/**
 * 云函数 tutorChat —— 全科题解导学（P1 MVP：单科多轮导学对话 + 会话归档）
 *
 * 入参：
 *   action: 'chat' | 'archive' | 'diagnoseQuestions' | 'sessionSummary' | 'genCards'
 *
 * 【chat】生成导学回复
 *   subject:  'math' | 'chinese' | 'english'（学科 key）
 *   content:  string 本轮孩子输入（题目 / 回答 / 提问）
 *   history:  Array<{role:'user'|'assistant', content:string}>  最近若干轮（不含本轮）
 *   learner:  { grade, teachStyle, expectations[] } 导学画像（可空）
 *   learnerCtx: string 近期卡点快照（前端从本地 tutorStore 组装，≤1500 字，可空）
 *   unitCtx:   { title, points:[{id,topic,status}] } 当前单元必会清单+复习状态（可空，混合路线：
 *              注入后 AI 优先围绕未覆盖/待复习的点引导，不强行拉回清单、不宣称掌握）
 *   出参：{ ok:true, reply:string } | { ok:false, code, msg }
 *
 * 【archive】会话结束归档（写入 tutor_sessions 集合，按 openid 隔离）
 *   subject:  string
 *   messages: Array<{role, content, ts}> 完整会话
 *   learner:  { grade, ... }
 *   sessionClientId: string 本地会话 uid（跨设备去重合并用，可空）
 *   mistakeClientId: string 预生成的本地错题 uid（诊断出卡点时随错题落库，可空）
 *   reviewClientId:  string 预生成的本地复习窗口 uid（= mistakeClientId + '_rv'，可空）
 *   出参：{ ok:true, id, diagnosis, mistakeId, review } | { ok:false, code, msg }
 *
 * 【diagnoseQuestions】拍照错题批量诊断（错题本「拍照收录」流程的阶段二）
 *   subject:  string 学科 key（可空）
 *   items:    Array<{no,type,questionText,childAnswer,marked,correctAnswer}>  ocrSchedule action='mistake' 转录结果（≤30 题）
 *   learner:  { grade }（可空，默认一年级）
 *   出参：{ ok:true, items:[{no,topic,errorType,errorDesc,suggestion}] } | { ok:false, code, msg }
 *
 * 【sessionSummary】会话级课程总结（写回 tutor_sessions.summary，与 archive 内联生成共用同一函数）
 *   subject:  string 学科 key
 *   messages: Array<{role, content}> 完整/精简会话
 *   diagnosis: Object 可选，archive 返回的诊断结果（用于 stuckPoints）
 *   sessionId: string 可选，tutor_sessions 的 _id（优先据此写回）
 *   sessionClientId: string 可选，archive 传入的本地 uid（无 sessionId 时按 openid+clientId 定位写回）
 *   出参：{ ok:true, data:{summary,keyPoints,stuckPoints,nextStep}, written } | { ok:false, code, msg }
 *
 * 【genCards】从会话抽取原子复习卡（仅返回候选，不入库；前端确认后才写 tutor_cards）
 *   subject:  string 学科 key
 *   messages: Array<{role, content}> 完整/精简会话
 *   出参：{ ok:true, cards:[{front,back,topic}] }（cards 可为空数组，宁缺毋滥） | { ok:false, code, msg }
 *
 * 大模型：CloudBase 内置 AI（cloudbase 组，模型 hy3，文本）。
 * 与 aiRoleAnalyze / studyPlanGen 同套初始化与错误兜底。
 * 设计：主控 prompt 管「怎么教」（最小干预 + 错因 + 契约），学科 prompt 管「教什么」（解法结构）。
 */
const tcb = require('@cloudbase/node-sdk');

/* ---------------- 频控：单实例内存级（防误触/脚本刷量；多轮对话适度放宽） ----------------
 * rateWait(openid) 返回「还需等待的毫秒数」：0 = 放行，>0 = 被限流。
 * 注意：未超限时也会计数（限流器语义），所以调用方必须以返回值为准，不能当纯查询用。 */
const RATE = { WIN_MS: 6000, MAX_PER_WIN: 1, MAX_PER_HOUR: 60 };
const rateMap = new Map();
function rateWait(openid) {
  if (!openid) return 0;
  const now = Date.now();
  let r = rateMap.get(openid);
  if (!r) { r = { winStart: now, winCount: 0, hourStart: now, hourCount: 0 }; rateMap.set(openid, r); }
  if (now - r.hourStart >= 3600000) { r.hourStart = now; r.hourCount = 0; }
  if (now - r.winStart >= RATE.WIN_MS) { r.winStart = now; r.winCount = 0; }
  r.winCount++; r.hourCount++;
  if (rateMap.size > 500) {
    for (const [k, v] of rateMap) if (now - v.hourStart >= 3600000) rateMap.delete(k);
  }
  // 小时档优先（等待更久），其次窗口档
  if (r.hourCount > RATE.MAX_PER_HOUR) return Math.max(0, r.hourStart + 3600000 - now);
  if (r.winCount > RATE.MAX_PER_WIN) return Math.max(0, r.winStart + RATE.WIN_MS - now);
  return 0;
}

/* ---------------- 主控 prompt：最小干预导学（专家的 D0-D4 / E1-E9 / 契约红线 提炼） ---------------- */
const SYSTEM_PROMPT =
  '你是「小小导学助手」，一位面向 K12 学生的全科导学老师。核心原则是「最小必要干预」——' +
  '绝不直接给答案，而是用提问和提示一步步引导孩子自己思考出答案。\n\n' +
  '【公开深度递进】根据孩子卡住的程度逐级升级提示，每次只给当前所需的最小提示：\n' +
  '- D0 题意澄清：先确认孩子看懂了题（如"这道题要我们求什么？题目给了哪些条件？"）\n' +
  '- D1 观察提示：引导孩子观察题面里的关键信息（数字、关键词、图）\n' +
  '- D2 方向引导：提示可以往哪个方向想，但不给具体步骤\n' +
  '- D3 关键转化：给出一个关键思路，把最后一步留给孩子\n' +
  '- D4 完整流程：只在孩子明确要求看答案、或反复受阻时，才给完整解法，并附"举一反三"的方法\n\n' +
  '【对话规则】\n' +
  '1. 每次只回应孩子当前的卡点，一次最多提 1~2 个小问题，不要长篇大论、不要一次讲太多。\n' +
  '2. 先让孩子说出自己的想法或试做，再决定给多深的提示。\n' +
  '3. 孩子答对时明确表扬；答错时不批评人，只温和指出"这一步可以再想想"，把问题定位成"可以改的动作"。\n' +
  '4. 不编造题目、答案、教材原文、评分标准；不确定时请孩子对照原题确认。\n' +
  '5. 语气亲切、简短，像一位耐心的老师，用孩子能听懂的话，不堆砌术语。';

/* ---------------- 学科 prompt：精简版（P3 九科，从 rolePresets 提炼核心导学方法） ---------------- */
const SUBJECT_PROMPTS = {
  math: '【数学】引导孩子理解题目的结构：先找"已知条件"，再想"要求什么"，最后想"怎么算"。' +
    '一年级重点：数感、20以内加减法、图形与位置、分类比较。多用实物、画图、数数帮助建立直觉，' +
    '先让孩子口算或摆一摆，再过渡到算式。不直接写答案。',
  chinese: '【语文】引导孩子完成字词句篇任务：先读准字音、认清字形，再组词、造句、理解意思。' +
    '拼音重点：声母、韵母、声调、拼读规则。先让孩子自己读一读、想一想，再给关键提示。不直接给答案。',
  english: '【英语】引导孩子开口：先听清、模仿发音，再认读单词。' +
    '一年级以听说模仿、词汇认读、兴趣为主，多用重复和鼓励。不纠结语法，不直接给答案。',
  physics: '【物理】引导孩子先建立物理情景：明确研究对象、已知条件、所求物理量，再想适用哪个概念或规律。' +
    '初中重点：速度与密度、力与运动、压强浮力、功和能、电路与光。' +
    '先让孩子说清"现象→规律→公式"，不跳步、不直接给答案。',
  chemistry: '【化学】引导孩子围绕"物质—反应—定量"三步：先看清反应物、生成物与条件，再配平、判断类型，最后计算。' +
    '初中重点：化学用语（元素符号/化学式/方程式）、常见物质性质、质量守恒。' +
    '先让孩子复述实验现象与结论，再给关键提示，不直接给答案。',
  biology: '【生物】引导孩子从"结构—功能—联系"理解生命现象：先观察或回忆结构，再想它的功能，最后联系生命活动。' +
    '初中重点：细胞、动植物、遗传、生态系统。多用类比和图示，先让孩子描述再给关键提示，不直接给答案。',
  history: '【历史】引导孩子建立"时间—事件—影响"的线索：先定位时间与背景，再梳理事件经过，最后分析意义。' +
    '初中重点：中国古代史、近代史、世界史。先让孩子复述史实，再引导归纳因果，不背结论、不直接给答案。',
  geography: '【地理】引导孩子按"在哪里—是什么—为什么—怎样影响"思考：先定位（图或坐标），再描述特征，最后分析成因。' +
    '初中重点：地图与经纬度、地形气候、区域差异。先让孩子读图、指图再说结论，不直接给答案。',
  politics: '【道德与法治】引导孩子按"是什么—为什么—怎么做"理解道理：先明确概念或观点，再讲依据，最后落到行为。' +
    '小学与初中重点：规则意识、权利义务、责任、价值观。先让孩子结合生活举例再归纳，不背条文、不直接给答案。'
};

/* 学科展示名（归档 / 错题落库 / 复测用） */
const SUBJECT_NAMES = {
  math: '数学', chinese: '语文', english: '英语',
  physics: '物理', chemistry: '化学', biology: '生物',
  history: '历史', geography: '地理', politics: '道德与法治'
};

/* ---------------- 工具 ---------------- */
function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

/** JSON 提取（宽松：代码块围栏 / 前后废话 / 尾逗号） */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch (e) {}
  try { return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1')); } catch (e) { return null; }
}

/** 组装 messages：主控 system + 学科 system + 近期卡点参考 + 单元必会清单 + 历史 + 本轮 user */
function buildMessages(subject, content, history, learner, learnerCtx, unitCtx) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];
  const sub = SUBJECT_PROMPTS[subject];
  if (sub) messages.push({ role: 'system', content: sub });

  // 近期卡点快照（跨会话记忆：前端从本地 tutorStore 组装，云函数不查库）
  if (learnerCtx) {
    messages.push({
      role: 'system',
      content: '【孩子近期卡点参考】以下是最近记录的卡点，仅供你主动关联、温故知新；' +
        '孩子问的是新题时就正常导学，不要强行重复旧题、不要据此出题。\n' + str(learnerCtx, 1500)
    });
  }

  // 单元必会清单（混合路线）：把当前单元的 canonical 清单 + 复习状态注入导学上下文，
  // 让 AI 优先围绕「未覆盖 / 待复习」的点引导，而不是漫无目的地接题。
  if (unitCtx && Array.isArray(unitCtx.points) && unitCtx.points.length) {
    const STATUS_CN = { uncovered: '未覆盖', learning: '复习中', due: '待复习', done: '已通关' };
    const lines = unitCtx.points.slice(0, 30).map(p =>
      '- ' + (p.topic || p.id) + '（' + (STATUS_CN[p.status] || '未覆盖') + '）');
    messages.push({
      role: 'system',
      content: '【本单元必会清单】孩子正在学习「' + str(unitCtx.title, 60) + '」，' +
        '本单元的必会知识点及当前复习状态如下：\n' + lines.join('\n') + '\n' +
        '引导建议：① 优先围绕「未覆盖 / 待复习」的点设计提问与提示，让孩子的每一轮都推进清单覆盖；' +
        '② 「已通关」的点不必重复引导；③ 孩子主动问清单外的内容时正常导学，不要强行拉回清单；' +
        '④ 状态只是复习进度参考，用来决定问什么，禁止在对话里对孩子宣称「已掌握 / 已通关 / 学会了」，' +
        '完成一个点时用「这个点想通了」这类过程性表述。'
    });
  }

  // 导学画像（简短注入，帮导学贴合「先提示后讲解」等偏好）
  const parts = [];
  if (learner && learner.grade) parts.push('年级：' + str(learner.grade, 20));
  if (learner && learner.teachStyle) parts.push('讲解偏好：' + str(learner.teachStyle, 20));
  if (learner && Array.isArray(learner.expectations) && learner.expectations.length) {
    parts.push('期望：' + learner.expectations.map(e => str(e, 20)).slice(0, 4).join('、'));
  }

  // 历史：只取最近 12 条，每条内容截断，防止超出上下文
  if (Array.isArray(history)) {
    history.slice(-12).forEach(m => {
      if (m && (m.role === 'user' || m.role === 'assistant')) {
        messages.push({ role: m.role, content: str(m.content, 2000) });
      }
    });
  }

  let user = str(content, 2000);
  if (parts.length) user = '【导学画像】' + parts.join('；') + '\n\n' + user;
  messages.push({ role: 'user', content: user });
  return messages;
}

/* ---------------- hy3 调用：429/限流自动退避重试（低配套餐内置模型并发配额低，易撞限流） ---------------- */
function isRateErr(e) {
  return /429|too many|rate.?limit|频率|限流|throttl/i.test((e && e.message) || String(e));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const RETRY_DELAYS = [1200, 2600];   // 两次重试的退避间隔（ms）
async function generateWithRetry(model, params) {
  let lastErr;
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    try {
      return await model.generateText(params);
    } catch (e) {
      lastErr = e;
      if (i < RETRY_DELAYS.length && isRateErr(e)) {
        await sleep(RETRY_DELAYS[i]);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/* ---------------- chat ---------------- */
async function chat(app, input) {
  const messages = buildMessages(input.subject, input.content, input.history, input.learner, input.learnerCtx, input.unitCtx);
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  const result = await generateWithRetry(model, { model: 'hy3', messages: messages });
  const text = (result && result.text) || '';
  if (!text) return { ok: false, code: 'empty_resp', msg: '老师没想好，再试一次吧' };
  return { ok: true, reply: text };
}

/* ---------------- 导学诊断（E1-E9 错因归因） ---------------- */
const DIAG_PROMPT =
  '你是「导学诊断」模块，负责根据一段导学对话，判断孩子本次导学的卡点与错因。\n' +
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，第一个字符必须是 {。\n\n' +
  '输出格式：\n' +
  '{"topic":"本次导学的知识点/题目（一句话）","stuck":true或false,"errorType":"E1"到"E9"或空字符串,"errorDesc":"孩子可观察到的错误行为（只说做了什么，不评价人）","suggestion":"建议的订正/训练动作（一句话）","done":true或false}\n\n' +
  '错因编号定义：\n' +
  'E1 审题信息（漏看限定/条件误识别/隐含条件忽略）\n' +
  'E2 概念知识（术语混淆/规则边界不清/反例未建立）\n' +
  'E3 学科表征（符号误读/图表提取错误/术语不熟）\n' +
  'E4 关系分析（方法选错/模型转化失败/关系找错）\n' +
  'E5 证据使用（公式前提不符/定理前提缺失/套错对象）\n' +
  'E6 逻辑推理（推理跳跃/分类不全/因果倒置）\n' +
  'E7 信息处理（运算失误/符号处理错误/变形错误）\n' +
  'E8 表达作答（跳步/单位格式缺失/表述不清）\n' +
  'E9 检查迁移（不检验/不会迁移/变式识别失败）\n\n' +
  '规则：\n' +
  '1. 错因是「诊断假设」，只基于对话中可观察的行为判断；不确定就 errorType 设空字符串、stuck 设 false。\n' +
  '2. 孩子最终独立做对/理解，done 设 true；一直靠提示才勉强完成，done 设 false。\n' +
  '3. 对话里没有实际做题（只是闲聊/问方法）时，stuck 设 false、errorType 空。';

/** 调 AI 对整段对话做错因诊断（失败抛错，由调用方降级） */
async function diagnose(app, input) {
  const lines = (Array.isArray(input.messages) ? input.messages : [])
    .slice(-40)
    .map(m => (m && m.role === 'user' ? '孩子：' : '老师：') + str(m && m.content, 1500));
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  const result = await generateWithRetry(model, {
    model: 'hy3',
    messages: [
      { role: 'system', content: DIAG_PROMPT },
      { role: 'user', content: '请诊断以下导学对话：\n\n' + lines.join('\n') }
    ]
  });
  return parseDiagnosis((result && result.text) || '');
}

/** 解析诊断 JSON（防御性：字段兜底） */
function parseDiagnosis(text) {
  const obj = extractJson(text);
  if (!obj) return null;
  return {
    topic: str(obj.topic, 40),
    stuck: !!obj.stuck,
    errorType: /^E[1-9]$/.test(obj.errorType || '') ? obj.errorType : '',
    errorDesc: str(obj.errorDesc, 100),
    suggestion: str(obj.suggestion, 100),
    done: !!obj.done
  };
}

/* ---------------- 复习窗口（艾宾浩斯档位：与 tutorRetest / 前端 tutorStore 保持一致） ---------------- */
const REVIEW_STAGE_DAYS = [1, 2, 4, 7, 15];
function reviewDueAt(stage) {
  const days = REVIEW_STAGE_DAYS[Math.max(0, Math.min(REVIEW_STAGE_DAYS.length, stage) - 1)] || 1;
  return Date.now() + days * 86400000;
}

/* ---------------- 拍照错题批量诊断（action='diagnoseQuestions'） ----------------
 * 与 DIAG_PROMPT 同一套 E1-E9 口径，但输入是「转录后的题目」而非对话：
 * 每题输出 topic / errorType / errorDesc / suggestion；同图多题打包一次调用（省 token）。
 * 计算题/默写类（图上有批改标记）由前端规则路由直接归因，不会送到这里。
 */
const DIAGQ_PROMPT =
  '你是「错题诊断」模块。下面是一批从练习图片转录来的题目（含孩子的作答与批改信息）。' +
  '请逐题判断知识点和错因。\n' +
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，第一个字符必须是 {。\n\n' +
  '输出格式：\n' +
  '{"items":[{"no":"对应输入题号","topic":"本题考查的知识点（一句话）","errorType":"E1"到"E9"或空字符串,"errorDesc":"孩子可观察到的错误行为（只说做了什么，不评价人）","suggestion":"建议的订正/训练动作（一句话）"}]}\n\n' +
  '错因编号定义：\n' +
  'E1 审题信息（漏看限定/条件误识别/隐含条件忽略）\n' +
  'E2 概念知识（术语混淆/规则边界不清/反例未建立）\n' +
  'E3 学科表征（符号误读/图表提取错误/术语不熟）\n' +
  'E4 关系分析（方法选错/模型转化失败/关系找错）\n' +
  'E5 证据使用（公式前提不符/定理前提缺失/套错对象）\n' +
  'E6 逻辑推理（推理跳跃/分类不全/因果倒置）\n' +
  'E7 信息处理（运算失误/符号处理错误/变形错误）\n' +
  'E8 表达作答（跳步/单位格式缺失/表述不清）\n' +
  'E9 检查迁移（不检验/不会迁移/变式识别失败）\n\n' +
  '规则：\n' +
  '1. 输出 items 的 no 必须逐一对应输入题目的 no，不许合并、不许遗漏。\n' +
  '2. 批改信息说明：marked=true 老师批改对（做对了，若收录则 errorType 可空，重点写知识点）；' +
  'marked=false 老师批改错；marked=null 未经批改——此时先自己解题得出参考答案，再与孩子作答比对判断对错，' +
  '并依据「孩子错在哪一步」归因。\n' +
  '3. 错因是「诊断假设」，只基于题面与作答可观察的信息判断；不确定就 errorType 设空字符串。\n' +
  '4. 不编造题面没有的内容；题干不完整时按可见部分诊断，errorDesc 里注明「题面信息不完整」。';

/** 拍照错题批量诊断（失败抛错，由调用方降级） */
async function diagnoseQuestions(app, input) {
  const grade = input.learner && input.learner.grade ? str(input.learner.grade, 20) : '';
  const lines = (Array.isArray(input.items) ? input.items : []).slice(0, 30).map((it, i) => {
    const parts = [
      'no: ' + str(it.no, 20),
      'type: ' + str(it.type, 20),
      '题干: ' + str(it.questionText, 500),
      '孩子作答: ' + str(it.childAnswer, 300),
      '批改标记: ' + (it.marked === true ? '批改对(√)' : it.marked === false ? '批改错(×)' : '未批改')
    ];
    if (it.correctAnswer) parts.push('图上正确答案: ' + str(it.correctAnswer, 200));
    return '【题' + (i + 1) + '】\n' + parts.join('\n');
  });
  const subjectName = ({ math: '数学', chinese: '语文', english: '英语' })[input.subject] || '';
  const head = '年级：' + (grade || '一年级') + (subjectName ? '；学科：' + subjectName : '') +
    '\n请诊断以下 ' + lines.length + ' 道题：\n\n';
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  const result = await model.generateText({
    model: 'hy3',
    messages: [
      { role: 'system', content: DIAGQ_PROMPT },
      { role: 'user', content: head + lines.join('\n\n') }
    ]
  });
  return parseDiagQ((result && result.text) || '');
}

/** 解析批量诊断 JSON：输出 [{no, topic, errorType, errorDesc, suggestion}]，解析失败返回 null */
function parseDiagQ(text) {
  const obj = extractJson(text);
  if (!obj || !Array.isArray(obj.items)) return null;
  return obj.items.slice(0, 30).map(it => ({
    no: str(it && it.no, 20),
    topic: str(it && it.topic, 60),
    errorType: /^E[1-9]$/.test((it && it.errorType) || '') ? it.errorType : '',
    errorDesc: str(it && it.errorDesc, 120),
    suggestion: str(it && it.suggestion, 120)
  }));
}

/* ---------------- 单元总结（action='unitSummary'） ----------------
 * 输入：阶段（≈单元）名称/目标/任务完成情况 + 本学科错题 + 日常打卡记录摘选。
 * 输出 JSON：{ summary, advice[≤3], branches[6-8]{title 2-6字, points 2-4条≤18字, color} }
 * branches 直接驱动前端 Canvas「仿黑板知识树」；文字总结与建议独立展示。
 * 丰富度对齐老师黑板板书样例：分支按知识点拆细、要点带具体例子（算式/符号/口诀）。
 * 合规：提示词明确禁用「已掌握/已精通」等绝对化掌握度表述；知识框架可按年级学科教材
 *       通用内容拆解（公开常识），但孩子表现/掌握情况的表述只依据输入的真实数据。
 */
const UNITSUM_PROMPT =
  '你是「单元总结」模块，擅长像有经验的老师那样画「整理与复习」黑板知识树。' +
  '下面是一个导学阶段（单元）的名称、目标、任务完成情况，以及相关错题与日常记录。\n' +
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，第一个字符必须是 {。\n\n' +
  '输出格式：\n' +
  '{"summary":"250字以内一段话：这个单元学了哪些知识、整体表现如何、哪里还需巩固；' +
  '不使用「已掌握/已精通/学会了」等绝对化表述，改用「达成较好/还需巩固/可以加强」",' +
  '"advice":["复习建议1（一句话）","建议2","建议3"],' +
  '"branches":[{"title":"分支名（2-6字）","points":["要点（不超过18字，带具体例子）","要点","要点"],"color":"yellow|pink|blue|green 之一"}]}\n\n' +
  '规则：\n' +
  '1. branches 给 6-8 个，按知识点把单元拆细（如「比大小」「分与合」「加法」「减法」「0的认识」「几和第几」），不要把多个大块塞进同一分支。\n' +
  '2. 每个分支 2-4 条要点，像黑板板书：写具体内容和小例子——算式（如「2+3=5」「5-3=2」）、符号（如「＞＜＝」）、词语、口诀；不要写「认识了加法」这类空话。\n' +
  '3. **严格围绕给定「单元名称」对应的教材范围拆分支**：不引入其他单元的内容、不跨年级拔高；' +
  '单元名称无法识别具体教材版本时，按「年级+学科+单元名」最通用的教材范围推断（教材知识是公开常识）；' +
  '涉及孩子表现/掌握情况的表述只依据下面输入的真实数据，不编造。\n' +
  '4. 做得好的和薄弱的都要体现；错题要落到对应分支的要点里（如「进位易错」「默写需巩固」），做对的部分也写进去。\n' +
  '5. color 在 yellow/pink/blue/green 四色粉笔里选，相邻分支颜色不同。\n' +
  '6. 要点里不要出现 E1-E9 这类错因编号，错因用通俗中文短词（如「运算失误」「审题不细」）。\n' +
  '7. 单元名称信息不足时（如只写「第三单元」），按该年级该学科最常见的进度推断范围，不要因此返回空 branches。';

/* 学科特定的必会点拆解要求（按导学类型定制提示词；与 SUBJECT_PROMPTS 的同学科重点一致，更细化） */
const UNIT_KP_HINTS = {
  math: '按知识模块拆细（如「数感」「20以内加减法」「图形与位置」「分类比较」），每条要点必须带具体算式、符号或口诀（如「2+3=5」「＞＜＝」「凑十法」），不写空话。',
  chinese: '按「拼音→识字→写字→词语→句子」模块拆细（如「声母韵母」「拼读规则」「偏旁部首」「笔画顺序」），每条要点带具体字词或拼读示例（如「b—à→bà（爸）」「日字旁」）。',
  english: '按「听说模仿→词汇认读→简单句型」模块拆细，每条要点带具体单词或句型（如「apple 苹果」「Hello, I\'m…」），不纠结语法术语。',
  physics: '按「概念→规律→公式→实验」模块拆细，每条要点带具体公式或实验现象（如「v=s/t」「压强 p=F/S」）。',
  chemistry: '按「化学用语→物质性质→反应类型→定量计算」模块拆细，每条要点带具体化学式或方程式。',
  biology: '按「结构→功能→联系」模块拆细，每条要点带具体结构名或生活实例。',
  history: '按「时间→事件→影响」模块拆细，每条要点带具体年代、事件名或人物。',
  geography: '按「定位→特征→成因→影响」模块拆细，每条要点带具体地名、数据或图表读法。',
  politics: '按「是什么→为什么→怎么做」模块拆细，每条要点带具体规则或生活实例。'
};

/** E 码 → 黑板可读的通俗错因名（与 DIAG_PROMPT 的 E1-E9 口径一致，取短词） */
const ERROR_SHORT = {
  E1: '审题不细', E2: '概念不清', E3: '符号误读', E4: '方法选错',
  E5: '前提不符', E6: '推理跳跃', E7: '运算失误', E8: '表述不清', E9: '不检验'
};

/** 单元总结（失败抛错，由调用方统一兜底） */
async function unitSummary(app, input) {
  const lines = [];
  lines.push('单元名称：' + str(input.unitName, 60));
  if (input.unitGoal) lines.push('单元目标：' + str(input.unitGoal, 200));
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).slice(0, 30);
  lines.push('任务清单：\n' + (tasks.length
    ? tasks.map(t => '- ' + str(t.name, 60) +
        (t.done ? ('（已完成' + (t.checkinDays ? '，用时' + t.checkinDays + '天' : '') + '）') : '（未完成）')).join('\n')
    : '-（暂无任务记录）'));
  const mistakes = (Array.isArray(input.mistakes) ? input.mistakes : []).slice(0, 20);
  if (mistakes.length) {
    lines.push('相关错题（知识点 + 错因）：\n' +
      mistakes.map(m => '- ' + str(m.topic, 40) +
        (m.errorType ? ('（' + (ERROR_SHORT[m.errorType] || m.errorType) + '）') : '')).join('\n'));
  }
  const notes = (Array.isArray(input.notes) ? input.notes : []).slice(0, 20);
  if (notes.length) {
    lines.push('日常记录摘选：\n' + notes.map(n => '- ' + str(n, 80)).join('\n'));
  }
  const grade = input.learner && input.learner.grade ? str(input.learner.grade, 20) : '';
  const head = '年级：' + (grade || '一年级') +
    (input.subjectName ? ('；学科：' + str(input.subjectName, 10)) : '') + '\n\n';
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  // 按导学类型（学科）注入必会点拆解要求：提示词关联学科 + 严格落在给定单元范围内
  const hint = UNIT_KP_HINTS[input.subject] || '';
  const sys = hint ? (UNITSUM_PROMPT + '\n\n【本学科必会点拆解要求】' + hint) : UNITSUM_PROMPT;
  const result = await model.generateText({
    model: 'hy3',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: head + lines.join('\n\n') }
    ]
  });
  return parseUnitSum((result && result.text) || '');
}

/** 解析单元总结 JSON，解析失败返回 null */
function parseUnitSum(text) {
  const obj = extractJson(text);
  if (!obj) return null;
  const branches = (Array.isArray(obj.branches) ? obj.branches : []).slice(0, 8)
    .map(b => ({
      title: str(b && b.title, 12),
      points: (Array.isArray(b && b.points) ? b.points : []).slice(0, 4).map(p => str(p, 20)),
      color: /^(yellow|pink|blue|green)$/.test((b && b.color) || '') ? b.color : ''
    }))
    .filter(b => b.title);
  if (!branches.length) return null;
  return {
    summary: str(obj.summary, 320),
    advice: (Array.isArray(obj.advice) ? obj.advice : []).slice(0, 3).map(a => str(a, 60)),
    branches: branches
  };
}

/* ---------------- 禁用词门禁（合规红线：与 order-kit K.findBannedWords 同口径，11 词） ----------------
 * 总结/卡片文字若混入绝对化掌握度表述，一律替换为合规中性表述，绝不落入「已掌握/已精通」断言。
 * 顺序：先长词组后短词组，避免「完全掌握」被「掌握了」短路。 */
const BANNED_WORDS = [
  ['已精通', '掌握扎实'],
  ['已掌握', '达成较好'],
  ['学会了', '推通了'],
  ['完全懂了', '理解了'],
  ['完全掌握', '掌握得不错'],
  ['稳稳掌握', '掌握得较稳'],
  ['掌握了', '学得很扎实'],
  ['精通了', '学得扎实'],
  ['已学会', '已能独立做'],
  ['学懂了', '理解了'],
  ['全懂了', '都理解了']
];
function sanitizeBanned(text) {
  let s = String(text == null ? '' : text);
  for (const [bad, good] of BANNED_WORDS) s = s.split(bad).join(good);
  return s;
}

/* ---------------- 会话级课程总结（action='sessionSummary'，也会在 archive 内联调用） ----------------
 * 与 unitSummary 平级但粒度更细：本次对话「推通了什么、卡在哪、下一步」。
 * 写回 tutor_sessions.summary（by _id 或 openid+clientId），降级不阻塞。
 * keyPoints 只来自孩子实际说出/推导的内容；stuckPoints 来自诊断；合规走 sanitizeBanned。 */
const SESSIONSUM_PROMPT =
  '你是「会话总结」模块，负责把一次导学对话浓缩成孩子和家长都能看懂的回顾。\n' +
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，第一个字符必须是 {。\n\n' +
  '输出格式：\n' +
  '{"summary":"200字以内一段话：本次围绕什么题、孩子自己推通了哪些点、卡在哪、下一步做什么；' +
  '不使用「已掌握/已精通/学会了」等绝对化表述，改用「达成较好/还需巩固/可以加强」",' +
  '"keyPoints":["本次孩子自己说出或推导出的关键结论1","结论2"],' +
  '"stuckPoints":["仍卡住的点1（来自诊断，没有就留空数组）"],' +
  '"nextStep":"一句话：下次可先练什么、或复习哪张卡"}\n\n' +
  '规则：\n' +
  '1. keyPoints 只能来自对话中孩子「实际说出或推导出来」的内容，不替孩子总结他没做过的；每条≤25字，最多4条。\n' +
  '2. stuckPoints 只写本次真正卡住的地方，最多3条，没有就返回空数组。\n' +
  '3. 不编造题面没有的内容；孩子表现只依据真实对话与诊断，不臆测。\n' +
  '4. 语气中性、给孩子成就感但不夸大；禁用「已掌握/已精通/学会了」等绝对化掌握度表述。';

async function sessionSummary(app, input, diagnosis) {
  const grade = (input.learner && input.learner.grade) ? str(input.learner.grade, 20)
    : (str(input.grade, 20) || '');
  const lines = (Array.isArray(input.messages) ? input.messages : [])
    .slice(-40)
    .map(m => (m && m.role === 'user' ? '孩子：' : '老师：') + str(m && m.content, 1500));
  const head = '学科：' + (SUBJECT_NAMES[input.subject] || str(input.subject, 10) || '未指定') +
    (grade ? ('；年级：' + grade) : '') + '\n\n';
  let diagText = '';
  if (diagnosis && (diagnosis.topic || diagnosis.stuck)) {
    diagText = '\n【本次诊断参考】' +
      (diagnosis.topic ? ('知识点：' + str(diagnosis.topic, 40) + '；') : '') +
      ('是否卡住：' + (diagnosis.stuck ? '是' : '否') + '；') +
      (diagnosis.errorDesc ? ('观察：' + str(diagnosis.errorDesc, 100)) : '') +
      (diagnosis.suggestion ? ('；建议：' + str(diagnosis.suggestion, 100)) : '');
  }
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  const result = await generateWithRetry(model, {
    model: 'hy3',
    messages: [
      { role: 'system', content: SESSIONSUM_PROMPT },
      { role: 'user', content: head + '请总结以下导学对话：\n\n' + lines.join('\n') + diagText }
    ]
  });
  return parseSessionSum((result && result.text) || '');
}

/** 解析会话总结 JSON（防御性：字段兜底 + 合规门禁），解析失败返回 null */
function parseSessionSum(text) {
  const obj = extractJson(text);
  if (!obj) return null;
  const keyPoints = (Array.isArray(obj.keyPoints) ? obj.keyPoints : []).slice(0, 4).map(k => sanitizeBanned(str(k, 30)));
  const stuckPoints = (Array.isArray(obj.stuckPoints) ? obj.stuckPoints : []).slice(0, 3).map(s => sanitizeBanned(str(s, 30)));
  const summary = sanitizeBanned(str(obj.summary, 240));
  const nextStep = sanitizeBanned(str(obj.nextStep, 60));
  if (!summary && !keyPoints.length && !stuckPoints.length) return null;
  return { summary: summary, keyPoints: keyPoints, stuckPoints: stuckPoints, nextStep: nextStep };
}

/** 把总结写回 tutor_sessions（优先 _id，否则 openid+clientId 定位）。失败返回 false，不抛错。 */
async function writeSessionSummary(app, openid, sessionId, clientId, summary) {
  if (!summary) return false;
  const db = app.database();
  try {
    if (sessionId) {
      await db.collection('tutor_sessions').doc(sessionId).update({ summary: summary });
      return true;
    }
    if (clientId && openid) {
      const r = await db.collection('tutor_sessions').where({ openid: openid, clientId: clientId }).get();
      const list = (r && r.data) || [];
      if (list.length) {
        await db.collection('tutor_sessions').doc(list[0]._id).update({ summary: summary });
        return true;
      }
    }
  } catch (e) {}
  return false;
}

/* ---------------- 复习卡生成（action='genCards'，仅返回候选，不入库） ----------------
 * 从本次会话抽取「孩子自己推通」的原子知识点，≤5 张；前端确认后才写 tutor_cards。
 * 卡片形态：front 一个可回想的问题，back 简短答案+具体小例子（Anki 一张卡一个事实）。 */
const GENCARDS_PROMPT =
  '你是「复习卡生成」模块。下面是一段导学对话（孩子在老师引导下自己推导出结论）。' +
  '请从中提取「孩子自己推通的关键知识点」，生成可自测的复习卡。\n' +
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，第一个字符必须是 {。\n\n' +
  '输出格式：\n' +
  '{"cards":[{"front":"卡片正面：一个具体问题/词/填空（如「3+4 等于几？」「b—à 拼成什么音节？」「‘明’字左边是什么偏旁？」）",' +
  '"back":"卡片背面：答案 + 一个具体小例子（如「7」「bà（爸）」「日字旁」）",' +
  '"topic":"这张卡对应的小知识点（一句话）",' +
  '"kpId":"若本卡确实覆盖了下面给定的「单元必会点」中某一条，填它的 id；否则填 null"}]}\n\n' +
  '规则：\n' +
  '1. 每张卡只承载「一个事实」，正面是一个可回想的问题，背面是简短答案+例子，不写大段解释。\n' +
  '2. 卡片只能来自对话中孩子「实际推通/说出」的内容，不凭空造卡、不造孩子没学过的题。\n' +
  '3. 数量：最多 5 张；如果本次对话没有值得单独记的知识点，返回 cards:[]（宁缺毋滥）。\n' +
  '4. 适合一年级孩子：用词具体、不抽象；拼音/汉字卡正面带语境（如给出音节或偏旁）。\n' +
  '5. kpId 仅当本卡确实覆盖了给定「单元必会点」某条时才填对应 id，且 id 必须从给定清单里取；' +
  '不确定或无关就填 null，不要硬凑、不要编造 id。';

async function genCards(app, input) {
  const grade = (input.learner && input.learner.grade) ? str(input.learner.grade, 20)
    : (str(input.grade, 20) || '');
  const lines = (Array.isArray(input.messages) ? input.messages : [])
    .slice(-40)
    .map(m => (m && m.role === 'user' ? '孩子：' : '老师：') + str(m && m.content, 1500));
  const head = '学科：' + (SUBJECT_NAMES[input.subject] || str(input.subject, 10) || '未指定') +
    (grade ? ('；年级：' + grade) : '') + '\n\n';
  // 单元必会点（混合路线）：若前端传了当前单元的 canonical 清单，则要求 AI 把覆盖到的点映射 kpId
  const unitPoints = Array.isArray(input.unitPoints) ? input.unitPoints.slice(0, 50) : [];
  let unitPart = '';
  if (unitPoints.length) {
    unitPart = '\n\n【单元必会点（id → 主题），kpId 只能取这里的 id】\n' +
      unitPoints.map(p => '- ' + (p.id || '') + '：' + (p.topic || '')).join('\n');
  }
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  const result = await generateWithRetry(model, {
    model: 'hy3',
    messages: [
      { role: 'system', content: GENCARDS_PROMPT },
      { role: 'user', content: head + '请生成复习卡：\n\n' + lines.join('\n') + unitPart }
    ]
  });
  const parsed = parseGenCards((result && result.text) || '');
  // 仅保留落在给定必会点 id 集合内的 kpId（防止 AI 编造 id 导致误去重）
  if (unitPoints.length) {
    const allowed = new Set(unitPoints.map(p => p.id));
    parsed.cards.forEach(c => { if (c.kpId && !allowed.has(c.kpId)) c.kpId = null; });
    parsed.coveredKpIds = parsed.cards.filter(c => c.kpId).map(c => c.kpId);
  }
  // 返回 { cards, coveredKpIds }；不入库（单元必会未覆盖点的自动补齐由前端按本地已有卡计算，见小程序端）
  return parsed;
}

/** 解析复习卡 JSON（防御性：去空卡、≤5 张，kpId 归一为字符串或 null），解析失败返回空结构 */
function parseGenCards(text) {
  const obj = extractJson(text);
  if (!obj || !Array.isArray(obj.cards)) return { cards: [], coveredKpIds: [] };
  const cards = obj.cards.slice(0, 5).map(c => ({
    front: str(c && c.front, 80),
    back: str(c && c.back, 120),
    topic: str(c && c.topic, 40),
    kpId: (c && c.kpId && typeof c.kpId === 'string' && /^[A-Za-z0-9_:-]+$/.test(c.kpId)) ? c.kpId : null
  })).filter(c => c.front && c.back);
  return { cards: cards, coveredKpIds: cards.filter(c => c.kpId).map(c => c.kpId) };
}

/* ---------------- archive（会话归档 + 错因诊断 + 错题落库 + 复习窗口派生 + 会话总结写回） ---------------- */
async function archive(app, input, openid) {
  const db = app.database();
  const now = Date.now();
  const doc = {
    openid: openid,
    clientId: str(input.sessionClientId, 60),   // 本地会话 uid，跨设备合并去重用
    subject: str(input.subject, 20),
    grade: (input.learner && input.learner.grade) ? str(input.learner.grade, 20) : '',
    messages: (Array.isArray(input.messages) ? input.messages : []).map(m => ({
      role: m && m.role === 'user' ? 'user' : 'assistant',
      content: str(m && m.content, 4000),
      ts: (m && m.ts) || now
    })),
    createdAt: now
  };

  // ⚠️ @cloudbase/node-sdk 的 add(obj)：obj 直接作为新文档，**无 { data:{} } 包壳**
  //    （那是 wx-server-sdk 的写法；包壳会把整份文档塞进一个 data 字段，读取端全空）
  let addRes;
  try {
    addRes = await db.collection('tutor_sessions').add(doc);
  } catch (e) {
    // 集合不存在时自动创建后重试一次
    try { await db.createCollection('tutor_sessions'); } catch (e2) {}
    addRes = await db.collection('tutor_sessions').add(doc);
  }

  // 错因诊断（失败不阻塞归档，降级为 null）
  let diagnosis = null;
  try { diagnosis = await diagnose(app, input); } catch (e) { diagnosis = null; }

  // 诊断出卡点 → 写错题本集合
  let mistakeId = '';
  if (diagnosis && diagnosis.stuck) {
    const mDoc = {
      openid: openid,
      clientId: str(input.mistakeClientId, 60),   // 预生成的本地错题 uid，跨设备去重用
      subject: str(input.subject, 20),
      subjectName: SUBJECT_NAMES[input.subject] || str(input.subject, 20),
      topic: diagnosis.topic,
      errorType: diagnosis.errorType,
      errorDesc: diagnosis.errorDesc,
      suggestion: diagnosis.suggestion,
      status: 'pending',
      source: 'manual',   // 对话诊断归档的错题属人工诊断（非拍照 OCR），与 OCR 的 source:'photo' 区分溯源
      createdAt: now
    };
    try {
      const mRes = await db.collection('tutor_mistakes').add(mDoc);
      mistakeId = (mRes && mRes.id) || '';
    } catch (e) {
      try { await db.createCollection('tutor_mistakes'); } catch (e2) {}
      try {
        const mRes = await db.collection('tutor_mistakes').add(mDoc);
        mistakeId = (mRes && mRes.id) || '';
      } catch (e3) {}
    }
  }

  // 诊断出卡点 → 派生复习窗口（stage 1，次日到期；失败不阻塞归档）
  // clientId 与错题 1:1 绑定（tutorRetest judge 按 mistakeClientId 定位推进/关闭）
  let review = null;
  if (diagnosis && diagnosis.stuck) {
    const rDoc = {
      openid: openid,
      clientId: str(input.reviewClientId, 60),
      mistakeClientId: str(input.mistakeClientId, 60),
      subject: str(input.subject, 20),
      subjectName: SUBJECT_NAMES[input.subject] || str(input.subject, 20),
      topic: diagnosis.topic,
      errorType: diagnosis.errorType,
      stage: 1,
      dueAt: reviewDueAt(1),
      done: false,
      createdAt: now,
      updatedAt: now
    };
    try {
      await db.collection('tutor_reviews').add(rDoc);
      review = {
        id: rDoc.clientId,
        mistakeId: rDoc.mistakeClientId,
        subject: rDoc.subject,
        subjectName: rDoc.subjectName,
        topic: rDoc.topic,
        errorType: rDoc.errorType,
        stage: 1,
        dueAt: rDoc.dueAt,
        done: false,
        createdAt: rDoc.createdAt
      };
    } catch (e) {
      try { await db.createCollection('tutor_reviews'); } catch (e2) {}
      try {
        await db.collection('tutor_reviews').add(rDoc);
        review = {
          id: rDoc.clientId,
          mistakeId: rDoc.mistakeClientId,
          subject: rDoc.subject,
          subjectName: rDoc.subjectName,
          topic: rDoc.topic,
          errorType: rDoc.errorType,
          stage: 1,
          dueAt: rDoc.dueAt,
          done: false,
          createdAt: rDoc.createdAt
        };
      } catch (e3) {}
    }
  }

  // 会话级总结（写回 tutor_sessions.summary；失败不阻塞归档，与 diagnose 同级降级）
  let summary = null;
  try { summary = await sessionSummary(app, input, diagnosis); } catch (e) { summary = null; }
  if (summary && addRes && addRes.id) {
    try {
      await db.collection('tutor_sessions').doc(addRes.id).update({ summary: summary });
    } catch (e) {}
  }

  return {
    ok: true,
    id: (addRes && addRes.id) || '',
    diagnosis: diagnosis,
    mistakeId: mistakeId,
    review: review,
    summary: summary
  };
}

/* ---------------- 主入口 ---------------- */
exports.main = async (event) => {
  const openid = (event.userInfo && event.userInfo.openId) || '';

  const input = {
    subject: str(event.subject, 20),
    content: str(event.content, 4000),
    history: Array.isArray(event.history) ? event.history.slice(-12) : [],
    messages: Array.isArray(event.messages) ? event.messages.slice(-200) : [],
    items: Array.isArray(event.items) ? event.items.slice(0, 30) : [],
    learner: event.learner && typeof event.learner === 'object' ? event.learner : {},
    learnerCtx: str(event.learnerCtx, 1500),
    sessionClientId: str(event.sessionClientId, 60),
    mistakeClientId: str(event.mistakeClientId, 60),
    reviewClientId: str(event.reviewClientId, 60),
    /* 单元总结（action='unitSummary'）专用字段 */
    unitName: str(event.unitName, 60),
    unitGoal: str(event.unitGoal, 200),
    subjectName: str(event.subjectName, 10),
    tasks: Array.isArray(event.tasks) ? event.tasks.slice(0, 30) : [],
    mistakes: Array.isArray(event.mistakes) ? event.mistakes.slice(0, 20) : [],
    notes: Array.isArray(event.notes) ? event.notes.slice(0, 20) : [],
    /* 会话总结 / 复习卡（sessionSummary / genCards）专用字段 */
    sessionId: str(event.sessionId, 60),
    grade: str(event.grade, 20),
    diagnosis: event.diagnosis && typeof event.diagnosis === 'object' ? event.diagnosis : null,
    /* 复习卡混合生成（genCards）专用字段：当前单元必会清单（用于 kpId 映射），
     *   元素 {id,topic,front,back} */
    unitPoints: Array.isArray(event.unitPoints) ? event.unitPoints.slice(0, 50) : [],
    /* 导学对话（chat）专用字段：当前单元必会清单 + 复习状态快照（前端从本地组装，云函数不查库），
     *   {title, points:[{id,topic,status}]}，status ∈ uncovered|learning|due|done */
    unitCtx: (event.unitCtx && typeof event.unitCtx === 'object') ? {
      title: str(event.unitCtx.title, 60),
      points: (Array.isArray(event.unitCtx.points) ? event.unitCtx.points : []).slice(0, 30).map(p => ({
        id: str(p && p.id, 30),
        topic: str(p && p.topic, 60),
        status: /^(uncovered|learning|due|done)$/.test(p && p.status) ? p.status : 'uncovered'
      }))
    } : null
  };

  const action = event.action === 'archive' ? 'archive'
    : event.action === 'diagnoseQuestions' ? 'diagnoseQuestions'
    : event.action === 'unitSummary' ? 'unitSummary'
    : event.action === 'sessionSummary' ? 'sessionSummary'
    : event.action === 'genCards' ? 'genCards'
    : 'chat';

  if (action === 'chat') {
    const waitMs = rateWait(openid);
    if (waitMs > 0) {
      return {
        ok: false,
        code: 'rate_limit',
        msg: '问得太快啦，喘口气再问一次～',
        retryAfterMs: waitMs          // 回传还需等待的毫秒数，前端据此延时重试
      };
    }
  }

  let app;
  try {
    app = tcb.init({ env: process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf' });
  } catch (e) {
    return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) };
  }

  if (action === 'diagnoseQuestions') {
    if (!input.items.length) return { ok: false, code: 'empty', msg: '没有可诊断的题目' };
    try {
      const items = await diagnoseQuestions(app, input);
      if (!items) return { ok: false, code: 'parse', msg: '诊断结果解析失败，请重试' };
      return { ok: true, items: items };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/token|tokencredit|resource|pack|quota|余额|额度|开通|403|404|未购买|模型|model|not found|不存在|unauthorized|forbidden/i.test(msg)) {
        return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
      }
      return { ok: false, code: 'ai_error', msg: '诊断失败：' + msg };
    }
  }

  if (action === 'unitSummary') {
    if (!input.unitName) return { ok: false, code: 'empty', msg: '缺少单元名称' };
    try {
      const data = await unitSummary(app, input);
      if (!data) return { ok: false, code: 'parse', msg: '总结生成失败，请重试' };
      return { ok: true, data: data };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/token|tokencredit|resource|pack|quota|余额|额度|开通|403|404|未购买|模型|model|not found|不存在|unauthorized|forbidden/i.test(msg)) {
        return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
      }
      return { ok: false, code: 'ai_error', msg: '总结生成失败：' + msg };
    }
  }

  if (action === 'sessionSummary') {
    if (!input.messages.length && !input.sessionId && !input.sessionClientId) {
      return { ok: false, code: 'empty', msg: '缺少会话内容或会话标识' };
    }
    try {
      const data = await sessionSummary(app, input, input.diagnosis);
      if (!data) return { ok: false, code: 'parse', msg: '总结生成失败，请重试' };
      const written = await writeSessionSummary(app, openid, input.sessionId, input.sessionClientId, data);
      return { ok: true, data: data, written: written };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/token|tokencredit|resource|pack|quota|余额|额度|开通|403|404|未购买|模型|model|not found|不存在|unauthorized|forbidden/i.test(msg)) {
        return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
      }
      return { ok: false, code: 'ai_error', msg: '总结生成失败：' + msg };
    }
  }

  if (action === 'genCards') {
    if (!input.messages.length) return { ok: false, code: 'empty', msg: '没有可生成卡片的对话内容' };
    try {
      const parsed = await genCards(app, input);
      // 仅返回候选（cards + coveredKpIds），不入库；单元必会未覆盖点的自动补齐由前端完成
      return { ok: true, cards: parsed.cards || [], coveredKpIds: parsed.coveredKpIds || [] };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/token|tokencredit|resource|pack|quota|余额|额度|开通|403|404|未购买|模型|model|not found|不存在|unauthorized|forbidden/i.test(msg)) {
        return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
      }
      return { ok: false, code: 'ai_error', msg: '卡片生成失败：' + msg };
    }
  }

  if (action === 'archive') {
    if (!input.messages.length) return { ok: false, code: 'empty', msg: '没有可归档的对话内容' };
    try {
      return await archive(app, input, openid);
    } catch (e) {
      return { ok: false, code: 'archive_error', msg: '归档失败：' + ((e && e.message) || e) };
    }
  }

  if (!input.subject) return { ok: false, code: 'empty', msg: '请先选择学科' };
  if (!SUBJECT_PROMPTS[input.subject]) return { ok: false, code: 'bad_subject', msg: '暂不支持该学科的导学' };
  if (!input.content) return { ok: false, code: 'empty', msg: '先说说你遇到了什么题吧' };

  try {
    return await chat(app, input);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/429|too many|rate.?limit|频率|限流/i.test(msg)) {
      return { ok: false, code: 'rate_limit', msg: '请求过于频繁，请稍等几秒再试一次' };
    }
    if (/token|tokencredit|resource|pack|quota|余额|额度|开通|403|404|未购买|模型|model|not found|不存在|unauthorized|forbidden/i.test(msg)) {
      return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
    }
    return { ok: false, code: 'ai_error', msg: '导学失败：' + msg };
  }
};

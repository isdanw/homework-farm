/**
 * 云函数 studyPlanGen —— 成长计划（阶段成长计划）生成
 *
 * 入参：{
 *   subject:    string,  // 科目名（如 语文）
 *   grade:      string,  // 年级（如 一年级）
 *   term:       string,  // 学期（上学期/下学期）
 *   textbook:   string,  // 教材版本（如 人教版）
 *   textbookId: string,  // 教材库锚点（选用教材后按单元目录编排；空 = 维持现状）
 *   planPrompt: string   // 家长自定义计划提示词（该科目的编排要求）
 * }
 * 出参：{ ok:true, plan: {stages:[{name,weeks,goal,tasks:[{name,days}]}]}, textbookAnchored: bool }
 *       { ok:false, code, msg }
 *
 * 大模型：CloudBase 内置 AI（cloudbase 组，hy3）。与 analyzeComment 同套错误兜底。
 * 输出严格 JSON；首轮解析失败走「会话内纠正重试」一次（与 ocrSchedule 同策略）。
 *
 * textbookId 锚定（#19）：从 textbook_library 读单元目录注入 user prompt（官方库或本人库；
 * 他人私有/不存在/读取异常一律 fail-open 不注入，保证计划生成主链路不被教材库拖挂）。
 */
const tcb = require('@cloudbase/node-sdk');

const TEXTBOOK_COLL = 'textbook_library';
const UNITKPS_COLL = 'tutor_unit_kps';   // 单元必会库（含依赖边 prereqs）
const MISTAKES_COLL = 'tutor_mistakes';  // 错题本（E1-E9）
const CARDS_COLL = 'tutor_cards';        // 复习卡（Leitner 毕业态 = 掌握度）
const MAX_TOC_CHARS = 4000;   // 目录块总长上限（超了截断，hy3 上下文充裕但防 prompt 膨胀）

/* —— R2：轻量每用户频控（单实例内存级；多实例时为近似限制，足以防误触与脚本刷量）——
 * 计划生成是重调用（大 prompt + 长输出），限得更紧：10 秒内最多 1 次、每小时最多 10 次。
 * rateWait(openid) 返回「还需等待的毫秒数」：0 = 放行，>0 = 被限流。
 * 注意：未超限时也会计数（限流器语义），调用方必须以返回值为准。 */
const RATE = { WIN_MS: 10000, MAX_PER_WIN: 1, MAX_PER_HOUR: 10 };
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

/* ---------- JSON 提取（宽松：代码块围栏 / 前后废话 / 尾逗号） ---------- */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch (e) {}
  try {
    return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1'));
  } catch (e) {
    return null;
  }
}

/** 教材记录 → 「单元目录（权威）」文本块（纯函数；空 units 返回空串 = 不注入）。
 *  读取侧已保证 units 结构合法（normalizeTextbook），这里只做展示层截断。 */
function buildTocBlock(tb) {
  if (!tb || !Array.isArray(tb.units) || !tb.units.length) return '';
  const title = String(tb.title || '').slice(0, 60);
  const meta = [tb.version, tb.grade, tb.term].filter(Boolean).map(s => String(s).slice(0, 20)).join('·');
  const head = '《' + title + (meta ? '（' + meta + '）' : '') + '》共 ' + tb.units.length + ' 个单元：';
  const lines = [head];
  let used = head.length;
  let truncated = false;
  tb.units.forEach((u, i) => {
    const name = String((u && u.name) || '').slice(0, 40) || ('第' + (i + 1) + '单元');
    const secs = (u && Array.isArray(u.sections) ? u.sections : []).map(s => String(s).slice(0, 30)).join('、');
    const line = (i + 1) + '. ' + name + (secs ? '\n   小节：' + secs : '');
    if (used + line.length + 1 > MAX_TOC_CHARS) { truncated = true; return; }   // 将超即跳（整行不进）
    used += line.length + 1;
    lines.push(line);
  });
  if (truncated) lines.push('……（目录过长已截断，余下单元按该教材常规教学进度补充）');
  return '【教材单元目录（权威，必须严格遵循）】\n' + lines.join('\n') + '\n\n' +
    '编排铁律：\n' +
    '1. 阶段划分与上方单元一一对应（仅可合并相邻小单元，不得自创、跳过或跨科目混排单元）；\n' +
    '2. 阶段名采用「第N单元 + 单元名」，单元名与目录逐字一致；\n' +
    '3. 每个阶段的任务必须从该单元的小节展开，并覆盖该单元全部小节；\n' +
    '4. 目录未列小节时，按该单元名的常见教学顺序拆 3-6 个任务。';
}

/** 读教材库锚点：官方库（openid=''）或本人库可读；他人私有/不存在/异常 → null（fail-open） */
async function loadTextbookForPlan(app, openid, textbookId) {
  if (!app || !textbookId) return null;
  try {
    const res = await app.database().collection(TEXTBOOK_COLL).where({ textbookId: textbookId }).limit(1).get();
    const rec = (res && res.data && res.data[0]) || null;
    if (!rec) return null;
    if (rec.openid && rec.openid !== openid) return null;   // 他人私有不给看
    return rec;
  } catch (e) {
    return null;
  }
}

function buildSystemPrompt(subject) {
  return '你是一位资深的小学课程编排专家，擅长把一学期的' + subject + '内容拆解成可执行、可核对的阶段计划。\n' +
    '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块、不要多余文字。你的回答第一个字符必须是 {。\n\n' +
    '输出格式：\n' +
    '{"stages":[{"name":"阶段名（如 第1单元 准备课）","weeks":"第1-2周","goal":"阶段目标一句话","tasks":[{"name":"具体任务（可核对）","days":2}]}]}\n\n' +
    '编排规则：\n' +
    '1. 覆盖整学期（约 16-20 周），拆成 4-8 个阶段，每个阶段 3-6 个任务；\n' +
    '2. 每个任务 days 为 1-5 的整数（预计几天完成），所有任务的 days 之和应约等于学期周数×5；\n' +
    '3. 任务必须具体、可核对（如「会认读第1课生字并组词」「熟练口算 10 以内加减法」），不要空泛表述；\n' +
    '4. 由浅入深、符合年级认知水平，严格贴合教材与学期进度；\n' +
    '5. 每个阶段最后安排 1 个可展示的成果任务（朗读 / 口算闯关 / 小制作等）。';
}

/** toc 为空时输出与旧版逐字一致（无 textbookId 时零变化，保证不回归） */
/** 教学计划参考块：teachingPlan raw 文本（自由文本，非结构化）。
 *  空 → 返回空串（零回归：不注入，buildUserPrompt 输出与现状逐字一致）。
 *  超长 → 截断到预算并注记（自由文本无法"整行跳过"，按字符截断）。
 *  优先级：仅作「目标与重点」参考，不得违背教材单元目录的权威划分。 */
const MAX_PLAN_REF_CHARS = 3000;
function buildPlanRefBlock(text) {
  const raw = (text || '').trim();
  if (!raw) return '';
  let body = raw;
  let truncated = false;
  if (body.length > MAX_PLAN_REF_CHARS) {
    body = body.slice(0, MAX_PLAN_REF_CHARS);
    truncated = true;
  }
  return '【教学计划参考（教学目标与重点，仅供参考，不得违背教材单元目录的权威划分）】\n' +
    body + (truncated ? '\n……（教学计划过长已截断）' : '');
}

/* Path A S4：知识点依赖边 → 让计划「先补前置、再上新课」。
 * 读该学科 unitKps 的 prereqs（硬依赖=必须先会 / 软依赖=建议先会），注入编排约束。
 * 空 → 返回空串（零回归）。 */
const MAX_PREREQ_CHARS = 2000;
function buildPrereqBlock(units) {
  if (!Array.isArray(units) || !units.length) return '';
  const lines = [];
  let used = 0;
  units.forEach(u => {
    (Array.isArray(u.points) ? u.points : []).forEach(p => {
      (p.prereqs || []).forEach(r => {
        if (!r || !r.topic) return;
        const line = '「' + (p.topic || '') + '」依赖「' + r.topic + '」' +
          (r.strength === 'hard' ? '（必须先会）' : '（建议先会）');
        if (used + line.length + 1 > MAX_PREREQ_CHARS) return;
        used += line.length + 1;
        lines.push(line);
      });
    });
  });
  if (!lines.length) return '';
  return '【知识点依赖（编排顺序必须遵循：先安排前置知识点，达标后再进入依赖它的点）】\n' + lines.join('\n');
}

/** 读该学科必会库（tutor_unit_kps，按 openid + subject）。异常 → []（fail-open，不拖挂主链路）。 */
async function readUnitKps(app, openid, subject) {
  if (!app || !openid) return [];
  try {
    const where = { openid: openid };
    if (subject) where.subject = subject;
    const res = await app.database().collection(UNITKPS_COLL).where(where).limit(200).get();
    return (res && res.data) || [];
  } catch (e) {
    return [];
  }
}

/** 读该学科学情（错题 + 复习卡毕业态）。异常 → 空（fail-open）。 */
async function readWeakness(app, openid, subject) {
  const out = { mistakes: [], cards: [] };
  if (!app || !openid) return out;
  try {
    const m = await app.database().collection(MISTAKES_COLL)
      .where({ openid: openid, subject: subject }).limit(20).get();
    out.mistakes = (m && m.data) || [];
  } catch (e) {}
  try {
    const c = await app.database().collection(CARDS_COLL)
      .where({ openid: openid, subject: subject }).limit(50).get();
    out.cards = (c && c.data) || [];
  } catch (e) {}
  return out;
}

/* P1：学情薄弱点块 —— 未订正错题 + 未毕业复习卡，让计划「先补薄弱前置、再推进新课」。
 * 空 → 返回空串（零回归）。 */
function buildWeaknessBlock(mistakes, cards) {
  const lines = [];
  (Array.isArray(mistakes) ? mistakes : [])
    .filter(m => m && m.topic && String(m.status || '').toLowerCase() !== 'corrected')
    .slice(0, 5)
    .forEach(m => lines.push('错题「' + m.topic + '」' + (m.errorType ? '（错因 ' + m.errorType + '）' : '')));
  const notDone = [...new Set((Array.isArray(cards) ? cards : [])
    .filter(c => c && c.topic && !c.done)
    .map(c => c.topic))].slice(0, 5);
  notDone.forEach(t => lines.push('未掌握「' + t + '」'));
  if (!lines.length) return '';
  return '【孩子学情（优先编排这些薄弱点：先补牢前置，再推进新课）】\n' + lines.join('\n');
}

function buildUserPrompt(input, toc, planRef, prereq, weakness) {
  let requirement = input.planPrompt || '按默认规则编排';
  // 长提示词（内置学科角色全文）附加框架说明，避免模型被角色里的输出格式要求带偏
  if (requirement.length > 800) {
    requirement = '以下为该科目的「学科角色说明」。编排阶段任务时，请与其能力体系、术语与方法保持一致；' +
      '忽略其中关于答题/对话输出格式的要求，最终只输出计划 JSON。\n\n' + requirement;
  }
  return '请为以下科目编排一学期的阶段计划：\n' +
    '科目：' + input.subject + '\n' +
    '年级：' + (input.grade || '未填写') + '\n' +
    '学期：' + (input.term || '上学期') + '\n' +
    '教材：' + (input.textbook || '未指定（按统编主流版本）') + '\n' +
    (toc ? toc + '\n' : '') +
    (planRef ? planRef + '\n' : '') +
    (prereq ? prereq + '\n' : '') +
    (weakness ? weakness + '\n' : '') +
    '\n编排要求（务必遵守）：\n' + requirement;
}

const CORRECTION = '你上一次的回答不符合要求（不是纯 JSON）。重新回答：只输出 JSON 对象本身，第一个字符必须是 {，最后一个字符必须是 }，不要任何其他字符。';

function validPlan(obj) {
  return !!(obj && Array.isArray(obj.stages) && obj.stages.length &&
    obj.stages.every(st => st && typeof st.name === 'string' && Array.isArray(st.tasks) && st.tasks.length));
}

exports.main = async (event) => {
  const openid = (event.userInfo && event.userInfo.openId) || '';
  const waitMs = rateWait(openid);
  if (waitMs > 0) {
    return {
      ok: false,
      code: 'rate_limit',
      msg: '计划生成太频繁啦，休息一下再试～',
      retryAfterMs: waitMs          // 回传还需等待的毫秒数，前端据此延时重试
    };
  }
  const input = {
    subject: String(event.subject || '').trim().slice(0, 20),
    grade: String(event.grade || '').trim().slice(0, 20),
    term: String(event.term || '').trim().slice(0, 10),
    textbook: String(event.textbook || '').trim().slice(0, 30),
    textbookId: String(event.textbookId || '').trim().slice(0, 60),
    planPrompt: String(event.planPrompt || '').trim().slice(0, 12000),
    teachingPlan: String(event.teachingPlan || '').trim().slice(0, 20000)
  };
  if (!input.subject) return { ok: false, code: 'empty', msg: '缺少科目信息' };
  if (!input.grade) return { ok: false, code: 'no_grade', msg: '请先在资料里填写年级' };

  let app;
  try {
    app = tcb.init({ env: process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf' });
  } catch (e) {
    return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) };
  }

  // 教材库锚点（#19）：官方/本人可读注入目录；其余情况静默不注入（fail-open）
  const tbRec = await loadTextbookForPlan(app, openid, input.textbookId);
  const toc = buildTocBlock(tbRec);
  // 教学计划参考：来自学科画像 teachingPlan 字段（客户端按 subject 透传），空则零回归
  const planRef = buildPlanRefBlock(input.teachingPlan);
  // Path A S4：读该学科 unitKps 依赖边 → 注入「先补前置」编排约束（失败静默跳过）
  const units = await readUnitKps(app, openid, input.subject);
  const prereq = buildPrereqBlock(units);
  // P1：读该学科学情（错题 + 复习卡毕业态）→ 注入「优先补薄弱点」（失败静默跳过）
  const weak = await readWeakness(app, openid, input.subject);
  const weakness = buildWeaknessBlock(weak.mistakes, weak.cards);

  const sys = buildSystemPrompt(input.subject);
  const user = buildUserPrompt(input, toc, planRef, prereq, weakness);

  try {
    const ai = app.ai();
    const model = ai.createModel('cloudbase');
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ];

    let text = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await model.generateText({ model: 'hy3', messages: messages });
      text = (result && result.text) || '';
      const obj = extractJson(text);
      if (validPlan(obj)) {
        return { ok: true, plan: obj, textbookAnchored: !!toc };
      }
      // 解析失败：会话内纠正后重试一次
      messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      messages.push({ role: 'user', content: CORRECTION });
    }
    return { ok: false, code: 'parse', msg: '计划生成结果解析失败，请重试一次' };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/429|too many|rate.?limit|频率|限流/i.test(msg)) {
      return { ok: false, code: 'rate_limit', msg: '请求过于频繁，请稍等几秒再试一次' };
    }
    if (/token|tokencredit|resource|pack|quota|余额|额度|开通|403|404|未购买|模型|model|not found|不存在|unauthorized|forbidden/i.test(msg)) {
      return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
    }
    return { ok: false, code: 'ai_error', msg: '计划生成失败：' + msg };
  }
};

/* 测试导出（EXAM_TEST=1 时生效，生产 exports.main 不受影响） */
if (process.env.EXAM_TEST) {
  module.exports.__test = {
    TEXTBOOK_COLL, MAX_TOC_CHARS, MAX_PLAN_REF_CHARS,
    buildTocBlock, buildPlanRefBlock, buildPrereqBlock, buildWeaknessBlock, buildUserPrompt, buildSystemPrompt,
    loadTextbookForPlan, readUnitKps, readWeakness, extractJson, validPlan
  };
}

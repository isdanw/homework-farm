/**
 * 云函数 tutorRetest —— 全科导学「复测 + 证据契约」（P3 → P0 attempt 化）
 *
 * 入参 action（三选一）:
 *  'generate'  按错题知识点生成 5 道同类复测题；带 features:'attempt_v1' 时建 attempt，
 *              答案/解析只留在服务端，出参不回
 *  'submit'    attempt 模式交卷：只收 attemptId + answers + independence，服务端判分
 *  'judge'     旧路径（兼容未升级的小程序）：客户端带回 questions(含 answer) 由服务端比对
 *
 * 【generate】
 *   subject, topic(知识点), errorType(E1-E9), grade(年级)
 *   features:'attempt_v1'（新客户端）| childId | recommendationId | unitId | kpId | mistakeId
 *   kind: 'retest'(默认) | 'variant'（换情境变式，喂给证据阶梯 L5/L6）
 *   context: 变式情境，**只认白名单**（VARIANT_CONTEXTS）；不在表内一律记空
 *     —— 自由文本会让「不同情境」被随口编出来，L6 就失去意义
 *   出参（attempt 模式）：{ ok:true, attemptId, expiresAt, questions:[{q, options:[4]}] }
 *   出参（旧客户端）：    { ok:true, questions:[{q, options, answer, analysis}] }
 *
 * 【submit】
 *   attemptId, answers[], independence('self_declared_no_hint'|'prompted'|'unknown'),
 *   childId, mistakeId, evidenceClientId
 *   ⚠️ 不收 kind/context：这两个标签只认建 attempt 时服务端存下的值
 *   出参：{ ok:true, attemptId, results:[{correct,your,answer,analysis}], total, correct,
 *          rate, pass, reason, evidenceProduced, independence, evidenceId, evidenceKind, context }
 *
 * 【judge】（兼容路径，证据标 scoredBy='client' / factGrade='client_claimed'）
 *   subject, topic, errorType, questions(含 answer), answers(用户作答)
 *   mistakeId: 本地错题 uid（可空；提供时联动推进 tutor_reviews 复习窗口）
 *   evidenceClientId: 前端预生成的本地证据 uid，写入 clientId 供跨设备去重
 *   出参：{ ok:true, results:[{correct, your, answer}], total, correct, rate, pass, reason }
 *
 * 核心红线（硬编码，不依赖 prompt）：
 *   · 题数 < 5 → pass=false；通过率 < 80% → pass=false；
 *   · **只有服务端判分 + 孩子声明「独立完成」**的复测才形成证据（attempt 路径）；
 *     「有提示/未声明」只留 attempt 记录，不形成证据、不推进复习；
 *   · 绝不生成「已掌握」结论（前端只显示「达标/未达标」）。
 *   · 变式（kind='variant'）只是给证据**贴标签**，判分门槛与普通复测完全一致；
 *     是否算「变式独立达标」由端上 evidenceLadder 按同一套阈值复核，本函数不判档位。
 *
 * 复习窗口联动（闭环 S2）：
 *   达标 → 对应 tutor_reviews 置 done=true；未达标 → stage+1（封顶 5），dueAt 顺延
 *   复习推进只由复测证据驱动（活动≠证据≠掌握），AI / 复习行为本身无权推进。
 */
const crypto = require('crypto');
const tcb = require('@cloudbase/node-sdk');
const G = require('./scopeGuard');

/* 学科展示名 */
const SUBJECT_NAMES = {
  math: '数学', chinese: '语文', english: '英语',
  physics: '物理', chemistry: '化学', biology: '生物',
  history: '历史', geography: '地理', politics: '道德与法治'
};

/* 固定复测题数（证据契约下限） */
const RETEST_COUNT = 5;
const PASS_RATE = 0.8;

/* attempt：服务端保存答案，客户端只拿题面；2 小时有效（够一次作业内完成，过期重出） */
const ATTEMPTS = 'tutor_retest_attempts';
const ATTEMPT_TTL_MS = 2 * 60 * 60 * 1000;
const INDEPENDENCE_VALUES = ['self_declared_no_hint', 'prompted', 'unknown'];

/* 变式复测（证据阶梯 L5/L6 的记录源）：
 *   kind 决定「这套题是不是换情境的变式」，context 决定它属于哪一种情境。
 *   ⚠️ 二者都只贴在服务端建的 attempt 上，交卷时客户端改不了 ——
 *      否则把普通复测事后改标成变式就能白升一档。
 *   ⚠️ context 走白名单：自由文本会让「不同情境」随口编出来，L6 失去意义。
 *      不在表内一律记空（空情境的变式只算「做过变式」，不参与情境去重）。
 * 端上 config.PROFILE.VARIANT_CONTEXTS 与本表必须同口径（由测试脚本静态比对）。 */
const ATTEMPT_KINDS = ['retest', 'variant'];
const VARIANT_CONTEXTS = ['换数字', '换问法', '生活情境', '图形与表格', '易错边界'];

/* 艾宾浩斯档位（天）：与 tutorChat / 前端 tutorStore 保持一致 */
const REVIEW_STAGE_DAYS = [1, 2, 4, 7, 15];

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

/** 生成题目的 prompt（结构化选择题，针对错题知识点做变式，不直接给答案） */
const GEN_PROMPT =
  '你是「复测出题」模块。根据一个错题知识点，出 ' + RETEST_COUNT + ' 道同类的单选题（4 个选项，只有一个正确），' +
  '用于检验孩子是否真正掌握（不复述原题，做条件/数字/问法变式）。\n\n' +
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，第一个字符必须是 {。\n\n' +
  '输出格式：\n' +
  '{"questions":[{"q":"题目文字","options":["选项A","选项B","选项C","选项D"],"answer":"A","analysis":"简短解析（一句话说明为什么选这个）"}]}\n\n' +
  '规则：\n' +
  '1. answer 必须是 "A"、"B"、"C"、"D" 之一，对应 options 的下标（0=A,1=B,2=C,3=D）。\n' +
  '2. 题目难度由易到难递进，第一题最基础、最后一题做变式迁移。\n' +
  '3. 贴合年级水平，题干简短、选项不歧义；只出一个正确答案。\n' +
  '4. 不编造教材原文、不出现超纲内容；不确定就出更基础的题。\n' +
  '5. 必须正好 ' + RETEST_COUNT + ' 道题。';

/** 解析生成结果（防御：过滤非法题） */
function parseQuestions(text) {
  const obj = extractJson(text);
  if (!obj || !Array.isArray(obj.questions)) return [];
  const out = [];
  for (const q of obj.questions) {
    const options = Array.isArray(q.options) ? q.options.map(o => str(o, 100)).filter(Boolean) : [];
    const answer = str(q.answer, 1).toUpperCase();
    if (!q || !str(q.q) || options.length < 2 || !/^[A-D]$/.test(answer)) continue;
    out.push({
      q: str(q.q, 200),
      options: options.slice(0, 4),
      answer: answer,
      analysis: str(q.analysis, 150)
    });
  }
  return out;
}

/** 变式出题 prompt：同一知识点，换条件/情境出**新题**（证据阶梯 L5/L6 的记录源） */
const VARIANT_PROMPT =
  '你是「变式出题」模块。给定一个知识点，出 ' + RETEST_COUNT + ' 道**换了条件或情境**的单选题' +
  '（4 个选项，只有一个正确），用来检验孩子能不能把方法用到新情境里。\n\n' +
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，第一个字符必须是 {。\n\n' +
  '输出格式：\n' +
  '{"questions":[{"q":"题目文字","options":["选项A","选项B","选项C","选项D"],"answer":"A","analysis":"一句话说明这题换了什么"}]}\n\n' +
  '规则：\n' +
  '1. answer 必须是 "A"、"B"、"C"、"D" 之一，对应 options 的下标（0=A,1=B,2=C,3=D）。\n' +
  '2. 每题都必须是**新题面**：不照搬教材例句或常见成题，数字、对象、问法、情境至少变一项。\n' +
  '3. 全程围绕给定「情境变化」出题；该情境没给定时，每题自己选一项变化并在 analysis 里说明。\n' +
  '4. 难度由易到难递进，最后一题做迁移；贴合年级、不超纲、不编造教材原文。\n' +
  '5. 必须正好 ' + RETEST_COUNT + ' 道题。';

/** 生成复测题 */
async function generate(app, input, ctx) {
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  const gradePart = input.grade ? ('孩子年级：' + str(input.grade, 20) + '。') : '';
  const errPart = input.errorType ? ('错因类型：' + str(input.errorType, 10) + '（针对该错因做变式）。') : '';
  const isVariant = input.kind === 'variant';
  const ctxPart = isVariant ? ('情境变化：' + (input.context || '未指定（每题自选一项变化）') + '。') : '';
  const result = await model.generateText({
    model: 'hy3',
    messages: [
      { role: 'system', content: isVariant ? VARIANT_PROMPT : GEN_PROMPT },
      { role: 'user', content: '请出 ' + RETEST_COUNT + ' 道' + (isVariant ? '变式' : '复测') + '题。\n学科：' +
        (SUBJECT_NAMES[input.subject] || input.subject) + '\n知识点：' + str(input.topic, 100) +
        '\n' + gradePart + errPart + ctxPart }
    ]
  });
  const questions = parseQuestions((result && result.text) || '');
  if (!questions.length) return { ok: false, code: 'empty_questions', msg: '复测题生成失败，请重试' };
  // 旧客户端：原样回题（含答案），走 judge 兼容路径
  if (!input.attemptMode) return { ok: true, questions: questions };
  return await createAttempt(app, input, ctx, questions);
}

/* ---------------- attempt：服务端存答案，判分只在服务端 ---------------- */

function hex(v) {
  return crypto.createHash('sha1').update(String(v), 'utf8').digest('hex');
}

/** attemptId 由服务端生成（不信任客户端），用随机串保证同一孩子下不撞 */
function newAttemptId() {
  return 'at' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function normIndependence(v) {
  const s = str(v, 40);
  return INDEPENDENCE_VALUES.indexOf(s) >= 0 ? s : 'unknown';
}

function normKind(v) {
  const s = str(v, 20);
  return ATTEMPT_KINDS.indexOf(s) >= 0 ? s : 'retest';
}

/** 变式情境只认白名单；表外一律空（不猜、不改写成近似项） */
function normContext(v) {
  const s = str(v, 20);
  return VARIANT_CONTEXTS.indexOf(s) >= 0 ? s : '';
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * 建 attempt。答案与解析只写在这里，generate 的返回体里没有它们。
 * ⚠️ 部分环境对 `add({_id})` 报错（CloudBase 各 SDK 版本不一致），失败时退化为自动 _id ——
 *    attemptId 本身是服务端随机串，重复只可能来自重放，而 submit 会按 attemptId 查回原文档。
 */
async function createAttempt(app, input, ctx, questions) {
  const db = app.database();
  const now = Date.now();
  const attemptId = newAttemptId();
  const doc = {
    _id: 'rta_' + hex(ctx.openid).slice(0, 10) + '_' + (ctx.childId || 'none') + '_' + attemptId,
    attemptId: attemptId,
    openid: ctx.openid,
    childId: ctx.childId || '',
    recommendationId: input.recommendationId,
    unitId: input.unitId,
    kpId: input.kpId,
    // 变式标签：建 attempt 时钉死，submit 只读不改（客户端事后改标就能白升一档，故不给它这个口子）
    kind: input.kind,
    context: input.context,
    mistakeClientId: input.mistakeId,
    subject: input.subject,
    topic: input.topic,
    errorType: input.errorType,
    grade: input.grade,
    questions: questions,          // [{q, options, answer, analysis}] —— 仅服务端可见
    answers: [],
    total: questions.length,
    status: 'generated',
    independence: '',
    correct: 0,
    rate: 0,
    passed: false,
    evidenceProduced: false,
    createdAt: now,
    expiresAt: now + ATTEMPT_TTL_MS,
    submittedAt: 0
  };
  try {
    await db.collection(ATTEMPTS).add(doc);
  } catch (e) {
    try { await db.createCollection(ATTEMPTS); } catch (e2) {}
    try {
      await db.collection(ATTEMPTS).add(doc);
    } catch (e3) {
      const noId = Object.assign({}, doc);
      delete noId._id;
      await db.collection(ATTEMPTS).add(noId);
    }
  }
  return {
    ok: true,
    attemptId: attemptId,
    expiresAt: doc.expiresAt,
    // 只回题面：answer/analysis 留在服务端，客户端无从修改判分依据
    questions: questions.map(function (q) { return { q: q.q, options: q.options }; })
  };
}

/** 同一 attemptId 只允许一条证据（重复提交不翻倍） */
async function findEvidenceByAttempt(db, openid, attemptId) {
  try {
    const res = await db.collection('tutor_evidence')
      .where({ openid: openid, attemptId: attemptId }).limit(1).get();
    return (res && res.data && res.data[0]) || null;
  } catch (e) {
    return null;
  }
}

/** 交卷：服务端用自己存的答案判分，写 attempt 结果 +（满足条件时）证据 */
async function submit(app, input, ctx) {
  const db = app.database();
  const attemptId = str(input.attemptId, 60);
  if (!attemptId) return { ok: false, code: 'no_attempt', msg: '缺少复测编号，请重新出题' };

  let doc = null;
  try {
    const res = await db.collection(ATTEMPTS)
      .where({ openid: ctx.openid, attemptId: attemptId }).limit(1).get();
    doc = (res && res.data && res.data[0]) || null;
  } catch (e) { doc = null; }
  if (!doc) return { ok: false, code: 'no_attempt', msg: '这套复测题已失效，请重新出题' };
  // 跨孩子复用同一套题 → 拒绝（证据会挂错孩子）
  if (doc.childId && ctx.childId && doc.childId !== ctx.childId) {
    return { ok: false, code: 'child_mismatch', msg: '复测与当前孩子不匹配，请重新出题' };
  }

  const questions = Array.isArray(doc.questions) ? doc.questions : [];
  const total = Number(doc.total) || questions.length;

  // 幂等：已交过卷，原样回放当时的判定（不重复写证据、不重复推进复习）
  if (doc.status === 'submitted') {
    const ev = await findEvidenceByAttempt(db, ctx.openid, attemptId);
    return buildSubmitResult(doc, ev ? String(ev._id) : '', '这套题已交过卷，以下为当时的判定结果');
  }
  if (doc.status !== 'generated') {
    return { ok: false, code: 'attempt_' + doc.status, msg: '这套复测题已不可用，请重新出题' };
  }
  if (Number(doc.expiresAt) && Date.now() > Number(doc.expiresAt)) {
    try {
      await db.collection(ATTEMPTS).doc(doc._id).update({ status: 'expired' });
    } catch (e) {}
    return { ok: false, code: 'attempt_expired', msg: '这套题已过期，请重新出题' };
  }

  const rawAnswers = Array.isArray(input.answers) ? input.answers : [];
  const answers = questions.map(function (_, i) { return normAnswer(rawAnswers[i]); });
  const results = questions.map(function (q, i) {
    const your = answers[i];
    return {
      index: i,
      correct: !!your && your === q.answer,
      your: your,
      answer: q.answer,
      analysis: q.analysis || ''
    };
  });
  const correct = results.filter(function (r) { return r.correct; }).length;
  const verdict = judgeEvidence(total, correct);
  const independence = normIndependence(input.independence);
  const selfDeclared = independence === 'self_declared_no_hint';
  const now = Date.now();

  const patch = {
    answers: answers,
    independence: independence,
    correct: correct,
    rate: round2(verdict.rate),
    passed: verdict.pass,
    status: 'submitted',
    submittedAt: now,
    // 只有「独立完成」的复测才形成证据；有提示只留 attempt
    evidenceProduced: selfDeclared
  };
  try {
    await db.collection(ATTEMPTS).doc(doc._id).update(patch);
  } catch (e) {}

  let evidenceId = '';
  if (selfDeclared) {
    evidenceId = await writeAttemptEvidence(app, ctx, doc, {
      correct: correct,
      rate: round2(verdict.rate),
      passed: verdict.pass,
      independence: independence,
      evidenceClientId: input.evidenceClientId
    });
    try {
      await syncReview(app, ctx.openid, str(input.mistakeId, 60) || doc.mistakeClientId || '', verdict.pass);
    } catch (e) {}
  }

  const reason = !verdict.pass ? verdict.reason
    : (selfDeclared ? '' : '这次有提示，题目记录已保存，但不计入复测证据。');
  return {
    ok: true,
    attemptId: attemptId,
    // 变式标签由服务端 attempt 回给客户端（前端存的是「服务端记下的」，不是「前端请求的」）
    evidenceKind: doc.kind || 'retest',
    context: doc.context || '',
    results: results,
    total: total,
    correct: correct,
    rate: round2(verdict.rate),
    pass: verdict.pass,
    reason: reason,
    independence: independence,
    evidenceProduced: selfDeclared,
    evidenceId: evidenceId
  };
}

/** 幂等回放：用 attempt 上已存的结果重建响应 */
function buildSubmitResult(doc, evidenceId, note) {
  const questions = Array.isArray(doc.questions) ? doc.questions : [];
  const answers = Array.isArray(doc.answers) ? doc.answers : [];
  const results = questions.map(function (q, i) {
    const your = normAnswer(answers[i]);
    return {
      index: i,
      correct: !!your && your === q.answer,
      your: your,
      answer: q.answer,
      analysis: q.analysis || ''
    };
  });
  return {
    ok: true,
    attemptId: doc.attemptId,
    results: results,
    total: Number(doc.total) || questions.length,
    correct: Number(doc.correct) || 0,
    rate: Number(doc.rate) || 0,
    pass: !!doc.passed,
    reason: doc.passed ? '' : '通过率 ' + Math.round((Number(doc.rate) || 0) * 100) + '% 未达 80%',
    independence: doc.independence || 'unknown',
    // 重放也要把变式标签带回去，否则换设备重进这页会把「变式」存成普通复测
    evidenceKind: doc.kind || 'retest',
    context: doc.context || '',
    evidenceProduced: !!doc.evidenceProduced,
    evidenceId: evidenceId || '',
    replayed: true,
    msg: note || ''
  };
}

/** 写 attempt 证据（按 attemptId 幂等），返回云端 _id */
async function writeAttemptEvidence(app, ctx, doc, scored) {
  const db = app.database();
  const attemptId = doc.attemptId;
  const exist = await findEvidenceByAttempt(db, ctx.openid, attemptId);
  if (exist) return String(exist._id);

  const ev = {
    openid: ctx.openid,
    childId: doc.childId || ctx.childId || '',
    attemptId: attemptId,
    // 本地证据 id 与云端 clientId 对齐（新旧客户端都按这个 merge）
    clientId: str(scored.evidenceClientId, 60) || ('ev_' + attemptId),
    recommendationId: doc.recommendationId || '',
    unitId: doc.unitId || '',
    kpId: doc.kpId || '',
    // 变式标签随证据一起落库：端上证据阶梯靠它点亮 L5/L6（判分门槛不变）
    evidenceKind: doc.kind || 'retest',
    context: doc.context || '',
    subject: doc.subject || '',
    topic: doc.topic || '',
    errorType: /^E[1-9]$/.test(doc.errorType || '') ? doc.errorType : '',
    total: Number(doc.total) || 0,
    correct: scored.correct,
    rate: scored.rate,
    passed: !!scored.passed,
    independence: scored.independence,
    scoredBy: 'server',
    factGrade: 'server_recorded',
    createdAt: Date.now()
  };
  try {
    const res = await db.collection('tutor_evidence').add(ev);
    return String((res && res.id) || '');
  } catch (e) {
    try { await db.createCollection('tutor_evidence'); } catch (e2) {}
    try {
      const res = await db.collection('tutor_evidence').add(ev);
      return String((res && res.id) || '');
    } catch (e3) { return ''; }
  }
}

/* ---------------- 证据契约（硬编码，绝不依赖 prompt） ---------------- */
function judgeEvidence(total, correct) {
  const rate = total > 0 ? correct / total : 0;
  if (total < RETEST_COUNT) return { pass: false, rate: rate, reason: '题数不足 ' + RETEST_COUNT + '，无法判定' };
  if (rate < PASS_RATE) return { pass: false, rate: rate, reason: '通过率 ' + Math.round(rate * 100) + '% 未达 80%' };
  return { pass: true, rate: rate, reason: '' };
}

/** 归一化答案（A/B/C/D，容忍全角/空格/小写） */
function normAnswer(v) {
  return String(v == null ? '' : v).trim().toUpperCase().replace(/[（(]/g, '').replace(/[）)]/g, '').slice(0, 1);
}

/**
 * 复习窗口联动（按本地错题 uid 定位，失败静默——复测判定不被联动阻塞）
 *   pass=true  → review done=true；同时 tutor_mistakes 置 corrected
 *   pass=false → review stage+1（封顶 5），dueAt 顺延
 */
async function syncReview(app, openid, mistakeId, pass) {
  if (!mistakeId) return;
  const db = app.database();
  const now = Date.now();
  try {
    const res = await db.collection('tutor_reviews')
      .where({ openid: openid, mistakeClientId: mistakeId, done: false })
      .limit(1)
      .get();
    const doc = res && res.data && res.data[0];
    if (doc) {
      // ⚠️ @cloudbase/node-sdk 的 update(obj)：键即字段名，**无 { data:{} } 包壳**（包壳会写进 data.data 失效）
      if (pass) {
        await db.collection('tutor_reviews').doc(doc._id).update({
          done: true, updatedAt: now
        });
      } else {
        const stage = Math.min((Number(doc.stage) || 1) + 1, REVIEW_STAGE_DAYS.length);
        const days = REVIEW_STAGE_DAYS[stage - 1] || 1;
        await db.collection('tutor_reviews').doc(doc._id).update({
          stage: stage, dueAt: now + days * 86400000, updatedAt: now
        });
      }
    }
  } catch (e) {}
  // 达标 → 云端错题同步为「已订正」（与前端本地状态一致）
  if (pass) {
    try {
      await db.collection('tutor_mistakes')
        .where({ openid: openid, clientId: mistakeId })
        .update({ status: 'corrected' });
    } catch (e2) {}
  }
}

/** 读该 openid 的家庭根数据（users[]/currentUserId），用于解析证据归属 */
async function loadRoot(app, openid) {
  try {
    const res = await app.database().collection('hw_farm_user')
      .where({ _openid: openid }).limit(1).get();
    const doc = (res && res.data && res.data[0]) || null;
    return (doc && doc.data) || null;
  } catch (e) {
    return null;
  }
}

/** 判定作答 + 落库 */
async function judge(app, input, openid, childId) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers = Array.isArray(input.answers) ? input.answers : [];

  const results = questions.map((q, i) => {
    const your = normAnswer(answers[i]);
    const correct = !!your && your === q.answer;
    return { index: i, correct: correct, your: your, answer: q.answer };
  });
  const correct = results.filter(r => r.correct).length;
  const verdict = judgeEvidence(questions.length, correct);

  // 落库：一条记录（passed 区分证据 vs 尝试），openid 隔离
  // ⚠️ 必须带 clientId（= 前端本地证据 uid）：tutorSync(push) 按 openid+clientId 去重，
  //    缺此字段会导致同一份证据被 push 再补写一条 → 云端与本地双双翻倍（P0-5）。
  //
  // ⚠️ 兼容路径的判分依据来自客户端回传的 questions[].answer：
  //    服务端只能确认「孩子答的与客户端声明的答案一致」，无法证明答案本身没被改过，
  //    也无法确认作答时是独立完成。故标 factGrade='client_claimed'，与 attempt 路径
  //    的 'server_recorded' 区分开 —— 学情结论只应采用后者。
  const doc = {
    openid: openid,
    childId: childId,
    clientId: str(input.evidenceClientId, 60),
    attemptId: '',
    independence: 'unknown',
    scoredBy: 'client',
    factGrade: 'client_claimed',
    // 兼容路径永不产变式证据：题面答案由客户端带回，「换了情境也做对了」这句话没人能证明
    evidenceKind: 'retest',
    context: '',
    subject: str(input.subject, 20),
    topic: str(input.topic, 100),
    errorType: /^E[1-9]$/.test(input.errorType || '') ? input.errorType : '',
    total: questions.length,
    correct: correct,
    rate: Math.round(verdict.rate * 100) / 100,
    passed: verdict.pass,
    createdAt: Date.now()
  };
  try {
    // node-sdk 的 add(obj)：obj 直接作为新文档，无 { data:{} } 包壳
    await app.database().collection('tutor_evidence').add(doc);
  } catch (e) {
    try { await app.database().createCollection('tutor_evidence'); } catch (e2) {}
    try { await app.database().collection('tutor_evidence').add(doc); } catch (e3) {}
  }

  // 复习窗口联动（不影响判定结果返回）
  try { await syncReview(app, openid, input.mistakeId, verdict.pass); } catch (e4) {}

  return {
    ok: true,
    results: results,
    total: questions.length,
    correct: correct,
    rate: Math.round(verdict.rate * 100) / 100,
    pass: verdict.pass,
    reason: verdict.reason
  };
}

/* ---------------- 主入口 ---------------- */
const ACTIONS = ['generate', 'submit', 'judge'];

/** features 是逗号分隔的能力开关串；attempt_v1 = 客户端接受「题面不含答案」的契约 */
function hasFeature(raw, name) {
  return str(raw, 200).split(',').some(function (s) { return s.trim() === name; });
}

exports.main = async (event) => {
  // 身份守卫（P0）：本函数是全系统唯一证据写入口，空身份一律拒绝
  const gate = G.requireOpenid((event.userInfo && event.userInfo.openId) || '');
  if (!gate.ok) return { ok: false, code: gate.code, msg: '缺少用户身份，无法复测' };
  const openid = gate.openid;
  const action = ACTIONS.indexOf(event.action) >= 0 ? event.action : 'judge';

  // 新客户端才走 attempt 契约；老客户端继续拿含答案的题面（否则会静默产生错误证据）
  const attemptMode = action === 'generate' && hasFeature(event.features, 'attempt_v1');

  const input = {
    subject: str(event.subject, 20),
    topic: str(event.topic, 100),
    errorType: str(event.errorType, 10),
    grade: str(event.grade, 20),
    childId: str(event.childId, 64),
    mistakeId: str(event.mistakeId, 60),
    recommendationId: str(event.recommendationId, 60),
    unitId: str(event.unitId, 60),
    kpId: str(event.kpId, 60),
    attemptId: str(event.attemptId, 60),
    independence: str(event.independence, 40),
    evidenceClientId: str(event.evidenceClientId, 60),
    // 变式标签只在 attempt 契约下生效：旧路径判分依据来自客户端，够不上「变式独立达标」
    kind: attemptMode ? normKind(event.kind) : 'retest',
    context: attemptMode ? normContext(event.context) : '',
    attemptMode: attemptMode,
    questions: Array.isArray(event.questions) ? event.questions.slice(0, 20) : [],
    answers: Array.isArray(event.answers) ? event.answers.slice(0, 20) : []
  };

  // submit 的学科/知识点来自服务端存的 attempt，只对 generate/judge 校验入参
  if (action !== 'submit' && !SUBJECT_NAMES[input.subject]) {
    return { ok: false, code: 'bad_subject', msg: '暂不支持该学科的复测' };
  }
  if (action === 'generate' && !input.topic) {
    return { ok: false, code: 'empty', msg: '请先选择要复测的知识点' };
  }
  if (action === 'judge' && !input.questions.length) {
    return { ok: false, code: 'empty', msg: '没有可判定的复测题' };
  }

  let app;
  try {
    app = tcb.init({ env: process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf' });
  } catch (e) {
    return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) };
  }

  // childId 解析一次，三条路径共用：跨家庭 id 一律拒绝（证据/题目都不能挂到别人孩子名下）
  let kid;
  try {
    kid = G.resolveChildId(await loadRoot(app, openid), input.childId);
  } catch (e) {
    kid = { childId: '', source: 'none' };
  }
  if (kid.source === 'invalid') {
    return { ok: false, code: 'child_scope_invalid', msg: '指定的孩子不属于当前账号，已拒绝' };
  }
  const ctx = { openid: openid, childId: kid.childId };

  if (action === 'generate') {
    try {
      return await generate(app, input, ctx);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/token|resource|pack|quota|余额|额度|开通|403|404|未购买|模型|not found|不存在|forbidden/i.test(msg)) {
        return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
      }
      return { ok: false, code: 'gen_error', msg: '复测题生成失败：' + msg };
    }
  }

  if (action === 'submit') {
    try {
      return await submit(app, input, ctx);
    } catch (e) {
      return { ok: false, code: 'submit_error', msg: '交卷失败：' + ((e && e.message) || e) };
    }
  }

  try {
    return await judge(app, input, openid, kid.childId);
  } catch (e) {
    return { ok: false, code: 'judge_error', msg: '判定失败：' + ((e && e.message) || e) };
  }
};

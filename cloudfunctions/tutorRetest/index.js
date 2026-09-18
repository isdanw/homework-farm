/**
 * 云函数 tutorRetest —— 全科导学「复测 + 证据契约」（P3）
 *
 * 入参 action:
 *  'generate'  按错题知识点生成 5 道同类复测题（结构化选择题）
 *  'judge'     本地判定作答对错 + 硬编码证据契约（≥5 题且 ≥80%），pass 才写 tutor_evidence
 *
 * 【generate】
 *   subject, topic(知识点), errorType(E1-E9), grade(年级)
 *   出参：{ ok:true, questions:[{q, options:[4], answer, analysis}] }
 *
 * 【judge】
 *   subject, topic, errorType, questions(含 answer), answers(用户作答)
 *   mistakeId: 本地错题 uid（可空；提供时联动推进 tutor_reviews 复习窗口）
 *   出参：{ ok:true, results:[{correct, your, answer}], total, correct, rate, pass, reason }
 *
 * 核心红线（硬编码，不依赖 prompt）：
 *   复测题数 < 5 → pass=false；通过率 < 80% → pass=false；仅 pass=true 才形成「已验证」证据。
 *   绝不生成「已掌握」结论（前端只显示「达标/未达标」，不显示「掌握」）。
 *
 * 复习窗口联动（闭环 S2）：
 *   pass=true  → 对应 tutor_reviews 置 done=true（复习窗口关闭）
 *   pass=false → stage+1（封顶 5），dueAt 顺延到下一档
 *   复习推进只由复测证据驱动（活动≠证据≠掌握），AI / 复习行为本身无权推进。
 */
const tcb = require('@cloudbase/node-sdk');

/* 学科展示名 */
const SUBJECT_NAMES = {
  math: '数学', chinese: '语文', english: '英语',
  physics: '物理', chemistry: '化学', biology: '生物',
  history: '历史', geography: '地理', politics: '道德与法治'
};

/* 固定复测题数（证据契约下限） */
const RETEST_COUNT = 5;
const PASS_RATE = 0.8;

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

/** 生成复测题 */
async function generate(app, input) {
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  const gradePart = input.grade ? ('孩子年级：' + str(input.grade, 20) + '。') : '';
  const errPart = input.errorType ? ('错因类型：' + str(input.errorType, 10) + '（针对该错因做变式）。') : '';
  const result = await model.generateText({
    model: 'hy3',
    messages: [
      { role: 'system', content: GEN_PROMPT },
      { role: 'user', content: '请出 ' + RETEST_COUNT + ' 道复测题。\n学科：' +
        (SUBJECT_NAMES[input.subject] || input.subject) + '\n知识点：' + str(input.topic, 100) +
        '\n' + gradePart + errPart }
    ]
  });
  const questions = parseQuestions((result && result.text) || '');
  if (!questions.length) return { ok: false, code: 'empty_questions', msg: '复测题生成失败，请重试' };
  return { ok: true, questions: questions };
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

/** 判定作答 + 落库 */
async function judge(app, input, openid) {
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
  const doc = {
    openid: openid,
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
exports.main = async (event) => {
  const openid = (event.userInfo && event.userInfo.openId) || '';
  const action = event.action === 'generate' ? 'generate' : 'judge';

  const input = {
    subject: str(event.subject, 20),
    topic: str(event.topic, 100),
    errorType: str(event.errorType, 10),
    grade: str(event.grade, 20),
    mistakeId: str(event.mistakeId, 60),
    questions: Array.isArray(event.questions) ? event.questions.slice(0, 20) : [],
    answers: Array.isArray(event.answers) ? event.answers.slice(0, 20) : []
  };

  if (!SUBJECT_NAMES[input.subject]) return { ok: false, code: 'bad_subject', msg: '暂不支持该学科的复测' };

  let app;
  try {
    app = tcb.init({ env: process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf' });
  } catch (e) {
    return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) };
  }

  if (action === 'generate') {
    if (!input.topic) return { ok: false, code: 'empty', msg: '请先选择要复测的知识点' };
    try {
      return await generate(app, input);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/token|resource|pack|quota|余额|额度|开通|403|404|未购买|模型|not found|不存在|forbidden/i.test(msg)) {
        return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
      }
      return { ok: false, code: 'gen_error', msg: '复测题生成失败：' + msg };
    }
  }

  // judge
  if (!input.questions.length) return { ok: false, code: 'empty', msg: '没有可判定的复测题' };
  try {
    return await judge(app, input, openid);
  } catch (e) {
    return { ok: false, code: 'judge_error', msg: '判定失败：' + ((e && e.message) || e) };
  }
};

/**
 * test-retest-attempt.cjs —— 复测 attempt 化回归测试（P0 · v3 §7.2）
 * ---------------------------------------------------------------------------
 * 用内存 DB + 假 AI 驱动**真实的 tutorRetest 源码**，锁住 attempt 契约：
 *   1. generate（features=attempt_v1）回题面但**不回答案/解析**，答案只落服务端；
 *   2. submit 用服务端存的答案判分 —— 客户端回传的 questions/answer 一律无视；
 *   3. 同一 attemptId 重复交卷幂等：回放结果，证据只有一条；
 *   4. 过期 attempt 不可交卷；
 *   5. 证据门槛：≥5 题且 ≥80% **且** independence=self_declared_no_hint；
 *      「有提示」只留 attempt 记录，不写证据、不推进复习窗口；
 *   6. attempt 记在哪个孩子名下，就只能被那个孩子交卷（child_mismatch）；
 *   7. 兼容路径 judge 的证据标 client_claimed（与 attempt 的 server_recorded 区分）。
 *   8. 变式复测（kind='variant'）：标签只在建 attempt 时钉死，context 走白名单，
 *      随证据落库供端上证据阶梯点亮 L5/L6；判分门槛与普通复测完全一致。
 *
 *     node scripts/test-retest-attempt.cjs
 *
 * 反证：把 createAttempt 里 `questions.map(仅回 q/options)` 改回整题返回 → 见「不泄题」红；
 *      把 evidenceProduced 改成恒 true → 见「有提示也产生了证据」红；
 *      把 status==='submitted' 的幂等分支删掉 → 见「证据翻倍」红。
 */
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------ 内存 DB ------------------------------ */
function makeDb() {
  const colls = new Map();
  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  function coll(name) { if (!colls.has(name)) colls.set(name, []); return colls.get(name); }

  const CMD = {
    exists: (val) => ({ __op: 'exists', val }),
    remove: () => ({ __op: 'remove' }),
  };

  function match(doc, q) {
    return Object.keys(q).every((k) => {
      const v = q[k];
      if (v && v.__op === 'exists') return (k in doc) === v.val;
      const dv = doc[k];
      if (dv && typeof dv === 'object') return JSON.stringify(dv) === JSON.stringify(v);
      return dv === v;
    });
  }

  function unwrap(v) {
    if (v && typeof v === 'object' && 'data' in v && Object.keys(v).length === 1) return v.data;
    return v;
  }

  function merge(doc, patch) {
    patch = unwrap(patch);
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && v.__op === 'remove') delete doc[k];
      else doc[k] = clone(v);
    }
    return doc;
  }

  function chain(name, q) {
    const c = { _q: q || {}, _limit: 1e9 };
    c.limit = (n) => { c._limit = n; return c; };
    c.orderBy = () => c;
    c.get = () => Promise.resolve({ data: coll(name).filter(d => match(d, c._q)).slice(0, c._limit).map(clone) });
    c.update = (patch) => {
      let n = 0;
      coll(name).forEach((d) => { if (match(d, c._q)) { merge(d, patch); n++; } });
      return Promise.resolve({ updated: n });
    };
    c.remove = () => {
      const keep = coll(name).filter(d => !match(d, c._q));
      const removed = coll(name).length - keep.length;
      colls.set(name, keep);
      return Promise.resolve({ removed });
    };
    return c;
  }

  return {
    _colls: colls,
    command: CMD,
    createCollection: (name) => { coll(name); return Promise.resolve({}); },
    collection: (name) => ({
      where: (q) => chain(name, q),
      limit: (n) => chain(name).limit(n),
      orderBy: () => chain(name),
      get: () => chain(name).get(),
      add: (obj) => {
        const raw = clone(unwrap(obj));
        // 与真实 CloudBase 一致：带 _id 就沿用（重复 _id 会报错），不带则自动生成
        if (raw._id) {
          if (coll(name).some(x => x._id === raw._id)) return Promise.reject(new Error('duplicate _id'));
          coll(name).push(raw);
          return Promise.resolve({ id: raw._id });
        }
        const d = Object.assign({ _id: 'id_' + (coll(name).length + 1) + '_' + Math.random().toString(36).slice(2, 7) }, raw);
        coll(name).push(d);
        return Promise.resolve({ id: d._id });
      },
      doc: (id) => ({
        get: () => Promise.resolve({ data: clone(coll(name).find(x => x._id === id) || null) }),
        update: (patch) => {
          const d = coll(name).find(x => x._id === id);
          if (!d) return Promise.reject(new Error('doc not found'));
          merge(d, patch);
          return Promise.resolve({ updated: 1 });
        },
        remove: () => {
          const keep = coll(name).filter(x => x._id !== id);
          colls.set(name, keep);
          return Promise.resolve({ removed: 1 });
        },
      }),
    }),
  };
}

/* ---------------------- AI / SDK 拦截 ---------------------- */
const AI_QUESTIONS = [
  { q: '1+1=?', options: ['1', '2', '3', '4'], answer: 'B', analysis: '一加一等于二' },
  { q: '2+2=?', options: ['2', '3', '4', '5'], answer: 'C', analysis: '二加二等于四' },
  { q: '3+3=?', options: ['5', '6', '7', '8'], answer: 'B', analysis: '三加三等于六' },
  { q: '4+4=?', options: ['7', '8', '9', '10'], answer: 'B', analysis: '四加四等于八' },
  { q: '5+5=?', options: ['9', '10', '11', '12'], answer: 'B', analysis: '五加五等于十' },
];
const RIGHT = ['B', 'C', 'B', 'B', 'B'];
const WRONG = ['A', 'A', 'A', 'A', 'A'];

let mockDb = null;
let aiQuestions = AI_QUESTIONS;
let aiCalls = 0;
let aiMessages = [];
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@cloudbase/node-sdk') {
    return {
      init: () => ({
        database: () => mockDb,
        ai: () => ({
          createModel: () => ({
            generateText: (params) => {
              aiCalls++;
              aiMessages = (params && params.messages) || [];
              return Promise.resolve({ text: JSON.stringify({ questions: aiQuestions }) });
            },
          }),
        }),
      }),
    };
  }
  return origLoad.apply(this, arguments);
};

const FN_PATH = path.join(ROOT, 'cloudfunctions/tutorRetest/index.js');
function load() { delete require.cache[FN_PATH]; return require(FN_PATH); }

/* ------------------------------ 断言 ------------------------------ */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(n) { console.log('\n' + n); }

const ROOT_DATA = {
  currentUserId: 'c2',
  users: [
    { id: 'c1', name: '大宝' },
    { id: 'c2', name: '二宝' },
  ],
};
function rows(db, name) { return db._colls.get(name) || []; }
function seedUser(db, openid) { db.collection('hw_farm_user').add({ _openid: openid, data: ROOT_DATA, updatedAt: 1 }); }
function seedReview(db) {
  db.collection('tutor_reviews').add({
    _id: 'rv1', openid: 'o1', mistakeClientId: 'm1', subject: 'math', topic: '加法',
    stage: 1, dueAt: Date.now(), done: false,
  });
}

/** 走一次出题，返回 { attemptId, res } */
async function gen(fn, extra) {
  return fn.main(Object.assign({
    action: 'generate', features: 'attempt_v1', userInfo: { openId: 'o1' },
    subject: 'math', topic: '加法', errorType: 'E3',
  }, extra || {}));
}

(async () => {
  /* ============ 1. 出题：attempt 模式不泄题 ============ */
  group('generate · attempt 模式');

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1'); aiQuestions = AI_QUESTIONS;
    const fn = load();
    const r = await gen(fn);
    const qs = r.questions || [];
    ok(r.ok === true && !!r.attemptId, '返回 attemptId', JSON.stringify({ ok: r.ok, code: r.code }));
    ok(qs.length === 5, '5 道题', String(qs.length));
    ok(qs.every(q => !('answer' in q) && !('analysis' in q)), '题面不含 answer/analysis（不泄题）', JSON.stringify(qs[0]));
    ok(!!r.expiresAt && r.expiresAt > Date.now(), '带过期时间');

    const doc = rows(mockDb, 'tutor_retest_attempts')[0];
    ok(doc && Array.isArray(doc.questions) && doc.questions[0].answer === 'B', '答案只存服务端', JSON.stringify(doc && doc.questions && doc.questions[0]));
    ok(doc.openid === 'o1' && doc.childId === 'c2', 'attempt 挂在调用者与当前孩子名下', JSON.stringify({ o: doc.openid, c: doc.childId }));
    ok(doc.status === 'generated' && doc.evidenceProduced === false, '初始状态 generated / 未产证据');
    ok(doc.recommendationId === '' && doc.mistakeClientId === '', '未传溯源字段时留空，不编造');
  }

  {
    // 旧客户端（无 features）：仍回含答案的题面，走 judge 兼容路径
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const r = await fn.main({ action: 'generate', userInfo: { openId: 'o1' }, subject: 'math', topic: '加法' });
    ok(r.ok === true && !r.attemptId, '旧客户端不建 attempt', JSON.stringify({ ok: r.ok, attemptId: r.attemptId }));
    ok((r.questions || []).every(q => !!q.answer), '旧客户端仍拿到答案（行为不变）');
  }

  {
    // 题数不足 5：仍可出卷，但交卷必须判不达标
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    aiQuestions = AI_QUESTIONS.slice(0, 4);
    const fn = load();
    const r = await gen(fn);
    const s = await fn.main({
      action: 'submit', userInfo: { openId: 'o1' }, attemptId: r.attemptId,
      answers: ['B', 'C', 'B', 'B'], independence: 'self_declared_no_hint', evidenceClientId: 'ev4',
    });
    ok(s.ok === true && s.pass === false && /题数不足/.test(s.reason), '4 题即使全对也不达标', JSON.stringify({ pass: s.pass, reason: s.reason }));
    aiQuestions = AI_QUESTIONS;
  }

  /* ============ 2. 交卷：服务端判分 ============ */
  group('submit · 服务端判分');

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1'); seedReview(mockDb);
    const fn = load();
    const g = await gen(fn, { recommendationId: 'c1', mistakeId: 'm1' });
    const s = await fn.main({
      action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId,
      answers: RIGHT, independence: 'self_declared_no_hint',
      mistakeId: 'm1', evidenceClientId: 'ev1',
    });
    const ev = rows(mockDb, 'tutor_evidence');
    ok(s.ok === true && s.pass === true && s.correct === 5 && s.rate === 1, '5/5 → 达标', JSON.stringify({ c: s.correct, r: s.rate, p: s.pass }));
    ok(s.results.every(x => !!x.answer && !!x.analysis), '结果回传答案与解析（判分后才给）');
    ok(ev.length === 1, '证据恰好一条', String(ev.length));
    ok(ev[0] && ev[0].attemptId === g.attemptId && ev[0].clientId === 'ev1', '证据带 attemptId + clientId', JSON.stringify({ a: ev[0] && ev[0].attemptId, c: ev[0] && ev[0].clientId }));
    ok(ev[0] && ev[0].scoredBy === 'server' && ev[0].factGrade === 'server_recorded', '证据标 server_recorded');
    ok(ev[0] && ev[0].childId === 'c2' && ev[0].openid === 'o1', '证据挂在正确的人/孩子名下');
    ok(ev[0] && ev[0].recommendationId === 'c1', 'recommendationId 透传到证据（溯源）');
    ok(!!s.evidenceId, '回传 evidenceId 供本地对齐');
    ok(rows(mockDb, 'tutor_reviews')[0].done === true, '达标 → 复习窗口关闭');
    ok(rows(mockDb, 'tutor_mistakes')[0] === undefined, '无云端错题时静默跳过（不报错）');
  }

  {
    // 客户端伪造 questions(含 answer) 试图左右判分：attempt 路径根本不读它
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn);
    const s = await fn.main({
      action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId,
      answers: WRONG, independence: 'self_declared_no_hint', evidenceClientId: 'ev2',
      questions: AI_QUESTIONS.map(q => ({ q: q.q, options: q.options, answer: 'A', analysis: 'hack' })),
    });
    ok(s.ok === true && s.correct === 0 && s.pass === false, '回传的 questions.answer 不参与判分', JSON.stringify({ c: s.correct, p: s.pass }));
    ok(rows(mockDb, 'tutor_evidence')[0].correct === 0, '证据记录的是真实得分');
  }

  {
    // 半对：3/5 = 60% → 不达标
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn);
    const s = await fn.main({
      action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId,
      answers: ['B', 'C', 'B', 'A', 'A'], independence: 'self_declared_no_hint', evidenceClientId: 'ev3',
    });
    ok(s.pass === false && s.correct === 3 && /80%/.test(s.reason), '3/5 不达标', JSON.stringify({ c: s.correct, r: s.reason }));
  }

  /* ============ 3. 幂等 ============ */
  group('submit · 幂等');

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn);
    const p = { action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId, answers: RIGHT, independence: 'self_declared_no_hint', evidenceClientId: 'ev1' };
    const a = await fn.main(p);
    const b = await fn.main(p);
    const ev = rows(mockDb, 'tutor_evidence');
    ok(b.ok === true && b.replayed === true, '重复交卷返回回放标记', JSON.stringify({ replayed: b.replayed, code: b.code }));
    ok(b.correct === a.correct && b.pass === a.pass, '回放的判定与首次一致');
    ok(ev.length === 1, '证据没有翻倍', String(ev.length));
    ok(b.evidenceId === String(ev[0]._id), '回放带同一 evidenceId');
  }

  {
    // 二次交卷换答案也不改判（attempt 已经 submitted）
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn);
    await fn.main({ action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId, answers: RIGHT, independence: 'self_declared_no_hint', evidenceClientId: 'ev1' });
    const b = await fn.main({ action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId, answers: WRONG, independence: 'prompted' });
    ok(b.ok === true && b.correct === 5 && b.independence === 'self_declared_no_hint', '二次提交不能改写既有判定', JSON.stringify({ c: b.correct, i: b.independence }));
  }

  /* ============ 4. 过期 ============ */
  group('submit · 过期');

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn);
    const doc = rows(mockDb, 'tutor_retest_attempts')[0];
    doc.expiresAt = Date.now() - 1000;
    const s = await fn.main({ action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId, answers: RIGHT, independence: 'self_declared_no_hint', evidenceClientId: 'ev1' });
    ok(s.ok === false && s.code === 'attempt_expired', '过期 → attempt_expired', JSON.stringify({ code: s.code }));
    ok(rows(mockDb, 'tutor_retest_attempts')[0].status === 'expired', 'attempt 标记 expired');
    ok(rows(mockDb, 'tutor_evidence').length === 0, '过期不产证据');
  }

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const s = await fn.main({ action: 'submit', userInfo: { openId: 'o1' }, attemptId: 'nope', answers: RIGHT, independence: 'self_declared_no_hint' });
    ok(s.ok === false && s.code === 'no_attempt', '不存在的 attemptId → no_attempt', JSON.stringify({ code: s.code }));
  }

  /* ============ 5. 独立性门槛 ============ */
  group('submit · 独立性门槛');

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1'); seedReview(mockDb);
    const fn = load();
    const g = await gen(fn, { mistakeId: 'm1' });
    const s = await fn.main({
      action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId,
      answers: RIGHT, independence: 'prompted', mistakeId: 'm1', evidenceClientId: 'ev1',
    });
    ok(s.ok === true && s.pass === true, '有提示也能判达标（判定 ≠ 证据）', JSON.stringify({ p: s.pass }));
    ok(s.evidenceProduced === false && s.evidenceId === '', '有提示 → 不产证据', JSON.stringify({ e: s.evidenceProduced }));
    ok(/有提示/.test(s.reason || ''), '明确告知不计入证据', s.reason);
    ok(rows(mockDb, 'tutor_evidence').length === 0, 'tutor_evidence 一行未写');
    const doc = rows(mockDb, 'tutor_retest_attempts')[0];
    ok(doc.status === 'submitted' && doc.independence === 'prompted' && doc.evidenceProduced === false, 'attempt 留痕但标未产证据');
    ok(rows(mockDb, 'tutor_reviews')[0].done === false, '复习窗口不推进（活动 ≠ 证据）');
  }

  {
    // 未声明（unknown）同样不产证据
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn);
    const s = await fn.main({ action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId, answers: RIGHT });
    ok(s.independence === 'unknown' && s.evidenceProduced === false, '缺省 → unknown，不产证据', JSON.stringify({ i: s.independence }));
    ok(rows(mockDb, 'tutor_evidence').length === 0, '没有证据');
  }

  {
    // 未达标但独立完成：证据留档（passed=false），复习窗口推进到下一档
    mockDb = makeDb(); seedUser(mockDb, 'o1'); seedReview(mockDb);
    const fn = load();
    const g = await gen(fn, { mistakeId: 'm1' });
    const s = await fn.main({
      action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId,
      answers: WRONG, independence: 'self_declared_no_hint', mistakeId: 'm1', evidenceClientId: 'ev5',
    });
    const ev = rows(mockDb, 'tutor_evidence')[0];
    ok(s.evidenceProduced === true && ev && ev.passed === false, '未达标也留档（passed=false）', JSON.stringify(ev && { p: ev.passed }));
    const rv = rows(mockDb, 'tutor_reviews')[0];
    ok(rv.done === false && rv.stage === 2, '复习窗口进入第 2 档', JSON.stringify({ d: rv.done, s: rv.stage }));
  }

  /* ============ 6. 作用域 ============ */
  group('作用域');

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn);                       // 记在 c2（currentUserId）
    const s = await fn.main({
      action: 'submit', userInfo: { openId: 'o1' }, childId: 'c1', attemptId: g.attemptId,
      answers: RIGHT, independence: 'self_declared_no_hint', evidenceClientId: 'ev1',
    });
    ok(s.ok === false && s.code === 'child_mismatch', '换孩子交卷 → child_mismatch', JSON.stringify({ code: s.code }));
    ok(rows(mockDb, 'tutor_evidence').length === 0, '没有把证据挂到另一个孩子名下');
  }

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const r = await gen(fn, { childId: 'c9' });
    ok(r.ok === false && r.code === 'child_scope_invalid', '跨家庭 childId → 拒绝出题', JSON.stringify({ code: r.code }));
    ok(rows(mockDb, 'tutor_retest_attempts').length === 0, '没有留下 orphan attempt');
  }

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const before = aiCalls;
    const s = await fn.main({ action: 'submit', attemptId: 'x', answers: RIGHT });
    ok(s.ok === false && s.code === 'no_openid', '空 openid → no_openid', JSON.stringify({ code: s.code }));
    ok(aiCalls === before, '被拒的请求没有调 AI');
  }

  {
    // 别人的 attempt 拿不到
    mockDb = makeDb(); seedUser(mockDb, 'o1'); seedUser(mockDb, 'o2');
    const fn = load();
    const g = await gen(fn);
    const docs = rows(mockDb, 'tutor_retest_attempts');
    const s = await fn.main({ action: 'submit', userInfo: { openId: 'o2' }, attemptId: docs[0].attemptId, answers: RIGHT, independence: 'self_declared_no_hint' });
    ok(s.ok === false && s.code === 'no_attempt', '他人 attempt → no_attempt（openid 隔离）', JSON.stringify({ code: s.code }));
  }

  /* ============ 7. 兼容路径 judge ============ */
  group('judge · 兼容路径');

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const r = await fn.main({
      action: 'judge', userInfo: { openId: 'o1' }, subject: 'math', topic: '加法',
      questions: AI_QUESTIONS, answers: RIGHT, evidenceClientId: 'evL',
    });
    const ev = rows(mockDb, 'tutor_evidence')[0];
    ok(r.ok === true && r.pass === true, '旧路径仍可用', JSON.stringify({ ok: r.ok, pass: r.pass }));
    ok(ev.scoredBy === 'client' && ev.factGrade === 'client_claimed', '证据标 client_claimed（不可与 attempt 混同）', JSON.stringify({ s: ev.scoredBy, f: ev.factGrade }));
    ok(ev.attemptId === '' && ev.independence === 'unknown', '无 attempt 溯源字段时留空/unknown');
  }


  /* ============ 8. 变式复测（L5/L6 记录源） ============ */
  group('变式复测 · kind/context');

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn, { kind: 'variant', context: '生活情境', unitId: 'u1', kpId: 'p1' });
    const doc = rows(mockDb, 'tutor_retest_attempts')[0];
    ok(g.ok === true && doc.kind === 'variant' && doc.context === '生活情境', '变式标签钉在建 attempt 时', JSON.stringify({ k: doc.kind, c: doc.context }));
    ok(doc.unitId === 'u1' && doc.kpId === 'p1', '知识点归属随 attempt 落库（证据能精确归点）');
    ok((aiMessages[0] && aiMessages[0].content || '').indexOf('变式出题') >= 0, '走变式出题 prompt，不是普通复测 prompt', JSON.stringify(aiMessages[0] && aiMessages[0].content.slice(0, 12)));
    ok((aiMessages[1] && aiMessages[1].content || '').indexOf('生活情境') >= 0, '情境进 prompt');
    const s = await fn.main({
      action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId,
      answers: RIGHT, independence: 'self_declared_no_hint', evidenceClientId: 'evV',
    });
    ok(s.evidenceKind === 'variant' && s.context === '生活情境', '交卷回传标签（端上存的是服务端那份）', JSON.stringify({ k: s.evidenceKind, c: s.context }));
    const ev = rows(mockDb, 'tutor_evidence')[0];
    ok(ev.evidenceKind === 'variant' && ev.context === '生活情境' && ev.unitId === 'u1' && ev.kpId === 'p1',
      '变式标签随证据落库', JSON.stringify(ev && { k: ev.evidenceKind, c: ev.context, u: ev.unitId }));
    ok(ev.passed === true && ev.factGrade === 'server_recorded', '门槛没变：仍要服务端判 + 独立完成', JSON.stringify({ p: ev.passed, f: ev.factGrade }));
  }

  {
    // 情境白名单：表外文本一律记空 —— 否则「不同情境」能随口凑，L6 失去意义
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    await gen(fn, { kind: 'variant', context: '我在海边做的' });
    const doc = rows(mockDb, 'tutor_retest_attempts')[0];
    ok(doc.kind === 'variant' && doc.context === '', '白名单外情境 → 记空', JSON.stringify({ k: doc.kind, c: doc.context }));
  }

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    await gen(fn, { kind: 'mastered', context: '换数字' });
    ok(rows(mockDb, 'tutor_retest_attempts')[0].kind === 'retest', '非法 kind → 退回普通复测');
  }

  {
    // 交卷阶段塞标签无效：只认建 attempt 时存下的值
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn);
    const s = await fn.main({
      action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId, answers: RIGHT,
      independence: 'self_declared_no_hint', evidenceClientId: 'evX', kind: 'variant', context: '生活情境',
    });
    ok(s.evidenceKind === 'retest', '交卷时补标 variant 无效', JSON.stringify({ k: s.evidenceKind }));
    ok(rows(mockDb, 'tutor_evidence')[0].evidenceKind === 'retest', '证据仍是普通复测（不能事后升档）');
  }

  {
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn, { kind: 'variant', context: '换问法' });
    const s = await fn.main({
      action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId,
      answers: RIGHT, independence: 'prompted', evidenceClientId: 'evP',
    });
    ok(s.evidenceProduced === false && rows(mockDb, 'tutor_evidence').length === 0, '变式也要独立完成才留证据');
  }

  {
    // 旧客户端（无 attempt 契约）：不给变式标签，免得 judge 路径产「无人证明」的迁移记录
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const r = await fn.main({ action: 'generate', userInfo: { openId: 'o1' }, subject: 'math', topic: '加法', kind: 'variant', context: '换数字' });
    ok(r.ok === true && !r.attemptId, '旧客户端不建 attempt');
    ok(rows(mockDb, 'tutor_retest_attempts').length === 0, '旧客户端没有变式 attempt');
    const j = await fn.main({ action: 'judge', userInfo: { openId: 'o1' }, subject: 'math', topic: '加法', questions: AI_QUESTIONS, answers: RIGHT, evidenceClientId: 'evJ' });
    ok(j.ok === true && rows(mockDb, 'tutor_evidence')[0].evidenceKind === 'retest', '兼容路径证据钉死普通复测', JSON.stringify(rows(mockDb, 'tutor_evidence')[0]));
    ok(rows(mockDb, 'tutor_evidence')[0].context === '', '兼容路径不写情境');
  }

  {
    // 重放保留标签（换设备/二次进页不会把变式降级成普通复测）
    mockDb = makeDb(); seedUser(mockDb, 'o1');
    const fn = load();
    const g = await gen(fn, { kind: 'variant', context: '图形与表格' });
    await fn.main({ action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId, answers: RIGHT, independence: 'self_declared_no_hint', evidenceClientId: 'evR' });
    const again = await fn.main({ action: 'submit', userInfo: { openId: 'o1' }, attemptId: g.attemptId, answers: WRONG, independence: 'prompted' });
    ok(again.replayed === true && again.evidenceKind === 'variant' && again.context === '图形与表格', '重放保留变式标签', JSON.stringify({ k: again.evidenceKind, c: again.context }));
    ok(rows(mockDb, 'tutor_evidence').length === 1, '重放不翻倍');
  }

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n挂具异常:', e); process.exit(2); });

/**
 * test-scope-writes.cjs —— 写入口作用域收口回归测试（P0）
 * ---------------------------------------------------------------------------
 * 用内存 DB 驱动**真实的云函数源码**（不部署、不连云端），锁住四条硬约束：
 *   1. 空 openid → no_openid，一行都不写；
 *   2. 客户端伪造的 openid/_openid 被剥离，身份只由服务端注入；
 *   3. childId 由服务端解析：跨家庭 → 拒绝；未指定 → currentUserId；**不回落 users[0]**；
 *   4. 证据单写者：tutorSync / webAdminWrite 的 evidence 通道一律 rejected，
 *      tutorRetest 是唯一能写 tutor_evidence 的入口。
 *
 *     node scripts/test-scope-writes.cjs
 *
 * 反证：把任一写入口的 G.requireOpenid / G.stripIdentity / G.resolveChildId 调用删掉，
 * 对应分组必须变红。
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

  /* wx-server-sdk 的 add/update 收 { data: X } 包壳；@cloudbase/node-sdk 收裸对象。
   * 真实 SDK 对两种写法行为不同，但 mock 需要同时服务两者 —— 单键 {data:X} 一律解包
   * （与本项目 scripts/mock-tcb.js 的 unwrap 保持同一口径）。 */
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
        const d = Object.assign({ _id: 'id_' + (coll(name).length + 1) + '_' + Math.random().toString(36).slice(2, 7) }, clone(unwrap(obj)));
        coll(name).push(d);
        return Promise.resolve({ id: d._id });
      },
      doc: (id) => ({
        get: () => {
          const d = coll(id === undefined ? name : name).find(x => x._id === id);
          return Promise.resolve({ data: d ? clone(d) : null });
        },
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

/* --------------------- SDK 拦截 --------------------- */
let mockDb = null;
let wxOpenid = '';
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@cloudbase/node-sdk') {
    return { init: () => ({ database: () => mockDb, ai: () => { throw new Error('no ai in test'); } }) };
  }
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test-env',
      init: () => {},
      getWXContext: () => ({ OPENID: wxOpenid }),
      database: () => mockDb,
    };
  }
  return origLoad.apply(this, arguments);
};

const paths = {
  tutorSync: path.join(ROOT, 'cloudfunctions/tutorSync/index.js'),
  webAdminWrite: path.join(ROOT, 'cloudfunctions/webAdminWrite/index.js'),
  tutorRetest: path.join(ROOT, 'cloudfunctions/tutorRetest/index.js'),
  tutorChat: path.join(ROOT, 'cloudfunctions/tutorChat/index.js'),
  syncData: path.join(ROOT, 'cloudfunctions/syncData/index.js'),
};

function load(name) {
  for (const p of Object.values(paths)) delete require.cache[p];
  return require(paths[name]);
}

/* ------------------------------ 断言 ------------------------------ */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(n) { console.log('\n' + n); }

/* 家庭根数据：两个孩子，当前是 c2 */
const ROOT_DATA = {
  currentUserId: 'c2',
  users: [
    { id: 'c1', name: '大宝', homework: {} },
    { id: 'c2', name: '二宝', homework: {} },
  ],
};
function seedUser(db, openid, data) {
  db.collection('hw_farm_user').add({ _openid: openid, data: data || ROOT_DATA, updatedAt: 1 });
}
function rows(db, name) { return db._colls.get(name) || []; }

(async () => {
  /* ======================= tutorSync ======================= */
  group('tutorSync');

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorSync');
    const r = await fn.main({ action: 'push', sessions: [{ clientId: 's1', messages: [] }] });
    ok(r.ok === false && r.code === 'no_openid', '空 openid → no_openid', JSON.stringify(r));
    ok(rows(mockDb, 'tutor_sessions').length === 0, '没有写入任何会话');
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorSync');
    const r = await fn.main({
      action: 'push', userInfo: { openId: 'o1' },
      sessions: [{ clientId: 's1', openid: 'oHACK', _openid: 'oHACK', messages: [] }],
    });
    const d = rows(mockDb, 'tutor_sessions')[0];
    ok(r.ok && r.added === 1, '会话正常补写', JSON.stringify(r));
    ok(d && d.openid === 'o1' && !('_openid' in d), '伪造的 openid/_openid 被剥离', JSON.stringify(d));
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorSync');
    const r = await fn.main({
      action: 'push', userInfo: { openId: 'o1' },
      evidence: [{ clientId: 'ev1', subject: 'math', topic: 'x', total: 5, correct: 5, passed: true }],
    });
    ok(r.ok === true && r.rejected === 1, 'evidence 推送被拒（计入 rejected）', JSON.stringify(r));
    ok(rows(mockDb, 'tutor_evidence').length === 0, 'tutor_evidence 一行未写');
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorSync');
    await fn.main({ action: 'push', userInfo: { openId: 'o1' }, sessions: [{ clientId: 's1', messages: [] }] });
    ok(rows(mockDb, 'tutor_sessions')[0].childId === 'c2', '未指定 childId → currentUserId');
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorSync');
    const r = await fn.main({
      action: 'push', userInfo: { openId: 'o1' }, childId: 'c1',
      sessions: [{ clientId: 's1', childId: 'c1', messages: [] }, { clientId: 's2', childId: 'c9', messages: [] }],
    });
    const s = rows(mockDb, 'tutor_sessions');
    ok(r.ok === true && s.length === 2, '合法 childId 整批写入', JSON.stringify(r));
    ok(s.every(d => d.childId === 'c1'), '条目里的 childId 一律被服务端结果覆盖', JSON.stringify(s.map(d => d.childId)));
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorSync');
    const r = await fn.main({ action: 'push', userInfo: { openId: 'o1' }, childId: 'c9', sessions: [{ clientId: 's1', messages: [] }] });
    ok(r.ok === false && r.code === 'child_scope_invalid', '跨家庭 childId → 整单拒绝', JSON.stringify(r));
    ok(rows(mockDb, 'tutor_sessions').length === 0, '跨家庭请求没有落任何数据');
  }

  {
    mockDb = makeDb();   // 没有 hw_farm_user 档案
    const fn = load('tutorSync');
    await fn.main({ action: 'push', userInfo: { openId: 'o1' }, sessions: [{ clientId: 's1', messages: [] }] });
    ok(rows(mockDb, 'tutor_sessions')[0].childId === '', '无档案 → childId 留空（待迁移），不猜');
  }

  /* ======================= webAdminWrite ======================= */
  group('webAdminWrite');

  function seedBinding(db, token, openid) {
    db.collection('web_portal_bindings').add({ token, openid, revoked: false });
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    seedBinding(mockDb, 'tk1', 'o1');
    const fn = load('webAdminWrite');
    const r = await fn.main({
      token: 'tk1',
      sessions: [{ clientId: 's1', openid: 'oHACK', messages: [] }],
      evidence: [{ clientId: 'ev1', subject: 'math', passed: true }],
    });
    const s = rows(mockDb, 'tutor_sessions')[0];
    ok(r.ok === true && r.added === 1, '会话写入成功', JSON.stringify(r));
    ok(s.openid === 'o1' && s.childId === 'c2', '身份与 childId 均由服务端注入', JSON.stringify(s));
    ok(r.rejected === 1, 'evidence 计入 rejected', JSON.stringify(r));
    ok(rows(mockDb, 'tutor_evidence').length === 0, 'tutor_evidence 一行未写');
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    seedBinding(mockDb, 'tk1', 'o1');
    const fn = load('webAdminWrite');
    const r = await fn.main({ token: 'tk1', childId: 'c1', mistakes: [{ clientId: 'm1', topic: 't', childId: 'c2' }] });
    const m = rows(mockDb, 'tutor_mistakes')[0];
    ok(r.ok === true && m && m.childId === 'c1', '显式合法 childId 生效（覆盖条目里的旧值）', JSON.stringify(m));
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    seedBinding(mockDb, 'tk1', 'o1');
    const fn = load('webAdminWrite');
    const r = await fn.main({ token: 'tk1', childId: 'c9', sessions: [{ clientId: 's1', messages: [] }] });
    ok(r.ok === false && r.code === 'child_scope_invalid', '跨家庭 childId → 拒绝写入', JSON.stringify(r));
    ok(rows(mockDb, 'tutor_sessions').length === 0, '没有落任何数据');
  }

  {
    mockDb = makeDb();
    const fn = load('webAdminWrite');
    const r = await fn.main({ token: 'nope', sessions: [{ clientId: 's1' }] });
    ok(r.ok === false && r.code === 'auth', '无效 token → auth', JSON.stringify(r));
  }

  /* ======================= tutorRetest（唯一证据写入口） ======================= */
  group('tutorRetest');

  const QUESTIONS = [
    { q: '1+1', options: ['1', '2', '3', '4'], answer: 'B' },
    { q: '2+2', options: ['2', '3', '4', '5'], answer: 'C' },
    { q: '3+3', options: ['5', '6', '7', '8'], answer: 'B' },
    { q: '4+4', options: ['7', '8', '9', '10'], answer: 'B' },
    { q: '5+5', options: ['9', '10', '11', '12'], answer: 'B' },
  ];
  const ANSWERS = ['B', 'C', 'B', 'B', 'B'];

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorRetest');
    const r = await fn.main({
      action: 'judge', subject: 'math', topic: '加法', questions: QUESTIONS, answers: ANSWERS,
      evidenceClientId: 'ev1',
    });
    ok(r.ok === false && r.code === 'no_openid', '空 openid → no_openid', JSON.stringify(r));
    ok(rows(mockDb, 'tutor_evidence').length === 0, '没有写入证据');
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorRetest');
    const r = await fn.main({
      action: 'judge', userInfo: { openId: 'o1' }, subject: 'math', topic: '加法',
      questions: QUESTIONS, answers: ANSWERS, evidenceClientId: 'ev1',
    });
    const e = rows(mockDb, 'tutor_evidence')[0];
    ok(r.ok === true && r.pass === true, '5/5 达标', JSON.stringify({ ok: r.ok, pass: r.pass }));
    ok(e && e.childId === 'c2' && e.openid === 'o1', '证据带服务端解析的 childId', JSON.stringify(e));
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorRetest');
    const r = await fn.main({
      action: 'judge', userInfo: { openId: 'o1' }, subject: 'math', topic: '加法', childId: 'c9',
      questions: QUESTIONS, answers: ANSWERS, evidenceClientId: 'ev1',
    });
    ok(r.ok === false && r.code === 'child_scope_invalid', '跨家庭 childId → 拒绝', JSON.stringify(r));
    ok(rows(mockDb, 'tutor_evidence').length === 0, '没有写入证据');
  }

  /* ======================= tutorChat（归档） ======================= */
  group('tutorChat');

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorChat');
    const r = await fn.main({ action: 'archive', messages: [{ role: 'user', content: '这道题怎么做' }], sessionClientId: 's1' });
    ok(r.ok === false && r.code === 'no_openid', '空 openid → no_openid（归档不写）', JSON.stringify(r));
    ok(rows(mockDb, 'tutor_sessions').length === 0, '没有写入会话');
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorChat');
    const r = await fn.main({
      action: 'archive', userInfo: { openId: 'o1' }, subject: 'math', sessionClientId: 's1',
      messages: [{ role: 'user', content: '这道题怎么做' }],
    });
    const s = rows(mockDb, 'tutor_sessions')[0];
    ok(r.ok === true && s && s.childId === 'c2', '归档带服务端解析的 childId', JSON.stringify({ ok: r.ok, childId: s && s.childId }));
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('tutorChat');
    const r = await fn.main({
      action: 'archive', userInfo: { openId: 'o1' }, childId: 'c9', sessionClientId: 's1',
      messages: [{ role: 'user', content: 'x' }],
    });
    ok(r.ok === false && r.code === 'child_scope_invalid', '跨家庭 childId → 拒绝归档', JSON.stringify(r));
    ok(rows(mockDb, 'tutor_sessions').length === 0, '没有写入会话');
  }

  /* ======================= syncData ======================= */
  group('syncData');

  const today = (() => {
    const d = new Date();
    const p = n => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  })();
  const payload = (currentUserId) => ({
    currentUserId,
    users: [
      { id: 'c1', homework: {} },
      { id: 'c2', homework: {} },
    ],
  });

  {
    mockDb = makeDb();
    const fn = load('syncData');
    wxOpenid = '';
    const r = await fn.main({ action: 'upload', payload: payload('c2') });
    ok(r.ok === false && r.code === 'no_openid', '空 OPENID → no_openid', JSON.stringify(r));
    ok(rows(mockDb, 'hw_farm_user').length === 0, '没有建档');
  }

  {
    mockDb = makeDb();
    const fn = load('syncData');
    wxOpenid = 'o1';
    const pl = payload('c2');
    pl.users[1].homework[today] = { math: { done: true } };
    const r = await fn.main({ action: 'upload', payload: pl, base: 0 });
    const log = rows(mockDb, 'hw_checkin_log')[0];
    ok(r.ok === true && log && log.childId === 'c2', '打卡明细带当前孩子 childId', JSON.stringify(log));
  }

  {
    mockDb = makeDb();
    const fn = load('syncData');
    wxOpenid = 'o1';
    const pl = payload('cX');            // currentUserId 失效
    pl.users[1].homework[today] = { math: { done: true } };
    const r = await fn.main({ action: 'upload', payload: pl, base: 0 });
    ok(r.ok === true, '上传本身成功（镜像仍落库）', JSON.stringify(r));
    const lg = rows(mockDb, 'hw_checkin_log');
    ok(lg.length === 1 && lg[0].childId === 'c2',
      'currentUserId 失效时按「记录所属孩子」落行，不猜当前孩子', JSON.stringify(lg));
    ok(!lg.some(x => x.childId === 'c1'),
      '反证：c2 的记录不会回落到 users[0]（c1）名下', JSON.stringify(lg.map(x => x.childId)));
  }

  {
    mockDb = makeDb();
    seedUser(mockDb, 'o1');
    const fn = load('syncData');
    wxOpenid = 'o1';
    const r1 = await fn.main({ action: 'logEvent', payload: { event: 'tap', childId: 'c9' } });
    ok(r1.ok === true && r1.skipped === true, '跨家庭 childId 的埋点被丢弃', JSON.stringify(r1));
    ok(rows(mockDb, 'hw_farm_events').length === 0, '没有写入埋点');
    const r2 = await fn.main({ action: 'logEvent', payload: { event: 'tap' } });
    const ev = rows(mockDb, 'hw_farm_events')[0];
    ok(r2.ok === true && ev && ev.childId === 'c2', '未指定 → 当前孩子', JSON.stringify(ev));
  }

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n挂具异常:', e); process.exit(2); });

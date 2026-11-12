/**
 * test-webadminquery-childscope.cjs —— webAdminQuery 孩子归属口径（P0-A）回归测试
 * ==========================================================================================
 * 用假的 @cloudbase/node-sdk 驱动**真实云函数源码**，不部署、不连云：
 *     node scripts/test-webadminquery-childscope.cjs
 *     COUNTERPROOF=1 node scripts/test-webadminquery-childscope.cjs
 *
 * 被测口径（2026-10-28 定，改代码前先定规则）：
 *   1. 有 childId 就归孩子，一分不差；
 *   2. 没有 childId 就标 legacy，**绝不并入任何孩子**（不猜 currentUserId、不猜 users[0]）；
 *   3. 同一天同一账号已有孩子级行时，旧行＝被取代的重复行：从列表剔除，但计入 replaced；
 *      没有孩子级行的日子，旧行仍是一天的真实快照 → 留在列表并标 legacy:true（unattributed）。
 *   4. 展示用的「当前孩子」= currentUserId；失效时回落第一个真实孩子，但必须标 childSource='first'。
 *
 * 覆盖：
 *   · farm：users 逐孩子（无占位切片）/ logs·settle 同日去重 / events 只标不删 / per-user 隔离；
 *   · overview：children 全量、byChild 逐孩子计数且**不把 legacy 摊给孩子**（sum 不变）；
 *   · profile：childId / childSource / children[]，占位切片不算孩子；
 *   · tutor / sync：childId 透传，老行不编一个空 childId；
 *   · 反证（COUNTERPROOF=1，进程内生成两个变异体）：
 *       ① 当前孩子回落 users[0] 且谎报 source='current' → 必须红；
 *       ② 历史行不做同日去重（pass-through）→ 必须红。
 */
const path = require('path');
const Module = require('module');

const FN = process.env.WAQ_PATH
  || path.resolve(__dirname, '../cloudfunctions/webAdminQuery/index.js');

/* ------------------------------ 假 @cloudbase/node-sdk ------------------------------ */
const ADMIN = 'ADMIN-TOKEN-cs';
const T_OA = 'TOKEN-OA';
const T_OB = 'TOKEN-OB';
const T_OC = 'TOKEN-OC';

const NOW = Date.now();
const PAST = NOW - 3600 * 1000;
const FUT = NOW + 24 * 3600 * 1000;

/* 家庭 A：两个孩子 + 内存占位切片；currentUserId 指向 a2 */
const USERS = [
  { _id: 'uA', _openid: 'oA', updatedAt: 3000, data: {
    currentUserId: 'a2',
    coop: { plants: [{ name: '豆苗', progress: 1, goal: 3, contributors: { a1: 1 } }] },
    users: [
      { id: 'a1', nickname: '小A', grade: '三年级',
        farm: { coins: 100, bears: [{}, {}], plots: [{}, {}], shields: 1, harvestLog: [{}, {}] },
        homework: { '2026-10-27': { chinese: { done: true }, math: { done: false } } },
        profile: { streak: 2 }, plans: { '2026-10-27': [{ name: '口算' }] },
        studyPlans: { math: { stages: [{ tasks: [{ name: 'T1' }] }] } } },
      { id: 'a2', nickname: '小A2', grade: '一年级',
        farm: { coins: 50, bears: [], plots: [{}], shields: 0 },
        homework: {}, plans: {}, studyPlans: null },
      { id: 'guest', __placeholder: true, nickname: '未建档', farm: { coins: 999 } }
    ]
  } },
  /* 家庭 B：currentUserId 指向不存在的孩子，users[0] 是占位切片
     —— 旧实现（users[0] 回落）会把这个账号显示成「未建档」 */
  { _id: 'uB', _openid: 'oB', updatedAt: 2000, data: {
    currentUserId: 'ghost',
    users: [
      { id: 'guest', __placeholder: true, nickname: '未建档', farm: { coins: 999 } },
      { id: 'b1', nickname: '小B', grade: '二年级', farm: { coins: 7, bears: [] }, homework: {} }
    ]
  } },
  /* 家庭 C：只有占位切片 → 一个真实孩子都没有 */
  { _id: 'uC', _openid: 'oC', updatedAt: 1000, data: {
    currentUserId: 'guest',
    users: [{ id: 'guest', __placeholder: true, nickname: '游客', farm: { coins: 5 } }]
  } }
];

/* 打卡明细：l3 是被 l1/l2 取代的 10-27 旧行；l4 是 10-26 的唯一快照；
   l6/l7/l8 验证「分组键含 openid」：oB 的 10-24 旧行只被 oB 的孩子级行取代，
   不会被 oA 同日的孩子级行误判 */
const LOGS = [
  { _id: 'l1', _openid: 'oA', childId: 'a1', date: '2026-10-27', chinese: true, math: false, english: false, createdAt: 900 },
  { _id: 'l2', _openid: 'oA', childId: 'a2', date: '2026-10-27', chinese: false, math: false, english: false, createdAt: 890 },
  { _id: 'l3', _openid: 'oA', date: '2026-10-27', chinese: true, math: false, english: false, createdAt: 880 },
  { _id: 'l4', _openid: 'oA', date: '2026-10-26', chinese: true, math: true, english: false, createdAt: 700 },
  { _id: 'l5', _openid: 'oA', childId: 'a1', date: '2026-10-25', chinese: true, math: true, english: true, createdAt: 600 },
  { _id: 'l6', _openid: 'oB', date: '2026-10-26', chinese: false, math: true, english: false, createdAt: 650 },
  { _id: 'l7', _openid: 'oB', date: '2026-10-24', chinese: true, math: false, english: false, createdAt: 500 },
  { _id: 'l8', _openid: 'oB', childId: 'b1', date: '2026-10-24', chinese: true, math: true, english: false, createdAt: 510 }
];

const SETTLE = [
  { _id: 'st1', _openid: 'oA', childId: 'a1', date: '2026-10-26', level: 2, missing: ['math', 'english'], bears: 2, stolen: 30, withered: 1, createdAt: 700 },
  { _id: 'st2', _openid: 'oA', date: '2026-10-26', level: 1, missing: ['english'], bears: 1, stolen: 10, withered: 0, createdAt: 690 },
  { _id: 'st3', _openid: 'oA', date: '2026-10-23', level: 3, missing: ['math', 'english', 'chinese'], bears: 3, stolen: 60, withered: 2, createdAt: 400 }
];

const EVENTS = [
  { _id: 'ev1', _openid: 'oA', childId: 'a1', event: 'checkin_done', subjectName: '语文', date: '2026-10-27', createdAt: 900 },
  { _id: 'ev2', _openid: 'oA', event: 'checkin_done', subjectName: '数学', date: '2026-10-26', createdAt: 700 }
];

/* 导学数据：每个集合都含「有 childId」「无 childId」两种行 */
const SESSIONS = [
  { _id: 's1', openid: 'oA', childId: 'a1', clientId: 's1', subject: 'math', subjectName: '数学', createdAt: 100 },
  { _id: 's2', openid: 'oA', childId: 'a2', clientId: 's2', subject: 'chinese', subjectName: '语文', createdAt: 90 },
  { _id: 's3', openid: 'oA', clientId: 's3', subject: 'english', subjectName: '英语', createdAt: 80 },
  { _id: 's4', openid: 'oB', childId: 'b1', clientId: 's4', subject: 'math', subjectName: '数学', createdAt: 70 }
];
const MISTAKES = [
  { _id: 'm1', openid: 'oA', childId: 'a1', clientId: 'm1', subject: 'math', status: 'corrected', errorType: 'E1', createdAt: 100 },
  { _id: 'm2', openid: 'oA', clientId: 'm2', subject: 'english', status: 'open', errorType: 'E2', createdAt: 90 },
  { _id: 'm3', openid: 'oB', childId: 'b1', clientId: 'm3', subject: 'math', status: 'open', errorType: 'E1', createdAt: 80 }
];
const EVIDENCE = [
  { _id: 'e1', openid: 'oA', childId: 'a1', clientId: 'e1', subject: 'math', passed: true, createdAt: 100 },
  { _id: 'e2', openid: 'oA', clientId: 'e2', subject: 'english', passed: true, createdAt: 90 },
  { _id: 'e3', openid: 'oB', childId: 'b1', clientId: 'e3', subject: 'math', passed: true, createdAt: 80 }
];
const REVIEWS = [
  { _id: 'r1', openid: 'oA', childId: 'a1', clientId: 'r1', subject: 'math', done: false, dueAt: PAST, createdAt: 100 },
  { _id: 'r2', openid: 'oA', clientId: 'r2', subject: 'english', done: false, dueAt: PAST, createdAt: 90 },
  { _id: 'r3', openid: 'oB', childId: 'b1', clientId: 'r3', subject: 'math', done: false, dueAt: FUT, createdAt: 80 }
];
const CARDS = [
  { _id: 'c1', openid: 'oA', childId: 'a1', clientId: 'c1', subject: 'math', front: 'Q', back: 'A', box: 1, done: false, dueAt: PAST, createdAt: 100 },
  { _id: 'c2', openid: 'oA', clientId: 'c2', subject: 'english', front: 'Q2', back: 'A2', box: 0, done: false, dueAt: PAST, createdAt: 90 }
];
const BINDINGS = [
  { _id: 'bdOA', token: T_OA, openid: 'oA', revoked: false },
  { _id: 'bdOB', token: T_OB, openid: 'oB', revoked: false },
  { _id: 'bdOC', token: T_OC, openid: 'oC', revoked: false }
];

function matchWhere(row, where) {
  const w = where || {};
  return Object.keys(w).every(k => row[k] === w[k]);
}
function makeCollection(rows) {
  let _w = {}, _order = null, _skip = 0, _limit = 100;
  const api = {
    where(w) { _w = w || {}; return api; },
    orderBy(k, d) { _order = { k, d }; return api; },
    skip(n) { _skip = n; return api; },
    limit(n) { _limit = n; return api; },
    async count() { return { total: rows.filter(r => matchWhere(r, _w)).length }; },
    async get() {
      let r = rows.filter(x => matchWhere(x, _w));
      if (_order) {
        r = r.slice().sort((a, b) => _order.d === 'desc'
          ? (b[_order.k] || 0) - (a[_order.k] || 0)
          : (a[_order.k] || 0) - (b[_order.k] || 0));
      }
      return { data: r.slice(_skip, _skip + _limit) };
    },
    doc() { return { async update() { return { updated: 1 }; } }; }
  };
  return api;
}
const TABLES = {
  hw_farm_user: USERS,
  hw_checkin_log: LOGS,
  hw_farm_settle: SETTLE,
  hw_farm_events: EVENTS,
  tutor_sessions: SESSIONS,
  tutor_mistakes: MISTAKES,
  tutor_reviews: REVIEWS,
  tutor_evidence: EVIDENCE,
  tutor_cards: CARDS,
  tutor_unit_kps: [],
  exam_resources: [],
  tutor_orders: [],
  web_portal_bindings: BINDINGS
};
const fakeDb = { collection(name) { return makeCollection(TABLES[name] ? TABLES[name].slice() : []); } };
const fakeSdk = { init() { return { database() { return fakeDb; } }; } };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === '@cloudbase/node-sdk') return fakeSdk;
  return origLoad.apply(this, arguments);
};

process.env.WEB_DASHBOARD_TOKEN = ADMIN;
const waq = require(FN);

/* ------------------------------ 断言器 ------------------------------ */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const call = (data) => waq.main(data);
const ids = (rows, k) => rows.map(r => r[k]);

(async () => {
  /* ================================================================== farm */
  console.log('\n—— farm · 逐孩子清单（占位切片不算孩子）——');
  const F = await call({ token: ADMIN, module: 'farm' });
  ok('ok=true', F && F.ok === true, F);
  const fu = (F.data && F.data.users) || [];
  ok('userSum = 3 个真实孩子（a1/a2/b1）', fu.length === 3, ids(fu, 'childId'));
  ok('没有任何占位切片行', !fu.some(u => u.childId === 'guest' || u.nickname === '未建档'), ids(fu, 'nickname'));
  ok('每行都带 childId', fu.every(u => typeof u.childId === 'string' && u.childId), ids(fu, 'childId'));
  ok('a1 农场资产正确（100 金币 / 2 熊 / 2 地块）',
    (fu.find(u => u.childId === 'a1') || {}).coins === 100 &&
    (fu.find(u => u.childId === 'a1') || {}).bears === 2 &&
    (fu.find(u => u.childId === 'a1') || {}).plots === 2, fu.find(u => u.childId === 'a1'));
  ok('currentUserId=a2 → a2 标 isCurrent，a1 不标',
    (fu.find(u => u.childId === 'a2') || {}).isCurrent === true &&
    (fu.find(u => u.childId === 'a1') || {}).isCurrent === false, fu.map(u => [u.childId, u.isCurrent]));
  ok('oB 的 currentUserId 失效 → 仍认出 b1（且标 isCurrent=first 语义）',
    !!(fu.find(u => u.childId === 'b1')) && fu.find(u => u.childId === 'b1').isCurrent === true, fu.map(u => u.childId));

  console.log('\n—— farm · 同日旧行：剔除但计数，不摊给孩子 ——');
  const sc = (F.data && F.data.childScope) || {};
  const logs = (F.data && F.data.logs) || [];
  const settle = (F.data && F.data.settle) || [];
  const events = (F.data && F.data.events) || [];
  ok('logs 保留 6 条（l3/l7 被取代剔除）', logs.length === 6, logs.map(r => r._id));
  ok('logs.replaced=2（oA 10-27 旧行 + oB 10-24 旧行）',
    sc.replaced && sc.replaced.logs === 2, sc);
  ok('logs.unattributed=2（oA 10-26 + oB 10-26 各一条无主快照）',
    sc.unattributed && sc.unattributed.logs === 2, sc);
  ok('被取代的 l3 / l7 已不在列表里',
    !logs.some(r => r._id === 'l3' || r._id === 'l7'), logs.map(r => r._id));
  ok('保留的旧行都标 legacy:true',
    logs.filter(r => !r.childId).every(r => r.legacy === true), logs.filter(r => !r.childId));
  ok('旧行没有被编造一个 childId（不许并入 a1/a2）',
    !logs.some(r => r._id === 'l4' && r.childId), logs.find(r => r._id === 'l4'));
  ok('分组键含 openid：oA 同日的孩子级行不会取代 oB 的旧行',
    !!logs.find(r => r._id === 'l6'), logs.map(r => r._id));
  ok('孩子级行原样保留（l1 a1 / l2 a2 / l5 a1 / l8 b1）',
    ['l1', 'l2', 'l5', 'l8'].every(id => {
      const row = logs.find(r => r._id === id);
      return row && row.childId && row.legacy === undefined;
    }), logs.map(r => [r._id, r.childId]));
  ok('settle 保留 2 条 / replaced=1 / unattributed=1',
    settle.length === 2 && sc.replaced.settle === 1 && sc.unattributed.settle === 1,
    { n: settle.length, sc });
  ok('settle 旧行 st3 标 legacy 且无 childId',
    (settle.find(r => r._id === 'st3') || {}).legacy === true &&
    !(settle.find(r => r._id === 'st3') || {}).childId, settle);
  ok('events 不做同日去重：2 条都在，replaced=0，unattributed=1',
    events.length === 2 && sc.replaced.events === 0 && sc.unattributed.events === 1,
    { n: events.length, sc });
  ok('events 旧行 ev2 标 legacy:true', (events.find(r => r._id === 'ev2') || {}).legacy === true, events);

  console.log('\n—— farm · per-user 隔离 ——');
  const FB = await call({ token: T_OB, module: 'farm' });
  const fbu = (FB.data && FB.data.users) || [];
  ok('oB 只看到 b1', fbu.length === 1 && fbu[0].childId === 'b1', fbu);
  const fbl = (FB.data && FB.data.logs) || [];
  ok('oB 的 logs 只有自己 2 条（l6 旧行 + l8 孩子行）', fbl.length === 2, fbl.map(r => r._id));
  ok('oB 的 logs 里没有 oA 的行', !fbl.some(r => r._openid !== 'oB'), fbl.map(r => r._openid));
  ok('oB 的 replaced=1 / unattributed=1（10-24 被取代、10-26 无主）',
    FB.data.childScope.replaced.logs === 1 && FB.data.childScope.unattributed.logs === 1, FB.data.childScope);

  /* ============================================================== overview */
  console.log('\n—— overview · children 全量 + byChild 逐孩子计数 ——');
  const O = await call({ token: ADMIN, module: 'overview' });
  ok('ok=true', O && O.ok === true, O);
  const od = (O && O.data) || {};
  ok('child = a2（currentUserId）且 childSource=current',
    od.child && od.child.childId === 'a2' && od.child.childSource === 'current', od.child);
  ok('child 昵称/年级取自 a2 切片，不是占位切片',
    od.child && od.child.nickname === '小A2' && od.child.grade === '一年级', od.child);
  const ch = od.children || [];
  ok('children = 3 个真实孩子（a1/a2/b1）', ch.length === 3, ids(ch, 'childId'));
  ok('children 不含占位切片', !ch.some(c => c.childId === 'guest'), ids(ch, 'childId'));
  ok('每个账号恰好一个 isCurrent（a2 + b1）',
    ch.filter(c => c.isCurrent).map(c => c.childId).sort().join(',') === 'a2,b1', ch.map(c => [c.childId, c.isCurrent]));

  const bc = od.byChild || [];
  const bA1 = bc.find(b => b.openid === 'oA' && b.childId === 'a1') || {};
  const bA2 = bc.find(b => b.openid === 'oA' && b.childId === 'a2') || {};
  const bLeg = bc.find(b => b.openid === 'oA' && b.childId === '' && b.legacy) || {};
  const bB1 = bc.find(b => b.openid === 'oB' && b.childId === 'b1') || {};
  ok('a1 只算自己那 1 条会话（legacy 没摊给它）', bA1.sessions === 1, bA1);
  ok('a2 只算自己那 1 条会话', bA2.sessions === 1, bA2);
  ok('无 childId 的行单独落 legacy 桶，会话 1 / 错题 1 / 掌握 1 / 待复习 1',
    bLeg.sessions === 1 && bLeg.mistakes === 1 && bLeg.mastered === 1 && bLeg.dueReviews === 1, bLeg);
  ok('b1 计数正确（会话 1 / 错题 1 / 掌握 1 / 待复习 0——r3 未到期）',
    bB1.sessions === 1 && bB1.mistakes === 1 && bB1.mastered === 1 && bB1.dueReviews === 0, bB1);
  const sum = k => bc.reduce((s, b) => s + (b[k] || 0), 0);
  ok('byChild 各列求和 == 全局总数（没重复计数）',
    sum('sessions') === (od.kpi || {}).sessions && sum('mistakes') === od.kpi.mistakes &&
    sum('mastered') === od.kpi.mastered && sum('dueReviews') === od.kpi.dueReviews,
    { sum: { s: sum('sessions'), m: sum('mistakes'), e: sum('mastered'), d: sum('dueReviews') }, kpi: od.kpi });

  /* =============================================================== profile */
  console.log('\n—— profile · childId / childSource / children[] ——');
  const P = await call({ token: ADMIN, module: 'profile' });
  const acc = (P.data && P.data.accounts) || [];
  ok('accounts = 3 个账号', acc.length === 3, ids(acc, 'openid'));
  const pA = acc.find(a => a.openid === 'oA') || {};
  const pB = acc.find(a => a.openid === 'oB') || {};
  const pC = acc.find(a => a.openid === 'oC') || {};
  ok('oA：childId=a2 / childSource=current', pA.childId === 'a2' && pA.childSource === 'current', { childId: pA.childId, src: pA.childSource });
  ok('oA：children = a1,a2（占位切片排除）',
    (pA.children || []).map(c => c.childId).sort().join(',') === 'a1,a2', pA.children);
  ok('oA：每个孩子自带 homework / studyPlans',
    !!((pA.children || []).find(c => c.childId === 'a1') || {}).homework &&
    !!((pA.children || []).find(c => c.childId === 'a1') || {}).studyPlans, pA.children);
  ok('oB：currentUserId 失效 → childId=b1 且 childSource=first（明确标注回落）',
    pB.childId === 'b1' && pB.childSource === 'first', { childId: pB.childId, src: pB.childSource });
  ok('oB：昵称/资产取自 b1，不是 users[0] 的占位切片',
    pB.nickname === '小B' && pB.farm && pB.farm.coins === 7, { nickname: pB.nickname, farm: pB.farm });
  ok('oC：只有占位切片 → childId 空 / childSource=none / children 空',
    pC.childId === '' && pC.childSource === 'none' && (pC.children || []).length === 0,
    { childId: pC.childId, src: pC.childSource, children: pC.children });
  ok('账号级计数仍跨孩子汇总（oA sessions=3）', pA.sessions === 3, pA.sessions);

  /* ================================================================= tutor */
  console.log('\n—— tutor · childId 透传（老行不编空值）——');
  const T = await call({ token: ADMIN, module: 'tutor' });
  const td = (T && T.data) || {};
  const ts = td.sessions || [];
  ok('sessions 4 条', ts.length === 4, ts.map(s => s.clientId));
  ok('s1 带 childId=a1', (ts.find(s => s.clientId === 's1') || {}).childId === 'a1', ts.find(s => s.clientId === 's1'));
  ok('s3（老行）没有 childId 字段（不是空字符串）',
    ts.some(s => s.clientId === 's3') && !('childId' in ts.find(s => s.clientId === 's3')),
    ts.find(s => s.clientId === 's3'));
  ok('cards 透传 childId：c1 有 a1，c2 无该字段',
    (td.cards.find(c => c.clientId === 'c1') || {}).childId === 'a1' &&
    !('childId' in (td.cards.find(c => c.clientId === 'c2') || {})), td.cards);
  ok('reviews/mistakes/evidence 都透传 childId',
    (td.reviews.find(r => r.clientId === 'r1') || {}).childId === 'a1' &&
    (td.mistakes.find(m => m.clientId === 'm1') || {}).childId === 'a1' &&
    (td.evidence.find(e => e.clientId === 'e1') || {}).childId === 'a1', td.reviews[0]);

  console.log('\n—— tutor · 单孩子模型：家长口令只回当前孩子（管理员仍看全部）——');
  const TU = await call({ token: T_OA, module: 'tutor' });
  const tud = (TU && TU.data) || {};
  ok('oA 当前孩子 a2 → sessions 只剩 s2(a2) + s3(历史行)',
    (tud.sessions || []).map(s => s.clientId).sort().join(',') === 's2,s3',
    (tud.sessions || []).map(s => s.clientId));
  ok('oA 的 a1 行被过滤（s1 / m1 / e1 / r1 / c1 都不再下发）',
    !['s1', 'm1', 'e1', 'r1', 'c1'].some(id =>
      ['sessions', 'mistakes', 'evidence', 'reviews', 'cards'].some(k =>
        (tud[k] || []).some(r => r.clientId === id))),
    { s: tud.sessions, m: tud.mistakes, e: tud.evidence, r: tud.reviews, c: tud.cards });
  ok('历史无归属行保留（s3）', (tud.sessions || []).some(s => s.clientId === 's3'), tud.sessions);

  /* ================================================================== sync */
  console.log('\n—— sync · 工作台镜像也带孩子归属 ——');
  const S = await call({ token: T_OA, module: 'sync' });
  const sp = (S.data && S.data.profile) || {};
  ok('oA sync：profile.childId=a2 / childSource=current', sp.childId === 'a2' && sp.childSource === 'current', sp);
  ok('oA sync：profile.children 列出 a1/a2',
    (sp.children || []).map(c => c.childId).sort().join(',') === 'a1,a2', sp.children);
  ok('oA sync：sessions 带 childId（s1=a1），老行 s3 不带',
    (S.data.sessions.find(s => s.clientId === 's1') || {}).childId === 'a1' &&
    !('childId' in (S.data.sessions.find(s => s.clientId === 's3') || {})), S.data.sessions);
  ok('oA sync：教训/证据/复习/闪卡都带 childId',
    ['mistakes', 'evidence', 'reviews', 'cards'].every(k =>
      (S.data[k] || []).some(r => r.childId)), { m: S.data.mistakes, c: S.data.cards });

  const SB = await call({ token: T_OB, module: 'sync' });
  ok('oB sync：profile.childId=b1 / childSource=first', SB.data.profile.childId === 'b1' && SB.data.profile.childSource === 'first', SB.data.profile);
  ok('oB sync：只看到自己的 1 条会话（隔离）', SB.data.sessions.length === 1 && SB.data.sessions[0].openid === 'oB', SB.data.sessions);

  /* ============================================================ 反证 */
  if (process.env.COUNTERPROOF === '1') {
    console.log('\n════ 反证 ════');
    const cp1 = counterproof('pick-current', [
      ["  if (cur) return { cu: cur, childId: cur.id, source: 'current' };\n  if (kids.length) return { cu: kids[0], childId: kids[0].id, source: 'first' };\n  return { cu: {}, childId: '', source: 'none' };",
        "  const us = (data && Array.isArray(data.users)) ? data.users : [];\n  const pick = cur || us[0] || {};\n  return { cu: pick, childId: pick.id || '', source: 'current' };"],
    ]);
    const cp2 = counterproof('legacy-dedupe', [
      ['  const childKeys = new Set();\n  src.forEach(r => { if (r.childId) childKeys.add(keyOf(r)); });',
        '  const childKeys = new Set();'],
    ]);
    console.log((cp1 && cp2) ? '\n反证有效 ✓' : '\n反证失效 ✗');
    if (!(cp1 && cp2)) fail++;
  }

  console.log('\n' + '─'.repeat(52));
  if (fail === 0) console.log(`通过 ${pass} / 共 ${pass}   ✓ 全部通过`);
  else console.log(`通过 ${pass} / 共 ${pass + fail}   ✗ 有 ${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('未捕获异常：', e); process.exit(1); });

/**
 * 反证：在进程内生成变异体（写在与原文件**同一目录**，否则 require('./scopeGuard')
 * 解析失败会把「红」的原因变成找不到文件），用 WAQ_PATH 指过去跑本文件，必须变红。
 * edits = [[原始片段, 替换片段], …]，任一锚点没命中即视为反证失效。
 */
function counterproof(tag, edits) {
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const dir = path.dirname(FN);
  const mutantPath = path.join(dir, `.mutant-${tag}.test.js`);
  const src = fs.readFileSync(FN, 'utf8');
  let mutated = src;
  for (const [from, to] of edits) {
    if (mutated.indexOf(from) < 0) {
      console.log(`  ! [${tag}] 未命中断言锚点 —— 反证跳过（不计为通过）`);
      return false;
    }
    mutated = mutated.replace(from, to);
  }
  fs.writeFileSync(mutantPath, mutated, 'utf8');
  let red = false;
  try {
    execFileSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, { WAQ_PATH: mutantPath, COUNTERPROOF: '' }),
      stdio: 'pipe',
    });
  } catch (e) { red = true; }
  try { fs.unlinkSync(mutantPath); } catch (e) { /* ignore */ }
  console.log(red
    ? `  ✓ [${tag}] 变异体变红`
    : `  ✗ [${tag}] 变异体没变红`);
  return red;
}

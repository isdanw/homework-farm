/**
 * test-multichild-rollover.cjs —— 多孩隔离：夜间结算 + 打卡明细（P0-B）
 * ---------------------------------------------------------------------------
 * 用内存 DB 驱动**真实的云函数源码**（不部署、不连云端），锁住三条硬约束：
 *   1. dailyReset 按 users[] **逐个孩子**结算：完成的孩子不被罚、未完成的孩子各自落账，
 *      hw_farm_settle 行必须带 childId（历史无 childId 的行不覆盖、不认领）；
 *   2. syncData 打卡明细按「当日有作业记录的孩子」各写一行，业务键 = openid+childId+date，
 *      重传不产生重复行；占位切片（guest/__placeholder）永不落库；
 *   3. 两家互不干扰：A 家的结算/日志不会落到 B 家，反之亦然。
 *
 *     node scripts/test-multichild-rollover.cjs
 *
 * 反证：
 *   · 把 dailyReset 改回「只取 currentUserId」→ A 组「c1 被结算」变红；
 *   · 去掉 settle 行的 childId → A 组归属断言变红；
 *   · 把 syncData 改回「只写当前孩子」→ B 组两行断言变红。
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
    lt: (val) => ({ __op: 'lt', val }),
    remove: () => ({ __op: 'remove' }),
  };

  function match(doc, q) {
    return Object.keys(q).every((k) => {
      const v = q[k];
      if (v && v.__op === 'exists') return (k in doc) === v.val;
      if (v && v.__op === 'lt') return Number(doc[k]) < Number(v.val);
      const dv = doc[k];
      if (dv && typeof dv === 'object') return JSON.stringify(dv) === JSON.stringify(v);
      return dv === v;
    });
  }

  /* wx-server-sdk 的 add/update 收 { data: X } 包壳；单键 {data:X} 一律解包
   * （与 scripts/mock-tcb.js 同一口径，两种 SDK 都伺候）。 */
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
    const c = { _q: q || {}, _limit: 1e9, _skip: 0, _field: null };
    c.limit = (n) => { c._limit = n; return c; };
    c.skip = (n) => { c._skip = n; return c; };
    c.field = (proj) => { c._field = proj; return c; };
    c.orderBy = () => c;
    c.get = () => {
      let rows = coll(name).filter(d => match(d, c._q)).slice(c._skip, c._skip + c._limit);
      if (c._field) {
        const keys = Object.keys(c._field).filter(k => c._field[k]);
        rows = rows.map(d => {
          const out = {};
          keys.forEach(k => { if (k in d) out[k] = clone(d[k]); });
          return out;
        });
      }
      return Promise.resolve({ data: rows.map(clone) });
    };
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
      field: (p) => chain(name).field(p),
      get: () => chain(name).get(),
      count: () => Promise.resolve({ total: coll(name).length }),
      add: (obj) => {
        const d = Object.assign({ _id: 'id_' + coll(name).length + '_' + Math.random().toString(36).slice(2, 7) }, clone(unwrap(obj)));
        coll(name).push(d);
        return Promise.resolve({ id: d._id });
      },
      doc: (id) => ({
        get: () => {
          const d = coll(name).find(x => x._id === id);
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

const P = {
  dailyReset: path.join(ROOT, 'cloudfunctions/dailyReset/index.js'),
  syncData: path.join(ROOT, 'cloudfunctions/syncData/index.js'),
};
function load(name) {
  for (const p of Object.values(P)) delete require.cache[p];
  return require(P[name]);
}

/* ------------------------------ 断言 ------------------------------ */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   → ' + JSON.stringify(extra) : '')); }
}
function group(n) { console.log('\n' + n); }

/* ------------------------------ 日期 ------------------------------ */
/** 与 dailyReset 的 dateKey 完全一致（云函数跑 UTC，按 +8 换算） */
function utcDateKey(offset) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + offset);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
/** 与 syncData 的 dateKey 完全一致（用本地时区读数） */
function localDateKey() {
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const YEST = utcDateKey(-1);
const TODAY = utcDateKey(0);
const localToday = localDateKey();

const hw = (chinese, math, english) => ({
  chinese: { done: chinese }, math: { done: math }, english: { done: english },
});
const farm = (coins, plots, bears) => ({ coins: coins, plots: plots || [], bears: bears || [], shields: 0, logs: [] });

(async () => {
  /* ================= A. dailyReset：两个孩子各自结算 ================= */
  group('A. dailyReset · 一个家庭两个孩子各自结算');
  mockDb = makeDb();
  wxOpenid = '';
  const dr = load('dailyReset');

  const ROOT_A = {
    currentUserId: 'c2',
    users: [
      {
        id: 'c1', name: '大宝',
        homework: { [YEST]: hw(true, false, false) },     // 缺 2 科
        farm: farm(100, [{ plantedDate: YEST, health: 3, stage: 3 }]),  // 有成熟植株
        settledDates: [],
      },
      {
        id: 'c2', name: '二宝',
        homework: { [YEST]: hw(true, true, true) },       // 全完成 → 不受罚
        farm: farm(200),
        settledDates: [],
      },
      {
        id: 'guest', name: '占位', __placeholder: true,
        homework: { [YEST]: hw(false, false, false) },
        farm: farm(999),
      },
    ],
  };
  const ROOT_B = {
    currentUserId: 'b1',
    users: [{ id: 'b1', name: 'B 家娃', homework: {}, farm: farm(0), settledDates: [] }],
  };

  mockDb.collection('hw_farm_user').add({
    _openid: 'oA', data: ROOT_A, updatedAt: 111, createdAt: 111,
  });
  mockDb.collection('hw_farm_user').add({
    _openid: 'oB', data: ROOT_B, updatedAt: 222, createdAt: 222,
  });
  // 历史遗留：无 childId 的旧结算行（不得被认领/覆盖）
  mockDb.collection('hw_farm_settle').add({
    _openid: 'oA', date: YEST, level: 1, bears: 1, stolen: 0, withered: 0, createdAt: 1,
  });

  const sum1 = await dr.main();
  const settles = mockDb._colls.get('hw_farm_settle');
  const newSettles = settles.filter(s => s.createdAt !== 1);
  const users = mockDb._colls.get('hw_farm_user');
  const a = users.find(u => u._openid === 'oA').data;
  const b = users.find(u => u._openid === 'oB').data;

  ok(sum1.users === 2 && sum1.children === 3 && sum1.punished === 2,
    'summary：2 个家庭 / 3 个孩子 / 2 条惩罚', sum1);
  ok(newSettles.length === 2, '新结算行 2 条（c1 + b1，c2 与占位不落行）', newSettles.length);
  ok(newSettles.every(s => typeof s.childId === 'string' && s.childId),
    '每条新结算行都带非空 childId', newSettles.map(s => s.childId));

  const sC1 = newSettles.find(s => s.childId === 'c1');
  ok(!!sC1 && sC1._openid === 'oA' && sC1.level === 2 && sC1.bears === 2 && sC1.withered === 1 && sC1.stolen === 50,
    'c1（缺 2 科）→ level 2 / 2 只熊 / 枯 1 株 / 偷 50', sC1);
  const sB1 = newSettles.find(s => s.childId === 'b1');
  ok(!!sB1 && sB1._openid === 'oB' && sB1.level === 3 && sB1.bears === 3 && sB1.stolen === 0,
    'b1（昨天无记录 → 缺 3 科）→ level 3', sB1);

  const c1 = a.users.find(u => u.id === 'c1');
  const c2 = a.users.find(u => u.id === 'c2');
  const guest = a.users.find(u => u.id === 'guest');
  ok(c1.farm.coins === 50 && c1.farm.bears.length === 2,
    'c1 自己的农场被罚（金币 100→50，2 只熊）', { coins: c1.farm.coins, bears: c1.farm.bears.length });
  ok(c2.farm.coins === 200 && c2.farm.bears.length === 0,
    '完成作业的 c2 农场不受影响（金币 200，0 只熊）', { coins: c2.farm.coins, bears: c2.farm.bears.length });
  ok(c1.settledDates.indexOf(YEST) >= 0 && c2.settledDates.indexOf(YEST) >= 0,
    '两个孩子各自被标记已结算', { c1: c1.settledDates, c2: c2.settledDates });
  ok(!!(c1.homework[TODAY] && c2.homework[TODAY]) && c1.homework[TODAY].math.done === false,
    '两个孩子都建了今天的空白作业', Object.keys(c1.homework));
  ok(c1.lastActiveDate === TODAY && c2.lastActiveDate === TODAY, '两个孩子 lastActiveDate 都推进到今天');
  ok(guest.farm.coins === 999 && guest.settledDates === undefined && guest.homework[TODAY] === undefined,
    '占位切片不被结算、不被改作业', { coins: guest.farm.coins, settled: guest.settledDates });
  ok(b.users[0].farm.bears.length === 3 && b.users[0].settledDates.indexOf(YEST) >= 0,
    'B 家按自己的数据结算，未与 A 家互串', b.users[0].farm.bears.length);

  const legacy = settles.find(s => s.createdAt === 1);
  ok(!!legacy && !('childId' in legacy),
    '历史无 childId 的结算行原样保留（不认领、不回填）', legacy);

  /* 幂等：同一天再跑一次，不得重复惩罚 / 重复落行 */
  const sum2 = await dr.main();
  ok(sum2.punished === 0 && mockDb._colls.get('hw_farm_settle').length === 3,
    '同日重跑：不重复结算、不新增结算行', { punished: sum2.punished, rows: mockDb._colls.get('hw_farm_settle').length });
  const c1After = mockDb._colls.get('hw_farm_user').find(u => u._openid === 'oA').data.users.find(u => u.id === 'c1');
  ok(c1After.farm.coins === 50, '重跑不会二次扣金币', c1After.farm.coins);

  /* ================= B. syncData：每个孩子一行打卡 ================= */
  group('B. syncData · 打卡明细按孩子逐条写');
  mockDb = makeDb();
  wxOpenid = 'oA';
  const sd = load('syncData');

  const ROOT_UP = {
    currentUserId: 'c2',
    users: [
      { id: 'c1', homework: { [localToday]: hw(true, false, false) }, farm: farm(11, [], [{}, {}]) },
      { id: 'c2', homework: { [localToday]: hw(true, true, false) }, farm: farm(22) },
      { id: 'c3', homework: {}, farm: farm(33) },               // 今天没记录 → 不落行
      { id: 'guest', __placeholder: true, homework: { [localToday]: hw(true, true, true) }, farm: farm(99) },
    ],
  };
  mockDb.collection('hw_farm_user').add({ _openid: 'oA', data: ROOT_UP, updatedAt: 500, createdAt: 500 });
  // 历史遗留：无 childId 的旧打卡行
  mockDb.collection('hw_checkin_log').add({
    _openid: 'oA', date: localToday, chinese: false, math: false, english: false,
  });

  const up1 = await sd.main({ action: 'upload', payload: JSON.parse(JSON.stringify(ROOT_UP)) });
  let logs = mockDb._colls.get('hw_checkin_log');
  const fresh = logs.filter(r => r.childId);
  ok(up1.ok === true, 'upload 成功', up1);
  ok(fresh.length === 2, '两个孩子各一行（不是只写当前孩子 c2）', fresh.map(r => r.childId));
  const r1 = fresh.find(r => r.childId === 'c1');
  const r2 = fresh.find(r => r.childId === 'c2');
  ok(!!r1 && r1.chinese === true && r1.math === false && r1.english === false && r1.coins === 11 && r1.bears === 2,
    'c1 行内容取自 c1 自己的切片', r1);
  ok(!!r2 && r2.chinese === true && r2.math === true && r2.english === false && r2.coins === 22 && r2.bears === 0,
    'c2 行内容取自 c2 自己的切片（与 c1 不串）', r2);
  ok(!fresh.some(r => r.childId === 'c3'), '今天没作业记录的孩子不落行');
  ok(!fresh.some(r => r.childId === 'guest'), '占位切片永不落打卡行');

  const legacyLog = logs.find(r => !r.childId);
  ok(!!legacyLog && legacyLog.chinese === false,
    '历史无 childId 的打卡行保持原样（未被当前孩子认领/覆写）', legacyLog);

  /* 幂等：重传不得新增行 */
  const up2 = await sd.main({ action: 'upload', payload: JSON.parse(JSON.stringify(ROOT_UP)), base: up1.cloudUpdatedAt });
  logs = mockDb._colls.get('hw_checkin_log');
  ok(up2.ok === true && logs.length === 3,
    '重传：总数仍是 3 行（2 新 + 1 旧），无重复行', { total: logs.length, res: up2.ok });
  ok(logs.filter(r => r.childId === 'c1').length === 1, 'c1 行按 openid+childId+date 幂等更新');

  /* 跨家庭隔离：B 家上传不得写到 A 家的行上 */
  mockDb.collection('hw_farm_user').add({ _openid: 'oB', data: { currentUserId: 'b1', users: [{ id: 'b1', homework: { [localToday]: hw(true, true, true) }, farm: farm(7) }] }, updatedAt: 9, createdAt: 9 });
  wxOpenid = 'oB';
  const upB = await sd.main({ action: 'upload', payload: { currentUserId: 'b1', users: [{ id: 'b1', homework: { [localToday]: hw(true, true, true) }, farm: farm(7) }] } });
  logs = mockDb._colls.get('hw_checkin_log');
  const bRows = logs.filter(r => r._openid === 'oB');
  ok(upB.ok === true && bRows.length === 1 && bRows[0].childId === 'b1',
    'B 家只新增自己的一行', bRows);
  ok(logs.filter(r => r._openid === 'oA').length === 3,
    'A 家的行数不受 B 家上传影响', logs.filter(r => r._openid === 'oA').length);

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();

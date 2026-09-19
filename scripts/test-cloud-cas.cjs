/**
 * test-cloud-cas.cjs —— F10（syncData 上传乐观锁）/ F11（dailyReset 写回 CAS）回归测试
 * ---------------------------------------------------------------------------
 * 覆盖审计报告 P2-1 / P2-2：云端「读-改-写」无版本条件 → 多设备 / 多写入方静默互相覆盖。
 *
 * 用假的 wx-server-sdk 驱动**真实云函数源码**，不需要部署、不需要连云端：
 *     node scripts/test-cloud-cas.cjs
 *
 * 关键能力：`db._interleaveOnce(fn)` / `db._interleaveAlways(fn)`
 *   在两个「读」和「写」之间插入一次**外部写入**（模拟另一台设备的前端 upload、
 *   或另一个云函数并发写），用来把「读-写窗口」这个时间竞态变成可复现的确定性用例。
 *   注意：`.get()` 返回的是深拷贝 —— 否则云函数内存里的旧快照会跟着外部写入一起变，
 *   竞态就测不出来了（这是本挂具最容易写错的一点）。
 *
 * 反证（用改动前的版本跑同一套用例，T3/T4/T6/T8/E1 应变红）：
 *     git show HEAD:cloudfunctions/syncData/index.js   > /tmp/old-syncData.js
 *     git show HEAD:cloudfunctions/dailyReset/index.js > /tmp/old-dailyReset.js
 *     SYNC_PATH=/tmp/old-syncData.js RESET_PATH=/tmp/old-dailyReset.js node scripts/test-cloud-cas.cjs
 */
const path = require('path');
const Module = require('module');

const SYNC_PATH = process.env.SYNC_PATH
  || path.resolve(__dirname, '../cloudfunctions/syncData/index.js');
const RESET_PATH = process.env.RESET_PATH
  || path.resolve(__dirname, '../cloudfunctions/dailyReset/index.js');

/* ------------------------------ 假 wx-server-sdk ------------------------------ */
let seq = 0;
let ctx = { OPENID: 'o1' };
let onceHook = null;      // 一次性外部写入钩子（在写之前触发，用完自动解除）
let alwaysHook = null;    // 每次写之前都触发（模拟「窗口被持续抢占」）
let brokenCondWrite = false;  // true = 条件写「一行未改但也不报错」（模拟 SDK 返回结构不符预期）
const clone = v => JSON.parse(JSON.stringify(v));

function makeDb() {
  const colls = new Map();
  function coll(name) { if (!colls.has(name)) colls.set(name, []); return colls.get(name); }

  const evalCmd = (doc, key, cond) => {
    if (cond && typeof cond === 'object' && cond.__cmd) {
      switch (cond.__cmd) {
        case 'exists': return cond.v ? (doc[key] !== undefined) : (doc[key] === undefined);
        case 'lt': return doc[key] < cond.v;
        case 'gt': return doc[key] > cond.v;
        case 'eq': return doc[key] === cond.v;
        default: return false;
      }
    }
    return doc[key] === cond;
  };
  const match = (doc, q) => Object.keys(q || {}).every(k => evalCmd(doc, k, q[k]));

  /** 外部写入：在任何写操作真正执行**之前**触发，模拟「恰好落在读-写窗口内的那次写入」。
   *  传入本次写操作原本要命中的那份原始文档（可能因此不再命中 —— 这正是要测的东西）。 */
  function fireInterleave(doc) {
    if (onceHook) { const f = onceHook; onceHook = null; f(doc); }
    if (alwaysHook) alwaysHook(doc);
  }

  const api = {
    _colls: colls,
    /** 注入一次外部写入，fn 收到的是**原始文档引用**（可直接改）
     *  例：db._interleaveOnce(d => { d.data.users[0].learn = { stars: 42 }; d.updatedAt = Date.now() + 1000; }) */
    _interleaveOnce(fn) { onceHook = fn; },
    /** 每次写之前都注入（模拟持续抢占，用来验证「有上限地放弃」） */
    _interleaveAlways(fn) { alwaysHook = fn; },
    _dump(name) { return coll(name).map(clone); },
    // 数据库指令：只实现被云函数真正用到的几个（exists / lt / gt / eq / set / remove）
    command: {
      exists: v => ({ __cmd: 'exists', v }),
      lt: v => ({ __cmd: 'lt', v }),
      gt: v => ({ __cmd: 'gt', v }),
      eq: v => ({ __cmd: 'eq', v }),
      set: v => ({ __cmd: 'set', v }),
      remove: () => ({ __cmd: 'remove' })
    },
    createCollection(name) { coll(name); return Promise.resolve({}); },
    collection(name) {
      const whereChain = (q) => {
        const chain = { _q: q || {}, _limit: 1e9, _skip: 0, _field: null };
        chain.limit = n => { chain._limit = n; return chain; };
        chain.skip = n => { chain._skip = n; return chain; };
        chain.field = f => { chain._field = f; return chain; };
        chain.get = () => {
          let rows = coll(name).filter(d => match(d, chain._q));
          rows = rows.slice(chain._skip, chain._skip + chain._limit);
          return Promise.resolve({ data: rows.map(clone) });   // ← 必须深拷贝，见文件头
        };
        chain.update = (arg) => {
          const fields = (arg && arg.data) || arg || {};
          // 「条件写语义与预期不符」的模拟：假装写成功但实际一行未改
          // （用来验证云函数能区分「真冲突」与「SDK 返回结构意外」，不会因此让上传彻底停摆）
          if (brokenCondWrite) return Promise.resolve({ stats: { updated: 0 } });
          // 先取「原本会命中」的文档喂给外部写入钩子，**之后重新评估条件** ——
          // 版本条件写（CAS）的正确语义正是：条件以「写这一刻」的状态为准。
          fireInterleave(coll(name).filter(d => match(d, chain._q))[0]);
          const rows = coll(name).filter(d => match(d, chain._q));
          rows.forEach(d => Object.assign(d, clone(fields)));
          return Promise.resolve({ stats: { updated: rows.length } });
        };
        chain.remove = () => {
          const rows = coll(name).filter(d => match(d, chain._q));
          const keep = coll(name).filter(d => !match(d, chain._q));
          colls.set(name, keep);
          return Promise.resolve({ stats: { removed: rows.length } });
        };
        return chain;
      };
      return {
        // 集合级也能直接链式调用（dailyReset 用的是 collection().field().skip().limit().get()）
        where: whereChain,
        field: f => whereChain({}).field(f),
        skip: n => whereChain({}).skip(n),
        limit: n => whereChain({}).limit(n),
        get: () => whereChain({}).get(),
        count() { return Promise.resolve({ total: coll(name).length }); },
        add(arg) {
          // wx-server-sdk 语义：add({ data: X }) 里 X 就是整份文档（不是「字段 data」）
          const payload = (arg && arg.data !== undefined) ? arg.data : (arg || {});
          const d = Object.assign({ _id: 'id_' + (++seq) }, clone(payload));
          coll(name).push(d);
          return Promise.resolve({ _id: d._id });
        },
        doc(id) {
          return {
            get() {
              const d = coll(name).find(x => x._id === id);
              return Promise.resolve({ data: d ? clone(d) : null });
            },
            update(arg) {
              const d = coll(name).find(x => x._id === id);
              fireInterleave(d);
              if (!d) return Promise.reject(new Error('doc not found'));
              Object.assign(d, clone((arg && arg.data) || arg || {}));
              return Promise.resolve({ stats: { updated: 1 } });
            },
            remove() {
              colls.set(name, coll(name).filter(x => x._id !== id));
              return Promise.resolve({ stats: { removed: 1 } });
            }
          };
        }
      };
    }
  };
  return api;
}

let db;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'env-fake',
      init() {},
      getWXContext() { return { OPENID: ctx.OPENID }; },
      database() { return db; }
    };
  }
  return origLoad.apply(this, arguments);
};

function loadFn(p) {
  delete require.cache[require.resolve(p)];
  return require(p);
}
function freshDb() { onceHook = null; alwaysHook = null; brokenCondWrite = false; db = makeDb(); return db; }

/* ------------------------------ 断言 ------------------------------ */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(n) { console.log('\n' + n); }

const USER = 'hw_farm_user';
const mkRoot = (patch) => Object.assign({
  version: 2,
  users: [Object.assign({
    id: 'u1', nickname: '加一', settledDates: [],
    homework: {}, farm: { coins: 100, plots: [], bears: [], shields: 0, logs: [] }
  }, (patch || {}).user || {})],
  currentUserId: 'u1'
}, (patch || {}).root || {});

/** 复刻 dailyReset 的 dateKey（UTC+8），保证用例与云函数取到同一组日期 */
function dateKey(offset) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + offset);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
const YEST = dateKey(-1);
const TODAY = dateKey(0);

(async () => {
  /* ===================== F10：syncData 上传乐观锁 ===================== */

  group('E1  首次上传：云端无文档 → 建档，并回传 cloudUpdatedAt 建立基线');
  {
    freshDb();
    const sync = loadFn(SYNC_PATH);
    const r = await sync.main({ action: 'upload', payload: mkRoot(), base: 0 });
    const rows = db._dump(USER);
    ok(r.ok === true, '上传成功', JSON.stringify(r));
    ok(typeof r.cloudUpdatedAt === 'number' && r.cloudUpdatedAt > 0, '回传了 cloudUpdatedAt（客户端据此建立 CAS 基线）', JSON.stringify(r.cloudUpdatedAt));
    ok(rows.length === 1 && rows[0]._openid === 'o1', '建档且归属正确');
  }

  group('E2  base 与云端一致 → CAS 写入成功，且回传新版本');
  {
    freshDb();
    db.collection(USER).add({ data: { _openid: 'o1', data: mkRoot(), updatedAt: 111, createdAt: 111 } });
    const id = db._dump(USER)[0]._id;
    const sync = loadFn(SYNC_PATH);
    const r = await sync.main({ action: 'upload', payload: mkRoot({ user: { nickname: '新昵称' } }), base: 111 });
    const doc = db._dump(USER)[0];
    ok(r.ok === true, '上传成功', JSON.stringify(r));
    ok(doc.data.users[0].nickname === '新昵称', '内容已落库');
    ok(doc.updatedAt > 111, '云端版本已推进', 'updatedAt=' + doc.updatedAt);
    ok(r.cloudUpdatedAt === doc.updatedAt, '回传版本与实际落库版本一致');
    ok(db._dump(USER).length === 1, '没有重复建档', 'id=' + id);
  }

  group('E3  base 落后于云端（另一台设备写过）→ 报 conflict 且**不写库** ❗核心');
  {
    freshDb();
    // 云端由「另一台设备」写成了 coins=777
    db.collection(USER).add({ data: { _openid: 'o1', data: mkRoot({ user: { farm: { coins: 777, plots: [], bears: [], shields: 0, logs: [] } } }), updatedAt: 222, createdAt: 111 } });
    const sync = loadFn(SYNC_PATH);
    // 本机拿着旧基线 111、内容是 coins=100 的快照来上传
    const r = await sync.main({ action: 'upload', payload: mkRoot(), base: 111 });
    const doc = db._dump(USER)[0];
    ok(r.ok === false && r.code === 'conflict', '返回 conflict', JSON.stringify({ ok: r.ok, code: r.code }));
    ok(doc.data.users[0].farm.coins === 777, '云端内容未被覆盖（旧实现会在这里静默写成 100）', 'coins=' + doc.data.users[0].farm.coins);
    ok(doc.updatedAt === 222, '云端版本未被推进');
    ok(r.cloudUpdatedAt === 222, 'conflict 带回云端最新版本，供客户端采纳为新基线');
    ok(r.data && r.data.users && r.data.users[0].farm.coins === 777, 'conflict 带回云端最新数据，供客户端做加法式调和');
  }

  group('E4  base 一致但「读-写之间」被人抢先写 → CAS 落空，同样报 conflict 且不覆盖 ❗核心');
  {
    freshDb();
    db.collection(USER).add({ data: { _openid: 'o1', data: mkRoot(), updatedAt: 111, createdAt: 111 } });
    const id = db._dump(USER)[0]._id;
    // 精确模拟：云函数已读完（拿到 updatedAt=111），此刻外部写入把版本推到 222
    db._interleaveOnce(d => {
      d.data.users[0].farm.coins = 888;
      d.updatedAt = 222;
    });
    const sync = loadFn(SYNC_PATH);
    const r = await sync.main({ action: 'upload', payload: mkRoot({ user: { farm: { coins: 100, plots: [], bears: [], shields: 0, logs: [] } } }), base: 111 });
    const doc = db._dump(USER).find(d => d._id === id);
    ok(r.ok === false && r.code === 'conflict', '返回 conflict', JSON.stringify({ ok: r.ok, code: r.code }));
    ok(doc.data.users[0].farm.coins === 888, '抢在窗口内的那次写入存活（旧实现必然被覆盖）', 'coins=' + doc.data.users[0].farm.coins);
    ok(r.cloudUpdatedAt === 222, 'conflict 带回的是**重新读到的**最新版本');
  }

  group('E5  无基线（base=0，老版本客户端 / 首次）→ 兼容放行，但回传版本让下次自动进 CAS');
  {
    freshDb();
    db.collection(USER).add({ data: { _openid: 'o1', data: mkRoot(), updatedAt: 111, createdAt: 111 } });
    const sync = loadFn(SYNC_PATH);
    const r = await sync.main({ action: 'upload', payload: mkRoot({ user: { nickname: '旧端' } }), base: 0 });
    const doc = db._dump(USER)[0];
    ok(r.ok === true, '老客户端不被一脚踢开（否则上线即全员冲突）', JSON.stringify(r));
    ok(doc.data.users[0].nickname === '旧端', '内容已落库');
    ok(r.cloudUpdatedAt === doc.updatedAt, '回传版本，客户端下一次上传起自动进入 CAS');
  }

  group('E6  download 回传 cloudUpdatedAt（下拉即建立基线）');
  {
    freshDb();
    db.collection(USER).add({ data: { _openid: 'o1', data: mkRoot(), updatedAt: 333, createdAt: 111 } });
    const sync = loadFn(SYNC_PATH);
    const r = await sync.main({ action: 'download' });
    ok(r.ok === true && r.cloudUpdatedAt === 333, 'cloudUpdatedAt=333', JSON.stringify(r.cloudUpdatedAt));
    const r2 = await sync.main({ action: 'whoami' });
    ok(r2.openid === 'o1', 'whoami 未受影响');
  }

  /* ===================== F11：dailyReset 写回 CAS ===================== */

  const seedSettlable = (patch) => {
    // 昨天两科没做 → 必被结算；today 尚无记录 → 会建空白
    const user = Object.assign({
      id: 'u1',
      settledDates: [],
      homework: { [YEST]: { chinese: { done: true }, math: { done: false }, english: { done: false } } },
      farm: { coins: 1000, plots: [], bears: [], shields: 0, logs: [] }
    }, patch || {});
    db.collection(USER).add({
      data: { _openid: 'o1', createdAt: 111, updatedAt: 111,
        data: { version: 2, users: [user], currentUserId: 'u1' } }
    });
  };

  group('E7  无并发：一轮 CAS 写成功，结算字段与空白日记录都落地');
  {
    freshDb();
    seedSettlable();
    const reset = loadFn(RESET_PATH);
    const s = await reset.main();
    const doc = db._dump(USER)[0];
    ok(s.users === 1 && s.failed === 0 && s.retried === 0, '计账正确', JSON.stringify({ users: s.users, failed: s.failed, retried: s.retried }));
    ok(s.punished === 1, '结算了 1 个用户', 'punished=' + s.punished);
    ok(doc.data.users[0].settledDates.indexOf(YEST) >= 0, 'settledDates 记下昨天');
    ok(!!doc.data.users[0].homework[TODAY], '为今天建立了空白作业记录');
    // 昨天缺 2 科 → 惩罚等级 2 → 2 只小狗熊（确认结算结果真的写进去了，而不是只改了个时间戳）
    ok((doc.data.users[0].farm.bears || []).length === 2, '结算结果已落库（2 科未完成 → 小狗熊 ×2）', JSON.stringify((doc.data.users[0].farm.bears || []).length));
    ok(doc.updatedAt > 111, '云端版本已推进');
    ok(db._dump('hw_farm_settle').length === 1, '落了 1 条结算记录');
  }

  group('E8  读-写窗口内前端 upload 落库 → 重读重算，两边数据都保住 ❗核心');
  {
    freshDb();
    seedSettlable();
    // 模拟：dailyReset 读完（updatedAt=111）→ 前端 upload 落库（+ 新的作业/金币）→ 才轮到写回
    db._interleaveOnce(d => {
      d.data.users[0].learn = { stars: 42 };            // 前端刚写的东西
      d.data.users[0].homework[YEST].math.done = true;  // 甚至把缺的作业补上了
      d.updatedAt = 222;
      d.data.users[0].lastActiveDate = TODAY;
    });
    const reset = loadFn(RESET_PATH);
    const s = await reset.main();
    const doc = db._dump(USER)[0];
    const cu = doc.data.users[0];
    ok(s.failed === 0, '没有放弃该用户', 'failed=' + s.failed);
    ok(s.retried === 1, '恰好重试了 1 轮', 'retried=' + s.retried);
    ok(cu.learn && cu.learn.stars === 42, '前端刚写的数据存活（旧实现必然被旧快照回写抹掉）', JSON.stringify(cu.learn));
    ok(cu.homework[YEST].math.done === true, '前端补的作业完成标记存活');
    ok(cu.settledDates.indexOf(YEST) >= 0, '结算也没丢：第二天重算后写回');
    ok(!!cu.homework[TODAY], '今天空白记录也建好了');
  }

  group('E9  窗口被持续抢占 → 有上限地放弃，且**绝不用旧快照覆盖** ❗核心');
  {
    freshDb();
    seedSettlable();
    // 每一轮 CAS 写之前都被外部写走 → 3 轮全部落空
    let n = 0;
    db._interleaveAlways(d => { n++; d.data.users[0].learn = { stars: 100 + n }; d.updatedAt = 1000 + n; });

    const reset = loadFn(RESET_PATH);
    const s = await reset.main();
    const doc = db._dump(USER)[0];
    ok(s.failed === 1, '该用户被计为 failed（没写成，但也没乱写）', JSON.stringify({ failed: s.failed, users: s.users }));
    ok(s.users === 0, '没写成就不计入 users（不虚报）');
    ok(doc.data.users[0].learn && doc.data.users[0].learn.stars >= 101, '外部写入者的数据完好', JSON.stringify(doc.data.users[0].learn));
    ok(doc.data.users[0].settledDates.indexOf(YEST) < 0, '结算未落地（CAS 没抢到就绝不写）——下次定时任务会补算');
    ok(db._dump('hw_farm_settle').length === 0, '没有落半成品结算记录');
  }

  group('E10 幂等：同一份数据连跑两次，第二次不该重复惩罚');
  {
    freshDb();
    seedSettlable();
    const reset = loadFn(RESET_PATH);
    const s1 = await reset.main();
    const s2 = await reset.main();
    const doc = db._dump(USER)[0];
    ok(s1.punished === 1 && s2.punished === 0, '第二次不再重复惩罚', JSON.stringify({ s1: s1.punished, s2: s2.punished }));
    ok(doc.data.users[0].settledDates.filter(d => d === YEST).length === 1, 'settledDates 不重复累加', JSON.stringify(doc.data.users[0].settledDates));
    ok(db._dump('hw_farm_settle').length === 1, '结算记录只有 1 条');
  }

  group('E11 条件写返回结构不符预期时，上传必须仍能落库（退化为直写而非一路报 conflict）❗底线');
  {
    freshDb();
    db.collection(USER).add({ data: { _openid: 'o1', data: mkRoot(), updatedAt: 111, createdAt: 111 } });
    brokenCondWrite = true;      // 条件写「一行未改」，且版本没变
    const sync = loadFn(SYNC_PATH);
    const r = await sync.main({ action: 'upload', payload: mkRoot({ user: { nickname: '降级写' } }), base: 111 });
    const doc = db._dump(USER)[0];
    ok(r.ok === true, '上传仍然成功（若这里报 conflict，客户端会无限「采纳基线→重推」，上传彻底停摆）', JSON.stringify(r));
    ok(doc.data.users[0].nickname === '降级写', '内容已落库（退化为直写）');
    ok(typeof r.cloudUpdatedAt === 'number', '仍然回传云端版本');
  }

  group('E12 同上场景：dailyReset 仍必须把结算落地');
  {
    freshDb();
    seedSettlable();
    brokenCondWrite = true;
    const reset = loadFn(RESET_PATH);
    const s = await reset.main();
    const doc = db._dump(USER)[0];
    ok(s.failed === 0, '没有把该用户判为失败', 'failed=' + s.failed);
    ok(s.users === 1, '计入 users');
    ok(doc.data.users[0].settledDates.indexOf(YEST) >= 0, '结算字段已落库（退化为直写）');
    ok(db._dump('hw_farm_settle').length === 1, '结算记录已落');
  }

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n挂具异常:', e); process.exit(2); });

/**
 * test-f14-sync.cjs —— F14 字段级时间戳 + LWW 仲裁回归测试
 * ---------------------------------------------------------------------------
 * 对应 miniprogram/utils/store.js 的 F14 实现（f14Stamp / f14MergeUser，经
 * 导出的 reconcileWithCloud / save 驱动，黑盒验证真实合并路径）。
 *
 * 纯 Node 运行（stub 掉 wx / getApp），不需要微信开发者工具：
 *     node scripts/test-f14-sync.cjs
 *
 * 设计要点：
 *   · T1 用可控制时钟（Date.now 桩）精确证明「仅本地真改动的字段才打戳」，
 *     未改动的字段时间戳保持不动（不是每次保存全打戳 → 否则本地永远赢）。
 *   · T2–T4 通过导出的 reconcileWithCloud 注入带 _ts 的云端，验证 LWW 仲裁：
 *       云端较新 → 采纳云端；本地较新 → 保留本地；双方无戳 → 本地优先（R4 兼容）。
 *   · 复用 test-store-persistence.cjs 的挂具骨架（storage Map + wx 桩 + 定时器登记）。
 *
 * 反证（证明用例真能抓到原缺陷）：
 *     git show HEAD:miniprogram/utils/store.js > /tmp/oldstore.js
 *     # 在 /tmp/oldstore.js 里注释掉 f14Stamp/f14MergeUser 的接入（或整体回退到 HEAD 前）
 *     SRC_DIR=/tmp node scripts/test-f14-sync.cjs   # 期望 T2/T4 多条 ✗
 */
const path = require('path');

const SRC_DIR = process.env.SRC_DIR
  ? path.resolve(process.env.SRC_DIR)
  : path.resolve(__dirname, '../miniprogram/utils');
const STORE_PATH = path.join(SRC_DIR, 'store.js');
const BASE_KEY = 'wb_hwfarm_data_v2';
const OPENID_KEY = 'wb_hwfarm_openid';

const OPENID = 'o_test_f14';
const NS_KEY = BASE_KEY + '_' + OPENID;

/* --------------------------- 可控制时钟 --------------------------- */
const REAL_NOW = Date.now;
let CLOCK = 1000;
Date.now = () => CLOCK;

/* ------------------------------ 测试挂具 ------------------------------ */
let storage;
const timerIds = new Set();
const _setTimeout = global.setTimeout;
const _clearTimeout = global.clearTimeout;
global.setTimeout = function (fn, ms, ...args) {
  const id = _setTimeout(function () { timerIds.delete(id); fn.apply(null, args); }, ms);
  timerIds.add(id);
  return id;
};
global.clearTimeout = function (id) { timerIds.delete(id); return _clearTimeout(id); };
function drainTimers() {
  timerIds.forEach(id => _clearTimeout(id));
  timerIds.clear();
}

function resetEnv() {
  drainTimers();
  storage = new Map();
  global.wx = {
    getStorageSync(k) { return storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : ''; },
    setStorageSync(k, v) { storage.set(k, JSON.parse(JSON.stringify(v))); },
    removeStorageSync(k) { storage.delete(k); },
    getStorageInfoSync() { return { keys: Array.from(storage.keys()), currentSize: 0, limitSize: 10240 }; },
    cloud: { callFunction() { return Promise.resolve({ result: { ok: true } }); } }
  };
  global.getApp = () => ({ globalData: {} });
  delete require.cache[require.resolve(STORE_PATH)];
}

function freshStore() {
  const s = require(STORE_PATH);
  s.setCloudReady(true);
  return s;
}

/* 造一个「真实孩子」切片（含全部 F14 白名单字段，便于 LWW 仲裁） */
const FARM_FULL = { coins: 999, suns: 7, seeds: {}, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] };
function makeUser(id, patch) {
  return Object.assign({
    id: id,
    nickname: '加一',
    avatar: '🐯',
    grade: '一年级',
    createdAt: 1000,
    lastActiveDate: '2026-09-16',
    settledDates: ['2026-09-15'],
    profile: { nickname: '加一', streak: 3, lastFullCheckinDate: '2026-09-16', equipped: {} },
    learner: { stage: '小学' },
    subjectProfiles: {},
    homework: {},
    checkinTypes: [],
    schedule: null,
    plans: {},
    studyPlans: {},
    comments: [],
    farm: JSON.parse(JSON.stringify(FARM_FULL)),
    _ts: {}
  }, patch || {});
}
const FARM_20 = { coins: 20, suns: 1, seeds: {}, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] };

/* ------------------------------ 断言 ------------------------------ */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(name) { console.log('\n' + name); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================== 用例 ============================== */
(async () => {
  /* ---- T1: save() 仅对「本地真改动」的白名单字段打时间戳（不每次全打戳） ---- */
  group('T1  f14Stamp：仅本地真改动的字段才打时间戳');
  resetEnv();
  {
    const s = freshStore();
    // 不预置 OPENID → 本地模式（canSync 为 false），save 不触发上云，干净验证 _ts
    await s.initAccount();

    CLOCK = 1000;
    s.addUser({ nickname: '加一' });            // 首轮 save：_f14Shadow 为空 → 全字段打戳 1000
    const u0 = s.getRoot().users[0];
    const ts1 = JSON.parse(JSON.stringify(u0._ts));
    ok(ts1.farm === 1000 && ts1.profile === 1000 && ts1.learner === 1000,
      '首轮 save 对所有已有白名单字段打戳(=1000)', JSON.stringify(ts1));

    // 只改 farm.coins，推进时钟后再次 save
    CLOCK = 2000;
    u0.farm.coins = 500;
    s.save(s.get());
    const ts2 = s.getRoot().users[0]._ts;
    ok(ts2.farm === 2000, '改动字段 farm 时间戳推进到 2000', 'farm=' + ts2.farm);
    ok(ts2.profile === 1000, '未改动字段 profile 时间戳保持不变(1000)→证明非每次全打戳', 'profile=' + ts2.profile);
    ok(ts2.learner === 1000, '未改动字段 learner 同样保持 1000', 'learner=' + ts2.learner);
    ok(u0.farm.coins === 500, 'farm 内容确实被改(500)');
  }

  /* ---- T2: LWW 仲裁 —— 云端较新者赢、本地较新者留、且幂等 ---- */
  group('T2  f14MergeUser（经 reconcileWithCloud）：云端较新采纳 / 本地较新保留 + 幂等');
  resetEnv();
  {
    const local = makeUser('u_a', { _ts: { farm: 100, profile: 100 } });
    storage.set(NS_KEY, { version: 2, users: [local], currentUserId: 'u_a' });
    storage.set(OPENID_KEY, OPENID);
    const s = freshStore();
    await s.initAccount();

    const cloud = { users: [ makeUser('u_a', {
      farm: Object.assign({}, FARM_20),
      profile: { nickname: '加一', streak: 5, lastFullCheckinDate: '2026-09-16', equipped: {} },
      _ts: { farm: 200, profile: 50 }
    }) ] };
    const changed = s.reconcileWithCloud(cloud);
    const ua = s.getRoot().users.find(u => u.id === 'u_a');
    ok(changed === true, 'reconcile 报告有改动');
    ok(ua.farm.coins === 20, '云端 farm 较新(ts200>100)→采纳云端(farm=20)', 'coins=' + ua.farm.coins);
    ok(ua._ts.farm === 200, 'farm 时间戳带回云端值 200');
    ok(ua.profile.streak === 3, '本地 profile 较新(ts100>50)→保留本地(streak=3)', 'streak=' + ua.profile.streak);
    ok(ua._ts.profile === 100, 'profile 时间戳保留本地值 100');

    // 幂等：用相同云端再合一次，不应再产生改动（防重推抖动）
    const changed2 = s.reconcileWithCloud(cloud);
    ok(changed2 === false, '幂等：相同云端再次合并不再产生改动');
  }

  /* ---- T3: 向后兼容 —— 双方都无时间戳 → 维持本地优先（R4 契约不被破坏） ---- */
  group('T3  向后兼容：两端皆无 _ts → 维持原本地优先');
  resetEnv();
  {
    const local = makeUser('u_a');                 // _ts = {}（老数据形态）
    storage.set(NS_KEY, { version: 2, users: [local], currentUserId: 'u_a' });
    storage.set(OPENID_KEY, OPENID);
    const s = freshStore();
    await s.initAccount();

    // 云端同样无戳（_ts 缺失），但 farm/profile 内容不同
    const cloud = { users: [ makeUser('u_a', {
      farm: Object.assign({}, FARM_20),
      profile: { nickname: '加一', streak: 9, lastFullCheckinDate: '2026-09-16', equipped: {} }
    }) ] };
    const changed = s.reconcileWithCloud(cloud);
    const ua = s.getRoot().users.find(u => u.id === 'u_a');
    ok(changed === false, '无戳时云端不覆盖本地→报告无改动');
    ok(ua.farm.coins === 999, 'farm 保持本地(999)未被云端(20)覆盖', 'coins=' + ua.farm.coins);
    ok(ua.profile.streak === 3, 'profile 保持本地(streak=3)未被云端(9)覆盖', 'streak=' + ua.profile.streak);
  }

  /* ---- T4: 多设备并发编辑不同字段 → 互不丢失（F14 核心修复点） ---- */
  group('T4  多设备并发：A 改 farm / B 改 profile，两端编辑都保留（不再丢一次）');
  resetEnv();
  {
    // 本地（A 机）：farm 刚改过（ts=100），profile 旧（ts=100）
    const local = makeUser('u_a', { _ts: { farm: 100, profile: 100 } });
    storage.set(NS_KEY, { version: 2, users: [local], currentUserId: 'u_a' });
    storage.set(OPENID_KEY, OPENID);
    const s = freshStore();
    await s.initAccount();

    // 云端（B 机）：farm 更旧（ts=50，已被 A 覆盖），profile 更新（ts=200）
    const cloud = { users: [ makeUser('u_a', {
      farm: Object.assign({}, FARM_20),                 // B 机的旧 farm（coins=20）
      profile: { nickname: '加一', streak: 9, lastFullCheckinDate: '2026-09-16', equipped: {} }, // B 机新 profile
      _ts: { farm: 50, profile: 200 }
    }) ] };
    s.reconcileWithCloud(cloud);
    const ua = s.getRoot().users.find(u => u.id === 'u_a');
    ok(ua.farm.coins === 999, 'A 机的 farm 编辑保留(local ts100 > cloud ts50)', 'coins=' + ua.farm.coins);
    ok(ua.profile.streak === 9, 'B 机的 profile 编辑保留(cloud ts200 > local ts100)', 'streak=' + ua.profile.streak);
    ok(ua._ts.farm === 100 && ua._ts.profile === 200, '两端时间戳各自正确带回(无互相丢失)', JSON.stringify(ua._ts));
  }

  /* ------------------------------ 汇总 ------------------------------ */
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
  Date.now = REAL_NOW;
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n挂具异常:', e); Date.now = REAL_NOW; process.exit(2); });

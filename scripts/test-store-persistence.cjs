/**
 * test-store-persistence.cjs —— store.js 数据可靠性回归测试
 * ---------------------------------------------------------------------------
 * 覆盖 2026-09-18 数据持久化审计的 P0-1 / P0-2 / P0-3 / P0-4 修复项。
 * 纯 Node 运行（stub 掉 wx / getApp），不需要微信开发者工具：
 *     node scripts/test-store-persistence.cjs
 *
 * 设计要点：每个用例都重建 require 缓存 + 清空内存存储，保证互不污染。
 *
 * 反证（证明用例真能抓到原缺陷）：
 *     mkdir -p /tmp/oldutils
 *     for f in store util config; do git show HEAD:miniprogram/utils/$f.js > /tmp/oldutils/$f.js; done
 *     SRC_DIR=/tmp/oldutils node scripts/test-store-persistence.cjs     # 期望多条 ✗
 */
const path = require('path');

const SRC_DIR = process.env.SRC_DIR
  ? path.resolve(process.env.SRC_DIR)
  : path.resolve(__dirname, '../miniprogram/utils');
const STORE_PATH = path.join(SRC_DIR, 'store.js');
const BASE_KEY = 'wb_hwfarm_data_v2';
const OPENID_KEY = 'wb_hwfarm_openid';

const OPENID = 'o_test_1';
const NS_KEY = BASE_KEY + '_' + OPENID;

/* ------------------------------ 测试挂具 ------------------------------ */
let storage;
let uploaded;
let uploadBases;      // 每次 upload 携带的 base（F10：断言 CAS 基线是否被正确记住 / 推进）
let calls;
let behavior;
let serverVersion;    // 假服务端的「云端 updatedAt」版本

/* 定时器登记表：每个用例结束时清掉前一个用例遗留的防抖 / 重试定时器。
   不这么做时，前面用例 set 的 2 秒防抖会在后面的用例里触发，
   把数据推进后面用例的 uploaded 数组 —— 变成挂具噪声而非产品问题。 */
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
  uploaded = [];
  uploadBases = [];
  calls = [];
  serverVersion = 1000;
  behavior = {
    whoami: 'ok',          // ok | fail
    download: 'empty',     // empty | ok | fail
    downloadData: null,
    downloadUpdatedAt: 0,
    upload: 'ok',          // ok | fail
    conflictTimes: 0,      // 连续返回几次 conflict（模拟另一台设备先写过云端）
    conflictData: null     // conflict 响应带回的云端最新 _root（null = 体积超限被截断）
  };
  behavior.uploadDelay = 0;

  global.wx = {
    getStorageSync(k) {
      return storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : '';
    },
    setStorageSync(k, v) { storage.set(k, JSON.parse(JSON.stringify(v))); },
    removeStorageSync(k) { storage.delete(k); },
    // ⚠️ 缺这个桩会让 store.js initAccount 的「命名空间归并」整块抛异常
    //    （TypeError: wx.getStorageInfoSync is not a function），
    //    连带 3 条断言长期误报红：降级标记 / flushSync 补推 / 脏标记清除。
    //    这是**测试台缺口**，不是产品缺陷 —— wx.getStorageInfoSync 是真实存在的微信 API。
    getStorageInfoSync() { return { keys: Array.from(storage.keys()), currentSize: 0, limitSize: 10240 }; },
    cloud: {
      callFunction({ name, data }) {
        const action = data && data.action;
        calls.push(action);
        if (action === 'whoami') {
          if (behavior.whoami === 'fail') return Promise.reject(new Error('whoami timeout'));
          return Promise.resolve({ result: { ok: true, openid: OPENID } });
        }
        if (action === 'download') {
          if (behavior.download === 'fail') return Promise.reject(new Error('download failed'));
          return Promise.resolve({
            result: { ok: true, data: behavior.downloadData, cloudUpdatedAt: behavior.downloadUpdatedAt }
          });
        }
        if (action === 'upload') {
          uploadBases.push(data.base);
          const finish = () => {
            if (behavior.upload === 'fail') return { result: { ok: false, msg: '云端拒绝' } };
            if (behavior.conflictTimes > 0) {
              // F10：模拟「另一台设备在上次同步之后写过云端」→ 服务端拒绝并在库里推出新版本
              behavior.conflictTimes--;
              serverVersion += 500;
              return { result: {
                ok: false, code: 'conflict',
                msg: '云端数据已被其它设备更新',
                cloudUpdatedAt: serverVersion,
                data: behavior.conflictData,
                truncated: !behavior.conflictData
              } };
            }
            serverVersion += 1000;
            uploaded.push(JSON.parse(JSON.stringify(data.payload)));
            return { result: { ok: true, cloudUpdatedAt: serverVersion } };
          };
          return behavior.uploadDelay
            ? new Promise(r => setTimeout(() => r(finish()), behavior.uploadDelay))
            : Promise.resolve(finish());
        }
        return Promise.resolve({ result: { ok: true } });
      }
    }
  };
  global.getApp = () => ({ globalData: {} });
  delete require.cache[require.resolve(STORE_PATH)];
}

function freshStore() {
  const s = require(STORE_PATH);
  s.setCloudReady(true);
  return s;
}

/**
 * 声明「本用例的前提是：用户此前已主动绑定过微信」—— 即 OPENID_KEY 里有缓存的 openid。
 *
 * ⚠️ 为什么必须显式声明（2026-09-28 修）：
 *   2026-09-22 登录策略调整后，initAccount() **不再自动登录微信**，只在「已缓存 openid」
 *   （用户此前绑定过）时才调 whoami 确认身份；首启未绑定一律走「本地模式」。
 *   而 store 的 canSync() = cloudReady && _openid && !_cloudBlocked。
 *   于是不声明这一步时 _openid 恒为空 → 一次云调用都不发（连 whoami 都不调），
 *   「上传 / CAS 基线 / 命名空间隔离」类断言会全部假红 —— 表现为
 *   「flushSync 补推不上」「base=undefined」这种看不出病因的失败。
 *   本挂具函数让这个前提在用例里**可见**，而不是靠隐式全局状态。
 *
 * 需要测「本地模式 / 未绑定」的用例（T1b / T2 / T7）**不要**调它。
 */
function bindCached() {
  storage.set(OPENID_KEY, OPENID);
}

/** 造一个「真实孩子」切片（有 homework 完成记录，能通过 hasRealActivity） */
function realChild(id, patch) {
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
    homework: { '2026-09-16': { chinese: { done: true }, math: { done: false }, english: { done: false } } },
    checkinTypes: [],
    schedule: null,
    plans: {},
    learn: { stars: 5 },
    comments: [],
    farm: { coins: 999, suns: 7, seeds: {}, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] }
  }, patch || {});
}

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
  /* ---- T1: whoami 失败 → 仍必须本地落盘（旧实现在这里全丢） ---- */
  group('T1  whoami 失败时仍本地落盘 + 提示降级');
  resetEnv();
  behavior.whoami = 'fail';
  {
    /* ⚠️ 场景前提（2026-09-22 登录策略调整后必须显式种下）：
       initAccount 只在**已缓存 openid**（用户此前主动绑定过）时才向服务端确认身份；
       首启未绑定默认走「本地模式」，不调 whoami、也不算降级（那条路径见 T1b）。
       本用例测的是「已绑定用户这次 whoami 失败」，所以必须预置 OPENID_KEY。 */
    const s = freshStore();
    storage.set(OPENID_KEY, OPENID);
    await s.initAccount();
    s.addUser({ nickname: '测试娃', grade: '一年级' });
    /* 已绑定时 storageKey() = 账号命名空间。whomai 失败只影响「能不能上云」，
       不影响「写到哪个命名空间」—— 身份是从缓存里知道的，不该退回兜底 key。 */
    const raw = storage.get(NS_KEY);
    ok(!!raw, '数据落到账号命名空间（身份确认失败也不丢盘）');
    ok(!!raw && raw.users.length === 1 && raw.users[0].nickname === '测试娃', '孩子资料已落盘', JSON.stringify(raw && raw.users.map(u => u.nickname)));
    ok(s.getSyncState().degraded === true, '标记为降级（app.js 会弹「数据已存本机」提示）');
    ok(s.isOnboarded() === true, 'isOnboarded() 正确为 true');
  }

  /* ---- T1b: 首启未绑定（本地模式）→ 不调 whoami、不算降级、不上云 ---- */
  group('T1b 首启未绑定 = 本地模式（2026-09-22 策略），不得误报「同步异常」');
  resetEnv();
  {
    const s = freshStore();                 // 不种 OPENID_KEY
    await s.initAccount();
    ok(calls.indexOf('whoami') < 0, '未绑定时不自动登录微信（不调 whoami）', 'calls=' + calls.join(','));
    ok(s.getSyncState().degraded === false, '未绑定不算降级（否则会误弹「网络异常」告警）');
    ok(s.getOpenid() === '', 'openid 保持为空');
    s.addUser({ nickname: '测试娃' });
    await sleep(60);
    ok(uploaded.length === 0, '本地模式不上云（canSync 由 openid 拦截）', 'uploaded=' + uploaded.length);
    const raw = storage.get(BASE_KEY);
    ok(!!raw && raw.users.length === 1, '数据落到兜底 key，本地照常可用');
  }

  /* ---- T2: 未启用的占位切片不得产生云端档案 ---- */
  group('T2  占位切片不落云端（避免幽灵档案污染结算与看板）');
  resetEnv();
  {
    const s = freshStore();
    await s.initAccount();
    s.save(s.get());
    await sleep(60);
    ok(uploaded.length === 0, 'cloudUpload 未被触发', 'uploaded=' + uploaded.length);
    ok(s.isOnboarded() === false, '占位态 isOnboarded() 为 false（登录门不再恒真）');
  }

  /* ---- T3: 上传失败 → 脏标记 → 恢复后补推 ---- */
  group('T3  上传失败不再「永久放弃」');
  resetEnv();
  {
    behavior.upload = 'fail';
    const s = freshStore();
    storage.set(OPENID_KEY, OPENID);   // 「已绑定」（同上：不种则走本地模式，canSync 恒 false，本用例无从检验）
    await s.initAccount();
    s.addUser({ nickname: '测试娃' });
    await sleep(60);
    ok(s.isDirty() === true, '上传失败留下脏标记');

    behavior.upload = 'ok';
    s.flushSync(true);
    await sleep(30);
    ok(uploaded.length === 1, '恢复后 flushSync 补推成功成功的 1 次', 'uploaded=' + uploaded.length);
    ok(s.isDirty() === false, '补推成功后脏标记清除');
    // ⚠️ 必须防空：uploaded 为空时 uploaded[0] 会抛 TypeError，
    //    把「一条断言失败」升级成「整个文件中断」，后面的用例全跑不到（曾经如此）
    ok(!!uploaded[0] && uploaded[0].users[0].nickname === '测试娃', '推送的是本地最新数据');
  }

  /* ---- T4: 2 秒防抖窗口内切后台 → onHide flush 兜住 ---- */
  group('T4  防抖窗口内切后台仍能上云');
  resetEnv();
  {
    const s = freshStore();
    bindCached();
    await s.initAccount();
    s.addUser({ nickname: '测试娃' });
    ok(uploaded.length === 0, 'addUser 后 2 秒防抖期内确实还没上云');
    s.flushSync(true);            // ← app.onHide 的动作
    await sleep(30);
    ok(uploaded.length === 1, 'onHide 触发 flushSync 后立刻上云');
  }

  /* ---- T5: mergeRemote 不再整片覆盖本地（旧实现的核心 bug） ---- */
  group('T5  云端「更新」不再覆盖本地未上云的改动');
  resetEnv();
  {
    const local = realChild('u_a', {
      farm: { coins: 999, suns: 7, seeds: {}, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] },
      comments: [{ id: 'cm1', text: '本地评语' }]
    });
    storage.set(NS_KEY, { version: 2, users: [local], currentUserId: 'u_a' });
    storage.set(OPENID_KEY, OPENID);

    // 云端是「更旧」的一份快照，但 lastActiveDate 被 dailyReset 推进到今天
    const cloud = realChild('u_a', {
      lastActiveDate: '2026-09-18',
      settledDates: ['2026-09-15', '2026-09-16', '2026-09-17'],
      farm: { coins: 20, suns: 1, seeds: {}, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] },
      comments: []
    });
    behavior.download = 'ok';
    behavior.downloadData = { version: 2, users: [cloud], currentUserId: 'u_a' };

    const s = freshStore();
    await s.initAccount();
    const u = s.get();
    ok(u.farm.coins === 999, '本地农场金币未被云端旧快照抹掉', 'actual=' + u.farm.coins);
    ok((u.comments || []).length === 1, '本地评语记录未被抹掉');
    ok(JSON.stringify(u.settledDates) === JSON.stringify(['2026-09-15']),
      'settledDates 未被云端并集污染（否则本地惩罚会蒸发）', JSON.stringify(u.settledDates));
    ok(u.lastActiveDate === '2026-09-16', 'lastActiveDate 保持本地基准（漏结算由 runDailyRollover 补算）');
  }

  /* ---- T6: mergeRemote 仍要能补进「云端独有的孩子」 ---- */
  group('T6  换设备场景：云端独有的孩子要补进来');
  resetEnv();
  {
    const localChild = realChild('u_a');
    storage.set(NS_KEY, { version: 2, users: [localChild], currentUserId: 'u_a' });
    storage.set(OPENID_KEY, OPENID);
    const cloudOnly = realChild('u_b', { nickname: '弟弟' });
    behavior.download = 'ok';
    behavior.downloadData = { version: 2, users: [realChild('u_a'), cloudOnly], currentUserId: 'u_b' };

    const s = freshStore();
    await s.initAccount();
    const ids = s.getRoot().users.map(u => u.id).sort();
    ok(JSON.stringify(ids) === JSON.stringify(['u_a', 'u_b']), '两个孩子的都在', JSON.stringify(ids));
    ok(s.getRoot().users.find(u => u.id === 'u_a').farm.coins === 999, '本地已有的孩子未被覆盖');
    ok(s.getRoot().users.find(u => u.id === 'u_b').nickname === '弟弟', '云端独有孩子已并入');
  }

  /* ---- T7: 建首个孩子时清掉未启用的占位切片 ---- */
  group('T7  占位切片不残留在孩子列表');
  resetEnv();
  {
    const s = freshStore();
    await s.initAccount();
    ok(s.getRoot().users.length === 1 && s.getRoot().users[0].__placeholder === true, '起始只有一个占位切片');
    s.addUser({ nickname: '加一' });
    ok(s.getRoot().users.length === 1, '建孩子后不残留占位切片', 'len=' + s.getRoot().users.length);
    ok(s.getRoot().users[0].id !== 'guest', '剩下的那个是真实孩子', s.getRoot().users[0].id);
  }

  /* ---- T8: 老版本遗留的 guest 用户数据必须保留（迁移安全） ---- */
  group('T8  老数据兼容：已落盘的 guest 用户不清除');
  resetEnv();
  {
    const legacyGuest = realChild('guest', { nickname: '小小农场主', grade: '', farm: { coins: 88, suns: 2, seeds: {}, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] } });
    legacyGuest.__placeholder = undefined;   // 老版本没有这个标记
    storage.set(NS_KEY, { version: 2, users: [legacyGuest], currentUserId: 'guest' });
    storage.set(OPENID_KEY, OPENID);

    const s = freshStore();
    await s.initAccount();
    ok(s.getRoot().users.length === 1 && s.getRoot().users[0].id === 'guest', '老 guest 用户未被清掉');
    ok(s.get().farm.coins === 88, '老 guest 用户的真实数据完好');
    ok(s.isOnboarded() === true, '老 guest 用户仍被视为已建档（不会被打回建档页）');
    s.addUser({ nickname: '老二' });
    ok(s.getRoot().users.length === 2, '新增孩子不会误删老数据', 'len=' + s.getRoot().users.length);
  }

  /* ---- T9: 云端下载失败 → 阻断上云但保留本地保存 ---- */
  group('T9  云端下载失败：只阻断上云，不阻断本地保存');
  resetEnv();
  {
    behavior.download = 'fail';
    const s = freshStore();
    bindCached();
    await s.initAccount();
    const st = s.getSyncState();
    ok(st.blocked === true, '置为云端保护期（防止本地空态覆盖云端）');
    ok(s.getOpenid() === OPENID, 'openid 仍然保留（旧实现会清空它导致连本地都不落盘）');
    s.addUser({ nickname: '测试娃' });
    const raw = storage.get(NS_KEY);
    ok(!!raw && raw.users.length === 1, '保护期内依然正常落盘到账号命名空间');
    s.save(s.get());
    await sleep(60);
    ok(uploaded.length === 0, '保护期内不上云');
  }

  /* ---- T10: P0-1 端到端 —— 本地模式（未绑定）期积压的改动，绑定微信后必须补推 ---- */
  group('T10 绑定微信后把兜底 key 的积压改动补上云');
  resetEnv();
  {
    /* ⚠️ 2026-09-22 起「身份恢复」的入口是用户在「我的 → 去绑定」触发的 bindWechat()，
       不再是下一次 initAccount 自动 whoami。本用例随之改写，覆盖的目标不变：
       本地模式期产生的改动不能因为换了命名空间就丢。 */
    const s = freshStore();
    await s.initAccount();                     // 未绑定 → 本地模式
    ok(s.getOpenid() === '', '前提：处于本地模式（openid 为空）');
    s.addUser({ nickname: '离线期娃' });
    await sleep(60);
    ok(!!storage.get(BASE_KEY), '离线期数据在兜底 key');
    ok(s.isDirty() === true, '离线期留下脏标记');
    ok(uploaded.length === 0, '离线期确实没上云');

    // 用户点「去绑定」→ whoami 成功 → 数据迁进账号命名空间
    const r = await s.bindWechat();
    ok(r && r.ok === true, '绑定成功', JSON.stringify(r));
    ok(s.getOpenid() === OPENID, 'openid 已就位');
    ok(!!storage.get(NS_KEY), '兜底 key 数据已迁进账号命名空间');
    ok(!storage.get(BASE_KEY), '兜底 key 已清空，不会重复迁移');
    ok(!!storage.get(NS_KEY).users.find(u => u.nickname === '离线期娃'), '迁过去的是离线期那份数据');

    s.flushSync(true);                         // app.onShow / onHide 的动作
    await sleep(40);
    ok(uploaded.length === 1, '积压改动被补推上云', 'uploaded=' + uploaded.length);
    ok(!!uploaded[0] && uploaded[0].users[0].nickname === '离线期娃', '补推的是离线期产生的那份数据');
  }

  /* ---- T11: 上传在途时又有改动 → 成功后不得误清脏标记（防丢改动） ---- */
  group('T11 上传在途期间的新改动不会被误判为「已同步」');
  resetEnv();
  {
    const s = freshStore();
    bindCached();
    await s.initAccount();
    const id = s.addUser({ nickname: 'A' });

    behavior.uploadDelay = 120;      // 让第一次上传变慢，制造在途窗口
    s.flushSync(true);               // 第一次上传开始（rev=1）
    await sleep(20);
    s.updateUser(id, { nickname: 'B' });   // 在途期间产生新改动（rev=2）
    ok(uploaded.length === 0, '第一次上传仍在途中');

    await sleep(150);                // 第一次返回 ok，但 rev 已变化 → 不应清脏
    ok(s.isDirty() === true, '在途期间有新改动时保持脏标记');

    await sleep(2100);               // 等重新排的防抖把第二次推送发出去
    ok(uploaded.length === 2, '自动补推了第二次', 'uploaded=' + uploaded.length);
    ok(uploaded[1] && uploaded[1].users[0].nickname === 'B', '第二次推的是最新数据（B）');
    ok(s.isDirty() === false, '全部同步完成后才清脏');
  }

  /* ---- T12: F8 微信昵称/头像必须进 _root（随镜像上云、按 openid 隔离） ---- */
  group('T12 F8 微信资料入 _root 并随整份镜像上云');
  resetEnv();
  {
    const s = freshStore();
    bindCached();
    await s.initAccount();
    s.addUser({ nickname: '加一', grade: '一年级' });

    s.setWxProfile({ nickname: '小依妈妈', avatarUrl: 'https://x/a.png' });
    const root = storage.get(NS_KEY);
    ok(!!root && !!root.wxProfile, 'wxProfile 落在 root 级（不再单开独立 key）', JSON.stringify(root && root.wxProfile));
    ok(!!root && root.wxProfile.nickname === '小依妈妈', '昵称已写入 root.wxProfile');
    ok(!storage.has('wb_hwfarm_wxprofile'), '不再写旧的独立 key');

    await sleep(2100);
    const last = uploaded[uploaded.length - 1] || {};
    ok(!!last.wxProfile && last.wxProfile.avatarUrl === 'https://x/a.png',
      '随整份镜像上云（旧实现只存本地 → 换手机即丢）', JSON.stringify(last.wxProfile));

    // 单项更新不覆盖另一项
    s.setWxProfile({ avatarUrl: 'https://x/b.png' });
    const p = s.getWxProfile();
    ok(p.nickname === '小依妈妈' && p.avatarUrl === 'https://x/b.png', '单项更新保留另一项', JSON.stringify(p));
  }

  /* ---- T13: F8 旧独立 key 一次性迁移进 root ---- */
  group('T13 F8 旧版 wb_hwfarm_wxprofile 自动迁移进 root');
  resetEnv();
  {
    storage.set('wb_hwfarm_wxprofile', { nickname: '旧昵称', avatarUrl: 'https://old/a.png' });
    const s = freshStore();
    bindCached();
    await s.initAccount();
    const p = s.getWxProfile();
    ok(p.nickname === '旧昵称' && p.avatarUrl === 'https://old/a.png', '读到旧 key 的内容', JSON.stringify(p));
    const root = storage.get(NS_KEY);
    ok(!!root && !!root.wxProfile && root.wxProfile.nickname === '旧昵称', '已搬进 root.wxProfile');
    ok(!storage.has('wb_hwfarm_wxprofile'), '旧 key 已删除（只迁移一次）');
    ok(s.isDirty() === true, '已置脏标记（保证随下一次上云带走）');
  }

  /* ---- T14: F8/R5 未建档时微信资料不产生云端幽灵档案 ---- */
  group('T14 F8 未建档（仅占位切片）时不产生云端档案');
  resetEnv();
  {
    const s = freshStore();
    bindCached();
    await s.initAccount();
    s.setWxProfile({ nickname: '还没建娃' });
    await sleep(2100);
    ok(uploaded.length === 0, '占位根不上云（R5 仍然成立）', 'uploaded=' + uploaded.length);
    ok(s.isOnboarded() === false, '仍未建档');
    // 建档后随下一次 save 一起上云
    s.addUser({ nickname: '加一' });
    await sleep(2100);
    const last = uploaded[uploaded.length - 1] || {};
    ok(!!last.wxProfile && last.wxProfile.nickname === '还没建娃', '建档后微信资料一并上云', JSON.stringify(last.wxProfile));
  }

  /* ---- T15: F10 CAS 基线自举并跨次保留 ---- */
  group('T15 F10 上传携带 base，且清脏不清基线');
  resetEnv();
  {
    const s = freshStore();
    bindCached();
    await s.initAccount();
    s.addUser({ nickname: '加一' });
    s.flushSync(true);
    await sleep(40);
    ok(uploadBases[0] === 0, '首次上传 base=0（还没有云端版本认知）', 'base=' + uploadBases[0]);
    ok(s.getSyncState().cloudUpdatedAt === 2000, '成功后记住服务端回传的云端版本', 'v=' + s.getSyncState().cloudUpdatedAt);

    s.save(s.get());
    s.flushSync(true);
    await sleep(40);
    ok(uploadBases[1] === 2000, '第二次上传带上刚记下的基线（清脏不得把基线一起抹掉）', 'bases=' + JSON.stringify(uploadBases));
    ok(s.getSyncState().cloudUpdatedAt === 3000, '基线继续推进（自举完成，从此进入 CAS 模式）');
    ok(s.isDirty() === false, '同步完成后不脏');
  }

  /* ---- T16: F10 冲突 → 加法式调和 + 采纳新基线 + 有上限重推 ---- */
  group('T16 F10 云端被别的设备改过 → 调和后重推，本地不被覆盖');
  resetEnv();
  {
    const local = realChild('u_a');
    local.homework = { '2026-09-18': { chinese: { done: true, minutes: 10, doneAt: 5 }, math: { done: false, minutes: 0, doneAt: 0 } } };
    local.learn = { stars: 5 };
    storage.set(NS_KEY, { version: 2, users: [local], currentUserId: 'u_a' });
    storage.set(OPENID_KEY, OPENID);

    // 另一台设备：把数学勾上了、金币改了、还多了一个孩子
    const cloudA = realChild('u_a', {
      farm: { coins: 20, suns: 1, seeds: {}, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] },
      settledDates: ['2026-09-15', '2026-09-17'],
      learn: { stars: 99 }
    });
    cloudA.homework = { '2026-09-18': { chinese: { done: false, minutes: 30, doneAt: 0 }, math: { done: true, minutes: 20, doneAt: 9 } } };
    const cloudB = realChild('u_b', { nickname: '弟弟' });
    behavior.conflictTimes = 1;
    behavior.conflictData = { version: 2, users: [cloudA, cloudB], currentUserId: 'u_a' };

    const s = freshStore();
    await s.initAccount();
    await sleep(10);
    s.save(s.get());
    s.flushSync(true);
    await sleep(60);

    ok(s.getSyncState().conflicts === 1, '冲突被记进同步状态（不再静默）', 'conflicts=' + s.getSyncState().conflicts);
    const ua = s.getRoot().users.find(u => u.id === 'u_a');
    const ub = s.getRoot().users.find(u => u.id === 'u_b');
    ok(!!ub, '云端独有的孩子已并入');
    ok(ua.homework['2026-09-18'].chinese.done === true, '本地已做的语文保留');
    ok(ua.homework['2026-09-18'].math.done === true, '云端已做的数学并集进来（否则会白罚一次）');
    ok(ua.homework['2026-09-18'].math.minutes === 20, 'minutes 取较大值');
    ok(ua.homework['2026-09-18'].chinese.minutes === 30, 'minutes 取较大值（云端更大）');
    ok(ua.farm.coins === 999, '本地农场金币不被云端快照覆盖（非单调量不做合并）', 'coins=' + ua.farm.coins);
    ok(ua.learn.stars === 5, '本地其它字段同样以本地为准');
    ok(JSON.stringify(ua.settledDates) === JSON.stringify(['2026-09-15']), 'settledDates 刻意不并集', JSON.stringify(ua.settledDates));

    await sleep(1400);            // 等自动重推（handleConflict 内的 1.2s 退避）
    ok(uploaded.length === 1, '调和后自动重推成功 1 次', 'uploaded=' + uploaded.length);
    ok(uploadBases[1] === 1500, '重推带的是**采纳后的新基线**（不采纳就会无限冲突）', 'bases=' + JSON.stringify(uploadBases));
    ok(s.isDirty() === false, '冲突最终收敛为已同步');
  }

  /* ---- T17: F10 冲突未带回数据（体积超限）→ 仍收敛 ---- */
  group('T17 F10 冲突响应被截断时不卡死（只采纳基线并重推）');
  resetEnv();
  {
    const local = realChild('u_a');
    storage.set(NS_KEY, { version: 2, users: [local], currentUserId: 'u_a' });
    storage.set(OPENID_KEY, OPENID);
    behavior.conflictTimes = 1;
    behavior.conflictData = null;         // truncated

    const s = freshStore();
    await s.initAccount();
    s.save(s.get());
    s.flushSync(true);
    await sleep(60);
    ok(s.getSyncState().conflicts === 1, '冲突被记录');
    ok(s.getSyncState().cloudUpdatedAt === 1500, '即使没带回数据也采纳了云端版本');
    await sleep(1400);
    ok(uploaded.length === 1, '仍然完成重推', 'uploaded=' + uploaded.length);
    ok(s.getSyncState().conflicts === 1, '重推成功没有产生新的冲突记录');
  }

  /* ---- T18: F10 reconcileWithCloud 的逐字段取舍语义 ---- */
  group('T18 F10 reconcileWithCloud 只做加法，非单调量一律保持本地');
  resetEnv();
  {
    const local = realChild('u_a');
    local.homework = { '2026-09-18': { chinese: { done: true, minutes: 10, doneAt: 5 }, math: { done: false } } };
    storage.set(NS_KEY, { version: 2, users: [local], currentUserId: 'u_a' });
    const s = freshStore();
    await s.initAccount();                              // 必须先确认 openid，否则读的是兜底 key 不是账号命名空间
    ok(s.getRoot().users[0].id === 'u_a', '前置条件：本地读到的确实是种下的那个孩子');

    const cloud = {
      users: [
        { id: 'u_a',
          homework: { '2026-09-18': { chinese: { done: false, minutes: 3, doneAt: 0 }, math: { done: true, minutes: 8, doneAt: 9 } },
                      '2026-09-17': { chinese: { done: true, minutes: 1, doneAt: 1 } } },
          farm: { coins: 1 }, settledDates: ['2026-09-17'] },
        { id: 'u_c', nickname: '新娃' }
      ]
    };
    const changed = s.reconcileWithCloud(cloud);
    const ua = s.getRoot().users.find(u => u.id === 'u_a');
    ok(changed === true, '返回「有改动」');
    ok(ua.homework['2026-09-18'].chinese.done === true, '已做的不会被云端 false 反写');
    ok(ua.homework['2026-09-18'].chinese.minutes === 10, '本地 minutes 更大 → 保持 10');
    ok(ua.homework['2026-09-18'].math.done === true, '云端已做的并集进来');
    ok(ua.homework['2026-09-18'].math.minutes === 8, '本地缺失的 minutes 补上云端值');
    ok(!!ua.homework['2026-09-17'], '本地缺失的那一天整日并入');
    ok(ua.farm.coins === 999, 'farm 保持本地（金币可涨可跌，不做合并）');
    ok(JSON.stringify(ua.settledDates) === JSON.stringify(['2026-09-15']), 'settledDates 保持本地');
    ok(!!s.getRoot().users.find(u => u.id === 'u_c'), '云端独有的孩子已追加');
    ok(s.reconcileWithCloud({ users: [cloud.users[0]] }) === false, '无新增时返回 false（不无谓落盘/重推）');
  }

  /* ------------------------------ 汇总 ------------------------------ */
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n挂具异常:', e); process.exit(2); });

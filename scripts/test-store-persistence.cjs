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
let calls;
let behavior;

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
  calls = [];
  behavior = {
    whoami: 'ok',          // ok | fail
    download: 'empty',     // empty | ok | fail
    downloadData: null,
    upload: 'ok'           // ok | fail
  };
  behavior.uploadDelay = 0;

  global.wx = {
    getStorageSync(k) {
      return storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : '';
    },
    setStorageSync(k, v) { storage.set(k, JSON.parse(JSON.stringify(v))); },
    removeStorageSync(k) { storage.delete(k); },
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
          return Promise.resolve({ result: { ok: true, data: behavior.downloadData } });
        }
        if (action === 'upload') {
          const finish = () => {
            if (behavior.upload === 'fail') return { result: { ok: false, msg: '云端拒绝' } };
            uploaded.push(JSON.parse(JSON.stringify(data.payload)));
            return { result: { ok: true } };
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
    const s = freshStore();
    await s.initAccount();
    s.addUser({ nickname: '测试娃', grade: '一年级' });
    const raw = storage.get(BASE_KEY);
    ok(!!raw, '数据落到兜底 key（未确认 openid 时不丢）');
    ok(!!raw && raw.users.length === 1 && raw.users[0].nickname === '测试娃', '孩子资料已落盘', JSON.stringify(raw && raw.users.map(u => u.nickname)));
    ok(s.getSyncState().degraded === true, '标记为降级（app.js 会弹「数据已存本机」提示）');
    ok(s.isOnboarded() === true, 'isOnboarded() 正确为 true');
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
    await s.initAccount();
    s.addUser({ nickname: '测试娃' });
    await sleep(60);
    ok(s.isDirty() === true, '上传失败留下脏标记');

    behavior.upload = 'ok';
    s.flushSync(true);
    await sleep(30);
    ok(uploaded.length === 1, '恢复后 flushSync 补推成功成功的 1 次', 'uploaded=' + uploaded.length);
    ok(s.isDirty() === false, '补推成功后脏标记清除');
    ok(uploaded[0].users[0].nickname === '测试娃', '推送的是本地最新数据');
  }

  /* ---- T4: 2 秒防抖窗口内切后台 → onHide flush 兜住 ---- */
  group('T4  防抖窗口内切后台仍能上云');
  resetEnv();
  {
    const s = freshStore();
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

  /* ---- T10: P0-1 端到端 —— whoami 失败期积压的改动，身份恢复后必须补推 ---- */
  group('T10 whoami 恢复后把兜底 key 的积压改动补上云');
  resetEnv();
  {
    behavior.whoami = 'fail';
    const s = freshStore();
    await s.initAccount();
    s.addUser({ nickname: '离线期娃' });
    await sleep(60);
    ok(!!storage.get(BASE_KEY), '离线期数据在兜底 key');
    ok(s.isDirty() === true, '离线期留下脏标记');
    ok(uploaded.length === 0, '离线期确实没上云');

    // 下一次启动：身份恢复正常
    behavior.whoami = 'ok';
    await s.initAccount();
    ok(!!storage.get(NS_KEY), '兜底 key 数据已迁移进账号命名空间');
    ok(!storage.get(BASE_KEY), '兜底 key 已清空，不会重复迁移');
    await sleep(30);
    ok(uploaded.length === 1, '积压改动被补推上云（脏标记也随身份一并迁移）', 'uploaded=' + uploaded.length);
    ok(!!uploaded[0] && uploaded[0].users[0].nickname === '离线期娃', '补推的是离线期产生的那份数据');
  }

  /* ---- T11: 上传在途时又有改动 → 成功后不得误清脏标记（防丢改动） ---- */
  group('T11 上传在途期间的新改动不会被误判为「已同步」');
  resetEnv();
  {
    const s = freshStore();
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

  /* ------------------------------ 汇总 ------------------------------ */
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n挂具异常:', e); process.exit(2); });

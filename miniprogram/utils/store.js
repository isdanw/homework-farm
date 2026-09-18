/**
 * ============================================================================
 *  store.js —— 统一数据层（多用户版）
 *  ---------------------------------------------------------------------------
 *  【核心联动点 ③：数据互通】
 *  每个孩子（用户）拥有「独立」的一份数据：打卡 homework + 农场 farm + 连续打卡
 *  profile，全部保存在各自的用户切片里。所有页面调用 save() 后通过 emit('change')
 *  事件总线广播，其它已打开的页面会立刻拿到「当前孩子」的最新数据。
 *
 *  存储结构（v2）：
 *  {
 *    version: 2,
 *    users: [            // 所有孩子
 *      {
 *        id, nickname, avatar, grade, createdAt,
 *        lastActiveDate, settledDates,
 *        profile, homework, plans, learn, farm
 *      }, ...
 *    ],
 *    currentUserId: 'u_xxx',
 *    coop: { plants: [] },            // 家庭合种（root 级共享，不属于某个孩子）
 *    wxProfile: { nickname, avatarUrl } // 微信昵称/头像（root 级共享，随整份镜像上云）
 *  }
 *
 *  store.get() 永远返回「当前孩子」的切片；引擎（farmEngine）全部基于这个切片工作，
 *  因此无需改动引擎代码即可天然支持多用户隔离。
 *
 *  存储策略：
 *    1) 本地 wx.setStorageSync 主存（离线可用、秒开）
 *    2) 本地存储按「微信 openid」命名空间隔离（wb_hwfarm_data_v2_<openid>），
 *       同一台手机切换不同微信号也不会串数据
 *    3) 若开通了云开发，则异步写入云数据库集合 hw_farm_user（按 openid 一人一条，
 *       服务端用 cloud.getWXContext().OPENID 隔离，天然「跟微信绑定」）
 *
 *  【数据可靠性契约·2026-09-18 定案，改本文件前必读】
 *    R1 本地落盘与上云必须解耦：save() **永远**先落盘；上云是「尽力而为 + 可补偿」的第二步。
 *       任何情况下都不得因为「拿不到身份 / 云不可用」而放弃本地落盘。
 *    R2 上云不可静默放弃：失败写脏标记（wb_hwfarm_sync_tag_<openid>）并按 1s/4s/15s/60s
 *       退避重试；save() / 启动 / 切前台 / 切后台都会再试。
 *    R3 下拉（云端→本地）只允许「补缺」，禁止整片替换本地切片、禁止跨副本合并 settledDates。
 *       本地是本机权威；云端是留档与换机恢复。
 *    R4 字段只增不改不删：新增字段必须同步写进 defaultData()，由 ensureUserFields 补默认值。
 *       上云走整份镜像（syncData 不做字段白名单），所以加字段天然向后兼容。
 *    R5 占位 / 演示数据必须打标记（__placeholder）并隔离，永不落盘、永不上云。
 *    R6 禁止用日期串、布尔量当「新旧判据」，只用毫秒时间戳或显式脏标记。
 *    R7 共享数据一律挂 root（users 之外的字段），禁止另开「与 openid 解耦的独立 storage key」。
 *       独立 key 既不随整份镜像上云（换手机即丢），也不按 openid 隔离（同机多账号串味）。
 *       root 级内容天然随镜像上云 —— coop 与 wxProfile 都按这条走。
 *
 *  【微信绑定】数据已经跟微信账号绑定：服务端按 openid 一人一条；客户端在启动时
 *  通过 syncData(whoami) 拿到自己的 openid，缓存并用于本地命名空间隔离，同时在
 *  「我的」页展示「已绑定微信」。换手机 / 重装后登录同一微信号会自动从云端恢复。
 * ============================================================================
 */
const util = require('./util.js');
const CFG = require('./config.js');

const BASE_KEY = 'wb_hwfarm_data_v2';      // 未拿到 openid 前的兜底存储 key（也用于首启迁移）
const OPENID_KEY = 'wb_hwfarm_openid';     // 缓存上一次使用的 openid（无云时瞬时判断账号）
const OLD_KEY = 'wb_hwfarm_data_v1';       // 旧版单用户数据，首次启动自动迁移
const STORAGE_KEY = BASE_KEY;              // 兼容导出（实际读写走 storageKey()）
const WXPROFILE_KEY = 'wb_hwfarm_wxprofile'; // 【遗留·只读】旧版独立的微信昵称头像存储，仅用于一次性迁移
const SYNCTAG_KEY = 'wb_hwfarm_sync_tag';  // 上云状态：脏标记 + 重试计数（按 openid 隔离）
const PLACEHOLDER_ID = 'guest';            // 尚未创建孩子时的内存占位切片 id（只活在内存里）

/* --------------------------- 默认（单个孩子）数据 --------------------------- */
function defaultData() {
  return {
    id: '',
    nickname: '小小农场主',
    avatar: '🐯',
    grade: '',                            // 年级（如「一年级」），可为空
    createdAt: Date.now(),

    lastActiveDate: util.today(),         // 上次打开小程序的日期（用于凌晨自动重置）
    settledDates: [],                     // 已完成夜间惩罚结算的日期，避免重复扣

    profile: {
      nickname: '小小农场主',
      streak: 0,                          // 连续全科打卡天数
      lastFullCheckinDate: '',            // 上一次三科全完成的日期
      equipped: { frame: '', skin: '' }
    },

    /* 儿童全局画像（参考学习者画像：学段 / 每周可学习时间 / 常用时段 / 讲解偏好 / 期望 / 自我感受 / 学校进度）
       年级(grade)沿用顶层字段，不在此重复；教材版本按学科存于 subjectProfiles */
    learner: {
      stage: '',                          // 学段：幼儿园/小学/初中/高中/其他
      weeklyMinutes: 0,                   // 每周可学习时间（分钟）
      timeSlots: [],                      // 常用时段：['放学后','晚饭后']
      teachStyle: '',                     // 讲解偏好：先提示后讲解/直接讲解/引导式探究/示范模仿
      expectations: [],                   // 期望内容：概念理解/方法训练/错题复盘/复测巩固...
      selfFeeling: '',                    // 自我感受：很好/一般/吃力/抗拒
      schoolProgress: '',                 // 学校进度：如「一年级上学期开学」
      schemaVersion: 'v1'
    },

    /* 每种打卡类型各自的学科画像，key = 类型 key（chinese/math/english/ct_xxx）
       { subject, textbook, progress, learnerNo, dimensions:[{name,level}], errors:[...] } */
    subjectProfiles: {},

    /* 作业打卡：{ 'YYYY-MM-DD': { chinese:{done,minutes,note,doneAt}, math:{...}, english:{...} } } */
    homework: {},

    /* 自定义打卡类型：家长在「打卡类型管理」里增删的类型，与内置 SUBJECTS 合并成可用类型列表 */
    checkinTypes: [],

    /* 课程表（一学期一张固定表，小学阶段不做单双周）：
       { termName, updatedAt, photoPath, rows, cols, slotTimes, cells }
       cells 以 '行-列' 为键，值为科目名字符串，如 { '0-0': '语文' } */
    schedule: null,

    /* 每日计划：{ 'YYYY-MM-DD': [ {id, subject, title, done} ] } */
    plans: {},

    /* 学习乐园：累计获得的小星星（做题正确即 +1，用于首页展示与激励） */
    learn: { stars: 0 },

    /* 老师评语分析记录：{ id, date, subject, comment, analysis, createdAt } */
    comments: [],

    /* 农场数据 */
    farm: {
      coins: 20,
      suns: 1,
      seeds: { chinese: 1, math: 1, english: 0 },
      pesticide: 0,
      shields: 0,
      plots: new Array(CFG.GROWTH.PLOT_COUNT).fill(null),
      bears: [],                          // 夜间刷新的小狗熊
      lockHarvestDate: '',                // 该日期禁止收获（三科全没写的惩罚）
      shieldExchangeDate: '',             // 今天已兑换护盾的日期（每日限量）
      harvestLog: [],                     // 仓库：收获记录
      owned: [],                          // 金币商城已购买的奖励 id
      logs: []                            // 农场大事记（结算报告）
    }
  };
}

/* --------------------------- 生成一株植物对象 --------------------------- */
function makePlant(subject, stage, health, plantedAt, plantedDate) {
  return {
    id: util.uid('pt'),
    subject: subject,
    stage: stage,                                  // 0播种 1发芽 2开花 3成熟
    health: health,                                // 健康度格数
    withered: false,                               // 是否已枯萎（灰色特效）
    plantedAt: plantedAt || Date.now(),
    plantedDate: plantedDate || util.today(),      // 「当天种下」判定用（惩罚等级1只啃当天的）
    lastGrowAt: plantedAt || Date.now(),
    bitten: false                                  // 是否正在被啃（触发啃咬动画）
  };
}

/* --------------------------- 事件总线（实时同步核心） --------------------------- */
const listeners = [];
function on(fn) {
  if (typeof fn === 'function' && listeners.indexOf(fn) < 0) listeners.push(fn);
}
function off(fn) {
  const i = listeners.indexOf(fn);
  if (i >= 0) listeners.splice(i, 1);
}
function emit(data) {
  listeners.forEach(fn => {
    try { fn(data); } catch (e) { console.warn('[store] listener error', e); }
  });
}

/* --------------------------- 读写 --------------------------- */
let _root = null;
let _openid = '';        // 当前绑定的微信 openid（空 = 尚未确认 / 离线兜底）
let _cloudBlocked = false;   // 云端下载失败保护期：只禁止「上云」，不影响本地落盘
let _accountDegraded = false; // 身份/网络异常导致降级：本地已存，但暂未上云（需给用户提示）

/** 本地存储 key：已确认 openid 则用命名空间隔离，否则用兜底 base key */
function storageKey() {
  return _openid ? `${BASE_KEY}_${_openid}` : BASE_KEY;
}

/** 当前绑定的微信 openid（可能为空） */
function getOpenid() { return _openid; }

/** 绑定信息，给「我的」页展示：是否已绑定微信 + 脱敏后的 openid + 微信昵称/头像 */
function getBindInfo() {
  const o = _openid;
  const p = getWxProfile();
  if (!o) return { bound: false, openid: '', masked: '', wxName: p.nickname, wxAvatar: p.avatarUrl };
  const masked = o.length > 10 ? `${o.slice(0, 6)}****${o.slice(-4)}` : o;
  return { bound: true, openid: o, masked, wxName: p.nickname, wxAvatar: p.avatarUrl };
}

/** 是否处于「游客模式」（尚未绑定微信 = openid 为空）：此模式下操作不落盘、不上云 */
function isGuest() { return !_openid; }

/**
 * 读取用户手动同步的微信昵称/头像。
 *
 * 【2026-09-18 迁入 root，修 P1-3/R7】旧实现存在独立的 `wb_hwfarm_wxprofile` key 里，
 * 两个后果：① 它不属于 syncData 的整份镜像 → 换手机就丢；② key 不带 openid →
 * 同机切换不同微信号会读到上一个人的昵称头像。
 * 现在主存 `root.wxProfile`（随整份镜像上云、按 openid 命名空间隔离）；
 * 旧 key 只作一次性迁移来源，读到时搬进 root 并删除。
 */
function getWxProfile() {
  const root = getRoot();
  const p = root.wxProfile;
  if (p && (p.nickname || p.avatarUrl)) {
    return { nickname: p.nickname || '', avatarUrl: p.avatarUrl || '' };
  }
  // 旧 key 一次性迁移
  let legacy = null;
  try { legacy = wx.getStorageSync(WXPROFILE_KEY); } catch (e) {}
  if (legacy && typeof legacy === 'object' && (legacy.nickname || legacy.avatarUrl)) {
    root.wxProfile = { nickname: legacy.nickname || '', avatarUrl: legacy.avatarUrl || '' };
    try { wx.setStorageSync(storageKey(), root); } catch (e) {}
    try { wx.removeStorageSync(WXPROFILE_KEY); } catch (e) {}
    markDirty();          // 让紧接着的那次上云把它一起带走（此时不主动发请求）
    return { nickname: root.wxProfile.nickname, avatarUrl: root.wxProfile.avatarUrl };
  }
  return { nickname: '', avatarUrl: '' };
}

/** 写入微信 nickname / avatarUrl（二者可单独更新，未传则沿用旧值）
 *  走 save()：本地必然落盘，并随整份镜像上云。
 *  注：用户尚未创建任何孩子时（root 只有 __placeholder 切片），按 R5 不产生云端档案，
 *      微信资料会等第一个孩子建档后一起上云 —— 这是有意的，避免幽灵档案污染结算与看板。 */
function setWxProfile(patch) {
  const cur = getWxProfile();
  const next = {
    nickname: patch.nickname !== undefined ? patch.nickname : cur.nickname,
    avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl : cur.avatarUrl
  };
  getRoot().wxProfile = next;
  save();
  return next;
}

/** 补齐单个孩子缺失的字段（兼容旧数据 / 配置变更） */
function ensureUserFields(u) {
  const def = defaultData();
  Object.keys(def).forEach(k => { if (u[k] === undefined) u[k] = def[k]; });
  Object.keys(def.farm).forEach(k => { if (u.farm[k] === undefined) u.farm[k] = def.farm[k]; });
  // 字段改名兼容：旧 profile.nickname 同步到顶层 nickname
  if (u.profile && u.profile.nickname && !u.nickname) u.nickname = u.profile.nickname;
  if (!u.avatar) u.avatar = '🐯';
  return u;
}

/**
 * 该孩子切片是否已产生「真实用户数据」。
 * 用途：判断内存占位切片（未创建孩子前的体验用切片）是否还处于「未启用」状态，
 *       从而决定要不要把它上云 —— 装了但从没用过的用户不该在云端留下一条幽灵档案
 *       （会污染 dailyReset 结算遍历与家长看板统计）。
 *
 * ⚠️ 判定必须刻意宽松：宁可误判为 true（多传一次，无害），
 *    也绝不能误判为 false（漏传用户真实数据）。
 */
function hasRealActivity(u) {
  if (!u) return false;
  const hw = u.homework || {};
  const hwDone = Object.keys(hw).some(day => {
    const d = hw[day] || {};
    return Object.keys(d).some(k => d[k] && d[k].done);
  });
  const farm = u.farm || {};
  const farmTouched = (farm.plots || []).some(Boolean) ||
    (farm.harvestLog || []).length > 0 || (farm.logs || []).length > 0 ||
    (farm.bears || []).length > 0 || (farm.pesticide || 0) > 0 || (farm.shields || 0) > 0 ||
    (farm.coins || 0) !== 20 || (farm.suns || 0) !== 1;
  const ln = u.learner || {};
  return hwDone || farmTouched ||
    (u.checkinTypes || []).length > 0 ||
    (u.comments || []).length > 0 ||
    Object.keys(u.plans || {}).length > 0 ||
    Object.keys(u.subjectProfiles || {}).length > 0 ||
    !!u.schedule || !!u.grade || !!u.studyPlans ||
    (u.nickname && u.nickname !== '小小农场主') ||
    ((u.learn || {}).stars || 0) > 0 ||
    ((u.profile || {}).streak || 0) > 0 ||
    !!(ln.stage || ln.weeklyMinutes || (ln.timeSlots || []).length || ln.teachStyle ||
       (ln.expectations || []).length || ln.selfFeeling || ln.schoolProgress);
}

/**
 * 整份数据是否「只有一个从未启用的占位切片」。
 * 真实用户在第一轮循环就 `return false`（占位标记不存在），成本为零；
 * 只有占位根才会付出 hasRealActivity 的开销。
 */
function isBarePlaceholderOnly(root) {
  const us = (root && Array.isArray(root.users)) ? root.users : [];
  if (!us.length) return true;
  for (let i = 0; i < us.length; i++) {
    const u = us[i];
    if (!u || !u.__placeholder) return false;
  }
  return us.every(u => !hasRealActivity(u));
}

/** 规范化根结构，保证可用（允许「空根」：全新用户尚未创建孩子） */
function normalizeRoot(root) {
  if (!root || typeof root !== 'object') root = { version: 2, users: [] };
  if (!Array.isArray(root.users)) root.users = [];
  root.users.forEach(ensureUserFields);
  if (root.users.length) {
    if (!root.users.find(u => u.id === root.currentUserId)) {
      root.currentUserId = root.users[0].id;
    }
  } else {
    // 空根：currentUserId 置空，等登录门创建第一个孩子
    root.currentUserId = '';
  }
  // 家庭内合种（阶段 0）：root 级共享作物，与「孩子切片」隔离
  if (!root.coop || !Array.isArray(root.coop.plants)) root.coop = { plants: [] };
  // 微信昵称/头像（R7）：root 级共享，随整份镜像上云；云端有值则原样保留
  if (!root.wxProfile || typeof root.wxProfile !== 'object') {
    root.wxProfile = { nickname: '', avatarUrl: '' };
  }
  return root;
}

/** 从 v1 单用户数据迁移到 v2 多用户根结构（首个孩子） */
function migrateFromV1() {
  let old = null;
  try { old = wx.getStorageSync(OLD_KEY); } catch (e) {}
  if (!old || !old.farm) return null;
  const u = Object.assign(defaultData(), old);    // 旧 homework/farm/profile 覆盖默认
  u.id = util.uid('u');
  u.nickname = (old.profile && old.profile.nickname) || '小小农场主';
  u.avatar = '🐯';
  u.grade = '';
  u.createdAt = Date.now();
  const root = { version: 2, users: [u], currentUserId: u.id, __isDemo: !!old.__isDemo };
  // 迁移完成后清掉旧 key，避免重复迁移
  try { wx.removeStorageSync(OLD_KEY); } catch (e) {}
  return root;
}

function getRoot() {
  if (_root) return _root;
  let root = null;
  try { root = wx.getStorageSync(storageKey()); } catch (e) { console.warn('[store] read fail', e); }

  if (!root || !root.users || !root.users.length) {
    root = migrateFromV1();                        // 尝试迁移旧数据（老用户直接带入一个孩子）
  }
  if (!root) {
    // 全新用户：返回「内存占位切片」用于浏览 / 体验。
    // ⚠️ 该切片只活在内存里：打 __placeholder 标记，不参与 isOnboarded() 判定、
    //    不产生云端档案（见 isBarePlaceholderOnly）。用户一旦建档或产生真实数据，
    //    标记即失去意义（hasRealActivity 放行上云），数据照常落盘 + 上云。
    const u = defaultData();
    u.id = PLACEHOLDER_ID;
    u.__placeholder = true;
    root = { version: 2, users: [u], currentUserId: PLACEHOLDER_ID };
  }
  _root = normalizeRoot(root);
  return _root;
}

/** 返回「当前孩子」的切片（引擎 / 页面都基于它工作） */
function get() {
  const root = getRoot();
  return root.users.find(u => u.id === root.currentUserId) || root.users[0];
}

/**
 * 可用打卡类型列表 = 内置预设(SUBJECTS) + 当前孩子的自定义类型(checkinTypes)
 * 引擎与所有页面都通过它获取「当前有哪些打卡项」，从而实现类型可配置。
 */
function getTypeList() {
  const u = get();
  const custom = (u && Array.isArray(u.checkinTypes)) ? u.checkinTypes : [];
  return CFG.SUBJECTS.concat(custom);
}

/** 按 key 取类型配置（内置或自定义）；找不到回退到第一个内置类型 */
function getType(key) {
  const list = getTypeList();
  return list.find(t => t.key === key) || list[0] || CFG.SUBJECTS[0];
}

/** 是否已完成「微信登录 + 创建首个孩子」——决定启动登录门是否展示 */
function isOnboarded() {
  // 只认真实孩子：内存占位切片（__placeholder）不算「已创建孩子」。
  // 旧实现用 users.length > 0 判定，而 getRoot() 的空数据兜底一定会造一个占位切片，
  // 于是 isOnboarded() 恒为 true → pkgTools/login 的建档入口永远走不到（死代码）。
  return getRoot().users.some(u => u && !u.__placeholder);
}

function getById(id) {
  return getRoot().users.find(u => u.id === id);
}

/** 切换当前孩子（会触发全局重渲染） */
function setCurrentUser(id) {
  const root = getRoot();
  if (root.users.find(u => u.id === id) && id !== root.currentUserId) {
    root.currentUserId = id;
    save();
  }
}

/** 新增一个孩子（默认全新数据，不带示例） */
function addUser(info) {
  const root = getRoot();
  // 顺手清掉「从未启用」的内存占位切片：它不该出现在孩子列表里，也不该被上云。
  // ⚠️ 只清带 __placeholder 标记的（新逻辑产生）。老版本遗留的 id='guest' 用户
  //    没有该标记，里面可能存着真实数据 → 一律保留（数据优先于整洁）。
  root.users = (root.users || []).filter(x => !(x && x.__placeholder && !hasRealActivity(x)));
  if (!root.users.find(x => x.id === root.currentUserId)) root.currentUserId = '';

  const u = defaultData();
  u.id = util.uid('u');
  u.nickname = (info && info.nickname) ? info.nickname : '新朋友';
  u.avatar = (info && info.avatar) || '🐯';
  u.grade = (info && info.grade) || '';
  u.createdAt = Date.now();
  root.users.push(u);
  root.currentUserId = u.id;                       // 新建后自动切到新孩子
  save();
  return u.id;
}

/** 修改某个孩子的资料（昵称 / 头像 / 年级） */
function updateUser(id, patch) {
  const u = getById(id);
  if (!u) return;
  if (patch) Object.assign(u, patch);
  save();
}

/** 删除一个孩子（至少保留 1 个） */
function removeUser(id) {
  const root = getRoot();
  if (root.users.length <= 1) return false;        // 不能删光
  const i = root.users.findIndex(u => u.id === id);
  if (i < 0) return false;
  root.users.splice(i, 1);
  if (root.currentUserId === id) root.currentUserId = root.users[0].id;
  save();
  return true;
}

/* ==========================================================================
 *  家庭内合种（阶段 0 · 群体动力狗粮验证）
 *  ---------------------------------------------------------------------------
 *  设计：合种是「家庭级共享作物」，挂在 root.coop 上，不归属某个孩子切片。
 *  单设备 + 多个孩子档案时，任一孩子的打卡都会推进同一棵合种作物的进度，
 *  从而模拟「一群人一起完成一个目标更有动力」的体验。
 *  注意：单家庭、单孩无法真正验证群体动力，这只是手感与基线采集，
 *        真正的实验主载体是后续「跨家庭群组」(见 growth-project.md)。
 * ========================================================================== */

/** 取 root 级合种数据 */
function getCoop() { return getRoot().coop; }

/** 当前进行中的合种（未完成的第一株） */
function getActiveCoop() {
  const coop = getCoop();
  return (coop && coop.plants && coop.plants.find(p => !p.done)) || null;
}

/**
 * 发起一株家庭合种（若已有进行中的则直接返回它）
 * @param {Object} opts { name, emoji, color, colorDeep }
 * @returns {Object} 合种植物对象
 */
function createCoop(opts) {
  const root = getRoot();
  if (!root.coop) root.coop = { plants: [] };
  const active = getActiveCoop();
  if (active) return active;

  // 目标进度 = 孩子数 × 内置学科数（忽略自定义类型，保证目标直观可达）
  const goal = (root.users.length || 1) * CFG.SUBJECTS.length;
  const plant = {
    id: util.uid('coop'),
    name: (opts && opts.name) || '家庭合种树',
    emoji: (opts && opts.emoji) || '🌳',
    color: (opts && opts.color) || '#6FCF7C',
    colorDeep: (opts && opts.colorDeep) || '#3B6D11',
    progress: 0,
    goal: goal,
    contributors: {},                 // childId -> 贡献次数
    createdAt: Date.now(),
    done: false,
    doneAt: 0
  };
  root.coop.plants.push(plant);
  save(root);
  try { require('./analytics.js').trackFarm('coop_create', { coopId: plant.id }); } catch (e) {}
  return plant;
}

/**
 * 某个孩子完成一次打卡 → 推进当前合种进度
 * @returns {Object|null} { plant, justDone } 或 null（无进行中合种）
 */
function contributeCoop(childId, subName) {
  const root = getRoot();
  if (!root.coop) root.coop = { plants: [] };
  const plant = getActiveCoop();
  if (!plant) return null;

  plant.progress += 1;
  plant.contributors[childId] = (plant.contributors[childId] || 0) + 1;

  let justDone = false;
  if (plant.progress >= plant.goal) {
    plant.done = true;
    plant.doneAt = Date.now();
    justDone = true;
  }
  save(root);
  try {
    const A = require('./analytics.js');
    A.trackFarm('coop_contribute', { coopId: plant.id, childId: childId, subName: subName });
    if (justDone) A.trackFarm('coop_done', { coopId: plant.id });
  } catch (e) {}
  return { plant: plant, justDone: justDone };
}

/**
 * 读取当前孩子的老师评语记录（按时间倒序）
 * @returns {Array} [{ id, date, subject, comment, analysis, createdAt }]
 */
function getComments() {
  const u = get();
  return (u && u.comments) ? u.comments.slice().sort((a, b) => b.createdAt - a.createdAt) : [];
}

/**
 * 新增一条老师评语分析记录（自动归属到当前孩子）
 * @param {Object} rec { date, subject, comment, analysis }
 * @returns {Object} 新增的记录
 */
function addComment(rec) {
  const u = get();
  if (!u.comments) u.comments = [];
  const item = {
    id: util.uid('cm'),
    date: rec.date || util.today(),
    subject: rec.subject || '综合',
    comment: (rec.comment || '').trim(),
    analysis: rec.analysis || '',
    createdAt: Date.now()
  };
  u.comments.unshift(item);              // 最新在前
  save();
  return item;
}

/* ==========================================================================
 *  用户画像（全局儿童画像 + 每种打卡类型的学科画像）
 * ========================================================================== */

/** 取当前孩子的全局儿童画像（确保存在） */
function getLearner() {
  const u = get();
  if (!u.learner) u.learner = defaultData().learner;
  return u.learner;
}

/** 年级识别词表（与「我的」GRADES 对齐，另覆盖初高中） */
const GRADE_RE = /小班|中班|大班|一年级|二年级|三年级|四年级|五年级|六年级|初一|初二|初三|高一|高二|高三/;

/** 从文本解析年级（如「一年级上学期开学」→「一年级」）；识别不到返回空串 */
function parseGrade(text) {
  if (!text) return '';
  const m = String(text).match(GRADE_RE);
  return m ? m[0] : '';
}

/**
 * 当前孩子的年级（成长计划 / 导学等场景统一从这里取，打通「画像 → 计划」）：
 *   1) 优先顶层 grade（「我的 → 编辑资料」显式设置）
 *   2) 兜底从「儿童画像 → 学校进度」解析（如填了「一年级上学期」即识别「一年级」）
 */
function resolveGrade() {
  const u = get();
  if (u.grade && String(u.grade).trim()) return String(u.grade).trim();
  return parseGrade(u.learner && u.learner.schoolProgress);
}

/** 保存全局儿童画像（patch 合并） */
function saveLearner(patch) {
  const u = get();
  if (!u.learner) u.learner = defaultData().learner;
  Object.assign(u.learner, patch);
  save(u);
  return u.learner;
}

/** 取某打卡类型的学科画像（确保存在，内置学科按预设填充能力维度初值） */
function getSubjectProfile(key) {
  const u = get();
  if (!u.subjectProfiles) u.subjectProfiles = {};
  if (!u.subjectProfiles[key]) u.subjectProfiles[key] = defaultSubjectProfile(key);
  return u.subjectProfiles[key];
}

/** 保存某打卡类型的学科画像（patch 合并） */
function saveSubjectProfile(key, patch) {
  const u = get();
  if (!u.subjectProfiles) u.subjectProfiles = {};
  const base = u.subjectProfiles[key] || defaultSubjectProfile(key);
  u.subjectProfiles[key] = Object.assign({}, base, patch);
  save(u);
  return u.subjectProfiles[key];
}

/** 学科画像默认结构（内置学科按 CFG.PROFILE.SUBJECT_DIMS 预设能力维度初值 2 分） */
function defaultSubjectProfile(key) {
  const t = getType(key);
  const name = t ? t.name : key;
  const dims = (CFG.PROFILE && CFG.PROFILE.SUBJECT_DIMS && CFG.PROFILE.SUBJECT_DIMS[key]) || [];
  return {
    subject: name,
    textbook: '',                 // 教材版本（如人教版）
    progress: '',                 // 进度（如「一年级上学期 准备课」）
    learnerNo: '',                // 学习者编号（如 JY-001）
    dimensions: dims.map(n => ({ name: n, level: 2 })),  // 能力维度 + 1-5 掌握度初值
    errors: []                    // 常见错误模式
  };
}

/**
 * 保存并广播（页面之间实时同步就靠它）
 * @param {Object} slice 当前孩子切片（不传也行，内部会写整份根结构）
 * @param {Boolean} sync 是否同时写云数据库（false = 只落盘不触发上云，如自然生长）
 *
 * 【铁律·2026-09-18 修订】「能否本地落盘」与「能否上云」是两件事，必须解耦。
 *   · 本地落盘：**永远执行**。身份（openid）没拿到时落到兜底 key，等 openid 恢复后
 *     由 initAccount 第 4 步迁移进账号命名空间。
 *   · 上云：需要 云就绪 + 已确认 openid + 未被阻断 + 不是未启用的占位切片。
 *
 * 旧实现把「_openid 为空」当作游客模式，既不落盘也不上云、只打一行 console.log，
 * 于是 whoami 调用失败（网络抖动 / 云函数未部署 / 超时）这一条路径会让用户
 * 整套操作静默丢失且毫无提示。已废弃该语义。
 */
function save(slice, sync) {
  if (!_root) _root = getRoot();

  // 1) 本地落盘：始终执行，失败只报错不中断（内存态仍然可用并已广播）
  try {
    wx.setStorageSync(storageKey(), _root);
  } catch (e) {
    console.error('[store] save fail（本地落盘失败）', e);
  }

  // 2) 上云：异步、不阻塞 UI；占位切片不产生云端档案
  if (sync !== false && !isBarePlaceholderOnly(_root)) {
    markDirty();
    cloudUpload();
  }

  emit(get());                                     // ← 广播：所有页面立即拿到「当前孩子」最新数据
  return get();
}

/** 重置当前孩子的数据（保留昵称 / 头像 / 年级 / 创建时间） */
function reset(keepProfile) {
  const u = get();
  const id = u.id, nick = u.nickname, avatar = u.avatar, grade = u.grade, createdAt = u.createdAt;
  const fresh = defaultData();
  Object.assign(u, fresh, { id, nickname: nick, avatar, grade, createdAt });
  u.__isDemo = false;
  save(u);
  return u;
}

/* --------------------------- 云数据库同步 --------------------------- */
let cloudReady = false;
function setCloudReady(v) { cloudReady = v; }

/* ---- 上云状态：脏标记 + 重试计数（按 openid 隔离，避免同设备多账号串味） ---- */
function syncTagKey() { return _openid ? `${SYNCTAG_KEY}_${_openid}` : SYNCTAG_KEY; }
function readSyncTag() {
  try {
    const v = wx.getStorageSync(syncTagKey());
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return {}; }
}
function writeSyncTag(t) { try { wx.setStorageSync(syncTagKey(), t); } catch (e) {} }

/** 本地有改动尚未成功上云 */
function isDirty() { return !!readSyncTag().dirty; }

/** 标记「有改动待上云」；已有待推改动时不重置 pendingSince（保留首次积压时间）
 *  _rev 是「本地改动代数」：上传在途期间若又有新改动，成功后不能误清脏标记。 */
let _rev = 0;
function markDirty() {
  _rev++;
  const t = readSyncTag();
  if (!t.dirty) { t.dirty = true; t.pendingSince = Date.now(); t.attempts = 0; }
  writeSyncTag(t);
}

/** 上云成功 → 清脏 */
function clearDirty() {
  writeSyncTag({ dirty: false, pendingSince: 0, attempts: 0, lastOkAt: Date.now() });
}

/** 对外暴露同步状态：「我的」页 / 排查「云端是否落后」时读它 */
function getSyncState() {
  const t = readSyncTag();
  return {
    ready: cloudReady,
    openid: _openid,
    blocked: _cloudBlocked,
    // 只有「环境已接入云、但身份或网络出问题」才算降级。
    // 环境本身没接云（cloudReady=false，如纯离线开发）不算降级，不必骚扰用户。
    degraded: !!(cloudReady && (_accountDegraded || _cloudBlocked || !_openid)),
    dirty: !!t.dirty,
    pendingSince: t.pendingSince || 0,
    attempts: t.attempts || 0,
    lastOkAt: t.lastOkAt || 0,
    lastError: t.lastError || ''
  };
}
function isAccountDegraded() { return getSyncState().degraded; }

/** 上行：本地 → 云
 *  · 默认防抖 2 秒（合并连续操作，避免频繁写库）
 *  · immediate=true 立刻发（app.onHide / onShow / 启动补偿用）
 *  · 成功清脏；失败保留脏标记并按退避重试 1s→4s→15s→60s，
 *    下次 save() / 启动 / 切前台还会再试 —— 不再「一次失败即永久放弃」
 *  · 未确认 openid、云端被阻断（下载失败保护期）、或整份数据只是未启用的占位切片时不上云
 */
const RETRY_DELAYS = [1000, 4000, 15000, 60000];
let uploadTimer = null;
let inflight = false;

function canSync() {
  return !!(cloudReady && _openid && !_cloudBlocked);
}

function cloudUpload(immediate) {
  if (!canSync()) return;
  if (isBarePlaceholderOnly(_root)) return;      // 未启用的占位切片不产生云端档案
  clearTimeout(uploadTimer);
  if (immediate) { doUpload(); return; }
  uploadTimer = setTimeout(doUpload, 2000);
}

function doUpload() {
  if (!canSync()) return;
  // 已有请求在途：不丢弃，重新排一次防抖（否则这次改动会被在途请求的
  // 成功回调误判为「已同步」而永远推不上去）
  if (inflight) { cloudUpload(); return; }

  const rev = _rev;                              // 记下本次上传对应的改动代数
  inflight = true;
  wx.cloud.callFunction({
    name: 'syncData',
    data: { action: 'upload', payload: sanitizeForCloud(_root) }
  }).then(res => {
    inflight = false;
    const r = res && res.result;
    if (r && r.ok) {
      // 只有「发出后本地再无新改动」才算真正同步完成
      if (_rev === rev) clearDirty();
      else cloudUpload();                        // 期间又有改动 → 再补推一次
      return;
    }
    scheduleRetry((r && r.msg) || '云端拒绝写入');
  }).catch(err => {
    inflight = false;
    scheduleRetry((err && err.errMsg) || String(err));
    console.warn('[store] 云同步失败，已排队重试', err);
  });
}

/** 失败退避重试；退避用尽后停手，等下次 save / 启动 / 切前台再试 */
function scheduleRetry(msg) {
  const t = readSyncTag();
  t.dirty = true;
  if (!t.pendingSince) t.pendingSince = Date.now();
  t.attempts = (t.attempts || 0) + 1;
  t.lastError = String(msg || '').slice(0, 200);
  writeSyncTag(t);
  if (t.attempts > RETRY_DELAYS.length) return;
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(doUpload, RETRY_DELAYS[t.attempts - 1]);
}

/**
 * 立刻把本地改动推上云。用于：
 *   · app.onHide —— 堵住「2 秒防抖窗口内被杀进程 → 该次操作永不上云」
 *   · app.onShow / initAccount —— 补推上次失败积压的改动
 * @param {Boolean} force true = 无视脏标记强制推一次（切后台用）
 */
function flushSync(force) {
  if (!canSync()) return;
  if (!force && !isDirty()) return;
  clearTimeout(uploadTimer);
  doUpload();
}
/**
 * 上云 / 导出前的脱敏（S1 红线：API Key 只允许留在设备本地）
 *  · 现版本已无小程序端 AI 配置页，正常数据里不含 Key；
 *    这里保留兜底，是为了堵住两条残留泄漏路径：
 *      ① 老版本升级上来的 localStorage 里仍有 aiVision.key
 *      ② exportJSON 导出的备份文件会被家长分享出去
 *  · 服务端 syncData 入库前再删一次（纵深防御）。
 */
function sanitizeForCloud(root) {
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(root));
  } catch (e) { return root; }
  if (clone && typeof clone === 'object') {
    ['aiVision', 'visionCfg'].forEach(k => {
      if (clone[k] && typeof clone[k] === 'object') clone[k].key = '';
    });
  }
  return clone;
}

/** 下行：云 → 本地（换手机 / 重装后，按本账号 openid 恢复数据）
 *  @returns Promise<{ok:boolean, empty?:boolean, failed?:boolean}>
 *    ok    ：成功拉到数据并写入本地命名空间
 *    empty ：云端明确无数据（首次用户，允许本地兜底后正常上云）
 *    failed：网络 / 云异常，无法判断云端是否有数据 —— 调用方必须阻断
 *            「已绑定但本地空」状态去覆盖云端真实数据（见 initAccount 第 5 步）
 */
function cloudDownload() {
  return new Promise((resolve) => {
    if (!cloudReady) return resolve({ ok: false, empty: true });
    wx.cloud.callFunction({ name: 'syncData', data: { action: 'download' } })
      .then(res => {
        const remote = res && res.result && res.result.data;
        if (remote && remote.users && remote.users.length) {
          remote.lastSyncAt = Date.now();
          _root = normalizeRoot(remote);
          try { wx.setStorageSync(storageKey(), _root); } catch (e) {}
          emit(get());
          resolve({ ok: true });
        } else resolve({ ok: false, empty: true });
      })
      .catch(() => resolve({ ok: false, failed: true }));
  });
}

/**
 * 拉取云端数据做「补缺式」合并（2026-09-18 重写，修 P0-4）
 *
 * 【为什么删掉旧的整片覆盖 + settledDates 并集】
 * 旧实现用 lastActiveDate 日期串比大小，云端更新时把整个孩子切片 Object.assign 覆盖掉，
 * 只保留 homework。两个致命后果：
 *   ① 本地尚未上云的改动（farm 金币/植物/仓库、plans、comments、learner、subjectProfiles、
 *      schedule、checkinTypes、studyPlans、profile.streak）被云端旧快照静默抹掉；
 *   ② 并集写回 settledDates 会命中 nightSettle 的「已结算」守卫（farmEngine.js:179），
 *      惩罚不再落到本地 farm，而下次 save() 又把本地 farm 推上云 →
 *      云端的惩罚被反向覆盖，惩罚凭空消失。
 * 更关键的是「云端更新」这个条件每天必然成立：云端 dailyReset 在 00:05 无条件把
 * lastActiveDate 写成当天，本地只在用户打开小程序时才推进，而 app.js 里
 * initAccount 先于 runDailyRollover 执行 —— 于是每天首次打开都会触发一次整片覆盖。
 *
 * 【现在的规则】
 * 只做一件事：云端有、本地没有的孩子 → 追加进来（换设备 / 多孩子场景的兜底）。
 * 已存在的孩子一律以本地为准 —— 本地是本机权威，上云统一由 save() → cloudUpload() 负责。
 * 漏结算的惩罚由 app.js 的 runDailyRollover 在本地按同一份 homework 记录重算一遍，
 * 结果同样只惩罚一次（settledDates 是「本副本已结算」的标记，不可跨副本混用）。
 *
 * @returns {Promise<Boolean>} 是否发生了合并
 */
function mergeRemote() {
  return new Promise((resolve) => {
    if (!cloudReady || !_openid) return resolve(false);
    wx.cloud.callFunction({ name: 'syncData', data: { action: 'download' } })
      .then(res => {
        const remote = res && res.result && res.result.data;
        if (!remote || !Array.isArray(remote.users) || !remote.users.length) return resolve(false);
        const local = getRoot();
        const localIds = {};
        (local.users || []).forEach(u => { if (u && u.id) localIds[u.id] = true; });

        let changed = false;
        remote.users.forEach(r => {
          if (!r || !r.id || localIds[r.id]) return;        // 本地已有 → 保留本地，绝不覆盖
          const adopted = ensureUserFields(Object.assign({}, r));
          delete adopted.__placeholder;
          local.users.push(adopted);
          localIds[r.id] = true;
          changed = true;
        });

        if (changed) {
          if (!local.currentUserId || !local.users.find(u => u.id === local.currentUserId)) {
            local.currentUserId = local.users[0].id;
          }
          try { wx.setStorageSync(storageKey(), local); } catch (e) {}
          markDirty();                                      // 新并入的孩子需要上云留档
          emit(get());
        }
        resolve(changed);
      })
      .catch(() => resolve(false));
  });
}

/**
 * 启动时的账号初始化（异步）：
 *   1) 读缓存 openid（无云时也能瞬时判断账号）
 *   2) 云可用则向 syncData(whoami) 确认真正的 openid（防同设备多微信串号）
 *   3) 清空内存根，强制从本账号命名空间重新加载
 *   4) 首次把旧 base key 数据搬进当前账号命名空间（仅一次）
 *   5) 加载本账号数据：本地有则用本地；本地空且云可用则下载；都没有则占位切片
 *   6) 缓存 openid；补推积压的未上云改动
 *
 * 【身份解耦·2026-09-18】拿不到 openid（whoami 失败且无缓存）**不再等于「游客模式」**，
 * 只表示「暂不能上云」：本地落盘照常走兜底 key，等 openid 恢复后由第 4 步迁移进
 * 账号命名空间。云端下载失败时只置 _cloudBlocked 阻断上云（保护云端真数据），
 * 同样不阻断本地保存。两种降级都会置 _accountDegraded，由 app.js 弹提示。
 */
async function initAccount() {
  _cloudBlocked = false;
  _accountDegraded = false;

  // 1) 读缓存
  try { _openid = wx.getStorageSync(OPENID_KEY) || ''; } catch (e) {}

  // 2) 云可用则向服务端确认真正的 openid
  if (cloudReady && wx.cloud && wx.cloud.callFunction) {
    try {
      const res = await wx.cloud.callFunction({ name: 'syncData', data: { action: 'whoami' } });
      const oid = res && res.result && res.result.openid;
      if (oid) _openid = oid;
      else _accountDegraded = true;
    } catch (e) {
      _accountDegraded = true;
      console.warn('[store] 获取 openid 失败：本地照常保存，暂不上云', e);
    }
  }
  if (!_openid) _accountDegraded = true;

  // 3) 切换账号：清空内存根，强制从本账号命名空间重新加载
  _root = null;

  // 4) 首启迁移：把旧 base key 数据搬进当前账号命名空间（仅一次）
  //    同时兜住「上次启动 whoami 失败 → 数据落在 base key」的情况
  if (_openid) {
    try {
      const legacy = wx.getStorageSync(BASE_KEY);
      const ns = wx.getStorageSync(storageKey());
      if (legacy && legacy.users && legacy.users.length &&
          (!ns || !ns.users || !ns.users.length)) {
        wx.setStorageSync(storageKey(), legacy);
        try { wx.removeStorageSync(BASE_KEY); } catch (e2) {}
      }
    } catch (e) {}
    // 4b) 脏标记必须跟着一起迁移：脏标记是按 openid 隔离的（syncTagKey），
    //     「whoami 失败期间落在兜底 key 的改动」若不迁移，openid 恢复后 flushSync
    //     读的是另一个 key，积压的改动就永远推不上去（首次上云静默丢失）。
    try {
      const legacyTag = wx.getStorageSync(SYNCTAG_KEY);
      if (legacyTag && legacyTag.dirty) {
        if (!readSyncTag().dirty) writeSyncTag(legacyTag);
        wx.removeStorageSync(SYNCTAG_KEY);
      }
    } catch (e) {}
  }

  // 5) 加载本账号数据
  let root = null;
  try { root = wx.getStorageSync(storageKey()); } catch (e) {}
  if (!root || !root.users || !root.users.length) {
    if (cloudReady) {
      const dl = await cloudDownload();   // { ok, empty, failed }
      if (dl.failed) {
        // 云端「可能」有真实数据但没拉下来 → 只阻断「上云」避免本地空态覆盖云端，
        // 本地保存照常（旧实现直接清空 _openid 退化成「不落盘」，用户操作全丢）
        _cloudBlocked = true;
        _accountDegraded = true;
      }
      // dl.ok 已写入 _root / 命名空间；dl.empty 走下面兜底占位切片
    }
  } else if (cloudReady) {
    await mergeRemote();       // 本地已有数据：只补云端独有孩子，绝不覆盖本地
  }

  // 6) 确保 _root 就绪 + 缓存 openid
  const finalRoot = getRoot();
  if (_openid) {
    try { wx.setStorageSync(storageKey(), finalRoot); } catch (e) {}
    try { wx.setStorageSync(OPENID_KEY, _openid); } catch (e) {}
  }

  // 7) 补推上次失败 / 被杀进程积压的改动
  if (canSync()) flushSync();

  try {
    const app = (typeof getApp === 'function') ? getApp() : null;
    if (app && app.globalData) {
      app.globalData.cloudRestoreFailed = _accountDegraded;
      app.globalData.syncDegraded = _accountDegraded;
    }
  } catch (e2) {}

  return _openid;
}

/**
 * 运行时「绑定 / 重新绑定微信」（供「我的」页点击触发）
 *  · 已绑定且 openid 未变：返回 { ok:true, changed:false }
 *  · 未绑定 / 换号：调用 syncData(whoami) 拿 openid，切换本地命名空间；
 *    若新命名空间为空，而当前（base key 或旧命名空间）已有数据，则把数据迁移过去，避免丢失。
 *  · 无云环境：返回 { ok:false, reason:'cloud' }
 */
async function bindWechat() {
  if (!cloudReady || !wx.cloud || !wx.cloud.callFunction) {
    return { ok: false, reason: 'cloud' };
  }
  let res = null, callErr = null;
  try {
    res = await wx.cloud.callFunction({ name: 'syncData', data: { action: 'whoami' } });
  } catch (e) {
    callErr = e;
    console.warn('[store] whoami 调用失败', e);
  }
  if (callErr) {
    // 云函数调用本身异常：多半是未部署到该环境 / 小程序与云不在同一账号 / 超时
    return { ok: false, reason: 'callfail', err: (callErr && callErr.errMsg) || String(callErr) };
  }
  const oid = res && res.result && res.result.openid;
  if (!oid) {
    // 调用成功但没返回 openid：云端代码不含 whoami 分支（需重新上传部署）
    return { ok: false, reason: 'openid', result: res && res.result };
  }

  // 云函数可达且身份已确认 → 解除降级保护（此前 whoami / 下载失败留下的状态）
  _cloudBlocked = false;
  _accountDegraded = false;

  if (oid === _openid) return { ok: true, changed: false };

  const current = getRoot();                  // 当前内存根（base key 或旧命名空间数据）
  let ns = null;
  try { ns = wx.getStorageSync(`${BASE_KEY}_${oid}`); } catch (e) {}
  if ((!ns || !ns.users || !ns.users.length) && current && current.users && current.users.length) {
    // 首次绑定 / 换号且新号无数据：把现有数据搬进新命名空间，防止丢失
    _root = current;
    _openid = oid;
    try { wx.setStorageSync(storageKey(), _root); } catch (e) {}
    try { wx.removeStorageSync(BASE_KEY); } catch (e2) {}
  } else {
    // 新号已有数据：直接切换命名空间并重新加载
    _openid = oid;
    _root = null;
    getRoot();
  }
  try { wx.setStorageSync(OPENID_KEY, oid); } catch (e) {}
  emit(get());
  return { ok: true, changed: true };
}

/* --------------------------- 导出 / 导入备份 --------------------------- */
/** 导出整份数据（含所有孩子）到手机文件（可分享给家长微信保存） */
function exportJSON() {
  const clone = sanitizeForCloud(getRoot());
  const fs = wx.getFileSystemManager();
  const path = `${wx.env.USER_DATA_PATH}/农场成长记录备份_${util.today()}.json`;
  fs.writeFileSync(path, JSON.stringify(clone, null, 2), 'utf8');
  return path;
}

/** 从手机选择 JSON 文件恢复（整份覆盖，含所有孩子） */
function importJSON() {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success(res) {
        try {
          const fs = wx.getFileSystemManager();
          const txt = fs.readFileSync(res.tempFiles[0].path, 'utf8');
          const obj = JSON.parse(txt);
          if (!obj || !obj.users || !obj.users.length) return reject(new Error('文件格式不对'));
          _root = normalizeRoot(obj);
          save(_root);
          resolve(_root);
        } catch (e) { reject(e); }
      },
      fail: reject
    });
  });
}

module.exports = {
  STORAGE_KEY, BASE_KEY, OPENID_KEY, OLD_KEY,
  get, getRoot, getById, setCurrentUser, addUser, updateUser, removeUser,
  getTypeList, getType,
  getCoop, getActiveCoop, createCoop, contributeCoop,
  save, reset,
  on, off, emit,
  makePlant, defaultData,
  setCloudReady, cloudUpload, cloudDownload, initAccount, bindWechat,
  flushSync, isDirty, getSyncState, isAccountDegraded,
  getOpenid, getBindInfo, getWxProfile, setWxProfile, isOnboarded, isGuest,
  getComments, addComment,
  getLearner, saveLearner, getSubjectProfile, saveSubjectProfile,
  resolveGrade, parseGrade,
  exportJSON, importJSON
};

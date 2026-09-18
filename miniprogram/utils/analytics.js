/**
 * ============================================================================
 *  analytics.js —— 阶段 0 埋点（本地优先，云端尽力同步）
 *  ---------------------------------------------------------------------------
 *  事件清单（与 growth-project.md 阶段 0 规格一一对应）：
 *    app_launch   每次「启动」（同日内自动去重，用于算 D1 / D7 留存）
 *    checkin_done 完成某科打卡（childId, subject, subjectName）
 *    checkin_day  当日首次完成打卡（用于算「日打卡率」）
 *    farm_action 种 / 收 / 合种等农场动作（action, childId, ...）
 *
 *  存储：本地 wb_hwfarm_events（环形上限，防无限膨胀）。
 *  云端：环境已开通且非游客时尽力同步到云函数 syncData(logEvent)，失败静默忽略，
 *        不影响本地玩法。阶段 2 出数据时直接读这份事件流做分析。
 * ============================================================================
 */
const store = require('./store.js');
const util = require('./util.js');

const KEY = 'wb_hwfarm_events';
const MAX = 3000;                 // 本地最多保留 3000 条事件

const EVENT = {
  APP_LAUNCH: 'app_launch',
  CHECKIN_DONE: 'checkin_done',
  CHECKIN_DAY: 'checkin_day',
  FARM_ACTION: 'farm_action'
};

let _lastLaunchDate = '';         // 启动去重：最近一次记过 app_launch 的日期
let _lastDayCheckin = {};         // 当日首次打卡去重：{ childId: date }

/* --------------------------- 本地读写 --------------------------- */
function readAll() {
  try {
    const v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function writeAll(arr) {
  try { wx.setStorageSync(KEY, arr); } catch (e) {}
}

function push(rec) {
  const arr = readAll();
  arr.push(rec);
  if (arr.length > MAX) arr.splice(0, arr.length - MAX);   // 环形裁剪，保留最新
  writeAll(arr);
  tryCloudSync(rec);
}

/** 云端尽力同步：环境未开通 / 分支缺失 / 报错 → 静默忽略 */
function tryCloudSync(rec) {
  try {
    if (!store.isGuest() && wx.cloud && wx.cloud.callFunction) {
      wx.cloud.callFunction({
        name: 'syncData',
        data: { action: 'logEvent', payload: rec }
      }).catch(() => {});
    }
  } catch (e) {}
}

/* --------------------------- 对外埋点 API --------------------------- */

/** 通用埋点：自动带上 uid / childId / date / ts */
function track(event, payload) {
  const rec = Object.assign({
    event: event,
    uid: store.getOpenid() || 'local',
    childId: '',
    date: util.today(),
    ts: Date.now()
  }, payload || {});
  push(rec);
  return rec;
}

/** 启动埋点：同日内只记一次（便于后续算 D1 / D7 留存返回） */
function trackLaunch() {
  const today = util.today();
  if (_lastLaunchDate === today) return;
  _lastLaunchDate = today;
  track(EVENT.APP_LAUNCH, {});
}

/** 打卡完成埋点（同时去重记录「当日首次打卡」用于日打卡率） */
function trackCheckin(childId, subject, subjectName) {
  track(EVENT.CHECKIN_DONE, { childId: childId, subject: subject, subjectName: subjectName });
  const today = util.today();
  if (_lastDayCheckin[childId] !== today) {
    _lastDayCheckin[childId] = today;
    track(EVENT.CHECKIN_DAY, { childId: childId });
  }
}

/** 农场动作埋点（action = plant / harvest / coop_create / coop_contribute / coop_done） */
function trackFarm(action, payload) {
  track(EVENT.FARM_ACTION, Object.assign({ action: action }, payload || {}));
}

/* --------------------------- 基线计算（供「我的 → 查看体验数据」） --------------------------- */

/**
 * 计算单人基线（仅方向性，不当结论）。
 * @param {String} childId 指定孩子；不传则统计全部孩子
 */
function computeBaseline(childId) {
  const events = readAll();
  const dayCheckin = new Set();        // 有打卡的天集合（用于日打卡率）
  const coopCreated = new Set();       // 合种发起次数（用 ts 去重）
  let coopDone = 0;                    // 合种完成次数

  events.forEach(e => {
    if (!e || !e.event) return;
    if (e.event === EVENT.CHECKIN_DAY && (!childId || e.childId === childId)) {
      dayCheckin.add(e.date);
    }
    if (e.event === EVENT.FARM_ACTION && e.action === 'coop_create') coopCreated.add(e.ts);
    if (e.event === EVENT.FARM_ACTION && e.action === 'coop_done') coopDone++;
  });

  // 近 7 天打卡率
  let hit = 0;
  for (let i = 6; i >= 0; i--) {
    if (dayCheckin.has(util.daysAgo(i))) hit++;
  }
  const rate7 = Math.round((hit / 7) * 100);

  return {
    checkinDays7: rate7,                                   // 近 7 日打卡率 %
    activeDays: dayCheckin.size,                           // 累计有打卡的天数
    coopCreated: coopCreated.size,                         // 合种发起次数
    coopDone: coopDone,                                    // 合种完成次数
    coopRate: coopCreated.size ? Math.round((coopDone / coopCreated.size) * 100) : 0,
    sampleNote: '样本仅 1 个家庭，仅方向性参考，不当结论'
  };
}

module.exports = {
  EVENT,
  track,
  trackLaunch,
  trackCheckin,
  trackFarm,
  computeBaseline
};

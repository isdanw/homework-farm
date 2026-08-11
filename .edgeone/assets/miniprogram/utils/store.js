/**
 * ============================================================================
 *  store.js —— 统一数据层
 *  ---------------------------------------------------------------------------
 *  【核心联动点 ③：数据互通】
 *  作业打卡数据（homework）和农场游戏数据（farm）保存在「同一份数据对象」里，
 *  任何页面调用 save() 后都会通过 emit('change') 事件总线广播，
 *  其它已打开的页面 onShow / 监听回调里会立刻拿到最新数据 —— 无需手动刷新。
 *
 *  存储策略：
 *    1) 本地 wx.setStorageSync 主存（离线可用、秒开）
 *    2) 若开通了云开发，则异步写入云数据库集合 hw_farm_user（按 openid 一人一条）
 * ============================================================================
 */
const util = require('./util.js');
const CFG = require('./config.js');

const STORAGE_KEY = 'wb_hwfarm_data_v1';

/* --------------------------- 默认数据结构 --------------------------- */
function defaultData() {
  return {
    version: 1,
    lastActiveDate: util.today(),      // 上次打开小程序的日期（用于凌晨自动重置）
    settledDates: [],                  // 已完成夜间惩罚结算的日期，避免重复扣

    profile: {
      nickname: '小小农场主',
      streak: 0,                       // 连续全科打卡天数
      lastFullCheckinDate: '',         // 上一次三科全完成的日期
      equipped: { frame: '', skin: '' }
    },

    /* 作业打卡：{ 'YYYY-MM-DD': { chinese:{done,minutes,note,doneAt}, math:{...}, english:{...} } } */
    homework: {},

    /* 每日计划：{ 'YYYY-MM-DD': [ {id, subject, title, done} ] } */
    plans: {},

    /* 错题本 */
    errors: [],

    /* 农场数据 */
    farm: {
      coins: 20,
      suns: 1,
      seeds: { chinese: 1, math: 1, english: 0 },
      pesticide: 0,
      shields: 0,
      plots: new Array(CFG.GROWTH.PLOT_COUNT).fill(null),
      bears: [],                       // 夜间刷新的小狗熊
      lockHarvestDate: '',             // 该日期禁止收获（三科全没写的惩罚）
      shieldExchangeDate: '',          // 今天已兑换护盾的日期（每日限量）
      harvestLog: [],                  // 仓库：收获记录
      owned: [],                       // 金币商城已购买的奖励 id
      logs: []                         // 农场大事记（结算报告）
    }
  };
}

/* --------------------------- 首次使用的示例数据 --------------------------- */
/**
 * 铁律：首次打开绝不能是空白页。
 * 预置 5 条示例（含 1 条昨天逾期未完成的作业 + 1 株被啃过的植物）
 */
function seedDemo(d) {
  const today = util.today();
  const yest = util.yesterday();
  const now = Date.now();

  // 1) 昨天：只写了语文，数学英语逾期未完成（示范惩罚效果）
  d.homework[yest] = {
    chinese: { done: true, minutes: 20, note: '朗读课文 2 遍', doneAt: now - 86400000 },
    math: { done: false, minutes: 0, note: '', doneAt: 0 },
    english: { done: false, minutes: 0, note: '', doneAt: 0 }
  };
  // 2) 今天：全部待完成
  d.homework[today] = {
    chinese: { done: false, minutes: 0, note: '', doneAt: 0 },
    math: { done: false, minutes: 0, note: '', doneAt: 0 },
    english: { done: false, minutes: 0, note: '', doneAt: 0 }
  };

  // 3) 每日计划示例（含 1 条昨天没做完、会自动顺延到今天的）
  d.plans[yest] = [
    { id: util.uid('pl'), subject: 'math', title: '口算练习 20 题', done: false, from: yest }
  ];
  d.plans[today] = [
    { id: util.uid('pl'), subject: 'chinese', title: '生字抄写 1 页', done: false, from: today },
    { id: util.uid('pl'), subject: 'english', title: '英语单词跟读 10 个', done: false, from: today }
  ];

  // 4) 错题本示例
  d.errors = [
    { id: util.uid('er'), subject: 'math', title: '8 + 5 = ？ 写成了 12', reason: '进位加法算错', mastered: false, createdAt: now - 86400000 },
    { id: util.uid('er'), subject: 'chinese', title: '「暖」字写成了「爱」', reason: '形近字混淆', mastered: true, createdAt: now - 172800000 }
  ];

  // 5) 农场示例：2 株已经长起来的植物，其中 1 株被昨晚的小狗熊啃掉 1 格健康度
  const H = CFG.GROWTH.MAX_HEALTH;
  d.farm.plots[0] = makePlant('chinese', 3, H, now - 3 * 3600000, yest);       // 成熟的樱花
  d.farm.plots[4] = makePlant('math', 1, H - 1, now - 1 * 3600000, yest);      // 发芽 + 被啃过 1 格
  d.farm.harvestLog = [
    { id: util.uid('hv'), subject: 'english', coin: 8, date: yest, time: '昨天' }
  ];
  d.farm.logs = [
    { date: yest, type: 'punish', text: '昨晚有 2 科作业没写完，小狗熊啃坏了菜园，还被偷走了一半金币' }
  ];
  return d;
}

/** 生成一株植物对象 */
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
let _cache = null;

function get() {
  if (_cache) return _cache;
  let d = null;
  try {
    d = wx.getStorageSync(STORAGE_KEY);
  } catch (e) {
    console.warn('[store] read fail', e);
  }
  if (!d || !d.farm) {
    d = seedDemo(defaultData());
    d.__isDemo = true;   // 标记：当前是示例数据，可一键清空
    try { wx.setStorageSync(STORAGE_KEY, d); } catch (e) {}
  }
  // 兼容旧版本：补齐可能缺失的字段
  const def = defaultData();
  Object.keys(def).forEach(k => { if (d[k] === undefined) d[k] = def[k]; });
  Object.keys(def.farm).forEach(k => { if (d.farm[k] === undefined) d.farm[k] = def.farm[k]; });
  _cache = d;
  return _cache;
}

/**
 * 保存并广播（页面之间实时同步就靠它）
 * @param {Object} d     数据对象（不传则保存当前缓存）
 * @param {Boolean} sync 是否同时写云数据库
 */
function save(d, sync) {
  _cache = d || _cache;
  try {
    wx.setStorageSync(STORAGE_KEY, _cache);
  } catch (e) {
    console.error('[store] save fail', e);
  }
  emit(_cache);                        // ← 广播：所有页面立即拿到最新数据
  if (sync !== false) cloudUpload();   // 异步上云，不阻塞 UI
  return _cache;
}

/** 重置为全新数据（清空示例 / 清空全部） */
function reset(keepProfile) {
  const old = get();
  const d = defaultData();
  if (keepProfile) d.profile = old.profile;
  d.__isDemo = false;
  _cache = d;
  save(d);
  return d;
}

/* --------------------------- 云数据库同步 --------------------------- */
let cloudReady = false;
function setCloudReady(v) { cloudReady = v; }

/** 上行：本地 → 云（防抖 2 秒，避免频繁写库） */
let uploadTimer = null;
function cloudUpload() {
  if (!cloudReady) return;
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    wx.cloud.callFunction({
      name: 'syncData',
      data: { action: 'upload', payload: _cache }
    }).catch(err => console.warn('[store] 云同步失败（不影响本地使用）', err));
  }, 2000);
}

/** 下行：云 → 本地（换手机后恢复数据） */
function cloudDownload() {
  return new Promise((resolve) => {
    if (!cloudReady) return resolve(null);
    wx.cloud.callFunction({ name: 'syncData', data: { action: 'download' } })
      .then(res => {
        const remote = res && res.result && res.result.data;
        if (remote && remote.farm) {
          _cache = remote;
          wx.setStorageSync(STORAGE_KEY, remote);
          emit(_cache);
          resolve(remote);
        } else resolve(null);
      })
      .catch(() => resolve(null));
  });
}

/* --------------------------- 导出 / 导入备份 --------------------------- */
/** 导出 JSON 到手机文件（可分享给家长微信保存） */
function exportJSON() {
  const d = get();
  const fs = wx.getFileSystemManager();
  const path = `${wx.env.USER_DATA_PATH}/农场作业本备份_${util.today()}.json`;
  fs.writeFileSync(path, JSON.stringify(d, null, 2), 'utf8');
  return path;
}

/** 从手机选择 JSON 文件恢复（不限条数） */
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
          if (!obj || !obj.farm) return reject(new Error('文件格式不对'));
          _cache = obj;
          save(obj);
          resolve(obj);
        } catch (e) { reject(e); }
      },
      fail: reject
    });
  });
}

module.exports = {
  STORAGE_KEY,
  get, save, reset,
  on, off, emit,
  makePlant, defaultData,
  setCloudReady, cloudUpload, cloudDownload,
  exportJSON, importJSON
};

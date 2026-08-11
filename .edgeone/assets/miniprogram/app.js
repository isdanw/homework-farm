/**
 * app.js —— 小程序入口
 * 职责：
 *   1) 初始化云开发（没开通也能正常离线使用）
 *   2) 启动/切前台时执行「每日凌晨自动重置 + 夜间惩罚结算」
 *   3) 把待弹窗的结算报告放进 globalData，农场页 onShow 时弹出
 */
const store = require('./utils/store.js');
const engine = require('./utils/farmEngine.js');
const util = require('./utils/util.js');

App({
  globalData: {
    cloudReady: false,
    pendingReport: null,     // 待展示的夜间结算报告
    ENV_ID: 'your-env-id'    // ← 换成你自己的云开发环境 ID（未开通留空即可）
  },

  onLaunch() {
    this.initCloud();
    this.runDailyRollover();
  },

  /** 从后台切回前台：可能已经跨天，需要重新结算一次 */
  onShow() {
    this.runDailyRollover();
  },

  /** 初始化云开发（失败不影响本地玩法） */
  initCloud() {
    if (!wx.cloud) return;
    try {
      wx.cloud.init({
        env: this.globalData.ENV_ID && this.globalData.ENV_ID !== 'your-env-id'
          ? this.globalData.ENV_ID
          : undefined,
        traceUser: true
      });
      this.globalData.cloudReady = true;
      store.setCloudReady(true);
      // 首次安装时尝试从云端拉回历史数据（换手机 / 重装恢复）
      store.cloudDownload();
    } catch (e) {
      console.warn('[app] 云开发未开通，使用本地存储模式', e);
      this.globalData.cloudReady = false;
      store.setCloudReady(false);
    }
  },

  /** 每日重置 + 夜间结算（联动逻辑总入口） */
  runDailyRollover() {
    const d = store.get();
    const report = engine.dailyRollover(d);
    engine.growTick(d);
    if (report) this.globalData.pendingReport = report;
    this._lastCheckDate = util.today();
  }
});

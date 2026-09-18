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
const analytics = require('./utils/analytics.js');

App({
  globalData: {
    cloudReady: false,
    pendingReport: null,     // 待展示的夜间结算报告
    cloudRestoreFailed: false, // 启动恢复云端数据失败（网络/云异常），前端提示用
    ENV_ID: 'workbuddy-d2gsgtfvmde5c9adf'
  },

  async onLaunch() {
    this.initCloud();
    // 先确认微信账号（openid）+ 加载/恢复本账号数据，再跑每日结算
    try { await store.initAccount(); } catch (e) { console.warn('[app] initAccount 失败', e); }
    // 游客与已登录用户都直接从 pages[0]（首页）进入，不再强制登录门拦截
    this.runDailyRollover();
    analytics.trackLaunch();            // 阶段 0 埋点：记录一次启动（同日内去重）
    if (this.globalData.cloudRestoreFailed) {
      setTimeout(() => {
        wx.showToast({ title: '云端恢复失败，已本地暂存，请检查网络后重开', icon: 'none' });
      }, 600);
    }
  },

  /** 从后台切回前台：可能已经跨天，需要重新结算一次 */
  onShow() {
    this.runDailyRollover();
    analytics.trackLaunch();            // 阶段 0 埋点：回到前台也算一次启动（同日内去重）
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
      // 云端数据恢复放在 store.initAccount() 里（需先确认 openid 再按账号下载）
    } catch (e) {
      console.warn('[app] 云开发未开通，使用本地存储模式', e);
      this.globalData.cloudReady = false;
      store.setCloudReady(false);
    }
  },

  /** 每日重置 + 夜间结算（联动逻辑总入口）
   *  遍历所有孩子分别结算，仅把「当前孩子」的结算报告放进 pendingReport */
  runDailyRollover() {
    const root = store.getRoot();
    let pending = null;
    root.users.forEach(u => {
      const report = engine.dailyRollover(u);
      engine.growTick(u);
      if (u.id === root.currentUserId && report) pending = report;
    });
    this.globalData.pendingReport = pending;
    this._lastCheckDate = util.today();
  }
});

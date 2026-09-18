/**
 * app.js —— 小程序入口
 * 职责：
 *   1) 初始化云开发（没开通也能正常离线使用）
 *   2) 启动/切前台时执行「每日凌晨自动重置 + 夜间惩罚结算」
 *   3) 把待弹窗的结算报告放进 globalData，农场页 onShow 时弹出
 *   4) 【数据可靠性】onHide 立刻把未上云的改动推上去（堵防抖窗口），
 *      onShow / 启动补推积压改动，同步降级时给出可见提示
 */
const store = require('./utils/store.js');
const tutorStore = require('./utils/tutorStore.js');
const engine = require('./utils/farmEngine.js');
const util = require('./utils/util.js');
const analytics = require('./utils/analytics.js');

App({
  globalData: {
    cloudReady: false,
    pendingReport: null,     // 待展示的夜间结算报告
    cloudRestoreFailed: false, // 启动恢复云端数据失败（网络/云异常），前端提示用
    syncDegraded: false,       // 本地已存但暂未上云（身份未确认 / 云端保护期）
    ENV_ID: 'workbuddy-d2gsgtfvmde5c9adf'
  },

  async onLaunch() {
    this.initCloud();
    // 先确认微信账号（openid）+ 加载/恢复本账号数据，再跑每日结算
    try { await store.initAccount(); } catch (e) { console.warn('[app] initAccount 失败', e); }
    // 游客与已登录用户都直接从 pages[0]（首页）进入，不再强制登录门拦截
    this.runDailyRollover();
    analytics.trackLaunch();            // 阶段 0 埋点：记录一次启动（同日内去重）
    this.warnSyncDegraded();
  },

  /** 从后台切回前台：可能已经跨天，需要重新结算一次；顺便补推积压的未上云改动 */
  onShow() {
    this.runDailyRollover();
    analytics.trackLaunch();            // 阶段 0 埋点：回到前台也算一次启动（同日内去重）
    store.flushSync();                  // 补推上次失败 / 上次被系统回收时积压的改动
    tutorStore.pushQueued();            // 导学链路同理：把待补写的错题/复习窗口推上去
    this.warnSyncDegraded();
  },

  /** 切后台：把「2 秒防抖窗口内」的改动立刻推上云。
   *  不加这一步时，用户打卡后 2 秒内退出，定时器被销毁 → 该次操作永不上云。
   *  导学链路的补推队列是持久化的（写入 pushQueue），此处顺手清一次积压。 */
  onHide() {
    store.flushSync(true);
    tutorStore.pushQueued();
  },

  /**
   * 同步降级提示：本地已保存、但暂未上云。
   * 旧实现在这条路径上完全静默 —— 用户操作照常、界面照常，重启后数据没了却毫无线索。
   * 现在明确告知「数据已存在本机 / 联网后自动补传」，并区分是否处于云端保护期。
   */
  warnSyncDegraded() {
    if (this._degradedWarned) return;
    const s = store.getSyncState();
    if (!s.degraded) return;
    this._degradedWarned = true;
    setTimeout(() => {
      wx.showToast({
        title: s.blocked
          ? '云端暂时连不上，数据已存本机，联网后会自动补传'
          : '网络异常，数据已存本机，联网后会自动补传',
        icon: 'none',
        duration: 3000
      });
    }, 600);
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

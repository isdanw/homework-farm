/**
 * ============================================================================
 *  我的农场（小游戏主页面）
 *  ---------------------------------------------------------------------------
 *  【联动位置一览】
 *   1) onShow → getApp().runDailyRollover()：跨天重置 + 夜间惩罚结算
 *   2) onShow → 未完成作业弹窗：「还有 X 科作业未完成，今晚小狗熊会来破坏你的菜园！」
 *   3) 种子只有完成对应学科作业才会 +1（数量为 0 时地块显示「未解锁」）
 *   4) 小狗熊 bears 来自 farmEngine.nightSettle()，用杀虫剂（补作业获得）才能清除
 *   5) 枯萎植物 withered=true → 灰色褪色特效 class="withered"
 * ============================================================================
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const util = require('../../utils/util.js');
const CFG = require('../../utils/config.js');

Page({
  data: {
    tab: 'farm',                 // farm 种植地块 / depot 仓库 / shop 商店 / bag 背包
    night: false,
    skinClass: '',
    res: { coins: 0, suns: 0, pesticide: 0, shields: 0, seeds: {} },
    seedList: [],
    plots: [],
    bears: [],
    forecast: {},
    streak: 0,
    // 弹窗
    showWarn: false, warnText: '',
    showReport: false, report: null,
    showSeed: false, seedPlot: -1,
    showAction: false, actionIndex: -1, actionPlant: null,
    // 其它 tab 数据
    shopList: [], harvestLog: [], depotStat: [], logs: [], ownedList: [],
    stageNames: CFG.GROWTH.STAGE_NAMES
  },

  onLoad() {
    this._onChange = () => this.render();
    store.on(this._onChange);
  },
  onUnload() { store.off(this._onChange); },

  onShow() {
    if (this.getTabBar) { const tb = this.getTabBar(); if (tb) tb.setData({ selected: 4 }); }

    const app = getApp();
    app.runDailyRollover();          // ← 联动 1：跨天重置 + 夜间结算
    this.render();

    // 有夜间结算报告先弹报告，关闭后再弹作业警告
    if (app.globalData.pendingReport) {
      this.setData({ showReport: true, report: this.buildReport(app.globalData.pendingReport) });
      app.globalData.pendingReport = null;
    } else {
      this.checkHomeworkWarn();      // ← 联动 2：未完成作业弹窗
    }

    // 页面停留时每 30 秒推进一次自然生长
    this._timer = setInterval(() => {
      if (engine.growTick(store.get())) this.render();
    }, 30000);
  },

  onHide() { clearInterval(this._timer); },

  /* ======================= 渲染 ======================= */
  render() {
    const d = store.get();
    const f = d.farm;
    const night = util.isNight(CFG.PUNISH.NIGHT_HOUR);

    // 地块
    const plots = f.plots.map((p, i) => {
      if (!p) return { index: i, empty: true };
      const s = CFG.getSubject(p.subject);
      const hearts = [];
      for (let h = 0; h < CFG.GROWTH.MAX_HEALTH; h++) hearts.push(h < p.health);
      return {
        index: i, empty: false,
        subject: p.subject, shape: s.shape, color: s.color, colorDeep: s.colorDeep,
        name: s.cropName, stage: p.stage, stageName: CFG.GROWTH.STAGE_NAMES[p.stage],
        health: p.health, hearts: hearts,
        withered: p.withered, bitten: p.bitten,
        mature: p.stage >= CFG.GROWTH.MAX_STAGE && !p.withered,
        isToday: p.plantedDate === util.today()
      };
    });

    // 种子（未完成作业 = 数量 0 = 未解锁）
    const seedList = CFG.SUBJECTS.map(s => ({
      key: s.key, name: s.name, seedName: s.seedName, cropName: s.cropName,
      color: s.color, colorDeep: s.colorDeep, shape: s.shape,
      count: f.seeds[s.key] || 0,
      locked: (f.seeds[s.key] || 0) <= 0
    }));

    // 商店（护盾显示解锁进度）
    const shopList = CFG.SHOP.map(it => {
      const o = Object.assign({}, it);
      if (it.type === 'streak') {
        o.canBuy = d.profile.streak >= it.needStreak && f.shieldExchangeDate !== util.today();
        o.tip = d.profile.streak >= it.needStreak
          ? (f.shieldExchangeDate === util.today() ? '今天已兑换，明天再来' : '可以兑换啦！')
          : `连续打卡 ${d.profile.streak}/${it.needStreak} 天`;
      } else {
        o.canBuy = f.coins >= it.price;
        o.tip = o.canBuy ? '金币充足' : `还差 ${it.price - f.coins} 金币`;
      }
      return o;
    });

    // 仓库统计
    const depotStat = CFG.SUBJECTS.map(s => {
      const rows = f.harvestLog.filter(h => h.subject === s.key);
      return { name: s.cropName, subName: s.name, color: s.color, count: rows.length, coin: rows.reduce((a, b) => a + b.coin, 0) };
    });

    // 背包里的商城奖励
    const ownedList = f.owned.map(id => {
      const it = CFG.MALL.find(m => m.id === id);
      if (!it) return null;
      return Object.assign({}, it, {
        equipped: d.profile.equipped.skin === id || d.profile.equipped.frame === id
      });
    }).filter(Boolean);

    this.setData({
      night,
      skinClass: d.profile.equipped.skin ? 'skin-' + d.profile.equipped.skin.replace('skin_', '') : '',
      res: { coins: f.coins, suns: f.suns, pesticide: f.pesticide, shields: f.shields, seeds: f.seeds },
      seedList, plots,
      bears: f.bears.map((b, i) => Object.assign({}, b, { delay: (i * 0.4).toFixed(1) })),
      forecast: engine.forecast(d),
      streak: d.profile.streak,
      shopList,
      harvestLog: f.harvestLog.slice(0, 30),
      depotStat,
      logs: f.logs.slice(0, 10).map(l => Object.assign({}, l, { dateText: util.cnDate(l.date) })),
      ownedList,
      lockHarvest: f.lockHarvestDate === util.today()
    });
  },

  /* ======================= 联动 2：未完成作业弹窗 ======================= */
  checkHomeworkWarn() {
    const d = store.get();
    const missing = engine.missingSubjects(d, util.today());
    if (missing.length === 0) return;
    const names = missing.map(k => CFG.getSubject(k).name).join('、');
    const text = CFG.TEXT.FARM_WARN_CONTENT.replace('{n}', missing.length).replace('{s}', names);
    this.setData({ showWarn: true, warnText: text });
  },
  closeWarn() { this.setData({ showWarn: false }); },
  goCheckin() { this.setData({ showWarn: false }); wx.switchTab({ url: '/pages/checkin/checkin' }); },

  /* ======================= 夜间结算报告 ======================= */
  buildReport(r) {
    return Object.assign({}, r, {
      dateText: util.cnDate(r.date),
      missingText: r.missing.length ? r.missing.join('、') : '无'
    });
  },
  closeReport() {
    this.setData({ showReport: false });
    this.checkHomeworkWarn();
  },

  /* ======================= tab 切换 ======================= */
  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.t }); },

  /* ======================= 种植 / 操作 ======================= */
  tapPlot(e) {
    const i = e.currentTarget.dataset.i;
    const p = this.data.plots[i];
    if (p.empty) {
      this.setData({ showSeed: true, seedPlot: i });
    } else {
      this.setData({ showAction: true, actionIndex: i, actionPlant: p });
    }
  },
  closeSeed() { this.setData({ showSeed: false }); },
  closeAction() { this.setData({ showAction: false }); },

  doPlant(e) {
    const key = e.currentTarget.dataset.key;
    const res = engine.plantSeed(store.get(), this.data.seedPlot, key);
    util.toast(res.msg, res.ok ? 'success' : 'none');
    if (res.ok) this.setData({ showSeed: false });
  },

  doSun() {
    const res = engine.useSun(store.get(), this.data.actionIndex);
    util.toast(res.msg, res.ok ? 'success' : 'none');
    if (res.ok) {
      const p = this.data.plots[this.data.actionIndex];
      this.setData({ showAction: false });
      // 长大特效
      this.playGrowFx(this.data.actionIndex);
    }
  },
  playGrowFx(i) {
    this.setData({ growFx: i });
    setTimeout(() => this.setData({ growFx: -1 }), 900);
  },

  doHarvest() {
    const res = engine.harvest(store.get(), this.data.actionIndex);
    util.toast(res.msg, res.ok ? 'success' : 'none');
    if (res.ok) this.setData({ showAction: false });
  },

  doClear() {
    const res = engine.clearPlot(store.get(), this.data.actionIndex);
    util.toast(res.msg, res.ok ? 'success' : 'none');
    if (res.ok) this.setData({ showAction: false });
  },

  /* ======================= 联动 4：杀虫剂修复 ======================= */
  doPesticide() {
    const res = engine.usePesticide(store.get());
    if (!res.ok) return util.toast(res.msg);
    wx.showModal({
      title: '小狗熊被赶跑啦！',
      content: res.msg,
      showCancel: false,
      confirmText: '太好了',
      confirmColor: '#5FBF6B'
    });
  },

  /* ======================= 商店 ======================= */
  buyShop(e) {
    const id = e.currentTarget.dataset.id;
    const res = engine.buyShop(store.get(), id);
    util.toast(res.msg, res.ok ? 'success' : 'none');
  },

  /* ======================= 背包：装备奖励 ======================= */
  equip(e) {
    const id = e.currentTarget.dataset.id;
    const res = engine.equipItem(store.get(), id);
    util.toast(res.msg, res.ok ? 'success' : 'none');
  },

  goMall() { wx.navigateTo({ url: '/pages/mall/mall' }); }
});

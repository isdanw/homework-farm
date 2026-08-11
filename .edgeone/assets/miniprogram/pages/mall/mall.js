/**
 * 金币商城
 *  金币来源 = 农场作物收获 = 作业完成度，形成「写作业 → 种植 → 收获 → 换奖励」正循环。
 *  奖励分三类：虚拟奖状 / 卡通头像框 / 学习皮肤（会改变农场背景配色）
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const util = require('../../utils/util.js');
const CFG = require('../../utils/config.js');

Page({
  data: {
    coins: 0,
    tab: 'cert',
    list: [],
    showCert: false,
    cert: null,
    nickname: '',
    frameClass: ''
  },

  onLoad() {
    this._onChange = () => this.render();
    store.on(this._onChange);
    this.render();
  },
  onUnload() { store.off(this._onChange); },
  onShow() { this.render(); },

  render() {
    const d = store.get();
    const list = CFG.MALL.filter(m => m.kind === this.data.tab).map(m => Object.assign({}, m, {
      owned: d.farm.owned.indexOf(m.id) >= 0,
      equipped: d.profile.equipped.skin === m.id || d.profile.equipped.frame === m.id,
      canBuy: d.farm.coins >= m.price
    }));
    this.setData({
      coins: d.farm.coins,
      list,
      nickname: d.profile.nickname,
      streak: d.profile.streak,
      frameClass: d.profile.equipped.frame ? 'frame-' + d.profile.equipped.frame.replace('frame_', '') : ''
    });
  },

  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.t }, () => this.render()); },

  buy(e) {
    const id = e.currentTarget.dataset.id;
    const item = CFG.MALL.find(m => m.id === id);
    wx.showModal({
      title: '兑换奖励',
      content: `要花 ${item.price} 金币兑换「${item.name}」吗？`,
      confirmColor: '#5FBF6B',
      success: (res) => {
        if (!res.confirm) return;
        const r = engine.buyMall(store.get(), id);
        util.toast(r.msg, r.ok ? 'success' : 'none');
        if (r.ok && item.kind === 'cert') this.openCert(id);
      }
    });
  },

  equip(e) {
    const r = engine.equipItem(store.get(), e.currentTarget.dataset.id);
    util.toast(r.msg, r.ok ? 'success' : 'none');
  },

  openCert(id) {
    const key = typeof id === 'string' ? id : id.currentTarget.dataset.id;
    const d = store.get();
    const item = CFG.MALL.find(m => m.id === key);
    if (!item || d.farm.owned.indexOf(key) < 0) return util.toast('先兑换才能看奖状哦');
    this.setData({
      showCert: true,
      cert: {
        name: item.name, color: item.color,
        nickname: d.profile.nickname,
        date: util.cnDate(util.today()),
        streak: d.profile.streak,
        harvest: d.farm.harvestLog.length
      }
    });
  },
  tapCert(e) { this.openCert(e); },
  closeCert() { this.setData({ showCert: false }); },

  back() { wx.navigateBack(); }
});

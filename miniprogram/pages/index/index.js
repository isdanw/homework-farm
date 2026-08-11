/**
 * 学习乐园（原「每日计划」）→ 三大学习模块的入口枢纽
 *  · 吉祥物问候 + 今日三科打卡状态（数据层实时同步）
 *  · 三扇学科大门：点进去进入对应学习模块
 *  · 底部保留「家长工具」：导出/导入备份、清空示例
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const util = require('../../utils/util.js');
const CFG = require('../../utils/config.js');

// 三扇大门：学科 key ↔ 模块页面 ↔ 展示色
const DOORS = [
  { key: 'chinese', name: '拼音汉字', emoji: '🔤', grad: 'door-cn', page: '/pages/learn-pinyin/learn-pinyin' },
  { key: 'math',    name: '数学乐园', emoji: '🔢', grad: 'door-ma', page: '/pages/learn-math/learn-math' },
  { key: 'english', name: '英语启蒙', emoji: '🔠', grad: 'door-en', page: '/pages/learn-english/learn-english' }
];

Page({
  data: {
    dateText: '', weekText: '', streak: 0,
    doors: [],
    doneNum: 0, percent: 0,
    learnStars: 0,
    farm: { coins: 0, suns: 0, bears: 0, pesticide: 0 },
    forecast: {},
    showTools: false,
    isDemo: false
  },

  onLoad() {
    this._onChange = () => this.render();
    store.on(this._onChange);
  },
  onUnload() { store.off(this._onChange); },

  onShow() {
    if (this.getTabBar) {
      const tb = this.getTabBar();
      if (tb) tb.setData({ selected: 0 });
    }
    getApp().runDailyRollover();
    this.render();
  },

  render() {
    const d = store.get();
    const today = util.today();
    const hw = engine.ensureDay(d, today);

    const doors = DOORS.map(o => {
      const done = hw[o.key].done;
      return Object.assign({}, o, { done, status: done ? '已完成 ✓' : '未开始' });
    });
    const doneNum = doors.filter(x => x.done).length;

    this.setData({
      dateText: util.cnDate(today),
      weekText: util.weekday(today),
      streak: d.profile.streak,
      doors,
      doneNum,
      percent: Math.round(doneNum / DOORS.length * 100),
      learnStars: d.learn ? d.learn.stars : 0,
      farm: { coins: d.farm.coins, suns: d.farm.suns, bears: d.farm.bears.length, pesticide: d.farm.pesticide },
      forecast: engine.forecast(d),
      isDemo: !!d.__isDemo
    });
  },

  /* 进入学科模块 */
  openModule(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.page });
  },

  goCheckin() { wx.switchTab({ url: '/pages/checkin/checkin' }); },
  goFarm() { wx.switchTab({ url: '/pages/farm/farm' }); },

  /* 家长工具 */
  toggleTools() { this.setData({ showTools: !this.data.showTools }); },
  exportData() {
    try {
      const path = store.exportJSON();
      wx.shareFileMessage({
        filePath: path,
        success: () => util.toast('备份已发送，记得保存到微信收藏', 'success'),
        fail: () => wx.openDocument({ filePath: path, showMenu: true, fail: () => util.toast('备份文件已生成：' + path) })
      });
    } catch (e) { util.toast('导出失败：' + e.message); }
  },
  importData() {
    store.importJSON()
      .then(() => { util.toast('恢复成功！', 'success'); this.render(); })
      .catch(err => { if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) return; util.toast('导入失败，请选择正确的备份文件'); });
  },
  clearDemo() {
    wx.showModal({
      title: '清空示例数据',
      content: '会删除预置的示例任务、示例笔记和示例植物，重新开始记录。确定吗？',
      confirmColor: '#FF7A7A',
      success: (res) => { if (!res.confirm) return; store.reset(true); this.render(); util.toast('已清空，开始你的农场吧！', 'success'); }
    });
  }
});

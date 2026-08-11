/**
 * 学习统计页
 *  把「学习数据」和「农场收益 / 被惩罚次数」放在一起对比，
 *  让孩子直观看到：写作业越勤快，农场越富有。
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const util = require('../../utils/util.js');
const CFG = require('../../utils/config.js');

Page({
  data: {
    summary: {},
    bars: [],          // 近 14 天柱状图
    subjectRate: [],   // 三科完成率
    logs: [],          // 农场大事记
    maxCoinDay: 0
  },

  onLoad() {
    this._onChange = () => this.render();
    store.on(this._onChange);
  },
  onUnload() { store.off(this._onChange); },

  onShow() {
    if (this.getTabBar) { const tb = this.getTabBar(); if (tb) tb.setData({ selected: 2 }); }
    this.render();
  },

  render() {
    const d = store.get();
    const DAYS = 14;

    // —— 近 14 天柱状图 ——
    const bars = [];
    let totalDone = 0, totalDays = 0;
    for (let i = DAYS - 1; i >= 0; i--) {
      const k = util.daysAgo(i);
      const rec = d.homework[k];
      const n = rec ? engine.SUB_KEYS.filter(x => rec[x] && rec[x].done).length : 0;
      if (rec) { totalDays++; totalDone += n; }
      bars.push({
        key: k,
        num: n,
        height: 20 + n * 60,                 // rpx 高度：0科=20，3科=200
        label: Number(k.split('-')[2]),
        isToday: i === 0,
        full: n === 3
      });
    }

    // —— 三科完成率 ——
    const subjectRate = CFG.SUBJECTS.map(s => {
      let done = 0, all = 0;
      Object.keys(d.homework).forEach(k => {
        const r = d.homework[k][s.key];
        if (!r) return;
        all++;
        if (r.done) done++;
      });
      const rate = all ? Math.round(done / all * 100) : 0;
      return { name: s.name, color: s.color, rate, done, all };
    });

    // —— 汇总 ——
    const punishTimes = d.farm.logs.filter(l => l.type === 'punish').length;
    const totalCoinEarned = d.farm.harvestLog.reduce((s, h) => s + h.coin, 0);
    const summary = {
      streak: d.profile.streak,
      fullDays: bars.filter(b => b.full).length,
      avg: totalDays ? (totalDone / totalDays).toFixed(1) : '0.0',
      coins: d.farm.coins,
      earned: totalCoinEarned,
      harvest: d.farm.harvestLog.length,
      errors: d.errors.length,
      errorsLeft: d.errors.filter(e => !e.mastered).length,
      punishTimes: punishTimes,
      bears: d.farm.bears.length
    };

    this.setData({
      bars, subjectRate, summary,
      logs: d.farm.logs.slice(0, 12).map(l => Object.assign({}, l, { dateText: util.cnDate(l.date) }))
    });
  },

  goCheckin() { wx.switchTab({ url: '/pages/checkin/checkin' }); }
});

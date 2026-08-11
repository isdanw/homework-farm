/**
 * 作业打卡页
 *  【联动核心】每完成一科 → engine.checkin() 立刻发放「1 阳光 + 1 学科种子」，
 *  数据写入后通过 store 事件总线广播，农场页无需手动刷新即可看到新种子。
 *  三科全完成 → 额外金币 + 连续打卡天数 +1；若当天已被小狗熊惩罚过，补齐后发杀虫剂。
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const util = require('../../utils/util.js');
const CFG = require('../../utils/config.js');

Page({
  data: {
    dateText: '',
    cards: [],
    doneNum: 0,
    forecast: {},
    minuteOptions: [10, 20, 30, 45],
    editing: '',            // 正在填写备注的学科
    noteText: '',
    pickMinutes: 20,
    reward: null,           // 奖励弹窗数据
    week: []                // 近 7 天完成情况
  },

  onLoad() {
    this._onChange = () => this.render();
    store.on(this._onChange);
  },
  onUnload() { store.off(this._onChange); },

  onShow() {
    if (this.getTabBar) { const tb = this.getTabBar(); if (tb) tb.setData({ selected: 1 }); }
    getApp().runDailyRollover();
    this.render();
  },

  render() {
    const d = store.get();
    const today = util.today();
    const hw = engine.ensureDay(d, today);

    const cards = CFG.SUBJECTS.map(s => ({
      key: s.key, name: s.name, icon: s.icon, color: s.color, colorDeep: s.colorDeep,
      seedName: s.seedName,
      done: hw[s.key].done,
      minutes: hw[s.key].minutes,
      note: hw[s.key].note,
      timeText: hw[s.key].doneAt ? formatTime(hw[s.key].doneAt) : ''
    }));

    // 近 7 天完成情况（今天在最右）
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const k = util.daysAgo(i);
      const rec = d.homework[k];
      const n = rec ? engine.SUB_KEYS.filter(x => rec[x] && rec[x].done).length : 0;
      week.push({ key: k, label: util.cnDate(k).replace('月', '/').replace('日', ''), num: n, isToday: i === 0 });
    }

    this.setData({
      dateText: util.cnDate(today) + ' ' + util.weekday(today),
      cards,
      doneNum: cards.filter(c => c.done).length,
      forecast: engine.forecast(d),
      week
    });
  },

  /* ------------------ 打卡（发奖励）------------------ */
  doCheckin(e) {
    const key = e.currentTarget.dataset.key;
    const d = store.get();
    const gain = engine.checkin(d, key, { minutes: this.data.pickMinutes, note: '' });
    if (!gain) return;
    this.setData({ reward: gain });
    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
  },

  closeReward() { this.setData({ reward: null }); },
  goFarmFromReward() { this.setData({ reward: null }); wx.switchTab({ url: '/pages/farm/farm' }); },

  /* ------------------ 撤销打卡 ------------------ */
  undoCheckin(e) {
    const key = e.currentTarget.dataset.key;
    wx.showModal({
      title: '撤销打卡',
      content: '撤销后会收回这一科奖励的阳光和种子，确定吗？',
      confirmColor: '#FF7A7A',
      success: (res) => {
        if (!res.confirm) return;
        engine.uncheckin(store.get(), key);
        util.toast('已撤销');
      }
    });
  },

  /* ------------------ 用时选择 / 备注 ------------------ */
  pickMinute(e) { this.setData({ pickMinutes: e.currentTarget.dataset.m }); },
  openNote(e) {
    const key = e.currentTarget.dataset.key;
    const c = this.data.cards.find(x => x.key === key);
    this.setData({ editing: key, noteText: c ? c.note : '' });
  },
  onNoteInput(e) { this.setData({ noteText: e.detail.value }); },
  saveNote() {
    const d = store.get();
    const hw = engine.ensureDay(d, util.today());
    hw[this.data.editing].note = this.data.noteText;
    store.save(d);
    this.setData({ editing: '' });
    util.toast('已记录', 'success');
  },
  closeNote() { this.setData({ editing: '' }); },

  goFarm() { wx.switchTab({ url: '/pages/farm/farm' }); }
});

function formatTime(ts) {
  const t = new Date(ts);
  return util.pad(t.getHours()) + ':' + util.pad(t.getMinutes());
}

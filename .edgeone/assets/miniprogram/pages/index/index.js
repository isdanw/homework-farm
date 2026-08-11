/**
 * 每日计划页
 *  · 首屏「今天要处理」：逾期计划 + 今天没写完的作业，红色标注 + 一键处理
 *  · 昨天没做完的计划会自动顺延到今天（engine.carryOverPlans）
 *  · 首屏提供「导出 JSON 备份 / 导入恢复」，数据不怕丢
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const util = require('../../utils/util.js');
const CFG = require('../../utils/config.js');

Page({
  data: {
    dateText: '', weekText: '',
    subjects: [], doneNum: 0, percent: 0,
    todo: [],                 // 今天要处理
    plans: [],
    farm: { coins: 0, suns: 0, bears: 0, pesticide: 0 },
    forecast: {},
    showAdd: false,
    newTitle: '', newSubject: 'chinese',
    subjectOptions: CFG.SUBJECTS,
    backupTip: false,
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

  /** 统一渲染（数据层变化时也会被自动调用 → 实时同步） */
  render() {
    const d = store.get();
    const today = util.today();
    const hw = engine.ensureDay(d, today);

    const subjects = CFG.SUBJECTS.map(s => ({
      key: s.key, name: s.name, icon: s.icon, color: s.color,
      done: hw[s.key].done, minutes: hw[s.key].minutes
    }));
    const doneNum = subjects.filter(s => s.done).length;

    // —— 今天要处理：逾期计划优先，其次未完成作业 ——
    const plans = (d.plans[today] || []).map(p => Object.assign({}, p, {
      subName: CFG.getSubject(p.subject).name,
      icon: CFG.getSubject(p.subject).icon,
      color: CFG.getSubject(p.subject).color
    }));
    const todo = [];
    plans.filter(p => !p.done && p.overdue).forEach(p => {
      todo.push({ kind: 'plan', id: p.id, title: p.title, tag: '逾期 · ' + util.cnDate(p.from) + ' 顺延过来', overdue: true, color: p.color, icon: p.icon });
    });
    subjects.filter(s => !s.done).forEach(s => {
      todo.push({ kind: 'hw', id: s.key, title: s.name + '作业还没打卡', tag: '今天必须完成，否则小狗熊来袭', overdue: false, color: s.color, icon: s.icon });
    });
    plans.filter(p => !p.done && !p.overdue).forEach(p => {
      todo.push({ kind: 'plan', id: p.id, title: p.title, tag: '今日计划', overdue: false, color: p.color, icon: p.icon });
    });

    // 数据量提示导出备份
    const total = Object.keys(d.homework).length + d.errors.length + d.farm.harvestLog.length;

    this.setData({
      dateText: util.cnDate(today),
      weekText: util.weekday(today),
      subjects, doneNum,
      percent: Math.round(doneNum / CFG.SUBJECTS.length * 100),
      todo, plans,
      farm: { coins: d.farm.coins, suns: d.farm.suns, bears: d.farm.bears.length, pesticide: d.farm.pesticide },
      forecast: engine.forecast(d),
      streak: d.profile.streak,
      backupTip: total >= CFG.BACKUP_TIP_COUNT,
      isDemo: !!d.__isDemo
    });
  },

  /* ------------------ 今天要处理：一键处理 ------------------ */
  handleTodo(e) {
    const item = e.currentTarget.dataset.item;
    if (item.kind === 'hw') {
      wx.switchTab({ url: '/pages/checkin/checkin' });   // 跳去打卡
    } else {
      const d = store.get();
      const list = d.plans[util.today()] || [];
      const t = list.find(x => x.id === item.id);
      if (t) { t.done = true; t.overdue = false; store.save(d); util.toast('完成啦，真棒！', 'success'); }
    }
  },

  togglePlan(e) {
    const id = e.currentTarget.dataset.id;
    const d = store.get();
    const list = d.plans[util.today()] || [];
    const t = list.find(x => x.id === id);
    if (t) { t.done = !t.done; if (t.done) t.overdue = false; store.save(d); }
  },

  delPlan(e) {
    const id = e.currentTarget.dataset.id;
    const d = store.get();
    const key = util.today();
    d.plans[key] = (d.plans[key] || []).filter(x => x.id !== id);
    store.save(d);
  },

  /* ------------------ 新增计划 ------------------ */
  openAdd() { this.setData({ showAdd: true, newTitle: '' }); },
  closeAdd() { this.setData({ showAdd: false }); },
  onTitleInput(e) { this.setData({ newTitle: e.detail.value }); },
  pickSubject(e) { this.setData({ newSubject: e.currentTarget.dataset.key }); },
  savePlan() {
    const title = (this.data.newTitle || '').trim();
    if (!title) return util.toast('先写一下要做什么呀');
    const d = store.get();
    const key = util.today();
    if (!d.plans[key]) d.plans[key] = [];
    d.plans[key].push({ id: util.uid('pl'), subject: this.data.newSubject, title, done: false, from: key });
    store.save(d);
    this.setData({ showAdd: false });
    util.toast('计划添加成功', 'success');
  },

  goCheckin() { wx.switchTab({ url: '/pages/checkin/checkin' }); },
  goFarm() { wx.switchTab({ url: '/pages/farm/farm' }); },

  /* ------------------ 数据备份 ------------------ */
  exportData() {
    try {
      const path = store.exportJSON();
      wx.shareFileMessage({
        filePath: path,
        success: () => util.toast('备份已发送，记得保存到微信收藏', 'success'),
        fail: () => {
          wx.openDocument({ filePath: path, showMenu: true, fail: () => util.toast('备份文件已生成：' + path) });
        }
      });
    } catch (e) {
      util.toast('导出失败：' + e.message);
    }
  },
  importData() {
    store.importJSON()
      .then(() => { util.toast('恢复成功！', 'success'); this.render(); })
      .catch(err => { if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) return; util.toast('导入失败，请选择正确的备份文件'); });
  },
  clearDemo() {
    wx.showModal({
      title: '清空示例数据',
      content: '会删除预置的示例作业、示例错题和示例植物，重新开始记录。确定吗？',
      confirmColor: '#FF7A7A',
      success: (res) => {
        if (!res.confirm) return;
        store.reset(true);
        this.render();
        util.toast('已清空，开始你的农场吧！', 'success');
      }
    });
  }
});

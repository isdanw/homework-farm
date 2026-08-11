/**
 * 错题本
 *  小彩蛋联动：每掌握 3 道错题，额外奖励 1 颗阳光（鼓励孩子复习）
 */
const store = require('../../utils/store.js');
const util = require('../../utils/util.js');
const CFG = require('../../utils/config.js');

const MASTER_REWARD_STEP = 3;   // 每掌握几道错题奖励 1 颗阳光（可调）

Page({
  data: {
    list: [],
    filter: 'all',            // all / todo / done
    filterSub: 'all',
    subjects: CFG.SUBJECTS,
    stat: { total: 0, left: 0 },
    showAdd: false,
    form: { subject: 'math', title: '', reason: '' }
  },

  onLoad() {
    this._onChange = () => this.render();
    store.on(this._onChange);
  },
  onUnload() { store.off(this._onChange); },

  onShow() {
    if (this.getTabBar) { const tb = this.getTabBar(); if (tb) tb.setData({ selected: 3 }); }
    this.render();
  },

  render() {
    const d = store.get();
    let list = d.errors.slice().sort((a, b) => b.createdAt - a.createdAt);
    if (this.data.filter === 'todo') list = list.filter(e => !e.mastered);
    if (this.data.filter === 'done') list = list.filter(e => e.mastered);
    if (this.data.filterSub !== 'all') list = list.filter(e => e.subject === this.data.filterSub);

    this.setData({
      list: list.map(e => {
        const s = CFG.getSubject(e.subject);
        return Object.assign({}, e, { subName: s.name, color: s.color, icon: s.icon, dateText: util.cnDate(util.dateKey(new Date(e.createdAt))) });
      }),
      stat: { total: d.errors.length, left: d.errors.filter(e => !e.mastered).length }
    });
  },

  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.v }, () => this.render()); },
  setFilterSub(e) { this.setData({ filterSub: e.currentTarget.dataset.v }, () => this.render()); },

  /* 标记掌握：每掌握 3 道奖励 1 颗阳光 */
  toggleMaster(e) {
    const id = e.currentTarget.dataset.id;
    const d = store.get();
    const item = d.errors.find(x => x.id === id);
    if (!item) return;
    item.mastered = !item.mastered;
    if (item.mastered) {
      const masteredCount = d.errors.filter(x => x.mastered).length;
      if (masteredCount % MASTER_REWARD_STEP === 0) {
        d.farm.suns += 1;
        d.farm.logs.unshift({ date: util.today(), type: 'reward', text: `复习掌握了 ${masteredCount} 道错题，奖励阳光 ×1` });
        util.toast('掌握 ' + masteredCount + ' 道错题，奖励阳光 +1', 'success');
      } else {
        util.toast('真棒，又掌握一道！');
      }
    }
    store.save(d);
  },

  delItem(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除错题', content: '删除后无法恢复，确定吗？', confirmColor: '#FF7A7A',
      success: (res) => {
        if (!res.confirm) return;
        const d = store.get();
        d.errors = d.errors.filter(x => x.id !== id);
        store.save(d);
      }
    });
  },

  openAdd() { this.setData({ showAdd: true, form: { subject: 'math', title: '', reason: '' } }); },
  closeAdd() { this.setData({ showAdd: false }); },
  pickSub(e) { this.setData({ 'form.subject': e.currentTarget.dataset.key }); },
  onTitle(e) { this.setData({ 'form.title': e.detail.value }); },
  onReason(e) { this.setData({ 'form.reason': e.detail.value }); },
  saveItem() {
    const f = this.data.form;
    if (!f.title.trim()) return util.toast('先写一下错在哪道题');
    const d = store.get();
    d.errors.unshift({
      id: util.uid('er'), subject: f.subject,
      title: f.title.trim(), reason: f.reason.trim(),
      mastered: false, createdAt: Date.now()
    });
    store.save(d);
    this.setData({ showAdd: false });
    util.toast('已记到错题本', 'success');
  }
});

/**
 * 复习卡页（G2 / G4 提取式记忆）
 *  · 展示今日到期复习卡（getDueCards）+ 全部卡片统计
 *  · 翻面自测：看正面 → 点卡片看答案 → 自评「记得 / 忘了」→ advanceCard 推进 Leitner 盒子
 *  · 完成一次卡片自测 = 一次农场浇灌（engine.tutorReward，闭环 G3）
 *  · 数据落 tutor_cards，经 tutorStore.pushQueued → tutorSync 上云，与网页端互通
 *
 * ⚠️ 卡片自测**不写复测证据、不声称掌握**（活动≠证据≠掌握），只推进记忆盒子。
 */
const store = require('../../utils/store.js');
const tutorStore = require('../../utils/tutorStore.js');
const util = require('../../utils/util.js');
const engine = require('../../utils/farmEngine.js');

Page({
  data: {
    dueList: [],        // 今日到期卡片（列表展示）
    allCount: 0,
    dueCount: 0,
    // 自测状态机
    studying: false,
    current: null,      // { id, subjectName, topic, front, back, box, done }
    flipped: false,
    finished: false
  },

  onShow() { this.render(); },

  render() {
    const all = tutorStore.getCards();
    const due = tutorStore.getDueCards();
    this.setData({
      allCount: all.length,
      dueCount: due.length,
      dueList: due.map(c => ({
        id: c.id,
        subjectName: c.subjectName || '',
        topic: c.topic || '',
        front: c.front || '',
        back: c.back || '',
        box: c.box || 1
      }))
    });
    // 自测进行中：刷新当前卡进度（advanceCard 后盒子可能已变化）
    if (this.data.studying && this.data.current) {
      const cur = tutorStore.getCards().find(c => c.id === this.data.current.id);
      if (cur) this.setData({ current: this._viewOf(cur) });
    }
  },

  _viewOf(c) {
    return {
      id: c.id,
      subject: c.subject || '',            // P2 情境：据此定位学科（老卡可能为空 → 下方兜底）
      subjectName: c.subjectName || '',
      topic: c.topic || '',
      front: c.front || '',
      back: c.back || '',
      box: c.box || 1,
      done: !!c.done
    };
  },

  /* ---------------- 开始自测 ---------------- */
  startStudy() {
    const due = tutorStore.getDueCards();
    if (!due.length) return util.toast('今天没有到期的卡片啦');
    this.setData({ studying: true, flipped: false, finished: false, current: this._viewOf(due[0]) });
  },

  /* ---------------- 翻面看答案 ---------------- */
  flip() { this.setData({ flipped: !this.data.flipped }); },

  /* ---------------- 自评：记得(good) / 忘了(again) ---------------- */
  rate(e) {
    const good = e.currentTarget.dataset.good === '1' || e.currentTarget.dataset.good === true;
    const cur = this.data.current;
    if (!cur) return;
    // 推进 Leitner 盒子：good→盒+1（封顶毕业）/ again→盒归1，均上云
    tutorStore.advanceCard(cur.id, good);
    tutorStore.pushQueued();
    // 农场浇灌（G3）：完成一次卡片自测 = 一次浇灌（每日有上限，防刷）
    const gain = engine.tutorReward(store.get());
    if (gain) util.toast('阳光 +' + gain.sun, 'success');
    // 学科情境（P2）：按当前卡的学科推进情境进度；解锁碎片时轻提示
    this._advanceScenario(cur.subject);
    // 取下一张到期卡；无则结束本轮
    const due = tutorStore.getDueCards();
    if (due.length) {
      this.setData({ current: this._viewOf(due[0]), flipped: false });
    } else {
      this.setData({ studying: false, finished: true, current: null });
    }
    this.render();
  },

  stopStudy() {
    this.setData({ studying: false, finished: false, current: null, flipped: false });
    this.render();
  },

  /**
   * 学科情境（P2）：推进该卡的学科情境，达节点解锁剧情碎片时弹一次轻提示。
   * 老卡可能缺 subject → 用内置第一科兜底（保证「每学科一份」永远有一个有效身份）。
   */
  _advanceScenario(subject) {
    try {
      const key = subject || 'math';
      const res = store.advanceScenario(key);
      if (res && res.unlocked && res.unlocked.length) {
        const b = store.getScenarioBanner(key);
        const frag = b && b.latest;
        if (frag) {
          setTimeout(() => util.toast(`${b.emoji} ${frag.title}：${frag.text}`, 'success'), 700);
        }
      }
    } catch (e) {}
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});

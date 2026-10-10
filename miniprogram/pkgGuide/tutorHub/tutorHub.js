/**
 * 导学中心（导学主线聚合页 · 方案 A）
 *  · 把散落在「我的」页的 AI 导学 / 错题本 / 导学报告 聚合成一条导学闭环入口
 *  · 顶部概览：导学归档 / 错题总数 / 待订正 / 已验证（复用 report 的统计口径）
 *  · 数据来自本地 tutorStore；进入页面时静默 pull 云端回填（闭环 S1，失败不提示）
 *  · 「导学单」入口（2026-09-28）：出单 → 豆包执行 → 回执 → 评语与汇总，
 *    与网页看板/工作台共用同一个云端库（`tutor_orders`），不是另一个孤岛
 */
const tutorStore = require('../../utils/tutorStore.js');
const tutorGate = require('../../utils/tutorGate.js');
const store = require('../../utils/store.js');

Page({
  data: {
    overview: { sessions: 0, mistakes: 0, pending: 0, evidence: 0 },
    orderPending: 0,          // 待回执的导学单数（回执环的待办量）
    locked: false,
    lockReason: ''
  },

  onShow() {
    // 门禁（2026-09-22）：未添加孩子或未建成长计划时，导学功能禁用
    const gate = tutorGate.getGate();
    if (!gate.ok) {
      this.setData({ locked: true, lockReason: gate.reason });
      return;
    }
    this.setData({ locked: false, lockReason: '' });

    // 静默同步（60 秒节流；无云环境 / 失败一律静默）→ 回填完成后重渲染
    tutorStore.syncFromCloud().then(merged => {
      this.render();
      if (merged && merged.added > 0) {
        console.log('[tutorHub] 云端回填', merged.added, '条');
      }
    });
    this.render();
  },

  render() {
    const sessions = tutorStore.getSessions().filter(s => s.closed).length;
    const mistakes = tutorStore.getMistakes();
    const pending = mistakes.filter(m => m.status !== 'corrected').length;
    const evidence = tutorStore.evidencePassedCount();
    const oc = tutorStore.orderCounts();

    this.setData({
      overview: {
        sessions: sessions,
        mistakes: mistakes.length,
        pending: pending,
        evidence: evidence
      },
      orderPending: oc.issued
    });
  },

  /* 门禁守卫：任一入口点击时再校验一次，避免缓存/深链绕过 */
  guard() {
    const gate = tutorGate.getGate();
    if (!gate.ok) { this.setData({ locked: true, lockReason: gate.reason }); return false; }
    return true;
  },

  /* 主入口（复测不单列：复测需从具体错题发起，收敛到错题本内） */
  goTutor() { if (!this.guard()) return; wx.navigateTo({ url: '/pkgGuide/tutor/tutor' }); },
  goOrder() { if (!this.guard()) return; wx.navigateTo({ url: '/pkgGuide/order/order' }); },
  goMistakes() { if (!this.guard()) return; wx.navigateTo({ url: '/pkgTools/mistakes/mistakes' }); },
  goReport() { if (!this.guard()) return; wx.navigateTo({ url: '/pkgGuide/report/report' }); },
  goExam() { if (!this.guard()) return; wx.navigateTo({ url: '/pkgGuide/examGallery/examGallery' }); },
  goSpeakstep() { if (!this.guard()) return; wx.navigateTo({ url: '/pkgGuide/speakstep/speakstep' }); },

  /* 锁定态引导：根据缺哪一步分流到「我的」或「成长计划」 */
  goMine() { wx.switchTab({ url: '/pages/mine/mine' }); },
  goPlanFromHub() {
    const first = store.getTypeList()[0];
    wx.navigateTo({ url: '/pkgTools/plan/plan' + (first ? '?key=' + first.key : '') });
  }
});

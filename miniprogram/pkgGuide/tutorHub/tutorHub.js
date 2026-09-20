/**
 * 导学中心（学习主线聚合页 · 方案 A）
 *  · 把散落在「我的」页的 AI 导学 / 错题本 / 导学报告 聚合成一条学习闭环入口
 *  · 顶部概览：导学归档 / 错题总数 / 待订正 / 已验证（复用 report 的统计口径）
 *  · 数据来自本地 tutorStore；进入页面时静默 pull 云端回填（闭环 S1，失败不提示）
 */
const tutorStore = require('../../utils/tutorStore.js');

Page({
  data: {
    overview: { sessions: 0, mistakes: 0, pending: 0, evidence: 0 }
  },

  onShow() {
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

    this.setData({
      overview: {
        sessions: sessions,
        mistakes: mistakes.length,
        pending: pending,
        evidence: evidence
      }
    });
  },

  /* 三个入口（复测不单列：复测需从具体错题发起，收敛到错题本内） */
  goTutor() { wx.navigateTo({ url: '/pkgGuide/tutor/tutor' }); },
  goMistakes() { wx.navigateTo({ url: '/pkgTools/mistakes/mistakes' }); },
  goReport() { wx.navigateTo({ url: '/pkgGuide/report/report' }); },
  goExam() { wx.navigateTo({ url: '/pkgGuide/examGallery/examGallery' }); }
});

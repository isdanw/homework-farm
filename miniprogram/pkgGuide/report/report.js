/**
 * 导学报告页（全科导学 P3 + 闭环 S2）
 *  · 今日回顾：到期复习窗口（归档诊断派生，复测达标后关闭）
 *  · 概览：导学归档次数 / 错题总数 / 待订正 / 已验证证据
 *  · 错因分布：E1-E9 统计（诊断假设，非事实标签）
 *  · 学科分布：各学科错题数
 *  · 复测证据列表：达标（已验证）与未达标记录
 *  · 数据来自本地 tutorStore（云端由 tutorSync 在导学中心页静默回填）
 */
const store = require('../../utils/store.js');
const tutorStore = require('../../utils/tutorStore.js');
const tutorSubjects = require('../../utils/tutorSubjects.js');
const mistakeRules = require('../../utils/mistakeRules.js');
const studyPlan = require('../../utils/studyPlan.js');
const planFeedback = require('../../utils/planFeedback.js');

/** E1-E9 错因元数据（共享一份，见 utils/mistakeRules.js） */
const ERROR_NAMES = {};
Object.keys(mistakeRules.ERROR_TYPES).forEach(k => { ERROR_NAMES[k] = mistakeRules.ERROR_TYPES[k].name; });

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    overview: { sessions: 0, mistakes: 0, pending: 0, evidence: 0 },
    reviewList: [],     // 今日回顾（复习窗口到期项，闭环 S2）
    errorDist: [],      // [{type, name, count, pct}]
    subjectDist: [],    // [{key, name, emoji, count}]
    evidenceList: [],   // 复测记录（含达标/未达标）
    feedbackList: [],   // 补漏建议（报告 → 计划反哺，按学科分组）
    hasData: false
  },

  onLoad() { this._added = {}; },   // 已加入计划的「学科:错因」标记（实例态，不进 setData）
  onShow() { this.render(); },

  render() {
    const sessions = tutorStore.getSessions().filter(s => s.closed).length;
    const mistakes = tutorStore.getMistakes();
    const pending = mistakes.filter(m => m.status !== 'corrected').length;
    const evidence = tutorStore.getEvidence();
    const passed = evidence.filter(e => e.passed).length;

    // 今日回顾：到期复习窗口（dueAt ≤ now 且未关闭）
    const reviewList = tutorStore.getDueReviews().slice(0, 10).map(r => ({
      id: r.id,
      mistakeId: r.mistakeId || '',
      subject: r.subject || '',
      subjectName: r.subjectName || '',
      topic: r.topic || '（未标注知识点）',
      errorType: r.errorType || '',
      errorTypeLabel: mistakeRules.errorTypeLabel(r.errorType || ''),
      stage: r.stage || 1,
      stageText: '第 ' + (r.stage || 1) + ' 轮',
      dueText: r.dueAt <= Date.now() - 86400000 ? '已过期' : '今日到期'
    }));

    // 错因分布（E1-E9 聚合）
    const errCount = {};
    mistakes.forEach(m => {
      if (m.errorType && ERROR_NAMES[m.errorType]) {
        errCount[m.errorType] = (errCount[m.errorType] || 0) + 1;
      }
    });
    const totalErr = Object.values(errCount).reduce((a, b) => a + b, 0);
    const errorDist = Object.keys(ERROR_NAMES).map(k => ({
      type: k,
      name: ERROR_NAMES[k],
      count: errCount[k] || 0,
      pct: totalErr ? Math.round(((errCount[k] || 0) / totalErr) * 100) : 0
    })).filter(d => d.count > 0).sort((a, b) => b.count - a.count);

    // 学科分布
    const subCount = {};
    mistakes.forEach(m => { if (m.subject) subCount[m.subject] = (subCount[m.subject] || 0) + 1; });
    const subjectDist = Object.keys(subCount).map(k => {
      const sub = tutorSubjects.getTutorSubject(k);
      return { key: k, name: sub ? sub.name : k, emoji: sub ? sub.emoji : '📘', count: subCount[k] };
    }).sort((a, b) => b.count - a.count);

    // 复测记录
    const evidenceList = evidence.slice(0, 20).map(e => ({
      id: e.id,
      subjectName: e.subjectName || '',
      topic: e.topic,
      errorType: e.errorType,
      total: e.total,
      correct: e.correct,
      rate: Math.round((e.rate || 0) * 100),
      passed: e.passed,
      timeText: fmtDate(e.createdAt)
    }));

    // 报告 → 计划反哺：把错因分布按学科聚合成「专项补漏建议」
    const added = this._added || {};
    const feedbackList = planFeedback.buildFeedback(mistakes).map(fb => {
      const sub = tutorSubjects.getTutorSubject(fb.subject) || {};
      return {
        subject: fb.subject,
        subjectName: sub.name || fb.subject,
        emoji: sub.emoji || '📘',
        items: fb.items.map(it => Object.assign({}, it, { added: !!added[fb.subject + ':' + it.errorType] }))
      };
    });

    this.setData({
      overview: { sessions: sessions, mistakes: mistakes.length, pending: pending, evidence: passed },
      reviewList: reviewList,
      errorDist: errorDist,
      subjectDist: subjectDist,
      evidenceList: evidenceList,
      feedbackList: feedbackList,
      hasData: !!(mistakes.length || evidence.length || sessions || reviewList.length)
    });
  },

  /* 今日回顾：去回顾（跳导学页，围绕知识点开场——复用错题订正上下文机制） */
  goReview(e) {
    const r = e.currentTarget.dataset.r;
    if (!r) return;
    wx.navigateTo({
      url: '/pkgGuide/tutor/tutor?key=' + encodeURIComponent(r.subject) +
        '&topic=' + encodeURIComponent(r.topic) +
        '&errorType=' + encodeURIComponent(r.errorType)
    });
  },

  /* 今日回顾：直接复测（带错题 id，达标即关闭复习窗口） */
  goReviewRetest(e) {
    const r = e.currentTarget.dataset.r;
    if (!r || !r.mistakeId) return;
    wx.navigateTo({
      url: '/pkgGuide/retest/retest?key=' + encodeURIComponent(r.subject) +
        '&topic=' + encodeURIComponent(r.topic) +
        '&errorType=' + encodeURIComponent(r.errorType) +
        '&mid=' + encodeURIComponent(r.mistakeId)
    });
  },

  goTutor() { wx.navigateTo({ url: '/pkgGuide/tutor/tutor' }); },
  goMistakes() { wx.navigateTo({ url: '/pkgTools/mistakes/mistakes' }); },

  /* 报告 → 计划反哺：把一条补漏建议加入对应学科成长计划 */
  addToPlan(e) {
    const d = e.currentTarget.dataset || {};
    const subject = d.subject, errorType = d.errorType, task = d.task;
    if (!subject || !task) return;
    const r = studyPlan.appendRemediationStage(subject, [task]);
    if (!r) { wx.showToast({ title: '加入失败', icon: 'none' }); return; }
    this._added = this._added || {};
    this._added[subject + ':' + errorType] = true;
    this.render();
    const sub = tutorSubjects.getTutorSubject(subject);
    wx.showToast({ title: '已加入' + (sub ? sub.name : '成长') + '计划', icon: 'success' });
  },

  /* 去成长计划页查看（可定位到具体学科） */
  goPlan(e) {
    const subject = (e.currentTarget.dataset || {}).subject || '';
    wx.navigateTo({ url: '/pkgTools/plan/plan' + (subject ? '?key=' + encodeURIComponent(subject) : '') });
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});

/**
 * 试卷库（F-B exam_resources 小程序入口 · 只读）
 *  · 数据来自 tutorSync 的两个 action：
 *      exams —— 索引元数据列表（不含正文，轻量）；
 *      exam  —— 单份详情（卷面 markdown + 参考答案/解析 + 外链）。
 *  · tutorSync 按 openid 过滤，小程序直连 callFunction 即可拿到「当前账号」的试卷库，无需令牌。
 *  · 本页纯展示：试卷由「全科导学工作台」经 webAdminWrite 单向权威推送，小程序端只读。
 *  · 无现成 markdown 渲染器，卷面与解析按纯文本（保留换行）展示，外链提供「复制」按钮。
 */
const SUBJECTS = [
  { key: '', label: '全部' },
  { key: 'chinese', label: '语文' },
  { key: 'math', label: '数学' },
  { key: 'english', label: '英语' }
];
const EXAM_TYPE_LABEL = {
  unit_test: '单元测',
  phase_test: '阶段测',
  real_exam: '真题',
  diagnostic_test: '诊断',
  special_test: '专项',
  advanced_test: '拔高'
};

function decorateIndex(e) {
  return Object.assign({}, e, {
    examTypeLabel: EXAM_TYPE_LABEL[e.examType] || e.examType || '',
    knowledgePointsText: Array.isArray(e.knowledgePoints)
      ? e.knowledgePoints.join(' / ')
      : (e.knowledgePoints || '')
  });
}
function decorateDetail(d) {
  return Object.assign({}, d, {
    examTypeLabel: EXAM_TYPE_LABEL[d.examType] || d.examType || '',
    knowledgePointsText: Array.isArray(d.knowledgePoints)
      ? d.knowledgePoints.join(' / ')
      : (d.knowledgePoints || ''),
    markdown: d.markdown || '',
    answers: d.answers || '',
    officialUrl: d.officialUrl || '',
    answerUrl: d.answerUrl || ''
  });
}

Page({
  data: {
    subjects: SUBJECTS,
    activeSubject: '',
    exams: [],
    loading: true,
    error: '',
    detail: null,
    showDetail: false
  },

  onLoad() {
    this.fetchExams('');
  },

  async fetchExams(subject) {
    this.setData({ loading: true, error: '', activeSubject: subject });
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      this.setData({ loading: false, error: '未连接云端' });
      return;
    }
    try {
      const res = await wx.cloud.callFunction({
        name: 'tutorSync',
        data: { action: 'exams', subject: subject || undefined }
      });
      const r = res && res.result;
      if (r && r.ok) {
        this.setData({
          exams: (r.exams || []).map(decorateIndex),
          loading: false
        });
      } else {
        this.setData({ exams: [], loading: false, error: (r && r.msg) || '加载失败' });
      }
    } catch (e) {
      this.setData({ exams: [], loading: false, error: '加载失败：' + ((e && e.message) || e) });
    }
  },

  onSubjectTap(e) {
    const s = e.currentTarget.dataset.subject;
    if (s === this.data.activeSubject) return;
    this.fetchExams(s);
  },

  async onExamTap(e) {
    const rid = e.currentTarget.dataset.rid;
    if (!rid) return;
    this.setData({ showDetail: true, detail: { loading: true } });
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      this.setData({ detail: { error: '未连接云端' } });
      return;
    }
    try {
      const res = await wx.cloud.callFunction({
        name: 'tutorSync',
        data: { action: 'exam', resourceId: rid }
      });
      const r = res && res.result;
      if (r && r.ok && r.exam) {
        this.setData({ detail: decorateDetail(r.exam) });
      } else {
        this.setData({ detail: { error: (r && r.msg) || '未找到该试卷（可能尚未上云）' } });
      }
    } catch (err) {
      this.setData({ detail: { error: '加载失败：' + ((err && err.message) || err) } });
    }
  },

  closeDetail() {
    this.setData({ showDetail: false, detail: null });
  },

  noop() {},

  copyUrl(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制', icon: 'none' })
    });
  }
});

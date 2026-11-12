/**
 * 测验卷中心（F-B exam_resources 小程序入口）
 *  · 三大区块：
 *    1) 测验入口（跳转 examGen，学情驱动 AI 组卷）
 *    2) 我的测验卷：examService.listExams 返回的 ai/manual 卷，含结构化题目可在线作答
 *    3) 试卷库（工作台推送）：tutorSync 只读卷面 + 解析
 *  · 合规：UI 文案统一「测验卷 / 卷」，规避个人主体审核红线。
 */
const EXAM = require('../../utils/examApi.js');
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
const ORIGIN_LABEL = { ai: 'AI 生成', manual: '自建', upload: '上传', workbench: '工作台' };

function decorateIndex(e) {
  return Object.assign({}, e, {
    examTypeLabel: EXAM_TYPE_LABEL[e.examType] || e.examType || '',
    knowledgePointsText: Array.isArray(e.knowledgePoints)
      ? e.knowledgePoints.join(' / ')
      : (e.knowledgePoints || '')
  });
}
function decorateMyExam(e) {
  return Object.assign({}, e, {
    examTypeLabel: EXAM_TYPE_LABEL[e.examType] || '',
    originLabel: ORIGIN_LABEL[e.origin] || e.origin || '',
    canAnswer: (e.qCount || 0) > 0,
    submitted: false, lastRate: null, lastAt: ''
  });
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = function (n) { return n < 10 ? ('0' + n) : ('' + n); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function decorateSub(s) {
  const sm = s.summary || {};
  return Object.assign({}, s, {
    rate: sm.rate != null ? sm.rate : 0,
    scoreText: (sm.gotPoints != null ? sm.gotPoints : 0) + '/' + (sm.totalPoints != null ? sm.totalPoints : 0),
    dateText: fmtDate(s.createdAt)
  });
}

Page({
  data: {
    subjects: SUBJECTS,
    activeSubject: '',
    exams: [],          // 工作台推送（只读）
    myExams: [],        // AI/自建（可作答）
    submissions: [],    // 已回收（已提交并批改）的试卷
    loading: true,
    error: '',
    detail: null,
    showDetail: false
  },

  onShow() {
    this.fetchExams(this.data.activeSubject);
    this.fetchMyExams(this.data.activeSubject);
    this.fetchSubmissions();
  },

  onLoad(options) {
    const subject = String((options && options.subject) || '').trim();
    this.setData({ activeSubject: subject });
    this.fetchExams(subject);
    this.fetchMyExams(subject);
    this.fetchSubmissions();
  },

  async fetchExams(subject) {
    this.setData({ loading: true, error: '', activeSubject: subject });
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      this.setData({ loading: false, error: '未连接云端' });
      return;
    }
    try {
      // 单孩子模型：不带 childId，云端按当前孩子过滤（无归属的库资源保留）
      const res = await wx.cloud.callFunction({
        name: 'tutorSync',
        data: { action: 'exams', subject: subject || undefined }
      });
      const r = res && res.result;
      if (r && r.ok) {
        this.setData({ exams: (r.exams || []).map(decorateIndex), loading: false });
      } else {
        this.setData({ exams: [], loading: false, error: (r && r.msg) || '加载失败' });
      }
    } catch (e) {
      this.setData({ exams: [], loading: false, error: '加载失败：' + ((e && e.message) || e) });
    }
  },

  async fetchMyExams(subject) {
    const r = await EXAM.listExams(subject);
    if (r && r.ok) {
      const list = (r.exams || [])
        .filter(function (e) { return e.origin === 'ai' || e.origin === 'manual'; })
        .map(decorateMyExam);
      this.setData({ myExams: list }, this.markSubmitted.bind(this));
    } else {
      // 不阻断主流程：云端未部署/无数据时不报错，仅空列表
      this.setData({ myExams: [] });
    }
  },

  /* 已回收（已提交批改）的提交记录 */
  async fetchSubmissions() {
    const r = await EXAM.listSubmissions('');
    if (r && r.ok) {
      this.setData({ submissions: (r.submissions || []).map(decorateSub) }, this.markSubmitted.bind(this));
    } else {
      this.setData({ submissions: [] });
    }
  },

  /* 用已回收记录标记「我的测验卷」：已作答的卷显示最近一次正确率/时间 */
  markSubmitted() {
    const subs = this.data.submissions || [];
    const latest = {};
    subs.forEach(function (s) {
      const k = s.examClientId;
      if (!k) return;
      if (!latest[k] || (s.createdAt || 0) > (latest[k].createdAt || 0)) latest[k] = s;
    });
    const myExams = (this.data.myExams || []).map(function (e) {
      const s = latest[e.resourceId];
      return Object.assign({}, e, {
        submitted: !!s,
        lastRate: s ? s.rate : null,
        lastAt: s ? s.dateText : ''
      });
    });
    this.setData({ myExams: myExams });
  },

  /* 打开已回收的试卷报告（凭 submissionClientId 从云端重建） */
  goSubmission(e) {
    const sid = e.currentTarget.dataset.sid;
    if (!sid) return;
    wx.navigateTo({ url: '/pkgGuide/examReport/examReport?submissionClientId=' + sid });
  },

  onSubjectTap(e) {
    const s = e.currentTarget.dataset.subject;
    if (s === this.data.activeSubject) return;
    this.fetchExams(s);
    this.fetchMyExams(s);
  },

  goGen() {
    wx.navigateTo({ url: '/pkgGuide/examGen/examGen' });
  },

  /* 删除一份测验卷（云端移除；已回收的批改记录保留在「已回收的试卷」里）
   * 卡片本体点按是「去作答」，所以这里必须 catchtap，避免冒泡进作答页。 */
  onDeleteExam(e) {
    const rid = e.currentTarget.dataset.rid;
    const name = e.currentTarget.dataset.name || rid;
    if (!rid) return;
    wx.showModal({
      title: '删除测验卷',
      content: '确定删除「' + name + '」吗？已回收的批改记录会保留。',
      confirmColor: '#FF7A7A',
      confirmText: '删除',
      success: (res) => {
        if (!res.confirm) return;
        EXAM.deleteExam(rid).then((r) => {
          if (!r || !r.ok) {
            wx.showToast({ title: (r && r.msg) || '删除失败', icon: 'none' });
            return;
          }
          wx.showToast({ title: r.removed ? '已删除' : '云端已无此卷', icon: 'none' });
          this.fetchMyExams(this.data.activeSubject);
        }).catch(() => wx.showToast({ title: '删除失败', icon: 'none' }));
      }
    });
  },

  goAnswer(e) {
    const rid = e.currentTarget.dataset.rid;
    const can = e.currentTarget.dataset.can;
    if (!rid) return;
    if (!can) { wx.showToast({ title: '该卷暂不支持在线作答', icon: 'none' }); return; }
    wx.navigateTo({ url: '/pkgGuide/examAnswer/examAnswer?examClientId=' + rid });
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

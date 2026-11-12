/**
 * examGen —— 测验生成页（P2）
 * 组装「学情上下文」：画像（年级/期望）+ 成长计划进度（未完成任务）+ 近期错题快照，
 * 调 examService.gen 生成结构化测验卷，成功后跳转作答页。
 */
const store = require('../../utils/store.js');
const studyPlan = require('../../utils/studyPlan.js');
const tutorStore = require('../../utils/tutorStore.js');
const TUTOR_SUBJECTS = require('../../utils/tutorSubjects.js').TUTOR_SUBJECTS;
const EXAM = require('../../utils/examApi.js');

const MODES = [
  { key: 'auto', label: '自适应（薄弱点优先）' },
  { key: 'unit', label: '按单元' },
  { key: 'chapter', label: '按章节' },
  { key: 'type', label: '按题型专项' }
];
const COUNTS = [5, 8, 10, 12, 15, 20];
const DIFFS = [{ v: 1, label: '基础' }, { v: 2, label: '标准' }, { v: 3, label: '拔高' }];
const EXAM_TYPES = [
  { key: 'unit_test', label: '单元测' }, { key: 'phase_test', label: '阶段测' },
  { key: 'diagnostic_test', label: '诊断' }, { key: 'special_test', label: '专项' },
  { key: 'advanced_test', label: '拔高' }
];

Page({
  data: {
    subjects: TUTOR_SUBJECTS,
    subjectIndex: 1,          // 默认数学
    modes: MODES, modeIndex: 0,
    counts: COUNTS, countIndex: 2,
    diffs: DIFFS, diffIndex: 1,
    examTypes: EXAM_TYPES, examTypeIndex: 0,
    generating: false,
    error: ''
  },

  onLoad(q) {
    // 支持「再来一份」预选学科：?subject=math
    if (q && q.subject) {
      const idx = TUTOR_SUBJECTS.findIndex(function (s) { return s.key === q.subject; });
      if (idx >= 0) this.setData({ subjectIndex: idx });
    }
  },

  onSubject(e) { this.setData({ subjectIndex: Number(e.detail.value) }); },
  onMode(e) { this.setData({ modeIndex: Number(e.detail.value) }); },
  onCount(e) { this.setData({ countIndex: Number(e.detail.value) }); },
  onDiff(e) { this.setData({ diffIndex: Number(e.detail.value) }); },
  onExamType(e) { this.setData({ examTypeIndex: Number(e.detail.value) }); },

  async gen() {
    if (this.data.generating) return;
    const d = this.data;
    const subj = d.subjects[d.subjectIndex];
    const learner = store.getLearner() || {};
    const grade = store.resolveGrade() || '';
    const expectations = Array.isArray(learner.expectations) ? learner.expectations : [];

    // 计划进度：该学科未完成任务（薄弱点）
    const plan = studyPlan.getPlan(subj.key);
    const pendingTasks = [];
    if (plan && Array.isArray(plan.stages)) {
      plan.stages.forEach(function (st) {
        (st.tasks || []).forEach(function (t) { if (t && !t.done && t.name) pendingTasks.push(t.name); });
      });
    }
    // 近期错题快照（E1-E9 卡点）
    const learnerCtx = tutorStore.getLearnerContext(subj.key, 1500);

    this.setData({ generating: true, error: '' });
    const r = await EXAM.genExam({
      subject: subj.key,
      grade: grade,
      clientId: 'exam_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      createdBy: 'mini',
      scope: {
        mode: d.modes[d.modeIndex].key,
        count: d.counts[d.countIndex],
        difficulty: d.diffs[d.diffIndex].v,
        examType: d.examTypes[d.examTypeIndex].key
      },
      planCtx: { pendingTasks: pendingTasks.slice(0, 10) },
      learnerCtx: learnerCtx,
      expectations: expectations
    });
    this.setData({ generating: false });

    if (!r || !r.ok) {
      this.setData({ error: (r && r.msg) || '生成失败，请重试' });
      return;
    }
    wx.redirectTo({ url: '/pkgGuide/examAnswer/examAnswer?examClientId=' + r.exam.resourceId });
  }
});

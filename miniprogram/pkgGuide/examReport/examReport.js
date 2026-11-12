/**
 * examReport —— 批改报告页（P2）
 * 读取 examAnswer 提交时暂存的「试卷原文 + 批改结果」，
 * 展示总评（正确率/得分/薄弱点/建议）+ 逐题对错/得分/E1-E9 错因诊断。
 * 按钮：重做 / 去错题本 / 再来一份。
 */
const EXAM = require('../../utils/examApi.js');
const mistakeRules = require('../../utils/mistakeRules.js');
const figureDraw = require('../../utils/figureDraw.js');

const TYPE_LABELS = {
  choice: '选择', fill: '填空', calc: '计算', essay: '简答', draw: '书写'
};
const LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

function etLabel(eKey) {
  if (!eKey) return { label: '', color: '#9AA5B1', bg: '#F2F4F7' };
  const meta = mistakeRules.ERROR_TYPES[eKey] || { name: eKey, color: '#9AA5B1', bg: '#F2F4F7' };
  return { label: meta.name ? (eKey + ' ' + meta.name) : eKey, color: meta.color || '#9AA5B1', bg: meta.bg || '#F2F4F7' };
}

Page({
  data: {
    ready: false, loadingCloud: false, err: '',
    examName: '', subjectName: '', route: '',
    summary: null, mistakesAdded: 0,
    items: [],
    examClientId: '', subject: '',
    routeLabel: ''
  },

  onLoad(query) {
    // 二次查看「已回收」的试卷：凭 submissionClientId 从云端重建
    if (query && query.submissionClientId) {
      this.loadFromCloud(query.submissionClientId);
      return;
    }
    // 提交后直传（内存暂存，避免大对象走 URL）
    const grade = EXAM.getLastGrade();
    const exam = EXAM.getLastExam();
    if (!grade || !grade.ok || !exam || !grade.submission) {
      this.setData({ ready: false, err: '暂无批改数据' });
      return;
    }
    this.buildReport(exam, grade);
  },

  async loadFromCloud(subId) {
    this.setData({ ready: false, loadingCloud: true });
    const r = await EXAM.getSubmission(subId);
    if (!r || !r.ok || !r.submission) {
      this.setData({ ready: false, loadingCloud: false, err: (r && r.msg) || '未找到该提交记录' });
      return;
    }
    const sub = r.submission;
    const ex = await EXAM.getExam(sub.examClientId);
    if (!ex || !ex.ok || !ex.exam) {
      this.setData({ ready: false, loadingCloud: false, err: '未找到对应试卷（可能尚未上云）' });
      return;
    }
    this.buildReport(ex.exam, { ok: true, submission: sub, mistakesAdded: 0 });
  },

  buildReport(exam, grade) {
    const sub = grade.submission;
    const questions = Array.isArray(exam.questions) ? exam.questions : [];
    const resMap = {};
    (sub.results || []).forEach(r => { resMap[r.qid] = r; });
    const ansMap = {};
    (sub.answers || []).forEach(a => { ansMap[a.qid] = a; });

    const figs = [];
    const items = questions.map(function (q, idx) {
      const res = resMap[q.id] || {};
      const ans = ansMap[q.id] || {};
      const diag = res.diagnosis && typeof res.diagnosis === 'object' ? res.diagnosis : {};
      const it = {
        no: idx + 1,
        type: q.type,
        typeLabel: TYPE_LABELS[q.type] || '题',
        stem: q.stem || '',
        kp: q.kp || '',
        points: q.points || 0,
        correct: !!res.correct,
        score: res.score || 0,
        userText: ans.text || '',
        answer: q.answer || '',
        diag: etLabel(diag.errorType),
        errorDesc: diag.errorDesc || '',
        suggestion: diag.suggestion || ''
      };
      if (q.figure && Array.isArray(q.figure.items) && q.figure.items.length) {
        it.figH = figureDraw.boxHeight(q.figure);
        figs.push(q.figure);
      }
      if (q.type === 'choice' && Array.isArray(q.options)) {
        it.opts = q.options.map(function (o, i) { return { label: LABELS[i] || '', text: o }; });
        const ui = LABELS.indexOf(ans.text);
        it.userText = ui >= 0 ? (it.opts[ui] ? (it.opts[ui].label + '. ' + it.opts[ui].text) : ans.text) : (ans.text || '');
        const ci = LABELS.indexOf(q.answer);
        it.answerText = ci >= 0 ? (it.opts[ci] ? (it.opts[ci].label + '. ' + it.opts[ci].text) : q.answer) : (q.answer || '');
      } else {
        it.answerText = q.answer || '';
      }
      if (!it.userText) it.userText = '（未作答）';
      return it;
    });

    const summary = sub.summary || {
      total: questions.length, correctCount: 0, totalPoints: 0, gotPoints: 0, rate: 0,
      weaknesses: [], advice: ''
    };
    const routeLabel = sub.route === 'vision' ? '视觉模型' : (sub.route === 'ocr_text' ? 'OCR+文本' : '文本');

    this.setData({
      ready: true, loadingCloud: false, err: '',
      examName: exam.name || '测验卷',
      subjectName: exam.subjectName || '',
      route: sub.route || '',
      routeLabel: routeLabel,
      summary: summary,
      mistakesAdded: grade.mistakesAdded || 0,
      items: items,
      examClientId: exam.clientId,
      subject: exam.subject || ''
    }, () => {
      figureDraw.paint(this, '.q-fig', figs);
    });
  },

  /* 重做：回到作答页（同一份卷） */
  redo() {
    if (!this.data.examClientId) return;
    wx.redirectTo({ url: '/pkgGuide/examAnswer/examAnswer?examClientId=' + this.data.examClientId });
  },

  /* 去错题本：判错题已回流，跳错题本查看 */
  toMistakes() {
    wx.navigateTo({ url: '/pkgTools/mistakes/mistakes' });
  },

  /* 再来一份：以本卷学科再生成（预选学科） */
  again() {
    const subj = this.data.subject || '';
    const url = subj ? ('/pkgGuide/examGen/examGen?subject=' + subj) : '/pkgGuide/examGen/examGen';
    wx.redirectTo({ url: url });
  },

  backGallery() {
    wx.navigateTo({ url: '/pkgGuide/examGallery/examGallery' });
  }
});

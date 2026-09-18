/**
 * 复测页（全科导学 P3：复测 + 证据契约）
 *  · 从错题本进入：按错题知识点生成 5 道同类选择题
 *  · 逐题作答 → 提交判定 → 展示结果
 *  · 契约红线：≥5 题且 ≥80% 才「达标」；结果只显示「达标/未达标」，绝不显示「已掌握」
 */
const store = require('../../utils/store.js');
const tutorStore = require('../../utils/tutorStore.js');
const util = require('../../utils/util.js');
const tutorSubjects = require('../../utils/tutorSubjects.js');
const mistakeRules = require('../../utils/mistakeRules.js');

const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

Page({
  data: {
    subject: 'math',
    subjectName: '数学',
    subjectEmoji: '🔢',
    topic: '',
    errorType: '',
    errorTypeLabel: '',        // 错因完整标签（如 'E7 信息处理'）
    phase: 'loading',          // loading | answering | result
    questions: [],             // [{q, options[], answer, analysis}]
    answers: [],               // 字母数组，与 questions 对齐
    current: 0,                // 当前题号
    mistakeId: '',             // 来源错题 id（空 = 未关联错题的独立复测）
    sending: false,
    errorMsg: '',
    result: null               // judge 返回
  },

  onLoad(options) {
    let subject = 'math';
    let topic = '', errorType = '', mistakeId = '';
    if (options) {
      if (options.key || options.subject) subject = options.key || options.subject;
      topic = decodeURIComponent(options.topic || '');
      errorType = decodeURIComponent(options.errorType || '');
      mistakeId = decodeURIComponent(options.mid || '');   // 错题 id：复习窗口推进/错题状态回写用
    }
    const sub = tutorSubjects.getTutorSubject(subject);
    if (!sub) subject = 'math';
    this.setData({
      subject: sub ? sub.key : 'math',
      subjectName: sub ? sub.name : '数学',
      subjectEmoji: sub ? sub.emoji : '🔢',
      topic: topic,
      errorType: errorType,
      errorTypeLabel: mistakeRules.errorTypeLabel(errorType),
      mistakeId: mistakeId
    });
    this.generate();
  },

  /* ---------------- 生成复测题 ---------------- */
  generate() {
    this.setData({ phase: 'loading', questions: [], answers: [], current: 0, result: null, errorMsg: '' });
    if (!this.data.topic) {
      this.setData({ phase: 'result', errorMsg: '缺少要复测的知识点' });
      return;
    }
    if (!wx.cloud || !wx.cloud.callFunction) {
      this.setData({ phase: 'result', errorMsg: '需要部署 tutorRetest 云函数后才能复测' });
      return;
    }
    const child = store.get();
    wx.cloud.callFunction({
      name: 'tutorRetest',
      data: {
        action: 'generate',
        subject: this.data.subject,
        topic: this.data.topic,
        errorType: this.data.errorType,
        grade: (child && child.grade) || ''
      }
    }).then(res => {
      const r = res && res.result;
      if (!r || !r.ok) {
        this.setData({ phase: 'result', errorMsg: (r && r.msg) || '复测题生成失败，请重试' });
        return;
      }
      const qs = (r.questions || []).map(q => ({
        q: q.q,
        options: q.options,
        answer: q.answer,
        analysis: q.analysis,
        letters: q.options.map((_, i) => OPTION_LETTERS[i])
      }));
      this.setData({ questions: qs, answers: new Array(qs.length).fill(''), phase: 'answering' });
    }).catch(err => {
      console.warn('[retest] 生成失败', err);
      const msg = (err && err.errMsg) || '';
      this.setData({ phase: 'result', errorMsg: /timeout|timed? ?out/i.test(msg)
        ? '出题超时了，请点「重试」再试一次'
        : '复测服务暂时不可用，请稍后重试' });
    });
  },

  /* ---------------- 作答 ---------------- */
  pickOption(e) {
    if (this.data.sending) return;
    const letter = e.currentTarget.dataset.letter;
    const idx = this.data.current;
    const answers = this.data.answers.slice();
    answers[idx] = letter;
    this.setData({ answers: answers });
    // 自动跳下一题（最后一题不跳）
    if (idx < this.data.questions.length - 1) {
      setTimeout(() => this.setData({ current: idx + 1 }), 250);
    }
  },

  goPrev() { if (this.data.current > 0) this.setData({ current: this.data.current - 1 }); },
  goNext() { if (this.data.current < this.data.questions.length - 1) this.setData({ current: this.data.current + 1 }); },

  answeredCount() {
    return this.data.answers.filter(a => a).length;
  },

  /* ---------------- 提交判定 ---------------- */
  submit() {
    if (this.data.sending) return;
    const total = this.data.questions.length;
    const answered = this.answeredCount();
    if (answered < total) {
      return util.toast('还有 ' + (total - answered) + ' 题没答，答完再交哦');
    }
    this.setData({ sending: true });
    wx.showLoading({ title: '正在判定…', mask: true });
    // 预生成证据 id：本地记录与云端文档共用同一个 clientId，
    // 否则云端会同时留下「tutorRetest 直写（无 clientId）+ push 回补（有 clientId）」两份重复证据
    const evId = util.uid('ev');
    wx.cloud.callFunction({
      name: 'tutorRetest',
      data: {
        action: 'judge',
        subject: this.data.subject,
        topic: this.data.topic,
        errorType: this.data.errorType,
        mistakeId: this.data.mistakeId,
        evidenceClientId: evId,
        questions: this.data.questions,
        answers: this.data.answers
      }
    }).then(res => {
      wx.hideLoading();
      const r = res && res.result;
      if (!r || !r.ok) {
        this.setData({ sending: false });
        return util.toast((r && r.msg) || '判定失败，请重试', 'none');
      }
      // 本地缓存证据记录（passed 区分达标/未达标）；id 用预生成的 evId，与云端 clientId 对齐
      tutorStore.addEvidence({
        id: evId,
        subject: this.data.subject,
        subjectName: this.data.subjectName,
        topic: this.data.topic,
        errorType: this.data.errorType,
        total: r.total,
        correct: r.correct,
        rate: r.rate,
        passed: !!r.pass
      });

      // 复习窗口推进（闭环 S2）：只由复测证据驱动，未关联错题的复测不推进
      // 入队由 advanceReview 内部自动完成（不再硬编码 '<mistakeId>_rv' 这种命名约定）
      if (this.data.mistakeId) {
        tutorStore.advanceReview(this.data.mistakeId, !!r.pass);
      }

      // 达标 → 标记对应错题为「已订正」（优先按 id 精确匹配，兜底按学科+知识点）
      if (r.pass) {
        let mk = this.data.mistakeId
          ? tutorStore.getMistakes().find(m => m.id === this.data.mistakeId)
          : null;
        if (!mk) {
          mk = tutorStore.getMistakes().find(m =>
            m.subject === this.data.subject && m.topic === this.data.topic);
        }
        if (mk) tutorStore.setMistakeStatus(mk.id, 'corrected');   // 入队由内部完成
      }

      // 触发一次合并推送（evidence / mistakes / reviews 的入队都已由 tutorStore 内部登记）
      tutorStore.pushQueued();

      this.setData({ sending: false, result: r, phase: 'result' });
    }).catch(err => {
      wx.hideLoading();
      console.warn('[retest] 判定失败', err);
      this.setData({ sending: false });
      const msg = (err && err.errMsg) || '';
      util.toast(/timeout|timed? ?out/i.test(msg) ? '判定超时，请重试一次' : '判定失败，请检查网络后重试', 'none');
    });
  },

  /* ---------------- 结果展示 ---------------- */
  retry() { this.generate(); },
  goBack() { wx.navigateBack({ delta: 1 }); }
});

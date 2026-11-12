/**
 * 复测页（全科导学 P3 → P0 attempt 化）
 *  · 从错题本/回顾/导学单进入：按知识点生成 5 道同类选择题
 *  · 也可从单元必会清单以「变式」身份进入（kind=variant + 情境）：题目换成新情境，
 *    标签由服务端建 attempt 时钉死并随证据落库，供证据阶梯 L5/L6 使用
 *  · 题面不含答案：答案与解析留在服务端，判分只由服务端完成（客户端改不了判分依据）
 *  · 交卷必须声明「是否独立完成」：仅「独立完成」的达标才形成证据、才推进复习窗口
 *  · 契约红线：≥5 题且 ≥80% 才「达标」；结果只显示「达标/未达标」，绝不显示「已掌握」
 */
const store = require('../../utils/store.js');
const tutorStore = require('../../utils/tutorStore.js');
const util = require('../../utils/util.js');
const tutorSubjects = require('../../utils/tutorSubjects.js');
const mistakeRules = require('../../utils/mistakeRules.js');
const config = require('../../utils/config.js');

const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

/* 独立性声明选项：默认不选中，必须由孩子自己点（预选等于替孩子回答） */
const INDEPENDENCE_OPTS = [
  { value: 'self_declared_no_hint', label: '独立完成（没看提示）', hint: '计入复测证据' },
  { value: 'prompted', label: '看了提示 / 有人帮', hint: '只记录，不计入证据' }
];

Page({
  data: {
    subject: 'math',
    subjectName: '数学',
    subjectEmoji: '🔢',
    topic: '',
    errorType: '',
    errorTypeLabel: '',        // 错因完整标签（如 'E7 信息处理'）
    phase: 'loading',          // loading | answering | result
    questions: [],             // [{q, options[], letters[]}] —— attempt 模式不含 answer/analysis
    answers: [],               // 字母数组，与 questions 对齐
    current: 0,                // 当前题号
    attemptId: '',             // 服务端出题编号（交卷凭据）
    mistakeId: '',             // 来源错题 id（空 = 未关联错题的独立复测）
    recommendationId: '',       // 来源建议（复习窗口 id / 导学单号），仅作溯源
    unitId: '',                 // 知识点归属（必会清单入口带上，证据才能精确归点）
    kpId: '',
    kind: 'retest',             // 'retest' 普通复测 | 'variant' 换情境变式（证据阶梯 L5/L6 记录源）
    context: '',                // 变式情境（白名单值；普通复测恒为空）
    independenceOpts: INDEPENDENCE_OPTS,
    independence: '',          // 未选择 = 空（不预选）
    sending: false,
    errorMsg: '',
    result: null               // submit 返回
  },

  onLoad(options) {
    let subject = 'math';
    let topic = '', errorType = '', mistakeId = '', recommendationId = '';
    let unitId = '', kpId = '', kind = 'retest', context = '';
    if (options) {
      if (options.key || options.subject) subject = options.key || options.subject;
      topic = decodeURIComponent(options.topic || '');
      errorType = decodeURIComponent(options.errorType || '');
      mistakeId = decodeURIComponent(options.mid || '');   // 错题 id：复习窗口推进/错题状态回写用
      recommendationId = decodeURIComponent(options.recommendationId || options.rid || '');
      unitId = decodeURIComponent(options.uid || '');       // 必会清单入口：证据按 unitId+kpId 精确归点
      kpId = decodeURIComponent(options.pid || '');
      // 白名单校验放在端上只是「少发一次无效请求」；服务端仍会自己再校验一遍
      kind = options.kind === 'variant' ? 'variant' : 'retest';
      const allowed = (config.PROFILE && config.PROFILE.VARIANT_CONTEXTS) || [];
      context = kind === 'variant' ? decodeURIComponent(options.ctx || '') : '';
      if (allowed.indexOf(context) < 0) context = '';
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
      mistakeId: mistakeId,
      recommendationId: recommendationId,
      unitId: unitId,
      kpId: kpId,
      kind: kind,
      context: context
    });
    this.generate();
  },

  /* ---------------- 生成复测题 ---------------- */
  generate() {
    this.setData({
      phase: 'loading', questions: [], answers: [], current: 0,
      attemptId: '', independence: '', result: null, errorMsg: ''
    });
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
        features: 'attempt_v1',          // 声明接受「题面不含答案」的契约
        subject: this.data.subject,
        topic: this.data.topic,
        errorType: this.data.errorType,
        grade: (child && child.grade) || '',
        recommendationId: this.data.recommendationId,
        mistakeId: this.data.mistakeId,
        unitId: this.data.unitId,
        kpId: this.data.kpId,
        kind: this.data.kind,
        context: this.data.context
      }
    }).then(res => {
      const r = res && res.result;
      if (!r || !r.ok) {
        this.setData({ phase: 'result', errorMsg: (r && r.msg) || '复测题生成失败，请重试' });
        return;
      }
      // 没有 attemptId 说明服务端还是旧版：此时题面可能带答案，交卷也拿不到服务端判分，
      // 直接停下比走旧路径更好 —— 旧路径的证据只能算 client_claimed，不该由新页面产生。
      if (!r.attemptId) {
        this.setData({ phase: 'result', errorMsg: '复测服务版本不匹配，请稍后重试' });
        return;
      }
      const qs = (r.questions || []).map(q => ({
        q: q.q,
        options: q.options,
        letters: q.options.map((_, i) => OPTION_LETTERS[i])
      }));
      this.setData({
        attemptId: r.attemptId,
        questions: qs,
        answers: new Array(qs.length).fill(''),
        phase: 'answering'
      });
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

  pickIndependence(e) {
    if (this.data.sending) return;
    this.setData({ independence: e.currentTarget.dataset.value || '' });
  },

  goPrev() { if (this.data.current > 0) this.setData({ current: this.data.current - 1 }); },
  goNext() { if (this.data.current < this.data.questions.length - 1) this.setData({ current: this.data.current + 1 }); },

  answeredCount() {
    return this.data.answers.filter(a => a).length;
  },

  /* ---------------- 交卷（服务端判分） ---------------- */
  submit() {
    if (this.data.sending) return;
    const total = this.data.questions.length;
    const answered = this.answeredCount();
    if (answered < total) {
      return util.toast('还有 ' + (total - answered) + ' 题没答，答完再交哦');
    }
    if (!this.data.independence) {
      return util.toast('先选一下：这次是自己做的，还是看了提示？');
    }
    this.setData({ sending: true });
    wx.showLoading({ title: '正在判定…', mask: true });
    // 预生成证据 id：本地记录与云端文档共用同一个 clientId，
    // 否则云端会同时留下「直写（无 clientId）+ push 回补（有 clientId）」两份重复证据
    const evId = util.uid('ev');
    wx.cloud.callFunction({
      name: 'tutorRetest',
      data: {
        action: 'submit',
        attemptId: this.data.attemptId,
        answers: this.data.answers,
        independence: this.data.independence,
        mistakeId: this.data.mistakeId,
        evidenceClientId: evId
      }
    }).then(res => {
      wx.hideLoading();
      const r = res && res.result;
      if (!r || !r.ok) {
        this.setData({ sending: false });
        return util.toast((r && r.msg) || '判定失败，请重试', 'none');
      }
      this.afterSubmit(r, evId);
    }).catch(err => {
      wx.hideLoading();
      console.warn('[retest] 交卷失败', err);
      this.setData({ sending: false });
      const msg = (err && err.errMsg) || '';
      util.toast(/timeout|timed? ?out/i.test(msg) ? '判定超时，请重试一次' : '判定失败，请检查网络后重试', 'none');
    });
  },

  /** 交卷后本地联动：只有真正形成证据时才写证据 / 推进复习 / 回写错题状态 */
  afterSubmit(r, evId) {
    // 服务端已判分；但 evidenceId 为空说明证据没落库（云端写失败）——
    // 此时本地不造一条云端并不存在的证据，避免两端不一致。
    const evidenced = !!r.evidenceProduced && !!r.evidenceId;
    if (evidenced) {
      tutorStore.addEvidence({
        id: r.evidenceId || evId,
        attemptId: r.attemptId,
        subject: this.data.subject,
        subjectName: this.data.subjectName,
        topic: this.data.topic,
        errorType: this.data.errorType,
        total: r.total,
        correct: r.correct,
        rate: r.rate,
        passed: !!r.pass,
        independence: r.independence,
        factGrade: 'server_recorded',
        // 归点与变式标签：标签取服务端回传的那份（前端改不了自己升档）
        unitId: this.data.unitId,
        kpId: this.data.kpId,
        evidenceKind: r.evidenceKind || 'retest',
        context: r.context || ''
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

      // 触发一次合并推送（mistakes / reviews 的入队都在 tutorStore 内部登记）
      tutorStore.pushQueued();
    }

    this.setData({ sending: false, result: r, phase: 'result' });
  },

  /* ---------------- 结果展示 ---------------- */
  retry() { this.generate(); },
  goBack() { wx.navigateBack({ delta: 1 }); }
});

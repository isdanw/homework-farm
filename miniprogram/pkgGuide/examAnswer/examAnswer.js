/**
 * examAnswer —— 在线作答页（P2）
 * 按 questions[] 渲染题型：choice 点选 / fill·calc·essay 文本 / draw 全屏书写画板。
 * draw 题支持「书写后导出上传图片」+「可选文字答案」（文字便于自动批改；图片需配置视觉模型）。
 * 提交收集 answers 调 examService.grade，跳转报告页并刷新错题本。
 */
const EXAM = require('../../utils/examApi.js');
const tutorStore = require('../../utils/tutorStore.js');
const figureDraw = require('../../utils/figureDraw.js');

Page({
  data: {
    exam: null, loading: true, error: '',
    answers: {}, submitting: false,
    drawModal: false, drawQid: '', drawCtx: null, drawLastX: 0, drawLastY: 0, drawSaved: false
  },

  onLoad(q) {
    this.examClientId = q.examClientId;
    this.load();
  },

  async load() {
    const r = await EXAM.getExam(this.examClientId);
    if (!r || !r.ok) { this.setData({ loading: false, error: (r && r.msg) || '加载失败' }); return; }
    const exam = r.exam;
    const questions = Array.isArray(exam.questions) ? exam.questions : [];
    if (!questions.length) { this.setData({ loading: false, error: '该卷暂不支持在线作答，请返回查看卷面' }); return; }
    // 预计算选择题选项标签（A/B/C/D），避免 WXML 内联数组字面量
    const LABELS = ['A', 'B', 'C', 'D'];
    const figs = [];
    questions.forEach(function (q) {
      if (q.type === 'choice' && Array.isArray(q.options)) {
        q.opts = q.options.map(function (o, i) { return { label: LABELS[i] || '', text: o }; });
      }
      // 题图：只认结构化 figure；顺手算好显示高度（rpx），WXML 里不再做运算
      if (q.figure && Array.isArray(q.figure.items) && q.figure.items.length) {
        q.figH = figureDraw.boxHeight(q.figure);
        figs.push(q.figure);
      } else {
        delete q.figure;
      }
    });
    const answers = {};
    questions.forEach(function (q) { answers[q.id] = { text: '', imageRefs: [], drawText: '' }; });
    this.figs = figs;
    this.setData({ loading: false, exam: exam, answers: answers }, () => {
      figureDraw.paint(this, '.q-fig', figs);
    });
  },

  onChoice(e) {
    const qid = e.currentTarget.dataset.qid;
    const opt = e.currentTarget.dataset.opt;
    const a = this.data.answers;
    if (!a[qid]) a[qid] = { text: '', imageRefs: [], drawText: '' };
    a[qid].text = opt;
    this.setData({ answers: a });
  },

  onText(e) {
    const qid = e.currentTarget.dataset.qid;
    const a = this.data.answers;
    if (!a[qid]) a[qid] = { text: '', imageRefs: [], drawText: '' };
    a[qid].text = e.detail.value;
    this.setData({ answers: a });
  },

  onDrawText(e) {
    const qid = e.currentTarget.dataset.qid;
    const a = this.data.answers;
    if (!a[qid]) a[qid] = { text: '', imageRefs: [], drawText: '' };
    a[qid].drawText = e.detail.value;
    this.setData({ answers: a });
  },

  /* ---------------- 书写画板（draw 题型） ---------------- */
  noop() {},

  openDraw(e) {
    const qid = e.currentTarget.dataset.qid;
    this.setData({ drawModal: true, drawQid: qid, drawSaved: false });
    // 等待 modal 渲染后初始化画布
    setTimeout(() => {
      const ctx = wx.createCanvasContext('drawCanvas', this);
      ctx.setStrokeStyle('#111827');
      ctx.setLineWidth(4);
      ctx.setLineCap('round');
      ctx.setLineJoin('round');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1000, 1400);
      ctx.draw();
      this.setData({ drawCtx: ctx });
    }, 50);
  },

  drawStart(e) {
    const t = e.touches[0];
    this.setData({ drawLastX: t.x, drawLastY: t.y });
  },

  drawMove(e) {
    const ctx = this.data.drawCtx;
    if (!ctx) return;
    const t = e.touches[0];
    ctx.beginPath();
    ctx.moveTo(this.data.drawLastX, this.data.drawLastY);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.draw(true);
    this.setData({ drawLastX: t.x, drawLastY: t.y });
  },

  drawEnd() {},

  clearDraw() {
    const ctx = this.data.drawCtx;
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1000, 1400);
    ctx.draw();
  },

  async saveDraw() {
    const qid = this.data.drawQid;
    const that = this;
    wx.canvasToTempFilePath({
      canvasId: 'drawCanvas',
      success(res) {
        wx.cloud.uploadFile({
          cloudPath: 'exam_draw/' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.png',
          filePath: res.tempFilePath,
          success(up) {
            const a = that.data.answers;
            if (!a[qid]) a[qid] = { text: '', imageRefs: [], drawText: '' };
            a[qid].imageRefs = [up.fileID];
            that.setData({ answers: a, drawModal: false, drawSaved: true });
            wx.showToast({ title: '书写已保存', icon: 'success' });
          },
          fail() { wx.showToast({ title: '上传失败', icon: 'none' }); }
        });
      },
      fail() { wx.showToast({ title: '保存失败', icon: 'none' }); }
    });
  },

  closeDraw() { this.setData({ drawModal: false }); },

  /* ---------------- 提交批改 ---------------- */
  async submit() {
    if (this.data.submitting) return;
    const exam = this.data.exam;
    const a = this.data.answers;
    const answers = exam.questions.map(function (q) {
      const item = a[q.id] || {};
      if (q.type === 'draw') {
        return { qid: q.id, text: item.drawText || '', imageRefs: item.imageRefs || [] };
      }
      return { qid: q.id, text: item.text || '' };
    });
    this.setData({ submitting: true });
    const r = await EXAM.gradeExam({
      examClientId: this.examClientId,
      answers: answers,
      submissionClientId: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
    });
    this.setData({ submitting: false });
    if (!r || !r.ok) { wx.showToast({ title: (r && r.msg) || '批改失败', icon: 'none' }); return; }
    EXAM.setLastGrade(r);
    EXAM.setLastExam(this.data.exam);
    // 刷新错题本（后端已把判错题写入 tutor_mistakes）
    try { tutorStore.syncFromCloud(); } catch (e) {}
    wx.redirectTo({ url: '/pkgGuide/examReport/examReport' });
  }
});

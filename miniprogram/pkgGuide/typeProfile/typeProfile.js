/**
 * 每种打卡类型的学科画像（参考 数学/语文/英语 画像）
 *  · 教材版本 / 进度 / 学习者编号
 *  · 能力维度：可增删，每项含 1-5 掌握度（level）初值
 *  · 常见错误模式：可增删
 * 数据按类型 key 存于当前孩子的 subjectProfiles[key]，随 store.save 上云。
 */
const store = require('../../utils/store.js');
const { parseProfilePrompt } = require('../../utils/profileParser.js');
const studyPlan = require('../../utils/studyPlan.js');

Page({
  data: {
    key: '',
    typeName: '',
    typeEmoji: '',
    typeColor: '#BFE6FF',
    textbook: '',
    progress: '',
    learnerNo: '',
    planPrompt: '',
    planHint: '',       // 已有计划时的入口提示
    dimensions: [],     // [{ name, level }]
    errors: [],         // [string]
    // 智能识别
    showPaste: false,
    rawText: ''
  },

  onLoad(options) {
    const key = (options && options.key) || '';
    const t = store.getType(key);
    const p = store.getSubjectProfile(key);
    const plan = studyPlan.getPlan(key);
    const prog = plan ? studyPlan.getProgress(key) : null;
    const builtinRole = studyPlan.getBuiltinRole(key);
    this.setData({
      key,
      typeName: t.name,
      typeEmoji: t.emoji || '📘',
      typeColor: t.color || '#BFE6FF',
      textbook: p.textbook || '',
      progress: p.progress || '',
      learnerNo: p.learnerNo || '',
      planPrompt: (p.planPrompt || studyPlan.defaultPrompt(t.name)),
      hasBuiltinRole: !!builtinRole,
      builtinRoleName: builtinRole ? builtinRole.name : '',
      planHint: prog ? (prog.statusText + ' · ' + prog.doneCount + '/' + prog.totalTasks + ' 项') : '',
      dimensions: (p.dimensions || []).map(d => ({ name: d.name, level: d.level || 2 })),
      errors: (p.errors || []).slice()
    });
  },

  /* ---- 文本字段 ---- */
  onTextbook(e) { this.setData({ textbook: e.detail.value }); },
  onProgress(e) { this.setData({ progress: e.detail.value }); },
  onLearnerNo(e) { this.setData({ learnerNo: e.detail.value }); },
  onPlanPrompt(e) { this.setData({ planPrompt: e.detail.value }); },

  /* ---- 成长计划入口 ---- */
  goPlan() {
    // 离开前把编排要求存掉
    store.saveSubjectProfile(this.data.key, { planPrompt: (this.data.planPrompt || '').trim() });
    wx.navigateTo({ url: '/pkgTools/plan/plan?key=' + this.data.key });
  },

  /* ---- 能力维度 ---- */
  onDimName(e) {
    const i = e.currentTarget.dataset.i;
    const ds = this.data.dimensions.slice();
    ds[i] = Object.assign({}, ds[i], { name: e.detail.value });
    this.setData({ dimensions: ds });
  },
  dimMinus(e) {
    const i = e.currentTarget.dataset.i;
    const ds = this.data.dimensions.slice();
    ds[i] = Object.assign({}, ds[i], { level: Math.max(1, ds[i].level - 1) });
    this.setData({ dimensions: ds });
  },
  dimPlus(e) {
    const i = e.currentTarget.dataset.i;
    const ds = this.data.dimensions.slice();
    ds[i] = Object.assign({}, ds[i], { level: Math.min(5, ds[i].level + 1) });
    this.setData({ dimensions: ds });
  },
  addDim() {
    wx.showModal({
      title: '新增能力维度',
      editable: true,
      placeholderText: '如：数感与数数',
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) return;
        const ds = this.data.dimensions.slice();
        ds.push({ name, level: 2 });
        this.setData({ dimensions: ds });
      }
    });
  },
  removeDim(e) {
    const i = e.currentTarget.dataset.i;
    const ds = this.data.dimensions.slice();
    ds.splice(i, 1);
    this.setData({ dimensions: ds });
  },

  /* ---- 常见错误模式 ---- */
  addErr() {
    wx.showModal({
      title: '新增错误模式',
      editable: true,
      placeholderText: '如：看错加减符号(E1)',
      success: (res) => {
        if (!res.confirm) return;
        const v = (res.content || '').trim();
        if (!v) return;
        const arr = this.data.errors.slice();
        arr.push(v);
        this.setData({ errors: arr });
      }
    });
  },
  removeErr(e) {
    const i = e.currentTarget.dataset.i;
    const arr = this.data.errors.slice();
    arr.splice(i, 1);
    this.setData({ errors: arr });
  },

  /* ---- 保存 ---- */
  buildPatch() {
    const d = this.data;
    return {
      subject: d.typeName,
      textbook: (d.textbook || '').trim(),
      progress: (d.progress || '').trim(),
      learnerNo: (d.learnerNo || '').trim(),
      planPrompt: (d.planPrompt || '').trim(),
      dimensions: d.dimensions.map(x => ({ name: (x.name || '').trim(), level: x.level || 2 }))
                    .filter(x => x.name),
      errors: d.errors.map(x => (x || '').trim()).filter(Boolean)
    };
  },
  save() {
    store.saveSubjectProfile(this.data.key, this.buildPatch());
    wx.showToast({ title: '已保存', icon: 'success' });
    setTimeout(() => wx.navigateBack({ delta: 1 }), 500);
  },

  /* ======================= 智能识别：粘贴提示词自动填入 ======================= */
  togglePaste() { this.setData({ showPaste: !this.data.showPaste }); },
  onPasteInput(e) { this.setData({ rawText: e.detail.value }); },

  parseAndApply() {
    const text = (this.data.rawText || '').trim();
    if (!text) return wx.showToast({ title: '先粘贴画像提示词', icon: 'none' });

    const parsed = parseProfilePrompt(text);
    if (!parsed.matched.length) {
      return wx.showModal({
        title: '未能识别',
        content: '没有找到可识别的画像字段。提示词需包含「教材版本 / 能力维度 / 常见错误模式 / 进度 / 学习者编号」等字段，请检查粘贴内容。',
        showCancel: false, confirmText: '知道了'
      });
    }

    if (parsed.textbook) this.setData({ textbook: parsed.textbook });
    if (parsed.progress) this.setData({ progress: parsed.progress });
    if (parsed.learnerNo) this.setData({ learnerNo: parsed.learnerNo });
    if (parsed.dimensions.length) this.setData({ dimensions: parsed.dimensions });
    if (parsed.errors.length) this.setData({ errors: parsed.errors });

    store.saveSubjectProfile(this.data.key, this.buildPatch());
    wx.showToast({ title: '识别 ' + parsed.matched.join('、') + ' 已保存', icon: 'none', duration: 2200 });
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});

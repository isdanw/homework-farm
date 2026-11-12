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
const teachingPlan = require('../../utils/teachingPlan.js');

Page({
  data: {
    key: '',
    typeName: '',
    typeEmoji: '',
    typeColor: '#BFE6FF',
    textbook: '',
    textbookId: '',   // 教材库条目锚点（选用后计划生成按单元目录编排；空=旧行为）
    progress: '',
    learnerNo: '',
    planPrompt: '',
    planHint: '',       // 已有计划时的入口提示
    dimensions: [],     // [{ name, level }]
    errors: [],         // [string]
    // 教学计划（与成长计划关联：导入后生成计划/导学会参考其目标与重点）
    tpTitle: '',        // 已导入教学计划标题
    tpFormat: 'text',   // 已导入格式
    tpUpdatedAt: 0,     // 已导入更新时间
    showTpSheet: false, // 导入 sheet 显隐
    tpPaste: '',        // 编辑中的原文
    tpPreviewShort: '', // 预览（清洗后前 800 字）
    tpHasPreview: false,
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
    const tp = p.teachingPlan || null;
    this.setData({
      key,
      typeName: t.name,
      typeEmoji: t.emoji || '📘',
      typeColor: t.color || '#BFE6FF',
      textbook: p.textbook || '',
      textbookId: p.textbookId || '',
      progress: p.progress || '',
      learnerNo: p.learnerNo || '',
      planPrompt: (p.planPrompt || studyPlan.defaultPrompt(t.name)),
      hasBuiltinRole: !!builtinRole,
      builtinRoleName: builtinRole ? builtinRole.name : '',
      planHint: prog ? (prog.statusText + ' · ' + prog.doneCount + '/' + prog.totalTasks + ' 项') : '',
      dimensions: (p.dimensions || []).map(d => ({ name: d.name, level: d.level || 2 })),
      errors: (p.errors || []).slice(),
      tpTitle: tp ? (tp.title || '') : '',
      tpFormat: tp ? (tp.format || 'text') : 'text',
      tpUpdatedAt: tp ? (tp.updatedAt || 0) : 0
    });
  },

  /** 从教材库选用返回：重读画像（教材页选用时已直接写 store，这里只刷新显示） */
  onShow() {
    if (!this.data.key) return;
    const p = store.getSubjectProfile(this.data.key);
    this.setData({
      textbook: p.textbook || '',
      textbookId: p.textbookId || ''
    });
  },

  /* ---- 文本字段 ---- */
  onTextbook(e) { this.setData({ textbook: e.detail.value }); },
  onProgress(e) { this.setData({ progress: e.detail.value }); },
  onLearnerNo(e) { this.setData({ learnerNo: e.detail.value }); },
  onPlanPrompt(e) { this.setData({ planPrompt: e.detail.value }); },

  /* ---- 教材库入口：选用结构化教材（写 textbookId 锚点，计划生成按单元目录编排） ---- */
  goTextbookLib() { wx.navigateTo({ url: '/pkgTools/textbookLib/textbookLib?pick=1&key=' + this.data.key }); },
  clearTextbookId() { this.setData({ textbookId: '' }); },

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
      textbookId: d.textbookId || '',
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

  /* ======================= 教学计划导入（与成长计划关联，不独立成模块） ======================= */
  openTpSheet() {
    const tp = this.data.key ? (store.getSubjectProfile(this.data.key).teachingPlan || null) : null;
    this.setData({
      showTpSheet: true,
      tpTitle: tp ? (tp.title || '') : '',
      tpPaste: '',
      tpPreviewShort: tp ? (tp.raw || '').slice(0, 800) : '',
      tpHasPreview: !!(tp && tp.raw),
      tpFormat: tp ? (tp.format || 'text') : 'text'
    });
  },
  closeTpSheet() { this.setData({ showTpSheet: false }); },
  noop() {},

  onTpPaste(e) {
    const val = e.detail.value || '';
    const fmt = teachingPlan.detectFormat('', val);
    const cleaned = teachingPlan.cleanPlanText(val, fmt);
    this.setData({
      tpPaste: val,
      tpFormat: fmt,
      tpPreviewShort: cleaned.slice(0, 800),
      tpHasPreview: cleaned.length > 0
    });
  },
  chooseTpFile() {
    const that = this;
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['md', 'html', 'htm', 'txt'],
      success(res) {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        wx.getFileSystemManager().readFile({
          filePath: f.path,
          encoding: 'utf-8',
          success(r) {
            const content = r.data || '';
            const fmt = teachingPlan.detectFormat(f.name || '', content);
            const cleaned = teachingPlan.cleanPlanText(content, fmt);
            that.setData({
              tpPaste: content,
              tpFormat: fmt,
              tpPreviewShort: cleaned.slice(0, 800),
              tpHasPreview: cleaned.length > 0
            });
          },
          fail() { wx.showToast({ title: '读取文件失败', icon: 'none' }); }
        });
      },
      fail() {}
    });
  },
  onTpTitle(e) { this.setData({ tpTitle: e.detail.value }); },
  saveTp() {
    const raw = teachingPlan.cleanPlanText(this.data.tpPaste || '', this.data.tpFormat);
    if (!raw) return wx.showToast({ title: '请先粘贴或选择内容', icon: 'none' });
    let title = (this.data.tpTitle || '').trim();
    if (!title) {
      const first = raw.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
      title = (first.replace(/^#+\s*/, '').slice(0, 60)) || (this.data.typeName + ' 教学计划');
    }
    const rec = { title: title.slice(0, 60), format: this.data.tpFormat, raw: raw.slice(0, 20000), outline: null, updatedAt: Date.now() };
    store.saveSubjectProfile(this.data.key, { teachingPlan: rec });
    this.setData({ showTpSheet: false, tpTitle: rec.title, tpFormat: rec.format, tpUpdatedAt: rec.updatedAt });
    wx.showToast({ title: '教学计划已保存', icon: 'success' });
  },
  clearTp() {
    const that = this;
    wx.showModal({
      title: '清除教学计划',
      content: '确定清除已导入的教学计划吗？成长计划与导学将不再引用它。',
      success(res) {
        if (!res.confirm) return;
        store.saveSubjectProfile(that.data.key, { teachingPlan: null });
        that.setData({ tpTitle: '', tpFormat: 'text', tpUpdatedAt: 0 });
        wx.showToast({ title: '已清除', icon: 'none' });
      }
    });
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});

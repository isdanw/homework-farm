/**
 * 儿童全局画像（参考 学习者画像）
 *  · 学段 / 每周可学习时间 / 常用时段 / 讲解偏好 / 期望内容 / 自我感受 / 学校进度
 *  · 年级(grade)沿用「我的」里的孩子资料，这里只读展示，避免重复维护
 */
const store = require('../../utils/store.js');
const CFG = require('../../utils/config.js');

const P = CFG.PROFILE;

Page({
  data: {
    nickname: '',
    avatar: '',
    grade: '',
    // 选项池（单选 picker 用）
    stages: P.STAGES,
    teachStyles: P.TEACH_STYLES,
    selfFeelings: P.SELF_FEELINGS,
    // 多选 chips 视图（含选中态 on；WXML 表达式不支持 indexOf，故在 JS 预计算）
    timeSlots: [],
    expectations: [],
    // 表单
    stageIndex: -1,
    teachIndex: -1,
    feelingIndex: -1,
    weeklyMinutes: '',
    timeSlotsSel: [],
    expectationsSel: [],
    schoolProgress: ''
  },

  onLoad() {
    const u = store.get();
    const lr = store.getLearner();
    this.setData({
      nickname: u.nickname,
      avatar: u.avatar,
      grade: u.grade || '',
      stageIndex: lr.stage ? P.STAGES.indexOf(lr.stage) : -1,
      teachIndex: lr.teachStyle ? P.TEACH_STYLES.indexOf(lr.teachStyle) : -1,
      feelingIndex: lr.selfFeeling ? P.SELF_FEELINGS.indexOf(lr.selfFeeling) : -1,
      weeklyMinutes: lr.weeklyMinutes ? String(lr.weeklyMinutes) : '',
      timeSlotsSel: (lr.timeSlots || []).slice(),
      expectationsSel: (lr.expectations || []).slice(),
      schoolProgress: lr.schoolProgress || ''
    });
    this.refreshChips();
  },

  /** 预计算多选 chips 的选中态（WXML 表达式不支持 indexOf，只能在 JS 算好 on） */
  refreshChips() {
    const selSlots = this.data.timeSlotsSel;
    const selExps = this.data.expectationsSel;
    this.setData({
      timeSlots: P.TIME_SLOTS.map(name => ({ name, on: selSlots.indexOf(name) >= 0 })),
      expectations: P.EXPECTATIONS.map(name => ({ name, on: selExps.indexOf(name) >= 0 }))
    });
  },

  /* ---- 单选类（picker） ---- */
  onStage(e) { this.setData({ stageIndex: Number(e.detail.value) }); },
  onTeach(e) { this.setData({ teachIndex: Number(e.detail.value) }); },
  onFeeling(e) { this.setData({ feelingIndex: Number(e.detail.value) }); },

  /* ---- 每周可学习时间 ---- */
  onMinutes(e) { this.setData({ weeklyMinutes: e.detail.value }); },

  /* ---- 多选 chips：常用时段 ---- */
  toggleSlot(e) {
    const v = e.currentTarget.dataset.val;
    const arr = this.data.timeSlotsSel.slice();
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
    this.setData({ timeSlotsSel: arr });
    this.refreshChips();
  },

  /* ---- 多选 chips：期望内容 ---- */
  toggleExpect(e) {
    const v = e.currentTarget.dataset.val;
    const arr = this.data.expectationsSel.slice();
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
    this.setData({ expectationsSel: arr });
    this.refreshChips();
  },

  /* ---- 学校进度 ---- */
  onProgress(e) { this.setData({ schoolProgress: e.detail.value }); },

  /* ---- 保存 ---- */
  save() {
    const d = this.data;
    const minutes = parseInt(d.weeklyMinutes, 10);
    const patch = {
      stage: d.stageIndex >= 0 ? P.STAGES[d.stageIndex] : '',
      weeklyMinutes: isNaN(minutes) || minutes < 0 ? 0 : minutes,
      timeSlots: d.timeSlotsSel.slice(),
      teachStyle: d.teachIndex >= 0 ? P.TEACH_STYLES[d.teachIndex] : '',
      expectations: d.expectationsSel.slice(),
      selfFeeling: d.feelingIndex >= 0 ? P.SELF_FEELINGS[d.feelingIndex] : '',
      schoolProgress: (d.schoolProgress || '').trim()
    };
    store.saveLearner(patch);

    // 打通「画像 → 成长计划」：顶层年级为空时，从「学校进度」自动推导年级并回填，
    // 这样「我的」页与成长计划都能识别（如填「一年级上学期」→ 自动补「一年级」）
    const cur = store.get();
    if (!cur.grade) {
      const g = store.parseGrade(patch.schoolProgress);
      if (g) store.updateUser(cur.id, { grade: g });
    }

    wx.showToast({ title: '已保存', icon: 'success' });
    setTimeout(() => wx.navigateBack({ delta: 1 }), 500);
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});

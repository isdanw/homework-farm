/**
 * 我的（用户管理中枢）
 *  · 当前孩子档案卡：头像 / 昵称 / 年级 / 连续打卡 / 农场资源
 *  · 切换孩子：点列表里的某个孩子即切换（所有页面实时联动）
 *  · 添加孩子：昵称 + emoji 头像 + 年级
 *  · 编辑当前孩子 / 删除当前孩子
 */
const store = require('../../utils/store.js');
const util = require('../../utils/util.js');
const analytics = require('../../utils/analytics.js');
const sched = require('../../utils/scheduleEngine.js');
const studyPlan = require('../../utils/studyPlan.js');

const AVATARS = ['🐯', '🐻', '🐰', '🐱', '🐶', '🐼', '🦁', '🐸', '🐵', '🐧', '🦊', '🐥'];
const GRADES = ['小班', '中班', '大班', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];

Page({
  data: {
    users: [],
    currentId: '',
    current: null,
    others: [],                   // 除当前孩子外的其他孩子（Hero 卡片内切换）
    bind: { bound: false, masked: '' },
    showWxDetail: false,
    wxName: '',
    wxAvatar: '',
    isDemo: false,
    showTools: false,
    showAdd: false,
    showEdit: false,
    showBaseline: false,
    baseline: null,
    scheduleInfo: '',             // 课表入口摘要（如「已录入 2026 秋季学期 · 12 节课」）
    form: { nickname: '', avatar: '🐯', grade: '' },
    avatarOptions: AVATARS,
    gradeOptions: GRADES
  },

  onLoad() {
    this._onChange = () => this.render();
    store.on(this._onChange);
  },
  onUnload() { store.off(this._onChange); },

  onShow() {
    if (this.getTabBar) {
      const tb = this.getTabBar();
      if (tb) tb.setData({ selected: 3 });
    }
    this.render();
  },

  /* ======================= 微信绑定（可点击入口） ======================= */
  async bindWechat() {
    if (this.data.bind.bound) {
      return util.toast('已绑定该微信，数据与该账号同步', 'none');
    }
    wx.showLoading({ title: '正在绑定微信…', mask: true });
    let r = null;
    try { r = await store.bindWechat(); } catch (e) { r = null; }
    wx.hideLoading();
    if (!r || !r.ok) {
      // 用弹窗展示具体失败原因，方便定位（而不是笼统的「绑定失败」）
      let title = '绑定失败';
      let msg = '请稍后重试';
      if (r && r.reason === 'cloud') {
        title = '云端未开通';
        msg = '当前环境未开通云开发，无法绑定微信。可先以「本地模式」使用，数据仅存本机。';
      } else if (r && r.reason === 'callfail') {
        title = '云函数调用失败';
        msg = 'syncData 云函数可能未部署到环境 workbuddy-d2gsgtfvmde5c9adf，或小程序与云环境不在同一账号。\n错误：' + (r.err || '');
      } else if (r && r.reason === 'openid') {
        title = '未获取到 openid';
        msg = '云函数 syncData 未包含 whoami 分支，请在开发者工具右键 syncData → 上传并部署（云端安装依赖）。';
      }
      wx.showModal({ title, content: msg, showCancel: false, confirmText: '知道了' });
      return;
    }
    this.render();
    util.toast('已绑定微信，数据已同步到该账号', 'success');
  },
  toggleWxDetail() { this.setData({ showWxDetail: !this.data.showWxDetail }); },

  /* ======================= 渲染 ======================= */
  render() {
    const root = store.getRoot();
    const cur = store.get();
    const users = root.users.map(u => ({
      id: u.id,
      nickname: u.nickname,
      avatar: u.avatar,
      grade: u.grade,
      streak: u.profile.streak,
      coins: u.farm.coins,
      suns: u.farm.suns,
      plants: u.farm.plots.filter(p => p).length,
      isCurrent: u.id === root.currentUserId
    }));
    const current = users.find(x => x.id === root.currentUserId) || users[0];
    const wxProfile = store.getWxProfile();

    // 课表入口摘要
    let scheduleInfo = '';
    try {
      const sch = sched.getSchedule();
      const n = Object.keys(sch.cells).length;
      scheduleInfo = n
        ? ('已录入' + (sch.termName ? '「' + sch.termName + '」' : '课程表') + ' · ' + n + ' 节课')
        : '还没有录入课程表，点这里拍照或手动填写';
    } catch (e) { scheduleInfo = ''; }

    this.setData({
      users,
      others: users.filter(u => !u.isCurrent),
      currentId: root.currentUserId,
      current,
      bind: store.getBindInfo(),
      wxName: wxProfile.nickname,
      wxAvatar: wxProfile.avatarUrl,
      isDemo: !!store.get().__isDemo,
      scheduleInfo: scheduleInfo,
      planInfo: this.buildPlanInfo(),
      hubInfo: this.buildHubInfo(),
      learnerSummary: this.buildLearnerSummary(store.get())
    });
  },

  /* ======================= 儿童画像摘要 ======================= */
  buildLearnerSummary(u) {
    const lr = (u && u.learner) || {};
    const parts = [];
    if (u && u.grade) parts.push(u.grade);
    if (lr.stage) parts.push(lr.stage);
    if (lr.weeklyMinutes) parts.push('每周 ' + lr.weeklyMinutes + ' 分钟');
    if (lr.teachStyle) parts.push('讲解：' + lr.teachStyle);
    return parts.length ? parts.join(' · ') : '';
  },

  /** 成长计划入口摘要：已生成计划数 + 最近状态 */
  buildPlanInfo() {
    try {
      const types = store.getTypeList();
      const withPlan = [];
      types.forEach(t => {
        const prog = studyPlan.getProgress(t.key);
        if (prog) withPlan.push(t.name + ' ' + prog.statusText);
      });
      if (!withPlan.length) return '还没有生成计划，点这里按年级、学期与教材为各科编排阶段任务';
      return '已生成 ' + withPlan.length + ' 份 · ' + withPlan.join(' / ');
    } catch (e) { return ''; }
  },

  /* ======================= 同步微信昵称 / 头像 ======================= */
  // 选择微信头像（button open-type="chooseAvatar" 触发，返回临时路径，需持久化保存）
  onChooseAvatar(e) {
    const temp = e.detail && e.detail.avatarUrl;
    if (!temp) return;
    let saved = temp;
    try {
      // 临时路径会过期，落盘为持久路径，避免重开后头像变空白
      saved = wx.getFileSystemManager().saveFileSync(temp);
    } catch (err) { console.warn('[mine] 保存微信头像失败，沿用临时路径', err); }
    store.setWxProfile({ avatarUrl: saved });
    this.render();
    util.toast('微信头像已同步', 'success');
  },
  // 使用微信昵称（input type="nickname" 点「使用微信昵称」或手动输入触发）
  onNickname(e) {
    const nickname = (e.detail && e.detail.nickname || '').trim();
    if (!nickname) return;
    store.setWxProfile({ nickname });
    this.render();
    util.toast('微信昵称已同步', 'success');
  },

  /* ======================= 切换孩子 ======================= */
  switchUser(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.currentId) return;
    store.setCurrentUser(id);
    const u = this.data.users.find(x => x.id === id);
    util.toast('已切换到 ' + (u ? u.nickname : '该孩子'), 'success');
    this.render();
  },

  /* ======================= 添加孩子 ======================= */
  openAdd() {
    this.setData({ showAdd: true, form: { nickname: '', avatar: '🐯', grade: '' } });
  },
  closeAdd() { this.setData({ showAdd: false }); },
  pickAvatarAdd(e) { this.setData({ 'form.avatar': e.currentTarget.dataset.emoji }); },
  pickGradeAdd(e) { this.setData({ 'form.grade': e.currentTarget.dataset.g }); },
  onNickAdd(e) { this.setData({ 'form.nickname': e.detail.value }); },
  confirmAdd() {
    const f = this.data.form;
    const nickname = (f.nickname || '').trim();
    if (!nickname) return util.toast('先给新朋友起个名字吧');
    store.addUser({ nickname, avatar: f.avatar, grade: f.grade });
    this.setData({ showAdd: false });
    util.toast('已添加「' + nickname + '」，并切换过去啦', 'success');
    this.render();
  },

  /* ======================= 编辑当前孩子 ======================= */
  openEdit() {
    const c = this.data.current || {};
    this.setData({ showEdit: true, form: { nickname: c.nickname || '', avatar: c.avatar || '🐯', grade: c.grade || '' } });
  },
  closeEdit() { this.setData({ showEdit: false }); },
  pickAvatarEdit(e) { this.setData({ 'form.avatar': e.currentTarget.dataset.emoji }); },
  pickGradeEdit(e) { this.setData({ 'form.grade': e.currentTarget.dataset.g }); },
  onNickEdit(e) { this.setData({ 'form.nickname': e.detail.value }); },
  confirmEdit() {
    const f = this.data.form;
    const nickname = (f.nickname || '').trim();
    if (!nickname) return util.toast('昵称不能为空');
    store.updateUser(this.data.currentId, { nickname, avatar: f.avatar, grade: f.grade });
    this.setData({ showEdit: false });
    util.toast('资料已更新', 'success');
    this.render();
  },

  /* ======================= 删除当前孩子 ======================= */
  __stop() {},   // 阻止点击对话框冒泡到遮罩（避免误关闭）

  removeUser() {
    if (this.data.users.length <= 1) {
      return util.toast('至少得保留一个孩子哦');
    }
    const name = (this.data.current && this.data.current.nickname) || '该孩子';
    wx.showModal({
      title: '删除孩子',
      content: '确定要删除「' + name + '」吗？TA 的打卡记录和农场数据都会被清空，无法恢复。',
      confirmColor: '#FF7A7A',
      success: (res) => {
        if (!res.confirm) return;
        const ok = store.removeUser(this.data.currentId);
        if (ok) { util.toast('已删除', 'success'); this.render(); }
      }
    });
  },

  /* ======================= 家长工具（从首页移入） ======================= */
  toggleTools() { this.setData({ showTools: !this.data.showTools }); },
  goTypeManage() { wx.navigateTo({ url: '/pkgTools/typeManage/typeManage' }); },
  goSchedule() { wx.navigateTo({ url: '/pkgTools/schedule/schedule' }); },
  goLearnerProfile() { wx.navigateTo({ url: '/pkgGuide/learnerProfile/learnerProfile' }); },

  /* 成长计划入口（默认带第一个科目 key，页面内可切换） */
  goPlan() {
    const first = store.getTypeList()[0];
    wx.navigateTo({ url: '/pkgTools/plan/plan' + (first ? '?key=' + first.key : '') });
  },

  /** 网页看板入口：per-user 网页口令生成（与微信账户绑定） */
  goWebPortal() { wx.navigateTo({ url: '/pkgTools/webportal/webportal' }); },

  /** 导学中心入口（学习主线聚合：AI 导学 / 错题本 / 导学报告） */
  goTutorHub() { wx.navigateTo({ url: '/pkgGuide/tutorHub/tutorHub' }); },

  /** 导学中心入口摘要：待订正 + 已验证 */
  buildHubInfo() {
    try {
      const tutorStore = require('../../utils/tutorStore.js');
      const pending = tutorStore.getMistakes().filter(m => m.status !== 'corrected').length;
      const ev = tutorStore.evidencePassedCount();
      const parts = [];
      if (pending) parts.push('待订正 ' + pending + ' 题');
      if (ev) parts.push('已验证 ' + ev + ' 项');
      return parts.length ? parts.join(' · ') : '导学助手 · 错题本 · 导学报告，一站式学习闭环';
    } catch (e) { return '导学助手 · 错题本 · 导学报告，一站式学习闭环'; }
  },

  exportData() {
    try {
      const path = store.exportJSON();
      wx.shareFileMessage({
        filePath: path,
        success: () => util.toast('备份已发送，记得保存到微信收藏', 'success'),
        fail: () => wx.openDocument({ filePath: path, showMenu: true, fail: () => util.toast('备份文件已生成：' + path) })
      });
    } catch (e) { util.toast('导出失败：' + e.message); }
  },
  importData() {
    store.importJSON()
      .then(() => { util.toast('恢复成功！', 'success'); this.render(); })
      .catch(err => { if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) return; util.toast('导入失败，请选择正确的备份文件'); });
  },
  clearDemo() {
    wx.showModal({
      title: '清空示例数据',
      content: '会删除预置的示例任务和示例植物，重新开始记录。确定吗？',
      confirmColor: '#FF7A7A',
      success: (res) => { if (!res.confirm) return; store.reset(true); this.render(); util.toast('已清空，开始你的农场吧！', 'success'); }
    });
  },

  /* ======================= 体验数据基线（阶段 0） ======================= */
  viewBaseline() {
    const b = analytics.computeBaseline(store.get().id);
    this.setData({ showBaseline: true, baseline: b });
  },
  closeBaseline() { this.setData({ showBaseline: false }); }
});

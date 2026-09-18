/**
 * 登录门（启动强制登录 + 完善首个孩子资料）
 *  · 全新用户：必须先「微信登录」并填写首个孩子（昵称/头像/年级）才能进入
 *  · 已登录用户（本地已有孩子）：app.js 会直接 reLaunch 到首页，本页 onLoad 也会兜底跳转
 */
const store = require('../../utils/store.js');
const util = require('../../utils/util.js');

const AVATARS = ['🐯', '🐻', '🐰', '🐱', '🐶', '🐼', '🦁', '🐸', '🐵', '🐧', '🦊', '🐥'];
const GRADES = ['小班', '中班', '大班', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];

Page({
  data: {
    step: 0,                 // 0 = 未登录（展示微信登录）；1 = 已登录（填资料）
    logging: false,
    form: { nickname: '', avatar: '🐯', grade: '' },
    avatarOptions: AVATARS,
    gradeOptions: GRADES
  },

  onLoad() {
    // 已登录过（本地已有孩子）→ 直接进入首页，不显示登录门
    if (store.isOnboarded()) {
      wx.reLaunch({ url: '/pages/index/index' });
    }
  },

  /* ======================= 微信一键登录 ======================= */
  wechatLogin() {
    if (this.data.logging) return;
    this.setData({ logging: true });
    // wx.login：建立微信登录态（openid 已由 store.initAccount 通过 syncData(whoami) 取得）
    wx.login({
      success: () => this.afterLogin(false),
      fail: () => this.afterLogin(true)   // 极少见：仍允许本机模式进入
    });
  },

  afterLogin(localFallback) {
    this.setData({ logging: false, step: 1 });
    if (localFallback) util.toast('未连接到微信，将使用本机模式', 'none');

    // 若云同步已把本账号数据拉回（如换手机登录同一微信号），且已有孩子 → 直接进首页
    if (store.isOnboarded()) {
      wx.reLaunch({ url: '/pages/index/index' });
    }
  },

  /* ======================= 填写首个孩子资料 ======================= */
  pickAvatar(e) { this.setData({ 'form.avatar': e.currentTarget.dataset.emoji }); },
  pickGrade(e) { this.setData({ 'form.grade': e.currentTarget.dataset.g }); },
  onNick(e) { this.setData({ 'form.nickname': e.detail.value }); },

  submit() {
    const f = this.data.form;
    const nickname = (f.nickname || '').trim();
    if (!nickname) return util.toast('先给孩子起个名字吧');

    store.addUser({ nickname, avatar: f.avatar, grade: f.grade });
    util.toast('欢迎进入成长乐园', 'success');
    wx.reLaunch({ url: '/pages/index/index' });
  }
});

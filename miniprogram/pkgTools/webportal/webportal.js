/**
 * 网页看板（per-user 口令生成）
 *  · 调用 webPortalBind 云函数（仅小程序端可调用，信任根为 cloud.getWXContext().OPENID）
 *  · create：复用优先，本 openid 已有未撤销口令时直接返回原令牌（reused:true）不再轮换；否则生成新令牌 + 深链 + 二维码（reused:false）。确保重复点「生成」不会让已分享链接/二维码失效。
 *  · list ：列出本 openid 有效口令（用于回显，避免重复生成打断已登录的电脑端）
 *  · revoke：撤销（本 openid 全部，或指定 token）
 */
const util = require('../../utils/util.js');
const HOST = 'https://workbuddy-d2gsgtfvmde5c9adf-1305268412.tcloudbaseapp.com/';

function maskToken(t) { return t.slice(0, 6) + '…' + t.slice(-4); }

Page({
  data: {
    loading: false,
    token: '',
    mask: '',
    deepLink: '',
    qrDataUrl: ''
  },

  onShow() { this.loadCurrent(); },

  /* 回显本 openid 当前有效口令（不打断已在用的电脑端会话） */
  async loadCurrent() {
    try {
      const r = await wx.cloud.callFunction({ name: 'webPortalBind', data: { action: 'list' } });
      const res = (r && r.result) || {};
      if (res.ok && res.tokens && res.tokens.length) {
        const t = res.tokens[0];
        this.setData({
          token: t.token,
          mask: t.mask,
          deepLink: HOST + '?tok=' + t.token,
          qrDataUrl: ''   // 历史口令不在端上留存二维码，重新生成即可获取
        });
      }
    } catch (e) { /* 云函数未部署时静默，UI 仍显示「生成」入口 */ }
  },

  /* 生成（或重新生成）口令 */
  async generate() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    wx.showLoading({ title: '生成口令…', mask: true });
    try {
      const r = await wx.cloud.callFunction({ name: 'webPortalBind', data: { action: 'create' } });
      const res = (r && r.result) || {};
      wx.hideLoading();
      if (!res.ok) {
        this.setData({ loading: false });
        wx.showModal({ title: '生成失败', content: res.msg || '请稍后重试', showCancel: false });
        return;
      }
      this.setData({
        loading: false,
        token: res.token,
        mask: maskToken(res.token),
        deepLink: res.deepLink,
        qrDataUrl: res.qrDataUrl || ''
      });
      // 复用优先：已存在有效口令时直接复用，提示明确「未更换」，避免用户误以为口令被轮换
      if (res.reused) {
        util.toast('已复用现有口令（未更换），扫码或打开链接即可登录', 'success');
      } else {
        util.toast('已生成新口令，扫码或打开链接即可登录', 'success');
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ loading: false });
      wx.showModal({
        title: '生成失败',
        content: '云函数 webPortalBind 未部署到环境 workbuddy-d2gsgtfvmde5c9adf，或网络异常：' + ((e && e.errMsg) || e),
        showCancel: false
      });
    }
  },

  /** 复制统一入口：空值给引导提示，失败给失败提示，成功先压掉系统「内容已复制」再弹自定义 toast */
  _copy(text, okMsg, emptyMsg) {
    if (!text) return util.toast(emptyMsg);
    wx.setClipboardData({
      data: text,
      success: () => {
        // 微信复制成功后自动弹系统级「内容已复制」toast，会盖住自定义提示；先隐藏再弹
        wx.hideToast();
        setTimeout(() => util.toast(okMsg, 'success'), 60);
      },
      fail: (e) => {
        const detail = (e && e.errMsg) || String(e) || '未知原因';
        console.warn('[webportal] 复制失败', detail);
        // 失败时弹窗兜底：内容可直接长按选择复制（modal 文本可选中）
        wx.showModal({
          title: '自动复制不可用',
          content: text + '\n\n（原因：' + detail + '。可长按上方内容手动复制）',
          showCancel: false,
          confirmText: '知道了'
        });
      }
    });
  },
  copyLink() { this._copy(this.data.deepLink, '链接已复制', '请先生成口令'); },
  copyToken() { this._copy(this.data.token, '口令已复制', '请先生成口令'); },

  revoke() {
    if (!this.data.token) return;
    wx.showModal({
      title: '撤销网页口令',
      content: '撤销后，当前链接与二维码立即失效。确定吗？',
      confirmColor: '#FF7A7A',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '撤销中…', mask: true });
        try {
          const r = await wx.cloud.callFunction({ name: 'webPortalBind', data: { action: 'revoke', token: this.data.token } });
          const rr = (r && r.result) || {};
          wx.hideLoading();
          if (rr.ok) {
            this.setData({ token: '', mask: '', deepLink: '', qrDataUrl: '' });
            util.toast('已撤销', 'success');
          } else {
            wx.showModal({ title: '撤销失败', content: rr.msg || '', showCancel: false });
          }
        } catch (e) {
          wx.hideLoading();
          wx.showModal({ title: '撤销失败', content: (e && e.errMsg) || String(e), showCancel: false });
        }
      }
    });
  }
});

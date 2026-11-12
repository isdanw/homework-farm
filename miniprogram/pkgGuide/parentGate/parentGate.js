/**
 * 家长验证（pkgGuide/parentGate）
 * ================================================================
 * 一个页面四种形态，按云端状态自动切换：
 *   setup    还没有口令 → 两次输入设置（设置成功后自动验证一次并直接解锁）
 *   verify   有口令但本机会话已过期/未验证 → 输一次口令换 2 小时会话
 *   change   已验证状态下改口令 → 必须先输当前口令（云端校验），改完自动重新验证
 *   unlocked 已验证 → 展示有效期与权限，可「结束本次验证」
 *
 * 硬约束：
 *   1. **没有自助重置**：忘记口令页面上不给任何「重置/找回」入口（云端也没有），
 *      只能由家长另找途径处理；这是家长凭证的意义，不做为了体验牺牲门禁的兜底。
 *   2. 锁定期间（云端 5 次失败锁 15 分钟）提交一律不请求云端，只跑本地倒计时。
 *   3. 页面 data 里的 pin 只用于本次提交，成功/失败都会清空；不写 storage、不打日志。
 */
const auth = require('../../utils/parentAuth.js');

const PIN_RE = /^\d{4,8}$/;

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function fmtTime(ts) {
  const d = new Date(Number(ts) || 0);
  if (!(Number(ts) > 0)) return '';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtCountdown(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return pad2(m) + ':' + pad2(s % 60);
}

Page({
  data: {
    mode: 'loading',
    hasPin: false,
    locked: false,
    countdown: '',
    pin: '',
    pin2: '',
    oldPin: '',
    submitting: false,
    errMsg: '',
    session: null,
    expiresText: '',
    scopes: [],
    scopeLabel: ''      // 调用方指定的本次目标权限（?scope=orderIssue 等），空表示从「我的」直接进入
  },

  /* 从门禁调用方进来的，验证通过后自动回跳，省一次手动返回 */
  onLoad(options) {
    const scope = String((options && options.scope) || '').trim();
    this._scope = auth.SCOPE_LABEL[scope] ? scope : '';
    this.setData({ scopeLabel: this._scope ? auth.SCOPE_LABEL[this._scope] : '' });
  },

  onShow() { this.refresh(); },
  onUnload() { this.stopTick(); },

  /* ---------------- 状态同步 ---------------- */
  async refresh() {
    this.stopTick();
    const st = await auth.status();
    if (!st || !st.ok) {
      this.setData({
        mode: 'error',
        errMsg: (st && st.msg) || '无法连接云端，请稍后再试'
      });
      return;
    }
    const session = auth.getSession();
    const patch = {
      hasPin: !!st.hasPin,
      locked: !!st.locked,
      errMsg: '', pin: '', pin2: '', oldPin: '',
      scopes: (session && session.scopes && session.scopes.length ? session.scopes : auth.SCOPES)
        .map(function (s) { return auth.SCOPE_LABEL[s] || s; })
    };
    if (!st.hasPin) {
      patch.mode = 'setup';
      patch.session = null;
      patch.expiresText = '';
    } else if (session) {
      patch.mode = 'unlocked';
      patch.session = session;
      patch.expiresText = fmtTime(session.expiresAt);
    } else {
      patch.mode = 'verify';
      patch.session = null;
      patch.expiresText = '';
    }
    this.setData(patch);
    if (st.locked && st.retryAfterSec) this.startTick(st.retryAfterSec);
  },

  /* ---------------- 锁定倒计时 ---------------- */
  startTick(sec) {
    this.stopTick();
    let left = Math.max(0, Math.ceil(Number(sec) || 0));
    const paint = () => this.setData({
      locked: left > 0,
      countdown: left > 0 ? fmtCountdown(left) : ''
    });
    paint();
    if (!left) return;
    this._tick = setInterval(() => {
      left -= 1;
      paint();
      if (left <= 0) {
        this.stopTick();
        this.refresh();
      }
    }, 1000);
  },
  stopTick() {
    if (this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
  },

  /* ---------------- 输入 ---------------- */
  onPinInput(e) { this.setData({ pin: String((e && e.detail && e.detail.value) || '') }); },
  onPin2Input(e) { this.setData({ pin2: String((e && e.detail && e.detail.value) || '') }); },
  onOldPinInput(e) { this.setData({ oldPin: String((e && e.detail && e.detail.value) || '') }); },

  /* ---------------- 提交 ---------------- */
  submit() {
    if (this.data.submitting) return;
    if (this.data.mode === 'setup') return this.doSetPin();
    if (this.data.mode === 'verify') return this.doVerify();
    if (this.data.mode === 'change') return this.doChange();
  },

  checkPinFields(pin, pin2) {
    if (!PIN_RE.test(pin)) return '口令需为 4-8 位数字';
    if (pin2 !== undefined && pin2 !== pin) return '两次输入的口令不一致';
    return '';
  },

  async doSetPin() {
    const pin = this.data.pin;
    const bad = this.checkPinFields(pin, this.data.pin2);
    if (bad) { this.setData({ errMsg: bad }); return; }
    this.setData({ submitting: true, errMsg: '' });
    const r = await auth.setPin(pin);
    if (!r || !r.ok) {
      this.setData({ submitting: false });
      return this.onFail(r);
    }
    const v = await auth.verify(pin);
    this.setData({ submitting: false });
    if (!v || !v.ok) {
      this.setData({ mode: 'verify', pin: '', pin2: '', errMsg: '口令已保存，请再验证一次' });
      return;
    }
    this.unlocked();
  },

  async doVerify() {
    if (this.data.locked) { this.setData({ errMsg: '尝试次数过多，请稍后再试' }); return; }
    const pin = this.data.pin;
    const bad = this.checkPinFields(pin);
    if (bad) { this.setData({ errMsg: bad }); return; }
    this.setData({ submitting: true, errMsg: '' });
    const r = await auth.verify(pin);
    this.setData({ submitting: false });
    if (!r || !r.ok) return this.onFail(r);
    this.unlocked();
  },

  async doChange() {
    const oldPin = this.data.oldPin;
    if (!PIN_RE.test(oldPin)) { this.setData({ errMsg: '请输入当前口令（4-8 位数字）' }); return; }
    const pin = this.data.pin;
    const bad = this.checkPinFields(pin, this.data.pin2);
    if (bad) { this.setData({ errMsg: bad }); return; }
    this.setData({ submitting: true, errMsg: '' });
    const r = await auth.setPin(pin, oldPin);
    if (!r || !r.ok) {
      this.setData({ submitting: false });
      return this.onFail(r);
    }
    const v = await auth.verify(pin);
    this.setData({ submitting: false });
    if (!v || !v.ok) {
      this.setData({ mode: 'verify', oldPin: '', pin: '', pin2: '', errMsg: '口令已修改，请重新验证' });
      return;
    }
    this.unlocked();
  },

  onFail(r) {
    const code = r && r.code;
    if (code === 'pin_locked') {
      this.startTick((r && r.retryAfterSec) || 0);
      this.setData({ errMsg: '尝试次数过多，请稍后再试', pin: '', pin2: '', oldPin: '' });
      return;
    }
    if (code === 'pin_not_set') { this.refresh(); return; }
    if (code === 'pin_wrong' || code === 'need_old_pin') {
      this.setData({
        errMsg: (code === 'need_old_pin' ? '需要先输入当前口令' : '口令不正确') +
          (r && r.remaining ? '，还可尝试 ' + r.remaining + ' 次' : ''),
        pin: '', pin2: '', oldPin: ''
      });
      return;
    }
    this.setData({ errMsg: (r && r.msg) || '操作失败，请稍后再试' });
  },

  unlocked() {
    const s = auth.getSession();
    this.setData({
      mode: 'unlocked',
      session: s,
      expiresText: s ? fmtTime(s.expiresAt) : '',
      pin: '', pin2: '', oldPin: '', errMsg: '',
      scopes: (s && s.scopes && s.scopes.length ? s.scopes : auth.SCOPES)
        .map(function (k) { return auth.SCOPE_LABEL[k] || k; })
    });
    if (s && this._scope) this.backToCaller();
  },

  /** 由门禁调用方进入 → 验证通过即返回，原页面由用户再点一次原文按钮 */
  backToCaller() {
    wx.showToast({ title: '已验证，可以继续操作了', icon: 'none' });
    setTimeout(() => {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      if (pages && pages.length > 1) { wx.navigateBack({ delta: 1 }); return; }
      wx.switchTab({ url: '/pages/mine/mine' });
    }, 700);
  },

  /* ---------------- 已验证后的操作 ---------------- */
  openChange() {
    if (!this.data.hasPin) return;
    this.setData({ mode: 'change', oldPin: '', pin: '', pin2: '', errMsg: '' });
  },
  cancelChange() {
    this.setData({
      mode: this.data.hasPin ? 'verify' : 'setup',
      oldPin: '', pin: '', pin2: '', errMsg: ''
    });
  },
  async doRevoke() {
    await auth.revoke();
    this.setData({ session: null, expiresText: '' });
    await this.refresh();
  },
  /* 四种形态（含云端不可用）都必须能离开本页，否则用户没有口令时会被卡在这里。
   * 页面栈只有本页（扫码/分享直进、或调用方用了 redirectTo）→ 回「我的」，不用 navigateBack 静默失败。
   */
  goBack() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    if (pages && pages.length > 1) { wx.navigateBack({ delta: 1 }); return; }
    wx.switchTab({ url: '/pages/mine/mine' });
  }
});

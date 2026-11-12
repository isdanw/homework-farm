/**
 * parentAuth.js —— 家长凭证端上封装（PIN → parentSession）
 * ================================================================
 * 云端：云函数 `parentAuth`（PIN 加盐散列、5 次失败锁 15 分钟、会话 2 小时）。
 * 本文件只管两件事：
 *   1. 把会话 token 缓存在本机（key = parentSession），**过期即失效**；
 *   2. 统一收口云函数调用，页面不直接拼 action。
 *
 * 页面侧只用一个出口：`requireScope(scope)` —— 有会话放行，没有就弹窗引导去验证页。
 *
 * 红线（改本文件前先读）：
 *   · 本机**不缓存 PIN**（明文/散列都不缓存），只缓存 token 与过期时间；
 *   · 会话是否有效由「expiresAt + 云端校验」共同决定，本机过期判断只是省一次请求；
 *   · 所有失败都回 { ok:false, code }，不抛异常（页面按 code 决定文案）。
 */
const FN = 'parentAuth';
const KEY = 'parentSession';

/** §7.6 审批矩阵中**真正有写入口**的三项（与云端 SESSION_SCOPES 同源）。
 *  日报页尚未建、导出属于用户自救能力而非家长特权，两者都不入表，
 *  避免「拿到了一个没有对应动作的权限」这种假声明。 */
const SCOPES = ['orderIssue', 'planEdit', 'subjectToggle'];
const SCOPE_LABEL = {
  orderIssue: '签发 / 作废学习单',
  planEdit: '修改 / 清除计划',
  subjectToggle: '增删打卡类型'
};

function call(action, data) {
  return new Promise(function (resolve) {
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      return resolve({ ok: false, code: 'no_cloud', msg: '未连接云端' });
    }
    try {
      wx.cloud.callFunction({
        name: FN,
        data: Object.assign({ action: action }, data || {})
      }).then(function (res) {
        resolve((res && res.result) || { ok: false, code: 'no_result', msg: '云端无返回' });
      }).catch(function (e) {
        resolve({ ok: false, code: 'network', msg: (e && e.errMsg) || '调用失败' });
      });
    } catch (e) {
      resolve({ ok: false, code: 'network', msg: (e && e.message) || '调用失败' });
    }
  });
}

function readRaw() {
  try {
    const v = wx.getStorageSync(KEY);
    return v && typeof v === 'object' ? v : null;
  } catch (e) { return null; }
}

function saveSession(r) {
  if (!r || !r.ok || !r.token) return null;
  const s = {
    token: String(r.token),
    expiresAt: Number(r.expiresAt) || 0,
    scopes: Array.isArray(r.scopes) ? r.scopes.slice() : [],
    parentSessionId: String(r.parentSessionId || ''),
    at: Date.now()
  };
  try { wx.setStorageSync(KEY, s); } catch (e) {}
  return s;
}

function clearSession() {
  try { wx.removeStorageSync(KEY); } catch (e) {}
}

/** 本机有效会话（过期即清空并返回 null） */
function getSession() {
  const s = readRaw();
  if (!s || !s.token) return null;
  if (!(Number(s.expiresAt) > Date.now())) { clearSession(); return null; }
  return s;
}

function hasScope(session, scope) {
  const s = session || getSession();
  return !!(s && Array.isArray(s.scopes) && s.scopes.indexOf(scope) >= 0);
}

/** 云端状态（hasPin / 是否锁定 / 会话是否仍有效） */
function status() {
  const s = getSession();
  return call('status', s ? { sessionToken: s.token } : {});
}

/** 首次设置：无旧口令；有旧口令时必须提供 oldPin（未提供时云端回 need_old_pin） */
function setPin(pin, oldPin) {
  const data = { pin: String(pin == null ? '' : pin) };
  if (oldPin !== undefined && oldPin !== null && oldPin !== '') data.oldPin = String(oldPin);
  return call('setPin', data).then(function (r) {
    // 改口令会让云端吊销全部会话，本机副本一并清掉，避免拿着失效 token 去打门禁
    if (r && r.ok) clearSession();
    return r;
  });
}

function verify(pin) {
  return call('verifyPin', { pin: String(pin == null ? '' : pin) }).then(function (r) {
    if (r && r.ok) return Object.assign({}, r, { session: saveSession(r) });
    if (r && r.code === 'session_expired') clearSession();
    return r;
  });
}

function revoke() {
  const s = getSession();
  if (!s) { clearSession(); return Promise.resolve({ ok: true, revoked: false }); }
  return call('revoke', { sessionToken: s.token }).then(function (r) {
    clearSession();
    return r && r.ok ? r : { ok: true, revoked: false, code: (r && r.code) || 'network' };
  });
}

/** 门禁用：拿不到有效会话就返回 null（本机过期判断，云端校验由调用方决定是否再打一次） */
function ensureSession() { return getSession(); }

/**
 * 家长特权动作的前置门禁（页面在写操作前 await，false 就直接 return）。
 *
 * 定位：**协作式软门禁** —— 拦住的是同一台设备上的孩子，不是攻击者；
 * 真正的隔离只有云端校验 parentSession 才成立，本函数不做这个承诺。
 * 离线/本地模式（连不上云）时放行，否则口令本身依赖云端，会把整个写入口锁死。
 */
function requireScope(scope) {
  return new Promise(function (resolve) {
    const s = getSession();
    if (s && hasScope(s, scope)) return resolve(true);
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return resolve(true);
    const label = SCOPE_LABEL[scope] || '家长操作';
    wx.showModal({
      title: '需要家长验证',
      content: '「' + label + '」属于家长操作，验证通过后 2 小时内有效。',
      confirmText: '去验证',
      cancelText: '先不',
      success: function (r) {
        if (r && r.confirm) {
          wx.navigateTo({ url: '/pkgGuide/parentGate/parentGate?scope=' + encodeURIComponent(scope) });
        }
        resolve(false);
      },
      fail: function () { resolve(false); }
    });
  });
}

module.exports = {
  KEY, SCOPES, SCOPE_LABEL,
  status, setPin, verify, revoke,
  getSession, clearSession, ensureSession, hasScope,
  requireScope
};

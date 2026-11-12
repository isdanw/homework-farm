/**
 * 云函数 parentAuth —— 家长凭证（PIN → parentSession）
 * ============================================================
 * 依据《多Agent教学辅导系统-架构设计-v3》§7.5 / §7.6：家长特权动作（签发/作废学习单、
 * 改计划、增删打卡类型）必须有**独立于孩子的家长凭证**。
 *
 * 门禁已在端上接通（2026-10-29）：出单 / 作废重开、生成 / 清除计划、增删打卡类型
 * 三处写入口在落库前调 parentAuth.requireScope。这是**协作式软门禁**（拦孩子、不拦攻击者），
 * 与 openid 同设备的角色边界一致；真正的强隔离不在本函数承诺范围内。
 * 网页端入口（2026-10-29）：网页看板没有微信上下文，改用该家庭的网页看板口令（webToken）
 * 解析 openid。
 *
 * 契约：
 *   action='status'     { sessionToken? } → { ok, hasPin, locked, retryAfterSec, scopes, session? }
 *   action='setPin'     { pin, oldPin? }  → { ok, hasPin:true }
 *   action='verifyPin'  { pin }           → { ok, token, expiresAt, scopes, parentSessionId }
 *   action='revoke'     { sessionToken }  → { ok, revoked }
 *
 * 身份（两条，互斥）：
 *   · 小程序：event.userInfo.openId（微信网关注入）；
 *   · 网页：event.webToken = 该家庭「网页看板口令」（web_portal_bindings 未撤销令牌）→ openid。
 *     网页没有微信上下文，不能靠 userInfo；也**不接受**管理员全局口令（它没有家长身份）。
 *
 * 安全要点：
 *   · PIN 只存 scrypt(pin, salt)；**明文与哈希都不进日志、不进审计、不回包**；
 *   · 连续失败 5 次锁 15 分钟（锁定期间不再校验，也不累加计数）；
 *   · 会话按 token 的 sha256 作 `_id`（库里拿不到可用 token），2 小时过期，
 *     改 PIN 会吊销该账号全部会话；
 *   · 身份只取网关 openid 或网页绑定口令，空身份一律拒绝（不产生无主凭证）；
 *   · 所有状态变更追加写 tutor_parent_actions（不含 PIN 与 token）。
 */
const crypto = require('crypto');
const tcb = require('@cloudbase/node-sdk');

const ENV = process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf';
const CRED_COLL = 'parent_credentials';
const SESS_COLL = 'parent_sessions';
const AUDIT_COLL = 'tutor_parent_actions';
const BIND_COLL = 'web_portal_bindings';

/** §7.6 审批矩阵里**确实有写入口**的三项（与端上 parentAuth.SCOPES 同源）。
 *  日报页未建、导出属于用户自救能力，都不入表——不发没有对应动作的权限。 */
const SESSION_SCOPES = ['orderIssue', 'planEdit', 'subjectToggle'];
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const PIN_RE = /^\d{4,8}$/;
const TOKEN_MIN_LEN = 32;

function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}
function credId(openid) { return 'pc_' + sha256(openid); }
function sessionIdOf(token) { return 'ps_' + sha256(token); }
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), String(salt), 32).toString('hex');
}
/** 定长比较（hash 是十六进制串，长度相同才比较） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function app() { return tcb.init({ env: ENV }); }

/* ---------------- 审计（只追加，永不阻塞主流程） ---------------- */
async function audit(dbh, openid, action, extra) {
  try {
    await dbh.collection(AUDIT_COLL).add(Object.assign({
      openid: openid, action: action, at: Date.now()
    }, extra || {}));
  } catch (e) { /* 审计失败不影响凭证操作本身 */ }
}

/* ---------------- 会话校验（后续门禁复用同一份语义） ---------------- */
/**
 * @returns {{ok:true, session:Object}|{ok:false, code:String}}
 *   code: session_invalid（不存在/不属于该账号/已吊销）· session_expired
 */
async function verifySession(appObj, openid, token) {
  const t = str(token, 200);
  if (!t || t.length < TOKEN_MIN_LEN) return { ok: false, code: 'session_invalid' };
  const dbh = appObj.database();
  let doc = null;
  try {
    const res = await dbh.collection(SESS_COLL).doc(sessionIdOf(t)).get();
    doc = (res && res.data && (Array.isArray(res.data) ? res.data[0] : res.data)) || null;
  } catch (e) { doc = null; }
  if (!doc || doc.openid !== openid || doc.revoked) return { ok: false, code: 'session_invalid' };
  if (Number(doc.expiresAt) <= Date.now()) return { ok: false, code: 'session_expired' };
  try { await dbh.collection(SESS_COLL).doc(doc._id).update({ lastUsedAt: Date.now() }); } catch (e) {}
  return { ok: true, session: doc };
}

/* ---------------- 动作 ---------------- */
async function readCred(dbh, openid) {
  try {
    const res = await dbh.collection(CRED_COLL).doc(credId(openid)).get();
    const d = res && res.data;
    return (d && (Array.isArray(d) ? d[0] : d)) || null;
  } catch (e) { return null; }
}

function lockState(cred, now) {
  const until = Number(cred && cred.lockedUntil) || 0;
  if (until > now) return { locked: true, retryAfterSec: Math.ceil((until - now) / 1000) };
  return { locked: false, retryAfterSec: 0 };
}

async function actStatus(dbh, openid, ev) {
  const cred = await readCred(dbh, openid);
  const lock = lockState(cred, Date.now());
  const out = {
    ok: true, hasPin: !!(cred && cred.hash), locked: lock.locked,
    retryAfterSec: lock.retryAfterSec, scopes: SESSION_SCOPES
  };
  const token = str(ev.sessionToken, 200);
  if (token) {
    const s = await verifySession({ database: () => dbh }, openid, token);
    out.session = s.ok
      ? { active: true, expiresAt: Number(s.session.expiresAt), scopes: s.session.scopes || [] }
      : { active: false, code: s.code };
  }
  return out;
}

async function actSetPin(dbh, openid, ev, source) {
  const pin = str(ev.pin, 20);
  if (!PIN_RE.test(pin)) return { ok: false, code: 'bad_pin', msg: '家长口令必须是 4-8 位数字' };
  const cred = await readCred(dbh, openid);
  if (cred && cred.hash) {
    const lock = lockState(cred, Date.now());
    if (lock.locked) return { ok: false, code: 'pin_locked', retryAfterSec: lock.retryAfterSec, msg: '尝试次数过多，请稍后再试' };
    const oldPin = str(ev.oldPin, 20);
    if (!oldPin) return { ok: false, code: 'need_old_pin', msg: '设置新口令前需要先输入当前口令' };
    if (!safeEqual(hashPin(oldPin, cred.salt), cred.hash)) {
      const fails = (Number(cred.fails) || 0) + 1;
      const patch = { fails: fails, updatedAt: Date.now() };
      if (fails >= MAX_FAILS) patch.lockedUntil = Date.now() + LOCK_MS;
      try { await dbh.collection(CRED_COLL).doc(cred._id).update(patch); } catch (e) {}
      await audit(dbh, openid, 'setPinFailed', { fails: fails });
      return fails >= MAX_FAILS
        ? { ok: false, code: 'pin_locked', retryAfterSec: Math.ceil(LOCK_MS / 1000), msg: '尝试次数过多，已锁定 15 分钟' }
        : { ok: false, code: 'pin_wrong', remaining: MAX_FAILS - fails, msg: '当前口令不正确' };
    }
  }
  const salt = newSalt();
  const now = Date.now();
  const rec = {
    _id: credId(openid), openid: openid, salt: salt, hash: hashPin(pin, salt),
    fails: 0, lockedUntil: 0, createdAt: (cred && cred.createdAt) || now, updatedAt: now
  };
  await dbh.collection(CRED_COLL).doc(rec._id).set(rec);
  // 改口令 → 旧会话全部失效（家长可能是为了踢掉别处的登录）
  try { await dbh.collection(SESS_COLL).where({ openid: openid, revoked: false }).update({ revoked: true, revokedAt: now }); } catch (e) {}
  await audit(dbh, openid, 'setPin', { source: source || 'mini' });
  return { ok: true, hasPin: true };
}

async function actVerifyPin(dbh, openid, ev, source) {
  const pin = str(ev.pin, 20);
  if (!PIN_RE.test(pin)) return { ok: false, code: 'bad_pin', msg: '家长口令必须是 4-8 位数字' };
  const cred = await readCred(dbh, openid);
  if (!cred || !cred.hash) return { ok: false, code: 'pin_not_set', msg: '还没有设置家长口令' };
  const lock = lockState(cred, Date.now());
  if (lock.locked) {
    await audit(dbh, openid, 'pinLocked', { retryAfterSec: lock.retryAfterSec });
    return { ok: false, code: 'pin_locked', retryAfterSec: lock.retryAfterSec, msg: '尝试次数过多，请稍后再试' };
  }
  const now = Date.now();
  if (!safeEqual(hashPin(pin, cred.salt), cred.hash)) {
    const fails = (Number(cred.fails) || 0) + 1;
    const patch = { fails: fails, updatedAt: now };
    if (fails >= MAX_FAILS) patch.lockedUntil = now + LOCK_MS;
    try { await dbh.collection(CRED_COLL).doc(cred._id).update(patch); } catch (e) {}
    await audit(dbh, openid, fails >= MAX_FAILS ? 'pinLocked' : 'pinFailed', { fails: fails });
    return fails >= MAX_FAILS
      ? { ok: false, code: 'pin_locked', retryAfterSec: Math.ceil(LOCK_MS / 1000), msg: '尝试次数过多，已锁定 15 分钟' }
      : { ok: false, code: 'pin_wrong', remaining: MAX_FAILS - fails, msg: '口令不正确' };
  }
  try { await dbh.collection(CRED_COLL).doc(cred._id).update({ fails: 0, lockedUntil: 0, updatedAt: now }); } catch (e) {}
  const token = newToken();
  const sid = sessionIdOf(token);
  const expiresAt = now + SESSION_TTL_MS;
  const doc = {
    _id: sid, openid: openid, tokenHash: sha256(token),
    scopes: SESSION_SCOPES.slice(), createdAt: now, expiresAt: expiresAt,
    lastUsedAt: now, revoked: false
  };
  await dbh.collection(SESS_COLL).doc(sid).set(doc);
  await audit(dbh, openid, 'issueSession', { parentSessionId: sid, expiresAt: expiresAt, source: source || 'mini' });
  return { ok: true, token: token, expiresAt: expiresAt, scopes: doc.scopes, parentSessionId: sid };
}

async function actRevoke(dbh, openid, ev, source) {
  const token = str(ev.sessionToken, 200);
  if (!token || token.length < TOKEN_MIN_LEN) return { ok: false, code: 'bad_param', msg: '缺少会话标识' };
  const sid = sessionIdOf(token);
  let revoked = false;
  try {
    const res = await dbh.collection(SESS_COLL).doc(sid).get();
    const d = res && res.data && (Array.isArray(res.data) ? res.data[0] : res.data);
    if (d && d.openid === openid) {
      await dbh.collection(SESS_COLL).doc(sid).update({ revoked: true, revokedAt: Date.now() });
      revoked = true;
    }
  } catch (e) { revoked = false; }
  await audit(dbh, openid, 'revokeSession', { parentSessionId: sid, revoked: revoked, source: source || 'mini' });
  return { ok: true, revoked: revoked };
}

/* ---------------- 身份解析 ---------------- */
/**
 * @returns {{ok:true, openid:String, source:'mini'|'web'}|{ok:false, code:String, msg:String}}
 */
async function resolveIdentity(appObj, ev) {
  const webToken = str(ev.webToken, 200);
  if (webToken) {
    // 管理员全局口令在 web_portal_bindings 里没有记录；显式拒绝，避免「管理员」被当成某个家长
    if (process.env.WEB_DASHBOARD_TOKEN && webToken === process.env.WEB_DASHBOARD_TOKEN) {
      return { ok: false, code: 'admin_not_allowed', msg: '管理员口令没有家长身份，请用该家庭的网页看板口令操作' };
    }
    try {
      const res = await appObj.database().collection(BIND_COLL)
        .where({ token: webToken, revoked: false }).limit(1).get();
      const b = res && res.data && res.data[0];
      if (b && b.openid) return { ok: true, openid: str(b.openid, 100), source: 'web' };
    } catch (e) {
      return { ok: false, code: 'auth_error', msg: '网页口令校验异常：' + ((e && e.message) || e) };
    }
    return { ok: false, code: 'web_token_invalid', msg: '网页看板口令无效或已撤销' };
  }
  const openid = str(ev.userInfo && ev.userInfo.openId, 100);
  if (!openid) return { ok: false, code: 'no_openid', msg: '缺少用户身份，无法操作家长凭证' };
  return { ok: true, openid: openid, source: 'mini' };
}

/* ---------------- 主入口 ---------------- */
exports.main = async (event) => {
  const ev = event || {};
  let appObj;
  try { appObj = tcb.init({ env: ENV }); }
  catch (e) { return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) }; }
  const ident = await resolveIdentity(appObj, ev);
  if (!ident.ok) return { ok: false, code: ident.code, msg: ident.msg };
  const openid = ident.openid;
  const action = str(ev.action, 20);
  const dbh = appObj.database();
  try {
    if (action === 'status') {
      const r = await actStatus(dbh, openid, ev);
      if (r && r.ok) r.source = ident.source;
      return r;
    }
    if (action === 'setPin') return await actSetPin(dbh, openid, ev, ident.source);
    if (action === 'verifyPin') return await actVerifyPin(dbh, openid, ev, ident.source);
    if (action === 'revoke') return await actRevoke(dbh, openid, ev, ident.source);
    return { ok: false, code: 'bad_action', msg: '未知 action: ' + (action || '(空)') };
  } catch (e) {
    return { ok: false, code: 'auth_error', msg: '家长凭证操作失败：' + ((e && e.message) || e) };
  }
};

/* 供门禁与单测复用（签发/校验必须同一份语义，避免两套 hash 规则） */
module.exports = Object.assign(module.exports, {
  SESSION_SCOPES, SESSION_TTL_MS, MAX_FAILS, LOCK_MS,
  sha256, hashPin, sessionIdOf, verifySession, resolveIdentity
});

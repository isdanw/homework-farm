/**
 * 云函数 webPortalBind —— 网页看板 per-user 口令绑定（小程序 openid ↔ 网页令牌）
 *
 * 信任根：仅能被小程序端调用（wx.cloud.callFunction），通过 cloud.getWXContext().OPENID
 * 拿到调用者小程序 openid。该 openid 是微信原生、可信、客户端无法伪造——整条
 * "网页口令 ↔ 小程序微信账户" 链路的身份就来自这里，不依赖开放平台 / unionid / 企业认证。
 *
 * 口令用途：家长在小程序点「生成网页口令」→ 拿到令牌（及深链/二维码）→ 网页看板输入或扫码，
 * 网页端 webAdminQuery 用该令牌反查 openid，只返回该微信账户的数据。
 *
 * action：
 *   create  —— 复用优先：若本 openid 已有未撤销令牌，直接返回该令牌（reused:true）不再轮换；
 *             否则生成新 24 字节 hex 令牌 + 深链 + 二维码(dataURL)（reused:false）。
 *             一个 openid 仅保留一个有效口令，确保已分享的链接/二维码不会因重复点「生成」而失效。
 *   list    —— 列出本 openid 当前有效口令（掩码）
 *   revoke  —— 撤销本 openid 全部（或指定 token）口令
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const crypto = require('crypto');

const BIND = 'web_portal_bindings';
const HOST = 'https://workbuddy-d2gsgtfvmde5c9adf-1305268412.tcloudbaseapp.com/';

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, code: 'no_openid', msg: '非小程序环境调用，无法获取微信身份' };
  const action = (event && event.action) || 'create';
  try {
    if (action === 'create') return await create(OPENID);
    if (action === 'list') return await list(OPENID);
    if (action === 'revoke') return await revoke(OPENID, event && event.token);
    return { ok: false, code: 'bad_action', msg: '未知 action: ' + action };
  } catch (e) {
    return { ok: false, code: 'error', msg: (e && e.message) || String(e) };
  }
};

async function create(openid) {
  // 复用优先：本 openid 已有未撤销令牌时，直接返回该令牌，不再轮换。
  // 这样口令固定不变，已分享的链接/二维码不会因重复点「生成」而失效。
  const existing = await db.collection(BIND).where({ openid, revoked: false }).limit(1).get();
  if (existing && existing.data && existing.data.length) {
    const t = existing.data[0];
    const deepLink = HOST + '?tok=' + t.token;
    let qrDataUrl = '';
    try { const QRCode = require('qrcode'); qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 320 }); } catch (e) { /* 二维码失败不影响口令 */ }
    return { ok: true, token: t.token, deepLink, qrDataUrl, reused: true };
  }
  // 无有效令牌时才新建（一个 openid 仅保留一个有效口令）
  const token = crypto.randomBytes(24).toString('hex');
  await db.collection(BIND).add({ data: { token, openid, createdAt: Date.now(), lastUsed: 0, revoked: false } });
  const deepLink = HOST + '?tok=' + token;
  let qrDataUrl = '';
  try { const QRCode = require('qrcode'); qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 320 }); } catch (e) { /* 二维码失败不影响口令 */ }
  return { ok: true, token, deepLink, qrDataUrl, reused: false };
}

async function list(openid) {
  const res = await db.collection(BIND).where({ openid, revoked: false }).orderBy('createdAt', 'desc').limit(10).get();
  const tokens = res.data.map(d => ({ mask: d.token.slice(0, 6) + '…' + d.token.slice(-4), createdAt: d.createdAt, lastUsed: d.lastUsed }));
  return { ok: true, tokens };
}

async function revoke(openid, token) {
  const q = token ? { openid, token } : { openid };
  await db.collection(BIND).where(q).update({ data: { revoked: true, revokedAt: Date.now() } });
  return { ok: true };
}

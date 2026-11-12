/**
 * scopeGuard.js —— 云函数写入口统一作用域（P0-1）
 * ============================================================================
 * **canonical 源**：cloudfunctions/_shared/scopeGuard.js
 * 各云函数目录下的 scopeGuard.js 是副本，由 `node scripts/sync-scope-guard.mjs`
 * 生成，**禁止手改副本**（副本带 canonical-sha256 校验行，测试会比对）。
 *
 * 为什么需要副本：本项目的云函数逐个目录独立上传（tcb fn deploy --dir），
 * 云端不会解析 `../_shared`，所以要复制。副本与 canonical 完全同字节（仅多一段
 * 生成头注释），改一处即可，靠脚本 + 测试防漂移。
 *
 * 职责边界（只做纯逻辑，不碰数据库）：
 *   1. requireOpenid  —— 空身份一律拒绝，绝不产生无主数据；
 *   2. stripIdentity  —— 客户端传来的 openid/_openid 一律丢弃，身份只由服务端注入；
 *   3. resolveChildId —— 孩子归属只能取自该 openid 的 users[]，不接受跨家庭指定；
 *                        不回落 users[0]（多孩家庭里那是「猜」）。
 *
 * 不做的事：不读库、不校验业务字段、不决定是否可写某集合（那是各写入方的事）。
 */

/** 身份字段：客户端不得指定 */
const IDENTITY_KEYS = ['openid', '_openid'];

/** 占位切片 id：只活在内存里，永不落盘（R5）。当前端用 'guest'，早期用 '__placeholder' */
const PLACEHOLDER_IDS = ['guest', '__placeholder', ''];

function s(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * 身份守卫。返回 { ok:true, openid } 或 { ok:false, code, msg }。
 * 调用方拿到 !ok 必须原样返回，且不得再创建集合/文档。
 *
 * 只接受非空字符串：微信下发的 openid 一定是字符串，非字符串只可能来自
 * 客户端伪造或取值路径写错 —— 一律 fail-closed，不做 String() 宽容转换。
 */
function requireOpenid(openid) {
  if (typeof openid !== 'string') {
    return { ok: false, code: 'no_openid', msg: '缺少用户身份，拒绝写入' };
  }
  const oid = openid.trim();
  if (!oid) return { ok: false, code: 'no_openid', msg: '缺少用户身份，拒绝写入' };
  return { ok: true, openid: oid };
}

/**
 * 就地剥离身份字段并返回同一个对象（便于链式使用）。
 * 只删 openid/_openid：childId 由 resolveChildId 校验后单独赋值。
 */
function stripIdentity(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  for (const k of IDENTITY_KEYS) delete doc[k];
  return doc;
}

/**
 * 真实孩子列表。
 * 排除：非对象、id 非字符串/为空、内存占位切片（__placeholder 标记或占位 id 'guest'）。
 * 占位切片也是 currentUserId 指向的对象（未创建孩子时），把它当成孩子会把数据挂到 'guest' 下。
 */
function childrenOf(root) {
  const users = root && Array.isArray(root.users) ? root.users : [];
  return users.filter(u => u
    && typeof u.id === 'string'
    && PLACEHOLDER_IDS.indexOf(u.id) < 0
    && u.__placeholder !== true);
}

/** childId 是否属于该家庭 */
function isChildOf(root, childId) {
  const cid = s(childId);
  return !!cid && childrenOf(root).some(u => u.id === cid);
}

/**
 * 解析写入归属的孩子。
 *   requested 合法            → { childId, source:'requested' }
 *   requested 非法/跨家庭     → { childId:'', source:'invalid' }（不写别人的孩子，也不整单失败）
 *   未提供                    → 取 currentUserId（当前孩子）
 *   当前孩子也无效/无档案     → { childId:'', source:'none' }
 *
 * ⚠️ 刻意不回落 users[0]：多孩家庭里「第一个孩子」不是当前孩子，回落即串数据。
 *    调用方应把 source='invalid' 记入审计/响应，便于发现客户端传错。
 */
function resolveChildId(root, requested) {
  const wanted = s(requested);
  if (wanted) {
    return isChildOf(root, wanted)
      ? { childId: wanted, source: 'requested' }
      : { childId: '', source: 'invalid' };
  }
  const current = s(root && root.currentUserId);
  if (current && isChildOf(root, current)) return { childId: current, source: 'current' };
  return { childId: '', source: 'none' };
}

module.exports = {
  IDENTITY_KEYS,
  requireOpenid,
  stripIdentity,
  childrenOf,
  isChildOf,
  resolveChildId
};

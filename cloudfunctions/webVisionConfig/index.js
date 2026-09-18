/**
 * 云函数 webVisionConfig —— 视觉识别模型配置·网页端读写代理
 *
 * 设计要点（与 webAdminQuery 同信任根）：
 *  - 复用 webAdminQuery 的 token + per-user 绑定 鉴权体系（管理员令牌 / 网页口令令牌）
 *  - API Key 仅存云端（vision_config 集合），云函数直读直调，小程序全程不碰 Key
 *  - 管理员令牌（WEB_DASHBOARD_TOKEN）可写「全局兜底」(__global__) 或指定 targetOpenid
 *  - per-user 绑定令牌只能读写自己 openid 的配置（隔离）
 *
 * 入参：{ token, action: 'get' | 'set', config?, targetOpenid? }
 * 出参：
 *  get  → { ok:true, enabled, active, platforms }
 *  set  → { ok:true, enabled, active } | { ok:false, code, msg }
 */

const tcb = require('@cloudbase/node-sdk');

const ENV = process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf';
const COLLS = { bindings: 'web_portal_bindings', vision: 'vision_config' };
const PLATFORMS = ['siliconflow', 'deepseek', 'custom'];
const GLOBAL = '__global__';

function getApp() {
  return tcb.init({ env: ENV, timeout: 30000 });
}

/**
 * 鉴权：管理员令牌优先，否则按网页绑定令牌反查 openid
 * 返回 { ok, admin, openid, code?, msg? }
 */
async function resolveBinding(app, token) {
  if (!token) return { ok: false, code: 'auth', msg: '缺少令牌' };
  // 管理员令牌（环境变量，用户自保管，不入代码明文比对逻辑之外）
  if (process.env.WEB_DASHBOARD_TOKEN && token === process.env.WEB_DASHBOARD_TOKEN) {
    return { ok: true, admin: true, openid: '' };
  }
  // per-user 绑定令牌：在 web_portal_bindings 反查未撤销的令牌
  try {
    const res = await app.database().collection(COLLS.bindings).where({ token, revoked: false }).limit(1).get();
    if (res && res.data && res.data.length) {
      return { ok: true, admin: false, openid: res.data[0].openid };
    }
  } catch (e) {
    return { ok: false, code: 'auth', msg: '令牌校验异常' };
  }
  return { ok: false, code: 'auth', msg: '令牌无效或已撤销' };
}

/**
 * 校验并清洗视觉配置：
 *  - platforms 三平台独立存放 base/key/model
 *  - enabled 为 true 时，active 指向的平台必须三要素齐全
 */
function cleanConfig(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, msg: '配置为空' };
  const enabled = raw.enabled === true;
  const active = PLATFORMS.indexOf(raw.active) >= 0 ? raw.active : '';
  const platforms = {};
  for (const p of PLATFORMS) {
    const src = raw.platforms && raw.platforms[p];
    platforms[p] = {
      base: src && typeof src.base === 'string' ? src.base.trim() : '',
      key: src && typeof src.key === 'string' ? src.key.trim() : '',
      model: src && typeof src.model === 'string' ? src.model.trim() : ''
    };
  }
  let activeOk = false;
  if (active && platforms[active].base && platforms[active].key && platforms[active].model) {
    activeOk = true;
  }
  const err = enabled && !activeOk ? '启用平台的三要素（接口地址/API Key/模型名）必须齐全' : '';
  return { ok: true, enabled, active, platforms, activeOk, msg: err };
}

exports.main = async (event) => {
  const app = getApp();
  const token = event.token;

  const auth = await resolveBinding(app, token);
  if (!auth.ok) return { ok: false, code: auth.code, msg: auth.msg };

  // 目标 openid：管理员 → targetOpenid || 全局兜底；per-user → 绑定 openid（隔离）
  let targetOpenid;
  if (auth.admin) targetOpenid = (event.targetOpenid && String(event.targetOpenid)) || GLOBAL;
  else targetOpenid = auth.openid;

  const coll = app.database().collection(COLLS.vision);
  const action = event.action;

  /* ---- TEST（视觉连通性，服务端代调 ocrSchedule，避开网页直连 ocrSchedule 的上下文/权限问题）---- */
  if (action === 'test') {
    const vc = (event.visionConfig && typeof event.visionConfig === 'object') ? event.visionConfig : {};
    const base = (vc.base || '').trim(), key = (vc.key || '').trim(), model = (vc.model || '').trim();
    if (!base || !key || !model) return { ok: false, msg: '配置不完整：需要接口地址 Base、API Key、模型名三项。' };
    try {
      const r = await app.callFunction({ name: 'ocrSchedule', data: { testVision: true, visionConfig: { base, key, model } } });
      const rr = (r && r.result) || {};
      return { ok: !!rr.ok, msg: rr.msg || (rr.ok ? '视觉链路连通成功' : '连接失败'), latencyMs: rr.latencyMs };
    } catch (e) {
      return { ok: false, msg: '测试执行异常：' + ((e && (e.errMsg || e.message)) || e) };
    }
  }

  /* ---- GET ---- */
  if (action === 'get') {
    try {
      const res = await coll.doc(targetOpenid).get();
      // 注意：tcb node-sdk 的 doc(id).get() 返回 { data: <单对象> }（非数组），
      // 而 where().get() 返回 { data: [数组] }。两种形态都兼容，避免 res.data.length 误判导致永远取不到配置。
      // 返回结构须与前端 web/index.html 的 queryVision → r.data 约定一致（同 webAdminQuery 的 { ok, data } 形态）。
      const d = res && res.data ? (Array.isArray(res.data) ? res.data[0] : res.data) : null;
      if (d) {
        return { ok: true, data: { enabled: !!d.enabled, active: d.active || '', platforms: d.platforms || {} } };
      }
    } catch (e) { /* 无文档 → 返回空默认 */ }
    return { ok: true, data: { enabled: false, active: '', platforms: {} } };
  }

  /* ---- SET ---- */
  if (action === 'set') {
    const cleaned = cleanConfig(event.config);
    if (!cleaned.ok) return { ok: false, code: 'bad_config', msg: cleaned.msg };
    if (cleaned.enabled && !cleaned.activeOk) {
      return { ok: false, code: 'bad_config', msg: cleaned.msg };
    }
    try {
      await coll.doc(targetOpenid).set({
        enabled: cleaned.enabled,
        active: cleaned.active,
        platforms: cleaned.platforms,
        updatedAt: new Date()
      });
      return { ok: true, enabled: cleaned.enabled, active: cleaned.active };
    } catch (e) {
      return { ok: false, code: 'write_err', msg: '写入失败：' + ((e && e.message) || e) };
    }
  }

  return { ok: false, code: 'bad_action', msg: '未知操作' };
};

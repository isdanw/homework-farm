/**
 * actionRegistry.js —— Action Registry v3 唯一契约的读取与参数校验（零依赖）
 * ============================================================================
 * 模型只允许输出 `action.name`；参数必须经这里校验后才能落地。
 * 契约数据在同目录 actionRegistry.json（小程序/Swift 侧由它生成常量）。
 *
 * 只做「形状」校验：类型 / 枚举 / 长度 / 整数 / childId 字面格式。
 * 不做「归属」校验：childId 是否属于该家庭由 agentKit / scopeGuard 的服务端作用域
 * 负责，这里猜不了也不该猜。
 *
 * AR_PATH 环境变量可指向另一份 JSON（测试反证用；默认同目录 actionRegistry.json）。
 */
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.resolve(__dirname, process.env.AR_PATH || 'actionRegistry.json');
const REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const ACTIONS = REGISTRY.actions || {};
const ACTION_LIST = Object.keys(ACTIONS).map(k => ACTIONS[k]);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;   // https: / wx: / javascript:
const INT_STRING = /^-?\d+$/;

function getAction(name) {
  return ACTIONS[name] || null;
}

function bad(code, msg) {
  return { ok: false, code: code, msg: msg };
}

function checkValue(key, raw, spec) {
  if (spec.type === 'enum') {
    if (typeof raw !== 'string' || (spec.values || []).indexOf(raw) < 0) {
      return bad('bad_enum', key + ' 取值不在允许范围');
    }
    return { ok: true, value: raw };
  }

  if (spec.type === 'string') {
    if (typeof raw !== 'string') return bad('bad_value', key + ' 必须是字符串');
    const val = raw.trim();
    if (CONTROL_CHARS.test(val)) return bad('bad_value', key + ' 含控制字符');
    if (val.charAt(0) === '/') return bad('bad_value', key + ' 不能是页面路径');
    if (URL_LIKE.test(val)) return bad('bad_value', key + ' 不能是链接');
    if (spec.maxLength && Array.from(val).length > spec.maxLength) {
      return bad('bad_value', key + ' 超过长度上限 ' + spec.maxLength);
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(val)) {
      return bad('bad_value', key + ' 格式不合法');
    }
    return { ok: true, value: val };
  }

  if (spec.type === 'integer') {
    let n = raw;
    if (typeof n === 'string' && INT_STRING.test(n.trim())) n = Number(n.trim());
    if (typeof n !== 'number' || !Number.isInteger(n)) {
      return bad('bad_value', key + ' 必须是整数');
    }
    if (typeof spec.min === 'number' && n < spec.min) {
      return bad('bad_value', key + ' 不能小于 ' + spec.min);
    }
    return { ok: true, value: n };
  }

  return bad('bad_value', key + ' 的契约类型未知');
}

/**
 * 校验并归一化参数。
 *   { ok:true, action, params }    params 只含契约声明过的键，字符串已 trim、整数已转 number
 *   { ok:false, code, msg }        code: unknown_action | bad_params | unknown_param |
 *                                        missing_required | bad_enum | bad_value
 * params 传 null/undefined 视为 {}（全可选动作因此合法；有必填则报 missing_required）。
 */
function validateParams(name, params) {
  const action = getAction(name);
  if (!action) return bad('unknown_action', '未知动作：' + name);
  if (params == null) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    return bad('bad_params', '参数必须是对象');
  }

  const props = (action.paramsSchema && action.paramsSchema.properties) || {};
  const keys = Object.keys(params);
  for (let i = 0; i < keys.length; i++) {
    if (!props[keys[i]]) {
      return bad('unknown_param', '动作 ' + name + ' 不接受参数 ' + keys[i]);
    }
  }

  const out = {};
  const declared = Object.keys(props);
  for (let i = 0; i < declared.length; i++) {
    const key = declared[i];
    const spec = props[key];
    const raw = params[key];
    const absent = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (absent) {
      if (spec.required) return bad('missing_required', '缺少必填参数 ' + key);
      continue;
    }
    const r = checkValue(key, raw, spec);
    if (!r.ok) return r;
    out[key] = r.value;
  }

  return { ok: true, action: action, params: out };
}

module.exports = {
  version: REGISTRY.version,
  registryPath: REGISTRY_PATH,
  actions: ACTIONS,
  ACTION_LIST: ACTION_LIST,
  getAction: getAction,
  validateParams: validateParams
};

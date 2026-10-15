/**
 * pace.js —— 精力条 / 节奏护盾（P1）
 *
 * 设计文档：教育侧留存与节奏增强_功能设计.md §二
 *
 * 【核心原则】参数由学习者档案**自动推导**，不绑定任何固定年龄/年级：
 *   · 单节建议上限 ← learner.stage（学段）
 *   · 每日精力池   ← learner.weeklyMinutes（每周可学习时间）
 *   档案缺失时才按「学段默认值」兜底；常量只存在于下方映射表，不进业务流。
 *
 * 【纯函数】本模块**不 require store.js**，避免与数据层循环依赖：
 *   · 只读操作 snapshot(u)      → 返回视图模型，不改数据
 *   · 写操作   spend(u, min)    → 就地改 u.pace，**由调用方负责 store.save(u)**
 *   （与 farmEngine.checkin 同口径：数据层在数据层内落盘）
 *
 * 【数据契约】R4 字段只增不改不删 —— defaultPace() 是唯一形状来源，
 *   store.defaultData() / store.ensureUserFields() 必须同步引用本形状。
 *
 * 【合规】非惩罚设计：精力条只做「轻提示」，绝不锁死、绝不羞辱；
 *   所有文案避开 orderKit.BANNED_WORDS（已掌握/已精通/学会了…）。
 */

const util = require('./util.js');

/* ==========================================================================
 * 一、学段 → 参数映射表（唯一允许出现「常量」的地方）
 * ========================================================================== */

/** 各学段的单次专注窗口建议上限（分钟） */
const STAGE_CAP = { 幼儿园: 15, 小学: 25, 初中: 38, 高中: 45, 其他: 25 };

/** 各学段的每周默认可学习时长（分钟）—— 仅在 learner.weeklyMinutes 未填时兜底 */
const STAGE_DEF_WEEKLY = { 幼儿园: 120, 小学: 300, 初中: 600, 高中: 900, 其他: 300 };

/** 每日精力池下限（分钟）—— 避免 weeklyMinutes 极小导致条太短失去意义 */
const DAILY_POOL_MIN = 10;

/** 打卡未填时长时的兜底扣减（分钟）—— 一次打卡至少记 5 分钟，口径与导学统一 */
const CHECKIN_DEFAULT_MIN = 5;

/** 翻面自测等轻量行为的固定扣减（分钟） */
const MICRO_MIN = 1;

const STAGES = ['幼儿园', '小学', '初中', '高中', '其他'];

/* ==========================================================================
 * 二、参数自动推导
 * ========================================================================== */

/**
 * 从年级文本推断学段（仅当 learner.stage 缺失时兜底）。
 * 小班/中班/大班→幼儿园；一~六年级→小学；初一~初三→初中；高一~高三→高中。
 * @param {String} grade 如「一年级」「初一上学期」
 * @returns {String} 学段；识别不到返回空串
 */
function stageFromGrade(grade) {
  if (!grade) return '';
  const s = String(grade);
  if (/小班|中班|大班|幼儿园/.test(s)) return '幼儿园';
  if (/一年级|二年级|三年级|四年级|五年级|六年级|小学/.test(s)) return '小学';
  if (/初一|初二|初三|初中/.test(s)) return '初中';
  if (/高一|高二|高三|高中/.test(s)) return '高中';
  return '';
}

/**
 * ★ 核心：由学习者档案推导节奏参数（**不绑年龄**）。
 *
 * @param {Object} learner 儿童画像 { stage, weeklyMinutes }（store.getLearner()）
 * @param {String} grade    年级（如「一年级」），stage 缺失时用于兜底推断
 * @returns {{stage:String, singleSessionCapMin:Number, dailyEnergyPool:Number,
 *            deductPerMin:Number, weeklyMinutes:Number, derived:Boolean}}
 *   derived = true 表示档案字段缺失、走了兜底（供 UI 决定是否提示家长补档案）
 */
function derivePaceConfig(learner, grade) {
  const ln = (learner && typeof learner === 'object') ? learner : {};

  // ① 学段：档案优先 → 年级推断 → 其他
  let stage = String(ln.stage || '').trim();
  let derived = false;
  if (STAGES.indexOf(stage) < 0) {
    stage = stageFromGrade(grade);
    if (stage) {
      derived = true;                       // 由年级推断而来，非家长显式填写
    } else {
      stage = '其他';
      derived = true;
    }
  }

  // ② 每周时长：档案为正数才采信，否则按学段兜底
  const wm = Number(ln.weeklyMinutes);
  const hasWeekly = isFinite(wm) && wm > 0;
  const weeklyMinutes = hasWeekly ? Math.round(wm) : (STAGE_DEF_WEEKLY[stage] || 300);
  if (!hasWeekly) derived = true;

  // ③ 每日精力池 = 周时长摊到每天（1 分钟 = 1 点，同口径扣减）
  const dailyEnergyPool = Math.max(DAILY_POOL_MIN, Math.ceil(weeklyMinutes / 7));

  return {
    stage: stage,
    singleSessionCapMin: STAGE_CAP[stage] || 25,
    dailyEnergyPool: dailyEnergyPool,
    deductPerMin: 1,
    weeklyMinutes: weeklyMinutes,
    derived: derived
  };
}

/* ==========================================================================
 * 三、pace 数据形状（R4：唯一来源）
 * ========================================================================== */

/**
 * pace 初始形状。注意 energy 初值 -1 = 「未初始化」，
 * 首次 normalize 时会按当日 dailyEnergyPool 回满（池大小随档案变，不写死 100）。
 */
function defaultPace() {
  return {
    energy: -1,                 // 当前精力（-1 未初始化；normalize 时回满）
    lastResetDate: '',          // 上次回满的日期（YYYY-MM-DD）
    todayUsedMin: 0,            // 当日累计学习分钟
    weekUsedMin: 0,             // 当周累计学习分钟
    weekStart: '',              // 当周起始日（周一），用于周计数重置
    lastSessionAt: 0,           // 上次学习行为时间戳
    warnedDate: '',             // 当日已弹过「该让大脑歇歇啦」的日期（每节只弹一次）
    sessionStartAt: 0           // 当前学习行为开始时间戳（用于按时长扣减）
  };
}

/** 本周周一（YYYY-MM-DD）；周计数以此为界重置 */
function weekStart(dateStr) {
  const d = new Date(String(dateStr || util.today()) + 'T00:00:00');
  if (isNaN(d.getTime())) return util.today();
  const wd = (d.getDay() + 6) % 7;        // 周一=0 … 周日=6
  d.setDate(d.getDate() - wd);
  return util.dateKey(d);
}

/* ==========================================================================
 * 四、规范化（日切 / 周切 / 钳制）—— 幂等，可重复调用
 * ========================================================================== */

/**
 * 补齐并规范化 u.pace。就地修改 u，就地返回 u.pace。
 * · 跨天 → energy 回满、todayUsedMin 归零
 * · 跨周 → weekUsedMin 归零
 * · energy 始终钳制在 [0, dailyEnergyPool]
 *
 * @param {Object} u   孩子切片（store.get() 的返回值）
 * @param {Object} cfg derivePaceConfig 的结果（可复用，避免重复推导）
 * @returns {Object} u.pace
 */
function normalizePace(u, cfg) {
  if (!u || typeof u !== 'object') return defaultPace();
  const def = defaultPace();
  if (!u.pace || typeof u.pace !== 'object') u.pace = def;
  Object.keys(def).forEach(k => { if (u.pace[k] === undefined) u.pace[k] = def[k]; });

  const conf = cfg || derivePaceConfig(u.learner, u.grade);
  const today = util.today();
  const p = u.pace;

  // 日切：首次初始化 / 跨天 → 回满
  if (p.lastResetDate !== today) {
    p.lastResetDate = today;
    p.todayUsedMin = 0;
    p.energy = conf.dailyEnergyPool;
    // 跨天后允许再次弹提示
    if (p.warnedDate !== today) p.warnedDate = '';
  } else if (p.energy < 0) {
    p.energy = conf.dailyEnergyPool;        // 同日首次写入但 energy 未初始化
  }

  // 周切：跨周 → 周累计归零
  const ws = weekStart(today);
  if (p.weekStart !== ws) {
    p.weekStart = ws;
    p.weekUsedMin = 0;
  }

  // 钳制到 [0, 池]（池随档案变化：调大 weeklyMinutes 后旧值不应越界）
  p.energy = Math.max(0, Math.min(conf.dailyEnergyPool, Number(p.energy) || 0));
  p.todayUsedMin = Math.max(0, Number(p.todayUsedMin) || 0);
  p.weekUsedMin = Math.max(0, Number(p.weekUsedMin) || 0);

  return p;
}

/* ==========================================================================
 * 五、扣减
 * ========================================================================== */

/**
 * 消耗精力（就地改 u.pace，**调用方负责 store.save(u)**）。
 * 非惩罚：energy 最低降到 0，但**不阻断任何学习行为**（不做锁死）。
 *
 * @param {Object} u       孩子切片
 * @param {Number} minutes 本次消耗分钟（<=0 视为无效，不改动）
 * @param {Object} cfg     derivePaceConfig 结果（可选）
 * @returns {{spent:Number, energy:Number, pool:Number, drained:Boolean}}
 *   drained = 能量已见底（用于 UI 变色，不用于拦截）
 */
function spend(u, minutes, cfg) {
  const min = Math.max(0, Math.round(Number(minutes) || 0));
  const p = normalizePace(u, cfg);
  const conf = cfg || derivePaceConfig(u.learner, u.grade);
  if (!min) {
    return { spent: 0, energy: p.energy, pool: conf.dailyEnergyPool, drained: p.energy <= 0 };
  }

  const before = p.energy;
  p.energy = Math.max(0, p.energy - min * conf.deductPerMin);
  p.todayUsedMin += min;
  p.weekUsedMin += min;
  p.lastSessionAt = Date.now();
  p.sessionStartAt = 0;

  return {
    spent: min,
    energy: p.energy,
    pool: conf.dailyEnergyPool,
    drained: p.energy <= 0,
    drainedDelta: before - p.energy
  };
}

/**
 * 记录一次学习行为的开始时刻（供结束时按时长扣减）。
 * 幂等：已有未结算的 sessionStartAt 时不覆盖（避免反复进入页面把起点推后）。
 */
function markSessionStart(u, cfg) {
  const p = normalizePace(u, cfg);
  if (!p.sessionStartAt) {
    p.sessionStartAt = Date.now();
    p.lastSessionAt = p.sessionStartAt;
  }
  return p.sessionStartAt;
}

/**
 * 结算当前学习行为：返回应扣减的分钟数并清空起点。
 * 未记录起点（没调 markSessionStart）时返回 0。
 * @returns {Number} 分钟数（≥1 的整数；未超 cap 时可小于 cap）
 */
function settleSession(u, cfg) {
  const p = normalizePace(u, cfg);
  const conf = cfg || derivePaceConfig(u.learner, u.grade);
  const startedAt = p.sessionStartAt;
  p.sessionStartAt = 0;
  if (!startedAt) return 0;
  const min = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  // 单节封顶计入上限 +50%，防止忘记结算时把一天一次性掏空
  return Math.min(min, Math.ceil(conf.singleSessionCapMin * 1.5));
}

/* ==========================================================================
 * 六、视图模型（UI 只读这个，不直接读 p.energy）
 * ========================================================================== */

/** 状态阈值：≤20% 偏橙，≤5% 偏红 */
const LOW_PCT = 20, CRIT_PCT = 5;

/**
 * 精力条视图模型。
 * @returns {{energy:Number,pool:Number,pct:Number,level:String,emoji:String,
 *            tip:String,capMin:Number,weeklyUsed:Number,weeklyTotal:Number,derived:Boolean}}
 *   level: 'high' 满 | 'mid' 中 | 'low' 低 | 'crit' 见底
 */
function snapshot(u, cfg) {
  if (!u || typeof u !== 'object') {
    const c0 = derivePaceConfig(null, '');
    return {
      energy: c0.dailyEnergyPool, pool: c0.dailyEnergyPool, pct: 100,
      level: 'high', emoji: '🌿', tip: '', capMin: c0.singleSessionCapMin,
      weeklyUsed: 0, weeklyTotal: c0.weeklyMinutes, derived: true
    };
  }
  const p = normalizePace(u, cfg);
  const conf = cfg || derivePaceConfig(u.learner, u.grade);
  const pool = conf.dailyEnergyPool;
  const pct = pool > 0 ? Math.round(p.energy / pool * 100) : 0;

  let level = 'high', emoji = '🌿', tip = '';
  if (pct <= CRIT_PCT) { level = 'crit'; emoji = '🔋'; tip = '该让大脑歇歇啦'; }
  else if (pct <= LOW_PCT) { level = 'low'; emoji = '🍃'; tip = '该让大脑歇歇啦'; }

  return {
    energy: p.energy,
    pool: pool,
    pct: Math.max(0, Math.min(100, pct)),
    level: level,
    emoji: emoji,
    tip: tip,
    capMin: conf.singleSessionCapMin,
    weeklyUsed: p.weekUsedMin,
    weeklyTotal: conf.weeklyMinutes,
    derived: conf.derived
  };
}

/**
 * 单节是否超过建议上限 —— **仅用于轻提示，绝不阻断**。
 * @returns {{over:Boolean, capMin:Number, minutes:Number}}
 */
function checkSessionCap(minutes, cfg) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const cap = (cfg && cfg.singleSessionCapMin) || 25;
  return { over: m > cap, capMin: cap, minutes: m };
}

/**
 * 取出「本次学习行为」的建议上限（供页面在开始前展示 / 结束后核对）。
 * 与 spend/settle 同源，避免各处各写一份 cap。
 */
function sessionCapOf(u, cfg) {
  const conf = cfg || derivePaceConfig(u && u.learner, u && u.grade);
  return conf.singleSessionCapMin;
}

module.exports = {
  // 常量（供测试与 UI 复用）
  STAGE_CAP, STAGE_DEF_WEEKLY, STAGES, DAILY_POOL_MIN, CHECKIN_DEFAULT_MIN, MICRO_MIN,
  LOW_PCT, CRIT_PCT,
  // 推导
  stageFromGrade, derivePaceConfig,
  // 数据
  defaultPace, weekStart, normalizePace,
  // 行为
  spend, markSessionStart, settleSession,
  // 视图
  snapshot, checkSessionCap, sessionCapOf
};
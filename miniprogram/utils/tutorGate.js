/**
 * ============================================================================
 *  tutorGate.js —— 导学功能启用门禁（2026-09-22 新增）
 *  ---------------------------------------------------------------------------
 *  规则（需求）：同时满足以下三条才允许使用「导学功能」
 *    ① 已添加孩子：存在真实孩子切片（store.isOnboarded，占位切片 __placeholder 不算）
 *    ② 已建立成长计划：当前孩子存在至少一份成长计划（u.studyPlans 非空）
 *    ③ 已绑定微信：本地模式（未绑定 / 已退出登录）下导学不可用
 *        —— 导学数据（错题 / 报告 / 会话）是云端 + 微信账户绑定的，
 *           退出后虽保留本机数据，但导学系统必须停用，避免「有数据却仍可用」的越权。
 *
 *  为什么集中在此：导学功能有 3 个入口（我的页→导学中心、导学中心页本身、
 *  以及 AI 导学页被计划/打卡/错题/报告等多处深链直达），散落判断易漏。
 *  统一在这里收口，所有入口 require 本文件即可，避免逻辑漂移。
 *
 *  reason（供 UI 文案/按钮分流，优先级：no-bind > no-child > no-plan）：
 *    ''          → 已启用
 *    'no-bind'   → 未绑定微信（本地模式 / 已退出登录）
 *    'no-child'  → 未添加孩子
 *    'no-plan'   → 已添加孩子但未建计划
 * ============================================================================
 */
const store = require('./store.js');

/** 是否已添加（真实）孩子：占位体验切片不算 */
function hasChild() {
  return store.isOnboarded();
}

/** 当前孩子是否已建立至少一份成长计划 */
function hasStudyPlan() {
  const u = store.get();
  if (!u) return false;
  const plans = u.studyPlans;
  if (!plans || typeof plans !== 'object') return false;
  return Object.keys(plans).length > 0;
}

/** 是否已绑定微信（本地模式 / 已退出登录 → false） */
function hasWxBind() {
  try { return !!store.getBindInfo().bound; } catch (e) { return false; }
}

/**
 * 门禁判定
 * @returns {{ok:boolean, hasChild:boolean, hasStudyPlan:boolean, bound:boolean, reason:string}}
 */
function getGate() {
  const child = hasChild();
  const plan = hasStudyPlan();
  const bound = hasWxBind();
  // 优先级：未绑定最高（本地模式/退出登录后首要引导是去绑定）；其余依次判定
  let reason = '';
  if (!bound) reason = 'no-bind';
  else if (!child) reason = 'no-child';
  else if (!plan) reason = 'no-plan';
  return {
    ok: child && plan && bound,
    hasChild: child,
    hasStudyPlan: plan,
    bound: bound,
    reason: reason
  };
}

/** 导学功能是否可用 */
function isTutorEnabled() {
  return getGate().ok;
}

module.exports = {
  getGate,
  isTutorEnabled,
  hasChild,
  hasStudyPlan,
  hasWxBind
};

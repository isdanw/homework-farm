/**
 * ============================================================================
 *  tutorGate.js —— 导学功能启用门禁（2026-09-22 新增）
 *  ---------------------------------------------------------------------------
 *  规则（需求）：同时满足以下两条才允许使用「导学功能」
 *    ① 已添加孩子：存在真实孩子切片（store.isOnboarded，占位切片 __placeholder 不算）
 *    ② 已建立学习计划：当前孩子存在至少一份成长计划（u.studyPlans 非空）
 *
 *  为什么集中在此：导学功能有 3 个入口（我的页→导学中心、导学中心页本身、
 *  以及 AI 导学页被计划/打卡/错题/报告等多处深链直达），散落判断易漏。
 *  统一在这里收口，所有入口 require 本文件即可，避免逻辑漂移。
 *
 *  reason（供 UI 文案/按钮分流）：
 *    ''          → 已启用
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

/**
 * 门禁判定
 * @returns {{ok:boolean, hasChild:boolean, hasStudyPlan:boolean, reason:string}}
 */
function getGate() {
  const child = hasChild();
  const plan = hasStudyPlan();
  let reason = '';
  if (!child) reason = 'no-child';
  else if (!plan) reason = 'no-plan';
  return { ok: child && plan, hasChild: child, hasStudyPlan: plan, reason: reason };
}

/** 导学功能是否可用 */
function isTutorEnabled() {
  return getGate().ok;
}

module.exports = {
  getGate,
  isTutorEnabled,
  hasChild,
  hasStudyPlan
};

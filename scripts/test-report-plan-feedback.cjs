/**
 * test-report-plan-feedback.cjs —— 报告 → 计划反哺 回归测试
 * ---------------------------------------------------------------------------
 * 纯 Node 运行（stub 掉 wx / getApp），覆盖：
 *   ① planFeedback.buildFeedback —— 错因分布按学科聚合成补漏建议（纯逻辑）
 *   ② studyPlan.appendRemediationStage —— 把补漏任务写回对应学科成长计划
 *     node scripts/test-report-plan-feedback.cjs
 *   反证（证明用例真能抓到缺陷）：把旧版源码指给 SRC_DIR 跑，应有断言 ✗
 */
const path = require('path');
const assert = require('assert');

const SRC_DIR = process.env.SRC_DIR
  ? path.resolve(process.env.SRC_DIR)
  : path.resolve(__dirname, '../miniprogram/utils');

/* ------------------------------ 测试挂具 ------------------------------ */
function makeWx() {
  const storage = new Map();
  return {
    getStorageSync(k) { return storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : ''; },
    setStorageSync(k, v) { storage.set(k, JSON.parse(JSON.stringify(v))); },
    removeStorageSync(k) { storage.delete(k); },
    cloud: { callFunction() { return Promise.resolve({ result: { ok: true } }); } }
  };
}
global.wx = makeWx();

const store = require(path.join(SRC_DIR, 'store.js'));
const studyPlan = require(path.join(SRC_DIR, 'studyPlan.js'));
const planFeedback = require(path.join(SRC_DIR, 'planFeedback.js'));

let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }

/* ===== 1. buildFeedback 纯逻辑 ===== */
(function testBuildFeedback() {
  const mistakes = [
    { subject: 'math', errorType: 'E7' },
    { subject: 'math', errorType: 'E7' },
    { subject: 'math', errorType: 'E1' },
    { subject: 'chinese', errorType: 'E2' },
    { subject: 'chinese', errorType: 'E8' },
    { subject: 'chinese', errorType: 'E8' },
    { subject: 'chinese', errorType: '' },   // 无错因，跳过
    { subject: 'math' },                     // 无 errorType，跳过
    { subject: '', errorType: 'E3' }         // 无学科，跳过
  ];
  const fb = planFeedback.buildFeedback(mistakes);
  assert.strictEqual(fb.length, 2, '应聚合出 2 个学科');
  const math = fb.find(x => x.subject === 'math');
  const chinese = fb.find(x => x.subject === 'chinese');
  assert.strictEqual(math.items.length, 2, 'math 默认 topN=2：E7 与 E1 两个错因都取');
  assert.strictEqual(math.items[0].errorType, 'E7', 'math 主要错因应为 E7（2 次）');
  assert.strictEqual(math.items[0].count, 2);
  assert.strictEqual(math.items[0].task, planFeedback.REMEDIATION.E7, 'task 应为 E7 模板');
  assert.strictEqual(chinese.items[0].errorType, 'E8', 'chinese 主要错因应为 E8（2 次）');
  assert.strictEqual(chinese.items[1].errorType, 'E2', 'chinese 第二错因为 E2');
  ok('buildFeedback 按学科聚合 + topN 排序 + 跳过无效错因');

  // 显式 topN=1 截断：每个学科仅取主要错因
  const fb1 = planFeedback.buildFeedback(mistakes, { topN: 1 });
  assert.strictEqual(fb1.find(x => x.subject === 'math').items.length, 1, 'topN=1 时 math 仅 1 项');
  assert.strictEqual(fb1.find(x => x.subject === 'chinese').items.length, 1, 'topN=1 时 chinese 仅 1 项');
  ok('buildFeedback topN 截断（每学科限主要错因数）');

  // 空输入安全
  assert.deepStrictEqual(planFeedback.buildFeedback([]), [], '空输入返回 []');
  assert.deepStrictEqual(planFeedback.buildFeedback(null), [], 'null 输入返回 []');
  ok('buildFeedback 空输入安全');

  // maxTasks 截断
  const many = [];
  for (let i = 0; i < 5; i++) many.push({ subject: 's' + i, errorType: 'E' + (i + 1) });
  const capped = planFeedback.buildFeedback(many, { topN: 1, maxTasks: 3 });
  const total = capped.reduce((s, x) => s + x.items.length, 0);
  assert.ok(total <= 3, '总任务数不超过 maxTasks');
  ok('buildFeedback maxTasks 截断');
})();

/* ===== 2. appendRemediationStage 写回成长计划 ===== */
(function testAppend() {
  store.addUser({ id: 'u_test', nickname: '测试孩子' });
  store.saveSubjectProfile('math', { grade: '一年级', textbook: '人教版' });

  // 无计划：新建
  const r1 = studyPlan.appendRemediationStage('math', [
    '限时完成 5 道计算，做完必验算一遍',
    '每天做 2 道应用题：先圈关键词'
  ]);
  assert.ok(r1 && r1.created === true, '首次应新建计划');
  let plan = studyPlan.getPlan('math');
  assert.ok(plan, '应能取到 math 计划');
  assert.strictEqual(plan.stages.length, 1, '应有 1 个阶段');
  assert.strictEqual(plan.stages[0].tasks.length, 2, '阶段应有 2 个任务');
  assert.strictEqual(plan.stages[0].tasks[0].done, false, '任务初始未勾选');
  assert.strictEqual(plan.grade, '一年级', '年级应取自画像');
  assert.strictEqual(plan.subjectName, '数学', 'subjectName 应取自类型');
  ok('appendRemediationStage 无计划时新建（字段/任务形状正确）');

  // 已有计划：追加阶段（不破坏既有）
  const r2 = studyPlan.appendRemediationStage('math', ['重读相关定义与例题，做 3 道概念辨析题']);
  assert.ok(r2 && r2.created === false, '再次应为追加而非新建');
  plan = studyPlan.getPlan('math');
  assert.strictEqual(plan.stages.length, 2, '应输出第 2 个阶段');
  assert.strictEqual(plan.stages[0].tasks.length, 2, '既有阶段不被改动');
  assert.strictEqual(plan.stages[1].tasks.length, 1, '新追加阶段含 1 个任务');
  ok('appendRemediationStage 已有计划时追加阶段（不破坏既有）');

  // 任务名超长截断 + 空值过滤
  const longTask = 'x'.repeat(80);
  studyPlan.appendRemediationStage('math', [longTask, '   ', '', null, '有效任务']);
  plan = studyPlan.getPlan('math');
  const last = plan.stages[plan.stages.length - 1];
  assert.strictEqual(last.tasks.length, 2, '空/空白/超长任务被过滤，仅保留 2 个有效');
  assert.ok(last.tasks[0].name.length <= 40, '超长任务名被截断到 40');
  ok('appendRemediationStage 任务名清洗（截断/过滤）');

  // 无效输入返回 null
  assert.strictEqual(studyPlan.appendRemediationStage('math', []), null, '空任务数组返回 null');
  assert.strictEqual(studyPlan.appendRemediationStage('', ['t']), null, '空学科返回 null');
  ok('appendRemediationStage 无效输入返回 null');
})();

console.log('\n' + pass + ' 项断言通过 ✅');

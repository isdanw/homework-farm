/**
 * test-plan-task-elapsed.js —— 成长计划「任务实际完成天数」回归测试
 *
 * 覆盖 2026-10-06 新增契约（studyPlan.js）：
 *   · startedAt：任务首次被打卡带出日（markTaskStarted，幂等不覆盖）
 *   · checkinDays（任务 done 时）= 真实耗时 = diffDays(doneAt, startedAt||plan.startDate) + 1（含首尾）
 *   · setTaskDone(false) 清 checkinDays 但保留 startedAt
 *   · 无 startDate 直接勾选完成 → checkinDays=0（回退空）
 *   · 下标越界 / 未知 key 保护
 *
 * 运行：node scripts/test-plan-task-elapsed.js
 */
const path = require('path');

/* ---------- mock wx（与 test-plan-checkin-sync.js 同款） ---------- */
const storage = {};
global.wx = {
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  showToast: () => {}, showModal: () => {},
  showLoading: () => {}, hideLoading: () => {},
  navigateTo: () => {}, navigateBack: () => {}, switchTab: () => {},
  vibrateShort: () => {},
  cloud: { callFunction: () => Promise.resolve({ result: { ok: true } }) }
};
global.getApp = () => ({ runDailyRollover: () => {} });
global.Page = () => {};

/* 屏蔽游客模式噪声日志 */
const rawLog = console.log.bind(console);
console.log = (...a) => {
  if (typeof a[0] === 'string' && a[0].indexOf('[store]') === 0) return;
  rawLog(...a);
};

const store = require('../miniprogram/utils/store.js');
const studyPlan = require('../miniprogram/utils/studyPlan.js');
const util = require('../miniprogram/utils/util.js');

/* 固定「今天」让 doneAt 可断言（studyPlan 运行期读 util.today） */
const TODAY = '2026-10-06';
util.today = () => TODAY;

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

/* 构造一份计划（含本轮新增字段 checkinDays / startedAt） */
function makePlan() {
  return {
    grade: '一年级', term: '上学期', textbook: '人教版', subjectName: '数学',
    startDate: '2026-10-01', createdAt: 1000, updatedAt: 0,
    stages: [{
      name: '第一阶段', weeks: '2周', goal: '数感启蒙', tasks: [
        { name: '会数 1-10 并指读', days: 3, done: false, doneAt: '', checkinDays: 0, startedAt: '' }
      ]
    }]
  };
}

store.addUser({ nickname: '加一', avatar: '🐯', grade: '一年级' });

/* ============ 1. markTaskStarted 幂等 ============ */
console.log('=== 1. markTaskStarted：首次写 + 不覆盖 ===');
studyPlan.savePlan('math', makePlan());
ok('首次记录 startedAt', studyPlan.markTaskStarted('math', 0, 0, '2026-10-02') === true);
ok('startedAt 值正确', studyPlan.getPlan('math').stages[0].tasks[0].startedAt === '2026-10-02');
ok('二次调用返回 true', studyPlan.markTaskStarted('math', 0, 0, '2026-10-09') === true);
ok('★ 不覆盖首次值（幂等）', studyPlan.getPlan('math').stages[0].tasks[0].startedAt === '2026-10-02');

/* ============ 2. setTaskDone(true) 真实耗时 ============ */
console.log('=== 2. setTaskDone(true)：真实完成天数 diffDays+1 ===');
ok('标记完成', studyPlan.setTaskDone('math', 0, 0, true) === true);
const t2 = studyPlan.getPlan('math').stages[0].tasks[0];
ok('doneAt = 今天', t2.doneAt === TODAY);
ok('★ checkinDays = diffDays(今天, startedAt)+1', t2.checkinDays === util.diffDays(TODAY, '2026-10-02') + 1);
ok('  具体值 10-02→10-06 = 5 天', t2.checkinDays === 5);
ok('days 字段（内部排期）不受影响', t2.days === 3);

/* ============ 3. setTaskDone(false) 清耗时留开始日 ============ */
console.log('=== 3. setTaskDone(false)：清 checkinDays 保留 startedAt ===');
ok('取消完成', studyPlan.setTaskDone('math', 0, 0, false) === true);
const t3 = studyPlan.getPlan('math').stages[0].tasks[0];
ok('doneAt 清空', t3.doneAt === '');
ok('★ checkinDays 清零', t3.checkinDays === 0);
ok('★ startedAt 保留（记录曾开始）', t3.startedAt === '2026-10-02');

/* ============ 4. 无 startDate 直接勾选完成 → 0 ============ */
console.log('=== 4. 未开始计划 + 直接勾选完成 → checkinDays=0 ===');
studyPlan.savePlan('eng', {
  grade: '', term: '', textbook: '', subjectName: '英语',
  startDate: '', createdAt: 2000, updatedAt: 0,
  stages: [{ name: 'E1', weeks: '', goal: '', tasks: [
    { name: 'ET1', days: 2, done: false, doneAt: '', checkinDays: 0, startedAt: '' }
  ] }]
});
ok('直接完成（无开始日）', studyPlan.setTaskDone('eng', 0, 0, true) === true);
ok('★ 回退空 → checkinDays=0', studyPlan.getPlan('eng').stages[0].tasks[0].checkinDays === 0);

/* ============ 5. 越界 / 未知 key 保护 ============ */
console.log('=== 5. 边界保护 ===');
ok('越界 si → false', studyPlan.setTaskDone('math', 9, 0, true) === false);
ok('越界 ti → false', studyPlan.setTaskDone('math', 0, 9, true) === false);
ok('未知 key markTaskStarted → false', studyPlan.markTaskStarted('nope', 0, 0, TODAY) === false);
ok('未知 key setTaskDone → false', studyPlan.setTaskDone('nope', 0, 0, true) === false);

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);

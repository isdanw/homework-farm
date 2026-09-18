/**
 * test-tutor-plan-link.js —— 成长计划 ⇄ 导学 联动测试（mock wx/Page）
 * 覆盖：计划任务进入 → taskContext 解析 → 自动开场 → 归档 → 确认回写计划任务完成
 * 运行：node scripts/test-tutor-plan-link.js
 */
const path = require('path');

/* ---------- mock wx ---------- */
const storage = {};
const calls = [];
let lastModal = null;
global.wx = {
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  cloud: {
    callFunction: (o) => {
      calls.push(o);
      return Promise.resolve({
        result: o.data.action === 'chat'
          ? { ok: true, reply: '先数一数：3 个再加 5 个，一共有几个呀？' }
          : { ok: true, id: 'archive_1' }
      });
    }
  },
  showToast: () => {},
  showModal: (opts) => { lastModal = opts; opts.success && opts.success({ confirm: true, cancel: false }); },
  showLoading: () => {}, hideLoading: () => {},
  navigateBack: () => {}
};

/* ---------- mock Page ---------- */
let pageDef;
global.Page = (def) => { pageDef = def; };

/* 真实加载 store / studyPlan / 页面 */
const store = require('../miniprogram/utils/store.js');
const studyPlan = require('../miniprogram/utils/studyPlan.js');
require('..//miniprogram/pkgGuide/tutor/tutor.js');

/* seed 一份数学计划 */
studyPlan.savePlan('math', {
  grade: '一年级', term: '上学期', textbook: '', subjectName: '数学',
  startDate: '', createdAt: Date.now(), updatedAt: 0,
  stages: [{
    name: '第1单元', weeks: '第1-2周', goal: '掌握10以内加减法',
    tasks: [{ name: '会口算10以内加减法', days: 2, done: false, doneAt: '' }]
  }]
});

const page = Object.create(pageDef);
page.data = JSON.parse(JSON.stringify(pageDef.data));
page.setData = function (patch, cb) {
  Object.keys(patch).forEach(k => { this.data[k] = patch[k]; });
  if (cb) cb();
};

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('=== 从计划任务进入导学 ===');
  page.onLoad({
    key: 'math', si: '0', ti: '0',
    task: encodeURIComponent('会口算10以内加减法'),
    stage: encodeURIComponent('第1单元'),
    goal: encodeURIComponent('掌握10以内加减法')
  });
  ok('taskContext.key = math', page.data.taskContext.key === 'math');
  ok('taskContext.si/ti = 0', page.data.taskContext.si === 0 && page.data.taskContext.ti === 0);
  ok('task 名解码正确', page.data.taskContext.task === '会口算10以内加减法');
  ok('stage/goal 解码正确', page.data.taskContext.stage === '第1单元' && page.data.taskContext.goal === '掌握10以内加减法');
  ok('学科自动设为数学', page.data.subject === 'math');

  console.log('=== 自动开场导学 ===');
  await sleep(500);
  ok('自动发起了开场消息', page.data.messages.length >= 1 && page.data.messages[0].role === 'user');
  ok('开场内容包含任务名', page.data.messages[0].content.indexOf('会口算10以内加减法') >= 0);
  ok('开场内容包含"不要直接给答案"', page.data.messages[0].content.indexOf('不要直接给答案') >= 0);
  ok('AI 已回复', page.data.messages.some(m => m.role === 'assistant'));

  console.log('=== 结束导学 → 归档 → 回写计划 ===');
  const before = studyPlan.getPlan('math').stages[0].tasks[0].done;
  ok('回写前任务未完成', before === false);
  page.endSession();
  await sleep(50);
  ok('调用了 archive', calls.some(c => c.data.action === 'archive'));
  ok('归档后弹出确认', !!lastModal && lastModal.content.indexOf('会口算10以内加减法') >= 0);
  ok('确认后任务已标记完成', studyPlan.getPlan('math').stages[0].tasks[0].done === true);
  ok('taskContext 已清空', page.data.taskContext === null);

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();

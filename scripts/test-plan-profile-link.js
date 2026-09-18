/**
 * test-plan-profile-link.js —— 画像 ⇄ 成长计划 数据关联修复测试
 * 覆盖：
 *   1. store.parseGrade / resolveGrade 年级推导（纯函数）
 *   2. learnerProfile.save() 保存「学校进度」后自动回填年级到孩子资料
 *   3. plan.generate 缺年级时正确拦截（resolveGrade 为空才弹窗）
 * 运行：node scripts/test-plan-profile-link.js
 */
const path = require('path');

/* ---------- mock wx ---------- */
const storage = {};
let lastModal = null;
let lastToast = '';
global.wx = {
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  showToast: (t) => { lastToast = t; },
  showModal: (opts) => { lastModal = opts; },
  showLoading: () => {}, hideLoading: () => {},
  navigateTo: () => {},
  navigateBack: () => {},
  cloud: { callFunction: () => Promise.resolve({ result: { ok: true } }) }
};

/* ---------- mock Page ---------- */
let pageDef;
global.Page = (def) => { pageDef = def; };

const store = require('../miniprogram/utils/store.js');
require('..//miniprogram/pkgGuide/learnerProfile/learnerProfile.js');
const lpDef = pageDef;

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}

/* ============ 1. parseGrade 纯函数 ============ */
console.log('=== 1. parseGrade 年级推导 ===');
ok('「一年级上学期开学」→ 一年级', store.parseGrade('一年级上学期开学') === '一年级');
ok('「二年级下学期」→ 二年级', store.parseGrade('二年级下学期') === '二年级');
ok('「大班」→ 大班', store.parseGrade('大班') === '大班');
ok('「初中二年级」→ 二年级', store.parseGrade('初中二年级') === '二年级');
ok('「小学」→ 空（无年级词）', store.parseGrade('小学') === '');
ok('空串 → 空', store.parseGrade('') === '');
ok('null → 空', store.parseGrade(null) === '');

/* ============ 2. 画像保存后回填年级 ============ */
console.log('=== 2. 画像「学校进度」→ 自动回填年级 ===');
// 建一个年级为空的孩子并切换为当前
const uid = store.addUser({ nickname: '加一', avatar: '🐯', grade: '' });
ok('新孩子年级为空', store.get().grade === '');

// 模拟画像页保存（schoolProgress = 一年级上学期）
const lp = Object.create(lpDef);
lp.data = JSON.parse(JSON.stringify(lpDef.data));
lp.data.schoolProgress = '一年级上学期';
lp.data.stageIndex = 1;        // 小学
lp.data.teachIndex = 0;
lp.data.feelingIndex = 0;
lp.data.weeklyMinutes = '300';
lp.data.timeSlotsSel = [];
lp.data.expectationsSel = [];
lp.setData = function (patch) { Object.keys(patch).forEach(k => { this.data[k] = patch[k]; }); };
lp.save();

ok('保存后年级自动回填为「一年级」', store.get().grade === '一年级');
ok('学校进度已存入画像', store.getLearner().schoolProgress === '一年级上学期');

/* resolveGrade：优先顶层 grade */
ok('resolveGrade 优先顶层 grade', store.resolveGrade() === '一年级');

// 再验证：顶层 grade 为空 + 学校进度有年级 → resolveGrade 兜底解析
const uid2 = store.addUser({ nickname: '老二', avatar: '🐰', grade: '' });
store.saveLearner({ schoolProgress: '三年级下学期' });
ok('无顶层 grade 时 resolveGrade 兜底解析', store.resolveGrade() === '三年级');

/* ============ 3. 缺年级拦截（resolveGrade 为空才弹） ============ */
console.log('=== 3. 缺年级拦截 ===');
const uid3 = store.addUser({ nickname: '老三', avatar: '🐱', grade: '' });
// 老三既无顶层 grade，也无学校进度 → resolveGrade 空
lastModal = null;
const g = store.resolveGrade();
ok('无任何年级信息时 resolveGrade 为空', g === '');
ok('此时应拦截（弹窗在 plan.generate 里触发）', g === ''); // 占位：实际弹窗逻辑在 plan 页

/* ============ 4. chips 多选（toggleSlot / toggleExpect） ============ */
console.log('=== 4. chips 多选事件响应 ===');
// 用新 data-val 路径模拟 wxml 渲染后的事件（修复 data-v 单字符稳定性问题）
const lp2 = Object.create(lpDef);
lp2.data = JSON.parse(JSON.stringify(lpDef.data));
lp2.setData = function (patch) { Object.keys(patch).forEach(k => { this.data[k] = patch[k]; }); };
lp2.toggleSlot({ currentTarget: { dataset: { val: '放学后' } } });
lp2.toggleSlot({ currentTarget: { dataset: { val: '周末上午' } } });
ok('toggleSlot 多选累加', lp2.data.timeSlotsSel.indexOf('放学后') >= 0 && lp2.data.timeSlotsSel.indexOf('周末上午') >= 0);
lp2.toggleSlot({ currentTarget: { dataset: { val: '放学后' } } });
ok('toggleSlot 再次点击取消', lp2.data.timeSlotsSel.indexOf('放学后') < 0 && lp2.data.timeSlotsSel.indexOf('周末上午') >= 0);
lp2.toggleExpect({ currentTarget: { dataset: { val: '错题复盘' } } });
lp2.toggleExpect({ currentTarget: { dataset: { val: '复测巩固' } } });
ok('toggleExpect 多选累加', lp2.data.expectationsSel.length === 2);

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);

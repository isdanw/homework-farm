/**
 * test-tutor-hub.js —— 导学中心聚合页（方案 A）测试
 * 覆盖：
 *   1. tutorHub render 的概览统计（错题总数 / 待订正 / 已验证）
 *   2. mine.buildHubInfo 入口摘要（有待办 / 无数据两种文案）
 * 运行：node scripts/test-tutor-hub.js
 */
const storage = {};
global.wx = {
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
  navigateTo: () => {}, navigateBack: () => {}, switchTab: () => {},
  cloud: { callFunction: () => Promise.resolve({ result: { ok: true } }) }
};
const pageDefs = [];
global.Page = (def) => { pageDefs.push(def); };

const tutorStore = require('../miniprogram/utils/tutorStore.js');

require('..//miniprogram/pkgGuide/tutorHub/tutorHub.js');
const hubDef = pageDefs[0];

require('../miniprogram/pages/mine/mine.js');
const mineDef = pageDefs[1];

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}

/* ============ 1. tutorHub 概览统计 ============ */
console.log('=== 1. tutorHub 概览统计 ===');
tutorStore.addMistake({ subject: 'math', subjectName: '数学', topic: '进位加法', errorType: 'E7', status: 'pending' });
tutorStore.addMistake({ subject: 'chinese', subjectName: '语文', topic: '声母拼读', errorType: 'E2', status: 'corrected' });
tutorStore.addEvidence({ subject: 'math', topic: '进位加法', errorType: 'E7', total: 5, correct: 5, rate: 1, passed: true });

const hub = Object.create(hubDef);
hub.data = JSON.parse(JSON.stringify(hubDef.data));
hub.setData = function (patch) { Object.assign(this.data, patch); };
hub.render();

ok('错题总数 = 2', hub.data.overview.mistakes === 2);
ok('待订正 = 1', hub.data.overview.pending === 1);
ok('已验证 = 1', hub.data.overview.evidence === 1);
ok('导学归档 = 0（无会话）', hub.data.overview.sessions === 0);

/* ============ 2. mine.buildHubInfo 摘要 ============ */
console.log('=== 2. mine.buildHubInfo 摘要 ===');
const mine = Object.create(mineDef);
mine.data = JSON.parse(JSON.stringify(mineDef.data));
const info1 = mine.buildHubInfo();
ok('有待办时含「待订正」', info1.indexOf('待订正') >= 0);
ok('有证据时含「已验证」', info1.indexOf('已验证') >= 0);

// 清空数据 → 无数据默认文案
storage[Object.keys(storage).find(k => k.indexOf('wb_hwfarm_tutor') === 0)] = { sessions: [], mistakes: [], evidence: [] };
const info2 = mine.buildHubInfo();
ok('无数据时返回引导文案', info2.indexOf('一站式学习闭环') >= 0);

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);

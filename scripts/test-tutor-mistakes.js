/**
 * test-tutor-mistakes.js —— 错题本页 + P2 诊断归因闭环测试（mock wx/Page）
 * 覆盖：错题列表渲染/筛选 → 去订正导航 → 标记已订正 →
 *       导学页 mistakeContext 解析 → 订正开场 → 归档诊断(stuck)→ 错题落库 → 小结弹窗
 * 运行：node scripts/test-tutor-mistakes.js
 */
const path = require('path');

/* ---------- mock wx ---------- */
const storage = {};
const calls = [];
const navigations = [];
let lastModal = null;
let lastToast = '';
global.wx = {
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  cloud: {
    callFunction: (o) => {
      calls.push(o);
      if (o.data.action === 'archive') {
        return Promise.resolve({
          result: {
            ok: true, id: 'archive_x',
            diagnosis: {
              topic: '20以内进位加法', stuck: true, errorType: 'E7',
              errorDesc: '思路正确但运算失误', suggestion: '分步书写并逐行检查', done: false
            },
            mistakeId: 'mk_cloud'
          }
        });
      }
      return Promise.resolve({ result: { ok: true, reply: '先回忆：9+5，把 5 拆成 1 和 4，先凑十…' } });
    }
  },
  showToast: (t) => { lastToast = t; },
  showModal: (opts) => { lastModal = opts; opts.success && opts.success({ confirm: true, cancel: false }); },
  showLoading: () => {}, hideLoading: () => {},
  navigateTo: (o) => { navigations.push(o.url); },
  navigateBack: () => {}
};

/* ---------- mock Page（捕获所有页面定义，按文件名区分） ---------- */
const pageDefs = {};
let curFile = '';
global.Page = (def) => { pageDefs[curFile] = def; };

/* 真实加载依赖 */
const store = require('../miniprogram/utils/store.js');
const tutorStore = require('../miniprogram/utils/tutorStore.js');
const studyPlan = require('../miniprogram/utils/studyPlan.js');

/* ---------- 手动加载两个页面（记录文件名） ---------- */
const _load = (file) => {
  curFile = file;
  delete require.cache[require.resolve(file)];
  require(file);
};
_load('..//miniprogram/pkgTools/mistakes/mistakes.js');
const mistakesDef = pageDefs['..//miniprogram/pkgTools/mistakes/mistakes.js'];
_load('..//miniprogram/pkgGuide/tutor/tutor.js');
const tutorDef = pageDefs['..//miniprogram/pkgGuide/tutor/tutor.js'];

/* 构造页面实例 */
function makePage(def) {
  const p = Object.create(def);
  p.data = JSON.parse(JSON.stringify(def.data));
  p.setData = function (patch, cb) { Object.keys(patch).forEach(k => { this.data[k] = patch[k]; }); if (cb) cb(); };
  return p;
}
const mkPage = makePage(mistakesDef);
const tutPage = makePage(tutorDef);

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  /* ================= 1. 错题落库 ================= */
  console.log('=== 1. 错题落库（模拟归档诊断） ===');
  tutorStore.addMistake({ subject: 'math', subjectName: '数学', topic: '20以内进位加法', errorType: 'E7', errorDesc: '思路正确但运算失误', suggestion: '分步书写并逐行检查', status: 'pending' });
  tutorStore.addMistake({ subject: 'chinese', subjectName: '语文', topic: '拼音 b/d 混淆', errorType: 'E2', errorDesc: '概念混淆', suggestion: '概念对比表', status: 'pending' });
  ok('错题总数 = 2', tutorStore.mistakeCount() === 2);
  ok('待订正数量 = 2', tutorStore.getMistakes().filter(m => m.status !== 'corrected').length === 2);

  /* ================= 2. 错题本页渲染 ================= */
  console.log('=== 2. 错题本页渲染 / 筛选 ===');
  mkPage.onShow();
  ok('默认显示全部 2 条', mkPage.data.list.length === 2);
  ok('概览待订正数 = 2', mkPage.data.pendingCount === 2);
  ok('错因标签名映射 E7=信息处理', mkPage.data.list.find(x => x.errorType === 'E7').errorTypeName === '信息处理');
  ok('错因标签名映射 E2=概念', mkPage.data.list.find(x => x.errorType === 'E2').errorTypeName === '概念');
  ok('状态文案 = 待订正', mkPage.data.list[0].statusText === '待订正');
  ok('时间格式化非空', !!mkPage.data.list[0].timeText);

  // 筛选数学
  mkPage.pickFilter({ currentTarget: { dataset: { key: 'math' } } });
  ok('筛选数学后仅 1 条', mkPage.data.list.length === 1 && mkPage.data.list[0].subject === 'math');

  // 筛选语文
  mkPage.pickFilter({ currentTarget: { dataset: { key: 'chinese' } } });
  ok('筛选语文后仅 1 条', mkPage.data.list.length === 1 && mkPage.data.list[0].subject === 'chinese');

  // 切回全部
  mkPage.pickFilter({ currentTarget: { dataset: { key: 'all' } } });
  ok('切回全部后 2 条', mkPage.data.list.length === 2);

  /* ================= 3. 去订正导航 ================= */
  console.log('=== 3. 去订正导航 ===');
  const target = mkPage.data.list.find(x => x.subject === 'math');
  navigations.length = 0;
  mkPage.goCorrect({ currentTarget: { dataset: { m: target } } });
  ok('触发 navigateTo', navigations.length === 1);
  ok('导航目标为 tutor 页', navigations[0].indexOf('/pkgGuide/tutor/tutor') === 0);
  ok('携带 subject=math', navigations[0].indexOf('key=math') >= 0);
  ok('携带 topic 编码', navigations[0].indexOf('topic=') >= 0);
  ok('携带 errorType=E7', navigations[0].indexOf('errorType=E7') >= 0);

  /* ================= 4. 标记已订正 ================= */
  console.log('=== 4. 标记已订正 ===');
  const m2 = mkPage.data.list.find(x => x.subject === 'math');
  mkPage.toggleStatus({ currentTarget: { dataset: { m: m2 } } });
  ok('状态已切为已订正', tutorStore.getMistakes().find(x => x.subject === 'math').status === 'corrected');
  ok('待订正数降为 1', tutorStore.getMistakes().filter(m => m.status !== 'corrected').length === 1);

  /* ================= 5. 导学页 mistakeContext 解析 ================= */
  console.log('=== 5. 导学页 mistakeContext 解析 ===');
  tutPage.onLoad({ key: 'math', topic: encodeURIComponent('20以内进位加法'), errorType: encodeURIComponent('E7') });
  ok('mistakeContext.topic 解码正确', tutPage.data.mistakeContext && tutPage.data.mistakeContext.topic === '20以内进位加法');
  ok('mistakeContext.errorType = E7', tutPage.data.mistakeContext && tutPage.data.mistakeContext.errorType === 'E7');
  ok('taskContext 为 null', tutPage.data.taskContext === null);
  ok('学科自动设为数学', tutPage.data.subject === 'math');

  console.log('=== 6. 订正开场导学 ===');
  await sleep(500);
  ok('自动发起开场消息', tutPage.data.messages.length >= 1 && tutPage.data.messages[0].role === 'user');
  ok('开场内容包含知识点', tutPage.data.messages[0].content.indexOf('20以内进位加法') >= 0);
  ok('开场内容包含错因 E7', tutPage.data.messages[0].content.indexOf('E7') >= 0);
  ok('AI 已回复', tutPage.data.messages.some(m => m.role === 'assistant'));

  /* ================= 7. 归档诊断 → 落库 → 小结 ================= */
  console.log('=== 7. 归档诊断 → 落库 → 小结 ===');
  const cntBefore = tutorStore.mistakeCount();
  tutPage.endSession();
  await sleep(50);
  ok('调用了 archive', calls.some(c => c.data.action === 'archive'));
  ok('诊断卡点 → 又新增一条错题', tutorStore.mistakeCount() === cntBefore + 1);
  ok('新错题为 E7', tutorStore.getMistakes()[0].errorType === 'E7');
  ok('弹出导学小结且含卡点', !!lastModal && lastModal.content.indexOf('卡点') >= 0);
  ok('小结提示记入错题本', lastModal && lastModal.content.indexOf('错题本') >= 0);
  ok('无计划任务上下文不触发回写', tutPage.data.taskContext === null);

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();

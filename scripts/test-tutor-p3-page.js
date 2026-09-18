/**
 * test-tutor-p3-page.js —— P3 页面数据流测试：复测页 + 报告页（mock wx/Page）
 * 运行：node scripts/test-tutor-p3-page.js
 */
const path = require('path');

/* ---------- 固定 5 题 ---------- */
const FIVE = [
  { q: '2+3=？', options: ['4', '5', '6', '7'], answer: 'B', analysis: '2+3=5' },
  { q: '3+5=？', options: ['7', '9', '8', '6'], answer: 'C', analysis: '3+5=8' },
  { q: '4+4=？', options: ['8', '7', '9', '6'], answer: 'A', analysis: '4+4=8' },
  { q: '5+6=？', options: ['10', '12', '13', '11'], answer: 'D', analysis: '5+6=11' },
  { q: '7+8=？', options: ['14', '15', '16', '17'], answer: 'B', analysis: '7+8=15' }
];

/* ---------- mock wx ---------- */
const storage = {};
const calls = [];
let lastToast = '';
global.wx = {
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  cloud: {
    callFunction: (o) => {
      calls.push(o);
      if (o.name === 'tutorRetest' && o.data.action === 'generate') {
        return Promise.resolve({ result: { ok: true, questions: FIVE } });
      }
      if (o.name === 'tutorRetest' && o.data.action === 'judge') {
        // 本地比对（模拟云函数判定逻辑）
        const qs = o.data.questions;
        const ans = o.data.answers;
        const results = qs.map((q, i) => {
          const your = String(ans[i] || '').trim().toUpperCase().slice(0, 1);
          return { index: i, correct: your === q.answer, your: your, answer: q.answer };
        });
        const correct = results.filter(r => r.correct).length;
        const rate = qs.length ? correct / qs.length : 0;
        return Promise.resolve({ result: {
          ok: true, results, total: qs.length, correct, rate,
          pass: qs.length >= 5 && rate >= 0.8, reason: ''
        }});
      }
      return Promise.resolve({ result: { ok: true } });
    }
  },
  showToast: (t) => { lastToast = t; },
  showModal: () => {},
  showLoading: () => {}, hideLoading: () => {},
  navigateTo: () => {},
  navigateBack: () => {}
};

/* ---------- mock Page（按文件区分） ---------- */
const pageDefs = {};
let curFile = '';
global.Page = (def) => { pageDefs[curFile] = def; };

/* 真实加载依赖 */
require('../miniprogram/utils/store.js');
const tutorStore = require('../miniprogram/utils/tutorStore.js');

const _load = (file) => { curFile = file; delete require.cache[require.resolve(file)]; require(file); };
_load('..//miniprogram/pkgGuide/retest/retest.js');
const retestDef = pageDefs['..//miniprogram/pkgGuide/retest/retest.js'];
_load('..//miniprogram/pkgGuide/report/report.js');
const reportDef = pageDefs['..//miniprogram/pkgGuide/report/report.js'];

function makePage(def) {
  const p = Object.create(def);
  p.data = JSON.parse(JSON.stringify(def.data));
  p.setData = function (patch, cb) { Object.keys(patch).forEach(k => { this.data[k] = patch[k]; }); if (cb) cb(); };
  return p;
}

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  /* 预置一条错题 */
  tutorStore.addMistake({ subject: 'math', subjectName: '数学', topic: '20以内进位加法', errorType: 'E7', errorDesc: '运算失误', suggestion: '分步书写', status: 'pending' });

  /* ============ 复测页 ============ */
  console.log('=== 复测页 ===');
  const rt = makePage(retestDef);
  rt.onLoad({ key: 'math', topic: encodeURIComponent('20以内进位加法'), errorType: encodeURIComponent('E7') });
  await sleep(30);
  ok('解析 subject/topic/errorType', rt.data.subject === 'math' && rt.data.topic === '20以内进位加法' && rt.data.errorType === 'E7');
  ok('生成 5 题', rt.data.questions.length === 5);
  ok('进入答题态', rt.data.phase === 'answering');
  ok('每题含字母选项', rt.data.questions[0].letters.join('') === 'ABCD');

  // 逐题作答（全对 B C A D B）
  const picks = ['B', 'C', 'A', 'D', 'B'];
  for (let i = 0; i < 5; i++) {
    rt.setData({ current: i });
    rt.pickOption({ currentTarget: { dataset: { letter: picks[i] } } });
  }
  await sleep(300);
  ok('答完 5 题', rt.answeredCount() === 5);

  // 未答满提交会被拦
  rt.setData({ answers: ['B', 'C', '', '', ''] });
  rt.submit();
  await sleep(10);
  ok('未答满提交被拦截（无 judge 调用）', !calls.some(c => c.name === 'tutorRetest' && c.data.action === 'judge'));

  // 答满提交
  rt.setData({ answers: picks.slice() });
  rt.submit();
  await sleep(30);
  ok('提交触发 judge', calls.some(c => c.name === 'tutorRetest' && c.data.action === 'judge'));
  ok('结果达标 pass=true', rt.data.result && rt.data.result.pass === true);
  ok('进入结果态', rt.data.phase === 'result');
  ok('错题被标记已订正', tutorStore.getMistakes().find(m => m.topic === '20以内进位加法').status === 'corrected');
  ok('本地证据已记录', tutorStore.getEvidence().some(e => e.passed === true && e.topic === '20以内进位加法'));

  /* ============ 报告页 ============ */
  console.log('=== 报告页 ===');
  // 再补一条不同错因的错题 + 一条未达标证据
  tutorStore.addMistake({ subject: 'chinese', subjectName: '语文', topic: '拼音 b/d', errorType: 'E2', errorDesc: '概念混淆', suggestion: '对比表', status: 'pending' });
  tutorStore.addEvidence({ subject: 'math', subjectName: '数学', topic: '凑十法', errorType: 'E7', total: 5, correct: 3, rate: 0.6, passed: false });

  const rp = makePage(reportDef);
  rp.onShow();
  ok('错题总数 = 2', rp.data.overview.mistakes === 2);
  ok('待订正 = 1', rp.data.overview.pending === 1);
  ok('已验证证据 = 1', rp.data.overview.evidence === 1);
  ok('错因分布含 E7 和 E2', rp.data.errorDist.some(d => d.type === 'E7') && rp.data.errorDist.some(d => d.type === 'E2'));
  ok('错因分布按数量降序', rp.data.errorDist[0].count >= rp.data.errorDist[rp.data.errorDist.length - 1].count);
  ok('学科分布含数学和语文', rp.data.subjectDist.some(s => s.key === 'math') && rp.data.subjectDist.some(s => s.key === 'chinese'));
  ok('复测记录含达标与未达标', rp.data.evidenceList.some(e => e.passed) && rp.data.evidenceList.some(e => !e.passed));
  ok('有数据 hasData=true', rp.data.hasData === true);

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();

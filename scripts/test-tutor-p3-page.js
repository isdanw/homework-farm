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
        // attempt 契约：只回题面，answer/analysis 留在服务端
        return Promise.resolve({ result: {
          ok: true, attemptId: 'at_test', expiresAt: Date.now() + 3600000,
          questions: FIVE.map(q => ({ q: q.q, options: q.options }))
        }});
      }
      if (o.name === 'tutorRetest' && o.data.action === 'submit') {
        // 模拟服务端判分：答案来自「服务端」的 FIVE，客户端交上来的只有 answers
        const ans = o.data.answers;
        const results = FIVE.map((q, i) => {
          const your = String(ans[i] || '').trim().toUpperCase().slice(0, 1);
          return { index: i, correct: your === q.answer, your: your, answer: q.answer, analysis: q.analysis };
        });
        const correct = results.filter(r => r.correct).length;
        const rate = FIVE.length ? correct / FIVE.length : 0;
        const pass = FIVE.length >= 5 && rate >= 0.8;
        const evidenced = o.data.independence === 'self_declared_no_hint';
        return Promise.resolve({ result: {
          ok: true, attemptId: o.data.attemptId, results, total: FIVE.length, correct, rate, pass,
          reason: pass ? '' : '通过率未达 80%',
          independence: o.data.independence || 'unknown',
          evidenceProduced: evidenced,
          evidenceId: evidenced ? 'ev_cloud_1' : ''
        }});
      }
      return Promise.resolve({ result: { ok: true } });
    }
  },
  showToast: (t) => { lastToast = (t && t.title) || t; },
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
  ok('题面不含答案（attempt 契约）', !('answer' in rt.data.questions[0]) && !('analysis' in rt.data.questions[0]));
  ok('出题带 attempt 能力声明，且不再传 childId（单孩子模型）', (() => {
    const g = calls.find(c => c.data.action === 'generate');
    return g && g.data.features === 'attempt_v1' && !('childId' in g.data);
  })());
  ok('记下 attemptId', rt.data.attemptId === 'at_test');

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
  ok('未答满提交被拦截（无 submit 调用）', !calls.some(c => c.name === 'tutorRetest' && c.data.action === 'submit'));

  // 没声明独立性也要拦：预选等于替孩子回答
  rt.setData({ answers: picks.slice() });
  rt.submit();
  await sleep(10);
  ok('未声明独立性被拦截', !calls.some(c => c.name === 'tutorRetest' && c.data.action === 'submit'));
  ok('拦截有提示语', /独立完成|提示/.test(lastToast), lastToast);

  // 声明「独立完成」后再交卷
  rt.pickIndependence({ currentTarget: { dataset: { value: 'self_declared_no_hint' } } });
  rt.submit();
  await sleep(30);
  const sub = calls.find(c => c.name === 'tutorRetest' && c.data.action === 'submit');
  ok('提交触发 submit', !!sub);
  ok('交卷只带 attemptId + answers（不重复上传题面）', !!sub && sub.data.attemptId === 'at_test' && !('questions' in sub.data));
  ok('结果达标 pass=true', rt.data.result && rt.data.result.pass === true);
  ok('进入结果态', rt.data.phase === 'result');
  ok('错题被标记已订正', tutorStore.getMistakes().find(m => m.topic === '20以内进位加法').status === 'corrected');
  ok('本地证据已记录', tutorStore.getEvidence().some(e => e.passed === true && e.topic === '20以内进位加法'));
  ok('本地证据带 attemptId 与独立性', (() => {
    const e = tutorStore.getEvidence().find(x => x.topic === '20以内进位加法');
    return e && e.attemptId === 'at_test' && e.independence === 'self_declared_no_hint';
  })());

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

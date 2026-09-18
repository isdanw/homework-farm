/**
 * test-tutor-reviews.js —— 复习窗口闭环测试（S2：归档派生 + 复测推进）
 * 覆盖：
 *   tutorChat archive：诊断 stuck → 派生 tutor_reviews（stage1/次日到期）+ clientId 一致性 + 返回 review；
 *                      非 stuck / 无卡点 → 不派生；chat 带 learnerCtx → 注入 system
 *   tutorRetest judge：pass → review done + 错题转 corrected；fail → stage+1 dueAt 顺延（封顶 5）
 * 运行：node scripts/test-tutor-reviews.js
 */
const path = require('path');
const { createMockDb, installMock } = require('./mock-tcb.js');

const db = createMockDb();
const restore = installMock(db);

const DAY = 86400000;
/* AI mock：按 system 内容区分「诊断」与「出题」调用 */
db.mockAiText = 'MOCK_REPLY';

const tutorChat = require(path.join(__dirname, '../cloudfunctions/tutorChat/index.js'));
const tutorRetest = require(path.join(__dirname, '../cloudfunctions/tutorRetest/index.js'));

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}
const STUCK_DIAG = JSON.stringify({
  topic: '20以内进位加法', stuck: true, errorType: 'E7',
  errorDesc: '运算失误', suggestion: '分步书写并逐行检查', done: false
});
const CLEAN_DIAG = JSON.stringify({
  topic: '20以内进位加法', stuck: false, errorType: '', errorDesc: '', suggestion: '', done: true
});

(async () => {
  /* ================= 1. archive：stuck → 派生复习窗口 ================= */
  console.log('=== archive：诊断 stuck → 错题 + 复习窗口派生 ===');
  db.mockAiText = STUCK_DIAG;
  const now = Date.now();
  const ra = await tutorChat.main({
    userInfo: { openId: 'opA' }, action: 'archive', subject: 'math',
    messages: [{ role: 'user', content: '9+8 好难', ts: now }, { role: 'assistant', content: '先凑十试试', ts: now }],
    learner: { grade: '一年级' },
    sessionClientId: 'ts_local_1',
    mistakeClientId: 'mk_local_1',
    reviewClientId: 'mk_local_1_rv'
  });
  ok('archive ok=true', ra.ok === true);
  ok('返回 mistakeId（云端 _id）', typeof ra.mistakeId === 'string' && ra.mistakeId.length > 0);
  ok('返回 review（客户端视图）', !!ra.review && ra.review.id === 'mk_local_1_rv');
  ok('review.mistakeId 与本地错题 uid 一致', ra.review && ra.review.mistakeId === 'mk_local_1');
  ok('review stage=1', ra.review && ra.review.stage === 1);
  ok('review dueAt ≈ 次日（24h±5s）', ra.review && Math.abs(ra.review.dueAt - (now + DAY)) < 5000);
  ok('review 未关闭', ra.review && ra.review.done === false);

  const sess = db.collections.tutor_sessions[0];
  ok('session doc 携带 clientId=ts_local_1', sess.clientId === 'ts_local_1');
  const mk = db.collections.tutor_mistakes.find(d => d.clientId === 'mk_local_1');
  ok('错题 doc 携带 clientId=mk_local_1', !!mk);
  const rv = db.collections.tutor_reviews.find(d => d.clientId === 'mk_local_1_rv');
  ok('云端 review doc 已落库', !!rv);
  ok('云端 review.mistakeClientId=mk_local_1（judge 联动定位键）', rv && rv.mistakeClientId === 'mk_local_1');

  console.log('=== archive：非 stuck → 不派生 ===');
  db.mockAiText = CLEAN_DIAG;
  const rb = await tutorChat.main({
    userInfo: { openId: 'opA' }, action: 'archive', subject: 'math',
    messages: [{ role: 'user', content: '懂了！', ts: now }],
    sessionClientId: 'ts_local_2', mistakeClientId: 'mk_local_2', reviewClientId: 'mk_local_2_rv'
  });
  ok('archive ok=true 且 review=null', rb.ok === true && rb.review === null);
  ok('未新增错题', db.collections.tutor_mistakes.filter(d => d.clientId === 'mk_local_2').length === 0);
  ok('未新增复习窗口', db.collections.tutor_reviews.filter(d => d.clientId === 'mk_local_2_rv').length === 0);

  console.log('=== chat：learnerCtx 注入（跨会话记忆，S3） ===');
  db.mockAiText = 'MOCK_REPLY';
  await tutorChat.main({
    userInfo: { openId: 'opA' }, action: 'chat', subject: 'math', content: '新题：7+6',
    history: [], learnerCtx: '1) 知识点「进位加法」（错因 E7）：运算失误'
  });
  const msgs = db.lastMessages;
  const ctxMsg = msgs.find(m => m.role === 'system' && m.content.indexOf('近期卡点参考') >= 0);
  ok('存在近期卡点 system 消息', !!ctxMsg);
  ok('卡点内容进入 prompt', ctxMsg && ctxMsg.content.indexOf('进位加法') >= 0 && ctxMsg.content.indexOf('E7') >= 0);

  await tutorChat.main({
    userInfo: { openId: 'opB_norisk' }, action: 'chat', subject: 'math', content: '新题：7+6', history: []
  });
  ok('无 learnerCtx 时不注入', !db.lastMessages.some(m => m.role === 'system' && m.content.indexOf('近期卡点参考') >= 0));

  /* ================= 2. judge：复习窗口推进 ================= */
  console.log('=== judge：未达标 → stage+1 顺延 ===');
  const q5 = [
    { q: 'q1', options: ['1', '2', '3', '4'], answer: 'A', analysis: '' },
    { q: 'q2', options: ['1', '2', '3', '4'], answer: 'A', analysis: '' },
    { q: 'q3', options: ['1', '2', '3', '4'], answer: 'A', analysis: '' },
    { q: 'q4', options: ['1', '2', '3', '4'], answer: 'A', analysis: '' },
    { q: 'q5', options: ['1', '2', '3', '4'], answer: 'A', analysis: '' }
  ];
  const rj1 = await tutorRetest.main({
    userInfo: { openId: 'opA' }, action: 'judge', subject: 'math',
    topic: '20以内进位加法', errorType: 'E7', mistakeId: 'mk_local_1',
    questions: q5, answers: ['A', 'A', 'A', 'B', 'B']   // 3/5 = 60% 未达标
  });
  ok('judge ok=true 且 pass=false', rj1.ok === true && rj1.pass === false);
  const rvAfterFail = db.collections.tutor_reviews.find(d => d.clientId === 'mk_local_1_rv');
  ok('review stage 1→2', rvAfterFail.stage === 2);
  ok('review 未关闭', rvAfterFail.done === false);
  ok('dueAt 顺延约 +2 天（stage2 档位）', Math.abs(rvAfterFail.dueAt - (Date.now() + 2 * DAY)) < 5000);

  console.log('=== judge：达标 → review 关闭 + 错题转已订正 ===');
  const rj2 = await tutorRetest.main({
    userInfo: { openId: 'opA' }, action: 'judge', subject: 'math',
    topic: '20以内进位加法', errorType: 'E7', mistakeId: 'mk_local_1',
    questions: q5, answers: ['A', 'A', 'A', 'A', 'B']   // 4/5 = 80% 达标
  });
  ok('judge pass=true', rj2.ok === true && rj2.pass === true);
  const rvAfterPass = db.collections.tutor_reviews.find(d => d.clientId === 'mk_local_1_rv');
  ok('review 已关闭（done=true）', rvAfterPass.done === true);
  const mkAfterPass = db.collections.tutor_mistakes.find(d => d.clientId === 'mk_local_1');
  ok('云端错题 status → corrected', mkAfterPass.status === 'corrected');

  console.log('=== judge：stage 封顶 5 ===');
  // 手动把 review 拉到 stage5，再未达标一次
  rvAfterFail.stage = 5; rvAfterFail.done = false;
  await tutorRetest.main({
    userInfo: { openId: 'opA' }, action: 'judge', subject: 'math',
    topic: '20以内进位加法', errorType: 'E7', mistakeId: 'mk_local_1',
    questions: q5, answers: ['B', 'B', 'B', 'B', 'B']
  });
  ok('stage 封顶不越界（=5）', rvAfterFail.stage === 5);

  console.log('=== judge：不带 mistakeId → 不触碰复习窗口 ===');
  await tutorRetest.main({
    userInfo: { openId: 'opA' }, action: 'judge', subject: 'math',
    topic: '独立复测', errorType: '', mistakeId: '',
    questions: q5, answers: ['A', 'A', 'A', 'A', 'A']
  });
  ok('review 状态未被误改（仍 done=true）', rvAfterPass.done === true);

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  restore();
  process.exit(failed ? 1 : 0);
})();

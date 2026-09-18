/**
 * test-tutor-sync.js —— tutorSync 云函数测试（闭环 S1：pull 回填 / push 回补）
 * 覆盖：pull 按 openid 过滤 + id 映射（clientId 优先）+ 限量；
 *       push 查重跳过 / 缺失补写 / reviews 进度同步 / 无 openid 拒绝
 * 运行：node scripts/test-tutor-sync.js
 */
const path = require('path');
const { createMockDb, installMock } = require('./mock-tcb.js');

const db = createMockDb();
const restore = installMock(db);
const fn = require(path.join(__dirname, '../cloudfunctions/tutorSync/index.js'));

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}

(async () => {
  /* ---------- 准备云端数据（两个 openid，验证隔离） ---------- */
  const now = Date.now();
  await db.collection('tutor_sessions').add({
    data: { openid: 'opA', clientId: 'ts_1', subject: 'math', messages: [], createdAt: now - 1000 }
  });
  await db.collection('tutor_sessions').add({
    data: { openid: 'opA', subject: 'math', messages: [], createdAt: now - 2000 }  // 旧数据：无 clientId
  });
  await db.collection('tutor_sessions').add({
    data: { openid: 'opB', clientId: 'ts_B', subject: 'chinese', messages: [], createdAt: now }
  });
  await db.collection('tutor_mistakes').add({
    data: { openid: 'opA', clientId: 'mk_1', subject: 'math', topic: '进位加法', status: 'pending', createdAt: now }
  });
  await db.collection('tutor_evidence').add({
    data: { openid: 'opA', clientId: 'ev_1', subject: 'math', passed: true, createdAt: now }
  });
  await db.collection('tutor_reviews').add({
    data: { openid: 'opA', clientId: 'mk_1_rv', mistakeClientId: 'mk_1', subject: 'math', stage: 2, dueAt: now, done: false, createdAt: now, updatedAt: now }
  });

  console.log('=== pull：按 openid 隔离回填 ===');
  const r1 = await fn.main({ userInfo: { openId: 'opA' }, action: 'pull' });
  ok('pull ok=true', r1.ok === true);
  ok('sessions 只回 opA 的 2 条（不含 opB）', r1.sessions.length === 2);
  ok('clientId 条目 id=ts_1', r1.sessions.some(s => s.id === 'ts_1'));
  ok('无 clientId 旧数据 id 兜底为 cloudId', r1.sessions.some(s => /^cloud_\d+$/.test(s.id)));
  ok('mistakes 回 1 条且 id=mk_1', r1.mistakes.length === 1 && r1.mistakes[0].id === 'mk_1');
  ok('evidence 回 1 条', r1.evidence.length === 1);
  ok('reviews 回 1 条且 stage=2', r1.reviews.length === 1 && r1.reviews[0].stage === 2);
  ok('cloudId 字段保留（便于服务端定位）', r1.reviews[0].cloudId === db.collections.tutor_reviews[0]._id);
  ok('pull 不串 openid（opB 数据未出现）', !r1.sessions.some(s => s.id === 'ts_B'));

  console.log('=== pull：无 openid 拒绝 ===');
  const r2 = await fn.main({ action: 'pull' });
  ok('无 openid → no_openid', r2.ok === false && r2.code === 'no_openid');

  console.log('=== push：查重跳过 + 缺失补写 ===');
  const r3 = await fn.main({
    userInfo: { openId: 'opA' }, action: 'push',
    sessions: [
      { id: 'ts_1', subject: 'math', messages: [], createdAt: 1 },          // 云端已有 clientId=ts_1 → 跳过
      { id: 'ts_local_new', subject: 'math', messages: [], createdAt: 2 }   // 云端没有 → 补写
    ],
    mistakes: [
      { id: 'mk_1', subject: 'math', status: 'corrected', createdAt: 1 },   // 已有 → 跳过（非 reviews 不同步状态）
      { id: 'mk_local_new', subject: 'math', status: 'pending', createdAt: 2 }
    ],
    evidence: [{ id: 'ev_local_new', subject: 'math', passed: false, createdAt: 2 }],
    reviews: [
      { id: 'mk_1_rv', mistakeId: 'mk_1', stage: 3, dueAt: now + 1, done: false, updatedAt: now + 999 },  // 已有但本地更新 → 同步进度
      { id: 'mk_local_new_rv', mistakeId: 'mk_local_new', stage: 1, dueAt: now, done: false, updatedAt: now } // 新增
    ]
  });
  ok('push ok=true', r3.ok === true);
  ok('补写 4 条（session/mistake/evidence/review 新增各 1）', r3.added === 4);
  ok('跳过 2 条（ts_1 / mk_1 已存在）', r3.skipped === 2);
  ok('reviews 进度同步 1 条（stage 2→3）', r3.updated === 1);
  const rvCloud = db.collections.tutor_reviews.find(d => d.clientId === 'mk_1_rv');
  ok('云端 review stage 已推进到 3', rvCloud && rvCloud.stage === 3);
  ok('补写的 session 带 openid 隔离', db.collections.tutor_sessions.some(d => d.clientId === 'ts_local_new' && d.openid === 'opA'));
  ok('push 文档不含本地 id 字段（clientId 承载）', !db.collections.tutor_sessions.find(d => d.clientId === 'ts_local_new').hasOwnProperty('id'));

  console.log('=== push：reviews 本地不比云端新 → 不更新 ===');
  const r4 = await fn.main({
    userInfo: { openId: 'opA' }, action: 'push',
    reviews: [{ id: 'mk_1_rv', mistakeId: 'mk_1', stage: 1, dueAt: 1, done: false, updatedAt: 1 }]
  });
  ok('旧进度被跳过', r4.skipped === 1 && r4.updated === 0);
  ok('云端 stage 保持 3', db.collections.tutor_reviews.find(d => d.clientId === 'mk_1_rv').stage === 3);

  console.log('=== push：无 openid 拒绝 ===');
  const r5 = await fn.main({ action: 'push', sessions: [{ id: 'x' }] });
  ok('无 openid → no_openid', r5.ok === false && r5.code === 'no_openid');

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  restore();
  process.exit(failed ? 1 : 0);
})();

/* studyPlanGen 教材库锚定（#19）单测
 * 运行：node scripts/test-studyplan-textbook.cjs
 * 覆盖：
 *   1. buildUserPrompt 无 toc 时与旧版逐字一致（零回归）
 *   2. buildTocBlock 正常/空 units/无 meta/无名单元/超长截断/长字段截断
 *   3. loadTextbookForPlan 官方可读/本人可读/他人 null/不存在 null/异常 null/无 id null
 *   4. main 集成（mock-tcb + mock ai）：有 id 注入目录并回传 textbookAnchored=true；
 *      他人 id/无 id 不注入；无 id 时 prompt 与旧版一致；频控仍生效
 */
process.env.EXAM_TEST = '1';
const { createMockDb, installMock } = require('./mock-tcb.js');
const db = createMockDb();
const restore = installMock(db);
const M = require('../cloudfunctions/studyPlanGen/index.js');
const T = M.__test;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

/* 旧版 buildUserPrompt（#19 之前的实现，逐字保留用于回归对比） */
function legacyUserPrompt(input) {
  let requirement = input.planPrompt || '按默认规则编排';
  if (requirement.length > 800) {
    requirement = '以下为该科目的「学科角色说明」。编排阶段任务时，请与其能力体系、术语与方法保持一致；' +
      '忽略其中关于答题/对话输出格式的要求，最终只输出计划 JSON。\n\n' + requirement;
  }
  return '请为以下科目编排一学期的阶段计划：\n' +
    '科目：' + input.subject + '\n' +
    '年级：' + (input.grade || '未填写') + '\n' +
    '学期：' + (input.term || '上学期') + '\n' +
    '教材：' + (input.textbook || '未指定（按统编主流版本）') + '\n\n' +
    '编排要求（务必遵守）：\n' + requirement;
}

(async () => {
  const ME = 'openid_me', OTHER = 'openid_other';

  /* ---------- 1. 无 toc 零回归 ---------- */
  console.log('== 1. buildUserPrompt 无 toc 与旧版逐字一致 ==');
  const cases = [
    { subject: '数学', grade: '一年级', term: '上学期', textbook: '人教版', planPrompt: '' },
    { subject: '语文', grade: '', term: '', textbook: '', planPrompt: '按家长要求' },
    { subject: '英语', grade: '三年级', term: '下学期', textbook: '外研版', planPrompt: '长'.repeat(900) }
  ];
  cases.forEach((c, i) => {
    ok(T.buildUserPrompt(c, '') === legacyUserPrompt(c), '用例' + (i + 1) + ' 无 toc 输出与旧版一致');
  });
  ok(T.buildUserPrompt(cases[0], null) === legacyUserPrompt(cases[0]), 'toc=null 同样零变化');

  /* ---------- 2. buildTocBlock ---------- */
  console.log('== 2. buildTocBlock ==');
  ok(T.buildTocBlock(null) === '', 'null → 空串');
  ok(T.buildTocBlock({ title: 'x', units: [] }) === '', '空 units → 空串');
  ok(T.buildTocBlock({ units: 'bad' }) === '', 'units 非数组 → 空串');
  const tbFull = {
    title: '人教版·一年级数学上册', version: '人教版', grade: '一年级', term: '上学期',
    units: [
      { order: 1, name: '准备课', sections: ['数一数', '比多少'] },
      { order: 2, name: '位置', sections: ['上、下、前、后'] },
      { order: 3, name: '1-5的认识' }
    ]
  };
  const toc = T.buildTocBlock(tbFull);
  ok(toc.indexOf('【教材单元目录（权威，必须严格遵循）】') === 0, '目录块带权威标题');
  ok(toc.indexOf('《人教版·一年级数学上册（人教版·一年级·上学期）》共 3 个单元') > 0, '标题+meta+单元数');
  ok(toc.indexOf('1. 准备课\n   小节：数一数、比多少') > 0, '单元行+小节折行');
  ok(toc.indexOf('3. 1-5的认识\n   小节') < 0, '无小节单元不带小节行');
  ok(toc.indexOf('阶段名采用「第N单元 + 单元名」，单元名与目录逐字一致') > 0, '含阶段名逐字一致铁律');
  const tbNoMeta = T.buildTocBlock({ title: '无名教材', units: [{ name: '唯一单元' }] });
  ok(tbNoMeta.indexOf('《无名教材》共 1 个单元') > 0, '无 meta 不加括号');
  const tbNoName = T.buildTocBlock({ title: 'x', units: [{ name: '' }, { name: '第二单元' }] });
  ok(tbNoName.indexOf('1. 第1单元') > 0, '无名单元兜底「第N单元」');
  // 超长截断：60 个单元、每单元 20 个小节 × 30 字符 → 远超 4000
  const longUnits = [];
  for (let i = 0; i < 60; i++) longUnits.push({ name: '单元' + i, sections: Array.from({ length: 20 }, () => '小'.repeat(30)) });
  const tocLong = T.buildTocBlock({ title: '长目录', units: longUnits });
  ok(tocLong.indexOf('目录过长已截断') > 0, '超长触发截断提示');
  ok(tocLong.length < 4600, '截断后总长受控（' + tocLong.length + ' < 4600）');
  const tbLongTitle = T.buildTocBlock({ title: '标'.repeat(100), units: [{ name: 'u' }] });
  ok(tbLongTitle.indexOf('《' + '标'.repeat(60) + '》') > 0, 'title >60 截断');
  const tbLongSec = T.buildTocBlock({ title: 'x', units: [{ name: 'u', sections: ['节'.repeat(50)] }] });
  ok(tbLongSec.indexOf('节'.repeat(30)) > 0 && tbLongSec.indexOf('节'.repeat(31)) < 0, 'section >30 截断');

  /* ---------- 3. loadTextbookForPlan ---------- */
  console.log('== 3. loadTextbookForPlan ==');
  const TB = T.TEXTBOOK_COLL;
  ok(TB === 'textbook_library', '集合名 textbook_library');
  db.collection(TB).add({ openid: '', textbookId: 'tb_seed_1', title: '官方教材', subject: 'math', units: [{ order: 1, name: '准备课' }] });
  db.collection(TB).add({ openid: ME, textbookId: 'tb_me_1', title: '我的教材', subject: 'math', units: [{ order: 1, name: '我的单元' }] });
  db.collection(TB).add({ openid: OTHER, textbookId: 'tb_other_1', title: '别人的教材', subject: 'math', units: [{ order: 1, name: '私密单元' }] });

  const l0 = await T.loadTextbookForPlan(db.app, ME, '');
  ok(l0 === null, '空 textbookId → null');
  const l1 = await T.loadTextbookForPlan(db.app, ME, 'tb_seed_1');
  ok(l1 && l1.textbookId === 'tb_seed_1', '官方库（openid=""）人人可读');
  const l2 = await T.loadTextbookForPlan(db.app, '', 'tb_seed_1');
  ok(l2 && l2.textbookId === 'tb_seed_1', '未登录 openid 也可读官方库');
  const l3 = await T.loadTextbookForPlan(db.app, ME, 'tb_me_1');
  ok(l3 && l3.textbookId === 'tb_me_1', '本人库可读');
  const l4 = await T.loadTextbookForPlan(db.app, ME, 'tb_other_1');
  ok(l4 === null, '他人私有 → null（不注入）');
  const l5 = await T.loadTextbookForPlan(db.app, ME, 'tb_not_exist');
  ok(l5 === null, '不存在 → null');
  const badApp = { database: () => ({ collection: () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('db down'); } }) }) }) }) };
  const l6 = await T.loadTextbookForPlan(badApp, ME, 'tb_seed_1');
  ok(l6 === null, '读取异常 → null（fail-open）');

  /* ---------- 4. main 集成 ---------- */
  /* ⚠️ studyPlanGen 有 10 秒/1 次频控（模块级内存 Map）——每个用例必须用独立 openId */
  console.log('== 4. main 集成（mock ai） ==');
  const GOOD_PLAN = JSON.stringify({ stages: [{ name: '第1单元 准备课', weeks: '第1-2周', goal: 'g', tasks: [{ name: 't', days: 2 }] }] });
  const ev = (openId, extra) => Object.assign({ userInfo: { openId: openId }, subject: '数学', grade: '一年级', term: '上学期', textbook: '人教版' }, extra || {});

  // 4a. 有官方 textbookId → 注入目录 + anchored=true
  db.mockAiText = GOOD_PLAN;
  const r1 = await M.main(ev('me_a', { textbookId: 'tb_seed_1' }));
  ok(r1.ok && r1.textbookAnchored === true, '官方锚点：ok + textbookAnchored=true');
  const msg1 = (db.lastMessages && db.lastMessages[1] && db.lastMessages[1].content) || '';
  ok(msg1.indexOf('【教材单元目录（权威，必须严格遵循）】') > 0, 'user prompt 注入目录块');
  ok(msg1.indexOf('1. 准备课') > 0, '目录块含单元名');
  ok(msg1.indexOf('编排铁律') > 0, '目录块含编排铁律');

  // 4b. 他人 textbookId → 不注入 + anchored=false，但计划照常生成
  db.mockAiText = GOOD_PLAN;
  const r2 = await M.main(ev('me_b', { textbookId: 'tb_other_1' }));
  ok(r2.ok && r2.textbookAnchored === false, '他人锚点：照常生成 + anchored=false');
  const msg2 = (db.lastMessages && db.lastMessages[1] && db.lastMessages[1].content) || '';
  ok(msg2.indexOf('教材单元目录') < 0, '他人锚点不注入目录');

  // 4c. 无 textbookId → prompt 与旧版逐字一致 + anchored=false
  db.mockAiText = GOOD_PLAN;
  const r3 = await M.main(ev('me_c'));
  ok(r3.ok && r3.textbookAnchored === false, '无锚点：ok + anchored=false');
  const msg3 = (db.lastMessages && db.lastMessages[1] && db.lastMessages[1].content) || '';
  ok(msg3.indexOf('教材单元目录') < 0, '无锚点不注入目录');
  ok(msg3 === legacyUserPrompt({ subject: '数学', grade: '一年级', term: '上学期', textbook: '人教版', planPrompt: '' }),
    '无锚点 user prompt 与旧版逐字一致');

  // 4d. 本人 textbookId → 注入（tb_me_1 归属 ME，须用同一 openId）
  db.mockAiText = GOOD_PLAN;
  const r4 = await M.main(ev(ME, { textbookId: 'tb_me_1' }));
  ok(r4.ok && r4.textbookAnchored === true, '本人锚点：anchored=true');
  ok((db.lastMessages[1].content || '').indexOf('我的单元') > 0, '本人目录单元名注入');

  // 4e. 入参校验不受影响
  db.mockAiText = GOOD_PLAN;
  const r5 = await M.main({ userInfo: { openId: 'me_e' }, subject: '数学' });
  ok(!r5.ok && r5.code === 'no_grade', '缺年级仍拒绝');
  const r6 = await M.main({ userInfo: { openId: 'me_f' }, subject: '', grade: '一年级' });
  ok(!r6.ok && r6.code === 'empty', '缺科目仍拒绝');

  // 4f. 频控仍生效（同一 openid 10 秒内第二次）
  db.mockAiText = GOOD_PLAN;
  await M.main(ev('rate_probe', { textbookId: 'tb_seed_1' }));
  const r7 = await M.main(ev('rate_probe', { textbookId: 'tb_seed_1' }));
  ok(!r7.ok && r7.code === 'rate_limit', '频控窗口内第二次被限流');

  // 4g. AI 返回非 JSON → parse 失败路径不受影响
  db.mockAiText = '我不是 JSON';
  const r8 = await M.main(ev('me_g'));
  ok(!r8.ok && r8.code === 'parse', 'AI 垃圾输出仍走 parse 失败');

  restore();
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('运行异常：', e); process.exit(1); });

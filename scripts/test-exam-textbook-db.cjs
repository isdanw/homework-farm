/* examService 教材库 db 层单测（mock-tcb 内存数据库，不连真云）
 * 运行：node scripts/test-exam-textbook-db.cjs
 * 覆盖：saveTextbook 新建/更新/拒绝、listTextbooks 官方+本人分组与筛选、
 *       getTextbook 越权拒绝、deleteTextbook 仅本人（含官方种子删不掉的隔离验证） */
process.env.EXAM_TEST = '1';
const M = require('../cloudfunctions/examService/index.js');
const { createMockDb } = require('./mock-tcb.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

(async () => {
  const db = createMockDb();
  const app = db.app;
  const ME = 'openid_me', OTHER = 'openid_other';
  const TB = M.TEXTBOOK_COLL;

  // 预置：官方种子 2 条 + 他人私有 1 条
  db.collection(TB).add({ openid: '', textbookId: 'tb_seed_math_g1_s', title: '人教版·一年级数学上册', subject: 'math', subjectName: '数学', grade: '一年级', term: '上学期', version: '人教版', source: 'seed', units: [{ order: 1, name: '准备课', keywords: ['数一数'] }], createdAt: 1000, updatedAt: 1000 });
  db.collection(TB).add({ openid: '', textbookId: 'tb_seed_math_g2_s', title: '人教版·二年级数学上册', subject: 'math', subjectName: '数学', grade: '二年级', term: '上学期', version: '人教版', source: 'seed', units: [{ order: 1, name: '长度单位', keywords: ['厘米'] }], createdAt: 1001, updatedAt: 1001 });
  db.collection(TB).add({ openid: OTHER, textbookId: 'tb_other_1', title: '别人的教材', subject: 'math', subjectName: '数学', grade: '一年级', term: '上学期', version: '人教版', source: 'upload', units: [{ order: 1, name: '私密单元' }], createdAt: 1002, updatedAt: 1002 });

  console.log('== 1. saveTextbook ==');
  const r1 = await M.saveTextbook(app, { textbook: {
    title: '北师大·一年级数学上册', subject: 'math', grade: '一年级', term: '上学期', version: '北师大版',
    source: 'upload', rawText: '粘贴的目录原文',
    units: [{ name: '准备课', keywords: ['数一数', '比多少'] }, { name: '位置' }]
  } }, ME);
  ok(r1.ok, '新建保存成功');
  ok(!!r1.textbook.textbookId && r1.textbook.textbookId.indexOf('tb_') === 0, 'textbookId 自动生成（tb_ 前缀）');
  ok(r1.textbook.openid === ME, '返回体带 openid');
  ok(r1.textbook.subjectName === '数学', 'subjectName 补全');
  ok(r1.textbook.units.length === 2 && r1.textbook.units[0].order === 1 && r1.textbook.units[1].order === 2, 'units order 重排');
  const myId = r1.textbook.textbookId;
  const stored = db.coll(TB).find(d => d.textbookId === myId);
  ok(!!stored && stored.openid === ME, '落库记录归属本人');

  const r2 = await M.saveTextbook(app, { textbook: {
    textbookId: myId, title: '北师大·一年级数学上册（改）', subject: 'math', grade: '一年级', term: '上学期',
    units: [{ name: '准备课' }, { name: '位置' }, { name: '1-5的认识' }]
  } }, ME);
  ok(r2.ok, '带 textbookId 再存成功（更新路径）');
  ok(db.coll(TB).filter(d => d.textbookId === myId).length === 1, '更新不新增（仍 1 条）');
  ok(db.coll(TB).find(d => d.textbookId === myId).units.length === 3, 'units 已更新为 3 条');

  // 他人 textbookId 撞名：where 带 openid 匹配不到 → 走新建；且因 textbookId 全库唯一，换新 id 复制为自己的
  const rCollide = await M.saveTextbook(app, { textbook: {
    textbookId: 'tb_other_1', title: '伪装的他人教材', subject: 'math', grade: '一年级', units: [{ name: 'x' }]
  } }, ME);
  ok(rCollide.ok, '撞名保存仍成功（不报唯一键错误）');
  ok(rCollide.textbook.textbookId !== 'tb_other_1', '撞名时为自己生成新 textbookId');
  ok(db.coll(TB).find(d => d.textbookId === 'tb_other_1').title === '别人的教材', '他人教材不被异地更新（隔离）');
  ok(db.coll(TB).filter(d => d.textbookId === 'tb_other_1').length === 1, '他人 textbookId 仍唯一（未产生重复键文档）');

  const r3 = await M.saveTextbook(app, { textbook: { title: 'x', subject: 'math' } }, ME);
  ok(!r3.ok && r3.code === 'no_units', '缺 units 拒绝');
  const r4 = await M.saveTextbook(app, { textbook: { title: 'x', subject: 'nope', units: [{ name: 'u' }] } }, ME);
  ok(!r4.ok && r4.code === 'bad_subject', '未知学科拒绝');

  console.log('== 2. listTextbooks ==');
  const l1 = await M.listTextbooks(app, ME, {});
  ok(l1.ok, '列表查询成功');
  ok(l1.official.length === 2, '官方库 2 条（openid="" 全员可见）');
  ok(l1.mine.length === 2, '我的库 2 条（新建+改题各 1，不含他人的）');
  ok(l1.mine.every(x => x.textbookId !== 'tb_other_1'), '他人库不混入');
  ok(l1.official[0].unitCount === 1, 'brief 含 unitCount');
  const l2 = await M.listTextbooks(app, ME, { subject: 'math', grade: '一年级' });
  ok(l2.ok && l2.official.length === 1 && l2.official[0].textbookId === 'tb_seed_math_g1_s', '按学科+年级筛选生效');
  const l3 = await M.listTextbooks(app, ME, { grade: '三年级' });
  ok(l3.ok && l3.official.length === 0 && l3.mine.length === 0, '无匹配时返回空列表');
  const l4 = await M.listTextbooks(app, '', {});
  ok(l4.ok && l4.official.length === 2 && l4.mine.length === 0, '未登录 openid 只见官方库');

  console.log('== 3. getTextbook ==');
  const g1 = await M.getTextbook(app, ME, 'tb_seed_math_g1_s');
  ok(g1.ok && g1.textbook.units.length === 1, '官方种子可读全文');
  const g2 = await M.getTextbook(app, ME, 'tb_other_1');
  ok(!g2.ok && g2.code === 'forbidden', '他人教材 forbidden');
  const g3 = await M.getTextbook(app, OTHER, 'tb_other_1');
  ok(g3.ok, '本人可读自己的');
  const g4 = await M.getTextbook(app, ME, 'tb_not_exist');
  ok(!g4.ok && g4.code === 'not_found', '不存在 not_found');
  const g5 = await M.getTextbook(app, ME, '');
  ok(!g5.ok && g5.code === 'no_id', '空 id no_id');

  console.log('== 4. deleteTextbook ==');
  const d1 = await M.deleteTextbook(app, ME, myId);
  ok(d1.ok && d1.removed === true, '删本人教材成功');
  ok(!db.coll(TB).find(d => d.textbookId === myId), '库中已移除');
  const d2 = await M.deleteTextbook(app, ME, 'tb_other_1');
  ok(d2.ok && d2.removed === false, '删他人教材 removed=false（where 带 openid 匹配不到）');
  ok(!!db.coll(TB).find(d => d.textbookId === 'tb_other_1'), '他人教材仍在（隔离）');
  const d3 = await M.deleteTextbook(app, ME, 'tb_seed_math_g1_s');
  ok(d3.ok && d3.removed === false, '官方种子删不掉（隔离铁律）');
  const d4 = await M.deleteTextbook(app, ME, '');
  ok(!d4.ok && d4.code === 'no_id', '空 id 拒绝');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试执行异常：', e); process.exit(1); });

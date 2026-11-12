/* examService 教材库 normalizeTextbook 单测（EXAM_TEST 纯逻辑模式，不依赖云 SDK）
 * 运行：node scripts/test-exam-textbook.cjs
 * 覆盖：正常路径 / 坏结构 / 超长 / 空 units 全部拒绝 / 种子数据 164 套全量回归 */
process.env.EXAM_TEST = '1';
const fs = require('fs');
const path = require('path');
const { normalizeTextbook, SUBJECT_NAMES } = require('../cloudfunctions/examService/index.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

console.log('== 1. 正常路径 ==');
const good = {
  title: '人教版·一年级数学上册', subject: 'math', grade: '一年级', term: '上学期', version: '人教版',
  source: 'upload', rawText: '第一单元 准备课\n第二单元 位置',
  units: [
    { name: '准备课', keywords: ['数一数', '比多少'], sections: ['数一数', '比多少'] },
    { name: '位置', keywords: ['上上下下', '前后左右', '左左右右'] },
    { name: '1-5的认识', lessons: '第1-3课时' }
  ]
};
const r1 = normalizeTextbook(good);
ok(r1.ok, '合法输入通过');
ok(r1.textbook && r1.textbook.subjectName === '数学', 'subjectName 按 SUBJECT_NAMES 自动补全');
ok(r1.textbook.units.length === 3 && r1.textbook.units[0].order === 1 && r1.textbook.units[2].order === 3, 'order 按输入顺序从 1 重排');
ok(r1.textbook.units[0].keywords.length === 2 && r1.textbook.units[0].sections.length === 2, 'keywords/sections 原样保留');
ok(r1.textbook.units[2].lessons === '第1-3课时', '可选 lessons 保留');
ok(r1.textbook.source === 'upload', 'source 白名单值原样通过');
ok(r1.textbook.textbookId === '', 'textbookId 缺省为空串（由 saveTextbook 补）');
ok(r1.textbook.grade === '一年级' && r1.textbook.term === '上学期', 'grade/term 保留');

console.log('== 2. 拒绝路径（坏结构/空/未知学科） ==');
ok(!normalizeTextbook(null).ok, 'null 拒绝');
ok(!normalizeTextbook(undefined).ok, 'undefined 拒绝');
ok(!normalizeTextbook({}).ok, '空对象拒绝');
ok(normalizeTextbook({ title: 'x', subject: 'math', units: [{ name: 'u' }] }).textbook.source === 'manual', 'source 缺省回落 manual');
ok(!normalizeTextbook({ title: 'x', subject: 'math', units: [{ name: 'u' }] }).ok === false, '合法最小结构应通过');
ok(normalizeTextbook({ title: 'x', subject: 'fly', units: [{ name: 'u' }] }).code === 'bad_subject', '未知学科 bad_subject');
ok(normalizeTextbook({ subject: 'math', units: [{ name: 'u' }] }).code === 'no_title', '空 title no_title');
ok(normalizeTextbook({ title: 'x', subject: 'math' }).code === 'no_units', '缺 units no_units');
ok(normalizeTextbook({ title: 'x', subject: 'math', units: [] }).code === 'no_units', '空 units no_units');
ok(normalizeTextbook({ title: 'x', subject: 'math', units: 'not-array' }).code === 'no_units', 'units 非数组 no_units');
ok(normalizeTextbook({ title: 'x', subject: 'math', units: [{ name: '' }] }).code === 'bad_unit', '单元名空 bad_unit');
ok(normalizeTextbook({ title: 'x', subject: 'math', units: [null] }).code === 'bad_unit', '单元为 null bad_unit');

console.log('== 3. 超限截断（不拒绝，削到边界内） ==');
const many = [];
for (let i = 0; i < 35; i++) many.push({ name: 'u' + i });
const r2 = normalizeTextbook({ title: 'x', subject: 'math', units: many });
ok(!r2.ok && r2.code === 'too_many_units', 'units>30 拒绝 too_many_units');
const exactly30 = [];
for (let i = 0; i < 30; i++) exactly30.push({ name: 'u' + i });
ok(normalizeTextbook({ title: 'x', subject: 'math', units: exactly30 }).ok, 'units=30 边界通过');
const kw = [];
for (let i = 0; i < 12; i++) kw.push('k' + i);
const sec = [];
for (let i = 0; i < 25; i++) sec.push('s' + i);
const r3 = normalizeTextbook({ title: 'x', subject: 'math', units: [{ name: 'u', keywords: kw, sections: sec }] });
ok(r3.ok && r3.textbook.units[0].keywords.length === 8, 'keywords 截断到 8');
ok(r3.ok && r3.textbook.units[0].sections.length === 20, 'sections 截断到 20');
const r4 = normalizeTextbook({ title: 'A'.repeat(100), subject: 'math', units: [{ name: 'u' }] });
ok(r4.ok && r4.textbook.title.length === 60, 'title 截断到 60 字');
const r5 = normalizeTextbook({ title: 'x', subject: 'math', units: [{ name: 'B'.repeat(80) }] });
ok(r5.ok && r5.textbook.units[0].name.length === 40, 'unit.name 截断到 40 字');
const r6 = normalizeTextbook({ title: 'x', subject: 'math', units: [{ name: 'u' }], rawText: 'C'.repeat(50000) });
ok(r6.ok && r6.textbook.rawText.length === 20000, 'rawText 截断到 20000 字');
const r7 = normalizeTextbook({ title: 'x', subject: 'math', units: [{ name: 'u', keywords: ['', '  ', null, 'ok'] }] });
ok(r7.ok && r7.textbook.units[0].keywords.length === 1 && r7.textbook.units[0].keywords[0] === 'ok', 'keywords 空值过滤');
const r8 = normalizeTextbook({ title: '  spaced title  ', subject: ' math ', units: [{ name: '  u  ' }] });
ok(r8.ok && r8.textbook.title === 'spaced title' && r8.textbook.subject === 'math' && r8.textbook.units[0].name === 'u', '首尾空白清洗');

console.log('== 4. 种子数据全量回归（164 套） ==');
const seedPath = path.join(__dirname, '..', 'scripts', 'textbook-pipeline', 'dist', 'textbook_seed.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
let seedOk = 0, seedFail = [];
for (const t of seed.textbooks) {
  const r = normalizeTextbook(t);
  if (r.ok) seedOk++;
  else seedFail.push((t._id || '?') + ' -> ' + r.code + ' ' + r.msg);
}
ok(seedFail.length === 0, '全部种子通过 normalizeTextbook' + (seedFail.length ? '（失败 ' + seedFail.length + ' 条）' : ''));
if (seedFail.length) seedFail.slice(0, 10).forEach(f => console.log('    - ' + f));
ok(SUBJECT_NAMES.science === '科学', 'SUBJECT_NAMES 含 science（种子库小学科学）');
console.log('    种子通过 ' + seedOk + '/' + seed.textbooks.length);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);

/* 教材库页纯逻辑单测（textbookLibModel，不依赖 wx）
 * 运行：node scripts/test-textbook-lib-model.cjs
 * 覆盖：draft⇄form 互转（含剔除/截断语义）、validateForm 与云端 normalizeTextbook 同口径、
 *       groupList 分组、来源标签、学科枚举 */
const M = require('../miniprogram/utils/textbookLibModel.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

console.log('== 1. 学科与来源枚举 ==');
ok(M.SUBJECT_KEYS.length === 10 && M.SUBJECT_KEYS.indexOf('science') >= 0, '十学科含 science');
ok(M.subjectName('politics') === '道德与法治' && M.subjectName('nope') === 'nope', 'subjectName 映射');
ok(M.sourceLabel('seed') === '官方' && M.sourceLabel('upload') === '上传' && M.sourceLabel('search') === '搜索' && M.sourceLabel(undefined) === '上传', '来源标签（未知回落上传）');

console.log('== 2. formFromDraft → draftFromForm 互转 ==');
const draft = {
  textbookId: 'tb_x', title: '人教版·一年级数学上册', subject: 'math', subjectName: '数学',
  grade: '一年级', term: '上学期', version: '人教版', source: 'upload', sourceUrl: 'cloud://x.pdf',
  units: [
    { order: 1, name: '准备课', sections: ['数一数', '比多少'], keywords: ['数一数', '比多少'] },
    { order: 2, name: '位置', keywords: ['上下', '左右'] }
  ]
};
const form = M.formFromDraft(draft);
ok(form.title === draft.title && form.subject === 'math' && form.textbookId === 'tb_x', '表单字段透传');
ok(form.units.length === 2 && form.units[0].sectionsText === '数一数\n比多少', 'sections 折成换行文本');
ok(form.units[0].keywordsText === '数一数、比多少', 'keywords 折成顿号文本');
const back = M.draftFromForm(form);
ok(back.title === draft.title && back.units.length === 2, '互转后字段不丢');
ok(back.units[0].sections[0] === '数一数' && back.units[0].keywords.length === 2, '文本拆回数组');
ok(back.textbookId === 'tb_x' && back.sourceUrl === 'cloud://x.pdf', 'textbookId/sourceUrl 保留（更新路径）');
ok(!('openid' in back) && !('subjectName' in back), '不把云端归属/派生字段带回（防越权写）');

console.log('== 3. draftFromForm 清洗语义 ==');
const dirty = M.draftFromForm({
  title: '  书名  ', subject: 'math', grade: ' 一年级 ', version: '', term: '',
  units: [
    { name: ' 第一单元 ', sectionsText: ' 数一数 \n\n  比多少 \n', keywordsText: ' 数一数、比多少，，' },
    { name: '   ', sectionsText: '小节', keywordsText: '' },
    { name: '第三单元', sectionsText: '', keywordsText: '' }
  ]
});
ok(dirty.units.length === 2, '空名单元被剔除');
ok(dirty.units[0].name === '第一单元' && dirty.grade === '一年级' && dirty.title === '书名', '首尾空白清洗');
ok(dirty.units[0].sections.length === 2 && dirty.units[0].sections[1] === '比多少', 'sections 空行剔除+trim');
ok(dirty.units[0].keywords.length === 2, 'keywords 空段剔除（顿号/逗号/分号切分）');
ok(!('sections' in dirty.units[1]), '空 sections 不带空数组字段');

console.log('== 4. validateForm（与云端 normalizeTextbook 同口径） ==');
ok(M.validateForm({ title: 'x', subject: 'math', units: [{ name: 'u' }] }).ok, '最小合法通过');
ok(!M.validateForm({ title: '', subject: 'math', units: [{ name: 'u' }] }).ok, '空标题拒');
ok(!M.validateForm({ title: 'x', subject: 'nope', units: [{ name: 'u' }] }).ok, '未知学科拒');
ok(!M.validateForm({ title: 'x', subject: 'math', units: [] }).ok, '无单元拒');
ok(!M.validateForm({ title: 'x', subject: 'math', units: [{ name: '' }] }).ok, '只有空名单元拒');
const many = []; for (let i = 0; i < 31; i++) many.push({ name: 'u' + i });
ok(!M.validateForm({ title: 'x', subject: 'math', units: many }).ok, '超 30 单元拒');
ok(M.validateForm({ title: 'x', subject: 'science', units: [{ name: 'u' }] }).ok, 'science 学科通过');

console.log('== 5. groupList ==');
const g = M.groupList({
  official: [{ textbookId: 'tb_seed_1', title: '人教版·一年级数学上册', subject: 'math', subjectName: '数学', grade: '一年级', unitCount: 5, source: 'seed', updatedAt: 1 }],
  mine: [{ textbookId: 'tb_mine_1', title: '我的教材', subject: 'math', subjectName: '数学', unitCount: 3, source: 'upload', updatedAt: 2 }]
});
ok(g.official.length === 1 && g.official[0].isOfficial === true && g.official[0].sourceLabel === '官方', '官方组标记正确');
ok(g.mine.length === 1 && g.mine[0].isOfficial === false && g.mine[0].sourceLabel === '上传', '我的组标记正确');
ok(g.mine[0].unitCount === 3, 'unitCount 透传');
const g2 = M.groupList(null);
ok(g2.official.length === 0 && g2.mine.length === 0, '空响应安全');

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);

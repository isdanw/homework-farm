/**
 * workbench knowledgePoints → homework-farm tutor_unit_kps 转换器单测
 * 运行：node scripts/test-workbench-kp-import.cjs
 * 覆盖：KP 模式 / 大纲模式 / 空输入 / 不可识别 / point 内部去重 / 学科映射 / synthetic 警告
 */
const assert = require('assert');
const path = require('path');
const conv = require('../miniprogram/utils/workbenchKpImport.js');
const sampleKps = require('../miniprogram/utils/workbenchKpImport.sample.json');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n── A. KP 模式（5 条 synthetic 演示）──');
const rA = conv.convert(sampleKps);
ok('ok=true', rA.ok === true, JSON.stringify(rA.error));
ok('mode=kp', rA.mode === 'kp');
ok('单元数=5', rA.units.length === 5, 'got ' + rA.units.length);
ok('必会点数=5', rA.stats.points === 5, 'got ' + rA.stats.points);
const mathUnit = rA.units.find(u => u.subject === 'math');
ok('mathematics→math 映射', !!mathUnit);
ok('unitId=wb_math_7_kp', mathUnit && mathUnit.id === 'wb_math_7_kp', mathUnit && mathUnit.id);
ok('grade K7→7', mathUnit && mathUnit.grade === '7', mathUnit && mathUnit.grade);
ok('数学单元含 1 点', mathUnit && mathUnit.points.length === 1);
const mp = mathUnit && mathUnit.points[0];
ok('point.id=slug(ref)', mp && mp.id === 'mathematics_kp_rational_numbers_curriculum_v1', mp && mp.id);
ok('topic=canonicalName', mp && mp.topic.indexOf('有理数') === 0, mp && mp.topic);
ok('front 模板化', mp && mp.front.indexOf('能说出「') === 0, mp && mp.front);
ok('synthetic 警告存在', rA.warnings.some(w => w.indexOf('synthetic') >= 0));
ok('5 单元各带 synthetic 警告', rA.warnings.filter(w => w.indexOf('synthetic') >= 0).length === 5, 'got ' + rA.warnings.filter(w => w.indexOf('synthetic') >= 0).length);
ok('内置学科(math/english/bio/history/geo)不触发「无内置导学」', !rA.warnings.some(w => w.indexOf('无内置导学') >= 0));

console.log('\n── B. 大纲模式（RawCurriculum，一年级数学，2 章 3 节）──');
const cur = {
  version: 'pep-v1', subject: 'mathematics', grade: '1', title: '一年级上册',
  source: 'demo', lastVerified: '2026-01-01',
  nodes: [
    { nodeId: 'ch1', title: '准备课', level: 1, order: 1 },
    { nodeId: 'ch1-s1', title: '数一数', level: 2, parentId: 'ch1', order: 1 },
    { nodeId: 'ch1-s2', title: '比多少', level: 2, parentId: 'ch1', order: 2 },
    { nodeId: 'ch2', title: '位置', level: 1, order: 2 },
    { nodeId: 'ch2-s1', title: '上、下、前、后', level: 2, parentId: 'ch2', order: 1 }
  ]
};
const rB = conv.convert([cur]);
ok('ok=true', rB.ok === true, rB.error);
ok('mode=curriculum', rB.mode === 'curriculum');
ok('单元数=1（一教材一单元）', rB.units.length === 1, 'got ' + rB.units.length);
ok('grade 1→1', rB.units[0].grade === '1', rB.units[0].grade);
ok('unitId=wb_math_1_pep_v1', rB.units[0].id === 'wb_math_1_pep_v1', rB.units[0].id);
ok('只取 level-2 节（3 点，章有子节点不重复）', rB.units[0].points.length === 3, 'got ' + rB.units[0].points.length);
ok('title 含 年级·学科·教材', rB.units[0].title.indexOf('1年级·数学·一年级上册') === 0, rB.units[0].title);

console.log('\n── C. 单对象 RawCurriculum（自动包成数组）──');
const rC = conv.convert(cur);
ok('ok=true', rC.ok === true, rC.error);
ok('单元数=1', rC.units.length === 1);

console.log('\n── D. 空 / 不可识别输入（防御）──');
const rD1 = conv.convert(null);
ok('null → ok=false', rD1.ok === false);
const rD2 = conv.convert([]);
ok('[] → ok=false', rD2.ok === false);
const rD3 = conv.convert([{ foo: 1 }]);
ok('无 knowledgePointRef/nodes → ok=false', rD3.ok === false, rD3.error);

console.log('\n── E. point 内部去重（同 ref 碰撞）──');
const rE = conv.convert([
  { knowledgePointRef: 'x:same@v1', name: 'A', canonicalName: 'A', subjectId: 'math', stage: 'K1' },
  { knowledgePointRef: 'x:same@v1', name: 'A', canonicalName: 'A', subjectId: 'math', stage: 'K1' }
]);
ok('同 ref 两 KP → 2 点（不同 id）', rE.units[0].points.length === 2, 'got ' + rE.units[0].points.length);
ok('id 去重追加 _2', rE.units[0].points[1].id === 'x_same_v1_2', rE.units[0].points[1].id);

console.log('\n── F. 学科透传（未在内置映射）──');
const rF = conv.convert([
  { knowledgePointRef: 'cs:kp@v1', name: '编程', canonicalName: '编程基础', subjectId: 'computerscience', stage: 'K7' }
]);
ok('未知学科原样透传', rF.units[0].subject === 'computerscience', rF.units[0].subject);
ok('透传学科警告', rF.warnings.some(w => w.indexOf('无内置导学') >= 0));

console.log('\n──────── 结果：通过 ' + pass + ' / ' + (pass + fail) + (fail ? '  ✗ 有失败' : '  ✓ 全部通过') + ' ────────');
process.exit(fail ? 1 : 0);

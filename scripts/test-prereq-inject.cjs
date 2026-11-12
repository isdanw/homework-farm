#!/usr/bin/env node
/**
 * 依赖归因注入回归测试（2026-10-27 · Path A S4）
 *
 * 锁住三个出题/计划入口的「依赖边注入」行为：
 *   buildBlindSpotHint  —— 出题盲区提示（前置欠账）
 *   unitTypeHint        —— 单元复习题型约束（语文不再套「计算」）
 *   buildPrereqBlock    —— 学习计划依赖边块（先补前置）
 * 跑真实源码（EXAM_TEST 模式），断言纯函数输出。退出码非 0 即失败。
 */
'use strict';

const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const EXAM = path.join(REPO, 'cloudfunctions', 'examService', 'index.js');
const PLAN = path.join(REPO, 'cloudfunctions', 'studyPlanGen', 'index.js');

let fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

// 桩掉 @cloudbase/node-sdk（EXAM_TEST 下 examService 本就不 require 它，保险起见）
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@cloudbase/node-sdk') return { init: () => ({}) };
  return origLoad.apply(this, arguments);
};

process.env.EXAM_TEST = '1';
const exam = require(EXAM);
const plan = require(PLAN);

console.log('依赖归因注入回归测试（Path A S4）');

/* ---------------------------------------------------------------- */
section('一、buildBlindSpotHint：前置欠账 → 优先出题提示');
let hint = exam.buildBlindSpotHint([
  { topic: '凑十法', prereqs: [{ topic: '10的组成', strength: 'hard' }, { topic: '分与合', strength: 'hard' }] },
  { topic: '8/7/6加几', prereqs: [{ topic: '凑十法', strength: 'hard' }] }
], [
  { topic: '分与合', done: true },
  { topic: '10的组成', done: false }
]);
ok(typeof hint === 'string' && hint.includes('凑十法') && hint.includes('10的组成'), '凑十法缺「10的组成」被列出');
ok(!hint.includes('分与合'), '已达标的前置「分与合」不误报');
ok(hint.includes('8/7/6加几'), '8/7/6加几 缺「凑十法」也被列出');

section('  └ 无欠账 → 返回空串（零回归）');
ok(exam.buildBlindSpotHint([{ topic: 'a', prereqs: [{ topic: 'b', strength: 'hard' }] }], [{ topic: 'b', done: true }]) === '', '全部前置达标 → 空串');
ok(exam.buildBlindSpotHint([], []) === '', '空点 → 空串');

/* ---------------------------------------------------------------- */
section('二、unitTypeHint：语文按单元内容分题型，不再套「计算」');
ok(exam.unitTypeHint('math', '', []) .includes('计算'), '数学仍含「计算」');
const pinyin = exam.unitTypeHint('chinese', '第二单元·汉语拼音', ['单韵母', '声母']);
ok(pinyin.includes('拼音题型') && pinyin.includes('选择正确读音'), '拼音单元：拼音题型、选择读音');
const shizi = exam.unitTypeHint('chinese', '第六单元·识字', ['偏旁部首']);
ok(shizi.includes('识字') && !shizi.includes('计算'), '识字单元：识字题型、不含计算');
const yuedu = exam.unitTypeHint('chinese', '第五单元·阅读', ['朗读课文']);
ok(yuedu.includes('阅读') && !yuedu.includes('计算'), '阅读单元：阅读题型、不含计算');

/* ---------------------------------------------------------------- */
section('三、buildPrereqBlock：学习计划依赖边注入');
const block = plan.__test.buildPrereqBlock([
  { points: [
    { topic: '凑十法', prereqs: [{ topic: '10的组成', strength: 'hard', reason: 'x' }] },
    { topic: '朗读课文', prereqs: [{ topic: '两拼音节', strength: 'soft', reason: 'y' }] }
  ] }
]);
ok(typeof block === 'string' && block.includes('凑十法') && block.includes('10的组成'), '硬依赖边被列出');
ok(block.includes('必须先会'), 'hard → 标注「必须先会」');
ok(block.includes('建议先会'), 'soft → 标注「建议先会」');
ok(plan.__test.buildPrereqBlock([]) === '', '空 units → 空串（零回归）');
ok(plan.__test.buildPrereqBlock([{ points: [{ topic: 'a', prereqs: [] }] }]) === '', '无 prereqs → 空串');

/* ---------------------------------------------------------------- */
section('四、buildUserPrompt 注入顺序（依赖边在编排要求之前）');
const up = plan.__test.buildUserPrompt({ subject: '数学', grade: '一年级', term: '上学期', textbook: '人教版', planPrompt: '按默认' }, '', '', '【知识点依赖】X');
ok(up.includes('【知识点依赖】X'), '依赖边块注入 user prompt');
ok(up.indexOf('【知识点依赖】') < up.indexOf('编排要求'), '依赖边在编排要求之前');

/* ---------------------------------------------------------------- */
section('五、buildWeaknessBlock：学情薄弱点（P1）');
const w = plan.__test.buildWeaknessBlock(
  [{ topic: '凑十法', errorType: 'E2', status: 'pending' }, { topic: '已订正', status: 'corrected' }],
  [{ topic: '10的组成', done: false }, { topic: '分与合', done: true }]
);
ok(w.includes('凑十法') && w.includes('E2'), '未订正错题被列出（含错因）');
ok(!w.includes('已订正'), '已订正错题不列');
ok(w.includes('10的组成'), '未毕业卡主题被列出');
ok(!w.includes('分与合'), '已毕业卡主题不列');
ok(plan.__test.buildWeaknessBlock([], []) === '', '空 → 空串（零回归）');

/* ---------------------------------------------------------------- */
section('六、buildGenUser P0：unitKps 知识点优先于 GEN_TOPICS');
const u1 = exam.buildGenUser({ subject: 'math', grade: '一年级', scope: {}, unitKpTopics: ['凑十法', '10的组成'] });
ok(u1.includes('必会知识点') && u1.includes('凑十法'), '有 unitKpTopics → 注入必会知识点');
ok(!u1.includes('本年级重点'), '有 unitKpTopics → 不注入 GEN_TOPICS 年级重点（降级）');
const u2 = exam.buildGenUser({ subject: 'math', grade: '一年级', scope: {} });
ok(u2.includes('本年级重点'), '无 unitKpTopics → 回退 GEN_TOPICS 年级重点');

/* ---------------------------------------------------------------- */
section('七、kpId 匹配（P2）：全局 kpId 优先于 topic');
const h2 = exam.buildBlindSpotHint(
  [{ topic: '凑十法', kpId: 'math-g1s-u5::p20', prereqs: [{ topic: '10的组成', kpId: 'math-g1s-u2::p13' }] }],
  [{ topic: '名字对不上', unitId: 'math-g1s-u2', kpId: 'p13', done: true }]
);
ok(h2 === '', 'kpId 匹配成功（topic 不同也判达标）→ 无盲区');
const h3 = exam.buildBlindSpotHint(
  [{ topic: '凑十法', prereqs: [{ topic: '10的组成' }] }],
  [{ topic: '10的组成', done: true }]
);
ok(h3 === '', '无 kpId 旧数据 fallback topic → 判达标');
const h4 = exam.buildBlindSpotHint(
  [{ topic: '凑十法', kpId: 'math-g1s-u5::p20', prereqs: [{ topic: '10的组成', kpId: 'math-g1s-u2::p13' }] }],
  [{ topic: '10的组成', unitId: 'math-g1s-u9', kpId: 'p13', done: true }]
);
ok(h4.includes('凑十法'), 'kpId 单元不同（u2 vs u9）→ 不误判达标，仍报欠账');

/* ---------------------------------------------------------------- */
section('八、题型库 buildTypeLibBlock：真实题型模板');
const mt = exam.buildTypeLibBlock('math', '一年级');
ok(mt.includes('口算') && mt.includes('看图列式') && mt.includes('解决问题'), '数学一年级含口算/看图列式/解决问题');
ok(mt.includes('type=calc'), '题型映射到 QuestionType（calc）');
ok(!mt.includes('竖式'), '一年级数学不含竖式（那是二年级，防超纲）');
const ct = exam.buildTypeLibBlock('chinese', '一年级');
ok(ct.includes('看拼音写词语') && ct.includes('笔顺笔画') && ct.includes('看图写话'), '语文一年级含看拼音写词语/笔顺/看图写话');
ok(ct.includes('选择正确读音'), '语文含选择正确读音');
ok(exam.buildTypeLibBlock('math', '六年级') === '', '未配题型的年级 → 空串（零回归）');
ok(exam.QUESTION_TYPES.math['一年级'].length === 10, '数学一年级题型库 10 种');
ok(exam.QUESTION_TYPES.chinese['一年级'].length === 13, '语文一年级题型库 13 种');

/* ---------------------------------------------------------------- */
section('九、题型配比 normTypeMix / buildTypeMixBlock（iPad 接题型库）');
ok(Array.isArray(exam.normTypeMix('math', '一年级', null)) && exam.normTypeMix('math', '一年级', null).length === 0, '未传配比 → 空数组（回落整库）');
const mx = exam.normTypeMix('math', '一年级', [
  { name: '口算', count: 4 }, { name: '解决问题', count: 2 },
  { name: '自创题型', count: 5 }, { name: '口算', count: 3 }
]);
ok(mx.length === 2, '库外题型被丢弃 + 同名去重 → 只剩 2 项');
ok(mx[0].name === '口算' && mx[0].count === 4, '保留首次出现的口算×4（重复项不覆盖）');
ok(mx.every(t => t.hint && t.type), '配比项带出 hint 与 type（供 prompt 与 UI 复用）');
ok(exam.normTypeMix('math', '一年级', [{ name: '口算', count: 999 }])[0].count === 20, 'count 上限夹到 20');
ok(exam.normTypeMix('math', '一年级', [{ name: '口算', count: 0 }])[0].count === 1, 'count 下限夹到 1');
ok(exam.normTypeMix('english', '一年级', [{ name: '口算', count: 3 }]).length === 0, '无题型库的学科 → 空（零回归）');

const mixBlock = exam.buildTypeMixBlock('math', '一年级', [{ name: '口算', count: 4 }, { name: '解决问题', count: 2 }]);
ok(mixBlock.includes('共 6 题'), '配比块合计题数正确（4+2=6）');
ok(mixBlock.includes('口算 × 4 题') && mixBlock.includes('解决问题 × 2 题'), '配比块按「题型 × N 题」表述');
ok(mixBlock.includes('不得增减题型'), '配比块禁止 AI 自创/增减题型');
ok(!mixBlock.includes('看图列式'), '未指定的题型不出现在配比块（整库收窄为指定项）');
ok(exam.buildTypeMixBlock('math', '六年级', [{ name: '口算', count: 2 }]) === '', '无题型库年级传配比 → 空（回落整库，零回归）');
// 手写卷：强制全 draw，配比块不带 type 标记（避免 type=calc 与强制 draw 冲突）
const mixHand = exam.buildTypeMixBlock('math', '一年级', [{ name: '口算', count: 3 }], true);
ok(mixHand.includes('口算 × 3 题') && !mixHand.includes('type='), '手写卷配比块省略 type 标记');

section('  └ buildGenUser：配比优先于整库');
const ug = exam.buildGenUser({ subject: 'math', grade: '一年级', scope: { questionTypes: [{ name: '口算', count: 4 }] } });
ok(ug.includes('本次指定题型配比'), '传配比 → 用配比块');
ok(!ug.includes('本年级真实题型'), '传配比 → 不再叠加整库块（避免两套题型打架）');
const ug2 = exam.buildGenUser({ subject: 'math', grade: '一年级', scope: {} });
ok(ug2.includes('本年级真实题型'), '未传配比 → 仍用整库块');
const ug3 = exam.buildGenUser({ subject: 'math', grade: '一年级', scope: { mode: 'handwriting', questionTypes: [{ name: '口算', count: 3 }] } });
ok(ug3.includes('本次指定题型配比') && !ug3.includes('type=calc'), '手写卷 + 配比 → 配比生效且不带 type');

console.log('\n' + passes + ' 通过 / ' + fails + ' 失败');
process.exit(fails ? 1 : 0);

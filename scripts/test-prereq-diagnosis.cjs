#!/usr/bin/env node
/**
 * 前置欠账诊断引擎回归测试（2026-11-11）
 * 锁住：零回归 / 四步状态机 / roots / kpId 优先 / 难度四档 / 纯函数 / 证据隔离。
 * 跑真实源码（无 wx 依赖），退出码非 0 即失败。
 */
'use strict';

const path = require('path');
const D = require(path.resolve(__dirname, '..', 'miniprogram', 'utils', 'prereqDiagnosis.js'));

let fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

/** 连答 N 次，返回最终 session */
function answer(s, results) {
  results.forEach(r => { s = D.applyAnswer(s, r); });
  return s;
}
function yes(n) { return new Array(n).fill('correct'); }

/* 三点链：分与合 → 10的组成 → 凑十法（hard）；另挂一条 soft */
const POINTS = [
  { topic: '分与合', kpId: 'u1::p1', prereqs: [], assessmentPrompt: '4可以分成几和几？', back: '1和3' },
  { topic: '10的组成', kpId: 'u2::p2', prereqs: [{ topic: '分与合', kpId: 'u1::p1', strength: 'hard', reason: '先会分与合' }] },
  { topic: '凑十法', kpId: 'u3::p3', prereqs: [{ topic: '10的组成', kpId: 'u2::p2', strength: 'hard', reason: '先会10的组成' }] }
];

console.log('前置欠账诊断引擎回归测试');

/* ---------------------------------------------------------------- */
section('一、零回归：空输入');
let s0 = D.createSession({ points: [] });
ok(D.nextItem(s0) === null, '空 points → 无题可出');
let z = D.summarize(s0);
ok(z.roots.length === 0 && z.weak.length === 0 && z.shaky.length === 0, '空会话 → 三态全空');
ok(z.blindSpotHint === '' && z.e1e9Hint === '', '空会话 → 两个 hint 空串');
ok(z.isEvidence === false, '空会话 → isEvidence:false');
ok(D.summarize(D.createSession({ points: POINTS, targets: ['凑十法'] })).answerCount === 0, '未作答 → answerCount 0');

/* ---------------------------------------------------------------- */
section('二、证据隔离：confirm 默认 5，不叫掌握');
let s1 = D.createSession({ points: POINTS, targets: ['凑十法'] });
ok(s1.confirm === 5, 'confirm 默认 5（对齐 tutorRetest 五题口径，不是参考库的 3）');
let item1 = D.nextItem(s1);
ok(!!item1 && item1.topic === '凑十法', '首题问目标点');
ok(item1.isEvidence === false && item1.examDifficulty >= 1, '出题信号带 isEvidence:false 与难度档');
let s2 = answer(s1, yes(4));
ok(!D.summarize(s2).status['K:u3::p3'], '连对 4 题仍未推定掌握');
let s3 = D.applyAnswer(s2, 'correct');
let sum3 = D.summarize(s3);
ok(sum3.status['K:u3::p3'] && sum3.status['K:u3::p3'].s === 'provisionalMastered', '连对 5 题 → provisionalMastered（非 mastered）');
ok(sum3.status['K:u2::p2'] && sum3.status['K:u2::p2'].src === 'inferred', '祖先被推断，src=inferred');
ok(sum3.isEvidence === false && JSON.stringify(sum3).indexOf('"done"') < 0, '汇总不产证据、不出现 done 字段');
ok(sum3.provisionalMastered.length === 3, '目标 + 两级祖先共 3 点推定掌握');

/* ---------------------------------------------------------------- */
section('三、四步状态机：答错 → 基础确认题');
let a1 = D.createSession({ points: POINTS, targets: ['凑十法'] });
let a2 = D.applyAnswer(a1, 'wrong');
let aItem = D.nextItem(a2);
ok(aItem.phase === 'confirm', '首次答错 → 下一题是确认题');
ok(aItem.difficulty === 'basic' && aItem.examDifficulty === 1, '确认题强制回退 basic（难度 1）');
ok(!D.summarize(a2).status['K:u3::p3'], '首次答错不立刻下结论');

section('  └ 确认题答对 → shaky，不回溯');
let a3 = D.applyAnswer(a2, 'correct');
let sa = D.summarize(a3);
ok(sa.status['K:u3::p3'] && sa.status['K:u3::p3'].s === 'shaky', 'shaky（会但不稳）');
ok(sa.roots.length === 0 && sa.weak.length === 0, 'shaky 不算根因、不产生 weak');
ok(D.nextItem(a3) === null, '三点链里已无需再问的点（未回溯）');

section('  └ 确认题也错 → weak，沿 hard 先修回溯');
let b1 = D.createSession({ points: POINTS, targets: ['凑十法'] });
let b2 = answer(b1, ['wrong', 'wrong']);
let sb = D.summarize(b2);
ok(sb.status['K:u3::p3'] && sb.status['K:u3::p3'].s === 'weak', 'weak');
let bItem = D.nextItem(b2);
ok(!!bItem && bItem.topic === '10的组成', '回溯到最近的 hard 先修「10的组成」');

section('  └ hard 优先于 soft');
const MIX = [
  { topic: 'A', prereqs: [] },
  { topic: 'B', prereqs: [] },
  { topic: '目标', prereqs: [{ topic: 'A', strength: 'soft' }, { topic: 'B', strength: 'hard' }] }
];
let m = answer(D.createSession({ points: MIX, targets: ['目标'] }), ['wrong', 'wrong']);
ok(D.nextItem(m).topic === 'B', 'prereqs 声明顺序 soft 在前，回溯仍先问 hard 的 B');

/* ---------------------------------------------------------------- */
section('四、roots 根因：无 weak 先修的 weak 节点');
let c1 = D.createSession({ points: POINTS, targets: ['凑十法'] });
let c2 = answer(c1, ['wrong', 'wrong']);                 // 凑十法 weak → 回溯 10的组成
let c3 = answer(c2, ['wrong', 'wrong']);                 // 10的组成 weak → 回溯 分与合
let c4 = answer(c3, ['wrong', 'wrong']);                 // 分与合 weak
let sc = D.summarize(c4);
ok(sc.weak.length === 3, '链上三个点都 weak');
ok(sc.roots.length === 1 && sc.roots[0].topic === '分与合', '唯一根因 = 最底层的「分与合」');
ok(sc.path.length >= 3, 'path 覆盖根因及其后代');
ok(sc.blindSpotHint.includes('分与合') && sc.blindSpotHint.includes('诊断假设'), 'blindSpotHint 含根因且标注非证据');

section('  └ E1-E9 归因先验：只给提示，不改 errorType');
ok(sc.e1e9Hint.includes('E2') && sc.e1e9Hint.includes('前置根因'), '全 weak 场景：先验指向 E2 与根因归属，不出现 E1');
ok(!sc.e1e9Hint.includes('E1 '), '无 shaky 时不给 E1 审题先验');
ok(!/E10|E0/.test(sc.e1e9Hint), '不新增 E 编号');
ok(!('errorType' in sc) && sc.e1e9Hint.includes('不改 errorType'), '汇总不产 errorType 字段');
let shakyHint = D.summarize(answer(D.createSession({ points: POINTS, targets: ['凑十法'] }), ['wrong', 'correct'])).e1e9Hint;
ok(shakyHint.includes('E1') && shakyHint.includes('E7') && shakyHint.includes('E9'), 'shaky 走 E1/E7/E9 分支');
ok(!shakyHint.includes('不是本次粗心'), 'shaky 不给「概念不会」结论');

/* ---------------------------------------------------------------- */
section('五、kpId 优先（防跨单元撞名）');
const DUP = [
  { topic: '凑十法', kpId: 'uA::p1', prereqs: [] },
  { topic: '凑十法', kpId: 'uB::p9', prereqs: [{ topic: '10的组成', kpId: 'uB::p1', strength: 'hard' }] },
  { topic: '10的组成', kpId: 'uB::p1', prereqs: [] }
];
let d1 = D.createSession({ points: DUP, targets: [{ topic: '凑十法', kpId: 'uB::p9' }] });
ok(D.nextItem(d1).topicId === 'K:uB::p9', '按 kpId 精确定位，不用同名 topic');
let d2 = answer(d1, ['wrong', 'wrong']);
ok(D.nextItem(d2).topicId === 'K:uB::p1', '回溯也按 kpId，不误撞 uA 的同名点');
ok(D.refKey({ topic: 'X' }) === 'T:X' && D.refKey({ topic: 'X', kpId: 'u1::p1' }) === 'K:u1::p1', 'refKey 优先级正确');

/* ---------------------------------------------------------------- */
section('六、难度四档与闪卡梯度');
ok(D.DIFFICULTY_ORDER.join(',') === 'basic,standard,challenge,advanced', '四档顺序固定');
ok(D.pickDifficulty({ consecutiveCorrect: 0 }) === 'standard', '探针首题 standard');
ok(D.pickDifficulty({ consecutiveCorrect: 1 }) === 'challenge', '连对 1 次 → challenge');
ok(D.pickDifficulty({ consecutiveCorrect: 5 }) === 'advanced', '连对封顶 advanced');
ok(D.pickDifficulty({ consecutiveCorrect: 9, phase: 'confirm' }) === 'basic', '确认题无视连对数，强制 basic');
ok(D.toExamDifficulty('basic') === 1 && D.toExamDifficulty('challenge') === 2 && D.toExamDifficulty('advanced') === 3, '四档 → examService 1..3 保守映射');
ok(D.toExamDifficulty('unknown') === 1, '未知档兜底 1');
ok(D.pickDifficulty({ box: 1 }) === 'basic' && D.pickDifficulty({ box: 5 }) === 'challenge', '闪卡 box 决定起点档');
let seq = D.createSession({ points: POINTS, targets: ['凑十法'] });
const diffs = [];
for (let i = 0; i < 5; i++) { diffs.push(D.nextItem(seq).difficulty); seq = D.applyAnswer(seq, 'correct'); }
ok(diffs[0] === 'standard' && diffs[1] === 'challenge' && diffs[4] === 'advanced', '会话内难度随连对逐档上推');

const CARDS = [
  { id: 'c1', dueAt: 200, box: 5 }, { id: 'c2', dueAt: 100, box: 3 },
  { id: 'c3', dueAt: 100, box: 1 }, { id: 'c4', dueAt: 300, box: 1 }
];
const snap = JSON.stringify(CARDS);
const sorted = D.sortCardsForReview(CARDS);
ok(sorted.map(c => c.id).join(',') === 'c3,c2,c1,c4', 'dueAt 优先、同日 box 升序');
ok(JSON.stringify(CARDS) === snap, '排序不改原数组与卡对象');
ok(D.sortCardsForReview([]).length === 0, '空卡列表零回归');

/* ---------------------------------------------------------------- */
section('七、纯函数与边界');
const p1 = D.createSession({ points: POINTS, targets: ['凑十法'] });
const before = JSON.stringify(p1);
D.nextItem(p1); D.applyAnswer(p1, 'wrong'); D.summarize(p1);
ok(JSON.stringify(p1) === before, 'nextItem / applyAnswer / summarize 均不改入参');
ok(D.applyAnswer(p1, 'xxx') !== undefined, '非法 result 归一 skip，不抛错');
const limited = D.createSession({ points: POINTS, targets: ['凑十法'], limit: 2 });
ok(D.nextItem(answer(limited, ['correct', 'correct'])) === null, 'limit 生效，题量用尽返回 null');
ok(D.summarize(answer(limited, ['wrong', 'wrong'])).weak.length === 1, '题量用尽仍有未确认错误 → 按 weak 处理');
ok(D.createSession({ points: POINTS, targets: ['不存在的点'] }).stack.length === 0, '目标不存在 → 空栈，不造点');
ok(D.createSession({ points: [{ topic: 'A', prereqs: [{ topic: 'A', strength: 'hard' }] }], targets: ['A'] }).order.length === 1, '自环不死循环');

console.log('\n结果：' + passes + ' 通过 / ' + fails + ' 失败');
process.exit(fails ? 1 : 0);

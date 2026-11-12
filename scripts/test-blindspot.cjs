#!/usr/bin/env node
/**
 * 盲区诊断回归测试（2026-10-27 · Path A S3）
 *
 * 锁住 diagnoseBlindSpot 的行为：读必会库依赖边 + 复习卡毕业态，
 * 反查「前置欠账（missingPrereqs）」与「下游拖累（blocks）」。
 * 掌握度判据 = topic 下存在 done=true 的卡；无卡视为未达标。
 * 跑真实源码 + 桩 wx / store.js，退出码非 0 即失败。
 */
'use strict';

const path = require('path');
const Module = require('module');

const TUTOR = path.resolve(__dirname, '..', 'miniprogram', 'utils', 'tutorStore.js');

let fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

const mem = {};
global.wx = {
  getStorageSync(k) { return mem[k]; },
  setStorageSync(k, v) { mem[k] = v; },
  cloud: { callFunction() { return Promise.resolve({ result: { ok: true, added: 0 } }); } }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === './store.js') return { getOpenid: () => 'o_test_pathA' };
  return origLoad.apply(this, arguments);
};

const TS = require(TUTOR);

console.log('盲区诊断回归测试（Path A S3）');

function reset() { Object.keys(mem).forEach(k => delete mem[k]); }

// 依赖链：分与合 → (5内加法, 10的组成) → 凑十法 → 8/7/6加几
function seedUnit() {
  TS.upsertUnitKp({
    id: 'u_math_test', subject: 'math', grade: '一年级', title: '进位加测试',
    points: [
      { id: 'p1', order: 1, topic: '分与合', type: 'CONCEPTUAL', prereqs: [] },
      { id: 'p2', order: 2, topic: '5内加法', type: 'PROCEDURAL', prereqs: [{ topic: '分与合', strength: 'hard', reason: '加法是合' }] },
      { id: 'p3', order: 3, topic: '10的组成', type: 'CONCEPTUAL', prereqs: [{ topic: '分与合', strength: 'hard', reason: '凑十前提' }] },
      { id: 'p4', order: 4, topic: '凑十法', type: 'PROCEDURAL', prereqs: [
        { topic: '10的组成', strength: 'hard', reason: '凑十凑10' },
        { topic: '分与合', strength: 'hard', reason: '组成根' }
      ] },
      { id: 'p5', order: 5, topic: '8/7/6加几', type: 'PROCEDURAL', prereqs: [{ topic: '凑十法', strength: 'hard', reason: '算法迁移' }] }
    ]
  });
}
function card(id, topic, done) {
  TS.upsertCard({ id: id, subject: 'math', topic: topic, front: 'f', back: 'b', kpId: id, unitId: 'u_math_test', done: done, box: done ? 5 : 1 });
}

section('一、无该学科必会库 → 返回 null');
ok(TS.diagnoseBlindSpot('english') === null, 'english 无库 → null');

section('二、全部前置达标 → blindSpots 为空，mastery 全 true');
reset(); seedUnit();
card('c_fh', '分与合', true);
card('c_10', '10的组成', true);
card('c_5j', '5内加法', true);
card('c_10f', '凑十法', true);
card('c_876', '8/7/6加几', true);
let r = TS.diagnoseBlindSpot('math');
ok(!!r, '返回诊断结果');
ok(r.mastery.length === 5, 'mastery 覆盖 5 个点');
ok(r.mastery.every(m => m.mastered === true), '全部达标');
ok(r.blindSpots.length === 0, '无欠账 → blindSpots 空');

section('三、前置欠账 → missingPrereqs 正确列出未达标前置');
reset(); seedUnit();
card('c_fh2', '分与合', true);   // 只有分与合达标，其余无卡
r = TS.diagnoseBlindSpot('math');
ok(!r.blindSpots.find(b => b.topic === '5内加法'), '5内加法：无欠账且不被依赖 → 不进 blindSpots');
const spotCsf = r.blindSpots.find(b => b.topic === '凑十法');
ok(spotCsf && spotCsf.missingPrereqs.some(m => m.topic === '10的组成'), '凑十法 欠账含「10的组成」（未达标）');
ok(spotCsf && spotCsf.missingPrereqs.every(m => m.topic !== '分与合'), '凑十法 不欠「分与合」（已达标）');
const spot876 = r.blindSpots.find(b => b.topic === '8/7/6加几');
ok(spot876 && spot876.missingPrereqs.some(m => m.topic === '凑十法'), '8/7/6加几 欠账含「凑十法」');

section('四、下游拖累 → 未达标且被依赖的点，blocks 正确');
const spot10 = r.blindSpots.find(b => b.topic === '10的组成');
ok(spot10 && spot10.blocks.indexOf('凑十法') >= 0, '10的组成 的 blocks 含「凑十法」（下游拖累）');
ok(spot876 && spot876.blocks.length === 0, '8/7/6加几 是叶子，blocks 为空');

section('五、无卡（未记录）→ 视为未达标');
const m10 = r.mastery.find(m => m.topic === '10的组成');
ok(m10 && m10.mastered === false, '10的组成 无卡 → mastered=false');
const mfh = r.mastery.find(m => m.topic === '分与合');
ok(mfh && mfh.mastered === true, '分与合 有毕业卡 → mastered=true');

console.log('\n' + passes + ' 通过 / ' + fails + ' 失败');
process.exit(fails ? 1 : 0);

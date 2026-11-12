#!/usr/bin/env node
/**
 * unitKps 图谱字段回归测试（2026-10-27 · Path A S1）
 *
 * 【它锁住的是什么】
 * unitKps 的 point 新增 4 个图谱字段：type / prereqs / evidence / assessmentPrompt
 * （借鉴 Marble os-taxonomy 的知识节点建模，字段只增不改）。
 * 历史坑：tutorStore.upsertUnitKp / addUnitKpPoint 对 point 是**逐字段白名单**映射，
 * 新字段若不在 map 里显式透传，写入即被静默丢弃（换设备 pull 回来也丢）。
 *
 * 本测试跑真实源码 + 桩掉 wx / store.js，断言 upsert/add/update 往返后
 * 4 个字段不丢、prereqs 元素规整为 {topic,strength,reason}、旧格式 point 兼容。
 * 退出码非 0 即失败。
 */
'use strict';

const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const TUTOR = path.join(REPO, 'miniprogram', 'utils', 'tutorStore.js');

let fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

/* ---- 一、wx 桩：本地存储落到内存对象，云调用一律 resolve ---- */
const mem = {};
global.wx = {
  getStorageSync(k) { return mem[k]; },
  setStorageSync(k, v) { mem[k] = v; },
  cloud: { callFunction() { return Promise.resolve({ result: { ok: true, added: 0 } }); } }
};

/* ---- 二、桩掉 store.js（tutorStore 只用它的 getOpenid） ---- */
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './store.js') {
    return { getOpenid: () => 'o_test_pathA' };
  }
  return origLoad.apply(this, arguments);
};

const TS = require(TUTOR);

console.log('unitKps 图谱字段回归测试（Path A S1）');

/* ---------------------------------------------------------------- */
section('一、upsertUnitKp：新增图谱字段往返不丢');
let unit = TS.upsertUnitKp({
  id: 'u_math_1', subject: 'math', grade: '一年级', title: '20以内进位加法',
  points: [{
    id: 'p1', topic: '10以内加减', front: '3+5=?', back: '8', order: 1,
    type: 'PROCEDURAL',
    prereqs: [{ topic: '数数', strength: 'hard', reason: '先会数数' }, { topic: '', strength: 'soft', reason: '' }],
    evidence: ['能口算 3+5=8'],
    assessmentPrompt: '让 {{name}} 口算 3+5'
  }]
});
ok(!!unit, 'upsert 返回 unit');
const got = TS.getUnitKps('u_math_1');
ok(!!got, 'getUnitKps 读回该单元');
const p = got && got.points && got.points[0];
ok(p && p.type === 'PROCEDURAL', 'type 透传');
ok(p && p.assessmentPrompt === '让 {{name}} 口算 3+5', 'assessmentPrompt 透传（含 {{name}} 占位）');
ok(p && Array.isArray(p.evidence) && p.evidence[0] === '能口算 3+5=8', 'evidence 透传');
ok(p && Array.isArray(p.prereqs) && p.prereqs.length === 1, 'prereqs 空 topic 被过滤（2 条 → 1 条）');
ok(p && p.prereqs[0].topic === '数数' && p.prereqs[0].strength === 'hard' && p.prereqs[0].reason === '先会数数',
  'prereqs 元素规整为 {topic, strength, reason}');

/* ---------------------------------------------------------------- */
section('二、prereqs 非法 strength 归一 hard');
TS.upsertUnitKp({
  id: 'u2', subject: 'math', grade: '', title: 't',
  points: [{ id: 'p1', topic: 'a', prereqs: [{ topic: 'b', strength: 'xxx', reason: 'r' }] }]
});
let q = TS.getUnitKps('u2').points[0];
ok(q && q.prereqs[0].strength === 'hard', '非法 strength（xxx）→ 归一 hard');

/* ---------------------------------------------------------------- */
section('三、addUnitKpPoint：新点默认补全图谱字段');
TS.upsertUnitKp({ id: 'u3', subject: 'math', grade: '', title: 't', points: [] });
const np = TS.addUnitKpPoint('u3', { topic: '新点', front: 'f', back: 'b' });
ok(np && np.type === '' && Array.isArray(np.prereqs) && np.prereqs.length === 0 &&
  Array.isArray(np.evidence) && np.evidence.length === 0 && np.assessmentPrompt === '',
  '新点图谱字段默认空值（type="" / prereqs=[] / evidence=[] / assessmentPrompt=""）');

/* ---------------------------------------------------------------- */
section('四、updateUnitKpPoint：patch 改图谱字段，不动旧字段');
TS.upsertUnitKp({ id: 'u4', subject: 'math', grade: '', title: 't', points: [{ id: 'p1', topic: 'x', front: 'F', back: 'B', order: 1 }] });
const upd = TS.updateUnitKpPoint('u4', 'p1', { prereqs: [{ topic: '前置', strength: 'soft', reason: '先备' }], type: 'CONCEPTUAL' });
ok(upd === true, 'update 返回 true');
let p4 = TS.getUnitKps('u4').points[0];
ok(p4 && p4.front === 'F' && p4.back === 'B', 'front/back 未被误改（零回归）');
ok(p4 && p4.type === 'CONCEPTUAL', 'type 被更新');
ok(p4 && p4.prereqs.length === 1 && p4.prereqs[0].topic === '前置' && p4.prereqs[0].strength === 'soft',
  'prereqs 被更新（soft 保留，不误归 hard）');

/* ---------------------------------------------------------------- */
section('五、旧格式 point（无图谱字段）不报错，默认补空');
TS.upsertUnitKp({ id: 'u5', subject: 'math', grade: '', title: 't', points: [{ id: 'p1', topic: 'old', front: 'f', back: 'b', order: 1 }] });
let p5 = TS.getUnitKps('u5').points[0];
ok(p5 && p5.type === '' && Array.isArray(p5.prereqs) && Array.isArray(p5.evidence) && p5.assessmentPrompt === '',
  '旧 point 兼容：图谱字段补空值，不抛错');

console.log('\n' + passes + ' 通过 / ' + fails + ' 失败');
process.exit(fails ? 1 : 0);

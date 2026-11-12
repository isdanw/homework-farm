#!/usr/bin/env node
/**
 * 导入必会库到云端 tutor_unit_kps（Path A 种子数据，通用）
 *
 * 用法：node scripts/import-unitkps.cjs <json路径> [openid]
 *   json 路径：scripts/data/*-unitkps.json（如 math-g1s-unitkps.json / chinese-g1s-unitkps.json）
 *   openid 缺省用硬编码的家长账号。
 *
 * 幂等：按 openid + clientId 查重，已存在的单元跳过，重复跑不产生重复数据。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENV = 'workbuddy-d2gsgtfvmde5c9adf';
const OPENID = process.argv[3] || 'oCZ0P5Y13PfGJwo3L20L_J4ajixI';
const COLL = 'tutor_unit_kps';

const jsonPath = process.argv[2];
if (!jsonPath) { console.error('用法：node import-unitkps.cjs <json路径> [openid]'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'));

// P2：建立 topic → 全局 kpId 映射（kpId = unitId::pointId，全局唯一，跨单元引用）
const topicToKpId = {};
data.units.forEach(u => {
  (Array.isArray(u.points) ? u.points : []).forEach(p => {
    if (p && p.topic) topicToKpId[p.topic] = u.id + '::' + p.id;
  });
});

const now = Date.now();
const docs = data.units.map(u => ({
  openid: OPENID,
  clientId: u.id,
  subject: data.subject,
  subjectName: data.subjectName,
  grade: data.grade,
  title: u.title,
  points: (Array.isArray(u.points) ? u.points : []).map(p => Object.assign({}, p, {
    kpId: u.id + '::' + p.id,   // 全局知识点 ID（P2 锚）
    prereqs: (Array.isArray(p.prereqs) ? p.prereqs : []).map(r => Object.assign({}, r, {
      kpId: (r && r.topic && topicToKpId[r.topic]) || ''   // topic → 全局 kpId 回填
    }))
  })),
  createdAt: now,
  updatedAt: now
}));

function run(command) {
  const r = spawnSync('tcb', ['db', 'nosql', 'execute', '--envId', ENV, '--command', command, '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const out = (r.stdout || '').replace(/^-.*Executing command\.\.\.\s*/m, '').trim();
  try { return JSON.parse(out); } catch (e) { return null; }
}

// 1. 查重
const findCmd = JSON.stringify([{
  TableName: COLL, CommandType: 'QUERY',
  Command: JSON.stringify({
    find: COLL,
    filter: { openid: OPENID, clientId: { $in: docs.map(d => d.clientId) } }
  })
}]);
const existing = new Set();
const q = run(findCmd);
if (q && q.data && Array.isArray(q.data.results) && q.data.results[0]) {
  q.data.results[0].forEach(r => r && r.clientId && existing.add(r.clientId));
}

const toInsert = docs.filter(d => !existing.has(d.clientId));
if (!toInsert.length) {
  console.log('全部 ' + docs.length + ' 个单元已存在，跳过（幂等）。');
  process.exit(0);
}

// 2. 插入缺失的单元
const insCmd = JSON.stringify([{
  TableName: COLL, CommandType: 'INSERT',
  Command: JSON.stringify({ insert: COLL, documents: toInsert })
}]);
const r = run(insCmd);
const ins = r && r.data && r.data.results && r.data.results[0] && r.data.results[0][0];
const n = ins && ins.n && (ins.n.$numberInt !== undefined ? ins.n.$numberInt : ins.n);
if (ins && Number(n) > 0) {
  console.log('✓ 已插入 ' + toInsert.length + ' 个单元（' + data.subjectName + '）：' + toInsert.map(d => d.title).join('、'));
  console.log('  跳过 ' + existing.size + ' 个已存在。');
} else {
  console.error('✗ 插入失败：' + JSON.stringify(r));
  process.exit(1);
}

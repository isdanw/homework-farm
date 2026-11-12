#!/usr/bin/env node
/* 种子数据上传预处理：dist/textbook_seed.json → upload_batches/batch_NN.json
 * 1. 每条种子过 examService.normalizeTextbook（保证云端数据 === 代码契约，防绕过校验的脏数据）
 * 2. 补 textbookId（= 原 _id）、createdAt/updatedAt（真实时间戳，便于排序）
 * 3. _id 保留种子 id（tb_seed_*）→ 重复插入会撞唯一键，天然防重复导入
 * 4. 分 4 批落盘（每批 ≤ 45 条），供 tcb db nosql execute 逐批 INSERT
 * 运行：node scripts/textbook-pipeline/prep_upload.js
 */
process.env.EXAM_TEST = '1';
const fs = require('fs');
const path = require('path');
const { normalizeTextbook } = require('../../cloudfunctions/examService/index.js');

const DIST = path.join(__dirname, 'dist', 'textbook_seed.json');
const OUT_DIR = path.join(__dirname, 'upload_batches');
const BATCH = 45;

const seed = JSON.parse(fs.readFileSync(DIST, 'utf8'));
const now = Date.now();
const docs = [];
const rejects = [];

for (const t of seed.textbooks) {
  const r = normalizeTextbook(t);
  if (!r.ok) { rejects.push((t._id || '?') + ' -> ' + r.code + ' ' + r.msg); continue; }
  const d = r.textbook;
  d._id = t._id;                 // 保留种子 id 作为文档 _id
  d.textbookId = t._id;          // 业务键与 _id 一致
  d.openid = '';                 // 官方种子库：全员可见
  d.createdAt = now;
  d.updatedAt = now;
  // 种子溯源字段（normalizeTextbook 已收窄 sourcePlatform/sourceUrl；crawledAt/edition 原样带）
  d.crawledAt = String(t.crawledAt || '');
  if (t.edition) d.edition = String(t.edition).slice(0, 20);
  docs.push(d);
}

if (rejects.length) {
  console.error('有 ' + rejects.length + ' 条种子被 normalizeTextbook 拒绝，终止上传：');
  rejects.forEach(r => console.error('  - ' + r));
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
// 清掉旧批次，防混入
for (const f of fs.readdirSync(OUT_DIR)) {
  if (/^batch_\d+\.json$/.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));
}

const total = docs.length;
const batchCount = Math.ceil(total / BATCH);
for (let i = 0; i < batchCount; i++) {
  const slice = docs.slice(i * BATCH, (i + 1) * BATCH);
  const file = path.join(OUT_DIR, 'batch_' + String(i + 1).padStart(2, '0') + '.json');
  fs.writeFileSync(file, JSON.stringify(slice));
  console.log('批次 ' + (i + 1) + '/' + batchCount + '：' + slice.length + ' 条 → ' + path.basename(file) +
    '（' + (fs.statSync(file).size / 1024).toFixed(0) + ' KB）');
}
console.log('合计 ' + total + ' 条，零拒绝，批次目录：' + OUT_DIR);

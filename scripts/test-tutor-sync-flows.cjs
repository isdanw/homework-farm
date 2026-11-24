#!/usr/bin/env node
/**
 * test-tutor-sync-flows.cjs —— tutorSync 新开 flows 动作（P3b 整流 LWW 写回）
 * ===========================================================================
 *   node scripts/test-tutor-sync-flows.cjs
 *
 * 为什么单独测这一条（与 test-tutor-sync-orders.cjs 同思路）：
 *   push 是「只补缺」语义（clientId 已存在 → skip），承载不了 flows 的状态推进。
 *   flows 动作 = 整流 LWW 更新，规则与 webAdminWrite.writeKpFlows（P1）完全一致：
 *     字段白名单重建 doc、_id=flowId 幂等、per-flow LWW（updatedAt 大者胜、
 *     tie 取 reviewRound 大者）、通关只进不出。
 *   服务端只做事实记录：不推进状态、不判排期；learnerNo 跨家庭拒该条；
 *   flows 不进 push 的 collName / PUSH_LIMITS / sanitize（P3a 红线延续）。
 *
 * 反证：摘掉 updateFlows 的通关锁 / 孩子闸任一处，本文件必须变红（变异由手跑验证）。
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'cloudfunctions', 'tutorSync');
const OPENID = 'o_flow_family';
const NOW = '2026-11-24T10:00:00.000Z';

function matchWhere(row, where) {
  const w = where || {};
  return Object.keys(w).every((k) => row[k] === w[k]);
}
function deep(o) { return JSON.parse(JSON.stringify(o)); }

function createFakeSdk(seed) {
  const tables = {};
  const touched = {};
  let autoId = 0;
  function ensure(n) { if (!tables[n]) tables[n] = []; return tables[n]; }
  for (const k of Object.keys(seed || {})) {
    for (const row of seed[k]) {
      const r = deep(row);
      if (r._id === undefined) r._id = 'seed' + (++autoId);
      ensure(k).push(r);
    }
  }
  function collection(name) {
    let w = {}, order = null, lim = 100;
    const api = {
      where(q) { w = q || {}; return api; },
      orderBy(k, d) { order = { k, d }; return api; },
      limit(n) { lim = n; return api; },
      async count() { return { total: ensure(name).filter((r) => matchWhere(r, w)).length }; },
      async get() {
        let rows = ensure(name).filter((r) => matchWhere(r, w));
        if (order) {
          rows = rows.slice().sort((a, b) => order.d === 'desc'
            ? String(b[order.k] || '').localeCompare(String(a[order.k] || ''))
            : String(a[order.k] || '').localeCompare(String(b[order.k] || '')));
        }
        return { data: deep(rows.slice(0, lim)) };
      },
      async update(patch) {
        const rows = ensure(name).filter((r) => matchWhere(r, w));
        rows.forEach((r) => Object.assign(r, deep(patch)));
        touched[name] = true;
        return { updated: rows.length };
      },
      async add(obj) { const r = Object.assign({ _id: 'id' + (++autoId) }, deep(obj)); ensure(name).push(r); touched[name] = true; return { id: r._id }; },
      doc(id) {
        return {
          async get() {
            const row = ensure(name).find((r) => r._id === id);
            return { data: row ? deep(row) : null };
          },
          async update(patch) {
            const row = ensure(name).find((r) => r._id === id);
            if (row) { Object.assign(row, deep(patch)); touched[name] = true; }
            return { updated: row ? 1 : 0 };
          },
          async set(obj) {
            let row = ensure(name).find((r) => r._id === id);
            if (row) Object.assign(row, deep(obj));
            else ensure(name).push(Object.assign({ _id: id }, deep(obj)));
            touched[name] = true;
            return { updated: 1 };
          }
        };
      }
    };
    return api;
  }
  const app = { database: () => ({ collection, async createCollection(n) { ensure(n); } }) };
  return { sdk: { init: () => app }, tables, touched, rows: (n) => deep(tables[n] || []) };
}

function loadSync(seed) {
  const fake = createFakeSdk(seed);
  const orig = Module._load;
  Module._load = function (req) {
    if (req === '@cloudbase/node-sdk') return fake.sdk;
    return orig.apply(this, arguments);
  };
  for (const k of Object.keys(require.cache)) if (k.indexOf(DIR) === 0) delete require.cache[k];
  let mod;
  try { mod = require(path.join(DIR, 'index.js')); } finally { Module._load = orig; }
  return { main: mod.main, fake };
}

/** hw_farm_user 家庭档案：c1 老大 / c2 老二，currentUserId=c1 */
function familyRoot() {
  return [{ _id: 'u1', _openid: OPENID, data: { users: [{ id: 'c1', nickname: '老大' }, { id: 'c2', nickname: '老二' }], currentUserId: 'c1' } }];
}

function invoke(mod, event) {
  return mod.main(Object.assign({ userInfo: { openId: OPENID } }, event));
}

function flow(flowId, over) {
  return Object.assign({
    flowId: flowId, subject: 'mathematics', knowledgePoint: '退位减法',
    status: 'reviewing', step: 'review', reviewRound: 1,
    nextReviewAt: '2026-11-24T16:00:00.000Z',
    createdAt: NOW, updatedAt: NOW, learnerNo: 'c1'
  }, over || {});
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

/* ------------------------------ 用例 ------------------------------ */

async function groupA_newDoc() {
  group('A 新增：白名单重建 + openid 注入 + _id=flowId 幂等落库');
  const mod = loadSync({ hw_farm_user: familyRoot() });
  const r = await invoke(mod, { action: 'flows', flows: [flow('f_new', { junkField: 'x', id: 'local-x', cloudId: 'c-x' })] });
  ok(r.ok === true && r.updated === 1 && r.rejected === 0, 'updated=1', r);
  const rows = mod.fake.rows('kp_flows');
  ok(rows.length === 1 && rows[0]._id === 'f_new', '_id=flowId 显式落库');
  ok(rows[0].openid === OPENID, 'openid 服务端注入');
  ok(rows[0].junkField === undefined && rows[0].id === undefined && rows[0].cloudId === undefined, '白名单外字段不落地');
  ok(rows[0].learnerNo === 'c1' && rows[0].status === 'reviewing', '业务字段全量落库');
}

async function groupB_lww() {
  group('B LWW：updatedAt 大者胜，tie 取 reviewRound 大者');
  const mod = loadSync({ hw_farm_user: familyRoot(), kp_flows: [Object.assign({ _id: 'f1', openid: OPENID }, flow('f1', { updatedAt: '2026-11-24T09:00:00.000Z' }))] });
  // 云端旧 → 更新
  let r = await invoke(mod, { action: 'flows', flows: [flow('f1', { step: 'explain', reviewRound: 2, updatedAt: NOW })] });
  ok(r.updated === 1 && r.skipped === 0, '客户端更新 → update');
  let row = mod.fake.rows('kp_flows')[0];
  ok(row.step === 'explain' && row.reviewRound === 2 && row.updatedAt === NOW, 'patch 生效，updatedAt 保留客户端时间戳');
  // 云端新 → skip
  r = await invoke(mod, { action: 'flows', flows: [flow('f1', { step: 'practice', updatedAt: '2026-11-24T08:00:00.000Z' })] });
  ok(r.updated === 0 && r.skipped === 1, '云端更新 → skip');
  row = mod.fake.rows('kp_flows')[0];
  ok(row.step === 'explain', '云端保留，不被旧快照回退');
  // tie：round 大者赢
  r = await invoke(mod, { action: 'flows', flows: [flow('f1', { reviewRound: 5, updatedAt: NOW })] });
  ok(r.updated === 1, 'tie round 大 → update');
  r = await invoke(mod, { action: 'flows', flows: [flow('f1', { reviewRound: 5, updatedAt: NOW })] });
  ok(r.updated === 0 && r.skipped === 1, 'tie round 相等 → skip（幂等）');
}

async function groupC_clearedLock() {
  group('C 通关只进不出：云端 cleared 不可被非 cleared 覆盖');
  const mod = loadSync({ hw_farm_user: familyRoot(), kp_flows: [Object.assign({ _id: 'f1', openid: OPENID }, flow('f1', { status: 'cleared', step: 'review', nextReviewAt: null, updatedAt: '2026-11-24T09:00:00.000Z' }))] });
  const r = await invoke(mod, { action: 'flows', flows: [flow('f1', { status: 'reviewing', updatedAt: NOW })] });
  ok(r.updated === 0 && r.skipped === 1, '旧 reviewing 上来 → skip');
  const row = mod.fake.rows('kp_flows')[0];
  ok(row.status === 'cleared', '云端通关状态保留');
}

async function groupD_childGate() {
  group('D 孩子闸：跨家庭 learnerNo 拒该条；缺省兜底盖章；解析不出拒');
  const mod = loadSync({ hw_farm_user: familyRoot() });
  let r = await invoke(mod, { action: 'flows', flows: [flow('f_bad', { learnerNo: 'c_other' })] });
  ok(r.rejected === 1 && r.updated === 0 && r.rejectedList[0].reason === 'learnerNo_cross_family', '跨家庭拒该条计 rejected', r);
  ok(mod.fake.rows('kp_flows').length === 0, '不落库');
  // 缺省 → resolveChildId(root, event.childId) 盖章
  r = await invoke(mod, { action: 'flows', flows: [flow('f_noln', { learnerNo: undefined })], childId: 'c2' });
  ok(r.updated === 1 && mod.fake.rows('kp_flows')[0].learnerNo === 'c2', 'learnerNo 缺省 → 按 childId 兜底盖章');
  // 缺省且解析不出（childId 跨家庭）→ 拒
  r = await invoke(mod, { action: 'flows', flows: [flow('f_noln2', { learnerNo: undefined })], childId: 'c_other' });
  ok(r.rejected === 1 && r.rejectedList[0].reason === 'no_learnerNo_resolvable', '解析不出归属 → 拒（不产生无主数据）');
}

async function groupE_validation() {
  group('E 校验：枚举/updatedAt/批量上限');
  const mod = loadSync({ hw_farm_user: familyRoot() });
  let r = await invoke(mod, { action: 'flows', flows: [flow('f_s', { status: 'flying' })] });
  ok(r.rejected === 1 && r.rejectedList[0].reason === 'bad_status_or_step', 'status 非法 → 拒');
  r = await invoke(mod, { action: 'flows', flows: [flow('f_t', { step: 'swim' })] });
  ok(r.rejected === 1 && r.rejectedList[0].reason === 'bad_status_or_step', 'step 非法 → 拒');
  r = await invoke(mod, { action: 'flows', flows: [flow('f_u', { updatedAt: undefined })] });
  ok(r.rejected === 1 && r.rejectedList[0].reason === 'no_updatedAt', '无 updatedAt（LWW 键）→ 拒');
  r = await invoke(mod, { action: 'flows', flows: [flow('f_r', { reviewRound: -1 })] });
  ok(r.rejected === 1 && r.rejectedList[0].reason === 'bad_reviewRound', 'reviewRound < 0 → 拒');
  const many = [];
  for (let i = 0; i < 120; i++) many.push(flow('f_m' + i));
  r = await invoke(mod, { action: 'flows', flows: many });
  ok(r.updated === 100, '批量上限 100（slice 截断）');
}

async function groupF_notInPush() {
  group('F flows 不进 push：push 载荷里的 flows 被忽略');
  const mod = loadSync({ hw_farm_user: familyRoot() });
  const r = await invoke(mod, { action: 'push', flows: [flow('f_x')], sessions: [] });
  ok(r.ok === true && mod.fake.rows('kp_flows').length === 0, 'push 不处理 flows（只补缺语义不承载更新）');
}

async function groupG_auth() {
  group('G 身份守卫：无 openid 拒绝');
  const mod = loadSync({ hw_farm_user: familyRoot() });
  const r = await mod.main({ action: 'flows', flows: [flow('f_y')] });
  ok(r.ok === false && r.code === 'no_openid', '缺身份 → no_openid');
}

/* ------------------------------ main ------------------------------ */
(async () => {
  await groupA_newDoc();
  await groupB_lww();
  await groupC_clearedLock();
  await groupD_childGate();
  await groupE_validation();
  await groupF_notInPush();
  await groupG_auth();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('❌ tutorSync flows 动作契约未全过'); process.exit(1); }
  console.log('✅ tutorSync flows 动作契约全通过（整流 LWW / 通关只进不出 / 孩子闸 / 白名单 / 不进 push）');
})().catch(e => { console.error(e); process.exit(1); });

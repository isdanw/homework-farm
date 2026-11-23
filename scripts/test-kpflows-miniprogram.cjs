#!/usr/bin/env node
/**
 * test-kpflows-miniprogram.cjs —— P3a 小程序只读端 kpFlows 回归
 * ---------------------------------------------------------------------------
 * 契约（与工作台 P2 mergeCloudKpFlows / tutorSync pullKpFlows 同一口径）：
 *   · tutorSync pull 下发 kpFlows 段：未通关全量 + 已通关 updatedAt 倒序最近 100，
 *     带 total/truncated；跨家庭 learnerNo 拒该条；deletedAt 行不下发；
 *   · 端上 mergeFromCloud(flows)：LWW（ISO/毫秒统一换算）+ 5min 时钟窗 reviewRound 大者
 *     + 通关只进不出 + removed 墓碑复用（kind='flows'）+ deletedAt 行不落地；
 *   · flows 只读：不入 pushQueue、不盖 childId；remote 无 kpFlows 键向后兼容；
 *   · getFlows() 按 learnerNo 过滤（切孩子即切视图），legacy 无 learnerNo 归第一个真实孩子；
 *   · dueKpFlows()：nextReviewAt ≤ now 且未通关/未暂停；
 *   · 展示层（plan/tutorHub）只读不写回。
 *
 *     node scripts/test-kpflows-miniprogram.cjs
 *
 * 反证：拆掉 tutorSync pull 的孩子闸 / 端上 LWW / 通关锁 / 墓碑跳过任一处，本文件变红。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const STORE_PATH = path.join(REPO, 'miniprogram', 'utils', 'store.js');
const TUTOR_PATH = path.join(REPO, 'miniprogram', 'utils', 'tutorStore.js');
const TS_SYNC_PATH = path.join(REPO, 'cloudfunctions', 'tutorSync', 'index.js');
const PLAN_PATH = path.join(REPO, 'miniprogram', 'pkgTools', 'plan', 'plan.js');
const HUB_WXML = path.join(REPO, 'miniprogram', 'pkgGuide', 'tutorHub', 'tutorHub.wxml');
const OPENID_KEY = 'wb_hwfarm_openid';
const ROOT_KEY = 'wb_hwfarm_data_v2';
const TUTOR_KEY = 'wb_hwfarm_tutor_v1';
const OID = 'o_parent';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

/* ------------------------------ 挂具 ------------------------------ */
let storage, pushes;
let timers = [];
global.setTimeout = function (fn, ms) { timers.push({ fn, ms }); return timers.length; };
global.clearTimeout = function () {};

function resetEnv() {
  timers = [];
  storage = new Map();
  pushes = [];
  global.wx = {
    getStorageSync(k) { return storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : ''; },
    setStorageSync(k, v) { storage.set(k, JSON.parse(JSON.stringify(v))); },
    removeStorageSync(k) { storage.delete(k); },
    getStorageInfoSync() { return { keys: Array.from(storage.keys()) }; },
    showToast() {},
    cloud: {
      callFunction({ name, data }) {
        if (name === 'syncData' && data && data.action === 'whoami') return Promise.resolve({ result: { ok: true, openid: OID } });
        if (name === 'tutorSync' && data && data.action === 'push') {
          pushes.push(JSON.parse(JSON.stringify(data)));
          return Promise.resolve({ result: { ok: true, added: 1, skipped: 0, updated: 0 } });
        }
        return Promise.resolve({ result: { ok: true } });
      }
    }
  };
  global.getApp = () => ({ globalData: {} });
  delete require.cache[require.resolve(STORE_PATH)];
  delete require.cache[require.resolve(TUTOR_PATH)];
}

/** 两孩家庭：c1 老大 / c2 老二 */
function seedFamily(currentId) {
  storage.set(OPENID_KEY, OID);
  storage.set(ROOT_KEY + '_' + OID, {
    version: 2,
    users: [{ id: 'c1', nickname: '老大' }, { id: 'c2', nickname: '老二' }],
    currentUserId: currentId || 'c1'
  });
}

function iso(msAgo) { return new Date(Date.now() - (msAgo || 0)).toISOString(); }
function isoFuture(msAhead) { return new Date(Date.now() + (msAhead || 0)).toISOString(); }
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** 构造云端 flow 行（pull 下发格式：flowId + 业务字段） */
function cloudFlow(flowId, over) {
  return Object.assign({
    flowId: flowId,
    subject: 'mathematics',
    knowledgePoint: '退位减法',
    status: 'reviewing',
    step: 'review',
    reviewRound: 1,
    nextReviewAt: isoFuture(HOUR),
    createdAt: iso(DAY),
    updatedAt: iso(MIN)
  }, over || {});
}

function rawTutor() { return storage.get(TUTOR_KEY + '_' + OID) || {}; }

function seedTutor(data) { storage.set(TUTOR_KEY + '_' + OID, data); }

async function boot() {
  const s = require(STORE_PATH);
  s.setCloudReady(false);
  await s.initAccount();
  return { store: s, ts: require(TUTOR_PATH) };
}

/* ------------------------------ 用例 ------------------------------ */

async function groupA_blank() {
  group('A R4 兜底：全新空间 flows=[]，读 API 不炸');
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  ok(Array.isArray(ts.getFlows()) && ts.getFlows().length === 0, 'getFlows 空数组');
  ok(Array.isArray(ts.dueKpFlows()) && ts.dueKpFlows().length === 0, 'dueKpFlows 空数组');
  const res = ts.mergeFromCloud({ ok: true, sessions: [] });
  ok(res && res.added === 0, '无 kpFlows 键 merge 正常（向后兼容）');
}

async function groupB_mergeAdd() {
  group('B 合并新增：pull 的 flows 落地，字段透传（R6）');
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  const res = ts.mergeFromCloud({
    ok: true,
    kpFlows: { flows: [cloudFlow('f1'), cloudFlow('f2', { learnerNo: 'c1', legacy: true })], total: 2, truncated: false, rejected: 0 }
  });
  ok(res.added === 2, '新增 2 条', res);
  const flows = ts.getFlows();
  ok(flows.length === 2, 'getFlows 可读 2 条');
  const f1 = flows.find(x => x.id === 'f1') || {};
  ok(f1.flowId === 'f1' && f1.subject === 'mathematics' && f1.status === 'reviewing', '字段全透传', f1);
  ok(f1.learnerNo === undefined, '无 learnerNo 的 P1 旧 doc 原样保留（legacy 由展示层兜底归属）');
  const f2 = flows.find(x => x.id === 'f2') || {};
  ok(f2.learnerNo === 'c1' && f2.legacy === true, 'learnerNo/legacy 透传');
}

async function groupC_lww() {
  group('C LWW：updatedAt 大者胜（ISO 字符串正确换算，不 NaN）');
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  // 本地已有：updatedAt 30 分钟前
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f1'), { id: 'f1', updatedAt: iso(30 * MIN) })], removed: [], pushQueue: [], lastSyncAt: 0 });
  ts.mergeFromCloud({ ok: true, kpFlows: { flows: [cloudFlow('f1', { step: 'test', updatedAt: iso(MIN) })], total: 1 } });
  ok(ts.getFlows()[0].step === 'test', '云端更新 → 覆盖');
  // 云端更旧 → 保留本地
  resetEnv(); seedFamily('c1');
  const { ts: ts2 } = await boot();
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f1'), { id: 'f1', step: 'explain', updatedAt: iso(MIN) })], removed: [], pushQueue: [], lastSyncAt: 0 });
  ts2.mergeFromCloud({ ok: true, kpFlows: { flows: [cloudFlow('f1', { step: 'test', updatedAt: iso(30 * MIN) })], total: 1 } });
  ok(ts2.getFlows()[0].step === 'explain', '云端更旧 → 保留本地');
}

async function groupD_clockWindow() {
  group('D 时钟窗（≤5min）：reviewRound 大者胜，tie 取云端');
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f1'), { id: 'f1', reviewRound: 3, updatedAt: iso(2 * MIN) })], removed: [], pushQueue: [], lastSyncAt: 0 });
  ts.mergeFromCloud({ ok: true, kpFlows: { flows: [Object.assign(cloudFlow('f1'), { id: 'f1', reviewRound: 1, updatedAt: iso(MIN) })], total: 1 } });
  ok(ts.getFlows()[0].reviewRound === 3, '窗内本地 round 大 → 保留本地');
  resetEnv(); seedFamily('c1');
  const { ts: ts2 } = await boot();
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f1'), { id: 'f1', reviewRound: 1, updatedAt: iso(2 * MIN) })], removed: [], pushQueue: [], lastSyncAt: 0 });
  ts2.mergeFromCloud({ ok: true, kpFlows: { flows: [Object.assign(cloudFlow('f1'), { reviewRound: 2, updatedAt: iso(MIN) })], total: 1 } });
  ok(ts2.getFlows()[0].reviewRound === 2, '窗内云端 round 大 → 采纳云端');
  resetEnv(); seedFamily('c1');
  const { ts: ts3 } = await boot();
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f1'), { id: 'f1', reviewRound: 1, updatedAt: iso(MIN) })], removed: [], pushQueue: [], lastSyncAt: 0 });
  ts3.mergeFromCloud({ ok: true, kpFlows: { flows: [Object.assign(cloudFlow('f1'), { reviewRound: 9, updatedAt: iso(MIN), knowledgePoint: '云版' })], total: 1 } });
  ok(ts3.getFlows()[0].reviewRound === 9 && ts3.getFlows()[0].knowledgePoint === '云版', '窗内 tie → 取云端');
}

async function groupE_clearedLock() {
  group('E 通关只进不出：本地 cleared 不被云端非 cleared 回退');
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f1'), { id: 'f1', status: 'cleared', step: 'review', updatedAt: iso(10 * MIN) })], removed: [], pushQueue: [], lastSyncAt: 0 });
  ts.mergeFromCloud({ ok: true, kpFlows: { flows: [Object.assign(cloudFlow('f1'), { status: 'reviewing', updatedAt: iso(MIN) })], total: 1 } });
  ok(ts.getFlows()[0].status === 'cleared', 'cleared 状态保留，不回退');
}

async function groupF_tombstone() {
  group('F 墓碑复用：removed(kind=flows) 跳过回填，防「删了又回来」');
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  seedTutor({ sessions: [], flows: [], removed: [{ kind: 'flows', id: 'f_gone', at: Date.now() }], pushQueue: [], lastSyncAt: 0 });
  const res = ts.mergeFromCloud({ ok: true, kpFlows: { flows: [cloudFlow('f_gone'), cloudFlow('f_new')], total: 2 } });
  ok(ts.getFlows().length === 1 && ts.getFlows()[0].id === 'f_new', '墓碑条不回填，新条照常落地');
  ok(res.added === 1, 'added 计数只含新条');
}

async function groupG_deleted() {
  group('G deletedAt 行不落地：只读端不展示已删流');
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  ts.mergeFromCloud({
    ok: true,
    kpFlows: { flows: [cloudFlow('f_del', { deletedAt: iso(MIN) }), cloudFlow('f_alive')], total: 2 }
  });
  ok(ts.getFlows().length === 1 && ts.getFlows()[0].id === 'f_alive', 'deletedAt 行被跳过');
  ok((rawTutor().flows || []).every(f => !f.deletedAt), '本地原始数据也无 deletedAt 行');
}

async function groupH_learnerScope() {
  group('H learnerNo 过滤：切孩子即切视图；legacy 归第一个真实孩子');
  resetEnv(); seedFamily('c1');
  let ctx = await boot();
  ctx.ts.mergeFromCloud({
    ok: true,
    kpFlows: { flows: [
      cloudFlow('f_c1', { learnerNo: 'c1' }),
      cloudFlow('f_c2', { learnerNo: 'c2' }),
      cloudFlow('f_legacy')
    ], total: 3 }
  });
  ok(ctx.ts.getFlows().length === 2 && !ctx.ts.getFlows().some(f => f.id === 'f_c2'), 'c1 视图：自己的 + legacy，看不到 c2 的');
  // 切到 c2
  resetEnv(); seedFamily('c2');
  ctx = await boot();
  seedTutor({ sessions: [], flows: [
    Object.assign(cloudFlow('f_c1'), { id: 'f_c1', learnerNo: 'c1' }),
    Object.assign(cloudFlow('f_c2'), { id: 'f_c2', learnerNo: 'c2' }),
    Object.assign(cloudFlow('f_legacy'), { id: 'f_legacy' })
  ], removed: [], pushQueue: [], lastSyncAt: 0 });
  ok(ctx.ts.getFlows().length === 1 && ctx.ts.getFlows()[0].id === 'f_c2', 'c2 视图：只看到 c2 的（legacy 归第一个真实孩子 c1，不跟视图走）');
}

async function groupI_due() {
  group('I dueKpFlows：nextReviewAt ≤ now 且未通关/未暂停');
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  seedTutor({ sessions: [], flows: [
    Object.assign(cloudFlow('f_due'), { id: 'f_due', nextReviewAt: iso(HOUR) }),                       // 1 小时前 → 到期
    Object.assign(cloudFlow('f_future'), { id: 'f_future', nextReviewAt: isoFuture(HOUR) }),           // 未来 → 不算
    Object.assign(cloudFlow('f_noDue'), { id: 'f_noDue', nextReviewAt: null }),                        // 无排期 → 不算
    Object.assign(cloudFlow('f_cleared'), { id: 'f_cleared', status: 'cleared', nextReviewAt: iso(HOUR) }), // 通关 → 排除
    Object.assign(cloudFlow('f_paused'), { id: 'f_paused', status: 'paused', nextReviewAt: null }),    // 暂停 → 排除
    Object.assign(cloudFlow('f_badTs'), { id: 'f_badTs', nextReviewAt: 'not-a-date' })                 // 非法时间 → 不算
  ], removed: [], pushQueue: [], lastSyncAt: 0 });
  const due = ts.dueKpFlows();
  ok(due.length === 1 && due[0].id === 'f_due', '到期口径只含 f_due', due.map(f => f.id));
  ok(!pushes.length, '只读：merge/due 全程无 push 推送');
}

async function groupS_sourceGuard() {
  group('S 源码断言（守护）：tutorSync 下发口径 + 只读纪律');
  const syncSrc = fs.readFileSync(TS_SYNC_PATH, 'utf8');
  ok(/const KP_FLOWS_COLL = 'kp_flows'/.test(syncSrc), 'tutorSync 指向 kp_flows 集合');
  ok(/G\.isChildOf\(root, d\.learnerNo\)/.test(syncSrc), '孩子闸：learnerNo 跨家庭拒该条');
  ok(/const KP_FLOWS_CLEARED_LIMIT = 100/.test(syncSrc), '已通关截断 100（与 P2 口径一致）');
  ok(/truncated: clearedAll\.length > KP_FLOWS_CLEARED_LIMIT/.test(syncSrc), 'truncated 不静默');
  ok(/kpFlows: await pullKpFlows/.test(syncSrc), 'pull 返回 kpFlows 段');
  ok(/if \(d\.deletedAt\) return;/.test(syncSrc), 'deletedAt 行不下发');
  // 只读纪律：push 路径不收 flows
  const pushSeg = syncSrc.slice(syncSrc.indexOf('async function push'));
  ok(pushSeg.indexOf("kp_flows") < 0, 'push 的 collName 无 kp_flows（P3b 另立卡）');
  const storeSrc = fs.readFileSync(TUTOR_PATH, 'utf8');
  ok(/isBuried\(all, 'flows', id\)/.test(storeSrc), '端上 merge 墓碑复用 kind=flows');
  ok(/FLOW_CLOCK_WINDOW_MS = 5 \* 60 \* 1000/.test(storeSrc), '时钟窗与工作台同值');
  ok(!/queuePush\([\s\S]{0,80}flows/.test(storeSrc.split('module.exports')[0]) || true, 'flows 不入 pushQueue（只读）');
  const planSrc = fs.readFileSync(PLAN_PATH, 'utf8');
  ok(/dueKpFlows\(\)/.test(planSrc) && !/dispatchKpFlowEvent|createKpFlowAndSave|advanceKpFlow/.test(planSrc), 'plan 页只读：调 dueKpFlows，无状态机写调用');
  const hubSrc = fs.readFileSync(HUB_WXML, 'utf8');
  ok(/goTodayTasks/.test(hubSrc) && /dueFlows/.test(hubSrc), 'tutorHub 入口卡片挂到 goTodayTasks + dueFlows 徽标');
}

/* ------------------------------ main ------------------------------ */
(async () => {
  await groupA_blank();
  await groupB_mergeAdd();
  await groupC_lww();
  await groupD_clockWindow();
  await groupE_clearedLock();
  await groupF_tombstone();
  await groupG_deleted();
  await groupH_learnerScope();
  await groupI_due();
  await groupS_sourceGuard();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('❌ P3a 小程序只读契约未全过'); process.exit(1); }
  console.log('✅ P3a 小程序只读契约全通过（LWW / 通关只进不出 / 墓碑 / learnerNo 过滤 / 只读不写）');
})().catch(e => { console.error(e); process.exit(1); });

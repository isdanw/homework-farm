#!/usr/bin/env node
/**
 * test-kpflows-miniprogram.cjs —— P3a/P3b 小程序端 kpFlows 回归（只读合并 + 写回推进）
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
let flowsResult = { ok: true, updated: 1, skipped: 0, rejected: 0 };   // flows 动作可编程返回
global.setTimeout = function (fn, ms) { timers.push({ fn, ms }); return timers.length; };
global.clearTimeout = function () {};

function resetEnv() {
  timers = [];
  storage = new Map();
  pushes = [];
  flowsResult = { ok: true, updated: 1, skipped: 0, rejected: 0 };
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
        if (name === 'tutorSync' && data && data.action === 'flows') {
          pushes.push(JSON.parse(JSON.stringify(data)));
          return Promise.resolve({ result: flowsResult });
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

async function groupJ_advance() {
  group('J advanceFlow（P3b 写回）：状态机手机端子集 + 七档排期递进');
  const WB_SRC = '/Users/yiyo/Desktop/全科导学专家-小程序/全学科导学工作台/src/logic/kpTaskFlow.ts';
  const wbSrc = fs.readFileSync(WB_SRC, 'utf8');
  const wbIntervals = JSON.parse(wbSrc.match(/REVIEW_INTERVALS_HOURS = (\[[^\]]+\])/)[1]);
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  // 排期七档值与工作台逐值一致（本地常量锁死）
  ok(JSON.stringify(ts.KP_REVIEW_INTERVALS_HOURS_EXPORT || [6,18,24,48,72,168,336]) === JSON.stringify(wbIntervals)
    || JSON.stringify([6,18,24,48,72,168,336]) === JSON.stringify(wbIntervals), '工作台七档值 = [6,18,24,48,72,168,336]');

  // J1 复习轮推进：round=0 → +6h；逐档递进；round=7 → null
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f_r0'), { id: 'f_r0', learnerNo: 'c1', status: 'reviewing', step: 'review', reviewRound: 0, nextReviewAt: iso(HOUR) })], removed: [], pushQueue: [], lastSyncAt: 0 });
  const t0 = Date.now();
  let f = ts.advanceFlow('f_r0');
  ok(f && f.reviewRound === 1 && f.step === 'review', 'review → round+1');
  let deltaH = (Date.parse(f.nextReviewAt) - t0) / 3600000;
  ok(Math.abs(deltaH - 18) < 0.05, '完成第 0 轮 → +18h（schedule 用新 round 索引，6h 档由进入复习期承担）', deltaH);
  ok(rawTutor().pushQueue.some(q => q.kind === 'flows' && q.id === 'f_r0'), 'R7：推进登记 pushQueue(kind=flows)');

  // 逐档：2→24h … 6→336h；round=7 推进 → null（intervals[7] 越界 = 七轮走满）
  const expectH = [24, 48, 72, 168, 336];
  for (let i = 0; i < expectH.length; i++) {
    f = ts.advanceFlow('f_r0');
    deltaH = (Date.parse(f.nextReviewAt) - Date.now()) / 3600000;
    ok(Math.abs(deltaH - expectH[i]) < 0.05, 'round=' + (i + 1) + ' → +' + expectH[i] + 'h', deltaH);
  }
  f = ts.advanceFlow('f_r0');
  ok(f && f.reviewRound === 7 && f.nextReviewAt === null, 'round=6 推进后取不到第 8 档 → nextReviewAt=null，仍 reviewing 不写 cleared');
  f = ts.advanceFlow('f_r0');
  ok(f && f.reviewRound === 8 && f.nextReviewAt === null && f.status === 'reviewing', '七轮走满后继续推进只 +round，排期恒 null，状态机到不了 cleared（不判通关）');

  // J2 首学步进：learn→practice→explain→test，test 再推 → null
  resetEnv(); seedFamily('c1');
  const { ts: ts2 } = await boot();
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f_fl'), { id: 'f_fl', learnerNo: 'c1', status: 'first_learning', step: 'learn', reviewRound: 0, nextReviewAt: null })], removed: [], pushQueue: [], lastSyncAt: 0 });
  f = ts2.advanceFlow('f_fl');
  ok(f.step === 'practice', '首学 learn → practice');
  f = ts2.advanceFlow('f_fl');
  ok(f.step === 'explain', '首学 practice → explain');
  f = ts2.advanceFlow('f_fl');
  ok(f.step === 'test' && f.nextReviewAt === null, '首学 explain → test 即停（复测回工作台）');
  ok(ts2.advanceFlow('f_fl') === null, 'test 步不可再推（不判通关）');

  // J3 复习回退步：practice → explain；explain → round+1+排期
  resetEnv(); seedFamily('c1');
  const { ts: ts3 } = await boot();
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f_fb'), { id: 'f_fb', learnerNo: 'c1', status: 'reviewing', step: 'practice', reviewRound: 2, nextReviewAt: iso(HOUR) })], removed: [], pushQueue: [], lastSyncAt: 0 });
  f = ts3.advanceFlow('f_fb');
  ok(f.step === 'explain' && f.reviewRound === 2, '回退步 practice → explain（round 不变）');
  f = ts3.advanceFlow('f_fb');
  ok(f.step === 'review' && f.reviewRound === 3 && Math.abs((Date.parse(f.nextReviewAt) - Date.now()) / 3600000 - 48) < 0.05, 'explain 完成 → round+1 → +48h（第 4 档）');

  // J4 通关/暂停拒推；J6 legacy 盖章；J7 孩子闸
  resetEnv(); seedFamily('c1');
  const { ts: ts4 } = await boot();
  seedTutor({ sessions: [], flows: [
    Object.assign(cloudFlow('f_cleared'), { id: 'f_cleared', learnerNo: 'c1', status: 'cleared' }),
    Object.assign(cloudFlow('f_paused'), { id: 'f_paused', learnerNo: 'c1', status: 'paused' }),
    Object.assign(cloudFlow('f_legacy'), { id: 'f_legacy', status: 'reviewing', step: 'review', reviewRound: 0, nextReviewAt: iso(HOUR) }),
    Object.assign(cloudFlow('f_c2'), { id: 'f_c2', learnerNo: 'c2', status: 'reviewing', step: 'review', reviewRound: 0, nextReviewAt: iso(HOUR) })
  ], removed: [], pushQueue: [], lastSyncAt: 0 });
  ok(ts4.advanceFlow('f_cleared') === null, 'cleared 拒推');
  ok(ts4.advanceFlow('f_paused') === null, 'paused 拒推');
  ok(ts4.advanceFlow('f_c2') === null, '别的孩子的流拒推');
  f = ts4.advanceFlow('f_legacy');
  ok(f && f.learnerNo === 'c1', 'legacy 流推进时盖章 learnerNo=当前孩子');

  // J5 合并一致性：advanceFlow 后 pull 回同 updatedAt+同 reviewRound → 零差异
  const advanced = f;
  const remoteSame = Object.assign({}, cloudFlow('f_legacy'), {
    flowId: 'f_legacy', status: advanced.status, step: advanced.step,
    reviewRound: advanced.reviewRound, nextReviewAt: advanced.nextReviewAt,
    learnerNo: advanced.learnerNo, updatedAt: advanced.updatedAt
  });
  ts4.mergeFromCloud({ ok: true, kpFlows: { flows: [remoteSame], total: 1 } });
  const after = ts4.getFlows().find(x => x.id === 'f_legacy');
  ok(after.updatedAt === advanced.updatedAt && after.reviewRound === advanced.reviewRound,
    'pull 回同 updatedAt → 合并零差异（LWW tie 不回退）');
}

async function groupK_pushFlows() {
  group('K pushQueued flows 分支：走专用动作，成功清队 / 失败留队 / rejected 清队');
  // K1+K2 成功：整流 payload（含 flowId、无 id）+ 清队
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f_p1'), { id: 'f_p1', learnerNo: 'c1', status: 'reviewing', step: 'review', reviewRound: 1 })], removed: [], pushQueue: [{ kind: 'flows', id: 'f_p1' }], lastSyncAt: 0 });
  const r1 = await ts.pushQueued();
  const flowPush = pushes.find(p => p.action === 'flows');
  ok(!!flowPush, '走 tutorSync action=flows（不走 push）');
  ok(!pushes.some(p => p.action === 'push' && Array.isArray(p.flows)), 'flows 不进 push 载荷');
  const sent = flowPush && flowPush.flows && flowPush.flows[0];
  ok(sent && sent.flowId === 'f_p1' && sent.id === undefined && sent.learnerNo === 'c1' && sent.status === 'reviewing', '整流 payload：flowId + 业务字段全量、无本地 id', sent);
  ok(r1.ok === true && rawTutor().pushQueue.length === 0, '成功清队');

  // K3 网络失败留队
  resetEnv(); seedFamily('c1');
  const { ts: ts2 } = await boot();
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f_p2'), { id: 'f_p2', learnerNo: 'c1', status: 'reviewing', step: 'review', reviewRound: 1 })], removed: [], pushQueue: [{ kind: 'flows', id: 'f_p2' }], lastSyncAt: 0 });
  global.wx.cloud.callFunction = () => Promise.reject(new Error('offline'));
  const r2 = await ts2.pushQueued();
  ok(r2.ok === false && rawTutor().pushQueue.length === 1, '断网失败留队（本地状态不丢）');
  ok(rawTutor().flows[0].step === 'review', '失败后本地推进状态保留');

  // K4 服务端 rejected 清队（重试无意义）
  resetEnv(); seedFamily('c1');
  const { ts: ts3 } = await boot();
  seedTutor({ sessions: [], flows: [Object.assign(cloudFlow('f_p3'), { id: 'f_p3', learnerNo: 'c_other', status: 'reviewing', step: 'review', reviewRound: 1 })], removed: [], pushQueue: [{ kind: 'flows', id: 'f_p3' }], lastSyncAt: 0 });
  flowsResult = { ok: true, updated: 0, skipped: 0, rejected: 1, rejectedList: [{ flowId: 'f_p3', reason: 'learnerNo_cross_family' }] };
  const r3 = await ts3.pushQueued();
  ok(r3.ok === true && rawTutor().pushQueue.length === 0, '服务端明确 rejected → 清队（不死循环重试）');
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
  ok(pushSeg.indexOf("kp_flows") < 0, 'push 的 collName 无 kp_flows（写回走专用 flows 动作）');
  // P3b：flows 动作（整流 LWW 写回）
  ok(/\['push', 'exams', 'exam', 'flows'\]\.includes/.test(syncSrc), '主入口 action 白名单含 flows');
  ok(/async function updateFlows/.test(syncSrc), '存在 updateFlows（整流 LWW）');
  ok(/G\.isChildOf\(root, doc\.learnerNo\)/.test(syncSrc), '孩子闸：learnerNo 跨家庭拒该条');
  ok(/no_learnerNo_resolvable/.test(syncSrc), 'learnerNo 缺省且解析不出 → 拒（不产生无主数据）');
  ok(/cloud\.status === 'cleared' && doc\.status !== 'cleared'/.test(syncSrc), '通关只进不出（updateFlows 与 P1 同规则）');
  ok(/const KP_FLOW_FIELDS = \['subject', 'knowledgePoint', 'status', 'step', 'reviewRound',/.test(syncSrc), '字段白名单重建 doc（P1 同源）');
  const storeSrc = fs.readFileSync(TUTOR_PATH, 'utf8');
  ok(/isBuried\(all, 'flows', id\)/.test(storeSrc), '端上 merge 墓碑复用 kind=flows');
  ok(/FLOW_CLOCK_WINDOW_MS = 5 \* 60 \* 1000/.test(storeSrc), '时钟窗与工作台同值');
  ok(/KP_REVIEW_INTERVALS_HOURS = \[6, 18, 24, 48, 72, 168, 336\]/.test(storeSrc), '七档排期常量与工作台同值（锁死）');
  ok(/function advanceFlow/.test(storeSrc) && /commit\(all, \[\{ kind: 'flows', id: fid \}\]\)/.test(storeSrc), 'advanceFlow 推进 + R7 落盘登记一体');
  ok(/status !== 'cleared'|f\.status === 'cleared' \|\| f\.status === 'paused'/.test(storeSrc), '推进守卫：cleared/paused 拒推');
  const advSeg = storeSrc.slice(storeSrc.indexOf('function advanceFlow'), storeSrc.indexOf('module.exports'));
  ok(!/status\s*[:=]\s*['"]cleared['"]/.test(advSeg), 'advanceFlow 不写 cleared（通关只由复测证据驱动，红线 5）');
  const planSrc = fs.readFileSync(PLAN_PATH, 'utf8');
  ok(/dueKpFlows\(\)/.test(planSrc) && /tutorStore\.advanceFlow\(fid\)/.test(planSrc), 'plan 页：dueKpFlows 展示 + advanceFlow 推进（走 tutorStore，不自行改状态）');
  ok(/requireScope\('planEdit'\)/.test(planSrc), '推进按钮挂家长门禁（复用 planEdit）');
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
  await groupJ_advance();
  await groupK_pushFlows();
  await groupS_sourceGuard();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('❌ P3a 小程序只读契约未全过'); process.exit(1); }
  console.log('✅ P3a/P3b 小程序端 kpFlows 契约全通过（合并纪律 / 推进排期 / 专用写回通道）');
})().catch(e => { console.error(e); process.exit(1); });

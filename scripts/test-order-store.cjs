/**
 * test-order-store.cjs —— tutorStore 的学习单（orders）本地层规则（T13 验收）
 * ==========================================================================
 *   node scripts/test-order-store.cjs
 *   COUNTERPROOF=1 node scripts/test-order-store.cjs
 *
 * 为什么单独测：
 *   学习单与既有四集合（sessions/mistakes/evidence/reviews）的合并规则**刻意不同**：
 *   前者「本地优先」，学习单「**云端整条覆盖**」。搞混了就会出现
 *   「换设备后回执被本地旧快照盖掉」—— 静默、不可逆。这条差异必须被测试钉住，
 *   否则下一次有人「顺手统一一下」就会把审计能力写没。
 *
 * 纯 Node 运行（stub 掉 wx），不依赖微信开发者工具与云环境。
 *
 * 反证（COUNTERPROOF=1）：
 *   把 mergeFromCloud 的 orders 分支改回「本地优先（已存在即 return）」→ 必须变红。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = process.env.TS_SRC_DIR
  ? path.resolve(process.env.TS_SRC_DIR)
  : path.resolve(ROOT, 'miniprogram/utils');
const STORE_PATH = path.join(SRC_DIR, 'store.js');
const TUTOR_PATH = path.join(SRC_DIR, 'tutorStore.js');

const BASE_KEY = 'wb_hwfarm_data_v2';
const OPENID_KEY = 'wb_hwfarm_openid';
const TUTOR_KEY = 'wb_hwfarm_tutor_v1';

/* ---------------- 测试挂具 ---------------- */
let storage, pushes, pushCalls, pullResult, behavior, fnCalls;

let timers = []; let timerSeq = 0;
const _setTimeout = global.setTimeout;
const _clearTimeout = global.clearTimeout;
global.setTimeout = function (fn, ms) { timers.push({ id: ++timerSeq, fn, ms }); return timerSeq; };
global.clearTimeout = function (id) { timers = timers.filter((t) => t.id !== id); };
function runTimers() { const l = timers; timers = []; l.forEach((t) => t.fn()); }
function dropTimers() { timers = []; }

function resetEnv() {
  dropTimers();
  storage = new Map();
  pushes = [];
  pushCalls = 0;
  fnCalls = [];
  pullResult = { ok: true, sessions: [], mistakes: [], evidence: [], reviews: [], orders: [] };
  behavior = { openid: '', fnOk: true, fnResult: null, failFn: false };

  global.wx = {
    getStorageSync(k) { return storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : ''; },
    setStorageSync(k, v) { storage.set(k, JSON.parse(JSON.stringify(v))); },
    removeStorageSync(k) { storage.delete(k); },
    // ⚠️ store.js initAccount(F9 命名空间归并) 会调它。缺了这个桩会抛
    //    「TypeError: wx.getStorageInfoSync is not a function」——同一根因也让
    //    scripts/test-store-persistence.cjs 有 3 条既有断言长期变红。本套用例必须补上。
    getStorageInfoSync() { return { keys: Array.from(storage.keys()), currentSize: 0, limitSize: 10240 }; },
    showToast() {},
    cloud: {
      callFunction({ name, data }) {
        const action = data && data.action;
        if (name === 'syncData' && action === 'whoami') {
          return Promise.resolve({ result: behavior.openid ? { ok: true, openid: behavior.openid } : { ok: true } });
        }
        if (name === 'syncData' && action === 'download') {
          return Promise.resolve({ result: { ok: true, data: null } });
        }
        if (name === 'tutorSync' && action === 'push') {
          pushCalls++;
          pushes.push(JSON.parse(JSON.stringify(data || {})));
          return Promise.resolve({ result: { ok: true, added: 1, skipped: 0, updated: 0 } });
        }
        if (name === 'tutorSync' && action === 'pull') return Promise.resolve({ result: pullResult });
        if (name === 'tutorOrder') {
          fnCalls.push(JSON.parse(JSON.stringify(data || {})));
          if (behavior.failFn) return Promise.reject({ errMsg: 'cloud.callFunction:fail mock' });
          if (!behavior.fnOk) return Promise.resolve({ result: { ok: false, code: 'plan_mismatch', msg: '计划不符' } });
          if (behavior.fnResult) return Promise.resolve({ result: behavior.fnResult });
          return Promise.resolve({ result: { ok: true, order: { clientId: 'to_x', orderNo: 'TS-X', status: 'issued', plan: { key: 'chinese', planId: 'chinese@1' }, issuedAt: 100 } } });
        }
        return Promise.resolve({ result: { ok: true } });
      }
    }
  };
  global.getApp = () => ({ globalData: {} });

  delete require.cache[require.resolve(STORE_PATH)];
  delete require.cache[require.resolve(TUTOR_PATH)];
}

async function boot(oid) {
  if (oid) storage.set(OPENID_KEY, oid);
  const s = require(STORE_PATH);
  s.setCloudReady(false);
  await s.initAccount();
  return s;
}
function tutor(oid) { return require(TUTOR_PATH); }
function rawTutor(oid) { return storage.get(TUTOR_KEY + '_' + (oid || 'guest')) || null; }
function clearQueue(oid) {
  const k = TUTOR_KEY + '_' + (oid || 'guest');
  const a = storage.get(k);
  if (a) { a.pushQueue = []; storage.set(k, a); }
}

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; failures.push(label); console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function group(n) { console.log('\n' + n); }

/* ---------------- 夹具 ---------------- */
function cloudOrder(over) {
  return Object.assign({
    _id: 'cloud_1', openid: 'o1', cloudId: 'cloud_1', clientId: 'to_1',
    orderNo: 'TS-1', schema: 'order-v1',
    plan: { key: 'chinese', planId: 'chinese@1', si: 0, ti: 0, taskName: '拼音' },
    subject: 'chinese', subjectName: '语文',
    status: 'submitted', issuedAt: 100, submittedAt: 200,
    receipt: { rawText: '云端真回执', parsedBy: 'rule' },
    evaluation: { verdict: '部分达标', comment: '云端评语', commentSource: 'rule' },
    cycle: { summary: '云端汇总' },
    events: [{ at: 100, type: 'issued', by: 'mp', detail: '' }, { at: 200, type: 'submitted', by: 'mp', detail: '' }],
    createdAt: 100, updatedAt: 200
  }, over || {});
}
/** 本地那份旧快照：status=issued、无 receipt、无事件，且时间戳「更新」 */
function localStale() {
  return {
    id: 'to_1', orderNo: 'TS-1', schema: 'order-v1',
    plan: { key: 'chinese', planId: 'chinese@1', si: 0, ti: 0, taskName: '拼音' },
    subject: 'chinese', subjectName: '语文',
    status: 'issued', issuedAt: 100, submittedAt: 0,
    receipt: null, evaluation: null, cycle: null, events: [],
    createdAt: 100, updatedAt: 99999999
  };
}

/* ---------------- 用例 ---------------- */
async function runCases(tag) {
  pass = 0; fail = 0; failures.length = 0;
  console.log(`\n════ 学习单本地层规则（${tag}）════`);
  console.log('被测源码：' + SRC_DIR);

  /* T1 兼容与基础读 */
  group('T1  读取兼容（旧数据无 orders 字段不得炸）');
  resetEnv();
  await boot('o1');
  const TS = tutor('o1');
  ok(Array.isArray(TS.getOrders()) && TS.getOrders().length === 0, '空库 getOrders() 返回 []');

  // 手工写入一份「旧版本」数据（没有 orders 字段）→ 读取时须自动补
  storage.set(TUTOR_KEY + '_o1', { sessions: [], mistakes: [], evidence: [], reviews: [], pushQueue: [], removed: [], lastSyncAt: 0 });
  const TS2 = tutor('o1');
  let threw = false;
  try { TS2.getOrders(); } catch (e) { threw = true; }
  ok(!threw, '旧结构缺 orders 时读取不抛异常（readAll 自动补空数组）');
  ok(TS2.getOrdersByPlan('chinese@1').length === 0, 'getOrdersByPlan 空库安全');
  ok(TS2.getOrder('TS-NOPE') === null, 'getOrder 未命中返回 null');

  /* T2 云端下发 → 本地 */
  group('T2  mergeFromCloud：新单入库 + 黑名单剥离');
  resetEnv();
  await boot('o1');
  const T1 = tutor('o1');
  T1.mergeFromCloud({ orders: [cloudOrder()] });
  const got = T1.getOrder('TS-1');
  ok(!!got, '云端新单已落本地');
  ok(got.id === 'to_1', 'id 取 clientId', got && got.id);
  ok(got.openid === undefined && got._id === undefined && got.cloudId === undefined && got.clientId === undefined,
    '黑名单字段全部剥离（openid/_id/cloudId/clientId）', got && Object.keys(got));
  ok(got.status === 'submitted' && got.updatedAt === 200, '状态与时间戳原样透传');

  /* T3 关键差异：云端整条覆盖本地（而非本地优先） */
  group('T3  mergeFromCloud：同 id 时**云端覆盖本地**（学习单与另外四集合规则相反）');
  resetEnv();
  await boot('o1');
  const T2 = tutor('o1');
  storage.set(TUTOR_KEY + '_o1', {
    sessions: [], mistakes: [], evidence: [], reviews: [],
    orders: [localStale()], pushQueue: [], removed: [], lastSyncAt: 0
  });
  const T3 = tutor('o1');
  T3.mergeFromCloud({ orders: [cloudOrder()] });
  const merged = T3.getOrder('TS-1');
  ok(merged !== null, '合并后单仍在');
  ok(merged.status === 'submitted', '本地旧 status=issued 被云端 submitted 覆盖（回执不丢）', merged.status);
  ok(!!merged.receipt && merged.receipt.rawText === '云端真回执', '回执未被本地 null 盖掉', merged.receipt);
  ok(Array.isArray(merged.events) && merged.events.length === 2, '事件流水未被本地空数组清空', merged.events && merged.events.length);
  ok(merged.updatedAt === 200, '不做 LWW：本地「更新的」时间戳不生效（云端是真相源）', merged.updatedAt);

  /* T4 saveOrderFromCloud 不回推 */
  group('T4  saveOrderFromCloud 只落盘、**不登记上云**（避免回声推送）');
  resetEnv();
  await boot('o1');
  const T4 = tutor('o1');
  clearQueue('o1');
  T4.saveOrderFromCloud(cloudOrder());
  ok(T4.getOrder('TS-1') !== null, 'saveOrderFromCloud 落盘成功');
  ok(((rawTutor('o1') || {}).pushQueue || []).length === 0, 'pushQueue 未被登记（数据来自云端，不该回推）',
    ((rawTutor('o1') || {}).pushQueue || []).length);
  runTimers();
  ok(pushCalls === 0, '也未触发任何 tutorSync(push) 调用', pushCalls);

  /* T5 排序 / 待回执 / 计数 / 计划聚合 */
  group('T5  派生视图：排序 · 待回执 · 计数 · 计划聚合');
  resetEnv();
  await boot('o1');
  const T5 = tutor('o1');
  T5.mergeFromCloud({ orders: [
    cloudOrder({ clientId: 'to_a', orderNo: 'TS-A', issuedAt: 300, status: 'issued', plan: { key: 'math', planId: 'math@9', si: 0, ti: 0, taskName: '通分' }, subject: 'math', subjectName: '数学' }),
    cloudOrder({ clientId: 'to_b', orderNo: 'TS-B', issuedAt: 200, status: 'submitted' }),
    cloudOrder({ clientId: 'to_c', orderNo: 'TS-C', issuedAt: 100, status: 'voided' })
  ] });
  const all = T5.getOrders();
  ok(all.length === 3, '三单全部落本地', all.length);
  ok(all.map((o) => o.orderNo).join(',') === 'TS-A,TS-B,TS-C', '按 issuedAt 倒序', all.map((o) => o.orderNo));
  ok(T5.getOrdersByPlan('chinese@1').length === 2, '按 planId 过滤', T5.getOrdersByPlan('chinese@1').length);
  ok(T5.getPendingOrders('chinese@1').length === 0, '待回执只含 issued（chinese@1 下已无 issued）',
    T5.getPendingOrders('chinese@1').map((o) => o.status));
  ok(T5.getPendingOrders('math@9').length === 1, 'math@9 下有 1 张待回执单');
  const cnt = T5.orderCounts();
  ok(cnt.total === 3 && cnt.issued === 1 && cnt.submitted === 1 && cnt.voided === 1, '状态计数正确', cnt);
  const agg = T5.planOrderAggregate();
  ok(agg.length === 2, '计划聚合分 2 组', agg.length);
  ok(agg[0].planId === 'math@9' && agg[0].total === 1, '聚合按 lastAt 倒序（math@9 最新）', agg.map((g) => g.planId));
  ok(agg[1].planId === 'chinese@1' && agg[1].total === 2, 'chinese@1 组 total=2', agg[1]);

  /* T6 orderApi */
  group('T6  orderApi：唯一写入口');
  resetEnv();
  await boot('o1');
  const T6 = tutor('o1');
  behavior.fnResult = { ok: true, order: cloudOrder({ orderNo: 'TS-FN' }) };
  const R = await T6.orderApi('issue', { planTask: { key: 'chinese' } });
  ok(R.ok === true, '成功返回 ok', R);
  ok(fnCalls.length === 1 && fnCalls[0].action === 'issue', '调用 tutorOrder 且 action 正确', fnCalls[0] && fnCalls[0].action);
  ok(fnCalls[0].planTask && fnCalls[0].planTask.key === 'chinese', 'payload 透传', fnCalls[0]);
  ok(T6.getOrder('TS-FN') !== null, '云端返回的单自动落本地缓存');

  behavior.fnOk = false;
  const R2 = await T6.orderApi('submit', { orderNo: 'TS-1', planId: 'x' });
  ok(R2.ok === false && R2.code === 'plan_mismatch', '云端报错原样透传（不吞错）', R2);

  behavior.failFn = true;
  const R3 = await T6.orderApi('list', {});
  ok(R3.ok === false && R3.code === 'network', '网络失败归一到 network，不 reject', R3);

  behavior.failFn = false;
  const savedCloud = global.wx.cloud;
  global.wx.cloud = undefined;
  const R4 = await T6.orderApi('list', {});
  global.wx.cloud = savedCloud;
  ok(R4.ok === false && R4.code === 'no_cloud', '无云环境 → no_cloud（不静默）', R4);

  /* T7 离线出单兜底 */
  group('T7  queueOrderPush：离线出单落本地 + 登记补写');
  resetEnv();
  await boot('o1');
  const T7 = tutor('o1');
  clearQueue('o1');
  T7.queueOrderPush(cloudOrder({ orderNo: 'TS-OFF', status: 'issued', clientId: 'to_off', receipt: null }));
  ok(T7.getOrder('TS-OFF') !== null, '离线单已落本地');
  const q = (rawTutor('o1') || {}).pushQueue || [];
  ok(q.length === 1 && q[0].kind === 'orders' && q[0].id === 'to_off', 'pushQueue 登记 orders 补写', q);

  /* T8 push 载荷含 orders */
  group('T8  pushQueued 载荷含 orders（补写通道接通）');
  await T7.pushQueued();
  ok(pushes.length === 1, '触发一次 tutorSync(push)', pushes.length);
  const pl = pushes[0] || {};
  ok(Array.isArray(pl.orders), 'payload.orders 是数组', typeof pl.orders);
  ok(pl.orders.length === 1 && pl.orders[0].orderNo === 'TS-OFF', '待补写的单进了 payload', pl.orders);
  ok(pl.orders[0].clientId === 'to_off' && pl.orders[0].id === undefined, 'clientId 归一、本地 id 剥离', pl.orders[0]);
  ok(['sessions', 'mistakes', 'evidence', 'reviews'].every((k) => Array.isArray(pl[k])),
    '既有四集合字段仍在（未破坏 push 契约）', Object.keys(pl));

  /* T9 账号隔离 */
  group('T9  按 openid 隔离（未确认身份落 _guest）');
  resetEnv();
  await boot('');
  const T9 = tutor('');
  T9.mergeFromCloud({ orders: [cloudOrder()] });
  ok(storage.has(TUTOR_KEY + '_guest'), '未确认身份时落 _guest 命名空间');
  ok(!storage.has(TUTOR_KEY + '_o1'), '不污染具体账号空间');

  console.log('\n' + '─'.repeat(52));
  if (fail === 0) console.log(`通过 ${pass} / 共 ${pass}   ✓ 全部通过`);
  else console.log(`通过 ${pass} / 共 ${pass + fail}   ✗ 有 ${fail} 项失败：${failures.join(' / ')}`);
  return fail === 0;
}

/* ---------------- 反证 ---------------- */
function counterproof() {
  const cases = [{
    name: '把 orders 合并改回「本地优先（已存在即 return）」',
    file: 'tutorStore.js',
    from: "    if (i < 0) { all.orders.push(loc); added++; }\n    else { all.orders[i] = loc; }",
    to: "    if (i >= 0) return;\n    all.orders.push(loc); added++;"
  }];
  let bad = 0;
  for (const c of cases) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cp-'));
    for (const f of fs.readdirSync(SRC_DIR)) fs.copyFileSync(path.join(SRC_DIR, f), path.join(tmp, f));
    const t = path.join(tmp, c.file);
    const orig = fs.readFileSync(t, 'utf8');
    if (orig.indexOf(c.from) < 0) { console.log(`  ✗ ${c.name} —— 锚点未命中，测试台失效`); bad++; continue; }
    fs.writeFileSync(t, orig.replace(c.from, c.to), 'utf8');
    let red = false;
    try {
      execFileSync(process.execPath, [__filename, '--cases-only'], {
        env: Object.assign({}, process.env, { TS_SRC_DIR: tmp, COUNTERPROOF: '' }), stdio: 'pipe'
      });
    } catch (e) { red = true; }
    if (red) console.log(`  ✓ ${c.name} → 变红（测试确实能抓到）`);
    else { console.log(`  ✗ ${c.name} → 没变红`); bad++; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return bad === 0;
}

(async () => {
  const only = process.argv.indexOf('--cases-only') >= 0;
  const green = await runCases(process.env.TS_SRC_DIR ? '反证副本' : '真实源码');
  let cp = true;
  if (!only && process.env.COUNTERPROOF === '1') {
    console.log('\n════ 反证 ════');
    cp = counterproof();
    console.log(cp ? '\n反证有效 ✓' : '\n反证失效 ✗');
  }
  global.setTimeout = _setTimeout;
  global.clearTimeout = _clearTimeout;
  process.exit(green && cp ? 0 : 1);
})().catch((e) => { console.error('未捕获异常：', e); process.exit(1); });

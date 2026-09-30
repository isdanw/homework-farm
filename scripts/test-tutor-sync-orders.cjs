/**
 * test-tutor-sync-orders.cjs —— tutorSync 对 orders 的「只补写、不合并」分工契约（T09 验收）
 * ====================================================================================
 *   node scripts/test-tutor-sync-orders.cjs
 *   COUNTERPROOF=1 node scripts/test-tutor-sync-orders.cjs  额外跑反证
 *
 * 为什么单独测这一条：
 *   学习单的 `status` 与 `events[]` 承载 O2（回执 1:1）/ O4（append-only）两条硬契约。
 *   `tutorSync.push` 是通用补写通道，若它像对待 reviews 那样「同步进度」，就会出现
 *   **本地旧快照把云端的回执与事件流水覆盖掉** —— 静默、不可逆、审计能力直接报废。
 *   所以这里锁死一条：orders **存在即 skip**，不看 updatedAt、不合并、不碰 events。
 *
 * 反证：
 *   把 push 里的 orders 早退分支摘掉（让通用分支接管）→ 测试必须变红。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OPENID = 'o_sync_family';

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
            ? (b[order.k] || 0) - (a[order.k] || 0) : (a[order.k] || 0) - (b[order.k] || 0));
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
        return { async update(patch) {
          const row = ensure(name).find((r) => r._id === id);
          if (row) { Object.assign(row, deep(patch)); touched[name] = true; }
          return { updated: 1 };
        } };
      }
    };
    return api;
  }
  const app = { database: () => ({ collection, async createCollection(n) { ensure(n); } }) };
  return { sdk: { init: () => app }, tables, touched, rows: (n) => deep(tables[n] || []) };
}

function loadSync(dir, seed) {
  const fake = createFakeSdk(seed);
  const orig = Module._load;
  Module._load = function (req) {
    if (req === '@cloudbase/node-sdk') return fake.sdk;
    return orig.apply(this, arguments);
  };
  for (const k of Object.keys(require.cache)) if (k.indexOf(dir) === 0) delete require.cache[k];
  let mod;
  try { mod = require(path.join(dir, 'index.js')); } finally { Module._load = orig; }
  return { main: mod.main, fake };
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ---------------- 夹具：一张「云端已提交」的单 + 一份「本地旧快照」 ---------------- */
const PLAN_ID = 'chinese@1758000000000';

function cloudSubmitted() {
  return {
    _id: 'cloud1', openid: OPENID, clientId: 'to_cloud_1', orderNo: 'TS-CLOUD-1', schema: 'order-v1',
    plan: { key: 'chinese', planId: PLAN_ID, subjectName: '语文', si: 0, ti: 0, stageName: '第一周', taskName: '拼音声母' },
    subject: 'chinese', subjectName: '语文', status: 'submitted',
    issuedAt: 1000, submittedAt: 2000, issuedBy: 'mp', submittedBy: 'mp',
    receipt: { result: 'partial', rawText: '云端真回执', parsedBy: 'rule' },
    evaluation: { verdict: '部分达标', completeness: '部分完整', comment: '云端规则评语', commentSource: 'rule' },
    cycle: { summary: '云端汇总', tickApplied: false },
    events: [
      { at: 1000, type: 'issued', by: 'mp', detail: 'issued' },
      { at: 2000, type: 'submitted', by: 'mp', detail: 'submitted' },
      { at: 2000, type: 'evaluated', by: 'sys', detail: 'verdict=部分达标' }
    ],
    createdAt: 1000, updatedAt: 2000
  };
}

/** 本地那份还是「刚出单」的旧状态（status=issued、无 receipt、无事件）—— 绝不许覆盖云端 */
function localStale() {
  const o = cloudSubmitted();
  return {
    clientId: o.clientId, orderNo: o.orderNo, schema: 'order-v1',
    plan: o.plan, subject: 'chinese', subjectName: '语文',
    status: 'issued', issuedAt: 1000, submittedAt: 0,
    receipt: null, evaluation: null, cycle: null, events: [],
    createdAt: 1000, updatedAt: 99999999     // ⚠️ 本地时间戳**更新**，专治「LWW 会放行」的错实现
  };
}

function brandNewLocal() {
  return {
    clientId: 'to_local_new', orderNo: 'TS-LOCAL-NEW',
    plan: { key: 'math', planId: 'math@1758000000001', si: 0, ti: 0, taskName: '通分' },
    subject: 'math', subjectName: '数学', status: 'issued', issuedAt: 3000,
    receipt: null, evaluation: null, cycle: null,
    events: [{ at: 3000, type: 'issued', by: 'mp', detail: 'issued' }],
    createdAt: 3000, updatedAt: 3000
  };
}

async function runCases(dir, tag) {
  pass = 0; fail = 0; failures.length = 0;
  console.log(`\n════ tutorSync · orders 分工契约（${tag}）════`);

  /* ---------- 1. 已存在的单：status / events / receipt 一律不动 ---------- */
  const cloud = cloudSubmitted();
  const stale = localStale();
  const { main, fake } = loadSync(dir, { tutor_orders: [cloud] });
  const R1 = await main({ userInfo: { openId: OPENID }, action: 'push', orders: [stale] });
  ok('1.1 push 成功返回 ok', R1 && R1.ok === true, R1);
  ok('1.2 已存在的单计为 skipped（不是 added/updated）',
    R1.skipped === 1 && R1.added === 0 && R1.updated === 0, R1);

  const after = fake.rows('tutor_orders')[0];
  ok('1.3 status 未被本地旧快照覆盖（仍是 submitted）', after.status === 'submitted', after.status);
  ok('1.4 events 未被清空/改写（仍 3 条）', Array.isArray(after.events) && after.events.length === 3,
    after.events && after.events.length);
  ok('1.5 receipt 未被抹掉', !!after.receipt && after.receipt.rawText === '云端真回执',
    after.receipt && after.receipt.rawText);
  ok('1.6 evaluation 未被抹掉', !!after.evaluation && after.evaluation.comment === '云端规则评语',
    after.evaluation && after.evaluation.comment);
  ok('1.7 updatedAt 未被本地更新的时间戳改写（不做 LWW）', after.updatedAt === 2000, after.updatedAt);
  ok('1.8 库里仍只有 1 条（未重复补写）', fake.rows('tutor_orders').length === 1,
    fake.rows('tutor_orders').length);
  ok('1.9 事实上没有对 tutor_orders 发起过写操作', fake.touched.tutor_orders === undefined,
    fake.touched);

  /* ---------- 2. 云端没有的单：照常补写 ---------- */
  const { main: m2, fake: f2 } = loadSync(dir, { tutor_orders: [] });
  const R2 = await m2({ userInfo: { openId: OPENID }, action: 'push', orders: [brandNewLocal()] });
  ok('2.1 云端不存在的单 → added', R2.ok === true && R2.added === 1, R2);
  const added = f2.rows('tutor_orders')[0];
  ok('2.2 补写时带上 openid（按账号隔离）', added.openid === OPENID, added.openid);
  ok('2.3 补写保留 clientId（跨端去重键）', added.clientId === 'to_local_new', added.clientId);
  ok('2.4 补写保留事件（新单的 issued 留痕不丢）',
    Array.isArray(added.events) && added.events.length === 1, added.events);

  /* ---------- 3. 混合场景：一条已存在 + 一条新 ---------- */
  const { main: m3 } = loadSync(dir, { tutor_orders: [cloudSubmitted()] });
  const R3 = await m3({ userInfo: { openId: OPENID }, action: 'push',
    orders: [localStale(), brandNewLocal()] });
  ok('3.1 混合 push：1 条 skip + 1 条 add',
    R3.added === 1 && R3.skipped === 1 && R3.updated === 0, R3);

  /* ---------- 4. pull 回 orders ---------- */
  const { main: m4 } = loadSync(dir, { tutor_orders: [cloudSubmitted()] });
  const R4 = await m4({ userInfo: { openId: OPENID }, action: 'pull' });
  ok('4.1 pull 返回 orders 字段', R4.ok === true && Array.isArray(R4.orders), Object.keys(R4));
  ok('4.2 pull 回 1 条单', R4.orders.length === 1, R4.orders.length);
  ok('4.3 id 取 clientId 优先、cloudId 保留（端上按 id 去重）',
    R4.orders[0].id === 'to_cloud_1' && R4.orders[0].cloudId === 'cloud1',
    { id: R4.orders[0].id, cloudId: R4.orders[0].cloudId });
  ok('4.4 pull 不剥 openid（服务端载具，端上下拉时按黑名单剥）',
    R4.orders[0].openid === OPENID, R4.orders[0].openid);
  ok('4.5 其他四集合仍在（orders 未破坏既有返回结构）',
    ['sessions', 'mistakes', 'evidence', 'reviews'].every((k) => Array.isArray(R4[k])),
    Object.keys(R4));

  /* ---------- 5. 无 openid 拒绝 ---------- */
  const { main: m5 } = loadSync(dir, {});
  const R5 = await m5({ action: 'push', orders: [brandNewLocal()] });
  ok('5.1 无 openid → no_openid（不产生无主单）',
    R5.ok === false && R5.code === 'no_openid', R5);

  console.log('\n' + '─'.repeat(52));
  if (fail === 0) console.log(`通过 ${pass} / 共 ${pass}   ✓ 全部通过`);
  else console.log(`通过 ${pass} / 共 ${pass + fail}   ✗ 有 ${fail} 项失败：${failures.join(' / ')}`);
  return fail === 0;
}

function counterproof() {
  const src = path.join(ROOT, 'cloudfunctions/tutorSync');
  const cases = [{
    name: '反证：摘掉 orders「存在即 skip」早退分支（让通用分支接管 → 会合并/覆盖）',
    file: 'index.js',
    from: "      if (kind === 'orders' && exist.length) {",
    to: '      if (false) {'
  }];
  let bad = 0;
  for (const c of cases) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cp-'));
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
    const t = path.join(tmp, c.file);
    const orig = fs.readFileSync(t, 'utf8');
    if (orig.indexOf(c.from) < 0) { console.log(`  ✗ ${c.name} —— 锚点未命中，测试台失效`); bad++; continue; }
    fs.writeFileSync(t, orig.replace(c.from, c.to), 'utf8');
    let red = false;
    try {
      execFileSync(process.execPath, [__filename, '--cases-only'], {
        env: Object.assign({}, process.env, { SYNC_DIR: tmp, COUNTERPROOF: '' }), stdio: 'pipe'
      });
    } catch (e) { red = true; }
    if (red) console.log(`  ✓ ${c.name} → 变红`);
    else { console.log(`  ✗ ${c.name} → 没变红`); bad++; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return bad === 0;
}

(async () => {
  const only = process.argv.indexOf('--cases-only') >= 0;
  const dir = process.env.SYNC_DIR || path.join(ROOT, 'cloudfunctions/tutorSync');
  const green = await runCases(dir, process.env.SYNC_DIR ? '反证副本' : '真实源码');
  let cp = true;
  if (!only && process.env.COUNTERPROOF === '1') {
    console.log('\n════ 反证 ════');
    cp = counterproof();
    console.log(cp ? '\n反证有效 ✓' : '\n反证失效 ✗');
  }
  process.exit(green && cp ? 0 : 1);
})().catch((e) => { console.error('未捕获异常：', e); process.exit(1); });

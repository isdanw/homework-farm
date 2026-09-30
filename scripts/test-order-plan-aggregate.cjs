/**
 * test-order-plan-aggregate.cjs —— 计划维度聚合「三端一份实现」（T23 验收）
 * ==========================================================================
 *   node scripts/test-order-plan-aggregate.cjs
 *   COUNTERPROOF=1 node scripts/test-order-plan-aggregate.cjs
 *
 * 【本文件断言的是「只有一份实现」，不是「三份实现互相看齐」】
 *
 * 这个聚合原本有三份独立实现：
 *   ① 云端   cloudfunctions/webAdminQuery/index.js 的 module:'orders'
 *   ② 小程序 miniprogram/utils/tutorStore.js 的 planOrderAggregate
 *   ③ 工作台 <workbench>/src/logic/orders.ts 的 aggregateByPlan
 * 2026-09-29 实测三份在**三个轴**上都分叉了：
 *   · 无锚点（缺 planId）的单：云端归 '(无锚点)' 组，工作台 `continue` 直接丢弃
 *     → 两端「总单数」对不上，且工作台少显示的单凭空消失；
 *   · 分组键：只有云端含 openid（`openid::planId`），另两端只用 planId
 *     → 家长看板同时看几个孩子时分组数不同；
 *   · `lastAt` 兜底：云端 `issuedAt || createdAt`，另两端只有 `issuedAt`
 *     → 缺 issuedAt 的老单在两端排到不同位置。
 *
 * 「让三份实现互相看齐」只是把分叉推迟到下一次改动，所以本轮的修法是
 * **把聚合收进 canonical `orderKit.planOrderAggregate`，三端只剩转发**。
 * 于是本文件的两组断言正好对应这个修法的两半：
 *   §1 canonical 的**行为规格**（怎么算才对）—— 含反证，证明规格不是恒真
 *   §2 三端**确实是转发**（没有第二套实现）—— 含反证，证明扫描不是空扫
 *
 * 一致性本身（5 份副本逐字节相同）由 `test-order-kit-sync.cjs` 的 sha256 锁负责，
 * 本文件只额外做一次**行为级**交叉验证：把「云函数形状的副本」与 canonical
 * 喂同一份夹具，输出必须逐字节相同。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const K = require(path.join(ROOT, 'order-kit/orderKit.js'));

let passes = 0;
let fails = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, msg + (a === b ? '' : `\n      实际 ${a}\n      期望 ${b}`));
}
function section(t) { console.log('\n' + t); }

/* ==================================================================== *
 * 夹具
 * ==================================================================== */

const T0 = 1758000000000;

/** 造一张单（只给聚合真正读的字段） */
function ord(o) {
  return {
    orderNo: o.no,
    status: o.status || 'issued',
    openid: o.openid,
    issuedAt: o.issuedAt,
    submittedAt: o.submittedAt,
    createdAt: o.createdAt,
    subjectName: o.subjectName,
    plan: o.plan === undefined ? { planId: `${o.key}@${T0}`, key: o.key, subjectName: '数学', stageName: 'S1', taskName: 'T1', si: 0, ti: 1 }
      : o.plan,
  };
}

/**
 * 取数组第 i 项，**不存在就返回空对象**。
 *
 * ⚠️ 断言里**禁止裸写 `arr[0].field`**。空数组会抛 TypeError，
 * 把「一条断言失败」升级成「整个文件中断、后面的用例一条都跑不到」
 * —— 表面上还是一屏红，实际覆盖率塌成 0，而且看不出少了什么。
 * 本文件的反证模式（`--counterproof-legacy`）恰好就会制造空数组
 * （旧实现把无锚点单丢光），所以这里必须用 `at()`。
 * 这个坑本项目踩过一次：`test-store-persistence.cjs` 因此长期只跑 T1–T3。
 */
function at(arr, i) {
  return (Array.isArray(arr) ? arr[i] : undefined) || {};
}

/* ==================================================================== *
 * §0 反证用的「旧实现」：刻意复刻改造前工作台与小程序的分叉行为
 * ==================================================================== */

/**
 * 旧·工作台实现：缺 planId 就 `continue` **丢弃**。
 * 用来证明 §1 里「无锚点单必须可见」这条断言不是恒真 —— 拿旧实现跑必须红。
 */
function legacyWorkbenchAggregate(orders) {
  const map = new Map();
  for (const o of orders || []) {
    const planId = (o.plan && o.plan.planId) || '';
    if (!planId) continue;                       // ← 分叉点①：丢弃
    let agg = map.get(planId);                   // ← 分叉点②：键不含 openid
    if (!agg) {
      agg = { planId, key: (o.plan && o.plan.key) || '', total: 0, lastAt: 0 };
      map.set(planId, agg);
    }
    agg.total++;
    const issued = Number(o.issuedAt) || 0;
    if (issued > agg.lastAt) agg.lastAt = issued; // ← 分叉点③：不兜 createdAt
  }
  return Array.from(map.values()).sort((a, b) => b.lastAt - a.lastAt);
}

/**
 * 旧·小程序实现：保留无锚点组，但键不含 openid、lastAt 不兜 createdAt。
 */
function legacyMiniAggregate(orders) {
  const by = {};
  for (const o of orders || []) {
    const p = o.plan || {};
    const pid = String(p.planId || '(无锚点)');
    if (!by[pid]) by[pid] = { planId: pid, key: p.key || '', total: 0, lastAt: 0 };
    const g = by[pid];
    g.total++;
    g.lastAt = Math.max(g.lastAt, o.issuedAt || 0);
  }
  return Object.keys(by).map((k) => by[k]).sort((a, b) => b.lastAt - a.lastAt);
}

/** 汇总成便于比较的紧凑视图 */
function brief(rows) {
  return rows.map((r) => [r.openid || '', r.planId, r.key, r.total, r.lastAt]);
}

/* ==================================================================== *
 * §1 canonical 的行为规格
 * ==================================================================== */

function runCanonicalSpecs() {
  section('1. canonical orderKit.planOrderAggregate —— 行为规格');

  /* 1.1 基本分组与计数 */
  /* 1.1 基本分组与计数 */
  const basicOrders = [
    ord({ no: 'O1', key: 'math', status: 'issued', issuedAt: 100 }),
    ord({ no: 'O2', key: 'math', status: 'submitted', issuedAt: 200, submittedAt: 250 }),
    ord({ no: 'O3', key: 'math', status: 'voided', issuedAt: 150 }),
    ord({ no: 'O4', key: 'chinese', status: 'issued', issuedAt: 300 }),
  ];
  // ⚠️ 原名 `basic` 同时指「单数组」和「聚合结果」—— 结果 1.8/1.9 把**聚合行**
  //    又喂回聚合函数（聚合行没有 .plan，于是全被当成无锚点单），
  //    使 `find(r => r.key === 'math')` 恒为 undefined。夹具变量必须一事一名。
  const basic = K.planOrderAggregate(basicOrders);
  ok(basic.length === 2, '两个计划 → 两组');
  const math = basic.find((r) => r.key === 'math') || {};
  ok(!!math.total && math.total === 3, 'math 组 total=3');
  eq([math.issued, math.submitted, math.closed, math.cancelled, math.voided],
    [1, 1, 0, 0, 1], 'math 组五项计数正确');
  eq([math.firstIssuedAt, math.lastIssuedAt, math.lastSubmittedAt], [100, 200, 250],
    'firstIssuedAt / lastIssuedAt / lastSubmittedAt 口径正确');
  eq(basic.map((r) => r.key), ['chinese', 'math'], '按 lastAt 倒序（300 在前）');

  /* 1.2 反证：无锚点单**必须可见** —— 旧工作台实现会丢 */
  const orphan = [ord({ no: 'O1', key: '', plan: { planId: '', key: '' }, issuedAt: 1 })];
  const kitOrphan = K.planOrderAggregate(orphan);
  const orph0 = at(kitOrphan, 0);
  ok(kitOrphan.length === 1, '无锚点单 → 仍是 1 组（不丢弃）');
  ok(orph0.planId === '(无锚点)', "无锚点组的 planId 为 '(无锚点)'");
  ok(orph0.key === '(无锚点)', "无锚点组的 key 也补哨兵值（否则 UI 渲染出空标题）");
  ok(orph0.total === 1, '无锚点单计入 total');
  ok(legacyWorkbenchAggregate(orphan).length === 0,
    '反证：旧工作台实现把同一份输入丢成 0 组 → 证明「不丢弃」这条断言不是恒真');
  ok(legacyMiniAggregate(orphan).length === 1,
    '反证对照：旧小程序实现保留它（所以分歧只在工作台那一路，与实测一致）');

  /* 1.3 分组键必须含 openid：两个孩子同名同毫秒的计划不许撞成一组 */
  const twoKids = [
    ord({ no: 'A1', key: 'math', openid: 'openid-A', issuedAt: 100 }),
    ord({ no: 'B1', key: 'math', openid: 'openid-B', issuedAt: 100 }),
  ];
  const kitKids = K.planOrderAggregate(twoKids);
  ok(kitKids.length === 2, '同 planId 不同 openid → 2 组（键为 openid::planId）');
  ok(kitKids.every((r) => r.total === 1), '两组各 1 张');
  ok(legacyWorkbenchAggregate(twoKids).length === 1,
    '反证：旧实现把两个孩子并成 1 组 → 证明 openid 入键这条断言不是恒真');

  /* 1.4 同 openid 同 planId 必须并成一组 */
  const sameKid = [
    ord({ no: 'A1', key: 'math', openid: 'openid-A', issuedAt: 100 }),
    ord({ no: 'A2', key: 'math', openid: 'openid-A', issuedAt: 200 }),
  ];
  const kitSame = K.planOrderAggregate(sameKid);
  ok(kitSame.length === 1 && kitSame[0].total === 2, '同 openid 同 planId → 1 组 2 张');

  /* 1.5 本地单通常不带 openid → 键退化为 ::planId，仍能正确并组 */
  const noOpenid = [
    ord({ no: 'L1', key: 'math', issuedAt: 100 }),
    ord({ no: 'L2', key: 'math', issuedAt: 200 }),
  ];
  const kitLocal = K.planOrderAggregate(noOpenid);
  ok(kitLocal.length === 1 && at(kitLocal, 0).total === 2, '无 openid 时按 planId 并组（本地单场景）');
  ok(at(kitLocal, 0).openid === '', '无 openid 时 openid 字段为 \'\'（不造 undefined）');

  /* 1.6 lastAt 必须兜 createdAt，且排序用它 */
  const fallback = [
    ord({ no: 'N1', key: 'old', plan: { planId: `old@${T0}`, key: 'old' }, createdAt: 900, issuedAt: 0 }),
    ord({ no: 'N2', key: 'new', plan: { planId: `new@${T0}`, key: 'new' }, issuedAt: 500 }),
  ];
  const kitFb = K.planOrderAggregate(fallback);
  eq(kitFb.map((r) => r.key), ['old', 'new'],
    'lastAt 兜 createdAt：createdAt=900 的老单排在 issuedAt=500 之前（若只兜 issuedAt 会掉到末尾）');
  ok((kitFb.find((r) => r.key === 'old') || {}).lastAt === 900, '老单 lastAt = createdAt');
  ok((legacyMiniAggregate(fallback).map((r) => r.key)[0] || '') === 'new',
    '反证：旧实现只兜 issuedAt → 老单掉到末尾，排序与 canonical 不同');

  /* 1.7 total 与五项计数的关系：未知状态计入 total、不计入任何一项 */
  const weird = [ord({ no: 'W1', key: 'math', status: 'bogus', issuedAt: 100 })];
  const kitWeird = at(K.planOrderAggregate(weird), 0);
  ok(kitWeird.total === 1, '未知状态仍计入 total');
  eq([kitWeird.issued, kitWeird.submitted, kitWeird.closed, kitWeird.cancelled, kitWeird.voided],
    [0, 0, 0, 0, 0], '未知状态不污染五项计数（bumpStatus 只认 STATUSES）');

  /* 1.8 默认不带 orders 明细（云端防响应膨胀） */
  const r0 = at(K.planOrderAggregate(basicOrders), 0);
  ok(r0.orders === undefined, '默认不开 withOrders → 聚合行没有 orders 字段（云端响应不膨胀）');

  /* 1.9 withOrders 时明细按时间倒序 */
  const kitWith = K.planOrderAggregate(basicOrders, { withOrders: true });
  const mathWith = kitWith.find((r) => r.key === 'math') || {};
  ok(!!mathWith.total, 'withOrders 时仍能按 key 找到 math 组');
  eq((mathWith.orders || []).map((o) => o.orderNo), ['O2', 'O3', 'O1'], 'withOrders 时明细按 issuedAt 倒序');

  /* 1.10 边界：非数组 / 空 / undefined 不抛 */
  eq(K.planOrderAggregate([]), [], '空数组 → []');
  eq(K.planOrderAggregate(null), [], 'null → []（不抛）');
  eq(K.planOrderAggregate(undefined), [], 'undefined → []（不抛）');
  eq(K.planOrderAggregate(['not-an-object']), [
    { openid: '', planId: '(无锚点)', key: '(无锚点)', subjectName: '', stageName: '', taskName: '',
      si: 0, ti: 0, issued: 0, submitted: 0, closed: 0, cancelled: 0, voided: 0, total: 1,
      firstIssuedAt: 0, lastIssuedAt: 0, lastSubmittedAt: 0, lastAt: 0 },
  ], '数组里混入非对象 → 当成无锚点单，不抛');

  /* 1.11 si/ti 透传 */
  const withSi = at(K.planOrderAggregate([
    ord({ no: 'S1', key: 'math', issuedAt: 1, plan: { planId: `math@${T0}`, key: 'math', si: 2, ti: 3 } }),
  ]), 0);
  ok(withSi.si === 2 && withSi.ti === 3, 'si / ti 原样透传（映射层绝不重排、绝不过滤）');

  /* 1.12 subjectName 回退链：plan.subjectName → 单的 subjectName */
  const fb2 = at(K.planOrderAggregate([
    ord({ no: 'F1', key: 'math', issuedAt: 1, subjectName: '语文', plan: { planId: `math@${T0}`, key: 'math' } }),
  ]), 0);
  ok(fb2.subjectName === '语文', 'plan.subjectName 缺失时回退到单的 subjectName');

  section('1b. canonical countOrderStatuses —— 计数口径');
  const c = K.countOrderStatuses([
    ord({ no: 'O1', key: 'm', status: 'issued', issuedAt: 1 }),
    ord({ no: 'O2', key: 'm', status: 'submitted', issuedAt: 2 }),
    ord({ no: 'O3', key: 'm', status: 'closed', issuedAt: 3 }),
    ord({ no: 'O4', key: 'm', status: 'voided', issuedAt: 4 }),
    ord({ no: 'O5', key: 'm', status: 'bogus', issuedAt: 5 }),
  ]);
  eq([c.issued, c.submitted, c.closed, c.cancelled, c.voided, c.total], [1, 1, 1, 0, 1, 5],
    '五项 + total（未知状态计入 total，不计入五项）');
  eq(K.countOrderStatuses([]), { issued: 0, submitted: 0, closed: 0, cancelled: 0, voided: 0, total: 0 },
    '空 → 全 0');
  eq(K.countOrderStatuses(null), { issued: 0, submitted: 0, closed: 0, cancelled: 0, voided: 0, total: 0 },
    'null → 全 0（不抛）');
}

/* ==================================================================== *
 * §2 三端「是转发，不是第二套实现」
 *
 * 判据两条，缺一不可：
 *   ① 必须调用 canonical（cloud: `K.planOrderAggregate(`；workbench: `kitPlanOrderAggregate(`）
 *   ② **不得自己出现无锚点哨兵字面量 `'(无锚点)'`**
 *      —— 这是分叉点①的指纹。谁要重新实现一遍，就必须重新写这个哨兵（或选择丢弃），
 *         也就是重新引入分叉；而「转发」是不需要它的。
 * 另加一条更普适的：不得出现分组累加器的典型写法（`const byPlan = {}` / `by[pid]` /
 * `new Map<string, PlanOrderAggregate>`）。
 * ==================================================================== */

/** 判定单个文件是不是「转发」。返回违规原因数组（空 = 合规）。 */
function relayViolations(src, kind) {
  const bad = [];
  const code = stripComments(src);

  const CALL = kind === 'workbench' ? /kitPlanOrderAggregate\s*\(/ : /K\.planOrderAggregate\s*\(/;
  if (!CALL.test(code)) bad.push(`没有调用 canonical（缺 ${kind === 'workbench' ? 'kitPlanOrderAggregate(' : 'K.planOrderAggregate('}）`);

  if (code.indexOf("'(无锚点)'") >= 0) bad.push("自己出现了无锚点哨兵 '(无锚点)'（分叉点①的指纹）");
  if (code.indexOf('"(无锚点)"') >= 0) bad.push('自己出现了无锚点哨兵 "(无锚点)"');

  const ACC = [/const\s+byPlan\s*=\s*\{\}/, /\bby\[pid\]/, /new Map<\s*string\s*,\s*PlanOrderAggregate\s*>/];
  for (const re of ACC) {
    if (re.test(code)) bad.push('出现第二套分组累加器：' + re.source);
  }
  return bad;
}

/** 剥注释（保留字符串字面量里的内容）。URL 的 `://` 不能被误当行注释。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const TARGETS = [
  { label: '云函数 webAdminQuery（只读）', kind: 'cloud', file: path.join(ROOT, 'cloudfunctions/webAdminQuery/index.js') },
  { label: '小程序 tutorStore', kind: 'mini', file: path.join(ROOT, 'miniprogram/utils/tutorStore.js') },
  {
    label: '工作台 logic/orders.ts', kind: 'workbench',
    file: path.join(process.env.HOME || '', 'Desktop/全科导学专家-小程序/全学科导学工作台/src/logic/orders.ts'),
  },
];

function runRelaySpecs() {
  section('2. 三端必须是「转发」，不得有第二套实现');

  for (const t of TARGETS) {
    if (!fs.existsSync(t.file)) {
      // 单克隆环境下工作台可能不在，跳过不算失败（与 sync-order-kit.mjs 同策略）
      console.log(`  ! 跳过 ${t.label}（文件不存在：${t.file}）`);
      continue;
    }
    const src = fs.readFileSync(t.file, 'utf8');
    const bad = relayViolations(src, t.kind);
    ok(bad.length === 0, `${t.label} 是转发${bad.length ? ' 【' + bad.join('；') + '】' : ''}`);
  }

  /* 2b 反证：把「第二套实现」塞进去，扫描必须报红 */
  const fakeCloud = `
    const K = require('./orderKit');
    function orders(openid, query) {
      const counts = { total: list.length };
      const byPlan = {};
      for (const o of list) {
        const pid = (o.plan && o.plan.planId) || '(无锚点)';
        const gk = (o.openid || '') + '::' + pid;
        if (!byPlan[gk]) byPlan[gk] = { planId: pid, total: 0, lastAt: 0 };
        byPlan[gk].total++;
      }
      return { counts, plans: Object.keys(byPlan).map(k => byPlan[k]) };
    }`;
  const vCloud = relayViolations(fakeCloud, 'cloud');
  ok(vCloud.length >= 3,
    '反证：塞进一份内联第二套实现 → 三类违规全被抓到（' + vCloud.length + ' 条）');

  const fakeMini = `
    const K = require('./orderKit.js');
    function planOrderAggregate() {
      const by = {};
      getOrders().forEach(o => {
        const pid = String((o.plan || {}).planId || '(无锚点)');
        if (!by[pid]) by[pid] = { planId: pid, total: 0, lastAt: 0 };
        by[pid].total++;
      });
      return Object.keys(by).map(k => by[k]);
    }`;
  ok(relayViolations(fakeMini, 'mini').length >= 2,
    '反证：小程序里塞回旧实现 → 被抓到（含 by[pid] 与哨兵字面量）');

  const fakeWb = `
    import { planOrderAggregate as kitPlanOrderAggregate } from '../order-kit/orderKit';
    export function aggregateByPlan(orders) {
      const map = new Map<string, PlanOrderAggregate>();
      return Array.from(map.values());
    }`;
  ok(relayViolations(fakeWb, 'workbench').length >= 1,
    '反证：工作台里塞回旧实现的累加器 → 被抓到');

  /* 2c 反证：把 canonical 调用整个删掉，必须报「没有调用 canonical」 */
  const noCall = "function planOrderAggregate() { return []; }";
  ok(relayViolations(noCall, 'cloud').some((s) => s.indexOf('没有调用 canonical') >= 0),
    '反证：删掉 canonical 调用 → 必须报「没有调用 canonical」');

  /* 2d 剥注释自检：解释性注释里出现 `'(无锚点)'` 不该误判 */
  ok(relayViolations("const K=require('./orderKit');\n/* 哨兵 '(无锚点)' 在 canonical 里 */\nK.planOrderAggregate(x);", 'cloud').length === 0,
    '自检：解释性注释里提到哨兵字面量 → 不误判（剥注释后判）');
  ok(relayViolations("const u='https://x/y';\nconst K=require('./orderKit');\nK.planOrderAggregate(x);", 'cloud').length === 0,
    '自检：URL 里的 // 不被误当注释删掉后半行');
}

/* ==================================================================== *
 * §3 行为级交叉验证：云函数形状的副本与 canonical 输出逐字节相同
 * ==================================================================== */

function runCopyParity() {
  section('3. 副本（云函数形状 CJS）与 canonical 输出逐字节相同');

  const copies = [
    ['云函数 tutorOrder', path.join(ROOT, 'cloudfunctions/tutorOrder/orderKit.js')],
    ['云函数 webAdminWrite', path.join(ROOT, 'cloudfunctions/webAdminWrite/orderKit.js')],
    ['云函数 webAdminQuery', path.join(ROOT, 'cloudfunctions/webAdminQuery/orderKit.js')],
    ['小程序 utils/orderKit.js', path.join(ROOT, 'miniprogram/utils/orderKit.js')],
  ];

  const fixture = [
    ord({ no: 'A1', key: 'math', openid: 'openid-A', status: 'issued', issuedAt: 100 }),
    ord({ no: 'A2', key: 'math', openid: 'openid-A', status: 'submitted', issuedAt: 200, submittedAt: 250 }),
    ord({ no: 'B1', key: 'math', openid: 'openid-B', status: 'issued', issuedAt: 100 }),
    ord({ no: 'C1', key: 'chinese', openid: 'openid-A', status: 'closed', issuedAt: 300 }),
    ord({ no: 'D1', key: '', plan: { planId: '', key: '' }, status: 'issued', issuedAt: 50 }),
    ord({ no: 'E1', key: 'old', plan: { planId: `old@${T0}`, key: 'old' }, createdAt: 900 }),
  ];
  const want = JSON.stringify(K.planOrderAggregate(fixture));

  for (const [label, file] of copies) {
    if (!fs.existsSync(file)) { console.log(`  ! 跳过 ${label}（副本不存在）`); continue; }
    let got;
    try {
      const mod = require(file);
      got = JSON.stringify(mod.planOrderAggregate(fixture));
    } catch (e) {
      ok(false, `${label} 加载/执行失败：${e.message}`);
      continue;
    }
    ok(got === want, `${label} 聚合输出与 canonical 逐字节相同`);

    // 顺带确认新导出确实在副本里（防「副本没重新生成」）
    const mod2 = require(file);
    ok(typeof mod2.countOrderStatuses === 'function', `${label} 也导出了 countOrderStatuses`);
  }

  /* 3b 反证：旧实现喂同一夹具，输出必须与 canonical **不同** ——
     证明这条「相同」的断言不是空比较（若夹具挑得太温和，两边都会一样）。 */
  const legacyOut = JSON.stringify(brief(legacyWorkbenchAggregate(fixture)));
  const kitOut = JSON.stringify(brief(K.planOrderAggregate(fixture)));
  ok(legacyOut !== kitOut,
    '反证：旧实现在同一夹具上的输出与 canonical **不同** → 说明夹具真的覆盖到了三处分叉');
}

/* ==================================================================== *
 * 主流程
 * ==================================================================== */

/**
 * `--counterproof-legacy` 模式：把 canonical 的两个函数**当场换成改造前的旧实现**，
 * 再跑同一批断言 —— 必须变红，否则说明这批断言根本没在检查口径。
 *
 * 为什么用「替换属性」而不是「换一个 require 的目标」：
 *   `K` 是同一个对象引用，断言里都写 `K.planOrderAggregate(...)`，
 *   改写它的属性即可让全部断言走旧实现，不需要改任何一行断言代码。
 *   这样反证证明的是「**这批断言**能抓到分叉」，而不是「我另外写了一段能红的代码」。
 *
 * 为什么不能像其他测试那样用「git 旧基线」：
 *   canonical 是 T23 新写的，git 里根本没有更早的版本可指。
 */
function applyLegacyMutation() {
  // 旧·工作台实现：丢无锚点 + 键不含 openid + lastAt 不兜 createdAt
  K.planOrderAggregate = function (orders) {
    return legacyWorkbenchAggregate(orders).map(function (r) {
      return Object.assign({
        openid: '', subjectName: '', stageName: '', taskName: '', si: 0, ti: 0,
        issued: 0, submitted: 0, closed: 0, cancelled: 0, voided: 0,
        firstIssuedAt: 0, lastIssuedAt: 0, lastSubmittedAt: 0,
      }, r);
    });
  };
  // 旧·计数口径：total 之外还用 `counts[status] !== undefined` 兜，
  // 这里换成「只认五项、total 单独算」的等价写法即可 —— 关键是让 §1b 也走旧路。
  K.countOrderStatuses = function (orders) {
    var c = { issued: 0, submitted: 0, closed: 0, cancelled: 0, voided: 0, total: 0 };
    var list = Array.isArray(orders) ? orders : [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i] || {};
      if (o.status === 'issued' || o.status === 'submitted' || o.status === 'closed'
        || o.status === 'cancelled' || o.status === 'voided') {
        c[o.status]++; c.total++;   // ← 旧口径：未知状态不进 total
      }
    }
    return c;
  };
}

function main() {
  const legacyMode = process.argv.indexOf('--counterproof-legacy') >= 0;
  if (legacyMode) {
    console.log('【反证模式】已把 canonical 换成改造前的旧实现 —— 下面的断言应当变红\n');
    applyLegacyMutation();
  }

  runCanonicalSpecs();
  // §2/§3 与正反证无关：§2 读的是三端源码的静态转发判据，
  // §3 读的是**副本文件**（不受本进程内存里 K 的替换影响）。
  // 旧实现模式下跳过它们，免得把「副本仍与 canonical 一致」的绿混进来冲淡信号。
  if (!legacyMode) {
    runRelaySpecs();
    runCopyParity();
  }

  console.log('\n========================================');
  console.log(`通过 ${passes} 项，失败 ${fails} 项`);
  console.log('========================================');
  return fails === 0;
}

if (require.main === module || process.argv[1] === __filename) {
  const green = main();
  process.exit(green ? 0 : 1);
}

module.exports = { relayViolations, stripComments, legacyWorkbenchAggregate, legacyMiniAggregate };

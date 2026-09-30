/**
 * test-tutor-orders.cjs —— 学习单云函数离线测试台（M2 验收）
 * ==========================================================
 *   node scripts/test-tutor-orders.cjs               跑全部用例
 *   COUNTERPROOF=1 node scripts/test-tutor-orders.cjs  额外跑三组反证（须全部变红）
 *
 * 做法：桩掉 `@cloudbase/node-sdk`，用内存假库驱动**真实云函数源码**
 * （cloudfunctions/tutorOrder/index.js），不部署、不连云、不产生线上脏数据（R8）。
 *
 * 覆盖：
 *   A 出单 O1         —— 缺锚点拒绝 / planId=key@createdAt / 幂等 / copied 幂等
 *   B 回执 O2         —— 三件套校验 / 1:1 锁定 / 重复提交拒绝
 *   C 状态机 O2       —— canTransition 唯一权威，非法跃迁一律 bad_transition
 *   D 作废重开 O4     —— 审计链不断，原单永不删除
 *   E O3 隔离         —— 只写 tutor_orders，绝不触碰 evidence/reviews/mistakes
 *   F 勾选与计划标记   —— tick 幂等 / planOrphan 落地
 *   G webAdminWrite orders 通道 —— 与 tutorOrder 共用同一份状态机；数组批量写被拒
 *
 * 反证（COUNTERPROOF=1 时自动执行；把源码复制到临时目录改坏，须变红后复原）：
 *   1. 放宽 canTransition（把 TRANSITIONS 全通）
 *   2. 摘掉 plan_mismatch 校验
 *   3. 把 already_submitted 改成覆盖写
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* ══════════════════════════════ 假 @cloudbase/node-sdk ══════════════════════════════ */

/** 支持嵌套字段路径（'plan.planId'）的 where 匹配 */
function fieldOf(row, key) {
  if (key.indexOf('.') < 0) return row[key];
  return key.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), row);
}
function matchWhere(row, where) {
  const w = where || {};
  return Object.keys(w).every((k) => fieldOf(row, k) === w[k]);
}
function deep(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }

function createFakeSdk(seed, opts) {
  const o = opts || {};
  const tables = {};
  const touched = {};   // 记录被写过的集合名 —— O3 隔离断言靠它
  let autoId = 0;
  let aiCalls = 0;      // T22：AI 被调了几次 —— 幂等断言靠它（幂等时不该再调 AI）

  function ensure(name) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }
  for (const k of Object.keys(seed || {})) {
    for (const row of seed[k]) {
      const r = deep(row);
      // 云端文档一定带 _id（缺了 doc(id).update 找不到目标）与 openid（缺了 where({openid}) 查不到）。
      // 而云函数出参是**剥过壳**的，所以种子行必须在这里补齐，否则会以为自己种了其实没种上。
      if (r._id === undefined) r._id = 'seed' + (++autoId);
      if (r.openid === undefined) r.openid = OPENID;
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
          rows = rows.slice().sort((a, b) => {
            const av = fieldOf(a, order.k) || 0, bv = fieldOf(b, order.k) || 0;
            return order.d === 'desc' ? bv - av : av - bv;
          });
        }
        return { data: deep(rows.slice(0, lim)) };
      },
      /** ⚠️ node-sdk 语义：update(obj) 键即字段名，无 { data:{} } 包壳 */
      async update(patch) {
        const rows = ensure(name).filter((r) => matchWhere(r, w));
        rows.forEach((r) => Object.assign(r, deep(patch)));
        touched[name] = true;
        return { updated: rows.length };
      },
      async add(obj) {
        const row = Object.assign({ _id: 'id' + (++autoId) }, deep(obj));
        ensure(name).push(row);
        touched[name] = true;
        return { id: row._id };
      },
      doc(id) {
        return {
          async update(patch) {
            const row = ensure(name).find((r) => r._id === id);
            if (!row) throw new Error('no doc ' + id);
            Object.assign(row, deep(patch));
            touched[name] = true;
            return { updated: 1 };
          }
        };
      }
    };
    return api;
  }

  const db = {
    collection,
    async createCollection(name) { ensure(name); }
  };

  /* T22 —— 假 AI 必须**可控**，否则只能测到「回落」这一条路，
     而「润色成功」与「润色稿命中门禁」两条同样关键的路就永远测不到。
     模式：fail（默认，模拟资源包未开通）/ ok / banned（命中禁用词）/ long（超长）/ empty。 */
  const AI_MODE = o.ai || 'fail';
  const AI_TEXT = '这次练了「' + '占位任务' + '」，2 轮共 12 分钟。变式题在提示后完成，边界题没测到。';
  const app = {
    database() { return db; },
    ai() {
      return {
        createModel() {
          return {
            async generateText() {
              aiCalls++;
              if (AI_MODE === 'fail') {
                // 默认：AI 不可用（模拟资源包未开通 / 断网）。润色必须静默回落。
                throw new Error('no_pack: 未开通 Token Credits 资源包');
              }
              if (AI_MODE === 'ok') return { text: AI_TEXT };
              if (AI_MODE === 'banned') return { text: '孩子已经掌握了这次的内容。' };  // 含「掌握」类结论
              if (AI_MODE === 'long') return { text: '很长的评语。'.repeat(60) };        // > 200 字，不合法
              if (AI_MODE === 'empty') return { text: '   ' };                          // 空输出，不合法
              return { text: AI_TEXT };
            }
          };
        }
      };
    }
  };

  return {
    sdk: { init() { return app; } },
    tables,
    touched,
    aiCalls: () => aiCalls,
    aiText: () => AI_TEXT,
    rows: (n) => deep(tables[n] || [])
  };
}

/* ══════════════════════════════ 载入被测云函数 ══════════════════════════════ */

function loadFn(dir, seed, opts) {
  const fake = createFakeSdk(seed, opts);
  const orig = Module._load;
  Module._load = function (req) {
    if (req === '@cloudbase/node-sdk') return fake.sdk;
    return orig.apply(this, arguments);
  };
  // 清缓存：副本目录可能被换过
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(dir) === 0) delete require.cache[k];
  }
  let mod;
  try {
    mod = require(path.join(dir, 'index.js'));
  } finally {
    Module._load = orig;
  }
  return { main: mod.main, fake };
}

/* ══════════════════════════════ 断言器 ══════════════════════════════ */

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    failures.push(name);
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

/* ══════════════════════════════ 夹具 ══════════════════════════════ */

const OPENID = 'o_test_family';
const PLAN_CREATED = 1758000000000;

/** 与小程序 studyPlans[key] 同构的计划任务锚点 */
function planTask(key) {
  return {
    key: key || 'chinese',
    si: 0,
    ti: 0,
    planCreatedAt: PLAN_CREATED,
    subjectName: key === 'math' ? '数学' : '语文',
    stageName: '第一周 · 基础',
    taskName: '拼音声母发音',
    goal: '能说清 b/p 的区别',
    days: 1,
    dueDay: 1,
    startDate: '2026-09-20',
    planUpdatedAt: PLAN_CREATED + 1000,
    scaffoldLevel: 'D1'
  };
}

/** 与 SKILL.md §8.1 格式一致的完整回执原文 */
function receiptText(orderNo) {
  return [
    '【费曼训练证据回执】',
    '训练编号：' + orderNo,
    '知识点与核心目标：拼音声母 b/p 的区别',
    '题目确认情况：已通过镜头确认',
    '首次表现：',
    '- 孩子的解释片段或概述：概述——说 b 是先闭嘴再放开',
    '- 发现的具体问题：把 p 也说成不送气',
    '帮助过程：',
    '- 关键提示及 D 层级：D1 提示摸喉咙感受送气',
    '- 使用时机（提示前孩子说了什么）："p 和 b 一样"',
    '- 提示后改变了什么：说出了送气差别',
    '变式验证：',
    '- 题目：给「爸爸」注音',
    '- 孩子的回答或做法：bà ba',
    '- 是否给予实质提示：是 D1',
    '- 结果：提示后完成',
    '边界验证：',
    '- 问题：「b 和 p 只是大小写不同」对不对',
    '- 孩子的判断及理由：不对，送气不同',
    '- 是否给予实质提示：否',
    '- 结果：独立完成',
    '本次证据支持的结论：能区分送气与否',
    '仍不确定的部分：书写',
    '下次建议：练书写'
  ].join('\n');
}

/* ══════════════════════════════ 用例主体 ══════════════════════════════ */

async function runCases(dir, tag) {
  pass = 0; fail = 0; failures.length = 0;

  const call = async (data, seed) => {
    const { main } = loadFn(dir, seed);
    return main(Object.assign({ userInfo: { openId: OPENID } }, data));
  };
  /** T22 用：返回 {res, fake} —— 既要结果，也要看 AI 被调了几次 */
  const callW = async (data, seed, ai) => {
    const { main, fake } = loadFn(dir, seed, { ai: ai });
    const res = await main(Object.assign({ userInfo: { openId: OPENID } }, data));
    return { res, fake };
  };
  console.log(`\n════ 学习单云函数离线测试（${tag}）════`);

  /* ---------- A 出单 O1 ---------- */
  console.log('\n—— A 出单（O1 单必锚计划）——');
  const A0 = await loadFn(dir, {}).main({ action: 'issue' });
  ok('A1 无 openid → no_openid（不产生无主数据）', A0.ok === false && A0.code === 'no_openid', A0);

  const A1 = await call({ action: 'nope' });
  ok('A2 未知 action → bad_action', A1.ok === false && A1.code === 'bad_action', A1);

  const A2 = await call({ action: 'issue', planTask: { key: 'chinese' }, opts: {} });
  ok('A3 缺 si/ti → no_anchor（绝不无计划自由出单）', A2.ok === false && A2.code === 'no_anchor', A2);

  const A3 = await call({ action: 'issue', planTask: planTask(), opts: { kind: 'concept', minutes: 10 } });
  ok('A4 出单成功', A3.ok === true && A3.order && A3.order.status === 'issued', A3 && A3.order && A3.order.status);
  const O1 = A3.order || {};
  ok('A5 planId = key@plan.createdAt', O1.plan && O1.plan.planId === 'chinese@' + PLAN_CREATED, O1.plan && O1.plan.planId);
  ok('A6 events 首条 = issued（O4 留痕）',
    Array.isArray(O1.events) && O1.events.length === 1 && O1.events[0].type === 'issued', O1.events);
  ok('A7 出参已剥 openid（不漏账号标识）', O1.openid === undefined && O1._id === undefined && O1.cloudId === undefined,
    { openid: O1.openid, _id: O1._id, cloudId: O1.cloudId });

  const A4 = await call({ action: 'issue', planTask: planTask(),
    opts: { kind: 'concept', minutes: 10, clientId: O1.clientId } }, { tutor_orders: [O1] });
  ok('A8 同 clientId 重复出单 → deduped，不新建', A4.ok === true && A4.deduped === true, A4);

  const A5 = await call({ action: 'copied', orderNo: O1.orderNo }, { tutor_orders: [O1] });
  ok('A9 copied 首次 → 追加事件', A5.ok === true && A5.deduped === false &&
    A5.order.events.length === 2 && A5.order.events[1].type === 'copied', A5.order && A5.order.events);
  const A6 = await call({ action: 'copied', orderNo: O1.orderNo }, { tutor_orders: [A5.order] });
  ok('A10 copied 幂等 → 第二次 deduped，事件不膨胀', A6.ok === true && A6.deduped === true, A6.deduped);

  /* ---------- B 回执 O2 ---------- */
  console.log('\n—— B 回执（O2 先选计划再选出单，严格 1:1）——');
  const B0 = await call({ action: 'submit', orderNo: O1.orderNo });
  ok('B1 缺 planId → bad_param（必须先选计划）', B0.ok === false && B0.code === 'bad_param', B0.code);

  const B1 = await call({ action: 'submit', orderNo: O1.orderNo, planId: 'math@999' },
    { tutor_orders: [O1] });
  ok('B2 计划与出单锚点不符 → plan_mismatch',
    B1.ok === false && B1.code === 'plan_mismatch', B1);
  ok('B3 plan_mismatch 回显期望 planId（便于端上定位）',
    B1.expectPlanId === 'chinese@' + PLAN_CREATED, B1.expectPlanId);

  const B2 = await call({ action: 'submit', orderNo: 'TS-NOT-EXIST', planId: 'chinese@' + PLAN_CREATED }, {});
  ok('B4 单不存在 → not_found', B2.ok === false && B2.code === 'not_found', B2.code);

  const B3 = await call({
    action: 'submit', orderNo: O1.orderNo, planId: 'chinese@' + PLAN_CREATED,
    fields: { rawText: receiptText(O1.orderNo), mode: 'standard' },
    quant: { rounds: 2, minutes: 12, selfEval: 3 },
    planCtx: { updatedAt: PLAN_CREATED + 1000, taskExists: true }
  }, { tutor_orders: [O1] });
  ok('B5 正确提交 → status=submitted', B3.ok === true && B3.order.status === 'submitted', B3);
  const S = B3.order || {};
  ok('B6 submittedAt 落库（什么时候回执，可查）', S.submittedAt > 0, S.submittedAt);
  ok('B7 receipt 已落库且 1:1 内嵌', !!S.receipt && S.receipt.rawText.indexOf('费曼训练证据回执') >= 0, !!S.receipt);
  ok('B8 量化项以人工确认为准（2 轮 / 12 分钟）', S.receipt.rounds === 2 && S.receipt.minutes === 12,
    { r: S.receipt.rounds, m: S.receipt.minutes });
  ok('B9 规则评语必出，commentSource=rule（不调 AI）',
    !!S.evaluation && !!S.evaluation.comment && S.evaluation.commentSource === 'rule',
    S.evaluation && S.evaluation.commentSource);
  ok('B10 verdict 只用四值，不含「掌握」类结论',
    [null, '达标', '部分达标', '未达标'].indexOf(S.evaluation.verdict) >= 0, S.evaluation.verdict);
  ok('B11 评语正文无禁用词',
    ['已掌握', '已精通', '学会了', '完全懂了', '完全掌握', '稳稳掌握']
      .every((w) => S.evaluation.comment.indexOf(w) < 0), S.evaluation.comment);
  ok('B12 cycle 汇总必出', !!S.cycle && !!S.cycle.summary, S.cycle && S.cycle.summary);
  const evTypes = (S.events || []).map((e) => e.type);
  ok('B13 events 追加 submitted + evaluated（O4 全链路留痕）',
    evTypes.indexOf('submitted') >= 0 && evTypes.indexOf('evaluated') >= 0, evTypes);
  ok('B14 事件时间递增（出单 → 复制 → 回执，顺序可查）',
    (S.events || []).every((e, i, arr) => i === 0 || e.at >= arr[i - 1].at), evTypes);

  const B4 = await call({ action: 'submit', orderNo: O1.orderNo, planId: 'chinese@' + PLAN_CREATED,
    fields: { rawText: '另一份回执' } }, { tutor_orders: [S] });
  ok('B15 重复提交 → already_submitted（1:1 锁定）',
    B4.ok === false && B4.code === 'already_submitted', B4);
  ok('B16 重复提交回显首次 submittedAt', B4.submittedAt === S.submittedAt, {
    got: B4.submittedAt, want: S.submittedAt
  });

  const afterDup = await call({ action: 'get', orderNo: O1.orderNo }, { tutor_orders: [S] });
  ok('B17 重复提交不产生第二份回执、不改动事件数',
    afterDup.order.receipt.rawText === S.receipt.rawText &&
    afterDup.order.events.length === S.events.length,
    { ev: afterDup.order.events.length, want: S.events.length });

  /* ---------- C 状态机 O2 ---------- */
  console.log('\n—— C 状态机（canTransition 唯一权威）——');
  const C0 = await call({ action: 'close', orderNo: O1.orderNo, reason: 'x' }, { tutor_orders: [O1] });
  ok('C1 issued → closed 非法 → bad_transition', C0.ok === false && C0.code === 'bad_transition', C0);

  const C1 = await call({ action: 'void', orderNo: O1.orderNo }, { tutor_orders: [O1] });
  ok('C2 作废未填原因 → bad_param（留痕必须说明）', C1.ok === false && C1.code === 'bad_param', C1.code);

  const C2 = await call({ action: 'cancel', orderNo: O1.orderNo, reason: '题目抄错' }, { tutor_orders: [O1] });
  ok('C3 issued → cancelled 合法', C2.ok === true && C2.order.status === 'cancelled', C2);
  ok('C4 cancelled 为终态：再 submit → bad_transition',
    (await call({ action: 'submit', orderNo: O1.orderNo, planId: 'chinese@' + PLAN_CREATED }, { tutor_orders: [C2.order] }))
      .code === 'bad_transition', 'expect bad_transition');

  const C3 = await call({ action: 'cancel', orderNo: O1.orderNo, reason: '再来一次' }, { tutor_orders: [S] });
  ok('C5 submitted → cancelled 非法（只能 closed/voided）',
    C3.ok === false && C3.code === 'bad_transition', C3);

  const C4 = await call({ action: 'close', orderNo: O1.orderNo }, { tutor_orders: [S] });
  ok('C6 submitted → closed 合法且记 closedAt', C4.ok === true && C4.order.status === 'closed' && C4.order.closedAt > 0,
    { st: C4.order.status, at: C4.order.closedAt });
  const C5 = await call({ action: 'close', orderNo: O1.orderNo }, { tutor_orders: [C4.order] });
  ok('C7 closed → closed 非法', C5.ok === false && C5.code === 'bad_transition', C5.code);
  const C6 = await call({ action: 'void', orderNo: O1.orderNo, reason: '归档后要撤' }, { tutor_orders: [C4.order] });
  ok('C8 closed → voided 合法（保留可追溯的撤回）',
    C6.ok === true && C6.order.status === 'voided' && !!C6.order.voidReason, C6.order && C6.order.voidReason);

  /* ---------- D 作废重开 O4 ---------- */
  console.log('\n—— D 作废重开（O4 审计链不断）——');
  const D0 = await call({ action: 'reissue', orderNo: O1.orderNo }, { tutor_orders: [S] });
  ok('D1 重开未填原因 → bad_param', D0.ok === false && D0.code === 'bad_param', D0.code);

  const fresh = await call({ action: 'issue', planTask: planTask(), opts: { kind: 'concept', minutes: 10 } });
  const O2 = fresh.order;
  const D1 = await call({ action: 'reissue', orderNo: O2.orderNo, reason: '孩子当天发烧没做' },
    { tutor_orders: [O2] });
  ok('D2 重开成功：原单作废', D1.ok === true && D1.voided.status === 'voided', D1.voided && D1.voided.status);
  ok('D3 原单事件全部保留（审计链不断）', D1.voided.events.length >= 2, D1.voided && D1.voided.events.length);
  ok('D4 新单 reissueOf 指向原单', D1.order.reissueOf === O2.orderNo, D1.order && D1.order.reissueOf);
  ok('D5 新单沿用原单锚点与 planId（不漂移）',
    D1.order.plan.planId === O2.plan.planId && D1.order.plan.si === O2.plan.si && D1.order.plan.ti === O2.plan.ti,
    D1.order && D1.order.plan);
  ok('D6 新单为 issued 且新编号', D1.order.status === 'issued' && D1.order.orderNo !== O2.orderNo,
    { st: D1.order.status, no: D1.order.orderNo });
  ok('D7 新单 issued 事件注明 reissueOf',
    D1.order.events[0].detail.indexOf('reissueOf=' + O2.orderNo) >= 0, D1.order.events[0].detail);

  /* ---------- E O3 隔离 ---------- */
  console.log('\n—— E O3 隔离（回执 ≠ 证据）——');
  const { main: mIso, fake: fIso } = loadFn(dir, { tutor_orders: [O1] });
  await mIso({ userInfo: { openId: OPENID }, action: 'submit', orderNo: O1.orderNo,
    planId: 'chinese@' + PLAN_CREATED, fields: { rawText: receiptText(O1.orderNo) } });
  const written = Object.keys(fIso.touched);
  ok('E1 只写 tutor_orders 一个集合', written.length === 1 && written[0] === 'tutor_orders', written);
  ok('E2 未创建/未触碰 tutor_evidence', (fIso.rows('tutor_evidence').length === 0), fIso.rows('tutor_evidence').length);
  ok('E3 未触碰 tutor_reviews / tutor_mistakes',
    fIso.rows('tutor_reviews').length === 0 && fIso.rows('tutor_mistakes').length === 0, written);
  ok('E4 落库文档不含任何「已掌握 / 已精通」结论',
    JSON.stringify(fIso.rows('tutor_orders')).indexOf('已掌握') < 0 &&
    JSON.stringify(fIso.rows('tutor_orders')).indexOf('已精通') < 0, 'banned word found');

  /* ---------- F 勾选与计划标记 ---------- */
  console.log('\n—— F 勾选计划任务与计划漂移标记 ——');
  const F0 = await call({ action: 'tick', orderNo: O2.orderNo }, { tutor_orders: [D1.voided] });
  ok('F1 已作废单不能勾选 → bad_transition', F0.ok === false && F0.code === 'bad_transition', F0.code);

  const F1 = await call({ action: 'tick', orderNo: D1.order.orderNo }, { tutor_orders: [D1.order] });
  ok('F2 tick 成功 → cycle.tickApplied=true', F1.ok === true && F1.order.cycle.tickApplied === true, F1.order && F1.order.cycle);
  ok('F3 追加 ticked 事件', (F1.order.events || []).some((e) => e.type === 'ticked'),
    (F1.order.events || []).map((e) => e.type));
  const F2 = await call({ action: 'tick', orderNo: D1.order.orderNo }, { tutor_orders: [F1.order] });
  ok('F4 tick 幂等 → 第二次 deduped', F2.ok === true && F2.deduped === true, F2.deduped);

  const F3 = await call({ action: 'submit', orderNo: D1.order.orderNo, planId: 'chinese@' + PLAN_CREATED,
    fields: { rawText: receiptText(D1.order.orderNo) },
    planCtx: { updatedAt: PLAN_CREATED + 999999, taskExists: false } },
  { tutor_orders: [D1.order] });
  ok('F5 计划已改 → cycle.planDrift=true', F3.order.cycle.planDrift === true, F3.order.cycle.planDrift);
  ok('F6 任务已删 → cycle.planOrphan=true', F3.order.cycle.planOrphan === true, F3.order.cycle.planOrphan);
  ok('F7 漂移/孤儿不拒绝、不丢数据，只在汇总里说明',
    F3.ok === true && F3.order.status === 'submitted' &&
    F3.order.cycle.summary.indexOf('计划在出单后被改动') >= 0 &&
    F3.order.cycle.summary.indexOf('已不存在') >= 0, F3.order.cycle.summary);

  /* ---------- G list / AI 润色回落 ---------- */
  console.log('\n—— G 列表聚合与 AI 润色静默回落 ——');
  const G0 = await call({ action: 'list', planId: 'chinese@' + PLAN_CREATED },
    { tutor_orders: [O1, S, C4.order, C6.order, D1.voided, D1.order] });
  ok('G1 list 按 planId 过滤（含同单不同状态的快照）',
    G0.ok === true && G0.orders.length === 6, G0.orders && G0.orders.length);
  ok('G2 list 回状态计数（计划 1:N 出单可视化）',
    G0.counts.total === 6 && G0.counts.issued === 2 && G0.counts.submitted === 1 &&
    G0.counts.closed === 1 && G0.counts.voided === 2, G0.counts);
  ok('G3 list 剥 openid', G0.orders.every((o) => o.openid === undefined), G0.orders[0] && G0.orders[0].openid);

  const G1 = await call({ action: 'polish', orderNo: O1.orderNo }, { tutor_orders: [S] });
  ok('G4 AI 不可用 → 不报错（闭环优先）', G1.ok === true, G1);
  ok('G5 AI 失败静默回落 rule', G1.order.evaluation.commentSource === 'rule' && G1.polishFailed === true,
    G1.order.evaluation.commentSource);
  ok('G6 回落也写 polished 事件（失败也要留痕）',
    (G1.order.events || []).some((e) => e.type === 'polished'), (G1.order.events || []).map((e) => e.type));

  /* ---------- H webAdminWrite orders 通道 ---------- */
  console.log('\n—— H webAdminWrite「订单」通道（与 tutorOrder 共用状态机）——');
  const W_DIR = path.join(ROOT, 'cloudfunctions/webAdminWrite');
  process.env.WEB_DASHBOARD_TOKEN = 'ADMIN-TOK';
  process.env.WEB_ADMIN_ALLOW_WRITE = '1';

  const wSeed = {
    web_portal_bindings: [{ _id: 'bd', token: 'USER-TOK', openid: OPENID, revoked: false }],
    tutor_orders: []
  };
  const loadW = (seed) => {
    const fake = createFakeSdk(seed);
    const orig = Module._load;
    Module._load = function (req) {
      if (req === '@cloudbase/node-sdk') return fake.sdk;
      return orig.apply(this, arguments);
    };
    for (const k of Object.keys(require.cache)) {
      if (k.indexOf(W_DIR) === 0) delete require.cache[k];
    }
    let mod;
    try { mod = require(path.join(W_DIR, 'index.js')); } finally { Module._load = orig; }
    return { main: mod.main, fake };
  };
  const wCall = async (data, seed) => loadW(seed || wSeed).main(data);

  const H0 = await wCall({ token: 'WRONG', orders: { action: 'list' } });
  ok('H1 错口令 → auth', H0.ok === false && H0.code === 'auth', H0.code);

  const H1 = await wCall({ token: 'USER-TOK', orders: [] });
  ok('H2 orders 传数组 → bad_param（拒绝批量覆盖写）',
    H1.ok === false && H1.code === 'bad_param', H1);

  const H2 = await wCall({ token: 'USER-TOK', orders: { action: 'not_a_real_action' } });
  ok('H3 未知 order action → bad_action', H2.ok === false && H2.code === 'bad_action', H2.code);

  const H3 = await wCall({ token: 'USER-TOK', orders: { action: 'issue', planTask: planTask(), opts: { kind: 'concept' } } });
  ok('H4 网页通道出单成功（openid 来自绑定口令）', H3.ok === true && H3.order.status === 'issued', H3);
  ok('H5 网页出单与小程序同源：planId 格式一致',
    H3.order.plan.planId === 'chinese@' + PLAN_CREATED, H3.order.plan.planId);

  const H4 = await wCall({ token: 'USER-TOK', orders: { action: 'submit', orderNo: H3.order.orderNo,
    planId: 'chinese@' + PLAN_CREATED, fields: { rawText: receiptText(H3.order.orderNo) } } },
  { web_portal_bindings: wSeed.web_portal_bindings, tutor_orders: [H3.order] });
  ok('H6 网页通道交回执成功', H4.ok === true && H4.order.status === 'submitted', H4);
  const H5 = await wCall({ token: 'USER-TOK', orders: { action: 'submit', orderNo: H3.order.orderNo,
    planId: 'chinese@' + PLAN_CREATED, fields: { rawText: 'x' } } },
  { web_portal_bindings: wSeed.web_portal_bindings, tutor_orders: [H4.order] });
  ok('H7 1:1 锁定在两个通道同样生效 → already_submitted',
    H5.ok === false && H5.code === 'already_submitted', H5);
  const H6 = await wCall({ token: 'USER-TOK', orders: { action: 'submit', orderNo: H3.order.orderNo, planId: 'other@1' } },
    { web_portal_bindings: wSeed.web_portal_bindings, tutor_orders: [H3.order] });
  ok('H8 plan_mismatch 在两个通道同样生效', H6.ok === false && H6.code === 'plan_mismatch', H6);

  /* ---- H9–H11：云端代解析回执原文（T21-b；网页看板唯一可行的提交形态）----
   * 网页是 1.4MB 内联单文件，拿不到 order-kit，**没有** parseReceiptText 可用。
   * 若让网页自己解析，同一段回执在三端会算出三种 verdict —— 而 verdict 是
   * 「活动 ≠ 证据 ≠ 掌握」的唯一判据。所以网页只提交 rawText，由云端用
   * canonical 解析器抽取；H9 锁这条通路，H10 锁「fields 优先」不被破坏（小程序通道不受影响）。
   */
  const H7 = await wCall({ token: 'USER-TOK', orders: { action: 'issue', planTask: planTask(), opts: { kind: 'concept' } } },
    { web_portal_bindings: wSeed.web_portal_bindings, tutor_orders: [H3.order] });
  ok('H9a 为 rawText 通路另开一张新单', H7.ok === true && H7.order.status === 'issued', H7.code);

  const H8 = await wCall({ token: 'USER-TOK', orders: {
    action: 'submit', orderNo: H7.order.orderNo, planId: 'chinese@' + PLAN_CREATED,
    rawText: receiptText(H7.order.orderNo), parsedBy: 'rule' } },
  { web_portal_bindings: wSeed.web_portal_bindings, tutor_orders: [H3.order, H7.order] });
  ok('H9b 只给 rawText（不给 fields）也能交回执 —— 云端用 canonical 解析器抽取',
    H8.ok === true && H8.order.status === 'submitted' && !!H8.order.evaluation, H8.code);
  ok('H9c 解析结果真的落到 receipt 上（不是空回执）',
    !!(H8.order.receipt && H8.order.receipt.topic && H8.order.receipt.childQuote),
    H8.order.receipt && JSON.stringify({ t: H8.order.receipt.topic, c: H8.order.receipt.childQuote }));
  ok('H9d 出参回传 parsed.missing，供端上提示缺哪几项（提示，不是拒绝）',
    !!(H8.parsed && Array.isArray(H8.parsed.missing)), JSON.stringify(H8.parsed));
  ok('H9e verdict 由引擎判定，不因「缺项」而拒绝提交',
    H8.order.evaluation.verdict === null || typeof H8.order.evaluation.verdict === 'string',
    String(H8.order.evaluation.verdict));

  /* H10：fields 优先 —— 传了 fields 时 rawText 不得覆盖它（小程序通道语义不变） */
  const H9 = await wCall({ token: 'USER-TOK', orders: { action: 'issue', planTask: planTask(), opts: { kind: 'concept' } } },
    { web_portal_bindings: wSeed.web_portal_bindings, tutor_orders: [H3.order, H7.order, H8.order] });
  const H10 = await wCall({ token: 'USER-TOK', orders: {
    action: 'submit', orderNo: H9.order.orderNo, planId: 'chinese@' + PLAN_CREATED,
    fields: { topic: '端上已确认的主题', variantResult: '独立完成', boundaryResult: '独立完成' },
    rawText: receiptText(H9.order.orderNo) } },     // rawText 里另有主题，必须**不**生效
  { web_portal_bindings: wSeed.web_portal_bindings, tutor_orders: [H3.order, H7.order, H8.order, H9.order] });
  ok('H10 fields 优先于 rawText（小程序通道语义不被改变）',
    H10.ok === true && H10.order.receipt.topic === '端上已确认的主题',
    H10.order.receipt && H10.order.receipt.topic);
  ok('H10b 传了 fields 时 parsed 为 null（不声称做过云端解析）',
    H10.parsed === null || H10.parsed === undefined, JSON.stringify(H10.parsed));

  /* H11：两个通道都写不进 status/events —— 端上从来不是权威 */
  const H11 = await wCall({ token: 'USER-TOK', orders: { action: 'issue', planTask: planTask(),
    opts: { kind: 'concept' }, status: 'closed', events: [] } },
  { web_portal_bindings: wSeed.web_portal_bindings, tutor_orders: [] });
  ok('H11 端上直传 status/events 不生效（新单仍是 issued）',
    H11.ok === true && H11.order.status === 'issued', H11.order && H11.order.status);

  /* H12：管理端通道**不得**放行 polish —— 这是写边界的规格锁。
   *
   * 为什么必须锁死：polish 是**openid 通道专用**动作（只有 tutorOrder 持有 AI 调用能力），
   * 它刻意**不在** canonical ACTIONS 里。一旦有人图省事把 polish 加进 ACTIONS，
   * webAdminWrite 的白名单会立刻放行它，而 orderActions['polish'] 根本不存在
   * → 变成 order_error 甚至崩。更根本的是：网页/工作台的定位是「只读消费评语」，
   * 给它们开一个 AI 写动作，等于把「网页只写 orders」这条边界悄悄扩大。
   * 所以这里反向锁：管理端调 polish 必须被 bad_action 挡下。 */
  const H12 = await wCall({ token: 'USER-TOK', orders: { action: 'polish', orderNo: 'TS-ANY' } });
  ok('H12 管理端通道拒绝 polish → bad_action（网页/工作台只读消费评语，不新增 AI 写通道）',
    H12.ok === false && H12.code === 'bad_action', H12);

  /* ---------- P AI 润色（T22；话术层，失败绝不阻塞闭环） ---------- */
  console.log('\n—— P AI 润色（T22 话术层）——');

  const P_issue = await call({ action: 'issue', planTask: planTask(), opts: { kind: 'concept', minutes: 10 } });
  const P_sub = await call({
    action: 'submit', orderNo: P_issue.order.orderNo, planId: 'chinese@' + PLAN_CREATED,
    fields: { rawText: receiptText(P_issue.order.orderNo), mode: 'standard' },
    quant: { rounds: 2, minutes: 12, selfEval: 3 }
  }, { tutor_orders: [P_issue.order] });
  const RULE_ORDER = P_sub.order;
  ok('P1 前置：已回执单带规则评语（commentSource=rule）',
    !!RULE_ORDER && !!RULE_ORDER.evaluation.comment && RULE_ORDER.evaluation.commentSource === 'rule',
    RULE_ORDER && RULE_ORDER.evaluation && RULE_ORDER.evaluation.commentSource);

  // P2/P3/P4 前置校验：没有规则评语就没有「可润色的对象」
  const P2 = await call({ action: 'polish', orderNo: P_issue.order.orderNo }, { tutor_orders: [P_issue.order] });
  ok('P2 未回执的单 → bad_transition（无规则评语可改）',
    P2.ok === false && P2.code === 'bad_transition', P2);
  const P3 = await call({ action: 'polish' });
  ok('P3 缺 orderNo → bad_param', P3.ok === false && P3.code === 'bad_param', P3.code);
  const P4 = await call({ action: 'polish', orderNo: 'TS-NOPE' }, {});
  ok('P4 单不存在 → not_found', P4.ok === false && P4.code === 'not_found', P4.code);

  /* P5 成功路径 —— 只有把假 AI 切成可用，才测得到这条路 */
  const P5w = await callW({ action: 'polish', orderNo: RULE_ORDER.orderNo }, { tutor_orders: [RULE_ORDER] }, 'ok');
  const P5 = P5w.res;
  ok('P5 润色成功 → commentSource 变 ai', P5.ok === true && P5.order.evaluation.commentSource === 'ai',
    P5.order && P5.order.evaluation && P5.order.evaluation.commentSource);
  ok('P5b 评语正文换成了 AI 稿', P5.order.evaluation.comment === P5w.fake.aiText(),
    P5.order.evaluation.comment);
  ok('P5c polishFailed=false（成功就是成功）', P5.polishFailed === false, P5.polishFailed);
  ok('P5d verdict **未被 AI 改动**（AI 无权参与判定）',
    P5.order.evaluation.verdict === RULE_ORDER.evaluation.verdict,
    { before: RULE_ORDER.evaluation.verdict, after: P5.order.evaluation.verdict });
  ok('P5e 事实层未被改动（receipt / cycle 原样）',
    JSON.stringify(P5.order.receipt) === JSON.stringify(RULE_ORDER.receipt) &&
    JSON.stringify(P5.order.cycle) === JSON.stringify(RULE_ORDER.cycle),
    'receipt/cycle 有变');
  const p5ev = P5.order.events || [];
  ok('P5f 追加恰好一条 polished 事件（by=ai，O4 留痕）',
    p5ev.length === RULE_ORDER.events.length + 1 &&
    p5ev[p5ev.length - 1].type === 'polished' && p5ev[p5ev.length - 1].by === 'ai',
    p5ev.map((e) => e.type + '/' + e.by));
  ok('P5g O3：润色只写 tutor_orders，不碰证据/错题/复测集合',
    Object.keys(P5w.fake.touched).every((k) => k === 'tutor_orders'),
    Object.keys(P5w.fake.touched));

  /* P6 幂等 —— 已是 ai 就不再调 AI、不再追加事件 */
  const P6w = await callW({ action: 'polish', orderNo: RULE_ORDER.orderNo }, { tutor_orders: [P5.order] }, 'ok');
  const P6 = P6w.res;
  ok('P6 已润色再次调用 → deduped', P6.ok === true && P6.deduped === true, P6.deduped);
  ok('P6b 幂等时**没有**再调 AI（不白烧 token）', P6w.fake.aiCalls() === 0, P6w.fake.aiCalls());
  ok('P6c 幂等时不追加 polished 事件（事件不膨胀）',
    (P6.order.events || []).length === p5ev.length, (P6.order.events || []).length);

  /* P7 四条失败路径一律**静默回落**，且闭环仍 ok:true ——
   * 这是 T22 的核心验收：「AI 不可用时闭环仍 100% 走通」。
   * 四种失败成因不同（不可用 / 命中禁用词 / 输出超长 / 空输出），必须都覆盖：
   * 只测「不可用」会漏掉「模型能回话但回话不合法」这半边。 */
  const FAIL_MODES = [
    ['fail', '资源包未开通 / 断网'],
    ['banned', '润色稿命中禁用词（含掌握类结论）'],
    ['long', '输出超长（>200 字）'],
    ['empty', '输出为空']
  ];
  for (const [mode, why] of FAIL_MODES) {
    const Fw = await callW({ action: 'polish', orderNo: RULE_ORDER.orderNo }, { tutor_orders: [RULE_ORDER] }, mode);
    const R = Fw.res;
    const ev = (R.order && R.order.events) || [];
    const last = ev[ev.length - 1] || {};
    ok('P7[' + mode + '] ' + why + ' → 仍返回 ok:true（闭环不被话术层拖垮）',
      R.ok === true, R);
    ok('P7[' + mode + '] 评语回落为规则版（commentSource 保持 rule，正文未变）',
      R.polishFailed === true &&
      R.order.evaluation.commentSource === 'rule' &&
      R.order.evaluation.comment === RULE_ORDER.evaluation.comment,
      R.order.evaluation.commentSource);
    ok('P7[' + mode + '] 失败也留痕：追加 polished 事件且 detail 写明回落原因',
      last.type === 'polished' && String(last.detail || '').indexOf('回落') >= 0,
      last);
  }

  /* P8 规格锁：polish 不在 canonical ACTIONS 里。
   * 与 H12 是一对 —— H12 从**行为**锁（管理端拒绝），P8 从**数据**锁（白名单不含它）。
   * 两条同时成立，才说明「polish 是 openid 通道专用」这个设计真的落到了代码里。 */
  const OA_API = require(path.join(dir, 'orderActions'));
  ok('P8 canonical ACTIONS 不含 polish（它是 openid 通道专用，不进三端共享状态机）',
    OA_API.ACTIONS.indexOf('polish') < 0, OA_API.ACTIONS.join(','));
  ok('P8b ACTIONS 与文档一致（10 个动作，不含 polish）',
    OA_API.ACTIONS.length === 10, OA_API.ACTIONS.length);

  console.log('\n' + '─'.repeat(52));
  if (fail === 0) console.log(`通过 ${pass} / 共 ${pass}   ✓ 全部通过`);
  else console.log(`通过 ${pass} / 共 ${pass + fail}   ✗ 有 ${fail} 项失败：${failures.join(' / ')}`);
  return fail === 0;
}

/* ══════════════════════════════ 反证 ══════════════════════════════ */

/** 把 tutorOrder 副本复制到临时目录，改坏 orderActions.js，跑同一套用例 —— 必须变红 */
function counterproof() {
  const src = path.join(ROOT, 'cloudfunctions/tutorOrder');
  const CASES = [
    {
      name: '反证 1：放宽 canTransition（TRANSITIONS 全通）',
      file: 'orderKit.js',
      from: "issued: ['submitted', 'cancelled', 'voided'],",
      to: "issued: ['submitted', 'cancelled', 'voided', 'closed'],"
    },
    {
      name: '反证 2：摘掉 plan_mismatch 校验',
      file: 'orderActions.js',
      from: "      if (anchorPlanId !== planId) {",
      to: "      if (false) {"
    },
    {
      name: '反证 3：already_submitted 改成覆盖写（放行重复提交）',
      file: 'orderActions.js',
      from: "      if (doc.status === 'submitted' || doc.status === 'closed') {",
      to: "      if (false) {"
    }
  ];

  let bad = 0;
  for (const c of CASES) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'order-cp-'));
    for (const f of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, f), path.join(tmp, f));
    }
    const target = path.join(tmp, c.file);
    const orig = fs.readFileSync(target, 'utf8');
    if (orig.indexOf(c.from) < 0) {
      console.log(`  ✗ ${c.name} —— 反证锚点未命中，测试台已失效，必须修`);
      bad++;
      continue;
    }
    fs.writeFileSync(target, orig.replace(c.from, c.to), 'utf8');
    let red = false;
    try {
      execFileSync(process.execPath, [__filename, '--cases-only'], {
        env: Object.assign({}, process.env, { TO_DIR: tmp, COUNTERPROOF: '' }),
        stdio: 'pipe'
      });
    } catch (e) {
      red = true;
    }
    if (red) console.log(`  ✓ ${c.name} → 变红（测试确实能抓到）`);
    else { console.log(`  ✗ ${c.name} → 没变红，测试抓不到这个 bug`); bad++; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return bad === 0;
}

/* ══════════════════════════════ 入口 ══════════════════════════════ */

(async () => {
  const onlyCases = process.argv.indexOf('--cases-only') >= 0;
  const dir = process.env.TO_DIR || path.join(ROOT, 'cloudfunctions/tutorOrder');
  const tag = process.env.TO_DIR ? '反证副本' : '真实源码';

  const green = await runCases(dir, tag);

  let cpGreen = true;
  if (!onlyCases && process.env.COUNTERPROOF === '1') {
    console.log('\n════ 反证（改坏源码 / 摘掉契约 → 测试必须变红）════');
    cpGreen = counterproof();
    console.log(cpGreen ? '\n反证全部有效 ✓' : '\n反证失效 ✗ —— 测试形同虚设');
  }

  process.exit(green && cpGreen ? 0 : 1);
})().catch((e) => { console.error('未捕获异常：', e); process.exit(1); });

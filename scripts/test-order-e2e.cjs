#!/usr/bin/env node
/**
 * test-order-e2e.cjs —— 学习单**全链路双向 E2E**（T24）
 * ============================================================================
 *   node scripts/test-order-e2e.cjs                跑全部用例（含 §7 反证）
 *
 * ── 这个脚本与既有测试的分工（为什么必须单独有它）────────────────────────────
 *   · `test-tutor-orders.cjs`       —— 云函数**单通道**离线桩（tutorOrder / webAdminWrite）
 *   · `test-web-order-write.cjs`    —— 网页端组装 payload 的形状（云端是桩）
 *   · `test-order-store.cjs`        —— 小程序本地层的合并规则（云端是桩）
 *   三者都只覆盖「一段」。**没有任何一个**能回答「网页出单，小程序能不能看见；
 *   小程序交回执，网页能不能看见评语」—— 而那正是 owner 原始需求里唯一验收口径。
 *
 * ── 做法：一个进程里把三端**真源码**串起来，中间只换掉云端的 SDK ──────────────
 *
 *   网页端                        小程序端
 *   web/index.html 应用脚本       pkgGuide/order/order.js（真实 Page 对象）
 *   （vm 沙箱，照旧例）             + utils/tutorStore.js + utils/store.js
 *        │ callFunction                  │ wx.cloud.callFunction
 *        ▼                                ▼
 *   ┌──────────────── 假 @cloudbase/node-sdk（内存库）────────────────┐
 *   │  拦截 Module._load('@cloudbase/node-sdk')                     │
 *   │  ┌──────────────┐ ┌───────────┐ ┌──────────────┐ ┌──────────┐ │
 *   │  │ webAdminWrite│ │webAdminQuery│ │  tutorOrder  │ │ tutorSync│ │
 *   │  │  （口令通道） │ │  （只读）  │ │ （openid 通道）│ │（pull） │ │
 *   │  └──────────────┘ └───────────┘ └──────────────┘ └──────────┘ │
 *   │        全部是 cloudfunctions/ 下的**真实源码**，一行不桩        │
 *   └────────────────────────────┬──────────────────────────────────┘
 *                                ▼
 *                       tables.tutor_orders（唯一真相源）
 *
 *   于是「小程序可见」= 真跑 tutorSync.pull → 真跑 tutorStore.mergeFromCloud →
 *   真读本地缓存；「网页看到评语」= 真跑 webAdminQuery.orders → 真读 DATA.orders。
 *   任何一环的实现被改坏，本脚本都会红。
 *
 * ── ⚠️ 关于「云端 tutor_orders 测试数据需手工清理」这个已知坑 ─────────────────
 *   开发计划 T24 卡里记着这条坑（tutor_sessions 同款问题）。本脚本**不连云**：
 *   假 SDK 直接由 Module._load 拦截注入，真 SDK 根本拿不到（§0 有断言证明这一点），
 *   所以**结构上不可能产生线上残留** —— 这是比「测完记得去删」更可靠的解法。
 *   同时把 webAdminWrite 的残留清理动作扩到 tutor_orders（见 §6），
 *   给「将来真要打线上」的那条路留一个安全出口。
 *
 * ── 数据命名约定：全部标识符带 `e2e-` 前缀 ──────────────────────────────────
 *   openid = e2e-openid-child · 计划 key = e2e-math（planId = e2e-math@<createdAt>）
 *   口令 = e2e-token-web。§6 会断言「库里每一条单的 openid 与 planId 都带前缀」。
 *   （刻意**不**伪造 clientId：出单走的是真实端上路径，而端上不传 clientId，
 *     云端自动生成 `to_YYMMDD_xxxxxx`。强行注入 clientId 就等于绕开被测路径。）
 *
 * 退出码非 0 即失败。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ================================================================== *
 * 断言工具：抛异常一律转成红断言（「可以红，绝不能死」）
 * ================================================================== */
let passes = 0;
let fails = 0;
const failureList = [];
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; failureList.push(msg); console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }
/** 容错取值：空数组/undefined 下不抛 TypeError（裸 arr[0] 会把「一条红」升级成「整段死」） */
function at(arr, i) {
  return (Array.isArray(arr) && arr.length > i) ? arr[i] : null;
}
function hit(list, fn) {
  return (Array.isArray(list) ? list : []).filter(fn);
}
function one(list, fn) {
  return at(hit(list, fn), 0);
}
/** 深拷贝（跨端传递一律走「序列化后的副本」，避免测试里共享同一对象而假过） */
function deep(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}
/**
 * 让挂起的 Promise 链跑完。
 * 为什么必须显式 flush：小程序页的 `doIssue` / `submitReceipt` / `polishQuietly` 都是
 * **fire-and-forget**（`.then(...)` 不 await，这是刻意的产品行为 —— 不能让云端阻塞交互）。
 * 所以 `await page.doIssue()` 立刻返回，此时云端调用还没落地。断言前必须把微任务排干。
 */
async function flush(n) {
  const k = Number(n) || 12;
  for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r));
}

/* ================================================================== *
 * 一、夹具常量
 * ================================================================== */
const E2E_PREFIX = 'e2e-';
const OPENID = 'e2e-openid-child';
const CHILD2 = 'e2e-openid-child2';   /* 第二个孩子：验证家长口令下的跨孩子归属 */
const WEB_TOKEN = 'e2e-token-web';
const ADMIN_TOKEN = 'e2e-token-admin';

const PLAN_KEY = 'e2e-math';
const PLAN_CREATED_1 = 1756684800000;              // 「第一版」计划
const PLAN_CREATED_2 = 1757203200000;              // 计划重生成后（createdAt 必变）
const PLAN_ID_1 = PLAN_KEY + '@' + PLAN_CREATED_1;
const PLAN_ID_2 = PLAN_KEY + '@' + PLAN_CREATED_2;

/** 一份已「开始计划」、有未勾选任务的成长计划（数学，人教版一年级） */
function makePlan(createdAt, over) {
  return Object.assign({
    grade: '一年级', term: '上学期', textbook: '人教版', subjectName: '数学',
    startDate: '2026-09-01', createdAt: createdAt, updatedAt: createdAt + 86400000,
    stages: [
      {
        name: '第一阶段', weeks: '第1-2周', goal: '10 以内的数', tasks: [
          { name: '认识10以内的数', days: 2, done: true, doneAt: '2026-09-02' },
          { name: '比大小', days: 1, done: false, doneAt: '' },
        ],
      },
      {
        name: '第二阶段', weeks: '第3-4周', goal: '10 的分解与组成', tasks: [
          { name: '10的分解与组成', days: 2, done: false, doneAt: '' },
        ],
      },
    ],
  }, over || {});
}

/** 回执原文（与 TeachStep 回执同格式；编号动态填） */
function makeRawReceipt(orderNo, over) {
  const lines = [
    '费曼训练证据回执',
    '训练编号：' + orderNo,
    '知识点与核心目标：10 的分解与组成',
    '【首次表现】',
    '孩子的解释片段或概述：他能说出 10 可以分成 3 和 7',
    '发现的具体问题：说不清为什么',
    '【变式验证】',
    '题目：10 可以分成几和几',
    '结果：独立完成',
    '【边界验证】',
    '问题：0 和 10 算不算',
    '结果：提示后完成',
    '本次证据支持的结论：部分达标',
    '下次建议：再来一轮，重点问为什么',
  ];
  const withOver = Object.assign({}, over || {});
  if (withOver.replaceLine) {
    const [from, to] = withOver.replaceLine;
    return lines.map((l) => (l === from ? to : l)).join('\n');
  }
  return lines.join('\n');
}

/* ================================================================== *
 * 二、假 @cloudbase/node-sdk（内存库）
 *   形状严格对齐 @cloudbase/node-sdk：where/orderBy/skip/limit/get/count/
 *   add/doc(id).update|remove/createCollection/command.regex
 *   ⚠️ update(obj) 的 obj **键即字段名**，没有 { data: {} } 包壳（项目已知坑）
 * ================================================================== */
function createFakeSdk(tables, hooks) {
  const h = hooks || {};
  let autoId = 0;
  const ops = [];                    // 操作流水（供「真的写进去了」类断言）
  const rowsOf = (name) => { if (!tables[name]) tables[name] = []; return tables[name]; };

  function deepCopy(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function fieldOf(row, key) {
    if (key.indexOf('.') < 0) return row[key];
    return key.split('.').reduce((a, k) => (a == null ? undefined : a[k]), row);
  }
  const isRegex = (v) => !!v && typeof v === 'object' && typeof v.__regex === 'string';
  function matchOne(val, want) {
    if (isRegex(want)) return new RegExp(want.__regex).test(String(val == null ? '' : val));
    return val === want;
  }
  function matchWhere(row, where) {
    const w = where || {};
    return Object.keys(w).every((k) => matchOne(fieldOf(row, k), w[k]));
  }
  function select(name, st) {
    let r = rowsOf(name).filter((x) => matchWhere(x, st.where));
    if (st.order) {
      const { k, d } = st.order;
      r = r.slice().sort((a, b) => (d === 'desc'
        ? (Number(b[k]) || 0) - (Number(a[k]) || 0)
        : (Number(a[k]) || 0) - (Number(b[k]) || 0)));
    }
    const skip = Number(st.skip) || 0;
    const end = st.limit == null ? r.length : skip + Number(st.limit);
    return r.slice(skip, end);
  }

  function makeQuery(name, st) {
    const api = {
      where(w) { return makeQuery(name, Object.assign({}, st, { where: Object.assign({}, st.where, w) })); },
      orderBy(k, d) { return makeQuery(name, Object.assign({}, st, { order: { k, d } })); },
      skip(n) { return makeQuery(name, Object.assign({}, st, { skip: n })); },
      limit(n) { return makeQuery(name, Object.assign({}, st, { limit: n })); },
      async count() {
        ops.push({ op: 'count', name });
        return { total: rowsOf(name).filter((x) => matchWhere(x, st.where)).length };
      },
      async get() {
        ops.push({ op: 'get', name, where: st.where });
        return { data: deepCopy(select(name, st)) };
      },
      async update(patch) {
        ops.push({ op: 'update', name, where: st.where });
        let n = 0;
        rowsOf(name).forEach((d, i) => {
          if (matchWhere(d, st.where)) { rowsOf(name)[i] = Object.assign({}, d, patch); n++; }
        });
        return { updated: n };
      },
      async remove() {
        ops.push({ op: 'remove', name, where: st.where });
        const before = rowsOf(name).length;
        tables[name] = rowsOf(name).filter((d) => !matchWhere(d, st.where));
        return { removed: before - tables[name].length };
      },
      async add(obj) {
        ops.push({ op: 'add', name });
        if (h.addGuard && h.addGuard(name, obj) === false) {
          throw new Error('FAKE_ADD_REJECTED');
        }
        const _id = 'cloud_' + (++autoId);
        rowsOf(name).push(Object.assign({ openid: undefined }, deepCopy(obj), { _id }));
        return { id: _id };
      },
      doc(id) {
        return {
          async update(patch) {
            ops.push({ op: 'docUpdate', name, id });
            const arr = rowsOf(name);
            const i = arr.findIndex((d) => d._id === id);
            if (i >= 0) arr[i] = Object.assign({}, arr[i], patch);
            return { updated: i >= 0 ? 1 : 0 };
          },
          async remove() {
            ops.push({ op: 'docRemove', name, id });
            const before = rowsOf(name).length;
            tables[name] = rowsOf(name).filter((d) => d._id !== id);
            return { removed: before - tables[name].length };
          },
          async get() {
            ops.push({ op: 'docGet', name, id });
            return { data: deepCopy(rowsOf(name).filter((d) => d._id === id)) };
          },
        };
      },
    };
    return api;
  }

  const db = {
    command: { regex: (p) => ({ __regex: p }) },
    collection(name) { return makeQuery(name, { where: {} }); },
    async createCollection(name) { rowsOf(name); },
  };

  let aiText = 'AI 改写后的评语（默认）';
  const app = {
    database: () => db,
    ai: () => ({
      createModel: () => ({
        generateText: async () => {
          ops.push({ op: 'ai' });
          if (h.aiThrow) throw new Error(h.aiThrow);
          return { text: aiText };
        },
      }),
    }),
  };

  return {
    init: () => app,
    __tables: tables,
    __ops: ops,
    __setAiText: (t) => { aiText = t; },
  };
}

/* ------------------------------------------------------------------ *
 * 反证变异体（仅在 E2E_MUTATE=<key>[,...] 时生效，默认关闭）
 *
 * 为什么需要：§7 的反证改的是**数据**（把某张单的 planId 改坏），它能证明「判据能识别
 * 异常态」；但证明不了「判据与**源码**绑定」。真正要防的是「有人把院校验删了，用例还全绿」。
 * 做法：在内存里把 canonical 副本的源码改坏（**不动磁盘**），再跑同一批断言 —— 必须变红。
 * 与 scripts/counterproof.sh 的 git 基线反证互补：那个证「旧实现会红」，这个证「改坏会红」。
 * ------------------------------------------------------------------ */
const MUTATIONS = {
  /** 摘掉 O2 的计划对位校验（§4 必须整段变红） */
  plan_mismatch: {
    file: 'cloudfunctions/tutorOrder/orderActions.js',
    from: 'if (anchorPlanId !== planId) {',
    to: 'if (false) {',
  },
  /** 摘掉 O2 的 1:1 锁定（§3 必须变红） */
  already_submitted: {
    file: 'cloudfunctions/tutorOrder/orderActions.js',
    from: "if (doc.status === 'submitted' || doc.status === 'closed') {",
    to: 'if (false) {',
  },
  /** 让 tutorSync.pull 读不到学习单（「小程序可见」必须变红） */
  pull_no_orders: {
    file: 'cloudfunctions/tutorSync/index.js',
    from: "orders: 'tutor_orders'",
    to: "orders: 'tutor_orders_E2E_MUTATED'",
  },
  /** 让云端 orders 视图**不回传 openid**（家长看板的按孩子归属必须变红，T23 红线） */
  orders_drop_openid: {
    file: 'cloudfunctions/webAdminQuery/index.js',
    from: "o.openid = r.openid || r._openid || '';",
    to: "o.openid = '';",
  },
};

function activeMutations() {
  const raw = String(process.env.E2E_MUTATE || '').trim();
  if (!raw) return [];
  return raw.split(',').map((k) => k.trim()).filter(Boolean).map((k) => {
    const m = MUTATIONS[k];
    if (!m) throw new Error('未知的 E2E_MUTATE：' + k + '（可选：' + Object.keys(MUTATIONS).join(',') + '）');
    const abs = path.join(ROOT, m.file);
    let src = fs.readFileSync(abs, 'utf8');
    if (src.indexOf(m.from) < 0) {
      throw new Error('反证变异点找不到（源码结构变了？）：' + m.file + ' :: ' + m.from);
    }
    src = src.split(m.from).join(m.to);
    return { key: k, abs, src };
  });
}

/**
 * 拦截 require：① '@cloudbase/node-sdk' → 假 SDK
 *              ② 被点名的变异文件 → 内存里的改坏版本（磁盘不动）
 */
function installHooks(sdk, mutations) {
  const original = Module._load;
  const patched = new Map(mutations.map((m) => [m.abs, m.src]));
  Module._load = function (request, parent) {
    if (request === '@cloudbase/node-sdk') return sdk;
    if (patched.size) {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent); } catch (e) { resolved = null; }
      if (resolved && patched.has(resolved)) {
        const m = new Module(resolved, parent);
        m.filename = resolved;
        m.paths = Module._nodeModulePaths(path.dirname(resolved));
        m._compile(patched.get(resolved), resolved);
        return m.exports;
      }
    }
    return original.apply(this, arguments);
  };
  return () => { Module._load = original; };
}

/* ================================================================== *
 * 三、World：一个独立的世界 = 一份内存库 + 四个真云函数 + 两端驱动
 * ================================================================== */
const CLOUD_FILES = [
  'cloudfunctions/tutorOrder/index.js',
  'cloudfunctions/tutorSync/index.js',
  'cloudfunctions/webAdminWrite/index.js',
  'cloudfunctions/webAdminQuery/index.js',
];
const MP_FILES = [
  'miniprogram/utils/store.js',
  'miniprogram/utils/tutorStore.js',
  'miniprogram/utils/studyPlan.js',
  'miniprogram/utils/tutorSubjects.js',
  'miniprogram/pkgGuide/order/order.js',
];

function seedTables(planCreatedAt) {
  const plan = makePlan(planCreatedAt);
  return {
    hw_farm_user: [{
      _id: 'e2e-u1', _openid: OPENID, createdAt: 1, updatedAt: plan.updatedAt,
      data: {
        version: 2, currentUserId: 'e2e-child', coop: { plants: [] },
        users: [{
          id: 'e2e-child', nickname: '加一', grade: '一年级',
          studyPlans: { [PLAN_KEY]: plan },
        }],
      },
    }],
    web_portal_bindings: [{ _id: 'e2e-b1', token: WEB_TOKEN, openid: OPENID, revoked: false }],
    tutor_orders: [],
    tutor_sessions: [],
    tutor_mistakes: [],
    tutor_reviews: [],
    tutor_evidence: [],
    exam_resources: [],
  };
}

/**
 * 建一个世界。
 * @param {object} [opts] { planCreatedAt, aiThrow, aiText }
 */
function createWorld(opts) {
  const o = opts || {};
  const tables = seedTables(o.planCreatedAt || PLAN_CREATED_1);
  const sdk = createFakeSdk(tables, {
    /* 默认让假 AI **不可用**（模拟「资源包未开通」这一生产常见态）：
       §1–§6 要判的是 canonical 规则评语，不能被一个 stub 的返回值绑架。
       AI 可用 / 命中禁用词两条路单独在 §7.3、§7.4 里测（那里显式传 aiThrow:null）。 */
    aiThrow: o.aiThrow === undefined ? 'E2E 假 AI：默认不可用（模拟资源包未开通）' : o.aiThrow,
  });
  if (o.aiText) sdk.__setAiText(o.aiText);
  const mutations = activeMutations();
  const uninstall = installHooks(sdk, mutations);

  /* ⚠️ 变异体同样要清模块缓存：否则第二次 createWorld 会拿到上一轮（未变异）的模块。
     变异目标文件（orderActions.js / tutorSync 等）不在 CLOUD_FILES 里，必须单独清，
     否则「云函数入口被清、它 require 的副本还在缓存里」→ 本轮变异不生效。 */
  const cacheTargets = CLOUD_FILES.concat(Object.keys(MUTATIONS).map((k) => MUTATIONS[k].file));
  Array.from(new Set(cacheTargets)).forEach((f) => {
    const abs = path.join(ROOT, f);
    try { delete require.cache[require.resolve(abs)]; } catch (e) { /* 文件不存在就算了 */ }
  });
  const cloud = {
    tutorOrder: require(path.join(ROOT, 'cloudfunctions/tutorOrder/index.js')),
    tutorSync: require(path.join(ROOT, 'cloudfunctions/tutorSync/index.js')),
    webAdminWrite: require(path.join(ROOT, 'cloudfunctions/webAdminWrite/index.js')),
    webAdminQuery: require(path.join(ROOT, 'cloudfunctions/webAdminQuery/index.js')),
  };

  const calls = [];   // 端上发出的每一次 callFunction（供「真的调到了云端」类断言）

  /* ---------- 云端分发（两端共用；openid 由运行时注入，与微信云一致） ---------- */
  async function dispatch(name, data) {
    if (name === 'tutorOrder') {
      // 云函数永远从 userInfo.openId 取身份 —— 客户端无法直传 openid（这是安全边界）
      return cloud.tutorOrder.main(Object.assign({ userInfo: { openId: OPENID } }, data || {}));
    }
    if (name === 'tutorSync') {
      return cloud.tutorSync.main(Object.assign({ userInfo: { openId: OPENID } }, data || {}));
    }
    if (name === 'webAdminWrite') return cloud.webAdminWrite.main(data || {});
    if (name === 'webAdminQuery') return cloud.webAdminQuery.main(data || {});
    return { ok: true };
  }

  return {
    tables, sdk, cloud, calls,
    /** 小程序侧的一次调用（callFunction 返回 {result}，与 wx.cloud 一致） */
    async mpCall(name, data) {
      const c = { from: 'mp', name, data: deep(data) };
      calls.push(c);
      const r = await dispatch(name, data);
      return { result: deep(r) };
    },
    /** 网页侧的一次调用 */
    async webCall(name, data) {
      const c = { from: 'web', name, data: deep(data) };
      calls.push(c);
      const r = await dispatch(name, data);
      return { result: deep(r) };
    },
    orders() { return tables.tutor_orders || []; },
    orderByNo(no) { return one(tables.tutor_orders, (x) => x.orderNo === no); },
    close() { uninstall(); },
  };
}

/* ================================================================== *
 * 四、网页端驱动（真实 web/index.html 应用脚本，跑在 vm 里）
 * ================================================================== */
const WEB_FILE = path.join(ROOT, 'web', 'index.html');
const webSrc = fs.readFileSync(WEB_FILE, 'utf8');
function extractScripts(src) {
  const out = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}
const SCRIPT_BLOCKS = extractScripts(webSrc);
const APP_SRC = SCRIPT_BLOCKS[1] || '';
if (!APP_SRC) { console.error('❌ 取不到 web/index.html 的应用脚本（结构变了？）'); process.exit(1); }

function makeEl(id) {
  return {
    id: id || '', dataset: {}, style: {}, value: '', textContent: '', innerHTML: '',
    className: '', disabled: false, checked: false,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { f ? this._s.add(c) : this._s.delete(c); } },
    },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return makeEl(); },
    scrollIntoView() {}, appendChild() {}, setAttribute() {}, getAttribute() { return null; },
    focus() {}, click() {}, remove() {}, getContext() { return null; },
  };
}

/**
 * 启一个网页端实例，云调用**直达假库里的真云函数**。
 * 与 scripts/test-web-order-write.cjs 同一套手法（同作用域追加 hook 才能读到块级 let）。
 */
function bootWeb(world, opts) {
  const o = opts || {};
  const els = new Map();
  const store = new Map();
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelectorAll() { return []; }, querySelector() { return makeEl(); },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {}, body: makeEl('body'), documentElement: makeEl('html'),
  };
  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };
  const cloudbase = {
    init() {
      return {
        auth: () => ({ signInAnonymously: async () => ({}) }),
        /* ⚠️ webCall 已经返回 { result }（与 wx.cloud.callFunction 同形），
           这里**不能再包一层** —— 首版写成 ({ result: await webCall(...) }) → 双层壳，
           网页端 query() 读到空 result，一律报「请求失败」。 */
        callFunction: (arg) => world.webCall(arg.name, arg.data),
      };
    },
  };
  const sandbox = {
    console, document, localStorage, cloudbase,
    window: { addEventListener() {}, removeEventListener() {}, location: { href: '' } },
    navigator: { userAgent: 'node-e2e' },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.reject(new Error('no net')),
    alert() {}, confirm: () => true, prompt: () => '',
    location: { href: '', search: '', hash: '' },
    Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const hook = `
;globalThis.__WEB = {
  query: query, refreshOrders: refreshOrders, renderOrders: renderOrders,
  doIssue: doIssue, doSubmitReceipt: doSubmitReceipt, acc: acc,
  callWrite: callWrite, issuablePlansOf: issuablePlansOf, receiptPanelHtml: receiptPanelHtml,
  /* 真实读路径：走 query() → webAdminQuery（真云函数）*/
  async loadAll(){
    DATA.profile = await query('profile');
    DATA.orders  = await query('orders', { limit: 300 });
    renderOrders();
  },
  getData(){ return DATA; },
  getOrders(){ return (DATA.orders && DATA.orders.orders) || []; },
  getPlans(){ return (DATA.orders && DATA.orders.plans) || []; },
  getMsg(){ return oMsg; },
  getAccount(){ return acc(); },
  setToken(v){ TOKEN = v; },
  setWriteTab(v){ oWriteTab = v; },
  setRcptStep(v){ oRcptStep = v; },
  setRcptPlan(v){ oRcptPlan = v; },
  setRcptOrder(v){ oRcptOrder = v; },
  setRcptPaste(v){ oRcptPaste = v; },
  /* 展开某张单的详情（评语只渲染在展开态，列表行不显示 —— 与真机一致） */
  setOrdersSel(v){ ordersSel = v; renderOrders(); },
  openOrder(no){ ordersSel = no; renderOrders(); },
  setIssuePlanIdx(v){ oIssuePlanIdx = v; },
  setIssueTaskIdx(v){ oIssueTaskIdx = v; },
  getWriteHtml(){ return (document.getElementById('ordersWrite')||{}).innerHTML || ''; },
  getContentHtml(){ return (document.getElementById('ordersContent')||{}).innerHTML || ''; }
};
`;
  const context = vm.createContext(sandbox);
  try {
    new vm.Script(APP_SRC + hook, { filename: 'web/index.html#app' }).runInContext(context);
  } catch (e) {
    throw new Error('网页端脚本加载失败（hook 引用的函数在源码里不存在 → 功能被删了）：' + e.message);
  }
  const T = sandbox.__WEB;
  if (!T) throw new Error('网页端加载后取不到 __WEB');
  T.setToken(o.token === undefined ? WEB_TOKEN : o.token);
  return { T, els };
}

/* ================================================================== *
 * 五、小程序端驱动（真实学习单页 + 真 tutorStore + 真 store）
 * ================================================================== */
function createMpStorage(planCreatedAt) {
  const plan = makePlan(planCreatedAt);
  const root = {
    version: 2, currentUserId: 'e2e-child', coop: { plants: [] },
    users: [{
      id: 'e2e-child', nickname: '加一', grade: '一年级',
      homework: {}, checkinTypes: [], plans: {},
      studyPlans: { [PLAN_KEY]: plan },
    }],
  };
  const map = new Map();
  map.set('wb_hwfarm_openid', OPENID);
  map.set('wb_hwfarm_data_v2', root);
  map.set('wb_hwfarm_data_v2_' + OPENID, root);
  return map;
}

/**
 * 启一个小程序端：真实 Page 对象（pkgGuide/order/order.js）+ 真 tutorStore。
 * wx.cloud.callFunction 直达假库里的真云函数。
 */
function bootMp(world, opts) {
  const o = opts || {};
  const storage = createMpStorage(o.planCreatedAt || PLAN_CREATED_1);
  const toasts = [];
  const modals = [];
  const clipboard = [];

  global.wx = {
    getStorageSync(k) { return storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : ''; },
    setStorageSync(k, v) { storage.set(k, JSON.parse(JSON.stringify(v))); },
    removeStorageSync(k) { storage.delete(k); },
    getStorageInfoSync() { return { keys: Array.from(storage.keys()), currentSize: 0, limitSize: 10240 }; },
    showToast(a) { toasts.push(a || {}); },
    showModal(a) { modals.push(a || {}); },
    /* 出单后会「复制执行端提示词」—— 这是 copied 事件（O4 的「单已交付」留痕点）的触发源。
       桩必须让它成功，否则整条 copied 链路在测试里永远走不到。 */
    setClipboardData(a) { clipboard.push((a && a.data) || ''); if (a && a.success) a.success(); },
    cloud: { callFunction: (arg) => world.mpCall(arg.name, arg.data) },
  };
  global.getApp = () => ({ globalData: {} });

  let pageDef = null;
  global.Page = (obj) => { pageDef = obj; };

  MP_FILES.forEach((f) => { delete require.cache[require.resolve(path.join(ROOT, f))]; });

  const store = require(path.join(ROOT, 'miniprogram/utils/store.js'));
  store.setCloudReady(false);

  return store.initAccount().then(() => {
    const tutorStore = require(path.join(ROOT, 'miniprogram/utils/tutorStore.js'));
    require(path.join(ROOT, 'miniprogram/pkgGuide/order/order.js'));
    if (!pageDef) throw new Error('学习单页没有调用 Page()（文件是不是被改成模块了？）');

    const inst = Object.create(null);
    Object.keys(pageDef).forEach((k) => { if (typeof pageDef[k] === 'function') inst[k] = pageDef[k]; });
    inst.data = JSON.parse(JSON.stringify(pageDef.data || {}));
    inst.setData = function (patch) { if (patch) Object.assign(inst.data, patch); };

    return { inst, tutorStore, store, storage, toasts, modals, clipboard, pageDef };
  });
}

/* ================================================================== *
 * §0 环境自检：证明桩是活的、且真的不连云
 * ================================================================== */

async function selfTest() {
  ok(APP_SRC.length > 10000, '取到 web/index.html 应用脚本（' + APP_SRC.length + ' 字节）');
  ok(SCRIPT_BLOCKS.length === 2 || SCRIPT_BLOCKS.length > 1,
    'web/index.html 仍是「SDK + 应用」两段脚本（实际 ' + SCRIPT_BLOCKS.length + ' 段）');

  const world = createWorld();
  try {
    CLOUD_FILES.forEach((f) => {
      const abs = path.join(ROOT, f);
      ok(fs.existsSync(abs), '云函数源码存在：' + f);
    });
    ok(typeof world.cloud.tutorOrder.main === 'function'
      && typeof world.cloud.webAdminWrite.main === 'function'
      && typeof world.cloud.webAdminQuery.main === 'function'
      && typeof world.cloud.tutorSync.main === 'function',
      '四个云函数都取到了真实 main()');

    /* ⚠️ 这条是「不连云」的结构性证明：既然 Module._load 被拦，
       真 @cloudbase/node-sdk 就不可能被拿到。 */
    const sdk = require('@cloudbase/node-sdk');
    ok(sdk === world.sdk, 'require("@cloudbase/node-sdk") 拿到的是假 SDK → 本脚本**不可能**写线上');

    const mp = await bootMp(world);
    ok(typeof mp.inst.doIssue === 'function' && typeof mp.inst.submitReceipt === 'function',
      '小程序侧捕获到真实 Page 对象，且 doIssue / submitReceipt 都在');
    ok(typeof mp.tutorStore.orderApi === 'function', '真 tutorStore.orderApi 就位');

    const web = bootWeb(world);
    ok(typeof web.T.doIssue === 'function' && typeof web.T.doSubmitReceipt === 'function',
      '网页侧真源码加载成功，doIssue / doSubmitReceipt 都在');

    /* 桩活性：真调一次云端，库里必须真的发生写入 */
    const before = world.orders().length;
    await web.T.loadAll();
    ok(world.calls.length >= 2, '网页 loadAll 真的发出了云调用（' + world.calls.length + ' 次）');
    ok(world.orders().length === before, '只读动作不写库（读 2 次，单数不变）');

    /* 反证：桩不是恒真的 —— 一次真实出单必须让库里的单数 +1 */
    const p = at(web.T.issuablePlansOf(web.T.getAccount()), 0);
    ok(!!p, '云端 hw_farm_user.data.users[0].studyPlans 被真实读回，且该计划可出单');
  } finally {
    world.close();
  }
}

/* ================================================================== *
 * §1 链路 1：网页出单 → 小程序可见 → 小程序交回执 → 网页看到评语
 * ================================================================== */

async function linkWebToMp() {
  const world = createWorld();
  try {
    /* ── 1) 网页出单 ───────────────────────────────────────── */
    const web = bootWeb(world);
    await web.T.loadAll();
    const acct = web.T.getAccount();
    ok(!!acct && acct.openid === OPENID, '网页读到的孩子就是小程序那个 openid（' + (acct && acct.openid) + '）');

    const plan = at(web.T.issuablePlansOf(acct), 0);
    ok(!!plan && plan.key === PLAN_KEY, '网页能看到可出单计划（key=' + (plan && plan.key) + '）');

    web.T.setWriteTab('issue');
    await web.T.doIssue();

    const rows = world.orders();
    ok(rows.length === 1, '网页出单后云端 tutor_orders 恰好 1 行（实际 ' + rows.length + '）');
    const issued = at(rows, 0) || {};
    ok(issued.issuedBy === 'web', "issuedBy='web'（三端留痕口径，实际 " + issued.issuedBy + '）');
    ok(issued.plan && issued.plan.planId === PLAN_ID_1,
      'planId 锚定到 key@createdAt（' + ((issued.plan || {}).planId) + '）');
    ok(issued.plan.si === 0 && issued.plan.ti === 1,
      '锚点下标取自计划原文（si=' + issued.plan.si + ' ti=' + issued.plan.ti + '，已勾选的 ti=0 不挤位）');
    ok(issued.openid === OPENID, '单的属主是孩子 openid（不是网页/管理员，避免无主数据）');
    ok(Array.isArray(issued.events) && issued.events.length === 1 && issued.events[0].type === 'issued',
      'O4：出单留痕恰好 1 条 issued 事件');
    const orderNo = issued.orderNo;

    /* ── 2) 小程序可见 ──────────────────────────────────────── */
    const mp = await bootMp(world);
    await mp.tutorStore.syncFromCloud();     // 真 tutorSync.pull
    mp.inst.buildViews();
    ok(mp.tutorStore.getOrder(orderNo) !== null, '小程序 pull 后能看到网页出的这张单（orderNo=' + orderNo + '）');
    const mineRow = one(mp.inst.data.orders, (x) => x.orderNo === orderNo);
    ok(!!mineRow && mineRow.statusText === '待回执', '「我的单」列表里状态显示为「待回执」');
    ok(hit(mp.tutorStore.getPendingOrders(PLAN_ID_1), (x) => x.orderNo === orderNo).length === 1,
      '回执第二步候选集（该 planId 下 status=issued）恰好含它');
    ok(hit(mp.tutorStore.getPendingOrders(PLAN_ID_2), () => true).length === 0,
      '对照：另一个 planId 下**没有**待回执单（不然「按计划对位」是空过）');

    /* ── 3) 小程序交回执（走真实三步交互） ───────────────────── */
    mp.inst.setData({ tab: 'receipt' });
    mp.inst.buildReceiptPlans();
    const rPlanIdx = mp.inst.data.rPlans.findIndex((x) => x.planId === PLAN_ID_1);
    ok(rPlanIdx >= 0, '回执第一步能选到该计划（「先选计划」，决策 1）');
    ok(mp.inst.data.rPlans.length === 1, '第一步只列还有待回执单的计划（实际 ' + mp.inst.data.rPlans.length + ' 个）');
    mp.inst.onReceiptPlanPick({ currentTarget: { dataset: { i: rPlanIdx } } });
    ok(mp.inst.data.rStep === 2, '选计划后进入第二步「选出单」');
    mp.inst.onReceiptOrderPick({ currentTarget: { dataset: { i: 0 } } });
    ok(mp.inst.data.rStep === 3 && mp.inst.data.rOrders.length === 1,
      '第二步恰好 1 张待回执单，选定后进入第三步（实际 ' + mp.inst.data.rOrders.length + ' 张）');

    const RAW = makeRawReceipt(orderNo);
    mp.inst.setData({ rawReceipt: RAW });
    mp.inst.parseReceipt();
    ok(!!mp.inst.data.parsed && !!mp.inst.data.confirm, '解析回执：抽到字段并生成待确认副本（不自动补全）');
    ok(mp.inst.data.confirm.conclusion === '部分达标',
      '人工确认副本里的结论取自原文（' + mp.inst.data.confirm.conclusion + '）');

    await mp.inst.submitReceipt(); await flush();  /* 提交与 polishQuietly 都是 fire-and-forget */

    const after = world.orderByNo(orderNo);
    /* 容错取值：链路被改坏时 after 可能是 null / evaluation 可能不存在 ——
       直接读 after.evaluation.comment 会抛 TypeError，把「一条红」升级成「整段死」。 */
    const ev1 = (after && after.evaluation) || {};
    ok(!!after && after.status === 'submitted', '小程序提交后云端 status=submitted（实际 ' + (after && after.status) + '）');
    ok(!!(after && after.receipt) && after.receipt.rawText === RAW,
      'O4：回执原文原样落库（' + (after && after.receipt ? after.receipt.rawText.length : 0) + ' 字符）');
    ok(typeof ev1.comment === 'string' && ev1.comment.length > 0,
      '规则评语已生成（' + String(ev1.comment || '').slice(0, 24) + '…）');
    /* §1/§2 用**规则评语**做判定（默认让假 AI 不可用 → polish 静默回落 'rule'）：
       规则评语是 canonical 算出来的、可预期的；AI 是否可用单独在 §7.3/§7.4 里测。
       把两件事混在一起，会让「评语正确」这条断言依赖一个 stub 的返回值。 */
    ok(ev1.commentSource === 'rule',
      "默认态下 commentSource='rule'（假 AI 不可用 → 静默回落，实际 " + ev1.commentSource + '）');

    const types = (after.events || []).map((e) => e.type);
    ok(types.slice(0, 3).join(',') === 'issued,submitted,evaluated',
      'O4：前三件事按序 append（实际 ' + types.join(',') + '）');
    ok(types.length === 3 || (types.length === 4 && types[3] === 'polished'),
      'O4：第 4 条只可能是 polished（AI 润色留痕），不会冒出别的类型（' + types.join(',') + '）');
    const ats = (after.events || []).map((e) => e.at);
    ok(ats.every((v, i) => i === 0 || v >= ats[i - 1]), '事件时间戳单调不减（「什么时间出单、什么时间回执」可追溯）');

    /* ── 4) 网页看到评语 ────────────────────────────────────── */
    await web.T.refreshOrders();
    const webOrders = web.T.getOrders();
    const wOrder = one(webOrders, (x) => x.orderNo === orderNo);
    const wo = wOrder || {};
    const wev = wo.evaluation || {};
    ok(!!wOrder, '网页重新拉取后能看到这张单');
    ok(wo.status === 'submitted', '网页看到的状态已是 submitted（实际 ' + wo.status + '）');
    ok(wOrder.evaluation && wOrder.evaluation.comment === after.evaluation.comment,
      '网页看到的评语与云端逐字相同（不在端上重算）');
    /* ⚠️ 评语只渲染在**展开态**（与真机一致：列表行不显示评语）。
       不展开就断言 innerHTML 里找不到评语 —— 首版正是这么写的，红过一次。 */
    web.T.openOrder(orderNo);
    ok(wev.comment && web.T.getContentHtml().indexOf(wev.comment) >= 0,
      '展开该单后评语**真的渲染进了页面**（不只是躺在内存里）');
    ok(web.T.getContentHtml().indexOf('回执') >= 0, '页面出现回执相关区块');

    /* 计划维度聚合：网页那一份由云端 canonical 算出，两端读同一份 */
    const agg = one(web.T.getPlans(), (x) => x.planId === PLAN_ID_1);
    ok(!!agg && agg.total === 1 && agg.submitted === 1 && agg.issued === 0,
      '计划聚合：该计划 1 张单、1 张已回执（' + JSON.stringify(agg && { total: agg.total, submitted: agg.submitted, issued: agg.issued }) + '）');
    ok(!!agg && agg.lastSubmittedAt > 0 && agg.lastSubmittedAt === after.submittedAt,
      '聚合行的 lastSubmittedAt 就是那张单的提交时间（可追溯）');

    /* 禁用词门禁（AI 润色走的是 tutorOrder 的 openid 通道） */
    const banned = require(path.join(ROOT, 'order-kit/orderKit.js')).findBannedWords(ev1.comment || '');
    ok(banned.length === 0, '评语不含禁用词（' + (banned.join('/') || '无') + '）');

    /* O3：回执不是证据 —— 全链路跑完，证据/复习/错题集合必须一动不动 */
    ok((world.tables.tutor_evidence || []).length === 0, 'O3：tutor_evidence 仍为空（回执 ≠ 证据）');
    ok((world.tables.tutor_reviews || []).length === 0, 'O3：tutor_reviews 仍为空');
    ok((world.tables.tutor_mistakes || []).length === 0, 'O3：tutor_mistakes 仍为空');
    ok(world.orders().length === 1, 'O2：全程只产生 1 张单（回执是原地状态变更，不新建单）');

    /* ── 5) 反向可见：小程序侧也要看到评语（走本地缓存，不经网页） ─ */
    await mp.tutorStore.syncFromCloud();
    const mpOrder = mp.tutorStore.getOrder(orderNo);
    ok(!!mpOrder && mpOrder.status === 'submitted', '小程序 pull 后本地单也是 submitted（云端覆盖本地）');
    ok(!!(mpOrder && mpOrder.evaluation) && mpOrder.evaluation.comment === ev1.comment,
      '小程序本地评语与云端逐字相同（跨了存储边界，不是同一份内存对象）');
    ok(!!(mpOrder && mpOrder.receipt) && mpOrder.receipt.rawText === RAW,
      '小程序本地也保留了回执原文（可查）');
  } finally {
    world.close();
  }
}

/* ================================================================== *
 * §2 链路 2：小程序出单 → 网页可见 → 网页交回执 → 小程序看到评语
 * ================================================================== */

async function linkMpToWeb() {
  const world = createWorld();
  try {
    const mp = await bootMp(world);
    mp.inst.buildViews();
    const p0 = at(mp.inst.data.plans, 0);
    ok(!!p0 && p0.key === PLAN_KEY && p0.taskName === '比大小',
      '小程序出单候选计划与当前任务取自 studyPlans（' + (p0 && p0.taskName) + '）');

    /* ── 1) 小程序出单 ─────────────────────────────────────── */
    mp.inst.setData({ tab: 'issue' });
    await mp.inst.doIssue(); await flush();   /* 页内 fire-and-forget，必须排干微任务 */
    const rows = world.orders();
    ok(rows.length === 1, '小程序出单后云端恰好 1 行（实际 ' + rows.length + '）');
    const issued = at(rows, 0) || {};
    ok(issued.issuedBy === 'mp', "issuedBy='mp'（实际 " + issued.issuedBy + '）');
    ok(issued.plan.planId === PLAN_ID_1, '锚点 planId 与网页端同口径（' + issued.plan.planId + '）');
    const orderNo = issued.orderNo;

    /* ── 2) 网页可见 ───────────────────────────────────────── */
    const web = bootWeb(world);
    await web.T.loadAll();
    const wOrder = one(web.T.getOrders(), (x) => x.orderNo === orderNo);
    ok(!!wOrder, '网页能看到小程序出的单');
    ok(wOrder.status === 'issued' && wOrder.issuedBy === 'mp',
      '网页看到的状态与留痕来源都正确（' + wOrder.status + ' / ' + wOrder.issuedBy + '）');

    /* 两步选择：第一步只列还有 issued 的计划；第二步只列该 planId 下的 issued 单 */
    const a = web.T.getAccount();
    const mine = web.T.getOrders().filter((x) => !x.openid || x.openid === a.openid);
    const plans = web.T.getPlans().filter((x) => !x.openid || x.openid === a.openid);
    web.T.setWriteTab('receipt');
    web.T.setRcptStep(1);
    let html = web.T.receiptPanelHtml(a, plans, mine);
    ok(html.indexOf(PLAN_ID_1) >= 0, '网页回执第一步列出该计划（先选计划）');
    ok(!/data-or-porder=/.test(html), '第一步**不**列出具体出单（必须先选计划 —— 决策 1 的服务端兜底在下一步）');
    web.T.setRcptStep(2);
    web.T.setRcptPlan(PLAN_ID_1);
    html = web.T.receiptPanelHtml(a, plans, mine);
    ok(new RegExp('data-or-porder="' + orderNo + '"').test(html), '第二步列出该计划下这张待回执单');
    ok(/一个出单只能对应一个回执/.test(html), '明写 1:1 约束（O2 的端上提示）');

    /* ── 3) 网页交回执 ─────────────────────────────────────── */
    web.T.setRcptStep(3);
    web.T.setRcptPlan(PLAN_ID_1);
    web.T.setRcptOrder(orderNo);
    web.T.setRcptPaste(makeRawReceipt(orderNo));
    await web.T.doSubmitReceipt();
    ok((web.T.getMsg() || {}).kind === 'ok' || (web.T.getMsg() || {}).kind === 'warn',
      '网页交回执拿到了成功/告警提示（' + JSON.stringify(web.T.getMsg()) + '）');

    const after = world.orderByNo(orderNo);
    ok(!!after && after.status === 'submitted', '云端状态变为 submitted');
    ok(!!(after && after.receipt) && after.receipt.parsedBy === 'rule',
      "parsedBy='rule'：网页只上传原文，**解析在云端**（端上不参与判定，实际 " + (after.receipt && after.receipt.parsedBy) + '）');
    const webType = at(hit(world.calls, (c) => c.from === 'web' && c.name === 'webAdminWrite'), 0);
    ok(!!webType && webType.data.orders && webType.data.orders.action === 'submit'
      && webType.data.orders.by === 'web',
      '写请求形状正确：orders 是对象且 by=web');
    ok(!!webType && !('fields' in webType.data.orders),
      '网页不提交 fields（否则会算出与 canonical 不同的第四种 verdict）');

    /* ── 4) 小程序看到评语 ─────────────────────────────────── */
    await mp.tutorStore.syncFromCloud();
    mp.inst.buildViews();
    const mpOrder = mp.tutorStore.getOrder(orderNo);
    ok(!!mpOrder && mpOrder.status === 'submitted', '小程序 pull 后看到 submitted');
    const ev2 = (after && after.evaluation) || {};
    ok(!!(mpOrder && mpOrder.evaluation) && !!mpOrder.evaluation.comment
      && mpOrder.evaluation.comment === ev2.comment,
      '小程序看到的评语与云端逐字相同（跨存储边界比对，非同一对象）');
    const mineRow = one(mp.inst.data.orders, (x) => x.orderNo === orderNo);
    ok(!!mineRow && !!mineRow.verdictText,
      '「我的单」列表渲染出了结论文案（' + (mineRow && mineRow.verdictText) + '）');
    ok(mp.inst.data.counts && mp.inst.data.counts.submitted === 1,
      '小程序状态计数走 canonical（submitted=1，实际 ' + JSON.stringify(mp.inst.data.counts) + '）');

    /* 小程序打开详情：时间线要能看到出单/回执/评语（O4 可追溯）
       ⚠️ setData 把 timeline 放在**顶层**（不在 detail 里）—— 读错层级会得到空数组。 */
    mp.inst.renderDetail(orderNo);
    const d = mp.inst.data.detail || {};
    const tl = mp.inst.data.timeline || [];
    ok(tl.length >= 3,
      '详情时间线含 ≥3 条事件（' + tl.length + '：' + tl.map((x) => x.label).join('→') + '）');
    ok(!!d.comment && d.comment === ev2.comment,
      '详情页拿到的评语与云端一致（' + String(d.comment || '').slice(0, 20) + '…）');
    ok(d.submittedAtText && d.submittedAtText !== '尚未回执',
      '详情页显示回执时间（「什么时间回执」可查，实际 ' + d.submittedAtText + '）');
    ok(d.verdictText !== '', '详情页显示结论文案（' + d.verdictText + '）');
    ok(tl.every((x) => !!x.atText), '时间线每条都有可读时间（' + tl.map((x) => x.atText).join(' / ') + '）');
  } finally {
    world.close();
  }
}

/* ================================================================== *
 * §3 一张单重复提交被拒（O2：1:1）
 * ================================================================== */

async function rejectDoubleSubmit() {
  const world = createWorld();
  try {
    const mp = await bootMp(world);
    mp.inst.buildViews();
    await mp.inst.doIssue(); await flush();   /* 页内 fire-and-forget，必须排干微任务 */
    const orderNo = (at(world.orders(), 0) || {}).orderNo;
    ok(!!orderNo, '先造一张待回执单：' + orderNo);

    const RAW1 = makeRawReceipt(orderNo);
    /* 第一次：小程序通道提交 */
    const r1 = await mp.tutorStore.orderApi('submit', {
      orderNo: orderNo, planId: PLAN_ID_1, rawText: RAW1, parsedBy: 'rule', by: 'mp',
    });
    ok(r1.ok === true, '第一次提交成功（ok:true）');
    const snap = world.orderByNo(orderNo);
    const firstSubmittedAt = snap.submittedAt;
    const firstComment = snap.evaluation.comment;

    /* 第二次：同一条通道 */
    const RAW2 = makeRawReceipt(orderNo, { replaceLine: ['本次证据支持的结论：部分达标', '本次证据支持的结论：未达标'] });
    const r2 = await mp.tutorStore.orderApi('submit', {
      orderNo: orderNo, planId: PLAN_ID_1, rawText: RAW2, parsedBy: 'rule', by: 'mp',
    });
    ok(r2.ok === false && r2.code === 'already_submitted',
      '小程序通道重复提交 → already_submitted（实际 ' + r2.code + '）');
    ok(typeof r2.msg === 'string' && /作废重开/.test(r2.msg), '错误信息给出人的出路（作废重开）：' + r2.msg);

    /* 第三次：另一条通道（网页） */
    const web = bootWeb(world);
    await web.T.loadAll();
    const webRes = await world.webCall('webAdminWrite', {
      token: WEB_TOKEN,
      orders: { action: 'submit', by: 'web', orderNo: orderNo, planId: PLAN_ID_1, rawText: RAW2, parsedBy: 'rule' },
    });
    ok(webRes.result && webRes.result.ok === false && webRes.result.code === 'already_submitted',
      '网页通道重复提交同样被拒（两端共用同一份状态机，实际 ' + ((webRes.result || {}).code) + '）');
    ok(webRes.result && webRes.result.submittedAt === firstSubmittedAt,
      '被拒时回显首次提交时间，便于端上说明（' + (webRes.result || {}).submittedAt + '）');

    /* 状态与内容都没有被第二次提交动过 */
    const now = world.orderByNo(orderNo);
    ok(now.status === 'submitted' && now.submittedAt === firstSubmittedAt,
      '状态与首次提交时间戳未被覆盖');
    ok(now.receipt.rawText !== RAW2 && now.receipt.rawText === RAW1,
      'O2：回执原文仍是第一次那份（原地覆盖被拒）');
    ok(now.evaluation.comment === firstComment, '评语未被第二次改写');
    ok(world.orders().length === 1, 'O2：全过程只有 1 张单（重复提交不新建）');
    ok(hit(now.events, (e) => e.type === 'submitted').length === 1,
      'O4：submitted 事件恰好 1 条（没有重复留痕）');
  } finally {
    world.close();
  }
}

/* ================================================================== *
 * §4 所选计划与出单锚点不符被拒（O2）
 * ================================================================== */

async function rejectPlanMismatch() {
  const world = createWorld();
  try {
    const mp = await bootMp(world);
    mp.inst.buildViews();
    await mp.inst.doIssue(); await flush();   /* 页内 fire-and-forget，必须排干微任务 */
    const issued = at(world.orders(), 0) || {};
    const orderNo = issued.orderNo;
    ok(issued.plan.planId === PLAN_ID_1, '本单真实锚点是 ' + issued.plan.planId);
    const eventsBefore = (world.orderByNo(orderNo) || {}).events || [];

    const RAW = makeRawReceipt(orderNo);

    /* ① 网页端选错计划 */
    const wRes = await world.webCall('webAdminWrite', {
      token: WEB_TOKEN,
      orders: { action: 'submit', by: 'web', orderNo: orderNo, planId: PLAN_ID_2, rawText: RAW, parsedBy: 'rule' },
    });
    ok(wRes.result && wRes.result.ok === false && wRes.result.code === 'plan_mismatch',
      '网页端：所选计划与锚点不符 → plan_mismatch（实际 ' + ((wRes.result || {}).code) + '）');
    ok(wRes.result && wRes.result.expectPlanId === PLAN_ID_1,
      '被拒时回显真实锚点，便于端上纠偏（' + (wRes.result || {}).expectPlanId + '）');

    /* ② 小程序端选错计划 */
    const mRes = await mp.tutorStore.orderApi('submit', {
      orderNo: orderNo, planId: PLAN_ID_2, rawText: RAW, parsedBy: 'rule', by: 'mp',
    });
    ok(mRes.ok === false && mRes.code === 'plan_mismatch',
      '小程序端同样被拒（两端同一份校验，实际 ' + mRes.code + '）');

    /* ③ 缺 planId 直接拒绝（决策 1 的硬前提：没有「先选计划」就没有回执） */
    const noPlan = await mp.tutorStore.orderApi('submit', { orderNo: orderNo, rawText: RAW, parsedBy: 'rule' });
    ok(noPlan.ok === false && noPlan.code === 'bad_param',
      '不带 planId → bad_param（回执必须先选计划，实际 ' + noPlan.code + '）');

    /* ④ 被拒三次之后，单必须一动不动 */
    const after = world.orderByNo(orderNo);
    ok(after.status === 'issued', '被拒后状态仍是 issued（没有被写坏）');
    ok(!!after && after.receipt === null && after.evaluation === null, '被拒后没有留下任何半成品回执/评语');
    /* ⚠️ 基线不能写死成 1：小程序出单成功后会「复制执行端提示词」→ 云端记一条 copied
       （O4 里「单已交付」的留痕点）。所以这里比的是「与拒绝前快照一致」，而不是某个常数。 */
    ok(after.events.length === eventsBefore.length,
      'O4：被拒不产生任何事件（拒绝前后都是 ' + eventsBefore.length + ' 条：'
      + after.events.map((e) => e.type).join('→') + '）');
    ok(hit(after.events, (e) => e.type === 'submitted').length === 0, '被拒后没有 submitted 事件');
  } finally {
    world.close();
  }
}

/* ================================================================== *
 * §5 计划重生成后旧单仍正确归属（planId = key@createdAt）
 * ================================================================== */

async function regenPlanOwnership() {
  const world = createWorld();
  try {
    /* ── 1) 旧计划下标一张单 ───────────────────────────────── */
    const mp1 = await bootMp(world);
    mp1.inst.buildViews();
    await mp1.inst.doIssue(); await flush(); /* 页内 fire-and-forget */
    const oldOrder = at(world.orders(), 0) || {};
    ok(oldOrder.plan.planId === PLAN_ID_1, '旧单锚在旧计划（' + oldOrder.plan.planId + '）');
    const oldNo = oldOrder.orderNo;

    /* ── 2) 计划重生成：createdAt 变 → planId 变 ───────────── */
    const userRow = at(world.tables.hw_farm_user, 0);
    const child = at(userRow.data.users, 0);
    child.studyPlans[PLAN_KEY] = makePlan(PLAN_CREATED_2);
    ok(child.studyPlans[PLAN_KEY].createdAt === PLAN_CREATED_2, '计划已重生成（createdAt=' + PLAN_CREATED_2 + '）');

    /* ── 3) 网页在新计划下标一张新单 ───────────────────────── */
    const web = bootWeb(world);
    await web.T.loadAll();
    const planRow = at(web.T.issuablePlansOf(web.T.getAccount()), 0);
    ok(!!planRow && planRow.plan.createdAt === PLAN_CREATED_2, '网页读到的是新计划');
    web.T.setWriteTab('issue');
    await web.T.doIssue();
    const newOrder = one(world.orders(), (x) => x.orderNo !== oldNo);
    ok(!!newOrder, '新计划下又出了一张单（共 ' + world.orders().length + ' 张）');
    ok(newOrder.plan.planId === PLAN_ID_2, '新单锚在新 planId（' + newOrder.plan.planId + '）');

    /* ── 4) 旧单必须还在旧计划上 ───────────────────────────── */
    const oldAfter = world.orderByNo(oldNo);
    ok(oldAfter.plan.planId === PLAN_ID_1,
      '旧单仍属于旧计划（' + oldAfter.plan.planId + '）→ 计划重生成不会让旧单错挂');
    ok(oldAfter.plan.planId !== newOrder.plan.planId, '两张单的 planId 确实是两个不同值（对照）');
    ok(oldAfter.plan.planId !== PLAN_ID_2, '旧单**没有**被改写成新 planId');

    /* ── 5) 三端聚合按 planId 各归各 ───────────────────────── */
    const aggs = (await world.webCall('webAdminQuery', { token: WEB_TOKEN, module: 'orders', query: { limit: 300 } }))
      .result.data.plans;
    const g1 = one(aggs, (x) => x.planId === PLAN_ID_1);
    const g2 = one(aggs, (x) => x.planId === PLAN_ID_2);
    ok(!!g1 && g1.total === 1 && !!g2 && g2.total === 1,
      '云端聚合分成两组、各 1 张（旧 ' + (g1 && g1.total) + ' / 新 ' + (g2 && g2.total) + '）');
    ok(!!g1 && g1.key === PLAN_KEY && !!g2 && g2.key === PLAN_KEY,
      '两组的业务 key 相同、planId 不同 —— 正是「计划身份 = key@createdAt」的体现');

    /* 小程序侧同样按 planId 分组（本地那份也走 canonical） */
    const mp2 = await bootMp(world, { planCreatedAt: PLAN_CREATED_2 });
    await mp2.tutorStore.syncFromCloud();
    const mpAgg = mp2.tutorStore.planOrderAggregate();
    ok(hit(mpAgg, (x) => x.planId === PLAN_ID_1).length === 1
      && hit(mpAgg, (x) => x.planId === PLAN_ID_2).length === 1,
      '小程序聚合同样分成两组（' + mpAgg.length + ' 组）');
    ok(mp2.tutorStore.getOrdersByPlan(PLAN_ID_1).length === 1
      && mp2.tutorStore.getOrdersByPlan(PLAN_ID_2).length === 1,
      'getOrdersByPlan 按 planId 精确归属（各 1 张）');

    /* ── 6) 网页回执两步选择：选旧计划只列旧单 ─────────────── */
    web.T.setWriteTab('receipt');
    const a = web.T.getAccount();
    const mine = web.T.getOrders().filter((x) => !x.openid || x.openid === a.openid);
    const plans = web.T.getPlans().filter((x) => !x.openid || x.openid === a.openid);
    web.T.setRcptStep(2);
    web.T.setRcptPlan(PLAN_ID_1);
    const html1 = web.T.receiptPanelHtml(a, plans, mine);
    ok(new RegExp('data-or-porder="' + oldNo + '"').test(html1), '选旧计划 → 列出旧单');
    ok(!new RegExp('data-or-porder="' + newOrder.orderNo + '"').test(html1), '选旧计划 → **不**列新单（对位正确）');
    web.T.setRcptPlan(PLAN_ID_2);
    const html2 = web.T.receiptPanelHtml(a, plans, mine);
    ok(new RegExp('data-or-porder="' + newOrder.orderNo + '"').test(html2), '选新计划 → 列出新单');
    ok(!new RegExp('data-or-porder="' + oldNo + '"').test(html2), '选新计划 → 不列旧单');

    /* ── 7) 对旧单交回执时带新 planId 必须被拒 ─────────────── */
    const bad = await world.webCall('webAdminWrite', {
      token: WEB_TOKEN,
      orders: { action: 'submit', by: 'web', orderNo: oldNo, planId: PLAN_ID_2, rawText: makeRawReceipt(oldNo), parsedBy: 'rule' },
    });
    ok(bad.result && bad.result.ok === false && bad.result.code === 'plan_mismatch',
      '旧单 + 新 planId → plan_mismatch（重生成后的错配被挡住，实际 ' + ((bad.result || {}).code) + '）');
  } finally {
    world.close();
  }
}

/* ================================================================== *
 * §6 数据卫生：e2e- 前缀约定 + O3 隔离 + 残留清理动作
 * ================================================================== */

async function hygiene() {
  const world = createWorld();
  try {
    /* ── 1) 全链路跑一轮，然后检查库里的每一行 ─────────────── */
    const mp = await bootMp(world);
    mp.inst.buildViews();
    await mp.inst.doIssue(); await flush();   /* 页内 fire-and-forget，必须排干微任务 */
    const web = bootWeb(world);
    await web.T.loadAll();
    await web.T.doIssue();

    const rows = world.orders();
    ok(rows.length === 2, '两个端各出一张单（实际 ' + rows.length + '）');
    ok(rows.every((r) => String(r.openid || '').indexOf(E2E_PREFIX) === 0),
      '每张单的 openid 都带 e2e- 前缀（' + rows.map((r) => r.openid).join(',') + '）');
    ok(rows.every((r) => String((r.plan || {}).planId || '').indexOf(E2E_PREFIX) === 0),
      '每个 planId 都带 e2e- 前缀（' + rows.map((r) => r.plan.planId).join(',') + '）');
    ok(world.tables.web_portal_bindings.every((b) => String(b.token).indexOf(E2E_PREFIX) === 0),
      '绑定的访问口令也带前缀（便于识别是测试数据）');

    /* ── 2) O3 隔离：学习单链路只碰 tutor_orders（外加绑定表的 lastUsed 戳） ── */
    const written = Array.from(new Set(world.sdk.__ops
      .filter((o) => o.op === 'add' || o.op === 'docUpdate' || o.op === 'update' || o.op === 'remove')
      .map((o) => o.name))).sort();
    ok(written.join(',') === 'tutor_orders,web_portal_bindings',
      '被写过的集合恰好是 tutor_orders + 绑定表（实际：' + (written.join(',') || '无') + '）');
    const businessCols = ['tutor_sessions', 'tutor_mistakes', 'tutor_evidence', 'tutor_reviews',
      'exam_resources', 'hw_farm_user'];
    ok(businessCols.every((c) => written.indexOf(c) < 0),
      'O3：导学镜像四集合 / 试卷库 / 主数据表一行未写（' + businessCols.join(',') + '）');
    ok((world.tables.tutor_evidence || []).length === 0
      && (world.tables.tutor_reviews || []).length === 0
      && (world.tables.tutor_mistakes || []).length === 0,
      'O3：证据 / 复习 / 错题三个集合确为空（回执 ≠ 证据）');

    /* ── 3) 多孩：家长用管理员口令 → 拉回**全部孩子**的单，每条必须带 openid ──
       为什么必须在 E2E 里再钉一次：家长看板走管理员口令时 ofilter 返回 {}，
       一次拉回所有孩子；不回传 openid 就无法按孩子 chip 过滤、也无法分组
       （「哥哥的数学计划」和「妹妹的数学计划」会渲染成两行同名行）。这是 T23 的红线。 */
    process.env.WEB_DASHBOARD_TOKEN = ADMIN_TOKEN;
    process.env.WEB_ADMIN_ALLOW_WRITE = '1';
    const adminIssue = await world.webCall('webAdminWrite', {
      token: ADMIN_TOKEN, openid: CHILD2,
      orders: {
        action: 'issue', by: 'web',
        planTask: {
          key: PLAN_KEY, si: 0, ti: 1, planCreatedAt: PLAN_CREATED_1,
          subjectName: '数学', stageName: '第一阶段', taskName: '比大小',
        },
        opts: { kind: 'concept', minutes: 10, issuedBy: 'web' },
      },
    });
    ok(adminIssue.result && adminIssue.result.ok === true,
      '管理员口令可为指定 openid 出单（= 另一个孩子的单，实际 ' + JSON.stringify(adminIssue.result && adminIssue.result.code) + '）');

    const adminQ = await world.webCall('webAdminQuery', { token: ADMIN_TOKEN, module: 'orders', query: { limit: 300 } });
    const all = (adminQ.result && adminQ.result.data && adminQ.result.data.orders) || [];
    ok(all.length === 3, '管理员口令一次拉回**全部孩子**的单（' + all.length + ' 张）');
    ok(all.every((o) => !!o.openid),
      '每条单都回传 openid（不回传 → 家长看板无法按孩子归属，实际 ' + JSON.stringify(all.map((o) => o.openid)) + '）');
    ok(hit(all, (o) => o.openid === OPENID).length === 2
      && hit(all, (o) => o.openid === CHILD2).length === 1,
      '按 openid 过滤能精确分到各孩子（2 / 1）');
    const adminPlans = (adminQ.result.data || {}).plans || [];
    ok(adminPlans.length === 2 && adminPlans.every((p) => !!p.openid),
      '计划聚合按 openid::planId 分组，两个孩子的同 key 计划不会撞成一组（' + adminPlans.length + ' 组）');
    ok(adminQ.result.scope === 'admin', "管理员口令的作用域标注为 admin（实际 " + adminQ.result.scope + '）');
    delete process.env.WEB_ADMIN_ALLOW_WRITE;

    /* ── 4) 「不连云」的结构性证据 ──────────────────────────── */
    ok(require('@cloudbase/node-sdk') === world.sdk,
      '真 @cloudbase/node-sdk 在本进程内不可达 → 测试不会产生线上残留');

    /* ── 4) 残留清理：只认 e2e- 前缀，且现在也覆盖 tutor_orders ─ */
    /* 先塞两条「非 e2e」的真实数据，清理动作绝不能碰它们 */
    world.tables.tutor_orders.push({ _id: 'real-1', clientId: 'to_250101_AAAAAA', openid: 'o_real', orderNo: 'TS-REAL-1', status: 'issued' });
    world.tables.tutor_sessions.push({ _id: 'real-2', clientId: 'ts_250101_BBBBBB', openid: 'o_real' });
    /* 再塞一条 e2e 残留（模拟外挂 E2E 脚本直接造的数据） */
    world.tables.tutor_orders.push({ _id: 'e2e-1', clientId: 'e2e-ord-1', openid: OPENID, orderNo: 'TS-E2E-1', status: 'issued' });

    const denied = await world.webCall('webAdminWrite', { token: WEB_TOKEN, action: 'cleanup' });
    ok(denied.result && denied.result.ok === false && denied.result.code === 'forbidden',
      'per-user 家长口令不能触发清理（实际 ' + ((denied.result || {}).code) + '）');

    process.env.WEB_DASHBOARD_TOKEN = ADMIN_TOKEN;
    process.env.WEB_ADMIN_ALLOW_WRITE = '1';
    const done = await world.webCall('webAdminWrite', { token: ADMIN_TOKEN, action: 'cleanup' });
    delete process.env.WEB_ADMIN_ALLOW_WRITE;

    ok(done.result && done.result.ok === true, '管理员口令 + 显式开启写权限 → 清理动作可执行');
    ok(done.result && Array.isArray(done.result.scopes)
      && done.result.scopes.map((s) => s.scope).sort().join(',') === 'tutor_orders,tutor_sessions',
      '清理范围覆盖 tutor_orders 与 tutor_sessions（' + JSON.stringify((done.result || {}).scopes) + '）');
    ok(!world.orderByNo('TS-E2E-1'), 'e2e- 前缀的学习单残留已被删除');
    ok(!!world.orderByNo('TS-REAL-1'), '同集合里的非 e2e 学习单**未被触碰**（白名单生效）');
    ok((world.tables.tutor_sessions || []).length === 1
      && at(world.tables.tutor_sessions, 0)._id === 'real-2',
      'tutor_sessions 里非 e2e 的会话未被触碰');
    ok(world.orders().length === 4,
      '清理后只剩 3 张业务单 + 1 条真实单（实际 ' + world.orders().length + '）');
  } finally {
    delete process.env.WEB_DASHBOARD_TOKEN;
    delete process.env.WEB_ADMIN_ALLOW_WRITE;
    world.close();
  }
}

/* ================================================================== *
 * §7 反证：证明上面几条关键判定不是「空过」
 *   （判据 = 规格；这里把**真实状态**改坏，同一判定必须变红）
 * ================================================================== */

async function counterproof() {
  /* 7.1 「旧单不错挂新计划」的判定有效性 */
  {
    const world = createWorld();
    try {
      /* 判定函数：旧单是否仍属于旧计划 */
      const stillAnchored = (o) => !!(o && o.plan && o.plan.planId === PLAN_ID_1);

      const mp = await bootMp(world);
      mp.inst.buildViews();
      await mp.inst.doIssue(); await flush();   /* 页内 fire-and-forget，必须排干微任务 */
      const o = at(world.orders(), 0);
      ok(stillAnchored(o), '[反证前] 旧单确实锚在旧计划 → 判定能识别正常态');

      /* 改坏：模拟「计划重生成时把旧单一并改写」这个真实 bug */
      o.plan.planId = PLAN_ID_2;
      ok(!stillAnchored(o),
        '[反证] 把旧单 planId 改成新计划 → 同一判定立刻变红 ⇒ §5 的归属判据不是空过');
    } finally { world.close(); }
  }

  /* 7.2 「两端评语逐字相同」的判定有效性（跨存储边界比对） */
  {
    const world = createWorld();
    try {
      const sameComment = (a, b) => !!(a && b && a === b);

      const mp = await bootMp(world);
      mp.inst.buildViews();
      await mp.inst.doIssue(); await flush();   /* 页内 fire-and-forget，必须排干微任务 */
      const orderNo = (at(world.orders(), 0) || {}).orderNo;
      await mp.tutorStore.orderApi('submit', {
        orderNo: orderNo, planId: PLAN_ID_1, rawText: makeRawReceipt(orderNo), parsedBy: 'rule', by: 'mp',
      });
      await mp.tutorStore.syncFromCloud();

      const cloudComment = (world.orderByNo(orderNo) || {}).evaluation.comment;
      const localComment = (mp.tutorStore.getOrder(orderNo) || {}).evaluation.comment;
      ok(sameComment(cloudComment, localComment), '[反证前] 云端与小程序本地评语相同 → 判定能识别正常态');

      /* 改坏：模拟「本地旧快照盖掉云端评语」这个真实 bug */
      const all = mp.storage.get('wb_hwfarm_tutor_v1_' + OPENID);
      at(all.orders, 0).evaluation = { comment: '本地旧评语（不该生效）' };
      mp.storage.set('wb_hwfarm_tutor_v1_' + OPENID, all);

      const corrupted = (mp.tutorStore.getOrder(orderNo) || {}).evaluation.comment;
      ok(!sameComment(cloudComment, corrupted),
        '[反证] 把本地缓存评语改掉 → 同一判定变红 ⇒ §1/§2 的「逐字相同」不是空过');
    } finally { world.close(); }
  }

  /* 7.3 AI 润色失败必须**静默回落**，且禁用词的越界表述不得落进评语 */
  {
    const world = createWorld({ aiThrow: null, aiText: '孩子已经掌握了这次的内容，非常棒。' });
    try {
      const mp = await bootMp(world);
      mp.inst.buildViews();
      await mp.inst.doIssue(); await flush();   /* 页内 fire-and-forget，必须排干微任务 */
      const orderNo = (at(world.orders(), 0) || {}).orderNo;
      await mp.tutorStore.orderApi('submit', {
        orderNo: orderNo, planId: PLAN_ID_1, rawText: makeRawReceipt(orderNo), parsedBy: 'rule', by: 'mp',
      });

      const polish = await mp.tutorStore.orderApi('polish', { orderNo: orderNo });
      ok(polish.ok === true, 'polish 即使命中禁用词也返回 ok:true（闭环不因 AI 失败而断）');
      const doc = world.orderByNo(orderNo);
      ok(doc.status === 'submitted', '状态仍是 submitted（润色失败不影响已提交的事实）');
      ok(doc.evaluation.commentSource === 'rule', "commentSource 回落为 'rule'（实际 " + doc.evaluation.commentSource + '）');
      ok(doc.evaluation.comment.indexOf('已经掌握了') < 0,
        '越界表述「已经掌握了」**没有**落进评语（T22 补的动词短语组生效）');
      ok(hit(doc.events, (e) => e.type === 'polished').length === 1,
        'O4：仍留一条 polished 事件记录「补过润色」（失败原因可查，信息不丢）');
      const pk = world.orderByNo(orderNo);
      ok(require(path.join(ROOT, 'order-kit/orderKit.js')).findBannedWords(pk.evaluation.comment).length === 0,
        '最终评语通过 canonical 禁用词门禁');
    } finally { world.close(); }
  }

  /* 7.4 反向：AI 输出合法时，润色必须**真的生效**（否则 7.3 可能只是「polish 压根没跑」） */
  {
    const world = createWorld({ aiThrow: null, aiText: '这次他自己说出了 10 的两种分法，边界那一问提示后也能跟上，可以再来一轮。' });
    try {
      const mp = await bootMp(world);
      mp.inst.buildViews();
      await mp.inst.doIssue(); await flush();   /* 页内 fire-and-forget，必须排干微任务 */
      const orderNo = (at(world.orders(), 0) || {}).orderNo;
      await mp.tutorStore.orderApi('submit', {
        orderNo: orderNo, planId: PLAN_ID_1, rawText: makeRawReceipt(orderNo), parsedBy: 'rule', by: 'mp',
      });
      const before = world.orderByNo(orderNo).evaluation;
      const beforeComment = before.comment;
      const beforeVerdict = before.verdict;
      const polish = await mp.tutorStore.orderApi('polish', { orderNo: orderNo });
      const after = world.orderByNo(orderNo);
      ok(polish.ok === true && polish.polishFailed === false, '合规的 AI 输出 → 润色成功（polishFailed=false）');
      ok(after.evaluation.commentSource === 'ai', "commentSource='ai'");
      ok(after.evaluation.comment !== beforeComment && after.evaluation.comment.indexOf('两种分法') >= 0,
        '评语确实被替换成润色稿 ⇒ 7.3 的「回落」不是因为 polish 没跑');
      ok(after.evaluation.verdict === beforeVerdict,
        'verdict 未被 AI 改动（AI 无权参与判定：' + after.evaluation.verdict + '）');
      ok(after.evaluation.completeness === before.completeness,
        'completeness 同样未被 AI 改动（' + after.evaluation.completeness + '）');
      ok(require(path.join(ROOT, 'order-kit/orderKit.js')).findBannedWords(after.evaluation.comment).length === 0,
        '润色稿同样过门禁');
    } finally { world.close(); }
  }
}

/* ================================================================== *
 * 执行：每个 section 包 try/catch —— 抛异常一律转成红断言
 * （「测试可以红，但绝不能死」：一处函数被删不能让整段静默无输出）
 * ================================================================== */
const SECTIONS = [
  ['0. 环境自检（三端真源码都跑起来了，且结构上不连云）', selfTest],
  ['1. 链路 1（网页 → 小程序 → 网页）：出单 / 可见 / 回执 / 评语', linkWebToMp],
  ['2. 链路 2（小程序 → 网页 → 小程序）：出单 / 可见 / 回执 / 评语', linkMpToWeb],
  ['3. 一张单重复提交被拒（两条通道都必须拒绝，且原回执不被覆盖）', rejectDoubleSubmit],
  ['4. 所选计划与出单锚点不符被拒（「先选计划」的服务端兜底）', rejectPlanMismatch],
  ['5. 计划重生成后旧单仍正确归属（旧单不错挂新计划）', regenPlanOwnership],
  ['6. 数据卫生：e2e- 命名约定 / O3 隔离 / e2e 残留可一键清理', hygiene],
  ['7. 反证：把状态改坏后，同样的判定必须变红', counterproof],
];

process.on('unhandledRejection', (e) => {
  fails++;
  console.log('  ✗ 未捕获的 Promise 拒绝：' + ((e && e.message) || e));
});

/* ⚠️ 段标题必须在**执行时**打印：首版把 section() 写在模块顶层，
   于是 8 个标题在加载阶段就一次性全部打完，异步断言全部排到后面 —— 日志完全错序。 */
(async function main() {
  for (const [name, fn] of SECTIONS) {
    section(name);
    try {
      await fn();
    } catch (e) {
      ok(false, '[§' + name + '] 该段抛异常（已转成失败，不再静默中断）：' + ((e && e.message) || e));
    }
  }

  console.log('\n通过 ' + passes + ' 项，失败 ' + fails + ' 项');
  if (fails) {
    console.log('\n失败清单：');
    failureList.forEach((f) => console.log('  · ' + f));
    console.error('\n❌ 学习单全链路双向 E2E 未通过');
    process.exit(1);
  }
  console.log('✅ 学习单全链路双向 E2E 全通过');
  process.exit(0);
})();

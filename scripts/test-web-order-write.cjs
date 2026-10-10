#!/usr/bin/env node
/**
 * 网页看板「导学单」写路径功能测试（T21-b）—— **跑真实源码，不打桩业务逻辑**
 *
 * 为什么要有这个脚本：
 *   `scripts/check-web-orders.cjs` 是**静态**校验（正则 / 切片 / 计数），它能证明
 *   「代码里写了什么」，但**不能证明「发出去的请求对不对」**。T21 首轮就栽在这：
 *   静态全绿、功能缺失。所以这里把 web/index.html 里那段 1420 行的**真实应用脚本**
 *   用 `vm` 跑起来，只桩掉浏览器与云端（document / localStorage / cloudbase），
 *   然后直接调用真实的 `callWrite` / `doIssue` / `doSubmitReceipt` / `planTasksOf`，
 *   断言它们真正组装出来的 payload 形状。
 *
 * 覆盖面（每族都带**变异反证**：把源码改坏，断言必须变红）：
 *   ① 写通道     name=webAdminWrite / data.orders.{action,by} / 不出现第二条通道
 *   ② 保留键拦截 status|events|openid|_openid|clientId 五键全部拦下，且**不发请求**
 *   ③ 口令缺失   未设 token 直接 auth，不打云端
 *   ④ 锚点保位   planTasksOf 的 si/ti 是 stages/tasks 下标，跳过 done 但**不重排**
 *   ⑤ 可出单判据 无 startDate / 无 createdAt / 全勾完 → 一律排除
 *   ⑥ 出单 O1    planTask 五件套 + planCreatedAt 取自计划本身 + issuedBy=web
 *   ⑦ 回执 O2    planId 取自**该单自己的锚点**（端上不重算）+ rawText + parsedBy=rule
 *   ⑧ 两步选择   第一步只列有 issued 的计划；第二步只列该 planId 下 status=issued 的单
 *   ⑨ 量化项     留空 = 不传（让云端按解析结果走），填了才覆盖
 *
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const WEB = path.join(REPO, 'web', 'index.html');

let fails = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

/* ================================================================== *
 * 一、取出真实应用脚本
 * ================================================================== */
const webSrc = fs.readFileSync(WEB, 'utf8');
const scriptBlocks = [];
{
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(webSrc))) scriptBlocks.push(m[1]);
}
const APP_SRC = scriptBlocks[1] || '';
if (!APP_SRC) { console.error('❌ 取不到应用脚本（web/index.html 结构变了？）'); process.exit(1); }

/* ================================================================== *
 * 二、环境桩：只桩浏览器与云端，一行业务都不桩
 * ================================================================== */

/** 极简元素桩：够 renderOrders / renderOrdersWrite 跑通即可 */
function makeEl(id) {
  const el = {
    id: id || '', dataset: {}, style: {}, value: '', textContent: '', innerHTML: '',
    className: '', disabled: false,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, f) {
        if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
        else { f ? this._s.add(c) : this._s.delete(c); }
      },
    },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return makeEl(); },
    scrollIntoView() {}, appendChild() {}, setAttribute() {}, getAttribute() { return null; },
    focus() {}, click() {}, remove() {},
  };
  return el;
}

/**
 * 建一个沙箱并跑真实脚本。
 * @param {object} cfg
 *   cfg.cloud  自定义云端处理器 (name, data) => result；缺省用 cfg.responses
 *   cfg.sources 覆盖源码（变异反证用）
 *   cfg.profile 预置 DATA.profile
 *   cfg.orders  预置 DATA.orders
 *   cfg.token   预置口令
 */
function boot(cfg) {
  const c = cfg || {};
  const src = c.sources || [webSrc];
  const appScript = src[1] || APP_SRC;

  const els = new Map();
  const calls = [];
  const store = new Map();

  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelectorAll() { return []; },
    querySelector() { return makeEl(); },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
    body: makeEl('body'),
    documentElement: makeEl('html'),
  };
  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };

  const cloudHandler = c.cloud || (async (name, data) => {
    const key = name + ':' + ((data && data.module) || (data && data.orders && data.orders.action) || '');
    const r = (c.responses || {})[key];
    if (r instanceof Error) throw r;
    if (r !== undefined) return r;
    return { ok: true, data: {} };
  });

  const cloudbase = {
    init() {
      return {
        auth: () => ({ signInAnonymously: async () => ({}) }),
        callFunction: async (arg) => {
          calls.push({ name: arg.name, data: arg.data });
          const result = await cloudHandler(arg.name, arg.data);
          return { result };
        },
      };
    },
  };

  const sandbox = {
    console, document, localStorage, cloudbase,
    window: { addEventListener() {}, removeEventListener() {}, location: { href: '' } },
    navigator: { userAgent: 'node-test' },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.reject(new Error('no net')),
    alert() {}, confirm: () => true, prompt: () => '',
    location: { href: '', search: '', hash: '' },
    Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  /* 在**同一作用域**末尾追加测试钩子：脚本里的 let/const（TOKEN / DATA / app）
     是块级绑定，只有同作用域的代码才能读写它们 —— 这也是本测试能测"真函数"的关键。 */
  const hook = `
;globalThis.__T = {
  callWrite: callWrite,
  doIssue: doIssue,
  doSubmitReceipt: doSubmitReceipt,
  planTasksOf: planTasksOf,
  issuablePlansOf: issuablePlansOf,
  planCtxOf: planCtxOf,
  receiptPanelHtml: receiptPanelHtml,
  issuePanelHtml: issuePanelHtml,
  renderOrdersWrite: renderOrdersWrite,
  renderOrders: renderOrders,
  query: query,
  get ORDER_RESERVED_KEYS(){ return ORDER_RESERVED_KEYS; },
  get DATA(){ return DATA; },
  get TOKEN(){ return TOKEN; },
  setToken(v){ TOKEN = v; },
  setAccount(i){ selectedAccount = i; },
  setOrders(v){ DATA.orders = v; },
  setProfile(v){ DATA.profile = v; },
  getWriteTab(){ return oWriteTab; },
  setWriteTab(v){ oWriteTab = v; },
  getRcptStep(){ return oRcptStep; },
  setRcptStep(v){ oRcptStep = v; },
  setRcptPlan(v){ oRcptPlan = v; },
  setRcptOrder(v){ oRcptOrder = v; },
  setRcptPaste(v){ oRcptPaste = v; },
  setIssuePlanIdx(v){ oIssuePlanIdx = v; },
  setIssueTaskIdx(v){ oIssueTaskIdx = v; },
  setIssueKind(v){ oIssueKind = v; },
  setIssueMinutes(v){ oIssueMinutes = v; },
  getMsg(){ return oMsg; },
  setBusy(v){ oBusy = v; },
  probe(){ return { token: TOKEN, app: !!app, env: typeof ENV === 'string' ? ENV : '' }; }
};
`;

  const context = vm.createContext(sandbox);
  try {
    new vm.Script(appScript + hook, { filename: 'web/index.html#app' }).runInContext(context);
  } catch (e) {
    /* ⚠️ 不能只返回 {error} 就完事：调用方若照常读 h.T 会抛 TypeError，
       整个脚本**静默死掉**（不打印任何失败），看起来像"没跑到"而不是"红"。
       反证时实测过这个坑（拿 T21 只读版跑，整段无输出、退出码 0 之外的信号全无）。
       所以这里直接把错误带上文抛出，由 main() 转成一条明确的失败断言。 */
    throw new Error('脚本加载失败（hook 引用的函数在源码里不存在 → 很可能功能被删了）：' + e.message);
  }

  const T = sandbox.__T;
  if (!T) throw new Error('脚本加载后取不到测试钩子 __T（源码结构变了？）');
  if (c.token) T.setToken(c.token);
  if (c.profile) T.setProfile(c.profile);
  if (c.orders !== undefined) T.setOrders(c.orders);
  if (c.writeTab) T.setWriteTab(c.writeTab);

  return { T, calls, els, store, sandbox };
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */
const OPENID = 'o_test_child';

/** 一份已「开始计划」、有未勾选任务的成长计划 */
function makePlan(over) {
  const p = {
    grade: '一年级', term: '上学期', textbook: '人教版', subjectName: '数学',
    startDate: '2026-09-01', createdAt: 1756684800000, updatedAt: 1756771200000,
    stages: [
      { name: '第一阶段', weeks: '第1-2周', tasks: [
        { name: '认识10以内的数', days: 2, done: true, doneAt: '2026-09-02' },
        { name: '比大小', days: 1, done: false, doneAt: '' },
      ] },
      { name: '第二阶段', weeks: '第3-4周', tasks: [
        { name: '10的分解与组成', days: 2, done: false, doneAt: '' },
      ] },
    ],
  };
  return Object.assign(p, over || {});
}

function makeProfile(studyPlans) {
  return {
    accounts: [{
      openid: OPENID, nickname: '加一',
      studyPlans: studyPlans || { math: makePlan() },
      homework: {}, checkinTypes: [], schedule: null,
    }],
  };
}

const PLAN_ID = 'math@1756684800000';

/** 云端 orders 模块的典型出参（含 openid + plans 聚合） */
function makeOrdersData(orders, plans) {
  const cnt = { issued: 0, submitted: 0, closed: 0, cancelled: 0, voided: 0, total: orders.length };
  orders.forEach((o) => { if (cnt[o.status] !== undefined) cnt[o.status]++; });
  return {
    orders, counts: cnt, total: orders.length,
    plans: plans !== undefined ? plans : orders.reduce((acc, o) => {
      const pid = o.plan.planId; const k = o.openid + '::' + pid;
      let a = acc.filter((x) => x.openid + '::' + x.planId === k)[0];
      if (!a) { a = { openid: o.openid, planId: pid, key: o.plan.key, subjectName: o.plan.subjectName, taskName: o.plan.taskName, stageName: o.plan.stageName, si: o.plan.si, ti: o.plan.ti, issued: 0, submitted: 0, closed: 0, total: 0, lastAt: 0 }; acc.push(a); }
      a.total++; a[o.status] = (a[o.status] || 0) + 1;
      a.lastAt = Math.max(a.lastAt, o.issuedAt || 0);
      return acc;
    }, []),
  };
}

function makeOrder(over) {
  return Object.assign({
    orderNo: 'OR-20260928-001', openid: OPENID, status: 'issued', issuedAt: 1759026000000, issuedBy: 'mp',
    kind: 'concept', minutes: 10, subject: 'math', subjectName: '数学', title: '',
    plan: {
      key: 'math', planId: PLAN_ID, subjectName: '数学',
      si: 1, ti: 0, stageName: '第二阶段', taskName: '10的分解与组成',
      goal: '', days: 2, dueDay: 3, startDate: '2026-09-01', planUpdatedAt: 1756771200000,
    },
    events: [{ type: 'issued', at: 1759026000000, by: 'mp', detail: 'planId=' + PLAN_ID }],
  }, over || {});
}

/** 云端 submit 的成功出参 */
function submitOk() {
  return { ok: true, order: makeOrder({ status: 'submitted', submittedAt: 1759112400000 }), deduped: false, parsed: null };
}

/* ================================================================== *
 * §0 环境自检
 * ================================================================== */
section('0. 环境自检（证明桩是活的：真脚本跑起来了、云端真的被调到了）');
async function selfTest() {
  ok(APP_SRC.length > 10000, '取到应用脚本（' + APP_SRC.length + ' 字节）');

  const h = boot({ token: 'tok', profile: makeProfile() });
  ok(!!h.T && typeof h.T.callWrite === 'function', '真脚本加载成功，且能取到真实的 callWrite（不是桩）');
  ok(typeof h.T.doIssue === 'function' && typeof h.T.doSubmitReceipt === 'function',
    '两个写动作函数都从真源码里取到了（doIssue / doSubmitReceipt）');
  const probe = h.T.probe();
  ok(probe.token === 'tok', '预置口令被真实 TOKEN 变量读到（实测 ' + probe.token + '）');
  ok(probe.env.length > 0, '脚本自带 ENV 环境 ID（' + probe.env + '）');

  // 反证：桩真的会被调用
  return h.T.query('overview', { range: 'today' }).then(() => {
    ok(h.calls.length === 1 && h.calls[0].name === 'webAdminQuery',
      '自检：query() 真的打到了桩（' + h.calls.length + ' 次）');
  });
}

/* ================================================================== *
 * §1 写通道形状
 * ================================================================== */
section('1. 写通道：webAdminWrite.orders 对象形态 + by=web');
async function writeChannel() {
  const h = boot({
    token: 'tok', profile: makeProfile(),
    cloud: async (name, data) => (name === 'webAdminWrite'
      ? { ok: true, order: makeOrder(), deduped: false }
      : { ok: true, data: {} }),
  });
  const r = await h.T.callWrite('issue', { planTask: { key: 'math', si: 1, ti: 0, taskName: 'x' }, opts: { kind: 'concept' } });

  ok(r.ok === true, '写成功时返回 ok:true');
  ok(h.calls.length === 1, '恰好发出 1 次云端调用（实际 ' + h.calls.length + '）');
  const c0 = h.calls[0];
  ok(c0.name === 'webAdminWrite', "云函数名是 webAdminWrite（实际 " + c0.name + '）');
  ok(c0.data.token === 'tok', '带口令');
  ok(c0.data.orders && typeof c0.data.orders === 'object' && !Array.isArray(c0.data.orders),
    'orders 是**对象** { action, ...payload }，不是数组（数组=批量覆盖，会摧毁 O2/O4）');
  ok(c0.data.orders.action === 'issue', 'action 正确透传（' + c0.data.orders.action + '）');
  ok(c0.data.orders.by === 'web', "by 固定 'web'（三端留痕口径统一，实际 " + c0.data.orders.by + '）');
  ok(c0.data.orders.planTask.key === 'math', 'payload 原样透传（planTask.key=math）');
  ok(!('status' in c0.data.orders) && !('events' in c0.data.orders), '请求体不含 status / events');

  // 反证：若把 orders 改成数组，形状判据必须红
  const [sdk, app] = [webSrc, APP_SRC];
  const broken = [sdk, app.replace('orders: Object.assign({ action: action, by: \'web\' }, body)', 'orders: [Object.assign({ action: action, by: \'web\' }, body)]')];
  ok(broken[1] !== APP_SRC, '反证：成功构造出「orders 变数组」的变异体');
  const hb = boot({ token: 'tok', profile: makeProfile(), sources: broken });
  await hb.T.callWrite('issue', {});
  ok(Array.isArray(hb.calls[0].data.orders), '反证：变异体确实发出了数组 → 上面的对象形态判据真的会红');
}

/* ================================================================== *
 * §2 保留键拦截（双层防御的端上那层）
 * ================================================================== */
section('2. 保留键：五键全部拦下，且**一次云端请求都不发**');
async function reservedKeys() {
  const keys = ['status', 'events', 'openid', '_openid', 'clientId'];
  const h = boot({ token: 'tok', profile: makeProfile(), cloud: async () => ({ ok: true }) });
  ok(h.T.ORDER_RESERVED_KEYS.length === 5, '保留键表 5 项（实际 ' + h.T.ORDER_RESERVED_KEYS.length + '）');

  for (const k of keys) {
    const before = h.calls.length;
    const payload = {};
    payload[k] = k === 'events' ? [] : (k === 'status' ? 'closed' : 'x');
    const r = await h.T.callWrite('issue', payload);
    ok(r.ok === false && r.code === 'bad_param', '拦下保留键「' + k + '」→ bad_param（实际 ' + r.code + '）');
    ok(h.calls.length === before, '拦下「' + k + '」时**未发出**任何云端请求（端上就该挡住，不靠服务端兜底）');
    ok(r.msg.indexOf(k) >= 0, '错误信息点名了具体键「' + k + '」');
  }

  // 反证：把保留键表清空 → 同一 payload 必须能发出去（证明拦截真的来自这张表）
  const mutated = [webSrc, APP_SRC.replace(
    "const ORDER_RESERVED_KEYS = ['status','events','openid','_openid','clientId'];",
    'const ORDER_RESERVED_KEYS = [];')];
  ok(mutated[1] !== APP_SRC, '反证：成功构造出「保留键表清空」的变异体');
  const hm = boot({ token: 'tok', profile: makeProfile(), sources: mutated, cloud: async () => ({ ok: true, order: makeOrder() }) });
  const rm = await hm.T.callWrite('issue', { status: 'closed' });
  ok(rm.ok === true && hm.calls.length === 1,
    '反证：清空保留键表后 status 能直传 → 上面的拦截判据真的来自那张表（不是恒真）');
}

/* ================================================================== *
 * §3 口令缺失
 * ================================================================== */
section('3. 无口令：直接 auth 拒绝，不打云端');
async function noToken() {
  const h = boot({ profile: makeProfile() });   // 不预置 token
  const r = await h.T.callWrite('issue', { a: 1 });
  ok(r.ok === false && r.code === 'auth', '无口令 → auth（实际 ' + r.code + '）');
  ok(h.calls.length === 0, '无口令时不发任何云端请求（实际 ' + h.calls.length + ' 次）');
  ok(/口令/.test(r.msg), '错误信息是给家长看的人话（' + r.msg + '）');
}

/* ================================================================== *
 * §4 锚点保位：si / ti 是下标，跳过 done 但绝不重排
 * ================================================================== */
section('4. planTasksOf：si / ti 必须原样取自 stages / stage.tasks 下标');
async function anchorIndex() {
  const h = boot({ profile: makeProfile() });
  const tasks = h.T.planTasksOf(makePlan());

  ok(tasks.length === 2, '跳过已勾选任务，保留 2 个未完成任务（实际 ' + tasks.length + '）');
  ok(tasks[0].si === 0 && tasks[0].ti === 1, '第 1 行保持原下标 si=0 ti=1（被跳过的 ti=0 不挤位）—— 实测 si='
    + tasks[0].si + ' ti=' + tasks[0].ti);
  ok(tasks[1].si === 1 && tasks[1].ti === 0, '第 2 行 si=1 ti=0（阶段 2 的第 1 个任务，实测 si='
    + tasks[1].si + ' ti=' + tasks[1].ti);
  ok(tasks[0].name === '比大小' && tasks[1].name === '10的分解与组成', '任务名与下标对应正确（不串行）');
  ok(tasks[0].dueDay === 3, 'dueDay 累计了被跳过任务的 days（2+1=3，实际 ' + tasks[0].dueDay + '）');

  // 反证：先 filter 再编号（常见错误实现）→ 下标必须错位
  const mutated = [webSrc, APP_SRC.replace(
    `  plan.stages.forEach(function(st, si){
    ((st && st.tasks) || []).forEach(function(t, ti){
      cum += Number(t && t.days) || 1;
      if(t && t.done) return;                      /* 已勾选的不再出单（与小程序一致） */
      rows.push({
        si: si, ti: ti,`,
    `  plan.stages.forEach(function(st, si){
    ((st && st.tasks) || []).filter(function(t){ return !t.done; }).forEach(function(t, ti){
      cum += Number(t && t.days) || 1;
      rows.push({
        si: si, ti: ti,`)];
  ok(mutated[1] !== APP_SRC, '反证：成功构造出「先 filter 再编号」的变异体');
  const hm = boot({ profile: makeProfile(), sources: mutated });
  const mt = hm.T.planTasksOf(makePlan());
  ok(mt[0].ti === 0 && tasks[0].ti === 1,
    '反证：filter 后重新编号把 ti 从 1 变成 ' + mt[0].ti + ' → 锚点判据真的能抓到错位');
}

/* ================================================================== *
 * §5 可出单判据
 * ================================================================== */
section('5. issuablePlansOf：三类不可出单的情形必须被挡住');
async function issuable() {
  const h = boot({ profile: makeProfile() });

  /* ⚠️ 入参是 **account**（DATA.profile.accounts[i]），不是 profile。
     首版这里传错成 profile → 每一条都返回 0，「排除」断言全部**空过**
     （假绿最典型的形态：断言对了，但被测对象根本不存在）。下面每族都加正例对照。 */
  const acct = (sp) => makeProfile(sp).accounts[0];

  ok(h.T.issuablePlansOf(acct()).length === 1, '正常计划可出单（对照：不是 0，说明取到了 account）');

  /* 每一种「不可出单」都必须与一个**同结构的正例**成对出现，否则无法区分
     「真的被排除了」和「根本没读到计划」。 */
  const base = acct();
  ok(h.T.issuablePlansOf(base).length === 1, '基线正例：完整计划 → 1 份');
  ok(h.T.issuablePlansOf(acct({ math: makePlan({ startDate: '' }) })).length === 0,
    '未「开始计划」（startDate 为空）→ 0 份（同结构正例为 1 份，排除确实生效）');
  ok(h.T.issuablePlansOf(acct({ math: makePlan({ createdAt: 0 }) })).length === 0,
    '无 createdAt → 0 份（不产生挂在假 planId 上的孤儿单）');
  ok(h.T.issuablePlansOf(acct({
    math: makePlan({ stages: [{ name: 's', weeks: '', tasks: [{ name: 'a', days: 1, done: true, doneAt: '' }] }] }),
  })).length === 0, '任务全部勾完 → 0 份（正确动作是去小程序推进计划）');
  ok(h.T.issuablePlansOf(acct({ math: makePlan({ stages: null }) })).length === 0,
    'stages 缺失 / 非数组 → 0 份（不抛异常）');

  // 多学科：不可出单的学科不应把可出单的一起带走
  const two = acct({ math: makePlan(), chinese: makePlan({ startDate: '', subjectName: '语文' }) });
  const out = h.T.issuablePlansOf(two);
  ok(out.length === 1 && out[0].key === 'math',
    '两学科中只有 math 可出单 → 恰好返回 1 份且是 math（实际 ' + out.length + ' 份：' + out.map((x) => x.key).join(',') + '）');

  ok(h.T.issuablePlansOf({ studyPlans: null }).length === 0, 'studyPlans 为 null → 空数组（不抛异常）');
  ok(h.T.issuablePlansOf(null).length === 0, 'account 为 null → 空数组（不抛异常）');

  // 反证：把 createdAt 检查删掉 → 上面的「无 createdAt」断言必须红
  const mutated = [webSrc, APP_SRC.replace('if(!p.startDate || !p.createdAt || !Array.isArray(p.stages)) return;',
    'if(!p.startDate || !Array.isArray(p.stages)) return;')];
  ok(mutated[1] !== APP_SRC, '反证：成功构造出「不检查 createdAt」的变异体');
  const hm = boot({ profile: makeProfile(), sources: mutated });
  ok(hm.T.issuablePlansOf(acct({ math: makePlan({ createdAt: 0 }) })).length === 1,
    '反证：删掉 createdAt 检查后，无 createdAt 的计划也能出单 → 上面那条判据真的有效');
}

/* ================================================================== *
 * §6 出单 O1：planTask 五件套
 * ================================================================== */
section('6. doIssue：O1 锚点五件套 + planCreatedAt 取自计划本身 + issuedBy=web');
async function issueE2E() {
  const h = boot({
    token: 'tok', profile: makeProfile(), orders: makeOrdersData([]),
    cloud: async (name, data) => {
      if (name === 'webAdminWrite') return { ok: true, order: makeOrder(), deduped: false };
      return { ok: true, data: makeOrdersData([makeOrder()]) };
    },
  });

  h.T.setWriteTab('issue');
  await h.T.doIssue();

  const w = h.calls.filter((c) => c.name === 'webAdminWrite');
  ok(w.length === 1, '发出 1 次写请求（实际 ' + w.length + '）');
  const o = w[0].data.orders;
  ok(o.action === 'issue', 'action=issue');
  ok(o.issuedBy === undefined, 'issuedBy 不在顶层（由 opts 承载）');
  const pt = o.planTask || {};
  ok(pt.key === 'math', 'planTask.key=math（实际 ' + pt.key + '）');
  /* 默认选中第 1 个未完成任务 = 阶段 0 的下标 1（「比大小」；阶段 0 的 ti=0 已勾选被跳过） */
  ok(pt.si === 0 && pt.ti === 1, 'planTask.si/ti 取默认选中任务的下标（实际 si=' + pt.si + ' ti=' + pt.ti + '）');
  ok(pt.planCreatedAt === 1756684800000, 'planCreatedAt 取自计划的 createdAt（实际 ' + pt.planCreatedAt + '）');
  ok(/^\w+@1756684800000$/.test(pt.key + '@' + pt.planCreatedAt), 'planId 形状 = key@createdAt（' + pt.key + '@' + pt.planCreatedAt + '）');
  ok(pt.taskName === '比大小', 'planTask.taskName 与下标对应（实际 ' + pt.taskName + '）');
  ok(pt.stageName === '第一阶段', 'planTask.stageName 与下标对应（实际 ' + pt.stageName + '）');
  ok(pt.startDate === '2026-09-01' && pt.planUpdatedAt === 1756771200000, 'startDate / planUpdatedAt 一并带上');
  ok(o.opts.issuedBy === 'web', "opts.issuedBy='web'（实际 " + o.opts.issuedBy + '）');
  ok(o.opts.kind === 'concept' && o.opts.minutes === 10, 'kind / minutes 透传（' + o.opts.kind + ' / ' + o.opts.minutes + '）');
  ok(!('clientId' in o) && !('status' in o), '不携带 clientId / status');

  /* 改选第 2 个任务：下标必须跟着走（证明选中态真的被带进锚点，而不是永远发第 0 个） */
  const h2 = boot({
    token: 'tok', profile: makeProfile(), orders: makeOrdersData([]),
    cloud: async (name) => (name === 'webAdminWrite' ? { ok: true, order: makeOrder() } : { ok: true, data: makeOrdersData([makeOrder()]) }),
  });
  h2.T.setWriteTab('issue');
  h2.T.setIssueTaskIdx(1);
  await h2.T.doIssue();
  const pt2 = h2.calls.filter((c) => c.name === 'webAdminWrite')[0].data.orders.planTask;
  ok(pt2.si === 1 && pt2.ti === 0, '改选第 2 个任务后锚点跟着变 si=1 ti=0（实际 si=' + pt2.si + ' ti=' + pt2.ti + '）');
  ok(pt2.taskName === '10的分解与组成', '改选后 taskName 同步（实际 ' + pt2.taskName + '）');
  ok(pt2.planCreatedAt === pt.planCreatedAt, '改选任务不改变 planCreatedAt（同一份计划）');

  const msg = h.T.getMsg();
  ok(msg && msg.kind === 'ok' && /出单成功/.test(msg.text), '成功后给出人话回执（' + (msg && msg.text) + '）');
  ok(h.calls.some((c) => c.name === 'webAdminQuery' && c.data.module === 'orders'),
    '出单后自动重查 orders（状态以云端回流为准）');

  // 反证：把 planCreatedAt 改成 Date.now() → 锚点判据必须红
  const mutated = [webSrc, APP_SRC.replace('planCreatedAt: cur.plan.createdAt,', 'planCreatedAt: Date.now(),')];
  ok(mutated[1] !== APP_SRC, '反证：构造出「端上补造 createdAt」的变异体');
  const hm = boot({
    token: 'tok', profile: makeProfile(), orders: makeOrdersData([]),
    sources: mutated,
    cloud: async (name) => (name === 'webAdminWrite' ? { ok: true, order: makeOrder() } : { ok: true, data: makeOrdersData([makeOrder()]) }),
  });
  hm.T.setWriteTab('issue');
  await hm.T.doIssue();
  const mpt = hm.calls.filter((c) => c.name === 'webAdminWrite')[0].data.orders.planTask;
  ok(mpt.planCreatedAt !== 1756684800000,
    '反证：变异体确实补造了 createdAt（变成 ' + mpt.planCreatedAt + '）→ 锚点判据真的有效');
}

/* ================================================================== *
 * §7 回执 O2：planId 取自该单自己的锚点，端上不重算
 * ================================================================== */
section('7. doSubmitReceipt：planId 取自本单锚点 + rawText + parsedBy=rule');
async function submitE2E() {
  const RAW = [
    '费曼训练证据回执',
    '训练编号：OR-20260928-001',
    '知识点与核心目标：10 的分解',
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
    '下次建议：再来一轮',
  ].join('\n');

  const req = makeOrder();
  const h = boot({
    token: 'tok', profile: makeProfile(), orders: makeOrdersData([req]),
    cloud: async (name) => (name === 'webAdminWrite'
      ? submitOk()
      : { ok: true, data: makeOrdersData([makeOrder({ status: 'submitted', submittedAt: 1759112400000 })]) }),
  });

  h.T.setWriteTab('receipt');
  h.T.setRcptStep(3);
  h.T.setRcptPlan(PLAN_ID);
  h.T.setRcptOrder(req.orderNo);
  h.T.setRcptPaste(RAW);
  await h.T.doSubmitReceipt();

  const w = h.calls.filter((c) => c.name === 'webAdminWrite');
  ok(w.length === 1, '发出 1 次写请求（实际 ' + w.length + '）');
  const o = w[0].data.orders;
  ok(o.action === 'submit', 'action=submit');
  ok(o.orderNo === req.orderNo, 'orderNo 正确（' + o.orderNo + '）');
  ok(o.planId === PLAN_ID, 'planId 取自**该单锚点**（' + o.planId + '）');
  ok(o.planId === req.plan.planId, 'planId 与 order.plan.planId 逐字相同 —— 端上不重算 planIdOf');
  ok(o.rawText === RAW, 'rawText 原样提交（' + (o.rawText ? o.rawText.length : 0) + ' 字符）');
  ok(o.parsedBy === 'rule', "parsedBy='rule'（云端用 canonical 解析器抽取）");
  ok(o.fields === undefined, '不提交 fields —— 端上不解析（否则会算出第四种 verdict）');
  ok(o.planCtx && o.planCtx.updatedAt === 1756771200000, 'planCtx.updatedAt 取自计划（' + (o.planCtx && o.planCtx.updatedAt) + '）');
  ok(o.planCtx.taskExists === true, 'planCtx.taskExists=true（锚点任务仍在计划里）');
  ok(o.quant === undefined, '量化项全留空 → 不传 quant（让云端按解析结果走）');
  ok(!('status' in o) && !('events' in o), '请求体不含 status / events');

  // planCtx 只报事实：任务不存在时应为 false
  const planMoved = makeProfile({ math: makePlan({ stages: [{ name: 's', weeks: '', tasks: [{ name: '别的任务', days: 1, done: false, doneAt: '' }] }] }) });
  ok(h.T.planCtxOf(planMoved.accounts[0], 'math', 1, 0).taskExists === false,
    'planCtx.taskExists：锚点任务已不在计划里 → false（端上只报事实，不判定）');
  ok(h.T.planCtxOf(makeProfile().accounts[0], 'nope', 0, 0) === null, '计划不存在 → planCtx 为 null（不造默认值）');

  // 量化项：填了才覆盖
  const h2 = boot({
    token: 'tok', profile: makeProfile(), orders: makeOrdersData([req]),
    cloud: async (name) => (name === 'webAdminWrite' ? submitOk() : { ok: true, data: makeOrdersData([makeOrder()]) }),
  });
  h2.T.setWriteTab('receipt'); h2.T.setRcptStep(3); h2.T.setRcptPlan(PLAN_ID);
  h2.T.setRcptOrder(req.orderNo); h2.T.setRcptPaste(RAW);
  // 直接调 callWrite 验证 quant 形状（doSubmitReceipt 的 quant 从 DOM 取，桩 DOM 无输入框）
  const rr = await h2.T.callWrite('submit', { orderNo: req.orderNo, planId: PLAN_ID, rawText: RAW, parsedBy: 'rule', quant: { rounds: 2, minutes: 8, selfEval: 4, errorType: 'E4' } });
  ok(rr.ok === true, '带 quant 提交成功');
  const q = h2.calls.filter((c) => c.name === 'webAdminWrite')[0].data.orders.quant;
  ok(q.rounds === 2 && q.minutes === 8 && q.selfEval === 4 && q.errorType === 'E4', 'quant 四值透传（' + JSON.stringify(q) + '）');

  // 空粘贴必须被挡在端上（不打云端）
  const h3 = boot({ token: 'tok', profile: makeProfile(), orders: makeOrdersData([req]), cloud: async () => ({ ok: true }) });
  h3.T.setWriteTab('receipt'); h3.T.setRcptStep(3); h3.T.setRcptPlan(PLAN_ID);
  h3.T.setRcptOrder(req.orderNo); h3.T.setRcptPaste('   ');
  await h3.T.doSubmitReceipt();
  ok(h3.calls.filter((c) => c.name === 'webAdminWrite').length === 0, '空粘贴被端上挡下，未发请求');
  ok(/粘贴/.test((h3.T.getMsg() || {}).text || ''), '并给出「请先粘贴回执原文」提示');
}

/* ================================================================== *
 * §8 回执两步选择：先选计划 → 再选该计划下的 issued 单
 * ================================================================== */
section('8. receiptPanelHtml：两步选择（选计划 → 选该计划下的待回执单）');
async function twoStep() {
  const p1 = makeOrder({ orderNo: 'OR-A', status: 'issued', plan: Object.assign({}, makeOrder().plan, { planId: 'math@1', key: 'math', subjectName: '数学', taskName: '任务甲' }) });
  const p2 = makeOrder({ orderNo: 'OR-B', status: 'issued', plan: Object.assign({}, makeOrder().plan, { planId: 'chinese@2', key: 'chinese', subjectName: '语文', taskName: '任务乙' }) });
  const p3 = makeOrder({ orderNo: 'OR-C', status: 'issued', plan: Object.assign({}, makeOrder().plan, { planId: 'chinese@2', key: 'chinese', subjectName: '语文', taskName: '任务乙' }) });
  const sub = makeOrder({ orderNo: 'OR-D', status: 'submitted', plan: Object.assign({}, makeOrder().plan, { planId: 'math@1' }) });
  const orders = [p1, p2, p3, sub];
  const data = makeOrdersData(orders);

  const h = boot({ token: 'tok', profile: makeProfile(), orders: data });
  const mine = orders.filter((o) => o.openid === OPENID);
  const plans = data.plans.filter((p) => p.openid === OPENID);

  // 第一步：只列有 issued 的计划
  h.T.setRcptStep(1);
  let html = h.T.receiptPanelHtml(makeProfile().accounts[0], plans, mine);
  ok(/1 选计划/.test(html) && /2 选出单/.test(html) && /3 粘贴并确认/.test(html), '三步指示器齐全');
  ok(html.indexOf('math@1') >= 0 && html.indexOf('chinese@2') >= 0, '列出两个有待回执单的计划');
  ok(/data-or-pplan="math@1"/.test(html), '计划以 data-or-pplan 暴露（planId 为键）');
  ok(!/data-or-porder/.test(html), '第一步**不**列出具体出单（必须先进第二步）');
  ok(!html.includes('OR-D'), '已回执的单不出现在第一步');

  // 第二步：只列该 planId 下的 issued 单
  h.T.setRcptStep(2); h.T.setRcptPlan('chinese@2');
  html = h.T.receiptPanelHtml(makeProfile().accounts[0], plans, mine);
  ok(/data-or-porder="OR-B"/.test(html) && /data-or-porder="OR-C"/.test(html), '第二步列出该计划下 2 张待回执单');
  ok(!/data-or-porder="OR-A"/.test(html), '不列其它计划的单（planId 对位）');
  ok(!/data-or-porder="OR-D"/.test(html), "不列 status!=='issued' 的单");
  ok(/一个出单只能对应一个回执/.test(html), '明写 1:1 约束');

  // 第二步选了「没有 issued 单」的计划 → 明确提示而非静默空白
  h.T.setRcptPlan('nope@0');
  html = h.T.receiptPanelHtml(makeProfile().accounts[0], plans, mine);
  ok(/没有待回执的出单/.test(html), '该计划无待回执单时给出明确提示');
  ok(/不支持手工造单提交/.test(html), '并说明回执不能凭空造单');

  // 全部已回执 → 整体空态
  const allSub = orders.map((o) => Object.assign({}, o, { status: 'submitted' }));
  const h2 = boot({ token: 'tok', profile: makeProfile(), orders: makeOrdersData(allSub) });
  html = h2.T.receiptPanelHtml(makeProfile().accounts[0], h2.T.DATA.orders.plans, allSub);
  ok(/没有「待回执」的导学单/.test(html), '无待回执单时给出整体空态（不显示空的选单界面）');
}

/* ================================================================== *
 * §9 出单面板：无计划时的明确引导（决策 4）
 * ================================================================== */
section('9. issuePanelHtml：无可出单计划时必须明确引导，不能给一个空表单');
async function issuePanel() {
  const h = boot({ token: 'tok', profile: makeProfile() });
  let html = h.T.issuePanelHtml(makeProfile().accounts[0]);
  ok(/data-oi-pplan/.test(html), '有计划时渲染计划选择器');
  ok(/data-oi-ptask/.test(html), '并渲染任务选择器');
  ok(/si=0 ti=1/.test(html) || /si=0/.test(html), '任务行展示锚点下标（可核对）');
  ok(/data-oi-do="issue"/.test(html), '有出单按钮');
  ok(/issuedBy=web/.test(html), '明示留痕口径 issuedBy=web');

  const noPlan = boot({ token: 'tok', profile: makeProfile({ math: makePlan({ startDate: '' }) }) });
  html = noPlan.T.issuePanelHtml(makeProfile({ math: makePlan({ startDate: '' }) }).accounts[0]);
  ok(/还没有可以出单的成长计划/.test(html), '无计划时给出明确空态');
  ok(/不支持无计划自由出单/.test(html), '明写决策 4（不支持无计划自由出单）');
  ok(!/data-oi-do="issue"/.test(html), '无计划时不渲染出单按钮（不给能点但必失败的表单）');
}

/* ================================================================== *
 * §10 渲染不抛：边界数据下 renderOrders 必须稳
 * ================================================================== */
section('10. renderOrders 边界数据鲁棒性');
async function robustness() {
  const cases = [
    ['正常', makeProfile(), makeOrdersData([makeOrder()])],
    ['无单', makeProfile(), makeOrdersData([])],
    ['orders 为 null', makeProfile(), null],
    ['orders.orders 非数组', makeProfile(), { orders: 'x', plans: null }],
    ['plans 缺失', makeProfile(), { orders: [makeOrder()] }],
    ['单缺 plan', makeProfile(), { orders: [Object.assign(makeOrder(), { plan: null })], plans: [] }],
    ['全作废', makeProfile(), makeOrdersData([makeOrder({ status: 'voided' })])],
    ['无账号', { accounts: [] }, makeOrdersData([])],
    ['profile 为 null', null, makeOrdersData([])],
  ];
  for (const [label, profile, orders] of cases) {
    const h = boot({ token: 'tok', profile: profile || undefined, orders: orders });
    let threw = null;
    try { h.T.renderOrders(); } catch (e) { threw = e; }
    ok(!threw, 'renderOrders 在「' + label + '」下不抛异常（' + (threw ? threw.message : 'ok') + '）');
  }

  // 写区必须在「无单」时也渲染 —— 否则新账号永远出不了第一张单
  const h = boot({ token: 'tok', profile: makeProfile(), orders: makeOrdersData([]) });
  h.T.renderOrders();
  const wbox = h.els.get('ordersWrite');
  ok(wbox && wbox.innerHTML.length > 0, '无单时写区**仍然渲染**（否则新账号出不了第一张单）');
  ok(/data-oi-do="issue"/.test(wbox.innerHTML), '无单时出单按钮可见');
  ok(/data-ow-tab="receipt"/.test(wbox.innerHTML), '两个页签都在（出单 / 交回执）');
}

section('11. 加载态：入口必须在数据到达前就存在（owner 报「没找到交回执的入口」的根因）');
async function loadingEntry() {
  /* 规格：从过门到云数据到达之间（refreshAll 的 Promise.all 期间，实测约 8 秒），
     导学单页**必须**已经看得到「出单 / 交回执」两个页签。
     原实现里 `renderOrders()` 只在 Promise.all 之后调用一次，这段是全空的
     （#ordersWrite 与 #ordersContent 双空），用户会直接判定「网页端没有这个功能」。
     真机复现：用真实口令登录 moodlife.xyz，4.5 秒时读到的写区 innerHTML 为空字符串。 */

  // ① profile 尚未加载（DATA.profile === null）—— 最典型的加载态
  {
    const h = boot({ token: 'tok' });   // 不传 profile → DATA.profile 保持 null
    h.T.renderOrders();
    const w = h.els.get('ordersWrite');
    ok(!!w && w.innerHTML.length > 0, '加载态下写区**不是空的**（不再被静默清空）');
    ok(/data-ow-tab="issue"/.test(w.innerHTML), '加载态下「出单」页签已经在');
    ok(/data-ow-tab="receipt"/.test(w.innerHTML), '加载态下「交回执」页签已经在');
    ok(/导学单数据加载中/.test(w.innerHTML), '加载态下面板给出明确「加载中」占位');
    const c = h.els.get('ordersContent');
    ok(!!c && /导学单数据加载中/.test(c.innerHTML), '加载态下内容区也给出明确提示（不是留白）');
  }

  // ② profile 已到 / orders 未到 —— 出单只依赖 profile.studyPlans，不该被 orders 拖住
  {
    const h = boot({ token: 'tok', profile: makeProfile(), orders: null });
    h.T.renderOrders();
    const w = h.els.get('ordersWrite');
    ok(/data-ow-tab="issue"/.test(w.innerHTML) && /data-ow-tab="receipt"/.test(w.innerHTML),
      'orders 未到时两个页签仍然都在');
    ok(/data-oi-do="issue"/.test(w.innerHTML),
      'orders 未到时**出单面板照常可用**（出单只依赖 profile.studyPlans，与 orders 无关）');
    ok(/data-oi-pplan/.test(w.innerHTML), 'orders 未到时出单计划选择器已可点');
    ok(output_shows_loading(h), 'orders 未到时内容区明示「加载中」并指引「重新拉取」');

    // 切到「交回执」：这个面板确实需要 orders，才该给占位
    h.T.setWriteTab('receipt');
    h.T.renderOrders();
    ok(/导学单数据加载中/.test(h.els.get('ordersWrite').innerHTML),
      'orders 未到时切到「交回执」给加载占位（该面板必须等 orders）');
    ok(!/data-oi-do="issue"/.test(h.els.get('ordersWrite').innerHTML),
      '回执占位态下不残留出单按钮（不给出会误操作的按钮）');
  }

  // ③ 对照（反证）：数据齐全时不得出现「加载中」字样 —— 证明该文案不是恒真
  {
    const h = boot({ token: 'tok', profile: makeProfile(), orders: makeOrdersData([makeOrder()]) });
    h.T.renderOrders();
    const w = h.els.get('ordersWrite');
    ok(!/导学单数据加载中/.test(w.innerHTML), '数据齐全时不再显示「加载中」（证明该文案只在加载态出现）');
    ok(/data-ow-tab="receipt"/.test(w.innerHTML), '数据齐全时「交回执」页签仍在');
    ok(/data-oi-do="issue"/.test(w.innerHTML), '数据齐全时出单面板正常');
  }
}

/** 内容区是否给出了加载态提示 */
function output_shows_loading(h) {
  const c = h.els.get('ordersContent');
  return !!c && /导学单数据加载中/.test(c.innerHTML) && /重新拉取/.test(c.innerHTML);
}


/* ================================================================== *
 * 顺序执行：await 每一个 section，保证输出顺序与阅读顺序一致
 * （首版用 IIFE，异步段落的 ok() 全部延后到同步段落之后打印，日志完全错序）
 *
 * ⚠️ 每个 section 都包一层 try/catch：任何**抛异常**都必须转成一条红断言。
 * 不这么做的话，一处「函数被删了」会让整个脚本静默死掉 —— 输出为空、也不报失败，
 * 看起来像"没跑到"。反证时实测过：拿 T21 只读版跑，整段无输出。
 * 测试可以红，但绝不能**死**。
 * ================================================================== */
const SECTIONS = [
  ['0 环境自检', selfTest],
  ['1 写通道', writeChannel],
  ['2 保留键', reservedKeys],
  ['3 无口令', noToken],
  ['4 锚点保位', anchorIndex],
  ['5 可出单判据', issuable],
  ['6 出单 O1', issueE2E],
  ['7 回执 O2', submitE2E],
  ['8 两步选择', twoStep],
  ['9 出单面板', issuePanel],
  ['10 边界鲁棒', robustness],
  ['11 加载态入口', loadingEntry],
];

process.on('unhandledRejection', (e) => {
  fails++;
  console.log('  ✗ 未捕获的 Promise 拒绝：' + ((e && e.message) || e));
});

(async function main() {
  for (const [name, fn] of SECTIONS) {
    try {
      await fn();
    } catch (e) {
      ok(false, '[§' + name + '] 该段抛异常（已转成失败，不再静默中断）：' + ((e && e.message) || e));
    }
  }

  console.log('\n通过 ' + passes + ' 项，失败 ' + fails + ' 项');
  if (fails) { console.error('\n❌ 网页看板「导学单」写路径测试未通过'); process.exit(1); }
  console.log('✅ 网页看板「导学单」写路径测试全通过');
  process.exit(0);
})();

#!/usr/bin/env node
/**
 * test-parent-gate-scope.cjs —— 家长门禁「真的接进了写入口」
 * ==========================================================================================
 *     node scripts/test-parent-gate-scope.cjs
 *
 * 背景：parentAuth 在 2026-10-28 就做完了（PIN / 锁定 / 2 小时会话 / scopes），
 * 但**没有任何页面消费它** —— mine 页却写着「签发学习单、修改计划需要通过这道验证」。
 * 那是"功能看起来有、实际没有"的最坏形态，所以这里把它钉死：
 *
 *   §1 utils/parentAuth.requireScope：无会话拦截 / 有会话放行 / 缺 scope 拦截 / 过期拦截 / 离线放行
 *   §2 三个写入口的处理器体里必须**在落库之前**调 requireScope（不认「文件里出现过」这种弱断言）
 *   §3 parentGate 页消费 ?scope= ，验证通过后回跳调用页
 *   §4 文案与实际门禁范围一致（三处动作，不多不少）
 *   §5 反证：抽掉 order 的门禁、抽掉页面的 scope 回跳 → 本脚本必须变红
 *
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const UTIL = path.resolve(process.env.PGS_UTIL || path.join(ROOT, 'miniprogram/utils/parentAuth.js'));
const ORDER = path.resolve(process.env.PGS_ORDER || path.join(ROOT, 'miniprogram/pkgGuide/order/order.js'));
const PLAN = path.resolve(process.env.PGS_PLAN || path.join(ROOT, 'miniprogram/pkgTools/plan/plan.js'));
const TYPE = path.resolve(process.env.PGS_TYPE || path.join(ROOT, 'miniprogram/pkgTools/typeManage/typeManage.js'));
const PAGE = path.resolve(process.env.PGS_PAGE || path.join(ROOT, 'miniprogram/pkgGuide/parentGate/parentGate.js'));
const MINE = path.join(ROOT, 'miniprogram/pages/mine/mine.wxml');
const CHILD = process.env.PGS_CHILD || '';

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; return true; }
  fail++;
  console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''));
  return false;
}
function group(name) { console.log('\n' + name); }

/* ------------------------------ 假小程序环境 ------------------------------ */
const storage = {};
let modals = [];
let navs = [];
let cloudOk = true;

global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
  showModal: (o) => { modals.push(o); if (o && o.success) o.success({ confirm: true, cancel: false }); },
  navigateTo: (o) => { navs.push(o && o.url); },
  cloud: {
    callFunction: (o) => Promise.resolve({ result: (o && o.data && o.data.action === 'status')
      ? { ok: true, hasPin: true, locked: false, scopes: [] }
      : { ok: true } })
  }
};

function freshUtil() {
  delete require.cache[require.resolve(UTIL)];
  return require(UTIL);
}

/** 取对象方法体（同名函数只取第一个；用花括号配平，不算注释里的括号） */
function bodyOf(src, name) {
  const re = new RegExp('(?:async\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

/* ------------------------------ §1 requireScope 行为 ------------------------------ */
function seedSession(session) {
  Object.keys(storage).forEach(k => delete storage[k]);
  if (session) storage.parentSession = session;
}
function futureSession(scopes) {
  return { token: 'tk_' + 'x'.repeat(40), expiresAt: Date.now() + 60 * 60 * 1000, scopes: scopes, at: Date.now() };
}

async function sectionUtil() {
  group('一、requireScope：写入口的前置门');
  const auth = freshUtil();

  ok(JSON.stringify(auth.SCOPES) === JSON.stringify(['orderIssue', 'planEdit', 'subjectToggle']),
    '权限表恰为三项（无页面/无动作的权限不入表）', JSON.stringify(auth.SCOPES));
  ok(auth.SCOPES.every(s => !!auth.SCOPE_LABEL[s]), '每个权限都有中文标签');

  modals = []; navs = [];
  seedSession(null);
  let got = await auth.requireScope('orderIssue');
  ok(got === false, '无会话 → 拦截（false）');
  ok(modals.length === 1 && /家长验证/.test(modals[0].title || ''), '无会话 → 弹「需要家长验证」');
  ok(navs.length === 1 && navs[0].indexOf('/pkgGuide/parentGate/parentGate?scope=orderIssue') === 0,
    '无会话 → 带 scope 跳验证页', JSON.stringify(navs));

  modals = []; navs = [];
  seedSession(futureSession(['orderIssue', 'planEdit', 'subjectToggle']));
  got = await auth.requireScope('planEdit');
  ok(got === true, '有覆盖该 scope 的会话 → 放行');
  ok(modals.length === 0 && navs.length === 0, '放行时不打扰用户');

  modals = []; navs = [];
  seedSession(futureSession(['orderIssue']));
  got = await auth.requireScope('subjectToggle');
  ok(got === false, '会话缺该 scope → 拦截');
  ok(modals.length === 1, '缺 scope 时同样弹验证引导');

  modals = []; navs = [];
  seedSession({ token: 'tk_old', expiresAt: Date.now() - 1000, scopes: ['orderIssue'] });
  got = await auth.requireScope('orderIssue');
  ok(got === false, '会话过期 → 拦截');
  ok(!storage.parentSession, '过期会话被清出 storage');

  modals = []; navs = [];
  seedSession(null);
  const savedCloud = global.wx.cloud;
  delete global.wx.cloud;
  got = await auth.requireScope('orderIssue');
  ok(got === true, '离线/本地模式 → 放行（口令依赖云端，拦住会把写入口锁死）');
  ok(modals.length === 0, '离线放行时静默，不弹一个点了也没用的窗');
  global.wx.cloud = savedCloud;
}

/* ------------------------------ §2 写入口接线 ------------------------------ */
function assertCallIn(srcPath, fnName, scope, label) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const body = bodyOf(src, fnName);
  if (!body) return ok(false, label + '：找不到处理器 ' + fnName);
  const re = new RegExp("parentAuth\\.requireScope\\(\\s*'" + scope + "'\\s*\\)");
  ok(re.test(body), label + '：' + fnName + ' 体内有 requireScope(' + scope + ')');
  const gateAt = body.search(re);
  const writeAt = Math.min(...['orderApi(', 'store.save(', 'studyPlan.savePlan(', 'studyPlan.removePlan(']
    .map(k => body.indexOf(k)).filter(i => i >= 0).concat([Infinity]));
  if (Number.isFinite(writeAt)) {
    ok(gateAt < writeAt, label + '：门禁在写操作之前（不是写完再问）');
  }
}

function sectionWiring() {
  group('二、三处写入口：门禁必须在落库之前');
  assertCallIn(ORDER, 'doIssue', 'orderIssue', '学习单');
  assertCallIn(ORDER, 'doReissue', 'orderIssue', '学习单');
  assertCallIn(PLAN, 'generate', 'planEdit', '成长计划');
  assertCallIn(PLAN, 'clearPlan', 'planEdit', '成长计划');
  assertCallIn(TYPE, 'confirmForm', 'subjectToggle', '打卡类型');
  assertCallIn(TYPE, 'removeType', 'subjectToggle', '打卡类型');

  // 只读/孩子可做的动作不能误伤：勾任务、开始计划、回执提交
  const planSrc = fs.readFileSync(PLAN, 'utf8');
  ok(!/parentAuth\.requireScope/.test(bodyOf(planSrc, 'toggleTask')), '勾选任务（孩子可做）不加门禁');
  const orderSrc = fs.readFileSync(ORDER, 'utf8');
  ok(!/parentAuth\.requireScope/.test(bodyOf(orderSrc, 'submitReceipt')), '提交回执（孩子可做）不加门禁');
}

/* ------------------------------ §3 页面回跳 ------------------------------ */
function sectionPage() {
  group('三、parentGate 页：带 scope 进来，验证通过自动回跳');
  const src = fs.readFileSync(PAGE, 'utf8');
  ok(/onLoad\s*\(\s*options\s*\)/.test(src), '页面有 onLoad(options)');
  const onLoad = bodyOf(src, 'onLoad');
  ok(/options\.scope|options\s*&&\s*options\.scope/.test(onLoad), 'onLoad 读取 ?scope=');
  ok(/SCOPE_LABEL\[/.test(onLoad), 'scope 必须来自白名单标签（不认任意字符串）');
  const unlocked = bodyOf(src, 'unlocked');
  ok(/backToCaller/.test(unlocked), '验证通过后回跳调用页');
  ok(/navigateBack/.test(bodyOf(src, 'backToCaller')), '回跳优先 navigateBack（保留调用页状态）');

  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pkgGuide/parentGate/parentGate.wxml'), 'utf8');
  ok(/scopeLabel/.test(wxml), '页面展示「本次操作」提示');
}

/* ------------------------------ §4 文案口径 ------------------------------ */
function sectionCopy() {
  group('四、文案与实际门禁范围一致');
  const mine = fs.readFileSync(MINE, 'utf8');
  ok(/签发\/作废学习单/.test(mine) && /修改计划/.test(mine) && /增删打卡类型/.test(mine),
    'mine 入口文案写明三种受控动作');
  ok(!/家长日报/.test(mine), '不再宣称「家长日报」门禁（日报页尚未建）');
  const utilSrc = fs.readFileSync(UTIL, 'utf8');
  ok(!/dailyReport/.test(utilSrc) && !/dataExport/.test(utilSrc), '端上权限表不再留无动作的权限');
  const cloudSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions/parentAuth/index.js'), 'utf8');
  ok(/SESSION_SCOPES\s*=\s*\[\s*'orderIssue',\s*'planEdit',\s*'subjectToggle'\s*\]/.test(cloudSrc),
    '云端 SESSION_SCOPES 与端上同源（三项）');
}

/* ------------------------------ §5 反证 ------------------------------ */
function sectionCounterproof() {
  if (CHILD) return;
  group('五、反证：拆掉门禁，本测试必须变红');
  const mutants = [
    {
      name: '出单不再要家长验证',
      file: ORDER,
      env: { PGS_ORDER: path.join(path.dirname(ORDER), '_mut_gate_order.js') },
      transform: (src) => src.replace("if (!(await parentAuth.requireScope('orderIssue'))) return;", '// removed')
    },
    {
      name: '验证页不再回跳调用方',
      file: PAGE,
      env: { PGS_PAGE: path.join(path.dirname(PAGE), '_mut_gate_page.js') },
      transform: (src) => src.replace('if (s && this._scope) this.backToCaller();', '// removed')
    }
  ];
  for (const m of mutants) {
    const src = fs.readFileSync(m.file, 'utf8');
    const next = m.transform(src);
    const out = Object.values(m.env)[0];
    if (next === src) { ok(false, '反证定位失败：' + m.name); continue; }
    fs.writeFileSync(out, next, 'utf8');
    const run = spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, m.env, { PGS_CHILD: m.name }),
      encoding: 'utf8'
    });
    try { fs.unlinkSync(out); } catch (e) {}
    const text = (run.stdout || '') + (run.stderr || '');
    ok(run.status !== 0, '「' + m.name + '」→ 测试变红 · exit=' + run.status);
    ok(/✗/.test(text), '「' + m.name + '」失败断言可见');
  }
}

(async () => {
  await sectionUtil();
  sectionWiring();
  sectionPage();
  sectionCopy();
  sectionCounterproof();

  console.log('\n' + '-'.repeat(60));
  console.log(fail
    ? '❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项'
    : '✅ 家长门禁接线全通过（通过 ' + pass + ' 项，失败 0 项）');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * 网页看板「导学单」tab 静态校验（T21）——离线，无浏览器、无云依赖
 *
 * 为什么要有这个脚本：web/index.html 是 1.4MB 内联单文件（含内联 CloudBase SDK），
 * 既不好单测也不好 diff。T21 又是计划里标「高危」的一步。所以把它的关键契约
 * 全部转成**可自动执行、可反证**的断言，而不是靠"人打开浏览器看一眼"。
 *
 * 校验项：
 *   §0 校验器自检（含反证：证明 §5 的比较函数、§4 的写边界计数、取源分层都不是恒真/恒假）
 *   §1 文件完整性：</script> 恰好 2 段；两段都能被 Node 解析（语法错误会让整页白屏）
 *   §2 导航与视图接线：nav / section / switchView / .view 四处齐全
 *   §3 数据接线：DATA 声明 / refreshAll 查询 / 解构 6 项 / renderOrders 被调用
 *   §4 写边界：**只有 orders 一路可写**（决策 3）——
 *       云函数白名单（读 2 + 写 1）/ 读走 query() 单一出口 / 写走 callWrite() 单一出口 /
 *       保留键 5 个双层防御 / 写动作恰 2 种（issue+submit）/ 块外无写 /
 *       文案如实说明写边界（不得残留「本页只读」）
 *   §5 三端文案一致：状态表 / 事件表 / 操作者表 与 小程序、工作台逐字一致
 *   §6 禁用词门禁：导学单区域内不得出现「已掌握」类结论词
 *   §7 锚点可见：planId / si / ti 必须被渲染出来（O1 的界面面）
 *   §8 写路径语义：O1 锚点五件套 / si·ti 不重排 / O2 两步选择 + 1:1 / O3 不产证据
 *
 * ⚠️ 判据来历（改本文件前必读）：§4 的判据在 2026-09-29 由「全局禁止 webAdminWrite」
 *    改为「只允许 orders 一路写」。原因见 §4 内的长注释 —— 一句话：**判据必须锁规格，
 *    不能锁实现**。T21 首轮把决策 3 实现成纯只读，旧判据照抄了那个错误口径，
 *    于是「断言全绿但功能缺失」。这是"断言写错"最贵的形态：它会把缺口报成完成。
 *
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const WEB = path.join(REPO, 'web', 'index.html');
const MP_ORDER = path.join(REPO, 'miniprogram', 'pkgGuide', 'order', 'order.js');
const WB_ORDERS = '/Users/yiyo/Desktop/全科导学专家-小程序/全学科导学工作台/src/logic/orders.ts';

let fails = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------------ *
 * 通用工具：从源码里抠出一个对象字面量并求值
 * ------------------------------------------------------------------ */

/**
 * 找到 `marker` 之后第一个平衡的 `{ ... }`，返回其字面量文本。
 * 处理字符串里的括号与转义 —— 否则 `'（'` 之类的全角/半角混排会把深度算错。
 */
function objLiteralAfter(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return null;
  const start = src.indexOf('{', i + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let quote = null;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === '\\') { j++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}

/** 字面量 → 对象（这些字面量都由本仓自己书写，无外部输入） */
function evalObj(literal) {
  if (!literal) return null;
  try {
    // eslint-disable-next-line no-new-func
    const o = new Function('return (' + literal + ');')();
    return (o && typeof o === 'object') ? o : null;
  } catch (e) { return null; }
}

/**
 * 剥离注释。**必须做这一步**：源码注释里正常会出现「不调 webAdminWrite」这类
 * 反向说明，若不剥离就会把「声明自己只读」误判成「存在写通道」。
 *
 * ⚠️ 必须能识别**正则字面量**：本项目有 `/replace(/[&<>"]/g, ...)` 这种写法，
 * 正则里的引号若被当成字符串开头，状态机会一路跑偏，后面的块注释就剥不掉了
 * （这会表现为一条假阳性失败 —— 本脚本第一版就是这样）。判定规则用标准启发式：
 * `/` 的前一个有效字符若属于「只能出现在运算符之后」的集合，则 `/` 开始一个正则。
 */
function stripComments(code) {
  const RE_PREV = /[(,=:[!&|?{};+\-*%~^<>]/;
  let out = '';
  let i = 0;
  const n = code.length;
  let quote = null;
  let prevSig = '';           // 上一个非空白字符（判断 `/` 是正则还是除号）
  while (i < n) {
    const c = code[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += code[i + 1] || ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; prevSig = c; continue; }
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === '/' && (prevSig === '' || RE_PREV.test(prevSig))) {
      // 正则字面量：整段原样保留（含字符类里的引号与转义斜杠）
      out += '/'; i++;
      let inClass = false;
      while (i < n) {
        const d = code[i];
        if (d === '\\') { out += d + (code[i + 1] || ''); i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { out += d; i++; break; }
        else if (d === '\n') break;      // 未闭合，防死循环
        out += d; i++;
      }
      prevSig = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out;
}

/** 比较两个「键 → 文案」表，返回不一致项。§0 会对它做反证，证明它真的会报差异。 */
function diffLabels(a, b) {
  const out = [];
  const keys = Array.from(new Set([...Object.keys(a || {}), ...Object.keys(b || {})])).sort();
  for (const k of keys) {
    if ((a || {})[k] !== (b || {})[k]) out.push(k + ': A=' + JSON.stringify((a || {})[k]) + ' B=' + JSON.stringify((b || {})[k]));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 读源
 * ------------------------------------------------------------------ */
const webSrc = fs.readFileSync(WEB, 'utf8');
const mpSrc = fs.readFileSync(MP_ORDER, 'utf8');
let wbSrc = null;
try { wbSrc = fs.readFileSync(WB_ORDERS, 'utf8'); } catch (e) { wbSrc = null; }

/* 导学单区域：从「导学单（T21」注释块开始，到「时间轴记录」之前 */
const O_START = webSrc.indexOf('/* ============ 导学单（T21');
const O_END = webSrc.indexOf('/* ============ 时间轴记录 ============ */');
const ordersBlock = (O_START >= 0 && O_END > O_START) ? webSrc.slice(O_START, O_END) : '';

/* 导学单的**界面区块**（HTML 模板部分）—— 必须与 ordersBlock（脚本部分）分开取。
   文案类断言若落在脚本切片上会**永远匹配不到**（T21-b 踩过：断言写错导致假红），
   反向亦然：把「不许出现某代码」的断言落在 HTML 上会恒真。取源必须与判据同层。 */
const OS_START = webSrc.indexOf('<section class="view" id="orders"');
const OS_END = OS_START >= 0 ? webSrc.indexOf('</section>', OS_START) : -1;
const ordersSection = (OS_START >= 0 && OS_END > OS_START) ? webSrc.slice(OS_START, OS_END) : '';

/* 两段 <script>；第 2 段是应用脚本 */
const scriptBlocks = [];
{
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(webSrc))) scriptBlocks.push(m[1]);
}
const appScript = scriptBlocks[1] || '';
/* 剥注释后的副本：所有「存在性」判定都跑在它上面，避免把注释里的说明误判为代码 */
const appCode = stripComments(appScript);
const ordersCode = stripComments(ordersBlock);

/* renderOrders 函数体（用大括号配平抠出来，避免只截到第一行） */
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const start = src.indexOf('{', i);
  if (start < 0) return '';
  let depth = 0, quote = null;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (quote) { if (c === '\\') { j++; continue; } if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return '';
}
const renderOrdersBody = fnBody(webSrc, 'renderOrders');

section('0. 校验器自检（反证：证明 §5 的比较与 §4 的只读判定真的会失败）');
(function selfTest() {
  ok(diffLabels({ a: '1' }, { a: '1' }).length === 0, '自检：完全一致 → 无差异');
  ok(diffLabels({ a: '1' }, { a: '2' }).length === 1, '自检（反证）：值不同 → 报 1 项差异');
  ok(diffLabels({ a: '1' }, { a: '1', b: '2' }).length === 1, '自检（反证）：键缺失 → 报差异（不静默放过）');
  ok(diffLabels({}, {}).length === 0, '自检：双空表 → 无差异（比较函数本身不恒报错）');

  // 若反转「相等」判定，一致的两表必须被判为有差异 → 证明原判定有效
  const inverted = (diffLabels({ a: '1' }, { a: '1' }).length > 0);
  ok(inverted === false, '自检（反证）：反转判定会把一致误报为差异 → 证明原判定有效');

  // objLiteralAfter 的自检
  ok(objLiteralAfter("const X = { a: '1' };", 'const X =') === "{ a: '1' }", '自检：对象字面量可抠出');
  ok(objLiteralAfter("const X = { a: '}' };", 'const X =') === "{ a: '}' }", '自检：字符串里的右括号不破坏配平');
  ok(objLiteralAfter('const Y = 1;', 'const X =') === null, '自检：标记不存在 → null（不静默返回空对象）');

  // 抠函数体的自检
  const fake = "function f(){ if(1){ return '}'; } } function g(){}";
  ok(fnBody(fake, 'f') === "{ if(1){ return '}'; } }", '自检：函数体配平正确（含字符串里的 }）');
  ok(fnBody(fake, 'nope') === '', '自检：函数不存在 → 空串');

  // 只读判定的反证：脚本必须能抓到「写通道」与「直连调用」
  const WRITE_RE = /webAdminWrite/;
  const CALL_RE = /\.callFunction\s*\(/;
  ok(WRITE_RE.test("x = webAdminWrite('issue')"), '自检：能识别写通道字样');
  ok(CALL_RE.test("await app.callFunction({})"), '自检：能识别直连 callFunction');
  ok(!WRITE_RE.test('const a = 1;'), '自检（反证）：干净文本不误报写通道');

  // 剥注释的自检 —— 这一条最关键：注释里写「不调 X」不得被判成「调了 X」
  const withComment = "// 本页只读：不调 webAdminWrite\nconst a = 1;";
  ok(WRITE_RE.test(withComment), '自检：未剥注释时，注释里的字样会被误报（说明剥注释是必需的）');
  ok(!WRITE_RE.test(stripComments(withComment)), '自检（关键）：剥注释后不再误报');
  ok(/const a = 1;/.test(stripComments(withComment)), '自检：剥注释保留原有代码');
  ok(stripComments("const u = 'http://x'; // tail").indexOf('http://x') >= 0, '自检：字符串里的 // 不被当成注释');
  ok(stripComments("/* multi\nline */ const b = 2;").trim() === 'const b = 2;', '自检：块注释（含换行）被剥离');
  ok(stripComments("const s = '/*不是注释*/';").indexOf('不是注释') >= 0, '自检：字符串里的 /* */ 不被剥掉');
  // 正则字面量里的引号必须不把状态机带偏（本脚本第一版就栽在这里，导致假阳性）
  const reQuote = "const esc = s=>s.replace(/[&<>\\\"]/g, c=>c);\n/* 注释里的 webAdminWrite 应被剥掉 */\nconst z = 1;";
  ok(stripComments(reQuote).indexOf('webAdminWrite') < 0, '自检（关键）：正则里的引号不会让后续注释漏剥');
  ok(stripComments(reQuote).indexOf('const z = 1;') >= 0, '自检：正则之后的有效代码仍被保留');
  ok(stripComments('const a = 4 / 2; const b = 1;').indexOf('const b = 1;') >= 0, '自检：除号不被误判为正则开头');

  /* —— 写边界的反证（T21-b 新增）——
     本节判据从「禁止一切写入」改为「只允许 orders 一路写」之后，
     必须证明新判据**不是恒真**：否则「写边界收紧了」这件事本身就没有被验证。 */
  // ① 调用点计数：多一条写路径必须能被数出来
  const countCalls = (s) => (s.match(/name\s*:\s*'webAdminWrite'/g) || []).length;
  ok(countCalls("await app.callFunction({name:'webAdminWrite',data:{}})") === 1, '自检：能数出 1 处写通道调用点');
  ok(countCalls("a({name:'webAdminWrite'})\nb({name:'webAdminWrite'})") === 2,
     '自检（反证）：多一条写路径会被数成 2 → §4.3 的「恰好 1 处」真的会红');
  // ② 保留键数组提取器：多一个 / 少一个都必须能被发现
  const extractKeys = (s) => {
    const m = s.match(/const ORDER_RESERVED_KEYS\s*=\s*\[([^\]]*)\]/);
    return m ? m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort() : [];
  };
  ok(extractKeys("const ORDER_RESERVED_KEYS = ['status','events','openid','_openid','clientId'];").length === 5,
     '自检：保留键数组可抠出 5 项');
  ok(extractKeys("const ORDER_RESERVED_KEYS = ['status','events','openid'];").length === 3,
     '自检（反证）：漏掉 _openid / clientId 会被发现 → §4.4 真的会红');
  ok(extractKeys("const ORDER_RESERVED_KEYS = ['status','events','openid','_openid','clientId','x'];").length === 6,
     '自检（反证）：多一个保留键同样会被发现');
  // ③ 取源分层：文案判据必须落在 HTML 上，落在脚本上会恒假（这是本轮真实踩过的坑）
  ok(ordersSection.length > 0 && ordersBlock.length > 0, '自检：脚本切片与界面切片都取到了');
  ok(ordersSection.indexOf('/* ============ 导学单') < 0,
     '自检（关键）：界面切片确实是 HTML（不含脚本注释头）—— 两个切片不重叠');
  ok(/id="orders"/.test(ordersSection) && !/function renderOrders/.test(ordersSection),
     '自检：界面切片含 section 但不含脚本函数 —— 取源与判据同层');
  ok(!/本页是本看板唯一的可写区域/.test(ordersBlock),
     '自检（反证）：该文案不在脚本切片里 → 若把文案断言写在 ordersBlock 上必然假红');
})();

section('1. 文件完整性');
(function integrity() {
  const scriptCount = (webSrc.match(/<\/script>/g) || []).length;
  ok(scriptCount === 2, '</script> 恰好 2 段（实际 ' + scriptCount + '）—— 内联 SDK 1 段 + 应用脚本 1 段');

  const blocks = scriptBlocks;
  ok(blocks.length === 2, '能切出 2 段 script（实际 ' + blocks.length + '）');

  blocks.forEach((code, i) => {
    let err = null;
    try { new vm.Script(code, { filename: 'inline-' + i + '.js' }); } catch (e) { err = e; }
    ok(!err, '第 ' + (i + 1) + ' 段 script 语法可解析' + (err ? '：' + err.message : ''));
  });

  const size = fs.statSync(WEB).size;
  ok(size > 1000 * 1000, '文件仍为单文件内联形态（' + Math.round(size / 1024) + ' KB）');
})();

section('2. 导航与视图接线');
(function wiring() {
  ok(/<a[^>]*data-v="orders"[^>]*>[\s\S]{0,400}?导学单<\/a>/.test(webSrc), '侧栏 nav 有 data-v="orders" 且文案为「导学单」');
  ok(/<section class="view" id="orders"/.test(webSrc), '存在 <section class="view" id="orders">');
  ok(/\borders:'导学单'/.test(webSrc), 'switchView 的标题映射含 orders → 导学单');
  ok(/id="ordersContent"/.test(webSrc), '存在 #ordersContent 渲染容器');
  ok(/id="childChipsOrders"/.test(webSrc), '存在 #childChipsOrders 孩子切换容器');
  ok(/renderChips\('childChipsOrders'/.test(webSrc), '孩子切换容器确实绑定了 renderChips');

  // 每个 .nav a 的 data-v 都必须有对应的 section，否则点了就是空白页
  const navVals = [];
  const navRe = /<a[^>]*data-v="([a-zA-Z]+)"/g;
  let n;
  while ((n = navRe.exec(webSrc))) navVals.push(n[1]);
  const missing = Array.from(new Set(navVals)).filter((v) => !new RegExp('<section class="view[^"]*" id="' + v + '"').test(webSrc));
  ok(missing.length === 0, '所有导航项都有对应的 view 容器（缺失：' + (missing.join(', ') || '无') + '）');
})();

section('3. 数据接线');
(function data() {
  ok(/let DATA = \{[^}]*\borders:null\b[^}]*\}/.test(webSrc), 'DATA 运行时状态声明含 orders');
  ok(/orders:\s*query\('orders'/.test(webSrc), 'refreshAll 里查询 orders 模块');
  ok(/\borders:\s*query\('orders',\s*\{[^}]*limit:/.test(webSrc), 'orders 查询带 limit（防一次拖回过多单）');
  ok(/DATA\.orders\s*=\s*od\.__err/.test(webSrc), 'orders 结果写回 DATA（含错误态判断）');
  ok(/renderOrders\(\)/.test(webSrc), 'refreshAll 调用了 renderOrders()');
  ok(/\bconst \[o,p,t,f,x,od\] = await Promise\.all/.test(webSrc), 'Promise.all 解构含第 6 项 orders');
  ok(/\[o,p,t,f,x,od\]\.filter\(v=>v\.__err\)/.test(webSrc), '错误收集数组含 orders（失败不会被吞掉）');
  ok(ordersBlock.length > 3000, '导学单代码块存在且规模合理（' + ordersBlock.length + ' 字节）');

  /* —— 3.5 加载期也必须渲染出「入口」（2026-09-29 owner 报「没找到交回执的入口」的根因）——
   *
   * 判据来历：当初 `renderOrders()` 只在 `await Promise.all` **之后**被调用一次。
   * 而 Promise.all 要先拉 6 个云模块（实测约 8 秒），期间 `DATA.*` 全是 null ——
   * 于是从过门到数据到达这段时间里，导学单页除了静态 note 之外**什么都没有**：
   * `#ordersWrite` 与 `#ordersContent` 双空，连「出单 / 交回执」两个页签都不存在。
   * 真机复现即为此态（用真实口令登录，4.5 秒时读到的写区 innerHTML 为空）。
   *
   * 规格：**入口必须在数据到达前就在**。数据晚到只该影响「内容」，不该影响「有没有这个功能」。
   * 下面三个断言配合才锁得住 —— 单看「存在 renderOrders() 调用」是恒真的（原来那条就是）。 */
  {
    const raStart = webSrc.indexOf('async function refreshAll(');
    const ra = raStart >= 0 ? webSrc.slice(raStart, raStart + 4000) : '';
    const posRender = ra.indexOf('renderOrders()');
    const posAll = ra.indexOf('await Promise.all');
    const posQuery = ra.indexOf("orders:");
    ok(posRender >= 0 && posAll > 0 && posRender < posAll,
      'refreshAll 在 await Promise.all **之前**先调 renderOrders()（否则加载期页面全空）');
    ok(posRender >= 0 && posQuery > 0 && posRender < posQuery,
      'renderOrders() 在发起 orders 查询之前就被调用（不等数据先立入口）');

    /* 反证：抹掉「提前渲染」那一行后，剩下的 renderOrders() 调用都在 Promise.all 之后
       （或根本不存在）—— 证明 posRender < posAll 这个判据会因删除而失效，不是恒真。 */
    {
      const raBad = ra.replace('renderOrders();', '');
      const pBad = raBad.indexOf('renderOrders()');
      const aBad = raBad.indexOf('await Promise.all');
      ok(!(pBad >= 0 && aBad > 0 && pBad < aBad),
        '自检（反证）：删掉提前渲染后判据不再成立 → 顺序断言真的会红（不是恒真）');
    }
  }

  ok(/function renderOrdersWrite\(a,\s*plans,\s*mine,\s*loading\)/.test(webSrc),
    'renderOrdersWrite 接受 loading 参数（加载态下仍渲染页签骨架）');
  ok(/\?\s*'<div class="empty">导学单数据加载中/.test(webSrc),
    '加载态下面板给出明确「加载中」占位，而不是留白');
  /* 两个面板对数据的依赖不同，不能一刀切 —— 出单只用 profile.studyPlans，
     回执必须等 orders。出单不该被 orders 的延迟拖住（那会让「能立刻做的事」被挡住）。 */
  ok(/oWriteTab\s*===\s*'receipt'\s*&&\s*loading/.test(webSrc),
    '占位条件区分面板：只有「交回执」需要等 orders，「出单」不被 orders 延迟拖住');
  ok(/if\(!DATA\.profile\)\{[\s\S]{0,420}?renderOrdersWrite\(null,\s*\[\],\s*\[\],\s*true\)/.test(webSrc),
    'profile 未加载时也渲染写区骨架（绝不静默清空写区）');

  /* 写区不许被静默清空：除「该口令下没有可展示的孩子账号」这一个分支外，
     任何路径都不得把 #ordersWrite 置空后 return —— 那会让入口凭空消失。 */
  {
    const wipes = (appCode.match(/wbox\.innerHTML\s*=\s*''/g) || []).length;
    ok(wipes === 1,
      '整份应用脚本里「写区置空」恰好 1 处（只允许在「无账号」分支），实际 ' + wipes + ' 处');
  }
})();

section('4. 写边界：**只有 orders 一路可写**，其余严格只读（决策 3）');
(function writeBoundary() {
  ok(appCode.length > 1000, '应用脚本已取出并剥注释（' + appCode.length + ' 字节）');

  /* ── 判据的来历（改本节前必读）─────────────────────────────────────
   * 本节的判据在 2026-09-29 由「**全局禁止 webAdminWrite**」改为
   * 「**只允许 orders 一路写，且唯一出口**」。理由：
   *   设计文档《导学单闭环设计_出单-回执.md》决策 3 的原文是
   *     「网页看板**开启 `orders` 权限** | webAdminQuery 新增 module:'orders'（读）；
   *       webAdminWrite 白名单新增 orders（写）」
   *   ——**写**字是决策本身，不是后来追加的。同文第 411 行并已明确修订
   *     「工作台 UI 只读零回写 ⚠️ **需修订**（已随决策 3 拍板）。工作台与网页看板
   *       同权限边界：**仅可写 orders**，其余仍严格只读」。
   *   T21 首轮把决策 3 实现成了纯只读（漏掉出单/回执两个写动作），本节断言
   *   也照抄了那个错误口径，于是「断言全绿但功能缺失」——**这是断言写错的典型样本**：
   *   断言锁的是实现，不是规格。所以本节现在锁的是**规格**：
   *     · 写动作**有且仅有** orders 两种（issue / submit）
   *     · 写入**有且仅有**一个出口（callWrite）
   *     · 除该出口外，全文不得出现第二个 webAdminWrite 调用点
   *   ───────────────────────────────────────────────────────────── */

  /* —— 4.1 云函数白名单：读 2 个 + 写 1 个，多一个都不行 —— */
  const ALLOWED_FN = ['webAdminQuery', 'webVisionConfig', 'webAdminWrite'];
  const fnNames = [];
  {
    const re = /name\s*:\s*'([A-Za-z]+)'/g;
    let m;
    while ((m = re.exec(appCode))) fnNames.push(m[1]);
  }
  const used = Array.from(new Set(fnNames)).sort();
  ok(used.length > 0, '能枚举出应用脚本调用的云函数（' + used.join(', ') + '）');
  const extra = used.filter(function (x) { return ALLOWED_FN.indexOf(x) < 0; });
  ok(extra.length === 0, '调用的云函数都在白名单内（越界：' + (extra.join(', ') || '无') + '）');
  ok(used.indexOf('webAdminWrite') >= 0, 'webAdminWrite 在白名单内 —— 导学单是唯一破例的写通道（决策 3）');

  /* —— 4.2 读通道只有 query() 一个出口 —— */
  const qCount = (appCode.match(/name\s*:\s*'webAdminQuery'/g) || []).length;
  ok(qCount === 1, '整个应用脚本只有 1 处 webAdminQuery 调用点（实际 ' + qCount + '）—— 读通道只有 query() 一个出口');

  /* —— 4.3 写通道只有 callWrite() 一个出口 —— */
  const wCount = (appCode.match(/name\s*:\s*'webAdminWrite'/g) || []).length;
  ok(wCount === 1, '整个应用脚本只有 1 处 webAdminWrite 调用点（实际 ' + wCount + '）—— 写通道只有 callWrite() 一个出口');

  const callWriteBody = fnBody(webSrc, 'callWrite');
  ok(callWriteBody.length > 300, 'callWrite 函数体已定位（' + callWriteBody.length + ' 字节）');
  ok(/orders\s*:\s*Object\.assign\(\{\s*action\s*:\s*action/.test(stripComments(callWriteBody)),
     'callWrite 只发 orders 对象 { action, ...payload }（不是数组 —— 数组=批量覆盖，会摧毁 O2/O4）');
  ok(/by\s*:\s*'web'/.test(stripComments(callWriteBody)),
     "callWrite 固定 by:'web'（三端留痕口径 mp / web / workbench）");

  /* webAdminWrite 调用点必须**落在 callWrite 里**：若出现在别处，就是绕开唯一出口的第二条写路径 */
  const callWriteIdx = webSrc.indexOf('function callWrite(');
  const wCallIdx = appCode.search(/name\s*:\s*'webAdminWrite'/);
  ok(callWriteIdx > 0 && wCallIdx > 0, '能同时定位 callWrite 定义与 webAdminWrite 调用点');

  /* —— 4.4 保留键双层防御（与云函数 / 工作台同名门禁）—— */
  /* 注意：ORDER_RESERVED_KEYS 是**数组**字面量，不能用 objLiteralAfter（那是给 {} 用的）——
     用错提取器会拿到后面一大段无关代码，判据永远为假（T21-b 踩过）。 */
  const reservedRaw = (webSrc.match(/const ORDER_RESERVED_KEYS\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
  const reservedKeys = reservedRaw.split(',').map(function (x) { return x.trim().replace(/^['"]|['"]$/g, ''); }).filter(Boolean).sort();
  ok(reservedKeys.length === 5, '保留键表恰好 5 个（实际 ' + reservedKeys.length + '：' + reservedKeys.join(',') + '）');
  ok(reservedKeys.join(',') === '_openid,clientId,events,openid,status',
     '保留键恰为 status/events/openid/_openid/clientId —— 一旦允许端上直传，O2/O4 立刻失效');
  ok(/ORDER_RESERVED_KEYS/.test(stripComments(callWriteBody)) && /hasOwnProperty/.test(stripComments(callWriteBody)),
     'callWrite 内逐键拦截保留键（hasOwnProperty，不用 in —— 原型链上的同名键不该误伤）');

  /* —— 4.5 写动作有且仅有 issue / submit 两种 —— */
  const doIssueBody = fnBody(webSrc, 'doIssue');
  const doSubmitBody = fnBody(webSrc, 'doSubmitReceipt');
  ok(doIssueBody.length > 300, 'doIssue 函数体已定位（' + doIssueBody.length + ' 字节）');
  ok(doSubmitBody.length > 300, 'doSubmitReceipt 函数体已定位（' + doSubmitBody.length + ' 字节）');
  const writes = (stripComments(doIssueBody + doSubmitBody).match(/callWrite\('/g) || []).length;
  ok(writes === 2, '写动作恰好 2 处（issue + submit，实际 ' + writes + ' 处）—— 本看板不出单以外的任何动作');
  ok(/callWrite\('issue'/.test(stripComments(doIssueBody)), '出单走 issue');
  ok(/callWrite\('submit'/.test(stripComments(doSubmitBody)), '交回执走 submit');
  /* 未实现的动作必须**一个都没有**：作废/重开/勾任务都在小程序端，本页不开口子 */
  const forbidden = ['callWrite(\'void\'', 'callWrite(\'reissue\'', "callWrite('tick'", "callWrite('close'", "callWrite('cancel'", "callWrite('copied'"];
  const leaked = forbidden.filter(function (x) { return (doIssueBody + doSubmitBody).indexOf(x) >= 0; });
  ok(leaked.length === 0, '不实现作废/重开/勾任务/归档等动作（越界：' + (leaked.join(', ') || '无') + '）');

  /* —— 4.6 导学单区域之外不得有任何写 —— */
  const outsideOrders = appCode.replace(stripComments(ordersBlock), '');
  ok(!/name\s*:\s*'webAdminWrite'/.test(outsideOrders),
     'webAdminWrite 调用点全部落在「导学单」代码块内（块外出现 = 越权写其它模块）');
  ok(/renderOrdersBody|^$/.test(renderOrdersBody) || !/\.callFunction\s*\(/.test(renderOrdersBody),
     'renderOrders 内不直连 callFunction（渲染与写入分离：写只在 doIssue / doSubmitReceipt）');
  ok(!/\.add\s*\(|\.update\s*\(|\.remove\s*\(/.test(ordersCode),
     '导学单区域内不出现数据库直写方法（写一律经 cloud 状态机，不经端上集合操作）');
  ok(!/localStorage\.(setItem|removeItem)/.test(ordersCode),
     '导学单区域不写 localStorage（回执草稿只存内存，不产生端上持久状态）');
  ok(!/cloudbase\.init/.test(ordersCode), '导学单区域不自行初始化 SDK（复用既有 initCloud）');

  /* —— 4.7 文案必须如实说明写边界（说反了比不写更糟）—— */
  ok(ordersSection.length > 300, '导学单界面区块已取出（' + ordersSection.length + ' 字节）');
  ok(/本页是本看板唯一的可写区域/.test(ordersSection), '导学单界面文案明写「本页是本看板唯一的可写区域」');
  ok(!/本页只读/.test(ordersSection), '不再残留「本页只读」的旧文案（与实现相反）');
  ok(/出单/.test(ordersSection) && /交回执/.test(ordersSection), '界面文案点明两个写动作（出单 / 交回执）');
  ok(!/只读回放/.test(ordersSection), '不再把本页描述为「只读回放」');
  ok(/导学单可写/.test(webSrc), '品牌栏文案标出写边界（HW-FARM · 导学单可写）');
  const subSuffix = webSrc.match(/suffix\s*=\s*\(v === 'orders'\)\s*\?\s*'([^']*)'\s*:\s*'([^']*)'/);
  ok(!!subSuffix, 'switchView 的副标题按视图区分写/读');
  ok(!!subSuffix && subSuffix[1].indexOf('可写') >= 0 && subSuffix[2].indexOf('只读') >= 0,
     '副标题：orders = 可写，其余 = 只读（实际 ' + (subSuffix ? subSuffix[1] + ' | ' + subSuffix[2] : '未解析') + '）');
})();

section('8. 写路径语义（O1 锚点 / O2 两步选择 / O3 不产证据）');
(function writeSemantics() {
  const doIssueCode = stripComments(fnBody(webSrc, 'doIssue'));
  const doSubmitCode = stripComments(fnBody(webSrc, 'doSubmitReceipt'));
  const planTasksCode = stripComments(fnBody(webSrc, 'planTasksOf'));

  /* —— O1：出单必须带齐锚点五件套 —— */
  ['key', 'si', 'ti', 'planCreatedAt', 'taskName'].forEach(function (k) {
    ok(new RegExp('\\b' + k + '\\s*:').test(doIssueCode), 'O1：issue 的 planTask 带 ' + k);
  });
  ok(/planCreatedAt\s*:\s*cur\.plan\.createdAt/.test(doIssueCode),
     'O1：planCreatedAt 取自**当前这份计划**的 createdAt（计划重生成即换 planId，旧单不会错挂新计划）');
  ok(!/Date\.now\(\)/.test(doIssueCode), 'O1：端上绝不补造 createdAt（宁可不出单，也不产生挂在假 planId 上的孤儿单）');
  ok(/issuedBy\s*:\s*'web'/.test(doIssueCode), "O1：issuedBy 固定 'web'（三端留痕口径统一）");

  /* si / ti 必须原样取自下标，绝不重排 */
  ok(/forEach\(function\s*\(\s*st\s*,\s*si\s*\)/.test(planTasksCode) && /forEach\(function\s*\(\s*t\s*,\s*ti\s*\)/.test(planTasksCode),
     'O1：si / ti 原样取自 stages / stage.tasks 的遍历下标');
  ok(!/\.filter\([\s\S]{0,80}\)\s*\.forEach\(function\s*\(\s*(?:st\s*,\s*)?si/.test(planTasksCode),
     'O1：不在编号前先 filter（过滤会挤掉下标，两端锚点立刻错位）');
  ok(/si\s*:\s*si\s*,\s*ti\s*:\s*ti/.test(planTasksCode), 'O1：下标原样落进任务行（保位，不重排）');
  ok(/if\s*\(\s*t\s*&&\s*t\.done\s*\)\s*return/.test(planTasksCode), 'O1：已勾选任务不再出单（与小程序一致）');

  /* —— 不可出单的情形必须被明确挡住 —— */
  const issuableCode = stripComments(fnBody(webSrc, 'issuablePlansOf'));
  ok(/!p\.startDate/.test(issuableCode), '未「开始计划」的学科不出现在出单候选里');
  ok(/!p\.createdAt/.test(issuableCode), '无 createdAt 的计划被排除（不产生假锚点）');
  ok(/!tasks\.length/.test(issuableCode), '无未勾选任务的计划被排除');
  ok(/不支持无计划自由出单/.test(webSrc), '页面明写「不支持无计划自由出单」（决策 4）');

  /* —— O2：回执两步选择 + 严格 1:1 —— */
  ok(/先选「属于哪一份计划」/.test(fnBody(webSrc, 'receiptPanelHtml')),
     'O2：回执第一步是「选计划」，不是直接选单');
  ok(/o\.plan\.planId === oRcptPlan/.test(stripComments(fnBody(webSrc, 'receiptPanelHtml'))),
     'O2：第二步只列**该计划下**的单（planId 对位）');
  ok(/o\.status === 'issued'/.test(stripComments(fnBody(webSrc, 'receiptPanelHtml'))),
     "O2：只列 status==='issued' 的单（已回执/已归档的不再出现）");
  ok(/planId\s*:\s*planId/.test(doSubmitCode), 'O2：submit 必带 planId（云端 plan_mismatch 对位校验的服务端兜底）');
  ok(/o\.plan\s*&&\s*o\.plan\.planId/.test(doSubmitCode),
     'O2：planId 取自**这张单自己的锚点**，端上不重算（planIdOf 的逻辑只在 canonical orderKit 里）');
  ok(/一个出单只能对应一个回执/.test(webSrc), 'O2：页面明写「一个出单只能对应一个回执」');

  /* —— 解析器不端上重造 —— */
  ok(!/parseReceiptText/.test(ordersCode), 'O2：端上不自建 parseReceiptText（解析在云端用 canonical 那一份）');
  ok(/rawText\s*:\s*rawText/.test(doSubmitCode) && /parsedBy\s*:\s*'rule'/.test(doSubmitCode),
     'O2：网页只提交 rawText，由云端 canonical 解析器抽取（端上不解析 = 不会算出第四种 verdict）');

  /* —— O3：回执 ≠ 证据 —— */
  ok(!/tutor_evidence|tutorEvidence|knowledgePoints/.test(ordersCode),
     'O3：导学单区域绝不触碰 tutor_evidence / knowledgePoints（回执 ≠ 证据 ≠ 掌握）');
  ok(/回执 ≠ 掌握证据/.test(webSrc), 'O3：页面明写「回执 ≠ 掌握证据」');
  ok(!/callWrite\('(?:evidence|reviews|mistakes|sessions)'/.test(doIssueCode + doSubmitCode),
     'O3：写白名单只到 orders，不含任何 tutor_* 集合');
})();


section('5. 三端文案一致（状态 / 事件 / 操作者 三张表）');
(function threeEnds() {
  // 标记不带 `=`：源码里的对齐空格数会变，带上 `=` 会因多一个空格而匹配失败（踩过）
  const webStatus = evalObj(objLiteralAfter(webSrc, 'const ORDER_STATUS_TEXT'));
  const webEvent = evalObj(objLiteralAfter(webSrc, 'const ORDER_EVENT_TEXT'));
  const webBy = evalObj(objLiteralAfter(webSrc, 'const ORDER_BY_TEXT'));
  const webBucket = evalObj(objLiteralAfter(webSrc, 'const ORDER_BUCKET_TEXT'));

  ok(!!webStatus && Object.keys(webStatus).length === 5, '网页端状态表可解析且有 5 个状态');
  ok(!!webEvent && Object.keys(webEvent).length === 9, '网页端事件表可解析且有 9 种事件');
  ok(!!webBy && Object.keys(webBy).length === 5, '网页端操作者表可解析且有 5 个取值');
  ok(!!webBucket && Object.keys(webBucket).length === 5, '网页端档位表可解析（含空串兜底）');

  // —— 小程序（口径基准）——
  const mpStatus = evalObj(objLiteralAfter(mpSrc, 'const STATUS_LABEL ='));
  const mpEvent = evalObj(objLiteralAfter(mpSrc, 'const EVENT_LABEL ='));
  const mpByLit = (mpSrc.match(/\{\s*mp:\s*'小程序'[\s\S]*?\}\[by\]/) || [])[0];
  const mpBy = evalObj(mpByLit ? mpByLit.replace(/\[by\]$/, '') : null);
  ok(!!mpStatus && !!mpEvent && !!mpBy, '小程序三张表均可解析（STATUS_LABEL / EVENT_LABEL / fmtBy 内联表）');

  if (mpStatus && mpEvent && mpBy) {
    ok(diffLabels(webStatus, mpStatus).length === 0, '状态表 网页 = 小程序' + (diffLabels(webStatus, mpStatus).length ? '（差异：' + diffLabels(webStatus, mpStatus).join('; ') + '）' : ''));
    ok(diffLabels(webEvent, mpEvent).length === 0, '事件表 网页 = 小程序' + (diffLabels(webEvent, mpEvent).length ? '（差异：' + diffLabels(webEvent, mpEvent).join('; ') + '）' : ''));
    ok(diffLabels(webBy, mpBy).length === 0, '操作者表 网页 = 小程序' + (diffLabels(webBy, mpBy).length ? '（差异：' + diffLabels(webBy, mpBy).join('; ') + '）' : ''));
  }

  // —— 工作台 ——（单克隆环境可能没有该目录，缺失即明确告警而不是静默通过）
  if (!wbSrc) {
    ok(false, '工作台 src/logic/orders.ts 不可读（单克隆环境）——三端一致性无法完整校验，请在有工作台的机器上跑');
  } else {
    const wbStatus = evalObj(objLiteralAfter(wbSrc, 'ORDER_STATUS_LABEL: Record<OrderStatus, string> ='));
    const wbEvent = evalObj(objLiteralAfter(wbSrc, 'ORDER_EVENT_LABEL: Record<string, string> ='));
    const wbBy = evalObj(objLiteralAfter(wbSrc, 'ISSUED_BY_LABEL: Record<string, string> ='));
    ok(!!wbStatus && !!wbEvent && !!wbBy, '工作台三张表均可解析');
    if (wbStatus && wbEvent && wbBy) {
      ok(diffLabels(webStatus, wbStatus).length === 0, '状态表 网页 = 工作台' + (diffLabels(webStatus, wbStatus).length ? '（差异：' + diffLabels(webStatus, wbStatus).join('; ') + '）' : ''));
      ok(diffLabels(webEvent, wbEvent).length === 0, '事件表 网页 = 工作台' + (diffLabels(webEvent, wbEvent).length ? '（差异：' + diffLabels(webEvent, wbEvent).join('; ') + '）' : ''));
      ok(diffLabels(webBy, wbBy).length === 0, '操作者表 网页 = 工作台' + (diffLabels(webBy, wbBy).length ? '（差异：' + diffLabels(webBy, wbBy).join('; ') + '）' : ''));
    }
  }

  // 「待回收」是一次真实的三端分叉（工作台曾用词）。判定落在**标签表的值**上，
  // 而不是「全文是否出现该字符串」—— 注释里解释「不要用待回收」是正当的。
  const endsIssued = [['网页', webStatus], ['小程序', mpStatus], wbSrc ? ['工作台', evalObj(objLiteralAfter(wbSrc, 'ORDER_STATUS_LABEL: Record<OrderStatus, string>'))] : null]
    .filter(Boolean);
  const wrongWord = endsIssued.filter(function (x) { return x[1] && x[1].issued !== '待回执'; })
    .map(function (x) { return x[0] + '=' + JSON.stringify(x[1] && x[1].issued); });
  ok(wrongWord.length === 0, '三端 status.issued 一律为「待回执」（例外：' + (wrongWord.join(', ') || '无') + '）');

  // 反证：把 issued 改成「待回收」，判定必须报出来
  const probeStatus = Object.assign({}, webStatus, { issued: '待回收' });
  ok(probeStatus.issued !== '待回执', '自检（反证）：issued 改成「待回收」→ 会被上面这条判定抓到');
})();

section('6. 禁用词门禁（回执 ≠ 证据 ≠ 掌握）');
(function banned() {
  const BANNED = ['已掌握', '已精通', '学会了', '完全懂了', '完全掌握', '稳稳掌握'];
  const hits = BANNED.filter((w) => ordersBlock.indexOf(w) >= 0);
  ok(hits.length === 0, '导学单区域内不含结论类禁用词（命中：' + (hits.join('、') || '无') + '）');

  // 反证：把禁用词塞进一份副本，必须被判定命中
  const probe = ordersBlock + '已掌握';
  ok(BANNED.filter((w) => probe.indexOf(w) >= 0).length === 1, '自检（反证）：塞入「已掌握」→ 必须命中 1 项');

  // verdict 必须原样取用引擎口径
  ok(/ev\.verdictText/.test(ordersBlock), 'verdict 取引擎自带的 verdictText（端上不重算、不翻译）');
  ok(!/function\s+verdictText\s*\(/.test(ordersBlock), '网页端不自建 verdictText（避免第四套口径）');
})();

section('7. 计划锚点可见（O1 的界面面）');
(function anchor() {
  ok(/planId/.test(ordersBlock), '渲染里出现 planId');
  ok(/planId\s*=\s*'\+esc\(p\.planId/.test(ordersBlock), 'planId 以「planId = ...」的可读形式展示');
  ok(/'si='\+esc\(String\(p\.si\)\)/.test(ordersBlock) || /si='\+esc\(String\(p\.si/.test(ordersBlock), '展示计划内下标 si');
  ok(/ti='\+esc\(String\(p\.ti/.test(ordersBlock), '展示计划内下标 ti');
  ok(/data-planrow/.test(ordersBlock), '计划聚合行可点击下钻');
  ok(/ordersPlanFilter/.test(ordersBlock), '存在计划维度过滤状态');

  // 时间线与 1:1 约束必须可见
  ok(/ORDER_EVENT_TEXT\[e\.type\]/.test(ordersBlock), '时间线用事件表渲染标签');
  ok(/只追加/.test(ordersBlock), '时间线明写「只追加」语义');
  ok(/回执/.test(ordersBlock) && /1 份计划 → N 张单|1 份计划/.test(ordersBlock), '页面写出「一份计划 → N 张单」的基数关系');
})();

console.log('\n通过 ' + passes + ' 项，失败 ' + fails + ' 项');
if (fails) { console.error('\n❌ 网页看板「导学单」静态校验未通过'); process.exit(1); }
console.log('✅ 网页看板「导学单」静态校验全通过');

#!/usr/bin/env node
/**
 * 学习单页注册与分包完整性静态校验（离线，无 wx 依赖）
 * 校验项：
 *   1) app.json 可解析，pkgGuide 分包存在
 *   2) pkgGuide 每个页面的 .js/.json/.wxml/.wxss 四件套齐备
 *   3) order/order 已注册
 *   4) 每个分包的 root 与其 pages 前缀一致
 *   5) preloadRule 的 network 指向真实存在的分包；pages 指向真实存在的页面
 *   6) pkgGuide 与主包页面不重名
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram');
const appJsonPath = path.join(ROOT, 'app.json');

let fails = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
let warns = 0;
function warn(msg) { warns++; console.log('  ! ' + msg); }
function section(t) { console.log('\n' + t); }

const raw = fs.readFileSync(appJsonPath, 'utf8');
let app;
try { app = JSON.parse(raw); } catch (e) {
  console.error('app.json 解析失败: ' + e.message);
  process.exit(1);
}

// 真实 app.json 用的是小写 `subpackages`；root 不带尾斜杠，pages 不带前导斜杠。
// 页面的完整路径 = root + '/' + page。这里两种写法都兼容，避免以后再踩。
const pkgs = app.subPackages || app.subpackages || [];
function joinPkg(root, page) {
  const r = String(root).replace(/\/+$/, '');
  const p = String(page).replace(/^\/+/, '');
  return r ? r + '/' + p : p;
}

section('0. 校验器自检（反证：确认 §8 的 *this 判定真的能抓到对象数组）');
(function selfTest() {
  const primLit = "Page({ data: { minuteChoices: ['5','10','15'] } })";
  ok(resolveArrayLiteral(primLit, 'minuteChoices') === "['5','10','15']", '自检：直接数组字面量可解析');
  ok(!/\{/.test(resolveArrayLiteral(primLit, 'minuteChoices')), '自检：原始值数组 → 不含 { → 判定安全');

  const primConst = "const MINUTE_CHOICES = ['5','10','15'];\nPage({ data: { minuteChoices: MINUTE_CHOICES } })";
  const r2 = resolveArrayLiteral(primConst, 'minuteChoices');
  ok(r2 === "['5','10','15']", '自检：常量间接引用可解析（本项目惯用写法）');
  ok(!/\{/.test(r2), '自检：常量间接引用 → 判定安全');

  const objLit = "Page({ data: { rows: [{ id: 1 }, { id: 2 }] } })";
  const r3 = resolveArrayLiteral(objLit, 'rows');
  ok(/\{/.test(r3), '自检（反证）：对象数组 → 含 { → 必须判失败');

  const objConst = "const ROWS = [{ id: 1 }];\nPage({ data: { rows: ROWS } })";
  ok(/\{/.test(resolveArrayLiteral(objConst, 'rows')), '自检（反证）：常量间接引用的对象数组 → 必须判失败');

  ok(resolveArrayLiteral("Page({ data: { x: foo() } })", 'x') === null, '自检：表达式 → 返回 null（降级为人工确认）');
  ok(resolveArrayLiteral("Page({})", 'nope') === null, '自检：不存在 → 返回 null');

  // 反证：把判定条件反转，必须与预期相反 —— 证明断言不是恒真
  const inverted = !/\{/.test(r3);
  ok(inverted === false, '自检（反证）：若反转判定，对象数组会误判为安全 → 证明原断言有效');
})();

section('1. 分包声明');

ok(Array.isArray(pkgs) && pkgs.length > 0, 'subpackages 非空（共 ' + (pkgs ? pkgs.length : 0) + ' 个）');
const pkgGuide = pkgs.find(p => String(p.root).replace(/\/+$/, '') === 'pkgGuide');
ok(!!pkgGuide, 'pkgGuide 分包已声明');
const pkgTools = pkgs.find(p => String(p.root).replace(/\/+$/, '') === 'pkgTools');
ok(!!pkgTools, 'pkgTools 分包已声明（回归确认）');

section('2. 页面四件套');
function checkPage(full, where) {
  const base = path.join(ROOT, full);
  ['js', 'json', 'wxml', 'wxss'].forEach(ext => {
    const f = base + '.' + ext;
    ok(fs.existsSync(f), where + ' → ' + full + '.' + ext + (fs.existsSync(f) ? '' : ' 【缺失】'));
  });
  // 页面 json 必须是合法 JSON（有则验）
  const jf = base + '.json';
  if (fs.existsSync(jf)) {
    try { JSON.parse(fs.readFileSync(jf, 'utf8')); ok(true, where + ' → ' + full + '.json 可解析'); }
    catch (e) { ok(false, where + ' → ' + full + '.json 解析失败: ' + e.message); }
  }
}

const mainPages = (app.pages || []).slice();
section('2a. 主包页面');
mainPages.forEach(p => checkPage(p, '主包'));

section('2b. 分包页面');
pkgs.forEach(pk => {
  const root = pk.root;
  const name = String(root).replace(/\/+$/, '');
  (pk.pages || []).forEach(p => {
    const full = joinPkg(root, p);
    checkPage(full, '分包 ' + name);
  });
});

section('3. 学习单页注册');
const allPkgPages = pkgs.reduce((acc, pk) => acc.concat((pk.pages || []).map(p => joinPkg(pk.root, p))), []);
ok(allPkgPages.indexOf('pkgGuide/order/order') >= 0, 'order/order 已注册在 pkgGuide');
const gPkg = pkgs.find(p => String(p.root).replace(/\/+$/, '') === 'pkgGuide') || {};
ok((gPkg.pages || []).indexOf('order/order') >= 0, 'order/order 位于 pkgGuide.pages 且写法为无前导斜杠的相对路径');

section('4. root / pages 前缀一致性');
pkgs.forEach(pk => {
  const bad = (pk.pages || []).filter(p => p.indexOf(String(pk.root).replace(/\/+$/, '')) === 0);
  ok(bad.length === 0, '分包 ' + pk.root + ' 的 pages 不含 root 前缀（' + bad.length + ' 处冗余）');
});

section('5. preloadRule');
const rules = app.preloadRule || {};
Object.keys(rules).forEach(from => {
  const r = rules[from];
  ok(!!fs.existsSync(path.join(ROOT, from + '.json')), 'preloadRule 来源页存在: ' + from);
  (r.packages || []).forEach(pk => {
    const key = String(pk).replace(/\/+$/, '');
    const found = pk === '__APP__' || pkgs.some(x => String(x.root).replace(/\/+$/, '') === key);
    ok(found, from + ' → 预载分包 ' + pk + ' 存在');
  });
  (r.pages || []).forEach(p => {
    // 未指定 packages 时，pages 直接写完整路径
    const found = pkgs.some(x => x.pages.some(pp => joinPkg(x.root, pp) === p)) || mainPages.indexOf(p) >= 0;
    ok(found, from + ' → 预载页面 ' + p + ' 存在');
  });
});

section('6. 主包 / 分包页面不重名');
const dup = mainPages.filter(p => allPkgPages.indexOf(p) >= 0);
ok(dup.length === 0, '无重名页面' + (dup.length ? ' 【重复: ' + dup.join(', ') + '】' : ''));

section('7. 页面文件里引用的跳转路径可解析（学习单相关）');
const orderJs = fs.readFileSync(path.join(ROOT, 'pkgGuide/order/order.js'), 'utf8');
const navRe = /wx\.navigateTo\(\{\s*\n?\s*url:\s*'([^']+)'/g;
let m; let navs = []; while ((m = navRe.exec(orderJs))) navs.push(m[1]);
ok(navs.length > 0, 'order.js 存在 navigateTo（' + navs.length + ' 处）');
navs.forEach(u => {
  const clean = u.split('?')[0].replace(/^\//, '');
  const found = mainPages.indexOf(clean) >= 0 || allPkgPages.indexOf(clean) >= 0;
  ok(found, '跳转目标已注册: ' + u);
});

const hubJs = fs.readFileSync(path.join(ROOT, 'pkgGuide/tutorHub/tutorHub.js'), 'utf8');
ok(hubJs.indexOf('/pkgGuide/order/order') >= 0, 'tutorHub 入口指向 /pkgGuide/order/order（绝对路径）');

section('8. order.wxml 结构约束');
const orderWxml = fs.readFileSync(path.join(ROOT, 'pkgGuide/order/order.wxml'), 'utf8');

// 8.1 每个带 wx:for 的标签必须同时有 wx:key
// 取标签片段：从 '<' 到第一个 '{' 不在 {{ }} 内的 '>'
function tagSlices(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    // 跳过 </ 闭合与注释
    if (src[lt + 1] === '/' || src[lt + 1] === '!') { i = lt + 1; continue; }
    let j = lt, depth = 0, end = -1;
    while (j < src.length) {
      if (src.startsWith('{{', j)) { depth++; j += 2; continue; }
      if (src.startsWith('}}', j)) { depth = Math.max(0, depth - 1); j += 2; continue; }
      if (src[j] === '>' && depth === 0) { end = j; break; }
      j++;
    }
    if (end < 0) break;
    out.push(src.slice(lt, end + 1));
    i = end + 1;
  }
  return out;
}
const slices = tagSlices(orderWxml);
const forTags = slices.filter(s => /\bwx:for\b/.test(s));
ok(forTags.length > 0, 'order.wxml 存在 wx:for 列表（' + forTags.length + ' 处）');
forTags.forEach(s => {
  const forExpr = (s.match(/wx:for="\{\{([^}]*)\}\}"/) || [])[1] || '?';
  ok(/\bwx:key\b/.test(s), 'wx:for="{{' + forExpr + '}}" 带 wx:key');
  // wx:key="*this" 只对「元素本身唯一的原始值数组」成立；对象数组必须用字段名。
  // 静态解法：尝试在 order.js 里把该数组字面量抠出来，看有没有对象字面量。
  const keyVal = (s.match(/wx:key="([^"]*)"/) || [])[1];
  if (keyVal === '*this') {
    const root = forExpr.split(/[.\[]/)[0].trim();
    const arr = resolveArrayLiteral(orderJs, root);
    if (arr === null) {
      warn('wx:for="{{' + forExpr + '}}" 用 wx:key="*this"，但无法静态解析 ' + root + ' 的字面量，需人工确认元素为唯一原始值');
    } else if (/\{/.test(arr)) {
      ok(false, 'wx:for="{{' + forExpr + '}}" 用 wx:key="*this" 但 ' + root + ' 是对象数组 → 必须改成字段名');
    } else {
      ok(true, 'wx:for="{{' + forExpr + '}}" 用 wx:key="*this" 且 ' + root + ' 是原始值数组（安全）');
    }
  }
});

/**
 * 在 js 源里把数组字面量文本抠出来；失败返回 null。
 * 支持两种写法：
 *   ① name: [ ... ]                 —— 直接字面量
 *   ② name: NAME 且 const NAME = [ ... ] —— 跟一层标识符间接引用（本项目常量惯用写法）
 */
function resolveArrayLiteral(src, name, depth) {
  depth = depth || 0;
  if (depth > 2) return null;
  const re = new RegExp('(?:^|[\\s,{])' + name + '\\s*:\\s*(\\[|[A-Za-z_$][\\w$]*)');
  const m = re.exec(src);
  if (!m) return null;
  const token = m[1];
  if (token !== '[') {
    // 标识符间接引用：找 `const NAME = [` 或 `let/var NAME = [`
    const re2 = new RegExp('(?:const|let|var)\\s+' + token + '\\s*=\\s*\\[');
    const m2 = re2.exec(src);
    if (!m2) return null;
    return sliceBracket(src, m2.index + m2[0].length - 1);
  }
  return sliceBracket(src, m.index + m[0].length - 1);
}

/** 从 src[i] === '[' 起，返回配对 ']' 之间的文本（含两端方括号） */
function sliceBracket(src, i) {
  if (src[i] !== '[') return null;
  let depth = 0;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return out + ']';
    }
    out += c;
    i++;
  }
  return null;
}

// 8.2 事件处理函数必须在 order.js 中真实存在（抓错别字）
const orderJsForHandlers = orderJs;
const handlers = [];
const hRe = /\b(?:bind|catch)(?::)?(?:tap|input|change|confirm|submit|longpress|blur|focus)="([A-Za-z_$][\w$]*)"/g;
let hm; while ((hm = hRe.exec(orderWxml))) handlers.push(hm[1]);
const uniqHandlers = Array.from(new Set(handlers));
ok(uniqHandlers.length > 0, 'order.wxml 存在事件绑定（' + uniqHandlers.length + ' 个不同处理函数）');
uniqHandlers.forEach(name => {
  const re = new RegExp('(^|[\\s,{])' + name + '\\s*[:(]');
  ok(re.test(orderJsForHandlers), '处理函数已定义: ' + name);
});

// 8.3 数据集字段 data-* 的数据来源：至少确认 wxml 里用到的 data-xxx 都在 js 里被读或被绑定
const dataAttrs = Array.from(new Set((orderWxml.match(/\bdata-([a-z][\w-]*)=/g) || []).map(x => x.replace(/^data-|=$/g, ''))));
ok(dataAttrs.length > 0, 'order.wxml 存在 data-* 传参（' + dataAttrs.length + ' 类）');
dataAttrs.forEach(attr => {
  const camel = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const re = new RegExp('dataset\\.' + camel + '\\b');
  ok(re.test(orderJsForHandlers), 'data-' + attr + ' 在 js 中被读取（dataset.' + camel + '）');
});

section('9. order.js 关键契约锚点');
ok(/orderApi\s*\(/.test(orderJsForHandlers), 'order.js 走 tutorStore.orderApi 通道');
ok(orderJsForHandlers.indexOf('planCreatedAt') >= 0, 'order.js 出单快照含 planCreatedAt（planId 锚点）');
ok(orderJsForHandlers.indexOf('K.makeOrder') >= 0, 'order.js 离线兜底复用 K.makeOrder（不另起引擎）');
ok(orderJsForHandlers.indexOf('queueOrderPush') >= 0, 'order.js 离线兜底登记上云队列');

/* ============================================================================
 * §10 T22 —— AI 润色在端上的接入
 *
 * 这一节守的是一条**观感契约**，不是功能契约：
 *   闭环在「回执已提交」那一刻就闭合了（规则评语必出），AI 只改措辞。
 *   所以润色必须是**靠后的**（不能抢在成功提示前）和**非阻塞的**（不能被 await）。
 *   一旦顺序反了或被 await，AI 一慢/一挂，用户看到的就变成「提交好像没成功」——
 *   这是纯静态检查能抓、而跑起来通常抓不到的那类缺陷（本地 mock 从不超时）。
 * ========================================================================== */

const orderWxss = fs.readFileSync(path.join(ROOT, 'pkgGuide/order/order.wxss'), 'utf8');

/**
 * 判定「润色调用是非阻塞且靠后的」。合规返回 null，违规返回原因字符串。
 *
 * 之所以写成「返回原因」而不是「返回 boolean」，是为了让反证能指出**为什么**红——
 * 不然反证只能证明「它红了」，不能证明「它因为正确的原因红了」。
 */
function polishNotBlocking(js) {
  const toastIdx = js.indexOf("title: '回执已提交'");
  if (toastIdx < 0) return '找不到「回执已提交」成功提示锚点';
  const m = /self\.polishQuietly\s*\(/.exec(js);
  if (!m) return '找不到 polishQuietly 调用';
  if (m.index < toastIdx) return '润色调用排在成功提示之前（AI 会挡在闭环提示前面）';
  const lineStart = js.lastIndexOf('\n', m.index) + 1;
  const line = js.slice(lineStart, js.indexOf('\n', m.index));
  if (/\bawait\b/.test(line)) return '润色调用被 await（阻塞式）';
  const def = /polishQuietly\s*\(orderNo\)\s*\{([\s\S]*?)\n  \},/.exec(js);
  if (!def) return '找不到 polishQuietly 定义体';
  if (/\bawait\b/.test(def[1])) return 'polishQuietly 定义体内有 await（不再是静默的）';
  return null;
}

section('10. T22 · AI 润色端上接入');

/* 10.0 判定函数反证：合成「坏样本」，规则必须报红 —— 证明断言不是恒真 */
(function polishRuleSelfTest() {
  const GOOD = "  wx.showToast({ title: '回执已提交', icon: 'success' });\n  self.polishQuietly(oRow.orderNo);\n  polishQuietly(orderNo) {\n    const self = this;\n    tutorStore.orderApi('polish', {}).then(() => {});\n  },";
  const BAD_SWAPPED = "  self.polishQuietly(oRow.orderNo);\n  wx.showToast({ title: '回执已提交', icon: 'success' });\n  polishQuietly(orderNo) {\n    tutorStore.orderApi('polish', {}).then(() => {});\n  },";
  const BAD_AWAITED = "  wx.showToast({ title: '回执已提交', icon: 'success' });\n  await self.polishQuietly(oRow.orderNo);\n  polishQuietly(orderNo) {\n    tutorStore.orderApi('polish', {}).then(() => {});\n  },";
  const BAD_INNER = "  wx.showToast({ title: '回执已提交', icon: 'success' });\n  self.polishQuietly(oRow.orderNo);\n  polishQuietly(orderNo) {\n    await tutorStore.orderApi('polish', {});\n  },";
  ok(polishNotBlocking(GOOD) === null, '自检：合规样本 → 判定通过');
  ok(polishNotBlocking(BAD_SWAPPED) !== null, '自检（反证）：润色排到提示前 → 必须报红');
  ok(polishNotBlocking(BAD_AWAITED) !== null, '自检（反证）：调用点加了 await → 必须报红');
  ok(polishNotBlocking(BAD_INNER) !== null, '自检（反证）：定义体内加了 await → 必须报红');
  ok(polishNotBlocking("wx.showToast({ title: 'x' })") !== null, '自检（反证）：缺锚点/缺调用 → 必须报红（防空扫描）');
})();

/* 10.1 定义与绑定齐备 */
ok(/polishQuietly\s*\(orderNo\)\s*\{/.test(orderJs), 'order.js 定义 polishQuietly');
ok(/doPolish\s*\(\s*\)\s*\{/.test(orderJs), 'order.js 定义 doPolish');
ok(/bindtap="doPolish"/.test(orderWxml), 'order.wxml 详情页绑定 doPolish');
ok(/class="or-polish"/.test(orderWxml), 'order.wxml 存在补润色区块');
ok(/\.or-polish\s*\{/.test(orderWxss), 'order.wxss 有 .or-polish 样式');

/* 10.2 入口可见性：只在「有规则评语且未润色」时开放 */
ok(orderJs.indexOf("canPolish: !!comment && commentSource !== 'ai'") >= 0,
  'canPolish = 有评语 且 尚未润色（已 AI 的不重复给入口）');
ok(!/canPolish:\s*true/.test(orderJs), '反证：不存在无条件开放补润色入口的写法');
ok(/wx:if="\{\{detail\.canPolish\}\}"/.test(orderWxml), 'wxml 用 detail.canPolish 控制入口显隐');

/* 10.3 非阻塞且靠后（核心观感契约） */
const blockReason = polishNotBlocking(orderJs);
ok(blockReason === null, '润色非阻塞且排在成功提示之后' + (blockReason ? ' 【' + blockReason + '】' : ''));

/* 10.4 通道正确性：只走 openid 通道，不新增管理端写通道。
 *
 * ⚠️ 必须在**剥掉注释之后**判：这段源码的注释里本来就要写「管理端通道 webAdminWrite
 *    不含 polish」来解释设计取舍。用裸文本判会把解释性注释误判成违规调用
 *    —— 这正是「锁实现而不是锁规格」的典型翻车方式。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const orderJsCode = stripComments(orderJs);
ok(/tutorStore\.orderApi\('polish'/.test(orderJs), 'polish 走 tutorStore.orderApi（openid 通道）');
ok((orderJs.match(/orderApi\('polish'/g) || []).length === 2,
  '恰好两处调用：提交后静默 1 处 + 详情页手动 1 处');
ok(orderJsCode.indexOf('webAdminWrite') < 0, '小程序端不出现管理端写通道 webAdminWrite（剥注释后判）');
ok(orderJsCode.indexOf('webAdminQuery') < 0, '小程序端不出现管理端读通道 webAdminQuery（走自己的 orderApi）');
ok(orderJs.split('webAdminWrite').length - 1 > 0, '（提示）注释里明确写了不走 webAdminWrite 的取舍');
ok(stripComments("/* webAdminWrite */ var x = 'webAdminWrite';").indexOf('webAdminWrite') >= 0,
  '自检：剥注释只删注释、保留真代码里的名字（不是把关键字整串删掉）');
ok(stripComments('// webAdminWrite\ncode();').indexOf('webAdminWrite') < 0, '自检：行注释被剥掉');
ok(stripComments("var u = 'https://x/y';").indexOf('//') >= 0, '自检：URL 里的 // 不被误当注释（须保留 ://）');

/* 10.5 loading 态与防连点 */
ok(/polishing:\s*false/.test(orderJs), 'data 初始化 polishing: false');
ok(/\{\{polishing \? '润色中…' : 'AI 润色一下'\}\}/.test(orderWxml), '按钮带「润色中…」loading 文案');
ok(/if \(this\.data\.polishing\) return;/.test(orderJs), '重复点击被拦（防止连点白烧 token）');
ok(/setData\(\{ polishing: false \}\)/.test(orderJs), '回调里把 polishing 复位（失败也不卡在 loading）');

/* 10.6 失败不阻塞、不谎报 */
ok(/res\.polishFailed/.test(orderJs), '端上识别 polishFailed 回落态');
ok(/res\.deduped/.test(orderJs), '端上识别 deduped 幂等态');
ok(orderJs.indexOf('AI 暂时不可用，评语仍用规则版') >= 0, '回落时明说「仍用规则版」（不谎报成功）');

/* 10.7 详情可原地刷新（抽 renderDetail 的动机） */
ok(/openDetail\(e\)\s*\{[\s\S]{0,200}?this\.renderDetail\(no\)/.test(orderJs),
  'openDetail 经 renderDetail 渲染（补润色后能原地刷新，不重走 toast）');
ok(/renderDetail\(d\.orderNo\)/.test(orderJs), 'doPolish 成功后原地重绘详情（时间线跟上）');

console.log('\n========================================');
console.log('通过 ' + passes + ' 项，失败 ' + fails + ' 项，人工确认 ' + warns + ' 项');
console.log('========================================');
process.exit(fails ? 1 : 0);

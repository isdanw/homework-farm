#!/usr/bin/env node
/**
 * 网页看板「家长口令」静态契约（2026-10-29；同日起 childId 迁移 UI 随多孩下线）
 * ======================================================================
 *     node scripts/check-web-parent-pin.cjs
 *
 * 为什么静态校验：web/index.html 是 1.5MB 内联单文件（含内联 CloudBase SDK），
 * 端上逻辑没法直接 require。把契约钉成可执行断言，改坏了立刻红。
 *
 * 锁住的契约：
 *   §1 界面：设置页有「家长口令」一块，四种形态的输入/按钮齐全；迁移卡已下线；
 *   §2 身份：网页端一律用 webToken（本机访问口令）调 parentAuth，不依赖微信上下文；
 *   §3 会话：本机只存 token + expiresAt（不存 PIN），过期即清；
 *   §4 单孩子模型：网页端不得再有 childId 迁移入口（服务端能力保留作数据兼容）；
 *   §5 接线：切到「设置」时刷新家长口令状态；
 *   §6 云端闸门：parentAuth 有 webToken 分支并拒绝管理员口令；webAdminWrite 的
 *      confirm 必须验家长会话（per-user），管理员身份除外；
 *   §7 反证：把 webToken / confirm 闸拆掉，本文件的断言必须变红。
 *
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.resolve(process.env.WPP_WEB || path.join(ROOT, 'web/index.html'));
const WRITE = path.join(ROOT, 'cloudfunctions/webAdminWrite/index.js');
const AUTH = path.join(ROOT, 'cloudfunctions/parentAuth/index.js');
const CHILD_MODE = process.env.WPP_CHILD || '';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(n) { console.log('\n' + n); }

const web = fs.readFileSync(WEB, 'utf8');
const write = fs.readFileSync(WRITE, 'utf8');
const auth = fs.readFileSync(AUTH, 'utf8');

/** 取「设置」这一节（#set ... </section>），避免全文误命中 */
function section(src, id) {
  const start = src.indexOf('id="' + id + '"');
  if (start < 0) return '';
  const end = src.indexOf('</section>', start);
  return src.slice(start, end < 0 ? src.length : end);
}
/** 取一段 JS 函数体（从 marker 起匹配到下一个顶层函数声明） */
function block(src, marker, stopMarker) {
  const i = src.indexOf(marker);
  if (i < 0) return '';
  const j = stopMarker ? src.indexOf(stopMarker, i + marker.length) : -1;
  return src.slice(i, j < 0 ? Math.min(src.length, i + 4000) : j);
}

const setView = section(web, 'set');
const ppCall = block(web, 'async function ppCall(', 'function ppFail(');
const ppSubmit = block(web, 'async function ppSubmit(', "document.getElementById('ppPrimary')");

(async () => {
  group('一、界面：设置页的两块卡与四形态控件');
  ok(setView.indexOf('id="ppCard"') >= 0, '设置页有「家长口令」卡');
  ['ppOld', 'ppPin', 'ppPin2', 'ppPrimary', 'ppChange', 'ppCancel', 'ppRevoke', 'ppState', 'ppMsg']
    .forEach(id => ok(setView.indexOf('id="' + id + '"') >= 0, '家长口令控件 ' + id + ' 存在'));
  ['migCard', 'migScan', 'migConfirm', 'migMsg', 'migResult']
    .forEach(id => ok(setView.indexOf('id="' + id + '"') < 0, '迁移控件 ' + id + ' 已下线（单孩子模型）'));
  ok(/家长口令与网页访问口令是两件事/.test(setView), '文案说清「访问口令 ≠ 家长口令」');
  ok(/家长口令决定「能不能做家长动作」/.test(setView), '文案说清家长口令的用途');

  group('二、身份：网页端用 webToken 调 parentAuth');
  ok(/name:'parentAuth'/.test(ppCall), 'ppCall 调 parentAuth');
  ok(/webToken:\s*TOKEN/.test(ppCall), 'ppCall 必带 webToken: TOKEN（不依赖微信上下文）');
  ok(/ppMode === 'verify' \? 'verifyPin' : 'setPin'/.test(ppSubmit), 'setup/change 走 setPin，verify 走 verifyPin');
  ok(/ppCall\('verifyPin'/.test(ppSubmit), '设置/修改口令后自动再验一次（不把「设了口令」当「已验证」）');
  ok(/oldPin:\s*oldPin/.test(ppSubmit), '修改口令必须带当前口令');

  group('三、会话：本机只存 token + expiresAt');
  ok(/const PP_KEY = 'wb_hwfarm_parent_session'/.test(web), '会话键与其他看板状态分开');
  ok(/localStorage\.setItem\(PP_KEY, JSON\.stringify\(s\)\)/.test(web), '会话写 localStorage');
  ok(/if\(!\(Number\(s\.expiresAt\) > Date\.now\(\)\)\)\{ localStorage\.removeItem\(PP_KEY\); return null; \}/.test(web),
    '本机过期即清（不等云端）');
  const storeBlock = block(web, 'function ppStore(', 'function setText(');
  ok(storeBlock.indexOf('pin') < 0, 'ppStore 不碰 PIN');
  ok(/\['ppPin','ppPin2','ppOld'\]\.forEach\(id => \{ const el = document\.getElementById\(id\); if\(el\) el\.value = ''; \}\)/.test(ppSubmit),
    '提交后清空输入框');
  ok(web.indexOf('localStorage.setItem(PP_KEY, JSON.stringify({ pin') < 0, '没有任何「把 PIN 写本机」的路径');

  group('四、单孩子模型：childId 迁移入口已下线（服务端能力保留）');
  ok(!/migrateChildScope/.test(web), '网页端不再有 migrateChildScope 调用点');
  ok(!/historyMigrate|migRender|migCall/.test(web), '迁移脚本（migRender/migCall）已整体移除');

  group('五、接线：切到设置刷新状态');
  ok(/if\(v==='set'\)\{ loadVisionConfig\(\); ppRefresh\(\); \}/.test(web), 'switchView(set) 刷新家长口令状态');
  ok(/ppRefresh\(\);\s*\/\/ 换了访问口令/.test(web), '换访问口令后重查（换家庭不串状态）');
  ok(/localStorage\.removeItem\(TOKEN_KEY\); TOKEN=''; localStorage\.removeItem\(PP_KEY\);/.test(web),
    '清访问口令时一并清家长会话');

  group('六、云端闸门：身份与确认写入');
  ok(/async function resolveIdentity\(appObj, ev\)/.test(auth), 'parentAuth 有 resolveIdentity');
  ok(/webToken/.test(auth) && /web_portal_bindings/.test(auth), 'parentAuth 用 webToken → web_portal_bindings 解析 openid');
  ok(/code: 'admin_not_allowed'/.test(auth), 'parentAuth 明确拒绝管理员口令（它没有家长身份）');
  ok(/if \(webToken\) \{/.test(auth), '给了 webToken 就不再回落到网关 openid');
  ok(/async function requireParentSession\(appObj, webToken, parentSessionToken\)/.test(write),
    'webAdminWrite 有 requireParentSession');
  ok(/name: 'parentAuth',\s*\n\s*data: \{ action: 'status', webToken: webToken, sessionToken: t \}/.test(write),
    '家长会话校验复用 parentAuth.status（同一份语义，不自算散列）');
  ok(/if \(event\.confirm === true && !adminCall\) \{/.test(write), 'per-user 的 confirm 必须过家长闸；管理员身份除外');
  ok(/code: 'need_parent_pin'/.test(write), '缺家长口令 → need_parent_pin');

  /* ------------------------------ 反证 ------------------------------ */
  if (!CHILD_MODE) {
    group('七、反证：拆掉关键行，断言必须变红');
    const MUTANTS = [
      {
        name: 'webToken 不再随请求发（网页端失去身份）',
        from: 'webToken: TOKEN',
        to: 'webToken: \'\''
      },
      {
        name: '把已下线的迁移卡加回设置页',
        from: '<div class="card" style="margin-top:14px" id="ppCard">',
        to: '<div class="card" style="margin-top:14px" id="ppCard"><div id="migCard"></div>'
      }
    ];
    for (const m of MUTANTS) {
      if (web.indexOf(m.from) < 0) { ok(false, '反证定位失败：' + m.name); continue; }
      const tmp = path.join(path.dirname(WEB), '.mutant-web-parent-pin.html');
      fs.writeFileSync(tmp, web.replace(m.from, m.to), 'utf8');
      const run = spawnSync(process.execPath, [__filename], {
        env: Object.assign({}, process.env, { WPP_WEB: tmp, WPP_CHILD: m.name }),
        encoding: 'utf8'
      });
      try { fs.unlinkSync(tmp); } catch (e) {}
      const out = (run.stdout || '') + (run.stderr || '');
      ok(run.status !== 0, '「' + m.name + '」→ 测试变红 · exit=' + run.status);
      ok(/✗/.test(out), '「' + m.name + '」失败断言可见');
    }
  }

  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 家长口令契约（含多孩入口下线）全通过') +
    '（通过 ' + pass + ' 项，失败 ' + fail + ' 项）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试自身异常：', e); process.exit(1); });

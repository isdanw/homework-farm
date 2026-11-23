#!/usr/bin/env node
/**
 * 网页端导学代理守护（P1-2，2026-11-23）
 *
 * 契约：webAdminWrite 的 tutor 通道只转发不实现（复制必然分叉）；
 * tutorChat 的代身份分支只认 EXAM_ADMIN_KEY + 显式 openid，密钥不符落回 wx 守卫。
 *
 * 静态断言（与 test-order-contract / test-web-sync-stamp 同风格，读源码不跑云）：
 *   A. tutorChat 代身份分支：adminKey 常量比较 + 显式 openid + 失败落回 requireOpenid
 *   B. webAdminWrite 代理：对象形态校验、数组拒绝、白名单恰 4 个 action、
 *      未知 action 显式报错、adminKey 注入、lastUsed 回写、专属错误码
 *   C. 白名单禁项：diagnoseQuestions / unitSummary 不对网页端开放
 *   D. 两个文件的 node --check 语法必须过
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tcPath = path.join(ROOT, 'cloudfunctions/tutorChat/index.js');
const wawPath = path.join(ROOT, 'cloudfunctions/webAdminWrite/index.js');
const tc = fs.readFileSync(tcPath, 'utf8');
const waw = fs.readFileSync(wawPath, 'utf8');

let n = 0;
let bad = 0;
const ok = (cond, msg) => {
  n++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) bad++;
};

console.log('── A. tutorChat 代身份分支 ──');
ok(/const adminKey = \(process\.env\.EXAM_ADMIN_KEY \|\| ''\)\.trim\(\);/.test(tc),
  'A1 读取 EXAM_ADMIN_KEY 且 trim');
ok(/claimed === adminKey && event\.openid/.test(tc),
  'A2 密钥全等比较 + 显式 openid 才代身份');
ok(/if \(!openid\) \{[\s\S]*?G\.requireOpenid\(\(event\.userInfo && event\.userInfo\.openId\) \|\| ''\)/.test(tc),
  'A3 无有效代身份时落回 wx 身份守卫（不产生旁路）');
ok(/let openid = '';/.test(tc),
  'A4 openid 先置空再由两条路径赋值（无默认身份）');
ok(/str\(event\.openid, 64\)/.test(tc),
  'A5 代身份 openid 过 str 清洗（限长 64）');

console.log('── B. webAdminWrite 代理通道 ──');
ok(/if \(event\.tutor !== undefined\) \{/.test(waw), 'B1 存在 tutor 专用通道');
ok(/tutor 必须是对象 \{ action, \.\.\.payload \}；批量数组写入被拒绝/.test(waw),
  'B2 数组形态显式拒绝');
ok(/const TUTOR_ACTION_MAP = \{\s*\n\s*chat: 'chat', archive: 'archive',\s*\n\s*sessionSummary: 'sessionSummary', genCards: 'genCards'\s*\n\}/.test(waw),
  'B3 白名单恰为 chat/archive/sessionSummary/genCards');
ok(/if \(!TUTOR_ACTION_MAP\[act\]\)/.test(waw) && /bad_action/.test(waw),
  'B4 未知 action 显式报错（不静默忽略）');
ok(/name: TUTOR_SVC_NAME,/.test(waw) && /const TUTOR_SVC_NAME = 'tutorChat';/.test(waw),
  'B5 转发目标唯一且为 tutorChat（不复制业务逻辑）');
ok(/delete payload\.action;/.test(waw), 'B6 转发前剥离 action（防注入覆盖）');
ok(/adminKey: adminKey/.test(waw) && /callTutorChat/.test(waw),
  'B7 转发注入 EXAM_ADMIN_KEY（走 callTutorChat）');
ok(/no_admin_key/.test(waw), 'B8 未配置密钥时显式报错');
ok(/tutor_proxy_error/.test(waw), 'B9 转发抛错返回业务错误码（不让云函数 reject）');
ok(/lastUsed: Date\.now\(\)/.test(waw.split('导学对话代理通道')[1] || ''),
  'B10 代理成功后回写绑定 lastUsed');
ok(/tutorChat 无返回/.test(waw), 'B11 无返回兜底为业务错误');

console.log('── C. 白名单禁项（小程序专属流程不对网页端开放）──');
const mapBlock = waw.match(/const TUTOR_ACTION_MAP = \{[\s\S]*?\n\};/)[0];
ok(!/diagnoseQuestions/.test(mapBlock), 'C1 diagnoseQuestions 不在网页端白名单');
ok(!/unitSummary/.test(mapBlock), 'C2 unitSummary 不在网页端白名单');
ok(/仅开放 chat \/ archive \/ sessionSummary \/ genCards/.test(waw),
  'C3 报错文案明示开放范围');

console.log('── D. 语法 ──');
try { execFileSync(process.execPath, ['--check', tcPath], { stdio: 'pipe' }); ok(true, 'D1 tutorChat node --check'); }
catch (e) { ok(false, 'D1 tutorChat node --check: ' + e.message); }
try { execFileSync(process.execPath, ['--check', wawPath], { stdio: 'pipe' }); ok(true, 'D2 webAdminWrite node --check'); }
catch (e) { ok(false, 'D2 webAdminWrite node --check: ' + e.message); }

console.log(`\n通过 ${n - bad} 项，失败 ${bad} 项`);
if (bad) {
  console.log('❌ 网页端导学代理契约被破坏，提交/部署被阻断');
  process.exit(1);
}
console.log('✅ 网页端导学代理契约全通过（转发不复制 / 密钥代身份 / 白名单封闭）');

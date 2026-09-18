/**
 * rateWait 逻辑单测：从源文件抽出实现，用假时钟验证窗口档 / 小时档的等待时长计算。
 * 运行：node scripts/test-ratewait.js
 *
 * 覆盖：
 *   · tutorChat     （窗口 6s / 1 次，小时 60 次）
 *   · studyPlanGen  （窗口 10s / 1 次，小时 10 次）
 *   · 前端消费逻辑：retryAfterMs → 提示秒数与「重试」可用性
 * 改了 RATE 参数或 rateWait 实现后，务必重跑本用例。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadRateWait(file, endMarker) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const s = src.indexOf('const RATE =');
  const e = src.indexOf(endMarker, s);
  if (s < 0 || e < 0) throw new Error('无法从 ' + file + ' 抽取 rateWait');
  return new Function(src.slice(s, e) + '\nreturn rateWait;')();
}

/* ---- 假时钟 ---- */
let NOW = 1_000_000;
const realNow = Date.now;
Date.now = () => NOW;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + ' → ' + got + (ok ? '' : '（期望 ' + want + '）'));
}

/* ================= tutorChat：WIN 6000ms / 1 次，HOUR 60 次 ================= */
console.log('\n[tutorChat] WIN_MS=6000, MAX_PER_WIN=1, MAX_PER_HOUR=60');
{
  const rateWait = loadRateWait('cloudfunctions/tutorChat/index.js', '/* ---------------- 主控 prompt');
  const U = 'userA';

  NOW = 1_000_000;
  eq('t=0     第1次（放行）',        rateWait(U), 0);
  NOW += 1000;
  eq('t=1s    第2次（窗口内）',      rateWait(U), 5000);
  NOW += 2000;
  eq('t=3s    第3次（窗口内）',      rateWait(U), 3000);
  NOW = 1_000_000 + 6000;
  eq('t=6s    窗口到期（放行）',     rateWait(U), 0);
  NOW += 100;
  eq('t=6.1s  窗口内',              rateWait(U), 5900);

  // 空 openid：不计数、放行（公开调用/无上下文时不误伤）
  eq('空 openid 直接放行',          rateWait(''), 0);

  // 不同用户互不影响
  eq('另一用户首次（放行）',         rateWait('userB'), 0);

  // 小时档：同刻狂调，第 61 次应命中小时限流并返回 ≈ 1 小时
  const H = 'userH';
  NOW = 2_000_000;
  let hourHit = 0, hourWait = 0;
  for (let i = 1; i <= 61; i++) {
    const w = rateWait(H);
    if (i >= 2 && w > 6000) { hourHit = i; hourWait = w; break; }
  }
  eq('第 61 次命中小时档',           hourHit, 61);
  eq('小时档返回到整点剩余毫秒',      hourWait, 3_600_000);
}

/* ================= studyPlanGen：WIN 10000ms / 1 次，HOUR 10 次 ================= */
console.log('\n[studyPlanGen] WIN_MS=10000, MAX_PER_WIN=1, MAX_PER_HOUR=10');
{
  const rateWait = loadRateWait('cloudfunctions/studyPlanGen/index.js', '/* ---------- JSON 提取');
  const U = 'planUser';

  NOW = 5_000_000;
  eq('t=0     第1次（放行）',        rateWait(U), 0);
  NOW += 400;
  eq('t=0.4s  第2次（窗口内）',      rateWait(U), 9600);   // 与线上实测 374ms 同构
  NOW += 5000;
  eq('t=5.4s  窗口内',              rateWait(U), 4600);
  NOW = 5_000_000 + 10000;
  eq('t=10s   窗口到期（放行）',     rateWait(U), 0);

  // 小时档：第 11 次
  const H = 'planHour';
  NOW = 6_000_000;
  let hit = 0, w0 = 0;
  for (let i = 1; i <= 11; i++) {
    const w = rateWait(H);
    if (i >= 2 && w > 10000) { hit = i; w0 = w; break; }
  }
  eq('第 11 次命中小时档',           hit, 11);
  eq('小时档返回到整点剩余毫秒',      w0, 3_600_000);
}

/* ---- 前端消费逻辑：waitMs → 提示秒数 / 是否给「重试」---- */
console.log('\n[前端] 等待时长 → 提示与重试可用性');
{
  const RATE_RETRY_MAX_MS = 30000;
  const decide = (waitMs) => ({
    canRetry: waitMs <= RATE_RETRY_MAX_MS,
    waitSec: Math.max(1, Math.ceil(waitMs / 1000))
  });
  const a = decide(374);
  eq('374ms → 可重试',              a.canRetry, true);
  eq('374ms → 显示 1 秒（下限）',    a.waitSec, 1);
  const b = decide(9600);
  eq('9.6s → 显示 10 秒',           b.waitSec, 10);
  eq('9.6s → 可重试',               b.canRetry, true);
  const c = decide(3_600_000);
  eq('1 小时 → 不给重试',            c.canRetry, false);
  eq('1 小时 → 秒数上限 3600',       c.waitSec, 3600);
}

Date.now = realNow;
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);

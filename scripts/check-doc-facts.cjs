#!/usr/bin/env node
/**
 * 文档事实守护（check-doc-facts）：根目录文档中的结构数字必须与代码实测一致。
 *
 * 背景：README 曾写「pkgGuide 9 页 / pkgTools 8 页 / 15 个云函数」，
 * 全景说明曾写「21 个云函数」，实测 app.json 为 13/11 页、17 个有效入口，
 * 多份文档各自漂移。本脚本把数字钉死：
 *   1) 实测 miniprogram/app.json 分包页数 ↔ README.md 声称
 *   2) 实测 cloudfunctions/ 有效入口数（有 index.js）↔ README / 全景说明声称
 *   3) 反漂移禁令：README 不得再声称 checkinDetail「已知漏红」（2026-11-23 已核销）；
 *      全景说明不得再出现「21 个云函数」旧口径。
 *
 * 改了页面/云函数结构后：先更新 README 与 全科导学系统-全景说明.md 的数字，再跑本脚本。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let fail = false;
const log = (ok, msg) => {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + msg);
  if (!ok) fail = true;
};

// ── 1. 实测 ──────────────────────────────────────────────
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
const subs = appJson.subpackages || appJson.subPackages || [];
const subPages = {};
for (const s of subs) subPages[s.root] = s.pages.length;

const cfDir = path.join(ROOT, 'cloudfunctions');
const fns = fs
  .readdirSync(cfDir)
  .filter((d) => fs.existsSync(path.join(cfDir, d, 'index.js')))
  .sort();
const fnCount = fns.length;

console.log('── 文档事实守护 check-doc-facts ──');
console.log(
  `实测: 主包 ${appJson.pages.length} 页 · pkgGuide ${subPages.pkgGuide || '?'} 页 · ` +
    `pkgTools ${subPages.pkgTools || '?'} 页 · 有效云函数 ${fnCount} 个`
);

// ── 2. 文档断言 ──────────────────────────────────────────
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const panorama = fs.readFileSync(path.join(ROOT, '全科导学系统-全景说明.md'), 'utf8');

const grab = (text, re) => {
  const m = text.match(re);
  return m ? Number(m[1]) : null;
};

const cases = [
  ['README pkgGuide 页数', readme, /分包 `pkgGuide`（导学相关，(\d+) 页）/, subPages.pkgGuide],
  ['README pkgTools 页数', readme, /分包 `pkgTools`（工具相关，(\d+) 页）/, subPages.pkgTools],
  ['README 云函数个数', readme, /云函数（`cloudfunctions\/`，(\d+) 个/, fnCount],
  ['全景说明 §一 云函数数', panorama, /(\d+) 个有效云函数提供写入、判分/, fnCount],
  ['全景说明 §六标题云函数数', panorama, /云端中枢：(\d+) 个有效云函数职责表/, fnCount],
  ['全景说明 架构图云函数数', panorama, /│\s+(\d+)个云函数 │/, fnCount],
];
for (const [name, text, re, expect] of cases) {
  const got = grab(text, re);
  log(got === expect, `${name}: 文档=${got === null ? '未找到' : got} 实测=${expect}`);
}

// ── 3. 反漂移禁令 ────────────────────────────────────────
const banned = [
  [
    readme,
    /已知漏红[\s\S]{0,120}checkinDetail/,
    'README 仍声称 checkinDetail「已知漏红」（2026-11-23 已核销，请更新口径）',
  ],
  [
    panorama,
    /21\s*个?云函数/,
    '全景说明仍含「21 个云函数」旧口径（实测 17 个有效入口）',
  ],
];
for (const [text, re, reason] of banned) {
  log(!re.test(text), `禁令: ${reason}`);
}

console.log(
  fail
    ? '── check-doc-facts: FAIL（数字漂移，按上方输出修正文档）──'
    : '── check-doc-facts: 全部一致 ──'
);
process.exit(fail ? 1 : 0);

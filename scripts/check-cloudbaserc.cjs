#!/usr/bin/env node
/**
 * 部署清单契约校验（cloudbaserc.json）——离线，无云依赖
 *
 * 为什么要有这个脚本：CloudBase 只部署「cloudbaserc 里登记过」的函数，
 * 没登记的会**静默跳过**、不报错（2026-10 踩过一次：改了代码以为部署了，
 * 线上还是旧行为）。反向也一样：登记了但本地没有目录，框架部署直接失败。
 * 2026-10-29 体检发现 7 个在用函数（tutorOrder / studyPlanGen / ocrSchedule /
 * aiRoleAnalyze / analyzeComment / webPortalBind / webVisionConfig）都没登记，
 * dailyReset 的定时器也只存在于云端、不在清单里 —— 一次框架部署就会把它们弄丢。
 *
 * 校验项：
 *   §1 清单可解析、函数名不重复、runtime 在白名单、每个登记项都有本地目录与 index.main
 *   §2 端上用到的云函数（callFunction name + 本地有目录）必须全部登记
 *   §3 dailyReset 必须带 timer 触发器（云端每天 00:05 结算，丢了就整夜不结算）
 *   §4 反证：删掉一条登记后本脚本必须变红
 *
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CFG_PATH = path.join(REPO, 'cloudbaserc.json');
const FN_ROOT = path.join(REPO, 'cloudfunctions');
const CLIENT_ROOTS = ['miniprogram', 'web', 'ipadApp', 'scripts'];
const RUNTIMES = ['Nodejs16.13', 'Nodejs18.15', 'Nodejs20.19'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'screenshots', '_attic_trash', '.backup-t21b']);
/** 平台内置/脚手架名字：不是本仓维护的函数，登记与否都不影响部署 */
const PLATFORM_NAMES = new Set([
  'copy-objects', 'delete-objects', 'get-objects-download-info', 'get-objects-upload-info',
  'lowcode-datasource', 'httpOverCallFunction'
]);

const results = [];
function ok(cond, msg) { results.push({ cond: !!cond, msg }); }

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|wxml|html|swift)$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** 端上真正会调的云函数名（只统计本地有目录的，天然排掉平台内置） */
function clientCalled() {
  const names = new Set();
  const files = [];
  CLIENT_ROOTS.forEach(r => walk(path.join(REPO, r), files));
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/callFunction\s*\(\s*\{[^}]*?name:\s*['"]([A-Za-z0-9_-]+)['"]/gs)) names.add(m[1]);
  }
  return names;
}

function localDirs() {
  return fs.readdirSync(FN_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => d.name);
}

function check(cfgPath) {
  const fails = [];
  const passes = [];

  /* ---------------- §1 清单自身 ---------------- */
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    fails.push('cloudbaserc.json 解析失败：' + e.message);
    return { fails, passes };
  }
  passes.push('cloudbaserc.json 可解析');
  if (cfg.envId !== 'workbuddy-d2gsgtfvmde5c9adf') fails.push('envId 不是 workbuddy-d2gsgtfvmde5c9adf：' + cfg.envId);
  else passes.push('envId 正确');

  const fns = Array.isArray(cfg.functions) ? cfg.functions : [];
  const seen = new Set();
  fns.forEach(f => {
    if (seen.has(f.name)) fails.push('函数重复登记：' + f.name);
    seen.add(f.name);
    if (RUNTIMES.indexOf(f.runtime) < 0) fails.push(f.name + ' runtime 不在白名单：' + f.runtime);
    if (f.handler !== 'index.main') fails.push(f.name + ' handler 应为 index.main，实际 ' + f.handler);
    const dir = path.join(FN_ROOT, f.name);
    if (!fs.existsSync(path.join(dir, 'index.js'))) { fails.push('登记的 ' + f.name + ' 本地没有 index.js'); return; }
    const src = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
    if (!/\bexports\.main\b|\bmodule\.exports\s*=\s*\{[^}]*\bmain\b/.test(src)) fails.push(f.name + ' 的 index.js 没有导出 main');
  });
  if (!fails.length) passes.push('登记项 ' + fns.length + ' 个：runtime / handler / 本地目录 / main 导出齐全');

  /* ---------------- §2 端上调用必须登记 ---------------- */
  const called = clientCalled();
  const dirs = new Set(localDirs());
  const missing = [...called]
    .filter(n => dirs.has(n) && !seen.has(n))
    .sort();
  if (missing.length) fails.push('端上在调用但未登记（框架部署会静默跳过）：' + missing.join(', '));
  else passes.push('端上调用且本地有目录的 ' + [...called].filter(n => dirs.has(n)).length + ' 个云函数全部已登记');

  const phantom = [...seen].filter(n => !dirs.has(n));
  if (phantom.length) fails.push('登记了但没有本地目录：' + phantom.join(', '));
  else passes.push('无幽灵登记项');

  /* ---------------- §3 定时器 ---------------- */
  const dr = fns.find(f => f.name === 'dailyReset');
  const trig = dr && Array.isArray(dr.triggers) ? dr.triggers : [];
  const timer = trig.find(t => t && t.type === 'timer');
  if (!timer) fails.push('dailyReset 缺 timer 触发器（云端每天 00:05 的结算会丢）');
  else if (String(timer.config || '').trim() !== '0 5 0 * * * *') {
    fails.push('dailyReset 触发器 cron 不是「0 5 0 * * * *」，实际「' + timer.config + '」');
  } else passes.push('dailyReset 定时器已登记（0 5 0 * * * *，对应云端 00:05）');

  return { fails, passes };
}

/* ---------------- §4 反证：把一条登记删掉，脚本必须变红 ---------------- */
function counterproof() {
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const cut = JSON.parse(JSON.stringify(raw));
  cut.functions = cut.functions.filter(f => f.name !== 'studyPlanGen');
  const tmp = path.join(os.tmpdir(), 'cloudbaserc.mutant.' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify(cut));
  let red = false;
  let childOut = '';
  try {
    execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { CB_CFG: tmp }), encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    red = true;
    childOut = String((e && e.stdout) || '');
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
  return { red, childOut };
}

function main() {
  const cfgPath = process.env.CB_CFG ? path.resolve(process.env.CB_CFG) : CFG_PATH;
  const { fails, passes } = check(cfgPath);

  console.log('一、部署清单契约（' + path.basename(cfgPath) + '）');
  passes.forEach(m => console.log('  ✓ ' + m));
  fails.forEach(m => console.log('  ✗ ' + m));

  if (!process.env.CB_CFG) {
    console.log('\n二、反证：删掉 studyPlanGen 登记，本脚本必须变红');
    const cp = counterproof();
    console.log((cp.red ? '  ✓ ' : '  ✗ ') + '删掉一条登记 → ' + (cp.red ? '脚本变红' : '脚本仍然全绿（判据是恒真的）'));
    if (cp.red && cp.childOut) {
      const line = cp.childOut.split('\n').find(l => l.indexOf('studyPlanGen') >= 0) || '';
      console.log((line ? '  ✓ ' : '  ✗ ') + '失败信息点到了被删的函数' + (line ? '：' + line.trim() : ''));
      if (!line) fails.push('反证失败信息没点到 studyPlanGen');
    }
    if (!cp.red) fails.push('反证未变红：删掉登记后脚本仍全绿');
  }

  console.log('\n' + '-'.repeat(60));
  console.log(fails.length ? '通过 ' + passes.length + ' 项，失败 ' + fails.length + ' 项' : '通过 ' + passes.length + ' 项  ✓ 全部通过');
  process.exit(fails.length ? 1 : 0);
}

main();

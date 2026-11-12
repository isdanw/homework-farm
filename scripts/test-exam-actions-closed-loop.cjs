#!/usr/bin/env node
/**
 * test-exam-actions-closed-loop.cjs —— examService 动作「有没有调用方」
 * ==========================================================================================
 *     node scripts/test-exam-actions-closed-loop.cjs
 *
 * 2026-10-29 体检发现三个**没有调用方**的动作：diagnoseBlindSpot（端上自己有同口径实现）、
 * uploadPageImage（iPad 走本地合成 + COS 直传，不用云端这版）、deleteExam（试卷库没有删除入口）。
 * 死动作的成本不是代码行数，是「以为有、其实没有」：接口文档写着、看板统计着、却永远没人调。
 *
 *   §1 两个纯冗余动作已从 examService 摘除（实现 + dispatch 都没了）
 *   §2 deleteExam 有了真实入口：试卷库「我的测验卷」删除（catchtap，不会误进作答页）
 *   §3 现存 35 个动作都必须有客户端字符串引用（防新死动作）
 *   §4 反证：把 diagnoseBlindSpot 塞回去 / 把删除入口摘掉 → 本脚本变红
 *
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SVC = path.resolve(process.env.EAC_SVC || path.join(ROOT, 'cloudfunctions/examService/index.js'));
const API = path.join(ROOT, 'miniprogram/utils/examApi.js');
const GAL_JS = path.resolve(process.env.EAC_GAL || path.join(ROOT, 'miniprogram/pkgGuide/examGallery/examGallery.js'));
const GAL_WXML = path.join(ROOT, 'miniprogram/pkgGuide/examGallery/examGallery.wxml');
const CHILD = process.env.EAC_CHILD || '';

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; return true; }
  fail++;
  console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''));
  return false;
}
function group(name) { console.log('\n' + name); }

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'screenshots', '_attic_trash', '.backup-t21b'].indexOf(ent.name) >= 0) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|wxml|html|swift)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function actionsOf(src) {
  return [...src.matchAll(/case '([A-Za-z0-9_]+)':/g)].map(m => m[1]);
}

function sectionRemoved() {
  group('一、冗余动作已摘除（实现 + dispatch）');
  const src = fs.readFileSync(SVC, 'utf8');
  ok(!/function\s+diagnoseBlindSpot\s*\(/.test(src), 'diagnoseBlindSpot 实现已删除');
  ok(!/case\s+'diagnoseBlindSpot'/.test(src), 'diagnoseBlindSpot dispatch 已删除');
  ok(!/function\s+uploadPageImage\s*\(/.test(src), 'uploadPageImage 实现已删除');
  ok(!/case\s+'uploadPageImage'/.test(src), 'uploadPageImage dispatch 已删除');
  ok(!/uploadPageImage\s+上传试卷原卷页面图/.test(src), '动作清单注释同步移除');
  // 端上本地实现仍在（不是把能力删掉了，只是不再有第二份云端实现）
  const ts = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/tutorStore.js'), 'utf8');
  ok(/function\s+diagnoseBlindSpot\s*\(/.test(ts), '端上 tutorStore.diagnoseBlindSpot 仍在（唯一实现）');
}

function sectionDeleteWired() {
  group('二、deleteExam 有了真实入口');
  const api = fs.readFileSync(API, 'utf8');
  ok(/deleteExam:\s*function\s*\(\s*resourceId\s*\)/.test(api), 'examApi 暴露 deleteExam(resourceId)');
  ok(/call\('deleteExam',\s*\{\s*resourceId:\s*resourceId/.test(api), 'deleteExam 走 call(action, resourceId) 契约');

  const gal = fs.readFileSync(GAL_JS, 'utf8');
  ok(/onDeleteExam\s*\(\s*e\s*\)/.test(gal), '试卷库有 onDeleteExam 处理器');
  const body = (() => {
    const m = /onDeleteExam\s*\([^)]*\)\s*\{/.exec(gal);
    if (!m) return '';
    let i = m.index + m[0].length, depth = 1;
    const start = i;
    while (i < gal.length && depth > 0) { if (gal[i] === '{') depth++; else if (gal[i] === '}') depth--; i++; }
    return gal.slice(start, i - 1);
  })();
  ok(/EXAM\.deleteExam\(/.test(body), '处理器真的调了 EXAM.deleteExam');
  ok(/showModal/.test(body), '删除前二次确认');
  ok(/fetchMyExams/.test(body), '删除后刷新列表（不留幽灵卡片）');

  const wxml = fs.readFileSync(GAL_WXML, 'utf8');
  ok(/catchtap="onDeleteExam"/.test(wxml), '删除按钮用 catchtap（不冒泡进「去作答」）');
  ok(/data-rid="\{\{item\.resourceId\}\}"/.test(wxml), '删除按钮带 resourceId');
}

function sectionNoDeadActions() {
  group('三、现存动作都有客户端引用（防新死动作）');
  const src = fs.readFileSync(SVC, 'utf8');
  const acts = actionsOf(src);
  ok(acts.length >= 30, '动作表非空且规模正常：' + acts.length);
  const files = [];
  ['miniprogram', 'web', 'ipadApp'].forEach(r => walk(path.join(ROOT, r), files));
  const texts = files.map(p => fs.readFileSync(p, 'utf8'));
  const dead = acts.filter(a => {
    const re = new RegExp('[\'"]' + a + '[\'"]');
    return !texts.some(t => re.test(t));
  });
  ok(dead.length === 0, '无死动作', dead.join(', '));
}

function sectionCounterproof() {
  if (CHILD) return;
  group('四、反证');
  const mutants = [
    {
      name: '把 diagnoseBlindSpot 塞回去',
      file: SVC,
      env: { EAC_SVC: path.join(path.dirname(SVC), '_mut_svc_blind.js') },
      transform: (s) => s.replace("case 'listPlans':", "case 'diagnoseBlindSpot': return { ok: true };\n      case 'listPlans':")
    },
    {
      name: '把试卷删除入口摘掉',
      file: GAL_WXML,
      env: null,
      transform: null
    }
  ];
  // 第二个反证改的是 wxml，用专门的入口：复制 gallery.wxml 到临时名不生效，
  // 所以直接改 gal.js（去掉 EXAM.deleteExam 调用）——同样是「入口被摘」的形态。
  mutants[1] = {
    name: '删除处理器不再调云端',
    file: GAL_JS,
    env: { EAC_GAL: path.join(path.dirname(GAL_JS), '_mut_gal_del.js') },
    transform: (s) => s.replace('EXAM.deleteExam(rid)', 'Promise.resolve({ ok: true })')
  };

  for (const m of mutants) {
    const src = fs.readFileSync(m.file, 'utf8');
    const next = m.transform(src);
    const target = Object.values(m.env)[0];
    if (next === src) { ok(false, '反证定位失败：' + m.name); continue; }
    fs.writeFileSync(target, next, 'utf8');
    const run = spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, m.env, { EAC_CHILD: m.name }),
      encoding: 'utf8'
    });
    try { fs.unlinkSync(target); } catch (e) {}
    const text = (run.stdout || '') + (run.stderr || '');
    ok(run.status !== 0, '「' + m.name + '」→ 测试变红 · exit=' + run.status);
    ok(/✗/.test(text), '「' + m.name + '」失败断言可见');
  }
}

sectionRemoved();
sectionDeleteWired();
sectionNoDeadActions();
sectionCounterproof();

console.log('\n' + '-'.repeat(60));
console.log(fail
  ? '❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项'
  : '✅ examService 动作闭环全通过（通过 ' + pass + ' 项，失败 0 项）');
process.exit(fail ? 1 : 0);

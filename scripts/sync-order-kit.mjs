#!/usr/bin/env node
/**
 * sync-order-kit.mjs —— 把 order-kit/ 下的 canonical 源同步到各端副本。
 *
 * 用法：
 *   node scripts/sync-order-kit.mjs          写入所有副本
 *   node scripts/sync-order-kit.mjs --check  只校验，不写入（哈希锁，CI/测试用）
 *
 * 三份 canonical（均在 order-kit/ 下）：
 *   orderKit.js        纯单引擎（编号/状态机/协议块/回执解析/评语规则）
 *   orderActions.js    业务动作层（出单/回执/作废/重开；纯逻辑，注入式 deps）
 *   orderCloudDeps.js  node-sdk 适配器（find/list/insert/update + now/rand）
 *
 * 设计要点：
 *   · canonical 是**唯一真相源**，副本一律带 AUTO-GENERATED 头，禁止手改；
 *   · 各端只抽取 `@@…BODY_BEGIN@@ … @@…BODY_END@@` 之间的纯逻辑体做哈希比对 ——
 *     包壳（UMD / ESM）允许不同，逻辑体必须逐字节相同；
 *   · **区段体内不得出现顶层 `return`**（见 assertNoTopLevelReturn）：ESM 副本顶层
 *     不允许 return，写错会让工作台那份直接语法错误。CJS 的 `return` 与 ESM 的
 *     `export` 一律由本脚本按目标追加在区段之外。
 *   · 目标目录不存在时跳过（例如单克隆环境下没有工作台），不算失败。
 *
 * ⚠️ 已踩过的坑：拼接时「标记 + 逻辑体 + 标记」必须作为**一个**数组元素，
 *    否则 join('\n') 会在标记与逻辑体之间多插一个换行，抽取出的区段与 canonical
 *    差一个换行 → 刚生成完 --check 就报三端全不一致。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const WORKBENCH_DIR = join(
  process.env.HOME || '',
  'Desktop/全科导学专家-小程序/全学科导学工作台'
);

/* ---------------- canonical 定义 ---------------- */

const SOURCES = [
  {
    id: 'orderKit',
    file: 'order-kit/orderKit.js',
    title: 'orderKit（单引擎）',
    begin: '/* @@ORDER_KIT_BODY_BEGIN @@ */',
    end: '/* @@ORDER_KIT_BODY_END @@ */',
    /** 区段体内声明的具名 API 对象；CJS 的 return / ESM 的 export 都指向它 */
    apiVar: 'ORDER_KIT_API',
    exportBlock: /var ORDER_KIT_API = \{([\s\S]*?)\n  \};/,
  },
  {
    id: 'orderActions',
    file: 'order-kit/orderActions.js',
    title: 'orderActions（业务动作层）',
    begin: '// @@ORDER_ACTIONS_BODY_BEGIN@@',
    end: '// @@ORDER_ACTIONS_BODY_END@@',
    apiVar: 'ORDER_ACTIONS_API',
    // orderActions 的导出名由 canonical 直接声明，无需从 API 对象解析
    exportNames: ['createActions', 'ACTIONS', 'LIST_LIMIT'],
  },
  {
    id: 'orderCloudDeps',
    file: 'order-kit/orderCloudDeps.js',
    title: 'orderCloudDeps（node-sdk 适配器）',
    begin: '// @@ORDER_CLOUD_DEPS_BODY_BEGIN@@',
    end: '// @@ORDER_CLOUD_DEPS_BODY_END@@',
    apiVar: 'ORDER_CLOUD_DEPS_API',
    exportNames: ['makeDeps', 'DEFAULT_COLL'],
  },
];

/**
 * 区段体守门：**顶层 `return` 会把 ESM 副本变成语法错误**。
 *
 * 为什么必须在这里拦：区段体被原样复制到工作台的 ESM 副本，而 ESM 模块顶层不允许
 * `return`。写错时 JS 引擎报的是「Return statement is not allowed here」——
 * 出现在 **rollup/vite 解析阶段**，报错信息里连文件名都没有，极难定位。
 * 本项目真实踩过：canonical 用 `return { … }` 时，工作台那份 orderKit 从来就
 * import 不进来，而 T06 声称的"三端接入"没有任何测试覆盖到。
 *
 * 判据：工厂函数体的语句缩进为 2 空格，其内部函数体 ≥4 空格 →
 * `^  return`（行首恰好两空格）只可能是工厂级 return，正是要禁止的那种。
 */
function assertNoTopLevelReturn(body, src) {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^  return\b/.test(lines[i])) {
      throw new Error(
        `${src.file} 区段体内出现顶层 return（第 ${i + 1} 行）：${lines[i].trim()}\n` +
        `  这会让 ESM 副本（工作台 src/order-kit/${src.id}.js）直接语法错误。\n` +
        `  改用「声明 var ${src.apiVar} = { … };」——return/export 由生成器追加在区段之外。`
      );
    }
  }
}

function header(title, src) {
  return [
    '/**',
    ' * ⚠️ AUTO-GENERATED —— 请勿直接编辑本文件。',
    ` * 内容：${title}`,
    ` * 源文件：${src}（canonical）`,
    ' * 重新生成：node scripts/sync-order-kit.mjs',
    ' * 一致性由 scripts/test-order-kit-sync.cjs 用 sha256 校验区段锁死。',
    ' */',
    ''
  ].join('\n');
}

function hashBody(body) {
  return createHash('sha256').update(body.replace(/\s+$/, ''), 'utf8').digest('hex');
}

/** 从 canonical 的 `return { … }` 块里抽出导出名（key === value，全部同名） */
function extractExportNames(raw, src) {
  if (src.exportNames) return src.exportNames.slice();
  const m = src.exportBlock.exec(raw);
  if (!m) throw new Error(`${src.file} 缺少 return { … } 导出块`);
  const names = [];
  const re = /^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm;
  let hit;
  while ((hit = re.exec(m[1])) !== null) {
    if (names.indexOf(hit[1]) < 0) names.push(hit[1]);
  }
  if (!names.length) throw new Error(`未能从 ${src.file} 的 return 块解析出导出名`);
  return names;
}

function cjsTarget(body, src) {
  return [
    header(src.title, src.file),
    '(function (root, factory) {',
    '  var api = factory();',
    "  if (typeof module === 'object' && module.exports) module.exports = api;",
    '  else root.' + src.id.charAt(0).toUpperCase() + src.id.slice(1) + ' = api;',
    "})(typeof globalThis !== 'undefined' ? globalThis : this, function () {",
    "  'use strict';",
    '',
    // ⚠️ 必须拼成一个元素，见文件头「已踩过的坑」
    src.begin + body + src.end,
    // 区段体只声明 API 对象，不 return —— return 在此处按目标追加（区段之外，不进哈希）
    '  return ' + src.apiVar + ';',
    '});',
    ''
  ].join('\n');
}

function esmTarget(body, src, names) {
  const named = names.join(', ');
  return [
    header(src.title, src.file),
    // ESM：区段体原样内联，**不能**含顶层 return（否则整个模块语法错误）
    src.begin + body + src.end,
    '',
    'export { ' + named + ' };',
    'export default ' + src.apiVar + ';',
    ''
  ].join('\n');
}

function buildTargets(src, body, names) {
  const isKit = src.id === 'orderKit';
  const list = [];
  if (isKit) {
    list.push({ label: '小程序', path: join(ROOT, 'miniprogram/utils/orderKit.js'), content: cjsTarget(body, src), src });
  }
  // 两个写入口云函数都要同一份逻辑：tutorOrder（小程序 openid 通道）/
  // webAdminWrite（网页看板·工作台 口令→openid 通道）。绝不允许各写一套状态机。
  for (const fn of ['tutorOrder', 'webAdminWrite']) {
    list.push({
      label: `云函数 ${fn}`,
      path: join(ROOT, 'cloudfunctions', fn, `${src.id}.js`),
      content: cjsTarget(body, src),
      src,
    });
  }
  if (isKit) {
    list.push({
      label: '工作台',
      path: join(WORKBENCH_DIR, 'src/order-kit/orderKit.js'),
      content: esmTarget(body, src, names),
      src,
    });
    // webAdminQuery 也要 orderKit：它的 `module:'orders'` 返回 plans 聚合，
    // 而「三端渲染同一份聚合数据」要求三端调**同一个函数**（T23）。
    // 只给它 orderKit（纯函数、零依赖、只读）—— 不给 orderActions / orderCloudDeps，
    // 那个云函数是**只读**的，一个写能力都不该有。
    list.push({
      label: '云函数 webAdminQuery（只读）',
      path: join(ROOT, 'cloudfunctions/webAdminQuery/orderKit.js'),
      content: cjsTarget(body, src),
      src,
    });
  }
  return list;
}

/* ---------------- 主流程 ---------------- */

function readCanonical(src) {
  const full = join(ROOT, src.file);
  const raw = readFileSync(full, 'utf8');
  const i = raw.indexOf(src.begin);
  const j = raw.indexOf(src.end);
  if (i < 0 || j < 0) throw new Error(`${src.file} 缺少区段标记`);
  const body = raw.slice(i + src.begin.length, j);
  return { raw, body };
}

function extractBodyFrom(file, src) {
  const raw = readFileSync(file, 'utf8');
  const i = raw.indexOf(src.begin);
  const j = raw.indexOf(src.end);
  if (i < 0 || j < 0) return null;
  return raw.slice(i + src.begin.length, j);
}

function main() {
  const check = process.argv.indexOf('--check') >= 0;
  let bad = 0;
  let written = 0;
  let skipped = 0;

  for (const src of SOURCES) {
    const { raw, body } = readCanonical(src);
    assertNoTopLevelReturn(body, src);
    const names = extractExportNames(raw, src);
    const want = hashBody(body);
    const targets = buildTargets(src, body, names);

    console.log(`── ${src.title} ──`);
    for (const t of targets) {
      const inRepo = t.path.startsWith(ROOT);
      if (!inRepo && !existsSync(dirname(dirname(dirname(t.path))))) {
        console.log(`  跳过  ${t.label}（目标工程不存在）`);
        skipped++;
        continue;
      }
      const exists = existsSync(t.path);
      if (check) {
        if (!exists) {
          console.log(`  ✗ ${t.label} 副本缺失：${t.path}`);
          bad++;
          continue;
        }
        const gotBody = extractBodyFrom(t.path, src);
        if (gotBody === null) {
          console.log(`  ✗ ${t.label} 副本缺少区段标记：${t.path}`);
          bad++;
          continue;
        }
        const got = hashBody(gotBody);
        if (got !== want) {
          console.log(`  ✗ ${t.label} 逻辑体与 canonical 不一致`);
          console.log(`      want ${want}`);
          console.log(`      got  ${got}`);
          bad++;
        } else {
          console.log(`  ✓ ${t.label}`);
        }
        continue;
      }

      const prev = exists ? readFileSync(t.path, 'utf8') : '';
      if (prev === t.content) {
        console.log(`  未变  ${t.label}`);
      } else {
        mkdirSync(dirname(t.path), { recursive: true });
        writeFileSync(t.path, t.content, 'utf8');
        console.log(`  写入  ${t.label} → ${t.path}`);
        written++;
      }
    }
    console.log(`  sha256(body) = ${want}`);
    console.log(`  导出名 ${names.length} 个：${names.slice(0, 8).join(', ')}${names.length > 8 ? ' …' : ''}`);
    console.log('');
  }

  console.log(`写入 ${written} · 跳过 ${skipped} · 不一致 ${bad}`);

  if (check && bad > 0) {
    console.error('\n哈希锁失败：请执行 `node scripts/sync-order-kit.mjs` 重新生成副本。');
    process.exit(1);
  }
  if (!check && bad > 0) process.exit(1);
}

main();

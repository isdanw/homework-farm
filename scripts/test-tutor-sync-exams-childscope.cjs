/**
 * test-tutor-sync-exams-childscope.cjs —— 小程序「试卷库」第三块的孩子维度
 * ==========================================================================
 *     node scripts/test-tutor-sync-exams-childscope.cjs
 *
 * 背景：试卷中心有三块数据源 —— ① AI 出卷入口 ② examService.listExams（已按孩子过滤）
 * ③ tutorSync.exams（工作台推送的只读库）。第 ③ 块原先按 openid 全量返回，
 * 于是「切到老二」后仍能看到老大的卷（AI 卷也落在这个集合里，origin/lchild 都在）。
 *
 * 本轮修的规则（与 examService.listExams 逐字相同，两条读路径不能各算一套口径）：
 *   · 能解析出当前孩子 → 只回「该孩子的卷 + 无归属卷」（历史行/工作台库资源不猜也不藏）；
 *   · 点名跨家庭/非法 childId → 回落当前孩子再过滤（坏参数不能把过滤整个关掉）；
 *   · 解析不出孩子（未建档 / 占位切片）→ 不过滤；
 *   · 详情 exam 同样过闸：别人的孩子的卷按 not_found 处理，不暴露存在性。
 *
 * 2026-10-29 起产品收成单孩子：端上不再传 childId，归属一律由服务端按当前孩子解析；
 * 下面的服务端闸门断言保留（它是安全网），端上断言反过来锁「不得再传 childId」。
 *
 * 反证（默认就跑）：拆掉列表过滤 / 拆掉详情闸，本文件必须变红。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SYNC_PATH = process.env.SYNC_PATH || path.join(ROOT, 'cloudfunctions/tutorSync/index.js');
const GALLERY = path.join(ROOT, 'miniprogram/pkgGuide/examGallery/examGallery.js');
const CHILD_MODE = process.env.EXAM_SYNC_CHILD || '';

const OID = 'openid_owner';

/* ---------------------------- 极简内存 DB ---------------------------- */
let seq = 0;
function makeDb() {
  const colls = new Map();
  function coll(name) { if (!colls.has(name)) colls.set(name, []); return colls.get(name); }
  const clone = v => JSON.parse(JSON.stringify(v));
  const match = (doc, q) => Object.keys(q).every(k => doc[k] === q[k]);

  return {
    _colls: colls,
    createCollection(name) { coll(name); return Promise.resolve({}); },
    collection(name) {
      return {
        where(q) {
          const chain = { _q: q || {}, _limit: 1e9, _order: null };
          chain.limit = n => { chain._limit = n; return chain; };
          chain.orderBy = (f, dir) => { chain._order = { f, dir }; return chain; };
          chain.get = () => {
            let rows = coll(name).filter(d => match(d, chain._q));
            if (chain._order) {
              const { f, dir } = chain._order;
              rows = rows.slice().sort((a, b) => dir === 'desc' ? (b[f] || 0) - (a[f] || 0) : (a[f] || 0) - (b[f] || 0));
            }
            return Promise.resolve({ data: rows.slice(0, chain._limit).map(clone) });
          };
          return chain;
        },
        add(obj) {
          const d = Object.assign({ _id: 'id_' + (++seq) }, clone(obj));
          coll(name).push(d);
          return Promise.resolve({ id: d._id });
        },
        doc(id) {
          return {
            update(patch) {
              const d = coll(name).find(x => x._id === id);
              if (!d) return Promise.reject(new Error('doc not found'));
              Object.assign(d, clone(patch));
              return Promise.resolve({ updated: 1 });
            }
          };
        }
      };
    }
  };
}

let db;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@cloudbase/node-sdk') return { init: () => ({ database: () => db }) };
  return origLoad.apply(this, arguments);
};

function loadSync(seed) {
  db = makeDb();
  Object.keys(seed || {}).forEach(name => {
    (seed[name] || []).forEach(d => db.collection(name).add(d));
  });
  delete require.cache[require.resolve(SYNC_PATH)];
  return require(SYNC_PATH);
}

/* ------------------------------ 断言 ------------------------------ */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(n) { console.log('\n' + n); }

const FAMILY = (current) => [{
  _openid: OID,
  data: { users: [{ id: 'c1', nickname: '老大' }, { id: 'c2', nickname: '老二' }], currentUserId: current }
}];

function examDocs() {
  return [
    { openid: OID, clientId: 'ex_c1', name: '老大的卷', subject: 'math', childId: 'c1', createdAt: 400 },
    { openid: OID, clientId: 'ex_c2', name: '老二的卷', subject: 'math', childId: 'c2', createdAt: 300 },
    { openid: OID, clientId: 'ex_lib', name: '工作台库卷', subject: 'math', createdAt: 200 },
    { openid: OID, clientId: 'ex_c1_cn', name: '老大语文卷', subject: 'chinese', childId: 'c1', createdAt: 100 },
    { openid: 'openid_other', clientId: 'ex_other', name: '别人家的卷', subject: 'math', createdAt: 500 }
  ];
}

function ids(res) { return (res.exams || []).map(e => e.resourceId).sort().join(','); }

(async () => {
  /* ---------- 一、列表：按当前孩子过滤 ---------- */
  group('一、exams：按当前孩子过滤（无归属卷保留）');
  {
    const sync = loadSync({ exam_resources: examDocs(), hw_farm_user: FAMILY('c1') });
    const cur = await sync.main({ action: 'exams', userInfo: { openId: OID } });
    ok(cur.ok === true, 'exams 返回 ok');
    ok(ids(cur) === 'ex_c1,ex_c1_cn,ex_lib', '当前 c1：只回 c1 的卷 + 无归属卷 + 不串到别人 openid', ids(cur));
    ok(!(cur.exams || []).some(e => e.resourceId === 'ex_c2'), '老二的卷不出现');
    ok(!(cur.exams || []).some(e => e.resourceId === 'ex_other'), '别的 openid 的卷不出现');

    const req = await sync.main({ action: 'exams', userInfo: { openId: OID }, childId: 'c2' });
    ok(ids(req) === 'ex_c2,ex_lib', '显式 childId=c2：回 c2 的卷 + 无归属卷', ids(req));

    const bad = await sync.main({ action: 'exams', userInfo: { openId: OID }, childId: 'c9' });
    ok(ids(bad) === 'ex_c1,ex_c1_cn,ex_lib', '跨家庭 childId=c9 不被采纳 → 回落当前孩子 c1（过滤不被关掉）', ids(bad));

    const sub = await sync.main({ action: 'exams', userInfo: { openId: OID }, subject: 'chinese' });
    ok(ids(sub) === 'ex_c1_cn', '学科筛选仍生效（且叠在孩子过滤之上）', ids(sub));
  }

  /* ---------- 二、无档案 / 占位切片：不过滤 ---------- */
  group('二、解析不出孩子时不过滤（不猜也不藏）');
  {
    const noRoot = loadSync({ exam_resources: examDocs() });
    const r1 = await noRoot.main({ action: 'exams', userInfo: { openId: OID } });
    ok(ids(r1) === 'ex_c1,ex_c1_cn,ex_c2,ex_lib', '未建档（无 hw_farm_user）→ 回全部本 openid 的卷', ids(r1));

    const placeholder = loadSync({
      exam_resources: examDocs(),
      hw_farm_user: [{ _openid: OID, data: { users: [{ id: 'guest', __placeholder: true }], currentUserId: 'guest' } }]
    });
    const r2 = await placeholder.main({ action: 'exams', userInfo: { openId: OID } });
    ok(ids(r2) === 'ex_c1,ex_c1_cn,ex_c2,ex_lib', '占位切片（未创建孩子）→ 不过滤，也不把数据挂到 guest', ids(r2));
  }

  /* ---------- 三、详情：同样过闸 ---------- */
  group('三、exam 详情：别人的孩子的卷不暴露');
  {
    const sync = loadSync({ exam_resources: examDocs(), hw_farm_user: FAMILY('c1') });

    const own = await sync.main({ action: 'exam', userInfo: { openId: OID }, resourceId: 'ex_c1' });
    ok(own.ok === true && own.exam && own.exam.resourceId === 'ex_c1', '自己的卷可读');

    const lib = await sync.main({ action: 'exam', userInfo: { openId: OID }, resourceId: 'ex_lib' });
    ok(lib.ok === true, '无归属的历史/库卷可读（无法判定归属时不藏）');

    const other = await sync.main({ action: 'exam', userInfo: { openId: OID }, resourceId: 'ex_c2', childId: 'c1' });
    ok(other.ok === false && other.code === 'not_found', '老二的卷按 not_found 处理（不暴露存在性）', JSON.stringify(other));

    const viaReq = await sync.main({ action: 'exam', userInfo: { openId: OID }, resourceId: 'ex_c2', childId: 'c2' });
    ok(viaReq.ok === true, '显式切到 c2 后可读 c2 的卷');

    const cross = await sync.main({ action: 'exam', userInfo: { openId: OID }, resourceId: 'ex_other' });
    ok(cross.ok === false && cross.code === 'not_found', '别的 openid 的卷仍不可读（原有隔离不变）');

    const noRoot = loadSync({ exam_resources: examDocs() });
    const noScope = await noRoot.main({ action: 'exam', userInfo: { openId: OID }, resourceId: 'ex_c2' });
    ok(noScope.ok === true, '无档案时不做归属判定（与列表口径一致）');
  }

  /* ---------- 四、端上：单孩子模型，不再传 childId ---------- */
  group('四、小程序端：不再传 childId（服务端按当前孩子解析）');
  {
    const src = fs.readFileSync(GALLERY, 'utf8');
    ok(!/childId\s*:/.test(src), 'examGallery 不向云端传 childId');
    ok(/action:\s*'exams',\s*subject:/.test(src), '列表仍带 subject（筛选行为不变）');
    ok(/action:\s*'exam',\s*resourceId:\s*rid/.test(src), '详情仍带 resourceId');
    ok(!/require\([^)]*store\.js/.test(src), '不再依赖 store 取孩子（端上无孩子概念）');
  }

  /* ------------------------------ 反证 ------------------------------ */
  if (!CHILD_MODE) {
    group('五、反证：拆掉闸门，断言必须变红');
    const SRC = fs.readFileSync(SYNC_PATH, 'utf8');
    const MUTANTS = [
      {
        name: '列表的孩子过滤被拆',
        from: '  if (childId) docs = docs.filter(d => !d.childId || d.childId === childId);',
        to: '  if (false) docs = docs.filter(d => !d.childId || d.childId === childId);'
      },
      {
        name: '详情的孩子闸被拆',
        from: '  if (childId && d.childId && d.childId !== childId) {',
        to: '  if (false && d.childId && d.childId !== childId) {'
      },
      {
        name: '跨家庭 childId 被当成「不过滤」',
        from: "  if (kid.source === 'invalid') kid = G.resolveChildId(root, '');",
        to: "  if (kid.source === 'invalid') return '';"
      }
    ];
    for (const m of MUTANTS) {
      if (SRC.indexOf(m.from) < 0) { ok(false, '反证定位失败：' + m.name); continue; }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'examsync-'));
      fs.cpSync(path.dirname(SYNC_PATH), tmp, { recursive: true });
      const target = path.join(tmp, 'index.js');
      fs.writeFileSync(target, SRC.replace(m.from, m.to), 'utf8');
      const run = spawnSync(process.execPath, [__filename], {
        env: Object.assign({}, process.env, { SYNC_PATH: target, EXAM_SYNC_CHILD: m.name }),
        encoding: 'utf8'
      });
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      const out = (run.stdout || '') + (run.stderr || '');
      ok(run.status !== 0, '「' + m.name + '」→ 测试变红 · exit=' + run.status);
      ok(/✗/.test(out), '「' + m.name + '」失败断言可见');
    }
  }

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n挂具异常:', e); process.exit(2); });

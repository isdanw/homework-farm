#!/usr/bin/env node
/**
 * test-migrate-child-scope.cjs —— webAdminWrite 的 childId 历史数据迁移（P0-8 服务端半边）
 *
 * 【锁住的契约】
 *   · 默认 dry-run：不传 confirm 只出报告，**一个字都不写**（含审计集合）；
 *   · 只有「恰好 1 个真实孩子」的家庭才自动归属，且仍须 confirm:true；
 *   · 多孩家庭一律判 ambiguous、不动数据；家长逐行给的 assignments 才生效；
 *   · 跨家庭 childId / 占位切片 → 冲突或 no_children，绝不猜；
 *   · 已有 childId 的行不动（幂等，可反复跑）；
 *   · 每次 confirm 运行写一条 tutor_migrations 审计；
 *   · per-user 绑定令牌可以确认自己家的迁移，但碰不到别人家。
 *
 * 反证：把「单孩才自动归属」改掉 / 把 confirm 闸拆掉，本文件必须变红。
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = process.env.MIG_SRC || path.join(ROOT, 'cloudfunctions/webAdminWrite/index.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const CHILD_MODE = process.env.MIG_CHILD || '';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(n) { console.log('\n' + n); }

/* ---------------- 假云端（支持 where / skip / limit / orderBy / doc.update / add） ---------------- */
const clone = v => JSON.parse(JSON.stringify(v));
function makeDb() {
  const colls = new Map();
  const coll = (name) => { if (!colls.has(name)) colls.set(name, []); return colls.get(name); };
  function match(doc, q) {
    return Object.keys(q).every(k => {
      const dv = doc[k];
      const v = q[k];
      if (v && typeof v === 'object') return JSON.stringify(dv) === JSON.stringify(v);
      return dv === v;
    });
  }
  function chain(name, q) {
    const c = { _q: q || {}, _limit: 1e9, _skip: 0, _order: null };
    c.limit = (n) => { c._limit = n; return c; };
    c.skip = (n) => { c._skip = n; return c; };
    c.orderBy = (field, dir) => { c._order = { field: field, dir: dir }; return c; };
    c.get = () => {
      let list = coll(name).filter(d => match(d, c._q));
      if (c._order) {
        const f = c._order.field, sign = c._order.dir === 'desc' ? -1 : 1;
        list = list.slice().sort((a, b) => ((a[f] || 0) - (b[f] || 0)) * sign);
      }
      return Promise.resolve({ data: list.slice(c._skip, c._skip + c._limit).map(clone) });
    };
    c.update = (patch) => {
      let n = 0;
      coll(name).forEach(d => { if (match(d, c._q)) { Object.assign(d, clone(patch)); n++; } });
      return Promise.resolve({ updated: n });
    };
    return c;
  }
  return {
    _colls: colls,
    createCollection: (n) => { coll(n); return Promise.resolve({}); },
    collection: (name) => ({
      where: (q) => chain(name, q),
      limit: (n) => chain(name).limit(n),
      skip: (n) => chain(name).skip(n),
      orderBy: (f, d) => chain(name).orderBy(f, d),
      get: () => chain(name).get(),
      add: (obj) => {
        const d = Object.assign({ _id: 'id_' + (coll(name).length + 1) + '_' + Math.random().toString(36).slice(2, 7) }, clone(obj));
        coll(name).push(d);
        return Promise.resolve({ id: d._id });
      },
      doc: (id) => ({
        update: (patch) => {
          const d = coll(name).find(x => x._id === id);
          if (!d) return Promise.reject(new Error('doc not found'));
          Object.assign(d, clone(patch));
          return Promise.resolve({ updated: 1 });
        },
        remove: () => Promise.resolve({ removed: 0 })
      })
    })
  };
}

let mockDb = null;
/* 家长口令会话（迁移确认是家长动作）：只模拟 parentAuth.status 的分支 */
let parentSessions = {};
function fakeCallFunction(opts) {
  const name = opts && opts.name;
  const data = (opts && opts.data) || {};
  if (name !== 'parentAuth') return Promise.resolve({ result: { ok: false, code: 'unexpected_fn' } });
  if (data.action !== 'status') return Promise.resolve({ result: { ok: false, code: 'bad_action' } });
  if (!data.webToken) return Promise.resolve({ result: { ok: false, code: 'web_token_invalid', msg: '缺少网页口令' } });
  const s = parentSessions[String(data.sessionToken || '')];
  const active = !!(s && s.active && Number(s.expiresAt) > Date.now());
  return Promise.resolve({ result: {
    ok: true, hasPin: true, scopes: [],
    session: active ? { active: true, expiresAt: Number(s.expiresAt) } : { active: false, code: 'session_invalid' }
  } });
}
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@cloudbase/node-sdk') {
    return { init: () => ({ database: () => mockDb, callFunction: fakeCallFunction, ai: () => { throw new Error('no ai in test'); } }) };
  }
  return origLoad.apply(this, arguments);
};

process.env.WEB_DASHBOARD_TOKEN = 'test-admin-token';
process.env.WEB_ADMIN_ALLOW_WRITE = '1';

function load() {
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf('cloudfunctions/webAdminWrite') >= 0) delete require.cache[k];
  }
  return require(SRC_PATH);
}
function rows(db, name) { return db._colls.get(name) || []; }
function seed(db, name, doc) { db.collection(name).add(doc); }
function seedFamily(db, openid, users, currentUserId) {
  seed(db, 'hw_farm_user', { _openid: openid, data: { currentUserId: currentUserId, users: users } });
}
const ADMIN = { token: 'test-admin-token', action: 'migrateChildScope' };

/* ---------------- 多孩家庭：不得自动归属 ---------------- */
async function multiChildChecks(fn) {
  group('二、多孩家庭：没有唯一答案 → ambiguous，一行都不动');
  const db = makeDb();
  seedFamily(db, 'o_multi', [{ id: 'c1' }, { id: 'c2' }], 'c2');
  seed(db, 'hw_checkin_log', { _openid: 'o_multi', _id: 'log_a', date: '2026-10-01' });
  seed(db, 'hw_checkin_log', { _openid: 'o_multi', _id: 'log_b', date: '2026-10-02' });
  mockDb = db;
  const r = await fn.main(Object.assign({}, ADMIN, { openid: 'o_multi', confirm: true }));
  ok(r && r.ok === true, '迁移调用成功');
  ok(r.autoChildId === '', '多孩家庭 autoChildId 为空（不取 users[0]）');
  ok(r.pending === 2 && r.updated === 0, 'pending=2 / updated=0');
  ok(r.ambiguous === 2, '两行都计入 ambiguous');
  ok(r.samples.length === 2, '返回待确认样本（家长确认页用）');
  ok(rows(db, 'hw_checkin_log').every(x => x.childId === undefined), '两行都没被写入 childId');
  ok(rows(db, 'tutor_migrations').length === 1, '仍写一条审计（记录「确认过但无唯一答案」）');
}

async function dryRunCheck(fn) {
  group('一、单孩家庭 dry-run：报告齐全，一个字都不写');
  const db = makeDb();
  seedFamily(db, 'o_single', [{ id: 'c1' }], 'c1');
  seed(db, 'hw_checkin_log', { _openid: 'o_single', _id: 'log_1', date: '2026-10-01' });
  seed(db, 'hw_checkin_log', { _openid: 'o_single', _id: 'log_2', date: '2026-10-02' });
  seed(db, 'hw_checkin_log', { _openid: 'o_single', _id: 'log_done', date: '2026-10-03', childId: 'c1' });
  seed(db, 'hw_farm_settle', { _openid: 'o_single', _id: 'st_1', date: '2026-10-01' });
  mockDb = db;
  const r = await fn.main(Object.assign({}, ADMIN, { openid: 'o_single' }));
  ok(r && r.ok === true && r.dryRun === true, '默认 dry-run（confirm 未传）');
  ok(r.autoChildId === 'c1', '单孩家庭 autoChildId=c1');
  ok(r.pending === 3 && r.updated === 0, 'pending=3 / updated=0');
  ok(r.scopes.find(s => s.coll === 'hw_checkin_log').plan === 2, 'hw_checkin_log 计划更新 2 行（已有 childId 的不算）');
  ok(r.scopes.find(s => s.coll === 'hw_farm_settle').plan === 1, 'hw_farm_settle 计划更新 1 行');
  ok(rows(db, 'hw_checkin_log').every(x => x.childId === undefined || x.childId === 'c1'), 'dry-run 没有写入任何 childId');
  ok(rows(db, 'hw_farm_settle')[0].childId === undefined, 'settle 行未被改动');
  ok(rows(db, 'tutor_migrations').length === 0, 'dry-run 不写审计（零副作用）');
}

(async function main() {
  console.log('webAdminWrite childId 历史数据迁移测试' + (CHILD_MODE ? '（变异体：' + CHILD_MODE + '）' : ''));
  const fn = load();

  if (CHILD_MODE === 'multi') { await multiChildChecks(fn); return finish(); }
  if (CHILD_MODE === 'dryrun') { await dryRunCheck(fn); return finish(); }

  await dryRunCheck(fn);

  await multiChildChecks(fn);

  group('  └ 家长逐行指定 assignments 才生效；跨家庭一律拒绝');
  {
    const db = makeDb();
    seedFamily(db, 'o_multi', [{ id: 'c1' }, { id: 'c2' }], 'c2');
    seed(db, 'hw_checkin_log', { _openid: 'o_multi', _id: 'log_a', date: '2026-10-01' });
    seed(db, 'hw_checkin_log', { _openid: 'o_multi', _id: 'log_b', date: '2026-10-02' });
    mockDb = db;
    const r = await fn.main(Object.assign({}, ADMIN, {
      openid: 'o_multi', confirm: true,
      assignments: { 'hw_checkin_log:log_a': 'c1', 'hw_checkin_log:log_b': 'c9' }
    }));
    const byId = {};
    rows(db, 'hw_checkin_log').forEach(x => { byId[x._id] = x; });
    ok(byId.log_a.childId === 'c1', '指定过的行按家长答案写入 c1');
    ok(byId.log_b.childId === undefined, '跨家庭 childId=c9 被拒绝，行保持未归属');
    ok((r.conflicts || []).some(c => c.key === 'hw_checkin_log:log_b' && c.reason === 'child_not_in_family'),
      '冲突表点名被拒的 key');
    ok(r.updated === 1 && r.ambiguous === 1, 'updated=1 / ambiguous=1');
  }

  group('三、confirm 后：单孩家庭补齐归属 + 审计 + 幂等');
  {
    const db = makeDb();
    seedFamily(db, 'o_single', [{ id: 'c1' }], 'c1');
    seed(db, 'hw_checkin_log', { _openid: 'o_single', _id: 'log_1', date: '2026-10-01' });
    seed(db, 'hw_checkin_log', { _openid: 'o_single', _id: 'log_2', date: '2026-10-02' });
    seed(db, 'hw_farm_settle', { _openid: 'o_single', _id: 'st_1', date: '2026-10-01' });
    seed(db, 'hw_checkin_log', { _openid: 'o_other', _id: 'log_x', date: '2026-10-01' });
    mockDb = db;
    const r = await fn.main(Object.assign({}, ADMIN, { openid: 'o_single', confirm: true }));
    ok(r && r.ok === true && r.dryRun === false, 'confirm:true → 真写');
    ok(r.updated === 3 && r.pending === 3, 'updated=3 / pending=3');
    ok(rows(db, 'hw_checkin_log').filter(x => x._openid === 'o_single').every(x => x.childId === 'c1'),
      '本家两行都写成 c1');
    ok(rows(db, 'hw_farm_settle')[0].childId === 'c1', 'settle 行写成 c1');
    ok(rows(db, 'hw_checkin_log').find(x => x._id === 'log_x').childId === undefined, '别人家的行完全没被碰');
    const audits = rows(db, 'tutor_migrations');
    ok(audits.length === 1, '写了一条审计');
    ok(audits[0] && audits[0].openid === 'o_single' && audits[0].updated === 3 && audits[0].autoChildId === 'c1',
      '审计含账号、更新数、归属孩子');

    const r2 = await fn.main(Object.assign({}, ADMIN, { openid: 'o_single', confirm: true }));
    ok(r2.updated === 0 && r2.pending === 0, '再跑一次：pending/updated 都为 0（幂等）');
  }

  group('四、没有真实孩子 → 拒绝（占位切片不算孩子）');
  {
    const db = makeDb();
    seedFamily(db, 'o_guest', [{ id: 'guest', __placeholder: true }], 'guest');
    seed(db, 'hw_checkin_log', { _openid: 'o_guest', _id: 'log_g', date: '2026-10-01' });
    mockDb = db;
    const r = await fn.main(Object.assign({}, ADMIN, { openid: 'o_guest', confirm: true }));
    ok(r && r.ok === false && r.code === 'no_children', 'code=no_children', JSON.stringify(r));
    ok(rows(db, 'hw_checkin_log')[0].childId === undefined, '没有写入');
    ok(rows(db, 'tutor_migrations').length === 0, '没有审计');
  }

  group('五、per-user 绑定令牌：确认写入必须带家长口令会话');
  {
    const db = makeDb();
    seedFamily(db, 'o_bind', [{ id: 'b1' }], 'b1');
    seedFamily(db, 'o_other', [{ id: 'x1' }], 'x1');
    seed(db, 'web_portal_bindings', { token: 'parent-token', openid: 'o_bind', revoked: false });
    seed(db, 'hw_checkin_log', { _openid: 'o_bind', _id: 'log_b1', date: '2026-10-01' });
    seed(db, 'hw_checkin_log', { _openid: 'o_other', _id: 'log_x1', date: '2026-10-01' });
    mockDb = db;
    parentSessions = {};

    const r0 = await fn.main({ token: 'parent-token', action: 'migrateChildScope', confirm: true });
    ok(r0 && r0.ok === false && r0.code === 'need_parent_pin', '缺家长口令 → need_parent_pin', JSON.stringify(r0));
    ok(rows(db, 'hw_checkin_log').find(x => x._id === 'log_b1').childId === undefined, '被拦下时一行都没写');
    ok(rows(db, 'tutor_migrations').length === 0, '被拦下时不产生审计记录');

    parentSessions['ps_expired'] = { active: false, expiresAt: Date.now() - 1000 };
    const r1 = await fn.main({ token: 'parent-token', action: 'migrateChildScope', confirm: true, parentSessionToken: 'ps_expired' });
    ok(r1 && r1.ok === false && r1.code === 'parent_session_invalid', '失效家长会话 → parent_session_invalid', JSON.stringify(r1));
    ok(rows(db, 'hw_checkin_log').find(x => x._id === 'log_b1').childId === undefined, '失效会话同样不写');

    parentSessions['ps_good'] = { active: true, expiresAt: Date.now() + 3600 * 1000 };
    const r2 = await fn.main({ token: 'parent-token', action: 'migrateChildScope', confirm: true, parentSessionToken: 'ps_good' });
    ok(r2 && r2.ok === true && r2.updated === 1, '家长口令会话有效 → 完成自己家的迁移', JSON.stringify(r2));
    ok(rows(db, 'hw_checkin_log').find(x => x._id === 'log_b1').childId === 'b1', '自己家行写成 b1');
    ok(rows(db, 'hw_checkin_log').find(x => x._id === 'log_x1').childId === undefined, '别人家行未被触碰');

    // dry-run 不需要家长口令（只读报告），否则家长没法先看再决定
    const r3 = await fn.main({ token: 'parent-token', action: 'migrateChildScope' });
    ok(r3 && r3.ok === true && r3.dryRun === true, 'dry-run 只读，不需要家长口令');
  }

  group('六、反证：拆掉安全闸，断言必须变红');
  {
    const MUTANTS = [
      {
        name: '多孩自动归属 users[0]',
        from: 'autoChildId: kids.length === 1 ? kids[0] : \'\'',
        to: 'autoChildId: kids[0] || \'\'',
        mode: 'multi'
      },
      {
        name: 'confirm 闸被拆（默认即真写）',
        from: 'const dryRun = req.confirm !== true;',
        to: 'const dryRun = false;',
        mode: 'dryrun'
      },
      {
        name: '家长口令闸被拆（per-user confirm 免验证）',
        from: 'if (event.confirm === true && !adminCall) {',
        to: 'if (false) {',
        mode: 'nogate'
      }
    ];
    for (const m of MUTANTS) {
      if (SRC.indexOf(m.from) < 0) { ok(false, '反证定位失败：' + m.name); continue; }
      const mutantPath = path.join(path.dirname(SRC_PATH), '.mutant-webadminwrite-migrate.test.js');
      fs.writeFileSync(mutantPath, SRC.replace(m.from, m.to), 'utf8');
      const run = spawnSync(process.execPath, [__filename], {
        env: Object.assign({}, process.env, { MIG_SRC: mutantPath, MIG_CHILD: m.mode }),
        encoding: 'utf8'
      });
      try { fs.unlinkSync(mutantPath); } catch (e) {}
      const out = (run.stdout || '') + (run.stderr || '');
      ok(run.status !== 0, '「' + m.name + '」→ 测试变红 · exit=' + run.status);
      ok(/✗/.test(out), '「' + m.name + '」失败断言可见');
    }
  }

  finish();
})().catch(e => { console.error('测试自身异常：', e); process.exit(1); });

function finish() {
  console.log('\n' + (fail === 0
    ? '通过 ' + pass + ' 项，失败 0 项\n✅ childId 迁移契约全通过（不猜、不写、可审计、幂等）'
    : '通过 ' + pass + ' 项，失败 ' + fail + ' 项\n❌ childId 迁移契约被破坏'));
  process.exit(fail === 0 ? 0 : 1);
}

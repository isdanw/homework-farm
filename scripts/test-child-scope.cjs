#!/usr/bin/env node
/**
 * test-child-scope.cjs —— 「切孩子即切视图」端上 + 试卷库双维度回归
 * ---------------------------------------------------------------------------
 * 用户定案（2026-10-29）：多孩不做「全家合并视图」，而是**切换孩子 = 切换视图**：
 *   · 写：导学数据（会话/错题/证据/复习窗口/复习卡/必会库）新条目一律盖当前孩子；
 *   · 读：只返回当前孩子的条目，切孩子后立刻看不到别人的；
 *   · 历史：无 childId / 落在占位 'guest' 的老条目补归属到第一个真实孩子
 *     （不补则切到任何孩子都看不见 = 静默丢数据）；
 *   · 云端合并：服务端解析的 childId 是权威，与本地不同就采纳云端；
 *   · 补推：队列里不同孩子的条目按 childId 分组各推一次（否则旧队列会被记到新孩子头上）；
 *   · 试卷库：examService 保存时盖章、listExams 按解析出的孩子过滤（历史卷不藏）。
 *
 *     node scripts/test-child-scope.cjs
 *
 * 反证（三处拆掉任一处，本文件必须变红）：
 *   · 拆读取过滤   → 「B 切孩子」断言变红
 *   · 拆历史盖章   → 「C 历史」断言变红
 *   · 拆 listExams 过滤 → 「F 试卷库」断言变红
 * 反证由本文件自动执行（子进程跑变异副本），无需手工。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_SRC = path.join(REPO, 'miniprogram', 'utils');
const SRC_DIR = process.env.TUTOR_SRC_DIR ? path.resolve(process.env.TUTOR_SRC_DIR) : DEFAULT_SRC;
const EXAM_PATH = process.env.EXAM_SRC
  ? path.resolve(process.env.EXAM_SRC)
  : path.join(REPO, 'cloudfunctions', 'examService', 'index.js');
const IS_MUTANT = !!process.env.TUTOR_SRC_DIR || !!process.env.EXAM_SRC;

const STORE_PATH = path.join(SRC_DIR, 'store.js');
const TUTOR_PATH = path.join(SRC_DIR, 'tutorStore.js');
const OPENID_KEY = 'wb_hwfarm_openid';
const ROOT_KEY = 'wb_hwfarm_data_v2';
const TUTOR_KEY = 'wb_hwfarm_tutor_v1';
const OID = 'o_parent';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
function group(t) { console.log('\n' + t); }

/* ------------------------------ 挂具 ------------------------------ */
let storage, pushes;
let timers = [];
global.setTimeout = function (fn, ms) { timers.push({ fn, ms }); return timers.length; };
global.clearTimeout = function () {};

function resetEnv() {
  timers = [];
  storage = new Map();
  pushes = [];
  global.wx = {
    getStorageSync(k) { return storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : ''; },
    setStorageSync(k, v) { storage.set(k, JSON.parse(JSON.stringify(v))); },
    removeStorageSync(k) { storage.delete(k); },
    getStorageInfoSync() { return { keys: Array.from(storage.keys()) }; },
    showToast() {},
    cloud: {
      callFunction({ name, data }) {
        if (name === 'syncData' && data && data.action === 'whoami') return Promise.resolve({ result: { ok: true, openid: OID } });
        if (name === 'tutorSync' && data && data.action === 'push') {
          pushes.push(JSON.parse(JSON.stringify(data)));
          return Promise.resolve({ result: { ok: true, added: 1, skipped: 0, updated: 0 } });
        }
        return Promise.resolve({ result: { ok: true } });
      }
    }
  };
  global.getApp = () => ({ globalData: {} });
  delete require.cache[require.resolve(STORE_PATH)];
  delete require.cache[require.resolve(TUTOR_PATH)];
}

/** 两孩家庭：c1 老大 / c2 老二 */
function seedFamily(currentId) {
  storage.set(OPENID_KEY, OID);
  storage.set(ROOT_KEY + '_' + OID, {
    version: 2,
    users: [{ id: 'c1', nickname: '老大' }, { id: 'c2', nickname: '老二' }],
    currentUserId: currentId || 'c1'
  });
}
function seedTutor(data) { storage.set(TUTOR_KEY + '_' + OID, data); }
function rawTutor() { return storage.get(TUTOR_KEY + '_' + OID) || {}; }

async function boot() {
  const s = require(STORE_PATH);
  s.setCloudReady(false);
  await s.initAccount();
  return { store: s, ts: require(TUTOR_PATH) };
}

/* ------------------------------ 用例 ------------------------------ */
async function groupA_writeStamps() {
  group('A 写入盖章：新条目一律带当前孩子 childId');
  resetEnv(); seedFamily('c1');
  const { ts } = await boot();
  ts.addMistake({ id: 'mk_a1', subject: 'math', topic: '退位减法' });
  ts.newSession('math', '数学');
  ts.addEvidence({ id: 'ev_a1', subject: 'math', topic: '退位减法', total: 5, correct: 5, passed: true });
  ts.upsertCard({ id: 'cd_a1', subject: 'math', topic: '退位减法' });
  ts.upsertUnitKp({ id: 'uk_a1', subject: 'math', title: '第一单元', points: [{ id: 'p1', topic: '退位减法' }] });
  ts.upsertReview({ id: 'rv_a1', mistakeId: 'mk_a1', subject: 'math' });
  const raw = rawTutor();
  const id = k => (raw[k] || [])[0] && raw[k][0].childId;
  ok(id('mistakes') === 'c1', '错题盖 childId=c1', id('mistakes'));
  ok(id('sessions') === 'c1', '会话盖 childId=c1', id('sessions'));
  ok(id('evidence') === 'c1', '证据盖 childId=c1', id('evidence'));
  ok(id('cards') === 'c1', '复习卡盖 childId=c1', id('cards'));
  ok(id('unitKps') === 'c1', '必会库盖 childId=c1', id('unitKps'));
  ok(id('reviews') === 'c1', '复习窗口盖 childId=c1', id('reviews'));
}

async function groupB_switchView() {
  group('B 切孩子：读侧只回当前孩子，原始数据一条不丢');
  resetEnv(); seedFamily('c1');
  const { store, ts } = await boot();
  ts.addMistake({ id: 'mk_c1', subject: 'math', topic: 'c1 的题' });
  ts.upsertCard({ id: 'cd_c1', subject: 'math', topic: 'c1 的卡' });
  ts.upsertReview({ id: 'rv_c1', mistakeId: 'mk_c1', subject: 'math' });
  ok(ts.getMistakes().length === 1, 'c1 视图有 1 条错题');

  store.setCurrentUser('c2');
  ok(ts.getMistakes().length === 0, '切到 c2：看不到 c1 的错题', ts.getMistakes().length);
  ok(ts.getCards().length === 0, '切到 c2：看不到 c1 的复习卡', ts.getCards().length);
  ok(ts.getReviews().length === 0, '切到 c2：看不到 c1 的复习窗口', ts.getReviews().length);
  ts.addMistake({ id: 'mk_c2', subject: 'math', topic: 'c2 的题' });
  ok(ts.getMistakes().length === 1 && ts.getMistakes()[0].topic === 'c2 的题', 'c2 只看到自己的 1 条');

  store.setCurrentUser('c1');
  ok(ts.getMistakes().length === 1 && ts.getMistakes()[0].topic === 'c1 的题', '切回 c1 只看到 c1 的那条');
  ok((rawTutor().mistakes || []).length === 2, '两个孩子的错题都在本地（切视图不删数据）', (rawTutor().mistakes || []).length);

  // 跨孩子不能互相推进：c2 那边用 c1 的 mistakeId 推不动复习窗口
  store.setCurrentUser('c2');
  ok(ts.advanceReview('mk_c1', true) === null, 'c2 推不动 c1 的复习窗口');
  ok(ts.setMistakeStatus('mk_c1', 'corrected') === false, 'c2 改不了 c1 的错题状态');
}

async function groupC_legacy() {
  group('C 历史条目：无 childId / 占位 guest → 补归属第一个真实孩子');
  resetEnv(); seedFamily('c1');
  seedTutor({
    sessions: [{ id: 'ts_old', subject: 'math', messages: [], createdAt: 1, closed: true }],
    mistakes: [{ id: 'mk_old', subject: 'math', topic: '老错题', createdAt: 1 }],
    evidence: [],
    reviews: [{ id: 'rv_old', mistakeId: 'mk_old', subject: 'math', stage: 1, dueAt: 1, updatedAt: 1 }],
    cards: [{ id: 'cd_old', subject: 'math', topic: '老卡', childId: 'guest', box: 1, dueAt: 1, updatedAt: 1 }],
    unitKps: [], orders: [], removed: [], pushQueue: []
  });
  const { store, ts } = await boot();
  ok(ts.getMistakes().length === 1, '漏 childId 的老错题在当前孩子可见（补归属，不是丢弃）');
  ok((rawTutor().mistakes[0] || {}).childId === 'c1', '老错题补成 c1', (rawTutor().mistakes[0] || {}).childId);
  ok((rawTutor().cards[0] || {}).childId === 'c1', 'childId=guest 的老卡片补成 c1', (rawTutor().cards[0] || {}).childId);
  ok((rawTutor().reviews[0] || {}).childId === 'c1', '老复习窗口补成 c1', (rawTutor().reviews[0] || {}).childId);
  ok((rawTutor().sessions[0] || {}).childId === 'c1', '老会话补成 c1', (rawTutor().sessions[0] || {}).childId);

  store.setCurrentUser('c2');
  ok(ts.getMistakes().length === 0, '切到 c2 看不到补到 c1 的老数据');
  ok((rawTutor().mistakes || []).length === 1, '老数据仍在本地（未删除）');
}

async function groupD_cloudAdopts() {
  group('D 云端合并：服务端解析的 childId 是权威归属');
  resetEnv(); seedFamily('c1');
  seedTutor({
    sessions: [], evidence: [], reviews: [], cards: [], unitKps: [], orders: [], removed: [], pushQueue: [],
    mistakes: [
      { id: 'mk_x', subject: 'math', topic: '云端说是 c2 的', childId: 'c1', createdAt: 1 },
      { id: 'mk_y', subject: 'math', topic: '云端没归属', childId: 'c1', createdAt: 2 }
    ]
  });
  const { store, ts } = await boot();
  ts.mergeFromCloud({
    sessions: [], evidence: [], reviews: [], cards: [], unitKps: [], orders: [],
    mistakes: [
      { id: 'mk_x', clientId: 'mk_x', subject: 'math', topic: '云端说是 c2 的', childId: 'c2', createdAt: 1 },
      { id: 'mk_y', clientId: 'mk_y', subject: 'math', topic: '云端没归属', createdAt: 2 }
    ]
  });
  const mk = id => rawTutor().mistakes.find(m => m.id === id) || {};
  ok(mk('mk_x').childId === 'c2', '本地 c1 / 云端 c2 → 采纳云端的 c2', mk('mk_x').childId);
  ok(mk('mk_y').childId === 'c1', '云端没给 childId → 不清掉本地已有归属', mk('mk_y').childId);
  ok(ts.getMistakes().map(m => m.id).join(',') === 'mk_y', '当前 c1 视图只剩 mk_y（mk_x 已归 c2）');
  store.setCurrentUser('c2');
  ok(ts.getMistakes().map(m => m.id).join(',') === 'mk_x', '切到 c2 看到 mk_x');
}

async function groupE_push() {
  group('E 补推：队列按 childId 分组，不带错孩子的归属');
  resetEnv(); seedFamily('c1');
  const { store, ts } = await boot();
  ts.addMistake({ id: 'mk_p1', subject: 'math', topic: 'c1 待推' });
  store.setCurrentUser('c2');
  ts.addMistake({ id: 'mk_p2', subject: 'math', topic: 'c2 待推' });
  ok((rawTutor().pushQueue || []).length === 2, '两条错题都登记进补推队列', (rawTutor().pushQueue || []).length);

  await ts.pushQueued();
  ok(pushes.length === 2, '两个孩子各推一次（不是合并成一次）', pushes.length);
  const byChild = {};
  pushes.forEach(p => { byChild[p.childId || ''] = p; });
  ok(!!byChild.c1 && !!byChild.c2, '两次推送分别带 childId=c1 / c2', Object.keys(byChild).join(','));
  ok((byChild.c1.mistakes || []).length === 1 && byChild.c1.mistakes[0].clientId === 'mk_p1', 'c1 那批只含 c1 的条目');
  ok((byChild.c2.mistakes || []).length === 1 && byChild.c2.mistakes[0].clientId === 'mk_p2', 'c2 那批只含 c2 的条目');
  ok((rawTutor().pushQueue || []).length === 0, '推送成功后队列清空');
}

/* ------------------------------ examService ------------------------------ */
function makeApp(cfg) {
  cfg = cfg || {};
  const colls = JSON.parse(JSON.stringify(cfg.colls || {}));
  const clone = v => JSON.parse(JSON.stringify(v));
  function coll(name) {
    const rows = () => colls[name] || [];
    const matched = cond => rows().filter(r => Object.keys(cond).every(k => r[k] === cond[k]));
    function q(cond) {
      return {
        orderBy() { return q(cond); },
        limit() { return { get: async () => ({ data: clone(matched(cond)) }) }; },
        get: async () => ({ data: clone(matched(cond)) })
      };
    }
    return {
      where: cond => q(cond),
      limit() { return { async get() { return { data: clone(rows()) }; } }; },
      async add(doc) { (colls[name] = colls[name] || []).push(clone(doc)); return { id: 'new_' + (colls[name].length) }; },
      doc(id) {
        return {
          async update(patch) {
            const d = rows().find(x => x._id === id);
            if (d) Object.keys(patch).forEach(k => { d[k] = clone(patch[k]); });
          },
          async remove() {}
        };
      }
    };
  }
  return { database: () => ({ collection: coll, createCollection: async () => {} }), __colls: colls };
}
function farmRoot(currentId) {
  return { _openid: OID, data: { users: [{ id: 'c1' }, { id: 'c2' }], currentUserId: currentId } };
}

async function groupF_exams() {
  group('F 试卷库：保存盖章 + listExams 按孩子过滤');
  process.env.EXAM_TEST = '1';
  const svc = require(EXAM_PATH);

  {
    const app = makeApp({ colls: { hw_farm_user: [farmRoot('c1')] } });
    const r = await svc.saveExam(app, { exam: { clientId: 'ex_c2', name: '老二卷', childId: 'c2' } }, OID);
    ok(r.ok && r.exam.childId === 'c2', '同家庭显式 childId=c2 优先（切孩子后云端 currentUserId 可能滞后）', r.exam && r.exam.childId);
  }
  {
    const app = makeApp({ colls: { hw_farm_user: [farmRoot('c1')] } });
    const r = await svc.saveExam(app, { exam: { clientId: 'ex_cur', name: '当前孩子卷' } }, OID);
    ok(r.ok && r.exam.childId === 'c1', '未传 childId → 服务端按当前孩子 c1 盖章', r.exam && r.exam.childId);
  }
  {
    const app = makeApp({ colls: { hw_farm_user: [farmRoot('c1')] } });
    const r = await svc.saveExam(app, { exam: { clientId: 'ex_bad', name: '跨家庭谎报', childId: 'c9' } }, OID);
    ok(r.ok && !r.exam.childId, '跨家庭 childId=c9 不被采纳（不归属任何孩子，绝不写别人名下）', r.exam && r.exam.childId);
  }
  {
    const app = makeApp({
      colls: {
        hw_farm_user: [farmRoot('c1')],
        exam_resources: [
          { _id: 'd1', openid: OID, clientId: 'ex_c1', name: 'c1 卷', childId: 'c1', createdAt: 3 },
          { _id: 'd2', openid: OID, clientId: 'ex_c2', name: 'c2 卷', childId: 'c2', createdAt: 2 },
          { _id: 'd3', openid: OID, clientId: 'ex_old', name: '历史卷', createdAt: 1 }
        ]
      }
    });
    const ids = res => (res.exams || []).map(e => e.id).sort().join(',');
    const cur = await svc.listExams(app, OID, '', '');
    ok(ids(cur) === 'ex_c1,ex_old', '当前 c1：只回 c1 的卷 + 无归属历史卷（历史不藏）', ids(cur));
    const req = await svc.listExams(app, OID, '', 'c2');
    ok(ids(req) === 'ex_c2,ex_old', '显式请求 c2：回 c2 的卷 + 历史卷', ids(req));
    const bad = await svc.listExams(app, OID, '', 'c9');
    ok(ids(bad) === 'ex_c1,ex_old', '跨家庭请求 c9 不被采纳，按当前孩子 c1 过滤', ids(bad));

    // update 不应把已有归属清空（saveExam 未传 childId 时）
    app.__colls.hw_farm_user = [farmRoot('c1')];
    await svc.saveExam(app, { exam: { clientId: 'ex_old', name: '改名历史卷' } }, OID);
    const d3 = (app.__colls.exam_resources || []).find(x => x.clientId === 'ex_old') || {};
    ok(d3.childId === undefined, '未传 childId 的更新不清也不猜归属（历史卷保持无归属）', d3.childId);
  }
  {
    const app = makeApp({ colls: {} });
    const r = await svc.listExams(app, 'ipad_abc', '', '');
    ok(r.ok && (r.exams || []).length === 0, '独立 iPad 账号（无档案）→ 不过滤、空列表不报错');
  }
}

/* ------------------------------ 反证 ------------------------------ */
function copyUtils() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'childscope-'));
  fs.cpSync(SRC_DIR, tmp, { recursive: true });
  return tmp;
}
function runMutant(env) {
  const run = spawnSync(process.execPath, [__filename], {
    env: Object.assign({}, process.env, { SCOPE_MUTANT: '1' }, env),
    encoding: 'utf8'
  });
  return { status: run.status, out: (run.stdout || '') + (run.stderr || '') };
}

function counterproofs() {
  group('G 反证：拆掉任一处，本文件必须变红');

  // 1) 拆读取过滤
  {
    const tmp = copyUtils();
    const p = path.join(tmp, 'tutorStore.js');
    const src = fs.readFileSync(p, 'utf8');
    const target = '  return (list || []).filter(x => x && ownerOf(x) === cur);';
    if (src.indexOf(target) < 0) ok(false, '反证定位失败：ofCurrentChild 过滤行');
    else {
      fs.writeFileSync(p, src.replace(target, '  return (list || []).slice(); /* mutant */'), 'utf8');
      const r = runMutant({ TUTOR_SRC_DIR: tmp });
      ok(r.status !== 0 && /✗ 切到 c2/.test(r.out), '拆读取过滤 → 「切到 c2 看不到 c1」变红');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 2) 拆历史盖章
  {
    const tmp = copyUtils();
    const p = path.join(tmp, 'tutorStore.js');
    const src = fs.readFileSync(p, 'utf8');
    const target = '      if (!x.childId || x.childId === LEGACY_CHILD) { x.childId = owner; changed = true; }';
    if (src.indexOf(target) < 0) ok(false, '反证定位失败：ensureChildScope 盖章行');
    else {
      fs.writeFileSync(p, src.replace(target, '      /* mutant: 不补归属 */'), 'utf8');
      const r = runMutant({ TUTOR_SRC_DIR: tmp });
      ok(r.status !== 0 && /✗ 老错题补成 c1|✗ 漏 childId 的老错题/.test(r.out), '拆历史盖章 → 「历史补归属」变红');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 3) 拆 listExams 过滤
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'examscope-'));
    const dir = path.join(REPO, 'cloudfunctions', 'examService');
    fs.cpSync(dir, tmp, { recursive: true });
    const p = path.join(tmp, 'index.js');
    const src = fs.readFileSync(p, 'utf8');
    const target = "  if (scopeOf.childId) docs = docs.filter(d => !d.childId || d.childId === scopeOf.childId);";
    if (src.indexOf(target) < 0) ok(false, '反证定位失败：listExams 过滤行');
    else {
      fs.writeFileSync(p, src.replace(target, '  /* mutant: 不过滤 */'), 'utf8');
      const r = runMutant({ EXAM_SRC: p });
      ok(r.status !== 0 && /✗ 当前 c1：只回/.test(r.out), '拆 listExams 过滤 → 「试卷库切孩子」变红');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------ 入口 ------------------------------ */
(async () => {
  console.log('child-scope 测试' + (IS_MUTANT ? '（变异体）' : '') + ' · 源码 ' + SRC_DIR);
  await groupA_writeStamps();
  await groupB_switchView();
  await groupC_legacy();
  await groupD_cloudAdopts();
  await groupE_push();
  await groupF_exams();
  if (!process.env.SCOPE_MUTANT) counterproofs();
  console.log('\n' + (fail === 0
    ? '通过 ' + pass + ' 项，失败 0 项\n✅ 切孩子即切视图（端上 + 试卷库）全通过'
    : '通过 ' + pass + ' 项，失败 ' + fail + ' 项\n❌ 孩子维度契约被破坏'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试自身异常：', e); process.exit(1); });

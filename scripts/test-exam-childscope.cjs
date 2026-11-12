#!/usr/bin/env node
/**
 * test-exam-childscope.cjs —— examService 的 childId 归属（P0-2 残项）
 *
 * 【锁住的契约】
 *   · 提交记录（tutor_exam_submissions）与 examService 回流的错题（tutor_mistakes）
 *     必须带服务端解析的 childId；
 *   · 归属只取 hw_farm_user.data.currentUserId，**不回落 users[0]**（多孩家庭里那是「猜」）；
 *   · 独立 iPad 账号（openid='ipad_xxx'）/ 无档案 / 查询失败 → childId 为空串（未归属），不阻断批改；
 *   · push 上来的 childId 一律丢弃并由服务端覆写（同 openid 不可信的理由）；
 *   · listSubmissions 历史行回空串，不猜当前孩子。
 *
 * 反证：把 resolveChildScope 改成回落 users[0]，本文件的关键断言必须变红。
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SRC_PATH = process.env.EXAM_SRC || path.join(REPO, 'cloudfunctions', 'examService', 'index.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const CHILD = process.env.EXAM_CHILD === '1';

let fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

/* ---------------- 假云端（可配 hw_farm_user 与查询故障） ---------------- */
function makeApp(cfg) {
  cfg = cfg || {};
  const colls = JSON.parse(JSON.stringify(cfg.colls || {}));
  const log = { adds: [] };
  const clone = v => JSON.parse(JSON.stringify(v));
  function coll(name) {
    const rows = () => colls[name] || [];
    const matched = cond => rows().filter(r => Object.keys(cond).every(k => r[k] === cond[k]));
    function q(cond) {
      return {
        orderBy() { return q(cond); },
        limit() { return { get: async () => { if (cfg.failQuery) throw new Error('query boom'); return { data: clone(matched(cond)) }; } }; },
        get: async () => { if (cfg.failQuery) throw new Error('query boom'); return { data: clone(matched(cond)) }; }
      };
    }
    return {
      where: cond => q(cond),
      limit() { return { async get() { return { data: clone(rows()) }; } }; },
      async add(doc) { log.adds.push({ name: name, doc: clone(doc) }); (colls[name] = colls[name] || []).push(doc); return { id: 'new_' + log.adds.length }; },
      doc() { return { async update() {}, async remove() {} }; }
    };
  }
  const app = { database: () => ({ collection: coll, createCollection: async () => {} }) };
  app.__log = log;
  app.__colls = colls;
  return app;
}

/* 拦截云 SDK：main 走假 app；EXAM_TEST 模式不加载 SDK 所以也不冲突 */
let currentApp = makeApp({});
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@cloudbase/node-sdk') return { init: () => currentApp };
  return origLoad.apply(this, arguments);
};

const OPENID = 'o_parent_1';
function familyUsers() {
  return [
    { id: 'c1', name: '老大' },
    { id: 'c2', name: '老二' }
  ];
}
function rootWith(currentUserId, users) {
  return { _openid: OPENID, data: { users: users === undefined ? familyUsers() : users, currentUserId: currentUserId } };
}

/* ================================================================== *
 * 一、resolveChildScope 语义（EXAM_TEST 导出）
 * ================================================================== */
async function resolverTests() {
  process.env.EXAM_TEST = '1';
  const pure = require(SRC_PATH);

  section('一、resolveChildScope：只认 currentUserId，绝不回落 users[0]');

  currentApp = makeApp({ colls: { hw_farm_user: [rootWith('c2')] } });
  let r = await pure.resolveChildScope(currentApp, OPENID);
  ok(r.childId === 'c2' && r.source === 'current', 'currentUserId=c2 → childId=c2（不是 users[0]=c1）');

  currentApp = makeApp({ colls: { hw_farm_user: [rootWith('')] } });
  r = await pure.resolveChildScope(currentApp, OPENID);
  ok(r.childId === '' && r.source === 'none', 'currentUserId 为空 → childId 空串（旧 readFarmUser 会回落 c1，串数据）');

  currentApp = makeApp({ colls: { hw_farm_user: [rootWith(undefined)] } });
  r = await pure.resolveChildScope(currentApp, OPENID);
  ok(r.childId === '', 'currentUserId 缺失 → childId 空串');

  currentApp = makeApp({ colls: { hw_farm_user: [rootWith('guest')] } });
  r = await pure.resolveChildScope(currentApp, OPENID);
  ok(r.childId === '' && r.source === 'none', 'currentUserId 指向占位切片 guest → childId 空串（占位永不落盘）');

  currentApp = makeApp({ colls: { hw_farm_user: [rootWith('__placeholder')] } });
  r = await pure.resolveChildScope(currentApp, OPENID);
  ok(r.childId === '', 'currentUserId 指向 __placeholder → childId 空串');

  currentApp = makeApp({ colls: { hw_farm_user: [] } });
  r = await pure.resolveChildScope(currentApp, OPENID);
  ok(r.childId === '' && r.source === 'none', '独立 iPad 账号（无 hw_farm_user 档案）→ 空串');

  currentApp = makeApp({ colls: { hw_farm_user: [rootWith('c1')] }, failQuery: true });
  r = await pure.resolveChildScope(currentApp, OPENID);
  ok(r.childId === '', '查询抛错 → 空串（归属解析失败不阻断，但绝不猜）');

  let queried = false;
  currentApp = makeApp({ colls: {} });
  currentApp.database = () => ({ collection: () => { queried = true; return {}; } });
  r = await pure.resolveChildScope(currentApp, '');
  ok(r.childId === '' && !queried, '空 openid → 直接返回，不查库');

  section('  └ 结构断言：grade 链路把服务端 childId 写进提交与错题');
  const fnBodyOf = name => (SRC.split('async function ' + name + '(')[1] || '').split('\nasync function ')[0];
  ['gradePaper', 'gradeExam', 'pushSync'].forEach(name => {
    const body = fnBodyOf(name);
    const n = (body.match(/await resolveChildScope\(app, openid\)/g) || []).length;
    ok(n === 1, name + ' 解析 childId 恰好一次（命中 ' + n + ' 处）');
  });
  ok((SRC.match(/childId: scope\.childId,/g) || []).length === 2, '两条提交记录都写 childId: scope.childId');
  ok((SRC.match(/childId: subDoc\.childId,/g) || []).length === 2, 'gradePaper / gradeExam 回流错题都继承 subDoc.childId');
  const fnBody = fnBodyOf('resolveChildScope');
  ok(fnBody.length > 0 && !/users\s*\[\s*0\s*\]/.test(fnBody), 'resolveChildScope 内不出现 users[0]（不猜第一个孩子）');
}

/* ================================================================== *
 * 二、main 链路：push / listSubmissions
 * ================================================================== */
async function mainTests() {
  delete process.env.EXAM_TEST;
  delete require.cache[require.resolve(SRC_PATH)];
  const svc = require(SRC_PATH);

  section('二、push：客户端 childId 不可信，提交类由服务端覆写');
  {
    const app = makeApp({ colls: { hw_farm_user: [rootWith('c2')] } });
    currentApp = app;
    const res = await svc.main({
      action: 'push', userInfo: { openId: OPENID },
      tutor_exam_submissions: [
        { clientId: 'sub_1', examClientId: 'e1', childId: 'c1' }   // 客户端谎报 c1
      ],
      exam_resources: [
        { clientId: 'e1', name: '数学卷', childId: 'c1' }           // 试卷本身不该带 childId
      ]
    });
    ok(res && res.ok === true, 'push 调用成功');
    const subAdd = app.__log.adds.find(a => a.name === 'tutor_exam_submissions');
    const examAdd = app.__log.adds.find(a => a.name === 'exam_resources');
    ok(!!subAdd, '提交记录已落库');
    ok(subAdd && subAdd.doc.childId === 'c2', '客户端塞的 childId=c1 被丢弃，落库为服务端解析的 c2');
    ok(subAdd && subAdd.doc.openid === OPENID, 'openid 仍是服务端解析值（未被子档覆盖）');
    ok(examAdd && examAdd.doc.childId === undefined, 'exam_resources 不写 childId（客户端值被剥离）');
  }

  section('  └ 无当前孩子时推送：childId 落空串，不猜 users[0]');
  {
    const app = makeApp({ colls: { hw_farm_user: [rootWith('')] } });
    currentApp = app;
    await svc.main({
      action: 'push', userInfo: { openId: OPENID },
      tutor_exam_submissions: [{ clientId: 'sub_2', childId: 'c1' }]
    });
    const subAdd = app.__log.adds.find(a => a.name === 'tutor_exam_submissions');
    ok(subAdd && subAdd.doc.childId === '', '落库 childId 为空串（客户端值被丢弃，未回落 users[0]=c1）');
  }

  section('  └ 独立 iPad 账号：无档案 → childId 空串');
  {
    const app = makeApp({ colls: {} });
    currentApp = app;
    await svc.main({ action: 'push', uid: 'ipad_abc', tutor_exam_submissions: [{ clientId: 'sub_3', childId: 'c1' }] });
    const subAdd = app.__log.adds.find(a => a.name === 'tutor_exam_submissions');
    ok(subAdd && subAdd.doc.openid === 'ipad_ipad_abc', '独立账号写入自己的命名空间');
    ok(subAdd && subAdd.doc.childId === '', 'childId 空串（独立账号没有家庭孩子可归属）');
  }

  section('三、listSubmissions：新行回传 childId，历史行回空串');
  {
    const app = makeApp({
      colls: {
        tutor_exam_submissions: [
          { _id: 'a', openid: OPENID, clientId: 'sub_new', childId: 'c2', createdAt: 200, summary: {} },
          { _id: 'b', openid: OPENID, clientId: 'sub_old', createdAt: 100, summary: {} }
        ]
      }
    });
    currentApp = app;
    const res = await svc.main({ action: 'listSubmissions', userInfo: { openId: OPENID } });
    ok(res && res.ok === true && res.submissions.length === 2, '两条提交都返回');
    const byId = {};
    res.submissions.forEach(s => { byId[s.id] = s; });
    ok(byId.sub_new && byId.sub_new.childId === 'c2', '新行回传 childId=c2');
    ok(byId.sub_old && byId.sub_old.childId === '', '历史行回空串（未归属，不猜当前孩子）');
  }

  section('  └ 单孩子模型：只回当前孩子的回收记录（历史无归属行保留）');
  {
    const app = makeApp({
      colls: {
        hw_farm_user: [rootWith('c2')],
        tutor_exam_submissions: [
          { _id: 'a', openid: OPENID, clientId: 'sub_c1', childId: 'c1', createdAt: 300, summary: {} },
          { _id: 'b', openid: OPENID, clientId: 'sub_c2', childId: 'c2', createdAt: 200, summary: {} },
          { _id: 'c', openid: OPENID, clientId: 'sub_legacy', createdAt: 100, summary: {} }
        ]
      }
    });
    currentApp = app;
    const res = await svc.main({ action: 'listSubmissions', userInfo: { openId: OPENID } });
    const got = (res.submissions || []).map(s => s.id).sort();
    ok(got.join(',') === 'sub_c2,sub_legacy', '当前孩子(c2)+历史行保留，别的孩子(c1)被过滤', got);
  }
}

/* ================================================================== *
 * 四、反证：resolveChildScope 回落 users[0] → 关键断言变红
 * ================================================================== */
function counterproof() {
  section('四、反证：把 resolveChildScope 改回回落 users[0]，断言必须变红');
  const original = '    return G.resolveChildId(doc.data, requested || \'\');';
  if (SRC.indexOf(original) < 0) {
    ok(false, '反证定位失败：源码里找不到 resolveChildScope 的解析行');
    return;
  }
  const mutant = SRC.replace(original,
    '    return G.resolveChildId(Object.assign({}, doc.data, { currentUserId: (doc.data.users && doc.data.users[0] && doc.data.users[0].id) || \'\' }), requested || \'\');');
  const mutantPath = path.join(path.dirname(SRC_PATH), '.mutant-index-childscope.test.js');
  fs.writeFileSync(mutantPath, mutant, 'utf8');
  const run = spawnSync(process.execPath, [__filename], {
    env: Object.assign({}, process.env, { EXAM_SRC: mutantPath, EXAM_CHILD: '1' }),
    encoding: 'utf8'
  });
  try { fs.unlinkSync(mutantPath); } catch (e) {}
  const out = (run.stdout || '') + (run.stderr || '');
  ok(run.status !== 0, '变异体运行失败（断言变红）· exit=' + run.status);
  ok(/✗/.test(out), '变异体输出里出现失败断言');
  ok(/currentUserId 为空/.test(out) === false || /✗ currentUserId 为空/.test(out),
    '失败点正是「currentUserId 为空 → 空串」这条');
}

/* 子进程：只跑 resolver 的关键断言（变异体在这里必须变红） */
(async function main() {
  console.log('examService childId 归属测试' + (CHILD ? '（变异体）' : ''));
  await resolverTests();
  if (!CHILD) {
    await mainTests();
    counterproof();
  }
  console.log('\n' + (fails === 0
    ? '通过 ' + passes + ' 项，失败 0 项\n✅ examService childId 归属契约全通过'
    : '通过 ' + passes + ' 项，失败 ' + fails + ' 项\n❌ childId 归属契约被破坏'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('测试自身异常：', e); process.exit(1); });

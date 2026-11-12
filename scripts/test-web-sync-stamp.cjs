#!/usr/bin/env node
/**
 * 网页端写入「同步留痕」回归测试（2026-10-27）
 *
 * 【它锁住的是什么】
 * 网页端（webAdminWrite）写入 hw_farm_user 的 profile / teachingPlan 时，如果不留
 * 「版本痕迹」，小程序随后的**整份镜像推送**会把网页刚写的内容静默抹掉：
 *
 *   小程序推 profile 只有一条路：store.js:927 doUpload → syncData action:'upload'
 *   服务端落库是 syncData/index.js:143 → `update({ data: { data: payload, updatedAt: now } })`
 *   = **整份 data 覆盖**，没有任何字段白名单。两道闸原本都拦不住它：
 *     ① CAS 闸（syncData/index.js:141 `prev !== base`）依赖文档级 updatedAt；
 *     ② F14 LWW 闸（store.js:1074 `cTs > lTs`）依赖孩子级 _ts.<field>。
 *   两者缺一不可：只补 ① 不够 —— 小程序冲突后走 reconcileWithCloud
 *   （store.js:1110 同样调 f14MergeUser）仍是**本地优先重推**，照样覆盖。
 *
 * 所以本测试断言：writeProfile / writeTeachingPlan 的 patch 必须同时带
 * `updatedAt`（文档级）与 `_ts.<F14 白名单字段>`（孩子级）。
 *
 * 【跑法】跑真实源码 + 桩掉云端 SDK，断言**真正组装出来的 patch**，不是正则数代码。
 * 每族带变异反证：把源码改坏，断言必须变红。退出码非 0 即失败。
 */
'use strict';

const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const FN = path.join(REPO, 'cloudfunctions', 'webAdminWrite', 'index.js');

let fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

/* ================================================================== *
 * 一、云端 SDK 桩：记录所有 update() 的 patch
 * ================================================================== */
const OPENID = 'o_test_001';
const DOC_ID = 'doc_1';
/** 云端主文档快照：data.users[0] 已有一个学科画像 */
function cloudDoc() {
  return {
    _id: DOC_ID,
    _openid: OPENID,
    updatedAt: 1000,
    data: {
      version: 2,
      currentUserId: 'u1',
      users: [{
        id: 'u1', nickname: '加一', grade: '一年级',
        learner: { style: '' },
        subjectProfiles: {
          math: { subject: '数学', textbook: '', dimensions: [], errors: [], teachingPlan: null },
          chinese: { subject: '语文', textbook: '', dimensions: [], errors: [], teachingPlan: null }
        },
        _ts: { subjectProfiles: 500, learner: 500 },
        farm: {}, homework: {}, pace: {}, scenarios: {}
      }],
      coop: { plants: [] },
      wxProfile: { nickname: '', avatarUrl: '' }
    }
  };
}

const LOG = { updates: [] };   // { coll, id, patch }
let CURRENT = cloudDoc();

function makeDbh() {
  const command = { remove: () => ({ __remove: true }) };
  function coll(name) {
    return {
      where(cond) {
        return {
          limit() {
            return {
              async get() {
                if (name === 'hw_farm_user') return { data: [CURRENT] };
                return { data: [] };
              },
              async update(patch) { LOG.updates.push({ coll: name, id: '(where)', patch: patch }); return { stats: { updated: 1 } }; }
            };
          },
          async get() { return { data: name === 'hw_farm_user' ? [CURRENT] : [] }; }
        };
      },
      doc(id) {
        return {
          async get() { return { data: CURRENT }; },
          async update(patch) {
            LOG.updates.push({ coll: name, id: id, patch: patch });
            // 就地模拟落库，让回读校验（writeProfile 的自证）能读到新值
            for (const k of Object.keys(patch)) {
              if (k.indexOf('.') < 0) { CURRENT[k] = patch[k]; continue; }
              const parts = k.split('.');
              let cur = CURRENT;
              for (let i = 0; i < parts.length - 1; i++) {
                if (cur[parts[i]] === undefined || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
                cur = cur[parts[i]];
              }
              cur[parts[parts.length - 1]] = patch[k];
            }
            return { stats: { updated: 1 } };
          }
        };
      },
      async add(doc) { LOG.updates.push({ coll: name, id: '(add)', patch: doc }); return { _id: 'new' }; }
    };
  }
  return { collection: coll, command: command };
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@cloudbase/node-sdk') {
    return { init: () => ({ database: makeDbh, callFunction: async () => ({ result: { ok: true } }) }) };
  }
  return origLoad.apply(this, arguments);
};

process.env.WEB_DASHBOARD_TOKEN = 'tok_admin';
process.env.WEB_ADMIN_ALLOW_WRITE = '1';
const fn = require(FN);

function reset() { LOG.updates = []; CURRENT = cloudDoc(); }
function patchOf(coll, id) {
  const hit = LOG.updates.filter(u => u.coll === coll && u.id === id);
  return hit.length ? hit[hit.length - 1].patch : null;
}
const ADMIN = { token: 'tok_admin', openid: OPENID };

(async function main() {
  console.log('网页端写入同步留痕回归测试（webAdminWrite ↔ 小程序 syncData / F14）');

  /* ---------------------------------------------------------------- */
  section('一、writeProfile：必须同时留 updatedAt 与 _ts');
  reset();
  let r = await fn.main(Object.assign({}, ADMIN, {
    profile: { baseUpdatedAt: 1000, nickname: '加一', grade: '一年级', learner: { style: '视觉' }, subjectProfiles: { math: { subject: '数学', dimensions: [] } } }
  }));
  ok(r && r.ok === true, 'profile 写入返回 ok');
  let p = patchOf('hw_farm_user', DOC_ID);
  ok(!!p, '确实对 hw_farm_user 发起了 update');
  ok(p && typeof p.updatedAt === 'number', '① 文档级 updatedAt 被刷新（syncData CAS 闸依赖它）');
  ok(p && typeof p['data.users.0._ts.subjectProfiles'] === 'number', '② _ts.subjectProfiles 被打戳（F14 LWW 依赖它）');
  ok(p && typeof p['data.users.0._ts.learner'] === 'number', '② _ts.learner 被打戳');
  ok(p && p['data.users.0.subjectProfiles.math'] !== undefined, '业务字段 subjectProfiles.math 仍照常写入');
  ok(p && p.updatedAt > 1000, 'updatedAt 是新时间戳（不是旧值）');

  section('  └ 变异反证：只写无白名单字段时不应打对应 _ts，但 updatedAt 仍要刷新');
  reset();
  r = await fn.main(Object.assign({}, ADMIN, { profile: { baseUpdatedAt: 1000, nickname: '改名' } }));
  p = patchOf('hw_farm_user', DOC_ID);
  ok(p && typeof p.updatedAt === 'number', '只改 nickname 也要刷新 updatedAt');
  ok(p && p['data.users.0._ts.subjectProfiles'] === undefined, '没写 subjectProfiles 就不打它的 _ts（不打无用戳）');
  ok(p && p['data.users.0._ts.learner'] === undefined, '没写 learner 就不打它的 _ts');

  /* ---------------------------------------------------------------- */
  section('二、writeTeachingPlan：必须同时留 updatedAt 与 _ts.subjectProfiles');
  reset();
  r = await fn.main(Object.assign({}, ADMIN, {
    teachingPlan: { key: 'math', title: '一年级数学计划', raw: '# 单元一\n准备课', format: 'md', base: 1000 }
  }));
  ok(r && r.ok === true, 'teachingPlan 写入返回 ok');
  p = patchOf('hw_farm_user', DOC_ID);
  ok(!!p, '确实对 hw_farm_user 发起了 update');
  ok(p && typeof p.updatedAt === 'number', '① 文档级 updatedAt 被刷新');
  ok(p && typeof p['data.users.0._ts.subjectProfiles'] === 'number', '② _ts.subjectProfiles 被打戳');
  ok(p && p['data.users.0.subjectProfiles.math.teachingPlan'] !== undefined, '业务字段 teachingPlan 照常写入');
  const newTs = p['data.users.0._ts.subjectProfiles'];
  ok(newTs > 500, '_ts 必须比云端旧值新（否则 F14 判「本地更新」仍会覆盖）');
  ok(r && r.teachingPlan && r.teachingPlan.updatedAt === p.updatedAt,
    '③ 返回新的 updatedAt（前端据此更新本地基线，否则连续编辑会被自己的闸挡住）');

  section('  └ 冲突闸：云端被小程序改过 → 拒写，绝不静默覆盖');
  reset();
  r = await fn.main(Object.assign({}, ADMIN, { teachingPlan: { key: 'math', raw: 'x', base: 900 } }));
  ok(r && r.ok === false && r.code === 'conflict', 'base 落后于云端 → 返回 conflict');
  ok(patchOf('hw_farm_user', DOC_ID) === null, '冲突时**一条 update 都没发**（未写入任何数据）');

  section('  └ 缺基线闸：与 writeProfile 同口径，base=0 且云端有版本 → 拒写');
  reset();
  r = await fn.main(Object.assign({}, ADMIN, { teachingPlan: { key: 'math', raw: 'x', base: 0 } }));
  ok(r && r.ok === false && r.code === 'conflict', 'base 缺失 → 返回 conflict（此前会静默覆盖）');
  ok(patchOf('hw_farm_user', DOC_ID) === null, '同样一条 update 都没发');

  section('  └ 学科画像缺失 → 拒写，不造残缺结构');
  reset();
  r = await fn.main(Object.assign({}, ADMIN, { teachingPlan: { key: 'english', raw: 'x', base: 1000 } }));
  ok(r && r.ok === false && r.code === 'no_profile', '云端无 english 画像 → no_profile');
  ok(patchOf('hw_farm_user', DOC_ID) === null, '残缺结构一条都没写进去');

  section('  └ db 抛错 → 返回业务错误，不让云函数直接 reject');
  reset();
  const realDb = require.cache[require.resolve(FN)];
  // 让 update 抛错
  const origUpdates = LOG.updates;
  LOG.updates = origUpdates;
  const docRef = CURRENT;
  CURRENT = Object.assign({}, docRef);   // 保持不变，仅注入故障
  try {
    const dbhBackup = makeDbh;
    // 直接把 db 打到抛错：临时重写 CURRENT 无法触发，改为让 collection 返回坏对象
    Module._load = function (request) {
      if (request === '@cloudbase/node-sdk') {
        return { init: () => ({ database: () => { throw new Error('boom'); }, callFunction: async () => ({ result: { ok: true } }) }) };
      }
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(FN)];
    const fn2 = require(FN);
    const r2 = await fn2.main(Object.assign({}, ADMIN, { teachingPlan: { key: 'math', raw: 'x', base: 1000 } }));
    ok(r2 && r2.ok === false && !!r2.msg, 'db() 抛错 → 返回 {ok:false, msg}，不是平台错误');
  } finally {
    Module._load = function (request) {
      if (request === '@cloudbase/node-sdk') {
        return { init: () => ({ database: makeDbh, callFunction: async () => ({ result: { ok: true } }) }) };
      }
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(FN)];
    require(FN);
  }

  /* ---------------------------------------------------------------- */
  section('三、前端契约：保存/清除成功后要把新基线写回本地');
  {
    const fs = require('fs');
    const web = fs.readFileSync(path.join(REPO, 'web', 'index.html'), 'utf8');
    const saveIdx = web.indexOf("teachingPlan: { key, title, raw, format: tpDetectFormat('', raw)");
    const clearIdx = web.indexOf("teachingPlan: { key, title:'', raw:'', format:'text'");
    ok(saveIdx > 0 && clearIdx > 0, '前端存在保存 / 清除两处 teachingPlan 写入');
    const saveTail = web.slice(saveIdx, saveIdx + 600);
    const clearTail = web.slice(clearIdx, clearIdx + 600);
    ok(/acct\.updatedAt\s*=\s*r\.teachingPlan/.test(saveTail), '保存成功后回写 acct.updatedAt');
    ok(/acct\.updatedAt\s*=\s*r\.teachingPlan/.test(clearTail), '清除成功后回写 acct.updatedAt');
  }

  console.log('\n' + (fails === 0
    ? '通过 ' + passes + ' 项，失败 0 项\n✅ 网页端写入同步留痕契约全通过（小程序整份推送不再静默覆盖）'
    : '通过 ' + passes + ' 项，失败 ' + fails + ' 项\n❌ 留痕契约被破坏'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('测试自身异常：', e); process.exit(1); });

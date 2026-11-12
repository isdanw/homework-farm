#!/usr/bin/env node
/**
 * test-parent-auth.cjs —— 家长凭证（PIN → parentSession）契约
 *
 * 【锁住的契约】
 *   · PIN 只存 scrypt(pin, salt)：库里/审计里都不得出现明文，也不得是裸 sha256；
 *   · 连续 5 次失败锁 15 分钟：锁定期间**正确 PIN 也签不出会话**，且不累加计数；
 *   · 会话 2 小时过期、吊销后立即失效、不能跨账号使用；
 *   · 改 PIN 需要旧 PIN，并吊销该账号全部旧会话；
 *   · 空身份一律拒绝（no_openid），不产生无主凭证；
 *   · 审计只记动作与计数，不记 PIN / token。
 *
 * 反证：拆掉锁定闸 / 拆掉过期闸 / 改成明文存 PIN，本文件必须变红。
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = process.env.PA_SRC || path.join(ROOT, 'cloudfunctions/parentAuth/index.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const CHILD_MODE = process.env.PA_CHILD || '';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(n) { console.log('\n' + n); }

/* ---------------- 假云端 ---------------- */
const clone = v => JSON.parse(JSON.stringify(v));
function makeDb() {
  const colls = new Map();
  const coll = (n) => { if (!colls.has(n)) colls.set(n, []); return colls.get(n); };
  function match(doc, q) {
    return Object.keys(q).every(k => {
      const dv = doc[k], v = q[k];
      if (v && typeof v === 'object') return JSON.stringify(dv) === JSON.stringify(v);
      return dv === v;
    });
  }
  function chain(name, q) {
    const c = { _q: q || {}, _limit: 1e9 };
    c.limit = (n) => { c._limit = n; return c; };
    c.get = () => Promise.resolve({ data: coll(name).filter(d => match(d, c._q)).slice(0, c._limit).map(clone) });
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
      add: (doc) => {
        const d = Object.assign({ _id: 'audit_' + (coll(name).length + 1) }, clone(doc));
        coll(name).push(d);
        return Promise.resolve({ id: d._id });
      },
      doc: (id) => ({
        get: () => {
          const d = coll(name).find(x => x._id === id) || null;
          return Promise.resolve({ data: d ? clone(d) : null });
        },
        set: (rec) => {
          const list = coll(name);
          const i = list.findIndex(x => x._id === id);
          const doc = Object.assign({ _id: id }, clone(rec));
          if (i >= 0) list[i] = doc; else list.push(doc);
          return Promise.resolve({});
        },
        update: (patch) => {
          const d = coll(name).find(x => x._id === id);
          if (!d) return Promise.reject(new Error('doc not found'));
          Object.assign(d, clone(patch));
          return Promise.resolve({ updated: 1 });
        }
      })
    })
  };
}

let mockDb = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@cloudbase/node-sdk') {
    return { init: () => ({ database: () => mockDb }) };
  }
  return origLoad.apply(this, arguments);
};

const OPENID = 'o_parent_001';
const OTHER = 'o_parent_002';
function call(fn, action, extra, openid) {
  return fn(Object.assign({ userInfo: { openId: openid === undefined ? OPENID : openid }, action: action }, extra || {}));
}
function rows(db, n) { return db._colls.get(n) || []; }
function sessOf(db, token, sha) {
  const id = 'ps_' + sha(token);
  return rows(db, 'parent_sessions').find(d => d._id === id) || null;
}

/* ---------------- 时间闸（Date.now 可拨） ---------------- */
const realNow = Date.now;
let clock = 1700000000000;
Date.now = () => clock;

(async function main() {
  console.log('parentAuth 家长凭证测试' + (CHILD_MODE ? '（变异体：' + CHILD_MODE + '）' : ''));
  const mod = require(SRC_PATH);
  const fn = mod.main;
  const sha = mod.sha256;

  if (CHILD_MODE === 'nolock') await lockoutChecks(fn, mod);
  else if (CHILD_MODE === 'noexpiry') await sessionChecks(fn, mod);
  else if (CHILD_MODE === 'plain') await storageChecks(fn, mod);
  else {
    await identityChecks(fn);
    await storageChecks(fn, mod);
    await lockoutChecks(fn, mod);
    await sessionChecks(fn, mod);
    await rotateChecks(fn, mod);
    await auditChecks(fn, mod);
    await webChecks(fn, mod);
    counterproofs();
  }
  finish();
})().catch(e => { console.error('测试自身异常：', e); Date.now = realNow; process.exit(1); });

function finish() {
  Date.now = realNow;
  console.log('\n' + (fail === 0
    ? '通过 ' + pass + ' 项，失败 0 项\n✅ 家长凭证契约全通过'
    : '通过 ' + pass + ' 项，失败 ' + fail + ' 项\n❌ 家长凭证契约被破坏'));
  process.exit(fail === 0 ? 0 : 1);
}

/* ---------------- 用例 ---------------- */
async function identityChecks(fn) {
  group('一、身份与初态');
  mockDb = makeDb();
  let r = await fn({ action: 'status' });
  ok(r && r.ok === false && r.code === 'no_openid', '空身份 → no_openid');
  ok(rows(mockDb, 'parent_credentials').length === 0, '没有产生无主凭证');
  r = await call(fn, 'bogus');
  ok(r && r.code === 'bad_action', '未知 action → bad_action');
  r = await call(fn, 'status');
  ok(r.ok === true && r.hasPin === false && r.locked === false, '未设置口令时 status 明确 hasPin:false');
  ok(Array.isArray(r.scopes) && r.scopes.indexOf('orderIssue') >= 0, '回传审批矩阵的权限名');
}

async function storageChecks(fn, mod) {
  group('二、口令存储：scrypt + 盐，不落明文');
  mockDb = makeDb();
  let r = await call(fn, 'setPin', { pin: '123' });
  ok(r.code === 'bad_pin', '3 位口令被拒');
  r = await call(fn, 'setPin', { pin: 'abcd' });
  ok(r.code === 'bad_pin', '非数字口令被拒');
  r = await call(fn, 'setPin', { pin: '1234' });
  ok(r.ok === true && r.hasPin === true, '4 位数字口令设置成功');
  const cred = rows(mockDb, 'parent_credentials')[0];
  ok(!!cred && !!cred.salt && cred.salt.length === 32, '存了 16 字节随机盐');
  ok(!!cred && cred.hash === mod.hashPin('1234', cred.salt), '哈希与 canonical hashPin 一致');
  ok(!!cred && cred.hash !== '1234' && cred.hash !== mod.sha256('1234'), '既不是明文也不是裸 sha256');
  const all = JSON.stringify(rows(mockDb, 'parent_credentials'));
  ok(all.indexOf('"1234"') < 0, '凭证文档里不含明文口令');
}

async function lockoutChecks(fn, mod) {
  group('三、连续失败 5 次 → 锁 15 分钟');
  mockDb = makeDb();
  clock = 1700000000000;
  await call(fn, 'setPin', { pin: '2468' });
  let r;
  for (let i = 1; i <= 4; i++) {
    r = await call(fn, 'verifyPin', { pin: '0000' });
    ok(r.code === 'pin_wrong' && r.remaining === mod.MAX_FAILS - i, '第 ' + i + ' 次错误 → pin_wrong，剩 ' + (mod.MAX_FAILS - i) + ' 次');
  }
  r = await call(fn, 'verifyPin', { pin: '0000' });
  ok(r.code === 'pin_locked' && r.retryAfterSec === 900, '第 5 次错误 → pin_locked（900 秒）');
  r = await call(fn, 'verifyPin', { pin: '2468' });
  ok(r.code === 'pin_locked', '锁定期间**正确口令也签不出会话**');
  r = await call(fn, 'status');
  ok(r.locked === true && r.retryAfterSec > 0, 'status 反映锁定与剩余秒数');
  ok(rows(mockDb, 'parent_sessions').length === 0, '锁定期间零会话');
  const cred = rows(mockDb, 'parent_credentials')[0];
  ok(Number(cred.fails) === mod.MAX_FAILS, '失败计数没有被锁定期间的尝试继续累加');
  clock = 1700000000000 + mod.LOCK_MS + 1000;
  r = await call(fn, 'verifyPin', { pin: '2468' });
  ok(r.ok === true && typeof r.token === 'string' && r.token.length === 48, '锁定到期后正确口令 → 签发会话');
  ok(rows(mockDb, 'parent_credentials')[0].fails === 0, '成功后失败计数清零');
}

async function sessionChecks(fn, mod) {
  group('四、会话：2 小时过期、吊销、不跨账号');
  mockDb = makeDb();
  clock = 1700000000000;
  await call(fn, 'setPin', { pin: '1357' });
  const r = await call(fn, 'verifyPin', { pin: '1357' });
  const token = r.token;
  ok(r.expiresAt === clock + mod.SESSION_TTL_MS, '有效期 2 小时');
  const doc = sessOf(mockDb, token, mod.sha256);
  ok(!!doc && doc.openid === OPENID && doc.revoked === false, '会话按 token 哈希落库并绑定 openid');
  ok(doc.scopes.indexOf('subjectToggle') >= 0, '会话携带审批矩阵权限');
  ok(JSON.stringify(doc).indexOf(token) < 0, '库里不存可用 token 明文');
  let v = await mod.verifySession({ database: () => mockDb }, OPENID, token);
  ok(v.ok === true, 'verifySession：有效');
  v = await mod.verifySession({ database: () => mockDb }, OTHER, token);
  ok(v.ok === false && v.code === 'session_invalid', 'verifySession：别的账号用同 token → 无效');
  v = await mod.verifySession({ database: () => mockDb }, OPENID, 'x'.repeat(48));
  ok(v.ok === false && v.code === 'session_invalid', 'verifySession：伪造 token → 无效');
  clock += mod.SESSION_TTL_MS + 1;
  v = await mod.verifySession({ database: () => mockDb }, OPENID, token);
  ok(v.ok === false && v.code === 'session_expired', 'verifySession：过期 → session_expired');
  const st = await call(fn, 'status', { sessionToken: token });
  ok(st.session && st.session.active === false, 'status 如实报告会话已过期');
  clock = 1700000000000 + 1000;
  const r2 = await call(fn, 'verifyPin', { pin: '1357' });
  const del = await call(fn, 'revoke', { sessionToken: r2.token });
  ok(del.ok === true && del.revoked === true, 'revoke 成功');
  v = await mod.verifySession({ database: () => mockDb }, OPENID, r2.token);
  ok(v.ok === false && v.code === 'session_invalid', '吊销后立即失效');
}

async function rotateChecks(fn, mod) {
  group('五、改口令：需要旧口令，且吊销全部旧会话');
  mockDb = makeDb();
  clock = 1700000000000;
  await call(fn, 'setPin', { pin: '1111' });
  const s = await call(fn, 'verifyPin', { pin: '1111' });
  let r = await call(fn, 'setPin', { pin: '2222' });
  ok(r.code === 'need_old_pin', '不带旧口令 → need_old_pin');
  r = await call(fn, 'setPin', { pin: '2222', oldPin: '9999' });
  ok(r.code === 'pin_wrong' && r.remaining === 4, '旧口令错误 → pin_wrong 并计数');
  r = await call(fn, 'setPin', { pin: '2222', oldPin: '1111' });
  ok(r.ok === true, '旧口令正确 → 改密成功');
  const v = await mod.verifySession({ database: () => mockDb }, OPENID, s.token);
  ok(v.ok === false && v.code === 'session_invalid', '改密后旧会话被吊销');
  r = await call(fn, 'verifyPin', { pin: '1111' });
  ok(r.code === 'pin_wrong', '旧口令不再可用');
  r = await call(fn, 'verifyPin', { pin: '2222' });
  ok(r.ok === true, '新口令可用');
}

async function webChecks(fn, mod) {
  group('七、网页入口：网页看板口令 → openid（不采信管理员口令）');
  mockDb = makeDb();
  clock = 1700000000000;
  const WEB_TOKEN = 'wt_' + 'a'.repeat(40);
  mockDb._colls.set('web_portal_bindings', [
    { _id: 'b1', token: WEB_TOKEN, openid: OPENID, revoked: false },
    { _id: 'b2', token: 'wt_revoked_' + 'b'.repeat(30), openid: OTHER, revoked: true }
  ]);
  const webCall = (action, extra) => fn(Object.assign({ action: action, webToken: WEB_TOKEN }, extra || {}));

  let r = await webCall('status');
  ok(r.ok === true && r.hasPin === false && r.source === 'web', '网页口令 → 解析到该家庭（source=web）');
  r = await webCall('setPin', { pin: '4321' });
  ok(r.ok === true && r.hasPin === true, '网页端可以设置家长口令');
  ok(rows(mockDb, 'parent_credentials')[0].openid === OPENID, '凭证挂在网页口令对应的 openid 上');
  r = await webCall('verifyPin', { pin: '4321' });
  const webToken = r && r.token;
  ok(!!webToken, '网页端可换取会话');
  const st = await webCall('status', { sessionToken: webToken });
  ok(st.session && st.session.active === true, '网页端会话可回验');
  ok(JSON.stringify(rows(mockDb, 'parent_credentials')).indexOf('4321') < 0, '网页路径同样不落明文口令');

  r = await fn({ action: 'status', webToken: 'nope' });
  ok(r.ok === false && r.code === 'web_token_invalid', '无效网页口令 → web_token_invalid');
  r = await fn({ action: 'status', webToken: 'wt_revoked_' + 'b'.repeat(30) });
  ok(r.ok === false && r.code === 'web_token_invalid', '已撤销的网页口令 → 拒绝');
  r = await fn({ action: 'setPin', webToken: 'nope', pin: '5555' });
  ok(r.ok === false && r.code === 'web_token_invalid', '无效口令不能设置家长口令');
  ok(rows(mockDb, 'parent_credentials').length === 1, '拒绝的请求没有产生第二条凭证');

  const old = process.env.WEB_DASHBOARD_TOKEN;
  process.env.WEB_DASHBOARD_TOKEN = 'adm_' + 'z'.repeat(40);
  r = await fn({ action: 'status', webToken: process.env.WEB_DASHBOARD_TOKEN });
  ok(r.ok === false && r.code === 'admin_not_allowed', '管理员口令没有家长身份 → admin_not_allowed');
  delete process.env.WEB_DASHBOARD_TOKEN;
  if (old !== undefined) process.env.WEB_DASHBOARD_TOKEN = old;

  r = await fn({ action: 'status', webToken: 'nope', userInfo: { openId: OPENID } });
  ok(r.ok === false && r.code === 'web_token_invalid', '给了 webToken 就不再回落到网关 openid');
}

async function auditChecks(fn, mod) {
  group('六、审计：只记动作，不记口令与 token');
  const s = await call(fn, 'verifyPin', { pin: '2222' });
  await call(fn, 'revoke', { sessionToken: s.token });
  const audits = rows(mockDb, 'tutor_parent_actions');
  const actions = audits.map(a => a.action);
  ['setPin', 'issueSession', 'pinFailed', 'revokeSession'].forEach(a => {
    ok(actions.indexOf(a) >= 0, '审计含 ' + a);
  });
  const dump = JSON.stringify(audits);
  ok(dump.indexOf('"2222"') < 0 && dump.indexOf('"1111"') < 0, '审计里没有明文口令');
  ok(dump.indexOf('"token"') < 0, '审计里没有 token 字段');
  ok(audits.every(a => a.openid === OPENID && a.at > 0), '每条审计都带账号与时间');
}

/* ---------------- 反证 ---------------- */
function counterproofs() {
  group('八、反证：拆掉安全闸，断言必须变红');
  const MUTANTS = [
    { name: '锁定闸被拆', from: 'const lock = lockState(cred, Date.now());\n  if (lock.locked) {\n    await audit(dbh, openid, \'pinLocked\'', to: 'const lock = lockState(cred, Date.now());\n  if (false) {\n    await audit(dbh, openid, \'pinLocked\'', mode: 'nolock' },
    { name: '过期闸被拆', from: 'if (Number(doc.expiresAt) <= Date.now()) return { ok: false, code: \'session_expired\' };', to: '', mode: 'noexpiry' },
    { name: '改成明文存 PIN', from: 'return crypto.scryptSync(String(pin), String(salt), 32).toString(\'hex\');', to: 'return String(pin);', mode: 'plain' },
    { name: '网页入口被拆（webToken 不生效）', from: '  const webToken = str(ev.webToken, 200);\n  if (webToken) {', to: '  const webToken = \'\';\n  if (webToken) {', mode: 'noweb' },
    { name: '管理员口令被当成家长身份', from: 'if (process.env.WEB_DASHBOARD_TOKEN && webToken === process.env.WEB_DASHBOARD_TOKEN) {', to: 'if (false) {', mode: 'webadmin' }
  ];
  for (const m of MUTANTS) {
    if (SRC.indexOf(m.from) < 0) { ok(false, '反证定位失败：' + m.name); continue; }
    const mutantPath = path.join(path.dirname(SRC_PATH), '.mutant-parentauth.test.js');
    fs.writeFileSync(mutantPath, SRC.replace(m.from, m.to), 'utf8');
    const run = spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, { PA_SRC: mutantPath, PA_CHILD: m.mode }),
      encoding: 'utf8'
    });
    try { fs.unlinkSync(mutantPath); } catch (e) {}
    const out = (run.stdout || '') + (run.stderr || '');
    ok(run.status !== 0, '「' + m.name + '」→ 测试变红 · exit=' + run.status);
    ok(/✗/.test(out), '「' + m.name + '」失败断言可见');
  }
}

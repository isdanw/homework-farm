/**
 * test-scope-guard.cjs —— 写入口作用域守卫（P0-1）
 * ---------------------------------------------------------------------------
 * 两层断言：
 *   1. 纯函数语义：空身份拒绝 / 身份剥离 / 孩子归属只认 users[]（无 users[0] 回落）；
 *   2. 副本哈希锁：五个写入口云函数里的 scopeGuard.js 必须与 canonical 逐字节一致。
 *
 *     node scripts/test-scope-guard.cjs
 *
 * 反证：给任一副本加一个空格，第 2 层必须变红；改 canonical 后不重跑
 * sync-scope-guard.mjs，同样变红。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '   → ' + extra : '')); }
}

const G = require(path.join(ROOT, 'cloudfunctions/_shared/scopeGuard.js'));

console.log('scopeGuard 纯函数语义\n');

/* ---------- requireOpenid ---------- */
for (const bad of ['', '   ', null, undefined, 0]) {
  const r = G.requireOpenid(bad);
  ok(r && r.ok === false && r.code === 'no_openid',
    `空身份 ${JSON.stringify(bad)} → no_openid`, JSON.stringify(r));
}
{
  const r = G.requireOpenid('  oABC123  ');
  ok(r.ok === true && r.openid === 'oABC123', '正常身份去空格后通过');
}

/* ---------- stripIdentity ---------- */
{
  const doc = { openid: 'client-forged', _openid: 'x', childId: 'c1', total: 3 };
  const out = G.stripIdentity(doc);
  ok(out === doc, 'stripIdentity 就地返回同一对象');
  ok(!('openid' in doc) && !('_openid' in doc), '客户端伪造的 openid/_openid 被剥离');
  ok(doc.childId === 'c1' && doc.total === 3, '业务字段不受影响');
  ok(G.stripIdentity(null) === null && G.stripIdentity(undefined) === undefined,
    '非对象入参安全返回');
}

/* ---------- childrenOf / isChildOf ---------- */
const root = {
  currentUserId: 'c2',
  users: [
    { id: 'c1', name: '大宝' },
    { id: '__placeholder', name: '旧占位' },
    { id: 'guest', name: '内存占位', __placeholder: true },
    { id: 'c2', name: '二宝' },
    { id: '', name: '坏数据' },
    null,
  ],
};
{
  const kids = G.childrenOf(root);
  ok(kids.length === 2 && kids.map(k => k.id).join(',') === 'c1,c2',
    '占位/空 id/坏数据都不算孩子', JSON.stringify(kids.map(k => k.id)));
  ok(G.childrenOf(null).length === 0 && G.childrenOf({}).length === 0, '无 users 时返回空数组');
  ok(G.isChildOf(root, 'c1') && G.isChildOf(root, ' c2 '), '合法孩子（含空格）被识别');
  ok(!G.isChildOf(root, '__placeholder') && !G.isChildOf(root, 'guest'), '旧占位与内存占位都不是合法孩子');
  ok(!G.isChildOf(root, 'c9') && !G.isChildOf(root, ''), '陌生 childId / 空值被拒');
}
{
  // 未创建孩子时 currentUserId = 'guest'（只在内存里）→ 绝不能把数据挂到 guest
  const r = G.resolveChildId({ currentUserId: 'guest', users: [{ id: 'guest', __placeholder: true }] }, '');
  ok(r.childId === '' && r.source === 'none', 'currentUserId=guest（占位）→ 不产生 childId', JSON.stringify(r));
}

/* ---------- resolveChildId ---------- */
{
  const r = G.resolveChildId(root, 'c1');
  ok(r.childId === 'c1' && r.source === 'requested', '显式合法 childId 原样采用');
}
{
  const r = G.resolveChildId(root, 'c9');
  ok(r.childId === '' && r.source === 'invalid', '跨家庭 childId 不被采用（source=invalid）');
}
{
  const r = G.resolveChildId(root, '');
  ok(r.childId === 'c2' && r.source === 'current', '未指定时取 currentUserId');
}
{
  // 关键反证：currentUserId 坏掉时，绝不能悄悄回落到 users[0]
  const r = G.resolveChildId({ currentUserId: 'cX', users: [{ id: 'c1' }] }, '');
  ok(r.childId === '' && r.source === 'none',
    '反证：currentUserId 失效时不回落 users[0]', JSON.stringify(r));
}
{
  const r = G.resolveChildId({ users: [{ id: 'c1' }] }, '');
  ok(r.childId === '' && r.source === 'none', '无 currentUserId 时不猜孩子');
}

console.log('\n副本哈希锁（canonical ↔ 云函数目录）\n');

const r = spawnSync(NODE, [path.join(ROOT, 'scripts/sync-scope-guard.mjs'), '--check'], {
  cwd: ROOT, encoding: 'utf8',
});
const out = (r.stdout || '') + (r.stderr || '');
process.stdout.write(out.split('\n').map(l => (l ? '  ' + l : l)).join('\n'));

ok(r.status === 0, '--check 退出码为 0', 'status=' + r.status);
for (const fn of ['tutorSync', 'tutorChat', 'tutorRetest', 'webAdminWrite', 'syncData', 'dailyReset', 'webAdminQuery', 'examService']) {
  ok(new RegExp('✓ ' + fn + '\\b').test(out), `${fn}/scopeGuard.js 与 canonical 一致`);
}
ok(/canonical sha256 = [0-9a-f]{64}/.test(out), '输出了 canonical 全文件 sha256');

/* 反证：篡改一个副本，--check 必须变红 */
{
  const victim = path.join(ROOT, 'cloudfunctions/tutorSync/scopeGuard.js');
  const backup = fs.readFileSync(victim, 'utf8');
  try {
    fs.writeFileSync(victim, backup.replace("const IDENTITY_KEYS = ['openid', '_openid'];",
      "const IDENTITY_KEYS = ['openid'];"), 'utf8');
    const r2 = spawnSync(NODE, [path.join(ROOT, 'scripts/sync-scope-guard.mjs'), '--check'], {
      cwd: ROOT, encoding: 'utf8',
    });
    const out2 = (r2.stdout || '') + (r2.stderr || '');
    ok(r2.status !== 0, '反证：篡改副本后 --check 非 0', 'status=' + r2.status);
    ok(/✗ tutorSync/.test(out2), '反证：输出点名 tutorSync 不一致');
  } finally {
    fs.writeFileSync(victim, backup, 'utf8');
  }
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);

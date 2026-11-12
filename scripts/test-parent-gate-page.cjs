/**
 * test-parent-gate-page.cjs —— 家长凭证端上封装 + 家长验证页
 * ==========================================================================================
 *     node scripts/test-parent-gate-page.cjs
 *
 * 验三块：
 *   1. utils/parentAuth.js：会话只存 token（不存 PIN）、本机过期即清、改口令清会话、revoke 清会话；
 *   2. pkgGuide/parentGate 页面：无口令→设置（两次一致）、有口令未验证→验证、
 *      锁定期间不发请求、改口令必须带旧口令、结束验证回验证态、页面没有自助重置入口；
 *   3. 入口接线：app.json 已注册该页，mine 页有跳转（不然页面写了也进不去）。
 *
 * 反证（默认就跑，PA_CHILD 时跳过）：
 *   ① 拆掉 utils 的过期判断 → 必须红；
 *   ② 把页面的「无口令才进设置」改成永远进设置（= 自助重置） → 必须红。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const UTIL_PATH = path.resolve(process.env.PA_UTIL || path.join(ROOT, 'miniprogram/utils/parentAuth.js'));
const PAGE_PATH = path.resolve(process.env.PA_PAGE || path.join(ROOT, 'miniprogram/pkgGuide/parentGate/parentGate.js'));
const CHILD_MODE = process.env.PA_CHILD || '';

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; return true; }
  fail++;
  console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''));
  return false;
}
function group(name) { console.log('\n' + name); }

/* ------------------------------ mock 小程序运行环境 ------------------------------ */
const storage = {};
let calls = [];
let server = null;
let seq = 0;
let nav = { back: 0, tab: '' };
let stackLen = 2;

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const TTL = 2 * 60 * 60 * 1000;
const SCOPES = ['orderIssue', 'planEdit', 'subjectToggle'];

function resetEnv(opts) {
  Object.keys(storage).forEach(k => { delete storage[k]; });
  calls = [];
  seq = 0;
  server = {
    hasPin: !!(opts && opts.hasPin),
    pin: (opts && opts.pin) || '',
    fails: 0,
    lockedUntil: 0,
    sessions: {}
  };
}

function countAction(action) { return calls.filter(d => d && d.action === action).length; }

/** 模拟云端 parentAuth（语义与 cloudfunctions/parentAuth/index.js 一致，只保留被页面用到的分支） */
function handle(name, d) {
  if (name !== 'parentAuth') return { ok: false, code: 'unexpected_fn' };
  calls.push(d);
  const now = Date.now();
  if (d.action === 'status') {
    const locked = server.lockedUntil > now;
    const out = {
      ok: true, hasPin: server.hasPin, locked: locked,
      retryAfterSec: locked ? Math.ceil((server.lockedUntil - now) / 1000) : 0,
      scopes: SCOPES.slice()
    };
    if (d.sessionToken) {
      const s = server.sessions[d.sessionToken];
      out.session = (s && !s.revoked && s.expiresAt > now)
        ? { active: true, expiresAt: s.expiresAt, scopes: s.scopes.slice() }
        : { active: false, code: 'session_invalid' };
    }
    return out;
  }
  if (d.action === 'setPin') {
    if (!/^\d{4,8}$/.test(String(d.pin || ''))) return { ok: false, code: 'bad_pin' };
    if (server.hasPin) {
      if (server.lockedUntil > now) {
        return { ok: false, code: 'pin_locked', retryAfterSec: Math.ceil((server.lockedUntil - now) / 1000) };
      }
      if (!d.oldPin) return { ok: false, code: 'need_old_pin' };
      if (d.oldPin !== server.pin) {
        server.fails += 1;
        if (server.fails >= MAX_FAILS) server.lockedUntil = now + LOCK_MS;
        return server.fails >= MAX_FAILS
          ? { ok: false, code: 'pin_locked', retryAfterSec: Math.ceil(LOCK_MS / 1000) }
          : { ok: false, code: 'pin_wrong', remaining: MAX_FAILS - server.fails };
      }
    }
    server.pin = String(d.pin);
    server.hasPin = true;
    server.fails = 0;
    server.lockedUntil = 0;
    Object.keys(server.sessions).forEach(t => { server.sessions[t].revoked = true; });
    return { ok: true, hasPin: true };
  }
  if (d.action === 'verifyPin') {
    if (!server.hasPin) return { ok: false, code: 'pin_not_set' };
    if (server.lockedUntil > now) {
      return { ok: false, code: 'pin_locked', retryAfterSec: Math.ceil((server.lockedUntil - now) / 1000) };
    }
    if (String(d.pin || '') !== server.pin) {
      server.fails += 1;
      if (server.fails >= MAX_FAILS) server.lockedUntil = now + LOCK_MS;
      return server.fails >= MAX_FAILS
        ? { ok: false, code: 'pin_locked', retryAfterSec: Math.ceil(LOCK_MS / 1000) }
        : { ok: false, code: 'pin_wrong', remaining: MAX_FAILS - server.fails };
    }
    server.fails = 0;
    seq += 1;
    const token = 'tk' + seq + '_' + 'x'.repeat(40);
    const expiresAt = now + TTL;
    server.sessions[token] = { expiresAt: expiresAt, revoked: false, scopes: ['orderIssue'] };
    return { ok: true, token: token, expiresAt: expiresAt, scopes: server.sessions[token].scopes, parentSessionId: 'ps_' + seq };
  }
  if (d.action === 'revoke') {
    const s = server.sessions[d.sessionToken];
    const revoked = !!(s && !s.revoked);
    if (s) s.revoked = true;
    return { ok: true, revoked: revoked };
  }
  return { ok: false, code: 'bad_action' };
}

global.wx = {
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete storage[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
  showToast: () => {},
  showModal: () => {},
  navigateBack: () => { nav.back += 1; },
  switchTab: (o) => { nav.tab = (o && o.url) || ''; },
  cloud: {
    callFunction: (opts) => Promise.resolve({ result: handle(opts.name, opts.data) }),
    init: () => {}
  }
};
global.getCurrentPages = () => new Array(stackLen).fill({});

const auth = require(UTIL_PATH);

let pageDef = null;
global.Page = (def) => { pageDef = def; };
require(PAGE_PATH);

function mount() {
  const p = Object.create(pageDef);
  p.data = JSON.parse(JSON.stringify(pageDef.data));
  p.setData = function (patch, cb) {
    Object.keys(patch).forEach(k => { this.data[k] = patch[k]; });
    if (cb) cb();
  };
  if (p.onLoad) p.onLoad({});
  return p;
}

async function waitFor(cond, ms) {
  const end = Date.now() + (ms || 800);
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return !!cond();
}

(async () => {
  /* ======================= 一、端上封装 ======================= */
  group('一、utils/parentAuth.js：会话缓存与失效');

  resetEnv({ hasPin: false });
  ok(auth.getSession() === null, '初始没有会话');
  ok(auth.ensureSession() === null, 'ensureSession 初始为 null');

  let st = await auth.status();
  ok(st.ok === true && st.hasPin === false, 'status：云端无口令', JSON.stringify(st));

  const bad = await auth.setPin('12');
  ok(bad.ok === false && bad.code === 'bad_pin', '3 位以下口令被云端拒绝', JSON.stringify(bad));
  ok(!storage[auth.KEY], '失败不写会话');

  const set1 = await auth.setPin('2468');
  ok(set1.ok === true && set1.hasPin === true, '首次设置口令成功');
  ok(server.pin === '2468' && server.hasPin, '云端确实存下口令');
  ok(!storage[auth.KEY], '设置口令本身不产生会话（需显式验证）');
  ok(JSON.stringify(storage).indexOf('2468') < 0, '本机 storage 不出现 PIN 明文');

  const wrong = await auth.verify('0000');
  ok(wrong.ok === false && wrong.code === 'pin_wrong', '错误口令不通过', JSON.stringify(wrong));
  ok(auth.getSession() === null, '错误口令不写会话');

  const right = await auth.verify('2468');
  ok(right.ok === true && !!right.token, '正确口令签发会话');
  const s1 = auth.getSession();
  ok(!!s1 && s1.token === right.token, '本机可读到会话 token');
  ok(s1.expiresAt > Date.now() + TTL - 5000, '会话有效期约 2 小时');
  ok(auth.hasScope(s1, 'orderIssue') === true, '会话携带 orderIssue 权限');
  ok(auth.hasScope(s1, 'subjectToggle') === false, '未授权的 scope 不冒充');
  ok(JSON.stringify(storage).indexOf('2468') < 0, '会话缓存里同样没有 PIN');

  // 本机过期判断：把过期时间挪到过去
  storage[auth.KEY].expiresAt = Date.now() - 1000;
  ok(auth.getSession() === null, '过期会话不再返回');
  ok(!storage[auth.KEY], '过期会话被清出 storage');
  ok(await auth.ensureSession() === null, 'ensureSession 同样拒绝过期会话');

  await auth.verify('2468');
  ok(!!auth.getSession(), '重新验证后恢复会话');
  const rotated = await auth.setPin('8642', '2468');
  ok(rotated.ok === true, '带旧口令可改口令');
  ok(auth.getSession() === null, '改口令后本机会话被清（云端已吊销全部会话）');
  ok(server.pin === '8642', '云端口令已更新');

  await auth.verify('8642');
  const oldToken = auth.getSession().token;
  const rv = await auth.revoke();
  ok(rv.ok === true && rv.revoked === true, 'revoke 通知云端吊销');
  ok(auth.getSession() === null, 'revoke 后本机会话清空');
  ok(server.sessions[oldToken].revoked === true, '云端那条会话已标记吊销');

  const again = await auth.verify('8642');
  ok(again.ok === true && again.token !== oldToken, '吊销后重新验证拿到新 token');

  /* ======================= 二、页面：首次设置 ======================= */
  group('二、家长验证页：首次设置');
  resetEnv({ hasPin: false });
  let p = mount();
  await p.refresh();
  ok(p.data.mode === 'setup', '无口令 → 设置态', p.data.mode);
  ok(p.data.hasPin === false, '设置态标记 hasPin=false');

  p.onPinInput({ detail: { value: '1357' } });
  p.onPin2Input({ detail: { value: '1358' } });
  p.submit();
  await waitFor(() => !!p.data.errMsg);
  ok(countAction('setPin') === 0, '两次不一致：不发请求');
  ok(/不一致/.test(p.data.errMsg), '两次不一致：提示文案', p.data.errMsg);

  p.setData({ errMsg: '' });
  p.onPinInput({ detail: { value: 'abcd' } });
  p.onPin2Input({ detail: { value: 'abcd' } });
  p.submit();
  await waitFor(() => !!p.data.errMsg);
  ok(countAction('setPin') === 0, '非数字：不发请求');
  ok(/4-8 位数字/.test(p.data.errMsg), '非数字：提示文案', p.data.errMsg);

  p.setData({ errMsg: '' });
  p.onPinInput({ detail: { value: '1357' } });
  p.onPin2Input({ detail: { value: '1357' } });
  p.submit();
  const unlocked1 = await waitFor(() => p.data.mode === 'unlocked');
  ok(unlocked1, '设置成功后自动验证并解锁', p.data.mode + ' / ' + p.data.errMsg);
  ok(server.hasPin === true && server.pin === '1357', '云端口令已建立');
  ok(!!auth.getSession(), '页面解锁后本机有会话');
  ok(p.data.pin === '' && p.data.pin2 === '', '成功后清空输入框');
  ok(p.data.expiresText.length > 0, '展示会话到期时间');
  ok(p.data.scopes.indexOf('签发 / 作废学习单') >= 0, '展示可做事项（中文，来自会话 scope 映射）', JSON.stringify(p.data.scopes));

  p = mount();
  await p.refresh();
  ok(p.data.mode === 'unlocked', '有有效会话时重进直接是已验证态', p.data.mode);

  /* ======================= 三、页面：验证与锁定 ======================= */
  group('三、家长验证页：验证与锁定');
  resetEnv({ hasPin: true, pin: '2468' });
  p = mount();
  await p.refresh();
  ok(p.data.mode === 'verify', '有口令无会话 → 验证态', p.data.mode);
  ok(typeof p.reset !== 'function' && typeof p.forgotPin !== 'function', '页面没有自助重置方法');

  p.onPinInput({ detail: { value: '1111' } });
  p.submit();
  await waitFor(() => !!p.data.errMsg);
  ok(countAction('verifyPin') === 1, '错误口令确实请求了云端');
  ok(/还可尝试 4 次/.test(p.data.errMsg), '失败后提示剩余次数', p.data.errMsg);
  ok(p.data.mode === 'verify' && !auth.getSession(), '失败后仍未验证');

  p.onPinInput({ detail: { value: '2468' } });
  p.submit();
  ok(await waitFor(() => p.data.mode === 'unlocked'), '正确口令 → 已验证态', p.data.mode + ' / ' + p.data.errMsg);

  // 连续失败到锁定
  resetEnv({ hasPin: true, pin: '2468' });
  p = mount();
  await p.refresh();
  server.fails = MAX_FAILS - 1;
  p.onPinInput({ detail: { value: '9999' } });
  p.submit();
  await waitFor(() => p.data.locked === true);
  ok(p.data.locked === true, '第 5 次失败 → 锁定');
  ok(/^\d\d:\d\d$/.test(p.data.countdown), '锁定显示倒计时', p.data.countdown);
  ok(p.data.mode === 'verify', '锁定后仍停在验证态');
  const before = countAction('verifyPin');
  p.onPinInput({ detail: { value: '2468' } });
  p.submit();
  await new Promise(r => setTimeout(r, 20));
  ok(countAction('verifyPin') === before, '锁定期间连正确口令都不发请求');
  ok(/稍后再试/.test(p.data.errMsg), '锁定期间给出提示', p.data.errMsg);
  p.stopTick();
  ok(p._tick === null, 'stopTick 清掉定时器');
  p.startTick(3);
  ok(p.data.countdown === '00:03' && p.data.locked === true, '倒计时按秒格式化', p.data.countdown);
  p.stopTick();

  /* ======================= 四、页面：改口令与结束验证 ======================= */
  group('四、家长验证页：改口令与结束验证');
  resetEnv({ hasPin: true, pin: '2468' });
  p = mount();
  await p.refresh();
  p.onPinInput({ detail: { value: '2468' } });
  p.submit();
  await waitFor(() => p.data.mode === 'unlocked');
  const firstToken = auth.getSession().token;

  p.openChange();
  ok(p.data.mode === 'change', '已验证时可进入改口令态');
  p.onPinInput({ detail: { value: '3333' } });
  p.onPin2Input({ detail: { value: '3333' } });
  const n0 = countAction('setPin');
  p.submit();
  await waitFor(() => !!p.data.errMsg);
  ok(countAction('setPin') === n0, '旧口令为空：不发请求');
  ok(/当前口令/.test(p.data.errMsg), '旧口令为空：提示文案', p.data.errMsg);

  p.setData({ errMsg: '' });
  p.onOldPinInput({ detail: { value: '0000' } });
  p.submit();
  await waitFor(() => !!p.data.errMsg);
  ok(server.pin === '2468', '旧口令错误：云端口令未变');
  ok(p.data.mode === 'change', '旧口令错误：留在改口令态');

  p.onOldPinInput({ detail: { value: '2468' } });
  p.onPinInput({ detail: { value: '3333' } });
  p.onPin2Input({ detail: { value: '3333' } });
  p.submit();
  const unlocked2 = await waitFor(() => p.data.mode === 'unlocked');
  ok(unlocked2, '旧口令正确 → 新口令生效并自动重新验证', p.data.mode + ' / ' + p.data.errMsg);
  ok(server.pin === '3333', '云端口令已换成新口令');
  const secondToken = auth.getSession().token;
  ok(secondToken && secondToken !== firstToken, '改口令后拿到新会话');
  ok(server.sessions[firstToken].revoked === true, '旧会话已被云端吊销');

  await p.doRevoke();
  ok(p.data.mode === 'verify', '结束验证 → 回到验证态', p.data.mode);
  ok(auth.getSession() === null, '结束验证后本机会话清空');
  ok(server.pin === '3333', '结束验证不动口令');

  /* ======================= 五、出口：任何形态都能离开 ======================= */
  group('五、出口：任何形态都能离开本页');
  stackLen = 1;
  nav = { back: 0, tab: '' };
  p.goBack();
  ok(nav.back === 0 && nav.tab === '/pages/mine/mine',
    '页面栈只有本页 → 回「我的」（navigateBack 会静默失败）', JSON.stringify(nav));
  stackLen = 2;
  nav = { back: 0, tab: '' };
  p.goBack();
  ok(nav.back === 1 && !nav.tab, '有上级页面时走 navigateBack', JSON.stringify(nav));

  const gateWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pkgGuide/parentGate/parentGate.wxml'), 'utf8');
  const blocks = gateWxml.split('<!-- ===== ');
  const blockHas = (label, needle) => {
    const b = blocks.filter(x => x.indexOf(label) === 0)[0] || '';
    return b.indexOf(needle) >= 0;
  };
  ok(blockHas('云端不可用', 'bindtap="goBack"'), 'error 态有返回出口');
  ok(blockHas('首次设置', 'bindtap="goBack"'), 'setup 态有返回出口（暂不设置）');
  ok(blockHas('验证', 'bindtap="goBack"'), 'verify 态有返回出口');
  ok(blockHas('已验证', 'bindtap="goBack"'), 'unlocked 态有返回出口');

  /* ======================= 六、入口接线 ======================= */
  group('六、入口接线');
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
  const guide = (appJson.subpackages || []).find(sp => sp.root === 'pkgGuide');
  ok(!!guide && guide.pages.indexOf('parentGate/parentGate') >= 0, 'app.json：pkgGuide 已注册 parentGate');
  const mineJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/mine/mine.js'), 'utf8');
  const mineWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/mine/mine.wxml'), 'utf8');
  ok(/goParentGate\s*\(\)\s*\{[^}]*\/pkgGuide\/parentGate\/parentGate/.test(mineJs), 'mine.js：跳转指向家长验证页');
  ok(/bindtap="goParentGate"/.test(mineWxml), 'mine.wxml：有可点入口');

  /* ------------------------------ 反证 ------------------------------ */
  if (!CHILD_MODE) {
    group('七、反证：拆掉闸门，断言必须变红');
    const utilSrc = fs.readFileSync(UTIL_PATH, 'utf8');
    const pageSrc = fs.readFileSync(PAGE_PATH, 'utf8');
    const MUTANTS = [
      {
        name: '过期判断被拆',
        srcPath: UTIL_PATH,
        from: 'if (!(Number(s.expiresAt) > Date.now())) { clearSession(); return null; }',
        to: 'if (false) { clearSession(); return null; }',
        env: { PA_UTIL: path.join(path.dirname(UTIL_PATH), '_mut_parentAuth.js') }
      },
      {
        name: '有口令也允许设新口令（自助重置）',
        srcPath: PAGE_PATH,
        from: '    if (!st.hasPin) {',
        to: '    if (true) {',
        env: { PA_PAGE: path.join(path.dirname(PAGE_PATH), '_mut_parentGate.js') }
      },
      {
        name: '栈底不回「我的」（退化成静默失败）',
        srcPath: PAGE_PATH,
        // 带上上一行一起定位：backToCaller 里也有同样的 switchTab（缩进不同），
        // 只按单行匹配会先命中回跳逻辑，反证就变成"改了另一处、断言照绿"。
        from: "    if (pages && pages.length > 1) { wx.navigateBack({ delta: 1 }); return; }\n    wx.switchTab({ url: '/pages/mine/mine' });",
        to: '    // removed (both)',
        env: { PA_PAGE: path.join(path.dirname(PAGE_PATH), '_mut_parentGate2.js') }
      }
    ];
    for (const m of MUTANTS) {
      const src = m.srcPath === UTIL_PATH ? utilSrc : pageSrc;
      if (src.indexOf(m.from) < 0) { ok(false, '反证定位失败：' + m.name); continue; }
      fs.writeFileSync(m.env.PA_UTIL || m.env.PA_PAGE, src.replace(m.from, m.to), 'utf8');
      const run = spawnSync(process.execPath, [__filename], {
        env: Object.assign({}, process.env, m.env, { PA_CHILD: m.name }),
        encoding: 'utf8'
      });
      try { fs.unlinkSync(m.env.PA_UTIL || m.env.PA_PAGE); } catch (e) {}
      const out = (run.stdout || '') + (run.stderr || '');
      ok(run.status !== 0, '「' + m.name + '」→ 测试变红 · exit=' + run.status);
      ok(/✗/.test(out), '「' + m.name + '」失败断言可见');
    }
  }

  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 家长凭证端上契约全通过') + '（通过 ' + pass + ' 项，失败 ' + fail + ' 项）');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});

/**
 * test-action-registry.cjs —— Action Registry v3 契约 × 小程序实际页面 交叉校验
 * ==========================================================================================
 *     node scripts/test-action-registry.cjs
 *     COUNTERPROOF=1 node scripts/test-action-registry.cjs
 *
 * 验的四件事（v3 §3.6 退出标准）：
 *   1. 契约形状：name 唯一且等于键、page 以 / 开头、stage/parentOnly/requiredFacts/paramsSchema 齐全，
 *      每个参数声明了 type 与 in（page|scope），required 必须在 properties 里存在；
 *   2. Registry 里每个 page 都存在于 miniprogram/app.json（主包或分包），且 .js/.wxml 存在，
 *      pageRegistered 与实际一致 —— 不允许「设计上可用、运行时 404」；
 *   3. 每个 in:'page' 的参数都被页面 onLoad 的入参变量读取（page 没有 onLoad 也算失败）；
 *   4. miniprogram 内所有字面量跳转（url: '/…'）目标都已注册，不许指向不存在的页面。
 * 另测校验器行为（缺必填/坏枚举/未知参数/超长/URL 注入/整数归一/childId 格式）。
 *
 * 反证（COUNTERPROOF=1）：
 *   ① 契约里塞一个不存在的 page → 必须红；
 *   ② 契约给某页多声明一个页面参数、页面并不读 → 必须红。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_JSON = path.join(ROOT, 'action-registry/actionRegistry.json');
const AR = require('../action-registry/actionRegistry.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(label + (detail ? ' —— ' + detail : ''));
  return false;
}

/* ------------------------------ 0. app.json 注册表 ------------------------------ */
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
const registered = new Set();
(app.pages || []).forEach(p => registered.add('/' + p));
(app.subpackages || []).forEach(sp => {
  (sp.pages || []).forEach(p => registered.add('/' + sp.root + '/' + p));
});

const actions = AR.ACTION_LIST;

console.log('契约形状（' + actions.length + ' 个 action）\n');
ok(actions.length > 0, '契约非空');
ok(AR.version === 3, '契约版本为 3', 'version=' + AR.version);

for (const a of actions) {
  const tag = a.name || '(缺少 name)';
  ok(!!a.name && AR.actions[a.name] && AR.actions[a.name].name === a.name, tag + '：键与 name 一致');
  ok(typeof a.page === 'string' && a.page.charAt(0) === '/', tag + '：page 以 / 开头', String(a.page));
  ok(typeof a.pageRegistered === 'boolean', tag + '：pageRegistered 是布尔');
  ok(typeof a.stage === 'string' && /^P[0-9]$/.test(a.stage), tag + '：stage 形如 P1', String(a.stage));
  ok(typeof a.parentOnly === 'boolean', tag + '：parentOnly 是布尔');
  ok(Array.isArray(a.requiredFacts), tag + '：requiredFacts 是数组');
  const schema = a.paramsSchema || {};
  ok(schema.type === 'object' && schema.properties && typeof schema.properties === 'object',
    tag + '：paramsSchema 为 object + properties');
  const props = schema.properties || {};
  const propsKeys = Object.keys(props);
  for (const k of propsKeys) {
    const s = props[k] || {};
    ok(s.in === 'page' || s.in === 'scope', tag + '.' + k + '：in 为 page|scope', String(s.in));
    ok(s.type === 'enum' || s.type === 'string' || s.type === 'integer',
      tag + '.' + k + '：type 已知', String(s.type));
    if (s.type === 'enum') {
      ok(Array.isArray(s.values) && s.values.length > 0, tag + '.' + k + '：enum 有候选值');
    }
    if (s.type === 'string') {
      ok(Number.isInteger(s.maxLength) && s.maxLength > 0, tag + '.' + k + '：string 有 maxLength',
        String(s.maxLength));
    }
    if (s.type === 'integer') {
      ok(Number.isInteger(s.min), tag + '.' + k + '：integer 有 min', String(s.min));
    }
    if (s.required) {
      ok(propsKeys.indexOf(k) >= 0, tag + '.' + k + '：required 参数在 properties 中');
    }
  }
  for (const k of propsKeys) {
    if (props[k] && props[k].required) ok(propsKeys.indexOf(k) >= 0, tag + '.required ⊆ properties：' + k);
  }
}

/* ------------------------------ 1. Registry ↘ app.json / 文件存在 ------------------------------ */
console.log('\nRegistry page 注册与文件\n');
for (const a of actions) {
  const tag = a.name;
  const exists = registered.has(a.page);
  ok(exists, tag + '：page 已在 app.json 注册', a.page);
  ok(a.pageRegistered === exists, tag + '：pageRegistered 与实际一致',
    '声明 ' + a.pageRegistered + ' / 实际 ' + exists);

  const base = path.join(ROOT, 'miniprogram', a.page.replace(/^\//, ''));
  ok(fs.existsSync(base + '.js'), tag + '：页面 .js 存在', a.page + '.js');
  ok(fs.existsSync(base + '.wxml'), tag + '：页面 .wxml 存在', a.page + '.wxml');
}

/* ------------------------------ 2. 页面真的消费声明参数 ------------------------------ */
console.log('页面消费 in:page 参数\n');
const ONLOAD_RE = /\bonLoad\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/;

function onLoadVar(page) {
  const base = path.join(ROOT, 'miniprogram', page.replace(/^\//, ''));
  if (!fs.existsSync(base + '.js')) return null;
  const src = fs.readFileSync(base + '.js', 'utf8');
  const m = ONLOAD_RE.exec(src);
  return m ? { name: m[1], src: src } : null;
}

for (const a of actions) {
  const props = (a.paramsSchema && a.paramsSchema.properties) || {};
  const pageParams = Object.keys(props).filter(k => props[k].in === 'page');
  if (!pageParams.length) {
    pass++;
    continue;
  }
  const hit = onLoadVar(a.page);
  ok(!!hit, a.name + '：页面有 onLoad(options) 可读参数', a.page);
  if (!hit) {
    pageParams.forEach(k => ok(false, a.name + '.' + k + '：未被页面消费（页面无 onLoad）'));
    continue;
  }
  for (const k of pageParams) {
    ok(hit.src.indexOf(hit.name + '.' + k) >= 0,
      a.name + '.' + k + '：被 onLoad(' + hit.name + ') 读取',
      '未找到 ' + hit.name + '.' + k);
  }
}

/* ------------------------------ 3. 字面量跳转目标都已注册 ------------------------------ */
console.log('字面量跳转目标\n');
const MINI = path.join(ROOT, 'miniprogram');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.charAt(0) === '.') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.js$/.test(name)) out.push(p);
  }
  return out;
}

const NAV_RE = /url\s*:\s*['"](\/[^'"]*)['"]/g;
const NAV_TPL_RE = /url\s*:\s*`(\/[^`]*)`/g;
const navTargets = new Set();

for (const file of walk(MINI, [])) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = NAV_RE.exec(src))) navTargets.add(m[1]);
  while ((m = NAV_TPL_RE.exec(src))) navTargets.add(m[1]);
}

ok(navTargets.size > 0, '扫到跳转字面量', 'count=' + navTargets.size);
for (const raw of Array.from(navTargets).sort()) {
  const target = raw.split('?')[0];
  ok(registered.has(target), '跳转目标已注册：' + target);
}

/* ------------------------------ 4. 校验器行为 ------------------------------ */
console.log('校验器行为\n');

const V = (name, params) => AR.validateParams(name, params);

let r = V('start_retest', { subject: 'math', topic: '  分数  ' });
ok(r.ok === true, '正例：start_retest 合法参数通过');
ok(r.ok && r.params.topic === '分数', '正例：字符串已 trim');
ok(r.ok && r.params.subject === 'math', '正例：enum 原样保留');
ok(r.ok && Object.keys(r.params).length === 2, '正例：只返回声明过的键');

r = V('start_retest', { subject: 'math' });
ok(!r.ok && r.code === 'missing_required', '缺必填 topic → missing_required', r.code);

r = V('start_retest', { subject: 'math', topic: '   ' });
ok(!r.ok && r.code === 'missing_required', '必填为空白串 → missing_required', r.code);

r = V('start_retest', { subject: 'art', topic: '分数' });
ok(!r.ok && r.code === 'bad_enum', '枚举外取值 → bad_enum', r.code);

r = V('start_tutor', { childIds: 'a1' });
ok(!r.ok && r.code === 'unknown_param', '未声明参数 → unknown_param', r.code);

r = V('start_retest', { subject: 'math', topic: 'x'.repeat(121) });
ok(!r.ok && r.code === 'bad_value', '超长字符串 → bad_value', r.code);

r = V('start_retest', { subject: 'math', topic: 'https://evil.example/x' });
ok(!r.ok && r.code === 'bad_value', 'URL 形态 → bad_value', r.code);

r = V('start_retest', { subject: 'math', topic: '/pkgTools/cards/cards' });
ok(!r.ok && r.code === 'bad_value', '页面路径形态 → bad_value', r.code);

r = V('start_retest', { subject: 'math', topic: 'a\nb' });
ok(!r.ok && r.code === 'bad_value', '控制字符 → bad_value', r.code);

r = V('start_tutor', { si: '2', ti: 3 });
ok(r.ok === true && r.params.si === 2 && r.params.ti === 3, '整数字符串归一为 number');

r = V('start_tutor', { si: 2.5 });
ok(!r.ok && r.code === 'bad_value', '非整数 → bad_value', r.code);

r = V('start_tutor', { si: -1 });
ok(!r.ok && r.code === 'bad_value', '低于 min → bad_value', r.code);

r = V('start_tutor', 'math');
ok(!r.ok && r.code === 'bad_params', '参数非对象 → bad_params', r.code);

r = V('nope', {});
ok(!r.ok && r.code === 'unknown_action', '未知 action → unknown_action', r.code);

r = V('start_speakstep', {});
ok(r.ok === true, '全可选 action 传空对象可过');

r = V('start_tutor', { childId: 'a 1' });
ok(!r.ok && r.code === 'bad_value', 'childId 含空格 → bad_value', r.code);

r = V('start_tutor', { childId: 'a_1-b2' });
ok(r.ok === true && r.params.childId === 'a_1-b2', 'childId 合法字符通过');

ok(AR.getAction('start_tutor') !== null && AR.getAction('nope') === null, 'getAction 存在性判断');

r = V('review_cards', { subject: 'math', childId: '' });
ok(r.ok === true && !('childId' in r.params), '可选参数空串按缺省丢弃');

/* ------------------------------ 5. 反证 ------------------------------ */
if (process.env.COUNTERPROOF === '1' && process.env.AR_CHILD !== '1') {
  console.log('\n════ 反证 ════');

  function runMutant(tag, mutate) {
    const base = JSON.parse(fs.readFileSync(REGISTRY_JSON, 'utf8'));
    mutate(base);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-' + tag + '-'));
    const file = path.join(dir, 'actionRegistry.json');
    fs.writeFileSync(file, JSON.stringify(base, null, 2), 'utf8');
    const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-action-registry.cjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: Object.assign({}, process.env, { AR_PATH: file, AR_CHILD: '1', COUNTERPROOF: '' })
    });
    const out = (child.stdout || '') + (child.stderr || '');
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: child.status, out: out };
  }

  const cp1 = runMutant('bogus-page', reg => {
    reg.actions.generate_exam.page = '/pkgGuide/nope/nope';
  });
  ok(cp1.status !== 0, '反证①：不存在的 page → 测试变红', 'status=' + cp1.status);
  ok(/pkgGuide\/nope\/nope/.test(cp1.out), '反证①：输出点名假页面');

  const cp2 = runMutant('unconsumed-param', reg => {
    reg.actions.open_plan.paramsSchema.properties.bogusparam =
      { type: 'string', maxLength: 10, in: 'page' };
  });
  ok(cp2.status !== 0, '反证②：页面不读的声明参数 → 测试变红', 'status=' + cp2.status);
  ok(/bogusparam/.test(cp2.out), '反证②：输出点名未消费参数');
}

/* ------------------------------ 结果 ------------------------------ */
console.log('\n' + '─'.repeat(52));
if (fail === 0) {
  console.log(`通过 ${pass} / 共 ${pass}   ✓ 全部通过`);
} else {
  failures.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
  if (failures.length > 40) console.log('  … 另有 ' + (failures.length - 40) + ' 项');
  console.log(`通过 ${pass} / 共 ${pass + fail}   ✗ 有 ${fail} 项失败`);
}
process.exit(fail === 0 ? 0 : 1);

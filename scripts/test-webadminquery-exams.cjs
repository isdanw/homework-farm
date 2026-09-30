/**
 * test-webadminquery-exams.cjs —— webAdminQuery 回归测试
 *   · `exams` 模块（F-B 网页看板试卷库展示端）
 *   · `orders` 模块（T23 计划维度聚合 —— 见文件下半部「T23」各节）
 * ------------------------------------------------------------------------------------------
 * 用假的 @cloudbase/node-sdk 驱动**真实云函数源码**，不部署、不连云：
 *     node scripts/test-webadminquery-exams.cjs
 *     COUNTERPROOF=1 node scripts/test-webadminquery-exams.cjs
 *
 * 覆盖：
 *   1. 管理员口令 → 聚合全部 openid 的试卷目录；
 *   2. per-user 绑定口令 → resolveBinding 反查 openid 后只返回该账户试卷（隔离）；
 *   3. 目录投影正确：只留轻量元数据（**不含** markdown/rawText/answers 正文三段），
 *      id = clientId 优先，数组字段（knowledgePoints）原样保留；
 *   4. 排序：按 updatedAt 降序；
 *   5. 鉴权/路由：错口令 → auth；未知 module → bad_module。
 *   6. **[T23]** `orders` 模块的 `plans` 聚合必须**逐字节等于** canonical
 *      `orderKit.planOrderAggregate`；夹具覆盖改造前三分叉的三个轴
 *      （无锚点单不许丢 / 分组键含 openid / lastAt 兜 createdAt）。
 *
 * 反证：
 *   · 旧基线（用改动前的版本跑同一套用例，应全部失败）：
 *       git show HEAD:cloudfunctions/webAdminQuery/index.js > /tmp/old-waq.js
 *       WAQ_PATH=/tmp/old-waq.js node scripts/test-webadminquery-exams.cjs
 *   · T23 另有一条**在进程内生成变异体**的反证（COUNTERPROOF=1 时触发）：
 *     把 `orders()` 的 return 换回改造前工作台那套内联聚合 → 必须变红。
 *
 *   ⚠️ 两条反证对 T23 的效力**不一样**，别混淆：
 *     · git-HEAD 旧基线对 T23 **证明不了新东西**。云端的 `plans` 聚合本来就是
 *       三端里的**参照实现**（T23 是把另两端对齐到它），所以旧基线在这批断言上
 *       一样是绿的 —— 它只会因为「`orders` 模块整体缺失」而红。这条反证的价值在 exams 侧。
 *     · 真正证明 T23 断言有效的是**进程内变异体**：它把云端换成工作台那套
 *       （丢无锚点 / 键不含 openid / lastAt 不兜 createdAt），
 *       若本文件仍全绿，就说明这批断言根本没在检查口径。
 */
const path = require('path');
const Module = require('module');

const FN = process.env.WAQ_PATH
  || path.resolve(__dirname, '../cloudfunctions/webAdminQuery/index.js');

/* ------------------------------ 假 @cloudbase/node-sdk ------------------------------ */
const TOKEN_ADMIN = 'ADMIN-TOKEN-xyz';
const TOKEN_USER = 'USER-TOKEN-abc';

const EXAMS = [
  { _id: 'a1', clientId: 'c1', openid: 'o1', name: '数学单元测一', subject: 'math', subjectName: '数学',
    examType: 'unit_test', level: 2, suggestedDuration: 40, knowledgePoints: ['两位数', '进位'],
    officialUrl: 'https://ex/1', createdAt: 1000, updatedAt: 2000,
    markdown: 'BIG-PAPER-BODY', rawText: 'BIG-RAW', answers: 'BIG-ANSWERS' },
  { _id: 'a2', clientId: 'c2', openid: 'o1', name: '语文阶段测', subject: 'chinese', subjectName: '语文',
    examType: 'phase_test', level: 1, staleLink: true, createdAt: 1500, updatedAt: 3000,
    markdown: 'BIG-PAPER-BODY', answers: 'BIG-ANSWERS' },
  { _id: 'a3', clientId: 'c3', openid: 'o2', name: '英语真题', subject: 'english', subjectName: '英语',
    examType: 'real_exam', createdAt: 1200, updatedAt: 2500, markdown: 'BIG-PAPER-BODY' }
];
const BINDINGS = [ { _id: 'bd1', token: TOKEN_USER, openid: 'o1', revoked: false } ];

/* ------------------------------------------------------------------ *
 * T23：orders 模块的计划维度聚合
 *
 * 夹具刻意覆盖「三分叉」的三个轴（改造前三端各算一遍时分叉的地方）：
 *   A. 无锚点单（缺 planId）—— 不许被丢弃，必须出现在 plans 里；
 *   B. 两个 openid 的**同 planId 同毫秒**计划 —— 分组键必须含 openid，否则撞成一组；
 *   C. 只有 createdAt、没有 issuedAt 的老单 —— lastAt 必须兜 createdAt，否则排序错。
 * ------------------------------------------------------------------ */
const TODERS = [
  // 同一孩子、同一计划：2 张
  { _id: 'r1', clientId: 'c-ord-1', openid: 'o1', orderNo: 'TS-1', status: 'issued',
    plan: { planId: 'math@1000', key: 'math', subjectName: '数学', stageName: 'S1', taskName: 'T1', si: 0, ti: 0 },
    subject: 'math', subjectName: '数学', issuedAt: 100, createdAt: 100,
    evaluation: { comment: '规则评语甲', commentSource: 'rule' },
    events: [{ type: 'issued', at: 100, by: 'workbench' }],
    copyText: 'BIG-COPY', resumeText: 'BIG-RESUME' },
  { _id: 'r2', clientId: 'c-ord-2', openid: 'o1', orderNo: 'TS-2', status: 'submitted',
    plan: { planId: 'math@1000', key: 'math', subjectName: '数学', stageName: 'S1', taskName: 'T1', si: 0, ti: 0 },
    subject: 'math', subjectName: '数学', issuedAt: 200, submittedAt: 250, createdAt: 200,
    events: [{ type: 'issued', at: 200, by: 'mp' }, { type: 'submitted', at: 250, by: 'mp' }] },
  // B：另一个孩子，同 planId 同毫秒
  { _id: 'r3', clientId: 'c-ord-3', openid: 'o2', orderNo: 'TS-3', status: 'issued',
    plan: { planId: 'math@1000', key: 'math', subjectName: '数学', stageName: 'S1', taskName: 'T1', si: 0, ti: 0 },
    subject: 'math', subjectName: '数学', issuedAt: 100, createdAt: 100, events: [] },
  // A：无锚点单
  { _id: 'r4', clientId: 'c-ord-4', openid: 'o1', orderNo: 'TS-4', status: 'issued',
    plan: {}, subject: 'math', subjectName: '数学', issuedAt: 50, createdAt: 50, events: [] },
  // C：只有 createdAt 的老单
  { _id: 'r5', clientId: 'c-ord-5', openid: 'o1', orderNo: 'TS-5', status: 'closed',
    plan: { planId: 'old@900', key: 'old', subjectName: '语文', stageName: 'S0', taskName: 'T0', si: 0, ti: 0 },
    subject: 'chinese', subjectName: '语文', createdAt: 900, issuedAt: 0, events: [] },
];

function matchWhere(row, where) {
  const w = where || {};
  return Object.keys(w).every(k => row[k] === w[k]);
}
function makeCollection(rows) {
  let _w = {}, _order = null, _skip = 0, _limit = 100;
  const api = {
    where(w) { _w = w || {}; return api; },
    orderBy(k, d) { _order = { k, d }; return api; },
    skip(n) { _skip = n; return api; },
    limit(n) { _limit = n; return api; },
    async count() { return { total: rows.filter(r => matchWhere(r, _w)).length }; },
    async get() {
      let r = rows.filter(x => matchWhere(x, _w));
      if (_order) {
        r = r.slice().sort((a, b) => _order.d === 'desc'
          ? (b[_order.k] || 0) - (a[_order.k] || 0)
          : (a[_order.k] || 0) - (b[_order.k] || 0));
      }
      return { data: r.slice(_skip, _skip + _limit) };
    },
    doc() { return { async update() { return { updated: 1 }; } }; }
  };
  return api;
}
const TABLES = { exam_resources: EXAMS, web_portal_bindings: BINDINGS, tutor_orders: TODERS };
const fakeDb = { collection(name) { return makeCollection(TABLES[name] ? TABLES[name].slice() : []); } };
const fakeSdk = { init() { return { database() { return fakeDb; } }; } };

const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === '@cloudbase/node-sdk') return fakeSdk;
  return origLoad.apply(this, arguments);
};

process.env.WEB_DASHBOARD_TOKEN = TOKEN_ADMIN;
const waq = require(FN);

/* ------------------------------ 断言器 ------------------------------ */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const call = (data) => waq.main(data);

(async () => {
  console.log('\n—— 管理员口令：聚合全部试卷 ——');
  const A = await call({ token: TOKEN_ADMIN, module: 'exams' });
  ok('ok=true', A && A.ok === true, A);
  ok('module=exams', A.module === 'exams', A.module);
  ok('scope=admin', A.scope === 'admin', A.scope);
  const ax = (A.data && A.data.exams) || [];
  ok('返回全部 3 份（不过滤 openid）', ax.length === 3, ax.map(e => e.id));
  ok('按 updatedAt 降序（首条=c2/3000）', ax[0] && ax[0].id === 'c2', ax.map(e => e.id));
  ok('顺序 c2>c3>c1', ax.map(e => e.id).join(',') === 'c2,c3,c1', ax.map(e => e.id));

  console.log('\n—— 目录投影：轻量元数据，剥离正文三段 ——');
  const hasHeavy = ax.some(e => 'markdown' in e || 'rawText' in e || 'answers' in e);
  ok('不含 markdown/rawText/answers 正文字段', !hasHeavy, ax[0]);
  ok('id 取 clientId（而非 _id）', ax.every(e => ['c1', 'c2', 'c3'].includes(e.id)), ax.map(e => e.id));
  const e1 = ax.find(e => e.id === 'c1') || {};
  ok('knowledgePoints 数组原样保留', Array.isArray(e1.knowledgePoints) && e1.knowledgePoints.length === 2, e1.knowledgePoints);
  ok('元数据字段保留（subjectName/level/duration）',
    e1.subjectName === '数学' && e1.level === 2 && e1.suggestedDuration === 40, e1);
  const e2 = ax.find(e => e.id === 'c2') || {};
  ok('staleLink 标记保留', e2.staleLink === true, e2.staleLink);

  console.log('\n—— per-user 绑定口令：按 openid 隔离 ——');
  const U = await call({ token: TOKEN_USER, module: 'exams' });
  ok('ok=true', U && U.ok === true, U);
  ok('scope=user', U.scope === 'user', U.scope);
  const ux = (U.data && U.data.exams) || [];
  ok('只返回 o1 的 2 份（隔离生效）', ux.length === 2, ux.map(e => e.id));
  ok('结果全部属于 o1', ux.every(e => e.openid === 'o1'), ux.map(e => e.openid));

  console.log('\n—— 鉴权与路由兜底 ——');
  const W = await call({ token: 'WRONG', module: 'exams' });
  ok('错口令 → auth', W && W.ok === false && W.code === 'auth', W);
  const B = await call({ token: TOKEN_ADMIN, module: 'nope' });
  ok('未知 module → bad_module', B && B.ok === false && B.code === 'bad_module', B);

  /* ================================================================ *
   * T23 · orders 模块：计划维度聚合必须**就是** canonical 的输出
   *
   * 这里用**真实云函数源码**跑，所以能顺带证明一件部署期才会暴露的事：
   * `cloudfunctions/webAdminQuery/orderKit.js` 确实随代码包上去了、
   * `require('./orderKit')` 在函数目录里解析得到。
   * ================================================================ */
  console.log('\n—— T23 · admin 视角：plans 聚合 ——');
  const O = await call({ token: TOKEN_ADMIN, module: 'orders' });
  ok('ok=true', O && O.ok === true, O);
  // ⚠️ 全部字段访问都必须容错：反证会拿**旧基线**（没有 orders 模块）跑本文件，
  //    那时 O.data 是 undefined。直接读 O.data.orders 会抛异常 → 整个文件中断，
  //    把「一条失败」升级成「测试坏了」——违反「可以红，但绝不能死」。
  const data = (O && O.data) || {};
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const counts = data.counts || {};
  ok('orders 模块返回 data', !!O && !!O.data, O);
  ok('返回 5 张单', orders.length === 5, orders.map(o => o.orderNo));

  // 大文本剥离（既有契约，别被 orders 改动带坏）
  ok('剥离 copyText/resumeText 等大文本', !orders.some(o => 'copyText' in o || 'resumeText' in o), orders[0]);
  ok('id 取 clientId', orders.every(o => String(o.id || '').indexOf('c-ord-') === 0), orders.map(o => o.id));
  ok('回传 openid（家长看板按孩子 chip 过滤的唯一依据）',
    orders.every(o => typeof o.openid === 'string' && o.openid), orders.map(o => o.openid));

  console.log('\n—— T23 · 三分叉轴：无锚点 / openid 入键 / lastAt 兜底 ——');
  // A. 无锚点单不许被丢弃
  const orphan = plans.filter(p => p.planId === '(无锚点)');
  ok("无锚点单出现在 plans 里（不许丢弃）", orphan.length === 1, plans.map(p => p.planId));
  ok("无锚点组 key 也补哨兵 '(无锚点)'（否则网页渲染出空标题）",
    orphan[0] && orphan[0].key === '(无锚点)', orphan[0] && orphan[0].key);
  ok('无锚点组 total=1', orphan[0] && orphan[0].total === 1, orphan[0] && orphan[0].total);

  // B. 分组键含 openid：同 planId 的两个孩子必须是两组
  const mathRows = plans.filter(p => p.planId === 'math@1000');
  ok('同 planId 不同 openid → 2 组（键为 openid::planId）', mathRows.length === 2, mathRows.map(p => p.openid));
  ok('两组 openid 分别是 o1 / o2', mathRows.map(p => p.openid).sort().join(',') === 'o1,o2',
    mathRows.map(p => p.openid));
  ok('o1 那组 total=2', (mathRows.find(p => p.openid === 'o1') || {}).total === 2, mathRows);

  // C. lastAt 兜 createdAt
  const old = plans.find(p => p.planId === 'old@900') || {};
  ok('老单（无 issuedAt、createdAt=900）lastAt=900', old.lastAt === 900, old);
  ok('老单 lastIssuedAt=0 / firstIssuedAt=0（没 issuedAt 就不编一个）',
    old.lastIssuedAt === 0 && old.firstIssuedAt === 0, old);
  ok('排序：lastAt 倒序 → old@900 排第一', plans[0] && plans[0].planId === 'old@900',
    plans.map(p => [p.planId, p.lastAt]));

  console.log('\n—— T23 · 云端输出必须**逐字节等于** canonical ——');
  // 对比基准取**仓库里的 canonical**，不取函数目录里的副本：
  //   · 副本与 canonical 是否逐字节相同已由 test-order-kit-sync.cjs 的 sha256 锁保证，
  //     这里再从函数目录读一次是重复；而且反证要拿旧基线（那时函数目录里根本没有
  //     orderKit.js）跑，从函数目录读会直接抛异常，把「红」的归因搞错。
  //   · 「require('./orderKit') 在函数目录里解析得到」这件事已经**隐式**被证明了：
  //     上面 `require(FN)` 会执行 index.js 顶层的 `const K = require('./orderKit')`，
  //     解析失败的话整个文件根本加载不起来。
  const KC = require(path.resolve(__dirname, '../order-kit/orderKit.js'));
  // ⚠️ 条件里必须带 `orders.length === 5`：否则旧基线（无 orders 模块）下
  //    plans=[]、orders=[]，两边都是空数组 → **空对空通过**，断言恒真。
  //    「空输入两边一致」是没信息量的比较，不能算通过。
  const nonEmpty = orders.length === 5 && plans.length > 0;
  ok('夹具非空（否则下面的相等比较会退化空对空恒真）', nonEmpty, { orders: orders.length, plans: plans.length });
  ok('云端 plans 等于 canonical.planOrderAggregate(orders)',
    nonEmpty && JSON.stringify(plans) === JSON.stringify(KC.planOrderAggregate(orders)),
    { cloud: plans.map(p => [p.openid, p.planId, p.total]), kit: KC.planOrderAggregate(orders).map(p => [p.openid, p.planId, p.total]) });
  ok('云端 counts 等于 canonical.countOrderStatuses(orders)',
    nonEmpty && JSON.stringify(counts) === JSON.stringify(KC.countOrderStatuses(orders)),
    { cloud: counts, kit: KC.countOrderStatuses(orders) });
  ok('counts.total=5 且五项正确',
    counts.total === 5 && counts.issued === 3 && counts.submitted === 1 && counts.closed === 1,
    counts);

  console.log('\n—— T23 · 网页看板真正依赖的两个筛选口径 ——');
  // 网页按孩子 chip 过滤：plans.filter(p => !p.openid || p.openid === a.openid)
  const mineO1 = plans.filter(p => !p.openid || p.openid === 'o1');
  ok('o1 视角 → 3 组（math / 无锚点 / old），不含 o2 的组', mineO1.length === 3, mineO1.map(p => p.planId));
  // 回执面板候选集：plans.filter(p => (p.issued||0) > 0)
  const pending = plans.filter(p => (p.issued || 0) > 0);
  ok('待回执候选（issued>0）共 3 组', pending.length === 3, pending.map(p => [p.planId, p.issued]));

  console.log('\n—— T23 · 上划线字段（网页/工作台下钻用）——');
  ok('plans 行带 stageName / taskName / si / ti（下钻锚点）',
    plans.every(p => 'stageName' in p && 'taskName' in p && 'si' in p && 'ti' in p), plans[0]);
  ok('plans 行默认**不**带 orders 明细（云端响应不膨胀）',
    plans.every(p => !('orders' in p)), plans[0]);

  console.log('\n—— 回归：exams 模块未受影响 ——');
  const A2 = await call({ token: TOKEN_ADMIN, module: 'exams' });
  ok('exams 仍返回 3 份', ((A2.data && A2.data.exams) || []).length === 3);
  /* ---------------- 反证 ---------------- */
  if (process.env.COUNTERPROOF === '1') {
    console.log('\n════ 反证 ════');
    const cp = counterproof();
    console.log(cp ? '\n反证有效 ✓' : '\n反证失效 ✗');
    if (!cp) fail++;
  }

  console.log('\n' + '─'.repeat(52));
  if (fail === 0) console.log(`通过 ${pass} / 共 ${pass}   ✓ 全部通过`);
  else console.log(`通过 ${pass} / 共 ${pass + fail}   ✗ 有 ${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('未捕获异常：', e); process.exit(1); });

/**
 * 反证：把 `orders()` 的 return 换回**改造前工作台那套内联聚合**
 * （丢无锚点 + 键不含 openid + lastAt 不兜 createdAt），
 * 变异体必须让上面那批断言变红。
 *
 * ⚠️ 变异副本必须写在**与原文件同一个目录**：它内部 `require('./orderKit')`
 * 是相对路径，放到 os.tmpdir() 会解析失败，那样"变红"的原因就成了文件找不到，
 * 反证会变成假的。
 */
function counterproof() {
  // 注意：子进程用 `COUNTERPROOF: ''` 启动，所以它根本不会进入上面那个 if 分支，
  // 不存在递归生成变异体的风险。
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const dir = path.dirname(FN);
  const mutantPath = path.join(dir, '.mutant-legacy-aggregate.test.js');
  const src = fs.readFileSync(FN, 'utf8');
  const legacy =
    "const byPlan = {};\n" +
    "  for (const o of list) {\n" +
    "    const p = o.plan || {};\n" +
    "    const pid = p.planId || '';\n" +
    "    if (!pid) continue;\n" +                       // ← 分叉①：丢无锚点
    "    if (!byPlan[pid]) byPlan[pid] = { openid: o.openid || '', planId: pid, key: p.key || '', total: 0, lastAt: 0 };\n" + // ← 分叉②：键不含 openid
    "    const g = byPlan[pid];\n" +
    "    g.total++;\n" +
    "    g.lastAt = Math.max(g.lastAt, o.issuedAt || 0);\n" +  // ← 分叉③：不兜 createdAt
    "  }\n" +
    "  return { orders: list, counts: K.countOrderStatuses(list), plans: Object.keys(byPlan).map((k) => byPlan[k]).sort((a, b) => b.lastAt - a.lastAt) };";
  const mutated = src.replace(
    /return \{\s*orders: list,\s*counts: K\.countOrderStatuses\(list\),\s*plans: K\.planOrderAggregate\(list\)\s*\};/,
    legacy
  );
  if (mutated === src) {
    console.log('  ! 未能定位 orders() 的 return 语句 —— 反证跳过（不计为通过）');
    return false;
  }
  fs.writeFileSync(mutantPath, mutated, 'utf8');
  let red = false;
  try {
    execFileSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, { WAQ_PATH: mutantPath, COUNTERPROOF: '' }),
      stdio: 'pipe',
    });
  } catch (e) { red = true; }
  try { fs.unlinkSync(mutantPath); } catch (e) { /* ignore */ }
  if (red) console.log('  ✓ 换成改造前的内联聚合 → 变红（测试确实能抓到口径分叉）');
  else console.log('  ✗ 换成改造前的内联聚合 → 没变红');
  return red;
}

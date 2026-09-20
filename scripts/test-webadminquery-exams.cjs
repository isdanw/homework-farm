/**
 * test-webadminquery-exams.cjs —— webAdminQuery `exams` 模块（F-B 网页看板试卷库展示端）回归测试
 * ------------------------------------------------------------------------------------------
 * 用假的 @cloudbase/node-sdk 驱动**真实云函数源码**，不部署、不连云：
 *     node scripts/test-webadminquery-exams.cjs
 *
 * 覆盖：
 *   1. 管理员口令 → 聚合全部 openid 的试卷目录；
 *   2. per-user 绑定口令 → resolveBinding 反查 openid 后只返回该账户试卷（隔离）；
 *   3. 目录投影正确：只留轻量元数据（**不含** markdown/rawText/answers 正文三段），
 *      id = clientId 优先，数组字段（knowledgePoints）原样保留；
 *   4. 排序：按 updatedAt 降序；
 *   5. 鉴权/路由：错口令 → auth；未知 module → bad_module。
 *
 * 反证（用改动前的版本跑同一套用例，应全部失败 —— 旧版根本没有 exams 模块）：
 *     git show HEAD:cloudfunctions/webAdminQuery/index.js > /tmp/old-waq.js
 *     WAQ_PATH=/tmp/old-waq.js node scripts/test-webadminquery-exams.cjs
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
const TABLES = { exam_resources: EXAMS, web_portal_bindings: BINDINGS };
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

  console.log('\n' + '─'.repeat(52));
  if (fail === 0) console.log(`通过 ${pass} / 共 ${pass}   ✓ 全部通过`);
  else console.log(`通过 ${pass} / 共 ${pass + fail}   ✗ 有 ${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('未捕获异常：', e); process.exit(1); });

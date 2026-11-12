/* examService 联网搜索（#18）单测
 * 运行：node scripts/test-exam-textbook-search.cjs
 * 覆盖：buildSearchQuery / parseSearchPayload / buildSearchMaterial / parseSearchToc 纯函数
 *       + cleanUnits 回归 + searchTextbook 集成（本地 HTTP 服模拟 Tavily + mock ai） */
process.env.EXAM_TEST = '1';
const M = require('../cloudfunctions/examService/index.js');
const http = require('http');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

/* ---------- 本地 HTTP 服：模拟 Tavily（/search）与 Bocha（/bocha） ---------- */
let server = null, serverPort = 0;
let tavilyBehavior = 'ok';         // ok | http500 | hangup | empty
let bochaBehavior = 'ok';          // ok | http500 | empty
let lastTavilyBody = null;
let lastBochaBody = null;

const BOCHA_RESULTS = [
  { name: '人教版一年级上册数学目录', url: 'https://bocha.example.com/a', summary: '第一单元 准备课 1 数一数 2 比多少 第二单元 位置', siteName: 'bocha' },
  { name: '数学一年级上 章节', url: 'https://bocha.example.com/b', summary: '完全不含目录的网页摘要', siteName: 'bocha' },
  { name: '人教版小学数学目录汇总', url: 'https://bocha.example.com/c', summary: '第三单元 1~5的认识和加减法', siteName: 'bocha' },
  { name: '干扰条目4', url: 'https://bocha.example.com/d', summary: '无关', siteName: 'bocha' },
  { name: '干扰条目5', url: 'https://bocha.example.com/e', summary: '无关', siteName: 'bocha' },
  { name: '超出5条应被截断', url: 'https://bocha.example.com/f', summary: '无关', siteName: 'bocha' }
];

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (req.url.indexOf('/bocha') >= 0) {
          lastBochaBody = (() => { try { return JSON.parse(body); } catch (e) { return null; } })();
          if (bochaBehavior === 'http500') { res.writeHead(500); res.end('boom'); return; }
          if (bochaBehavior === 'empty') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 200, data: { webPages: { value: [] } } })); return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 200, data: { webPages: { value: BOCHA_RESULTS } } }));
          return;
        }
        // Tavily
        lastTavilyBody = (() => { try { return JSON.parse(body); } catch (e) { return null; } })();
        if (tavilyBehavior === 'http500') { res.writeHead(500); res.end('boom'); return; }
        if (tavilyBehavior === 'hangup') { req.socket.destroy(); return; }
        if (tavilyBehavior === 'empty') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ query: 'x', results: [] })); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          query: 'x',
          results: [
            { title: '人教版一年级数学上册目录', url: 'https://example.com/a', content: '第一单元 准备课 1 数一数 2 比多少 第二单元 位置', score: 0.9 },
            { title: '数学一年级上 第二页', url: 'https://example.com/b', content: '完全不含目录的网页摘要', score: 0.7 },
            { title: '人教版小学数学目录汇总', url: 'https://example.com/c', content: '第三单元 1~5的认识和加减法', score: 0.6 },
            { title: '干扰条目4', url: 'https://example.com/d', content: '无关', score: 0.5 },
            { title: '干扰条目5', url: 'https://example.com/e', content: '无关', score: 0.4 },
            { title: '超出5条应被截断', url: 'https://example.com/f', content: '无关', score: 0.3 }
          ]
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}
function stopServer() { return new Promise((r) => server.close(r)); }

/* mock app：仅 ai（searchTextbook 只用 app.ai） */
function makeApp(aiText, throwAi) {
  return {
    ai: () => ({
      createModel: () => ({
        generateText: async () => {
          if (throwAi) throw new Error('hy3 炸了');
          return { text: aiText };
        }
      })
    })
  };
}

const HY3_OK = JSON.stringify({
  results: [
    { index: 1, units: [{ name: '第一单元 准备课', sections: ['数一数', '比多少'], keywords: ['数一数'] }, { name: '第二单元 位置' }] },
    { index: 3, units: [{ name: '第三单元 1~5的认识和加减法', sections: ['1~5的认识', '比大小'] }] }
  ]
});

(async () => {
  await startServer();
  const API = 'http://127.0.0.1:' + serverPort + '/search';

  /* ---------- 1. buildSearchQuery ---------- */
  console.log('== 1. buildSearchQuery ==');
  ok(M.buildSearchQuery({ query: '  北师大一年级数学 目录  ' }) === '北师大一年级数学 目录', '家长 query 优先（trim）');
  ok(M.buildSearchQuery({ subject: 'math', grade: '一年级', term: '上学期', version: '人教版' }) === '人教版一年级上学期数学教材目录', '无 query 时按版本+年级+学期+学科拼');
  ok(M.buildSearchQuery({ subject: 'chinese', grade: '三年级' }) === '三年级语文教材目录', '部分字段缺失时跳过缺失项');
  ok(M.buildSearchQuery({ subject: 'math' }) === '数学教材目录', '仅学科也能拼');
  ok(M.buildSearchQuery({}) === '小学教材目录', '全空兜底');
  ok(M.buildSearchQuery({ query: 'x'.repeat(100) }).length === 60, 'query 截断到 60');

  /* ---------- 2. parseSearchPayload ---------- */
  console.log('== 2. parseSearchPayload ==');
  const p1 = M.parseSearchPayload({ results: [
    { title: 'T1', url: 'https://a.com/1', content: 'c1' },
    { title: 'T2', url: 'https://a.com/2', content: 'c2' }
  ] });
  ok(p1.length === 2 && p1[0].title === 'T1' && p1[0].snippet === 'c1', '正常映射（content→snippet）');
  ok(M.parseSearchPayload({ results: 'bad' }).length === 0, 'results 非数组 → 空');
  ok(M.parseSearchPayload(null).length === 0, 'null → 空');
  ok(M.parseSearchPayload({ results: [{ content: 'only content' }] }).length === 0, '无 title 无 url 被过滤');
  const many = Array.from({ length: 8 }, (_, i) => ({ title: 'T' + i, url: 'https://a.com/' + i, content: 'c' }));
  ok(M.parseSearchPayload({ results: many }).length === 5, '最多取 5 条');
  const long = M.parseSearchPayload({ results: [{ title: 'T'.repeat(100), url: 'https://a.com/' + 'u'.repeat(400), content: 'C'.repeat(500) }] })[0];
  ok(long.title.length === 80 && long.url.length === 300 && long.snippet.length === 400, 'title80/url300/snippet400 截断');

  /* ---------- 2b. parseBochaPayload ---------- */
  console.log('== 2b. parseBochaPayload ==');
  const bp1 = M.parseBochaPayload({ code: 200, data: { webPages: { value: [
    { name: 'B1', url: 'https://b.com/1', summary: 's1' },
    { name: 'B2', url: 'https://b.com/2', snippet: 'sn2' }
  ] } } });
  ok(bp1.length === 2 && bp1[0].title === 'B1' && bp1[0].snippet === 's1', '正常映射（summary→snippet）');
  ok(M.parseBochaPayload({ data: { webPages: { value: 'bad' } } }).length === 0, 'value 非数组 → 空');
  ok(M.parseBochaPayload(null).length === 0, 'null → 空');
  ok(M.parseBochaPayload({ data: { webPages: { value: [{ summary: 'only' }] } } }).length === 0, '无 name 无 url 被过滤');
  const bmany = Array.from({ length: 8 }, (_, i) => ({ name: 'B' + i, url: 'https://b.com/' + i, summary: 'c' }));
  ok(M.parseBochaPayload({ data: { webPages: { value: bmany } } }).length === 5, '最多取 5 条');
  const blong = M.parseBochaPayload({ data: { webPages: { value: [{ name: 'N'.repeat(100), url: 'https://b.com/' + 'u'.repeat(400), summary: 'S'.repeat(500) }] } } })[0];
  ok(blong.title.length === 80 && blong.url.length === 300 && blong.snippet.length === 400, 'Bocha title80/url300/snippet400 截断');

  /* ---------- 3. buildSearchMaterial ---------- */
  console.log('== 3. buildSearchMaterial ==');
  const mat = M.buildSearchMaterial([{ title: 'T1', url: 'https://a.com/1', snippet: 's1' }, { title: 'T2', url: 'https://a.com/2', snippet: 's2' }]);
  ok(mat.indexOf('[1] 标题：T1\n网址：https://a.com/1\n摘要：s1') === 0, '编号化拼接格式');
  ok(mat.indexOf('[2] 标题：T2') > 0, '多条按序编号');
  const matLong = M.buildSearchMaterial([{ title: 'T', url: 'u', snippet: 'x'.repeat(13000) }]);
  ok(matLong.length <= 12020 && matLong.indexOf('材料过长已截断') > 0, '超 12000 截断+提示');

  /* ---------- 4. parseSearchToc ---------- */
  console.log('== 4. parseSearchToc ==');
  const m1 = M.parseSearchToc(HY3_OK, 5);
  ok(m1.size === 2 && m1.get(1).length === 2 && m1.get(3).length === 1, '按编号分组提取');
  ok(m1.get(1)[0].name === '第一单元 准备课' && m1.get(1)[0].sections.length === 2, 'units 字段完整');
  ok(m1.get(1)[1].order === 2, 'order 组内重排');
  ok(!m1.has(2), '无目录的编号不进 Map');
  ok(M.parseSearchToc(HY3_OK, 5).get(9) === undefined, '编号 9 越界（candCount=5）丢弃');
  const m2 = M.parseSearchToc('{"results":[{"index":1,"units":[{"name":""}]}]}', 3);
  ok(m2.size === 0, '空名单元剔除后整组丢弃');
  ok(M.parseSearchToc('不是 JSON', 3).size === 0, '非 JSON → 空 Map');
  ok(M.parseSearchToc('{"foo":1}', 3).size === 0, '无 results → 空 Map');

  /* ---------- 5. cleanUnits 回归（parseTocText 行为不变） ---------- */
  console.log('== 5. cleanUnits 回归 ==');
  const c1 = M.cleanUnits([{ name: 'u1' }, { name: '' }, { name: 'u2', sections: ['s'] }]);
  ok(c1.length === 2 && c1[0].order === 1 && c1[1].order === 2, '剔空名 + order 重排');
  ok(M.cleanUnits([{ name: 'u', keywords: Array.from({ length: 12 }, (_, i) => 'k' + i) }])[0].keywords.length === 8, 'keywords 截 8');
  ok(M.cleanUnits(null).length === 0 && M.cleanUnits('x').length === 0, '非数组安全');
  const pOld = M.parseTocText('{"title":"t","term":"上学期","units":[{"name":"第一单元"},{"name":"第二单元"}]}');
  ok(pOld && pOld.units.length === 2 && pOld.units[1].order === 2 && pOld.title === 't', 'parseTocText 行为不变');

  /* ---------- 6. searchTextbook 集成 ---------- */
  console.log('== 6. searchTextbook 集成 ==');
  const base = { subject: 'math', grade: '一年级', term: '上学期', version: '人教版' };

  // 6.0 未配置 key
  const savedUrl = process.env.SEARCH_API_URL, savedKey = process.env.SEARCH_API_KEY;
  delete process.env.SEARCH_API_URL; delete process.env.SEARCH_API_KEY;
  const r0 = await M.searchTextbook(makeApp(''), base, 'u_cfg');
  ok(!r0.ok && r0.code === 'search_unconfigured', '未配置 SEARCH_API_URL/KEY → search_unconfigured');
  process.env.SEARCH_API_URL = API; process.env.SEARCH_API_KEY = 'tvly-test-key';

  // 6.1 正常流程
  tavilyBehavior = 'ok';
  const r1 = await M.searchTextbook(makeApp(HY3_OK), base, 'u_ok');
  ok(r1.ok, '正常流程 ok');
  ok(r1.usedQuery === '人教版一年级上学期数学教材目录', 'usedQuery 为构造关键词');
  ok(r1.candidates.length === 5, '候选 5 条（第 6 条被截）');
  ok(r1.candidates[0].units.length === 2 && r1.candidates[0].units[0].name === '第一单元 准备课', '候选1 带 units');
  ok(r1.candidates[2].units.length === 1, '候选3 带 units（编号分组正确）');
  ok(r1.candidates[1].units.length === 0, '候选2（无目录）units 空');
  ok(lastTavilyBody && lastTavilyBody.query === '人教版一年级上学期数学教材目录' && lastTavilyBody.max_results === 5, 'Tavily 请求体正确（query/max_results）');
  ok(lastTavilyBody && lastTavilyBody.search_depth === 'advanced', 'Tavily 请求用 advanced 深度（目录页内容更全）');

  // 6.2 家长自定义 query
  const r2 = await M.searchTextbook(makeApp(HY3_OK), Object.assign({ query: '北师大一年级上 目录 site:edu.cn' }, base), 'u_q');
  ok(r2.ok && r2.usedQuery === '北师大一年级上 目录 site:edu.cn', '自定义 query 透传');

  // 6.3 Tavily 500
  tavilyBehavior = 'http500';
  const r3 = await M.searchTextbook(makeApp(HY3_OK), base, 'u_500');
  ok(!r3.ok && r3.code === 'search_error' && r3.msg.indexOf('500') > 0, 'Tavily 500 → search_error');

  // 6.4 Tavily 网络异常
  tavilyBehavior = 'hangup';
  const r4 = await M.searchTextbook(makeApp(HY3_OK), base, 'u_net');
  ok(!r4.ok && r4.code === 'search_error', 'Tavily 连接异常 → search_error');

  // 6.5 空结果
  tavilyBehavior = 'empty';
  const r5 = await M.searchTextbook(makeApp(HY3_OK), base, 'u_empty');
  ok(r5.ok && r5.candidates.length === 0 && r5.usedQuery, '空结果 → ok + 空候选');

  // 6.6 hy3 异常不阻断
  tavilyBehavior = 'ok';
  const r6 = await M.searchTextbook(makeApp('', true), base, 'u_hy3');
  ok(r6.ok && r6.candidates.length === 5 && r6.candidates.every(c => c.units.length === 0), 'hy3 异常 → 候选可见但 units 全空（前端禁用选它）');

  // 6.7 hy3 垃圾输出
  const r7 = await M.searchTextbook(makeApp('我无法提取'), base, 'u_hy3b');
  ok(r7.ok && r7.candidates.every(c => c.units.length === 0), 'hy3 垃圾输出 → units 空但不报错');

  // 6.8 频控（同 openid 10s 内第 4 次）
  const r8a = await M.searchTextbook(makeApp(HY3_OK), base, 'u_rate');
  const r8b = await M.searchTextbook(makeApp(HY3_OK), base, 'u_rate');
  const r8c = await M.searchTextbook(makeApp(HY3_OK), base, 'u_rate');
  const r8d = await M.searchTextbook(makeApp(HY3_OK), base, 'u_rate');
  ok(r8a.ok && r8b.ok && r8c.ok, '同 openid 前 3 次放行');
  ok(!r8d.ok && r8d.code === 'rate_limit' && r8d.retryAfterMs > 0, '第 4 次被频控 + retryAfterMs');

  // 6.9 入参校验
  const r9 = await M.searchTextbook(makeApp(HY3_OK), { subject: 'nope' }, 'u_sub');
  ok(!r9.ok && r9.code === 'bad_subject', '未知学科拒绝');
  const r10 = await M.searchTextbook(makeApp(HY3_OK), { subject: 'math', query: '' }, 'u_q2');
  ok(r10.ok, 'query 为空时自动构造（不拒绝）');

  /* ---------- 6.10 Bocha 兜底（Tavily 主，搜不到/报错自动切博查） ---------- */
  console.log('== 6.10 Bocha 兜底 ==');
  const BAPI = 'http://127.0.0.1:' + serverPort + '/bocha';
  const savedBUrl = process.env.BOCHA_API_URL, savedBKey = process.env.BOCHA_API_KEY;
  process.env.BOCHA_API_URL = BAPI; process.env.BOCHA_API_KEY = 'bocha-test-key';

  // 6.10.1 Tavily 空 → Bocha 兜底
  tavilyBehavior = 'empty'; bochaBehavior = 'ok';
  const rb1 = await M.searchTextbook(makeApp(HY3_OK), base, 'u_fb1');
  ok(rb1.ok && rb1.provider === 'bocha' && rb1.candidates.length === 5, 'Tavily 空 → 切 Bocha 且 provider=bocha');
  ok(lastBochaBody && lastBochaBody.query === '人教版一年级上学期数学教材目录' && lastBochaBody.freshness === 'noLimit' && lastBochaBody.summary === true, 'Bocha 请求体正确（query/freshness/summary）');

  // 6.10.2 Tavily 500 → Bocha 兜底
  tavilyBehavior = 'http500'; bochaBehavior = 'ok';
  const rb2 = await M.searchTextbook(makeApp(HY3_OK), base, 'u_fb2');
  ok(rb2.ok && rb2.provider === 'bocha', 'Tavily 500 → 切 Bocha');

  // 6.10.3 Tavily 正常 → 优先 Tavily（不沉底到 Bocha）
  tavilyBehavior = 'ok'; bochaBehavior = 'empty';
  const rb3 = await M.searchTextbook(makeApp(HY3_OK), base, 'u_fb3');
  ok(rb3.ok && rb3.provider === 'tavily', 'Tavily 正常 → 优先 tavily（provider=tavily）');

  // 6.10.4 两路都空 → ok + 空候选（不报错）
  tavilyBehavior = 'empty'; bochaBehavior = 'empty';
  const rb4 = await M.searchTextbook(makeApp(HY3_OK), base, 'u_fb4');
  ok(rb4.ok && rb4.candidates.length === 0, '两路都空 → ok + 空候选');

  // 6.10.5 仅 Bocha 配置（删 Tavily）→ provider=bocha
  delete process.env.SEARCH_API_URL; delete process.env.SEARCH_API_KEY;
  tavilyBehavior = 'ok'; bochaBehavior = 'ok';
  const rb5 = await M.searchTextbook(makeApp(HY3_OK), base, 'u_fb5');
  ok(rb5.ok && rb5.provider === 'bocha', '仅 Bocha 配置 → provider=bocha');
  process.env.SEARCH_API_URL = API; process.env.SEARCH_API_KEY = 'tvly-test-key';

  // 6.10.6 getSearchProviders 顺序 tavily→bocha
  const prov = M.getSearchProviders();
  ok(prov.length === 2 && prov[0].name === 'tavily' && prov[1].name === 'bocha', 'getSearchProviders 顺序 tavily→bocha');

  // 6.10.7 自定义 query 放松 subject（无学科不拒绝）
  const rb7 = await M.searchTextbook(makeApp(HY3_OK), { query: '一年级上学期 人教版 教材目录' }, 'u_qfree');
  ok(rb7.ok && rb7.usedQuery === '一年级上学期 人教版 教材目录', '自定义 query 时无需学科（放松校验）');

  // 还原 env
  if (savedBUrl === undefined) delete process.env.BOCHA_API_URL; else process.env.BOCHA_API_URL = savedBUrl;
  if (savedBKey === undefined) delete process.env.BOCHA_API_KEY; else process.env.BOCHA_API_KEY = savedBKey;

  // 还原 env
  if (savedUrl === undefined) delete process.env.SEARCH_API_URL; else process.env.SEARCH_API_URL = savedUrl;
  if (savedKey === undefined) delete process.env.SEARCH_API_KEY; else process.env.SEARCH_API_KEY = savedKey;

  await stopServer();
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('运行异常：', e); process.exit(1); });

/* examService 教材 PDF 目录解析单测
 * 运行：node scripts/test-exam-textbook-pdf.cjs
 * 覆盖：
 *   纯函数：sliceTocSegment（目录定位/无关键词回退/截断/空白折叠）、parseTocText（JSON 提取/拒绝路径）
 *   集成：parseTextbookPdf 全链路——本地 HTTP 服 fixture → httpJson 下载（真实 Buffer.concat，
 *        小文件必落 Node 池，天然回归 byteOffset 修复）→ pdf-parse 提取 → mock hy3 → normalizeTextbook
 *        错误路径：无文件/坏学科/取 URL 失败/404/非 PDF/扫描版无文本/hy3 垃圾输出/hy3 空 units/超大文件
 */
process.env.EXAM_TEST = '1';
const fs = require('fs');
const http = require('http');
const path = require('path');
const M = require('../cloudfunctions/examService/index.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

const FIX = path.join(__dirname, '..', 'scripts', 'textbook-pipeline', 'fixtures');
const TOC_PDF = path.join(FIX, 'toc_textbook.pdf');
const SCAN_PDF = path.join(FIX, 'scanned_like.pdf');

/* mock hy3 的目录 JSON 回复（带代码块围栏+前后废话，验证 extractJson 宽松提取） */
const HY3_TOC_OK =
  '好的，我来提取这本教材的目录。\n' +
  '```json\n' +
  '{"title":"人教版·一年级数学上册","term":"上学期",' +
  '"units":[{"name":"第一单元 准备课","sections":["数一数","比多少"],"keywords":["数一数","比多少"]},' +
  '{"name":"第二单元 位置","sections":["上上下下","前后左右"],"keywords":["上上下下","前后左右"]},' +
  '{"name":"第三单元 1-5的认识","sections":["1-5的认识","比大小","加法"],"keywords":["1-5的认识","加法"]},' +
  '{"name":"第四单元 认识图形","sections":["立体图形"],"keywords":["立体图形"]},' +
  '{"name":"总复习","sections":[],"keywords":["复习"]}]}\n' +
  '```\n以上就是结构化结果。';

/* ---------------- 本地 HTTP 服（供 httpJson 真实下载） ---------------- */
let server = null;
let serverPort = 0;
let serveMap = {};   // path -> { file | buffer | status }
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const key = req.url.split('?')[0].replace(/^\//, '');
      const item = serveMap[key];
      if (!item) { res.writeHead(404); res.end('not found'); return; }
      if (item.status) { res.writeHead(item.status); res.end('err'); return; }
      const data = item.buffer || fs.readFileSync(item.file);
      res.writeHead(200, { 'Content-Type': item.type || 'application/pdf', 'Content-Length': data.length });
      res.end(data);
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}
function stopServer() { return new Promise((r) => server.close(r)); }

/* mock app：getTempFileURL 指向本地服；ai 返回 mock-tcb 同款 canned generateText
 * ⚠️ node-sdk 真实返回是裸 { fileList }（无 data 包装；getFileUrlsDetail 同款）；
 *    wrap=true 模拟个别版本包一层 data 的兼容路径（线上实测踩过：mock 用 data 包装
 *    导致单测全绿但线上 file_url_error，2026-10-25） */
function makeApp(aiText, wrap) {
  const fileList = (fileList) => fileList.map(f => ({ fileID: f.fileID, tempFileURL: 'http://127.0.0.1:' + serverPort + '/' + f.fileID }));
  return {
    getTempFileURL: async ({ fileList: fl }) => (
      wrap ? { data: { fileList: fileList(fl) } } : { fileList: fileList(fl) }
    ),
    ai: () => ({ createModel: () => ({ generateText: async () => ({ text: aiText }) }) })
  };
}

(async () => {
  console.log('== 1. sliceTocSegment 纯函数 ==');
  const withToc = '封面文字\n出版社信息\n目  录\n第一单元 准备课 ..... 1\n第二单元 位置 ..... 7\n正文开始\n这是正文';
  const s1 = M.sliceTocSegment(withToc);
  ok(s1.indexOf('目') === 0, '从「目  录」（含空格）处开切');
  ok(s1.indexOf('第一单元') > 0, '目录标题后的单元保留');
  ok(s1.indexOf('封面') < 0, '目录前内容被切掉');
  ok(s1.indexOf('正文开始') >= 0, '目录后内容保留');
  const noToc = '这是全文开头\n第一单元 ..... 1';
  ok(M.sliceTocSegment(noToc).indexOf('这是全文开头') === 0, '无目录关键词时取开头');
  const long = '目录\n' + 'x'.repeat(50000);
  ok(M.sliceTocSegment(long).length <= 12000, '截断到 12000 字');
  ok(M.sliceTocSegment(long, 100).length === 100, '自定义 max 生效');
  const ff = '目录\f第一单元\f\f\f第二单元';
  ok(M.sliceTocSegment(ff).indexOf('\f') < 0, '分页符 \\f 被折叠');
  ok(M.sliceTocSegment('a\n\n\n\nb').indexOf('\n\n\n') < 0, '连续换行折叠');
  ok(M.sliceTocSegment(null) === '' && M.sliceTocSegment(undefined) === '', 'null/undefined 安全');

  console.log('== 2. parseTocText 纯函数 ==');
  const p1 = M.parseTocText(HY3_TOC_OK);
  ok(!!p1 && p1.title === '人教版·一年级数学上册' && p1.term === '上学期', '围栏+废话中提取标题/学期');
  ok(p1.units.length === 5 && p1.units[0].order === 1 && p1.units[4].order === 5, 'units 提取且 order 重排');
  ok(p1.units[0].sections.length === 2 && p1.units[0].keywords.length === 2, 'sections/keywords 保留');
  ok(!M.parseTocText('完全不是 JSON'), '非 JSON 返回 null');
  ok(!M.parseTocText('{"units":[]}'), '空 units 返回 null');
  ok(!M.parseTocText('{"title":"x"}'), '缺 units 返回 null');
  const p2 = M.parseTocText('{"units":[{"name":""},{"name":"第二单元"}]}');
  ok(p2 && p2.units.length === 1 && p2.units[0].name === '第二单元' && p2.units[0].order === 1, '空名单元被剔除且 order 重排');
  const p3 = M.parseTocText('{"units":[{"name":"u","sections":[' + Array.from({ length: 30 }, (_, i) => '"s' + i + '"').join(',') + ']}]}');
  ok(p3.units[0].sections.length === 20, 'sections 截断到 20');
  const p4 = M.parseTocText('{"units":[{"name":"u","keywords":[' + Array.from({ length: 12 }, (_, i) => '"k' + i + '"').join(',') + ']}]}');
  ok(p4.units[0].keywords.length === 8, 'keywords 截断到 8');

  console.log('== 3. parseTextbookPdf 集成（本地 HTTP + 真实 pdf-parse） ==');
  await startServer();
  serveMap['tb_toc'] = { file: TOC_PDF };
  serveMap['tb_scan'] = { file: SCAN_PDF };
  serveMap['tb_notpdf'] = { buffer: Buffer.from('这不是 PDF，只是纯文本。'.repeat(10)), type: 'text/plain' };
  serveMap['tb_404'] = { status: 404 };
  const huge = Buffer.alloc(25 * 1024 * 1024 + 1024, 0x41); // >25MB
  serveMap['tb_huge'] = { buffer: huge };

  // 3.1 正常链路
  const r1 = await M.parseTextbookPdf(makeApp(HY3_TOC_OK), {
    fileId: 'tb_toc', subject: 'math', grade: '一年级', version: '人教版'
  }, 'openid_me');
  ok(r1.ok, '文字版 PDF 全链路解析成功');
  ok(r1.draft && r1.draft.subjectName === '数学' && r1.draft.grade === '一年级', 'draft 带学科/年级');
  ok(r1.draft.units.length === 5 && r1.draft.units[0].name === '第一单元 准备课', 'units 来自 hy3（5 个单元）');
  ok(r1.draft.source === 'upload' && r1.draft.sourceUrl === 'tb_toc', '溯源：source=upload + sourceUrl=fileId');
  ok(r1.draft.openid === undefined, 'draft 是预览对象不带 openid（保存时由 saveTextbook 注入）');
  ok(r1.meta && r1.meta.pages === 3, 'meta.pages=3（封面+目录+正文）');
  ok(r1.meta.textLength > 100, 'meta.textLength 有值');

  // 3.1b 裸 fileList 即真实 node-sdk 返回结构（r1 已用）；再验 data 包装兼容路径
  const r1b = await M.parseTextbookPdf(makeApp(HY3_TOC_OK, true), {
    fileId: 'tb_toc', subject: 'math', grade: '一年级', version: '人教版'
  }, 'openid_me');
  ok(r1b.ok && r1b.draft.units.length === 5, 'getTempFileURL 返回 {data:{fileList}} 兼容路径也通');

  // 3.2 扫描版无文本层
  const r2 = await M.parseTextbookPdf(makeApp(HY3_TOC_OK), { fileId: 'tb_scan', subject: 'math' }, 'openid_me');
  ok(!r2.ok && r2.code === 'pdf_no_text', '扫描版 PDF → pdf_no_text');

  // 3.3 非 PDF
  const r3 = await M.parseTextbookPdf(makeApp(HY3_TOC_OK), { fileId: 'tb_notpdf', subject: 'math' }, 'openid_me');
  ok(!r3.ok && r3.code === 'not_pdf', '非 PDF 文件 → not_pdf');

  // 3.4 404
  const r4 = await M.parseTextbookPdf(makeApp(HY3_TOC_OK), { fileId: 'tb_404', subject: 'math' }, 'openid_me');
  ok(!r4.ok && r4.code === 'download_error', '下载 404 → download_error');

  // 3.5 超大
  const r5 = await M.parseTextbookPdf(makeApp(HY3_TOC_OK), { fileId: 'tb_huge', subject: 'math' }, 'openid_me');
  ok(!r5.ok && r5.code === 'too_large', '>25MB → too_large');

  // 3.6 取 URL 失败
  const badUrlApp = { getTempFileURL: async () => { throw new Error('cos 挂了'); }, ai: () => ({ createModel: () => ({ generateText: async () => ({ text: '' }) }) }) };
  const r6 = await M.parseTextbookPdf(badUrlApp, { fileId: 'tb_toc', subject: 'math' }, 'openid_me');
  ok(!r6.ok && r6.code === 'file_url_error', 'getTempFileURL 抛错 → file_url_error');

  // 3.7 hy3 垃圾输出
  const r7 = await M.parseTextbookPdf(makeApp('我无法提取这份目录。'), { fileId: 'tb_toc', subject: 'math' }, 'openid_me');
  ok(!r7.ok && r7.code === 'parse_error', 'hy3 非 JSON → parse_error');

  // 3.8 hy3 空 units
  const r8 = await M.parseTextbookPdf(makeApp('{"units":[]}'), { fileId: 'tb_toc', subject: 'math' }, 'openid_me');
  ok(!r8.ok && r8.code === 'parse_error', 'hy3 空 units → parse_error');

  // 3.9 入参校验
  const r9 = await M.parseTextbookPdf(makeApp(HY3_TOC_OK), { fileId: '', subject: 'math' }, 'openid_me');
  ok(!r9.ok && r9.code === 'no_file', '缺 fileId → no_file');
  const r10 = await M.parseTextbookPdf(makeApp(HY3_TOC_OK), { fileId: 'tb_toc', subject: 'nope' }, 'openid_me');
  ok(!r10.ok && r10.code === 'bad_subject', '未知学科 → bad_subject');

  await stopServer();
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试执行异常：', e); process.exit(1); });

/**
 * test-ocr-pipeline.cjs —— ocrSchedule(v3) 本地端到端管线验证
 *
 * 为什么这么测：ocrSchedule 真实识别依赖云端配置的外部视觉模型（Key 在云上，需真机+真实照片），
 * 我侧无法拿到真实 API。但 v3 的「取图 → 外部调用 → extractJson → normalizeGrid/normalizeItems
 * → 两遍核对 → 返回」管线是确定性的，可以用一个本地 mock 视觉 HTTP 服务替代真实模型来跑通，
 * 从而验证：① 外部调用分支（source='external'）真的接管 ② JSON/HTML 解析 ③ 反幻觉（空图拒绝）
 * ④ 两遍核对 ⑤ 错题转录。真实 AI 识别质量本身仍需真机 + 配置好的外部 API 验证（脚本内已标注）。
 *
 * 运行：node scripts/test-ocr-pipeline.cjs
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');

/* ---- 1) stub @cloudbase/node-sdk（云函数只在 main 里 init，外部路径根本不碰 app.ai） ---- */
const fakeDb = {
  collection() { return { add() { return Promise.reject(new Error('stub-db')); }, get() { return Promise.resolve({ data: [] }); } }; },
  createCollection() { return Promise.reject(new Error('stub-db')); }
};
const fakeTcb = {
  init() {
    return {
      database() { return fakeDb; },
      ai() {
        return {
          createModel() {
            return {
              generateText() { return Promise.reject(new Error('stub-no-tokenhub')); }
            };
          }
        };
      }
    };
  }
};
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) {
  if (req === '@cloudbase/node-sdk') return 'fake-tcb';
  return _resolve.call(this, req, ...a);
};
const _load = Module._load;
Module._load = function (req, ...a) {
  if (req === '@cloudbase/node-sdk' || req === 'fake-tcb') return fakeTcb;
  // ocrSchedule 硬编码用 https.request 调外部视觉 API；本地 mock 是 HTTP 服务，
  // 故把 https 透传成 http（API 同签名），绕过 TLS，专注验证管线逻辑而非传输层。
  if (req === 'https') return { request: require('http').request };
  return _load.call(this, req, ...a);
};

/* ---- 2) 取 index.js 里真实的 PROBE_PNG_B64 作为「真实图片」底座（64x64 红图，非空图） ---- */
const SRC = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/ocrSchedule/index.js'), 'utf8');
const m = SRC.match(/const PROBE_PNG_B64 = '([^']+)'/);
const PROBE_PNG_B64 = m ? m[1] : '';
if (!PROBE_PNG_B64) { console.error('未能从源码提取 PROBE_PNG_B64'); process.exit(1); }

const ocr = require(path.resolve(__dirname, '../cloudfunctions/ocrSchedule/index.js'));

/* ---- 3) mock 视觉服务：按全局变量 CASE 返回不同「模型输出」 ---- */
let CASE = 'schedule';
const SERVER = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    let content;
    switch (CASE) {
      case 'schedule':
        content = JSON.stringify({ termName: '2026秋', days: ['周一', '周二', '周三', '周四', '周五'], periods: ['08:20', '09:15'], grid: [['语文', '数学', '', '', ''], ['', '美术', '', '', '']] });
        break;
      case 'schedule_html':
        content = '<table><tr><th>项目</th><th>周一</th><th>周二</th></tr><tr><td>第一节</td><td>语文</td><td>数学</td></tr><tr><td>第二节</td><td>英语</td><td>体育</td></tr></table>';
        break;
      case 'schedule_blank': // 反幻觉：模型对着空图编造（这里直接给全空 grid）→ 应被拒
        content = JSON.stringify({ termName: '', days: ['周一', '周二'], periods: [], grid: [['', '', '', '', ''], ['', '', '', '', '']] });
        break;
      case 'schedule_garbage': // 模型跑偏：输出废话而非 JSON → 应报 parse
        content = '抱歉，我无法识别这张图片，请问还有什么可以帮您？';
        break;
      case 'mistake':
        content = JSON.stringify({
          subjectGuess: 'math',
          studyNote: '练习了两位数进位加法竖式，共 2 道题，其中 1 道做错',
          items: [
            { no: '1', type: 'calc', questionText: '37+45=', childAnswer: '72', marked: true, correctAnswer: '', wrong: true },
            { no: '2', type: 'calc', questionText: '63-28=', childAnswer: '35', marked: true, correctAnswer: '', wrong: false }
          ]
        });
        break;
      default:
        content = '{}';
    }
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }

function startServer() {
  return new Promise(res => SERVER.listen(0, '127.0.0.1', () => res(SERVER.address().port)));
}
const visionConfigFor = (port) => ({ base: 'http://127.0.0.1:' + port, key: 'test-key', model: 'mock-vl' });

async function run() {
  const port = await startServer();
  const cfg = visionConfigFor(port);

  // ① 课表识别（默认 action）+ 两遍核对
  CASE = 'schedule';
  const r1 = await ocr.main({ imageBase64: PROBE_PNG_B64, visionConfig: cfg });
  ok('课表：ok=true', r1.ok === true, JSON.stringify(r1).slice(0, 120));
  eq('课表：grid 正确', (r1.grid || []).map(row => row.slice(0, 2)), [['语文', '数学'], ['', '美术']]);
  ok('课表：两遍核对生效 verified=true', r1.verified === true, 'verified=' + r1.verified);

  // ② 错题转录（action=mistake）+ 两遍核对
  CASE = 'mistake';
  const r2 = await ocr.main({ action: 'mistake', imageBase64: PROBE_PNG_B64, visionConfig: cfg });
  ok('错题：ok=true', r2.ok === true, JSON.stringify(r2).slice(0, 120));
  ok('错题：items 长度=2', (r2.items || []).length === 2, 'len=' + (r2.items || []).length);
  eq('错题：第1题 wrong=true（客观题自算）', r2.items[0].wrong, true);
  eq('错题：第2题 wrong=false', r2.items[1].wrong, false);
  ok('错题：studyNote 带回', (r2.studyNote || '').indexOf('进位加法') >= 0, r2.studyNote);
  ok('错题：marked 三值归一 true', r2.items[0].marked === true);

  // ③ 反幻觉：空图（全空 grid）→ 应拒绝而非编造
  CASE = 'schedule_blank';
  const r3 = await ocr.main({ imageBase64: PROBE_PNG_B64, visionConfig: cfg });
  ok('反幻觉：全空图被拒 ok=false', r3.ok === false, JSON.stringify(r3).slice(0, 120));
  ok('反幻觉：code=parse（未编造课表）', r3.code === 'parse', 'code=' + r3.code);

  // ④ HTML 表格兜底：模型不守 JSON 输出 <table>
  CASE = 'schedule_html';
  const r4 = await ocr.main({ imageBase64: PROBE_PNG_B64, visionConfig: cfg });
  ok('HTML兜底：ok=true', r4.ok === true, JSON.stringify(r4).slice(0, 120));
  ok('HTML兜底：解析出语文/数学', (r4.grid || []).some(row => row.includes('语文') && row.includes('数学')), JSON.stringify(r4.grid));

  // ⑤ 模型跑偏（废话非 JSON）→ 必须被拒（ok=false），绝不透传成假课表。
  // 注：v3 的 callVision 对外部源会重试一次仍失败则抛错，errFrom 归为 ai_error（带清晰文案），
  // 与 doOcr 内的 parse 分支不同源；二者都表示「拒绝」，故 code 取 parse/ai_error 均可。
  CASE = 'schedule_garbage';
  const r5 = await ocr.main({ imageBase64: PROBE_PNG_B64, visionConfig: cfg });
  ok('废话：ok=false（被拒，未透传）', r5.ok === false, JSON.stringify(r5).slice(0, 120));
  ok('废话：code ∈ {parse,ai_error}', r5.code === 'parse' || r5.code === 'ai_error', 'code=' + r5.code);

  SERVER.close();
  console.log('\n────────────────────────────────────────');
  console.log('通过 ' + pass + ' / ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail + ' 项：\n  - ' + failures.join('\n  - ') : '   ✓ 全部通过'));
  console.log('\n注：本脚本验证 v3 管线逻辑（外部调用分支/解析/反幻觉/两遍核对/错题转录）。');
  console.log('真实 AI 识别质量需真机 + 云端已配置的外部视觉 API（Key 在云上）实拍验证，本脚本无法替代。');
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('harness error', e); process.exit(2); });

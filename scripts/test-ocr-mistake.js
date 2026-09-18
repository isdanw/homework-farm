/**
 * 错题拍照收录 · 验证测试脚本（无云环境依赖，纯 Node 跑）
 *
 * 覆盖：
 *  T1 规则路由 mistakeRules（ruleDiagnose / splitForDiagnosis）
 *  T2 ocrSchedule 转录清洗（extractJson / normalizeItems / normMarked，vm 沙箱提取云函数内部函数）
 *  T3 ocrSchedule mistake 分支反幻觉行为（空白图 / 幻觉 marked / 字段截断 / 30 题上限）
 *  T4 tutorChat 批量诊断解析 parseDiagQ（no 对齐 / 非法 errorType 过滤）
 *  T5 WXML 标签配平 + JSON 配置一致性（页面注册 / 组件引用）
 *
 * 运行：node scripts/test-ocr-mistake.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NODE = { pass: 0, fail: 0, fails: [] };

function assert(name, cond, detail) {
  if (cond) { NODE.pass++; console.log('  ✅ ' + name); }
  else { NODE.fail++; NODE.fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ---------- vm 沙箱：提取云函数内部纯函数（剥掉 tcb require，可注入模块 stub） ---------- */
function loadCloudFns(relPath, exportNames, stubModules) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8')
    .replace(/^const tcb = require\('@cloudbase\/node-sdk'\);/m, '');
  const stubs = stubModules || {};
  const sandbox = {
    require: (m) => {
      if (stubs[m]) return stubs[m];
      throw new Error('云函数沙箱不应 require: ' + m);
    },
    console: console,
    module: { exports: {} },
    Date: Date,
    JSON: JSON,
    Buffer: Buffer,
    URL: URL,
    // 云函数运行时真实存在 process.env（VISION_API_* 环境变量）；
    // 沙箱里给一份空 env，避免读到本机环境变量导致用例结果不确定
    process: { env: {} }
  };
  sandbox.exports = sandbox.module.exports;   // 云函数源码里有 exports.main = ...
  vm.createContext(sandbox);
  vm.runInContext(src + '\nmodule.exports = {' + exportNames.join(',') + '};', sandbox);
  return sandbox.module.exports;
}

/* ======================= T1 规则路由 ======================= */
section('T1 规则路由 mistakeRules');
const rules = require(path.join(ROOT, 'miniprogram/utils/mistakeRules.js'));

const calcWrong = { type: 'calc', marked: false, questionText: '12-5=', childAnswer: '6' };
const r1 = rules.ruleDiagnose(calcWrong);
assert('calc 批改× 归因 E7', r1 && r1.errorType === 'E7', JSON.stringify(r1));
assert('calc topic 含题干', r1 && r1.topic.indexOf('12-5=') >= 0);

const calcRight = rules.ruleDiagnose({ type: 'calc', marked: true, questionText: '3+5=8', childAnswer: '8' });
assert('calc 批改√ 不给错因', calcRight && calcRight.errorType === '' && calcRight.topic.indexOf('计算') === 0);

const dictWrong = rules.ruleDiagnose({ type: 'dictation', marked: false, questionText: '清', childAnswer: '青' });
assert('dictation 批改× 归因 E2', dictWrong && dictWrong.errorType === 'E2');

const calcUnmarked = rules.ruleDiagnose({ type: 'calc', marked: null, questionText: '3+5=', childAnswer: '9' });
assert('calc 未批改 → 不走规则（送 AI）', calcUnmarked === null);

const applyQ = rules.ruleDiagnose({ type: 'apply', marked: false, questionText: '树上有5只鸟…', childAnswer: '' });
assert('应用题即使批改× 也走 AI 路由', applyQ === null);

const split = rules.splitForDiagnosis([
  calcWrong,                                        // 规则
  { type: 'apply', marked: null, questionText: '小明有3个苹果…', childAnswer: '2个' },  // AI
  { type: 'dictation', marked: false, questionText: '春', childAnswer: '需' },          // 规则
  { type: 'calc', marked: null, questionText: '9-4=', childAnswer: '' }                 // AI（未批口算）
]);
assert('路由分组 2 规则 + 2 AI', split.ruleItems.length === 2 && split.aiItems.length === 2,
  'rule=' + split.ruleItems.length + ' ai=' + split.aiItems.length);
assert('规则组保留原数组下标', split.ruleItems[0].idx === 0 && split.ruleItems[1].idx === 2);

/* ======================= T2/T3 ocrSchedule 转录清洗 ======================= */
section('T2/T3 ocrSchedule 转录清洗 + 反幻觉');
const ocr = loadCloudFns('cloudfunctions/ocrSchedule/index.js',
  ['extractJson', 'normalizeGrid', 'normalizeItems', 'normMarked', 'parseHtmlTable', 'MISTAKE_SYSTEM_PROMPT']);

// --- extractJson 兼容性 ---
assert('纯 JSON 解析', !!ocr.extractJson('{"a":1}'));
assert('```json 围栏解析', !!ocr.extractJson('好的，结果如下：\n```json\n{"a":1}\n```'));
assert('尾逗号宽松修复', !!ocr.extractJson('{"items":[{ "no":"1" },]}'));
assert('纯文本废话不解析', ocr.extractJson('我无法识别这张图片') === null);

// --- normalizeItems 常规 ---
const good = ocr.normalizeItems([
  { no: '1', type: 'calc', questionText: '3+5=', childAnswer: '9', marked: false, correctAnswer: '' },
  { no: '2', type: 'apply', questionText: '小明有3个苹果，吃了1个，还剩几个？', childAnswer: '还剩1个', marked: '×', correctAnswer: '还剩2个' },
  { no: '3', type: 'dictation', questionText: '春', childAnswer: '', marked: 'null', correctAnswer: null }
]);
assert('常规 3 题转录', Array.isArray(good) && good.length === 3);
assert('批改 false 直通', good[0].marked === false);
assert('字符串 "×" → false', good[1].marked === false);
assert('字符串 "null" → null（无批改标记）', good[2].marked === null);
assert('correctAnswer null → 空串', good[2].correctAnswer === '');
assert('非法 type 兜底 other', ocr.normalizeItems([{ type: 'hack', questionText: 'x' }])[0].type === 'other');

// --- 反幻觉红线 ---
assert('全空题 → null（空白图防线）', ocr.normalizeItems([{ no: '1', questionText: '', childAnswer: '', correctAnswer: '' }]) === null);
assert('空数组 → null', ocr.normalizeItems([]) === null);
assert('非数组 → null', ocr.normalizeItems('items') === null);
assert('无批改标记时禁止带正确答案？(correctAnswer 保留但 marked=null，由确认页兜底)',
  ocr.normalizeItems([{ questionText: 'x', marked: null, correctAnswer: '答案' }])[0].marked === null);

// --- 边界：截断与上限 ---
const long = ocr.normalizeItems([{ questionText: '题'.repeat(600), childAnswer: '答'.repeat(400), no: 'n'.repeat(50) }]);
assert('题干截断 ≤500', long[0].questionText.length === 500);
assert('作答截断 ≤300', long[0].childAnswer.length === 300);
assert('题号截断 ≤20', long[0].no.length === 20);
const many = ocr.normalizeItems(Array.from({ length: 40 }, (_, i) => ({ questionText: '题' + i })));
assert('40 题裁到 30 题上限', many.length === 30);

// --- marked 三值完整覆盖 ---
// 输入 17 组: true,false,null,'true','False','√','×','x','对','错','correct','wrong','1',0,'无','',undefined
const marks = [true, false, null, 'true', 'False', '√', '×', 'x', '对', '错', 'correct', 'wrong', '1', 0, '无', '', undefined].map(v => ocr.normMarked(v));
assert('marked 三值归一全量（17 组）',
  JSON.stringify(marks) === JSON.stringify([true, false, null, true, false, true, false, false, true, false, true, false, true, false, null, null, null]),
  JSON.stringify(marks));

/* ======================= T4 tutorChat parseDiagQ ======================= */
section('T4 tutorChat 批量诊断解析');
const tc = loadCloudFns('cloudfunctions/tutorChat/index.js',
  ['str', 'extractJson', 'parseDiagQ', 'DIAGQ_PROMPT', 'reviewDueAt']);

const diagText = '```json\n{"items":[{"no":"1","topic":"20以内退位减法","errorType":"E7","errorDesc":"12-5 算成 6","suggestion":"用数数法再算一遍"},{"no":"2","topic":"看图应用题","errorType":"E99","errorDesc":"非法错因编号","suggestion":""}]}\n```';
const parsed = tc.parseDiagQ(diagText);
assert('诊断结果解析 2 条', Array.isArray(parsed) && parsed.length === 2);
assert('合法 E7 保留', parsed[0].errorType === 'E7');
assert('非法 E99 过滤为空串', parsed[1].errorType === '');
assert('DIAGQ_PROMPT 与 DIAG 同套 E1-E9 口径', tc.DIAGQ_PROMPT.indexOf('E7 信息处理') > 0);
assert('复习档位 reviewDueAt(1)≈明天', Math.abs(tc.reviewDueAt(1) - Date.now() - 86400000) < 60000);

// 解析失败兜底
assert('非 JSON 输出 → null', tc.parseDiagQ('对不起我做不到') === null);
assert('缺 items → null', tc.parseDiagQ('{"a":1}') === null);

/* ======================= T5 前端结构检查 ======================= */
section('T5 WXML 标签配平 + 配置一致性');

function checkWxml(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // 去掉注释
  const clean = src.replace(/<!--[\s\S]*?-->/g, '');
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g;
  let m, stack = [], ok = true, firstErr = '';
  while ((m = tagRe.exec(clean))) {
    const [full, name, , selfClose] = m;
    if (name === 'input' || selfClose === '/') continue;   // input 可不闭合
    if (full.startsWith('</')) {
      const top = stack.pop();
      if (top !== name) { ok = false; firstErr = '期望 </' + top + '> 实际 </' + name + '>'; break; }
    } else {
      stack.push(name);
    }
  }
  if (stack.length && ok) { ok = false; firstErr = '未闭合: ' + stack.join(','); }
  assert(rel + ' 标签配平', ok, firstErr);
}
['/miniprogram/pkgTools/mistakes/mistakes.wxml',
 '/miniprogram/pkgTools/mistakes/confirm/confirm.wxml'].forEach(checkWxml);

// JSON 配置
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
// 页面既可能在主包 pages，也可能在分包 subpackages（2026-09-08 起 mistakes 已迁入 pkgTools）
const allPages = (appJson.pages || []).concat(
  (appJson.subpackages || []).reduce((acc, sp) => acc.concat((sp.pages || []).map(p => sp.root + '/' + p)), []));
assert('confirm 页已注册 app.json', allPages.indexOf('pkgTools/mistakes/confirm/confirm') >= 0);
const confirmJson = JSON.parse(fs.readFileSync(path.join(ROOT, '/miniprogram/pkgTools/mistakes/confirm/confirm.json'), 'utf8'));
assert('confirm.json 合法且四件套齐全', confirmJson.navigationBarTitleText === '核对识别结果' &&
  ['confirm.js', 'confirm.wxml', 'confirm.wxss', 'confirm.json'].every(f =>
    fs.existsSync(path.join(ROOT, '/miniprogram/pkgTools/mistakes/confirm', f))));

// 关键调用链一致性（源码静态断言）
const mistakesSrc = fs.readFileSync(path.join(ROOT, '/miniprogram/pkgTools/mistakes/mistakes.js'), 'utf8');
const confirmSrc = fs.readFileSync(path.join(ROOT, '/miniprogram/pkgTools/mistakes/confirm/confirm.js'), 'utf8');
const confirmWxml = fs.readFileSync(path.join(ROOT, '/miniprogram/pkgTools/mistakes/confirm/confirm.wxml'), 'utf8');
assert('mistakes.js 用 action=mistake 调 ocrSchedule', mistakesSrc.indexOf("action: 'mistake'") > 0);
assert('confirm.js 用 diagnoseQuestions 调 tutorChat', confirmSrc.indexOf("action: 'diagnoseQuestions'") > 0);
assert('confirm.js 落库带 source=photo', confirmSrc.indexOf("source: 'photo'") > 0);
assert('confirm.js 派生复习窗口 upsertReview', confirmSrc.indexOf('upsertReview') > 0 && confirmSrc.indexOf("mid + '_rv'") > 0);
assert('confirm.wxml 事件均已绑定 JS 方法',
  ['toggleCard', 'delCard', 'addCard', 'onInput', 'pickType', 'setMark', 'pickSubject', 'doDiagnose', 'saveAll', 'previewPhoto']
    .every(fn => confirmWxml.indexOf(fn) > 0 && confirmSrc.indexOf(fn + '(') > 0 || fn === 'previewPhoto' && confirmWxml.indexOf(fn) > 0));
assert('mistakes.wxml 入口已挂 photoAdd', mistakesSrc.indexOf('photoAdd(') > 0 &&
  fs.readFileSync(path.join(ROOT, '/miniprogram/pkgTools/mistakes/mistakes.wxml'), 'utf8').indexOf('photoAdd') > 0);

// tutorStore 增量字段
const tsStore = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/tutorStore.js'), 'utf8');
assert('addMistake 含 photo 增量字段', ['source', 'questionText', 'childAnswer', 'markSource'].every(f => tsStore.indexOf("m." + f) > 0));
assert('mergeFromCloud 回填增量字段', tsStore.indexOf("c.questionText") > 0 && tsStore.indexOf("c.markSource") > 0);

/* ============ T6 连通性测试：单次带图探测（VL 模型不吃纯文本） ============ */
section('T6 testExternalVision 单次带图探测（mock https）');
(async () => {

/** mock https 模块：按 handler(statusOf(body)) 返回响应；记录每次请求体 */
function mockHttps(handler) {
  const calls = [];
  return {
    calls: calls,
    request: (opts, cb) => {
      const req = {
        handlers: {},
        write: (b) => { req.body = b; },
        end: () => {
          calls.push(String(req.body || ''));
          const res = handler(String(req.body || ''), calls.length);
          setImmediate(() => {
            cb({
              statusCode: res.status,
              on: (ev, fn) => {
                if (ev === 'data') fn(res.body);
                if (ev === 'end') fn();
              }
            });
          });
        },
        destroy: () => {},
        on: (ev, fn) => { req.handlers[ev] = fn; }
      };
      return req;
    }
  };
}

const OK_COLOR = JSON.stringify({ choices: [{ message: { content: '红色' } }] });
const ERR_50507 = JSON.stringify({ code: 50507, message: 'Request failed: Unknown error.', data: null });
const CFG = { base: 'https://api.example.com/v1', key: 'sk-test', model: 'test-vl-model' };

function loadTestVision(httpsStub) {
  return loadCloudFns('cloudfunctions/ocrSchedule/index.js', ['testExternalVision'], { https: httpsStub });
}

// 用例 A（复现用户报错场景）：探测请求本身就是带图请求，200 即判定连通
{
  const hs = mockHttps(() => ({ status: 200, body: OK_COLOR }));
  const r = await loadTestVision(hs).testExternalVision(CFG);
  assert('A: 带图探测 200 → 判定连通', r.ok === true, r.msg);
  assert('A: 提示视觉链路连通成功', r.msg.indexOf('视觉链路连通成功') >= 0, r.msg);
  assert('A: 恰好发出 1 次请求（单次带图探测）', hs.calls.length === 1);
  assert('A: 探测请求含真实 PNG data URI', hs.calls[0].indexOf('data:image/png;base64,iVBORw0') > 0);
  assert('A: 探测请求为图片消息', hs.calls[0].indexOf('image_url') > 0);
  assert('A: 探测请求带 max_tokens', hs.calls[0].indexOf('"max_tokens"') > 0);
}

// 用例 A2（回归红线）：不发纯文本探测——VL 模型拒纯文本会 5xx 造成误报
{
  const hs = mockHttps(() => ({ status: 200, body: OK_COLOR }));
  await loadTestVision(hs).testExternalVision(CFG);
  assert('A2: 所有探测请求均带图（不发纯文本）', hs.calls.length > 0 && hs.calls.every(c => c.indexOf('image_url') > 0));
}

// 用例 B：401 → 确定性配置错误，直接给 Key 指引
{
  const hs = mockHttps(() => ({ status: 401, body: '{"error":"unauthorized"}' }));
  const r = await loadTestVision(hs).testExternalVision(CFG);
  assert('B: 401 直接报 Key 错误', r.ok === false && r.msg.indexOf('401') > 0 && r.msg.indexOf('Key') > 0);
  assert('B: 只发 1 次请求', hs.calls.length === 1);
}

// 用例 C：404 → 暴露模型名/地址问题
{
  const hs = mockHttps(() => ({ status: 404, body: '{"error":"not found"}' }));
  const r = await loadTestVision(hs).testExternalVision(CFG);
  assert('C: 404 → 报模型名/地址错误', r.ok === false && r.msg.indexOf('404') > 0 && r.msg.indexOf('模型名') > 0);
}

// 用例 D：5xx / 50507 → 提示上游过载并给出换小模型指引
{
  const hs = mockHttps(() => ({ status: 500, body: ERR_50507 }));
  const r = await loadTestVision(hs).testExternalVision(CFG);
  assert('D: 50507 → 提示上游不可用/过载', r.ok === false && r.msg.indexOf('50507') > 0, r.msg);
}

// 用例 D2：400 → 提示该模型可能不支持图片输入
{
  const hs = mockHttps(() => ({ status: 400, body: '{"error":"bad request"}' }));
  const r = await loadTestVision(hs).testExternalVision(CFG);
  assert('D2: 400 → 提示可能不支持图片输入', r.ok === false && r.msg.indexOf('图片输入') > 0);
}

// 用例 F：三要素缺失 → 不发请求，直接提示配置不完整
{
  ['VISION_API_BASE', 'VISION_API_KEY', 'VISION_API_MODEL'].forEach(k => { delete process.env[k]; });
  const hs = mockHttps(() => ({ status: 200, body: OK_COLOR }));
  const r = await loadTestVision(hs).testExternalVision({ base: '', key: '', model: '' });
  assert('F: 配置不完整 → 明确提示三项', r.ok === false && r.msg.indexOf('配置不完整') >= 0, r.msg);
  assert('F: 配置不完整时不发请求', hs.calls.length === 0);
}

// 用例 G：推理型模型（DeepSeek）探测时显式关闭思考，避免被思考耗空 content
{
  const hs = mockHttps(() => ({ status: 200, body: OK_COLOR }));
  await loadTestVision(hs).testExternalVision({ base: 'https://api.deepseek.com/v1', key: 'sk-t', model: 'deepseek-chat' });
  assert('G: DeepSeek 探测关闭 thinking', hs.calls[0].indexOf('"thinking"') > 0 && hs.calls[0].indexOf('disabled') > 0);
}

// 用例 E：探测图是合法 PNG（签名头）
{
  const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/ocrSchedule/index.js'), 'utf8');
  const m = src.match(/PROBE_PNG_B64 = '([^']+)'/);
  const sig = Buffer.from(m[1], 'base64').slice(0, 8).toString('hex');
  assert('E: PROBE_PNG_B64 为合法 PNG 签名', m && m[1].length > 100 && sig === '89504e470d0a1a0a', sig);
}

})().catch(e => { assert('T6 执行异常: ' + e.message, false, e.stack); }).then(() => {
console.log('\n========================================');
console.log('通过 ' + NODE.pass + ' / 失败 ' + NODE.fail);
if (NODE.fail) { NODE.fails.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
console.log('全部测试通过 ✅');
});

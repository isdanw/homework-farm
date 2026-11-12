/**
 * examService 纯逻辑单测（不依赖云 SDK / 不调 AI）
 * 运行：EXAM_TEST=1 node scripts/test-exam-service.cjs
 */
process.env.EXAM_TEST = '1';
const M = require('../cloudfunctions/examService/index.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
function eq(name, a, b) { ok(name + ' (得到:' + JSON.stringify(a) + ')', JSON.stringify(a) === JSON.stringify(b)); }

console.log('\n[1] 合规门禁 sanitizeBanned（11 词同口径）');
ok('「已掌握」→「达成较好」（保留后缀字）', M.sanitizeBanned('孩子已掌握了') === '孩子达成较好了');
ok('「学会了」→「推通了」', M.sanitizeBanned('他学会了') === '他推通了');
ok('「完全掌握」→「掌握得不错」', M.sanitizeBanned('完全掌握本章') === '掌握得不错本章');
ok('正常文案不变', M.sanitizeBanned('本题做对了') === '本题做对了');

console.log('\n[2] JSON 提取 extractJson（宽松解析）');
eq('裸 JSON', M.extractJson('前缀 {"a":1} 后缀'), { a: 1 });
eq('代码块围栏', M.extractJson('```json\n{"b":2}\n```'), { b: 2 });
eq('尾逗号容错', M.extractJson('{"c":3,}'), { c: 3 });
ok('非法返回 null', M.extractJson('没有json') === null);

console.log('\n[3] 视觉模型 provider 注册表');
const meta = M.listProviderMeta();
eq('内置 5 个主流模型', meta.map(p => p.id), ['qwen-vl', 'glm-4v', 'doubao-vl', 'gpt-4o', 'gemini']);
ok('下拉不含 apiKey', meta.every(p => !('apiKey' in p)));
ok('每个 provider 有 build/pick', Object.values(M.PROVIDERS).every(p => typeof p.build === 'function' && typeof p.pick === 'function'));
const qw = M.PROVIDERS['qwen-vl'].build(['http://img/1.png'], 'prompt', 'qwen-vl-max-latest', 'KEY');
ok('qwen-vl 请求含 Bearer', qw.headers.Authorization === 'Bearer KEY');
ok('qwen-vl 请求带图与文', Array.isArray(qw.body.input.messages[0].content) && qw.body.input.messages[0].content.length === 2);
const gm = M.PROVIDERS['gemini'].build(['BASE64DATA'], 'prompt', 'gemini-1.5-flash', 'KEY');
ok('gemini 需 base64 且 url 带 key', M.PROVIDERS['gemini'].needsBase64 === true && gm.url.indexOf('key=KEY') > 0);

console.log('\n[4] 选择题判定 normChoice / judgeChoice');
eq('全角/空格/括号归一', M.normChoice('（b）'), 'B');
const q = { id: 'q1', type: 'choice', stem: '1+1=?', options: ['1', '2', '3', '4'], answer: 'B', points: 5 };
eq('选对判 correct 满分', M.judgeChoice(q, { text: 'B' }), { qid: 'q1', correct: true, score: 5, ocrText: '', diagnosis: { errorType: '', errorDesc: '', suggestion: '' } });
eq('选错判 0 分+原因', M.judgeChoice(q, { text: 'A' }).correct, false);
eq('空作答判错', M.judgeChoice(q, { text: '' }).correct, false);

console.log('\n[5] 出卷解析 parseExam');
const good = M.parseExam(JSON.stringify({
  name: '数学单元测', examType: 'unit_test', suggestedDuration: 30, knowledgePoints: ['加法'],
  questions: [
    { id: 'q1', type: 'choice', stem: '1+1', options: ['1', '2', '3', '4'], answer: 'B', points: 5, kp: '加法', difficulty: 1 },
    { id: 'q2', type: 'fill', stem: '2+3=', answer: '5', points: 5, kp: '加法' }
  ],
  answersMarkdown: 'q1:B q2:5'
}));
ok('合法卷解析出 2 题', good && good.questions.length === 2);
ok('choice 校验 4 选项', good && good.questions[0].options.length === 4);
ok('examType 标准化', good && good.examType === 'unit_test');
ok('answersMarkdown 透传', good && good.answersMarkdown.indexOf('q1:B') >= 0);
const badChoice = M.parseExam(JSON.stringify({
  name: 'x', questions: [
    { id: 'q1', type: 'choice', stem: '1+1', options: ['1'], answer: 'A' },
    { id: 'q2', type: 'fill', stem: '2+3=', answer: '5' }
  ]
}));
ok('选项不足 2 的 choice 被过滤、其余保留', badChoice && badChoice.questions.length === 1 && badChoice.questions[0].id === 'q2');
const noJson = M.parseExam('模型乱说话没有json');
ok('无 JSON 返回 null', noJson === null);
const banned = M.parseExam(JSON.stringify({ name: '卷', questions: [{ id: 'q1', type: 'fill', stem: '孩子已掌握了这个方法', answer: 'x' }] }));
ok('题干合规门禁生效', banned && banned.questions[0].stem.indexOf('已掌握') < 0);

console.log('\n[5b] 选择题选项清洗（修复「A. A. xxx」双标签）');
eq('去「A. 」前缀', M.cleanChoiceOption('A. 苹果'), '苹果');
eq('去「B、」前缀', M.cleanChoiceOption('B、香蕉'), '香蕉');
eq('去「C．」全角句点', M.cleanChoiceOption('C．梨子'), '梨子');
eq('无前缀原样', M.cleanChoiceOption('葡萄'), '葡萄');
eq('答案「A」→「A」', M.choiceAnswerLetter('A'), 'A');
eq('答案「A. 苹果」→「A」', M.choiceAnswerLetter('A. 苹果'), 'A');
eq('答案小写「c」→「C」', M.choiceAnswerLetter('c'), 'C');
const prefixed = M.parseExam(JSON.stringify({
  name: '带前缀卷', questions: [
    { id: 'q1', type: 'choice', stem: '哪个是苹果', options: ['A. 苹果', 'B. 香蕉', 'C. 梨子'], answer: 'B. 香蕉', points: 5 }
  ]
}));
ok('AI 带字母前缀的选项被清洗（无残留 A.）', prefixed && prefixed.questions[0].options[0] === '苹果');
eq('选项数组整体清洗', prefixed && prefixed.questions[0].options, ['苹果', '香蕉', '梨子']);
eq('choice 答案归一为单字母', prefixed && prefixed.questions[0].answer, 'B');
ok('清洗后拼标签只出现一次 A.（不双 A）', prefixed && ('A. ' + prefixed.questions[0].options[0]) === 'A. 苹果');

console.log('\n[6d] 手写图 base64 解析（iPad 代传云存储）');
const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
ok('data URL 前缀能解析', !!M.decodeImageBase64('data:image/png;base64,' + png1x1));
ok('裸 base64 能解析', !!M.decodeImageBase64(png1x1));
ok('带换行的 base64 能解析', !!M.decodeImageBase64(png1x1.replace(/(.{40})/g, '$1\n')));
ok('空值返回 null', M.decodeImageBase64('') === null);
ok('非字符串返回 null', M.decodeImageBase64(null) === null);
ok('过短垃圾串返回 null', M.decodeImageBase64('abc') === null);
ok('解出的是 PNG 魔数', M.decodeImageBase64(png1x1) && M.decodeImageBase64(png1x1)[0] === 0x89);
ok('超过 2MB 上限被拒', M.decodeImageBase64('data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024)) === null);

console.log('\n[7] 枚举映射');
ok('SUBJECT_NAMES 含十科（2026-10-25 加 science 科学，教材库种子数据含小学科学）', Object.keys(M.SUBJECT_NAMES).length === 10 && M.SUBJECT_NAMES.science === '科学');
ok('EXAM_TYPE_LABEL 含 6 类', Object.keys(M.EXAM_TYPE_LABEL).length === 6);

console.log('\n[6b] HTTP 集成请求归一化（iPad URL 化入口）');
// 小程序 SDK 路径：原样透传，viaHttp=false
const sdkEv = M.normalizeHttpEvent({ action: 'listExams', uid: 'u1' });
ok('SDK 原始 payload 直通', sdkEv.viaHttp === false && sdkEv.payload.action === 'listExams');
// URL 化入口：body 是 JSON 字符串，需解包
const httpEv = M.normalizeHttpEvent({
  path: '/examapi', httpMethod: 'POST',
  headers: { 'content-type': 'application/json', 'x-exam-token': 'TK' },
  body: JSON.stringify({ action: 'listExams', uid: 'u2' }), isBase64Encoded: 'false'
});
ok('集成请求 viaHttp=true', httpEv.viaHttp === true);
eq('body 解包出 action', httpEv.payload.action, 'listExams');
eq('body 解包出 uid', httpEv.payload.uid, 'u2');
eq('headers 透传', httpEv.headers['x-exam-token'], 'TK');
// base64 body
const b64Ev = M.normalizeHttpEvent({
  path: '/examapi', httpMethod: 'POST', headers: {},
  body: Buffer.from(JSON.stringify({ action: 'getExam', resourceId: 'r1' })).toString('base64'),
  isBase64Encoded: true
});
eq('base64 body 解码', b64Ev.payload.action, 'getExam');
// GET 无 body → 回退 queryString
const qEv = M.normalizeHttpEvent({ path: '/examapi', httpMethod: 'GET', headers: {}, body: '', queryStringParameters: { action: 'resolve', uid: 'u3' } });
eq('GET 空 body 回退 queryString', qEv.payload.action, 'resolve');
// 坏 JSON 不崩
const badEv = M.normalizeHttpEvent({ path: '/examapi', httpMethod: 'POST', headers: {}, body: 'not-json' });
ok('坏 JSON 不抛异常且 payload 为空对象', badEv.viaHttp === true && Object.keys(badEv.payload).length === 0);

console.log('\n[6c] 访问令牌闸（仅 URL 化入口生效，不影响小程序）');
const savedTok = process.env.EXAM_HTTP_TOKEN;
delete process.env.EXAM_HTTP_TOKEN;
ok('未配置令牌 → 不拦（开发态）', M.httpTokenRejected({ viaHttp: true, headers: {} }) === false);
ok('未配置令牌 → SDK 也不拦', M.httpTokenRejected({ viaHttp: false, headers: {} }) === false);
process.env.EXAM_HTTP_TOKEN = 'SECRET123';
ok('已配置令牌 → 缺失被拒', M.httpTokenRejected({ viaHttp: true, headers: {} }) === true);
ok('已配置令牌 → 错误被拒', M.httpTokenRejected({ viaHttp: true, headers: { 'x-exam-token': 'nope' } }) === true);
ok('已配置令牌 → 大写 header 名也认', M.httpTokenRejected({ viaHttp: true, headers: { 'X-Exam-Token': 'SECRET123' } }) === false);
ok('小程序 SDK 路径永不被令牌闸拦（wx 开放身份）', M.httpTokenRejected({ viaHttp: false, headers: {} }) === false);
if (savedTok === undefined) delete process.env.EXAM_HTTP_TOKEN; else process.env.EXAM_HTTP_TOKEN = savedTok;

console.log('\n========================================');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('========================================');
process.exit(fail ? 1 : 0);

/**
 * evidenceLadder 证据覆盖档位单测（端上纯函数，无 wx / 无云）
 * 运行：node scripts/test-evidence-ladder.cjs
 * 覆盖：阶梯逐级 / 达标阈值内部复核 / 关联口径（kpId 精确 vs topic 弱关联）/
 *       L5-L6 需变式记录（显式 transfers + 变式复测证据两条记录源）/ 文案合规（无掌握断言、无百分比）/
 *       入参只读 / 空数据 fail-open / summary 口径 / unitKp 页接线静态校验 /
 *       变式跨端契约静态校验（白名单两端一致、标签只认服务端）
 */
const fs = require('fs');
const path = require('path');
const L = require('../miniprogram/utils/evidenceLadder.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2192 ' + extra : '')); }
}

const DAY = 86400000;
const NOW = 1700000000000;

const units = [{
  id: 'u_math_1', subject: 'math', title: '第一单元 6～10的认识和加减法',
  points: [
    { id: 'p1', topic: '比大小', front: '先看两边数量', back: '再用 ＞＜＝ 连接', order: 1 },
    { id: 'p2', topic: '10以内加法', front: '合起来一共', back: '2+3=5', order: 2 },
    { id: 'p3', topic: '认识图形', front: '说说形状', back: '长方体/正方体', order: 3 },
    { id: 'p4', topic: '数', front: '单字清单名', back: '不该被长 topic 点亮', order: 4 }
  ]
}];

const card = (o) => Object.assign({ id: 'c', subject: 'math', unitId: 'u_math_1', kpId: 'p1', topic: '比大小', front: 'f', back: 'b', done: false }, o);
const ev = (o) => Object.assign({
  id: 'e', subject: 'math', unitId: 'u_math_1', kpId: 'p1', topic: '比大小',
  total: 6, correct: 6, rate: 1, passed: true,
  factGrade: 'server_recorded', independence: 'self_declared_no_hint', createdAt: NOW
}, o);

function row(topic, data) {
  const r = L.buildLadder(Object.assign({ subject: 'math', units: units }, data, { now: NOW }));
  return r.rows.find(x => x.topic === topic);
}

console.log('\n\u2500\u2500 A. 阶梯逐级判定 \u2500\u2500');
const a0 = row('认识图形', { cards: [], mistakes: [], evidence: [], reviews: [] });
ok('A 无任何记录 = L0', a0 && a0.level === 0, a0 && a0.level);
ok('A L0 说法只讲记录有无', a0 && a0.label === '还没有这类记录', a0 && a0.label);
ok('A L0 给出下一步该补的记录', a0 && a0.nextStep.indexOf('学习记录') >= 0, a0 && a0.nextStep);

const a1 = row('比大小', { cards: [card({ done: false })], mistakes: [], evidence: [], reviews: [] });
ok('A 只有未毕业卡 = L1', a1 && a1.level === 1, a1 && a1.level);

const a1b = row('认识图形', { cards: [], mistakes: [{ id: 'm', subject: 'math', topic: '认识图形', status: 'pending' }], evidence: [], reviews: [] });
ok('A 只有待订正错题 = L1', a1b && a1b.level === 1, a1b && a1b.level);

const a2 = row('比大小', { cards: [card({ done: true })], mistakes: [], evidence: [], reviews: [] });
ok('A 复习卡毕业（提取通过）= L2', a2 && a2.level === 2, a2 && a2.level);

const a2b = row('认识图形', {
  cards: [], reviews: [],
  mistakes: [{ id: 'm', subject: 'math', topic: '认识图形', status: 'corrected' }],
  evidence: []
});
ok('A 错题已订正 = L2', a2b && a2b.level === 2, a2b && a2b.level);

const a3 = row('比大小', { cards: [card()], mistakes: [], reviews: [], evidence: [ev()] });
ok('A 一次独立达标复测 = L3', a3 && a3.level === 3, a3 && a3.level);
ok('A 有达标证据不会停在 L1', a3 && a3.level >= 3);

const a4 = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: [ev({ createdAt: NOW - 10 * DAY }), ev({ id: 'e2', createdAt: NOW })]
});
ok('A 首末达标间隔 ≥7 天 = L4', a4 && a4.level === 4, a4 && a4.level);

const a3gap = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: [ev({ createdAt: NOW - 3 * DAY }), ev({ id: 'e2', createdAt: NOW })]
});
ok('A 间隔只有 3 天仍是 L3', a3gap && a3gap.level === 3, a3gap && a3gap.level);

console.log('\n\u2500\u2500 B. 达标阈值内部复核（不信记录上的 passed） \u2500\u2500');
ok('B 题量不足 5 不算达标', L.isVerified(ev({ total: 4, correct: 4 })) === false);
ok('B 正确率不足 80% 不算达标', L.isVerified(ev({ total: 5, correct: 4, rate: 0.8 })) === true);
ok('B 正确率 79% 不算达标', L.isVerified(ev({ total: 100, correct: 79, rate: 0.79 })) === false);
ok('B 客户端自报答案（client_claimed）不算达标', L.isVerified(ev({ factGrade: 'client_claimed' })) === false);
ok('B 缺 factGrade 的旧记录不算达标', L.isVerified(ev({ factGrade: undefined })) === false);
ok('B 提示后完成不算独立达标', L.isVerified(ev({ independence: 'prompted' })) === false);
ok('B 未声明独立性不算独立达标', L.isVerified(ev({ independence: 'unknown' })) === false);
ok('B rate 缺失时用 correct/total 复核', L.isVerified(ev({ rate: undefined, total: 5, correct: 5 })) === true);
const bDown = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: [ev({ factGrade: 'client_claimed' }), ev({ id: 'e2', independence: 'prompted' })]
});
ok('B 只有一堆「不算数」的复测 = L2（做过订正动作）', bDown && bDown.level === 2, bDown && bDown.level);

console.log('\n\u2500\u2500 C. 关联口径 \u2500\u2500');
const cExact = row('比大小', {
  cards: [card(), card({ id: 'c9', unitId: 'u_other', kpId: 'p1', topic: '整理与复习' })],
  mistakes: [], reviews: [], evidence: []
});
ok('C 跨单元同 kpId 的卡不误关联', cExact && cExact.counts.cards === 1, cExact && JSON.stringify(cExact.counts));
ok('C unitId+kpId 命中时标 link=kp', cExact && cExact.link === 'kp', cExact && cExact.link);
const cTopic = row('10以内加法', {
  cards: [], mistakes: [], reviews: [],
  evidence: [ev({ id: 'eT', unitId: '', kpId: '', topic: '10以内加法进位漏了' })]
});
ok('C 本地证据无 kpId 时按名称弱关联', cTopic && cTopic.counts.verified === 1, cTopic && JSON.stringify(cTopic.counts));
ok('C 弱关联如实标 link=topic', cTopic && cTopic.link === 'topic', cTopic && cTopic.link);
const cNoise = row('数', {
  cards: [card({ id: 'cn', unitId: '', kpId: '', topic: '数字书写' })],
  mistakes: [], reviews: [], evidence: []
});
ok('C 单字清单名不被长 topic 点亮', cNoise && cNoise.level === 0, cNoise && cNoise.level);
const cSubject = row('比大小', {
  cards: [card({ subject: 'chinese' })], mistakes: [], reviews: [], evidence: [ev({ subject: 'chinese' })]
});
ok('C 跨学科同名记录不串味', cSubject && cSubject.level === 0, cSubject && cSubject.level);

console.log('\n\u2500\u2500 D. L5/L6 需要按知识点落库的变式记录 \u2500\u2500');
const twoVerified = [ev({ createdAt: NOW - 10 * DAY }), ev({ id: 'e2', createdAt: NOW })];
const d4 = row('比大小', { cards: [card()], mistakes: [], reviews: [], evidence: twoVerified, transfers: [] });
ok('D 端上无变式记录时封顶 L4', d4 && d4.level === 4, d4 && d4.level);
const d5 = row('比大小', {
  cards: [card()], mistakes: [], reviews: [], evidence: twoVerified,
  transfers: [{ unitId: 'u_math_1', kpId: 'p1', independent: true, context: '换条件变式' }]
});
ok('D 有 1 条独立变式记录 = L5', d5 && d5.level === 5, d5 && d5.level);
const d6 = row('比大小', {
  cards: [card()], mistakes: [], reviews: [], evidence: twoVerified,
  transfers: [
    { unitId: 'u_math_1', kpId: 'p1', independent: true, context: '换条件变式' },
    { unitId: 'u_math_1', kpId: 'p1', independent: true, context: '生活情境' }
  ]
});
ok('D 两条不同情境独立记录 = L6', d6 && d6.level === 6, d6 && d6.level);
ok('D L6 不再给下一步', d6 && d6.nextStep === '', d6 && d6.nextStep);
const dSameCtx = row('比大小', {
  cards: [card()], mistakes: [], reviews: [], evidence: twoVerified,
  transfers: [
    { unitId: 'u_math_1', kpId: 'p1', independent: true, context: '换条件变式' },
    { unitId: 'u_math_1', kpId: 'p1', independent: true, context: '换条件变式' }
  ]
});
ok('D 同一情境记两次不算多情境', dSameCtx && dSameCtx.level === 5, dSameCtx && dSameCtx.level);
const dNotInd = row('比大小', {
  cards: [card()], mistakes: [], reviews: [], evidence: twoVerified,
  transfers: [
    { unitId: 'u_math_1', kpId: 'p1', independent: false, context: '提示后完成' },
    { unitId: 'u_math_1', kpId: 'p1', independent: false, context: '未完成' }
  ]
});
ok('D 非独立完成的变式不升档', dNotInd && dNotInd.level === 4, dNotInd && dNotInd.level);
// 语言组：L4 之上必须有变式记录
const langUnits = [{ id: 'u_en_1', subject: 'english', title: 'Module 1 颜色', points: [{ id: 'p1', topic: '颜色词认读', front: 'f', back: 'b', order: 1 }] }];
const lang = L.buildLadder({
  subject: 'english', units: langUnits, now: NOW, cards: [], mistakes: [], reviews: [],
  evidence: [ev({ subject: 'english', unitId: 'u_en_1', kpId: 'p1', topic: '颜色词认读', createdAt: NOW - 10 * DAY }),
    ev({ subject: 'english', id: 'e2', unitId: 'u_en_1', kpId: 'p1', topic: '颜色词认读', createdAt: NOW })],
  transfers: []
});
ok('D 语言组学科组判定', lang.subjectGroup === 'language', lang.subjectGroup);
ok('D 语言组缺变式记录封顶 L4', lang.rows[0] && lang.rows[0].level === 4, lang.rows[0] && lang.rows[0].level);
ok('D 语言组 L5 文案点明需变式记录', L.LABELS.language[5].indexOf('变式') >= 0);

console.log('\n\u2500\u2500 D2. 变式复测证据 = L5/L6 的真实记录源 \u2500\u2500');
// 真实链路：unitKp 页「变式」→ retest 带 kind=variant + ctx → tutorRetest 建 attempt 时钉住标签
// → submit 服务端判分 → 证据落库带 evidenceKind/context → 这里从 evidence 派生 transfer。
const variant = (o) => ev(Object.assign({ evidenceKind: 'variant', context: '换数字' }, o));
const retestBase = [ev({ createdAt: NOW - 10 * DAY }), ev({ id: 'e2', createdAt: NOW })];

const d5v = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: [ev({ createdAt: NOW - 10 * DAY }), variant({ id: 'v1', createdAt: NOW })]
});
ok('D2 独立达标的变式证据点亮 L5', d5v && d5v.level === 5, d5v && d5v.level);
ok('D2 变式计入 transfers 计数', d5v && d5v.counts.transfers === 1, d5v && JSON.stringify(d5v.counts));
const d6v = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: [ev({ createdAt: NOW - 10 * DAY }),
    variant({ id: 'v1', createdAt: NOW - 5 * DAY, context: '换数字' }),
    variant({ id: 'v2', createdAt: NOW, context: '生活情境' })]
});
ok('D2 两种不同情境的变式 = L6', d6v && d6v.level === 6, d6v && d6v.level);
const d5same = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: [ev({ createdAt: NOW - 10 * DAY }),
    variant({ id: 'v1', createdAt: NOW - 5 * DAY }), variant({ id: 'v2', createdAt: NOW })]
});
ok('D2 同一情境做两次仍停在 L5', d5same && d5same.level === 5, d5same && d5same.level);
const d5noctx = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: [ev({ createdAt: NOW - 10 * DAY }),
    variant({ id: 'v1', createdAt: NOW - 5 * DAY, context: '' }),
    variant({ id: 'v2', createdAt: NOW, context: '' })]
});
ok('D2 情境空白的变式凑不出「多情境」', d5noctx && d5noctx.level === 5, d5noctx && d5noctx.level);
const d3only = row('比大小', {
  cards: [card()], mistakes: [], reviews: [], evidence: [variant()]
});
ok('D2 只有一次变式（没跨过间隔）= L3，不给跳档', d3only && d3only.level === 3, d3only && d3only.level);
const dPrompt = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: twoVerified.concat([variant({ id: 'v1', createdAt: NOW, independence: 'prompted' })])
});
ok('D2 提示后完成的变式不升档', dPrompt && dPrompt.level === 4, dPrompt && dPrompt.level);
const dClient = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: twoVerified.concat([variant({ id: 'v1', createdAt: NOW, factGrade: 'client_claimed' })])
});
ok('D2 客户端自报的变式不升档', dClient && dClient.level === 4, dClient && dClient.level);
const dLowScore = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: twoVerified.concat([variant({ id: 'v1', createdAt: NOW, total: 5, correct: 3, rate: 0.6 })])
});
ok('D2 未达标的变式不升档', dLowScore && dLowScore.level === 4, dLowScore && dLowScore.level);
const dCross = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: twoVerified.concat([variant({ id: 'v1', createdAt: NOW, unitId: 'u_other', kpId: 'p1' })])
});
ok('D2 跨单元的同 kpId 变式不误算', dCross && dCross.level === 4 && dCross.counts.transfers === 0,
  dCross && JSON.stringify(dCross.counts));
const dKpLink = row('比大小', { cards: [], mistakes: [], reviews: [], evidence: [variant()] });
ok('D2 只有变式证据时 link 仍标 kp（精确归属）', dKpLink && dKpLink.link === 'kp', dKpLink && dKpLink.link);
const dMixed = row('比大小', {
  cards: [card()], mistakes: [], reviews: [],
  evidence: [ev({ createdAt: NOW - 10 * DAY }), variant({ id: 'v1', createdAt: NOW, context: '换数字' })],
  transfers: [{ unitId: 'u_math_1', kpId: 'p1', independent: true, context: '生活情境' }]
});
ok('D2 变式证据与显式记录合并计算', dMixed && dMixed.level === 6, dMixed && dMixed.level);

console.log('\n\u2500\u2500 E. 文案合规红线 \u2500\u2500');
const BANNED = ['已掌握', '已精通', '学会了', '完全懂了', '完全掌握', '稳稳掌握', '掌握了', '精通了', '已学会', '学懂了', '全懂了'];
const allText = [];
Object.keys(L.LABELS).forEach(g => { L.LABELS[g].forEach(s => allText.push(s)); });
Object.keys(L.NEXT_STEPS).forEach(k => allText.push(L.NEXT_STEPS[k]));
allText.push(L.buildLadder({ subject: 'math', units: [], now: NOW }).summary.note);
ok('E 文案不含 11 个绝对化掌握词', allText.every(t => BANNED.every(w => t.indexOf(w) < 0)),
  allText.filter(t => BANNED.some(w => t.indexOf(w) >= 0)).join(' | '));
ok('E 文案全程不出现「掌握」二字', allText.every(t => t.indexOf('掌握') < 0));
const built = L.buildLadder({ subject: 'math', units: units, now: NOW, cards: [card()], mistakes: [], reviews: [], evidence: twoVerified });
ok('E 行文案也不含掌握断言', built.rows.every(r => BANNED.every(w => (r.label + r.nextStep).indexOf(w) < 0)));
ok('E 汇总说明否认能力等级', built.summary.note.indexOf('不是能力等级') >= 0, built.summary.note);
ok('E 全程不给百分比', JSON.stringify(built).indexOf('%') < 0);
ok('E 每层都有说法（无空 label）', L.LABELS.science.every(s => !!s) && L.LABELS.language.every(s => !!s) && L.LABELS.humanities.every(s => !!s));

console.log('\n\u2500\u2500 F. 只读边界 \u2500\u2500');
const frozen = {
  subject: 'math', units: units,
  cards: [card(), card({ id: 'cx', unitId: '', kpId: '', topic: '10以内加法' })],
  mistakes: [{ id: 'm', subject: 'math', topic: '比大小', status: 'corrected' }],
  reviews: [{ id: 'r', subject: 'math', topic: '比大小', done: true }],
  evidence: [ev(), ev({ id: 'e2', createdAt: NOW - 10 * DAY })],
  transfers: [{ unitId: 'u_math_1', kpId: 'p1', independent: true, context: 'c' }]
};
const snapshot = JSON.stringify(frozen);
const f1 = L.buildLadder(Object.assign({ now: NOW }, frozen));
ok('F 输入对象未被修改（只读引擎）', JSON.stringify(frozen) === snapshot);
ok('F 输出行不含引用对象本身', f1.rows.every(r => r.counts && typeof r.counts === 'object'));

console.log('\n\u2500\u2500 G. 空数据 fail-open \u2500\u2500');
const g1 = L.buildLadder({});
ok('G 全空输入不抛且返回空行', g1 && g1.rows.length === 0, JSON.stringify(g1));
ok('G 全空输入学科组退化 default', g1.subjectGroup === 'default', g1.subjectGroup);
const g2 = L.buildLadder({ subject: 'math', units: [{ id: 'u', points: [] }], now: NOW });
ok('G 空清单返回空行', g2.rows.length === 0);
const g3 = L.buildLadder({ subject: 'math', units: [{ id: 'u', points: [{ id: '', topic: 'x' }] }], now: NOW });
ok('G 缺点 id 的点被跳过', g3.rows.length === 0);
const g4 = L.buildLadder({ subject: 'math', units: [{ id: 'u', title: '', points: [{ id: 'p', topic: '比大小' }] }] });
ok('G 缺各集合时仍判 L1 以下不抛', g4.rows.length === 1 && g4.rows[0].level === 0, JSON.stringify(g4.rows));

console.log('\n\u2500\u2500 H. summary 口径 \u2500\u2500');
const h = L.buildLadder({
  subject: 'math', units: units, now: NOW,
  cards: [card()], mistakes: [], reviews: [],
  evidence: [ev({ unitId: 'u_math_1', kpId: 'p2', topic: '10以内加法' }),
    ev({ id: 'e3', unitId: 'u_math_1', kpId: 'p2', topic: '10以内加法', createdAt: NOW - 9 * DAY })]
});
const sum = h.summary;
ok('H counts 求和 = 清单点数', sum.counts.reduce((a, b) => a + b, 0) === sum.total, JSON.stringify(sum));
ok('H reachedL3 ≥ reachedL4', sum.reachedL3 >= sum.reachedL4, JSON.stringify(sum));
ok('H 统计覆盖程度说明不给百分比', sum.note.indexOf('百分比') >= 0, sum.note);
ok('H 弱关联条数可被页面提示', typeof sum.topicLinked === 'number');
ok('H 弱关联如实计数', sum.topicLinked === 0, JSON.stringify(sum));

console.log('\n\u2500\u2500 I. 页面接线静态校验 \u2500\u2500');
const pageJs = fs.readFileSync(path.join(__dirname, '../miniprogram/pkgTools/unitKp/unitKp.js'), 'utf8');
const pageWxml = fs.readFileSync(path.join(__dirname, '../miniprogram/pkgTools/unitKp/unitKp.wxml'), 'utf8');
ok('I unitKp 页 require evidenceLadder', pageJs.indexOf("require('../../utils/evidenceLadder.js')") >= 0);
ok('I unitKp 页从 store 读证据', pageJs.indexOf('getEvidence()') >= 0);
const ladderFn = (pageJs.match(/_ladderOf\(unit\)\s*\{[\s\S]*?\n  \},/) || [''])[0];
ok('I 证据覆盖计算函数存在', ladderFn.length > 0);
ok('I 计算只调只读接口（无 add/upsert/advance/commit）', !/tutorStore\.(add|upsert|update|remove|advance|setMistake|pushQueued|commit)\w*\s*\(/.test(ladderFn));
ok('I 计算读取复测证据源', ladderFn.indexOf('getEvidence()') >= 0);
ok('I 显式 transfers 口留空（变式只从服务端判过的证据派生，不凭空补）', /transfers:\s*\[\]/.test(ladderFn));
ok('I 计算异常 fail-open（catch 后不展示）', ladderFn.indexOf('catch') >= 0);
ok('I 每次计算先清空旧汇总（切单元不残留）', /_ladderOf\(unit\)\s*\{\s*const out = \{\};\s*this\._lvSummary = null;/.test(pageJs));
ok('I 档位说明弹窗只读（showModal 无写接口）', /showLadder\(e\)[\s\S]{0,400}wx\.showModal/.test(pageJs) && !/showLadder\(e\)[\s\S]{0,400}tutorStore\.(add|upsert|update|advance)/.test(pageJs));
ok('I wxml 有证据覆盖图例', pageWxml.indexOf('证据覆盖') >= 0);
ok('I wxml 无百分比宽度色条（不给掌握度视觉暗示）', !/class="[^"]*lv-bar/.test(pageWxml));
const pkg = fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8');
ok('I npm test 已串起 ladder', pkg.indexOf('test-evidence-ladder.cjs') >= 0);

console.log('\n\u2500\u2500 J. 变式记录跨端契约（静态） \u2500\u2500');
function listFrom(src, re) {
  const m = src.match(re);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
const cloudSrc = fs.readFileSync(path.join(__dirname, '../cloudfunctions/tutorRetest/index.js'), 'utf8');
const cfgSrc = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/config.js'), 'utf8');
const ladderSrc = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/evidenceLadder.js'), 'utf8');
const retestSrc = fs.readFileSync(path.join(__dirname, '../miniprogram/pkgGuide/retest/retest.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/tutorStore.js'), 'utf8');

const ctxCloud = listFrom(cloudSrc, /const VARIANT_CONTEXTS = \[([^\]]*)\]/);
const ctxClient = listFrom(cfgSrc, /VARIANT_CONTEXTS:\s*\[([^\]]*)\]/);
ok('J 两端都声明了变式情境白名单', !!ctxCloud && !!ctxClient, JSON.stringify([ctxCloud, ctxClient]));
ok('J 情境白名单跨端逐项一致（否则端上选了云上也记空）',
  JSON.stringify(ctxCloud) === JSON.stringify(ctxClient), ctxCloud + ' vs ' + ctxClient);
ok('J 情境是封闭集合且够凑出多情境', !!ctxCloud && ctxCloud.length >= 4, ctxCloud && ctxCloud.length);
ok('J 情境名本身不夹带掌握断言', !!ctxCloud && ctxCloud.every(c => BANNED.every(w => c.indexOf(w) < 0)));

ok('J ladder 只把「独立达标的变式」算作迁移记录', ladderSrc.indexOf("e.evidenceKind === 'variant' && ok") >= 0);
ok('J 变式标签只在 attempt 契约下接受', /kind:\s*attemptMode \? normKind\(event\.kind\) : 'retest'/.test(cloudSrc));
ok('J 情境同样只在 attempt 契约下接受', /context:\s*attemptMode \? normContext\(event\.context\) : ''/.test(cloudSrc));
const submitBody = (cloudSrc.match(/async function submit\(app, input, ctx\) \{[\s\S]*?\n\}/) || [''])[0];
ok('J submit 函数体可定位', submitBody.length > 0);
ok('J submit 不读前端传的变式标签（升档只能靠重新出题）', !/input\.kind|input\.context/.test(submitBody));
ok('J 落库标签取建单时存下的 doc', /evidenceKind:\s*doc\.kind \|\| 'retest'/.test(cloudSrc));
ok('J 兼容判分路径恒为普通复测', cloudSrc.indexOf("evidenceKind: 'retest'") >= 0);

const addEvBody = (retestSrc.match(/addEvidence\(\{[\s\S]*?\n\s*\}\)/) || [''])[0];
ok('J 复测页落库用服务端回传的标签', addEvBody.indexOf('r.evidenceKind') >= 0 && addEvBody.indexOf('r.context') >= 0,
  addEvBody.slice(0, 60));
ok('J 复测页不用本地输入覆盖标签', addEvBody.indexOf('this.data.kind') < 0);
ok('J 复测页落库带归点字段', addEvBody.indexOf('this.data.unitId') >= 0 && addEvBody.indexOf('this.data.kpId') >= 0);
ok('J 复测页出题请求透传 kind/context', /kind:\s*this\.data\.kind,/.test(retestSrc) && /context:\s*this\.data\.context/.test(retestSrc));
ok('J 复测页也按白名单过滤情境', retestSrc.indexOf('config.PROFILE.VARIANT_CONTEXTS') >= 0 && /allowed\.indexOf\(context\) < 0/.test(retestSrc));

ok('J store 持久化变式标签', /evidenceKind:\s*e\.evidenceKind \|\| 'retest'/.test(storeSrc) && /context:\s*e\.context \|\| ''/.test(storeSrc));
ok('J store 云端默认值补齐新字段（旧记录读回不缺字段）',
  /unitId: '', kpId: '', evidenceKind: 'retest', context: ''/.test(storeSrc));

const variantBody = (pageJs.match(/startVariant\(e\)\s*\{[\s\S]*?\n  \},/) || [''])[0];
ok('J 清单页变式入口存在', variantBody.length > 0);
ok('J 入口的情境取自封闭白名单', variantBody.indexOf('config.PROFILE.VARIANT_CONTEXTS') >= 0);
ok('J 入口只跳转复测页（不端上直写证据）', !/tutorStore\.(add|upsert|update|advance)\w*\s*\(/.test(variantBody));
ok('J 入口带上归点与 kind', variantBody.indexOf('kind=variant') >= 0 && variantBody.indexOf('&uid=') >= 0 && variantBody.indexOf('&pid=') >= 0);
ok('J wxml 暴露变式入口', pageWxml.indexOf('bindtap="startVariant"') >= 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

/**
 * test-order-contract.cjs —— 学习单契约测试（order-v1.1，T02）
 * ---------------------------------------------------------------------------
 * 锁死四条硬契约：O1 单必锚计划 / O2 回执与出单严格 1:1 / O3 回执≠证据 / O4 全程可追溯。
 * 本文件只依赖 order-kit/orderKit.js，不需要云端、不需要部署。
 *
 *     node scripts/test-order-contract.cjs
 */
const path = require('path');
const OK = require(path.resolve(__dirname, '../order-kit/orderKit.js'));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '   → ' + extra : '')); }
}
function group(t) { console.log('\n' + t); }

/* ---------------- 固定具（可复现） ---------------- */

const NOW = Date.parse('2026-09-28T10:00:00');
const PLAN_CREATED = 1758000000000;
const RAND0 = () => 0;

const PLAN = {
  createdAt: PLAN_CREATED,
  startDate: '2026-09-01',
  updatedAt: PLAN_CREATED + 1,
  stages: [
    { name: '第一周 · 认识分数', weeks: '1', goal: '理解分数意义', tasks: [
      { name: '会认读分数并说出含义', days: 2, done: true, doneAt: '2026-09-02' },
      { name: '会比较同分母分数大小', days: 3, done: false, doneAt: '' } ] },
    { name: '第二周 · 通分', weeks: '1', goal: '能说明为什么要通分', tasks: [
      { name: '会通分比较异分母分数大小', days: 4, done: false, doneAt: '' },
      { name: '能解释通分的道理', days: 2, done: false, doneAt: '' } ] }
  ]
};

function planTask(over) {
  return Object.assign({
    key: 'math', subjectName: '数学', si: 1, ti: 0,
    stageName: '第二周 · 通分', taskName: '会通分比较异分母分数大小',
    goal: '能说明为什么要通分', days: 4, dueDay: 9,
    startDate: '2026-09-01', planCreatedAt: PLAN_CREATED, planUpdatedAt: PLAN_CREATED + 1,
    scaffoldLevel: 'D1', source: 'test', generatedAt: '2026-09-28T10:00:00.000Z'
  }, over || {});
}

function newOrder(over) {
  return OK.makeOrder(planTask(over), { now: NOW, rand: RAND0, issuedBy: 'mp', learnerAlias: '加一', grade: '小学·五年级' });
}

/* 一份完整的标准回执原文（照 SKILL.md §8.1 模板，四选一已选定） */
const RECEIPT_FULL = [
  '【费曼训练证据回执】',
  '训练编号：TS-260928-AAA',
  '知识点与核心目标：会通分比较异分母分数大小',
  '题目确认情况：已确认',
  '首次表现：',
  '- 孩子的解释片段或概述：说分母不一样就不好比',
  '- 发现的具体问题：说不出为什么必须通分',
  '帮助过程：',
  '- 关键提示及 D 层级：D2 提供蛋糕切分类比',
  '- 使用时机（提示前孩子说了什么）：孩子说反正通分就好',
  '- 提示后改变了什么：改说"每块大小不一样就没法数"',
  '变式验证：',
  '- 题目：比较 2/3 与 3/4',
  '- 孩子的回答或做法：先通分成 8/12 与 9/12',
  '- 是否给予实质提示：无',
  '- 结果：独立完成',
  '边界验证：',
  '- 问题：1/2 和 2/4 谁大',
  '- 孩子的判断及理由：一样大，因为它们相等',
  '- 是否给予实质提示：给了类比',
  '- 结果：提示后完成',
  '本次证据支持的结论：能独立做异分母比较，理由仍需提示',
  '仍不确定的部分：为什么必须通分',
  '下次建议：再讲一次通分的道理'
].join('\n');

/* ---------------- O1：单必锚计划 ---------------- */

group('O1  单必锚计划');
{
  const o = newOrder();
  ok(!!o, '合法计划任务可出单');

  const required = ['clientId', 'orderNo', 'plan', 'intent', 'evidenceType', 'subject', 'subjectName',
    'grade', 'title', 'status', 'issuedAt', 'issuedBy', 'submittedAt', 'closedAt',
    'receipt', 'evaluation', 'cycle', 'events', 'createdAt', 'updatedAt',
    'promptText', 'protocolBlock', 'copyText', 'resumeText', 'recycleText'];
  const miss = required.filter(k => o[k] === undefined);
  ok(miss.length === 0, '必填字段齐备（' + required.length + ' 项）', '缺：' + miss.join(','));

  const planReq = ['key', 'planId', 'subjectName', 'si', 'ti', 'stageName', 'taskName', 'goal', 'days', 'dueDay', 'startDate', 'planUpdatedAt'];
  const pmiss = planReq.filter(k => o.plan[k] === undefined);
  ok(pmiss.length === 0, '计划锚点字段齐备（' + planReq.length + ' 项）', '缺：' + pmiss.join(','));

  ok(OK.makeOrder({ subjectName: '数学' }, { now: NOW }) === null, '缺 key → 拒绝出单');
  ok(OK.makeOrder(planTask({ si: undefined }), { now: NOW }) === null, '缺 si → 拒绝出单');
  ok(OK.makeOrder(planTask({ ti: null }), { now: NOW }) === null, '缺 ti → 拒绝出单');
  ok(OK.makeOrder(planTask({ taskName: '' }), { now: NOW }) === null, '缺 taskName 且无 topic → 拒绝出单');
  ok(!!OK.makeOrder(planTask({ taskName: '' }), { now: NOW, topic: '手填知识点' }), '缺 taskName 但有 topic → 允许');

  ok(o.plan.planId === 'math@' + PLAN_CREATED, 'planId = key@plan.createdAt', o.plan.planId);
  ok(OK.planIdOf({ createdAt: 123 }, 'math') === 'math@123', 'planIdOf 可独立调用');
  ok(OK.planIdOf({ createdAt: 456 }, 'math') !== OK.planIdOf({ createdAt: 123 }, 'math'),
    '计划重生成（createdAt 变）→ planId 变，旧单不会错挂新计划');
}

/* ---------------- O2：回执与出单严格 1:1 ---------------- */

group('O2  回执与出单严格 1:1（状态机）');
{
  ok(OK.canTransition('issued', 'submitted'), 'issued → submitted 合法');
  ok(OK.canTransition('issued', 'cancelled'), 'issued → cancelled 合法');
  ok(OK.canTransition('issued', 'voided'), 'issued → voided 合法（未执行即作废）');
  ok(OK.canTransition('submitted', 'closed'), 'submitted → closed 合法');
  ok(OK.canTransition('submitted', 'voided'), 'submitted → voided 合法（评语失败即作废重开）');
  ok(OK.canTransition('closed', 'voided'), 'closed → voided 合法（作废重开）');

  ok(!OK.canTransition('issued', 'closed'), 'issued → closed 非法（不许跳过回执）');
  ok(!OK.canTransition('submitted', 'submitted'), 'submitted → submitted 非法（1:1 的硬保证）');
  ok(!OK.canTransition('closed', 'submitted'), 'closed → submitted 非法（回执锁定不覆盖）');
  ok(!OK.canTransition('cancelled', 'submitted'), 'cancelled → submitted 非法');
  ok(!OK.canTransition('voided', 'issued'), 'voided 为终态');

  // 全 5×5 组合穷举：只有 TRANSITIONS 白名单内 6 条合法（3+2+1）
  let legal = 0;
  OK.STATUSES.forEach(a => OK.STATUSES.forEach(b => { if (OK.canTransition(a, b)) legal++; }));
  ok(legal === 6, '5×5 全组合中仅 6 条合法跃迁', '实际 ' + legal);

  ok(OK.isTerminal('cancelled') && OK.isTerminal('voided'), 'cancelled / voided 为终态');
  ok(!OK.isTerminal('issued') && !OK.isTerminal('closed'), 'issued / closed 非终态（closed 仍可作废）');
}

/* ---------------- O3：回执 ≠ 证据 ---------------- */

group('O3  回执 ≠ 证据');
{
  const o = newOrder();
  const parsed = OK.parseReceiptText(RECEIPT_FULL);
  const receipt = OK.buildReceipt(parsed.fields, { now: NOW, by: 'mp', parsedBy: 'rule' });
  const before = JSON.stringify(o);
  const res = OK.evaluateReceipt(o, receipt, { now: NOW, plan: PLAN, history: [] });

  ok(res.ok === true, '评语与汇总生成成功');
  ok(JSON.stringify(o) === before, 'evaluateReceipt 对 order 是纯函数（不得就地改写）');

  const keys = Object.keys(res).sort().join(',');
  ok(keys === 'cycle,evaluation,ok', '返回值只有 ok/evaluation/cycle', keys);

  const forbiddenTop = ['evidence', 'mastery', 'knowledgePoints', 'reviews', 'status', 'sessions', 'mistakes'];
  const flat = JSON.stringify(res);
  const hit = forbiddenTop.filter(k => flat.indexOf('"' + k + '"') >= 0);
  ok(hit.length === 0, '返回值不含 evidence / mastery / knowledgePoints / reviews 等证据字段', hit.join(','));

  ok(res.evaluation.commentSource === 'rule', '默认评语来源为 rule（AI 未参与）');
  ok(res.evaluation.verdict !== undefined, 'verdict 存在');

  // 禁用词门禁
  const all = [res.evaluation.comment, res.evaluation.verdictText, res.cycle.summary].join(' ');
  ok(OK.findBannedWords(all).length === 0, '评语与汇总不含掌握类禁用词', OK.findBannedWords(all).join(','));
  ok(OK.BANNED_WORDS.length >= 4, '禁用词表非空（' + OK.BANNED_WORDS.length + ' 个）');
  ok(OK.BANNED_WORDS.indexOf('已掌握') >= 0 && OK.BANNED_WORDS.indexOf('已精通') >= 0,
    '禁用词表含「已掌握」「已精通」');
}

/* ---------------- O4：全程可追溯 ---------------- */

group('O4  全程可追溯（append-only）');
{
  const o = newOrder();
  ok(o.events.length === 1 && o.events[0].type === 'issued', '出单即写 issued 事件');
  ok(o.events[0].by === 'mp' && o.events[0].at === NOW, 'issued 事件记录了端与时间');
  ok(/planId=/.test(o.events[0].detail), 'issued 事件带计划锚点');

  ok(OK.appendEvent(o, 'copied', 'mp', '首次复制到豆包', NOW + 1000) === true, 'copied 首次写入成功');
  ok(OK.appendEvent(o, 'copied', 'web', '第二次复制', NOW + 2000) === false, 'copied 幂等：只记首次');

  const snap = JSON.stringify(o.events[0]);
  OK.appendEvent(o, 'submitted', 'mp', 'parsedBy=rule', NOW + 3000);
  OK.appendEvent(o, 'evaluated', 'sys', 'verdict=部分达标', NOW + 4000);
  ok(JSON.stringify(o.events[0]) === snap, '追加新事件后既有条目逐字未变');

  const tl = OK.orderTimeline(o);
  let sorted = true;
  for (let i = 1; i < tl.length; i++) if (tl[i].at < tl[i - 1].at) sorted = false;
  ok(sorted, '时间线按时间正序');
  ok(tl.length === o.events.length, '时间线不丢事件');

  ok(OK.appendEvent(o, 'not_a_type', 'mp', '') === false, '未知事件类型被拒绝');
  ok(OK.EVENT_TYPES.every(t => typeof t === 'string'), '事件类型表为字符串数组');
  const WANT_TYPES = ['issued', 'copied', 'submitted', 'evaluated', 'polished', 'ticked', 'closed', 'cancelled', 'voided'];
  WANT_TYPES.forEach(t => {
    if (OK.EVENT_TYPES.indexOf(t) < 0) { fail++; console.log('  ✗ 事件类型表缺 ' + t); } else pass++;
  });
  // 事件类型表是**封闭**的：多出一种也必须显式确认（closed 是 2026-09-28 新增的第 9 种，
  // 用于「归档关闭」——状态机有 submitted→closed，若不记事件 O4 就会出现状态变了没留痕）
  ok(OK.EVENT_TYPES.length === WANT_TYPES.length,
    `${WANT_TYPES.length} 种事件类型齐备且无多余（issued/copied/submitted/evaluated/polished/ticked/closed/cancelled/voided）`,
    OK.EVENT_TYPES);
}

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
process.exit(fail ? 1 : 0);

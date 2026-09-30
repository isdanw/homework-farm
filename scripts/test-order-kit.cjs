/**
 * test-order-kit.cjs —— orderKit 单引擎单测（T05）
 * ---------------------------------------------------------------------------
 * 覆盖 planIdOf / 编号生成 / makeOrder / 模板保真 / parseReceiptText / buildReceipt /
 * auditEvidence / evaluateReceipt / cycleSummary / nextOrderSuggestion 全分支。
 *
 *     node scripts/test-order-kit.cjs
 */
const path = require('path');
const OK = require(path.resolve(__dirname, '../order-kit/orderKit.js'));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '   → ' + extra : '')); }
}
function group(t) { console.log('\n' + t); }

const NOW = Date.parse('2026-09-28T10:00:00');
const PLAN_CREATED = 1758000000000;
const R0 = () => 0;

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

function pt(over) {
  return Object.assign({
    key: 'math', subjectName: '数学', si: 1, ti: 0,
    stageName: '第二周 · 通分', taskName: '会通分比较异分母分数大小',
    goal: '能说明为什么要通分', days: 4, dueDay: 9,
    startDate: '2026-09-01', planCreatedAt: PLAN_CREATED, planUpdatedAt: PLAN_CREATED + 1,
    scaffoldLevel: 'D1', source: 'test', generatedAt: '2026-09-28T10:00:00.000Z'
  }, over || {});
}
function mk(over, opts) {
  return OK.makeOrder(pt(over), Object.assign({ now: NOW, rand: R0, issuedBy: 'mp' }, opts || {}));
}

const STD_RECEIPT = [
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

const EXPRESS_RECEIPT = [
  '【费曼训练证据回执】',
  '训练编号：TS-260928-BBB',
  '知识点与核心目标：说明分数的含义',
  '题目确认情况：已确认',
  '首次表现：',
  '- 孩子的解释片段或概述：把一个整体平均分',
  '- 发现的具体问题：说不清分母含义',
  '帮助过程：',
  '- 关键提示及 D 层级：D3 示范一步',
  '- 使用时机（提示前孩子说了什么）：孩子沉默',
  '- 提示后改变了什么：能说出分母是份数',
  '表达表现：',
  '- 能否说明关键关系：能',
  '- 是否能解释"为什么"：不能',
  '- 是否使用了自己的例子：能',
  '- 是否前后矛盾：无',
  '- 是否需要提示才能继续：需要',
  '本次证据支持的结论：表达基本清楚，因果解释弱',
  '仍不确定的部分：为什么',
  '下次建议：讲因果'
].join('\n');

/* ---------------- 编号与身份 ---------------- */

group('编号生成与计划身份');
{
  ok(OK.newOrderNo(NOW, R0) === 'TS-260928-AAA', 'newOrderNo 格式 TS-YYMMDD-XXX', OK.newOrderNo(NOW, R0));
  ok(OK.newClientId(NOW, R0) === 'to_260928_AAAAAA', 'newClientId 格式 to_YYMMDD_XXXXXX', OK.newClientId(NOW, R0));
  ok(OK.newOrderNo(NOW, R0) === OK.newOrderNo(NOW, R0), '同 rand 下编号可复现（可测）');
  ok(OK.newOrderNo(NOW, () => 0.999) !== OK.newOrderNo(NOW, R0), '不同 rand 下编号不同');
  ok(!/[IO01]/.test(OK.newOrderNo(NOW, () => 0.5).slice(10)), '编号字符集剔除易混字符 I/O/0/1');
  ok(OK.planIdOf({ createdAt: 0 }, 'chinese') === 'chinese@0', 'planIdOf 缺 createdAt 时降级为 @0');
  ok(OK.isoDate(NOW) === '2026-09-28', 'isoDate 用本地时区（不受 UTC 偏移影响）', OK.isoDate(NOW));
  ok(OK.diffDays('2026-09-01', '2026-09-28') === 27, 'diffDays 计算正确');
  ok(OK.diffDays('', '2026-09-28') === null && OK.diffDays('x', 'y') === null, 'diffDays 无法解析返回 null');
}

/* ---------------- 出单与模板保真（T07） ---------------- */

group('出单与 TeachStep 模板保真');
{
  const o = mk();
  const t = o.promptText;

  ok(Object.keys(OK.SUBJ_FOCUS).length === 12, 'SUBJ_FOCUS 保留 12 个学科（含自定义）');
  ok(OK.SUBJ_FOCUS['自定义'].indexOf('这个内容里最核心的是什么') >= 0, '「自定义」学科文案逐字保留');
  ok(Object.keys(OK.DUR_GOAL).length === 3, 'DUR_GOAL 保留 5/10/15 三档');
  ok(OK.DUR_GOAL['5'].indexOf('边界题不强求，时间不足标"未测"，不压缩、不编造。') >= 0, '5 分钟目标文案逐字保留');
  ok(OK.KIND_MIN.express === '仅评价表达，不进行变式/边界验证，不得声称已验证掌握', 'express 最小证据要求逐字保留');
  ok(OK.KIND_FOCUS.mistake.indexOf('原先怎么想、错在第几步') >= 0, '讲错题检查重点逐字保留');
  ok(Object.keys(OK.KIND_LABEL).length === 5, '5 种训练类型齐备');

  ['【训练身份】', '【你的角色】', '【观察与追问】', '【D0-D4 帮助层级】', '【本次验证重点】',
    '【最小证据要求】', '【验证】', '【证据要求】', '【结束与回收】', '【费曼训练证据回执】']
    .forEach(h => { if (t.indexOf(h) >= 0) pass++; else { fail++; console.log('  ✗ promptText 缺段 ' + h); } });
  console.log('  ✓ 启动单 10 个受控段落齐备');

  ok(t.indexOf(o.orderNo) >= 0, 'promptText 含训练编号');
  ok(t.indexOf('训练编号：' + o.orderNo + '（本训练所有单据沿用此编号，不新造）') >= 0, '编号行逐字保留');
  ok(t.indexOf('计划时长：10 分钟') >= 0, '默认时长 10 分钟');
  ok(t.indexOf('不要把提示后复述记为独立掌握') >= 0, '防重复升级与"提示后复述"防线保留');
  ok(o.protocolBlock.indexOf('protocolVersion: ' + OK.PROTOCOL_VERSION) >= 0,
    '协议块版本号引用常量而非字面量（版本一升即同步）', OK.PROTOCOL_VERSION);
  ok(o.protocolBlock.indexOf('```task-protocol') >= 0 && o.protocolBlock.trim().slice(-3) === '```',
    '协议块围栏完整');
  ok(o.protocolBlock.indexOf('orderId: ' + o.clientId) >= 0, '协议块含 orderId');
  ok(o.protocolBlock.indexOf('planId: math@' + PLAN_CREATED) >= 0, '协议块含计划锚点');

  ok(mk().promptText === t, '同输入 → 同输出（确定性，无隐式时间/随机）');
  ok(mk({ taskName: '另一任务' }).promptText !== t, '不同任务 → 不同出单文本');

  ok(o.resumeText.indexOf('【TeachStep 续接单】') === 0, '续接单以规定标题开头');
  ok(o.resumeText.indexOf('（沿用上次编号，不新造）') >= 0, '续接单沿用同一编号');
  ok(o.recycleText.indexOf('【第一步：证据审核】') >= 0, '回收指令含证据审核第一步');
  ok(o.recycleText.indexOf('证据完整度：完整 / 部分完整 / 不足') >= 0, '回收指令含完整度三档');
  ok(o.recycleText.indexOf('不得补写回执中没有的孩子回答') >= 0, '回收指令含"不得补写"红线');

  const ex = mk({}, { kind: 'express' });
  ok(ex.promptText.indexOf('仅练表达模式，不进行变式与边界验证') >= 0, 'express 出单走仅练表达分支');
  ok(ex.promptText.indexOf('表达表现：') >= 0, 'express 回执模板为表达表现段');
  ok(ex.evidenceType === 'expression' && o.evidenceType === 'retest', 'evidenceType 随类型区分');

  const ms = mk({}, { kind: 'mistake' });
  ok(ms.promptText.indexOf('若是错题，先请孩子讲当时自己的解题思路') >= 0, '讲错题追加错题专项指令');

  const v = mk({}, { device: 'voice' });
  ok(v.promptText.indexOf('语音通话') >= 0, 'device=voice 走语音通道文案');
  ok(mk({}, { device: 'cloud' }).promptText.indexOf('请在接下来的对话中') >= 0, 'device=cloud 走对话通道文案');

  ok(OK.normalizeState({ taskName: 'x' }, { minutes: '99' }).minutes === '10', '非法时长回落 10 分钟');
  ok(OK.normalizeState({ taskName: 'x' }, { kind: 'nope' }).kind === 'concept', '非法类型回落讲概念');
  ok(OK.topicFullOf({ topic: '', coord: '人教五上 P32', note: '' }).indexOf('教材坐标：人教五上 P32') >= 0,
    '教材坐标按规则拼接');
  ok(OK.topicFullOf({ topic: '' }).indexOf('题目未预先提供') >= 0, '无题面时给出两阶段确认兜底');
  ok(OK.orderTextFor(o, 'resume') === o.resumeText && OK.orderTextFor(o, 'recycle') === o.recycleText,
    'orderTextFor 按阶段取文本');
  ok(OK.orderTextFor(o, 'x') === o.copyText, 'orderTextFor 未知阶段回落出单全文');
  ok(OK.orderTextFor(null, 'resume') === '', 'orderTextFor 空单返回空串');
}

/* ---------------- 回执解析 ---------------- */

group('回执解析（只抽取、不推断）');
{
  const p = OK.parseReceiptText(STD_RECEIPT);
  ok(p.recognized === true, '识别为标准回执');
  ok(p.fields.orderNo === 'TS-260928-AAA', '抽出训练编号');
  ok(p.fields.topic === '会通分比较异分母分数大小', '抽出知识点');
  ok(p.fields.childQuote.indexOf('分母不一样就不好比') >= 0, '抽出孩子解释片段');
  ok(p.fields.stuckPoint.indexOf('说不出为什么必须通分') >= 0, '抽出具体问题');
  ok(p.fields.dLevelsUsed.length === 1 && p.fields.dLevelsUsed[0] === 'D2', '抽出 D 层级');
  ok(p.fields.variantResult === 'independent', '变式结果 = 独立完成');
  ok(p.fields.boundaryResult === 'prompted', '边界结果 = 提示后完成（分段隔离，未错取变式的值）');
  ok(p.fields.variantQuestion === '比较 2/3 与 3/4', '抽出变式题目');
  ok(p.fields.boundaryQuestion === '1/2 和 2/4 谁大', '抽出边界题目');
  ok(p.fields.mode === 'standard', '模式判定为标准');
  ok(p.missing.length === 0, '完整回执无缺失项', p.missing.join(','));

  const e = OK.parseReceiptText(EXPRESS_RECEIPT);
  ok(e.fields.mode === 'express', '仅练表达回执判定为 express');
  ok(e.fields.variantResult === '' && e.fields.boundaryResult === '', 'express 模式下不产生变式/边界档位');
  ok(e.fields.expressionNote.indexOf('能否说明关键关系：能') >= 0, '抽出表达表现五问');
  ok(e.fields.dLevelsUsed[0] === 'D3', 'express 模式仍抽出 D 层级');

  const empty = OK.parseReceiptText('');
  ok(empty.recognized === false, '空文本不识别');
  ok(empty.fields.variantResult === '' && empty.fields.boundaryResult === '', '空文本不臆造结果');
  ok(empty.missing.length >= 8, '空文本缺失项被完整标注（' + empty.missing.length + ' 项）');

  const half = OK.parseReceiptText('变式验证：\n- 题目：1+1\n- 结果：未测\n');
  ok(half.fields.variantResult === 'untested', '单项未测如实抽出');
  ok(half.fields.boundaryResult === '', '边界缺失不补默认值（绝不推断）');
  ok(half.missing.indexOf('boundaryResult') >= 0, '缺失项进入 missing 列表');

  ok(OK.bucketOfResultLine('独立完成') === 'independent', '档位精确匹配：独立完成');
  ok(OK.bucketOfResultLine('提示后完成') === 'prompted', '档位精确匹配：提示后完成');
  ok(OK.bucketOfResultLine('未完成') === 'incomplete', '档位精确匹配：未完成');
  ok(OK.bucketOfResultLine('未测') === 'untested', '档位精确匹配：未测');
  ok(OK.bucketOfResultLine('独立完成 / 提示后完成 / 未完成 / 未测') === 'independent',
    '未选择时取首个候选（保守，不臆造）');
  ok(OK.bucketOfResultLine('胡说八道') === '', '无法识别返回空');
  ok(OK.levelsOf('用了 D2 和 D4，还有 D2').join(',') === 'D2,D4', 'D 层级去重且保序');
  ok(OK.levelsOf('没有层级').length === 0, '无 D 层级返回空数组');
}

/* ---------------- buildReceipt ---------------- */

group('buildReceipt 归一与兜底');
{
  const both = OK.buildReceipt({ mode: 'standard', variantResult: '独立完成', boundaryResult: '独立完成' }, { now: NOW });
  ok(both.result === 'done', '两项均独立完成 → result=done');
  ok(both.independent.variant && both.independent.boundary, 'independent 双位正确');
  ok(both.untested.length === 0, '无未测项');

  const onePro = OK.buildReceipt({ mode: 'standard', variantResult: '独立完成', boundaryResult: '提示后完成' }, { now: NOW });
  ok(onePro.result === 'partial' && onePro.prompted.boundary, '含提示后完成 → partial');

  const blocked = OK.buildReceipt({ mode: 'standard', variantResult: '未完成', boundaryResult: '独立完成' }, { now: NOW });
  ok(blocked.result === 'blocked' && blocked.incomplete.variant, '含未完成 → blocked');

  const unt = OK.buildReceipt({ mode: 'standard', variantResult: '未测', boundaryResult: '独立完成' }, { now: NOW });
  ok(unt.untested.length === 1 && unt.untested[0] === '变式验证', '未测项进入 untested 列表');
  ok(unt.result === 'partial', '含未测 → 不得判 done');

  const def = OK.buildReceipt({}, { now: NOW });
  ok(def.mode === 'standard' && def.variantResult === undefined, '空输入不产生变式字段');
  ok(def.parsedBy === 'rule' && def.submittedBy === 'mp', '默认来源与端');
  ok(OK.buildReceipt({}, { now: NOW, parsedBy: 'manual' }).parsedBy === 'manual', '手工填写来源可覆盖');
  ok(OK.buildReceipt({ errorType: 'E9' }, { now: NOW }).errorType === 'E9', '合法错因码保留');
  ok(OK.buildReceipt({ errorType: 'E99' }, { now: NOW }).errorType === '', '非法错因码清空');
  ok(OK.buildReceipt({ rounds: 99, minutes: 9999 }, { now: NOW }).rounds === 20, '轮次上限收敛 20');
  ok(OK.buildReceipt({ minutes: -5 }, { now: NOW }).minutes === 0, '负时长收敛为 0');
}

/* ---------------- 证据完整度 ---------------- */

group('证据完整度七项清单');
{
  const full = OK.parseReceiptText(STD_RECEIPT);
  const fam = OK.auditEvidence(OK.buildReceipt(full.fields, { now: NOW }), full.fields);
  ok(fam.completeness === '完整', '完整回执 → 完整', fam.passed + '/' + fam.applicable);
  ok(fam.applicable === 7, '标准模式 7 项适用', String(fam.applicable));

  const e = OK.parseReceiptText(EXPRESS_RECEIPT);
  const fae = OK.auditEvidence(OK.buildReceipt(e.fields, { now: NOW }), e.fields);
  ok(fae.completeness === '完整', 'express 完整回执 → 完整');
  ok(fae.applicable === 5, 'express 模式裁剪为 5 项（不做变式/边界）', String(fae.applicable));

  const em = OK.parseReceiptText('');
  const fap = OK.auditEvidence(OK.buildReceipt(em.fields, { now: NOW }), em.fields);
  ok(fap.completeness === '不足', '空回执 → 不足', fap.passed + '/' + fap.applicable);
  ok(fap.passed === 0, '空回执 0 项通过', String(fap.passed));

  const half = OK.parseReceiptText('变式验证：\n- 题目：1+1\n- 结果：未测\n');
  const fah = OK.auditEvidence(OK.buildReceipt(half.fields, { now: NOW }), half.fields);
  ok(fah.completeness === '不足' || fah.completeness === '部分完整', '半份回执不判完整', fah.completeness);
  const bc = fah.checks.find(c => c.id === 'boundary_done');
  ok(bc && bc.pass === false, '边界未完成 → 对应检查项不通过');
}

/* ---------------- 评语与汇总 ---------------- */

group('评语与汇总（确定性规则）');
{
  function evalWith(raw, over, ctxOver) {
    const o = mk(over || {});
    const p = OK.parseReceiptText(raw);
    const r = OK.buildReceipt(p.fields, { now: NOW, by: 'mp' });
    return { o, r, res: OK.evaluateReceipt(o, r, Object.assign({ now: NOW, plan: PLAN, history: [] }, ctxOver || {})) };
  }

  const A = evalWith(STD_RECEIPT);
  ok(A.res.ok, '标准回执生成评语成功');
  ok(A.res.evaluation.completeness === '完整', '完整度 = 完整');
  ok(A.res.evaluation.verdict === '部分达标', '变式独立 + 边界提示后 → 部分达标', A.res.evaluation.verdict);
  ok(A.res.evaluation.facts.promptedCount === 1, 'facts.promptedCount = 1');
  ok(A.res.evaluation.facts.independentCount === 1, 'facts.independentCount = 1');
  ok(A.res.evaluation.facts.dLevelsUsed.join(',') === 'D2', 'facts 记录帮助层级');
  ok(A.res.evaluation.commentSource === 'rule', 'commentSource = rule');
  ok(A.res.cycle.retestHint !== null, '存在提示后完成 → 产出复测建议入口');
  ok(A.res.cycle.retestHint.topic.indexOf('通分') >= 0, '复测建议带上知识点');
  ok(A.res.cycle.planDelta && A.res.cycle.planDelta.dueDay === 9, '汇总含计划排期对照');
  ok(A.res.cycle.planDelta.actualDay === 28, '实际完成日 = 距计划起算日 +1', String(A.res.cycle.planDelta.actualDay));
  ok(A.res.cycle.planDelta.delta === 19, '滞后天数计算正确', String(A.res.cycle.planDelta.delta));
  ok(A.res.cycle.summary.indexOf('滞后 19 天') >= 0, '汇总结论含滞后描述');
  ok(A.res.cycle.tickApplied === false, '默认不自动勾选计划任务');

  const B = evalWith(STD_RECEIPT.replace('结果：提示后完成', '结果：独立完成'));
  ok(B.res.evaluation.verdict === '达标', '两项均独立完成 → 达标', B.res.evaluation.verdict);
  ok(B.res.cycle.retestHint === null, '全项独立完成 → 无复测建议');
  ok(B.res.cycle.summary.indexOf('达标') >= 0, '汇总含达标');

  const C = evalWith(STD_RECEIPT.replace('结果：独立完成', '结果：未完成'));
  ok(C.res.evaluation.verdict === '未达标', '含未完成 → 未达标', C.res.evaluation.verdict);
  ok(C.res.cycle.retestHint !== null, '未达标 → 给复测建议');

  const D = evalWith(STD_RECEIPT.replace('结果：独立完成', '结果：未测'));
  ok(D.res.evaluation.verdict === '部分达标', '含未测 → 不得判达标', D.res.evaluation.verdict);
  ok(D.res.evaluation.comment.indexOf('未测') >= 0, '评语显式写出未测项');
  ok(D.res.evaluation.facts.untested.join(',') === '变式验证', 'facts 记录未测项');

  const E = evalWith('');
  ok(E.res.evaluation.verdict === null && E.res.evaluation.completeness === '不足', '证据不足 → 不下结论');
  ok(E.res.evaluation.comment.indexOf('证据不足') >= 0, '评语写明证据不足');
  ok(E.res.evaluation.comment.indexOf('补一次验证训练') >= 0, '评语给出补救动作');

  const F = evalWith(EXPRESS_RECEIPT);
  ok(F.res.evaluation.verdict !== '达标', '仅练表达永不判达标（不声称已验证掌握）', F.res.evaluation.verdict);
  ok(F.res.evaluation.facts.mode === 'express', 'facts 记录模式为 express');

  const G = evalWith(STD_RECEIPT, {}, {
    history: [
      { clientId: 'to_x', status: 'closed', plan: { key: 'math', si: 1, ti: 0, taskName: '会通分比较异分母分数大小' },
        receipt: { stuckPoint: '为什么通分' } }
    ]
  });
  ok(G.res.cycle.repeatStuck === 1, '连续同知识点卡点计数 = 1', String(G.res.cycle.repeatStuck));
  ok(G.res.cycle.summary.indexOf('连续卡点 1 次') >= 0, '汇总写出连续卡点次数');

  const H = evalWith(STD_RECEIPT, {}, {
    history: [
      { clientId: 'z2', status: 'closed', plan: { key: 'math', si: 1, ti: 0, taskName: '会通分比较异分母分数大小' }, receipt: { stuckPoint: 'a' } },
      { clientId: 'z1', status: 'closed', plan: { key: 'math', si: 1, ti: 0, taskName: '会通分比较异分母分数大小' }, receipt: { stuckPoint: 'b' } }
    ]
  });
  ok(H.res.cycle.repeatStuck === 2, '两次历史卡点 → 计数 2', String(H.res.cycle.repeatStuck));

  const I = evalWith(STD_RECEIPT.replace('D2 提供蛋糕切分类比', 'D4 完整示范').
    replace('- 关键提示及 D 层级：D4 完整示范', '- 关键提示及 D 层级：D4 完整示范'));
  ok(I.res.evaluation.facts.dLevelsUsed.indexOf('D4') >= 0, 'D4 被记录');
  ok(I.res.evaluation.comment.indexOf('示范级帮助') >= 0, '使用 D3/D4 → 评语追加示范级提示');

  const J = (function () {
    const o = mk();
    const p = OK.parseReceiptText(STD_RECEIPT);
    const r = OK.buildReceipt(Object.assign({}, p.fields, { rounds: 4 }), { now: NOW });
    return { res: OK.evaluateReceipt(o, r, { now: NOW, plan: PLAN, history: [] }) };
  })();
  ok(J.res.evaluation.comment.indexOf('4 轮') >= 0, '轮次偏多 → 评语提示卡点未解决');

  ok(OK.evaluateReceipt(null, {}, {}) .ok === false, '无出单 → 拒绝评语');
  ok(OK.evaluateReceipt(mk(), null, {}).ok === false, '无回执 → 拒绝评语');

  // 无 startDate 时不产出排期对照（不臆造）
  const K = evalWith(STD_RECEIPT, { startDate: '' });
  ok(K.res.cycle.planDelta === null, '计划未起算 → 不产出排期对照（绝不臆造）');
  ok(K.res.evaluation.verdict === '部分达标', '无排期不影响评语判定');

  // 禁用词：四条 verdict 分支全覆盖
  const allComments = [A, B, C, D, E, F, G, H, I, J].map(x => x.res.evaluation.comment).join('\n');
  ok(OK.findBannedWords(allComments).length === 0, '全部评语分支均无禁用词', OK.findBannedWords(allComments).join(','));
}

/* ---------------- 下一条建议 ---------------- */

group('nextOrderSuggestion（下一条计划任务）');
{
  const o = mk();
  const n1 = OK.nextOrderSuggestion(PLAN, o, []);
  ok(n1 && n1.si === 1 && n1.ti === 1, '同阶段内顺延到下一条', JSON.stringify(n1 && { si: n1.si, ti: n1.ti }));
  ok(n1.taskName === '能解释通分的道理', '返回正确任务名');
  ok(n1.dueDay === 11, 'dueDay 按 days 累计计算', String(n1.dueDay));

  const o0 = mk({ si: 0, ti: 1 });
  const n2 = OK.nextOrderSuggestion(PLAN, o0, []);
  ok(n2 && n2.si === 1 && n2.ti === 0, '本阶段结束后跨到下一阶段', JSON.stringify(n2 && { si: n2.si, ti: n2.ti }));

  const oLast = mk({ si: 1, ti: 1 });
  ok(OK.nextOrderSuggestion(PLAN, oLast, []) === null, '计划末尾 → 无下一条');

  const skipPlan = JSON.parse(JSON.stringify(PLAN));
  skipPlan.stages[1].tasks[1].done = true;
  ok(OK.nextOrderSuggestion(skipPlan, o, []) === null, '已勾选任务被跳过');

  const noStages = { stages: [] };
  ok(OK.nextOrderSuggestion(noStages, o, []) === null, '空计划 → null');
  ok(OK.nextOrderSuggestion(null, o, []) === null, '无计划 → null');

  const n3 = OK.nextOrderSuggestion(PLAN, null, []);
  ok(n3 && n3.si === 0 && n3.ti === 1, '无当前单时从计划首条**未勾选**任务开始（跳过已完成的 ti=0）',
    JSON.stringify(n3 && { si: n3.si, ti: n3.ti }));
  ok(n3.taskName === '会比较同分母分数大小', '无当前单时返回首个未勾选任务名');

  const n4 = OK.nextOrderSuggestion(PLAN, o, [
    { clientId: 'to_y', status: 'issued', plan: { key: 'math', si: 1, ti: 1, taskName: '能解释通分的道理' } }
  ]);
  ok(n4 && n4.issuedBefore === true, '已出过单的任务被标记 issuedBefore（供 UI 提示）');
}

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
process.exit(fail ? 1 : 0);

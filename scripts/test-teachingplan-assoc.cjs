/* test-teachingplan-assoc.cjs —— 教学计划关联（与成长计划）单测
 * 运行：node scripts/test-teachingplan-assoc.cjs
 * 覆盖：
 *   1. studyPlanGen.buildPlanRefBlock：空→空串；非空→含标题与正文；超 3000 截断
 *   2. studyPlanGen.buildUserPrompt 零回归：teachingPlan 为空/未传 → 输出与旧版逐字一致
 *   3. buildUserPrompt 注入 teachingPlan 后含参考块（且不破坏 toc 注入）
 *   4. teachingPlan.js htmlToText / mdToText 清洗（script/style 剥离、标题层级、列表保留）
 *   5. tutorChat 注入 fail-open（本文件只静态校验块文案存在性，端到端见发布验证）
 */
process.env.EXAM_TEST = '1';
const path = require('path');
const { createMockDb, installMock } = require('./mock-tcb.js');
const db = createMockDb();
installMock(db);

const M = require('../cloudfunctions/studyPlanGen/index.js');
const T = M.__test;
const tp = require('../miniprogram/utils/teachingPlan.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

/* 旧版 buildUserPrompt（#19 之前的实现，逐字保留用于回归对比） */
function legacyUserPrompt(input, toc) {
  let requirement = input.planPrompt || '按默认规则编排';
  if (requirement.length > 800) {
    requirement = '以下为该科目的「学科角色说明」。编排阶段任务时，请与其能力体系、术语与方法保持一致；' +
      '忽略其中关于答题/对话输出格式的要求，最终只输出计划 JSON。\n\n' + requirement;
  }
  return '请为以下科目编排一学期的阶段计划：\n' +
    '科目：' + input.subject + '\n' +
    '年级：' + (input.grade || '未填写') + '\n' +
    '学期：' + (input.term || '上学期') + '\n' +
    '教材：' + (input.textbook || '未指定（按统编主流版本）') + '\n' +
    (toc ? toc + '\n' : '') +
    '\n编排要求（务必遵守）：\n' + requirement;
}

(async () => {
  const INPUT = { subject: '语文', grade: '一年级', term: '上学期', textbook: '人教版', planPrompt: '' };

  /* ---------- 1. buildPlanRefBlock ---------- */
  console.log('== 1. buildPlanRefBlock ==');
  ok(T.buildPlanRefBlock('') === '', '空串 → 空串（零回归保障）');
  ok(T.buildPlanRefBlock(null) === '', 'null → 空串');
  const tpText = '第一单元目标：认识常用汉字；重点：拼音与识字。';
  const block = T.buildPlanRefBlock(tpText);
  ok(block.indexOf('【教学计划参考（教学目标与重点，仅供参考，不得违背教材单元目录的权威划分）】') === 0, '参考块带标题');
  ok(block.indexOf(tpText) > 0, '参考块含教学计划正文');
  const longText = 'x'.repeat(3500);
  const blockLong = T.buildPlanRefBlock(longText);
  ok(blockLong.length <= T.MAX_PLAN_REF_CHARS + 80, '超长截断受控（' + blockLong.length + '）');
  ok(blockLong.indexOf('教学计划过长已截断') > 0, '超长触发截断提示');

  /* ---------- 2. buildUserPrompt 零回归 ---------- */
  console.log('== 2. buildUserPrompt 零回归（teachingPlan 未注入时逐字一致） ==');
  ok(T.buildUserPrompt(INPUT, '') === legacyUserPrompt(INPUT, ''), 'planRef 缺省 → 与旧版一致');
  ok(T.buildUserPrompt(INPUT, '', '') === legacyUserPrompt(INPUT, ''), 'planRef 空串 → 与旧版一致');
  ok(T.buildUserPrompt(INPUT, '', undefined) === legacyUserPrompt(INPUT, ''), 'planRef undefined → 与旧版一致');
  // 带 toc 时也不因 teachingPlan 引入变化
  const toc = T.buildTocBlock({ title: '人教版·一年级语文上册', version: '人教版', grade: '一年级', term: '上学期', units: [{ name: '我上学了' }] });
  ok(T.buildUserPrompt(INPUT, toc, '') === legacyUserPrompt(INPUT, toc), '带 toc + 空 planRef → 与旧版一致');

  /* ---------- 3. buildUserPrompt 注入 teachingPlan ---------- */
  console.log('== 3. buildUserPrompt 注入 teachingPlan（planRef 由 buildPlanRefBlock 包装，与 main 同款） ==');
  const injected = T.buildUserPrompt(INPUT, '', T.buildPlanRefBlock(tpText));
  ok(injected.indexOf('【教学计划参考') >= 0, '含教学计划参考块');
  ok(injected.indexOf('\n编排要求（务必遵守）') > injected.indexOf('【教学计划参考'), '参考块在编排要求之前');
  ok(injected.indexOf(tpText) > 0, '教学计划正文进入参考块');

  /* ---------- 4. teachingPlan.js 清洗 ---------- */
  console.log('== 4. htmlToText / mdToText ==');
  const html = '<html><head><style>.a{color:red}</style></head><body><h1>一年级语文计划</h1>' +
    '<p>第一单元：识字。</p><ul><li>目标A</li><li>目标B</li></ul><script>var x=1;</script></body></html>';
  const ht = tp.htmlToText(html);
  ok(ht.indexOf('一年级语文计划') > 0 && ht.indexOf('第一单元：识字。') > 0, 'HTML 保留标题与正文');
  ok(ht.indexOf('var x=1') < 0, 'HTML 去 script');
  ok(ht.indexOf('.a{color:red}') < 0, 'HTML 去 style');
  ok(/^# 一年级语文计划/.test(ht), 'HTML h1 → # 层级');
  ok(ht.indexOf('- 目标A') > 0 && ht.indexOf('- 目标B') > 0, 'HTML 列表 → - 项');
  const md = '# 数学计划\n\n## 第一单元\n- 会数 1-10\n- 会比较大小\n\n```\ncode block\n```';
  const mt = tp.mdToText(md);
  ok(mt.indexOf('# 数学计划') >= 0 && mt.indexOf('## 第一单元') >= 0, 'MD 保留标题层级');
  ok(mt.indexOf('- 会数 1-10') > 0 && mt.indexOf('- 会比较大小') > 0, 'MD 保留列表');
  ok(mt.indexOf('code block') < 0, 'MD 去代码围栏');
  ok(tp.detectFormat('a.html', '<p>hi</p>') === 'html', 'detectFormat: .html → html');
  ok(tp.detectFormat('a.md', '# hi') === 'md', 'detectFormat: .md → md');
  ok(tp.detectFormat('x.txt', 'plain text') === 'text', 'detectFormat: 无扩展名纯文本 → text');

  /* ---------- 5. tutorChat 注入文案存在性（静态） ---------- */
  console.log('== 5. tutorChat 教学计划参考块（源码静态校验） ==');
  const tcSrc = require('fs').readFileSync(path.join(__dirname, '../cloudfunctions/tutorChat/index.js'), 'utf8');
  ok(tcSrc.indexOf('【教学计划参考（教学目标与重点）】') > 0, 'tutorChat 含教学计划参考块文案');
  ok(tcSrc.indexOf('teachingPlan: str(event.teachingPlan, 1500)') > 0, 'tutorChat 接收 teachingPlan 参数（≤1500）');
  ok(tcSrc.indexOf('buildMessages(input.subject, input.content, input.history, input.learner, input.learnerCtx, input.unitCtx, input.teachingPlan)') > 0, 'buildMessages 透传 teachingPlan');

  console.log('\n教学计划关联单测：' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();

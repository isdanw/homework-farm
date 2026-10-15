/**
 * test-scenario.cjs —— 情境化使命感（P2）纯函数单测
 *
 * 运行：node scripts/test-scenario.cjs
 * 覆盖：框架多样性 / 累积制只增不减 / 章节解锁 / 兜底身份 / 视图模型 / 合规
 */
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) { ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
function section(t) { console.log('\n── ' + t + ' ──'); }

const scenario = require(path.join(__dirname, '../miniprogram/utils/scenario.js'));
const tutorSubjects = require(path.join(__dirname, '../miniprogram/utils/tutorSubjects.js'));

function fresh() { return { id: 'u1', scenarios: {} }; }

console.log('═══ 情境化使命感（P2）单测 ═══\n');

/* ---------------------------------------------------------------- */
section('A. 内置三科身份（设计 §3.2）');

eq('数学 → 数学小侦探', scenario.frameOf('math').identity, '数学小侦探');
eq('语文 → 汉字探险家', scenario.frameOf('chinese').identity, '汉字探险家');
eq('英语 → 单词收集员', scenario.frameOf('english').identity, '单词收集员');
eq('数学进度意象 = 线索卡', scenario.frameOf('math').progressNoun, '线索卡');
eq('语文进度意象 = 地图', scenario.frameOf('chinese').progressNoun, '地图');
eq('英语进度意象 = 词汇罐', scenario.frameOf('english').progressNoun, '词汇罐');

/* ---------------------------------------------------------------- */
section('B. 框架多样性（不只三科 / 不绑具体科目）');

eq('九科全部有身份', tutorSubjects.TUTOR_SUBJECTS.filter(s => scenario.frameOf(s.key).identity).length, 9);
ok('九科身份互不重复',
   new Set(tutorSubjects.TUTOR_SUBJECTS.map(s => scenario.frameOf(s.key).identity)).size, 9);
// 自定义打卡类型走兜底，而不是「没有身份」
eq('ct_xxx 走兜底身份', scenario.frameOf('ct_sports').identity, '小小探索家');
eq('未知学科不返回 undefined', !!scenario.frameOf('whatever').identity, true);
eq('兜底也有剧情碎片', scenario.frameOf('ct_sports').fragments.length > 0, true);
eq('兜底身份不含学科名（通用）', /[语数英物化生史地政]/.test(scenario.frameOf('ct_sports').identity), false);

/* ---------------------------------------------------------------- */
section('C. 推进与累积制（只增不减 —— 核心）');

{
  const u = fresh();
  const r1 = scenario.advance(u, 'math');
  eq('首次推进 progress=1', r1.progress, 1);
  eq('首次推进 chapter=1', r1.chapter, 1);
  eq('首次推进无解锁', r1.unlocked.length, 0);

  scenario.advance(u, 'math');                      // progress=2
  eq('第二次 chapter 仍为 1', scenario.getScenario(u, 'math').chapter, 1);

  const r3 = scenario.advance(u, 'math');           // progress=3 → chapter 2
  eq('第三次 chapter=2', r3.chapter, 2);
  eq('达节点解锁 1 段', r3.unlocked.length, 1);
  eq('解锁的是第 1 段', r3.unlocked[0], 'math_c1');

  // 累积制：progress 只增，unlocked 永不移除
  const scn = scenario.getScenario(u, 'math');
  eq('unlocked 只增', scn.unlocked.length, 1);
  scenario.advance(u, 'math'); scenario.advance(u, 'math'); scenario.advance(u, 'math');
  eq('继续推进 unlocked 累加到 2', scenario.getScenario(u, 'math').unlocked.length, 2);
  eq('progress 单调递增到 6', scenario.getScenario(u, 'math').progress, 6);
}

/* ---------------------------------------------------------------- */
section('D. 解锁上限与不重复');

{
  const u = fresh();
  // 数学 step=3，5 段碎片 → 最多解锁 5 段；progress 到 15+ 也不该重复/越界
  for (let i = 0; i < 20; i++) scenario.advance(u, 'math');
  const scn = scenario.getScenario(u, 'math');
  eq('progress 累积到 20', scn.progress, 20);
  eq('unlocked 不超过碎片总数', scn.unlocked.length <= 5, true);
  eq('unlocked 无重复', new Set(scn.unlocked).size, scn.unlocked.length);
  eq('全部碎片都已解锁（到顶）', scn.unlocked.length, 5);
  eq('chapter 继续增长（不封顶错乱）', scn.chapter, Math.floor(20 / 3) + 1);
}

{
  // 自定义科目 step=3，碎片 5 段
  const u = fresh();
  for (let i = 0; i < 4; i++) scenario.advance(u, 'ct_sports');
  const scn = scenario.getScenario(u, 'ct_sports');
  eq('兜底学科也按 step 解锁', scn.unlocked.length, 1);
  eq('兜底碎片 id 前缀 custom', scn.unlocked[0], 'custom_c1');
}

/* ---------------------------------------------------------------- */
section('E. 每学科一份，互不干扰');

{
  const u = fresh();
  scenario.advance(u, 'math'); scenario.advance(u, 'math'); scenario.advance(u, 'math');
  scenario.advance(u, 'chinese');
  eq('数学 chapter 独立', scenario.getScenario(u, 'math').chapter, 2);
  eq('语文仍 chapter 1', scenario.getScenario(u, 'chinese').chapter, 1);
  eq('语文 identity 独立', scenario.banner(u, 'chinese').identity, '汉字探险家');
  eq('两科场景各自独立', Object.keys(u.scenarios).sort().join(','), 'chinese,math');
}

/* ---------------------------------------------------------------- */
section('F. 健壮性（缺字段 / 脏数据 / 边界）');

{
  const u = fresh();
  eq('空 subject 不崩 advance', scenario.advance(u, '').progress, 0);
  eq('null u 不崩 advance', scenario.advance(null, 'math').progress, 0);
  eq('getScenario(undefined) 返回默认形状',
    JSON.stringify(Object.keys(scenario.getScenario({}, undefined)).sort()),
    JSON.stringify(['chapter', 'progress', 'subject', 'unlocked', 'updatedAt']));

  // 脏数据：progress 为字符串 / 负数 / unlocked 非数组
  const bad = { scenarios: { math: { progress: '7', unlocked: 'nope', chapter: 999 } } };
  const scn = scenario.getScenario(bad, 'math');
  eq('字符串 progress 被转数字', scn.progress, 7);
  eq('chapter 按 progress 重算（不被脏值带偏）', scn.chapter, Math.floor(7 / 3) + 1);
  eq('非数组 unlocked 被纠正', Array.isArray(scn.unlocked), true);

  // 完全无 scenarios 字段
  const bare = { id: 'u1' };
  scenario.advance(bare, 'math');
  eq('缺失 scenarios 自动创建', typeof bare.scenarios, 'object');
}

/* ---------------------------------------------------------------- */
section('G. 视图模型（UI 契约）');

{
  const u = fresh();
  const b0 = scenario.banner(u, 'math');
  eq('初始 identity 正确', b0.identity, '数学小侦探');
  eq('初始 emoji 正确', b0.emoji, '🔍');
  eq('初始 chapter=1', b0.chapter, 1);
  eq('初始 nodePct=0', b0.nodePct, 0);
  eq('初始 latest 为 null', b0.latest, null);
  eq('初始 unlockedCount=0', b0.unlockedCount, 0);

  scenario.advance(u, 'math');                       // progress 1
  const b1 = scenario.banner(u, 'math');
  eq('节点内 1/3 → nodePct=33', b1.nodePct, 33);
  eq('仍未解锁 latest=null', b1.latest, null);

  scenario.advance(u, 'math');                       // progress 2
  eq('节点内 2/3 → nodePct=67', scenario.banner(u, 'math').nodePct, 67);
  eq('未到阈值（progress<step）不解锁', scenario.getScenario(u, 'math').unlocked.length, 0);

  scenario.advance(u, 'math');                       // progress 3 → 跨过 step，解锁 c1
  const b2 = scenario.banner(u, 'math');
  eq('解锁后 latest 有碎片', b2.latest && b2.latest.id, 'math_c1');
  ok('latest 是短句（≤2句）', b2.latest && b2.latest.text.split(/[。！？]/).filter(Boolean).length <= 2);
  eq('unlockedCount=1', b2.unlockedCount, 1);
  eq('解锁后 chapter=2', b2.chapter, 2);
  eq('解锁后 nodePct 归零（新节点）', b2.nodePct, 0);
}

/* ---------------------------------------------------------------- */
section('H. 合规（禁用词 / 无社交付费 / 无 AI 生成）');

{
  const BANNED = ['已掌握', '已精通', '学会了', '完全懂了', '完全掌握', '稳稳掌握',
                  '掌握了', '精通了', '已学会', '学懂了', '全懂了'];
  let leaked = [];
  // 全框架扫描
  Object.keys(scenario.FRAMES).forEach(k => {
    const f = scenario.FRAMES[k];
    leaked = leaked.concat(BANNED.filter(w => f.identity.indexOf(w) >= 0));
    leaked = leaked.concat(BANNED.filter(w => f.progressNoun.indexOf(w) >= 0));
    f.fragments.forEach(fr => {
      leaked = leaked.concat(BANNED.filter(w => String(fr.title).indexOf(w) >= 0));
      leaked = leaked.concat(BANNED.filter(w => String(fr.text).indexOf(w) >= 0));
    });
  });
  eq('全部框架文案无禁用词', leaked.length, 0);

  // 碎片短句约束
  let tooLong = 0;
  Object.keys(scenario.FRAMES).forEach(k => {
    scenario.FRAMES[k].fragments.forEach(fr => {
      if (String(fr.text).length > 60) tooLong++;      // ≤2 句且不过长
    });
  });
  eq('碎片均为短句（≤60 字）', tooLong, 0);

  // 源码级：无社交/付费/AI 生成调用
  // ⚠️ 只扫「代码」不含注释：本文件注释里写着「无陌生人社交」这类合规声明，
  //    直接全文匹配会把自己判为违规。剥离注释后再扫。
  const srcRaw = require('fs').readFileSync(path.join(__dirname, '../miniprogram/utils/scenario.js'), 'utf8');
  const src = srcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const socialWords = ['好友', '好友榜', '排行', '聊天', '私信', '组队', '联盟', '社交', '微信好友'];
  const payWords = ['付费', '充值', '购买解锁', '内购', 'VIP', '会员'];
  eq('源码（去注释）无社交元素', socialWords.filter(w => src.indexOf(w) >= 0).length, 0);
  eq('源码（去注释）无付费解锁', payWords.filter(w => src.indexOf(w) >= 0).length, 0);
  eq('源码不 require 云函数（纯本地）', /require\(['"]cloudfunctions|wx\.cloud/.test(src), false);
  eq('源码不 require store.js（避免循环依赖）', /require\(['"]\.\/store\.js/.test(src), false);
  // 叙事用过程性词汇，不做掌握度断言
  ok('碎片用过程性意象（线索/脚印/记录等）',
     /线索|脚印|记录|地图|罐|笔记|时间线/.test(JSON.stringify(scenario.FRAMES)));
}

console.log('\n────────────────────────────────────────');
console.log(fail === 0
  ? `通过 ${pass} / ${pass + fail}   ✓ 全部通过`
  : `通过 ${pass} / ${pass + fail}   ✗ 失败 ${fail} 项：\n  - ` + failures.join('\n  - '));
console.log('────────────────────────────────────────');
process.exit(fail === 0 ? 0 : 1);
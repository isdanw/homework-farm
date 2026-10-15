/**
 * test-pace.cjs —— 精力条 / 节奏护盾（P1）纯函数单测
 *
 * 运行：node scripts/test-pace.cjs
 * 覆盖：参数自动推导（不绑年龄）/ 日切周切 / 扣减与钳制 / 单节上限 / 视图模型 / 合规文案
 */
const path = require('path');
const Module = require('module');

/* ---- 最小 wx stub：pace.js 只用到 util.js 的纯日期函数，不需要 wx ---- */
const origResolve = Module._resolveFilename;

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++; failures.push(name + (extra ? '  → ' + extra : ''));
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}
function section(t) { console.log('\n── ' + t + ' ──'); }

const UTIL = path.join(__dirname, '../miniprogram/utils/util.js');
const pace = require(UTIL.replace(/util\.js$/, 'pace.js'));

/* 固定「今天」，让日切/周切断言可复现 */
const REAL_TODAY = util_today();
function util_today() { return require(UTIL).today(); }

let TODAY = REAL_TODAY;
require.cache[UTIL].exports.today = function () { return TODAY; };

function fresh(learner, grade) {
  const u = { id: 'u1', grade: grade || '', learner: learner || {} };
  u.pace = pace.defaultPace();
  return u;
}

console.log('═══ 精力条 / 节奏护盾（P1）单测 ═══\n');

/* ---------------------------------------------------------------- */
section('A. 参数自动推导 —— 不绑年龄/年级');

eq('幼儿园 → 单节 15 / 默认周 120',
  JSON.stringify([pace.derivePaceConfig({ stage: '幼儿园', weeklyMinutes: 0 }, '').singleSessionCapMin,
                 pace.derivePaceConfig({ stage: '幼儿园', weeklyMinutes: 0 }, '').weeklyMinutes]),
  JSON.stringify([15, 120]));

eq('小学 → 单节 25', pace.derivePaceConfig({ stage: '小学' }, '').singleSessionCapMin, 25);
eq('初中 → 单节 38', pace.derivePaceConfig({ stage: '初中' }, '').singleSessionCapMin, 38);
eq('高中 → 单节 45', pace.derivePaceConfig({ stage: '高中' }, '').singleSessionCapMin, 45);
eq('其他 → 单节 25', pace.derivePaceConfig({ stage: '其他' }, '').singleSessionCapMin, 25);

// 关键反例：同样「小学」，周时长不同 → 每日精力池必须不同（证明不是写死常量）
const p300 = pace.derivePaceConfig({ stage: '小学', weeklyMinutes: 300 }, '');
const p900 = pace.derivePaceConfig({ stage: '小学', weeklyMinutes: 900 }, '');
ok('同学段不同周时长 → 每日精力池不同（非写死）', p300.dailyEnergyPool !== p900.dailyEnergyPool,
   p300.dailyEnergyPool + ' vs ' + p900.dailyEnergyPool);
eq('小学 300 分钟/周 → 每日池 43（⌈300/7⌉）', p300.dailyEnergyPool, 43);
eq('小学 900 分钟/周 → 每日池 129（⌈900/7⌉）', p900.dailyEnergyPool, 129);

eq('每日池下限 10（周 5 分钟也保底）',
  pace.derivePaceConfig({ stage: '高中', weeklyMinutes: 5 }, '').dailyEnergyPool, 10);

// stage 缺失 → 用 grade 推断（档案兜底，derived=true）
eq('grade=初一 → 推断初中', pace.derivePaceConfig({}, '初一').stage, '初中');
eq('grade=一年级 → 推断小学', pace.derivePaceConfig({}, '一年级').stage, '小学');
eq('grade=五年级 → 推断小学', pace.derivePaceConfig({}, '五年级').stage, '小学');
eq('grade=高三 → 推断高中', pace.derivePaceConfig({}, '高三').stage, '高中');
eq('大班 → 幼儿园', pace.stageFromGrade('大班'), '幼儿园');
eq('识别不到 → 空串', pace.stageFromGrade('外星语'), '');
eq('stage+grade 冲突时 stage 优先',
  pace.derivePaceConfig({ stage: '高中' }, '一年级').stage, '高中');

eq('档案齐全 → derived=false', pace.derivePaceConfig({ stage: '小学', weeklyMinutes: 300 }, '').derived, false);
eq('档案全缺 → derived=true', pace.derivePaceConfig({}, '').derived, true);
eq('weeklyMinutes=0 视为未填（走兜底）',
  pace.derivePaceConfig({ stage: '小学', weeklyMinutes: 0 }, '').weeklyMinutes, 300);

eq('null learner 不崩', pace.derivePaceConfig(null, '').stage, '其他');

/* ---------------------------------------------------------------- */
section('B. 日切 / 周切（幂等）');

{
  const u = fresh({ stage: '小学', weeklyMinutes: 300 });
  const cfg = pace.derivePaceConfig(u.learner, u.grade);
  const p = pace.normalizePace(u, cfg);
  eq('首次初始化 → 回满到池', p.energy, 43);
  eq('首次初始化 → lastResetDate=今天', p.lastResetDate, TODAY);

  pace.spend(u, 10, cfg);
  eq('扣 10 分钟后 energy=33', u.pace.energy, 33);
  eq('todayUsedMin=10', u.pace.todayUsedMin, 10);
  eq('weekUsedMin=10', u.pace.weekUsedMin, 10);

  // 同日重复 normalize 不应回满（幂等）
  pace.normalizePace(u, cfg);
  eq('同日再 normalize 不回满', u.pace.energy, 33);

  // 跨天
  TODAY = require(UTIL).daysAgo(1);
  pace.normalizePace(u, cfg);
  eq('跨天 → energy 回满', u.pace.energy, 43);
  eq('跨天 → todayUsedMin 归零', u.pace.todayUsedMin, 0);
  TODAY = REAL_TODAY;
}

// 跨周：weekUsedMin 归零
{
  const u = fresh({ stage: '小学', weeklyMinutes: 300 });
  const cfg = pace.derivePaceConfig(u.learner, u.grade);
  pace.spend(u, 30, cfg);
  eq('扣 30 → weekUsedMin=30', u.pace.weekUsedMin, 30);
  // 把 weekStart 改成一个不同周的值 → 触发周切
  u.pace.weekStart = '2000-01-03';
  pace.normalizePace(u, cfg);
  eq('跨周 → weekUsedMin 归零', u.pace.weekUsedMin, 0);
  eq('跨周 → weekStart 重算为本周一', u.pace.weekStart, pace.weekStart(TODAY));
}

{
  const ws = pace.weekStart(TODAY);
  const wd = new Date(ws + 'T00:00:00').getDay();
  eq('weekStart 落在本周周一（周日=0…周一=1）', wd, 1);
}

/* ---------------------------------------------------------------- */
section('C. 扣减与钳制（非惩罚）');

{
  const u = fresh({ stage: '小学', weeklyMinutes: 300 });
  const cfg = pace.derivePaceConfig(u.learner, u.grade);
  pace.normalizePace(u, cfg);

  const r = pace.spend(u, 5, cfg);
  eq('扣 5 → energy 38', r.energy, 38);
  eq('返回值 spent=5', r.spent, 5);
  eq('未耗尽 drained=false', r.drained, false);

  // 超量扣减 → 钳到 0，不为负
  const r2 = pace.spend(u, 999, cfg);
  eq('超量扣减 → energy=0（不为负）', r2.energy, 0);
  eq('耗尽 drained=true', r2.drained, true);
  eq('energy 是 0 不是 -5', r2.energy >= 0, true);

  // 无效时长不改动
  const before = u.pace.energy;
  const r3 = pace.spend(u, 0, cfg);
  eq('扣 0 → spent=0', r3.spent, 0);
  eq('扣 0 → energy 不变', u.pace.energy, before);
  eq('扣 -5 → spent=0（负数无效）', pace.spend(u, -5, cfg).spent, 0);
  eq('扣 NaN → spent=0', pace.spend(u, NaN, cfg).spent, 0);
}

// 池子变大（家长调高 weeklyMinutes）后旧 energy 不越界
{
  const u = fresh({ stage: '小学', weeklyMinutes: 1400 });   // 池 200
  const cfg = pace.derivePaceConfig(u.learner, u.grade);
  u.pace.energy = 999;                                       // 脏数据
  pace.normalizePace(u, cfg);
  eq('池变大后脏 energy 被钳到池上限', u.pace.energy, 200);
}
{
  const u = fresh({ stage: '小学', weeklyMinutes: 1400 });
  u.pace.energy = 200; u.pace.lastResetDate = TODAY;
  const smallCfg = pace.derivePaceConfig({ stage: '小学', weeklyMinutes: 70 }, '');  // 池 10
  pace.normalizePace(u, smallCfg);
  eq('池变小后 energy 被钳到新池上限', u.pace.energy, 10);
}

/* ---------------------------------------------------------------- */
section('D. 会话计时（markSessionStart / settleSession）');

{
  const u = fresh({ stage: '小学', weeklyMinutes: 300 });
  const cfg = pace.derivePaceConfig(u.learner, u.grade);
  pace.normalizePace(u, cfg);

  eq('未记起点时 settle=0', pace.settleSession(u, cfg), 0);

  const at = pace.markSessionStart(u, cfg);
  ok('markSessionStart 返回时间戳', at > 0);
  eq('幂等：重复 mark 不改起点', pace.markSessionStart(u, cfg), at);

  // 模拟 30 分钟学习
  u.pace.sessionStartAt = Date.now() - 30 * 60000;
  eq('settle 30 分钟会话 → 30', pace.settleSession(u, cfg), 30);
  eq('settle 后 sessionStartAt 清零', u.pace.sessionStartAt, 0);

  // 超长会话封顶（cap 25 → 上限 ⌈25*1.5⌉=38）
  pace.markSessionStart(u, cfg);
  u.pace.sessionStartAt = Date.now() - 600 * 60000;          // 10 小时
  eq('超长会话封顶到 cap*1.5', pace.settleSession(u, cfg), 38);
}

{
  const u = fresh({ stage: '幼儿园', weeklyMinutes: 120 });
  const cfg = pace.derivePaceConfig(u.learner, u.grade);    // cap 15 → 上限 23
  pace.normalizePace(u, cfg);
  pace.markSessionStart(u, cfg);
  u.pace.sessionStartAt = Date.now() - 300 * 60000;
  eq('幼儿园封顶 23（15*1.5 上取整）', pace.settleSession(u, cfg), 23);
}

/* ---------------------------------------------------------------- */
section('E. 单节上限（轻提示，非阻断）');

{
  const cfg = pace.derivePaceConfig({ stage: '小学' }, '');
  eq('20 分钟未超小学上限 25', pace.checkSessionCap(20, cfg).over, false);
  eq('25 分钟不超（边界含等号）', pace.checkSessionCap(25, cfg).over, false);
  eq('26 分钟超上限', pace.checkSessionCap(26, cfg).over, true);

  const k = pace.derivePaceConfig({ stage: '幼儿园' }, '');
  eq('幼儿园 16 分钟即超（上限 15）', pace.checkSessionCap(16, k).over, true);
  eq('幼儿园 15 分钟不超', pace.checkSessionCap(15, k).over, false);

  const j = pace.derivePaceConfig({ stage: '初中' }, '');
  eq('初中 38 分钟不超', pace.checkSessionCap(38, j).over, false);
  eq('初中 39 分钟超', pace.checkSessionCap(39, j).over, true);
}

/* ---------------------------------------------------------------- */
section('F. 视图模型（UI 契约）');

{
  const u = fresh({ stage: '小学', weeklyMinutes: 300 });
  const cfg = pace.derivePaceConfig(u.learner, u.grade);
  const s0 = pace.snapshot(u, cfg);
  eq('满状态 level=high', s0.level, 'high');
  eq('满状态 emoji=🌿', s0.emoji, '🌿');
  eq('满状态 pct=100', s0.pct, 100);
  eq('满状态无提示语', s0.tip, '');

  pace.spend(u, 35, cfg);                      // 43 → 8，≈18% → low
  const s1 = pace.snapshot(u, cfg);
  eq('≈18% → level=low', s1.level, 'low');
  eq('low → emoji=🍃', s1.emoji, '🍃');
  eq('low → 有提示语', s1.tip, '该让大脑歇歇啦');

  pace.spend(u, 6, cfg);                       // → 2，≈4% → crit
  const s2 = pace.snapshot(u, cfg);
  eq('≈4% → level=crit', s2.level, 'crit');
  eq('crit → emoji=🔋', s2.emoji, '🔋');

  ok('pct 始终在 0..100', s2.pct >= 0 && s2.pct <= 100);
  eq('余 2 点时 pct=5（2/43 四舍五入）', s2.pct, 5);
  eq('weeklyUsed 累加正确', s2.weeklyUsed, 41);
  eq('weeklyTotal = 档案周时长', s2.weeklyTotal, 300);
  eq('capMin 透出给 UI', s2.capMin, 25);

  // 真正耗尽（再扣 2 点归零）
  pace.spend(u, 2, cfg);
  const s3 = pace.snapshot(u, cfg);
  eq('耗尽 → energy=0', s3.energy, 0);
  eq('耗尽 → pct=0', s3.pct, 0);
  eq('耗尽 → level=crit', s3.level, 'crit');
  eq('耗尽 → 仍非阻断（只提示，不锁死）', s3.emoji, '🔋');

  eq('snapshot(null) 不崩且满状态', pace.snapshot(null).level, 'high');
  eq('snapshot(undefined) 不崩', pace.snapshot(undefined).pct, 100);
}

/* ---------------------------------------------------------------- */
section('G. 数据形状契约（R4 字段只增）');

{
  const d = pace.defaultPace();
  const keys = Object.keys(d).sort();
  eq('形状字段数=8', keys.length, 8);
  eq('初始 energy=-1（未初始化）', d.energy, -1);
  eq('初始 lastResetDate 空', d.lastResetDate, '');
  eq('初始计数为 0', d.todayUsedMin + d.weekUsedMin, 0);
  // 快照键必须齐
  const snapKeys = Object.keys(pace.snapshot(fresh({ stage: '小学' }))).sort();
  ['energy', 'pool', 'pct', 'level', 'emoji', 'tip', 'capMin', 'weeklyUsed', 'weeklyTotal', 'derived']
    .forEach(k => ok('snapshot 含字段 ' + k, snapKeys.indexOf(k) >= 0));
}

/* ---------------------------------------------------------------- */
section('H. 合规（禁用词门禁 + 不绑定七岁）');

{
  // orderKit 的 11 词禁用表（掌握类断言）
  const BANNED = ['已掌握', '已精通', '学会了', '完全懂了', '完全掌握', '稳稳掌握',
                  '掌握了', '精通了', '已学会', '学懂了', '全懂了'];
  const u = fresh({ stage: '小学', weeklyMinutes: 300 });
  const cfg = pace.derivePaceConfig(u.learner, u.grade);
  let leaked = [];
  [0, 10, 20, 41, 43].forEach(m => {
    pace.spend(u, m, cfg);
    const s = pace.snapshot(u, cfg);
    leaked = leaked.concat(BANNED.filter(w => String(s.tip).indexOf(w) >= 0));
  });
  eq('各状态提示语均不含禁用词', leaked.length, 0);

  const capTxt = pace.checkSessionCap(99, cfg);
  ok('上限提示不含禁用词', BANNED.every(w => JSON.stringify(capTxt).indexOf(w) < 0));

  // 源码级：不得出现任何硬编码年龄常量
  const src = require('fs').readFileSync(path.join(__dirname, '../miniprogram/utils/pace.js'), 'utf8');
  const ageHardcode = src.match(/['"]?[1-6]\s*岁/g);
  eq('源码无「N 岁」硬编码', ageHardcode ? ageHardcode.length : 0, 0);
  eq('源码无 age 字段依赖', /profile\s*\.\s*age|\bage\b\s*[:=]/.test(src) ? 1 : 0, 0);
}

console.log('\n────────────────────────────────────────');
console.log(fail === 0
  ? `通过 ${pass} / ${pass + fail}   ✓ 全部通过`
  : `通过 ${pass} / ${pass + fail}   ✗ 失败 ${fail} 项：\n  - ` + failures.join('\n  - '));
console.log('────────────────────────────────────────');
process.exit(fail === 0 ? 0 : 1);
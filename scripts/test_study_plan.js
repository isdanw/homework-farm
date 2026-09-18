/**
 * 成长计划引擎回归测试（Node + mock wx）
 * 覆盖：normalizePlan 校验 / 未开始 / 正常 / 超前 / 滞后 评估 / 打卡天数统计 / 阶段状态
 */
const BASE_KEY = 'wb_hwfarm_data_v2';

const mem = {};
const CFG_SUB = [
  { key: 'chinese', name: '语文', emoji: '📕', color: '#FFC9DC' },
  { key: 'math', name: '数学', emoji: '📗', color: '#BFE6FF' }
];
mem[BASE_KEY] = {
  version: 2,
  users: [{
    id: 'u1', nickname: '小豆', avatar: '🐯', grade: '一年级', createdAt: Date.now(),
    lastActiveDate: '', settledDates: [],
    profile: { nickname: '小豆', streak: 0, lastFullCheckinDate: '', equipped: {} },
    homework: {}, checkinTypes: [], plans: {}, learn: { stars: 0 }, comments: [],
    farm: { coins: 20, suns: 1, seeds: {}, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] }
  }],
  currentUserId: 'u1'
};

global.wx = {
  getStorageSync(k) { return mem[k]; },
  setStorageSync(k, v) { mem[k] = v; },
  removeStorageSync(k) { delete mem[k]; },
  getStorageInfoSync() { return { keys: Object.keys(mem) }; },
  showToast() {}, showLoading() {}, hideLoading() {}, showModal() {},
  vibrateShort() {},
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager() { return { saveFileSync: p => p, copyFileSync: () => {}, unlinkSync: () => {}, writeFileSync: () => {}, readFileSync: () => '' }; }
};

const store = require('../miniprogram/utils/store.js');
const studyPlan = require('../miniprogram/utils/studyPlan.js');
const util = require('../miniprogram/utils/util.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

/* 计划夹具：5 项任务共 10 天（2+2+1 | 2+3） */
const AI_PLAN = {
  stages: [
    { name: '第1单元 准备课', weeks: '第1-2周', goal: '建立数感', tasks: [
      { name: '认识数字1-5', days: 2 }, { name: '认识数字6-10', days: 2 }, { name: '10以内口算闯关', days: 1 }
    ] },
    { name: '第2单元 比较与分类', weeks: '第3-4周', goal: '会比较分类', tasks: [
      { name: '比大小比多少', days: 2 }, { name: '分类整理小成果', days: 3 }
    ] }
  ]
};
// 掺脏数据的版本：坏任务应被剔除
const DIRTY_PLAN = {
  stages: [
    { name: '', weeks: '', goal: '', tasks: [{ name: '  ', days: 0 }] },
    { name: '有效阶段', tasks: [{ name: '正常任务', days: 2 }, null, { days: 3 }, { name: '超长任务名超长任务名超长任务名超长任务名超长任务名超长任务名超长任务名超长任务名X', days: 99 }] }
  ]
};

(async () => {
  await store.initAccount().catch(() => {});
  const u = store.get();
  const KEY = 'math';

  console.log('normalizePlan 规范化:');
  const plan = studyPlan.normalizePlan(AI_PLAN, { grade: '一年级', term: '上学期', textbook: '人教版', subjectName: '数学' });
  ok(!!plan, '合法 JSON 生成计划');
  ok(plan.stages.length === 2 && plan.stages[0].tasks.length === 3, '阶段/任务结构正确');
  ok(plan.totalTasks === undefined && studyPlan.totalDays(plan) === 10, '总排期 10 天（实际 ' + studyPlan.totalDays(plan) + '）');
  ok(plan.grade === '一年级' && plan.term === '上学期' && plan.textbook === '人教版', '快照元信息正确');
  ok(plan.startDate === '', '初始未开始');

  const dirty = studyPlan.normalizePlan(DIRTY_PLAN, { grade: '一年级', term: '上学期', textbook: '', subjectName: '数学' });
  ok(!!dirty && dirty.stages.length === 1 && dirty.stages[0].tasks.length === 2, '脏数据剔除（空阶段/空任务/缺 name）');
  ok(dirty.stages[0].tasks[1].days === 10, 'days 夹取 1-10（99 → 10）');
  ok(studyPlan.normalizePlan(null, {}) === null && studyPlan.normalizePlan({ stages: [] }, {}) === null, '非法结构返回 null');

  console.log('未开始状态:');
  studyPlan.savePlan(KEY, plan);
  let prog = studyPlan.getProgress(KEY);
  ok(prog.status === 'notstarted' && prog.statusText === '未开始', '未开始 → notstarted');
  ok(prog.started === false && prog.dueCount === 0, '未开始不产生应完成数');

  console.log('正常状态（第1天完成第1项[2天任务]）:');
  studyPlan.startPlan(KEY);
  studyPlan.setTaskDone(KEY, 0, 0, true);
  prog = studyPlan.getProgress(KEY);
  ok(prog.started && prog.elapsed === 1, '开始后 elapsed=1（实际 ' + prog.elapsed + '）');
  ok(prog.dueCount === 0 && prog.doneCount === 1, '2天任务第1天尚未到期 → 应完成 0 / 已完成 1');
  ok(prog.status === 'normal' && prog.statusText === '正常', '提前1项×2天=领先2天 <3 → 评估=正常');
  ok(prog.stages[0].statusText === '超前' && prog.stages[0].percent === 33, '阶段1 超前 33%（实际 ' + prog.stages[0].statusText + ' ' + prog.stages[0].percent + '%）');
  ok(prog.nextTask.name === '认识数字6-10', '下一项指向第2个任务');

  console.log('超前状态（第1天勾完3项）:');
  studyPlan.setTaskDone(KEY, 0, 1, true);
  studyPlan.setTaskDone(KEY, 0, 2, true);
  prog = studyPlan.getProgress(KEY);
  ok(prog.doneCount === 3 && prog.dueCount === 0, '完成 3 / 应完成 0');
  ok(prog.status === 'ahead' && prog.devDays > 0, '评估=超前，领先 ' + prog.devDays + ' 天');
  ok(prog.stages[0].statusText === '已完成' && prog.stages[1].statusText === '未开始', '阶段1 已完成 / 阶段2 未开始');

  console.log('滞后状态（ startDate 回溯 9 天，未再勾选）:');
  const p2 = studyPlan.getPlan(KEY);
  p2.startDate = util.daysAgo(9);
  studyPlan.savePlan(KEY, p2);
  prog = studyPlan.getProgress(KEY);
  ok(prog.elapsed === 10, 'elapsed=10（实际 ' + prog.elapsed + '）');
  ok(prog.dueCount === 5, '应完成 5 项（实际 ' + prog.dueCount + '）');
  ok(prog.status === 'lag' && prog.devDays < 0, '评估=滞后，落后 ' + (-prog.devDays) + ' 天');
  ok(prog.stages[0].statusText === '已完成' && prog.stages[1].statusText === '滞后', '阶段1 任务全勾→已完成 / 阶段2 滞后');

  console.log('打卡天数统计:');
  const u2 = store.get();
  u2.homework[util.today()] = u2.homework[util.today()] || {};
  u2.homework[util.today()]['math'] = { done: true, minutes: 10, note: '', doneAt: Date.now() };
  u2.homework[util.daysAgo(12)] = u2.homework[util.daysAgo(12)] || {};
  u2.homework[util.daysAgo(12)]['math'] = { done: true, minutes: 10, note: '', doneAt: Date.now() };  // 开始日之前，不应计入
  store.save(u2);
  prog = studyPlan.getProgress(KEY);
  ok(prog.checkinDays === 1, '只统计开始日以来的打卡天数（实际 ' + prog.checkinDays + '）');

  console.log('提示词来源与画像取值:');
  // 语文/数学 → 内置角色提示词（直接使用已提供的提示词）
  ok(studyPlan.getBuiltinRole('chinese') && studyPlan.getBuiltinRole('chinese').name === '校内语文题解', '语文内置角色=校内语文题解');
  ok(studyPlan.getBuiltinRole('math') && studyPlan.getPrompt('math').indexOf('校内数学') >= 0, '数学提示词取内置角色全文');
  ok(studyPlan.getPromptLabel('math').indexOf('内置角色') === 0, '数学提示词来源=内置角色');
  // 英语内置角色（用户提供：校内英语题解导学）
  ok(studyPlan.getBuiltinRole('english') && studyPlan.getBuiltinRole('english').name === '校内英语题解导学', '英语内置角色=校内英语题解导学');
  ok(studyPlan.getPrompt('english').indexOf('英语题解导学 Agent') >= 0, '英语提示词取内置角色全文');
  ok(studyPlan.getPromptLabel('english').indexOf('内置角色') === 0, '英语提示词来源=内置角色');
  // 自定义类型 → 画像自定义 / 默认兜底
  studyPlan.savePrompt('ct_custom', '自定义编排要求');
  ok(studyPlan.getPrompt('ct_custom') === '自定义编排要求', '自定义类型用画像自定义提示词');
  ok(studyPlan.getPromptLabel('ct_custom') === '自定义编排要求', '自定义来源=自定义');
  ok(studyPlan.getPromptLabel('ct_none') === '默认编排要求', '无画像类型兜底默认编排要求');
  // 学期从画像进度识别
  const pu = store.get();
  pu.subjectProfiles['english'] = pu.subjectProfiles['english'] || {};
  pu.subjectProfiles['english'].progress = '一年级上学期 第3单元';
  store.save(pu);
  ok(studyPlan.getTerm('english') === '上学期', '学期从进度识别=上学期');
  pu.subjectProfiles['english'].progress = '一年级下学期 第1单元';
  store.save(pu);
  ok(studyPlan.getTerm('english') === '下学期', '学期从进度识别=下学期');
  ok(studyPlan.getTerm('chinese') === '上学期', '识别不到时默认上学期');

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST_ERROR:', e); process.exit(1); });

/**
 * test-plan-checkin-sync.js —— 打卡 ⇄ 成长计划 单向读取特性测试
 *
 * 设计契约（2026-09-10 定案）：
 *   · 打卡与计划状态【解耦】：打卡只读计划任务，绝不回写计划的勾选状态
 *   · 读取口径：取计划中「最近一条未勾选」的任务；已勾选的自动顺延到下一条
 *   · 无需「开始计划」：开始计划只用于起算排期与进度对照，与「今天该做什么」无关
 *   · 快照固化：打卡时把任务名 / 阶段 / 下标写进当日记录，历史视图读快照（不现算）
 *
 * 覆盖：
 *   1. studyPlan.getCurrentTask —— 无计划 / 未开始 / 顺延 / 跨阶段 / 全勾完 / 取消勾选
 *   2. farmEngine.checkin 写入 planTask / planStage / planRef 快照，且不回写计划
 *   3. index.js 首页磁贴 doors 携带 planTask
 *   4. checkinDetail.render —— 今日实时读计划，历史读快照
 *
 * 运行：node scripts/test-plan-checkin-sync.js
 */
const path = require('path');

/* ---------- mock wx ---------- */
const storage = {};
global.wx = {
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  showToast: () => {}, showModal: () => {},
  showLoading: () => {}, hideLoading: () => {},
  navigateTo: () => {}, navigateBack: () => {}, switchTab: () => {},
  vibrateShort: () => {},
  cloud: { callFunction: () => Promise.resolve({ result: { ok: true } }) }
};
global.getApp = () => ({ runDailyRollover: () => {} });

let pageDef;
global.Page = (def) => { pageDef = def; };

/* 屏蔽游客模式噪声日志（store 未绑定微信时每次 save 都会打一行） */
const rawLog = console.log.bind(console);
console.log = (...a) => {
  if (typeof a[0] === 'string' && a[0].indexOf('[store]') === 0) return;
  rawLog(...a);
};

const store = require('../miniprogram/utils/store.js');
const studyPlan = require('../miniprogram/utils/studyPlan.js');
const engine = require('../miniprogram/utils/farmEngine.js');
const util = require('../miniprogram/utils/util.js');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}

/* 构造一份数学计划 */
function makePlan() {
  return {
    grade: '一年级', term: '上学期', textbook: '人教版', subjectName: '数学',
    startDate: '', createdAt: Date.now(), updatedAt: 0,
    stages: [
      { name: '第一阶段', weeks: '2周', goal: '数感启蒙', tasks: [
        { name: '会数 1-10 并指读', days: 2, done: false, doneAt: '' },
        { name: '认识加减号', days: 3, done: false, doneAt: '' }
      ]},
      { name: '第二阶段', weeks: '2周', goal: '20 以内加减', tasks: [
        { name: '20 以内不进位加法', days: 3, done: false, doneAt: '' }
      ]}
    ]
  };
}

/** 造一个页面实例（复用 global.Page 捕获的定义） */
function instance(pageDefObj, dataPatch) {
  const inst = Object.create(pageDefObj);
  inst.data = Object.assign(JSON.parse(JSON.stringify(pageDefObj.data)), dataPatch || {});
  inst.setData = function (patch) { Object.assign(this.data, patch); };
  return inst;
}

/* ============ 1. getCurrentTask 状态判定 ============ */
console.log('=== 1. studyPlan.getCurrentTask：读取与顺延 ===');
store.addUser({ nickname: '加一', avatar: '🐯', grade: '一年级' });

ok('无计划 → null', studyPlan.getCurrentTask('math') === null);

studyPlan.savePlan('math', makePlan());
const cur0 = studyPlan.getCurrentTask('math');
ok('未点「开始计划」也能读到首个任务（无门槛）', !!cur0 && cur0.name === '会数 1-10 并指读');
ok('携带阶段名', cur0 && cur0.stageName === '第一阶段');
ok('携带任务下标 si/ti', cur0 && cur0.si === 0 && cur0.ti === 0);
ok('携带应完成日 dueDay', cur0 && cur0.dueDay === 2);

// 勾选第 1 条 → 顺延到第 2 条
studyPlan.setTaskDone('math', 0, 0, true);
const cur1 = studyPlan.getCurrentTask('math');
ok('已勾选的任务自动跳过 → 顺延到下一条', !!cur1 && cur1.name === '认识加减号');
ok('顺延任务下标正确（si=0, ti=1）', cur1 && cur1.si === 0 && cur1.ti === 1);

// 勾完第一阶段 → 跨到第二阶段
studyPlan.setTaskDone('math', 0, 1, true);
const cur2 = studyPlan.getCurrentTask('math');
ok('本阶段勾完 → 跨阶段顺延', !!cur2 && cur2.name === '20 以内不进位加法' && cur2.si === 1 && cur2.ti === 0);

// 全部勾完 → null
studyPlan.setTaskDone('math', 1, 0, true);
ok('任务全部勾完 → null', studyPlan.getCurrentTask('math') === null);

// 取消勾选 → 重新回到该任务
studyPlan.setTaskDone('math', 0, 0, false);
studyPlan.setTaskDone('math', 0, 1, false);
studyPlan.setTaskDone('math', 1, 0, false);
const cur = studyPlan.getCurrentTask('math');
ok('取消勾选后重新回到该任务', cur && cur.name === '会数 1-10 并指读');

// 开始计划不改变「当前任务」
studyPlan.startPlan('math');
ok('点「开始计划」不改变当前任务（开始 ≠ 今天该做什么）',
  studyPlan.getCurrentTask('math').name === '会数 1-10 并指读');

/* ============ 2. checkin 写入快照且不回写计划 ============ */
console.log('=== 2. farmEngine.checkin：快照固化 + 单向 ===');
const today = util.today();
const d = store.get();
const gain = engine.checkin(d, 'math', {
  note: '做了口算', minutes: 15,
  planTask: cur.name, planStage: cur.stageName, planRef: { si: cur.si, ti: cur.ti }
});
const rec = d.homework[today].math;
ok('打卡返回奖励', !!gain);
ok('planTask 快照写入', rec.planTask === '会数 1-10 并指读');
ok('planStage 快照写入', rec.planStage === '第一阶段');
ok('planRef 快照写入（si/ti）', !!rec.planRef && rec.planRef.si === 0 && rec.planRef.ti === 0);
ok('note 保留', rec.note === '做了口算');

const plan = studyPlan.getPlan('math');
ok('★ 打卡不回写计划勾选状态（单向）',
  plan.stages[0].tasks[0].done === false && plan.stages[0].tasks[1].done === false);

// 空值兜底
const d2 = store.get();
engine.checkin(d2, 'chinese', { note: '', minutes: 0, planTask: '', planStage: '', planRef: null });
ok('未带任务时快照为空（不写脏值）',
  d2.homework[today].chinese.planTask === '' &&
  d2.homework[today].chinese.planStage === '' &&
  d2.homework[today].chinese.planRef === null);

/* ============ 3. 首页磁贴携带 planTask ============ */
console.log('=== 3. 首页磁贴 doors 携带 planTask ===');
require('../miniprogram/pages/index/index.js');
const idx = instance(pageDef);
let lastDoors = [];
idx.setData = function (patch) { if (patch.doors) lastDoors = patch.doors; };
idx.render();
const mathDoor = lastDoors.find(x => x.key === 'math');
ok('数学磁贴携带 planTask', !!mathDoor && mathDoor.planTask === '会数 1-10 并指读');
const chiDoor = lastDoors.find(x => x.key === 'chinese');
ok('无计划科目 planTask 为空', !!chiDoor && chiDoor.planTask === '');

/* ============ 4. 打卡详情页：今日实时 / 历史快照 ============ */
console.log('=== 4. checkinDetail.render：今日实时 vs 历史快照 ===');
require('../miniprogram/pkgTools/checkinDetail/checkinDetail.js');
const cdDef = pageDef;

// 4.1 今日视图：实时读计划
const cdToday = instance(cdDef, { key: 'math', date: '' });
cdToday.render();
ok('今日视图读计划 → 当前任务', cdToday.data.planTask === '会数 1-10 并指读');
ok('今日视图 planRef 可回链', !!cdToday.data.planRef && cdToday.data.planRef.ti === 0);

// 4.2 计划勾选推进后，今日视图跟随顺延
studyPlan.setTaskDone('math', 0, 0, true);
const cdToday2 = instance(cdDef, { key: 'math', date: '' });
cdToday2.render();
ok('今日视图跟随计划顺延', cdToday2.data.planTask === '认识加减号');
studyPlan.setTaskDone('math', 0, 0, false);

// 4.3 历史视图：读当时固化的快照（计划已被改动也不受影响）
const past = '2026-09-01';
const dh = store.get();
engine.ensureDay(dh, past);
dh.homework[past].math.done = true;
dh.homework[past].math.planTask = '认识加减号';
dh.homework[past].math.planStage = '第一阶段';
dh.homework[past].math.planRef = { si: 0, ti: 1 };
store.save(dh);

const cdHist = instance(cdDef, { key: 'math', date: past });
cdHist.render();
ok('历史视图识别为历史', cdHist.data.isToday === false);
ok('历史视图读快照而非现算', cdHist.data.planTask === '认识加减号');
ok('历史视图带回快照阶段', cdHist.data.planStage === '第一阶段');
ok('历史视图带回快照下标', !!cdHist.data.planRef && cdHist.data.planRef.ti === 1);

// 4.4 历史无快照 → 空（不误读当前计划）
const past2 = '2026-09-02';
engine.ensureDay(store.get(), past2);
const cdEmpty = instance(cdDef, { key: 'math', date: past2 });
cdEmpty.render();
ok('历史无快照 → 不误读当前计划', cdEmpty.data.planTask === '' && cdEmpty.data.planRef === null);

/* ============ 5. 回链 URL ============ */
console.log('=== 5. 打卡 → 计划 回链 ===');
let navUrl = '';
wx.navigateTo = (o) => { navUrl = o.url; };
cdHist.goPlanTask();
ok('历史快照可回链定位计划任务',
  navUrl === '/pkgTools/plan/plan?key=math&si=0&ti=1');
navUrl = '';
cdEmpty.goPlanTask();
ok('无下标时回链不带定位参数',
  navUrl === '/pkgTools/plan/plan?key=math');

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);

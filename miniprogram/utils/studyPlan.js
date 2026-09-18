/**
 * ============================================================================
 *  studyPlan.js —— 成长计划（阶段计划生成 + 打卡进度对照）引擎
 *  ---------------------------------------------------------------------------
 *  职责：
 *   ① 计划生成：按「打卡类型 + 年级 + 学期 + 教材 + 计划提示词」调云函数
 *      studyPlanGen（CloudBase 内置 AI）生成阶段计划，normalizePlan 防御性校验后落库；
 *   ② 进度对照：已完成任务数（**以勾选为准**）vs 计划排期（任务累计天数 = 应完成日），
 *      逐项 + 逐阶段统计完成情况与偏差天数；
 *   ③ 状态评估：整体与各阶段给出 超前 / 正常 / 滞后（偏差 ≥3 天触发）；
 *   ④ 任务引用（getCurrentTask）：每日打卡**读取**计划中「最近一条未勾选」的任务，
 *      已勾选的自动顺延到下一条。**单向**：打卡只读计划，不回写计划的勾选状态
 *      —— 成长计划的阶段任务是跨多天的，一次打卡不等价于完成一个多天任务。
 *
 *  ⚠️ 打卡与计划状态解耦：`checkinDays` 仅作展示，不参与 doneCount / devDays / status 推导。
 *
 *  数据结构（u.studyPlans[typeKey]，随 store.save 上云）：
 *    {
 *      grade, term, textbook, subjectName,
 *      startDate: '' | 'YYYY-MM-DD',        // 点「开始计划」当天起算排期
 *      createdAt, updatedAt,
 *      stages: [{ name, weeks, goal, tasks: [{ name, days, done, doneAt }] }]
 *    }
 *  计划提示词：subjectProfiles[typeKey].planPrompt（学科画像页配置）
 * ============================================================================
 */
const store = require('./store.js');
const util = require('./util.js');
const { BUILTIN_ROLES } = require('./rolePresets.js');

const PLANS_KEY = 'studyPlans';
const AHEAD_DAYS = 3;      // 偏差 ≥3 天视为超前
const LAG_DAYS = 3;        // 偏差 ≥3 天视为滞后

/** 默认计划提示词（类型未自定义时使用） */
function defaultPrompt(typeName) {
  return '请围绕' + (typeName || '本科目') + '的主线知识与技能编排，' +
    '任务要具体、可核对（如「会认读第1-2课生字并组词」），由浅入深，' +
    '每个阶段结束安排 1 个可展示的成果任务（如朗读打卡 / 口算闯关）';
}

/** 内置学科角色（语数英中已提供提示词的：语文=校内语文题解、数学=校内数学导学） */
function getBuiltinRole(key) {
  return BUILTIN_ROLES.find(r => r.key === key) || null;
}

/* --------------------------- 基础读写 --------------------------- */

function ensureMap(u) {
  if (!u[PLANS_KEY] || typeof u[PLANS_KEY] !== 'object') u[PLANS_KEY] = {};
  return u[PLANS_KEY];
}

function getPlan(key) {
  const u = store.get();
  ensureMap(u);
  return u[PLANS_KEY][key] || null;
}

function savePlan(key, plan) {
  const u = store.get();
  ensureMap(u);
  plan.updatedAt = Date.now();
  u[PLANS_KEY][key] = plan;
  store.save(u);
  return plan;
}

function removePlan(key) {
  const u = store.get();
  ensureMap(u);
  if (!u[PLANS_KEY][key]) return false;
  delete u[PLANS_KEY][key];
  store.save(u);
  return true;
}

/** 计划提示词：语文/数学直接用内置学科角色提示词；其余类型用画像自定义，默认兜底 */
function getPrompt(key) {
  const role = getBuiltinRole(key);
  if (role) return role.prompt;
  const p = store.getSubjectProfile(key);
  return (p && p.planPrompt) ? p.planPrompt : defaultPrompt(store.getType(key).name);
}

/** 提示词来源标签（页面展示用） */
function getPromptLabel(key) {
  const role = getBuiltinRole(key);
  if (role) return '内置角色：' + role.name;
  const p = store.getSubjectProfile(key);
  return (p && p.planPrompt) ? '自定义编排要求' : '默认编排要求';
}

/** 学期：从画像「当前进度 / 学校进度」里识别上/下学期，识别不到默认上学期 */
function getTerm(key) {
  const u = store.get();
  const p = store.getSubjectProfile(key);
  const texts = [p && p.progress, u.learner && u.learner.schoolProgress, u.learner && u.learner.stage];
  for (const t of texts) {
    if (!t) continue;
    if (/下学期/.test(t)) return '下学期';
    if (/上学期/.test(t)) return '上学期';
  }
  return '上学期';
}

function savePrompt(key, text) {
  store.saveSubjectProfile(key, { planPrompt: (text || '').trim() });
}

/* --------------------------- 计划规范化 --------------------------- */

/** 防御性校验 AI 返回的计划 JSON；结构不合法返回 null */
function normalizePlan(raw, meta) {
  if (!raw || !Array.isArray(raw.stages) || !raw.stages.length) return null;
  const stages = [];
  raw.stages.slice(0, 12).forEach(st => {
    if (!st || typeof st.name !== 'string' || !st.name.trim()) return;
    const tasks = (Array.isArray(st.tasks) ? st.tasks : [])
      .map(t => {
        if (!t || typeof t.name !== 'string' || !t.name.trim()) return null;
        const days = Math.max(1, Math.min(10, Number(t.days) || 1));
        return { name: t.name.trim().slice(0, 40), days: days, done: false, doneAt: '' };
      })
      .filter(Boolean)
      .slice(0, 12);
    if (!tasks.length) return;
    stages.push({
      name: st.name.trim().slice(0, 30),
      weeks: String(st.weeks || '').slice(0, 20),
      goal: String(st.goal || '').slice(0, 60),
      tasks: tasks
    });
  });
  if (!stages.length) return null;
  return {
    grade: (meta && meta.grade) || '',
    term: (meta && meta.term) || '',
    textbook: (meta && meta.textbook) || '',
    subjectName: (meta && meta.subjectName) || '',
    startDate: '',
    createdAt: Date.now(),
    updatedAt: 0,
    stages: stages
  };
}

/* --------------------------- 排期与对照 --------------------------- */

/** 计划总天数 */
function totalDays(plan) {
  return plan.stages.reduce((s, st) => s + st.tasks.reduce((a, t) => a + t.days, 0), 0);
}

/** 展开为平铺任务表：[{ stageIdx, ti, stageName, task, dueDay }]（dueDay=按排期应完成日） */
function flatten(plan) {
  let cum = 0;
  const rows = [];
  plan.stages.forEach((st, si) => {
    st.tasks.forEach((t, ti) => {
      cum += t.days;
      rows.push({ stageIdx: si, ti: ti, stageName: st.name, task: t, dueDay: cum });
    });
  });
  return rows;
}

/** 某类型自计划开始日以来已打卡的天数（homework 里该类型 done=true 的日期数） */
function countCheckinDays(key, plan) {
  if (!plan.startDate) return 0;
  const u = store.get();
  const hw = u.homework || {};
  let n = 0;
  Object.keys(hw).forEach(date => {
    if (plan.startDate && date >= plan.startDate && hw[date] && hw[date][key] && hw[date][key].done) n++;
  });
  return n;
}

/**
 * 进度对照 + 状态评估（核心）
 * @returns {Object|null} {
 *   started, elapsed, plannedDays, totalTasks, doneCount, dueCount,
 *   checkinDays, status: 'notstarted'|'ahead'|'normal'|'lag',
 *   statusText, devDays, avgDaysPerTask,
 *   nextTask: { name, dueDay, stageName, si, ti } | null,
 *   stages: [{ name, weeks, goal, total, done, due, statusText, percent }]
 * }
 */
function getProgress(key) {
  const plan = getPlan(key);
  if (!plan) return null;

  const rows = flatten(plan);
  const totalTasks = rows.length;
  const plannedDays = totalDays(plan);
  const avgDaysPerTask = totalTasks ? plannedDays / totalTasks : 1;
  const started = !!plan.startDate;
  const elapsed = started ? Math.max(1, util.diffDays(util.today(), plan.startDate) + 1) : 0;
  const horizon = started ? Math.min(elapsed, plannedDays) : 0;

  let doneCount = 0, dueCount = 0, lagDays = 0, nextTask = null;
  const stageStat = plan.stages.map(st => ({ name: st.name, weeks: st.weeks, goal: st.goal, total: st.tasks.length, done: 0, due: 0 }));

  rows.forEach(r => {
    if (r.task.done) doneCount++;
    if (started && r.dueDay <= horizon) {
      dueCount++;
      stageStat[r.stageIdx].due++;
    }
    if (r.task.done) stageStat[r.stageIdx].done++;
    if (!r.task.done && started && r.dueDay <= horizon) {
      const d = elapsed - r.dueDay;
      if (d > lagDays) lagDays = d;             // 最久逾期天数
    }
    if (!r.task.done && !nextTask) {
      nextTask = {
        name: r.task.name, dueDay: r.dueDay, stageName: r.stageName,
        si: r.stageIdx, ti: r.ti            // 下标：供打卡记录回链到计划中的具体任务
      };
    }
  });

  // 偏差天数：超前 = 超出应完成的部分按平均天数折算；滞后 = 最久逾期天数
  let devDays = 0;
  if (doneCount > dueCount) devDays = Math.round((doneCount - dueCount) * avgDaysPerTask);
  else if (dueCount > doneCount) devDays = -Math.max(lagDays, Math.round((dueCount - doneCount) * avgDaysPerTask));

  let status = 'notstarted', statusText = '未开始';
  if (started) {
    if (devDays >= AHEAD_DAYS) { status = 'ahead'; statusText = '超前'; }
    else if (devDays <= -LAG_DAYS) { status = 'lag'; statusText = '滞后'; }
    else { status = 'normal'; statusText = '正常'; }
  }

  const stages = stageStat.map(s => {
    let t = '未开始', percent = 0;
    if (s.done >= s.total && s.total > 0) { t = '已完成'; percent = 100; }
    else if (started) {
      if (s.done > s.due) t = '超前';
      else if (s.due > s.done) t = '滞后';
      else t = s.due > 0 ? '进行中' : '未开始';
      percent = Math.round(s.done / s.total * 100);
    }
    return Object.assign({}, s, { statusText: t, percent: percent });
  });

  return {
    started: started,
    elapsed: elapsed,
    plannedDays: plannedDays,
    totalTasks: totalTasks,
    doneCount: doneCount,
    dueCount: dueCount,
    checkinDays: countCheckinDays(key, plan),
    status: status,
    statusText: statusText,
    devDays: devDays,
    nextTask: nextTask,
    stages: stages
  };
}

/** 标记/取消任务完成 */
function setTaskDone(key, stageIdx, taskIdx, done) {
  const plan = getPlan(key);
  if (!plan || !plan.stages[stageIdx] || !plan.stages[stageIdx].tasks[taskIdx]) return false;
  const t = plan.stages[stageIdx].tasks[taskIdx];
  t.done = !!done;
  t.doneAt = done ? util.today() : '';
  savePlan(key, plan);
  return true;
}

/**
 * 当前应做的任务（每日打卡「读取」成长计划用）
 *  · 取法：按计划顺序取最近一条「未勾选」的任务；已勾选的自动跳过，顺延到下一个
 *  · 不要求计划已「开始」：「开始计划」只用于起算排期与进度对照，
 *    与「今天该做什么」无关 —— 计划一生成即可读取
 *  · 单向：打卡只读计划，不改变计划的勾选状态
 *  · @returns {{name:string, dueDay:number, stageName:string, si:number, ti:number}|null}
 *    无计划 / 任务已全部勾选 → null
 */
function getCurrentTask(key) {
  const prog = getProgress(key);
  if (!prog || !prog.nextTask) return null;
  return prog.nextTask;
}

/** 开始计划（排期从今天起算） */
function startPlan(key) {
  const plan = getPlan(key);
  if (!plan) return false;
  plan.startDate = util.today();
  savePlan(key, plan);
  return true;
}

module.exports = {
  PLANS_KEY, AHEAD_DAYS, LAG_DAYS,
  defaultPrompt, getBuiltinRole, getPlan, savePlan, removePlan,
  getPrompt, getPromptLabel, getTerm, savePrompt,
  normalizePlan, totalDays, flatten, countCheckinDays,
  getProgress, setTaskDone, startPlan, getCurrentTask
};

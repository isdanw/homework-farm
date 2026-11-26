/**
 * 成长计划页 —— 阶段计划生成 + 打卡进度对照
 *  · 按打卡类型各一份计划：年级 + 学期 + 教材 + 该科计划提示词 → AI 生成阶段/任务
 *  · 逐任务勾选完成，系统按排期（任务累计天数）对照实际打卡进度
 *  · 整体与分阶段给出 超前 / 正常 / 滞后 评估
 */
const store = require('../../utils/store.js');
const studyPlan = require('../../utils/studyPlan.js');
const util = require('../../utils/util.js');
const parentAuth = require('../../utils/parentAuth.js');
const tutorStore = require('../../utils/tutorStore.js');
const wi = require('../../utils/workbenchKpImport.js');

const STATUS_STYLE = {
  ahead: { color: '#5FBF6B', bg: '#E7F6E8' },
  normal: { color: '#2E86DE', bg: '#E3F2FF' },
  lag: { color: '#E08A1E', bg: '#FFF3E0' },
  notstarted: { color: '#8A8A8A', bg: '#F0F2F5' }
};

/* P3a/P3b（2026-11-23/24）：「今日任务」区 = 工作台建的 Echo-Loop 知识流到期复习提醒。
 * 口径 = tutorStore.dueKpFlows()（nextReviewAt ≤ now 且未通关/未暂停）+ inProgressKpFlows()
 * （首学进行中，无排期；不并进来「下一步」永远触达不到），按学科分组。
 * subject 是工作台侧 key（mathematics/english/…），复用 SUBJECT_MAP 映射，未列出透传。
 * P3b 起可推进：advanceFlow 本地状态机前进 + 七档排期递进，写回走 tutorSync flows 动作；
 * 复测/通关仍回工作台（小程序不判通关、不产生 evidence）。 */
const FLOW_STEP_CN = { learn: '首学', practice: '练习', explain: '讲解', test: '复测', review: '复习' };
/** 推进按钮防连点：完成后冷却时长（吃掉双击的第二下） */
const ADVANCE_COOLDOWN_MS = 300;
/** 知识点名展示上限：卡片单行，超长截断加省略号（完整名看工作台） */
const KP_LABEL_MAX = 40;

function kpLabel(v) {
  const s = String(v || '');
  return s.length > KP_LABEL_MAX ? s.slice(0, KP_LABEL_MAX) + '…' : s;
}

function buildTodayTasks() {
  const now = Date.now();
  const groups = {};
  const order = [];
  const seen = {};
  tutorStore.dueKpFlows().concat(tutorStore.inProgressKpFlows()).forEach(f => {
    const fid = f.flowId || f.id;
    if (seen[fid]) return;   // 两类互斥（首学无排期），去重只是防御
    seen[fid] = true;
    const sub = wi.normalizeSubject(f.subject);
    if (!groups[sub.subject]) {
      groups[sub.subject] = { key: sub.subject, name: sub.subjectName, items: [] };
      order.push(sub.subject);
    }
    const t = f.nextReviewAt ? Date.parse(f.nextReviewAt) : 0;
    const lateMin = t ? Math.max(0, Math.floor((now - t) / 60000)) : 0;
    // P3b：推进按钮（只读→可推进）。首学到 test 停（复测回工作台：小程序不判通关）
    let btn = '', waitRetest = false;
    if (f.status === 'first_learning') {
      if (['learn', 'practice', 'explain'].indexOf(f.step) >= 0) btn = '下一步';
      else waitRetest = true;   // step='test'
    } else if (f.status === 'reviewing') {
      btn = f.step === 'practice' ? '下一步' : '完成本轮复习';
    }
    groups[sub.subject].items.push({
      flowId: f.flowId || f.id,
      kp: kpLabel(f.knowledgePoint),
      step: FLOW_STEP_CN[f.step] || f.step || '',
      due: f.status === 'first_learning' ? '首学进行中'
         : lateMin >= 1440 ? '到期 ' + Math.floor(lateMin / 1440) + ' 天'
         : lateMin >= 60 ? '到期 ' + Math.floor(lateMin / 60) + ' 小时'
         : '刚到期',
      round: f.reviewRound || 0,
      btn: btn,
      waitRetest: waitRetest
    });
  });
  return order.map(k => groups[k]);
}

/** 限流重试策略：等待超过 30 秒不给「重试」（属小时档超限），只提示稍后再试 */
const RATE_RETRY_MAX_MS = 30000;
/** 旧版云函数未回传 retryAfterMs 时的兜底等待（与 studyPlanGen 的 10 秒窗口对齐） */
const RATE_FALLBACK_WAIT_MS = 10000;

/** 取云函数回传的等待毫秒数；未回传时用兜底值，保证重试不会立刻再撞限流 */
function rateWaitOf(r) {
  const ms = Number(r && r.retryAfterMs);
  return ms > 0 ? ms : RATE_FALLBACK_WAIT_MS;
}

Page({
  data: {
    types: [],
    key: '',
    typeName: '',
    typeEmoji: '',
    typeColor: '#BFE6FF',

    plan: null,
    /* 自动取自画像：年级（孩子资料）/ 学期（进度）/ 教材（学科画像） */
    grade: '',
    term: '上学期',
    textbook: '',
    promptLabel: '',
    generating: false,

    /* 状态卡 */
    prog: null,

    /* 教学计划参考（与成长计划关联） */
    tpTitle: '',
    tpFormat: '',

    /* 今日任务（P3a 只读：工作台知识流到期复习，按学科分组） */
    todayTasks: [],
    todayCount: 0,

    /* 阶段视图模型 */
    stageList: []
  },

  onLoad(options) {
    const key = (options && options.key) || '';
    // 可选：定位到指定任务（从打卡记录「计划」按钮回链过来）?si=&ti=
    const hasRef = !!(options && options.si !== undefined && options.ti !== undefined);
    const si = hasRef ? Number(options.si) : -1;
    const ti = hasRef ? Number(options.ti) : -1;
    this._focusKey = (si >= 0 && ti >= 0) ? (si + '-' + ti) : '';
    this._scrollDone = false;
    this.initKey(key || (store.getTypeList()[0] || {}).key || '');
  },

  onShow() { if (this.data.key) this.render(); },

  /** 离页标记：限流延时重试的定时器可能在页面卸载后触发，需丢弃 */
  onUnload() { this._destroyed = true; },

  initKey(key) {
    const types = store.getTypeList().map(t => ({ key: t.key, name: t.name, emoji: t.emoji || '📘', color: t.color || '#BFE6FF' }));
    this.setData({ types: types });
    if (key) { this.setData({ key: key }); this.render(); }
  },

  pickType(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.key) return;
    this.setData({ key: key, showPrompt: false });
    this.render();
  },

  render() {
    const key = this.data.key;
    const t = store.getType(key) || {};
    const profile = store.getSubjectProfile(key);
    const plan = studyPlan.getPlan(key);
    const prog = studyPlan.getProgress(key);

    // 今日任务（P3a 只读）：跨学科展示，不受当前 key 切换影响
    const todayTasks = buildTodayTasks();
    let todayCount = 0;
    todayTasks.forEach(g => { todayCount += g.items.length; });

    let stageList = [];
    if (plan && prog) {
      let cum = 0;
      const horizon = prog.started ? Math.min(prog.elapsed, prog.plannedDays) : 0;
      const curCheckin = studyPlan.countCheckinDays(key, plan);   // 实时打卡天数（绑定每日打卡），所有任务共用
      stageList = plan.stages.map((st, si) => {
        const stat = prog.stages[si] || {};
        const tasks = st.tasks.map((task, ti) => {
          cum += task.days;                                       // days 仅用于内部排期（应完成日 / 超前滞后）
          let cls = 'todo', tag = '待开始';
          if (task.done) { cls = 'done'; tag = '✓ 已完成' + (task.doneAt ? '（' + util.cnDate(task.doneAt) + '）' : ''); }
          else if (prog.started && cum <= horizon) {
            const late = prog.elapsed - cum;
            cls = 'overdue';
            tag = late > 0 ? '已逾期 ' + late + ' 天' : '今天应完成';
          } else if (prog.started && cum <= horizon + 1) { cls = 'due'; tag = '即将到期'; }
          return {
            name: task.name,
            done: task.done,
            planDays: task.days,                                  // 预期天数（用于「计划 vs 实际」对比）
            // 已完成 = 保存的真实任务耗时；未完成 = 实时绑定每日打卡的累计天数
            checkinDays: task.done ? (task.checkinDays || 0) : curCheckin,
            cls: cls, tag: tag,
            si: si, ti: ti, id: 'task-' + si + '-' + ti,
            hl: this._focusKey === (si + '-' + ti)      // 从打卡记录回链过来时高亮该任务
          };
        });
        return {
          name: st.name, weeks: st.weeks, goal: st.goal,
          si: si,
          allDone: tasks.length > 0 && tasks.every(t => t.done),
          stat: stat, tasks: tasks,
          barStyle: 'width:' + (stat.percent || 0) + '%',
          statColor: (STATUS_STYLE[stat.statusText === '超前' ? 'ahead' : stat.statusText === '滞后' ? 'lag' : stat.statusText === '已完成' ? 'ahead' : 'notstarted'] || STATUS_STYLE.notstarted).color
        };
      });
    }

    const style = prog ? (STATUS_STYLE[prog.status] || STATUS_STYLE.notstarted) : STATUS_STYLE.notstarted;
    const tp = profile.teachingPlan || null;
    this.setData({
      typeName: t.name || '',
      typeEmoji: t.emoji || '📘',
      typeColor: t.color || '#BFE6FF',
      plan: plan,
      grade: store.resolveGrade(),
      term: studyPlan.getTerm(key),
      textbook: profile.textbook || '',
      promptLabel: studyPlan.getPromptLabel(key),
      prog: prog,
      statusColor: style.color,
      statusBg: style.bg,
      stageList: stageList,
      tpTitle: tp ? tp.title : '',
      tpFormat: tp ? tp.format : '',
      todayTasks: todayTasks,
      todayCount: todayCount
    }, () => this.scrollToFocusTask());
  },

  /** 从打卡记录回链定位：滚动到目标任务（仅首次渲染后执行一次，高亮常驻到离开页面） */
  scrollToFocusTask() {
    if (!this._focusKey || this._scrollDone) return;
    this._scrollDone = true;
    setTimeout(() => {
      wx.pageScrollTo({
        selector: '#task-' + this._focusKey,
        duration: 300,
        offsetTop: -160,        // 顶部留出标题与科目切换条的遮挡空间
        fail: () => {}
      });
    }, 150);
  },

  /* ======================= 生成（年级/学期/教材/提示词均自动取自画像） ======================= */
  /** 去学科画像导入/查看教学计划（与成长计划关联） */
  goTpProfile() { wx.navigateTo({ url: '/pkgGuide/typeProfile/typeProfile?key=' + this.data.key }); },

  async generate() {
    // 改计划是家长特权动作（§7.6 审批矩阵）
    if (!(await parentAuth.requireScope('planEdit'))) return;
    if (this.data.generating) return;
    const grade = store.resolveGrade();
    if (!grade) {
      return wx.showModal({
        title: '还没有年级信息',
        content: '请先设置年级：①「我的 → 编辑资料」选择年级；或 ②「儿童画像 → 学校进度」填写（如「一年级上学期」），系统会自动识别。',
        confirmText: '去设置',
        success: (res) => { if (res.confirm) wx.navigateTo({ url: '/pkgGuide/learnerProfile/learnerProfile' }); }
      });
    }

    if (studyPlan.getPlan(this.data.key)) {
      wx.showModal({
        title: '重新生成',
        content: '会覆盖当前这份计划（已勾选的完成记录也会清空）。确定吗？',
        confirmColor: '#FF7A7A',
        success: (res) => { if (res.confirm) this._doGenerate(); }
      });
    } else this._doGenerate();
  },

  /** 实际发起生成（generate 与「限流重试」共用）：年级/学期/教材/提示词均实时取自画像 */
  _doGenerate() {
    const grade = store.resolveGrade();
    if (!grade) return util.toast('请先设置年级');
    const term = studyPlan.getTerm(this.data.key);
    const profile = store.getSubjectProfile(this.data.key);
    const textbook = (profile.textbook || '').trim();
    const textbookId = (profile.textbookId || '').trim();   // 教材库锚点（选用后按单元目录编排）
    const prompt = studyPlan.getPrompt(this.data.key);
    const teachingPlanRaw = (profile.teachingPlan && profile.teachingPlan.raw) || '';  // 教学计划参考（与教材目录同为学科画像设定）

    this.setData({ generating: true });
    wx.showLoading({ title: '编排中…', mask: true });
    wx.cloud.callFunction({
      name: 'studyPlanGen',
      data: {
        subject: this.data.typeName,
        grade: grade,
        term: term,
        textbook: textbook,
        textbookId: textbookId,
        planPrompt: prompt,
        teachingPlan: teachingPlanRaw
      }
    }).then(res => {
      wx.hideLoading();
      this.setData({ generating: false });
      const r = res && res.result;
      if (r && r.ok && r.plan) {
        const plan = studyPlan.normalizePlan(r.plan, {
          grade: grade, term: term,
          textbook: textbook,
          subjectName: this.data.typeName
        });
        if (!plan) return util.toast('生成结果不完整，请重试一次');
        studyPlan.savePlan(this.data.key, plan);
        this.render();
        const anchored = !!(r.textbookAnchored && textbook);
        wx.showModal({
          title: '计划已生成',
          content: (anchored ? '已按《' + textbook + '》单元目录编排。\n' : '') +
            '共 ' + plan.stages.length + ' 个阶段。点「开始计划」起算排期；之后每日打卡会自动带出当前待完成任务，任务完成请在此勾选。',
          showCancel: false, confirmText: '好的'
        });
      } else {
        // 限流：云函数回传 retryAfterMs（还需等待的毫秒数）。
        // 等待短的给「重试」，并在等满窗口后才真正重发——窗口内直接重发必然再次被拒
        // （rateWait 每次调用都会计数），会让家长连点几次都失败。
        const isRate = r && r.code === 'rate_limit';
        const waitMs = isRate ? rateWaitOf(r) : 0;
        const canRetry = isRate && waitMs <= RATE_RETRY_MAX_MS;
        const waitSec = Math.max(1, Math.ceil(waitMs / 1000));
        wx.showModal({
          title: '没能生成计划',
          content: canRetry
            ? ('生成得有点频繁～点「重试」会等 ' + waitSec + ' 秒后自动再来一次。')
            : ((r && r.msg) || '请稍后重试'),
          showCancel: canRetry,
          cancelText: canRetry ? '取消' : '',
          confirmText: canRetry ? '重试' : '知道了',
          success: (d) => { if (canRetry && d.confirm) this.retryGen(waitMs); }
        });
      }
    }).catch(err => {
      wx.hideLoading();
      this.setData({ generating: false });
      console.warn('[plan] generate fail', err);
      wx.showModal({
        title: '没能生成计划',
        content: '网络或云函数异常，请稍后重试',
        showCancel: false, confirmText: '知道了'
      });
    });
  },

  /** 限流重试：等满窗口后再发；期间保持 generating 锁，避免重复触发 */
  retryGen(waitMs) {
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), RATE_RETRY_MAX_MS);
    if (wait <= 0) return this._doGenerate();
    this.setData({ generating: true });
    wx.showLoading({ title: '等待 ' + Math.ceil(wait / 1000) + ' 秒…', mask: true });
    setTimeout(() => {
      wx.hideLoading();
      if (this._destroyed) return;   // 已离页，丢弃本次重试
      this._doGenerate();
    }, wait + 300);   // 多留 300ms 余量，避开窗口边界抖动
  },

  /* ======================= 排期与任务 ======================= */
  startPlan() {
    wx.showModal({
      title: '开始计划',
      content: '排期从今天开始起算，之后每天自动对照进度。确定吗？',
      success: (res) => {
        if (!res.confirm) return;
        studyPlan.startPlan(this.data.key);
        this.render();
        util.toast('计划已开始', 'success');
      }
    });
  },

  toggleTask(e) {
    const si = Number(e.currentTarget.dataset.si);
    const ti = Number(e.currentTarget.dataset.ti);
    const done = e.currentTarget.dataset.done !== 'true';
    studyPlan.setTaskDone(this.data.key, si, ti, done);
    this.render();
  },

  /** 跳转单元总结页（以计划阶段为单元，一键生成知识树总结） */
  goUnitSummary(e) {
    const si = e.currentTarget.dataset.si;
    wx.navigateTo({
      url: '/pkgTools/unitSummary/unitSummary?typeKey=' + this.data.key + '&si=' + si
    });
  },

  /** 从计划任务跳转 AI 导学（带任务上下文，导学结束可回写本任务完成状态） */
  goTutor(e) {
    const d = e.currentTarget.dataset;
    const url = '/pkgGuide/tutor/tutor?key=' + this.data.key +
      '&si=' + (d.si != null ? d.si : 0) +
      '&ti=' + (d.ti != null ? d.ti : 0) +
      '&task=' + encodeURIComponent(d.task || '') +
      '&stage=' + encodeURIComponent(d.stage || '') +
      '&goal=' + encodeURIComponent(d.goal || '');
    wx.navigateTo({ url: url });
  },

  async clearPlan() {
    if (!(await parentAuth.requireScope('planEdit'))) return;
    wx.showModal({
      title: '清除计划',
      content: '将删除该科目当前计划（不影响打卡记录）。确定吗？',
      confirmColor: '#FF7A7A',
      success: (res) => {
        if (!res.confirm) return;
        studyPlan.removePlan(this.data.key);
        this.render();
      }
    });
  },

  goProfile() {
    wx.navigateTo({ url: '/pkgGuide/typeProfile/typeProfile?key=' + this.data.key });
  },

  /** P3b：推进今日任务流（下一步 / 完成本轮复习）。
   * 家长特权动作（§7.6，复用 planEdit 会话，一次验证会话内有效不反复打断）；
   * 本地推进立即生效 + 刷新；写回由 commit→scheduleFlush 自动走 tutorSync flows 动作，
   * 失败留队不丢数据、不弹错打断孩子。
   * 防连点（2026-11-26）：首学四步没有到期守卫，双击会连跳两步（learn 一路跳到 explain）。
   * 两道闸：①执行中（含等家长授权的时间）一律忽略；②完成后 300ms 冷却，吃掉连点的第二下。 */
  async advanceTask(e) {
    const fid = e.currentTarget.dataset.fid;
    if (!fid) return;
    if (this._advBusy) return;
    if (this._advDoneAt && Date.now() - this._advDoneAt < ADVANCE_COOLDOWN_MS) return;
    this._advBusy = true;
    try {
      if (!(await parentAuth.requireScope('planEdit'))) return;
      const f = tutorStore.advanceFlow(fid);
      if (!f) return;   // 不可推进（通关/暂停/首学已到 test）——按钮本不该出现，防御
      this.render();
      wx.showToast({ title: '已推进 ✓', icon: 'none', duration: 1200 });
    } finally {
      this._advBusy = false;
      this._advDoneAt = Date.now();
    }
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});

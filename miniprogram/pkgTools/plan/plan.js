/**
 * 成长计划页 —— 阶段计划生成 + 打卡进度对照
 *  · 按打卡类型各一份计划：年级 + 学期 + 教材 + 该科计划提示词 → AI 生成阶段/任务
 *  · 逐任务勾选完成，系统按排期（任务累计天数）对照实际打卡进度
 *  · 整体与分阶段给出 超前 / 正常 / 滞后 评估
 */
const store = require('../../utils/store.js');
const studyPlan = require('../../utils/studyPlan.js');
const util = require('../../utils/util.js');

const STATUS_STYLE = {
  ahead: { color: '#5FBF6B', bg: '#E7F6E8' },
  normal: { color: '#2E86DE', bg: '#E3F2FF' },
  lag: { color: '#E08A1E', bg: '#FFF3E0' },
  notstarted: { color: '#8A8A8A', bg: '#F0F2F5' }
};

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

    let stageList = [];
    if (plan && prog) {
      let cum = 0;
      const horizon = prog.started ? Math.min(prog.elapsed, prog.plannedDays) : 0;
      stageList = plan.stages.map((st, si) => {
        const stat = prog.stages[si] || {};
        const tasks = st.tasks.map((task, ti) => {
          cum += task.days;
          let cls = 'todo', tag = '预计 ' + task.days + ' 天';
          if (task.done) { cls = 'done'; tag = '✓ 已完成' + (task.doneAt ? '（' + util.cnDate(task.doneAt) + '）' : ''); }
          else if (prog.started && cum <= horizon) {
            const late = prog.elapsed - cum;
            cls = 'overdue';
            tag = late > 0 ? '已逾期 ' + late + ' 天' : '今天应完成';
          } else if (prog.started && cum <= horizon + 1) { cls = 'due'; tag = '即将到期'; }
          return {
            name: task.name, days: task.days, done: task.done, cls: cls, tag: tag,
            si: si, ti: ti, id: 'task-' + si + '-' + ti,
            hl: this._focusKey === (si + '-' + ti)      // 从打卡记录回链过来时高亮该任务
          };
        });
        return {
          name: st.name, weeks: st.weeks, goal: st.goal,
          stat: stat, tasks: tasks,
          barStyle: 'width:' + (stat.percent || 0) + '%',
          statColor: (STATUS_STYLE[stat.statusText === '超前' ? 'ahead' : stat.statusText === '滞后' ? 'lag' : stat.statusText === '已完成' ? 'ahead' : 'notstarted'] || STATUS_STYLE.notstarted).color
        };
      });
    }

    const style = prog ? (STATUS_STYLE[prog.status] || STATUS_STYLE.notstarted) : STATUS_STYLE.notstarted;
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
      stageList: stageList
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
  generate() {
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
    const textbook = (store.getSubjectProfile(this.data.key).textbook || '').trim();
    const prompt = studyPlan.getPrompt(this.data.key);

    this.setData({ generating: true });
    wx.showLoading({ title: '编排中…', mask: true });
    wx.cloud.callFunction({
      name: 'studyPlanGen',
      data: {
        subject: this.data.typeName,
        grade: grade,
        term: term,
        textbook: textbook,
        planPrompt: prompt
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
        wx.showModal({
          title: '计划已生成',
          content: '共 ' + plan.stages.length + ' 个阶段。点「开始计划」起算排期；之后每日打卡会自动带出当前待完成任务，任务完成请在此勾选。',
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

  clearPlan() {
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

  goBack() { wx.navigateBack({ delta: 1 }); }
});

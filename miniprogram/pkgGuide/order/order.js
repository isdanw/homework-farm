/**
 * 导学单页（全科导学 · 出单 → 豆包执行 → 回执 → 评语与汇总）
 * ==========================================================
 * 三个页签，一条闭环：
 *   · 出单   —— 选计划 → 选任务 → 选类型与时长 → 出单（同时落库 + 复制到执行端）
 *   · 回执   —— **两步选择**：① 选计划 ② 选出单（只列该计划下 status=issued 的单）
 *                再粘贴回执原文 → 正则抽字段 → **人工逐项确认** → 提交
 *   · 我的单 —— 计划维度聚合（一份计划 N 张单）→ 单详情（只读时间线 + 评语 + 汇总）
 *
 * 【硬约束，改本页前先读】
 *   1. 所有状态变更走云函数 `tutorOrder`（经 tutorStore.orderApi）。本地**绝不推演状态**：
 *      合法跃迁由 orderKit.canTransition 唯一裁决，页面不许自己判断。
 *   2. 回执 = 回执，**不是证据**（O3）。本页不写 tutor_evidence、不改掌握度、不推进复习窗口。
 *      要产生真证据只能走复测页（≥5 题且 ≥80%）。
 *   3. 判据文案红线：只显示「达标 / 部分达标 / 未达标 / 证据不足」，
 *      **绝不出现**「已掌握 / 已精通 / 学会了 / 完全懂了 / 完全掌握 / 稳稳掌握」。
 *   4. 回执一经提交即锁定（1:1）。要修正只能「作废重开」，本页不提供任何原地编辑入口。
 *   5. 抽不到的字段标「未记录」并高亮要求手填，**绝不自动补全**（不猜、不编造回执）。
 */
const store = require('../../utils/store.js');
const tutorStore = require('../../utils/tutorStore.js');
const studyPlan = require('../../utils/studyPlan.js');
const tutorSubjects = require('../../utils/tutorSubjects.js');
const K = require('../../utils/orderKit.js');

/** 训练类型（与 orderKit.KIND_LABEL 同源，此处只做有序化，不改文案） */
const KIND_ORDER = ['concept', 'example', 'mistake', 'review', 'express'];
const MINUTE_CHOICES = ['5', '10', '15'];
/** 帮助层级（回执里要确认「用了哪几级」） */
const D_LEVELS = ['D0', 'D1', 'D2', 'D3', 'D4'];

const STATUS_LABEL = {
  issued: '待回执', submitted: '已回执', closed: '已归档', cancelled: '已取消', voided: '已作废'
};
/** 事件类型 → 人话（时间线用；「什么时间出单、什么时间回执」） */
const EVENT_LABEL = {
  issued: '出单', copied: '复制到执行端', submitted: '提交回执', evaluated: '生成评语与汇总',
  polished: 'AI 润色评语', ticked: '标记任务完成', closed: '归档关闭',
  cancelled: '取消', voided: '作废'
};

Page({
  data: {
    tab: 'issue',              // issue | receipt | mine

    /* ── 出单 ── */
    plans: [],                 // [{key, subjectName, planId, stageName, taskName, si, ti, orderCount, pendingCount}]
    planIdx: -1,
    tasks: [],                 // 该学科可出单的任务（默认当前任务，可改选未勾选任务）
    taskIdx: 0,
    kinds: [],                 // [{key, label}]
    kindIdx: 0,
    minutes: '10',
    minuteChoices: MINUTE_CHOICES,
    issuing: false,

    /* ── 回执（两步选择）── */
    rStep: 1,                  // 1 选计划 | 2 选出单 | 3 粘贴与确认
    rPlans: [],
    rPlanIdx: -1,
    rOrders: [],               // 该计划下待回执的单
    rOrderIdx: -1,
    rawReceipt: '',
    parsed: null,              // {fields, missing}
    confirm: null,             // 人工确认后的可编辑副本
    dLevels: D_LEVELS.map(l => ({ key: l, on: false })),
    quant: { rounds: '1', minutes: '', selfEval: '' },
    submitting: false,

    /* ── 我的单 ── */
    agg: [],
    counts: { issued: 0, submitted: 0, closed: 0, cancelled: 0, voided: 0, total: 0 },
    orders: [],
    detailNo: '',
    detail: null,
    timeline: [],
    detailOpen: false,
    polishing: false,          // T22 补润色进行中（详情页按钮 loading 态）

    loading: true,
    busy: false
  },

  onLoad() {
    this.refreshAll();
  },
  onShow() {
    // 从复测页回来（「去做复测」）时刷新状态
    if (!this.data.loading) this.refreshAll();
  },
  onPullDownRefresh() {
    this.refreshAll();
    wx.stopPullDownRefresh();
  },

  /* ==================== 数据装载 ==================== */

  /**
   * 拉一次云端（换设备/他端改过都能同步），再重建全部派生视图。
   * 拉取失败不阻塞：本地缓存照样能渲染，只是可能不是最新。
   */
  refreshAll() {
    const self = this;
    this.setData({ loading: true });
    const done = function () {
      self.buildViews();
      self.setData({ loading: false });
    };
    // syncFromCloud 有 60s 节流且失败静默；这里不 await 结果，只借它同步一次
    try {
      const p = tutorStore.syncFromCloud();
      if (p && typeof p.then === 'function') p.then(done, done);
      else done();
    } catch (e) { done(); }
  },

  buildViews() {
    this.buildPlans();
    this.buildReceiptPlans();
    this.buildMine();
  },

  /** 出单候选计划：只认 studyPlans 里真实存在的学科（O1：单必锚计划） */
  buildPlans() {
    const u = store.get();
    const map = (u && u.studyPlans) || {};
    const out = [];
    Object.keys(map).forEach(key => {
      const plan = map[key];
      if (!plan || !Array.isArray(plan.stages) || !plan.stages.length) return;
      const cur = studyPlan.getCurrentTask(key);
      if (!cur) return;                                   // 任务全部勾选 → 无可出单任务
      const planId = K.planIdOf(plan, key);
      const ofPlan = tutorStore.getOrdersByPlan(planId);
      const sub = tutorSubjects.getTutorSubject(key);
      out.push({
        key: key,
        subjectName: (plan.subjectName || (sub && sub.name) || key),
        emoji: (sub && sub.emoji) || '📘',
        planId: planId,
        stageName: cur.stageName || '',
        taskName: cur.name || '',
        si: cur.si || 0,
        ti: cur.ti || 0,
        orderCount: ofPlan.length,
        pendingCount: ofPlan.filter(o => o.status === 'issued').length
      });
    });
    const kinds = KIND_ORDER.map(k => ({ key: k, label: K.KIND_LABEL[k] || k }));

    let planIdx = this.data.planIdx;
    if (planIdx < 0 || planIdx >= out.length) planIdx = out.length ? 0 : -1;
    this.setData({ plans: out, planIdx: planIdx, kinds: kinds });
    if (planIdx >= 0) this.buildTasks(planIdx);
  },

  /**
   * 可选任务：该学科**全部未勾选**任务（默认当前任务）。
   * 允许改选的用途：孩子今天想先做后面那一节，或当前任务刚出过单。
   */
  buildTasks(planIdx) {
    const p = this.data.plans[planIdx];
    if (!p) { this.setData({ tasks: [], taskIdx: 0 }); return; }
    const plan = studyPlan.getPlan(p.key);
    let rows = [];
    if (plan && Array.isArray(plan.stages)) {
      let cum = 0;
      plan.stages.forEach((st, si) => {
        (st.tasks || []).forEach((t, ti) => {
          cum += Number(t.days) || 1;
          if (t.done) return;                              // 已勾选的不再出单
          rows.push({
            id: si + '-' + ti,                             // wxml wx:key 用（任务名可重名，不能当键）
            si: si, ti: ti,
            stageName: st.name || '',
            name: t.name || '',
            goal: t.goal || (st.goal || ''),
            dueDay: cum
          });
        });
      });
    }
    if (!rows.length) rows = [{ id: '0-0', si: p.si, ti: p.ti, stageName: p.stageName, name: p.taskName, goal: '', dueDay: 1 }];
    // 默认选中与当前任务一致的那条
    let idx = rows.findIndex(r => r.si === p.si && r.ti === p.ti);
    if (idx < 0) idx = 0;
    this.setData({ tasks: rows, taskIdx: idx });
  },

  /** 回执第一步的候选计划：至少有一张 issued 的单 */
  buildReceiptPlans() {
    const out = [];
    this.data.plans.forEach(p => {
      if (p.pendingCount > 0) out.push(p);
    });
    let idx = this.data.rPlanIdx;
    if (idx < 0 || idx >= out.length) idx = out.length ? 0 : -1;
    this.setData({ rPlans: out, rPlanIdx: idx });
    if (idx >= 0 && this.data.rStep >= 2) this.buildReceiptOrders(idx);
  },

  /** 回执第二步：只列该 planId 下 status==='issued' 的单 */
  buildReceiptOrders(rPlanIdx) {
    const p = this.data.rPlans[rPlanIdx];
    if (!p) { this.setData({ rOrders: [], rOrderIdx: -1 }); return; }
    const rows = tutorStore.getPendingOrders(p.planId).map(o => ({
      orderNo: o.orderNo,
      title: o.title || (o.plan && o.plan.taskName) || '',
      issuedAt: o.issuedAt || 0,
      issuedAtText: fmtTime(o.issuedAt),
      issuedByText: fmtBy(o.issuedBy),
      minutes: o.minutes || ''
    }));
    let idx = this.data.rOrderIdx;
    if (idx < 0 || idx >= rows.length) idx = rows.length ? 0 : -1;
    this.setData({ rOrders: rows, rOrderIdx: idx });
  },

  buildMine() {
    const orders = tutorStore.getOrders().map(o => ({
      orderNo: o.orderNo,
      title: o.title || ((o.plan && o.plan.taskName) || ''),
      subjectName: o.subjectName || '',
      status: o.status,
      statusText: STATUS_LABEL[o.status] || o.status,
      issuedAtText: fmtTime(o.issuedAt),
      submittedAtText: o.submittedAt ? fmtTime(o.submittedAt) : '—',
      verdictText: (o.evaluation && o.evaluation.verdict) ? verdictLabel(o.evaluation.verdict) : '',
      planId: (o.plan && o.plan.planId) || ''
    }));
    this.setData({
      agg: tutorStore.planOrderAggregate(),
      counts: tutorStore.orderCounts(),
      orders: orders
    });
  },

  /* ==================== 交互 ==================== */

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab: tab, detailOpen: false });
    if (tab === 'mine') this.buildMine();
    if (tab === 'receipt') this.buildReceiptPlans();
  },

  onPlanPick(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ planIdx: i });
    this.buildTasks(i);
  },
  onTaskPick(e) {
    this.setData({ taskIdx: Number(e.currentTarget.dataset.i) });
  },
  onKindPick(e) {
    this.setData({ kindIdx: Number(e.currentTarget.dataset.i) });
  },
  onMinutePick(e) {
    this.setData({ minutes: String(e.currentTarget.dataset.m || '10') });
  },

  /* ---------------- 出单（T15） ---------------- */
  doIssue() {
    const self = this;
    const p = this.data.plans[this.data.planIdx];
    if (!p) { wx.showToast({ title: '该学科还没有成长计划', icon: 'none' }); return; }
    const t = this.data.tasks[this.data.taskIdx];
    if (!t) { wx.showToast({ title: '没有可出单的任务', icon: 'none' }); return; }
    const plan = studyPlan.getPlan(p.key);
    if (!plan) { wx.showToast({ title: '成长计划已不存在，请重新生成', icon: 'none' }); return; }
    if (this.data.issuing) return;

    const kind = this.data.kinds[this.data.kindIdx];
    // ⚠️ planTask 是 O1 的锚点：key / si / ti / taskName 缺一不可，
    //    且 planCreatedAt 必须是**当前这份计划**的 createdAt（计划重生成即换 id，旧单不会错挂）
    const planTask = {
      key: p.key,
      si: t.si,
      ti: t.ti,
      planCreatedAt: plan.createdAt,
      subjectName: p.subjectName,
      stageName: t.stageName,
      taskName: t.name,
      goal: t.goal || '',
      days: (plan.stages[t.si] && plan.stages[t.si].tasks[t.ti] && plan.stages[t.si].tasks[t.ti].days) || 1,
      dueDay: t.dueDay,
      startDate: plan.startDate || '',
      planUpdatedAt: plan.updatedAt || 0,
      scaffoldLevel: ''
    };

    this.setData({ issuing: true });
    tutorStore.orderApi('issue', {
      planTask: planTask,
      opts: { kind: kind.key, minutes: this.data.minutes, issuedBy: 'mp' }
    }).then(res => {
      self.setData({ issuing: false });
      if (!res || !res.ok) {
        // 离线兜底：本地生成单并登记补写（tutorSync.push 对 orders 只补写、不合并，不会写坏已有单）
        const fallback = self.issueOffline(planTask, kind, p.key);
        wx.showModal({
          title: res && res.code === 'no_cloud' ? '当前无法连接云端' : '出单未上云',
          content: (fallback ? '已在本机出单并排队补写。\n' : '出单失败：') +
            ((res && res.msg) || '未知原因') + (fallback ? '\n\n请联网后下拉刷新补写。' : ''),
          showCancel: false
        });
        if (fallback) self.copyPrompt(fallback);
        return;
      }
      const order = res.order || {};
      wx.showToast({ title: res.deduped ? '这张单已存在' : '出单成功', icon: 'success' });
      self.copyPrompt(order);
      self.buildViews();
    }).catch(() => {
      self.setData({ issuing: false });
      wx.showToast({ title: '出单失败', icon: 'none' });
    });
  },

  /** 离线出单：本地用同一份 orderKit 生成（与云端逐字节同源的副本），并登记补写 */
  issueOffline(planTask, kind, key) {
    try {
      const order = K.makeOrder(planTask, {
        kind: kind.key, minutes: this.data.minutes, issuedBy: 'mp'
      });
      if (!order) return null;
      tutorStore.queueOrderPush(order);
      return order;
    } catch (e) { return null; }
  },

  /** 复制到执行端（豆包）。复制是「单已交付」的留痕点，幂等只记首次。 */
  copyPrompt(order) {
    if (!order) return;
    const text = order.copyText || order.promptText || (function () {
      try { return K.orderTextFor(order, 'start'); } catch (e) { return ''; }
    })();
    if (!text) { wx.showToast({ title: '提示词生成失败', icon: 'none' }); return; }
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制，去豆包粘贴', icon: 'none', duration: 2200 });
        tutorStore.orderApi('copied', { orderNo: order.orderNo, by: 'mp' }).then(() => this.buildMine());
      },
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' })
    });
  },

  /* ---------------- 回执：两步选择（T16） ---------------- */
  onReceiptPlanPick(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ rPlanIdx: i, rStep: 2, rOrderIdx: -1, parsed: null, confirm: null, rawReceipt: '' });
    this.buildReceiptOrders(i);
  },
  onReceiptOrderPick(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ rOrderIdx: i, rStep: 3 });
  },
  backReceiptStep() {
    const s = this.data.rStep;
    if (s <= 1) return;
    this.setData({ rStep: s - 1 });
  },
  onReceiptInput(e) {
    this.setData({ rawReceipt: e.detail.value });
  },

  /** 解析回执原文：只抽取与标注缺失，**绝不推断补全** */
  parseReceipt() {
    const raw = String(this.data.rawReceipt || '').trim();
    if (!raw) { wx.showToast({ title: '请先粘贴回执原文', icon: 'none' }); return; }
    const r = K.parseReceiptText(raw);
    const f = r.fields || {};
    const missing = r.missing || [];
    const dOn = {};
    (f.dLevelsUsed || []).forEach(l => { dOn[l] = true; });
    this.setData({
      parsed: r,
      confirm: {
        topic: f.topic || '',
        childQuote: f.childQuote || '',
        stuckPoint: f.stuckPoint || '',
        conclusion: f.conclusion || '',
        expressionNote: f.expressionNote || '',
        variantQuestion: f.variantQuestion || '',
        variantResult: f.variantResult || '',
        boundaryQuestion: f.boundaryQuestion || '',
        boundaryResult: f.boundaryResult || '',
        markedNotMeasured: !!f.markedNotMeasured
      },
      dLevels: D_LEVELS.map(l => ({ key: l, on: !!dOn[l] })),
      quant: {
        rounds: String(f.rounds || 1),
        minutes: f.minutes ? String(f.minutes) : '',
        selfEval: f.selfEval ? String(f.selfEval) : ''
      }
    });
    wx.showToast({
      title: missing.length ? ('自动抽到 ' + (13 - missing.length) + ' 项，' + missing.length + ' 项需手填') : '全部字段已抽到，请逐项确认',
      icon: 'none', duration: 2500
    });
  },

  onConfirmInput(e) {
    const k = e.currentTarget.dataset.k;
    const c = Object.assign({}, this.data.confirm);
    c[k] = e.detail.value;
    this.setData({ confirm: c });
  },
  onResultPick(e) {
    const k = e.currentTarget.dataset.k;      // variantResult | boundaryResult
    const v = e.currentTarget.dataset.v;      // independent | prompted | incomplete | untested
    const c = Object.assign({}, this.data.confirm);
    c[k] = v;
    this.setData({ confirm: c });
  },
  onDLevelTap(e) {
    const l = e.currentTarget.dataset.l;
    this.setData({ dLevels: this.data.dLevels.map(x => (x.key === l ? { key: l, on: !x.on } : x)) });
  },
  onQuantInput(e) {
    const k = e.currentTarget.dataset.k;
    const q = Object.assign({}, this.data.quant);
    q[k] = e.detail.value;
    this.setData({ quant: q });
  },

  submitReceipt() {
    const self = this;
    const p = this.data.rPlans[this.data.rPlanIdx];
    const oRow = this.data.rOrders[this.data.rOrderIdx];
    if (!p || !oRow) { wx.showToast({ title: '请先选择计划与出单', icon: 'none' }); return; }
    if (!this.data.parsed) { wx.showToast({ title: '请先解析回执原文', icon: 'none' }); return; }
    if (this.data.submitting) return;

    const c = this.data.confirm;
    const dUsed = this.data.dLevels.filter(x => x.on).map(x => x.key);
    const q = this.data.quant;

    // fields 要带全：云端 buildReceipt 会把它们原样收进 receipt.fields，
    // 缺项会让证据完整度被判成「不足」——不是保守，是**判错**。
    const fields = {
      mode: 'standard',
      rawText: this.data.rawReceipt,
      topic: c.topic,
      childQuote: c.childQuote,
      stuckPoint: c.stuckPoint,
      conclusion: c.conclusion,
      expressionNote: c.expressionNote,
      variantQuestion: c.variantQuestion,
      variantResult: c.variantResult,
      boundaryQuestion: c.boundaryQuestion,
      boundaryResult: c.boundaryResult,
      dLevelsUsed: dUsed,
      markedNotMeasured: !!c.markedNotMeasured
    };

    // planCtx：计划内容在本地（studyPlans），云端不持有 —— 端上提供事实，云端据此算漂移/孤儿。
    // ⚠️ 必须按**该出单自己的锚点**（order.plan.si/ti）判断任务是否还在，
    //    而不是计划「当前」任务的 si/ti —— 否则判断的是另一件事，planOrphan 会误报。
    const plan = studyPlan.getPlan(p.key);
    const anchor = (tutorStore.getOrder(oRow.orderNo) || {}).plan || {};
    const si = Number(anchor.si) || 0;
    const ti = Number(anchor.ti) || 0;
    let taskExists = false;
    if (plan && Array.isArray(plan.stages) && plan.stages[si] &&
        Array.isArray(plan.stages[si].tasks) && plan.stages[si].tasks[ti]) {
      taskExists = true;
    }

    this.setData({ submitting: true });
    tutorStore.orderApi('submit', {
      orderNo: oRow.orderNo,
      planId: p.planId,                       // 服务端据此做 plan_mismatch 硬校验
      fields: fields,
      parsedBy: 'rule',
      by: 'mp',
      quant: {
        rounds: Number(q.rounds) || 1,
        minutes: Number(q.minutes) || 0,
        selfEval: Number(q.selfEval) || 0
      },
      planCtx: { updatedAt: (plan && plan.updatedAt) || 0, taskExists: taskExists }
    }).then(res => {
      self.setData({ submitting: false });
      if (!res || !res.ok) {
        wx.showModal({
          title: '提交被拒绝',
          content: rejectText(res),
          showCancel: false
        });
        return;
      }
      wx.showToast({ title: '回执已提交', icon: 'success' });
      self.setData({
        rStep: 1, rOrderIdx: -1, rawReceipt: '', parsed: null, confirm: null,
        rPlans: [], rOrders: []
      });
      self.buildViews();
      self.setData({ tab: 'mine' });
      /* T22：回执提交成功后再补一次 AI 润色 —— **非阻塞、失败静默**。
         闭环在上一行就已经闭合（规则评语必出），润色只改措辞。
         ⚠️ 必须放在成功提示**之后**且不 await：绝不能让 AI 的可用性
         影响到「回执有没有提交成功」这件事的观感。 */
      self.polishQuietly(oRow.orderNo);
    }).catch(() => {
      self.setData({ submitting: false });
      wx.showToast({ title: '提交失败', icon: 'none' });
    });
  },

  /* ---------------- 单详情（T17，纯只读 + T22 补润色） ---------------- */
  openDetail(e) {
    const no = e.currentTarget.dataset.no;
    const ok = this.renderDetail(no);
    if (ok) this.setData({ detailOpen: true });
  },

  /**
   * 渲染详情（从本地缓存取）。抽成独立方法是为了让「补润色」后能**原地刷新**，
   * 而不是重新走一遍 openDetail（那条路会重新弹 toast、重算 detailNo）。
   * @returns {boolean} 本地是否有这张单
   */
  renderDetail(no) {
    const order = tutorStore.getOrder(no);
    if (!order) { wx.showToast({ title: '本地没有这张单，请下拉刷新', icon: 'none' }); return false; }
    const ev = (order.events || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0));
    const comment = (order.evaluation && order.evaluation.comment) || '';
    const commentSource = (order.evaluation && order.evaluation.commentSource) || '';
    /* 计划天数 vs 实际耗时：
       · 计划天数 = 出单时锁定的 canonical `order.plan.days`（不随计划重生成漂移）；
       · 实际耗时 = 实时读当前计划对应 si/ti 任务的 checkinDays（仅任务已勾选完成时存在）。
         用 planCreatedAt 对齐：计划重生成过（createdAt 变更）则该任务指针已失效，
         不强行显示实际耗时，避免把新计划里别的任务的耗时嫁接到这张老单上。 */
    const pt = order.plan || {};
    const planDays = (typeof pt.days === 'number' && pt.days > 0) ? pt.days : 1;
    let actualDays = null;   // null = 暂不可比（任务未完成 / 计划已重生成）
    if (pt.key && typeof pt.si === 'number' && typeof pt.ti === 'number') {
      const live = studyPlan.getPlan(pt.key);
      if (live && live.createdAt === pt.planCreatedAt
          && live.stages[pt.si] && live.stages[pt.si].tasks[pt.ti]) {
        const task = live.stages[pt.si].tasks[pt.ti];
        if (task.done) actualDays = task.checkinDays || 0;
      }
    }
    this.setData({
      detailNo: no,
      detail: {
        orderNo: order.orderNo,
        title: order.title || ((order.plan && order.plan.taskName) || ''),
        subjectName: order.subjectName || '',
        kindLabel: K.KIND_LABEL[order.kind] || order.kind || '',
        minutes: order.minutes || '',
        statusText: STATUS_LABEL[order.status] || order.status,
        status: order.status,
        planStage: (order.plan && order.plan.stageName) || '',
        planTask: (order.plan && order.plan.taskName) || '',
        planId: (order.plan && order.plan.planId) || '',
        planDays: planDays,
        hasActual: actualDays !== null,
        actualDays: actualDays,
        issuedAtText: fmtTime(order.issuedAt),
        issuedByText: fmtBy(order.issuedBy),
        submittedAtText: order.submittedAt ? fmtTime(order.submittedAt) : '尚未回执',
        submittedByText: order.submittedBy ? fmtBy(order.submittedBy) : '',
        verdictText: (order.evaluation && order.evaluation.verdict) ? verdictLabel(order.evaluation.verdict) : '',
        completeness: (order.evaluation && order.evaluation.completeness) || '',
        comment: comment,
        commentSource: commentSource,
        /* T22：只有「已有规则评语、且还没润色过」才给补润色入口。
           没评语（未回执）时润色无从谈起 —— 云端也会以 bad_transition 拒绝。 */
        canPolish: !!comment && commentSource !== 'ai',
        cycleSummary: (order.cycle && order.cycle.summary) || '',
        tickApplied: !!(order.cycle && order.cycle.tickApplied),
        retestSubject: (order.cycle && order.cycle.retestHint && order.cycle.retestHint.subject) || order.subject || '',
        retestTopic: (order.cycle && order.cycle.retestHint && order.cycle.retestHint.topic) || '',
        retestErrorType: (order.cycle && order.cycle.retestHint && order.cycle.retestHint.errorType) || '',
        hasReceipt: !!order.receipt
      },
      // 时间线字段名：t 已被格式化，保留原始 at 供排序（已排序）
      // ⚠️ id 用下标而不是时间：submitted 与 evaluated 会在同一毫秒写入，
      //    用时间当 wx:key 会重键，渲染会错行。
      timeline: ev.map((x, i) => ({
        id: i,
        type: x.type,
        label: EVENT_LABEL[x.type] || x.type,
        by: fmtBy(x.by),
        detail: x.detail || '',
        atText: fmtTime(x.at)
      }))
    });
    return true;
  },
  closeDetail() {
    this.setData({ detailOpen: false });
  },

  /* ---------------- AI 润色（T22，话术层，失败绝不阻塞闭环） ---------------- */

  /**
   * 静默润色：**不 await、不弹成功提示、失败不打扰用户**。
   *
   * 为什么必须是静默的：
   *   · 闭环在「提交回执」那一步就已经闭合了 —— 规则评语是**必出**的；
   *     AI 只改措辞（`commentSource: 'rule' → 'ai'`），是话术层。
   *   · 所以润色绝不能挡在「回执已提交」的成功提示前面，也绝不能让它的失败
   *     看起来像提交失败。云端失败时会在单上写一条 `polished` 事件说明回落原因，
   *     信息不丢，所以这里连 toast 都不需要。
   *   · 云端 `runPolish` 幂等：已是 `commentSource==='ai'` 时直接回 `deduped:true`，
   *     重复触发无副作用。
   */
  polishQuietly(orderNo) {
    const self = this;
    if (!orderNo) return;
    tutorStore.orderApi('polish', { orderNo: orderNo }).then(res => {
      // 只有真的润色成功才需要重绘（评语文案变了）。
      // 回落 / 失败时评语没变，重绘是纯浪费。
      if (res && res.ok && !res.polishFailed && !res.deduped) {
        self.buildViews();
        if (self.data.detailOpen && self.data.detailNo === orderNo) self.renderDetail(orderNo);
      }
    });
  },

  /**
   * 详情页「AI 润色一下」（补润色入口）。
   *
   * 为什么需要一个手动入口、而不是全靠提交后自动润色：
   *   交回执有三个入口 —— 小程序、网页看板、工作台。但 `polish` 只存在于
   *   `tutorOrder` 这条 **openid 通道**（它才是持有 AI 调用能力的那个云函数），
   *   管理端通道 `webAdminWrite` 的 action 白名单是 canonical `ACTIONS`，**不含 polish**。
   *   于是「从网页/工作台交的回执」这条路不会自动润色 —— 这个按钮就是它的补偿路径：
   *   家长在小程序打开该单，一键补上，且**不需要新增任何写通道**。
   */
  doPolish() {
    const self = this;
    const d = this.data.detail;
    if (!d || !d.orderNo) return;
    if (!d.canPolish) {
      wx.showToast({ title: '本单暂无可润色的评语', icon: 'none' });
      return;
    }
    if (this.data.polishing) return;
    this.setData({ polishing: true });
    tutorStore.orderApi('polish', { orderNo: d.orderNo }).then(res => {
      self.setData({ polishing: false });
      if (!res || !res.ok) {
        wx.showToast({ title: '暂时无法润色', icon: 'none' });
        return;
      }
      if (res.polishFailed) {
        wx.showToast({ title: 'AI 暂时不可用，评语仍用规则版', icon: 'none' });
      } else if (res.deduped) {
        wx.showToast({ title: '已经是润色版了', icon: 'none' });
      } else {
        wx.showToast({ title: '已润色', icon: 'success' });
      }
      // 无论成功/回落/幂等，都重绘一次：polished 事件已追加，时间线要跟上
      self.renderDetail(d.orderNo);
    });
  },

  /** 标记本计划任务完成（**不自动**，见设计 §9.1） */
  doTick() {
    const self = this;
    const d = this.data.detail;
    if (!d) return;
    wx.showModal({
      title: '标记本任务完成',
      content: '将在成长计划里勾选「' + (d.planTask || '该任务') + '」，并记录一条 ticked 留痕。',
      success(r) {
        if (!r.confirm) return;
        self.setData({ busy: true });
        // 先勾本地计划（这是本地权威数据）
        const p = tutorStore.getOrder(d.orderNo);
        let okLocal = false;
        if (p && p.plan) {
          okLocal = studyPlan.setTaskDone(p.plan.key, p.plan.si, p.plan.ti, true);
        }
        tutorStore.orderApi('tick', { orderNo: d.orderNo, by: 'mp' }).then(res => {
          self.setData({ busy: false });
          if (!res || !res.ok) {
            wx.showToast({ title: (res && res.msg) || '记录失败', icon: 'none' });
            return;
          }
          wx.showToast({ title: okLocal ? '已勾选并留痕' : '已留痕（计划未勾选，请手动确认）', icon: 'none' });
          self.buildMine();
          self.openDetail({ currentTarget: { dataset: { no: d.orderNo } } });
        }).catch(() => self.setData({ busy: false }));
      }
    });
  },

  /** 去做复测（唯一能产生真证据的路径） */
  goRetest() {
    const d = this.data.detail;
    if (!d) return;
    if (!d.retestTopic) { wx.showToast({ title: '本单没有复测建议', icon: 'none' }); return; }
    wx.navigateTo({
      url: '/pkgGuide/retest/retest?key=' + encodeURIComponent(d.retestSubject) +
        '&topic=' + encodeURIComponent(d.retestTopic) +
        '&errorType=' + encodeURIComponent(d.retestErrorType || '')
    });
  },

  /** 作废重开（修正回执的唯一合法路径：不作原地覆盖） */
  doReissue() {
    const self = this;
    const d = this.data.detail;
    if (!d) return;
    wx.showModal({
      title: '作废重开',
      editable: true,
      placeholderText: '填写作废原因（必填，留痕需要）',
      success(r) {
        if (!r.confirm) return;
        const reason = String(r.content || '').trim();
        if (!reason) { wx.showToast({ title: '必须填写原因', icon: 'none' }); return; }
        self.setData({ busy: true });
        tutorStore.orderApi('reissue', { orderNo: d.orderNo, reason: reason, by: 'mp' }).then(res => {
          self.setData({ busy: false });
          if (!res || !res.ok) {
            wx.showToast({ title: (res && res.msg) || '重开失败', icon: 'none' });
            return;
          }
          wx.showToast({ title: '已作废并开出新单', icon: 'success' });
          self.setData({ detailOpen: false });
          self.buildViews();
        }).catch(() => self.setData({ busy: false }));
      }
    });
  },

  /** 复制本单提示词（详情页重发用） */
  copyDetail() {
    const o = tutorStore.getOrder(this.data.detailNo);
    if (!o) return;
    this.copyPrompt(o);
  }
});

/* ==================== 纯函数小工具 ==================== */

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(ms) {
  const n = Number(ms) || 0;
  if (!n) return '—';
  const d = new Date(n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function fmtBy(by) {
  return { mp: '小程序', web: '网页看板', workbench: '工作台', sys: '系统', ai: 'AI' }[by] || by || '—';
}
/** verdict 只允许四值；绝不显示「掌握」类结论 */
function verdictLabel(v) {
  if (v === null || v === undefined || v === '') return '证据不足';
  return String(v);
}
/** 把云端错误码翻成人话（不暴露内部细节，但要让用户知道下一步做什么） */
function rejectText(res) {
  const c = (res && res.code) || '';
  const m = {
    no_openid: '登录状态丢失，请回「我的」重新绑定微信后重试。',
    not_found: '云端没有找到这张单，请下拉刷新后再试。',
    plan_mismatch: '所选计划与出单锚点不一致（这张单属于另一份计划）。请回上一步重新选择计划。',
    already_submitted: '这张单已经提交过回执了。一个出单只能对应一个回执；如需修正，请在单详情里「作废重开」。',
    bad_transition: '当前状态不允许这个操作，请下拉刷新后重试。',
    bad_param: '还有必填项没填。',
    no_anchor: '出单必须锚定成长计划的任务。',
    bad_receipt: '回执内容无法识别，请检查是否粘贴了完整的回执。'
  };
  return (m[c] || ('提交失败：' + ((res && res.msg) || '未知原因'))) +
    (res && res.submittedAt ? '\n\n首次提交时间：' + fmtTime(res.submittedAt) : '');
}

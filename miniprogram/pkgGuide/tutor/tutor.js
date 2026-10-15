/**
 * AI 导学页（全科题解导学）
 *  · 学科切换（语文/数学/英语）→ 多轮最小干预导学对话
 *  · 每条消息走 tutorChat 云函数（hy3），支持多轮上下文
 *  · 底部「结束本次导学」→ tutorChat(archive)：会话归档 + AI 错因诊断 + 错题落库
 *  · 成长计划联动：从计划任务进入（taskContext）自动围绕任务开场；结束确认后回写计划
 *  · 错题订正联动：从错题本进入（mistakeContext）自动围绕知识点订正开场
 */
const store = require('../../utils/store.js');
const tutorStore = require('../../utils/tutorStore.js');
const studyPlan = require('../../utils/studyPlan.js');
const util = require('../../utils/util.js');
const tutorSubjects = require('../../utils/tutorSubjects.js');
const mistakeRules = require('../../utils/mistakeRules.js');
const engine = require('../../utils/farmEngine.js');
const tutorGate = require('../../utils/tutorGate.js');

/** 导学支持的九科（与云函数 SUBJECT_PROMPTS 对齐） */
const TUTOR_SUBJECTS = tutorSubjects.TUTOR_SUBJECTS;

/** 限流重试策略：等待超过 30 秒不给「重试」（属小时档超限），只提示稍后再试 */
const RATE_RETRY_MAX_MS = 30000;
/** 旧版云函数未回传 retryAfterMs 时的兜底等待（与 tutorChat 的 6 秒窗口对齐） */
const RATE_FALLBACK_WAIT_MS = 6000;

Page({
  data: {
    subjects: TUTOR_SUBJECTS,
    subject: 'math',
    subjectName: '数学',
    subjectEmoji: '🔢',
    messages: [],          // [{role, content, ts}]
    sessionId: '',
    input: '',
    sending: false,
    archivedCount: 0,
    scrollTo: '',
    taskContext: null,     // 成长计划任务上下文 { key, si, ti, task, stage, goal }
    mistakeContext: null,  // 错题订正上下文 { key, topic, errorType }
    locked: false,         // 门禁（2026-09-22）：未添加孩子或未建计划时禁用导学
    lockReason: '',
    checkinNote: '',
    // 复习卡双组确认弹窗（P1 混合路线）：本次推通（session）+ 单元必会未覆盖自动补齐（fill）
    cardConfirm: { show: false, session: [], fill: [], unitTitle: '' },
    // 当前学科单元必会库覆盖进度（混合路线：导学结合清单，见 _unitSnapshot）
    unitProgress: null
  },

  onLoad(options) {
    // 门禁（2026-09-22）：未添加孩子或未建成长计划时，导学功能禁用。
    // 深链直达（计划/打卡/错题/报告）也会在此被拦截，不初始化任何导学会话。
    const gate = tutorGate.getGate();
    if (!gate.ok) {
      this._locked = true;
      this.setData({ locked: true, lockReason: gate.reason });
      return;
    }

    let initSubject = 'math';
    let taskContext = null;
    let mistakeContext = null;
    let checkinNote = '';
    if (options) {
      if (options.key || options.subject) initSubject = options.key || options.subject;
      if (options.checkinNote) checkinNote = decodeURIComponent(options.checkinNote || '');
      if (options.task) {
        taskContext = {
          key: initSubject,
          si: Number(options.si) || 0,
          ti: Number(options.ti) || 0,
          task: decodeURIComponent(options.task || ''),
          stage: decodeURIComponent(options.stage || ''),
          goal: decodeURIComponent(options.goal || '')
        };
      } else if (options.topic) {
        mistakeContext = {
          key: initSubject,
          topic: decodeURIComponent(options.topic || ''),
          errorType: decodeURIComponent(options.errorType || ''),
          errorTypeLabel: mistakeRules.errorTypeLabel(decodeURIComponent(options.errorType || ''))
        };
      }
    }
    if (!TUTOR_SUBJECTS.some(s => s.key === initSubject)) initSubject = 'math';

    this.setData({ taskContext: taskContext, mistakeContext: mistakeContext, checkinNote: checkinNote });
    this.switchSubject(initSubject);

    // 从打卡 / 计划任务 / 错题订正进入：把建议开场语预填进输入框，
    // 由用户确认后点「发送」才真正发起对话（不再自动发送，避免进入即消耗 AI 调用、打断用户节奏）。
    // 2026-10-06 调整。
    // 必会清单开场引导（混合路线）：无任务/订正/打卡上下文时，若当前学科有必会库，
    // 按「今日待复习 > 未覆盖」推荐一个必会点预填（用户可改可删，不自动发送）。
    if (taskContext || mistakeContext || checkinNote || (this.data.unitProgress && this.data.unitProgress.nextTopic)) {
      this.setData({ input: this.buildOpenContent() });
    }
  },

  onShow() {
    if (this._locked) return;
    this.setData({ archivedCount: tutorStore.archiveCount() });
    // 从 unitKp 清单页返回后本地卡/清单可能变了 → 刷新覆盖进度
    this._refreshUnitProgress();
  },

  /* ---------------- 单元必会清单快照（混合路线：导学结合清单） ---------------- */

  /**
   * 当前学科单元必会库快照：
   *  · progress = UI 覆盖进度（标题/总数/已覆盖/已通关/今日待复习/开场推荐点）
   *  · ctx      = chat 注入给 AI 的清单上下文（{title, points:[{id,topic,status}]}）
   * 无建库返回 null（导学退化为原行为，不受影响）。
   * ⚠️ kpId 仅单元内唯一 → 关联卡必须同时匹配 unitId + kpId。
   */
  _unitSnapshot() {
    const unit = tutorStore.getUnitKpsBySubject(this.data.subject);
    if (!unit || !Array.isArray(unit.points) || !unit.points.length) return null;
    const cards = tutorStore.getCards();
    const now = Date.now();
    let covered = 0, done = 0, dueCount = 0;
    let nextTopic = '', nextStatus = '';
    const points = unit.points.map(p => {
      const cs = cards.filter(c => c.kpId === p.id && c.unitId === unit.id);
      const anyDone = cs.some(c => c.done);
      const anyDue = cs.some(c => !c.done && (c.dueAt || 0) <= now);
      const status = !cs.length ? 'uncovered' : (anyDone ? 'done' : (anyDue ? 'due' : 'learning'));
      if (cs.length) covered++;
      if (anyDone) done++;
      if (anyDue) dueCount++;
      // 开场推荐：今日待复习优先于未覆盖（遇到 due 就替换掉已记的 uncovered）
      if (status === 'due' || status === 'uncovered') {
        if (!nextTopic || (nextStatus === 'uncovered' && status === 'due')) {
          nextTopic = p.topic || '';
          nextStatus = status;
        }
      }
      return { id: p.id, topic: p.topic || '', status: status };
    });
    return {
      progress: {
        title: unit.title || '',
        total: unit.points.length,
        covered: covered, done: done, dueCount: dueCount,
        nextTopic: nextTopic, nextStatus: nextStatus
      },
      ctx: { title: unit.title || '', points: points }
    };
  },

  _refreshUnitProgress() {
    const snap = this._unitSnapshot();
    this.setData({ unitProgress: snap ? snap.progress : null });
  },

  _buildUnitCtx() {
    const snap = this._unitSnapshot();
    return snap ? snap.ctx : null;
  },

  /** 离页标记：限流延时重试的定时器可能在页面卸载后触发，需丢弃 */
  onUnload() { this._destroyed = true; },

  /* ---------------- 学科切换 ---------------- */
  pickSubject(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.subject) return;
    // 手动切学科：任务 / 订正 / 打卡上下文不再适用，取消
    this.setData({ taskContext: null, mistakeContext: null, checkinNote: '' });
    this.switchSubject(key);
  },

  switchSubject(key) {
    if (this._locked) return;
    const sub = TUTOR_SUBJECTS.find(s => s.key === key);
    const active = tutorStore.getActive(key);
    this.setData({
      subject: key,
      subjectName: sub ? sub.name : key,
      subjectEmoji: sub ? sub.emoji : '📘',
      messages: active ? active.messages.slice() : [],
      sessionId: active ? active.id : '',
      input: '',
      sending: false,
      scrollTo: ''
    }, () => this.scrollBottom());
    // 切学科后必会库不同 → 刷新覆盖进度
    this._refreshUnitProgress();
  },

  /* ---------------- 输入 ---------------- */
  onInput(e) { this.setData({ input: e.detail.value || '' }); },

  scrollBottom() {
    setTimeout(() => this.setData({ scrollTo: 'msg-bottom' }), 30);
  },

  /** 构造开场导学预填内容（打卡内容 / 计划任务 / 错题订正三种上下文） */
  buildOpenContent() {
    const c = this.data.checkinNote;
    const t = this.data.taskContext;
    const m = this.data.mistakeContext;
    // 打卡内容优先：把用户写的打卡记录作为导学开场，结合计划任务上下文
    if (c) {
      let s = '我今天的打卡记录是：「' + c + '」';
      if (t) {
        const parts = [];
        if (t.stage) parts.push('阶段「' + t.stage + '」');
        if (t.task) parts.push('任务「' + t.task + '」');
        s += '，我想完成 ' + parts.join(' 里的 ') + '，请帮我看看这里哪里还有问题，一步步引导我理解，不要直接给答案。';
      } else {
        s += '，请帮我看看这里哪里还有卡点，引导我弄明白，不要直接给答案。';
      }
      return s;
    }
    if (t) {
      const parts = [];
      if (t.stage) parts.push('阶段「' + t.stage + '」');
      if (t.task) parts.push('任务「' + t.task + '」');
      if (t.goal) parts.push('目标「' + t.goal + '」');
      return '我想完成 ' + parts.join(' 里的 ') +
        '，请一步步引导我学习：先看看我哪里不会，不要直接给答案。';
    }
    if (m) {
      return '我想订正这个知识点：' + m.topic +
        (m.errorType ? '（之前的错因是 ' + m.errorType + '）' : '') +
        '，请引导我重新理解，先看看我哪里还没弄明白，不要直接给答案。';
    }
    // 必会清单引导（混合路线）：无其他上下文时，按「今日待复习 > 未覆盖」推荐一个必会点开场
    const up = this.data.unitProgress;
    if (up && up.nextTopic) {
      const tail = up.nextStatus === 'due' ? '今天该复习啦' : '还没复习到';
      return '我们在学「' + up.title + '」，必会点「' + up.nextTopic + '」' + tail +
        '。今天就先从这个点开始好吗？我有不会的地方，请一步步引导我，不要直接给答案。';
    }
    return '';
  },

  /* ---------------- 发送 ---------------- */
  /**
   * UI 触发（bindtap 发送按钮 / bindconfirm 键盘发送键）：
   *   微信小程序事件回调总是把事件对象 e 当首参传入，所以这里不能声明形参
   *   接收「内容」，否则 e 会被误当成 customContent → String(e) = "[object Object]"。
   *   无参，从 this.data.input 读取用户输入，再走 _sendContent。
   */
  send() {
    return this._sendContent(this.data.input);
  },

  /** 内部：推送 user 消息 + 调云函数 + 追加 ai 回复；text 为要发送的文本 */
  _sendContent(text) {
    if (this._locked) return;
    const content = String(text == null ? '' : text).trim();
    if (!content) return util.toast('先说说你遇到了什么题吧');
    if (this.data.sending) return;
    if (!wx.cloud || !wx.cloud.callFunction) {
      return wx.showModal({
        title: '云函数未就绪',
        content: '需要部署 tutorChat 云函数后才能使用导学助手。',
        showCancel: false, confirmText: '知道了'
      });
    }

    // 确保有进行中的会话
    let sessionId = this.data.sessionId;
    if (!sessionId) {
      const s = tutorStore.newSession(this.data.subject, this.data.subjectName);
      sessionId = s.id;
      this.setData({ sessionId: sessionId });
      // 精力条（P1）：标记本次学习行为开始（幂等，结束时按实际时长结算）
      try { store.markPaceSession(); } catch (e) {}
    }

    // 追加用户消息
    const userMsg = { role: 'user', content: content, ts: Date.now() };
    tutorStore.appendMessage(sessionId, userMsg);
    const messages = this.data.messages.concat([userMsg]);
    this.setData({ messages: messages, input: '', sending: true }, () => this.scrollBottom());

    const child = store.get();
    const lr = store.getLearner();
    const learner = {
      grade: child.grade || '',
      teachStyle: lr.teachStyle || '',
      expectations: lr.expectations || []
    };

    // history 传给云函数（不含刚追加的本轮 user，云函数内部会再拼本轮 content）
    const history = messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

    // 跨会话记忆（闭环 S3）：每轮新会话的第一问，注入「近期卡点快照」（纯本地结构化字段）
    const learnerCtx = history.length === 0 ? tutorStore.getLearnerContext(this.data.subject) : '';

    // 记住本次载荷：限流等失败时可直接重试（不重复插入用户消息）
    this._lastPayload = {
      action: 'chat',
      subject: this.data.subject,
      content: content,
      history: history,
      learner: learner,
      learnerCtx: learnerCtx,
      // 混合路线：把当前单元必会清单 + 复习状态注入，AI 优先围绕未覆盖/待复习的点引导
      unitCtx: this._buildUnitCtx()
    };
    this._callChat(this._lastPayload);
  },

  /** 调 tutorChat 云函数（chat），处理回复 / 失败弹窗 / 限流一键重试 */
  _callChat(payload) {
    wx.cloud.callFunction({
      name: 'tutorChat',
      data: payload
    }).then(res => {
      const r = res && res.result;
      if (!r || !r.ok) {
        this.setData({ sending: false });
        // 限流：云函数回传 retryAfterMs（还需等待的毫秒数）。
        // 等待短的给「重试」，并在等满窗口后才真正重发——在窗口内直接重发必然再次被拒
        // （rateWait 每次调用都会计数），会让用户连点几次都失败。
        const isRate = r && r.code === 'rate_limit';
        const waitMs = isRate ? this._rateWaitOf(r) : 0;
        const canRetry = isRate && !!this._lastPayload && waitMs <= RATE_RETRY_MAX_MS;
        const waitSec = Math.max(1, Math.ceil(waitMs / 1000));
        return wx.showModal({
          title: '导学未成功',
          content: canRetry
            ? ('问题来得有点快～点「重试」会等 ' + waitSec + ' 秒后自动再发一次。')
            : ((r && r.msg) || '导学失败，请稍后重试'),
          showCancel: canRetry,
          cancelText: canRetry ? '取消' : '',
          confirmText: canRetry ? '重试' : '知道了',
          success: (d) => { if (canRetry && d.confirm) this.retryChat(waitMs); }
        });
      }
      this._lastPayload = null;
      const aiMsg = { role: 'assistant', content: r.reply || '', ts: Date.now() };
      tutorStore.appendMessage(this.data.sessionId, aiMsg);
      this.setData({ messages: this.data.messages.concat([aiMsg]), sending: false }, () => this.scrollBottom());
    }).catch(err => {
      console.warn('[tutor] 导学失败', err);
      this.setData({ sending: false });
      wx.showModal({
        title: '调用失败',
        content: 'tutorChat 云函数可能尚未部署，或网络异常。',
        showCancel: false, confirmText: '知道了'
      });
    });
  },

  /** 取云函数回传的等待毫秒数；旧版云函数未回传时用保守兜底，保证重试不会立刻再撞限流 */
  _rateWaitOf(r) {
    const ms = Number(r && r.retryAfterMs);
    return ms > 0 ? ms : RATE_FALLBACK_WAIT_MS;
  },

  /** 限流重试：等满窗口后再发；期间保持 sending 锁，避免用户重复触发 */
  retryChat(waitMs) {
    if (!this._lastPayload) return;
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), RATE_RETRY_MAX_MS);
    this.setData({ sending: true }, () => this.scrollBottom());
    if (wait <= 0) return this._callChat(this._lastPayload);
    wx.showLoading({ title: '等待 ' + Math.ceil(wait / 1000) + ' 秒…', mask: true });
    setTimeout(() => {
      wx.hideLoading();
      if (this._destroyed || !this._lastPayload) return;   // 已离页 / 无待重发内容
      this._callChat(this._lastPayload);
    }, wait + 300);   // 多留 300ms 余量，避开窗口边界抖动
  },

  /* ---------------- 结束本次导学并归档 ---------------- */
  endSession() {
    if (this._locked) return;
    const messages = this.data.messages;
    if (!messages.length) return util.toast('还没有对话内容哦');
    if (!this.data.sessionId) return;

    wx.showLoading({ title: '正在归档…', mask: true });

    const child = store.get();
    const lr = store.getLearner();
    const learner = { grade: child.grade || '', teachStyle: lr.teachStyle || '' };

    // 预生成本地错题 / 复习窗口 uid：云端 clientId 与本地 id 一致，跨设备合并才不会重复
    const mkId = util.uid('mk');
    const rvId = mkId + '_rv';
    const sessionId = this.data.sessionId;

    wx.cloud.callFunction({
      name: 'tutorChat',
      data: {
        action: 'archive',
        subject: this.data.subject,
        messages: messages,
        learner: learner,
        sessionClientId: sessionId,
        mistakeClientId: mkId,
        reviewClientId: rvId
      }
    }).then(res => {
      wx.hideLoading();
      const r = res && res.result;
      if (r && r.ok) {
        tutorStore.closeSession(sessionId);
        // 归档后可能顺带更新错题/复习窗口 → 刷新覆盖进度
        this._refreshUnitProgress();
        const diagnosis = r.diagnosis || null;
        const now = Date.now();

        // 精力条（P1）：按本次导学实际时长结算扣减（非阻断；封顶 cap*1.5 见 pace.settleSession）
        let paceSpent = null;
        try {
          paceSpent = store.settlePaceSession();
          if (paceSpent && paceSpent.spent > 0) {
            const cap = store.checkPaceCap(paceSpent.spent);
            if (cap.over) {
              wx.showModal({
                title: '该让大脑歇歇啦 🌿',
                content: `这次导学用了 ${paceSpent.spent} 分钟，超过建议的 ${cap.capMin} 分钟。\n要不要休息一下再来？`,
                confirmText: '好的',
                showCancel: false,
                confirmColor: '#5FBF6B'
              });
            }
          }
        } catch (e) {}

        // 诊断出卡点 → 写本地错题本（id 与云端 clientId 一致）
        if (diagnosis && diagnosis.stuck) {
          tutorStore.addMistake({
            id: mkId,
            subject: this.data.subject,
            subjectName: this.data.subjectName,
            topic: diagnosis.topic,
            errorType: diagnosis.errorType,
            errorDesc: diagnosis.errorDesc,
            suggestion: diagnosis.suggestion,
            status: 'pending'
          });
          // 派生复习窗口（闭环 S2）：优先用云端返回，云端失败则本地兜底生成
          const review = (r.review && r.review.id) ? r.review : {
            id: rvId,
            mistakeId: mkId,
            subject: this.data.subject,
            subjectName: this.data.subjectName,
            topic: diagnosis.topic,
            errorType: diagnosis.errorType,
            stage: 1,
            dueAt: now + 86400000,   // stage 1 = 次日
            done: false,
            createdAt: now
          };
          tutorStore.upsertReview(review);
        }

        // 补推上云：sessions / mistakes / reviews 的入队现在由 tutorStore 各写操作内部
        // 自动完成（见其「写操作出口」），这里只需触发一次合并推送。
        tutorStore.pushQueued();

        // 暂存归档上下文，供 showSummary 之后调 genCards 生成候选卡使用（setData 会清空 sessionId）
        this._archiveSessionId = sessionId;
        this._sessionMessages = messages;
        this._archiveLearner = learner;

        const hasTask = !!(this.data.taskContext && this.data.taskContext.key);
        this.setData({
          messages: [], sessionId: '', input: '',
          archivedCount: tutorStore.archiveCount()
        });
        this.showSummary(diagnosis, hasTask ? this.data.taskContext : null, r.summary);
      } else {
        wx.showModal({
          title: '归档未成功',
          content: (r && r.msg) || '归档失败，请稍后重试（本地记录仍保留）',
          showCancel: false, confirmText: '知道了'
        });
      }
    }).catch(() => {
      wx.hideLoading();
      wx.showModal({
        title: '调用失败',
        content: 'tutorChat 云函数可能尚未部署，归档未完成（本地记录仍保留）。',
        showCancel: false, confirmText: '知道了'
      });
    });
  },

  /** 导学结束小结：会话总结 + 错因反馈 + 计划任务确认（合一弹窗） */
  showSummary(diagnosis, taskContext, summary) {
    const lines = [];
    // G1：会话级课程总结（archive 内联生成并写回 tutor_sessions.summary）
    if (summary && summary.summary) lines.push('📒 ' + summary.summary);
    if (diagnosis && diagnosis.topic) lines.push('本次学了：' + diagnosis.topic);
    if (summary && summary.keyPoints && summary.keyPoints.length) {
      lines.push('推通的重点：\n' + summary.keyPoints.map((k, i) => ((i + 1) + '. ' + k)).join('\n'));
    }
    if (diagnosis && diagnosis.stuck) {
      lines.push('卡点：' + (diagnosis.errorDesc || '遇到了一点困难') +
        (diagnosis.errorType ? '（' + diagnosis.errorType + '）' : ''));
      if (diagnosis.suggestion) lines.push('建议：' + diagnosis.suggestion);
      lines.push('已记入错题本，可去「错题本」订正巩固。');
    } else if (diagnosis && diagnosis.done) {
      lines.push('这次完成得不错！');
    }

    let content = lines.join('\n');
    if (taskContext) {
      const ask = (taskContext.task ? ('任务「' + taskContext.task + '」完成了吗？') : '这个计划任务完成了吗？');
      content = content ? (content + '\n\n' + ask) : ask;
    }

    wx.showModal({
      title: '导学小结',
      content: content || '本次导学已结束。',
      showCancel: !!taskContext,
      cancelText: taskContext ? '还不太会' : '',
      confirmText: taskContext ? '会了，标记完成' : '知道了',
      success: (res) => {
        if (taskContext && res.confirm) {
          studyPlan.setTaskDone(taskContext.key, taskContext.si, taskContext.ti, true);
          util.toast('已更新成长计划', 'success');
        }
        // 农场激励（闭环 S4）：奖励只挂「完成一次导学归档」这个活动，
        // 复测达标（证据）绝不发奖；每日有上限，防刷
        const gain = engine.tutorReward(store.get());
        if (gain && res.confirm !== false) {
          setTimeout(() => util.toast('导学完成，阳光 +' + gain.sun, 'success'), taskContext ? 600 : 0);
        }
        this.setData({ taskContext: null });
        // G2：生成复习卡候选 → 确认弹窗（genCards 降级不阻塞；失败/无候选则静默跳过）
        if (this._sessionMessages && this._sessionMessages.length) {
          this._genAndConfirmCards(this._archiveSessionId, this._sessionMessages, this._archiveLearner);
        }
      }
    });
  },

  /**
   * G2：调 genCards 取候选卡（仅候选，不落库）；失败/无候选静默跳过。
   * P1 混合路线：带当前学科最新单元必会库的 points → AI 映射 kpId → 前端按本地已有卡
   * 计算「未覆盖点」自动补齐为 source:'unit' 卡 → 双组确认弹窗。
   * （missing 计算放前端而非云端：genCards 保持「只读候选、不查库」；且要并入本地
   *   已有的 kpId 才能正确判「已有卡」，云端没有这份数据。）
   */
  _genAndConfirmCards(sessionId, messages, learner) {
    if (!messages || !messages.length) return;
    wx.showLoading({ title: '生成复习卡…', mask: true });
    const unit = tutorStore.getUnitKpsBySubject(this.data.subject);
    const unitPoints = (unit && Array.isArray(unit.points)) ? unit.points.map(p => ({
      id: p.id, topic: p.topic, front: p.front, back: p.back
    })) : [];
    wx.cloud.callFunction({
      name: 'tutorChat',
      data: {
        action: 'genCards',
        subject: this.data.subject,
        messages: messages,
        learner: learner,
        unitPoints: unitPoints
      }
    }).then(res => {
      wx.hideLoading();
      const r = res && res.result;
      if (!(r && r.ok)) return;
      const sessionCards = Array.isArray(r.cards) ? r.cards : [];
      const coveredKpIds = Array.isArray(r.coveredKpIds) ? r.coveredKpIds : [];
      // 单元必会未覆盖点 → 自动补齐为待复习卡（排除本次已覆盖 + 本地已有卡已挂的点）
      let unitFillCards = [];
      if (unit && unitPoints.length) {
        const existingKpIds = (tutorStore.getCards() || []).filter(c => c.kpId).map(c => c.kpId);
        const covered = {};
        coveredKpIds.concat(existingKpIds).forEach(k => { covered[k] = true; });
        unitFillCards = unitPoints
          .filter(p => !covered[p.id])
          .map(p => ({ front: p.front, back: p.back, topic: p.topic, kpId: p.id, source: 'unit', unitId: unit.id }));
      }
      if (!sessionCards.length && !unitFillCards.length) return;   // 无候选 → 不弹窗
      this._showCardConfirm(sessionId, sessionCards, unitFillCards, unit);
    }).catch(() => { wx.hideLoading(); });
  },

  /** G2/P1：双组确认弹窗（自定义遮罩，支持勾选剔除）。确认后才写 tutor_cards 并上云 */
  _showCardConfirm(sessionId, sessionCards, unitFillCards, unit) {
    this.setData({
      cardConfirm: {
        show: true,
        session: (sessionCards || []).map(c => ({
          front: c.front || '', back: c.back || '', topic: c.topic || '',
          kpId: c.kpId || null, unitId: unit ? unit.id : '', checked: true
        })),
        fill: (unitFillCards || []).map(c => ({
          front: c.front || '', back: c.back || '', topic: c.topic || '',
          kpId: c.kpId || null, unitId: c.unitId || '', checked: true
        })),
        unitTitle: unit ? unit.title : ''
      }
    });
    this._archiveSessionId = sessionId || this._archiveSessionId || '';
  },

  /** 双组弹窗：勾选/取消某一条（session 或 fill 组） */
  toggleCardCheck(e) {
    const group = e.currentTarget.dataset.group;
    const idx = Number(e.currentTarget.dataset.index);
    const cc = this.data.cardConfirm;
    if (!cc || !cc.show || !cc[group] || cc[group][idx] == null) return;
    cc[group][idx].checked = !cc[group][idx].checked;
    this.setData({ cardConfirm: cc });
  },

  /** 双组弹窗：取消（不入库） */
  cancelCards() {
    this.setData({ cardConfirm: { show: false, session: [], fill: [], unitTitle: '' } });
  },

  /** 双组弹窗：确认生成勾选的卡（有 kpId 走 kpId 主键去重 upsert，保留盒子进度） */
  confirmCards() {
    const cc = this.data.cardConfirm;
    if (!cc || !cc.show) return;
    const now = Date.now();
    const built = [];
    const push = (c, source) => {
      if (!c.checked) return;
      built.push({
        id: c.kpId ? ('cd_' + (c.unitId || '') + '_' + c.kpId) : util.uid('cd'),
        subject: this.data.subject,
        subjectName: this.data.subjectName,
        topic: c.topic || '',
        front: c.front || '',
        back: c.back || '',
        sourceSessionId: this._archiveSessionId || '',
        unitId: c.unitId || '',
        kpId: c.kpId || null,
        source: source,
        box: 1,
        dueAt: now + 86400000,         // stage 1 = 次日到期
        lastResult: null,
        done: false,
        createdAt: now,
        updatedAt: now
      });
    };
    (cc.session || []).forEach(c => push(c, 'session'));
    (cc.fill || []).forEach(c => push(c, 'unit'));
    if (built.length) {
      tutorStore.addCards(built);
      tutorStore.pushQueued();
      util.toast('已加入 ' + built.length + ' 张复习卡', 'success');
    }
    this.setData({ cardConfirm: { show: false, session: [], fill: [], unitTitle: '' } });
  },

  /* ---------------- 单元必会库建库（P1 混合路线 · A 路径：unitSummary 生成候选） ---------------- */

  /** 入口：打开当前学科的单元必会清单页（查看 / 编辑 / 翻面自测） */
  openUnitKp() {
    if (this._locked) return;
    wx.navigateTo({ url: '/pkgTools/unitKp/unitKp?subject=' + this.data.subject });
  },

  /** 入口：输入单元名称 → AI 生成必会点候选草稿 → 保存到 tutor_unit_kps。
   *  默认带入当前导学的单元（成长计划任务阶段名），让建库与正在导学的内容对齐；
   *  说明文字放 placeholderText（editable 模式下 content 是输入框默认值）。 */
  buildUnitLibrary() {
    if (this._locked) return;
    const t = this.data.taskContext;
    const defaultName = (t && t.stage) ? t.stage : '';
    wx.showModal({
      title: '建单元必会库',
      content: defaultName,
      editable: true,
      placeholderText: '单元名称（如「第三单元 1~5 的认识和加减法」）',
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) return util.toast('单元名称不能为空');
        this._buildUnitFromAI(name);
      }
    });
  },

  /** 调 unitSummary 生成黑板知识树 → 拆成必会点候选 → 保存。
   *  若从成长计划任务进入，把阶段名（单元）与目标一并带入，提示词据此定制拆点范围。 */
  _buildUnitFromAI(name) {
    wx.showLoading({ title: '生成必会清单…', mask: true });
    const sub = TUTOR_SUBJECTS.find(s => s.key === this.data.subject);
    const t = this.data.taskContext;
    wx.cloud.callFunction({
      name: 'tutorChat',
      data: {
        action: 'unitSummary',
        unitName: name,
        unitGoal: (t && t.goal) || '',
        subject: this.data.subject,
        subjectName: sub ? sub.name : this.data.subjectName,
        learner: { grade: store.get().grade || '' }
      }
    }).then(res => {
      wx.hideLoading();
      const r = res && res.result;
      const branches = (r && r.ok && r.data && Array.isArray(r.data.branches)) ? r.data.branches : [];
      if (!branches.length) {
        return wx.showModal({ title: '生成失败', content: (r && r.msg) || '请稍后重试', showCancel: false, confirmText: '知道了' });
      }
      // branches → points 候选：每个分支的要点各成一条必会点
      const points = [];
      let n = 0;
      branches.forEach(b => {
        const branchTitle = (b && b.title) || '';
        const pts = Array.isArray(b && b.points) ? b.points : [];
        pts.forEach(p => {
          const text = String(p || '').trim();
          if (!text) return;
          n++;
          points.push({
            id: 'p' + n,
            topic: branchTitle,
            front: branchTitle ? (branchTitle + '：能说出「' + text + '」吗？') : ('能说出「' + text + '」吗？'),
            back: text,
            order: n
          });
        });
      });
      if (!points.length) {
        return wx.showModal({ title: '无要点', content: '本次总结未产出可记录的要点，换个单元名重试', showCancel: false, confirmText: '知道了' });
      }
      this._saveUnitLibrary(name, points);
    }).catch(() => {
      wx.hideLoading();
      wx.showModal({ title: '调用失败', content: 'unitSummary 云函数可能未部署，请稍后重试', showCancel: false, confirmText: '知道了' });
    });
  },

  /** 保存单元必会库（id 按 subject+名称 slug 稳定生成：重名重建即更新，不重复建库） */
  _saveUnitLibrary(name, points) {
    const grade = store.get().grade || '';
    const slug = name.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '_').slice(0, 40);
    const unitId = 'u_' + this.data.subject + '_' + slug;
    tutorStore.upsertUnitKp({
      id: unitId,
      subject: this.data.subject,
      grade: grade,
      title: name,
      points: points,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    tutorStore.pushQueued();
    wx.showModal({
      title: '单元必会库已建',
      content: '已为「' + name + '」生成 ' + points.length + ' 条必会点。\n会话结束时，未覆盖的点会自动补齐成复习卡。',
      showCancel: false,
      confirmText: '好的'
    });
  },

  goBack() { wx.navigateBack({ delta: 1 }); },

  /* 锁定态引导（2026-09-22）：按缺哪一步分流 */
  goMine() { wx.switchTab({ url: '/pages/mine/mine' }); },
  goPlanFromTutor() {
    const first = store.getTypeList()[0];
    wx.navigateTo({ url: '/pkgTools/plan/plan' + (first ? '?key=' + first.key : '') });
  },
  lockBack() {
    const pages = getCurrentPages();
    if (pages && pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/mine/mine' });
  }
});

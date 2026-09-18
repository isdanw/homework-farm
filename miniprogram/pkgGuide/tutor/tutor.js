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
    mistakeContext: null   // 错题订正上下文 { key, topic, errorType }
  },

  onLoad(options) {
    let initSubject = 'math';
    let taskContext = null;
    let mistakeContext = null;
    if (options) {
      if (options.key || options.subject) initSubject = options.key || options.subject;
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

    this.setData({ taskContext: taskContext, mistakeContext: mistakeContext });
    this.switchSubject(initSubject);

    // 从计划任务 / 错题订正进入：自动发起第一轮导学（围绕目标引导，不直接给答案）
    if (taskContext || mistakeContext) {
      setTimeout(() => this._sendContent(this.buildOpenContent()), 400);
    }
  },

  onShow() {
    this.setData({ archivedCount: tutorStore.archiveCount() });
  },

  /** 离页标记：限流延时重试的定时器可能在页面卸载后触发，需丢弃 */
  onUnload() { this._destroyed = true; },

  /* ---------------- 学科切换 ---------------- */
  pickSubject(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.subject) return;
    // 手动切学科：任务 / 订正上下文不再适用，取消
    this.setData({ taskContext: null, mistakeContext: null });
    this.switchSubject(key);
  },

  switchSubject(key) {
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
  },

  /* ---------------- 输入 ---------------- */
  onInput(e) { this.setData({ input: e.detail.value || '' }); },

  scrollBottom() {
    setTimeout(() => this.setData({ scrollTo: 'msg-bottom' }), 30);
  },

  /** 构造开场导学请求（计划任务 / 错题订正两种上下文） */
  buildOpenContent() {
    const t = this.data.taskContext;
    if (t) {
      const parts = [];
      if (t.stage) parts.push('阶段「' + t.stage + '」');
      if (t.task) parts.push('任务「' + t.task + '」');
      if (t.goal) parts.push('目标「' + t.goal + '」');
      return '我想完成 ' + parts.join(' 里的 ') +
        '，请一步步引导我学习：先看看我哪里不会，不要直接给答案。';
    }
    const m = this.data.mistakeContext;
    if (m) {
      return '我想订正这个知识点：' + m.topic +
        (m.errorType ? '（之前的错因是 ' + m.errorType + '）' : '') +
        '，请引导我重新理解，先看看我哪里还没弄明白，不要直接给答案。';
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
      learnerCtx: learnerCtx
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
        const diagnosis = r.diagnosis || null;
        const now = Date.now();

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

        // 待补写队列（闭环 S1）：云端写入失败 / 离线时，下次由 tutorSync(push) 回补
        tutorStore.queuePush('sessions', sessionId);
        if (diagnosis && diagnosis.stuck) {
          tutorStore.queuePush('mistakes', mkId);
          tutorStore.queuePush('reviews', rvId);
        }
        tutorStore.pushQueued();

        const hasTask = !!(this.data.taskContext && this.data.taskContext.key);
        this.setData({
          messages: [], sessionId: '', input: '',
          archivedCount: tutorStore.archiveCount()
        });
        this.showSummary(diagnosis, hasTask ? this.data.taskContext : null);
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

  /** 导学结束小结：错因反馈 + 计划任务确认（合一弹窗） */
  showSummary(diagnosis, taskContext) {
    const lines = [];
    if (diagnosis && diagnosis.topic) lines.push('本次学了：' + diagnosis.topic);
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
      }
    });
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});

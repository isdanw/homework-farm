/**
 * 打卡详情页（首页点击打卡图标进入）
 *  · 可输入文字描述：简单叙述当天的学习情况（存进 homework[date][key].note）
 *  · 可选填写用时分钟数
 *  · 完成打卡 → 走 farmEngine.checkin，照常发放阳光 / 种子 / 推进合种
 *  · 调用「评语分析」云函数（mode:'note' 学习记录模式）对描述做分析，给出评价
 *  · 支持查看历史日期（只读）
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const sched = require('../../utils/scheduleEngine.js');
const studyPlan = require('../../utils/studyPlan.js');
const util = require('../../utils/util.js');
const { BUILTIN_ROLES } = require('../../utils/rolePresets.js');


/** 学科 → 内置角色映射：语文/数学/英语固定使用对应提示词角色，其余学科沿用原 analyzeComment */
const SUBJECT_ROLE_KEY = { chinese: 'chinese', math: 'math', english: 'english' };
function roleForSubject(key) {
  const rk = SUBJECT_ROLE_KEY[key];
  if (!rk) return null;
  return BUILTIN_ROLES.find(r => r.key === rk) || null;
}

Page({
  data: {
    key: '',
    date: '',                    // 查看 / 打卡日期；空 = 今天
    isToday: true,

    type: { name: '', emoji: '📘', color: '#BFE6FF', colorDeep: '#3FA9F5' },
    dateText: '', weekText: '',

    done: false, doneAtText: '',
    note: '', noteLen: 0, minutes: '',

    courseHint: '',              // 「今天第 2、5 节有语文课」
    planTask: '',                // 计划中「最近一条未勾选」的任务（今日实时读 / 历史读打卡快照）
    planStage: '',               // 该任务所属阶段
    planRef: null,               // 该任务在计划中的下标 { si, ti }（用于跳回计划定位）

    analysis: '',                // 已保存的分析（历史）
    result: null,                // 本次分析结果 { analysis, sections }
    analyzing: false,
    roleName: ''                 // 当前 AI 分析所用的角色名（语文/数学固定为对应内置角色，其余为空）
  },

  onLoad(options) {
    const key = (options && options.key) || '';
    const has = store.getTypeList().some(t => t.key === key);
    if (!has) {
      util.toast('打卡类型不存在');
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ key: key, date: (options && options.date) || '' });
  },

  onShow() {
    if (!this.data.key) return;
    this.render();
  },

  render() {
    const key = this.data.key;
    const date = this.data.date || util.today();
    const isToday = date === util.today();

    const d = store.get();
    const t = store.getType(key);
    const hw = engine.ensureDay(d, date);
    const rec = hw[key] || { done: false, note: '', minutes: 0, doneAt: 0, analysis: '', planTask: '', planStage: '', planRef: null };
    const note = (rec.note || '').trim();

    // 课表联动：今天（或所选日期）有几节这门课
    let courseHint = '';
    try {
      const courses = sched.dayCourses(sched.getSchedule(), date);
      const hit = courses.filter(c => c.typeKey === key);
      if (hit.length) {
        courseHint = `今天第 ${hit.map(c => c.period).join('、')} 节有${t.name}课`;
      }
    } catch (e) {}

    /* 成长计划任务（单向读取：打卡只读计划，不回写计划的勾选状态）
       · 今日视图：实时读取计划中「最近一条未勾选的任务」——该任务若已被勾选，自动顺延到下一条
       · 历史视图：读当时打卡固化的快照（计划可能已改动或重新生成，不能现算） */
    let planTask = '', planStage = '', planRef = null;
    if (isToday) {
      try {
        const cur = studyPlan.getCurrentTask(key);
        if (cur) {
          planTask = cur.name;
          planStage = cur.stageName;
          planRef = { si: cur.si, ti: cur.ti };
        }
      } catch (e) {}
    } else {
      planTask = rec.planTask || '';
      planStage = rec.planStage || '';
      planRef = rec.planRef || null;
    }

    this.setData({
      isToday: isToday,
      type: { name: t.name, emoji: t.emoji || t.icon || '📘', color: t.color || '#BFE6FF', colorDeep: t.colorDeep || '#3FA9F5' },
      dateText: util.cnDate(date),
      weekText: util.weekday(date) + (isToday ? '' : '（历史）'),
      done: !!rec.done,
      doneAtText: rec.doneAt ? fmtTime(rec.doneAt) : '',
      note: note,
      noteLen: note.length,
      minutes: rec.minutes ? String(rec.minutes) : '',
      analysis: rec.analysis || '',
      courseHint: courseHint,
      planTask: planTask,
      planStage: planStage,
      planRef: planRef,
      roleName: (roleForSubject(this.data.key) || {}).name || ''
    });
  },

  /* ---------------- 输入 ---------------- */
  onNote(e) {
    const v = e.detail.value || '';
    this.setData({ note: v, noteLen: v.length });
  },

  onMinutes(e) {
    this.setData({ minutes: e.detail.value || '' });
  },


  /* ---------------- 打卡 / 撤销 / 保存 ---------------- */
  submit() {
    if (!this.data.isToday) return util.toast('只能给今天打卡哦');
    if (this.data.done) return util.toast('今天已经打过卡啦');

    const d = store.get();
    const gain = engine.checkin(d, this.data.key, {
      note: (this.data.note || '').trim(),
      minutes: Number(this.data.minutes) || 0,
      // 固化本次打卡对应的计划任务快照（只记录，不改变计划的勾选状态）
      planTask: this.data.planTask || '',
      planStage: this.data.planStage || '',
      planRef: this.data.planRef || null
    });
    if (!gain) return util.toast('今天已经打过卡啦');

    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    util.toast(`🎉 ${this.data.type.name}打卡完成！阳光 +${gain.sun}`, 'success');
    this.render();
  },

  /** 已打卡后仍可补充 / 修改描述 */
  saveNote() {
    const d = store.get();
    const date = this.data.date || util.today();
    const hw = engine.ensureDay(d, date);
    if (!hw[this.data.key]) return;
    hw[this.data.key].note = (this.data.note || '').trim();
    hw[this.data.key].minutes = Number(this.data.minutes) || 0;
    store.save(d);
    util.toast('记录已保存', 'success');
    this.render();
  },

  undo() {
    if (!this.data.isToday) return util.toast('历史记录不能撤销');
    wx.showModal({
      title: '撤销打卡',
      content: '撤销后会收回本次的阳光和种子，确定吗？',
      confirmColor: '#FF7A7A',
      success: (res) => {
        if (!res.confirm) return;
        const d = store.get();
        const date = util.today();
        const hw = engine.ensureDay(d, date);
        if (hw[this.data.key]) {
          hw[this.data.key].note = '';
          hw[this.data.key].minutes = 0;
          hw[this.data.key].analysis = '';
          hw[this.data.key].planTask = '';      // 撤销后不保留任务快照
          hw[this.data.key].planStage = '';
          hw[this.data.key].planRef = null;
        }
        engine.uncheckin(d, this.data.key);
        this.setData({ result: null, analysis: '' });
        util.toast('已撤销');
        this.render();
      }
    });
  },

  /* ---------------- AI 分析 ----------------
   *  · 语文(key='chinese')：固定使用内置「校内语文题解」角色提示词，走 aiRoleAnalyze 云函数
   *  · 其他学科：沿用原 analyzeComment 云函数（mode:'note' 学习记录模式）
   */
  analyze() {
    const note = (this.data.note || '').trim();
    if (!note) return util.toast('先写点今天的学习情况吧');
    if (this.data.analyzing) return;
    if (!wx.cloud || !wx.cloud.callFunction) {
      return wx.showModal({
        title: '云函数未就绪',
        content: '需要部署 aiRoleAnalyze / analyzeComment 云函数后才能在小程序里使用学习分析。',
        showCancel: false, confirmText: '知道了'
      });
    }

    wx.showLoading({ title: '分析中…', mask: true });
    this.setData({ analyzing: true, result: null });

    const child = store.get();
    const base = { childName: child.nickname || '', grade: child.grade || '' };

    // —— 语文/数学：固定对应内置角色提示词（走 aiRoleAnalyze）——
    const role = roleForSubject(this.data.key);
    if (role) {
      wx.cloud.callFunction({
        name: 'aiRoleAnalyze',
        data: {
          rolePrompt: role.prompt,
          content: note,
          scopeLabel: this.data.type.name + '打卡',
          childName: base.childName,
          grade: base.grade
        }
      }).then(res => this._onRoleBack(res)).catch(err => this._onAnalyzeErr(err));
      return;
    }

    // —— 其他学科：沿用原评语分析云函数 ——
    wx.cloud.callFunction({
      name: 'analyzeComment',
      data: {
        mode: 'note',                       // 学习记录模式（区别于老师评语）
        subject: this.data.key,
        subjectLabel: this.data.type.name,  // 自定义打卡类型也能拿到准确名称
        comment: note,
        grade: base.grade,
        childName: base.childName
      }
    }).then(res => this._onCommentBack(res)).catch(err => this._onAnalyzeErr(err));
  },

  /** 语文/数学角色分析回包处理（aiRoleAnalyze 返回 { ok, analysis }，无 sections） */
  _onRoleBack(res) {
    wx.hideLoading();
    const r = res && res.result;
    if (!r || !r.ok) {
      this.setData({ analyzing: false });
      return wx.showModal({
        title: '分析未成功',
        content: (r && r.msg) || '分析失败，请稍后重试',
        showCancel: false, confirmText: '知道了'
      });
    }
    // 分析结果落到当天的打卡记录里
    const d = store.get();
    const date = this.data.date || util.today();
    const hw = engine.ensureDay(d, date);
    if (hw[this.data.key]) {
      hw[this.data.key].analysis = r.analysis || '';
      store.save(d);
    }
    this.setData({ result: { analysis: r.analysis || '', sections: [] }, analyzing: false });
    util.toast('分析完成', 'success');
  },

  /** 其他学科（analyzeComment）回包处理（返回 { ok, analysis, sections }） */
  _onCommentBack(res) {
    wx.hideLoading();
    const r = res && res.result;
    if (!r || !r.ok) {
      this.setData({ analyzing: false });
      return wx.showModal({
        title: '分析未成功',
        content: (r && r.msg) || '分析失败，请稍后重试',
        showCancel: false, confirmText: '知道了'
      });
    }
    // 分析结果落到当天的打卡记录里
    const d = store.get();
    const date = this.data.date || util.today();
    const hw = engine.ensureDay(d, date);
    if (hw[this.data.key]) {
      hw[this.data.key].analysis = r.analysis || '';
      store.save(d);
    }
    this.setData({ result: r, analyzing: false });
    this.render();
    util.toast('分析完成', 'success');
  },

  _onAnalyzeErr(err) {
    wx.hideLoading();
    console.warn('[checkinDetail] 分析失败', err);
    this.setData({ analyzing: false });
    wx.showModal({
      title: '调用失败',
      content: '云函数可能尚未部署，或网络异常。',
      showCancel: false, confirmText: '知道了'
    });
  },

  goBack() { wx.navigateBack(); },

  /* 跳转到该打卡类型的学科画像 */
  goTypeProfile() {
    const key = this.data.key;
    if (!key) return;
    wx.navigateTo({ url: '/pkgGuide/typeProfile/typeProfile?key=' + key });
  },

  /* 从打卡页跳转 AI 导学（带当前计划任务上下文，打通「打卡 → 导学计划」） */
  goTutor() {
    const key = this.data.key;
    if (!key) return;
    const url = '/pkgGuide/tutor/tutor?key=' + key +
      (this.data.planTask ? ('&task=' + encodeURIComponent(this.data.planTask)) : '') +
      (this.data.planStage ? ('&stage=' + encodeURIComponent(this.data.planStage)) : '');
    wx.navigateTo({ url: url });
  },

  /* 跳回成长计划页并定位到该任务（打卡记录 → 计划 的回链定位） */
  goPlanTask() {
    const key = this.data.key;
    if (!key) return;
    const ref = this.data.planRef;
    let url = '/pkgTools/plan/plan?key=' + key;
    if (ref && ref.si != null && ref.ti != null) url += '&si=' + ref.si + '&ti=' + ref.ti;
    wx.navigateTo({ url: url });
  },

  noop() {}
});

function fmtTime(ts) {
  const t = new Date(ts);
  return util.pad(t.getHours()) + ':' + util.pad(t.getMinutes());
}

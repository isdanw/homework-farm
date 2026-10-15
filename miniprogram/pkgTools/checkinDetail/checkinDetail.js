/**
 * 打卡详情页（首页点击打卡图标进入）
 *  · 可输入文字描述：简单叙述当天的打卡情况（存进 homework[date][key].note）
 *  · 可选填写用时分钟数
 *  · 完成打卡 → 走 farmEngine.checkin，照常发放阳光 / 种子 / 推进合种
 *  · 调用「评语分析」云函数（mode:'note' 导学记录模式）对描述做分析，给出评价
 *  · 支持查看历史日期（只读）
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const sched = require('../../utils/scheduleEngine.js');
const studyPlan = require('../../utils/studyPlan.js');
const util = require('../../utils/util.js');
const { BUILTIN_ROLES } = require('../../utils/rolePresets.js');
const tutorStore = require('../../utils/tutorStore.js');
const tutorSubjects = require('../../utils/tutorSubjects.js');
const mistakeRules = require('../../utils/mistakeRules.js');


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
    roleName: '',                // 当前 AI 分析所用的角色名（语文/数学固定为对应内置角色，其余为空）
    scanning: false,             // 拍照识别中
    showMistakeModal: false,     // 识别到错题后的确认弹窗
    mistakeCount: 0,             // 弹窗展示的错题数量
    errorCluster: null           // 导学评价后的错因聚类卡片数据
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

  /* ---------------- 拍照识别导学内容 ----------------
   *  · 拍照/选图 → ocrSchedule action='mistake'（复用错题转录视觉链路，已配好）
   *  · 返回的 studyNote 自动回填到 note（导学内容总结，立即持久化）
   *  · 识别到错题（marked===false）则弹窗询问是否加入错题库；确定后直接入库并在 note 追加一句描述
   */

  /** 识别结果中的导学内容总结，写入 note（不覆盖用户已输入，追加到末尾；同一内容不重复追加） */
  autoFillNote(text) {
    if (!text) return;
    const cur = (this.data.note || '').trim();
    if (cur.indexOf(text) !== -1) return;   // 去重：重复识别同一张图 / 重复确认时不再追加同文案
    const merged = cur ? (cur + '\n' + text) : text;
    const capped = merged.slice(0, 300);   // 对齐 textarea maxlength
    this.setData({ note: capped, noteLen: capped.length });
    // 立即持久化，避免弹窗/导航后 render() 读回旧值覆盖
    const d = store.get();
    const date = this.data.date || util.today();
    const hw = engine.ensureDay(d, date);
    if (!hw[this.data.key]) hw[this.data.key] = { done: false, note: '', minutes: 0, doneAt: 0, analysis: '', planTask: '', planStage: '', planRef: null };
    hw[this.data.key].note = capped;
    store.save(d);
  },

  /* 收集「导学评价」要综合的素材：拍照识别到的题目（含错题与错因）+ 计划任务
   *  · 优先级：本次确认加入错题库的错题（带 E1-E9 诊断）> 本次拍照识别原始结果 > 错题库今日本题学科拍照错题（兜底，防页面重进丢失会话上下文）
   *  · 返回 [{ q, a, wrong, errorType, errorDesc, suggestion }] */
  getAnalysisItems() {
    const key = this.data.key;
    if (Array.isArray(this.confirmedMistakes) && this.confirmedMistakes.length) {
      return this.confirmedMistakes.map(m => ({
        q: m.questionText || '', a: m.childAnswer || '', wrong: true,
        errorType: m.errorType || '', errorDesc: m.errorDesc || '', suggestion: m.suggestion || ''
      }));
    }
    if (this.recognitionContext && Array.isArray(this.recognitionContext.items) && this.recognitionContext.items.length) {
      return this.recognitionContext.items.map(it => ({
        q: it.questionText || '', a: it.childAnswer || '',
        wrong: (it.wrong === true || it.marked === false),
        errorType: '', errorDesc: '', suggestion: ''
      }));
    }
    try {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const list = (tutorStore.getMistakes() || []).filter(m =>
        m.subject === key && m.source === 'photo' && (m.createdAt || 0) >= dayStart.getTime());
      if (list.length) return list.map(m => ({
        q: m.questionText || '', a: m.childAnswer || '', wrong: true,
        errorType: m.errorType || '', errorDesc: m.errorDesc || '', suggestion: m.suggestion || ''
      }));
    } catch (e) {}
    return [];
  },

  /* 把「文本描述 + 拍照识别题目/错题 + 计划任务」拼成一份综合分析内容（喂给现有分析云函数） */
  buildAnalysisContent() {
    const note = (this.data.note || '').trim();
    const items = this.getAnalysisItems();
    let block = '';
    if (items.length) {
      const total = items.length;
      const wrongN = items.filter(i => i.wrong).length;
      const lines = items.map((it, i) => {
        const p = [];
        p.push(it.wrong ? '【错题】' : '【已做】');
        if (it.q) p.push('题目：' + it.q);
        if (it.a) p.push('孩子作答：' + it.a);
        if (it.errorType) p.push('错因类型：' + it.errorType);
        if (it.errorDesc) p.push('错因说明：' + it.errorDesc);
        if (it.suggestion) p.push('改进建议：' + it.suggestion);
        return (i + 1) + '. ' + p.join('；');
      });
      block = '\n\n【今日拍照识别到的练习题目（共 ' + total + ' 题，其中错题 ' + wrongN + ' 道）】\n' + lines.join('\n');
    }
    if (this.data.planTask) {
      block += '\n\n【今日导学计划任务】' + this.data.planTask + (this.data.planStage ? '（' + this.data.planStage + '）' : '');
    }
    const clusterText = this.errorClusterText();
    if (clusterText) block += '\n\n' + clusterText;
    let content = (note + block).trim();
    // aiRoleAnalyze 限制 content ≤ 6000；超长时优先保留文本描述，裁剪题目列表尾部
    if (content.length > 5800) {
      const keep = block.length - (content.length - 5800);
      const cut = keep > 0 ? block.slice(0, keep) + '\n…（题目较多，已截断）' : '';
      content = (note + cut).trim();
    }
    return content;
  },

  /* 按错因类型（E1-E9）聚合本次错题，输出聚类数据（供「导学评价」引用 + 独立展示卡片）
   *  · errorType 为 E 码（如 'E7'）；空串表示「尚未诊断 / 未确认收录」，归入「未归类」 */
  buildErrorClusterData() {
    const items = this.getAnalysisItems().filter(i => i.wrong);
    if (!items.length) return { has: false, groups: [], totalWrong: 0, topName: '', topCount: 0, unclassified: 0 };
    const map = {};
    let unclassified = 0;
    items.forEach(it => {
      const code = (it.errorType || '').trim();
      if (!code) { unclassified++; return; }
      if (!map[code]) {
        const meta = mistakeRules.ERROR_TYPES[code] || {};
        map[code] = { code: code, name: meta.name || code, color: meta.color || '#8A8A8A', bg: meta.bg || '#F2F2F2', count: 0 };
      }
      map[code].count++;
    });
    const groups = Object.keys(map).map(k => map[k]).sort((a, b) => b.count - a.count);
    const top = groups[0] || null;
    return {
      has: true,
      groups: groups,
      totalWrong: items.length,
      topName: top ? top.name : '',
      topCount: top ? top.count : 0,
      unclassified: unclassified
    };
  },

  /* 把错因聚类写成一行文本，注入到分析内容，便于评价引用 */
  errorClusterText() {
    const c = this.buildErrorClusterData();
    if (!c.has) return '';
    const parts = c.groups.map(g => (g.code + ' ' + g.name + ' ×' + g.count));
    if (c.unclassified) parts.push('未归类（待确认收录）×' + c.unclassified);
    const topLine = c.topName ? ('本次最集中的错因类型是「' + c.topName + '」（' + c.topCount + ' 道）') : '';
    return '【错题错因聚类（系统统计）】共 ' + c.totalWrong + ' 道错题：' + parts.join('，') + '。' + topLine;
  },

  photoAdd() {
    if (this.data.scanning) return;
    if (!this.data.isToday) return util.toast('只能给今天的打卡拍照记录哦');
    if (!wx.cloud || !wx.cloud.callFunction) {
      return wx.showModal({
        title: '拍照识别不可用', content: '云函数未就绪，请稍后再试。',
        showCancel: false, confirmText: '好的'
      });
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: (res) => {
        const temp = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
        if (!temp) return;
        let photoPath = temp;
        try {
          const fs = wx.getFileSystemManager();
          photoPath = `${wx.env.USER_DATA_PATH}/checkin_photo.png`;
          fs.copyFileSync(temp, photoPath);
        } catch (e) { photoPath = temp; }
        this.recognizeQuestions(photoPath);
      }
    });
  },

  recognizeQuestions(photoPath) {
    if (this.data.scanning) return;
    wx.showLoading({ title: '正在识别…', mask: true });
    this.setData({ scanning: true });

    let b64 = '';
    try {
      b64 = wx.getFileSystemManager().readFileSync(photoPath, 'base64');
    } catch (e) {
      wx.hideLoading();
      this.setData({ scanning: false });
      return util.toast('读取图片失败，请重试');
    }

    wx.cloud.callFunction({
      name: 'ocrSchedule',
      data: { action: 'mistake', imageBase64: b64 }
    }).then(res => {
      wx.hideLoading();
      this.setData({ scanning: false });
      const r = res && res.result;
      if (r && r.ok && Array.isArray(r.items) && r.items.length) {
        // 缓存整页识别结果（含全部题目与对错标记），供「导学评价」综合使用
        this.recognitionContext = { subjectGuess: r.subjectGuess || '', items: r.items };
        // ① 导学内容总结自动回填 note（不依赖用户是否把错题加入错题库）
        if (r.studyNote) this.autoFillNote(r.studyNote);
        // ② 错题 = 模型判定答错（wrong===true）或图上批改为错（marked===false）；自动识别无需人工勾选
        const wrongs = r.items.filter(it => it.wrong === true || it.marked === false);
        if (wrongs.length) {
          this.pendingMistakes = { subjectGuess: r.subjectGuess || '', items: wrongs };
          this.setData({ showMistakeModal: true, mistakeCount: wrongs.length });
        } else {
          util.toast('未识别到错题，已自动填入练习内容');
        }
      } else {
        util.toast((r && r.msg) || '没能识别出题目，请重试');
      }
    }).catch(err => {
      wx.hideLoading();
      console.warn('[checkinDetail] 拍照识别失败', err);
      this.setData({ scanning: false });
      util.toast('识别失败，请检查「拍照识别设置」后重试');
    });
  },

  /* ---------------- 错题确认弹窗 ----------------
   *  · 确定：先跑错因识别（本地规则归因 calc/dictation 有批改 + 其余送 tutorChat 诊断 E1-E9），再入库
   *  · 入库：addMistake(source:'photo') + 派生复习窗口 + 上云队列；note 追加一句描述
   *  · 取消：仅保留已自动填入的导学内容总结，不入库
   */
  confirmAddMistakes() {
    this.confirmedMistakes = [];   // 记录本次确认加入错题库的题目（带 E1-E9 诊断），供「导学评价」使用
    const pm = this.pendingMistakes;
    this.setData({ showMistakeModal: false, mistakeCount: 0 });
    this.pendingMistakes = null;
    if (!pm || !pm.items || !pm.items.length) return;
    const sub = tutorSubjects.getTutorSubject(pm.subjectGuess) || { key: 'math', name: '数学' };

    // 每道错题：本地规则归因优先（calc/dictation 有批改），其余送 AI 诊断错因（E1-E9）
    const cards = pm.items.map(it => {
      const marked = (it.marked === true || it.marked === false) ? it.marked : null;
      return { no: String(it.no || ''), type: it.type || 'other', questionText: it.questionText || '', childAnswer: it.childAnswer || '', marked: marked };
    });
    const ruleOf = {};
    const aiCards = [];
    cards.forEach(c => {
      const rule = mistakeRules.ruleDiagnose(c);
      if (rule) ruleOf[c.no] = rule;
      else aiCards.push(c);
    });

    const finish = (diagMap) => {
      let saved = 0;
      cards.forEach(c => {
        const d = diagMap[c.no] || null;
        const rule = ruleOf[c.no] || null;
        const topic = rule ? rule.topic : ((d && d.topic) || (mistakeRules.clip(c.questionText, 30) || '（未标注知识点）'));
        const errorType = rule ? rule.errorType : ((d && d.errorType) || '');
        const errorDesc = rule ? rule.errorDesc : ((d && d.errorDesc) || '');
        const suggestion = rule ? rule.suggestion : ((d && d.suggestion) || '');
        const mid = util.uid('mk');
        tutorStore.addMistake({
          id: mid,
          subject: sub.key,
          subjectName: sub.name,
          topic: topic,
          errorType: errorType,
          errorDesc: errorDesc,
          suggestion: suggestion,
          status: 'pending',
          source: 'photo',
          questionText: c.questionText,
          childAnswer: c.childAnswer,
          markSource: c.marked !== null ? 'marked' : (errorType ? 'ai' : 'none')
        });
        tutorStore.upsertReview({
          id: mid + '_rv',
          mistakeId: mid,
          subject: sub.key,
          subjectName: sub.name,
          topic: topic,
          errorType: errorType,
          stage: 1,
          dueAt: Date.now() + tutorStore.REVIEW_STAGE_DAYS[0] * 86400000
        });
        saved++;
        this.confirmedMistakes.push({ questionText: c.questionText, childAnswer: c.childAnswer, errorType: errorType, errorDesc: errorDesc, suggestion: suggestion });
      });
      tutorStore.pushQueued();
      this.autoFillNote('📷 已识别 ' + saved + ' 道错题，已加入错题库');
      util.toast('已添加 ' + saved + ' 道错题到错题库', 'success');
    };

    // 无需 AI 诊断（全部命中本地规则）→ 直接入库
    if (!aiCards.length) { finish({}); return; }

    // 有待诊断项 → 调 tutorChat diagnoseQuestions（E1-E9）；失败降级不阻塞收录
    if (!wx.cloud || !wx.cloud.callFunction) { finish({}); return; }
    wx.showLoading({ title: '诊断错因中…', mask: true });
    wx.cloud.callFunction({
      name: 'tutorChat',
      data: {
        action: 'diagnoseQuestions',
        subject: this.data.key,   // 以打卡学科为上下文
        items: aiCards.map(c => ({ no: c.no, type: c.type, questionText: c.questionText, childAnswer: c.childAnswer, marked: c.marked, correctAnswer: '' }))
      }
    }).then(res => {
      wx.hideLoading();
      const r = res && res.result;
      const diagMap = {};
      if (r && r.ok && Array.isArray(r.items)) {
        r.items.forEach(d => { if (d && d.no !== undefined) diagMap[String(d.no)] = d; });
      }
      finish(diagMap);
    }).catch(err => {
      wx.hideLoading();
      console.warn('[checkinDetail] 错因诊断失败', err);
      finish({});   // 降级：按无错因收录，不阻塞
    });
  },

  cancelAddMistakes() {
    this.setData({ showMistakeModal: false, mistakeCount: 0 });
    this.pendingMistakes = null;
    util.toast('已取消添加错题');
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

    // 记录当前计划任务首次开始日（绑定「实际完成天数」：完成日 − 开始日）
    const ref = this.data.planRef;
    if (ref && ref.si != null && ref.ti != null) {
      studyPlan.markTaskStarted(this.data.key, ref.si, ref.ti, util.today());
    }

    // 精力条（P1）：按本次打卡时长扣减，口径与导学统一（1 分钟 = 1 点）。
    // 未填时长按 CHECKIN_DEFAULT_MIN 兜底，保证「填了多久就扣多久」不被打卡流程割裂。
    const spentMin = Number(this.data.minutes) || 5;
    const cap = store.checkPaceCap(spentMin);
    if (cap.over) this._restTip(cap);
    store.spendPace(spentMin);   // 内部走 save()：落盘 + 登记上云 + 广播（首页精力条自动刷新）

    // 学科情境（P2）：按打卡科目推进情境进度，解锁碎片时轻提示（累积制，不阻断）
    this._advanceScenario();

    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    util.toast(`🎉 ${this.data.type.name}打卡完成！阳光 +${gain.sun}`, 'success');
    this.render();
  },

  /**
   * 学科情境（P2）：推进本次打卡科目的情境进度，达节点解锁剧情碎片时弹一次轻提示。
   * 累积制只增不减，不阻断打卡。
   */
  _advanceScenario() {
    try {
      const key = this.data.key;
      const res = store.advanceScenario(key);
      if (res && res.unlocked && res.unlocked.length) {
        const b = store.getScenarioBanner(key);
        const frag = b && b.latest;
        if (frag) {
          setTimeout(() => util.toast(`${b.emoji} ${frag.title}：${frag.text}`, 'success'), 900);
        }
      }
    } catch (e) {}
  },

  /**
   * 精力条：单节/单次时长超建议上限时的**非阻断**轻提示。
   * 只提示一次（同一会话内不连弹），不阻止打卡 —— 契合「习惯培养」而非「管控」。
   */
  _restTip(cap) {
    if (this._restTipShown) return;
    this._restTipShown = true;
    wx.showModal({
      title: '该让大脑歇歇啦 🌿',
      content: `这次花了 ${cap.minutes} 分钟，超过建议的 ${cap.capMin} 分钟。\n要不要起来活动一下，再继续？`,
      confirmText: '去玩会儿',
      cancelText: '继续',
      confirmColor: '#5FBF6B'
    });
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
   *  · 其他学科：沿用原 analyzeComment 云函数（mode:'note' 导学记录模式）
   */
  analyze() {
    const note = (this.data.note || '').trim();
    // 允许「只拍照未打字」也分析：只要文本描述或拍照识别题目任一存在即可
    if (!note && !this.getAnalysisItems().length) {
      return util.toast('先写点今天的打卡情况，或拍一张练习纸再分析');
    }
    if (this.data.analyzing) return;
    if (!wx.cloud || !wx.cloud.callFunction) {
      return wx.showModal({
        title: '云函数未就绪',
        content: '需要部署 aiRoleAnalyze / analyzeComment 云函数后才能在小程序里使用导学分析。',
        showCancel: false, confirmText: '知道了'
      });
    }

    wx.showLoading({ title: '分析中…', mask: true });
    this.setData({ analyzing: true, result: null, errorCluster: null });

    const child = store.get();
    const base = { childName: child.nickname || '', grade: child.grade || '' };

    // —— 语文/数学：固定对应内置角色提示词（走 aiRoleAnalyze）——
    const role = roleForSubject(this.data.key);
    if (role) {
      wx.cloud.callFunction({
        name: 'aiRoleAnalyze',
        data: {
          rolePrompt: role.prompt,
          content: this.buildAnalysisContent(),   // 综合：文本描述 + 拍照识别题目/错题 + 计划任务
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
        mode: 'note',                       // 导学记录模式（区别于老师评语）
        subject: this.data.key,
        subjectLabel: this.data.type.name,  // 自定义打卡类型也能拿到准确名称
        comment: this.buildAnalysisContent(),   // 综合：文本描述 + 拍照识别题目/错题 + 计划任务
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
    this.setData({ result: { analysis: r.analysis || '', sections: [] }, analyzing: false, errorCluster: this.buildErrorClusterData() });
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
    this.setData({ result: r, analyzing: false, errorCluster: this.buildErrorClusterData() });
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

  /* 从打卡页跳转 AI 导学（带打卡内容 + 当前计划任务上下文，打通「打卡 → 导学」） */
  goTutor() {
    const key = this.data.key;
    if (!key) return;
    const url = '/pkgGuide/tutor/tutor?key=' + key +
      (this.data.note ? ('&checkinNote=' + encodeURIComponent(this.data.note)) : '') +
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

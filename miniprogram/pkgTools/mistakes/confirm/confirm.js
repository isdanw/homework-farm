/**
 * 确认页（拍照收录 · 人工确认环节，流程设计 D3）
 *
 * 阶段一产物（ocrSchedule action='mistake' 的转录草稿）在这里逐条核对：
 *  · 全部字段可编辑（题号/题型/题干/作答/对错标记）
 *  · 勾选收录哪些题（默认只勾「老师批改 ×」的题）
 *  · 「AI 诊断错因」：规则路由（calc/dictation 有批改）本地归因；
 *    其余走 tutorChat action='diagnoseQuestions'（E1-E9，诊断失败不阻塞收录）
 *  · 「收录」：tutorStore.addMistake（source='photo'）→ 内部自动入队上云 → 派生复习窗口
 */
const tutorStore = require('../../../utils/tutorStore.js');
const util = require('../../../utils/util.js');
const tutorSubjects = require('../../../utils/tutorSubjects.js');
const mistakeRules = require('../../../utils/mistakeRules.js');

const OCR_DRAFT_KEY = 'wb_hwfarm_ocr_draft_v1';
const DRAFT_MAX_AGE = 10 * 60 * 1000;   // 草稿时效：超时视为陈旧数据丢弃

const ERROR_TYPES = mistakeRules.ERROR_TYPES;
const TYPE_KEYS = Object.keys(mistakeRules.QUESTION_TYPES);
const TYPE_NAMES = TYPE_KEYS.map(k => mistakeRules.QUESTION_TYPES[k].name);
const E_LABELS = ['不标注'].concat(
  Object.keys(ERROR_TYPES).map(k => k + ' ' + ERROR_TYPES[k].name)
);
const E_KEYS = [''].concat(Object.keys(ERROR_TYPES));

Page({
  data: {
    photoPath: '',
    subjects: tutorSubjects.TUTOR_SUBJECTS,
    subjectKey: 'math',
    subjectName: '数学',
    cards: [],
    selectedCount: 0,
    aiCount: 0,
    stage: 'edit',            // edit 勾选编辑 / diagnosed 错因已回填
    typeNames: TYPE_NAMES,
    eLabels: E_LABELS,
    diagnosing: false
  },

  onLoad() {
    let draft = null;
    try { draft = wx.getStorageSync(OCR_DRAFT_KEY) || null; } catch (e) {}
    if (!draft || !Array.isArray(draft.items) || !draft.items.length ||
        !draft.ts || (Date.now() - draft.ts) > DRAFT_MAX_AGE) {
      util.toast('识别草稿已失效，请重新拍照');
      return setTimeout(() => wx.navigateBack({ delta: 1 }), 800);
    }

    const cards = draft.items.map((it, idx) => this.buildCard(it, idx));
    const guess = draft.subjectGuess || '';
    const subjectKey = tutorSubjects.getTutorSubject(guess) ? guess : 'math';
    this.draftPhotoPath = draft.photoPath || '';
    this.setData({
      photoPath: draft.photoPath || '',
      subjectKey: subjectKey,
      subjectName: (tutorSubjects.getTutorSubject(subjectKey) || {}).name || '数学',
      cards: cards
    }, () => this.updateMeta());
  },

  /** 云函数转录条目 → 确认页卡片 */
  buildCard(it, idx) {
    const marked = (it.marked === true || it.marked === false) ? it.marked : null;
    const card = {
      idx: idx,
      selected: it.selected === true,
      no: it.no || String(idx + 1),
      type: TYPE_KEYS.indexOf(it.type) >= 0 ? it.type : 'other',
      typeIndex: Math.max(0, TYPE_KEYS.indexOf(it.type)),
      typeName: mistakeRules.typeName(TYPE_KEYS.indexOf(it.type) >= 0 ? it.type : 'other'),
      questionText: it.questionText || '',
      childAnswer: it.childAnswer || '',
      correctAnswer: it.correctAnswer || '',
      marked: marked,                        // boolean|null（逻辑值）
      markLabel: marked === true ? '√ 对' : marked === false ? '× 错' : '未批',
      markSource: marked !== null ? 'marked' : 'none',
      topic: '',
      errorType: '',
      errorTypeName: '',
      errorColor: '#8A8A8A',
      errorBg: '#F2F2F2',
      errorDesc: '',
      suggestion: '',
      rule: false
    };
    // 规则路由题（calc/dictation 有批改标记）：本地直接预填归因
    const rule = mistakeRules.ruleDiagnose({ type: card.type, marked: marked, questionText: card.questionText, childAnswer: card.childAnswer });
    if (rule) {
      card.rule = true;
      card.topic = rule.topic;
      card.errorType = rule.errorType;
      card.errorDesc = rule.errorDesc;
      card.suggestion = rule.suggestion;
      this.applyTag(card, rule.errorType);
    }
    return card;
  },

  applyTag(card, eKey) {
    const et = ERROR_TYPES[eKey] || null;
    card.errorType = eKey || '';
    card.errorTypeName = et ? et.name : '';
    card.errorColor = et ? et.color : '#8A8A8A';
    card.errorBg = et ? et.bg : '#F2F2F2';
  },

  /* ---------------- 统计（选中数 / 需 AI 诊断数） ---------------- */
  updateMeta() {
    const cards = this.data.cards;
    const selected = cards.filter(c => c.selected);
    const aiCount = selected.filter(c => {
      return !c.rule && mistakeRules.ruleDiagnose({ type: c.type, marked: c.marked, questionText: c.questionText, childAnswer: c.childAnswer }) === null;
    }).length;
    this.setData({
      selectedCount: selected.length,
      aiCount: aiCount,
      cards: cards
    });
  },

  /* ---------------- 勾选 / 删除 / 加题 ---------------- */
  toggleCard(e) {
    const i = e.currentTarget.dataset.idx;
    const cards = this.data.cards;
    cards[i].selected = !cards[i].selected;
    this.updateMeta();
  },
  delCard(e) {
    const i = e.currentTarget.dataset.idx;
    const cards = this.data.cards.slice();
    cards.splice(i, 1);
    // 重新编号 idx，保持 key 稳定
    cards.forEach((c, j) => { c.idx = j; });
    this.setData({ cards: cards }, () => this.updateMeta());
  },
  addCard() {
    const cards = this.data.cards;
    const card = this.buildCard({ type: 'other', questionText: '', childAnswer: '', marked: null, selected: true }, cards.length);
    card.selected = true;
    cards.push(card);
    this.setData({ cards: cards }, () => this.updateMeta());
  },

  /* ---------------- 字段编辑 ---------------- */
  onInput(e) {
    const i = e.currentTarget.dataset.idx;
    const field = e.currentTarget.dataset.field;
    const cards = this.data.cards;
    if (!cards[i] || !field) return;
    cards[i][field] = e.detail.value;
    // 规则路由题改了题干/作答：同步刷新规则归因文案
    if (field === 'questionText' || field === 'childAnswer') this.refreshRule(cards[i]);
    this.setData({ cards: cards });
  },

  pickType(e) {
    const i = Number(e.currentTarget.dataset.idx);
    const v = Number(e.detail.value);
    const cards = this.data.cards;
    if (!cards[i]) return;
    cards[i].type = TYPE_KEYS[v] || 'other';
    cards[i].typeIndex = v;
    cards[i].typeName = mistakeRules.typeName(cards[i].type);
    cards[i].rule = false;
    this.refreshRule(cards[i], true);
    this.setData({ cards: cards }, () => this.updateMeta());
  },

  /** 改题型/题干/作答后重算规则归因（calc/dictation 且有批改标记时覆盖） */
  refreshRule(card, force) {
    const rule = mistakeRules.ruleDiagnose({ type: card.type, marked: card.marked, questionText: card.questionText, childAnswer: card.childAnswer });
    if (!rule) {
      if (force) {
        card.rule = false;
        card.topic = '';
        card.errorType = '';
        card.errorDesc = '';
        card.suggestion = '';
        this.applyTag(card, '');
      }
      return;
    }
    card.rule = true;
    card.topic = rule.topic;
    card.errorType = rule.errorType;
    card.errorDesc = rule.errorDesc;
    card.suggestion = rule.suggestion;
    this.applyTag(card, rule.errorType);
  },

  /** 对错三态按钮：'1' 对 / '0' 错 / 'none' 未批 */
  setMark(e) {
    const i = Number(e.currentTarget.dataset.idx);
    const v = e.currentTarget.dataset.val;
    const cards = this.data.cards;
    if (!cards[i]) return;
    cards[i].marked = v === '1' ? true : v === '0' ? false : null;
    cards[i].markLabel = cards[i].marked === true ? '√ 对' : cards[i].marked === false ? '× 错' : '未批';
    cards[i].markSource = cards[i].marked !== null ? 'marked' : 'none';
    this.refreshRule(cards[i], true);
    this.setData({ cards: cards });
  },

  /* ---------------- 学科 ---------------- */
  pickSubject(e) {
    const key = e.currentTarget.dataset.key;
    const sub = tutorSubjects.getTutorSubject(key);
    if (!sub) return;
    this.setData({ subjectKey: key, subjectName: sub.name });
  },

  /* ---------------- AI 诊断（阶段二，规则路由之外的题打包一次调用） ---------------- */
  doDiagnose() {
    if (this.data.diagnosing || this.data.stage !== 'edit') return;
    const targets = this.data.cards.filter(c => c.selected && !c.rule);
    if (!targets.length) { this.finishDiagnose(); return; }

    if (!wx.cloud || !wx.cloud.callFunction) {
      this.aiFallback(targets, '云函数未就绪');
      return;
    }
    this.setData({ diagnosing: true });
    wx.showLoading({ title: '自动诊断错因中…', mask: true });
    wx.cloud.callFunction({
      name: 'tutorChat',
      data: {
        action: 'diagnoseQuestions',
        subject: this.data.subjectKey,
        items: targets.map(c => ({
          no: c.no,
          type: c.type,
          questionText: c.questionText,
          childAnswer: c.childAnswer,
          marked: c.marked,
          correctAnswer: c.correctAnswer
        }))
      }
    }).then(res => {
      wx.hideLoading();
      this.setData({ diagnosing: false });
      const r = res && res.result;
      if (r && r.ok && Array.isArray(r.items) && r.items.length) {
        // 按 no 匹配回填（模型被要求逐一对应 no）；匹配不到的保持空错因
        const byNo = {};
        r.items.forEach(d => { if (d && d.no !== undefined) byNo[String(d.no)] = d; });
        targets.forEach(c => {
          const d = byNo[String(c.no)] || null;
          if (d) {
            if (d.topic && !this.data.cards[c.idx].topic) this.data.cards[c.idx].topic = d.topic;
            this.data.cards[c.idx].errorDesc = d.errorDesc || this.data.cards[c.idx].errorDesc;
            this.data.cards[c.idx].suggestion = d.suggestion || this.data.cards[c.idx].suggestion;
            this.applyTag(this.data.cards[c.idx], d.errorType || '');
            if (!this.data.cards[c.idx].markSource || this.data.cards[c.idx].markSource === 'none') {
              this.data.cards[c.idx].markSource = 'ai';
            }
          } else {
            this.aiFallbackSingle(this.data.cards[c.idx]);
          }
        });
        this.setData({ cards: this.data.cards }, () => this.finishDiagnose());
      } else {
        this.aiFallback(targets, (r && r.msg) || '诊断暂不可用');
      }
    }).catch(err => {
      wx.hideLoading();
      console.warn('[confirm] 诊断失败', err);
      this.setData({ diagnosing: false });
      this.aiFallback(targets, '诊断暂不可用');
    });
  },

  /** AI 诊断失败降级：空错因落库，不阻塞收录（设计红线） */
  aiFallback(targets, why) {
    targets.forEach(c => this.aiFallbackSingle(this.data.cards[c.idx]));
    this.setData({ cards: this.data.cards }, () => this.finishDiagnose());
    util.toast('自动诊断暂不可用，已按无错因收录');
  },
  aiFallbackSingle(card) {
    if (!card.topic) card.topic = mistakeRules.clip(card.questionText, 30) || '（未标注知识点）';
    if (!card.errorDesc) card.errorDesc = '错因待补充：可先收录，去订正时和 AI 一起看这题';
    if (card.markSource === 'none') card.markSource = 'ai';
  },

  finishDiagnose() {
    this.setData({ stage: 'diagnosed' });
    util.toast('错因已生成，可修改后收录', 'success');
  },

  /* ---------------- 收录入库 ---------------- */
  saveAll() {
    const selected = this.data.cards.filter(c => c.selected);
    if (!selected.length) return util.toast('请先勾选要收录的题目');
    const sub = tutorSubjects.getTutorSubject(this.data.subjectKey) || { key: 'math', name: '数学' };
    let saved = 0;
    selected.forEach(c => {
      const mid = util.uid('mk');
      tutorStore.addMistake({
        id: mid,
        subject: sub.key,
        subjectName: sub.name,
        topic: c.topic || mistakeRules.clip(c.questionText, 30) || '（未标注知识点）',
        errorType: c.errorType || '',
        errorDesc: c.errorDesc || '',
        suggestion: c.suggestion || '',
        status: 'pending',
        source: 'photo',
        questionText: c.questionText,
        childAnswer: c.childAnswer,
        markSource: c.marked !== null ? 'marked' : (c.errorType ? 'ai' : 'none')
      });
      // 派生复习窗口（与导学归档闭环一致：stage1 → 1 天后到期）
      tutorStore.upsertReview({
        id: mid + '_rv',
        mistakeId: mid,
        subject: sub.key,
        subjectName: sub.name,
        topic: c.topic || '（未标注知识点）',
        errorType: c.errorType || '',
        stage: 1,
        dueAt: Date.now() + tutorStore.REVIEW_STAGE_DAYS[0] * 86400000
      });
      saved++;
    });

    // 收录完成后：补写队列上云（fire-and-forget）+ 清理草稿和本地照片
    tutorStore.pushQueued();
    try { wx.removeStorageSync(OCR_DRAFT_KEY); } catch (e) {}
    this.cleanupPhoto();

    util.toast('已收录 ' + saved + ' 道错题', 'success');
    setTimeout(() => wx.navigateBack({ delta: 1 }), 600);
  },

  cleanupPhoto() {
    const p = this.draftPhotoPath || '';
    if (!p || String(p).indexOf(wx.env.USER_DATA_PATH) !== 0) return;
    try { wx.getFileSystemManager().unlinkSync(p); } catch (e) {}
  },

  previewPhoto() {
    if (!this.data.photoPath) return;
    wx.previewImage({ urls: [this.data.photoPath] });
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});

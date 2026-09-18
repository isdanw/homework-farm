/**
 * 错题本页（全科导学 P2）
 *  · 展示 tutorStore 里的错题（导学归档时 AI 诊断 E1-E9 卡点自动落库）
 *  · 按学科筛选；每条错题含 E1-E9 错因标签、可观察表现、建议
 *  · 「去订正」→ 跳转导学页（mistakeContext 自动围绕知识点开场，不直接给答案）
 *  · 「标记已订正」→ 手动切换状态（订正 ≠ 掌握，不做自动判定）
 */
const store = require('../../utils/store.js');
const tutorStore = require('../../utils/tutorStore.js');
const util = require('../../utils/util.js');
const tutorSubjects = require('../../utils/tutorSubjects.js');
const mistakeRules = require('../../utils/mistakeRules.js');

/** 九科筛选（与导学页对齐） */
const TUTOR_SUBJECTS = tutorSubjects.TUTOR_SUBJECTS;

/** E1-E9 标签配色（与规则路由/确认页共用一份，见 utils/mistakeRules.js） */
const ERROR_TYPES = mistakeRules.ERROR_TYPES;

/** 拍照识别草稿（错题本页 → 确认页传递用） */
const OCR_DRAFT_KEY = 'wb_hwfarm_ocr_draft_v1';

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    filterKey: 'all',       // all | chinese | math | english
    subjects: TUTOR_SUBJECTS,
    list: [],
    pendingCount: 0,
    scanning: false
  },

  onShow() { this.render(); },

  render() {
    const all = tutorStore.getMistakes();
    const fk = this.data.filterKey;
    const list = all
      .filter(m => fk === 'all' || m.subject === fk)
      .map(m => {
        const et = ERROR_TYPES[m.errorType] || null;
        return {
          id: m.id,
          subject: m.subject,
          subjectName: m.subjectName || '',
          topic: m.topic || '（未标注知识点）',
          errorType: m.errorType || '',
          errorTypeName: et ? et.name : (m.errorType || ''),
          errorColor: et ? et.color : '#8A8A8A',
          errorBg: et ? et.bg : '#F2F2F2',
          errorDesc: m.errorDesc || '',
          suggestion: m.suggestion || '',
          status: m.status || 'pending',
          statusText: (m.status === 'corrected') ? '已订正' : '待订正',
          source: m.source || 'tutor',
          questionText: m.questionText || '',
          childAnswer: m.childAnswer || '',
          timeText: fmtTime(m.createdAt)
        };
      });
    this.setData({
      list: list,
      pendingCount: all.filter(m => m.status !== 'corrected').length
    });
  },

  /* ---------------- 学科筛选 ---------------- */
  pickFilter(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.filterKey) return;
    this.setData({ filterKey: key }, () => this.render());
  },

  /* ---------------- 去订正（跳导学页） ---------------- */
  goCorrect(e) {
    const m = e.currentTarget.dataset.m;
    if (!m) return;
    wx.navigateTo({
      url: '/pkgGuide/tutor/tutor?key=' + encodeURIComponent(m.subject) +
        '&topic=' + encodeURIComponent(m.topic) +
        '&errorType=' + encodeURIComponent(m.errorType)
    });
  },

  /* ---------------- 复测（跳复测页，生成 5 道同类题；带错题 id 供复习窗口推进） ---------------- */
  goRetest(e) {
    const m = e.currentTarget.dataset.m;
    if (!m) return;
    wx.navigateTo({
      url: '/pkgGuide/retest/retest?key=' + encodeURIComponent(m.subject) +
        '&topic=' + encodeURIComponent(m.topic) +
        '&errorType=' + encodeURIComponent(m.errorType) +
        '&mid=' + encodeURIComponent(m.id)
    });
  },

  /* ---------------- 手动标记已订正（订正 ≠ 掌握，不做自动判定） ---------------- */
  toggleStatus(e) {
    const m = e.currentTarget.dataset.m;
    if (!m) return;
    const next = m.status === 'corrected' ? 'pending' : 'corrected';
    tutorStore.setMistakeStatus(m.id, next);
    util.toast(next === 'corrected' ? '已标记为订正' : '已恢复为待订正', 'success');
    this.render();
  },

  /* ---------------- 拍照收录（阶段一：视觉转录 → 确认页） ---------------- */
  photoAdd() {
    if (this.data.scanning) return;
    if (!wx.cloud || !wx.cloud.callFunction) {
      return wx.showModal({
        title: '拍照收录不可用', content: '云函数未就绪，请稍后再试。',
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
        // 转存为固定名本地文件：确认页可对照原图，且不会堆积临时文件
        let photoPath = temp;
        try {
          const fs = wx.getFileSystemManager();
          photoPath = `${wx.env.USER_DATA_PATH}/mistake_photo.png`;
          fs.copyFileSync(temp, photoPath);
        } catch (e) { photoPath = temp; }
        this.recognizeQuestions(photoPath);
      }
    });
  },

  recognizeQuestions(photoPath) {
    wx.showLoading({ title: '正在识别题目…', mask: true });
    this.setData({ scanning: true });

    let b64 = '';
    try {
      b64 = wx.getFileSystemManager().readFileSync(photoPath, 'base64');
    } catch (e) {
      wx.hideLoading();
      this.setData({ scanning: false });
      return util.toast('读取图片失败，请重试');
    }

    // 视觉识别模型配置已移至网页端（云端按 openid 存储，云函数直接读取），此处不再传本地配置
    wx.cloud.callFunction({
      name: 'ocrSchedule',
      data: { action: 'mistake', imageBase64: b64 }
    }).then(res => {
      wx.hideLoading();
      this.setData({ scanning: false });
      const r = res && res.result;
      if (r && r.ok && Array.isArray(r.items) && r.items.length) {
        // 默认只勾选「老师批改 ×」的题（收录的是错题）；其余由用户手动勾选
        const draft = {
          ts: Date.now(),
          photoPath: photoPath,
          subjectGuess: r.subjectGuess || '',
          items: r.items.map(it => ({
            no: it.no || '',
            type: it.type || 'other',
            questionText: it.questionText || '',
            childAnswer: it.childAnswer || '',
            marked: (it.marked === true || it.marked === false) ? it.marked : null,
            correctAnswer: it.correctAnswer || '',
            selected: it.marked === false
          }))
        };
        try { wx.setStorageSync(OCR_DRAFT_KEY, draft); } catch (e) {}
        wx.navigateTo({ url: '/pkgTools/mistakes/confirm/confirm' });
      } else {
        util.toast((r && r.msg) || '没能识别出题目，请重试');
      }
    }).catch(err => {
      wx.hideLoading();
      console.warn('[mistakes] 拍照识别失败', err);
      this.setData({ scanning: false });
      util.toast('识别失败，请检查「拍照识别设置」后重试');
    });
  },

  /* ---------------- 返回 ---------------- */
  goBack() { wx.navigateBack({ delta: 1 }); }
});

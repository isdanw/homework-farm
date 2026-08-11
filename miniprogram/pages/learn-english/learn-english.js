/**
 * 英语启蒙模块
 *  · 字母认知：A-Z 网格，点字母看好朋友单词
 *  · 单词图文卡：图 + 词
 *  · 简单跟读：纯视觉跟读动作 + 家长 1-3 星打分（不录音，规避儿童隐私合规）
 *  · 完成今日练习 → engine.checkin('english') 联动农场奖励
 *
 * 合规说明：本页不调用 wx.getRecorderManager / wx.getLocation 等隐私敏感接口，
 * 跟读仅做"开口动作 + 家长打分"的视觉互动，不采集任何用户音频，
 * 满足《儿童个人信息网络保护规定》与个人主体小程序的隐私要求。
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const util = require('../../utils/util.js');
const LD = require('../../utils/learnData.js');
const tts = require('../../utils/tts.js');

Page({
  data: {
    tab: 0, stars: 0,
    abcList: LD.ABC.map(a => ({ l: a[0], w: a[1], e: a[2] })),
    abcSel: null,
    words: LD.WORDS,
    wordSel: null,
    readList: LD.WORDS.slice(0, 8),
    readI: 0,
    reading: false,     // 跟读中状态（纯视觉，非录音）
    showScore: false
  },

  onLoad() {
    this.setData({ stars: (store.get().learn || {}).stars || 0 });
  },
  onUnload() { tts.stop(); },
  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.i }); },

  addStar() {
    const d = store.get();
    if (!d.learn) d.learn = { stars: 0 };
    d.learn.stars += 1; store.save(d);
    this.setData({ stars: d.learn.stars });
  },

  /* ---------- 字母认知 ---------- */
  tapLetter(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ abcSel: this.data.abcList[i] });
  },
  // 朗读字母名 + 示例词（先播字母，约 0.95s 后播单词，避免相互覆盖）
  playLetter() {
    const s = this.data.abcSel;
    if (!s) return;
    tts.speak(s.l, 'en_US');
    setTimeout(() => tts.speak(s.w, 'en_US'), 950);
  },

  /* ---------- 单词图文卡 ---------- */
  tapWord(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ wordSel: this.data.words[i] });
  },
  playWord() { if (this.data.wordSel) tts.speak(this.data.wordSel.w, 'en_US'); },

  /* ---------- 简单跟读（纯视觉动作 + 家长打分，不录音） ---------- */
  // 朗读跟读目标词，作为示范音让孩子先听再开口
  playRead() { tts.speak(this.data.readList[this.data.readI].w, 'en_US'); },
  // 纯视觉跟读：点一下进入"跟读中"，再点一下完成 → 家长打分。
  // 不采集任何音频，规避儿童隐私合规（个人主体小程序无需后台声明录音权限）。
  toggleRead() {
    if (this.data.reading) {
      this.setData({ reading: false, showScore: true });
      util.toast('读得真棒，请家长打分');
    } else {
      this.setData({ reading: true, showScore: false });
      util.toast('🎤 跟着大声读出来吧');
    }
  },
  scoreRead(e) {
    const n = Number(e.currentTarget.dataset.n);
    this.addStar();
    util.toast(n >= 2 ? '🎉 读得真好听！' : '(´・ω・`) 再读一次试试');
    this.setData({ showScore: false });
  },
  nextRead() {
    this.setData({ readI: (this.data.readI + 1) % this.data.readList.length, showScore: false, reading: false });
  },

  /* ---------- 完成今日练习 ---------- */
  finishToday() {
    const d = store.get();
    const gain = engine.checkin(d, 'english');
    if (!gain) util.toast('今天已经完成啦');
    else util.toast('🎉 完成英语练习，获得阳光+种子！', 'success');
  }
});

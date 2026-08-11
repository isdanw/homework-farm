/**
 * 拼音汉字模块
 *  · 认知卡片：声母/韵母大字 + 图 + 听音（音频暂以视觉反馈占位，需自备录音文件）
 *  · 拼读练习：声母+韵母 → 选正确音节
 *  · 汉字描红：canvas 自由描画（覆盖虚线引导字），简化版不校验覆盖度
 *  · 完成今日练习 → engine.checkin('chinese') 联动农场奖励
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const util = require('../../utils/util.js');
const LD = require('../../utils/learnData.js');
const tts = require('../../utils/tts.js');

Page({
  data: {
    tab: 0,
    stars: 0,
    // 认知卡片
    pyList: LD.PINYIN, pyI: 0, pyBig: '', pyEx: '', pyWord: '', pyZh: '',
    // 拼读
    blendList: LD.BLEND, blendI: 0, blendA: '', blendB: '', blendR: '', blendEx: '', blendOpts: [],
    // 描红
    traceList: LD.TRACE, traceI: 0
  },

  onLoad() {
    this.setData({ stars: (store.get().learn || {}).stars || 0 });
    this.renderPy();
    this.buildBlend();
  },
  onReady() { this.initTrace(); },
  onUnload() { tts.stop(); },

  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.i }); },

  /* ---------- 奖励：小星星 ---------- */
  addStar() {
    const d = store.get();
    if (!d.learn) d.learn = { stars: 0 };
    d.learn.stars += 1;
    store.save(d);
    this.setData({ stars: d.learn.stars });
  },

  /* ---------- 认知卡片 ---------- */
  renderPy() {
    const p = this.data.pyList[this.data.pyI];
    // 从 w（如 'b — 香蕉 banana'）中解析出中文示例词 '香蕉'，用于朗读
    const zh = (p.w.split(' — ')[1] || '').split(' ')[0] || p.c;
    this.setData({ pyBig: p.c, pyEx: p.e, pyWord: p.w, pyZh: zh });
  },
  pyNext() { this.setData({ pyI: (this.data.pyI + 1) % this.data.pyList.length }); this.renderPy(); },
  pyPrev() { const n = this.data.pyList.length; this.setData({ pyI: (this.data.pyI - 1 + n) % n }); this.renderPy(); },
  // 朗读拼音对应的中文示例词（如 '香蕉'），听标准发音
  playPy() { tts.speak(this.data.pyZh, 'zh_CN'); },

  /* ---------- 拼读练习 ---------- */
  buildBlend() {
    const cur = this.data.blendList[this.data.blendI];
    const pool = this.data.blendList.filter(x => x.r !== cur.r).map(x => x.r);
    const pick = [];
    while (pick.length < 2 && pool.length) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    const opts = [cur.r, ...pick];
    for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[opts[i], opts[j]] = [opts[j], opts[i]]; }
    this.setData({ blendA: cur.a, blendB: cur.b, blendR: cur.r, blendEx: cur.ex, blendOpts: opts.map(v => ({ v, cls: '' })) });
  },
  chooseBlend(e) {
    const v = e.currentTarget.dataset.v;
    const opts = this.data.blendOpts.map(o => ({ v: o.v, cls: '' }));
    const idx = opts.findIndex(o => o.v === v);
    if (v === this.data.blendR) { opts[idx].cls = 'right'; this.addStar(); util.toast('🎉 拼对啦！', 'success'); }
    else { opts[idx].cls = 'wrong'; util.toast('再试试～'); }
    this.setData({ blendOpts: opts });
    setTimeout(() => this.setData({ blendOpts: this.data.blendOpts.map(o => ({ v: o.v, cls: '' })) }), 650);
  },
  nextBlend() { this.setData({ blendI: (this.data.blendI + 1) % this.data.blendList.length }); this.buildBlend(); },
  // 朗读拼读音节对应的中文示例词（如 '爸爸'），帮助建立拼读语感
  playBlend() { tts.speak(this.data.blendEx, 'zh_CN'); },

  /* ---------- 汉字描红（canvas 自由描画） ---------- */
  initTrace() {
    const sys = wx.getSystemInfoSync();
    this.cw = sys.windowWidth * 620 / 750;
    this.ch = sys.windowWidth * 380 / 750;
    this.ctx = wx.createCanvasContext('trace', this);
    this.drawGuide();
  },
  drawGuide() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cw, this.ch);
    ctx.setFillStyle('rgba(43,176,240,0.16)');
    ctx.setFontSize(this.ch * 0.7);
    ctx.setTextAlign('center');
    ctx.setTextBaseline('middle');
    ctx.fillText(this.data.traceList[this.data.traceI], this.cw / 2, this.ch / 2);
    ctx.draw(false);
  },
  traceStart(e) { const t = e.touches[0]; this.lastX = t.x; this.lastY = t.y; },
  traceMove(e) {
    const t = e.touches[0];
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(this.lastX, this.lastY);
    ctx.lineTo(t.x, t.y);
    ctx.setStrokeStyle('#43C95A');
    ctx.setLineWidth(10);
    ctx.setLineCap('round');
    ctx.stroke();
    ctx.draw(true);
    this.lastX = t.x; this.lastY = t.y;
  },
  finishTrace() {
    this.addStar();
    util.toast('✏️ 描得真棒！', 'success');
    this.setData({ traceI: (this.data.traceI + 1) % this.data.traceList.length });
    this.drawGuide();
  },
  // 朗读当前描红汉字（如 '一'），听标准读音后再描
  playTrace() { tts.speak(this.data.traceList[this.data.traceI], 'zh_CN'); },

  /* ---------- 完成今日练习 → 联动农场 ---------- */
  finishToday() {
    const d = store.get();
    const gain = engine.checkin(d, 'chinese');
    if (!gain) util.toast('今天已经完成啦');
    else util.toast('🎉 完成拼音练习，获得阳光+种子！', 'success');
  }
});

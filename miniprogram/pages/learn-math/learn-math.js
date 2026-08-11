/**
 * 数学乐园模块
 *  · 20以内加减法：随机出题 + 三选项
 *  · 逻辑训练：ABAB 规律，选下一个
 *  · 几何图形认知：6 种基础图形点选（发声占位）
 *  · 完成今日练习 → engine.checkin('math') 联动农场奖励
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const util = require('../../utils/util.js');
const LD = require('../../utils/learnData.js');

// 逻辑训练：预设几组 ABAB 规律
const LOGIC = [
  { seq: ['🔴', '⭐', '🔴', '⭐', '🔴'], ans: '⭐', opts: ['⭐', '🔵', '🔴'] },
  { seq: ['🟦', '🟥', '🟦', '🟥', '🟦'], ans: '🟥', opts: ['🟥', '🟦', '⭐'] },
  { seq: ['🐱', '🐶', '🐱', '🐶', '🐱'], ans: '🐶', opts: ['🐶', '🐱', '🦁'] },
  { seq: ['1️⃣', '2️⃣', '1️⃣', '2️⃣', '1️⃣'], ans: '2️⃣', opts: ['2️⃣', '1️⃣', '3️⃣'] },
  { seq: ['🔺', '🔵', '🔺', '🔵', '🔺'], ans: '🔵', opts: ['🔵', '🔺', '⭐'] },
  { seq: ['🌞', '🌙', '🌞', '🌙', '🌞'], ans: '🌙', opts: ['🌙', '🌞', '⭐'] }
];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

Page({
  data: {
    tab: 0, stars: 0,
    qText: '', qAns: 0, qOpts: [],
    logicList: LOGIC, logicI: 0, logicSeq: '', logicAns: '', logicOpts: [],
    shapes: LD.SHAPES
  },

  onLoad() {
    this.setData({ stars: (store.get().learn || {}).stars || 0 });
    this.genMath();
    this.buildLogic();
  },
  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.i }); },

  addStar() {
    const d = store.get();
    if (!d.learn) d.learn = { stars: 0 };
    d.learn.stars += 1; store.save(d);
    this.setData({ stars: d.learn.stars });
  },

  /* ---------- 20以内加减法 ---------- */
  genMath() {
    const a = Math.floor(Math.random() * 20);
    const b = Math.floor(Math.random() * 20);
    let text, ans;
    if (Math.random() < 0.5) { ans = a + b; text = `${a} + ${b} = ?`; }
    else { const big = Math.max(a, b), small = Math.min(a, b); ans = big - small; text = `${big} - ${small} = ?`; }
    const opts = [ans];
    while (opts.length < 3) {
      const d = ans + (Math.floor(Math.random() * 5) + 1) * (Math.random() < 0.5 ? -1 : 1);
      if (d >= 0 && d !== ans && opts.indexOf(d) < 0) opts.push(d);
    }
    this.setData({ qText: text, qAns: ans, qOpts: shuffle(opts).map(v => ({ v, cls: '' })) });
  },
  chooseMath(e) {
    const v = Number(e.currentTarget.dataset.v);
    const opts = this.data.qOpts.map(o => ({ v: o.v, cls: '' }));
    const idx = opts.findIndex(o => o.v === v);
    if (v === this.data.qAns) { opts[idx].cls = 'right'; this.addStar(); util.toast('🎉 答对啦！', 'success'); }
    else { opts[idx].cls = 'wrong'; util.toast('再想想～'); }
    this.setData({ qOpts: opts });
    setTimeout(() => this.setData({ qOpts: this.data.qOpts.map(o => ({ v: o.v, cls: '' })) }), 650);
  },

  /* ---------- 逻辑训练 ---------- */
  buildLogic() {
    const cur = this.data.logicList[this.data.logicI];
    this.setData({ logicSeq: cur.seq.join('  '), logicAns: cur.ans, logicOpts: shuffle(cur.opts.slice()).map(v => ({ v, cls: '' })) });
  },
  chooseLogic(e) {
    const v = e.currentTarget.dataset.v;
    const opts = this.data.logicOpts.map(o => ({ v: o.v, cls: '' }));
    const idx = opts.findIndex(o => o.v === v);
    if (v === this.data.logicAns) { opts[idx].cls = 'right'; this.addStar(); util.toast('🎉 找对规律！', 'success'); }
    else { opts[idx].cls = 'wrong'; util.toast('看看前面是怎么排的？'); }
    this.setData({ logicOpts: opts });
    setTimeout(() => this.setData({ logicOpts: this.data.logicOpts.map(o => ({ v: o.v, cls: '' })) }), 650);
  },
  nextLogic() { this.setData({ logicI: (this.data.logicI + 1) % this.data.logicList.length }); this.buildLogic(); },

  /* ---------- 图形认知 ---------- */
  tapShape(e) { util.toast('这是' + e.currentTarget.dataset.nm); },

  /* ---------- 完成今日练习 ---------- */
  finishToday() {
    const d = store.get();
    const gain = engine.checkin(d, 'math');
    if (!gain) util.toast('今天已经完成啦');
    else util.toast('🎉 完成数学练习，获得阳光+种子！', 'success');
  }
});

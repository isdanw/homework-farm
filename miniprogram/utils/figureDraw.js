/**
 * figureDraw.js —— 题图（结构化 figure）的小程序端绘制
 *
 * 契约与云端 examService.normFigure、iPad FigureRenderer 严格同构：
 *   figure = { w: 画布宽, h: 画布高, items: [图元...] }
 *   坐标系原点左上、y 轴向下；图元只有 line / poly / circle / text 四种。
 *
 * 样式（颜色/线宽/字号）由端上决定，云端只给几何 —— 因此同一份 figure
 * 在小程序和 iPad 上观感一致，且永远不加载外部图片。
 */

const INK = '#1f2937';
const SHADE = 'rgba(37, 99, 235, 0.12)';
const LINE_W = 1.2;
const FONT = '13px sans-serif';

function num(v, dflt) {
  const n = Number(v);
  return isFinite(n) ? n : dflt;
}

/** 按题图宽高比算显示高度（rpx）：避免细高图把版式撑开、长条图缩成一条缝 */
function boxHeight(fig, baseRpx) {
  if (!fig) return 0;
  const w = num(fig.w, 160) > 0 ? num(fig.w, 160) : 160;
  const h = num(fig.h, 120) > 0 ? num(fig.h, 120) : 120;
  const base = baseRpx || 640;
  return Math.max(110, Math.min(460, Math.round(base * h / w)));
}

/** 在已按 dpr 缩放过的 2d context 上绘制（width/height 是 CSS 像素尺寸） */
function draw(ctx, fig, width, height) {
  if (!ctx || !fig || !Array.isArray(fig.items) || !fig.items.length) return;
  if (!(width > 0) || !(height > 0)) return;
  const w = num(fig.w, 160) > 0 ? num(fig.w, 160) : 160;
  const h = num(fig.h, 120) > 0 ? num(fig.h, 120) : 120;
  const s = Math.min(width / w, height / h);
  if (!(s > 0)) return;
  const ox = (width - w * s) / 2;
  const oy = (height - h * s) / 2;
  const X = function (v) { return ox + num(v, 0) * s; };
  const Y = function (v) { return oy + num(v, 0) * s; };

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = LINE_W;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;

  fig.items.forEach(function (it) {
    if (!it || !it.k) return;
    if (ctx.setLineDash) ctx.setLineDash(it.dash ? [4, 3] : []);
    if (it.k === 'line') {
      ctx.beginPath();
      ctx.moveTo(X(it.x1), Y(it.y1));
      ctx.lineTo(X(it.x2), Y(it.y2));
      ctx.stroke();
    } else if (it.k === 'poly') {
      const pts = Array.isArray(it.pts) ? it.pts : [];
      if (pts.length < 2) return;
      ctx.beginPath();
      pts.forEach(function (p, i) {
        const px = Array.isArray(p) ? X(p[0]) : X(p && p.x);
        const py = Array.isArray(p) ? Y(p[1]) : Y(p && p.y);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      if (it.closed !== false) ctx.closePath();
      if (it.fill) { ctx.fillStyle = SHADE; ctx.fill(); }
      ctx.stroke();
    } else if (it.k === 'circle') {
      const r = num(it.r, 0) * s;
      if (!(r > 0)) return;
      ctx.beginPath();
      ctx.arc(X(it.cx), Y(it.cy), r, 0, Math.PI * 2);
      if (it.fill) { ctx.fillStyle = SHADE; ctx.fill(); }
      ctx.stroke();
    } else if (it.k === 'text') {
      const t = String(it.t == null ? '' : it.t);
      if (!t) return;
      ctx.save();
      if (ctx.setLineDash) ctx.setLineDash([]);
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 白色描边（halo）：AI 常把标注放在边框上，加了白边才读得清
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(t, X(it.x), Y(it.y));
      ctx.fillStyle = INK;
      ctx.fillText(t, X(it.x), Y(it.y));
      ctx.restore();
    }
  });
  if (ctx.setLineDash) ctx.setLineDash([]);
}

/**
 * 把页面里的题图 canvas（<canvas type="2d">）逐个画出来。
 * page 上按 selector 取到的 canvas 顺序必须与 figs 一一对应（都是按题目顺序渲染）。
 */
function paint(page, selector, figs) {
  const list = Array.isArray(figs) ? figs : [];
  if (!page || !list.length) return;
  setTimeout(function () {
    wx.createSelectorQuery().in(page).selectAll(selector)
      .fields({ node: true, size: true })
      .exec(function (res) {
        const boxes = (res && res[0]) || [];
        boxes.forEach(function (box, i) {
          const node = box && box.node;
          const fig = list[i];
          if (!node || !fig || !Array.isArray(fig.items) || !fig.items.length) return;
          if (!(box.width > 0) || !(box.height > 0)) return;
          let dpr = 2;
          try {
            const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
            dpr = (info && info.pixelRatio) || 2;
          } catch (e) { dpr = 2; }
          node.width = box.width * dpr;
          node.height = box.height * dpr;
          const ctx = node.getContext('2d');
          if (!ctx) return;
          ctx.scale(dpr, dpr);
          draw(ctx, fig, box.width, box.height);
        });
      });
  }, 80);
}

module.exports = { draw: draw, paint: paint, boxHeight: boxHeight };

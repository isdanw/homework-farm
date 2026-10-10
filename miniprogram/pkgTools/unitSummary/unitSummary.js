/**
 * 单元总结页（成长计划阶段 → 一键生成「整理与复习」知识树）
 *  · 数据：计划阶段(名称/目标/任务完成情况) + 本学科错题库 + 日常打卡记录
 *  · AI：tutorChat action='unitSummary' → { summary, advice[], branches[] }
 *  · 图片：Canvas 2D 绘制仿黑板知识树（深绿板面 + 木框 + 四色粉笔分支），可保存相册
 *  · 降级：AI 失败时用任务清单本地拼一份保底结构，知识树照样能画
 */
const store = require('../../utils/store.js');
const util = require('../../utils/util.js');
const studyPlan = require('../../utils/studyPlan.js');
const tutorStore = require('../../utils/tutorStore.js');

/* 四色粉笔（与云函数约定一致；AI 未指定时按下标循环） */
const CHALK_KEYS = ['yellow', 'pink', 'blue', 'green'];
const CHALK = {
  yellow: '#F7E36B',
  pink: '#F8A8B8',
  blue: '#9CD6F5',
  green: '#A8E090'
};
const BOARD_W = 750;
const BOARD_H = 1280;

Page({
  data: {
    typeKey: '', si: -1,
    unitName: '', unitGoal: '',
    stageDone: false, doneCount: 0, taskCount: 0,
    loading: true, failed: false, failMsg: '',
    summary: '', advice: [], branches: [],
    saving: false
  },

  onLoad(options) {
    this.setData({
      typeKey: (options && options.typeKey) || '',
      si: options && options.si != null ? Number(options.si) : -1
    });
    this._stage = null;
    if (!this.data.typeKey || this.data.si < 0) {
      util.toast('缺少单元信息');
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const plan = studyPlan.getPlan(this.data.typeKey);
    const stage = plan && plan.stages && plan.stages[this.data.si];
    if (!stage) {
      util.toast('未找到该单元');
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this._stage = stage;
    this.setData({
      unitName: stage.name || '',
      unitGoal: stage.goal || '',
      taskCount: (stage.tasks || []).length,
      doneCount: (stage.tasks || []).filter(t => t.done).length,
      stageDone: (stage.tasks || []).length > 0 && (stage.tasks || []).every(t => t.done)
    });
    this.generate();
  },

  /* ---------------- 数据聚合 ---------------- */

  /** 本学科错题（最近的在前，取 topic + errorType，上限 15 条） */
  gatherMistakes() {
    try {
      return (tutorStore.getMistakes() || [])
        .filter(m => m.subject === this.data.typeKey)
        .slice(0, 15)
        .map(m => ({ topic: m.topic || '', errorType: m.errorType || '' }));
    } catch (e) { return []; }
  },

  /** 本学科打卡记录摘选（按日期倒序，非空 note，上限 12 条） */
  gatherNotes() {
    try {
      const d = store.get();
      const hw = d.homework || {};
      const dates = Object.keys(hw).sort().reverse();
      const notes = [];
      dates.forEach(date => {
        const rec = hw[date] && hw[date][this.data.typeKey];
        const note = rec && rec.note && rec.note.trim();
        if (note) notes.push(note);
      });
      return notes.slice(0, 12);
    } catch (e) { return []; }
  },

  /* ---------------- 生成 ---------------- */

  generate() {
    if (!wx.cloud || !wx.cloud.callFunction) {
      this.applyResult(this.fallbackResult(), '云服务未就绪，已用本地内容生成');
      return;
    }
    const stage = this._stage || {};
    wx.cloud.callFunction({
      name: 'tutorChat',
      data: {
        action: 'unitSummary',
        subject: this.data.typeKey,
        subjectName: (store.getType(this.data.typeKey) || {}).name || '',
        unitName: this.data.unitName,
        unitGoal: this.data.unitGoal || '',
        learner: { grade: store.resolveGrade() },
        tasks: (stage.tasks || []).map(t => ({ name: t.name || '', done: !!t.done, checkinDays: t.checkinDays || 0 })),
        mistakes: this.gatherMistakes(),
        notes: this.gatherNotes()
      }
    }).then(res => {
      const r = res && res.result;
      if (r && r.ok && r.data) {
        this.applyResult(r.data, '');
      } else {
        this.applyResult(this.fallbackResult(), (r && r.msg) || 'AI 生成失败，已用本地内容生成');
      }
    }).catch(err => {
      console.warn('[unitSummary] 生成失败', err);
      this.applyResult(this.fallbackResult(), 'AI 暂不可用，已用本地内容生成');
    });
  },

  regenerate() {
    if (this.data.loading) return;
    this.setData({ loading: true, failed: false, failMsg: '' });
    this.generate();
  },

  /** AI 结果 → 页面数据 + 画树 */
  applyResult(data, failMsg) {
    const branches = (data.branches || []).map((b, i) => ({
      title: b.title || '',
      points: (b.points || []).slice(0, 4),
      colorKey: CHALK_KEYS.indexOf(b.color) >= 0 ? b.color : CHALK_KEYS[i % 4],
      color: CHALK[CHALK_KEYS.indexOf(b.color) >= 0 ? b.color : CHALK_KEYS[i % 4]]
    }));
    this.setData({
      loading: false,
      failed: !!failMsg,
      failMsg: failMsg || '',
      summary: data.summary || '',
      advice: data.advice || [],
      branches: branches
    }, () => this.drawTree());
  },

  /** 本地保底：任务名当分支标题（无要点），summary 用统计拼一句 */
  fallbackResult() {
    const stage = this._stage || {};
    const tasks = (stage.tasks || []);
    const doneN = tasks.filter(t => t.done).length;
    const mistakes = this.gatherMistakes();
    const branches = tasks.slice(0, 8).map((t, i) => ({
      title: clip(t.name || ('任务' + (i + 1)), 6),
      points: [t.done
        ? ('已完成' + (t.checkinDays ? '，用时' + t.checkinDays + '天' : ''))
        : '待完成'],
      colorKey: CHALK_KEYS[i % 4],
      color: CHALK[CHALK_KEYS[i % 4]]
    }));
    if (!branches.length && this.data.unitName) {
      branches.push({ title: clip(this.data.unitName, 6), points: [], colorKey: 'yellow', color: CHALK.yellow });
    }
    let summary = '本单元共 ' + tasks.length + ' 个任务，已完成 ' + doneN + ' 个。';
    if (mistakes.length) summary += '期间收集了 ' + mistakes.length + ' 条相关错题，建议回错题本复习订正。';
    else summary += '继续加油，完成任务后可以补充打卡记录，总结会更丰富。';
    return {
      summary: summary,
      advice: ['把未完成的任务补完', '回错题本重做本单元错题', '下次打卡时写一句当天收获'],
      branches: branches
    };
  },

  /* ---------------- 仿黑板知识树（Canvas 2D） ---------------- */

  drawTree() {
    const query = wx.createSelectorQuery().in(this);
    query.select('#board').fields({ node: true, size: true }).exec(res => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      let dpr = 2;
      try { dpr = Math.min((wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2, 2); } catch (e) {}
      canvas.width = BOARD_W * dpr;
      canvas.height = BOARD_H * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      this._canvas = canvas;
      this._paint(ctx, BOARD_W, BOARD_H);
    });
  },

  _paint(ctx, W, H) {
    /* 板面 + 木框 */
    ctx.fillStyle = '#2E5C4D';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#8A6642';
    ctx.lineWidth = 18;
    ctx.strokeRect(9, 9, W - 18, H - 18);
    ctx.strokeStyle = '#A5825B';
    ctx.lineWidth = 4;
    ctx.strokeRect(24, 24, W - 48, H - 48);

    ctx.textAlign = 'center';
    /* 顶部小标题 */
    ctx.fillStyle = '#F7E36B';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('整 理 与 复 习', W / 2, 82);
    /* 单元名（自动换行，最多 2 行） */
    ctx.fillStyle = '#FDF6E3';
    ctx.font = 'bold 44px sans-serif';
    const nameLines = wrapText(this.data.unitName || '', 14).slice(0, 2);
    nameLines.forEach((ln, i) => ctx.fillText(ln, W / 2, 140 + i * 56));
    const topY = 170 + nameLines.length * 56;

    /* 分支 → 气泡盒（左右两列，按高度贪心分配） */
    const branches = this.data.branches || [];
    const bw = 300;
    const boxH = b => 62 + (b.points ? b.points.length : 0) * 34 + 12;
    const colL = [], colR = [];
    let hL = 0, hR = 0;
    branches.forEach(b => {
      const h = boxH(b);
      if (hL <= hR) { colL.push(b); hL += h + 18; }
      else { colR.push(b); hR += h + 18; }
    });
    const areaTop = topY + 16;
    const areaBottom = H - 190;   // 给树干留空间
    const startY = (col) => {
      const total = col.reduce((s, b) => s + boxH(b) + 18, 0) - 18;
      return Math.max(areaTop, areaTop + Math.max(0, (areaBottom - areaTop - total) / 2) - 20);
    };

    const layoutCol = (col, x) => {
      const boxes = [];
      let y = startY(col);
      col.forEach(b => {
        const h = boxH(b);
        boxes.push({ b: b, x: x, y: y, w: bw, h: h });
        y += h + 18;
      });
      return boxes;
    };
    const boxesL = layoutCol(colL, 34);
    const boxesR = layoutCol(colR, W - 34 - bw);

    /* 树干（先画，连接线压在树干上） */
    const trunkTop = Math.min(
      Math.max(bottomOf(boxesL), bottomOf(boxesR), topY + 120),
      H - 150
    );
    const trunkBaseY = H - 64;
    ctx.fillStyle = '#C9A86B';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 16, trunkBaseY);
    ctx.quadraticCurveTo(W / 2 - 10, trunkTop + 120, W / 2 - 6, trunkTop);
    ctx.lineTo(W / 2 + 6, trunkTop);
    ctx.quadraticCurveTo(W / 2 + 10, trunkTop + 120, W / 2 + 16, trunkBaseY);
    ctx.closePath();
    ctx.fill();

    /* 连接线：气泡内侧 → 树干顶 */
    const link = (box, side) => {
      const sx = side === 'L' ? box.x + box.w : box.x;
      const sy = box.y + box.h / 2;
      const tx = W / 2 + (side === 'L' ? -8 : 8);
      const ty = trunkTop + 14;
      ctx.strokeStyle = '#C9A86B';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo((sx + tx) / 2 + (side === 'L' ? -40 : 40), (sy + ty) / 2, tx, ty);
      ctx.stroke();
    };
    boxesL.forEach(b => link(b, 'L'));
    boxesR.forEach(b => link(b, 'R'));

    /* 气泡：虚线粉笔框 + 彩色标题 + 白粉笔要点 */
    ctx.textAlign = 'left';
    const all = boxesL.concat(boxesR);
    all.forEach(box => {
      const b = box.b;
      ctx.save();
      ctx.setLineDash([9, 7]);
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 3;
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      roundRect(ctx, box.x, box.y, box.w, box.h, 24);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = b.color;
      ctx.font = 'bold 27px sans-serif';
      ctx.fillText(b.title, box.x + 20, box.y + 40);
      ctx.fillStyle = '#E8F0E4';
      ctx.font = '21px sans-serif';
      (b.points || []).forEach((p, i) => {
        ctx.fillText('· ' + p, box.x + 22, box.y + 72 + i * 34);
      });
    });

    /* 右下角落款 */
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(253,246,227,0.55)';
    ctx.font = '20px sans-serif';
    ctx.fillText((this.data.doneCount || 0) + '/' + (this.data.taskCount || 0) + ' 任务', W - 40, H - 44);
  },

  /* ---------------- 保存到相册 ---------------- */

  saveImg() {
    if (this.data.saving || !this._canvas) return;
    this.setData({ saving: true });
    wx.canvasToTempFilePath({
      canvas: this._canvas,
      success: (r) => {
        wx.saveImageToPhotosAlbum({
          filePath: r.tempFilePath,
          success: () => {
            this.setData({ saving: false });
            util.toast('已保存到相册', 'success');
          },
          fail: (e) => {
            this.setData({ saving: false });
            const msg = (e && e.errMsg) || '';
            if (/auth|deny/i.test(msg)) {
              wx.showModal({
                title: '需要相册权限',
                content: '请在设置中允许「保存到相册」后重试。',
                confirmText: '去设置',
                success: (r2) => { if (r2.confirm) wx.openSetting(); }
              });
            } else {
              util.toast('保存失败，请重试');
            }
          }
        });
      },
      fail: () => {
        this.setData({ saving: false });
        util.toast('生成图片失败，请重试');
      }
    });
  }
});

/* ---------- 工具 ---------- */
function clip(s, n) {
  const str = String(s == null ? '' : s).trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function bottomOf(boxes) {
  return boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0);
}

/** 按字符数换行（中文 44px 字号，14 字 ≈ 616px < 画布可用宽度；单元名最多取 2 行） */
function wrapText(text, maxChars) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return [''];
  const lines = [];
  let cur = '';
  for (const ch of s) {
    if (cur.length >= maxChars) {
      lines.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [s];
}

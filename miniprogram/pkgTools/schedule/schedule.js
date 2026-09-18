/**
 * 课程表页
 *  · 一学期一张固定课表（小学阶段不做单双周）
 *  · 两种录入方式：
 *      ① 拍照 / 相册 → AI 视觉识别自动填表（识别失败自动降级：保留照片，手动填写）
 *      ② 手动点选：点格子 → 底部抽屉输入或选常见科目
 *  · 录入后自动「识别课表对应的打卡内容」：
 *      - 能匹配上现有打卡类型的科目 → 标记已关联
 *      - 匹配不上的（体育 / 音乐 等）→ 一键添加为新的打卡类型
 */
const store = require('../../utils/store.js');
const sched = require('../../utils/scheduleEngine.js');
const util = require('../../utils/util.js');
const CFG = require('../../utils/config.js');

/** 常见科目（抽屉里点一下即可填入，降低输入成本） */
const COMMON = [
  '语文', '数学', '英语', '体育', '音乐', '美术',
  '科学', '道法', '信息技术', '劳动', '综合实践', '写字', '阅读', '自习', '班会'
];

/*
 * 课表格子配色：柔和浅底 + 深色文字，保证 WCAG AA 对比度（≥4.5:1）。
 * 语数英固定色，其余科目（自定义 / 未匹配）按名称稳定 hash 取扩展池颜色，
 * 保证同一科目每次打开颜色一致，课表一眼可读。
 */
const CELL_COLORS = {
  chinese: { bg: '#FFE9F0', fg: '#D6457A' },   // 粉
  math:    { bg: '#E3F2FF', fg: '#2E86DE' },   // 蓝
  english: { bg: '#E7F6E8', fg: '#3E9B4F' }    // 绿
};
const CELL_EXTRA = [
  { bg: '#FFF3E0', fg: '#E08A1E' },   // 橙
  { bg: '#F1EEF8', fg: '#6E63A8' },   // 紫
  { bg: '#E0F7F4', fg: '#1BA39C' },   // 青
  { bg: '#FDE7F1', fg: '#C2508A' },   // 玫红
  { bg: '#EAF2FF', fg: '#4A6FD0' }    // 靛蓝
];

/** 科目名（已归一化）→ 格子配色 */
function colorOf(normName) {
  const key = sched.matchType(normName);
  if (key && CELL_COLORS[key]) return CELL_COLORS[key];
  const h = parseInt(sched.hashName(normName), 36) || 0;
  return CELL_EXTRA[h % CELL_EXTRA.length];
}

Page({
  data: {
    termName: '',
    photoPath: '',
    rows: [],
    cols: [],
    gridStyle: '',
    rowCount: 8,
    colCount: 5,
    cellCount: 0,

    analysis: { matched: [], unmatched: [], total: 0, coverage: 0 },

    /* 单格编辑抽屉 */
    showCell: false,
    editing: { r: 0, c: 0, period: 1, dayLabel: '' },
    cellName: '',
    common: COMMON,

    recognizing: false
  },

  onShow() { this.render(); },

  render() {
    const sch = sched.getSchedule();
    const S = CFG.SCHEDULE;

    const cols = [];
    for (let c = 0; c < sch.cols; c++) {
      cols.push({ idx: c, label: S.DAY_LABELS[c] || ('周' + (c + 1)) });
    }

    let cellCount = 0;
    const rows = [];
    for (let r = 0; r < sch.rows; r++) {
      const cells = [];
      for (let c = 0; c < sch.cols; c++) {
        const name = sched.getCell(sch, r, c);
        if (name) cellCount++;
        // 有内容的格子：科目配色底 + 深色字（空格式 style 留空，走虚线占位样式）
        const cc = name ? colorOf(sched.normalizeName(name)) : null;
        cells.push({
          row: r, col: c, key: `${r}-${c}`, name: name, has: !!name,
          style: cc ? `background:${cc.bg};color:${cc.fg};border-color:${cc.bg};` : ''
        });
      }
      rows.push({ idx: r, period: r + 1, time: sch.slotTimes[r] || '', cells: cells });
    }

    const ana = sched.analyzeTypes(sch);
    const matched = ana.matched.map(m => {
      const cc = colorOf(sched.normalizeName(m.name));
      return Object.assign({}, m, { bg: cc.bg, fg: cc.fg });
    });
    const unmatched = ana.unmatched.map(u => {
      const cc = colorOf(sched.normalizeName(u.name));
      return Object.assign({}, u, { bg: cc.bg, fg: cc.fg });
    });

    this.setData({
      termName: sch.termName || '',
      photoPath: sch.photoPath || '',
      rows: rows,
      cols: cols,
      rowCount: sch.rows,
      colCount: sch.cols,
      cellCount: cellCount,
      // 第一列节次 84rpx，课程格最小 136rpx；列多时外层横向滚动
      gridStyle: `84rpx repeat(${sch.cols}, minmax(136rpx, 1fr))`,
      analysis: { matched: matched, unmatched: unmatched, total: ana.total, coverage: ana.coverage }
    });
  },

  /* ======================= 学期名 ======================= */
  onTermName(e) { this.setData({ termName: e.detail.value }); },

  saveTermName() {
    const sch = sched.getSchedule();
    sch.termName = (this.data.termName || '').trim();
    sched.saveSchedule(sch);
    util.toast('已保存', 'success');
  },

  /* ======================= 行列调整 ======================= */
  changeRows(e) {
    const delta = Number(e.currentTarget.dataset.d) || 0;
    const sch = sched.getSchedule();
    const next = sched.clamp(sch.rows + delta, 1, CFG.SCHEDULE.MAX_ROWS);
    if (next === sch.rows) return;
    sch.rows = next;
    // 行数变多时补齐时间列
    while (sch.slotTimes.length < next) {
      const idx = sch.slotTimes.length;
      sch.slotTimes.push(CFG.SCHEDULE.SLOT_TIMES[idx] || '');
    }
    sched.saveSchedule(sch);
    this.render();
  },

  changeCols(e) {
    const delta = Number(e.currentTarget.dataset.d) || 0;
    const sch = sched.getSchedule();
    const next = sched.clamp(sch.cols + delta, 1, CFG.SCHEDULE.MAX_COLS);
    if (next === sch.cols) return;
    sch.cols = next;
    sched.saveSchedule(sch);
    this.render();
  },

  /* ======================= 单格编辑 ======================= */
  editCell(e) {
    const r = Number(e.currentTarget.dataset.r);
    const c = Number(e.currentTarget.dataset.c);
    const sch = sched.getSchedule();
    this.setData({
      showCell: true,
      editing: {
        r: r, c: c,
        period: r + 1,
        dayLabel: (CFG.SCHEDULE.DAY_LABELS[c] || ('周' + (c + 1)))
      },
      cellName: sched.getCell(sch, r, c)
    });
  },

  closeCell() { this.setData({ showCell: false }); },
  noop() {},

  onCellName(e) {
    const v = e.detail.value;
    this.setData({ cellName: v });
  },

  pickSubject(e) {
    this.setData({ cellName: e.currentTarget.dataset.s || '' });
  },

  confirmCell() {
    const ed = this.data.editing;
    const sch = sched.getSchedule();
    sched.setCell(sch, ed.r, ed.c, this.data.cellName);
    sched.saveSchedule(sch);
    this.setData({ showCell: false });
    this.render();
    util.toast('已保存', 'success');
  },

  clearCell() {
    const ed = this.data.editing;
    const sch = sched.getSchedule();
    sched.setCell(sch, ed.r, ed.c, '');
    sched.saveSchedule(sch);
    this.setData({ showCell: false, cellName: '' });
    this.render();
  },

  /* ======================= 拍照识别 ======================= */
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: (res) => {
        const temp = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
        if (!temp) return;
        // 存成本地永久文件，便于之后对照核对（不会被临时目录回收）
        let dest = temp;
        try {
          const fs = wx.getFileSystemManager();
          dest = `${wx.env.USER_DATA_PATH}/schedule_${Date.now()}.png`;
          fs.copyFileSync(temp, dest);
        } catch (e) {
          console.warn('[schedule] 图片转存失败，沿用临时路径', e);
          dest = temp;
        }
        this.deletePhotoFile(this.data.photoPath);   // 旧照片同步清理，避免文件堆积
        this.setData({ photoPath: dest });
        this.recognize(dest);
      }
    });
  },

  /** 删除课表照片文件（仅清理 USER_DATA_PATH 下的永久文件，临时文件交给系统回收） */
  deletePhotoFile(path) {
    if (!path || String(path).indexOf(wx.env.USER_DATA_PATH) !== 0) return;
    try { wx.getFileSystemManager().unlinkSync(path); } catch (e) {}
  },

  /**
   * 调用 ocrSchedule 云函数识别课表
   * 任何失败都走降级：照片保留下来，提示家长对照照片手动填写
   */
  recognize(path) {
    if (this.data.recognizing) return;
    if (!wx.cloud || !wx.cloud.callFunction) {
      this.keepPhoto(path);
      return wx.showModal({
        title: '自动识别不可用',
        content: '云函数未就绪，已保存照片，请对照照片手动填写课表。',
        showCancel: false, confirmText: '好的'
      });
    }

    wx.showLoading({ title: '识别中…', mask: true });
    this.setData({ recognizing: true });

    let b64 = '';
    try {
      const fs = wx.getFileSystemManager();
      b64 = fs.readFileSync(path, 'base64');
    } catch (e) {
      wx.hideLoading();
      this.setData({ recognizing: false });
      this.keepPhoto(path);
      return util.toast('读取图片失败，请手动填写');
    }

    // 视觉识别模型配置已移至网页端（云端按 openid 存储，云函数直接读取），此处不再传本地配置
    wx.cloud.callFunction({
      name: 'ocrSchedule',
      data: { imageBase64: b64 }
    }).then(res => {
      wx.hideLoading();
      this.setData({ recognizing: false });
      const r = res && res.result;
      if (r && r.ok && Array.isArray(r.grid) && r.grid.length) {
        const sch = sched.applyGrid(sched.getSchedule(), r.grid);
        sch.photoPath = path;
        if (!sch.termName && r.termName) sch.termName = r.termName;
        sched.saveSchedule(sch);
        this.render();
        wx.showModal({
          title: '识别完成',
          content: `已识别 ${this.data.cellCount} 节课，请对照照片核对，不对的地方点格子修改。`,
          showCancel: false, confirmText: '去核对'
        });
      } else {
        this.keepPhoto(path);
        wx.showModal({
          title: '没能自动识别',
          content: (r && r.msg) || '照片已保存，请对照照片手动填写课表。',
          showCancel: false, confirmText: '手动填写'
        });
      }
    }).catch(err => {
      wx.hideLoading();
      console.warn('[schedule] 识别失败', err);
      this.setData({ recognizing: false });
      this.keepPhoto(path);
      wx.showModal({
        title: '没能自动识别',
        content: '照片已保存，请对照照片手动填写课表。',
        showCancel: false, confirmText: '手动填写'
      });
    });
  },

  /** 降级时也要把照片留下，方便对照填写 */
  keepPhoto(path) {
    const sch = sched.getSchedule();
    sch.photoPath = path;
    sched.saveSchedule(sch);
    this.render();
  },

  previewPhoto() {
    if (!this.data.photoPath) return;
    wx.previewImage({ urls: [this.data.photoPath], current: this.data.photoPath });
  },

  removePhoto() {
    this.deletePhotoFile(this.data.photoPath);
    const sch = sched.getSchedule();
    sch.photoPath = '';
    sched.saveSchedule(sch);
    this.render();
  },

  /* ======================= 打卡内容识别 ======================= */
  addMissing() {
    const res = sched.addMissingTypes(sched.getSchedule());
    if (!res.added) return util.toast('没有需要新增的科目');
    util.toast(`已添加 ${res.added} 个打卡类型`, 'success');
    this.render();
  },

  goTypeManage() { wx.navigateTo({ url: '/pkgTools/typeManage/typeManage' }); },

  /* ======================= 清空 ======================= */
  clearAll() {
    wx.showModal({
      title: '清空课表',
      content: '会清空当前孩子的整张课程表（打卡类型不受影响）。确定吗？',
      confirmColor: '#FF7A7A',
      success: (res) => {
        if (!res.confirm) return;
        this.deletePhotoFile(this.data.photoPath);
        sched.clearSchedule();
        this.render();
        util.toast('已清空');
      }
    });
  },

  goBack() { wx.navigateBack(); }
});

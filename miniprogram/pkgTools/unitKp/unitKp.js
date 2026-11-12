/**
 * 单元必会清单页（P3 编辑体验）
 *  · 展示当前学科的单元必会库（tutor_unit_kps，混合路线 canonical 清单）
 *  · 每个必会点标注状态：未覆盖 / 复习中 / 待复习 / 已通关（按 kpId 关联 tutor_cards）
 *  · 每个必会点另标「证据覆盖程度 L0–L6」（只读，来自 evidenceLadder）：这一层记录有没有，
 *    不是能力等级、不是掌握百分比，所以文案只用「做过 / 订正过 / 独立测过」的口气
 *  · 编辑：改 front/back（内联编辑）、删点、加点；改完自动登记上云（与看板互通）
 *  · 翻面自测：点「自测」对该点已生成的卡做翻面回想（记得/忘了推进 Leitner 盒子）
 *
 * ⚠️ 自测只推进记忆盒子，不写复测证据、不声称掌握（活动≠证据≠掌握）。
 * ⚠️ 删点只删清单条目；已挂该 kpId 的卡保留，只是不再计入单元统计。
 */
const tutorStore = require('../../utils/tutorStore.js');
const util = require('../../utils/util.js');
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const tutorSubjects = require('../../utils/tutorSubjects.js');
const workbenchKpImport = require('../../utils/workbenchKpImport.js');
const evidenceLadder = require('../../utils/evidenceLadder.js');
const config = require('../../utils/config.js');

Page({
  data: {
    subject: 'math',
    subjectName: '数学',
    unit: null,                 // 当前学科最新一份必会库 { id, title, grade, points }
    rows: [],                   // 渲染行（point + 状态 + 关联卡 + 证据覆盖档位）
    lvDist: [],                 // 证据覆盖 L0–L6 分布（只读，条数不含百分比）
    stats: { total: 0, carded: 0, done: 0, passRate: 0 },
    // 编辑态
    editingId: '',
    editFront: '',
    editBack: '',
    adding: false,
    newFront: '',
    newBack: '',
    // 翻面自测态（复用 cards 页翻面交互）
    study: { active: false, flipped: false, current: null },
    // 从工作台知识库导入态
    importing: false,
    importText: '',
    importPreview: null,        // { stats, warnings, units:[{title,subject,grade,count,topics}] }
    importUnits: [],            // 解析后的原始 unit 列表（确认时写入）
    importErr: ''
  },

  onLoad(options) {
    const unitId = String((options && options.unitId) || '').trim();
    let subject = String((options && options.subject) || '').trim() || 'math';
    // 带 unitId 时以该单元自身学科为准（Registry 的 unitId 是精确定位，学科只是兜底）
    if (unitId) {
      const u = tutorStore.getUnitKps(unitId);
      if (u && u.subject) subject = u.subject;
    }
    this._unitId = unitId;
    const sub = tutorSubjects.TUTOR_SUBJECTS.find(s => s.key === subject);
    this.setData({
      subject: subject,
      subjectName: sub ? sub.name : subject
    });
    wx.setNavigationBarTitle({ title: (sub ? sub.name : subject) + ' · 单元必会清单' });
  },

  onShow() { this.render(); },

  render() {
    const unit = this._unitId
      ? tutorStore.getUnitKps(this._unitId)
      : tutorStore.getUnitKpsBySubject(this.data.subject);
    const lvMap = this._ladderOf(unit);
    const rows = [];
    let carded = 0, done = 0;
    if (unit && Array.isArray(unit.points)) {
      const cards = tutorStore.getCards();
      const now = Date.now();
      unit.points.forEach(p => {
        // ⚠️ kpId 仅单元内唯一 → 关联卡必须同时匹配 unitId + kpId
        const cs = cards.filter(c => c.kpId === p.id && c.unitId === unit.id);
        const anyDone = cs.some(c => c.done);
        const anyDue = cs.some(c => !c.done && (c.dueAt || 0) <= now);
        if (cs.length) carded++;
        if (anyDone) done++;
        const c0 = cs[0] || null;
        const lv = lvMap[p.id] || null;
        rows.push({
          id: p.id,
          topic: p.topic || '',
          front: p.front || '',
          back: p.back || '',
          status: !cs.length ? 'uncovered' : (anyDone ? 'done' : (anyDue ? 'due' : 'learning')),
          box: c0 ? (c0.box || 1) : 0,
          cardId: c0 ? c0.id : '',
          // 证据覆盖档位（只读展示，不参与任何判定或写入）
          lv: lv ? lv.level : -1,
          lvText: lv ? 'L' + lv.level : '',
          lvLabel: lv ? lv.label : '',
          lvNext: lv ? lv.nextStep : '',
          lvLink: lv ? lv.link : ''
        });
      });
    }
    const total = rows.length;
    this.setData({
      unit: unit,
      rows: rows,
      lvDist: this._distOf(lvMap),
      stats: {
        total: total, carded: carded, done: done,
        passRate: total ? Math.round(done / total * 100) : 0
      }
    });
    // 自测进行中：刷新当前卡进度
    if (this.data.study.active && this.data.study.current) {
      const cur = tutorStore.getCards().find(c => c.id === this.data.study.current.id);
      if (cur && !cur.done) this.setData({ study: { active: true, flipped: this.data.study.flipped, current: this._viewOf(cur) } });
    }
  },

  /** 证据覆盖程度（只读）：把本单元的点喂给 evidenceLadder，异常或无清单时退化为「不展示」 */
  _ladderOf(unit) {
    const out = {};
    this._lvSummary = null;
    if (!unit || !Array.isArray(unit.points) || !unit.points.length) return out;
    try {
      const res = evidenceLadder.buildLadder({
        subject: this.data.subject,
        units: [unit],
        cards: tutorStore.getCards(),
        mistakes: tutorStore.getMistakes(),
        reviews: tutorStore.getReviews(),
        evidence: tutorStore.getEvidence(),
        // 显式 transfers 口留空：变式记录由 evidence 里的 evidenceKind==='variant' 派生
        // （题由服务端判、情境由服务端白名单钉），不在这里凭空补
        transfers: []
      });
      (res.rows || []).forEach(r => { out[r.kpId] = r; });
      this._lvSummary = res.summary || null;
    } catch (e) {
      console.warn('[unitKp] 证据覆盖计算异常，本轮不展示', e);
      this._lvSummary = null;
    }
    return out;
  },

  /** 各档位的条数分布（只给条数，不给百分比） */
  _distOf(lvMap) {
    const sum = this._lvSummary;
    if (!sum || !sum.total) return [];
    const short = ['无记录', '有活动', '有订正', '独立达标', '间隔稳定', '变式迁移', '多情境'];
    return evidenceLadder.LEVELS.map(l => ({
      code: 'L' + l,
      name: short[l],
      count: sum.counts[l] || 0,
      on: (sum.counts[l] || 0) > 0
    }));
  },

  /**
   * 换情境变式（L5/L6 记录源）：先选情境，再跳复测页带 kind=variant + unitId/kpId。
   * 情境是封闭集合（config.PROFILE.VARIANT_CONTEXTS，与云函数白名单同口径）：
   * 让孩子随口写一句就能凑出「另一种情境」，L6 的「多情境」就成了自证。
   */
  startVariant(e) {
    const u = this.data.unit;
    const r = (this.data.rows || []).find(x => x.id === e.currentTarget.dataset.id);
    if (!u || !r) return;
    const list = (config.PROFILE && config.PROFILE.VARIANT_CONTEXTS) || [];
    if (!list.length) return util.toast('变式情境还没配置');
    if (!r.topic) return util.toast('这个点还没有知识点名称，先补一下');
    wx.showActionSheet({
      itemList: list,
      success: (res) => {
        const ctxName = list[res.tapIndex] || '';
        wx.navigateTo({
          url: '/pkgGuide/retest/retest?key=' + this.data.subject +
            '&topic=' + encodeURIComponent(r.topic) +
            '&uid=' + encodeURIComponent(u.id) +
            '&pid=' + encodeURIComponent(r.id) +
            '&kind=variant&ctx=' + encodeURIComponent(ctxName)
        });
      },
      fail: () => {}
    });
  },

  /** 点档位标签 → 说明这一档怎么来的、还缺哪类记录（纯只读弹窗） */
  showLadder(e) {
    const id = e.currentTarget.dataset.id;
    const r = this.data.rows.find(x => x.id === id);
    if (!r || r.lv < 0) return;
    const lines = [r.lvLabel];
    if (r.lvLink === 'topic') lines.push('（按知识点名称关联到记录，可能存在同名）');
    if (r.lvNext) lines.push('再往上一层需要：' + r.lvNext);
    wx.showModal({ title: '证据覆盖 ' + r.lvText, content: lines.join('\n'), showCancel: false, confirmText: '知道了' });
  },

  _viewOf(c) {
    return { id: c.id, front: c.front || '', back: c.back || '', box: c.box || 1, done: !!c.done };
  },

  /* ---------------- 编辑：改 front/back ---------------- */
  startEdit(e) {
    const id = e.currentTarget.dataset.id;
    const r = this.data.rows.find(x => x.id === id);
    if (!r) return;
    this.setData({ editingId: id, editFront: r.front, editBack: r.back, adding: false });
  },
  cancelEdit() { this.setData({ editingId: '', editFront: '', editBack: '' }); },
  onEditFront(e) { this.setData({ editFront: e.detail.value || '' }); },
  onEditBack(e) { this.setData({ editBack: e.detail.value || '' }); },
  saveEdit() {
    const u = this.data.unit;
    if (!u) return;
    const front = (this.data.editFront || '').trim();
    const back = (this.data.editBack || '').trim();
    if (!front || !back) return util.toast('正面和背面都不能为空');
    tutorStore.updateUnitKpPoint(u.id, this.data.editingId, { front: front, back: back });
    tutorStore.pushQueued();
    this.setData({ editingId: '', editFront: '', editBack: '' });
    this.render();
    util.toast('已保存', 'success');
  },

  /* ---------------- 编辑：删点 ---------------- */
  askRemove(e) {
    const id = e.currentTarget.dataset.id;
    const u = this.data.unit;
    if (!u) return;
    wx.showModal({
      title: '删除必会点',
      content: '只从清单移除，已生成的复习卡会保留（不再计入本单元统计）。',
      confirmText: '删除',
      confirmColor: '#E05B5B',
      success: (res) => {
        if (!res.confirm) return;
        tutorStore.removeUnitKpPoint(u.id, id);
        tutorStore.pushQueued();
        this.setData({ editingId: '' });
        this.render();
      }
    });
  },

  /* ---------------- 编辑：加点 ---------------- */
  startAdd() { this.setData({ adding: true, newFront: '', newBack: '', editingId: '' }); },
  cancelAdd() { this.setData({ adding: false, newFront: '', newBack: '' }); },
  onNewFront(e) { this.setData({ newFront: e.detail.value || '' }); },
  onNewBack(e) { this.setData({ newBack: e.detail.value || '' }); },
  saveAdd() {
    const u = this.data.unit;
    if (!u) return;
    const front = (this.data.newFront || '').trim();
    const back = (this.data.newBack || '').trim();
    if (!front || !back) return util.toast('正面和背面都不能为空');
    tutorStore.addUnitKpPoint(u.id, { front: front, back: back, topic: u.title || '' });
    tutorStore.pushQueued();
    this.setData({ adding: false, newFront: '', newBack: '' });
    this.render();
    util.toast('已添加', 'success');
  },

  /* ---------------- 翻面自测（复用 cards 页交互） ---------------- */
  startStudy(e) {
    const id = e.currentTarget.dataset.id;
    const r = this.data.rows.find(x => x.id === id);
    if (!r) return;
    if (!r.cardId) return util.toast('该点还没有复习卡：去导学页推通它，或结束导学自动补齐');
    const c = tutorStore.getCards().find(x => x.id === r.cardId);
    if (!c || c.done) { this.render(); return util.toast(c ? '该卡已毕业' : '卡片不存在'); }
    this.setData({ study: { active: true, flipped: false, current: this._viewOf(c) } });
  },
  studyFlip() { this.setData({ 'study.flipped': !this.data.study.flipped }); },
  studyRate(e) {
    const good = e.currentTarget.dataset.good === '1' || e.currentTarget.dataset.good === true;
    const cur = this.data.study.current;
    if (!cur) return;
    tutorStore.advanceCard(cur.id, good);
    tutorStore.pushQueued();
    // 精力条（P1）：翻面自测是轻量行为，按 MICRO_MIN 少量扣减（非阻断）
    try { store.spendPace(require('../../utils/pace.js').MICRO_MIN); } catch (e) {}
    // 学科情境（P2）：叠加情境进度（累积制）；解锁新剧情碎片时轻提示一次
    this._advanceScenario();
    // 完成一次自测 = 一次农场浇灌（每日有上限，防刷）
    const gain = engine.tutorReward(store.get());
    if (gain) util.toast('阳光 +' + gain.sun, 'success');
    this.setData({ study: { active: false, flipped: false, current: null } });
    this.render();
  },

  /** 学科情境（P2）：推进当前学科情境，达节点解锁碎片时弹一次轻提示 */
  _advanceScenario() {
    try {
      const res = store.advanceScenario(this.data.subject);
      if (res && res.unlocked && res.unlocked.length) {
        const b = store.getScenarioBanner(this.data.subject);
        const frag = b && b.latest;
        if (frag) {
          setTimeout(() => util.toast(`${b.emoji} ${frag.title}：${frag.text}`, 'success'), 700);
        }
      }
    } catch (e) {}
  },
  studyStop() { this.setData({ study: { active: false, flipped: false, current: null } }); },

  /* ---------------- 从工作台知识库导入（跨仓 §七） ---------------- */
  openImport() {
    this.setData({ importing: true, importText: '', importPreview: null, importUnits: [], importErr: '' });
  },
  closeImport() { this.setData({ importing: false }); },
  onImportText(e) { this.setData({ importText: e.detail.value || '' }); },
  pasteFromClipboard() {
    wx.getClipboardData({
      success: (r) => { this.setData({ importText: r.data || '' }); util.toast('已粘贴剪贴板内容'); },
      fail: () => util.toast('读取剪贴板失败')
    });
  },
  parseImport() {
    const txt = (this.data.importText || '').trim();
    if (!txt) return util.toast('请先粘贴或输入 JSON');
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch (e) { this.setData({ importErr: 'JSON 解析失败：' + e.message, importPreview: null, importUnits: [] }); return; }
    const res = workbenchKpImport.convert(parsed);
    if (!res.ok) { this.setData({ importErr: res.error || '无法识别输入', importPreview: null, importUnits: [] }); return; }
    if (!res.units.length) {
      this.setData({ importErr: '未解析出任何单元（检查 knowledgePointRef / nodes 字段）', importPreview: null, importUnits: [] });
      return;
    }
    const preview = {
      stats: res.stats,
      warnings: res.warnings,
      units: res.units.map(u => ({
        title: u.title, subject: u.subject, grade: u.grade,
        count: u.points.length,
        topics: u.points.slice(0, 3).map(p => p.topic)
      }))
    };
    this.setData({ importErr: '', importPreview: preview, importUnits: res.units });
  },
  confirmImport() {
    const units = this.data.importUnits || [];
    if (!units.length) return util.toast('请先解析出可导入的单元');
    let n = 0, pts = 0;
    units.forEach(u => { const it = tutorStore.upsertUnitKp(u); if (it) { n++; pts += (u.points ? u.points.length : 0); } });
    tutorStore.pushQueued();
    this.setData({ importing: false, importText: '', importPreview: null, importUnits: [] });
    this.render();
    util.toast('已导入 ' + n + ' 个单元（' + pts + ' 个必会点）', 'success');
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});

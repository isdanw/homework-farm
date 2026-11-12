/**
 * 教材库页（pkgTools/textbookLib）
 *  · 官方库（云端种子 164 套，openid=''）+ 我的库两个分组，按学科筛选
 *  · 新建：上传 PDF（主入口，COS 直传 → parseTextbookPdf）/ 粘贴目录文本（兜底 → parseTextbookText）
 *  · 预览编辑表（单元名/小节/关键词可改可删可加）→ 保存（saveTextbook，服务端 normalizeTextbook 兜底）
 *  · 我的条目：查看单元 / 编辑 / 删除；pick 模式（从学科画像进入）：条目「选用」回写画像
 *
 * ⚠️ AI 只把文本变结构；解析结果永远先过预览编辑，保存与否由家长拍板。
 * ⚠️ 上传 PDF 走 COS 直传（wx.request PUT）——HTTP 网关体上限约 100KB，禁走云函数传大文件。
 */
const examApi = require('../../utils/examApi.js');
const util = require('../../utils/util.js');
const store = require('../../utils/store.js');
const model = require('../../utils/textbookLibModel.js');

Page({
  data: {
    pickMode: false,            // 从学科画像进入：只做「选用」回写
    profileKey: '',             // pick 模式回写目标（打卡类型 key）
    // 列表
    official: [],
    mine: [],
    filterSubject: '',
    subjectOptions: [{ key: '', name: '全部学科' }].concat(model.SUBJECTS),
    subjectPickOptions: model.SUBJECTS,   // sheet/编辑态选择器（不含「全部学科」）
    loading: false,
    filterIdx: 0,                         // 筛选器学科下标（subjectOptions，[0]=全部学科）
    expandedId: '',             // 展开查看单元的条目
    expandedUnits: [],
    // 新建上下文（学科/年级/版本先于解析收集，喂给 hy3）
    sheetOpen: false,
    newSubject: 'math',
    newSubjectIdx: 0,                     // sheet 学科选择器下标（subjectPickOptions）
    newGrade: '',
    newVersion: '',
    newTerm: '',
    // PDF 上传流
    uploading: false,
    uploadStage: '',            // 上传中 / 解析中
    // 粘贴流
    pasteOpen: false,
    pasteText: '',
    parsing: false,
    // 搜索流（联网候选 → 选它进预览编辑）
    searchOpen: false,
    searchSubject: 'math',
    searchSubjectIdx: 0,
    searchGrade: '',
    searchVersion: '',
    searchTerm: '',
    searchQuery: '',
    searching: false,
    searchResults: [],
    searchUsed: '',
    // 编辑态（PDF 解析结果 / 粘贴结果 / 编辑我的）
    editing: false,
    form: null,
    formSubjectIdx: 0,                    // 编辑态学科选择器下标（subjectPickOptions）
    compare: null,                        // 与官方种子库比对结果（null=未比对/无候选）
    compareOpen: false,                   // 比对明细展开
    saving: false
  },

  onLoad(options) {
    const pickMode = !!(options && options.pick);
    const profileKey = (options && options.key) || '';
    const init = { pickMode, profileKey };
    // pick 模式（从学科画像「从教材库选择」进入）：直接代入画像里的搜索信息，免去重复填写
    if (pickMode && profileKey && model.SUBJECT_KEYS.indexOf(profileKey) >= 0) {
      const p = store.getSubjectProfile(profileKey);
      const grade = store.resolveGrade() || '';
      // 学期：从画像 progress 自由文本尽力识别（上学期 / 下学期），识别不到留空由家长补
      let term = '';
      const prog = (p && p.progress) || '';
      if (prog.indexOf('上学期') >= 0) term = '上学期';
      else if (prog.indexOf('下学期') >= 0) term = '下学期';
      init.searchSubject = profileKey;
      init.searchSubjectIdx = this._pickIdx(profileKey);
      init.searchVersion = (p && p.textbook) || '';   // 如「人教版」
      init.searchGrade = grade;                         // 顶层 grade 或 schoolProgress 解析
      init.searchTerm = term;
    }
    this.setData(init);
    wx.setNavigationBarTitle({ title: (pickMode ? '选择教材' : '教材库') });
  },

  onShow() {
    this.setData({ newSubjectIdx: this._pickIdx(this.data.newSubject) });
    this.loadList();
  },

  noop() {},

  /** 学科 key → subjectOptions 下标（[0] 为「全部学科」占位，仅筛选器用） */
  _subjectIdx(key) {
    const i = this.data.subjectOptions.findIndex(o => o.key === key);
    return i >= 0 ? i : 1;
  },

  /** 学科 key → subjectPickOptions 下标（sheet/编辑态选择器，无「全部」占位） */
  _pickIdx(key) {
    const i = this.data.subjectPickOptions.findIndex(o => o.key === key);
    return i >= 0 ? i : 0;
  },

  /* ---------------- 列表 ---------------- */
  loadList() {
    this.setData({ loading: true });
    examApi.listTextbooks({ subject: this.data.filterSubject }).then(r => {
      this.setData({ loading: false });
      if (!r || !r.ok) return util.toast((r && r.msg) || '教材库加载失败');
      const g = model.groupList(r);
      this.setData({ official: g.official, mine: g.mine, filterIdx: this._subjectIdx(this.data.filterSubject) });
    });
  },
  onFilterSubject(e) {
    const i = Number(e.detail.value);
    const opt = this.data.subjectOptions[i] || this.data.subjectOptions[0];
    this.setData({ filterSubject: opt.key });
    this.loadList();
  },

  /** 展开/收起某教材的单元清单（官方与我的都可看） */
  toggleExpand(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.expandedId === id) { this.setData({ expandedId: '', expandedUnits: [] }); return; }
    examApi.getTextbook(id).then(r => {
      if (!r || !r.ok) return util.toast((r && r.msg) || '读取教材失败');
      const units = (r.textbook && r.textbook.units) || [];
      this.setData({
        expandedId: id,
        expandedUnits: units.map(u => ({
          name: u.name || '',
          sections: (Array.isArray(u.sections) ? u.sections : []).join('、'),
          keywords: (Array.isArray(u.keywords) ? u.keywords : []).join('、')
        }))
      });
    });
  },

  /* ---------------- 新建：上下文收集 ---------------- */
  openSheet() {
    this.setData({ sheetOpen: true, newSubject: 'math', newGrade: '', newVersion: '', newTerm: '', pasteOpen: false });
  },
  closeSheet() { this.setData({ sheetOpen: false }); },
  onNewSubject(e) { this.setData({ newSubject: this.data.subjectPickOptions[Number(e.detail.value)].key }); },
  onNewGrade(e) { this.setData({ newGrade: e.detail.value || '' }); },
  onNewVersion(e) { this.setData({ newVersion: e.detail.value || '' }); },
  onNewTerm(e) { this.setData({ newTerm: e.detail.value || '' }); },

  /** 入口一：上传 PDF（选文件 → COS 直传 → 云端解析目录） */
  choosePdf() {
    const subject = this.data.newSubject;
    if (!subject) return util.toast('请先选择学科');
    this.setData({ sheetOpen: false });
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extensionType: ['pdf'],
      success: (res) => {
        const f = (res.tempFiles && res.tempFiles[0]) || null;
        if (!f) return;
        if (f.size > 25 * 1024 * 1024) return util.toast('PDF 超过 25MB，请压缩后重试');
        this.uploadAndParse(f.path);
      },
      fail: () => { /* 用户取消 */ }
    });
  },

  uploadAndParse(filePath) {
    this.setData({ uploading: true, uploadStage: '上传中…' });
    examApi.uploadFile(filePath, 'textbook_pdf', 'pdf').then(fileId => {
      this.setData({ uploadStage: '解析目录中…' });
      return examApi.parseTextbookPdf({
        fileId: fileId,
        subject: this.data.newSubject,
        grade: this.data.newGrade,
        term: this.data.newTerm,
        version: this.data.newVersion
      });
    }).then(r => {
      this.setData({ uploading: false, uploadStage: '' });
      if (!r || !r.ok) {
        return wx.showModal({ title: '解析失败', content: (r && r.msg) || '请重试', showCancel: false });
      }
      const form = model.formFromDraft(r.draft);
      if (!form.title) form.title = (this.data.newVersion || '') + '·' + model.subjectName(this.data.newSubject) + (this.data.newGrade || '');
      this.setData({ editing: true, form: form, formSubjectIdx: this._pickIdx(form.subject) });
      this.compareOfficial(form);         // 与官方种子库比对（只读，识别后即可见）
    }).catch(e => {
      this.setData({ uploading: false, uploadStage: '' });
      wx.showModal({ title: '上传或解析失败', content: (e && e.message) || '请重试', showCancel: false });
    });
  },

  /** 入口二：粘贴目录文本（兜底） */
  openPaste() {
    if (!this.data.newSubject) return util.toast('请先选择学科');
    this.setData({ sheetOpen: false, pasteOpen: true, pasteText: '' });
  },
  closePaste() { this.setData({ pasteOpen: false }); },
  onPasteText(e) { this.setData({ pasteText: e.detail.value || '' }); },
  pasteFromClipboard() {
    wx.getClipboardData({
      success: (r) => { this.setData({ pasteText: r.data || '' }); util.toast('已粘贴剪贴板内容'); },
      fail: () => util.toast('读取剪贴板失败')
    });
  },
  parsePaste() {
    const txt = (this.data.pasteText || '').trim();
    if (!txt) return util.toast('请先粘贴目录文本');
    this.setData({ parsing: true });
    examApi.parseTextbookText({
      rawText: txt,
      subject: this.data.newSubject,
      grade: this.data.newGrade,
      term: this.data.newTerm,
      version: this.data.newVersion
    }).then(r => {
      this.setData({ parsing: false });
      if (!r || !r.ok) {
        return wx.showModal({ title: '解析失败', content: (r && r.msg) || '请重试', showCancel: false });
      }
      const form = model.formFromDraft(r.draft);
      this.setData({ pasteOpen: false, editing: true, form: form, formSubjectIdx: this._pickIdx(form.subject) });
      this.compareOfficial(form);         // 与官方种子库比对（只读，识别后即可见）
    }).catch(e => {
      this.setData({ parsing: false });
      wx.showModal({ title: '解析失败', content: (e && e.message) || '请重试', showCancel: false });
    });
  },

  /* ---------------- 联网搜索（Tavily → 候选带 units） ---------------- */
  openSearch() {
    const s = this.data.searchSubject;
    this.setData({
      searchOpen: true,
      searchSubjectIdx: this._pickIdx(s),
      searchQuery: (this.data.searchVersion || '') + (this.data.searchGrade || '') + (this.data.searchTerm || '') + model.subjectName(s) + '教材目录',
      searchResults: [], searchUsed: ''
    });
  },
  closeSearch() { this.setData({ searchOpen: false }); },
  onSearchSubject(e) {
    const key = this.data.subjectPickOptions[Number(e.detail.value)].key;
    this.setData({
      searchSubject: key, searchSubjectIdx: this._pickIdx(key),
      searchQuery: (this.data.searchVersion || '') + (this.data.searchGrade || '') + (this.data.searchTerm || '') + model.subjectName(key) + '教材目录'
    });
  },
  onSearchGrade(e) {
    const g = e.detail.value || '';
    this.setData({
      searchGrade: g,
      searchQuery: (this.data.searchVersion || '') + g + (this.data.searchTerm || '') + model.subjectName(this.data.searchSubject) + '教材目录'
    });
  },
  onSearchVersion(e) {
    const v = e.detail.value || '';
    this.setData({
      searchVersion: v,
      searchQuery: v + (this.data.searchGrade || '') + (this.data.searchTerm || '') + model.subjectName(this.data.searchSubject) + '教材目录'
    });
  },
  onSearchTerm(e) {
    const t = e.detail.value || '';
    this.setData({
      searchTerm: t,
      searchQuery: (this.data.searchVersion || '') + (this.data.searchGrade || '') + t + model.subjectName(this.data.searchSubject) + '教材目录'
    });
  },
  onSearchQuery(e) { this.setData({ searchQuery: e.detail.value || '' }); },
  doSearch() {
    const q = (this.data.searchQuery || '').trim();
    if (!q) return util.toast('请输入关键词');
    this.setData({ searching: true });
    examApi.searchTextbook({ query: q, subject: this.data.searchSubject, grade: this.data.searchGrade, term: this.data.searchTerm, version: this.data.searchVersion }).then(r => {
      this.setData({ searching: false });
      if (!r || !r.ok) {
        if (r && r.code === 'rate_limit') return util.toast('搜索太频繁啦，稍等一下再试');
        return util.toast((r && r.msg) || '搜索失败');
      }
      const list = r.candidates || [];
      this.setData({ searchResults: list, searchUsed: r.usedQuery || '' });
      if (!list.length) util.toast('没搜到相关结果，换个关键词试试');
    }).catch(e => {
      this.setData({ searching: false });
      util.toast((e && e.message) || '搜索失败');
    });
  },
  /** 点候选「选它」：候选 units 直接进预览编辑表（不落库，保存由家长拍板） */
  pickSearch(e) {
    const i = Number(e.currentTarget.dataset.i);
    const c = (this.data.searchResults || [])[i];
    if (!c) return;
    if (!c.units || !c.units.length) return util.toast('这条没提取到目录，换一条或改用粘贴');
    const form = model.formFromDraft({
      title: (c.title || '').slice(0, 60),
      subject: this.data.searchSubject,
      grade: this.data.searchGrade,
      term: '', version: '',
      source: 'search',
      sourceUrl: c.url,
      units: c.units
    });
    if (!form.title) form.title = model.subjectName(this.data.searchSubject) + '教材（搜索）';
    this.setData({ searchOpen: false, editing: true, form: form, formSubjectIdx: this._pickIdx(form.subject) });
  },

  /* ---------------- 预览编辑表 ---------------- */
  onFormTitle(e) { this.setData({ 'form.title': e.detail.value || '' }); },
  onFormGrade(e) { this.setData({ 'form.grade': e.detail.value || '' }); },
  onFormTerm(e) { this.setData({ 'form.term': e.detail.value || '' }); },
  onFormVersion(e) { this.setData({ 'form.version': e.detail.value || '' }); },
  onFormSubject(e) { this.setData({ 'form.subject': this.data.subjectPickOptions[Number(e.detail.value)].key }); },
  onUnitName(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ ['form.units[' + i + '].name']: e.detail.value || '' });
  },
  onUnitSections(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ ['form.units[' + i + '].sectionsText']: e.detail.value || '' });
  },
  onUnitKeywords(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ ['form.units[' + i + '].keywordsText']: e.detail.value || '' });
  },
  addUnit() {
    const units = (this.data.form && this.data.form.units || []).concat([{ name: '', sectionsText: '', keywordsText: '' }]);
    this.setData({ 'form.units': units });
  },
  removeUnit(e) {
    const i = Number(e.currentTarget.dataset.i);
    const units = (this.data.form && this.data.form.units || []).slice();
    units.splice(i, 1);
    this.setData({ 'form.units': units });
  },
  /* ---------------- 与官方种子库比对（只读；识别后自动触发） ---------------- */
  /** 找官方库最像的教材（元数据打分：同年级>同学期>同版本），拉全文后做单元级 diff */
  compareOfficial(form) {
    this.setData({ compare: null, compareOpen: false });
    this._compareSeed = null;
    const subject = (form && form.subject) || '';
    const grade = (form && form.grade) || '';
    const term = (form && form.term) || '';
    const version = (form && form.version) || '';
    if (!subject || !grade) return;     // 没有年级没法可靠匹配，静默跳过
    examApi.listTextbooks({ subject: subject }).then(r => {
      if (!r || !r.ok) return;
      const official = model.groupList(r).official || [];
      let best = null, bestScore = 0;
      for (const it of official) {
        let sc = 0;
        const ig = it.grade || '';
        if (ig.indexOf(grade) >= 0 || (ig && grade.indexOf(ig) >= 0)) sc += 4;
        if (term && (it.term || '') === term) sc += 2;
        if (version && (it.version || '').indexOf(version) >= 0) sc += 2;
        if (sc > bestScore) { bestScore = sc; best = it; }
      }
      if (!best || bestScore < 4) return;   // 至少年级对得上才比对
      return examApi.getTextbook(best.textbookId).then(tr => {
        if (!tr || !tr.ok) return;
        const seed = tr.textbook || {};
        const diff = model.diffUnits((form && form.units) || [], seed.units || []);
        this._compareSeed = seed;
        this.setData({
          compare: {
            seedTitle: seed.title || best.title,
            seedId: best.textbookId,
            matched: diff.matched,
            draftOnly: diff.draftOnly,
            seedOnly: diff.seedOnly,
            rows: diff.rows
          }
        });
      });
    }).catch(() => { /* 比对失败静默：不影响识别主流程 */ });
  },
  toggleCompareDetail() { this.setData({ compareOpen: !this.data.compareOpen }); },
  /** 家长拍板：官方库是对的 → 用官方条目替换表单（保存时云端会复制成自己的，不动官方数据） */
  useOfficial() {
    const seed = this._compareSeed;
    if (!seed) return util.toast('官方库数据已失效，请关闭后重试');
    const form = model.formFromDraft(seed);
    this.setData({ form: form, formSubjectIdx: this._pickIdx(form.subject), compare: null, compareOpen: false });
    this._compareSeed = null;
    util.toast('已改用官方库版本，可继续编辑后保存');
  },
  /** 家长拍板：以本次识别为准 → 收起比对卡 */
  dismissCompare() { this.setData({ compare: null, compareOpen: false }); this._compareSeed = null; },

  cancelEdit() { this.setData({ editing: false, form: null }); },

  saveForm() {
    const form = this.data.form;
    const v = model.validateForm(form);
    if (!v.ok) return util.toast(v.msg);
    this.setData({ saving: true });
    const draft = model.draftFromForm(form);
    examApi.saveTextbook(draft).then(r => {
      this.setData({ saving: false });
      if (!r || !r.ok) return util.toast((r && r.msg) || '保存失败');
      this.setData({ editing: false, form: null });
      util.toast('已保存', 'success');
      this.loadList();
    }).catch(e => {
      this.setData({ saving: false });
      util.toast((e && e.message) || '保存失败');
    });
  },

  /* ---------------- 我的条目：编辑 / 删除 ---------------- */
  editMine(e) {
    const id = e.currentTarget.dataset.id;
    examApi.getTextbook(id).then(r => {
      if (!r || !r.ok) return util.toast((r && r.msg) || '读取失败');
      const form = model.formFromDraft(r.textbook);
      this.setData({ editing: true, form: form, formSubjectIdx: this._pickIdx(form.subject) });
    });
  },
  deleteMine(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除教材',
      content: '删除后不可恢复（已绑定该教材的学习计划不受影响，仍可按原计划执行）。',
      confirmText: '删除',
      confirmColor: '#E05B5B',
      success: (res) => {
        if (!res.confirm) return;
        examApi.deleteTextbook(id).then(r => {
          if (!r || !r.ok) return util.toast((r && r.msg) || '删除失败');
          util.toast('已删除', 'success');
          this.loadList();
        });
      }
    });
  },

  /* ---------------- 选用 / 复制到我的（同一按钮，按模式分流） ----------------
   *  · pick 模式（从学科画像进入）：「选用」只写画像（教材版本字符串 + textbookId 锚点），随后返回
   *  · 非 pick 模式（从「我的」页进入）：官方库「复制到我的」= 把官方条目复制成当前用户的副本，不碰画像 */
  pickThis(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.pickMode) {
      const key = this.data.profileKey;
      if (!key) return util.toast('缺少画像参数');
      examApi.getTextbook(id).then(r => {
        if (!r || !r.ok) return util.toast((r && r.msg) || '读取教材失败');
        const t = r.textbook || {};
        const label = [t.version, t.title].filter(Boolean).join(' · ') || t.title || '';
        store.saveSubjectProfile(key, {
          textbook: label.slice(0, 20),     // 画像里的教材版本字符串（兼容旧逻辑，计划生成仍可用）
          textbookId: t.textbookId || id    // 新增锚点：计划生成按单元目录编排
        });
        util.toast('已选用《' + (t.title || '') + '》', 'success');
        setTimeout(() => wx.navigateBack({ delta: 1 }), 600);
      });
    } else {
      // 非 pick：官方库复制到我的（沿用原 textbookId，云端撞唯一键自动换新 id 并归属当前用户，#17）
      examApi.getTextbook(id).then(r => {
        if (!r || !r.ok) return util.toast((r && r.msg) || '读取教材失败');
        const t = r.textbook || {};
        const draft = {
          textbookId: t.textbookId || id,
          title: t.title || '',
          subject: t.subject || '',
          grade: t.grade || '',
          term: t.term || '',
          version: t.version || '',
          units: t.units || [],
          source: 'upload'
        };
        examApi.saveTextbook(draft).then(sr => {
          if (!sr || !sr.ok) return util.toast((sr && sr.msg) || '复制失败');
          util.toast('已复制到我的库', 'success');
          this.loadList();
        }).catch(err => util.toast((err && err.message) || '复制失败'));
      }).catch(err => util.toast((err && err.message) || '读取教材失败'));
    }
  },

  goBack() { wx.navigateBack({ delta: 1 }); }
});

/**
 * textbookLibModel.js —— 教材库页纯逻辑（不依赖 wx，可单测）
 *  · 学科/来源枚举（与云端 SUBJECT_NAMES 对齐，含 science）
 *  · 云端草稿 draft ⇄ 可编辑表单 form 互转（units 的 sections/keywords 折成文本便于改）
 *  · 表单校验（保存前拦脏数据，与云端 normalizeTextbook 同口径）
 */
const SUBJECTS = [
  { key: 'math', name: '数学' },
  { key: 'chinese', name: '语文' },
  { key: 'english', name: '英语' },
  { key: 'physics', name: '物理' },
  { key: 'chemistry', name: '化学' },
  { key: 'biology', name: '生物' },
  { key: 'history', name: '历史' },
  { key: 'geography', name: '地理' },
  { key: 'politics', name: '道德与法治' },
  { key: 'science', name: '科学' }
];
const SUBJECT_KEYS = SUBJECTS.map(s => s.key);
function subjectName(key) {
  const s = SUBJECTS.find(x => x.key === key);
  return s ? s.name : (key || '');
}

/** 来源标签（与云端 source 字段对齐） */
const SOURCE_LABELS = { seed: '官方', upload: '上传', search: '搜索', manual: '手动' };
function sourceLabel(s) { return SOURCE_LABELS[s] || '上传'; }

/** 云端 draft → 可编辑表单（units 数组字段折成换行文本，编辑体验与粘贴目录一致） */
function formFromDraft(draft) {
  const d = draft || {};
  return {
    textbookId: d.textbookId || '',
    title: d.title || '',
    subject: d.subject || 'math',
    grade: d.grade || '',
    term: d.term || '',
    version: d.version || '',
    source: d.source || 'upload',
    sourceUrl: d.sourceUrl || '',
    units: (Array.isArray(d.units) ? d.units : []).map(u => ({
      name: (u && u.name) || '',
      sectionsText: (u && Array.isArray(u.sections) ? u.sections.join('\n') : ''),
      keywordsText: (u && Array.isArray(u.keywords) ? u.keywords.join('、') : '')
    }))
  };
}

/** 表单 → 云端 draft（空行/空值剔除；keywords 顿号或顿号变体切分） */
function draftFromForm(form) {
  const f = form || {};
  const units = (Array.isArray(f.units) ? f.units : []).map(u => {
    const sections = String((u && u.sectionsText) || '').split('\n').map(s => s.trim()).filter(Boolean);
    const keywords = String((u && u.keywordsText) || '').split(/[、,，;；]/).map(s => s.trim()).filter(Boolean);
    const rec = { name: String((u && u.name) || '').trim() };
    if (sections.length) rec.sections = sections;
    if (keywords.length) rec.keywords = keywords;
    return rec;
  }).filter(u => u.name);
  const draft = {
    title: String(f.title || '').trim(),
    subject: f.subject || 'math',
    grade: String(f.grade || '').trim(),
    term: String(f.term || '').trim(),
    version: String(f.version || '').trim(),
    source: f.source || 'upload',
    units: units
  };
  if (f.textbookId) draft.textbookId = f.textbookId;
  if (f.sourceUrl) draft.sourceUrl = f.sourceUrl;
  return draft;
}

/** 保存前校验（与云端 normalizeTextbook 边界同口径：标题非空、学科受支持、≥1 单元、≤30 单元） */
function validateForm(form) {
  const f = form || {};
  if (!String(f.title || '').trim()) return { ok: false, msg: '请填写教材名称' };
  if (SUBJECT_KEYS.indexOf(f.subject) < 0) return { ok: false, msg: '请选择受支持的学科' };
  const named = (Array.isArray(f.units) ? f.units : []).filter(u => String((u && u.name) || '').trim());
  if (!named.length) return { ok: false, msg: '至少需要一个单元' };
  if (named.length > 30) return { ok: false, msg: '单元数量超过上限（30）' };
  return { ok: true };
}

/** 列表条目分组展示模型（官方库在上、我的库在下） */
function groupList(listRes) {
  const r = listRes || {};
  const brief = x => ({
    textbookId: x.textbookId || '',
    title: x.title || '未命名教材',
    subject: x.subject || '',
    subjectName: x.subjectName || subjectName(x.subject),
    grade: x.grade || '',
    term: x.term || '',
    version: x.version || '',
    source: x.source || '',
    sourceLabel: sourceLabel(x.source),
    unitCount: x.unitCount || 0,
    updatedAt: x.updatedAt || 0,
    isOfficial: x.source === 'seed'
  });
  return {
    official: (Array.isArray(r.official) ? r.official : []).map(brief),
    mine: (Array.isArray(r.mine) ? r.mine : []).map(brief)
  };
}

/* ==================== 与官方种子库比对（只读，2026-10-26） ==================== */

/** 单元名归一化：剥「第X单元/单元」前缀、章节号、空白与常见标点，得到可比对的核 */
function normalizeUnitName(name) {
  let s = String(name || '');
  s = s.replace(/第[一二三四五六七八九十百千0-9０-９]+单元/g, '');   // 先吃全「单元」两字
  s = s.replace(/第[一二三四五六七八九十百千0-9０-９]+[课讲章]/g, '');
  s = s.replace(/^[0-9０-９]+[\s\.、\.]*/, '');          // 行首编号
  s = s.replace(/[·•・\-—_()（）\[\]【】\s]/g, '');
  return s.toLowerCase();
}

/** form/draft 单元 → { name, sections[] }（sectionsText 按行切） */
function comparableUnits(units) {
  return (Array.isArray(units) ? units : []).map(u => ({
    name: String((u && u.name) || '').trim(),
    sections: u && Array.isArray(u.sections)
      ? u.sections.map(s => String(s).trim()).filter(Boolean)
      : String((u && u.sectionsText) || '').split('\n').map(s => s.trim()).filter(Boolean)
  })).filter(u => u.name);
}

/** 单元名匹配：归一化后相等，或一方完整包含另一方（≥2 字，容忍 AI 掉前缀/掉后缀） */
function unitNameMatch(a, b) {
  const x = normalizeUnitName(a), y = normalizeUnitName(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 2 && y.length >= 2 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0));
}

/**
 * 目录比对（form/draft units vs 官方库 units，纯客户端，不落库）：
 * 返回 { matched, draftOnly, seedOnly, rows, matchRate }
 *   rows: [{ name, status: same|section_diff|draft_only|seed_only, note }]
 */
function diffUnits(draftUnits, seedUnits) {
  const d = comparableUnits(draftUnits);
  const s = comparableUnits(seedUnits);
  const usedSeed = new Array(s.length).fill(false);
  const rows = [];
  let matched = 0;
  for (const du of d) {
    let si = -1;
    for (let j = 0; j < s.length; j++) {
      if (!usedSeed[j] && unitNameMatch(du.name, s[j].name)) { si = j; break; }
    }
    if (si < 0) {
      rows.push({ name: du.name, status: 'draft_only', note: '官方库没有该单元' });
      continue;
    }
    usedSeed[si] = true;
    matched++;
    const a = du.sections, b = s[si].sections;
    const setA = new Set(a.map(x => normalizeUnitName(x)));
    const setB = new Set(b.map(x => normalizeUnitName(x)));
    const onlyA = a.filter(x => !setB.has(normalizeUnitName(x)));
    const onlyB = b.filter(x => !setA.has(normalizeUnitName(x)));
    if (!b.length || (!onlyA.length && !onlyB.length)) {
      rows.push({ name: du.name, status: 'same', note: b.length ? ('小节一致（' + a.length + ' 节）') : '单元名一致（官方库无小节）' });
    } else {
      const parts = [];
      if (onlyA.length) parts.push('识别多出 ' + onlyA.length + ' 节');
      if (onlyB.length) parts.push('官方多出 ' + onlyB.length + ' 节');
      rows.push({ name: du.name, status: 'section_diff', note: '小节不同：' + parts.join('，') });
    }
  }
  for (let j = 0; j < s.length; j++) {
    if (!usedSeed[j]) rows.push({ name: s[j].name, status: 'seed_only', note: '本次识别漏了该单元' });
  }
  const total = Math.max(d.length, s.length, 1);
  return { matched: matched, draftOnly: d.length - matched, seedOnly: s.length - matched, rows: rows, matchRate: matched / total };
}

module.exports = {
  SUBJECTS: SUBJECTS,
  SUBJECT_KEYS: SUBJECT_KEYS,
  subjectName: subjectName,
  sourceLabel: sourceLabel,
  formFromDraft: formFromDraft,
  draftFromForm: draftFromForm,
  validateForm: validateForm,
  groupList: groupList,
  normalizeUnitName: normalizeUnitName,
  diffUnits: diffUnits
};

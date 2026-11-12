/**
 * kpRecall.js —— 必会点「讲解材料」结构化召回（端上纯函数，不依赖 wx，可被测试脚本直接 require）
 *
 * 设计（借鉴通用学习系统的知识地图召回思路，按本项目红线裁剪）：
 *  · 召回源全是孩子自己整理过的结构化数据：单元必会点（topic/front/back/assessmentPrompt）、
 *    复习卡（front/back）、错题订正建议（suggestion）——不引入语义向量、不引第三方检索库。
 *  · 打分口径：中文短问句按相邻二字组（bigram）重叠计数 + 必会点名整串命中加权；
 *    低于 MIN_SCORE 判为不相关，宁可不注入，也不要把无关清单硬塞进 prompt。
 *  · 只读边界：本模块**不写任何数据**，不参与判分、不产生 evidence、不影响复测单写者逻辑；
 *    召回文本只作为「怎么讲」的素材注入 tutorChat，AI 拿它组织提问，不当作本题对错的标准。
 *  · 可溯源：随文本一起返回 sources（单元/必会点/引用到的卡数），前端在回复下方原样展示。
 */

/** 打分权重：整串命中必会点名 > 主题词重叠 > 讲解细节重叠 */
const W = { topicExact: 6, topicHit: 2, detailHit: 1 };
/** 相关性下限：低于此分不注入（避免「问了加法却塞一堆图形与位置」） */
const MIN_SCORE = 3;
/** 输出预算：最多几条必会点、每条几张卡、整块不超过多少字 */
const MAX_POINTS = 4;
const MAX_CARDS = 2;
const MAX_PREREQS = 2;
const MAX_CHARS = 1200;

/** 问句里的口语噪声词（只从 query 侧剔除，清单文本不动），避免噪声撑高重叠分 */
const QUERY_STOP = Object.assign(Object.create(null), {
  '什么': 1, '怎么': 1, '为何': 1, '请问': 1, '一下': 1, '这个': 1, '那个': 1,
  '还有': 1, '就是': 1, '可以': 1, '不会': 1, '做题': 1, '题目': 1, '这道': 1,
  '这题': 1, '那题': 1, '答案': 1, '告诉': 1, '帮我': 1, '老师': 1, '对吗': 1
});

/** 归一：只保留汉字/字母/数字，其余压成空格（不用 \p{...}，兼容低版本 JSC） */
function clean(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^0-9a-z一-龥]+/g, ' ')
    .trim();
}

/** 切词：纯英数整词保留，中文串取相邻二字组（单字串退化为单字） */
function tokenize(text) {
  const c = clean(text);
  if (!c) return [];
  const out = [];
  c.split(' ').forEach(seg => {
    if (!seg) return;
    if (/^[0-9a-z]+$/.test(seg) || seg.length === 1) { out.push(seg); return; }
    for (let i = 0; i + 1 < seg.length; i++) out.push(seg.substr(i, 2));
  });
  return out;
}

function tokenSet(list) {
  const s = Object.create(null);
  for (let i = 0; i < list.length; i++) s[list[i]] = 1;
  return s;
}

/** query 侧切词：先剔噪声词，剔空了则回退原词，保证短问句仍有召回 */
function queryTokens(text) {
  const all = tokenize(text);
  const kept = all.filter(t => !QUERY_STOP[t]);
  const src = kept.length ? kept : all;
  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < src.length; i++) {
    if (seen[src[i]]) continue;
    seen[src[i]] = 1;
    out.push(src[i]);
  }
  return out;
}

function clip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** query 词已去重，直接数命中了几个不同的词 */
function hitCount(qTokens, set) {
  let n = 0;
  for (let i = 0; i < qTokens.length; i++) if (set[qTokens[i]]) n++;
  return n;
}

/** 一份必会清单摊平成 {unit, point} 条目（只取有 id/topic 的点） */
function flatten(units) {
  const rows = [];
  (Array.isArray(units) ? units : []).forEach(u => {
    if (!u || !Array.isArray(u.points)) return;
    u.points.forEach(p => {
      if (!p || !p.topic) return;
      rows.push({
        unitId: u.id || '',
        unitTitle: u.title || '',
        point: p,
        topicSet: tokenSet(tokenize(p.topic)),
        detailSet: tokenSet(tokenize([p.front, p.back, p.assessmentPrompt].join(' ')))
      });
    });
  });
  return rows;
}

/** 主题相关性打分：整串命中 > 主题词重叠 > 讲解细节重叠 */
function scoreRow(row, qClean, qTokens) {
  let s = 0;
  const topicClean = clean(row.point.topic);
  if (topicClean && qClean.indexOf(topicClean) >= 0) s += W.topicExact;
  else if (topicClean && qClean && topicClean.indexOf(qClean) >= 0) s += W.topicExact - 2;
  s += W.topicHit * hitCount(qTokens, row.topicSet);
  s += W.detailHit * hitCount(qTokens, row.detailSet);
  return s;
}

/** 该必会点是否已有「毕业卡」（与 diagnoseBlindSpot 同口径：有 done 卡即视为该点走通） */
function buildMastered(cards) {
  const byKp = Object.create(null);
  const byTopic = Object.create(null);
  (Array.isArray(cards) ? cards : []).forEach(c => {
    if (!c || !c.done) return;
    if (c.kpId) byKp[c.unitId + '::' + c.kpId] = 1;
    if (c.topic) byTopic[clean(c.topic)] = 1;
  });
  return { byKp: byKp, byTopic: byTopic };
}

/** 与该必会点相关的错题（主题串互相包含，或二字组重叠），取最近一条的订正动作 */
function relatedSuggestion(point, mistakes) {
  const topicClean = clean(point.topic);
  const topicTokens = tokenSet(tokenize(point.topic));
  const list = Array.isArray(mistakes) ? mistakes : [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || !m.topic || !m.suggestion) continue;
    const mClean = clean(m.topic);
    const related = (topicClean && mClean && (topicClean.indexOf(mClean) >= 0 || mClean.indexOf(topicClean) >= 0)) ||
      tokenize(m.topic).some(t => topicTokens[t]);
    if (related) return clip(m.suggestion, 40);
  }
  return '';
}

/**
 * 组装一条必会点的讲解材料。
 * 只说「怎么讲」的抓手，不写「学会没」的结论。
 */
function renderRow(row, cards, mistakes, mastered, lines) {
  const p = row.point;
  const head = '「' + clip(p.topic, 30) + '」' + (row.unitTitle ? ('（' + clip(row.unitTitle, 20) + '）') : '');
  lines.push(head);
  if (p.assessmentPrompt) lines.push('  自测问法：' + clip(p.assessmentPrompt, 50));
  const explain = [p.front, p.back].filter(Boolean).join(' → ');
  if (explain) lines.push('  讲解抓手：' + clip(explain, 60));

  const kpCards = cards.filter(c => c && c.kpId === p.id && c.unitId === row.unitId).slice(0, MAX_CARDS);
  kpCards.forEach(c => {
    const text = [c.front, c.back].filter(Boolean).join(' → ');
    if (text) lines.push('  孩子自己推通过的问法：' + clip(text, 50));
  });

  // 先修欠账：只报「还没走通的硬前置」，措辞是进度不是能力结论
  const prereqs = Array.isArray(p.prereqs) ? p.prereqs : [];
  let shown = 0;
  for (let i = 0; i < prereqs.length && shown < MAX_PREREQS; i++) {
    const r = prereqs[i];
    if (!r || !r.topic || r.strength === 'soft') continue;
    const done = mastered.byTopic[clean(r.topic)] === 1;
    if (done) continue;
    lines.push('  先修还没走通：' + clip(r.topic, 24) + (r.reason ? ('（' + clip(r.reason, 24) + '）') : ''));
    shown++;
  }

  const sug = relatedSuggestion(p, mistakes);
  if (sug) lines.push('  上次订正动作：' + sug);
  return kpCards.length;
}

/**
 * 主入口：给一轮提问，返回可注入的讲解材料与来源。
 *
 * @param {Object} input
 *   query      {string} 孩子本轮输入
 *   subject    {string} 学科 key（用于错题过滤由调用方保证，这里只做兜底）
 *   units      {Array}  tutorStore 的单元必会清单（同孩子、同学科，按 updatedAt 新→旧）
 *   cards      {Array}  tutorStore.getCards()
 *   mistakes   {Array}  tutorStore.getMistakes()
 *   errorType  {string} 可选，错题订正入口带进来的错因（E1-E9），命中同错因的错题优先
 * @returns {{text:string, sources:Array}|null} 无可信召回时返回 null（导学退化为原行为）
 */
function buildRecall(input) {
  const opt = input || {};
  const qClean = clean(opt.query);
  const qTokens = queryTokens(opt.query);
  if (!qTokens.length) return null;

  const rows = flatten(opt.units);
  if (!rows.length) return null;

  const scored = [];
  for (let i = 0; i < rows.length; i++) {
    const s = scoreRow(rows[i], qClean, qTokens);
    if (s >= MIN_SCORE) scored.push({ row: rows[i], score: s });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || (b.row.point.order || 0) - (a.row.point.order || 0));

  const cards = Array.isArray(opt.cards) ? opt.cards : [];
  const mistakes = filterMistakes(opt.subject, opt.errorType, opt.mistakes);
  const mastered = buildMastered(cards);

  const sources = [];
  const lines = [];
  let used = 0;
  for (let i = 0; i < scored.length && sources.length < MAX_POINTS; i++) {
    const row = scored[i].row;
    const before = lines.length;
    const cardCount = renderRow(row, cards, mistakes, mastered, lines);
    const block = lines.slice(before).join('\n');
    if (used + block.length + 1 > MAX_CHARS) { lines.length = before; break; }
    used += block.length + 1;
    sources.push({
      uid: row.unitId + '::' + row.point.id,   // 列表渲染键（kpId 仅单元内唯一，必须带上 unitId）
      unitTitle: row.unitTitle,
      unitId: row.unitId,
      kpId: row.point.id,
      topic: clip(row.point.topic, 30),
      score: scored[i].score,
      cards: cardCount
    });
  }
  if (!sources.length) return null;
  return { text: lines.join('\n').slice(0, MAX_CHARS), sources: sources };
}

/** 错题过滤：同学科优先，同错因的排前面（错因只是排序信号，不参与任何判定） */
function filterMistakes(subject, errorType, mistakes) {
  const list = Array.isArray(mistakes) ? mistakes : [];
  const same = list.filter(m => m && (!subject || !m.subject || m.subject === subject));
  if (!errorType) return same;
  return same.slice().sort((a, b) =>
    ((b.errorType === errorType) ? 1 : 0) - ((a.errorType === errorType) ? 1 : 0));
}

module.exports = {
  MIN_SCORE, MAX_POINTS, MAX_CHARS,
  clean, tokenize, queryTokens, clip, flatten, scoreRow, buildMastered, buildRecall
};

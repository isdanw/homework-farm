/**
 * evidenceLadder.js —— 知识点「证据覆盖程度」L0–L6 判定（端上纯函数，不依赖 wx，测试脚本可直接 require）
 *
 * 口径（与产品文档一致，**改动必须同步文档**）：
 *   L0 无记录 → L1 有学习活动 → L2 有订正证据 → L3 独立提取达标（复测达标且独立完成）
 *   → L4 间隔后稳定（首末两次达标间隔 ≥7 天）→ L5 变式迁移 → L6 多情境稳定
 *
 * ⚠️ 这不是能力等级，也不是掌握百分比。它只回答一件事：**系统里攒下了第几层记录**。
 *    所以文案一律用「有没有这类记录」的口气，绝不出现「已掌握 / 学会了 / 精通」。
 *
 * 只读边界：本模块不写任何数据、不判分、不产生 evidence，只把已有的
 * cards / mistakes / reviews / evidence / transfers 折叠成一个档位；输入对象不被修改。
 *
 * 达标阈值在**本模块内独立复核**（不复用记录上的 passed 字段）：
 *   ≥5 题 且 正确率 ≥80% 且 factGrade='server_recorded' 且 independence='self_declared_no_hint'
 *   —— 兼容路径（client_claimed，答案由客户端回传）与「提示后完成」都不算独立达标。
 *
 * L5/L6 的记录源有两条，都带 unitId/kpId：
 *   ① 变式复测证据：tutorRetest 以 kind='variant' 建 attempt，标签随证据落库（evidenceKind/context）。
 *      题仍由服务端判、独立性仍由孩子声明，只是这批题换了情境，所以够格证明「迁移」。
 *      context 走服务端白名单（换数字/换问法/生活情境/图形与表格/易错边界），
 *      情境去重才不会被自由文本随口凑出来。
 *   ② 显式 transfers 入参：给后续别的记录源（如导学单回执落 kpId）留的口，形状同 evidence 派生。
 * 两条都没记录时最高只到 L4 —— 宁可不亮，也不脑补。
 */

/** 达标硬阈值（与云函数 tutorRetest 的 RETEST_COUNT / PASS_RATE 同口径） */
const MIN_ITEMS = 5;
const MIN_RATE = 0.8;
/** L4 间隔口径：首末两次独立达标的间隔天数 */
const SPAN_DAYS = 7;
const DAY_MS = 86400000;

/** 学科组：同一层在不同学科说法不同（理科讲「题」，语言讲「材料」，文综讲「复述」） */
const SUBJECT_GROUPS = {
  math: 'science', physics: 'science', chemistry: 'science', biology: 'science',
  chinese: 'language', english: 'language',
  history: 'humanities', geography: 'humanities', politics: 'humanities'
};

const LEVELS = [0, 1, 2, 3, 4, 5, 6];

/** 每层在各学科组下的说法：只描述「这一层有没有记录」 */
const LABELS = {
  science: [
    '还没有这类记录',
    '做过这类题',
    '错过，也订正过',
    '独立做完一套，题量和正确率都够',
    '隔了些天再测，仍然够',
    '换条件/换情境的变式也能独立做',
    '好几种情境里都能独立做'
  ],
  language: [
    '还没有这类记录',
    '读过、背过或写过',
    '错过，也订正过错字错词',
    '独立默写/朗读一遍，题量和正确率都够',
    '隔了些天再默再读，仍然够',
    '换一篇新材料也用得上（需变式记录）',
    '几篇不同材料里都用得上（需多情境记录）'
  ],
  humanities: [
    '还没有这类记录',
    '讲过一次',
    '答偏过，也订正过表述',
    '独立复述/作答一遍，题量和正确率都够',
    '隔了些天还能复述出来，仍然够',
    '换个角度提问也答得上（需变式记录）',
    '图表、材料、生活情境里都答得上（需多情境记录）'
  ],
  default: [
    '还没有这类记录',
    '有过学习动作',
    '有过订正',
    '独立做过一遍，题量和正确率都够',
    '隔了些天再做，仍然够',
    '换题型也能独立做',
    '多种情境里都能独立做'
  ]
};

/** 每层「还缺哪一层记录」——只说缺什么证据，不说孩子会不会 */
const NEXT_STEPS = {
  1: '在这个知识点上留一条学习记录（导学对话或复习卡）',
  2: '把这次做错的地方订正一遍，并标为已订正',
  3: '做一次复测：≥5 题、选「自己做的没看提示」，交卷由服务端判',
  4: '过 7 天以上再独立复测一次',
  5: '做一次换条件的变式，并把结果落到这个知识点的记录上',
  6: '在另一种情境（不同材料/图表/生活场景）再独立做一次'
};

/** 归一：只保留汉字/字母/数字，其余压成空格（不用 \p{...}，兼容低版本 JSC） */
function clean(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^0-9a-z一-龥]+/g, ' ')
    .trim();
}

function groupOf(subject) {
  return SUBJECT_GROUPS[subject] || 'default';
}

/**
 * 名称弱关联：清单点名与记录里的 topic 文本对上。
 * 相等直接命中；否则要求「短的能被长的包含」且短的至少 3 字 —— 避免「法」「数」这类
 * 单字/双字噪声把整份清单都点亮。命中后行上会标 link:'topic'，UI 需注明是同名关联。
 */
function sameTopic(a, b) {
  const x = clean(a), y = clean(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  return short.length >= 3 && long.indexOf(short) >= 0;
}

/** 独立达标复核：题量、正确率、判分方、独立性四项全过才算 */
function isVerified(e) {
  if (!e) return false;
  const total = Number(e.total) || 0;
  if (total < MIN_ITEMS) return false;
  const correct = Number(e.correct) || 0;
  const rate = e.rate != null && !isNaN(Number(e.rate)) ? Number(e.rate) : correct / total;
  if (rate < MIN_RATE) return false;
  if (e.factGrade !== 'server_recorded') return false;
  if (e.independence !== 'self_declared_no_hint') return false;
  return true;
}

/* ---------------- 单个知识点的证据折叠 ---------------- */

/**
 * 汇总一个必会点关联到的所有记录。
 * 关联优先级：unitId+kpId 精确 > topic 文本弱关联（旧数据 / 本地证据不带 kpId）。
 * 行上的 link 如实记录用了哪一种：'kp' | 'topic' | 'none'。
 */
function collect(point, unitId, data) {
  const cards = [], mistakes = [], reviews = [], attempts = [], verified = [], transfers = [];
  let byKp = false;

  const linkCard = (c) => {
    if (c.unitId && c.kpId) {
      if (c.unitId === unitId && c.kpId === point.id) { byKp = true; return true; }
      return false;
    }
    return sameTopic(c.topic, point.topic);
  };
  (data.cards || []).forEach(c => { if (c && c.subject === data.subject && linkCard(c)) cards.push(c); });
  (data.mistakes || []).forEach(m => {
    if (m && m.subject === data.subject && sameTopic(m.topic, point.topic)) mistakes.push(m);
  });
  (data.reviews || []).forEach(r => {
    if (r && r.subject === data.subject && sameTopic(r.topic, point.topic)) reviews.push(r);
  });
  (data.evidence || []).forEach(e => {
    if (!e || (e.subject && e.subject !== data.subject)) return;
    let hit = false;
    if (e.unitId && e.kpId) {
      hit = e.unitId === unitId && e.kpId === point.id;
      if (hit) byKp = true;
    } else {
      hit = sameTopic(e.topic, point.topic);
    }
    if (!hit) return;
    attempts.push(e);
    const ok = isVerified(e);
    if (ok) verified.push(e);
    // 变式复测（tutorRetest 建的 attempt 带 kind='variant'，标签随证据落库）就是 L5/L6 的记录源：
    // 题还是服务端判的、独立性还是孩子声明的，只是这批题「换了情境」，于是够格证明迁移。
    // 只有独立达标的变式才算数 —— 提示后完成的变式仍是「有订正动作」，不该升档。
    if (e.evidenceKind === 'variant' && ok) {
      transfers.push({ context: e.context || '', independent: true, source: 'evidence' });
    }
  });
  (data.transfers || []).forEach(t => {
    if (!t || !t.independent) return;
    let hit = false;
    if (t.unitId && t.kpId) {
      hit = t.unitId === unitId && t.kpId === point.id;
      if (hit) byKp = true;
    } else {
      hit = sameTopic(t.topic, point.topic);
    }
    if (hit) transfers.push(t);
  });

  // 关联强度如实上报：无记录 = none；只有文本弱关联 = topic（UI 需注明可能同名）；命中过 kpId = kp
  const linked = cards.length + mistakes.length + reviews.length + attempts.length + transfers.length;
  const link = linked === 0 ? 'none' : (byKp ? 'kp' : 'topic');
  return { cards, mistakes, reviews, attempts, verified, transfers, link };
}

/** 由汇总结果推出档位（逐级判定，任一层不满足即停在该层） */
function levelOf(sig) {
  const v = sig.verified.slice().sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  const activity = sig.cards.length > 0 || sig.mistakes.length > 0 ||
    sig.attempts.length > 0 || sig.transfers.length > 0;
  if (!activity) return 0;

  // 订正证据：错题已订正 / 复习窗口走过 / 做过复测但没到独立达标线 / 复习卡已毕业
  const corrected = sig.mistakes.some(m => m.status === 'corrected') ||
    sig.reviews.some(r => r.done === true) ||
    sig.attempts.some(e => !isVerified(e)) ||
    sig.cards.some(c => c.done === true);
  // 独立达标天然蕴含「有活动 + 有订正动作」，否则会出现「有达标证据却停在 L1」
  if (!(corrected || v.length)) return 1;
  if (!v.length) return 2;

  let level = 3;
  if (v.length >= 2) {
    const span = (Number(v[v.length - 1].createdAt) || 0) - (Number(v[0].createdAt) || 0);
    if (span >= SPAN_DAYS * DAY_MS) level = 4;
  }
  // L5 起必须有按知识点落库的变式/多情境记录；语言类没有这类记录时明确封顶 L4
  const contexts = Object.create(null);
  sig.transfers.forEach(t => { const k = clean(t.context); if (k) contexts[k] = 1; });
  const nCtx = Object.keys(contexts).length;
  if (level === 4 && sig.transfers.length >= 1) level = 5;
  if (level === 5 && sig.transfers.length >= 2 && nCtx >= 2) level = 6;
  return level;
}

/** 一行：档位 + 说法 + 还缺的记录 + 关联方式 */
function buildRow(point, unitId, unitTitle, data) {
  const sig = collect(point, unitId, data);
  const level = levelOf(sig);
  const group = groupOf(data.subject);
  const labelSet = LABELS[group] || LABELS.default;
  const counts = {
    cards: sig.cards.length,
    // Leitner 盒子毕业（不等于「掌握」，只是间隔重复走完了）
    graduatedCards: sig.cards.filter(c => c.done === true).length,
    mistakes: sig.mistakes.length,
    correctedMistakes: sig.mistakes.filter(m => m.status === 'corrected').length,
    attempts: sig.attempts.length,
    verified: sig.verified.length,
    transfers: sig.transfers.length
  };
  return {
    uid: unitId + '::' + point.id,
    unitId: unitId,
    unitTitle: unitTitle,
    kpId: point.id,
    topic: clip(point.topic, 30),
    level: level,
    label: labelSet[level] || '',
    nextStep: level >= 6 ? '' : (NEXT_STEPS[level + 1] || ''),
    link: sig.link,
    counts: counts
  };
}

function clip(text, max) {
  const s = String(text == null ? '' : text).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 主入口：把某学科的必会清单逐点折算成证据覆盖档位。
 * @param {Object} input { subject, units, cards, mistakes, reviews, evidence, transfers, }
 * @returns {{subjectGroup:string, rows:Array, summary:Object}}
 */
function buildLadder(input) {
  const data = input || {};
  const units = Array.isArray(data.units) ? data.units : [];
  const rows = [];
  units.forEach(u => {
    if (!u || !Array.isArray(u.points)) return;
    const unitId = String(u.id || '');
    u.points.forEach(p => {
      if (!p || !p.id) return;
      rows.push(buildRow(p, unitId, clip(u.title, 30), {
        subject: data.subject,
        cards: data.cards, mistakes: data.mistakes, reviews: data.reviews,
        evidence: data.evidence, transfers: data.transfers
      }));
    });
  });

  const counts = [0, 0, 0, 0, 0, 0, 0];
  rows.forEach(r => { counts[r.level]++; });
  return {
    subjectGroup: groupOf(data.subject),
    rows: rows,
    summary: {
      total: rows.length,
      counts: counts,
      // 只统计「证据覆盖到第几层」的分布，不折算成百分比或能力分数
      reachedL3: rows.filter(r => r.level >= 3).length,
      reachedL4: rows.filter(r => r.level >= 4).length,
      topicLinked: rows.filter(r => r.link === 'topic').length,
      note: '这里统计的是「系统里攒到第几层记录」，不是能力等级，也不折算成百分比。'
    }
  };
}

module.exports = {
  MIN_ITEMS: MIN_ITEMS,
  MIN_RATE: MIN_RATE,
  SPAN_DAYS: SPAN_DAYS,
  LEVELS: LEVELS,
  LABELS: LABELS,
  NEXT_STEPS: NEXT_STEPS,
  SUBJECT_GROUPS: SUBJECT_GROUPS,
  clean: clean,
  clip: clip,
  groupOf: groupOf,
  sameTopic: sameTopic,
  isVerified: isVerified,
  levelOf: levelOf,
  buildLadder: buildLadder
};

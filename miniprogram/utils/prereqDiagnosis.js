/**
 * prereqDiagnosis.js —— 前置欠账「诊断假设」引擎（会话内纯函数）
 *
 * 思路来源：cn-math-taxonomy/diagnose/engine.js 的四步机制
 *   答错 → 基础确认题 → shaky/weak → 沿 hard 回溯 → roots 根因
 * 改造要点（见《前置诊断引擎移植_设计文档.md》）：
 *   1. 状态一律 provisional，永不写 done / 不产证据（对齐 tutorRetest 证据契约）。
 *   2. 三态不并入 E1-E9：只输出归因先验文本，不改 errorType。
 *   3. 不出真实题目：nextItem 只给「该考哪个点 / 哪个难度 / 是否确认题」的调度信号，
 *      题干取 point.assessmentPrompt || front，答案取 back；接入时由调用方挂题库。
 *
 * 约束：CommonJS、无 wx 依赖、纯函数（不改入参）、可被 Node 直接 require。
 */
'use strict';

/* ---------------- 难度四档（只作调度，不写进任何数据对象） ---------------- */

const DIFFICULTY_ORDER = ['basic', 'standard', 'challenge', 'advanced'];

/** 四档 → examService 的 difficulty:1..3（保守映射，防超纲） */
const EXAM_DIFFICULTY = { basic: 1, standard: 1, challenge: 2, advanced: 3 };

function toExamDifficulty(d) {
  return EXAM_DIFFICULTY[d] || 1;
}

/**
 * 出题难度调度。
 * @param {object} s { consecutiveCorrect, phase, box }
 *   phase='confirm' 强制回退 basic；box 为闪卡 Leitner 盒号（1..5），给定时决定起点。
 */
function pickDifficulty(s) {
  const o = s || {};
  if (o.phase === 'confirm') return 'basic';
  const corrects = Math.max(0, Number(o.consecutiveCorrect) || 0);
  if (o.box != null) {
    const b = Math.max(1, Math.min(5, Number(o.box) || 1));
    if (b <= 1) return 'basic';
    if (b <= 3) return 'standard';
    return 'challenge';
  }
  const ladder = ['standard', 'challenge', 'advanced'];
  return ladder[Math.min(corrects, ladder.length - 1)];
}

/** 同日到期卡排序：dueAt 优先，其次 box 升序（弱卡先出 basic）。返回新数组，不改原对象。 */
function sortCardsForReview(cards) {
  return (Array.isArray(cards) ? cards : [])
    .map((c, i) => ({ c: c, i: i }))
    .sort((a, b) => {
      const da = Number(a.c && a.c.dueAt) || 0;
      const db = Number(b.c && b.c.dueAt) || 0;
      if (da !== db) return da - db;
      const ba = Number(a.c && a.c.box) || 1;
      const bb = Number(b.c && b.c.box) || 1;
      if (ba !== bb) return ba - bb;
      return a.i - b.i;                       // 稳定排序
    })
    .map(x => x.c);
}

/* ---------------- 建图 ---------------- */

/** kpId 优先、topic 兜底（与 tutorStore 的防跨单元撞名契约一致） */
function refKey(p) {
  if (!p) return '';
  const kid = String(p.kpId || '').trim();
  if (kid) return 'K:' + kid;
  const t = String(p.topic || '').trim();
  return t ? 'T:' + t : '';
}

function cloneSession(s) {
  return {
    limit: s.limit, confirm: s.confirm, seed: s.seed,
    nodes: s.nodes,                         // 建图后只读，不修改
    order: s.order, pos: s.pos, reverse: s.reverse,
    scope: s.scope,
    stack: s.stack.slice(),
    status: Object.assign({}, s.status),
    attempts: Object.assign({}, s.attempts),   // 各数组在写入时整体替换
    counters: Object.assign({}, s.counters),
    answers: s.answers.slice(),
    current: s.current ? Object.assign({}, s.current) : null
  };
}

/**
 * 建图：nodes / 拓扑序 / 祖先集 / 反向依赖。
 * prereqs 里找不到的前置记为 external，只记录、不入栈（不能凭空造可测点）。
 */
function buildGraph(points) {
  const nodes = Object.create(null);
  (Array.isArray(points) ? points : []).forEach(p => {
    const k = refKey(p);
    if (!k || nodes[k]) return;
    nodes[k] = {
      key: k,
      topic: String(p.topic || p.name || ''),
      kpId: String(p.kpId || ''),
      prereqs: (Array.isArray(p.prereqs) ? p.prereqs : []).map(r => ({
        key: refKey(r),
        topic: String((r && r.topic) || ''),
        strength: (r && r.strength) === 'soft' ? 'soft' : 'hard',
        reason: String((r && r.reason) || '')
      })).filter(r => r.key),
      prompt: String(p.assessmentPrompt || p.front || ''),
      answer: String(p.back || ''),
      isTestable: true
    };
  });

  // 反向依赖：key → 依赖它的后置点（用于算 path 后代）
  const reverse = Object.create(null);
  Object.keys(nodes).forEach(k => {
    nodes[k].prereqs.forEach(r => {
      if (!reverse[r.key]) reverse[r.key] = [];
      reverse[r.key].push(k);
    });
  });

  return { nodes: nodes, reverse: reverse };
}

/** 从 targets 反向收集所有祖先（hard + soft），防环 */
function ancestorSet(nodes, targets) {
  const seen = Object.create(null);
  const walk = (k) => {
    if (seen[k] || !nodes[k]) return;
    seen[k] = true;
    nodes[k].prereqs.forEach(r => walk(r.key));
  };
  targets.forEach(walk);
  return seen;
}

/** DFS 拓扑：先修在前；环内节点按访问序兜底，不死循环 */
function topoSort(nodes, scope) {
  const order = [];
  const state = Object.create(null);        // 0 未访问 / 1 在栈 / 2 完成
  const visit = (k) => {
    if (!nodes[k] || !scope[k] || state[k]) return;
    state[k] = 1;
    // hard 先、soft 后
    nodes[k].prereqs.slice().sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'hard' ? -1 : 1))
      .forEach(r => visit(r.key));
    state[k] = 2;
    order.push(k);
  };
  Object.keys(scope).forEach(visit);
  return order;
}

/**
 * 创建会话。
 * @param {object} input { points, targets, limit=16, confirm=5, seed }
 *   points  : [{ topic, kpId?, prereqs:[{topic,kpId?,strength,reason}], assessmentPrompt?, front?, back? }]
 *   targets : 目标 topic/kpId 数组；不传则取全部点
 */
function createSession(input) {
  const o = input || {};
  const g = buildGraph(o.points);
  const all = Object.keys(g.nodes);
  // targets 兼容三种写法：内部 key / 纯 topic 字符串 / {topic,kpId}。
  // 点带 kpId 时节点键是 K:*，纯字符串需按 topic 名反查，否则会静默丢目标。
  const raw = (Array.isArray(o.targets) && o.targets.length) ? o.targets : all;
  const wanted = [];
  raw.forEach(t => {
    const key = typeof t === 'string' ? refKey({ topic: t }) : refKey(t);
    if (g.nodes[key]) { if (wanted.indexOf(key) < 0) wanted.push(key); return; }
    const name = typeof t === 'string' ? t : String((t && t.topic) || '');
    if (!name) return;
    all.forEach(k => {
      if (g.nodes[k].topic === name && wanted.indexOf(k) < 0) wanted.push(k);
    });
  });
  const targets = wanted.filter(k => !!g.nodes[k]);
  const scope = ancestorSet(g.nodes, targets);
  const order = topoSort(g.nodes, scope);
  const pos = Object.create(null);
  order.forEach((k, i) => { pos[k] = i; });
  // 初始 stack 只放目标，拓扑倒序（离目标最近的先问）；祖先在答错后才回溯
  const stack = targets.slice().sort((a, b) => (pos[b] || 0) - (pos[a] || 0));
  return {
    limit: Math.max(1, Number(o.limit) || 16),
    confirm: Math.max(1, Number(o.confirm) || 5),
    seed: String(o.seed || 'default'),
    nodes: g.nodes,
    reverse: g.reverse,
    order: order, pos: pos, scope: scope,
    stack: stack,
    status: Object.create(null),
    attempts: Object.create(null),
    counters: Object.create(null),
    answers: [],
    current: null
  };
}

/* ---------------- 出题信号 ---------------- */

function counterOf(s, k) {
  return s.counters[k] || { corrects: 0, fails: 0, confirmPending: false };
}

function nextItem(session) {
  if (!session) return null;
  if (session.answers.length >= session.limit) return null;
  const key = session.stack.find(k =>
    session.nodes[k] && session.nodes[k].isTestable && !session.status[k]
  );
  if (!key) return null;
  const n = session.nodes[key];
  const c = counterOf(session, key);
  const phase = c.confirmPending ? 'confirm' : 'probe';
  const attempt = (session.attempts[key] || []).length + 1;
  const difficulty = pickDifficulty({
    consecutiveCorrect: c.corrects,
    phase: phase,
    box: null
  });
  return {
    topicId: key,
    topic: n.topic,
    kpId: n.kpId,
    phase: phase,
    attempt: attempt,
    difficulty: difficulty,
    examDifficulty: toExamDifficulty(difficulty),
    qid: key + '#' + attempt + '|' + phase + '|' + difficulty,
    prompt: n.prompt,
    answer: n.answer,
    // 会话内推定，不是证据
    isEvidence: false
  };
}

/* ---------------- 状态机 ---------------- */

function setCounter(s, k, c) {
  const next = Object.assign({}, s.counters);
  next[k] = c;
  s.counters = next;
}

function pushAnswer(s, item, result) {
  const list = (s.attempts[item.topicId] || []).slice();
  list.push({ qid: item.qid, result: result, phase: item.phase });
  const next = Object.assign({}, s.attempts);
  next[item.topicId] = list;
  s.attempts = next;
  s.answers.push({
    topicId: item.topicId, topic: item.topic, qid: item.qid,
    result: result, phase: item.phase, difficulty: item.difficulty
  });
}

function markMastered(s, k) {
  if (s.status[k]) return;
  s.status[k] = { s: 'provisionalMastered', src: 'direct' };
  // 掌握向上推断祖先；不覆盖任何已判定的状态（尤其不覆盖 weak）
  const seen = Object.create(null);
  const walk = (key) => {
    if (seen[key] || !s.nodes[key]) return;
    seen[key] = true;
    s.nodes[key].prereqs.forEach(r => {
      if (!s.status[r.key]) s.status[r.key] = { s: 'provisionalMastered', src: 'inferred' };
      walk(r.key);
    });
  };
  walk(k);
}

function markWeak(s, k) {
  s.status[k] = { s: 'weak', src: 'direct' };
  // hard 先、soft 后压到栈首；只收可测、在 scope 内、尚未判定的前置
  const cand = s.nodes[k].prereqs
    .slice()
    .sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'hard' ? -1 : 1))
    .map(r => r.key)
    .filter(key => s.nodes[key] && s.nodes[key].isTestable && s.scope[key] && !s.status[key]);
  s.stack = cand.concat(s.stack);
}

/**
 * 提交一次作答，返回新 session（不改入参）。
 * @param result 'correct' | 'wrong' | 'skip'
 */
function applyAnswer(session, result) {
  const item = session.current || nextItem(session);
  if (!item) return session;
  const r = (result === 'correct' || result === 'wrong' || result === 'skip') ? result : 'skip';
  const s = cloneSession(session);
  s.current = null;
  pushAnswer(s, item, r);
  const c = Object.assign({}, counterOf(s, item.topicId));

  if (item.phase === 'confirm') {
    c.confirmPending = false;
    if (r === 'correct') {
      s.status[item.topicId] = { s: 'shaky', src: 'direct' };
    } else {
      markWeak(s, item.topicId);
    }
    setCounter(s, item.topicId, c);
    return s;
  }

  if (r === 'correct') {
    c.corrects += 1;
    setCounter(s, item.topicId, c);
    if (c.corrects >= s.confirm && c.fails === 0) markMastered(s, item.topicId);
    return s;
  }

  // 首次答错：先出基础确认题，不立刻下结论；无题可出才直接 weak
  c.fails += 1;
  c.corrects = 0;
  const used = (s.attempts[item.topicId] || []).length;
  if (used < 4) {
    c.confirmPending = true;
    setCounter(s, item.topicId, c);
    return s;
  }
  c.confirmPending = false;
  setCounter(s, item.topicId, c);
  markWeak(s, item.topicId);
  return s;
}

/** 把 nextItem 的结果挂到 session 上（便于调用方先展示题目再提交） */
function peek(session) {
  const item = nextItem(session);
  if (!item) return { session: session, item: null };
  const s = cloneSession(session);
  s.current = item;
  return { session: s, item: item };
}

/* ---------------- 汇总 ---------------- */

function row(s, k) {
  const st = s.status[k] || {};
  return {
    key: k, topic: (s.nodes[k] && s.nodes[k].topic) || k,
    kpId: (s.nodes[k] && s.nodes[k].kpId) || '',
    s: st.s || '', src: st.src || ''
  };
}

function buildHint(roots, shaky, weak, e1e9Prior) {
  const lines = [];
  if (roots.length) lines.push('根因（基础确认题也错，先补前置）：' + roots.map(r => r.topic).slice(0, 8).join('、'));
  if (shaky.length) lines.push('不稳（首错但基础题答对）：' + shaky.map(r => r.topic).slice(0, 8).join('、'));
  if (weak.length) lines.push('本点未打牢：' + weak.map(r => r.topic).slice(0, 8).join('、'));
  if (!lines.length) return { blindSpotHint: '', e1e9Hint: '' };
  return {
    blindSpotHint: '【前置欠账·诊断假设，非证据】\n' + lines.join('\n') + '\n适当降低难度，先考根因知识点。',
    e1e9Hint: '【归因先验·不改 errorType】\n' + e1e9Prior.join('\n') +
      '\n以上均为会话内诊断假设，不足以判定掌握；掌握须走复测证据契约。'
  };
}

function summarize(session) {
  const s = session || createSession({ points: [] });
  const keys = Object.keys(s.status);
  const status = Object.create(null);
  keys.forEach(k => { status[k] = row(s, k); });

  const mastered = keys.filter(k => s.status[k].s === 'provisionalMastered').map(k => row(s, k));
  const shaky = keys.filter(k => s.status[k].s === 'shaky').map(k => row(s, k));
  const weak = keys.filter(k => s.status[k].s === 'weak').map(k => row(s, k));
  const weakSet = Object.create(null);
  weak.forEach(r => { weakSet[r.key] = true; });

  // roots = weak 且没有 weak 的 hard 先修
  const roots = weak.filter(r => {
    const pr = (s.nodes[r.key] && s.nodes[r.key].prereqs) || [];
    return !pr.some(p => p.strength === 'hard' && weakSet[p.key]);
  });

  // path = roots ∪ shaky 及其后代，去掉已推定掌握
  const pathSet = Object.create(null);
  const queue = roots.concat(shaky).map(r => r.key);
  queue.forEach(k => { pathSet[k] = true; });
  while (queue.length) {
    const k = queue.shift();
    (s.reverse[k] || []).forEach(next => {
      if (s.scope[next] && !pathSet[next] && !(s.status[next] && s.status[next].s === 'provisionalMastered')) {
        pathSet[next] = true;
        queue.push(next);
      }
    });
  }
  const path = Object.keys(pathSet).map(k => row(s, k));

  const prior = [];
  if (shaky.length) prior.push('· 首错但基础确认题答对 → 优先复核 E1 审题 / E7 信息处理 / E9 检查迁移，别急着判「概念不会」。');
  if (weak.length) prior.push('· 基础确认题也错 → 优先复核 E2 概念 / E3 表征，不是本次粗心。');
  if (roots.length) prior.push('· 存在前置根因 → 不要把 E2 归到当前点，应归到根因对应的前置知识点。');
  const hints = buildHint(roots, shaky, weak, prior);

  return {
    status: status,
    roots: roots, shaky: shaky, weak: weak, provisionalMastered: mastered,
    path: path,
    blindSpotHint: hints.blindSpotHint,
    e1e9Hint: hints.e1e9Hint,
    answerCount: s.answers.length,
    // 红线：本模块永不产证据、永不写 done
    isEvidence: false
  };
}

module.exports = {
  DIFFICULTY_ORDER, EXAM_DIFFICULTY,
  toExamDifficulty, pickDifficulty, sortCardsForReview,
  refKey, createSession, nextItem, peek, applyAnswer, summarize
};

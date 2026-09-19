/**
 * tutorStore.js —— 全科导学「会话」本地存储层（P1）
 *
 * 与主数据 store.js 解耦：导学对话内容较长、且会跨多轮累积，若混入主数据
 * （syncData 全量上云）会显著增大同步体量。这里用独立 storage key 按 openid 隔离，
 * 云端归档由 tutorChat(archive) 单独写 tutor_sessions 集合完成。
 *
 * 本地结构：
 * {
 *   sessions: [{
 *     id,            // 会话 id（uid 'ts'）
 *     subject,       // 学科 key：math/chinese/english
 *     subjectName,   // 学科展示名：数学/语文/英语
 *     messages: [{ role:'user'|'assistant', content, ts }],
 *     createdAt,
 *     closed: false, closedAt: 0
 *   }],
 *   mistakes: [{     // 错题本（P2）：导学诊断出的卡点
 *     id, subject, subjectName, topic, errorType(E1-E9), errorDesc, suggestion,
 *     status: 'pending'|'corrected', createdAt
 *   }],
 *   evidence: [{     // 复测证据（P3）：复测 ≥5 题且 ≥80% 才形成
 *     id, subject, subjectName, topic, errorType, total, correct, rate,
 *     passed: true|false, createdAt
 *   }],
 *   reviews: [{      // 复习窗口（闭环 S2）：归档诊断派生，复测证据驱动推进
 *     id, mistakeId, subject, subjectName, topic, errorType,
 *     stage: 1-5, dueAt, done: false, createdAt, updatedAt
 *   }],
 *   removed: [{ kind, id, at }],// 本地已删条目墓碑：pull 回填时跳过，防「删了又回来」
 *   pushQueue: [{ kind, id }],  // 待补写云端的数据（离线/失败回补，push 成功后清空）
 *   lastSyncAt: 0
 * }
 *
 * 【数据契约 · 2026-09-18 与 store.js 同一套（见其文件头 R1–R7）】
 *   · R4 字段只增不改不删：新增字段必须在 readAll() 的兜底里给默认值。
 *   · R6 读云端一律「全字段透传」：只剔除云端的库内字段（_id/openid/clientId/cloudId），
 *       绝不按业务字段白名单裁剪 —— 否则以后给错题加个 imageUrl，换设备拉回来就静默丢了。
 *   · R7 写操作在数据层内部完成「落盘 + 登记上云队列」两件事，调用方不可能漏推。
 */
const store = require('./store.js');
const util = require('./util.js');

const BASE_KEY = 'wb_hwfarm_tutor_v1';

/* 艾宾浩斯复习档位（天）：与云函数 tutorChat / tutorRetest 保持一致 */
const REVIEW_STAGE_DAYS = [1, 2, 4, 7, 15];

/* 同步节流：60 秒内不重复 pull */
const SYNC_THROTTLE_MS = 60000;

/* 有改动登记后的合并推送延迟：连续 3 次写操作只触发 1 次云调用 */
const FLUSH_DEBOUNCE_MS = 1500;

/* 本地持有的四个集合 */
const KINDS = ['sessions', 'mistakes', 'evidence', 'reviews'];

function storageKey() {
  const oid = store.getOpenid();
  return oid ? `${BASE_KEY}_${oid}` : `${BASE_KEY}_guest`;
}

function blank() {
  return { sessions: [], mistakes: [], evidence: [], reviews: [], removed: [], pushQueue: [], lastSyncAt: 0 };
}

let _probeOid = '';            // 已探查过 _guest 空间的 openid（按身份各探一次）

function readAll() {
  let raw = null;
  try { raw = wx.getStorageSync(storageKey()); } catch (e) {}
  const all = (raw && Array.isArray(raw.sessions)) ? raw : blank();
  if (!Array.isArray(all.mistakes)) all.mistakes = [];
  if (!Array.isArray(all.evidence)) all.evidence = [];
  if (!Array.isArray(all.reviews)) all.reviews = [];
  if (!Array.isArray(all.pushQueue)) all.pushQueue = [];
  if (!Array.isArray(all.removed)) all.removed = [];
  // 身份已确认且本进程还没为该身份探查过 → 探一次 _guest 空间（F9）。
  // 未确认身份时绝不动 guest 空间（那是当前唯一的数据落点，动了就是丢数据）。
  const oid = store.getOpenid() || '';
  if (oid && _probeOid !== oid) {
    _probeOid = oid;
    return adoptGuestData(all);
  }
  return all;
}

/**
 * F9 —— 把 `_guest` 命名空间的导学数据继承进当前账号命名空间（懒迁移）。
 *
 * 【为什么必须做】storageKey() 依赖 store.getOpenid()。身份未确认（whoami 失败降级，
 * 见 store.js initAccount）时写入落 `_guest`；随后身份恢复或用户点「绑定微信」，
 * storageKey() 变成 `_<openid>`，`_guest` 里的错题/复习窗口就**永远读不到**了 ——
 * 用户视角就是「绑定微信之后错题少了一批」。
 *
 * 【为什么放在读取路径上】initAccount / bindWechat 都在 store.js 里，而 tutorStore
 * 单向依赖 store（反向 require 会成环）。懒迁移让任何调用方都无需记得迁移，也不会漏调。
 * 按 id 合并、只补本地缺的条目，因此重复执行是幂等的。
 */
function adoptGuestData(cur) {
  if (!store.getOpenid()) return cur;              // 自己就是 guest → 无需迁移
  const guestKey = `${BASE_KEY}_guest`;
  let guest = null;
  try { guest = wx.getStorageSync(guestKey); } catch (e) { return cur; }
  if (!guest || !Array.isArray(guest.sessions)) return cur;

  let changed = false;
  KINDS.forEach(kind => {
    (Array.isArray(guest[kind]) ? guest[kind] : []).forEach(g => {
      if (!g || !g.id) return;
      if (cur[kind].some(x => x.id === g.id)) return;
      cur[kind].push(g);
      changed = true;
    });
  });
  (guest.removed || []).forEach(t => {
    if (!t || !t.id) return;
    if (cur.removed.some(x => x.kind === t.kind && x.id === t.id)) return;
    cur.removed.push(t);
    changed = true;
  });
  (guest.pushQueue || []).forEach(q => {
    if (!q || !q.id) return;
    if (cur.pushQueue.some(x => x.kind === q.kind && x.id === q.id)) return;
    cur.pushQueue.push(q);
    changed = true;
  });
  if (changed) {
    if (!cur.lastSyncAt) cur.lastSyncAt = Number(guest.lastSyncAt) || 0;
    try { wx.setStorageSync(storageKey(), cur); } catch (e) {}
    try { wx.removeStorageSync(guestKey); } catch (e) {}     // 迁移完成即删，避免下次重复并入
  }
  return cur;
}

function writeAll(data) {
  try { wx.setStorageSync(storageKey(), data); } catch (e) {}
}

/* ======================= 写操作出口（落盘 + 自动登记上云） =======================
 * 背景（修 P1-2）：此前「写本地」与「登记补推」是两步、由调用方各自负责，于是
 * mistakes.js 改了错题状态却没 queuePush → 手动标「已订正」永不进云，换设备后状态回退；
 * confirm.js 建了复习窗口同样漏推。现在把两件事收进数据层，调用方想漏也漏不掉。
 */
const MAX_QUEUE = 500;
const MAX_TOMB = 500;

/** 登记待补推上云的条目（按 kind+id 幂等，超限丢最旧） */
function enqueue(all, kind, id) {
  if (!kind || !id) return;
  if (!Array.isArray(all.pushQueue)) all.pushQueue = [];
  if (all.pushQueue.some(q => q.kind === kind && q.id === id)) return;
  all.pushQueue.push({ kind: kind, id: id });
  if (all.pushQueue.length > MAX_QUEUE) all.pushQueue = all.pushQueue.slice(-MAX_QUEUE);
}

/** 登记删除墓碑（本地已删 → pull 回填时不得复活） */
function bury(all, kind, id) {
  if (!kind || !id) return;
  if (!Array.isArray(all.removed)) all.removed = [];
  if (all.removed.some(t => t.kind === kind && t.id === id)) return;
  all.removed.push({ kind: kind, id: id, at: Date.now() });
  if (all.removed.length > MAX_TOMB) all.removed = all.removed.slice(-MAX_TOMB);
}

function isBuried(all, kind, id) {
  return (all.removed || []).some(t => t.kind === kind && t.id === id);
}

/**
 * 写操作的唯一出口。
 * @param {Object} all     本次变更后的完整本地对象
 * @param {Array}  queues  需要补推上云的 [{kind,id}]（可选）
 * @param {Array}  buries  需要登记墓碑的 [{kind,id}]（可选）
 */
function commit(all, queues, buries) {
  (queues || []).forEach(q => enqueue(all, q.kind, q.id));
  (buries || []).forEach(t => bury(all, t.kind, t.id));
  writeAll(all);
  if ((queues || []).length) scheduleFlush();      // 登记了改动 → 合并推一次
  return all;
}

/** 全部会话（按创建时间倒序） */
function getSessions() {
  const all = readAll();
  return all.sessions.slice().sort((a, b) => b.createdAt - a.createdAt);
}

/** 某学科「进行中」（未关闭）的会话；没有则 null */
function getActive(subject) {
  const all = readAll();
  return all.sessions.find(s => s.subject === subject && !s.closed) || null;
}

/** 新建会话（同一学科同时只保留一个进行中会话；已有进行中则直接返回它） */
function newSession(subject, subjectName) {
  const existing = getActive(subject);
  if (existing) return existing;
  const all = readAll();
  const s = {
    id: util.uid('ts'),
    subject: subject,
    subjectName: subjectName || subject,
    messages: [],
    createdAt: Date.now(),
    closed: false,
    closedAt: 0
  };
  all.sessions.push(s);
  commit(all);                        // 新建的空会话不推云：云端 tutor_sessions 只存已归档会话
  return s;
}

/** 追加一条消息（role: user/assistant） */
function appendMessage(sessionId, msg) {
  const all = readAll();
  const s = all.sessions.find(x => x.id === sessionId);
  if (!s) return null;
  s.messages.push({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: (msg.content || '').trim(),
    ts: msg.ts || Date.now()
  });
  commit(all);
  return s;
}

/** 关闭会话（标记归档完成）—— 同时登记上云：归档云函数失败时由 tutorSync(push) 回补
 *  （push 按 clientId 幂等，归档已成功则只会 skip，不会产生重复） */
function closeSession(sessionId) {
  const all = readAll();
  const s = all.sessions.find(x => x.id === sessionId);
  if (!s) return null;
  s.closed = true;
  s.closedAt = Date.now();
  commit(all, [{ kind: 'sessions', id: s.id }]);
  return s;
}

/** 删除会话。
 *  ⚠️ 云端 tutor_sessions 是「归档证据」，不做物理删除；本地登记墓碑，pull 时不再回填。
 *     否则删掉后一进导学页 pull 一次，会话就复活了。 */
function removeSession(sessionId) {
  const all = readAll();
  const i = all.sessions.findIndex(x => x.id === sessionId);
  if (i < 0) return;
  all.sessions.splice(i, 1);
  all.pushQueue = all.pushQueue.filter(q => !(q.kind === 'sessions' && q.id === sessionId));
  commit(all, null, [{ kind: 'sessions', id: sessionId }]);
}

/** 已归档（关闭）会话数 */
function archiveCount() {
  return getSessions().filter(s => s.closed).length;
}

/* ======================= 错题本（P2） ======================= */

/**
 * 错题来源枚举 —— 三端（小程序 / 云函数 / 工作台）唯一口径，改这里要同步改
 * `cloudfunctions/webAdminWrite` 与工作台的 md-to-cloud 映射。
 *
 * 【两个正交的轴，别混】
 *   · `source`     = **录入路径**：photo 拍照/OCR收录 | tutor 导学对话(tutorChat)收录 | manual 手工录入
 *   · `markSource` = **对错判定来源**：marked 图上已有批改 | ai AI 判定 | none 未知
 *
 * 【为什么保留 manual 而不是并进 tutor】（2026-09-18 定案，推翻审计报告当时的建议）
 *   审计时提的是「收敛为 photo|tutor，验证等级另设字段」。复核后否定该方案：
 *   manual 是真实存在且语义独立的第三条录入路径，把它并进 tutor 会**永久丢失信息**，
 *   违反项目最基本的「只增字段、不改语义」——而这种丢失是不可逆的，改回去也回不来。
 *   「验证等级」诉求本就由 markSource 这条独立的轴承载，不需要靠合并 source 来腾位置。
 *
 * 【历史事故】`tutorChat` 写 `'manual'`、本地默认 `'tutor'`，而 addMistake 又把非 photo
 *   一律归一成 `'tutor'` → 同一条错题在两端拿到不同的 source，云端值被端上改写。
 *   现在两端都不再归一化，只做「非法值兜底」，合法值原样保留。
 */
const MISTAKE_SOURCES = ['photo', 'tutor', 'manual'];
const MISTAKE_MARK_SOURCES = ['marked', 'ai', 'none'];

/** 全部错题（按创建时间倒序） */
function getMistakes() {
  const all = readAll();
  return (all.mistakes || []).slice().sort((a, b) => b.createdAt - a.createdAt);
}

/** 新增一条错题（E1-E9 归因；可传 m.id 预生成 uid，保证与云端 clientId 一致）
 *  拍照收录增量字段：source(见 MISTAKE_SOURCES) / questionText 题干 / childAnswer 孩子作答 /
 *  markSource 对错判定来源(见 MISTAKE_MARK_SOURCES) —— 旧数据缺省兼容 */
function addMistake(m) {
  const all = readAll();
  const item = {
    id: m.id || util.uid('mk'),
    subject: m.subject || '',
    subjectName: m.subjectName || '',
    topic: m.topic || '',
    errorType: m.errorType || '',
    errorDesc: m.errorDesc || '',
    suggestion: m.suggestion || '',
    status: m.status || 'pending',   // pending 待重测 / corrected 已订正
    // 只对「非法/缺失」兜底，**不改写合法值**（manual 必须原样留下）
    source: MISTAKE_SOURCES.indexOf(m.source) >= 0 ? m.source : 'tutor',
    questionText: m.questionText || '',
    childAnswer: m.childAnswer || '',
    markSource: MISTAKE_MARK_SOURCES.indexOf(m.markSource) >= 0 ? m.markSource : 'none',
    createdAt: Date.now()
  };
  all.mistakes.unshift(item);
  commit(all, [{ kind: 'mistakes', id: item.id }]);
  return item;
}

/** 更新错题状态（pending 待重测 / corrected 已订正） */
function setMistakeStatus(id, status) {
  const all = readAll();
  const m = all.mistakes.find(x => x.id === id);
  if (!m) return false;
  m.status = status;
  // 自动登记上云（修 P1-2：此前 mistakes.js 只写本地，标记「已订正」换设备即回退）
  commit(all, [{ kind: 'mistakes', id: m.id }]);
  return true;
}

/** 错题总数 */
function mistakeCount() {
  return getMistakes().length;
}

/* ======================= 复测证据（P3） ======================= */

/** 全部复测记录（按创建时间倒序） */
function getEvidence() {
  const all = readAll();
  return (all.evidence || []).slice().sort((a, b) => b.createdAt - a.createdAt);
}

/** 新增一条复测记录（passed=true 才是「已验证」证据）
 *  可传 e.id 预生成 uid：必须与 tutorRetest 落库时的 clientId 一致，
 *  否则云端会存在「一条无 clientId 的直写记录 + 一条 push 回补记录」两份（P0-5 重复写）。 */
function addEvidence(e) {
  const all = readAll();
  const item = {
    id: e.id || util.uid('ev'),
    subject: e.subject || '',
    subjectName: e.subjectName || '',
    topic: e.topic || '',
    errorType: e.errorType || '',
    total: e.total || 0,
    correct: e.correct || 0,
    rate: e.rate || 0,
    passed: !!e.passed,
    createdAt: Date.now()
  };
  all.evidence.unshift(item);
  commit(all, [{ kind: 'evidence', id: item.id }]);
  return item;
}

/** 已达标（passed=true）的证据数 */
function evidencePassedCount() {
  return getEvidence().filter(e => e.passed).length;
}

/* ======================= 复习窗口（闭环 S2） ======================= */

/** 全部复习窗口（按到期时间正序：最紧急的在前） */
function getReviews() {
  const all = readAll();
  return (all.reviews || []).slice().sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
}

/** 今日到期（dueAt ≤ now 且未关闭），最早到期的在前 */
function getDueReviews(now) {
  const t = now || Date.now();
  return getReviews().filter(r => !r.done && (r.dueAt || 0) <= t);
}

/** 未关闭的复习窗口数 */
function reviewPendingCount() {
  return getReviews().filter(r => !r.done).length;
}

/** 新增/更新一条复习窗口（按 id 去重；返回该条） */
function upsertReview(rv) {
  if (!rv || !rv.id) return null;
  const all = readAll();
  const i = (all.reviews || []).findIndex(x => x.id === rv.id);
  const item = {
    id: rv.id,
    mistakeId: rv.mistakeId || '',
    subject: rv.subject || '',
    subjectName: rv.subjectName || '',
    topic: rv.topic || '',
    errorType: rv.errorType || '',
    stage: Math.max(1, Math.min(REVIEW_STAGE_DAYS.length, Number(rv.stage) || 1)),
    dueAt: Number(rv.dueAt) || (Date.now() + REVIEW_STAGE_DAYS[0] * 86400000),
    done: !!rv.done,
    createdAt: rv.createdAt || Date.now(),
    updatedAt: rv.updatedAt || Date.now()
  };
  if (i >= 0) all.reviews[i] = item;
  else all.reviews.unshift(item);
  // 自动登记上云：此前 confirm.js 建了复习窗口却没入队 → 本机之外看不到该窗口
  commit(all, [{ kind: 'reviews', id: item.id }]);
  return item;
}

/**
 * 推进复习窗口（只由复测证据驱动）：
 *   passed=true  → done=true（关闭）
 *   passed=false → stage+1（封顶 5），dueAt 顺延到下一档
 * 找不到对应窗口（如旧数据）→ no-op
 */
function advanceReview(mistakeId, passed) {
  if (!mistakeId) return null;
  const all = readAll();
  const r = (all.reviews || []).find(x => x.mistakeId === mistakeId && !x.done);
  if (!r) return null;
  if (passed) {
    r.done = true;
  } else {
    r.stage = Math.min((r.stage || 1) + 1, REVIEW_STAGE_DAYS.length);
    r.dueAt = Date.now() + (REVIEW_STAGE_DAYS[r.stage - 1] || 1) * 86400000;
  }
  r.updatedAt = Date.now();
  // 自动登记上云，且用的是 r.id ——调用方不必再猜窗口 id 的命名约定
  // （旧写法在 retest.js 里硬编码 'mistakeId + "_rv"'，命名一变就静默漏推）
  commit(all, [{ kind: 'reviews', id: r.id }]);
  return r;
}

/* ======================= 跨会话记忆（learnerContext，闭环 S3） ======================= */

/**
 * 组装「近期卡点快照」：该学科最近 3 条错题（topic + 错因 + 可观察表现）
 * 纯本地结构化字段拼接（不经 AI，防幻觉），上限 maxChars 字符
 */
function getLearnerContext(subject, maxChars) {
  const cap = maxChars || 1200;
  const items = getMistakes()
    .filter(m => m.subject === subject)
    .slice(0, 3)
    .map((m, i) => (i + 1) + ') 知识点「' + (m.topic || '未标注') + '」' +
      (m.errorType ? '（错因 ' + m.errorType + '）' : '') +
      (m.errorDesc ? '：' + m.errorDesc : ''));
  if (!items.length) return '';
  let text = items.join('；');
  if (text.length > cap) text = text.slice(0, cap);
  return text;
}

/* ======================= 云端同步（闭环 S1：pull 回填 + push 回补） ======================= */

/** 记录待补写云端的数据（幂等；一般由 commit() 自动调用，保留公开 API 供特殊场景使用） */
function queuePush(kind, id) {
  if (!kind || !id) return;
  const all = readAll();
  if (all.pushQueue.some(q => q.kind === kind && q.id === id)) return;
  commit(all, [{ kind: kind, id: id }]);
}

/* ---- 合并推送：连续多次写操作只发一次云调用 ---- */
let _flushTimer = null;

/** 有改动登记后，延迟合并推一次（pushQueued 本身可重入，队列为空时是 no-op） */
function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; pushQueued(); }, FLUSH_DEBOUNCE_MS);
}

/* ======================= 云端文档 → 本地条目（全字段透传） =======================
 * 【这不是白名单】白名单是「只留这些字段」，这里是「只去掉这些字段」。
 * 区别决定数据能否随迭代通用：以后给错题加 imageUrl、给证据加 durationSec、
 * 给会话加 modelName —— 只要写进云端文档，换设备拉回来就自动落进本地，
 * 无需改动本文件一行代码。旧实现逐字段列白名单，新字段会被静默丢掉（修 P1-1）。
 *
 * 只剔除三类「不属于业务数据」的字段：
 *   _id / _openid  云端库内标识（云端独有，端上无意义）
 *   clientId       云端用它承载本地 uid，端上统一叫 id
 *   cloudId        pull 时临时附加的 _id 别名
 */
const CLOUD_META = { _id: 1, _openid: 1, openid: 1, cloudId: 1, clientId: 1 };

/** 各集合的必填兜底：只在字段为 undefined 时补，绝不覆盖云端已给出的值 */
const CLOUD_DEFAULTS = {
  sessions: {
    subject: '', subjectName: '', messages: [], createdAt: 0,
    closed: true,            // 云端 tutor_sessions 存的都是已归档会话
    closedAt: 0
  },
  mistakes: {
    subject: '', subjectName: '', topic: '', errorType: '', errorDesc: '', suggestion: '',
    status: 'pending', source: 'tutor', questionText: '', childAnswer: '', markSource: 'none',
    createdAt: 0
  },
  evidence: {
    subject: '', subjectName: '', topic: '', errorType: '',
    total: 0, correct: 0, rate: 0, passed: false, createdAt: 0
  },
  reviews: {
    mistakeId: '', subject: '', subjectName: '', topic: '', errorType: '',
    stage: 1, dueAt: 0, done: false, createdAt: 0, updatedAt: 0
  }
};

/**
 * 把一条云端文档转成本地条目：① 云端字段全量拷贝 ② 归一 id ③ 必填兜底
 * @returns {Object|null} 无可用 id 时返回 null（不产生无主条目）
 */
function cloudToLocal(kind, cloud) {
  if (!cloud || typeof cloud !== 'object') return null;
  const out = {};
  Object.keys(cloud).forEach(k => { if (!CLOUD_META[k]) out[k] = cloud[k]; });
  out.id = String(cloud.clientId || cloud.id || cloud.cloudId || '');
  if (!out.id) return null;
  const def = CLOUD_DEFAULTS[kind] || {};
  Object.keys(def).forEach(k => { if (out[k] === undefined) out[k] = def[k]; });
  if (kind === 'sessions' && !out.closedAt) out.closedAt = Number(out.createdAt) || 0;
  // 关系字段兼容：review 的 mistakeId 在云端历史字段名下叫 mistakeClientId
  if (kind === 'reviews' && !out.mistakeId) out.mistakeId = cloud.mistakeClientId || '';
  return out;
}

/**
 * 云 → 本地回填（换设备/清缓存恢复）。
 * remote: tutorSync(pull) 返回 { sessions, mistakes, evidence, reviews }
 * 合并规则：
 *   · sessions / mistakes / evidence：按 id 并集，同 id 本地优先（本地是本机权威）
 *   · reviews：同 id 比 updatedAt，云端的更新则把云端字段全量覆盖过来
 *   · 任何被本地删过（removed 墓碑）的条目一律不回填
 */
function mergeFromCloud(remote) {
  if (!remote || typeof remote !== 'object') return { added: 0 };
  const all = readAll();
  let added = 0;

  ['sessions', 'mistakes', 'evidence'].forEach(kind => {
    (Array.isArray(remote[kind]) ? remote[kind] : []).forEach(cloud => {
      const local = cloudToLocal(kind, cloud);
      if (!local) return;
      if (isBuried(all, kind, local.id)) return;
      if (all[kind].some(x => x.id === local.id)) return;
      all[kind].push(local);
      added++;
    });
  });

  (Array.isArray(remote.reviews) ? remote.reviews : []).forEach(cloud => {
    const inc = cloudToLocal('reviews', cloud);
    if (!inc) return;
    if (isBuried(all, 'reviews', inc.id)) return;
    const i = all.reviews.findIndex(x => x.id === inc.id);
    if (i < 0) { all.reviews.unshift(inc); added++; return; }
    const cur = all.reviews[i];
    const lu = Number(cur.updatedAt) || 0;
    const cu = Number(inc.updatedAt) || Number(inc.createdAt) || 0;
    if (cu > lu) {
      // 云端更新（多半是另一台设备推进了复测）→ 云端字段全量覆盖，
      // 本地独有字段保留（不删除本地知道而云端不知道的东西）
      Object.keys(inc).forEach(k => { cur[k] = inc[k]; });
      cur.updatedAt = cu;
    }
  });

  all.lastSyncAt = Date.now();
  writeAll(all);
  return { added: added };
}

/**
 * 静默拉取云端 → 合并本地（tutorHub onLoad 调用）。
 * 60 秒节流；无 wx.cloud / 失败一律静默，不阻塞页面。
 * @returns {Promise<Object|null>} 成功返回 merge 结果，否则 null
 */
let _pulling = false;
function syncFromCloud() {
  return new Promise(resolve => {
    try {
      const all = readAll();
      if (_pulling) return resolve(null);
      if (all.lastSyncAt && Date.now() - all.lastSyncAt < SYNC_THROTTLE_MS) return resolve(null);
      if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return resolve(null);
      _pulling = true;
      wx.cloud.callFunction({
        name: 'tutorSync',
        data: { action: 'pull' }
      }).then(res => {
        _pulling = false;
        const r = res && res.result;
        if (r && r.ok) resolve(mergeFromCloud(r));
        else resolve(null);
      }).catch(() => { _pulling = false; resolve(null); });
    } catch (e) {
      _pulling = false;
      resolve(null);
    }
  });
}

/** 把待补写队列 push 上云（归档/复测成功后 fire-and-forget；失败留队下次再试） */
function pushQueued() {
  return new Promise(resolve => {
    try {
      const all = readAll();
      const queue = (all.pushQueue || []).slice(0, 200);
      if (!queue.length) return resolve({ ok: true, added: 0 });
      if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return resolve({ ok: false });

      const payload = { sessions: [], mistakes: [], evidence: [], reviews: [] };
      queue.forEach(q => {
        const arrName = { sessions: 'sessions', mistakes: 'mistakes', evidence: 'evidence', reviews: 'reviews' }[q.kind];
        if (!arrName) return;
        const item = (all[arrName] || []).find(x => x.id === q.id);
        if (item) payload[q.kind].push(Object.assign({}, item, { clientId: item.id, id: undefined }));
      });

      wx.cloud.callFunction({
        name: 'tutorSync',
        data: Object.assign({ action: 'push' }, payload)
      }).then(res => {
        const r = res && res.result;
        if (r && r.ok) {
          const rest = readAll();
          const doneIds = {};
          queue.forEach(q => { doneIds[q.kind + ':' + q.id] = true; });
          rest.pushQueue = (rest.pushQueue || []).filter(q => !doneIds[q.kind + ':' + q.id]);
          writeAll(rest);
          resolve({ ok: true, added: r.added || 0, skipped: r.skipped || 0, updated: r.updated || 0 });
        } else {
          resolve({ ok: false });
        }
      }).catch(() => resolve({ ok: false }));
    } catch (e) {
      resolve({ ok: false });
    }
  });
}

module.exports = {
  getSessions, getActive, newSession, appendMessage, closeSession, removeSession, archiveCount,
  getMistakes, addMistake, setMistakeStatus, mistakeCount,
  getEvidence, addEvidence, evidencePassedCount,
  getReviews, getDueReviews, reviewPendingCount, upsertReview, advanceReview,
  getLearnerContext,
  queuePush, mergeFromCloud, syncFromCloud, pushQueued,
  REVIEW_STAGE_DAYS
};

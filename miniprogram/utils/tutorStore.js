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
 *   pushQueue: [{ kind, id }],  // 待补写云端的数据（离线/失败回补，push 成功后清空）
 *   lastSyncAt: 0
 * }
 */
const store = require('./store.js');
const util = require('./util.js');

const BASE_KEY = 'wb_hwfarm_tutor_v1';

/* 艾宾浩斯复习档位（天）：与云函数 tutorChat / tutorRetest 保持一致 */
const REVIEW_STAGE_DAYS = [1, 2, 4, 7, 15];

/* 同步节流：60 秒内不重复 pull */
const SYNC_THROTTLE_MS = 60000;

function storageKey() {
  const oid = store.getOpenid();
  return oid ? `${BASE_KEY}_${oid}` : `${BASE_KEY}_guest`;
}

function readAll() {
  try {
    const raw = wx.getStorageSync(storageKey());
    if (raw && Array.isArray(raw.sessions)) {
      if (!Array.isArray(raw.mistakes)) raw.mistakes = [];
      if (!Array.isArray(raw.evidence)) raw.evidence = [];
      if (!Array.isArray(raw.reviews)) raw.reviews = [];
      if (!Array.isArray(raw.pushQueue)) raw.pushQueue = [];
      return raw;
    }
  } catch (e) {}
  return { sessions: [], mistakes: [], evidence: [], reviews: [], pushQueue: [], lastSyncAt: 0 };
}

function writeAll(data) {
  try { wx.setStorageSync(storageKey(), data); } catch (e) {}
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
  writeAll(all);
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
  writeAll(all);
  return s;
}

/** 关闭会话（标记归档完成） */
function closeSession(sessionId) {
  const all = readAll();
  const s = all.sessions.find(x => x.id === sessionId);
  if (!s) return null;
  s.closed = true;
  s.closedAt = Date.now();
  writeAll(all);
  return s;
}

/** 删除会话 */
function removeSession(sessionId) {
  const all = readAll();
  const i = all.sessions.findIndex(x => x.id === sessionId);
  if (i < 0) return;
  all.sessions.splice(i, 1);
  writeAll(all);
}

/** 已归档（关闭）会话数 */
function archiveCount() {
  return getSessions().filter(s => s.closed).length;
}

/* ======================= 错题本（P2） ======================= */

/** 全部错题（按创建时间倒序） */
function getMistakes() {
  const all = readAll();
  return (all.mistakes || []).slice().sort((a, b) => b.createdAt - a.createdAt);
}

/** 新增一条错题（E1-E9 归因；可传 m.id 预生成 uid，保证与云端 clientId 一致）
 *  拍照收录增量字段：source('photo'|'tutor') / questionText 题干 / childAnswer 孩子作答 /
 *  markSource 对错判定来源('marked' 图上批改 | 'ai' AI 判定 | 'none') —— 旧数据缺省兼容 */
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
    source: m.source === 'photo' ? 'photo' : 'tutor',
    questionText: m.questionText || '',
    childAnswer: m.childAnswer || '',
    markSource: ['marked', 'ai', 'none'].indexOf(m.markSource) >= 0 ? m.markSource : 'none',
    createdAt: Date.now()
  };
  all.mistakes.unshift(item);
  writeAll(all);
  return item;
}

/** 更新错题状态（pending 待重测 / corrected 已订正） */
function setMistakeStatus(id, status) {
  const all = readAll();
  const m = all.mistakes.find(x => x.id === id);
  if (!m) return false;
  m.status = status;
  writeAll(all);
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

/** 新增一条复测记录（passed=true 才是「已验证」证据） */
function addEvidence(e) {
  const all = readAll();
  const item = {
    id: util.uid('ev'),
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
  writeAll(all);
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
  writeAll(all);
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
  writeAll(all);
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

/** 记录待补写云端的数据（归档/复测成功后调用；push 成功后清空） */
function queuePush(kind, id) {
  if (!kind || !id) return;
  const all = readAll();
  if (!all.pushQueue.some(q => q.kind === kind && q.id === id)) {
    all.pushQueue.push({ kind: kind, id: id });
    if (all.pushQueue.length > 500) all.pushQueue = all.pushQueue.slice(-500);
    writeAll(all);
  }
}

/**
 * 云 → 本地回填（换设备/清缓存恢复）。
 * remote: tutorSync(pull) 返回 { sessions, mistakes, evidence, reviews }
 * 合并规则：按 id 并集；同 id 本地优先；reviews 比较 updatedAt 取新。
 */
function mergeFromCloud(remote) {
  if (!remote || typeof remote !== 'object') return { added: 0 };
  const all = readAll();
  let added = 0;

  const addIfMissing = (arrName, items, mapFn) => {
    (Array.isArray(items) ? items : []).forEach(cloud => {
      if (!cloud || !cloud.id) return;
      if (!all[arrName].some(x => x.id === cloud.id)) {
        all[arrName].push(mapFn(cloud));
        added++;
      }
    });
  };

  addIfMissing('sessions', remote.sessions, c => ({
    id: c.id,
    subject: c.subject || '',
    subjectName: c.subjectName || '',
    messages: Array.isArray(c.messages) ? c.messages : [],
    createdAt: c.createdAt || 0,
    closed: true,               // 云端 tutor_sessions 均为已归档会话
    closedAt: c.closedAt || c.createdAt || 0
  }));
  addIfMissing('mistakes', remote.mistakes, c => ({
    id: c.id,
    subject: c.subject || '',
    subjectName: c.subjectName || '',
    topic: c.topic || '',
    errorType: c.errorType || '',
    errorDesc: c.errorDesc || '',
    suggestion: c.suggestion || '',
    status: c.status === 'corrected' ? 'corrected' : 'pending',
    source: c.source === 'photo' ? 'photo' : 'tutor',
    questionText: c.questionText || '',
    childAnswer: c.childAnswer || '',
    markSource: ['marked', 'ai', 'none'].indexOf(c.markSource) >= 0 ? c.markSource : 'none',
    createdAt: c.createdAt || 0
  }));
  addIfMissing('evidence', remote.evidence, c => ({
    id: c.id,
    subject: c.subject || '',
    subjectName: c.subjectName || '',
    topic: c.topic || '',
    errorType: c.errorType || '',
    total: c.total || 0,
    correct: c.correct || 0,
    rate: c.rate || 0,
    passed: !!c.passed,
    createdAt: c.createdAt || 0
  }));

  // reviews：同 id 比 updatedAt，新者胜（复测推进可能发生在另一台设备）
  (Array.isArray(remote.reviews) ? remote.reviews : []).forEach(c => {
    if (!c || !c.id) return;
    const local = all.reviews.find(x => x.id === c.id);
    if (!local) {
      all.reviews.unshift({
        id: c.id,
        mistakeId: c.mistakeId || c.mistakeClientId || '',
        subject: c.subject || '',
        subjectName: c.subjectName || '',
        topic: c.topic || '',
        errorType: c.errorType || '',
        stage: Number(c.stage) || 1,
        dueAt: Number(c.dueAt) || 0,
        done: !!c.done,
        createdAt: c.createdAt || 0,
        updatedAt: c.updatedAt || c.createdAt || 0
      });
      added++;
    } else {
      const lu = local.updatedAt || 0;
      const cu = c.updatedAt || c.createdAt || 0;
      if (cu > lu) {
        local.stage = Number(c.stage) || local.stage;
        local.dueAt = Number(c.dueAt) || local.dueAt;
        local.done = !!c.done;
        local.updatedAt = cu;
      }
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

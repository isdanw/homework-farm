/**
 * 云函数 tutorSync —— 导学数据云↔本地同步（闭环 S1）
 *
 * 背景：tutor_sessions / tutor_mistakes / tutor_evidence / tutor_reviews 四个集合
 * 此前「只写不读」，换设备后云端有数据、页面为空。本云函数提供两条读路径：
 *
 * 入参 action:
 *   'pull'  按 openid 拉回四集合最近数据（返回给前端 merge 进本地 tutorStore）
 *   'push'  把本地有而云端缺的条目补写上云（离线归档 / 归档失败回补），按 clientId 查重
 *   'exams' F-B 试卷库列表（exam_resources）——只回索引元数据，**不回正文**，保持载荷轻量
 *   'exam'  F-B 单份试卷详情（按 resourceId）——回卷面 markdown + 参考答案，供「查看卷面」
 *
 * 【pull】出参：
 *   { ok:true, sessions:[], mistakes:[], evidence:[], reviews:[] }
 *   每条含 id（= 云端 clientId，无 clientId 的旧数据用 _id 兜底）+ cloudId + 原字段
 *   限量：sessions 100 / mistakes 200 / evidence 200 / reviews 100（createdAt 倒序）
 *
 * 【exams】入参：{ subject?: 'math'|'chinese'|… }（可选筛选）
 *   出参：{ ok:true, exams:[{ id, resourceId, name, subject, subjectName, level, examType,
 *          knowledgePoints, suggestedDuration, passingCriteria, lastVerified, staleLink,
 *          updatedAt, markdownLength, hasAnswers }] }  限量 100，createdAt 倒序
 *
 * 【exam】入参：{ resourceId }  出参：{ ok:true, exam:{ …元数据, markdown, rawText, answers } }
 *
 * 【push】入参：
 *   { sessions:[], mistakes:[], evidence:[], reviews:[], orders:[] }  每条必须带 clientId（本地 uid）
 *   行为：clientId 已存在 → 跳过（reviews 额外同步 stage/dueAt/done 进度）；
 *         不存在 → 补写。出参 { ok:true, added, skipped, updated }
 *
 *   ⚠️ orders 的分工契约（与 reviews 不同，别照抄）：
 *     · tutorOrder 云函数 = 唯一带状态机的写入口（出单/回执/作废/重开）
 *     · 本函数对 orders **只补写「云端不存在」的单**；已存在一律 skip，
 *       **不合并 status、不追加/改写 events[]、不看 updatedAt**。
 *     · 理由：status 与 events 承载 O2（回执 1:1）/O4（append-only）两条硬契约，
 *       被本地副本覆盖就会出现「回执被抹掉」「审计链断掉」。宁可不合并，不可写坏。
 *
 * 红线：
 *   · 全部按 openid 隔离；openid 为空直接拒绝（不产生无主数据）
 *   · 纯数据搬运，不调用 AI、不做任何「掌握」判定
 *   · 试卷是**资源库条目**：不产生 evidence、不参与学情统计（§试卷登记入库规则）
 *   · 学习单（tutor_orders）不是证据集合：本函数回传的 orders 不得写入 tutor_evidence
 */
const tcb = require('@cloudbase/node-sdk');

/* pull 拉取上限（家庭自用量级，防误拉全量） */
const PULL_LIMITS = {
  tutor_sessions: 100,
  tutor_mistakes: 200,
  tutor_evidence: 200,
  tutor_reviews: 100,
  tutor_orders: 200
};

/* push 各集合单次上限 */
const PUSH_LIMITS = {
  sessions: 100,
  mistakes: 200,
  evidence: 200,
  reviews: 100,
  orders: 200
};

/* F-B：试卷库 */
const EXAM_COLL = 'exam_resources';
const EXAM_LIST_LIMIT = 100;
/* 列表只回索引元数据（不含 markdown/rawText/answers），避免一次下拉拖回大量正文 */
const EXAM_LIST_FIELDS = ['clientId', 'resourceId', 'name', 'level', 'examType', 'retestType',
  'subject', 'subjectName', 'stage', 'grade', 'textbookEdition', 'correspondingUnit',
  'knowledgePoints', 'suggestedDuration', 'maxEvidenceLevel', 'passingCriteria',
  'publisher', 'lastVerified', 'staleLink', 'createdAt', 'updatedAt'];
/* 详情额外回正文三段 */
const EXAM_DETAIL_FIELDS = EXAM_LIST_FIELDS.concat(['officialUrl', 'answerUrl', 'sourceFile', 'sessionFile', 'markdown', 'rawText', 'answers']);

function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

/* ---------------- pull ---------------- */
async function pull(app, openid) {
  const db = app.database();
  const out = { sessions: [], mistakes: [], evidence: [], reviews: [], orders: [] };
  const map = {
    sessions: 'tutor_sessions',
    mistakes: 'tutor_mistakes',
    evidence: 'tutor_evidence',
    reviews: 'tutor_reviews',
    orders: 'tutor_orders'
  };
  for (const key of Object.keys(map)) {
    const name = map[key];
    let docs = [];
    try {
      const res = await db.collection(name)
        .where({ openid: openid })
        .orderBy('createdAt', 'desc')
        .limit(PULL_LIMITS[name])
        .get();
      docs = (res && res.data) || [];
    } catch (e) {
      docs = [];   // 集合不存在 / 查询失败 → 当作空，不阻塞其他集合
    }
    let mapped = docs.map(d => {
      const item = Object.assign({}, d);
      item.cloudId = d._id;
      item.id = d.clientId || d._id;   // 新数据用 clientId（= 本地 uid），旧数据兜底 _id
      delete item._id;
      return item;
    });
    // evidence 折叠历史重复（P0-5 残留）：早期 tutorRetest 直写的记录没有 clientId，
    // 与 push 回补的同一条证据构成两份。仅在「一份有 clientId、一份没有」时判为重复写，
    // 并保留带 clientId 的那份；同性质的两份视为两次真实复测，都保留。
    // 保守起见只在端上折叠，不删云端数据。
    if (key === 'evidence') mapped = dedupeEvidence(mapped);
    out[key] = mapped;
  }
  return {
    ok: true,
    sessions: out.sessions, mistakes: out.mistakes, evidence: out.evidence,
    reviews: out.reviews, orders: out.orders
  };
}

/** 复测证据折叠：识别「同一天 + 同知识点 + 同分数」且仅一份带 clientId 的重复写 */
function dedupeEvidence(list) {
  const out = [];
  const byKey = {};
  list.forEach(it => {
    const t = Number(it.createdAt) || 0;
    const day = t ? new Date(t).toISOString().slice(0, 10) : '';
    const key = [it.subject, it.topic, it.total, it.correct, it.passed ? 1 : 0, day].join('|');
    const hit = byKey[key];
    if (!hit) { byKey[key] = it; out.push(it); return; }
    const hitHas = !!hit.clientId;
    const curHas = !!it.clientId;
    if (hitHas === curHas) { out.push(it); return; }   // 同性质 → 两次真实复测，都保留
    if (curHas) { out[out.indexOf(hit)] = it; byKey[key] = it; }   // 保留带 clientId 的那份
  });
  return out;
}

/* ---------------- F-B：试卷库（只读） ----------------
 * 试卷由工作台/专家侧生成并上云，小程序端**纯只读**。
 * 列表刻意剥离正文三段：家庭试卷库可能累积较多卷，一次把卷面+答案全拖回端上既拖慢首屏也浪费流量；
 * 用户在列表点「查看卷面」时再按 resourceId 取单份详情。
 */
function pickExam(doc, fields) {
  const o = {};
  fields.forEach((k) => { if (doc[k] !== undefined) o[k] = doc[k]; });
  return o;
}

async function exams(app, openid, event) {
  const db = app.database();
  let docs = [];
  const where = { openid: openid };
  const subject = str(event && event.subject, 20);
  if (subject) where.subject = subject;
  try {
    const res = await db.collection(EXAM_COLL)
      .where(where)
      .orderBy('createdAt', 'desc')
      .limit(EXAM_LIST_LIMIT)
      .get();
    docs = (res && res.data) || [];
  } catch (e) {
    docs = [];   // 集合不存在（尚未推送过任何试卷）→ 当作空列表
  }
  const list = docs.map((d) => {
    const o = pickExam(d, EXAM_LIST_FIELDS);
    o.id = d.clientId || d._id;
    o.resourceId = d.resourceId || d.clientId || d._id;
    o.cloudId = d._id;
    delete o.clientId;
    // 端上只需要「有没有答案 / 卷面多长」这两个判断位，正文本身留在云端
    o.markdownLength = (d.markdown || '').length;
    o.hasAnswers = !!(d.answers || '').length;
    return o;
  });
  return { ok: true, exams: list };
}

async function exam(app, openid, event) {
  const db = app.database();
  const resourceId = str(event && (event.resourceId || event.clientId), 80);
  if (!resourceId) return { ok: false, code: 'no_resourceId', msg: '缺少 resourceId' };
  let docs = [];
  try {
    const res = await db.collection(EXAM_COLL)
      .where({ openid: openid, clientId: resourceId })
      .limit(1)
      .get();
    docs = (res && res.data) || [];
  } catch (e) { docs = []; }
  if (!docs.length) return { ok: false, code: 'not_found', msg: '未找到该试卷（可能未上云）' };
  const d = docs[0];
  const o = pickExam(d, EXAM_DETAIL_FIELDS);
  o.id = d.clientId || d._id;
  o.resourceId = o.resourceId || d.clientId || d._id;
  o.cloudId = d._id;
  delete o.clientId;
  return { ok: true, exam: o };
}

/* ---------------- push ---------------- */
/** 收敛 push 文档：只保留业务字段，剥离本地 id（云端用 clientId 承载） */
function sanitize(kind, item) {
  if (!item || typeof item !== 'object') return null;
  const clientId = str(item.clientId || item.id, 60);
  if (!clientId) return null;
  const doc = Object.assign({}, item);
  doc.clientId = clientId;
  delete doc.id;
  delete doc.cloudId;
  delete doc._id;
  return doc;
}

async function push(app, openid, input) {
  const db = app.database();
  let added = 0, skipped = 0, updated = 0;

  const collName = {
    sessions: 'tutor_sessions',
    mistakes: 'tutor_mistakes',
    evidence: 'tutor_evidence',
    reviews: 'tutor_reviews',
    orders: 'tutor_orders'
  };

  for (const kind of Object.keys(collName)) {
    const items = Array.isArray(input[kind]) ? input[kind].slice(0, PUSH_LIMITS[kind]) : [];
    if (!items.length) continue;
    for (const raw of items) {
      const doc = sanitize(kind, raw);
      if (!doc) continue;
      let exist = [];
      try {
        const res = await db.collection(collName[kind])
          .where({ openid: openid, clientId: doc.clientId })
          .limit(1)
          .get();
        exist = (res && res.data) || [];
      } catch (e) { exist = []; }

      /* ── 学习单（orders）：只补写、绝不合并（分工契约，见 docs/orderProtocol.md §6）──
       * tutorOrder 是**唯一**带状态机的写入口；本函数对已存在的单必须原样放过。
       * 理由：orders 的 status 与 events[] 是 O2/O4 两条硬契约的载体，一旦被本地副本
       * 覆盖，就会出现「回执被抹掉」「事件流水断链」——审计能力直接报废。
       * 因此这里**不看 updatedAt、不做 LWW、不比对状态**，存在即 skip。 */
      if (kind === 'orders' && exist.length) {
        skipped++;
        continue;
      }
      if (exist.length) {
        // reviews 额外同步进度（复测推进后本地领先云端时回写）
        if (kind === 'reviews') {
          const cloud = exist[0];
          const localStage = Number(doc.stage) || 1;
          const localUpdated = Number(doc.updatedAt) || 0;
          const cloudUpdated = Number(cloud && cloud.updatedAt) || 0;
          if (localUpdated > cloudUpdated || localStage > (Number(cloud && cloud.stage) || 1)) {
            try {
              // ⚠️ @cloudbase/node-sdk 的 update(obj)：obj 的键即字段名，**无 { data:{} } 包壳**
              //    （与 wx-server-sdk 不同）。包壳会把内容写进嵌套 data.data，永不生效。
              await db.collection(collName[kind]).doc(cloud._id).update({
                stage: localStage,
                dueAt: Number(doc.dueAt) || 0,
                done: !!doc.done,
                updatedAt: localUpdated || Date.now()
              });
              updated++;
            } catch (e) {}
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
        continue;
      }

      // 不存在 → 对于 evidence，先尝试「认领」旧数据（P0-5 修复）：
      // 早期 tutorRetest 直写的 evidence 没有 clientId，本函数按 openid+clientId 查不到，
      // 于是又 add 一条 → 同一份证据在云端两份。这里按业务键（学科+知识点+题数+正确数）
      // 找一条无 clientId 的同源记录，补上 clientId 即完成合并，不再新增。
      if (kind === 'evidence') {
        let legacy = [];
        try {
          const res2 = await db.collection(collName[kind]).where({
            openid: openid,
            subject: doc.subject || '',
            topic: doc.topic || '',
            total: Number(doc.total) || 0,
            correct: Number(doc.correct) || 0
          }).limit(5).get();
          legacy = ((res2 && res2.data) || []).filter(d => d && !d.clientId);
        } catch (e) { legacy = []; }
        if (legacy.length) {
          try {
            await db.collection(collName[kind]).doc(legacy[0]._id).update({
              clientId: doc.clientId,
              subjectName: doc.subjectName || legacy[0].subjectName || ''
            });
            updated++;
            continue;                      // 认领成功 → 不再新增
          } catch (e) { /* 认领失败 → 落到下面的正常补写 */ }
        }
      }

      // 不存在 → 补写（node-sdk 的 add(obj)：obj 直接作为新文档，无 { data:{} } 包壳）
      try {
        await db.collection(collName[kind]).add(Object.assign({ openid: openid }, doc));
        added++;
      } catch (e) {
        try { await db.createCollection(collName[kind]); } catch (e2) {}
        try {
          await db.collection(collName[kind]).add(Object.assign({ openid: openid }, doc));
          added++;
        } catch (e3) {}
      }
    }
  }

  return { ok: true, added: added, skipped: skipped, updated: updated };
}

/* ---------------- 主入口 ---------------- */
exports.main = async (event) => {
  const openid = (event.userInfo && event.userInfo.openId) || '';
  if (!openid) return { ok: false, code: 'no_openid', msg: '缺少用户身份，无法同步' };

  const action = ['push', 'exams', 'exam'].includes(event.action) ? event.action : 'pull';

  let app;
  try {
    app = tcb.init({ env: process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf' });
  } catch (e) {
    return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) };
  }

  try {
    if (action === 'push') {
      const input = {
        sessions: Array.isArray(event.sessions) ? event.sessions : [],
        mistakes: Array.isArray(event.mistakes) ? event.mistakes : [],
        evidence: Array.isArray(event.evidence) ? event.evidence : [],
        reviews: Array.isArray(event.reviews) ? event.reviews : [],
        orders: Array.isArray(event.orders) ? event.orders : []
      };
      return await push(app, openid, input);
    }
    if (action === 'exams') return await exams(app, openid, event);
    if (action === 'exam') return await exam(app, openid, event);
    return await pull(app, openid);
  } catch (e) {
    return { ok: false, code: 'sync_error', msg: '同步失败：' + ((e && e.message) || e) };
  }
};

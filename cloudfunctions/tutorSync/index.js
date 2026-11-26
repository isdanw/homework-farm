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
 *   'flows' P3b：kp_flows 整流 LWW 写回（小程序推进状态后落事实），规则=writeKpFlows（P1）
 *
 * 【pull】出参：
 *   { ok:true, sessions:[], mistakes:[], evidence:[], reviews:[], orders:[], cards:[], unitKps:[],
 *     kpFlows: { flows:[], total, truncated, rejected } }   ← P3a 只读段（工作台建的流，详见 pullKpFlows）
 *   每条含 id（= 云端 clientId，无 clientId 的旧数据用 _id 兜底）+ cloudId + 原字段
 *   限量：sessions 100 / mistakes 200 / evidence 200 / reviews 100（createdAt 倒序）
 *   kpFlows 截断口径与 webAdminQuery P2 一致：未通关全量 + 已通关 updatedAt 倒序最近 100
 *
 * 【exams】入参：{ subject?: 'math'|'chinese'|…, childId?: string }（均可选）
 *   出参：{ ok:true, exams:[{ id, resourceId, name, subject, subjectName, level, examType,
 *          knowledgePoints, suggestedDuration, passingCriteria, lastVerified, staleLink,
 *          updatedAt, markdownLength, hasAnswers }] }  限量 100，createdAt 倒序
 *
 * 【exam】入参：{ resourceId, childId? }
 *   出参：{ ok:true, exam:{ …元数据, markdown, rawText, answers } }
 *
 * 【试卷读路径的孩子维度】
 *   与 examService.listExams 同一规则：能解析出当前孩子 → 只回「该孩子的卷 + 无归属卷」
 *   （历史行无法判定归属，不猜也不藏）；解析不出孩子（未建档 / 占位切片）→ 不过滤。
 *   端上点名的 childId 跨家庭/非法 → **回落当前孩子**再过滤，坏参数不能把过滤整个关掉。
 *   详情（exam）同样校验：别人的孩子的卷一律按 not_found 处理，不暴露存在性。
 *
 * 【push】入参：
 *   { sessions:[], mistakes:[], reviews:[], orders:[], cards:[], unitKps:[], childId? }
 *   每条必须带 clientId（本地 uid）
 *   行为：clientId 已存在 → 跳过（reviews/cards 额外同步进度）；
 *         不存在 → 补写。出参 { ok:true, added, skipped, updated, rejected }
 *
 *   ⚠️ evidence 不再接受 push（P0：证据单写者 = tutorRetest）：
 *     tutor_evidence 只能由 tutorRetest.judge 用服务端判分结果写入；
 *     客户端推上来的证据一律计入 rejected，不落库、不「认领」。
 *     旧客户端继续推 → 数据不会丢（judge 已写过云端那条），只是被拒。
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
 *   · childId 由服务端从该 openid 的 hw_farm_user.users[] 解析，客户端传的只作
 *     「想要的归属」参考；跨家庭 childId 直接拒绝该条（rejected），不落库
 *   · 纯数据搬运，不调用 AI、不做任何「掌握」判定
 *   · 试卷是**资源库条目**：不产生 evidence、不参与学情统计（§试卷登记入库规则）
 *   · 导学单（tutor_orders）不是证据集合：本函数回传的 orders 不得写入 tutor_evidence
 */
const tcb = require('@cloudbase/node-sdk');
const G = require('./scopeGuard');

const USER = 'hw_farm_user';

/* pull 拉取上限（家庭自用量级，防误拉全量） */
const PULL_LIMITS = {
  tutor_sessions: 100,
  tutor_mistakes: 200,
  tutor_evidence: 200,
  tutor_reviews: 100,
  tutor_orders: 200,
  tutor_cards: 200,
  tutor_unit_kps: 200
};

/* push 各集合单次上限（evidence 不在列：不接受客户端推证据） */
const PUSH_LIMITS = {
  sessions: 100,
  mistakes: 200,
  reviews: 100,
  orders: 200,
  cards: 200,
  unitKps: 200
};

/* P3a（2026-11-23）：kpFlows 只读下发段。
 * kp_flows 由「全科导学工作台」P1/P2 写入与读回（webAdminWrite / webAdminQuery），
 * 小程序端 P3a 纯只读展示。截断口径与 webAdminQuery P2 完全一致：
 *   未通关全量 + 已通关按 updatedAt 倒序最近 KP_FLOWS_CLEARED_LIMIT 条，带 total/truncated（绝不静默）。
 * 额外孩子闸（任务卡）：flow.learnerNo 属于该 openid 家庭才下发，跨家庭直接拒该条（不猜不藏）；
 *   无 learnerNo 的 P1 旧 doc 保留（无法判定归属时不下判，端上按 legacy 兜底展示）。
 * deletedAt 行不下发：只读端不展示已删流（工作台读回走 webAdminQuery，不受影响）。
 * flows 只读：不进 push 的 collName / sanitize / PUSH_LIMITS 任何路径（P3b 写通道另立卡）。 */
const KP_FLOWS_COLL = 'kp_flows';
const KP_FLOWS_CLEARED_LIMIT = 100;
const KP_FLOWS_PAGE_LIMIT = 100;   // 全量读取分页（未通关不截，封顶见下）
const KP_FLOWS_MAX_PAGES = 10;     // 封顶 10 页 = 1000 条；撞顶时 truncated=true，绝不静默

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
  const out = { sessions: [], mistakes: [], evidence: [], reviews: [], orders: [], cards: [], unitKps: [] };
  const map = {
    sessions: 'tutor_sessions',
    mistakes: 'tutor_mistakes',
    evidence: 'tutor_evidence',
    reviews: 'tutor_reviews',
    orders: 'tutor_orders',
    cards: 'tutor_cards',
    unitKps: 'tutor_unit_kps'
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
    reviews: out.reviews, orders: out.orders, cards: out.cards, unitKps: out.unitKps,
    // P3a：kpFlows 只读段（缺集合时为空段，老端忽略该键即可）
    kpFlows: await pullKpFlows(db, openid)
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

/* ---------------- pull：kpFlows 只读段（P3a） ----------------
 * 口径与 webAdminQuery P2 一致：未通关全量 + 已通关按 updatedAt 倒序最近 100，
 * 带 total/truncated；跨家庭 learnerNo 拒该条（rejected 计数 >0 说明云端脏数据/绑定错，不静默）。
 * 集合不存在（工作台还没备份过任何流）→ 空段，不阻塞其他集合。 */
async function pullKpFlows(db, openid) {
  const empty = { flows: [], total: 0, truncated: false, rejected: 0 };
  // 分页取全部（与 webAdminQuery getAll 同构：count → 分页 → 封顶），**不能**「updatedAt 倒序 + limit」一次取：
  // 那样已通关流一多就会把未通关流挤出扫描窗口，且 truncated 只看已通关是否超限 → 未通关流静默丢失。
  let docs = [];
  try {
    const countRes = await db.collection(KP_FLOWS_COLL).where({ openid: openid }).count();
    const pages = Math.min(Math.ceil((countRes.total || 0) / KP_FLOWS_PAGE_LIMIT), KP_FLOWS_MAX_PAGES);
    for (let i = 0; i < pages; i++) {
      const res = await db.collection(KP_FLOWS_COLL)
        .where({ openid: openid })
        .orderBy('createdAt', 'desc')
        .skip(i * KP_FLOWS_PAGE_LIMIT)
        .limit(KP_FLOWS_PAGE_LIMIT)
        .get();
      if (res && res.data) docs.push(...res.data);
    }
  } catch (e) {
    return empty;   // 集合不存在（工作台还没备份过任何流）→ 空段，不阻塞其他集合
  }
  const root = await loadRoot(db, openid);
  const rows = [];
  let rejected = 0;
  docs.forEach(d => {
    if (d.deletedAt) return;                       // 已删流不下发（只读端不展示）
    // 孩子闸：learnerNo 必须属于该 openid 家庭（与 push 的 childId 跨家庭拒绝同纪律）
    if (d.learnerNo && !G.isChildOf(root, d.learnerNo)) { rejected++; return; }
    const o = Object.assign({}, d);
    o.cloudId = d._id;
    o.id = d.flowId || d._id;                      // 写端 _id=flowId（幂等键），正常恒等
    if (!o.flowId) o.flowId = d._id;
    delete o._id;
    rows.push(o);
  });
  const active = rows.filter(r => r.status !== 'cleared');
  const clearedAll = rows.filter(r => r.status === 'cleared')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const cleared = clearedAll.slice(0, KP_FLOWS_CLEARED_LIMIT);
  return {
    flows: active.concat(cleared),
    total: rows.length,
    // 不静默：已通关超限，或全量读取撞到封顶（家庭自用量级不可能，撞到即明示）
    truncated: clearedAll.length > KP_FLOWS_CLEARED_LIMIT || docs.length >= KP_FLOWS_PAGE_LIMIT * KP_FLOWS_MAX_PAGES,
    rejected: rejected
  };
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

/**
 * 试卷读路径的孩子作用域。规则与 examService.listExams 逐字相同（两条读路径不能各算一套口径）：
 *   · 点名了本家庭的孩子 → 按该孩子过滤；
 *   · 点名跨家庭/非法 id → 回落当前孩子再过滤（坏参数不能把过滤整个关掉）；
 *   · 解析不出孩子（未建档 / 仍是占位切片）→ 返回空串 = 不过滤。
 */
async function resolveExamChild(app, openid, event) {
  const root = await loadRoot(app.database(), openid);
  let kid = G.resolveChildId(root, event && event.childId);
  if (kid.source === 'invalid') kid = G.resolveChildId(root, '');
  return kid.childId;
}

async function exams(app, openid, event) {
  const db = app.database();
  const childId = await resolveExamChild(app, openid, event);
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
  // 无归属的卷（工作台推送的资源库 / 迁移前历史行）一律保留：无法判定归属时不猜也不藏
  if (childId) docs = docs.filter(d => !d.childId || d.childId === childId);
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
  // 详情同样过孩子闸：知道 resourceId 也不能读到别的孩子的卷。
  // 仍然回 not_found 而不是 forbidden —— 不向调用方暴露「这份卷存在但不属于你」。
  const childId = await resolveExamChild(app, openid, event);
  if (childId && d.childId && d.childId !== childId) {
    return { ok: false, code: 'not_found', msg: '未找到该试卷（可能未上云）' };
  }
  const o = pickExam(d, EXAM_DETAIL_FIELDS);
  o.id = d.clientId || d._id;
  o.resourceId = o.resourceId || d.clientId || d._id;
  o.cloudId = d._id;
  delete o.clientId;
  return { ok: true, exam: o };
}

/* ---------------- push ---------------- */
/** 收敛 push 文档：只保留业务字段，剥离本地 id 与身份字段（云端用 clientId 承载 id） */
function sanitize(kind, item) {
  if (!item || typeof item !== 'object') return null;
  const clientId = str(item.clientId || item.id, 60);
  if (!clientId) return null;
  const doc = G.stripIdentity(Object.assign({}, item));
  doc.clientId = clientId;
  delete doc.id;
  delete doc.cloudId;
  delete doc._id;
  // childId 只认服务端解析结果（resolveChildId），客户端传的不透传
  delete doc.childId;
  return doc;
}

/** 读该 openid 的家庭根数据（只取 users[]/currentUserId，用于解析 childId） */
async function loadRoot(db, openid) {
  try {
    const res = await db.collection(USER).where({ _openid: openid }).limit(1).get();
    const doc = (res && res.data && res.data[0]) || null;
    return (doc && doc.data) || null;
  } catch (e) {
    return null;   // 集合不存在 / 尚未上传过 → 无档案，childId 留空待迁移
  }
}

async function push(app, openid, input, childId) {
  const db = app.database();
  let added = 0, skipped = 0, updated = 0, rejected = 0;

  /* evidence 不在此表：证据只能由 tutorRetest 服务端判分后写入（单写者）。
   * 客户端推上来的一律 rejected —— 若客户端就传了证据，等于「自己给自己发奖状」。 */
  const collName = {
    sessions: 'tutor_sessions',
    mistakes: 'tutor_mistakes',
    reviews: 'tutor_reviews',
    orders: 'tutor_orders',
    cards: 'tutor_cards',
    unitKps: 'tutor_unit_kps'
  };

  rejected += Array.isArray(input.evidence) ? input.evidence.length : 0;

  for (const kind of Object.keys(collName)) {
    const items = Array.isArray(input[kind]) ? input[kind].slice(0, PUSH_LIMITS[kind]) : [];
    if (!items.length) continue;
    for (const raw of items) {
      const doc = sanitize(kind, raw);
      if (!doc) { rejected++; continue; }
      doc.childId = childId;
      let exist = [];
      try {
        const res = await db.collection(collName[kind])
          .where({ openid: openid, clientId: doc.clientId })
          .limit(1)
          .get();
        exist = (res && res.data) || [];
      } catch (e) { exist = []; }

      /* ── 导学单（orders）：只补写、绝不合并（分工契约，见 docs/orderProtocol.md §6）──
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
        } else if (kind === 'cards') {
          // 闪卡：推进后本地领先云端时回写 Leitner 盒子进度（与 reviews 同思路）
          const cloud = exist[0];
          const localUpdated = Number(doc.updatedAt) || 0;
          const cloudUpdated = Number(cloud && cloud.updatedAt) || 0;
          if (localUpdated > cloudUpdated) {
            try {
              await db.collection(collName[kind]).doc(cloud._id).update({
                box: Number(doc.box) || 1,
                dueAt: Number(doc.dueAt) || 0,
                done: !!doc.done,
                lastResult: doc.lastResult || null,
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

      // 不存在 → 补写（node-sdk 的 add(obj)：obj 直接作为新文档，无 { data:{} } 包壳）
      try {
        await db.collection(collName[kind]).add(Object.assign({ openid: openid }, doc));
        added++;
      } catch (e) {
        try { await db.createCollection(collName[kind]); } catch (e2) {}
        try {
          await db.collection(collName[kind]).add(Object.assign({ openid: openid }, doc));
          added++;
        } catch (e3) { rejected++; }
      }
    }
  }

  return { ok: true, added: added, skipped: skipped, updated: updated, rejected: rejected };
}

/* ---------------- flows 动作（P3b：小程序写回，整流 LWW 更新） ----------------
 * ⚠️ 与 push 的分工（别混淆）：
 *   · push 是「只补缺」语义（clientId 已存在 → skip），承载不了状态推进；
 *   · 本动作 = 整流 LWW 更新，规则与 webAdminWrite 的 writeKpFlows（P1）完全一致：
 *     字段白名单重建 doc、_id=flowId 幂等、per-flow LWW（updatedAt 大者胜、tie 取
 *     reviewRound 大者）、通关只进不出（cloud cleared 不可被降级覆盖）。
 * 服务端只做事实记录：不推进状态、不算排期、不判通关（工作台/端上状态机唯一权威）。
 * 孩子闸：有 learnerNo 必须 isChildOf（跨家庭拒该条计 rejected，不落库）；
 *   缺省则用 resolveChildId 结果盖章（P3a 旧流推进时端上会盖章，此处兜底），
 *   解析不出 → rejected（不产生无主数据，与 push 同纪律）。
 * 校验：status/step 必须在库内枚举、reviewRound ≥ 0、updatedAt 必须存在（LWW 键）。
 * flows 不进 push 的 collName / PUSH_LIMITS / sanitize（P3a 红线延续）。 */
const KP_FLOW_FIELDS = ['subject', 'knowledgePoint', 'status', 'step', 'reviewRound',
  'nextReviewAt', 'lastEvidence', 'prevStatus', 'createdAt', 'updatedAt', 'deletedAt',
  'learnerNo', 'legacy'];
const KP_FLOW_STATUSES = ['not_started', 'first_learning', 'reviewing', 'cleared', 'paused'];
const KP_FLOW_STEPS = ['learn', 'practice', 'explain', 'test', 'review'];
const KP_FLOW_MAX_BATCH = 100;

async function updateFlows(app, openid, event) {
  const db = app.database();
  const items = Array.isArray(event.flows) ? event.flows.slice(0, KP_FLOW_MAX_BATCH) : [];
  let updated = 0, skipped = 0, rejected = 0;
  const rejectedList = [];
  const reject = (flowId, reason) => {
    rejected++;
    if (rejectedList.length < 20) rejectedList.push({ flowId: flowId || '', reason: reason });
  };
  // 家庭根数据：孩子闸 + learnerNo 缺省时的兜底盖章
  const root = await loadRoot(db, openid);
  const fallbackKid = G.resolveChildId(root, event.childId);

  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { reject('', 'not_object'); continue; }
    const flowId = str(raw.flowId || raw.id, 60);
    if (!flowId) { reject('', 'no_flowId'); continue; }

    // 白名单重建：只拷贝已知字段，端上多余键（id/cloudId/身份键）不落地
    const doc = {};
    for (const k of KP_FLOW_FIELDS) {
      if (raw[k] !== undefined) doc[k] = raw[k];
    }
    if (KP_FLOW_STATUSES.indexOf(doc.status) < 0 || KP_FLOW_STEPS.indexOf(doc.step) < 0) {
      reject(flowId, 'bad_status_or_step'); continue;
    }
    const rr = Number(doc.reviewRound);
    if (!Number.isFinite(rr) || rr < 0) { reject(flowId, 'bad_reviewRound'); continue; }
    doc.reviewRound = Math.floor(rr);
    if (typeof doc.updatedAt !== 'string' || !doc.updatedAt) {
      reject(flowId, 'no_updatedAt'); continue;   // LWW 键必须存在
    }

    // 孩子闸：learnerNo 缺省 → 服务端兜底盖章（解析不出 = 无归属，拒）
    if (!doc.learnerNo) {
      if (!fallbackKid.childId) { reject(flowId, 'no_learnerNo_resolvable'); continue; }
      doc.learnerNo = fallbackKid.childId;
    } else if (!G.isChildOf(root, doc.learnerNo)) {
      reject(flowId, 'learnerNo_cross_family'); continue;
    }

    let exist = [];
    try {
      const res = await db.collection(KP_FLOWS_COLL).doc(flowId).get();
      exist = (res && res.data && (Array.isArray(res.data) ? res.data : [res.data])) || [];
    } catch (e) { exist = []; }
    const cloud = exist.length ? exist[0] : null;
    // 按 _id 直取后的归属校验（项目既定越权纪律：_id 兜底查询后必补 openid）。
    // flowId 由客户端点名，不校验就能改写别家同 flowId 的流（含把 learnerNo 改成自家孩子）。
    if (cloud && cloud._id && cloud.openid !== openid) { reject(flowId, 'flow_id_conflict'); continue; }

    // ---- 新增 ----
    if (!cloud || !cloud._id) {
      const fresh = Object.assign({ openid }, doc);
      try {
        await db.collection(KP_FLOWS_COLL).doc(flowId).set(fresh);
        updated++;
      } catch (e) {
        try { await db.createCollection(KP_FLOWS_COLL); } catch (e2) {}
        try {
          await db.collection(KP_FLOWS_COLL).doc(flowId).set(fresh);
          updated++;
        } catch (e3) { reject(flowId, 'write_failed'); }
      }
      continue;
    }

    // ---- 已存在：LWW + 通关只进不出（与 P1 writeKpFlows 同规则）----
    if (cloud.status === 'cleared' && doc.status !== 'cleared') { skipped++; continue; }
    const cAt = String(cloud.updatedAt || '');
    const mAt = String(doc.updatedAt);
    if (cAt > mAt) { skipped++; continue; }              // 云端更新 → 保留云端
    if (cAt === mAt) {
      // tie：reviewRound 大者赢；再 tie 取云端（幂等跳过）
      if (!(doc.reviewRound > (Number(cloud.reviewRound) || 0))) { skipped++; continue; }
    }
    const patch = {};
    for (const k of KP_FLOW_FIELDS) if (doc[k] !== undefined) patch[k] = doc[k];
    patch.updatedAt = doc.updatedAt;   // 保留客户端时间戳（事实记录，不重打）
    try {
      await db.collection(KP_FLOWS_COLL).doc(cloud._id).update(patch);
      updated++;
    } catch (e) { reject(flowId, 'write_failed'); }
  }

  return { ok: true, updated: updated, skipped: skipped, rejected: rejected,
    ...(rejectedList.length ? { rejectedList: rejectedList } : {}) };
}

/* ---------------- 主入口 ---------------- */
exports.main = async (event) => {
  const gate = G.requireOpenid((event.userInfo && event.userInfo.openId) || '');
  if (!gate.ok) return { ok: false, code: gate.code, msg: '缺少用户身份，无法同步' };
  const openid = gate.openid;

  const action = ['push', 'exams', 'exam', 'flows'].includes(event.action) ? event.action : 'pull';

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
        orders: Array.isArray(event.orders) ? event.orders : [],
        cards: Array.isArray(event.cards) ? event.cards : [],
        unitKps: Array.isArray(event.unitKps) ? event.unitKps : []
      };
      const root = await loadRoot(app.database(), openid);
      const kid = G.resolveChildId(root, event.childId);
      // 客户端点名了不属于本家庭的孩子 → 整单拒绝：这一批的归属都不可信，
      // 既不能写到别人孩子名下，也不该悄悄换成「当前孩子」（那正是串数据的根源）。
      if (kid.source === 'invalid') {
        return { ok: false, code: 'child_scope_invalid', msg: '指定的孩子不属于当前账号，已拒绝本次同步' };
      }
      return await push(app, openid, input, kid.childId);
    }
    if (action === 'exams') return await exams(app, openid, event);
    if (action === 'exam') return await exam(app, openid, event);
    if (action === 'flows') return await updateFlows(app, openid, event);
    return await pull(app, openid);
  } catch (e) {
    return { ok: false, code: 'sync_error', msg: '同步失败：' + ((e && e.message) || e) };
  }
};

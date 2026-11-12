/**
 * 云函数 webAdminWrite —— 家长数据看板·写入代理（与 webAdminQuery 对称，T3 工作台→云 push）
 *
 * 职责（不可破坏的红线）：
 *   · 写。但只写「导学镜像」四类集合（tutor_sessions/mistakes/reviews/cards）+「试卷库」
 *     （exam_resources）+ 孩子切片（learner / subjectProfiles / nickname / grade）+「导学单」
 *     （tutor_orders，见下方 orders 专用通道）；tutor_evidence **不可写**（见 P0 说明）；
 *     绝不触碰 homework/checkin/schedule/农场等小程序权威数据，避免镜像写回污染主链路。
 *   · 身份解析：复用 webAdminQuery 的 token→openid 机制（web_portal_bindings），不接收微信上下文。
 *   · 去重：tutor_* 与 exam_resources 均按 openid+clientId 查重。**T5 起 tutor_* 改为三路合并**
 *     （base=本地「云端版本」基线 / mine=本地 md / theirs=云端当前 updatedAt）：下拉后云端被小程序
 *     改过则拒绝覆盖并上报 conflicts；仅在「云端仍停在我下拉时的版本」或「本地确更新」时才发布。
 *     绝不静默覆盖。（F-B 试卷库的判定顺序不同，见 writeExams 注释。）
 *   · 纯数据搬运，不调用 AI、不做"掌握"判定。
 *
 * ⚠️ orders 通道是**唯一的例外形态**，读本文件前请先理解：
 *   · 入参 `event.orders` 是**对象** { action, ...payload }，不是数组；传数组一律拒绝。
 *   · 业务规则零实现 —— 全部转发给 orderActions（canonical 副本，与 tutorOrder 逐字节相同），
 *     由哈希锁（scripts/test-order-kit-sync.cjs）保证两端不会漂移。
 *   · 导学单的 status / events 承载 O2（回执 1:1）/O4（append-only）两条硬契约，
 *     因此**只允许走动作层**，永不允许「批量覆盖写」。
 *
 * 入参：
 *   { token:'xxx', sessions:[], mistakes:[], reviews:[], cards:[], exams:[], childId?,
 *     profile:{ nickname, grade, learner, subjectProfiles, baseUpdatedAt } }
 *   （每条 tutor 记录可带 baseUpdatedAt = 上次下拉时的云端 updatedAt，不落库；
 *     exams 每条的 clientId = resourceId）
 *   { token:'xxx', orders:{ action:'issue'|'submit'|'void'|…, ...payload } }
 *   { token:'xxx', action:'migrateChildScope', confirm?, assignments?, parentSessionToken? }
 *     （历史 childId 迁移：默认 dry-run；单孩家庭才自动归属，多孩须逐行 assignments；
 *      confirm:true 是家长动作 → per-user 口令必须同时带家长口令会话 token）
 * 出参：{ ok:true, scope, openid, added, skipped, updated, rejected, exams?, conflictCount, conflicts[], profile }
 *       或 { ok:false, code, msg }
 *
 * P0（作用域收口）：
 *   · 客户端传来的 openid/_openid 一律剥离，身份只由 token→bindings 解析；
 *   · evidence 通道已关闭（证据单写者 = tutorRetest 服务端判分），收到即计入 rejected；
 *   · childId 由服务端从该 openid 的 users[] 解析：跨家庭 → 整单拒绝，
 *     未指定 → 取 currentUserId（不回落 users[0]）。
 */

const tcb = require('@cloudbase/node-sdk');
const G = require('./scopeGuard');

const kit = require('./orderKit');
const orderActions = require('./orderActions').createActions(kit);
const { makeDeps } = require('./orderCloudDeps');

const ENV = process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf';
const COLLS = {
  user: 'hw_farm_user',
  sessions: 'tutor_sessions',
  mistakes: 'tutor_mistakes',
  reviews: 'tutor_reviews',
  exams: 'exam_resources',
  orders: 'tutor_orders',
  cards: 'tutor_cards',
  bindings: 'web_portal_bindings'
};

let _app = null;
function app() {
  if (!_app) _app = tcb.init({ env: ENV });
  return _app;
}
function db() { return app().database(); }

/* ---------- F13：错题来源枚举（三端唯一口径）----------
 *   source     = 录入路径：photo 拍照/OCR | tutor 导学对话(tutorChat) | manual 手工录入
 *   markSource = 对错判定来源：marked 图上已批改 | ai AI 判定 | none 未知
 * 这是**两个正交的轴**。历史上 tutorChat 写 'manual'、本地默认 'tutor'，端上又把非 photo
 * 一律归一成 'tutor'，导致同一条错题两端拿到不同 source。现在三端都不再归一化：
 *   · 本函数：原样搬运，只做白名单过滤，绝不改写取值；
 *   · 小程序 tutorStore.addMistake：只对「非法/缺失」兜底，合法值（含 manual）原样保留；
 *   · tutorChat：保留 'manual'（对话诊断归档，语义真实且不可用 tutor 替代）。
 * 对应地，小程序 utils/tutorStore.js 的 MISTAKE_SOURCES 是同一份口径，改这里要同步改那里。 */

/* ---------- 身份解析：token → openid（与 webAdminQuery 一致）---------- */
async function resolveBinding(token) {
  if (!token) return null;
  try {
    const res = await db().collection(COLLS.bindings).where({ token, revoked: false }).limit(1).get();
    if (res && res.data && res.data.length) return res.data[0];
  } catch (e) {}
  return null;
}

function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

/* ---------- tutor_* 写入（T5：三路合并 + LWW，绝不静默覆盖）----------
 * base   = 上次下拉时记录的云端 updatedAt（本地 md 的「云端版本」字段）
 * mine   = 本地 md 的 updatedAt（由「日期」归一化而来）
 * theirs = 云端当前 updatedAt
 *
 * 判定规则：
 *   · 云端无该 clientId         → add（新记录）
 *   · theirs > base             → conflict：下拉之后小程序又写过云端，**跳过并上报**，不覆盖
 *   · theirs <= base（含相等）   → 云端仍停在基线版本，本地差异即我方编辑 → 发布
 *   · base 缺失（本地新写 md）  → 退化为 LWW：mine > theirs 才发布，否则 conflict
 *
 * 幂等：可发布字段与云端完全一致时不写（记 skipped），避免每次推送无谓刷新 updatedAt。
 */
const PUBLISH_FIELDS = {
  sessions: ['messages'],
  // 注：source 必须进白名单 —— 拍照 OCR 收录的错题由 md-to-cloud 按「验证等级: V2」映射为 source:'photo'，
  // 若缺此字段，update 路径会将其剥离，导致「V2 → 云端 source:photo」回路断掉（§9.2 R4）。
  //
  // F13（2026-09-18）：补齐 questionText / childAnswer / markSource。
  //   webAdminQuery 的下拉白名单里一直有这三个字段，上行白名单却没有 → 下拉能读到、
  //   改完推不上去，工作台改这几个字段**永远不生效且没有任何报错**（update 是部分更新，
  //   不会破坏数据，所以表现为「静默无效」——比报错更难发现）。
  //   两端白名单必须镜像，本文件头已声明：改一边必须同步另一边。
  mistakes: ['topic', 'errorType', 'errorDesc', 'suggestion', 'status', 'source',
    'questionText', 'childAnswer', 'markSource'],
  // evidence 不在此列：证据只能由 tutorRetest 服务端判分写入（单写者），网页端已无该通道
  reviews: ['stage', 'dueAt', 'done'],
  // 闪卡（tutor_cards）：与 reviews 平行，可发布字段即 Leitner 盒子进度；不发布 front/back（内容不变）
  cards: ['box', 'dueAt', 'done', 'lastResult'],
  // F-B 试卷库：试卷是**资源库条目**（不是学情数据，不产生 evidence）。
  // 全字段可发布（含 markdown/rawText/answers 三段正文），索引元数据与正文一并搬运。
  exams: ['resourceId', 'fileName', 'name', 'level', 'examType', 'retestType', 'subject', 'subjectName',
    'stage', 'grade', 'textbookEdition', 'correspondingUnit', 'knowledgePoints',
    'suggestedDuration', 'maxEvidenceLevel', 'passingCriteria', 'officialUrl', 'answerUrl',
    'publisher', 'lastVerified', 'staleLink', 'sourceFile', 'sessionFile',
    'markdown', 'rawText', 'answers']
};

/** 字段归一化：只用于「是否实质变化」的比较。
 *  本地 md 是派生态，天然缺 `messages[*].ts`（md 正文只有角色+内容）—— 逐字节比较会永久判为「有差异」，
 *  导致每次推送都无谓更新、且把云端的 ts 丢掉。故比较时只取语义字段。 */
function normField(k, v) {
  if (k === 'messages' && Array.isArray(v)) {
    return v.map((m) => ({ role: (m && m.role) || '', content: (m && m.content) || '' }));
  }
  return v;
}

function sameFields(cloud, patch) {
  for (const k of Object.keys(patch)) {
    const a = normField(k, cloud ? cloud[k] : undefined);
    const b = normField(k, patch[k]);
    if (b !== null && typeof b === 'object') {
      if (JSON.stringify(a) !== JSON.stringify(b)) return false;
    } else if (a !== b) return false;
  }
  return true;
}

/** 发布时尽量保住云端已有的派生字段：同一位置 role+content 未变则沿用原 ts。 */
function carryOver(kind, patch, cloud) {
  if (kind === 'sessions' && Array.isArray(patch.messages) && Array.isArray(cloud && cloud.messages)) {
    const cm = cloud.messages;
    patch.messages = patch.messages.map((m, i) => {
      const o = cm[i];
      if (o && o.ts && o.role === m.role && o.content === m.content) return Object.assign({}, m, { ts: o.ts });
      return m;
    });
  }
  return patch;
}

/** 读家庭根数据（users[]/currentUserId），用于服务端解析 childId；无档案返回 null */
async function loadRootData(openid) {
  try {
    const res = await db().collection(COLLS.user).where({ _openid: openid }).limit(1).get();
    const u = (res && res.data && res.data[0]) || null;
    return (u && u.data && typeof u.data === 'object') ? u.data : null;
  } catch (e) {
    return null;
  }
}

async function writeTutor(kind, collName, openid, items, childId) {
  const dbh = db();
  let added = 0, skipped = 0, updated = 0;
  const conflicts = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const clientId = str(raw.clientId || raw.id, 60);
    if (!clientId) continue;
    const doc = G.stripIdentity(Object.assign({}, raw));
    doc.clientId = clientId;
    delete doc.id; delete doc.cloudId; delete doc._id;
    delete doc.childId;         // 归属只认服务端解析结果
    doc.childId = childId;
    const base = Number(doc.baseUpdatedAt) || 0;
    delete doc.baseUpdatedAt;   // 本地基线元数据，不落云

    let exist = [];
    try {
      const res = await dbh.collection(collName).where({ openid, clientId }).limit(1).get();
      exist = (res && res.data) || [];
    } catch (e) { exist = []; }

    if (!exist.length) {
      try {
        // add(obj)：obj 直接作为新文档（node-sdk 无 { data:{} } 包壳）；误加壳会变成单字段 data 文档
        await dbh.collection(collName).add(Object.assign({ openid }, doc));
        added++;
      } catch (e) {
        try { await dbh.createCollection(collName); } catch (e2) {}
        try { await dbh.collection(collName).add(Object.assign({ openid }, doc)); added++; } catch (e3) {}
      }
      continue;
    }

    // ---- 已存在 → 三路合并 ----
    const cloud = exist[0];
    const theirs = Number(cloud && cloud.updatedAt) || 0;
    const mine = Number(doc.updatedAt) || 0;

    if (base > 0 && theirs > base) {
      conflicts.push({ kind, clientId, reason: 'cloud_changed_after_pull', base, theirs, mine });
      skipped++;
      continue;
    }
    if (!base && !(mine > theirs)) {
      conflicts.push({ kind, clientId, reason: 'no_baseline_and_not_newer', theirs, mine });
      skipped++;
      continue;
    }

    const fields = PUBLISH_FIELDS[kind] || [];
    const patch = {};
    for (const k of fields) if (doc[k] !== undefined) patch[k] = doc[k];
    if (sameFields(cloud, patch)) { skipped++; continue; }   // 无实质变化，幂等跳过
    carryOver(kind, patch, cloud);
    patch.updatedAt = Date.now();

    try {
      // ⚠️ node-sdk 的 update(obj)：obj 的键就是「要更新的字段」，**没有 { data:{} } 包壳**
      //    （与 wx-server-sdk 不同！）。误写成 update({ data:{...} }) 会写成嵌套的 data.data，永不生效。
      await dbh.collection(collName).doc(cloud._id).update(patch);
      updated++;
    } catch (e) { skipped++; }
  }
  return { added, skipped, updated, conflicts };
}

/* ---------- F-B：试卷库写入（exam_resources，工作台单向权威）----------
 * 与 tutor_* 的差异与理由：
 *   · 试卷**只由工作台/专家侧生成**，小程序端纯只读、云端从不产生试卷 →
 *     工作台是该集合的唯一作者，因此「内容有变即发布」是安全的，不会覆盖他人的编辑。
 *   · 但基线保护仍然保留：若本地记有「云端版本」基线而云端已越过它，
 *     说明有本机之外的写入发生 → 一律拒绝覆盖并上报 conflict（绝不静默覆盖）。
 *   · 判定顺序刻意与 writeTutor 不同：**先判幂等（内容全同则跳过）再判基线**，
 *     否则「首推后再推一次未改动的卷」会因 base=0 被误报 conflict（噪音）。
 *   · 试卷是资源库条目：不产生 evidence、不参与任何「掌握」判定。
 */
async function writeExams(openid, items) {
  const dbh = db();
  let added = 0, skipped = 0, updated = 0;
  const conflicts = [];
  const fields = PUBLISH_FIELDS.exams;

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const clientId = str(raw.clientId || raw.resourceId, 80);
    if (!clientId) continue;

    const doc = Object.assign({}, raw);
    doc.clientId = clientId;
    delete doc.id; delete doc.cloudId; delete doc._id;
    const base = Number(doc.baseUpdatedAt) || 0;
    delete doc.baseUpdatedAt;          // 本地基线元数据，不落云

    let exist = [];
    try {
      const res = await dbh.collection(COLLS.exams).where({ openid, clientId }).limit(1).get();
      exist = (res && res.data) || [];
    } catch (e) { exist = []; }

    // ---- 新增 ----
    if (!exist.length) {
      const now = Date.now();
      const fresh = Object.assign({ openid }, doc, {
        createdAt: Number(doc.createdAt) || now,
        updatedAt: now                 // 云端版本 = 首次落库时刻，供下拉写回「云端版本」基线
      });
      try {
        await dbh.collection(COLLS.exams).add(fresh);
        added++;
      } catch (e) {
        try { await dbh.createCollection(COLLS.exams); } catch (e2) {}
        try { await dbh.collection(COLLS.exams).add(fresh); added++; } catch (e3) {}
      }
      continue;
    }

    // ---- 已存在：先判幂等，再判基线 ----
    const cloud = exist[0];
    const patch = {};
    for (const k of fields) if (doc[k] !== undefined) patch[k] = doc[k];

    if (sameFields(cloud, patch)) { skipped++; continue; }   // 内容全同 → 幂等跳过，不刷新 updatedAt

    const theirs = Number(cloud && cloud.updatedAt) || 0;
    if (base > 0 && theirs > base) {
      conflicts.push({ kind: 'exams', clientId, reason: 'cloud_changed_after_pull', base, theirs });
      skipped++;
      continue;
    }

    patch.updatedAt = Date.now();
    try {
      // node-sdk update(obj)：obj 的键即字段名，无 { data:{} } 包壳
      await dbh.collection(COLLS.exams).doc(cloud._id).update(patch);
      updated++;
    } catch (e) { skipped++; }
  }
  return { added, skipped, updated, conflicts };
}

/* ---------- profile 写入（字段级更新，绝不整份替换 data）----------
 * T5：同样走「基线」判定。hw_farm_user 的孩子切片没有逐字段时间戳，
 * 唯一可靠的判据是文档级 updatedAt（syncData 每次全量写 _root 时刷新）。
 *   · base 缺失（本地 md 从未下拉过）→ 拒绝覆盖，返回 conflict 并提示先下拉
 *   · theirs > base（下拉后小程序又写过）→ 拒绝覆盖，返回 conflict
 *   · 否则 → 写入
 *
 * 【F12 修复·2026-09-18】原来这里是「读整份 data → 内存改 → command.set(data) 整份替换」。
 *   文件头与本节注释都声明「绝不触碰 homework/checkin/schedule/农场」，但实现是**整份替换**——
 *   声明与实现不一致，就是隐患：基线的毫秒级时间戳给不了原子性，同一毫秒内的并发
 *   （小程序刚写完 homework 的瞬间）仍会被这份旧快照连带抹掉。
 *   现在改为**点号路径字段级 update**，只写本函数真正拥有的字段：
 *     data.users.<ci>.nickname / grade / learner / subjectProfiles.<key>
 *   由此产生三个直接好处：
 *     ① 结构上不可能碰到 homework / farm / schedule / coop —— 不再是「靠约定」，而是「靠不写」；
 *     ② 不再需要「读整份」，也就没有读-改-写窗口，连毫秒级竞态都没有；
 *     ③ 不再刷新未经改动字段的值，幂等更彻底。
 *   ⚠️ 保持 node-sdk 语义：update(obj) 的键就是字段名，**没有 { data:{} } 包壳**。
 *   ⚠️ subjectProfiles 逐 key 写，而不是整个对象替换 —— 只写工作台本次要改的学科，
 *      不会把小程序侧刚更新的其它学科画像一起压回去（原来的浅合并做不到这一点）。
 */
async function writeProfile(openid, profile) {
  if (!profile) return 'noop';
  const dbh = db();
  let users = [];
  try {
    const res = await dbh.collection(COLLS.user).where({ _openid: openid }).limit(1).get();
    users = (res && res.data) || [];
  } catch (e) { users = []; }
  if (!users.length) return 'no_user';
  const u = users[0];
  const theirs = Number(u.updatedAt) || 0;
  const base = Number(profile.baseUpdatedAt) || 0;
  if (base > 0 && theirs > base) {
    return { result: 'conflict', reason: 'cloud_changed_after_pull', base, theirs,
      hint: '云端在本地下拉之后被小程序改过，已跳过 profile 写入；请先 sync-pull 重建基线再推。' };
  }
  if (!base && theirs > 0) {
    return { result: 'conflict', reason: 'no_baseline', theirs,
      hint: '本地 md 缺少「云端版本」基线（从未下拉过），拒绝覆盖云端；请先 sync-pull。' };
  }

  // 定位当前孩子在 users[] 中的下标（点号路径要写死下标，不能猜 0）
  const rootData = (u.data && typeof u.data === 'object') ? u.data : {};
  const arr = Array.isArray(rootData.users) ? rootData.users : [];
  if (!arr.length) {
    return { result: 'no_slot', hint: '云端的 users[] 为空，没有可写的孩子切片；等小程序上传一次全量镜像后再推。' };
  }
  let ci = arr.findIndex(x => x && x.id === rootData.currentUserId);
  if (ci < 0) ci = 0;

  let wroteLearner = false, wroteProfiles = false;
  const P = `data.users.${ci}`;
  const patch = {};
  if (profile.nickname) patch[`${P}.nickname`] = profile.nickname;
  if (profile.grade) patch[`${P}.grade`] = profile.grade;
  // learner 由工作台独占（小程序侧只读展示），整对象写不会与端上打架
  if (profile.learner && typeof profile.learner === 'object') {
    patch[`${P}.learner`] = profile.learner;
    wroteLearner = true;
  }
  // subjectProfiles 逐学科写：只覆盖本次送来的学科，未送到的学科保持云端现值
  if (profile.subjectProfiles && typeof profile.subjectProfiles === 'object') {
    for (const k of Object.keys(profile.subjectProfiles)) {
      if (profile.subjectProfiles[k] === undefined) continue;
      patch[`${P}.subjectProfiles.${k}`] = profile.subjectProfiles[k];
      wroteProfiles = true;
    }
  }
  if (!Object.keys(patch).length) return 'noop';

  /* 网页端写入留痕（2026-10-27 修复：此前两处都不留痕 → 小程序整片覆盖）
   * 小程序推 profile 只有一条路：store.js:927 doUpload → syncData action:'upload'，
   * 服务端是 `update({ data: { data: payload, updatedAt: now } })`（syncData/index.js:143）
   * —— **整份 data 覆盖**，没有任何字段白名单。两道闸原本都拦不住它：
   *
   *  ① CAS 闸（syncData/index.js:141 `prev !== base`）：靠文档级 updatedAt 判断
   *     「云端是否被别人改过」。网页写入不刷新 updatedAt → 版本原地不动 → 闸放行。
   *     ⇒ 这里补 `updatedAt: Date.now()`，让小程序下一次推送判为 conflict。
   *
   *  ② F14 LWW 闸（store.js:1060-1082 f14MergeUser，cmp `_ts.<field>`）：
   *     只在 `cTs > lTs` 时采纳云端。网页写入不打 _ts → 判「本地更新」→ 保留本地旧值。
   *     而小程序冲突后走 reconcileWithCloud（store.js:1110 同样调 f14MergeUser）
   *     **本地优先重推**，所以只靠 ① 挡不住，必须同时补 ②。
   *     ⇒ 这里按 F14_FIELDS（store.js:1032）补 `_ts.learner` / `_ts.subjectProfiles`。
   *
   * ⚠️ nickname / grade 不在 F14 白名单，只能靠 ① 触发冲突提示（工作台侧已有
   *    baseUpdatedAt 语义，冲突即要求 sync-pull 重建基线），属 F10/F14 的已知边界。
   * ⚠️ 副作用可接受：dailyReset 的 CAS（dailyReset/index.js:146）自带多轮重读重算，
   *    updatedAt 被改只会让它多试一次，不会跳过结算。 */
  patch['updatedAt'] = Date.now();
  if (wroteLearner) patch[`${P}._ts.learner`] = Date.now();
  if (wroteProfiles) patch[`${P}._ts.subjectProfiles`] = Date.now();

  try {
    await dbh.collection(COLLS.user).doc(u._id).update(patch);
  } catch (e) {
    return 'err:' + ((e && e.message) || e);
  }

  // 历史误写自愈：早期版本 update({data:{data}}) 会在 data 内留下嵌套 data 键并逐次膨胀。
  // 单独一次尽力而为的删除（失败不影响本次写入结果），不再需要整份重写 data。
  if (rootData.data && typeof rootData.data === 'object') {
    try { await dbh.collection(COLLS.user).doc(u._id).update({ 'data.data': dbh.command.remove() }); }
    catch (e) { /* 字段级删除不可用时忽略：不影响主数据正确性，只是留着冗余 */ }
  }

  // 回读校验：把「实际落库」的昵称/科目数/数学错因一并返回，让调用方一眼确认是否写成功。
  // （历史上出现过「返回 merged 但读取不变」的假成功，必须自证。）
  // F12 起额外回传 verified/mismatch —— 字段级点号路径一旦在某环境不被支持，
  // 这里会明确报出来，而不是静默无效（这正是 F13 那个 bug 的教训）。
  let stored = null;
  try {
    const back = await dbh.collection(COLLS.user).doc(u._id).get();
    const d0 = Array.isArray(back && back.data) ? back.data[0] : (back && back.data);
    const rd = (d0 && d0.data) || {};
    const rus = Array.isArray(rd.users) ? rd.users : [];
    const rcu = rus.find(x => x && x.id === rd.currentUserId) || rus[0] || {};
    const rsp = rcu.subjectProfiles || {};
    const mismatch = [];
    if (patch[`${P}.nickname`] !== undefined && rcu.nickname !== patch[`${P}.nickname`]) mismatch.push('nickname');
    if (patch[`${P}.grade`] !== undefined && rcu.grade !== patch[`${P}.grade`]) mismatch.push('grade');
    Object.keys(profile.subjectProfiles || {}).forEach(k => {
      if (profile.subjectProfiles[k] !== undefined && !rsp[k]) mismatch.push('subjectProfiles.' + k);
    });
    stored = {
      nickname: rcu.nickname || '',
      grade: rcu.grade || '',
      subjects: Object.keys(rsp),
      mathErrors: (rsp.math && rsp.math.errors) || null,
      verified: mismatch.length === 0,
      mismatch
    };
  } catch (e) { stored = { readbackError: (e && e.message) || String(e) }; }
  return { result: 'merged', stored };
}

/* ---------- R2：云端 e2e 测试残留自清理 ----------
 * 只删除 clientId 以 'e2e-' 开头的文档；集合白名单见 E2E_SCOPES。
 * E2E 脚本本地已按前缀自清扫，云端残留由本动作兜底（§9.2 运维项⑤）。
 * 严格白名单：只动 e2e- 前缀、只动白名单集合；绝不触碰真实用户数据或其它集合。
 * 权限：仅管理员口令（WEB_DASHBOARD_TOKEN + WEB_ADMIN_ALLOW_WRITE=1）可触发；per-user 绑定令牌一律拒绝。
 *
 * 【T24 补 tutor_orders】2026-09-29：
 *   导学单上线时（T14）**漏了**把 tutor_orders 加进白名单 —— 于是导学单 E2E 的残留
 *   只能靠人去控制台手工删（开发计划 T24 卡里把这条记成了「项目已知坑」，
 *   与 tutor_sessions 同款问题）。清理动作按 clientId 前缀工作、与具体集合无关，
 *   把 tutor_orders 加进来即可，无需新增任何权限或接口。
 *   ⚠️ 出单走真实端上路径时云端自动生成的 clientId 形如 `to_YYMMDD_xxxxxx`，
 *      **不带** e2e- 前缀 —— 这类数据不会被本动作删掉（也就不会误删真实单）。
 *      只有外挂脚本显式带前缀造的数据才会被清理。 */
const E2E_PREFIX = 'e2e-';
/** 可清理集合白名单（**只允许**这几个；新增必须在此显式登记） */
const E2E_SCOPES = ['tutor_sessions', 'tutor_orders'];
async function cleanupE2E() {
  const dbh = db();
  const scopes = [];
  let removedTotal = 0;
  for (const name of E2E_SCOPES) {
    let scanned = 0, removed = 0, err = null;
    try {
      // clientId 前缀匹配：仅命中 e2e- 测试残留
      const res = await dbh.collection(name)
        .where({ clientId: dbh.command.regex('^' + E2E_PREFIX) })
        .limit(100).get();
      const list = (res && res.data) || [];
      scanned = list.length;
      for (const d of list) {
        // 防御：双重校验，只删 clientId 确实以 e2e- 开头的文档，绝不波及真实数据
        if (typeof d.clientId !== 'string' || !d.clientId.startsWith(E2E_PREFIX)) continue;
        try { await dbh.collection(name).doc(d._id).remove(); removed++; } catch (e) {}
      }
    } catch (e) { err = (e && e.message) || String(e); }
    removedTotal += removed;
    scopes.push({ scope: name, scanned, removed, err: err || undefined });
  }
  return { ok: true, action: 'cleanup', scope: E2E_SCOPES.join('+'), prefix: E2E_PREFIX,
    scopes, removed: removedTotal };
}

/* ---------- 教学计划导入（2026-10-26）：网页端专属，字段级写 ----------
 * 只写 `data.users.<ci>.subjectProfiles.<key>.teachingPlan` 一个子字段，不整对象替换
 * subjectProfiles（与小程序 typeProfile 保存的整 profile 写互不踩脚）。
 * 冲突闸与 writeProfile 同语义：base=网页加载 profile 时的文档 updatedAt，
 * 云端被小程序更新过 → conflict 拒写，提示刷新，绝不静默覆盖。 */
async function writeTeachingPlan(openid, tp) {
  if (!tp || typeof tp !== 'object') return { result: 'noop' };
  const key = String(tp.key || '').trim().slice(0, 30);
  if (!key) return { result: 'bad_param', hint: '缺少学科 key' };
  const raw = String(tp.raw || '').slice(0, 20000);
  const title = String(tp.title || '').trim().slice(0, 60);
  const format = String(tp.format || 'text').slice(0, 10);
  const base = Number(tp.base) || 0;
  const dbh = db();
  let users = [];
  try {
    const res = await dbh.collection(COLLS.user).where({ _openid: openid }).limit(1).get();
    users = (res && res.data) || [];
  } catch (e) { users = []; }
  if (!users.length) return { result: 'no_user', hint: '找不到该孩子的主文档' };
  const u = users[0];
  const theirs = Number(u.updatedAt) || 0;
  if (base > 0 && theirs > base) {
    return { result: 'conflict', reason: 'cloud_changed_after_pull', base, theirs,
      hint: '云端数据在网页加载后被小程序更新过，请刷新页面后重试（教学计划未写入）。' };
  }
  // 与 writeProfile 同口径：本函数写入后会刷新文档级 updatedAt（见下方留痕说明），
  // 所以「本地基线为 0」只可能是页面加载后云端已被写过，一律拒写而不是静默覆盖。
  if (!base && theirs > 0) {
    return { result: 'conflict', reason: 'no_baseline', theirs,
      hint: '本地缺少云端版本基线（页面数据已过期），请刷新页面后重试（教学计划未写入）。' };
  }
  const rootData = (u.data && typeof u.data === 'object') ? u.data : {};
  const arr = Array.isArray(rootData.users) ? rootData.users : [];
  if (!arr.length) return { result: 'no_slot', hint: '云端 users[] 为空，请先在小程序打开一次导学功能' };
  let ci = arr.findIndex(x => x && x.id === rootData.currentUserId);
  if (ci < 0) ci = 0;
  /* 学科画像必须已存在：点号路径 `subjectProfiles.<key>.teachingPlan` 在画像不存在时
   * 会凭空造出只有 teachingPlan 一个键的残缺结构，而小程序 ensureUserFields
   * （store.js:258-276）**不会**补全 subjectProfiles 内部结构 → 端上读 dimensions 为
   * undefined 可能崩。宁可明确报错，也不写残缺数据。 */
  const curUser = arr[ci] || {};
  const curSp = (curUser.subjectProfiles && typeof curUser.subjectProfiles === 'object')
    ? curUser.subjectProfiles[key] : null;
  if (!curSp || typeof curSp !== 'object') {
    return { result: 'no_profile', key: key,
      hint: '云端还没有「' + key + '」的学科画像，请先在小程序端打开一次该学科的画像页，再回到网页导入。' };
  }
  const rec = { title: title, raw: raw, format: format, updatedAt: Date.now() };
  const now = Date.now();
  const patch = {};
  patch['data.users.' + ci + '.subjectProfiles.' + key + '.teachingPlan'] = rec;
  /* 留痕（2026-10-27 修复）：与 writeProfile 完全同理由，缺一不可 ——
   *   ① updatedAt → syncData CAS 闸（syncData/index.js:141）判定冲突；
   *   ② _ts.subjectProfiles → 小程序 F14 LWW（store.js:1074）判定「云端更新」并采纳。
   * 只补 ① 不够：小程序冲突后 reconcileWithCloud 本地优先重推，仍会把 teachingPlan 抹掉。 */
  patch['updatedAt'] = now;
  patch['data.users.' + ci + '._ts.subjectProfiles'] = now;
  try {
    await dbh.collection(COLLS.user).doc(u._id).update(patch);
  } catch (e) { return { result: 'err', hint: (e && e.message) || String(e) }; }
  return { result: 'ok', key: key, chars: raw.length, cleared: raw === '', updatedAt: now };
}

/* ---------- 教材库导入（2026-10-26）：网页端代理 examService ----------
 * 为什么代理而不是复制解析代码：parseTextbookText/searchTextbook 的 hy3 链路、
 * normalizeTextbook、官方种子保护（撞官方 id 自动换新 id 复制）都在 examService，
 * 复制必然分叉。身份：共享密钥 EXAM_ADMIN_KEY + 显式 openid（服务端对服务端，
 * 网页端不持有密钥；两函数 env 必须同值，见 examService resolveOpenid 的 admin 分支）。 */
const EXAM_SVC_NAME = 'examService';
const TB_ACTION_MAP = {
  list: 'listTextbooks', get: 'getTextbook', parseText: 'parseTextbookText',
  parsePdf: 'parseTextbookPdf',
  save: 'saveTextbook', search: 'searchTextbook', delete: 'deleteTextbook'
};
async function callExamService(app2, action, openid, payload) {
  const adminKey = (process.env.EXAM_ADMIN_KEY || '').trim();
  if (!adminKey) return { ok: false, code: 'no_admin_key', msg: '本函数未配置 EXAM_ADMIN_KEY，教材代理不可用' };
  const res = await app2.callFunction({
    name: EXAM_SVC_NAME,
    data: Object.assign({}, payload || {}, { action: action, openid: openid, adminKey: adminKey })
  });
  return (res && res.result) || { ok: false, code: 'no_result', msg: 'examService 无返回' };
}

/* ---------- R3：childId 历史数据迁移（P0-8，默认 dry-run）----------
 * 背景：多孩遍历（P0-2/3）之后新行都带 childId，但历史行没有 —— 看板同一天会同时出现
 * 「孩子级行」和「legacy 行」两条（webAdminQuery 已按 replaced/unattributed 区分展示）。
 *
 * 铁律（架构设计 §11 P0-8）：**不做任何自动归属**。
 *   · 只有「恰好 1 个真实孩子」的家庭才存在唯一答案，且仍须调用方显式 confirm:true
 *     （家长确认）；不传 confirm 一律 dry-run，只出报告、一个字都不写；
 *   · 多孩家庭一律跳过并计入 ambiguous —— 由家长在确认页逐行指定 assignments
 *     （键：`<collection>:<_id>`，也接受裸 `_id`），未指定的行永远不动；
 *   · 占位切片（guest/__placeholder）不算孩子；跨家庭 childId 直接判冲突、不采纳；
 *   · 已有 childId 的行不动（幂等：可反复跑）。
 * 审计：每次 confirm 运行都往 tutor_migrations 追加一条（含计数、归属与冲突数）。
 * 只动 `_openid` 归口的农场日志集合；tutor_* 镜像的归属另议（见文件头）。 */
const MIGRATION_AUDIT = 'tutor_migrations';
const MIGRATABLE = [
  { coll: 'hw_checkin_log', owner: '_openid' },
  { coll: 'hw_farm_settle', owner: '_openid' }
];
const MIGRATION_PAGE = 100;
const MIGRATION_MAX_PAGES = 20;
const MIGRATION_SAMPLE = 100;

async function scanLegacyRows(collName, owner, openid) {
  const dbh = db();
  const rows = [];
  for (let page = 0; page < MIGRATION_MAX_PAGES; page++) {
    let batch = [];
    try {
      const res = await dbh.collection(collName)
        .where({ [owner]: openid })
        .skip(page * MIGRATION_PAGE)
        .limit(MIGRATION_PAGE)
        .get();
      batch = (res && res.data) || [];
    } catch (e) {
      return { rows: rows, error: (e && e.message) || String(e) };
    }
    for (const row of batch) rows.push(row);
    if (batch.length < MIGRATION_PAGE) return { rows: rows };
  }
  return { rows: rows, truncated: true };
}

/* ---------- 家长会话校验（迁移确认是家长动作）----------
 * 语义只有一份：parentAuth。本函数据此判断，不自己算散列、不读 parent_sessions，
 * 否则两处规则迟早分叉。管理员口令不走家长口令：它是部署者身份，不是某个家长。
 */
async function requireParentSession(appObj, webToken, parentSessionToken) {
  const t = str(parentSessionToken, 200);
  if (!t) return { ok: false, code: 'need_parent_pin', msg: '需要先验证家长口令' };
  let r = {};
  try {
    const res = await appObj.callFunction({
      name: 'parentAuth',
      data: { action: 'status', webToken: webToken, sessionToken: t }
    });
    r = (res && res.result) || {};
  } catch (e) {
    return { ok: false, code: 'parent_auth_error', msg: '家长口令校验失败：' + ((e && e.message) || e) };
  }
  if (!r.ok) return { ok: false, code: r.code || 'parent_auth_error', msg: r.msg || '家长口令校验失败' };
  if (!(r.session && r.session.active === true)) {
    return { ok: false, code: 'parent_session_invalid', msg: '家长验证已失效，请重新输入家长口令' };
  }
  return { ok: true, expiresAt: Number(r.session.expiresAt) || 0 };
}

async function migrateChildScope(openid, req) {
  const root = await loadRootData(openid);
  const kids = G.childrenOf(root).map(u => u.id);
  if (!kids.length) {
    return { ok: false, code: 'no_children', msg: '该账号还没有真实孩子档案，无法确定归属（占位切片不算孩子）' };
  }
  const dryRun = req.confirm !== true;
  const rawAssign = (req.assignments && typeof req.assignments === 'object' && !Array.isArray(req.assignments))
    ? req.assignments : {};
  const validAssign = {};
  const conflicts = [];
  for (const key of Object.keys(rawAssign)) {
    const cid = str(rawAssign[key], 40);
    if (G.isChildOf(root, cid)) validAssign[key] = cid;
    else conflicts.push({ key: key, reason: 'child_not_in_family' });
  }
  const out = {
    ok: true, action: 'migrateChildScope', dryRun: dryRun,
    children: kids, autoChildId: kids.length === 1 ? kids[0] : '',
    pending: 0, updated: 0, ambiguous: 0,
    scopes: [], samples: [], conflicts: conflicts
  };
  const dbh = db();
  for (const scope of MIGRATABLE) {
    const scan = await scanLegacyRows(scope.coll, scope.owner, openid);
    const stat = { coll: scope.coll, scanned: scan.rows.length, pending: 0, plan: 0, updated: 0, ambiguous: 0, errors: [] };
    if (scan.error) stat.errors.push(scan.error);
    if (scan.truncated) stat.truncated = true;
    for (const row of scan.rows) {
      if (row.childId) continue;
      stat.pending++;
      const target = validAssign[scope.coll + ':' + row._id] || validAssign[row._id] || out.autoChildId;
      if (!target) {
        stat.ambiguous++;
        if (out.samples.length < MIGRATION_SAMPLE) {
          out.samples.push({ coll: scope.coll, id: row._id, date: row.date || row.createdAt || 0, candidates: kids });
        }
        continue;
      }
      stat.plan++;
      if (dryRun) continue;
      try {
        await dbh.collection(scope.coll).doc(row._id).update({ childId: target });
        stat.updated++;
        out.updated++;
      } catch (e) {
        stat.errors.push(scope.coll + ':' + row._id + ' ' + ((e && e.message) || String(e)));
      }
    }
    out.pending += stat.pending;
    out.ambiguous += stat.ambiguous;
    out.scopes.push(stat);
  }
  if (!dryRun) {
    const audit = {
      openid: openid, at: Date.now(),
      children: kids, autoChildId: out.autoChildId,
      assignments: Object.keys(validAssign), conflicts: conflicts.length,
      pending: out.pending, updated: out.updated, ambiguous: out.ambiguous,
      scopes: out.scopes.map(s => ({ coll: s.coll, scanned: s.scanned, pending: s.pending, updated: s.updated, ambiguous: s.ambiguous }))
    };
    try { await dbh.collection(MIGRATION_AUDIT).add(audit); } catch (e) { out.auditError = (e && e.message) || String(e); }
  }
  return out;
}

/* ---------- 主入口 ---------- */
exports.main = async (event) => {
  const token = (event && event.token) || '';
  if (!token) return { ok: false, code: 'auth', msg: '缺少 token' };

  // R2：云端 e2e 残留清理（仅管理员 + 显式开启写权限时可触发；per-user 绑定令牌不可触发删除）
  if (event.action === 'cleanup') {
    const expect = process.env.WEB_DASHBOARD_TOKEN;
    if (!(expect && token === expect && process.env.WEB_ADMIN_ALLOW_WRITE === '1')) {
      return { ok: false, code: 'forbidden', msg: '清理操作仅限管理员口令且需开启写权限' };
    }
    return await cleanupE2E();
  }

  let openid = null;
  let adminCall = false;
  const expect = process.env.WEB_DASHBOARD_TOKEN;
  if (expect && token === expect && process.env.WEB_ADMIN_ALLOW_WRITE === '1') {
    // 管理员口令仅在显式开启写权限时才可写；否则一律走 per-user 绑定
    openid = event.openid || null;
    adminCall = true;
  } else {
    const bind = await resolveBinding(token);
    if (!bind) return { ok: false, code: 'auth', msg: '访问口令无效或已撤销' };
    openid = bind.openid;
  }
  if (!openid) return { ok: false, code: 'no_openid', msg: '无法解析目标 openid，拒绝写入（不产生无主数据）' };

  let app2;
  try { app2 = tcb.init({ env: ENV }); } catch (e) {
    return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) };
  }

  /* ---------- childId 历史数据迁移（家长确认）----------
   * 与 orders / teachingPlan 同款：失败必须返回 {ok:false}，不能让云函数直接 reject。
   * 默认 dry-run（confirm !== true），只出报告不写库；归属规则见 migrateChildScope 注释。 */
  if (event.action === 'migrateChildScope') {
    /* 确认写入 = 家长动作：必须先有该家庭的家长口令会话（管理员身份除外，它没有家长可言）。 */
    if (event.confirm === true && !adminCall) {
      const gate = await requireParentSession(app2, token, event.parentSessionToken);
      if (!gate.ok) {
        return { ok: false, code: gate.code, msg: gate.msg, action: 'migrateChildScope', gated: true };
      }
    }
    let r;
    try {
      r = await migrateChildScope(openid, event);
    } catch (e) {
      return { ok: false, code: 'migrate_error', msg: '迁移失败：' + ((e && e.message) || e) };
    }
    if (r && r.ok && !r.dryRun) {
      try { await db().collection(COLLS.bindings).where({ token, revoked: false }).limit(1).update({ lastUsed: Date.now() }); } catch (e) {}
    }
    return r;
  }

  /* ---------- 导学单（tutor_orders）专用通道 ----------
   * 网页看板 / 工作台是本单的**第二写入口**（第一个是小程序 tutorOrder）。
   * 关键是：两者必须共用同一份状态机与同一套硬契约，否则 O1–O4 必然分叉。
   * 做法：orders 传**对象** { action, ...payload }，直接路由到 orderActions（canonical 副本，
   * 与 tutorOrder 逐字节相同）；本文件不实现任何导学单业务规则。
   *
   * ⚠️ 传数组一律拒绝：数组形态意味着「批量覆盖」，而 orders 的 status / events 是
   *    O2/O4 的载体，绝不允许被批量覆盖（这正是 tutorSync.push 对 orders 只补写不合并的同一条理由）。
   * ⚠️ action 白名单由 orderActions.ACTIONS 决定，未知 action 必须显式报错，不得静默忽略。
   */
  if (event.orders !== undefined) {
    if (Array.isArray(event.orders) || typeof event.orders !== 'object' || event.orders === null) {
      return {
        ok: false, code: 'bad_param',
        msg: 'orders 必须是对象 { action, ...payload }；批量数组写入被拒绝（状态与事件不允许被覆盖）'
      };
    }
    const req = event.orders;
    const act = String(req.action || '');
    if (orderActions.ACTIONS.indexOf(act) < 0) {
      return { ok: false, code: 'bad_action', msg: '未知导学单 action: ' + (act || '(空)') };
    }
    try {
      const deps = makeDeps(app2, openid, { collection: COLLS.orders });
      const res = await orderActions[act](req, deps);
      if (res && res.ok) {
        try { await db().collection(COLLS.bindings).where({ token, revoked: false }).limit(1).update({ lastUsed: Date.now() }); } catch (e) {}
      }
      return res;
    } catch (e) {
      return { ok: false, code: 'order_error', msg: '导学单操作失败：' + ((e && e.message) || e) };
    }
  }

  /* ---------- 教学计划导入通道（网页端「教材·计划」页专用，字段级写） ---------- */
  if (event.teachingPlan !== undefined) {
    if (Array.isArray(event.teachingPlan) || typeof event.teachingPlan !== 'object' || event.teachingPlan === null) {
      return { ok: false, code: 'bad_param', msg: 'teachingPlan 必须是对象 { key, title, raw, format, base }' };
    }
    let r;
    try {
      r = await writeTeachingPlan(openid, event.teachingPlan);
    } catch (e) {
      // 与 orders / textbook 两个通道同款兜底：db() 或点号路径 update 抛错时也要返回
      // {ok:false}，不能让云函数直接 reject（端上拿到的会是平台错误而非业务错误）。
      return { ok: false, code: 'tp_error', msg: '教学计划写入失败：' + ((e && e.message) || e) };
    }
    if (r && r.result === 'ok') {
      try { await db().collection(COLLS.bindings).where({ token, revoked: false }).limit(1).update({ lastUsed: Date.now() }); } catch (e) {}
      return { ok: true, scope: 'user', openid, teachingPlan: r };
    }
    return { ok: false, code: (r && r.result) || 'tp_error', msg: (r && r.hint) || '教学计划写入失败' };
  }

  /* ---------- 教材库代理通道（网页端「教材·计划」页专用，转发 examService） ---------- */
  if (event.textbook !== undefined) {
    const tb = event.textbook;
    if (Array.isArray(tb) || typeof tb !== 'object' || tb === null) {
      return { ok: false, code: 'bad_param', msg: 'textbook 必须是对象 { action, ...payload }' };
    }
    const act = String(tb.action || '');
    if (!TB_ACTION_MAP[act]) return { ok: false, code: 'bad_action', msg: '未知教材 action: ' + (act || '(空)') };
    try {
      const payload = Object.assign({}, tb);
      delete payload.action;
      const res = await callExamService(app2, TB_ACTION_MAP[act], openid, payload);
      if (res && res.ok) {
        try { await db().collection(COLLS.bindings).where({ token, revoked: false }).limit(1).update({ lastUsed: Date.now() }); } catch (e) {}
      }
      return res;
    } catch (e) {
      return { ok: false, code: 'proxy_error', msg: '教材服务调用失败：' + ((e && e.message) || e) };
    }
  }

  try {
    const input = {
      sessions: Array.isArray(event.sessions) ? event.sessions : [],
      mistakes: Array.isArray(event.mistakes) ? event.mistakes : [],
      reviews: Array.isArray(event.reviews) ? event.reviews : [],
      cards: Array.isArray(event.cards) ? event.cards : []
    };
    /* evidence 通道已关闭：证据只能由 tutorRetest 服务端判分写入。
     * 收到即计数拒绝，不落库（旧工作台版本继续推也只是被拒，不会写坏数据）。 */
    const rejectedEvidence = Array.isArray(event.evidence) ? event.evidence.length : 0;
    const kid = G.resolveChildId(await loadRootData(openid), event.childId);
    if (kid.source === 'invalid') {
      return { ok: false, code: 'child_scope_invalid', msg: '指定的孩子不属于该家庭，已拒绝写入' };
    }
    const map = {
      sessions: 'tutor_sessions', mistakes: 'tutor_mistakes',
      reviews: 'tutor_reviews', cards: 'tutor_cards'
    };
    const tally = { added: 0, skipped: 0, updated: 0, rejected: rejectedEvidence };
    const conflicts = [];
    for (const kind of Object.keys(map)) {
      const r = await writeTutor(kind, map[kind], openid, input[kind], kid.childId);
      tally.added += r.added; tally.skipped += r.skipped; tally.updated += r.updated;
      if (r.conflicts && r.conflicts.length) conflicts.push(...r.conflicts);
    }
    // F-B：试卷库（exam_resources）—— 单独走 writeExams（判定顺序与 tutor_* 不同，见其注释）
    const exams = Array.isArray(event.exams) ? event.exams.slice(0, 200) : [];
    if (exams.length) {
      const re = await writeExams(openid, exams);
      tally.added += re.added; tally.skipped += re.skipped; tally.updated += re.updated;
      if (re.conflicts && re.conflicts.length) conflicts.push(...re.conflicts);
      tally.exams = { added: re.added, skipped: re.skipped, updated: re.updated };
    }
    const profileRes = await writeProfile(openid, event.profile);
    if (profileRes && profileRes.result === 'conflict') {
      conflicts.push({ kind: 'profile', clientId: 'profile', reason: profileRes.reason,
        base: profileRes.base, theirs: profileRes.theirs });
    }
    try { await db().collection(COLLS.bindings).where({ token, revoked: false }).limit(1).update({ lastUsed: Date.now() }); } catch (e) {}
    return { ok: true, scope: 'user', openid, ...tally, conflictCount: conflicts.length, conflicts, profile: profileRes };
  } catch (e) {
    return { ok: false, code: 'write_error', msg: '写入失败：' + ((e && e.message) || e) };
  }
};

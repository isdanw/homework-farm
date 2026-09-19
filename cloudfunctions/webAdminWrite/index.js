/**
 * 云函数 webAdminWrite —— 家长数据看板·写入代理（与 webAdminQuery 对称，T3 工作台→云 push）
 *
 * 职责（不可破坏的红线）：
 *   · 写。但只写「导学镜像」四类集合（tutor_sessions/mistakes/evidence/reviews）+「试卷库」
 *     （exam_resources）+ 孩子切片（learner / subjectProfiles / nickname / grade）；
 *     绝不触碰 homework/checkin/schedule/农场等小程序权威数据，避免镜像写回污染主链路。
 *   · 身份解析：复用 webAdminQuery 的 token→openid 机制（web_portal_bindings），不接收微信上下文。
 *   · 去重：tutor_* 与 exam_resources 均按 openid+clientId 查重。**T5 起 tutor_* 改为三路合并**
 *     （base=本地「云端版本」基线 / mine=本地 md / theirs=云端当前 updatedAt）：下拉后云端被小程序
 *     改过则拒绝覆盖并上报 conflicts；仅在「云端仍停在我下拉时的版本」或「本地确更新」时才发布。
 *     绝不静默覆盖。（F-B 试卷库的判定顺序不同，见 writeExams 注释。）
 *   · 纯数据搬运，不调用 AI、不做"掌握"判定。
 *
 * 入参：
 *   { token:'xxx', sessions:[], mistakes:[], evidence:[], reviews:[], exams:[],
 *     profile:{ nickname, grade, learner, subjectProfiles, baseUpdatedAt } }
 *   （每条 tutor 记录可带 baseUpdatedAt = 上次下拉时的云端 updatedAt，不落库；
 *     exams 每条的 clientId = resourceId）
 * 出参：{ ok:true, scope, openid, added, skipped, updated, exams?, conflictCount, conflicts[], profile }
 *       或 { ok:false, code, msg }
 */

const tcb = require('@cloudbase/node-sdk');

const ENV = process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf';
const COLLS = {
  user: 'hw_farm_user',
  sessions: 'tutor_sessions',
  mistakes: 'tutor_mistakes',
  reviews: 'tutor_reviews',
  evidence: 'tutor_evidence',
  exams: 'exam_resources',
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

/* ---------- 工具：取「当前孩子」切片 ---------- */
function currentUser(data) {
  const us = (data && Array.isArray(data.users)) ? data.users : [];
  return us.find(x => x && x.id === (data && data.currentUserId)) || us[0] || {};
}

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
  evidence: ['total', 'correct', 'rate', 'passed'],
  reviews: ['stage', 'dueAt', 'done'],
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

async function writeTutor(kind, collName, openid, items) {
  const dbh = db();
  let added = 0, skipped = 0, updated = 0;
  const conflicts = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const clientId = str(raw.clientId || raw.id, 60);
    if (!clientId) continue;
    const doc = Object.assign({}, raw);
    doc.clientId = clientId;
    delete doc.id; delete doc.cloudId; delete doc._id;
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

  const P = `data.users.${ci}`;
  const patch = {};
  if (profile.nickname) patch[`${P}.nickname`] = profile.nickname;
  if (profile.grade) patch[`${P}.grade`] = profile.grade;
  // learner 由工作台独占（小程序侧只读展示），整对象写不会与端上打架
  if (profile.learner && typeof profile.learner === 'object') patch[`${P}.learner`] = profile.learner;
  // subjectProfiles 逐学科写：只覆盖本次送来的学科，未送到的学科保持云端现值
  if (profile.subjectProfiles && typeof profile.subjectProfiles === 'object') {
    for (const k of Object.keys(profile.subjectProfiles)) {
      if (profile.subjectProfiles[k] === undefined) continue;
      patch[`${P}.subjectProfiles.${k}`] = profile.subjectProfiles[k];
    }
  }
  if (!Object.keys(patch).length) return 'noop';

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
 * 仅删除 tutor_sessions 中 clientId 以 'e2e-' 开头的文档。
 * E2E 脚本本地已按前缀自清扫，云端残留由本动作兜底（§9.2 运维项⑤）。
 * 严格白名单：只动 e2e- 前缀、只动 tutor_sessions；绝不触碰真实用户数据或其它集合。
 * 权限：仅管理员口令（WEB_DASHBOARD_TOKEN + WEB_ADMIN_ALLOW_WRITE=1）可触发；per-user 绑定令牌一律拒绝。 */
const E2E_PREFIX = 'e2e-';
async function cleanupE2E() {
  const dbh = db();
  let scanned = 0, removed = 0, err = null;
  try {
    // clientId 前缀匹配：仅命中 e2e- 测试残留
    const res = await dbh.collection('tutor_sessions')
      .where({ clientId: dbh.command.regex('^' + E2E_PREFIX) })
      .limit(100).get();
    const list = (res && res.data) || [];
    scanned = list.length;
    for (const d of list) {
      // 防御：双重校验，只删 clientId 确实以 e2e- 开头的文档，绝不波及真实数据
      if (typeof d.clientId !== 'string' || !d.clientId.startsWith(E2E_PREFIX)) continue;
      try { await dbh.collection('tutor_sessions').doc(d._id).remove(); removed++; } catch (e) {}
    }
  } catch (e) { err = (e && e.message) || String(e); }
  return { ok: true, action: 'cleanup', scope: 'tutor_sessions', prefix: E2E_PREFIX,
    scanned, removed, err: err || undefined };
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
  const expect = process.env.WEB_DASHBOARD_TOKEN;
  if (expect && token === expect && process.env.WEB_ADMIN_ALLOW_WRITE === '1') {
    // 管理员口令仅在显式开启写权限时才可写；否则一律走 per-user 绑定
    openid = event.openid || null;
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

  try {
    const input = {
      sessions: Array.isArray(event.sessions) ? event.sessions : [],
      mistakes: Array.isArray(event.mistakes) ? event.mistakes : [],
      evidence: Array.isArray(event.evidence) ? event.evidence : [],
      reviews: Array.isArray(event.reviews) ? event.reviews : []
    };
    const map = {
      sessions: 'tutor_sessions', mistakes: 'tutor_mistakes',
      evidence: 'tutor_evidence', reviews: 'tutor_reviews'
    };
    const tally = { added: 0, skipped: 0, updated: 0 };
    const conflicts = [];
    for (const kind of Object.keys(map)) {
      const r = await writeTutor(kind, map[kind], openid, input[kind]);
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

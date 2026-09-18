/**
 * 云函数 webAdminQuery —— 家长数据看板·只读代理（D1）
 *
 * 职责（不可破坏的红线）：
 *   · 只读。不写库、不更新任何状态、不调用 AI。
 *   · 家长单视角：跨 openid 聚合查全部家庭/孩子数据（小程序端按 openid 隔离，网页端需管理员权限绕过）。
 *   · 访问口令：校验请求体 token 等于环境变量 WEB_DASHBOARD_TOKEN；不符即拒，不返回任何数据。
 *   · 纯数据搬运 + 服务端聚合，不生成任何"掌握"判定（掌握度只来自 tutor_evidence.passed=true）。
 *
 * 入参：
 *   { token:'xxx', module:'overview|farm|tutor|profile', query:{ range:'7d', openid:'', subject:'' } }
 * 出参：{ ok:true, module, data:{...} } 或 { ok:false, code, msg }
 *
 * 聚合口径：
 *   · 打卡率 = hw_checkin_log 中三科 done 数 / (3 × 日志记录数)
 *   · 学科分布 = tutor_sessions 按 subject 分组计数
 *   · 错因分布 = tutor_mistakes 按 errorType(E1–E9) 分组计数
 *   · 待复习 = tutor_reviews done=false 且 dueAt≤now
 *   · 已掌握 = tutor_evidence passed=true 计数
 *   · 已订正 = tutor_mistakes status='corrected'（≠掌握，单独计）
 */
const tcb = require('@cloudbase/node-sdk');

const ENV = process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf';
const COLLS = {
  user: 'hw_farm_user',
  log: 'hw_checkin_log',
  settle: 'hw_farm_settle',
  events: 'hw_farm_events',
  sessions: 'tutor_sessions',
  mistakes: 'tutor_mistakes',
  reviews: 'tutor_reviews',
  evidence: 'tutor_evidence',
  exams: 'exam_resources',
  bindings: 'web_portal_bindings'
};
const READ_LIMIT = 200; // 单集合读取上限（防误拉全量，家庭自用量级足够）

let _app = null;
function app() {
  if (!_app) _app = tcb.init({ env: ENV });
  return _app;
}
function db() { return app().database(); }

/* ---------- 工具：分页取全部（限时） ---------- */
async function getAll(name, where) {
  const d = db();
  const out = [];
  try {
    const countRes = await d.collection(name).where(where || {}).count();
    const total = countRes.total || 0;
    const pages = Math.min(Math.ceil(total / READ_LIMIT), 20); // 封顶 20 页 = 4000 条
    for (let i = 0; i < pages; i++) {
      const res = await d.collection(name).where(where || {}).orderBy('createdAt', 'desc').skip(i * READ_LIMIT).limit(READ_LIMIT).get();
      if (res && res.data) out.push(...res.data);
    }
  } catch (e) {
    // 集合不存在 → 当作空，不阻塞其他集合
  }
  return out;
}

function groupCount(rows, key) {
  const m = {};
  rows.forEach(r => { const k = r[key] || '未知'; m[k] = (m[k] || 0) + 1; });
  return Object.keys(m).map(k => ({ n: k, v: m[k] })).sort((a, b) => b.v - a.v);
}

/* ---------- 工具：按账号维度过滤（per-user 口令场景） ---------- */
function ofilter(name, openid) {
  if (!openid) return {}; // 管理员：不过滤，看全部
  // hw_farm_* 用文档属主 _openid；tutor_* 与 exam_resources 用明文 openid
  if (name === COLLS.user || name === COLLS.log || name === COLLS.settle || name === COLLS.events) return { _openid: openid };
  return { openid };
}

/* ---------- 工具：取「当前孩子」切片 ----------
 * ⚠️ 关键：hw_farm_user.data 存的是整个 _root（{ version, users:[...], currentUserId, coop }），
 * 孩子级字段（homework/schedule/learner/subjectProfiles/studyPlans/plans/farm/checkinTypes/
 * comments/learn/profile）全部挂在 data.users[i] 上，**data 顶层并没有这些字段**。
 * 早期误从 data.xxx 读取 → 网页永远空。所有孩子级字段一律走本函数。
 * coop 是 _root 级（全家庭共享），仍从 data.coop 取。 */
function currentUser(data) {
  const us = (data && Array.isArray(data.users)) ? data.users : [];
  return us.find(x => x && x.id === (data && data.currentUserId)) || us[0] || {};
}

/* ---------- 工具：日期加减（'YYYY-MM-DD'） ---------- */
function dateKey(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 各模块聚合 ---------- */
async function overview(query, openid) {
  const [sessions, mistakes, reviews, evidence, users] = await Promise.all([
    getAll(COLLS.sessions, ofilter(COLLS.sessions, openid)),
    getAll(COLLS.mistakes, ofilter(COLLS.mistakes, openid)),
    getAll(COLLS.reviews, ofilter(COLLS.reviews, openid)),
    getAll(COLLS.evidence, ofilter(COLLS.evidence, openid)),
    getAll(COLLS.user, ofilter(COLLS.user, openid))
  ]);
  const now = Date.now();
  // 范围窗口（今日/7日/30日）
  const range = (query && query.range) || '7d';
  const days = range === '1d' ? 1 : (range === '30d' ? 30 : 7);
  const windowSet = {};
  for (let i = days - 1; i >= 0; i--) windowSet[dateKey(-i)] = true;

  // 打卡率：直接由 hw_farm_user 的 homework（权威源，与小程序/今日打卡一致）聚合。
  // homework[日期][typeKey]={done,...}；跳过 allDoneGranted 等非对象标记位。
  // （原取自 hw_checkin_log，但该集合长期为空 —— syncData 曾误读顶层 homework，已一并修复；
  //   这里改用 homework 可覆盖全部历史日期，且保证与其它视图口径一致。）
  const byDate = {};
  users.forEach(u => {
    const data = (u && u.data) || {};
    const us = Array.isArray(data.users) ? data.users : [];
    us.forEach(cu => {
      const hw = cu.homework || {};
      Object.keys(hw).forEach(dt => {
        const day = hw[dt] || {};
        Object.keys(day).forEach(k => {
          const rec = day[k];
          if (!rec || typeof rec !== 'object') return;
          byDate[dt] = byDate[dt] || { done: 0, total: 0 };
          byDate[dt].total += 1;
          if (rec.done) byDate[dt].done += 1;
        });
      });
    });
  });
  let doneSubjects = 0, recCount = 0;
  Object.keys(byDate).forEach(dt => { if (windowSet[dt]) { doneSubjects += byDate[dt].done; recCount += byDate[dt].total; } });
  const checkinRate = recCount ? Math.round(doneSubjects / recCount * 100) : 0;
  const trend = Object.keys(windowSet).sort().map(d => ({
    d,
    r: byDate[d] && byDate[d].total ? Math.round(byDate[d].done / byDate[d].total * 100) : 0
  }));

  const dueReviews = reviews.filter(r => !r.done && (r.dueAt || 0) <= now).length;
  const mastered = evidence.filter(e => e.passed === true).length;
  const corrected = mistakes.filter(m => m.status === 'corrected').length;

  // 孩子状态摘要：即使无打卡 / 导学活动，也能展示画像（昵称 / 年级）与农场资产
  const u0 = users[0];
  const d0 = (u0 && u0.data) || {};
  const cu0 = currentUser(d0);
  const f0 = cu0.farm || {};
  const child = u0 ? {
    nickname: cu0.nickname || d0.nickname || '',
    grade: cu0.grade || d0.grade || '',
    coins: f0.coins || 0,
    bears: Array.isArray(f0.bears) ? f0.bears.length : 0,
    plots: Array.isArray(f0.plots) ? f0.plots.length : 0,
    shields: f0.shields || 0
  } : null;

  return {
    child,
    kpi: { checkinRate, sessions: sessions.length, mistakes: mistakes.length, dueReviews, mastered, corrected },
    subjectDist: groupCount(sessions, 'subject'),
    errorDist: groupCount(mistakes, 'errorType'),
    trend
  };
}

async function farm(openid) {
  const [users, logs, settle, events] = await Promise.all([
    getAll(COLLS.user, ofilter(COLLS.user, openid)),
    getAll(COLLS.log, ofilter(COLLS.log, openid)),
    getAll(COLLS.settle, ofilter(COLLS.settle, openid)),
    getAll(COLLS.events, ofilter(COLLS.events, openid))
  ]);
  const userSum = [];
  users.forEach(u => {
    const data = (u && u.data) || {};
    const us = Array.isArray(data.users) ? data.users : [];
    const list = us.length ? us : [currentUser(data)];
    list.forEach(cu => {
      const farm = cu.farm || {};
      userSum.push({
        openid: u._openid || u.openid || '',
        nickname: cu.nickname || '',
        grade: cu.grade || '',
        coins: farm.coins || 0,
        bears: Array.isArray(farm.bears) ? farm.bears.length : 0,
        plots: Array.isArray(farm.plots) ? farm.plots.length : 0,
        shields: farm.shields || 0,
        suns: farm.suns || 0,
        pesticide: farm.pesticide || 0,
        harvest: Array.isArray(farm.harvestLog) ? farm.harvestLog.length : 0,
        owned: Array.isArray(farm.owned) ? farm.owned.length : 0,
        updatedAt: u.updatedAt || 0
      });
    });
  });
  return { users: userSum, logs: logs.slice(0, 60), settle: settle.slice(0, 60), events: events.slice(0, 60) };
}

async function tutor(openid) {
  const [sessions, mistakes, reviews, evidence] = await Promise.all([
    getAll(COLLS.sessions, ofilter(COLLS.sessions, openid)),
    getAll(COLLS.mistakes, ofilter(COLLS.mistakes, openid)),
    getAll(COLLS.reviews, ofilter(COLLS.reviews, openid)),
    getAll(COLLS.evidence, ofilter(COLLS.evidence, openid))
  ]);
  const clean = r => {
    const o = {};
    ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'errorType', 'errorDesc', 'suggestion', 'status', 'stage', 'dueAt', 'done', 'total', 'correct', 'rate', 'passed', 'createdAt', 'updatedAt'].forEach(k => { if (r[k] !== undefined) o[k] = r[k]; });
    return o;
  };
  return {
    sessions: sessions.slice(0, 100).map(clean),
    mistakes: mistakes.slice(0, 100).map(clean),
    reviews: reviews.slice(0, 100).map(clean),
    evidence: evidence.slice(0, 100).map(clean)
  };
}

async function profile(openid) {
  const [users, sessions, mistakes, reviews, evidence] = await Promise.all([
    getAll(COLLS.user, ofilter(COLLS.user, openid)),
    getAll(COLLS.sessions, ofilter(COLLS.sessions, openid)),
    getAll(COLLS.mistakes, ofilter(COLLS.mistakes, openid)),
    getAll(COLLS.reviews, ofilter(COLLS.reviews, openid)),
    getAll(COLLS.evidence, ofilter(COLLS.evidence, openid))
  ]);
  const now = Date.now();
  // 按 openid 聚合（tutor_* 无 childId 字段，真实口径只到 openid 级）
  const openids = new Set();
  users.forEach(u => openids.add(u._openid));
  sessions.forEach(s => s.openid && openids.add(s.openid));
  mistakes.forEach(m => m.openid && openids.add(m.openid));
  reviews.forEach(r => r.openid && openids.add(r.openid));
  evidence.forEach(e => e.openid && openids.add(e.openid));

  const accounts = [];
  for (const oid of openids) {
    const u = users.find(x => x._openid === oid) || {};
    const data = u.data || {};
    const cu = currentUser(data);              // 孩子切片：homework/schedule/learner/studyPlans/farm… 全在 data.users[i]
    const farm = cu.farm || {};
    const s = sessions.filter(x => x.openid === oid);
    const m = mistakes.filter(x => x.openid === oid);
    const rv = reviews.filter(x => x.openid === oid);
    const ev = evidence.filter(x => x.openid === oid);
    accounts.push({
      openid: oid,
      nickname: cu.nickname || data.nickname || '',
      grade: cu.grade || data.grade || '',
      learner: cu.learner || null,
      subjectProfiles: cu.subjectProfiles || null,
      // 多孩信息（若后续 learners 落地，可在此映射；当前数据为账号级）
      learners: Array.isArray(cu.learners) ? cu.learners.map(l => ({ grade: l.grade, book: l.book, name: l.name || l.code || '' })) : [],
      // —— 以下全部取自「当前孩子」切片 cu（此前误取 data.xxx，恒空，是网页不显示的直接原因）——
      // 今日打卡：homework[日期][typeKey]={done,minutes,note,doneAt}；profile.streak 连续全科打卡
      homework: cu.homework || {},
      streak: (cu.profile && cu.profile.streak) || 0,
      lastFullCheckinDate: (cu.profile && cu.profile.lastFullCheckinDate) || '',
      learn: cu.learn || { stars: 0 },
      // 任务：每日计划 plans[日期]；课表 schedule（行=节次，列=周几）；自定义打卡类型
      plans: cu.plans || {},
      schedule: cu.schedule || null,
      checkinTypes: Array.isArray(cu.checkinTypes) ? cu.checkinTypes : [],
      // 时间轴记录：老师评语 comments；家庭合种 coop（coop 是 _root 级，全家庭共享）
      comments: Array.isArray(cu.comments) ? cu.comments.slice(0, 60) : [],
      coop: data.coop || { plants: [] },
      // 成长计划（studyPlan 引擎写入 cu.studyPlans[学科]={stages:[{tasks}]}）：小程序「计划」页 AI 生成，非每日 plans
      studyPlans: cu.studyPlans || null,
      farm: { coins: farm.coins || 0, bears: Array.isArray(farm.bears) ? farm.bears.length : 0, plots: Array.isArray(farm.plots) ? farm.plots.length : 0, shields: farm.shields || 0, suns: farm.suns || 0, pesticide: farm.pesticide || 0, harvest: Array.isArray(farm.harvestLog) ? farm.harvestLog.length : 0, owned: Array.isArray(farm.owned) ? farm.owned.length : 0 },
      sessions: s.length,
      mistakes: m.length,
      dueReviews: rv.filter(x => !x.done && (x.dueAt || 0) <= now).length,
      mastered: ev.filter(x => x.passed === true).length,
      corrected: m.filter(x => x.status === 'corrected').length,
      subjectDist: groupCount(s, 'subject'),
      errorDist: groupCount(m, 'errorType'),
      mistakeBySubject: groupCount(m, 'subject'),
      masteredBySubject: groupCount(ev.filter(e => e.passed === true), 'subject')
    });
  }
  return { accounts };
}

/**
 * sync 模块 —— 工作台「云→本地镜像下拉」专用数据出口（T2）
 * 与 tutor/profile 不同：不过滤字段、不限 100 条，透传全部业务字段（含 messages/stage/done），
 * 保证本地 家庭学习库 md 可被完整重建。仍受 token 鉴权与 openid 作用域约束（per-user 或 admin）。
 * 出参：{ profile:{nickname,grade,learner,subjectProfiles}, sessions, mistakes, evidence, reviews, exams }
 *   exams = exam_resources 全字段（含 markdown/rawText/answers），F-B 起纳入下拉，供 papers md 重建。
 */
async function sync(openid) {
  const [users, sessions, mistakes, reviews, evidence, exams] = await Promise.all([
    getAll(COLLS.user, ofilter(COLLS.user, openid)),
    getAll(COLLS.sessions, ofilter(COLLS.sessions, openid)),
    getAll(COLLS.mistakes, ofilter(COLLS.mistakes, openid)),
    getAll(COLLS.reviews, ofilter(COLLS.reviews, openid)),
    getAll(COLLS.evidence, ofilter(COLLS.evidence, openid)),
    getAll(COLLS.exams, ofilter(COLLS.exams, openid))
  ]);
  const u = users[0];
  const data = (u && u.data) || {};
  const cu = currentUser(data);
  const pass = (rows, keep) => rows.map(r => {
    const o = {};
    keep.forEach(k => { if (r[k] !== undefined) o[k] = r[k]; });
    o.id = r.clientId || r._id;   // 与 tutorSync(pull) 保持一致：clientId 优先，旧数据兜底 _id
    return o;
  });
  return {
    profile: {
      nickname: cu.nickname || data.nickname || '',
      grade: cu.grade || data.grade || '',
      learner: cu.learner || null,
      subjectProfiles: cu.subjectProfiles || null,
      // T5：文档级 updatedAt（syncData 每次全量写 _root 时刷新）→ 作「云端版本」基线，
      // 供工作台上推时判断「小程序是否在我下拉之后又写过」，从而避免静默覆盖。
      updatedAt: (u && u.updatedAt) || 0
    },
    sessions: pass(sessions, ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'errorType', 'messages', 'createdAt', 'updatedAt', 'closed', 'closedAt']),
    mistakes: pass(mistakes, ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'errorType', 'errorDesc', 'suggestion', 'status', 'source', 'questionText', 'childAnswer', 'markSource', 'createdAt', 'updatedAt']),
    evidence: pass(evidence, ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'errorType', 'total', 'correct', 'rate', 'passed', 'createdAt', 'updatedAt']),
    reviews: pass(reviews, ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'errorType', 'stage', 'dueAt', 'done', 'mistakeClientId', 'createdAt', 'updatedAt']),
    // F-B：试卷库（资源库条目，非学情数据）。正文三段一并返回，供工作台下拉重建 papers md。
    exams: pass(exams, ['openid', 'clientId', 'resourceId', 'fileName', 'name', 'level', 'examType', 'retestType',
      'subject', 'subjectName', 'stage', 'grade', 'textbookEdition', 'correspondingUnit',
      'knowledgePoints', 'suggestedDuration', 'maxEvidenceLevel', 'passingCriteria',
      'officialUrl', 'answerUrl', 'publisher', 'lastVerified', 'staleLink', 'sourceFile', 'sessionFile',
      'markdown', 'rawText', 'answers', 'createdAt', 'updatedAt'])
  };
}

/* ---------- 主入口 ---------- */
exports.main = async (event) => {
  const token = (event && event.token) || '';
  const expect = process.env.WEB_DASHBOARD_TOKEN;

  // 身份解析：优先全局管理员口令（看全部账号）；否则按 per-user 绑定反查 openid
  let boundOpenid = null;   // null = 超级管理员，聚合全部 openid
  let isAdmin = false;
  if (expect && token && token === expect) {
    isAdmin = true;
  } else {
    const bind = await resolveBinding(token);
    if (!bind) return { ok: false, code: 'auth', msg: '访问口令无效或已撤销' };
    boundOpenid = bind.openid;
    try { await db().collection(COLLS.bindings).doc(bind._id).update({ lastUsed: Date.now() }); } catch (e) {}
  }

  const module = (event && event.module) || 'overview';
  try {
    let data;
    if (module === 'overview') data = await overview(event.query, boundOpenid);
    else if (module === 'farm') data = await farm(boundOpenid);
    else if (module === 'tutor') data = await tutor(boundOpenid);
    else if (module === 'profile') data = await profile(boundOpenid);
    else if (module === 'sync') data = await sync(boundOpenid);
    else return { ok: false, code: 'bad_module', msg: '未知 module: ' + module };
    return { ok: true, module, scope: isAdmin ? 'admin' : 'user', data };
  } catch (e) {
    return { ok: false, code: 'query_error', msg: '聚合失败：' + ((e && e.message) || e) };
  }
};

async function resolveBinding(token) {
  if (!token) return null;
  try {
    const res = await db().collection(COLLS.bindings).where({ token, revoked: false }).limit(1).get();
    if (res && res.data && res.data.length) return res.data[0];
  } catch (e) {}
  return null;
}

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
// 只 require orderKit（纯函数、零依赖、无写能力）。⚠️ 本函数**只读**，
// 绝不可引入 orderActions / orderCloudDeps —— 那里面有写路径。
const K = require('./orderKit');

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
  orders: 'tutor_orders',
  cards: 'tutor_cards',
  unitKps: 'tutor_unit_kps',
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

/* ---------- 单元必会通关率（P2 混合路线量化） ----------
 * 口径：total=单元必会点数；carded=有卡的必会点数（kpId 命中）；done=有已毕业卡(done,
 * Leitner 到顶 5)的必会点数；passRate=done/total；due=有今日到期卡的必会点数。
 * ⚠️ kpId 仅**单元内唯一**（p1/p2 会在不同单元重复）→ 必须按 (unitId, kpId) 聚合，
 *    不能只按 kpId 分组，否则跨单元串数据。
 * 合规：通关率只基于 Leitner 毕业（复习行为指标），不写 tutor_evidence、不称「掌握」。 */
const SUBJECT_NAMES_CN = {
  math: '数学', chinese: '语文', english: '英语', physics: '物理', chemistry: '化学',
  biology: '生物', history: '历史', geography: '地理', politics: '道德与法治'
};

/** 按 (unitId, kpId) 把卡片归组，返回单元粒度统计 */
function computeUnitKpStats(units, cards) {
  const now = Date.now();
  const byKp = {};
  cards.forEach(c => {
    if (!c.kpId || !c.unitId) return;
    const key = c.unitId + '|' + c.kpId;
    (byKp[key] = byKp[key] || []).push(c);
  });
  return units.map(u => {
    const unitId = u.clientId || u._id || '';
    const points = Array.isArray(u.points) ? u.points : [];
    let carded = 0, done = 0, due = 0;
    points.forEach(p => {
      const cs = byKp[unitId + '|' + p.id] || [];
      if (!cs.length) return;
      carded++;
      if (cs.some(c => c.done)) done++;
      if (cs.some(c => !c.done && (Number(c.dueAt) || 0) <= now)) due++;
    });
    const total = points.length;
    return {
      unitId: unitId,
      subject: u.subject || '',
      subjectName: SUBJECT_NAMES_CN[u.subject] || u.subject || '',
      title: u.title || '',
      total: total, carded: carded, due: due, done: done,
      passRate: total ? Math.round(done / total * 100) : 0,
      coveredRate: total ? Math.round(carded / total * 100) : 0,
      updatedAt: u.updatedAt || 0
    };
  });
}

/** 展开到必会点粒度（看板「单元必会」表按行展示 + 直达该点卡片的复习按钮） */
function computeUnitKpPoints(units, cards) {
  const now = Date.now();
  const byKp = {};
  cards.forEach(c => {
    if (!c.kpId || !c.unitId) return;
    const key = c.unitId + '|' + c.kpId;
    (byKp[key] = byKp[key] || []).push(c);
  });
  const out = [];
  units.forEach(u => {
    const unitId = u.clientId || u._id || '';
    const points = Array.isArray(u.points) ? u.points : [];
    points.forEach(p => {
      const cs = byKp[unitId + '|' + p.id] || [];
      const anyDone = cs.some(c => c.done);
      const anyDue = cs.some(c => !c.done && (Number(c.dueAt) || 0) <= now);
      const c0 = cs[0] || null;
      out.push({
        unitId: unitId,
        unitTitle: u.title || '',
        subject: u.subject || '',
        kpId: p.id,
        topic: p.topic || '',
        front: p.front || '',
        cardCount: cs.length,
        cardClientId: c0 ? (c0.clientId || '') : '',
        box: c0 ? (Number(c0.box) || 1) : 0,
        dueAt: c0 ? (Number(c0.dueAt) || 0) : 0,
        status: !cs.length ? 'uncovered' : (anyDone ? 'done' : (anyDue ? 'due' : 'learning'))
      });
    });
  });
  return out;
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
  const [sessions, mistakes, reviews, evidence, cards, users, unitKps] = await Promise.all([
    getAll(COLLS.sessions, ofilter(COLLS.sessions, openid)),
    getAll(COLLS.mistakes, ofilter(COLLS.mistakes, openid)),
    getAll(COLLS.reviews, ofilter(COLLS.reviews, openid)),
    getAll(COLLS.evidence, ofilter(COLLS.evidence, openid)),
    getAll(COLLS.cards, ofilter(COLLS.cards, openid)),
    getAll(COLLS.user, ofilter(COLLS.user, openid)),
    getAll(COLLS.unitKps, ofilter(COLLS.unitKps, openid))
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
  const dueCards = cards.filter(c => !c.done && (c.dueAt || 0) <= now).length;
  const mastered = evidence.filter(e => e.passed === true).length;
  const corrected = mistakes.filter(m => m.status === 'corrected').length;

  // 单元通关率（P2 混合路线量化）：进行中 = 有卡但未全部通关的单元；avgUnitPass = 各单元通关率均值
  const unitStats = computeUnitKpStats(unitKps, cards);
  const unitsInProgress = unitStats.filter(u => u.carded > 0 && u.done < u.total).length;
  const avgUnitPass = unitStats.length
    ? Math.round(unitStats.reduce((s, u) => s + u.passRate, 0) / unitStats.length)
    : 0;

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
    kpi: { checkinRate, sessions: sessions.length, mistakes: mistakes.length, dueReviews, dueCards, mastered, corrected, unitsInProgress, avgUnitPass },
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
  const [sessions, mistakes, reviews, evidence, cards, unitKps] = await Promise.all([
    getAll(COLLS.sessions, ofilter(COLLS.sessions, openid)),
    getAll(COLLS.mistakes, ofilter(COLLS.mistakes, openid)),
    getAll(COLLS.reviews, ofilter(COLLS.reviews, openid)),
    getAll(COLLS.evidence, ofilter(COLLS.evidence, openid)),
    getAll(COLLS.cards, ofilter(COLLS.cards, openid)),
    getAll(COLLS.unitKps, ofilter(COLLS.unitKps, openid))
  ]);
  // 会话白名单含 summary（会话级课程总结）；其余集合无该字段，多带无害
  const clean = r => {
    const o = {};
    ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'errorType', 'errorDesc', 'suggestion', 'status', 'stage', 'dueAt', 'done', 'total', 'correct', 'rate', 'passed', 'summary', 'createdAt', 'updatedAt'].forEach(k => { if (r[k] !== undefined) o[k] = r[k]; });
    return o;
  };
  // 闪卡白名单（提取式记忆实体；不回 messages、不回 openid 属主细节）
  // 混合路线（P1）增补 unitId / kpId / source 三字段，供看板标注「必会覆盖」来源
  const cardClean = r => {
    const o = {};
    ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'front', 'back', 'sourceSessionId', 'unitId', 'kpId', 'source', 'box', 'dueAt', 'done', 'lastResult', 'createdAt', 'updatedAt'].forEach(k => { if (r[k] !== undefined) o[k] = r[k]; });
    return o;
  };
  // 单元必会清单白名单（P2）：points 只留结构化字段，不带正文外内容
  const unitClean = r => {
    const o = {};
    ['openid', 'clientId', 'subject', 'subjectName', 'title', 'createdAt', 'updatedAt'].forEach(k => { if (r[k] !== undefined) o[k] = r[k]; });
    o.points = (Array.isArray(r.points) ? r.points : []).map(p => ({
      id: p.id, topic: p.topic, front: p.front, back: p.back, order: p.order
    }));
    return o;
  };
  return {
    sessions: sessions.slice(0, 100).map(clean),
    mistakes: mistakes.slice(0, 100).map(clean),
    reviews: reviews.slice(0, 100).map(clean),
    evidence: evidence.slice(0, 100).map(clean),
    cards: cards.slice(0, 100).map(cardClean),
    unitKps: unitKps.slice(0, 100).map(unitClean),
    unitKpStats: computeUnitKpStats(unitKps, cards),
    unitKpPoints: computeUnitKpPoints(unitKps, cards)
  };
}

async function profile(openid) {
  const [users, sessions, mistakes, reviews, evidence, cards, unitKps] = await Promise.all([
    getAll(COLLS.user, ofilter(COLLS.user, openid)),
    getAll(COLLS.sessions, ofilter(COLLS.sessions, openid)),
    getAll(COLLS.mistakes, ofilter(COLLS.mistakes, openid)),
    getAll(COLLS.reviews, ofilter(COLLS.reviews, openid)),
    getAll(COLLS.evidence, ofilter(COLLS.evidence, openid)),
    getAll(COLLS.cards, ofilter(COLLS.cards, openid)),
    getAll(COLLS.unitKps, ofilter(COLLS.unitKps, openid))
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
    const cd = cards.filter(x => x.openid === oid);
    const uk = unitKps.filter(x => x.openid === oid);
    // 单元通关率（P2）：该账号各单元 passRate 均值（无单元库时为 0）
    const ukStats = computeUnitKpStats(uk, cd);
    const unitPassRate = ukStats.length
      ? Math.round(ukStats.reduce((s, u) => s + u.passRate, 0) / ukStats.length)
      : 0;
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
      dueCards: cd.filter(x => !x.done && (x.dueAt || 0) <= now).length,
      unitPassRate: unitPassRate,
      unitCount: uk.length,
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
 * 出参：{ profile:{nickname,grade,learner,subjectProfiles,studyPlans,updatedAt}, sessions, mistakes, evidence, reviews, exams }
 *   studyPlans = 成长计划（供工作台/网页构造导学单 O1 锚点，见下）
 *   exams = exam_resources 全字段（含 markdown/rawText/answers），F-B 起纳入下拉，供 papers md 重建。
 */
async function sync(openid) {
  const [users, sessions, mistakes, reviews, evidence, exams, cards] = await Promise.all([
    getAll(COLLS.user, ofilter(COLLS.user, openid)),
    getAll(COLLS.sessions, ofilter(COLLS.sessions, openid)),
    getAll(COLLS.mistakes, ofilter(COLLS.mistakes, openid)),
    getAll(COLLS.reviews, ofilter(COLLS.reviews, openid)),
    getAll(COLLS.evidence, ofilter(COLLS.evidence, openid)),
    getAll(COLLS.exams, ofilter(COLLS.exams, openid)),
    getAll(COLLS.cards, ofilter(COLLS.cards, openid))
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
      // 成长计划（studyPlan 引擎写入 cu.studyPlans[typeKey] = {grade,term,textbook,subjectName,
      // startDate,createdAt,updatedAt,stages:[{name,weeks,goal,tasks:[{name,days,done,doneAt}]}]}）。
      // 与 profile 模块同源同字段，不改形状、不做归一化。
      //
      // 为什么必须下发（2026-09-28 补）：导学单的 O1 硬契约要求「单必锚计划任务」，
      // 锚点必须与小程序侧 studyPlan.getCurrentTask(key) 同源（同一份 stages[].tasks[] 下标）。
      // 工作台此前拿不到 studyPlans，就无法构造合法锚点 —— 一旦在端上「就近取材」
      // （用 flows / recommend 的知识点凑一个锚点），出的单会挂在一份并不存在的计划任务上，
      // 表现为「统计对不上、计划环关不掉」。宁可让端上明确知道"没有计划、不能出单"。
      studyPlans: cu.studyPlans || null,
      // T5：文档级 updatedAt（syncData 每次全量写 _root 时刷新）→ 作「云端版本」基线，
      // 供工作台上推时判断「小程序是否在我下拉之后又写过」，从而避免静默覆盖。
      updatedAt: (u && u.updatedAt) || 0
    },
    sessions: pass(sessions, ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'errorType', 'messages', 'createdAt', 'updatedAt', 'closed', 'closedAt']),
    mistakes: pass(mistakes, ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'errorType', 'errorDesc', 'suggestion', 'status', 'source', 'questionText', 'childAnswer', 'markSource', 'createdAt', 'updatedAt']),
    evidence: pass(evidence, ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'errorType', 'total', 'correct', 'rate', 'passed', 'createdAt', 'updatedAt']),
    reviews: pass(reviews, ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'errorType', 'stage', 'dueAt', 'done', 'mistakeClientId', 'createdAt', 'updatedAt']),
    // 闪卡：与 reviews 同口径透传（含 box/lastResult 进度 + 混合路线 unitId/kpId/source，供工作台下拉完整重建）
    cards: pass(cards, ['openid', 'clientId', 'subject', 'subjectName', 'topic', 'front', 'back', 'sourceSessionId', 'unitId', 'kpId', 'source', 'box', 'dueAt', 'done', 'lastResult', 'createdAt', 'updatedAt']),
    // F-B：试卷库（资源库条目，非学情数据）。正文三段一并返回，供工作台下拉重建 papers md。
    exams: pass(exams, ['openid', 'clientId', 'resourceId', 'fileName', 'name', 'level', 'examType', 'retestType',
      'subject', 'subjectName', 'stage', 'grade', 'textbookEdition', 'correspondingUnit',
      'knowledgePoints', 'suggestedDuration', 'maxEvidenceLevel', 'passingCriteria',
      'officialUrl', 'answerUrl', 'publisher', 'lastVerified', 'staleLink', 'sourceFile', 'sessionFile',
      'markdown', 'rawText', 'answers', 'createdAt', 'updatedAt'])
  };
}

/**
 * exams 模块 —— 家长看板「试卷库」只读目录（F-B 展示端）
 * 与 sync 不同：只返回轻量目录字段（不含 markdown/rawText/answers 正文三段，避免大体积拖慢看板），
 * 供家长浏览「孩子有哪些试卷 / 卷子类型 / 对应单元 / 是否有链接」；正文查看仍走小程序 / 工作台。
 * 出参：{ exams:[{ id, name, subjectName, examType, retestType, grade, stage, correspondingUnit, suggestedDuration, maxEvidenceLevel, officialUrl, answerUrl, staleLink, updatedAt, ... }] }
 */
async function exams(openid) {
  const rows = await getAll(COLLS.exams, ofilter(COLLS.exams, openid));
  const KEEP = ['openid', 'clientId', 'resourceId', 'fileName', 'name', 'level', 'examType', 'retestType',
    'subject', 'subjectName', 'stage', 'grade', 'textbookEdition', 'correspondingUnit',
    'knowledgePoints', 'suggestedDuration', 'maxEvidenceLevel', 'passingCriteria',
    'officialUrl', 'answerUrl', 'publisher', 'lastVerified', 'staleLink', 'createdAt', 'updatedAt'];
  const clean = r => {
    const o = {};
    KEEP.forEach(k => { if (r[k] !== undefined) o[k] = r[k]; });
    o.id = r.clientId || r._id;   // 与 sync 保持一致：clientId 优先，旧数据兜底 _id
    return o;
  };
  const list = rows.map(clean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { exams: list };
}

/**
 * orders 模块 —— 家长看板「导学单」**读**视图（决策 3：网页看板打开 orders 权限，该权限**含写**）
 *
 * ⚠️ 本模块**只负责读**。网页看板的写动作（出单 / 交回执）走 `webAdminWrite` 的 `orders` 通道，
 * 不在这里 —— 本云函数保持纯读，不引入任何写路径（写边界见 `docs/orderProtocol.md` §6.2）。
 *
 * 与 exams 模块同理：只读、不写、不判定。**只回轻量字段**，不回 copyText / resumeText /
 * recycleText / protocolBlock 四段大文本（那是执行端复制用的，端上可按需重新生成），
 * 否则一次下拉会把上百张单的全文拖回来。
 *
 * 入参 query：{ planId?, subject?, status?, limit? }
 * 出参：{
 *   orders:[{ orderNo, clientId, openid, status, subject, subjectName, title, kind, minutes,
 *             plan:{…锚点}, issuedAt, issuedBy, submittedAt, submittedBy, closedAt,
 *             voidedAt, voidReason, reissueOf,
 *             receipt:{…}, evaluation:{…}, cycle:{…}, events:[…], updatedAt }],
 *   counts:{ issued, submitted, closed, cancelled, voided, total },
 *   plans:[{ openid, planId, key, subjectName, stageName, taskName, si, ti,
 *            issued, submitted, closed, cancelled, voided, total,
 *            firstIssuedAt, lastIssuedAt, lastSubmittedAt, lastAt }]
 * }
 *
 * plans 是「一份计划 → N 张单」的聚合（设计文档 §0.1 基数 1:N 的可视化落地）。
 * **实现已收进 canonical `orderKit.planOrderAggregate`**（2026-09-29 T23）——
 * 三端（小程序 / 网页 / 工作台）调同一个函数，一致性由 sha256 哈希锁保证。
 * 此前三端各写一套，实测在「无锚点单 / 分组键是否含 openid / lastAt 兜底」三处分叉。
 *
 * ⚠️ openid 为什么必须回传（2026-09-28 补）：
 *   家长看板是用**管理员口令**访问的，此时 ofilter 返回 {} → 一次拉回**所有孩子**的单。
 *   若不回传 openid，网页端就只能把「哥哥的数学计划」和「妹妹的数学计划」渲染成两行同名行，
 *   且无法按孩子 chip 过滤 —— 页面看着有数据，实际是错的。
 *   回传 openid 不构成越权：同一口令下 profile 模块本来就回传裸 openid（见 accounts[].openid）。
 *   前端只回显 maskOpenid(openid)，不展示完整值。
 */
async function orders(openid, query) {
  const q = query || {};
  const rows = await getAll(COLLS.orders, ofilter(COLLS.orders, openid));

  // 大文本剔除（端上要用时按 orderKit 的 orderTextFor 重新生成，不依赖云端存全文）
  const HEAVY = ['copyText', 'resumeText', 'recycleText', 'protocolBlock', 'promptText'];
  const clean = (r) => {
    const o = {};
    for (const k of Object.keys(r)) {
      if (k === '_id' || HEAVY.indexOf(k) >= 0) continue;
      o[k] = r[k];
    }
    o.id = r.clientId || r._id;
    // 文档属主与业务 openid 归一到一个字段：tutor_* 用明文 openid，兜底取 _openid
    o.openid = r.openid || r._openid || '';
    return o;
  };

  let list = rows.map(clean);

  const planId = String(q.planId || '');
  const subject = String(q.subject || '');
  const status = String(q.status || '');
  const oid = String(q.openid || '');
  if (oid) list = list.filter((o) => o.openid === oid);
  if (planId) list = list.filter((o) => o.plan && o.plan.planId === planId);
  if (subject) list = list.filter((o) => o.subject === subject);
  if (status) list = list.filter((o) => o.status === status);

  list.sort((a, b) => (b.issuedAt || b.createdAt || 0) - (a.issuedAt || a.createdAt || 0));
  const limit = Math.min(Number(q.limit) || 200, 500);
  if (list.length > limit) list = list.slice(0, limit);

  // 计划维度聚合**复用 canonical orderKit**（T23）：三端（小程序 / 网页 / 工作台）
  // 必须调**同一个函数**。各端自己算一遍，必然算出三种口径 —— 本文件里原来的内联
  // 实现就与另两端实测分叉过三处（无锚点单被丢弃 / 分组键缺 openid / lastAt 缺
  // createdAt 兜底），详见 order-kit/orderKit.js §八 的注释。
  //
  // 注意 `K.planOrderAggregate(list)` 刻意**不开** `withOrders`：
  // 云端响应不带下钻明细，200 张单全挂回去会把响应撑大一个数量级。
  // 端上要下钻时按 planId 从扁平的 `orders` 里自己 filter。
  return {
    orders: list,
    counts: K.countOrderStatuses(list),
    plans: K.planOrderAggregate(list)
  };
}

/* ---------- 主入口 ---------- */exports.main = async (event) => {
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
    else if (module === 'exams') data = await exams(boundOpenid);
    else if (module === 'orders') data = await orders(boundOpenid, event.query);
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

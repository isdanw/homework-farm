/**
 * 云函数 tutorSync —— 导学数据云↔本地同步（闭环 S1）
 *
 * 背景：tutor_sessions / tutor_mistakes / tutor_evidence / tutor_reviews 四个集合
 * 此前「只写不读」，换设备后云端有数据、页面为空。本云函数提供两条读路径：
 *
 * 入参 action:
 *   'pull'  按 openid 拉回四集合最近数据（返回给前端 merge 进本地 tutorStore）
 *   'push'  把本地有而云端缺的条目补写上云（离线归档 / 归档失败回补），按 clientId 查重
 *
 * 【pull】出参：
 *   { ok:true, sessions:[], mistakes:[], evidence:[], reviews:[] }
 *   每条含 id（= 云端 clientId，无 clientId 的旧数据用 _id 兜底）+ cloudId + 原字段
 *   限量：sessions 100 / mistakes 200 / evidence 200 / reviews 100（createdAt 倒序）
 *
 * 【push】入参：
 *   { sessions:[], mistakes:[], evidence:[], reviews:[] }  每条必须带 clientId（本地 uid）
 *   行为：clientId 已存在 → 跳过（reviews 额外同步 stage/dueAt/done 进度）；
 *         不存在 → 补写。出参 { ok:true, added, skipped, updated }
 *
 * 红线：
 *   · 全部按 openid 隔离；openid 为空直接拒绝（不产生无主数据）
 *   · 纯数据搬运，不调用 AI、不做任何「掌握」判定
 */
const tcb = require('@cloudbase/node-sdk');

/* pull 拉取上限（家庭自用量级，防误拉全量） */
const PULL_LIMITS = {
  tutor_sessions: 100,
  tutor_mistakes: 200,
  tutor_evidence: 200,
  tutor_reviews: 100
};

/* push 各集合单次上限 */
const PUSH_LIMITS = {
  sessions: 100,
  mistakes: 200,
  evidence: 200,
  reviews: 100
};

function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

/* ---------------- pull ---------------- */
async function pull(app, openid) {
  const db = app.database();
  const out = { sessions: [], mistakes: [], evidence: [], reviews: [] };
  const map = {
    sessions: 'tutor_sessions',
    mistakes: 'tutor_mistakes',
    evidence: 'tutor_evidence',
    reviews: 'tutor_reviews'
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
    out[key] = docs.map(d => {
      const item = Object.assign({}, d);
      item.cloudId = d._id;
      item.id = d.clientId || d._id;   // 新数据用 clientId（= 本地 uid），旧数据兜底 _id
      delete item._id;
      return item;
    });
  }
  return { ok: true, sessions: out.sessions, mistakes: out.mistakes, evidence: out.evidence, reviews: out.reviews };
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
    reviews: 'tutor_reviews'
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

  const action = event.action === 'push' ? 'push' : 'pull';

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
        reviews: Array.isArray(event.reviews) ? event.reviews : []
      };
      return await push(app, openid, input);
    }
    return await pull(app, openid);
  } catch (e) {
    return { ok: false, code: 'sync_error', msg: '同步失败：' + ((e && e.message) || e) };
  }
};

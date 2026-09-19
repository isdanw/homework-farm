/**
 * 云函数 syncData —— 作业数据 & 农场数据云端同步（数据互通的服务端部分）
 *
 * action = 'upload'   本地 → 云端（前端每次 store.save() 后防抖 2 秒调用）
 * action = 'download' 云端 → 本地（换手机 / 重装小程序时恢复）
 *
 * 说明：数据按 openid 隔离，一人一条，互相看不到对方的数据。
 *
 * R4 自愈（2026-09-10 修复）：集合可能因 initDB 未跑 / 被误删而不存在。
 *   旧逻辑 where().get() 直接抛错 → 云函数异常 → 前端 cloudUpload 静默吞掉 →
 *   数据从不上云。现改为：集合缺失时先 createCollection 再写，保证任意一次
 *   上传都能落库，不再静默丢数据。
 *
 * 【F10 多设备并发·2026-09-18】上传从「无条件整份覆盖」改为**乐观锁（CAS）**。
 *   同一微信号在两台设备（手机 + 平板）交替使用时，旧逻辑是静默 LWW：
 *   后写的那台把先写的那台的改动整片抹掉，双方都毫无察觉。
 *   现在：
 *     · 客户端 upload 带上 `base` = 它「最后一次见到的云端 updatedAt」（0/缺失 = 无基线）；
 *     · 服务端比对云端当前 updatedAt 与 base，不一致 → 返回 `code:'conflict'` 并**不写库**；
 *       一致 → 用 `where({_id, updatedAt: base}).update()` 做 CAS，把「读-写」窗口也堵住，
 *       期间被人抢先写过（受影响 0 行）同样报 conflict。
 *     · 无基线（base=0）时退化为旧行为，但**每次都回传 cloudUpdatedAt**，客户端存下后
 *       从下一刻起自动进入 CAS 模式 —— 老版本客户端也能平滑升级，不会一上线就全员冲突。
 *   ⚠️ 本函数只负责「检测并拒绝覆盖」，不做业务字段合并：
 *      合并策略在客户端 store.js 的 reconcileWithCloud()，那里的取舍必须逐字段说清理由。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const USER = 'hw_farm_user';
const LOG = 'hw_checkin_log';
const EVENTS = 'hw_farm_events';

/** 取「当前孩子」切片：_root 里孩子级字段（homework/farm/...）都在 users[currentUserId] 上 */
function currentUser(root) {
  const us = (root && Array.isArray(root.users)) ? root.users : [];
  return us.find(x => x && x.id === (root && root.currentUserId)) || us[0] || {};
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  // 仅返回调用者的 openid（客户端用来做「微信已绑定」展示 + 本地多账号隔离）
  if (action === 'whoami') {
    return { ok: true, openid: OPENID };
  }

  // 埋点事件（analytics.js 尽力同步，失败静默）：单条追加，字段白名单 + 截断
  if (action === 'logEvent') {
    const rec = event.payload || {};
    const row = {
      _openid: OPENID,
      event: String(rec.event || '').slice(0, 40),
      uid: String(rec.uid || '').slice(0, 64),
      childId: String(rec.childId || '').slice(0, 64),
      subject: String(rec.subject || '').slice(0, 30),
      subjectName: String(rec.subjectName || '').slice(0, 30),
      action: String(rec.action || '').slice(0, 30),
      date: String(rec.date || '').slice(0, 10),
      ts: Number(rec.ts) || Date.now(),
      createdAt: Date.now()
    };
    try {
      await db.collection(EVENTS).add({ data: row });
    } catch (e) {
      // 集合不存在时懒创建一次（与 ocr_debug 同策略）
      await db.createCollection(EVENTS);
      await db.collection(EVENTS).add({ data: row });
    }
    return { ok: true };
  }

  if (action === 'download') {
    // R4 自愈：集合不存在时视为「云端无数据」，而不是抛错让前端把整次下载判成失败
    let res;
    try {
      res = await db.collection(USER).where({ _openid: OPENID }).limit(1).get();
    } catch (e) {
      if (isCollMissing(e)) return { ok: true, data: null, cloudUpdatedAt: 0 };
      throw e;
    }
    const doc = res.data[0];
    return {
      ok: true,
      data: doc ? doc.data : null,
      // F10：把云端版本一并交给客户端存为下次 upload 的 base（CAS 基线从此建立）
      cloudUpdatedAt: doc ? (Number(doc.updatedAt) || 0) : 0
    };
  }

  if (action === 'upload') {
    const payload = event.payload;
    // R3：入参校验——必须是普通对象、拒绝原型污染键、体积上限 512KB
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, msg: 'payload 必须是对象' };
    }
    const keys = Object.keys(payload);
    if (keys.some(k => k === '__proto__' || k === 'constructor' || k === 'prototype')) {
      return { ok: false, msg: 'payload 含非法字段' };
    }
    let size = 0;
    try { size = JSON.stringify(payload).length; }
    catch (e) { return { ok: false, msg: 'payload 无法序列化' }; }
    if (size > 512 * 1024) return { ok: false, msg: 'payload 过大（上限 512KB），请检查本地数据' };

    // 纵深防御（S1 双保险）：服务端入库前再剥离一次 API Key，Key 只允许留在设备本地
    if (payload.aiVision && typeof payload.aiVision === 'object') delete payload.aiVision.key;

    const now = Date.now();

    // F10：乐观锁基线。0 / 缺失 = 客户端还没有云端版本认知（首装、老版本客户端）。
    const hasBase = typeof event.base === 'number' && event.base > 0;
    const base = hasBase ? event.base : 0;

    // 1) 整份数据镜像（一人一条，存在就更新）
    // R4 自愈：集合不存在（initDB 未跑 / 被删）时先建集合再写，避免静默丢数据
    let exist;
    try {
      exist = await db.collection(USER).where({ _openid: OPENID }).limit(1).get();
    } catch (e) {
      if (isCollMissing(e)) {
        await ensureColl(USER);
        exist = await db.collection(USER).where({ _openid: OPENID }).limit(1).get();
      } else throw e;
    }
    if (!exist.data.length) {
      // 首次上传：云端没有版本可冲突，直接建档
      await db.collection(USER).add({ data: { _openid: OPENID, data: payload, updatedAt: now, createdAt: now } });
    } else {
      const cur = exist.data[0];
      const prev = Number(cur.updatedAt) || 0;

      // 1a) 客户端基线已落后于云端 → 说明有本机之外的写入，**不写库**，把冲突摆到台面上
      if (hasBase && prev !== base) return conflictResult(cur, prev);

      // 1b) CAS 写：条件带上 updatedAt，把「上面这次 get 与这次 update 之间」的窗口一起堵住
      const cond = prev > 0
        ? { _id: cur._id, updatedAt: prev }
        : { _id: cur._id, updatedAt: _.exists(false) };   // 历史脏文档没有 updatedAt（它不会自己长出来）
      const res2 = await db.collection(USER).where(cond).update({ data: { data: payload, updatedAt: now } });
      if (affected(res2) === 0) {
        // 写不中。**必须分清两种成因**，否则会踩一个比 LWW 更糟的坑：
        let latest = cur, latestVer = prev;
        try {
          const re = await db.collection(USER).doc(cur._id).get();
          if (re && re.data) { latest = re.data; latestVer = Number(re.data.updatedAt) || 0; }
        } catch (e) {}
        // ① 版本确实变了 → 真·多设备冲突：不写库，摆到台面上
        if (latestVer !== prev) return conflictResult(latest, latestVer);
        // ② 版本没变却写不中 → 条件写的返回结构/语义与预期不符（不同 SDK 版本会有差异）。
        //    此时若一路报 conflict，客户端会「采纳基线 → 重推 → 再 conflict」无限来回，
        //    上传彻底停摆 —— 比修复前的 LWW 糟得多。故退化为一次直写（＝修复前行为），并留日志。
        console.warn('[syncData] 条件写未生效且版本未变，退化为直写；请检查 SDK 的条件写返回结构');
        await db.collection(USER).doc(cur._id).update({ data: { data: payload, updatedAt: now } });
      }
    }

    // 2) 清理历史孤儿文档：修复前 .add() 未写 _openid，导致 webAdminQuery 按 _openid 过滤时
    //    永远匹配不到、且每次上传都新建一条空文档。此处统一清掉无 _openid 的脏数据。
    try {
      await db.collection(USER).where({ _openid: _.exists(false) }).remove();
    } catch (e) { /* 集合空或已无孤儿时忽略 */ }

    // 3) 单独落一条「今日打卡明细」，方便后台统计
    //    ⚠️ payload 是整份 _root，homework/farm 挂在 payload.users[i]（当前孩子）上，
    //    顶层 payload.homework 恒为 undefined —— 早期误读顶层导致 hw_checkin_log 永远不写。
    const today = new Date();
    const dateKey = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const cu = currentUser(payload);
    const hw = (cu.homework || {})[dateKey];
    if (hw) {
      const row = {
        _openid: OPENID,
        date: dateKey,
        chinese: !!(hw.chinese && hw.chinese.done),
        math: !!(hw.math && hw.math.done),
        english: !!(hw.english && hw.english.done),
        coins: cu.farm ? cu.farm.coins : 0,
        bears: cu.farm ? (cu.farm.bears || []).length : 0,
        updatedAt: now
      };
      // R4 自愈：hw_checkin_log 也可能不存在，缺失时建集合后写入
      let old;
      try {
        old = await db.collection(LOG).where({ _openid: OPENID, date: dateKey }).limit(1).get();
      } catch (e) {
        if (isCollMissing(e)) { await ensureColl(LOG); old = { data: [] }; }
        else throw e;
      }
      if (old.data.length) await db.collection(LOG).doc(old.data[0]._id).update({ data: row });
      else await db.collection(LOG).add({ data: row });
      // 清理历史孤儿日志（修复前未写 _openid 的脏数据，避免 overview 打卡率统计失真）
      try {
        await db.collection(LOG).where({ _openid: _.exists(false) }).remove();
      } catch (e) {}
    }
    // F10：回传本次落库后的云端版本，客户端存为下一轮的 CAS 基线
    return { ok: true, cloudUpdatedAt: now };
  }

  return { ok: false, msg: 'unknown action' };
};

/** 取 update / remove 的影响行数（wx-server-sdk 与 node-sdk 返回结构不同，双重兜底） */
function affected(res) {
  if (!res) return 0;
  if (res.stats && typeof res.stats.updated === 'number') return res.stats.updated;
  if (res.stats && typeof res.stats.removed === 'number') return res.stats.removed;
  if (typeof res.updated === 'number') return res.updated;
  return 0;
}

/**
 * F10：冲突响应。
 * 把云端最新版本一起带回去，让客户端能「调和后重推」而不是盲目重试（盲目重试＝死循环）。
 * 体积保护：整份 _root 上限 512KB，云函数返回体同样有上限，
 * 超过 400KB 时只回基线不带数据（客户端随后退化为「只更新基线 + 重推」）。
 */
function conflictResult(doc, cloudUpdatedAt) {
  let body = (doc && doc.data) || null;
  let truncated = false;
  try {
    if (body && JSON.stringify(body).length > 400 * 1024) { body = null; truncated = true; }
  } catch (e) { body = null; truncated = true; }
  return {
    ok: false,
    code: 'conflict',
    msg: '云端数据已被其它设备更新，本次上传未写入（已回传云端最新版本供调和）',
    cloudUpdatedAt: Number(cloudUpdatedAt) || 0,
    data: body,
    truncated
  };
}

/** 判断数据库错误是否因「集合不存在」导致（不同 SDK 版本错误码/文案不一致，双重兜底） */
function isCollMissing(e) {
  if (!e) return false;
  if (e.errCode === -502005) return true;            // 集合不存在
  if (e.errCode === -501001) return false;           // 已存在，不是缺失
  const m = (e.message || e.errMsg || '') + '';
  return /not exist|CollectionNotExist|ResourceNotFound|Db or Table not exist/i.test(m);
}

/** 确保集合存在（已存在则忽略 -501001） */
async function ensureColl(name) {
  try { await db.createCollection(name); }
  catch (e) { if (e && e.errCode !== -501001) throw e; }
}

function p(n) { return n < 10 ? '0' + n : '' + n; }

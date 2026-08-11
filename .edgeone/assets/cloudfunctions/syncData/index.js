/**
 * 云函数 syncData —— 作业数据 & 农场数据云端同步（数据互通的服务端部分）
 *
 * action = 'upload'   本地 → 云端（前端每次 store.save() 后防抖 2 秒调用）
 * action = 'download' 云端 → 本地（换手机 / 重装小程序时恢复）
 *
 * 说明：数据按 openid 隔离，一人一条，互相看不到对方的数据。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const USER = 'hw_farm_user';
const LOG = 'hw_checkin_log';

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  if (action === 'download') {
    const res = await db.collection(USER).where({ _openid: OPENID }).limit(1).get();
    return { ok: true, data: res.data[0] ? res.data[0].data : null };
  }

  if (action === 'upload') {
    const payload = event.payload || {};
    const now = Date.now();

    // 1) 整份数据镜像（一人一条，存在就更新）
    const exist = await db.collection(USER).where({ _openid: OPENID }).limit(1).get();
    if (exist.data.length) {
      await db.collection(USER).doc(exist.data[0]._id).update({
        data: { data: payload, updatedAt: now }
      });
    } else {
      await db.collection(USER).add({ data: { data: payload, updatedAt: now, createdAt: now } });
    }

    // 2) 单独落一条「今日打卡明细」，方便后台统计
    const today = new Date();
    const dateKey = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const hw = (payload.homework || {})[dateKey];
    if (hw) {
      const row = {
        date: dateKey,
        chinese: !!(hw.chinese && hw.chinese.done),
        math: !!(hw.math && hw.math.done),
        english: !!(hw.english && hw.english.done),
        coins: payload.farm ? payload.farm.coins : 0,
        bears: payload.farm ? (payload.farm.bears || []).length : 0,
        updatedAt: now
      };
      const old = await db.collection(LOG).where({ _openid: OPENID, date: dateKey }).limit(1).get();
      if (old.data.length) await db.collection(LOG).doc(old.data[0]._id).update({ data: row });
      else await db.collection(LOG).add({ data: row });
    }
    return { ok: true };
  }

  return { ok: false, msg: 'unknown action' };
};

function p(n) { return n < 10 ? '0' + n : '' + n; }

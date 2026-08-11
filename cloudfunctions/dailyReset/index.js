/**
 * 云函数 dailyReset —— 每日凌晨定时任务（服务端兜底）
 *
 * 触发时间见同目录 config.json（默认每天 00:05 执行，北京时间需按 UTC+8 换算，
 * 微信云函数定时器使用的是「北京时间」，可直接写 0 5 0 * * * *）。
 *
 * 做三件事：
 *   1) 遍历所有用户，按前一天的作业完成情况计算惩罚等级（服务端权威结算）
 *   2) 把结算结果写入 hw_farm_settle，并同步更新 hw_farm_user 里的农场数据
 *      （小狗熊数量 / 被偷金币 / 枯萎植物 / 收获锁定）
 *   3) 清空当日作业状态：为新的一天建立空白记录
 *
 * 注意：小程序端 app.js 每次启动也会做同样的结算（engine.dailyRollover），
 *      两边都有「settledDates 去重」，不会重复惩罚。云端只是兜底，
 *      保证孩子长时间不打开小程序时，账面数据依然正确。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const USER = 'hw_farm_user';
const SETTLE = 'hw_farm_settle';

/* —— 与小程序端 config.js 保持一致的惩罚参数（改这里要同步改前端）—— */
const PUNISH = {
  STEAL_COIN_RATIO: 0.5,
  LEVELS: {
    1: { bears: 1, mode: 'damageToday', healthLoss: 1 },
    2: { bears: 2, mode: 'destroyHalfMature', healthLoss: 2 },
    3: { bears: 3, mode: 'witherAllMature', healthLoss: 3, lockHarvest: true }
  }
};
const MAX_STAGE = 3;
const SUBS = ['chinese', 'math', 'english'];

exports.main = async () => {
  const yest = dateKey(-1);
  const today = dateKey(0);
  const summary = { date: yest, users: 0, punished: 0 };

  // 分页遍历所有用户（云函数单次最多取 100 条）
  const countRes = await db.collection(USER).count();
  const total = countRes.total;
  const pages = Math.ceil(total / 100);

  for (let i = 0; i < pages; i++) {
    const res = await db.collection(USER).skip(i * 100).limit(100).get();
    for (const row of res.data) {
      const d = row.data;
      if (!d || !d.farm) continue;
      summary.users++;

      d.settledDates = d.settledDates || [];
      const already = d.settledDates.indexOf(yest) >= 0;
      const hw = (d.homework || {})[yest];
      const missing = hw ? SUBS.filter(k => !(hw[k] && hw[k].done)) : SUBS.slice();

      let report = null;
      if (!already && missing.length > 0) {
        report = settle(d, yest, missing);
        summary.punished++;
        await db.collection(SETTLE).add({
          data: { _openid: row._openid, date: yest, level: missing.length, missing, bears: report.bears, stolen: report.stolen, withered: report.withered, createdAt: Date.now() }
        });
      }
      if (!already) d.settledDates.push(yest);

      // 清空当日作业状态：为今天建立空白记录
      if (!d.homework) d.homework = {};
      if (!d.homework[today]) {
        d.homework[today] = {};
        SUBS.forEach(k => { d.homework[today][k] = { done: false, minutes: 0, note: '', doneAt: 0 }; });
      }
      d.lastActiveDate = today;

      await db.collection(USER).doc(row._id).update({ data: { data: d, updatedAt: Date.now() } });
    }
  }
  return summary;
};

/** 服务端惩罚结算（逻辑与前端 farmEngine.nightSettle 一致） */
function settle(d, day, missing) {
  const conf = PUNISH.LEVELS[Math.min(missing.length, 3)];
  const report = { bears: 0, damaged: 0, withered: 0, stolen: 0 };
  const farm = d.farm;
  farm.bears = farm.bears || [];
  farm.plots = farm.plots || [];

  // 护盾优先抵挡
  if (farm.shields > 0) {
    farm.shields -= 1;
    pushLog(farm, day, 'shield', '护盾抵挡了小狗熊的攻击（云端结算）');
    return report;
  }

  for (let i = 0; i < conf.bears; i++) {
    farm.bears.push({ id: 'bear_' + day + '_' + i, x: 8 + Math.round(Math.random() * 62), y: 10 + Math.round(Math.random() * 55), target: -1, date: day });
  }
  report.bears = conf.bears;

  if (conf.mode === 'damageToday') {
    farm.plots.forEach(p => {
      if (p && !p.withered && p.plantedDate === day) {
        p.health = Math.max(0, p.health - conf.healthLoss); p.bitten = true; report.damaged++;
        if (p.health <= 0) { p.withered = true; report.withered++; }
      }
    });
  } else if (conf.mode === 'destroyHalfMature') {
    const mature = [];
    farm.plots.forEach((p, i) => { if (p && !p.withered && p.stage >= MAX_STAGE) mature.push(i); });
    for (let i = 0; i < Math.ceil(mature.length / 2); i++) {
      const p = farm.plots[mature[i]];
      p.withered = true; p.health = 0; p.bitten = true; report.withered++;
    }
    farm.plots.forEach(p => {
      if (p && !p.withered) {
        p.health = Math.max(0, p.health - 1); p.bitten = true; report.damaged++;
        if (p.health <= 0) { p.withered = true; report.withered++; }
      }
    });
  } else {
    farm.plots.forEach(p => {
      if (!p) return;
      p.bitten = true;
      if (p.stage >= MAX_STAGE) { p.withered = true; p.health = 0; report.withered++; }
      else {
        p.health = Math.max(0, p.health - conf.healthLoss); report.damaged++;
        if (p.health <= 0) { p.withered = true; report.withered++; }
      }
    });
    if (conf.lockHarvest) farm.lockHarvestDate = day;
  }

  const stolen = Math.floor((farm.coins || 0) * PUNISH.STEAL_COIN_RATIO);
  if (stolen > 0) { farm.coins -= stolen; report.stolen = stolen; }

  pushLog(farm, day, 'punish', `云端结算：${missing.length} 科未完成 → 小狗熊 ×${conf.bears}，枯萎 ${report.withered} 株，被偷 ${stolen} 金币`);
  return report;
}

function pushLog(farm, date, type, text) {
  farm.logs = farm.logs || [];
  farm.logs.unshift({ date, type, text });
  if (farm.logs.length > 60) farm.logs.length = 60;
}

function dateKey(offset) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);   // 云函数为 UTC，换算成北京时间
  d.setUTCDate(d.getUTCDate() + offset);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

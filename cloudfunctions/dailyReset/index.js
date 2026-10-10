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
 *
 * 【F11 竞态修复·2026-09-18】结算写回从「无条件整份覆盖」改为 **CAS（乐观锁）**。
 *   旧逻辑：`doc(id).get()` 读整份 → 内存里改 → 整份写回，两步之间若前端 upload 成功落库，
 *   那次用户操作会被旧快照回写抹掉（00:05 使用概率低，但分页遍历全部用户时窗口真实存在）。
 *   现在：写回用 `where({_id, updatedAt: <刚读到的版本>}).update()`，受影响 0 行说明版本已变 →
 *   重新读取最新文档、在新快照上重算、再写，最多 CAS_MAX_ATTEMPT 轮。
 *   ⚠️ 只有写成功才计入 summary 与落 hw_farm_settle 记录 —— 否则重试会导致重复计数 / 重复结算记录。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const USER = 'hw_farm_user';
const SETTLE = 'hw_farm_settle';
const OCR_DEBUG = 'ocr_debug';
const OCR_RETAIN_DAYS = 7;   // S4：OCR 观测数据（含课表内容）只保留 7 天
const CAS_MAX_ATTEMPT = 3;   // F11：单个用户因并发冲突最多重读重算的轮数

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

/** 取「当前孩子」切片：_root 里孩子级字段（homework/farm/settledDates/lastActiveDate）都在 users[currentUserId] 上 */
function currentUser(root) {
  const us = (root && Array.isArray(root.users)) ? root.users : [];
  return us.find(x => x && x.id === (root && root.currentUserId)) || us[0] || {};
}

exports.main = async () => {
  const yest = dateKey(-1);
  const today = dateKey(0);
  const summary = { date: yest, users: 0, punished: 0, skipped: 0, retried: 0, failed: 0, ocrDebugCleaned: 0 };

  // R5：先「只读」分页收集全部 _id（读阶段无写入，skip 不会漂移），再逐条取回处理，
  // 避免旧的「边遍历边写」在极端并发下漏处理/重复处理。
  const countRes = await db.collection(USER).count();
  const total = countRes.total;
  const pages = Math.ceil(total / 100);
  const ids = [];
  for (let i = 0; i < pages; i++) {
    const res = await db.collection(USER).field({ _id: true }).skip(i * 100).limit(100).get();
    res.data.forEach(r => ids.push(r._id));
  }

  for (const id of ids) {
    // F11：最多 CAS_MAX_ATTEMPT 轮。每轮都「重新读最新文档 → 在最新快照上重算 → CAS 写回」，
    //      绝不拿上一轮的旧快照去写（那正是要修的 bug）。
    let status = 'failed';   // ok | skip | failed
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPT; attempt++) {
      const row = await db.collection(USER).doc(id).get();
      const doc = row.data;
      const root = doc && doc.data;   // 载荷就是整份 _root（含 users[]）——孩子级字段在切片里，顶层没有
      const cu = currentUser(root);
      if (!root || !cu || !cu.farm) { status = 'skip'; break; }
      const openid = doc._openid;

      cu.settledDates = cu.settledDates || [];
      const already = cu.settledDates.indexOf(yest) >= 0;
      const hw = (cu.homework || {})[yest];
      const missing = hw ? SUBS.filter(k => !(hw[k] && hw[k].done)) : SUBS.slice();

      let report = null;
      if (!already && missing.length > 0) report = settle(cu, yest, missing);
      if (!already) cu.settledDates.push(yest);

      // 清空当日作业状态：为今天建立空白记录
      if (!cu.homework) cu.homework = {};
      if (!cu.homework[today]) {
        cu.homework[today] = {};
        SUBS.forEach(k => { cu.homework[today][k] = { done: false, minutes: 0, note: '', doneAt: 0 }; });
      }
      cu.lastActiveDate = today;

      const cas = await casWrite(id, doc.updatedAt, { data: root, updatedAt: Date.now() });
      if (cas !== 'ok') continue;         // 窗口内被人改过 → 重读重算，绝不用旧快照覆盖

      // 写成功后才计账/落记录（重试不产生重复计数、不产生重复结算记录）
      summary.users++;
      if (attempt > 0) summary.retried++;
      if (report) {
        summary.punished++;
        await db.collection(SETTLE).add({
          data: { _openid: openid, date: yest, level: missing.length, missing, bears: report.bears, stolen: report.stolen, withered: report.withered, createdAt: Date.now() }
        });
      }
      status = 'ok';
      break;
    }
    if (status === 'skip') summary.skipped++;
    else if (status !== 'ok') summary.failed++;
  }

  // S4：清理过期的 OCR 调试观测数据（含课表科目内容，避免长期留存儿童导学数据）
  try {
    const cutoff = new Date(Date.now() - OCR_RETAIN_DAYS * 86400000);
    for (let round = 0; round < 50; round++) {   // 每轮最多删 100 条，50 轮封顶防跑飞
      const old = await db.collection(OCR_DEBUG).where({ ts: _.lt(cutoff) }).limit(100).get();
      if (!old.data.length) break;
      for (const od of old.data) await db.collection(OCR_DEBUG).doc(od._id).remove();
      summary.ocrDebugCleaned += old.data.length;
      if (old.data.length < 100) break;
    }
  } catch (e) {
    // 集合不存在等情况静默跳过，不影响结算主流程
    console.warn('[dailyReset] ocr_debug cleanup skipped:', (e && e.message) || e);
  }

  return summary;
};

/**
 * F11：带版本条件的写回（CAS）。
 * 为什么不用「只写结算字段」那条路：结算要动的 `farm` 是结构性的（bears 追加 / plots 逐株改
 * health / coins 扣减），拆成点号路径要么丢语义、要么需要先读后算（又是读-改-写）。
 * 整份写 + 版本校验更简单，且**正确性更强**：它保证了「写的一定是我刚读的那一版」。
 *
 * @param {String} id            文档 _id
 * @param {Number} prevUpdatedAt 刚才读到的版本（毫秒时间戳）
 * @param {Object} fields        要写回的字段（{ data, updatedAt }）
 * @returns {Promise<String>} 'ok' 已写入 | 'conflict' 版本已变，调用方应重读重算
 */
async function casWrite(id, prevUpdatedAt, fields) {
  const prev = Number(prevUpdatedAt) || 0;
  try {
    const cond = prev > 0
      ? { _id: id, updatedAt: prev }
      : { _id: id, updatedAt: _.exists(false) };   // 历史文档没有 updatedAt（它不会自己长出来）
    const res = await db.collection(USER).where(cond).update({ data: fields });
    if (affected(res) > 0) return 'ok';

    // 写不中：分清「真被别人写了」与「条件写返回结构不符预期」——后者若当成冲突，
    // 会导致 3 轮全部空转、该用户每天都被跳过（结算永远不落地），比直接写一次糟得多。
    let nowVer = prev;
    try {
      const re = await db.collection(USER).doc(id).get();
      if (re && re.data) nowVer = Number(re.data.updatedAt) || 0;
    } catch (e) {}
    if (nowVer !== prev) return 'conflict';
    console.warn('[dailyReset] 条件写未生效且版本未变，退化为直写；请检查 SDK 的条件写返回结构', id);
    await db.collection(USER).doc(id).update({ data: fields });
    return 'ok';
  } catch (e) {
    console.warn('[dailyReset] CAS 写回异常，跳过该用户（下次定时任务会补算）', id, (e && e.message) || e);
    return 'conflict';
  }
}

/** 取受影响行数（不同 SDK 版本返回结构不同，双重兜底） */
function affected(res) {
  if (!res) return 0;
  if (res.stats && typeof res.stats.updated === 'number') return res.stats.updated;
  if (typeof res.updated === 'number') return res.updated;
  return 0;
}

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

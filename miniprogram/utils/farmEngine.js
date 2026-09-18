/**
 * ============================================================================
 *  farmEngine.js —— 作业 × 农场 核心联动引擎（整个项目最重要的文件）
 *  ---------------------------------------------------------------------------
 *  这里实现了需求里的四大机制：
 *    ① 奖励机制  checkin()        写完作业 → 阳光 + 学科专属种子（+ 全勤金币）
 *    ② 惩罚机制  nightSettle()    没写完 → 夜晚小狗熊入侵 / 植物枯萎 / NPC 偷金币
 *    ③ 修复机制  usePesticide()   补完作业领杀虫剂 → 赶走小狗熊 + 恢复植物健康
 *    ④ 每日重置  dailyRollover()  凌晨清空当日作业状态 + 结算昨晚惩罚 + 计划顺延
 *
 *  所有力度参数都在 utils/config.js，不要在本文件里写死数字。
 * ============================================================================
 */
const CFG = require('./config.js');
const util = require('./util.js');
const store = require('./store.js');
const analytics = require('./analytics.js');

/** 当前可用的打卡类型 key 列表（内置 + 自定义，动态） */
function getSubKeys() { return store.getTypeList().map(t => t.key); }

/* ==========================================================================
 * 一、作业数据基础操作
 * ========================================================================== */

/** 确保某天的作业记录存在（所有激活类型都建好空记录） */
function ensureDay(d, date) {
  const key = date || util.today();
  if (!d.homework[key]) d.homework[key] = {};
  getSubKeys().forEach(k => {
    if (!d.homework[key][k]) {
      d.homework[key][k] = {
        done: false, minutes: 0, note: '', doneAt: 0,
        /* 打卡时绑定的成长计划任务快照（单向读取：打卡读计划，不回写计划状态） */
        planTask: '', planStage: '', planRef: null
      };
    }
  });
  ensureTypeSeeds(d);
  return d.homework[key];
}

/** 保证 farm.seeds 覆盖每一个激活类型 key（新增自定义类型后旧数据也能正常显示） */
function ensureTypeSeeds(d) {
  if (!d.farm.seeds) d.farm.seeds = {};
  getSubKeys().forEach(k => { if (d.farm.seeds[k] === undefined) d.farm.seeds[k] = 0; });
}

/** 取某天未完成的类型 key 数组 */
function missingSubjects(d, date) {
  const hw = ensureDay(d, date);
  return getSubKeys().filter(k => !hw[k].done);
}

/** 取某天已完成类型数 */
function doneCount(d, date) {
  return getSubKeys().length - missingSubjects(d, date).length;
}

/* ==========================================================================
 * 二、【联动点 ①】奖励机制：打卡 → 阳光 + 种子
 * ========================================================================== */
/**
 * 完成一科作业打卡
 * @returns {Object} 奖励明细，用于弹窗展示
 */
function checkin(d, subject, extra) {
  const date = util.today();
  const hw = ensureDay(d, date);
  if (hw[subject].done) return null;                 // 已打过卡，防重复领奖

  hw[subject].done = true;
  hw[subject].doneAt = Date.now();
  hw[subject].minutes = (extra && extra.minutes) || 0;
  hw[subject].note = (extra && extra.note) || '';
  hw[subject].planTask = (extra && extra.planTask) || '';    // 打卡时成长计划中「最近一条待完成」任务名
  hw[subject].planStage = (extra && extra.planStage) || '';  // 该任务所属阶段
  hw[subject].planRef = (extra && extra.planRef) || null;    // 该任务在计划中的下标 { si, ti }，供历史回链定位
                                                             // 注：仅记录快照，打卡不改变计划的勾选状态

  const sub = store.getType(subject);
  const gain = { sun: CFG.REWARD.SUN_PER_SUBJECT, seed: CFG.REWARD.SEED_PER_SUBJECT, coin: 0, pesticide: 0, allDone: false, subName: sub.name, seedName: sub.seedName };

  // —— 单科奖励：1 颗阳光 + 1 颗对应学科专属种子 ——
  d.farm.suns += gain.sun;
  d.farm.seeds[subject] = (d.farm.seeds[subject] || 0) + gain.seed;

  // —— 三科全部完成的额外奖励 + 连续打卡天数（每天只发一次，防止「撤销→重勾」刷奖励）——
  const missing = missingSubjects(d, date);
  if (missing.length === 0 && !hw.allDoneGranted) {
    hw.allDoneGranted = true;
    gain.allDone = true;
    gain.sun += CFG.REWARD.ALL_DONE_BONUS_SUN;
    gain.coin += CFG.REWARD.ALL_DONE_BONUS_COIN;
    d.farm.suns += CFG.REWARD.ALL_DONE_BONUS_SUN;
    d.farm.coins += CFG.REWARD.ALL_DONE_BONUS_COIN;
    if (CFG.REWARD.ALL_DONE_BONUS_SEED > 0) {
      d.farm.seeds[subject] += CFG.REWARD.ALL_DONE_BONUS_SEED;
      gain.seed += CFG.REWARD.ALL_DONE_BONUS_SEED;
    }
    // 连续打卡天数（护盾兑换条件）
    const p = d.profile;
    p.streak = (p.lastFullCheckinDate && util.diffDays(date, p.lastFullCheckinDate) === 1) ? p.streak + 1 : 1;
    p.lastFullCheckinDate = date;

    // —— 【联动点 ③】修复机制：已经挨过罚 / 农场里还有小狗熊时，补齐作业发杀虫剂 ——
    const punished = d.settledDates.indexOf(date) >= 0 || d.farm.bears.length > 0;
    if (punished) {
      d.farm.pesticide += CFG.REWARD.PESTICIDE_ON_MAKEUP;
      gain.pesticide = CFG.REWARD.PESTICIDE_ON_MAKEUP;
      d.farm.logs.unshift({ date: date, type: 'fix', text: '补齐了全部任务，获得杀虫剂 × ' + gain.pesticide + '，快去赶走小狗熊！' });
    }
  }

  d.farm.logs.unshift({ date: date, type: 'reward', text: `完成${sub.name}任务，获得阳光 ×${CFG.REWARD.SUN_PER_SUBJECT}、${sub.seedName} ×${CFG.REWARD.SEED_PER_SUBJECT}` });
  trimLogs(d);
  store.save(d);

  // —— 阶段 0 埋点 + 家庭内合种推进（任一孩子打卡都推进共享作物）——
  analytics.trackCheckin(d.id, subject, sub.name);
  store.contributeCoop(d.id, sub.name);

  return gain;
}

/** 撤销打卡（误点了可以取消，同时收回奖励） */
function uncheckin(d, subject) {
  const date = util.today();
  const hw = ensureDay(d, date);
  if (!hw[subject].done) return false;
  hw[subject].done = false;
  hw[subject].doneAt = 0;
  d.farm.suns = Math.max(0, d.farm.suns - CFG.REWARD.SUN_PER_SUBJECT);
  d.farm.seeds[subject] = Math.max(0, (d.farm.seeds[subject] || 0) - CFG.REWARD.SEED_PER_SUBJECT);
  store.save(d);
  return true;
}

/* ==========================================================================
 * 二点五、【闭环 S4】导学奖励：完成一次 AI 导学 → 阳光
 * ---------------------------------------------------------------------------
 * 红线：奖励只挂「完成一次导学对话归档」这个【活动】；
 *       复测达标属于【证据】，绝不发奖（防刷复测，守「活动≠证据≠掌握」契约）。
 * @returns {Object|null} 奖励明细（null = 今日已到上限，不发）
 */
function tutorReward(d) {
  if (!d || !d.farm) return null;
  const date = util.today();
  if (!d.farm.tutorBonus) d.farm.tutorBonus = { date: date, count: 0 };
  const tb = d.farm.tutorBonus;
  if (tb.date !== date) { tb.date = date; tb.count = 0; }   // 跨天重置
  if (tb.count >= CFG.REWARD.TUTOR_DAILY_CAP) return null;  // 每日上限，防刷

  tb.count += 1;
  d.farm.suns += CFG.REWARD.TUTOR_SUN;
  d.farm.logs.unshift({
    date: date,
    type: 'reward',
    text: '完成一次导学，获得阳光 ×' + CFG.REWARD.TUTOR_SUN + '（今日第 ' + tb.count + ' 次）'
  });
  trimLogs(d);
  store.save(d);
  return { sun: CFG.REWARD.TUTOR_SUN, count: tb.count, cap: CFG.REWARD.TUTOR_DAILY_CAP };
}

/* ==========================================================================
 * 三、【联动点 ②】惩罚机制：夜晚结算，小狗熊入侵 + NPC 偷菜
 * ========================================================================== */
/**
 * 夜间结算（同一天只会结算一次）
 * 触发时机：
 *   · 当天进入「夜晚」（config.PUNISH.NIGHT_HOUR，默认 19:00）后打开小程序
 *   · 或第二天凌晨自动重置时，对前一天补结算
 * @returns {Object|null} 结算报告，用于弹窗展示
 */
function nightSettle(d, date) {
  const day = date || util.today();
  if (!CFG.PUNISH.ENABLE) return null;
  if (d.settledDates.indexOf(day) >= 0) return null;          // 已结算过，不重复扣

  const missing = missingSubjects(d, day);
  const report = { date: day, level: missing.length, missing: missing.map(k => store.getType(k).name), bears: 0, damaged: 0, withered: 0, stolen: 0, shielded: false, title: '', desc: '' };

  d.settledDates.push(day);
  if (d.settledDates.length > 90) d.settledDates.shift();

  // —— 全部完成：农场平安夜 ——
  if (missing.length === 0) {
    const total = getSubKeys().length;
    report.title = '平安夜！农场安全';
    report.desc = `今天全部 ${total} 项任务都完成了，小狗熊不敢来，植物健康生长～`;
    d.farm.logs.unshift({ date: day, type: 'safe', text: `全部 ${total} 项任务完成，农场平安无事，植物健康生长` });
    trimLogs(d);
    store.save(d);
    return report;
  }

  const conf = CFG.PUNISH.LEVELS[Math.min(missing.length, 3)];
  report.title = conf.title;
  report.desc = `有 ${missing.length} 项任务没做完（${report.missing.join('、')}），小狗熊溜进菜园啃植物，还会被偷走一半金币`;

  // —— 护盾抵挡：消耗 1 个护盾，本次攻击全部免疫 ——
  if (d.farm.shields > 0) {
    d.farm.shields -= 1;
    report.shielded = true;
    report.desc = '护盾闪闪发光，帮你挡下了这次小狗熊的攻击！（护盾 -1）';
    d.farm.logs.unshift({ date: day, type: 'shield', text: '护盾抵挡了小狗熊的攻击，菜园毫发无伤' });
    trimLogs(d);
    store.save(d);
    return report;
  }

  // —— 1. 刷新小狗熊（带啃咬动画，会一直待在农场直到用杀虫剂） ——
  const plots = d.farm.plots;
  const occupied = [];
  plots.forEach((p, i) => { if (p) occupied.push(i); });
  for (let i = 0; i < conf.bears; i++) {
    d.farm.bears.push({
      id: util.uid('bear'),
      // 位置用百分比，方便在 3×3 地块上自由走动
      x: 8 + Math.round(Math.random() * 62),
      y: 10 + Math.round(Math.random() * 55),
      target: occupied.length ? occupied[i % occupied.length] : -1,
      date: day
    });
  }
  report.bears = conf.bears;

  // —— 2. 按等级执行不同的植物破坏逻辑 ——
  const MAXH = CFG.GROWTH.MAX_HEALTH;
  if (conf.mode === 'damageToday') {
    // 等级1：只啃「当天种下」的植物，每株扣 healthLoss 格健康度
    plots.forEach(p => {
      if (p && !p.withered && p.plantedDate === day) {
        p.health = Math.max(0, p.health - conf.healthLoss);
        p.bitten = true;
        report.damaged++;
        if (p.health <= 0) { p.withered = true; report.withered++; }
      }
    });
    if (report.damaged === 0) report.desc = '今天没有新种下的植物，这次侥幸躲过';
  } else if (conf.mode === 'destroyHalfMature') {
    // 等级2：直接毁掉一半（向上取整）的成熟植物，其余植物也掉健康度
    const mature = [];
    plots.forEach((p, i) => { if (p && !p.withered && p.stage >= CFG.GROWTH.MAX_STAGE) mature.push(i); });
    const killCount = Math.ceil(mature.length / 2);
    for (let i = 0; i < killCount; i++) {
      const p = plots[mature[i]];
      p.withered = true; p.health = 0; p.bitten = true;
      report.withered++;
    }
    plots.forEach(p => {
      if (p && !p.withered) {
        p.health = Math.max(0, p.health - 1);
        p.bitten = true;
        report.damaged++;
        if (p.health <= 0) { p.withered = true; report.withered++; }
      }
    });
  } else if (conf.mode === 'witherAllMature') {
    // 等级3：成熟作物全部枯萎 + 当天禁止收获金币
    plots.forEach(p => {
      if (!p) return;
      p.bitten = true;
      if (p.stage >= CFG.GROWTH.MAX_STAGE) { p.withered = true; p.health = 0; report.withered++; }
      else {
        p.health = Math.max(0, p.health - conf.healthLoss);
        report.damaged++;
        if (p.health <= 0) { p.withered = true; report.withered++; }
      }
    });
    if (conf.lockHarvest) d.farm.lockHarvestDate = day;   // 锁定收获
  }

  // —— 3. 额外偷菜机制：漏做任意一科，NPC 偷走一半金币 ——
  const ratio = CFG.PUNISH.STEAL_COIN_RATIO;
  const stolen = Math.min(CFG.PUNISH.STEAL_MAX, Math.floor(d.farm.coins * ratio));
  if (stolen > 0) {
    d.farm.coins -= stolen;
    report.stolen = stolen;
  }

  d.farm.logs.unshift({
    date: day,
    type: 'punish',
    text: `${conf.title}：${report.missing.join('、')}没完成 → 小狗熊 ×${conf.bears}，损坏植物 ${report.damaged} 株、枯萎 ${report.withered} 株，被偷走 ${stolen} 金币`
  });
  trimLogs(d);
  store.save(d);
  return report;
}

/* ==========================================================================
 * 四、【联动点 ③】修复机制：杀虫剂
 * ========================================================================== */
function usePesticide(d) {
  if (d.farm.pesticide <= 0) return { ok: false, msg: '还没有杀虫剂，补完任务就能领到哦' };
  if (d.farm.bears.length === 0 && !hasHurtPlant(d)) return { ok: false, msg: '农场很健康，暂时不需要杀虫剂' };

  d.farm.pesticide -= 1;
  const bearCount = d.farm.bears.length;
  d.farm.bears = [];                                   // 赶走全部小狗熊
  let healed = 0;
  d.farm.plots.forEach(p => {
    if (!p) return;
    if (p.withered || p.health < CFG.GROWTH.MAX_HEALTH) healed++;
    p.withered = false;                                 // 枯萎植物复活
    p.health = CFG.GROWTH.MAX_HEALTH;                   // 健康度恢复满格
    p.bitten = false;
  });
  if (d.farm.lockHarvestDate === util.today()) d.farm.lockHarvestDate = '';  // 解除收获封锁
  d.farm.logs.unshift({ date: util.today(), type: 'fix', text: `使用杀虫剂：赶走 ${bearCount} 只小狗熊，${healed} 株植物恢复健康` });
  trimLogs(d);
  store.save(d);
  return { ok: true, msg: `赶走了 ${bearCount} 只小狗熊，${healed} 株植物恢复健康！`, bearCount, healed };
}

function hasHurtPlant(d) {
  return d.farm.plots.some(p => p && (p.withered || p.health < CFG.GROWTH.MAX_HEALTH));
}

/* ==========================================================================
 * 五、种植 / 生长 / 收获
 * ========================================================================== */

/** 播种：消耗 1 颗对应学科种子 */
function plantSeed(d, plotIndex, subject) {
  if (d.farm.plots[plotIndex]) return { ok: false, msg: '这块地已经种上啦' };
  if ((d.farm.seeds[subject] || 0) <= 0) {
    return { ok: false, msg: `没有${store.getType(subject).seedName}了，去完成${store.getType(subject).name}任务就能解锁` };
  }
  d.farm.seeds[subject] -= 1;
  d.farm.plots[plotIndex] = store.makePlant(subject, 0, CFG.GROWTH.MAX_HEALTH, Date.now(), util.today());
  store.save(d);
  analytics.trackFarm('plant', { childId: d.id, subject: subject });
  return { ok: true, msg: '种下啦！浇点阳光会长得更快～' };
}

/** 浇阳光：立刻推进 1 个生长阶段 */
function useSun(d, plotIndex) {
  const p = d.farm.plots[plotIndex];
  if (!p) return { ok: false, msg: '这块地还是空的' };
  if (p.withered) return { ok: false, msg: '植物枯萎了，先用杀虫剂治好它' };
  if (p.stage >= CFG.GROWTH.MAX_STAGE) return { ok: false, msg: '已经成熟啦，快收获吧' };
  if (d.farm.suns <= 0) return { ok: false, msg: '阳光不够了，完成任务可以领阳光' };
  d.farm.suns -= 1;
  p.stage = Math.min(CFG.GROWTH.MAX_STAGE, p.stage + CFG.GROWTH.SUN_SPEED_UP);
  p.lastGrowAt = Date.now();
  store.save(d);
  return { ok: true, msg: '植物长大了一点！', stage: p.stage };
}

/** 自然生长：按时间推进（每次进入农场页调用一次） */
function growTick(d) {
  const ms = CFG.GROWTH.STAGE_MINUTES * 60000;
  let changed = false;
  const now = Date.now();
  d.farm.plots.forEach(p => {
    if (!p || p.withered || p.stage >= CFG.GROWTH.MAX_STAGE) return;
    const steps = Math.floor((now - p.lastGrowAt) / ms);
    if (steps > 0) {
      p.stage = Math.min(CFG.GROWTH.MAX_STAGE, p.stage + steps);
      p.lastGrowAt = p.lastGrowAt + steps * ms;
      changed = true;
    }
  });
  if (changed) store.save(d, false);
  return changed;
}

/** 收获：成熟且未枯萎、且当天没被锁定收获 */
function harvest(d, plotIndex) {
  const p = d.farm.plots[plotIndex];
  if (!p) return { ok: false, msg: '这块地是空的' };
  if (p.withered) return { ok: false, msg: '枯萎的植物收不了，用杀虫剂救救它' };
  if (p.stage < CFG.GROWTH.MAX_STAGE) return { ok: false, msg: '还没成熟，再等等或者浇阳光' };
  if (d.farm.lockHarvestDate === util.today()) {
    return { ok: false, msg: '今天还有任务没做完，小狗熊把果实糟蹋了，今天不能收获' };
  }
  const sub = store.getType(p.subject);
  d.farm.coins += sub.coin;
  d.farm.harvestLog.unshift({ id: util.uid('hv'), subject: p.subject, name: sub.cropName, coin: sub.coin, date: util.today(), time: nowHM() });
  if (d.farm.harvestLog.length > 200) d.farm.harvestLog.pop();
  d.farm.plots[plotIndex] = null;
  store.save(d);
  analytics.trackFarm('harvest', { childId: d.id, subject: p.subject });
  return { ok: true, msg: `收获 ${sub.cropName}，金币 +${sub.coin}`, coin: sub.coin };
}

/** 铲除枯萎的植物，把地块空出来 */
function clearPlot(d, plotIndex) {
  const p = d.farm.plots[plotIndex];
  if (!p) return { ok: false, msg: '这块地是空的' };
  d.farm.plots[plotIndex] = null;
  store.save(d);
  return { ok: true, msg: '地块清理干净啦' };
}

/* ==========================================================================
 * 六、商店 / 金币商城
 * ========================================================================== */
function buyShop(d, id) {
  const item = CFG.SHOP.find(s => s.id === id);
  if (!item) return { ok: false, msg: '没有这个道具' };

  if (item.type === 'streak') {
    // 护盾：需要连续打卡天数，且每天限量
    if (d.profile.streak < item.needStreak) {
      return { ok: false, msg: `需要连续打卡 ${item.needStreak} 天，你现在是 ${d.profile.streak} 天` };
    }
    if (d.farm.shieldExchangeDate === util.today()) {
      return { ok: false, msg: '今天已经兑换过护盾啦，明天再来' };
    }
    d.farm.shields += 1;
    d.farm.shieldExchangeDate = util.today();
    store.save(d);
    return { ok: true, msg: '兑换成功！护盾能帮你挡下一次小狗熊攻击' };
  }

  if (d.farm.coins < item.price) return { ok: false, msg: `金币不够，还差 ${item.price - d.farm.coins} 枚` };
  d.farm.coins -= item.price;
  if (id === 'sun') d.farm.suns += 1;
  if (id === 'pesticide') d.farm.pesticide += 1;
  store.save(d);
  return { ok: true, msg: `买到 ${item.name} ×1` };
}

function buyMall(d, id) {
  const item = CFG.MALL.find(s => s.id === id);
  if (!item) return { ok: false, msg: '没有这个奖励' };
  if (d.farm.owned.indexOf(id) >= 0) return { ok: false, msg: '已经拥有啦' };
  if (d.farm.coins < item.price) return { ok: false, msg: `金币不够，还差 ${item.price - d.farm.coins} 枚` };
  d.farm.coins -= item.price;
  d.farm.owned.push(id);
  if (item.kind === 'skin') d.profile.equipped.skin = id;
  if (item.kind === 'frame') d.profile.equipped.frame = id;
  store.save(d);
  return { ok: true, msg: `恭喜获得「${item.name}」！` };
}

function equipItem(d, id) {
  const item = CFG.MALL.find(s => s.id === id);
  if (!item || d.farm.owned.indexOf(id) < 0) return { ok: false, msg: '还没有拥有这个奖励' };
  if (item.kind === 'skin') d.profile.equipped.skin = (d.profile.equipped.skin === id ? '' : id);
  if (item.kind === 'frame') d.profile.equipped.frame = (d.profile.equipped.frame === id ? '' : id);
  store.save(d);
  return { ok: true, msg: '换上啦！' };
}

/* ==========================================================================
 * 七、【联动点 ④】每日凌晨自动重置
 * ========================================================================== */
/**
 * 每次启动 / 切回前台时调用：
 *   1) 若跨天：先对昨天做夜间结算（补罚），再顺延未完成计划，清空当日作业状态
 *   2) 若当天已进入夜晚且有缺科：立刻刷新小狗熊（让孩子当晚就看到后果）
 * @returns {Object|null} 需要弹窗展示的结算报告
 */
function dailyRollover(d) {
  const today = util.today();
  let report = null;

  if (d.lastActiveDate && d.lastActiveDate !== today) {
    // —— 跨天：把上次活跃日之后、今天之前所有没结算的日子补结算 ——
    let cursor = d.lastActiveDate;
    let guard = 0;
    while (util.diffDays(today, cursor) > 0 && guard < 30) {
      const r = nightSettle(d, cursor);
      if (r && (r.bears > 0 || r.stolen > 0 || r.shielded)) report = r;   // 只弹最近一次有内容的
      cursor = nextDay(cursor);
      guard++;
    }
    // 计划顺延：昨天没做完的自动滚到今天，不会凭空消失
    carryOverPlans(d, today);
    // 清空当日作业状态（新建今天的空记录）
    ensureDay(d, today);
    d.lastActiveDate = today;
    store.save(d);
  } else {
    ensureDay(d, today);
    d.lastActiveDate = today;
  }

  // —— 当天晚上就结算：19:00 之后如果还有没写完的作业，小狗熊立刻出现 ——
  if (util.isNight(CFG.PUNISH.NIGHT_HOUR) && d.settledDates.indexOf(today) < 0) {
    const r = nightSettle(d, today);
    if (r && (r.bears > 0 || r.stolen > 0 || r.shielded)) report = r;
  }
  return report;
}

function nextDay(key) {
  const d = new Date(key.replace(/-/g, '/'));
  d.setDate(d.getDate() + 1);
  return util.dateKey(d);
}

/** 未完成的计划自动顺延到今天（带 overdue 逾期标记） */
function carryOverPlans(d, today) {
  if (!d.plans[today]) d.plans[today] = [];
  Object.keys(d.plans).forEach(date => {
    if (date >= today) return;
    const list = d.plans[date] || [];
    const rest = [];
    list.forEach(item => {
      if (!item.done) {
        d.plans[today].push(Object.assign({}, item, { overdue: true, from: item.from || date }));
      } else rest.push(item);
    });
    d.plans[date] = rest;
  });
}

/* ==========================================================================
 * 八、辅助
 * ========================================================================== */
function trimLogs(d) {
  if (d.farm.logs.length > 60) d.farm.logs.length = 60;
}

function nowHM() {
  const t = new Date();
  return util.pad(t.getHours()) + ':' + util.pad(t.getMinutes());
}

/** 今晚会发生什么？（用于打卡页 / 农场页的预警文案，支持任意数量打卡类型） */
function forecast(d) {
  const total = getSubKeys().length;
  const missing = missingSubjects(d, util.today());
  if (missing.length === 0) {
    return { level: 0, names: [], text: `全部 ${total} 项都完成了，今晚农场平安，植物健康生长！`, danger: false };
  }
  const conf = CFG.PUNISH.LEVELS[Math.min(missing.length, 3)];
  const names = missing.map(k => store.getType(k).name);
  return {
    level: missing.length,
    names: names,
    text: `还有 ${missing.length} 项没完成（${names.join('、')}），今晚会来 ${conf.bears} 只小狗熊，还会被偷走一半金币！`,
    danger: true
  };
}

module.exports = {
  getSubKeys,
  ensureDay, missingSubjects, doneCount,
  checkin, uncheckin, tutorReward,
  nightSettle, usePesticide,
  plantSeed, useSun, growTick, harvest, clearPlot,
  buyShop, buyMall, equipItem,
  dailyRollover, carryOverPlans, forecast
};

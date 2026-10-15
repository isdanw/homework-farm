/**
 * scenario.js —— 情境化赋予使命感（P2）
 *
 * 设计文档：教育侧留存与节奏增强_功能设计.md §三
 *
 * 【定位】把现有「农场浇灌」奖励从**通用反馈**升级为**学科情境**：
 *   给「为什么要学」一个轻叙事外框。**不重建奖励系统** —— 阳光照旧由
 *   engine.tutorReward 发，本模块只在同一批触发点上**叠加**情境进度。
 *
 * 【多样性原则（承 P1 的教训）】框架表**不写死只有三科**：
 *   · 内置 9 科（对齐 tutorSubjects）各有身份；
 *   · 家长自定义打卡类型（ct_xxx）走 `DEFAULT_FRAME` 兜底，而不是没有身份；
 *   · 身份永远**不绑定年龄** —— 文案用过程性意象（线索/进度/探索），
 *     不用「通关/掌握」这类绝对化断言（避开 orderKit.BANNED_WORDS）。
 *
 * 【纯函数】不 require store.js，避免与数据层循环依赖：
 *   写操作只就地改 u.scenarios，**落盘由调用方 store.save() 负责**
 *   （与 pace.js / farmEngine 同口径）。
 *
 * 【合规】剧情碎片为**本地写死的短句**（≤2 句），不接 AI 生成、不接社区、
 *   无支付解锁、无陌生人社交。解锁为**累积制**（只增不减）——
 *   避免孩子因失误掉进度产生挫败。
 */

/* ==========================================================================
 * 一、学科情境框架表
 * ========================================================================== */

/** 每个进度节点需要累计多少次有效学习行为才解锁一段剧情 */
const UNLOCK_STEP = 3;

/** 默认解锁步长（家长自定义打卡类型走这里） */
const DEFAULT_STEP = UNLOCK_STEP;

/**
 * 框架字段：
 *   identity  情境身份（如「数学小侦探」）
 *   emoji     身份图标
 *   progressNoun 进度意象（进度条旁的量词，如「线索卡」）
 *   step      解锁一段剧情需要的累计次数
 *   fragments 剧情碎片 [{id, title, text}]，text ≤2 句、纯本地写死
 */
const FRAMES = {
  math: {
    identity: '数学小侦探',
    emoji: '🔍',
    progressNoun: '线索卡',
    step: 3,
    fragments: [
      { id: 'math_c1', title: '第一张线索卡', text: '你把题目里的小条件圈了出来，侦探的第一步脚印出现了。' },
      { id: 'math_c2', title: '第二张线索卡', text: '试过的方法被记进小本本，下次遇到同类题会更快想起。' },
      { id: 'math_c3', title: '第三张线索卡', text: '错题变成了脚印而不是障碍，案卷一点点厚起来了。' },
      { id: 'math_c4', title: '第四张线索卡', text: '你能自己发现哪一步最容易卡住，这本身就是重要线索。' },
      { id: 'math_c5', title: '第五张线索卡', text: '算式写清楚、检查一遍，侦探的仪式感就位了。' }
    ]
  },
  chinese: {
    identity: '汉字探险家',
    emoji: '🗺️',
    progressNoun: '地图',
    step: 3,
    fragments: [
      { id: 'chinese_c1', title: '点亮第一格地图', text: '拼音的地图上多了一格，读音和声调有了落脚的地方。' },
      { id: 'chinese_c2', title: '点亮第二格地图', text: '词语被你拆开又合上，字形在小本本上留住了影子。' },
      { id: 'chinese_c3', title: '点亮第三格地图', text: '遇到不认识的字先猜一猜再核对，探险家的习惯养成了。' },
      { id: 'chinese_c4', title: '点亮第四格地图', text: '句子读起来顺了，说明你已经在心里给它标好了路标。' },
      { id: 'chinese_c5', title: '点亮第五格地图', text: '写完读一遍听听声音，字词就住进你的探险包里了。' }
    ]
  },
  english: {
    identity: '单词收集员',
    emoji: '🫙',
    progressNoun: '词汇罐',
    step: 3,
    fragments: [
      { id: 'english_c1', title: '词汇罐 +1', text: '第一个单词精灵住进了罐子，它带来了一个小小的问候。' },
      { id: 'english_c2', title: '词汇罐 +2', text: '听一遍、跟读一遍，精灵在你的声音里待得更安稳了。' },
      { id: 'english_c3', title: '词汇罐 +3', text: '把单词用在句子里，精灵就从罐子里跳出来和你玩啦。' },
      { id: 'english_c4', title: '词汇罐 +4', text: '你开始记得精灵的名字，而不是它的编号。' },
      { id: 'english_c5', title: '词汇罐 +5', text: '收集来的单词排成一排，像一条通往新地方的路。' }
    ]
  },
  physics: {
    identity: '力学观察员',
    emoji: '🔭', progressNoun: '实验记录', step: DEFAULT_STEP,
    fragments: [
      { id: 'physics_c1', title: '实验记录 +1', text: '你注意到力往哪个方向走，这是观察的第一步。' },
      { id: 'physics_c2', title: '实验记录 +2', text: '把现象画成图，变化的样子就留下来了。' },
      { id: 'physics_c3', title: '实验记录 +3', text: '换个条件再试一次，答案就更清楚了。' }
    ]
  },
  chemistry: {
    identity: '小小实验员',
    emoji: '⚗️', progressNoun: '实验步骤', step: DEFAULT_STEP,
    fragments: [
      { id: 'chemistry_c1', title: '实验步骤 +1', text: '先观察再动手，安全的第一条规则被你记住了。' },
      { id: 'chemistry_c2', title: '实验步骤 +2', text: '每次只改一个条件，你在做最靠谱的对照实验。' },
      { id: 'chemistry_c3', title: '实验步骤 +3', text: '现象和结论分开写，实验员的记录方式很专业。' }
    ]
  },
  biology: {
    identity: '自然观察员',
    emoji: '🌿', progressNoun: '观察笔记', step: DEFAULT_STEP,
    fragments: [
      { id: 'biology_c1', title: '观察笔记 +1', text: '你开始注意一片叶子边缘的小锯齿。' },
      { id: 'biology_c2', title: '观察笔记 +2', text: '记录下时间和天气，观察就有了对照。' },
      { id: 'biology_c3', title: '观察笔记 +3', text: '把两次观察放一起，变化自己会说话。' }
    ]
  },
  history: {
    identity: '时光讲述员',
    emoji: '📜', progressNoun: '时间线', step: DEFAULT_STEP,
    fragments: [
      { id: 'history_c1', title: '时间线 +1', text: '给一件事找到它发生的时间，故事就有了开头。' },
      { id: 'history_c2', title: '时间线 +2', text: '把人和事放在一起，因果关系开始显形。' },
      { id: 'history_c3', title: '时间线 +3', text: '你不只是记住年份，还记住了当时的人在想什么。' }
    ]
  },
  geography: {
    identity: '地图勘探员',
    emoji: '🧭', progressNoun: '地图角', step: DEFAULT_STEP,
    fragments: [
      { id: 'geography_c1', title: '地图角 +1', text: '地形有了轮廓，方向感就先长出来一点。' },
      { id: 'geography_c2', title: '地图角 +2', text: '把气候和植被对上，地图就不只是图案了。' },
      { id: 'geography_c3', title: '地图角 +3', text: '你能说出这里为什么和那里不一样了。' }
    ]
  },
  politics: {
    identity: '规则研究员',
    emoji: '⚖️', progressNoun: '规则卡', step: DEFAULT_STEP,
    fragments: [
      { id: 'politics_c1', title: '规则卡 +1', text: '先问「为什么要有这条规则」，问题问得比答案更早。' },
      { id: 'politics_c2', title: '规则卡 +2', text: '规则保护了谁，你开始想它背后的那件事。' },
      { id: 'politics_c3', title: '规则卡 +3', text: '遇到新情况，你会先找一找可以参照的规则。' }
    ]
  }
};

/** 自定义打卡类型（ct_xxx）兜底框架 —— 「有身份」优先于「没身份」 */
const DEFAULT_FRAME = {
  identity: '小小探索家',
  emoji: '🧭',
  progressNoun: '探索脚印',
  step: DEFAULT_STEP,
  fragments: [
    { id: 'custom_c1', title: '第一个脚印', text: '你完成了今天的一次尝试，探索从这里开始记。' },
    { id: 'custom_c2', title: '第二个脚印', text: '做过的每一件事都被记下来了，路就慢慢变清楚。' },
    { id: 'custom_c3', title: '第三个脚印', text: '回头看时，你会发现已经走了挺远。' },
    { id: 'custom_c4', title: '第四个脚印', text: '坚持这件事本身，就值得被记一笔。' },
    { id: 'custom_c5', title: '第五个脚印', text: '脚印越来越多，探索家的背包也快装满了。' }
  ]
};

/** 取某学科的框架（内置 9 科；其余走 DEFAULT_FRAME，**不绑定具体科目名**） */
function frameOf(subject) {
  return FRAMES[subject] || DEFAULT_FRAME;
}

/* ==========================================================================
 * 二、scenario 数据形状（R4 字段只增，形状唯一来源）
 * ========================================================================== */

/**
 * 单个学科的情境状态。
 * @param {String} subject 学科 key
 */
function defaultScenario(subject) {
  return {
    subject: subject || '',
    progress: 0,                 // 累计有效学习行为次数（只增不减）
    chapter: 1,                  // 当前进度节点 = ⌊progress / step⌋ + 1
    unlocked: [],                // 已解锁剧情碎片 id（累积制，永不回退）
    updatedAt: 0                 // 最后更新时间戳
  };
}

/** 归一化单个学科情境（补齐缺失字段、按框架校准 chapter） */
function normalizeScenario(scn, subject) {
  const def = defaultScenario(subject);
  if (!scn || typeof scn !== 'object') scn = def;
  Object.keys(def).forEach(k => { if (scn[k] === undefined) scn[k] = def[k]; });
  if (!Array.isArray(scn.unlocked)) scn.unlocked = [];
  const step = frameOf(subject).step || DEFAULT_STEP;
  // chapter 由 progress 推导，保证与框架 step 永远一致（不落盘漂移）
  scn.chapter = Math.floor((Number(scn.progress) || 0) / step) + 1;
  scn.progress = Math.max(0, Number(scn.progress) || 0);
  return scn;
}

/* ==========================================================================
 * 三、推进 / 解锁
 * ========================================================================== */

/**
 * 推进学科情境进度。**累积制**：只增不减，重复调用不会掉进度。
 *
 * @param {Object} u       孩子切片（store.get() 的返回值）
 * @param {String} subject 学科 key（chinese/math/english/ct_xxx…）
 * @returns {{unlocked:Array, chapter:Number, progress:Number, delta:Number}}
 *   unlocked = 本次新解锁的碎片数组（空数组表示无新解锁）
 */
function advance(u, subject) {
  if (!u || typeof u !== 'object' || !subject) return { unlocked: [], chapter: 1, progress: 0, delta: 0 };
  if (!u.scenarios || typeof u.scenarios !== 'object') u.scenarios = {};

  const scn = normalizeScenario(u.scenarios[subject], subject);
  u.scenarios[subject] = scn;

  const frame = frameOf(subject);
  const before = scn.unlocked.length;

  scn.progress += 1;                          // 累积：只增
  scn.updatedAt = Date.now();
  // ⚠️ normalizeScenario 是在 progress++ **之前**跑的，chapter 此刻是旧值，
  //    必须按新 progress 重算一次，否则解锁判定会慢一拍。
  const step = frame.step || DEFAULT_STEP;
  scn.chapter = Math.floor(scn.progress / step) + 1;

  // 达节点 → 解锁一段剧情碎片。
  // 阈值语义：progress 跨过 step 的整数倍才解锁（第 1 段在 progress==step 时解锁），
  // 故 chapter=1 表示「还没解锁任何碎片」，fragments 索引需用 chapter-2。
  const fragIndex = scn.chapter - 2;
  const frag = fragIndex >= 0 ? frame.fragments[fragIndex] : null;
  if (frag && scn.unlocked.indexOf(frag.id) < 0) {
    scn.unlocked.push(frag.id);               // 累积制：只 push，不 remove
  }

  return {
    unlocked: scn.unlocked.slice(before),      // 本次新解锁
    chapter: scn.chapter,
    progress: scn.progress,
    delta: 1
  };
}

/**
 * 取某学科的情境状态（只读，自动归一化但不落盘）。
 * @returns {Object} scenario 状态
 */
function getScenario(u, subject) {
  if (!u || typeof u !== 'object' || !subject) return defaultScenario(subject);
  if (!u.scenarios || typeof u.scenarios !== 'object') u.scenarios = {};
  const scn = normalizeScenario(u.scenarios[subject], subject);
  u.scenarios[subject] = scn;
  return scn;
}

/* ==========================================================================
 * 四、视图模型（UI 只读这个）
 * ========================================================================== */

/**
 * 情境横幅视图模型。
 * @param {Object} u       孩子切片
 * @param {String} subject 学科 key
 * @returns {{identity:String,emoji:String,progressNoun:String,progress:Number,
 *            chapter:Number,step:Number,nodePct:Number,latest:Object|null,
 *            unlockedCount:Number}}
 */
function banner(u, subject) {
  const frame = frameOf(subject);
  const scn = getScenario(u, subject);
  const step = frame.step || DEFAULT_STEP;
  // nodePct：当前节点内的进度百分比（0..100）
  const inNode = scn.progress % step;
  const nodePct = Math.round(inNode / step * 100);
  // latest：最近解锁的那一段（没有则取第一段作为「预览」，但不算已解锁）
  let latest = null;
  if (scn.unlocked.length) {
    const lastId = scn.unlocked[scn.unlocked.length - 1];
    latest = frame.fragments.find(f => f.id === lastId) || null;
  }
  return {
    identity: frame.identity,
    emoji: frame.emoji,
    progressNoun: frame.progressNoun,
    progress: scn.progress,
    chapter: scn.chapter,
    step: step,
    nodePct: nodePct,
    latest: latest,
    unlockedCount: scn.unlocked.length
  };
}

module.exports = {
  // 框架
  FRAMES, DEFAULT_FRAME, UNLOCK_STEP,
  frameOf,
  // 数据
  defaultScenario, normalizeScenario, getScenario,
  // 行为
  advance,
  // 视图
  banner
};
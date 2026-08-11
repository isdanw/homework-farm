/**
 * ============================================================================
 *  【全局可调参数配置中心】config.js
 *  ---------------------------------------------------------------------------
 *  家长 / 老师 / 开发者想修改玩法，99% 的情况只需要改这一个文件：
 *    · 想调小狗熊惩罚力度 ......... 改 PUNISH
 *    · 想改每日阳光奖励数量 ....... 改 REWARD.SUN_PER_SUBJECT / ALL_DONE_BONUS_SUN
 *    · 想自定义农场作物样式 ....... 改 SUBJECTS 里的 color / cropName / shape
 *    · 想改作物生长速度 ........... 改 GROWTH.STAGE_MINUTES
 *    · 想改商店价格 / 商城奖励 .... 改 SHOP / MALL
 *  详细图文教程见项目根目录 README.md
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * 一、三大学科定义（同时决定「种子 / 作物」的外观样式）
 * shape 可选：'flower'(花朵) | 'berry'(果实) | 'leaf'(叶菜) | 'carrot'(萝卜)
 * 想新增学科？在这里加一项，并在 farm.wxss 里补一条 .p-{key} 的配色即可
 * ------------------------------------------------------------------------- */
const SUBJECTS = [
  {
    key: 'chinese',
    name: '语文',
    icon: '语',
    color: '#FFB3C6',          // 主色（花瓣/果实颜色）
    colorDeep: '#FF8FAE',      // 深色（描边、阴影）
    seedName: '语文种子',
    cropName: '樱花小花',
    shape: 'flower',           // 作物造型
    coin: 8                    // 单株成熟收获金币
  },
  {
    key: 'math',
    name: '数学',
    icon: '数',
    color: '#9AD5FF',
    colorDeep: '#5FB6F5',
    seedName: '数学种子',
    cropName: '蓝莓果果',
    shape: 'berry',
    coin: 8
  },
  {
    key: 'english',
    name: '英语',
    icon: 'A',
    color: '#A8E6A1',
    colorDeep: '#6FCF7C',
    seedName: '英语种子',
    cropName: '青提叶菜',
    shape: 'leaf',
    coin: 8
  }
];

/* ---------------------------------------------------------------------------
 * 二、奖励机制（完成作业 → 阳光 + 种子）
 * 【核心联动点 ①】写作业 = 赚阳光和种子
 * ------------------------------------------------------------------------- */
const REWARD = {
  SUN_PER_SUBJECT: 1,        // 完成 1 科作业奖励的阳光数（默认 1，三科全完成即 3 颗）
  SEED_PER_SUBJECT: 1,       // 完成 1 科作业奖励的对应学科种子数
  ALL_DONE_BONUS_SUN: 0,     // 三科全部完成的「额外」阳光（默认 0 → 总计正好 3 颗）
  ALL_DONE_BONUS_SEED: 0,    // 三科全部完成的「额外」随机种子
  ALL_DONE_BONUS_COIN: 5,    // 三科全勤额外金币小红包（不想给就改成 0）
  PESTICIDE_ON_MAKEUP: 1     // 补齐当天全部作业后发放的杀虫剂瓶数
};

/* ---------------------------------------------------------------------------
 * 三、惩罚机制（没写完作业 → 夜晚小狗熊入侵 + NPC 偷菜）
 * 【核心联动点 ②】这是"没写完作业就会受到农场惩罚"的总开关
 *
 * mode 说明：
 *   'damageToday'      —— 只啃「当天种下」的植物，每株扣 healthLoss 格健康度
 *   'destroyHalfMature'—— 直接毁掉一半（向上取整）的成熟植物
 *   'witherAllMature'  —— 全部成熟作物枯萎，并锁定当天收获
 *
 * 想让惩罚更温柔：把 bears 调小、healthLoss 改 0、STEAL_COIN_RATIO 改 0.2
 * 想彻底关闭惩罚：ENABLE 改成 false
 * ------------------------------------------------------------------------- */
const PUNISH = {
  ENABLE: true,              // 惩罚总开关（false = 只奖励不惩罚，适合刚起步的小朋友）
  NIGHT_HOUR: 19,            // 几点算「夜晚」（19 = 晚上 7 点后小狗熊就会出现）
  STEAL_COIN_RATIO: 0.5,     // NPC 偷菜：漏做任意一科，偷走金币的比例（0.5 = 一半）
  STEAL_MAX: 9999,           // 单次最多被偷多少金币（怕孩子受打击可设 20）

  // 按「未完成科目数」分级的惩罚配置
  LEVELS: {
    1: {
      bears: 1,
      mode: 'damageToday',
      healthLoss: 1,
      title: '1 只小狗熊闯进菜园',
      desc: '有 1 科作业没写完，1 只小狗熊啃掉了今天种下植物的 1 格健康度'
    },
    2: {
      bears: 2,
      mode: 'destroyHalfMature',
      healthLoss: 2,
      title: '2 只小狗熊结伴来偷吃',
      desc: '有 2 科作业没写完，2 只小狗熊毁掉了一半成熟的植物'
    },
    3: {
      bears: 3,
      mode: 'witherAllMature',
      healthLoss: 3,
      lockHarvest: true,
      title: '3 只小狗熊集体入侵！',
      desc: '三科作业都没写，成熟作物全部枯萎，今天一枚金币也收不到了'
    }
  }
};

/* ---------------------------------------------------------------------------
 * 四、作物生长设置
 * 生长周期：0 播种 → 1 发芽 → 2 开花 → 3 成熟
 * ------------------------------------------------------------------------- */
const GROWTH = {
  STAGE_NAMES: ['播种', '发芽', '开花', '成熟'],
  STAGE_MINUTES: 120,        // 自然生长：每 120 分钟长大一阶段（想快点改成 5 试试）
  MAX_STAGE: 3,
  MAX_HEALTH: 3,             // 满健康度格数（被小狗熊啃 1 次掉 1 格，掉到 0 就枯萎）
  PLOT_COUNT: 9,             // 农场地块数量（3 × 3）
  SUN_SPEED_UP: 1            // 浇 1 颗阳光立刻长大 1 阶段
};

/* ---------------------------------------------------------------------------
 * 五、道具商店（用金币买 / 用连续打卡兑换）
 * ------------------------------------------------------------------------- */
const SHOP = [
  {
    id: 'sun',
    name: '阳光',
    desc: '给植物浇一次，立刻长大一阶段',
    price: 6,                // 金币价格
    unit: '颗',
    type: 'coin'
  },
  {
    id: 'pesticide',
    name: '杀虫剂',
    desc: '赶走全部小狗熊，并把植物健康度恢复满',
    price: 15,
    unit: '瓶',
    type: 'coin'
  },
  {
    id: 'shield',
    name: '护盾',
    desc: '连续打卡 3 天可兑换，能抵挡 1 次小狗熊攻击',
    price: 0,
    unit: '个',
    type: 'streak',
    needStreak: 3,           // 需要连续打卡的天数（改这里调整兑换难度）
    dailyLimit: 1            // 每天最多兑换几个
  }
];

/* ---------------------------------------------------------------------------
 * 六、金币商城（虚拟奖状 / 头像框 / 学习皮肤）
 * kind: 'cert' 奖状 | 'frame' 头像框 | 'skin' 学习皮肤（会改变农场背景配色）
 * ------------------------------------------------------------------------- */
const MALL = [
  { id: 'cert_week',  kind: 'cert',  name: '每周小学霸奖状', price: 60,  color: '#FFD98E', desc: '连续认真打卡的小朋友专属' },
  { id: 'cert_month', kind: 'cert',  name: '月度农场之星奖状', price: 200, color: '#FFB3C6', desc: '一整月都没被小狗熊打败！' },
  { id: 'frame_flower', kind: 'frame', name: '小花花头像框', price: 40, color: '#FFB3C6', desc: '粉粉嫩嫩的花环边框' },
  { id: 'frame_star',   kind: 'frame', name: '小星星头像框', price: 80, color: '#9AD5FF', desc: '闪闪发光的星星边框' },
  { id: 'skin_spring',  kind: 'skin',  name: '春日草地皮肤', price: 100, color: '#A8E6A1', desc: '农场变成嫩绿春天' },
  { id: 'skin_sakura',  kind: 'skin',  name: '樱花庭院皮肤', price: 150, color: '#FFC9DC', desc: '农场变成粉色樱花园' },
  { id: 'skin_ocean',   kind: 'skin',  name: '海边农场皮肤', price: 150, color: '#BFE6FF', desc: '农场变成蓝色海边小院' }
];

/* ---------------------------------------------------------------------------
 * 七、其它文案与开关
 * ------------------------------------------------------------------------- */
const TEXT = {
  // 进入农场时的未完成作业弹窗（{n} 会被替换成科目数，{s} 会被替换成科目名）
  FARM_WARN_TITLE: '小狗熊警告！',
  FARM_WARN_CONTENT: '还有 {n} 科作业未完成（{s}），今晚小狗熊会来破坏你的菜园！快去打卡完成任务'
};

const BACKUP_TIP_COUNT = 30; // 数据积累多少条时提示导出备份

module.exports = {
  SUBJECTS,
  REWARD,
  PUNISH,
  GROWTH,
  SHOP,
  MALL,
  TEXT,
  BACKUP_TIP_COUNT,
  // 便捷查询：根据 key 拿学科配置
  getSubject(key) {
    return SUBJECTS.find(s => s.key === key) || SUBJECTS[0];
  }
};

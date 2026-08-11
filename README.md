# 小学一年级暑假 · 语数英作业监督打卡小程序（含联动农场小游戏）

> 一个微信小程序：每天完成「语文 / 数学 / 英语」三科作业 → 农场获得阳光和种子、植物健康长大、产出金币；
> 没写完作业 → 夜晚小狗熊入侵啃食植物、NPC 偷走一半金币、严重时作物全部枯萎。
> 奖惩全部由「作业完成情况」自动驱动，零人工干预。

---

## 一、目录结构

```
项目根目录/
├── project.config.json            # 小程序项目配置（appid / 云函数目录）
├── miniprogram/                   # 前端代码
│   ├── app.js / app.json / app.wxss   # 全局逻辑 / 页面与 tabBar 注册 / 马卡龙主题
│   ├── custom-tab-bar/            # 自定义底部 5 栏导航（作业未完成时农场栏显示红点）
│   ├── pages/
│   │   ├── index/                 # 学习乐园枢纽（三扇学科大门 + 实时三科状态 + 家长备份）
│   │   ├── learn-pinyin/          # 拼音汉字（认知卡片 / 拼读练习 / 汉字描红 + 发音）
│   │   ├── learn-math/            # 数学乐园（20 以内加减 / 逻辑训练 / 几何图形）
│   │   ├── learn-english/         # 英语启蒙（字母认知 / 单词卡 / 简单跟读 + 发音）
│   │   ├── checkin/               # 作业打卡（三科打卡 + 阳光奖励弹窗 + 一周战绩）
│   │   ├── stats/                 # 学习统计（14 天柱状图 + 农场大事记）
│   │   ├── errors/                # 错题本（每掌握 3 题额外 +1 阳光）
│   │   ├── farm/                  # 我的农场（地块/仓库/商店/背包 + 小狗熊动画）
│   │   └── mall/                  # 金币商城（奖状 / 头像框 / 皮肤）
│   └── utils/
│       ├── config.js              # ★ 全局可调参数中心（改玩法 99% 只动这里）
│       ├── util.js                # 日期/星期/本地存储等工具
│       ├── store.js               # 统一数据层 + 跨页事件总线（核心联动点 ③）
│       ├── farmEngine.js          # ★ 农场核心联动引擎（奖励/惩罚/生长/结算）
│       ├── learnData.js           # 三大学习模块的静态内容（拼音/拼读/描红/图形/字母/单词）
│       └── tts.js                 # 文本转语音封装（微信同声传译插件 WechatSI）
└── cloudfunctions/                # 云开发后端（可选，离线也能用）
    ├── initDB/                    # 首次创建 3 个云数据库集合
    ├── syncData/                  # 数据上传/下载（按 openid 隔离）
    └── dailyReset/                # 每日 00:05 定时任务（服务端兜底结算惩罚）
```

---

## 二、如何运行 / 部署

1. 用微信开发者工具「导入项目」，目录选 `项目根目录`，AppID 用测试号或自己的小程序 AppID。
2. 开通「云开发」→ 在 `miniprogram/app.js` 的 `initCloud()` 里把 `'your-env-id'` 改成你的云环境 ID。
3. 右键 `cloudfunctions/initDB` → 上传并部署 → 在云函数里点「运行」一次，自动建好 3 个集合。
4. 依次上传 `syncData`、`dailyReset` 两个云函数；`dailyReset` 自带定时器（每天北京时间 00:05）。
5. 不配云环境也能用：数据走本地存储（`wx.setStorageSync`），只是没有跨设备同步。

> 首次进入会预置示例数据（1 条「昨天逾期」的作业 + 1 株被啃过的植物），孩子一眼就能看懂效果。

---

## 三、「作业 ↔ 农场」联动逻辑在哪

| 标记 | 位置 | 作用 |
|------|------|------|
| **核心联动点 ①** | `utils/config.js` → `REWARD` | 写完作业发阳光 + 对应学科种子 |
| **核心联动点 ②** | `utils/config.js` → `PUNISH` | 没写完作业 → 夜晚小狗熊/偷菜惩罚总开关 |
| **核心联动点 ③** | `utils/store.js` 的 `save()` / 事件总线 | 打卡页改了数据，农场页实时刷新（无需手动下拉） |

实际执行在 `utils/farmEngine.js`：
- `checkin(subject)` —— 打卡发奖 + 连续天数 + 补完作业发杀虫剂
- `nightSettle(missing)` —— 按漏做科目数算惩罚等级、刷小狗熊、偷金币、枯萎植物、锁收获
- `dailyRollover()` —— 跨天后清作业、把昨天没做完的计划顺延、触发夜晚结算

> 联调提示：云函数 `dailyReset/index.js` 里**也镜像了一份 `PUNISH`**，改惩罚参数时务必前后端同步（详见第四节）。

---

## 四、教程 ①：如何调整小狗熊惩罚力度

所有惩罚开关都在 **`miniprogram/utils/config.js`** 的 `PUNISH` 对象里。

```js
const PUNISH = {
  ENABLE: true,             // 总开关。false = 只奖励不惩罚（适合刚起步的小朋友）
  NIGHT_HOUR: 19,           // 几点算「夜晚」，到点小狗熊出现
  STEAL_COIN_RATIO: 0.5,    // 漏做任意一科，NPC 偷走金币的比例（0.5 = 一半）
  STEAL_MAX: 9999,          // 单次最多被偷金币数（怕孩子受打击可改成 20）

  LEVELS: {                 // 按「未完成科目数」分级
    1: { bears: 1, mode: 'damageToday',     healthLoss: 1 }, // 1 科没写
    2: { bears: 2, mode: 'destroyHalfMature', healthLoss: 2 }, // 2 科没写
    3: { bears: 3, mode: 'witherAllMature', healthLoss: 3, lockHarvest: true } // 3 科没写
  }
};
```

### 常见调整

**想温柔一点**（不打击积极性）：
```js
ENABLE: true,
STEAL_COIN_RATIO: 0.2,   // 只偷 20%
STEAL_MAX: 20,           // 每天最多被偷 20 金币
LEVELS: {
  1: { bears: 1, mode: 'damageToday', healthLoss: 0 }, // 只出现 1 只熊，但不掉血
  2: { bears: 1, mode: 'damageToday', healthLoss: 1 }, // 2 科也只用 1 只轻啃
  3: { bears: 2, mode: 'destroyHalfMature', healthLoss: 1 } // 3 科也只毁一半
}
```

**想严厉一点**：把 `bears` 调大、`healthLoss` 调大、`STEAL_COIN_RATIO` 调到 `0.8`。

**想彻底关闭惩罚**（纯激励模式）：直接 `ENABLE: false`。

**想加第 4 级**（比如 4 科作业场景）：在 `LEVELS` 里加 `4: { ... }`，并同步改 `farmEngine.nightSettle` 里 `Math.min(missing, 3)` 的上限、以及 `dailyReset` 里的 `Math.min(missing.length, 3)`。

> ⚠️ **务必同步云端**：`cloudfunctions/dailyReset/index.js` 顶部有一份 `PUNISH` 镜像。改了前端 `LEVELS` / `STEAL_COIN_RATIO` 后，这里也要改成一样，否则云端定时结算会用旧参数。

---

## 五、教程 ②：如何修改每日阳光奖励数量

阳光奖励在 **`miniprogram/utils/config.js`** 的 `REWARD` 对象里。

```js
const REWARD = {
  SUN_PER_SUBJECT: 1,     // 每完成 1 科作业奖励的阳光数（默认三科全完成 = 3 颗）
  SEED_PER_SUBJECT: 1,    // 每完成 1 科奖励的对应学科种子数
  ALL_DONE_BONUS_SUN: 0,  // 三科「全部完成」的额外阳光（0 = 总计正好 3 颗）
  ALL_DONE_BONUS_SEED: 0, // 三科全部完成的额外随机种子
  ALL_DONE_BONUS_COIN: 5, // 三科全勤额外金币小红包（不想给就改 0）
  PESTICIDE_ON_MAKEUP: 1  // 补齐当天全部作业后发放的杀虫剂瓶数
};
```

### 常见调整

- **想让阳光更「值钱」/ 更稀有**：把 `SUN_PER_SUBJECT` 调成 `1`，但把 `ALL_DONE_BONUS_SUN` 设成 `2` —— 这样单科完成得 1 颗，三科全勤额外再得 2 颗，总计 5 颗，鼓励「全勤」。
- **想每天固定发更多阳光**：直接 `SUN_PER_SUBJECT: 2`（单科 2 颗，三科 6 颗）。
- **想取消金币红包**：`ALL_DONE_BONUS_COIN: 0`。
- **想让「补作业」奖励更多杀虫剂**：`PESTICIDE_ON_MAKEUP: 2`。

> 阳光只在前端 `config.js` 控制，没有云端镜像，**改完即时生效**。

---

## 六、教程 ③：如何自定义农场作物样式

作物样式由两部分组成：**颜色**（数据驱动）和**造型**（CSS/WXML 驱动）。

### 6.1 改颜色（最简单，只动 config.js）

在 **`miniprogram/utils/config.js`** 的 `SUBJECTS` 里改 `color`（主色/花瓣/果实）和 `colorDeep`（描边/阴影/叶菜深色）：

```js
{
  key: 'chinese', name: '语文', icon: '语',
  color: '#FFB3C6',      // ← 改成你喜欢的颜色，全农场该作物自动变色
  colorDeep: '#FF8FAE',  // ← 深色描边
  seedName: '语文种子', cropName: '樱花小花',
  shape: 'flower', coin: 8
}
```

颜色通过 `style="background:{{item.color}}"` 内联注入（见 `farm.wxml` 第 66-86 行），
**改完 config.js 即可，无需碰 CSS**。

### 6.2 改造型（flower / berry / leaf 三种现成造型）

- `shape: 'flower'` → 五瓣花（`.petal` + `.core`，`farm.wxss` 第 195-204 行）
- `shape: 'berry'`  → 蓝莓果实（`.berry`，`farm.wxss` 第 206-210 行）
- `shape: 'leaf'`   → 青提叶菜（`.bigleaf`，`farm.wxss` 第 212-216 行）

换造型：把学科配置里的 `shape` 改成上面三种之一即可，例如把英语从 `leaf` 改成 `berry`。

### 6.3 细化造型比例 / 新增造型

- **微调配比**：直接改 `farm.wxss` 里 `.petal` / `.berry` / `.bigleaf` 的宽高、位置。
  例如把花朵花瓣改大：`.petal { width: 34rpx; height: 52rpx; }`。
- **新增一种造型**（如 `carrot` 萝卜）：
  1) 在 `config.js` 的 `SUBJECTS` 某项加 `shape: 'carrot'`；
  2) 在 `farm.wxml` 第 72-87 行的 `<view class="pl-crop">` 内加一个分支：
     ```xml
     <block wx:elif="{{item.shape==='carrot'}}">
       <view class="carrot" style="background:{{item.color}};border-color:{{item.colorDeep}}"></view>
     </block>
     ```
  3) 在 `farm.wxss` 里补一条 `.carrot { ... }` 的画法。
- **用 shape 钩子做整株覆盖**：`.plant` 容器带有 `shape-flower` / `shape-berry` / `shape-leaf` 类（见 `farm.wxml` 第 60 行），
  想对某科作物整株做特殊样式，可写 `.plant.shape-flower .pl-stem { ... }` 这样的选择器。

### 6.4 顺手可改的其它外观

| 想改什么 | 改哪里 |
|----------|--------|
| 生长速度（默认 120 分钟长一阶段） | `config.js` → `GROWTH.STAGE_MINUTES` |
| 地块数量（默认 3×3=9） | `config.js` → `GROWTH.PLOT_COUNT` |
| 护盾兑换所需连续打卡天数（默认 3 天） | `config.js` → `SHOP` 里 `shield.needStreak` |
| 商店价格 / 商城奖励 | `config.js` → `SHOP` / `MALL` |
| 农场皮肤背景色 | `farm.wxss` 第 8-10 行 `.skin-spring/.skin-sakura/.skin-ocean` |
| 进入农场时的未完成弹窗文案 | `config.js` → `TEXT.FARM_WARN_CONTENT`（`{n}` 科目数，`{s}` 科目名） |

---

## 七、新增一门学科（进阶）

1. `config.js` 的 `SUBJECTS` 数组追加一项（key / name / color / shape / coin）。
2. `farmEngine.js` 和 `dailyReset/index.js` 里的 `SUBS`（学科 key 列表）加上新 key。
3. `pages/index`、`pages/checkin` 里写死的「三科」遍历会自动读取 `SUBJECTS`，一般无需改 WXML。
4. 若新学科用新造型，按第六节 6.3 补 WXML 分支 + CSS。

---

## 八、数据安全与备份

- 数据默认存在本机（`wx.setStorageSync`），刷新/关页面不丢。
- 「每日计划」页首屏有 **导出 JSON / 导入恢复** 两个按钮，导入不限制条数。
- 清空示例数据、清空全部数据都有二次确认弹窗。
- 数据积累到 30 条时，页面顶部会温和提示导出备份。
- 配了云环境后，`syncData` 云函数按 `openid` 隔离上传下载，换设备可恢复。

---

## 九、自测方法

逻辑引擎 `utils/farmEngine.js` 是纯函数（不依赖小程序运行时），可用 Node 直接跑自测：

```bash
node /tmp/test_farm.js
```

脚本会模拟 `wx` 全局，覆盖：单科/三科奖励、三级惩罚、护盾抵挡、杀虫剂修复、
种植/生长/收获/商店、跨天顺延、预警文案。全部断言通过即代表联动逻辑正确。

> 改完 `config.js` 的奖惩参数后，建议重跑一遍自测确认行为符合预期。

---

## 十、语音发音（本地预生成音频）

> ⚠️ **重要前提**：微信官方「同声传译」插件**仅对企业主体小程序开放**，个人主体（备案的个人号）无法添加，
> 会报「主体类型不符合要求」。因此本程序**没有用插件**，改用「本地预生成 mp3」方案——
> 所有发音词由脚本用系统语音批量生成、直接打包进小程序，运行时播放。
> **个人号可用、离线可用、零成本、无配额限制。**

### 10.1 文件结构
- `miniprogram/assets/audio/*.mp3`：116 个发音文件（中文 56 + 英文 60，约 568K，主包总容量 892K，远低于 2MB 上限）。
- `miniprogram/utils/audioManifest.js`：自动生成的映射表（`"语言|内容" → 音频相对路径`），`tts.js` 据此播放。
- `miniprogram/utils/tts.js`：封装 `speak(content, lang)`，播放本地音频；找不到对应音频时降级为文字 toast。

### 10.2 重新生成音频（换音色 / 加词时）
1. 改 `miniprogram/utils/learnData.js` 增减内容（拼音/拼读/描红/字母/单词）。
2. macOS 上执行生成脚本（依赖系统 `say` 中文 Tingting / 英文 Samantha 语音 + `ffmpeg`）：
   ```bash
   node /tmp/gen_audio.js     # 重新产出 assets/audio + audioManifest.js
   ```
3. 导入开发者工具编译即可，无需任何插件或网络。

### 10.3 常用调用
```js
const tts = require('../../utils/tts.js');
tts.speak('苹果', 'zh_CN');   // 中文
tts.speak('apple', 'en_US'); // 英文
tts.stop();                  // 页面 onUnload 时调用，避免切页后仍在发声
```
- 音频为本地打包文件，首次进入即存在，不需联网，平板离线也能用。
- 朗读内容均为 1~4 字短文本；若某词没预生成，`tts.js` 会降级为「🔊 文字提示」toast（不会崩）。


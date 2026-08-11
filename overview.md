# 交付总览：语数英作业打卡小程序 + 联动农场小游戏

## 已完成内容

一个从零搭建的微信小程序，把「暑假作业打卡」和「卡通农场种菜」深度联动：
**写完作业 → 农场得阳光/种子、植物长大产金币；没写完 → 夜晚小狗熊入侵啃食、NPC 偷金币、作物枯萎。**

## 交付文件清单

**前端（miniprogram/）**
- `app.js / app.json / app.wxss` —— 全局逻辑、5 栏 tabBar、马卡龙主题
- `custom-tab-bar/` —— 自定义导航（作业未完成时农场栏亮红点）
- `pages/index` 每日计划｜`pages/checkin` 作业打卡｜`pages/stats` 学习统计｜`pages/errors` 错题本｜`pages/farm` 我的农场｜`pages/mall` 金币商城
- `utils/config.js` —— ★ 全局可调参数中心（改玩法主要改这里）
- `utils/farmEngine.js` —— ★ 农场核心联动引擎（奖励/惩罚/生长/结算）
- `utils/store.js` —— 统一数据层 + 跨页事件总线（数据实时互通）
- `utils/util.js` —— 日期/本地存储工具

**云函数（cloudfunctions/）**
- `initDB` 建集合｜`syncData` 上传下载｜`dailyReset` 每日 00:05 兜底结算（含 PUNISH 镜像）

**文档**
- `README.md` —— 图文教程：调小狗熊惩罚力度 / 改每日阳光奖励 / 自定义作物样式（含部署、联动逻辑位置、自测方法）

## 核心联动三处标记
- ① `config.js → REWARD`：写完作业发阳光+种子
- ② `config.js → PUNISH`：没写完触发惩罚（ENABLE 总开关）
- ③ `store.js` 事件总线：打卡页改动实时同步农场页

## 验证情况
- 全部 `.js` 通过 `node --check`，`.json` 通过解析校验
- `farmEngine.js` 用 Node 自测（`/tmp/test_farm.js`）覆盖奖励/三级惩罚/护盾/杀虫剂/生长/跨天顺延/预警，32 条断言全部 PASS
- 首次进入预置示例数据（昨天逾期作业 + 被啃植物），无空白首屏

## 改玩法最快路径
打开 `miniprogram/utils/config.js`：调惩罚改 `PUNISH`，改阳光改 `REWARD`，改作物颜色改 `SUBJECTS.color`；若改惩罚参数记得同步 `cloudfunctions/dailyReset/index.js` 的 PUNISH 镜像。

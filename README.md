# homework-farm（小小农场成长记）

> 微信小程序：一年级「作业打卡 × 卡通农场联动」+「全科导学工作台」（AI 导学 / 错题归因 / 复测证据 / 导学报告）+「学习单闭环」+ 网页只读看板。
> 奖惩全部由打卡完成情况自动驱动，零人工干预；AI 导学部分走云端 hy3，本地可降级。

---

## 一、当前架构（以 `app.json` / `cloudfunctions` / `miniprogram` 为准，本文档即真相源）

### 主包（4 个 tab）
| tabBar | 页面 | 作用 |
|--------|------|------|
| 成长乐园 | `pages/index/index` | 学科打卡入口（横向卡片）+ 今日导学任务 + 待订正提醒 |
| 每日打卡 | `pages/checkin/checkin` | 日/周/月打卡视图（由打卡类型驱动，不再写死三科） |
| 我的农场 | `pages/farm/farm` | 地块/仓库/商店/背包 + 小狗熊惩罚动画 |
| 我的 | `pages/mine/mine` | 备份导出、导学中心入口、类型管理入口 |

### 分包 `pkgGuide`（导学相关，9 页）
`tutor`（AI 导学对话）、`tutorHub`（导学中心聚合）、`report`（导学报告）、`retest`（复测证据）、`learnerProfile`（儿童画像）、`typeProfile`（题型画像）、`examGallery`（试卷库只读）、`speakstep`（演讲步骤，新增待提交）、`order`（学习单出单/回执）

### 分包 `pkgTools`（工具相关，8 页）
`schedule`（课表拍照/录入）、`mistakes`（错题本 + 订正）、`mistakes/confirm`（订正确认）、`plan`（成长计划 + 进度对照）、`webportal`（网页入口绑定）、`typeManage`（打卡类型管理）、`checkinDetail`（打卡详情 + AI 分析 + 拍照识别）、`unitSummary`（单元总结，新增待提交）

### 云函数（`cloudfunctions/`，15 个）
`initDB`（建集合）、`syncData`（按 openid 跨设备同步）、`dailyReset`（每日 00:05 兜底结算惩罚）、`ocrSchedule`（课表拍照识别）、`analyzeComment`（学习记录评语）、`aiRoleAnalyze`（**语文/数学角色分析，活功能**）、`studyPlanGen`（AI 生成成长计划）、`tutorChat`（导学对话 + 归档 + E1–E9 归因）、`tutorRetest`（复测生成 + 证据判定）、`tutorOrder`（学习单出单/回执状态机）、`tutorSync`（导学数据同步）、`webAdminQuery`（网页看板只读查询）、`webAdminWrite`（网页看板写，仅 orders）、`webPortalBind`（网页绑定）、`webVisionConfig`（视觉识别配置）

---

## 二、核心机制

- **打卡 × 农场联动**：`utils/farmEngine.js`（纯函数，551 行）+ `utils/config.js`（参数中心）。奖励/惩罚/生长/结算全在 config 调参，详见旧版 README 的奖惩教程思路（参数位置未变）。
- **打卡类型系统**：内置语数英 + 家长自定义类型（`utils/store.js` 的 `checkinTypes`），农场/统计全由类型列表驱动。
- **全科导学闭环**：画像 → 计划 → 打卡/导学 → 错题(E1–E9) → 复测(≥5题且≥80%) → 报告。守「活动 ≠ 证据 ≠ 掌握」契约（掌握/完成由人确认，AI 不自动判定）。
- **学习单闭环 `order-kit`**：`order-kit/orderKit.js` 为 canonical，经 `scripts/sync-order-kit.mjs` 生成 9 份副本（小程序 + 4 云函数 + 工作台），`scripts/test-order-kit-sync.cjs` 用 sha256 锁一致性。**禁止手改任一份副本**。
- **数据持久化契约 R1–R7**：落盘与上云解耦；上云不可静默放弃（脏标记 + 退避）；下拉只补缺；字段只增不改不删；云端→本地只写黑名单（绝不白名单）。

## 三、合规红线（个人主体小程序，审核高风险区）

- 不录音 / 不采个人信息 / 无支付 / 无陌生人社交。
- UI 文案规避「学习 / 作业 / 教育 / 培训」：统一用「导学报告 / 导学数据 / 导学证据 / 打卡」等词。
- ⚠️ 已知漏红：部分边缘错误文案仍含「学习分析」等词（见 `miniprogram/pkgTools/checkinDetail/checkinDetail.js` 第 523 行附近），待修。

## 四、部署纪律

- **云函数**：用 CloudBase MCP `manageFunctions` 部署；部署后必须 `invokeFunction` 空参自检（`tutorSync→no_openid`、`tutorRetest→bad_subject`、`ocrSchedule→no_vision`）。
- **网页看板**：`web/index.html` 是 1.4MB 内联单文件、无构建。改动必须三步：① 改 `web/index.html` → ② 传云函数 `tutorOrder`/`webAdminWrite`/`webAdminQuery` → ③ 传静态托管 `manageHosting(index.html)`。改后必跑 `scripts/check-gateway-route.sh` 核对网关路径。
- **私钥**：`private.key`（miniprogram-ci 上传密钥）已在 `.gitignore`，且 `scripts/upload.js` 依赖其位于仓库根，勿移动、勿提交。

## 五、开发 / 测试

```bash
npm test            # 核心 17 脚本回归（store/tutor/order 等）
npm run test:orders # 学习单闭环全链路（含 order-kit-sync 反证）
node scripts/test-order-kit-sync.cjs   # 改动 orderKit 后必跑；已挂 pre-commit 守卫
node scripts/smoke_schedule.js          # 课表冒烟
```

全量回归基线 **1168+ 项 / 16 脚本 / exit 0**（见工作记忆与 `上线前流程验证清单.md`）。

## 六、文档一致性说明

- 本 README 以代码现状为真相源，取代早期「三科 + 商城 + 5 栏 tabBar」的旧描述（已失效）。
- 历史演进与决策见 `overview.md`、`实践过程.md`、`数据持久化审计报告_2026-09-18.md`、`学习单闭环设计_出单-回执.md` 等根目录文档。
- 失活的历史预览/审查快照已归档至 `_attic_trash/`（原件仍在 git 历史，可恢复）。

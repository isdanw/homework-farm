# student-study（k12-guidance-workbench）项目全景说明

> 版本基线：HEAD `895492b`（2026-09-21）· package.json `2.0.5` · 本文档所有结论均经源码逐条核验
> 用途：供他人或大模型快速建立对本项目的整体认知

---

## 一句话定位

`student-study` 不是完整的"自主导学"系统本体，而是其中**只读的工作台/看板端**：仓库名 `k12-guidance-workbench`，正式名称「K1–K12 全学科导学工作台（降噪全科导学系统）」。仓库内没有出现「自主导学」四个字；系统的"教学大脑"（专家提示词 + 家庭学习库）在仓库外的同级工程「全学科导学体系」，写入端在 `homework-farm` 微信小程序与云函数。

## 定位与设计理念

- **解决的问题**：学习过程发生在导学对话里，产出散落在云端和 Markdown 目录；家长看不到结构化画像，孩子也看不懂专业术语。工作台把这些档案渲染成**孩子能看懂、家长能决策**的界面。
- **面向**：K1–K12 家庭，双视角——孩子只看「今日 / 任务 / 训练」3 页；「档案 / 记录 / 系统」归家长。孩子模式只读，点「开始」只打开行动抽屉，不写云也不写本地完成状态（真实完成在小程序端打卡）。
- **产品红线（本项目最有辨识度的设计）**：**活动 ≠ 证据 ≠ 掌握**。任务完成、复习完成、订正完成都只生成"活动记录"；学科状态只能由规则派生，禁止把"做过了"写成"学会了"；文案禁写「已掌握 / 已精通」，由语言门禁脚本（`archive-language-gate.mjs` / `growth-language-gate.mjs`）直接阻断。
- **技术栈刻意极简**：Vite 5 + TypeScript 5 + 原生 DOM（无 UI 框架）+ Vitest 2；端到端用 playwright-core 自写脚本；云端用 CloudBase JS SDK；本地挂了一个 PDF 解析中间件（`@firecrawl/pdf-inspector`，`/api/pdf-inspector`）用于试卷登记。

## 模块与目录结构

当前实际是 **6 个一级页面**（`src/main.ts` 的 renderers：today / tasks / training / archive / records / system）。历史文档里写的 9 页、11 页是旧信息架构，已被收敛（报告并入档案，时间轴/成长/测验等降为页面内 section）。

| 模块 | 实际内容 | 关键落点 |
|---|---|---|
| 今日 | 推荐行动、继续上次、复习窗口、孩子视角「你做过的事」复述 | `src/pages/today.ts`、`src/sections/timelineSection.ts` |
| 任务 | 7 类场景入口（看不懂/没思路/复习/自查/错题复盘/拍照录题等）→ 任务配置抽屉 → 三段式提示词**复制**给对话侧 | `src/pages/tasks.ts`、`src/components/handwrittenGuide.ts` |
| 训练 | 学科学习工作台（按章节发起预习/复测/变式/单元测验）+ 错题按学科分组 + 结构化复测抽屉 + 试卷登记 | `src/pages/training.ts`、`src/sections/subjectLearningSection.ts`、`src/components/examRegister.ts` |
| 档案 | 阶段性学习分析报告（趋势/错因/复测/处方），明确"不代表对能力的最终判断" | `src/pages/archive.ts` → `src/sections/reportSection.ts` |
| 记录 | 5 个 Tab：错题本 / 学习记录 / 复测记录 / 证据 / 导学纠错；含证据阶梯、校准观察、成长观察 | `src/pages/records.ts` |
| 系统 | 数据源状态、云端直连（口令·只读·实时）、孩子/家长密码、备份/导出为受控演示态 | `src/pages/system.ts`、`docs/云端直连只读说明.md` |
| 逻辑层 | 状态派生、证据阶梯、复习区间、角色门禁、校准、前置缺口、多孩、教材大纲聚合等 **17 个纯函数模块** | `src/logic/*` |
| 适配器 | 5 种数据源：`auto`（本地快照）/`synthetic`/`fixture`/`readonly`/`cloud`，外加 `version_incompatible` 错误态；云端载荷映射与九科键归一 | `src/adapters/*` |
| 工程保障 | 类型检查、418 个单测、离线审计（页面×场景矩阵）、契约审计、语言门禁、e2e、CI | `tests/`、`scripts/`、`reports/`、`.github/workflows/ci.yml` |

## 数据模型：什么算"掌握"，证据如何产生和记录

**先说结论：系统不计算"掌握度"**，这是明写的红线，不是没做完。对外最高口径只有「有可验证证据」，从不输出百分比、遗忘率或"已掌握"结论；历史档案里的 `mastery`、`VERIFIED` 字段被映射层**显式阻断**，永不展示。

1. **统一快照契约**（`snapshot-adapter-contract-v1` / `snapshot-v1`，定义于 `src/adapters/snapshotContract.ts`）：`learnerConfig`、`subjectProfiles`、`tasks`、`learningActivities`、`mistakes`、`reviewSchedules`、`assessments`、`evidence`、`records`、`systemInfo` 十类，另有可选的 `curriculum`（教材大纲树）、`flows`（断点续接）、`examResources`、`quality`。
2. **九科稳定机器值**：`mathematics / chinese / english / physics / chemistry / biology / history / geography / politics`；小学科固定中文标签，信奥/竞赛被明确隔离在外。云端用 `math`、本地用 `mathematics`，映射层有归一表，否则数学会凭空消失。
3. **学科状态 5 态**：未选择 / 已建档无记录 / 待复测或待处理 / 证据不足 / 有可验证证据（`task_completed` 只是任务徽章，不参与学科状态）。判定是纯函数：有待复习或待处理错题 → 待处理；有证据 → 有可验证证据；只有活动 → 证据不足。
4. **证据门槛（双端同一套硬编码）**：复测必须 **≥5 题且通过率 ≥80%，且为孩子独立完成（`supportLevel=demonstration` 即看答案完成不算）**，才生成 `verifiable_evidence`；题量 <5 只算热身，不计证据。
   - 工作台侧：`src/logic/activityLog.ts` 的 `RETEST_EVIDENCE_RULE = { minItems: 5, minPassRate: 0.8 }`。
   - 云端侧：`homework-farm/cloudfunctions/tutorRetest/index.js` 的 `RETEST_COUNT = 5`、`PASS_RATE = 0.8`，仅 `pass=true` 才写 `tutor_evidence`。
5. **证据阶梯 L0–L6**：无记录 → 有学习活动 → 有订正证据 → 独立提取达标（复测达标且独立完成）→ 间隔后稳定（首末两次达标间隔 ≥7 天）→ 变式迁移 → 多情境稳定。文案按学科组（理科/语言/文综）差异化；**语言类没有 `transfer_attempt` 结构化记录时封顶 L4**（写作运用证据尚未结构化采集）。它明确被定义为"证据覆盖程度，不是能力等级或掌握百分比"。
6. **复习计划**：`interval-v2` 区间制（概念 1/3/7/14/30 天、程序 1/2/5/10/21 天、表达 7/14/30 天；独立达标后间隔 ×1.5、上限 90 天），只给**建议窗口**，附免责声明，不做遗忘预测。
7. **证据怎么产生和记录**（端到端）：
   - 云端写入侧：`homework-farm` 的 `tutorChat`（CloudBase 内置模型 hy3）完成导学对话并结构化归档，`tutorRetest` 判分并按 ≥5/≥80% 写 `tutor_evidence`。
   - 文件侧：对话侧把记录写进「全学科导学体系/家庭学习库」的 `04-evidence` Markdown，**frontmatter 是成绩权威**，正文数字只是人读回显。
   - 读取侧：快照构建器（`scripts/build-workspace-snapshot.ts`）解析 frontmatter 生成 `evidence[]`；工作台云直连（`src/adapters/cloudSnapshot.ts`）只把 `passed === true` 的行放进 `evidence`，未通过只进 `assessments`；缺 id 或缺学科的行直接丢弃并计入 `quality.warnings`，不造占位行。
   - 展示侧：记录页「证据」Tab、档案页证据墙、训练页复测抽屉共用同一数据源；`derived` 的学科状态不写回任何证据。

## 角色与门禁

- 孩子视角可见页恰为 `CHILD_ROUTES = ['today','tasks','training']`，家长专属 `PARENT_ONLY_ROUTES = ['archive','records','system']`；两集合恰等于导航全集，由 `tests/roleView.test.ts` 锁死。
- 三层门禁：L1 路由层（`canAccessRoute`，fail-closed，未知路由一律拒绝并重定向回「今日」）+ L2 导航层 + L3 内容层（各页自行裁剪）。
- 孩子→家长切换需家长密码（默认 `jiangzao`，可在系统页修改）；家长→孩子免密。

## 完成度与缺口

**实测基线（干净 checkout，未改任何源码）**：`tsc --noEmit` 0 错误；单测 **409 passed / 9 skipped（共 418）**——在带同级「全学科导学体系」工程的环境为 418 全过，跳过的是跨工程迁移用例（被测脚本属仓库外工程，单独克隆时明确跳过，不静默绿）；`npm run build` 成功，主包 291.43 kB。仓库自带的 2026-09-21 离线审计（`reports/offline-audit.latest.md`）为：e2e 97/97、6 页面×5 场景 = 30 单元全绿、9 学科×6 页面 = 54 单元、九科闭环 9/9、errors=0；CI 只跑 typecheck + vitest + build。

**已实现（有代码）**：六页信息架构、孩子/家长三层门禁、云端直连只读、五类适配器与降级态、记录页五 Tab、证据阶梯、interval-v2 复习、教材大纲聚合、多孩切换提示词、试卷登记与本地 PDF 解析、语言门禁与离线审计。

**明显缺口 / 风险（按重要性）**：

1. **没有"自主"闭环**：工作台不调用任何 Agent/solver，也不自动写回。任务页只生成提示词让家长复制到 WorkBuddy 对话执行，再由对话侧归档、重建快照或从云端读取。UI 内部没有真正的"一问一答→判分→归档"自动链路，关键一环仍靠人工粘贴。
2. **真实数据门禁仍关着**：`realDataGate = waiting_for_human_input`；只读试运行需要人工确认 A1–A7（单文件、已去标识化、授权记录等），目前未走 `snapshot:preflight`。与此同时，云端直连（口令·只读）是另一条已可用的真实数据通道——两条轨道并存，容易被误读为"已经接入真实数据"。
3. **仓库自带的真实快照几乎是空的**：`public/data/workspace-snapshot.json` 元数据显示 `dataNature=real_readonly`，但只有 3 个学科（数学、语文、英语）、**0 条活动、0 条错题、0 条证据**，年级为一年级。默认 `auto` 模式打开看到的是"有档案、无记录"；有意义的学情必须在系统页填口令走云端。
4. **云端映射落后于小程序，且落后还在扩大**：工作台 `CloudSyncPayload` 只声明 profile/sessions/mistakes/evidence/reviews/exams 六类，而小程序侧 `webAdminQuery(module:'sync')` 已返回 7 类数据——profile（内嵌成长计划 `studyPlans`）+ sessions/mistakes/reviews/evidence/exams + **cards（闪卡）**；学习单（orders）则更彻底：sync 根本不返回，它是独立的 `module:'orders'`，且工作台 `cloudClient` 的可用模块集合是 `overview|farm|tutor|profile|sync|exams`，**压根没有接 orders**。结论：闪卡、成长计划、学习单在工作台均不可见；且小程序侧 sync 形状晚于工作台 HEAD 仍在演进（studyPlans 下发为 2026-09-28 增补），映射差距还在扩大。
5. **e2e 不在 CI**：需要手工起 `npm run preview`，且依赖 `@firecrawl/pdf-inspector` 的平台原生绑定（`npm ci --include=optional`，装完还必须重启服务），否则会掉到 94/97。本地验证环境的脆弱点是已知的。
6. **文档与代码漂移**：`IMPLEMENTATION.md` 仍含 9 页时代描述（§11.13 的真实数据门禁描述仍有效）、`.workbench-agent/current-state.json` 的矩阵口径仍是 `9 pages×5 scenarios=45`（现为 6 页）；`docs/工作台功能提升方案-V2.1.md` 状态仍是"待确认 → 执行"，其中"错题生命周期轨迹 / 老化提示 / 记录搜索"在代码中 grep 无命中（记录页纠错 Tab、教材大纲、多孩等批次已落地）。README 与 package.json 版本一致（均为 2.0.5），此处无漂移。
7. **合规与隐私**：仓库为私有且**含真实未成年人学习者称谓/编号**，LICENSE 为"版权所有 © 2026 yiyo（GitHub: @isdanw）·非开源·保留所有权利"，未脱敏前不得转 public；真实姓名被映射层阻断，但源文件里仍有痕迹。
8. **覆盖范围**：九科只做到 synthetic 演示闭环与教材大纲骨架，地理/道法标注为"可灰度验收"而非完整真实内容验证；信奥/竞赛刻意不接入。

## 关系厘清

- **student-study ↔ homework-farm：同一系统的"读端"与"写端"**，不是两个平行项目。证据：两者使用同一个云开发环境 `workbuddy-d2gsgtfvmde5c9adf`；工作台的云端客户端（`src/cloudClient.ts`）调用的就是 `homework-farm/cloudfunctions/webAdminQuery` 的 `module:'sync'`；口令通过 `web_portal_bindings` 反查 openid，只读。`homework-farm` 是微信小程序「小小农场成长记」（打卡×农场）＋ 15 个云函数，负责生产数据；`student-study` 只消费它的云函数，不读它的源码。
- **student-study ↔ 全学科导学体系**：后者才是"导学大脑"（WorkBuddy 专家包 SKILL.md + 家庭学习库 Markdown + 契约），不在本仓库里。工作台的 `scripts/build-workspace-snapshot.ts`、迁移测试、语言门禁都直接指向同级目录 `../全学科导学体系`。所以"自主导学"如果指的是完整系统，`student-study` 只是其中一块可视化面板。
- **与 Coze 导学 Bot / 小智**：**仓库内均未见证据**（全仓 grep 未出现 Coze / 扣子 / 小智）。实际 AI 调用链是：云函数 → **CloudBase 内置 AI 模型 `hy3`**（`tutorChat`、`tutorRetest`、`analyzeComment`、`studyPlanGen`、`aiRoleAnalyze`），导学内容资产源自 WorkBuddy 专家包（工作台只登记路由，明确"不调用"）。请不要把 Coze/小智写进这条链路，除非另有仓库外证据。

## 证据文件路径清单

**student-study（工作台本体）**
- `README.md` — 定位、双视角、语义红线、本地实测基线（v2.0.5）、隐私声明
- `package.json` — 版本 2.0.5、全部脚本入口
- `src/main.ts` — 6 个路由、adapter 选择、云端异步取数
- `src/types/contract.ts` — 九科、5 态、E1–E9 错因、复测四类目、证据/活动类型
- `src/logic/activityLog.ts` — `RETEST_EVIDENCE_RULE`（≥5 题且 ≥80% 且独立完成）、任务完成只生成活动
- `src/logic/subjectStatus.ts` — 学科状态派生（不产生掌握）
- `src/logic/evidenceLadder.ts` — L0–L6 证据阶梯、学科组变体、语言类 L4 封顶
- `src/logic/reviewSchedule.ts` — interval-v2 区间制、×1.5 自适应、90 天上限、免责声明
- `src/logic/roleView.ts`、`tests/roleView.test.ts`、`docs/孩子家长双视角分层.md` — 三层门禁与可见页集合
- `src/adapters/snapshotContract.ts` — 快照十类数据结构 + 契约版本号定义
- `src/adapters/cloudSnapshot.ts` — 云端→契约映射、九科键归一、只收 `passed === true` 证据
- `src/cloudClient.ts`、`src/cloudToken.ts` — 云端只读取数（模块集合 overview|farm|tutor|profile|sync|exams）与口令管理
- `src/pages/records.ts` — 5 Tab（错题本/学习记录/复测/证据/纠错）
- `src/pages/training.ts`、`src/pages/archive.ts`、`src/sections/reportSection.ts` — 训练与阶段分析
- `scripts/build-workspace-snapshot.ts` — 家庭学习库 Markdown → 快照；证据 frontmatter 权威与规则复核
- `scripts/archive-language-gate.mjs`、`scripts/growth-language-gate.mjs` — "已掌握"类文案阻断
- `public/data/workspace-snapshot.json` — `dataNature=real_readonly`，3 学科 / 0 条记录 / 一年级
- `reports/offline-audit.latest.md` — 当前权威验证基线（418 单测、97/97 e2e、30+54 矩阵、构建 291.43 kB）
- `IMPLEMENTATION.md` §7、§11.13 — 未接入能力、真实数据门禁、仓库自包含修复
- `docs/READONLY_PILOT_CHECKLIST.md` — 真实数据 A1–A7 授权清单
- `docs/云端直连只读说明.md` — 三种取数方式与映射口径
- `REAL_SOURCE_MAPPING.md` — 31 个字段已映射、5 个字段（姓名/历史掌握度/VERIFIED 等）被阻断
- `docs/工作台功能提升方案-V2.1.md` — 仍待执行的提升项
- `.workbench-agent/current-state.json` — 已过时的状态文件（9 页时代，矩阵口径 9×5=45）

**homework-farm（写入端，仅作关系核对）**
- `README.md` — 小程序结构、15 个云函数清单
- `cloudfunctions/webAdminQuery/index.js` — `sync` 模块返回 7 类数据（含 cards；studyPlans 内嵌 profile；orders 为独立模块，sync 不返回）
- `cloudfunctions/tutorRetest/index.js` — `RETEST_COUNT=5`、`PASS_RATE=0.8` 硬编码证据契约，仅 pass=true 写 `tutor_evidence`
- `cloudfunctions/tutorChat/index.js` — hy3 导学对话与归档
- `miniprogram/app.js` — `ENV_ID: 'workbuddy-d2gsgtfvmde5c9adf'`，与工作台同环境
- `全科导学嵌入小程序方案.md` — WorkBuddy 专家资产迁移到小程序/云函数的原始设计

## 本次修订说明（相对上一版）

1. 更正：README 版本实为 v2.0.5，与 package.json 一致，原"README 写 V2.0.6"为误。
2. 更正：`src/logic/*` 为 17 个模块，非 22 个。
3. 更正：orders（学习单）不在 `module:'sync'` 返回中，是独立模块且工作台未接入——缺口 4 的机制描述已修正，结论不变。
4. 移除：构建 gzip 106.82 kB / 云端分包 768.92 kB 两个无法在仓库内复核的数字，保留可验证的 291.43 kB。
5. 新增：角色与门禁一节（CHILD_ROUTES/PARENT_ONLY_ROUTES、三层门禁、家长密码）。

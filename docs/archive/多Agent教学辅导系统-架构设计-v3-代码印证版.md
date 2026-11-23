# 多 Agent 教学辅导系统 · 架构设计 v3（代码印证与增补版）

> 日期：2026-10-28  
> 状态：已完成只读代码核验，设计增补，尚未实施。  
> 与 v2 的关系：保留 v2 的 5 项产品决策与“规则主系统 + Agent 增强层”路线；与 v2 冲突处以此文为准，理由逐条给出。  
> 基线：当前工作区源码（含未提交 WIP）。未连接线上数据库，未运行云函数；所有“现状”判断均来自源码，部署态需另行核验。  
> 核验范围：`miniprogram/`、`cloudfunctions/`、`app.json`、`cloudbaserc.json`、`scripts/mock-tcb.js`，以及 v1/v2 设计文档与全景说明。

---

## 0. 一页结论

v2 的方向是对的，三处 P0 判断也成立：**孩子归属缺失、证据不是单写者、家长角色门禁不存在**。但 v2 仍不足以直接开工，主要遗漏集中在“事实面比 v2 假设的更宽”和“现有能力比 v2 假设的更多”两端。

| 结论 | 说明 |
|---|---|
| 方向成立 | 逻辑 Agent、单轮结构化输出、规则兜底、家长只审批关键动作，均应保留 |
| v2 的 P0 成立 | `childId`、证据单写者、权限收口三项必须先做 |
| v2 的 P0 范围偏窄 | 多孩缺口不止 `tutor_*`，还包括打卡日志、每日结算、农场事件、试卷提交 |
| v2 低估了现有能力 | 家长口令 `web_portal_bindings` 已存在，并与 iPad 绑定共用；精力条/课表也已存在 |
| v2 高估了页面可用性 | `examGen/examAnswer/examReport` 页面存在但未注册，`examGallery` 的跳转目前是断的 |
| v2 的动作契约不准确 | `start_tutor` 不接收 `mid`，`review_cards` 不接收 `subject`，`new_lesson/blindsweep/practice` 没有对应动作 |
| v2 缺少归因主键模型 | 只有 `recommendationId` 不够，还需要曝光/点击/开始/完成事件与稳定 ID |
| v2 的计划刷新过于激进 | 每完成一条就改 `stateHash` 并重生成整份 dayPlan，会打散未完成推荐、破坏归因 |
| 上线硬门槛 | 零跨孩子串数据、零证据旁路、零 Agent 直接写事实、零未注册路由、零未授权家长动作 |

**最危险的三个问题（按修复顺序）：**

1. 多孩事实没有稳定归属，且 `dailyReset` 只结算“当前孩子”——Agent 看到的“今日状态”本身可能是错的。
2. 证据仍有至少四条写入路径，且复测题在生成时把标准答案发给了客户端——“独立作答”目前不可验证。
3. 家长口令已存在但被当成不存在；同时学习单页没有角色门禁，孩子可以自己出单。

---

## 1. 核验方法与边界

- 只读核查源码，不修改任何现有文件；`git status` 显示当前工作区含未提交改动，因此行号以当前工作区为准。
- 未连接线上 CloudBase，未读取真实集合；集合是否存在、索引是否存在、云函数是否已部署，均需上线前再核。
- 本文把“设计缺口”和“代码缺陷”分开写：前者是 v2 没写清，后者是 v2 没点名但代码里已经存在的风险。
- 证据格式：`文件:行号`。行号只用于定位，不保证未来重构后仍不变。

---

## 2. v2 论断逐条印证

| # | v2 论断 | 代码证据 | 判定 | 需要补充/修正 |
|---|---|---|---|---|
| 1 | 导学本地数据只按 openid 隔离 | `miniprogram/utils/tutorStore.js:61-64`；`cloudfunctions/tutorSync/index.js:96-122` | 成立 | 缺口范围更大，见 §3.1 |
| 2 | 复测硬编码 ≥5 题、≥80% | `cloudfunctions/tutorRetest/index.js:117-121` | 成立 | 阈值本身可保留 |
| 3 | 判分信任客户端回传题目与答案 | `cloudfunctions/tutorRetest/index.js:170-203` | 成立 | 生成阶段还把答案下发给客户端，见 §3.2 |
| 4 | `tutorSync`/`webAdminWrite` 可写 `evidence.passed` | `tutorSync/index.js:340`；`webAdminWrite/index.js:114-118` | 成立 | 还有客户端本地 `addEvidence`，见 §3.2 |
| 5 | `evidenceClientId` 主入口漏接 | `tutorRetest/index.js:224-232`；`retest.js:142` | 成立 | 客户端确实发了，是服务端没接 |
| 6 | `Object.assign({openid}, doc)` 可被客户端覆盖 | `tutorSync/index.js:213-223,340`；`webAdminWrite/index.js:184` | 成立 | 两个函数都没剥离 `openid/_openid` |
| 7 | `tutorGate` 只检查绑定/孩子/计划 | `miniprogram/utils/tutorGate.js:48-63` | 成立 | 学习单页甚至没调用它，见 §3.5 |
| 8 | 没有 `recommendationId` | 全仓检索为 0 | 成立 | 还缺曝光/点击事件，见 §4.1 |
| 9 | `cards.done` 不能当掌握 | `tutorStore.js:581-588`；`webAdminQuery/index.js:19,276` | 成立 | 现有盲区诊断和看板文案正在这么做，见 §4.5 |
| 10 | `webAdminQuery` 全量扫描聚合 | `webAdminQuery/index.js:53-68,228-236` | 部分成立 | 有 4000 条封顶、按 openid 过滤，但仍是整集合聚合，不能做高频读 |
| 11 | 家长角色门禁前提不存在 | `tutorGate.js:48-63`；`webPortalBind/index.js:40-58` | 部分成立 | 网页端已有口令体系；小程序端没有会话，见 §3.4 |
| 12 | 没有 20:30 夜间定时器 | `cloudfunctions/dailyReset/config.json` | 成立 | 目前只有 00:05 的 `dailyReset` |
| 13 | 复测页参数是 `subject/key、topic、errorType、mid` | `retest.js:34-40` | 成立 | 还要加 `recommendationId/childId` |
| 14 | `actionRef.route` 存在假路由风险 | `miniprogram/app.json:8-40`；`examGallery.js:151-170` | 成立 | 现有三个试卷页未注册，见 §3.6 |
| 15 | 计划 vs 实际缺关联键 | `orderKit.js:201-209`；`studyPlan.js:1-22` | 成立 | 已有报告→计划反哺，但无推荐关联，见 §4.9 |
| 16 | 90 天只清理 Agent 运行日志 | 无对应代码 | 成立（设计项） | 需同时做 current 文档压缩 |
| 17 | 首页 `onShow` 读取当日计划缓存 | `pages/index/index.js:44-51` | 不成立（是待建） | 当前首页不拉云端、不读计划文档 |
| 18 | 三科合计 3–5 条 | 无对应代码 | 设计约束 | 需要落到 Policy Engine 的硬上限 |

---

## 3. P0 遗漏（不做完不能接 Agent）

### 3.1 多孩缺口不止 `tutor_*`：打卡、结算、农场也按“当前孩子”处理

v2 把 `childId` 的改造范围写成“本地存储、`tutor_*`、试卷提交、网页查询”。但 Agent 的“今日状态”还依赖打卡、结算和农场，而这些数据同样没有稳定归属。

**代码证据：**

- `cloudfunctions/syncData/index.js:36-40` 取 `users.find(id===currentUserId) || users[0]`，只把“当前孩子”的作业写成 `hw_checkin_log`。
- `syncData/index.js:172-184` 写入的日志行只有 `_openid/date/chinese/math/english/coins/bears`，**没有 `childId`**。
- `cloudfunctions/dailyReset/index.js:48-52`、`78` 同样只取 `currentUser(root)`；一个家庭有多个孩子时，只有当前被选中的孩子会被结算、清空当日作业、推进 `settledDates`。
- `dailyReset` 写入的 `hw_farm_settle` 也只有 `_openid/date/level/...`，没有 `childId`。
- `hw_farm_events` 在 `syncData/index.js:58` 有 `childId`，但它是可选字段，埋点调用方不保证传。

**影响：**

- 孩子 A 的打卡率、结算记录、农场惩罚会被算到 openid 级，孩子 B 的 Agent 可能读到 A 的事实。
- 如果家长不切换 `currentUserId`，孩子 B 的当日作业不会被 `dailyReset` 清空，第二天的“今日计划”会基于脏状态。
- “多孩隔离”只修 `tutor_*` 仍然过不了验收。

**修正：**

1. `hw_checkin_log`、`hw_farm_settle`、`hw_farm_events` 全部增加 `childId`，写入时必须由服务端解析，不接受客户端直接指定。
2. `syncData` 的 `logEvent` 与打卡日志按“遍历 `users[]` 中当日有数据的孩子”写，而不是只写当前孩子。
3. `dailyReset` 改为遍历 `root.users[]`，对每个孩子独立结算；保留每孩子 CAS，避免整份根文档写冲突。
4. 旧日志没有 `childId` 时进入“待确认历史数据”，不得按当前孩子回填。
5. 增加测试：同一 openid 两个孩子，各自打卡/结算/日志互不污染。

### 3.2 证据写入口清点不全：客户端本地也在写，复测还下发答案

v2 列了 `tutorSync`、`webAdminWrite` 两条旁路，但证据的真实写入路径至少有四条：

| 路径 | 证据 | 问题 |
|---|---|---|
| 客户端本地写入 | `tutorStore.js:346-363`；`retest.js:154` | `addEvidence` 直接把 `passed` 写进本地，并登记上云队列；即使云端关了旁路，本地仍会“造证据” |
| 复测判分写入 | `tutorRetest/index.js:185-203` | 判分依赖客户端回传的 `questions[].answer`，客户端可自造题、自造答案 |
| 生成阶段泄露答案 | `tutorRetest/index.js:111-113` | `generate` 返回的 `questions` 含 `answer` 和 `analysis`，作答时答案就在客户端 |
| 工作台/同步写入 | `tutorSync/index.js:340`；`webAdminWrite/index.js:114-118` | 可写 `passed`，绕过复测入口 |

另外，`tutorRetest/index.js:224-232` 的 `input` 没有 `evidenceClientId`，所以 `clientId` 恒为空字符串；`tutorSync` 的旧数据“认领”逻辑（`tutorSync/index.js:310-336`）又会按业务键给无 `clientId` 的证据补一个 `clientId`——这等于**自动猜测证据归属**，与 v2 §6.1 “历史数据不得自动猜测归属”直接冲突。

**修正：**

1. 新增 `tutor_retest_attempts`：`generate` 在服务端保存题目、标准答案、孩子、推荐、提示事件、过期时间；只向客户端返回不含答案的题目与 `attemptId`。
2. `submit` 只接收 `attemptId+answers+independenceDeclaration+childId+recommendationId`；服务端读标准答案判分。
3. `tutor_evidence` 只允许复测领域服务写；`tutorSync/webAdminWrite` 删除 `passed` 字段写权限；客户端 `addEvidence` 改为只读服务端结果。
4. 删除 `tutorSync` 的“按业务键认领旧证据”逻辑；历史数据由家长一次性确认归属，而不是自动补 `clientId`。
5. 一次推荐只允许一个进行中的 attempt；同一 `attemptId` 重放返回同一结果，不重复写证据。
6. 测试必须覆盖：客户端伪造 `questions/answer`、重复提交、篡改 `attemptId`、跨孩子 `attemptId`、答案是否出现在 `generate` 响应中。

### 3.3 空 openid 写入：`tutorChat` 与 `tutorRetest` 没有守卫

v2 在 P0 里写了“空 openid 不可写”，但只点名了 `tutorSync/webAdminWrite`。实际还有两个写入函数没有守卫：

- `cloudfunctions/tutorChat/index.js:779` 取 `openid = event.userInfo.openId || ''`，没有空值拒绝；`archive()` 在 `647-745` 直接用这个 `openid` 写 `tutor_sessions`/`tutor_mistakes`/`tutor_reviews`。
- `cloudfunctions/tutorRetest/index.js:221` 同样没有空值拒绝；`judge()` 在 `170-203` 写 `tutor_evidence`，`openid` 可能是空串。

**影响：** 产生无主数据，后续任何按 openid 的查询都读不到，但集合里会持续堆积；也会干扰“同一份证据”的去重和统计。

**修正：** 所有写入口统一经过 `ScopeGuard`：`openid` 为空直接 `no_openid`，不创建任何集合/文档；`childId` 必须属于该 openid 的 `users[]`。

### 3.4 家长凭证已经存在，但 v2 当成不存在

v2 §8 写“新增家长 PIN 或等效凭证”，但网页端已经有一套口令体系：

- `cloudfunctions/webPortalBind/index.js:40-58`：为每个 openid 生成 24 字节 hex 令牌，写入 `web_portal_bindings`；已有未撤销令牌时直接复用，不轮换、不过期。
- `cloudfunctions/webAdminQuery/index.js:637-672`：请求带 `token`，先比对 `WEB_DASHBOARD_TOKEN`（管理员），否则查 `web_portal_bindings` 反查 openid。
- `cloudfunctions/examService/index.js:2581-2596`：iPad 绑定也复用同一个 `web_portal_bindings` 令牌，写入 `exam_account_link`。

**问题不是“没有凭证”，而是凭证模型不够：**

| 问题 | 证据 | 影响 |
|---|---|---|
| 长期有效、无过期 | `webPortalBind` 只在撤销时失效 | 截图/二维码泄露后长期可用 |
| 明文存储 | `webPortalBind` 直接存 `token` | 数据库泄露即全部失守 |
| 一个令牌多用途 | 网页看板 + iPad 绑定共用 | 为绑定设备而交出看板权限；设备丢失无法单独撤销 |
| 无频率限制/锁定 | `webAdminQuery` 只比对 token | 可被暴力尝试（虽然 24 字节空间很大） |
| 小程序端没有家长会话 | 全仓无 `parentSession/PIN` | “家长日报”“家长签发”没有可验证的 actor |

**修正：**

1. **不要新建一套平行口令。** 复用 `web_portal_bindings`，但拆成两类：
   - `portal_session`：网页看板用，短/中期有效，服务端存 `sha256(token+salt)`，支持轮换、撤销、`lastUsed`。
   - `device_bind_token`：iPad 绑定专用，只能调用 `bind`，不能读看板。
2. 小程序端新增 `parentSession`：由家长 PIN 或“在小程序内确认”换取，30–60 分钟有效，只允许家长动作（日报、出单、作废、改计划、开关科目）。
3. `actor` 不再由客户端字段声明：有有效 `parentSession` 才是 `parent`，只有 openid 是 `child`，定时器是 `system`。
4. 令牌只存哈希，深链/二维码里只放一次性交换码，不放长期令牌。
5. 测试：过期、撤销、跨 openid 重放、iPad 令牌越权读看板、暴力 PIN 锁定。

### 3.5 角色门禁与家长动作：孩子可以自己出学习单

- `tutorGate.js:48-63` 只判断“已绑定 / 有孩子 / 有成长计划”，不区分家长和孩子。
- `miniprogram/pkgGuide/order/order.js:84-90` 的 `onLoad` 只调用 `refreshAll()`，没有 `tutorGate`，也没有家长校验。
- 出单时 `orderActions.js:182,385` 的 `by` 来自客户端参数，服务端没有把它和凭证绑定。

**影响：** “学习单签发始终由家长完成”目前只是产品约定，不是权限控制。孩子打开学习单页就能出单、作废、重开。

**修正：**

1. 建立**审批矩阵**（见 §7.6）：`issue/void/reissue/cancel/plan edit/subject toggle` 需要 `parentSession`；`submit/receipt` 允许孩子。
2. 所有家长动作写审计事件：`actor=parent`、`parentSessionId`、`targetRef`、`before/after` 摘要。
3. 小程序端家长入口隐藏只是 UX，不作为安全措施。
4. 明确写进文档：同一台设备、同一个 openid 下，角色是“协作式”的，不是强隔离；只有 `parentSession` 覆盖的动作才是强门禁。

### 3.6 页面注册与 Action Registry 不一致

v2 的 Action Registry 假设“页面已注册/参数已支持”，但代码不是：

| Action | v2 假设 | 代码现状 | 结论 |
|---|---|---|---|
| `start_retest` | `subject/topic/errorType/mid` | `retest.js:34-40` 读取 `key/subject/topic/errorType/mid` | 基本可用，需加 `recommendationId/childId` |
| `start_tutor` | `subject + mid` 或 `planId/si/ti` | `tutor.js:49-75` 读取 `key/subject`、`task+si+ti` 或 `topic+errorType`，**不读 `mid`，也不读 `planId`** | v2 契约不准确；要么改页面，要么改契约 |
| `review_cards` | `subject/unitId` | `cards.js` **没有 `onLoad(options)`**，只有 `onShow`；页面永远展示全部到期卡 | 参数会被静默忽略 |
| `open_plan` | `subject/childId` | `plan.js:56-65` 读取 `key`、可选 `si/ti` | 可用；`childId` 需新增 |
| `generate_exam` | “iPad GenerateSheet 或已注册的小程序页” | `examGen/examAnswer/examReport` 三个目录存在，但 `app.json:8-40` **没有注册**；`examGallery.js:151-170` 已经在跳转它们 | 小程序端当前是断链，不能作为 P3 的“已注册页” |
| `blindsweep` | 转成可执行动作 | `unitKp.js:42-50` 只读 `subject`，不读 `unitId` | 需要新增 `open_unit_kp` 或改页面 |
| `new_lesson` / `practice` | dayPlan 类型 | 没有任何对应页面/动作 | 枚举里应删除，或明确映射到 `start_tutor` |

**修正：**

1. 把 Action Registry 做成**唯一 JSON 契约**（服务端校验 + 小程序/Swift 生成常量），每个 action 包含：`name/page/paramsSchema/requiredFacts/parentOnly/pageRegistered`。
2. 上线前加一条自动测试：遍历 Registry，检查 `app.json` 中是否存在对应 page；不存在则测试失败。
3. 先注册试卷三页，或从 Registry 中移除 `generate_exam`，不要留“设计上可用、运行时 404”的状态。
4. `cards` 页要么支持 `subject/unitId` 过滤，要么 Registry 不传这两个参数。

### 3.7 夜间编排缺运维契约

v2 说“一个 20:30 定时入口调用 `tutorSupervisor.nightly`”，但没有写怎么部署、怎么鉴权、怎么分批、超时怎么办：

- `cloudfunctions/dailyReset/config.json` 只有 `0 5 0 * * * *`；没有 20:30 触发器的函数。
- `cloudbaserc.json:4-13` 只声明了 `examService`，新函数不在部署清单里。
- `examService` 的 `timeout` 是 60 秒；如果 `nightly` 在一个调用里遍历全部家庭，必然超时。
- 云函数之间互调没有内建服务鉴权；如果 `tutorSupervisor` 暴露 `nightly` action，客户端也能直接调，造成越权/刷 AI。

**修正：**

1. 新增 `tutorSupervisor/config.json` 定时触发器（时区按云开发控制台确认，不依赖运行环境本地时区），并在文档里写清 cron 与实际执行时间。
2. `nightly` 只接受内部调用：`INTERNAL_AGENT_KEY` + HMAC（`openid+childId+date+requestId+timestamp`），客户端调用一律拒绝。
3. 分页/游标批处理：每次最多处理 N 个家庭，处理进度写 `tutor_agent_cursor`；下次从游标继续；单函数超时设为 300–900 秒并留余量。
4. 每个家庭一把锁：`nightly_<date>_<openid>` 确定性文档，状态 `running/succeeded/partial/failed`；重入直接返回现有状态。
5. 每科独立超时；某科超时只降级该科，不拖垮整份日报；失败进入重试队列/死信，不在下一次静默跳过。
6. 上线前用 3 个家庭、每家庭 2 个孩子的数据做一次真实定时器演练。

### 3.8 历史数据迁移：需要工具，不是一句“家长确认”

v2 说“历史 `tutor_*` 没有 childId 时进入待确认历史数据，由家长一次性映射；不得静默回填”。方向正确，但没有落地物：

- 现有 `tutorSync` 的证据“认领”逻辑（`310-336`）正在做静默归属。
- 本地 `tutorStore.adoptGuestData`（`106-140`）会把 `_guest` 数据并入当前 openid，不区分孩子。
- 没有迁移页面/脚本/审计表。

**修正：**

1. 新增 `scripts/migrate-child-scope.cjs`（dry-run 默认）：列出每个 openid 下无 `childId` 的记录数、时间范围、业务键，输出候选归属，不写库。
2. 小程序新增“历史数据确认”页（家长会话）：逐批展示，家长选择孩子或“暂不归属”；未确认的记录保留 `childId=''`，Agent 不读取。
3. 迁移写审计：`tutor_migrations` 记录操作者、批次、记录 ID、before/after。
4. 单孩子家庭也要显式确认，不做“只有一个孩子就自动归他”的捷径。

---

## 4. P1 遗漏（归因、状态、容量）

### 4.1 推荐生命周期与曝光事件缺失

v2 只定义了 `recommendationId`，但没有定义它的生命周期和事件。没有这些，`planned/done`、采纳率、证据回流率都无法可靠计算。

**需要新增：**

```js
// tutor_recommendations（当前态，确定性 _id）
{
  _id: 'rec_<date>_<hash>',       // 服务端生成；hash = sha1(openid|childId|action|targetKey)[:12]
  openid, childId, date, timezone,
  recommendationId,
  revision,
  status: 'proposed' | 'shown' | 'clicked' | 'started'
        | 'completed' | 'abandoned' | 'expired' | 'superseded',
  action: { name, params },
  targetRef,
  reason,
  firstShownAt, lastShownAt, shownCount,
  clickedAt, startedAt, completedAt,
  terminalFactRef,                // 完成时指向 attempt/submission/session/order
  evidenceProduced: false,        // 只由复测证据服务回填
  createdAt, updatedAt
}
```

- `shown` 同一天只记一次首曝 + 计数，避免每次渲染写库。
- `clicked/started/completed` 是状态迁移，必须幂等（同一 `recommendationId+status` 只写一次）。
- `completed` 只表示“有终态事实”，不等于“形成证据”；`evidenceProduced` 单独字段。
- `expired` 由 Action Registry 在执行前检查目标是否仍有效；无效时页面提示，不静默跳转。

### 4.2 计划稳定性：不要在白天反复重生成 dayPlan

v2 §5.1 第 7 步说“新执行结果会改变 `stateHash`，旧计划标记 stale/superseded，新计划新增 revision”。这条会造成三个问题：

1. 孩子完成一条推荐，剩下未完成的推荐全部换 `recommendationId`，归因断裂。
2. 每完成一条就触发一次 Supervisor + Subject Agent，成本随完成次数线性增长。
3. 孩子正在做的事可能因为计划刷新而从首页消失。

**修正：**

- `dayPlan` 在当天首次成功后**冻结**；当天只做“patch”：
  - 完成 → 该推荐 `completed`；
  - 目标失效 → 该推荐 `expired`；
  - 剩余为空 → 可追加一轮“补充推荐”，但保留原推荐记录。
- 只有以下情况生成新 revision：家长手动刷新、当天计划为空、所有推荐都已终态、次日首开。
- `stateHash` 用于**次日计划**和**directive**，不作为白天重生成整份计划的触发器。
- 推荐 ID 采用确定性 hash（`date+child+action+target`），同一目标同一天重复推荐时复用 ID，保证幂等。

### 4.3 事实分级：打卡/勾选是“自述”，不是“已验证”

v2 说“不把打卡、导学、复习卡完成等同于证据”，但 `subjectReport.facts` 里的 `done` 仍然把不同可信度的事实混在一起。需要显式分级：

| 级别 | 定义 | 例子 | 能否支撑“有可验证证据” |
|---|---|---|---|
| `verified` | 服务端生成题目、服务端判分、满足独立性声明 | 复测 attempt `passed=true` | 能 |
| `server_recorded` | 服务端观察到并落库，但不是掌握证据 | 导学会话归档、试卷提交、学习单回执 | 不能，只能算活动 |
| `client_claimed` | 客户端自述 | 打卡、成长计划勾选、卡片自评、手动“已订正” | 不能，只能算过程 |
| `derived` | 规则从上述事实推导 | 到期数、连续未达标天数、完成率 | 不能 |

**修正：**

- 所有事实文档增加 `factGrade`；Agent 的 `facts` 必须按级别分组，不允许把 `client_claimed` 写成“完成”。
- 家长日报中，`done` 必须区分“服务端记录完成”和“孩子自述完成”；文案不能混。
- 学习单回执（`tutor_orders`）是 `server_recorded`，不是证据；保持现有 O3 红线。

### 4.4 容量来源没有进入 StateReader：精力条/课表已存在

v2 说 Policy Engine “按画像和剩余时间截断”，但没有说“剩余时间”从哪来。项目里已经有两套容量信号：

- `miniprogram/utils/pace.js:75-105` 由 `learner.weeklyMinutes + stage` 推导 `singleSessionCapMin`、`dailyEnergyPool`、`weeklyMinutes`；`snapshot()` 在 `267-300` 输出 `pct/capMin/weeklyUsed/weeklyTotal`。
- `store.js:712-716` 的 `getPaceSnapshot()` 是页面读的视图模型。
- `pages/index/index.js:88-99` 已经读取今日课表；`scheduleEngine` 有课程数据。

如果 Agent 自己再写一套“每日 30 分钟”的规则，就会和精力条冲突：首页说“今天还能学 20 分钟”，推荐卡说“建议 45 分钟”。

**修正：**

- StateReader 增加 `capacity`：

```js
capacity: {
  dayMinutes, remainingMinutes, singleSessionCapMin,
  energyPct, weeklyUsedMin, weeklyTotalMin,
  scheduleBusyMinutes, cutoffTime,
  source: 'pace+schedule'
}
```

- `capacity` 由**云端的 canonical 模块**计算，输入是 learner/grade/pace/schedule；小程序端 `pace.js` 作为同一套公式的另一份实现，用哈希测试锁死，类似 `order-kit` 的同步方式。
- Policy Engine 只使用 `capacity` 截断；Agent 不得输出超过 `hardLimits` 的题量/时长。
- 若 `capacity` 缺失，降级为“只推荐到期复习 + 1 条错题”，不做长时间任务。

### 4.5 盲区/掌握口径：现有代码正在把“卡片毕业”当掌握

v2 说“`cards.done` 不能与 `tutor_evidence.passed` 混称为掌握”，但没有点名现有实现：

- `tutorStore.js:581-588` 的 `kpMastered()` 只检查 `card.done`，`diagnoseBlindSpot()` 用它判断前置是否欠账。
- `webAdminQuery/index.js:19` 写“已掌握 = `tutor_evidence passed=true` 计数”，但 `276` 行变量名和看板文案仍容易读成能力掌握；`402` 行注释明确“`tutor_*` 无 childId，真实口径只到 openid 级”。
- `webAdminQuery/index.js:76-118` 的单元通关率基于 Leitner 毕业，并明确“不写 evidence、不称掌握”，这是对的；但和 `diagnoseBlindSpot` 的“mastered”命名仍不一致。

**修正：**

- 盲区诊断改为：`evidenceByKp(unitId::kpId)` 优先；没有证据时状态是“证据不足”，不是“未掌握”。
- 卡片毕业只用于“复习进度/到期调度”，字段名改为 `graduated` 或 `reviewDone`，不要叫 `mastered`。
- 看板文案统一为“有可验证证据 / 待巩固 / 证据不足 / 未开始”，删除“已掌握”作为能力结论；如果保留“已掌握”作为筛选标签，必须加括号说明“仅指复测证据”。
- 增加测试：只有卡片毕业、没有复测证据时，盲区诊断不得输出“已掌握”。

### 4.6 知识点身份与教材版本没有统一

- `tutorStore.js:470-475` 明确 `kpId` 只在单元内唯一，去重要叠加 `unitId`。
- `unitKps` 的 `points[].id` 是单元内序号（`p1/p2`），跨单元会撞名。
- 教材库有 `textbook_library`、`tutor_unit_kps` 两套数据，`examService` 出卷也读 `tutor_unit_kps`。

**修正：**

- 全链路统一 `kpKey = unitId + '::' + kpId`；推荐 `targetRef` 必须同时带 `unitId/kpId`，不能只带 `topic`。
- 教材版本 `textbookEdition` 进入 StateReader；推荐理由可以提“当前教材第 X 单元”，但不得跨版本引用。
- `topic` 只用于展示和弱依赖，不作为主键；现有 `diagnoseBlindSpot` 的 `deps[topic]` 保留为兼容，但新逻辑用 `kpKey`。

### 4.7 时区与业务日：现有代码有 UTC 混用

v2 要求统一 `Asia/Shanghai`，但没有指出具体坑：

- `tutorSync/index.js:136` 用 `new Date(t).toISOString().slice(0, 10)` 做证据去重日键——这是 UTC 日期，晚上 8 点后（UTC+8）会落到前一天。
- `dailyReset/index.js` 用 `new Date()` 的本地时间做 `dateKey`；云函数运行环境的时区不保证与业务时区一致。
- `tutorStore`/`retest` 的 `dueAt` 是毫秒时间戳，跨日判断依赖客户端本地时区。

**修正：**

- `agentKit/clock.js` 提供 `businessDate(ts, tz='Asia/Shanghai')`、`dayRange(date)`、`isSameBusinessDay(a,b)`；所有业务日键只走这个模块。
- `tutorSync` 的去重日键改为 `businessDate`；`dailyReset` 的 `dateKey` 改为显式时区。
- 测试覆盖 UTC+8 的 23:30、00:30、以及服务器 UTC 00:00 附近的场景。

### 4.8 日报只有“每个孩子一份”，没有家庭视图

v2 的 `dailyReport` 唯一键是 `openid+childId+date+kind`。这适合孩子级，但家长打开日报时通常想看“今天两个孩子分别怎样、谁需要我介入”。

**修正：**

- 保留孩子级 `dailyReport`（事实来源）。
- 新增 `familyReport`（`openid+date`）：由规则引擎聚合孩子级报告，不调用 AI；字段包括每个孩子的 `headline/planned/done/evidence/alerts` 和家庭级 `topActions`。
- 家长日报页默认展示家庭视图，可下钻到孩子。
- 如果只有一个孩子，家庭视图退化为孩子视图，不额外增加页面。

### 4.9 现有“报告→计划”反哺没有被纳入推荐闭环

`miniprogram/utils/planFeedback.js` 已经把错因聚合成“专项补漏任务”，`report.js:149` 的 `addToPlan` 可以把任务加入成长计划。但这条路径没有 `recommendationId`，也没有采纳事件。

**修正：**

- 要么把它纳入 Action Registry（`add_plan_task`），由规则引擎生成、家长确认后写入，并记录 `sourceRecommendationId`；
- 要么明确它是“手动模式”，不参与推荐采纳率，避免把两套采纳口径混在一起。
- v3 建议：先保留为手动模式，但在 v3 的 `recommendation_events` 里记录 `manual_add`，后续再统一。

### 4.10 iPad/网页交接契约缺失

- `examService.js:1998-2010` 的 `readFarmUser` 用 `currentUserId || users[0]` 取当前孩子；`readCards/readUnitKps` 在 `2015-2059` 只按 openid 读。也就是说，iPad 出卷时“年级/计划”来自当前孩子，“卡片/单元必会”却来自全家，容易跨孩子。
- `examService.js:1564,1864` 的 `subDoc` 没有 `childId`；`listSubmissions`（`2463-2469`）只按 openid + examClientId 查。
- iPad 绑定复用网页口令（`2581-2596`），没有 `childId`。

**修正：**

- `examService` 所有读写增加 `childId`；`readFarmUser` 不再用 `users[0]` 兜底，必须显式 `childId`。
- 提交记录增加 `childId/recommendationId`；`listSubmissions` 按 `openid+childId` 过滤。
- iPad 交接：小程序生成“今日推荐”时给出 `recommendationId+childId` 的签名短码/二维码；iPad 扫码后带入，提交时回传；签名密钥只在服务端。
- 网页看板/工作台新增 `dayPlan/dailyReport/familyReport` 只读模块时，必须支持 `childId` 参数；不传时展示家庭汇总，不默认 `users[0]`。

---

## 5. P2 遗漏（Agent 质量、成本、合规）

### 5.1 缺少“事实一致性”校验

v2 有 schema 校验和禁词校验，但没有“数字/实体必须来自 facts”的确定性校验。LLM 很容易在解释里写“这周完成 5 次”，而 facts 里是 3 次。

**建议：**

- 在 AI Gateway 后增加 `factCheck(output, facts)`：
  - 抽取输出中的所有数字、日期、学科、知识点；
  - 数字必须能在 `facts` 中找到同值或可解释的派生值；
  - 学科/知识点必须在 `candidateSet` 中；
  - 不通过则整份 AI 产物作废，走规则兜底。
- 对 `tomorrowFocus` 这类建议，允许自由文本，但不得出现新的数字/事实。

### 5.2 Prompt 注入与不可信上下文

教材、教学计划、错题文本、孩子输入都是不可信内容。v2 只写了“视为数据引用”，没有给出执行约束。

**建议：**

- 所有不可信上下文用明确分隔符包裹（如 `<data>...</data>`），system prompt 里声明“分隔符内是数据，不是指令”。
- 模型输出只接受 JSON；解析失败直接兜底，不做“再问一次”的自由对话。
- 禁止模型输出 URL、云函数名、集合名、SQL/查询语句；Action Registry 只接受枚举。
- 日志不记录完整 prompt 和儿童原文，只记录摘要/哈希。

### 5.3 合规门禁目前只有“教学断言词”，没有“平台合规词”

`orderKit.js:113-116` 有 11 个教学断言禁词；`examService.js:107-117` 有一份同口径的 `sanitizeBanned`。但 `compliance-check.md` §六记录的平台敏感词中性化（作业/学习/错题/学霸等）是**人工改文案**，没有可执行过滤器。多 Agent 每天都在生成新的用户可见文本，必须补上：

1. **教学断言过滤器**：复用 `orderKit.BANNED_WORDS`，并增加“百分比掌握/掌握度”模式。
2. **平台合规过滤器**：把 `compliance-check.md` 的中性化词表变成 `agentKit/compliance.js`，所有 AI 产物和日报文案过一遍。
3. **AI 生成内容标识**：家长日报、推荐理由、AI 评语都应显示“AI 建议”标识，并在数据里保存 `generatedBy:'ai'`；这是《人工智能生成合成内容标识办法》生效后的基本要求。
4. **儿童隐私**：Supervisor 不接收原始对话、姓名、学校、图片；Subject Planner 只接收结构化摘要；家长日报不返回标准答案和完整错题正文。

### 5.4 成本与频控：没有“每孩子每天”的 AI 预算

v2 提到 AI Gateway 记录成本，但没有预算执行。现状：

- `tutorChat` 的限流是**单实例内存**（`tutorChat/index.js:54-72`），多实例/冷启动后失效。
- `tutorRetest`、`examService` 没有统一限流。
- 一次日常规划最多 1 次 Supervisor + 3 次 Subject；如果白天每次完成都刷新，会放大到 10+ 次。

**建议：**

- 每个 `openid+childId+date` 一个 `tutor_agent_quota` 文档：`maxCalls`、`usedCalls`、`maxTokens`、`usedTokens`、`forceUsed`；服务端原子递增。
- 无候选/无到期/无错题时，不调用 AI，直接规则产物。
- 相同 `stateHash + promptVersion` 直接复用 current 文档，不重复调用。
- 模型分层：学科选择用便宜模型，家长解释用较强模型；都失败则规则。
- 输入 ≤3k tokens、输出 ≤800 tokens；超长先截断（优先保留到期、待处理、当前单元）。

### 5.5 观测与评估

v2 的字段清单是好的，但缺跨函数追踪和离线评估：

- `traceId` 必须由编排器生成并透传到 `tutorPlanner/tutorSupervisor`；`recommendationId` 透传到执行服务。
- 指标：schema 失败率、语言失败率、事实校验失败率、兜底率、p95 延迟、token/成本、跨孩子拒绝数、证据旁路拒绝数。
- 离线评估：准备 20–30 个脱敏家庭快照，固定 prompt 版本跑“金标准”检查（不出现“已掌握”、不超额度、推荐目标都存在、数字与 facts 一致）。
- 影子模式：数学 Subject Planner 先只生成、不展示，与规则计划对比 1–2 周，再切流量。

### 5.6 规范常量存在多份副本

以下常量已经在多处复制，Agent 再复制一份必然漂移：

| 常量 | 现有副本 |
|---|---|
| `REVIEW_STAGE_DAYS = [1,2,4,7,15]` | `tutorStore.js:50`、`tutorRetest/index.js:41`、`tutorChat/index.js:296` |
| 九科学科名 | `tutorSubjects.js`、`tutorRetest/tutorChat` 的 `SUBJECT_NAMES`、`webAdminQuery` 的 `SUBJECT_NAMES_CN` |
| 教学断言禁词 | `orderKit.js:113`、`examService.js:107` |
| 复测阈值 | `tutorRetest` 的 `RETEST_COUNT/PASS_RATE`；客户端只有注释 |
| 到期/复习口径 | `tutorStore`、`webAdminQuery`、`examService` 各一份 |

**修正：** 用 `agentKit` 做 canonical，参考现有 `order-kit` 模式：canonical 源 + `scripts/sync-agent-kit.mjs` 生成到各云函数 + sha256 锁死；小程序端要么引用生成文件，要么用同一份 JSON 常量。

### 5.7 测试底座不足以证明幂等/并发

`scripts/mock-tcb.js` 目前不支持真实语义：

- `limit()` 是空操作（`mock-tcb.js:33,39-41`），`get()` 返回全部；
- 没有 `count()`、`skip()`；
- 没有 `doc(id).get()`、`doc(id).set()`；
- `where` 只支持等值，没有 `exists/lt/in` 等操作符；
- `add` 不检查 `_id` 冲突，无法模拟确定性 ID 的原子 upsert；
- `update` 不返回真实的影响行数语义（只有 `updated` 计数）。

v2 §11 已经说“内存 mock 需补齐 limit、文档 get、原子 upsert 和唯一键语义”，但没有列清单。v3 要求：

1. 补齐上述能力，并用“同一 `_id` 二次 `add` 必须失败/`set` 必须覆盖”的测试锁住。
2. 幂等/并发测试必须走真实云函数入口 + mock 的原子语义，不能手工插入“预期正确”的文档。
3. 增加故障注入：AI 超时/429/额度不足、DB 超时、集合缺失、schema 非法、禁词、事实不一致、部分写入失败。

### 5.8 保留、压缩与隐私

- `tutor_agent_runs` 90 天清理是对的，但 `tutor_agent_current` 的 revision 会累积；需要每 key 只保留最近 N 个 revision，旧 revision 写 `superseded` 后归档/删除。
- 需要按孩子导出/删除：家长会话下可导出 `childId` 的全部事实与 Agent 产物；删除时事实、证据、会话、订单、Agent 文档一起处理，不能只删一份。
- 日志/埋点不得记录儿童原文；`tutor_sessions.messages` 已有 4000 字截断，但仍是原文，需要明确保留期和访问权限。

### 5.9 部署与回滚

- 新函数需要 `package.json`、`config.json`（超时/内存/触发器）、`cloudbaserc.json` 声明；`agentKit` 需要同步脚本。
- `examService` 的发布三步铁律（update→publish→alias）不能套用到新函数；新函数要写自己的部署 runbook。
- 每个阶段都要有 feature flag：`agent.dayPlan.enabled`、`agent.supervisor.enabled`、`agent.parentReport.enabled`；关闭后回到规则版，不删数据。

---

## 6. 修正后的总体架构（v3）

```text
微信小程序                 iPad ExamPad                网页看板/工作台
   │                          │                           │
   │ openid + childId         │ device token + childId    │ portal session + childId
   ▼                          ▼                           ▼
─────────────────────────────────────────────────────────────────
                    ScopeGuard + ParentSession
      openid 服务端解析｜childId 校验属于家庭｜actor 由凭证推导
─────────────────────────────────────────────────────────────────
                             │
                             ▼
                 Fact Ledger（只追加的学习事实）
   打卡/农场（childId）｜错题/会话｜复测 attempt/证据｜试卷提交｜订单/回执
                             │
                             ▼
              Learning StateReader（确定性，带 stateHash）
   画像/成长计划/教学计划/教材｜到期复习/卡片｜待处理错题｜证据｜容量 capacity
                             │
                             ▼
              Policy Engine（确定性，无 AI）
   欠账/异常｜候选｜额度硬上限｜规则计划｜统计事实｜兜底文案
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
       Supervisor Agent               Subject Planner Agent
   跨科排序/家长解释/日报           单科推荐/单科解释/次日建议
              │                             │
              └──────────────┬──────────────┘
                             ▼
        AI Gateway：schema + 事实校验 + 语言/合规 + 预算 + 版本
                             │
                             ▼
              Action Registry（服务端校验 + 客户端注册表）
                             │
                             ▼
                今日推荐 current + 推荐状态/事件
                             │
                             ▼
        执行服务（现有能力改造后复用，携带 recommendationId）
  tutorChat｜tutorRetest｜examService｜cards｜tutorOrder
                             │
                             ▼
              Fact Ledger → StateReader → 下一轮推荐
```

### 6.1 AI 角色与确定性角色必须分开

| 角色 | 性质 | 输入 | 输出 | 禁止 |
|---|---|---|---|---|
| Orchestrator | 确定性代码 | request、stateHash、quota | 调用顺序、重试、降级 | 不做教学判断 |
| Supervisor Agent | 单轮 LLM | 三科聚合事实、异常、额度 | 优先级、家长解释、日报叙述 | 不看原始对话、不改额度、不写事实 |
| Subject Planner Agent | 单轮 LLM | 学科事实、候选、容量、教材坐标 | 1–2 条推荐 + 理由 | 不跨科、不造目标、不超容量 |
| Tutor Agent（现有 `tutorChat`） | 单轮/多轮 LLM + 会话 | 推荐上下文、孩子提问 | 诊断建议、引导话术 | 不判证据、不写事实 |
| Judge/Executor | 确定性 | attempt、答案、阈值 | 判分、证据、复习推进 | 不接受客户端答案 |
| Reporter | 确定性 + 可选 LLM 润色 | facts | 日报数字 + 解释 | 数字不得由 LLM 生成 |

**关键约束：** “多 Agent”是**编排多个无状态单轮模型调用**，不是让模型自主循环、调用工具或互相广播。所有 Agent 之间只通过版本化 JSON 通信。

### 6.2 写入矩阵（谁可以写什么）

| 写入方 | 可写集合 | 禁止 |
|---|---|---|
| `tutorRetest` | `tutor_retest_attempts`、`tutor_evidence`、`tutor_reviews`（推进） | 写 `tutor_mistakes.status` 以外的学习事实 |
| `tutorChat` | `tutor_sessions`、`tutor_mistakes`、`tutor_reviews`（派生） | 写 `tutor_evidence` |
| `examService` | `exam_resources`、`tutor_exam_submissions`、`tutor_mistakes`（source=exam/paper） | 写 `tutor_evidence` |
| `tutorOrder` | `tutor_orders` | 写证据/错题/复习/计划 |
| `tutorSync` | `tutor_sessions/mistakes/reviews/cards/unitKps/orders`（镜像） | 写 `tutor_evidence`；合并 orders 状态 |
| `webAdminWrite` | 画像/教学计划、`tutor_*` 镜像、试卷库 | 写 `evidence.passed`；覆盖身份字段 |
| `tutorPlanner` | `tutor_agent_current/runs`（subject 类） | 写任何学习事实 |
| `tutorSupervisor` | `tutor_agent_current/runs`（supervisor 类） | 写任何学习事实、改计划 |
| `dailyReset` | `hw_farm_user`（CAS）、`hw_farm_settle` | 写 Agent 文档 |
| `syncData` | `hw_farm_user`、`hw_checkin_log`、`hw_farm_events` | 写 `tutor_*` |

**规则：** 每个集合只有一个“权威写者”；镜像写入必须保留 `clientId` 且不允许改状态机字段。上线前把这张表变成静态断言测试（扫描每个云函数的 `collection().add/update` 调用）。

### 6.3 通信与版本

- Agent 输入/输出都带 `schemaVersion: 'agent-v3'`、`promptVersion`、`model`、`requestId`、`traceId`。
- `requestId` 由客户端/编排器生成，服务端按 `openid+childId+requestId` 幂等；不允许跨孩子复用。
- `stateHash` 的 canonical 化：只包含规划相关字段，排序 key，排除 `updatedAt/lastSyncAt/pushQueue/removed`；否则每次本地同步都会变。
- `stateHash` 变化只影响“次日计划/directive”，不触发白天整份 dayPlan 重生成（见 §4.2）。

---

## 7. 数据与接口契约（v3 增补）

### 7.1 统一作用域（在 v2 基础上加字段）

```js
{
  schemaVersion: 'agent-v3',
  openid,                    // 服务端身份上下文生成
  childId,                   // 必填，属于该 openid 的 users[]
  actor,                     // 'child' | 'parent' | 'system'，由凭证推导
  actorSource,               // 'openid' | 'parent_session' | 'timer' | 'internal'
  requestId,
  traceId,
  occurredAt,
  timezone: 'Asia/Shanghai',
  factGrade                  // verified | server_recorded | client_claimed | derived
}
```

### 7.2 复测 attempt 契约

```js
// tutor_retest_attempts
{
  _id: 'rta_<openidHash>_<childId>_<attemptId>',
  attemptId, openid, childId,
  recommendationId,
  subject, unitId, kpId, topic, errorType,
  questions: [{ q, options, answerHash, analysisHash }], // 服务端存答案/解析
  answers: [],               // 提交后写入
  total, correct, rate, passed,
  independence: 'self_declared_no_hint' | 'prompted' | 'unknown',
  status: 'generated' | 'submitted' | 'expired' | 'invalidated',
  expiresAt,
  createdAt, submittedAt
}
```

- `generate` 只返回 `{ attemptId, questions:[{q,options}] }`，**不返回 `answer/analysis`**。
- `submit` 只接受 `attemptId+answers+independenceDeclaration+childId+recommendationId`。
- 证据通过条件：`total>=5`、`rate>=0.8`、`independence=self_declared_no_hint`；`prompted` 只保存为 attempt，不形成独立证据。
- `tutor_evidence` 增加 `attemptId`、`childId`、`recommendationId`；以 `attemptId` 唯一。

### 7.3 推荐状态与事件

- 当前态：`tutor_recommendations`，确定性 `_id`，字段见 §4.1。
- 事件：`tutor_recommendation_events`，只追加，`eventId = recommendationId|status|attempt`，用于审计和采纳率重算。
- 采纳率分母：`shown` 的推荐；分子：`started` 或 `completed`，按产品口径二选一并在文档固定。
- 证据回流率分母：`type=retest` 且 `completed` 的推荐；分子：`evidenceProduced=true`。
- 不用“点击率”替代“完成率”；两个指标都保留。

### 7.4 Agent 文档（v2 基础上补）

```js
// tutor_agent_current
{
  _id: 'tac_<openidHash>_<childId>_<date>_<kind>_<subject>',
  openid, childId, date, timezone,
  role: 'supervisor' | 'subject' | 'orchestrator',
  subject, kind: 'directive' | 'dayPlan' | 'subjectReport' | 'dailyReport' | 'familyReport',
  revision, stateHash, schemaVersion, promptVersion, model,
  status: 'running' | 'succeeded' | 'fallback' | 'failed' | 'stale' | 'superseded',
  fallback, fallbackReason,
  payload, createdAt, updatedAt
}
```

- 每 key 只保留最近 3 个 revision；旧 revision 标 `superseded` 后归档。
- `tutor_agent_runs` 每次 attempt 一条，成功后 payload 不可变；90 天清理只清这个集合。
- `runId = <date>|<openidHash>|<childId>|<role>|<subject>|<requestId>|<attempt>`，服务端生成，不信任客户端。

### 7.5 家长会话与设备令牌

```js
// parent_sessions
{
  _id: 'ps_<sha256(token)>',
  openid,
  tokenHash, salt,
  scope: ['dailyReport','orderIssue','planEdit','subjectToggle'],
  createdAt, expiresAt, lastUsedAt, revoked
}

// device_bind_tokens
{
  _id: 'dbt_<sha256(token)>',
  openid, uid,             // iPad uid
  scope: ['bind'],
  createdAt, expiresAt, revoked
}
```

- 网页 `portal_session` 与 iPad `device_bind_token` 分离。
- 小程序 `parentSession` 由 PIN 或“在小程序内确认”换取；PIN 失败 5 次锁定 15 分钟。
- 所有家长动作写 `tutor_parent_actions`（只追加）：`action/targetRef/beforeHash/afterHash/parentSessionId`。

### 7.6 审批矩阵

| 动作 | child | parentSession | 说明 |
|---|---|---|---|
| 查看今日推荐 | 允许 | 允许 | 孩子可见 |
| 开始复测/导学/复习卡 | 允许 | 允许 | 执行事实由服务端记录 |
| 提交复测/回执 | 允许 | 允许 | 不能改判分 |
| 签发/作废/重开学习单 | 禁止 | 必须 | 当前无门禁，必须补 |
| 修改成长计划/教学计划 | 禁止 | 必须 | 现有 `webAdminWrite` 走 token，小程序端需补 |
| 开关科目/暂停某科 | 禁止 | 必须 | 新能力 |
| 查看家长日报/家庭报告 | 禁止 | 必须 | 小程序端需 `parentSession` |
| 导出/删除孩子数据 | 禁止 | 必须 | 新增 |

### 7.7 Action Registry v3（按真实页面校正）

| action | 真实页面 | 页面现状 | 必要参数 | 阶段 |
|---|---|---|---|---|
| `start_retest` | `/pkgGuide/retest/retest` | 已注册；读 `key/subject/topic/errorType/mid` | `subject/topic/errorType/mid/recommendationId/childId` | P1 |
| `start_tutor` | `/pkgGuide/tutor/tutor` | 已注册；读 `key`、`task+si+ti` 或 `topic+errorType`，**不读 mid/planId** | `key` + (`task/si/ti` 或 `topic/errorType`) + `recommendationId/childId` | P1（需改页面或改契约） |
| `review_cards` | `/pkgTools/cards/cards` | 已注册；**无 onLoad 参数** | 若保留 `subject/unitId`，需先给页面加过滤 | P2 |
| `open_plan` | `/pkgTools/plan/plan` | 已注册；读 `key/si/ti` | `key/childId` | P2 |
| `open_unit_kp` | `/pkgTools/unitKp/unitKp` | 已注册；只读 `subject` | `subject/unitId?`（需加 unitId 支持） | P2 |
| `open_mistakes` | `/pkgTools/mistakes/mistakes` | 已注册；无参数 | `subject?/childId` | P2 |
| `start_speakstep` | `/pkgGuide/speakstep/speakstep` | 已注册；无参数 | `recommendationId/childId` | P3 |
| `open_exam_gallery` | `/pkgGuide/examGallery/examGallery` | 已注册 | `subject?` | P3 |
| `generate_exam` | `/pkgGuide/examGen/examGen` | **未注册** | 注册并加 `childId/recommendationId` | P3 |
| `open_exam_report` | `/pkgGuide/examReport/examReport` | **未注册** | `submissionClientId/childId` | P3 |
| `open_daily_report` | `/pkgGuide/dailyReport/dailyReport` | **不存在**（v1 规划过） | `date/childId?`；需 parentSession | P2 |
| `open_parent_report_web` | 网页看板 | 已有口令体系 | `childId/date` | P3 |

**规则：**
- 模型只能输出 `action.name`，不能输出 URL。
- 服务端按 Registry 校验 `params` 的类型、范围、归属（`mid` 属于该孩子、`kpId` 属于该学科/教材、`si/ti` 属于该计划）。
- 执行前再检查目标状态（错题是否仍待处理、复习是否仍到期、计划任务是否存在）；失效则返回 `target_expired`，页面提示而不是跳转。
- `new_lesson`、`practice`、`blindsweep` 暂不作为独立 type；如果要保留，必须映射到上述 action，并写清映射规则。

### 7.8 索引建议

| 集合 | 索引 |
|---|---|
| `tutor_sessions` | `openid+childId+createdAt` |
| `tutor_mistakes` | `openid+childId+status+createdAt` |
| `tutor_evidence` | `openid+childId+attemptId`、`openid+childId+createdAt` |
| `tutor_reviews` | `openid+childId+done+dueAt` |
| `tutor_cards` | `openid+childId+done+dueAt` |
| `tutor_unit_kps` | `openid+childId+subject+updatedAt` |
| `tutor_exam_submissions` | `openid+childId+createdAt` |
| `tutor_orders` | `openid+childId+status+issuedAt` |
| `tutor_retest_attempts` | `openid+childId+status+expiresAt` |
| `tutor_recommendations` | `openid+childId+date+status` |
| `tutor_recommendation_events` | `openid+childId+date+recommendationId` |
| `tutor_agent_current` | `_id` 确定性；`openid+childId+date+kind` 查询索引 |
| `tutor_agent_runs` | `openid+childId+date+runId`、`createdAt`（清理） |
| `hw_checkin_log` | `_openid+childId+date` |
| `hw_farm_settle` | `_openid+childId+date` |
| `web_portal_bindings` | `tokenHash`、`openid+revoked` |
| `parent_sessions` | `tokenHash`、`openid+expiresAt` |

---

## 8. 关键流程（v3 修正）

### 8.1 今日计划：规则先行，AI 异步增强，当天冻结

1. 首页 `onShow` 取当前 `childId`；不在 `App.onLaunch` 阻塞。
2. 本地有当日 current 文档则立即展示；没有则展示规则候选（到期复习、待处理错题），不出现空白。
3. 云端 StateReader 读快照、`capacity`、`stateHash`；Policy Engine 生成候选、额度、规则 directive。
4. 若当日 current 有效且 `stateHash` 未变，直接返回；否则创建同一 `requestId` 的幂等任务。
5. Supervisor 只调整优先级与说明；Subject Planner 分科 1–2 条；总条数 3–5。
6. 服务端完成 schema、事实、语言/合规、额度、Action Registry 校验后写 current；失败用规则版并标 `fallback=true`。
7. **当天计划冻结**：完成/失效只 patch 单条推荐，不重生成整份；次日首开再按新 `stateHash` 生成。
8. `force` 刷新必须新 `requestId`，且受每日次数限制；旧 revision 保留，不覆盖历史。

### 8.2 推荐执行与回流

1. 每条推荐由服务端生成 `recommendationId`，绑定 `openid+childId+date+action+targetKey`。
2. 首页展示时写 `shown`（首曝 + 计数）；点击写 `clicked`；进入执行页写 `started`。
3. 页面和云函数透传 `recommendationId+childId`；执行事实保存该关联。
4. 执行服务返回终态后，推荐服务写 `completed`/`abandoned`；复测证据服务单独回填 `evidenceProduced`。
5. 下一次 StateReader 读取新事实，规则引擎移除已完成候选；Agent 不“记住”上次对话。

### 8.3 复测证据

按 §7.2 执行。补充：

- `generate` 时记录 `promptVersion/model`，便于审计。
- `submit` 校验 `attempt.openid/childId` 与调用者一致；跨孩子直接 `forbidden`。
- 同一 `attemptId` 重复提交：已提交则返回原结果，不重复写证据。
- 证据写入失败必须可补偿：attempt 标 `submitted_pending_evidence`，重试任务补写；不能“判分成功但证据静默丢失”。
- 复习窗口推进与证据写入使用同一 `attemptId` 幂等；部分失败返回明确状态。

### 8.4 夜间日报

1. 20:30 定时入口（单入口）→ `tutorSupervisor.nightly`。
2. 按家庭/孩子分批；每个作用域先加锁，再规则统计。
3. 三科并发生成解释（并发上限 3）；每科必须有 `succeeded/fallback` 终态；超时/缺失不得当零活动。
4. 三科终态后生成孩子级 `dailyReport`；再生成 `familyReport`（规则聚合，不调 AI）。
5. AI 失败用规则统计组成日报；`dataCompleteness` 按科标记 `complete/partial`。
6. `tomorrowFocus` 只是建议；次日首开重新读状态，不沿用夜间冻结的 directive。
7. 所有日期用 `Asia/Shanghai`；文档存 `date/timezone`。

### 8.5 家长日报页

- 新增 `pkgGuide/dailyReport/dailyReport`（v1 已规划，v2 漏写页面）。入口：`mine` 家长区 + 首页家长区；需要 `parentSession`。
- 默认家庭视图：每个孩子一行 `headline / done / evidence / alerts`；下钻孩子详情。
- 展示“今日建议 / 明日重点 / 需决策事项”；底部“调整计划”“签发学习单”跳现有页。
- 所有数字来自 facts；AI 只生成解释；页面显示“AI 建议”标识。
- 不做订阅消息（P3 再评估；当前全仓无 `requestSubscribeMessage`）。

### 8.6 iPad/网页交接

- 小程序“今日推荐”可生成签名短码（`recommendationId+childId+exp`），iPad 扫码带入；提交回传 `recommendationId`。
- iPad 绑定使用 `device_bind_token`，不再复用网页 `portal_session`。
- 网页看板新增 `dailyReport/dayPlan/familyReport` 只读模块；按 `portal_session→openid→childId` 精确读取，不调 AI。
- 工作台扩展 `CloudSyncPayload` 时，先定义字段映射和冲突策略，再改代码。

---

## 9. 权限、隐私与合规

### 9.1 身份真相表

| 声明 | 可信度 | 用途 |
|---|---|---|
| `openid` | 服务端从 `getWXContext()` 取得，可信 | 账号隔离 |
| `childId` | 客户端提交，但服务端校验属于该 openid | 孩子隔离 |
| `actor` | 客户端不可信；由 `parentSession`/定时器/内部调用推导 | 权限与审计 |
| `recommendationId` | 客户端提交，服务端校验属于该孩子/日期/目标 | 归因、幂等 |
| `attemptId` | 客户端提交，服务端校验属于该孩子 | 证据判分 |
| `requestId` | 客户端提交，服务端按 `openid+childId` 去重 | 幂等 |

### 9.2 权限原则

- 前端隐藏入口不是权限控制。
- 所有家长动作必须 `parentSession`；孩子动作只需 openid + childId。
- 服务端函数之间的调用必须内部鉴权；客户端不能直接调 `nightly`、`generateDirective`。
- 任何按 `_id` 直查的兜底路径，取到文档后必须补验 `openid/childId`（参考 `examService` 的 IDOR 修复）。

### 9.3 模型输入最小化

| Agent | 可见 | 不可见 |
|---|---|---|
| Supervisor | 三科聚合数字、异常、额度、家庭级摘要 | 原始对话、姓名、学校、图片、完整错题正文 |
| Subject Planner | 本科结构化事实、Top N 候选、教材坐标、容量 | 其他学科原始对话、其他孩子数据 |
| Tutor | 当前会话 + 推荐上下文 + 本科摘要 | 其他孩子、其他学科会话 |
| 日报润色 | 已生成的规则 facts + 规则草稿 | 原始答案、完整对话 |

### 9.4 语言与合规双门禁

1. **教学断言**：禁止“已掌握/精通/学会/百分比掌握”等；复用并扩展 `orderKit.BANNED_WORDS`。
2. **平台合规**：把 `compliance-check.md` 的中性化词表变成可执行过滤器；所有用户可见 AI 文案过一遍。
3. **AI 标识**：AI 生成的建议/解释显示“AI 建议”，数据里记录 `generatedBy:'ai'`。
4. **事实与解释分离**：数字来自 facts；解释不得新增事实。
5. **未成年人隐私**：最小化输入、最小化输出、保留期、导出/删除。

---

## 10. 成本、并发与可观测性

### 10.1 预算

- 每孩子每日：`supervisor 1 + subject 3 + nightly 3 + report 1` 为上限；`force` 最多 3 次/日。
- 每孩子每日 token 预算可配置；超预算降级为规则版，并记 `budget_exceeded`。
- 无候选/无到期/无错题：不调用 AI。
- 相同 `stateHash+promptVersion`：复用 current，不重复调用。
- 模型分层：便宜模型做选择，较强模型做家长解释；都失败则规则。

### 10.2 并发与幂等

- 当前文档用确定性 `_id`；CloudBase 没有通用唯一约束，必须用 `_id` + `set/upsert` 或 CAS，不能“先查再 add”。
- 运行日志用 `runId`；同一 `requestId` 重试返回同一逻辑结果。
- 复测提交、订单状态、跨集合联动必须可重放；部分失败返回明确状态，不静默成功。
- `current` 的 revision 只在 `stateHash/revision` 符合预期时替换，防止旧 AI 结果覆盖新事实。

### 10.3 观测

- 每次运行记录：`traceId/requestId/runId/stateHash/schemaVersion/promptVersion/model/latency/fallbackReason/tokenIn/tokenOut/cost`。
- 指标：schema 失败率、语言失败率、事实校验失败率、兜底率、p95 延迟、成本、跨孩子拒绝数、证据旁路拒绝数、推荐采纳率、证据回流率、日报打开率。
- 告警：夜间失败、兜底率 >20%、成本超预算、跨孩子异常、未注册路由、家长动作越权。
- 日志不记录完整 prompt/儿童原文；需要排查时用 `runId` 关联脱敏摘要。

---

## 11. 分阶段实施（v3）

### P0：数据可信地基（未完成前不上 Agent）

1. `ScopeGuard`：所有写入口拒绝空 openid；剥离客户端 `openid/_openid/childId`；服务端重建作用域。
2. `childId` 全量落地：`tutor_*`、`tutor_exam_submissions`、`hw_checkin_log`、`hw_farm_settle`、`hw_farm_events`、本地 `tutorStore`、网页查询、iPad。
3. `dailyReset` 遍历所有孩子；`syncData` 打卡日志按孩子写。
4. 复测 attempt 化；证据单写者；关闭 `tutorSync/webAdminWrite` 证据旁路；移除客户端 `addEvidence`；删除自动认领。
5. 家长凭证：复用 `web_portal_bindings`，拆 `portal_session`/`device_bind_token`，新增小程序 `parentSession`；补齐学习单/计划修改权限。
6. 页面与 Action Registry 对齐：注册试卷三页或移除对应 action；`cards/unitKp` 参数补齐。
7. `agentKit` 骨架：scope/schema/actionRegistry/policy/aiGateway/clock/compliance；canonical + 同步脚本 + 哈希测试。
8. 历史数据迁移脚本 + 家长确认页 + 审计。
9. 索引与保留策略。

**出口标准：** 多孩隔离、空 openid、证据绕过、越权、重试、跨日、未注册路由测试全部通过；零跨孩子串数据。

### P1：数学规则闭环（先不接新 Agent）

1. StateReader + Policy Engine + 规则 dayPlan（含 `capacity`）。
2. 首页数学推荐卡 + 推荐状态/事件 + `recommendationId` 贯穿复测/导学/复习卡。
3. 家长日报页骨架（规则版，数学段）。
4. 复测 attempt 全链路（生成不含答案、服务端判分、幂等）。
5. 连续 5 天手工对账“推荐→执行→事实回流→次日推荐变化”。

**出口标准：** 无 AI 也能闭环；归因数字可手工对账；当天计划不被完成事件打散。

### P2：多 Agent 试点与三科铺开

1. `agentKit` + AI Gateway + schema/事实/语言/合规/预算。
2. 数学 Subject Planner 影子运行，与规则计划对比。
3. Supervisor + 夜间单入口 + 数学家长日报；验证 fallback、语言、负荷上限。
4. 扩至语文/英语；家庭视图；保留手动模式。
5. iPad/网页只读接入（可选）。

**出口标准：** Agent 不修改事实、不突破额度；AI 停用时规则闭环无回归；成本在预算内。

### P3：外部入口与减法

1. 看板/工作台接 `dayPlan/dailyReport/familyReport`，补 `CloudSyncPayload` 映射。
2. iPad“按今日推荐出卷”，提交回传 `recommendationId/childId`。
3. 小程序试卷生成/报告页注册并打通。
4. 根据采纳数据减少重复入口；手动模式不删除，只降级。
5. 订阅消息/提醒（需用户授权）再评估。

---

## 12. 测试矩阵（v3）

| 类别 | 必测用例 |
|---|---|
| 作用域 | 同 openid 两个孩子完全隔离；其他家庭不可读；禁止 `users[0]` 兜底；`hw_checkin_log/hw_farm_settle` 带 childId |
| 身份 | 伪造 openid/childId/actor 无效；空 openid 不可写；`requestId` 不能跨孩子复用 |
| 家长权限 | 无 `parentSession` 不能读日报/出单/改计划；过期/撤销/重放令牌无效；iPad token 不能读看板 |
| 证据 | `tutorSync/webAdminWrite` 无法写 `passed`；客户端不能自造题/答案；`generate` 响应不含答案；提示后完成不形成独立证据；跨孩子 attempt 拒绝 |
| 幂等 | `Promise.all` 同键并发只产生一个 current/attempt；重复提交返回原结果；force 保留历史 revision |
| 归因 | 每条执行事实能回链 `recommendationId`；`shown/clicked/started/completed` 可重算；证据回流率分母正确 |
| 计划稳定 | 完成一条推荐不改变其余推荐 ID；当天不重生成整份计划；次日按新 stateHash 生成 |
| 动作 | 非白名单 action 拒绝；非法 mid/si/ti/kpId 拒绝；跨孩子 targetRef 拒绝；目标过期明确提示 |
| 页面注册 | Registry 中每个 page 都存在于 `app.json`；页面能消费声明的参数 |
| schema/语言/事实 | 缺字段/错类型/超长/禁词/合规词/数字与 facts 不一致 → 兜底 |
| 时间 | UTC+8 23:30/00:30；服务器 UTC 跨日；`dailyReset` 跨日；证据去重日键 |
| 夜间 | 单科失败/超时、定时器重入、部分数据、家庭批量、游标续跑、死信重试 |
| 降级 | AI 超时/429/额度不足/DB 异常均不伪装成空数据；规则计划仍可用 |
| 隐私/保留 | 模型输入不含非必要儿童原文；90 天清理不影响事实/current；按孩子导出/删除 |
| 迁移 | 无 childId 历史数据 dry-run、家长确认、拒绝自动回填、审计完整 |
| Mock | `limit/skip/count/doc.get/doc.set/_id 冲突/操作符/影响行数` 语义与真实 SDK 对齐 |

**测试必须调用真实云函数入口；mock 只替代数据库，不替代业务入口。**

---

## 13. 未决事项（需要产品拍板）

1. **家长审批范围**：dayPlan 是否需要家长逐条批准？v3 建议“dayPlan 只建议，不强制；学习单/计划修改才需要 parentSession”。
2. **当天计划稳定性**：完成一条后是否允许补充推荐？v3 建议“允许补充，但不重生成原推荐”。
3. **农场激励耦合**：复测/导学是否也给农场奖励？目前卡片自测给浇灌（`cards.js:100-103`），复测/导学没有。若不统一，推荐会和打卡争夺动机。
4. **日报提醒**：是否上订阅消息？需要用户授权和模板审核；v3 建议 P3。
5. **`new_lesson/practice` 类型**：没有页面；v3 建议先删除，等页面就绪再加。
6. **家庭日报 vs 孩子日报**：是否同时保留两层？v3 建议保留孩子级 + 家庭聚合。
7. **iPad 交接方式**：签名短码/二维码/手动输入？v3 建议签名短码，P3。
8. **历史数据归属**：单孩子家庭是否可自动归属？v3 建议仍要显式确认。
9. **AI 标识文案**：用“AI 建议”还是“智能建议”？需与合规/产品统一。
10. **预算数字**：每日调用次数/token 上限，需要按真实家庭量级测算。

---

## 14. 附录 A：v2 勘误表

| v2 位置 | 原文/含义 | 修正 |
|---|---|---|
| §3.1 | `tutorStore.js:47-67` | 实际 storageKey 在 `61-64`；行号仅定位用 |
| §3.2 | 复测判分 `169-195` | 实际 `170-203` |
| §3.2 | 只列 `tutorSync/webAdminWrite` 旁路 | 还有客户端 `addEvidence`、生成阶段下发答案 |
| §3.3 | `tutorSync/webAdminWrite` 身份覆盖 | 还包括 `tutorChat/tutorRetest` 空 openid 写入 |
| §3.5 | “webAdminQuery 全量扫描” | 有 4000 条封顶、按 openid 过滤；仍是整集合聚合 |
| §5.1 第 7 步 | 完成一条即 `stale/superseded` + 新 revision | 改为当天冻结 + 单条 patch；否则推荐 ID 漂移、成本放大 |
| §6.4 | `start_tutor` 支持 `mid` | 页面不读 `mid/planId`；需改页面或改契约 |
| §6.4 | `review_cards` 支持 `subject/unitId` | 页面无 `onLoad` 参数；参数会被忽略 |
| §7 | `generate_exam` “已注册的小程序页” | `examGen/examAnswer/examReport` 未注册；`examGallery` 跳转断链 |
| §8 | “新增家长凭证” | 已有 `web_portal_bindings`；应复用并拆分用途 |
| §11 | “测试必须调用真实云函数入口” | 与现有 mock 能力冲突；需先升级 mock |
| §12 | “规则系统可独立运行” | 打卡/结算/农场仍按当前孩子；需先修 §3.1 |

---

## 15. 附录 B：证据索引

**身份与多孩**

- `miniprogram/utils/tutorStore.js:61-64`：本地 key 仅 openid
- `cloudfunctions/tutorSync/index.js:96-122`：pull 仅按 openid
- `cloudfunctions/syncData/index.js:36-40,172-184`：仅当前孩子的打卡日志
- `cloudfunctions/dailyReset/index.js:48-52,78`：仅当前孩子的结算
- `cloudfunctions/examService/index.js:1998-2010`：iPad 读当前孩子
- `cloudfunctions/examService/index.js:2015-2059`：卡片/unitKps 按 openid
- `cloudfunctions/examService/index.js:1564,1864`：提交无 childId
- `cloudfunctions/webAdminQuery/index.js:216,402`：currentUser 兜底、openid 级口径
- `miniprogram/utils/orderKit.js:201-209`：planId 不含 childId

**证据**

- `cloudfunctions/tutorRetest/index.js:111-113`：生成返回答案
- `cloudfunctions/tutorRetest/index.js:117-121`：5 题/80% 阈值
- `cloudfunctions/tutorRetest/index.js:170-203`：客户端题目判分
- `cloudfunctions/tutorRetest/index.js:224-232`：漏接 evidenceClientId
- `miniprogram/pkgGuide/retest/retest.js:137-159`：客户端发送 evidenceClientId、本地 addEvidence
- `miniprogram/utils/tutorStore.js:346-363`：本地证据写入
- `cloudfunctions/tutorSync/index.js:131-146`：UTC 日键去重
- `cloudfunctions/tutorSync/index.js:310-336`：自动认领旧证据
- `cloudfunctions/webAdminWrite/index.js:114-118`：evidence 字段白名单含 passed

**权限**

- `miniprogram/utils/tutorGate.js:48-63`：只查绑定/孩子/计划
- `miniprogram/pkgGuide/order/order.js:84-90,293`：出单页无门禁
- `cloudfunctions/tutorOrder/orderActions.js:182,385`：by 来自客户端
- `cloudfunctions/webPortalBind/index.js:40-58`：长期明文令牌
- `cloudfunctions/webAdminQuery/index.js:637-672`：token 鉴权
- `cloudfunctions/examService/index.js:2581-2596`：iPad 复用网页令牌

**页面与动作**

- `miniprogram/app.json:8-40`：已注册页面清单（无 examGen/examAnswer/examReport）
- `miniprogram/pkgGuide/examGallery/examGallery.js:151-170`：跳转未注册页面
- `miniprogram/pkgGuide/retest/retest.js:34-40`：复测参数
- `miniprogram/pkgGuide/tutor/tutor.js:49-75`：导学参数（无 mid/planId）
- `miniprogram/pkgTools/cards/cards.js:29`：只有 onShow，无参数
- `miniprogram/pkgTools/plan/plan.js:56-65`：计划参数
- `miniprogram/pkgTools/unitKp/unitKp.js:42-50`：只读 subject

**容量与计划**

- `miniprogram/utils/pace.js:75-105,267-300`：精力/单节上限/周预算
- `miniprogram/utils/store.js:712-716`：getPaceSnapshot
- `miniprogram/pages/index/index.js:88-99`：今日课表
- `miniprogram/utils/studyPlan.js:1-22`：成长计划与打卡解耦
- `miniprogram/utils/planFeedback.js:1-20`：报告→计划反哺
- `miniprogram/pkgGuide/report/report.js:149`：addToPlan

**工具与部署**

- `scripts/mock-tcb.js:33,39-41`：limit 空操作
- `cloudbaserc.json:4-13`：仅 examService
- `cloudfunctions/dailyReset/config.json`：仅 00:05 触发器
- `miniprogram/utils/orderKit.js:113-116`：教学断言禁词
- `cloudfunctions/examService/index.js:107-117`：另一份禁词实现
- `compliance-check.md` §六：平台敏感词中性化记录（非代码过滤器）

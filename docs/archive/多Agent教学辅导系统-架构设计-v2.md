# 多 Agent 教学辅导系统 · 架构设计（v2 · 代码校准版）

> 日期：2026-10-28  
> 状态：依据当前仓库源码重新设计，尚未实施。  
> 基线：`miniprogram/`、`cloudfunctions/`、`web/`、《全科导学系统-全景说明》及原 v1 设计。  
> 说明：本文取代 v1 的实施口径，但不覆盖原文件；本次仅做只读代码核查，未连接线上数据库。

## 一、评审结论

**v1 的产品方向合理，技术契约不足以直接实施。** 应保留“Agent 提建议、确定性服务做判定、家长做审批、数学先试点”的路线，但必须先修复身份、证据和执行归因三个地基问题。

| v1 设计项 | 评审 | v2 处理 |
|---|---|---|
| Agent 不判分、不写证据 | 正确 | 保留，并进一步规定 Agent 不直接访问数据库，云函数校验后才落库 |
| 总控 + 学科 Agent | 合理，够用 | 采用逻辑 Agent，不为九科分别创建云函数；保留 `tutorChat` 作为导学 Agent |
| 总控计算欠账、额度和异常 | 部分不合理 | 数字、阈值、异常由规则引擎计算；总控 Agent 只排序、解释和提建议 |
| `openid+date+role+subject` 唯一 | 有碰撞且不支持多孩 | 当前文档与运行日志分离；当前键加入 `childId+kind`，运行日志按 attempt 保存 |
| 首开同步生成总控和三科计划 | 首屏慢、易重复调用 | 首页 `onShow` 读取缓存/当前文档，规则计划立即可用，AI 异步刷新 |
| 20:30 学科汇报、20:40 总控汇报 | 两个定时器无完成依赖 | 改为一个夜间编排入口，三科均到达成功或兜底终态后再汇总 |
| 按 `currentUserId` 隔离多孩 | 当前代码不支持 | 所有新读写使用服务端验证的 `openid+childId`；历史数据不得自动猜测归属 |
| 沿用现有家长角色门禁 | 前提不存在 | 新增家长凭证和短时会话，隐藏入口不算权限控制 |
| `actionRef.route` 由 Agent 给出 | 存在假路由和越权风险 | Agent 只能选动作枚举，服务端校验参数，客户端注册表映射真实页面 |
| 计划 vs 实际、采纳率、证据回流率 | 缺少关联键 | 全链路增加 `recommendationId`，从执行事实计算，不由 Agent 估算 |
| 90 天清理 `tutor_agent_runs` | 可以，但不能影响事实数据 | 只清理 Agent 审计记录；证据、会话、订单等按各自策略保留 |

### 已确认且不变的产品决策

1. 日报首先落在小程序「家长日报」页。
2. 总控只建议，不强制，不自动修改成长计划或教学计划。
3. 不输出能力掌握百分比；继续使用「有可验证证据 / 待巩固 / 证据不足 / 未开始」。
4. 今日计划首开惰性生成，夜间定时汇报。
5. 先数学、再语数英，预留九科；学习单签发始终由家长完成。

## 二、目标与非目标

### 2.1 目标

把现有“画像/计划 → 导学/练习 → 错题 → 复测 → 证据 → 报告”串成可追踪闭环：

- 每天给孩子一小组可执行推荐，而不是多个平行入口。
- 每条推荐都能追踪到点击、执行、结果及后续推荐变化。
- AI 不可用时，规则系统仍能独立给出计划、统计和日报。
- 多孩、跨端、重试、并发和跨日均不混淆数据。

### 2.2 非目标

- 不让 Agent 自由对话后自行决定数据库写入。
- 不建设通用 Agent 框架、消息总线或九套微服务。
- 不把打卡、导学、复习卡完成等同于证据。
- 不让试卷分数自动变成证据，不预测“遗忘率”或“掌握度”。
- 不在第一阶段改动农场激励、学习单状态机和现有判分阈值。

## 三、当前代码约束与前置阻断项

以下不是理论风险，而是当前源码中的实际约束。

### 3.1 P0：学习事实没有稳定的孩子归属

- 主数据按 `hw_farm_user.data.users[i]` 分孩子，但 `tutorStore` 的本地 key 只有 openid，导学集合也主要按 openid 查询。见 `miniprogram/utils/tutorStore.js:47-67`、`cloudfunctions/tutorSync/index.js:84-126`。
- `currentUserId` 是家庭镜像中的当前选择，不是历史事实的归属键；不能使用 `currentUserId || users[0]` 推断旧数据归属。
- 因此，Agent 在现状下读取的错题、证据、复习和订单可能混合多个孩子。

### 3.2 P0：证据尚无全系统单一权威

- `tutorRetest` 确实硬编码了至少 5 题、通过率至少 80%，见 `cloudfunctions/tutorRetest/index.js:116-121`。
- 但判分同时信任客户端回传的题目、标准答案和作答；服务端没有保存复测 attempt，见同文件 `169-195`。
- `tutorSync` 和 `webAdminWrite` 仍可写入 `evidence.passed`，可绕过复测入口，见 `cloudfunctions/tutorSync/index.js:229-250`、`cloudfunctions/webAdminWrite/index.js:103-118`。
- “独立作答”当前只是声明，不是可验证事实。系统只能记录“无实质提示 + 明确声明”的独立性依据，不能声称云端证明了孩子身边无人帮助。
- `evidenceClientId` 在 `tutorRetest` 主入口漏接，见 `cloudfunctions/tutorRetest/index.js:224-232`，现有去重契约不完整。

### 3.3 P0：写入身份与权限需要先收口

- `tutorSync` 新增时 `Object.assign({openid}, doc)` 允许客户端字段覆盖服务端 openid；`webAdminWrite` 也有同类模式。必须先剥离客户端 `openid/_openid/childId`，再由服务端重建作用域。
- 小程序 `tutorGate` 只检查绑定、孩子、计划，不区分家长和孩子，见 `miniprogram/utils/tutorGate.js:48-63`。
- 家长日报需要独立权限，不得复用该功能门禁冒充角色门禁。

### 3.4 P1：推荐无法形成可靠执行归因

- 复测页现有参数是 `subject/key、topic、errorType、mid`，不是 v1 的 `kp/mistakeRef`，见 `miniprogram/pkgGuide/retest/retest.js:33-54`。
- 导学页虽然支持任务和错题上下文，但缺少稳定的 `recommendationId`，部分入口还缺 `mid/si/ti`。
- 没有关联键，就不能可靠计算 `planned/done`、推荐采纳率、证据回流率，也无法保证“次日推荐因结果而变化”。

### 3.5 P1：计划、状态和统计口径需要统一

- `cards.done` 只能表示复习卡进度，不能与 `tutor_evidence.passed` 混称为掌握。
- 错题 `corrected`、复习 `done`、订单回执、试卷提交和复测证据是不同事实，状态读取器必须分别建模。
- 不应让 Agent 复用 `webAdminQuery` 的全量扫描聚合作为高频读模型；应使用按作用域索引的专用 StateReader。

## 四、总体架构

```text
微信小程序                 iPad ExamPad                网页看板/工作台
   │                          │                           │
   │ openid + childId         │ 绑定身份 + childId         │ 家长口令 + childId
   ▼                          ▼                           ▼
─────────────────────────────────────────────────────────────────
                     接入与作用域校验
        服务端生成 openid｜验证 childId 属于该家庭｜家长会话
─────────────────────────────────────────────────────────────────
                             │
                             ▼
                Learning StateReader（确定性）
     画像/计划/教材｜错题/复习卡｜复测/证据｜试卷提交｜订单/打卡
                             │
                             ▼
                Policy Engine（确定性，无 AI）
   欠账与异常｜候选任务｜总额度硬上限｜规则计划｜统计事实｜兜底文案
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
       Supervisor Agent               Subject Planner Agent
   跨科排序/家长解释/日报           单科推荐/单科解释/次日建议
              │                             │
              └──────────────┬──────────────┘
                             ▼
                Schema + Action Registry 校验
                             │
                             ▼
                今日推荐 current document
                             │
                             ▼
       执行服务（现有能力改造后复用，携带 recommendationId）
 tutorChat 导学 Agent｜tutorRetest｜examService｜cards｜tutorOrder
                             │
                             ▼
       学习事实集合（唯一权威） → StateReader → 下一轮推荐
```

### 4.1 组件职责

| 组件 | 性质 | 职责 | 不得做什么 |
|---|---|---|---|
| ScopeGuard | 确定性 | 解析 openid、校验 childId、验证家长会话、重建写入作用域 | 不信任客户端身份字段 |
| Learning StateReader | 确定性 | 生成带 `stateHash` 的孩子级学习快照 | 不生成教学建议，不修改事实 |
| Policy Engine | 确定性 | 计算候选、欠账、异常、额度上限、规则计划和统计 | 不调用模型 |
| Supervisor Agent | 无状态 LLM | 在硬上限内提出跨科优先级、解释异常、组织日报 | 不改计划、不判证据、不编造数字 |
| Subject Planner Agent | 无状态 LLM | 从候选中选择单科行动并生成孩子可理解的理由 | 不自由创建路由、不跨科调度 |
| Tutor Agent（现有 tutorChat） | 无状态 LLM + 会话输入 | 按推荐上下文导学，输出诊断建议 | 不直接判定证据或独立完成 |
| Action Registry | 确定性 | 校验动作和参数、映射真实页面、执行前再检查目标状态 | 不接受模型任意 URL/云函数名 |
| Execution Services | 确定性写入边界 | 执行、判分、保存事实、回传 recommendationId | 不让模型绕过写入契约 |

**通信方式：** 只允许编排器与 Agent 之间传递版本化 JSON，不做 Agent 间自由消息广播。所有 Agent 无状态，记忆来自学习事实和当前文档。

## 五、核心流程

### 5.1 今日计划：规则先行，AI 异步增强

1. 小程序首页 `onShow` 获取当前 `childId`；不在 `App.onLaunch` 阻塞启动。
2. 本地有当日计划则立即展示；没有则展示本地/云端规则候选，不出现长时间空白。
3. 云端 StateReader 读取快照并计算 `stateHash`；Policy Engine 生成确定性候选、额度和规则版 directive。
4. 若当日当前文档有效且 `stateHash` 未变，直接返回；否则创建同一 `requestId` 的幂等任务。
5. Supervisor Agent 只调整优先级和说明；Subject Planner Agent 分科生成少量推荐。
6. 服务端完成 schema、语言、额度、动作白名单校验后写当前文档；任一步失败则使用规则版并标记 `fallback=true`。
7. 新执行结果会改变 `stateHash`。旧计划标记 `stale/superseded`，新计划新增 revision，不改写历史运行记录。

**负荷约束：** 三科合计首页展示 3–5 条，不再理解为“每科 3–5 条”。每科通常 1–2 条；总题量和总时长由规则引擎按画像和剩余时间截断，Agent 不得突破。

### 5.2 推荐执行与结果回流

1. 每条推荐获得服务端生成的 `recommendationId`，并绑定 `openid+childId+date+subject+action+target`。
2. 点击时 Action Registry 再验证目标：错题是否仍待处理、复习是否仍到期、计划任务是否仍存在。
3. 页面和云函数透传 `recommendationId+childId`；事实记录保存该关联：
   - 复测：`tutor_retest_attempts` 与 `tutor_evidence`；
   - 导学：`tutor_sessions`，诊断错题保留来源会话和推荐；
   - 试卷：`tutor_exam_submissions`；
   - 复习卡/学习单：各自进度或事件记录。
4. `done` 表示对应执行已有终态事实，不表示形成证据；`evidenceProduced` 只统计 `passed=true` 且满足独立性策略的证据。
5. StateReader 下次读取新事实，规则引擎移除已完成候选或调整优先级，Agent 无需“记住”上次对话。

### 5.3 复测证据的权威流程

新增 `tutor_retest_attempts`：

1. `generate` 在服务端保存题目、标准答案、学科、错题、孩子、推荐、提示事件和过期时间；只向客户端返回不含答案的题目与 `attemptId`。
2. `submit` 只接收 `attemptId+answers+independenceDeclaration+childId+recommendationId`，从服务端读取标准答案判分。
3. 证据通过条件由代码统一判断：题数 ≥5、正确率 ≥80%、未使用实质提示且完成独立性声明。提示后完成仍可保存为活动/尝试，但不形成独立证据。
4. 只有复测领域服务可以写 `tutor_evidence`；`tutorSync` 和 `webAdminWrite` 删除证据判定字段的写权限。
5. 证据、复习窗口和错题状态使用同一 attemptId 做幂等；多集合写入失败必须可补偿重放，不得静默成功。

独立性记录建议为 `independence: self_declared_no_hint | prompted | unknown`，它是证据来源说明，不宣称证明线下环境。

### 5.4 夜间日报：单入口编排

- 一个 20:30 定时入口调用 `tutorSupervisor.nightly`，按家庭/孩子分批处理。
- 每个作用域先由规则引擎计算事实统计，再并发生成学科解释；并发数设上限。
- 每科必须到达 `succeeded` 或 `fallback` 终态；缺失、超时不得被当作零活动。
- 三科终态后，总控生成 dailyReport；AI 失败则由规则统计直接组成日报。
- 日报中的 `tomorrowFocus` 只是建议。次日首开仍重新读取状态，不沿用夜间预先冻结的 directive。
- 所有业务日期统一使用 `Asia/Shanghai`，文档显式保存 `date` 和 `timezone`。

## 六、数据设计

### 6.1 统一作用域

所有新接口和新写入至少包含：

```js
{
  schemaVersion: 'agent-v2',
  openid,                 // 只能由服务端身份上下文生成
  childId,                // 必填，且必须属于该 openid 的 users[]
  actor: 'child' | 'parent' | 'system',
  requestId,              // 客户端/编排器幂等键
  occurredAt,
  timezone: 'Asia/Shanghai'
}
```

禁止使用 `users[0]` 兜底归属。历史 `tutor_*` 没有 childId 时进入“待确认历史数据”，由家长一次性映射；不得按当前孩子静默回填。单孩子家庭也需显式确认迁移。

本地 `tutorStore` 逐步改为 `openid+childId` 命名空间；guest 数据只能在家长确认孩子归属后迁移，不能默认并入当前孩子。

### 6.2 Agent 数据拆成两类集合

**`tutor_agent_current`：当前可读快照**

- 唯一逻辑键：`openid+childId+date+kind+subject`。
- 使用确定性 `docKey` 作为文档 `_id` 或等效原子 upsert，避免“先查再 add”。
- `kind` 包含 `directive/dayPlan/subjectReport/dailyReport`，因此 directive 与 dailyReport 不再碰撞。
- 保存最新成功 revision；旧状态标记 superseded，客户端只读当前有效版本。

**`tutor_agent_runs`：运行审计（完成后不可变）**

- 每次执行尝试一条，包含 requestId、runId、输入摘要、stateHash、状态、错误码、模型和耗时；运行中只允许推进状态，成功后 payload 不再改写。
- force 刷新产生新 attempt，不覆盖旧记录；相同 requestId 重试返回同一逻辑结果。
- 默认保留 90 天，只清理本集合；不清理 current 中被引用的有效文档，也绝不清理学习事实。

公共字段：

```js
{
  _id, openid, childId, date, timezone,
  role: 'supervisor' | 'subject' | 'orchestrator',
  subject: 'math' | 'chinese' | 'english' | '-',
  kind: 'directive' | 'dayPlan' | 'subjectReport' | 'dailyReport',
  revision, stateHash, schemaVersion: 'agent-v2',
  status: 'running' | 'succeeded' | 'fallback' | 'failed' | 'stale',
  fallback, fallbackReason,
  model, promptVersion, requestId, runId, traceId,
  payload, createdAt, updatedAt
}
```

### 6.3 四类产物契约

**directive**

```js
{
  hardLimits: { totalItems, totalMinutes }, // 规则计算，Agent 不可改写
  quotas: [{ subject, priority, maxItems, maxMinutes, reasonCode }],
  focus: 'math',
  alerts: [{ type, subject, factRef, detail }],
  generatedBy: 'agent' | 'rule'
}
```

**dayPlan**

```js
{
  recommendations: [{
    recommendationId,
    type: 'retest' | 'practice' | 'review' | 'new_lesson' | 'blindsweep',
    subject, knowledgePoint,
    targetRef: { mistakeId?, unitId?, kpId?, planId?, si?, ti? },
    estimatedItems?, estimatedMinutes?,
    reason,                       // 孩子视角，限长
    action: { name, params }      // 只能来自 Action Registry
  }],
  summary
}
```

**subjectReport**

```js
{
  facts: {
    planned, started, done,
    retestAttempts, evidenceProduced,
    pending: [{ knowledgePoint, status: '待巩固' | '证据不足' }]
  },
  interpretation: { issues: [], tomorrow: [] },
  dataCompleteness: 'complete' | 'partial'
}
```

`facts` 只能由 StateReader/Policy Engine 填写；Agent 只生成 `interpretation`，服务端合并。

**dailyReport**

```js
{
  headline,
  bySubject: [{ subject, planned, done, retestAttempts, evidenceProduced, note }],
  quality: { adoptionRate, completionRate, evidenceReturnRate },
  issues, improvements, tomorrowFocus, alerts,
  dataCompleteness: 'complete' | 'partial'
}
```

`evidenceReturnRate` 的分母只包含已执行且具备复测条件的推荐，不能把所有导学/打卡都当作应产证据任务；它只是流程指标，不是能力指标。

### 6.4 Action Registry

| action.name | 客户端真实目标 | 必要参数 | 阶段 |
|---|---|---|---|
| `start_retest` | `/pkgGuide/retest/retest` | subject/topic/errorType/mid/recommendationId/childId | P1 |
| `start_tutor` | `/pkgGuide/tutor/tutor` | subject + mid 或 planId/si/ti + recommendationId/childId | P1 |
| `review_cards` | `/pkgTools/cards/cards` | subject/unitId?/recommendationId/childId | P2 |
| `open_plan` | `/pkgTools/plan/plan` | subject/childId | P2 |
| `generate_exam` | iPad GenerateSheet 或已注册的小程序页 | scope/questionTypes?/recommendationId/childId | P3 |

模型不得输出页面 URL。`diagnoseBlindSpot` 是状态分析能力，不是可直接跳转的页面；blindsweep 必须转成上述可执行动作。

## 七、云函数与现有模块改造

| 模块 | 新接口/改造 | 说明 |
|---|---|---|
| `tutorPlanner`（新） | `getToday/generate/reportSubject` | 共用 StateReader、规则兜底、学科 prompt；按 subject 形成逻辑 Agent |
| `tutorSupervisor`（新） | `getDirective/generateDirective/nightly/getDailyReport` | 规则计算总控输入，统一夜间编排，不在网页查询中实时调 AI |
| `agentKit`（新共享模块） | scope/schema/actionRegistry/policy/aiGateway/clock | canonical + 哈希同步测试，禁止各函数复制后漂移 |
| `tutorRetest` | attempt 化、服务端判分、childId、证据单写者 | 保留 5 题/80% 阈值，修复 clientId 与重试幂等 |
| `tutorSync` | 所有查询/写入增加 childId；剥离身份字段；禁止推 evidence | 返回逐条失败，不得部分失败后仍让客户端清整批队列 |
| `tutorChat` | 接收 recommendationId/mid/完整计划锚点 | Agent 提诊断，确定性归档服务写事实；更新必须校验 openid+childId |
| `examService` | 出卷、提交、错题、盲区读取增加 childId/recommendationId | 试卷成绩仍是活动结果，不自动写证据 |
| `tutorOrder` | 增加 childId/recommendationId，保留 order-v1.1 状态机 | 学习单仍由家长签发，Agent 不代签 |
| `webAdminQuery` | 新增 `dailyReport/dayPlan` 只读模块 | 按 token→openid，再按 childId/date 精确读取；不调 AI |
| `webAdminWrite` | 移除 evidence 判定字段写权限 | 保留画像、教学计划等受控写入及 F14 时间戳 |

AI Gateway 统一负责：超时、有限重试、持久化频控、schema 校验、prompt/model 版本、成本与耗时指标。教材、教学计划、错题文本和孩子输入均视为不可信上下文，只能作为数据引用，不能覆盖系统指令。

## 八、权限、隐私与语言边界

1. **身份：** openid 永远由服务端解析；客户端提交的 openid/_openid/childId 不直接信任，childId 必须经家庭成员关系验证。
2. **家长日报：** 新增家长 PIN 或等效凭证，云端验证后签发短时 parentSession；日报页和云端读取均校验。前端隐藏入口不是安全措施。
3. **最小化模型输入：** 默认只发送结构化摘要、Top N 候选和必要知识点，不发送完整对话、姓名、学校、图片、原始作答或密钥。
4. **最小化日报输出：** 不返回 prompt、原始消息、标准答案、内部密钥和完整错题正文。
5. **语言：** 使用拒绝式禁词校验，命中“已掌握/精通/能力百分比”等表述则整份 AI 产物无效并走规则兜底；过程完成率可保留，但必须标注为过程指标。
6. **事实与解释分离：** “完成 2 条、产生 1 条证据”来自数据库；“粗心有所改善”没有充分事实时不得生成。

## 九、降级、并发与可观测性

### 9.1 降级链

- StateReader 失败：返回明确 `state_unavailable`，不能把查询异常显示成“没有错题/没有活动”。
- Supervisor 失败：使用规则 directive；只损失跨科措辞，不损失额度和候选。
- Subject Agent 失败：使用规则 dayPlan，保证有到期复习/待处理错题时仍有可执行推荐。
- SubjectReport 失败：保留完整 facts，省略解释段并标 fallback。
- DailyReport 失败：输出规则日报，标注数据完整性；不得伪造“问题与改进”。

### 9.2 幂等与并发

- 当前文档用确定性 docKey；运行日志用 requestId+attempt 标识。
- 相同请求重试返回现有结果；force 必须新 requestId。
- 不复制现有“查重后 add”作为并发保证；使用确定性文档 ID、原子 upsert/CAS 或数据库唯一约束。
- 复测提交、订单状态变更和跨集合联动都必须可重放，部分失败返回明确状态，不静默成功。
- 当前 revision 只在 stateHash/revision 符合预期时替换，防止旧 AI 结果覆盖新执行事实。

### 9.3 观测字段

记录 requestId/traceId、stateHash、schema/prompt/model 版本、耗时、fallbackReason、作用域和产物数量。日志默认不记录完整 prompt 和儿童原文。

## 十、分阶段实施

### P0：数据可信地基（未完成前不上 Agent）

1. childId 进入本地存储、所有 tutor_* 查询/写入、试卷提交和网页查询；制定历史数据确认迁移。
2. 修复 openid 覆盖、空 openid 写入、按 _id 更新不验归属等权限问题。
3. 复测 attempt 化；证据单写者；关闭 tutorSync/webAdminWrite 证据旁路。
4. 新增家长凭证与 parentSession；统一 Asia/Shanghai 日期。
5. 建立 ScopeGuard、统一事实字段和必要索引。

**出口标准：** 多孩隔离、证据绕过、越权、重试和跨日测试全部通过。

### P1：数学规则闭环（先不接新 Agent）

1. 建 StateReader + Policy Engine + 规则 dayPlan。
2. 首页数学推荐卡，复测/导学按 Action Registry 直达。
3. recommendationId 贯穿执行事实，能计算 planned/started/done/evidenceProduced。
4. 连续 5 天验证“推荐 → 执行 → 事实回流 → 次日推荐变化”。

**出口标准：** 无 AI 也能闭环，归因数字可手工对账。

### P2：多 Agent 试点与三科铺开

1. 数学 Subject Planner 先影子运行，与规则计划比较，不影响执行。
2. 接入 Supervisor 和数学家长日报；验证 fallback、语言和负荷上限。
3. 扩至语文/英语，夜间单入口编排三科日报。
4. 保留原手动场景矩阵作为手动模式，不删除现有能力。

**出口标准：** Agent 不修改事实、不突破额度；AI 停用时规则闭环无回归。

### P3：外部入口与减法

- 看板/工作台接 dayPlan/dailyReport，并补全现有 CloudSyncPayload 映射。
- iPad 增加“按今日推荐出卷”，提交回传 recommendationId。
- 小程序试卷生成动作只有在页面注册与路由测试完成后才开放。
- 根据采纳数据减少重复入口，而非提前删除手动模式。

## 十一、测试与验收

### 11.1 必写测试

1. **作用域：** 同 openid 两个孩子完全隔离；其他家庭不可读；禁止 users[0] 归属兜底。
2. **权限：** 客户端伪造 openid/childId 无效；空 openid 不可写；家长日报无 parentSession 不可读。
3. **证据：** tutorSync/webAdminWrite 无法写 passed；客户端不能改标准答案；提示后完成不形成独立证据。
4. **幂等：** `Promise.all` 同键并发只产生一个当前文档和一个逻辑 attempt；force 保留历史 revision。
5. **归因：** 每条执行事实能回链 recommendationId；planned/done/evidenceProduced 可重算。
6. **动作：** 非白名单 action、非法 mid/si/ti、跨孩子 targetRef 全部拒绝；执行前过期目标有明确提示。
7. **schema/语言：** 缺字段、错类型、超长、禁词、模型附加指令均走兜底。
8. **夜间编排：** 单科失败、定时器重入、跨 UTC+8 午夜、部分数据时日报口径正确。
9. **降级：** AI 超时、资源包不足、数据库异常均不伪装成空数据，规则计划仍可用。
10. **隐私/保留：** 模型输入不含非必要儿童原文；90 天清理不影响事实和有效当前文档。

测试必须调用真实云函数入口，不能只手工插入“预期正确”的文档；内存 mock 需补齐 limit、文档 get、原子 upsert 和唯一键语义。

### 11.2 产品验收指标

- 首屏规则推荐可见耗时、AI 增强完成耗时分别统计。
- 推荐点击率、开始率、完成率；分母和去重口径固定到 recommendationId。
- 可复测推荐的证据回流率；不把该指标解释为能力增长。
- 规则兜底率、schema 失败率、重复写入数、跨孩子越权数。
- 家长日报打开率及“调整计划/签发学习单”的后续行动率。

上线硬门槛是**零跨孩子串数据、零证据旁路、零 Agent 直接事实写入**；“兜底率 <20%”作为稳定期优化目标，不替代正确性验收。

## 十二、最终实施口径

- 多 Agent 的核心不是增加模型调用次数，而是让**规划、导学、执行、证据、汇报各自有明确权限**。
- 规则系统是可独立运行的主系统，Agent 是可替换的增强层，而不是数据真相源。
- 先建立 `openid+childId` 和证据单写者，再做推荐归因，最后接 Agent；顺序不可颠倒。
- 保持现有三端与集合渐进改造，不做一次性重写；每个阶段都必须可回退到当前手动流程。

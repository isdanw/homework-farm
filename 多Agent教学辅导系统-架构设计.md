# 多 Agent 教学辅导系统 · 架构设计（v1 · 已确认 4 项决策）

> 状态：需求已对齐（2026-10-28），未开始编码。本文为实施依据。
> 已确认决策：①日报=小程序内「家长日报」页 ②总控只建议不强制 ③掌握度沿用证据阶梯不出百分比 ④计划首开惰性生成 + 夜间定时汇报。

---

## 一、设计铁律（先立规矩，再谈架构）

1. **Agent 负责"想"，确定性服务负责"算"，家长负责"批"。** Agent 输出决策与语言；判分、证据门槛、复习窗口、题量口径全部走现有确定性代码。
2. **Agent 无状态。** 记忆全在数据库，每次运行"读状态 → 产出结构化 JSON"，不依赖对话历史维持人设。保证可审计、可回放、成本可控。
3. **四条写入通道互不越界**：总控只写 directive；学科只写 dayPlan/subjectReport；日报只由总控写；学习数据（活动/证据/错题/复习）永远只由执行层写。
4. **每层必须有确定性兜底**：Agent 失败/超时/schema 不合法 → 降级为规则产物，用户无感知。
5. **不出现"掌握度/已掌握"**：学科 Agent 只允许表达「有可验证证据 / 待巩固 / 证据不足 / 未开始」四态，沿用现有语言门禁词表。

---

## 二、角色与职责

| 角色 | 输入 | 决策/产出 | 明确禁止 |
|---|---|---|---|
| **总控 Agent**（教导主任） | 三科 subjectReport + 证据/错题/窗口汇总 + 成长计划 + 教学计划 | `supervisorDirective`：每科每日额度（题量/时长）、优先级、异常标记；`dailyReport`：家长日报 | 不给孩子直接下指令、不判分、不定掌握、不改画像/计划 |
| **学科 Agent**（学科老师） | directive + 学科画像 + 教材目录 + 教学计划 + 到期窗口 + 待处理错题 + 近 7 天证据 | `dayPlan`：3–5 条推荐（type/what/why/actionRef）；`subjectReport`：计划 vs 实际、问题、明日建议 | 不判证据、不推进复习窗口、不签发学习单、不跨科调度 |
| **执行层**（已有） | dayPlan.actionRef 参数 | 出卷 gen / 复测 tutorRetest / 盲区 diagnoseBlindSpot / 复习窗口 / 教材锚定 | 不产出教学计划与话术 |
| **家长（你）** | dailyReport | 签发学习单、改成长计划/教学计划、开关科目、暂停某科 | — |

---

## 三、每日主流程（时间轴）

| 时点 | 触发 | 动作 | 产物 |
|---|---|---|---|
| 当日首次打开（惰性） | 小程序 onLaunch | 总控：算各科欠账（到期窗口数、待处理错题数、连续未达标天数、计划完成率）→ 分配额度与优先级 | `supervisorDirective`（缓存当日） |
| 紧随 | 同上 | 学科 Agent（每科一次，可并发）：生成 dayPlan | `dayPlan` |
| 白天 | 孩子点推荐 | 执行层执行 → 判分 → 证据落库（契约不变） | 活动/证据 |
| 20:30 | 云函数定时器 | 学科 Agent 对照 dayPlan 生成 subjectReport | `subjectReport` |
| 20:40 | 同上（串行） | 总控汇总三科 + 质量指标 → 明日 directive 预生成 + dailyReport | `dailyReport` |
| 任意时点 | 事件 | 连续 3 天未达标 / 错题堆积 > 阈值 / 计划偏离 > 50% / 教材或教学计划变更 → 总控异常标记，日报置顶 | 异常标记 |

**降级链**：学科 dayPlan 失败 → 规则版 dayPlan（interval-v2 到期窗口 + 待处理错题按优先级排序，= 现有工作台今日页口径）；subjectReport 失败 → 由活动/证据数据直接生成统计段，跳过"问题与改进"叙述；总控失败 → 规则汇总（三科数字 + 无建议）。

---

## 四、数据契约

统一落 **一个集合 `tutor_agent_runs`**，`openid + date + role + subject` 唯一（role=supervisor 时 subject='-'），避免三套集合契约分裂。

```js
{
  _id, openid, date: '2026-10-28',
  role: 'supervisor' | 'subject',
  subject: 'math' | 'chinese' | 'english' | '-',
  kind: 'directive' | 'dayPlan' | 'subjectReport' | 'dailyReport',
  payload: {...},            // 见下
  model: 'hy3', promptVersion: 'agent-v1',
  fallback: false,           // true=规则兜底产物
  createdAt, updatedAt
}
```

**supervisorDirective.payload**
```js
{
  quotas: [{ subject:'math', priority:1, targetItems:12, note:'到期窗口2个' }],
  focus: 'math',                        // 今日主攻
  alerts: [{ type:'evidence_stall'|'mistake_pileup'|'plan_drift'|'plan_change', subject, detail }],
  generatedBy: 'agent'|'rule'
}
```

**dayPlan.payload**（3–5 条，理由必须孩子能看懂）
```js
{
  recommendations: [{
    type: 'retest'|'practice'|'review'|'new_lesson'|'blindsweep',
    knowledgePoint, mistakeRef?, items?,
    reason,                              // ≤40字，孩子视角
    actionRef: { route:'retest'|'gen'|'review'|'tutor', params:{...} }
  }],
  summary                              // 给家长的一句话
}
```

**subjectReport.payload**
```js
{
  planned: n, done: m,
  evidenceProduced: k,                 // verifiable_evidence 新增数
  pending: [{ knowledgePoint, status:'待巩固'|'证据不足' }],
  issues: ['竖式进位连续错'],
  tomorrow: ['口算变式 5 题']
}
```

**dailyReport.payload**
```js
{
  headline,                            // 一句话
  bySubject: [{ subject, planned, done, evidence, note }],
  quality: { planDoneRate, evidenceReturnRate, stallSubjects:[] },  // 过程指标，非能力指标
  issues, improvements,                // 今日问题 / 已做改进
  tomorrowFocus,
  alerts: [...]                        // 需要家长决策的事项
}
```

---

## 五、云函数与调用参数

| 函数 | action | 入参 | 说明 |
|---|---|---|---|
| `tutorSupervisor`（新） | `directive` | `{date, force?}` | 读三科状态 → 写 directive；幂等：当日已存在且非 force 直接返回 |
| | `report` | `{date}` | 读当日 subjectReport + 活动/证据 → 写 dailyReport |
| `tutorPlanner`（新） | `plan` | `{subject, date}` | 读 directive+画像+教材+窗口+错题 → 写 dayPlan |
| | `dailyReportSubject` | `{subject, date}` | 生成 subjectReport |
| 复用（不动） | — | — | `tutorRetest` / `examService(gen,genUnitReview,diagnoseBlindSpot)` / `studyPlanGen` / `tutorChat` |

- 单次上下文压缩到 ≤3000 token：近 3 天证据摘要 + 到期窗口 Top5 + 待处理错题 Top5 + 教材当前单元 + 教学计划≤1500 字。
- 频控：规划每科每日 1 次（force 手动刷新限 3 次/日）；汇报每日 1 次。

---

## 六、页面交互改动

**小程序**
1. `pages/index/index`：顶部新增「今日推荐」卡（每科一条：为什么 + 开始）。点开始 → 按 `actionRef.route` 直达执行页，参数预填，跳过配置抽屉。卡片带"今日额度"小字（来自 directive）。
2. 新增 `pkgGuide/dailyReport/dailyReport`：**家长日报页**（入口放 `mine` + 首页家长区）。展示 headline / 三科进度 / 今日问题与改进 / 明日重点 / 需决策事项；底部「调整计划」「签发学习单」跳转现有页。
3. `pkgGuide/retest`：支持外部参数直达（kp/mistakeRef 预填），流程与结果页零改动。
4. `pkgTools/plan`：加一行"你的计划会影响每日推荐"，不改编辑能力。
5. 任务页场景矩阵与多步抽屉：保留为「手动模式」，视觉降级，不删。

**网页看板 / 工作台（二期）**
- 看板新增「日报」只读 tab（复用现有口令体系）；工作台今日页后续接 dayPlan（需扩 CloudSyncPayload，属已知缺口④的收口动作，与工作台侧同步排期）。

**iPad（三期，可选）**
- `GenerateSheet` 支持"按今日推荐出卷"快捷入口，题型配比逻辑不变。

---

## 七、守卫与验收

**必写测试（沿用 `scripts/test-*.cjs` 模式）**
1. schema 校验：四类产物字段缺失/类型错 → 判为无效并走兜底；
2. 兜底等价性：dayPlan 兜底输出 = 规则推荐（到期窗口+待处理错题），不出现空计划；
3. 语言门禁：四类产物文本不含「掌握/精通/百分比」词表；
4. 幂等：同 openid+date 重复调用只产生一条记录；
5. 越权：学科 Agent 产物不得写入 evidence/activities 集合（静态断言写入通道白名单）。

**分阶段**
- **P0 后端**：两云函数 + `tutor_agent_runs` 集合 + 兜底 + 上述 5 类测试。
- **P1 数学试点**：首页推荐卡（数学）+ retest 直达 + 日报页（仅数学段）。验收：连续 5 天跑通"推荐→执行→证据回流→次日推荐变化"。
- **P2 三科铺开 + 总控**：三科 dayPlan、subjectReport、总控 directive + 家长日报全量。
- **P3 减法与外部**：手动入口降级、看板日报 tab、iPad 快捷出卷。

**验收指标**：①打开后 30 秒内进入执行的比例；②推荐采纳率；③证据回流率（采纳推荐中产生 verifiable_evidence 的比例）；④兜底触发率 <20%；⑤日报打开率。

---

## 八、按默认执行、未单独确认的细节

| 项 | 默认 |
|---|---|
| 学科范围 | 先 3 科（数学/语文/英语），预留 9 科键位 |
| 每科每日推荐条数 | 3–5 条，按额度上限截断 |
| 总控能否改成长计划/教学计划 | 不能，只提建议；改动永远由家长手动 |
| 多孩 | 沿用 `currentUserId`，日报/计划按孩子隔离 |
| 日报长度 | 一屏三段（今日 / 问题与改进 / 明日），正文 ≤400 字 |
| 孩子能否看日报 | 不能（家长专属路由，沿用现有角色门禁） |
| 历史保留 | tutor_agent_runs 保留 90 天，超期归档删除（定时任务） |

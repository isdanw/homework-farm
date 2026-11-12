# 学科 Agent 化改造设计（v1 草案，待确认）

> 目标：把"用户点菜单告诉系统做什么"反转为"学科 agent 决定做什么、怎么做"。
> 原则：**agent 只决定行动建议，不判定证据**；判分/证据/复习窗口契约一行不动；UI 做减法不做推翻。

---

## 一、现状与目标的流程对比

```
现状（人编排）：
用户打开页面 → 点场景入口/抽屉 → 手动配置(学科/章节/题量/配比)
  → 组装上下文调云函数 → 执行(复测/出卷/复习) → 证据落库
  → 用户自己决定下一步

目标（agent 编排）：
打开小程序 → 今日推荐卡片（agent 输出：做什么+为什么+依据）
  → 一键进入执行页（参数已带好）→ 证据落库（契约不变）
  → 明日规划自动消费昨日证据 → 飞轮
```

关键洞察：**执行层已经完备**（retest 页、作答页、复习页、判分云函数），缺的是决策层。本次改造=新增决策层 + 把现有执行能力注册为 agent 工具。

---

## 二、后端改动

### 2.1 云函数：新增 `tutorPlanner`（或 tutorChat 新增 action `planDay`）

**V1（推荐先做）：单轮规划器，无工具循环，控成本控幻觉**

```
输入（云端自读，改变现在"客户端组装上下文"的薄云模式）：
  subject, grade, date
  云端读取（已有集合/函数，只读不改）：
    - hw_farm_user.data.users[i].subjectProfiles[key]  → textbookId/teachingPlan/画像
    - tutor_mistakes（待处理错题, E1–E9）
    - tutor_reviews（到期复习窗口, stage）
    - tutor_evidence（近7天证据记录）
    - unitKps + 复习卡毕业态
输出（结构化 JSON，schema 校验）：
  dayPlan: {
    date, subject,
    recommendations: [{
      type: 'retest'|'practice'|'review'|'new_lesson'|'blindsweep',
      knowledgePoint, mistakeRef?, reason(孩子能看懂的一句话),
      actionRef: { tool:'tutorRetest.generate'|'gen'|..., params:{...} }
    }],
    summary  // 给家长的一段话
  }
```

- hy3 单次调用，输入压缩到 ≤3000 token（近3天证据摘要+到期窗口+前5错题，不喂全量）。
- schema 校验失败 / 超时 → **确定性兜底**：`interval-v2` 到期窗口 + 待处理错题按规则排序生成 dayPlan（等价于现在工作台"今日页"的规则推荐，零回归）。
- 频控：每学科每日 1 次规划，落缓存；家长手动刷新限 3 次/日。

**V2（验证后再做）：工具循环**
- hy3 若不支持可靠 function calling，则不硬上——用"规划器输出 actionRef → 前端确认执行"的半自动模式长期运行也成立。
- 工具注册表（全部包装现有 action，不写新逻辑）：`tutorRetest.generate`、`gen`、`genUnitReview`、`diagnoseBlindSpot`、`studyPlanGen`、复习窗口查询。

### 2.2 铁律：不动的东西

| 契约 | 位置 | 说明 |
|---|---|---|
| 证据门槛 ≥5/≥80%/独立 | `tutorRetest` RETEST_COUNT/PASS_RATE | agent 无权判定证据，只能建议发起复测 |
| 活动≠证据≠掌握 | 前端文案 + 语言门禁 | dayPlan 的 reason 里禁写"掌握"类词（沿用门禁词表） |
| 复习窗口推进只由复测证据驱动 | tutorRetest 联动逻辑 | agent 推荐不改变 stage/dueAt |
| order-v1.1 状态机 | tutorOrder | 学习单仍须家长签发，agent 只产草稿 |

### 2.3 数据契约改动（最小）

- dayPlan 落新集合 `tutor_dayplans`（openid+date+subject 唯一），或复用 tutor_sessions 加 type 标记——**倾向新集合**，避免污染会话流。建集合走 ensureCollection 双保险，写入走 `addOnce`（examService 写入安全铁律）。
- `subjectProfiles[key]` 不加字段（agent 状态由 dayPlan 历史即可推导）；若确需"上次规划时间"，加 `_ts.lastPlanAt`（走 F14 白名单同口径）。

---

## 三、页面交互改动（小程序为主）

### 3.1 首页 `pages/index/index`（核心改动）

- 现状：学科打卡入口矩阵。
- 改为：顶部新增「今日推荐」卡片（每学科一条 agent 建议：图标 + 一句话"为什么" + 「开始」按钮）。点「开始」直接带 `actionRef` 跳转执行页（retest 页 / 出卷页 / 复习页），**参数预填，不再进配置抽屉**。
- 打卡入口保留，降为卡片下方常规区。
- 卡片有确定性兜底版（规则推荐），agent 失败用户无感知。

### 3.2 `pkgGuide/tutor` 导学对话页

- 保留对话能力；顶部加「按今日计划学」入口，把 dayPlan 当前项注入对话上下文（teachingPlan 通道已有，复用 `learnerCtx` 传 dayPlan 摘要即可）。
- 对话中孩子说"我不知道学什么"→ 提示回首页看推荐（V1 不做对话内跳转执行）。

### 3.3 `pkgGuide/retest` 复测页

- 流程不变；新增接受外部参数直达（kp/mistakeRef 预填），现在从错题本进，改造后可从推荐卡直接进。
- 判分结果页不动（证据契约展示口径不变）。

### 3.4 `pkgTools/plan` 成长计划页

- 定位变化：从"用户手动生成后闲置的文档"变为 **agent 的长期约束输入**。页面加一行说明"你的计划会影响每日推荐"；计划内容编辑仍手动（家长掌控）。

### 3.5 学习单 `pkgGuide/order`

- agent 可生成学习单**草稿**（锚定成长计划任务，O1 契约照旧），家长在 order 页确认签发。签发按钮前必须家长操作（孩子端不可签发）。

### 3.6 做减法（不删，降级）

- 任务页 7 类场景入口、复测/出卷的多步配置抽屉：保留为「手动模式」，视觉降级到"高级"分组。推荐路径走通后再评估删除。
- 工作台 student-study 任务页的"提示词复制桥"：待 agent 推荐稳定后，今日页改为展示 dayPlan（云端 sync 已可透出），复制桥退居备用。

### 3.7 iPad（可选，二期）

- `GenerateSheet` 加"按今日推荐出卷"快捷参数（dayPlan.actionRef 带 gen 参数），题型配比编辑器逻辑不变。

---

## 四、成本与风险防护

| 风险 | 防护 |
|---|---|
| hy3 幻觉/格式漂移 | 输出强制 JSON schema 校验；失败走确定性兜底；reason 词表门禁 |
| 成本 | 每学科每日 1 次规划（≈3k token/次），3 学科 ≈9k token/日，低配可承受；禁工具循环 |
| 低配环境 | tutorPlanner 纯文本，不依赖 vision；云端自读数据避免超长上下文 |
| 家长失控感 | dayPlan.summary 给家长；成长计划/学习单签发保持人工闸门 |
| 新集合写入 | addOnce + ensureCollection；绝不静默吞错 |

---

## 五、迁移路径与验收

1. **P0（先行，纯后端）**：tutorPlanner V1 + 兜底逻辑 + `tutor_dayplans` 集合 + 单测（schema 校验/兜底降级/词表门禁，参照 `scripts/test-*.cjs` 模式）。
2. **P1（数学试点）**：首页推荐卡（数学）→ retest 直达参数。验收：推荐→完成→证据回流→次日推荐变化，闭环走通 5 天。
3. **P2（语文/英语复制 + plan/order 联动）**。
4. **P3（减法与 iPad）**：手动入口降级、工作台今日页接 dayPlan、iPad 快捷出卷。

**验收指标**：①孩子日均从"打开后 30 秒内进入执行"的比例；②推荐采纳率（点了开始的推荐/总推荐）；③证据回流率（采纳的推荐中产生 verifiable_evidence 的比例）；④兜底触发率（应 <20%）。

## 待决事项

- [ ] dayPlan 落新集合 vs 复用 tutor_sessions（倾向新集合，需确认）
- [ ] hy3 function calling 可靠性实测（决定 V2 是否做工具循环）
- [ ] 推荐卡是否进 tabBar 首页 vs 打包在打卡页顶部（影响 P2 子包结构）
- [ ] dayPlan 的 reason 是否允许引用"证据/达标"术语（语言门禁词表需扩一组测试）
- [ ] 工作台端今日页接入 dayPlan 的时点（sync 契约需加 dayPlan 类型，会扩大 5a 缺口④的反向差距，建议与工作台侧同步排期）

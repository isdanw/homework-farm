# orderProtocol.md —— 学习单契约 order-v1.1

> 实现（canonical，唯一真相源，均在 `order-kit/`）：
> - `orderKit.js` —— 单引擎：编号 / 状态机 / 协议块 / 回执解析 / 证据审核 / 评语规则 / 汇总
> - `orderActions.js` —— 业务动作层：出单 / 回执 / 作废 / 重开 / 勾选（**纯逻辑，注入式 deps**）
> - `orderCloudDeps.js` —— `@cloudbase/node-sdk` ↔ deps 适配器
> 设计依据：`学习单闭环设计_出单-回执.md`
> 一致性锁：`scripts/test-order-kit-sync.cjs`（**六个副本** sha256 区段锁）
> 离线取证：`scripts/test-tutor-orders.cjs`（75 断言 + 3 组反证）· `scripts/test-tutor-sync-orders.cjs`（20 断言 + 1 组反证）
> 网页端写路径：`scripts/test-web-order-write.cjs`（126 断言，跑真实 `web/index.html` 源码）· `scripts/check-web-orders.cjs`（137 项静态）

---

## 1. 集合与实体

**集合**：`tutor_orders`（云端唯一真相源；回执 / 评语 / 汇总内嵌，1:1，免 join）

```js
{
  clientId,        // 'to_YYMMDD_XXXXXX'，本地 uid = 云端 clientId，跨端幂等主键
  openid,          // 仅云端持有，端上剥离
  orderNo,         // 'TS-YYMMDD-XXX'，人读训练编号，全链路一致
  schema,          // 'order-v1'

  plan: {
    key,           // studyPlans 的 key（学科）→ 按学科聚合
    planId,        // 'key@plan.createdAt' → 精确定位「哪一份计划」
    subjectName, si, ti, stageName, taskName, goal, days, dueDay,
    startDate,     // 计划起算日（算排期偏差）
    planUpdatedAt  // 出单时计划的 updatedAt → 检测计划漂移
  },

  intent,          // 12 种之一（复用 task-protocol-v1）
  evidenceType,    // 'retest' | 'expression'
  subject, subjectName, grade, textbook, scaffoldLevel, title, kind, minutes, device,

  status,          // issued | submitted | closed | cancelled | voided
  issuedAt, issuedBy,
  submittedAt, submittedBy,
  closedAt,

  receipt,         // 回执（1:1，提交后锁定；未提交为 null）
  voidedAt, voidReason, reissueOf,
  evaluation,      // 评语（含 facts / completeness / commentSource）
  cycle,           // 本次出单-回执汇总

  events[],        // 审计流水（append-only）
  createdAt, updatedAt
}
```

**端上额外携带**（不进云或按需剥离）：`promptText` / `copyText` / `resumeText` / `recycleText` / `protocolBlock`。

---

## 2. 基数（硬约束）

```
一份学习计划（planId）
    ├── 出单 #1 ── 回执 #1     ← 1:1，提交即锁定
    ├── 出单 #2 ── 回执 #2
    └── 出单 #3 ──（待回执）
```

- 计划 **1 : N** 出单；出单 **1 : 1** 回执；
- 修正路径只有一条：`作废(voided) → 重开新单(reissueOf 指向原单)`。**无原地覆盖。**

---

## 3. 状态机（唯一权威：`canTransition`）

```
                    submit                     evaluate
   issued  ───────────────→  submitted  ───────────────→  closed
     │  │                        │                            │
     │  └── cancel ──→ cancelled └── void ──→ voided          └── void ──→ voided
     └──────────── void ─────────────────────→ voided
```

| from | 允许 to |
|---|---|
| `issued` | `submitted` · `cancelled` · `voided` |
| `submitted` | `closed` · `voided` |
| `closed` | `voided` |
| `cancelled` | —（终态） |
| `voided` | —（终态） |

5×5 全组合中**仅 6 条合法**。非法跃迁一律返回 `bad_transition`，**不做兜底修正**。

---

## 4. 四条硬契约

### O1 · 单必锚计划
`makeOrder()` 缺 `key` 或 `si`/`ti` 或（`taskName` 且 `topic`）→ **返回 null**。
**不支持无计划的自由出单**。出单入口只从 `studyPlans` 取。

`planId = key + '@' + plan.createdAt`。计划重生成必换 `createdAt`（`normalizePlan` 恒定写 `Date.now()`），故旧单不会错挂到新计划。

### O2 · 回执先选计划、再选出单，与出单严格 1:1
提交前必须同时校验：**出单存在** · **`status === 'issued'`** · **`plan.planId` 与所选计划一致**。

| 情况 | 处理 |
|---|---|
| 计划出单后被编辑（`planUpdatedAt` 不符） | `cycle.planDrift = true`，**不拒绝**，按出单时锚点归档 |
| 计划任务已删除（si/ti 越界） | `cycle.planOrphan = true`，**不拒绝**，按快照归档 |
| 所选计划与出单锚点不符 | **拒绝 `plan_mismatch`** —— 唯一硬拒绝 |
| 已提交再提交 | **拒绝 `already_submitted`**，回显首次 `submittedAt`，不写第二次 |

### O3 · 回执 ≠ 证据
提交回执**只关"单的环"**：不写 `tutor_evidence`、不改 `knowledgePoints[].status`、不推进 `tutor_reviews`。

- `verdict` 只允许 `达标 | 部分达标 | 未达标 | null(证据不足)`
- 评语**禁用词**（`findBannedWords()` 门禁，测试与云端写入前各跑一次），**两组缺一不可**：
  - 副词前缀组：`已掌握` `已精通` `学会了` `完全懂了` `完全掌握` `稳稳掌握`
  - 动词短语组：`掌握了` `精通了` `已学会` `学懂了` `全懂了`
  - 为什么要第二组：「已经掌握了这次的内容」**不含**上面任何一串（`已掌握` 要求三字相连，
    而「已经掌握」中间夹了「经」）—— 最自然的越界表述恰好能从门禁下钻过去。
    动词短语一次覆盖前缀的所有变体（已经/基本/都/全/彻底 + 掌握了）。
- 要产生真证据只能走 `tutorRetest`（≥5 题、≥80%、`passed=true`）；`cycle.retestHint` 只是**跳转入口**

### O4 · 全程可追溯（append-only）
`events[]` 只追加、永不修改或删除。类型白名单 **9 种**（**封闭表**，新增类型必须同时改 `EVENT_TYPES` 与本表）：

| 事件 | 触发 | 幂等 |
|---|---|---|
| `issued` | 出单 | — |
| `copied` | 首次复制出单全文 | **只记首次**（`appendEvent` 内建） |
| `submitted` | 提交回执 | 由 O2 保证只发生一次 |
| `evaluated` | 评语与汇总生成 | — |
| `polished` | AI 润色成功 / 失败回落（**失败也留痕**） | 已 `ai` 则不重复 |
| `ticked` | 标记计划任务完成 | **只记首次**（动作层先查事件，`appendEvent` 对 ticked 不幂等） |
| `closed` | 归档关闭（`submitted → closed`） | — |
| `cancelled` / `voided` | 取消 / 作废 | — |

> `closed` 是 2026-09-28 增补的第 9 种：状态机有 `submitted → closed`，若不记事件就会出现
> **状态变了却没留痕**，直接违反 O4。`closed` 还参与 `repeatStuck` 统计（只有已归档的单才计入连续卡点）。

`orderTimeline(order)` 输出只读时间线（按 `at` 正序）。

**业务字段与事件必须在同一次 `update()` 内落库** —— 不允许出现「状态改了但事件没写」的中间态。

---

## 5. 评语与汇总

### 5.1 证据完整度（先审证据）
照 SKILL.md §8.2 七项清单，标准模式 7 项、仅练表达 5 项：

| 通过数 | 结果 |
|---|---|
| 全部 | `完整` |
| ≥70% | `部分完整` |
| <70% | `不足` → **不出结论**，评语写"证据不足，建议补一次验证训练" |

### 5.2 verdict 判定（纯规则，AI 无权参与）

| 条件 | verdict |
|---|---|
| 完整度 = 不足 | `null`（证据不足） |
| 有"未完成" 或 `result === 'blocked'` | 未达标 |
| `mode === 'express'`（仅练表达） | 部分达标（**永不达标**） |
| 有"提示后完成" | 部分达标 |
| 有未测项 | 部分达标 |
| 两项均独立完成 | 达标 |
| 仅一项独立完成 | 部分达标 |
| 其余 | 未达标 |

### 5.3 commentSource
`rule`（默认，必出）→ 可选 `ai`（仅润色，失败静默回落 `rule`，**不阻塞闭环**）。
AI 的 prompt 必须锁死：只能使用传入 `facts`，不得新增任何事实。

### 5.4 cycle.summary（纯计算）
含：时长 / 轮次 / 帮助层级 · 结论与分档计数 · `planDelta` 排期偏差 · `planDrift` / `planOrphan` 标记 · `repeatStuck` 连续卡点 · `nextSuggest` 下一条任务 / `retestHint` 复测建议。

`task.days === 1` 与自动勾选：**默认不自动**，由用户点「标记本任务完成」写 `ticked` 事件（`tickApplied` / `tickedAt` / `tickedBy`）。

---

## 6. 云函数接口

**两个写入口，共用同一份状态机（canonical 副本 + 哈希锁，绝各写一套）**

| 入口 | 身份来源 | 面向 |
|---|---|---|
| `tutorOrder`（云函数） | `event.userInfo.openId`（微信上下文） | 小程序 |
| `webAdminWrite` 的 `orders` 通道 | `token` → `web_portal_bindings` → `openid` | 网页看板 / 工作台 |

### 6.1 `tutorOrder` actions

| action | 入参 | 出参 |
|---|---|---|
| `list` | `{ planId?, subject?, status?, limit? }` | `{ ok, orders[], total, counts }` |
| `get` | `{ orderNo }` | `{ ok, order }` |
| `issue` | `{ planTask, opts:{ kind, minutes, intent?, clientId?, issuedBy? } }` | `{ ok, order, deduped }` |
| `copied` | `{ orderNo, by?, detail? }` | `{ ok, order, deduped }` |
| `submit` | `{ orderNo, planId, fields \| rawText, quant?, parsedBy?, plan?, planCtx?, by? }` | `{ ok, order, parsed? }` |
| `tick` | `{ orderNo, by? }` | `{ ok, order, deduped }` |
| `close` | `{ orderNo, by? }` | `{ ok, order }` |
| `cancel` | `{ orderNo, reason, by? }` | `{ ok, order }` |
| `void` | `{ orderNo, reason, by? }` | `{ ok, order }` |
| `reissue` | `{ orderNo, reason, opts?, by? }` | `{ ok, order, voided }` |
| `polish` | `{ orderNo }` | `{ ok, order, polishFailed }` |

**必填要点**
- `issue` 缺 `key` / `si` / `ti` / 任务名 → `no_anchor`（**不支持无计划自由出单**）
- `submit` 必须同时给 `orderNo` + `planId`（决策 1：先选计划再选出单）
- `planCtx = { updatedAt, taskExists }` 由端上提供（计划内容在本地 `studyPlans`，云端不持有），用于算 `planDrift` / `planOrphan`；不提供则不判定，**不报错**
- `quant = { rounds, minutes, selfEval, errorType }` 是人类逐项确认后的量化项（`parseReceiptText` 抽不到，必须手填）
- **回执字段来源二选一**（`fields` **优先**）：
  - `fields` —— 端上已解析并人工确认（**小程序通道**）。语义不变，此时 `rawText` 被忽略
  - `rawText` —— 端上**只给粘贴原文**（**网页看板通道**），由云端 canonical `parseReceiptText` 抽取
  - 解析器**只有这一份**：`verdict` 是「活动 ≠ 证据 ≠ 掌握」的唯一判据，**绝不允许端上参与判定**。
    网页看板是 1.4 MB 内联单文件、拿不到 `order-kit`，「粘贴原文上云解析」是它唯一不与 canonical 分叉的路径。
  - **缺项不拒绝提交**：缺什么由 `evaluateReceipt` 折算成证据完整度与 `verdict`，`missing` 随出参
    `parsed = { missing[], recognized }` 回传供端上**提示**（是提示，不是拒绝）

错误码：`no_openid` · `bad_action` · `bad_param` · `no_anchor` · `not_found` · `plan_mismatch` · `already_submitted` · `bad_transition` · `bad_receipt` · `evaluate_error` · `init` · `order_error`。

### 6.2 `webAdminWrite` orders 通道

```js
{ token, orders: { action: 'issue'|'submit'|'void'|…, ...同 tutorOrder 的入参 } }
```

- `orders` 必须是**对象**；传数组一律 `bad_param` —— 数组语义是「批量覆盖」，而 `status` / `events` 绝不允许被覆盖。
- `action` 白名单 = `orderActions.ACTIONS`，未知 action → `bad_action`。
- **写边界（决策 3，2026-09-28 拍板 / 09-29 T21-b 落地）**：网页看板与工作台**只有 `orders` 一路可写**，
  其余模块严格只读。保留键 `status` / `events` / `openid` / `_openid` / `clientId` **双层拦截**
  （云函数门禁 + 端上 `callWrite()` 拦下且**不发请求**）；状态与事件只能由状态机推进。
- 网页端 `by` 留痕 = `'web'`（工作台 = `'workbench'`，小程序 = `'mp'`），三端同一张单可追溯是谁操作的。

### 6.3 只读查询

`webAdminQuery` 加 `module:'orders'`，入参 `query:{ planId?, subject?, status?, limit? }`，
出参 `{ orders[], counts, plans[] }` —— 其中 `plans[]` 是「一份计划 → N 张单」的聚合，
三端共用同一份聚合口径（各算一遍必然算出三种结果）。
**大文本（`copyText`/`resumeText`/`recycleText`/`protocolBlock`/`promptText`）不下发**，端上按需用 `orderTextFor()` 重新生成。

### 6.4 写入分工（不可越界）

| 通道 | 职责 |
|---|---|
| `tutorOrder` / `webAdminWrite.orders` | **唯一**带状态机的写；唯一能改 `status` 与 `events` |
| `tutorSync.push` 的 `orders` | **只补写云端不存在的单**；已存在一律 `skip`，不看 `updatedAt`、不合并、**不碰 `events`** |
| `tutorSync.pull` 的 `orders` | 只读（限额 200，`createdAt` 倒序） |

> 为什么 `tutorSync` 不做 LWW：`status` 与 `events` 是 O2/O4 的载体。一旦被本地旧快照覆盖，
> 就会出现「云端回执被抹掉、审计链断掉」—— 静默、不可逆。宁可不合并，不可写坏。
> 已由 `scripts/test-tutor-sync-orders.cjs` 锁死（含反证）。

---

## 7. 端与副本

| canonical | 副本 | 形态 | 目标 |
|---|---|---|---|
| `orderKit.js` | `miniprogram/utils/orderKit.js` | UMD | 小程序 |
| | `cloudfunctions/tutorOrder/orderKit.js` | UMD | 云函数 |
| | `cloudfunctions/webAdminWrite/orderKit.js` | UMD | 云函数 |
| | `<workbench>/src/order-kit/orderKit.js` | **ESM** | 工作台 |
| `orderActions.js` | `cloudfunctions/tutorOrder/orderActions.js` | CJS | 云函数 |
| | `cloudfunctions/webAdminWrite/orderActions.js` | CJS | 云函数 |
| `orderCloudDeps.js` | `cloudfunctions/tutorOrder/orderCloudDeps.js` | CJS | 云函数 |
| | `cloudfunctions/webAdminWrite/orderCloudDeps.js` | CJS | 云函数 |

**副本一律不得手改**。生成：`node scripts/sync-order-kit.mjs`；
校验：`node scripts/sync-order-kit.mjs --check`（`scripts/test-order-kit-sync.cjs` 会跑它，并做反证）。

⚠️ 拼接时「标记 + 逻辑体 + 标记」必须作为**一个**数组元素，否则 `join('\n')` 会在标记与逻辑体之间
多插一个换行，抽取出的区段与 canonical 差一个换行 → 刚生成完 `--check` 就报全端不一致（已踩）。

---

## 8. 测试矩阵（当前实测，2026-09-29）

| 套件 | 断言 | 反证 | 覆盖 |
|---|---|---|---|
| `test-order-contract.cjs` | **54** | — | O1–O4 契约、字段、状态机、禁用词、O3 隔离 |
| `test-order-kit.cjs` | **155** | — | 单引擎 5 个 API 全分支 + TeachStep 模板保真 |
| `test-order-kit-sync.cjs` | **11** | 1 组（篡改副本须变红） | 八份副本 canonical 一致 |
| `test-tutor-orders.cjs` | **75** | 3 组 | 两个写入口、8 组场景、AI 回落、跨通道一致性、`rawText` 通路、`fields` 优先 |
| `test-tutor-sync-orders.cjs` | **20** | 1 组 | 只补写不合并、pull 结构、openid 隔离 |
| `test-order-store.cjs` | **41** | — | 小程序端订单 store 落盘 / 上云队列 |
| `check-order-page.cjs` | **167** | — | 小程序学习单页静态校验（结构 / 接线 / 禁用词 / 锚点） |
| `check-web-orders.cjs` | **137** | 4 组（§0） | 网页看板静态：**写边界** / 写路径语义 / 三端文案一致 |
| `test-web-order-write.cjs` | **126** | — | 网页写路径：**跑真实源码**（`vm` 执行第 2 段 script，业务零打桩） |

**合计 786 断言**（`npm run test:orders`）+ **5 组 counterproof**（`npm run test:orders-counterproof`）。
另有真浏览器套件 `npm run smoke:web-orders`（playwright，**96** 项），依赖本机浏览器，**不入 `npm test`**。

> 仓库整体基线：`npm test` = **1009 项 / 15 脚本 / exit 0**（2026-09-29）。
>
> 门禁背景：`test-store-persistence.cjs` 曾因 2026-09-22 登录策略调整（`initAccount()` 不再自动登录微信）
> 而 3 条假红 + 在 T3 抛 `TypeError` → **T4–T18 长期从未被执行**。已于 09-28 修复
> （新增挂具 `bindCached()` 显式声明前提 + T1b 锁定新语义 + 修掉裸 `arr[0]`），现 **95/95**。

> **⚠️ 判据锁规格，不锁实现**（2026-09-29 教训）：`check-web-orders.cjs` §4 曾把「网页只读」当作红线，
> 断言「白名单绝不含 `webAdminWrite`」——那是当时**错误实现**的照抄，而设计文档决策 3 要求的是
> 「网页看板开启 `orders` 权限（读 + **写**）」。结果**断言全绿但功能缺失**。现 §4 已改为「写边界」，
> 判据依据为设计文档原文。**改本文件相关的任何断言前，先读 §4 顶部的「判据来历」注释。**

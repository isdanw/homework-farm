# 🤖 AI 角色分析 —— 打卡页「角色提示词定义」功能设计文档

> 状态：**设计稿（待确认）** · 确认后进入开发
> 关联页面：`pages/checkin/checkin` · 后端：`cloudfunctions/aiRoleAnalyze`（新增）
> 设计语言：沿用项目马卡龙低幼风（浅蓝 #BFE6FF / 嫩绿 #A8E6A1 / 米白 #FFF9F0）

---

## 一、功能定义（第一性原理拆解）

**核心问题**：现有 `analyzeComment` 云函数用**写死的 systemPrompt** 分析老师评语。家长无法按自家孩子的真实短板，定制分析视角。

**本功能**：把 systemPrompt 改为**用户自定义「角色提示词」**，让家长定义"AI 扮演谁、怎么分析"，再基于**当前打卡视图周期**的数据跑分析。

**最小闭环**：
```
定义角色提示词 → 可选存为预设（按孩子） → 点"开始分析"
  → 端上把"当前视图周期"的打卡数据+评语拼成文本 → 调云函数
  → AI 按角色提示词产出分析 → 弹窗展示
```

**已确认的三项决策**
| 项 | 决策 |
|---|---|
| 分析对象 | **当前视图周期**（日/周/月，跟随打卡页当前选中） |
| 角色保存范围 | **按孩子分别**（存入当前孩子切片 `u.aiRoles`，切换孩子自动切换） |
| 入口形态 | **按钮触发弹窗**（打卡页底部入口 → 弹出底部抽屉面板） |

---

## 二、页面结构与交互流程

### 2.1 入口（打卡页底部，现有"老师评语分析"下方）
```
✏️ 老师评语分析 ›          （原有）
🤖 AI 角色分析 ›           （新增，蓝色描边区分）
```
- 样式：复用 `.entry-link`，加 `.entry-link.ai` 变体（蓝绿渐变感，视觉上区别于老师评语）。

### 2.2 底部抽屉面板（角色定义 + 分析）
点击入口 → 底部抽屉（slide-up，高约 82vh，圆角顶部）从屏幕底部升起，含：

1. **标题栏**：`🤖 AI 角色分析` + 关闭 ✕
2. **分析范围提示条**：一行小字，实时显示"将分析：2026年9月2日 星期三（今日）"，让用户确认范围。
3. **角色提示词输入框**（textarea，`.textarea` 样式）：
   - placeholder：`例如：你是一位严厉的数学老师，专抓孩子计算粗心、进退位错误，给出可落地的纠正动作`
   - 下方 helper：`提示词决定 AI 以什么身份、怎么分析，越具体越好`
4. **快捷预设标签区**（chips）：
   - 读取 `u.aiRoles`（按孩子），每枚显示名称，点击**填充**输入框；长按/点 ✕ **删除**。
   - 内置 3 枚示例建议（仅展示文案，点击即用默认提示词填充）：
     - 「温和鼓励型」|「严厉纠错型」|「习惯养成导师」
5. **存为预设**：输入框下方一行「名称输入 + 保存」按钮（`.btn-sm`），保存当前提示词到 `u.aiRoles`。
6. **开始分析按钮**（`.btn .btn-green .btn-block`）：
   - 提示词为空 → 置灰禁用。
   - 点击 → 关闭抽屉 → 调云函数 → 出结果弹窗。

### 2.3 结果弹窗（复用现有 `.modal` 大弹窗）
- 标题：`AI 分析报告` + 范围小字（如 `2026年9月第1周`）
- 正文：`.cm-text` 预排版文本（`white-space: pre-wrap`），AI 原始输出完整保留（角色自定义，不强行解析板块）。
- 失败态：友好提示（资源包未开通 / 限流 / 网络），含重试。

---

## 三、数据模型变更（store.js）

当前孩子切片 `u` 新增字段：

```js
// AI 角色预设（按孩子分别保存）
aiRoles: [ { id: 'ar_xxx', name: '温和鼓励型', prompt: '你是一位...', createdAt: 1710000000 } ]
```

新增 store 方法（与现有 `getComments/addComment` 同构）：
```js
getAiRoles()            // 返回 u.aiRoles（数组）
addAiRole({ name, prompt })  // 追加并 save()
removeAiRole(id)        // 删除并 save()
```

> 说明：分析结果本身 **v1 不持久化**（按需分析）。后续如需"分析历史"可加 `u.aiAnalyses`，本次不做。

---

## 四、后端契约（cloudfunctions/aiRoleAnalyze，新增）

**为什么新增而非改 `analyzeComment`**：老师评语功能是已上线的稳定链路，自定义角色是独立能力，拆开避免相互污染；二者共享 tcb 初始化与错误兜底逻辑（可抽公共 util）。

**入参**
```json
{
  "rolePrompt": "你是一位严厉的数学老师…",   // 用户自定义 system prompt（≤2000字）
  "content":   "分析周期：2026年9月2日…\n【打卡】语文✓…", // 端上拼接的当前周期文本
  "scopeLabel": "2026年9月2日 星期三（今日）",
  "childName": "加一",
  "grade": "一年级"
}
```

**出参**
```json
{ "ok": true,  "analysis": "（AI 原始文本）" }
{ "ok": false, "code": "empty|too_long|no_pack|rate_limit|ai_error", "msg": "…" }
```

**核心逻辑**
- 校验 `rolePrompt` 非空、≤2000；`content` 非空。
- `systemPrompt = rolePrompt`（直接用用户定义）。
- `userPrompt = 拼装上下文`（childName/grade/scopeLabel + content）。
- 调 `ai.createModel('cloudbase').generateText({ model:'hy3', messages:[{role:'system',content:rolePrompt},{role:'user',content:userPrompt}] })`。
- 错误兜底完全复用 `analyzeComment` 的 `no_pack` / `rate_limit` 文案。

**端上数据拼装示例（checkin.js 内 `buildScopeContent()`）**
- **日模式**：日期 + 各打卡项完成/用时/时刻 + 当天老师评语原文。
- **周模式**：周区间 + 每日三科✓/✗ + 评语汇总（含原文）。
- **月模式**：全勤天数、每日完成数、评语条数与摘要。

---

## 五、设计 Token（延续现有规范）

| 类别 | 取值 |
|---|---|
| 面板背景 | #FFFFFF，顶部圆角 36rpx |
| 抽屉遮罩 | rgba(60,70,90,.45)（同 `.mask`） |
| 输入框 | 复用 `.textarea`：#F6F9FC / 圆角20rpx / 32rpx |
| 主按钮 | `.btn-green`：#5FBF6B |
| 预设 chip | 浅绿底 #EAF3DE / 深绿字 #3B6D11 / 圆角28rpx |
| 范围提示条 | #F0F7FF 底 / #185FA5 字 |
| 间距基准 | 8px（rpx 倍数） |
| 字号 | 正文 26–32rpx；标题 36rpx |

**微交互**：抽屉 slide-up `translateY` 0.25s ease；按钮 `:active` 缩 0.96；分析中转圈 spinner。

---

## 六、无障碍（WCAG 2.2 AA）

- 正文对比度 ≥ 4.5:1（深字配浅底，满足）。
- 输入框字号 32rpx（≥16px），iOS 不缩放。
- 按钮点击区 ≥ 88rpx（`.btn` 已满足）。
- 状态不只靠颜色：预设删除用「✕ 文字/图标」双标识；分析按钮禁用用置灰+文案。
- 抽屉/弹窗均可点遮罩或 ✕ 关闭，焦点逻辑清晰。

---

## 七、开发清单（确认后执行）

1. `store.js`：加 `aiRoles` 字段默认、`getAiRoles/addAiRole/removeAiRole`。
2. `cloudfunctions/aiRoleAnalyze`：新增云函数（init 包、index.js、package.json）。
3. `checkin.wxml`：入口按钮 + 底部抽屉面板 + 结果弹窗。
4. `checkin.wxss`：抽屉/预设 chip/范围条/结果样式（复用现有 class 为主）。
5. `checkin.js`：面板开关、预设读写、范围文本计算、`buildScopeContent()`、云函数调用、结果/错误处理。
6. 自测：空提示词禁用、预设增删、日/周/月三视图数据拼装、无 AI 资源包的错误提示。

---

## 八、待你拍板的点

- 角色预设是否要**内置示例提示词正文**（我建议内置 3 条可直接用，降低门槛）。
- 结果弹窗是否**顺手加"复制全文"**（方便家长发微信给家人）。
- 分析结果 **v1 不保存**，可接受？（避免数据膨胀）

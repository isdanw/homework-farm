# 课表功能 + 打卡详情页（AI 学习评价）实现总结

> 2026-08-31 完成。上一阶段的「打卡类型管理」总结见文末。

## 需求
1. 新增**课表**功能：拍照 / 手动录入一学期课程表，识别课表对应的打卡内容。
2. 打卡改交互：点击打卡图标 → 进入**打卡详情页** → 输入文字描述当天学习情况 → 完成打卡。
3. 复用**评语分析**工具，对学习描述给出评价。

## 已完成

### 数据模型
- `utils/config.js`：新增 `SCHEDULE` 配置——默认 8 节 × 5 天、`SUBJECT_ALIAS` 科目别名表（语文/数学/英语 → chinese/math/english，含阅读/口算/外教等别名）、`SUBJECT_EMOJI`、`TYPE_PALETTE` 配色池。
- `utils/store.js`：`defaultData()` 新增 `schedule: null`；`ensureUserFields` 自动补齐旧数据字段（兼容迁移）。

### 课表引擎（`utils/scheduleEngine.js` 新增）
- 结构：一学期一张固定表，行=节次、列=周几（周一=0），`cells` 以 `行-列` 为键。
- 科目名归一化（去括号/去空格）、别名匹配、`analyzeTypes`（课表 → 已关联/未关联打卡内容 + 覆盖率）、`addMissingTypes`（一键把未匹配科目加为自定义打卡类型，幂等）、`applyGrid`（拍照识别结果回填）、`dayCourses/todayCourses`（按天查课）。

### 课表页（`pages/schedule` 新增）
- 拍照/相册识别（`ocrSchedule` 云函数，失败自动降级为「保留照片 + 手动填写」）+ 手动点格子录入。
- 学期名、行/列数调节、打卡内容识别列表、一键补类型。

### 打卡详情页（`pages/checkinDetail` 新增）
- 点击首页打卡图标 → 进入详情页：输入文字描述（含快捷短语）、可选填写用时分钟数 → 完成打卡。
- 「让 AI 分析一下」调用 `analyzeComment` 云函数 `mode:'note'`（学习记录模式），三段输出：今天做得好 / 可以改进 / 明天试试。
- 课表联动：有课表时提示「今天第 X 节有XX课」。
- 支持历史日期只读、撤销打卡。

### 入口 & 联动
- `pages/index/index`：打卡磁贴改为 `openCheckin` 跳详情页；新增「今日课表」提示（点击进课表页）。
- `pages/mine/mine`：新增「课程表」入口卡（含录入状态摘要）。
- `app.json`：注册 `pages/schedule/schedule`、`pages/checkinDetail/checkinDetail`。

### 云函数
- `cloudfunctions/ocrSchedule`（新增）：base64 图片 → CloudBase AI 视觉（hy3）→ 结构化 grid，含 `vision_unsupported / rate_limit / no_pack` 等降级码。
- `cloudfunctions/analyzeComment`（改）：新增 `mode:'note'` 学习记录分析分支 + `parseSections` 兼容两种模式。

### 校验
- 10 个改动 JS 文件 `node --check` 全部通过。
- `scripts/smoke_schedule.js` 冒烟测试 29/29 通过（别名匹配、课表→打卡识别、一键补类型幂等、拍照回填、按天查课、文字描述打卡落盘）。

## 待部署（需在微信开发者工具手动操作）
- 右键 `cloudfunctions/ocrSchedule` → 上传并部署（云端安装依赖）。
- 右键 `cloudfunctions/analyzeComment` → 上传并部署（云端安装依赖，更新 note 模式）。
- 云环境需开通「Token Credits 资源包」，否则 AI 识别/分析返回 `no_pack`。

---

# 群体打卡 · Phase 1（家庭内多类型打卡）实现总结

## 已完成
把原写死在「语文/数学/英语」三科上的打卡 + 农场联动，解耦为**可配置的打卡类型系统**，并新增家长「打卡类型管理」页。

### 数据模型（核心改造）
- `utils/config.js`：`SUBJECTS` 每条加 `emoji` + `builtin:true`，作为**内置预设池**（语数英）。
- `utils/store.js`：`defaultData()` 新增 `checkinTypes: []`；新增 `getTypeList()`（合并 内置 `CFG.SUBJECTS` + 当前孩子 `checkinTypes`）、`getType(key)`（按 key 取类型，兜底首个内置）。
- `utils/farmEngine.js`：`SUB_KEYS` 改为动态 `getSubKeys()`；新增 `ensureTypeSeeds(d)` 保证 `farm.seeds` 覆盖所有激活类型；`checkin/plantSeed/harvest/forecast/nightSettle` 全部通用化，文案随类型总数动态（不再写死「三科」）。

### 页面改造
- `pages/index/index`：打卡磁贴由 `getTypeList()` 生成，用各类型自身配色做渐变背景。
- `pages/checkin/checkin`：日/周/月视图由类型列表驱动，月历底色按总数比例着色，硬编码「3 科」全部改为 `typeTotal`。
- `pages/farm/farm`：种子背包、仓库统计、作物着色改用 `getTypeList/getType`，自定义类型正常显示与收获。
- `pages/typeManage`（**新增**）：家长增 / 删 / 改自定义打卡类型（名称、emoji、配色、作物造型 flower/berry/leaf），实时预览，落盘到 `checkinTypes`。
- `pages/mine/mine` + `app.json`：新增「打卡类型管理」入口并注册页面。

### 校验
- 8 个改动 JS 文件 `node --check` 全部通过。
- 数据层回归测试通过：默认 3 类型 → 加自定义变 4 → `ensureDay`/`checkin`/`plantSeed`/`harvest` 对自定义类型正确奖励阳光+种子、收获金币 → 删除后回落 3。

## 用户决策（已确认）
- 排期：**先家庭后社交**（社交圈为 Phase 2）。
- 预设范围：**仅语数英起步**（内置池=3 科，其余类型家长从零自定义）。

## 未做 / 下一步（Phase 2：社交打卡圈）
- 云函数 `groupCheckin`（CloudBase）：`createGroup/joinGroup/listMembers/submitCheckin/getRank/getFeed`。
- 集合：`hw_group` / `hw_group_member` / `hw_group_checkin`。
- 入口：`open-type="share"` 分享卡片拉好友、微信群分享、`wx.requestSubscribeMessage` 每日提醒。
- 新增 `pages/circle`：圈子列表 + 排行榜（聚合成员连续打卡/天数）+ 打卡动态流。
- 注：AI 评语分析仍仅限语数英，自定义生活类暂不做 AI 评语（与决策一致）。

## 2026-09-05 成长计划功能上线
- 新增「学习计划生成 + 打卡进度对照」：utils/studyPlan.js 引擎 + pages/plan 计划页 + studyPlanGen 云函数（hy3，已部署）+ typeProfile 提示词配置入口。
- 流程：选科目 → 填年级/学期/教材（+可选编排提示词）→ AI 生成阶段计划 → 开始计划起算排期 → 每日打卡 + 逐项勾选 → 自动对照出 超前/正常/滞后（±3天）与分阶段进度。
- 测试：test_study_plan.js 25/25，全量回归通过。

## 2026-09-07 全科导学 P1 MVP（AI 导学对话）实现总结

### 需求
把 WorkBuddy「降噪全科导学专家」嵌入小程序，P1 先跑通「单科多轮导学 + 会话归档」闭环。

### 已完成
- **云函数 `cloudfunctions/tutorChat`**（新增）：`action=chat/archive` 双模式。主控 prompt 实现最小干预导学（D0-D4 深度递进 + 不直接给答案 + 温和纠错），学科精简 prompt（数学/语文/英语）；多轮上下文（历史截 12 条×2000 字）；频控（6 秒 1 次/小时 60 次）；`archive` 写 `tutor_sessions` 集合（openid 隔离，集合不存在自动建）。
- **`utils/tutorStore.js`**（新增）：会话本地存储层，独立 key `wb_hwfarm_tutor_v1_<openid>`（与主数据 syncData 全量上云解耦），newSession/appendMessage/closeSession/getActive/archiveCount。
- **导学页 `pages/tutor/tutor`**（新增）：学科切换（语文/数学/英语）、气泡消息列表、输入发送、底部「结束本次导学并归档」；复用全局样式（米白 + 蓝色气泡）。
- **入口**：`app.json` 注册页面；`pages/mine/mine` 新增「AI 导学」入口卡（儿童画像下方）。

### 校验
- `scripts/test-tutor.js`：云函数单测 **17/17 通过**（prompt 组装、参数校验、archive 落库、openid 隔离、频控）。
- `scripts/test-tutor-page.js`：前端数据流 **15/15 通过**（chat→多轮 history→archive→切学科会话独立）。
- 全部 JS `node --check` + JSON 校验通过。

### 待部署（需在微信开发者工具手动操作）
1. 右键 `cloudfunctions/tutorChat` → 上传并部署（云端安装依赖）。
2. 云环境需开通「Token Credits 资源包」，否则导学返回 `no_pack`。
3. 真机/模拟器验证 hy3 实际返回质量（重点：是否真正"最小干预"不直接给答案）。

### 后续（P2 起）
- 九科路由 + 错题本（E1-E9 归因落库）+ 复测证据契约（≥5 题且 ≥80%）+ 学习报告页。
- hy3 流式返回；与农场奖励联动（完成一次导学 = 一次浇灌）。
- ⚠️ 上线合规评估：类目「工具-实用工具」+ K12 学科辅导的审核风险（自用体验版无此顾虑）。

## 2026-09-07 成长计划 ⇄ 导学 双向联动

- **计划 → 导学**：`pages/plan` 任务项新增「导学」按钮（`catchtap` 防冒泡到勾选），带任务名/阶段/阶段目标上下文跳转 `pages/tutor`；tutor 页解析 `taskContext` → 顶部显示任务横幅 → 自动发起第一轮导学（开场内容围绕任务目标，强调「不要直接给答案」）。
- **导学 → 计划**：结束导学归档成功后，若带 `taskContext` 弹窗确认「会了 → 标记完成」，调用 `studyPlan.setTaskDone(key,si,ti,true)` 回写任务完成状态（守「活动≠证据≠掌握」契约：由家长/孩子确认，非 AI 自动判定掌握）。
- 手动切换学科会取消任务上下文（`pickSubject` 清 `taskContext`）。
- 测试：`scripts/test-tutor-plan-link.js` 14/14；回归 `test-tutor.js` 17/17、`test-tutor-page.js` 15/15 全通过。

## 2026-09-07 全科导学 P2（错题本 + E1-E9 错因归因落库）

### 需求
导学结束后由 AI 对「卡点」做 E1-E9 错因归因，自动记入错题本，并提供错题订正闭环。

### 已完成
- **云函数 `tutorChat` 扩展**：`archive` 归档成功后调用 `diagnose()`（`DIAG_PROMPT` 输出 JSON `{topic,stuck,errorType(E1-E9),errorDesc,suggestion,done}`），`parseDiagnosis` 解析（弱模型 JSON 兜底 `extractJson`）；`stuck=true` 时写 `tutor_mistakes` 集合；诊断失败不阻塞归档（优雅降级）。
- **`utils/tutorStore.js` 扩展**：新增 `mistakes` 数组 + `getMistakes/addMistake/setMistakeStatus/mistakeCount`（错题项含 subject/topic/errorType/errorDesc/suggestion/status pending|corrected）。
- **导学页 `tutor.js`**：`endSession` 归档后若 `diagnosis.stuck` 自动 `addMistake`；`showSummary` 合并展示错因+建议+「已记入错题本」+（带任务时）「任务「XX」完成了吗？」；新增 `mistakeContext` 解析（`?topic=&errorType=`）与订正开场（围绕知识点重学，不直接给答案）。
- **错题本页 `pages/mistakes`**（新增）：学科筛选（全部/语/数/英）、待订正概览、错题卡（E1-E9 标签+配色、可观察表现、建议、状态、时间）、「去订正」跳导学页、「标记已订正」手动切换（守「订正≠掌握」契约，不做自动判定）。
- **入口**：`app.json` 注册；`mine` 页新增「错题本」入口卡（含待订正数摘要 `buildMistakeInfo`）。

### E1-E9 错因（诊断假设，非事实标签）
E1 审题 / E2 概念 / E3 表征 / E4 关系 / E5 证据 / E6 推理 / E7 信息处理 / E8 表达 / E9 检查迁移（与工作台 contract 同源）。

### 校验
- `scripts/test-tutor-mistakes.js` **32/32 通过**（落库→渲染/筛选→去订正导航→标记订正→mistakeContext 解析→订正开场→归档诊断落库→小结）。
- 回归：`test-tutor.js` 17/17、`test-tutor-page.js` 15/15、`test-tutor-plan-link.js` 14/14 全通过。
- 修复：P2 重写 `showSummary` 曾丢失计划任务名，已补回（弹窗含「任务「XX」完成了吗？」）。

### 待部署
- 需重新部署 `tutorChat` 云函数（新增 diagnose 分支）才能让归档自动诊断归因；不部署时归档仍可用，仅无错因诊断。

## 2026-09-07 全科导学 P3（九科路由 + 复测证据契约 + 导学报告）

### 需求
P3 三件事：九科路由（物理/化学/生物/历史/地理/道法）＋ 复测证据契约（≥5 题且 ≥80%）＋ 导学报告页，并做上线前流程验证。

### 已完成
- **九科路由**：新增 `utils/tutorSubjects.js`（9 科 key/name/emoji，独立于打卡类型 CFG.SUBJECTS）；`tutorChat` 云函数 `SUBJECT_PROMPTS/SUBJECT_NAMES` 扩展到 9 科（物理/化学/生物/历史/地理/道法写精简导学 prompt）；tutor 页与 mistakes 页学科栏改为横向滚动的 9 科。
- **复测证据契约**：新增 `cloudfunctions/tutorRetest` —— `generate`（AI 按错题 topic/errorType 生成 5 道选择题，含答案+解析）、`judge`（云端本地比对答案 + 硬编码 `judgeEvidence`：<5 题或 <80% 即 fail；仅 pass 写 `tutor_evidence`）。答案归一化容忍全角/空格/小写。
- **复测页 `pages/retest`**：从错题本进入 → 生成 5 题 → 逐题作答（自动跳题）→ 交卷判定 → 结果只显示「达标/未达标」，绝不显示「掌握」；达标自动把对应错题标记「已订正」。
- **导学报告页 `pages/report`**：概览（归档/错题/待订正/已验证）、E1-E9 错因分布（百分比条）、学科分布、复测记录（达标=已验证 / 未达标）；入口接 mine 页。
- **`tutorStore` 扩展**：新增 `evidence` 数组 + `getEvidence/addEvidence/evidencePassedCount`。
- **入口接线**：app.json 注册 retest/report；mine 页加「导学报告」入口；错题本「去订正」旁加「复测」按钮。
- **合规文案规避**：`学习报告→导学报告`、`学习数据→导学数据`、`学习证据→导学证据`（守 UI 层回避「学习/作业/教育/培训」红线）。

### 校验
- 新增 `scripts/test-tutor-p3.js`（云函数 + 九科路由 + 证据契约 **21/21**）、`scripts/test-tutor-p3-page.js`（复测页 + 报告页数据流 **19/19**）。
- 修复 `test-tutor.js`：physics 已支持，bad_subject 断言改用 `foobar`。
- 全量回归 **118/118 通过**：test-tutor 17 + test-tutor-page 15 + test-tutor-plan-link 14 + test-tutor-mistakes 32 + test-tutor-p3 21 + test-tutor-p3-page 19。
- 上线前流程验证清单见根目录 `上线前流程验证清单.md`。

### 待部署（手动）
1. 重新部署 `tutorChat`（九科 prompt + diagnose 归因）。
2. 新部署 `tutorRetest`（复测生成 + 证据判定）。
3. 开通 Token Credits 资源包。
4. 已知限制：错题本/报告当前只读本地，跨设备同步留待 P4。

### 修复：画像 → 成长计划 数据关联断层（2026-09-07）
- 问题：成长计划的「年级」只读顶层 `u.grade`（仅「我的→编辑」可设），儿童画像页的「学段/学校进度」不参与年级推导，且缺年级弹窗错误指向「儿童画像」。
- 修复：`store.js` 新增 `parseGrade` + `resolveGrade`（优先顶层 grade，兜底从 `learner.schoolProgress` 解析年级）；`plan.js` 改用 `resolveGrade`；`learnerProfile.save()` 保存「学校进度」后自动回填年级；修正弹窗提示与画像页说明文案。
- 测试：`test-plan-profile-link.js` 17/17（含 chips 修复项）；全量回归 135/135。

### 修复：画像「常用时段/期望内容」多选无法选择（2026-09-07）
- 问题：`toggleSlot`/`toggleExpect` JS 逻辑正确，但 `<view>` 上 `data-v` 单字符 data 属性在微信渲染层读取 `dataset.v` 不稳定，导致点击无响应。
- 修复：wxml 属性名 `data-v` → `data-val`，js 读取 `dataset.val`；补充 `toggleSlot/toggleExpect` 多选累加/取消测试覆盖。
- ⚠️ 需用户在微信开发者工具重新编译 + 清缓存后验证（已按最可能原因修复，若仍失败需真机抓 event 定位）。

## 2026-09-07 打卡内容 ⇄ 导学计划 同步

### 需求
成长计划生成的「导学任务」与「打卡内容」此前互不相干。要求：生成导学计划后，打卡内容与导学计划同步。

### 已完成
- **`studyPlan.js`**：新增 `getCurrentTask(key)` —— 仅当「计划已开始 + 存在未完成任务」时返回 `{ name, dueDay, stageName }`，否则 null（作为「今日应做导学任务」的唯一数据源）。
- **`farmEngine.checkin`**：打卡记录 `homework[date][key]` 新增 `planTask` 字段，把本次打卡对应的导学任务名落盘（含空值兜底）。
- **打卡详情页 `checkinDetail`**：`render()` 计算 `planTask/planStage`；`submit()` 传入 `planTask`；新增紫色「今日导学」卡片（显示任务名+阶段，点击 `goTutor()` 带 `?key=&task=&stage=` 跳导学页）。
- **首页 `index`**：打卡磁贴 `doors` 项新增 `planTask`，磁贴内显示「今日导学任务」（最多 2 行省略），让打卡入口即可见同步内容。
- **同步链路闭环**：计划任务 → 打卡页展示 + 打卡落盘 + 首页磁贴展示；打卡页 → 导学页（带任务上下文）→ 完成回写计划（沿用 P 计划⇄导学联动）。

### 校验
- 新增 `scripts/test-plan-checkin-sync.js` **12/12 通过**（getCurrentTask 三态 + checkin 写 planTask + 首页磁贴携带 planTask）。
- 全量回归 **147/147 通过**（含此前的 test-tutor* / test-plan-profile-link 各套件）。

### 待部署
- 本次为纯前端（utils + 页面）改动，无新云函数，无需重新部署；重新编译预览即可生效。

## 2026-09-07 首页打卡区重设计（磁贴 → 横向卡片）

### 问题
首页打卡磁贴为横向三等分窄格子（约 220rpx），加入「今日导学任务」后信息拥挤，导学任务被 2 行省略截断、展示不全。

### 重设计
- **`index.wxml`**：三等分磁贴 `.sub-grid/.sub-tile` 改为纵向列表 `.sub-list/.sub-row`，每科一张横向卡片。
- **`index.wxss`**：四区分离布局——左 `.sr-icon`（84rpx 白底圆角图标块）+ 中 `.sr-main`（`.sr-top` 科目名+状态 tag、`.sr-task` 导学任务条）+ 右 `.sr-action`（待打卡=白底「打卡」按钮 / 已完成=白底绿勾）。
- **关键收益**：导学任务获约 450rpx 完整单行展示（`nowrap+ellipsis` 兜底）；纵向排列适配动态科目数（内置 3 科 + 自定义扩展）；保留每科浅色渐变 + 卡通农场风格，整卡点击仍进打卡详情页。

### 校验
- 纯 UI 改动（wxml/wxss），未改 JS 数据层；`test-plan-checkin-sync.js` 12/12 通过，确认 `doors` 仍携带 `planTask`。

## 2026-09-07 首页学习逻辑串联 · 方案 A（今日中枢 + 导学中心）

### 需求
学习逻辑（画像→计划→打卡/导学→错题→复测→报告）被打散在 4 个 tab 和「我的」页 8 个并列入口，用户感知不到闭环。采用保守方案 A：tabBar 不动，做两处增量。

### 已完成
- **A1 首页「今日中枢」**：`index.js` render 补读 `tutorStore` 待订正数（`pendingMistakes`）；`index.wxml` 打卡卡内新增「待办提醒条」（有待订正错题才显示，点击进错题本），把打卡进度 + 今日导学任务 + 待办合并到首页一处。
- **A2 「导学中心」聚合页**：新建 `pages/tutorHub`（js/wxml/wxss/json），顶部概览（导学归档/错题总数/待订正/已验证）+ 3 个入口（AI 导学/错题本/导学报告），按闭环顺序排；复测不单列（需从具体错题发起，收敛到错题本内）。
- **「我的」页瘦身**：AI 导学/错题本/导学报告 3 卡替换为 1 张「导学中心」卡（含待订正+已验证摘要）；`mine.js` 删 `goTutor/goMistakes/goReport/buildMistakeInfo/buildReportInfo`，新增 `goTutorHub/buildHubInfo`。
- `app.json` 注册 `pages/tutorHub/tutorHub`。

### 校验
- 新增 `scripts/test-tutor-hub.js` 7/7（概览统计 + hubInfo 摘要）。
- 全量回归 **154/154 通过**；语法检查 + JSON 校验通过。纯前端改动，无新云函数。

### 待办（后续可选）
- 改造 3「报告 → 计划反哺」尚未实现（错因分布回流成长计划）。
- 进阶「孩子 / 家长双视角」分层。

# cn-math-taxonomy 与本地 unitKps：字段映射与差异比对

> 核对日期：2026-11-11 · 参考库 commit：main（当日 09:03 UTC 推送）
> 本地参照：`miniprogram/utils/tutorStore.js`（unitKps / normPointMeta / getUnitKpsMastery）、`scripts/test-prereq-schema.cjs`、`scripts/test-prereq-inject.cjs`
> 参考库副本：`_ref_cn-math-taxonomy/`（只读用途，未纳入任何构建）
> 本文档只做只读分析，**未改动 unitKps、未写云端、未改任何生产数据**。

## 一、结论

1. 两套模型的骨架已经同构：`{strength: hard|soft, reason}` 的先修边在本地 2026-10-27「Path A S1」就落地了，比参考库建库只晚 9 天。**不需要重新设计 schema。**
2. 唯一的结构性分歧是**引用的键**：参考库用稳定字符串 ID（`cnm_p001`），本地用知识点名称（`topic`）。名称撞名/改名即断链，这是导入的第一坑。
3. 数据可以直接看，不能直接信：`standards` 映射里 **2531 条 inferred / 1175 条 exact，推断占 68%**；3442 个点里只有 106 个带 `official_toc` 标记。**当参考索引可以，当教学真值源不行。**
4. 许可证 CC BY-NC 4.0，商业化需单独授权。

## 二、实测规模（脚本读 JSON 统计，非 README 摘录）

| 项 | 参考库 | 本地 unitKps |
|---|---|---|
| 知识点 | 3442（`data/topics.json` 3.18 MB） | 云端按孩子/单元存，本地无数 |
| 先修边 | 4915（hard 2548 / soft 2367） | 每点内嵌 `prereqs[]` |
| 题目 | 13915（`questions.json` 9.92 MB） | 闪卡 `cards` 自产，非题库 |
| 课标 | `cn-curriculum-standards.json` 0.42 MB | 无对应字段 |
| 学科 | math 870 / english 791 / chinese 683 / physics 269 / science 260 / morality 265 / history 134 / geography 59 / biology 66 / chemistry 45 | `unit.subject`、`unit.grade`，无学科枚举约束 |
| 题型 | choice 11037 / numeric 2849 / short 23 / self 6；难度 basic 6845 / standard 5383 / challenge 1332 / advanced 355 | `front` / `back` 两段式卡片 |

仓库描述写的「1644 点 / 2403 边 / 6723 题」是旧快照，实际已翻倍以上。

## 三、字段映射

### 单元层

| 参考库 | 本地 `unitKps[]` | 说明 |
|---|---|---|
| — | `id` | 本地单元 ID，参考库无「单元」概念，只有 `chapter` 字符串 |
| `subject`（**数学 870 条缺失**） | `subject` | 数学要靠 `cnm_` 前缀反推，是映射脚本必须处理的脏点 |
| `grade` + `semester` | `grade`（单字段字符串） | 参考库 `grade` 是数字 1–16（高中用 10–16 表示册次），不是年级 |
| `chapter` | `title` | 例：「一年级上册 第1单元 5以内数的认识和加、减法」 |
| — | `childId` / `createdAt` / `updatedAt` | 本地多孩子隔离与 LWW 时间戳，参考库无 |

### 知识点层

| 参考库 `topics[]` | 本地 `points[]` | 处理 |
|---|---|---|
| `id`（cnm_p001…） | `id`（单元内短 ID） | 建议映射为 `kpId`，不要覆盖 `id` |
| `name` | `topic` | 直接对应 |
| `description` | `front` | 卡片正面 |
| `mastery_criteria[]` | `back` | 需拼成一段文本 |
| `diagnostic_question{q,a}` | `assessmentPrompt` | 本地已有该字段，天然落点 |
| `type`（conceptual/procedural…） | `type` | **大小写不一致**：参考库小写，本地测试用 `CONCEPTUAL` 大写 |
| `standards[{id,confidence}]` | 无 | 只能挂 `evidence[]` 或另建只读索引 |
| `external` / `root_reason` / `mathLinks` / `catalog_status` / `lesson` / `frames` | 无 | 不映射 |
| `dependencies.json` 的 `{topicId,prerequisiteId,strength,reason}` | `prereqs: [{topic,strength,reason}]` | **必须把 ID 解析成 name**；`strength` 归一规则两边一致（非 soft 即 hard） |
| `questions.json` 的 `{id,topicId,prompt,answer,explanation,verify,difficulty,type,choices}` | `cards` | 本地卡片无选项/难度/解析字段，硬塞会丢信息 |

### 诊断逻辑

| | 参考库 `diagnose/engine.js`（1070 行） | 本地 `getUnitKpsMastery` |
|---|---|---|
| 掌握判据 | 会话内连续答对 N 题（默认 3），并向上推断祖先 `inferred` | 该 topic 下存在 `done=true` 的卡（Leitner 毕业） |
| 答错处理 | 再出基础确认题 → `shaky` / `weak`，沿 hard 先修回溯（hard 优先 soft） | 静态比对 `prereqs`，产出 `missingPrereqs[]` + `blocks[]` |
| 根因 | 没有 weak 先修的 weak 节点 = `roots` | 无根因概念，只列欠账点 |
| 状态 | 可序列化 session、`answers[]`、`attempts[]`、`seed` 确定性出题 | 无会话，纯函数读当前快照 |
| 存储 | localStorage，无后端 | tutorStore.commit → CloudBase `tutor_unit_kps` |

## 四、四个必须先解决的冲突

1. **引用键**：`prereqs[].topic` 是名称。直接写参考库的 `prerequisiteId` 进去，本地 `mastered(r)` 按名称查必然全部 false，盲区会全量爆出。
2. **数学缺 subject**：3442 个点里 870 个（正好全部数学）没有 `subject` 字段。按 `subject` 过滤会静默丢掉整个数学学科。
3. **ID 保留缺口**：`getUnitKpsMastery` 会读 `p.kpId`（`unitId::kpId` 精确匹配防跨单元撞名），但 `upsertUnitKp` 重建 point 时只保留 `id/topic/front/back/order` + 4 个图谱字段，**没有保留 `kpId`**。若按 ID 方案接入，先确认是否另有写入路径，别踩空。
4. **字段只增不改不删**：本地既定契约。参考库的 `subject/grade/standards` 一律不能写进 `unitKps` 顶层结构，只能走独立只读集合。

## 五、能拿 / 不能拿

**能拿（工程范式）**
- 引擎的「答错 → 基础确认题 → shaky/weak → 沿 hard 回溯 → roots 根因」四步，可补进现有 E1-E9 错因诊断，成本低。
- 按 `grade+semester+chapter` 生成单元目录的脚本思路（190 个生成脚本在 `scripts/`）。
- 题型/难度分层（basic/standard/challenge/advanced）可反光卡出题梯度。

**不能拿（内容）**
- 课标映射：68% 是 `confidence: inferred`，不是官方原文。
- 教材目录：仅 106/3442 有 `official_toc`，README 自述九下数学目录由知乎摘要+教辅拼接、多处「非官方、待核」。
- 题目答案：README 承认高中数学题与英语题未做盲解，`verify` 与 `answer` 同源；题库 `choice` 占 79%，带图 `figure` 与 `choices` 在本地卡片无处安放。
- 先修边：hard/soft 为 AI 主观判定，未经一线教师审核。

## 六、若真要接，最小动作（待单独确认后执行）

1. 新建独立只读集合 `kp_ref_index`，与 `textbook_library` / 教学计划 / `unitKps` 三者互不回填，遵守既定数据独立性规矩。
2. 一次性转换脚本：`topics.json` + `dependencies.json` → 参考索引，保留 `sourceId`、`sourceSubject`（数学按 `cnm_` 补）、`confidence`、`catalog_status`；先修边同时存 ID 与解析后的 name。
3. 一年级范围先小试：grade=1 共 189 点（数学 48、语文 79、道法 32、科学 30，英语三年级起），人工逐条核过再谈挂接。
4. 任何写入 `unitKps` 的动作单独提方案，不在本次范围内。

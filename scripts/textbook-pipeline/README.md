# 教材库数据管道（本地下载 → 本地处理 → 上传云端）

> 2026-10-25 建立。架构决策（用户拍板）：教材服务从本地电脑部署——源数据下载到本地、
> 本地处理成干净结构化数据、再上传云数据库 `textbook_library` 供云函数使用。
> 云端只存结构化数据，不存原始爬取文件。

## 管道总览

```
raw/ 25 个源 JSON  ──fetch.py──▶  dist/textbook_seed.json  ──prep_upload.js──▶  upload_batches/  ──tcb CLI──▶  云 textbook_library
（上游爬取快照）      下载           normalize.py 规范化       过 normalizeTextbook      分批 INSERT          164 套官方种子
```

| 步骤 | 命令 | 产物 |
|---|---|---|
| ① 下载 | `python3 scripts/textbook-pipeline/fetch.py` | `raw/*.json`（25 个，幂等可重跑） |
| ② 规范化 | `python3 scripts/textbook-pipeline/normalize.py` | `dist/textbook_seed.json`（164 套 / 979 单元） |
| ③ 预处理 | `node scripts/textbook-pipeline/prep_upload.js` | `upload_batches/batch_NN.json`（4 批） |
| ④ 上传 | `tcb db nosql execute --command ...`（见下） | 云集合 `textbook_library` |
| ⑤ 自检 | `node scripts/test-exam-textbook.cjs && node scripts/test-exam-textbook-db.cjs` | 65 项断言 |

## 数据模型（云集合 textbook_library）

- `openid: ''` = 官方种子库（全员可见）；其余仅本人可见——隔离规则见 examService `listTextbooks`
- `textbookId` 全库唯一索引（`idx_textbookId`）；列表筛选复合索引 `idx_openid_subject_grade_term`
- `units[]`：`{order, name, keywords[≤8], sections[≤20], lessons?}`——计划生成的目录锚点
- 溯源字段：`source(seed/upload/search/manual)`、`sourcePlatform`、`sourceUrl`、`crawledAt`、`edition`

## ④ 上传命令（分 4 批，数据走文件不进上下文）

```bash
B=scripts/textbook-pipeline/upload_batches
for i in 01 02 03 04; do
  INNER=$(jq -c --arg t textbook_library '{insert:$t, documents:.}' "$B/batch_$i.json")
  FULL=$(jq -cn --arg t textbook_library --arg c "$INNER" '[{TableName:$t, CommandType:"INSERT", Command:$c}]')
  tcb db nosql execute --json --command "$FULL"
done
```

- `_id` 用种子 id（`tb_seed_*`）→ 重复插入撞唯一键，**天然防重复导入**
- 首次需建集合：`tcb db nosql execute --command '[{"TableName":"textbook_library","CommandType":"COMMAND","Command":"{\"create\":\"textbook_library\"}"}]'`
- 建索引见 `教材库功能设计.md` 第三节（复合筛选索引 + textbookId 唯一索引）
- ⚠️ CLI `--json` 输出会把数字包成 `$numberInt`/`$numberLong`（扩展 JSON 显示层），库内是普通数字，已用 `$type` 聚合判定

## 当前状态（2026-10-25）

- ✅ 164 套 / 979 单元种子数据已在云端（小学 68 套、初中 41 套、高中 55 套）
- ✅ 学科覆盖：数学/语文/英语/物理/化学/生物/历史/地理/道法/科学（science 已补入 SUBJECT_NAMES）
- ⚠️ 数据来自个人开源项目（wuage-quiz-cloud，抓自国家中小学智慧教育平台，无 license）；
  部分知识点标 `by:llm` 待校订——仅作计划编排目录锚点，不直接作为教学内容
- 二期升级通道：省级智慧教育平台「资源编目 API」（需平台审核 accessToken）

## 复跑与增量

- 全量重跑：删 `dist/` + `upload_batches/` → 依次跑 ②③④
- 只重传某批：删该批 JSON 重跑 ③，再单批 INSERT（_id 唯一性保证覆盖语义由人工确认）
- 新增上游文件：把文件名加进 `fetch.py` 的 FILES，跑 ①②③④

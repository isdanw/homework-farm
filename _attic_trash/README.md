# _attic_trash（死资源暂存，不入库意图外的根目录展示）

本目录收纳已从仓库根目录移走的**失活 / 过期**产物，目的是消除根目录误导、避免后来者误读项目现状。

- 原件仍保留在 git 历史中，可随时用 `git show <提交>:<原路径>` 或 `git mv` 恢复。
- 若确认永久无用，可执行 `git rm -r _attic_trash` 彻底移除（历史 blob 仍可追溯）。

## 当前归档
- `代码审查报告.md` / `代码审查报告_2026-09-08.md` —— 旧代码审查快照，已被 `数据持久化审计报告_2026-09-18.md` 等取代。
- `design-preview.html` / `mine-kids-merge-preview.html` / `preview.html` / `sheet-selftest.html` —— 早期 UI 预览/自测页，与当前分包结构不符。
- `系统功能架构图与流程图.html` —— 早期架构图，未反映当前 21 页 + 15 云函数架构（未被 git 跟踪）。

## 明确 NOT 归档（易误判为孤儿，实为活资产）
- `cloudfunctions/aiRoleAnalyze/` + `AI角色分析_*.{html,md}` + `AI名称清理清单_*.md`：语文/数学角色分析功能仍由 `pkgTools/checkinDetail` 调用，属活功能，留在原处。
- `private.key`：miniprogram-ci 上传密钥，已 `.gitignore`，且 `scripts/upload.js` 依赖其位于根目录，勿动。
- `_attic_dead_audio/`：早期音频，已 `.gitignore`，保留。

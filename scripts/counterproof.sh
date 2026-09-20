#!/bin/sh
# ---------------------------------------------------------------------------
# counterproof.sh —— 反证：把被测源码指回改动前的版本，跑同一套用例，必须变红。
#
# 目的：证明「改完测试全绿」不是因为用例太弱。若旧实现也全绿，说明用例无效。
#   用法：sh scripts/counterproof.sh     （或 npm run test:counterproof）
#
# 【基线怎么取·2026-09-18 改成自动】
# 反证要的是「这套被测文件**所有修复都还没做**」的那个版本。历史上踩过两次坑：
#   ① 早期写死 `BASE=HEAD`：修复一旦提交，基线就跟着往前跑，「旧实现」其实是修好的版本
#      → 反证必然全绿 → 反证失效，而且从输出上看不出来。**反证失效比测试失效更危险。**
#   ② 改成「逐文件取最后一次改它的提交的父版本」：仍然是错的。同一个文件会被**分多批**修
#      （store.js 先 F1–F9 再 F10），逐文件取到的是「最近一批之前」，而用例覆盖的是所有批次，
#      于是老批次的用例对着已修好的代码跑 → 不红。
# 正确做法：先在所有被测文件里找出**最早的那次修复提交**，取它的父提交作为统一基线。
# 这样后面无论再修几批，只要还有文件停在早期修复上，基线就不会漂；而且自动计算、无需记 SHA。
# 需要手工指定时仍可用 BASE=<commit> 覆盖。
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.." || exit 2

# 只对**被断言的源码**求最早修复提交。util/config 只是被测文件 require 的依赖、本身不被断言，
# 它们长期不变，若纳入计算会把基线拉到远古版本（然后一跑就崩，失去定位价值）。
ASSERTED="miniprogram/utils/store.js
miniprogram/utils/tutorStore.js
cloudfunctions/tutorSync/index.js
cloudfunctions/syncData/index.js
cloudfunctions/dailyReset/index.js
cloudfunctions/webAdminQuery/index.js"

oldest=""
for src in $ASSERTED; do
  h=$(git log -1 --format=%H -- "$src")
  [ -n "$h" ] || continue
  if [ -z "$oldest" ]; then
    oldest=$h
  elif git merge-base --is-ancestor "$h" "$oldest" 2>/dev/null; then
    oldest=$h        # h 比 oldest 更早 → 以 h 为准
  fi
done

if [ -z "${BASE:-}" ]; then
  if [ -z "$oldest" ]; then
    echo "无法确定反证基线（这些文件都没有提交历史）"; exit 2
  fi
  if git rev-parse --verify -q "$oldest~1" >/dev/null; then
    BASE="$oldest~1"
  else
    echo "最早修复提交 $oldest 没有父提交，无法取改动前版本"; exit 2
  fi
fi

OLD=/tmp/hw-farm-old
rm -rf "$OLD"
mkdir -p "$OLD/utils" "$OLD/cf"

for f in store tutorStore util config; do
  git show "$BASE:miniprogram/utils/$f.js" > "$OLD/utils/$f.js" 2>/dev/null || {
    echo "无法从 $BASE 取出 miniprogram/utils/$f.js"; exit 2; }
done
for f in tutorSync syncData dailyReset webAdminQuery; do
  git show "$BASE:cloudfunctions/$f/index.js" > "$OLD/cf/$f.js" 2>/dev/null || {
    echo "无法从 $BASE 取出 cloudfunctions/$f/index.js"; exit 2; }
done

echo "反证基线：$BASE（最早一批修复的父提交 $(git log -1 --format=%h\ %s "$oldest")）"
echo "         注：若将来所有被测文件都被重新修过一轮，基线会随之前移，老用例可能不再变红 ——"
echo "             那种情况本脚本会**明确报红并退出非 0**（不会静默通过），届时用 BASE=<commit> 手工指定即可。"
echo

fail=0
red() {
  name=$1
  out=$2
  n=$(printf '%s\n' "$out" | grep -c '✗')
  note=""
  if printf '%s\n' "$out" | grep -q '挂具异常'; then
    # 旧版连被测 API 都不存在（如早期的 store.js 没有 getSyncState/isDirty），
    # 用例会在断言里抛错、后续用例不再执行 → 失败条数偏少，但这恰恰是最强的反证。
    note="  ← 旧版缺 API 致用例中途中断（最强反证）"
  fi
  if [ "$n" -gt 0 ]; then
    printf '  ✅ %-26s 旧实现变红（%s 条失败断言）%s\n' "$name" "$n" "$note"
  else
    printf '  ❌ %-26s 旧实现没变红 → 该套用例无效，需加强\n' "$name"
    fail=1
  fi
}

OUT=$(SRC_DIR="$OLD/utils" node scripts/test-store-persistence.cjs 2>&1)
red "store.js 主链路" "$OUT"

OUT=$(SRC_DIR="$OLD/utils" node scripts/test-tutor-store.cjs 2>&1)
red "tutorStore 导学链路" "$OUT"

OUT=$(SYNC_PATH="$OLD/cf/tutorSync.js" node scripts/test-tutor-sync-dedupe.cjs 2>&1)
red "tutorSync 云函数" "$OUT"

OUT=$(SYNC_PATH="$OLD/cf/syncData.js" RESET_PATH="$OLD/cf/dailyReset.js" node scripts/test-cloud-cas.cjs 2>&1)
red "syncData/dailyReset CAS" "$OUT"

OUT=$(WAQ_PATH="$OLD/cf/webAdminQuery.js" node scripts/test-webadminquery-exams.cjs 2>&1)
red "webAdminQuery exams 模块" "$OUT"

echo
PROBE=$(SRC_DIR="$OLD/utils" node scripts/probe-f8-wxprofile.cjs 2>&1)
if printf '%s\n' "$PROBE" | grep -q '❌ 未修'; then
  printf '  ✅ %-26s 旧实现确认「昵称头像不进 _root 镜像」\n' "F8 微信资料专证"
else
  printf '  ❌ %-26s 旧实现行为与预期不符\n' "F8 微信资料专证"
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "反证通过：所有用例都能抓到改动前的缺陷。"
else
  echo "反证不完整：有用例没能变红（见上）。"
fi
exit $fail

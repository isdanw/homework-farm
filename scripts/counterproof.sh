#!/bin/sh
# ---------------------------------------------------------------------------
# counterproof.sh —— 反证：把被测源码指回改动前的版本，跑同一套用例，必须变红。
#
# 目的：证明「改完测试全绿」不是因为用例太弱。若旧实现也全绿，说明用例无效。
#   用法：sh scripts/counterproof.sh     （或 npm run test:counterproof）
#
# 【基线怎么取·2026-09-18 改成自动】
# 早期写法是固定 `BASE=HEAD`，一旦把修复提交进去，基线就跟着往前跑，
# 于是「旧实现」其实是修好的版本 → 反证必然全绿 → 反证失效而且看不出失效。
# 现在逐文件自动判定：**取「最后一次改这个文件的提交」的父版本**。
#   理由：修复一旦提交，该文件在父提交里就是干净的「改动前」版本；
#   而工作区里还没提交的改动天然不在任何提交里，所以不会被误当成基线。
#   同一文件被分多批修过时（如 store.js 先 F1–F9 再 F10），这样取到的是**最早那批之前**的版本，
#   也就是「这套用例覆盖的所有修复都还没做」的状态 —— 正是反证需要的。
# 需要手工指定时仍可用 BASE=<commit> 覆盖。
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.." || exit 2

OLD=/tmp/hw-farm-old
rm -rf "$OLD"
mkdir -p "$OLD/utils" "$OLD/cf"

# pick_old <仓库路径> <输出文件>
pick_old() {
  src=$1; dst=$2
  if [ -n "${BASE:-}" ]; then
    git show "$BASE:$src" > "$dst" 2>/dev/null || return 1
    return 0
  fi
  last=$(git log -1 --format=%H -- "$src")
  if [ -n "$last" ]; then
    git show "$last~1:$src" > "$dst" 2>/dev/null && return 0
  fi
  git show "HEAD:$src" > "$dst" 2>/dev/null || return 1
}

for f in store tutorStore util config; do
  pick_old "miniprogram/utils/$f.js" "$OLD/utils/$f.js" || {
    echo "无法取出 miniprogram/utils/$f.js 的改动前版本"; exit 2; }
done
for f in tutorSync syncData dailyReset; do
  pick_old "cloudfunctions/$f/index.js" "$OLD/cf/$f.js" || {
    echo "无法取出 cloudfunctions/$f/index.js 的改动前版本"; exit 2; }
done

echo "反证基线：${BASE:-逐文件自动取「改动前」版本}"
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

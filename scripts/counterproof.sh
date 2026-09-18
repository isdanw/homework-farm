#!/bin/sh
# ---------------------------------------------------------------------------
# counterproof.sh —— 反证：把被测源码指回改动前的版本，跑同一套用例，必须变红。
#
# 目的：证明「改完测试全绿」不是因为用例太弱。若旧实现也全绿，说明用例无效。
#   用法：sh scripts/counterproof.sh     （或 npm run test:counterproof）
#
# 依赖：仓库里存在改动前的提交（默认 HEAD）。若已提交过修复，请改 BASE 指向修复前提交。
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.." || exit 2

BASE=${BASE:-HEAD}
OLD=/tmp/hw-farm-old
rm -rf "$OLD"
mkdir -p "$OLD/utils" "$OLD/cf"

for f in store tutorStore util config; do
  git show "$BASE:miniprogram/utils/$f.js" > "$OLD/utils/$f.js" 2>/dev/null || {
    echo "无法从 $BASE 取出 miniprogram/utils/$f.js"; exit 2; }
done
git show "$BASE:cloudfunctions/tutorSync/index.js" > "$OLD/cf/tutorSync.js" 2>/dev/null || {
  echo "无法从 $BASE 取出 cloudfunctions/tutorSync/index.js"; exit 2; }

echo "反证基线：$BASE（改动前的源码）"
echo

fail=0
red() {
  name=$1
  out=$2
  n=$(printf '%s\n' "$out" | grep -c '✗')
  if [ "$n" -gt 0 ]; then
    printf '  ✅ %-28s 旧实现变红（%s 条失败断言）\n' "$name" "$n"
  else
    printf '  ❌ %-28s 旧实现没变红 → 该套用例无效，需加强\n' "$name"
    fail=1
  fi
}

OUT=$(SRC_DIR="$OLD/utils" node scripts/test-store-persistence.cjs 2>&1)
red "store.js 主链路" "$OUT"

OUT=$(SRC_DIR="$OLD/utils" node scripts/test-tutor-store.cjs 2>&1)
red "tutorStore 导学链路" "$OUT"

OUT=$(SYNC_PATH="$OLD/cf/tutorSync.js" node scripts/test-tutor-sync-dedupe.cjs 2>&1)
red "tutorSync 云函数" "$OUT"

echo
PROBE=$(SRC_DIR="$OLD/utils" node scripts/probe-f8-wxprofile.cjs 2>&1)
if printf '%s\n' "$PROBE" | grep -q '❌ 未修'; then
  printf '  ✅ %-28s 旧实现确认「昵称头像不进 _root 镜像」\n' "F8 微信资料专证"
else
  printf '  ❌ %-28s 旧实现行为与预期不符\n' "F8 微信资料专证"
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "反证通过：所有用例都能抓到改动前的缺陷。"
else
  echo "反证不完整：有用例没能变红（见上）。"
fi
exit $fail

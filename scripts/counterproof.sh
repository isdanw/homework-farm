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

# ⚠️ 变量名必须写 `${BASE}` **带花括号**：本机 `/bin/sh`（2026-09-19 起）会把紧跟其后的
#    全角字符首字节吞进变量名 → `BASE\xef: unbound variable`，脚本当场退出 127。
#    这个 shell 不是 bash：bash 会在非 [A-Za-z0-9_] 处正确截断，所以「在 bash 里试没问题」
#    完全不能作为安全依据。凡是 `$VAR` 后面接中文的，一律加花括号。
echo "反证基线：${BASE}（最早一批修复的父提交 $(git log -1 --format=%h\ %s "$oldest")）"
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

# T23 · 计划维度聚合「三端一份实现」。两条反证**性质不同**，用两个不同的判定：
#
#   ① canonical 的行为规格：canonical 是 T23 新写的，git 里没有更早的版本可当基线，
#      所以走 **`--counterproof-legacy` 进程内变异体** —— 把 canonical 的两个函数
#      当场换成改造前的旧实现，再跑同一批断言。断言能红 → 用 red()。
OUT=$(node scripts/test-order-plan-aggregate.cjs --counterproof-legacy 2>&1)
red "计划聚合 canonical 规格" "$OUT"

#   ② 云端输出 = canonical：这条反过来 —— 云端本来就是三端里的**参照实现**，
#      拿旧基线跑它一样是绿的（T23 是把另两端对齐到云端），所以旧基线证明不了它。
#      有效反证只能是「把云端换成工作台那套内联聚合」，由脚本内部生成变异体并自证，
#      判定方式 = 脚本退出码 0 **且**输出含「反证有效 ✓」。
selfproof() {
  name=$1
  out=$2
  code=$3
  if [ "$code" -eq 0 ] && printf '%s\n' "$out" | grep -q '反证有效 ✓'; then
    printf '  ✅ %-26s 变异体反证有效（脚本内部自证）\n' "$name"
  else
    printf '  ❌ %-26s 变异体反证失效或脚本异常（exit=%s）\n' "$name" "$code"
    fail=1
  fi
}

OUT=$(COUNTERPROOF=1 node scripts/test-webadminquery-exams.cjs 2>&1); CODE=$?
selfproof "计划聚合 云端=canonical" "$OUT" "$CODE"

# ---------------------------------------------------------------------------
# T24 · 学习单全链路双向 E2E。反证机制与前两种都不同，是**进程内内存变异体**：
#   `E2E_MUTATE=<key> node scripts/test-order-e2e.cjs` —— 通过 Module._load 拦截被点名
#   文件的 require，把内存里 _compile 过的「改坏版本」喂进去，磁盘一个字节都不动。
# 为什么不能像上面那样走 git 基线：E2E 挂具驱动的是**四个云函数 + 两端真源码**的联合体，
#   git 基线里 `order-kit/` 与 `pkgGuide/order/` 整目录都不存在，取不出「可运行的旧版」——
#   基线版本连模块都加载不起来，那不是反证、是崩溃。
# 判定比 red() 更严一条：**必须零「抛异常」**。
#   本项目硬规矩「测试可以红，但绝不能死」：一处裸读（如 after.evaluation）在变异体下抛
#   TypeError，会把「几条红」升级成「整段死」，后面用例根本跑不到 —— 从输出上看失败条数
#   偏少，很容易被误读成「变异体效果较弱」而放过去。所以要单独把它算成 ❌。
# ---------------------------------------------------------------------------
mutation_red() {
  name=$1
  key=$2
  OUT=$(E2E_MUTATE="${key}" node scripts/test-order-e2e.cjs 2>&1)
  n=$(printf '%s\n' "$OUT" | grep -c '✗')
  dead=$(printf '%s\n' "$OUT" | grep -c '抛异常')
  if [ "$dead" -gt 0 ]; then
    printf '  ❌ %-26s 变异体下段落中途死亡（%s 处抛异常）→ 违反「可红不可死」\n' "$name" "$dead"
    fail=1
  elif [ "$n" -gt 0 ]; then
    printf '  ✅ %-26s 改坏即变红（%s 条失败断言，零段落死）\n' "$name" "$n"
  else
    printf '  ❌ %-26s 改坏仍全绿 → 该段断言无效，需加强\n' "$name"
    fail=1
  fi
}

mutation_red "E2E 锚点计划不符"   "plan_mismatch"
mutation_red "E2E 重复提交 1:1"   "already_submitted"
mutation_red "E2E 下拉不带学习单" "pull_no_orders"
mutation_red "E2E 云端丢 openid"  "orders_drop_openid"

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

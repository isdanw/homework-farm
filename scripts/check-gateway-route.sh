#!/usr/bin/env bash
# ============================================================================
# check-gateway-route.sh —— 自定义域名与默认域「行为对齐」核验
#
# 为什么需要它：
#   CloudBase 静态托管有两套域名：
#     · 默认域  <envId>-<appId>.tcloudbaseapp.com   （DomainType=STATIC_STORE，直连 COS）
#     · 自定义域（如 moodlife.xyz）                  （DomainType=HTTPSERVICE，过 HTTP 网关）
#   自定义域走的是**网关路由**，多出一层 `PathRewrite` / `EnablePathTransmission` 配置。
#   配错时表现极具迷惑性：**首页内容完全正确**（靠静态托管的 ErrorDocument 兜底），
#   但 HTTP 状态码是 404，且**所有子路径资源静默 404** —— 单文件自包含的页面看不出问题，
#   直到某天拆了静态资源、或某个页面要加载同源的 .js/.svg 才全线崩。
#
#   真实事故（2026-09-29）：moodlife.xyz 的路由是
#       Path="/"  PathRewrite.Prefix="/index.html"  EnablePathTransmission=true
#   → 上游 key 变成 `index.html//index.html`（见响应头 x-cos-error-detail-key），
#     `/` 返回 404、`/cloudbase.sdk.js` 返回 404（还被兜底成 HTML，Content-Type 也是错的）。
#
#   判据：**同一个 key，在两个域上必须返回相同的状态码、相同的 Content-Type、相同的字节。**
#   默认域即「正确行为」的参照系 —— 不需要事先知道正确值是多少。
#
# 用法：
#   scripts/check-gateway-route.sh [自定义域名] [默认域名]
#   默认参数即本项目的 moodlife.xyz 与其托管默认域。
# 退出码：0 全对齐 / 1 有差异 / 2 参数或网络问题
# ============================================================================
set -uo pipefail

CUSTOM="${1:-https://moodlife.xyz}"
DEFAULT="${2:-https://workbuddy-d2gsgtfvmde5c9adf-1305268412.tcloudbaseapp.com}"

# 探针路径：挑「必须存在但类型各异」的 key，覆盖 HTML / JS / SVG / 目录 / 不存在
PATHS=(
  "/"
  "/index.html"
  "/cloudbase.sdk.js"
  "/cloud-admin/index.html"
  "/__auth/index.html"
  "/__auth/env/logo.svg"
  "/node/buffer.js"
  "/__definitely_not_exist__.txt"
)

pass=0
fail=0
failed_items=()

probe() {  # $1=base $2=path  → "code|content_type|sha256前16|size"
  local base="$1" path="$2" tmp
  tmp="$(mktemp)"
  # 带 cache-buster，绕开 CDN 的 max-age，避免拿旧响应做判据
  local out
  out="$(curl -s --noproxy '*' -H 'Cache-Control: no-cache' \
          -o "$tmp" -w '%{http_code}|%{content_type}|%{size_download}' \
          "${base}${path}?cb=$(date +%s%N)" 2>/dev/null)"
  local h
  h="$(shasum -a 256 "$tmp" 2>/dev/null | cut -c1-16)"
  rm -f "$tmp"
  echo "${out}|${h}"
}

echo "自定义域 = ${CUSTOM}"
echo "默认域   = ${DEFAULT}   （作为「正确行为」的参照系）"
echo
printf '%-6s %-32s %-34s %-34s\n' "结果" "路径" "自定义域" "默认域"
printf '%-6s %-32s %-34s %-34s\n' "------" "--------------------------------" "----------------------------------" "----------------------------------"

for p in "${PATHS[@]}"; do
  c="$(probe "$CUSTOM" "$p")"
  d="$(probe "$DEFAULT" "$p")"
  if [ "$c" = "$d" ]; then
    flag="✅"
    pass=$((pass + 1))
  else
    flag="❌"
    fail=$((fail + 1))
    failed_items+=("$p")
  fi
  printf '%-6s %-32s %-34s %-34s\n' "$flag" "$p" "$c" "$d"
done

echo
echo "结果：通过 ${pass} 项，失败 ${fail} 项（共 ${#PATHS[@]} 项）"
if [ "$fail" -gt 0 ]; then
  echo
  echo "失败路径："
  for p in "${failed_items[@]}"; do echo "  · $p"; done
  cat <<'TIP'

排查提示（自定义域与默认域行为不一致时）：
  1. queryGateway(action="listRoutes", domain="<自定义域>")
  2. 看该 route 的 **PathRewrite**：只要不是 {} 就高度可疑。
     典型病灶：PathRewrite.Prefix="/index.html" —— 静态托管自己已经会用
     IndexDocument 处理 "/"，再加这层前缀只会把上游 key 拼歪
     （响应头 x-cos-error-detail-key 会直接暴露拼歪后的 key）。
  3. 看 **EnablePathTransmission**：映射站点根通常应为 false。
  4. ⚠️ 该路由的 PathRewrite **无法通过 MCP 工具改写**（createRoute/updateRoute 都不收这个入参），
     只能 deleteRoute + createRoute 重建。生产域名上属破坏性变更 —— 先存档 getRoute 原始输出再动手。
TIP
  exit 1
fi
echo "✅ 自定义域与默认域行为完全对齐"
exit 0

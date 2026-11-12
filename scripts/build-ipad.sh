#!/usr/bin/env bash
# ============================================================================
#  build-ipad.sh —— 构建 / 安装 iPad App（模拟器优先，真机需显式指定）
#
#  用法：
#    sh scripts/build-ipad.sh                  # 编译 + 装到模拟器 + 启动
#    sh scripts/build-ipad.sh --test           # 跑单测（模拟器）
#    sh scripts/build-ipad.sh --regen          # 先重新生成 Xcode 工程
#    sh scripts/build-ipad.sh --sim "iPad Pro 11-inch (M5)"
#    sh scripts/build-ipad.sh --device 00008142-000E70391109401C   # 装真机
#
#  选项：
#    --test                编译并跑 ExamPadTests
#    --regen               先跑 scripts/gen-ipad-project.sh 重新生成工程
#    --sim <name|udid>     指定模拟器（默认 "iPad Pro 13-inch (M5)"）
#    --device <udid>       装到已连接真机（需签名；免费证书 7 天过期）
#    --no-launch           只安装，不启动
#    --clean               清空 DerivedData 后重编
#    -h, --help            帮助
#
#  已知环境坑（Xcode 27.1）：swiftc 用 sandbox-exec 起宏插件会报
#  "swift-plugin-server produced malformed response"，必须加
#  OTHER_SWIFT_FLAGS="-Xfrontend -disable-sandbox"。本脚本已内置。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ_DIR="$ROOT/ipadApp"
PROJ="$PROJ_DIR/ExamPad.xcodeproj"
SCHEME="ExamPad"
BUNDLE_ID="xyz.yiyo.exampad"
DD="$ROOT/.artifacts/ipad-build"

SIM_NAME="${IPAD_SIM_NAME:-iPad Pro 13-inch (M5)}"
SIM_UDID=""
DEVICE_UDID=""
DO_TEST=0
DO_REGEN=0
DO_LAUNCH=1
DO_CLEAN=0

SWIFT_FLAGS="-Xfrontend -disable-sandbox"

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel() { printf '\033[33m%s\033[0m\n' "$*"; }
section() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

usage() {
  sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test)      DO_TEST=1; shift ;;
    --regen)     DO_REGEN=1; shift ;;
    --sim)       SIM_NAME="$2"; shift 2 ;;
    --sim=*)     SIM_NAME="${1#*=}"; shift ;;
    --device)    DEVICE_UDID="$2"; shift 2 ;;
    --device=*)  DEVICE_UDID="${1#*=}"; shift ;;
    --no-launch) DO_LAUNCH=0; shift ;;
    --clean)     DO_CLEAN=1; shift ;;
    -h|--help)   usage ;;
    *) echo "未知参数：$1（-h 查看用法）" >&2; exit 2 ;;
  esac
done

section "预检"
command -v xcodebuild >/dev/null 2>&1 || { c_red "未找到 xcodebuild"; exit 1; }
command -v xcrun >/dev/null 2>&1      || { c_red "未找到 xcrun"; exit 1; }
c_grn "  OK    $(xcodebuild -version | head -1)"

if [[ $DO_REGEN -eq 1 || ! -d "$PROJ" ]]; then
  section "生成 Xcode 工程"
  command -v xcodegen >/dev/null 2>&1 || { c_red "未找到 xcodegen（brew install xcodegen）"; exit 1; }
  sh "$ROOT/scripts/gen-ipad-project.sh"
  c_grn "  OK    已生成 $PROJ"
fi
[[ -d "$PROJ" ]] || { c_red "缺少 $PROJ"; exit 1; }

if [[ $DO_CLEAN -eq 1 ]]; then
  section "清理 DerivedData"
  rm -rf "$DD"
  c_grn "  OK    已清空 $DD"
fi

COMMON_ARGS=(
  -project "$PROJ"
  -scheme "$SCHEME"
  -configuration Debug
  -derivedDataPath "$DD"
  "OTHER_SWIFT_FLAGS=$SWIFT_FLAGS"
)

# ---------------------------------------------------------------- 真机
if [[ -n "$DEVICE_UDID" ]]; then
  section "构建（真机）"
  xcodebuild "${COMMON_ARGS[@]}" \
    -destination "generic/platform=iOS" \
    -allowProvisioningUpdates \
    build

  APP="$DD/Build/Products/Debug-iphoneos/ExamPad.app"
  [[ -d "$APP" ]] || { c_red "未找到产物：$APP"; exit 1; }

  section "安装到真机 $DEVICE_UDID"
  xcrun devicectl device install app --device "$DEVICE_UDID" "$APP"
  if [[ $DO_LAUNCH -eq 1 ]]; then
    xcrun devicectl device process launch --device "$DEVICE_UDID" "$BUNDLE_ID"
  fi
  c_grn "完成（如提示证书过期，重跑本脚本即可；免费证书 7 天有效）"
  exit 0
fi

# ---------------------------------------------------------------- 模拟器
section "选择模拟器"
SIM_UDID="$(xcrun simctl list devices available -j | python3 -c '
import json, re, sys
wanted = sys.argv[1]
data = json.load(sys.stdin)

def ver(key):
    m = re.search(r"-(\d+(?:-\d+)*)$", key)
    return tuple(int(x) for x in m.group(1).split("-")) if m else (0,)

# 同一机型会在多个 runtime 下重复，优先新系统
runtimes = sorted(data.get("devices", {}).items(), key=lambda kv: ver(kv[0]), reverse=True)
devs = [d for _, rt in runtimes for d in rt if d.get("isAvailable")]
for d in devs:
    if d.get("state") == "Booted" and d.get("name") == wanted:
        print(d["udid"]); sys.exit(0)
for d in devs:
    if d.get("name") == wanted:
        print(d["udid"]); sys.exit(0)
for d in devs:
    if wanted.lower() in d.get("name", "").lower():
        print(d["udid"]); sys.exit(0)
sys.exit(1)
' "$SIM_NAME")" || true

if [[ -z "$SIM_UDID" ]]; then
  c_red "找不到可用模拟器：$SIM_NAME"
  echo "可用设备：" >&2
  xcrun simctl list devices available | grep -i ipad | sed 's/^/  /' >&2
  exit 1
fi
c_grn "  OK    $SIM_NAME（$SIM_UDID）"

section "启动模拟器"
xcrun simctl boot "$SIM_UDID" >/dev/null 2>&1 || true
open -a Simulator --args -CurrentDeviceUDID "$SIM_UDID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$SIM_UDID" -b >/dev/null
c_grn "  OK    已就绪"

if [[ $DO_TEST -eq 1 ]]; then
  section "运行单测"
  xcodebuild "${COMMON_ARGS[@]}" \
    -destination "platform=iOS Simulator,id=$SIM_UDID" \
    -only-testing:ExamPadTests \
    test
  c_grn "单测通过"
  exit 0
fi

section "构建（模拟器）"
xcodebuild "${COMMON_ARGS[@]}" \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  build

APP="$DD/Build/Products/Debug-iphonesimulator/ExamPad.app"
[[ -d "$APP" ]] || { c_red "未找到产物：$APP"; exit 1; }

section "安装并启动"
xcrun simctl install "$SIM_UDID" "$APP"
if [[ $DO_LAUNCH -eq 1 ]]; then
  xcrun simctl launch "$SIM_UDID" "$BUNDLE_ID"
fi
c_grn "完成：ExamPad 已装到 $SIM_NAME"

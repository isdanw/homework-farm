#!/usr/bin/env bash
# 生成 ExamPad.xcodeproj
#   .xcodeproj 是生成物，不进 git；project.yml + 本脚本才是源。
#   令牌从 ipadApp/.exam-token 读，注入 Info.plist，避免明文写进 project.yml。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ipadApp"
cd "$DIR"

ENV_ID="workbuddy-d2gsgtfvmde5c9adf"
BASE_URL="${EXAM_API_BASE_URL:-https://${ENV_ID}-1305268412.ap-shanghai.app.tcloudbase.com/examapi}"

if [[ -f .exam-token ]]; then
  EXAM_HTTP_TOKEN="$(cat .exam-token)"
else
  echo "!! 未找到 .exam-token，将以空令牌生成（App 会提示未配置）" >&2
  EXAM_HTTP_TOKEN=""
fi

echo "端点: $BASE_URL"
echo "令牌: ${EXAM_HTTP_TOKEN:0:6}…（${#EXAM_HTTP_TOKEN} 位）"

export EXAM_API_BASE_URL="$BASE_URL"
export EXAM_HTTP_TOKEN

xcodegen generate
echo "✅ 已生成 $DIR/ExamPad.xcodeproj"
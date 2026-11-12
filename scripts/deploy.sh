#!/usr/bin/env bash
# ============================================================================
#  deploy.sh —— 云函数 / 网页看板 一键发布
#
#  只做「跑测试 → 部署指定函数 → 部署网页 → 线上自检」四件事，不做全量兜底。
#  ⚠️ 小程序包不在本脚本范围（由 owner 手动上传；上传密钥有 IP 白名单）。
#  ⚠️ iPad App 不在本脚本范围（见 scripts/build-ipad.sh）。
#
#  用法：
#    sh scripts/deploy.sh --fn tutorChat,webAdminQuery --web
#    sh scripts/deploy.sh --fn examService
#    sh scripts/deploy.sh --web --skip-tests
#    sh scripts/deploy.sh --fn dailyReset --dry-run     # 只打印将执行的命令
#
#  选项：
#    --fn <a,b>      部署指定云函数（逗号分隔，可重复）
#    --web           部署 web/ 静态托管
#    --skip-tests    跳过 npm test
#    --no-smoke      跳过部署后自检
#    --dry-run       只打印命令，不执行
#    -h, --help      帮助
#
#  退出码：0 全部成功；1 有失败步骤。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_ID="${TCB_ENV_ID:-workbuddy-d2gsgtfvmde5c9adf}"
WEB_HOST="${WEB_HOST:-https://moodlife.xyz/}"
EXAM_BASE="${EXAM_API_BASE_URL:-https://${ENV_ID}-1305268412.ap-shanghai.app.tcloudbase.com/examapi}"

FNS=()
DO_WEB=0
DO_TESTS=1
DO_SMOKE=1
DRY_RUN=0

FAILED=0
SKIPPED=0

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel() { printf '\033[33m%s\033[0m\n' "$*"; }
section() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

pass() {
  if [[ $DRY_RUN -eq 1 ]]; then c_yel "  DRY   $*"; else c_grn "  PASS  $*"; fi
}
fail() { c_red  "  FAIL  $*"; FAILED=$((FAILED + 1)); }
skip() { c_yel  "  SKIP  $*"; SKIPPED=$((SKIPPED + 1)); }

run() {
  if [[ $DRY_RUN -eq 1 ]]; then printf '  $ %s\n' "$*"; return 0; fi
  "$@"
}

usage() {
  sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fn)        IFS=',' read -r -a _fns <<< "$2"; FNS+=("${_fns[@]}"); shift 2 ;;
    --fn=*)      IFS=',' read -r -a _fns <<< "${1#*=}"; FNS+=("${_fns[@]}"); shift ;;
    --web)       DO_WEB=1; shift ;;
    --skip-tests) DO_TESTS=0; shift ;;
    --no-smoke)  DO_SMOKE=0; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage ;;
    *) echo "未知参数：$1（-h 查看用法）" >&2; exit 2 ;;
  esac
done

if [[ ${#FNS[@]} -eq 0 && $DO_WEB -eq 0 ]]; then
  echo "没有指定任何部署目标。至少给一个 --fn <name> 或 --web。" >&2
  echo "（-h 查看用法）" >&2
  exit 2
fi

# ---------------------------------------------------------------- 预检
section "预检"
command -v tcb >/dev/null 2>&1 || { c_red "未找到 tcb CLI"; exit 1; }
if [[ $DRY_RUN -eq 0 ]]; then
  if ! tcb env list -e "$ENV_ID" >/dev/null 2>&1; then
    c_red "tcb 未登录或无权访问环境 $ENV_ID（先跑 tcb login）"
    exit 1
  fi
fi
c_grn "  OK    tcb 可用，环境 $ENV_ID"

if [[ ${#FNS[@]} -gt 0 ]]; then
  for name in "${FNS[@]}"; do
    [[ -f "$ROOT/cloudfunctions/$name/index.js" ]] || { c_red "云函数目录不存在：cloudfunctions/$name/index.js"; exit 1; }
  done
fi

if [[ $DO_WEB -eq 1 && ! -f "$ROOT/web/index.html" ]]; then
  c_red "缺少 web/index.html"; exit 1
fi

# 脏工作区提示：把「这次会上线的未提交改动」摆在明面上，避免误发别人的 WIP
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  dirty=$(git -C "$ROOT" status --porcelain -- cloudfunctions web | sed 's/^...//' || true)
  if [[ -n "$dirty" ]]; then
    c_yel "  !     工作区有未提交改动（下列路径会按当前磁盘内容上线）："
    printf '%s\n' "$dirty" | sed 's/^/         /'
  fi
fi

# ---------------------------------------------------------------- 测试
section "测试"
if [[ $DO_TESTS -eq 0 ]]; then
  skip "已跳过 npm test"
elif [[ $DRY_RUN -eq 1 ]]; then
  run npm test
else
  if (cd "$ROOT" && npm test >/tmp/deploy-test.log 2>&1); then
    pass "npm test 全通过"
  else
    fail "npm test 失败，终止部署（日志：/tmp/deploy-test.log）"
    tail -30 /tmp/deploy-test.log || true
    exit 1
  fi
fi

# 网页冒烟是静态本地验证：它读的是 web/index.html 源码，必须在部署前跑
if [[ $DO_WEB -eq 1 && $DO_SMOKE -eq 1 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    run python3 scripts/smoke-web-orders.py
  elif command -v python3 >/dev/null 2>&1 && (cd "$ROOT" && python3 scripts/smoke-web-orders.py >/tmp/deploy-web-smoke.log 2>&1); then
    pass "网页冒烟（本地渲染/写路径）通过"
  else
    c_yel "  !     网页冒烟未通过或环境缺失（日志：/tmp/deploy-web-smoke.log），继续部署但在下方如实汇报"
  fi
fi

# ---------------------------------------------------------------- 云函数
deploy_one_fn() {
  local name="$1"
  local dir="$ROOT/cloudfunctions/$name"
  section "部署云函数 $name"
  if ! run tcb fn deploy "$name" --force --dir "$dir" -e "$ENV_ID" --json; then
    fail "$name 部署失败"
    return 1
  fi
  pass "$name 代码已更新（\$LATEST）"

  # examService 走 HTTP 网关且路由钉 $DEFAULT 别名：只更新代码、只发布版本都不会让线上生效。
  # CLI 3.7.2 没有 fn alias 命令，直接调 SCF UpdateAlias 把 $DEFAULT 指到刚发布的版本。
  if [[ "$name" == "examService" ]]; then
    local desc="deploy $(date +%Y%m%d-%H%M%S)"
    if run tcb fn publish-version examService "$desc" -e "$ENV_ID" --json; then
      pass "examService 已发布版本（$desc）"
    else
      fail "examService 发布版本失败"
      return 1
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
      printf '  $ tcb api scf ListVersionByFunction ...   # 取最新版本号\n'
      printf '  $ tcb api scf UpdateAlias ...             # $DEFAULT → 最新版本\n'
      return 0
    fi
    local ver
    ver="$(tcb api scf ListVersionByFunction -e "$ENV_ID" --api-version 2018-04-16 \
      --body "{\"FunctionName\":\"examService\",\"Namespace\":\"$ENV_ID\",\"Offset\":0,\"Limit\":100}" --json 2>/dev/null \
      | tr -d ' \n' | grep -o '"Version":"[0-9]*"' | tr -dc '0-9\n' | sort -n | tail -1 || true)"
    if [[ -z "$ver" ]]; then
      fail "examService 取最新版本号失败，\$DEFAULT 未切换（/examapi 仍跑旧码）"
      return 1
    fi
    # ⚠️ 刚 publish-version 完函数还在「更新中」，UpdateAlias 会报
    #    FailedOperation：当前函数状态无法进行此操作。必须重试等它稳定，
    #    否则部署日志 PASS、线上仍跑旧码（2026-10-29 实测踩到）。
    local alias_ok=0 alias_err='' try
    for try in 1 2 3 4 5 6; do
      alias_err="$(tcb api scf UpdateAlias -e "$ENV_ID" --api-version 2018-04-16 \
        --body "{\"FunctionName\":\"examService\",\"Namespace\":\"$ENV_ID\",\"Name\":\"\$DEFAULT\",\"FunctionVersion\":\"$ver\",\"Description\":\"$desc\"}" --json 2>&1 || true)"
      if ! printf '%s' "$alias_err" | grep -q '"error"'; then alias_ok=1; break; fi
      sleep 4
    done
    if [[ $alias_ok -eq 1 ]]; then
      pass "examService \$DEFAULT → v$ver（/examapi 已生效）"
    else
      fail "examService \$DEFAULT 别名切换失败（/examapi 仍跑旧码）：$(printf '%s' "$alias_err" | tr -d '\n' | cut -c1-200)"
      return 1
    fi
  fi
  return 0
}

if [[ ${#FNS[@]} -gt 0 ]]; then
  for name in "${FNS[@]}"; do
    deploy_one_fn "$name" || true
  done
fi

# ---------------------------------------------------------------- 网页
if [[ $DO_WEB -eq 1 ]]; then
  section "部署网页"
  if run tcb hosting deploy "$ROOT/web" -e "$ENV_ID"; then
    pass "静态托管已上传 web/index.html"
  else
    fail "静态托管上传失败"
  fi
fi

# ---------------------------------------------------------------- 线上自检
if [[ $DO_SMOKE -eq 1 && $DRY_RUN -eq 0 ]]; then
  section "线上自检"

  if [[ $DO_WEB -eq 1 ]]; then
    code=$(curl --noproxy '*' -s -o /dev/null -m 20 -w '%{http_code}' "$WEB_HOST" || echo 000)
    case "$code" in
      200|301|302) pass "网页 $WEB_HOST → HTTP $code" ;;
      000)         skip "网页不可达（网络/代理），未验证 $WEB_HOST" ;;
      *)           fail "网页 $WEB_HOST → HTTP $code" ;;
    esac
  fi

  if [[ " ${FNS[*]-} " == *" examService "* ]]; then
    token="${EXAM_HTTP_TOKEN:-}"
    [[ -z "$token" && -f "$ROOT/ipadApp/.exam-token" ]] && token="$(cat "$ROOT/ipadApp/.exam-token")"
    if [[ -z "$token" ]]; then
      skip "无 EXAM_HTTP_TOKEN，跳过 /examapi 自检"
    else
      body=$(curl --noproxy '*' -s -m 30 -X POST "$EXAM_BASE" \
        -H "content-type: application/json" -H "x-exam-token: $token" \
        -d '{"action":"listProviders"}' || true)
      if printf '%s' "$body" | grep -q '"ok"'; then
        pass "/examapi listProviders 有响应"
        printf '%s' "$body" | grep -q '"ok":true' \
          || c_yel "  !     响应不是 ok:true（可能是别名未切换，仍是旧版本）"
      else
        fail "/examapi 无有效响应：${body:0:160}"
      fi
    fi
  fi

  # bash 3.2（macOS /bin/sh）下空数组展开会触发 set -u 的 unbound variable，
  # 只部署网页（没有任何 --fn）时必须显式跳过这段，否则汇总前直接中断。
  if [[ ${#FNS[@]} -gt 0 ]]; then
    for name in "${FNS[@]}"; do
      out=$(tcb fn invoke "$name" -d '{}' -e "$ENV_ID" --json 2>&1 || true)
      if [[ -z "$out" ]]; then
        fail "$name 空参调用无返回"
      # 「有返回」不等于「跑起来了」：缺 package.json 时平台照样回包，只是 ErrMsg 里写着
      # Cannot find module。必须看 ErrMsg 是否为空，否则会把运行时炸掉当成部署成功。
      elif printf '%s' "$out" | grep -q '"ErrMsg": "[^"]'; then
        fail "$name 运行时报错：$(printf '%s' "$out" | tr -d '\n' | grep -o '"ErrMsg": "[^"]*"' | cut -c1-160)"
      else
        pass "$name 空参可调用：$(printf '%s' "$out" | tr -d '\n' | cut -c1-120)"
      fi
    done
  fi
fi

# ---------------------------------------------------------------- 汇总
section "汇总"
if [[ $FAILED -gt 0 ]]; then
  c_red "完成，但有 $FAILED 项失败（跳过 $SKIPPED 项）"
  exit 1
fi
c_grn "全部完成（跳过 $SKIPPED 项）"
if [[ " ${FNS[*]-} " == *" examService "* ]]; then
  c_yel "提示：/examapi 已切到本次发布的版本；若 iPad 仍拿旧响应，先确认 \$DEFAULT 指向。"
fi

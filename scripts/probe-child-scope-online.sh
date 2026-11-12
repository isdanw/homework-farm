#!/bin/bash
# 孩子维度线上探针：用真实 hw_farm_user（两孩家庭）+ 真实 /examapi 验证盖章与过滤，跑完清理
set -u
cd "$(dirname "$0")/.." || exit 1
ENV=workbuddy-d2gsgtfvmde5c9adf
BASE=https://workbuddy-d2gsgtfvmde5c9adf-1305268412.ap-shanghai.app.tcloudbase.com/examapi
OID=o_probe_scope_20261029
TOKEN=$(cat ipadApp/.exam-token)
KEY=$(tcb fn detail examService -e "$ENV" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s.slice(s.indexOf('{')));const a=j.data.Environment.Variables;const k=a.find(x=>x.Key==='EXAM_ADMIN_KEY');process.stdout.write(k?k.Value:'')}catch(e){}})")

fails=0
chk() { if [ "$1" = "1" ]; then echo "  PASS  $2"; else echo "  FAIL  $2  ${3:-}"; fails=$((fails+1)); fi; }
has() { printf '%s' "$1" | grep -q "$2" && echo 1; }
miss() { printf '%s' "$1" | grep -q "$2" || echo 1; }

db() {  # db <table> <type> <inner-json>  —— inner-json 原样写入 Command 字段（自动转义）
  local esc
  esc=$(printf '%s' "$3" | sed 's/\\/\\\\/g; s/"/\\"/g')
  tcb db nosql execute -e "$ENV" --command "[{\"TableName\":\"$1\",\"CommandType\":\"$2\",\"Command\":\"$esc\"}]" --json 2>/dev/null
}
dbcount() {  # dbcount <table> <query-json> → n
  local esc out
  esc=$(printf '%s' "{\"count\":\"$1\",\"query\":$2}" | sed 's/\\/\\\\/g; s/"/\\"/g')
  out=$(tcb db nosql execute -e "$ENV" --command "[{\"TableName\":\"$1\",\"CommandType\":\"COMMAND\",\"Command\":\"$esc\"}]" --json 2>/dev/null)
  printf '%s' "$out" | grep -o '"\$numberInt": "[0-9]*"' | head -1 | grep -o '[0-9]*'
}
api() {
  curl --noproxy '*' -s -m 40 -X POST "$BASE" -H 'content-type: application/json' -H "x-exam-token: $TOKEN" \
    -d "{\"adminKey\":\"$KEY\",\"openid\":\"$OID\",$1}"
}

echo "== 准备探针数据 =="
db hw_farm_user INSERT "{\"insert\":\"hw_farm_user\",\"documents\":[{\"_openid\":\"$OID\",\"data\":{\"users\":[{\"id\":\"pc1\"},{\"id\":\"pc2\"}],\"currentUserId\":\"pc1\"}}]}" >/dev/null
db exam_resources INSERT "{\"insert\":\"exam_resources\",\"documents\":[{\"openid\":\"$OID\",\"clientId\":\"probe_legacy\",\"name\":\"历史探针卷\",\"createdAt\":$(( $(date +%s) * 1000 - 100000 ))}]}" >/dev/null
n=$(dbcount hw_farm_user "{\"_openid\":\"$OID\"}")
m=$(dbcount exam_resources "{\"openid\":\"$OID\",\"clientId\":\"probe_legacy\"}")
chk "$([ "${n:-0}" -ge 1 ] && echo 1)" "两孩家庭档案已就位（pc1=当前）n=$n"
chk "$([ "${m:-0}" -eq 1 ] && echo 1)" "无归属历史卷已就位 n=$m"

echo "== 1) 保存盖章 =="
r=$(api '"action":"saveExam","exam":{"clientId":"probe_c2","name":"老二探针卷","childId":"pc2"}')
chk "$(has "$r" '"childId":"pc2"')" "显式 childId=pc2（同家庭）→ 盖章 pc2" "$r"
r=$(api '"action":"saveExam","exam":{"clientId":"probe_c1","name":"当前孩子探针卷"}')
chk "$(has "$r" '"childId":"pc1"')" "未传 childId → 盖当前孩子 pc1" "$r"
r=$(api '"action":"saveExam","exam":{"clientId":"probe_bad","name":"跨家庭探针卷","childId":"zzz"}')
chk "$(has "$r" '"ok":true')" "跨家庭 childId=zzz 不阻断保存" "$r"
chk "$(miss "$r" '"childId":"zzz"')" "跨家庭 childId 不被写入" "$r"
chk "$(has "$r" '"clientId":"probe_bad"')" "（该卷本身仍保存，只是无归属）" "$r"
r=$(api '"action":"deleteExam","resourceId":"probe_bad"')

echo "== 2) listExams 视图 =="
r=$(api '"action":"listExams"')
chk "$(has "$r" 'probe_c1')" "当前 pc1：看得到自己的卷" "$r"
chk "$(miss "$r" 'probe_c2')" "当前 pc1：看不到 pc2 的卷" "$r"
chk "$(has "$r" 'probe_legacy')" "当前 pc1：看得到无归属历史卷（不藏）" "$r"
r=$(api '"action":"listExams","childId":"pc2"')
chk "$(has "$r" 'probe_c2')" "切 pc2：看得到 pc2 的卷" "$r"
chk "$(miss "$r" 'probe_c1')" "切 pc2：看不到 pc1 的卷" "$r"
chk "$(has "$r" 'probe_legacy')" "切 pc2：仍看得到历史卷" "$r"
r=$(api '"action":"listExams","childId":"zzz"')
chk "$(has "$r" 'probe_c1')" "非法 childId=zzz → 回落当前孩子过滤（不是关掉过滤）" "$r"
chk "$(miss "$r" 'probe_c2')" "非法 childId 时也不会露出 pc2 的卷" "$r"

echo "== 3) 更新历史卷不抢归属 =="
r=$(api '"action":"saveExam","exam":{"clientId":"probe_legacy","name":"历史探针卷-改名"}')
r=$(api '"action":"listExams","childId":"pc2"')
chk "$(has "$r" 'probe_legacy')" "历史卷被 pc1 改名后，pc2 仍看得到（没被划到 pc1）" "$r"

echo "== 4) 清理 =="
for c in probe_c1 probe_c2 probe_legacy probe_bad probe_z1; do api "\"action\":\"deleteExam\",\"resourceId\":\"$c\"" >/dev/null; done
db exam_resources DELETE "{\"delete\":\"exam_resources\",\"deletes\":[{\"q\":{\"openid\":\"$OID\"},\"limit\":0}]}" >/dev/null
# Mongo Connector 的 delete limit 只接受 0/1，多条要逐条删
for _ in 1 2 3 4 5 6; do
  db hw_farm_user DELETE "{\"delete\":\"hw_farm_user\",\"deletes\":[{\"q\":{\"_openid\":\"$OID\"},\"limit\":1}]}" >/dev/null
done
n1=$(dbcount hw_farm_user "{\"_openid\":\"$OID\"}")
n2=$(dbcount exam_resources "{\"openid\":\"$OID\"}")
chk "$([ "${n1:-1}" = "0" ] && echo 1)" "探针家庭档案已删除 n=$n1"
chk "$([ "${n2:-1}" = "0" ] && echo 1)" "探针试卷已清空 n=$n2"

echo
if [ "$fails" -gt 0 ]; then echo "❌ 失败 $fails 项"; exit 1; fi
echo "✅ 孩子维度线上验证全通过"

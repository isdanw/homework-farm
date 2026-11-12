"""
绑定链路复现脚本（合并后版本）：
模拟「小程序网页看板生成网页口令 → iPad 粘贴口令 → 绑定」全流程。

说明：网页口令由 webPortalBind 写入 web_portal_bindings（需微信上下文，CLI 无法直接调），
这里用 tcb 直接插入一条等价记录来模拟；绑定动作仍走 examService 的 bind，
验证它确实按 web_portal_bindings 的 token 解析出 openid。

用法：python3 scripts/verify-bind.py
"""
import json, os, subprocess, urllib.request, secrets

ENV = "workbuddy-d2gsgtfvmde5c9adf"
URL = f"https://{ENV}-1305268412.ap-shanghai.app.tcloudbase.com/examapi"
TOKEN_FILE = os.path.join(os.path.dirname(__file__), "..", "ipadApp", ".exam-token")
BIND_COLL = "web_portal_bindings"
ACC_COLL = "exam_account_link"


def call(payload, token):
    req = urllib.request.Request(
        URL, data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json', 'x-exam-token': token})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"_http_error": e.code, "_body": e.read().decode()[:300]}


def db_execute(command):
    """command: mongo 命令字符串，例如 {"insert":"web_portal_bindings","documents":[...]}"""
    cmd = json.dumps([{"TableName": BIND_COLL, "CommandType": "INSERT" if "insert" in command else "DELETE" if "delete" in command else "COMMAND", "Command": command}])
    p = subprocess.run(["tcb", "db", "nosql", "execute", "--command", cmd],
                       capture_output=True, text=True)
    return p.stdout


def main():
    token = open(TOKEN_FILE).read().strip()
    owner_openid = "verify_owner_openid_001"      # 模拟「小程序微信账户」
    binder = "ipad_binder_001"                     # 模拟「iPad 端」
    web_token = secrets.token_hex(24)              # 48 位 hex，等同于 webPortalBind 生成的网页口令

    # 模拟 webPortalBind 写入一条未撤销的绑定记录
    print("[0] 模拟网页看板生成网页口令（插入 web_portal_bindings）")
    db_execute(json.dumps({
        "insert": BIND_COLL,
        "documents": [{"token": web_token, "openid": owner_openid, "createdAt": 0, "lastUsed": 0, "revoked": False}]
    }))

    print("\n[1] iPad 用网页口令绑定 bind")
    r = call({"action": "bind", "uid": binder, "token": web_token}, token)
    print("   ", json.dumps(r, ensure_ascii=False)[:220])
    if not (r.get("ok") and r.get("openid") == owner_openid):
        print("❌ 绑定未返回正确的 openid")
        db_execute(json.dumps({"delete": BIND_COLL, "deletes": [{"q": {"token": web_token}, "limit": 1}]}))
        return

    print("\n[2] 绑定后 resolve（应显示已绑定 ipad_bound）")
    r = call({"action": "resolve", "uid": binder}, token)
    print("   ", json.dumps(r, ensure_ascii=False)[:220])
    iden = (r.get("identity") or {})
    if not (iden.get("bound") and iden.get("kind") == "ipad_bound" and iden.get("openid") == owner_openid):
        print("⚠️ resolve 未显示预期绑定态：", iden)

    print("\n[3] 用不存在的令牌 bind（应 bad_token）")
    r = call({"action": "bind", "uid": binder, "token": "deadbeef" * 6}, token)
    print("   ", json.dumps(r, ensure_ascii=False)[:220])

    print("\n[4] 用已撤销的令牌 bind（应 bad_token）")
    revoked = secrets.token_hex(24)
    db_execute(json.dumps({
        "insert": BIND_COLL,
        "documents": [{"token": revoked, "openid": owner_openid, "createdAt": 0, "lastUsed": 0, "revoked": True}]
    }))
    r = call({"action": "bind", "uid": binder + "_revoked", "token": revoked}, token)
    print("   ", json.dumps(r, ensure_ascii=False)[:220])
    db_execute(json.dumps({"delete": BIND_COLL, "deletes": [{"q": {"token": revoked}, "limit": 1}]}))

    print("\n[5] 缺 token 参数（应 bad_param）")
    r = call({"action": "bind", "uid": binder}, token)
    print("   ", json.dumps(r, ensure_ascii=False)[:220])

    # 清理模拟记录（口令映射 + 设备绑定映射，避免残留测试数据）
    db_execute(json.dumps({"delete": BIND_COLL, "deletes": [{"q": {"token": web_token}, "limit": 1}]}))
    db_execute(json.dumps({"delete": ACC_COLL, "deletes": [{"q": {"uid": binder}, "limit": 1}]}))
    print("\n✅ 验证脚本结束，测试数据已清理")


if __name__ == '__main__':
    main()

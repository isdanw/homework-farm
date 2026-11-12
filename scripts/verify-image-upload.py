"""
手写图上传链路端到端验证（iPad → 云函数代传 → 云存储）
真实 PNG 二进制（非伪造 base64）：构造一张 8x8 红点 PNG，走完整 grade 流程。
用法：python3 scripts/verify-image-upload.py
"""
import base64, json, zlib, struct, urllib.request, os

ENV = "workbuddy-d2gsgtfvmde5c9adf"
URL = f"https://{ENV}-1305268412.ap-shanghai.app.tcloudbase.com/examapi"
TOKEN_FILE = os.path.join(os.path.dirname(__file__), "..", "ipadApp", ".exam-token")
UID = "ipad_imgtest_001"


def make_png(w=8, h=8):
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\xff\x00\x00' * w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def call(payload, token):
    req = urllib.request.Request(
        URL, data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json', 'x-exam-token': token})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def main():
    token = open(TOKEN_FILE).read().strip()
    png = make_png()
    b64 = base64.b64encode(png).decode()
    print(f'真实 PNG {len(png)} 字节 → base64 {len(b64)} 字符')

    print('\n[1] 建含书写题的考卷')
    r = call({"action": "saveExam", "uid": UID, "exam": {
        "clientId": "exam_imgtest_001", "name": "手写上传测试卷", "subject": "math",
        "subjectName": "数学", "origin": "manual", "status": "published",
        "questions": [{"id": "q1", "type": "draw", "stem": "请写出 12 + 8 的竖式",
                       "answer": "20", "points": 10, "kp": "两位数加法"}]}}, token)
    print('    ok =', r.get('ok'))
    assert r.get('ok'), 'saveExam 失败'

    print('\n[2] 提交带 base64 手写图')
    r = call({"action": "grade", "uid": UID, "examClientId": "exam_imgtest_001",
              "answers": [{"qid": "q1", "text": "竖式如下",
                           "imageBase64": "data:image/png;base64," + b64}],
              "submissionClientId": "sub_imgtest_001"}, token)
    print('    ok             =', r.get('ok'))
    print('    imagesUploaded =', r.get('imagesUploaded'))
    print('    imagesSkipped  =', r.get('imagesSkipped'))
    sub = r.get('submission') or {}
    for a in sub.get('answers', []):
        refs = a.get('imageRefs') or []
        print('    答案', a.get('qid'), '→ imageRefs =', refs)
        print('       fileID 形如 cloud://… :', str(refs[0]).startswith('cloud://') if refs else False)
    blob = json.dumps(sub, ensure_ascii=False)
    print('    提交记录残留 base64 :', 'YES(异常)' if 'imageBase64' in blob else 'NO(正确)')
    for x in sub.get('results', []):
        dg = x.get('diagnosis') or {}
        print('    批改:', x.get('qid'), 'correct =', x.get('correct'), '|', dg.get('errorDesc'))

    assert r.get('ok'), 'grade 失败'
    assert r.get('imagesUploaded') == 1, '手写图未成功上传'
    refs = (sub.get('answers') or [{}])[0].get('imageRefs') or []
    assert refs and str(refs[0]).startswith('cloud://'), '未拿到云存储 fileID'
    assert 'imageBase64' not in blob, '提交记录残留 base64 正文'
    print('\n✅ 手写图上传链路端到端验证通过')


if __name__ == '__main__':
    main()
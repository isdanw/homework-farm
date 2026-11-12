#!/usr/bin/env python3
"""生成「考卷」iPad App 图标：蓝底 + 白纸(A4) + 红色卷头线 + 黄色铅笔。
输出到 ipadApp/ExamPad/Assets.xcassets/AppIcon.appiconset/ 全套尺寸 + Contents.json。
"""
import math, os
from PIL import Image, ImageDraw

OUT = "/Users/yiyo/WorkBuddy/2026-08-05-08-49-04/ipadApp/ExamPad/Assets.xcassets/AppIcon.appiconset"
os.makedirs(OUT, exist_ok=True)

S = 1024
master = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(master)

# —— 背景：柔和蓝渐变（整平方铺满，iOS 会做圆角遮罩）——
top, bot = (76, 141, 255), (38, 86, 214)
for y in range(S):
    t = y / S
    r = int(top[0] + (bot[0]-top[0])*t)
    g = int(top[1] + (bot[1]-top[1])*t)
    b = int(top[2] + (bot[2]-top[2])*t)
    d.line([(0, y), (S, y)], fill=(r, g, b, 255))

# —— 白纸（A4 比例，轻微投影）——
pw, ph = 580, 752
px0 = (S - pw)//2
py0 = (S - ph)//2 + 14
# 投影
d.rounded_rectangle([px0+10, py0+26, px0+pw+10, py0+ph+26], radius=46,
                    fill=(20, 40, 90, 70))
# 纸面
d.rounded_rectangle([px0, py0, px0+pw, py0+ph], radius=42, fill=(255, 255, 255, 255))
# 纸边极淡描边
d.rounded_rectangle([px0, py0, px0+pw, py0+ph], radius=42,
                    outline=(225, 230, 240, 255), width=3)

paper_cx = px0 + pw//2

# —— 卷头红线（呼应 App 内试卷页顶部红色分隔线）——
red = (229, 72, 77, 255)
rl_y = py0 + 104
d.rounded_rectangle([px0+62, rl_y, px0+pw-62, rl_y+16], radius=8, fill=red)

# —— 几行灰「题目/文字」占位线 ——
grey = (214, 220, 230, 255)
line_w = [400, 430, 300, 392]
ly = rl_y + 78
for i, w in enumerate(line_w):
    d.rounded_rectangle([px0+62, ly, px0+62+w, ly+20], radius=10, fill=grey)
    ly += 66
# 一个小「对勾」方块，暗示批改
d.rounded_rectangle([px0+62, ly, px0+62+200, ly+58], radius=14, fill=(236, 245, 255, 255))
d.line([(px0+92, ly+34), (px0+118, ly+52), (px0+170, ly+16)],
       fill=(46, 160, 90, 255), width=14, joint="curve")

# —— 黄色铅笔（横绘后旋转 -32°，从左下穿向右上）——
L, T = 770, 58
pad = 80
pen = Image.new("RGBA", (L + pad*2, T + pad*2), (0, 0, 0, 0))
pd_ = ImageDraw.Draw(pen)
mid = (T + pad*2)//2
tipLen = 92
eraserLen = 70
body_x0 = tipLen + pad
body_x1 = L + pad - eraserLen
# 笔身（黄）
pd_.rounded_rectangle([body_x0, pad, body_x1, pad+T], radius=20, fill=(245, 178, 0, 255))
pd_.line([body_x0, pad+8, body_x1, pad+8], fill=(255, 214, 110, 255), width=6)  # 高光
# 金属箍
pd_.rounded_rectangle([body_x1-4, pad, body_x1+20, pad+T], radius=6, fill=(200, 205, 212, 255))
# 橡皮（粉）
pd_.rounded_rectangle([body_x1+20, pad, L+pad, pad+T], radius=18, fill=(240, 150, 160, 255))
# 笔尖（石墨三角）
pd_.polygon([(pad, mid), (tipLen+pad, pad+6), (tipLen+pad, pad+T-6)], fill=(58, 58, 64, 255))
pd_.polygon([(pad+10, mid), (tipLen+pad-30, pad+14), (tipLen+pad-30, pad+T-14)], fill=(96, 96, 104, 255))

pen_rot = pen.rotate(-32, expand=True, resample=Image.BICUBIC)
# 把铅笔放在画面中央偏右，使其斜跨纸张
off_x = (S - pen_rot.width)//2 + 70
off_y = (S - pen_rot.height)//2 - 40
master.alpha_composite(pen_rot, (off_x, off_y))

# —— 导出 iPad 专用全套尺寸（App 仅 iPad，不做 iPhone slot）——
sizes = [(20,1),(20,2),(29,1),(29,2),(40,1),(40,2),(76,1),(76,2),(83.5,2),(1024,1)]
seen = {}
images = []
for pt, scale in sizes:
    px = int(round(pt*scale))
    if px not in seen:
        img = master.resize((px, px), Image.LANCZOS).convert("RGBA")
        # 1024 营销图必须不透明
        if px == 1024:
            bg = Image.new("RGBA", (px, px), (38, 86, 214, 255))
            bg.alpha_composite(img)
            img = bg.convert("RGB")
            img.save(os.path.join(OUT, "icon-1024.png"))
        else:
            img.save(os.path.join(OUT, f"icon-{px}.png"))
        seen[px] = f"icon-{px}.png" if px != 1024 else "icon-1024.png"
    fname = seen[px]
    idioms = []
    idiom = "ios-marketing" if pt == 1024 else "ipad"
    images.append({"size": f"{pt}x{pt}", "scale": f"{scale}x", "idiom": [idiom], "file": fname})

# 清掉上一轮遗留、本轮不再需要的尺寸（避免 unassigned children）
keep = set(seen.values())
for f in os.listdir(OUT):
    if f.endswith(".png") and f not in keep:
        os.remove(os.path.join(OUT, f))
        print("removed stale", f)

# —— Contents.json ——
import json
images_json = []
for it in images:
    for idiom in it["idiom"]:
        images_json.append({
            "size": it["size"], "scale": it["scale"], "idiom": idiom,
            "filename": it["file"]
        })
contents = {"images": images_json, "info": {"author": "xcode", "version": 1}}
with open(os.path.join(OUT, "Contents.json"), "w") as f:
    json.dump(contents, f, ensure_ascii=False, indent=2)

print("OK generated", len(images_json), "entries to", OUT)

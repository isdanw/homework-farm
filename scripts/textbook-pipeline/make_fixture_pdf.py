#!/usr/bin/env python3
"""教材 PDF 解析测试夹具生成器（无第三方依赖，手写经典 XRef 表）
reportlab 4.x 产出 XRef 流，pdf-parse 1.1.1 内置的老版 pdf.js 解析不了（bad XRef entry），
故这里手写 PDF-1.4 经典交叉引用表，保证 pdf.js legacy 可读。

产出 fixtures/ 下两个文件：
  1. toc_textbook.pdf —— 3 页：封面 + 目录页（含点线页码）+ 正文开头页
  2. scanned_like.pdf —— 2 页无文本层 PDF（只画灰色矩形），用于 pdf_no_text 路径
运行：python3 scripts/textbook-pipeline/make_fixture_pdf.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")
os.makedirs(OUT, exist_ok=True)


def _esc(s: str) -> str:
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _content(lines, leading=16, start_y=540, font="/F1", size=12, x=40):
    """文本行 → PDF content stream（BT/Td/Tj/TL）"""
    out = ["BT", f"{font} {size} Tf", f"{leading} TL", f"{x} {start_y} Td"]
    for ln in lines:
        out.append(f"({_esc(ln)}) Tj")
        out.append("T*")
    out.append("ET")
    return "\n".join(out).encode("latin-1")


def build_pdf(path: str, pages) -> None:
    """pages: [ [行...], [行...] ] 每页一个 content stream（Helvetica 文本）"""
    objs = {}  # num -> bytes（不含 "n 0 obj" 头尾）

    n_pages = len(pages)
    # 1=Catalog 2=Pages 3..=Page对象 其后 Contents 最后 Font
    page_nums = list(range(3, 3 + n_pages))
    content_nums = list(range(3 + n_pages, 3 + 2 * n_pages))
    font_num = 3 + 2 * n_pages

    kids = " ".join(f"{n} 0 R" for n in page_nums)
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[2] = f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode()

    for i, (pnum, cnum, lines) in enumerate(zip(page_nums, content_nums, pages)):
        objs[pnum] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] "
            f"/Resources << /Font << /F1 {font_num} 0 R >> >> /Contents {cnum} 0 R >>"
        ).encode()
        stream = _content(lines)
        objs[cnum] = b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"

    objs[font_num] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"

    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for num in sorted(objs):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + objs[num] + b"\nendobj\n"

    xref_pos = len(out)
    total = max(objs) + 1
    out += f"xref\n0 {total}\n".encode()
    out += b"0000000000 65535 f \n"
    for num in range(1, total):
        out += f"{offsets[num]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {total} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()

    with open(path, "wb") as f:
        f.write(bytes(out))


def make_toc_textbook() -> None:
    cover = [
        "Mathematics",
        "Grade 1 - Volume 1",
        "Compulsory Education Textbook",
        "PEP Press",
    ]
    toc = [
        "Mu Lu",
        "",
        "Unit 1  Preparation .................. 1",
        "   Lesson 1  Counting ................ 1",
        "   Lesson 2  Comparing ................ 3",
        "Unit 2  Position ...................... 7",
        "   Lesson 1  Up Down Front Back ...... 7",
        "   Lesson 2  Left Right ............... 9",
        "Unit 3  Numbers 1-5 ................. 13",
        "   Lesson 1  Recognizing 1-5 ........ 13",
        "   Lesson 2  Comparing Sizes ........ 15",
        "   Lesson 3  Addition ................ 17",
        "Unit 4  Recognizing Shapes .......... 21",
        "   Lesson 1  Solid Shapes ........... 21",
        "Revision .............................. 28",
    ]
    body = [
        "Unit 1  Preparation",
        "This is the body text of the textbook.",
        "It should not be treated as catalog content.",
        "The cat starts on the previous page.",
    ]
    build_pdf(os.path.join(OUT, "toc_textbook.pdf"), [cover, toc, body])


def make_scanned_like() -> None:
    """无文本层：空 content stream（只声明资源），模拟扫描页"""
    # 直接构造空流页面
    objs = {}
    n_pages = 2
    page_nums = [3, 4]
    content_nums = [5, 6]
    font_num = 7
    kids = " ".join(f"{n} 0 R" for n in page_nums)
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[2] = f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode()
    for pnum, cnum in zip(page_nums, content_nums):
        objs[pnum] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] "
            f"/Resources << /Font << /F1 {font_num} 0 R >> >> /Contents {cnum} 0 R >>"
        ).encode()
        objs[cnum] = b"<< /Length 0 >>\nstream\n\nendstream"
    objs[font_num] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for num in sorted(objs):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + objs[num] + b"\nendobj\n"
    xref_pos = len(out)
    total = max(objs) + 1
    out += f"xref\n0 {total}\n".encode()
    out += b"0000000000 65535 f \n"
    for num in range(1, total):
        out += f"{offsets[num]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {total} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    with open(os.path.join(OUT, "scanned_like.pdf"), "wb") as f:
        f.write(bytes(out))


if __name__ == "__main__":
    make_toc_textbook()
    make_scanned_like()
    for name in ("toc_textbook.pdf", "scanned_like.pdf"):
        p = os.path.join(OUT, name)
        print(f"生成 {name}（{os.path.getsize(p)} 字节）")

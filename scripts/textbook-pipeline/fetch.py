#!/usr/bin/env python3
"""教材种子库管道 · 第 1 步：下载源数据
从 GitHub Peng-Rao/wuage-quiz-cloud 抓取国家中小学智慧教育平台的章节 JSON（2026-09-27 快照）。
幂等：已存在的文件跳过（--force 强制重下）。
运行：python3 scripts/textbook-pipeline/fetch.py [--force]
"""
import argparse
import os
import urllib.parse
import urllib.request

REPO_RAW = "https://raw.githubusercontent.com/Peng-Rao/wuage-quiz-cloud/main/server/app/data/chapters"
HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "raw")

# 25 个源文件（文件名与上游保持一致，中文名需 URL 编码）
FILES = [
    "小学数学-人教版.json",
    "小学语文-统编版.json",
    "小学英语-人教PEP版（三起）.json",
    "小学科学-教科版.json",
    "小学科学-苏教版.json",
    "小学道德与法治-统编版.json",
    "初中数学-人教版.json",
    "初中语文-统编版.json",
    "初中英语-人教版.json",
    "初中物理-沪科版.json",
    "初中化学-人教版.json",
    "初中生物-人教版.json",
    "初中历史-统编版.json",
    "初中地理-湘教版.json",
    "初中道德与法治-统编版.json",
    "高中数学-人教A版.json",
    "高中语文-统编版.json",
    "高中英语-人教版.json",
    "高中物理-鲁科版.json",
    "高中化学-苏教版.json",
    "高中化学-鲁科版.json",
    "高中生物-人教版.json",
    "高中历史-统编版.json",
    "高中地理-人教版.json",
    "高中政治-统编版.json",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="强制重新下载（默认跳过已存在文件）")
    args = ap.parse_args()

    os.makedirs(RAW_DIR, exist_ok=True)
    ok, skipped, failed = 0, 0, 0
    for name in FILES:
        dest = os.path.join(RAW_DIR, name)
        if os.path.exists(dest) and not args.force:
            skipped += 1
            continue
        url = REPO_RAW + "/" + urllib.parse.quote(name)
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = resp.read()
            with open(dest, "wb") as f:
                f.write(data)
            print(f"  下载 {name}（{len(data) // 1024} KB）")
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  !! 失败 {name}: {e}")
            failed += 1
    print(f"\n完成：新下载 {ok}，跳过 {skipped}，失败 {failed}（共 {len(FILES)} 个源文件）")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

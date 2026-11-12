#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
normalize.py —— 教材数据规范化（本地数据工厂 · 第一步之后的核心）
把 raw/ 下的源 JSON（books→chapters→sections→knowledge）转成统一的
textbook_library 种子记录，输出 dist/textbook_seed.json。

源格式（Peng-Rao/wuage-quiz-cloud，抓自国家中小学智慧教育平台）：
  { stage, subject, version, books: [{ name, grade, edition, chapters:
      [{ name, sections: [{ name, knowledge: [...], by }] }] }] }

目标 schema（与云端 textbook_library 集合一致，见《教材库功能设计》第三节）：
  { _id, openid:'', title, subject, grade, term, version, source:'seed',
    sourcePlatform, sourceUrl, crawledAt,
    units: [{ order, name, keywords: [...], sections: [...] }] }
"""
import json, os, re, sys, hashlib
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
DIST = os.path.join(HERE, 'dist')

SUBJECT_KEYS = {
    '语文': 'chinese', '数学': 'math', '英语': 'english',
    '物理': 'physics', '化学': 'chemistry', '生物': 'biology', '生物学': 'biology',
    '历史': 'history', '地理': 'geography', '政治': 'politics',
    '道德与法治': 'politics', '思想政治': 'politics', '科学': 'science',
}
TERM_MAP = {'上册': '上学期', '下册': '下学期', '中册': '中册', '全一册': '全一册'}
TERM_TOKENS = {'上册', '下册', '中册', '全一册', '第一册', '第二册', '第三册'}
BOOK_TYPE = ['选择性必修', '必修']
GRADE_RE = re.compile(r'^([一二三四五六七八九十]+年级|高一|高二|高三)$')
MAX_UNITS = 30
MAX_KEYWORDS = 8
MAX_NAME = 40

warnings = []

def parse_filename(fn):
    """小学数学-人教版.json → (stage, subject_cn, version)"""
    m = re.match(r'^(小学|初中|高中)(.+?)-(.+?)\.json$', fn)
    if not m:
        warnings.append(f'文件名无法解析: {fn}')
        return None
    return m.group(1), m.group(2), m.group(3)

def split_book_name(name):
    """解析册次名 → (term_cn, book_type, seq, name_part)
    '一年级 上册' → ('上册', '', '', '')
    '八年级 全一册' → ('全一册', '', '', '')
    '必修 第一册' → ('第一册', '必修', '', '')
    '选择性必修1 化学反应原理' → ('', '选择性必修', '1', '化学反应原理')
    '必修 中外历史纲要（上）' → ('', '必修', '', '中外历史纲要（上）')"""
    term_cn, book_type, seq, name_part = '', '', '', ''
    for p in re.split(r'\s+', name.strip()):
        if not p:
            continue
        if p in TERM_TOKENS:
            term_cn = p
        elif p.startswith('选择性必修'):
            book_type = '选择性必修'
            rest = p[len('选择性必修'):]
            if rest:
                seq = rest
        elif p.startswith('必修'):
            book_type = '必修'
            rest = p[len('必修'):]
            if rest:
                seq = rest
        elif GRADE_RE.match(p):
            pass  # 年级 token（book.grade 字段已提供，忽略）
        else:
            name_part = p
    return term_cn, book_type, seq, name_part

def slug(s):
    """稳定 ASCII slug：优先查表，否则哈希（保证 _id 确定且可复现）"""
    table = {
        '人教版': 'rjc', '统编版': 'tbb', '北师大版': 'bsd', '苏教版': 'sjb',
        '冀教版': 'jjb', '北京版': 'bjb', '西南师大版': 'xnSD', '西南大学版': 'xnDX',
        '青岛版': 'qdb', '教科版': 'jkb', '人教PEP版（三起）': 'pep3',
        '人教鄂教版': 'rjcEB', '冀人版': 'jrb', '大象社版': 'dxsb', '湘科版': 'xkb',
        '粤教粤科版': 'yjyk', '沪科版': 'hkb', '湘教版': 'xjb', '华东师大版': 'hdsd',
        '浙教版': 'zjb', '沪科技版': 'hkj', '人教A版': 'rjcA', '鲁科版': 'lkb',
        '沪教版': 'hjb', '科普版': 'kpb', '中图版': 'ztb', '商务星图版': 'swxt',
        '晋教版': 'jjb2', '译林版': 'ylb', '外研社版': 'wys', '闽教版': 'mjb',
        '陕旅版': 'slb', '接力版': 'jlb', '辽宁师大版': 'lnsd', '重庆大学版': 'cqdx',
        '鲁教湘教版': 'ljxj', '清华大学版': 'qhd', '花城版': 'hcb', '湘艺版': 'xyb',
        '苏少版': 'ssb', '浙人美版': 'zrm', '岭南美版': 'lnm', '冀美版': 'jmb',
        '桂美版': 'gmb', '赣美版': 'gmb2', '辽海版': 'lhb', '人美版': 'rmb',
        '人音版': 'ryb', '川教版': 'cjb', '湘少版': 'xsb', '粤教粤人版': 'yjyr',
    }
    if s in table:
        return table[s]
    return hashlib.md5(s.encode('utf-8')).hexdigest()[:6]

GRADE_SLUG = {
    '一年级': 'g1', '二年级': 'g2', '三年级': 'g3', '四年级': 'g4', '五年级': 'g5', '六年级': 'g6',
    '七年级': 'g7', '八年级': 'g8', '九年级': 'g9',
    '高一': 'gz1', '高二': 'gz2', '高三': 'gz3',
}
TERM_SLUG = {'上册': 's', '下册': 'x', '中册': 'z', '全一册': 'q',
             '第一册': 'd1', '第二册': 'd2', '第三册': 'd3'}

def clean_name(s):
    """轻量清洗源数据里的 stray 空格：'二 6～10的认识和加、 减法' → '二 6～10的认识和加减法'"""
    s = re.sub(r'\s+', ' ', str(s)).strip()
    s = re.sub(r'(?<=[，。、；：？！])\s+', '', s)   # 中文标点后的空格
    s = re.sub(r'(?<=[一二三四五六七八九十])\s+(?=\d)', '', s)  # 「一 5以内」→「一5以内」
    return s

def normalize_file(fn):
    parsed = parse_filename(fn)
    if not parsed:
        return []
    stage, subject_cn, version = parsed
    subject = SUBJECT_KEYS.get(subject_cn)
    if not subject:
        warnings.append(f'{fn}: 未知学科 {subject_cn}，跳过')
        return []
    path = os.path.join(RAW, fn)
    try:
        d = json.load(open(path, encoding='utf-8'))
    except Exception as e:
        warnings.append(f'{fn}: JSON 解析失败 {e}')
        return []
    src = d.get('source') or {}
    source_url = f'https://raw.githubusercontent.com/Peng-Rao/wuage-quiz-cloud/main/server/app/data/chapters/{fn}'
    records = []
    for book in d.get('books', []):
        bname = (book.get('name') or '').strip()
        grade = book.get('grade') or ''
        term_cn, book_type, seq, name_part = split_book_name(bname)
        if not grade:
            # 高中书常不带 grade，从书型推（必修→高一，选择性必修→高二）
            grade = '高一' if book_type == '必修' else ('高二' if book_type == '选择性必修' else '')
        if not grade or not (term_cn or name_part):
            warnings.append(f'{fn}/{bname}: 缺年级或册次，跳过')
            continue
        term = TERM_MAP.get(term_cn, term_cn) if term_cn else ''
        units, seen_kw = [], set()
        for ch in book.get('chapters', []):
            cname = (ch.get('name') or '').strip()
            if not cname:
                continue
            keywords, sections = [], []
            for sec in ch.get('sections', []):
                sname = (sec.get('name') or '').strip()
                if sname:
                    sections.append(clean_name(sname)[:MAX_NAME])
                for k in (sec.get('knowledge') or []):
                    k = str(k).strip()
                    if k and k not in seen_kw:
                        seen_kw.add(k)
                        keywords.append(clean_name(k)[:MAX_NAME])
            units.append({
                'order': len(units) + 1,
                'name': clean_name(cname)[:MAX_NAME],
                'keywords': keywords[:MAX_KEYWORDS],
                'sections': sections[:20],
            })
        if not units:
            warnings.append(f'{fn}/{bname}: 无有效单元，跳过')
            continue
        if len(units) > MAX_UNITS:
            warnings.append(f'{fn}/{bname}: 单元 {len(units)} 个超上限，截断到 {MAX_UNITS}')
            units = units[:MAX_UNITS]
        # 展示名：年级 token 去掉后剩余部分（必修 第一册 / 选择性必修1 化学反应原理 / 上册 / 全一册）
        display = ' '.join(x for x in [book_type + seq, name_part, term_cn] if x)
        # 标题：人教版·一年级数学上册 / 苏教版·高二化学选择性必修1 化学反应原理
        title = f'{version}·{grade}{subject_cn}{display}'
        # _id：学科_版本_年级_书型+册次/序号，保证确定且唯一
        type_slug = {'选择性必修': 'xzx', '必修': 'bx', '': ''}[book_type]
        grade_slug = GRADE_SLUG.get(grade) or hashlib.md5(grade.encode('utf-8')).hexdigest()[:4]
        if term_cn:
            key = TERM_SLUG.get(term_cn) or hashlib.md5(term_cn.encode('utf-8')).hexdigest()[:4]
        elif seq:
            key = 'n' + seq
        else:
            key = hashlib.md5(display.encode('utf-8')).hexdigest()[:6]
        bid = f'tb_seed_{subject}_{slug(version)}_{grade_slug}_{type_slug}{key}'
        records.append({
            '_id': bid,
            'openid': '',
            'title': title,
            'subject': subject,
            'grade': grade,
            'term': term,
            'version': version,
            'source': 'seed',
            'sourcePlatform': src.get('platform') or '国家中小学智慧教育平台',
            'sourceUrl': source_url,
            'crawledAt': src.get('crawledAt') or '',
            'edition': book.get('edition') or '',
            'units': units,
            'createdAt': 0,
            'updatedAt': 0,
        })
    return records

def main():
    os.makedirs(DIST, exist_ok=True)
    files = sorted(f for f in os.listdir(RAW) if f.endswith('.json'))
    all_records, seen_ids = [], {}
    for fn in files:
        for r in normalize_file(fn):
            if r['_id'] in seen_ids:
                warnings.append(f"_id 冲突 {r['_id']}（{fn} 与 {seen_ids[r['_id']]}），后者跳过")
                continue
            seen_ids[r['_id']] = fn
            all_records.append(r)
    out = os.path.join(DIST, 'textbook_seed.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'generatedAt': datetime.now(timezone.utc).isoformat(),
                   'count': len(all_records), 'textbooks': all_records},
                  f, ensure_ascii=False, indent=1)
    # 统计
    by_stage = {}
    for r in all_records:
        g = r['grade']
        stage = '小学' if re.match(r'^[一二三四五六]年级$', g) else ('初中' if re.match(r'^[七八九]年级$', g) else '高中')
        by_stage.setdefault(stage, [0, 0])
        by_stage[stage][0] += 1
        by_stage[stage][1] += len(r['units'])
    total_units = sum(len(r['units']) for r in all_records)
    print(f'== 规范化完成 ==  教材 {len(all_records)} 套 / 单元 {total_units} 个')
    for st, (n, u) in sorted(by_stage.items()):
        print(f'  {st}: {n} 套 / {u} 单元')
    print(f'输出: {out}')
    if warnings:
        print(f'\n== 警告 {len(warnings)} 条 ==')
        for w in warnings[:30]:
            print('  -', w)
    else:
        print('无警告')

if __name__ == '__main__':
    main()

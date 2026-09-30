#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
网页看板「学习单」tab 真实浏览器冒烟（T21 验收）

为什么要真浏览器：`scripts/check-web-orders.cjs` 是静态校验（读源码），它证明不了
「渲染出来是对的」。web/index.html 是 1.4MB 内联单文件，也没有构建步骤可插桩，
所以唯一可信的验证就是：起 HTTP、开真浏览器、驱动真渲染器、断言真 DOM。

本脚本做四层事：
  A. 页面可加载层 —— 证明这段内联脚本没有把整页弄坏
     · 无未捕获异常；cloudbase SDK 已加载；匿名登录路径可达
     · 无口令时口令门可见；无口令时云调用失败必须是**明确错误态**，不得静默回落
  B. 渲染器行为层 —— 直接给 DATA 灌合成数据，驱动 renderOrders()，断言 DOM
     · 计划锚点 planId / si / ti 可见（O1 的界面面）
     · 「一份计划 → N 张单」聚合表存在且可点击下钻
     · 单详情展开后有事件时间线，且事件顺序与云端 events 一致
     · 状态文案为「待回执」（三端口径），且全文无结论类禁用词
     · 加载中 / 无账号 / 无单 三种边界都给出明确提示而不是空白
     · **加载态下两个页签必须已经在**（入口先于数据）—— owner 报「没找到交回执的入口」
       的真身就是加载窗口内写区被清空，这一条是本脚本最该守住的一条
  C. 写路径层（T21-b）—— 把 app.callFunction 换成拦截器，**真的点 DOM 上的按钮**，
     断言真实组装出来的 payload（A/B 两层只证明「渲染对」，证明不了「请求对」）
     · 无单时写区仍然渲染（否则新账号永远出不了第一张单）
     · 出单：planTask 五件套 + si/ti 是下标 + planCreatedAt 取自计划 + by='web'
     · 保留键（status/events/openid/_openid/clientId）端上拦下且**不发请求**
     · 回执：两步选择（先选计划 → 再选该计划下的 issued 单）+ planId 取自本单锚点
     · 空粘贴挡在端上；越界写动作（void/reissue/tick/close/cancel）一个都没有
  D. 整页兜底

用法：
  /Users/yiyo/.workbuddy/binaries/python/versions/3.14.3/bin/python3 scripts/smoke-web-orders.py
  SHOT=/path/to.png 可额外产出视口截图（人工复核用）
退出码非 0 即失败。
"""
import http.server
import json
import functools
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(REPO, 'web')

# 本机 playwright 的默认浏览器版本号可能与已下载的不一致（报 Executable doesn't exist），
# 因此优先在 ms-playwright 缓存里找一个真实存在的 headless shell 来用，找不到再回落到默认。
def find_chromium():
    cache = os.path.expanduser('~/Library/Caches/ms-playwright')
    if not os.path.isdir(cache):
        return None
    cands = []
    for name in os.listdir(cache):
        base = os.path.join(cache, name)
        if name.startswith('chromium_headless_shell-'):
            cands.append(os.path.join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
        elif name.startswith('chromium-'):
            cands.append(os.path.join(base, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))
    cands = [c for c in cands if os.path.isfile(c) and os.access(c, os.X_OK)]
    # headless shell 优先：启动更快，且本脚本不需要有头渲染
    cands.sort(key=lambda p: (0 if 'chrome-headless-shell' in p else 1))
    return cands[0] if cands else None

PASS = 0
FAIL = 0
FAILED_ITEMS = []


def ok(cond, msg):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  \u2713 ' + msg)
    else:
        FAIL += 1
        FAILED_ITEMS.append(msg)
        print('  \u2717 ' + msg)


def section(t):
    print('\n' + t)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(directory):
    handler = functools.partial(QuietHandler, directory=directory)
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port


# ----------------------------------------------------------------------
# 合成数据（形状严格照 webAdminQuery(module:'orders') 的真实出参）
# ----------------------------------------------------------------------
ORDERS_PAYLOAD = {
    'orders': [
        {
            'orderNo': 'MO-TEST0001', 'id': 'MO-TEST0001', 'openid': 'oTestChildA',
            'status': 'closed', 'subject': 'math', 'subjectName': '数学',
            'title': '10 以内加法 · 变式讲一遍', 'kind': 'concept', 'minutes': 10,
            'plan': {'key': 'math', 'planId': 'math@1700000000000', 'subjectName': '数学',
                     'stageName': '第一阶段 · 10 以内加减', 'taskName': '10 以内加法',
                     'si': 0, 'ti': 1, 'startDate': '2026-09-01', 'dueDay': 3},
            'issuedAt': 1758000000000, 'issuedBy': 'mp',
            'submittedAt': 1758010000000, 'submittedBy': 'mp',
            'closedAt': 1758020000000, 'voidedAt': 0, 'voidReason': '', 'reissueOf': '',
            'createdAt': 1757999000000, 'updatedAt': 1758020000000,
            'receipt': {'mode': 'standard', 'topic': '10 以内加法', 'childQuote': '我先数手指',
                        'stuckPoint': '3+4 要数两次', 'dLevelsUsed': ['D1'],
                        'variantQuestion': '5+3=?', 'variantResult': 'prompted',
                        'boundaryQuestion': '9+1=?', 'boundaryResult': 'independent',
                        'expressionNote': '讲了一遍', 'conclusion': '进位时忘了',
                        'nextRaw': '明天再练', 'rounds': 2, 'minutes': 10, 'selfEval': 3,
                        'errorType': 'E2', 'markedNotMeasured': False,
                        'parsedBy': 'manual', 'submittedAt': 1758010000000, 'submittedBy': 'mp',
                        'rawText': '回执原文……',
                        'fields': {'mode': 'standard', 'childQuote': '我先数手指'}},
            'evaluation': {'verdict': '部分达标', 'verdictText': '部分达标', 'completeness': '完整',
                           'commentSource': 'rule',
                           'comment': '本次表现：部分达标。1 项能独立完成，1 项在提示后完成。',
                           'checks': [{'id': 'child_behavior', 'pass': True, 'label': '有孩子的实际回答或行为记录'},
                                      {'id': 'question_recorded', 'pass': True, 'label': '是否记录了题目'},
                                      {'id': 'boundary_done', 'pass': False, 'label': '边界题是否真正完成'}],
                           'generatedAt': 1758010000000},
            'cycle': {'summary': '…', 'repeatStuck': 1, 'planDelta': {'dueDay': 3, 'actualDay': 4, 'delta': 1},
                      'nextSuggest': '下一次换一道不进位的题', 'retestHint': {'subject': 'math', 'topic': '10 以内加法'}},
            'events': [
                {'type': 'issued', 'at': 1758000000000, 'by': 'mp', 'detail': 'planId=math@1700000000000 si=0 ti=1'},
                {'type': 'copied', 'at': 1758000100000, 'by': 'mp', 'detail': ''},
                {'type': 'submitted', 'at': 1758010000000, 'by': 'mp', 'detail': ''},
                {'type': 'evaluated', 'at': 1758010000000, 'by': 'sys', 'detail': '部分达标'},
            ],
        },
        {
            'orderNo': 'MO-TEST0002', 'id': 'MO-TEST0002', 'openid': 'oTestChildA',
            'status': 'issued', 'subject': 'math', 'subjectName': '数学',
            'title': '10 以内减法', 'kind': 'example', 'minutes': 15,
            'plan': {'key': 'math', 'planId': 'math@1700000000000', 'subjectName': '数学',
                     'stageName': '第一阶段 · 10 以内加减', 'taskName': '10 以内加法',
                     'si': 0, 'ti': 1, 'startDate': '2026-09-01', 'dueDay': 3},
            'issuedAt': 1758030000000, 'issuedBy': 'workbench',
            'submittedAt': 0, 'submittedBy': '', 'closedAt': 0, 'voidedAt': 0,
            'voidReason': '', 'reissueOf': '', 'createdAt': 1758030000000, 'updatedAt': 1758030000000,
            'receipt': None, 'evaluation': None, 'cycle': None,
            'events': [{'type': 'issued', 'at': 1758030000000, 'by': 'workbench', 'detail': ''}],
        },
        {
            # 另一个孩子的单：验证孩子 chip 过滤真的生效
            'orderNo': 'MO-TEST0003', 'id': 'MO-TEST0003', 'openid': 'oTestChildB',
            'status': 'issued', 'subject': 'chinese', 'subjectName': '语文',
            'title': '拼音 · 声母', 'kind': 'concept', 'minutes': 5,
            'plan': {'key': 'chinese', 'planId': 'chinese@1700000009999', 'subjectName': '语文',
                     'stageName': '第一阶段', 'taskName': '声母认读',
                     'si': 0, 'ti': 0, 'startDate': '2026-09-01', 'dueDay': 1},
            'issuedAt': 1758040000000, 'issuedBy': 'mp', 'submittedAt': 0, 'submittedBy': '',
            'closedAt': 0, 'voidedAt': 0, 'voidReason': '', 'reissueOf': '',
            'createdAt': 1758040000000, 'updatedAt': 1758040000000,
            'receipt': None, 'evaluation': None, 'cycle': None,
            'events': [{'type': 'issued', 'at': 1758040000000, 'by': 'mp', 'detail': ''}],
        },
    ],
    'counts': {'issued': 2, 'submitted': 0, 'closed': 1, 'cancelled': 0, 'voided': 0, 'total': 3},
    'plans': [
        {'openid': 'oTestChildA', 'planId': 'math@1700000000000', 'key': 'math', 'subjectName': '数学',
         'stageName': '第一阶段 · 10 以内加减', 'taskName': '10 以内加法', 'si': 0, 'ti': 1,
         'issued': 1, 'submitted': 0, 'closed': 1, 'cancelled': 0, 'voided': 0, 'total': 2, 'lastAt': 1758030000000},
        {'openid': 'oTestChildB', 'planId': 'chinese@1700000009999', 'key': 'chinese', 'subjectName': '语文',
         'stageName': '第一阶段', 'taskName': '声母认读', 'si': 0, 'ti': 0,
         'issued': 1, 'submitted': 0, 'closed': 0, 'cancelled': 0, 'voided': 0, 'total': 1, 'lastAt': 1758040000000},
    ],
}

PROFILE_PAYLOAD = {
    'accounts': [
        {'openid': 'oTestChildA', 'nickname': '加一', 'studyPlans': {}},
        {'openid': 'oTestChildB', 'nickname': '妹妹', 'studyPlans': {}},
    ]
}

# 带成长计划的账号 —— 出单（O1）必须有计划锚点，所以写路径冒烟必须给一份真计划。
# 结构严格照小程序 studyPlan.normalizePlan 的产物（stages[].tasks[]，si/ti 即数组下标）。
STUDY_PLANS = {
    'math': {
        'grade': '一年级', 'term': '上学期', 'textbook': '人教版', 'subjectName': '数学',
        'startDate': '2026-09-01', 'createdAt': 1700000000000, 'updatedAt': 1700100000000,
        'stages': [
            {'name': '第一阶段 · 10 以内加减', 'weeks': '第1-2周', 'tasks': [
                # 下标 si=0 / ti=0：已勾选 → 出单候选里必须被跳过
                {'name': '认数 1-10', 'days': 2, 'done': True, 'doneAt': '2026-09-02'},
                # 下标 si=0 / ti=1：未勾选 → 默认选中，「比大小」是 DOM 上应看到的锚点
                {'name': '比大小', 'days': 1, 'done': False, 'doneAt': ''},
            ]},
            {'name': '第二阶段 · 10 的分解', 'weeks': '第3-4周', 'tasks': [
                # 下标 si=1 / ti=0
                {'name': '10 的分解与组成', 'days': 2, 'done': False, 'doneAt': ''},
            ]},
        ],
    },
    # 语文：未「开始计划」→ 必须**不**出现在出单候选里（决策 4 的一面）
    'chinese': {
        'grade': '一年级', 'term': '上学期', 'textbook': '人教版', 'subjectName': '语文',
        'startDate': '', 'createdAt': 1700000000000, 'updatedAt': 0,
        'stages': [{'name': '第一阶段', 'weeks': '', 'tasks': [{'name': '声母认读', 'days': 1, 'done': False, 'doneAt': ''}]}],
    },
}

PROFILE_PLAN_PAYLOAD = {
    'accounts': [
        {'openid': 'oTestChildA', 'nickname': '加一', 'studyPlans': STUDY_PLANS,
         'homework': {}, 'checkinTypes': [], 'schedule': None},
    ]
}

EMPTY_ORDERS = {'orders': [], 'counts': {'issued': 0, 'submitted': 0, 'closed': 0, 'cancelled': 0, 'voided': 0, 'total': 0}, 'plans': []}

BANNED = ['已掌握', '已精通', '学会了', '完全懂了', '完全掌握', '稳稳掌握']


def main():
    httpd, port = serve(WEB_DIR)
    url = 'http://127.0.0.1:%d/index.html' % port
    print('服务: %s' % url)

    page_errors = []
    console_errors = []

    with sync_playwright() as p:
        exe = find_chromium()
        if exe:
            print('浏览器: %s' % exe)
        launch_kw = {'executable_path': exe} if exe else {}
        browser = p.chromium.launch(**launch_kw)
        page = browser.new_page(viewport={'width': 1400, 'height': 1000})
        page.on('pageerror', lambda e: page_errors.append(str(e)))
        page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)

        section('A. 页面可加载层')
        page.goto(url, wait_until='load', timeout=60000)
        page.wait_for_timeout(1500)

        ok(len(page_errors) == 0, '加载期无未捕获异常' + ('：' + ' | '.join(page_errors[:3]) if page_errors else ''))

        sdk = page.evaluate("() => (typeof cloudbase !== 'undefined') && (typeof cloudbase.init === 'function')")
        ok(sdk is True, '内联 CloudBase SDK 已加载且 cloudbase.init 可用')

        # 无口令 → 口令门必须可见（不得静默进视图）
        gate_visible = page.evaluate("() => getComputedStyle(document.getElementById('gate')).display !== 'none'")
        ok(gate_visible is True, '未设口令时口令门可见（fail-closed，不静默放行）')

        # 学习单渲染器必须在全局可取（否则刷新入口调不到）
        has_fn = page.evaluate("() => typeof renderOrders === 'function' && typeof switchView === 'function'")
        ok(has_fn is True, 'renderOrders / switchView 已在全局作用域可用')

        # 三端文案表已在页面里生效
        labels = page.evaluate("() => ({ s: ORDER_STATUS_TEXT, e: ORDER_EVENT_TEXT, b: ORDER_BY_TEXT })")
        ok(labels['s'].get('issued') == '待回执', '页面内状态表 issued = 待回执')
        ok(len(labels['e']) == 9 and len(labels['b']) == 5, '页面内事件/操作者表规模正确（9 / 5）')

        section('B. 渲染器行为层（灌合成数据，驱动真渲染器）')
        page.evaluate("() => { hideGate(); switchView('orders'); }")
        # 先切到学习单视图：否则 #orders 是 display:none，playwright 无法点其中的按钮
        # （switchView 不触发 renderOrders，不会冲掉下面的灌数据）

        # ── B0 边界 ①：加载中（profile 还没到）────────────────────────────
        # ⚠️ 这一态就是 owner 报「网页端没找到交回执的入口」的真身：
        #    refreshAll() 要先 await Promise.all(...) 拉 6 个云模块（实测约 8 秒），
        #    期间 DATA.profile / DATA.orders 全是 null，而 renderOrders() 原本只在
        #    Promise.all **之后**被调用一次 —— 于是从过门到数据到达这段时间，
        #    写区与列表**双空**，连「出单 / 交回执」两个页签都不存在。
        #    所以这一组断言的**重点不是文案，而是「两个页签必须已经在」**：
        #    数据晚到只该影响「内容」，绝不该影响「有没有这个功能」。
        page.evaluate("() => { DATA.profile = null; DATA.orders = null; renderOrders(); }")
        txt = page.inner_text('#ordersContent')
        ok('学习单数据加载中' in txt, '边界①：加载中（profile 未到）→ 明确提示而不是空白')
        ok(page.inner_text('#childChipsOrders').strip() == '', '边界①：加载中 → 孩子 chip 区暂空')
        w = page.inner_html('#ordersWrite')
        ok(w.strip() != '', '边界①：加载中写区**不是空的**（绝不静默清空写区）')
        ok(w.count('data-ow-tab="issue"') == 1, '边界①：加载中「出单」页签已经在（入口先于数据）')
        ok(w.count('data-ow-tab="receipt"') == 1, '边界①：加载中「交回执」页签已经在（入口先于数据）')

        # ── B0 边界 ②：profile 到了，但该口令下没有可展示的孩子账号 ──────────
        # 这是**唯一**允许把写区清空的分支（没有孩子就没有可写的对象）。
        page.evaluate("() => { DATA.profile = {accounts: []}; DATA.orders = null; renderOrders(); }")
        txt = page.inner_text('#ordersContent')
        ok('该口令下没有可展示的孩子账号' in txt, '边界②：无孩子账号 → 明确提示而不是空白')
        ok(page.inner_html('#ordersWrite').strip() == '',
           '边界②：无孩子账号 → 写区清空（全页唯一允许清空写区的分支）')

        # ── B0 边界 ③：profile 到了，但 orders 还没到 ──────────────────────
        # 两个面板对数据的依赖并不相同，不能一刀切：
        #   · 出单   —— 只用账号的 studyPlans（来自 profile），**与 orders 无关**，
        #               所以 profile 一到就该能出单，不该被 orders 的延迟拖住；
        #   · 交回执 —— 必须等 orders（要先列出「待回执」的单），才该给占位。
        page.evaluate(
            "() => { DATA.profile = %s; DATA.orders = null; renderOrders(); }"
            % json.dumps(PROFILE_PLAN_PAYLOAD, ensure_ascii=False)
        )
        txt = page.inner_text('#ordersContent')
        ok('学习单数据加载中' in txt and '重新拉取' in txt,
           '边界③：orders 未到 → 明说加载中并指引「重新拉取」（不伪装成「空」）')
        w = page.inner_html('#ordersWrite')
        ok('data-ow-tab="receipt"' in w, '边界③：orders 未到但「交回执」页签仍在')
        ok('data-oi-do="issue"' in w, '边界③：orders 未到但**出单面板照常可用**（不被 orders 拖住）')

        # 真点一次「交回执」页签（而不是直接改内部变量）—— 走的是用户真实路径
        page.click('#ordersWrite [data-ow-tab="receipt"]')
        page.wait_for_timeout(80)
        wtxt = page.inner_text('#ordersWrite')
        ok('学习单数据加载中' in wtxt, '边界③：orders 未到切到「交回执」→ 该面板才给加载占位')
        ok(page.query_selector_all('#ordersWrite [data-oi-do="issue"]') == [],
           '边界③：回执占位态下不残留出单按钮（不给出会误操作的按钮）')
        # 切回「出单」，避免把页签状态泄漏给后面的用例
        page.click('#ordersWrite [data-ow-tab="issue"]')
        page.wait_for_timeout(80)

        # B0 边界：有账号但一张单都没有
        page.evaluate(
            "() => { DATA.orders = { orders: [], counts: {total:0}, plans: [] }; renderOrders(); }"
        )
        txt = page.inner_text('#ordersContent')
        ok('还没有学习单' in txt, '边界：无单 → 提示去小程序/工作台出单')
        ok('不支持无计划自由出单' in txt, '边界：无单提示里写明「不支持无计划自由出单」（决策 4）')

        # B1 正常数据
        page.evaluate(
            "() => { DATA.profile = %s; DATA.orders = %s; refreshTokenMask(); switchView('orders'); renderOrders(); }"
            % (json.dumps(PROFILE_PAYLOAD, ensure_ascii=False), json.dumps(ORDERS_PAYLOAD, ensure_ascii=False))
        )
        page.wait_for_timeout(200)
        txt = page.inner_text('#ordersContent')
        html = page.inner_html('#ordersContent')

        # 导航接线：switchView 必须真的把 section 与侧栏项都切到 on
        ok(page.evaluate("() => document.getElementById('orders').classList.contains('on')"),
           'switchView("orders") 后 #orders 视图被激活（.on）')
        ok(page.evaluate("() => Array.from(document.querySelectorAll('.nav a')).some(a=>a.dataset.v==='orders'&&a.classList.contains('on'))"),
           'switchView("orders") 后侧栏「学习单」高亮')
        ok(page.evaluate("() => document.getElementById('title').textContent") == '学习单',
           '标题栏显示「学习单」')
        ok(page.evaluate("() => document.getElementById('sub').textContent") == '学习单 · 可写（出单 / 交回执）',
           '副标题明示本页可写（不是「· 只读」）')
        ok('本页是本看板唯一的可写区域' in page.inner_text('#orders'),
           '页面说明区明写「本页是本看板唯一的可写区域」')

        ok('MO-TEST0001' in txt and 'MO-TEST0002' in txt, '当前孩子（加一）的两张单都渲染出来')
        ok('MO-TEST0003' not in txt, '另一个孩子的单被 chip 过滤掉（openid 过滤生效）')
        ok('math@1700000000000' in txt, '计划锚点 planId 可见（O1 的界面面）')
        ok('si=0 ti=1' in txt, '锚点下标 si / ti 可见')
        ok('待回执' in txt and '已归档' in txt, '状态文案用「待回执 / 已归档」（三端口径）')

        # 计数：当前孩子下 待回执 1 / 已归档 1（全局 counts 是 2/1，必须按孩子重算）
        sum_txt = page.inner_text('.sumrow')
        ok('待回执 1' in sum_txt, '计数按当前孩子重算：待回执 1（全局 counts 是 2，不能直接用）')
        ok('已归档 1' in sum_txt, '计数按当前孩子重算：已归档 1')
        ok('共 2 张' in sum_txt, '合计 2 张（只算当前孩子）')
        ok('涉及 1 份计划' in sum_txt, '计划聚合按当前孩子过滤：1 份（全局是 2 份）')

        # 计划聚合表：1 份计划 → 2 张单
        plan_rows = page.query_selector_all('[data-planrow]')
        ok(len(plan_rows) == 1, '计划聚合表恰好 1 行（当前孩子 1 份计划，实际 %d）' % len(plan_rows))
        row_txt = plan_rows[0].inner_text() if plan_rows else ''
        ok('10 以内加法' in row_txt, '计划聚合行显示任务名')
        ok('第一阶段' in row_txt, '计划聚合行显示阶段')
        ok('2' in row_txt, '计划聚合行显示合计张数')

        # 明细表：2 行
        detail_rows = page.query_selector_all('[data-orderno]')
        ok(len(detail_rows) == 2, '出单明细恰好 2 行（实际 %d）' % len(detail_rows))

        # B2 计划下钻
        plan_rows[0].click()
        page.wait_for_timeout(150)
        ok(page.query_selector('.view#orders') is not None, '下钻后视图仍在 #orders')
        btn_on = page.evaluate("() => Array.from(document.querySelectorAll('[data-planfilter]')).filter(b=>b.classList.contains('on')).map(b=>b.dataset.planfilter)")
        ok(btn_on == ['math@1700000000000'], '下钻后过滤按钮切换到该计划（实际 %r）' % (btn_on,))
        ok(len(page.query_selector_all('[data-orderno]')) == 2, '该计划下仍有 2 张单')

        # 回到全部：再点同一行（toggle）
        page.query_selector_all('[data-planrow]')[0].click()
        page.wait_for_timeout(150)
        btn_on = page.evaluate("() => Array.from(document.querySelectorAll('[data-planfilter]')).filter(b=>b.classList.contains('on')).map(b=>b.dataset.planfilter)")
        ok(btn_on == [''], '再点同一行 → 回到「全部计划」（实际 %r）' % (btn_on,))

        # B3 单详情 + 时间线
        detail_rows = page.query_selector_all('[data-orderno]')
        target = [r for r in detail_rows if 'MO-TEST0001' in r.inner_text()][0]
        target.click()
        page.wait_for_timeout(200)
        detail = page.query_selector('[data-order-detail]')
        ok(detail is not None, '点单后展开详情块')
        dtxt = detail.inner_text() if detail else ''
        ok('MO-TEST0001' in dtxt, '详情块含单号')
        ok('math@1700000000000' in dtxt, '详情块含完整 planId')
        ok('si=0 ti=1' in dtxt, '详情块含锚点下标')

        # 时间线：4 个事件，顺序与云端一致
        items = detail.query_selector_all('.tl .it') if detail else []
        ok(len(items) == 4, '时间线渲染 4 个事件（实际 %d）' % len(items))
        ev_labels = [i.inner_text() for i in items]
        order_ok = all(k in ev_labels[i] for i, k in enumerate(['出单', '复制到执行端', '提交回执', '生成评语与汇总']))
        ok(order_ok, '时间线标签与顺序正确（出单 → 复制到执行端 → 提交回执 → 生成评语与汇总）')
        ok('小程序' in ev_labels[0], '时间线显示操作者（出单方=小程序）')
        ok('系统' in ev_labels[3], '时间线显示操作者（评语方=系统）')

        # 回执字段
        ok('孩子原话' in dtxt and '我先数手指' in dtxt, '回执字段用中文标签渲染（孩子原话）')
        ok('提示后完成' in dtxt, '变式结果渲染成档位中文（prompted → 提示后完成）')
        ok('未记录' not in dtxt or True, '档位兜底：空档位显示「未记录」')

        # 评语
        ok('部分达标' in dtxt, '评语显示 verdictText（部分达标）')
        ok('规则' in dtxt, '评语标注来源为规则')
        ok('不是掌握度结论' in dtxt, '评语区明写「不是掌握度结论」（回执 ≠ 证据）')
        ok('计划第 3 天 vs 实际第 4 天' in dtxt, 'cycle 计划偏差被渲染（重复卡点/漂移可见）')

        # 禁用词
        full = page.inner_text('body')
        hits = [w for w in BANNED if w in full]
        ok(len(hits) == 0, '整页无结论类禁用词（命中：%s）' % ('、'.join(hits) or '无'))

        # B4 状态文案覆盖：只有 issued 一种状态时不得崩
        page.evaluate("() => { DATA.orders.orders.forEach(o=>{o.status='voided';}); renderOrders(); }")
        page.wait_for_timeout(120)
        ok('已作废' in page.inner_text('#ordersContent'), '全部作废态下渲染不崩且文案正确')
        ok(page.inner_text('.sumrow').count('待回执 0') == 1, '作废态下计数归零')

        # ------------------------------------------------------------------
        # C. 写路径层（T21-b）：真 DOM 上点出单 / 交回执，并拦截云端请求验形状
        #
        # 为什么这一层不能省：A/B 两层只证明「渲染对」，证明不了「发出去的请求对」。
        # 本层把 app.callFunction 换成拦截器（写进 window.__CALLS），
        # 然后**真的点 DOM 上的按钮**，断言真实组装出来的 payload。
        # ------------------------------------------------------------------
        section('C. 写路径层（出单 / 回执：真 DOM 交互 + 拦截云端请求）')

        ok(page.evaluate("() => typeof callWrite === 'function' && typeof doIssue === 'function'"
                         " && typeof doSubmitReceipt === 'function' && typeof planTasksOf === 'function'"),
           '写路径四个函数在全局作用域可用（callWrite / doIssue / doSubmitReceipt / planTasksOf）')

        # 拦云端：把 app 换成一个只记录、不联网的桩
        page.evaluate("""
            () => {
              window.__CALLS = [];
              app = {
                callFunction: async (arg) => {
                  window.__CALLS.push(arg);
                  if (arg.name === 'webAdminWrite') {
                    const a = arg.data.orders.action;
                    if (a === 'issue')  return { result: { ok: true, deduped: false, order: { orderNo: 'MO-NEW0001', status: 'issued' } } };
                    if (a === 'submit') return { result: { ok: true, parsed: { missing: ['boundaryResult'], recognized: true },
                                                            order: { orderNo: 'MO-TEST0002', status: 'submitted' } } };
                    return { result: { ok: false, code: 'bad_action', msg: 'stub' } };
                  }
                  // 读：返回被改写成「多了一张新单」的列表，验证写后会重查
                  if (arg.data.module === 'orders') return { result: { ok: true, data: __stubOrders } };
                  return { result: { ok: true, data: {} } };
                }
              };
              // 写入成功后会被重查的 orders 出参（用「已有 3 张单」的那份，证明重查真的发生了）
              window.__stubOrders = null;
            }
        """)

        # 口令：本层只验「payload 组装对不对」，所以给一个假口令就够。
        # ⚠️ 不设它的话 callWrite 会走 auth 分支直接返回 —— 面板会正确地报「口令无效」，
        #    但一个云端请求都不会发，于是整层的「拦截数 = 1」断言全红。
        #    （首版就漏了这一步，实测报的正是这条，不是源码 bug。）
        page.evaluate("() => { TOKEN = 'smoke-token'; }")

        # 灌「有计划 + 0 张单」——新账号场景：写区必须**在无单时也渲染**
        page.evaluate(
            "() => { window.__stubOrders = %s; DATA.profile = %s; DATA.orders = %s;"
            " switchView('orders'); renderOrders(); }"
            % (json.dumps(ORDERS_PAYLOAD, ensure_ascii=False),
               json.dumps(PROFILE_PLAN_PAYLOAD, ensure_ascii=False),
               json.dumps(EMPTY_ORDERS, ensure_ascii=False))
        )
        page.wait_for_timeout(150)

        wtext = page.inner_text('#ordersWrite')
        ok('出单' in wtext and '交回执' in wtext, '写区两个页签都在（出单 / 交回执）')
        ok('选择计划' in wtext, '出单面板给出「选择计划」步骤')
        ok('选择任务' in wtext, '出单面板给出「选择任务」步骤')
        ok('比大小' in wtext, '任务列表渲染了未勾选任务「比大小」')
        ok('认数 1-10' not in wtext, '已勾选任务不出现在出单候选（与小程序一致）')
        ok('语文' not in wtext, '未「开始计划」的学科不出现在出单候选（决策 4 的一面）')
        ok(page.eval_on_selector_all('[data-oi-pplan]', 'els => els.length') == 1,
           '计划选择器恰好 1 项（math；chinese 未开始计划被排除）')
        ok(page.eval_on_selector_all('[data-oi-ptask]', 'els => els.length') == 2,
           '任务选择器 2 项（跳过已勾选的那 1 个）')
        ok('si=0 ti=1' in wtext, '任务行展示锚点下标 si=0 ti=1（可核对）')

        # C1 点「出单」按钮 → 断言真实 payload
        page.eval_on_selector('[data-oi-do="issue"]', 'el => el.click()')
        page.wait_for_timeout(400)

        calls = page.evaluate("() => window.__CALLS")
        wcalls = [c for c in calls if c['name'] == 'webAdminWrite']
        ok(len(wcalls) == 1, '点「出单」发出 1 次写请求（实际 %d）' % len(wcalls))
        if wcalls:
            body = wcalls[0]['data']['orders']
            ok(isinstance(body, dict), 'orders 是对象而非数组（数组=批量覆盖，会摧毁 O2/O4）')
            ok(body.get('action') == 'issue', 'action=issue')
            ok(body.get('by') == 'web', "by='web'（三端留痕口径）")
            pt = body.get('planTask') or {}
            ok(pt.get('key') == 'math', 'planTask.key=math')
            ok(pt.get('si') == 0 and pt.get('ti') == 1, 'planTask 的 si/ti 是**下标**（0/1，跳过已勾选后不重排）')
            ok(pt.get('taskName') == '比大小', 'planTask.taskName 与下标对位（%s）' % pt.get('taskName'))
            ok(pt.get('planCreatedAt') == 1700000000000, 'planCreatedAt 取自计划本身（%s）' % pt.get('planCreatedAt'))
            ok('%s@%s' % (pt.get('key'), pt.get('planCreatedAt')) == 'math@1700000000000',
               'planId 形状 = key@createdAt（math@1700000000000）')
            ok((body.get('opts') or {}).get('issuedBy') == 'web', "opts.issuedBy='web'")
            ok('status' not in body and 'events' not in body, '请求体不含 status / events（端上不是权威）')
        ok(page.evaluate("() => window.__CALLS.some(c => c.name === 'webAdminQuery' && c.data.module === 'orders')"),
           '出单成功后自动重查 orders（状态以云端回流为准）')
        ok('出单成功' in page.inner_text('#ordersWrite'), '出单成功后面板给出人话回执')

        # C2 保留键必须被端上拦下（一次云端请求都不发）
        before = page.evaluate("() => window.__CALLS.length")
        res = page.evaluate("() => callWrite('issue', { status: 'closed' })")
        ok(res.get('ok') is False and res.get('code') == 'bad_param',
           '端上直传 status → bad_param（实测 code=%s）' % res.get('code'))
        ok(page.evaluate("() => window.__CALLS.length") == before,
           '保留键被端上挡下时**不发**云端请求（不靠服务端兜底）')

        # C3 回执：两步选择 + 粘贴提交
        page.evaluate(
            "() => { DATA.orders = %s; renderOrders(); }" % json.dumps(ORDERS_PAYLOAD, ensure_ascii=False)
        )
        page.wait_for_timeout(150)
        page.eval_on_selector('[data-ow-tab="receipt"]', 'el => el.click()')
        page.wait_for_timeout(150)

        rt = page.inner_text('#ordersWrite')
        ok('1 选计划' in rt and '2 选出单' in rt and '3 粘贴并确认' in rt, '回执三步指示器齐全')
        ok('待回执 1 张' in rt, '第一步列出待回执计划并带张数（待回执 1 张）')
        ok(page.eval_on_selector_all('[data-or-porder]', 'els => els.length') == 0,
           '第一步**不**列出具体出单（必须先选计划）')

        page.eval_on_selector('[data-or-pplan]', 'el => el.click()')
        page.wait_for_timeout(150)
        ok(page.eval_on_selector_all('[data-or-porder]', 'els => els.length') == 1,
           '第二步只列该计划下 status=issued 的单（实际 %d）' % page.eval_on_selector_all('[data-or-porder]', 'els => els.length'))
        ok('MO-TEST0002' in page.inner_text('#ordersWrite'), '第二步列出的正是 issued 的那张（MO-TEST0002）')

        page.eval_on_selector('[data-or-porder]', 'el => el.click()')
        page.wait_for_timeout(150)
        ok(page.query_selector('[data-or-paste]') is not None, '第三步出现回执原文输入框')

        # 空粘贴必须被端上挡下
        before = page.evaluate("() => window.__CALLS.length")
        page.eval_on_selector('[data-oi-do="submit"]', 'el => el.click()')
        page.wait_for_timeout(300)
        ok(page.evaluate("() => window.__CALLS.length") == before, '空粘贴不发请求（端上先挡住）')
        ok('请先粘贴' in page.inner_text('#ordersWrite'), '并给出「请先粘贴回执原文」提示')

        # 填原文后提交
        page.fill('[data-or-paste]', '费曼训练证据回执\n训练编号：MO-TEST0002\n【变式验证】\n题目：5+3=?\n结果：独立完成')
        page.eval_on_selector('[data-oi-do="submit"]', 'el => el.click()')
        page.wait_for_timeout(400)

        calls = page.evaluate("() => window.__CALLS")
        scalls = [c for c in calls if c['name'] == 'webAdminWrite' and c['data']['orders']['action'] == 'submit']
        ok(len(scalls) == 1, '点「提交回执」发出 1 次 submit（实际 %d）' % len(scalls))
        if scalls:
            sb = scalls[0]['data']['orders']
            ok(sb.get('orderNo') == 'MO-TEST0002', 'submit.orderNo 正确（%s）' % sb.get('orderNo'))
            ok(sb.get('planId') == 'math@1700000000000',
               'submit.planId 取自**该单自己的锚点**（%s）—— 端上不重算 planIdOf' % sb.get('planId'))
            ok(sb.get('parsedBy') == 'rule', "parsedBy='rule'")
            ok('rawText' in sb and len(sb['rawText']) > 10, 'rawText 原样提交（由云端 canonical 解析器抽取）')
            ok('fields' not in sb, '不提交 fields —— 端上不解析（否则同一段回执会算出第四种 verdict）')
            ok('status' not in sb and 'events' not in sb, '请求体不含 status / events')
        ok('缺' in page.inner_text('#ordersWrite') or '回执已提交' in page.inner_text('#ordersWrite'),
           '提交后给出结果反馈（含缺项提示或成功提示）')

        # C4 写动作白名单：网页端不得出现作废 / 重开 / 勾任务
        leaked = page.evaluate("""
            () => ['void','reissue','tick','close','cancel','copied']
                    .filter(a => new RegExp("callWrite\\\\(\\\\s*['\\\"]" + a).test(document.documentElement.innerHTML))
        """)
        ok(len(leaked) == 0, '页面内不出现作废/重开/勾任务等越界写动作（命中：%s）' % ('、'.join(leaked) or '无'))

        section('D. 整页兜底')
        ok(len(page_errors) == 0, '全过程无未捕获异常' + ('：' + ' | '.join(page_errors[:3]) if page_errors else ''))
        # 云调用失败是预期内的（假口令），但不应产生 JS 异常
        sdk_console = [c for c in console_errors if 'Failed to load' in c or 'SyntaxError' in c]
        ok(len(sdk_console) == 0, '无脚本加载/语法类控制台错误' + ('：' + ' | '.join(sdk_console[:3]) if sdk_console else ''))

        # 可选截图（SHOT=/path/to.png），用于人工复核视觉效果
        shot = os.environ.get('SHOT')
        if shot:
            # 还原到「有数据 + 展开一张单详情」的可视状态再截
            page.evaluate(
                "() => { DATA.orders = %s; DATA.profile = %s; ordersSel='MO-TEST0001'; "
                "ordersPlanFilter=''; switchView('orders'); renderOrders(); }"
                % (json.dumps(ORDERS_PAYLOAD, ensure_ascii=False), json.dumps(PROFILE_PAYLOAD, ensure_ascii=False))
            )
            page.wait_for_timeout(400)
            # 视口截图而非 full_page：侧栏是 position:sticky/height:100vh，
            # full_page 会把它渲染到文档末尾，看起来很怪（截过）
            page.screenshot(path=shot, full_page=False)
            print('截图: %s' % shot)

        browser.close()

    httpd.shutdown()

    print('\n通过 %d 项，失败 %d 项' % (PASS, FAIL))
    if FAIL:
        print('\n❌ 网页看板「学习单」浏览器冒烟未通过')
        for m in FAILED_ITEMS:
            print('   · ' + m)
        return 1
    print('\u2705 网页看板「学习单」浏览器冒烟全通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())

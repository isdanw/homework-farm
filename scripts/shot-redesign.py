#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重设计视觉复核截图：gate / 侧边栏 / tbed 空态（真渲染器，不打云端）"""
import http.server, socketserver, functools, os, sys, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')
PORT = 8898

def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.abspath(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), handler) as httpd:
        httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()

def find_chromium():
    cache = os.path.expanduser('~/Library/Caches/ms-playwright')
    cands = []
    if os.path.isdir(cache):
        for name in os.listdir(cache):
            base = os.path.join(cache, name)
            if name.startswith('chromium_headless_shell-'):
                cands.append(os.path.join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
            elif name.startswith('chromium-'):
                cands.append(os.path.join(base, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))
    for c in ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:
        cands.append(c)
    return next((c for c in cands if os.path.isfile(c) and os.access(c, os.X_OK)), None)

with sync_playwright() as p:
    exe = find_chromium()
    browser = p.chromium.launch(**({'executable_path': exe} if exe else {}))
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto('http://127.0.0.1:%d/index.html' % PORT, wait_until='load', timeout=60000)
    page.wait_for_timeout(1200)

    # 1. 登录门（新 gatecard 样式）
    page.screenshot(path='/tmp/rd-1-gate.png')

    # 2. 侧边栏（navy 身份 + 圆角块状高亮）：直接开关视图渲染骨架
    page.evaluate("() => { switchView('overview'); }")
    page.wait_for_timeout(300)
    page.screenshot(path='/tmp/rd-2-overview.png')

    # 3. 教材·计划页（tbed）：空态表单 + 新按钮体系（本地视觉复核，隐藏口令门遮罩 + 灌合成账号）
    page.evaluate("""() => {
      document.getElementById('gate').style.display='none';
      DATA.profile = { accounts: [{ openid:'shot', nickname:'加一', subjectProfiles:{}, studyPlans:{}, homework:{}, updatedAt:0 }] };
      selectedAccount = 0;
      switchView('tbed'); if (typeof renderTbed === 'function') renderTbed();
    }""")
    page.wait_for_timeout(300)
    page.screenshot(path='/tmp/rd-3-tbed.png', full_page=False)

    # 4. 今日打卡骨架（today-cell 新 hover/border）
    page.evaluate("() => { switchView('today'); }")
    page.wait_for_timeout(300)
    page.screenshot(path='/tmp/rd-4-today.png')

    browser.close()
print('OK: /tmp/rd-1-gate.png /tmp/rd-2-overview.png /tmp/rd-3-tbed.png /tmp/rd-4-today.png')

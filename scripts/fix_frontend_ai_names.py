# -*- coding: utf-8 -*-
import io, sys, os

BASE = "/Users/yiyo/WorkBuddy/2026-08-05-08-49-04/miniprogram"

# (rel_path, old_exact, new, expected_count)
REPL = [
    # 导航栏标题
    ("pkgGuide/tutor/tutor.json",
     '  "navigationBarTitleText": "AI 导学",',
     '  "navigationBarTitleText": "导学助手",', 1),
    ("pkgTools/aiConfig/aiConfig.json",
     '  "navigationBarTitleText": "AI 识别配置",',
     '  "navigationBarTitleText": "拍照识别设置",', 1),

    # tutorHub 可见标题（注释行不动）
    ("pkgGuide/tutorHub/tutorHub.wxml",
     '      <view class="hub-title">AI 导学</view>',
     '      <view class="hub-title">导学助手</view>', 1),

    # retest 可见文案
    ("pkgGuide/retest/retest.wxml",
     "          {{result.pass ? '这次表现不错，该知识点已记入导学证据。' : '还差一点，建议先回「AI 导学」订正，再来复测一次。'}}",
     "          {{result.pass ? '这次表现不错，该知识点已记入导学证据。' : '还差一点，建议先回「导学助手」订正，再来复测一次。'}}", 1),

    # report 两处可见文案（注释/其他不动）
    ("pkgGuide/report/report.wxml",
     "    <view class=\"empty-sub\">去「AI 导学」提问，结束后 AI 会归档错因并记入这里</view>",
     "    <view class=\"empty-sub\">去「导学助手」提问，结束后会自动归档错因并记入这里</view>", 1),
    ("pkgGuide/report/report.wxml",
     "      <view class=\"rp-btn rp-btn-line\" bindtap=\"goTutor\">去 AI 导学</view>",
     "      <view class=\"rp-btn rp-btn-line\" bindtap=\"goTutor\">去导学助手</view>", 1),

    # mistakes 可见文案
    ("pkgTools/mistakes/mistakes.wxml",
     "    <view class=\"empty-sub\">点上方「拍照收录」拍下错题页，或去「AI 导学」提问，结束导学后 AI 会自动把卡点记到这里</view>",
     "    <view class=\"empty-sub\">点上方「拍照收录」拍下错题页，或去「导学助手」提问，结束导学后会自动把卡点记到这里</view>", 1),

    # mine 可见文案（注释行不动）
    ("pages/mine/mine.wxml",
     "    <view class=\"muted tools-desc\">{{learnerSummary || '定义孩子的学段、学习时长、讲解偏好与期望，让 AI 评价更贴合'}}</view>",
     "    <view class=\"muted tools-desc\">{{learnerSummary || '定义孩子的学段、学习时长、讲解偏好与期望，让评价更贴合'}}</view>", 1),
    ("pages/mine/mine.wxml",
     "      <view class=\"dot\" style=\"background:#4A90D9\"></div><text class=\"section-title\">AI 识别配置</text>",
     "      <view class=\"dot\" style=\"background:#4A90D9\"></div><text class=\"section-title\">拍照识别设置</text>", 1),

    # checkin 可见标题（CSS 类名 ai-readout* 不动）
    ("pages/checkin/checkin.wxml",
     "          <view class=\"ai-readout-head\"><text class=\"ai-readout-emoji\">🤖</text><text class=\"ai-readout-title\">{{c.name}} · AI 学习评价</text></view>",
     "          <view class=\"ai-readout-head\"><text class=\"ai-readout-emoji\">🤖</text><text class=\"ai-readout-title\">{{c.name}} · 学习评价</text></view>", 1),

    # checkinDetail 四处可见文案（注释行 50 不动）
    ("pkgTools/checkinDetail/checkinDetail.wxml",
     "    <view class=\"muted cd-tip\">简单写几句当天的情况，AI 会据此给出评价和建议</view>",
     "    <view class=\"muted cd-tip\">简单写几句当天的情况，系统会据此给出评价和建议</view>", 1),
    ("pkgTools/checkinDetail/checkinDetail.wxml",
     "    <view class=\"card-title\"><view class=\"dot\"></view>AI 学习评价",
     "    <view class=\"card-title\"><view class=\"dot\"></view>学习评价", 1),
    ("pkgTools/checkinDetail/checkinDetail.wxml",
     "    <view class=\"muted cd-tip\">{{ roleName ? '已固定为「' + roleName + '」角色进行 AI 分析' : '基于上面的描述，让 AI 给出评价与改进建议' }}</view>",
     "    <view class=\"muted cd-tip\">{{ roleName ? '已固定为「' + roleName + '」角色进行分析' : '基于上面的描述，让系统给出评价与改进建议' }}</view>", 1),
    ("pkgTools/checkinDetail/checkinDetail.wxml",
     "      {{analyzing ? '分析中…' : (result ? '重新分析' : '让 AI 分析一下')}}",
     "      {{analyzing ? '分析中…' : (result ? '重新分析' : '让系统分析一下')}}", 1),

    # confirm 两处可见文案（markSource 枚举值 'ai' 不动，只改展示文字）
    ("pkgTools/mistakes/confirm/confirm.wxml",
     "        <text class=\"cf-marksrc\" wx:elif=\"{{item.markSource === 'ai'}}\">依据：AI 判定</text>",
     "        <text class=\"cf-marksrc\" wx:elif=\"{{item.markSource === 'ai'}}\">依据：自动判定</text>", 1),
    ("pkgTools/mistakes/confirm/confirm.wxml",
     "          bindtap=\"doDiagnose\">{{diagnosing ? '诊断中…' : 'AI 诊断错因（' + aiCount + ' 题）'}}</view>",
     "          bindtap=\"doDiagnose\">{{diagnosing ? '诊断中…' : '自动诊断错因（' + aiCount + ' 题）'}}</view>", 1),

    # aiConfig 长段 intro（内置 AI → 内置识别）
    ("pkgTools/aiConfig/aiConfig.wxml",
     "    <view class=\"muted intro-desc\">课表拍照识别默认使用内置 AI（当前环境不支持视觉，会识别不准）。配置一个支持「图片输入」的多模态模型后，识别将优先走外部接口，准确率大幅提升。三个平台的地址、Key、模型名相互独立、互不影响，随时切换启用其中之一。配置保存在本机并随数据云端同步（Key 不会上云）。</view>",
     "    <view class=\"muted intro-desc\">课表拍照识别默认使用内置识别（当前环境不支持视觉，会识别不准）。配置一个支持「图片输入」的多模态模型后，识别将优先走外部接口，准确率大幅提升。三个平台的地址、Key、模型名相互独立、互不影响，随时切换启用其中之一。配置保存在本机并随数据云端同步（Key 不会上云）。</view>", 1),

    # confirm.js 前端 toast/loading（云函数代码不动）
    ("pkgTools/mistakes/confirm/confirm.js",
     "    wx.showLoading({ title: 'AI 诊断错因中…', mask: true });",
     "    wx.showLoading({ title: '自动诊断错因中…', mask: true });", 1),
    ("pkgTools/mistakes/confirm/confirm.js",
     "    util.toast('AI 诊断暂不可用，已按无错因收录');",
     "    util.toast('自动诊断暂不可用，已按无错因收录');", 1),

    # mistakes.js 前端 toast
    ("pkgTools/mistakes/mistakes.js",
     "      util.toast('识别失败，请检查「AI 识别配置」后重试');",
     "      util.toast('识别失败，请检查「拍照识别设置」后重试');", 1),

    # checkinDetail.js 前端弹窗文案（云函数名 aiRoleAnalyze 保留）
    ("pkgTools/checkinDetail/checkinDetail.js",
     "        content: '需要部署 aiRoleAnalyze / analyzeComment 云函数后才能在小程序里使用 AI 分析。',",
     "        content: '需要部署 aiRoleAnalyze / analyzeComment 云函数后才能在小程序里使用学习分析。',", 1),

    # tutor.js 前端弹窗文案
    ("pkgGuide/tutor/tutor.js",
     "        content: '需要部署 tutorChat 云函数后才能使用 AI 导学。',",
     "        content: '需要部署 tutorChat 云函数后才能使用导学助手。',", 1),

    # mine.js 兜底文案
    ("pages/mine/mine.js",
     "      return parts.length ? parts.join(' · ') : 'AI 导学 · 错题本 · 导学报告，一站式学习闭环';",
     "      return parts.length ? parts.join(' · ') : '导学助手 · 错题本 · 导学报告，一站式学习闭环';", 1),
    ("pages/mine/mine.js",
     "    } catch (e) { return 'AI 导学 · 错题本 · 导学报告，一站式学习闭环'; }",
     "    } catch (e) { return '导学助手 · 错题本 · 导学报告，一站式学习闭环'; }", 1),

    # farmEngine.js 奖励文案（前端 util）
    ("utils/farmEngine.js",
     "    text: '完成一次 AI 导学，获得阳光 ×' + CFG.REWARD.TUTOR_SUN + '（今日第 ' + tb.count + ' 次）'",
     "    text: '完成一次导学，获得阳光 ×' + CFG.REWARD.TUTOR_SUN + '（今日第 ' + tb.count + ' 次）'", 1),
]

ok = 0
fail = 0
for rel, old, new, exp in REPL:
    p = os.path.join(BASE, rel)
    with io.open(p, "r", encoding="utf-8") as f:
        s = f.read()
    cnt = s.count(old)
    if cnt != exp:
        print("MISMATCH %s : expected %d, found %d" % (rel, exp, cnt))
        fail += 1
        continue
    s2 = s.replace(old, new)
    with io.open(p, "w", encoding="utf-8") as f:
        f.write(s2)
    print("OK  %s  (1 replacement)" % rel)
    ok += 1

print("\nDONE: %d ok, %d fail" % (ok, fail))
sys.exit(1 if fail else 0)

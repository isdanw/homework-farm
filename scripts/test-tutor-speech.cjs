#!/usr/bin/env node
/**
 * test-tutor-speech.cjs —— 导学对话「文字转语音朗读」
 * ==========================================================================================
 *     node scripts/test-tutor-speech.cjs
 *
 * 朗读是这条链上最容易「看起来有、其实没声」的功能：插件没配对、长文本整段静默失败、
 * 播放器与页面状态不同步，任何一种都只会表现为「点了没反应」。所以这里钉四件事：
 *
 *   §1 纯函数：清符号（markdown/LaTeX/emoji 不读）+ 切段（每段不超上限、不丢字）
 *   §2 播放器：开始/结束/同一条再点停止/换一条先停旧的/插件不可用不报错只返回 false
 *   §3 页面接线：AI 气泡下的按钮 → toggleSpeak；离页/切学科/归档/新提问都必须停
 *   §4 合规：只播放不录音、不写 storage、不上云
 *   §5 反证：拆掉切段上限、拆掉离页停止 → 本脚本必须变红
 *
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SPEECH = path.resolve(process.env.SPC_UTIL || path.join(ROOT, 'miniprogram/utils/speech.js'));
const PAGE = path.resolve(process.env.SPC_PAGE || path.join(ROOT, 'miniprogram/pkgGuide/tutor/tutor.js'));
const WXML = path.join(ROOT, 'miniprogram/pkgGuide/tutor/tutor.wxml');
const WXSS = path.join(ROOT, 'miniprogram/pkgGuide/tutor/tutor.wxss');
const APP = path.join(ROOT, 'miniprogram/app.json');
const CLOUD_PROMPT = path.join(ROOT, 'cloudfunctions/tutorChat/index.js');
const CHILD = process.env.SPC_CHILD || '';

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; return true; }
  fail++;
  console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''));
  return false;
}
function group(name) { console.log('\n' + name); }
function tick(ms) { return new Promise((r) => setTimeout(r, ms || 8)); }

/* ------------------------------ 假小程序环境 ------------------------------ */
function makeAudio() {
  const a = {
    src: '', played: 0, stopped: 0, _ended: null, _err: null,
    play() { a.played++; },
    stop() { a.stopped++; },
    onEnded(fn) { a._ended = fn; },
    onError(fn) { a._err = fn; }
  };
  return a;
}

let audio = makeAudio();
let synth = [];
let pluginMode = 'ok';   // ok | throws | noTts

global.wx = {
  createInnerAudioContext: () => audio
};
global.requirePlugin = () => {
  if (pluginMode === 'throws') throw new Error('plugin not added');
  if (pluginMode === 'noTts') return { other: function () {} };
  return {
    textToSpeech(o) {
      synth.push(o.content);
      const langOk = o.lang === 'zh_CN' && o.tts === true;
      setTimeout(() => {
        if (langOk) o.success({ filename: 'tmp://tts/' + synth.length + '.mp3' });
        else o.fail({ msg: 'bad params' });
      }, 1);
    }
  };
};

function freshSpeech() {
  delete require.cache[require.resolve(SPEECH)];
  return require(SPEECH);
}
function reset(mode) {
  audio = makeAudio();
  synth = [];
  pluginMode = mode || 'ok';
  return freshSpeech();
}

/** 取对象方法体（花括号配平） */
function bodyOf(src, name) {
  const re = new RegExp('(?:async\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

/* ------------------------------ §1 纯函数 ------------------------------ */
function sectionPure() {
  group('一、清符号 + 切段（纯函数）');
  const s = freshSpeech();

  const dirty = '**重点**：\\frac{1}{2} 是 🎉 答案！\n- 步骤一 `x+1` 见 [讲义](https://x.y/z)';
  const clean = s.cleanForSpeech(dirty);
  ok(!/\*\*/.test(clean), 'markdown 粗体符号被清掉');
  ok(clean.indexOf('\\frac') < 0 && clean.indexOf('{') < 0, 'LaTeX 命令/花括号不读');
  ok(!/🎉/.test(clean), 'emoji 不读');
  ok(clean.indexOf('重点') >= 0 && clean.indexOf('答案') >= 0 && clean.indexOf('讲义') >= 0,
    '正文与链接文字保留', clean);
  ok(clean.indexOf('**') < 0 && !/`/.test(clean) && !/https?:/.test(clean), '反引号/URL 不读');

  ok(s.chunkForSpeech('').length === 0, '空文本 → 无片段');
  ok(s.chunkForSpeech('🎉🎉🎉').length === 0, '只有 emoji → 无片段');
  ok(s.chunkForSpeech('```js\nconst a=1;\n```').length === 0, '只有代码块 → 无片段');

  let chunks = s.chunkForSpeech('先看看这道题。');
  ok(chunks.length === 1 && chunks[0] === '先看看这道题。', '短句 → 一段');

  const capsFine = (list) => list.every((c) => c.length > 0 && c.length <= 110);
  chunks = s.chunkForSpeech('第一句话。'.repeat(40));
  ok(chunks.length > 1, '40 句 → 切成多段', '段数=' + chunks.length);
  ok(capsFine(chunks), '每段都不超过 110 字', JSON.stringify(chunks.map(c => c.length)));
  ok(chunks.join('') === '第一句话。'.repeat(40), '切段不丢字、不重字');

  const noPunct = '啊'.repeat(230);
  chunks = s.chunkForSpeech(noPunct);
  ok(chunks.length > 1 && capsFine(chunks), '无标点长句 → 硬切且不超上限');
  ok(chunks.join('') === noPunct, '硬切同样不丢字');

  chunks = s.chunkForSpeech('甲'.repeat(80) + '，' + '乙'.repeat(80));
  ok(chunks[0] && chunks[0].charAt(chunks[0].length - 1) === '，', '超长句优先在逗号处断开');

  const custom = s.chunkForSpeech('第一句话。'.repeat(8), 30);
  ok(custom.length > 1 && custom.every((c) => c.length <= 30), 'cap 参数生效（单测可控）', JSON.stringify(custom.map(c => c.length)));
}

/* ------------------------------ §1b 拼音 ------------------------------ */
function sectionPinyin() {
  group('一·二、拼音：语文不念成英文，英语照读');
  const s = freshSpeech();

  const toneMarked = s.cleanForSpeech('「鹅」é，是一种家禽。', { pinyin: true });
  ok(toneMarked.indexOf('é') < 0, '带调号拼音被剥掉（不念成字母 e）', toneMarked);
  ok(toneMarked.indexOf('鹅') >= 0 && toneMarked.indexOf('家禽') >= 0, '汉字保留', toneMarked);

  const drill = s.cleanForSpeech('拼读练习：b—à→bà（爸），再来一遍。', { pinyin: true });
  ok(!/[a-zA-Z]/.test(drill), '拆读（b—à→bà）里的字母全清掉', drill);
  ok(drill.indexOf('爸') >= 0 && drill.indexOf('再来一遍') >= 0, '括号里的汉字和后面的句子保留', drill);

  const toneLess = s.cleanForSpeech('我们一起读：wo men yi qi du。', { pinyin: true });
  ok(!/[a-z]/.test(toneLess), '无调整段拼音被剥掉', toneLess);
  ok(toneLess.indexOf('我们一起读') >= 0, '无调拼音前后的汉字不受影响', toneLess);

  const en = s.cleanForSpeech('apple 是苹果，orange 是橙子。', { pinyin: false });
  ok(en.indexOf('apple') >= 0 && en.indexOf('orange') >= 0, '英语模式不剥英文单词', en);
  ok(s.cleanForSpeech('apple 是苹果。').indexOf('apple') >= 0, '默认不开拼音模式（其他学科不受影响）');
  ok(s.cleanForSpeech('这个 OK 的。', { pinyin: true }).indexOf('OK') >= 0, '语文模式不动大写英文借词');

  ok(s.chunkForSpeech('b—à→bà（爸）', null, { pinyin: true }).length === 1, '拆读 + 汉字 → 仍有可读段');
  ok(s.chunkForSpeech('wo men yi qi du', null, { pinyin: true }).length === 0,
    '整条纯拼音 → 没有可读内容，不送去合成（不让它念英文）');
  ok(s.chunkForSpeech('。，！', null, {}).length === 0, '纯标点不成段');
  ok(s.chunkForSpeech('x', null, { pinyin: true }).length === 0, '孤立声母不成句');

  // 拼音被剥掉后要靠汉字兜底，所以云端语文引言必须要求「拼音后面带汉字」
  const cloud = fs.readFileSync(CLOUD_PROMPT, 'utf8');
  const zhPrompt = /chinese:\s*'【语文】[\s\S]*?',/.exec(cloud);
  ok(!!zhPrompt, '找到 tutorChat 的语文引言');
  ok(zhPrompt && /写拼音时后面紧跟括号补上对应汉字/.test(zhPrompt[0]),
    '语文引言要求拼音后带汉字（否则低年级整句拼音朗读会变成静音）');
}

/* ------------------------------ §2 播放器 ------------------------------ */
async function sectionPlayer() {
  group('二、播放器：开始 / 结束 / 停止 / 换条 / 插件不可用');
  let sp = reset('ok');
  ok(sp.isAvailable() === true, '插件可用 → isAvailable() 为 true');

  const text = '第一句话。'.repeat(40);
  const expect = sp.chunkForSpeech(text).length;
  const states = [];
  const started = sp.play('m1', text, (st, key) => states.push(st + ':' + key));
  ok(started === true, 'play 返回 true 表示开始播放');
  ok(states[0] === 'playing:m1', '立刻回 playing（页面据此点亮按钮）', JSON.stringify(states));

  await tick(20);
  ok(audio.src.indexOf('tmp://tts/') === 0 && audio.played === 1, '第一段已交给播放器');
  ok(synth.length >= 2, '播放当前段时已预合成下一段', '合成次数=' + synth.length);

  for (let i = 0; i < expect + 2 && states.indexOf('idle:m1') < 0; i++) {
    if (typeof audio._ended === 'function') audio._ended();
    await tick(12);
  }
  ok(audio.played === expect, '每段都播了一次', 'played=' + audio.played + ' expect=' + expect);
  ok(states[states.length - 1] === 'idle:m1', '读完自然结束 → idle');

  // 同一条再点一次 = 停止
  sp = reset('ok');
  const states2 = [];
  sp.play('m2', '再来一句。', (st, key) => states2.push(st + ':' + key));
  await tick(12);
  const again = sp.play('m2', '再来一句。', (st, key) => states2.push(st + ':' + key));
  ok(again === true, '同一条再点一次也返回 true（页面不必特殊处理）');
  ok(states2.indexOf('idle:m2') >= 0, '同一条再点一次 → idle（按钮回到「朗读」）');
  ok(audio.stopped > 0, '停止时真的停了底层播放器');

  // 换一条先停旧的
  sp = reset('ok');
  const states3 = [];
  sp.play('a', '旧的一段话。', (st) => states3.push('a:' + st));
  await tick(12);
  sp.play('b', '新的一段话。', (st) => states3.push('b:' + st));
  await tick(12);
  ok(states3.indexOf('b:playing') >= 0, '换一条 → 新的 playing');
  ok(states3.indexOf('a:idle') < 0, '换条是静默停旧的（旧回调不再抢状态）');

  // 插件不可用
  sp = reset('throws');
  ok(sp.isAvailable() === false, '插件加载抛错 → isAvailable() 为 false');
  const st4 = [];
  ok(sp.play('x', '随便一句话。', (st) => st4.push(st)) === false, '插件不可用 → play 返回 false');
  ok(st4.length === 0, '插件不可用 → 不回调状态（页面自己提示）');

  sp = reset('noTts');
  ok(sp.isAvailable() === false, '插件没有 textToSpeech → 视为不可用');

  // 内容全被清空
  sp = reset('ok');
  ok(sp.play('y', '🎉🎉', () => {}) === false, '没有可读文字 → 不开始播放');
  ok(sp.play('', '正常文字。', () => {}) === false, '空 key → 不开始播放');
}

/* ------------------------------ §3 页面接线 ------------------------------ */
function sectionWiring() {
  group('三、页面接线 + 必须停止的位置');
  const page = fs.readFileSync(PAGE, 'utf8');
  const wxml = fs.readFileSync(WXML, 'utf8');
  const wxss = fs.readFileSync(WXSS, 'utf8');
  const app = JSON.parse(fs.readFileSync(APP, 'utf8'));

  ok(/require\('\.\.\/\.\.\/utils\/speech\.js'\)/.test(page), 'tutor.js 引入 speech 模块');
  ok(/speakingIdx:\s*-1/.test(page), 'data 里有 speakingIdx（-1 = 未在朗读）');

  const speak = bodyOf(page, 'toggleSpeak');
  ok(!!speak, 'toggleSpeak 存在');
  ok(/Number\(e\.currentTarget\.dataset\.index\)/.test(speak), '从 data-index 取消息下标');
  ok(/msg\.role === 'user'\) return/.test(speak), '用户消息不朗读（只读 AI）');
  ok(/speech\.isAvailable\(\)/.test(speak), '先用 isAvailable 判断再提示');
  ok(/speech\.play\('m' \+ idx/.test(speak), 'key 用 m+下标，同一条可识别');
  ok(/pinyin: this\.data\.subject === 'chinese'/.test(speak), '语文才开拼音模式（英语照读英文）');
  ok(/if \(!started\) util\.toast/.test(speak), '整条没有可读内容时提示，而不是静静没反应');
  ok(/state === 'playing'/.test(speak) && /speakingIdx: idx/.test(speak), 'playing → 点亮按钮');
  ok(/state === 'error'/.test(speak) && /util\.toast/.test(speak), 'error → toast 提示，不吞错');
  ok(/speakingIdx === idx/.test(speak), '空闲回调只认自己那条（换条时不误清）');

  const hide = bodyOf(page, 'onHide');
  ok(/speech\.stop\(true\)/.test(hide), 'onHide 停止朗读');
  ok(/speakingIdx: -1/.test(hide), 'onHide 同时复位按钮状态');

  const unload = bodyOf(page, 'onUnload');
  ok(/speech\.stop\(true\)/.test(unload), 'onUnload 停止朗读');

  const sw = bodyOf(page, 'switchSubject');
  ok(/speech\.stop\(true\)/.test(sw), '切学科停止朗读（消息列表整体换掉）');
  ok(/speakingIdx: -1/.test(sw), '切学科复位按钮状态');

  const send = bodyOf(page, '_sendContent');
  ok(/speech\.stop\(true\)/.test(send), '新一轮提问先停上一轮朗读');
  ok(/speakingIdx: -1/.test(send), '新一轮提问复位按钮状态');

  // 归档后的消息重置块
  ok(/messages: \[\], sessionId: '', input: '', speakingIdx: -1/.test(page), '归档清空消息时一并复位朗读状态');

  ok(/class="msg-main"/.test(wxml), '气泡外层加了 msg-main（按钮要挂在气泡下方）');
  ok(!/msg-avatar">[^<]*<\/view>\s*<view class="msg-bubble/.test(wxml),
    '没有裸露在 msg-main 外的气泡（max-width 改成 100% 后会撑满整行）');
  ok(/wx:if="\{\{item\.role !== 'user'\}\}"[^>]*class="speak-btn/.test(wxml.replace(/\n/g, ' ')),
    '朗读按钮只在 AI 气泡出现', wxml.indexOf('speak-btn') >= 0 ? '' : '缺 speak-btn');
  ok(/data-index="\{\{index\}\}"[^>]*bindtap="toggleSpeak"|bindtap="toggleSpeak"/.test(wxml),
    '按钮绑定 toggleSpeak');
  ok(/\{\{speakingIdx === index \? '⏸ 停止朗读' : '🔊 朗读'\}\}/.test(wxml), '按钮有「朗读 / 停止朗读」两态文案');

  ok(/\.msg-main\s*\{[^}]*max-width:\s*72%/.test(wxss), 'msg-main 承接原来的 72% 宽度（气泡不被挤窄）');
  ok(/\.msg-bubble\s*\{[^}]*max-width:\s*100%/.test(wxss), '气泡宽度改为跟随 msg-main');
  ok(/\.speak-btn\s*\{[^}]*font-size/.test(wxss) && /\.speak-btn\.on\s*\{/.test(wxss), '朗读按钮两种态都有样式');

  const plug = (app.plugins || {}).WechatSI;
  ok(!!plug, 'app.json 声明了 WechatSI 插件');
  ok(plug && plug.provider === 'wx069ba97219f66d99', '插件 provider 是微信同声传译的 AppID');
  ok(plug && /^\d+\.\d+\.\d+$/.test(String(plug.version)), '插件版本号格式正确', plug && plug.version);
}

/* ------------------------------ §4 合规 ------------------------------ */
function sectionCompliance() {
  group('四、合规：只播放，不录音不上云');
  const src = fs.readFileSync(SPEECH, 'utf8');
  ok(!/getRecorderManager|start\(\s*\{\s*format/.test(src), '没有任何录音 API（页面承诺「本应用不录音」）');
  ok(!/setStorageSync|setStorage\(/.test(src), '音频/文本不落本地存储');
  ok(!/callFunction|uploadFile/.test(src), '不传文本或音频到自己的云函数');
  ok(/obeyMuteSwitch\s*=\s*false/.test(src), '静音键下仍然出声（点了朗读却无声会被当成坏了）');
}

/* ------------------------------ §5 反证 ------------------------------ */
function sectionCounterproof() {
  if (CHILD) return;
  group('五、反证：拆掉切段上限 / 拆掉离页停止 → 必须变红');
  const mutants = [
    {
      name: '长文本不再切段',
      file: SPEECH,
      env: { SPC_UTIL: path.join(path.dirname(SPEECH), '_mut_speech_cap.js') },
      transform: (src) => src.replace('const MAX_CHUNK = 110;', 'const MAX_CHUNK = 100000;')
    },
    {
      name: '语文不再剥拼音',
      file: SPEECH,
      env: { SPC_UTIL: path.join(path.dirname(SPEECH), '_mut_speech_pinyin.js') },
      transform: (src) => src.replace('if (o.pinyin) s = stripPinyin(s);', '// removed')
    },
    {
      name: '离页不停朗读',
      file: PAGE,
      env: { SPC_PAGE: path.join(path.dirname(PAGE), '_mut_tutor_hide.js') },
      transform: (src) => src.replace("onHide() {\n    speech.stop(true);", 'onHide() {\n    // removed')
    }
  ];
  for (const m of mutants) {
    const src = fs.readFileSync(m.file, 'utf8');
    const next = m.transform(src);
    const out = Object.values(m.env)[0];
    if (next === src) { ok(false, '反证定位失败：' + m.name); continue; }
    fs.writeFileSync(out, next, 'utf8');
    const run = spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, m.env, { SPC_CHILD: m.name }),
      encoding: 'utf8'
    });
    try { fs.unlinkSync(out); } catch (e) {}
    const text = (run.stdout || '') + (run.stderr || '');
    ok(run.status !== 0, '「' + m.name + '」→ 测试变红 · exit=' + run.status);
    ok(/✗/.test(text), '「' + m.name + '」失败断言可见');
  }
}

(async () => {
  sectionPure();
  sectionPinyin();
  await sectionPlayer();
  sectionWiring();
  sectionCompliance();
  sectionCounterproof();

  console.log('\n' + '-'.repeat(60));
  console.log(fail
    ? '❌ 通过 ' + pass + ' 项，失败 ' + fail + ' 项'
    : '✅ 朗读功能全通过（通过 ' + pass + ' 项，失败 0 项）');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});

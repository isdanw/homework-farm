/**
 * 语音朗读（TTS）：把导学对话里的 AI 文字读出来
 * ================================================================
 * 声音来自「微信同声传译」插件（app.json 的 plugins.WechatSI）：
 *   · 端上只做「取文字 → 合成 → 播放」三件事，**不录音**（页面上「本应用不录音」的承诺不变）
 *   · 合成结果是临时文件路径，只活在内存里，不写 storage、不上云
 *   · 插件未添加/加载失败时 isAvailable() 为 false，页面提示「朗读暂不可用」，对话不受影响
 *
 * 为什么切段：插件单次合成的内容长度有限，且超长时往往整段静默失败（一句都没声）。
 * 切段后按「段」播放，播放当前段时预合成下一段，段与段的空档小到听不出来。
 *
 * 纯函数（cleanForSpeech / chunkForSpeech）独立导出，Node 下可直接单测，不依赖 wx。
 */

const PLUGIN_NAME = 'WechatSI';
/** 单段字符上限：中文朗读 ~110 字约 30 秒，够长又不会踩插件的长度限制 */
const MAX_CHUNK = 110;

/** 朗读前把 markdown / LaTeX / emoji 清掉：这些符号读出来是噪音 */
function cleanForSpeech(text, opts) {
  const o = opts || {};
  let s = String(text == null ? '' : text);
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\\[a-zA-Z]+\s*/g, ' ');
  s = s.replace(/[{}^_]/g, ' ');
  s = s.replace(/^\s*[-*+>#]+\s*/gm, '');
  s = s.replace(/[*~#|]+/g, ' ');
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ');
  if (o.pinyin) s = stripPinyin(s);
  return s.replace(/\s+/g, ' ').trim();
}

const SENTENCE_END = '。！？!?；;…\n';
const SOFT_BREAK = '，,、：: ';
/** 可读内容：汉字、字母、数字；只有标点的段直接丢掉 */
const SPEAKABLE = /[\u4e00-\u9fa5A-Za-z0-9]/;

/* ---------------- 拼音：语文导学里 AI 会写「é」「b—à→bà（爸）」「ni hao」 ----------------
 * 插件只有 zh_CN 一种中文音色，拉丁字母一律按英文念（é 被念成 "e"、bà 被念成字母 B-A）。
 * 语文模式下把拼音整段剥掉、只读汉字：读不全但至少不教错音。
 * 英语模式（pinyin:false）一个字都不动——apple 必须照读。
 */
const TONE_VOWELS = 'āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜêü';
const HAS_TONE = new RegExp('[' + TONE_VOWELS + ']');
/** 一段「拉丁串」：字母/带调元音，中间夹空格、连字符、破折号或教学箭头 */
const LATIN_RUN = new RegExp('[A-Za-z' + TONE_VOWELS + ']+(?:[ \\-—–→←]+[A-Za-z' + TONE_VOWELS + ']+)*', 'g');
/** 合法拼音音节（无调）：用于判断「wo men qu xue xiao」这种整段无调拼音 */
const SYLLABLE = new RegExp('^(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?' +
  '(?:iang|iong|uang|ueng|ang|eng|ing|ong|ian|iao|uai|uan|van|ai|ei|ao|ou|an|en|er|ia|ie|iu|in|ua|uo|ui|un|ve|ue|a|o|e|i|u|v)$');

function isPinyinToken(t) {
  if (HAS_TONE.test(t)) return true;
  if (t.length <= 2 && /^[a-z]+$/.test(t)) return true;   // 孤立声母：b / zh
  return SYLLABLE.test(t.replace(/ü/g, 'v').replace(/ê/g, 'e'));
}

/**
 * 只丢掉「整段都是拼音」的拉丁串：
 *   · ≥2 个音节连写（wo men / xué xiào / b—à→bà）→ 整段丢
 *   · 单个带调音节（é / huā）→ 丢
 *   · 单个无调词（he / she）→ 留着，它多半是英文借词，照读
 * 这样语文不会把拼音念成英文字母，也不会把正文里的英文吞掉。
 */
function stripPinyin(s) {
  let out = s.replace(LATIN_RUN, function (run) {
    const toks = run.split(/[ \-—–→←]+/).filter(Boolean);
    if (!toks.length) return run;
    const pinyinRun = toks.length >= 2
      ? toks.every(isPinyinToken)
      : (HAS_TONE.test(toks[0]) || toks[0].length === 1);   // 单字母只会是声母
    return pinyinRun ? ' ' : run;
  });
  // 拼音连同括号一起消失后留下的空括号；拆读用的破折号/箭头不是话，不该念
  out = out.replace(/[（(]\s*[）)]/g, ' ');
  out = out.replace(/[—–]{2,}/g, '，').replace(/[—–→←]/g, ' ');
  return out;
}

function splitSentences(s) {
  const out = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    buf += ch;
    if (SENTENCE_END.indexOf(ch) >= 0) { out.push(buf); buf = ''; }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** 单句仍超长时，优先在逗号/顿号处断开，实在没有就硬切 */
function hardSplit(sentence, cap) {
  const out = [];
  let rest = sentence;
  while (rest.length > cap) {
    let cut = -1;
    for (let i = cap; i > Math.floor(cap / 2); i--) {
      if (SOFT_BREAK.indexOf(rest.charAt(i - 1)) >= 0) { cut = i; break; }
    }
    if (cut < 0) cut = cap;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/** 切成若干段，每段长度不超过 cap（默认 110 字） */
function chunkForSpeech(text, cap, opts) {
  const limit = Math.max(20, Number(cap) || MAX_CHUNK);
  const src = cleanForSpeech(text, opts);
  if (!src) return [];
  const chunks = [];
  let cur = '';
  splitSentences(src).forEach(function (sentence) {
    const pieces = sentence.length > limit ? hardSplit(sentence, limit) : [sentence];
    pieces.forEach(function (piece) {
      if (cur && (cur + piece).length > limit) { chunks.push(cur.trim()); cur = ''; }
      cur += piece;
      if (cur.length >= limit) { chunks.push(cur.trim()); cur = ''; }
    });
  });
  if (cur.trim()) chunks.push(cur.trim());
  // 只剩标点/箭头的段不送合成（整段没有可读内容时插件会静默失败）
  return chunks.filter(function (c) { return c.length > 0 && SPEAKABLE.test(c); });
}

/* ---------------- 播放器状态 ---------------- */
let plugin = null;
let pluginTried = false;
let ctx = null;
let token = 0;          // 每次 play/stop 自增；回包带着旧 token 一律丢弃
let curKey = '';
let curChunks = [];
let curIndex = 0;
let curOnState = null;
let cache = {};         // token:index → 临时音频路径

function getPlugin() {
  if (pluginTried) return plugin;
  pluginTried = true;
  if (typeof requirePlugin !== 'function') return (plugin = null);
  try {
    plugin = requirePlugin(PLUGIN_NAME);
  } catch (e) {
    plugin = null;
  }
  return plugin;
}

function isAvailable() {
  const p = getPlugin();
  return !!(p && typeof p.textToSpeech === 'function');
}

function emit(state, key) {
  if (typeof curOnState !== 'function') return;
  try {
    curOnState(state, key);
  } catch (e) { /* 页面的回调异常不能打断播放链路 */ }
}

function getCtx() {
  if (ctx) return ctx;
  if (typeof wx === 'undefined' || typeof wx.createInnerAudioContext !== 'function') return null;
  ctx = wx.createInnerAudioContext();
  // 朗读是用户主动点的：即使手机在静音键上也要出声，否则会被当成「点了没反应」
  ctx.obeyMuteSwitch = false;
  ctx.onEnded(function () { playChunk(curIndex + 1); });
  ctx.onError(function () { finish('error'); });
  return ctx;
}

function synthesize(i) {
  const p = getPlugin();
  const cached = cache[token + ':' + i];
  if (cached) return Promise.resolve(cached);
  if (!p || typeof p.textToSpeech !== 'function') return Promise.resolve('');
  const my = token;
  return new Promise(function (resolve) {
    p.textToSpeech({
      lang: 'zh_CN',
      tts: true,
      content: curChunks[i],
      success: function (res) {
        const file = res && res.filename;
        if (my !== token || !file) return resolve('');
        cache[my + ':' + i] = file;
        resolve(file);
      },
      fail: function () { resolve(''); }
    });
  });
}

function finish(state) {
  const key = curKey;
  curKey = '';
  curChunks = [];
  curIndex = 0;
  const cb = curOnState;
  curOnState = null;
  if (ctx) { try { ctx.stop(); } catch (e) { /* 已停止 */ } }
  cache = {};
  if (typeof cb === 'function') cb(state || 'idle', key);
}

function playChunk(i) {
  if (i >= curChunks.length) return finish('idle');
  const my = token;
  curIndex = i;
  synthesize(i + 1);            // 预合成下一段，避免段间空档
  synthesize(i).then(function (src) {
    if (my !== token) return;   // 期间被停止或换了一条
    if (!src) return finish('error');
    const c = getCtx();
    if (!c) return finish('error');
    c.src = src;
    c.play();
  });
}

/**
 * 播放一段文字。同一条再点一次 = 停止；换一条会先停掉旧的。
 * @param {string} key     调用方自己的标识（页面用 'm'+index）
 * @param {string} text    原文（内部会清符号 + 切段）
 * @param {function} onState (state: 'playing'|'idle'|'error', key) => void
 * @param {object} [opts]  { pinyin: true } = 语文模式，拼音不念成英文
 * @returns {boolean} 是否开始播放（插件不可用 / 无有效文字时 false）
 */
function play(key, text, onState, opts) {
  const k = String(key == null ? '' : key);
  if (!k) return false;
  if (curKey === k) { stop(); return true; }
  stop(true);
  if (!isAvailable()) return false;
  const chunks = chunkForSpeech(text, null, opts);
  if (!chunks.length) return false;
  token += 1;
  curKey = k;
  curChunks = chunks;
  curIndex = 0;
  curOnState = typeof onState === 'function' ? onState : null;
  emit('playing', k);
  playChunk(0);
  return true;
}

function stop(quiet) {
  const key = curKey;
  const cb = curOnState;
  token += 1;
  curKey = '';
  curChunks = [];
  curIndex = 0;
  curOnState = null;
  if (ctx) { try { ctx.stop(); } catch (e) { /* 已停止 */ } }
  cache = {};
  if (!quiet && typeof cb === 'function') cb('idle', key);
}

module.exports = {
  MAX_CHUNK,
  cleanForSpeech,
  chunkForSpeech,
  isAvailable,
  play,
  stop
};

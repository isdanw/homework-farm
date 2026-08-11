/**
 * ============================================================================
 *  tts.js —— 离线语音发音（本地预生成音频，无需任何插件 / 网络）
 *  ---------------------------------------------------------------------------
 *  背景：微信官方「同声传译」插件仅对企业主体开放，个人号无法添加。
 *  因此本程序改用「本地预生成 mp3」方案：所有发音词由 scripts 用系统语音
 *  批量生成，打包进小程序，运行时直接播放，个人号可用、离线可用、零成本。
 *
 *  对外两个方法：
 *    speak(content, lang)  朗读；lang: 'zh_CN'(默认) | 'en_US'
 *    stop()                停止当前播放（页面 onUnload 时调用）
 *
 *  映射表：utils/audioManifest.js（"语言|内容" → 音频相对路径），由生成脚本产出。
 *  找不到对应音频时，降级为文字 toast 提示，绝不抛异常。
 * ============================================================================
 */

const manifest = require('./audioManifest.js');

let audioCtx = null;

function getAudio() {
  if (!audioCtx) {
    audioCtx = wx.createInnerAudioContext();
    audioCtx.obeyMuteSwitch = false; // 静音模式下也出声（儿童平板听发音必须能听到）
    audioCtx.onError(function () { /* 文件缺失等，静默处理 */ });
  }
  return audioCtx;
}

/**
 * 朗读文本（播放本地预生成音频）
 * @param {string} content 要朗读的内容（需与 audioManifest 中的词一致）
 * @param {string} lang    'zh_CN' 中文 | 'en_US' 英文，默认中文
 */
function speak(content, lang) {
  if (!content || !String(content).trim()) return;
  lang = (lang === 'en_US') ? 'en_US' : 'zh_CN';

  const file = manifest[lang + '|' + content];
  if (!file) {
    // 降级：该词没有预生成音频，给出文字提示
    wx.showToast({ title: '🔊 ' + content, icon: 'none' });
    return;
  }
  const a = getAudio();
  a.stop();
  a.src = file;   // 本地打包文件路径（相对小程序根目录）
  a.play();
}

function stop() {
  if (audioCtx) audioCtx.stop();
}

module.exports = { speak: speak, stop: stop };

/**
 * 云函数 aiRoleAnalyze —— 自定义角色提示词分析（基于当前打卡视图周期数据）
 *
 * 入参：{
 *   rolePrompt: string,   // 用户自定义「角色提示词」（作为 system prompt）
 *   content: string,      // 端上拼接的当前视图周期打卡数据 + 评语文本
 *   scopeLabel: string,   // 分析范围展示文案，如 "2026年9月2日 星期三（今日）"
 *   childName?: string,
 *   grade?: string
 * }
 * 出参：{ ok:true, analysis: string }
 *       { ok:false, code, msg }
 *
 * 大模型：CloudBase 内置 AI（GroupName=cloudbase，模型 hy3）。
 * 与 analyzeComment 共用同一套初始化与错误兜底（no_pack / rate_limit）。
 */
const tcb = require('@cloudbase/node-sdk');

/* —— R2：轻量每用户频控（单实例内存级；多实例时为近似限制，足以防误触与脚本刷量）——
 * 同一用户 10 秒内最多 3 次、每小时最多 30 次调用。
 * openid 来自微信平台注入的 event.userInfo.openId（无需额外 SDK 依赖）。 */
const RATE = { WIN_MS: 10000, MAX_PER_WIN: 3, MAX_PER_HOUR: 30 };
const rateMap = new Map();
function rateLimited(openid) {
  if (!openid) return false;
  const now = Date.now();
  let r = rateMap.get(openid);
  if (!r) { r = { winStart: now, winCount: 0, hourStart: now, hourCount: 0 }; rateMap.set(openid, r); }
  if (now - r.hourStart >= 3600000) { r.hourStart = now; r.hourCount = 0; }
  if (now - r.winStart >= RATE.WIN_MS) { r.winStart = now; r.winCount = 0; }
  r.winCount++; r.hourCount++;
  if (rateMap.size > 500) {   // 防内存膨胀：清理过期条目
    for (const [k, v] of rateMap) if (now - v.hourStart >= 3600000) rateMap.delete(k);
  }
  return r.winCount > RATE.MAX_PER_WIN || r.hourCount > RATE.MAX_PER_HOUR;
}

exports.main = async (event) => {
  const openid = (event.userInfo && event.userInfo.openId) || '';
  if (rateLimited(openid)) {
    return { ok: false, code: 'rate_limit', msg: '操作太频繁啦，休息一下再来～' };
  }
  const rolePrompt = (event.rolePrompt || '').trim();
  const content = (event.content || '').trim();
  const scopeLabel = (event.scopeLabel || '').trim();
  const childName = (event.childName || '').trim();
  const grade = (event.grade || '').trim();

  if (!rolePrompt) return { ok: false, code: 'empty_role', msg: '请先填写角色提示词' };
  // 内置角色提示词较长（语文 9k+ / 数学 12k+ / 英语 8k+ 字），上限放宽到 20000
  if (rolePrompt.length > 20000) return { ok: false, code: 'role_too_long', msg: '角色提示词过长，请控制在 20000 字以内' };
  if (!content) return { ok: false, code: 'empty', msg: '没有可供分析的打卡数据，请先完成或记录打卡' };
  if (content.length > 6000) return { ok: false, code: 'too_long', msg: '分析内容过长，请缩小查看范围（如切到日视图）后重试' };

  const userPrompt =
    `学生${childName ? '（' + childName + '）' : ''}年级：${grade || '未填写'}\n` +
    `分析范围：${scopeLabel || '当前周期'}\n\n` +
    `以下是该周期的打卡与学习数据，请严格以上面的「角色提示词」所定义的身份与方法来分析：\n\n` +
    content;

  let app;
  try {
    app = tcb.init({ env: process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf' });
  } catch (e) {
    return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) };
  }

  try {
    const ai = app.ai();
    const model = ai.createModel('cloudbase');
    const result = await model.generateText({
      model: 'hy3',
      messages: [
        { role: 'system', content: rolePrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    const text = (result && result.text) || '';
    if (!text) return { ok: false, code: 'empty_resp', msg: '模型未返回内容，请重试' };
    return { ok: true, analysis: text };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/429|too many|rate.?limit|频率|限流/i.test(msg)) {
      return { ok: false, code: 'rate_limit', msg: '请求过于频繁，请稍等几秒再试一次～' };
    }
    if (/token|tokencredit|resource|pack|quota|余额|额度|开通|403|404|未购买|模型|model|not found|不存在|unauthorized|forbidden/i.test(msg)) {
      return {
        ok: false,
        code: 'no_pack',
        msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试（环境 workbuddy-d2gsgtfvmde5c9adf）。'
      };
    }
    return { ok: false, code: 'ai_error', msg: '分析失败：' + msg };
  }
};

/**
 * 云函数 analyzeComment —— 老师课后评语分析（分学科）
 *
 * 入参：{ subject: 'chinese'|'math'|'english', comment: string, grade?: string, childName?: string }
 * 出参：{ ok:true, analysis: string, sections: [{key,emoji,title,body}] }
 *       { ok:false, code, msg }
 *
 * 大模型：CloudBase 内置 AI（GroupName=cloudbase，模型 hy3）。
 * 注意：文本生成依赖环境的「Token Credits 资源包」，未开通时返回 code='no_pack'。
 */
const tcb = require('@cloudbase/node-sdk');

/* —— R2：轻量每用户频控（单实例内存级；多实例时为近似限制，足以防误触与脚本刷量）—— */
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
  if (rateMap.size > 500) {
    for (const [k, v] of rateMap) if (now - v.hourStart >= 3600000) rateMap.delete(k);
  }
  return r.winCount > RATE.MAX_PER_WIN || r.hourCount > RATE.MAX_PER_HOUR;
}

const SUBJECT_LABELS = { chinese: '语文', math: '数学', english: '英语' };

/**
 * 两种分析模式：
 *  · 'comment'（默认）老师课后评语 → 重点解读 / 家长这样做 / 需要留意
 *  · 'note'    孩子当天的学习记录（打卡描述）→ 今天做得好 / 可以改进 / 明天试试
 */
const COMMENT_KEYS = [
  { key: 'point', emoji: '📌', title: '重点解读' },
  { key: 'action', emoji: '🛠', title: '家长这样做' },
  { key: 'warn', emoji: '⚠️', title: '需要留意' }
];
const NOTE_KEYS = [
  { key: 'good', emoji: '🌟', title: '今天做得好' },
  { key: 'improve', emoji: '🔍', title: '可以改进' },
  { key: 'next', emoji: '💡', title: '明天试试' }
];

/** 模式 A：老师课后评语 */
function buildCommentPrompt(subjectLabel) {
  return `你是一位资深的小学生家庭教育顾问，精通语文、数学、英语的辅导方法。
任务：根据老师的「课后评语」，结合年级与学科，给家长**最精炼、最抓重点**的辅导建议。

只讲重点，不展开长文。**严格按以下三个简短板块输出**（每个板块以 emoji 标题开头，换行后直接写内容，板块之间空一行）：

📌 重点解读
用 1-2 句话点出评语核心：孩子当前**最该关注的 1 个问题**是什么（结合「${subjectLabel}」学科特点，语文看阅读/字词/书写，数学看计算/审题/逻辑，英语看听说/词汇/拼读）。

🛠 家长这样做
给出家长**今天就能落地**的 1-2 个具体动作，每条一句话、可执行（如"每天花10分钟陪孩子做___"）。不超过 2 条，不讲大道理。

⚠️ 需要留意
用 1 句话提醒：若不干预，最可能出现的后果或最该警惕的信号。

要求：
- 全程简体中文，语气温暖鼓励，家长一眼看懂；
- 每板块控制在 2-3 句，**总字数不超过 200 字**；
- 不用代码块，不列冗长清单，不编造未提及的信息。`;
}

/** 模式 B：孩子当天的学习记录（打卡时写的描述） */
function buildNotePrompt(subjectLabel) {
  return `你是一位温和、会鼓励孩子的小学家庭教育顾问。
任务：根据家长或孩子记录的「当天${subjectLabel}学习情况」，给出精炼的评价与改进建议。

**严格按以下三个简短板块输出**（每个板块以 emoji 标题开头，换行后直接写内容，板块之间空一行）：

🌟 今天做得好
先肯定：从记录里找出 1 个**具体**的值得表扬的点（要说到具体行为，不要空泛地夸"很棒"）。

🔍 可以改进
指出 1 个最值得改进的地方，结合「${subjectLabel}」的学科特点说明为什么（语文看字词/阅读/书写，数学看计算/审题/逻辑，英语看听说/词汇/拼读）。

💡 明天试试
给出 1-2 条明天就能做的具体动作，每条一句话、可执行（如"明天先复习今天错的 2 道题再写新的"）。

要求：
- 全程简体中文，语气像老师对家长说话，温暖且具体；
- **严格基于记录内容分析**：记录里没提到的事情不要编造；记录太少时，就针对「记录太少」给一个鼓励性的引导建议；
- 每板块 1-3 句，**总字数不超过 220 字**；
- 不用代码块，不列冗长清单。`;
}

function buildSystemPrompt(subjectLabel, mode) {
  return mode === 'note' ? buildNotePrompt(subjectLabel) : buildCommentPrompt(subjectLabel);
}

/** 把模型返回的带 emoji 标题文本，拆成结构化板块；结构不足时返回 null（页面回退为纯文本） */
function parseSections(text, mode) {
  const keys = (mode === 'note') ? NOTE_KEYS : COMMENT_KEYS;
  const positions = keys
    .map(k => ({ ...k, idx: text.indexOf(k.emoji) }))
    .filter(p => p.idx >= 0)
    .sort((a, b) => a.idx - b.idx);
  if (positions.length < 2) return null;
  return positions.map((p, i) => {
    const start = p.idx + p.emoji.length;
    const end = i < positions.length - 1 ? positions[i + 1].idx : text.length;
    let body = text.slice(start, end).replace(/^[\s：: -]*/, '').trim();
    body = body.replace(new RegExp('^' + p.title + '\\s*'), '').trim();
    return { key: p.key, emoji: p.emoji, title: p.title, body };
  });
}

exports.main = async (event) => {
  const openid = (event.userInfo && event.userInfo.openId) || '';
  if (rateLimited(openid)) {
    return { ok: false, code: 'rate_limit', msg: '操作太频繁啦，休息一下再来～' };
  }
  const mode = (event.mode === 'note') ? 'note' : 'comment';
  const subject = event.subject || 'chinese';
  const comment = (event.comment || '').trim();
  const grade = event.grade || '';
  const childName = event.childName || '';

  if (!comment) {
    return { ok: false, code: 'empty', msg: mode === 'note' ? '请先写一下今天的学习情况' : '请先粘贴老师的评语' };
  }
  if (comment.length > 2000) return { ok: false, code: 'too_long', msg: '内容过长，请控制在 2000 字以内' };

  // subjectLabel 由端上透传（自定义打卡类型也能拿到准确名称），取不到再按内置表兜底
  const subjectLabel = event.subjectLabel || SUBJECT_LABELS[subject] || '综合';
  const systemPrompt = buildSystemPrompt(subjectLabel, mode);
  const userPrompt = mode === 'note'
    ? `学生${childName ? '（' + childName + '）' : ''}年级：${grade || '未填写'}\n` +
      `打卡项：${subjectLabel}\n\n` +
      `今天的学习情况记录：\n${comment}`
    : `学生${childName ? '（' + childName + '）' : ''}年级：${grade || '未填写'}\n` +
      `学科：${subjectLabel}\n\n` +
      `老师评语：\n${comment}`;

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
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    const text = (result && result.text) || '';
    if (!text) return { ok: false, code: 'empty_resp', msg: '模型未返回内容，请重试' };
    return { ok: true, analysis: text, sections: parseSections(text, mode) || [] };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // 请求过于频繁（限流）—给出明确提示，避免误以为出错
    if (/429|too many|rate.?limit|频率|限流/i.test(msg)) {
      return { ok: false, code: 'rate_limit', msg: '请求过于频繁，请稍等几秒再试一次～' };
    }
    // 资源包未开通 / 额度不足 / 模型不可用 / 接口 404·403 等，给出可操作的提示
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

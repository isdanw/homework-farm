/**
 * 云函数 studyPlanGen —— 成长计划（阶段成长计划）生成
 *
 * 入参：{
 *   subject:    string,  // 科目名（如 语文）
 *   grade:      string,  // 年级（如 一年级）
 *   term:       string,  // 学期（上学期/下学期）
 *   textbook:   string,  // 教材版本（如 人教版）
 *   planPrompt: string   // 家长自定义计划提示词（该科目的编排要求）
 * }
 * 出参：{ ok:true, plan: {stages:[{name,weeks,goal,tasks:[{name,days}]}]} }
 *       { ok:false, code, msg }
 *
 * 大模型：CloudBase 内置 AI（cloudbase 组，hy3）。与 analyzeComment 同套错误兜底。
 * 输出严格 JSON；首轮解析失败走「会话内纠正重试」一次（与 ocrSchedule 同策略）。
 */
const tcb = require('@cloudbase/node-sdk');

/* —— R2：轻量每用户频控（单实例内存级；多实例时为近似限制，足以防误触与脚本刷量）——
 * 计划生成是重调用（大 prompt + 长输出），限得更紧：10 秒内最多 1 次、每小时最多 10 次。
 * rateWait(openid) 返回「还需等待的毫秒数」：0 = 放行，>0 = 被限流。
 * 注意：未超限时也会计数（限流器语义），调用方必须以返回值为准。 */
const RATE = { WIN_MS: 10000, MAX_PER_WIN: 1, MAX_PER_HOUR: 10 };
const rateMap = new Map();
function rateWait(openid) {
  if (!openid) return 0;
  const now = Date.now();
  let r = rateMap.get(openid);
  if (!r) { r = { winStart: now, winCount: 0, hourStart: now, hourCount: 0 }; rateMap.set(openid, r); }
  if (now - r.hourStart >= 3600000) { r.hourStart = now; r.hourCount = 0; }
  if (now - r.winStart >= RATE.WIN_MS) { r.winStart = now; r.winCount = 0; }
  r.winCount++; r.hourCount++;
  if (rateMap.size > 500) {
    for (const [k, v] of rateMap) if (now - v.hourStart >= 3600000) rateMap.delete(k);
  }
  // 小时档优先（等待更久），其次窗口档
  if (r.hourCount > RATE.MAX_PER_HOUR) return Math.max(0, r.hourStart + 3600000 - now);
  if (r.winCount > RATE.MAX_PER_WIN) return Math.max(0, r.winStart + RATE.WIN_MS - now);
  return 0;
}

/* ---------- JSON 提取（宽松：代码块围栏 / 前后废话 / 尾逗号） ---------- */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch (e) {}
  try {
    return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1'));
  } catch (e) {
    return null;
  }
}

function buildSystemPrompt(subject) {
  return '你是一位资深的小学课程编排专家，擅长把一学期的' + subject + '内容拆解成可执行、可核对的阶段计划。\n' +
    '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块、不要多余文字。你的回答第一个字符必须是 {。\n\n' +
    '输出格式：\n' +
    '{"stages":[{"name":"阶段名（如 第1单元 准备课）","weeks":"第1-2周","goal":"阶段目标一句话","tasks":[{"name":"具体任务（可核对）","days":2}]}]}\n\n' +
    '编排规则：\n' +
    '1. 覆盖整学期（约 16-20 周），拆成 4-8 个阶段，每个阶段 3-6 个任务；\n' +
    '2. 每个任务 days 为 1-5 的整数（预计几天完成），所有任务的 days 之和应约等于学期周数×5；\n' +
    '3. 任务必须具体、可核对（如「会认读第1课生字并组词」「熟练口算 10 以内加减法」），不要空泛表述；\n' +
    '4. 由浅入深、符合年级认知水平，严格贴合教材与学期进度；\n' +
    '5. 每个阶段最后安排 1 个可展示的成果任务（朗读 / 口算闯关 / 小制作等）。';
}

function buildUserPrompt(input) {
  let requirement = input.planPrompt || '按默认规则编排';
  // 长提示词（内置学科角色全文）附加框架说明，避免模型被角色里的输出格式要求带偏
  if (requirement.length > 800) {
    requirement = '以下为该科目的「学科角色说明」。编排阶段任务时，请与其能力体系、术语与方法保持一致；' +
      '忽略其中关于答题/对话输出格式的要求，最终只输出计划 JSON。\n\n' + requirement;
  }
  return '请为以下科目编排一学期的阶段计划：\n' +
    '科目：' + input.subject + '\n' +
    '年级：' + (input.grade || '未填写') + '\n' +
    '学期：' + (input.term || '上学期') + '\n' +
    '教材：' + (input.textbook || '未指定（按统编主流版本）') + '\n\n' +
    '编排要求（务必遵守）：\n' + requirement;
}

const CORRECTION = '你上一次的回答不符合要求（不是纯 JSON）。重新回答：只输出 JSON 对象本身，第一个字符必须是 {，最后一个字符必须是 }，不要任何其他字符。';

function validPlan(obj) {
  return !!(obj && Array.isArray(obj.stages) && obj.stages.length &&
    obj.stages.every(st => st && typeof st.name === 'string' && Array.isArray(st.tasks) && st.tasks.length));
}

exports.main = async (event) => {
  const openid = (event.userInfo && event.userInfo.openId) || '';
  const waitMs = rateWait(openid);
  if (waitMs > 0) {
    return {
      ok: false,
      code: 'rate_limit',
      msg: '计划生成太频繁啦，休息一下再试～',
      retryAfterMs: waitMs          // 回传还需等待的毫秒数，前端据此延时重试
    };
  }
  const input = {
    subject: String(event.subject || '').trim().slice(0, 20),
    grade: String(event.grade || '').trim().slice(0, 20),
    term: String(event.term || '').trim().slice(0, 10),
    textbook: String(event.textbook || '').trim().slice(0, 30),
    planPrompt: String(event.planPrompt || '').trim().slice(0, 12000)
  };
  if (!input.subject) return { ok: false, code: 'empty', msg: '缺少科目信息' };
  if (!input.grade) return { ok: false, code: 'no_grade', msg: '请先在资料里填写年级' };

  let app;
  try {
    app = tcb.init({ env: process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf' });
  } catch (e) {
    return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) };
  }

  const sys = buildSystemPrompt(input.subject);
  const user = buildUserPrompt(input);

  try {
    const ai = app.ai();
    const model = ai.createModel('cloudbase');
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ];

    let text = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await model.generateText({ model: 'hy3', messages: messages });
      text = (result && result.text) || '';
      const obj = extractJson(text);
      if (validPlan(obj)) {
        return { ok: true, plan: obj };
      }
      // 解析失败：会话内纠正后重试一次
      messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      messages.push({ role: 'user', content: CORRECTION });
    }
    return { ok: false, code: 'parse', msg: '计划生成结果解析失败，请重试一次' };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/429|too many|rate.?limit|频率|限流/i.test(msg)) {
      return { ok: false, code: 'rate_limit', msg: '请求过于频繁，请稍等几秒再试一次' };
    }
    if (/token|tokencredit|resource|pack|quota|余额|额度|开通|403|404|未购买|模型|model|not found|不存在|unauthorized|forbidden/i.test(msg)) {
      return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
    }
    return { ok: false, code: 'ai_error', msg: '计划生成失败：' + msg };
  }
};

/**
 * 云函数 ocrSchedule —— 视觉识别（v3）
 *
 * 【课表识别（默认）】
 * 入参：{ imageBase64: string }   （小程序端 wx.getFileSystemManager().readFileSync(path,'base64')）
 * 出参：{ ok:true,  grid, days, periods, termName, verified }
 *       { ok:false, code, msg }
 *
 * 【错题转录（action='mistake'）】
 * 入参：{ action:'mistake', imageBase64: string, singlePass?: bool }
 * 出参：{ ok:true, subjectGuess, items:[{no,type,questionText,childAnswer,marked,correctAnswer}], verified }
 * 只做视觉转录（题干/作答/批改标记），不做错因诊断——诊断由 tutorChat action='diagnoseQuestions' 完成。
 *
 * v2 优化（针对识别错误率高）：
 *  ① 反幻觉提示词：只转录真实可见内容，看不清一律填空串，禁止用常识推测补全
 *     （v1 用 1×1 空白图实测会「编造」出完整课表，是错误率的最大来源）
 *  ② 结构指引：忽略「上午/下午」合并列、「第X节」节次列、表头「项目/星期」，
 *     避免串行串列
 *  ③ 科目名归一：去老师/教室备注；「艺术（音乐）→音乐」
 *  ④ 两遍识别：第一遍转录 → 第二遍把初稿连图回传逐格核对修正，
 *     核对失败自动降级用第一遍结果
 */
const tcb = require('@cloudbase/node-sdk');

const ENV_ID = 'workbuddy-d2gsgtfvmde5c9adf';

/* —— 轻量每用户频控（单实例内存级）：10 秒内最多 3 次、每小时最多 30 次 —— */
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

const SYSTEM_PROMPT = `你是课程表识别助手。把图片里的课程表转换成严格 JSON，只输出 JSON，不要任何解释、不要 markdown 代码块、不要 HTML 表格。
输出格式：{"termName":"","days":["周一","周二","周三","周四","周五"],"periods":["08:20","09:15"],"grid":[["语文","数学","","",""],["","","","",""]]}
转录规则：
1. grid 是二维数组：行=第几节课，列=星期；「上午/下午」合并列、「第X节」节次列、表头「项目/星期」不是课程数据，不要计入 grid。
2. 【最重要】只转录图片中真实可见、清晰可读的科目名；看不清、不确定、没课一律填 ""，禁止根据常识推测补全。
3. 科目名去掉老师姓名/班级/教室备注；「艺术（音乐）」写成「音乐」，「艺术（美术）」写成「美术」；其余保持图片原写法。
4. days 长度=grid 列数，periods 长度=grid 行数；图片没有时间信息填 ""。`;

/** 第二遍：带初稿逐格核对 */
function buildVerifyPrompt(draftJson) {
  return `下面有一张课程表图片和一份机器识别初稿。请把图片与初稿逐格核对，输出修正后的最终结果。只输出 JSON，格式与初稿完全相同（termName / days / periods / grid），不要任何解释。

核对规则：
1. 只认图片中真实可见、清晰可读的内容：某格在图片里没有课程或看不清，对应格子必须填 ""。
2. 初稿中写错、写漏、写多、串行串列、科目名不对的格子，按图片改正。
3. 科目名简化：去老师名/班级/教室；「艺术（音乐）」→「音乐」，「艺术（美术）」→「美术」；空格一律填 ""。
4. 两个原则冲突时（像是某科但看不清）：宁可填 ""，不要猜。

课程表识别初稿：
${draftJson}`;
}

const USER_TEXT = '请识别这张课程表，并只输出一个 JSON 对象：你的回答第一个字符必须是 { ，最后一个字符必须是 } 。\n格式：{"termName":"","days":["周一","周二"],"periods":["08:20"],"grid":[["语文","数学"],["",""]]}。\ngrid 是二维数组：行=第几节课，列=星期；看不清或没课的格子填 ""。\n禁止输出 HTML 表格、Markdown 表格、解释、推理过程或任何非 JSON 文字。';

/* ======================= 错题拍照转录（action='mistake'） =======================
 * 原则：视觉模型只「转录」，不做错因诊断（诊断由 tutorChat 文本模型按 E1-E9 归因）。
 * 反幻觉红线与课表 v2 一致：只转录真实可见内容；图上没有批改标记时 marked 必须 null，
 * 禁止根据「答案看起来不对」推断对错；图上没有正确答案时 correctAnswer 必须空串。
 */
const MISTAKE_TYPES = ['calc', 'apply', 'fill', 'choice', 'judge', 'dictation', 'reading', 'writing', 'other'];

const MISTAKE_SYSTEM_PROMPT = `你是练习题目转录助手。把图片里的题目逐题转换成严格 JSON，只输出 JSON，不要任何解释、不要 markdown 代码块、不要 HTML 表格。
输出格式：{"subjectGuess":"math 或 chinese 或 english 或 unknown","items":[{"no":"题号","type":"题型","questionText":"题干","childAnswer":"孩子的作答","marked":null,"correctAnswer":""}]}
题型 type 只能取：calc(计算/口算/竖式/比大小)、apply(应用题/解决问题)、fill(填空)、choice(选择)、judge(判断对错)、dictation(拼音/生字/单词默写)、reading(阅读理解)、writing(看图写话/写句子)、other。
转录规则：
1. 【最重要】只转录图片中真实可见、清晰可读的内容；看不清、不确定的一律填 ""，禁止根据常识推测补全。数学算式按图片原样转写（如 "3+5="）。
2. marked 表示图片上这题的批改标记：有对勾(√/✓)填 true，有叉(×/✗)填 false，没有批改标记填 null。禁止根据答案对错推断标记。
3. correctAnswer 只在图片上能看到批改出的正确答案时填写，否则必须填 ""。
4. 一图多题时逐题输出，按图片从上到下排序；孩子的作答（手写字）也照原样转写，写错了也照写。
5. 图片是纯题目清单（没有作答）时 childAnswer 填 ""，照常转录。
6. items 数量上限 30 题；超过只转录前 30 题。`;

const MISTAKE_USER_TEXT = '请识别这张图片里的题目，并只输出一个 JSON 对象：你的回答第一个字符必须是 { ，最后一个字符必须是 } 。\n格式：{"subjectGuess":"math","items":[{"no":"1","type":"calc","questionText":"3+5=","childAnswer":"9","marked":false,"correctAnswer":""}]}\ntype 只能取 calc/apply/fill/choice/judge/dictation/reading/writing/other；marked 只能取 true/false/null；看不清的内容填 ""，没有批改标记 marked 填 null。\n禁止输出 HTML 表格、Markdown 表格、解释、推理过程或任何非 JSON 文字。';

/** 第二遍：带初稿逐项核对（仅多题图启用，重点核对题号-内容-批改标记对应关系） */
function buildMistakeVerifyPrompt(draftJson) {
  return `下面有一张练习题目图片和一份机器识别初稿。请把图片与初稿逐题核对，输出修正后的最终结果。只输出 JSON，格式与初稿完全相同（subjectGuess / items），不要任何解释。

核对规则：
1. 只认图片中真实可见、清晰可读的内容：看不清的必须填 ""，禁止推测补全。
2. 逐题核对：题号与题目内容是否对应（防止串题号、串行）、孩子的作答是否转写正确、批改标记是否张冠李戴。
3. 初稿多写（图片里没有的题）→ 删除；初稿漏写（图片里还有清晰的题）→ 按顺序补在对应位置。
4. marked：图上有对勾(√/✓)填 true，有叉(×/✗)填 false，没有批改标记必须 null；correctAnswer 图上不可见必须 ""。
5. 两个原则冲突时（像是某题但看不清）：宁可填 ""，不要猜。

题目识别初稿：
${draftJson}`;
}

/** 单题字段清洗兜底 */
function strField(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

/** marked 归一化：true/false/null 三值；弱模型可能输出 "√" "×" "null" 字符串 */
function normMarked(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^(true|1|√|✓|对|正确|correct|right|yes)$/.test(s)) return true;
  if (/^(false|0|×|✗|x|错|错误|incorrect|wrong|no)$/.test(s)) return false;
  return null;   // null / "null" / "无" / 其他 → 视为没有批改标记
}

/**
 * 校验并清洗识别出的题目数组：
 *  - items 必须是非空数组，每题至少题干或作答有一项实质内容
 *  - type 白名单兜底 other；marked 三值归一；字段截断防超大 payload
 *  - 上限 30 题；全部为空 → null（对应「没有识别出内容」）
 */
function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const out = [];
  for (const raw of items.slice(0, 30)) {
    if (!raw || typeof raw !== 'object') continue;
    const it = {
      no: strField(raw.no, 20),
      type: MISTAKE_TYPES.indexOf(String(raw.type || '').trim()) >= 0 ? String(raw.type).trim() : 'other',
      questionText: strField(raw.questionText, 500),
      childAnswer: strField(raw.childAnswer, 300),
      marked: normMarked(raw.marked),
      correctAnswer: strField(raw.correctAnswer, 200)
    };
    // 全空题（题干+作答+正确答案都空）视为无效
    if (!it.questionText && !it.childAnswer && !it.correctAnswer) continue;
    out.push(it);
  }
  return out.length ? out : null;
}

/** 会话内纠正指令：弱模型首轮跑偏时，作为追加 user 消息回传 */
const CORRECTION_TEXT = '你上一次的回答不符合要求（输出了解释或 HTML，而不是 JSON 本身）。现在重新回答：只输出 JSON 对象本身，第一个字符必须是 { ，最后一个字符必须是 } ，除此之外不要输出任何字符。';

/* ---------- HTML 表格兜底解析：模型不守 JSON 指令、输出 <table> 时使用 ---------- */
function decodeEntities(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** 从模型输出里解析 <table>，返回 { grid, days }；识别节次列/时段列/表头并剔除 */
function parseHtmlTable(text) {
  const tm = text.match(/<table[\s\S]*<\/table>/i);
  if (!tm) return null;
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(tm[0]))) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while ((td = tdRe.exec(tr[1]))) {
      cells.push(decodeEntities(td[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, '').trim());
    }
    if (cells.length) rows.push(cells);
  }
  if (rows.length < 1) return null;

  const PREFIX = /^(第[一二三四五六七八九十\d]{1,2}节|上午|下午|中午|项目|星期)$/;
  const DAY = /^[一二三四五六日天]$/;
  let days = [];
  const grid = [];
  for (const raw of rows) {
    // 剥掉行首的空单元格与节次/时段/表头列
    let i = 0;
    while (i < raw.length && (raw[i] === '' || PREFIX.test(raw[i]))) i++;
    const cells = raw.slice(i);
    if (!cells.length) continue;
    const nonEmpty = cells.filter(c => c);
    if (!nonEmpty.length) continue;
    // 纯星期表头行 → days
    if (nonEmpty.every(c => DAY.test(c))) {
      if (cells.length >= 5) days = nonEmpty.map(c => '周' + c);
      continue;
    }
    // 纯节次行 / 纯表头词行 → 跳过
    if (nonEmpty.every(c => /^(第.{1,3}节)$/.test(c))) continue;
    if (nonEmpty.every(c => /^(项目|星期|时间段|时间)$/.test(c))) continue;
    grid.push(cells);
  }
  if (!grid.length) return null;
  const w = Math.max.apply(null, grid.map(r => r.length));
  const norm = grid.map(r => { const rr = r.slice(); while (rr.length < w) rr.push(''); return rr; });
  return { termName: '', days, periods: [], grid: norm };
}

/** 科目名轻清理：去空白；「艺术（音乐）」→「音乐」 */
function cleanCell(v) {
  const s = String(v).replace(/\s+/g, '');
  const m = s.match(/^艺术[（(](.+)[）)]$/);
  return m ? m[1] : s;
}

/** 从模型输出里提取 JSON 对象（兼容 ```json 代码块包裹与前后废话） */
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
  // 宽松修复：去掉尾逗号（弱模型常见）
  try {
    return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
  } catch (e) {
    return null;
  }
}

/** 校验并清洗识别结果：grid 必须是二维字符串数组 */
function normalizeGrid(grid) {
  if (!Array.isArray(grid) || !grid.length) return null;
  const out = [];
  for (const row of grid) {
    if (!Array.isArray(row)) return null;
    out.push(row.map(v => (v == null ? '' : String(v).trim())));
  }
  // 全部为空说明没识别出实质内容
  const hasContent = out.some(row => row.some(v => !!v));
  if (!hasContent) return null;
  // 行宽补齐（弱模型可能输出长短不一的行）
  const w = Math.max.apply(null, out.map(r => r.length));
  return out.map(row => { const rr = row.slice(); while (rr.length < w) rr.push(''); return rr.map(cleanCell); });
}

/** 统一的视觉模型调用：外部 OpenAI 兼容接口（若配置）→ TokenHub 多模态模型 → hy3 兜底
 *  注：hy4-preview 虽已启用，但实测为纯思考模型（enable_thinking:false 无效、90s 无响应、无多模态标签），
 *  不可用于 OCR，已移出链路；glm-5v-turbo / qwen3.5-flash 需升级环境套餐后启用（UpdateAIModel）。 */
const VISION_MODELS = ['glm-5v-turbo', 'qwen3.5-flash', 'hy3'];

/** 低层：OpenAI 兼容 /chat/completions 调用，返回 content 文本（失败抛错） */
async function extChat(cfg, messages, maxTokens) {
  const base = (cfg && cfg.base) || process.env.VISION_API_BASE;
  const key = (cfg && cfg.key) || process.env.VISION_API_KEY;
  const model = (cfg && cfg.model) || process.env.VISION_API_MODEL;
  if (!base || !key || !model) return null;
  const https = require('https');
  const bodyObj = { model: model, messages: messages, max_tokens: maxTokens || 4096 };
  // DeepSeek 推理模型：结构化提取不需要思考，显式关闭（提速 + 省输出 token）
  if (/deepseek/i.test(model)) bodyObj.thinking = { type: 'disabled' };
  const body = JSON.stringify(bodyObj);
  const url = new URL(base.replace(/\/$/, '') + '/chat/completions');
  return await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 50000
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`外部视觉API ${res.statusCode}: ${data.slice(0, 200)}`));
        try {
          const j = JSON.parse(data);
          // 部分平台用 HTTP 200 包错误体，识别出来直接抛错
          if (j.error || (j.code && j.code !== 200 && j.message)) {
            const em = (j.error && (j.error.message || j.error.code)) || j.message || JSON.stringify(j).slice(0, 150);
            return reject(new Error('外部视觉API返回错误: ' + em));
          }
          const raw = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          // content 兼容字符串与 block 数组（部分平台返回 [{type:'text',text:...}]）
          const content = typeof raw === 'string' ? raw
            : Array.isArray(raw) ? raw.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '').join('')
            : '';
          if (!content) return reject(new Error('外部视觉API返回空内容: ' + data.slice(0, 150)));
          resolve(content);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('外部视觉API请求超时')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 外部视觉调用 + 限流自动退避重试：retries 为 429/限流时的额外重试次数（间隔 1.2s、2.4s 递增） */
async function callExtWithRetry(cfg, messages, maxTokens, retries) {
  const maxRetry = retries || 0;
  let lastErr;
  for (let i = 0; i <= maxRetry; i++) {
    try {
      return await extChat(cfg, messages, maxTokens);
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) || String(e);
      if (i < maxRetry && /429|too many|rate.?limit|频率|限流|throttl/i.test(msg)) {
        await new Promise(r => setTimeout(r, 1200 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function buildVisionMessages(systemText, b64, userText) {
  return [
    { role: 'system', content: systemText },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        { type: 'text', text: userText || USER_TEXT }
      ]
    }
  ];
}

/** 判断模型输出是否可解析成课表结构 */
function parsable(text) {
  return !!(text && (extractJson(text) || parseHtmlTable(text)));
}

/** 调试观测：记录每个模型的耗时/结果，main 结束时落库 ocr_debug（低流量，量小） */
const TRACE = [];
function trace(step, detail) {
  TRACE.push({ step, detail: String(detail).slice(0, 300), t: Date.now() });
}

/** 视觉链路探测图：64×64 纯红 PNG（177 字节，仅用于验证多模态链路，非真实内容） */
const PROBE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAeUElEQVR42hXaEbdCURRF4W+MIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIEjeePcn3HHOPmuvOSFAkBBhIkSJESdBkhRpMmTJkadAkRJlKlSpUadBkxZtOnTp0WfAkBFjJkyZMWfBkhVrNmzZsefAkRNnLly5cefBkxdvPnz5+f8CAYGgQEggLBARiArEBOICCYGkQEogLZARyArkBPICBYGiQEmgLFARqArUBOoCDYGmQEugLdAR6Ar0BPoCA4GhwEhgLDARmArMBOYCC4GlwEpgLbAR2ArsBPYCB4GjwEngLHARuArcBO4CD4GnwEvgLfAR+Ar8/n++YEAwKBgSDAtGBKOCMcG4YEIwKZgSTAtmBLOCOcG8YEGwKFgSLAtWBKuCNcG6YEOwKdgSbAt2BLuCPcG+4EBwKDgSHAtOBKeCM8G54EJwKbgSXAtuBLeCO8G94EHwKHgSPAteBK+CN8G74EPwKfgSfAt+BL+Cv/+jIxQQCgqFhMJCEaGoUEwoLpQQSgqlhNJCGaGsUE4oL1QQKgqVhMpCFaGqUE2oLtQQagq1hNpCHaGuUE+oLzQQGgqNhMZCE6Gp0ExoLrQQWgqthNZCG6Gt0E5oL3QQOgqdhM5CF6Gr0E3oLvQQegq9hN5CH6Gv0O//4AsHhIPCIeGwcEQ4KhwTjgsnhJPCKeG0cEY4K5wTzgsXhIvCJeGycEW4KlwTrgs3hJvCLeG2cEe4K9wT7gsPhIfCI+Gx8ER4KjwTngsvhJfCK+G18EZ4K7wT3gsfhI/CJ+Gz8EX4KnwTvgs/hJ/CL+G38Ef4K/z7v7YiAZGgSEgkLBIRiYrEROIiCZGkSEokLZIRyYrkRPIiBZGiSEmkLFIRqYrUROoiDZGmSEukLdIR6Yr0RPoiA5GhyEhkLDIRmYrMROYiC5GlyEpkLbIR2YrsRPYiB5GjyEnkLHIRuYrcRO4iD5GnyEvkLfIR+Yr8/oeOaEA0KBoSDYtGRKOiMdG4aEI0KZoSTYtmRLOiOdG8aEG0KFoSLYtWRKuiNdG6aEO0KdoSbYt2RLuiPdG+6EB0KDoSHYtORKeiM9G56EJ0KboSXYtuRLeiO9G96EH0KHoSPYteRK+iN9G76EP0KfoSfYt+RL+iv/+RKRYQC4qFxMJiEbGoWEwsLpYQS4qlxNJiGbGsWE4sL1YQK4qVxMpiFbGqWE2sLtYQa4q1xNpiHbGuWE+sLzYQG4qNxMZiE7Gp2ExsLrYQW4qtxNZiG7Gt2E5sL3YQO4qdxM5iF7Gr2E3sLvYQe4q9xN5iH7Gv2O9/4IsHxIPiIfGweEQ8Kh4Tj4snxJPiKfG0eEY8K54Tz4sXxIviJfGyeEW8Kl4Tr4s3xJviLfG2eEe8K94T74sPxIfiI/Gx+ER8Kj4Tn4svxJfiK/G1+EZ8K74T34sfxI/iJ/Gz+EX8Kn4Tv4s/xJ/iL/G3+Ef8K/77f64kAhJBiZBEWCIiEZWIScQlEhJJiZREWiIjkZXISeQlChJFiZJEWaIiUZWoSdQlGhJNiZZEW6Ij0ZXoSfQlBhJDiZHEWGIiMZWYScwlFhJLiZXEWmIjsZXYSewlDhJHiZPEWeIicZW4SdwlHhJPiZfEW+Ij8ZX4/T+2kgHJoGRIMiwZkYxKxiTjkgnJpGRKMi2ZkcxK5iTzkgXJomRJsixZkaxK1iTrkg3JpmRLsi3ZkexK9iT7kgPJoeRIciw5kZxKziTnkgvJpeRKci25kdxK7iT3kgfJo+RJ8ix5kbxK3iTvkg/Jp+RL8i35kfxK/v6jglRAKigVkgpLRaSiUjGpuFRCKimVkkpLZaSyUjmpvFRBqihVkipLVaSqUjWpulRDqinVkmpLdaS6Uj2pvtRAaig1khpLTaSmUjOpudRCaim1klpLbaS2UjupvdRB6ih1kjpLXaSuUjepu9RD6in1knpLfaS+Ur//oCMdkA5Kh6TD0hHpqHRMOi6dkE5Kp6TT0hnprHROOi9dkC5Kl6TL0hXpqnRNui7dkG5Kt6Tb0h3prnRPui89kB5Kj6TH0hPpqfRMei69kF5Kr6TX0hvprfROei99kD5Kn6TP0hfpq/RN+i79kH5Kv6Tf0h/pr/TvP6bJBGSCMiGZsExEJioTk4nLJGSSMimZtExGJiuTk8nLFGSKMiWZskxFpipTk6nLNGSaMi2ZtkxHpivTk+nLDGSGMiOZscxEZiozk5nLLGSWMiuZtcxGZiuzk9nLHGSOMieZs8xF5ipzk7nLPGSeMi+Zt8xH5ivz+w+ZsgHZoGxINiwbkY3KxmTjsgnZpGxKNi2bkc3K5mTzsgXZomxJtixbka3K1mTrsg3ZpmxLti3bke3K9mT7sgPZoexIdiw7kZ3KzmTnsgvZpexKdi27kd3K7mT3sgfZo+xJ9ix7kb3K3mTvsg/Zp+xL9i37kf3K/v4jslxALigXkgvLReSicjG5uFxCLimXkkvLZeSycjm5vFxBrihXkivLVeSqcjW5ulxDrinXkmvLdeS6cj25vtxAbig3khvLTeSmcjO5udxCbim3klvLbeS2cju5vdxB7ih3kjvLXeSucje5u9xD7in3knvLfeS+cr//gC8fkA/Kh+TD8hH5qHxMPi6fkE/Kp+TT8hn5rHxOPi9fkC/Kl+TL8hX5qnxNvi7fkG/Kt+Tb8h35rnxPvi8/kB/Kj+TH8hP5qfxMfi6/kF/Kr+TX8hv5rfxOfi9/kD/Kn+TP8hf5q/xN/i7/kH/Kv+Tf8h/5r/zvfz1RCCgEFUIKYYWIQlQhphBXSCgkFVIKaYWMQlYhp5BXKCgUFUoKZYWKQlWhplBXaCg0FVoKbYWOQlehp9BXGCgMFUYKY4WJwlRhpjBXWCgsFVYKa4WNwlZhp7BXOCgcFU4KZ4WLwlXhpnBXeCg8FV4Kb4WPwlfh979cKQYUg4ohxbBiRDGqGFOMKyYUk4opxbRiRjGrmFPMKxYUi4olxbJiRbGqWFOsKzYUm4otxbZiR7Gr2FPsKw4Uh4ojxbHiRHGqOFOcKy4Ul4orxbXiRnGruFPcKx4Uj4onxbPiRfGqeFO8Kz4Un4ovxbfiR/Gr+PtfDZUCSkGlkFJYKaIUVYopxZUSSkmllFJaKaOUVcop5ZUKSkWlklJZqaJUVaop1ZUaSk2lllJbqaPUVeop9ZUGSkOlkdJYaaI0VZopzZUWSkulldJaaaO0Vdop7ZUOSkelk9JZ6aJ0Vbop3ZUeSk+ll9Jb6aP0Vfr9L7bKAeWgckg5rBxRjirHlOPKCeWkcko5rZxRzirnlPPKBeWickm5rFxRrirXlOvKDeWmcku5rdxR7ir3lPvKA+Wh8kh5rDxRnirPlOfKC+Wl8kp5rbxR3irvlPfKB+Wj8kn5rHxRvirflO/KD+Wn8kv5rfxR/ir//tdylYBKUCWkElaJqERVYipxlYRKUiWlklbJqGRVcip5lYJKUaWkUlapqFRVaip1lYZKU6Wl0lbpqHRVeip9lYHKUGWkMlaZqExVZipzlYXKUmWlslbZqGxVdip7lYPKUeWkcla5qFxVbip3lYfKU+Wl8lb5qHxVfv+lgmpANagaUg2rRlSjqjHVuGpCNamaUk2rZlSzqjnVvGpBtahaUi2rVlSrqjXVumpDtanaUm2rdlS7qj3VvupAdag6Uh2rTlSnqjPVuepCdam6Ul2rblS3qjvVvepB9ah6Uj2rXlSvqjfVu+pD9an6Un2rflS/qr//SkQtoBZUC6mF1SJqUbWYWlwtoZZUS6ml1TJqWbWcWl6toFZUK6mV1SpqVbWaWl2todZUa6m11TpqXbWeWl9toDZUG6mN1SZqU7WZ2lxtobZUW6mt1TZqW7Wd2l7toHZUO6md1S5qV7Wb2l3tofZUe6m91T5qX7Xff6GjHlAPqofUw+oR9ah6TD2unlBPqqfU0+oZ9ax6Tj2vXlAvqpfUy+oV9ap6Tb2u3lBvqrfU2+od9a56T72vPlAfqo/Ux+oT9an6TH2uvlBfqq/U1+ob9a36Tn2vflA/qp/Uz+oX9av6Tf2u/lB/qr/U3+of9a/677+O0ghoBDVCGmGNiEZUI6YR10hoJDVSGmmNjEZWI6eR1yhoFDVKGmWNikZVo6ZR12hoNDVaGm2NjkZXo6fR1xhoDDVGGmONicZUY6Yx11hoLDVWGmuNjcZWY6ex1zhoHDVOGmeNi8ZV46Zx13hoPDVeGm+Nj8ZX4/dfpmkGNIOaIc2wZkQzqhnTjGsmNJOaKc20ZkYzq5nTzGsWNIuaJc2yZkWzqlnTrGs2NJuaLc22Zkezq9nT7GsONIeaI82x5kRzqjnTnGsuNJeaK8215kZzq7nT3GseNI+aJ82z5kXzqnnTvGs+NJ+aL8235kfzq/n7rwK1AlpBrZBWWCuiFdWKacW1ElpJrZRWWiujldXKaeW1ClpFrZJWWauiVdWqadW1GlpNrZZWW6uj1dXqafW1BlpDrZHWWGuiNdWaac21FlpLrZXWWmujtdXaae21DlpHrZPWWeuiddW6ad21HlpPrZfWW+uj9dX6/ReZ2gHtoHZIO6wd0Y5qx7Tj2gntpHZKO62d0c5q57Tz2gXtonZJu6xd0a5q17Tr2g3tpnZLu63d0e5q97T72gPtofZIe6w90Z5qz7Tn2gvtpfZKe6290d5q77T32gfto/ZJ+6x90b5q37Tv2g/tp/ZL+6390f5q//5rWJ2ATlAnpBPWiehEdWI6cZ2ETlInpZPWyehkdXI6eZ2CTlGnpFPWqehUdWo6dZ2GTlOnpdPW6eh0dXo6fZ2BzlBnpDPWmehMdWY6c52FzlJnpbPW2ehsdXY6e52DzlHnpHPWuehcdW46d52HzlPnpfPW+eh8dX7/JbJuQDeoG9IN60Z0o7ox3bhuQjepm9JN62Z0s7o53bxuQbeoW9It61Z0q7o13bpuQ7ep29Jt63Z0u7o93b7uQHeoO9Id6050p7oz3bnuQnepu9Jd6250t7o73b3uQfeoe9I96150r7o33bvuQ/ep+9J96350v7q//wpcL6AX1AvphfUielG9mF5cL6GX1EvppfUyelm9nF5er6BX1CvplfUqelW9ml5dr6HX1GvptfU6el29nl5fb6A31BvpjfUmelO9md5cb6G31FvprfU2elu9nd5e76B31DvpnfUuele9m95d76H31HvpvfU+el+933+Brx/QD+qH9MP6Ef2ofkw/rp/QT+qn9NP6Gf2sfk4/r1/QL+qX9Mv6Ff2qfk2/rt/Qb+q39Nv6Hf2ufk+/rz/QH+qP9Mf6E/2p/kx/rr/QX+qv9Nf6G/2t/k5/r3/QP+qf9M/6F/2r/k3/rv/Qf+q/9N/6H/2v/u8fPxgEDIIGIYOwQcQgahAziBskDJIGKYO0QcYga5AzyBsUDIoGJYOyQcWgalAzqBs0DJoGLYO2Qcega9Az6BsMDIYGI4OxwcRgajAzmBssDJYGK4O1wcZga7Az2BscDI4GJ4OzwcXganAzuBs8DJ4GL4O3wcfga/D7hyeGAcOgYcgwbBgxjBrGDOOGCcOkYcowbZgxzBrmDPOGBcOiYcmwbFgxrBrWDOuGDcOmYcuwbdgx7Br2DPuGA8Oh4chwbDgxnBrODOeGC8Ol4cpwbbgx3BruDPeGB8Oj4cnwbHgxvBreDO+GD8On4cvwbfgx/Br+/tGPUcAoaBQyChtFjKJGMaO4UcIoaZQyShtljLJGOaO8UcGoaFQyKhtVjKpGNaO6UcOoadQyaht1jLpGPaO+0cBoaDQyGhtNjKZGM6O50cJoabQyWhttjLZGO6O90cHoaHQyOhtdjK5GN6O70cPoafQyeht9jL5Gv39wZRwwDhqHjMPGEeOoccw4bpwwThqnjNPGGeOscc44b1wwLhqXjMvGFeOqcc24btwwbhq3jNvGHeOucc+4bzwwHhqPjMfGE+Op8cx4brwwXhqvjNfGG+Ot8c54b3wwPhqfjM/GF+Or8c34bvwwfhq/jN/GH+Ov8e8fu5kETIImIZOwScQkahIziZskTJImKZO0ScYka5IzyZsUTIomJZOyScWkalIzqZs0TJomLZO2Sceka9Iz6ZsMTIYmI5OxycRkajIzmZssTJYmK5O1ycZka7Iz2ZscTI4mJ5OzycXkanIzuZs8TJ4mL5O3ycfka/L7h4amAdOgacg0bBoxjZrGTOOmCdOkaco0bZoxzZrmTPOmBdOiacm0bFoxrZrWTOumDdOmacu0bdox7Zr2TPumA9Oh6ch0bDoxnZrOTOemC9Ol6cp0bbox3ZruTPemB9Oj6cn0bHoxvZreTO+mD9On6cv0bfox/Zr+/pGnWcAsaBYyC5tFzKJmMbO4WcIsaZYyS5tlzLJmObO8WcGsaFYyK5tVzKpmNbO6WcOsadYya5t1zLpmPbO+2cBsaDYyG5tNzKZmM7O52cJsabYyW5ttzLZmO7O92cHsaHYyO5tdzK5mN7O72cPsafYye5t9zL5mv39gax4wD5qHzMPmEfOoecw8bp4wT5qnzNPmGfOsec48b14wL5qXzMvmFfOqec28bt4wb5q3zNvmHfOuec+8bz4wH5qPzMfmE/Op+cx8br4wX5qvzNfmG/Ot+c58b34wP5qfzM/mF/Or+c38bv4wf5q/zN/mH/Ov+e8fN1sELIIWIYuwRcQiahGziFskLJIWKYu0RcYia5GzyFsULIoWJYuyRcWialGzqFs0LJoWLYu2Rceia9Gz6FsMLIYWI4uxxcRiajGzmFssLJYWK4u1xcZia7Gz2FscLI4WJ4uzxcXianGzuFs8LJ4WL4u3xcfia/H7h+WWAcugZcgybBmxjFrGLOOWCcukZcoybZmxzFrmLPOWBcuiZcmybFmxrFrWLOuWDcumZcuybdmx7Fr2LPuWA8uh5chybDmxnFrOLOeWC8ul5cpybbmx3FruLPeWB8uj5cnybHmxvFreLO+WD8un5cvybfmx/Fr+/lG/VcAqaBWyCltFrKJWMau4VcIqaZWySltlrLJWOau8VcGqaFWyKltVrKpWNau6VcOqadWyalt1rLpWPau+1cBqaDWyGltNrKZWM6u51cJqabWyWlttrLZWO6u91cHqaHWyOltdrK5WN6u71cPqafWyelt9rL5Wv39RwTpgHbQOWYetI9ZR65h13DphnbROWaetM9ZZ65x13rpgXbQuWZetK9ZV65p13bph3bRuWbetO9Zd655133pgPbQeWY+tJ9ZT65n13HphvbReWa+tN9Zb65313vpgfbQ+WZ+tL9ZX65v13fph/bR+Wb+tP9Zf69+/ZmETsAnahGzCNhGbqE3MJm6TsEnapGzSNhmbrE3OJm9TsCnalGzKNhWbqk3Npm7TsGnatGzaNh2brk3Ppm8zsBnajGzGNhObqc3MZm6zsFnarGzWNhubrc3OZm9zsDnanGzONhebq83N5m7zsHnavGzeNh+br83vXxKxDdgGbUO2YduIbdQ2Zhu3TdgmbVO2aduMbdY2Z5u3LdgWbUu2ZduKbdW2Zlu3bdg2bVu2bduObde2Z9u3HdgObUe2Y9uJ7dR2Zju3XdgubVe2a9uN7dZ2Z7u3PdgebU+2Z9uL7dX2Znu3fdg+bV+2b9uP7df296+42AXsgnYhu7BdxC5qF7OL2yXsknYpu7Rdxi5rl7PL2xXsinYlu7Jdxa5qV7Or2zXsmnYtu7Zdx65r17Pr2w3shnYju7HdxG5qN7Ob2y3slnYru7Xdxm5rt7Pb2x3sjnYnu7Pdxe5qd7O72z3snnYvu7fdx+5r9/sXdOwD9kH7kH3YPmIftY/Zx+0T9kn7lH3aPmOftc/Z5+0L9kX7kn3ZvmJfta/Z1+0b9k37ln3bvmPfte/Z9+0H9kP7kf3YfmI/tZ/Zz+0X9kv7lf3afmO/td/Z7+0P9kf7k/3Z/mJ/tb/Z3+0f9k/7l/3b/mP/tf/960UOAYegQ8gh7BBxiDrEHOIOCYekQ8oh7ZBxyDrkHPIOBYeiQ8mh7FBxqDrUHOoODYemQ8uh7dBx6Dr0HPoOA4ehw8hh7DBxmDrMHOYOC4elw8ph7bBx2DrsHPYOB4ejw8nh7HBxuDrcHO4OD4enw8vh7fBx+Dr8/uUox4Bj0DHkGHaMOEYdY45xx4Rj0jHlmHbMOGYdc455x4Jj0bHkWHasOFYda451x4Zj07Hl2HbsOHYde459x4Hj0HHkOHacOE4dZ45zx4Xj0nHluHbcOG4dd457x4Pj0fHkeHa8OF4db453x4fj0/Hl+Hb8OH4df/9ql1PAKegUcgo7RZyiTjGnuFPCKemUcko7ZZyyTjmnvFPBqehUcio7VZyqTjWnulPDqenUcmo7dZy6Tj2nvtPAaeg0cho7TZymTjOnudPCaem0clo7bZy2TjunvdPB6eh0cjo7XZyuTjenu9PD6en0cno7fZy+Tr9/Mc054Bx0DjmHnSPOUeeYc9w54Zx0TjmnnTPOWeecc9654Fx0LjmXnSvOVeeac9254dx0bjm3nTvOXeeec9954Dx0HjmPnSfOU+eZ89x54bx0XjmvnTfOW+ed89754Hx0PjmfnS/OV+eb89354fx0fjm/nT/OX+ffv1bnEnAJuoRcwi4Rl6hLzCXuknBJuqRc0i4Zl6xLziXvUnApupRcyi4Vl6pLzaXu0nBpurRc2i4dl65Lz6XvMnAZuoxcxi4Tl6nLzGXusnBZuqxc1i4bl63LzmXvcnA5upxczi4Xl6vLzeXu8nB5urxc3i4fl6/L718KdA24Bl1DrmHXiGvUNeYad024Jl1TrmnXjGvWNeeady24Fl1LrmXXimvVteZad224Nl1brm3XjmvXtefadx24Dl1HrmPXievUdeY6d124Ll1XrmvXjevWdee6dz24Hl1PrmfXi+vV9eZ6d324Pl1frm/Xj+vX9fevNLoF3IJuIbewW8Qt6hZzi7sl3JJuKbe0W8Yt65Zzy7sV3IpuJbeyW8Wt6lZzq7s13JpuLbe2W8et69Zz67sN3IZuI7ex28Rt6jZzm7st3JZuK7e128Zt67Zz27sd3I5uJ7ez28Xt6nZzu7s93J5uL7e328ft6/b7FzLdA+5B95B72D3iHnWPucfdE+5J95R72j3jnnXPuefdC+5F95J72b3iXnWvudfdG+5N95Z7273j3nXvuffdB+5D95H72H3iPnWfuc/dF+5L95X72n3jvnXfue/dD+5H95P72f3ifnW/ud/dH+5P95f72/3j/nX//eukHgGPoEfII+wR8Yh6xDziHgmPpEfKI+2R8ch65DzyHgWPokfJo+xR8ah61DzqHg2PpkfLo+3R8eh69Dz6HgOPocfIY+wx8Zh6zDzmHguPpcfKY+2x8dh67Dz2HgePo8fJ4+xx8bh63DzuHg+Pp8fL4+3x8fh6/P5lWM+AZ9Az5Bn2jHhGPWOecc+EZ9Iz5Zn2zHhmPXOeec+CZ9Gz5Fn2rHhWPWuedc+GZ9Oz5dn27Hh2PXuefc+B59Bz5Dn2nHhOPWeec8+F59Jz5bn23HhuPXeee8+D59Hz5Hn2vHhePW+ed8+H59Pz5fn2/Hh+PX//Kq9XwCvoFfIKe0W8ol4xr7hXwivplfJKe2W8sl45r7xXwavoVfIqe1W8ql41r7pXw6vp1fJqe3W8ul49r77XwGvoNfIae028pl4zr7nXwmvptfJae228tl47r73XwevodfI6e128rl43r7vXw+vp9fJ6e328vl6/fxHZO+Ad9A55h70j3lHvmHfcO+Gd9E55p70z3lnvnHfeu+Bd9C55l70r3lXvmnfdu+Hd9G55t7073l3vnnffe+A99B55j70n3lPvmffce+G99F55r7033lvvnffe++B99D55n70v3lfvm/fd++H99H55v70/3l/v379G7RPwCfqEfMI+EZ+oT8wn7pPwSfqkfNI+GZ+sT84n71PwKfqUfMo+FZ+qT82n7tPwafq0fNo+HZ+uT8+n7zPwGfqMfMY+E5+pz8xn7rPwWfqsfNY+G5+tz85n73PwOfqcfM4+F5+rz83n7vPwefq8fN4+H5+vz+9fAvcN+AZ9Q75h34hv1DfmG/dN+CZ9U75p34xv1jfnm/ct+BZ9S75l34pv1bfmW/dt+DZ9W75t345v17fn2/cd+A59R75j34nv1HfmO/dd+C59V75r343v1nfnu/c9+B59T75n34vv1ffme/d9+D59X75v34/v1/f3r7D7BfyCfiG/sF/EL+oX84v7JfySfim/tF/GL+uX88v7FfyKfiW/sl/Fr+pX86v7Nfyafi2/tl/Hr+vX8+v7DfyGfiO/sd/Eb+o385v7LfyWfiu/td/Gb+u389v7HfyOfie/s9/F7+p387v7Pfyefi+/t9/H7+v38/sDTGmhYlD1CmgAAAAASUVORK5CYII=';

/** 低层：外部 API 单次 POST，返回 Promise<{ok, status, body, latencyMs}>（不抛错） */
function extRequest(cfg, bodyObj, timeoutMs) {
  const base = (cfg && cfg.base) || process.env.VISION_API_BASE;
  const key = (cfg && cfg.key) || process.env.VISION_API_KEY;
  const https = require('https');
  const body = JSON.stringify(bodyObj);
  const url = new URL(base.replace(/\/$/, '') + '/chat/completions');
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: data, latencyMs: Date.now() - t0 }));
    });
    req.on('timeout', () => { req.destroy(new Error('连接超时（' + (timeoutMs / 1000) + '秒无响应）')); });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: '网络错误：' + ((e && e.message) || e), latencyMs: Date.now() - t0 }));
    req.write(body);
    req.end();
  });
}

/** 从响应体提取模型回复文本（提取不到返回空串） */
function replyOf(body) {
  try {
    const j = JSON.parse(body);
    const m = j.choices && j.choices[0] && j.choices[0].message;
    if (!m) return '';
    // content 为字符串直接用；为数组（部分兼容端返回 block 数组）时拼接 text 块
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '').join('');
    }
    // 推理型模型（DeepSeek v4 等）思考文本在 reasoning_content；content 被截断为空时以它兜底，
    // 至少证明模型对图片产生了响应（连通性验证目的已达成）
    return (content || '').trim() || (m.reasoning_content || '').trim();
  } catch (e) { return ''; }
}

/** 把一次非 200 结果转成可读提示（确定性问题给明确指引） */
function describeFail(r) {
  const head = String(r.body || '').slice(0, 150);
  if (r.status === 401) return 'API Key 无效或未授权（401），请检查 Key 是否正确。';
  if (r.status === 404) return '接口地址或模型名不存在（404），请检查 Base 地址是否以 /v1 结尾、模型名是否正确。';
  if (r.status === 429) return '触发限流（429）：Key 有效但请求过于频繁或额度不足，稍后重试。';
  return `HTTP ${r.status || '无响应'}：${head}`;
}

/**
 * 外部 API 连通性测试（单次「带图探测」）：
 *  直接用一张真实小图发起一次请求，验证 ① 网络通 ② 模型接受图片 ③ 能返回文本。
 *  为什么不发纯文本 ping：Qwen-VL / GLM-VL 等 VL 模型会拒绝纯文本请求直接抛 5xx
 *  「Unknown error」，纯文本探测必然误报「连接失败」，所以探测请求天然带图。
 *  超时 45s：32B 级视觉模型首次推理较慢，短超时必误报。
 * 返回 {ok, msg, latencyMs}
 */
function testExternalVision(cfg) {
  const model = (cfg && cfg.model) || process.env.VISION_API_MODEL;
  const base = (cfg && cfg.base) || process.env.VISION_API_BASE;
  const key = (cfg && cfg.key) || process.env.VISION_API_KEY;
  if (!base || !key || !model) {
    return Promise.resolve({ ok: false, msg: '配置不完整：需要接口地址 Base、API Key、模型名三项。' });
  }
  // 视觉模型只接受图片输入，纯文本探测对 VL 模型无效（会误报“连接失败”）；
  // 直接发一张探测图，验证 ① 网络通 ② 模型接受图片 ③ 返回文本。
  // 超时 45s：Qwen3-VL 等 32B 大模型首次推理较慢，短超时必误报。
  // max_tokens 512：DeepSeek v4 等推理型模型默认带思考，max_tokens 太小会被思考耗尽导致 content 为空而误报。
  const probeBody = {
    model: model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PROBE_PNG_B64 } },
        { type: 'text', text: '这张图是什么颜色？只回复颜色词。' }
      ]
    }],
    max_tokens: 512
  };
  // DeepSeek 推理模型：探测阶段显式关思考（官方 thinking 参数），省 token 且响应更快
  if (/deepseek/i.test(model)) probeBody.thinking = { type: 'disabled' };
  return extRequest(cfg, probeBody, 45000).then(r => {
    if (r.ok && replyOf(r.body)) {
      return { ok: true, msg: `视觉链路连通成功（${r.latencyMs}ms），该模型可正常接收图片并返回结果。`, latencyMs: r.latencyMs };
    }
    // 网络层超时 / 错误（云函数到服务商之间不通）
    if (r.status === 0) {
      let host = '';
      try { host = new URL(base).hostname; } catch (e) {}
      return { ok: false, msg: `网络层超时/错误（${r.latencyMs}ms）：${String(r.body || '').slice(0, 100)}。` +
        (host ? `请确认云函数环境能访问 ${host}（个人版套餐出站可能受限）。` : '') };
    }
    // 确定性配置错误：直接给指引
    if (r.status === 401) return { ok: false, msg: describeFail(r) };
    if (r.status === 404) return { ok: false, msg: describeFail(r) + '（请确认 Base 地址与模型名拼写正确，如 https://api.siliconflow.cn/v1 / https://api.deepseek.com）' };
    if (r.status === 429) return { ok: false, msg: describeFail(r) };
    if (r.status === 400) return { ok: false, msg: describeFail(r) + '（该模型可能不支持图片输入，请换视觉模型如 Qwen/Qwen3-VL-32B-Instruct）' };
    // 5xx / 其他：给出可读原因
    const bodyHead = String(r.body || '').slice(0, 120);
    if (/50507|Unknown error|Request failed/i.test(bodyHead)) {
      return { ok: false, msg: `模型推理失败（SiliconFlow 50507）：上游模型暂时不可用或过载，稍后重试；若持续出现，请换更小模型（如 Qwen/Qwen3-VL-8B-Instruct）。` };
    }
    return { ok: false, msg: `连通失败。HTTP ${r.status}（${r.latencyMs}ms）：${bodyHead}` };
  });
}

/** 视觉调用：返回 { text, source }，source='external'|'tokenhub'（核对遍只信 external） */
async function callVision(app, extCfg, systemText, b64, userText) {
  // ① 外部 OpenAI 兼容视觉接口优先（多模态真视觉，结果最可靠）
  const hasExt = !!(extCfg && extCfg.base && extCfg.key && extCfg.model);
  if (hasExt) {
    trace('external_model', extCfg.model + ' @ ' + extCfg.base);
    try {
      const t0 = Date.now();
      const first = await callExtWithRetry(extCfg, buildVisionMessages(systemText, b64, userText), 4096, 1);
      trace('external', (Date.now() - t0) + 'ms len=' + first.length + ' head=' + first.slice(0, 150));
      if (parsable(first)) return { text: first, source: 'external' };
      // 弱模型跑偏（输出解释/HTML 等）：会话内纠正后重试一次
      trace('external_retry', 'head=' + first.slice(0, 100));
      const t1 = Date.now();
      const msgs = buildVisionMessages(systemText, b64, userText).concat([
        { role: 'assistant', content: first.slice(0, 2000) },
        { role: 'user', content: CORRECTION_TEXT }
      ]);
      const second = await extChat(extCfg, msgs);
      trace('external_retry2', (Date.now() - t1) + 'ms len=' + second.length + ' head=' + second.slice(0, 150));
      if (parsable(second)) return { text: second, source: 'external' };
      trace('external_retry_fail', second.slice(0, 100));
      throw new Error('外部模型两次返回均无法解析（输出不符合 JSON/表格格式）');
    } catch (e) {
      trace('external_err', (e && e.message) || e);
      console.warn('[ocrSchedule] external vision failed:', (e && e.message) || e);
      // 外部已配置 = 家长明确指定用外部视觉模型；内置 hy3 看不见图只会产出幻觉假结果，
      // 直接把错误抛给上层（页面会提示重试），绝不让内置链污染结果。
      throw e;
    }
  }
  // ② TokenHub 多模态模型链（需环境套餐支持启用 glm-5v-turbo / qwen3.5-flash）
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  let lastErr = null;
  for (const name of VISION_MODELS) {
    try {
      const t0 = Date.now();
      // enable_thinking:false —— hy4-preview 等深度思考模型关闭思考可大幅降低延迟
      // （SDK processInput 会透传额外字段；不支持的模型会忽略或报错后走下一个）
      const result = await model.generateText({
        model: name,
        enable_thinking: false,
        messages: [
          { role: 'system', content: systemText },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
              { type: 'text', text: userText || USER_TEXT }
            ]
          }
        ]
      });
      const text = (result && result.text) || '';
      trace(name, (Date.now() - t0) + 'ms len=' + text.length + ' head=' + text.slice(0, 120));
      if (text) return { text, source: 'tokenhub' };
      lastErr = new Error('模型 ' + name + ' 返回空内容');
    } catch (e) {
      trace(name + '_err', (e && e.message) || e);
      lastErr = e;
      console.warn('[ocrSchedule] model ' + name + ' failed:', (e && e.message) || e);
    }
  }
  throw lastErr || new Error('所有视觉模型调用失败');
}

/** 错误分类兜底 */
function errFrom(e) {
  const msg = (e && e.message) || String(e);
  if (/image|vision|multimodal|多模态|图片|content_type|unsupported|invalid.*content/i.test(msg)) {
    return { ok: false, code: 'vision_unsupported', msg: '当前 AI 模型不支持识别图片。已保存照片，请对照照片手动填写课表。' };
  }
  if (/429|too many|rate.?limit|频率|限流/i.test(msg)) {
    return { ok: false, code: 'rate_limit', msg: '请求太频繁了，请稍等几秒再试一次。' };
  }
  if (/token|tokencredit|resource|pack|quota|余额|额度|开通|403|404|未购买|not found|unauthorized|forbidden/i.test(msg)) {
    return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试。' };
  }
  return { ok: false, code: 'ai_error', msg: '识别失败：' + msg };
}

/** tcb.init 统一入口：90s 覆盖 SDK 默认 15s（hy4-preview 深度思考 + 大图 base64 需要更久） */
function initApp() {
  try {
    return { app: tcb.init({ env: ENV_ID, timeout: 90000 }) };
  } catch (e) {
    return { err: { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) } };
  }
}

/* ---------- 视觉配置解析：客户端 override 优先，否则读服务端 vision_config ---------- */
const VISION_COLL = 'vision_config';
const VISION_GLOBAL = '__global__';

// 按 openid（再 __global__）从云数据库读取已启用的视觉配置三要素
async function loadServerVision(app, openid) {
  if (!app) return null;
  const ids = [openid, VISION_GLOBAL].filter(Boolean);
  for (const id of ids) {
    try {
      const res = await app.database().collection(VISION_COLL).doc(id).get();
      if (res && res.data && res.data.length) {
        const d = res.data[0];
        if (d && d.enabled && d.active && d.platforms && d.platforms[d.active]) {
          const p = d.platforms[d.active];
          if (p.base && p.key && p.model) {
            return { base: p.base.trim(), key: p.key.trim(), model: p.model.trim() };
          }
        }
      }
    } catch (e) {}
  }
  return null;
}

// 解析外部视觉配置：event.visionConfig（小程序 override）优先，否则服务端
async function resolveExtCfg(event, openid, app) {
  const evCfg = event.visionConfig || {};
  const client = {
    base: typeof evCfg.base === 'string' ? evCfg.base.trim() : '',
    key: typeof evCfg.key === 'string' ? evCfg.key.trim() : '',
    model: typeof evCfg.model === 'string' ? evCfg.model.trim() : ''
  };
  if (client.base && client.key && client.model) return client;
  return await loadServerVision(app, openid);
}

exports.main = async (event) => {
  const openid = (event.userInfo && event.userInfo.openId) || '';
  const t0 = Date.now();
  const b64len = (event.imageBase64 || '').length;
  const b64 = event.imageBase64 || '';

  /* ---- 连通性测试分支：不发图、不落观测库、不走频控，快速返回 ---- */
  if (event.testVision) {
    return await testExternalVision(event.visionConfig);
  }

  // 频控只对真实识别生效（测试连接不计频，方便反复调试配置）
  if (rateLimited(openid)) {
    return { ok: false, code: 'rate_limit', msg: '识别太频繁啦，稍等几秒再试～' };
  }

  const init = initApp();
  let finalResult = init.err || null;
  if (init.app) {
    try {
      finalResult = event.action === 'mistake'
        ? await doOcrMistake(event, b64, init.app)
        : await doOcr(event, b64, init.app);
    } catch (e) {
      finalResult = errFrom(e);
    }
  }
  // 无论成功失败/客户端是否超时断连，都把观测记录落到 ocr_debug
  try {
    const db = init.app.database();
    const doc = {
      ts: new Date(),
      costMs: Date.now() - t0,
      b64len,
      trace: TRACE,
      result: finalResult ? finalResult.ok : 'threw'
    };
    try {
      await db.collection('ocr_debug').add(doc);
    } catch (e1) {
      await db.createCollection('ocr_debug');
      await db.collection('ocr_debug').add(doc);
    }
  } catch (e2) {
    console.warn('[ocrSchedule] debug write failed', (e2 && e2.message) || e2);
  }
  return finalResult;
};

async function doOcr(event, b64, app) {
  // 视觉配置：优先用小程序传入（可选 override），否则读服务端 vision_config（网页端配置）
  const openid = (event.userInfo && event.userInfo.openId) || '';
  const extCfg = await resolveExtCfg(event, openid, app);
  if (!extCfg) return { ok: false, code: 'no_vision', msg: '未配置视觉识别模型，请到网页端「视觉识别设置」中配置后重试。' };
  if (!b64) return { ok: false, code: 'empty', msg: '没有收到图片数据' };
  // 云函数入参有体积上限，这里提前拦截（base64 比原图约大 1/3）
  if (b64.length > 3 * 1024 * 1024) {
    return { ok: false, code: 'too_large', msg: '图片太大了，请只拍课表部分、裁掉多余内容后重试。' };
  }

  const startedAt = Date.now();

  /* ---- 第一遍：转录 ---- */
  let text1 = '';
  let src1 = '';
  try {
    const r1 = await callVision(app, extCfg, SYSTEM_PROMPT, b64);
    text1 = r1.text;
    src1 = r1.source;
  } catch (e) {
    return errFrom(e);
  }
  if (!text1) return { ok: false, code: 'empty_resp', msg: '模型没有返回内容，请重试或手动填写。' };

  const obj1 = extractJson(text1) || parseHtmlTable(text1);
  if (!obj1) {
    trace('parse_fail', 'extractJson+htmlTable=null text1head=' + text1.slice(0, 200));
    return { ok: false, code: 'parse', msg: '没能读懂这张课表，请对照照片手动填写。' };
  }
  const grid1 = normalizeGrid(obj1.grid);
  if (!grid1) {
    // 反幻觉生效时，空白/无效图会走到这里
    trace('parse_fail', 'grid invalid obj1keys=' + Object.keys(obj1).join(',') + ' text1head=' + text1.slice(0, 200));
    return { ok: false, code: 'parse', msg: '没有识别出课程内容：请确认照片是完整课表、文字清晰后重试。' };
  }

  /* ---- 第二遍：逐格核对 ----
   * 门槛（防「核对遍覆盖好结果」事故）：
   *  ① 仅当第一遍来自外部模型时才核对——内置 hy3 看不见图，其「核对」= 幻觉，绝不接受；
   *  ② 第一遍耗时 > 25s（慢思考模型如 Qwen3-VL）时跳过核对——两遍必超小程序 60s 限制；
   *  ③ 核对失败/超时自动保留第一遍结果。
   */
  const verifyEligible = src1 === 'external' && (Date.now() - startedAt) < 25000;
  if (event.singlePass || !verifyEligible) {
    const grid = grid1;
    return {
      ok: true,
      grid: grid,
      days: Array.isArray(obj1.days) ? obj1.days : [],
      periods: Array.isArray(obj1.periods) ? obj1.periods : [],
      termName: typeof obj1.termName === 'string' ? obj1.termName : '',
      verified: false,
      raw: ''
    };
  }
  let verified = false;
  let finalObj = obj1;
  try {
    const draft = JSON.stringify({
      termName: typeof obj1.termName === 'string' ? obj1.termName : '',
      days: Array.isArray(obj1.days) ? obj1.days : [],
      periods: Array.isArray(obj1.periods) ? obj1.periods : [],
      grid: grid1
    });
    const r2 = await callVision(app, extCfg, buildVerifyPrompt(draft), b64);
    const obj2 = (r2.source === 'external' && r2.text) ? (extractJson(r2.text) || parseHtmlTable(r2.text)) : null;
    const grid2 = obj2 ? normalizeGrid(obj2.grid) : null;
    if (grid2) {
      finalObj = obj2;
      verified = true;
    }
  } catch (e) {
    // 核对遍失败不阻断：降级返回第一遍结果
    console.warn('[ocrSchedule] verify pass failed, fallback to draft', e);
  }

  const grid = normalizeGrid(finalObj.grid) || grid1;
  return {
    ok: true,
    grid: grid,
    days: Array.isArray(finalObj.days) ? finalObj.days : [],
    periods: Array.isArray(finalObj.periods) ? finalObj.periods : [],
    termName: typeof finalObj.termName === 'string' ? finalObj.termName : '',
    verified: verified,
    raw: ''
  };
}

/**
 * 错题拍照转录（action='mistake'）：
 * 视觉模型只转录题干/作答/批改标记（结构见 MISTAKE_SYSTEM_PROMPT），不做错因诊断。
 * 诊断由前端调 tutorChat action='diagnoseQuestions'（文本模型 E1-E9 归因）完成。
 *
 * 出参：{ ok:true, subjectGuess, items:[{no,type,questionText,childAnswer,marked,correctAnswer}], verified }
 */
async function doOcrMistake(event, b64, app) {
  const openid = (event.userInfo && event.userInfo.openId) || '';
  const extCfg = await resolveExtCfg(event, openid, app);
  if (!extCfg) return { ok: false, code: 'no_vision', msg: '未配置视觉识别模型，请到网页端「视觉识别设置」中配置后重试。' };
  if (!b64) return { ok: false, code: 'empty', msg: '没有收到图片数据' };
  if (b64.length > 3 * 1024 * 1024) {
    return { ok: false, code: 'too_large', msg: '图片太大了，请只拍题目部分、裁掉多余内容后重试。' };
  }

  const startedAt = Date.now();

  /* ---- 第一遍：转录 ---- */
  let text1 = '';
  let src1 = '';
  try {
    const r1 = await callVision(app, extCfg, MISTAKE_SYSTEM_PROMPT, b64, MISTAKE_USER_TEXT);
    text1 = r1.text;
    src1 = r1.source;
  } catch (e) {
    return errFrom(e);
  }
  if (!text1) return { ok: false, code: 'empty_resp', msg: '模型没有返回内容，请重试或手动添加错题。' };

  const obj1 = extractJson(text1);
  if (!obj1 || !Array.isArray(obj1.items)) {
    trace('mistake_parse_fail', 'extractJson=null text1head=' + text1.slice(0, 200));
    return { ok: false, code: 'parse', msg: '没能读懂这张题目图片，请重试或手动添加错题。' };
  }
  const items1 = normalizeItems(obj1.items);
  if (!items1) {
    // 反幻觉生效时，空白/无效图会走到这里
    trace('mistake_empty', 'items invalid obj1keys=' + Object.keys(obj1).join(',') + ' text1head=' + text1.slice(0, 200));
    return { ok: false, code: 'parse', msg: '没有识别出题目内容：请确认照片里题目清晰、文字可读后重试。' };
  }

  /* ---- 第二遍：逐题核对 ----
   * 门槛（与课表 v2 一致）：
   *  ① 仅 external 源才核对（内置 hy3 看不见图，核对=幻觉）；
   *  ② 首遍耗时 > 25s 跳过（两遍必超小程序 60s 限制）；
   *  ③ 仅多题图（≥2 题）启用——单题图串题号风险低，省一半延迟；
   *  ④ 核对失败/超时自动保留第一遍结果。
   */
  const verifyEligible = src1 === 'external' && (Date.now() - startedAt) < 20000 && items1.length >= 2;
  if (event.singlePass || !verifyEligible) {
    return {
      ok: true,
      subjectGuess: strField(obj1.subjectGuess, 20),
      items: items1,
      verified: false
    };
  }
  let verified = false;
  let finalObj = obj1;
  let finalItems = items1;
  try {
    const draft = JSON.stringify({ subjectGuess: strField(obj1.subjectGuess, 20), items: items1 });
    const r2 = await callVision(app, extCfg, buildMistakeVerifyPrompt(draft), b64, MISTAKE_USER_TEXT);
    if (r2.source === 'external' && r2.text) {
      const obj2 = extractJson(r2.text);
      const items2 = obj2 && Array.isArray(obj2.items) ? normalizeItems(obj2.items) : null;
      if (items2) {
        finalObj = obj2;
        finalItems = items2;
        verified = true;
      }
    }
  } catch (e) {
    console.warn('[ocrSchedule] mistake verify pass failed, fallback to draft', e);
  }

  return {
    ok: true,
    subjectGuess: strField(finalObj.subjectGuess, 20),
    items: finalItems,
    verified: verified
  };
};

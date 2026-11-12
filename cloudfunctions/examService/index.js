/**
 * 云函数 examService —— 自助导学「测验卷」系统中枢（双端共享：小程序 + 原生 iPad App）
 *
 * 动作一览（event.action）：
 *   gen            学情驱动 AI 出卷（hy3）→ 写 exam_resources(origin='ai')
 *   grade          AI 批改（双路线：文本AI 默认 / 视觉模型 可配置）→ 写 tutor_exam_submissions + 回流错题本
 *   saveExam       保存/更新一份测验卷（ai/manual/upload）
 *   listExams      试卷索引列表（只回元数据，不含正文）
 *   getExam        单份试卷详情（正文 + 参考答案 + questions）
 *   deleteExam     删除试卷（登记墓碑）
 *   saveSubmission 保存一次批改提交
 *   listSubmissions 提交记录列表
 *   pull           同步：拉回 exam_resources + submissions（按 openid）
 *   push           同步：补写本地有而云端缺的试卷/提交
 *   bind           绑定 iPad 账号 ↔ 微信 openid（令牌复用 web_portal_bindings，与网页看板同一口令）
 *   resolve        解析当前身份映射（调试/前端确认绑定态）
 *   saveVisionConfig 保存视觉模型配置（与 webVisionConfig 共用 vision_config[openid]，按 openid 隔离）
 *   getVisionConfig  读取已保存的视觉模型配置（iPad/小程序设置页预填；网页端配的在此可见）
 *
 *   ⚠️ 视觉配置唯一真相源 = vision_config[openid]（与 webVisionConfig 云函数共用同一集合，
 *   ⚠️ 网页端配置后 iPad/小程序读到的就是同一份）。provider 体系收敛到网页端多平台模型：
 *   ⚠️ 平台 = {base, key, model, kind:'openai'|'qwen'|'gemini'}，active 指定当前启用平台。
 *   listProviders   返回内置主流视觉模型下拉清单（不含密钥）
 *   testVision      用已配置密钥测试连接是否成功
 *   parseUpload     上传试卷（Word/PDF 提取的文本）→ AI 结构化为 questions 草稿（不落库）
 *   fileUrls        fileID 批量转临时访问 URL（原卷页面/手写图展示用）
 *   reviewSubmission 批改结果人工复核：逐题确认/改判，同步修正错题库（reviews[] 只追加）
 *
 * 身份方案（已确认：不强制绑定）：
 *   · 小程序：event.userInfo.openId 存在 → 直接用（微信 openid 命名空间）
 *   · iPad：自定义登录 uid；若有绑定映射则合并到微信 openid 命名空间（共享数据），
 *           否则用 uid 自身作为独立命名空间（数据独立、不互通）
 *
 * 大模型：AI 出卷/文本批改走 CloudBase 内置 hy3（与 tutorChat 同套初始化 + no_pack 兜底 + retry）。
 * 视觉批改走外部 provider（Qwen-VL/GLM-VL/Doubao-VL/Gemini/GPT-4o），密钥存服务端、默认关闭、失败降级文本。
 */

/* 测试模式（EXAM_TEST）下不加载云 SDK，便于本地纯逻辑单测 */
const tcb = process.env.EXAM_TEST ? null : require('@cloudbase/node-sdk');

/* 作用域纯函数（副本，canonical 在 cloudfunctions/_shared/scopeGuard.js，
 * 由 scripts/sync-scope-guard.mjs 生成；副本漂移会让 npm test 变红） */
const G = require('./scopeGuard');

/* ---------------- 常量 ---------------- */
const ENV = process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf';
const EXAM_COLL = 'exam_resources';
const SUB_COLL = 'tutor_exam_submissions';
const LINK_COLL = 'exam_account_link';
const VISION_COLL = 'vision_config';
const MISTAKE_COLL = 'tutor_mistakes';
const TEXTBOOK_COLL = 'textbook_library';

const SUBJECT_NAMES = {
  math: '数学', chinese: '语文', english: '英语',
  physics: '物理', chemistry: '化学', biology: '生物',
  history: '历史', geography: '地理', politics: '道德与法治',
  science: '科学'
};
const EXAM_TYPE_LABEL = {
  unit_test: '单元测', phase_test: '阶段测', real_exam: '真题',
  diagnostic_test: '诊断', special_test: '专项', advanced_test: '拔高'
};

/* ---------------- 工具 ---------------- */
function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}
/** 从粘贴内容里规整出裸令牌：允许用户误粘贴整条直达链接（含 tok=），自动提取。 */
function extractBindToken(raw) {
  let t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  const m = t.match(/tok=([^&?#\s]+)/i);
  if (m) t = m[1];
  // 去掉可能被夹带的引号
  t = t.replace(/^["']|["']$/g, '').trim();
  return t;
}
function nowMs() { return Date.now(); }

/**
 * 判断是否「AI 资源包未开通 / 额度耗尽」类错误（决定要不要回 no_pack 引导购买）。
 *
 * ⚠️ 2026-10-27 收窄：旧正则把 `403|404|not found|不存在|forbidden|模型|token|resource`
 *    这类**泛词**也算命中，于是任何数据库错误、权限错误、甚至「集合不存在」，只要
 *    消息里恰好带了这些子串，都会被伪装成「AI 资源包未开通」—— 排查方向和用户提示
 *    双双被带偏。现在只保留资源包/额度专属特征，`token` 只在与额度词同现时才算。
 */
function isNoPackError(e) {
  const msg = String((e && e.message) || e || '');
  return /资源包|token\s*credits|credits|quota|额度|余额|未购买|未开通|no_pack|resource\s+pack|resource\s+exhausted|insufficient|arrears|欠费/i.test(msg);
}

/** JSON 提取（宽松：代码块围栏 / 前后废话 / 尾逗号） */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch (e) {}
  try { return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1')); } catch (e) { return null; }
}

/* ---------------- 合规门禁（与 tutorChat K.findBannedWords 同口径，11 词，绝不落入「已掌握」断言） ---------------- */
const BANNED_WORDS = [
  ['已精通', '掌握扎实'], ['已掌握', '达成较好'], ['学会了', '推通了'],
  ['完全懂了', '理解了'], ['完全掌握', '掌握得不错'], ['稳稳掌握', '掌握得较稳'],
  ['掌握了', '学得很扎实'], ['精通了', '学得扎实'], ['已学会', '已能独立做'],
  ['学懂了', '理解了'], ['全懂了', '都理解了']
];
function sanitizeBanned(text) {
  let s = String(text == null ? '' : text);
  for (const [bad, good] of BANNED_WORDS) s = s.split(bad).join(good);
  return s;
}

/* ---------------- 视觉模型 provider 注册表（主流模型，下拉可选） ---------------- */
/* 每个 provider 提供：build(images, prompt, model, key) → {url, headers, body}
 *                      pick(json) → 模型回复文本（从各厂商响应结构抽取）
 * OpenAI 兼容系列（智谱/豆包/GPT-4o）响应结构一致，用工厂生成。 */
function openAiCompat(name, endpoint, model) {
  return {
    name: name, endpoint: endpoint, model: model, kind: 'openai', needsBase64: false,
    build(images, prompt, m, key) {
      return {
        url: this.endpoint,
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: {
          model: m || this.model,
          messages: [{ role: 'user', content: images.map(u => ({ type: 'image_url', image_url: { url: u } })).concat([{ type: 'text', text: prompt }]) }]
        }
      };
    },
    pick: (j) => (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
  };
}
const PROVIDERS = {
  'qwen-vl': {
    name: '通义千问 VL（阿里云 DashScope）',
    kind: 'qwen',
    endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    model: 'qwen-vl-max-latest',
    needsBase64: false,
    build(images, prompt, m, key) {
      return {
        url: this.endpoint,
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: {
          model: m || this.model,
          input: { messages: [{ role: 'user', content: images.map(u => ({ image: u })).concat([{ text: prompt }]) }] }
        }
      };
    },
    pick: (j) => (j && j.output && j.output.choices && j.output.choices[0] && j.output.choices[0].message && j.output.choices[0].message.content && j.output.choices[0].message.content[0] && j.output.choices[0].message.content[0].text) || ''
  },
  'glm-4v': openAiCompat('智谱 GLM-4V（OpenAI 兼容）', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm-4v-plus'),
  'doubao-vl': openAiCompat('豆包视觉（火山方舟 OpenAI 兼容）', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'doubao-vision-pro-32k'),
  'gpt-4o': openAiCompat('OpenAI GPT-4o（OpenAI 兼容）', 'https://api.openai.com/v1/chat/completions', 'gpt-4o'),
  'gemini': {
    name: 'Google Gemini（需将图片转 base64）',
    kind: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    model: 'gemini-1.5-flash',
    needsBase64: true,
    build(images, prompt, m, key) {
      const url = this.endpoint + '?key=' + key;
      const parts = images.map(b64 => ({ inline_data: { mime_type: 'image/jpeg', data: b64 } })).concat([{ text: prompt }]);
      return { url: url, headers: { 'Content-Type': 'application/json' }, body: { contents: [{ parts: parts }] } };
    },
    pick: (j) => (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || ''
  }
};
function listProviderMeta() {
  return Object.keys(PROVIDERS).map(k => {
    const p = PROVIDERS[k];
    let host = '';
    try { host = new URL(p.endpoint).host; } catch (e) {}
    return { id: k, name: p.name, model: p.model || '', host: host, needsBase64: !!p.needsBase64 };
  });
}

/* ---------------- 视觉模型统一构造器（与 webVisionConfig 共用 vision_config[openid]） ----------------
 * 网页端平台（siliconflow/deepseek/custom）均为 OpenAI 兼容接口；iPad 内置 provider 也按 kind 归一：
 *   kind='openai'   → 通用 OpenAI 兼容（base+key+model）  覆盖 glm-4v/doubao-vl/gpt-4o 及网页三平台
 *   kind='qwen'     → 通义千问 VL 专用请求（PROVIDERS['qwen-vl'].build）
 *   kind='gemini'   → Google Gemini 专用请求（PROVIDERS['gemini'].build）
 */
/* ---------------- Node16 兼容出网（云函数运行时无全局 fetch，Node18+ 才内置） ----------------
 * 返回 { ok, status, text(), json(), buffer() }，形似 fetch Response，调用点改动最小。 */
function httpJson(url, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const body = o.body || null;
    const headers = Object.assign({}, o.headers || {}, body ? { 'Content-Length': Buffer.byteLength(body) } : {});
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: o.method || 'GET',
      headers: headers,
      timeout: o.timeout || 55000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => buf.toString('utf8'),
          json: () => { try { return JSON.parse(buf.toString('utf8')); } catch (e) { return {}; } },
          buffer: () => buf
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildOpenAiVision(base, key, model, images, prompt) {
  const imgs = Array.isArray(images) ? images : [];
  const content = imgs.map(u => ({ type: 'image_url', image_url: { url: u } }));
  content.push({ type: 'text', text: prompt });
  // base 归一化（对齐 ocrSchedule 的参考实现）：网页端存的 base 可能不带路径
  // （deepseek='https://api.deepseek.com'、siliconflow='.../v1'），真实端点 = base + '/chat/completions'。
  // 已带该后缀（内置 PROVIDERS 的完整端点）则原样保留，避免拼成 .../chat/completions/chat/completions。
  let url = String(base || 'https://api.openai.com/v1/chat/completions').trim().replace(/\/+$/, '');
  if (!/\/chat\/completions$/i.test(url)) url += '/chat/completions';
  return {
    url: url,
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: { model: model, messages: [{ role: 'user', content: content }] }
  };
}

function visionBuilder(v) {
  if (v.kind === 'qwen') {
    const p = PROVIDERS['qwen-vl'];
    return (images, prompt) => p.build(images, prompt, v.model || p.model, v.key);
  }
  if (v.kind === 'gemini') {
    const p = PROVIDERS['gemini'];
    return (images, prompt) => p.build(images, prompt, v.model || p.model, v.key);
  }
  return (images, prompt) => buildOpenAiVision(v.base || 'https://api.openai.com/v1/chat/completions', v.key, v.model, images, prompt);
}

/** 从 vision_config[openid] 文档解析出当前激活平台（统一多平台 schema） */
function resolveActiveVision(doc) {
  if (!doc || doc.enabled === false) return null;
  const platforms = doc.platforms || {};
  const active = doc.active && platforms[doc.active] ? doc.active : Object.keys(platforms)[0];
  const p = platforms[active];
  if (!p || !p.key || !p.model) return null;
  return { provider: active, base: p.base || '', key: p.key, model: p.model, kind: p.kind || 'openai' };
}

/** 兼容读取 vision_config[openid]：doc(id) 与 where(openid) 两种形态都支持 */
async function readVisionConfigDoc(app, openid) {
  if (!openid) return null;
  try {
    const r1 = await app.database().collection(VISION_COLL).doc(openid).get();
    const d1 = (r1 && r1.data) ? (Array.isArray(r1.data) ? r1.data[0] : r1.data) : null;
    if (d1) return d1;
  } catch (e) {}
  try {
    const r2 = await app.database().collection(VISION_COLL).where({ openid: openid }).limit(1).get();
    const d2 = (r2 && r2.data && r2.data[0]) || null;
    if (d2) return d2;
  } catch (e) {}
  return null;
}

/* ---------------- hy3 调用：429/限流自动退避重试 ---------------- */
function isRateErr(e) {
  return /429|too many|rate.?limit|频率|限流|throttl/i.test((e && e.message) || String(e));
}
function isTimeoutErr(e) {
  return /timeout|timed out|超时|ETIMEDOUT|aborted/i.test((e && e.message) || String(e));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// CloudBase node-sdk 的 AI 请求默认 15s 超时（request-core 的 socket setTimeout）。
// 大卷（十几~二十题）的模型响应常超过 15s，必须显式抬高；函数本身 timeout 60s。
// 只给 AI 单独开一个 app 实例，DB/存储等其它请求仍保持 15s 快速失败。
const AI_TIMEOUT_MS = (function () {
  const n = parseInt(process.env.EXAM_AI_TIMEOUT_MS, 10);
  return Math.min(Math.max(n || 40000, 5000), 50000);
})();
let aiAppCache = null;
function aiModel(app) {
  if (process.env.EXAM_TEST || !tcb) return app.ai().createModel('cloudbase');
  if (!aiAppCache) {
    try { aiAppCache = tcb.init({ env: ENV, timeout: AI_TIMEOUT_MS }); }
    catch (e) { aiAppCache = app; }
  }
  return aiAppCache.ai().createModel('cloudbase');
}

const RETRY_DELAYS = [1200, 2600];
async function generateWithRetry(model, params) {
  const start = Date.now();
  let lastErr;
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    try { return await model.generateText(params); }
    catch (e) {
      lastErr = e;
      // 限流重试只在「快速失败」时有意义：已耗掉半个预算就别再叠一次长请求
      if (i < RETRY_DELAYS.length && isRateErr(e) && Date.now() - start < AI_TIMEOUT_MS / 2) {
        await sleep(RETRY_DELAYS[i]); continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/* ---------------- 身份解析（不强制绑定；账号优先，无账号独立） ---------------- */
async function resolveOpenid(app, event) {
  const wxOpenid = event && event.userInfo && event.userInfo.openId;
  if (wxOpenid) return { openid: wxOpenid, bound: false, kind: 'wx' };
  // 服务端代调用（webAdminWrite 教材代理）：共享密钥 EXAM_ADMIN_KEY + 显式 openid。
  // 该密钥只应存在于服务端函数环境变量，网页端不持有；两函数 env 必须同值。
  const EXAM_ADMIN_KEY = (process.env.EXAM_ADMIN_KEY || '').trim();
  if (EXAM_ADMIN_KEY && event && event.adminKey && String(event.adminKey) === EXAM_ADMIN_KEY) {
    const oid = String((event && event.openid) || '').trim();
    if (oid) return { openid: oid, bound: false, kind: 'admin' };
  }
  const uid = (event && (event.uid || (event.userInfo && event.userInfo.uid))) || '';
  if (!uid) return { openid: '', bound: false, kind: 'none' };
  // 查绑定映射：若 iPad uid 已绑定微信 openid → 合并到微信命名空间（共享数据）
  try {
    const res = await app.database().collection(LINK_COLL).where({ uid: uid }).limit(1).get();
    const doc = res && res.data && res.data[0];
    if (doc && doc.openid) return { openid: doc.openid, bound: true, kind: 'ipad_bound' };
  } catch (e) {}
  // 无绑定 → uid 自身作为独立命名空间
  return { openid: 'ipad_' + uid, bound: false, kind: 'ipad_independent' };
}

/**
 * 提交归属的孩子（服务端解析，**不信任客户端**）。
 * 走 scopeGuard.resolveChildId(root, requested)：
 *   · requested 属于本家庭 → 用 requested（切孩子后云端 currentUserId 可能还没同步，端上显式带更准）；
 *   · 未传 → 取云端 currentUserId；
 *   · requested 跨家庭/非法 → ''（写入侧不归属：宁可不写，也不把卷记到别人孩子头上）；
 *   · iPad 独立账号（openid='ipad_xxx'）或尚无档案 → ''（无主，不猜）；
 *   · 查询失败 → ''（归属解析失败不该阻断批改，但绝不能写错孩子）。
 * ⚠️ 刻意不回落 users[0]：多孩家庭里第一个孩子不是当前孩子（readFarmUser 的回落只用于读切片）。
 */
async function resolveChildScope(app, openid, requested) {
  const none = { childId: '', source: 'none' };
  if (!openid) return none;
  try {
    const res = await app.database().collection('hw_farm_user').where({ _openid: openid }).limit(1).get();
    const doc = (res && res.data && res.data[0]) || null;
    if (!doc || !doc.data) return none;
    return G.resolveChildId(doc.data, requested || '');
  } catch (e) { return none; }
}

/* ---------------- 云存储：fileId → 临时访问 URL ----------------
 * ⚠️ @cloudbase/node-sdk 的 getTempFileURL 直接挂在 app 上（无 app.storage() 访问器）；
 * 旧代码 app.storage().getTempFileURL 必抛错 → 视觉批改一直拿不到图片 URL（已修复）。
 */
async function getFileUrlsDetail(app, fileIds) {
  const out = { urls: [], error: '' };
  if (!Array.isArray(fileIds) || !fileIds.length) { out.error = 'no_ids'; return out; }
  const arg = { fileList: fileIds.slice(0, 50) };
  try {
    let fn = null;
    if (typeof app.getTempFileURL === 'function') fn = app.getTempFileURL.bind(app);
    else if (typeof app.storage === 'function' && app.storage() && typeof app.storage().getTempFileURL === 'function') fn = app.storage().getTempFileURL.bind(app.storage());
    if (!fn) { out.error = 'no_api'; return out; }
    const res = await fn(arg);
    const list = (res && res.fileList) || [];
    out.urls = list.map(f => (f && f.tempFileURL) || '').filter(Boolean);
    if (!out.urls.length) out.error = 'empty:' + JSON.stringify(list).slice(0, 300);
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 300); }
  return out;
}
async function getFileUrls(app, fileIds) {
  const d = await getFileUrlsDetail(app, fileIds);
  return d.urls;
}

/* ---------------- AI 出卷（action='gen'） ---------------- */
const GEN_SYSTEM =
  '你是「自适应测验卷出题」老师。依据孩子的学情（画像、当前学习进度、近期错题）自动组卷，' +
  '原则是「哪里弱考哪里、不超纲、不编造题与答案」。\n\n' +
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，第一个字符必须是 {。\n\n' +
  '输出格式：\n' +
  '{"name":"卷名（含学科+范围，如「数学·一年级上·20以内加减法 单元测」）",' +
  '"examType":"unit_test 或 phase_test 或 diagnostic_test 或 special_test 或 advanced_test",' +
  '"suggestedDuration":分钟数(整数),' +
  '"knowledgePoints":["知识点1","知识点2"],' +
  '"questions":[' +
  '{"id":"q1","type":"choice|fill|calc|essay|draw","stem":"题干","options":["A","B","C","D"](choice 时必填4项),"answer":"参考答案/正确选项字母","points":分值(整数),"kp":"关联知识点","difficulty":1到3,"figure":可选题图对象(仅需要看图的题，格式见规则6)},' +
  '...],' +
  '"answersMarkdown":"完整参考答案与解析（markdown，逐题给出答案和简短解析）"}\n\n' +
  '规则：\n' +
  '1. choice 必须正好 4 个选项、answer 为 A/B/C/D；其余题型 answer 为文字或算式。\n' +
  '2. 优先围绕「近期错题知识点」与「计划未完成/滞后任务」出题（占约 60%），其余从已覆盖知识点巩固。\n' +
  '3. 难度贴合年级；题干简短、选项不歧义；不出现超纲内容，不编造教材原文。\n' +
  '4. 题量与 scope.count 一致（5~20 道）；题型按 scope 指定。\n' +
  '5. 不确定时就出更基础的题，宁少勿错。\n' +
  '6. 题图 figure（图形题必填）：题干出现「如图/下图/上图/图中/看图」或学生需要看图作答时，' +
  '必须同时给出 figure，用基本图元把题图画出来；格式 {"w":画布宽,"h":画布高,"items":[图元...]}。' +
  '坐标系原点在左上角、y 轴向下，w 取 40~320、h 取 30~240 的整数，所有坐标必须落在 0~w / 0~h 之间。' +
  '图元只有四种：线段 {"k":"line","x1":0,"y1":0,"x2":80,"y2":0}（可加 "dash":true 画虚线）；' +
  '折线/多边形 {"k":"poly","pts":[[0,0],[80,0],[80,50]],"closed":true}（closed 为 true 时首尾相连，可加 "fill":true 填充阴影）；' +
  '圆 {"k":"circle","cx":60,"cy":40,"r":20}（可加 "fill":true）；' +
  '文字 {"k":"text","x":60,"y":20,"t":"A"}（顶点字母、边长、数据标注，text 不超过 8 个字）。' +
  '最多 30 个图元，直角用 poly 画小方块表示。图形只是示意，题干文字必须写全所有已知条件与数据（不能把关键条件只标在图上）；' +
  '实物照片、卡通插画这类画不出来的图，不要出对应题目。';

/* ---------------- 年级×学科 重点知识点 + 专题风格（出卷范围锚定，2026-10-24） ----------------
 * 目的：出卷不只靠模型常识——按「学科×年级」锚定本年级重点（不超纲），按「专题」约束题型风格。
 * iPad/小程序出卷传 scope.topic（专题名，与下表 key 一致）与 grade（年级）。 */
const GEN_TOPICS = {
  math: {
    grades: {
      '一年级': '20以内数的认识与加减法、100以内数的认识、比大小、认识人民币、认识图形（立体与平面）、认识钟表（整时半时）、看图列式',
      '二年级': '表内乘法与除法、100以内加减法（竖式）、长度单位（米/厘米/线段）、角的认识、观察物体、认识时间（几时几分）',
      '三年级': '万以内加减法、多位数乘一位数、有余数的除法、分数的初步认识、四边形与周长、质量单位（克/千克/吨）、时 分 秒',
      '四年级': '大数的认识、三位数乘两位数、除数是两位数的除法、角的度量、平行四边形与梯形、小数的意义与加减法',
      '五年级': '小数乘除法、简易方程、多边形的面积、因数与倍数、长方体与正方体、分数的意义与性质',
      '六年级': '分数乘除法、比与比例、圆的周长与面积、百分数、圆柱与圆锥、负数的认识'
    },
    topics: {
      '口算': '直接写得数的口算题：题干只写算式本身（如 8+5=、15-9=、6+（）=12、23+14=），严禁加「请直接写出得数」「口算」等任何前缀或说明文字，一道一式，适合两列并排作答；内容围绕该年级计算重点，可含连加连减/加减混合/填括号',
      '应用题': '生活情境应用题：读题理解→列式→计算→带单位作答，题干说清情境与要求',
      '图形': '图形与几何专项：数图形、认特征、画图形、比周长面积，可要求学生在作答区画图或标注',
      '钟表与时间': '钟表认读与时间计算：看钟面写时间、推算经过时间、按描述画指针',
      '比较与排序': '比较大小与排序：填 >、<、=，或把数/算式结果按顺序排列',
      '综合': ''
    }
  },
  chinese: {
    grades: {
      '一年级': '汉语拼音（声母韵母整体认读与标调）、识字与写字（笔顺组词）、简单反义词与词语搭配、读句子、古诗背诵',
      '二年级': '识字写字、近义/反义词、量词与词语搭配、看图写话、古诗与课文背默、把字句被字句',
      '三年级': '多音字与形近字、词语理解与运用、修改病句、记叙文阅读（概括段意）、习作片段、古诗理解',
      '四年级': '词语的感情色彩、修辞（比喻拟人）、记叙文阅读（概括内容体会情感）、观察作文、古诗词',
      '五年级': '说明文与记叙文阅读、概括与批注、缩写扩写、古诗文名句、习作（写人记事）',
      '六年级': '综合阅读（记叙/说明/文言启蒙）、句子衔接与表达、作文（叙事抒情）、古诗文积累与理解'
    },
    topics: {
      '拼音': '拼音专项：声母韵母声调辨析、拼读写词、选择正确读音，题型以选择/填空/连线为主',
      '识字与词语': '识字专项：笔顺、组词、近反义词、量词搭配、多音字',
      '阅读理解': '短文阅读专项：出一段 80~150 字短文 + 2~3 道小题（原文找答案/词句理解/简单感想），短文写入题干，小题按 (1)(2)(3) 编号',
      '看图写话与写作': '写作专项：用文字描述画面场景（低年级看图写话）或给作文题目，要求学生写一段话；作答需要较大空间，题量可减至 2~4 道',
      '古诗与背默': '古诗专项：补全诗句、作者与朝代、诗句意思理解',
      '综合': ''
    }
  },
  english: {
    grades: {
      '一年级': '字母认知与大小写、简单单词认读（颜色/数字/动物）、简单问候语',
      '二年级': '字母书写、基础单词（文具/身体/食物）、简单课堂指令',
      '三年级': '26 个字母读写、自我介绍句型、常见单词拼写、简单问答对话',
      '四年级': '核心句型（There be / Can you...）、词汇分类（时间/天气/地点）、简单语篇阅读',
      '五年级': '一般现在时与现在进行时、日常活动与爱好词汇、短文阅读理解',
      '六年级': '一般过去时与一般将来时、比较级初步、语篇阅读与小写作'
    },
    topics: {
      '字母与发音': '字母专项：大小写配对、字母顺序、首字母发音归类',
      '单词': '单词专项：看图/中文写单词、单词分类、选词填空',
      '句型': '句型专项：选词补全句子、连词成句、情景问答选择',
      '阅读理解': '短文阅读专项：50~100 词小短文 + 2~3 道理解题（判断/选择/简答），短文写入题干',
      '综合': ''
    }
  }
};

/** 知识点达标判定（P2）：有全局 kpId 时只按 unitId::kpId 精确匹配（防跨单元 topic 撞名误判）；
 *  无 kpId（旧数据）才 fallback topic。 */
function kpMastered(cards, target) {
  if (!target) return false;
  const tid = target.kpId || '';
  if (tid) {
    return cards.some(c => c && c.done && c.kpId && (c.unitId || '') + '::' + c.kpId === tid);
  }
  return cards.some(c => c && c.done && c.topic === target.topic);
}

/** 盲区提示（出题用，Path A 依赖归因）：优先围绕「前置欠账」的点出题。
 *  判据 = 点的 prereqs 里存在未达标的（kpId 优先、topic 兜底）。
 *  无欠账返回 ''（零回归：不注入 prompt，出题与现状一致）。 */
function buildBlindSpotHint(points, cards, maxChars) {
  const cap = maxChars || 900;
  const lines = [];
  (Array.isArray(points) ? points : []).forEach(p => {
    const missing = (p.prereqs || []).filter(r => r && !kpMastered(cards, r));
    if (missing.length) {
      lines.push('「' + (p.topic || '') + '」缺前置：' + missing.map(m => m.topic || m.kpId).join('、'));
    }
  });
  if (!lines.length) return '';
  let text = '【盲区诊断·优先围绕这些点出题（孩子的前置没打牢，先考这里并适当降低难度）】\n' + lines.slice(0, 10).join('\n');
  if (text.length > cap) text = text.slice(0, cap);
  return text;
}

/** 单元复习题型约束（按学科 + 单元内容）。语文不能再套「填空/计算」硬约束（无计算题型）。 */
function unitTypeHint(subject, unitName, topics) {
  const name = (unitName || '') + ' ' + (topics || []).join(' ');
  if (subject === 'math') {
    return '题型以填空/计算/选择为主，含少量画图（draw）；竖式题用「列竖式计算」表述';
  }
  if (subject === 'chinese') {
    if (/拼音|韵母|声母|声调|拼读|认读/.test(name)) {
      return '拼音题型：选择正确读音、补全声母/韵母、标声调、拼读连线，以选择/填空为主，不出「计算」题型';
    }
    if (/识字|笔画|独体字|偏旁|笔顺|合体字|写字|组词/.test(name)) {
      return '识字题型：笔顺填空、组词、偏旁辨析、选择正确汉字，以填空/选择为主';
    }
    if (/阅读|朗读|背诵|理解|说话|写话/.test(name)) {
      return '阅读/表达题型：给一段短课文或短文 + 2~3 道理解题（原文找答案/词句理解/简单感想）；看图说话/写话用 draw 题型并给足作答空间，题量可减至 3~5 道';
    }
    return '语文题型：以填空/选择为主，含少量书写（draw）题，不出「计算」题型';
  }
  return '题型以填空/计算/选择为主，含少量简答或画图';
}

/* ---------------- 题型库（真实学校试卷题型模板，2026-10-28 从真题提炼） ----------------
 * 解决「出题与学校脱节」：不再让 AI 在 5 个泛化桶里自由发挥，而是按学科×年级给真实题型模板。
 * 每个题型：name=题型名，hint=题干表述/格式要求，type=映射到 QuestionType(choice/fill/calc/essay/draw)。 */
const QUESTION_TYPES = {
  math: {
    '一年级': [
      { name: '口算', hint: '直接写算式本身（如 8+5=、15-9=、6+()=12），一道一式，严禁加「请直接写出得数」等前缀', type: 'calc' },
      { name: '看图列式', hint: '用文字描述图意（如「左边3个苹果，右边2个苹果」），让学生列加法或减法算式', type: 'calc' },
      { name: '数的组成填空', hint: '如「1个十和7个一是（）」「15的个位是（）、十位是（）」', type: 'fill' },
      { name: '比大小', hint: '在○里填 >、< 或 =（如 8+3○12、20-3○16）', type: 'fill' },
      { name: '填括号', hint: '如 6+()=12、()-3=5、()里填数使算式成立', type: 'fill' },
      { name: '找规律', hint: '按规律填空（如 12、（）、（）、15；或 1、3、5、（））', type: 'fill' },
      { name: '判断对错', hint: '给一句话判断对错（如「9+0 大于 9-0」，对还是错）', type: 'choice' },
      { name: '选择', hint: '单选题（如「比15大比18小的数是」A.14 B.17 C.19）', type: 'choice' },
      { name: '解决问题', hint: '生活情境应用题（求一共/求剩余/排队问题），题干说清情境与要求，答案带单位', type: 'essay' },
      { name: '数图形', hint: '数一数有几个长方体/正方体/圆柱/球', type: 'fill' }
    ]
  },
  chinese: {
    '一年级': [
      { name: '看拼音写词语', hint: '给拼音写汉字（如 dà rén→大人、shān shuǐ→山水），每词一字一格', type: 'fill' },
      { name: '选择正确读音', hint: '给加点字选择正确读音（如 手足(zú zhú)），打√', type: 'choice' },
      { name: '拼音分类', hint: '把拼音按声母/韵母/整体认读音节分类', type: 'fill' },
      { name: '标声调', hint: '给音节标上正确声调（如 shan→山、shi→石）', type: 'fill' },
      { name: '补全音节', hint: '拼一拼写一写（如 p—i—āo→（）；ch—u—→chuāng）', type: 'fill' },
      { name: '比一比组词', hint: '形近字组词（如 日（）目（）、人（）入（））', type: 'fill' },
      { name: '笔顺笔画', hint: '如「火」的第二笔是（）；「口」共（）画', type: 'fill' },
      { name: '连线', hint: '图连词语、音节连词语、反义词连线，用 draw 题型让学生连线', type: 'draw' },
      { name: '选词填空', hint: '量词/近义词/语气词填空（如 一（）树、选「友/有」）', type: 'fill' },
      { name: '连词成句', hint: '把词语排成通顺的句子（如 ①太阳②从③升起④东方）', type: 'fill' },
      { name: '课文填空', hint: '根据所学课文内容填空（如 「（）之计在于春」）', type: 'fill' },
      { name: '看图写话', hint: '看图写一句话或几句话（不会写的字用拼音代替），给足书写空间', type: 'essay' },
      { name: '阅读短文', hint: '给一段 80~150 字短文 + 2~3 道小题（原文找答案/词句理解/简单感想）', type: 'essay' }
    ]
  }
};

/** 题型库提示块（出题用）：按学科×年级给真实题型模板。无该年级题型 → ''（零回归）。 */
function buildTypeLibBlock(subject, grade) {
  const types = (QUESTION_TYPES[subject] || {})[grade];
  if (!types || !types.length) return '';
  return '【本年级真实题型（必须严格按这些题型出题，不得自创其他题型，题干表述贴近学校试卷）】\n' +
    types.map(t => '- ' + t.name + '（题型 type=' + t.type + '）：' + t.hint).join('\n');
}

/** 用户指定配比 → 合法题型列表（iPad/网页可选传入 [{name,count}]）。
 *  清洗规则：题型名必须在库里（防 AI 自创）、count 夹到 1~20、最多 12 项、去重取先者。
 *  库里没有该学科×年级 → []（调用方回落整库，零回归）。 */
function normTypeMix(subject, grade, mix) {
  if (!Array.isArray(mix) || !mix.length) return [];
  const lib = (QUESTION_TYPES[subject] || {})[grade] || [];
  if (!lib.length) return [];
  const byName = {};
  lib.forEach(t => { byName[t.name] = t; });
  const seen = {};
  const out = [];
  mix.forEach(m => {
    const name = str(m && m.name, 20);
    const t = byName[name];
    if (!t || seen[name]) return;
    seen[name] = 1;
    const n = Math.min(Math.max(parseInt(m && m.count, 10) || 1, 1), 20);
    out.push({ name: t.name, hint: t.hint, type: t.type, count: n });
  });
  return out.slice(0, 12);
}

/** 指定配比提示块。omitType=true 时不带 type 标记（手写卷强制 draw 时避免与配比里的 type 冲突）。 */
function buildTypeMixBlock(subject, grade, mix, omitType) {
  const list = normTypeMix(subject, grade, mix);
  if (!list.length) return '';
  const total = list.reduce((s, t) => s + t.count, 0);
  return '【本次指定题型配比（共 ' + total + ' 题，严格按此配比出题，不得增减题型或自创题型）】\n' +
    list.map(t => '- ' + t.name + ' × ' + t.count + ' 题' +
      (omitType ? '' : '（题型 type=' + t.type + '）') + '：' + t.hint).join('\n') +
    '\n要求：以上题型按配比出现，每道题的题干表述严格照对应题型的格式要求，贴近学校试卷。';
}

function buildGenUser(input) {
  const sp = input.scope || {};
  const parts = [];
  parts.push('学科：' + (SUBJECT_NAMES[input.subject] || input.subject));
  if (input.grade) parts.push('年级：' + input.grade);
  parts.push('出卷模式：' + (sp.mode || 'auto'));
  parts.push('题量：' + (sp.count || 10));
  if (sp.difficulty) parts.push('整体难度：' + sp.difficulty);
  if (sp.examType && EXAM_TYPE_LABEL[sp.examType]) parts.push('卷型：' + EXAM_TYPE_LABEL[sp.examType]);
  if (sp.unit) parts.push('限定范围：' + sp.unit);
  if (sp.type) parts.push('限定题型：' + sp.type);
  // 年级重点锚定 + 专题约束（GEN_TOPICS：学科×年级重点表，iPad/小程序共用）
  // P0：unitKps 结构化必会知识点优先锚定（真相源收敛）；无该学科必会库才回退 GEN_TOPICS 硬编码
  const gt = GEN_TOPICS[input.subject];
  const kpTopics = Array.isArray(input.unitKpTopics) ? input.unitKpTopics.filter(Boolean).slice(0, 30) : [];
  if (kpTopics.length) {
    parts.push('本学科必会知识点（出题范围锚定，严格围绕这些点、不得超纲）：' + kpTopics.join('、'));
  } else if (gt && input.grade && gt.grades[input.grade]) {
    parts.push('本年级重点（出题范围锚定，不得超纲）：' + gt.grades[input.grade]);
  }
  // 专题约束（GEN_TOPICS 的「题型风格」维度，与知识点范围不同，仍保留）
  if (gt) {
    const topic = str(sp.topic, 20);
    if (topic && gt.topics[topic]) {
      parts.push('本次专题：' + topic + (gt.topics[topic] ? '——' + gt.topics[topic] : ''));
      if (topic !== '综合') {
        parts.push('本次为专题卷：按上述专题与年级重点出题，卷名须含「' + topic + '」字样');
      }
    }
  }
  let ctx = '';
  if (input.planCtx && Array.isArray(input.planCtx.pendingTasks) && input.planCtx.pendingTasks.length) {
    ctx += '\n【当前学习进度·未完成/滞后任务】' + input.planCtx.pendingTasks.slice(0, 10).map(t => '- ' + str(t, 60)).join('\n');
  }
  if (input.learnerCtx) {
    ctx += '\n【孩子近期卡点（供围绕薄弱点出题，新题不必重复旧题）】\n' + str(input.learnerCtx, 1500);
  }
  if (input.expectations && input.expectations.length) {
    ctx += '\n【家长期望内容】' + input.expectations.slice(0, 4).join('、');
  }
  let modeNote = '';
  const mode = sp.mode || 'auto';
  if (mode === 'handwriting') {
    modeNote = '\n\n【手写卷模式·强制】本卷为「手写卷」：每一道题（无论原本是选择/填空/计算/简答）都必须以 type:"draw" 生成，' +
      '即只给题干与参考答案文字，不给学生任何预置输入框——学生将像在真实 A4 打印纸上一样，全部用 Apple Pencil/手写作答。' +
      '题干要写清「请写出/请画出/请列式计算/请勾选并说明」等明确要求；answer 字段给出该道题的标准解答文字（供批改参考，不直接展示给学生）。' +
      '题量与前面一致；draw 题的 options 留空数组。';
  }
  // 题型库：按学科×年级真实题型模板（解决与学校试卷脱节）；客户端显式指定配比时以配比为准
  const isHand = mode === 'handwriting';
  const typeLib = buildTypeMixBlock(input.subject, input.grade, sp.questionTypes, isHand) ||
    buildTypeLibBlock(input.subject, input.grade);
  return parts.join('\n') + ctx + modeNote + (typeLib ? '\n\n' + typeLib : '') + '\n\n请按以上学情出卷。';
}

/* ---------------- 题图（结构化 figure）规范化 ----------------
 * 图形题的图由 AI 用基本图元描述（line/poly/circle/text），两端各自原生绘制。
 * 这里做安全清洗：坐标夹进画布、图元数量上限、文字过合规门禁。
 * 洗不出任何图元就整块丢弃 —— 老客户端只会退化成「只有题干」，而不是画出一团乱线。 */
const FIG_W = [40, 320], FIG_H = [30, 240], FIG_MAX_ITEMS = 30, FIG_MAX_PTS = 16;

function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function normPts(pts, w, h) {
  if (!Array.isArray(pts)) return [];
  const out = [];
  pts.slice(0, FIG_MAX_PTS).forEach(p => {
    if (Array.isArray(p)) out.push([clampNum(p[0], 0, w, 0), clampNum(p[1], 0, h, 0)]);
    else if (p && typeof p === 'object') out.push([clampNum(p.x, 0, w, 0), clampNum(p.y, 0, h, 0)]);
  });
  return out.length >= 2 ? out : [];
}
function normFigure(fig) {
  if (!fig || typeof fig !== 'object' || Array.isArray(fig)) return null;
  const w = Math.round(clampNum(fig.w, FIG_W[0], FIG_W[1], 160));
  const h = Math.round(clampNum(fig.h, FIG_H[0], FIG_H[1], 120));
  const items = [];
  (Array.isArray(fig.items) ? fig.items : []).slice(0, FIG_MAX_ITEMS).forEach(it => {
    if (!it || typeof it !== 'object') return;
    const k = str(it.k, 8);
    if (k === 'line') {
      items.push({
        k: 'line', x1: clampNum(it.x1, 0, w, 0), y1: clampNum(it.y1, 0, h, 0),
        x2: clampNum(it.x2, 0, w, 0), y2: clampNum(it.y2, 0, h, 0), dash: !!it.dash
      });
    } else if (k === 'poly') {
      const pts = normPts(it.pts, w, h);
      if (!pts.length) return;
      items.push({ k: 'poly', pts: pts, closed: it.closed !== false, fill: !!it.fill, dash: !!it.dash });
    } else if (k === 'circle') {
      const r = clampNum(it.r, 1, Math.min(w, h) / 2, 10);
      items.push({
        k: 'circle', cx: clampNum(it.cx, 0, w, w / 2), cy: clampNum(it.cy, 0, h, h / 2),
        r: Math.round(r * 10) / 10, fill: !!it.fill
      });
    } else if (k === 'text') {
      const t = sanitizeBanned(str(it.t, 16));
      if (!t) return;
      items.push({ k: 'text', x: clampNum(it.x, 0, w, 0), y: clampNum(it.y, 0, h, 0), t: t });
    }
  });
  if (!items.length) return null;
  return { w: w, h: h, items: items };
}

function parseExam(text) {
  const obj = extractJson(text);
  if (!obj) return null;
  const questions = Array.isArray(obj.questions) ? obj.questions.map((q, i) => {
    const id = str(q.id, 30) || ('q' + (i + 1));
    const type = ['choice', 'fill', 'calc', 'essay', 'draw'].indexOf(q.type) >= 0 ? q.type : 'fill';
    const options = type === 'choice' ? (Array.isArray(q.options) ? q.options.map(o => cleanChoiceOption(o)).filter(Boolean).slice(0, 4) : []) : [];
    const out = {
      id: id, type: type, stem: sanitizeBanned(str(q.stem, 400)),
      options: options, answer: type === 'choice' ? choiceAnswerLetter(q.answer) : sanitizeBanned(str(q.answer, 300)),
      points: Math.max(0, Number(q.points) || 0), kp: str(q.kp, 60),
      difficulty: Math.min(3, Math.max(1, Number(q.difficulty) || 1))
    };
    const fig = normFigure(q.figure);
    if (fig) out.figure = fig;
    return out;
  }).filter(q => q.stem && (q.type !== 'choice' || q.options.length >= 2)) : [];
  if (!questions.length) return null;
  return {
    name: sanitizeBanned(str(obj.name, 80)) || 'AI 测验卷',
    examType: EXAM_TYPE_LABEL[obj.examType] ? obj.examType : 'unit_test',
    suggestedDuration: Math.max(1, Number(obj.suggestedDuration) || 30),
    knowledgePoints: Array.isArray(obj.knowledgePoints) ? obj.knowledgePoints.map(k => str(k, 40)).slice(0, 20) : [],
    questions: questions,
    answersMarkdown: sanitizeBanned(str(obj.answersMarkdown, 4000))
  };
}

async function genExam(app, input, openid) {
  if (!SUBJECT_NAMES[input.subject]) return { ok: false, code: 'bad_subject', msg: '暂不支持该学科的测验卷' };
  // Path A：读依赖边 + 复习卡毕业态，算学科级盲区，注入出题 prompt（失败静默跳过，不拖挂主链路）
  let blindSpotHint = '';
  try {
    const units = await readUnitKps(app, openid);
    const cards = await readCards(app, openid);
    const sc = units.filter(u => u.subject === input.subject);
    if (sc.length) {
      const allPoints = [];
      sc.forEach(u => (Array.isArray(u.points) ? u.points : []).forEach(p => allPoints.push(p)));
      blindSpotHint = buildBlindSpotHint(allPoints, cards, 1200);
      // P0：unitKps 必会知识点作为出题范围锚定（优先于 GEN_TOPICS 硬编码）
      input.unitKpTopics = allPoints.map(p => p.topic).filter(Boolean);
    }
  } catch (e) {}
  // 出卷归属：切孩子后云端 currentUserId 可能滞后，端上显式带的 childId 优先（仍校验家庭归属）
  const scopeOf = await resolveChildScope(app, openid, str(input.childId, 64));
  const model = aiModel(app);
  let text = '';
  try {
    const r = await generateWithRetry(model, {
      model: 'hy3',
      messages: [
        { role: 'system', content: GEN_SYSTEM },
        { role: 'user', content: buildGenUser(input) + (blindSpotHint ? '\n\n' + blindSpotHint : '') }
      ]
    });
    text = (r && r.text) || '';
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (isNoPackError(e)) {
      return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
    }
    if (isTimeoutErr(e)) {
      return { ok: false, code: 'gen_timeout', msg: '出卷超时（题量偏大或模型繁忙），请减少题量或稍后重试' };
    }
    return { ok: false, code: 'gen_error', msg: '出卷失败：' + msg };
  }
  const parsed = parseExam(text);
  if (!parsed) return { ok: false, code: 'parse_error', msg: '出卷结果解析失败，请重试' };

  // 口算专题兜底：模型常给题干加「请直接写出得数：」前缀（prompt 禁不住），
  // 代码强制剥掉——真实口算卷题干就是算式本身，短题干才能触发两列格子排版。
  if (input.scope && input.scope.topic === '口算' && Array.isArray(parsed.questions)) {
    parsed.questions.forEach(q => {
      q.stem = String(q.stem || '')
        .replace(/^(?:请?直接写出得数|请?写出得数|请?口算(?:下面各题)?)[:：]?\s*/, '')
        .trim();
    });
  }

  const doc = {
    openid: openid,
    // 归属孩子由服务端解析（独立 iPad 账号为空串，不猜）
    childId: scopeOf.childId,
    clientId: str(input.clientId, 60) || ('exam_' + nowMs() + '_' + Math.random().toString(36).slice(2, 8)),
    name: parsed.name, subject: str(input.subject, 20), subjectName: SUBJECT_NAMES[input.subject],
    grade: str(input.grade, 20), examType: parsed.examType,
    knowledgePoints: parsed.knowledgePoints, suggestedDuration: parsed.suggestedDuration,
    questions: parsed.questions, markdown: '', rawText: '', answers: parsed.answersMarkdown,
    origin: 'ai', status: 'published', createdBy: str(input.createdBy, 10) || 'mini',
    createdAt: nowMs(), updatedAt: nowMs()
  };
  try {
    await app.database().collection(EXAM_COLL).add(doc);
  } catch (e) {
    try { await app.database().createCollection(EXAM_COLL); } catch (e2) {}
    // 重试前必须查重：网络抖动/超时场景下服务端可能已写成功，无脑再 add 就是重复落库
    try {
      const dup = await app.database().collection(EXAM_COLL).where({ openid: openid, clientId: doc.clientId }).limit(1).get();
      if (dup && dup.data && dup.data.length) return { ok: true, exam: Object.assign({}, doc, { resourceId: doc.clientId }) };
    } catch (e4) {}
    try { await app.database().collection(EXAM_COLL).add(doc); } catch (e3) { return { ok: false, code: 'db_error', msg: '试卷保存失败：' + ((e3 && e3.message) || e3) }; }
  }
  const out = Object.assign({}, doc);
  delete out._id;
  out.resourceId = out.clientId;
  return { ok: true, exam: out };
}

/* ---------------- COS 客户端直传签名（action='signUpload'） ----------------
 * ⚠️ URL化网关请求体实际上限约 100KB（实测 102,339B 即 413），大图 base64 走函数必炸。
 * 此处用官方 getUploadMetadata 签发直传凭证，客户端 PUT 文件字节直传 COS，体积不受限。
 * ⚠️ 契约铁律：node-sdk getUploadMetadata 内部硬编码 method:'put'，凭证按 PUT 请求签发 ——
 * 客户端必须 PUT + 请求头鉴权（authorization / x-cos-meta-fileid / x-cos-security-token），
 * 用 multipart POST 会报 COS 403 SignatureDoesNotMatch（已实测踩坑）。
 * 路径由服务端按 kind 白名单生成，客户端不能指定任意路径。
 */
async function signUpload(app, input) {
  const kind = str(input.kind, 30);
  const ext = str(input.ext, 8).replace(/[^a-z0-9]/gi, '') || 'jpg';
  let cloudPath = '';
  if (kind === 'page') cloudPath = 'exam_paper_pages/' + nowMs() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  else if (kind === 'handwriting') cloudPath = 'exam_handwriting/' + nowMs() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  else if (kind === 'textbook_pdf') cloudPath = 'textbook_pdfs/' + nowMs() + '_' + Math.random().toString(36).slice(2, 8) + '.' + (ext === 'pdf' ? 'pdf' : 'pdf');
  else return { ok: false, code: 'bad_kind', msg: '不支持的上传类型' };
  try {
    const meta = await app.getUploadMetadata({ cloudPath: cloudPath });
    const d = (meta && meta.data) || {};
    if (!d.url || !d.authorization) return { ok: false, code: 'sign_error', msg: '获取上传签名失败' };
    return {
      ok: true,
      upload: {
        url: d.url, authorization: d.authorization, token: d.token || '',
        fileId: d.fileId || d.cosFileId || '', cosFileId: d.cosFileId || '', cloudPath: cloudPath
      }
    };
  } catch (e) { return { ok: false, code: 'sign_error', msg: '获取上传签名失败：' + ((e && e.message) || e) }; }
}

/* ---------------- 上传试卷解析（action='parseUpload'，Word/PDF 文本 → 结构化卷） ---------------- */
const UPLOAD_PARSE_SYSTEM =
  '你是「试卷结构化」老师。家长上传了一份试卷的原文（从 PDF/Word 提取），请把它原样转成结构化 JSON 试卷。\n' +
  '铁律：不增题、不删题、不改写题意；原文顺序即题号顺序。\n\n' +
  '只输出一个 JSON 对象，第一个字符必须是 {。格式：\n' +
  '{"name":"卷名（原文标题或「学科·上传试卷」）",' +
  '"examType":"unit_test 或 phase_test 或 diagnostic_test 或 special_test 或 advanced_test",' +
  '"suggestedDuration":建议分钟数(整数),' +
  '"knowledgePoints":["知识点1","知识点2"],' +
  '"questions":[' +
  '{"id":"q1","type":"choice|fill|calc|essay|draw","stem":"题干原文","options":["A项内容","B项内容","C项内容","D项内容"](choice 时必填4项，不带字母前缀),"answer":"参考答案/正确选项字母","points":分值(整数,卷面未标注默认5),"kp":"关联知识点","difficulty":1到3},' +
  '...],' +
  '"answersMarkdown":"参考答案与解析（markdown，逐题给出；卷面未附答案时写「待补答案」）"}\n\n' +
  '规则：\n' +
  '1. 卷面附有参考答案/评分标准时：填 answer 与 answersMarkdown；没有则 answer 填空字符串。\n' +
  '2. choice 必须正好 4 个选项、answer 为 A/B/C/D（能从卷面判断时）；其余题型 answer 为文字或算式。\n' +
  '3. 含图/表格的题：type 按题型正常归类，题干以「【看图题】」开头并简述图意，建议家长在预览时手动补图说明。\n' +
  '4. 原文乱码/不完整的题宁可跳过并计入 answersMarkdown 说明，不要编造。';

async function parseUpload(app, input, openid) {
  if (!SUBJECT_NAMES[input.subject]) return { ok: false, code: 'bad_subject', msg: '暂不支持该学科的试卷解析' };
  const rawText = str(input.rawText, 20000);
  if (rawText.trim().length < 30) return { ok: false, code: 'bad_text', msg: '未提取到足够的试卷文字（扫描版 PDF 无文本层，暂不支持）' };
  const model = aiModel(app);
  let text = '';
  try {
    const r = await generateWithRetry(model, {
      model: 'hy3',
      messages: [
        { role: 'system', content: UPLOAD_PARSE_SYSTEM },
        { role: 'user', content: '年级：' + (str(input.grade, 20) || '未标注') + '\n学科：' + SUBJECT_NAMES[input.subject] +
          '\n\n【试卷原文开始】\n' + rawText + '\n【试卷原文结束】\n\n请输出结构化 JSON。' }
      ]
    });
    text = (r && r.text) || '';
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (isNoPackError(e)) {
      return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
    }
    return { ok: false, code: 'parse_error', msg: '试卷解析失败：' + msg };
  }
  const parsed = parseExam(text);
  if (!parsed) return { ok: false, code: 'parse_error', msg: '解析结果异常，请重试或减少单次页数' };
  return {
    ok: true,
    draft: {
      name: parsed.name, examType: parsed.examType, suggestedDuration: parsed.suggestedDuration,
      knowledgePoints: parsed.knowledgePoints, questions: parsed.questions, answersMarkdown: parsed.answersMarkdown
    }
  };
}

/* ---------------- 教材 PDF 目录解析（action='parseTextbookPdf'） ----------------
 * 链路：COS fileId → getTempFileURL 下载（≤25MB）→ pdf-parse 提取文本（限 40 页）
 * → 定位目录段（sliceTocSegment，≤12000 字）→ hy3 提取单元清单（parseTocText）
 * → normalizeTextbook 防御性校验 → 返回草稿（不落库，保存与否由用户拍板）。
 * 扫描版/图片版 PDF 无文本层 → pdf_no_text，引导手动补录（二期接视觉 OCR）。 */
const TOC_PARSE_SYSTEM =
  '你是「教材目录结构化」老师。下面是一本教材的目录页文字（从 PDF 提取，可能含页码/点线/分页符/乱序）。\n' +
  '请提取出该教材的**单元层级目录**，转成结构化 JSON。\n\n' +
  '铁律：\n' +
  '1. 只提取目录中真实存在的单元/章节名，不增补、不编造；页码、点线、装饰文字全部忽略。\n' +
  '2. 保持教材原有顺序；单元名保留编号前缀（如「第一单元 准备课」「Module 1」）。\n' +
  '3. 每个单元可带 keywords（3-8 个核心知识点/课题名，从该单元小节名提炼）与 sections（小节名列表，≤20 条）。\n' +
  '4. 目录中的「复习/整理/单元评价」等按原样作为单元或小节，不合并不改写。\n\n' +
  '只输出一个 JSON 对象，第一个字符必须是 {。格式：\n' +
  '{"title":"教材名（版本+年级+册次+学科，如「人教版·一年级数学上册」；推断不出用原文书名）",' +
  '"term":"上学期/下学期/全一册/必修第一册（推断不出留空字符串）",' +
  '"units":[{"name":"第一单元 准备课","sections":["数一数","比多少"],"keywords":["数一数","比多少"]}, ...]}';

/** 目录段定位：从全文截取「目录」关键词起的窗口（≤max 字）；无关键词则取开头。
 * 纯函数：PDF 提取文本常含封面/前言/正文混排，先定位再喂模型，省 token 又提精度。 */
function sliceTocSegment(text, max) {
  const limit = max || 12000;
  let s = String(text == null ? '' : text);
  const m = s.match(/目\s*录/);
  if (m && m.index >= 0) s = s.slice(m.index);
  // 折叠分页符与连续空白（PDF 提取常见 \f 与成串空格/换行）
  s = s.replace(/\f/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s.slice(0, limit);
}

/** hy3 输出 → 单元清单草案（parseExam 同款宽松 JSON 提取 + 防御性清洗） */
/** 单元数组清洗（parseTocText / 搜索结果提取共用）：截断、剔空名、order 重排；全空返回 [] */
function cleanUnits(arr) {
  if (!Array.isArray(arr)) return [];
  const units = arr.map((u) => {
    const name = str(u && u.name, 40);
    if (!name) return null;
    const sections = Array.isArray(u.sections) ? u.sections.map(x => str(x, 60)).filter(Boolean).slice(0, 20) : [];
    const keywords = Array.isArray(u.keywords) ? u.keywords.map(x => str(x, 30)).filter(Boolean).slice(0, 8) : [];
    const rec = { name: name };
    if (sections.length) rec.sections = sections;
    if (keywords.length) rec.keywords = keywords;
    return rec;
  }).filter(Boolean).slice(0, 30);
  units.forEach((u, i) => { u.order = i + 1; });   // 剔除空名后按序重排
  return units;
}

function parseTocText(text) {
  const obj = extractJson(text);
  if (!obj) return null;
  const units = cleanUnits(obj.units);
  if (!units.length) return null;
  return { title: str(obj.title, 60), term: str(obj.term, 10), units: units };
}

async function parseTextbookPdf(app, input, openid) {
  const fileId = str(input.fileId, 300);
  if (!fileId) return { ok: false, code: 'no_file', msg: '缺少 PDF 文件标识' };
  if (!SUBJECT_NAMES[input.subject]) return { ok: false, code: 'bad_subject', msg: '请先选择学科' };
  // 1. 临时下载地址（COS 文件需签名 URL，直连 fileId 不可下载）
  let downloadUrl = '';
  try {
    const r = await app.getTempFileURL({ fileList: [{ fileID: fileId, maxAge: 600 }] });
    // node-sdk 返回裸 { fileList }（视觉批改链路同款）；兼容个别版本包一层 data
    const list = (r && r.fileList) || (r && r.data && r.data.fileList) || [];
    const f = list.find(x => x.fileID === fileId || x.fileId === fileId) || list[0] || {};
    downloadUrl = f.tempFileURL || f.url || f.downloadUrl || '';
  } catch (e) {}
  if (!downloadUrl) return { ok: false, code: 'file_url_error', msg: '无法获取文件下载地址（文件可能已过期，请重新上传）' };
  // 2. 下载（Node16 无 fetch，走 httpJson；≤25MB，防异常大包打爆函数内存）
  let buf = null;
  try {
    const res = await httpJson(downloadUrl, { timeout: 55000 });
    if (!res.ok) return { ok: false, code: 'download_error', msg: 'PDF 下载失败（HTTP ' + res.status + '）' };
    buf = res.buffer();
  } catch (e) { return { ok: false, code: 'download_error', msg: 'PDF 下载失败：' + ((e && e.message) || e) }; }
  if (!buf || !buf.length) return { ok: false, code: 'empty_file', msg: 'PDF 文件为空' };
  if (buf.length > 25 * 1024 * 1024) return { ok: false, code: 'too_large', msg: 'PDF 超过 25MB，请压缩后重试' };
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return { ok: false, code: 'not_pdf', msg: '文件不是有效的 PDF' };
  // 3. 提取文本（懒加载：仅本 action 需要，避免拖慢其他入口冷启动；限 40 页，目录一般在前几页）
  let fullText = '', numPages = 0;
  try {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    // Node Buffer 池化（byteOffset≠0）会让 pdf.js makeSubStream 读错内存报 bad XRef entry
    // （实测：<4KB 的 fs 读入/concat 结果必在池里）。拷成 byteOffset=0 的干净视图再喂。
    let pdfBytes = buf;
    if (buf.byteOffset !== 0 || buf.length !== buf.buffer.byteLength) {
      pdfBytes = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    }
    const r = await pdfParse(pdfBytes, { max: 40 });
    fullText = (r && r.text) || '';
    numPages = (r && r.numpages) || 0;
  } catch (e) { return { ok: false, code: 'pdf_error', msg: 'PDF 解析失败：' + ((e && e.message) || e) }; }
  const compactLen = fullText.replace(/\s+/g, '').length;
  if (compactLen < 100) return { ok: false, code: 'pdf_no_text', msg: '未能从 PDF 提取到文字（扫描版/图片版 PDF 无文本层）。请改用文字版电子教材 PDF，或保存后在预览页手动补录单元。' };
  // 4. hy3 提取单元清单
  const model = aiModel(app);
  let text = '';
  try {
    const r = await generateWithRetry(model, {
      model: 'hy3',
      messages: [
        { role: 'system', content: TOC_PARSE_SYSTEM },
        { role: 'user', content: '学科：' + SUBJECT_NAMES[input.subject] +
          (str(input.grade, 10) ? '\n年级：' + str(input.grade, 10) : '') +
          (str(input.version, 20) ? '\n版本：' + str(input.version, 20) : '') +
          '\n\n【教材目录文字开始】\n' + sliceTocSegment(fullText) + '\n【教材目录文字结束】\n\n请输出结构化 JSON。' }
      ]
    });
    text = (r && r.text) || '';
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (isNoPackError(e)) {
      return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
    }
    return { ok: false, code: 'parse_error', msg: '目录解析失败：' + msg };
  }
  const parsed = parseTocText(text);
  if (!parsed) return { ok: false, code: 'parse_error', msg: '未从目录中识别出单元，请确认 PDF 含目录页后重试' };
  // 5. 防御性规范化（坏结构在这里被拦，不进库）
  const n = normalizeTextbook({
    title: parsed.title || (SUBJECT_NAMES[input.subject] + '教材'),
    subject: input.subject,
    grade: str(input.grade, 10),
    term: parsed.term || str(input.term, 10),
    version: str(input.version, 20),
    source: 'upload',
    sourceUrl: fileId,
    units: parsed.units
  });
  if (!n.ok) return n;
  return {
    ok: true,
    draft: n.textbook,
    meta: { pages: numPages, textLength: compactLen, truncated: compactLen > 12000 }
  };
}

/* ---------------- 教材目录文本解析（action='parseTextbookText'，粘贴兜底） ----------------
 * 与 parseTextbookPdf 共用 TOC_PARSE_SYSTEM/parseTocText/normalizeTextbook，
 * 区别仅在文本来源：用户直接粘贴目录文字（无 PDF 文件时走这条）。 */
async function parseTextbookText(app, input, openid) {
  if (!SUBJECT_NAMES[input.subject]) return { ok: false, code: 'bad_subject', msg: '请先选择学科' };
  const rawText = str(input.rawText, 20000);
  if (rawText.replace(/\s+/g, '').length < 30) return { ok: false, code: 'bad_text', msg: '目录文字太短，请至少粘贴一个单元条目' };
  const model = aiModel(app);
  let text = '';
  try {
    const r = await generateWithRetry(model, {
      model: 'hy3',
      messages: [
        { role: 'system', content: TOC_PARSE_SYSTEM },
        { role: 'user', content: '学科：' + SUBJECT_NAMES[input.subject] +
          (str(input.grade, 10) ? '\n年级：' + str(input.grade, 10) : '') +
          (str(input.version, 20) ? '\n版本：' + str(input.version, 20) : '') +
          '\n\n【教材目录文字开始】\n' + sliceTocSegment(rawText) + '\n【教材目录文字结束】\n\n请输出结构化 JSON。' }
      ]
    });
    text = (r && r.text) || '';
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (isNoPackError(e)) {
      return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
    }
    return { ok: false, code: 'parse_error', msg: '目录解析失败：' + msg };
  }
  const parsed = parseTocText(text);
  if (!parsed) return { ok: false, code: 'parse_error', msg: '未从目录中识别出单元，请检查内容是否含目录' };
  const n = normalizeTextbook({
    title: parsed.title || (SUBJECT_NAMES[input.subject] + '教材'),
    subject: input.subject,
    grade: str(input.grade, 10),
    term: parsed.term || str(input.term, 10),
    version: str(input.version, 20),
    source: 'upload',
    rawText: rawText,
    units: parsed.units
  });
  if (!n.ok) return n;
  return { ok: true, draft: n.textbook, meta: { textLength: rawText.replace(/\s+/g, '').length } };
}

/* ---------------- 联网搜索教材目录（action='searchTextbook'） ----------------
 * 适配器模式：Tavily 为主（SEARCH_API_URL/SEARCH_API_KEY，默认 https://api.tavily.com/search），
 * 博查 Bocha 兜底（BOCHA_API_URL/BOCHA_API_KEY，默认 https://api.bocha.cn/v1/web-search）。
 * Tavily 用不了或搜不到，自动切博查；都不行才报错/空。URL/key 走云函数环境变量（只存服务端）。
 * 流程：频控（外部 API 按次计费，10s/3 次）→ 依次尝试提供商 → 首个返回有效候选者胜出
 *       → hy3 从摘要提取 units（只提取不落库；家长点「选它」进预览编辑表）。 */

const SEARCH_RATE = { WIN_MS: 10000, MAX_PER_WIN: 3 };
const searchRateMap = new Map();
function searchRateWait(openid) {
  if (!openid) return 0;
  const now = Date.now();
  let r = searchRateMap.get(openid);
  if (!r) { r = { winStart: now, winCount: 0 }; searchRateMap.set(openid, r); }
  if (now - r.winStart >= SEARCH_RATE.WIN_MS) { r.winStart = now; r.winCount = 0; }
  r.winCount++;
  if (searchRateMap.size > 500) {
    for (const [k, v] of searchRateMap) if (now - v.winStart >= 3600000) searchRateMap.delete(k);
  }
  if (r.winCount > SEARCH_RATE.MAX_PER_WIN) return Math.max(0, r.winStart + SEARCH_RATE.WIN_MS - now);
  return 0;
}

const SEARCH_TOC_SYSTEM =
  '你是「教材目录检索」助手。下面给你若干条联网搜索结果（编号/标题/网址/摘要），请逐条判断是否为教材目录页，并只从摘要材料中提取单元目录。\n' +
  '铁律：\n' +
  '1. 只提取材料中真实出现的单元名，严禁编造或补全；\n' +
  '2. 每条结果独立判断，输出编号必须与输入一致；\n' +
  '3. 不是目录页、或材料中没有单元信息的，units 输出空数组；\n' +
  '4. 若材料明显属于其他年级/学期/学科（与给定目标不符），units 输出空数组。\n\n' +
  '只输出一个 JSON 对象，不要任何解释，第一个字符必须是 {。格式：\n' +
  '{"results":[{"index":1,"units":[{"name":"第一单元 准备课","sections":["数一数","比多少"],"keywords":["数一数"]}]}]}';

/** 关键词构造（纯函数）：家长填了 query 就用；否则按「版本+年级+学期+学科+教材目录」拼 */
function buildSearchQuery(input) {
  const q = str(input.query, 60).trim();
  if (q) return q;
  const parts = [];
  if (str(input.version, 20)) parts.push(str(input.version, 20));
  if (str(input.grade, 10)) parts.push(str(input.grade, 10));
  if (str(input.term, 10)) parts.push(str(input.term, 10));
  if (input.subject) parts.push(SUBJECT_NAMES[input.subject] || '');
  const head = parts.filter(Boolean).join('');
  return head ? head + '教材目录' : '小学教材目录';
}

/** Tavily 响应 → 候选列表（纯函数）：title≤80 / url≤300 / snippet≤400，最多 5 条 */
function parseSearchPayload(payload) {
  const arr = (payload && Array.isArray(payload.results)) ? payload.results : [];
  return arr.slice(0, 5).map(r => ({
    title: str(r && r.title, 80),
    url: str(r && r.url, 300),
    snippet: str(r && r.content, 400)
  })).filter(x => x.title || x.url);
}

/** 候选 → hy3 材料（纯函数）：编号化拼接，总长 ≤12000 字 */
function buildSearchMaterial(cands) {
  const blocks = (cands || []).map((c, i) =>
    '[' + (i + 1) + '] 标题：' + (c.title || '') + '\n网址：' + (c.url || '') + '\n摘要：' + (c.snippet || '')
  );
  let s = blocks.join('\n\n');
  if (s.length > 12000) s = s.slice(0, 12000) + '\n……（材料过长已截断）';
  return s;
}

/** hy3 输出 → Map<编号, units>（纯函数）：编号越界/空 units 的条目丢弃 */
function parseSearchToc(text, candCount) {
  const obj = extractJson(text);
  const m = new Map();
  if (!obj || !Array.isArray(obj.results)) return m;
  obj.results.forEach(r => {
    const idx = Number(r && r.index);
    if (!(idx >= 1 && idx <= candCount)) return;
    const units = cleanUnits(r && r.units);
    if (units.length) m.set(idx, units);
  });
  return m;
}

/** Bocha 响应 → 候选列表（纯函数）：data.webPages.value[].name→title / url / summary→snippet，最多 5 条 */
function parseBochaPayload(payload) {
  const pages = (payload && payload.data && payload.data.webPages && Array.isArray(payload.data.webPages.value))
    ? payload.data.webPages.value : [];
  return pages.slice(0, 5).map(r => ({
    title: str(r && r.name, 80),
    url: str(r && r.url, 300),
    snippet: str(r && (r.summary || r.snippet), 400)
  })).filter(x => x.title || x.url);
}

/** 读取已配置的搜索提供商（按顺序：Tavily 主 → Bocha 兜底）。未配置者不进列表。 */
function getSearchProviders() {
  const list = [];
  const tUrl = (process.env.SEARCH_API_URL || 'https://api.tavily.com/search').trim();
  const tKey = (process.env.SEARCH_API_KEY || '').trim();
  if (tUrl && tKey) list.push({ name: 'tavily', url: tUrl, key: tKey });
  const bUrl = (process.env.BOCHA_API_URL || 'https://api.bocha.cn/v1/web-search').trim();
  const bKey = (process.env.BOCHA_API_KEY || '').trim();
  if (bUrl && bKey) list.push({ name: 'bocha', url: bUrl, key: bKey });
  return list;
}

/** 单个提供商执行搜索，返回 { ok, status?, candidates }（不抛异常） */
async function runSearch(provider, query) {
  const headers = { 'Authorization': 'Bearer ' + provider.key, 'Content-Type': 'application/json' };
  const body = (provider.name === 'tavily')
    ? JSON.stringify({ query: query, max_results: 5, search_depth: 'advanced', include_answer: false })
    : JSON.stringify({ query: query, freshness: 'noLimit', summary: true, count: 10 });
  let res;
  try {
    res = await httpJson(provider.url, { method: 'POST', headers: headers, body: body, timeout: 20000 });
  } catch (e) {
    return { ok: false, status: 0, err: ((e && e.message) || String(e)) };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const cands = (provider.name === 'tavily') ? parseSearchPayload(res.json()) : parseBochaPayload(res.json());
  return { ok: true, candidates: cands };
}

async function searchTextbook(app, input, openid) {
  const waitMs = searchRateWait(openid);
  if (waitMs > 0) {
    return { ok: false, code: 'rate_limit', msg: '搜索太频繁啦，休息一下再试～', retryAfterMs: waitMs };
  }
  // 自定义 query 时不再强制学科；仅自动构造关键词路径才需要学科
  const q = str(input.query, 60).trim();
  if (!q && !SUBJECT_NAMES[input.subject]) return { ok: false, code: 'bad_subject', msg: '请先选择学科' };
  const providers = getSearchProviders();
  if (!providers.length) {
    return { ok: false, code: 'search_unconfigured', msg: '联网搜索未配置：请在云开发控制台为 examService 设置 SEARCH_API_URL/SEARCH_API_KEY 与/或 BOCHA_API_URL/BOCHA_API_KEY' };
  }
  const query = buildSearchQuery(input);
  if (!query) return { ok: false, code: 'empty', msg: '请输入搜索关键词' };
  // 1. 依次尝试提供商：Tavily 为主，搜不到/报错自动切 Bocha
  let cands = [];
  let usedProvider = '';
  let lastErr = null;
  for (const p of providers) {
    const r = await runSearch(p, query);
    if (r.ok && r.candidates.length) { cands = r.candidates; usedProvider = p.name; break; }
    if (!r.ok) lastErr = p.name + ':' + (r.status || r.err);
  }
  if (!cands.length) {
    if (lastErr) return { ok: false, code: 'search_error', msg: '搜索服务暂时不可用（' + lastErr + '）' };
    return { ok: true, candidates: [], usedQuery: query, provider: providers.map(p => p.name).join(',') };
  }
  // 2. hy3 从摘要材料提取 units（一次调用处理全部候选，按编号分组；失败不阻断，候选仍可见）
  let byIdx = new Map();
  try {
    const model = aiModel(app);
    const target = '目标教材：' + (q ? '通用检索' : (SUBJECT_NAMES[input.subject] || input.subject)) +
      (str(input.grade, 10) ? ' · ' + str(input.grade, 10) : '') +
      (str(input.term, 10) ? ' · ' + str(input.term, 10) : '') +
      (str(input.version, 20) ? ' · ' + str(input.version, 20) : '');
    const r = await generateWithRetry(model, {
      model: 'hy3',
      messages: [
        { role: 'system', content: SEARCH_TOC_SYSTEM },
        { role: 'user', content: target + '\n\n请从以下 ' + cands.length + ' 条搜索结果中提取教材单元目录：\n\n' + buildSearchMaterial(cands) }
      ]
    });
    byIdx = parseSearchToc((r && r.text) || '', cands.length);
  } catch (e) { /* hy3 异常 → 候选 units 为空，前端禁用「选它」，可改用粘贴兜底 */ }
  const candidates = cands.map((c, i) => Object.assign({}, c, { units: byIdx.get(i + 1) || [] }));
  return { ok: true, candidates: candidates, usedQuery: query, provider: usedProvider };
}

/* ---------------- 批改结果复核（action='reviewSubmission'，逐题确认/改判 + 同步错题库） ----------------
 * verdict: confirm(维持 AI 判定) / override_correct(改判正确，AI 误判) / override_wrong(改判错误，AI 漏判)
 * 改判正确 → results 该题 correct=true/score=满分，并从 tutor_mistakes 移除该题错题；
 * 改判错误 → correct=false/score=0，若错题库缺该题则补录（markSource='human'）。
 * 全程可追溯：reviews[] 只追加，不改写历史复核。
 */
async function reviewSubmission(app, input, openid) {
  const submissionClientId = str(input.submissionClientId, 80);
  const reviews = Array.isArray(input.reviews) ? input.reviews.slice(0, 100) : [];
  if (!submissionClientId) return { ok: false, code: 'no_id', msg: '缺少提交标识' };
  if (!reviews.length) return { ok: false, code: 'no_input', msg: '没有需要复核的题目' };

  let doc = null;
  try {
    const res = await app.database().collection(SUB_COLL).where({ openid: openid, clientId: submissionClientId }).limit(1).get();
    doc = (res && res.data && res.data[0]) || null;
  } catch (e) {}
  if (!doc) return { ok: false, code: 'not_found', msg: '未找到该提交记录' };

  let exam = null;
  try {
    const res2 = await app.database().collection(EXAM_COLL).where({ openid: openid, clientId: doc.examClientId }).limit(1).get();
    exam = (res2 && res2.data && res2.data[0]) || null;
  } catch (e) {}
  const qById = {};
  ((exam && exam.questions) || []).forEach(q => { qById[q.id] = q; });

  const results = Array.isArray(doc.results) ? doc.results : [];
  const rByQid = {};
  results.forEach(r => { rByQid[r.qid] = r; });
  const prevReviews = Array.isArray(doc.reviews) ? doc.reviews : [];
  const now = nowMs();
  let overridden = 0, mistakesRemoved = 0, mistakesAdded = 0;
  const syncErrors = [];
  const applied = [];

  for (const rv of reviews) {
    const qid = str(rv && rv.qid, 30);
    const verdict = str(rv && rv.verdict, 20);
    const r = rByQid[qid];
    if (!r || ['confirm', 'override_correct', 'override_wrong'].indexOf(verdict) < 0) continue;

    if (verdict === 'confirm') {
      applied.push({ qid: qid, verdict: verdict, reviewedAt: now });
      continue;
    }
    overridden++;
    const q = qById[qid];
    if (verdict === 'override_correct') {
      r.correct = true;
      r.score = (q && q.points) || 0;
      r.diagnosis = Object.assign({}, r.diagnosis || {}, { errorType: '', errorDesc: '人工复核：判定正确（AI 误判）', suggestion: '' });
      // 同步错题库：移除该题错题
      try {
        const fq = await app.database().collection(MISTAKE_COLL).where({ openid: openid, clientId: 'mk_' + doc.examClientId + '_' + qid }).get();
        const mdocs = (fq && fq.data) || [];
        for (const m of mdocs) {
          try { await app.database().collection(MISTAKE_COLL).doc(m._id).remove(); mistakesRemoved++; } catch (e5) { syncErrors.push('rm:' + String((e5 && e5.message) || e5).slice(0, 120)); }
        }
      } catch (e4) { syncErrors.push('rmq:' + String((e4 && e4.message) || e4).slice(0, 120)); }
    } else {
      // override_wrong
      const d = (rv && rv.diagnosis && typeof rv.diagnosis === 'object') ? rv.diagnosis : {};
      const prevD = r.diagnosis || {};
      r.correct = false;
      r.score = 0;
      r.diagnosis = {
        errorType: /^E[1-9]$/.test(d.errorType || '') ? d.errorType : (prevD.errorType || 'E1'),
        errorDesc: sanitizeBanned(str(d.errorDesc, 200)) || (prevD.errorDesc && ('人工复核确认错误。' + prevD.errorDesc)) || '人工复核：判定错误（AI 漏判）',
        suggestion: sanitizeBanned(str(d.suggestion, 200)) || prevD.suggestion || '订正本题'
      };
      // 同步错题库：缺则补录（markSource='human'）
      const mkId = 'mk_' + doc.examClientId + '_' + qid;
      try {
        const fq = await app.database().collection(MISTAKE_COLL).where({ openid: openid, clientId: mkId }).limit(1).get();
        if (!fq || !fq.data || !fq.data.length) {
          const ansRec = (Array.isArray(doc.answers) ? doc.answers : []).find(a => a && a.qid === qid);
          try {
            await app.database().collection(MISTAKE_COLL).add({
              openid: openid, clientId: mkId,
              subject: doc.subject || '', subjectName: doc.subjectName || '',
              topic: (q && q.kp) || (doc.examName || ''),
              errorType: r.diagnosis.errorType, errorDesc: r.diagnosis.errorDesc, suggestion: r.diagnosis.suggestion,
              status: 'pending', source: 'exam',
              questionText: (q && q.stem) || '', childAnswer: (ansRec && ansRec.text) || r.ocrText || '',
              markSource: 'human', createdAt: now
            });
            mistakesAdded++;
          } catch (e6) {
            syncErrors.push('add:' + String((e6 && e6.message) || e6).slice(0, 160));
            // 重试前查重（addOnce 自带），不再无脑再 add —— 否则同一 mkId 会落两条
            const ansRec2 = (Array.isArray(doc.answers) ? doc.answers : []).find(a => a && a.qid === qid);
            const mk2 = await addOnce(app, MISTAKE_COLL, {
              openid: openid, clientId: mkId,
              subject: doc.subject || '', subjectName: doc.subjectName || '',
              topic: (q && q.kp) || (doc.examName || ''),
              errorType: r.diagnosis.errorType, errorDesc: r.diagnosis.errorDesc, suggestion: r.diagnosis.suggestion,
              status: 'pending', source: 'exam',
              questionText: (q && q.stem) || '', childAnswer: (ansRec2 && ansRec2.text) || r.ocrText || '',
              markSource: 'human', createdAt: now
            }, { openid: openid, clientId: mkId });
            if (mk2.ok) mistakesAdded++;
            else syncErrors.push('add2:' + String(mk2.err).slice(0, 160));
          }
        }
      } catch (e4) { syncErrors.push('wq:' + String((e4 && e4.message) || e4).slice(0, 160)); }
    }
    applied.push({ qid: qid, verdict: verdict, reviewedAt: now });
  }

  if (!applied.length) return { ok: false, code: 'no_effect', msg: '复核内容与题目不匹配' };

  // 重算总评（改判后正确率/得分同步刷新）
  const totalPoints = exam
    ? ((exam.questions) || []).reduce((s, q) => s + (q.points || 0), 0)
    : ((doc.summary && doc.summary.totalPoints) || 0);
  const gotPoints = results.reduce((s, r) => s + (r.score || 0), 0);
  const correctCount = results.filter(r => r.correct).length;
  const wrongList = results.filter(r => !r.correct);
  const summary = {
    total: results.length, correctCount: correctCount, totalPoints: totalPoints, gotPoints: gotPoints,
    rate: results.length ? Math.round(correctCount / results.length * 100) : 0,
    strengths: [],
    weaknesses: wrongList.slice(0, 6).map(r => {
      const q = qById[r.qid];
      return (q && q.kp ? q.kp : ('题' + r.qid)) + (r.diagnosis && r.diagnosis.errorType ? '（' + r.diagnosis.errorType + '）' : '');
    }),
    advice: '针对薄弱点（' + (wrongList[0] && qById[wrongList[0].qid] && qById[wrongList[0].qid].kp || '相关知识点') + '）加强练习，错了的题建议进入错题本订正。'
  };

  doc.results = results;
  doc.reviews = prevReviews.concat(applied);
  doc.reviewedAt = now;
  doc.summary = summary;
  try {
    await app.database().collection(SUB_COLL).doc(doc._id).update({ results: results, reviews: doc.reviews, reviewedAt: now, summary: summary });
  } catch (e) { return { ok: false, code: 'db_error', msg: '复核结果保存失败' }; }

  const out = Object.assign({}, doc);
  delete out._id;
  out.resourceId = out.clientId || submissionClientId;
  return { ok: true, submission: out, overridden: overridden, mistakesRemoved: mistakesRemoved, mistakesAdded: mistakesAdded, syncErrors: syncErrors };
}

/* ---------------- AI 批改（action='grade'，双路线） ---------------- */
const GRADE_TEXT_SYSTEM =
  '你是「测验卷批改」老师。对照参考答案，逐题判断孩子的作答是否正确，并对错误题给出 E1-E9 错因诊断与建议。\n' +
  '不编造评分标准；只依据题面与参考答案判断；不确定时判「需人工复核」。\n\n' +
  '只输出一个 JSON 对象，第一个字符必须是 {。格式：\n' +
  '{"items":[{"qid":"题号","correct":true或false,"score":该题得分(0~points),"diagnosis":{"errorType":"E1~E9或空","errorDesc":"可观察到的错误行为","suggestion":"订正建议"}}]}\n\n' +
  '错因编号：E1审题 E2概念 E3表征 E4关系 E5证据 E6推理 E7信息处理 E8表达 E9检查迁移。\n' +
  '规则：choice 直接比对选项；其余题型按参考答案语义判断，允许等价表述。';

const GRADE_VISION_PROMPT =
  '请批改以下孩子手写作答的图片。图中每道题已对应题号与参考答案。\n' +
  '逐题：① 先识别孩子手写内容（OCR）；② 对照参考答案判断正确与否；③ 错误题给出 E1-E9 错因与订正建议。\n' +
  '只输出一个 JSON 对象，第一个字符必须是 {。格式：\n' +
  '{"items":[{"qid":"题号","ocrText":"识别出的手写文字","correct":true或false,"score":得分,"diagnosis":{"errorType":"E1~E9或空","errorDesc":"错误行为","suggestion":"订正建议"}}]}';

function normChoice(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/[（）()\s]/g, '').slice(0, 1); }

/** 清洗 AI/导入的选择项：去掉行首多余的「A. 」「A、」「A．」前缀，避免客户端再拼一次导致 “A. A. xxx” */
function cleanChoiceOption(s) {
  return str(s, 100).trim().replace(/^[A-Fa-f][．.、]\s*/, '');
}
/** 选择题参考答案归一为单个字母（兼容 “A” / “A. 文本” / “选A” 等写法） */
function choiceAnswerLetter(v) {
  const m = String(v == null ? '' : v).match(/^[A-Fa-f]/);
  if (m) return m[0].toUpperCase();
  return normChoice(v);
}

/** 本地判定 choice（确定性，不调 AI） */
function judgeChoice(q, ans) {
  const your = normChoice(ans && ans.text);
  const correct = !!your && your === normChoice(q.answer);
  return { qid: q.id, correct: correct, score: correct ? (q.points || 0) : 0, ocrText: '', diagnosis: { errorType: '', errorDesc: correct ? '' : '选择题选项与正确答案不符', suggestion: correct ? '' : '对照选项再确认' } };
}

/** 文本 AI 判分（fill/calc/essay）：批量一次调用，逐元素防御解析 */
async function gradeByText(app, exam, answers) {
  const qById = {};
  (exam.questions || []).forEach(q => { qById[q.id] = q; });
  const toGrade = answers.filter(a => {
    const q = qById[a.qid];
    return q && q.type !== 'choice' && (a.text || '').trim();
  });
  if (!toGrade.length) return {};
  const stemBlock = toGrade.map(a => {
    const q = qById[a.qid];
    return '题号 ' + a.qid + '（' + (q.type) + '，满分' + (q.points || 0) + '）\n题干：' + q.stem +
      (q.options && q.options.length ? ('\n选项：' + q.options.map((o, i) => (['A', 'B', 'C', 'D'][i]) + '.' + o).join(' ')) : '') +
      '\n参考答案：' + q.answer + '\n孩子作答：' + str(a.text, 500);
  }).join('\n\n');
  const model = aiModel(app);
  let items = [];
  try {
    const r = await generateWithRetry(model, { model: 'hy3', messages: [{ role: 'system', content: GRADE_TEXT_SYSTEM }, { role: 'user', content: stemBlock + '\n\n请输出批改 JSON。' }] });
    const obj = extractJson((r && r.text) || '');
    if (obj && Array.isArray(obj.items)) items = obj.items;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (isNoPackError(e)) {
      throw { code: 'no_pack', msg: 'AI 资源包未开通，无法批改主观题' };
    }
    throw { code: 'grade_error', msg: '批改失败：' + msg };
  }
  const map = {};
  items.forEach(it => {
    const q = qById[it.qid];
    if (!q) return;
    const correct = !!it.correct;
    const diagnosis = it.diagnosis && typeof it.diagnosis === 'object' ? it.diagnosis : {};
    map[it.qid] = {
      qid: it.qid, correct: correct,
      score: correct ? (q.points || 0) : Math.max(0, Math.min(Number(it.score) || 0, q.points || 0)),
      ocrText: '',
      diagnosis: {
        errorType: /^E[1-9]$/.test(diagnosis.errorType || '') ? diagnosis.errorType : '',
        errorDesc: sanitizeBanned(str(diagnosis.errorDesc, 200)),
        suggestion: sanitizeBanned(str(diagnosis.suggestion, 200))
      }
    };
  });
  return map;
}

/** 视觉模型判分（draw/手写图片）：取试卷图片 + 作答图片，一次多模态调用 */
async function gradeByVision(app, visionCfg, exam, answers, imageUrls) {
  if (!visionCfg || !visionCfg.key) throw { code: 'no_vision_key', msg: '未配置视觉模型密钥' };
  const qById = {};
  (exam.questions || []).forEach(q => { qById[q.id] = q; });
  // 构造题面参考文本（让视觉模型知道每题参考答案）
  const refText = (exam.questions || []).map(q => q.id + ':' + q.stem + ' 参考答案=' + q.answer).join('\n');
  const prompt = GRADE_VISION_PROMPT + '\n\n【试卷题目与参考答案】\n' + refText + '\n\n请输出批改 JSON。';
  const build = visionBuilder(visionCfg);
  let images = imageUrls;
  if (visionCfg.kind === 'gemini') {
    // Gemini 需要 base64 内联图片
    const conv = [];
    for (const u of imageUrls) {
      try { const r = await httpJson(u); conv.push(r.buffer().toString('base64')); }
      catch (e) { /* skip */ }
    }
    images = conv;
  }
  const req = build(images, prompt);
  let text = '';
  try {
    const resp = await httpJson(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    const j = resp.json();
    text = req.pick ? req.pick(j) : (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } catch (e) { throw { code: 'vision_error', msg: '视觉模型调用失败：' + ((e && e.message) || e) }; }
  const obj = extractJson(text);
  if (!obj || !Array.isArray(obj.items)) throw { code: 'vision_parse', msg: '视觉模型返回解析失败' };
  const map = {};
  obj.items.forEach(it => {
    const q = qById[it.qid];
    if (!q) return;
    const diagnosis = it.diagnosis && typeof it.diagnosis === 'object' ? it.diagnosis : {};
    map[it.qid] = {
      qid: it.qid, correct: !!it.correct,
      score: !!it.correct ? (q.points || 0) : Math.max(0, Math.min(Number(it.score) || 0, q.points || 0)),
      ocrText: str(it.ocrText, 1000),
      diagnosis: {
        errorType: /^E[1-9]$/.test(diagnosis.errorType || '') ? diagnosis.errorType : '',
        errorDesc: sanitizeBanned(str(diagnosis.errorDesc, 200)),
        suggestion: sanitizeBanned(str(diagnosis.suggestion, 200))
      }
    };
  });
  return map;
}

/* ---------------- PDF 直写阅卷（导入 PDF → 页面手写作答 → 逐页视觉阅卷） ----------------
 * 与 grade 的区别：这里没有结构化题目与参考答案，试卷就是「原卷页图」本身。
 * 阅卷 = 把「原卷+孩子手写」的合成页图给视觉模型，让它自己识题、判对错。
 * 无视觉配置 / 调用失败 → 诚实标「需人工复核」，不伪判（与 grade 的降级口径一致）。
 */
const GRADE_PAPER_SYSTEM =
  '你是小学试卷阅卷老师。图片中：印刷体是试卷原题，手写笔迹是孩子的作答（孩子直接写在题目旁/下方）。\n' +
  '任务：① 识别图中每道题目；② 识别孩子对应的手写作答；③ 判断对错——计算/填空按结果，主观题按合理性与完整性；无标准答案时依据学科常识判断，无法确定的判 needsReview=true；④ 错题给 E1-E9 错因与订正建议。\n' +
  '只输出一个 JSON 对象，第一个字符必须是 {。格式：\n' +
  '{"items":[{"no":"题号","question":"题目摘要","ocrText":"孩子手写作答","correct":true或false,"needsReview":true或false,"diagnosis":{"errorType":"E1~E9或空","errorDesc":"错误行为","suggestion":"订正建议"}}]}\n' +
  '错因编号：E1审题 E2概念 E3表征 E4关系 E5证据 E6推理 E7信息处理 E8表达 E9检查迁移。不确定就对错不编造。';

/** 单页视觉阅卷 */
async function gradePaperPageByVision(app, visionCfg, page, urls) {
  const build = visionBuilder(visionCfg);
  let images = urls;
  if (visionCfg.kind === 'gemini') {
    // Gemini 需要 base64 内联图片
    const conv = [];
    for (const u of urls) {
      try { const r = await httpJson(u); conv.push(r.buffer().toString('base64')); }
      catch (e) { /* skip */ }
    }
    images = conv;
  }
  const pageNo = String(page.stem || '').replace(/[^0-9]/g, '') || '?';
  const prompt = GRADE_PAPER_SYSTEM + '\n\n本图为试卷第 ' + pageNo + ' 页，请批改图中孩子的手写作答，输出 JSON。';
  const req = build(images, prompt);
  let text = '';
  try {
    const resp = await httpJson(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    const j = resp.json();
    text = req.pick ? req.pick(j) : (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } catch (e) { throw { code: 'vision_error', msg: '视觉模型调用失败：' + ((e && e.message) || e) }; }
  const obj = extractJson(text);
  if (!obj || !Array.isArray(obj.items)) throw { code: 'vision_parse', msg: '视觉模型返回解析失败' };
  const items = obj.items.filter(it => it && typeof it === 'object');
  if (!items.length) throw { code: 'vision_parse', msg: '视觉模型未返回题目' };
  const anyWrong = items.some(it => it.correct !== true);
  const needReview = items.some(it => it.needsReview === true);
  const wrong = items.find(it => it.correct !== true) || null;
  const d = (wrong && wrong.diagnosis && typeof wrong.diagnosis === 'object') ? wrong.diagnosis : {};
  const ocr = items
    .map(it => (it.no ? ('[' + it.no + '] ') : '') + str(it.ocrText, 200))
    .filter(Boolean).join('；');
  return {
    qid: page.id,
    correct: !anyWrong && !needReview,
    score: (anyWrong || needReview) ? 0 : 100,
    ocrText: str(ocr, 900),
    diagnosis: {
      errorType: /^E[1-9]$/.test(d.errorType || '') ? d.errorType : '',
      errorDesc: (needReview && !anyWrong) ? '本页有需人工复核的题目' : sanitizeBanned(str(d.errorDesc, 200)),
      suggestion: sanitizeBanned(str(d.suggestion, 200))
    }
  };
}

/** PDF 直写卷提交阅卷 */
async function gradePaper(app, input, openid) {
  const examClientId = str(input.examClientId, 80);
  if (!examClientId) return { ok: false, code: 'no_exam', msg: '缺少试卷标识' };
  let examDoc = null;
  try {
    const res = await app.database().collection(EXAM_COLL).where({ openid: openid, clientId: examClientId }).limit(1).get();
    examDoc = (res && res.data && res.data[0]) || null;
  } catch (e) {}
  if (!examDoc) return { ok: false, code: 'exam_not_found', msg: '未找到该考卷' };
  const exam = {
    clientId: examDoc.clientId, name: examDoc.name || '导入的试卷',
    subject: examDoc.subject || '', subjectName: examDoc.subjectName || ''
  };
  // 每页一题（id: p1..pn，stem: 第N页）
  const pages = (Array.isArray(examDoc.questions) ? examDoc.questions : []).slice(0, 30);
  if (!pages.length) return { ok: false, code: 'no_pages', msg: '该导入卷没有页面' };
  const answers = Array.isArray(input.answers) ? input.answers.slice(0, 30) : [];

  let visionCfg = null;
  try {
    const vdoc = await readVisionConfigDoc(app, openid);
    visionCfg = resolveActiveVision(vdoc);
  } catch (e) {}

  const resultMap = {};
  // 系统级降级结果（未配置视觉 / 阅卷失败）：只在报告标「需人工复核」，不进错题本（避免系统提示污染错题库）
  const reviewResult = (qid, desc, suggestion) => ({
    qid: qid, correct: false, score: 0, ocrText: '', reviewOnly: true,
    diagnosis: { errorType: '', errorDesc: desc, suggestion: suggestion }
  });
  for (const a of answers) {
    const page = pages.find(p => p.id === a.qid);
    if (!page) continue;
    const fileIds = Array.isArray(a.imageRefs) ? a.imageRefs.filter(Boolean).slice(0, 3) : [];
    if (!fileIds.length) {
      resultMap[a.qid] = { qid: a.qid, correct: false, score: 0, ocrText: '', diagnosis: { errorType: '', errorDesc: '未提交该页作答', suggestion: '补做本页' } };
      continue;
    }
    if (!visionCfg || !visionCfg.key) {
      resultMap[a.qid] = reviewResult(a.qid, '未配置视觉模型，需人工复核', '在网页端看板配置视觉模型后可自动阅卷');
      continue;
    }
    try {
      const urls = await getFileUrls(app, fileIds);
      if (!urls.length) throw { code: 'no_url', msg: '页面图取址失败' };
      resultMap[a.qid] = await gradePaperPageByVision(app, visionCfg, page, urls);
    } catch (e) {
      resultMap[a.qid] = reviewResult(a.qid, '本页阅卷失败（' + (e.msg || '') + '），需人工复核', '请人工核对本页');
    }
  }
  pages.forEach(p => {
    if (!resultMap[p.id]) resultMap[p.id] = { qid: p.id, correct: false, score: 0, ocrText: '', diagnosis: { errorType: '', errorDesc: '未提交该页', suggestion: '补做本页' } };
  });

  const results = pages.map(p => resultMap[p.id]);
  const correctCount = results.filter(r => r.correct).length;
  const summary = {
    total: pages.length, correctCount: correctCount,
    totalPoints: pages.length * 100, gotPoints: correctCount * 100,
    rate: pages.length ? Math.round(correctCount / pages.length * 100) : 0,
    strengths: [],
    weaknesses: results.filter(r => !r.correct).slice(0, 6).map(r => {
      const pg = pages.find(p => p.id === r.qid) || {};
      return (pg.stem || r.qid) + '（' + ((r.diagnosis && r.diagnosis.errorDesc) || '需复核').slice(0, 20) + '）';
    }),
    advice: '已按页批改；标「需人工复核」的页请家长重点核对。错页已进入错题本可复习。'
  };

  const scope = await resolveChildScope(app, openid);
  const subDoc = {
    openid: openid,
    // 归属孩子由服务端解析（独立 iPad 账号为空串，不猜）
    childId: scope.childId,
    clientId: str(input.submissionClientId, 60) || ('sub_paper_' + nowMs() + '_' + Math.random().toString(36).slice(2, 8)),
    examClientId: exam.clientId, examName: exam.name, subject: exam.subject, subjectName: exam.subjectName,
    route: 'paper',
    answers: answers.map(a => Object.assign({}, a, resultMap[a.qid] ? { diagnosis: resultMap[a.qid].diagnosis } : {})),
    results: results,
    summary: summary,
    createdAt: nowMs(), status: 'graded'
  };
  // 提交记录是这份批改报告的**唯一载体**：落库失败必须报错，绝不能像以前那样空吞
  // 然后照样返回 ok:true（家长看到结果、刷新后却永远找不到这条提交）。
  const subRes = await addOnce(app, SUB_COLL, subDoc, { openid: openid, clientId: subDoc.clientId });
  if (!subRes.ok) return { ok: false, code: 'db_error', msg: '提交记录保存失败：' + subRes.err };

  // 回流错题本：判错的页 → tutor_mistakes（source='paper'，与测验卷错题同库）。
  // reviewOnly（系统级降级：未配置视觉/阅卷失败）不进错题本——那是系统提示不是错题。
  let mistakesAdded = 0;
  for (const r of results) {
    if (r.correct) continue;
    if (r.reviewOnly) continue;
    if (r.diagnosis && r.diagnosis.errorDesc === '未提交该页') continue;
    const page = pages.find(p => p.id === r.qid) || {};
    try {
      await app.database().collection(MISTAKE_COLL).add({
        openid: openid,
        childId: subDoc.childId,
        clientId: ('mk_' + exam.clientId + '_' + r.qid),
        subject: exam.subject || '', subjectName: exam.subjectName || '',
        topic: exam.name || '',
        errorType: (r.diagnosis && r.diagnosis.errorType) || '',
        errorDesc: (r.diagnosis && r.diagnosis.errorDesc) || '导入卷作答有误',
        suggestion: (r.diagnosis && r.diagnosis.suggestion) || '',
        status: 'pending', source: 'paper',
        questionText: page.stem || '', childAnswer: r.ocrText || '', markSource: 'ai',
        createdAt: nowMs()
      });
      mistakesAdded++;
    } catch (e2) {}
  }

  const out = Object.assign({}, subDoc);
  delete out._id;
  return { ok: true, submission: out, mistakesAdded: mistakesAdded };
}

/* ---------------- 选择题错因归类（本地已判定对错，这里只做 E1-E9 归因） ----------------
 * 选择题正确性由 judgeChoice 本地确定性判定（可靠），但原逻辑不给错因分类。
 * 这里对「判错的选项」追一次 AI 归因：依据题干 + 选项 + 孩子所选错误项 + 正确答案，
 * 推断 E1-E9 主因。诊断失败（含 no_pack）返回 {}，回退到 judgeChoice 的通用描述，不阻塞批改。
 */
const CHOICE_DIAGNOSE_SYSTEM =
  '你是「测验卷错题归因」老师。孩子做了一道选择题但选错了选项。\n' +
  '请仅依据题干、选项、孩子所选的错误选项、正确答案，判断孩子选错的主要原因，' +
  '归到 E1-E9 错因之一，并给一句错因描述与一句订正建议。\n' +
  '不编造；只在题干与选项内推断；拿不准时归为 E1 审题 或 E4 关系，不要判为需人工复核。\n\n' +
  '只输出一个 JSON 对象，第一个字符必须是 {。格式：\n' +
  '{"items":[{"qid":"题号","diagnosis":{"errorType":"E1~E9","errorDesc":"错因描述","suggestion":"订正建议"}}]}\n\n' +
  '错因编号：E1审题 E2概念 E3表征 E4关系 E5证据 E6推理 E7信息处理 E8表达 E9检查迁移。';

/**
 * 选择题规则兜底归因：AI 不可用或 AI 未给出有效 E1-E9 时，按题干/选项特征给一个轻量分类。
 * 规则：题干或选项含「条件关系/比较/因果/对应」类线索 → 归 E4 关系（没理清条件与选项的关系）；
 * 否则默认 E1 审题（误选了干扰项）。保证即便 AI 缺失，选择题错因也不再是泛泛的「选项不符」。
 */
function ruleChoiceDiag(q, chosen, correct) {
  const text = ((q && q.stem) || '') + ' ' + ((q && q.options) ? q.options.join(' ') : '');
  const relCues = ['因为', '所以', '原因', '顺序', '对应', '属于', '关系', '比较', '大于', '小于', '区别', '联系', '等于', '换算', '比例', '多少', '几个', '哪些'];
  const hasRel = relCues.some(c => text.indexOf(c) >= 0);
  if (hasRel) {
    return { errorType: 'E4', errorDesc: '未能理清题目条件与选项之间的关系，误选了干扰项', suggestion: '先理清题干的条件关系，再对应到正确选项' };
  }
  return { errorType: 'E1', errorDesc: '审题不清，误选了干扰项', suggestion: '看清题干与选项，排除干扰项后再作答' };
}

async function diagnoseWrongChoices(app, exam, answers) {
  const qById = {};
  (exam.questions || []).forEach(q => { qById[q.id] = q; });
  const toDiag = answers.filter(a => {
    const q = qById[a.qid];
    return q && q.type === 'choice' && (a.text || '').trim();
  });
  if (!toDiag.length) return {};
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const block = toDiag.map(a => {
    const q = qById[a.qid];
    const chosen = (a.text || '').trim().toUpperCase();
    const ci = letters.indexOf(chosen);
    return '题号 ' + a.qid + '\n题干：' + q.stem +
      (q.options && q.options.length ? ('\n选项：' + q.options.map((o, i) => letters[i] + '.' + o).join(' ')) : '') +
      '\n孩子所选（错误）：' + (ci >= 0 ? (chosen + '.' + (q.options[ci] || '')) : chosen) +
      '\n正确答案：' + q.answer;
  }).join('\n\n');
  // 先为每条构造规则兜底归因（保证 AI 不可用也有 E1/E4 分类）
  const map = {};
  toDiag.forEach(a => {
    const q = qById[a.qid];
    const chosen = (a.text || '').trim().toUpperCase();
    map[a.qid] = ruleChoiceDiag(q, chosen, q.answer);
  });
  // 再尝试 AI 归因覆盖（仅在 AI 给出合法 E1-E9 时覆盖规则兜底）
  const model = aiModel(app);
  try {
    const r = await generateWithRetry(model, {
      model: 'hy3',
      messages: [{ role: 'system', content: CHOICE_DIAGNOSE_SYSTEM },
                { role: 'user', content: block + '\n\n请输出归因 JSON。' }]
    });
    const obj = extractJson((r && r.text) || '');
    if (obj && Array.isArray(obj.items)) {
      obj.items.forEach(it => {
        const q = qById[it.qid];
        if (!q) return;
        const d = it.diagnosis && typeof it.diagnosis === 'object' ? it.diagnosis : {};
        if (/^E[1-9]$/.test(d.errorType || '')) {
          const fb = map[it.qid] || ruleChoiceDiag(q, '', q.answer);
          map[it.qid] = {
            errorType: d.errorType,
            errorDesc: sanitizeBanned(str(d.errorDesc, 200)) || fb.errorDesc,
            suggestion: sanitizeBanned(str(d.suggestion, 200)) || fb.suggestion
          };
        }
      });
    }
  } catch (e) { /* AI 失败：保留规则兜底，不返回 {}，不阻塞批改 */ }
  return map;
}

/* ---------------- 手写图代传（base64 → 云存储 fileID） ---------------- */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;   // 单图上限 2MB，防滥用
/** 解析 data URL / 裸 base64 → Buffer；非法或超限返回 null */
function decodeImageBase64(v) {
  if (!v || typeof v !== 'string') return null;
  let s = v.trim();
  const m = /^data:image\/[a-z]+;base64,/.exec(s);
  if (m) s = s.slice(m[0].length);
  s = s.replace(/\s/g, '');
  if (s.length < 16) return null;
  let buf = null;
  try { buf = Buffer.from(s, 'base64'); } catch (e) { return null; }
  if (!buf || !buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  return buf;
}

/**
 * 把 answers[].imageBase64 落云存储，转成 imageRefs[fileID]。
 * 始终删除 imageBase64 字段 —— 提交记录里绝不留 base64 正文（体积）。
 * 小程序端本来就传 fileID，此处对其无副作用。
 */
async function uploadBase64Images(app, answers) {
  const stat = { uploaded: 0, skipped: 0 };
  for (const a of answers) {
    if (!a || !a.imageBase64) continue;
    const buf = decodeImageBase64(a.imageBase64);
    delete a.imageBase64;
    if (!buf) { stat.skipped++; continue; }
    try {
      const cloudPath = 'exam_handwriting/' + nowMs() + '_' + Math.random().toString(36).slice(2, 8) + '.png';
      const r = await app.uploadFile({ cloudPath: cloudPath, fileContent: buf });
      const fid = (r && (r.fileID || r.fileId)) || '';
      if (fid) { a.imageRefs = (a.imageRefs || []).concat([fid]); stat.uploaded++; }
      else stat.skipped++;
    } catch (e) { stat.skipped++; }
  }
  return stat;
}

async function gradeExam(app, input, openid) {
  const examClientId = str(input.examClientId, 80);
  if (!examClientId) return { ok: false, code: 'no_exam', msg: '缺少试卷标识' };
  // 取试卷（含题目与参考答案）
  let examDoc = null;
  try {
    const res = await app.database().collection(EXAM_COLL).where({ openid: openid, clientId: examClientId }).limit(1).get();
    examDoc = (res && res.data && res.data[0]) || null;
  } catch (e) {}
  if (!examDoc) {
    // 兜底：按 _id 查（兼容旧数据）
    try {
      const res2 = await app.database().collection(EXAM_COLL).doc(examClientId).get();
      examDoc = (res2 && res2.data) || null;
    } catch (e2) {}
  }
  if (!examDoc) return { ok: false, code: 'exam_not_found', msg: '未找到该测验卷' };
  /* 兜底路径是「按 _id 直查」，**不带 openid 条件** —— 任何人拿到他人文档的 _id 就能
   * 读出题干与参考答案（IDOR）。所以取到之后必须补验归属。
   * （正常路径 where({openid, clientId}) 已经带过滤，只有老数据才走兜底。） */
  if (examDoc.openid && examDoc.openid !== openid) {
    return { ok: false, code: 'forbidden', msg: '无权访问该测验卷' };
  }
  const exam = {
    clientId: examDoc.clientId, name: examDoc.name, subject: examDoc.subject, subjectName: examDoc.subjectName,
    questions: Array.isArray(examDoc.questions) ? examDoc.questions : []
  };
  if (!exam.questions.length) return { ok: false, code: 'no_questions', msg: '该卷无结构化题目，无法批改' };

  const answers = Array.isArray(input.answers) ? input.answers.slice(0, 50) : [];
  const route = input.route === 'vision' ? 'vision' : 'text';

  // 手写图：iPad 端受 HTTP 体积限制无法直传云存储，改由本函数代传 base64 → 云存储拿 fileID，
  // 随后复用既有视觉批改路线（小程序端仍走 imageRefs 直传，不受影响）。
  const imgStat = await uploadBase64Images(app, answers);

  const qById = {};
  exam.questions.forEach(q => { qById[q.id] = q; });

  // choice 本地判定
  const resultMap = {};
  answers.forEach(a => {
    const q = qById[a.qid];
    if (q && q.type === 'choice') resultMap[a.qid] = judgeChoice(q, a);
  });

  // 非 choice 文本题
  try {
    const textMap = await gradeByText(app, exam, answers);
    Object.keys(textMap).forEach(k => { if (!resultMap[k]) resultMap[k] = textMap[k]; });
  } catch (e) {
    if (e && e.code === 'no_pack') return { ok: false, code: 'no_pack', msg: e.msg };
    return { ok: false, code: e.code || 'grade_error', msg: e.msg || '批改失败' };
  }

  // 含图片（draw/手写）→ 视觉路线（若配置），否则降级提示
  const imageAnswers = answers.filter(a => {
    const q = qById[a.qid];
    return q && (q.type === 'draw' || a.imageRefs && a.imageRefs.length);
  });
  if (imageAnswers.length) {
    let visionCfg = null;
    try {
      const doc = await readVisionConfigDoc(app, openid);
      visionCfg = resolveActiveVision(doc);
    } catch (e) {}
    if (visionCfg && visionCfg.key) {
      // 汇总所有图片 URL
      const fileIds = [];
      imageAnswers.forEach(a => { (a.imageRefs || []).forEach(f => fileIds.push(f)); });
      const urls = await getFileUrls(app, fileIds);
      if (urls.length) {
        try {
          const visMap = await gradeByVision(app, visionCfg, exam, imageAnswers, urls);
          Object.keys(visMap).forEach(k => { resultMap[k] = visMap[k]; });
        } catch (e) {
          if (e && e.code === 'no_pack') return { ok: false, code: 'no_pack', msg: e.msg };
          // 视觉失败不阻塞：标记需人工复核
          imageAnswers.forEach(a => { if (!resultMap[a.qid]) resultMap[a.qid] = { qid: a.qid, correct: false, score: 0, ocrText: '', diagnosis: { errorType: '', errorDesc: '视觉批改失败（' + (e.msg || '') + '），需人工复核', suggestion: '请人工核对' } }; });
        }
      }
    } else {
      // 未配置视觉模型：标记需人工复核（诚实降级，不伪判）
      imageAnswers.forEach(a => { if (!resultMap[a.qid]) resultMap[a.qid] = { qid: a.qid, correct: false, score: 0, ocrText: '', diagnosis: { errorType: '', errorDesc: '含手写/图，未配置视觉模型，需人工复核或转文字作答', suggestion: '在设置中配置视觉模型，或改用文本作答' } }; });
    }
  }

  // 选择题错因归类：本地已判定对错，这里对判错的选项补 AI 的 E1-E9 归因
  // （非选择题的错因已由 gradeByText / gradeByVision 给出，无需再处理）
  try {
    const wrongChoiceAnswers = answers.filter(a => {
      const q = qById[a.qid];
      const res = resultMap[a.qid];
      return q && q.type === 'choice' && res && !res.correct && (a.text || '').trim();
    });
    if (wrongChoiceAnswers.length) {
      const choiceDiag = await diagnoseWrongChoices(app, exam, wrongChoiceAnswers);
      for (const qid of Object.keys(choiceDiag)) {
        const r = resultMap[qid];
        if (!r) continue;
        const d = choiceDiag[qid];
        const prev = r.diagnosis || {};
        r.diagnosis = {
          errorType: d.errorType || prev.errorType || '',
          errorDesc: d.errorDesc || prev.errorDesc || '选择题选项与正确答案不符',
          suggestion: d.suggestion || prev.suggestion || '对照选项再确认'
        };
      }
    }
  } catch (e) { /* 归因失败不阻塞批改，保留 judgeChoice 的通用描述 */ }

  // 缺答题目标记
  exam.questions.forEach(q => { if (!resultMap[q.id]) resultMap[q.id] = { qid: q.id, correct: false, score: 0, ocrText: '', diagnosis: { errorType: '', errorDesc: '未作答', suggestion: '补做本题' } }; });

  // 汇总 + 总评
  const results = exam.questions.map(q => resultMap[q.id]);
  const totalPoints = exam.questions.reduce((s, q) => s + (q.points || 0), 0);
  const gotPoints = results.reduce((s, r) => s + (r.score || 0), 0);
  const correctCount = results.filter(r => r.correct).length;
  const wrong = results.filter(r => !r.correct);
  const summary = {
    total: exam.questions.length, correctCount: correctCount,
    totalPoints: totalPoints, gotPoints: gotPoints,
    rate: exam.questions.length ? Math.round(correctCount / exam.questions.length * 100) : 0,
    strengths: [],
    weaknesses: wrong.slice(0, 6).map(r => {
      const q = qById[r.qid];
      return (q && q.kp ? q.kp : ('题' + r.qid)) + (r.diagnosis && r.diagnosis.errorType ? '（' + r.diagnosis.errorType + '）' : '');
    }),
    advice: '针对薄弱点（' + (wrong[0] && qById[wrong[0].qid] && qById[wrong[0].qid].kp || '相关知识点') + '）加强练习，错了的题建议进入错题本订正。'
  };

  // 落库：提交记录
  const scope = await resolveChildScope(app, openid);
  const subDoc = {
    openid: openid,
    // 归属孩子由服务端解析（独立 iPad 账号为空串，不猜）
    childId: scope.childId,
    clientId: str(input.submissionClientId, 60) || ('sub_' + nowMs() + '_' + Math.random().toString(36).slice(2, 8)),
    examClientId: exam.clientId, examName: exam.name || '', subject: exam.subject || '', subjectName: exam.subjectName || '',
    route: route,
    answers: answers.map(a => Object.assign({}, a, resultMap[a.qid] ? { diagnosis: resultMap[a.qid].diagnosis } : {})),
    results: results,
    summary: summary,
    createdAt: nowMs(), status: 'graded'
  };
  // 主批改链路：提交记录落库失败必须报错（旧写法末尾 catch(e3){} 空吞，会造成
  // 「返回 ok:true 带完整报告，但 listSubmissions 里永远找不到它」的假成功）。
  const subRes = await addOnce(app, SUB_COLL, subDoc, { openid: openid, clientId: subDoc.clientId });
  if (!subRes.ok) return { ok: false, code: 'db_error', msg: '提交记录保存失败：' + subRes.err };

  // 回流错题本（判错题 → tutor_mistakes，source='exam'）
  let mistakesAdded = 0;
  for (const r of wrong) {
    // 未作答不进错题库：避免把「没做」当成「错题」污染错题本（仅在批改报告中标记，不回流）
    if (r.diagnosis && (r.diagnosis.errorDesc || '') === '未作答') continue;
    if (r.diagnosis && /^E[1-9]$/.test(r.diagnosis.errorType || '') === false && !r.diagnosis.errorDesc) continue;
    const q = qById[r.qid];
    /* 错题回流是「尽力而为」的旁路（失败不该打断批改结果返回），但**不能空吞**：
     * 旧写法末尾 catch(e4){} 什么都不做，错题静默丢失且端上的 mistakesAdded 计数
     * 与实际落库条数可能不符。现在改用 addOnce，失败只跳过这一条、不计入计数。 */
    const mkDoc = {
      openid: openid,
      childId: subDoc.childId,
      clientId: ('mk_' + exam.clientId + '_' + r.qid),
      subject: exam.subject || '', subjectName: exam.subjectName || '',
      topic: (q && q.kp) || (exam.name || ''),
      errorType: (r.diagnosis && r.diagnosis.errorType) || '',
      errorDesc: (r.diagnosis && r.diagnosis.errorDesc) || '测验卷作答错误',
      suggestion: (r.diagnosis && r.diagnosis.suggestion) || '',
      status: 'pending', source: 'exam',
      questionText: (q && q.stem) || '', childAnswer: (r.ocrText || ''), markSource: 'ai',
      createdAt: nowMs()
    };
    const mkRes = await addOnce(app, MISTAKE_COLL, mkDoc, { openid: openid, clientId: mkDoc.clientId });
    if (mkRes.ok) mistakesAdded++;
  }

  const out = Object.assign({}, subDoc);
  delete out._id;
  return {
    ok: true, submission: out, mistakesAdded: mistakesAdded,
    imagesUploaded: imgStat.uploaded, imagesSkipped: imgStat.skipped
  };
}

/* ---------------- 试卷 / 提交 CRUD ---------------- */
async function saveExam(app, input, openid) {
  const doc = input.exam || {};
  const clientId = str(doc.clientId, 60);
  if (!clientId) return { ok: false, code: 'no_id', msg: '缺少试卷 clientId' };
  // 归属孩子：新建时由服务端解析结果盖章；更新时只采纳**显式**给出的归属，
  // 不拿「当前孩子」去猜历史卷的归属（否则最后编辑的人会把全家共用卷抢到自己名下）。
  const reqChild = str(doc.childId, 64);
  const scopeOf = await resolveChildScope(app, openid, reqChild);
  const rec = {
    openid: openid, clientId: clientId,
    name: sanitizeBanned(str(doc.name, 80)) || '未命名测验卷',
    subject: str(doc.subject, 20), subjectName: SUBJECT_NAMES[doc.subject] || str(doc.subjectName, 20) || '',
    grade: str(doc.grade, 20), examType: EXAM_TYPE_LABEL[doc.examType] ? doc.examType : 'unit_test',
    knowledgePoints: Array.isArray(doc.knowledgePoints) ? doc.knowledgePoints.map(k => str(k, 40)).slice(0, 20) : [],
    suggestedDuration: Math.max(1, Number(doc.suggestedDuration) || 30),
    questions: Array.isArray(doc.questions) ? doc.questions.map((q, i) => {
      const rec = {
        id: str(q.id, 30) || ('q' + (i + 1)), type: ['choice', 'fill', 'calc', 'essay', 'draw'].indexOf(q.type) >= 0 ? q.type : 'fill',
        stem: sanitizeBanned(str(q.stem, 400)), options: Array.isArray(q.options) ? q.options.map(o => cleanChoiceOption(o)).filter(Boolean).slice(0, 4) : [],
        answer: (q.type === 'choice') ? choiceAnswerLetter(q.answer) : sanitizeBanned(str(q.answer, 300)), points: Math.max(0, Number(q.points) || 0),
        kp: str(q.kp, 60), difficulty: Math.min(3, Math.max(1, Number(q.difficulty) || 1))
      };
      const fig = normFigure(q.figure);
      if (fig) rec.figure = fig;
      return rec;
    }) : [],
    markdown: str(doc.markdown, 20000), rawText: str(doc.rawText, 20000), answers: sanitizeBanned(str(doc.answers, 4000)),
    origin: ['ai', 'manual', 'upload', 'workbench', 'pdf_write'].indexOf(doc.origin) >= 0 ? doc.origin : 'manual',
    status: doc.status === 'draft' ? 'draft' : 'published',
    createdBy: str(doc.createdBy, 10) || 'mini', updatedAt: nowMs()
  };
  // 原卷页面图（上传试卷时才有）：只增不覆盖 —— 未传时保留云端已有值
  if (Array.isArray(doc.pageRefs)) {
    rec.pageRefs = doc.pageRefs.map(x => str(x, 200)).filter(Boolean).slice(0, 30);
  }
  /* 改动（2026-10-27）：与 saveTextbook 同一类 bug —— 旧写法把「查询 + update/add」
   * 一起包进 try，catch 里 `createCollection + add(rec)` **不看 exist**，于是 update 一旦
   * 失败就会再插一条同 clientId 的试卷（get/delete 都 limit(1)，旧的那条成孤儿）。
   * 现在：集合预检提前、查询与写入分段、update 失败只报错，新建分支带查重。 */
  await ensureCollection(app, EXAM_COLL);
  let exist = null;
  try {
    const res = await app.database().collection(EXAM_COLL).where({ openid: openid, clientId: clientId }).limit(1).get();
    exist = (res && res.data && res.data[0]) || null;
  } catch (e) { return { ok: false, code: 'db_error', msg: '读取试卷失败：' + ((e && e.message) || e) }; }
  try {
    if (exist) {
      // 更新：只采纳显式归属；不传就把历史卷保持「无归属」（不拿当前孩子去猜）
      if (reqChild && scopeOf.childId) rec.childId = scopeOf.childId;
      if (!rec.createdAt) rec.createdAt = exist.createdAt || nowMs();
      await app.database().collection(EXAM_COLL).doc(exist._id).update(rec);
    } else {
      if (scopeOf.childId) rec.childId = scopeOf.childId;
      rec.createdAt = nowMs();
      const addRes = await addOnce(app, EXAM_COLL, rec, { openid: openid, clientId: clientId });
      if (!addRes.ok) return { ok: false, code: 'db_error', msg: '试卷保存失败：' + addRes.err };
    }
  } catch (e) { return { ok: false, code: 'db_error', msg: '试卷保存失败：' + ((e && e.message) || e) }; }
  const out = Object.assign({}, rec); out.resourceId = clientId;
  return { ok: true, exam: out };
}

async function listExams(app, openid, subject, requestedChildId) {
  const where = { openid: openid };
  if (subject) where.subject = subject;
  let docs = [];
  try {
    const res = await app.database().collection(EXAM_COLL).where(where).orderBy('createdAt', 'desc').limit(100).get();
    docs = (res && res.data) || [];
  } catch (e) { docs = []; }
  /* 孩子维度：切孩子即切视图。
   *   · 能解析出当前孩子 → 只留该孩子的卷 + 历史卷（childId 为空，无法事后判定归属，不猜也不藏）；
   *   · 端上给的 childId 跨家庭/非法 → **回落当前孩子**再过滤（否则一个坏参数就把过滤整个关掉）；
   *   · 解析不出（iPad 独立账号 / 尚无档案）→ 返回全部，行为与改造前一致。 */
  let scopeOf = await resolveChildScope(app, openid, requestedChildId);
  if (!scopeOf.childId && requestedChildId) scopeOf = await resolveChildScope(app, openid, '');
  if (scopeOf.childId) docs = docs.filter(d => !d.childId || d.childId === scopeOf.childId);
  const list = docs.map(d => ({
    id: d.clientId || d._id, resourceId: d.clientId || d._id, name: d.name, subject: d.subject,
    pageCount: Array.isArray(d.pageRefs) ? d.pageRefs.length : 0,
    subjectName: d.subjectName, level: d.grade, examType: d.examType, examTypeLabel: EXAM_TYPE_LABEL[d.examType] || d.examType,
    knowledgePoints: d.knowledgePoints || [], suggestedDuration: d.suggestedDuration, origin: d.origin, status: d.status,
    markdownLength: (d.markdown || '').length, hasAnswers: !!(d.answers || '').length, qCount: (d.questions || []).length,
    updatedAt: d.updatedAt || d.createdAt
  }));
  return { ok: true, exams: list };
}

async function getExam(app, openid, resourceId) {
  if (!resourceId) return { ok: false, code: 'no_id', msg: '缺少试卷标识' };
  let doc = null;
  try {
    const res = await app.database().collection(EXAM_COLL).where({ openid: openid, clientId: resourceId }).limit(1).get();
    doc = (res && res.data && res.data[0]) || null;
  } catch (e) {}
  if (!doc) return { ok: false, code: 'not_found', msg: '未找到该测验卷' };
  const out = Object.assign({}, doc); delete out._id; out.resourceId = out.clientId || resourceId;
  return { ok: true, exam: out };
}

/* ---------------- 读 hw_farm_user 切片（学习计划 / 单元必会库 / 卡片 / 错题） ----------------
 * iPad 端只走本云函数，无法直接读小程序 tutorStore；这里按 openid 读取 hw_farm_user 文档，
 * 定位当前学习者后返回切片。独立账号（openid='ipad_xxx'）无此文档 → 返回空切片。
 * 云端铁律：字段全在 data.users[i]，顶层唯 coop 例外；一律 users.find(id===currentUserId)||users[0]。
 */
async function readFarmUser(app, openid) {
  if (!openid) return null;
  try {
    const res = await app.database().collection('hw_farm_user').where({ _openid: openid }).limit(1).get();
    const doc = (res && res.data && res.data[0]) || null;
    if (!doc) return null;
    const root = doc.data || {};
    const users = Array.isArray(root.users) ? root.users : [];
    const cid = root.currentUserId;
    return users.find(u => u && u.id === cid) || users[0] || null;
  } catch (e) { return null; }
}

/* 复习卡真源：tutor_cards 集合（tutorSync push 写入）。
 * ⚠️ 同 unitKps 历史 bug：曾读 hw_farm_user.users[i].cards（死路），改读真源集合。 */
async function readCards(app, openid) {
  if (!openid) return [];
  try {
    const res = await app.database().collection('tutor_cards')
      .where({ openid: openid })
      .limit(500)
      .get();
    return (res && res.data) || [];
  } catch (e) {
    return [];   // 集合不存在/查询失败 → 空，不阻塞
  }
}

/* 单元卡片列表（复习卡）：Leitner 盒子 + 到期时间 */
async function listCards(app, openid) {
  const cards = await readCards(app, openid);
  const list = cards.map(c => ({
    id: c.clientId || c._id || '',
    subject: c.subject || '',
    subjectName: c.subjectName || '',
    topic: c.topic || '',
    front: c.front || '',
    back: c.back || '',
    unitId: c.unitId || '',
    kpId: (c.kpId == null) ? null : c.kpId,
    box: Number(c.box) || 1,
    dueAt: Number(c.dueAt) || 0,
    done: !!c.done
  }));
  return { ok: true, cards: list };
}

/* 单元必会库真源：tutor_unit_kps 集合（tutorSync push 写入）。
 * ⚠️ 历史 bug：此处曾读 hw_farm_user.users[i].unitKps，但全仓库无任何代码往那写
 * unitKps，导致 iPad 端 listUnits/getUnitKps 永远空。改读真源集合。 */
async function readUnitKps(app, openid) {
  if (!openid) return [];
  try {
    const res = await app.database().collection('tutor_unit_kps')
      .where({ openid: openid })
      .orderBy('updatedAt', 'desc')
      .limit(200)
      .get();
    return (res && res.data) || [];
  } catch (e) {
    return [];   // 集合不存在/查询失败 → 空，不阻塞
  }
}

/* 单元必会库列表（即「单元」清单）：来自 tutor_unit_kps 集合 */
async function listUnits(app, openid) {
  const units = await readUnitKps(app, openid);
  const list = units.map(x => ({
    id: x.clientId || x._id || '',
    subject: x.subject || '',
    subjectName: x.subjectName || (SUBJECT_NAMES[x.subject] || ''),
    grade: x.grade || '',
    title: x.title || '',
    pointCount: Array.isArray(x.points) ? x.points.length : 0,
    updatedAt: Number(x.updatedAt) || 0
  }));
  return { ok: true, units: list };
}

/* 单个单元必会库的必会点（每单元具体学习内容） */
async function getUnitKps(app, openid, unitId) {
  const units = await readUnitKps(app, openid);
  const x = units.find(y => (y.clientId || y._id || '') === unitId) || null;
  if (!x) return { ok: false, code: 'not_found', msg: '未找到该单元必会库' };
  return { ok: true, unit: {
    id: x.clientId || x._id || '', subject: x.subject, subjectName: x.subjectName || (SUBJECT_NAMES[x.subject] || ''),
    grade: x.grade || '', title: x.title || '',
    points: Array.isArray(x.points) ? x.points.map(p => ({
      id: String(p.id || ''), topic: String(p.topic || ''),
      front: String(p.front || ''), back: String(p.back || ''),
      order: Number(p.order) || 0,
      type: String(p.type || ''),
      prereqs: Array.isArray(p.prereqs) ? p.prereqs : [],
      evidence: Array.isArray(p.evidence) ? p.evidence : [],
      assessmentPrompt: String(p.assessmentPrompt || '')
    })) : []
  } };
}

/* 学习计划列表：来自 users[i].studyPlans（字段随小程序演进，按需扩展） */
async function listPlans(app, openid) {
  const u = await readFarmUser(app, openid);
  const plans = (u && Array.isArray(u.studyPlans)) ? u.studyPlans : [];
  const list = plans.map(p => ({
    id: p.id || '',
    name: p.name || '',
    subject: p.subject || '',
    subjectName: p.subjectName || (SUBJECT_NAMES[p.subject] || ''),
    grade: p.grade || '',
    units: Array.isArray(p.units) ? p.units.length : 0,
    updatedAt: Number(p.updatedAt) || 0
  }));
  return { ok: true, plans: list };
}

/* ---------------- 单元复习：按单元必会点出同类题（action='genUnitReview'） ----------------
 * 读 hw_farm_user 中该单元的必会点（getUnitKps），把 topics 注入出题 prompt，
 * 复用 GEN_SYSTEM/parseExam 出卷，exam 标 origin:'unit_review' + unitId + kpTopics，
 * 批改时错题自然写入 tutor_mistakes（与考卷中心同一条路）。 */
async function genUnitReview(app, input, openid) {
  const subject = str(input.subject, 20);
  const unitId = str(input.unitId, 60);
  const grade = str(input.grade, 20);
  if (!SUBJECT_NAMES[subject]) return { ok: false, code: 'bad_subject', msg: '暂不支持该学科的复习测验' };
  if (!unitId) return { ok: false, code: 'no_unit', msg: '缺少单元标识' };

  const unitRes = await getUnitKps(app, openid, unitId);
  const unit = (unitRes && unitRes.ok && unitRes.unit) || null;
  const unitName = (unit && unit.title) || '单元';
  const points = (unit && Array.isArray(unit.points)) ? unit.points : [];
  const topics = points.map(p => String((p && p.topic) || '').trim()).filter(Boolean);
  const topicHint = topics.length
    ? '本单元必会点（出题严格围绕这些点，不超出）：\n' + topics.map(t => '- ' + t).join('\n')
    : '（该单元暂无结构化必会点，请围绕单元标题「' + unitName + '」覆盖核心知识点出题）';

  // Path A：读复习卡毕业态，算该单元「前置欠账」盲区 + 按学科给题型约束
  const cards = await readCards(app, openid);
  const blindSpotHint = buildBlindSpotHint(points, cards);
  // 题型库优先（真实题型模板）→ 客户端指定配比 → 学科兜底
  const typeHint = buildTypeMixBlock(subject, grade, input.questionTypes) ||
    buildTypeLibBlock(subject, grade) ||
    unitTypeHint(subject, unitName, topics);

  const model = aiModel(app);
  // 客户端指定配比时题量以配比合计为准（避免「题量10 / 配比共6」自相矛盾）
  const mixList = normTypeMix(subject, grade, input.questionTypes);
  const mixTotal = mixList.reduce((s, t) => s + t.count, 0);
  const count = mixTotal > 0
    ? Math.min(mixTotal, 20)
    : Math.min(Math.max(parseInt(input.count, 10) || 8, 3), 20);
  const userMsg =
    '学科：' + SUBJECT_NAMES[subject] + '\n' +
    (grade ? '年级：' + grade + '\n' : '') +
    '单元：' + unitName + '\n' +
    '题量：' + count + '\n' +
    '卷型：unit_test（单元复习测验）\n' +
    '卷名须含单元名「' + unitName + '」\n\n' +
    topicHint + '\n\n' +
    (blindSpotHint ? blindSpotHint + '\n\n' : '') +
    '题型约束：' + typeHint + '\n' +
    '要求：按必会点覆盖出题，确保每道小题对应至少一个必会点（在 questions[].kp 写明对应必会点文字）；' +
    '不出超纲题；难度贴合年级；答案与解析逐题给出。请输出结构化 JSON。';

  let text = '';
  try {
    const r = await generateWithRetry(model, {
      model: 'hy3',
      messages: [
        { role: 'system', content: GEN_SYSTEM },
        { role: 'user', content: userMsg }
      ]
    });
    text = (r && r.text) || '';
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (isNoPackError(e)) {
      return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
    }
    if (isTimeoutErr(e)) {
      return { ok: false, code: 'gen_timeout', msg: '出卷超时（题量偏大或模型繁忙），请减少题量或稍后重试' };
    }
    return { ok: false, code: 'gen_error', msg: '出卷失败：' + msg };
  }
  const parsed = parseExam(text);
  if (!parsed) return { ok: false, code: 'parse_error', msg: '出卷结果解析失败，请重试' };

  const doc = {
    openid: openid,
    clientId: str(input.clientId, 60) || ('urev_' + nowMs() + '_' + Math.random().toString(36).slice(2, 8)),
    name: parsed.name, subject: subject, subjectName: SUBJECT_NAMES[subject],
    grade: grade, examType: 'unit_test',
    knowledgePoints: parsed.knowledgePoints, suggestedDuration: parsed.suggestedDuration,
    questions: parsed.questions, markdown: '', rawText: '', answers: parsed.answersMarkdown,
    origin: 'unit_review', unitId: unitId, kpTopics: topics,
    status: 'published', createdBy: str(input.createdBy, 10) || 'ipad',
    createdAt: nowMs(), updatedAt: nowMs()
  };
  try {
    await app.database().collection(EXAM_COLL).add(doc);
  } catch (e) {
    try { await app.database().createCollection(EXAM_COLL); } catch (e2) {}
    // 重试前必须查重：网络抖动/超时场景下服务端可能已写成功，无脑再 add 就是重复落库
    try {
      const dup = await app.database().collection(EXAM_COLL).where({ openid: openid, clientId: doc.clientId }).limit(1).get();
      if (dup && dup.data && dup.data.length) return { ok: true, exam: Object.assign({}, doc, { resourceId: doc.clientId }) };
    } catch (e4) {}
    try { await app.database().collection(EXAM_COLL).add(doc); } catch (e3) { return { ok: false, code: 'db_error', msg: '试卷保存失败：' + ((e3 && e3.message) || e3) }; }
  }
  const out = Object.assign({}, doc);
  delete out._id;
  out.resourceId = out.clientId;
  return { ok: true, exam: out };
}

/* ---------------- 单元复习错题回顾（action='listMistakes'） ----------------
 * 读 tutor_mistakes，按 openid + 学科 + 单元必会点 topics 过滤；activeOnly 默认只看未掌握。
 * 单元复习「错题回顾」与「掌握度」都从这份数据派生。 */
async function listMistakes(app, openid, opts) {
  const subject = str(opts.subject, 20);
  const topics = Array.isArray(opts.topics) ? opts.topics.map(t => String(t).trim()).filter(Boolean) : [];
  const activeOnly = opts.activeOnly !== false;
  try {
    const cond = { openid: openid };
    if (subject) cond.subject = subject;
    const res = await app.database().collection(MISTAKE_COLL).where(cond).limit(200).get();
    let list = (res && res.data) || [];
    if (topics.length) {
      const set = new Set(topics);
      list = list.filter(m => set.has(String((m.topic || '').trim())));
    }
    if (activeOnly) {
      list = list.filter(m => !['resolved', 'graduated', 'done'].includes(String(m.status || '').toLowerCase()));
    }
    const out = list.map(m => ({
      id: m.clientId || (m._id || ''),
      subject: m.subject || '',
      subjectName: m.subjectName || '',
      topic: m.topic || '',
      errorType: m.errorType || '',
      errorDesc: m.errorDesc || '',
      suggestion: m.suggestion || '',
      questionText: m.questionText || '',
      status: m.status || '',
      source: m.source || '',
      markSource: m.markSource || '',
      createdAt: Number(m.createdAt) || 0
    }));
    return { ok: true, mistakes: out };
  } catch (e) {
    return { ok: false, code: 'db_error', msg: '读取错题失败' };
  }
}

/* ---------------- 教材库：normalizeTextbook 防御性规范化 ----------------
 * 输入（客户端上传/搜索保留/种子导入）→ 干净结构化教材；坏结构/超长/空 units 一律拒绝。
 * 边界（设计文档第三节）：title ≤ 60、units ≤ 30、unit.name ≤ 40、
 * keywords ≤ 8 条/单元（每条 ≤ 30 字）、sections ≤ 20 条/单元（每条 ≤ 60 字）、rawText ≤ 20000 字。
 * 纯函数：不读时钟、不产随机数（textbookId 由 saveTextbook 补），便于 EXAM_TEST 单测。 */
function normalizeTextbook(raw) {
  const src = raw || {};
  const subject = str(src.subject, 20);
  if (!SUBJECT_NAMES[subject]) return { ok: false, code: 'bad_subject', msg: '请选择受支持的学科' };
  const title = str(src.title, 60);
  if (!title) return { ok: false, code: 'no_title', msg: '教材名称不能为空' };
  if (!Array.isArray(src.units) || !src.units.length) return { ok: false, code: 'no_units', msg: '至少需要一个单元' };
  if (src.units.length > 30) return { ok: false, code: 'too_many_units', msg: '单元数量超过上限（30）' };
  const units = [];
  for (let i = 0; i < src.units.length; i++) {
    const u = src.units[i] || {};
    const name = str(u.name, 40);
    if (!name) return { ok: false, code: 'bad_unit', msg: '第 ' + (i + 1) + ' 个单元名称为空' };
    const keywords = Array.isArray(u.keywords) ? u.keywords.map(k => str(k, 30)).filter(Boolean).slice(0, 8) : [];
    const sections = Array.isArray(u.sections) ? u.sections.map(s => str(s, 60)).filter(Boolean).slice(0, 20) : [];
    const lessons = str(u.lessons, 200);
    const rec = { order: i + 1, name: name };
    if (keywords.length) rec.keywords = keywords;
    if (sections.length) rec.sections = sections;
    if (lessons) rec.lessons = lessons;
    units.push(rec);
  }
  return { ok: true, textbook: {
    textbookId: str(src.textbookId, 60),
    title: title,
    subject: subject,
    subjectName: SUBJECT_NAMES[subject],
    grade: str(src.grade, 10),
    term: str(src.term, 10),
    version: str(src.version, 20),
    source: ['upload', 'search', 'seed', 'manual'].indexOf(src.source) >= 0 ? src.source : 'manual',
    sourceUrl: str(src.sourceUrl, 300),
    sourcePlatform: str(src.sourcePlatform, 60),
    rawText: str(src.rawText, 20000),
    units: units
  } };
}

/* ---------------- 教材库（textbook_library） ----------------
 * 隔离规则：openid==='' 为官方种子库（全员可见）；其余记录仅本人可见。
 * 写/删强制校验归属（where 带 openid，防越权改他人教材）。
 * 容量边界与 normalizeTextbook 一致；集合不存在时 createCollection 兜底后重试一次。 */
async function listTextbooks(app, openid, opts) {
  const subject = str(opts.subject, 20);
  const grade = str(opts.grade, 10);
  const term = str(opts.term, 10);
  async function q(baseCond) {
    const cond = Object.assign({}, baseCond);
    if (subject) cond.subject = subject;
    if (grade) cond.grade = grade;
    if (term) cond.term = term;
    const run = () => app.database().collection(TEXTBOOK_COLL).where(cond).orderBy('updatedAt', 'desc').limit(200).get();
    try {
      const res = await run();
      return (res && res.data) || [];
    } catch (e) {
      try { await app.database().createCollection(TEXTBOOK_COLL); } catch (e2) {}
      try {
        const res = await run();
        return (res && res.data) || [];
      } catch (e3) { return null; }
    }
  }
  const official = await q({ openid: '' });
  if (official === null) return { ok: false, code: 'db_error', msg: '读取教材库失败' };
  const mine = openid ? await q({ openid: openid }) : [];
  if (mine === null) return { ok: false, code: 'db_error', msg: '读取教材库失败' };
  const brief = d => ({
    textbookId: d.textbookId || d._id,
    title: d.title || '', subject: d.subject || '', subjectName: d.subjectName || (SUBJECT_NAMES[d.subject] || ''),
    grade: d.grade || '', term: d.term || '', version: d.version || '',
    source: d.source || '', sourcePlatform: d.sourcePlatform || '',
    unitCount: Array.isArray(d.units) ? d.units.length : 0,
    updatedAt: Number(d.updatedAt) || 0
  });
  return { ok: true, official: official.map(brief), mine: mine.map(brief) };
}

/** 取单本教材全文（含 units）：官方库或本人库可读，他人库拒绝 */
async function getTextbook(app, openid, textbookId) {
  if (!textbookId) return { ok: false, code: 'no_id', msg: '缺少教材标识' };
  let doc = null;
  try {
    const res = await app.database().collection(TEXTBOOK_COLL).where({ textbookId: textbookId }).limit(1).get();
    doc = (res && res.data && res.data[0]) || null;
  } catch (e) {}
  if (!doc) return { ok: false, code: 'not_found', msg: '未找到该教材' };
  if (doc.openid !== '' && doc.openid !== openid) return { ok: false, code: 'forbidden', msg: '无权访问该教材' };
  const out = Object.assign({}, doc); delete out._id;
  return { ok: true, textbook: out };
}

/** 保存（upsert）：有 textbookId 且属于本人 → 更新；否则新建（textbookId 服务端生成） */
async function saveTextbook(app, input, openid) {
  const n = normalizeTextbook((input && input.textbook) || {});
  if (!n.ok) return n;
  const rec = n.textbook;
  rec.openid = openid;   // 服务端写入不自动注入 openid，必须显式写（与 saveExam 同）
  const now = nowMs();
  /* 改动（2026-10-27）：不再把「查询 + 写」一起包进 try 再在 catch 里无脑 add。
   * 旧写法最危险的一点：if(exist) 分支的 update 一旦失败（抖动 / 权限 / 瞬时异常），
   * 控制流会掉进 catch 走 add —— 此时 rec.textbookId 仍是原值，于是**插入第二条
   * textbookId 完全相同的教材**。后果：getTextbook/listTextbooks 都 limit(1)，
   * 前端可能读到旧内容；deleteTextbook 只删一条，另一条成永久孤儿。
   * 现在：集合预检提前、查询与写入分段、update 失败只报错绝不退化成 add。 */
  await ensureCollection(app, TEXTBOOK_COLL);
  let exist = null;
  try {
    if (rec.textbookId) {
      const res = await app.database().collection(TEXTBOOK_COLL).where({ openid: openid, textbookId: rec.textbookId }).limit(1).get();
      exist = (res && res.data && res.data[0]) || null;
      if (!exist) {
        // textbookId 可能属于官方库或他人（textbookId 全库唯一索引）→ 撞名即换新 id，复制为自己的，绝不变他人数据
        const anyRes = await app.database().collection(TEXTBOOK_COLL).where({ textbookId: rec.textbookId }).limit(1).get();
        if (anyRes && anyRes.data && anyRes.data.length) rec.textbookId = '';
      }
    }
  } catch (e) { return { ok: false, code: 'db_error', msg: '读取教材库失败：' + ((e && e.message) || e) }; }
  try {
    if (exist) {
      rec.updatedAt = now;
      rec.createdAt = Number(exist.createdAt) || now;
      await app.database().collection(TEXTBOOK_COLL).doc(exist._id).update(rec);
    } else {
      rec.textbookId = rec.textbookId || ('tb_' + now.toString(36) + Math.random().toString(36).slice(2, 8));
      rec.createdAt = now;
      rec.updatedAt = now;
      // dedupe：并发 / 超时重试都可能让上一轮其实已写成功，命中即视为成功，不重复插入
      const addRes = await addOnce(app, TEXTBOOK_COLL, rec, { openid: openid, textbookId: rec.textbookId });
      if (!addRes.ok) return { ok: false, code: 'db_error', msg: '教材保存失败：' + addRes.err };
    }
  } catch (e) { return { ok: false, code: 'db_error', msg: '教材保存失败：' + ((e && e.message) || e) }; }
  const out = Object.assign({}, rec);
  out.openid = openid;
  return { ok: true, textbook: out };
}

/** 删除：仅本人（官方种子不可删） */
async function deleteTextbook(app, openid, textbookId) {
  if (!textbookId) return { ok: false, code: 'no_id', msg: '缺少教材标识' };
  try {
    const res = await app.database().collection(TEXTBOOK_COLL).where({ openid: openid, textbookId: textbookId }).limit(1).get();
    const doc = (res && res.data && res.data[0]) || null;
    if (!doc) return { ok: true, removed: false };
    await app.database().collection(TEXTBOOK_COLL).doc(doc._id).remove();
    return { ok: true, removed: true };
  } catch (e) { return { ok: false, code: 'db_error', msg: '删除失败' }; }
}

async function deleteExam(app, openid, resourceId) {
  if (!resourceId) return { ok: false, code: 'no_id', msg: '缺少试卷标识' };
  try {
    const res = await app.database().collection(EXAM_COLL).where({ openid: openid, clientId: resourceId }).limit(1).get();
    const doc = (res && res.data && res.data[0]);
    if (doc) await app.database().collection(EXAM_COLL).doc(doc._id).remove();
    return { ok: true, removed: !!doc };
  } catch (e) { return { ok: false, code: 'db_error', msg: '删除失败' }; }
}

async function listSubmissions(app, openid, examClientId) {
  const where = { openid: openid };
  if (examClientId) where.examClientId = examClientId;
  let docs = [];
  try {
    const res = await app.database().collection(SUB_COLL).where(where).orderBy('createdAt', 'desc').limit(100).get();
    docs = (res && res.data) || [];
  } catch (e) { docs = []; }
  /* 单孩子模型：只返回当前孩子的回收记录（历史无 childId 行保留，不猜也不藏）。
   * 解析不出孩子（iPad 独立账号 / 尚无档案）→ 返回全部，行为与改造前一致。 */
  const scopeOf = await resolveChildScope(app, openid, '');
  if (scopeOf.childId) docs = docs.filter(d => !d.childId || d.childId === scopeOf.childId);
  const list = docs.map(d => ({
    id: d.clientId || d._id, examClientId: d.examClientId, examName: d.examName, subject: d.subject, subjectName: d.subjectName,
    route: d.route, summary: d.summary || {}, createdAt: d.createdAt,
    // 历史行没有 childId：回空串表示「未归属」，不猜当前孩子
    childId: d.childId || ''
  }));
  return { ok: true, submissions: list };
}

/** 取单条提交记录（回收的试卷：含作答/批改/总评，供报告页二次查看） */
async function getSubmission(app, openid, submissionClientId) {
  if (!submissionClientId) return { ok: false, code: 'no_id', msg: '缺少提交标识' };
  let doc = null;
  try {
    const res = await app.database().collection(SUB_COLL).where({ openid: openid, clientId: submissionClientId }).limit(1).get();
    doc = (res && res.data && res.data[0]) || null;
  } catch (e) {}
  if (!doc) return { ok: false, code: 'not_found', msg: '未找到该提交记录（可能尚未上云）' };
  const out = Object.assign({}, doc); delete out._id; out.resourceId = out.clientId || submissionClientId;
  return { ok: true, submission: out };
}

/* ---------------- 同步（pull/push，exam_resources + submissions） ---------------- */
const SYNC_KINDS = ['exam_resources', 'tutor_exam_submissions'];
async function pullSync(app, openid) {
  const out = { exam_resources: [], tutor_exam_submissions: [] };
  const map = { exam_resources: EXAM_COLL, tutor_exam_submissions: SUB_COLL };
  for (const kind of SYNC_KINDS) {
    let docs = [];
    try {
      const res = await app.database().collection(map[kind]).where({ openid: openid }).orderBy('createdAt', 'desc').limit(200).get();
      docs = (res && res.data) || [];
    } catch (e) { docs = []; }
    out[kind] = docs.map(d => { const o = Object.assign({}, d); o.id = d.clientId || d._id; o.cloudId = d._id; delete o._id; return o; });
  }
  return { ok: true, exam_resources: out.exam_resources, tutor_exam_submissions: out.tutor_exam_submissions };
}
async function pushSync(app, openid, input) {
  let added = 0, skipped = 0;
  const errors = [];
  const map = { exam_resources: EXAM_COLL, tutor_exam_submissions: SUB_COLL };
  // 归属孩子只在服务端解析一次：客户端推上来的 childId 不可信（同 openid 不可信的理由）
  const scope = await resolveChildScope(app, openid);
  for (const kind of SYNC_KINDS) {
    const items = Array.isArray(input[kind]) ? input[kind].slice(0, 200) : [];
    for (const raw of items) {
      const clientId = str(raw.clientId || raw.id, 60);
      if (!clientId) continue;
      const doc = Object.assign({}, raw); doc.clientId = clientId;
      delete doc.id; delete doc.cloudId; delete doc._id;
      // ⚠️ openid 必须删：Object.assign 里 doc 是 source，留着会**覆盖**解析出的身份，
      //    等于调用方能在 raw 里塞 openid 往任意用户命名空间写数据（IDOR 写入）。
      delete doc.openid;
      // childId 同理：删掉客户端的，提交类文档用服务端解析结果覆写（空串=未归属，不猜）
      delete doc.childId;
      if (kind === 'tutor_exam_submissions') doc.childId = scope.childId;
      try {
        const exist = await app.database().collection(map[kind]).where({ openid: openid, clientId: clientId }).limit(1).get();
        if (exist && exist.data && exist.data.length) { skipped++; continue; }
      } catch (e) { /* 查重失败不阻断：集合可能还不存在，交给 addOnce 预检 */ }
      const addRes = await addOnce(app, map[kind], Object.assign({ openid: openid }, doc),
        { openid: openid, clientId: clientId });
      if (addRes.ok) added++;
      else errors.push(String(addRes.err).slice(0, 160));
    }
  }
  return { ok: true, added: added, skipped: skipped, errors: errors.length ? errors : undefined };
}

/* ---------------- 账号绑定 / 视觉模型配置 ---------------- */
/** 集合不存在时自动创建一次并重试（自愈：换环境/新库不需手工建表） */
async function ensureCollection(app, coll) {
  try {
    await app.database().collection(coll).limit(1).get();
    return true;
  } catch (e) {
    try { await app.database().createCollection(coll); return true; } catch (e2) { return false; }
  }
}

/**
 * 一次性 add —— 取代旧的「catch 里无脑 createCollection + 再 add」写法。
 *
 * 【旧写法为什么必须改】`try{ add } catch{ createCollection; try{ add } catch(e3){} }`
 *   ① 末尾 catch(e3){} **空吞**：一条都没落库，函数照样 return ok:true 带完整批改报告。
 *      家长看到结果、刷新后从 listSubmissions 里永远找不到它，全程零报错 —— 假成功。
 *   ② add 是插入不是 upsert，且不判错误类型：网络抖动 / 超时（服务端其实已写成功）
 *      也会重试一次 → 落两条同 clientId 的记录；而 get/delete 都 limit(1)，
 *      另一条永远读不到也删不掉，成孤儿。
 *
 * 【现在的做法】
 *   · 写前先用 ensureCollection 预检（集合不存在就建），**写入只做一次**；
 *   · 可选 dedupe：写前按条件查一次，已存在即视为成功（幂等），杜绝重复插入；
 *   · 失败一律返回 { ok:false, err }，由调用方决定报错还是降级 —— 绝不静默。
 *
 * @param {Object} app
 * @param {String} coll  集合名
 * @param {Object} doc   要插入的文档
 * @param {Object} [dedupe] 查重条件（如 { openid, clientId }）；不传则不查重
 * @returns {Promise<{ok:Boolean, err?:String, deduped?:Boolean}>}
 */
async function addOnce(app, coll, doc, dedupe) {
  try {
    if (dedupe) {
      const ex = await app.database().collection(coll).where(dedupe).limit(1).get();
      if (ex && ex.data && ex.data.length) return { ok: true, deduped: true };
    }
  } catch (e) { /* 查重失败不阻断：集合可能还不存在，交给下面的预检 */ }
  await ensureCollection(app, coll);
  try {
    await app.database().collection(coll).add(doc);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

async function bindAccount(app, openid, input) {
  const uid = str(input.uid, 60);
  const token = extractBindToken(str(input.token, 400));
  if (!uid || !token) return { ok: false, code: 'bad_param', msg: '缺少 uid 或 token' };
  // token = 小程序「网页看板」页生成的网页口令（webPortalBind 写入 web_portal_bindings）。
  // 与网页端共用同一套 openid 映射，不再额外维护一份 iPad 专属令牌。
  try {
    await ensureCollection(app, 'web_portal_bindings');
    const res = await app.database().collection('web_portal_bindings').where({ token: token, revoked: false }).limit(1).get();
    const t = (res && res.data && res.data[0]);
    if (!t) return { ok: false, code: 'bad_token', msg: '令牌无效或已撤销' };
    await ensureCollection(app, LINK_COLL);
    await app.database().collection(LINK_COLL).where({ uid: uid }).limit(1).get().then(r => {
      const ex = r && r.data && r.data[0];
      if (ex) return app.database().collection(LINK_COLL).doc(ex._id).update({ openid: t.openid, updatedAt: nowMs() });
      return app.database().collection(LINK_COLL).add({ uid: uid, openid: t.openid, createdAt: nowMs(), updatedAt: nowMs() });
    });
    // 记录网页令牌最近使用时间（仅审计用，不影响复用）
    try { await app.database().collection('web_portal_bindings').doc(t._id).update({ lastUsed: nowMs() }); } catch (e) {}
    return { ok: true, openid: t.openid };
  } catch (e) { return { ok: false, code: 'bind_error', msg: '绑定失败：' + ((e && e.message) || e) }; }
}

async function saveVisionConfig(app, openid, input) {
  const provider = str(input.provider, 20);
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, code: 'bad_provider', msg: '不支持的视觉模型' };
  const platforms = {};
  platforms[provider] = {
    base: p.endpoint || '',
    key: str(input.apiKey, 400),
    model: str(input.model, 60) || (p.model || ''),
    kind: p.kind || 'openai'
  };
  // 合并既有其它平台（网页端配的平台不被覆盖），active 指向本次保存的平台
  const prev = await readVisionConfigDoc(app, openid);
  const merged = Object.assign({}, prev ? (prev.platforms || {}) : {}, platforms);
  const rec = { enabled: input.enabled !== false, active: provider, platforms: merged, updatedAt: nowMs() };
  try {
    await app.database().collection(VISION_COLL).doc(openid).set(rec);
    return { ok: true };
  } catch (e) {
    try { await app.database().createCollection(VISION_COLL); await app.database().collection(VISION_COLL).doc(openid).set(rec); return { ok: true }; }
    catch (e2) { return { ok: false, code: 'db_error', msg: '保存失败' }; }
  }
}

/** 视觉能力探测图：64x64 纯红色 JPEG（本机 PIL 生成，693B）。
 * openai 兼容平台测试时发这张图问颜色——纯文本模型（如 deepseek-chat/flash）看不到图，
 * 文本探测「只回复OK」会造成假阳性（实测 deepseek-flash 文本可通过但批改时看不到笔迹）。 */
const VISION_PROBE_IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDnqKKK8U/TAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//Z';

async function testVision(app, openid, input) {
  const provider = (input && input.provider) || '';
  const apiKey = (input && input.apiKey) || '';
  const model = (input && input.model) || '';
  const p = PROVIDERS[provider];
  let base = p ? (p.endpoint || '') : '';
  let kind = p ? (p.kind || 'openai') : 'openai';
  let key = apiKey;
  let mdl = model || (p ? (p.model || '') : '');
  // 网页端平台（deepseek/siliconflow/custom）不在内置 PROVIDERS 清单：
  // 回读 vision_config[openid] 文档取该平台的 base/kind；key/model 以入参优先、缺省回文档。
  // 批改主链路（resolveActiveVision→visionBuilder）从不查 PROVIDERS，此处对齐，网页端为准。
  if (!p) {
    const doc = await readVisionConfigDoc(app, openid);
    const plat = doc && doc.platforms && doc.platforms[provider];
    if (!plat || typeof plat !== 'object') return { ok: false, code: 'bad_provider', msg: '不支持的视觉模型：' + provider };
    base = plat.base || '';
    kind = plat.kind || 'openai';
    if (!key) key = plat.key || '';
    if (!mdl) mdl = plat.model || '';
    if (!base) return { ok: false, code: 'bad_provider', msg: '该平台未配置接口地址（请在网页端补全）' };
  }
  if (!key) return { ok: false, code: 'no_key', msg: '未提供 API Key' };
  if (!mdl) return { ok: false, code: 'no_key', msg: '未配置模型名' };
  const v = { base: base, key: key, model: mdl, kind: kind };
  // openai 兼容平台用「红色图问颜色」探测真实视觉能力；qwen/gemini 内置平台保持文本探测
  const useImageProbe = v.kind === 'openai';
  const req = visionBuilder(v)(useImageProbe ? [VISION_PROBE_IMG] : [], useImageProbe ? '图中色块是什么颜色？只回答颜色名。' : '请只回复两个字：OK');
  try {
    const resp = await httpJson(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    const j = resp.json();
    const text = req.pick ? req.pick(j) : ((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    const t = String(text || '').trim();
    if (useImageProbe) {
      if (!/红|red/i.test(t)) {
        return { ok: false, code: 'no_vision', msg: '该模型读不到图片内容（回复：' + t.slice(0, 30) + '）。请改用视觉模型（如 Qwen3-VL），或在网页端切换平台。' };
      }
      return { ok: true, msg: '连接成功（视觉识别正常）', sample: t.slice(0, 50) };
    }
    if (t.length) return { ok: true, msg: '连接成功', sample: t.slice(0, 50) };
    return { ok: false, code: 'empty', msg: '模型返回为空，请检查密钥或模型名' };
  } catch (e) { return { ok: false, code: 'conn_error', msg: '连接失败：' + ((e && e.message) || e) }; }
}

async function getVisionConfig(app, openid) {
  try {
    await ensureCollection(app, VISION_COLL);
    const doc = await readVisionConfigDoc(app, openid);
    if (!doc) return { ok: true, config: null };
    const v = resolveActiveVision(doc);
    if (!v) return { ok: true, config: null };
    // 回传 active 平台给 iPad/小程序设置页预填（家庭自用场景，apiKey 原样回传）
    return { ok: true, config: { provider: v.provider, apiKey: v.key || '', model: v.model || '', enabled: doc.enabled !== false } };
  } catch (e) { return { ok: false, code: 'db_error', msg: '读取配置失败：' + ((e && e.message) || e) }; }
}

/* ---------------- HTTP 集成请求归一化（云函数 URL 化入口；iPad 原生端走这里） ----------------
 * 云函数开启 URL 化后，event 变为「集成请求」结构：
 *   { path, httpMethod, headers, queryStringParameters, body: 'JSON字符串', isBase64Encoded }
 * 而小程序 wx.cloud.callFunction 传的是原始 payload。
 * 这里把两者归一，下方 switch 逻辑一行都不用改，双端共用同一套业务代码。
 */
function normalizeHttpEvent(raw) {
  const ev = (raw && typeof raw === 'object') ? raw : {};
  const isIntegration = typeof ev.body === 'string' &&
    (typeof ev.httpMethod === 'string' || typeof ev.path === 'string');
  if (!isIntegration) return { payload: ev, headers: {}, viaHttp: false };
  const headers = (ev.headers && typeof ev.headers === 'object') ? ev.headers : {};
  let bodyText = ev.body;
  if (String(ev.isBase64Encoded) === 'true' || ev.isBase64Encoded === true) {
    try { bodyText = Buffer.from(String(bodyText || ''), 'base64').toString('utf8'); } catch (e) {}
  }
  let payload = {};
  try {
    const p = JSON.parse(String(bodyText || ''));
    if (p && typeof p === 'object' && !Array.isArray(p)) payload = p;
  } catch (e) {}
  // GET / 空 body 场景：回退到 queryString
  if (!payload.action && ev.queryStringParameters && typeof ev.queryStringParameters === 'object') {
    payload = Object.assign({}, ev.queryStringParameters, payload);
  }
  /* 安全剥离（2026-10-27，IDOR 修复）：
   * `userInfo` 是**微信网关注入**的字段，客户端不可伪造 —— 但那只对
   * wx.cloud.callFunction 成立。URL 化（HTTP 集成）入口没有网关把关，调用方只要在
   * body 里塞 `{"action":"listExams","userInfo":{"openId":"受害者openid"}}` 就能命中
   * resolveOpenid 的第一个分支，以他人身份读写全库。所以这里必须显式剥掉。
   *   · 小程序：body 不是 string → 不进本分支，完全不受影响；
   *   · iPad：身份靠 uid 自报（resolveOpenid 第 3/4 分支），uid 保留，
   *     保护由 EXAM_HTTP_TOKEN 令牌闸承担 —— 生产必须配置该环境变量。 */
  delete payload.userInfo;
  return { payload: payload, headers: headers, viaHttp: true };
}

/** 访问令牌闸：**仅对 URL 化入口生效**，小程序 SDK 调用不受影响。
 *  设环境变量 EXAM_HTTP_TOKEN 后，客户端必须带 header `x-exam-token`；未配置则不拦（开发态）。
 *  作用：URL 化地址是公开可打的，没有闸等于任何人都能调 gen 消耗 AI Token 额度。 */
function httpTokenRejected(req) {
  if (!req || !req.viaHttp) return false;
  const expect = String(process.env.EXAM_HTTP_TOKEN || '').trim();
  if (!expect) return false;
  const h = req.headers || {};
  let got = '';
  for (const k of Object.keys(h)) {
    if (String(k).toLowerCase() === 'x-exam-token') { got = String(h[k] || ''); break; }
  }
  return got.trim() !== expect;
}

/* ---------------- 主入口 ---------------- */
exports.main = async (rawEvent) => {
  const req = normalizeHttpEvent(rawEvent);
  if (httpTokenRejected(req)) return { ok: false, code: 'unauthorized', msg: '未授权请求：缺少或错误的访问令牌' };
  const event = req.payload;
  const action = str(event && event.action, 30);
  let app;
  try { app = tcb.init({ env: ENV }); }
  catch (e) { return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) }; }

  // 身份解析（不强制绑定）
  let idRes;
  try { idRes = await resolveOpenid(app, event); }
  catch (e) { idRes = { openid: '', bound: false, kind: 'none' }; }
  const openid = idRes.openid;
  if (!openid && action !== 'listProviders') return { ok: false, code: 'no_identity', msg: '无法解析用户身份' };

  try {
    switch (action) {
      case 'gen': return await genExam(app, {
        subject: str(event.subject, 20), grade: str(event.grade, 20), clientId: str(event.clientId, 60),
        createdBy: str(event.createdBy, 10), scope: event.scope || {}, planCtx: event.planCtx || {},
        learnerCtx: str(event.learnerCtx, 2000), expectations: Array.isArray(event.expectations) ? event.expectations : [],
        childId: str(event.childId, 64)
      }, openid);
      case 'grade': return await gradeExam(app, {
        examClientId: str(event.examClientId, 80), answers: event.answers || [], route: event.route,
        submissionClientId: str(event.submissionClientId, 60)
      }, openid);
      case 'saveExam': return await saveExam(app, { exam: event.exam || {} }, openid);
      case 'listExams': return await listExams(app, openid, str(event.subject, 20), str(event.childId, 64));
      case 'getExam': return await getExam(app, openid, str(event.resourceId, 80));
      case 'deleteExam': return await deleteExam(app, openid, str(event.resourceId, 80));
      case 'listSubmissions': return await listSubmissions(app, openid, str(event.examClientId, 80));
      case 'getSubmission': return await getSubmission(app, openid, str(event.submissionClientId, 80));
      case 'pull': return await pullSync(app, openid);
      case 'push': return await pushSync(app, openid, { exam_resources: Array.isArray(event.exam_resources) ? event.exam_resources : [], tutor_exam_submissions: Array.isArray(event.tutor_exam_submissions) ? event.tutor_exam_submissions : [] });
      case 'bind': return await bindAccount(app, openid, { uid: str(event.uid, 60), token: str(event.token, 400) });
      case 'resolve': return { ok: true, identity: idRes };
      case 'saveVisionConfig': return await saveVisionConfig(app, openid, { provider: str(event.provider, 20), apiKey: str(event.apiKey, 400), model: str(event.model, 60), enabled: event.enabled });
      case 'testVision': return await testVision(app, openid, { provider: str(event.provider, 20), apiKey: str(event.apiKey, 400), model: str(event.model, 60) });
      case 'getVisionConfig': return await getVisionConfig(app, openid);
      case 'listProviders': return { ok: true, providers: listProviderMeta() };
      case 'parseUpload': return await parseUpload(app, { rawText: event.rawText, name: str(event.name, 80), subject: str(event.subject, 20), grade: str(event.grade, 20) }, openid);
      case 'parseTextbookPdf': return await parseTextbookPdf(app, { fileId: str(event.fileId, 300), subject: str(event.subject, 20), grade: str(event.grade, 10), term: str(event.term, 10), version: str(event.version, 20) }, openid);
      case 'parseTextbookText': return await parseTextbookText(app, { rawText: event.rawText, subject: str(event.subject, 20), grade: str(event.grade, 10), term: str(event.term, 10), version: str(event.version, 20) }, openid);
      case 'searchTextbook': return await searchTextbook(app, { query: event.query, subject: str(event.subject, 20), grade: str(event.grade, 10), term: str(event.term, 10), version: str(event.version, 20) }, openid);
      case 'signUpload': return await signUpload(app, { kind: str(event.kind, 30), ext: str(event.ext, 8) });
      case 'fileUrls': {
        // fileID 实测可达 121+ 字符，cap 必须留足（曾用 120 恰好截断扩展名末字符）
        const ids = Array.isArray(event.fileIds) ? event.fileIds.map(x => str(x, 200)).filter(Boolean).slice(0, 50) : [];
        const d = await getFileUrlsDetail(app, ids);
        return { ok: true, urls: d.urls, error: d.error };
      }
      case 'reviewSubmission': return await reviewSubmission(app, { submissionClientId: str(event.submissionClientId, 80), reviews: event.reviews }, openid);
      // —— iPad 学习闭环只读切片（按计划/单元/卡片/计划回读 hw_farm_user）——
      case 'listCards': return await listCards(app, openid);
      case 'listUnits': return await listUnits(app, openid);
      case 'getUnitKps': return await getUnitKps(app, openid, str(event.unitId, 60));
      case 'listPlans': return await listPlans(app, openid);
      // —— 单元复习闭环 ——
      case 'genUnitReview': return await genUnitReview(app, { subject: str(event.subject, 20), grade: str(event.grade, 20), unitId: str(event.unitId, 60), count: event.count, clientId: str(event.clientId, 60), questionTypes: Array.isArray(event.questionTypes) ? event.questionTypes : [] }, openid);
      // 题型库（学科×年级真实题型模板）：客户端出卷 UI 的题型选项来源，服务端为唯一真相源
      case 'listQuestionTypes': {
        const s = str(event.subject, 20), g = str(event.grade, 20);
        return { ok: true, subject: s, grade: g, types: ((QUESTION_TYPES[s] || {})[g] || []).map(t => ({ name: t.name, hint: t.hint, type: t.type })) };
      }
      case 'listMistakes': return await listMistakes(app, openid, { subject: str(event.subject, 20), topics: Array.isArray(event.topics) ? event.topics : [], activeOnly: event.activeOnly });
      case 'listTextbooks': return await listTextbooks(app, openid, { subject: str(event.subject, 20), grade: str(event.grade, 10), term: str(event.term, 10) });
      case 'getTextbook': return await getTextbook(app, openid, str(event.textbookId, 60));
      case 'saveTextbook': return await saveTextbook(app, { textbook: event.textbook || {} }, openid);
      case 'deleteTextbook': return await deleteTextbook(app, openid, str(event.textbookId, 60));
      // —— PDF 直写卷阅卷（导入 PDF → 页面手写 → 逐页视觉批改）——
      case 'gradePaper': return await gradePaper(app, {
        examClientId: str(event.examClientId, 80),
        answers: Array.isArray(event.answers) ? event.answers : [],
        submissionClientId: str(event.submissionClientId, 60)
      }, openid);
      default:     return { ok: false, code: 'bad_action', msg: '未知动作：' + action };
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (isNoPackError(e)) {
      return { ok: false, code: 'no_pack', msg: 'AI 资源包未开通：请在云开发控制台购买「Token Credits 资源包」后重试' };
    }
    return { ok: false, code: 'svc_error', msg: '服务异常：' + msg };
  }
};

/* 测试导出（纯逻辑，不依赖云 SDK） */
if (process.env.EXAM_TEST) {
  module.exports = {
    str, extractJson, sanitizeBanned, parseExam, PROVIDERS, listProviderMeta,
    normChoice, judgeChoice, cleanChoiceOption, choiceAnswerLetter, EXAM_TYPE_LABEL, SUBJECT_NAMES,
    normalizeTextbook,
    listTextbooks, getTextbook, saveTextbook, deleteTextbook, TEXTBOOK_COLL,
    sliceTocSegment, parseTocText, parseTextbookPdf, parseTextbookText,
    cleanUnits, buildSearchQuery, parseSearchPayload, parseBochaPayload, buildSearchMaterial, parseSearchToc, searchTextbook, searchRateWait, getSearchProviders, runSearch,
    normalizeHttpEvent, httpTokenRejected, decodeImageBase64, ruleChoiceDiag,
    resolveChildScope,
    addOnce, isNoPackError, buildBlindSpotHint, unitTypeHint, buildGenUser,
    buildTypeLibBlock, normTypeMix, buildTypeMixBlock, QUESTION_TYPES,
    normFigure, saveExam, listExams
  };
}

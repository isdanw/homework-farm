/**
 * teachingPlan.js —— 教学计划（Markdown / HTML）导入的纯文本清洗（小程序端，不依赖云）。
 * 只产出「可被引用的纯文本」；结构化大纲（outline）提取留作二期（可在 studyPlanGen 内联或端上一次性提取）。
 *
 * 设计要点（见《教学计划导入功能设计.md》修订版）：
 *   · 教学计划折叠进「学科画像 → 成长计划(studyPlanGen) → 导学(tutorChat)」链路，不新建集合/模块；
 *   · 文本存于 subjectProfiles[key].teachingPlan.raw（用户级、随画像同步云端）；
 *   · 导入走本地读文本（粘贴 / chooseMessageFile），纯文本不走 COS。
 */

/** 剥 script/style/注释 + 块级标签转行 + 标题层级保留 + 标签剥空格 + 实体还原 + 空白折叠 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<h1[^>]*>/gi, '\n# ')
    .replace(/<h2[^>]*>/gi, '\n## ')
    .replace(/<h3[^>]*>/gi, '\n### ')
    .replace(/<h4[^>]*>/gi, '\n#### ')
    .replace(/<h5[^>]*>/gi, '\n##### ')
    .replace(/<h6[^>]*>/gi, '\n###### ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(p|div|br|tr|table|thead|tbody)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Markdown → 纯文本：去代码围栏 / 图片语法，保留标题层级与列表，折叠空白 */
function mdToText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 由文件名/内容推断格式。
 * @param {string} name 文件名（含扩展名）
 * @param {string} content 文本内容
 */
function detectFormat(name, content) {
  const ext = (name || '').toLowerCase().split('.').pop();
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'md';
  // 无扩展名时按内容嗅探
  const c = String(content || '');
  if (/<(h[1-6]|p|div|table|style|script)\b/i.test(c)) return 'html';
  if (/^#{1,6}\s|^[-*]\s|\*\*[^*]+\*\*/m.test(c)) return 'md';
  return 'text';
}

/**
 * 清洗入口：按格式选 htmlToText / mdToText。
 * @returns string 清洗后的纯文本
 */
function cleanPlanText(content, format) {
  if (format === 'html') return htmlToText(content);
  if (format === 'md') return mdToText(content);
  return String(content || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { htmlToText, mdToText, detectFormat, cleanPlanText };

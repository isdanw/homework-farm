/**
 * profileParser.js —— 画像提示词本地解析器
 * ---------------------------------------------------------------------------
 * 从粘贴的画像提示词（YAML frontmatter + Markdown 正文，参考
 * 「全科导学专家 / 01-profiles」的 学习者/数学/语文/英语.md 结构）中，
 * 识别学科画像字段：教材版本 / 进度 / 学习者编号 / 能力维度(含掌握度初值) / 常见错误模式。
 *
 * 纯字符串运算、不依赖 wx，可在 Node 中直接单测。
 *
 * 支持的行格式（全半角冒号均可，兼容列表符号与括号备注）：
 *   教材版本: 人教版
 *   能力维度: 数感与数数、20以内加减法、图形与位置、分类与比较
 *   能力维度初值：数感 2 / 计算 2 / 图形位置 2 / 分类比较 2（1-5 分，随证据更新）
 *   常见错误模式: 拼音字形混淆（b/d、p/q，E3）、声调标注错误（E2）
 *   进度: 一年级上学期 准备课（数一数 / 比多少）
 *   学习者编号: JY-001
 */

/** 仅在括号外按分隔符切分（避免「（b/d、p/q，E3）」内的分隔符拆坏内容） */
function splitOutside(str, seps) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const ch of String(str || '')) {
    if (ch === '（' || ch === '(') { depth++; buf += ch; continue; }
    if (ch === '）' || ch === ')') { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (depth === 0 && seps.indexOf(ch) >= 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map(s => s.trim()).filter(Boolean);
}

/** 去掉括号备注：「数感 2（1-5 分）」→「数感 2」 */
function stripParens(s) {
  return String(s || '').replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 名称归一：去连接词与空白后比对（图形位置 ↔ 图形与位置） */
function normName(s) { return String(s || '').replace(/[与和及、·\s]/g, ''); }

/** 维度名模糊匹配：归一后互相包含即视为同一维度 */
function sameDim(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
}

/**
 * 解析画像提示词文本
 * @param {String} raw 粘贴的提示词全文
 * @returns {{textbook:String, progress:String, learnerNo:String,
 *            dimensions:Array<{name:String,level:Number}>, errors:Array<String>, matched:Array<String>}}
 */
function parseProfilePrompt(raw) {
  const out = { textbook: '', progress: '', learnerNo: '', dimensions: [], errors: [], matched: [] };
  if (!raw || typeof raw !== 'string') return out;

  // 去 markdown 代码围栏
  const text = raw.replace(/```[a-zA-Z]*\n?/g, '').trim();

  // 拆 frontmatter 与正文
  let fm = '';
  let body = text;
  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fmMatch) { fm = fmMatch[1]; body = text.slice(fmMatch[0].length); }

  const dimNames = [];    // 「能力维度」提供的维度名（frontmatter 全名）
  const dimLevels = [];   // 「能力维度初值」提供的 名字+等级
  const errFm = [];       // frontmatter 里的错误模式（结构化，优先）
  const errBody = [];     // 正文里的错误模式（frontmatter 缺席时兜底）

  const feed = (segment, isFm) => {
    segment.split('\n').forEach(line0 => {
      let line = String(line0 || '').trim();
      if (!line || /^#/.test(line)) return;
      line = line.replace(/^[-*•]\s+/, '');          // 去列表符号

      const m = line.match(/^([^:：]{2,24})[:：]\s*(.+)$/);
      if (!m) return;
      const key = stripParens(m[1]);
      const val = m[2].trim();

      if (/^(教材版本|教材)$/.test(key)) {
        out.textbook = stripParens(val);
        out.matched.push('教材版本');
      } else if (/^(学校)?进度$/.test(key)) {
        out.progress = val;
        out.matched.push('进度');
      } else if (/学习者编号/.test(key)) {
        out.learnerNo = val;
        out.matched.push('学习者编号');
      } else if (/能力维度(初值|掌握度)|掌握度初值/.test(key)) {
        // 形如「数感 2 / 计算 2 / 图形位置 2（1-5 分…）」
        splitOutside(stripParens(val), ['/', '、', '，', ',']).forEach(tok => {
          const lm = tok.match(/^(.+?)\s*[:：]?\s*([1-5])\s*分?$/);
          if (lm) dimLevels.push({ name: lm[1].trim(), level: parseInt(lm[2], 10) });
        });
      } else if (/能力维度|维度/.test(key)) {
        splitOutside(stripParens(val), ['/', '、', '，', ',']).forEach(t => dimNames.push(t));
      } else if (/错误模式|易错/.test(key)) {
        (isFm ? errFm : errBody).push.apply(
          isFm ? errFm : errBody,
          splitOutside(val, ['/', '、', '，', ',', '；', ';'])
        );
      }
    });
  };

  feed(fm, true);
  feed(body, false);

  // 维度合并：frontmatter 全名为骨架（初值等级匹配则覆盖），未匹配的初值条目追加保留
  const dims = [];
  dimNames.forEach(n => { if (!dims.find(d => sameDim(d.name, n))) dims.push({ name: n, level: 2 }); });
  dimLevels.forEach(dl => {
    const hit = dims.find(d => sameDim(d.name, dl.name));
    if (hit) hit.level = dl.level;
    else dims.push({ name: dl.name, level: dl.level });
  });
  out.dimensions = dims;

  out.errors = errFm.length ? errFm : errBody;

  if (out.dimensions.length) out.matched.push('能力维度');
  if (out.errors.length) out.matched.push('常见错误模式');
  out.matched = Array.from(new Set(out.matched));
  return out;
}

module.exports = { parseProfilePrompt, splitOutside, stripParens, sameDim };

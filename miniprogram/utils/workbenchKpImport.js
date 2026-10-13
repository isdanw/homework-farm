/**
 * 跨仓对齐：全科导学工作台 → homework-farm 单元必会库（tutor_unit_kps）
 * =================================================================
 * 背景：设计文档 §七 规划的「复用 workbench knowledgePoints 作为可选导入源」。
 * 工作台两种结构化知识点形状：
 *   A. KnowledgePoint[]  （src/library/p3/types.ts，subject 级、synthetic 演示居多）
 *   B. RawCurriculum[]   （src/logic/curriculum.ts，章/节大纲树，含 subject/grade/title/nodes）
 * homework-farm 目标：tutor_unit_kps = { id, subject, grade, title, points:[{id,topic,front,back,order}] }
 *
 * 对齐规则（跨仓契约）：
 *   1. subject:  workbench subjectId(mathematics/english/...) → homework-farm subject(math/english/...)
 *               未列出的学科原样透传（subject 为自由字符串，unitKp 页仍可按自定义学科消费）。
 *   2. grade:    stage('K7')/grade('7')/中文('一年级') → 纯数字年级串。
 *   3. unitId:   导入单元统一前缀 `wb_`（与 AI 建库的 `u_` 区分，避免互覆盖）；
 *               KP 模式 = `wb_<subject>_<grade>_kp`（学科级一单元）；
 *               大纲模式 = `wb_<subject>_<grade>_<versionSlug>`（一教材一单元）。
 *   4. points:   KP.ref→id、canonicalName/name→topic；大纲 node→id/topic。
 *   5. front/back: 工作台无问答对 → 模板占位（front=`能说出「topic」吗？`，back=topic/描述）。
 *               标记为占位，导入后可在 unitKp 页补充真实问答；生成时附 synthetic 等警告。
 *   6. 去重:     point.id 单元内唯一（碰撞追加 _2/_3）；unit 按 id upsert（幂等）。
 *
 * 纯函数、无 wx 依赖，可在 node 下单测。
 */

// workbench subjectId → homework-farm subject（key）。未列出的原样透传。
const SUBJECT_MAP = {
  mathematics: 'math', math: 'math',
  chinese: 'chinese', yuwen: 'chinese',
  english: 'english',
  biology: 'biology', history: 'history', geography: 'geography',
  physics: 'physics', chemistry: 'chemistry', politics: 'politics',
  // 默认兜底见 normalizeSubject
};

const SUBJECT_CN = {
  math: '数学', chinese: '语文', english: '英语',
  biology: '生物', history: '历史', geography: '地理',
  physics: '物理', chemistry: '化学', politics: '道法'
};

function normalizeSubject(subjectId) {
  const raw = String(subjectId == null ? '' : subjectId).trim();
  const key = raw.toLowerCase();
  const mapped = SUBJECT_MAP[key];
  if (mapped) return { subject: mapped, subjectName: SUBJECT_CN[mapped] || mapped, mapped: true };
  const pass = key || raw;
  return { subject: pass, subjectName: SUBJECT_CN[pass] || raw || pass, mapped: false };
}

function normalizeGrade(stageOrGrade) {
  if (stageOrGrade == null) return '';
  const s = String(stageOrGrade).trim();
  const m = s.match(/\d+/);
  if (m) return m[0];
  if (s.includes('一')) return '1';
  if (s.includes('二')) return '2';
  if (s.includes('三')) return '3';
  if (s.includes('四')) return '4';
  if (s.includes('五')) return '5';
  if (s.includes('六')) return '6';
  return s; // 兜底原值
}

function slugify(ref) {
  const s = String(ref == null ? '' : ref)
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return s || 'kp';
}

// 工作台无问答对 → 模板占位（导入后建议补充真实问答）
function genFrontBack(topic, desc) {
  const t = String(topic || '').trim();
  const d = String(desc || '').trim();
  const front = t ? '能说出「' + t + '」吗？' : '能说出这个必会点吗？';
  const back = (d && d !== t) ? d : (t || '（待补充）');
  return { front: front, back: back };
}

function detectMode(input) {
  if (input == null) return { mode: null, arr: [], error: '输入为空' };
  const arr = Array.isArray(input) ? input : [input];
  if (!arr.length) return { mode: null, arr: [], error: '输入为空数组' };
  const hasKp = (x) => x && typeof x === 'object' && ('knowledgePointRef' in x);
  const hasNodes = (x) => x && typeof x === 'object' && Array.isArray(x.nodes);
  if (arr.every(hasKp)) return { mode: 'kp', arr: arr };
  if (arr.every(hasNodes)) return { mode: 'curriculum', arr: arr };
  // 容错：以首个元素判定
  const f = arr[0];
  if (hasKp(f)) return { mode: 'kp', arr: arr };
  if (hasNodes(f)) return { mode: 'curriculum', arr: arr };
  return { mode: null, arr: arr, error: '无法识别：元素既无 knowledgePointRef 也无 nodes' };
}

// 给一份 unit 的 points 做 id 内部去重（碰撞追加 _2/_3）
function dedupePoints(points) {
  const seen = {};
  return points.map((p) => {
    let pid = slugify(p.id) || slugify(p.topic) || 'p';
    if (seen[pid]) { let n = 2; while (seen[pid + '_' + n]) n++; pid = pid + '_' + n; }
    seen[pid] = true;
    return {
      id: pid,
      topic: String(p.topic || '').trim(),
      front: String(p.front || '').trim(),
      back: String(p.back || '').trim(),
      order: Number(p.order) || 0
    };
  });
}

function convertKp(arr) {
  const groups = {};
  const warnings = [];
  arr.forEach((kp) => {
    const s = normalizeSubject(kp.subjectId);
    const grade = normalizeGrade(kp.stage);
    const key = s.subject + ':' + grade;
    if (!groups[key]) groups[key] = { s: s, grade: grade, kps: [], synthetic: false };
    groups[key].kps.push(kp);
    if (kp.dataNature === 'synthetic') groups[key].synthetic = true;
  });
  const units = [];
  Object.keys(groups).forEach((gk) => {
    const g = groups[gk];
    const unitId = 'wb_' + g.s.subject + '_' + g.grade + '_kp';
    const title = (g.grade ? g.grade + '年级·' : '') + g.s.subjectName + '·必会（工作台导入）';
    const points = dedupePoints(g.kps.map((kp, idx) => {
      const topic = kp.canonicalName || kp.name || kp.knowledgePointRef;
      const fb = genFrontBack(topic, kp.canonicalName || kp.name);
      return { id: kp.knowledgePointRef, topic: topic, front: fb.front, back: fb.back, order: idx + 1 };
    }));
    units.push({
      id: unitId, subject: g.s.subject, grade: g.grade, title: title,
      points: points, createdAt: Date.now(), updatedAt: Date.now(), _source: 'workbench-kp'
    });
    if (!g.s.mapped) warnings.push('学科 ' + g.s.subject + ' 在 homework-farm 无内置导学，已按自定义学科导入');
    if (g.synthetic) warnings.push('单元「' + title + '」来源为 synthetic 演示数据，问答为模板占位，建议补充真实内容');
  });
  return { units: units, warnings: warnings };
}

function convertCurriculum(arr) {
  const units = [];
  const warnings = [];
  arr.forEach((cur) => {
    const s = normalizeSubject(cur.subject);
    const grade = normalizeGrade(cur.grade);
    const versionSlug = slugify(cur.version || cur.title || 'v1');
    const unitId = 'wb_' + s.subject + '_' + grade + '_' + versionSlug;
    const title = (grade ? grade + '年级·' : '') + s.subjectName + '·' + (cur.title || '必会');
    const nodes = Array.isArray(cur.nodes) ? cur.nodes : [];
    // 取 level-2（节）为点；level-1（章）若没有子节点也纳入
    const childIds = new Set(nodes.filter((n) => n && n.parentId).map((n) => n.parentId));
    const pointNodes = nodes.filter((n) => n && (n.level === 2 || (n.level === 1 && !childIds.has(n.nodeId))));
    const points = dedupePoints(pointNodes.map((n, idx) => {
      const topic = n.title || n.nodeId;
      const fb = genFrontBack(topic, '');
      return { id: n.nodeId, topic: topic, front: fb.front, back: fb.back, order: Number(n.order) || (idx + 1) };
    }));
    units.push({
      id: unitId, subject: s.subject, grade: grade, title: title,
      points: points, createdAt: Date.now(), updatedAt: Date.now(), _source: 'workbench-curriculum'
    });
    if (!s.mapped) warnings.push('学科 ' + s.subject + ' 在 homework-farm 无内置导学，已按自定义学科导入');
  });
  return { units: units, warnings: warnings };
}

/**
 * 入口：把 workbench 知识点结构转为 homework-farm 单元必会库。
 * @param {any} input  KnowledgePoint[] | RawCurriculum[] | 单个 RawCurriculum 对象
 * @returns {{ok:boolean, mode?:string, units:Array, warnings:string[], stats?:{units:number,points:number}, error?:string}}
 */
function convert(input) {
  const { mode, arr, error } = detectMode(input);
  if (!mode) return { ok: false, error: error || '无法识别输入', units: [], warnings: [] };
  const res = mode === 'kp' ? convertKp(arr) : convertCurriculum(arr);
  const totalPoints = res.units.reduce((sum, u) => sum + (u.points ? u.points.length : 0), 0);
  return {
    ok: true, mode: mode,
    units: res.units, warnings: res.warnings,
    stats: { units: res.units.length, points: totalPoints }
  };
}

module.exports = {
  SUBJECT_MAP: SUBJECT_MAP,
  SUBJECT_CN: SUBJECT_CN,
  normalizeSubject: normalizeSubject,
  normalizeGrade: normalizeGrade,
  slugify: slugify,
  genFrontBack: genFrontBack,
  detectMode: detectMode,
  dedupePoints: dedupePoints,
  convertKp: convertKp,
  convertCurriculum: convertCurriculum,
  convert: convert
};

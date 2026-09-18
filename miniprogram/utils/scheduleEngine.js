/**
 * ============================================================================
 *  scheduleEngine.js —— 课程表引擎（录入 / 归一化 / 课表 → 打卡内容识别）
 *  ---------------------------------------------------------------------------
 *  职责：
 *    ① 课表数据结构：一学期一张固定表（小学阶段不做单双周）
 *       行 = 第几节课，列 = 周几（周一=0），cells 以 '行-列' 为键
 *    ② 科目名归一化：去空格、去括号备注，让「语文(张老师)」=「语文」
 *    ③ 课表 → 打卡内容识别：扫描课表出现的科目，与现有打卡类型做别名匹配
 *       · 命中（如 语文 → chinese）→ 标记「已关联打卡」
 *       · 未命中（如 体育 / 音乐）→ 提示家长一键添加为新的打卡类型
 *    ④ 拍照识别结果的回填：二维数组 → cells
 *
 *  数据归属：课表挂在「孩子切片」上（每个孩子一份），
 *           新增的打卡类型写进该孩子的 checkinTypes，与 typeManage 完全兼容。
 * ============================================================================
 */
const CFG = require('./config.js');
const util = require('./util.js');
const store = require('./store.js');

/* --------------------------- 基础结构 --------------------------- */

function clamp(n, min, max) {
  n = Number(n) || min;
  return Math.max(min, Math.min(max, n));
}

/** 一张空课表 */
function emptySchedule() {
  const S = CFG.SCHEDULE;
  return {
    termName: '',
    updatedAt: 0,
    photoPath: '',                                   // 拍照原图（本地永久路径，用于对照核对）
    rows: S.DEFAULT_ROWS,
    cols: S.DEFAULT_COLS,
    slotTimes: S.SLOT_TIMES.slice(0, S.DEFAULT_ROWS),
    cells: {}
  };
}

/** 补齐字段并夹取合法范围（兼容旧数据 / 脏数据） */
function normalize(sch) {
  const S = CFG.SCHEDULE;
  const base = emptySchedule();
  if (!sch || typeof sch !== 'object') return base;
  const out = Object.assign(base, sch);
  out.rows = clamp(out.rows, 1, S.MAX_ROWS);
  out.cols = clamp(out.cols, 1, S.MAX_COLS);
  if (!Array.isArray(out.slotTimes) || !out.slotTimes.length) {
    out.slotTimes = S.SLOT_TIMES.slice(0, out.rows);
  }
  if (!out.cells || typeof out.cells !== 'object') out.cells = {};
  return out;
}

function cellKey(r, c) { return `${r}-${c}`; }

function getCell(sch, r, c) {
  return ((sch && sch.cells ? sch.cells[cellKey(r, c)] : '') || '').trim();
}

/** 写入 / 清空一格（空字符串 = 删除该格） */
function setCell(sch, r, c, name) {
  const v = (name || '').trim();
  if (v) sch.cells[cellKey(r, c)] = v;
  else delete sch.cells[cellKey(r, c)];
  return sch;
}

/* --------------------------- 读写 --------------------------- */

/** 当前孩子的课表（保证结构完整） */
function getSchedule() {
  const u = store.get();
  return normalize(u ? u.schedule : null);
}

/** 保存课表（自动刷新 updatedAt 并广播） */
function saveSchedule(sch) {
  const u = store.get();
  u.schedule = normalize(sch);
  u.schedule.updatedAt = Date.now();
  store.save(u);
  return u.schedule;
}

/** 清空课表 */
function clearSchedule() {
  const u = store.get();
  u.schedule = emptySchedule();
  store.save(u);
  return u.schedule;
}

/** 是否有课表内容（用于首页 / 我的页判断是否展示入口角标） */
function hasSchedule() {
  return Object.keys(getSchedule().cells).length > 0;
}

/* --------------------------- 科目名归一化 --------------------------- */

/** 去空格、去括号内的备注（如「语文（张老师）」→「语文」） */
function normalizeName(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim();
}

/** 科目名 → 打卡类型 key；命中别名表返回 key，否则返回 '' */
function matchType(name) {
  const n = normalizeName(name);
  if (!n) return '';
  const alias = CFG.SCHEDULE.SUBJECT_ALIAS || {};

  // 1) 精确命中（归一化后完全相等）
  for (const k of Object.keys(alias)) {
    if (alias[k].some(a => normalizeName(a) === n)) return k;
  }
  // 2) 包含命中（课表名较长，如「语文阅读」「数学思维」）
  for (const k of Object.keys(alias)) {
    for (const a of alias[k]) {
      const na = normalizeName(a);
      if (na.length >= 2 && n.indexOf(na) >= 0) return k;
    }
  }
  return '';
}

/** 收集课表出现过的全部科目（去重，按出现次数倒序） */
function collectSubjects(sch) {
  const s = normalize(sch);
  const map = {};
  Object.keys(s.cells).forEach(k => {
    const n = normalizeName(s.cells[k]);
    if (!n) return;
    map[n] = (map[n] || 0) + 1;
  });
  return Object.keys(map)
    .map(name => ({ name, count: map[name] }))
    .sort((a, b) => b.count - a.count);
}

/* --------------------------- 课表 → 打卡内容识别 --------------------------- */

/**
 * 识别课表对应的打卡内容
 * @param {Object} sch
 * @returns {Object} {
 *   matched:   [{ name, count, typeKey, typeName, emoji, builtin }]  已能打卡的科目
 *   unmatched: [{ name, count }]                                     还没对应打卡类型的科目
 *   total, coverage                                                  科目总数 / 已关联覆盖率(%)
 * }
 */
function analyzeTypes(sch) {
  const subjects = collectSubjects(sch);
  const types = store.getTypeList();
  const matched = [];
  const unmatched = [];

  subjects.forEach(s => {
    // 1) 别名匹配内置类型  2) 与已有打卡类型（含自定义）同名匹配
    let key = matchType(s.name);
    if (!key) {
      const hit = types.find(t => normalizeName(t.name) === s.name);
      if (hit) key = hit.key;
    }
    if (key) {
      const t = store.getType(key);
      matched.push({
        name: s.name, count: s.count, typeKey: key,
        typeName: t.name, emoji: t.emoji || t.icon, builtin: !!t.builtin
      });
    } else {
      unmatched.push({ name: s.name, count: s.count });
    }
  });

  const total = subjects.length;
  return { matched, unmatched, total, coverage: total ? Math.round(matched.length / total * 100) : 0 };
}

/** 稳定短哈希（用于生成不会重复的打卡类型 key） */
function hashName(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

/** 由科目名生成一个自定义打卡类型记录（配色从池里取，保证同一科目每次一致） */
function buildTypeFromSubject(name, index) {
  const S = CFG.SCHEDULE;
  const n = normalizeName(name) || '其它';
  const pal = S.TYPE_PALETTE[(index || 0) % S.TYPE_PALETTE.length];
  const emoji = S.SUBJECT_EMOJI[n] || '📗';
  const key = 'st_' + hashName(n);
  return {
    id: key,
    key: key,
    name: n,
    emoji: emoji,
    icon: n.slice(0, 1),
    color: pal.color,
    colorDeep: pal.colorDeep,
    seedName: n + '种子',
    cropName: n + '小苗',
    shape: pal.shape,
    coin: 8,
    builtin: false,
    fromSchedule: true                     // 标记来源，便于 typeManage 区分
  };
}

/**
 * 一键把课表里「还没打卡类型」的科目加为打卡类型
 * @returns {Object} { added: 新增数量, names: [新增类型名] }
 */
function addMissingTypes(sch) {
  const res = analyzeTypes(sch);
  if (!res.unmatched.length) return { added: 0, names: [] };

  const u = store.get();
  if (!Array.isArray(u.checkinTypes)) u.checkinTypes = [];
  const added = [];

  res.unmatched.forEach((s) => {
    const exists = store.getTypeList().some(t => normalizeName(t.name) === s.name);
    if (exists) return;                                    // 已存在同名类型，跳过
    const rec = buildTypeFromSubject(s.name, u.checkinTypes.length + added.length);
    u.checkinTypes.push(rec);
    added.push(rec.name);
  });

  if (added.length) store.save(u);
  return { added: added.length, names: added };
}

/* --------------------------- 拍照识别结果回填 --------------------------- */

/**
 * 用识别结果（二维数组 grid[row][col] = 科目名）覆盖填充网格
 * 占位符（'-' / '—' / 空）视为空课
 */
function applyGrid(sch, grid) {
  const out = normalize(sch);
  out.cells = {};
  if (Array.isArray(grid)) {
    grid.forEach((row, r) => {
      if (!Array.isArray(row)) return;
      row.forEach((name, c) => {
        const v = String(name || '').trim();
        if (v && v !== '-' && v !== '—' && v !== '无') out.cells[cellKey(r, c)] = v;
      });
    });
    if (grid.length) out.rows = clamp(grid.length, 1, CFG.SCHEDULE.MAX_ROWS);
    // 列数取识别结果中最宽的一行
    const maxCol = grid.reduce((m, row) => Math.max(m, Array.isArray(row) ? row.length : 0), 0);
    if (maxCol) out.cols = clamp(maxCol, 1, CFG.SCHEDULE.MAX_COLS);
  }
  return out;
}

/* --------------------------- 按天查询 --------------------------- */

/**
 * 某天（按周几）的课程列表
 * @param {Object} sch
 * @param {String} dateKey 'YYYY-MM-DD'，默认今天
 * @returns {Array} [{ period, time, name, typeKey }]
 */
function dayCourses(sch, dateKey) {
  const s = normalize(sch);
  const d = new Date((dateKey || util.today()).replace(/-/g, '/'));
  const col = (d.getDay() + 6) % 7;                        // 周一 = 0
  if (col >= s.cols) return [];
  const list = [];
  for (let r = 0; r < s.rows; r++) {
    const name = getCell(s, r, col);
    if (!name) continue;
    list.push({ period: r + 1, time: s.slotTimes[r] || '', name: name, typeKey: matchType(name) });
  }
  return list;
}

/** 今天有哪些课（供首页展示） */
function todayCourses(sch) {
  return dayCourses(sch || getSchedule(), util.today());
}

module.exports = {
  clamp, emptySchedule, normalize, cellKey, getCell, setCell,
  getSchedule, saveSchedule, clearSchedule, hasSchedule,
  normalizeName, matchType, collectSubjects,
  analyzeTypes, buildTypeFromSubject, addMissingTypes, hashName,
  applyGrid, dayCourses, todayCourses
};

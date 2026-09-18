/**
 * tutorSubjects.js —— 全科导学的「九科路由」元数据（P3）
 *
 * 与 config.js 的 SUBJECTS（打卡类型，仅语数英 builtin）**解耦**：
 * 导学支持 K1-K12 九科，这是导学场景的学科列表，不污染打卡/农场类型系统。
 * 每科的「导学方法 prompt」在云函数 tutorChat 的 SUBJECT_PROMPTS 里维护（云端），
 * 这里只放前端展示所需的 key/name/emoji。
 *
 * key 命名与 rolePresets.js / 云函数 SUBJECT_NAMES 对齐：
 *   chinese 语文 / math 数学 / english 英语 / physics 物理 / chemistry 化学 /
 *   biology 生物 / history 历史 / geography 地理 / politics 道德与法治
 */
const TUTOR_SUBJECTS = [
  { key: 'chinese',   name: '语文',       emoji: '📚' },
  { key: 'math',      name: '数学',       emoji: '🔢' },
  { key: 'english',   name: '英语',       emoji: '🔤' },
  { key: 'physics',   name: '物理',       emoji: '🧲' },
  { key: 'chemistry', name: '化学',       emoji: '🧪' },
  { key: 'biology',   name: '生物',       emoji: '🧬' },
  { key: 'history',   name: '历史',       emoji: '📜' },
  { key: 'geography', name: '地理',       emoji: '🌍' },
  { key: 'politics',  name: '道德与法治', emoji: '⚖️' }
];

/** 按 key 取学科；找不到返回 null */
function getTutorSubject(key) {
  return TUTOR_SUBJECTS.find(s => s.key === key) || null;
}

module.exports = { TUTOR_SUBJECTS, getTutorSubject };

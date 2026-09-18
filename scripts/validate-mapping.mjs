// T1 参考实现 / 校验器：本地 家庭学习库 md → 云端集合 JSON 形态
// 目的：实证 T1 映射规范可落地（用真实非-demo 文件跑通）。非生产脚本。
import { readFileSync } from 'node:fs';

const LIB = '/Users/yiyo/Desktop/全科导学专家/全学科导学体系/家庭学习库';

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    fm[key] = val;
  }
  return fm;
}
const splitList = (s) => (s ? s.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) : []);
const errorCodes = (s) => (s ? s.match(/E[1-9]/g) || [] : []);
const toMs = (d) => (d ? Date.parse(d) || null : null);

// 01-profiles/数学.md → subjectProfiles['数学']
function subjectProfile(fm) {
  return {
    subject: fm['学科'],
    textbook: fm['教材版本'] || null,
    progress: fm['进度'] || null,
    dimensions: splitList(fm['能力维度']),
    errors: errorCodes(fm['常见错误模式']),
  };
}
// 01-profiles/学习者.md (全局) → learner
function learnerObj(fm) {
  return {
    grade: fm['年级'] || null,
    stage: fm['学段'] || null,
    weeklyMinutes: parseInt(fm['每周可学习时间'], 10) || null,
    timeSlots: fm['常用时段'] ? [fm['常用时段']] : [],
    teachStyle: fm['讲解偏好'] || null,
    expectations: splitList(fm['期望']),
    selfFeeling: fm['自我感受'] || null,
    schoolProgress: fm['学校进度'] || null,
  };
}
// 03-sessions → tutor_sessions（messages 由正文段落序列化）
function sessionToCloud(fm, body) {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const messages = lines.map((content, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content,
    ts: (toMs(fm['日期']) || Date.now()) + i * 1000,
  }));
  return {
    subject: fm['学科'],
    grade: '',
    messages: messages.slice(0, 8), // 仅取前 8 段作为形态样例
    createdAt: toMs(fm['日期']),
    _localMeta_lossy: { 题目: fm['题目'], 知识点: fm['知识点'], 任务类型: fm['任务类型'] },
  };
}

const math = parseFrontmatter(readFileSync(`${LIB}/01-profiles/数学.md`, 'utf8'));
const globalFm = parseFrontmatter(readFileSync(`${LIB}/01-profiles/学习者.md`, 'utf8'));
const sessText = readFileSync(`${LIB}/03-sessions/2026-09-07-数学-10以内加减法与分步检查.md`, 'utf8');
const sessFm = parseFrontmatter(sessText);
const sessBody = sessText.split('\n---')[1] || '';

const users_i = {
  id: math['学习者编号'] || 'JY-001',
  grade: globalFm['年级'],
  learner: learnerObj(globalFm),
  subjectProfiles: { [math['学科']]: subjectProfile(math) },
};

console.log('=== hw_farm_user.data.users[i] (from 数学.md + 学习者.md) ===');
console.log(JSON.stringify(users_i, null, 2));
console.log('\n=== tutor_sessions (from 03-sessions, 前8段) ===');
console.log(JSON.stringify(sessionToCloud(sessFm, sessBody), null, 2));

// 基本断言：映射落地的关键字段不丢
const ok =
  users_i.id === 'JY-001' &&
  users_i.subjectProfiles['数学'].errors.includes('E7') &&
  users_i.learner.weeklyMinutes === 210 &&
  sessFm['学科'] === '数学';
console.log('\n[T1 VALIDATE]', ok ? 'PASS ✅ 映射可落地' : 'FAIL ❌');
process.exit(ok ? 0 : 1);

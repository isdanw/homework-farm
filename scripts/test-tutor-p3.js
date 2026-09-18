/**
 * test-tutor-p3.js —— 全科导学 P3 测试：九科路由 + tutorRetest 证据契约 + 复测页/报告页数据流
 * 运行：node scripts/test-tutor-p3.js
 */
const path = require('path');
const Module = require('module');

/* ---------- 固定 5 道复测题 ---------- */
const FIVE = [
  { q: '2+3=？', options: ['4', '5', '6', '7'], answer: 'B', analysis: '2+3=5' },
  { q: '3+5=？', options: ['7', '9', '8', '6'], answer: 'C', analysis: '3+5=8' },
  { q: '4+4=？', options: ['8', '7', '9', '6'], answer: 'A', analysis: '4+4=8' },
  { q: '5+6=？', options: ['10', '12', '13', '11'], answer: 'D', analysis: '5+6=11' },
  { q: '7+8=？', options: ['14', '15', '16', '17'], answer: 'B', analysis: '7+8=15' }
];
const QUESTIONS_JSON = JSON.stringify({ questions: FIVE });

/* ---------- mock @cloudbase/node-sdk ---------- */
const captured = {};
let genMode = 'reply'; // 'reply' | 'questions'
const mockTcb = {
  init: () => ({
    ai: () => ({
      createModel: () => ({
        generateText: async (args) => {
          captured.lastModel = args.model;
          captured.lastMessages = args.messages;
          return { text: genMode === 'questions' ? QUESTIONS_JSON : 'MOCK_REPLY' };
        }
      })
    }),
    database: () => ({
      collection: (name) => ({
        add: async ({ data }) => { captured.addName = name; captured.addData = data; return { id: 'mock_id' }; }
      }),
      createCollection: async () => {}
    })
  })
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@cloudbase/node-sdk') return mockTcb;
  return originalLoad.apply(this, arguments);
};

/* 云函数 + 元数据 */
const tutorChat = require(path.join(__dirname, '../cloudfunctions/tutorChat/index.js'));
const tutorRetest = require(path.join(__dirname, '../cloudfunctions/tutorRetest/index.js'));
const tutorSubjects = require('../miniprogram/utils/tutorSubjects.js');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}

(async () => {
  /* ============ 1. 九科路由 ============ */
  console.log('=== 1. 九科路由 ===');
  ok('tutorSubjects 共 9 科', tutorSubjects.TUTOR_SUBJECTS.length === 9);
  ok('物理可查到', tutorSubjects.getTutorSubject('physics').name === '物理');
  ok('道法可查到', tutorSubjects.getTutorSubject('politics').name === '道德与法治');
  ok('未知学科返回 null', tutorSubjects.getTutorSubject('xxx') === null);

  // tutorChat 支持新学科（物理）
  const rPhys = await tutorChat.main({ userInfo: { openId: 'o1' }, action: 'chat', subject: 'physics', content: '速度怎么算' });
  ok('物理学科导学返回 ok', rPhys.ok === true);
  const subMsg = captured.lastMessages.find(m => m.role === 'system' && m.content.indexOf('【物理】') >= 0);
  ok('注入了物理学科 prompt', !!subMsg);
  ok('仍拒绝未知学科', (await tutorChat.main({ action: 'chat', subject: 'foobar', content: 'x' })).code === 'bad_subject');

  /* ============ 2. tutorRetest generate ============ */
  console.log('=== 2. tutorRetest generate ===');
  genMode = 'questions';
  const g = await tutorRetest.main({
    userInfo: { openId: 'o1' }, action: 'generate',
    subject: 'math', topic: '20以内进位加法', errorType: 'E7', grade: '一年级'
  });
  ok('generate 返回 ok', g.ok === true);
  ok('生成 5 题', g.questions.length === 5);
  ok('每题含 4 选项 + 答案 + 解析', g.questions.every(q => q.options.length === 4 && q.answer && q.analysis));
  ok('无 topic → empty', (await tutorRetest.main({ action: 'generate', subject: 'math', topic: '' })).code === 'empty');
  ok('bad subject → bad_subject', (await tutorRetest.main({ action: 'generate', subject: 'xx', topic: 'x' })).code === 'bad_subject');

  /* ============ 3. judge 证据契约（硬编码） ============ */
  console.log('=== 3. judge 证据契约 ===');
  const judgeBase = { userInfo: { openId: 'o1' }, action: 'judge', subject: 'math', topic: '20以内进位加法', errorType: 'E7', questions: FIVE };

  // 全对 → pass
  const j5 = await tutorRetest.main({ ...judgeBase, answers: ['B', 'C', 'A', 'D', 'B'] });
  ok('全对 → pass=true 且 rate=1', j5.ok && j5.pass === true && j5.rate === 1 && j5.correct === 5);

  // 4/5 = 0.8 → pass（恰好达标）
  const j4 = await tutorRetest.main({ ...judgeBase, answers: ['B', 'C', 'A', 'D', 'X'] });
  ok('4/5=0.8 → pass=true（≥80%）', j4.pass === true && j4.rate === 0.8);

  // 3/5 = 0.6 → fail
  const j3 = await tutorRetest.main({ ...judgeBase, answers: ['B', 'C', 'A', 'X', 'X'] });
  ok('3/5=0.6 → pass=false', j3.pass === false && j3.rate === 0.6);
  ok('未达标给出 reason', !!j3.reason);

  // 题数不足 5 → fail
  const jFew = await tutorRetest.main({ ...judgeBase, questions: FIVE.slice(0, 4), answers: ['B', 'C', 'A', 'D'] });
  ok('题数不足 5 → pass=false', jFew.pass === false && jFew.reason.indexOf('题数不足') >= 0);

  // 落库检查
  ok('judge 写入 tutor_evidence 集合', captured.addName === 'tutor_evidence');
  ok('evidence doc 含 openid 隔离', captured.addData.openid === 'o1');
  ok('达标记录 passed=true', captured.addData.passed === false); // 最后一条是 jFew(不足5) → passed=false

  // 答案归一化：全角括号 / 空格 / 小写
  const jNorm = await tutorRetest.main({ ...judgeBase, answers: ['b', ' C ', '（a）', 'D', 'B'] });
  ok('答案归一化后全对 → pass', jNorm.correct === 5 && jNorm.pass === true);

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();

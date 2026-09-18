/**
 * test-tutor.js —— tutorChat 云函数核心逻辑单元测试（mock 依赖，不联网）
 * 运行：node scripts/test-tutor.js
 * 覆盖：chat 正常流程 / 参数校验 / archive 落库 / 频控
 */
const path = require('path');
const Module = require('module');

/* ---------- mock @cloudbase/node-sdk ---------- */
const captured = {};
const mockTcb = {
  init: () => ({
    ai: () => ({
      createModel: () => ({
        generateText: async (args) => {
          captured.lastModel = args.model;
          captured.lastMessages = args.messages;
          return { text: 'MOCK_REPLY' };
        }
      })
    }),
    database: () => ({
      collection: (name) => ({
        add: async ({ data }) => {
          captured.addName = name;
          captured.addData = data;
          return { id: 'mock_id' };
        }
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

const fn = require(path.join(__dirname, '../cloudfunctions/tutorChat/index.js'));

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}

(async () => {
  console.log('=== chat 正常流程（prompt 组装）===');
  const r1 = await fn.main({
    userInfo: { openId: 'openid_A' },
    action: 'chat', subject: 'math', content: '3+5=?',
    history: [{ role: 'user', content: '我不会加法' }, { role: 'assistant', content: '先数一数' }],
    learner: { grade: '一年级', teachStyle: '先提示后讲解', expectations: ['概念理解'] }
  });
  ok('返回 ok=true', r1.ok === true);
  ok('返回 MOCK_REPLY', r1.reply === 'MOCK_REPLY');
  ok('模型为 hy3', captured.lastModel === 'hy3');
  const msgs = captured.lastMessages;
  ok('第1条是主控 system（含「最小必要干预」）', msgs[0].role === 'system' && msgs[0].content.indexOf('最小必要干预') >= 0);
  ok('第2条是学科 system（含「数学」）', msgs[1].role === 'system' && msgs[1].content.indexOf('数学') >= 0);
  ok('历史 2 条被保留', msgs.length >= 4 && msgs[2].role === 'user' && msgs[3].role === 'assistant');
  const last = msgs[msgs.length - 1];
  ok('末条是 user 且含画像+本轮内容', last.role === 'user' && last.content.indexOf('一年级') >= 0 && last.content.indexOf('3+5=?') >= 0);

  console.log('=== chat 参数校验 ===');
  ok('空 subject → empty', (await fn.main({ action: 'chat', subject: '', content: 'x' })).code === 'empty');
  ok('不支持的学科 → bad_subject', (await fn.main({ action: 'chat', subject: 'foobar', content: 'x' })).code === 'bad_subject');
  ok('空 content → empty', (await fn.main({ action: 'chat', subject: 'math', content: '  ' })).code === 'empty');

  console.log('=== archive 落库 ===');
  const ra = await fn.main({
    userInfo: { openId: 'openid_A' }, action: 'archive', subject: 'math',
    messages: [{ role: 'user', content: '3+5', ts: 1 }, { role: 'assistant', content: '试试', ts: 2 }],
    learner: { grade: '一年级' }
  });
  ok('archive 返回 ok=true 且 id=mock_id', ra.ok === true && ra.id === 'mock_id');
  ok('写入集合 tutor_sessions', captured.addName === 'tutor_sessions');
  ok('doc 含 openid 隔离', captured.addData.openid === 'openid_A');
  ok('doc 含 2 条消息', captured.addData.messages.length === 2);
  ok('doc 消息 role 归一化', captured.addData.messages[0].role === 'user' && captured.addData.messages[1].role === 'assistant');

  console.log('=== archive 空消息 ===');
  ok('空 messages → empty', (await fn.main({ action: 'archive', messages: [] })).code === 'empty');

  console.log('=== 频控（6 秒内同 openid 第二次 chat 被限）===');
  await fn.main({ userInfo: { openId: 'openid_B' }, action: 'chat', subject: 'math', content: '1+1' });
  const r2 = await fn.main({ userInfo: { openId: 'openid_B' }, action: 'chat', subject: 'math', content: '1+2' });
  ok('第二次 chat → rate_limit', r2.code === 'rate_limit');

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();

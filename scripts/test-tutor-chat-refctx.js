/**
 * test-tutor-chat-refctx.js —— tutorChat「讲解材料召回 + 画像备忘」注入契约
 * 运行：node scripts/test-tutor-chat-refctx.js
 * 覆盖：refCtx 注入与截断 / 无 refCtx fail-open / 约束语齐全 / coachNote+replyLength 进画像 /
 *       画像免责口径 / chat 只读不写库（不破证据单写者）
 */
const path = require('path');
const Module = require('module');

/* ---------- mock @cloudbase/node-sdk（沿用 test-tutor-p3 的桩） ---------- */
const captured = {};
const mockTcb = {
  init: () => ({
    ai: () => ({ createModel: () => ({
      generateText: async (args) => {
        captured.lastModel = args.model;
        captured.lastMessages = args.messages;
        return { text: 'MOCK_REPLY' };
      }
    }) }),
    database: () => ({
      collection: (name) => ({
        add: async (arg) => { captured.addName = name; captured.addData = arg; return { id: 'mock_id' }; }
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

const tutorChat = require(path.join(__dirname, '../cloudfunctions/tutorChat/index.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (extra ? '  → ' + extra : '')); }
}
const sysBlocks = () => (captured.lastMessages || []).filter(m => m.role === 'system').map(m => m.content);
const userMsg = () => (captured.lastMessages || []).filter(m => m.role === 'user').pop() || {};
/** 限流按 openid 计数且每次调用都记账，每个用例用独立身份，避免互相打回 */
let oidSeq = 0;
const freshOpenid = () => 'refctx_case_' + (++oidSeq);

(async () => {
  const REF = '「比大小」（第三单元 比较与分类）\n  自测问法：哪边多哪边少？\n  讲解抓手：先看两边数量 → 再用 ＞＜＝';

  console.log('=== 1. refCtx 注入 ===');
  const r1 = await tutorChat.main({
    userInfo: { openId: freshOpenid() }, action: 'chat', subject: 'math',
    content: '比大小怎么想', refCtx: REF
  });
  ok('带召回材料导学成功', r1.ok === true && r1.reply === 'MOCK_REPLY', JSON.stringify(r1));
  ok('材料块进入 system', sysBlocks().some(c => c.indexOf('【本轮讲解材料') >= 0));
  ok('材料原文可见（讲解抓手）', sysBlocks().some(c => c.indexOf('＞＜＝') >= 0));
  ok('约束：材料不是本题答案', sysBlocks().some(c => c.indexOf('不是本题的标准答案') >= 0));
  ok('约束：不得拿来判对错', sysBlocks().some(c => c.indexOf('判孩子答得对不对') >= 0));
  ok('约束：禁止宣称已掌握', sysBlocks().some(c => c.indexOf('已掌握 / 学会了') >= 0));
  ok('约束：不向孩子逐条念材料', sysBlocks().some(c => c.indexOf('不要向孩子逐条念材料') >= 0));

  console.log('=== 2. 无 refCtx fail-open（老前端不受影响） ===');
  const r2 = await tutorChat.main({
    userInfo: { openId: freshOpenid() }, action: 'chat', subject: 'math', content: '2+3 怎么算'
  });
  ok('缺省字段仍正常导学', r2.ok === true);
  ok('未传材料则不出现材料块', !sysBlocks().some(c => c.indexOf('【本轮讲解材料') >= 0));

  console.log('=== 3. 长度上限（防 prompt 拖慢首字） ===');
  const LONG = 'X'.repeat(4000);
  await tutorChat.main({
    userInfo: { openId: freshOpenid() }, action: 'chat', subject: 'math', content: '比大小', refCtx: LONG
  });
  const refBlock = sysBlocks().find(c => c.indexOf('【本轮讲解材料') >= 0) || '';
  const body = refBlock.split('\n').filter(l => /^X+$/.test(l)).join('');
  ok('refCtx 截断到 1200 内', body.length <= 1200, 'got ' + body.length);

  console.log('=== 4. 家长偏好与辅导备忘进画像 ===');
  await tutorChat.main({
    userInfo: { openId: freshOpenid() }, action: 'chat', subject: 'math', content: '比大小',
    learner: { grade: '一年级', teachStyle: '先提示后讲解', replyLength: '简短些',
      expectations: ['概念理解'], coachNote: '容易漏看单位，读题指着字读两遍' }
  });
  const u1 = String(userMsg().content || '');
  ok('画像含讲解长度', u1.indexOf('讲解长度：简短些') >= 0, u1.slice(0, 200));
  ok('画像含辅导备忘', u1.indexOf('家长辅导备忘：容易漏看单位') >= 0);
  ok('画像带「不代表会或不会」免责', u1.indexOf('不代表孩子会或不会') >= 0);
  const rTrunc = await tutorChat.main({
    userInfo: { openId: freshOpenid() }, action: 'chat', subject: 'math', content: '比大小',
    learner: { coachNote: 'Y'.repeat(300) }
  });
  const u2 = String(userMsg().content || '');
  ok('备忘截断到 120 字', rTrunc.ok === true && u2.indexOf('Y'.repeat(120)) >= 0 && u2.indexOf('Y'.repeat(121)) < 0);

  console.log('=== 5. 与混合路线共存 ===');
  await tutorChat.main({
    userInfo: { openId: freshOpenid() }, action: 'chat', subject: 'math', content: '比大小',
    refCtx: REF, unitCtx: { title: '第三单元', points: [{ id: 'k1', topic: '比大小', status: 'uncovered' }] }
  });
  const blocks = sysBlocks();
  ok('单元清单块与材料块同时注入',
    blocks.some(c => c.indexOf('【本单元必会清单】') >= 0) && blocks.some(c => c.indexOf('【本轮讲解材料') >= 0));

  console.log('=== 6. chat 只读：不写任何集合（证据单写者不被绕过） ===');
  ok('chat 未触发数据库写入', captured.addName === undefined, 'wrote to ' + captured.addName);
  const r6 = await tutorChat.main({
    userInfo: { openId: freshOpenid() }, action: 'chat', subject: 'math',
    content: '比大小', refCtx: REF, learner: { coachNote: '备忘' }
  });
  ok('本轮仍未写库', r6.ok === true && captured.addName === undefined);

  console.log('\n════ tutorChat 召回注入：' + passed + ' 通过 / ' + failed + ' 失败 ════\n');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('用例异常', e); process.exit(1); });

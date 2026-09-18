/**
 * test-tutor-page.js —— 前端导学页数据流测试（mock wx/Page，验证 chat→多轮→archive 端到端）
 * 运行：node scripts/test-tutor-page.js
 */
const path = require('path');

/* ---------- mock wx ---------- */
const storage = {};
const calls = [];
global.wx = {
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  cloud: {
    callFunction: (o) => {
      calls.push(o);
      return Promise.resolve({
        result: o.data.action === 'chat'
          ? { ok: true, reply: 'AI回复内容' }
          : { ok: true, id: 'archive_id' }
      });
    }
  },
  showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
  navigateBack: () => {}
};

/* ---------- mock Page ---------- */
let pageDef;
global.Page = (def) => { pageDef = def; };

/* 真实加载页面（依赖 store/tutorStore/util/config 均为纯模块，无需再 mock） */
require(path.join(__dirname, '..//miniprogram/pkgGuide/tutor/tutor.js'));

const page = Object.create(pageDef);
page.data = JSON.parse(JSON.stringify(pageDef.data));
page.setData = function (patch, cb) {
  Object.keys(patch).forEach(k => { this.data[k] = patch[k]; });
  if (cb) cb();
};

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + '  → 实际: ' + JSON.stringify(arguments[2])); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('=== 页面初始化 ===');
  page.onLoad({});
  ok('onLoad 默认学科为数学', page.data.subject === 'math');
  ok('初始消息为空', page.data.messages.length === 0);
  ok('初始无会话', page.data.sessionId === '');

  console.log('=== 第一轮发送 ===');
  page.data.input = '3+5=?';
  page.send();
  ok('同步追加用户消息', page.data.messages.length === 1 && page.data.messages[0].role === 'user');
  ok('自动创建会话', !!page.data.sessionId);
  await sleep(20);
  ok('异步追加 AI 回复', page.data.messages.length === 2 && page.data.messages[1].role === 'assistant');
  ok('AI 回复内容正确', page.data.messages[1].content === 'AI回复内容');
  ok('调用了 tutorChat(chat)', calls.some(c => c.name === 'tutorChat' && c.data.action === 'chat'));

  console.log('=== 第二轮发送（history 组装）===');
  page.data.input = '我还是不会';
  page.send();
  await sleep(20);
  const chatCall = calls.filter(c => c.data.action === 'chat').pop();
  ok('第二轮 history 有 2 条（不含本轮 user）', chatCall.data.history.length === 2);
  ok('history 角色正确', chatCall.data.history[0].role === 'user' && chatCall.data.history[1].role === 'assistant');
  ok('本轮 content 单独传', chatCall.data.content === '我还是不会');

  console.log('=== 结束导学归档 ===');
  page.endSession();
  await sleep(20);
  const archCall = calls.find(c => c.data.action === 'archive');
  ok('调用了 tutorChat(archive)', !!archCall);
  ok('archive 传了完整 4 条消息', archCall.data.messages.length === 4);
  ok('归档后清空当前会话', page.data.messages.length === 0 && page.data.sessionId === '');

  console.log('=== 切换学科 ===');
  page.data.input = '背古诗';
  page.pickSubject({ currentTarget: { dataset: { key: 'chinese' } } });
  ok('切到语文后会话独立（消息为空）', page.data.subject === 'chinese' && page.data.messages.length === 0);

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();

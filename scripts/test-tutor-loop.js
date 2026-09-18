/**
 * test-tutor-loop.js —— 导学数据闭环前端全链路测试（S1-S4，mock wx / Page）
 * 覆盖：
 *   归档流：tutor 页归档 → 本地错题（id=clientId）→ 复习窗口落库 → pushQueue → push 回补上云 → 农场奖励（活动）
 *   回顾流：report 页今日回顾列表 → 去回顾 / 直接复测导航（带 mid）
 *   复测流：retest 页 mid 贯通 → advanceReview 推进/关闭 → 错题转已订正 → 证据入队
 *   同步流：mergeFromCloud 去重回填 / syncFromCloud 节流 / getLearnerContext 快照
 * 运行：node scripts/test-tutor-loop.js
 */
const path = require('path');

/* ---------- mock wx（可控的云函数响应） ---------- */
const storage = {};
const cloudCalls = [];
let chatResult = { ok: true, reply: 'MOCK' };
let pullResult = null;       // tutorSync pull 响应
let pushResult = { ok: true, added: 0, skipped: 0, updated: 0 };
const navigations = [];
let lastModal = null;
const toasts = [];
const DAY = 86400000;
let archiveDiagnosis = null; // archive 响应中的诊断（每次用例设置）

global.wx = {
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  removeStorageSync: (k) => { delete storage[k]; },
  cloud: {
    callFunction: (o) => {
      cloudCalls.push(o);
      const name = o.name, d = o.data || {};
      if (name === 'tutorChat' && d.action === 'archive') {
        // 等价真实云端行为：clientId 回显 + stuck 时派生 review（id/mistakeId 用请求里预生成的 uid）
        const diag = archiveDiagnosis || null;
        const result = {
          ok: true, id: 'cloud_s',
          diagnosis: diag,
          mistakeId: diag && diag.stuck ? 'cloud_mk' : '',
          review: null
        };
        if (diag && diag.stuck) {
          result.review = {
            id: d.reviewClientId, mistakeId: d.mistakeClientId,
            subject: d.subject, subjectName: '',
            topic: diag.topic, errorType: diag.errorType,
            stage: 1, dueAt: Date.now() + DAY, done: false, createdAt: Date.now()
          };
        }
        return Promise.resolve({ result: result });
      }
      if (name === 'tutorChat') return Promise.resolve({ result: chatResult });
      if (name === 'tutorSync' && d.action === 'pull') {
        return pullResult ? Promise.resolve({ result: pullResult }) : Promise.resolve({ result: { ok: false } });
      }
      if (name === 'tutorSync') return Promise.resolve({ result: pushResult });
      return Promise.resolve({ result: { ok: false } });
    }
  },
  showToast: (t) => { toasts.push(t); },
  showModal: (opts) => { lastModal = opts; opts.success && opts.success({ confirm: true, cancel: false }); },
  showLoading: () => {}, hideLoading: () => {},
  navigateTo: (o) => { navigations.push(o.url); },
  navigateBack: () => {}
};

/* ---------- mock Page ---------- */
const pageDefs = {};
let curFile = '';
global.Page = (def) => { pageDefs[curFile] = def; };

const tutorStore = require('../miniprogram/utils/tutorStore.js');
const store = require('../miniprogram/utils/store.js');
const engine = require('../miniprogram/utils/farmEngine.js');

const _load = (file) => {
  curFile = file;
  delete require.cache[require.resolve(file)];
  require(file);
};
_load('..//miniprogram/pkgGuide/tutor/tutor.js');
const tutorDef = pageDefs['..//miniprogram/pkgGuide/tutor/tutor.js'];
_load('..//miniprogram/pkgGuide/report/report.js');
const reportDef = pageDefs['..//miniprogram/pkgGuide/report/report.js'];
_load('..//miniprogram/pkgTools/mistakes/mistakes.js');
const mistakesDef = pageDefs['..//miniprogram/pkgTools/mistakes/mistakes.js'];
_load('..//miniprogram/pkgGuide/tutorHub/tutorHub.js');
const hubDef = pageDefs['..//miniprogram/pkgGuide/tutorHub/tutorHub.js'];

function makePage(def) {
  const p = Object.create(def);
  p.data = JSON.parse(JSON.stringify(def.data));
  p.setData = function (patch, cb) { Object.keys(patch).forEach(k => { this.data[k] = patch[k]; }); if (cb) cb(); };
  return p;
}

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const tutorPage = makePage(tutorDef);
  const reportPage = makePage(reportDef);
  const mkPage = makePage(mistakesDef);
  const hubPage = makePage(hubDef);

  /* ================= 1. 归档流（含 learnerCtx / 农场奖励） ================= */
  console.log('=== 1. 归档流：learnerCtx → 归档 → 复习窗口 → push → 农场奖励 ===');
  tutorPage.onLoad({ key: 'math' });
  tutorPage.onInput({ detail: { value: '9+8 好难' } });

  // 第一问（新会话）→ 应携带 learnerCtx（此刻为空串，字段存在即可）
  cloudCalls.length = 0;
  tutorPage.send();
  await sleep(20);
  const chatCall = cloudCalls.find(c => c.data.action === 'chat');
  ok('chat 调用发出', !!chatCall);
  ok('chat 载荷含 learnerCtx 字段（首轮注入）', chatCall && 'learnerCtx' in chatCall.data);

  // 预置一条数学错题 → 验证第二轮 learnerCtx 非空（跨会话记忆）
  tutorStore.addMistake({ subject: 'math', subjectName: '数学', topic: '凑十法', errorType: 'E2', errorDesc: '概念不清' });

  // 归档：使用 send() 真实创建的会话 id；消息直接写进 tutorStore（等价多轮后状态）
  const sessionId = tutorPage.data.sessionId;
  ok('send() 后已创建进行中会话', !!sessionId);
  const now = Date.now();
  tutorStore.appendMessage(sessionId, { role: 'assistant', content: '凑十试试', ts: now });
  tutorPage.data.messages = [{ role: 'user', content: '9+8', ts: now }, { role: 'assistant', content: '凑十试试', ts: now }];
  archiveDiagnosis = { topic: '20以内进位加法', stuck: true, errorType: 'E7', errorDesc: '运算失误', suggestion: '分步检查', done: false };
  cloudCalls.length = 0;
  toasts.length = 0;
  const sunBefore = store.get().farm.suns;
  tutorPage.endSession();
  await sleep(30);

  const localMk = tutorStore.getMistakes().find(m => m.topic === '20以内进位加法');
  ok('本地错题落库', !!localMk);
  const localRv = tutorStore.getReviews().find(r => r.mistakeId === localMk.id);
  ok('本地复习窗口落库且 mistakeId 与错题 id 一致', !!localRv);
  ok('review stage=1 且未关闭', localRv && localRv.stage === 1 && localRv.done === false);
  ok('review.id = 错题id + _rv（本地/云端约定一致）', localRv && localRv.id === localMk.id + '_rv');
  ok('会话已关闭（归档）', (() => {
    const s = tutorStore.getSessions().find(x => x.id === sessionId);
    return s && s.closed === true;
  })());

  const pushCall = cloudCalls.find(c => c.name === 'tutorSync' && c.data.action === 'push');
  ok('归档后触发 pushQueued（tutorSync push）', !!pushCall);
  ok('push 载荷含新会话（clientId 一致）', pushCall && pushCall.data.sessions.some(s => s.clientId === sessionId));
  ok('push 载荷含错题 + 复习窗口', pushCall && pushCall.data.mistakes.some(m => m.clientId === localMk.id) &&
    pushCall.data.reviews.some(r => r.clientId === localRv.id));
  await sleep(10);
  const rawAfterPush = storage[Object.keys(storage).find(k => k.indexOf('wb_hwfarm_tutor_v1') === 0)];
  ok('push 成功后队列清空', rawAfterPush.pushQueue.length === 0);

  // 农场奖励：只挂活动（归档），showModal confirm 后发放
  const gain = store.get().farm.suns - sunBefore;
  ok('归档后农场阳光 +1（TUTOR_SUN）', gain === 1);
  ok('奖励日志写入农场', store.get().farm.logs.some(l => l.text.indexOf('完成一次导学') >= 0));

  /* ================= 2. 报告页：今日回顾 ================= */
  console.log('=== 2. 报告页：今日回顾列表与导航 ===');
  // 把复习窗口到期时间拨到过去（模拟「次日到期」后孩子打开报告页）
  const rawKeyRv = Object.keys(storage).find(k => k.indexOf('wb_hwfarm_tutor_v1') === 0);
  const rawRv = storage[rawKeyRv];
  rawRv.reviews.find(r => r.mistakeId === localMk.id).dueAt = now - 1000;
  storage[rawKeyRv] = rawRv;

  reportPage.onShow();
  ok('到期复习窗口出现在今日回顾', reportPage.data.reviewList.length === 1);
  ok('回顾项带 mistakeId / stageText', reportPage.data.reviewList.length === 1 &&
    reportPage.data.reviewList[0].mistakeId === localMk.id &&
    reportPage.data.reviewList[0].stageText === '第 1 轮');

  navigations.length = 0;
  reportPage.goReview({ currentTarget: { dataset: { r: reportPage.data.reviewList[0] } } });
  ok('去回顾 → 导学页（复用订正上下文）', navigations[0].indexOf('/pkgGuide/tutor/tutor') === 0 && navigations[0].indexOf('topic=') >= 0);

  navigations.length = 0;
  reportPage.goReviewRetest({ currentTarget: { dataset: { r: reportPage.data.reviewList[0] } } });
  ok('直接复测 → 复测页且带 mid', navigations[0].indexOf('/pkgGuide/retest/retest') === 0 &&
    navigations[0].indexOf('mid=' + encodeURIComponent(localMk.id)) >= 0);

  /* ================= 3. 复测推进复习窗口 ================= */
  console.log('=== 3. 复测流：advanceReview + 错题转已订正 ===');
  tutorStore.advanceReview(localMk.id, false);   // 未达标
  let rvNow = tutorStore.getReviews().find(r => r.id === localRv.id);
  ok('未达标 → stage 2 + dueAt 顺延', rvNow.stage === 2 && rvNow.dueAt > now + DAY);
  tutorStore.advanceReview(localMk.id, true);    // 达标
  rvNow = tutorStore.getReviews().find(r => r.id === localRv.id);
  ok('达标 → 复习窗口关闭', rvNow.done === true);
  ok('达标项不再出现在今日回顾', tutorStore.getDueReviews().length === 0);

  tutorStore.setMistakeStatus(localMk.id, 'corrected');
  ok('达标后错题转已订正', tutorStore.getMistakes().find(m => m.id === localMk.id).status === 'corrected');

  /* ================= 4. 错题本 → 复测带 mid ================= */
  console.log('=== 4. 错题本复测导航带 mid ===');
  mkPage.onShow();
  const firstMk = mkPage.data.list[0];
  navigations.length = 0;
  mkPage.goRetest({ currentTarget: { dataset: { m: firstMk } } });
  ok('复测导航携带 mid', navigations[0].indexOf('mid=' + encodeURIComponent(firstMk.id)) >= 0);

  /* ================= 5. 同步流：merge / 节流 / learnerContext ================= */
  console.log('=== 5. 云端回填 merge + 节流 + 卡点快照 ===');
  pullResult = {
    ok: true,
    sessions: [{ id: 'ts_cloud_only', subject: 'chinese', subjectName: '语文', messages: [], createdAt: now - 5000 }],
    mistakes: [{ id: 'mk_cloud_only', subject: 'chinese', subjectName: '语文', topic: 'b/d 混淆', errorType: 'E2', status: 'pending', createdAt: now - 5000 }],
    evidence: [{ id: 'ev_cloud_only', subject: 'math', passed: true, total: 5, correct: 5, rate: 1, createdAt: now - 5000 }],
    reviews: [
      { id: 'mk_cloud_only_rv', mistakeId: 'mk_cloud_only', subject: 'chinese', subjectName: '语文', topic: 'b/d 混淆', stage: 1, dueAt: now - 1000, done: false, createdAt: now - 5000, updatedAt: now - 5000 }
    ]
  };
  // 清 lastSyncAt 触发 pull（写 storage 直接改）
  const rawKey = Object.keys(storage).find(k => k.indexOf('wb_hwfarm_tutor_v1') === 0);
  const raw = storage[rawKey];
  raw.lastSyncAt = 0;
  storage[rawKey] = raw;

  const merged = await tutorStore.syncFromCloud();
  ok('syncFromCloud 完成回填', !!merged && merged.added >= 4);
  ok('云端独有会话合并进本地（closed=true）', tutorStore.getSessions().some(s => s.id === 'ts_cloud_only' && s.closed));
  ok('云端独有错题合并进本地', tutorStore.getMistakes().some(m => m.id === 'mk_cloud_only'));
  ok('云端到期复习窗口合并进本地', tutorStore.getDueReviews().some(r => r.id === 'mk_cloud_only_rv'));

  // 节流：60 秒内第二次不发起 pull
  cloudCalls.length = 0;
  const merged2 = await tutorStore.syncFromCloud();
  ok('60 秒内重复 sync 被节流（返回 null 且无网络调用）', merged2 === null && !cloudCalls.some(c => c.data.action === 'pull'));

  // learnerContext：只取对应学科、含错因
  const ctx = tutorStore.getLearnerContext('math');
  ok('数学卡点快照含「进位加法」与 E7', ctx.indexOf('进位加法') >= 0 && ctx.indexOf('E7') >= 0);
  ok('数学卡点快照不含语文错题', ctx.indexOf('b/d') < 0);
  ok('无错题学科返回空串', tutorStore.getLearnerContext('english') === '');

  /* ================= 6. 导学中心静默同步入口 ================= */
  console.log('=== 6. 导学中心静默同步 ===');
  hubPage.onShow();
  ok('导学中心概览可渲染（含回填数据）', hubPage.data.overview.sessions >= 2);

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();

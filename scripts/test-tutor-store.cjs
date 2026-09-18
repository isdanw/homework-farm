/**
 * test-tutor-store.cjs —— tutorStore.js（导学数据链路 B）数据可靠性回归测试
 * ---------------------------------------------------------------------------
 * 覆盖 2026-09-18 数据持久化审计「第二批」的 F6 / F7 / F9：
 *   F6  mergeFromCloud 全字段透传（P1-1：字段白名单导致新字段换设备静默丢失）
 *   F7  写操作内部自动登记上云（P1-2：mistakes/confirm 漏推 → 标记订正永不进云）
 *       附：删除墓碑（removeSession 后 pull 不得复活）
 *   F9  绑定/身份恢复后继承 _guest 命名空间数据（P1-4：绑定后错题读不到）
 *
 * 纯 Node 运行（stub 掉 wx），不需要微信开发者工具、不需要云环境：
 *     node scripts/test-tutor-store.cjs
 *
 * 反证（证明用例真能抓到原缺陷）：
 *     mkdir -p /tmp/oldutils
 *     for f in store tutorStore util config; do git show HEAD:miniprogram/utils/$f.js > /tmp/oldutils/$f.js; done
 *     SRC_DIR=/tmp/oldutils node scripts/test-tutor-store.cjs     # 期望多处 ✗
 *
 * 设计要点：
 *   · 定时器全部虚拟化（不创建真实 timer），用例完全确定、无墙钟依赖；
 *     scheduleFlush 的合并推送靠 runTimers() 显式触发。
 *   · 每个用例清 require 缓存 + 清空内存存储，互不污染。
 */
const path = require('path');

const SRC_DIR = process.env.SRC_DIR
  ? path.resolve(process.env.SRC_DIR)
  : path.resolve(__dirname, '../miniprogram/utils');
const STORE_PATH = path.join(SRC_DIR, 'store.js');
const TUTOR_PATH = path.join(SRC_DIR, 'tutorStore.js');

const BASE_KEY = 'wb_hwfarm_data_v2';
const OPENID_KEY = 'wb_hwfarm_openid';
const TUTOR_KEY = 'wb_hwfarm_tutor_v1';

/* ------------------------------ 测试挂具 ------------------------------ */
let storage;          // Map<key, value>
let pushes;           // 收到的 tutorSync(push) 载荷
let pushCalls;        // push 调用次数
let pullResult;       // tutorSync(pull) 的返回
let behavior;         // { openid }

/* 虚拟定时器：不落真实 timer，避免墙钟抖动与跨用例泄漏 */
let timers = [];
let timerSeq = 0;
const _setTimeout = global.setTimeout;
const _clearTimeout = global.clearTimeout;
global.setTimeout = function (fn, ms) {
  const t = { id: ++timerSeq, fn: fn, ms: ms };
  timers.push(t);
  return t.id;
};
global.clearTimeout = function (id) { timers = timers.filter(t => t.id !== id); };
/** 执行所有待触发回调（模拟时间推进） */
function runTimers() { const list = timers; timers = []; list.forEach(t => t.fn()); }
function dropTimers() { timers = []; }

function resetEnv() {
  dropTimers();
  storage = new Map();
  pushes = [];
  pushCalls = 0;
  pullResult = { ok: true, sessions: [], mistakes: [], evidence: [], reviews: [] };
  behavior = { openid: '' };

  global.wx = {
    getStorageSync(k) {
      return storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : '';
    },
    setStorageSync(k, v) { storage.set(k, JSON.parse(JSON.stringify(v))); },
    removeStorageSync(k) { storage.delete(k); },
    showToast() {},
    cloud: {
      callFunction({ name, data }) {
        const action = data && data.action;
        if (name === 'syncData' && action === 'whoami') {
          return Promise.resolve({ result: behavior.openid ? { ok: true, openid: behavior.openid } : { ok: true } });
        }
        if (name === 'syncData' && action === 'download') {
          return Promise.resolve({ result: { ok: true, data: null } });
        }
        if (name === 'tutorSync' && action === 'push') {
          pushCalls++;
          pushes.push(JSON.parse(JSON.stringify(data || {})));
          return Promise.resolve({ result: { ok: true, added: 1, skipped: 0, updated: 0 } });
        }
        if (name === 'tutorSync' && action === 'pull') {
          return Promise.resolve({ result: pullResult });
        }
        return Promise.resolve({ result: { ok: true } });
      }
    }
  };
  global.getApp = () => ({ globalData: {} });

  // store 与 tutorStore 都必须清缓存：store 的 _openid / _root 是模块级状态
  delete require.cache[require.resolve(STORE_PATH)];
  delete require.cache[require.resolve(TUTOR_PATH)];
}

/** 全新加载 store（cloudReady=false，本套用例不关心主链路上云） */
function freshStore() {
  const s = require(STORE_PATH);
  s.setCloudReady(false);
  return s;
}

/** 以已确认身份启动（模拟缓存里有 openid 的正常路径） */
async function openidStore(oid) {
  storage.set(OPENID_KEY, oid);
  const s = freshStore();
  await s.initAccount();
  return s;
}

/** 读导学本地原始结构 */
function rawTutor(oid) { return storage.get(TUTOR_KEY + '_' + (oid || 'guest')) || null; }
function queue(oid) { const a = rawTutor(oid); return (a && a.pushQueue) || []; }
/** 清空待推队列，便于精确断言「本次操作是否登记了上云」 */
function clearQueue(oid) {
  const k = TUTOR_KEY + '_' + (oid || 'guest');
  const a = storage.get(k);
  if (a) { a.pushQueue = []; storage.set(k, a); }
}

/* ------------------------------ 断言 ------------------------------ */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
function group(name) { console.log('\n' + name); }

/* ============================== 用例 ============================== */
(async () => {
  console.log('被测源码：' + SRC_DIR);

  /* ---- T1: F6 云端错题文档全字段透传 ---- */
  group('T1  F6 云端错题全字段透传（新字段不再静默丢失）');
  resetEnv();
  {
    await openidStore('o1');
    const ts = require(TUTOR_PATH);
    ts.mergeFromCloud({
      sessions: [], evidence: [], reviews: [],
      mistakes: [{
        id: 'mk_c1', clientId: 'mk_c1', _id: 'doc_1', cloudId: 'doc_1', openid: 'o1',
        subject: 'chinese', subjectName: '语文', topic: 'b/p 不分',
        errorType: 'E2',
        status: 'archived',            // ← 未来新增的枚举值
        source: 'photo',
        imageUrl: 'cloud://mistakes/x.png',   // ← 未来新增字段
        ocrConfidence: 0.93,                  // ← 未来新增字段
        createdAt: 111
      }]
    });
    const list = ts.getMistakes();
    ok(list.length === 1, '云端错题已并入本地', 'len=' + list.length);
    const m = list[0] || {};
    ok(m.imageUrl === 'cloud://mistakes/x.png', '未知新字段 imageUrl 原样保留（旧实现丢弃）', m.imageUrl);
    ok(m.ocrConfidence === 0.93, '未知新字段 ocrConfidence 原样保留（旧实现丢弃）', m.ocrConfidence);
    ok(m.status === 'archived', '未知枚举值 status 不被强制归一（旧实现压成 pending）', m.status);
    ok(m.id === 'mk_c1', 'id 归一到 clientId', m.id);
    ok(m._id === undefined && m.openid === undefined && m.clientId === undefined && m.cloudId === undefined,
      '云端系统字段（_id/openid/clientId/cloudId）不落本地', JSON.stringify(m));
  }

  /* ---- T2: F6 会话 / 证据同样透传 ---- */
  group('T2  F6 会话与复测证据同样透传');
  resetEnv();
  {
    await openidStore('o1');
    const ts = require(TUTOR_PATH);
    ts.mergeFromCloud({
      mistakes: [], reviews: [],
      sessions: [{
        id: 'ts_1', clientId: 'ts_1', _id: 's1', subject: 'math', subjectName: '数学',
        messages: [{ role: 'user', content: 'hi', ts: 1 }],
        modelName: 'hy3',            // ← 未来新增字段
        createdAt: 100, closed: false
      }],
      evidence: [{
        id: 'ev_1', clientId: 'ev_1', _id: 'e1', subject: 'math', subjectName: '数学',
        topic: '退位减法', total: 6, correct: 5, rate: 0.83, passed: true,
        durationSec: 240,            // ← 未来新增字段
        createdAt: 200
      }]
    });
    const s = ts.getSessions()[0] || {};
    const e = ts.getEvidence()[0] || {};
    ok(s.modelName === 'hy3', '会话新字段 modelName 保留', s.modelName);
    ok(s.closed === false, '云端明确的 closed=false 不被强制改成 true（旧实现恒置 true）', s.closed);
    ok(e.durationSec === 240, '证据新字段 durationSec 保留', e.durationSec);
  }

  /* ---- T3: F6 reviews 云端更新 → 全字段覆盖 ---- */
  group('T3  F6 复习窗口：云端更新时全字段覆盖');
  resetEnv();
  {
    await openidStore('o1');
    const ts = require(TUTOR_PATH);
    ts.mergeFromCloud({
      sessions: [], mistakes: [], evidence: [],
      reviews: [{
        id: 'rv_1', clientId: 'rv_1', _id: 'r1', mistakeId: 'mk_1',
        subject: 'math', topic: '退位减法', stage: 3, dueAt: 999, done: false,
        createdAt: 100, updatedAt: 500
      }]
    });
    ok((ts.getReviews()[0] || {}).stage === 3, '首次并入 stage=3');
    // 另一台设备推进了窗口（云端 updatedAt 更大，且带本地未知字段）
    ts.mergeFromCloud({
      sessions: [], mistakes: [], evidence: [],
      reviews: [{
        id: 'rv_1', clientId: 'rv_1', mistakeId: 'mk_1', subject: 'math',
        stage: 4, dueAt: 1234, done: true, createdAt: 100, updatedAt: 900,
        advancedOn: 'phone-B'        // ← 未来新增字段
      }]
    });
    const r = ts.getReviews()[0] || {};
    ok(r.stage === 4 && r.done === true, '云端更新的进度已覆盖本地', 'stage=' + r.stage + ' done=' + r.done);
    ok(r.advancedOn === 'phone-B', '覆盖时新字段一并落地（旧实现只挑 4 个字段 copy）', r.advancedOn);
    ok(r.dueAt === 1234, 'dueAt 已更新', r.dueAt);
  }

  /* ---- T4: F6 reviews 本地更新 → 不被云端旧值覆盖 ---- */
  group('T4  F6 复习窗口：本地更新时不被云端旧值回退');
  resetEnv();
  {
    await openidStore('o1');
    const ts = require(TUTOR_PATH);
    ts.upsertReview({ id: 'rv_2', mistakeId: 'mk_2', subject: 'math', stage: 5, dueAt: 5000, done: true, createdAt: 100, updatedAt: 2000 });
    ts.mergeFromCloud({
      sessions: [], mistakes: [], evidence: [],
      reviews: [{ id: 'rv_2', clientId: 'rv_2', subject: 'math', stage: 2, dueAt: 300, done: false, createdAt: 100, updatedAt: 900 }]
    });
    const r = ts.getReviews()[0] || {};
    ok(r.stage === 5 && r.done === true, '本地更新的一侧胜出（不会回退）', 'stage=' + r.stage + ' done=' + r.done);
  }

  /* ---- T5: F7 setMistakeStatus 自动入队 ---- */
  group('T5  F7 标「已订正」自动登记上云（修 P1-2）');
  resetEnv();
  {
    await openidStore('o1');
    const ts = require(TUTOR_PATH);
    const m = ts.addMistake({ topic: '退位减法' });
    clearQueue('o1');
    ts.setMistakeStatus(m.id, 'corrected');        // 模拟 mistakes.js：只调这一个，不调 queuePush
    const q = queue('o1');
    ok(q.some(x => x.kind === 'mistakes' && x.id === m.id), 'setMistakeStatus 已自动登记上云队列（旧实现留空）', JSON.stringify(q));
    runTimers();
    await Promise.resolve();
    ok(pushCalls === 1, '自动触发了一次合并推送', 'pushCalls=' + pushCalls);
    const payload = pushes[0] || {};
    ok((payload.mistakes || []).some(x => x.clientId === m.id && x.status === 'corrected'),
      'push 载荷带上了该错题与 corrected 状态', JSON.stringify(payload.mistakes));
  }

  /* ---- T6: F7 每个写操作都自入队 ---- */
  group('T6  F7 写操作统一在数据层收口（调用方想漏也漏不掉）');
  resetEnv();
  {
    await openidStore('o1');
    const ts = require(TUTOR_PATH);

    const mk = ts.addMistake({ id: 'mk_a', topic: '拼音' });
    ok(queue('o1').some(x => x.kind === 'mistakes' && x.id === mk.id), 'addMistake 自动入队');

    const ev = ts.addEvidence({ id: 'ev_a', topic: '拼音', total: 5, correct: 4, passed: false });
    ok(queue('o1').some(x => x.kind === 'evidence' && x.id === ev.id), 'addEvidence 自动入队');

    // 复习窗口 id 刻意不叫 '<mistakeId>_rv'：旧代码在页面里硬编码该命名约定来入队，
    // 命名一变就静默漏推；现在由 upsertReview / advanceReview 用真实 id 登记。
    const rv = ts.upsertReview({ id: 'rv_custom_1', mistakeId: mk.id, subject: 'chinese', stage: 1 });
    ok(queue('o1').some(x => x.kind === 'reviews' && x.id === 'rv_custom_1'), 'upsertReview 用真实 id 入队');

    clearQueue('o1');
    ts.advanceReview(mk.id, false);
    const rq = queue('o1');
    ok(rq.length === 1 && rq[0].kind === 'reviews' && rq[0].id === 'rv_custom_1',
      'advanceReview 用真实 review id 入队（旧实现靠页面硬编码 <mistakeId>_rv，命名不符即漏推）', JSON.stringify(rq));

    clearQueue('o1');
    ts.closeSession(ts.newSession('math', '数学').id);
    ok(queue('o1').some(x => x.kind === 'sessions'), 'closeSession 自动入队（归档云函数失败时可回补）');
  }

  /* ---- T7: 删除墓碑，pull 不得复活 ---- */
  group('T7  F7 删除的会话不被 pull 复活');
  resetEnv();
  {
    await openidStore('o1');
    const ts = require(TUTOR_PATH);
    ts.mergeFromCloud({
      sessions: [{ id: 'ts_x', clientId: 'ts_x', subject: 'math', createdAt: 1, closed: true }],
      mistakes: [], evidence: [], reviews: []
    });
    ok(ts.getSessions().length === 1, '会话已并入');
    ts.removeSession('ts_x');
    ok(ts.getSessions().length === 0, '本地已删除');
    ts.mergeFromCloud({
      sessions: [{ id: 'ts_x', clientId: 'ts_x', subject: 'math', createdAt: 1, closed: true }],
      mistakes: [], evidence: [], reviews: []
    });
    ok(ts.getSessions().length === 0, '再次 pull 不会复活（旧实现会复活）', 'len=' + ts.getSessions().length);
    const raw = rawTutor('o1') || {};
    ok((raw.removed || []).some(t => t.kind === 'sessions' && t.id === 'ts_x'), '墓碑已登记');
  }

  /* ---- T8: F9 身份恢复 / 绑定后继承 _guest 数据 ---- */
  group('T8  F9 绑定微信后继承游客态数据');
  resetEnv();
  {
    // 1) 身份确认失败（whoami 拿不到 openid）→ 降级态，导学数据落 _guest
    storage.set(OPENID_KEY, '');
    const st = freshStore();
    st.setCloudReady(true);
    await st.initAccount();
    ok(st.getOpenid() === '', '起步处于未确认身份状态');
    const ts = require(TUTOR_PATH);
    ts.addMistake({ id: 'mk_g', topic: '拼音 b/p 不分', subject: 'chinese' });
    ok(!!rawTutor('guest'), '数据落在 _guest 命名空间');

    // 2) 身份恢复 → 用户点「绑定微信」
    behavior.openid = 'o1';
    const r = await st.bindWechat();
    ok(r.ok && r.changed === true, 'bindWechat 成功切换命名空间', JSON.stringify(r));

    // 3) 绑定后必须仍读得到（旧实现读不到 → 表现就是「绑定后错题少了一批」）
    const list = ts.getMistakes();
    ok(list.length === 1 && list[0].id === 'mk_g', '绑定后错题仍可见（旧实现此时为空）', 'len=' + list.length);
    ok(!storage.has(TUTOR_KEY + '_guest'), '_guest 空间已清理（避免下次重复并入）', JSON.stringify([...storage.keys()]));
  }

  /* ---- T9: F9 账号空间已有数据时按 id 合并，且待推队列一起迁移 ---- */
  group('T9  F9 账号空间已有数据时按 id 合并 + 队列跟随迁移');
  resetEnv();
  {
    storage.set(TUTOR_KEY + '_guest', {
      sessions: [],
      mistakes: [
        { id: 'mk_g', topic: 'guest 的错题', createdAt: 1 },
        { id: 'mk_same', topic: '重复的', createdAt: 2 }
      ],
      evidence: [], reviews: [],
      pushQueue: [{ kind: 'mistakes', id: 'mk_g' }],
      lastSyncAt: 0
    });
    storage.set(TUTOR_KEY + '_o1', {
      sessions: [],
      mistakes: [{ id: 'mk_same', topic: '账号已有的', createdAt: 3 }],
      evidence: [], reviews: [], pushQueue: [], lastSyncAt: 0
    });
    await openidStore('o1');
    const ts = require(TUTOR_PATH);
    const list = ts.getMistakes();
    ok(list.length === 2, '按 id 合并后共 2 条（guest 的 mk_g + 账号已有的 mk_same）', 'len=' + list.length);
    ok(list.filter(m => m.id === 'mk_same').length === 1, '同 id 不产生重复');
    ok(list.find(m => m.id === 'mk_same').topic === '账号已有的', '同 id 以账号空间已有条目为准');
    ok(queue('o1').some(x => x.kind === 'mistakes' && x.id === 'mk_g'),
      'guest 的待推队列跟随迁移（否则那条错题永远推不上云）', JSON.stringify(queue('o1')));
  }

  /* ---- T10: F9 未确认身份时绝不消费 guest 空间 ---- */
  group('T10 F9 未确认身份时不动 guest 空间（防止误删）');
  resetEnv();
  {
    storage.set(TUTOR_KEY + '_guest', {
      sessions: [], mistakes: [{ id: 'mk_g', topic: 'x', createdAt: 1 }],
      evidence: [], reviews: [], pushQueue: [], lastSyncAt: 0
    });
    const st = freshStore();
    await st.initAccount();                 // 无 openid
    const ts = require(TUTOR_PATH);
    const list = ts.getMistakes();
    ok(list.length === 1, '仍能读到 guest 数据');
    ok(storage.has(TUTOR_KEY + '_guest'), 'guest 空间未被删除');
  }

  /* ---- T11: F7 合并推送（连续写操作只发一次云调用） ---- */
  group('T11 F7 合并推送：连续 3 次写操作只触发 1 次云调用');
  resetEnv();
  {
    await openidStore('o1');
    const ts = require(TUTOR_PATH);
    ts.addMistake({ id: 'mk_1', topic: 'a' });
    ts.addMistake({ id: 'mk_2', topic: 'b' });
    ts.upsertReview({ id: 'rv_1', mistakeId: 'mk_1' });
    ok(pushCalls === 0, '尚未到防抖时点，一次都没发', 'pushCalls=' + pushCalls);
    runTimers();
    ok(pushCalls === 1, '防抖到点后只发 1 次', 'pushCalls=' + pushCalls);
    const payload = pushes[0] || {};
    ok((payload.mistakes || []).length === 2 && (payload.reviews || []).length === 1,
      '一次调用带上全部 3 条待推数据',
      'mistakes=' + (payload.mistakes || []).length + ' reviews=' + (payload.reviews || []).length);
  }

  /* ------------------------------ 汇总 ------------------------------ */
  console.log('\n' + '─'.repeat(52));
  if (fail) {
    console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + '   ✗ 有失败');
    process.exit(1);
  }
  console.log('通过 ' + pass + ' / 共 ' + pass + '   ✓ 全部通过');
  process.exit(0);
})();

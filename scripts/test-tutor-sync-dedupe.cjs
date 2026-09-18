/**
 * test-tutor-sync-dedupe.cjs —— tutorRetest / tutorSync 证据重复写入修复的回归测试
 * ---------------------------------------------------------------------------
 * 覆盖审计报告 P0-5：每次复测在 tutor_evidence 里留下两份记录（一份无 clientId 的
 * 云函数直写 + 一份带 clientId 的 push 回补），导致云端与本地双双翻倍、「已掌握」计数虚高。
 *
 * 用假的 @cloudbase/node-sdk 驱动**真实的云函数源码**，不需要部署、不需要连云端：
 *     node scripts/test-tutor-sync-dedupe.cjs
 *
 * 反证（用改动前的版本跑同一套用例，应看到重复）：
 *     git show HEAD:cloudfunctions/tutorSync/index.js > /tmp/old-tutorSync.js
 *     SYNC_PATH=/tmp/old-tutorSync.js node scripts/test-tutor-sync-dedupe.cjs
 */
const path = require('path');
const Module = require('module');

const SYNC_PATH = process.env.SYNC_PATH || path.resolve(__dirname, '../cloudfunctions/tutorSync/index.js');

/* --------------------- 极简内存 DB（够 tutorSync 用） --------------------- */
let seq = 0;
function makeDb() {
  const colls = new Map();
  function coll(name) { if (!colls.has(name)) colls.set(name, []); return colls.get(name); }
  const clone = v => JSON.parse(JSON.stringify(v));
  const match = (doc, q) => Object.keys(q).every(k => doc[k] === q[k]);

  return {
    _colls: colls,
    createCollection(name) { coll(name); return Promise.resolve({}); },
    collection(name) {
      return {
        where(q) {
          const chain = { _q: q || {}, _limit: 1e9, _order: null };
          chain.limit = n => { chain._limit = n; return chain; };
          chain.orderBy = (f, dir) => { chain._order = { f, dir }; return chain; };
          chain.get = () => {
            let rows = coll(name).filter(d => match(d, chain._q));
            if (chain._order) {
              const { f, dir } = chain._order;
              rows = rows.slice().sort((a, b) => dir === 'desc' ? (b[f] || 0) - (a[f] || 0) : (a[f] || 0) - (b[f] || 0));
            }
            return Promise.resolve({ data: rows.slice(0, chain._limit).map(clone) });
          };
          return chain;
        },
        add(obj) {
          const d = Object.assign({ _id: 'id_' + (++seq) }, clone(obj));
          coll(name).push(d);
          return Promise.resolve({ id: d._id });
        },
        doc(id) {
          return {
            update(patch) {
              const d = coll(name).find(x => x._id === id);
              if (!d) return Promise.reject(new Error('doc not found'));
              Object.assign(d, clone(patch));
              return Promise.resolve({ updated: 1 });
            }
          };
        }
      };
    }
  };
}

/* --------------------- 拦截 @cloudbase/node-sdk --------------------- */
let db;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@cloudbase/node-sdk') return { init: () => ({ database: () => db }) };
  return origLoad.apply(this, arguments);
};

function loadSync() {
  db = makeDb();
  delete require.cache[require.resolve(SYNC_PATH)];
  return require(SYNC_PATH);
}

/* ------------------------------ 断言 ------------------------------ */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(n) { console.log('\n' + n); }
const T = 1758000000000;   // 固定时间戳，保证「同一天」

const legacyDoc = () => ({
  openid: 'o1', subject: 'math', topic: '两位数进位加', errorType: 'E2',
  total: 5, correct: 4, rate: 0.8, passed: false, createdAt: T
});
const newEvidence = (cid) => ({
  openid: 'o1', clientId: cid, subject: 'math', topic: '两位数进位加', errorType: 'E2',
  subjectName: '数学', total: 5, correct: 4, rate: 0.8, passed: false, createdAt: T
});

(async () => {
  /* ---- T1: 云端已有「无 clientId 的直写记录」→ push 必须认领它，而不是再插一条 ---- */
  group('T1  push 认领无 clientId 的旧证据，不再新增重复');
  {
    const sync = loadSync();
    db.collection('tutor_evidence').add(legacyDoc());
    const seeded = db._colls.get('tutor_evidence').length;

    const r = await sync.main({ action: 'push', userInfo: { openId: 'o1' }, evidence: [newEvidence('ev_1')] });
    const rows = db._colls.get('tutor_evidence');
    ok(r.ok === true, 'push 返回 ok');
    ok(rows.length === seeded, '证据条数未增加（旧实现会 +1 变成两条）', 'seeded=' + seeded + ' now=' + rows.length);
    ok(rows.filter(d => d.clientId === 'ev_1').length === 1, '旧记录已被认领并写入 clientId');
    ok(r.updated === 1 && r.added === 0, '计为 updated 而非 added', JSON.stringify({ added: r.added, updated: r.updated }));
  }

  /* ---- T2: pull 不再把同一份证据返回两次 ---- */
  group('T2  pull 返回的证据不再重复');
  {
    const sync = loadSync();
    db.collection('tutor_evidence').add(legacyDoc());                 // 旧直写（无 clientId）
    db.collection('tutor_evidence').add(newEvidence('ev_1'));         // push 回补（有 clientId）
    const r = await sync.main({ action: 'pull', userInfo: { openId: 'o1' } });
    ok(r.ok === true, 'pull 返回 ok');
    ok(r.evidence.length === 1, '同一份证据折叠成 1 条（旧实现返回 2 条）', 'len=' + r.evidence.length);
    ok(r.evidence[0].clientId === 'ev_1', '保留的是带 clientId 的那份');
  }

  /* ---- T3: 两次「真实复测」不能被误折叠 ---- */
  group('T3  真正等分的两次复测都要保留');
  {
    const sync = loadSync();
    db.collection('tutor_evidence').add(Object.assign(newEvidence('ev_1'), {}));
    db.collection('tutor_evidence').add(Object.assign(newEvidence('ev_2'), {}));
    const r = await sync.main({ action: 'pull', userInfo: { openId: 'o1' } });
    ok(r.evidence.length === 2, '两条都带 clientId → 视为两次真实复测，都保留', 'len=' + r.evidence.length);
  }

  /* ---- T4: 端到端 —— 复测一次后云端恰好只有一条 ---- */
  group('T4  端到端：一次复测只产生一条证据');
  {
    const sync = loadSync();
    // 模拟 tutorRetest 直写（改动后已带 clientId），随后前端 push 同一份
    db.collection('tutor_evidence').add(newEvidence('ev_9'));
    const r = await sync.main({ action: 'push', userInfo: { openId: 'o1' }, evidence: [newEvidence('ev_9')] });
    const rows = db._colls.get('tutor_evidence');
    ok(rows.length === 1, '云端恰好 1 条', 'len=' + rows.length);
    ok(r.skipped === 1, 'push 判定为已存在并跳过', 'skipped=' + r.skipped);
  }

  /* ---- T5: 隔离性 —— 不串到别人的 openid ---- */
  group('T5  仍然按 openid 隔离');
  {
    const sync = loadSync();
    db.collection('tutor_evidence').add(Object.assign(legacyDoc(), { openid: 'o2' }));
    const r = await sync.main({ action: 'push', userInfo: { openId: 'o1' }, evidence: [newEvidence('ev_1')] });
    const rows = db._colls.get('tutor_evidence');
    const o2 = rows.filter(d => d.openid === 'o2');
    ok(o2.length === 1 && !o2[0].clientId, '别人的记录未被认领 / 未被改写');
    ok(r.added === 1, 'o1 自己那条正常新增', 'added=' + r.added);
  }

  /* ---- T6: 无 openid 直接拒绝（不产生无主数据） ---- */
  group('T6  没有身份时拒绝写入');
  {
    const sync = loadSync();
    const r = await sync.main({ action: 'push', evidence: [newEvidence('ev_1')] });
    ok(r.ok === false && r.code === 'no_openid', '返回 no_openid', JSON.stringify(r));
    ok((db._colls.get('tutor_evidence') || []).length === 0, '没有产生无主数据');
  }

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n挂具异常:', e); process.exit(2); });

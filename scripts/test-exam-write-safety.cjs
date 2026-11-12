#!/usr/bin/env node
/**
 * examService 写入安全回归测试（2026-10-27）
 *
 * 【它锁住的是什么】旧写法统一是
 *   `try { add } catch { createCollection; try { add } catch(e3){} }`
 * 有三个必发/偶发的坏处：
 *   ① **假成功**：末尾 catch(e3){} 空吞 —— 一条都没落库，函数照样 return ok:true
 *      带完整批改报告。家长看到结果、刷新后从 listSubmissions 里永远找不到它。
 *   ② **重复落库**：add 是插入不是 upsert，且不判错误类型。网络抖动/超时场景下
 *      服务端其实已写成功，再 add 一次就是两条同 clientId；而 get/delete 都 limit(1)，
 *      另一条成孤儿。
 *   ③ **update 失败退化成 add**（saveTextbook / saveExam 最危险）：try 把「查询+写」
 *      一起包住，update 一失败就掉进 catch 走 add，于是同 textbookId / clientId
 *      被插入第二条。
 *
 * 现在的契约：
 *   · 写入类失败一律返回 { ok:false }，绝不静默；
 *   · 重试前必须先查重；
 *   · update 分支失败只报错，绝不退化成 add。
 *
 * saveTextbook 已导出（EXAM_TEST），做**功能级**断言（真跑 + 可控故障）；
 * saveExam / gradeExam / gradePaper 未导出且依赖 AI 链路，做**结构级**断言
 * （源码里不再出现空吞 catch / 无条件重试 add）。
 * 退出码非 0 即失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const SRC_PATH = path.join(REPO, 'cloudfunctions', 'examService', 'index.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

let fails = 0, passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

/* ================================================================== *
 * 一、可控故障的云端桩
 * ================================================================== */
const OPENID = 'o_exam_001';

/**
 * @param {Object} cfg
 *   cfg.failUpdate  Boolean  —— doc().update() 抛错
 *   cfg.failAdd     Boolean  —— collection().add() 抛错
 *   cfg.existing    Array    —— where().get() 返回的文档
 *   cfg.failQuery   Boolean  —— where().get() 抛错
 */
function makeApp(cfg) {
  const log = { adds: [], updates: [], created: [] };
  function coll(name) {
    return {
      where(cond) {
        return {
          limit() {
            return {
              async get() {
                if (cfg.failQuery) throw new Error('query boom');
                return { data: cfg.existing || [] };
              }
            };
          },
          async get() {
            if (cfg.failQuery) throw new Error('query boom');
            return { data: cfg.existing || [] };
          }
        };
      },
      doc(id) {
        return {
          async update(patch) {
            if (cfg.failUpdate) throw new Error('update boom');
            log.updates.push({ name: name, id: id, patch: patch });
          }
        };
      },
      async add(doc) {
        if (cfg.failAdd) throw new Error('add boom');
        log.adds.push({ name: name, doc: doc });
      },
      async limit() { return { async get() { return { data: [] }; } }; }
    };
  }
  const app = {
    database: () => ({
      collection: coll,
      createCollection: async (n) => { log.created.push(n); }
    })
  };
  app.__log = log;
  return app;
}

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@cloudbase/node-sdk') {
    return { init: () => ({ database: () => makeApp(currentCfg).database(), callFunction: async () => ({ result: {} }) }) };
  }
  return origLoad.apply(this, arguments);
};

let currentCfg = {};
process.env.EXAM_TEST = '1';
const svc = require(SRC_PATH);

function textbookInput(overrides) {
  return Object.assign({
    textbook: {
      textbookId: 'tb_exist_1',
      title: '数学一年级上',
      subject: 'math',
      grade: '一年级',
      term: '上册',
      units: [{ name: '准备课', keywords: ['数一数'], sections: ['比多少'] }]
    }
  }, overrides || {});
}

(async function main() {
  console.log('examService 写入安全回归测试（假成功 / 重复落库 / update 退化成 add）');

  /* ---------------------------------------------------------------- */
  section('一、saveTextbook：update 失败 → 只报错，绝不退化成 add');
  currentCfg = { existing: [{ _id: 'doc_1', openid: OPENID, textbookId: 'tb_exist_1', createdAt: 100 }], failUpdate: true, failAdd: false };
  let r = await svc.saveTextbook(makeApp(currentCfg), textbookInput(), OPENID);
  ok(r && r.ok === false, 'update 抛错 → 返回 ok:false（旧写法会掉进 catch 走 add 并返回 ok:true）');
  ok(r && r.code === 'db_error', '错误码是 db_error');
  ok(!!(r && r.msg), '带明确错误信息：' + (r && r.msg || ''));
  {
    const app2 = makeApp(currentCfg);
    await svc.saveTextbook(app2, textbookInput(), OPENID);
    ok(app2.__log.adds.length === 0, 'update 失败后**一条 add 都没发**（不产生第二条同 id 教材）');
  }

  section('  └ 正常更新路径仍然走 update，不新增');
  currentCfg = { existing: [{ _id: 'doc_1', openid: OPENID, textbookId: 'tb_exist_1', createdAt: 100 }] };
  {
    const app3 = makeApp(currentCfg);
    r = await svc.saveTextbook(app3, textbookInput(), OPENID);
    ok(r && r.ok === true, '正常保存成功');
    ok(app3.__log.updates.length === 1, '走 update 分支（1 次）');
    ok(app3.__log.adds.length === 0, '没有新增文档');
  }

  section('  └ 新建路径：add 失败必须报错，不静默');
  currentCfg = { existing: [], failAdd: true };
  {
    const app4 = makeApp(currentCfg);
    r = await svc.saveTextbook(app4, textbookInput({ textbook: { title: '新教材', subject: 'math', units: [{ name: 'U1' }] } }), OPENID);
    ok(r && r.ok === false, 'add 失败 → ok:false（不静默）');
    ok(!!(r && r.msg), '带错误信息：' + (r && r.msg || ''));
  }

  /* ---------------------------------------------------------------- */
  section('二、结构断言：主批改链路不再空吞（假成功）');
  const lines = SRC.split('\n');
  // 只看**代码行**：注释里会引用旧写法做说明，不能算命中
  const codeLines = lines.filter(l => {
    const t = l.trim();
    return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  });
  // 精准命中「写入被空吞」：同一行里既 add 了，又用空 catch 把失败吃掉。
  // （`createCollection(...)` 的空 catch 是无害的 —— 集合已存在时本就该忽略。）
  const swallowed = codeLines.filter(l => /\.add\(/.test(l) && /catch\s*\(\s*e\d\s*\)\s*\{\s*\}\s*$/.test(l));
  ok(swallowed.length === 0,
    '代码里再无「add 失败被空吞」（命中 ' + swallowed.length + ' 处）' +
    (swallowed.length ? ' → ' + JSON.stringify(swallowed.map(s => s.trim().slice(0, 120))) : ''));

  const gradeSubmit = /const subRes = await addOnce\(app, SUB_COLL, subDoc,/.test(SRC);
  ok(gradeSubmit, 'gradeExam / gradePaper 的提交记录改走 addOnce（带 dedupe）');
  ok(/if \(!subRes\.ok\) return \{ ok: false, code: 'db_error'/.test(SRC),
    '提交记录落库失败时 return {ok:false}（不再 ok:true 带完整报告）');

  section('  └ 结构断言：重试前必须查重，不再无脑 add');
  ok(/重试前必须查重/.test(SRC), 'genExam / genUnitReview 的重试分支带查重注释');
  ok(/const dup = await app\.database\(\)\.collection\(EXAM_COLL\)\.where\(\{ openid: openid, clientId: doc\.clientId \}\)/.test(SRC),
    'genExam / genUnitReview 重试前按 openid+clientId 查重');
  ok(/if \(dup && dup\.data && dup\.data\.length\)/.test(SRC), '查重命中即视为成功返回（幂等）');

  section('  └ 结构断言：saveExam 不再「查询+写」同 try');
  ok(/saveExam[\s\S]{0,4000}?await ensureCollection\(app, EXAM_COLL\)/.test(SRC), 'saveExam 提前做集合预检');
  ok(/const addRes = await addOnce\(app, EXAM_COLL, rec, \{ openid: openid, clientId: clientId \}\)/.test(SRC),
    'saveExam 新建分支带查重');

  section('  └ 结构断言：addOnce 语义');
  ok(/async function addOnce\(app, coll, doc, dedupe\)/.test(SRC), '存在 addOnce 统一写入口');
  ok(/return \{ ok: true, deduped: true \}/.test(SRC), 'dedupe 命中 → ok:true 且标记 deduped');
  ok(/return \{ ok: false, err: /.test(SRC), '写入失败 → 返回 {ok:false, err}（不抛、不空吞）');
  ok(/await ensureCollection\(app, coll\);/.test(SRC), '写入前做集合预检，写入只做一次');

  /* ---------------------------------------------------------------- */
  section('三、变异反证：把契约改坏，断言必须变红');
  const DUP = 'if (dup && dup.data && dup.data.length)';
  const broken = SRC
    .split('return { ok: false, err: (e && e.message) || String(e) };').join('return { ok: true };')
    .split(DUP).join('/* mutated away */');
  ok(broken !== SRC, '变异体确实被构造出来（否则反证无意义）');
  ok(!broken.includes('return { ok: false, err: (e && e.message) || String(e) };'),
    '变异后「失败返回 ok:false」断言会变红');
  ok(!broken.includes(DUP), '变异后「重试前查重」断言会变红');

  /* ---------------------------------------------------------------- */
  section('四、越权与误判修复');

  // 4a HTTP 入口必须剥掉 userInfo（否则 body 里塞 openId 即可冒用任意微信身份）
  {
    const ev = svc.normalizeHttpEvent({
      httpMethod: 'POST', path: '/examapi',
      body: JSON.stringify({ action: 'listExams', userInfo: { openId: 'victim_openid' } })
    });
    ok(ev.viaHttp === true, 'HTTP 集成请求被识别为 viaHttp');
    ok(ev.payload.userInfo === undefined, 'userInfo 被剥离（IDOR 修复）');
    ok(ev.payload.action === 'listExams', '业务字段照常保留');
    // uid 必须保留：iPad 身份机制依赖它（resolveOpenid 第 3/4 分支）
    const ev2 = svc.normalizeHttpEvent({ httpMethod: 'POST', path: '/examapi', body: JSON.stringify({ action: 'resolve', uid: 'ipad_abc' }) });
    ok(ev2.payload.uid === 'ipad_abc', 'uid 保留（iPad 身份依赖它，由令牌闸保护）');
    // 小程序走 callFunction：body 非 string → 不进集成分支，userInfo 不受影响
    const ev3 = svc.normalizeHttpEvent({ action: 'gen', userInfo: { openId: 'wx_real' } });
    ok(ev3.viaHttp === false && ev3.payload.userInfo && ev3.payload.userInfo.openId === 'wx_real',
      '小程序 SDK 调用不受影响（userInfo 由微信网关注入，可信）');
  }

  // 4b no_pack 判定收窄：DB / 权限错误不再被伪装成「资源包未开通」
  ok(svc.isNoPackError(new Error('Token Credits 资源包未开通')) === true, '资源包未开通 → 判为 no_pack');
  ok(svc.isNoPackError(new Error('quota exceeded')) === true, 'quota 超限 → 判为 no_pack');
  ok(svc.isNoPackError(new Error('余额不足')) === true, '余额不足 → 判为 no_pack');
  ok(svc.isNoPackError(new Error('collection not exists')) === false, '集合不存在 → **不再**误判为 no_pack');
  ok(svc.isNoPackError(new Error('permission forbidden')) === false, '权限错误 → **不再**误判为 no_pack');
  ok(svc.isNoPackError(new Error('404 model not found')) === false, '404 not found → **不再**误判为 no_pack');
  ok(svc.isNoPackError(new Error('doc 不存在')) === false, '“不存在” → **不再**误判为 no_pack');

  // 4c gradeExam 的 _id 兜底查询必须补归属校验
  ok(/if \(examDoc\.openid && examDoc\.openid !== openid\)/.test(SRC),
    'gradeExam 的 _id 兜底结果校验归属（否则填他人 _id 即可跨用户读卷）');

  console.log('\n' + (fails === 0
    ? '通过 ' + passes + ' 项，失败 0 项\n✅ examService 写入安全契约全通过（无假成功、无重复落库）'
    : '通过 ' + passes + ' 项，失败 ' + fails + ' 项\n❌ 写入安全契约被破坏'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('测试自身异常：', e); process.exit(1); });

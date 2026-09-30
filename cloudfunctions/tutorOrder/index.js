/**
 * 云函数 tutorOrder —— 全科导学「学习单」写入口（小程序侧，openid 通道）
 * ============================================================
 * 职责：把「出单 → 豆包执行 → 回执 → 评语与汇总」的**状态变更**落进集合 `tutor_orders`。
 *
 * 设计原则（不可破坏）：
 *   · 业务判定**一律不在本文件**。全部在 `orderActions.js`（纯逻辑）+ `orderKit.js`（单引擎），
 *     本文件只做「node-sdk ↔ deps 接口」的适配。这样小程序通道与网页通道共用同一份状态机，
 *     O1–O4 四条硬契约不会分叉。
 *   · 两个 order*.js 是 canonical 副本，**禁止手改**（改 canonical 后跑 scripts/sync-order-kit.mjs）。
 *   · 纯数据搬运：**不调用 AI**（AI 润色是独立 action `polish`，失败必须静默回落）。
 *   · O3 红线：本函数只写 `tutor_orders` 一个集合，**绝不触碰** tutor_evidence /
 *     tutor_mistakes / tutor_reviews / knowledgePoints[].status。回执不是证据。
 *   · openid 为空一律拒绝（no_openid）——绝不产生无主数据。
 *
 * 入参（event）：
 *   { action, ...payload }
 *   action ∈ list | get | issue | copied | submit | tick | close | cancel | void | reissue | polish
 *
 * 出参：{ ok:true, ... } 或 { ok:false, code, msg }
 *   错误码：no_openid · bad_action · bad_param · no_anchor · not_found · plan_mismatch ·
 *           already_submitted · bad_transition · bad_receipt · evaluate_error · init · order_error
 *
 * 部署后自检：invokeFunction 空参 → 必须返回 { ok:false, code:'no_openid' }
 */
const tcb = require('@cloudbase/node-sdk');

const kit = require('./orderKit');
const actions = require('./orderActions').createActions(kit);
const { makeDeps } = require('./orderCloudDeps');

const COLL = 'tutor_orders';

/* ---------------- AI 润色（话术层，失败静默回落） ---------------- */

/**
 * 只润色「已经由规则算出来」的评语，**不得新增任何事实、不得给掌握结论**。
 * 任何失败（断网 / 资源包未开通 / 模型幻觉）都静默回落规则版，不阻塞闭环。
 */
const POLISH_PROMPT =
  '你是「学习单评语」的文字编辑。下面给你一份【事实】和一份【规则评语】。\n' +
  '只允许把规则评语改写得更自然、更口语、更适合给孩子和家长看，长度相近（不超过 120 字）。\n\n' +
  '硬约束（违反即失败）：\n' +
  '1. 只能使用【事实】里出现的信息，不得新增任何事实、数字、题目、孩子原话或训练过程。\n' +
  '2. 不得给出「已掌握 / 已精通 / 学会了 / 完全懂了 / 完全掌握 / 稳稳掌握」这类结论。\n' +
  '3. 不得改变「达标 / 部分达标 / 未达标 / 证据不足」这个结论本身。\n' +
  '4. 只输出改写后的评语正文，不要任何解释、不要 markdown、不要引号。';

async function polishComment(app, order) {
  const ai = app.ai();
  const model = ai.createModel('cloudbase');
  const facts = (order.evaluation && order.evaluation.facts) || {};
  const res = await model.generateText({
    model: 'hy3',
    messages: [
      { role: 'system', content: POLISH_PROMPT },
      { role: 'user', content: '【事实】\n' + JSON.stringify({
        taskName: order.plan && order.plan.taskName,
        verdict: order.evaluation && order.evaluation.verdict,
        completeness: order.evaluation && order.evaluation.completeness,
        rounds: facts.rounds, minutes: facts.minutes, dLevelsUsed: facts.dLevelsUsed,
        independentCount: facts.independentCount, promptedCount: facts.promptedCount,
        incompleteCount: facts.incompleteCount, untested: facts.untested
      }) + '\n\n【规则评语】\n' + ((order.evaluation && order.evaluation.comment) || '')
    }]
  });
  let text = String((res && res.text) || '').trim();
  text = text.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  if (!text || text.length > 200) throw new Error('polish 输出不合法');
  // 门禁：润色稿一旦出现禁用词或凭空造数，直接判失败回落
  const banned = kit.findBannedWords(text);
  if (banned.length) throw new Error('polish 命中禁用词：' + banned.join('/'));
  return text;
}

/* ---------------- 主入口 ---------------- */

exports.main = async (event) => {
  const ev = event || {};
  const openid = (ev.userInfo && ev.userInfo.openId) || '';
  if (!openid) return { ok: false, code: 'no_openid', msg: '缺少用户身份，无法操作学习单' };

  const action = String(ev.action || '');
  if (action !== 'polish' && actions.ACTIONS.indexOf(action) < 0) {
    return { ok: false, code: 'bad_action', msg: '未知 action: ' + (action || '(空)') };
  }

  let app;
  try {
    app = tcb.init({ env: process.env.TCB_ENV || 'workbuddy-d2gsgtfvmde5c9adf' });
  } catch (e) {
    return { ok: false, code: 'init', msg: '云函数初始化失败：' + ((e && e.message) || e) };
  }

  const deps = makeDeps(app, openid);

  try {
    if (action === 'polish') return await runPolish(ev, deps, app);
    const fn = actions[action];
    if (typeof fn !== 'function') {
      return { ok: false, code: 'bad_action', msg: 'action 未实现: ' + action };
    }
    return await fn(ev, deps);
  } catch (e) {
    return { ok: false, code: 'order_error', msg: '学习单操作失败：' + ((e && e.message) || e) };
  }
};

/**
 * AI 润色：只改 evaluation.comment 与 commentSource，**不产生新的事实或结论**。
 * 失败静默回落 rule（ok:true + commentSource:'rule' + polishFailed 说明），绝不阻塞闭环。
 */
async function runPolish(ev, deps, app) {
  const orderNo = String(ev.orderNo || '').trim();
  if (!orderNo) return { ok: false, code: 'bad_param', msg: '缺少 orderNo' };
  const doc = await deps.find({ orderNo: orderNo });
  if (!doc) return { ok: false, code: 'not_found', msg: '学习单不存在：' + orderNo };
  if (!doc.evaluation || !doc.evaluation.comment) {
    return { ok: false, code: 'bad_transition', msg: '本单还没有规则评语（回执未提交），无法润色' };
  }
  if (doc.evaluation.commentSource === 'ai') {
    return { ok: true, order: actions.pick(doc), deduped: true };
  }

  const now = Date.now();
  let patch;
  let note;
  try {
    const polished = await polishComment(app, doc);
    patch = {
      evaluation: Object.assign({}, doc.evaluation, { comment: polished, commentSource: 'ai' }),
      updatedAt: now
    };
    note = 'commentSource=ai';
  } catch (e) {
    // 静默回落：闭环优先，评语退回规则版
    patch = { updatedAt: now };
    note = 'commentSource=rule（润色失败已回落：' + String((e && e.message) || e).slice(0, 60) + '）';
  }

  const next = Object.assign({}, doc);
  next.events = doc.events || [];
  kit.appendEvent(next, 'polished', 'ai', note, now);
  patch.events = next.events;
  await deps.update(doc.cloudId || doc._id, patch);

  return {
    ok: true,
    order: actions.pick(Object.assign({}, doc, patch)),
    polishFailed: patch.evaluation ? false : true
  };
}

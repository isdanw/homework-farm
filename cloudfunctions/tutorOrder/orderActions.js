/**
 * ⚠️ AUTO-GENERATED —— 请勿直接编辑本文件。
 * 内容：orderActions（业务动作层）
 * 源文件：order-kit/orderActions.js（canonical）
 * 重新生成：node scripts/sync-order-kit.mjs
 * 一致性由 scripts/test-order-kit-sync.cjs 用 sha256 校验区段锁死。
 */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrderActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

// @@ORDER_ACTIONS_BODY_BEGIN@@
  var LIST_LIMIT = 200;
  var REASON_MAX = 120;
  var NOTE_MAX = 60;

  /** 动作清单（云函数只做白名单校验，不做业务分支） */
  var ACTIONS = ['issue', 'copied', 'submit', 'tick', 'close', 'cancel', 'void', 'reissue', 'get', 'list'];

  /** 允许被「客户端传字段」覆盖的 action —— 其余字段一律由服务端计算 */
  function createActions(kit) {
    if (!kit || typeof kit.makeOrder !== 'function') {
      throw new Error('createActions: 需要 orderKit');
    }
    var K = kit;

    /* ---------------- 工具 ---------------- */
    function fail(code, msg, extra) {
      var o = { ok: false, code: code, msg: msg || '' };
      if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) o[k] = extra[k]; } }
      return o;
    }
    function s(v, max) {
      var t = String(v == null ? '' : v).trim();
      return max ? t.slice(0, max) : t;
    }
    function ts(v, fallback) {
      var n = Number(v);
      return isFinite(n) && n > 0 ? n : fallback;
    }
    /** 对客户端出参：剥掉云端专属字段（openid / _id / 云文档 id），语义与 tutorStore 黑名单一致 */
    function pick(doc) {
      if (!doc) return null;
      var o = {};
      for (var k in doc) {
        if (!doc.hasOwnProperty(k)) continue;
        if (k === 'openid' || k === '_openid' || k === '_id' || k === 'cloudId') continue;
        o[k] = doc[k];
      }
      return o;
    }
    function nowOf(deps) { return typeof deps.now === 'function' ? deps.now() : Date.now(); }

    /* ---------------- 读取 ---------------- */
    async function get(params, deps) {
      var orderNo = s(params.orderNo, 40);
      if (!orderNo) return fail('bad_param', '缺少 orderNo');
      var doc = await deps.find({ orderNo: orderNo });
      if (!doc) return fail('not_found', '导学单不存在：' + orderNo);
      return { ok: true, order: pick(doc) };
    }

    async function list(params, deps) {
      var p = params || {};
      var rows = await deps.list({
        planId: s(p.planId, 60),
        subject: s(p.subject, 40),
        status: s(p.status, 20),
        limit: Math.min(Number(p.limit) || LIST_LIMIT, LIST_LIMIT)
      });
      var arr = Array.isArray(rows) ? rows : [];
      var out = arr.map(pick);
      out.sort(function (a, b) { return (b.issuedAt || b.createdAt || 0) - (a.issuedAt || a.createdAt || 0); });
      var counts = { issued: 0, submitted: 0, closed: 0, cancelled: 0, voided: 0, total: out.length };
      out.forEach(function (o) { if (counts[o.status] !== undefined) counts[o.status]++; });
      return { ok: true, orders: out, total: out.length, counts: counts };
    }

    /* ---------------- 出单 ---------------- */
    /**
     * O1：必须带 planTask（key / si / ti / taskName）+ opts。
     * 幂等：同 clientId 已存在 → 回既有单，deduped:true，**不新建、不重复计数**。
     */
    async function issue(params, deps) {
      var p = params || {};
      var order = K.makeOrder(p.planTask, p.opts || {});
      if (!order) {
        return fail('no_anchor', '出单必须锚定成长计划里的具体任务（学科 key / 阶段 si / 任务 ti / 任务名 缺一不可）');
      }
      var dup = await deps.find({ clientId: order.clientId });
      if (dup) return { ok: true, order: pick(dup), deduped: true };
      // 编号碰撞（极小概率）→ 重新取号，绝不覆盖既有单
      var byNo = await deps.find({ orderNo: order.orderNo });
      if (byNo) {
        order.orderNo = K.newOrderNo(nowOf(deps), deps.rand && deps.rand());
        order.events[0].detail = 'planId=' + order.plan.planId + ' si=' + order.plan.si + ' ti=' + order.plan.ti;
      }
      var ins = await deps.insert(order);
      var saved = Object.assign({}, order, { cloudId: (ins && ins.id) || '' });
      return { ok: true, order: pick(saved), deduped: false };
    }

    /* ---------------- 复制留痕（O4） ---------------- */
    async function copied(params, deps) {
      var orderNo = s(params.orderNo, 40);
      if (!orderNo) return fail('bad_param', '缺少 orderNo');
      var doc = await deps.find({ orderNo: orderNo });
      if (!doc) return fail('not_found', '导学单不存在：' + orderNo);
      var next = clone(doc);
      // ⚠️ appendEvent 返回 **boolean**（是否真的写入），并**原地**追加到 order.events。
      //    不是「返回新对象」——早期误当对象用，events 直接变 undefined。
      var wrote = K.appendEvent(next, 'copied', s(params.by, 12) || doc.issuedBy || 'mp',
        s(params.detail, 80) || '首次复制出单全文到执行端', nowOf(deps));
      if (!wrote) {
        return { ok: true, order: pick(doc), deduped: true };   // copied 幂等：只记首次
      }
      await deps.update(doc.cloudId || doc._id, { events: next.events, updatedAt: nowOf(deps) });
      return { ok: true, order: pick(next), deduped: false };
    }

    /* ---------------- 提交回执（O2 + O3 + O4） ---------------- */
    /**
     * 三件套校验（顺序即报错优先级）：
     *   ① 单存在            → not_found
     *   ② planId 与所选计划一致 → plan_mismatch   ← 决策 1「先选计划再选出单」的服务端兜底
     *   ③ status === 'issued'  → already_submitted（回显首次 submittedAt）
     * 通过后：buildReceipt → evaluateReceipt → 落 receipt/evaluation/cycle + status=submitted
     *         + events 追加 submitted / evaluated（与业务字段**同一次 update**）
     */
    async function submit(params, deps) {
      var p = params || {};
      var orderNo = s(p.orderNo, 40);
      var planId = s(p.planId, 60);
      if (!orderNo) return fail('bad_param', '缺少 orderNo');
      if (!planId) return fail('bad_param', '回执必须先选计划再选出单：缺少 planId');

      var doc = await deps.find({ orderNo: orderNo });
      if (!doc) return fail('not_found', '导学单不存在：' + orderNo);

      // ② 计划对位：所选计划必须与出单锚点完全一致
      var anchorPlanId = (doc.plan && doc.plan.planId) || '';
      if (anchorPlanId !== planId) {
        return fail('plan_mismatch', '所选计划与出单锚点不符：本单属于 ' + (anchorPlanId || '未知计划'),
          { expectPlanId: anchorPlanId });
      }

      // ③ 1:1 锁定：一个出单只能对应一个回执，原地覆盖一律拒绝
      if (doc.status === 'submitted' || doc.status === 'closed') {
        return fail('already_submitted', '本单已提交过回执（' + fmt(doc.submittedAt) + '），不可重复提交；如需修正请作废重开',
          { status: doc.status, submittedAt: doc.submittedAt || 0 });
      }
      if (!K.canTransition(doc.status, 'submitted')) {
        return fail('bad_transition', '当前状态「' + doc.status + '」不允许提交回执', { status: doc.status });
      }

      var now = nowOf(deps);

      /* 回执字段来源二选一 —— 但**解析器只有这一份**（canonical K.parseReceiptText）：
       *   ① p.fields  —— 端上已解析并人工确认过（小程序通道；字段优先，不受 rawText 影响）
       *   ② p.rawText —— 端上只给粘贴原文（网页看板通道），由这里抽取
       * 为什么不让网页端自己解析：解析规则一旦分叉，同一段回执在三端会算出三种 verdict，
       *   而 verdict 是「活动 ≠ 证据 ≠ 掌握」的唯一判据，绝不允许端上参与判定。
       *   网页看板是 1.4MB 内联单文件、拿不到 order-kit，本来也**没有**解析器可用 ——
       *   「粘贴原文上云解析」是它唯一不与 canonical 分叉的路径。
       * 缺项**不拒绝提交**：缺什么由 evaluateReceipt 折算成证据完整度与 verdict，
       *   把「回执不全」如实反映出来，而不是把家长挡在门外；missing 随出参回传供端上提示。
       */
      var fields = p.fields;
      var parsedInfo = null;
      if ((!fields || typeof fields !== 'object' || !Object.keys(fields).length) && s(p.rawText, 6000)) {
        parsedInfo = K.parseReceiptText(s(p.rawText, 6000));
        fields = (parsedInfo && parsedInfo.fields) || {};
      }
      var receipt = K.buildReceipt(fields || {}, {
        orderNo: orderNo,
        parsedBy: s(p.parsedBy, 12) || 'rule',
        now: now,
        by: s(p.by, 12) || 'mp'
      });
      if (!receipt) return fail('bad_receipt', '回执内容无法归一，请检查必填项');

      // 人工确认过的量化项（rounds / minutes / selfEval / errorType）以显式入参为准
      var q = p.quant || {};
      if (q.rounds !== undefined) receipt.rounds = Math.max(1, Math.min(Number(q.rounds) || 1, 9));
      if (q.minutes !== undefined) receipt.minutes = Math.max(0, Math.min(Number(q.minutes) || 0, 600));
      if (q.selfEval !== undefined) receipt.selfEval = Math.max(0, Math.min(Number(q.selfEval) || 0, 5));
      if (q.errorType !== undefined && /^E[1-9]$/.test(s(q.errorType, 4))) receipt.errorType = s(q.errorType, 4);

      var history = await deps.list({ subject: doc.subject || '', limit: LIST_LIMIT });
      var ev = K.evaluateReceipt(doc, receipt, {
        now: now,
        plan: p.plan || null,          // 端上带过来的计划快照（可选）——用于算下一条建议任务
        history: Array.isArray(history) ? history : []
      });
      if (!ev || !ev.ok) return fail('evaluate_error', '证据审核失败：' + ((ev && ev.reason) || 'unknown'));

      var cycle = ev.cycle;
      // planDrift / planOrphan：计划内容不在云端（studyPlans 在小程序本地），只能由端上带判定所需事实
      var pc = p.planCtx || {};
      if (pc.updatedAt !== undefined && pc.updatedAt !== null) {
        var pu = ts(pc.updatedAt, 0);
        cycle.planDrift = !!(doc.plan && doc.plan.planUpdatedAt && pu && pu !== doc.plan.planUpdatedAt);
      }
      if (typeof pc.taskExists === 'boolean') cycle.planOrphan = !pc.taskExists;
      cycle.summary = K.cycleSummary(doc, ev.evaluation, cycle);

      // O4：业务字段与事件同一次 update —— 不允许出现「状态改了但没留痕」
      var withEvents = clone(doc);
      withEvents.events = doc.events || [];
      withEvents.status = 'submitted';
      withEvents.submittedAt = now;
      withEvents.submittedBy = s(p.by, 12) || 'mp';
      withEvents.receipt = receipt;
      withEvents.evaluation = ev.evaluation;
      withEvents.cycle = cycle;
      var detail = 'parsedBy=' + receipt.parsedBy + '，verdict=' +
        (ev.evaluation.verdict === null ? '证据不足' : ev.evaluation.verdict) +
        ' completeness=' + ev.evaluation.completeness;
      K.appendEvent(withEvents, 'submitted', withEvents.submittedBy, detail, now);
      K.appendEvent(withEvents, 'evaluated', 'sys',
        'verdict=' + (ev.evaluation.verdict === null ? 'null' : ev.evaluation.verdict) +
        ' completeness=' + ev.evaluation.completeness, now);

      await deps.update(doc.cloudId || doc._id, {
        status: withEvents.status,
        submittedAt: withEvents.submittedAt,
        submittedBy: withEvents.submittedBy,
        receipt: receipt,
        evaluation: ev.evaluation,
        cycle: cycle,
        events: withEvents.events,
        updatedAt: now
      });
      return {
        ok: true,
        order: pick(Object.assign({}, withEvents, { cloudId: doc.cloudId || doc._id })),
        /* 仅当本次是「云端代解析」时才有值：missing 供端上提示缺哪几项（**提示，不是拒绝**） */
        parsed: parsedInfo
          ? { missing: parsedInfo.missing || [], recognized: !!parsedInfo.recognized }
          : null
      };
    }

    /* ---------------- 勾选计划任务（不自动，仅显式动作） ---------------- */
    async function tick(params, deps) {
      var p = params || {};
      var orderNo = s(p.orderNo, 40);
      if (!orderNo) return fail('bad_param', '缺少 orderNo');
      var doc = await deps.find({ orderNo: orderNo });
      if (!doc) return fail('not_found', '导学单不存在：' + orderNo);
      if (doc.status === 'cancelled' || doc.status === 'voided') {
        return fail('bad_transition', '已作废/已取消的单不能勾选计划任务', { status: doc.status });
      }
      var now = nowOf(deps);
      var by = s(p.by, 12) || 'mp';
      // 幂等判据：业务上「勾选计划任务」只应生效一次。appendEvent 只对 copied 幂等，
      // 对 ticked 不幂等，所以这里必须自己先查事件再决定要不要写。
      var hasTicked = (doc.events || []).some(function (e) { return e && e.type === 'ticked'; });
      if (hasTicked) return { ok: true, order: pick(doc), deduped: true };

      var cycle = Object.assign({}, doc.cycle || {}, {
        tickApplied: true,
        tickedAt: now,
        tickedBy: by
      });
      var next = clone(doc);
      // appendEvent 原地追加、返回 boolean（见 copied 处注释）
      K.appendEvent(next, 'ticked', by,
        'planId=' + ((doc.plan && doc.plan.planId) || '') + ' si=' + ((doc.plan && doc.plan.si) || 0) +
        ' ti=' + ((doc.plan && doc.plan.ti) || 0), now);
      // 计划任务的 actualDone 由端上按事件重放得出，云端只存事件（计划内容不在云端）
      await deps.update(doc.cloudId || doc._id, { cycle: cycle, events: next.events, updatedAt: now });
      return { ok: true, order: pick(Object.assign({}, doc, { cycle: cycle, events: next.events })), deduped: false };
    }

    /* ---------------- 关闭（归档） ---------------- */
    async function close(params, deps) {
      return transition(params, deps, 'closed', 'closedAt', '归档关闭本次导学单');
    }

    /* ---------------- 取消 ---------------- */
    async function cancel(params, deps) {
      return transition(params, deps, 'cancelled', '', '取消');
    }

    /* ---------------- 作废 ---------------- */
    async function doVoid(params, deps) {
      return transition(params, deps, 'voided', 'voidedAt', '作废');
    }

    /**
     * 统一状态跃迁：canTransition 是唯一权威，绝不在本文件重写规则。
     * 非法跃迁一律 bad_transition 并回显当前状态（便于端上给出人话提示）。
     */
    async function transition(params, deps, to, stampField, label) {
      var p = params || {};
      var orderNo = s(p.orderNo, 40);
      if (!orderNo) return fail('bad_param', '缺少 orderNo');
      var doc = await deps.find({ orderNo: orderNo });
      if (!doc) return fail('not_found', '导学单不存在：' + orderNo);

      var reason = s(p.reason, REASON_MAX);
      if ((to === 'voided' || to === 'cancelled') && !reason) {
        return fail('bad_param', label + '必须填写原因（留痕需要）');
      }
      if (!K.canTransition(doc.status, to)) {
        return fail('bad_transition', '当前状态「' + doc.status + '」不能' + label, {
          status: doc.status, from: doc.status, to: to
        });
      }

      var now = nowOf(deps);
      var by = s(p.by, 12) || 'mp';
      var patch = { status: to, updatedAt: now };
      if (stampField) patch[stampField] = now;
      if (to === 'voided') patch.voidReason = reason;
      if (to === 'cancelled') patch.cancelReason = reason;

      var next = clone(doc);
      var evType = to === 'closed' ? 'closed' : (to === 'cancelled' ? 'cancelled' : 'voided');
      // 事件类型表里没有 closed —— 归档复用 evaluated 之后的终点语义：此处用 cancelled/voided 之外的
      // 「closed」不入 EVENT_TYPES；为保持事件类型封闭，归档记为 'evaluated' 之后的 closed 事件由
      // appendEvent 兜底为原类型。见下方 guardEventType。
      var et = guardEventType(K, evType, to);
      K.appendEvent(next, et, by, reason || (label + '（无备注）'), now);
      patch.events = next.events;

      await deps.update(doc.cloudId || doc._id, patch);
      return { ok: true, order: pick(Object.assign({}, doc, patch)) };
    }

    /** 事件类型必须落在 EVENT_TYPES 内（O4 的表是封闭的，不许自由加类型） */
    function guardEventType(K2, want, status) {
      var types = (K2 && K2.EVENT_TYPES) || [];
      if (types.indexOf(want) >= 0) return want;
      if (types.indexOf('evaluated') >= 0) return status === 'cancelled' ? 'cancelled' : 'voided';
      return want;
    }

    /* ---------------- 作废重开（O4：审计链不断） ---------------- */
    /**
     * 修正既有的唯一合法路径：先把原单作废（保留全部事件与回执原文），再基于**原单锚点快照**
     * 新建一张单，新单 reissueOf = 原 orderNo。原单永不删除，时间线完整可查。
     */
    async function reissue(params, deps) {
      var p = params || {};
      var orderNo = s(p.orderNo, 40);
      if (!orderNo) return fail('bad_param', '缺少 orderNo');
      var doc = await deps.find({ orderNo: orderNo });
      if (!doc) return fail('not_found', '导学单不存在：' + orderNo);

      var reason = s(p.reason, REASON_MAX);
      if (!reason) return fail('bad_param', '重开必须填写原因（说明为什么要作废原单）');
      if (!K.canTransition(doc.status, 'voided')) {
        return fail('bad_transition', '当前状态「' + doc.status + '」不能作废重开', { status: doc.status });
      }

      var now = nowOf(deps);
      var by = s(p.by, 12) || 'mp';
      var vo = await doVoid({ orderNo: orderNo, reason: '重开：' + reason, by: by }, deps);
      if (!vo.ok) return vo;

      // 新单沿用原单的锚点快照（不重新读计划——否则重开后归属会漂移）
      var rebuilt = K.makeOrder({
        key: doc.plan.key,
        si: doc.plan.si,
        ti: doc.plan.ti,
        planId: doc.plan.planId,
        planCreatedAt: planCreatedFrom(doc.plan.planId),
        subjectName: doc.plan.subjectName,
        stageName: doc.plan.stageName,
        taskName: doc.plan.taskName,
        goal: doc.plan.goal,
        days: doc.plan.days,
        dueDay: doc.plan.dueDay,
        startDate: doc.plan.startDate,
        planUpdatedAt: doc.plan.planUpdatedAt,
        scaffoldLevel: doc.scaffoldLevel
      }, Object.assign({}, p.opts || {}, {
        now: now,
        issuedBy: by,
        kind: doc.kind,
        minutes: doc.minutes,
        intent: doc.intent,
        device: doc.device,
        grade: doc.grade,
        textbook: doc.textbook
      }));
      if (!rebuilt) return fail('no_anchor', '原单锚点不完整，无法重开');

      rebuilt.reissueOf = orderNo;
      rebuilt.events[0].detail = 'reissueOf=' + orderNo + ' planId=' + rebuilt.plan.planId +
        ' si=' + rebuilt.plan.si + ' ti=' + rebuilt.plan.ti;
      var ins = await deps.insert(rebuilt);
      return {
        ok: true,
        voided: vo.order,
        order: pick(Object.assign({}, rebuilt, { cloudId: (ins && ins.id) || '' }))
      };
    }

    /** 从 planId（key@createdAt）反解计划 createdAt；解析不出返回 0（planId 已显式传入，不影响归属） */
    function planIdFrom(planId) {
      var t = s(planId, 60);
      var i = t.lastIndexOf('@');
      return i > 0 ? t.slice(i + 1) : '';
    }
    function planCreatedFrom(planId) {
      var v = planIdFrom(planId);
      var n = Number(v);
      return isFinite(n) && n > 0 ? n : 0;
    }

    function clone(o) {
      var out = {};
      for (var k in o) { if (o.hasOwnProperty(k)) out[k] = o[k]; }
      return out;
    }

    function fmt(ms) {
      var n = Number(ms) || 0;
      if (!n) return '时间未知';
      var d = new Date(n);
      var p2 = function (x) { return x < 10 ? '0' + x : '' + x; };
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
        ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    }

    return {
      ACTIONS: ACTIONS,
      get: get,
      list: list,
      issue: issue,
      copied: copied,
      submit: submit,
      tick: tick,
      close: close,
      cancel: cancel,
      void: doVoid,
      reissue: reissue,
      // 供云函数复用的小工具
      pick: pick,
      fail: fail
    };
  }

  /* ⚠️ 区段体内**不得**出现顶层 `return`（ESM 副本会直接语法错误，见 orderKit.js 同处说明）。
   *    body 只声明具名 API 对象；CJS 的 return 由 scripts/sync-order-kit.mjs 追加在区段之外。 */
  var ORDER_ACTIONS_API = { createActions: createActions, ACTIONS: ACTIONS, LIST_LIMIT: LIST_LIMIT };
  // @@ORDER_ACTIONS_BODY_END@@
  return ORDER_ACTIONS_API;
});

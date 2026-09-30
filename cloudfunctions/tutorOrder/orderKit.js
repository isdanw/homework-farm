/**
 * ⚠️ AUTO-GENERATED —— 请勿直接编辑本文件。
 * 内容：orderKit（单引擎）
 * 源文件：order-kit/orderKit.js（canonical）
 * 重新生成：node scripts/sync-order-kit.mjs
 * 一致性由 scripts/test-order-kit-sync.cjs 用 sha256 校验区段锁死。
 */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrderKit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

/* @@ORDER_KIT_BODY_BEGIN @@ */
  /* ------------------------------------------------------------------ *
   * 一、常量
   * ------------------------------------------------------------------ */

  /** 出单协议版本（与 src/contracts/taskProtocol.ts 的 TASK_PROTOCOL_VERSION 同口径） */
  var PROTOCOL_VERSION = 'task-protocol-v1';

  /** 学习单 schema 版本 */
  var ORDER_SCHEMA = 'order-v1';

  /** 状态机（唯一权威，端与云端共用同一份） */
  var STATUSES = ['issued', 'submitted', 'closed', 'cancelled', 'voided'];

  var TRANSITIONS = {
    issued: ['submitted', 'cancelled', 'voided'],
    submitted: ['closed', 'voided'],
    closed: ['voided'],
    cancelled: [],
    voided: []
  };

  /** 审计事件类型（append-only） */
  var EVENT_TYPES = ['issued', 'copied', 'submitted', 'evaluated', 'polished', 'ticked', 'closed', 'cancelled', 'voided'];

  /** 训练意图（复用 task-protocol-v1 的 12 种） */
  var TASK_INTENTS = ['建档', '订正', '复测', '新课', '单元过关', '试卷', '变式', '诊断', '计划', '断点续接', '表达', '转出'];

  /** 训练类型（对齐 TeachStep 费曼讲台） */
  var KINDS = ['concept', 'example', 'mistake', 'review', 'express'];
  var KIND_LABEL = { concept: '讲概念', example: '讲例题', mistake: '讲错题', review: '复习巩固', express: '仅练表达' };

  /** 学科讲学侧重（逐字取自 TeachStep 工作台） */
  var SUBJ_FOCUS = {
    '语文': '文章/诗词理解、字词用法、作者意图、用自己的话复述',
    '数学': '概念定义、推理步骤、为什么这样解、边界条件',
    '英语': '语法规则、词汇用法、句型结构、为什么这样用',
    '物理': '物理原理、适用条件、步骤推理、单位与量纲',
    '化学': '概念与反应原理、反应条件、方程式含义',
    '生物': '概念、结构与功能关系、因果关系、举例',
    '历史': '事件因果、时间线、人物与影响、用自己的话讲',
    '地理': '概念、因果、分布规律、举例',
    '道法': '观点、理由、例子、判断对错',
    '编程': '代码逻辑、算法步骤、为什么这样做、边界情况',
    '科学实验': '实验原理、变量控制、现象解释',
    '自定义': '以家长/孩子给出的内容为准：先问"这个内容里最核心的是什么"，再围绕它讲'
  };

  /** 检查重点（逐字取自 TeachStep 工作台） */
  var KIND_FOCUS = {
    concept: '是什么、为什么、什么时候用、什么时候不能用、能否举例',
    example: '读题、选择方法、每一步的理由、条件变化后是否仍适用',
    mistake: '原先怎么想、错在第几步、错因属于哪一类、修改后能否重做',
    review: '多知识点区分、相似概念辨别、反例、新情境迁移',
    express: '能否说明关键关系、能否解释为什么、是否用自己的例子、是否前后矛盾'
  };

  /** 最小证据要求（逐字取自 TeachStep 工作台） */
  var KIND_MIN = {
    concept: '能独立举例 + 能说明一个不能用的情境',
    example: '独立完成一道条件变化的变式',
    mistake: '独立完成一道相似题',
    review: '能区分一组易混概念 + 完成一个迁移',
    express: '仅评价表达，不进行变式/边界验证，不得声称已验证掌握'
  };

  /** 时长 → 最低完成目标（逐字取自 TeachStep 工作台） */
  var DUR_GOAL = {
    '5': '一次首次讲解 + 一个关键追问 + 一个小变式。边界题不强求，时间不足标"未测"，不压缩、不编造。',
    '10': '首次讲解 + 诊断 + 重讲 + 一个变式。边界题视剩余时间，时间不足标"未测"。',
    '15': '首次讲解 + 重讲 + 换情境变式 + 边界题 + 小结。各环节尽量完成，仍未完成标"未测"。'
  };

  var DEVICE_HEAD = {
    cloud: '请在接下来的对话中，执行一次 TeachStep 费曼讲学训练。',
    video: '请在接下来的视频通话中，执行一次 TeachStep 费曼讲学训练。',
    voice: '请在接下来的语音通话中，执行一次 TeachStep 费曼讲学训练。'
  };

  /**
   * 评语禁用词（O3：不得给出掌握结论）。
   *
   * ⚠️ 分两组，缺一不可（2026-09-29 T22 补第二组）：
   *   · 第一组是**带副词前缀**的形如「已掌握/完全掌握」—— 最初的实现只认这六个精确串。
   *   · 第二组是**动词短语**（掌握了 / 精通了 / 已学会 / 学懂了 / 全懂了）。
   *
   * 为什么非要补第二组：这道门禁守的是 **AI 润色稿**（`tutorOrder` 里 `polishComment` 的
   * 输出校验）。而「已经掌握了这次的内容」这种说法**不含**上面任何一串——
   * 「已掌握」要求 已/掌/握 三字连着，而「已经掌握」中间夹了个「经」。
   * 于是最自然的那种越界表述恰好能从门禁底下钻过去，AI 的掌握结论就落到了评语里。
   * 这不是假想：把假 AI 的输出改成「孩子已经掌握了这次的内容」时，
   * `test-tutor-orders.cjs` 的 P7[banned] 用例当场报红暴露出这个洞。
   *
   * 动词短语能一次覆盖掉前缀的所有变体（已经/基本/都/全/彻底 + 掌握了），
   * 比逐个枚举前缀更省也更容易维护。规则评语模板从不出现这些词
   * （`test-order-contract.cjs` / `test-order-kit.cjs` 会立刻发现误伤）。
   */
  var BANNED_WORDS = [
    '已掌握', '已精通', '学会了', '完全懂了', '完全掌握', '稳稳掌握',
    '掌握了', '精通了', '已学会', '学懂了', '全懂了'
  ];

  /** 回执结果档位（与 TeachStep 回执「结果：」行一致） */
  var RESULT_BUCKETS = { independent: '独立完成', prompted: '提示后完成', incomplete: '未完成', untested: '未测' };

  var BUCKET_OF_TEXT = {
    '独立完成': 'independent',
    '提示后完成': 'prompted',
    '未完成': 'incomplete',
    '未测': 'untested'
  };

  var VERDICTS = ['达标', '部分达标', '未达标'];
  var COMPLETENESS = ['完整', '部分完整', '不足'];

  /** 未测/无法核验的写法（判定「是否标注」用） */
  var NOT_MEASURED_RE = /未测|无法核验|无法确认|未记录/;

  var ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  /* ------------------------------------------------------------------ *
   * 二、基础工具（全部纯函数）
   * ------------------------------------------------------------------ */

  function str(v, max) {
    var s = v === null || v === undefined ? '' : String(v);
    s = s.replace(/^\s+|\s+$/g, '');
    return max ? s.slice(0, max) : s;
  }

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function num(v, dft) {
    var n = Number(v);
    return isFinite(n) ? n : (dft === undefined ? 0 : dft);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 'YYYY-MM-DD'（本地时区，避免 toISOString 的 UTC 偏移） */
  function isoDate(ts) {
    var d = new Date(num(ts, 0));
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 两个 'YYYY-MM-DD' 之间的天数差（b - a），无法解析返回 null */
  function diffDays(a, b) {
    if (!a || !b) return null;
    var ta = Date.parse(a + 'T00:00:00');
    var tb = Date.parse(b + 'T00:00:00');
    if (isNaN(ta) || isNaN(tb)) return null;
    return Math.round((tb - ta) / 86400000);
  }

  /** 可注入的随机段：rand 为 0..1 的取随机函数 */
  function randSeg(len, rand) {
    var out = '';
    var i;
    for (i = 0; i < len; i++) {
      var r = typeof rand === 'function' ? rand() : Math.random();
      if (!(r >= 0 && r < 1)) r = 0;
      out += ID_CHARS.charAt(Math.floor(r * ID_CHARS.length) % ID_CHARS.length);
    }
    return out;
  }

  /** 人读训练编号：TS-YYMMDD-XXX（与 TeachStep genId 同格式） */
  function newOrderNo(ts, rand) {
    var d = new Date(num(ts, 0));
    return 'TS-' + String(d.getFullYear()).slice(2) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + randSeg(3, rand);
  }

  /** 跨端幂等主键（本地 uid = 云端 clientId） */
  function newClientId(ts, rand) {
    var d = new Date(num(ts, 0));
    return 'to_' + String(d.getFullYear()).slice(2) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '_' + randSeg(6, rand);
  }

  /**
   * 计划身份：key + '@' + plan.createdAt
   * 计划被重新生成时 createdAt 必变（studyPlan.normalizePlan 恒定写 Date.now()），
   * 因此旧单不会错挂到新计划上。
   */
  function planIdOf(plan, key) {
    var k = str(key || (plan && plan.key), 40);
    var created = plan && plan.createdAt ? num(plan.createdAt) : 0;
    return k + '@' + created;
  }

  /* ------------------------------------------------------------------ *
   * 三、状态机（O2）
   * ------------------------------------------------------------------ */

  /** 唯一权威：非法跃迁一律 false，调用方必须返回 bad_transition，不做兜底修正 */
  function canTransition(from, to) {
    var allow = TRANSITIONS[str(from)];
    return !!allow && allow.indexOf(str(to)) >= 0;
  }

  function isTerminal(st) {
    var allow = TRANSITIONS[str(st)];
    return !!allow && allow.length === 0;
  }

  /* ------------------------------------------------------------------ *
   * 四、审计事件（O4，append-only）
   * ------------------------------------------------------------------ */

  /**
   * 追加一条审计事件。**只追加，永不修改或删除既有条目。**
   * copied 幂等：同一单只记首次（代表"单已交付"）。
   * @returns {boolean} 是否真的写入
   */
  function appendEvent(order, type, by, detail, ts) {
    if (!order || EVENT_TYPES.indexOf(type) < 0) return false;
    if (!order.events) order.events = [];
    if (type === 'copied') {
      var i;
      for (i = 0; i < order.events.length; i++) {
        if (order.events[i] && order.events[i].type === 'copied') return false;
      }
    }
    order.events.push({
      at: num(ts, Date.now()),
      type: type,
      by: str(by, 12) || 'sys',
      detail: str(detail, 200)
    });
    return true;
  }

  /** events → 只读时间线（按时间正序） */
  function orderTimeline(order) {
    if (!order || !order.events) return [];
    return order.events.slice().sort(function (a, b) { return num(a.at) - num(b.at); });
  }

  /* ------------------------------------------------------------------ *
   * 五、出单（O1：单必锚计划）
   * ------------------------------------------------------------------ */

  /** D0-D4 帮助层级说明（逐字取自 SKILL.md §5 与 TeachStep buildExecution） */
  var HELP_LEVELS =
    '【D0-D4 帮助层级】\n' +
    'D0：澄清追问，不提供解题线索。\n' +
    'D1：指出需要检查的位置或条件。\n' +
    'D2：提供类比、图像或具体例子。\n' +
    'D3：示范关键的一步。\n' +
    'D4：简短讲解当前障碍，必要时完整示范。\n' +
    '根据困难选择层级，不机械逐级追问。防重复升级：同一个障碍最多连续追问两次；回答没有新增信息时，' +
    '5 分钟训练直接进入 D1 或 D2，10/15 分钟先给一个类比（D2），仍无法推进才用 D3/D4。' +
    '禁止同一问题反复追问，也禁止从 D0 直接跳到 D4 讲答案。获得实质帮助后，请孩子重新组织解释。' +
    '不要把提示后复述记为独立掌握。';

  /** 把 planTask + opts 归一成一个内部 state（所有 build* 都只读它） */
  function normalizeState(planTask, opts) {
    var pt = planTask || {};
    var o = opts || {};
    var kind = KINDS.indexOf(o.kind) >= 0 ? o.kind : 'concept';
    var minutes = ['5', '10', '15'].indexOf(String(o.minutes)) >= 0 ? String(o.minutes) : '10';
    var device = ['cloud', 'video', 'voice'].indexOf(o.device) >= 0 ? o.device : 'video';

    // 知识点 = 任务名（计划任务即出单来源）；opts.topic 可覆盖
    var topic = str(o.topic, 120) || str(pt.taskName, 120);
    var coord = str(o.coord, 60);
    var note = str(o.note, 120);

    return {
      orderNo: str(o.orderNo, 40),
      intent: TASK_INTENTS.indexOf(o.intent) >= 0 ? o.intent : '变式',
      learnerAlias: str(o.learnerAlias, 20) || '同学',
      grade: str(o.grade, 20) || '小学·一年级',
      subjectName: str(pt.subjectName, 20) || '数学',
      textbook: str(o.textbook, 40),
      kind: kind,
      kindLabel: KIND_LABEL[kind],
      minutes: minutes,
      durGoal: DUR_GOAL[minutes],
      device: device,
      topic: topic,
      coord: coord,
      note: note
    };
  }

  /** 知识点行（含教材坐标与家长补充，逐字沿用 TeachStep coordTxt/noteTxt 规则） */
  function topicFullOf(s) {
    var base = s.topic || '（题目未预先提供：先请孩子把题目对准镜头/口述，确认后再开始）';
    if (s.coord) base += '\n教材坐标：' + s.coord;
    if (s.note) base += '\n家长补充说明：' + s.note;
    return base;
  }

  /** ① 训练身份 */
  function buildIdentity(pt, s) {
    return '【训练身份】\n训练编号：' + s.orderNo + '（本训练所有单据沿用此编号，不新造）\n' +
      '称呼：' + s.learnerAlias + '\n' +
      '年级：' + s.grade + '\n' +
      '学科/内容：' + s.subjectName + '\n' +
      '训练类型：' + s.kindLabel + '\n' +
      '知识点或题目：' + topicFullOf(s) + '\n' +
      '计划时长：' + s.minutes + ' 分钟\n' +
      '本次最低完成目标：' + s.durGoal;
  }

  /** ② 执行规则 */
  function buildExecution(pt, s) {
    var head = DEVICE_HEAD[s.device];
    var start = s.device === 'video'
      ? '【开始】\n若题目通过镜头展示：① 先请孩子把题目对准镜头；② 复述你能确认的题干和关键条件；' +
        '③ 请孩子确认；④ 未确认前不得开始讲解或出题。看不清的数字、符号、图形关系必须问清，' +
        '不要猜测，也不要承诺一直看到了完整书写过程。\n若题目未预先提供：按上述两阶段流程，先请孩子口述完整题目并确认。'
      : '【开始】\n若题目未预先输入，先请孩子口述题目内容与条件，你复述确认；听不清必须问清，不要猜测。' +
        '未确认前不得开始讲解或出题。';
    var mis = s.kind === 'mistake' ? '\n若是错题，先请孩子讲当时自己的解题思路（不看订正），再定位错因。' : '';
    return head + '\n\n' +
      '【你的角色】\n你是认真听讲的 AI 学习伙伴，请孩子当小老师。语气自然、简短，每次只给一个主要任务，' +
      '等孩子回应。不要一次读出训练流程，也不要替孩子连续讲解。孩子不会时可以教学，随后请孩子自己解释。\n\n' +
      start + mis + '\n确认后选定本次最需要讲清的一个核心点。请孩子先讲："你准备怎么做？为什么这样做？" ' +
      '如果练概念，请孩子解释含义并举例。\n\n' +
      '【观察与追问】\n根据任务，内部检查概念、条件、原理、方法、边界、迁移和表达，不必逐项问完。' +
      '优先处理最影响理解的一个问题。以孩子说出的解释、确认的题目和可辨认的草稿为依据。' +
      '停顿时可询问是否需要帮助，不用表情判断理解或人格。允许孩子用术语、画图、算式或指认辅助说明。' +
      '听不清或看不清时，记录为无法确认，不算答错。\n\n' + HELP_LEVELS + '\n\n' +
      '【本次验证重点】\n' + KIND_FOCUS[s.kind] + '\n' +
      '【最小证据要求】\n' + KIND_MIN[s.kind];
  }

  /** ③ 验证与证据要求 */
  function buildEvidence(pt, s) {
    if (s.kind === 'express') {
      return '【验证】\n本次为仅练表达模式，不进行变式与边界验证。结束时只能评价知识表达表现，不得声称已验证掌握。\n' +
        '【证据要求】\n表达表现只记录：能否说明关键关系、是否能解释"为什么"、是否使用了自己的例子、' +
        '是否前后矛盾、是否需要提示才能继续。禁止评价说得顺不顺、像不像标准答案、是否足够流利、口头停顿次数。';
    }
    return '【验证】\n核心解释修正后，给一道适龄、条件完整的新题。先让孩子独立尝试，暂不提供解题线索。' +
      '若使用了提示，记录为提示后完成。再给一个适龄的边界问题，例如：一个错误说法，' +
      '或者一个看似相似但不能直接用原方法的情境。请孩子判断并说明原因，不一定要求孩子自行构造反例。' +
      '出题前检查答案、条件和难度。训练不只靠换数字，要适当检查"为什么"和适用条件。\n' +
      '【证据要求】\n必须记录：是否给了实质提示、给的是哪一级（D0-D4）、提示前孩子说了什么、提示后改变了什么；' +
      '区分独立完成与提示后完成；未完成的环节写"未测"，不压缩、不编造。';
  }

  /** ④ 结束与回收（含证据回执模板，逐字沿用 SKILL.md §8.1） */
  function buildRecovery(pt, s) {
    var expressPart = '表达表现：\n' +
      '- 能否说明关键关系：\n- 是否能解释"为什么"：\n- 是否使用了自己的例子：\n' +
      '- 是否前后矛盾：\n- 是否需要提示才能继续：\n';
    var verifyPart = '变式验证：\n- 题目：\n- 孩子的回答或做法：\n- 是否给予实质提示：\n' +
      '- 结果：独立完成 / 提示后完成 / 未完成 / 未测\n' +
      '边界验证：\n- 问题：\n- 孩子的判断及理由：\n- 是否给予实质提示：\n' +
      '- 结果：独立完成 / 提示后完成 / 未完成 / 未测\n';
    return '【结束与回收】\n不要在原题讲顺后立即宣告掌握，应推进到验证。孩子要求停止、感到疲劳或训练需要结束时，' +
      '及时收尾，未完成的环节写"未测"。不以回合数认定掌握，不因一次训练标记"已稳定掌握"。' +
      '结束时先口头给出两三句简短反馈。\n随后若当前通道支持文字输出，生成下面的证据回执；' +
      '不要默认逐字朗读整份回执。如果通话内无法输出文字，待回到文字对话后，' +
      '仅依据仍可访问的本次记录生成，缺失信息明确标注。训练编号沿用 ' + s.orderNo + '。\n\n' +
      '【费曼训练证据回执】\n训练编号：\n知识点与核心目标：\n题目确认情况：\n首次表现：\n' +
      '- 孩子的解释片段或概述：\n- 发现的具体问题：\n帮助过程：\n- 关键提示及 D 层级：\n' +
      '- 使用时机（提示前孩子说了什么）：\n- 提示后改变了什么：\n' +
      (s.kind === 'express' ? expressPart : verifyPart) +
      '本次证据支持的结论：\n仍不确定的部分：\n下次建议：\n' +
      '只记录实际发生且能确认的内容。能确认原话时才使用引号，否则写"概述"。无法取得的信息写"未记录"。';
  }

  /** 机器可校验的协议块（任务参数，出单时注入；协议是请求不是指令） */
  function buildProtocolBlock(pt, s, orderId) {
    var lines = [
      '```task-protocol',
      'protocolVersion: ' + PROTOCOL_VERSION,
      'orderId: ' + orderId,
      'orderNo: ' + s.orderNo,
      'planId: ' + str(pt.planId, 60),
      'intent: ' + s.intent,
      'subject: ' + s.subjectName,
      'knowledgePoint: ' + (s.topic || str(pt.taskName, 120)),
      'currentStep: ' + str(pt.stageName, 40),
      'scaffoldLevel: ' + str(pt.scaffoldLevel, 20)
    ];
    if (s.kind === 'express' || s.intent === '表达') lines.push('evidenceType: expression');
    else lines.push('evidenceType: retest');
    lines.push('source: ' + str(pt.source, 40));
    lines.push('generatedAt: ' + str(pt.generatedAt, 40));
    lines.push('```');
    return lines.join('\n');
  }

  /** 完整启动单（① + ② + ③ + ④，逐字沿用 buildStart 的拼接方式） */
  function buildStart(pt, s) {
    return [buildIdentity(pt, s), '', buildExecution(pt, s), '', buildEvidence(pt, s), '', buildRecovery(pt, s)]
      .join('\n');
  }

  /** 续接单（逐字沿用 buildResume 的结构） */
  function buildResume(pt, s, resume) {
    var r = resume || {};
    var ev = [];
    if (str(r.variantResult)) ev.push('\n变式结果：' + str(r.variantResult, 40));
    if (str(r.boundaryResult)) ev.push('\n边界结果：' + str(r.boundaryResult, 40));
    return '【TeachStep 续接单】\n\n训练编号：' + s.orderNo + '（沿用上次编号，不新造）\n' +
      '上次已完成阶段：' + (str(r.stage) || '（未记录）') + ev.join('') + '\n\n' +
      '【续接确认】\n先向家长或孩子确认以下信息，无法确认的统一标记"未知"，不得假设：\n' +
      '1. 上次已经做到哪个阶段；\n2. 是否给过实质提示（哪一级）；\n' +
      '3. 变式题结果（独立完成 / 提示后完成 / 未完成 / 未测）；\n' +
      '4. 边界题结果（能识别 / 提示后识别 / 未识别 / 未测）；\n5. 哪些内容未完成。\n' +
      '题目未重新确认前，不得直接开始出题。\n\n' +
      '【训练身份】\n年级：' + s.grade + '\n学科/内容：' + s.subjectName + '\n' +
      '训练类型：' + s.kindLabel + '\n知识点或题目：' + topicFullOf(s) + '\n' +
      '计划时长：' + s.minutes + ' 分钟\n\n' +
      '【你的角色】\n你是认真听讲的 AI 学习伙伴，请孩子当小老师。语气自然、简短，每次只给一个主要任务，' +
      '等孩子回应。孩子不会时可以教学，随后请孩子自己解释。\n\n' +
      '【恢复】\n确认后请孩子从上次停下的位置继续讲。其余规则（学科侧重、观察追问、D0-D4 防重复升级、' +
      '验证与最小证据要求、结束与回收）与上次启动单一致；若规则已丢失，' +
      '按"认真听讲的 AI 学习伙伴、D0-D4 分层帮助、变式与边界验证、不编造回执"执行。\n\n' +
      buildEvidence(pt, s) + '\n\n' + buildRecovery(pt, s);
  }

  /** 回收指令（逐字沿用 buildRecycle 的第二步输出结构） */
  function buildRecycle(pt, s) {
    return '请依据下面的费曼训练证据回执，先做证据审核，再生成学习小结。\n\n' +
      '【第一步：证据审核】\n检查：\n1. 是否有孩子的实际回答或行为记录；\n2. 是否记录了题目；\n' +
      '3. 是否说明是否使用提示；\n4. 是否区分独立完成与提示后完成；\n5. 变式是否真的是新题；\n' +
      '6. 边界题是否真正完成；\n7. 是否标注了未测 / 无法核验。\n' +
      '证据完整度：完整 / 部分完整 / 不足\n可以确认：\n不能确认：\n需要下次验证：\n' +
      '只有通过审核的内容才能进入本次结论；证据不足时输出"证据不足，建议补一次验证训练"，不生成掌握结论。\n' +
      '不得补写回执中没有的孩子回答、题目、提示或训练过程；无法核验标注"无法核验"。\n\n' +
      '【第二步：输出】\n【本次表现】\n核心知识：\n独立完成：\n提示后完成：\n未完成：\n未测：\n' +
      '【写给孩子的反馈】\n两句话，适龄语言，基于具体行为。\n' +
      '【下一次训练】\n只验证一个最值得验证的薄弱点，附一份自包含复习训练单（可直接复制到视频通话执行）。\n\n' +
      '单次训练只能说明本次表现。没有隔日或跨场景复测证据，不标记"已稳定掌握"。\n\n' +
      '训练编号沿用 ' + s.orderNo + '。\n\n【粘贴证据回执】';
  }

  /**
   * 出单（O1：必须携带计划锚点）
   * @param {Object} planTask 计划任务锚点
   *   { key, subjectName, si, ti, stageName, taskName, goal, days, dueDay,
   *     startDate, planCreatedAt, planUpdatedAt, scaffoldLevel, source, generatedAt }
   * @param {Object} opts { now, rand, issuedBy, learnerAlias, grade, textbook, kind, minutes, device,
   *                        intent, topic, coord, note, title }
   * @returns {Object|null} 完整 order 对象；缺 key / si / ti 直接返回 null（O1 硬约束）
   */
  function makeOrder(planTask, opts) {
    var pt = planTask || {};
    var o = opts || {};
    var now = num(o.now, Date.now());
    var by = str(o.issuedBy, 12) || 'mp';

    // O1：单必锚计划 —— 缺锚点直接拒绝，不产生无计划自由出单
    if (!str(pt.key)) return null;
    if (pt.si === undefined || pt.si === null || pt.ti === undefined || pt.ti === null) return null;
    if (!str(pt.taskName) && !str(o.topic)) return null;

    var orderNo = str(o.orderNo, 40) || newOrderNo(now, o.rand);
    var clientId = str(o.clientId, 60) || newClientId(now, o.rand);

    var s = normalizeState(pt, {
      orderNo: orderNo, intent: o.intent, learnerAlias: o.learnerAlias, grade: o.grade,
      textbook: o.textbook, kind: o.kind, minutes: o.minutes, device: o.device,
      topic: o.topic, coord: o.coord, note: o.note
    });

    var plan = {
      key: str(pt.key, 40),
      planId: str(pt.planId, 60) || planIdOf({ createdAt: pt.planCreatedAt }, pt.key),
      subjectName: str(pt.subjectName, 20),
      si: num(pt.si, 0),
      ti: num(pt.ti, 0),
      stageName: str(pt.stageName, 40),
      taskName: str(pt.taskName, 60),
      goal: str(pt.goal, 80),
      days: num(pt.days, 1),
      dueDay: num(pt.dueDay, 0),
      startDate: str(pt.startDate, 12),
      planUpdatedAt: num(pt.planUpdatedAt, 0)
    };

    var order = {
      clientId: clientId,
      orderNo: orderNo,
      schema: ORDER_SCHEMA,

      plan: plan,

      intent: s.intent,
      evidenceType: (s.kind === 'express' || s.intent === '表达') ? 'expression' : 'retest',
      subject: plan.key,
      subjectName: s.subjectName,
      grade: s.grade,
      textbook: s.textbook,
      scaffoldLevel: str(pt.scaffoldLevel, 20),
      title: str(o.title, 60) || (plan.taskName + ' · ' + s.kindLabel),
      kind: s.kind,
      minutes: s.minutes,
      device: s.device,

      status: 'issued',
      issuedAt: now,
      issuedBy: by,
      submittedAt: 0,
      submittedBy: '',
      closedAt: 0,

      receipt: null,
      voidedAt: 0,
      voidReason: '',
      reissueOf: '',
      evaluation: null,
      cycle: null,

      events: [],
      createdAt: now,
      updatedAt: now
    };

    order.protocolBlock = buildProtocolBlock(plan, s, clientId);
    order.promptText = buildStart(plan, s) + '\n\n' + order.protocolBlock;
    order.copyText = order.promptText;
    // 续接单 / 回收指令也一并生成，端上"一键复制"时按阶段取用
    order.resumeText = buildResume(plan, s, null);
    order.recycleText = buildRecycle(plan, s);

    appendEvent(order, 'issued', by, 'planId=' + plan.planId + ' si=' + plan.si + ' ti=' + plan.ti, now);
    return order;
  }

  /** 出单文本随阶段切换（issued / copied 用 start，续接用 resume，回收用 recycle） */
  function orderTextFor(order, stage) {
    if (!order) return '';
    if (stage === 'resume') return str(order.resumeText);
    if (stage === 'recycle') return str(order.recycleText);
    return str(order.copyText || order.promptText);
  }

  /* ------------------------------------------------------------------ *
   * 六、回执解析（只抽取、不推断）
   * ------------------------------------------------------------------ */

  /** 取某个一级段落（从 header 起，到下一个已知 header 止） */
  var SECTION_HEADERS = ['首次表现', '帮助过程', '变式验证', '边界验证', '表达表现',
    '本次证据支持的结论', '仍不确定的部分', '下次建议'];

  function sectionOf(text, header) {
    var start = text.indexOf(header);
    if (start < 0) return '';
    start += header.length;
    var end = text.length;
    var i;
    for (i = 0; i < SECTION_HEADERS.length; i++) {
      if (SECTION_HEADERS[i] === header) continue;
      var p = text.indexOf(SECTION_HEADERS[i], start);
      if (p >= 0 && p < end) end = p;
    }
    return text.slice(start, end);
  }

  /** 段落内取「标签：值」（标签可带前导 "- " 或 "· "） */
  function fieldIn(section, label) {
    if (!section) return '';
    var lines = section.split('\n');
    var i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s*[-*·]\s*/, '');
      var idx = line.indexOf(label);
      if (idx < 0) continue;
      var rest = line.slice(idx + label.length);
      if (rest.charAt(0) === '：' || rest.charAt(0) === ':') rest = rest.slice(1);
      rest = str(rest);
      if (rest) return rest;
    }
    return '';
  }

  /** 「结果：」行 → 档位 key；无法识别返回 '' */
  function bucketOfResultLine(v) {
    var t = str(v);
    if (!t) return '';
    // 回执模板给的是「独立完成 / 提示后完成 / 未完成 / 未测」四选一，
    // 抽取时必须取**已选中的那一个**：优先精确等于，其次取第一个命中项。
    var order = ['独立完成', '提示后完成', '未完成', '未测'];
    var i;
    for (i = 0; i < order.length; i++) if (t === order[i]) return BUCKET_OF_TEXT[order[i]];
    for (i = 0; i < order.length; i++) if (t.indexOf(order[i]) >= 0) return BUCKET_OF_TEXT[order[i]];
    return '';
  }

  /** 从"关键提示及 D 层级"里抽 D0-D4 */
  function levelsOf(text) {
    var out = [];
    var re = /D[0-4]/g;
    var m;
    while ((m = re.exec(str(text))) !== null) {
      if (out.indexOf(m[0]) < 0) out.push(m[0]);
    }
    return out;
  }

  /**
   * 解析回执原文（纯正则/分段，**绝不推断补全**）
   * @returns {{fields:Object, missing:string[], recognized:boolean}}
   */
  function parseReceiptText(raw) {
    var text = String(raw === null || raw === undefined ? '' : raw).replace(/\r\n?/g, '\n');
    var missing = [];
    var recognized = text.indexOf('费曼训练证据回执') >= 0 ||
      text.indexOf('变式验证') >= 0 || text.indexOf('表达表现') >= 0;

    var secFirst = sectionOf(text, '首次表现');
    var secHelp = sectionOf(text, '帮助过程');
    var secVar = sectionOf(text, '变式验证');
    var secBnd = sectionOf(text, '边界验证');
    var secExpr = sectionOf(text, '表达表现');

    var fields = {};

    fields.orderNo = fieldIn(text.slice(0, Math.max(text.indexOf('首次表现'), 0)), '训练编号');
    if (!fields.orderNo) missing.push('orderNo');

    fields.topic = fieldIn(text.slice(0, Math.max(text.indexOf('首次表现'), 0)), '知识点与核心目标');
    if (!fields.topic) missing.push('topic');

    fields.childQuote = fieldIn(secFirst, '孩子的解释片段或概述');
    if (!fields.childQuote) missing.push('childQuote');

    fields.stuckPoint = fieldIn(secFirst, '发现的具体问题');
    if (!fields.stuckPoint) missing.push('stuckPoint');

    fields.dLevelsUsed = levelsOf(fieldIn(secHelp, '关键提示及 D 层级'));
    if (!fields.dLevelsUsed.length) missing.push('dLevelsUsed');

    fields.variantQuestion = fieldIn(secVar, '题目');
    fields.variantResult = bucketOfResultLine(fieldIn(secVar, '结果'));
    fields.boundaryQuestion = fieldIn(secBnd, '问题');
    fields.boundaryResult = bucketOfResultLine(fieldIn(secBnd, '结果'));

    var isExpress = !!secExpr && !secVar;
    fields.mode = isExpress ? 'express' : 'standard';
    fields.expressionNote = isExpress
      ? ['能否说明关键关系', '是否能解释"为什么"', '是否使用了自己的例子', '是否前后矛盾', '是否需要提示才能继续']
        .map(function (k) { return k + '：' + (fieldIn(secExpr, k) || '未记录'); }).join('\n')
      : '';

    if (isExpress) {
      if (!secExpr) missing.push('expression');
    } else {
      if (!fields.variantResult) missing.push('variantResult');
      if (!fields.boundaryResult) missing.push('boundaryResult');
      if (!fields.variantQuestion) missing.push('variantQuestion');
      if (!fields.boundaryQuestion) missing.push('boundaryQuestion');
    }

    fields.conclusion = fieldIn(text.slice(text.lastIndexOf('本次证据支持的结论')), '本次证据支持的结论');
    fields.nextRaw = fieldIn(text.slice(text.lastIndexOf('下次建议')), '下次建议');
    fields.markedNotMeasured = NOT_MEASURED_RE.test(text);
    fields.rawText = text;

    return { fields: fields, missing: missing, recognized: recognized };
  }

  /* ------------------------------------------------------------------ *
   * 七、评语与汇总（确定性规则；AI 只做话术润色，不参与 verdict）
   * ------------------------------------------------------------------ */

  /** SKILL.md §8.2 七项证据完整度清单（applicable 依模式裁剪） */
  function auditEvidence(receipt, fields) {
    var express = fields.mode === 'express';
    var checks = [];
    var missingResults = express ? 0 : ((fields.variantResult ? 0 : 1) + (fields.boundaryResult ? 0 : 1));

    checks.push({
      id: 'child_behavior',
      pass: !!str(fields.childQuote) || !!str(fields.conclusion) || !!str(fields.expressionNote),
      label: '有孩子的实际回答或行为记录'
    });
    checks.push({
      id: 'question_recorded',
      pass: express ? !!str(fields.expressionNote) : (!!str(fields.variantQuestion) && !!str(fields.boundaryQuestion)),
      label: '是否记录了题目'
    });
    checks.push({
      id: 'hint_stated',
      pass: express ? true : (!!fields.variantResult || !!fields.boundaryResult),
      label: '是否说明是否使用提示'
    });
    checks.push({
      id: 'independent_vs_prompted',
      pass: express ? true : (fields.variantResult !== '' || fields.boundaryResult !== ''),
      label: '是否区分独立完成与提示后完成'
    });
    if (!express) {
      checks.push({
        id: 'variant_is_new',
        pass: !!str(fields.variantQuestion),
        label: '变式是否真的是新题'
      });
      checks.push({
        id: 'boundary_done',
        pass: fields.boundaryResult !== '' && fields.boundaryResult !== 'untested',
        label: '边界题是否真正完成'
      });
    }
    checks.push({
      id: 'not_measured_marked',
      pass: express ? true : (missingResults === 0 ? true : NOT_MEASURED_RE.test(str(fields.rawText) + str(receipt.rawText))),
      label: '是否标注了未测 / 无法核验'
    });

    var passed = checks.filter(function (c) { return c.pass; }).length;
    var applicable = checks.length;
    var ratio = applicable ? passed / applicable : 0;
    var completeness = passed === applicable ? '完整' : (ratio >= 0.7 ? '部分完整' : '不足');
    return { checks: checks, passed: passed, applicable: applicable, completeness: completeness };
  }

  /** 档位数组（按 receipt 里显式给出的分类） */
  function bucketsOf(receipt) {
    var ind = [], pro = [], inc = [], unt = [];
    if (receipt.independent && receipt.independent.variant) ind.push('变式验证');
    if (receipt.independent && receipt.independent.boundary) ind.push('边界验证');
    if (receipt.prompted && receipt.prompted.variant) pro.push('变式验证');
    if (receipt.prompted && receipt.prompted.boundary) pro.push('边界验证');
    if (receipt.incomplete && receipt.incomplete.variant) inc.push('变式验证');
    if (receipt.incomplete && receipt.incomplete.boundary) inc.push('边界验证');
    (receipt.untested || []).forEach(function (x) { if (unt.indexOf(x) < 0) unt.push(x); });
    return { independent: ind, prompted: pro, incomplete: inc, untested: unt };
  }

  /** 由 verdict + facts 组装规则评语文案（**绝不含禁用词**） */
  function ruleComment(order, receipt, facts, completeness) {
    var topic = str(receipt.topic) || str(order && order.plan && order.plan.taskName) || str(order && order.title);
    var lines = [];
    lines.push('本次单：' + topic + '（' + str(order && order.orderNo) + '）。');

    if (completeness === '不足') {
      lines.push('证据不足，不下结论 —— 建议补一次验证训练。');
      return lines.join('');
    }

    var verdictMap = { '达标': '本次表现：达标。', '部分达标': '本次表现：部分达标。', '未达标': '本次表现：未达标。' };
    lines.push(verdictMap[facts.verdict] || ('本次表现：' + facts.verdict + '。'));

    var seg = [];
    if (facts.independentCount) seg.push(facts.independentCount + ' 项能独立完成');
    if (facts.promptedCount) seg.push(facts.promptedCount + ' 项在提示后完成');
    if (facts.incompleteCount) seg.push(facts.incompleteCount + ' 项未完成');
    if (seg.length) lines.push(seg.join('，') + '。');

    if (facts.untested.length) {
      lines.push(facts.untested.join('、') + ' 未测，不等于已会，下次优先补测。');
    }

    if (facts.dLevelsUsed.indexOf('D3') >= 0 || facts.dLevelsUsed.indexOf('D4') >= 0) {
      lines.push('本次使用了示范级帮助（' + facts.dLevelsUsed.join('/') + '），提示后复述不算独立完成。');
    }
    if (facts.rounds >= 3) {
      lines.push('本次讲了 ' + facts.rounds + ' 轮，轮次偏多，卡点可能尚未真正解决。');
    }
    return lines.join('');
  }

  /** 禁用词检查（O3 门禁；测试与云端写入前都跑一遍） */
  function findBannedWords(text) {
    var t = str(text);
    return BANNED_WORDS.filter(function (w) { return t.indexOf(w) >= 0; });
  }

  /**
   * 提交回执 → 生成 evaluation + cycle（O2 校验由调用方在服务端做，这里做纯计算）
   * @param {Object} order  出单对象
   * @param {Object} receipt 回执（已人工确认后的结构字段）
   * @param {Object} ctx { now, plan, history }
   * @returns {{ok:boolean, reason?:string, evaluation?:Object, cycle?:Object}}
   */
  function evaluateReceipt(order, receipt, ctx) {
    if (!order) return { ok: false, reason: 'no_order' };
    if (!receipt) return { ok: false, reason: 'no_receipt' };
    var c = ctx || {};
    var now = num(c.now, Date.now());

    var fields = receipt.fields || {
      mode: receipt.mode === 'express' ? 'express' : 'standard',
      childQuote: receipt.childQuote, conclusion: receipt.conclusion,
      variantResult: '', boundaryResult: '', variantQuestion: '', boundaryQuestion: '',
      expressionNote: receipt.expressionNote, markedNotMeasured: !!receipt.markedNotMeasured
    };

    var audit = auditEvidence(receipt, fields);
    var b = bucketsOf(receipt);

    var facts = {
      rounds: num(receipt.rounds, 1),
      minutes: num(receipt.minutes, 0),
      dLevelsUsed: Array.isArray(receipt.dLevelsUsed) ? receipt.dLevelsUsed.slice(0, 5) : [],
      independentCount: b.independent.length,
      promptedCount: b.prompted.length,
      incompleteCount: b.incomplete.length,
      untested: b.untested.slice(0, 4),
      result: str(receipt.result, 12) || 'partial',
      mode: fields.mode
    };

    // ---- verdict（纯规则，AI 无权参与）----
    var verdict;
    if (audit.completeness === '不足') {
      verdict = null;
    } else if (facts.result === 'blocked' || facts.incompleteCount > 0) {
      verdict = '未达标';
    } else if (facts.mode === 'express') {
      // 仅练表达：不进行变式/边界验证，不得声称已验证掌握
      verdict = '部分达标';
    } else if (facts.promptedCount > 0) {
      verdict = '部分达标';
    } else if (facts.untested.length > 0) {
      verdict = '部分达标';
    } else if (facts.independentCount >= 2) {
      verdict = '达标';
    } else if (facts.independentCount === 1) {
      verdict = '部分达标';
    } else {
      verdict = '未达标';
    }
    facts.verdict = verdict;

    var evaluation = {
      verdict: verdict,
      verdictText: verdict === null ? '证据不足' : verdict,
      completeness: audit.completeness,
      checks: audit.checks,
      facts: facts,
      comment: ruleComment(order, receipt, facts, audit.completeness),
      commentSource: 'rule',
      generatedAt: now
    };

    // ---- cycle ----
    var plan = c.plan || null;
    var planDelta = null;
    if (order.plan && order.plan.startDate) {
      var actual = diffDays(order.plan.startDate, isoDate(receipt.submittedAt || now));
      if (actual !== null) {
        var day = actual + 1;
        planDelta = { dueDay: order.plan.dueDay, actualDay: day, delta: order.plan.dueDay ? (day - order.plan.dueDay) : 0 };
      }
    }

    var repeatStuck = 0;
    var history = Array.isArray(c.history) ? c.history : [];
    var hi;
    for (hi = history.length - 1; hi >= 0; hi--) {
      var h = history[hi];
      if (!h || h.clientId === order.clientId) continue;
      if (!h.plan || h.plan.key !== order.plan.key) continue;
      if (h.plan.taskName !== order.plan.taskName) continue;
      if (h.status !== 'closed') break;
      if (h.receipt && str(h.receipt.stuckPoint)) repeatStuck++;
      else break;
    }

    var nextSuggest = nextOrderSuggestion(plan, order, history);

    var retestHint = null;
    if (facts.incompleteCount > 0 || facts.promptedCount > 0 || facts.untested.length > 0) {
      retestHint = {
        subject: order.plan.key,
        subjectName: order.subjectName,
        topic: str(receipt.topic) || order.plan.taskName,
        errorType: str(receipt.errorType, 4)
      };
    }

    var cycle = {
      summary: '',
      planDelta: planDelta,
      planDrift: false,
      planOrphan: false,
      repeatStuck: repeatStuck,
      nextSuggest: nextSuggest,
      retestHint: retestHint,
      tickApplied: false,
      tickedAt: 0,
      tickedBy: ''
    };
    cycle.summary = cycleSummary(order, evaluation, cycle);
    return { ok: true, evaluation: evaluation, cycle: cycle };
  }

  /** 本次出单-回执汇总正文（纯计算） */
  function cycleSummary(order, evaluation, cycle) {
    var f = evaluation.facts;
    var parts = [];
    var topic = str(order && order.plan && order.plan.taskName) || str(order && order.title);
    var head = '本次单「' + topic + '」';
    var metrics = [];
    if (f.minutes) metrics.push(f.minutes + ' 分钟');
    metrics.push(f.rounds + ' 轮');
    if (f.dLevelsUsed.length) metrics.push('用了 ' + f.dLevelsUsed.join('、'));
    head += '：' + metrics.join(' / ');
    parts.push(head + '。');

    var vMap = { '达标': '达标', '部分达标': '部分达标', '未达标': '未达标' };
    var vLine = evaluation.verdict === null ? '证据不足，暂不下结论' : (vMap[evaluation.verdict] || evaluation.verdict);
    var vSeg = [];
    if (f.independentCount) vSeg.push('独立完成 ' + f.independentCount + ' 项');
    if (f.promptedCount) vSeg.push('提示后完成 ' + f.promptedCount + ' 项');
    if (f.incompleteCount) vSeg.push('未完成 ' + f.incompleteCount + ' 项');
    if (f.untested.length) vSeg.push('未测 ' + f.untested.join('、'));
    parts.push('结论：' + vLine + (vSeg.length ? '（' + vSeg.join('，') + '）' : '') + '。');

    if (cycle.planDelta) {
      var d = cycle.planDelta;
      var ds = d.delta > 0 ? ('滞后 ' + d.delta + ' 天') : (d.delta < 0 ? ('超前 ' + (-d.delta) + ' 天') : '按排期完成');
      parts.push('属计划第 ' + d.dueDay + ' 天任务，实际第 ' + d.actualDay + ' 天完成（' + ds + '）。');
    }
    if (cycle.planDrift) parts.push('计划在出单后被改动，本单按出单时锚点归档。');
    if (cycle.planOrphan) parts.push('计划中该任务已不存在，本单按出单时快照归档。');
    if (cycle.repeatStuck > 0) parts.push('同知识点连续卡点 ' + cycle.repeatStuck + ' 次。');
    if (cycle.nextSuggest) parts.push('下次建议：' + cycle.nextSuggest.taskName + '。');
    else if (cycle.retestHint) parts.push('下次建议：先做一次「' + cycle.retestHint.topic + '」的复测。');
    return parts.join('');
  }

  /**
   * 下一条建议任务（同阶段往后找第一条未勾选；再往后阶段找）
   * @param {Object} plan studyPlans[key] 结构
   */
  function nextOrderSuggestion(plan, order, history) {
    if (!plan || !Array.isArray(plan.stages)) return null;
    var cur = order && order.plan ? order.plan : null;
    var doneKeys = {};
    (Array.isArray(history) ? history : []).forEach(function (h) {
      if (h && h.plan && h.plan.key && h.plan.si !== undefined && h.plan.ti !== undefined) {
        doneKeys[h.plan.key + ':' + h.plan.si + ':' + h.plan.ti] = true;
      }
    });

    var cum = 0;
    var cands = [];
    plan.stages.forEach(function (st, si) {
      var tasks = (st && Array.isArray(st.tasks)) ? st.tasks : [];
      tasks.forEach(function (t, ti) {
        cum += num(t && t.days, 1);
        cands.push({ si: si, ti: ti, stageName: str(st && st.name, 40), task: t, dueDay: cum });
      });
    });
    if (!cands.length) return null;

    var startIdx = 0;
    if (cur) {
      var i;
      for (i = 0; i < cands.length; i++) {
        if (cands[i].si === cur.si && cands[i].ti === cur.ti) { startIdx = i + 1; break; }
      }
    }
    var k;
    for (k = startIdx; k < cands.length; k++) {
      var c = cands[k];
      if (c.task && c.task.done) continue;
      var key = (cur ? cur.key : c.stageName) + ':' + c.si + ':' + c.ti;
      return {
        key: cur ? cur.key : '',
        si: c.si, ti: c.ti,
        stageName: c.stageName,
        taskName: str(c.task && c.task.name, 60),
        goal: str(c.task && c.task.goal, 80),
        days: num(c.task && c.task.days, 1),
        dueDay: c.dueDay,
        issuedBefore: !!doneKeys[key]
      };
    }
    return null;
  }

  /** 档位 key 白名单 */
  var BUCKET_KEYS = ['independent', 'prompted', 'incomplete', 'untested'];

  /**
   * 归一「结果」字段：同时接受
   *   · 回执原文的四选一文本（'独立完成' / '提示后完成' / '未完成' / '未测'）
   *   · 已归一过的档位 key（parseReceiptText 的输出）
   * 两者互转必须幂等 —— 否则 parseReceiptText → buildReceipt 的往返会丢档位。
   */
  function toBucket(v) {
    var t = str(v);
    if (!t) return '';
    if (BUCKET_OF_TEXT[t]) return BUCKET_OF_TEXT[t];
    if (BUCKET_KEYS.indexOf(t) >= 0) return t;
    return bucketOfResultLine(t);
  }

  /**
   * 回执结构字段 → 提交用的 receipt 对象（端上人工确认后调用）
   * 只做归一与兜底，不做推断。
   */
  function buildReceipt(fields, meta) {
    var f = fields || {};
    var m = meta || {};
    var variantKey = toBucket(f.variantResult);
    var boundaryKey = toBucket(f.boundaryResult);
    var untested = [];
    if (variantKey === 'untested') untested.push('变式验证');
    if (boundaryKey === 'untested') untested.push('边界验证');

    var express = f.mode === 'express';
    var receipt = {
      mode: express ? 'express' : 'standard',
      topic: str(f.topic, 120),
      childQuote: str(f.childQuote, 300),
      stuckPoint: str(f.stuckPoint, 200),
      dLevelsUsed: Array.isArray(f.dLevelsUsed) ? f.dLevelsUsed.slice(0, 5) : [],
      variantQuestion: str(f.variantQuestion, 200),
      boundaryQuestion: str(f.boundaryQuestion, 200),
      expressionNote: str(f.expressionNote, 400),
      conclusion: str(f.conclusion, 300),
      nextRaw: str(f.nextRaw, 200),
      rounds: Math.max(1, Math.min(20, num(f.rounds, 1))),
      minutes: Math.max(0, Math.min(300, num(f.minutes, 0))),
      selfEval: Math.max(0, Math.min(5, num(f.selfEval, 0))),
      errorType: /^E[1-9]$/.test(str(f.errorType)) ? str(f.errorType) : '',
      markedNotMeasured: !!f.markedNotMeasured,
      parsedBy: m.parsedBy === 'manual' ? 'manual' : 'rule',
      submittedAt: num(m.now, Date.now()),
      submittedBy: str(m.by, 12) || 'mp',
      rawText: str(f.rawText, 6000)
    };

    // 内层字段包：evaluateReceipt 只读它。
    // 必须把**全部**已确认字段带进来，否则「解析结果 → 回执 → 评语」往返会丢字段，
    // 证据完整度会误判为「不足」。
    receipt.fields = {
      mode: express ? 'express' : 'standard',
      topic: receipt.topic,
      childQuote: receipt.childQuote,
      stuckPoint: receipt.stuckPoint,
      dLevelsUsed: receipt.dLevelsUsed,
      variantQuestion: receipt.variantQuestion,
      boundaryQuestion: receipt.boundaryQuestion,
      variantResult: variantKey,
      boundaryResult: boundaryKey,
      expressionNote: receipt.expressionNote,
      conclusion: receipt.conclusion,
      nextRaw: receipt.nextRaw,
      markedNotMeasured: receipt.markedNotMeasured,
      rawText: receipt.rawText
    };

    receipt.independent = { variant: variantKey === 'independent', boundary: boundaryKey === 'independent' };
    receipt.prompted = { variant: variantKey === 'prompted', boundary: boundaryKey === 'prompted' };
    receipt.incomplete = { variant: variantKey === 'incomplete', boundary: boundaryKey === 'incomplete' };
    receipt.untested = untested;

    var any = function (o) { return !!(o && (o.variant || o.boundary)); };
    if (any(receipt.incomplete)) receipt.result = 'blocked';
    else if (any(receipt.independent) && !any(receipt.prompted) && !untested.length) receipt.result = 'done';
    else receipt.result = 'partial';

    return receipt;
  }

  /* ------------------------------------------------------------------ *
   * 八、计划维度聚合（一份计划 → N 张单）
   *
   * 【为什么必须收进 canonical，而不是各端自己算】
   *
   * 这个聚合原本有**三份独立实现**：云端 `webAdminQuery` 的 `module:'orders'`、
   * 小程序 `tutorStore.planOrderAggregate`、工作台 `logic/orders.aggregateByPlan`。
   * 2026-09-29 T23 实测，三份在三个轴上都分叉了：
   *
   *   ① 无锚点（缺 planId）的单：云端归到 `'(无锚点)'` 组并计入 total，
   *      工作台 `if (!planId) continue;` **直接丢弃** → 两端「总单数」对不上。
   *   ② 分组键：只有云端含 openid（`openid::planId`），另两端只用 planId
   *      → 家长看板同时看几个孩子时，分组数与小程序/工作台不同。
   *   ③ 时间戳兜底：云端 `issuedAt || createdAt`，另两端只有 `issuedAt`
   *      → 缺 issuedAt 的老单在两端排到不同位置。
   *
   * 「三端渲染同一份聚合数据」**不能靠三份实现互相看齐** —— 那只是把分叉推迟到
   * 下一次改动。收进 canonical 后，一致性由 `test-order-kit-sync.cjs` 的 sha256
   * 哈希锁机器保证，不靠人记。
   * ------------------------------------------------------------------ */

  /** 状态自增：只认 STATUSES 里的 5 个键，防止把聚合行的其它字段（key/total/…）当成状态自增 */
  function bumpStatus(group, status) {
    for (var i = 0; i < STATUSES.length; i++) {
      if (STATUSES[i] === status) { group[status]++; return true; }
    }
    return false;
  }

  /**
   * 状态计数。
   * @param {Array} orders
   * @returns {{issued:number,submitted:number,closed:number,cancelled:number,voided:number,total:number}}
   *   `total` 是**参与统计的单数**；五项计数之和可以 < total（状态缺失/未知时不计数）。
   */
  function countOrderStatuses(orders) {
    var c = { issued: 0, submitted: 0, closed: 0, cancelled: 0, voided: 0, total: 0 };
    var list = Array.isArray(orders) ? orders : [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i] || {};
      c.total++;
      bumpStatus(c, o.status);
    }
    return c;
  }

  /**
   * 计划维度聚合：一份计划 → N 张单的状态与时间戳一览。
   *
   * @param {Array} orders 学习单数组。云端形状与本地形状都吃，只读下列字段：
   *   `plan.planId / plan.key / plan.subjectName / plan.stageName / plan.taskName / plan.si / plan.ti`、
   *   `status`、`openid`（或 `_openid`）、`issuedAt`、`submittedAt`、`createdAt`、`subjectName`
   * @param {Object} [opts]
   *   @param {boolean} [opts.withOrders=false] 把该计划下的单**原样**挂回 `orders` 字段。
   *     仅供端上做下钻。⚠️ **云端绝不能开**：200 张单全挂回去会把响应撑大一个数量级。
   * @returns {Array} 聚合行，按 `lastAt` 倒序
   *
   * 三个字段口径（与改造前的**云端**口径对齐，另两端向它看齐）：
   *
   *   · **分组键 = `openid::planId`**。`planId = key + '@' + createdAt`，两家孩子的
   *     同名计划在「同 key 同毫秒 createdAt」这种（罕见但真实存在的）情况下会撞成同一组。
   *     本地单通常不带 openid → 键退化为 `::planId`，等价于只按 planId 分组。
   *
   *   · **无锚点的单归入 `'(无锚点)'` 组，不丢弃**。丢了就等于「有单凭空消失」；
   *     而 O1 要求每张单都必须锚计划，所以真出现无锚点单是**异常**，
   *     更要让它可见（这一组只要非空就是个告警信号），而不是藏起来。
   *
   *   · **`lastAt` = `max(issuedAt || createdAt || 0)`**。兜底 `createdAt` 是必须的：
   *     老单可能没有 `issuedAt`，只兜 issuedAt 会让它排到末尾。
   *     同时给出 `firstIssuedAt` / `lastIssuedAt` / `lastSubmittedAt` 供下钻视图用。
   */
  function planOrderAggregate(orders, opts) {
    var o = opts || {};
    var list = Array.isArray(orders) ? orders : [];
    var by = {};
    var keys = [];

    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var p = it.plan || {};
      var pid = p.planId ? String(p.planId) : '(无锚点)';
      var oid = it.openid || it._openid || '';
      var gk = oid + '::' + pid;

      if (!by[gk]) {
        by[gk] = {
          openid: oid,
          planId: pid,
          // 无锚点组连 `key` 也补成同一个哨兵值：否则三端会各自渲染出一个
          // 「 · 共 N 张」的空标题行（key=''），看起来像渲染坏了而不是数据异常。
          // 有 planId 但 key 为空的情形保持 '' —— 那是「计划被重建」，另一码事。
          key: p.key || (p.planId ? '' : '(无锚点)'),
          subjectName: p.subjectName || it.subjectName || '',
          stageName: p.stageName || '',
          taskName: p.taskName || '',
          si: p.si || 0,
          ti: p.ti || 0,
          issued: 0, submitted: 0, closed: 0, cancelled: 0, voided: 0,
          total: 0,
          firstIssuedAt: 0, lastIssuedAt: 0, lastSubmittedAt: 0,
          lastAt: 0
        };
        keys.push(gk);
      }

      var g = by[gk];
      g.total++;
      bumpStatus(g, it.status);

      var issued = num(it.issuedAt, 0);
      if (issued && (!g.firstIssuedAt || issued < g.firstIssuedAt)) g.firstIssuedAt = issued;
      if (issued > g.lastIssuedAt) g.lastIssuedAt = issued;
      var sub = num(it.submittedAt, 0);
      if (sub > g.lastSubmittedAt) g.lastSubmittedAt = sub;
      var at = issued || num(it.createdAt, 0);
      if (at > g.lastAt) g.lastAt = at;

      if (o.withOrders) {
        if (!g.orders) g.orders = [];
        g.orders.push(it);
      }
    }

    var out = [];
    for (var j = 0; j < keys.length; j++) out.push(by[keys[j]]);

    if (o.withOrders) {
      for (var k = 0; k < out.length; k++) {
        out[k].orders.sort(function (x, y) {
          return (num(y.issuedAt, 0) || num(y.createdAt, 0)) - (num(x.issuedAt, 0) || num(x.createdAt, 0));
        });
      }
    }

    // 排序：lastAt 倒序。**必须用 lastAt 而不是 lastIssuedAt** ——
    // 无锚点且有 createdAt 无 issuedAt 的单 lastIssuedAt=0，用后者会把它恒定排到末尾。
    out.sort(function (a, b) { return b.lastAt - a.lastAt; });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 九、导出
   * ------------------------------------------------------------------ */
  /* ⚠️ 这里**不能**写 `return { … }`。区段体（BODY_BEGIN…END 之间）会被生成器原样
   *    复制到 **ESM** 副本（工作台 src/order-kit/orderKit.js），而 ESM 顶层不允许
   *    `return` —— 一旦写 return，工作台那份会直接语法错误、根本无法 import
   *    （这个坑真实发生过：T06 声称"三端接入"，但工作台 import 从来没验证过）。
   *    正确做法：body 只声明一个具名 API 对象；CJS 的 `return` 与 ESM 的 `export`
   *    都由 scripts/sync-order-kit.mjs 按目标**追加在区段之外**。
   *    scripts/test-order-kit-sync.cjs 会断言本区段内不含顶层 return。 */
  var ORDER_KIT_API = {
    /* 常量 */
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    ORDER_SCHEMA: ORDER_SCHEMA,
    STATUSES: STATUSES,
    TRANSITIONS: TRANSITIONS,
    EVENT_TYPES: EVENT_TYPES,
    TASK_INTENTS: TASK_INTENTS,
    KINDS: KINDS,
    KIND_LABEL: KIND_LABEL,
    SUBJ_FOCUS: SUBJ_FOCUS,
    KIND_FOCUS: KIND_FOCUS,
    KIND_MIN: KIND_MIN,
    DUR_GOAL: DUR_GOAL,
    BANNED_WORDS: BANNED_WORDS,
    RESULT_BUCKETS: RESULT_BUCKETS,
    BUCKET_OF_TEXT: BUCKET_OF_TEXT,
    VERDICTS: VERDICTS,
    COMPLETENESS: COMPLETENESS,

    /* 工具 */
    str: str,
    num: num,
    isoDate: isoDate,
    diffDays: diffDays,
    randSeg: randSeg,
    newOrderNo: newOrderNo,
    newClientId: newClientId,
    planIdOf: planIdOf,

    /* 状态机 */
    canTransition: canTransition,
    isTerminal: isTerminal,

    /* 审计（O4） */
    appendEvent: appendEvent,
    orderTimeline: orderTimeline,

    /* 出单（O1） */
    makeOrder: makeOrder,
    orderTextFor: orderTextFor,
    buildIdentity: buildIdentity,
    buildExecution: buildExecution,
    buildEvidence: buildEvidence,
    buildRecovery: buildRecovery,
    buildStart: buildStart,
    buildResume: buildResume,
    buildRecycle: buildRecycle,
    buildProtocolBlock: buildProtocolBlock,
    normalizeState: normalizeState,
    topicFullOf: topicFullOf,

    /* 回执 */
    parseReceiptText: parseReceiptText,
    buildReceipt: buildReceipt,
    toBucket: toBucket,
    BUCKET_KEYS: BUCKET_KEYS,
    bucketOfResultLine: bucketOfResultLine,
    levelsOf: levelsOf,
    sectionOf: sectionOf,
    fieldIn: fieldIn,

    /* 评语与汇总 */
    auditEvidence: auditEvidence,
    evaluateReceipt: evaluateReceipt,
    cycleSummary: cycleSummary,
    ruleComment: ruleComment,
    findBannedWords: findBannedWords,
    nextOrderSuggestion: nextOrderSuggestion,

    /* 计划维度聚合（三端共用同一份，见 §八） */
    planOrderAggregate: planOrderAggregate,
    countOrderStatuses: countOrderStatuses
  };
  /* @@ORDER_KIT_BODY_END @@ */
  return ORDER_KIT_API;
});

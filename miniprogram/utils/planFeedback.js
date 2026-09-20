/**
 * ============================================================================
 *  planFeedback.js —— 报告 → 计划反哺（错因分布回流成长计划）
 *  ---------------------------------------------------------------------------
 *  纯逻辑模块，不依赖 wx / 页面，可被 Node 测试直接 require。
 *
 *  职责：把「错题本」里带错因（E1-E9）的错题，按学科聚合出「专项补漏建议」，
 *  每条建议是一个可直接加入该学科「成长计划」的具体任务（确定性模板，无需 AI）。
 *
 *  数据契约：
 *    · 输入 mistakes：元素需含 { subject, errorType }（与 tutorStore 错题结构一致）
 *    · 输出 feedbackList：
 *        [{ subject, items: [{ errorType, errorName, count, task }] }]
 *      仅含「至少有 1 个有效错因」的学科；无数据返回 []
 * ============================================================================
 */
const mistakeRules = require('./mistakeRules.js');

/**
 * E1-E9 错因 → 专项补漏任务模板（确定性、离线可用，不调 AI）
 * 每个模板是一个「可核对的日常训练动作」，对应错因类型的能力短板。
 */
const REMEDIATION = {
  E1: '每天做 2 道应用题：先圈关键词、写出「已知 / 未知」再动笔',
  E2: '重读相关定义与例题，做 3 道概念辨析题',
  E3: '用画图 / 列表 / 线段图表示题意，做 2 道表征题',
  E4: '梳理数量关系（和差 / 倍比 / 比例），做 2 道关系题',
  E5: '整理错题证据（题干 + 错答 + 正解），重做 2 道同类题',
  E6: '写出每一步推理依据，做 2 道推理题',
  E7: '限时完成 5 道计算，做完必验算一遍',
  E8: '口述解题过程并写清步骤，做 2 道表达题',
  E9: '做完用不同方法验算，并改编 1 道同类题'
};

/** 取某错因的补漏任务（未知错因返回空串） */
function remediationOf(errorType) {
  return (errorType && REMEDIATION[errorType]) || '';
}

/**
 * 把错题列表聚合成「按学科分组的补漏建议」。
 * @param {Array} mistakes 元素需含 { subject, errorType }
 * @param {Object} [opts] { topN=2, maxTasks=6 }
 *        topN     —— 每个学科最多取几个主要错因
 *        maxTasks —— 一次反哺的总任务数上限（防止一次塞太多）
 * @returns {Array<{subject:string, items:Array<{errorType,errorName,count,task}>}>}
 */
function buildFeedback(mistakes, opts) {
  const topN = Math.max(1, (opts && opts.topN) || 2);
  const maxTasks = Math.max(1, (opts && opts.maxTasks) || 6);

  const bySubject = {};
  (mistakes || []).forEach(function (m) {
    const sub = m && m.subject;
    const et = m && m.errorType;
    if (!sub || !et || !REMEDIATION[et]) return;        // 无学科 / 无补救模板的错因跳过
    if (!bySubject[sub]) bySubject[sub] = {};
    bySubject[sub][et] = (bySubject[sub][et] || 0) + 1;
  });

  const list = Object.keys(bySubject).map(function (sub) {
    const items = Object.keys(bySubject[sub])
      .map(function (et) {
        return {
          errorType: et,
          errorName: mistakeRules.errorTypeName(et),
          count: bySubject[sub][et],
          task: REMEDIATION[et]
        };
      })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, topN);
    return { subject: sub, items: items };
  });

  // 总任务数封顶：逐学科均摊截断，避免一次反哺任务过多
  let total = 0;
  list.forEach(function (fb) { total += fb.items.length; });
  if (total > maxTasks) {
    let budget = maxTasks;
    list.forEach(function (fb) {
      const keep = Math.min(fb.items.length, budget);
      fb.items = fb.items.slice(0, keep);
      budget -= keep;
    });
    return list.filter(function (fb) { return fb.items.length; });
  }
  return list;
}

module.exports = { REMEDIATION, remediationOf, buildFeedback };

/**
 * mistakeRules.js —— 拍照错题「规则路由」与共享元数据
 *
 * 设计（见《错题拍照识别流程设计.md》）：
 *  · 计算题(calc)/默写(dictation) 且图上有批改标记 → 本地规则直接归因，零 AI 成本、零幻觉
 *  · 其余题型（应用/填空/阅读/表达等）→ 走文本模型诊断（tutorChat action='diagnoseQuestions'）
 *  · 本模块不依赖 wx，可被测试脚本直接 require
 */

/** E1-E9 错因标签配色（与错题本页一致；诊断假设，非事实标签） */
const ERROR_TYPES = {
  E1: { name: '审题',      color: '#3FA9F5', bg: '#EAF5FF' },
  E2: { name: '概念',      color: '#9B7BF0', bg: '#F0ECFF' },
  E3: { name: '表征',      color: '#33C4AC', bg: '#E4F7F2' },
  E4: { name: '关系',      color: '#F5A623', bg: '#FFF3E0' },
  E5: { name: '证据',      color: '#FF6FA5', bg: '#FFEAF2' },
  E6: { name: '推理',      color: '#FF7A7A', bg: '#FFEDED' },
  E7: { name: '信息处理',  color: '#F5B740', bg: '#FFF6DD' },
  E8: { name: '表达',      color: '#5FBF6B', bg: '#EBF7EC' },
  E9: { name: '检查迁移',  color: '#8A8A8A', bg: '#F2F2F2' }
};

/** 题型元数据（key 与 ocrSchedule MISTAKE_TYPES 对齐） */
const QUESTION_TYPES = {
  calc:      { name: '计算' },
  apply:     { name: '应用题' },
  fill:      { name: '填空' },
  choice:    { name: '选择' },
  judge:     { name: '判断' },
  dictation: { name: '默写' },
  reading:   { name: '阅读理解' },
  writing:   { name: '写话' },
  other:     { name: '其他' }
};

/** 规则路由覆盖的题型（图上有批改标记时，无需 AI 归因） */
function isRuleType(type) {
  return type === 'calc' || type === 'dictation';
}

/** 题型展示名（未知兜底「其他」） */
function typeName(type) {
  return (QUESTION_TYPES[type] && QUESTION_TYPES[type].name) || '其他';
}

/** 错因中文名（如 '信息处理'）；未知返回空串 */
function errorTypeName(eKey) {
  return (ERROR_TYPES[eKey] && ERROR_TYPES[eKey].name) || '';
}

/** 错因完整标签（如 'E7 信息处理'）；未知/空返回原值兜底 */
function errorTypeLabel(eKey) {
  if (!eKey) return '';
  const name = errorTypeName(eKey);
  return name ? (eKey + ' ' + name) : eKey;
}

/** 截短工具：topic 一句话上限 */
function clip(s, n) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/**
 * 单题规则归因（仅覆盖 calc/dictation 且 marked 非 null 的题）：
 *   marked===false → calc: E7 运算失误 / dictation: E2 概念知识
 *   marked===true  → 做对的题：只给知识点，不给错因（是否收录由用户勾选决定）
 * 返回 { topic, errorType, errorDesc, suggestion }；不适用规则返回 null
 */
function ruleDiagnose(item) {
  if (!item || !isRuleType(item.type) || item.marked == null) return null;
  const q = clip(item.questionText, 24);
  const ans = clip(item.childAnswer, 16);

  if (item.type === 'calc') {
    if (item.marked === false) {
      return {
        topic: clip('计算：' + q, 40),
        errorType: 'E7',
        errorDesc: ans ? ('计算「' + q + '」写成了「' + ans + '」（老师批改 ×）') : ('计算「' + q + '」出错（老师批改 ×）'),
        suggestion: '重新算一遍这题，再出 3 道同类型的题练一练'
      };
    }
    return {
      topic: clip('计算：' + q, 40),
      errorType: '',
      errorDesc: '老师批改这题是对的',
      suggestion: ''
    };
  }

  // dictation
  if (item.marked === false) {
    return {
      topic: clip('默写：' + q, 40),
      errorType: 'E2',
      errorDesc: ans ? ('「' + q + '」写成了「' + ans + '」（老师批改 ×）') : ('「' + q + '」默写有误（老师批改 ×）'),
      suggestion: '对照正确写法描红 3 遍，明天再默一次'
    };
  }
  return {
    topic: clip('默写：' + q, 40),
    errorType: '',
    errorDesc: '老师批改这题是对的',
    suggestion: ''
  };
}

/**
 * 把确认后的题目列表按诊断路由分组：
 * 返回 { ruleItems, aiItems }，每组元素为 { idx, item, rule? }——
 * idx 是原数组下标（回填诊断结果用），rule 是规则归因结果（ruleItems 才有）
 */
function splitForDiagnosis(items) {
  const ruleItems = [];
  const aiItems = [];
  (items || []).forEach((item, idx) => {
    const rule = ruleDiagnose(item);
    if (rule) ruleItems.push({ idx: idx, item: item, rule: rule });
    else aiItems.push({ idx: idx, item: item });
  });
  return { ruleItems: ruleItems, aiItems: aiItems };
}

module.exports = { ERROR_TYPES, QUESTION_TYPES, isRuleType, typeName, errorTypeName, errorTypeLabel, ruleDiagnose, splitForDiagnosis, clip };

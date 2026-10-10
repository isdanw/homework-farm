/**
 * 英语练习（SpeakStep 听说练习台）· 导学中心入口
 *  · 与「家长数据看板」中的英语练习功能保持一致：同一套数据表 + 同一份 buildPrompt，
 *    生成的练习单文案逐字相同，复制后粘贴到豆包即可开练。
 *  · 默认带入当前孩子在「导学档案」的英语画像（store.get().subjectProfiles.english）：
 *    称呼 / 年级（含学段推导）/ 教材 / 进度（解析单元号）。可手动调整，也提供「刷新档案」按钮。
 *  · 纯前端、不写云、不接 AI（与看板复制模式一致）。
 */
const store = require('../../utils/store.js');

/* ===================== 数据表（与看板 SpeakStep 完全一致） ===================== */
const GRADES_ALL = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级'];
const GRADES = {
  primary: ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'],
  junior: ['七年级', '八年级', '九年级']
};
const BOOKS = {
  primary: ['人教PEP（三年级起点）', '人教新起点', '外研版（一起）', '外研版（三起）', '译林版', '北师大版', '冀教版', '湘少版', '沪教版', '其他'],
  junior: ['人教版（新目标）', '外研版', '译林版', '北师大版', '冀教版', '仁爱版', '鲁教版', '沪教版', '其他']
};
const EXAMS = ['剑桥少儿·Starters', '剑桥少儿·Movers', '剑桥少儿·Flyers', 'KET（A2 Key）', 'PET（B1 Preliminary）'];
const EXAM_STRUCT = {
  '剑桥少儿·Starters': { lv: 'L', words: '约 500 词（Starters 官方词表）',
    listen: ['Part 1 听名字连线人物', 'Part 2 听对话填空（数字/名字）', 'Part 3 听信息选择图片', 'Part 4 听指令涂色'],
    speak: ['Part 1 打招呼与个人问题', 'Part 2 看图问答', 'Part 3 看图讲故事', 'Part 4 开放个人问题'] },
  '剑桥少儿·Movers': { lv: 'M', words: '约 700 词（Movers 官方词表）',
    listen: ['Part 1 听名字连线人物', 'Part 2 听对话填空', 'Part 3 听信息选择图片', 'Part 4 听短文选择', 'Part 5 听指令涂色'],
    speak: ['Part 1 看图找不同', 'Part 2 看图讲故事', 'Part 3 看图问答', 'Part 4 开放问答'] },
  '剑桥少儿·Flyers': { lv: 'M', words: '约 900 词（Flyers 官方词表）',
    listen: ['Part 1 连线', 'Part 2 填空', 'Part 3 选择', 'Part 4 选择', 'Part 5 涂色'],
    speak: ['Part 1 看图找不同', 'Part 2 信息问答', 'Part 3 看图讲故事', 'Part 4 开放问答'] },
  'KET（A2 Key）': { lv: 'H', words: '约 1500 词（A2 Key 官方词表）',
    listen: ['Part 1 短对话三选一（标准 5 题）', 'Part 2 长对话信息填空（标准 5 空）', 'Part 3 独白信息填空（标准 5 空）', 'Part 4 长对话三选一（标准 5 题）', 'Part 5 匹配（标准 5 题）'],
    speak: ['Part 1 个人信息问答', 'Part 2 情景交流与看图讨论'] },
  'PET（B1 Preliminary）': { lv: 'H', words: '约 3500 词（B1 Preliminary 官方词表）',
    listen: ['Part 1 短对话三选一（标准 7 题）', 'Part 2 长对话三选一（标准 6 题）', 'Part 3 独白填空（标准 6 空）', 'Part 4 独白三选一（标准 6 题）'],
    speak: ['Part 1 个人问答', 'Part 2 情景交流', 'Part 3 看图描述', 'Part 4 观点讨论'] }
};
const UNIT_NUM = ['不指定', 'Unit 1', 'Unit 2', 'Unit 3', 'Unit 4', 'Unit 5', 'Unit 6', 'Unit 7', 'Unit 8', 'Unit 9', 'Unit 10', 'Unit 11', 'Unit 12'];
const THEMES = {
  '人教PEP（三年级起点）|三年级|上册|3': '身体部位',
  '人教PEP（三年级起点）|三年级|上册|4': '动物',
  '人教PEP（三年级起点）|四年级|上册|1': '教室',
  '人教PEP（三年级起点）|四年级|上册|4': '房间与家居',
  '人教PEP（三年级起点）|五年级|上册|3': '食物与饮品',
  '人教PEP（三年级起点）|五年级|上册|4': '活动与技能',
  '人教PEP（三年级起点）|六年级|上册|1': '交通方式',
  '人教PEP（三年级起点）|六年级|上册|3': '周末计划',
  '人教新起点|一年级|上册|1': '问候与自我介绍',
  '人教版（新目标）|七年级|上册|3': '家庭与物品',
  '人教版（新目标）|七年级|上册|5': '运动与爱好',
  '人教版（新目标）|八年级|上册|6': '未来计划',
  '人教版（新目标）|八年级|下册|6': '故事与传说',
  '外研版（三起）|三年级|上册|1': '问候与自我介绍'
};
const TOPICS = {
  topic: ['动物与自然', '足球与篮球', '游戏与动画', '科学与太空', '音乐与舞蹈', '食物与旅行', '恐龙与探险', '机器人与编程'],
  task: ['认识新朋友', '在餐厅点餐', '在商店买东西', '问路', '介绍自己的学校', '邀请朋友参加活动', '制订周末计划', '介绍家乡和中国节日', '旅行中的简单交流'],
  world: ['世界各地的校园', '不同国家的早餐', '国际节日', '世界动物与地理', '太空探索', '环境保护', '体育赛事', '不同文化中的礼貌表达']
};
const SRC_NAME = { topic: '兴趣主题', task: '生活任务', world: '世界见闻', free: '自由主题' };
const FOCUS_NOTE = {
  '听说综合': '听力与口语交替进行，先听后说',
  '听懂关键信息': '听人物、地点、时间与动作，听后选择或找关键词',
  '开口完成对话': '回答问题、情境对话或角色扮演，完成一个小任务',
  '听完简单复述': '复述一句话、说大意或按顺序重讲',
  '表达自己的想法': '介绍兴趣、说明原因、比较或表达简单观点'
};
const QUICK_PLANS = [
  { n: '放学后聊一聊', d: '5 分钟 · 校园生活 · 简单问答', set: { src: 'topic', topic: '校园生活', focus: '开口完成对话', minutes: 5 } },
  { n: '我最喜欢的动物', d: '5 分钟 · 兴趣主题 · 听说综合', set: { src: 'topic', topic: '动物与自然', focus: '听说综合', minutes: 5 } },
  { n: '在餐厅点餐', d: '10 分钟 · 生活任务 · 开口完成对话', set: { src: 'task', topic: '在餐厅点餐', focus: '开口完成对话', minutes: 10 } },
  { n: '世界各地的早餐', d: '10 分钟 · 世界见闻 · 听后表达', set: { src: 'world', topic: '不同国家的早餐', focus: '听完简单复述', minutes: 10 } },
  { n: '介绍我的兴趣', d: '10 分钟 · 兴趣主题 · 说出理由', set: { src: 'topic', topic: '我的兴趣', focus: '表达自己的想法', minutes: 10 } }
];
const SAMPLES = [
  { mode: 'quick', grade: '五年级', src: 'topic', topic: '动物与自然', focus: '听说综合', minutes: 10, name: '小虎' },
  { mode: 'quick', grade: '四年级', src: 'task', topic: '在餐厅点餐', focus: '开口完成对话', minutes: 10, name: '小虎' },
  { mode: 'school', track: 'school', stage: 'primary', grade: '五年级', book: '人教PEP（三年级起点）', term: '上册', unit: 3, lesson: '第1课时', focus: '开口完成对话', minutes: 10, name: '小虎', goal: 'What would you like? / I\'d like ...' },
  { mode: 'school', track: 'exam', exam: 'KET（A2 Key）', mod: '听力 + 口语', part: 'L0', focus: '听懂关键信息', minutes: 15, name: '小虎' }
];

const DEFAULT_STATE = {
  mode: 'quick', kind: 'practice',
  name: '', self: '能说简单句', grade: '五年级',
  src: 'topic', topic: '动物与自然',
  track: 'school', stage: 'primary', gradeS: '三年级', book: '人教PEP（三年级起点）',
  term: '上册', unit: 3, lesson: '',
  exam: 'KET（A2 Key）', mod: '听力 + 口语', part: '',
  focus: '听说综合', minutes: 10,
  langMode: 'auto', pronCheck: true, summary: true, goal: '',
  device: 'cloud'
};

Page({
  data: {
    state: Object.assign({}, DEFAULT_STATE),
    profileInfo: '未加载档案',
    prompt: '',
    /* 选项池（picker 用） */
    gradeQuickOptions: GRADES_ALL,
    gradeOptions: GRADES.primary,
    bookOptions: BOOKS.primary.map(b => ({ label: b, value: b })),
    termOptions: ['上册', '下册'],
    unitOptions: UNIT_NUM,
    lessonOptions: ['', '第1课时', '第2课时', '第3课时'],
    examOptions: EXAMS,
    partOptions: [],
    topicOptions: TOPICS.topic,
    /* chips 选项 */
    selfOptions: ['刚开始，需要较多提示', '能说简单句', '能连续说几句'],
    focusOptions: ['听说综合', '听懂关键信息', '开口完成对话', '听完简单复述', '表达自己的想法'],
    timeOptions: [5, 10, 15],
    langOptions: ['auto', '中英结合', '英语为主', '全英语为主'],
    pronOptions: ['1', '0'],
    sumOptions: ['1', '0'],
    srcOptions: [{ k: 'topic', t: '兴趣主题' }, { k: 'task', t: '生活任务' }, { k: 'world', t: '世界见闻' }, { k: 'free', t: '自由主题' }],
    modOptions: ['听力', '口语', '听力 + 口语'],
    stageOptions: [{ k: 'primary', t: '小学' }, { k: 'junior', t: '初中' }],
    trackOptions: [{ k: 'school', t: '校内同步' }, { k: 'exam', t: '剑桥考试' }],
    kindOptions: [{ k: 'practice', t: '听说练习单' }, { k: 'cards', t: '新词听读卡' }],
    modeOptions: [{ k: 'quick', t: '快速开练' }, { k: 'school', t: '按教材练' }],
    deviceOptions: [{ k: 'cloud', t: '电脑云电脑 · 带技能' }, { k: 'phone', t: '手机语音通话 · 自包含单' }],
    quickPlans: QUICK_PLANS,
    /* picker 当前选中下标（WXML 不支持 indexOf，统一在 JS 预计算） */
    giQuick: 4, giSchool: 2, bi: 0, ti: 0, ui: 3, li: 0, ei: 3, pi: 0,
    /* 折叠 / 抽屉状态 */
    advOpen: false,
    quickOpen: false,
    preview: { coord: '', focus: '', time: '' }
  },

  noop() {},
  toggleAdv() { this.setData({ advOpen: !this.data.advOpen }); },
  openQuick() { this.setData({ quickOpen: true }); },
  closeQuick() { this.setData({ quickOpen: false }); },

  /* 预览摘要（与看板「今天的练习」renderPV 一致，随选择实时更新） */
  preview() {
    const s = this.data.state;
    let coord;
    if (s.mode === 'quick') coord = SRC_NAME[s.src] + ' · ' + s.topic;
    else if (s.track === 'school') {
      const unitTxt = s.unit === 0 ? '当前单元' : ('Unit ' + s.unit);
      const th = this.themePreview();
      coord = (s.stage === 'primary' ? '小学' : '初中') + ' · ' + s.book + ' · ' + s.term + ' · ' + unitTxt + (th ? (' · ' + th) : '');
    } else {
      const pm = this.partMeta();
      coord = s.exam + (pm ? (' · ' + pm.kind + ' ' + pm.name) : '');
    }
    return { coord: coord, focus: s.focus, time: s.minutes + ' 分钟' };
  },

  sampleIdx: 0,

  onLoad() {
    this.applyProfile();
  },

  /* ===================== 档案联动 ===================== */
  normalizeGrade(g) {
    if (!g) return '';
    if (GRADES_ALL.indexOf(g) >= 0) return g;
    for (let i = 0; i < GRADES_ALL.length; i++) { if (g.indexOf(GRADES_ALL[i]) >= 0) return GRADES_ALL[i]; }
    const m = g.match(/(\d+)\s*年级/);
    if (m) { const n = +m[1] - 1; if (n >= 0 && n < GRADES_ALL.length) return GRADES_ALL[n]; }
    return '';
  },
  stageFromProfile(u, lr, grade) {
    if (['七年级', '八年级', '九年级'].indexOf(grade) >= 0) return 'junior';
    if (grade) return 'primary';
    const st = (lr && lr.stage) || '';
    if (st.indexOf('初中') >= 0 || st.indexOf('高中') >= 0) return 'junior';
    if (st.indexOf('小学') >= 0 || st.indexOf('幼儿园') >= 0) return 'primary';
    return this.data.state.stage;
  },
  parseUnit(progress) {
    if (!progress) return 0;
    const m = progress.match(/(\d+)/);
    if (m) { const n = +m[1]; if (n >= 1 && n <= 12) return n; }
    return 0;
  },
  applyProfile() {
    const u = store.get();
    if (!u) { this.setData({ profileInfo: '未找到孩子档案' }); return; }
    const lr = store.getLearner();
    const sp = (u.subjectProfiles && u.subjectProfiles.english) || {};
    const name = u.nickname || '';
    const grade = this.normalizeGrade(u.grade);
    const stage = this.stageFromProfile(u, lr, grade);
    const book = sp.textbook || '';
    const progress = sp.progress || '';
    const unit = this.parseUnit(progress);
    const s = this.data.state;
    s.name = name;
    if (grade) { s.grade = grade; s.gradeS = grade; }
    if (stage && stage !== s.stage) s.stage = stage;
    if (book) s.book = book;
    if (/下册/.test(progress)) s.term = '下册';
    if (unit > 0) s.unit = unit;
    const bits = [];
    if (name) bits.push(name);
    if (grade) bits.push(grade);
    if (book) bits.push(book);
    if (progress) bits.push('进度 ' + progress);
    if (sp.learnerNo) bits.push('编号 ' + sp.learnerNo);
    this.setData({ state: s, profileInfo: bits.length ? ('已带入：' + bits.join(' · ')) : '已带入（档案信息较少，请手动补充）' });
    this.refresh();
  },
  pullProfile() {
    this.applyProfile();
    wx.showToast({ title: '已带入 / 刷新英语档案，可继续手动调整', icon: 'none' });
  },

  /* ===================== 渲染 ===================== */
  idxOf(arr, v, d) { const i = arr.indexOf(v); return i >= 0 ? i : (d === undefined ? 0 : d); },
  refresh() {
    const s = this.data.state;
    const baseBooks = BOOKS[s.stage] || [];
    let bookList = baseBooks.slice();
    if (s.book && baseBooks.indexOf(s.book) < 0) bookList.push(s.book);
    const bookOptions = bookList.map(b => ({ label: (baseBooks.indexOf(b) < 0) ? (b + '（档案）') : b, value: b }));
    const gradeOpts = (s.mode === 'quick') ? GRADES_ALL : (GRADES[s.stage] || GRADES_ALL);
    const topicOpts = (TOPICS[s.src] || []).slice();
    const partOpts = this.partOptions();
    /* picker 选中下标（WXML 不支持 indexOf，统一在 JS 预计算） */
    const giQuick = this.idxOf(GRADES_ALL, s.grade);
    const giSchool = this.idxOf(GRADES[s.stage] || GRADES_ALL, s.gradeS);
    const bi = this.idxOf(bookList, s.book);
    const ti = this.idxOf(this.data.termOptions, s.term);
    const ui = (typeof s.unit === 'number' && s.unit >= 0 && s.unit < UNIT_NUM.length) ? s.unit : 0;
    const li = this.idxOf(this.data.lessonOptions, s.lesson);
    const ei = this.idxOf(EXAMS, s.exam);
    let pi = 0;
    for (let i = 0; i < partOpts.length; i++) { if (partOpts[i].value === s.part) { pi = i; break; } }
    this.setData({
      state: s,
      gradeOptions: gradeOpts,
      bookOptions: bookOptions,
      partOptions: partOpts,
      topicOptions: topicOpts,
      prompt: this.buildPrompt(),
      preview: this.preview(),
      giQuick: giQuick, giSchool: giSchool, bi: bi, ti: ti, ui: ui, li: li, ei: ei, pi: pi
    });
  },

  /* ===================== 提示词生成（与看板逐字一致） ===================== */
  gradeLevel() {
    const s = this.data.state;
    if (s.mode === 'school' && s.track === 'exam') return EXAM_STRUCT[s.exam].lv;
    const g = s.mode === 'quick' ? s.grade : s.gradeS;
    if (['一年级', '二年级', '三年级'].indexOf(g) >= 0) return 'L';
    if (['四年级', '五年级', '六年级'].indexOf(g) >= 0) return 'M';
    return 'H';
  },
  themePreview() {
    const s = this.data.state;
    if (s.mode !== 'school' || s.track !== 'school' || s.unit === 0) return '';
    return THEMES[`${s.book}|${s.gradeS}|${s.term}|${s.unit}`] || '';
  },
  langDesc() {
    const s = this.data.state;
    const lv = this.gradeLevel();
    let mode = s.langMode;
    if (mode === 'auto') mode = lv === 'L' ? '中英结合' : (lv === 'M' ? '英语为主' : '全英语为主');
    return `反馈语言：${mode}，必要时中文提示`;
  },
  partMeta() {
    const s = this.data.state;
    if (!s.part || s.mode !== 'school' || s.track !== 'exam') return null;
    const k = s.part[0] === 'L' ? 'listen' : 'speak';
    const idx = +s.part.slice(1);
    const st = EXAM_STRUCT[s.exam];
    const name = st[k][idx] || '';
    const m = name.match(/（标准 (\d+) (题|空)）/);
    return { kind: k === 'listen' ? '听力' : '口语', name: name.replace(/（标准.*$/, ''), std: m ? m[1] : '' };
  },
  partOptions() {
    const s = this.data.state;
    if (s.mode !== 'school' || s.track !== 'exam') return [];
    const st = EXAM_STRUCT[s.exam]; if (!st) return [];
    const opts = [];
    if (s.mod.indexOf('听力') >= 0) st.listen.forEach((p, i) => opts.push({ label: '[听] ' + p, value: 'L' + i }));
    if (s.mod.indexOf('口语') >= 0) st.speak.forEach((p, i) => opts.push({ label: '[说] ' + p, value: 'S' + i }));
    return opts;
  },
  buildPrompt() {
    const s = this.data.state;
    const lvName = { L: '入门', M: '成长', H: '自主' }[this.gradeLevel()];
    const lv = this.gradeLevel();
    const name = s.name || '同学';
    /* ===== 新词听读卡模式 ===== */
    if (s.kind === 'cards') {
      const nWord = lv === 'L' ? 8 : lv === 'M' ? 12 : 15;
      const sentLen = lv === 'L' ? 6 : lv === 'M' ? 10 : 15;
      const lines = ['【SpeakStep 新词听读卡】',
        `称呼：${name}（导学与小结中使用）`,
        `年级：${s.mode === 'quick' ? s.grade : s.gradeS}（${lvName}档）`];
      if (s.mode === 'quick') {
        lines.push(`内容来源：${SRC_NAME[s.src]}`, `主题：${s.topic}`);
      } else if (s.track === 'school') {
        const unitTxt = s.unit === 0 ? '当前单元' : 'Unit ' + s.unit + (s.lesson ? ('（' + s.lesson + '）') : '');
        lines.push(`内容来源：校内同步`,
          `教材坐标：${s.stage === 'primary' ? '小学' : '初中'} · ${s.gradeS} · ${s.book} · ${s.term} · ${unitTxt}`);
        if (s.goal) lines.push(`本课词句：${s.goal}`);
        lines.push('请围绕上述坐标设计；不声称复现教材词表原文，如需严格同步请在本对话提供课本内容');
      } else {
        lines.push(`内容来源：剑桥考试`, `考试：${s.exam}`, `词汇范围：${EXAM_STRUCT[s.exam].words}`);
      }
      lines.push('',
        '【请按以下规则输出单词听读卡】',
        `1. 先选出本单元/本主题核心新词 ${nWord} 个（按${lv}档），按出现频率从高到低排`,
        `2. 每张卡包含：单词 + 教练读一遍 + 一个适龄例句（不超过 ${sentLen} 词）+ 一个跟读提示（重音/尾音/连读，不编发音分数）+ 一个小应用问题（让孩子用这个词说一句自己的话）`,
        '3. 逐张出卡：先读词 → 例句 → 让孩子跟读 → 问小应用问题，孩子答完再出下一张，不要一次性把所有卡片倒出来',
        '4. 出完卡片后，请孩子从这组词里挑 3 个，各说一句和自己有关的话',
        '5. 最后做一个快速小测：随机念 3 个词的中文意思，让孩子说出英文，或反过来',
        '6. 结束用「' + name + '」称呼给简短小结：哪几个词读得顺、哪个词还不熟、下次建议复习哪几个');
      if (s.device === 'phone') {
        lines.push('',
          '【执行规则：语音通话模式，技能未加载，请严格遵守】',
          '- 你是' + lv + '档英语听说教练，句子难度按孩子水平，新词先说再解释',
          '- 一次只出一张卡；先让孩子跟读/回答，再简短反馈',
          '- 发音可指出重音、尾音、节奏，但不编造百分制分数');
      }
      return lines.join('\n');
    }
    /* ===== 听说练习单模式 ===== */
    const lines = ['【SpeakStep 听说练习单】',
      `称呼：${name}（导学与小结中使用）`];
    if (s.mode === 'quick') lines.push(`年级：${s.grade}（${lvName}档）`);
    else if (s.track === 'school') lines.push(`年级：${s.gradeS}（${lvName}档）`);
    lines.push(`起步水平：${s.self}`);
    if (s.mode === 'quick') {
      lines.push(`内容来源：${SRC_NAME[s.src]}`, `主题：${s.topic}`);
    } else if (s.track === 'school') {
      const unitTxt = s.unit === 0 ? '当前单元' : 'Unit ' + s.unit + (s.lesson ? ('（' + s.lesson + '）') : '');
      lines.push(`内容来源：校内同步`,
        `教材坐标：${s.stage === 'primary' ? '小学' : '初中'} · ${s.gradeS} · ${s.book} · ${s.term} · ${unitTxt}`);
      if (s.goal) lines.push(`本课词句：${s.goal}`);
      lines.push('请围绕上述坐标设计适龄的听说练习；不声称复现教材原文，如需严格同步请在本对话提供课本内容');
    } else {
      const pm = this.partMeta();
      const partTxt = pm ? `${pm.kind} ${pm.name}${pm.std ? `（标准 ${pm.std} 题，本次练 2-3 题）` : ''}` : '各 Part 按顺序混练';
      lines.push(`内容来源：剑桥考试`,
        `考试：${s.exam} · ${partTxt}`,
        `词汇范围：${EXAM_STRUCT[s.exam].words}`);
    }
    lines.push(`今天重点：${s.focus}`, `时长：${s.minutes} 分钟`, this.langDesc());
    if (s.pronCheck) lines.push('加入一句跟读练习：孩子按教练示范自行比较清晰度与节奏，不提供机器发音分数');
    if (s.summary) lines.push('结束生成简短小结：练习证据 + 需要复习 + 下次建议');
    lines.push('请直接开始语音友好的听说练习：一次只给一个任务，先让孩子回答，再简短反馈');
    if (s.device === 'phone') {
      const mins = s.minutes;
      const rounds = mins <= 5 ? '3-4 个回合' : mins <= 10 ? '5-7 个回合' : '7-9 个回合';
      lines.push('',
        '【执行规则：语音通话模式，技能未加载，请严格遵守】',
        `- 你是${this.gradeLevel() === 'L' ? '入门' : '成长'}档英语听说教练，面向${name}（${s.mode === 'quick' ? s.grade : s.gradeS}），句子难度按其水平，新词先说再解释`,
        '- 一次只给一个任务；先让孩子开口回答，再简短反馈，不连续讲长课',
        '- 每轮最多纠正 1-2 个最重要问题：先肯定有效部分 → 给更自然的说法 → 让孩子再说一遍 → 继续情境',
        '- 反馈语言：' + (s.langMode === 'auto' ? (this.gradeLevel() === 'L' ? '中英结合' : '英语为主') : s.langMode) + '，必要时中文一句提示',
        '- 发音：可具体指出重音、尾音、节奏问题，但不编造百分制分数',
        '',
        '【流程骨架：本次练习共 ' + mins + ' 分钟，必须走完以下环节，不要 2-3 个回合就收尾】',
        '1. 热身（1 轮）：用熟悉话题问一个简单问题，让孩子开口',
        '2. 示范输入（1 轮）：围绕教材/主题，主动给出 2-4 句英语示范；如来自教材坐标，先从该单元提炼 2-3 个核心句型作为本轮目标表达',
        '3. 理解检查（1 轮）：就示范内容问一个低负担问题（关键词/对错/大意）',
        '4. 口语输出（' + (mins <= 5 ? '1' : '3-4') + ' 轮）：围绕核心句型让孩子完成情境任务，逐轮追问或换场景',
        '5. 变式迁移（1 轮）：把刚练的句型换到新人物/新地点/新任务，让孩子自己换说法',
        '6. 小结（1 轮）：用「' + name + '」称呼简短收尾',
        `全程至少 ${rounds}；每环节都要推进内容深度，不要泛泛聊两三句就结束`,
        '结束用「' + name + '」称呼给简短小结（练了什么 / 哪里好 / 下次练什么）');
    }
    return lines.join('\n');
  },

  /* ===================== 交互 ===================== */
  setMode(e) { this.data.state.mode = e.currentTarget.dataset.k; this.refresh(); },
  setKind(e) { this.data.state.kind = e.currentTarget.dataset.k; this.refresh(); },
  setDevice(e) { this.data.state.device = e.currentTarget.dataset.k; this.refresh(); },
  setTrack(e) { this.data.state.track = e.currentTarget.dataset.k; this.data.state.part = ''; this.refresh(); },
  setStage(e) {
    const st = e.currentTarget.dataset.k;
    this.data.state.stage = st;
    this.data.state.gradeS = (GRADES[st] || GRADES_ALL)[2];
    this.data.state.book = (BOOKS[st] || [])[0];
    this.refresh();
  },
  setSelf(e) { this.data.state.self = e.currentTarget.dataset.self; this.refresh(); },
  setFocus(e) { this.data.state.focus = e.currentTarget.dataset.focus; this.refresh(); },
  setTime(e) { this.data.state.minutes = Number(e.currentTarget.dataset.min); this.refresh(); },
  setSrc(e) {
    const src = e.currentTarget.dataset.src;
    this.data.state.src = src;
    this.data.state.topic = (TOPICS[src] || [])[0] || '';
    this.refresh();
  },
  setLang(e) { this.data.state.langMode = e.currentTarget.dataset.lang; this.refresh(); },
  setMod(e) { this.data.state.mod = e.currentTarget.dataset.mod; this.data.state.part = ''; this.refresh(); },
  setPron(e) { this.data.state.pronCheck = e.currentTarget.dataset.p === '1'; this.refresh(); },
  setSum(e) { this.data.state.summary = e.currentTarget.dataset.s === '1'; this.refresh(); },
  onTopicTap(e) { this.data.state.topic = e.currentTarget.dataset.topic; this.refresh(); },

  onGradeQuick(e) { this.data.state.grade = this.data.gradeQuickOptions[Number(e.detail.value)]; this.refresh(); },
  onGrade(e) { this.data.state.gradeS = this.data.gradeOptions[Number(e.detail.value)]; this.refresh(); },
  onBook(e) { this.data.state.book = this.data.bookOptions[Number(e.detail.value)].value; this.refresh(); },
  onTerm(e) { this.data.state.term = this.data.termOptions[Number(e.detail.value)]; this.refresh(); },
  onUnit(e) { this.data.state.unit = Number(e.detail.value); this.refresh(); },
  onLesson(e) { this.data.state.lesson = this.data.lessonOptions[Number(e.detail.value)]; this.refresh(); },
  onExam(e) { this.data.state.exam = this.data.examOptions[Number(e.detail.value)]; this.data.state.part = ''; this.refresh(); },
  onPart(e) { this.data.state.part = this.data.partOptions[Number(e.detail.value)].value; this.refresh(); },

  onName(e) { this.data.state.name = e.detail.value; this.setData({ prompt: this.buildPrompt() }); },
  onGoal(e) { this.data.state.goal = e.detail.value; this.setData({ prompt: this.buildPrompt() }); },
  onFreeTopic(e) { this.data.state.topic = e.detail.value; this.setData({ prompt: this.buildPrompt() }); },

  pickQuick(e) {
    const q = QUICK_PLANS[Number(e.currentTarget.dataset.i)];
    Object.assign(this.data.state, q.set, { mode: 'quick' });
    this.refresh();
    wx.showToast({ title: '已填入：' + q.n + '，仍可在下方修改', icon: 'none' });
  },
  onSample() {
    const s = SAMPLES[this.sampleIdx % SAMPLES.length]; this.sampleIdx++;
    Object.assign(this.data.state, s);
    this.refresh();
  },

  copyPrompt() {
    const txt = this.buildPrompt();
    wx.setClipboardData({
      data: txt,
      success: () => wx.showToast({ title: '已复制，去豆包粘贴发送', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请手动选择', icon: 'none' })
    });
  }
});

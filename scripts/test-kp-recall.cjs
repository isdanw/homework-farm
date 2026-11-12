/**
 * kpRecall 讲解召回单测（端上纯函数，无 wx / 无云）
 * 运行：node scripts/test-kp-recall.cjs
 * 覆盖：相关性排序 / 无关不注入 / 空清单 fail-open / 先修欠账 / 卡关联(unitId+kpId) /
 *       错题订正动作 / 长度上限 / 入参只读 / 噪声问句 / 合规措辞（不出现掌握断言）/
 *       端上与云函数接线静态校验（refCtx、来源展示、画像备忘字段）
 */
const path = require('path');
const R = require('../miniprogram/utils/kpRecall.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const unit1 = {
  id: 'u_math_3', subject: 'math', title: '第三单元 比较与分类', updatedAt: 200,
  points: [
    { id: 'kp_bibigger', topic: '比大小', front: '先看两边数量', back: '再用 ＞＜＝ 连接', order: 1,
      assessmentPrompt: '哪边多哪边少，用什么符号？',
      prereqs: [{ topic: '10以内数数', strength: 'hard', reason: '数不清楚就无法比较' }] },
    { id: 'kp_fenlei', topic: '按颜色分类', front: '挑出相同颜色的物体', back: '说出一类有几个', order: 2, prereqs: [] },
    { id: 'kp_10shushu', topic: '10以内数数', front: '一个一个数', back: '说出总数', order: 0, prereqs: [] }
  ]
};
const unit2 = {
  id: 'u_math_2', subject: 'math', title: '第二单元 加减法', updatedAt: 100,
  points: [
    { id: 'kp_jiafa', topic: '5以内加法', front: '合起来一共', back: '2+3=5', order: 1, prereqs: [] }
  ]
};
const units = [unit1, unit2];

const cards = [
  { id: 'c1', unitId: 'u_math_3', kpId: 'kp_bibigger', topic: '比大小', front: '5和3谁大？', back: '5（比3大）', done: false, dueAt: 10 },
  { id: 'c2', unitId: 'u_math_3', kpId: 'kp_10shushu', topic: '10以内数数', front: '数到7', back: '7', done: false, dueAt: 20 },
  { id: 'c3', unitId: 'other_unit', kpId: 'kp_bibigger', topic: '比大小', front: '跨单元同 kpId 的卡', back: '不该被带进来', done: false, dueAt: 1 }
];
const mistakes = [
  { id: 'm1', subject: 'math', topic: '比大小符号方向反了', errorType: 'E3', suggestion: '写完回读一遍，箭头开口朝大数', createdAt: 300 },
  { id: 'm2', subject: 'math', topic: '20以内退位减', errorType: 'E7', suggestion: '画数轴先退一再减', createdAt: 400 }
];

console.log('\n── A. 相关性召回 ──');
const a = R.buildRecall({ query: '比大小这题怎么想？', subject: 'math', units, cards, mistakes });
ok('A 命中并返回材料', !!a && !!a.text, a && a.text);
ok('A 首位来源=比大小', a && a.sources[0].kpId === 'kp_bibigger', a && JSON.stringify(a.sources));
ok('A 带单元标题可溯源', a && a.sources[0].unitTitle === '第三单元 比较与分类');
ok('A 自测问法进材料', a && a.text.indexOf('自测问法') >= 0);
ok('A 讲解抓手（front→back）进材料', a && a.text.indexOf('2+3=5') >= 0 || a.text.indexOf('＞＜＝') >= 0);
ok('A 引用到本单元卡（unitId+kpId 双条件）', a && a.sources[0].cards === 1, a && String(a.sources[0].cards));
ok('A 跨单元同 kpId 的卡未被误关联', a && a.text.indexOf('不该被带进来') < 0);
ok('A 带出孩子推通过的问法', a && a.text.indexOf('5和3谁大') >= 0);
ok('A 先修欠账（10以内数数无 done 卡时）', a && a.text.indexOf('先修还没走通') >= 0, a && a.text);
ok('A 关联到错题订正动作', a && a.text.indexOf('箭头开口朝大数') >= 0);

console.log('\n── B. 先修已走通则不报欠账 ──');
const b = R.buildRecall({ query: '比大小', subject: 'math', units,
  cards: cards.concat([{ id: 'c4', unitId: 'u_math_3', kpId: 'kp_10shushu', topic: '10以内数数', front: 'f', back: 'b', done: true }]), mistakes });
ok('B 已毕业的先修不再标欠账', b && b.text.indexOf('先修还没走通') < 0, b && b.text);

console.log('\n── C. 不相关 / 空数据 fail-open ──');
ok('C 无关提问不注入', R.buildRecall({ query: '今天天气怎么样啊', subject: 'math', units, cards, mistakes }) === null);
ok('C 空清单返回 null', R.buildRecall({ query: '比大小', subject: 'math', units: [], cards, mistakes }) === null);
ok('C 空问句返回 null', R.buildRecall({ query: '', subject: 'math', units, cards, mistakes }) === null);
ok('C 全空数据返回 null', R.buildRecall({}) === null);

console.log('\n── D. 噪声问句不炸 ──');
const d1 = R.buildRecall({ query: '这题答案是什么', subject: 'math', units, cards, mistakes });
ok('D 纯噪声问句安全返回（null 或有界结果）', d1 === null || d1.text.length <= R.MAX_CHARS, d1 && d1.text.length);
const d2 = R.buildRecall({ query: 'constructor', subject: 'math', units, cards, mistakes });
ok('D 原型链词不误判为噪声', d2 === null || typeof d2.text === 'string');

console.log('\n── E. 输出预算 ──');
const fat = { id: 'u_fat', subject: 'math', title: '长清单单元', updatedAt: 999,
  points: Array.from({ length: 60 }, (_, i) => ({
    id: 'k' + i, topic: '比大小变式' + i, front: 'F'.repeat(80), back: 'B'.repeat(80),
    assessmentPrompt: 'P'.repeat(80), order: i, prereqs: []
  })) };
const e = R.buildRecall({ query: '比大小变式3', subject: 'math', units: [fat], cards: [], mistakes: [] });
ok('E 材料不超上限', e && e.text.length <= R.MAX_CHARS, e && e.text.length);
ok('E 最多 4 条来源', e && e.sources.length <= R.MAX_POINTS, e && String(e.sources.length));

console.log('\n── F. 只读边界（不修改入参、不产证据） ──');
const snapUnits = JSON.stringify(units), snapCards = JSON.stringify(cards), snapMk = JSON.stringify(mistakes);
R.buildRecall({ query: '比大小 5以内加法', subject: 'math', units, cards, mistakes });
ok('F units 未被改写', JSON.stringify(units) === snapUnits);
ok('F cards 未被改写', JSON.stringify(cards) === snapCards);
ok('F mistakes 未被改写', JSON.stringify(mistakes) === snapMk);

console.log('\n── G. 合规措辞：召回块不得自带掌握断言 ──');
const g = R.buildRecall({ query: '按颜色分类', subject: 'math', units, cards, mistakes });
const BANNED = ['已掌握', '掌握了', '学会了', '已精通', '完全掌握', '稳稳掌握', '全懂了'];
ok('G 无掌握类绝对化表述', g === null || BANNED.every(w => g.text.indexOf(w) < 0),
  g && BANNED.filter(w => g.text.indexOf(w) >= 0).join(','));
ok('G sources 字段限定在定位信息内', g && Object.keys(g.sources[0]).every(k =>
  ['uid', 'unitTitle', 'unitId', 'kpId', 'topic', 'score', 'cards'].indexOf(k) >= 0));
ok('G 渲染键带单元前缀（kpId 仅单元内唯一）', g && g.sources[0].uid === g.sources[0].unitId + '::' + g.sources[0].kpId);

console.log('\n── H. 错因只影响排序，不产生判定 ──');
const h1 = R.buildRecall({ query: '比大小', subject: 'math', units, cards, mistakes, errorType: 'E3' });
const h2 = R.buildRecall({ query: '比大小', subject: 'math', units, cards, mistakes, errorType: 'E9' });
ok('H 有结果且文本不含错因编号', h1 && h2 && h1.text.indexOf('E3') < 0 && h2.text.indexOf('E9') < 0);
ok('H 召回结论稳定（同问句同数据同来源）',
  JSON.stringify(h1.sources.map(s => s.kpId)) === JSON.stringify(h2.sources.map(s => s.kpId)));

console.log('\n── I. 端上与云函数接线（静态，防静默断链） ──');
const fs = require('fs');
const p = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const tutorJs = p('miniprogram/pkgGuide/tutor/tutor.js');
const tutorWxml = p('miniprogram/pkgGuide/tutor/tutor.wxml');
const chatJs = p('cloudfunctions/tutorChat/index.js');
const profileJs = p('miniprogram/pkgGuide/learnerProfile/learnerProfile.js');
const storeJs = p('miniprogram/utils/store.js');
const tutorStoreJs = p('miniprogram/utils/tutorStore.js');
ok('导学页引入 kpRecall', tutorJs.indexOf("require('../../utils/kpRecall.js')") >= 0);
ok('导学页按学科跨单元取清单', tutorStoreJs.indexOf('getUnitKpsListBySubject') >= 0 && tutorJs.indexOf('getUnitKpsListBySubject') >= 0);
ok('导学页组装 refCtx 进载荷', tutorJs.indexOf('refCtx: recall ? recall.text') >= 0);
ok('导学页把来源挂到回复', tutorJs.indexOf('aiMsg.refs = this._lastRefs') >= 0);
ok('导学页把备忘与讲解长度传给云函数', tutorJs.indexOf('coachNote: lr.coachNote') >= 0 && tutorJs.indexOf('replyLength: lr.replyLength') >= 0);
ok('WXML 渲染来源行（uid 作键）', tutorWxml.indexOf('item.refs') >= 0 && tutorWxml.indexOf('wx:key="uid"') >= 0);
ok('WXML 来源行措辞是「讲解材料」不是掌握标签', tutorWxml.indexOf('本轮讲解材料') >= 0);
ok('云函数解析并截断 refCtx', chatJs.indexOf('str(event.refCtx, 1200)') >= 0);
ok('云函数把 refCtx 传进 buildMessages', /buildMessages\([^)]*input\.refCtx/s.test(chatJs));
ok('画像页保存讲解长度与备忘', profileJs.indexOf('replyLength: d.lengthIndex') >= 0 && profileJs.indexOf('coachNote: (d.coachNote') >= 0);
ok('画像页备忘落库前截断 120', profileJs.indexOf('.slice(0, 120)') >= 0);
ok('store 默认画像含新字段（只增不改）', storeJs.indexOf('replyLength:') >= 0 && storeJs.indexOf('coachNote:') >= 0);

console.log('\n════ kpRecall：' + pass + ' 通过 / ' + fail + ' 失败 ════\n');
process.exit(fail ? 1 : 0);

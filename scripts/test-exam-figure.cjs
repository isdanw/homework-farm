#!/usr/bin/env node
/**
 * 图形题（结构化 figure）回归测试
 *
 * 背景：AI 出的图形题题干写着「如下图…」，但契约里没有图字段，两端也就没图可画。
 * 现在云端让 AI 用基本图元描述题图（line/poly/circle/text），两端各自原生绘制。
 *
 * 【本测试锁住的三件事】
 *   ① 脏数据洗不坏端上：坐标越界夹取、图元白名单、图元/点数上限、文字过合规门禁；
 *      洗不出任何图元就整块丢弃 —— 老客户端退化成「只有题干」，而不是画出乱线。
 *   ② 契约贯通：parseExam（AI 出卷）/ saveExam（iPad/网页存卷）两条写入路径都保图。
 *   ③ 端上实现真的在：小程序 utils/figureDraw.js 与小程序的 canvas 声明存在。
 *
 * 运行：node scripts/test-exam-figure.cjs   （退出码非 0 即失败）
 */
'use strict';

const fs = require('fs');
const path = require('path');

process.env.EXAM_TEST = '1';
const REPO = path.resolve(__dirname, '..');
const M = require(path.join(REPO, 'cloudfunctions', 'examService', 'index.js'));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function section(t) { console.log('\n' + t); }

/* ================================================================== */
section('[1] normFigure：合法图原样保形');
const legal = {
  w: 160, h: 120,
  items: [
    { k: 'line', x1: 10, y1: 10, x2: 150, y2: 10 },
    { k: 'poly', pts: [[10, 10], [150, 10], [150, 100]], closed: true },
    { k: 'poly', pts: [[10, 10], [60, 60]], closed: false, dash: true },
    { k: 'circle', cx: 80, cy: 60, r: 20, fill: true },
    { k: 'text', x: 12, y: 8, t: 'A' }
  ]
};
const n1 = M.normFigure(legal);
ok(!!n1, '合法 figure 保留');
ok(n1 && n1.w === 160 && n1.h === 120, '画布尺寸透传');
ok(n1 && n1.items.length === 5, '5 个图元一个不少');
ok(n1 && n1.items[0].k === 'line' && n1.items[0].x2 === 150, 'line 端点保留');
ok(n1 && JSON.stringify(n1.items[1].pts) === JSON.stringify([[10, 10], [150, 10], [150, 100]]), 'poly 顶点保序');
ok(n1 && n1.items[2].closed === false && n1.items[2].dash === true, 'open/dash 标志保留');
ok(n1 && n1.items[3].fill === true, 'circle 填充标志保留');
ok(n1 && n1.items[4].t === 'A', 'text 内容保留');
ok(n1 && n1.items[1].fill === false, '未给 fill 默认 false（不误填阴影）');

/* ================================================================== */
section('[2] normFigure：脏数据清洗（端上不会被画崩）');
const dirty = M.normFigure({
  w: 9999, h: 1,
  items: [
    { k: 'line', x1: -50, y1: 0, x2: 9999, y2: 'abc' },
    { k: 'img', src: 'http://evil/x.png' },
    { k: 'poly', pts: [[0, 0]] },
    { k: 'circle', cx: 10, cy: 10, r: 9999 },
    { k: 'text', x: 5, y: 5, t: '孩子已掌握了' },
    { k: 'text', x: 5, y: 5, t: '   ' }
  ]
});
ok(dirty && dirty.w === 320 && dirty.h === 30, '画布宽高夹到 40~320 / 30~240');
ok(dirty && dirty.items.length === 3, '未知图元(img)/单点 poly/空文字被丢弃，剩 3 个');
ok(dirty && dirty.items[0].x1 === 0 && dirty.items[0].x2 === 320, '越界坐标夹进画布');
ok(dirty && dirty.items[0].y2 === 0, '非数字坐标回落默认 0');
ok(dirty && dirty.items[1].r === 15, '圆半径夹到 min(w,h)/2');
ok(dirty && dirty.items[2].t === '孩子达成较好了', '图内文字过合规门禁（已掌握→达成较好）');

const capped = M.normFigure({ w: 100, h: 100, items: Array.from({ length: 50 }, () => ({ k: 'line', x1: 0, y1: 0, x2: 10, y2: 10 })) });
ok(capped && capped.items.length === 30, '图元数量上限 30（防体积爆）');
const manyPts = M.normFigure({ w: 100, h: 100, items: [{ k: 'poly', pts: Array.from({ length: 40 }, (_, i) => [i, i]) }] });
ok(manyPts && manyPts.items[0].pts.length === 16, 'poly 顶点上限 16');
const longText = M.normFigure({ w: 100, h: 100, items: [{ k: 'text', x: 1, y: 1, t: '一二三四五六七八九十一二三四五六七八九十' }] });
ok(longText && longText.items[0].t.length === 16, '标注文字截到 16 字');

/* 反证：normFigure 不是恒等函数（恒等实现会让上面这批断言全绿但端上乱画） */
ok(M.normFigure({ w: 9999, h: 1, items: [{ k: 'img' }] }) === null, '反证：洗空的 figure 返回 null（不是原样透传）');
ok(M.normFigure(null) === null && M.normFigure([]) === null && M.normFigure('x') === null, '反证：null/数组/字符串一律 null');
ok(M.normFigure({ items: [] }) === null, '反证：items 空 → null');

/* ================================================================== */
section('[3] parseExam：AI 出卷带图');
const parsed = M.parseExam(JSON.stringify({
  name: '数学·图形与几何专项', examType: 'special_test', suggestedDuration: 30,
  questions: [
    {
      id: 'q1', type: 'fill', stem: '长方形的长是6厘米、宽是4厘米，周长是多少厘米？', answer: '20厘米', points: 5,
      figure: { w: 160, h: 100, items: [{ k: 'poly', pts: [[10, 10], [150, 10], [150, 90], [10, 90]], closed: true }] }
    },
    { id: 'q2', type: 'fill', stem: '2+3=', answer: '5', points: 5 },
    { id: 'q3', type: 'fill', stem: '脏图题', answer: 'x', points: 5, figure: { w: 100, h: 100, items: [{ k: 'img', src: 'x' }] } }
  ]
}));
ok(parsed && parsed.questions.length === 3, '三题全部保留（图坏了不连累题干）');
ok(parsed && parsed.questions[0].figure && parsed.questions[0].figure.items.length === 1, '第 1 题 figure 落库');
ok(parsed && !('figure' in parsed.questions[1]), '无图题不带 figure 字段（不写空对象）');
ok(parsed && !('figure' in parsed.questions[2]), '洗空的 figure 被丢弃，题仍保留');

/* ================================================================== */
section('[4] saveExam：iPad/网页存卷也保图');
function makeApp() {
  const adds = [];
  function coll() {
    return {
      where() { return { limit() { return { async get() { return { data: [] }; } }; }, async get() { return { data: [] }; } }; },
      doc() { return { async update() {} }; },
      async add(doc) { adds.push(doc); },
      async limit() { return { async get() { return { data: [] }; } }; }
    };
  }
  const app = { database: () => ({ collection: coll, createCollection: async () => {} }) };
  app.__adds = adds;
  return app;
}

(async function () {
  const app = makeApp();
  const r = await M.saveExam(app, {
    exam: {
      clientId: 'fig_save_1', name: '图形卷', subject: 'math', grade: '五年级',
      questions: [
        { id: 'q1', type: 'fill', stem: '三角形底6厘米、高4厘米，面积是多少？', answer: '12平方厘米', points: 5,
          figure: { w: 160, h: 120, items: [{ k: 'poly', pts: [[20, 100], [140, 100], [80, 20]], closed: true, fill: true }, { k: 'text', x: 80, y: 110, t: '6cm' }] } },
        { id: 'q2', type: 'fill', stem: '无图题', answer: '1', points: 5 }
      ]
    }
  }, 'o_fig');
  ok(r && r.ok === true, 'saveExam 成功');
  const saved = app.__adds[0] && app.__adds[0].questions;
  ok(!!saved && saved[0].figure && saved[0].figure.items.length === 2, '落库的题带规范化后的 figure');
  ok(!!saved && saved[0].figure.items[0].fill === true && saved[0].figure.items[1].t === '6cm', '图元字段保真');
  ok(!!saved && !('figure' in saved[1]), '无图题不写 figure 字段');

  /* ================================================================== */
  section('[5] 端上实现存在性（小程序）');
  const utilPath = path.join(REPO, 'miniprogram', 'utils', 'figureDraw.js');
  ok(fs.existsSync(utilPath), 'utils/figureDraw.js 存在');
  const util = require(utilPath);
  ok(typeof util.draw === 'function' && typeof util.paint === 'function' && typeof util.boxHeight === 'function', '导出 draw / paint / boxHeight');
  ok(util.boxHeight({ w: 160, h: 120 }) === 460, 'boxHeight 按宽高比算高度（640*120/160 后封顶 460）');
  ok(util.boxHeight({ w: 40, h: 240 }) === 460, '细高图高度封顶 460rpx（不撑爆版式）');
  ok(util.boxHeight({ w: 320, h: 30 }) === 110, '长条图高度兜底 110rpx（不缩成缝）');

  const ansWxml = fs.readFileSync(path.join(REPO, 'miniprogram', 'pkgGuide', 'examAnswer', 'examAnswer.wxml'), 'utf8');
  ok(/type="2d"[^>]*q-fig/.test(ansWxml) || /q-fig[^>]*type="2d"/.test(ansWxml), '作答页声明了 type="2d" 的题图 canvas');
  const repWxml = fs.readFileSync(path.join(REPO, 'miniprogram', 'pkgGuide', 'examReport', 'examReport.wxml'), 'utf8');
  ok(repWxml.indexOf('q-fig') >= 0, '报告页同样渲染题图');

  section('[6] iPad 端实现存在性');
  const swiftModels = fs.readFileSync(path.join(REPO, 'ipadApp', 'ExamPad', 'Core', 'Models.swift'), 'utf8');
  ok(swiftModels.indexOf('struct FigureSpec') >= 0 && swiftModels.indexOf('let figure: FigureSpec?') >= 0, 'ExamQuestion 带可选 figure');
  const swiftView = fs.readFileSync(path.join(REPO, 'ipadApp', 'ExamPad', 'Features', 'Answer', 'FigureView.swift'), 'utf8');
  ok(swiftView.indexOf('FigureView') >= 0 && swiftView.indexOf('"poly"') >= 0 && swiftView.indexOf('"circle"') >= 0, 'FigureView 支持 poly/circle');
  const answerView = fs.readFileSync(path.join(REPO, 'ipadApp', 'ExamPad', 'Features', 'Answer', 'AnswerView.swift'), 'utf8');
  ok(answerView.indexOf('FigureView(spec: fig') >= 0, '作答页插入了题图视图');

  section('[7] 出题 prompt 契约（图是 AI 按系统提示产出的）');
  const svcSrc = fs.readFileSync(path.join(REPO, 'cloudfunctions', 'examService', 'index.js'), 'utf8');
  ok(svcSrc.indexOf('题图 figure（图形题必填）') >= 0, 'GEN_SYSTEM 含 figure 规则');
  ok(svcSrc.indexOf('"k":"poly"') >= 0 && svcSrc.indexOf('"k":"circle"') >= 0 && svcSrc.indexOf('"k":"text"') >= 0, 'prompt 给出四种图元的写法');
  ok(svcSrc.indexOf('题干文字必须写全所有已知条件') >= 0, 'prompt 要求文字自带条件（图只作示意，批改不依赖图）');

  console.log('\n========================================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();

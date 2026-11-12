/**
 * test-cards-page-filter.cjs —— 复习卡页 subject/unitId 过滤回归（Action Registry D 项）
 * ==========================================================================================
 *     node scripts/test-cards-page-filter.cjs
 *     COUNTERPROOF=1 node scripts/test-cards-page-filter.cjs
 *
 * 为什么单测这一页：Action Registry 的 review_cards 声明了 subject/unitId，页面必须真的按它过滤，
 * 而不是「读进变量就丢掉」。用 mock wx + 真实 tutorStore 驱动页面定义，断言计数与标签。
 *
 * 反证：把 _allCards 的过滤改成直接返回全部 → 必须红。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PAGE_PATH = path.resolve(
  process.env.CARDS_PATH || path.join(ROOT, 'miniprogram/pkgTools/cards/cards.js')
);

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''));
}

/* ------------------------------ mock 小程序运行环境 ------------------------------ */
const storage = {};
global.wx = {
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete storage[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
  showToast: () => {},
  showModal: () => {},
  cloud: {
    callFunction: () => Promise.resolve({ result: { ok: true } }),
    init: () => {}
  }
};

let pageDef = null;
global.Page = (def) => { pageDef = def; };

const tutorStore = require(path.join(ROOT, 'miniprogram/utils/tutorStore.js'));

/* 四张卡：两张数学同一单元（1 到期 / 1 未到期）、一张语文到期、一张无学科的旧卡到期 */
const NOW = Date.now();
tutorStore.addCards([
  { id: 'c1', subject: 'math', subjectName: '数学', unitId: 'u_math', topic: '分数', front: '1/2+1/3?', back: '5/6', dueAt: NOW - 1000 },
  { id: 'c2', subject: 'math', subjectName: '数学', unitId: 'u_math', topic: '分数', front: '2/3-1/3?', back: '1/3', dueAt: NOW + 86400000 },
  { id: 'c3', subject: 'chinese', subjectName: '语文', unitId: 'u_cn', topic: '古诗', front: '床前明月光', back: '疑是地上霜', dueAt: NOW - 1000 },
  { id: 'c4', topic: '老卡', front: '无学科旧卡', back: '保留', dueAt: NOW - 1000 }
]);

tutorStore.upsertUnitKp({ id: 'u_math', subject: 'math', title: '分数的初步认识', points: [] });

require(PAGE_PATH);

function open(options) {
  const p = Object.create(pageDef);
  p.data = JSON.parse(JSON.stringify(pageDef.data));
  p.setData = function (patch, cb) {
    Object.keys(patch).forEach(k => { this.data[k] = patch[k]; });
    if (cb) cb();
  };
  p.onLoad(options);
  p.onShow();
  return p;
}

console.log('复习卡页 subject/unitId 过滤\n');

let p = open({});
ok(p.data.allCount === 4, '无参数：全部卡 4 张', 'allCount=' + p.data.allCount);
ok(p.data.dueCount === 3, '无参数：今日到期 3 张', 'dueCount=' + p.data.dueCount);
ok(p.data.filterLabel === '', '无参数：不显示筛选标签', 'label=' + p.data.filterLabel);

p = open({ subject: 'math' });
ok(p.data.allCount === 2, 'subject=math：只剩数学卡 2 张（无学科旧卡不冒充）', 'allCount=' + p.data.allCount);
ok(p.data.dueCount === 1, 'subject=math：到期 1 张', 'dueCount=' + p.data.dueCount);
ok(p.data.filterLabel.indexOf('数学') >= 0, 'subject=math：标签显示学科名', 'label=' + p.data.filterLabel);

p = open({ unitId: 'u_math' });
ok(p.data.allCount === 2, 'unitId=u_math：只该单元 2 张', 'allCount=' + p.data.allCount);
ok(p.data.dueCount === 1, 'unitId=u_math：到期 1 张', 'dueCount=' + p.data.dueCount);
ok(p.data.filterLabel.indexOf('分数的初步认识') >= 0, 'unitId=u_math：标签显示单元标题', 'label=' + p.data.filterLabel);

p = open({ subject: 'chinese', unitId: 'u_math' });
ok(p.data.allCount === 0, 'subject 与 unitId 同时给：取交集（0 张）', 'allCount=' + p.data.allCount);
ok(p.data.dueCount === 0, '交集为空时到期也为 0', 'dueCount=' + p.data.dueCount);

p = open({ subject: 'chinese' });
ok(p.data.allCount === 1 && p.data.dueCount === 1, 'subject=chinese：1 张 1 到期',
  'all=' + p.data.allCount + ' due=' + p.data.dueCount);

/* 自测入口也必须走筛选后的集合：数学筛选下 startStudy 抽到的应是数学卡 */
p = open({ subject: 'math' });
p.startStudy();
ok(p.data.studying === true && p.data.current && p.data.current.id === 'c1',
  '自测：从筛选后的到期卡开始', p.data.current && p.data.current.id);

/* ------------------------------ 反证 ------------------------------ */
if (process.env.COUNTERPROOF === '1' && process.env.CARDS_CHILD !== '1') {
  console.log('\n════ 反证 ════');
  const src = fs.readFileSync(PAGE_PATH, 'utf8');
  const anchor = '    if (!f.subject && !f.unitId) return all;\n'
    + '    return all.filter(c => (!f.subject || c.subject === f.subject) && (!f.unitId || c.unitId === f.unitId));';
  if (src.indexOf(anchor) < 0) {
    console.log('  ✗ 反证：未找到过滤实现锚点（改动后请同步更新反证）');
    fail++;
  } else {
    const dir = path.dirname(PAGE_PATH);
    const mutant = path.join(dir, '.mutant-cards-unfiltered.test.js');
    fs.writeFileSync(mutant, src.replace(anchor, '    return all;'), 'utf8');
    try {
      const r = spawnSync(process.execPath, [path.join(__dirname, 'test-cards-page-filter.cjs')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CARDS_PATH: mutant, CARDS_CHILD: '1', COUNTERPROOF: '' })
      });
      const out = (r.stdout || '') + (r.stderr || '');
      ok(r.status !== 0, '反证：去掉过滤后测试变红', 'status=' + r.status);
      ok(/subject=math/.test(out), '反证：输出点名 subject=math 断言');
    } finally {
      fs.rmSync(mutant, { force: true });
    }
  }
}

console.log('\n' + '─'.repeat(52));
if (fail === 0) console.log(`通过 ${pass} / 共 ${pass}   ✓ 全部通过`);
else console.log(`通过 ${pass} / 共 ${pass + fail}   ✗ 有 ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);

/**
 * 课表功能冒烟测试（Node + mock wx）
 * 验证：科目别名匹配 / 课表→打卡内容识别 / 一键补类型 / 拍照结果回填 / 按天查课
 *      + checkinDetail 的文字描述打卡流程（note/minutes 落盘）
 */
const BASE_KEY = 'wb_hwfarm_data_v2';

/* ---------- mock wx ---------- */
const mem = {};
const seedRoot = {
  version: 2,
  users: [{
    id: 'u1', nickname: '小豆', avatar: '🐯', grade: '一年级', createdAt: Date.now(),
    profile: { nickname: '小豆', streak: 0, lastFullCheckinDate: '', equipped: {} },
    homework: {}, checkinTypes: [], plans: {}, learn: { stars: 0 }, comments: [],
    farm: { coins: 20, suns: 1, seeds: {}, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] }
  }],
  currentUserId: 'u1'
};
mem[BASE_KEY] = seedRoot;

global.wx = {
  getStorageSync(k) { return mem[k]; },
  setStorageSync(k, v) { mem[k] = v; },
  removeStorageSync(k) { delete mem[k]; },
  getStorageInfoSync() { return { keys: Object.keys(mem) }; },
  showToast(o) { /* console.log('[toast]', o.title); */ },
  showLoading() {}, hideLoading() {}, showModal() {},
  vibrateShort() {},
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager() { return { saveFileSync: p => p, copyFileSync: () => {} }; }
};

const sched = require('../miniprogram/utils/scheduleEngine.js');
const engine = require('../miniprogram/utils/farmEngine.js');
const store = require('../miniprogram/utils/store.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('【1】科目名归一化 + 别名匹配');
ok(sched.normalizeName('语文（张老师）') === '语文', '去括号「语文（张老师）」→ 语文');
ok(sched.matchType('语文') === 'chinese', '语文 → chinese');
ok(sched.matchType('数学思维') === 'math', '数学思维（包含命中）→ math');
ok(sched.matchType('English') === 'english', 'English → english');
ok(sched.matchType('体育') === '', '体育 → 空（未匹配）');

console.log('【2】课表写入 + 打卡内容识别');
const sch = sched.getSchedule();
sched.setCell(sch, 0, 0, '语文');       // 周一第1节
sched.setCell(sch, 0, 1, '数学');       // 周二第1节
sched.setCell(sch, 1, 0, '体育');       // 周一第2节
sched.setCell(sch, 1, 1, '音乐');       // 周二第2节
sched.saveSchedule(sch);

const ana = sched.analyzeTypes(sched.getSchedule());
ok(ana.total === 4, '共识别 4 个科目（去重后），实际=' + ana.total);
ok(ana.matched.length === 2, '已关联 2 个（语文/数学），实际=' + ana.matched.length);
ok(ana.unmatched.length === 2, '未匹配 2 个（体育/音乐），实际=' + ana.unmatched.length);
ok(ana.matched.some(m => m.name === '语文' && m.typeKey === 'chinese'), '语文关联 chinese');
ok(ana.matched.some(m => m.name === '数学' && m.typeKey === 'math'), '数学关联 math');

console.log('【3】一键补类型（体育/音乐 → 自定义打卡类型）');
const before = store.getTypeList().length;
const r = sched.addMissingTypes(sched.getSchedule());
const after = store.getTypeList().length;
ok(r.added === 2, '新增 2 个类型，实际=' + r.added);
ok(after - before === 2, '类型列表 +2');
ok(store.getTypeList().some(t => t.name === '体育' && t.fromSchedule), '体育类型已生成且标记 fromSchedule');
// 再跑一次：应无新增（幂等）
ok(sched.addMissingTypes(sched.getSchedule()).added === 0, '二次调用幂等（不再重复添加）');
// 补完后 analyzeTypes 应 100% 关联
const ana2 = sched.analyzeTypes(sched.getSchedule());
ok(ana2.coverage === 100, '补完后覆盖率 100%，实际=' + ana2.coverage);

console.log('【4】拍照识别结果回填（applyGrid）');
const grid = [
  ['语文', '数学', '', '美术', ''],
  ['体育', '-', '英语', '—', '科学']
];
const applied = sched.applyGrid(sched.getSchedule(), grid);
ok(applied.rows === 2, '行数回填为 2');
ok(sched.getCell(applied, 0, 3) === '美术', '第1行第4列=美术');
ok(sched.getCell(applied, 1, 2) === '英语', '第2行第3列=英语');
ok(sched.getCell(applied, 1, 1) === '', '占位符 "-" 视为空');

console.log('【5】按天查课（今天 2026-08-31 为周一 → col 0）');
sched.saveSchedule(sched.setCell(sched.getSchedule(), 0, 0, '语文'));
sched.setCell(sched.getSchedule(), 1, 0, '体育');
const day = sched.dayCourses(sched.getSchedule(), '2026-08-31');
ok(day.length === 2, '周一有 2 节课，实际=' + day.length);
ok(day[0].period === 1 && day[0].name === '语文' && day[0].typeKey === 'chinese', '第1节语文且已关联');
ok(day[1].period === 2 && day[1].name === '体育', '第2节体育');

console.log('【6】checkinDetail 文字描述打卡流程');
const d = store.get();
const gain = engine.checkin(d, 'chinese', { note: '今天口算错了2道，已订正', minutes: 30 });
ok(!!gain, '打卡成功返回奖励');
ok(gain.sun >= 1, '获得阳光');
const hw = engine.ensureDay(d, '');
const rec = hw['chinese'];
ok(rec.done === true, 'done=true');
ok(rec.note === '今天口算错了2道，已订正', 'note 落盘正确');
ok(rec.minutes === 30, 'minutes 落盘正确');
ok(rec.doneAt > 0, 'doneAt 已记录');
// 重复打卡应拒绝
ok(engine.checkin(d, 'chinese', {}) === null, '重复打卡被拒绝');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

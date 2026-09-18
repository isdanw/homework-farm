/**
 * 审查修复回归测试（Node + mock wx）
 * B1: 撤销打卡→重新打卡 不能重复领全科奖励（不刷金币）
 * B2: mergeRemote 云端合并（settledDates 并集 / 云端更新整片采用 / 本地字段保留）
 * S1: cloudUpload 上云 payload 不含 aiVision.key；exportJSON 导出不含 key
 */
const BASE_KEY = 'wb_hwfarm_data_v2';

/* ---------- mock wx ---------- */
const mem = {};
let cloudCalls = [];
global.REMOTE_ROOT = null;   // B2 场景里动态注入云端数据（初始无云端数据）
const seedRoot = {
  version: 2,
  users: [{
    id: 'u1', nickname: '小豆', avatar: '🐯', grade: '一年级', createdAt: Date.now(),
    lastActiveDate: '', settledDates: [],
    profile: { nickname: '小豆', streak: 0, lastFullCheckinDate: '', equipped: {} },
    homework: {}, checkinTypes: [], plans: {}, learn: { stars: 0 }, comments: [],
    farm: { coins: 20, suns: 1, seeds: { chinese: 3, math: 3, english: 3 }, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] }
  }],
  currentUserId: 'u1',
  aiVision: { base: 'https://api.siliconflow.cn/v1', key: 'sk-SECRET', model: 'Qwen/Qwen3-VL-32B-Instruct', enabled: true }
};
mem[BASE_KEY] = JSON.parse(JSON.stringify(seedRoot));
mem['wb_hwfarm_openid'] = 'oTEST_openid';

global.wx = {
  getStorageSync(k) { return mem[k]; },
  setStorageSync(k, v) { mem[k] = v; },
  removeStorageSync(k) { delete mem[k]; },
  getStorageInfoSync() { return { keys: Object.keys(mem) }; },
  showToast() {}, showLoading() {}, hideLoading() {}, showModal() {},
  vibrateShort() {},
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager() {
    const rfs = require('fs');
    return {
      saveFileSync: p => p, copyFileSync: () => {}, unlinkSync: () => {},
      writeFileSync: (p, data) => rfs.writeFileSync(p, data, 'utf8'),
      readFileSync: (p) => rfs.readFileSync(p, 'utf8')
    };
  },
  cloud: {
    callFunction(opt) {
      cloudCalls.push(opt);
      if (opt.data && opt.data.action === 'whoami') {
        return Promise.resolve({ result: { ok: true, openid: 'oTEST_openid' } });
      }
      if (opt.data && opt.data.action === 'download') {
        return Promise.resolve({ result: { ok: true, data: global.REMOTE_ROOT } });
      }
      return Promise.resolve({ result: { ok: true } });
    }
  }
};

/* ---------- B1 测试 ---------- */
const engine = require('../miniprogram/utils/farmEngine.js');
const store = require('../miniprogram/utils/store.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

(async () => {
  store.setCloudReady(true);
  await store.initAccount();   // 确认 openid + 迁移到命名空间（后续 S1/B2 依赖）

  console.log('B1 撤销打卡防刷奖励:');
  const u = store.get();
  // 三科全部打卡
  ['chinese', 'math', 'english'].forEach(s => engine.checkin(u, s));
  const coinsAfterFull = u.farm.coins;
  ok(coinsAfterFull === 25, '三科全勤后金币 = 20 + 5（实际 ' + coinsAfterFull + '）');
  // 撤销一科再重新打卡
  engine.uncheckin(u, 'chinese');
  engine.checkin(u, 'chinese');
  ok(u.farm.coins === coinsAfterFull, '撤1科再重勾，金币不变（实际 ' + u.farm.coins + '，应为 ' + coinsAfterFull + '）');
  // 再来一轮
  engine.uncheckin(u, 'math');
  engine.checkin(u, 'math');
  engine.uncheckin(u, 'english');
  engine.checkin(u, 'english');
  ok(u.farm.coins === coinsAfterFull, '多轮撤销重勾，金币仍不变（实际 ' + u.farm.coins + '）');
  ok(u.farm.pesticide === 0, '未被惩罚日不重复发杀虫剂（实际 ' + u.farm.pesticide + '）');

/* ---------- S1 测试 ---------- */
console.log('S1 Key 不上云/不导出:');
store.setCloudReady(true);   // 模拟云可用
store.save(null);            // 触发 cloudUpload 防抖
setTimeout(() => {
  const up = cloudCalls.find(c => c.data && c.data.action === 'upload');
  ok(!!up, 'upload 已发出');
  const payload = up && up.data.payload;
  ok(payload && payload.aiVision && payload.aiVision.key === '', '上云 payload 的 aiVision.key 已剥离');
  const NS_KEY = store.BASE_KEY + '_oTEST_openid';
  ok(mem[NS_KEY] && mem[NS_KEY].aiVision && mem[NS_KEY].aiVision.key === 'sk-SECRET', '本地存储仍保留 Key（设备端可用）');

  const fs = require('fs');
  const util = require('../miniprogram/utils/util.js');
  const path = store.exportJSON();
  const exported = JSON.parse(fs.readFileSync(path, 'utf8'));
  ok(exported.aiVision && exported.aiVision.key === '', '导出文件不含 Key');
  fs.unlinkSync(path);

  /* ---------- B2 测试 ---------- */
  console.log('B2 云端合并:');
  // 场景：孩子 3 天没开小程序，云端 dailyReset 已结算（settledDates 含昨天，lastActiveDate=今天）
  const today = util.today();
  const yest = util.daysAgo(1);
  const local1 = store.getRoot().users[0];
  local1.lastActiveDate = util.daysAgo(3);
  local1.settledDates = [];
  global.REMOTE_ROOT = {
    version: 2,
    users: [{
      id: 'u1', nickname: '小豆', avatar: '🐯', grade: '一年级', createdAt: Date.now(),
      lastActiveDate: today, settledDates: [yest],
      profile: { nickname: '小豆', streak: 0, lastFullCheckinDate: '', equipped: {} },
      homework: {}, checkinTypes: [], plans: {}, learn: { stars: 0 }, comments: [],
      farm: { coins: 10, suns: 1, seeds: {}, pesticide: 0, shields: 0, plots: [], bears: [], lockHarvestDate: '', shieldExchangeDate: '', harvestLog: [], owned: [], logs: [] }
    }],
    currentUserId: 'u1'
  };
  store.initAccount().then(() => {
    const after = store.getRoot().users[0];
    ok(after.settledDates.indexOf(yest) >= 0, 'settledDates 已并入云端（昨天已云端结算）');
    ok(after.lastActiveDate === today, '云端更新 → lastActiveDate 采用云端（' + after.lastActiveDate + '）');
    ok(after.farm.coins === 10, 'farm 采用云端切片（结算结果生效，金币 ' + after.farm.coins + '）');

    // 场景2：本地更新（今天已本地打开过）→ 本地为准，但 settledDates 并集
    const local2 = store.getRoot().users[0];
    local2.lastActiveDate = today;    // 本地也已推进到今天
    local2.settledDates = [yest];     // 本地也结算过
    global.REMOTE_ROOT.users[0].settledDates = [util.daysAgo(2), yest]; // 云端多结算了一天
    const p = store.initAccount().then(() => {
      const after2 = store.getRoot().users[0];
      ok(after2.settledDates.indexOf(util.daysAgo(2)) >= 0, '本地更新时云端 settledDates 仍并入（防重复结算）');
      ok(after2.farm.coins === 10, '本地为准时 farm 不被云端覆盖');

      console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
      process.exit(fail ? 1 : 0);
    });
  });
}, 2100);
})();

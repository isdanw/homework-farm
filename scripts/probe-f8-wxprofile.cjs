/**
 * 一次性反证探针（F8）：微信昵称/头像是否进入 _root 整份镜像
 * 用法：SRC_DIR=/tmp/oldutils node scripts/probe-f8-wxprofile.cjs
 */
const path = require('path');
const SRC = process.env.SRC_DIR
  ? path.resolve(process.env.SRC_DIR)
  : path.resolve(__dirname, '../miniprogram/utils');
const STORE = path.join(SRC, 'store.js');
const KEY = 'wb_hwfarm_data_v2_o1';
const LEGACY = 'wb_hwfarm_wxprofile';

const storage = new Map();
global.wx = {
  getStorageSync: k => (storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : ''),
  setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
  removeStorageSync: k => storage.delete(k),
  showToast() {},
  cloud: { callFunction: () => Promise.resolve({ result: { ok: true, data: null } }) }
};
global.getApp = () => ({ globalData: {} });

(async () => {
  storage.set('wb_hwfarm_openid', 'o1');
  const store = require(STORE);
  store.setCloudReady(false);
  await store.initAccount();
  store.addUser({ nickname: '加一', grade: '一年级' });
  store.setWxProfile({ nickname: '小依妈妈', avatarUrl: 'https://x/a.png' });

  const root = storage.get(KEY) || {};
  const inRoot = !!(root.wxProfile && root.wxProfile.nickname);
  const inLegacy = storage.has(LEGACY);
  console.log('被测源码                     : ' + path.relative(path.resolve(__dirname, '..'), STORE));
  console.log('昵称头像是否在 _root 里      : ' + inRoot + '   （在 → 随整份镜像上云）');
  console.log('是否另开独立 storage key     : ' + inLegacy + '   （在 → 换手机即丢、同机多账号串味）');
  console.log('结论：' + (inRoot && !inLegacy ? '✅ 已修（F8）' : '❌ 未修（旧实现）'));
})();

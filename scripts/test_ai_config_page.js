/**
 * aiConfig 页面逻辑仿真：stub wx/Page/store，驱动 onLoad → pickPreset 全流程
 * 验证平台切换是否正常工作（不依赖微信开发者工具）
 */
const path = require('path');

// ---- stub wx ----
global.wx = {
  showToast: () => {},
  navigateBack: () => {},
  cloud: { callFunction: () => {} },
  getStorageSync: () => ({}),
  setStorageSync: () => {}
};

// ---- stub Page：记录配置，方法挂到实例 ----
let pageInst = null;
global.Page = (cfg) => {
  pageInst = Object.assign({}, cfg);
  pageInst.data = JSON.parse(JSON.stringify(cfg.data));
  pageInst.setData = function (patch, cb) {
    Object.assign(this.data, patch);
    // 模拟视图层读取 this.data 渲染；回调同步执行（微信为异步，但时序问题已在代码中规避）
    if (cb) cb();
  };
};

// ---- stub store：模拟新版多平台结构（含用户当前真实状态：SiliconFlow 已启用）----
const modPath = path.resolve(__dirname, '../miniprogram/pkgTools/aiConfig/aiConfig.js');
require.cache[require.resolve(path.resolve(__dirname, '../miniprogram/utils/store.js'))] = {
  id: require.resolve(path.resolve(__dirname, '../miniprogram/utils/store.js')),
  filename: require.resolve(path.resolve(__dirname, '../miniprogram/utils/store.js')),
  loaded: true,
  exports: {
    getVisionConfig: () => ({
      preset: 'siliconflow', base: 'https://api.siliconflow.cn/v1', key: 'sk-old', model: 'Qwen/Qwen3-VL-32B-Instruct',
      enabled: true, active: 'siliconflow',
      platforms: {
        siliconflow: { base: 'https://api.siliconflow.cn/v1', key: 'sk-old', model: 'Qwen/Qwen3-VL-32B-Instruct' },
        deepseek: { base: 'https://api.deepseek.com', key: 'sk-ds', model: 'deepseek-v4-flash-vision-exp' },
        custom: { base: '', key: '', model: '' }
      }
    }),
    saveVisionConfig: (cfg) => ({ ok: true, cfg }),
    visionConfigReady: () => true,
    getActiveVision: () => ({ base: 'https://api.siliconflow.cn/v1', key: 'sk-old', model: 'Qwen/Qwen3-VL-32B-Instruct' })
  }
};
require.cache[require.resolve(path.resolve(__dirname, '../miniprogram/utils/util.js'))] = {
  id: 2, filename: 'util', loaded: true, exports: { toast: () => {} }
};

require(modPath);

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

// ---- 场景 1：onLoad 初始状态 ----
console.log('场景 1：onLoad（SiliconFlow 已启用）');
pageInst.onLoad();
ok(pageInst.data.preset === 'siliconflow', '初始编辑平台 = siliconflow');
ok(pageInst.data.base === 'https://api.siliconflow.cn/v1', 'SiliconFlow base 正确填充');
ok(pageInst.data.activePreset === 'siliconflow', '启用平台标记 = siliconflow');
ok(pageInst.data.modelOptions.length === 1 && pageInst.data.modelOptions[0] === 'Qwen/Qwen3-VL-32B-Instruct', '模型候选正确');

// ---- 场景 2：点击 DeepSeek chip ----
console.log('场景 2：pickPreset(deepseek)');
pageInst.pickPreset({ currentTarget: { dataset: { pid: 'deepseek' } } });
ok(pageInst.data.preset === 'deepseek', '编辑平台切换为 deepseek');
ok(pageInst.data.base === 'https://api.deepseek.com', 'DeepSeek base 载入');
ok(pageInst.data.model === 'deepseek-v4-flash-vision-exp', 'DeepSeek 模型载入');
ok(pageInst.data.key === 'sk-ds', 'DeepSeek Key 载入（独立隔离）');
ok(pageInst.data.modelOptions.length === 1 && pageInst.data.modelOptions[0] === 'deepseek-v4-flash-vision-exp', 'DeepSeek 模型候选正确');

// ---- 场景 3：SiliconFlow 草稿未被覆盖 ----
console.log('场景 3：切走后 SiliconFlow 草稿保留');
pageInst.pickPreset({ currentTarget: { dataset: { pid: 'siliconflow' } } });
ok(pageInst.data.preset === 'siliconflow', '切回 siliconflow');
ok(pageInst.data.base === 'https://api.siliconflow.cn/v1' && pageInst.data.key === 'sk-old', 'SiliconFlow 三要素完好（互不覆盖）');
pageInst.pickPreset({ currentTarget: { dataset: { pid: 'deepseek' } } });
ok(pageInst.data.preset === 'deepseek' && pageInst.data.model === 'deepseek-v4-flash-vision-exp', '再切回 deepseek 数据完好');

// ---- 场景 4：点击自定义 ----
console.log('场景 4：pickPreset(custom)');
pageInst.pickPreset({ currentTarget: { dataset: { pid: 'custom' } } });
ok(pageInst.data.preset === 'custom' && pageInst.data.base === '', 'custom 切换成功，空表单');

// ---- 场景 5：dataset 异常兜底（undefined）----
console.log('场景 5：dataset.pid 缺失时不崩、不误切');
const before = pageInst.data.preset;
pageInst.pickPreset({ currentTarget: { dataset: {} } });
ok(pageInst.data.preset === before, 'pid 缺失 → 保持原平台不崩');

// ---- 场景 6：启用切换 + 保存校验 ----
console.log('场景 6：启用 DeepSeek 并保存');
pageInst.pickPreset({ currentTarget: { dataset: { pid: 'deepseek' } } });
pageInst.onEnabledChange({ detail: { value: true } });
ok(pageInst.data.enabled === true && pageInst.data.activePreset === 'deepseek', '开关开启 → activePreset = deepseek');
let saved = null;
pageInst.setData({}, () => {}); // noop
// 拦截 store.saveVisionConfig
const origSave = require.cache[require.resolve(path.resolve(__dirname, '../miniprogram/utils/store.js'))].exports.saveVisionConfig;
require.cache[require.resolve(path.resolve(__dirname, '../miniprogram/utils/store.js'))].exports.saveVisionConfig = (cfg) => { saved = cfg; return cfg; };
pageInst.saveConfig();
ok(saved && saved.enabled === true && saved.active === 'deepseek', '保存：enabled=true, active=deepseek');
ok(saved.platforms && saved.platforms.deepseek && saved.platforms.deepseek.model === 'deepseek-v4-flash-vision-exp', '保存：deepseek 平台三要素写入');
ok(saved.platforms.siliconflow.key === 'sk-old', '保存：SiliconFlow 配置未受影响');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

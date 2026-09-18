/**
 * 小程序代码上传脚本
 * 使用 miniprogram-ci 替代微信开发者工具手动上传
 *
 * 使用前请确认：
 * 1. 已从 mp.weixin.qq.com → 开发 → 开发设置 → 生成「小程序代码上传密钥」
 * 2. 下载私钥文件放到项目根目录，如 private.key
 * 3. 在 mp.weixin.qq.com → 开发 → 开发设置 → IP 白名单，添加本机 IP
 *
 * 使用方式：
 *   node scripts/upload.js                          # 使用默认版本号
 *   node scripts/upload.js --version 1.0.1          # 指定版本号
 *   node scripts/upload.js --desc "修复农场BUG"      # 自定义备注
 */
const ci = require('miniprogram-ci');
const fs = require('fs');
const path = require('path');

// ==================== 可配置项 ====================
const CONFIG = {
  appid: 'wx57969d0453d14966',
  projectPath: path.resolve(__dirname, '..', 'miniprogram'),
  privateKeyPath: path.resolve(__dirname, '..', 'private.key'),
  defaultVersion: '1.0.0',
  defaultDesc: '首发版本：每日好习惯打卡、卡通农场种植收获、成长记录、资料本与个性装扮',
  robot: 1,   // CI 机器人编号（1~30），用于区分不同来源的上传
};

// ==================== 解析命令行参数 ====================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' || args[i] === '-v') {
      opts.version = args[i + 1] || CONFIG.defaultVersion;
      i++;
    } else if (args[i] === '--desc' || args[i] === '-d') {
      opts.desc = args[i + 1] || CONFIG.defaultDesc;
      i++;
    } else if (args[i] === '--key' || args[i] === '-k') {
      CONFIG.privateKeyPath = path.resolve(args[i + 1]);
      i++;
    }
  }
  return opts;
}

// ==================== 主流程 ====================
async function upload() {
  const opts = parseArgs();
  const version = opts.version || CONFIG.defaultVersion;
  const desc = opts.desc || CONFIG.defaultDesc;

  // 1. 检查私钥文件
  if (!fs.existsSync(CONFIG.privateKeyPath)) {
    console.error('\n❌ 未找到私钥文件:', CONFIG.privateKeyPath);
    console.error('请按以下步骤操作：');
    console.error('  1. 登录 mp.weixin.qq.com → 开发 → 开发管理 → 开发设置');
    console.error('  2. 找到「小程序代码上传密钥」，点击「生成」');
    console.error('  3. 下载私钥文件，放到项目根目录并命名为 private.key');
    console.error('  4. （可选）用 --key 参数指定私钥路径\n');
    process.exit(1);
  }

  // 2. 检查项目路径
  if (!fs.existsSync(CONFIG.projectPath)) {
    console.error('\n❌ 未找到小程序项目目录:', CONFIG.projectPath);
    process.exit(1);
  }

  // 3. 创建项目实例
  console.log('\n📦 准备上传...');
  console.log('  AppID:', CONFIG.appid);
  console.log('  版本号:', version);
  console.log('  备注:', desc);
  console.log('  机器人:', CONFIG.robot);

  const project = new ci.Project({
    appid: CONFIG.appid,
    type: 'miniProgram',
    projectPath: CONFIG.projectPath,
    privateKeyPath: CONFIG.privateKeyPath,
    ignores: ['node_modules/**/*'],
  });

  try {
    // 4. 上传代码
    const result = await ci.upload({
      project,
      version,
      desc,
      robot: CONFIG.robot,
      setting: {
        es6: true,
        es7: true,
        minify: true,
        codeProtect: false,
        autoPrefixWXSS: true,
      },
      onProgressUpdate: (info) => {
        if (info.status === 'doing') {
          console.log(`  ⏳ ${info._msg || '上传中...'}`);
        } else if (info.status === 'done') {
          console.log(`  ✅ ${info._msg || '完成'}`);
        }
      },
    });

    console.log('\n🎉 上传成功！');
    console.log('──────────────────────────────');
    console.log('  版本号:', version);
    console.log('  备注:', desc);
    console.log('──────────────────────────────');
    console.log('\n👉 下一步：');
    console.log('  1. 打开 https://mp.weixin.qq.com');
    console.log('  2. 进入「管理 → 版本管理」');
    console.log('  3. 找到版本', version, '，点击「提交审核」');
    console.log('\n');

    return result;
  } catch (err) {
    console.error('\n❌ 上传失败:', err.message);
    if (err.message.includes('privateKey')) {
      console.error('   私钥文件无效，请确认是从公众平台下载的原始文件');
    } else if (err.message.includes('network')) {
      console.error('   网络异常，请检查 IP 白名单设置');
    } else if (err.message.includes('robot')) {
      console.error('   机器人编号冲突，请修改 CONFIG.robot 值（1~30）');
    }
    process.exit(1);
  }
}

upload();

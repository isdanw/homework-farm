/**
 * 云函数 initDB —— 一键初始化云数据库集合
 * 使用方式：右键该云函数「上传并部署」，然后在云开发控制台「测试」执行一次即可。
 *
 * 集合说明：
 *   hw_farm_user    —— 一人一条，保存完整的作业 + 农场数据（前端 store 的镜像）
 *   hw_checkin_log  —— 每日打卡明细，方便家长端 / 后台统计
 *   hw_farm_settle  —— 每日夜间惩罚结算记录（哪天来了几只小狗熊、偷了多少金币）
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = ['hw_farm_user', 'hw_checkin_log', 'hw_farm_settle', 'hw_farm_events'];

exports.main = async () => {
  const result = [];
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      result.push({ name, status: 'created' });
    } catch (e) {
      // -501001 / ResourceUnavailable：集合已存在，忽略即可
      result.push({ name, status: 'exists', code: e.errCode });
    }
  }
  return { ok: true, result };
};

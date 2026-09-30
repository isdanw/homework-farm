/**
 * orderCloudDeps —— node-sdk ↔ orderActions 的 deps 适配器（唯一一份）
 * ============================================================
 * 为什么单独成文件：
 *   `tutorOrder`（小程序 openid 通道）与 `webAdminWrite`（网页看板·工作台 口令→openid 通道）
 *   都要调用同一套 orderActions，而 orderActions 是零 I/O 的纯逻辑，需要外部注入 deps。
 *   若两个云函数各写一份适配器，**查询条件、集合名、add/update 写法**迟早漂移 ——
 *   那种漂移不会报错，只会静默改错单。所以适配器也做 canonical，由
 *   scripts/sync-order-kit.mjs 同步到两个云函数，哈希锁死。
 *
 * ⚠️ 本文件**不 require 任何 SDK**：只按 @cloudbase/node-sdk 的**形状**消费传入的 app。
 *    这样离线测试台可以传一个内存假 app，直接跑真实云函数源码。
 *
 * ⚠️ @cloudbase/node-sdk 写法坑（项目已知，反复踩）：
 *   update(obj) 的 obj **键即字段名**，没有 `{ data: {} }` 包壳（与 wx-server-sdk 不同）。
 *   包壳会把内容写进嵌套 data.data → 永不生效且不报错。add(obj) 同理。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrderCloudDeps = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // @@ORDER_CLOUD_DEPS_BODY_BEGIN@@
  const DEFAULT_COLL = 'tutor_orders';
  const DEFAULT_LIMIT = 200;

  /**
   * @param {Object} app        tcb.init({ env }) 的返回值（或离线测试台的等价物）
   * @param {string} openid     当前账号标识（服务端解析，绝不接受客户端直传）
   * @param {Object} [opts]     { collection }
   * @returns orderActions 需要的 deps
   */
  function makeDeps(app, openid, opts) {
    const COLL = (opts && opts.collection) || DEFAULT_COLL;
    const db = app.database();

    async function safeGet(build) {
      try {
        const res = await build();
        return (res && res.data) || [];
      } catch (e) {
        return [];   // 集合尚不存在 / 查询失败 → 当空，不阻塞
      }
    }

    return {
      /**
       * 定位唯一一张单：orderNo 与 clientId 二者其一。
       * ⚠️ 两个都没传时必须返回 null —— 否则 where({}) 会捞回任意一条，酿成「改错单」。
       */
      find: async (q) => {
        const query = q || {};
        const where = { openid: openid };
        if (query.orderNo) where.orderNo = String(query.orderNo);
        else if (query.clientId) where.clientId = String(query.clientId);
        else return null;
        const rows = await safeGet(() => db.collection(COLL).where(where).limit(2).get());
        return rows[0] || null;
      },

      /** 列表：planId / subject / status 过滤。planId 用点号路径匹配内嵌对象。 */
      list: async (q) => {
        const query = q || {};
        const where = { openid: openid };
        if (query.planId) where['plan.planId'] = String(query.planId);
        if (query.subject) where.subject = String(query.subject);
        if (query.status) where.status = String(query.status);
        const limit = Math.min(Number(query.limit) || DEFAULT_LIMIT, DEFAULT_LIMIT);
        const rows = await safeGet(() =>
          db.collection(COLL).where(where).orderBy('issuedAt', 'desc').limit(limit).get());
        return rows;
      },

      insert: async (doc) => {
        const body = Object.assign({ openid: openid }, doc);
        try {
          const res = await db.collection(COLL).add(body);
          return { id: (res && (res.id || res._id)) || '' };
        } catch (e) {
          // 首次写入时集合可能还不存在 → 建集合后重试一次（与 tutorRetest / tutorSync 同款兜底）
          try { await db.createCollection(COLL); } catch (e2) {}
          try {
            const res2 = await db.collection(COLL).add(body);
            return { id: (res2 && (res2.id || res2._id)) || '' };
          } catch (e3) {
            throw e3;
          }
        }
      },

      update: async (id, patch) => {
        await db.collection(COLL).doc(id).update(patch);
      },

      now: () => Date.now(),

      rand: () => Math.random().toString(36).slice(2, 8).toUpperCase()
    };
  }

  /* ⚠️ 区段体内**不得**出现顶层 `return`（ESM 副本会直接语法错误，见 orderKit.js 同处说明）。 */
  var ORDER_CLOUD_DEPS_API = { makeDeps: makeDeps, DEFAULT_COLL: DEFAULT_COLL };
  // @@ORDER_CLOUD_DEPS_BODY_END@@

  return ORDER_CLOUD_DEPS_API;
});

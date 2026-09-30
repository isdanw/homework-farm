/**
 * ⚠️ AUTO-GENERATED —— 请勿直接编辑本文件。
 * 内容：orderCloudDeps（node-sdk 适配器）
 * 源文件：order-kit/orderCloudDeps.js（canonical）
 * 重新生成：node scripts/sync-order-kit.mjs
 * 一致性由 scripts/test-order-kit-sync.cjs 用 sha256 校验区段锁死。
 */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrderCloudDeps = api;
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

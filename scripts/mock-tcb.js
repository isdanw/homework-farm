/**
 * mock-tcb.js —— 测试共享：内存版 @cloudbase/node-sdk mock
 * 支持 tutorSync / tutorChat / tutorRetest 用到的全部数据库操作：
 *   collection().add / .where().get() / .where().limit().get() /
 *   .where().orderBy().limit().get() / .where().update() / .doc().update() / createCollection
 * 用法：Module._load 拦截 '@cloudbase/node-sdk' 返回本模块的 createMock()
 */
function createMockDb() {
  const db = {
    collections: {},          // { name: [doc, ...] }
    autoId: 0,
    log: []                   // 操作日志（供断言）
  };

  function coll(name) {
    if (!db.collections[name]) db.collections[name] = [];
    return db.collections[name];
  }

  db.coll = coll;

  function makeQuery(name, filter) {
    return {
      where: (f) => makeQuery(name, Object.assign({}, filter, f)),
      orderBy: () => makeQuery(name, filter),
      limit: () => makeQuery(name, filter),
      get: async () => {
        db.log.push({ op: 'get', name: name, filter: filter });
        let arr = coll(name).filter(d => {
          return Object.keys(filter).every(k => d[k] === filter[k]);
        });
        // orderBy('createdAt','desc') 语义固定按 createdAt 倒序
        arr = arr.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return { data: JSON.parse(JSON.stringify(arr)) };
      },
      update: async ({ data }) => {
        db.log.push({ op: 'update', name: name, filter: filter, data: data });
        let n = 0;
        coll(name).forEach((d, i) => {
          if (Object.keys(filter).every(k => d[k] === filter[k])) {
            coll(name)[i] = Object.assign({}, d, data);
            n++;
          }
        });
        return { updated: n };
      }
    };
  }

  db.collection = (name) => ({
    where: (f) => makeQuery(name, f),
    orderBy: () => db.collection(name),
    limit: () => db.collection(name),
    add: async ({ data }) => {
      db.log.push({ op: 'add', name: name, data: data });
      const _id = 'cloud_' + (++db.autoId);
      coll(name).push(Object.assign({}, data, { _id: _id }));
      return { id: _id };
    },
    doc: (id) => ({
      update: async ({ data }) => {
        db.log.push({ op: 'docUpdate', name: name, id: id, data: data });
        const arr = coll(name);
        const i = arr.findIndex(d => d._id === id);
        if (i >= 0) arr[i] = Object.assign({}, arr[i], data);
        return { updated: i >= 0 ? 1 : 0 };
      }
    }),
    get: async () => ({ data: JSON.parse(JSON.stringify(coll(name))) })
  });

  db.createCollection = async (name) => { if (!db.collections[name]) db.collections[name] = []; };

  db.app = {
    ai: () => ({
      createModel: () => ({
        generateText: async (args) => {
          db.lastModel = args.model;
          db.lastMessages = args.messages;
          return { text: db.mockAiText || 'MOCK_REPLY' };
        }
      })
    }),
    database: () => db
  };

  return db;
}

/** 拦截 require('@cloudbase/node-sdk')，返回 { init: () => db.app } */
function installMock(db) {
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@cloudbase/node-sdk') return { init: () => db.app };
    return originalLoad.apply(this, arguments);
  };
  return () => { Module._load = originalLoad; };
}

module.exports = { createMockDb, installMock };

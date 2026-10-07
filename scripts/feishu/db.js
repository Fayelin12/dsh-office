'use strict';

/**
 * db.js — SQLite 数据层（Windows 版）
 *
 * 用 Node 24 内置 node:sqlite（DatabaseSync）替代 better-sqlite3，零原生依赖。
 * schema 与 vec0 用法：
 *   - @photostructure/sqlite-vec 的 load(db) 自动按平台加载 vec0.dll
 *   - node:sqlite 需 allowExtension:true 才能 loadExtension
 *   - 去掉 members 表 join（首版只做「消息→向量→召回」，不做成员画像）
 *
 * sqlite-vec 为可选依赖：未安装时降级为「只写 msg_metadata、跳过 msg_embeddings」，
 * 消息流/洞察只依赖 msg_metadata，脚本照常运行不崩。
 */

const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { logInfo, logError, float32ToJson } = require('./utils.js');

let db = null;
let vec0Loaded = false;
let embeddingDim = 1024;

// sqlite-vec 惰性加载（try/catch）：未安装 @photostructure/sqlite-vec 时不抛错、不崩。
let loadVec = null;
try {
  ({ load: loadVec } = require('@photostructure/sqlite-vec'));
} catch (err) {
  loadVec = null;
  logError('db', `sqlite-vec 未安装或加载失败（向量功能不可用，仅存元数据）| error=${err.message}`);
}

/**
 * 初始化数据库并加载 sqlite-vec 扩展。
 * @param {string} dbPath - SQLite 文件路径
 * @param {number} [dim] - 向量维度，默认 1024
 */
function init(dbPath, dim) {
  if (dim) embeddingDim = dim;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath, { allowExtension: true });
  // 并发写者（手动同步/洞察预同步/事件入库可能撞一起）等待而非立即 database is locked
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  logInfo('db', `数据库初始化 | path=${dbPath} mode=WAL`);

  if (loadVec) {
    try {
      loadVec(db); // 自动匹配 win32-x64/vec0.dll
      vec0Loaded = true;
      logInfo('db', 'sqlite-vec 扩展加载成功');
    } catch (err) {
      vec0Loaded = false;
      logError('db', `sqlite-vec 扩展加载失败（向量功能不可用）| error=${err.message}`);
    }
  } else {
    vec0Loaded = false;
  }

  runMigration();
  return db;
}

/**
 * msg_metadata 表结构 DDL 单一来源（初始建表与重建共用，防漂移）。
 * rowid 可空：无向量消息（image/file/folder）不关联 msg_embeddings，允许 NULL。
 * 注：重建表只搬下列列（names），新增列需同步维护 META_COLUMNS。
 */
const META_COLUMNS = ['id','rowid','chat_id','user_id','message_id','msg_type','chat_type','message_type','text','root_id','sender_name','chat_name','created_at','resource_type','resource_key','file_name','thread_id'];

function createMetaTableSql(tableName, ifNotExists) {
  const create = ifNotExists ? 'CREATE TABLE IF NOT EXISTS' : 'CREATE TABLE';
  return `
    ${create} ${tableName} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      rowid      INTEGER,
      chat_id    TEXT NOT NULL,
      user_id    TEXT,
      message_id TEXT NOT NULL UNIQUE,
      msg_type   TEXT DEFAULT 'chat',
      chat_type  TEXT DEFAULT 'group',
      message_type TEXT,
      text       TEXT NOT NULL,
      root_id    TEXT,
      sender_name TEXT,
      chat_name  TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      resource_type TEXT,
      resource_key TEXT,
      file_name TEXT,
      thread_id TEXT
    );
  `;
}

function runMigration() {
  if (vec0Loaded) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS msg_embeddings USING vec0(embedding FLOAT[${embeddingDim}]);`);
      logInfo('db', 'msg_embeddings 虚拟表创建完成');
    } catch (err) {
      logError('db', `msg_embeddings 虚拟表创建失败 | error=${err.message}`);
    }
  } else {
    logError('db', '跳过 msg_embeddings 创建（vec0 未加载）');
  }

  try {
    db.exec(createMetaTableSql('msg_metadata', true));
    try { db.exec('ALTER TABLE msg_metadata ADD COLUMN message_type TEXT'); } catch (e) { /* 已存在 */ }
    try { db.exec('ALTER TABLE msg_metadata ADD COLUMN sender_name TEXT'); } catch (e) { /* 已存在 */ }
    try { db.exec('ALTER TABLE msg_metadata ADD COLUMN chat_name TEXT'); } catch (e) { /* 已存在 */ }
    // 2026-08-18：非文本消息支持（image/file/folder）——资源字段
    try { db.exec('ALTER TABLE msg_metadata ADD COLUMN resource_type TEXT'); } catch (e) { /* 已存在 */ }
    try { db.exec('ALTER TABLE msg_metadata ADD COLUMN resource_key TEXT'); } catch (e) { /* 已存在 */ }
    try { db.exec('ALTER TABLE msg_metadata ADD COLUMN file_name TEXT'); } catch (e) { /* 已存在 */ }
    // 2026-09-23：话题群消息标识（omt_xxx；非话题消息为 NULL）——必须在 ensureRowidNullable 之前，
    // 否则重建表时 META_COLUMNS 里的 thread_id 会因源表缺列而报错
    try { db.exec('ALTER TABLE msg_metadata ADD COLUMN thread_id TEXT'); } catch (e) { /* 已存在 */ }
    // 2026-08-18：rowid 列改可空（无向量消息不关联 msg_embeddings，需允许 NULL）
    // 老表 `rowid INTEGER NOT NULL` 会让无向量 INSERT 的 NULL rowid 被 NOT NULL 约束拒绝
    ensureRowidNullable();
    db.exec('CREATE INDEX IF NOT EXISTS idx_msg_meta_chat ON msg_metadata(chat_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_msg_meta_created ON msg_metadata(created_at);');
    logInfo('db', 'msg_metadata 表迁移完成');
  } catch (err) {
    logError('db', `msg_metadata 表迁移失败 | error=${err.message}`);
  }
}

/**
 * 把 msg_metadata.rowid 列改为可空（重建表）。
 * 幂等：已可空则跳过。保留全部数据、主键与 UNIQUE 约束。
 */
function ensureRowidNullable() {
  try {
    const cols = db.prepare('PRAGMA table_info(msg_metadata)').all();
    const rowidCol = cols.find((c) => c.name === 'rowid');
    if (!rowidCol || !rowidCol.notnull) return;  // 已可空（新表）或无需处理

    db.exec('BEGIN');
    try {
      // 固定 DDL 重建：rowid 可空，其余与原表一致（含主键/UNIQUE/索引由外层重建）
      db.exec(createMetaTableSql('msg_metadata_new'));
      // 搬数据：显式列清单（含 rowid 保留原值，JOIN msg_embeddings 仍成立）
      const names = META_COLUMNS.join(', ');
      db.exec(`INSERT INTO msg_metadata_new (${names}) SELECT ${names} FROM msg_metadata`);
      db.exec('DROP TABLE msg_metadata');
      db.exec('ALTER TABLE msg_metadata_new RENAME TO msg_metadata');
      db.exec('COMMIT');
      logInfo('db', 'msg_metadata.rowid 已改为可空（重建表完成）');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (err) {
    logError('db', `msg_metadata.rowid 可空化失败 | error=${err.message}`);
  }
}

/**
 * 插入一条消息（幂等）。
 * 两条路径：
 *   - 有文本 + 有向量（vec 非空）：向量 + 元数据原子写入 → 可参与语义召回
 *   - 无文本（image/file/folder，vec 为空）：只写 msg_metadata，不写 msg_embeddings
 *     → 不参与召回（2026-08-18 拍板：图片/文件不做语义召回）
 * @param {Float32Array} vec - 可为空数组/空（无文本消息传 new Float32Array(0)）
 * @param {object} meta - { chat_id, user_id, message_id, msg_type, chat_type, text,
 *                          root_id, thread_id?, resource_type?, resource_key?, file_name? }
 * @returns {boolean}
 */
function insertMsgVector(vec, meta) {
  if (!db) return false;

  const chatId = meta.chat_id || null;
  const userId = meta.user_id || null;
  const messageId = meta.message_id || null;
  const msgType = meta.msg_type || 'chat';
  const chatType = meta.chat_type || 'group';
  const messageType = meta.message_type || null;
  const text = meta.text || '';
  const rootId = meta.root_id || null;
  const createdAt = meta.created_at || null;
  const senderName = meta.sender_name || null;
  const chatName = meta.chat_name || null;
  const resourceType = meta.resource_type || null;
  const resourceKey = meta.resource_key || null;
  const fileName = meta.file_name || null;
  const threadId = meta.thread_id || null;

  // 允许无文本消息（资源类）入库，但必须至少有一个标识
  if (!chatId || !messageId) return false;
  if (!text && !resourceKey) return false;

  try {
    const existing = db.prepare('SELECT 1 AS e FROM msg_metadata WHERE message_id = ?').get(messageId);
    if (existing) return false; // 幂等：已存在则跳过

    const hasVec = vec && vec.length > 0 && vec0Loaded;

    db.exec('BEGIN');
    try {
      // rowid 参数化：有向量 → msg_embeddings 的 rowid；无向量（image/file/folder）→ NULL 自增，不参与召回
      let rowId = null;
      if (hasVec) {
        const vecJson = float32ToJson(vec);
        const vecRes = db.prepare('INSERT INTO msg_embeddings (rowid, embedding) VALUES (NULL, ?)').run(vecJson);
        rowId = vecRes.lastInsertRowid;
      }
      const metaRes = db.prepare(`
        INSERT OR IGNORE INTO msg_metadata (rowid, chat_id, user_id, message_id, msg_type, chat_type, message_type, text, root_id, created_at, sender_name, chat_name, resource_type, resource_key, file_name, thread_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')), ?, ?, ?, ?, ?, ?)
      `).run(rowId, chatId, userId, messageId, msgType, chatType, messageType, text, rootId, createdAt, senderName, chatName, resourceType, resourceKey, fileName, threadId);
      db.exec('COMMIT');
      return metaRes.changes > 0;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (err) {
    logError('db', `插入消息失败 | chat_id=${chatId} error=${err.message}`);
    return false;
  }
}

/**
 * KNN 语义检索（沿用生产 sqlite-vec 用法：fork 用 AND k=? 而非 LIMIT）。
 * @param {string} chatId - 群 ID
 * @param {Float32Array} queryVector
 * @param {number} [k=5]
 * @returns {Array}
 */
function knnSearch(chatId, queryVector, k) {
  if (!db || !vec0Loaded) return [];
  const topK = k || 5;

  try {
    const vecJson = float32ToJson(queryVector);
    const stmt = db.prepare(`
      SELECT m.rowid, m.distance, t.chat_id, t.chat_name, t.user_id, t.sender_name, t.message_id, t.text, t.created_at
      FROM msg_embeddings m
      JOIN msg_metadata t ON m.rowid = t.rowid
      WHERE m.embedding MATCH ?
        AND m.k = ?
        AND t.chat_id = ?
        AND m.rowid IN (SELECT rowid FROM msg_metadata WHERE chat_id = ?)
      ORDER BY m.distance
    `);
    return stmt.all(vecJson, topK, chatId, chatId);
  } catch (err) {
    logError('db', `KNN 检索失败 | chat_id=${chatId} error=${err.message}`);
    return [];
  }
}

function getVec0Loaded() {
  return vec0Loaded;
}

function getStats() {
  if (!db) return null;
  try {
    const count = db.prepare('SELECT COUNT(*) AS c FROM msg_metadata').get();
    const vecCount = vec0Loaded ? db.prepare('SELECT COUNT(*) AS c FROM msg_embeddings').get() : { c: 0 };
    const chats = db.prepare('SELECT chat_id, COUNT(*) AS c FROM msg_metadata GROUP BY chat_id ORDER BY c DESC LIMIT 10').all();
    return { messages: count.c, vectors: vecCount.c, chats };
  } catch (err) {
    return { error: err.message };
  }
}

function hasMessage(messageId) {
  if (!db) return false;
  return !!db.prepare('SELECT 1 AS e FROM msg_metadata WHERE message_id = ?').get(messageId);
}

module.exports = { init, insertMsgVector, knnSearch, getVec0Loaded, getStats, hasMessage };

'use strict';

/**
 * latest.js — 读取最近消息（供 dsh-office 插件「💬 飞书」视图展示）
 *
 * 用法：node latest.js [--per-chat N] [--since "YYYY-MM-DD HH:MM"] [--chat oc_xxx] [--offset N]
 *   --per-chat N   每个会话返回的消息条数，默认 20，最大 50
 *   --since        统计/过滤「该时间之后」的新消息（与 created_at 同格式，字符串比较）：
 *                  - 全量路径（无 --chat）时，messages 只含 created_at > since 的新消息，
 *                    recent_messages 才含最近 N 条（供卡片预览/详情展示）；
 *                  - 单会话分页路径（--chat）不受影响，messages 仍按 offset 翻页返回最近 N 条
 *   --chat oc_xxx  只返回该会话（弹窗分页用）：total = 该会话消息总数
 *   --offset N     跳过最新 N 条（配合 --chat 翻更早的消息）
 *
 * 配置：FEISHU_DB_PATH 环境变量指定 SQLite 库路径（默认 ~/.dsh/office/feishu.db）。
 *
 * 输出：单行 JSON（无日志噪声，stdout 只有这一行 JSON）：
 *   { ok: true, total, since, offset?,
 *     chats: [{ chat_id, chat_name, chat_type, count, new_count, last_at,
 *               messages: [{ chat_id, chat_name, user_id, sender_name, message_id,
 *                            message_type, text, created_at, thread_id,
 *                            resource_type?, resource_key?, file_name? }],
 *               recent_messages: [...] }] }
 *   - messages：全量路径下为「本次新入库（created_at > since）」消息（提及扫描用），
 *               无 --since 时退化为最近 N 条；单会话路径下恒为最近 N 条（分页）
 *   - recent_messages：全量路径下恒为最近 N 条（卡片预览/详情展示用）
 *   resource_* 为 2026-08-18 新增（image/file/folder 非文本消息资源字段；老库回退空串）
 *   thread_id 为 2026-09-23 新增（话题标识 omt_xxx；非话题消息 / 老库 / 缺列时恒为空串）
 * 失败时：{ ok: false, error }
 */

const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.FEISHU_DB_PATH || path.join(os.homedir(), '.dsh', 'office', 'feishu.db');

function parsePerChat(argv) {
  const i = argv.indexOf('--per-chat');
  if (i >= 0 && argv[i + 1]) {
    const n = parseInt(argv[i + 1], 10);
    if (Number.isFinite(n)) return Math.min(Math.max(n, 1), 50);
  }
  return 20;
}

function parseSince(argv) {
  const i = argv.indexOf('--since');
  if (i >= 0 && argv[i + 1]) {
    const s = String(argv[i + 1]).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return s;
  }
  return '';
}

function parseChat(argv) {
  const i = argv.indexOf('--chat');
  if (i >= 0 && argv[i + 1]) return String(argv[i + 1]).trim();
  return '';
}

function parseOffset(argv) {
  const i = argv.indexOf('--offset');
  if (i >= 0 && argv[i + 1]) {
    const n = parseInt(argv[i + 1], 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const perChat = parsePerChat(argv);
  const since = parseSince(argv);
  const chatFilter = parseChat(argv);
  const offset = parseOffset(argv);

  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (e) {
    return fail('打开数据库失败: ' + e.message);
  }

  // 列探测：sender_name / chat_name / 资源字段（迁移前也可用，回退 NULL/空）
  let colSet = new Set();
  try {
    colSet = new Set(db.prepare('PRAGMA table_info(msg_metadata)').all().map((c) => c.name));
  } catch (_) {}
  const has = (n) => colSet.has(n);

  // 消息 SELECT 列串（单会话分页与全量路径共用）
  const msgCols = `chat_id, ${has('chat_name') ? 'chat_name' : 'NULL AS chat_name'}, user_id, ` +
    `${has('sender_name') ? 'sender_name' : 'NULL AS sender_name'}, message_id, message_type, text, created_at, ` +
    `${has('resource_type') ? 'resource_type' : "'' AS resource_type"}, ` +
    `${has('resource_key') ? 'resource_key' : "'' AS resource_key"}, ` +
    `${has('file_name') ? 'file_name' : "'' AS file_name"}, ` +
    `${has('thread_id') ? "COALESCE(thread_id, '') AS thread_id" : "'' AS thread_id"}`;

  try {
    const chatSel = has('chat_name') ? 'chat_name' : 'NULL AS chat_name';
    const newStmt = since
      ? db.prepare('SELECT COUNT(*) AS c FROM msg_metadata WHERE chat_id = ? AND created_at > ?')
      : null;

    // 单会话分页路径（弹窗「加载更早消息」）
    if (chatFilter) {
      const chat = db.prepare(
        `SELECT chat_id, ${chatSel}, chat_type, COUNT(*) AS count, MAX(created_at) AS last_at
         FROM msg_metadata WHERE chat_id = ? GROUP BY chat_id`
      ).get(chatFilter);
      if (!chat) return fail('会话不存在: ' + chatFilter);
      chat.messages = db.prepare(
        `SELECT ${msgCols}
         FROM msg_metadata WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
      ).all(chatFilter, perChat, offset);
      if (newStmt) {
        const r = newStmt.get(chatFilter, since);
        chat.new_count = r ? r.c : 0;
      } else {
        chat.new_count = 0;
      }
      console.log(JSON.stringify({ ok: true, total: chat.count, since, offset, chats: [chat] }));
      process.exit(0);
    }

    // 全量路径（卡片流）：所有会话 + 每会话最新 N 条
    const total = db.prepare('SELECT COUNT(*) AS c FROM msg_metadata').get().c;
    const chats = db.prepare(
      `SELECT chat_id, ${chatSel}, chat_type, COUNT(*) AS count, MAX(created_at) AS last_at
       FROM msg_metadata GROUP BY chat_id ORDER BY count DESC`
    ).all();
    const msgStmt = db.prepare(
      `SELECT ${msgCols}
       FROM msg_metadata WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
    );
    // 本次新入库消息（created_at > since）：供「提及扫描」只看新消息，避免旧 @ 消息每次同步重复通知
    const newMsgStmt = since
      ? db.prepare(`SELECT ${msgCols} FROM msg_metadata WHERE chat_id = ? AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      : null;
    for (const c of chats) {
      c.recent_messages = msgStmt.all(c.chat_id, perChat);   // 最近 N 条（卡片预览/详情展示）
      if (newMsgStmt) {
        const r = newStmt.get(c.chat_id, since);
        c.new_count = r ? r.c : 0;
        c.messages = newMsgStmt.all(c.chat_id, since, perChat);  // 本次新入库（提及扫描用）
      } else {
        c.new_count = 0;
        c.messages = c.recent_messages;
      }
    }
    console.log(JSON.stringify({ ok: true, total, since, chats }));
    process.exit(0);
  } catch (e) {
    return fail('查询失败: ' + e.message);
  }
}

main();

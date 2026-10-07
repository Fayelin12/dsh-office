'use strict';

/**
 * poller.js — 用户身份轮询：列出用户所有会话 + 读消息 + 转 meta
 *
 * 依赖 lark-cli.js 封装，用户身份（--as user）读消息需要已授权的 get_as_user scope。
 *
 * 2026-09-23：话题群（chat_mode=topic）按会话只返回话题根消息，话题内回复需按 thread_id
 * 用 listThreadMessages 单独补拉（有界，见 MAX_THREAD_BACKFILL）。
 */

const larkCli = require('./lark-cli.js');
const { logInfo, logError } = require('./utils.js');

// 消息 content 解析正则（2026-08-18 非文本消息支持）
const IMAGE_KEY_RE = /\[Image:\s*([^\]]+)\]/;      // "[Image: img_v3_xxx]" → key
const XML_ATTR_KEY_RE = /key="([^"]+)"/;           // <file key="..." name="..."/>
const XML_ATTR_NAME_RE = /name="([^"]+)"/;
const CARD_BODY_RE = /<card>([\s\S]*?)<\/card>/;   // interactive 卡片内纯文本

// 话题群（chat_mode=topic）兜底补拉上限：每次同步每会话最多补拉多少个话题（取最新）
const MAX_THREAD_BACKFILL = 20;

/**
 * 列出用户所在的所有会话（含私聊 p2p + 群 group）。
 */
async function listChats(profile) {
  const res = await larkCli.run([
    '--profile', profile, 'im', '+chat-list',
    '--as', 'user', '--types', 'p2p,group', '--page-all', '--format', 'json',
  ]);
  if (res && res.ok && res.data && Array.isArray(res.data.chats)) {
    return res.data.chats;
  }
  return [];
}

/**
 * 读某个会话的最近消息（倒序；可选 startIso 增量起点，只拉该时间之后的消息）。
 * @param {string} profile
 * @param {string} chatId
 * @param {number} [pageSize=50]
 * @param {string} [startIso] - ISO 8601 起点（增量）
 */
async function listMessages(profile, chatId, pageSize = 50, startIso) {
  const args = [
    '--profile', profile, 'im', '+chat-messages-list',
    '--as', 'user', '--chat-id', chatId,
    '--page-size', String(pageSize), '--order', 'desc', '--no-reactions', '--format', 'json',
  ];
  if (startIso) args.push('--start', startIso);
  const res = await larkCli.run(args);
  if (res && res.ok && res.data && Array.isArray(res.data.messages)) {
    return res.data.messages;
  }
  return [];
}

/**
 * 读某个话题（thread）内的消息（倒序）。
 * 背景：话题群里 +chat-messages-list 只返回话题根消息，话题内回复必须按 thread_id 单独拉。
 * @param {string} profile
 * @param {string} threadId - omt_xxx
 * @param {number} [pageSize=50]
 */
async function listThreadMessages(profile, threadId, pageSize = 50) {
  const res = await larkCli.run([
    '--profile', profile, 'im', '+threads-messages-list',
    '--as', 'user', '--thread', threadId,
    '--page-size', String(pageSize), '--order', 'desc', '--no-reactions', '--format', 'json',
  ]);
  if (res && res.ok && res.data && Array.isArray(res.data.messages)) {
    return res.data.messages;
  }
  return [];
}

/**
 * 从会话消息（倒序）里挑出待补拉的话题 id：去重、取最新的前 maxN 个（有界，防 71 话题 → 71 请求）。
 * 非话题会话的消息不带 thread_id ⇒ 恒返回空数组，不产生任何额外请求。
 * @param {Array} msgs - listMessages 的返回（desc）
 * @param {number} [maxN=MAX_THREAD_BACKFILL]
 * @returns {string[]}
 */
function pickThreadIds(msgs, maxN = MAX_THREAD_BACKFILL) {
  const ids = [];
  for (const m of msgs || []) {
    const tid = m && m.thread_id ? String(m.thread_id).trim() : '';
    if (tid && !ids.includes(tid)) ids.push(tid);
    if (ids.length >= maxN) break;
  }
  return ids;
}

/**
 * 把一条轮询到的消息转成 ingest meta；跳过（返回 null）时表示不采集。
 *
 * 消息类型覆盖（2026-08-18 扩展，支持非文本消息）：
 *   text / post       → 文本入库（可召回）
 *   image             → resource_type=image，resource_key 从 "[Image: xxx]" 提取
 *   file              → resource_type=file，key/name 从 "<file key name/>" 提取
 *   folder            → resource_type=folder（文件夹容器，只展示不下载）
 *   interactive       → 提取 <card> 内纯文本（可召回）
 *   system / 未知类型 → 丢弃（返回 null）
 * 无文本消息（image/file/folder）只进 msg_metadata，不进 msg_embeddings（不做语义召回）。
 */
function messageToMeta(chat, m) {
  if (m.deleted) return null;                       // 已撤回
  if (m.msg_type === 'system') return null;         // 系统通知（入群等）无价值
  const chatType = chat.chat_mode === 'p2p' ? 'p2p' : 'group';
  const meta = {
    chat_id: m.chat_id || chat.chat_id,
    user_id: m.sender && m.sender.id ? m.sender.id : null,
    sender_name: m.sender && m.sender.name ? m.sender.name : null,
    chat_name: chat.name || null,
    message_id: m.message_id,
    msg_type: 'chat',
    chat_type: chatType,
    message_type: m.msg_type,
    text: '',
    resource_type: '',
    resource_key: '',
    file_name: '',
    root_id: null,
    thread_id: m.thread_id || '',   // omt_xxx；空串＝非话题消息（话题根与其内回复都带 thread_id）
    created_at: m.create_time || null,
  };
  const content = typeof m.content === 'string' ? m.content.trim() : '';
  switch (m.msg_type) {
    case 'text':
      meta.text = content;
      break;
    case 'post':
      meta.text = content;   // 富文本 JSON 原样存（latest.js 预览时截断/清洗）
      break;
    case 'image': {
      const keyMatch = IMAGE_KEY_RE.exec(content);
      if (keyMatch && keyMatch[1]) {
        meta.resource_type = 'image';
        meta.resource_key = keyMatch[1].trim();
      }
      break;
    }
    case 'file':
    case 'folder': {
      // <file key="file_v3_..." name="文件名.zip"/> 或 <folder key="..." name="..."/>
      const keyMatch = XML_ATTR_KEY_RE.exec(content);
      const nameMatch = XML_ATTR_NAME_RE.exec(content);
      meta.resource_type = m.msg_type;
      if (keyMatch && keyMatch[1]) meta.resource_key = keyMatch[1].trim();
      if (nameMatch && nameMatch[1]) meta.file_name = nameMatch[1].trim();
      break;
    }
    case 'interactive': {
      // <card> 内含可读纯文本（含 markdown 链接），提取为 text 供展示/召回
      const cardMatch = CARD_BODY_RE.exec(content);
      if (cardMatch && cardMatch[1]) {
        meta.text = cardMatch[1].trim();
      } else {
        meta.text = content;
      }
      break;
    }
    default:
      return null;   // share/sticker/audio/media/merge_forward 等未覆盖类型仍跳过
  }
  // 坏数据兜底：既无文本也无资源 key 的消息不采集
  if (!meta.text && !meta.resource_key) return null;
  return meta;
}

module.exports = { listChats, listMessages, listThreadMessages, pickThreadIds, messageToMeta, MAX_THREAD_BACKFILL };

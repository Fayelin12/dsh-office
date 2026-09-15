'use strict';

/**
 * ingestor.js — 飞书消息采集（单次轮询，外部触发，非后台常驻）
 *
 * 用法：node ingestor.js [--since "YYYY-MM-DD HH:MM"] [--window-hours N]
 *   --since：增量拉取起点（本地时间，与 created_at 同格式）；缺省用最近窗口
 *   --window-hours：覆盖默认窗口（默认 24h，上限 30 天）
 *
 * 配置：全部走环境变量（由 dsh-office 插件的 buildScriptEnv 注入，或手工 export），
 *      未配置走默认值；本脚本不读取任何 config.json：
 *   LARK_PROFILE          lark-cli 授权 profile（默认 'default'）
 *   FEISHU_DB_PATH        SQLite 库路径（默认 ~/.dsh/office/feishu.db）
 *   EMBEDDING_API_KEY     embedding key（空 = 跳过向量化，只写 msg_metadata）
 *   EMBEDDING_ENDPOINT    默认 https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings
 *   EMBEDDING_MODEL       默认 qwen3.7-text-embedding
 *   EMBEDDING_DIMENSIONS  默认 1024
 *
 * 流程：用户身份列出所有会话 → 按时间范围读消息 → 落库（+ 可选 embedding）→ 打印统计 → 退出
 *
 * stdout 契约（插件解析依据）：轮询完成 | 新增=X 跳过=Y 总消息=Z 耗时=Ns
 *
 * 触发方：dsh-office 插件（在需要同步时调用本脚本，自动带 --since=上次同步时间）。
 */

const path = require('path');
const os = require('os');
const { logInfo, logError } = require('./utils.js');
const embedding = require('./embedding.js');
const db = require('./db.js');
const poller = require('./poller.js');

// ===== 配置（环境变量 + 默认值，不读取 config.json） =====
const CONFIG = {
  profile: process.env.LARK_PROFILE || 'default',
  dbPath: process.env.FEISHU_DB_PATH || path.join(os.homedir(), '.dsh', 'office', 'feishu.db'),
  embedding: {
    apiKey: process.env.EMBEDDING_API_KEY || '',
    endpoint: process.env.EMBEDDING_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
    model: process.env.EMBEDDING_MODEL || 'qwen3.7-text-embedding',
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 1024,
  },
  poll: {
    pageSize: 50,
    sinceWindowHours: 24,
  },
};
// 是否启用向量化：EMBEDDING_API_KEY 为空 → 跳过 embedding，每条消息 vec 传 new Float32Array(0)
const hasEmbedding = !!CONFIG.embedding.apiKey;

// 解析 --since（本地 'YYYY-MM-DD HH:MM'），返回 Date | null
function parseSince(argv) {
  const i = argv.indexOf('--since');
  if (i >= 0 && argv[i + 1]) {
    const s = String(argv[i + 1]).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) {
      const d = new Date(s.replace(' ', 'T'));
      return isNaN(d.getTime()) ? null : d;
    }
  }
  return null;
}

// 解析 --window-hours（覆盖默认窗口，上限 30 天）
function parseWindowHours(argv) {
  const i = argv.indexOf('--window-hours');
  if (i >= 0 && argv[i + 1]) {
    const n = parseInt(argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 30 * 24);
  }
  return null;
}

async function main() {
  db.init(CONFIG.dbPath, CONFIG.embedding.dimensions);
  if (hasEmbedding) embedding.init(CONFIG.embedding);
  logInfo('ingestor', `初始化完成 | vec0=${db.getVec0Loaded()} embedding=${hasEmbedding ? 'on' : 'off'}`);

  const startedAt = Date.now();
  let ingested = 0;
  let skipped = 0;
  const pageSize = CONFIG.poll.pageSize;
  // 窗口（小时）：--window-hours > 默认 24
  const windowHours = parseWindowHours(process.argv.slice(2)) || CONFIG.poll.sinceWindowHours;

  // 增量时间范围：起点 = max(since, now - windowHours)，终点 = now
  const sinceArg = parseSince(process.argv.slice(2));
  const windowStart = new Date(startedAt - windowHours * 3600 * 1000);
  const since = sinceArg && sinceArg > windowStart ? sinceArg : windowStart;
  const startIso = since.toISOString();
  const sinceLabel = sinceArg ? sinceArg.toISOString() : '(无 --since，用窗口)';

  try {
    const chats = await poller.listChats(CONFIG.profile);
    logInfo('ingestor', `轮询开始 | 会话数=${chats.length} pageSize=${pageSize} 窗口=${windowHours}h since=${sinceLabel} start=${startIso}`);

    for (const chat of chats) {
      try {
        const msgs = await poller.listMessages(CONFIG.profile, chat.chat_id, pageSize, startIso);
        for (const m of msgs) {
          const meta = poller.messageToMeta(chat, m);
          if (!meta) { skipped++; continue; }
          if (db.hasMessage(meta.message_id)) { skipped++; continue; }  // 已入库跳过，不重复 embed
          // 向量化可选：EMBEDDING_API_KEY 为空 → 跳过 embedding；无文本消息（image/file/folder）也不 embedding
          const vec = (hasEmbedding && meta.text)
            ? await embedding.embed(meta.text)
            : new Float32Array(0);
          if (db.insertMsgVector(vec, meta)) {
            ingested++;
            logInfo('ingestor', `入库 | chat_id=${meta.chat_id} msg_id=${meta.message_id} type=${meta.message_type || '-'} res=${meta.resource_type || '-'}`);
          } else {
            skipped++;
          }
        }
      } catch (e) {
        logError('ingestor', `会话失败 | chat_id=${chat.chat_id} error=${e.message}`);
      }
    }
  } catch (e) {
    logError('ingestor', `轮询失败 | error=${e.message}`);
  }

  const stats = db.getStats();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  logInfo('ingestor', `轮询完成 | 新增=${ingested} 跳过=${skipped} 总消息=${stats.messages} 耗时=${elapsed}s`);
  process.exit(0);
}

main().catch((e) => {
  logError('ingestor', `致命错误 | error=${e.message}`);
  process.exit(1);
});

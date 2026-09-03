'use strict';

/**
 * insights.js — 每日洞察生成（供 dsh-office「💡 洞察」视图）
 *
 * 形态：今日飞书日报（LLM 通读窗口内全部文本消息，要点式日报）
 *   📰 日报正文（report）     —— LLM 通读全量消息生成的要点式日报（markdown，含来源会话）
 *   📋 重要待办（todos）      —— LLM 从全量消息判定（带动作/优先级/理由）
 *   📩 未回复消息（unreplied）—— 纯规则（私聊末条非我；群聊末条非我且 @ 到「我」才计入）
 *   🔥 高价值讨论（highlights）—— LLM 判定（带原文引用）
 *
 * 用法：node insights.js [--date YYYY-MM-DD] [--window-days N] [--profile xxx]
 *   [--llm-endpoint URL] [--llm-model M] [--llm-key-env VAR]
 *   [--self-user-id ou_xxx] [--mention-names 名1,名2]
 *   [--todos-top N] [--highlights-top N] [--unreplied-hours N]
 *
 * 配置（环境变量 + 默认值，不读取任何 config.json）：
 *   FEISHU_DB_PATH    消息库 SQLite 路径（默认 ~/.dsh/office/feishu.db）
 *   LARK_PROFILE      lark-cli profile（默认 ''，--profile 参数优先）
 *   LLM key 经 --llm-key-env 指定的环境变量注入（由插件从 insights.llmKeyFile 读取后注入）
 *
 * 说明：
 *   - 不做向量预筛：日报需要通读全量（预筛会漏召回）；消息量超阈值时按会话截断兜底。
 *   - 机器人/自动推送消息也进日报，价值由 LLM 判断。
 *   - stdout 只有一行 JSON（与 latest.js 同模式）；日志走 stderr。
 *
 * 输出契约：
 *   { ok: true, date, generatedAt, stats: { windowDays, scanned, llm, selfUserId },
 *     summary, sections: { report, todos, unreplied, highlights } }
 *   失败：{ ok: false, error: { code, message } }
 */

const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const { logError, httpsRequest } = require('./utils.js');
const larkCli = require('./lark-cli.js');

const LLM_TIMEOUT_MS = 60000;
const LLM_RETRY = 1;                    // 非 JSON 输出重试次数
const MAX_INPUT_CHARS = 20000;          // 日报输入总字符上限（超出按会话截断兜底）
const MAX_PER_CHAT = 60;                // 单个会话最多进入日报的消息条数

// 消息库路径（环境变量优先，默认 ~/.dsh/office/feishu.db）
const DB_PATH = process.env.FEISHU_DB_PATH || path.join(os.homedir(), '.dsh', 'office', 'feishu.db');

/** 本地时间字符串（YYYY-MM-DD HH:MM）→ Date（Windows/Node 兼容解析） */
function parseLocal(s) {
  return new Date(String(s).replace(/-/g, '/'));
}

// ===== 参数解析 =====
function parseArg(argv, name, def) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1]) return String(argv[i + 1]).trim();
  return def;
}

function parseIntArg(argv, name, def) {
  const v = parseArg(argv, name, '');
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseArgs(argv) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
  return {
    date: parseArg(argv, 'date', todayStr),
    windowDays: parseIntArg(argv, 'window-days', 1),
    profile: parseArg(argv, 'profile', process.env.LARK_PROFILE || ''),
    llmEndpoint: parseArg(argv, 'llm-endpoint', ''),
    llmModel: parseArg(argv, 'llm-model', ''),
    llmKeyEnv: parseArg(argv, 'llm-key-env', ''),
    selfUserId: parseArg(argv, 'self-user-id', ''),
    mentionNames: parseArg(argv, 'mention-names', '').split(',').map((s) => s.trim()).filter(Boolean),
    todosTop: parseIntArg(argv, 'todos-top', 10),
    highlightsTop: parseIntArg(argv, 'highlights-top', 5),
    unrepliedHours: parseIntArg(argv, 'unreplied-hours', 12),
  };
}

// ===== LLM 配置（参数优先；key 从 --llm-key-env 指定的环境变量读取） =====
function resolveLlmCfg(args) {
  const endpoint = args.llmEndpoint || 'https://api.deepseek.com/v1/chat/completions';
  const model = args.llmModel || 'deepseek-chat';
  const key = args.llmKeyEnv ? (process.env[args.llmKeyEnv] || '') : '';
  return { endpoint, model, key, timeoutMs: LLM_TIMEOUT_MS };
}

// ===== 工具 =====
function fail(code, message) {
  console.log(JSON.stringify({ ok: false, error: { code, message } }));
  process.exit(1);
}

/** post 富文本 JSON 里提取可读文本；普通文本原样返回 */
function normalizeText(text) {
  if (!text) return '';
  const t = String(text).trim();
  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t);
      if (obj && obj.text) return String(obj.text);
    } catch (_) { /* 非 JSON，走原文 */ }
  }
  return t;
}

/** 打开只读消息库（日报只需 msg_metadata，无需向量扩展） */
function openDb() {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

/** 解析自己 open_id：显式参数 > lark-cli auth status > 无 */
async function resolveSelfId(args) {
  if (args.selfUserId) return args.selfUserId;
  try {
    const res = await larkCli.run(['--profile', args.profile, 'auth', 'status']);
    const openId = res && res.identities && res.identities.user && res.identities.user.openId;
    if (openId) return openId;
  } catch (e) {
    logError('insights', 'auth status 失败: ' + e.message);
  }
  return '';
}

// ===== 日报 prompt：全量消息按会话分组 → LLM =====
function buildReportPrompt(groups, args) {
  const sys = '你是「办公室洞察」助手，帮用户把今天收到的飞书消息整理成一份简明日报。只输出 JSON，不要输出任何其他内容。';
  let user = '以下是今天各会话收到的消息（已按会话分组、时间升序；[私聊] 为单聊）：\n\n';
  let total = 0;
  for (const g of groups) {
    user += `## 会话「${g.chat_name || g.chat_id}」(${g.chat_type === 'p2p' ? '私聊' : '群聊'}, ${g.messages.length}条)\n`;
    for (const m of g.messages) {
      const time = String(m.created_at || '').slice(11, 16);
      user += `- [${time}] ${m.sender_name || m.user_id || '成员'}：${m.text}\n`;
      total++;
    }
    user += '\n';
  }
  user += `共 ${total} 条消息。\n\n`;
  user += '请输出 JSON（格式严格如下）：\n';
  user += '{"summary":"一句话概括今天最重要的信息（不超过40字）","report":"日报正文（markdown，简洁要点式，每条要点含：要点本身 + 为什么值得注意 + 来源会话；按重要性排序，3~6条；只写有信息量的内容：决策/规则/进展/通知/重要问答；忽略闲聊、寒暄、广告、表情、拼房信息）","todos":[{"action":"要做什么","priority":"高|中|低","assignee":"我|他人","reason":"为什么是待办","chat":"来源会话名"}],"highlights":[{"chat":"来源会话名","summary":"这段讨论的核心/结论","messages":[{"sender":"发送者","text":"消息原文","time":"HH:MM"}]}]}\n';
  user += '规则：\n';
  user += `- todos 只包含需要用户本人处理/跟进的（最多 ${args.todosTop} 条），纯信息告知不算待办；\n`;
  user += `- highlights 是值得用户回看的讨论（有结论/观点交锋/关键信息），最多 ${args.highlightsTop} 条，每条附 2~5 条关键消息原文（必须来自上面的输入）；\n`;
  user += '- 机器人/自动推送消息如有价值也纳入 report，由你判断；\n';
  user += '- report 用简洁要点式，不要流水账，不要编造输入里没有的信息。';
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

async function callLlm(messages, cfg) {
  const urlObj = new URL(cfg.endpoint);
  const body = JSON.stringify({ model: cfg.model, messages, temperature: 0.2, max_tokens: 4096 });
  const resp = await httpsRequest({
    hostname: urlObj.hostname,
    path: urlObj.pathname + (urlObj.search || ''),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body,
    timeout: cfg.timeoutMs,
  });
  const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
  if (!content) throw new Error('LLM 无输出');
  return content;
}

/** 从 LLM 输出中提取 JSON 并校验结构；失败返回 null */
function parseLlmJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (!obj || typeof obj.summary !== 'string' || typeof obj.report !== 'string') return null;
    if (!Array.isArray(obj.todos) || !Array.isArray(obj.highlights)) return null;
    return obj;
  } catch (_) { return null; }
}

/** LLM 日报输出 → 洞察 sections 结构 */
function applyReport(llmOut) {
  const todos = (llmOut.todos || []).slice(0, 20).map((t) => ({
    is_todo: true, llm: true, action: t.action || '', priority: t.priority || '中',
    assignee: t.assignee || '', reason: t.reason || '', chat_name: t.chat || '',
  }));
  const highlights = (llmOut.highlights || []).slice(0, 10).map((h) => ({
    llm: true, chat_name: h.chat || '', summary: h.summary || '',
    messages: Array.isArray(h.messages) ? h.messages.map((m) => ({
      sender_name: m.sender, text: m.text, created_at: m.time,
    })).filter((m) => m.text) : [],
  }));
  return { report: llmOut.report, summary: llmOut.summary, todos, highlights };
}

// ===== 主流程 =====
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();

  // 窗口（本地时间字符串比较，与 latest.js 一致）
  const pad = (n) => String(n).padStart(2, '0');
  const endIso = args.date + ' 23:59';
  let startStr = args.date + ' 00:00';
  if (args.windowDays > 1) {
    const d = parseLocal(args.date + ' 00:00:00');
    d.setDate(d.getDate() - (args.windowDays - 1));
    startStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' 00:00';
  }

  const selfId = await resolveSelfId(args);

  // 窗口内全部文本消息（日报 + 未回复共用；最后一条可能是 image/file 等无文本消息——未回复只认文本）
  let allRows;
  try {
    allRows = db.prepare(`
      SELECT rowid, chat_id, chat_name, chat_type, user_id, sender_name, message_type,
             text, created_at
      FROM msg_metadata
      WHERE created_at >= ? AND created_at <= ? AND text IS NOT NULL AND text != ''
      ORDER BY created_at ASC, rowid ASC
    `).all(startStr, endIso);
  } catch (e) {
    fail('QUERY_FAILED', '消息查询失败: ' + e.message);
  }
  const scanned = allRows.length;

  const toMessage = (r) => ({
    chat_id: r.chat_id, chat_name: r.chat_name, chat_type: r.chat_type,
    user_id: r.user_id, sender_name: r.sender_name, message_type: r.message_type,
    text: normalizeText(r.text), created_at: r.created_at,
  });
  const messages = allRows.map(toMessage);

  // ===== ① 未回复（纯规则）：私聊末条非我；群聊末条非我 且 文本 @ 到「我」 =====
  const lastByChat = new Map();
  for (const m of messages) {
    lastByChat.set(m.chat_id, m); // 已按时间升序，覆盖即最后一条
  }
  const nowTs = Date.now();
  const unreplied = [];
  for (const m of lastByChat.values()) {
    if (!m.user_id || !selfId || m.user_id === selfId) continue;
    const hoursAgo = (nowTs - parseLocal(m.created_at).getTime()) / 3600000;
    if (hoursAgo > args.unrepliedHours) continue;
    // 群聊：仅当末条消息 @ 到 mention 名单中的名字才计入（无名单则跳过），避免活跃群噪声
    if (m.chat_type === 'group') {
      const mentioned = args.mentionNames.some((name) => m.text.includes('@' + name));
      if (!mentioned) continue;
    }
    unreplied.push({
      chat_id: m.chat_id, chat_name: m.chat_name || m.chat_id, chat_type: m.chat_type,
      why: m.chat_type === 'p2p' ? 'p2p最后一条非我' : '群聊@我未回复',
      since_hours: Math.round(hoursAgo * 10) / 10,
      last_message: { sender_name: m.sender_name, text: m.text, created_at: m.created_at },
    });
  }
  // 未回复排序：越久未回越靠前
  unreplied.sort((a, b) => b.since_hours - a.since_hours);

  // ===== ② 日报（LLM 通读全量，按会话分组 + 截断兜底） =====
  const groups = [];
  const byChat = new Map();
  for (const m of messages) {
    if (!byChat.has(m.chat_id)) {
      byChat.set(m.chat_id, { chat_id: m.chat_id, chat_name: m.chat_name || m.chat_id, chat_type: m.chat_type, messages: [] });
    }
    const g = byChat.get(m.chat_id);
    if (g.messages.length < MAX_PER_CHAT) g.messages.push(m);   // 单会话条数兜底
  }
  for (const g of byChat.values()) {
    let chars = 0;
    for (const m of g.messages) chars += m.text.length + 8;
    if (chars > MAX_INPUT_CHARS) {   // 全局字符兜底：超限只保留每会话靠前的消息
      g.messages = g.messages.slice(0, Math.max(1, Math.floor(MAX_INPUT_CHARS / Math.max(1, g.messages.length))));
    }
    if (g.messages.length > 0) groups.push(g);
  }
  groups.sort((a, b) => b.messages.length - a.messages.length);   // 消息多的会话在前（保证截断时优先完整保留）

  const llmCfg = resolveLlmCfg(args);
  let llmState = 'disabled';
  let report = '', summary = '', todos = [], highlights = [];
  let llmOut = null;
  if (messages.length > 0 && llmCfg.key && llmCfg.endpoint) {
    for (let attempt = 0; attempt <= LLM_RETRY && !llmOut; attempt++) {
      try {
        const content = await callLlm(buildReportPrompt(groups, args), llmCfg);
        const parsed = parseLlmJson(content);
        if (parsed) llmOut = parsed;
      } catch (e) {
        logError('insights', 'LLM 调用失败 attempt=' + attempt + ' ' + e.message);
      }
    }
    llmState = llmOut ? 'ok' : 'fallback';
  }
  if (llmOut) {
    const applied = applyReport(llmOut);
    report = applied.report; summary = applied.summary;
    todos = applied.todos; highlights = applied.highlights;
  }

  // LLM 无输出 / 未配置时，补统计句兜底
  if (!summary || summary.length < 3) {
    summary = `今日 ${todos.length} 条待办、${unreplied.length} 条消息未回复、${highlights.length} 场讨论（LLM 判定${llmState === 'ok' ? '完成' : '不可用'}）`;
  }
  if (!report || report.length < 3) {
    report = `今日共 ${scanned} 条消息（${groups.length} 个会话）。LLM 判定${llmState === 'ok' ? '已完成' : '不可用'}，未生成日报正文。`;
  }

  console.log(JSON.stringify({
    ok: true,
    date: args.date,
    generatedAt: Date.now(),
    stats: { windowDays: args.windowDays, scanned, llm: llmState, selfUserId: selfId },
    summary,
    sections: { report, todos, unreplied, highlights },
  }));
  process.exit(0);
}

main().catch((e) => {
  logError('insights', '致命错误: ' + e.message);
  console.log(JSON.stringify({ ok: false, error: { code: 'FATAL', message: e.message } }));
  process.exit(1);
});

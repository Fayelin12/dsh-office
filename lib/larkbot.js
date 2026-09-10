// ============================================================================
// 「🤖 群聊助理」模块 v3（挂接 office 每小时飞书同步，钩子驱动）
//
// v1：@larksuite/channel WS 机器人通道（废弃——需 app_secret）
// v2：独立 lark-cli 轮询（废弃——与 office 现有同步链路重复）
// v3（本版）：**复用 office 现有的每小时飞书同步**（feishu-config scripts.sync =
//   飞书采集脚本，user 身份拉全会话含机器人 P2P → SQLite 存档，已实测覆盖）。
//   同步完成 → lark.js 调 shared.onFeishuSynced() → 本模块：
//    1. 调 latest.js（--since=处理游标）取「新入库」消息
//    2. 过滤出目标会话（allowChats 白名单群 + 机器人 P2P）+ 非机器人 + 文本 + 未处理
//    3. 逐条 LLM 门控判断是否值得开 dsh 任务（宁缺毋滥，失败保守跳过）
//    4. 需要：该会话专属 dsh 会话执行（一群/一私聊 = 一项目空间 = 一长会话）
//    5. 结果 lark-cli im +messages-reply（--as bot）markdown 回原消息
//  处理游标 lastProcessedAt 持久化（靠 message_id seen 去重兜底，不重复/不漏）。
//
// 零新增凭据：lark-cli 授权即飞书应用（secret 存本机 keychain）；回复/读均走它，
// 沿用成熟的 lark-cli spawn 封装（env 剔除 OPENCLAW_*）。
//
// 配置：~/.dsh/office/larkbot-config.json（无凭据字段）
// 状态：~/.dsh/office/larkbot-state.json（决策日志 + seen 游标 + lastProcessedAt）
// ============================================================================

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { request } from "node:https";
import { DATA_DIR } from "./constants.js";
import { isLoopback } from "./util.js";

const LARKBOT_CONFIG_PATH = join(DATA_DIR, "larkbot-config.json");
const LARKBOT_STATE_PATH = join(DATA_DIR, "larkbot-state.json");
// office 飞书主配置（同源：latest 读取脚本路径、同步间隔由它管）
const FEISHU_CONFIG_PATH = join(DATA_DIR, "feishu-config.json");

const DEFAULT_CLI_CANDIDATES = [
  "C:\\Users\\{USER}\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js",
];

const DEFAULT_WORKSPACE_ROOT = join(DATA_DIR, "larkbot-projects");
const SESSION_ID_PREFIX = "office-larkbot-";
const DECISIONS_MAX = 100;
const GATE_MAX_TOKENS = 800;
const GATE_TIMEOUT_MS = 15_000;
const REPLY_MAX_CHARS = 4000;
const PER_CHAT_SEEN_MAX = 300;
const MAX_PENDING_PER_CHAT = 15;
const TURN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const CLI_TIMEOUT_MS = 60_000;
const LATEST_TIMEOUT_MS = 30_000;
// 门控起点回退余量（分钟）：latest 的 created_at 为分钟精度，游标减余量防漏，
// 重复由 message_id seen 去重兜底
const CURSOR_BACKOFF_MIN = 2;
// 门控输入：最近上下文条数上限 + 单条长度上限（软判断「回复后关联对话」用）
const GATE_CONTEXT_MAX = 10;
const GATE_CONTEXT_MSG_MAX = 200;
const DEFAULT_BOT_NAME = "";

// 提示词外置 + 热加载：默认取包内 assets/prompts/，可在 ~/.dsh/office/prompts/ 放同名 .md 覆盖。
// 每次使用实时读盘（门控/会话挂载均为低频路径），改文件后即时生效，无需重启 dsh。
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "prompts");
const PROMPTS_OVERRIDE_DIR = join(DATA_DIR, "prompts");

function readPromptSync(name) {
  for (const dir of [PROMPTS_OVERRIDE_DIR, PROMPTS_DIR]) {
    const p = join(dir, name + ".md");
    try {
      if (existsSync(p)) return readFileSync(p, "utf8").replace(/^\uFEFF/, "").trimEnd();
    } catch (_) { /* 读取失败（如文件被占用）则尝试下一候选 */ }
  }
  return null; // 包内默认也缺失 → 调用处保守处理
}

// 门控兜底（仅当包内 gate-system.md 也缺失时的极简指令，防门控无 system 文本）
const GATE_MINIMAL = "你是群聊助理：根据一批飞书消息与最近上下文，判断每条是否值得处理，只输出 JSON {\"decisions\":[{\"index\":0,\"action\":\"run\"|\"direct\"|\"skip\",\"reason\":\"10字内理由\",\"reply\":\"direct 时必填\"}]}。";

// ---------------------------------------------------------------------------
// 配置（无凭据字段）
// ---------------------------------------------------------------------------

function defaultConfig() {
  return {
    enabled: false,
    cliPath: "",               // lark-cli run.js 绝对路径；空 = 自动探测
    profile: "",               // lark-cli profile；空 = currentApp
    as: "bot",                 // 回复身份：bot（默认，飞书应用身份）| user
    workspaceRoot: "",
    allowChats: [],            // 监听群白名单；群聊只限名单内
    allowP2p: true,            // true = 启动事件通道，处理飞书应用收到的所有 p2p 私聊（任何人）
    botName: "",               // 机器人显示名：@检测用；空 = 需显式配置
    kbPaths: [],               // 本地知识库目录（「商业视角/平台」问答依据）；空 = 不挂知识库
    agentPreset: "",
    provider: "",
    model: "",
    maxPendingPerChat: MAX_PENDING_PER_CHAT,
    replyMaxChars: REPLY_MAX_CHARS,
  };
}

// 读本地 JSON 配置：用户手写/编辑器可能带 UTF-8 BOM，JSON.parse 会失败，统一剥离（与 lark.js 兜底一致）
function readJsonFileSync(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function loadConfig() {
  try {
    if (!existsSync(LARKBOT_CONFIG_PATH)) {
      return { ok: false, error: { code: "NO_CONFIG", message: "未找到 larkbot-config.json" } };
    }
    const user = readJsonFileSync(LARKBOT_CONFIG_PATH);
    const cfg = { ...defaultConfig(), ...user };
    return { ok: true, cfg };
  } catch (e) {
    return { ok: false, error: { code: "BAD_CONFIG", message: `配置解析失败：${e && e.message ? e.message : String(e)}` } };
  }
}

function saveEnabled(enabled) {
  try {
    const existing = existsSync(LARKBOT_CONFIG_PATH)
      ? readJsonFileSync(LARKBOT_CONFIG_PATH)
      : {};
    existing.enabled = enabled;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LARKBOT_CONFIG_PATH, JSON.stringify(existing, null, 2), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 1, message: e && e.message ? e.message : String(e) } };
  }
}

// 读 office 飞书主配置（拿 latest 读取脚本；没配置则 larkbot 无法取消息）
function loadFeishuConfig() {
  try {
    if (!existsSync(FEISHU_CONFIG_PATH)) return { ok: false, error: { code: "NO_FEISHU_CONFIG", message: "未找到 feishu-config.json（需先配置 💬 飞书消息流）" } };
    const cfg = readJsonFileSync(FEISHU_CONFIG_PATH);
    if (!cfg.scripts || !cfg.scripts.latest) {
      return { ok: false, error: { code: "NO_LATEST", message: "feishu-config.json 缺少 scripts.latest（消息读取脚本）" } };
    }
    return { ok: true, cfg };
  } catch (e) {
    return { ok: false, error: { code: "BAD_FEISHU_CONFIG", message: `feishu-config.json 解析失败：${e && e.message ? e.message : String(e)}` } };
  }
}

function detectCliPath() {
  for (const cand of DEFAULT_CLI_CANDIDATES) {
    const p = cand.replace("{USER}", process.env.USERNAME || "");
    if (existsSync(p)) return p;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

function loadState() {
  try {
    if (existsSync(LARKBOT_STATE_PATH)) {
      const parsed = JSON.parse(readFileSync(LARKBOT_STATE_PATH, "utf8"));
      return {
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        seenByChat: parsed.seenByChat && typeof parsed.seenByChat === "object" ? parsed.seenByChat : {},
        sentMsgIds: Array.isArray(parsed.sentMsgIds) ? parsed.sentMsgIds : [],
        lastProcessedAt: typeof parsed.lastProcessedAt === "string" ? parsed.lastProcessedAt : null,
      };
    }
  } catch (_) { /* 损坏从空开始 */ }
  return { decisions: [], seenByChat: {}, sentMsgIds: [], lastProcessedAt: null };
}

// 持久化状态（决策日志 + seen 游标 + 处理游标）；失败不抛出（持久化非关键路径）
function saveState(state) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LARKBOT_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
    return true;
  } catch (_) {
    return false;
  }
}

// 本地时间 'YYYY-MM-DD HH:MM'（与 latest.js/feishu-state 同格式）
function localMinuteString(d) {
  const dt = d || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

function minuteAgoString(d, mins) {
  return localMinuteString(new Date((d || new Date()).getTime() - mins * 60 * 1000));
}

// ---------------------------------------------------------------------------
// lark-cli / latest.js 调用
// ---------------------------------------------------------------------------

function cleanCliEnv() {
  const env = { ...process.env };
  for (const k of [
    "OPENCLAW_STATE_DIR", "OPENCLAW_WEB_SEARCH_PROVIDER", "OPENCLAW_HOME",
    "OPENCLAW_CONFIG_PATH", "HERMES_HOME",
  ]) {
    delete env[k];
  }
  return env;
}

function runNodeScript(scriptPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [scriptPath, ...args], {
        env: cleanCliEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      reject(new Error(`spawn 失败: ${e.message}`));
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* noop */ }
      reject(new Error(`脚本超时（${Math.round((timeoutMs || 30000) / 1000)}s）`));
    }, timeoutMs || 30000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try { resolve(JSON.parse(out)); } catch (_) { resolve(out); }
      } else {
        reject(new Error(`exit ${code}: ${(err || out).slice(0, 300)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

function safeChatName(chatId) {
  const cleaned = String(chatId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "default";
}

async function resolveChatWorkspace(workspaceRoot, chatId) {
  const dir = join(workspaceRoot, safeChatName(chatId));
  await mkdir(dir, { recursive: true });
  return dir;
}

// 群聊里是否 @ 了机器人（实测：用户 @ 存为纯文本「@名字」；兼容可能的 <at> 原始标记）
function isMentionedBot(text, botName) {
  const t = String(text || "");
  if (!botName) return false;
  if (t.includes("@" + botName)) return true;
  return t.includes(">" + botName + "</at>");   // <at user_id="...">机器人名</at>
}

// 构建门控用的最近上下文（含机器人自己的回复；assistant 标记机器人本人）。
// excludeIds：要排除的消息 id（单个或数组；批处理时排除整批，拿到「这批之前」的最近上下文）
function buildRecentContext(chat, excludeIds, botName) {
  const ex = new Set((Array.isArray(excludeIds) ? excludeIds : [excludeIds]).map((v) => String(v)).filter(Boolean));
  const list = Array.isArray(chat && chat.recent_messages) ? chat.recent_messages : [];
  return list
    .filter((x) => x && !ex.has(String(x.message_id || "")))
    .slice(0, GATE_CONTEXT_MAX)
    .reverse()
    .map((x) => {
      // 机器人自己的消息也带进上下文（回复/日报/纪要等可能相关），标 assistant=true；
      // 兜底用 user_id 的 cli_ 前缀判定（sender_name 缺失时仍能认出是机器人）
      const isBot = String(x.user_id || "").startsWith("cli_") || (!!botName && x.sender_name === botName);
      return {
        who: x.sender_name || x.user_id || "未知",
        assistant: isBot,
        text: clip(x.text || "", GATE_CONTEXT_MSG_MAX),
      };
    });
}

// 构建会话侧「本地知识库」提示段（渐进式披露：仅这些目录是回答依据）
function buildKbPrompt(kbPaths) {
  const paths = Array.isArray(kbPaths) ? kbPaths.map((p) => String(p || "").trim()).filter(Boolean) : [];
  if (paths.length === 0) return "";
  return `# 本地知识库（回答依据）
以下是你的回答依据目录（具体内容以目录为准：可能含行业资讯、调研归档、产品/开发文档等）。问题内容落在这些目录覆盖范围内时，优先用 read/grep/glob 工具检索对应目录再回答，不要凭记忆编造；检索不到就如实说明找不到，可再给一句标注为「个人看法」的判断。目录：
${paths.map((p) => `- ${p}`).join("\n")}`;
}

// 门控输入（批处理）：一批消息 + 共享最近上下文。messages 按时间正序，带 index 供输出对齐。
function gateBatchUserText(chat, messages, context, botName) {
  const msgs = (Array.isArray(messages) ? messages : []).map((m, i) => ({
    index: i,
    sender: (m && m.sender_name) || (m && m.user_id) || "未知",
    text: (m && m.text) || "",
    private: !!(m && m.chat_type === "p2p"),
    mentionedBot: isMentionedBot(m && m.text, botName),
  }));
  const chatName = (chat && chat.chat_name) || (msgs.length && (messages[0].chat_name || messages[0].chat_id)) || "";
  return JSON.stringify({
    chat: chatName,
    recent: Array.isArray(context) ? context : [],
    messages: msgs,
  });
}

function buildBridgePrompt(m) {
  const meta = {
    chatId: m.chat_id,
    chatName: m.chat_name || undefined,
    senderId: m.user_id || undefined,
    senderName: m.sender_name || undefined,
  };
  const user = { text: m.text || "" };
  const esc = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  // 带最近上下文进会话（门控阶段已算好 m._gateContext：时间正序的 {who, assistant, text} 列表），
  // 让会话看见连续几条消息，不漏关联追问、也不重复问已经答过的
  const recent = Array.isArray(m && m._gateContext) ? m._gateContext : [];
  const recentBlock = recent.length > 0
    ? `\n\n<recent_context>\n${esc(recent)}\n</recent_context>`
    : "";
  return `<bridge_context>\n${esc(meta)}\n</bridge_context>${recentBlock}\n\n<user_input>\n${esc(user)}\n</user_input>`;
}

function clip(text, max) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// 把会话输出按「单独一行 ---（3 个及以上横线）」拆成多条独立回复（多问分开回）；
// 无分隔符时整段作为一条。回复风格里已约定该分隔符为多问分隔，不做其它 markdown 用途。
function splitReplies(text) {
  const parts = String(text || "")
    .split(/^\s*-{3,}\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [String(text || "")];
}

// 解析批门控输出：接受 {decisions:[...]} / 数组 / 单个对象三种形态；按 index 对齐，缺省补 skip
function parseGateBatchJson(text, expectedCount) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  let start = t.indexOf("["), end = t.lastIndexOf("]");
  const objStart = t.indexOf("{"), objEnd = t.lastIndexOf("}");
  if (start === -1 || (objStart >= 0 && objStart < start)) { start = objStart; end = objEnd; }
  if (start < 0 || end <= start) return null;
  t = t.slice(start, end + 1);
  let raw;
  try { raw = JSON.parse(t); } catch (_) { return null; }
  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object" && Array.isArray(raw.decisions)) list = raw.decisions;
  else if (raw && typeof raw === "object" && (raw.action === "run" || raw.action === "direct" || raw.action === "skip")) list = [raw];
  if (!list) return null;
  const n = Number.isInteger(expectedCount) && expectedCount > 0 ? expectedCount : list.length;
  const decisions = new Array(n).fill(null);
  list.forEach((d, pos) => {
    if (!d || typeof d !== "object") return;
    const idx = Number.isInteger(d.index) ? d.index : pos;
    if (idx < 0 || idx >= n) return;
    const action = (d.action === "run" || d.action === "direct" || d.action === "skip") ? d.action : null;
    if (!action) return;
    decisions[idx] = {
      action,
      reason: typeof d.reason === "string" ? d.reason : "",
      reply: typeof d.reply === "string" ? d.reply.trim() : "",
    };
  });
  // 未被覆盖的条目保守按 skip 处理（宁可不回，也别乱回）
  for (let i = 0; i < n; i++) {
    if (!decisions[i]) decisions[i] = { action: "skip", reason: "门控未给出该条决策", reply: "" };
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// 群聊助理服务（钩子驱动）
// ---------------------------------------------------------------------------

class LarkBotService {
  constructor(runtime) {
    this.ctx = runtime.ctx;
    this.services = runtime.services;
    this.shared = runtime.shared;
    this.log = (level, msg) => {
      try {
        if (typeof this.shared.appendOfficeLog === "function") {
          this.shared.appendOfficeLog(level, String(msg));
          return;
        }
      } catch (_) { /* 降级 */ }
      try {
        const fn = this.ctx.logger && this.ctx.logger[level];
        if (typeof fn === "function") fn.call(this.ctx.logger, String(msg));
      } catch (_) { /* noop */ }
    };
    this.ctxLogger = runtime.ctx.logger;

    this.cfg = null;
    this.lastError = null;
    this.startedAt = null;
    this.lastRunAt = null;         // 最近一次 afterSync 处理时刻
    this.chatNames = new Map();

    this.chatSessions = new Map();
    this.handlers = new Map();
    this.busy = new Set();
    this.pending = new Map();
    this.eventRestartDelay = 3000;   // 事件监听重连退避（成功就绪后重置，退出时翻倍）
    this.eventToken = 0;             // 事件监听代际令牌（防旧子进程 exit 污染新子进程）

    const state = loadState();
    this.decisions = state.decisions;
    this.seenByChat = state.seenByChat;
    this.sentMsgIds = state.sentMsgIds;
    this.lastProcessedAt = state.lastProcessedAt;

    try {
      const on = runtime.ctx.on && runtime.ctx.on.bind(runtime.ctx);
      if (typeof on === "function") {
        this.unsubSessionEvent = on("session/event", (session, event) => {
          try {
            const key = String(session && session.id);
            const handler = this.handlers.get(key);
            if (!handler) return;
            const translated = translateSessionEvent(event);
            if (translated) handler(translated);
          } catch (e) {
            this.log("warn", `[larkbot] session/event 处理异常: ${e && e.message ? e.message : e}`);
          }
        });
      }
    } catch (e) {
      this.ctxLogger?.warn?.("[larkbot] 订阅 session/event 失败:", e);
    }
  }

  get agents() { return this.services.agents || this.ctx.get("agents"); }
  get sessionPersistence() { return this.services.sessionPersistence || this.ctx.get("sessionPersistence"); }
  _optional(name) {
    const get = this.ctx.get && this.ctx.get.bind(this.ctx);
    if (typeof get !== "function") return undefined;
    try { return get(name); } catch (_) { return undefined; }
  }
  get llm() { return this._optional("llm"); }
  get agentPresets() { return this._optional("agentPresets"); }
  get agentDefaultModel() { return this._optional("agentDefaultModel"); }
  get workspaceRegistry() { return this.ctx.workspaceRegistry || this._optional("workspaceRegistry"); }
  get botName() { return (this.cfg && this.cfg.botName) || DEFAULT_BOT_NAME; }

  dispose() {
    this.stop();
    if (this.unsubSessionEvent) {
      try { this.unsubSessionEvent(); } catch (_) { /* noop */ }
      this.unsubSessionEvent = null;
    }
  }

  // ---- 启动 / 停止（v3：不轮询，仅校验配置 + 定位目标会话；处理由同步钩子触发） ----

  async start() {
    if (this.startedAt) return;
    const loaded = loadConfig();
    if (!loaded.ok) {
      this.lastError = loaded.error.message;
      this.log("error", `[larkbot] ${loaded.error.message}`);
      return;
    }
    const cfg = loaded.cfg;
    if (!cfg.enabled) {
      this.log("info", "[larkbot] 配置 enabled=false，不启动（可在面板开启）");
      return;
    }
    const hasGroups = Array.isArray(cfg.allowChats) && cfg.allowChats.length > 0;
    if (!hasGroups && cfg.allowP2p === false) {
      this.lastError = "allowChats 为空且 allowP2p=false：无任何监听目标（fail-closed）。请填入群 chat_id 或开启 allowP2p。";
      this.log("warn", `[larkbot] ${this.lastError}`);
      return;
    }
    const feishuCfg = loadFeishuConfig();
    if (!feishuCfg.ok) {
      this.lastError = feishuCfg.error.message;
      this.log("error", `[larkbot] ${this.lastError}`);
      return;
    }
    const cliPath = (cfg.cliPath && String(cfg.cliPath).trim()) || detectCliPath();
    if (!cliPath || !existsSync(cliPath)) {
      this.lastError = `找不到 lark-cli run.js（配置 cliPath 或安装于 npm 全局）`;
      this.log("error", `[larkbot] ${this.lastError}`);
      return;
    }

    this.cfg = cfg;
    this.cliPath = cliPath;
    this.latestScript = feishuCfg.cfg.scripts.latest;
    // 门控 LLM key：默认复用洞察的 insights.llmKeyFile（同一密钥文件），未配置则走 dsh 凭据
    const insightsRaw = feishuCfg.cfg && feishuCfg.cfg.insights;
    this.insightsKeyFile = (insightsRaw && typeof insightsRaw.llmKeyFile === "string" && insightsRaw.llmKeyFile.trim()) ? insightsRaw.llmKeyFile.trim() : "";
    this.insightsLlmEndpoint = (insightsRaw && typeof insightsRaw.llmEndpoint === "string" && insightsRaw.llmEndpoint.trim()) ? insightsRaw.llmEndpoint.trim() : "";
    this.insightsLlmModel = (insightsRaw && typeof insightsRaw.llmModel === "string" && insightsRaw.llmModel.trim()) ? insightsRaw.llmModel.trim() : "";
    // 事件消息存档脚本（feishu-config scripts.eventIngest；缺失 = 只处理不存档）
    this.eventIngestScript = (feishuCfg.cfg.scripts && feishuCfg.cfg.scripts.eventIngest) || null;
    this.eventIngestProfile = (feishuCfg.cfg && feishuCfg.cfg.profile) || cfg.profile || "";
    this.workspaceRoot = (cfg.workspaceRoot && String(cfg.workspaceRoot).trim())
      ? String(cfg.workspaceRoot).trim().replace(/^~(?=\/|\\)/, process.env.USERPROFILE || process.env.HOME || "")
      : DEFAULT_WORKSPACE_ROOT;
    this.lastError = null;
    this.startedAt = Date.now();
    try { await mkdir(this.workspaceRoot, { recursive: true }); } catch (_) { /* 延迟到会话创建 */ }

    // 私聊（所有人 × 机器人）：启动事件通道实时接收（user 身份无法枚举他人 p2p，
    // bot 也无法列 p2p——飞书隐私限制；唯一途径是应用事件 im.message.receive_v1）
    this.chatNames = new Map();
    for (const cid of cfg.allowChats) this.chatNames.set(cid, cid);
    this.eventRunning = false;
    if (cfg.allowP2p !== false) {
      this.startEventListener();
    }
    // 群名美化：用 user 身份 chat-list 补群名（latest 输出也会带 chat_name，这里只是启动日志友好）
    try {
      const list = await runNodeScript(this.cliPath, ["im", "+chat-list", "--as", "user", "--page-size", "50", "--format", "json"], CLI_TIMEOUT_MS);
      const chats = list && list.data && Array.isArray(list.data.chats) ? list.data.chats : [];
      for (const c of chats) {
        if (c.chat_id && c.name && this.chatNames.has(c.chat_id)) this.chatNames.set(c.chat_id, c.name);
      }
    } catch (_) { /* 群名非必须 */ }

    this.log("info", `[larkbot] 已启用：群 ${cfg.allowChats.length} 个（飞书同步后处理）+ 私聊事件${this.eventRunning ? "监听中" : "未启动"}（回复身份 ${cfg.as || "bot"}）`);
    // 首次启用：游标置为当前，不处理历史存量（只从启用后开始）
    if (!this.lastProcessedAt) {
      this.lastProcessedAt = localMinuteString();
      this.persist();
      this.log("info", `[larkbot] 首次启用：处理游标 = ${this.lastProcessedAt}（历史消息不处理）`);
    }
  }

  stop() {
    this.stopEventListener();
    this.busy.clear();
    this.pending.clear();
    this.handlers.clear();
    const sessions = [...this.chatSessions.values()];
    this.chatSessions.clear();
    for (const s of sessions) {
      if (s && s.dispose) void s.dispose().catch(() => {});
    }
    this.startedAt = null;
  }

  // ---- 事件通道：接收飞书应用的所有 p2p 私聊消息（im.message.receive_v1） ----

  // 启动常驻事件消费进程：lark-cli event consume（bot 身份）；stdout NDJSON 每行一个事件。
  // 子进程契约（lark-event skill）：stderr 出现 ready marker 后开始读 stdout；
  // unbounded 模式 stdin EOF = 优雅退出 → 保持 stdin pipe 打开（不写不关）。
  startEventListener() {
    if (this.eventProc) return;
    const token = ++this.eventToken;
    const runJs = this.cliPath;
    if (!runJs || !existsSync(runJs)) {
      this.lastError = "找不到 lark-cli run.js，无法启动私聊事件监听";
      this.log("error", `[larkbot] ${this.lastError}`);
      return;
    }
    const args = ["event", "consume", "im.message.receive_v1", "--as", this.cfg.as || "bot"];
    if (this.cfg && this.cfg.profile) args.push("--profile", this.cfg.profile);
    this.log("info", `[larkbot] 启动私聊事件监听: lark-cli ${args.slice(0, 3).join(" ")}`);

    let child;
    try {
      child = spawn(process.execPath, [runJs, ...args], {
        env: cleanCliEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      this.lastError = `事件监听 spawn 失败: ${e.message}`;
      this.log("error", `[larkbot] ${this.lastError}`);
      return;
    }
    this.eventProc = child;
    this.eventReady = false;
    this.eventRestartTimer = null;
    this.eventStopping = false;

    child.stdin.on("error", () => { /* 子进程退出后 stdin 关闭的常规错误，忽略 */ });

    // stderr：等待 ready marker；记录诊断；退出原因在此可见
    let errBuf = "";
    child.stderr.on("data", (d) => {
      errBuf += String(d);
      if (!this.eventReady && errBuf.includes("[event] ready event_key=")) {
        this.eventReady = true;
        this.eventRunning = true;
        this.eventRestartDelay = 3000;   // 成功就绪重置退避
        this.log("info", "[larkbot] 私聊事件监听就绪（ready）");
      }
      // 截断防内存膨胀
      if (errBuf.length > 8192) errBuf = errBuf.slice(-8192);
    });

    // stdout：NDJSON 事件行
    let outBuf = "";
    child.stdout.on("data", (d) => {
      outBuf += String(d);
      let nl;
      while ((nl = outBuf.indexOf("\n")) >= 0) {
        const line = outBuf.slice(0, nl).trim();
        outBuf = outBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          void this.handleEvent(evt).catch((e) => {
            this.log("warn", `[larkbot] 事件处理异常: ${e && e.message ? e.message : e}`);
          });
        } catch (e) {
          this.log("warn", `[larkbot] 事件行解析失败: ${clip(line, 120)}`);
        }
      }
    });

    child.on("exit", (code, signal) => {
      if (this.eventToken !== token) return;   // 过期子进程，新监听器已接管，忽略
      this.eventProc = null;
      this.eventRunning = false;
      this.eventReady = false;
      const reason = signal ? `signal(${signal})` : `exit(${code})`;
      if (this.eventStopping) {
        this.log("info", `[larkbot] 私聊事件监听已停止（${reason}）`);
        return;
      }
      this.log("warn", `[larkbot] 私聊事件监听退出（${reason}），将自动重连…`);
      // 快速失败原因（bus 被占 / 缺 scope 等）从 stderr 取
      const tail = errBuf.slice(-400);
      if (/exit\(2\)/.test(reason) || /another event bus|already connected/.test(tail)) {
        this.eventRunning = false;
        this.lastError = "事件总线被其他进程占用（一个应用全局只能一条长连接）。请关闭占用方（如 Qoder 飞书通道）后重载。";
        this.log("error", `[larkbot] ${this.lastError}`);
        return; // 不自动重连占用冲突
      }
      if (/exit\(3\)/.test(reason)) {
        this.eventRunning = false;
        this.lastError = "事件消费缺 scope（im:message.p2p_msg:readonly），请到开发者后台为你的飞书应用开通。";
        this.log("error", `[larkbot] ${this.lastError}`);
        return;
      }
      // 指数退避重连（3s → 6s → 12s → 24s → 上限 60s）
      if (this.eventRestartTimer) clearTimeout(this.eventRestartTimer);
      this.eventRestartTimer = setTimeout(() => {
        this.eventRestartTimer = null;
        if (!this.startedAt) return;
        this.startEventListener();
      }, this.eventRestartDelay);
      this.eventRestartDelay = Math.min(this.eventRestartDelay * 2, 60000);
    });
  }

  stopEventListener() {
    this.eventStopping = true;
    if (this.eventRestartTimer) { clearTimeout(this.eventRestartTimer); this.eventRestartTimer = null; }
    const child = this.eventProc;
    this.eventProc = null;
    this.eventRunning = false;
    if (child) {
      try {
        // 优雅退出：关闭 stdin（EOF → consume 退出）；5s 未退则 SIGTERM
        child.stdin.end();
        const killer = setTimeout(() => {
          try { child.kill("SIGTERM"); } catch (_) { /* noop */ }
        }, 5000);
        killer.unref?.();
        child.once("exit", () => clearTimeout(killer));
      } catch (_) { /* noop */ }
    }
  }

  // 处理一条 receive_v1 事件（p2p 私聊 + 白名单群消息，均实时门控；整点同步仍做兜底）
  async handleEvent(evt) {
    if (!evt) return;
    const chatType = evt.chat_type;
    if (chatType !== "p2p" && chatType !== "group") return;
    if (evt.sender_type === "bot") return;             // 机器人消息（防循环，含自己发的）
    if (evt.message_type !== "text") return;           // MVP 只处理文本
    const mid = String(evt.message_id || evt.id || "");
    if (!mid) return;
    const chatId = String(evt.chat_id || "");
    if (!chatId) return;
    // 群消息只处理白名单内的群；p2p 机器人私聊全收
    if (chatType === "group" && !this.isTargetChat(chatId)) return;
    const seen = this.seenByChat[chatId];
    if (seen && seen.includes(mid)) return;
    if (this.sentMsgIds.includes(mid)) return;
    this.markSeen(chatId, mid);

    const kindLabel = chatType === "p2p" ? "私聊" : "群";
    const m = {
      chat_id: chatId,
      chat_type: chatType,
      message_id: mid,
      message_type: evt.message_type,
      user_id: evt.sender_id || "",
      sender_name: null,
      text: evt.content || "",
      chat_name: this.chatNames.get(chatId) || (chatType === "p2p" ? "私聊" : chatId),
      created_at: evt.create_time ? new Date(Number(evt.create_time)).toISOString().slice(0, 16).replace("T", " ") : "",
    };
    if (!this.chatNames.has(chatId)) {
      this.chatNames.set(chatId, chatType === "p2p" ? "私聊" : chatId);
    }
    this.log("info", `[larkbot] 收到${kindLabel}消息 | chat=${m.chat_name} from=${m.user_id} text=${clip(m.text, 60)}`);

    // 群消息实时路径：先取最近上下文供门控判断（承接/互聊），再入库、再门控分发
    if (chatType === "group") {
      m._gateContext = await this.fetchRecentContext(chatId, mid);
    }

    if (this.eventIngestScript) {
      try {
        const ing = await this.ingestEventMessage(mid, chatType);
        if (ing && ing.sender_name) m.sender_name = ing.sender_name;   // 事件只有 open_id，名字靠 mget 补
      } catch (e) {
        this.log("warn", `[larkbot] 事件消息存档异常（继续处理）: ${e && e.message ? e.message : e}`);
      }
    } else {
      this.log("warn", "[larkbot] 未配置 scripts.eventIngest，事件消息不存档（仅实时处理）");
    }
    await this.onNewMessage(m);
  }

  // 群消息实时路径：从存档库取该会话最近消息，构建门控用上下文（取不到则空，保守降级）
  async fetchRecentContext(chatId, excludeMid) {
    try {
      const latest = await runNodeScript(this.latestScript, ["--per-chat", "50"], LATEST_TIMEOUT_MS);
      if (!latest || !latest.ok) return [];
      const chats = Array.isArray(latest.chats) ? latest.chats : [];
      const chat = chats.find((c) => c && String(c.chat_id) === String(chatId));
      return buildRecentContext(chat, [excludeMid], this.botName);
    } catch (e) {
      this.log("warn", `[larkbot] 取最近上下文失败（门控无上下文继续）: ${e && e.message ? e.message : e}`);
      return [];
    }
  }

  // 调 event-ingest.js 把事件消息补入 msg_metadata（stdout 含项目日志噪声，取末尾 JSON 行）
  async ingestEventMessage(mid, chatMode) {
    const args = ["--message-id", mid, "--chat-mode", chatMode === "group" ? "group" : "p2p"];
    if (this.eventIngestProfile) args.push("--profile", this.eventIngestProfile);
    const raw = await runNodeScript(this.eventIngestScript, args, 60_000);
    let obj = raw;
    if (typeof raw === "string") {
      const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { obj = JSON.parse(lines[i]); break; } catch (_) { /* 找下一个候选行 */ }
      }
    }
    if (!obj || obj.ok !== true) {
      this.log("warn", `[larkbot] 事件消息存档失败: ${mid} ${(obj && obj.error) || ""}`);
      return null;
    }
    this.log("info", `[larkbot] 事件消息已存档: ${mid} status=${obj.status}`);
    return obj;
  }

  // ---- 同步完成后处理（lark.js 调 shared.onFeishuSynced 触发） ----

  async afterSync() {
    if (!this.cfg || !this.startedAt) return;      // 未启用
    if (this.processing) {
      this.log("info", "[larkbot] 上一次处理还在进行，跳过本次触发");
      return;
    }
    this.processing = true;
    this.lastRunAt = new Date();
    let completed = false;
    try {
      completed = await this.runOnce();
    } catch (e) {
      this.log("error", `[larkbot] 处理后处理失败: ${e && e.message ? e.message : e}`);
    } finally {
      this.processing = false;
      // 仅在 latest 读取成功（含 0 候选）时推进游标；读取失败/异常不推进，避免整窗静默丢失
      if (completed) {
        this.lastProcessedAt = localMinuteString();
        this.persist();
      } else {
        this.log("warn", "[larkbot] 本轮未完成（latest 读取失败或异常），游标不推进，下次同步重试");
      }
    }
  }

  // 从存档取「游标后」消息 → 过滤目标会话 → 逐条门控 → 执行
  async runOnce() {
    // 起点 = max(游标, 现在 - 回退余量) 再减余量（latest 分钟精度，seen 去重兜底防漏防重）
    let since;
    if (this.lastProcessedAt) {
      const t = new Date(String(this.lastProcessedAt).replace(" ", "T"));
      since = isNaN(t.getTime())
        ? minuteAgoString(new Date(), CURSOR_BACKOFF_MIN)
        : minuteAgoString(t, CURSOR_BACKOFF_MIN);
    } else {
      since = minuteAgoString(new Date(), CURSOR_BACKOFF_MIN);
    }
    this.log("info", `[larkbot] 处理新消息 | since=${since} | 目标=${this.describeTargets()}`);

    const latest = await runNodeScript(this.latestScript, ["--per-chat", "50", "--since", since], LATEST_TIMEOUT_MS);
    if (!latest || !latest.ok) {
      this.log("warn", `[larkbot] latest.js 读取失败: ${latest && latest.error ? latest.error : "未知"}`);
      return false;
    }
    const chats = Array.isArray(latest.chats) ? latest.chats : [];
    let processed = 0;
    for (const chat of chats) {
      const chatId = chat && chat.chat_id;
      if (!this.isTargetChat(chatId)) continue;    // 群只限白名单；p2p 限机器人会话
      const messages = Array.isArray(chat.messages) ? chat.messages : [];
      // 按时间正序处理
      const fresh = messages
        .filter((m) => this.isCandidate(chat, m))
        .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
      if (fresh.length === 0) continue;
      // 先全部 markSeen（防重入/防漏），并给每条消息算各自的 recent 供会话用
      for (const m of fresh) {
        this.markSeen(chatId, String(m.message_id || ""));
        m._gateContext = buildRecentContext(chat, [m.message_id], this.botName);
      }
      // 批处理门控：这批消息一起过 LLM，整体判断谁该回、谁该跳过（避免逐条孤立误判产生误会）
      let decisions;
      try {
        decisions = await this.gateBatch(chat, fresh);
      } catch (e) {
        // 批门控失败（LLM 异常/解析失败）→ 回退逐条门控，避免整批静默漏回
        this.log("warn", `[larkbot] 批门控失败，回退逐条门控: ${e && e.message ? e.message : e}`);
        for (const m of fresh) {
          await this.onNewMessage(m);
          processed++;
        }
        continue;
      }
      for (let i = 0; i < fresh.length; i++) {
        await this.dispatchGate(fresh[i], decisions[i]);
        processed++;
      }
    }
    this.log("info", `[larkbot] 本次处理完成 | 候选消息=${processed}`);
    return true;
  }

  isTargetChat(chatId) {
    if (!chatId) return false;
    if (Array.isArray(this.cfg.allowChats) && this.cfg.allowChats.includes(chatId)) return true;
    return false;
  }

  describeTargets() {
    const parts = (this.cfg.allowChats || []).map((c) => this.chatNames.get(c) || c);
    return parts.join(", ");
  }

  // 候选过滤：文本、非 app、未处理
  isCandidate(chat, m) {
    const mid = String(m && m.message_id || "");
    if (!mid) return false;
    if (m.msg_type !== "text" && m.message_type !== "text") return false;
    // 机器人/app 消息（user_id 为 cli_* 应用 id；机器人自己的回复也是 cli_ 开头 → 防循环）
    const senderId = String(m.user_id || "");
    if (senderId.startsWith("cli_")) return false;
    const chatId = chat && chat.chat_id;
    const seen = chatId ? this.seenByChat[chatId] : null;
    if (seen && seen.includes(mid)) return false;
    if (this.sentMsgIds.includes(mid)) return false;   // 本助理发过的（双保险）
    return true;
  }

  markSeen(chatId, mid) {
    const list = this.seenByChat[chatId] || [];
    if (!list.includes(mid)) {
      list.push(mid);
      if (list.length > PER_CHAT_SEEN_MAX) list.splice(0, list.length - PER_CHAT_SEEN_MAX);
      this.seenByChat[chatId] = list;
      this.persist();
    }
  }

  persist() {
    saveState({
      decisions: this.decisions,
      seenByChat: this.seenByChat,
      sentMsgIds: this.sentMsgIds.slice(-PER_CHAT_SEEN_MAX),
      lastProcessedAt: this.lastProcessedAt || null,
    });
  }

  // ---- 消息入口：门控 → 执行 ----

  async onNewMessage(m) {
    let gate = null;
    try {
      gate = await this.gate(m);
    } catch (e) {
      this.log("warn", `[larkbot] 门控失败，跳过: ${e && e.message ? e.message : e}`);
      this.pushDecision(m, "gate-error", clip(e && e.message ? e.message : String(e), 120));
      return;
    }
    await this.dispatchGate(m, gate);
  }

  // 按门控决策执行（skip/direct/run）
  async dispatchGate(m, gate) {
    if (!gate || gate.action === "skip") {
      this.pushDecision(m, "skip", gate && gate.reason ? gate.reason : "无需回应");
      return;
    }
    if (gate.action === "direct") {
      // 消极回应：婉拒/闲聊，LLM 直接给出回复文本，不建 dsh 会话
      const replyStr = (gate.reply || "").trim();
      if (!replyStr) {
        this.log("warn", "[larkbot] 门控返回 direct 但 reply 为空，降级 skip");
        this.pushDecision(m, "skip", "direct 文本为空");
        return;
      }
      this.pushDecision(m, "direct", gate.reason || "", clip(replyStr, 80));
      try {
        await this.replyText(m, replyStr);
      } catch (e) {
        this.log("error", `[larkbot] 直接回复失败: ${e && e.message ? e.message : e}`);
        this.pushDecision(m, "reply-error", clip(e && e.message ? e.message : String(e), 120));
      }
      return;
    }
    // action === "run"：积极回应，开 dsh 会话执行（本地知识库问答等）
    this.pushDecision(m, "run", gate.reason || "", null);
    await this.runTurn(m);
  }

  // 门控（批量）：一批消息一起过 LLM，返回与 messages 对齐的 decision 列表。
  // chat 传入 latest.js 的会话对象（含 recent_messages，用来取「这批之前」的最近上下文）。
  async gateBatch(chat, messages) {
    const msgs = Array.isArray(messages) ? messages : [];
    if (msgs.length === 0) return [];
    const context = buildRecentContext(chat, msgs.map((m) => m && m.message_id), this.botName);
    const text = await this.runGateLLM(gateBatchUserText(chat, msgs, context, this.botName));
    const decisions = parseGateBatchJson(text, msgs.length);
    if (!decisions) throw new Error(`门控输出无法解析: ${clip(text, 120)}`);
    return decisions;
  }

  // 门控（单条）：批量的退化形式（p2p 事件通道 / 批处理回退用）
  async gate(m) {
    const context = (m && m._gateContext) || [];
    const text = await this.runGateLLM(gateBatchUserText(null, [m], context, this.botName));
    const decisions = parseGateBatchJson(text, 1);
    if (!decisions) throw new Error(`门控输出无法解析: ${clip(text, 120)}`);
    return decisions[0] || null;
  }

  // 统一门控 LLM 调用：有独立 key 文件走直连，否则走 dsh 模型路由
  async runGateLLM(inputText) {
    const keyFile = this.insightsKeyFile;
    return keyFile
      ? await this.gateLLMWithKeyFile(inputText, keyFile)
      : await this.gateLLMStream(inputText);
  }

  async gateLLMStream(inputText) {
    const llm = this.llm;
    if (!llm || typeof llm.stream !== "function") {
      throw new Error("llm 服务不可用，无法判断是否需要回复");
    }
    const sel = this.resolveModelSelection();
    if (!sel) throw new Error("无可用模型路由");
    return await collectStreamText(
      llm,
      {
        provider: sel.provider,
        model: sel.model,
        messages: [{
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: inputText }],
          source: { kind: "plugin", plugin: "dsh-office-larkbot" },
        }],
        system: readPromptSync("gate-system") ?? GATE_MINIMAL,
        maxTokens: GATE_MAX_TOKENS,
        // 门控是轻量三选一判断，关闭推理思维链：deepseek 推理模型省略时默认 high，
        // 思维链会占满 maxTokens 导致正文（JSON）为空 → "门控输出无法解析"（空）
        reasoningEffort: "off",
      },
      GATE_TIMEOUT_MS,
    );
  }

  resolveModelSelection() {
    if (this.cfg && this.cfg.provider && this.cfg.model) {
      return { provider: this.cfg.provider, model: this.cfg.model };
    }
    const adm = this.agentDefaultModel;
    if (adm && typeof adm.currentSelection === "function") {
      try {
        const sel = adm.currentSelection();
        if (sel && sel.provider && sel.model) return sel;
      } catch (_) { /* fallthrough */ }
    }
    return null;
  }

  // 独立 key 文件门控：读 key + 直连 LLM API（非流式，OpenAI 兼容），不走 dsh 模型路由
  async gateLLMWithKeyFile(inputText, keyFile) {
    let key = "";
    try { key = readFileSync(keyFile, "utf8").trim(); } catch (e) { throw new Error(`读取 llmKeyFile 失败: ${e.message}`); }
    if (!key) throw new Error("llmKeyFile 文件为空");
    const endpoint = this.insightsLlmEndpoint || "https://api.deepseek.com/v1/chat/completions";
    const model = this.insightsLlmModel || "deepseek-chat";
    return await llmChatJson(endpoint, key, model, [
      { role: "system", content: readPromptSync("gate-system") ?? GATE_MINIMAL },
      { role: "user", content: inputText },
    ], GATE_MAX_TOKENS, GATE_TIMEOUT_MS);
  }

  // ---- 执行一轮（会话 busy 防叠 + 排队） ----

  async runTurn(m) {
    const chatId = m && m.chat_id;
    if (this.busy.has(chatId)) {
      const queue = this.pending.get(chatId) || [];
      if (queue.length < (this.cfg.maxPendingPerChat || MAX_PENDING_PER_CHAT)) {
        queue.push(m);
        this.pending.set(chatId, queue);
      }
      return;
    }
    this.busy.add(chatId);
    try {
      await this.runAgentTurn(m);
    } catch (e) {
      this.log("error", `[larkbot] turn 失败: ${e && e.message ? e.message : e}`);
      this.pushDecision(m, "reply-error", clip(e && e.message ? e.message : String(e), 120));
      try { await this.replyText(m, `⚠️ 处理失败：${clip(e && e.message ? e.message : String(e), 300)}`); }
      catch (_) { /* 回复失败不阻塞 */ }
    } finally {
      this.busy.delete(chatId);
      const queue = this.pending.get(chatId);
      const next = queue && queue.shift();
      if (queue && queue.length === 0) this.pending.delete(chatId);
      // 出队直接执行回合，不再走 onNewMessage 重过门控（决策早已是 run；重门控会因上下文
      // 变化误判 skip 而漏回，还会重复记一次决策）
      if (next) void this.runTurn(next).catch(() => {});
    }
  }

  async runAgentTurn(m) {
    const chatId = m.chat_id;
    const cwd = await resolveChatWorkspace(this.workspaceRoot, chatId);
    const session = await this.ensureSession(chatId, cwd);
    const prompt = buildBridgePrompt(m);

    let buffer = "";
    let finalText = "";
    let failReason = null;
    let settled = false;
    const waiter = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("回合等待超时"));
      }, TURN_WAIT_TIMEOUT_MS);
      this.handlers.set(session.sessionId, (event) => {
        if (settled) return;
        switch (event.type) {
          case "text": buffer += event.delta; break;
          case "final_text":
            if (buffer.length === 0) buffer = event.content;
            finalText = event.content || "";
            break;
          case "done":
            settled = true;
            clearTimeout(timer);
            if (event.reason && typeof event.reason === "string" && event.reason.includes("error")) {
              failReason = event.reason;
            }
            resolve();
            break;
          case "error":
            settled = true;
            clearTimeout(timer);
            failReason = event.message || "回合出错";
            resolve();
            break;
          default: break;
        }
      });
    });

    try {
      session.send(prompt);
      await waiter;
      if (failReason) {
        this.log("warn", `[larkbot] 回合失败: ${clip(failReason, 200)}`);
        throw new Error(failReason);
      }
      const replyText = (finalText || buffer || "").trim();
      if (!replyText) {
        this.log("warn", "[larkbot] 回合结束但无文本输出");
        return;
      }
      // 兜底门控：会话结合上下文判断这条消息其实不需要回复 → 输出 <no_reply>，跳过发送
      // （门控是轻量模型，run 后由会话再做一次终判，避免多余回复）
      if (/^\s*<no_reply>\s*$/i.test(replyText)) {
        this.log("info", "[larkbot] 会话兜底门控：无需回复，跳过发送");
        this.pushDecision(m, "skip", "会话兜底：无需回复");
        return;
      }
      // 多问分开回：按 --- 分隔符拆成多条，逐条发出（单条消息，避免一条塞完）
      for (const part of splitReplies(replyText)) {
        await this.replyText(m, part);
      }
      this.pushDecision(m, "replied", "", clip(replyText, 80));
    } finally {
      this.handlers.delete(session.sessionId);
    }
  }

  // 经 lark-cli 回复原消息（markdown；超长截断；记录发出 message_id 防自触发）
  async replyText(m, text) {
    const max = (this.cfg && this.cfg.replyMaxChars) || REPLY_MAX_CHARS;
    const body = text.length > max ? text.slice(0, max) + "\n\n…（内容过长已截断，完整内容在会话里）" : text;
    const args = ["im", "+messages-reply", "--message-id", String(m.message_id),
      "--markdown", body, "--as", this.cfg.as || "bot", "--format", "json"];
    if (this.cfg && this.cfg.profile) args.push("--profile", this.cfg.profile);
    const result = await runNodeScript(this.cliPath, args, CLI_TIMEOUT_MS);
    const mid = result && result.data && result.data.message_id;
    if (mid) {
      this.sentMsgIds.push(String(mid));
      if (this.sentMsgIds.length > PER_CHAT_SEEN_MAX) this.sentMsgIds.splice(0, this.sentMsgIds.length - PER_CHAT_SEEN_MAX);
      this.persist();
    }
  }

  // ---- 一群/一私聊一长会话 ----

  async ensureSession(chatId, cwd) {
    const existing = this.chatSessions.get(chatId);
    if (existing) return existing;

    const baseId = SESSION_ID_PREFIX + safeChatName(chatId);
    // 归属 workspace（分组）：一群一项目空间，path = cwd（目录已由 resolveChatWorkspace mkdir）
    let workspace = null;
    const registry = this.workspaceRegistry;
    // 判断会话是否「还在」：被归档的会话在 dsh 里不显示，不复用，改用新代际 id 新建（对齐轮询插件的重建机制）
    let sessionId = baseId;
    try {
      const archived = registry && registry.archivedSessionIds;
      if (Array.isArray(archived)) {
        let gen = 0;
        while (archived.includes(sessionId)) {
          gen += 1;
          sessionId = `${baseId}-${gen}`;
        }
        if (sessionId !== baseId) {
          this.log("info", `[larkbot] 会话 ${baseId} 已被归档，改用新会话 ${sessionId}`);
        }
      }
    } catch (_) { /* workspace registry 未就绪，按未归档处理 */ }
    if (registry && typeof registry.create === "function") {
      try {
        workspace = await registry.create(cwd, this.chatNames.get(chatId) || undefined);
      } catch (e) {
        this.log("warn", `[larkbot] 创建 workspace 失败: ${e && e.message ? e.message : e}`);
      }
    }
    const agents = this.agents;
    if (!agents || typeof agents.create !== "function") {
      throw new Error("agents 服务不可用，无法创建会话");
    }
    const sel = this.resolveModelSelection();
    const agentOptions = sel ? { provider: sel.provider, model: sel.model } : {};
    const preset = this.cfg && this.cfg.agentPreset ? this.cfg.agentPreset : undefined;
    const setup = async (agentCtx) => {
      if (sel) installModelSelection(agentCtx, sel);
      try {
        const sys = agentCtx && agentCtx.systemPrompt;
        if (sys && typeof sys.section === "function") {
          const protocolPrompt = readPromptSync("bridge-protocol");
          if (protocolPrompt) sys.section({ name: "office-larkbot:protocol", order: -50, text: protocolPrompt });
          const kbPrompt = buildKbPrompt(this.cfg && this.cfg.kbPaths);
          if (kbPrompt) sys.section({ name: "office-larkbot:kb", order: -40, text: kbPrompt });
          const replyStylePrompt = readPromptSync("reply-style");
          if (replyStylePrompt) sys.section({ name: "office-larkbot:reply-style", order: -30, text: replyStylePrompt });
        }
      } catch (e) {
        this.log("warn", `[larkbot] 挂载提示段失败: ${e && e.message ? e.message : e}`);
      }
      await mountPresetFailClosed(this.agentPresets, agentCtx, preset);
    };

    let persisted = null;
    const persistence = this.sessionPersistence;
    if (persistence && typeof persistence.list === "function") {
      try {
        const list = await persistence.list();
        if (Array.isArray(list)) {
          persisted = list.find((h) => h && String(h.id) === sessionId) || null;
        }
      } catch (_) { /* 视为无持久化 */ }
    }

    let handle;
    try {
      handle = persisted
        ? await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
        : await agents.create({ sessionId, meta: { cwd }, agentOptions, setup });
    } catch (err) {
      const live = typeof agents.get === "function" ? agents.get(sessionId) : null;
      if (!live) throw err;
      handle = {
        agent: { id: sessionId, followup: (mm) => live.followup(mm), whenIdle: async () => {} },
        dispose: async () => {},
      };
    }
    try { await handle.agent.whenIdle(); } catch (_) { /* 忽略 */ }

    const key = String(handle.agent.id);
    // 归属到 workspace（session.header.cwd 需匹配 workspace path；失败仅告警，不阻断会话）
    if (workspace && typeof workspace.attachSession === "function") {
      try {
        await workspace.attachSession(key);
      } catch (e) {
        this.log("warn", `[larkbot] 会话归属 workspace 失败: ${e && e.message ? e.message : e}`);
      }
    }
    const session = {
      sessionId: key,
      send: (text) => {
        const live = (typeof agents.get === "function" && agents.get(key)) || handle.agent;
        live.followup({
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text }],
          source: { kind: "user" },
        });
      },
      dispose: async () => {
        try { await handle.dispose(); } catch (_) { /* noop */ }
      },
    };
    this.chatSessions.set(chatId, session);
    return session;
  }

  // ---- 决策日志 ----

  pushDecision(m, decision, reason, replyPreview) {
    const chatId = m && m.chat_id;
    const entry = {
      at: new Date().toISOString(),
      chatId,
      chatName: (chatId && this.chatNames.get(chatId)) || (m && m.chat_name) || null,
      sender: m && (m.sender_name || m.user_id),
      text: clip(m && m.text, 120),
      decision,
      reason: reason || "",
      replyPreview: replyPreview || "",
    };
    this.decisions.unshift(entry);
    if (this.decisions.length > DECISIONS_MAX) this.decisions.length = DECISIONS_MAX;
    this.persist();
  }

  // ---- 状态快照 ----

  status() {
    const cur = loadConfig();
    const cfgOk = cur.ok;
    const cfg = cur.ok ? cur.cfg : null;
    return {
      configured: cfgOk,
      configError: cfgOk ? null : cur.error.message,
      enabled: cfgOk ? !!cfg.enabled : false,
      running: !!this.startedAt,
      lastError: this.lastError,
      startedAt: this.startedAt,
      lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
      lastProcessedAt: this.lastProcessedAt,
      chatCount: cfg && Array.isArray(cfg.allowChats) ? cfg.allowChats.length : 0,
      allowP2p: cfg ? cfg.allowP2p !== false : false,
      p2pEventReady: !!this.eventReady,
      p2pEventRunning: !!this.eventProc,
      activeSessions: this.chatSessions.size,
      busyCount: this.busy.size,
      pendingCount: [...this.pending.values()].reduce((n, q) => n + q.length, 0),
      workspaceRoot: this.workspaceRoot || null,
      cliPath: this.cliPath || null,
      decisionsCount: this.decisions.length,
      identity: cfg ? (cfg.as || "bot") : null,
      hookMode: true,
    };
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

// 直连 LLM API（OpenAI 兼容 /chat/completions，非流式），供独立 key 文件场景使用
async function llmChatJson(endpoint, apiKey, model, messages, maxTokens, timeoutMs) {
  const urlObj = new URL(endpoint);
  const body = JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens });
  const resp = await httpsPostJson(urlObj, {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  }, body, timeoutMs);
  const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
  if (!content) throw new Error("LLM 无输出");
  return content;
}

function httpsPostJson(urlObj, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`LLM HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("LLM 响应非 JSON")); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("LLM 请求超时")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function collectStreamText(llm, options, timeoutMs) {
  let out = "";
  let timer = null;
  try {
    await Promise.race([
      (async () => {
        for await (const chunk of llm.stream(options)) {
          if (chunk && chunk.type === "text-delta") out += chunk.text || "";
          if (chunk && chunk.type === "finish") break;
        }
      })(),
      new Promise((_, reject) => {
        if (timeoutMs) timer = setTimeout(() => reject(new Error("门控超时")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return out.trim();
}

async function mountPresetFailClosed(presets, agentCtx, preset) {
  if (!presets) {
    if (preset !== undefined) {
      throw new Error(`无法挂载 preset ${JSON.stringify(preset)}：agentPresets 服务不可用`);
    }
    return;
  }
  try {
    await presets.mount(agentCtx, preset);
  } catch (cause) {
    if (preset === undefined) throw cause;
    throw new Error(`preset ${JSON.stringify(preset)} 不可用，拒绝降级到默认 preset`, { cause });
  }
}

function installModelSelection(agentCtx, selection) {
  const ctx = agentCtx;
  const onAssemble = async (_assembly, _context, next) => {
    const assembled = await next();
    return {
      ...assembled,
      variables: {
        ...(assembled.variables || {}),
        provider: selection.provider,
        model: selection.model,
      },
    };
  };
  const onRequest = async (_payload, next) => {
    const resolved = await next();
    const { reasoningEffort: _inh, ...rest } = resolved || {};
    return {
      ...rest,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    };
  };
  ctx.on("system-prompt/assemble", onAssemble);
  ctx.on("agent/request", onRequest);
}

function translateSessionEvent(event) {
  if (typeof event !== "object" || event === null) return undefined;
  const e = event;
  switch (e.type) {
    case "assistant/chunk": {
      const chunk = e.data && e.data.chunk;
      if (!chunk || typeof chunk !== "object") return undefined;
      if (chunk.type === "text-delta") return { type: "text", delta: chunk.text || "" };
      return undefined;
    }
    case "assistant/message": {
      const message = e.data && e.data.message;
      return { type: "final_text", content: extractText(message && message.content) };
    }
    case "turn/end": {
      const reason = e.data && e.data.reason;
      const asText = reason && typeof reason === "object" ? JSON.stringify(reason) : String(reason || "normal");
      return { type: "done", reason: asText };
    }
    default:
      return undefined;
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      // 只取 text 块；reasoning 块形如 { type:"reasoning", text }，是思考过程，不应进最终回复
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

// ---------------------------------------------------------------------------
// register(runtime)
// ---------------------------------------------------------------------------

export function register(runtime) {
  const { ctx, shared } = runtime;
  const { sendJson, sendJsonForbidden, readJsonBody, errMsg } = shared;

  const service = new LarkBotService(runtime);

  // 挂接飞书同步完成钩子（lark.js triggerFeishuSync 同步入库后调用）
  shared.onFeishuSynced = () => {
    void service.afterSync().catch((e) => {
      ctx.logger?.warn?.("[larkbot] afterSync 异常:", e);
    });
  };
  ctx.effect(() => () => {
    if (shared.onFeishuSynced) shared.onFeishuSynced = null;
    service.dispose();
  }, "office: larkbot lifecycle");

  const loaded = loadConfig();
  if (loaded.ok && loaded.cfg.enabled) {
    void service.start().catch((e) => {
      ctx.logger?.warn?.("[larkbot] 自动启动失败:", e);
    });
  }
  if (loaded.ok && !loaded.cfg.enabled) {
    service.log("info", "[larkbot] 已注册（enabled=false，等待面板开启）");
  }

  const routes = {
    "/office-ui/larkbot/status": async (req, res) => {
      if (!isLoopback(req.socket.remoteAddress)) return sendJsonForbidden(res);
      sendJson(res, { ok: true, data: service.status() });
    },
    "/office-ui/larkbot/enable": async (req, res) => {
      if (!isLoopback(req.socket.remoteAddress)) return sendJsonForbidden(res);
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, { ok: false, error: { code: 1, message: errMsg(e) } }); }
      if (body && typeof body.enabled === "boolean") {
        const saved = saveEnabled(body.enabled);
        if (!saved.ok) return sendJson(res, saved);
        if (body.enabled) await service.start();
        else service.stop();
        return sendJson(res, { ok: true, data: service.status() });
      }
      return sendJson(res, { ok: false, error: { code: 1, message: "缺少 enabled 字段" } });
    },
    "/office-ui/larkbot/reload": async (req, res) => {
      if (!isLoopback(req.socket.remoteAddress)) return sendJsonForbidden(res);
      service.stop();
      await service.start();
      sendJson(res, { ok: true, data: service.status() });
    },
    "/office-ui/larkbot/decisions": async (req, res) => {
      if (!isLoopback(req.socket.remoteAddress)) return sendJsonForbidden(res);
      sendJson(res, { ok: true, data: { decisions: service.decisions.slice(0, 50) } });
    },
    "/office-ui/larkbot/config": async (req, res) => {
      if (!isLoopback(req.socket.remoteAddress)) return sendJsonForbidden(res);
      const cur = loadConfig();
      if (!cur.ok) return sendJson(res, cur);
      sendJson(res, { ok: true, data: { configPath: LARKBOT_CONFIG_PATH, cfg: { ...cur.cfg } } });
    },
    // 手动触发一次处理（面板/调试用：模拟一次同步后处理）
    "/office-ui/larkbot/run-now": async (req, res) => {
      if (!isLoopback(req.socket.remoteAddress)) return sendJsonForbidden(res);
      if (!service.startedAt) {
        return sendJson(res, { ok: false, error: { code: 1, message: "未启用，请先点「启用」" } });
      }
      void service.afterSync();
      sendJson(res, { ok: true, data: { started: true } });
    },
  };

  return { routes };
}

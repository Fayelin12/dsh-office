import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile, copyFile, rename, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";

export const name = "office";
export const inject = [
  "webServer",
  "workspaceRegistry",
  "sessions",
  "agents",
  "sessionQuery",
  "sessionPersistence",
  "sessionProjections",
  "sessionProjectionCache",
  "tokenMeter"
];

// 静态资源（随包走，只读）+ 运行时数据（用户 dsh home，可写）
// 不 import dsh-home-paths：file: 安装时其 peer 依赖解析可能失败，导致 Host 半整体加载失败
const DSH_HOME = (process.env.DSH_HOME && String(process.env.DSH_HOME).trim()) || join(homedir(), ".dsh");
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const DATA_DIR = join(DSH_HOME, "office");
const HTML_PATH = join(ASSETS_DIR, "office.html");
const BUBBLE_TEXTS_PATH = join(ASSETS_DIR, "bubble-texts.json");
const CONFIG_PATH = join(DATA_DIR, "office-config.json");
const TOKEN_USAGE_PATH = join(DATA_DIR, "token-usage.json");
const TITLE_CACHE_PATH = join(DATA_DIR, "title-cache.json");

// P1-2: cache size caps to prevent unbounded memory growth
const MAX_TOKEN_CACHE = 500;
const MAX_TITLE_CACHE = 500;
const MAX_TOKEN_DISK_ENTRIES = 1000;
const MAX_TITLE_DISK_ENTRIES = 1000;

// P2-6: magic number constants
const BODY_LIMIT_1MB = 1_048_576;
const BODY_LIMIT_2MB = 2_097_152;
const AGENTLY_TIMEOUT_MS = 60_000;
const COLD_SUBAGENT_THROTTLE_MS = 30_000;

/* ── 补充常量 ── */
const WEBSERVER_RETRY_DELAY_MS = 2000;
const NPM_PREFIX_TIMEOUT_MS = 10000;
const AGENTLY_RETRY_DELAY_MS = 600;
const MAX_BUFFER_16MB = 16 * 1024 * 1024;
const COLD_SNAPSHOT_TIMEOUT_MS = 15000;
const CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 3000;
const COLD_READ_BATCH_SIZE = 5;
const BG_REFRESH_MAX_FAIL_COUNT = 5;
const BG_REFRESH_WARN_THRESHOLD = 3;
const UPCOMING_MEETING_WINDOW_MIN = 120;
const ONGOING_MEETING_GRACE_MIN = -60;
const CALENDAR_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const NEXT_SYNC_MIN_DELAY_MS = 1000;
const MESSAGE_ID_MAX_LENGTH = 200;
const MAIL_LIST_DEFAULT_LIMIT = 20;
const MAIL_LIST_MAX_LIMIT = 50;
const FEISHU_PER_CHAT_DEFAULT_LIMIT = 20;
const FEISHU_PER_CHAT_MAX_LIMIT = 50;
const MENTION_SNIPPET_LENGTH = 40;
const LAYOUT_COLUMN_COUNT = 6;
const RECENT_TOOL_NAMES_LIMIT = 3;
const SESSION_ID_PREFIX_LENGTH = 6;
const FEISHU_MANUAL_WINDOW_DAYS_DEFAULT = 30;
const FEISHU_AUTOSYNC_INTERVAL_MIN_DEFAULT = 30;
const FEISHU_AUTOSYNC_INTERVAL_MIN_MIN = 5;
const FEISHU_AUTOSYNC_INTERVAL_MIN_MAX = 1440;
const FEISHU_MANUAL_WINDOW_DAYS_MIN = 1;
const FEISHU_MANUAL_WINDOW_DAYS_MAX = 90;
const STDERR_LOG_SLICE_LENGTH = 300;

/* 办公室日志（内存环形缓冲，供 /office-ui/logs 实时查看） */
const OFFICE_LOG_MAX = 500;
const OFFICE_LOG_LEVELS = new Set(['info', 'warn', 'error']);

/* 逐字稿（transcript） */
const TRANSCRIPTS_DIR = join(DATA_DIR, "transcripts");
const TRANSCRIPTS_STATE_PATH = join(DATA_DIR, "transcripts-state.json");
const TRANSCRIPT_TIMEOUT_MS = 120 * 1000;
const TRANSCRIPT_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const TRANSCRIPT_BATCH_MAX = 2;
const PERMISSION_TIMEOUT_MS = 30 * 1000;

/* Content-Type */
const CT_JSON = 'application/json; charset=utf-8';
const CT_TEXT = 'text/plain; charset=utf-8';
const CT_HTML = 'text/html; charset=utf-8';
const CT_BINARY = 'application/octet-stream';
const CACHE_NO_STORE = 'no-store';
const CACHE_PUBLIC_1H = 'public, max-age=3600';

/* 重复字符串 */
const FEISHU_CONFIG_PATH_DISPLAY = '~/.dsh/office/feishu-config.json';
const URL_PARSE_BASE = 'http://localhost';
const DEFAULT_SESSION_TITLE_PREFIX = '会话 ';
const MAIL_DIRS_ALLOWED = ['inbox', 'sent', 'trash', 'spam'];

/* CLI 错误码 */
const CLI_ERROR_TRANSIENT = 1;
const CLI_ERROR_AUTH_REQUIRED = 3;
const CLI_ERROR_LOCAL_NETWORK = 4;

/* 瞬态网络错误 */
const TRANSIENT_ERROR_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']);

function sendForbidden(res) {
  res.writeHead(403, { 'content-type': CT_TEXT });
  res.end('forbidden');
}

// Extract [id, parentSession] pair from session entries with varying shapes:
// - sessionQuery records: { header: { id, parentSession } }
// - live sessions: { id, header: { parentSession } }
function extractParentEntry(entry) {
  const h = entry.header || entry;
  const id = entry.id != null ? entry.id : h.id;
  const ps = h.parentSession;
  if (id != null && ps != null) {
    return [String(id), String(ps)];
  }
  return null;
}

// P1-2: LRU eviction — delete oldest entries when cache exceeds max size
function evictOldest(map, max) {
  while (map.size > max) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    map.delete(firstKey);
  }
}

// ============================================================
// Agent Mail（agently-cli）集成：面板「邮箱」页签
// 直接以 Node 执行 CLI 入口（不经 cmd 外壳），规避注入与 .cmd 兼容问题
// ============================================================
const AGENTLY_PKG = "@tencent-qqmail/agently-cli";
const AGENTLY_ENTRY_REL = ["scripts", "run.js"];

function isLoopback(remoteAddr) {
  return remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
}

// 高频只读轮询路径：不记请求日志（避免 3 秒轮询刷屏）
// 含 /office-ui/logs：日志 tab 自身 2.5 秒轮询，若不过滤会把真实动作日志挤出缓冲
const HIGH_FREQ_READ_PATHS = new Set([
  "/office-ui/data",
  "/office-ui/health",
  "/office-ui/bubble-texts",
  "/office-ui/logs"
]);

function isHighFreqReadPath(pathname) {
  return HIGH_FREQ_READ_PATHS.has(pathname) || pathname.startsWith("/office-ui/assets/");
}

export async function apply(ctx, _config = {}) {
  // ---------- 办公室日志（内存环形缓冲 + ctx.logger 包装） ----------
  // 记录加载/调用/同步等全部动作，供 GET /office-ui/logs 实时查看
  const officeLogs = [];

  // 日志时间戳：24 小时制 HH:MM:SS（复用 localTimeString 的补零思路）
  function logTimeString(d) {
    const dt = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds());
  }

  // 追加一条日志；仅保留 info/warn/error 三种 level，超出容量丢弃最旧
  function appendOfficeLog(level, msg) {
    if (!OFFICE_LOG_LEVELS.has(level)) return;
    officeLogs.push({ t: logTimeString(), level, msg: String(msg) });
    if (officeLogs.length > OFFICE_LOG_MAX) officeLogs.shift();
  }

  // 参数转字符串：对象 JSON.stringify（失败降级 String），其余 String
  function officeLogArg(a) {
    if (typeof a === "object" && a !== null) {
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }
    return String(a);
  }

  // 包装 ctx.logger：info/warn/error 调用原方法的同时写入内存日志
  // 在 ctx.effect 注册清理，dispose 时恢复原方法，防止泄漏
  const _origLogger = {
    info: ctx.logger.info,
    warn: ctx.logger.warn,
    error: ctx.logger.error
  };
  function wrapLogger(level) {
    return function (...args) {
      try { _origLogger[level].apply(ctx.logger, args); } catch (_) {}
      try { appendOfficeLog(level, args.map(officeLogArg).join(" ")); } catch (_) {}
    };
  }
  ctx.logger.info = wrapLogger('info');
  ctx.logger.warn = wrapLogger('warn');
  ctx.logger.error = wrapLogger('error');
  ctx.effect(() => () => {
    ctx.logger.info = _origLogger.info;
    ctx.logger.warn = _origLogger.warn;
    ctx.logger.error = _origLogger.error;
  }, "office: logger wrapper");

  let webServer = ctx.get("webServer");
  if (webServer === undefined) {
    ctx.logger.warn("[office] webServer 服务不可用，等待 2 秒后重试...");
    await new Promise(r => setTimeout(r, WEBSERVER_RETRY_DELAY_MS));
    webServer = ctx.get("webServer");
    if (webServer === undefined) {
      ctx.logger.warn("[office] webServer 仍不可用，跳过路由注册");
      return;
    }
  }

  const workspaceRegistry = ctx.get("workspaceRegistry");
  const sessionQuery = ctx.get("sessionQuery");
  const agents = ctx.get("agents");
  const sessionsSvc = ctx.get("sessions");
  const tokenMeter = ctx.get("tokenMeter");
  const sessionProjections = ctx.get("sessionProjections");
  const projectionCache = ctx.get("sessionProjectionCache");
  const sessionPersistence = ctx.get("sessionPersistence");
  const connection = ctx.get("connection");

  function errMsg(e) { return e && e.message ? e.message : String(e); }
  async function ensureDataDir() { await mkdir(DATA_DIR, { recursive: true }); }

  let _agentlyEntry = null;
  function resolveAgentlyEntry() {
    if (_agentlyEntry) return _agentlyEntry;
    const candidates = [];
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "npm", "node_modules", AGENTLY_PKG));
    if (process.env.npm_config_prefix) candidates.push(join(process.env.npm_config_prefix, "node_modules", AGENTLY_PKG));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "npm", "node_modules", AGENTLY_PKG));
    try {
      const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", windowsHide: true, timeout: NPM_PREFIX_TIMEOUT_MS }).trim();
      if (prefix) candidates.push(join(prefix, "node_modules", AGENTLY_PKG));
    } catch (e) { ctx.logger.warn('[office][mail] npm prefix -g failed:', e && e.message || e); }
    for (const base of candidates) {
      const entry = join(base, ...AGENTLY_ENTRY_REL);
      if (existsSync(entry)) {
        _agentlyEntry = entry;
        return entry;
      }
    }
    ctx.logger.error('[office][mail] agently-cli not found in any candidate path');
    _agentlyEntry = "";
    return "";
  }

  // 执行 agently-cli：resolve CLI 的 JSON envelope（{ok, data|error}）
  // opts.retries：瞬时故障（exit 1/4、DNS 解析失败等）自动重试次数，默认 0。
  // 写操作（send/reply）不传 retries，避免"已发送但响应丢失"时重复发送。
  function runAgently(args, opts = {}) {
    const maxAttempts = 1 + (opts.retries || 0);
    const delayMs = opts.delayMs || AGENTLY_RETRY_DELAY_MS;
    return new Promise((resolve) => {
      const attempt = (n) => {
        ctx.logger.info('[office][mail] CLI call:', args.join(' '), '(attempt', n + ')');
        const onDone = (error, stdout, stderr) => {
          let parsed = null;
          try {
            const text = String(stdout || "").trim();
            if (text) parsed = JSON.parse(text);
          } catch (e) { parsed = null; }
          // 瞬时故障判定：CLI 业务码 1/4（网络抖动/本地网络），或底层网络错误
          const transient = (() => {
            if (parsed && typeof parsed === "object") {
              const code = parsed.error && parsed.error.code;
              return !parsed.ok && (code === CLI_ERROR_TRANSIENT || code === CLI_ERROR_LOCAL_NETWORK);
            }
            if (error) {
              const c = error.code;
              return c === CLI_ERROR_TRANSIENT || c === CLI_ERROR_LOCAL_NETWORK || TRANSIENT_ERROR_CODES.has(c);
            }
            return false;
          })();
          if (transient && n < maxAttempts) {
            ctx.logger.info('[office][mail] retrying in', delayMs + 'ms...');
            setTimeout(() => attempt(n + 1), delayMs);
            return;
          }
          if (parsed && typeof parsed === "object") {
            if (!parsed.ok) {
              ctx.logger.warn('[office][mail] CLI error:', JSON.stringify(parsed.error), '| args:', args.join(' '));
            }
            resolve(parsed);
            return;
          }
          ctx.logger.error('[office][mail] CLI no JSON output:', (error && error.message ? error.message : "") + (stderr ? (error ? " | " : "") + String(stderr).trim() : ""), '| args:', args.join(' '));
          const detail = (error && error.message ? error.message : "") +
            (stderr ? (error ? " | " : "") + String(stderr).trim() : "");
          resolve({ ok: false, error: { code: (error && error.code) || CLI_ERROR_TRANSIENT, message: detail || "agently-cli 无输出" } });
        };
        const entry = resolveAgentlyEntry();
        const common = { timeout: opts.timeout || AGENTLY_TIMEOUT_MS, maxBuffer: MAX_BUFFER_16MB, windowsHide: true };
        if (entry) {
          execFile(process.execPath, [entry, ...args], common, onDone);
        } else {
          // 不再 fallback 到 exec（命令注入风险），直接报错
          onDone(new Error("agently-cli not found"), "", "");
        }
      };
      attempt(1);
    });
  }

  // 异步预热 CLI 入口探测
  setTimeout(() => resolveAgentlyEntry(), 0);

  const assignments = {};
  let configLoaded = false;
  let pendingOpenSession = null;
  let pendingSessions = new Set();
  let _cleanupInterval = null;
  let feishuNotice = null;   // 定时同步后检测到「提到我」的悬浮提示（{at,count,chat,keyword}）

  // 轻量错误/健康追踪：捕获最近一次错误，供 /office-ui/health 检查
  let lastError = null;
  let lastErrorAt = null;
  function setError(msg) {
    lastError = msg;
    lastErrorAt = Date.now();
    ctx.logger.error("[office]", msg);
  }

  // Client → Host RPC：面板内点会话跳转（consume-open）+ 待确认徽标同步（set-pending）
  ctx.effect(() => {
    if (connection && connection.rpc && typeof connection.rpc.handle === "function") {
      return connection.rpc.handle("/office", async (endpoint, payload) => {
        if (endpoint === "consume-open") {
          const id = pendingOpenSession;
          pendingOpenSession = null;
          if (id) markDataDirty();
          return { ok: true, value: id };
        }
        if (endpoint === "set-pending") {
          pendingSessions = new Set((payload && payload.ids) || []);
          markDataDirty();
          return { ok: true, value: null };
        }
        if (endpoint === "feishu-notice") {
          // 悬浮按钮「📢 飞书收到@你的消息」提示（定时同步后扫描到提及）
          const n = feishuNotice;
          return { ok: true, value: n ? { at: n.at, count: n.count, chat: n.chat, keyword: n.keyword, sender: n.sender, snippet: n.snippet } : null };
        }
        if (endpoint === "calendar-notice") {
          // ⏰ 会议提醒：缓存过期则惰性补拉一次，然后返回「未来 2 小时内开始的会议」
          const cfg = loadFeishuConfig();
          if (cfg && cfg.calendar && (calendarEvents == null || calendarCacheStale())) {
            await syncCalendar(cfg);
          }
          const upcoming = upcomingMeetings(calendarEvents, UPCOMING_MEETING_WINDOW_MIN);
          return { ok: true, value: upcoming.length ? {
            fetchedAt: _calendarFetchedAt,
            meetings: upcoming
          } : null };
        }
        return { ok: false, error: { code: "not_found", message: `unknown office endpoint "${endpoint}"` } };
      }, { authority: "loopback" });
    }
    return () => {};
  }, "office: rpc channel");

  async function ensureConfig() {
    if (configLoaded) return;
    configLoaded = true;
    try {
      const txt = await readFile(CONFIG_PATH, "utf8");
      const parsed = JSON.parse(txt);
      if (parsed && parsed.assignments && typeof parsed.assignments === "object") {
        Object.assign(assignments, parsed.assignments);
      }
    } catch (e) { console.warn('[office]', e?.message || e); }
  }

  // P1-6: serialize config writes to prevent race conditions
  let _saveConfigChain = Promise.resolve();
  async function saveConfig() {
    _saveConfigChain = _saveConfigChain.then(async () => {
      try {
        await ensureDataDir();
        await writeFile(CONFIG_PATH, JSON.stringify({ assignments }), "utf8");
      } catch (e) { console.warn('[office] saveConfig failed:', e?.message || e); }
    });
    await _saveConfigChain;
  }

  function singleInputTokens(session) {
    if (!tokenMeter || !session) return null;
    try {
      const m = tokenMeter.measure(session);
      const b = m && m.baseline;
      if (b && b.kind === "usage" && b.usage) {
        return (b.usage.inputTokens || 0) + (b.usage.cacheReadTokens || 0) + (b.usage.cacheWriteTokens || 0);
      }
    } catch (e) { console.warn('[office]', e?.message || e); }
    return null;
  }

  // 累计 token（未缓存输入 + 输出 + 缓存读 + 缓存写）
  function tokenUsageTotal(usage) {
    if (!usage) return 0;
    return (usage.uncachedInputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
  }

  // A3: generic cache file loader (read JSON → populate Map → evict oldest)
  async function loadCacheFile(path, map, maxEntries) {
    try {
      const raw = await readFile(path, "utf8");
      const obj = JSON.parse(raw);
      for (const k of Object.keys(obj)) {
        map.set(k, obj[k]);
      }
      evictOldest(map, maxEntries);
    } catch (_) { /* file may not exist yet */ }
  }

  // token 累计缓存：历史/归档会话冷读结果持久化到 json，active 会话实时快照
  const tokenCache = new Map();
  let tokenCacheLoaded = false;

  async function loadTokenCache() {
    if (tokenCacheLoaded) return;
    tokenCacheLoaded = true;
    await loadCacheFile(TOKEN_USAGE_PATH, tokenCache, MAX_TOKEN_CACHE);
    // P1-2: periodic cleanup — remove entries for sessions that no longer exist
    _cleanupInterval = setInterval(() => {
      if (tokenCache.size === 0 && titleCache.size === 0) return;
      (async () => {
        const knownIds = new Set();
        // 用 sessionQuery.listSessions() 获取完整列表（含持久化），比 sessionsSvc.list() 更全
        if (sessionQuery && typeof sessionQuery.listSessions === "function") {
          try {
            const records = await sessionQuery.listSessions();
            for (const rec of records) {
              const h = rec && rec.header;
              if (h && h.id != null) knownIds.add(String(h.id));
            }
          } catch (e) { /* ignore */ }
        } else if (sessionsSvc && typeof sessionsSvc.list === "function") {
          // fallback
          try {
            for (const s of sessionsSvc.list()) {
              if (s && s.id != null) knownIds.add(String(s.id));
            }
          } catch (e) { /* ignore */ }
        }
        // 如果获取列表失败（knownIds 为空），不清理任何缓存（保护性跳过）
        if (knownIds.size === 0) return;
        for (const k of tokenCache.keys()) {
          if (!knownIds.has(k)) tokenCache.delete(k);
        }
        for (const k of titleCache.keys()) {
          if (!knownIds.has(k)) titleCache.delete(k);
        }
        for (const k of titleCacheTs.keys()) {
          if (!knownIds.has(k)) titleCacheTs.delete(k);
        }
      })();
    }, CACHE_CLEANUP_INTERVAL_MS).unref?.();
  }

  // A2: generic debounced cache saver factory (timer scoped inside closure)
  function createDebouncedSaver(cacheMap, maxEntries, filePath, label) {
    let timer = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const obj = {};
        let count = 0;
        for (const [k, v] of cacheMap) {
          if (count >= maxEntries) break;
          obj[k] = v;
          count++;
        }
        ensureDataDir()
          .then(() => writeFile(filePath, JSON.stringify(obj), "utf8"))
          .catch(e => console.warn(`[office] ${label} save failed:`, e?.message || e));
      }, SAVE_DEBOUNCE_MS);
    };
    schedule.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    return schedule;
  }

  const scheduleSaveTokenCache = createDebouncedSaver(tokenCache, MAX_TOKEN_DISK_ENTRIES, TOKEN_USAGE_PATH, 'token cache');

  function sessionTokenTotal(id) {
    const sid = String(id);
    const session = sessionsSvc && typeof sessionsSvc.get === "function" ? sessionsSvc.get(sid) : undefined;
    if (session && sessionProjections && typeof sessionProjections.snapshot === "function") {
      try {
        const snap = sessionProjections.snapshot(session);
        const usage = snap && snap.values && snap.values.tokenUsage;
        if (usage) return tokenUsageTotal(usage);
      } catch (e) { console.warn('[office]', e?.message || e); }
    }
    return tokenCache.get(sid) ?? 0;
  }

  // 惰性冷读历史会话 token（限流每次最多 5 个，fire-and-forget 不阻塞轮询）
  let coldReadRunning = false;
  async function coldReadPending(perWs) {
    if (coldReadRunning || !projectionCache || typeof projectionCache.coldSnapshot !== "function") return;
    coldReadRunning = true;
    try {
      const pending = [];
      const seen = new Set();
      for (const { all } of perWs) {
        for (const id of all) {
          const sid = String(id);
          if (seen.has(sid)) continue;
          seen.add(sid);
          const inMemory = sessionsSvc && typeof sessionsSvc.get === "function" ? sessionsSvc.get(sid) : undefined;
          if (!inMemory && !tokenCache.has(sid)) pending.push(sid);
        }
      }
      const batch = pending.slice(0, COLD_READ_BATCH_SIZE);
      const promises = [];
      for (const id of batch) {
        promises.push(Promise.race([
          projectionCache.coldSnapshot(id),
          new Promise((_, reject) => setTimeout(() => reject(new Error('coldSnapshot timeout')), COLD_SNAPSHOT_TIMEOUT_MS))
        ]).catch(e => { console.warn('[office] coldSnapshot:', e?.message || e); return undefined; }));
      }
      const results = await Promise.all(promises);
      let wroteAny = false;
      for (let i = 0; i < batch.length; i++) {
        const snap = results[i];
        if (!snap || !snap.values) continue;  // 冷读失败，跳过不写缓存
        const usage = snap.values.tokenUsage;
        if (usage) {
          tokenCache.set(batch[i], tokenUsageTotal(usage));
          evictOldest(tokenCache, MAX_TOKEN_CACHE);
          wroteAny = true;
        }
      }
      if (wroteAny) scheduleSaveTokenCache();
    } finally {
      coldReadRunning = false;
    }
  }

  // 标题缓存：历史会话标题不变则缓存，active 会话短 TTL（10s）
  // 落盘持久化，进程重启后第一次打开不用全量读日志
  const titleCache = new Map();
  const titleCacheTs = new Map(); // 缓存时间戳，用于 active 会话的短 TTL 判定
  const ACTIVE_TITLE_TTL_MS = 10000; // 活跃会话标题缓存 10s
  let titleCacheLoaded = false;

  async function loadTitleCache() {
    if (titleCacheLoaded) return;
    titleCacheLoaded = true;
    await loadCacheFile(TITLE_CACHE_PATH, titleCache, MAX_TITLE_CACHE);
  }

  const scheduleSaveTitleCache = createDebouncedSaver(titleCache, MAX_TITLE_DISK_ENTRIES, TITLE_CACHE_PATH, 'title cache');

  // 从 live session 的 events 中提取标题（零 I/O）
  // 标题在 session/title 事件的 data.title 中
  function liveSessionTitle(id) {
    if (!sessionsSvc || typeof sessionsSvc.get !== "function") return undefined;
    try {
      const session = sessionsSvc.get(id);
      if (!session || !session.events) return undefined;
      const events = session.events;
      // 从尾部向前找 session/title 事件（标题通常在后面）
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev && ev.type === "session/title" && ev.data && ev.data.title) {
          return ev.data.title;
        }
      }
    } catch (_) {}
    return undefined;
  }

  async function fetchTitles(ids, activeSet) {
    const result = {};
    const missing = [];
    const now = Date.now();
    for (const id of ids) {
      const sid = String(id);
      const cached = titleCache.get(sid);
      if (cached !== undefined) {
        if (!activeSet.has(sid)) {
          // 非活跃会话：标题不变，直接命中缓存
          result[sid] = cached;
        } else {
          // 活跃会话：标题可能变，但 10s 内仍用缓存
          const ts = titleCacheTs.get(sid) || 0;
          if (now - ts < ACTIVE_TITLE_TTL_MS) {
            result[sid] = cached;
          } else {
            missing.push(sid);
          }
        }
      } else {
        missing.push(sid);
      }
    }
    // 先从 live session 内存 events 中提取标题（零 I/O）
    const stillMissing = [];
    for (const sid of missing) {
      const liveTitle = liveSessionTitle(sid);
      if (liveTitle) {
        result[sid] = liveTitle;
        titleCache.set(sid, liveTitle);
        titleCacheTs.set(sid, Date.now());
        evictOldest(titleCache, MAX_TITLE_CACHE);
      } else {
        stillMissing.push(sid);
      }
    }
    if (stillMissing.length && sessionQuery && typeof sessionQuery.readTitleSnapshots === "function") {
      try {
        const res = await sessionQuery.readTitleSnapshots(stillMissing);
        let added = false;
        for (const r of res || []) {
          if (r && r.status === "fulfilled" && r.value && r.value.title && r.value.title.title) {
            const sid = String(r.sessionId);
            result[sid] = r.value.title.title;
            titleCache.set(sid, r.value.title.title);
            titleCacheTs.set(sid, Date.now());
            evictOldest(titleCache, MAX_TITLE_CACHE);
            if (!activeSet.has(sid)) added = true;
          }
        }
        if (added) scheduleSaveTitleCache();
      } catch (e) { console.warn('[office]', e?.message || e); }
    }
    return result;
  }

  // 最近工具名：只抓进行中会话，直接用 live session.events（浅拷贝、轻量），绝不走 readSession 深拷贝
  function recentToolNames(id, isActive) {
    if (!isActive) return [];
    let names = [];
    try {
      const session = sessionsSvc && typeof sessionsSvc.get === "function" ? sessionsSvc.get(id) : undefined;
      const events = session && session.events ? session.events : [];
      for (let i = events.length - 1; i >= 0 && names.length < RECENT_TOOL_NAMES_LIMIT; i--) {
        const ev = events[i];
        if (ev && ev.type === "tool/call" && ev.data && typeof ev.data.name === "string") {
          names.push(ev.data.name);
        }
      }
      names.reverse();
    } catch (e) { console.warn('[office]', e?.message || e); }
    return names;
  }

  // P0-2: bounded body reader (1 MB default)
  async function readBody(req, maxBytes = BODY_LIMIT_1MB) {
    let body = '', size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) return null;
      body += chunk;
    }
    return body;
  }

  // 每次请求直接读文件（office.html 仅在面板打开时加载一次，非高频轮询）：
  // 避免内存缓存导致「改文件后刷新不生效、必须重启」的开发体验坑
  async function serveHtml(res) {
    let html;
    try { html = await readFile(HTML_PATH, "utf8"); } catch (e) {
      setError("读取 office.html 失败: " + errMsg(e));
    }
    if (html === undefined) {
      res.statusCode = 500;
      res.setHeader("content-type", CT_TEXT);
      res.end("office.html not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", CT_HTML);
    res.setHeader("cache-control", CACHE_NO_STORE);
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'");
    res.end(html);
  }

  async function serveAsset(res, rel) {
    // P0-1: reject path traversal attempts
    if (rel.includes('..')) {
      sendForbidden(res);
      return;
    }
    const resolved = join(ASSETS_DIR, rel);
    if (!resolved.startsWith(ASSETS_DIR + sep) && resolved !== ASSETS_DIR) {
      sendForbidden(res);
      return;
    }
    try {
      const bytes = await readFile(resolved);
      res.statusCode = 200;
      res.setHeader("content-type", rel.endsWith(".png") ? "image/png" : CT_BINARY);
      res.setHeader("cache-control", CACHE_PUBLIC_1H);
      res.end(bytes);
    } catch (e) {
      res.statusCode = 404;
      res.setHeader("content-type", CT_TEXT);
      res.end("asset not found: " + rel);
    }
  }

  // 每次请求直接读文件（低频率接口），避免内存缓存导致改文件后刷新不生效
  async function serveBubbleTexts(res) {
    let texts;
    try { texts = await readFile(BUBBLE_TEXTS_PATH, 'utf8'); } catch (e) { console.warn('[office]', e?.message || e); }
    if (texts === undefined) { res.statusCode = 500; res.end('bubble-texts.json not found'); return; }
    res.statusCode = 200;
    res.setHeader('content-type', CT_JSON);
    res.setHeader('cache-control', CACHE_PUBLIC_1H);
    res.end(texts);
  }

  async function serveOpenSession(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    try {
      const body = await readBody(req);
      if (body === null) {
        res.statusCode = 413;
        res.setHeader("content-type", CT_JSON);
        res.end(JSON.stringify({ ok: false, error: "request body too large" }));
        return;
      }
      const parsed = JSON.parse(body);
      if (parsed && parsed.sessionId) {
        pendingOpenSession = String(parsed.sessionId);
        markDataDirty();
        res.statusCode = 200;
        res.setHeader("content-type", CT_JSON);
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 400;
        res.setHeader("content-type", CT_JSON);
        res.end(JSON.stringify({ ok: false, error: "missing sessionId" }));
      }
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("content-type", CT_JSON);
      res.end(JSON.stringify({ ok: false, error: errMsg(e) }));
    }
  }

  // 子代理识别：header.parentSession 非空 = 子代理（subagentId -> parentId）
  let subagentParent = new Map();
  let coldSubagentsLoadedAt = 0;

  function refreshLiveSubagents() {
    if (sessionsSvc && typeof sessionsSvc.list === "function") {
      try {
        for (const s of sessionsSvc.list()) {
          const pair = extractParentEntry(s);
          if (pair) subagentParent.set(pair[0], pair[1]);
        }
      } catch (e) { console.warn('[office]', e?.message || e); }
    }
  }

  async function refreshColdSubagents() {
    const now = Date.now();
    if (now - coldSubagentsLoadedAt < COLD_SUBAGENT_THROTTLE_MS) return;
    coldSubagentsLoadedAt = now;

    let newMap = null;

    // 优先用 sessionQuery.listSessions()（轻量，只读 header）
    if (sessionQuery && typeof sessionQuery.listSessions === "function") {
      try {
        const records = await sessionQuery.listSessions();
        newMap = new Map();
        for (const rec of records) {
          const pair = extractParentEntry(rec);
          if (pair) newMap.set(pair[0], pair[1]);
        }
      } catch (e) { console.warn('[office] listSessions failed, falling back to persistence.list:', e?.message || e); }
    }

    // fallback：旧路径
    if (!newMap && sessionPersistence && typeof sessionPersistence.list === "function") {
      try {
        const headers = await sessionPersistence.list();
        newMap = new Map();
        for (const h of headers) {
          const pair = extractParentEntry(h);
          if (pair) newMap.set(pair[0], pair[1]);
        }
      } catch (e) { console.warn('[office]', e?.message || e); }
    }

    // Single merge point: preserve live subagent entries not found in newMap
    if (newMap) {
      for (const [k, v] of subagentParent) {
        if (!newMap.has(k)) newMap.set(k, v);
      }
      subagentParent = newMap;
    }
  }

  // P2-2: dirty flag + cache for buildData — only rebuild when state changes
  let _dataCache = null;
  let _dataDirty = true;
  let _dataLastBuilt = 0;
  const DATA_CACHE_TTL_MS = 30000; // stale-while-revalidate: serve old data up to 30s, refresh in background
  let _bgRefreshRunning = false;
  let _bgFailCount = 0;
  function markDataDirty() { _dataDirty = true; }

  // A1: merged buildData — cold=true does full IO (cold subagent scan + title fetch),
  // cold=false is the fast path (cache-only titles, skip cold subagent refresh)
  async function buildData({ cold = true } = {}) {
    const initPromises = [ensureConfig(), loadTokenCache(), loadTitleCache()];
    if (cold) initPromises.push(refreshColdSubagents().catch(e => console.warn('[office]', e?.message || e)));
    await Promise.all(initPromises);
    const workspaces = workspaceRegistry && typeof workspaceRegistry.list === "function"
      ? workspaceRegistry.list() : [];
    refreshLiveSubagents();
    const active = new Set();
    if (agents && typeof agents.list === "function") {
      try {
        for (const a of agents.list()) {
          if (a && a.id != null && a.status === "running") {
            const sid = String(a.id);
            active.add(sid);
            // running 的若是子代理，则其父/祖先会话也视为活跃（有子代理在干活）
            let cur = sid;
            const seen = new Set();
            while (subagentParent.has(cur) && !seen.has(cur)) {
              seen.add(cur);
              cur = subagentParent.get(cur);
              active.add(cur);
            }
          }
        }
      } catch (e) { console.warn('[office]', e?.message || e); }
    }

    const archived = new Set();
    if (workspaceRegistry && Array.isArray(workspaceRegistry.archivedSessionIds)) {
      for (const id of workspaceRegistry.archivedSessionIds) archived.add(String(id));
    }
    // 每个工作区：全部会话（含归档，用于计数）+ 全部未归档会话（展示用）
    const perWs = workspaces.map((ws) => {
      if (!ws || !Array.isArray(ws.sessionIds)) return { all: [], top: [] };
      // 展示列表排除归档 + 子代理；token/计数仍走 all（含子代理）
      const visible = ws.sessionIds.filter((id) => !archived.has(String(id)) && !subagentParent.has(String(id)));
      return { all: ws.sessionIds, top: visible };
    });
    const allIds = [];
    for (const { top } of perWs) for (const id of top) allIds.push(id);

    let titleMap;
    if (cold) {
      titleMap = await fetchTitles(allIds, active);
    } else {
      titleMap = {};
      for (const id of allIds) {
        const sid = String(id);
        titleMap[sid] = titleCache.get(sid) || DEFAULT_SESSION_TITLE_PREFIX + sid.slice(0, SESSION_ID_PREFIX_LENGTH);
      }
    }

    const columns = Array.from({ length: LAYOUT_COLUMN_COUNT }, (_, index) => ({ index, workspaces: [] }));
    // 累计 token（输入+输出，含归档）：active 实时 + 历史从 json 缓存读；冷读 fire-and-forget 后台补齐，不阻塞轮询
    coldReadPending(perWs);
    const tokenTotals = [];
    const sessionTokenMap = new Map();
    for (const { all } of perWs) {
      let total = 0;
      for (const id of all) {
        const sid = String(id);
        let t = sessionTokenMap.get(sid);
        if (t === undefined) { t = sessionTokenTotal(sid); sessionTokenMap.set(sid, t); }
        total += t;
      }
      tokenTotals.push(total);
    }
    const flat = [];
    for (const [wi, ws] of workspaces.entries()) {
      const { all, top } = perWs[wi];
      const sessions = top.map((id) => {
        let inputTokens = null;
        if (sessionsSvc && typeof sessionsSvc.get === "function") {
          inputTokens = singleInputTokens(sessionsSvc.get(id));
        }
        const tools = recentToolNames(id, active.has(String(id)));
        return {
          id: String(id),
          title: titleMap[String(id)] || DEFAULT_SESSION_TITLE_PREFIX + String(id).slice(0, SESSION_ID_PREFIX_LENGTH),
          active: active.has(String(id)),
          pending: pendingSessions.has(String(id)),
          inputTokens,
          tokenTotal: sessionTokenMap.get(String(id)) ?? 0,
          tools
        };
      });
      const sessionCount = all.length;
      const tokenTotal = tokenTotals[wi];
      let col = assignments[String(ws.id)];
      if (typeof col !== "number" || col < -1 || col > LAYOUT_COLUMN_COUNT - 1) col = 0;
      const entry = { id: String(ws.id), title: typeof ws.title === "string" ? ws.title : "", col, sessions, sessionCount, tokenTotal };
      flat.push(entry);
      if (col >= 0 && col <= LAYOUT_COLUMN_COUNT - 1) {
        columns[col].workspaces.push({ id: entry.id, title: entry.title, sessions, sessionCount, tokenTotal });
      }
    }
    return { assignments, columns, workspaces: flat };
  }

  function serveHealth(res) {
    const wsCount = workspaceRegistry && typeof workspaceRegistry.list === "function"
      ? workspaceRegistry.list().length : 0;
    res.statusCode = 200;
    res.setHeader("content-type", CT_JSON);
    res.setHeader("cache-control", CACHE_NO_STORE);
    res.end(JSON.stringify({
      ok: lastError === null,
      workspaces: wsCount,
      configLoaded,
      tokenCacheEntries: tokenCache.size,
      titleCacheEntries: titleCache.size,
      subagentMappings: subagentParent.size,
      coldReadRunning,
      dataCacheAge: _dataLastBuilt ? Date.now() - _dataLastBuilt : null,
      dataDirty: _dataDirty,
      bgRefreshRunning: _bgRefreshRunning,
      lastError,
      lastErrorAt
    }));
  }

  // GET /office-ui/logs：返回内存日志缓冲副本（时间正序 旧→新）
  async function serveOfficeLogs(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    sendJson(res, { ok: true, data: { logs: officeLogs.slice() } });
  }

  async function serveData(res) {
    try {
      const now = Date.now();
      const stale = !_dataCache || _dataDirty || (now - _dataLastBuilt >= DATA_CACHE_TTL_MS);

      // 有缓存就先返回（即使过期），后台刷新
      if (_dataCache) {
        res.statusCode = 200;
        res.setHeader("content-type", CT_JSON);
        res.setHeader("cache-control", CACHE_NO_STORE);
        res.end(_dataCache);

        // 后台刷新（不阻塞响应）
        if (stale && !_bgRefreshRunning) {
          _bgRefreshRunning = true;
          buildData().then((data) => {
            _bgFailCount = 0;
            _dataCache = JSON.stringify(data);
            _dataDirty = false;
            _dataLastBuilt = Date.now();
          }).catch(e => {
            console.warn('[office] bg refresh failed:', e?.message || e);
            _bgFailCount++;
            if (_bgFailCount >= BG_REFRESH_MAX_FAIL_COUNT) {
                // 连续失败 5 次，清除旧缓存，让下次请求重新构建
                _dataCache = null;
                _dataDirty = true;
                _bgFailCount = 0;
                setError("数据后台刷新连续失败，缓存已清除");
            } else if (_bgFailCount >= BG_REFRESH_WARN_THRESHOLD) {
                setError("数据后台刷新连续失败 " + _bgFailCount + " 次");
            }
          })
            .finally(() => { _bgRefreshRunning = false; });
        }
        return;
      }

      // 首次请求，无缓存：fast path 先返回骨架数据（<50ms），后台 full build 补齐
      const fastData = await buildData({ cold: false });
      _dataCache = JSON.stringify(fastData);
      _dataDirty = false;
      _dataLastBuilt = now;
      res.statusCode = 200;
      res.setHeader("content-type", CT_JSON);
      res.setHeader("cache-control", CACHE_NO_STORE);
      res.end(_dataCache);

      // 后台 full build 补齐冷数据（子代理关系、完整标题）
      if (!_bgRefreshRunning) {
        _bgRefreshRunning = true;
        buildData().then((data) => {
          _dataCache = JSON.stringify(data);
          _dataDirty = false;
          _dataLastBuilt = Date.now();
        }).catch(e => console.warn('[office] full build failed:', e?.message || e))
          .finally(() => { _bgRefreshRunning = false; });
      }
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("content-type", CT_JSON);
      res.end(JSON.stringify({ error: errMsg(e) }));
    }
  }

  async function serveConfig(req, res) {
    try {
      // P1-1: loopback check for config write
      const remoteAddr = req.socket.remoteAddress;
      if (!isLoopback(remoteAddr)) {
        sendJsonForbidden(res);
        return;
      }
      const body = await readBody(req);
      if (body === null) {
        res.statusCode = 413;
        res.setHeader("content-type", CT_JSON);
        res.end(JSON.stringify({ ok: false, error: "request body too large" }));
        return;
      }
      const parsed = JSON.parse(body);
      if (parsed && parsed.assignments && typeof parsed.assignments === "object") {
        for (const k of Object.keys(assignments)) delete assignments[k];
        const safeAssign = {};
        for (const k of Object.keys(parsed.assignments)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          safeAssign[k] = parsed.assignments[k];
        }
        Object.assign(assignments, safeAssign);
        markDataDirty();
        await saveConfig();
        res.statusCode = 200;
        res.setHeader("content-type", CT_JSON);
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 400;
        res.setHeader("content-type", CT_JSON);
        res.end(JSON.stringify({ ok: false, error: "bad body" }));
      }
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("content-type", CT_JSON);
      res.end(JSON.stringify({ ok: false, error: errMsg(e) }));
    }
  }

  // ---------- 邮箱接口（Agent Mail / agently-cli） ----------
  function sendJson(res, payload, status = 200) {
    res.statusCode = status;
    res.setHeader("content-type", CT_JSON);
    res.setHeader("cache-control", CACHE_NO_STORE);
    res.end(JSON.stringify(payload));
  }

  function sendJsonForbidden(res) {
    sendJson(res, { ok: false, error: { code: 403, message: "forbidden" } }, 403);
  }

  async function readJsonBody(req) {
    const body = await readBody(req, BODY_LIMIT_2MB);
    if (body === null) return null;
    try { return JSON.parse(body); } catch (e) { return null; }
  }

  // ============ Agent Mail 安装/授权引导（未配置用户的兼容处理） ============
  // 没装 CLI / 没授权的用户打开邮箱页签时，返回结构化引导信息，由面板渲染安装卡片。
  const MAIL_SETUP_URL = "https://agent.qq.com/doc/cli-setup.md";
  const MAIL_SETUP_PROMPT = "请阅读 " + MAIL_SETUP_URL + " 文档，按照步骤为我安装并配置 Agent Mail CLI。";
  const MAIL_INSTALL_CMD = "npm install -g @tencent-qqmail/agently-cli";
  const MAIL_AUTH_CMD = "agently-cli auth login";

  function mailSetupInfo(installed) {
    return {
      installed,
      setupUrl: MAIL_SETUP_URL,
      prompt: MAIL_SETUP_PROMPT,
      installCmd: MAIL_INSTALL_CMD,
      authCmd: MAIL_AUTH_CMD
    };
  }

  function mailSetupRequiredError(installed) {
    return {
      ok: false,
      error: {
        code: installed ? "MAIL_AUTH_REQUIRED" : "MAIL_CLI_REQUIRED",
        message: installed
          ? "邮箱未授权，请先运行 " + MAIL_AUTH_CMD + " 完成授权"
          : "未检测到 Agent Mail CLI，请先安装（" + MAIL_INSTALL_CMD + "）",
        setup: mailSetupInfo(installed)
      }
    };
  }

  // 依据 +me 的调用结果分类：ready / cli_missing / auth_required / error
  // （CLI 未安装时 runAgently 直接以 "agently-cli not found" 失败，无 JSON 输出）
  function classifyMailResult(r) {
    if (r && r.ok && r.data && Array.isArray(r.data.aliases) && r.data.aliases.length) {
      return { status: "ready", email: r.data.aliases[0].email, name: r.data.aliases[0].name || "" };
    }
    const code = r && r.error && r.error.code;
    const msg = (r && r.error && r.error.message) || "";
    if (!resolveAgentlyEntry() || /not found|not recognized|ENOENT|is not recognized/i.test(msg)) {
      return { status: "cli_missing" };
    }
    if (code === CLI_ERROR_AUTH_REQUIRED) return { status: "auth_required" };
    return { status: "error", code, message: msg };
  }

  // CLI 是否可用（入口解析为空 = 未安装；不再走 shell 兜底，判定可靠）
  function cliMissing() {
    return !resolveAgentlyEntry();
  }

  // A10: common guard for mail endpoints — loopback check + CLI availability + error catch
  // Automatically sends the standard {ok, data, error} envelope from fn()'s return value.
  function withMailGuard(req, res, fn) {
    if (!isLoopback(req.socket && req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    if (cliMissing()) { sendJson(res, mailSetupRequiredError(false)); return; }
    return fn()
      .then(r => sendJson(res, { ok: !!r.ok, data: r.data || null, error: r.error || null }))
      .catch(e => {
        ctx.logger.error('[office][mail] error:', e && e.message || e);
        sendJson(res, { ok: false, error: { code: 1, message: errMsg(e) } });
      });
  }

  async function serveMailMe(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    const r = await runAgently(["+me"], { retries: 2 });
    const st = classifyMailResult(r);
    if (st.status === "ready") {
      sendJson(res, { ok: true, data: { email: st.email, name: st.name } });
      return;
    }
    if (st.status === "cli_missing") {
      ctx.logger.warn('[office][mail] agently-cli 未安装，返回安装引导');
      sendJson(res, mailSetupRequiredError(false));
      return;
    }
    if (st.status === "auth_required") {
      ctx.logger.warn('[office][mail] 邮箱未授权，返回授权引导');
      sendJson(res, mailSetupRequiredError(true));
      return;
    }
    // error：CLI 已装、授权状态未知但调用失败（网络/服务端），透传真实错误
    ctx.logger.warn('[office][mail] +me failed:', JSON.stringify(r && r.error));
    sendJson(res, { ok: false, error: r.error || { code: 1, message: "获取邮箱信息失败" } });
  }

  async function serveMailList(req, res) {
    return withMailGuard(req, res, async () => {
      const url = new URL(req.url, URL_PARSE_BASE);
      const dirRaw = url.searchParams.get("dir") || "inbox";
      const dir = MAIL_DIRS_ALLOWED.includes(dirRaw) ? dirRaw : "inbox";
      const limitRaw = parseInt(url.searchParams.get("limit") || String(MAIL_LIST_DEFAULT_LIMIT), 10);
      const limit = Math.min(Math.max(isNaN(limitRaw) ? MAIL_LIST_DEFAULT_LIMIT : limitRaw, 1), MAIL_LIST_MAX_LIMIT);
      const cursor = url.searchParams.get("cursor") || "";
      const args = ["message", "+list", "--dir", dir, "--limit", String(limit)];
      if (url.searchParams.get("unread") === "1") args.push("--is-unread");
      if (cursor) args.push("--cursor", cursor);
      return runAgently(args, { retries: 2 });
    });
  }

  async function serveMailRead(req, res) {
    return withMailGuard(req, res, async () => {
      const url = new URL(req.url, URL_PARSE_BASE);
      const id = (url.searchParams.get("id") || "").trim();
      if (!id || id.length > MESSAGE_ID_MAX_LENGTH) {
        sendJson(res, { ok: false, error: { code: 2, message: "缺少或非法的 message id" } });
        return;
      }
      return runAgently(["message", "+read", "--id", id], { retries: 2 });
    });
  }

  async function serveMailSend(req, res) {
    return withMailGuard(req, res, async () => {
      const payload = await readJsonBody(req);
      if (!payload) { sendJson(res, { ok: false, error: { code: 2, message: "请求体缺失或非法" } }); return; }
      const to = Array.isArray(payload.to) ? payload.to.map((t) => String(t).trim()).filter(Boolean) : [];
      const subject = String(payload.subject || "").trim();
      const body = String(payload.body || "");
      if (!to.length) { sendJson(res, { ok: false, error: { code: 2, message: "缺少收件人" } }); return; }
      if (!subject) { sendJson(res, { ok: false, error: { code: 2, message: "缺少主题" } }); return; }
      if (!body) { sendJson(res, { ok: false, error: { code: 2, message: "缺少正文" } }); return; }
      if (Buffer.byteLength(body, "utf8") > BODY_LIMIT_1MB) { sendJson(res, { ok: false, error: { code: 2, message: "正文超过 1MB 限制" } }); return; }
      const args = ["message", "+send", "--confirmed", "--subject", subject, "--body", body];
      for (const addr of to) args.push("--to", addr);
      return runAgently(args);
    });
  }

  async function serveMailReply(req, res) {
    return withMailGuard(req, res, async () => {
      const payload = await readJsonBody(req);
      if (!payload) { sendJson(res, { ok: false, error: { code: 2, message: "请求体缺失或非法" } }); return; }
      const id = String(payload.id || "").trim();
      const body = String(payload.body || "");
      if (!id || id.length > MESSAGE_ID_MAX_LENGTH) { sendJson(res, { ok: false, error: { code: 2, message: "缺少或非法的 message id" } }); return; }
      if (!body) { sendJson(res, { ok: false, error: { code: 2, message: "缺少回复正文" } }); return; }
      if (Buffer.byteLength(body, "utf8") > BODY_LIMIT_1MB) { sendJson(res, { ok: false, error: { code: 2, message: "正文超过 1MB 限制" } }); return; }
      return runAgently(["message", "+reply", "--id", id, "--body", body, "--confirmed"]);
    });
  }

  // ============ 飞书消息流（外部脚本接入，配置驱动，包内零硬编码路径） ============
  // 配置：~/.dsh/office/feishu-config.json
  //   { "scripts": { "sync": "<ingestor.js 绝对路径>", "latest": "<latest.js 绝对路径>" } }
  // 状态：~/.dsh/office/feishu-state.json（lastSync 结果，运行时数据）
  const FEISHU_CONFIG_PATH = join(DATA_DIR, "feishu-config.json");
  const FEISHU_STATE_PATH = join(DATA_DIR, "feishu-state.json");
  const FEISHU_SYNC_TIMEOUT_MS = 5 * 60 * 1000;   // 全量轮询 + embedding 可能较久
  const FEISHU_LATEST_TIMEOUT_MS = 30 * 1000;
  // 会议日程缓存（scripts.calendar 脚本输出）：随消息同步顺带拉取，供 📅 会议视图 + ⏰ 提醒
  const CALENDAR_CACHE_PATH = join(DATA_DIR, "calendar-cache.json");
  const CALENDAR_SYNC_TIMEOUT_MS = 60 * 1000;
  const CALENDAR_DAYS_DEFAULT = 7;                // 拉取未来 N 天的日程
  const CALENDAR_HISTORY_DAYS_DEFAULT = 7;        // 额外拉取「已开完」的历史会议天数（含妙记/纪要入口）

  let feishuSyncing = false;        // 防叠进程（内存态）
  let feishuLastSync = null;        // { added, skipped, total, elapsed, at }
  let calendarEvents = null;        // [{ event_id, summary, start_ts, end_ts, start, end, meeting_url, app_link, organizer, rsvp, busy }]
  let calendarSyncing = false;      // 防叠进程（内存态）

  async function loadFeishuState() {
    try {
      const parsed = JSON.parse(await readFile(FEISHU_STATE_PATH, "utf8"));
      if (parsed && parsed.lastSync) feishuLastSync = parsed.lastSync;
    } catch (e) { /* 首次运行无状态 */ }
  }
  function saveFeishuState() {
    ensureDataDir()
      .then(() => writeFile(FEISHU_STATE_PATH, JSON.stringify({ lastSync: feishuLastSync }), "utf8"))
      .catch(e => console.warn('[office] feishu state save failed:', e?.message || e));
  }
  loadFeishuState();

  // ---------- 会议日程缓存（scripts.calendar 脚本输出；与消息共用同一套 lark-cli 授权） ----------
  // 内存态 calendarEvents + 磁盘 calendar-cache.json（{ fetchedAt, since, days, events }）
  async function loadCalendarCache() {
    try {
      const parsed = JSON.parse(await readFile(CALENDAR_CACHE_PATH, "utf8"));
      if (parsed && parsed.events && Array.isArray(parsed.events)) {
        calendarEvents = parsed.events;
        _calendarFetchedAt = parsed.fetchedAt || null;
        _calendarSince = parsed.since || "";
      }
    } catch (e) { /* 首次运行无缓存 */ }
  }
  function saveCalendarCache() {
    ensureDataDir()
      .then(() => writeFile(CALENDAR_CACHE_PATH,
        JSON.stringify({ fetchedAt: _calendarFetchedAt, since: _calendarSince, events: calendarEvents || [] }), "utf8"))
      .catch(e => console.warn('[office] calendar cache save failed:', e?.message || e));
  }
  let _calendarFetchedAt = null;    // 'YYYY-MM-DD HH:MM'（本地时间字符串）
  let _calendarSince = "";
  loadCalendarCache();

  // 手动绑定兜底：把 feishu-config 的 manualMinutes（event_id 或会议标题 → minute_token）
  // 应用到同步结果里 vc 链路未拿到 token 的会议（幂等，不覆盖已查到的 token）
  function applyManualMinutes(events, manualMinutes) {
    if (!manualMinutes || typeof manualMinutes !== "object" || !Array.isArray(events)) return;
    for (const e of events) {
      if (!e || e.minute_token) continue;
      const byId = manualMinutes[e.event_id];
      const byTitle = e.summary ? manualMinutes[e.summary] : undefined;
      const token = byId || byTitle;
      if (typeof token === "string" && token.trim()) {
        e.minute_token = token.trim();
        ctx.logger.info('[office][calendar] manualMinutes 绑定:', e.summary || e.event_id, '→', token.slice(0, 8) + '…');
      }
    }
  }

  // 拉取会议日程并缓存（脚本输出 { ok, since, days, historyDays, total, events, hasMinutes }）
  // 返回值：{ ok, events, total } 或 { ok:false, error }
  async function syncCalendar(cfg, opts = {}) {
    if (!cfg || !cfg.calendar) return { ok: false, error: { code: "CALENDAR_CONFIG_REQUIRED", message: "未配置会议日程脚本（scripts.calendar）" } };
    if (calendarSyncing) return { ok: false, error: { code: "SYNC_IN_PROGRESS", message: "会议日程同步进行中，请稍候" } };
    calendarSyncing = true;
    try {
      const days = (opts && opts.days) || CALENDAR_DAYS_DEFAULT;
      const args = ["--days", String(days), "--history", String(CALENDAR_HISTORY_DAYS_DEFAULT)];
      if (opts.since) args.push("--since", opts.since);
      const { error, stdout } = await spawnNodeScript(cfg.calendar, args, CALENDAR_SYNC_TIMEOUT_MS);
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch (e) { parsed = null; }
      if (parsed && parsed.ok && Array.isArray(parsed.events)) {
        const prevEvents = calendarEvents || [];
        calendarEvents = parsed.events;
        // 手动绑定兜底：vc 链路没拿到 minute_token 的会议，用 manualMinutes 配置补上
        //（覆盖分享链接拿到权限但会议记录接口仍拒绝的场景，如「皇包车- AI 岗位需求深度访谈」）
        applyManualMinutes(calendarEvents, cfg.manualMinutes);
        _calendarFetchedAt = localTimeString();
        _calendarSince = parsed.since || "";
        saveCalendarCache();
        // 对比新旧日程，标记「本次新出现的妙记」为待自动拉取（需先确保状态已从磁盘加载，避免覆盖既有状态）
        await loadTranscriptsState();
        markNewMinuteEvents(prevEvents, parsed.events);
        ctx.logger.info('[office][calendar] 日程同步完成:', parsed.total, '条, 含纪要:', parsed.hasMinutes || 0);
        return { ok: true, events: calendarEvents, total: parsed.total };
      }
      const msg = (parsed && parsed.error) || ((error && error.message) || "读取日程失败");
      ctx.logger.warn('[office][calendar] 日程同步失败:', msg);
      return { ok: false, error: { code: 1, message: msg } };
    } catch (e) {
      ctx.logger.warn('[office][calendar] 日程同步异常:', e && e.message || e);
      return { ok: false, error: { code: 1, message: errMsg(e) } };
    } finally {
      calendarSyncing = false;
    }
  }

  // 对比新旧日程，把「本次新出现的妙记」（上次无 minute_token）标记为待自动拉取（status: new）。
  // 历史会议（上次已有妙记）不标记；已有 done/saved/new/pending 状态的条目不动（幂等，跨重启安全）
  function markNewMinuteEvents(prevEvents, newEvents) {
    const prevMinuteByEvent = new Map((prevEvents || []).map((e) => [e.event_id, e.minute_token || ""]));
    let marked = 0;
    for (const e of newEvents || []) {
      if (!e.minute_token || prevMinuteByEvent.get(e.event_id)) continue;
      const st = transcriptsState[e.event_id];
      if (st && (st.status === "done" || st.status === "saved" || st.status === "new" || st.status === "pending")) continue;
      transcriptsState[e.event_id] = { minute_token: e.minute_token, title: e.summary || "", status: "new" };
      marked++;
    }
    if (marked) {
      saveTranscriptsState();
      ctx.logger.info('[office][transcript] 检测到新妙记:', marked, '场，待自动拉取');
    }
    return marked;
  }

  // ---------- 妙记逐字稿（scripts.transcript 脚本输出；依赖 scripts.calendar 提供的 minute_token） ----------
  // 状态落盘 transcripts-state.json：{ [event_id]: { minute_token, title, status, file, chars,
  //   fetchedAt, lastError, retryAfter, savedAt, savedTo } }
  // status：new（新妙记，待自动拉取）/ pending（拉取中）/ done（已生成）/ failed（失败，retryAfter 冷却）/ saved（已移动出缓存）
  // 自动拉取只针对 status=new 的新妙记（syncCalendar 对比新旧日程后标记）；历史会议不自动拉（手动重试仍可）
  let transcriptsState = {};
  let transcriptsStateLoaded = false;
  let transcriptSyncing = false;    // 防叠进程（内存态）

  async function loadTranscriptsState() {
    if (transcriptsStateLoaded) return;
    transcriptsStateLoaded = true;
    try {
      const parsed = JSON.parse(await readFile(TRANSCRIPTS_STATE_PATH, "utf8"));
      if (parsed && typeof parsed === "object") transcriptsState = parsed;
    } catch (e) { /* 首次运行无状态 */ }
  }
  function saveTranscriptsState() {
    mkdir(DATA_DIR, { recursive: true })
      .then(() => writeFile(TRANSCRIPTS_STATE_PATH, JSON.stringify(transcriptsState), "utf8"))
      .catch(e => console.warn('[office] transcripts state save failed:', e?.message || e));
  }
  loadTranscriptsState();

  // 拉取单场会议的妙记逐字稿（自动/手动共用）：调 scripts.transcript → 更新状态 → 返回最新状态
  async function fetchTranscript(cfg, event) {
    const st = (transcriptsState[event.event_id] = transcriptsState[event.event_id] || {});
    st.minute_token = event.minute_token || st.minute_token;
    st.title = event.summary || st.title;
    st.status = "pending";
    st.lastError = "";
    st.retryAfter = 0;
    const args = ["--minute-token", st.minute_token, "--title", st.title, "--out-dir", TRANSCRIPTS_DIR];
    if (cfg.profile) args.push("--profile", cfg.profile);
    const { error, stdout } = await spawnNodeScript(cfg.transcript, args, TRANSCRIPT_TIMEOUT_MS);
    let parsed = null;
    try { parsed = JSON.parse(stdout.trim()); } catch (e) { parsed = null; }
    if (parsed && parsed.ok) {
      st.status = "done";
      st.file = parsed.file || "";
      st.chars = parsed.chars || 0;
      st.fetchedAt = localTimeString();
      ctx.logger.info('[office][transcript] 逐字稿已生成:', event.event_id, st.chars, '字');
    } else {
      const err = (parsed && parsed.error) || { code: 1, message: (error && error.message) || "逐字稿拉取失败" };
      st.status = "failed";
      st.lastError = err.message || String(err);
      st.lastErrorCode = err.code || "";
      st.retryAfter = Date.now() + TRANSCRIPT_RETRY_COOLDOWN_MS;
      ctx.logger.warn('[office][transcript] 拉取失败:', event.event_id, st.lastError);
    }
    saveTranscriptsState();
    return st;
  }

  // 自动拉取：只处理「新妙记」（status=new）与冷却到期的失败重试，限流拉取（fire-and-forget，不阻塞调用方）。
  // 历史会议（无状态条目）不自动拉——用户只对新拉取的妙记生成逐字稿
  async function ensureTranscripts(cfg) {
    if (!cfg || !cfg.transcript || transcriptSyncing || !Array.isArray(calendarEvents)) return;
    transcriptSyncing = true;
    try {
      const now = Date.now();
      const candidates = calendarEvents.filter((e) => {
        const st = transcriptsState[e.event_id];
        if (!(typeof e.end_ts === "number" && e.end_ts < now) || !e.minute_token) return false;
        if (!st || !st.status) return false;
        if (st.status === "done" || st.status === "saved" || st.status === "pending") return false;
        if (st.status === "failed" && st.retryAfter && st.retryAfter > now) return false;
        return true;   // status=new（待拉取）或 failed 且冷却到期
      }).slice(0, TRANSCRIPT_BATCH_MAX);
      for (const event of candidates) {
        await fetchTranscript(cfg, event);
      }
      if (candidates.length) ctx.logger.info('[office][transcript] 自动拉取完成:', candidates.length, '场');
    } catch (e) {
      ctx.logger.warn('[office][transcript] 自动拉取异常:', e && e.message || e);
    } finally {
      transcriptSyncing = false;
    }
  }

  // 会议附带的逐字稿状态（供前端卡片渲染），只透出展示所需字段
  function transcriptView(eventId) {
    const st = transcriptsState[eventId];
    if (!st || !st.status) return null;
    const view = { status: st.status, chars: st.chars || 0 };
    if (st.savedTo) view.savedTo = st.savedTo;
    if (st.status === "failed") {
      view.lastError = st.lastError || "";
      view.errorCode = st.lastErrorCode || "";
    }
    return view;
  }

  // 目标目录校验：仅接受 Windows 绝对路径（盘符或 UNC）
  function isWindowsAbsolutePath(p) {
    return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
  }

  // 移动文件（跨盘 rename 会 EXDEV，回退 copy+unlink）
  async function moveFile(src, dest) {
    try {
      await rename(src, dest);
    } catch (e) {
      if (e && e.code === "EXDEV") {
        await copyFile(src, dest);
        await unlink(src);
      } else {
        throw e;
      }
    }
  }

  // 计算「即将开始」的会议（开始时间在未来 2 小时内，且尚未结束）→ 供 ⏰ 提醒 + 面板倒计时
  function upcomingMeetings(events, windowMinutes = UPCOMING_MEETING_WINDOW_MIN) {
    const now = Date.now();
    const out = [];
    for (const e of events || []) {
      if (typeof e.start_ts !== "number" || !isFinite(e.start_ts)) continue;
      const diffMin = (e.start_ts - now) / 60000;
      // 进行中(-60~0) 或 即将开始(0~windowMinutes)；已结束(end_ts < now) 不提醒
      const ended = typeof e.end_ts === "number" && isFinite(e.end_ts) && e.end_ts < now;
      if (!ended && diffMin >= ONGOING_MEETING_GRACE_MIN && diffMin <= windowMinutes) {
        out.push({ ...e, minutesLeft: Math.max(0, Math.ceil(diffMin)) });
      }
    }
    return out.sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
  }

  // 会议缓存是否过期（默认 10 分钟内新鲜；提醒轮询每 5 分钟一次，留余量避免反复触发同步）
  function calendarCacheAgeMs() {
    if (!_calendarFetchedAt) return Infinity;
    const t = new Date(String(_calendarFetchedAt).replace(' ', 'T')).getTime();
    return isNaN(t) ? Infinity : Math.max(0, Date.now() - t);
  }
  function calendarCacheStale(maxAgeMs = CALENDAR_CACHE_MAX_AGE_MS) {
    return calendarCacheAgeMs() >= maxAgeMs;
  }

  // P2: 5 秒内存缓存，避免每次请求都 readFileSync 读配置文件
  let _feishuConfigCache = null;
  let _feishuConfigLoadedAt = 0;
  const FEISHU_CONFIG_TTL = 5_000; // 5 秒

  // 每次读取配置（文件很小，不缓存，保证「重新检测」即时生效）
  // 剥离 BOM：用户手写/编辑器可能带 UTF-8 BOM，JSON.parse 会失败
  function loadFeishuConfig() {
    const now = Date.now();
    if (_feishuConfigCache && (now - _feishuConfigLoadedAt < FEISHU_CONFIG_TTL)) {
      return _feishuConfigCache;
    }
    try {
      const raw = readFileSync(FEISHU_CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      const sync = parsed && parsed.scripts && parsed.scripts.sync;
      const latest = parsed && parsed.scripts && parsed.scripts.latest;
      if (typeof sync === "string" && sync.trim() && typeof latest === "string" && latest.trim()
          && existsSync(sync) && existsSync(latest)) {
        // 可选：mention 提醒关键词数组（面板据此把「最近消息提到我」的会话标黄）
        const mention = Array.isArray(parsed.mention)
          ? parsed.mention.map((s) => String(s).trim()).filter(Boolean)
          : [];
        // 可选：autoSync 自动同步（enabled + intervalMin 分钟；仅 dsh web 运行期间生效）
        const autoSyncRaw = parsed.autoSync || {};
        const autoSync = {
          enabled: !!autoSyncRaw.enabled,
          intervalMin: Math.min(Math.max(parseInt(autoSyncRaw.intervalMin, 10) || FEISHU_AUTOSYNC_INTERVAL_MIN_DEFAULT, FEISHU_AUTOSYNC_INTERVAL_MIN_MIN), FEISHU_AUTOSYNC_INTERVAL_MIN_MAX)
        };
        // 可选：手动同步的深捞窗口（天），默认 30
        const manualWindowDays = Math.min(Math.max(parseInt(parsed.manualWindowDays, 10) || FEISHU_MANUAL_WINDOW_DAYS_DEFAULT, FEISHU_MANUAL_WINDOW_DAYS_MIN), FEISHU_MANUAL_WINDOW_DAYS_MAX);
        // 可选：会议日程脚本（calendar.js 绝对路径）。配置后，消息同步完成时顺带拉取会议日程
        //（与消息共用同一套 lark-cli 授权，缓存到 calendar-cache.json，供 📅 会议视图 + ⏰ 提醒）
        const calendar = parsed && parsed.scripts && parsed.scripts.calendar;
        // 可选：妙记逐字稿脚本（transcript.js 绝对路径）。配置后，日历同步完成时自动拉取已结束会议的逐字稿
        const transcript = parsed && parsed.scripts && parsed.scripts.transcript;
        // 可选：妙记权限申请脚本（permission.js 绝对路径）。配置后，无权限的会议卡片可一键申请查看权限
        const permission = parsed && parsed.scripts && parsed.scripts.permission;
        // 可选：lark-cli 授权 profile 名（默认由脚本读 env LARK_PROFILE 或 'default'）
        const profile = (typeof parsed.profile === "string" && parsed.profile.trim()) ? parsed.profile.trim() : "";
        // 可选：手动绑定妙记 token（vc 链路查不到时的兜底，如分享链接拿到的权限）
        // 格式：{ "<event_id 或会议标题>": "<minute_token>" }
        const manualMinutes = {};
        if (parsed.manualMinutes && typeof parsed.manualMinutes === "object") {
          for (const [k, v] of Object.entries(parsed.manualMinutes)) {
            if (typeof v === "string" && v.trim()) manualMinutes[String(k).trim()] = v.trim();
          }
        }
        const result = {
          sync, latest, mention, autoSync, manualWindowDays, profile, manualMinutes,
          calendar: (typeof calendar === "string" && calendar.trim() && existsSync(calendar)) ? calendar.trim() : "",
          transcript: (typeof transcript === "string" && transcript.trim() && existsSync(transcript)) ? transcript.trim() : "",
          permission: (typeof permission === "string" && permission.trim() && existsSync(permission)) ? permission.trim() : ""
        };
        _feishuConfigCache = result;
        _feishuConfigLoadedAt = now;
        return result;
      }
    } catch (e) { /* 文件缺失或解析失败 → 未配置 */ }
    return null;
  }

  function feishuSetupError() {
    return {
      ok: false,
      error: {
        code: "FEISHU_CONFIG_REQUIRED",
        message: "未检测到飞书消息流配置（~/.dsh/office/feishu-config.json）",
        setup: {
          configPath: FEISHU_CONFIG_PATH_DISPLAY,
          template: {
            scripts: { sync: "<ingestor.js 绝对路径>", latest: "<latest.js 绝对路径>" },
            mention: ["你的名字，可选"]
          }
        }
      }
    };
  }

  // 直接以 Node 执行本地脚本（无 shell，防注入）
  function spawnNodeScript(scriptPath, args, timeoutMs) {
    return new Promise((resolve) => {
      execFile(process.execPath, [scriptPath, ...args], {
        timeout: timeoutMs, maxBuffer: MAX_BUFFER_16MB, windowsHide: true
      }, (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    });
  }

  // 解析 ingestor 结果行：「轮询完成 | 新增=X 跳过=Y 总消息=Z 耗时=Ns」
  function parseIngestorResult(stdout) {
    const m = stdout.match(/新增=(\d+)\s+跳过=(\d+)\s+总消息=(\d+)\s+耗时=([\d.]+)s/);
    if (!m) return null;
    return {
      added: parseInt(m[1], 10),
      skipped: parseInt(m[2], 10),
      total: parseInt(m[3], 10),
      elapsed: parseFloat(m[4])
    };
  }

  async function serveFeishuStatus(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    // 「重新检测」按钮：清除配置缓存，立即重新读取磁盘
    const url = new URL(req.url, URL_PARSE_BASE);
    if (url.searchParams.get("refresh") === "1") {
      _feishuConfigCache = null;
    }
    const cfg = loadFeishuConfig();
    const auto = feishuAutoConfig(cfg);
    const stale = auto.enabled && (feishuLastSyncAgeMs() >= auto.intervalMin * 60 * 1000);
    if (cfg && auto.enabled && !feishuAutoTimer) scheduleFeishuAutoSync();  // 配置中途开启时补臂
    sendJson(res, { ok: true, data: {
      configured: !!cfg,
      syncing: feishuSyncing,
      lastSync: feishuLastSync,
      mention: (cfg && cfg.mention) || [],
      autoSync: auto,
      stale
    } });
  }

  // 本地时间字符串（与 msg_metadata.created_at 同格式，可直接字符串比较）
  function localTimeString(d) {
    const dt = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
  }

  // ---------- 自动同步（① 整点定时器 + ③ 惰性补同步） ----------
  function feishuLastSyncAgeMs() {
    if (!feishuLastSync || !feishuLastSync.at) return Infinity;
    const t = new Date(String(feishuLastSync.at).replace(' ', 'T')).getTime();
    return isNaN(t) ? Infinity : Math.max(0, Date.now() - t);
  }

  function feishuAutoConfig(cfg) {
    return (cfg && cfg.autoSync) || { enabled: false, intervalMin: FEISHU_AUTOSYNC_INTERVAL_MIN_DEFAULT };
  }

  // 触发一次同步（手动接口与自动定时共用；返回是否真正开始）
  // opts.auto=true（整点定时/惰性补同步）：增量拉取（--since=上次同步，24h 兜底窗口），
  //   同步完成后扫描新消息是否提到 mention 关键词 → 设置悬浮提示
  // opts 缺省 / manual=true（手动按钮）：深捞最近 manualWindowDays 天（默认 30）
  function triggerFeishuSync(cfg, opts = {}) {
    if (feishuSyncing) return false;
    const beforeAt = feishuLastSync && feishuLastSync.at;
    let args;
    if (opts.auto) {
      args = beforeAt ? ["--since", beforeAt] : [];
    } else {
      const days = (cfg.manualWindowDays && cfg.manualWindowDays > 0) ? cfg.manualWindowDays : FEISHU_MANUAL_WINDOW_DAYS_DEFAULT;
      const since = localTimeString(new Date(Date.now() - days * 24 * 3600 * 1000));
      args = ["--since", since, "--window-hours", String(days * 24)];
    }
    feishuSyncing = true;
    spawnNodeScript(cfg.sync, args, FEISHU_SYNC_TIMEOUT_MS).then(({ error, stdout, stderr }) => {
      const parsed = parseIngestorResult(stdout);
      if (parsed) {
        feishuLastSync = { ...parsed, at: localTimeString() };
        saveFeishuState();
        _feishuMsgCache = null;  // 同步完成，清除消息缓存以获取最新数据
        ctx.logger.info('[office][feishu] 同步完成:', JSON.stringify(feishuLastSync));
        if (opts.auto && beforeAt && cfg.mention && cfg.mention.length) {
          scanFeishuMention(cfg, beforeAt);
        }
      } else {
        ctx.logger.warn('[office][feishu] 同步未识别到结果行:', ((error && error.message) || '') + (stderr ? ' | ' + stderr.slice(0, STDERR_LOG_SLICE_LENGTH) : ''));
      }
      // 消息同步完成后，顺带拉取会议日程（共用同一套触发链；脚本未配置时静默跳过）
      if (cfg.calendar) syncCalendar(cfg).then((r) => {
        if (r && r.ok) ensureTranscripts(cfg).catch((e) => {
          ctx.logger.warn('[office][transcript] 同步后拉取失败:', e && e.message || e);
        });
      }).catch((e) => {
        ctx.logger.warn('[office][calendar] 同步拉取失败:', e && e.message || e);
      });
    }).finally(() => { feishuSyncing = false; });
    return true;
  }

  // 定时同步后：扫描「本次新入库（since 之后）」的消息，若正文提到 mention 关键词 → 悬浮提示
  async function scanFeishuMention(cfg, since) {
    try {
      const { stdout } = await spawnNodeScript(cfg.latest, ["--per-chat", "50", "--since", since], FEISHU_LATEST_TIMEOUT_MS);
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch (e) { parsed = null; }
      if (!parsed || !parsed.ok) return;
      let hit = null;
      for (const c of parsed.chats || []) {
        for (const m of c.messages || []) {
          const t = (m && m.text) || '';
          for (const kw of cfg.mention) {
            if (kw && t.includes(kw)) {
              hit = { chat: c.chat_name || c.chat_id || '', sender: m.sender_name || '', snippet: t.slice(0, MENTION_SNIPPET_LENGTH) };
              break;
            }
          }
          if (hit) break;
        }
        if (hit) break;
      }
      if (hit) {
        feishuNotice = { at: localTimeString(), count: 1, chat: hit.chat, keyword: cfg.mention[0], sender: hit.sender, snippet: hit.snippet };
        ctx.logger.info('[office][feishu] 定时同步后检测到提及:', JSON.stringify(feishuNotice));
      }
    } catch (e) {
      ctx.logger.warn('[office][feishu] 提及扫描失败:', e && e.message || e);
    }
  }

  // 距下一个「整点对齐」触发点的毫秒数（intervalMin 的倍数对齐到小时内整点，如 30 → :00/:30）
  function nextSyncDelayMs(intervalMin) {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60000;
    let target = Math.ceil(mins / intervalMin) * intervalMin;
    const targetDate = new Date(now);
    if (target >= 24 * 60) {
      target -= 24 * 60;
      targetDate.setDate(targetDate.getDate() + 1);
    }
    targetDate.setHours(0, 0, 0, 0);
    targetDate.setMinutes(target, 0, 0);
    return Math.max(NEXT_SYNC_MIN_DELAY_MS, targetDate.getTime() - now.getTime());
  }

  // 整点定时链：到点触发一次 → 重新排下一次（无 60s 轮询监听）
  let feishuAutoTimer = null;
  function scheduleFeishuAutoSync() {
    if (feishuAutoTimer) return;
    const cfg = loadFeishuConfig();
    const auto = feishuAutoConfig(cfg);
    if (!cfg || !auto.enabled) return;
    feishuAutoTimer = setTimeout(() => {
      feishuAutoTimer = null;
      const cfg2 = loadFeishuConfig();
      const auto2 = feishuAutoConfig(cfg2);
      if (!cfg2 || !auto2.enabled) return;               // 已关闭：不再续链
      if (feishuSyncing) { scheduleFeishuAutoSync(); return; }
      if (feishuLastSyncAgeMs() >= auto2.intervalMin * 60 * 1000) {
        ctx.logger.info('[office][feishu] 整点自动同步触发（' + auto2.intervalMin + ' 分钟）');
        triggerFeishuSync(cfg2, { auto: true });
      }
      scheduleFeishuAutoSync();
    }, nextSyncDelayMs(auto.intervalMin));
  }
  scheduleFeishuAutoSync();

  async function serveFeishuSync(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    const cfg = loadFeishuConfig();
    if (!cfg) { sendJson(res, feishuSetupError()); return; }
    if (feishuSyncing) { sendJson(res, { ok: false, error: { code: "SYNC_IN_PROGRESS", message: "同步进行中，请稍候" } }); return; }
    // mode=incr（惰性补同步用）→ 增量；缺省（手动按钮）→ 深捞 manualWindowDays 天
    const url = new URL(req.url, URL_PARSE_BASE);
    const mode = url.searchParams.get("mode") || "manual";
    const started = triggerFeishuSync(cfg, mode === "incr" ? { auto: true } : { manual: true });
    if (!feishuAutoTimer) scheduleFeishuAutoSync();      // 配置中途开启时，靠手动同步/面板打开补臂
    sendJson(res, { ok: started, data: { started } });
  }

  // P0: 15 秒内存缓存，避免每次请求都 spawn 子进程读数据
  let _feishuMsgCache = null;
  let _feishuMsgCacheAt = 0;
  const FEISHU_MSG_CACHE_TTL = 15_000; // 15 秒

  async function serveFeishuMessages(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    const cfg = loadFeishuConfig();
    if (!cfg) { sendJson(res, feishuSetupError()); return; }
    try {
      const url = new URL(req.url, URL_PARSE_BASE);
      const perChatRaw = parseInt(url.searchParams.get("per-chat") || "20", 10);
      const perChat = Math.min(Math.max(isNaN(perChatRaw) ? FEISHU_PER_CHAT_DEFAULT_LIMIT : perChatRaw, 1), FEISHU_PER_CHAT_MAX_LIMIT);
      const since = (feishuLastSync && feishuLastSync.at) || "";
      const chatFilter = url.searchParams.get("chat") || "";
      const offsetRaw = parseInt(url.searchParams.get("offset") || "0", 10);
      const offset = Math.max(isNaN(offsetRaw) ? 0 : offsetRaw, 0);
      const args = ["--per-chat", String(perChat)];
      if (since) args.push("--since", since);
      if (chatFilter) args.push("--chat", chatFilter);
      if (offset > 0) args.push("--offset", String(offset));
      // 缓存命中：15 秒内直接返回，不 spawn 子进程
      const now = Date.now();
      if (_feishuMsgCache && (now - _feishuMsgCacheAt < FEISHU_MSG_CACHE_TTL)) {
        sendJson(res, _feishuMsgCache);
        return;
      }
      const { error, stdout } = await spawnNodeScript(cfg.latest, args, FEISHU_LATEST_TIMEOUT_MS);
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch (e) { parsed = null; }
      if (parsed && parsed.ok) {
        const result = { ok: true, data: { total: parsed.total, since: parsed.since, chats: parsed.chats || [] } };
        _feishuMsgCache = result;
        _feishuMsgCacheAt = Date.now();
        sendJson(res, result);
      } else {
        sendJson(res, { ok: false, error: { code: 1, message: (parsed && parsed.error) || ((error && error.message) || "读取消息失败") } });
      }
    } catch (e) {
      sendJson(res, { ok: false, error: { code: 1, message: errMsg(e) } });
    }
  }

  // ============ 会议日程（scripts.calendar 脚本接入，与飞书消息共用配置与授权） ============
  async function serveCalendarStatus(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    const cfg = loadFeishuConfig();
    sendJson(res, { ok: true, data: {
      configured: !!(cfg && cfg.calendar),
      syncing: calendarSyncing,
      fetchedAt: _calendarFetchedAt,
      since: _calendarSince,
      total: (calendarEvents || []).length,
      stale: cfg && cfg.calendar ? calendarCacheStale() : false
    } });
  }

  async function serveCalendarEvents(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    const cfg = loadFeishuConfig();
    if (!cfg || !cfg.calendar) {
      sendJson(res, calendarSetupError());
      return;
    }
    // 缓存缺失/过期 → 惰性补拉（打开会议视图时自动拉一次）
    if (calendarEvents == null || calendarCacheStale()) {
      const r = await syncCalendar(cfg);
      if (!r.ok && calendarEvents == null) {
        sendJson(res, { ok: false, error: r.error || { code: 1, message: "读取日程失败" } });
        return;
      }
      // 日程更新后顺带触发逐字稿自动拉取（fire-and-forget，不阻塞本次响应）
      ensureTranscripts(cfg).catch((e) => {
        ctx.logger.warn('[office][transcript] 惰性拉取失败:', e && e.message || e);
      });
    }
    sendJson(res, { ok: true, data: {
      fetchedAt: _calendarFetchedAt,
      since: _calendarSince,
      events: (calendarEvents || []).map((e) => ({ ...e, transcript: transcriptView(e.event_id) })),
      upcoming: upcomingMeetings(calendarEvents, UPCOMING_MEETING_WINDOW_MIN)
    } });
  }

  async function serveCalendarSync(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    const cfg = loadFeishuConfig();
    if (!cfg || !cfg.calendar) { sendJson(res, calendarSetupError()); return; }
    if (calendarSyncing) { sendJson(res, { ok: false, error: { code: "SYNC_IN_PROGRESS", message: "会议日程同步进行中，请稍候" } }); return; }
    const r = await syncCalendar(cfg);
    sendJson(res, { ok: !!r.ok, data: r.ok ? { total: r.total, fetchedAt: _calendarFetchedAt } : null, error: r.error || null });
  }

  function calendarSetupError() {
    return {
      ok: false,
      error: {
        code: "CALENDAR_CONFIG_REQUIRED",
        message: "未检测到会议日程脚本配置（~/.dsh/office/feishu-config.json → scripts.calendar）",
        setup: {
          configPath: FEISHU_CONFIG_PATH_DISPLAY,
          template: { scripts: { calendar: "<calendar.js 绝对路径>" } }
        }
      }
    };
  }

  async function serveTranscriptStatus(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    const cfg = loadFeishuConfig();
    const counts = { total: 0, done: 0, failed: 0, saved: 0, pending: 0 };
    for (const st of Object.values(transcriptsState)) {
      if (counts[st.status] != null) counts[st.status]++;
      counts.total++;
    }
    sendJson(res, { ok: true, data: {
      configured: !!(cfg && cfg.transcript),
      syncing: transcriptSyncing,
      ...counts
    } });
  }

  async function serveTranscriptFetch(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    const cfg = loadFeishuConfig();
    if (!cfg || !cfg.transcript) { sendJson(res, transcriptSetupError()); return; }
    const payload = await readJsonBody(req);
    const event = (calendarEvents || []).find((e) => e.event_id === (payload && payload.event_id));
    // 手动转换：有妙记的会议即可触发（自动链路只处理新妙记，手动入口对历史会议同样可用）
    if (!event || !event.minute_token) {
      sendJson(res, { ok: false, error: { code: "EVENT_NOT_FOUND", message: "该会议没有妙记，无法转逐字稿" } });
      return;
    }
    const result = await fetchTranscript(cfg, event);
    sendJson(res, { ok: result.status === "done", data: { event_id: event.event_id, ...transcriptView(event.event_id) } });
  }

  async function serveTranscriptSave(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    const payload = await readJsonBody(req);
    const st = transcriptsState[payload && payload.event_id];
    if (!st || st.status !== "done" || !st.file) {
      sendJson(res, { ok: false, error: { code: "TRANSCRIPT_NOT_READY", message: "该会议逐字稿尚未生成" } });
      return;
    }
    const targetDir = payload && payload.target_dir ? String(payload.target_dir).trim() : "";
    if (!isWindowsAbsolutePath(targetDir)) {
      sendJson(res, { ok: false, error: { code: "INVALID_TARGET_DIR", message: "目标目录必须是 Windows 绝对路径（如 D:\\会议纪要）" } });
      return;
    }
    try {
      await mkdir(targetDir, { recursive: true });
      const targetFile = join(targetDir, basename(st.file));
      await moveFile(st.file, targetFile);
      st.status = "saved";
      st.savedTo = targetFile;
      st.savedAt = localTimeString();
      st.file = "";
      saveTranscriptsState();
      ctx.logger.info('[office][transcript] 已保存:', payload.event_id, '→', targetFile);
      sendJson(res, { ok: true, data: { event_id: payload.event_id, savedTo: targetFile } });
    } catch (e) {
      ctx.logger.warn('[office][transcript] 保存失败:', payload.event_id, e && e.message || e);
      sendJson(res, { ok: false, error: { code: "SAVE_FAILED", message: "保存失败: " + (e && e.message ? e.message : String(e)) } });
    }
  }

  async function serveTranscriptApplyPermission(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return;
    }
    const cfg = loadFeishuConfig();
    if (!cfg || !cfg.permission) {
      sendJson(res, { ok: false, error: { code: "PERMISSION_CONFIG_REQUIRED", message: "未检测到妙记权限申请脚本配置（~/.dsh/office/feishu-config.json → scripts.permission）" } });
      return;
    }
    const payload = await readJsonBody(req);
    const event = (calendarEvents || []).find((e) => e.event_id === (payload && payload.event_id));
    if (!event || !event.minute_token) {
      sendJson(res, { ok: false, error: { code: "EVENT_NOT_FOUND", message: "该会议没有妙记，无法申请权限" } });
      return;
    }
    const args = ["--minute-token", event.minute_token];
    if (cfg.profile) args.push("--profile", cfg.profile);
    const { stdout } = await spawnNodeScript(cfg.permission, args, PERMISSION_TIMEOUT_MS);
    let parsed = null;
    try { parsed = JSON.parse(stdout.trim()); } catch (e) { parsed = null; }
    if (parsed && parsed.ok) {
      ctx.logger.info('[office][transcript] 已申请妙记查看权限:', event.event_id);
      sendJson(res, { ok: true, data: { minute_token: event.minute_token } });
    } else {
      const err = (parsed && parsed.error) || { code: "APPLY_FAILED", message: "权限申请失败" };
      sendJson(res, { ok: false, error: { code: err.code || "APPLY_FAILED", message: err.message || "权限申请失败" } });
    }
  }

  function transcriptSetupError() {
    return {
      ok: false,
      error: {
        code: "TRANSCRIPT_CONFIG_REQUIRED",
        message: "未检测到妙记逐字稿脚本配置（~/.dsh/office/feishu-config.json → scripts.transcript）",
        setup: {
          configPath: FEISHU_CONFIG_PATH_DISPLAY,
          template: { scripts: { transcript: "<transcript.js 绝对路径>" } }
        }
      }
    };
  }

  // P1-1/P1-2: cleanup interval/timer on dispose
  ctx.effect(() => {
    return () => {
      if (_cleanupInterval) clearInterval(_cleanupInterval);
      scheduleSaveTitleCache.cancel();
      scheduleSaveTokenCache.cancel();
      if (feishuAutoTimer) clearTimeout(feishuAutoTimer);
    };
  }, "office: cleanup interval");

  // 事件驱动 dirty：订阅 Cordis 框架事件总线，即时标记缓存过期
  ctx.effect(() => {
    const disposers = [];

    // Cordis ctx.on() 事件（比 sessions.on('change') 更细粒度）
    if (typeof ctx.on === "function") {
      const onSessionChange = () => markDataDirty();
      try {
        const d1 = ctx.on("session/created", onSessionChange);
        if (d1) disposers.push(d1);
      } catch (_) {}
      try {
        const d2 = ctx.on("session/disposed", onSessionChange);
        if (d2) disposers.push(d2);
      } catch (_) {}
      // session/event 太频繁（每个 token 都触发），不订阅
      // 只订阅 created/disposed，加上 agents 的 change
    }

    // agents 服务：agent 启动/结束（这个仍然有价值，因为 agent 状态变化不触发 session/created）
    if (agents && typeof agents.on === "function") {
      const handler = () => markDataDirty();
      try {
        agents.on("change", handler);
        disposers.push(() => { try { agents.off("change", handler); } catch (_) {} });
      } catch (_) {}
    }

    return () => { for (const d of disposers) { try { typeof d === "function" && d(); } catch (_) {} } };
  }, "office: event-driven dirty");

  try {
    const dispose = webServer.register({
      kind: "prefix",
      path: "/office-ui",
      handler: async (req, res) => {
        const pathname = String(req.url || "/").split("?")[0];
        // 请求日志：记录每次请求（高频只读轮询路径过滤，避免 3 秒轮询刷屏）
        if (!isHighFreqReadPath(pathname)) {
          appendOfficeLog("info", req.method + " " + pathname);
        }
        if (pathname.startsWith("/office-ui/assets/")) return serveAsset(res, pathname.slice("/office-ui/assets/".length));
        if (pathname === "/office-ui/data") return serveData(res);
        if (pathname === "/office-ui/config") return serveConfig(req, res);
        if (pathname === "/office-ui/open-session") return serveOpenSession(req, res);
        if (pathname === "/office-ui/health") return serveHealth(res);
        if (pathname === "/office-ui/bubble-texts") return serveBubbleTexts(res);
        if (pathname === "/office-ui/mail/me") return serveMailMe(req, res);
        if (pathname === "/office-ui/mail/list") return serveMailList(req, res);
        if (pathname === "/office-ui/mail/read") return serveMailRead(req, res);
        if (pathname === "/office-ui/mail/send") return serveMailSend(req, res);
        if (pathname === "/office-ui/mail/reply") return serveMailReply(req, res);
        if (pathname === "/office-ui/feishu/status") return serveFeishuStatus(req, res);
        if (pathname === "/office-ui/feishu/sync") return serveFeishuSync(req, res);
        if (pathname === "/office-ui/feishu/messages") return serveFeishuMessages(req, res);
        if (pathname === "/office-ui/calendar/status") return serveCalendarStatus(req, res);
        if (pathname === "/office-ui/calendar/events") return serveCalendarEvents(req, res);
        if (pathname === "/office-ui/calendar/sync") return serveCalendarSync(req, res);
        if (pathname === "/office-ui/transcript/status") return serveTranscriptStatus(req, res);
        if (pathname === "/office-ui/transcript/fetch") return serveTranscriptFetch(req, res);
        if (pathname === "/office-ui/transcript/save") return serveTranscriptSave(req, res);
        if (pathname === "/office-ui/transcript/apply-permission") return serveTranscriptApplyPermission(req, res);
        if (pathname === "/office-ui/logs") return serveOfficeLogs(req, res);
        return serveHtml(res);
      }
    });
    ctx.effect(() => dispose, "office: http routes");
  } catch (e) {
    ctx.logger.error("[office] webServer.register 失败:", e);
  }
}

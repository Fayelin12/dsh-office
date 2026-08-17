import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { exec, execFile, execFileSync } from "node:child_process";

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

// cmd.exe 引号转义（仅兜底路径使用）
function cmdQuote(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function isLoopback(remoteAddr) {
  return remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
}

export async function apply(ctx, _config = {}) {
  let webServer = ctx.get("webServer");
  if (webServer === undefined) {
    ctx.logger.warn("[office] webServer 服务不可用，等待 2 秒后重试...");
    await new Promise(r => setTimeout(r, 2000));
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

  let _agentlyEntry = null;
  function resolveAgentlyEntry() {
    if (_agentlyEntry) return _agentlyEntry;
    const candidates = [];
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "npm", "node_modules", AGENTLY_PKG));
    if (process.env.npm_config_prefix) candidates.push(join(process.env.npm_config_prefix, "node_modules", AGENTLY_PKG));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "npm", "node_modules", AGENTLY_PKG));
    try {
      const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", windowsHide: true, timeout: 10000 }).trim();
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
    const delayMs = opts.delayMs || 600;
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
              return !parsed.ok && (code === 1 || code === 4);
            }
            if (error) {
              const c = error.code;
              return c === 1 || c === 4 || c === "ETIMEDOUT" || c === "ENOTFOUND" || c === "EAI_AGAIN" || c === "ECONNRESET";
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
          resolve({ ok: false, error: { code: (error && error.code) || 1, message: detail || "agently-cli 无输出" } });
        };
        const entry = resolveAgentlyEntry();
        const common = { timeout: opts.timeout || AGENTLY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
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
          return { ok: true, value: n ? { at: n.at, count: n.count, chat: n.chat, keyword: n.keyword } : null };
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
        await mkdir(DATA_DIR, { recursive: true });
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

  // token 累计缓存：历史/归档会话冷读结果持久化到 json，active 会话实时快照
  const tokenCache = new Map();
  let tokenCacheLoaded = false;

  async function loadTokenCache() {
    if (tokenCacheLoaded) return;
    tokenCacheLoaded = true;
    try {
      const txt = await readFile(TOKEN_USAGE_PATH, "utf8");
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === "object") {
        for (const k of Object.keys(parsed)) {
          if (typeof parsed[k] === "number") tokenCache.set(k, parsed[k]);
        }
      }
      // P1-2: cap loaded entries to prevent unbounded disk-sourced growth
      evictOldest(tokenCache, MAX_TOKEN_CACHE);
    } catch (e) { console.warn('[office]', e?.message || e); }
    // P1-2: periodic cleanup — remove entries for sessions that no longer exist
    _cleanupInterval = setInterval(() => {
      if (tokenCache.size === 0 && titleCache.size === 0) return;
      const knownIds = new Set();
      if (sessionsSvc && typeof sessionsSvc.list === "function") {
        try {
          for (const s of sessionsSvc.list()) {
            if (s && s.id != null) knownIds.add(String(s.id));
          }
        } catch (e) { /* ignore */ }
      }
      for (const k of tokenCache.keys()) {
        if (!knownIds.has(k)) tokenCache.delete(k);
      }
      for (const k of titleCache.keys()) {
        if (!knownIds.has(k)) titleCache.delete(k);
      }
    }, 5 * 60 * 1000).unref?.();
  }

  function scheduleSaveTokenCache() {
    const obj = {};
    let count = 0;
    for (const [k, v] of tokenCache) {
      if (count >= MAX_TOKEN_DISK_ENTRIES) break;
      obj[k] = v;
      count++;
    }
    mkdir(DATA_DIR, { recursive: true })
      .then(() => writeFile(TOKEN_USAGE_PATH, JSON.stringify(obj), "utf8"))
      .catch(e => console.warn('[office] token cache save failed:', e?.message || e));
  }

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
    return tokenCache.get(sid) || 0;
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
      const batch = pending.slice(0, 5);
      const promises = [];
      for (const id of batch) {
        promises.push(projectionCache.coldSnapshot(id).catch(e => console.warn('[office]', e?.message || e)));
      }
      const results = await Promise.all(promises);
      for (let i = 0; i < batch.length; i++) {
        const snap = results[i];
        const usage = snap && snap.values && snap.values.tokenUsage;
        tokenCache.set(batch[i], tokenUsageTotal(usage));
        evictOldest(tokenCache, MAX_TOKEN_CACHE);
      }
      if (batch.length) scheduleSaveTokenCache();
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
    try {
      const txt = await readFile(TITLE_CACHE_PATH, "utf8");
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === "object") {
        for (const k of Object.keys(parsed)) {
          if (typeof parsed[k] === "string") titleCache.set(k, parsed[k]);
        }
      }
      evictOldest(titleCache, MAX_TITLE_CACHE);
    } catch (e) { /* file may not exist yet */ }
  }

  let _saveTitleTimer = null;
  function scheduleSaveTitleCache() {
    if (_saveTitleTimer) return;
    _saveTitleTimer = setTimeout(() => {
      _saveTitleTimer = null;
      const obj = {};
      let count = 0;
      for (const [k, v] of titleCache) {
        if (count >= MAX_TITLE_DISK_ENTRIES) break;
        obj[k] = v;
        count++;
      }
      mkdir(DATA_DIR, { recursive: true })
        .then(() => writeFile(TITLE_CACHE_PATH, JSON.stringify(obj), "utf8"))
        .catch(e => console.warn('[office] title cache save failed:', e?.message || e));
    }, 3000);
  }

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
      for (let i = events.length - 1; i >= 0 && names.length < 3; i--) {
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

  // P2-4: cache office.html in memory after first read
  let _htmlCache = null;
  async function serveHtml(res) {
    if (_htmlCache === null) {
      try { _htmlCache = await readFile(HTML_PATH, "utf8"); } catch (e) {
        setError("读取 office.html 失败: " + (e && e.message ? e.message : e));
      }
    }
    if (_htmlCache === null) {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("office.html not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'");
    res.end(_htmlCache);
  }

  async function serveAsset(res, rel) {
    // P0-1: reject path traversal attempts
    if (rel.includes('..')) {
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("forbidden");
      return;
    }
    const resolved = join(ASSETS_DIR, rel);
    if (!resolved.startsWith(ASSETS_DIR + sep) && resolved !== ASSETS_DIR) {
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("forbidden");
      return;
    }
    try {
      const bytes = await readFile(resolved);
      res.statusCode = 200;
      res.setHeader("content-type", rel.endsWith(".png") ? "image/png" : "application/octet-stream");
      res.setHeader("cache-control", "public, max-age=3600");
      res.end(bytes);
    } catch (e) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("asset not found: " + rel);
    }
  }

  let _bubbleTextsCache = null;
  async function serveBubbleTexts(res) {
    if (_bubbleTextsCache === null) {
      try { _bubbleTextsCache = await readFile(BUBBLE_TEXTS_PATH, 'utf8'); } catch (e) { console.warn('[office]', e?.message || e); }
    }
    if (_bubbleTextsCache === null) { res.statusCode = 500; res.end('bubble-texts.json not found'); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=3600');
    res.end(_bubbleTextsCache);
  }

  async function serveOpenSession(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, { ok: false, error: { code: 403, message: "forbidden" } }, 403);
      return;
    }
    try {
      const body = await readBody(req);
      if (body === null) {
        res.statusCode = 413;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: "request body too large" }));
        return;
      }
      const parsed = JSON.parse(body);
      if (parsed && parsed.sessionId) {
        pendingOpenSession = String(parsed.sessionId);
        markDataDirty();
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: "missing sessionId" }));
      }
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
    }
  }

  // 子代理识别：header.parentSession 非空 = 子代理（subagentId -> parentId）
  let subagentParent = new Map();
  let coldSubagentsLoadedAt = 0;

  function refreshLiveSubagents() {
    if (sessionsSvc && typeof sessionsSvc.list === "function") {
      try {
        for (const s of sessionsSvc.list()) {
          if (s && s.id != null && s.header && s.header.parentSession != null) {
            subagentParent.set(String(s.id), String(s.header.parentSession));
          }
        }
      } catch (e) { console.warn('[office]', e?.message || e); }
    }
  }

  async function refreshColdSubagents() {
    const now = Date.now();
    if (now - coldSubagentsLoadedAt < COLD_SUBAGENT_THROTTLE_MS) return;
    coldSubagentsLoadedAt = now;

    // 优先用 sessionQuery.listSessions()（轻量，只读 header）
    if (sessionQuery && typeof sessionQuery.listSessions === "function") {
      try {
        const records = await sessionQuery.listSessions();
        const newMap = new Map();
        for (const rec of records) {
          const h = rec && rec.header;
          if (h && h.id != null && h.parentSession != null) {
            newMap.set(String(h.id), String(h.parentSession));
          }
        }
        // 保留 live subagents 已发现的映射
        for (const [k, v] of subagentParent) {
          if (!newMap.has(k)) newMap.set(k, v);
        }
        subagentParent = newMap;
        return;
      } catch (e) { console.warn('[office] listSessions failed, falling back to persistence.list:', e?.message || e); }
    }

    // fallback：旧路径
    if (sessionPersistence && typeof sessionPersistence.list === "function") {
      try {
        const headers = await sessionPersistence.list();
        const newMap = new Map();
        for (const h of headers) {
          if (h && h.id != null && h.parentSession != null) {
            newMap.set(String(h.id), String(h.parentSession));
          }
        }
        for (const [k, v] of subagentParent) {
          if (!newMap.has(k)) newMap.set(k, v);
        }
        subagentParent = newMap;
      } catch (e) { console.warn('[office]', e?.message || e); }
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

  async function buildData() {
    await Promise.all([
      ensureConfig(),
      refreshColdSubagents().catch(e => console.warn('[office]', e?.message || e)),
      loadTokenCache(),
      loadTitleCache()
    ]);
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
    const titleMap = await fetchTitles(allIds, active);

    const columns = Array.from({ length: 6 }, (_, index) => ({ index, workspaces: [] }));
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
          title: titleMap[String(id)] || "会话 " + String(id).slice(0, 6),
          active: active.has(String(id)),
          pending: pendingSessions.has(String(id)),
          inputTokens,
          tokenTotal: sessionTokenMap.get(String(id)) || 0,
          tools
        };
      });
      const sessionCount = all.length;
      const tokenTotal = tokenTotals[wi];
      let col = assignments[String(ws.id)];
      if (typeof col !== "number" || col < -1 || col > 5) col = 0;
      const entry = { id: String(ws.id), title: typeof ws.title === "string" ? ws.title : "", col, sessions, sessionCount, tokenTotal };
      flat.push(entry);
      if (col >= 0 && col <= 5) {
        columns[col].workspaces.push({ id: entry.id, title: entry.title, sessions, sessionCount, tokenTotal });
      }
    }
    return { assignments, columns, workspaces: flat };
  }

  function serveHealth(res) {
    const wsCount = workspaceRegistry && typeof workspaceRegistry.list === "function"
      ? workspaceRegistry.list().length : 0;
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
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

  // 快速构建：只用内存数据 + 磁盘缓存，跳过所有磁盘 IO（冷子代理扫描、标题快照读取）
  // 用于首次请求的 fast path，让前端立即拿到骨架数据渲染
  async function buildDataFast() {
    await Promise.all([ensureConfig(), loadTokenCache(), loadTitleCache()]);
    // 跳过 refreshColdSubagents()，用已有 subagentParent（可能为空，后续 full build 补齐）
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
    const perWs = workspaces.map((ws) => {
      if (!ws || !Array.isArray(ws.sessionIds)) return { all: [], top: [] };
      const visible = ws.sessionIds.filter((id) => !archived.has(String(id)) && !subagentParent.has(String(id)));
      return { all: ws.sessionIds, top: visible };
    });
    const allIds = [];
    for (const { top } of perWs) for (const id of top) allIds.push(id);
    // 只从缓存取标题，missing 的给默认标题（不触发 readTitleSnapshots）
    const titleMap = {};
    for (const id of allIds) {
      const sid = String(id);
      titleMap[sid] = titleCache.get(sid) || "会话 " + sid.slice(0, 6);
    }
    const columns = Array.from({ length: 6 }, (_, index) => ({ index, workspaces: [] }));
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
          title: titleMap[String(id)] || "会话 " + String(id).slice(0, 6),
          active: active.has(String(id)),
          pending: pendingSessions.has(String(id)),
          inputTokens,
          tokenTotal: sessionTokenMap.get(String(id)) || 0,
          tools
        };
      });
      const sessionCount = all.length;
      const tokenTotal = tokenTotals[wi];
      let col = assignments[String(ws.id)];
      if (typeof col !== "number" || col < -1 || col > 5) col = 0;
      const entry = { id: String(ws.id), title: typeof ws.title === "string" ? ws.title : "", col, sessions, sessionCount, tokenTotal };
      flat.push(entry);
      if (col >= 0 && col <= 5) {
        columns[col].workspaces.push({ id: entry.id, title: entry.title, sessions, sessionCount, tokenTotal });
      }
    }
    return { assignments, columns, workspaces: flat };
  }

  async function serveData(res) {
    try {
      const now = Date.now();
      const stale = !_dataCache || _dataDirty || (now - _dataLastBuilt >= DATA_CACHE_TTL_MS);

      // 有缓存就先返回（即使过期），后台刷新
      if (_dataCache) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
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
            if (_bgFailCount >= 3) setError("数据后台刷新连续失败 " + _bgFailCount + " 次");
          })
            .finally(() => { _bgRefreshRunning = false; });
        }
        return;
      }

      // 首次请求，无缓存：fast path 先返回骨架数据（<50ms），后台 full build 补齐
      const fastData = await buildDataFast();
      _dataCache = JSON.stringify(fastData);
      _dataDirty = false;
      _dataLastBuilt = now;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
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
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
    }
  }

  async function serveConfig(req, res) {
    try {
      // P1-1: loopback check for config write
      const remoteAddr = req.socket.remoteAddress;
      if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
        res.statusCode = 403;
        res.end('forbidden');
        return;
      }
      const body = await readBody(req);
      if (body === null) {
        res.statusCode = 413;
        res.setHeader("content-type", "application/json; charset=utf-8");
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
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: "bad body" }));
      }
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
    }
  }

  // ---------- 邮箱接口（Agent Mail / agently-cli） ----------
  function sendJson(res, payload, status = 200) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(payload));
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
    if (code === 3) return { status: "auth_required" };
    return { status: "error", code, message: msg };
  }

  // CLI 是否可用（入口解析为空 = 未安装；不再走 shell 兜底，判定可靠）
  function cliMissing() {
    return !resolveAgentlyEntry();
  }

  async function serveMailMe(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("forbidden");
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
    if (!isLoopback(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("forbidden");
      return;
    }
    if (cliMissing()) { sendJson(res, mailSetupRequiredError(false)); return; }
    try {
      const url = new URL(req.url, "http://localhost");
      const dirRaw = url.searchParams.get("dir") || "inbox";
      const dir = ["inbox", "sent", "trash", "spam"].includes(dirRaw) ? dirRaw : "inbox";
      const limitRaw = parseInt(url.searchParams.get("limit") || "20", 10);
      const limit = Math.min(Math.max(isNaN(limitRaw) ? 20 : limitRaw, 1), 50);
      const cursor = url.searchParams.get("cursor") || "";
      const args = ["message", "+list", "--dir", dir, "--limit", String(limit)];
      if (url.searchParams.get("unread") === "1") args.push("--is-unread");
      if (cursor) args.push("--cursor", cursor);
      const r = await runAgently(args, { retries: 2 });
      sendJson(res, { ok: !!r.ok, data: r.data || null, error: r.error || null });
    } catch (e) {
      ctx.logger.error('[office][mail] serveMailList error:', e && e.message || e);
      sendJson(res, { ok: false, error: { code: 1, message: e && e.message ? e.message : String(e) } });
    }
  }

  async function serveMailRead(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("forbidden");
      return;
    }
    if (cliMissing()) { sendJson(res, mailSetupRequiredError(false)); return; }
    try {
      const url = new URL(req.url, "http://localhost");
      const id = (url.searchParams.get("id") || "").trim();
      if (!id || id.length > 200) {
        sendJson(res, { ok: false, error: { code: 2, message: "缺少或非法的 message id" } });
        return;
      }
      const r = await runAgently(["message", "+read", "--id", id], { retries: 2 });
      sendJson(res, { ok: !!r.ok, data: r.data || null, error: r.error || null });
    } catch (e) {
      ctx.logger.error('[office][mail] serveMailRead error:', e && e.message || e);
      sendJson(res, { ok: false, error: { code: 1, message: e && e.message ? e.message : String(e) } });
    }
  }

  async function serveMailSend(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, { ok: false, error: { code: 403, message: "forbidden" } }, 403);
      return;
    }
    if (cliMissing()) { sendJson(res, mailSetupRequiredError(false)); return; }
    try {
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
      const r = await runAgently(args);
      sendJson(res, { ok: !!r.ok, data: r.data || null, error: r.error || null });
    } catch (e) {
      ctx.logger.error('[office][mail] serveMailSend error:', e && e.message || e);
      sendJson(res, { ok: false, error: { code: 1, message: e && e.message ? e.message : String(e) } });
    }
  }

  async function serveMailReply(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, { ok: false, error: { code: 403, message: "forbidden" } }, 403);
      return;
    }
    if (cliMissing()) { sendJson(res, mailSetupRequiredError(false)); return; }
    try {
      const payload = await readJsonBody(req);
      if (!payload) { sendJson(res, { ok: false, error: { code: 2, message: "请求体缺失或非法" } }); return; }
      const id = String(payload.id || "").trim();
      const body = String(payload.body || "");
      if (!id || id.length > 200) { sendJson(res, { ok: false, error: { code: 2, message: "缺少或非法的 message id" } }); return; }
      if (!body) { sendJson(res, { ok: false, error: { code: 2, message: "缺少回复正文" } }); return; }
      if (Buffer.byteLength(body, "utf8") > BODY_LIMIT_1MB) { sendJson(res, { ok: false, error: { code: 2, message: "正文超过 1MB 限制" } }); return; }
      const r = await runAgently(["message", "+reply", "--id", id, "--body", body, "--confirmed"]);
      sendJson(res, { ok: !!r.ok, data: r.data || null, error: r.error || null });
    } catch (e) {
      ctx.logger.error('[office][mail] serveMailReply error:', e && e.message || e);
      sendJson(res, { ok: false, error: { code: 1, message: e && e.message ? e.message : String(e) } });
    }
  }

  // ============ 飞书消息流（外部脚本接入，配置驱动，包内零硬编码路径） ============
  // 配置：~/.dsh/office/feishu-config.json
  //   { "scripts": { "sync": "<ingestor.js 绝对路径>", "latest": "<latest.js 绝对路径>" } }
  // 状态：~/.dsh/office/feishu-state.json（lastSync 结果，运行时数据）
  const FEISHU_CONFIG_PATH = join(DATA_DIR, "feishu-config.json");
  const FEISHU_STATE_PATH = join(DATA_DIR, "feishu-state.json");
  const FEISHU_SYNC_TIMEOUT_MS = 5 * 60 * 1000;   // 全量轮询 + embedding 可能较久
  const FEISHU_LATEST_TIMEOUT_MS = 30 * 1000;

  let feishuSyncing = false;        // 防叠进程（内存态）
  let feishuLastSync = null;        // { added, skipped, total, elapsed, at }

  async function loadFeishuState() {
    try {
      const parsed = JSON.parse(await readFile(FEISHU_STATE_PATH, "utf8"));
      if (parsed && parsed.lastSync) feishuLastSync = parsed.lastSync;
    } catch (e) { /* 首次运行无状态 */ }
  }
  function saveFeishuState() {
    mkdir(DATA_DIR, { recursive: true })
      .then(() => writeFile(FEISHU_STATE_PATH, JSON.stringify({ lastSync: feishuLastSync }), "utf8"))
      .catch(e => console.warn('[office] feishu state save failed:', e?.message || e));
  }
  loadFeishuState();

  // 每次读取配置（文件很小，不缓存，保证「重新检测」即时生效）
  // 剥离 BOM：用户手写/编辑器可能带 UTF-8 BOM，JSON.parse 会失败
  function loadFeishuConfig() {
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
          intervalMin: Math.min(Math.max(parseInt(autoSyncRaw.intervalMin, 10) || 30, 5), 1440)
        };
        // 可选：手动同步的深捞窗口（天），默认 30
        const manualWindowDays = Math.min(Math.max(parseInt(parsed.manualWindowDays, 10) || 30, 1), 90);
        return { sync, latest, mention, autoSync, manualWindowDays };
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
          configPath: "~/.dsh/office/feishu-config.json",
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
        timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true
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
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("forbidden");
      return;
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
    return (cfg && cfg.autoSync) || { enabled: false, intervalMin: 30 };
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
      const days = (cfg.manualWindowDays && cfg.manualWindowDays > 0) ? cfg.manualWindowDays : 30;
      const since = localTimeString(new Date(Date.now() - days * 24 * 3600 * 1000));
      args = ["--since", since, "--window-hours", String(days * 24)];
    }
    feishuSyncing = true;
    spawnNodeScript(cfg.sync, args, FEISHU_SYNC_TIMEOUT_MS).then(({ error, stdout, stderr }) => {
      const parsed = parseIngestorResult(stdout);
      if (parsed) {
        feishuLastSync = { ...parsed, at: localTimeString() };
        saveFeishuState();
        ctx.logger.info('[office][feishu] 同步完成:', JSON.stringify(feishuLastSync));
        if (opts.auto && beforeAt && cfg.mention && cfg.mention.length) {
          scanFeishuMention(cfg, beforeAt);
        }
      } else {
        ctx.logger.warn('[office][feishu] 同步未识别到结果行:', ((error && error.message) || '') + (stderr ? ' | ' + stderr.slice(0, 300) : ''));
      }
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
              hit = { chat: c.chat_name || c.chat_id || '', sender: m.sender_name || '', snippet: t.slice(0, 40) };
              break;
            }
          }
          if (hit) break;
        }
        if (hit) break;
      }
      if (hit) {
        feishuNotice = { at: localTimeString(), count: 1, chat: hit.chat, keyword: cfg.mention[0] };
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
    return Math.max(1000, targetDate.getTime() - now.getTime());
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
      sendJson(res, { ok: false, error: { code: 403, message: "forbidden" } }, 403);
      return;
    }
    const cfg = loadFeishuConfig();
    if (!cfg) { sendJson(res, feishuSetupError()); return; }
    if (feishuSyncing) { sendJson(res, { ok: false, error: { code: "SYNC_IN_PROGRESS", message: "同步进行中，请稍候" } }); return; }
    // mode=incr（惰性补同步用）→ 增量；缺省（手动按钮）→ 深捞 manualWindowDays 天
    const url = new URL(req.url, "http://localhost");
    const mode = url.searchParams.get("mode") || "manual";
    const started = triggerFeishuSync(cfg, mode === "incr" ? { auto: true } : { manual: true });
    if (!feishuAutoTimer) scheduleFeishuAutoSync();      // 配置中途开启时，靠手动同步/面板打开补臂
    sendJson(res, { ok: started, data: { started } });
  }

  async function serveFeishuMessages(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, { ok: false, error: { code: 403, message: "forbidden" } }, 403);
      return;
    }
    const cfg = loadFeishuConfig();
    if (!cfg) { sendJson(res, feishuSetupError()); return; }
    try {
      const url = new URL(req.url, "http://localhost");
      const perChatRaw = parseInt(url.searchParams.get("per-chat") || "20", 10);
      const perChat = Math.min(Math.max(isNaN(perChatRaw) ? 20 : perChatRaw, 1), 50);
      const since = (feishuLastSync && feishuLastSync.at) || "";
      const args = ["--per-chat", String(perChat)];
      if (since) args.push("--since", since);
      const { error, stdout } = await spawnNodeScript(cfg.latest, args, FEISHU_LATEST_TIMEOUT_MS);
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch (e) { parsed = null; }
      if (parsed && parsed.ok) {
        sendJson(res, { ok: true, data: { total: parsed.total, since: parsed.since, chats: parsed.chats || [] } });
      } else {
        sendJson(res, { ok: false, error: { code: 1, message: (parsed && parsed.error) || ((error && error.message) || "读取消息失败") } });
      }
    } catch (e) {
      sendJson(res, { ok: false, error: { code: 1, message: e && e.message ? e.message : String(e) } });
    }
  }

  // 整点定时链已由 scheduleFeishuAutoSync 管理（无 60s 轮询监听）

  // P1-1/P1-2: cleanup interval/timer on dispose
  ctx.effect(() => {
    return () => {
      if (_cleanupInterval) clearInterval(_cleanupInterval);
      if (_saveTitleTimer) clearTimeout(_saveTitleTimer);
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
        return serveHtml(res);
      }
    });
    ctx.effect(() => dispose, "office: http routes");
  } catch (e) {
    ctx.logger.error("[office] webServer.register 失败:", e);
  }
}

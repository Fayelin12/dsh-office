import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  } catch (e) { /* ignore */ }
  for (const base of candidates) {
    const entry = join(base, ...AGENTLY_ENTRY_REL);
    if (existsSync(entry)) {
      _agentlyEntry = entry;
      return entry;
    }
  }
  _agentlyEntry = "";
  return "";
}

// cmd.exe 引号转义（仅兜底路径使用）
function cmdQuote(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

// 执行 agently-cli：resolve CLI 的 JSON envelope（{ok, data|error}）
function runAgently(args, opts = {}) {
  return new Promise((resolve) => {
    const onDone = (error, stdout, stderr) => {
      let parsed = null;
      try {
        const text = String(stdout || "").trim();
        if (text) parsed = JSON.parse(text);
      } catch (e) { parsed = null; }
      if (parsed && typeof parsed === "object") {
        resolve(parsed);
        return;
      }
      const detail = (error && error.message ? error.message : "") +
        (stderr ? (error ? " | " : "") + String(stderr).trim() : "");
      resolve({ ok: false, error: { code: (error && error.code) || 1, message: detail || "agently-cli 无输出" } });
    };
    const entry = resolveAgentlyEntry();
    const common = { timeout: opts.timeout || 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
    if (entry) {
      execFile(process.execPath, [entry, ...args], common, onDone);
    } else {
      exec(["agently-cli", ...args].map(cmdQuote).join(" "), common, onDone);
    }
  });
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

  const assignments = {};
  let configLoaded = false;
  let pendingOpenSession = null;
  let pendingSessions = new Set();

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
    setInterval(() => {
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

  // 标题缓存：历史会话标题不变则缓存，active 会话实时读（标题可能变）
  // 落盘持久化，进程重启后第一次打开不用全量读日志
  const titleCache = new Map();
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

  async function fetchTitles(ids, activeSet) {
    const result = {};
    const missing = [];
    for (const id of ids) {
      const sid = String(id);
      if (titleCache.has(sid) && !activeSet.has(sid)) {
        result[sid] = titleCache.get(sid);
      } else {
        missing.push(sid);
      }
    }
    if (missing.length && sessionQuery && typeof sessionQuery.readTitleSnapshots === "function") {
      try {
        const res = await sessionQuery.readTitleSnapshots(missing);
        let added = false;
        for (const r of res || []) {
          if (r && r.status === "fulfilled" && r.value && r.value.title && r.value.title.title) {
            const sid = String(r.sessionId);
            result[sid] = r.value.title.title;
            if (!activeSet.has(sid)) {
              titleCache.set(sid, r.value.title.title);
              evictOldest(titleCache, MAX_TITLE_CACHE);
              added = true;
            }
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
  async function readBody(req, maxBytes = 1_048_576) {
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
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
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
  const subagentParent = new Map();
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
    if (now - coldSubagentsLoadedAt < 30000) return;
    coldSubagentsLoadedAt = now;
    if (sessionPersistence && typeof sessionPersistence.list === "function") {
      try {
        const headers = await sessionPersistence.list();
        for (const h of headers) {
          if (h && h.id != null && h.parentSession != null) {
            subagentParent.set(String(h.id), String(h.parentSession));
          }
        }
      } catch (e) { console.warn('[office]', e?.message || e); }
    }
  }

  // P2-2: dirty flag + cache for buildData — only rebuild when state changes
  let _dataCache = null;
  let _dataDirty = true;
  let _dataLastBuilt = 0;
  const DATA_CACHE_TTL_MS = 30000; // stale-while-revalidate: serve old data up to 30s, refresh in background
  let _bgRefreshRunning = false;
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
      coldReadRunning,
      lastError,
      lastErrorAt
    }));
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
            _dataCache = JSON.stringify(data);
            _dataDirty = false;
            _dataLastBuilt = Date.now();
          }).catch(e => console.warn('[office] bg refresh failed:', e?.message || e))
            .finally(() => { _bgRefreshRunning = false; });
        }
        return;
      }

      // 首次请求，无缓存：阻塞构建
      const data = await buildData();
      _dataCache = JSON.stringify(data);
      _dataDirty = false;
      _dataLastBuilt = now;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(_dataCache);
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
        Object.assign(assignments, parsed.assignments);
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
    const body = await readBody(req, 2 * 1024 * 1024);
    if (body === null) return null;
    try { return JSON.parse(body); } catch (e) { return null; }
  }

  async function serveMailMe(res) {
    const r = await runAgently(["+me"]);
    if (r && r.ok && r.data && Array.isArray(r.data.aliases) && r.data.aliases.length) {
      sendJson(res, { ok: true, data: { email: r.data.aliases[0].email, name: r.data.aliases[0].name || "" } });
    } else {
      sendJson(res, { ok: false, error: (r && r.error) || { code: 1, message: "获取邮箱信息失败" } });
    }
  }

  async function serveMailList(req, res) {
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
      const r = await runAgently(args);
      sendJson(res, { ok: !!r.ok, data: r.data || null, error: r.error || null });
    } catch (e) {
      sendJson(res, { ok: false, error: { code: 1, message: e && e.message ? e.message : String(e) } });
    }
  }

  async function serveMailRead(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      const id = (url.searchParams.get("id") || "").trim();
      if (!id || id.length > 200) {
        sendJson(res, { ok: false, error: { code: 2, message: "缺少或非法的 message id" } });
        return;
      }
      const r = await runAgently(["message", "+read", "--id", id]);
      sendJson(res, { ok: !!r.ok, data: r.data || null, error: r.error || null });
    } catch (e) {
      sendJson(res, { ok: false, error: { code: 1, message: e && e.message ? e.message : String(e) } });
    }
  }

  async function serveMailSend(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, { ok: false, error: { code: 403, message: "forbidden" } }, 403);
      return;
    }
    try {
      const payload = await readJsonBody(req);
      if (!payload) { sendJson(res, { ok: false, error: { code: 2, message: "请求体缺失或非法" } }); return; }
      const to = Array.isArray(payload.to) ? payload.to.map((t) => String(t).trim()).filter(Boolean) : [];
      const subject = String(payload.subject || "").trim();
      const body = String(payload.body || "");
      if (!to.length) { sendJson(res, { ok: false, error: { code: 2, message: "缺少收件人" } }); return; }
      if (!subject) { sendJson(res, { ok: false, error: { code: 2, message: "缺少主题" } }); return; }
      if (!body) { sendJson(res, { ok: false, error: { code: 2, message: "缺少正文" } }); return; }
      if (Buffer.byteLength(body, "utf8") > 1024 * 1024) { sendJson(res, { ok: false, error: { code: 2, message: "正文超过 1MB 限制" } }); return; }
      const args = ["message", "+send", "--confirmed", "--subject", subject, "--body", body];
      for (const addr of to) args.push("--to", addr);
      const r = await runAgently(args);
      sendJson(res, { ok: !!r.ok, data: r.data || null, error: r.error || null });
    } catch (e) {
      sendJson(res, { ok: false, error: { code: 1, message: e && e.message ? e.message : String(e) } });
    }
  }

  async function serveMailReply(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, { ok: false, error: { code: 403, message: "forbidden" } }, 403);
      return;
    }
    try {
      const payload = await readJsonBody(req);
      if (!payload) { sendJson(res, { ok: false, error: { code: 2, message: "请求体缺失或非法" } }); return; }
      const id = String(payload.id || "").trim();
      const body = String(payload.body || "");
      if (!id || id.length > 200) { sendJson(res, { ok: false, error: { code: 2, message: "缺少或非法的 message id" } }); return; }
      if (!body) { sendJson(res, { ok: false, error: { code: 2, message: "缺少回复正文" } }); return; }
      if (Buffer.byteLength(body, "utf8") > 1024 * 1024) { sendJson(res, { ok: false, error: { code: 2, message: "正文超过 1MB 限制" } }); return; }
      const r = await runAgently(["message", "+reply", "--id", id, "--body", body, "--confirmed"]);
      sendJson(res, { ok: !!r.ok, data: r.data || null, error: r.error || null });
    } catch (e) {
      sendJson(res, { ok: false, error: { code: 1, message: e && e.message ? e.message : String(e) } });
    }
  }

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
        if (pathname === "/office-ui/mail/me") return serveMailMe(res);
        if (pathname === "/office-ui/mail/list") return serveMailList(req, res);
        if (pathname === "/office-ui/mail/read") return serveMailRead(req, res);
        if (pathname === "/office-ui/mail/send") return serveMailSend(req, res);
        if (pathname === "/office-ui/mail/reply") return serveMailReply(req, res);
        return serveHtml(res);
      }
    });
    ctx.effect(() => dispose, "office: http routes");
  } catch (e) {
    ctx.logger.error("[office] webServer.register 失败:", e);
  }
}

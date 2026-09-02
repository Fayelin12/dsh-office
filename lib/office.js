import { join, sep } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  ASSETS_DIR, DATA_DIR, HTML_PATH, BUBBLE_TEXTS_PATH, CONFIG_PATH, TOKEN_USAGE_PATH, TITLE_CACHE_PATH,
  MAX_TOKEN_CACHE, MAX_TITLE_CACHE, MAX_TOKEN_DISK_ENTRIES, MAX_TITLE_DISK_ENTRIES,
  BODY_LIMIT_1MB, BODY_LIMIT_2MB, COLD_SUBAGENT_THROTTLE_MS,
  CACHE_CLEANUP_INTERVAL_MS, SAVE_DEBOUNCE_MS, COLD_READ_BATCH_SIZE, COLD_SNAPSHOT_TIMEOUT_MS,
  BG_REFRESH_MAX_FAIL_COUNT, BG_REFRESH_WARN_THRESHOLD, UPCOMING_MEETING_WINDOW_MIN,
  LAYOUT_COLUMN_COUNT, RECENT_TOOL_NAMES_LIMIT, SESSION_ID_PREFIX_LENGTH,
  DEFAULT_SESSION_TITLE_PREFIX,
  OFFICE_LOG_MAX, OFFICE_LOG_LEVELS,
  CT_JSON, CT_TEXT, CT_HTML, CT_BINARY, CACHE_NO_STORE, CACHE_PUBLIC_1H
} from "./constants.js";
import { sendForbidden, extractParentEntry, evictOldest, isLoopback, localIPv4 } from "./util.js";

export function register(runtime) {
  const { ctx, services } = runtime;
  const shared = runtime.shared;
  const {
    workspaceRegistry, sessionQuery, agents, sessionsSvc, tokenMeter,
    sessionProjections, projectionCache, sessionPersistence, connection
  } = services;

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

  function errMsg(e) { return e && e.message ? e.message : String(e); }
  async function ensureDataDir() { await mkdir(DATA_DIR, { recursive: true }); }

  const assignments = {};
  let configLoaded = false;
  let pendingOpenSession = null;
  let pendingSessions = new Set();
  let _cleanupInterval = null;

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
        if (endpoint === "consume-create-session") {
          // 转会话指令（{ workspaceId, promptText }）——Client 消费后执行 sessions.create/prompt/open
          const p = shared.pendingCreateSession;
          shared.pendingCreateSession = null;
          return { ok: true, value: p };
        }
        if (endpoint === "set-pending") {
          pendingSessions = new Set((payload && payload.ids) || []);
          markDataDirty();
          return { ok: true, value: null };
        }
        if (endpoint === "feishu-notice") {
          // 悬浮按钮「📢 飞书收到@你的消息」提示（定时同步后扫描到提及）
          const n = shared.feishuNotice;
          return { ok: true, value: n ? { at: n.at, count: n.count, chat: n.chat, keyword: n.keyword, sender: n.sender, snippet: n.snippet } : null };
        }
        if (endpoint === "calendar-notice") {
          // ⏰ 会议提醒：缓存过期则惰性补拉一次，然后返回「未来 2 小时内开始的会议」
          const cfg = shared.loadFeishuConfig();
          if (cfg && cfg.calendar && (shared.calendar.events == null || shared.calendar.cacheStale())) {
            await shared.calendar.syncCalendar(cfg);
          }
          const upcoming = shared.calendar.upcoming(shared.calendar.events, UPCOMING_MEETING_WINDOW_MIN);
          return { ok: true, value: upcoming.length ? {
            fetchedAt: shared.calendar.fetchedAt,
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

  // content-type 映射（前端拆分前置）：js/css/json/png 有明确类型，其余 octet-stream
  function assetContentType(rel) {
    if (rel.endsWith(".js")) return "text/javascript";
    if (rel.endsWith(".css")) return "text/css";
    if (rel.endsWith(".json")) return "application/json";
    if (rel.endsWith(".png")) return "image/png";
    return CT_BINARY;
  }

  // cache-control（前端拆分前置）：js/css 改 no-store 保证刷新即生效；png 保持 1h；其余 no-store
  function assetCacheControl(rel) {
    if (rel.endsWith(".png")) return CACHE_PUBLIC_1H;
    return CACHE_NO_STORE;
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
      res.setHeader("content-type", assetContentType(rel));
      res.setHeader("cache-control", assetCacheControl(rel));
      res.end(bytes);
    } catch (e) {
      res.statusCode = 404;
      res.setHeader("content-type", CT_TEXT);
      res.end("asset not found: " + rel);
    }
  }

  // 每次请求直接读文件（低频率接口），避免内存缓存导致改文件后刷新不生效
  async function serveBubbleTexts(_req, res) {
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
    return { assignments, columns, workspaces: flat, localIP: localIPv4() };
  }

  function serveHealth(_req, res) {
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

  async function serveData(_req, res) {
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

  // ---------- 通用 JSON 响应工具（跨模块共享，经 runtime.shared 传递） ----------
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

  // P1-1/P1-2: cleanup interval/timer on dispose（缓存清理/调度 → office.js）
  ctx.effect(() => {
    return () => {
      if (_cleanupInterval) clearInterval(_cleanupInterval);
      scheduleSaveTitleCache.cancel();
      scheduleSaveTokenCache.cancel();
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

  // 注入跨模块共享契约（office.js 拥有）
  shared.appendOfficeLog = appendOfficeLog;
  shared.sendJson = sendJson;
  shared.sendJsonForbidden = sendJsonForbidden;
  shared.readJsonBody = readJsonBody;
  shared.errMsg = errMsg;
  shared.ensureDataDir = ensureDataDir;
  shared.serveAsset = serveAsset;
  shared.serveHtml = serveHtml;

  const routes = {
    "/office-ui/data": serveData,
    "/office-ui/config": serveConfig,
    "/office-ui/open-session": serveOpenSession,
    "/office-ui/health": serveHealth,
    "/office-ui/bubble-texts": serveBubbleTexts,
    "/office-ui/logs": serveOfficeLogs,
  };

  return { routes };
}

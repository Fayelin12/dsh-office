import { join, resolve, sep, basename } from "node:path";
import { mkdir, readFile, readdir, writeFile, copyFile, rename, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  DATA_DIR, FEISHU_CONFIG_PATH_DISPLAY, FEISHU_RESOURCE_DEFAULT_DIR, FEISHU_RESOURCE_TIMEOUT_MS,
  FEISHU_RESOURCE_KEY_MAX_LENGTH, CACHE_PUBLIC_1D, MENTION_SNIPPET_LENGTH,
  FEISHU_MANUAL_WINDOW_DAYS_DEFAULT, FEISHU_AUTOSYNC_INTERVAL_MIN_DEFAULT, FEISHU_AUTOSYNC_INTERVAL_MIN_MIN,
  FEISHU_AUTOSYNC_INTERVAL_MIN_MAX, FEISHU_MANUAL_WINDOW_DAYS_MIN, FEISHU_MANUAL_WINDOW_DAYS_MAX,
  FEISHU_SYNC_TIMEOUT_MS, FEISHU_LATEST_TIMEOUT_MS,
  STDERR_LOG_SLICE_LENGTH, INSIGHTS_WINDOW_DAYS_DEFAULT, INSIGHTS_WINDOW_DAYS_MAX, INSIGHTS_TODOS_TOP_DEFAULT,
  INSIGHTS_TODOS_TOP_MAX, INSIGHTS_HIGHLIGHTS_TOP_DEFAULT, INSIGHTS_HIGHLIGHTS_TOP_MAX,
  INSIGHTS_UNREPLIED_HOURS_DEFAULT, INSIGHTS_UNREPLIED_HOURS_MAX, FEISHU_PER_CHAT_DEFAULT_LIMIT,
  FEISHU_PER_CHAT_MAX_LIMIT, UPCOMING_MEETING_WINDOW_MIN, ONGOING_MEETING_GRACE_MIN, CALENDAR_CACHE_MAX_AGE_MS,
  CALENDAR_SYNC_TIMEOUT_MS, CALENDAR_DAYS_DEFAULT, CALENDAR_HISTORY_DAYS_DEFAULT,
  NEXT_SYNC_MIN_DELAY_MS, TRANSCRIPTS_DIR, TRANSCRIPTS_STATE_PATH, TRANSCRIPT_TIMEOUT_MS,
  TRANSCRIPT_RETRY_COOLDOWN_MS, TRANSCRIPT_BATCH_MAX, PERMISSION_TIMEOUT_MS, URL_PARSE_BASE, MAX_BUFFER_16MB
} from "./constants.js";
import { isLoopback } from "./util.js";

export function register(runtime) {
  const { ctx } = runtime;
  const shared = runtime.shared;
  const { sendJson, sendJsonForbidden, readJsonBody, errMsg, ensureDataDir } = shared;

  // ============ 飞书消息流（外部脚本接入，配置驱动，包内零硬编码路径） ============
  // 配置：~/.dsh/office/feishu-config.json
  //   { "scripts": { "sync": "<ingestor.js 绝对路径>", "latest": "<latest.js 绝对路径>" } }
  // 状态：~/.dsh/office/feishu-state.json（lastSync 结果，运行时数据）
  const FEISHU_CONFIG_PATH = join(DATA_DIR, "feishu-config.json");
  const FEISHU_STATE_PATH = join(DATA_DIR, "feishu-state.json");
  // 会议日程缓存（scripts.calendar 脚本输出）：随消息同步顺带拉取，供 📅 会议视图 + ⏰ 提醒
  const CALENDAR_CACHE_PATH = join(DATA_DIR, "calendar-cache.json");

  let feishuNotice = null;          // 定时同步后检测到「提到我」的悬浮提示（{at,count,chat,keyword}）
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
    if (!cfg || !cfg.transcript || transcriptSyncing || !Array.isArray(calendarEvents)) {
      ctx.logger.warn('[office][transcript] ensureTranscripts 跳过:', JSON.stringify({
        hasCfg: !!cfg, hasScript: !!(cfg && cfg.transcript), syncing: transcriptSyncing,
        eventsArr: Array.isArray(calendarEvents), eventsCount: Array.isArray(calendarEvents) ? calendarEvents.length : -1
      }));
      return;
    }
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
      ctx.logger.info('[office][transcript] 自动拉取候选:', candidates.length, '场:', candidates.map((c) => c.summary).join(',') || '无');
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
        // 可选：每日洞察脚本（insights.js 绝对路径）。配置后，💡 洞察视图可生成三类洞察（待办/未回复/高价值讨论）
        const insights = (typeof parsed.scripts.insights === "string" && parsed.scripts.insights.trim() && existsSync(parsed.scripts.insights.trim()))
          ? parsed.scripts.insights.trim() : "";
        // 可选：insights 参数段（窗口/条数/未回复时长/身份/LLM 端点；key 走 dsh credentials）
        const iRaw = (parsed.insights && typeof parsed.insights === "object") ? parsed.insights : {};
        const insightsOpts = {
          windowDays: Math.min(Math.max(parseInt(iRaw.windowDays, 10) || INSIGHTS_WINDOW_DAYS_DEFAULT, 1), INSIGHTS_WINDOW_DAYS_MAX),
          todosTop: Math.min(Math.max(parseInt(iRaw.todosTop, 10) || INSIGHTS_TODOS_TOP_DEFAULT, 1), INSIGHTS_TODOS_TOP_MAX),
          highlightsTop: Math.min(Math.max(parseInt(iRaw.highlightsTop, 10) || INSIGHTS_HIGHLIGHTS_TOP_DEFAULT, 1), INSIGHTS_HIGHLIGHTS_TOP_MAX),
          unrepliedHours: Math.min(Math.max(parseInt(iRaw.unrepliedHours, 10) || INSIGHTS_UNREPLIED_HOURS_DEFAULT, 1), INSIGHTS_UNREPLIED_HOURS_MAX),
          selfUserId: (typeof iRaw.selfUserId === "string" && iRaw.selfUserId.trim()) ? iRaw.selfUserId.trim() : "",
          llmEndpoint: (typeof iRaw.llmEndpoint === "string" && iRaw.llmEndpoint.trim()) ? iRaw.llmEndpoint.trim() : "",
          llmModel: (typeof iRaw.llmModel === "string" && iRaw.llmModel.trim()) ? iRaw.llmModel.trim() : ""
        };
        const result = {
          sync, latest, mention, autoSync, manualWindowDays, profile, manualMinutes,
          calendar: (typeof calendar === "string" && calendar.trim() && existsSync(calendar)) ? calendar.trim() : "",
          transcript: (typeof transcript === "string" && transcript.trim() && existsSync(transcript)) ? transcript.trim() : "",
          permission: (typeof permission === "string" && permission.trim() && existsSync(permission)) ? permission.trim() : "",
          resourceDir: (typeof parsed.resourceDir === "string" && parsed.resourceDir.trim())
            ? parsed.resourceDir.trim() : FEISHU_RESOURCE_DEFAULT_DIR,
          insights, insightsOpts
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

  // 直接以 Node 执行本地脚本（无 shell，防注入）；execFilePromise 的特例（固定 process.execPath）
  function spawnNodeScript(scriptPath, args, timeoutMs, extraEnv) {
    const opts = { timeout: timeoutMs, maxBuffer: MAX_BUFFER_16MB, windowsHide: true };
    if (extraEnv) opts.env = { ...process.env, ...extraEnv };
    return execFilePromise(process.execPath, [scriptPath, ...args], opts);
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
        // 同步入库完成后通知订阅方（如「🤖 群聊助理」：取本次新消息过 LLM 门控 → 开 dsh 任务）
        // 订阅方由 larkbot.js register 时注入 shared.onFeishuSynced
        try {
          if (typeof shared.onFeishuSynced === "function") {
            shared.onFeishuSynced();
          }
        } catch (e) {
          ctx.logger.warn('[office][larkbot] 同步后处理钩子异常:', e && e.message || e);
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
          // 只扫本次新入库（created_at > since）的消息；latest.js 全量路径返回的 messages 已按 since 过滤，
          // 这里再兜底一次，防止用户脚本未按 since 过滤时旧 @ 消息在每次整点同步重复通知
          if (since && m && m.created_at && String(m.created_at) <= String(since)) continue;
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

  // ============ 飞书消息资源（图片/文件）本地缓存 + 查看/打开 ============
  // GET /office-ui/feishu/resource?msg=<message_id>&key=<resource_key>&type=image|file  → 返回文件流（图片内联 / 新标签打开）
  // GET /office-ui/feishu/resource/open?msg=<message_id>&key=<resource_key>&type=file   → 用系统默认程序打开本地缓存
  // 缓存目录：feishu-config.resourceDir 覆盖，默认 ~/.dsh/office/feishu-resources；文件名 = resource_key（扩展名由 lark-cli 推断）
  // 语义召回隔离：资源消息不入 msg_embeddings，这里只做本地缓存与查看/打开，与召回无关
  // 资源已全部缓存本地，前端无需浏览器下载；文件「打开」= 系统默认程序（md→编辑器 / pptx→PowerPoint / zip→资源管理器）
  // 解析资源请求公共参数（loopback + 配置 + msg/key/type 校验）
  // 返回 { ok:true, cfg, msgId, key, type } 或 { ok:false }（已发送错误响应）
  async function parseResourceRequest(req, res, allowedTypes) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJsonForbidden(res);
      return { ok: false };
    }
    const cfg = loadFeishuConfig();
    if (!cfg) { sendJson(res, feishuSetupError()); return { ok: false }; }
    const url = new URL(req.url, URL_PARSE_BASE);
    const msgId = (url.searchParams.get("msg") || "").trim();
    const key = (url.searchParams.get("key") || "").trim();
    const type = (url.searchParams.get("type") || "").trim();
    if (!msgId || !key || !allowedTypes.includes(type)) {
      sendJson(res, { ok: false, error: { code: "BAD_REQUEST", message: "参数缺失或非法（msg/key/type=" + allowedTypes.join("|") + "）" } }, 400);
      return { ok: false };
    }
    if (!isValidResourceKey(key)) {
      sendJson(res, { ok: false, error: { code: "BAD_REQUEST", message: "resource_key 非法" } }, 400);
      return { ok: false };
    }
    return { ok: true, cfg, msgId, key, type };
  }

  async function serveFeishuResource(req, res) {
    const p = await parseResourceRequest(req, res, ["image", "file"]);
    if (!p.ok) return;
    const { cfg, msgId, key, type } = p;
    try {
      const file = await ensureResourceFile(cfg, msgId, key, type);
      if (!file.ok) { sendJson(res, { ok: false, error: file.error }); return; }
      const data = await readFile(file.path);
      const ctype = type === "image" ? guessImageContentType(file.path) : "application/octet-stream";
      res.statusCode = 200;
      res.setHeader("content-type", ctype);
      res.setHeader("cache-control", CACHE_PUBLIC_1D);  // 同 key 资源不变，缓存 1 天
      res.setHeader("x-office-resource", basename(file.path));
      res.end(data);
    } catch (e) {
      ctx.logger.warn('[office][feishu] 资源处理异常:', errMsg(e));
      sendJson(res, { ok: false, error: { code: 1, message: errMsg(e) } });
    }
  }

  // 用系统默认程序打开本地缓存的资源文件（仅 file 类型；image 走浏览器内联渲染）
  async function serveFeishuResourceOpen(req, res) {
    const p = await parseResourceRequest(req, res, ["file"]);
    if (!p.ok) return;
    const { cfg, msgId, key, type } = p;
    try {
      // 确保本地缓存存在（未命中先下载）；ensureResourceFile 已保证路径在缓存目录内
      const file = await ensureResourceFile(cfg, msgId, key, type);
      if (!file.ok) { sendJson(res, { ok: false, error: file.error }); return; }
      // 用系统默认程序打开（fire-and-forget：GUI 程序不退出，不能等 close）。
      // Windows：cmd /c start "" "path"；macOS/Linux：xdg-open / open
      const opened = openWithDefaultApp(file.path);
      if (!opened) {
        sendJson(res, { ok: false, error: { code: "OPEN_FAILED", message: "无法调用系统默认程序打开文件" } });
        return;
      }
      ctx.logger.info('[office][feishu] 资源已用系统默认程序打开:', basename(file.path));
      sendJson(res, { ok: true, data: { opened: basename(file.path) } });
    } catch (e) {
      ctx.logger.warn('[office][feishu] 资源打开异常:', errMsg(e));
      sendJson(res, { ok: false, error: { code: 1, message: errMsg(e) } });
    }
  }

  // 资源 key 白名单（防路径注入）：字母数字下划线点横线，长度受限
  function isValidResourceKey(key) {
    return key.length <= FEISHU_RESOURCE_KEY_MAX_LENGTH && /^[A-Za-z0-9_.-]+$/.test(key);
  }

  // 确保资源文件在本地缓存：命中返回 { ok:true, path }；未命中 spawn lark-cli 下载后返回
  // 返回的 path 恒为缓存目录内的绝对路径（相对/绝对 saved_path 统一 resolve + 目录包含校验）
  async function ensureResourceFile(cfg, msgId, key, type) {
    const dir = resolve(join(cfg.resourceDir, type));
    await mkdir(dir, { recursive: true });
    // 1) 缓存命中：key 前缀文件（lark-cli 保存为 {key}.{ext}，扩展名不确定，按前缀扫）
    const cached = await findResourceFile(dir, key);
    if (cached) return { ok: true, path: cached };
    // 2) 未命中：spawn lark-cli 下载（--output 传无扩展名前缀 → lark-cli 追加推断扩展名，如 .webp/.zip）
    //    cwd = 缓存目录（命令只允许相对路径输出）
    const runJs = resolveLarkCliRunJs();
    if (!runJs) {
      return { ok: false, error: { code: "LARK_CLI_REQUIRED", message: "未找到 lark-cli（@larksuite/cli），无法获取资源" } };
    }
    const dl = await execFilePromise(process.execPath, [
      runJs, "--profile", cfg.profile || "default", "im", "+messages-resources-download",
      "--as", "user", "--message-id", msgId, "--file-key", key, "--type", type,
      "--output", key, "--format", "json"
    ], { cwd: dir, timeout: FEISHU_RESOURCE_TIMEOUT_MS, maxBuffer: MAX_BUFFER_16MB, windowsHide: true });
    if (dl.error) {
      ctx.logger.warn('[office][feishu] 资源获取失败:', (dl.error && dl.error.message) || 'exit ' + dl.error.code, '| stderr:', String(dl.stderr || '').slice(0, STDERR_LOG_SLICE_LENGTH));
      return { ok: false, error: { code: "RESOURCE_DOWNLOAD_FAILED", message: "资源获取失败（可能无权限或已过期）" } };
    }
    // 解析 lark-cli 输出：成功走 stdout JSON（含 saved_path）；错误 JSON 走 stderr
    let parsed = null;
    try { parsed = JSON.parse(String(dl.stdout).trim()); } catch (e) { parsed = null; }
    if (!(parsed && parsed.ok && parsed.data && parsed.data.saved_path)) {
      ctx.logger.warn('[office][feishu] 资源下载响应异常:', String(dl.stdout || dl.stderr || '').slice(0, STDERR_LOG_SLICE_LENGTH));
      return { ok: false, error: { code: "RESOURCE_DOWNLOAD_FAILED", message: "资源获取失败（请检查飞书授权 scope）" } };
    }
    // saved_path 可能是相对（相对 cwd=dir）或绝对路径：统一 resolve 到 dir 下
    const finalPath = resolve(dir, String(parsed.data.saved_path));
    if (!existsSync(finalPath) || !finalPath.startsWith(dir + sep)) {
      return { ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "资源文件未找到" } };
    }
    return { ok: true, path: finalPath };
  }

  // 在缓存目录下按 key 前缀找资源文件（扩展名由 lark-cli 推断，可能为 .webp/.png/.zip 等）
  async function findResourceFile(dir, key) {
    const entries = await readdirSafe(dir);
    if (!entries) return null;
    for (const name of entries) {
      if (name === key || name.startsWith(key + ".")) {
        const full = join(dir, name);
        if (existsSync(full)) return full;
      }
    }
    return null;
  }

  function guessImageContentType(filePath) {
    const lower = String(filePath || "").toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    return "image/webp";   // lark-cli 图片默认 webp
  }

  // 只读目录列举（目录不存在/无权限返回 null）
  async function readdirSafe(dir) {
    try {
      return await readdir(dir);
    } catch (e) {
      return null;
    }
  }
  // 找 lark-cli run.js（与 scripts/lark-cli.js 的 resolveRunJs 同逻辑，互指维护）
  // 差异说明：本版不含本机私有路径候选（隐私红线）；scripts/lark-cli.js 含 D:\npm-global（本机工具脚本约定值）
  function resolveLarkCliRunJs() {
    const candidates = [];
    if (process.env.LARK_CLI_RUN_JS && existsSync(process.env.LARK_CLI_RUN_JS)) candidates.push(process.env.LARK_CLI_RUN_JS);
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "npm", "node_modules", "@larksuite", "cli", "scripts", "run.js"));
    if (process.env.npm_config_prefix) candidates.push(join(process.env.npm_config_prefix, "node_modules", "@larksuite", "cli", "scripts", "run.js"));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "npm", "node_modules", "@larksuite", "cli", "scripts", "run.js"));
    if (process.platform !== "win32") {
      candidates.push("/usr/local/lib/node_modules/@larksuite/cli/scripts/run.js");
      candidates.push("/usr/lib/node_modules/@larksuite/cli/scripts/run.js");
    }
    for (const c of candidates) if (existsSync(c)) return c;
    return "";
  }

  function execFilePromise(file, args, opts) {
    return new Promise((resolve) => {
      execFile(file, args, opts, (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    });
  }

  // 用系统默认程序打开本地文件（fire-and-forget，不等 GUI 程序退出）
  // Windows: cmd /c start "" "path"（start 是 cmd 内建）；macOS: open；Linux: xdg-open
  // spawn 失败（平台工具缺失等）走 'error' 事件，挂监听避免 uncaught，失败返回 false
  function openWithDefaultApp(filePath) {
    let child;
    try {
      if (process.platform === "win32") {
        child = execFile("cmd.exe", ["/c", "start", "", filePath], { windowsHide: true, detached: true, stdio: "ignore" });
      } else {
        child = execFile(process.platform === "darwin" ? "open" : "xdg-open", [filePath], { detached: true, stdio: "ignore" });
      }
    } catch (e) {
      ctx.logger.warn('[office][feishu] 调用系统默认程序失败:', errMsg(e));
      return false;
    }
    child.on("error", (e) => {
      ctx.logger.warn('[office][feishu] 系统默认程序启动失败:', errMsg(e));
    });
    child.unref();
    return true;
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

  // P1-1/P1-2: feishuAutoTimer 清理随 lark.js 迁移
  ctx.effect(() => {
    return () => {
      if (feishuAutoTimer) clearTimeout(feishuAutoTimer);
    };
  }, "lark: auto sync timer");

  // 注入跨模块共享契约（lark.js 拥有）
  shared.loadFeishuConfig = loadFeishuConfig;
  shared.localTimeString = localTimeString;
  shared.spawnNodeScript = spawnNodeScript;
  shared.parseIngestorResult = parseIngestorResult;
  shared.saveFeishuState = saveFeishuState;

  Object.defineProperties(shared, {
    feishuNotice: {
      get() { return feishuNotice; },
      set(v) { feishuNotice = v; },
      enumerable: true,
      configurable: true
    },
    feishuLastSync: {
      get() { return feishuLastSync; },
      set(v) { feishuLastSync = v; },
      enumerable: true,
      configurable: true
    },
    _feishuMsgCache: {
      get() { return _feishuMsgCache; },
      set(v) { _feishuMsgCache = v; },
      enumerable: true,
      configurable: true
    },
    _feishuConfigCache: {
      get() { return _feishuConfigCache; },
      set(v) { _feishuConfigCache = v; },
      enumerable: true,
      configurable: true
    }
  });

  shared.calendar = {
    get events() { return calendarEvents; },
    get syncing() { return calendarSyncing; },
    get fetchedAt() { return _calendarFetchedAt; },
    get since() { return _calendarSince; },
    syncCalendar,
    cacheStale: calendarCacheStale,
    upcoming: upcomingMeetings
  };

  const routes = {
    "/office-ui/feishu/status": serveFeishuStatus,
    "/office-ui/feishu/sync": serveFeishuSync,
    "/office-ui/feishu/messages": serveFeishuMessages,
    "/office-ui/feishu/resource": serveFeishuResource,
    "/office-ui/feishu/resource/open": serveFeishuResourceOpen,
    "/office-ui/calendar/status": serveCalendarStatus,
    "/office-ui/calendar/events": serveCalendarEvents,
    "/office-ui/calendar/sync": serveCalendarSync,
    "/office-ui/transcript/status": serveTranscriptStatus,
    "/office-ui/transcript/fetch": serveTranscriptFetch,
    "/office-ui/transcript/save": serveTranscriptSave,
    "/office-ui/transcript/apply-permission": serveTranscriptApplyPermission,
  };

  return { routes };
}

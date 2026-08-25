import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  DATA_DIR, INSIGHTS_STATE_FILE, INSIGHTS_HISTORY_FILE, INSIGHTS_RETENTION_DAYS, INSIGHTS_SECTIONS,
  INSIGHTS_TIMEOUT_MS, LLM_KEY_REF, INSIGHTS_PRESYNC_WINDOW_HOURS, FEISHU_CONFIG_PATH_DISPLAY,
  URL_PARSE_BASE, STDERR_LOG_SLICE_LENGTH, FEISHU_SYNC_TIMEOUT_MS
} from "./constants.js";
import { isLoopback } from "./util.js";

export function register(runtime) {
  const { ctx, services } = runtime;
  const shared = runtime.shared;
  const { credentials } = services;
  const {
    sendJson, sendJsonForbidden, readJsonBody, ensureDataDir,
    loadFeishuConfig, localTimeString, spawnNodeScript, parseIngestorResult, saveFeishuState
  } = shared;

  // 💡 每日洞察状态：~/.dsh/office/insights-state.json（最近一次生成结果）
  let insightsGenerating = false;   // 防叠进程（内存态）
  let insightsState = null;         // { date, generatedAt, stats, summary, sections }

  async function loadInsightsState() {
    try {
      const parsed = JSON.parse(await readFile(join(DATA_DIR, INSIGHTS_STATE_FILE), "utf8"));
      if (parsed && parsed.generatedAt) insightsState = parsed;
    } catch (e) { /* 首次运行无状态 */ }
  }
  function saveInsightsState() {
    ensureDataDir()
      .then(() => writeFile(join(DATA_DIR, INSIGHTS_STATE_FILE), JSON.stringify(insightsState || {}), "utf8"))
      .catch(e => console.warn('[office] insights state save failed:', e?.message || e));
  }
  // 💡 洞察历史（30 天按日快照）：~/.dsh/office/insights-history.json（{ days: { "YYYY-MM-DD": { generatedAt, stats, summary, sections } } }）
  let insightsHistory = null;   // 与 insightsState 各自独立（recordInsightsDay 深拷贝解耦）

  async function loadInsightsHistory() {
    try {
      const parsed = JSON.parse(await readFile(join(DATA_DIR, INSIGHTS_HISTORY_FILE), "utf8"));
      if (parsed && parsed.days && typeof parsed.days === "object") insightsHistory = parsed;
    } catch (e) { /* 首次运行无历史 */ }
  }
  function saveInsightsHistory() {
    ensureDataDir()
      .then(() => writeFile(join(DATA_DIR, INSIGHTS_HISTORY_FILE), JSON.stringify(insightsHistory || { days: {} }), "utf8"))
      .catch(e => console.warn('[office] insights history save failed:', e?.message || e));
  }
  // 两者都加载完再迁移：旧版只有 insights-state.json（无历史文件）时，把最近一次补进历史
  Promise.all([loadInsightsState(), loadInsightsHistory()]).then(() => {
    if (insightsState && insightsState.date && insightsState.generatedAt &&
        (!insightsHistory || !insightsHistory.days || !insightsHistory.days[insightsState.date])) {
      recordInsightsDay(insightsState);
    }
  });

  // ============ 💡 每日洞察（scripts.insights 脚本接入；LLM key 复用 dsh credentials） ============
  // 状态：~/.dsh/office/insights-state.json（最近一次生成结果，运行时数据）
  // 前置条件检测（引导卡用）：① 消息接入 ② LLM（日报式洞察：LLM 通读当天全量消息，无向量化依赖）
  function insightsPrereq(cfg) {
    const feishuOk = !!(cfg && cfg.sync && cfg.latest);
    return {
      msgConnected: feishuOk,
      llmConfigured: false      // 实际由 credentials.describe 判定（serveInsightsStatus 内异步补）
    };
  }

  async function serveInsightsStatus(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    const url = new URL(req.url, URL_PARSE_BASE);
    if (url.searchParams.get("refresh") === "1") shared._feishuConfigCache = null;
    const cfg = loadFeishuConfig();
    const prereq = insightsPrereq(cfg);
    // 凭据实际配置情况（describe 不泄露值）
    if (credentials && typeof credentials.describe === "function") {
      try {
        const llm = await credentials.describe(LLM_KEY_REF);
        if (llm && llm.configured) prereq.llmConfigured = true;
      } catch (e) {
        ctx.logger.warn('[office][insights] 凭据检查失败:', e?.message || e);
      }
    }
    sendJson(res, { ok: true, data: {
      configured: !!(cfg && cfg.insights),
      generating: insightsGenerating,
      prereq,
      last: insightsState ? {
        date: insightsState.date,
        generatedAt: insightsState.generatedAt,
        stats: insightsState.stats,
        summary: insightsState.summary
      } : null
    } });
  }

  // 运行洞察脚本：参数从 feishu-config 的 insights 段构造；key 从 dsh credentials resolve → env 注入（包内零 key）
  async function runInsights(cfg) {
    const opts = cfg.insightsOpts || {};
    const args = [];
    if (opts.windowDays) args.push("--window-days", String(opts.windowDays));
    if (opts.todosTop) args.push("--todos-top", String(opts.todosTop));
    if (opts.highlightsTop) args.push("--highlights-top", String(opts.highlightsTop));
    if (opts.unrepliedHours) args.push("--unreplied-hours", String(opts.unrepliedHours));
    if (opts.selfUserId) args.push("--self-user-id", opts.selfUserId);
    if (cfg.mention && cfg.mention.length) args.push("--mention-names", cfg.mention.join(','));
    if (opts.llmEndpoint) args.push("--llm-endpoint", opts.llmEndpoint);
    if (opts.llmModel) args.push("--llm-model", opts.llmModel);
    const env = {};
    if (credentials && typeof credentials.resolve === "function") {
      try {
        const llm = await credentials.resolve(LLM_KEY_REF);
        if (llm && llm.value) { args.push("--llm-key-env", LLM_KEY_REF); env[LLM_KEY_REF] = llm.value; }
      } catch (e) {
        ctx.logger.warn('[office][insights] 凭据解析失败:', e?.message || e);
      }
    }
    const { error, stdout } = await spawnNodeScript(cfg.insights, args, INSIGHTS_TIMEOUT_MS, env);
    if (error) return { ok: false, error: { code: "SCRIPT_FAILED", message: error.message || String(error) } };
    try {
      const parsed = JSON.parse(stdout.trim());
      return (parsed && parsed.ok) ? parsed : { ok: false, error: (parsed && parsed.error) || { code: "BAD_OUTPUT", message: "insights 脚本输出异常" } };
    } catch (e) {
      return { ok: false, error: { code: "BAD_OUTPUT", message: "insights 脚本输出非 JSON: " + String(e.message) } };
    }
  }

  async function serveInsightsGenerate(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const cfg = loadFeishuConfig();
    if (!cfg || !cfg.insights) {
      return sendJson(res, { ok: false, error: {
        code: "INSIGHTS_CONFIG_REQUIRED",
        message: "未配置洞察脚本（scripts.insights）",
        setup: { configPath: FEISHU_CONFIG_PATH_DISPLAY, template: { scripts: { insights: "<insights.js 绝对路径>" } } }
      } });
    }
    if (insightsGenerating) {
      return sendJson(res, { ok: false, error: { code: "GENERATING", message: "洞察生成进行中，请稍候" } });
    }
    insightsGenerating = true;
    // 异步链：① 增量预同步（确保当天消息已入库 + 向量化）→ ② 洞察生成；先回 started，前端轮询 /status
    (async () => {
      try {
        if (cfg.sync) {
          const since = (shared.feishuLastSync && shared.feishuLastSync.at) || localTimeString(new Date(Date.now() - INSIGHTS_PRESYNC_WINDOW_HOURS * 3600 * 1000));
          const syncRes = await spawnNodeScript(cfg.sync, ["--since", since], FEISHU_SYNC_TIMEOUT_MS);
          const parsed = parseIngestorResult(syncRes.stdout);
          if (parsed) {
            shared.feishuLastSync = { ...parsed, at: localTimeString() };
            saveFeishuState();
            shared._feishuMsgCache = null;
            ctx.logger.info('[office][insights] 预同步完成:', JSON.stringify(parsed));
          } else {
            ctx.logger.warn('[office][insights] 预同步未识别结果行:', (syncRes.error && syncRes.error.message) || (syncRes.stderr ? syncRes.stderr.slice(0, STDERR_LOG_SLICE_LENGTH) : ''));
          }
        }
        const result = await runInsights(cfg);
        if (result && result.ok) {
          insightsState = {
            date: result.date, generatedAt: result.generatedAt,
            stats: result.stats, summary: result.summary, sections: result.sections
          };
          saveInsightsState();
          recordInsightsDay(result);
          ctx.logger.info('[office][insights] 生成完成:', JSON.stringify({
            date: result.date, scanned: result.stats && result.stats.scanned,
            llm: result.stats && result.stats.llm,
            todos: (result.sections && result.sections.todos || []).length,
            unreplied: (result.sections && result.sections.unreplied || []).length,
            highlights: (result.sections && result.sections.highlights || []).length
          }));
        } else {
          ctx.logger.warn('[office][insights] 生成失败:', JSON.stringify(result && result.error));
        }
      } catch (e) {
        ctx.logger.warn('[office][insights] 生成异常:', e?.message || e);
      } finally {
        insightsGenerating = false;
      }
    })();
    sendJson(res, { ok: true, started: true });
  }

  // ---------- 洞察历史（30 天保留；生成时写入 + 读取/删除时兜底裁剪，无后台定时器） ----------
  function localDateOnly(d) { return localTimeString(d).slice(0, 10); }

  function insightsRetentionCutoff() {
    const d = new Date();
    d.setDate(d.getDate() - (INSIGHTS_RETENTION_DAYS - 1));
    return localDateOnly(d);
  }
  function pruneInsightsHistory() {
    if (!insightsHistory || !insightsHistory.days) return;
    const cutoff = insightsRetentionCutoff();
    for (const key of Object.keys(insightsHistory.days)) {
      if (key < cutoff) delete insightsHistory.days[key];   // YYYY-MM-DD 字典序即时间序
    }
  }
  function recordInsightsDay(day) {
    if (!insightsHistory) insightsHistory = { days: {} };
    // 深拷贝，与 insightsState 解耦（单条删除只改历史，互不影响）
    insightsHistory.days[day.date] = JSON.parse(JSON.stringify({
      generatedAt: day.generatedAt, stats: day.stats, summary: day.summary, sections: day.sections
    }));
    pruneInsightsHistory();
    saveInsightsHistory();
  }

  async function serveInsightsHistory(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    pruneInsightsHistory();
    const url = new URL(req.url, URL_PARSE_BASE);
    const date = (url.searchParams.get("date") || "").trim();
    const day = (date && insightsHistory && insightsHistory.days && insightsHistory.days[date]) || null;
    sendJson(res, { ok: true, data: day ? { date, ...day } : { date: date || null, empty: true } });
  }

  async function serveInsightsDelete(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const date = body && typeof body.date === "string" ? body.date : "";
    const section = body && typeof body.section === "string" ? body.section : "";
    const index = body && Number.isInteger(body.index) ? body.index : -1;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !INSIGHTS_SECTIONS.includes(section) || index < 0) {
      return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "date/section/index 无效" } }, 400);
    }
    const day = insightsHistory && insightsHistory.days && insightsHistory.days[date];
    const arr = day && day.sections && day.sections[section];
    if (!day || !Array.isArray(arr) || index >= arr.length) {
      return sendJson(res, { ok: false, error: { code: "NOT_FOUND", message: "该条洞察不存在" } }, 404);
    }
    arr.splice(index, 1);   // 硬删除：直接从快照移除，无撤销/墓碑
    // 若删除的是最近一次生成（同日快照），同步 insightsState 保持一致（与历史为独立副本）
    if (insightsState && insightsState.date === date && Array.isArray(insightsState.sections && insightsState.sections[section])) {
      insightsState.sections[section].splice(index, 1);
      saveInsightsState();
    }
    saveInsightsHistory();
    sendJson(res, { ok: true });
  }

  let pendingCreateSession = null;   // 转会话指令（iframe → Host 暂存，Client 轮询消费后执行）
  async function serveInsightsToSession(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const workspaceId = body && typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const promptText = body && typeof body.promptText === "string" ? body.promptText.trim() : "";
    if (!workspaceId || !promptText) {
      return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "workspaceId/promptText 不能为空" } }, 400);
    }
    pendingCreateSession = { workspaceId, promptText };
    sendJson(res, { ok: true });
  }

  // 注入跨模块共享契约（insights.js 拥有）：pendingCreateSession 供 office.js 的 RPC consume-create-session 消费
  Object.defineProperty(shared, "pendingCreateSession", {
    get() { return pendingCreateSession; },
    set(v) { pendingCreateSession = v; },
    enumerable: true,
    configurable: true
  });

  const routes = {
    "/office-ui/feishu/insights/status": serveInsightsStatus,
    "/office-ui/feishu/insights/history": serveInsightsHistory,
    "/office-ui/feishu/insights/delete": serveInsightsDelete,
    "/office-ui/feishu/insights/to-session": serveInsightsToSession,
    "/office-ui/feishu/insights/generate": serveInsightsGenerate,
  };

  return { routes };
}

// 🔔 会话跑完 / ⏳ 提问等你回答 / ⏸ 审批等你点 → 飞书私聊通知
//
// 三个触发点：
// 1. `agent/status` 进入 idle：该 agent 已无调度中/进行中的 driver，这一轮跑完了。
//    延迟 settleMs（默认 60 秒）后仍为 idle 才发；这段延迟既是防抖（期间又追问 → 撤回），
//    也是留给你先自己看完的窗口——通知来得比人快，红点就得白消一次。
// 2. `user-questions/request`：agent 提问等回答。**此时 turn 未结束、agent 仍是 running**，
//    所以 idle 那条路永远碰不到这种时刻，必须单独挂。
// 3. `approval/request`：工具执行前等审批。同理仍是 running。
//
// 范围：仅 notify-config.json 白名单工作区；仅主会话（header.parentSession 为空），
//       子代理（夜间批/子代理会话）不推送，避免刷屏。
// 发送：复用 feishu-config.json 的 lark-cli 路径与 profile，以 bot 身份私聊目标 open_id。
//       配置缺失/找不到 CLI 时 fail-closed（不发、只记日志），绝不因通知失败影响会话。
//
// 读会话内容一律「live 内存优先，sessionQuery 兜底」：live session 只在其存活期间可读，
// 且 live events 里并没有 title 事件类型，标题只能由 sessionQuery 折出（它同时覆盖持久化）。
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  FEISHU_CONFIG_PATH, NOTIFY_CONFIG_PATH, NOTIFY_SETTLE_MS_DEFAULT,
  NOTIFY_SNIPPET_MAX, NOTIFY_SEND_TIMEOUT_MS, NOTIFY_STATUS_PATH,
} from "./constants.js";
import { extractParentEntry, isLoopback } from "./util.js";

// 配置文件损坏/缺失一律当"未配置"处理（通知是旁路能力，不打扰主流程）
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (_) {
    return null;
  }
}

function normalizeConfig(raw) {
  const workspaces = Array.isArray(raw && raw.workspaces)
    ? raw.workspaces.map((w) => String(w).trim()).filter(Boolean)
    : [];
  return {
    // fail-closed：白名单为空即视为关闭，绝不默认全量推送
    enabled: raw && raw.enabled !== false && workspaces.length > 0,
    workspaces,
    userOpenId: raw && typeof raw.userOpenId === "string" ? raw.userOpenId.trim() : "",
    profile: raw && typeof raw.profile === "string" ? raw.profile.trim() : "",
    cliPath: raw && typeof raw.cliPath === "string" ? raw.cliPath.trim() : "",
    settleMs: raw && Number.isFinite(raw.settleMs) && raw.settleMs >= 0
      ? raw.settleMs : NOTIFY_SETTLE_MS_DEFAULT,
  };
}

// lark-cli run.js：显式配置优先，其次环境变量与 npm 全局常规位置
function resolveCliPath(configured) {
  const candidates = [];
  const push = (p) => { if (p && String(p).trim()) candidates.push(String(p).trim()); };
  push(configured);
  push(process.env.LARK_CLI_RUN_JS);
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (base) push(join(base, "npm", "node_modules", "@larksuite", "cli", "scripts", "run.js"));
  }
  if (process.env.npm_config_prefix) {
    push(join(process.env.npm_config_prefix, "node_modules", "@larksuite", "cli", "scripts", "run.js"));
  }
  return candidates.find((p) => existsSync(p)) || "";
}

function clip(text, max) {
  const flat = String(text).replace(/\s*\n\s*/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return sec + " 秒";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + " 分 " + (sec % 60) + " 秒";
  return Math.floor(min / 60) + " 小时 " + (min % 60) + " 分";
}

// assistant/message 的 content 可能是字符串或 ContentBlock[]，只取文本块
function collectText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// 事件序列里最后一条有文本的助手消息
function pickAssistantText(events) {
  if (!Array.isArray(events)) return "";
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || ev.type !== "assistant/message" || !ev.data || !ev.data.message) continue;
    const text = collectText(ev.data.message.content);
    if (text) return text;
  }
  return "";
}

export function register(runtime) {
  const { ctx, services, shared } = runtime;
  const { workspaceRegistry, sessionsSvc, agents, sessionQuery } = services;

  const log = (level, msg) => {
    try { shared.appendOfficeLog(level, "[notify] " + msg); } catch (_) { /* 日志非关键路径 */ }
  };
  const sendJson = shared.sendJson;

  // ---------- 配置：按 mtime 热加载（改完配置无需重启 dsh） ----------
  let cfgMtime = -1;
  let cfgValue = null;
  function config() {
    try {
      const st = statSync(NOTIFY_CONFIG_PATH);
      if (st.mtimeMs !== cfgMtime) {
        cfgValue = normalizeConfig(readJsonSafe(NOTIFY_CONFIG_PATH));
        cfgMtime = st.mtimeMs;
      }
      return cfgValue;
    } catch (_) {
      return null;   // 配置文件不存在 = 功能关闭
    }
  }

  const startedAt = new Map();   // sid -> 本轮 running 起始时间
  const pending = new Map();     // sid -> 待确认的发送定时器
  let lastMessage = "";          // 最近一次实际发出的正文（排障用）

  function cancelPending(sid) {
    const t = pending.get(sid);
    if (t) { clearTimeout(t); pending.delete(sid); }
  }

  function isRunning(sid) {
    if (!agents || typeof agents.list !== "function") return false;
    try {
      const live = agents.list().find((a) => String(a.id) === sid);
      return Boolean(live && live.status === "running");
    } catch (_) {
      return false;
    }
  }

  function isSubagent(sid) {
    if (!sessionsSvc || typeof sessionsSvc.get !== "function") return false;
    try {
      return extractParentEntry(sessionsSvc.get(sid) || {}) !== null;
    } catch (_) {
      return false;
    }
  }

  function workspaceOf(sid) {
    if (!workspaceRegistry || typeof workspaceRegistry.list !== "function") return null;
    try {
      for (const ws of workspaceRegistry.list()) {
        const ids = ws && ws.sessionIds;
        if (!ids) continue;
        for (const id of ids) if (String(id) === sid) return ws;
      }
    } catch (_) { /* 注册表暂不可用 → 视为不在白名单 */ }
    return null;
  }

  // 白名单按标题或完整路径匹配（面板里看到的是标题，配置更省心）
  function inWhitelist(ws, whitelist) {
    const norm = (s) => String(s || "").trim().toLowerCase().replace(/[\\/]+$/, "");
    const title = norm(ws.title);
    const path = norm(ws.path);
    return whitelist.some((entry) => {
      const e = norm(entry);
      return e.length > 0 && (e === title || e === path);
    });
  }

  // 「等你」类通知的公共前置：开关 → 主会话 → 白名单工作区。不通过返回 null。
  function gateFor(sid) {
    const cfg = config();
    if (!cfg || !cfg.enabled) return null;
    if (!sid || isSubagent(sid)) return null;
    const ws = workspaceOf(sid);
    if (!ws || !inWhitelist(ws, cfg.workspaces)) return null;
    return { cfg, ws };
  }

  // waterfall 的 payload 里 agent 有时可缺；currentInitiator 只在同步链上有意义，
  // 所以调用方必须在同步阶段取值，不能留到异步里。
  function resolveAgent(fromPayload) {
    if (fromPayload) return fromPayload;
    if (agents && typeof agents.currentInitiator === "function") {
      try { return agents.currentInitiator(); } catch (_) { /* 无发起者边界 */ }
    }
    return undefined;
  }

  function sidOf(agent) {
    return agent && agent.id != null ? String(agent.id) : "";
  }

  // 标题只能由 sessionQuery 折出（live sessionsSvc 的 events 里没有 title 事件类型），
  // readTitle 是 live-preferred，冷会话也能读到。
  async function sessionTitle(sid) {
    if (!sessionQuery || typeof sessionQuery.readTitle !== "function") return "";
    try {
      const snap = await sessionQuery.readTitle(sid);
      const raw = snap && snap.title;
      if (typeof raw === "string") return raw;                     // SessionTitleSnapshot.title
      if (raw && typeof raw.title === "string") return raw.title;  // 兼容 Observation 形态
    } catch (e) {
      log("warn", "读会话标题失败: " + (e && e.message ? e.message : String(e)));
    }
    return "";
  }

  async function titleOf(sid) {
    return (await sessionTitle(sid)) || ("会话 " + sid.slice(-8));
  }

  // 正文 live 优先（零 I/O），冷会话再走 readSurface
  async function lastAssistantText(sid) {
    const live = pickAssistantText(sessionsSvc.get(sid)?.events);
    if (live) return clip(live, NOTIFY_SNIPPET_MAX);
    if (!sessionQuery || typeof sessionQuery.readSurface !== "function") return "";
    try {
      const snap = await sessionQuery.readSurface(sid);
      return clip(pickAssistantText(snap && snap.events), NOTIFY_SNIPPET_MAX);
    } catch (e) {
      log("warn", "读会话正文失败: " + (e && e.message ? e.message : String(e)));
      return "";
    }
  }

  async function compose(sid, ws) {
    const parts = ["🔔 **" + (ws.title || "工作区") + " · " + (await titleOf(sid)) + "**"];
    const snippet = await lastAssistantText(sid);
    if (snippet) parts.push("", snippet);
    const began = startedAt.get(sid);
    if (began) parts.push("", "⏱ 用时 " + formatDuration(Date.now() - began));
    return parts.join("\n");
  }

  // 提问等待：agent 在等回答时 turn 未结束、仍是 running，idle 那条路等不到它。
  async function composeAsk(sid, ws, request) {
    const questions = Array.isArray(request && request.questions) ? request.questions : [];
    const first = questions[0] || {};
    const lines = [
      "⏳ **" + (ws.title || "工作区") + " · " + (await titleOf(sid)) + "**",
      "",
      "等你在 dsh 里回答：" + clip(first.question || "(无题面)", 120),
    ];
    if (questions.length > 1) lines.push("（这一批共 " + questions.length + " 个问题）");
    return lines.join("\n");
  }

  // 审批等待：同样是 running，同理单挂。
  async function composeApproval(sid, ws, req) {
    const lines = [
      "⏸ **" + (ws.title || "工作区") + " · " + (await titleOf(sid)) + "**",
      "",
      "等你审批：" + (req && req.toolName ? String(req.toolName) : "一个工具调用"),
    ];
    const reason = req && req.reason ? clip(req.reason, 120) : "";
    if (reason) lines.push(reason);
    return lines.join("\n");
  }

  async function notifyAsk(request, agent) {
    try {
      const sid = sidOf(agent);
      const g = gateFor(sid);
      if (!g) return;
      await send(g.cfg, await composeAsk(sid, g.ws, request));
    } catch (e) {
      log("warn", "提问通知异常: " + (e && e.message ? e.message : String(e)));
    }
  }

  async function notifyApproval(req, agent) {
    try {
      const sid = sidOf(agent);
      const g = gateFor(sid);
      if (!g) return;
      await send(g.cfg, await composeApproval(sid, g.ws, req));
    } catch (e) {
      log("warn", "审批通知异常: " + (e && e.message ? e.message : String(e)));
    }
  }

  // 两个 waterfall 监听器：**必须调用 next() 委派**——返回一个结果就等于「接管」了这次
  // 提问/审批，用户在 GUI 里就没得答了。通知一律 fire-and-forget，绝不 await 去拖住它。
  function onUserQuestion(request, next) {
    const answer = next();
    void notifyAsk(request, resolveAgent(request && request.agent));
    return answer;
  }

  function onApprovalRequest(req, next) {
    const outcome = next();
    void notifyApproval(req, resolveAgent(req && req.agent));
    return outcome;
  }

  let lastResult = "尚未发送";

  function runCli(cliPath, args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.execPath, [cliPath, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e) {
        resolve({ ok: false, error: "spawn 失败: " + (e && e.message ? e.message : String(e)) });
        return;
      }
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) { /* 已退出 */ }
        resolve({ ok: false, error: "超时" });
      }, NOTIFY_SEND_TIMEOUT_MS);
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e && e.message) }); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve({ ok: false, error: "exit " + code + ": " + String(err || out).slice(0, 200) });
          return;
        }
        let parsed = null;
        try { parsed = JSON.parse(out); } catch (_) { /* 非 JSON 输出按失败处理 */ }
        resolve(parsed && parsed.ok === true
          ? { ok: true }
          : { ok: false, error: "CLI 返回非 ok：" + String(out).slice(0, 200) });
      });
    });
  }

  async function send(cfg, text) {
    if (!cfg.userOpenId) {
      lastResult = "未配置 userOpenId，已跳过";
      log("warn", lastResult);
      return;
    }
    const feishu = readJsonSafe(FEISHU_CONFIG_PATH) || {};
    const cliPath = resolveCliPath(cfg.cliPath || feishu.larkCliRunJs);
    if (!cliPath) {
      lastResult = "找不到 lark-cli run.js（配 notify.cliPath 或 feishu-config.larkCliRunJs）";
      log("error", lastResult);
      return;
    }
    const args = ["im", "+messages-send", "--as", "bot", "--user-id", cfg.userOpenId, "--markdown", text];
    const profile = cfg.profile || (typeof feishu.profile === "string" ? feishu.profile : "");
    if (profile) args.push("--profile", profile);
    const res = await runCli(cliPath, args);
    lastMessage = clip(text, 200);
    lastResult = res.ok ? "最近一次发送成功 " + new Date().toLocaleString() : "最近一次发送失败：" + res.error;
    log(res.ok ? "info" : "warn", lastResult);
  }

  async function settle(sid) {
    const g = gateFor(sid);
    if (!g) return;
    if (isRunning(sid)) return;                 // settleMs 内又跑起来了：这轮还没完
    await send(g.cfg, await compose(sid, g.ws));
  }

  function onStatus(payload) {
    const agent = payload && payload.agent;
    if (!agent || agent.id == null) return;
    const sid = String(agent.id);

    if (payload.status === "running") {
      if (!startedAt.has(sid)) startedAt.set(sid, Date.now());
      cancelPending(sid);                       // 用户又发了消息：撤回待发通知
      return;
    }
    if (payload.status !== "idle") return;

    const cfg = config();
    if (!cfg || !cfg.enabled) return;
    cancelPending(sid);
    const timer = setTimeout(() => {
      pending.delete(sid);
      void settle(sid)
        // startedAt 必须等 compose 读完耗时再删（早删会让「用时」永远取不到）
        .catch((e) => log("warn", "通知处理异常: " + (e && e.message ? e.message : String(e))))
        .finally(() => startedAt.delete(sid));
    }, cfg.settleMs);
    pending.set(sid, timer);
  }

  ctx.effect(() => {
    const disposers = [];
    const subs = [
      ["agent/status", onStatus],
      ["user-questions/request", onUserQuestion],
      ["approval/request", onApprovalRequest],
    ];
    if (typeof ctx.on === "function") {
      for (const [name, handler] of subs) {
        try {
          const d = ctx.on(name, handler);
          if (d) disposers.push(d);
        } catch (e) {
          log("warn", "订阅 " + name + " 失败: " + (e && e.message ? e.message : String(e)));
        }
      }
    }
    return () => {
      for (const d of disposers) { try { typeof d === "function" && d(); } catch (_) { /* 已释放 */ } }
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      startedAt.clear();
    };
  }, "notify: agent status + user questions + approvals");

  const routes = {
    [NOTIFY_STATUS_PATH]: (req, res) => {
      if (!isLoopback(req.socket.remoteAddress)) { shared.sendForbidden(res); return; }
      const cfg = config();
      const feishu = readJsonSafe(FEISHU_CONFIG_PATH) || {};
      sendJson(res, {
        ok: true,
        configured: cfg !== null,
        enabled: Boolean(cfg && cfg.enabled),
        workspaces: cfg ? cfg.workspaces : [],
        target: cfg && cfg.userOpenId ? cfg.userOpenId.slice(0, 6) + "***" : "",
        settleMs: cfg ? cfg.settleMs : null,
        cliPath: resolveCliPath(cfg ? cfg.cliPath || feishu.larkCliRunJs : feishu.larkCliRunJs) || "",
        pending: pending.size,
        lastResult,
        lastMessage,
      });
    },
  };

  return { routes };
}

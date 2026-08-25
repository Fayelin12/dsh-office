import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  AGENTLY_PKG, AGENTLY_ENTRY_REL, AGENTLY_TIMEOUT_MS, AGENTLY_RETRY_DELAY_MS, MAX_BUFFER_16MB,
  CLI_ERROR_TRANSIENT, CLI_ERROR_AUTH_REQUIRED, CLI_ERROR_LOCAL_NETWORK, TRANSIENT_ERROR_CODES,
  MAIL_LIST_DEFAULT_LIMIT, MAIL_LIST_MAX_LIMIT, MAIL_DIRS_ALLOWED, URL_PARSE_BASE, MESSAGE_ID_MAX_LENGTH,
  BODY_LIMIT_1MB
} from "./constants.js";
import { isLoopback } from "./util.js";

export function register(runtime) {
  const { ctx } = runtime;
  const shared = runtime.shared;
  const { sendJson, sendJsonForbidden, readJsonBody, errMsg } = shared;

  let _agentlyEntry = null;
  function resolveAgentlyEntry() {
    if (_agentlyEntry) return _agentlyEntry;
    // 候选：标准 npm 全局安装位置（Windows 下 npm 是 .cmd，execFileSync 无法解析，
    // 因此不调用 `npm prefix -g`——它必然 ENOENT 且与 APPDATA 候选重复，只产生日志噪音）
    const candidates = [];
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "npm", "node_modules", AGENTLY_PKG));
    if (process.env.npm_config_prefix) candidates.push(join(process.env.npm_config_prefix, "node_modules", AGENTLY_PKG));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "npm", "node_modules", AGENTLY_PKG));
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

  const routes = {
    "/office-ui/mail/me": serveMailMe,
    "/office-ui/mail/list": serveMailList,
    "/office-ui/mail/read": serveMailRead,
    "/office-ui/mail/send": serveMailSend,
    "/office-ui/mail/reply": serveMailReply,
  };

  return { routes };
}

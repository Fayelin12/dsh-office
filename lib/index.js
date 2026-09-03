// M2 后端 Phase 2：apply(ctx) 按功能拆分为 office/mail/lark/insights/todos 五个模块，
// 本文件退化为 shell：取注入服务 → 组装 runtime → 依次 register → 合并路由 → 注册 webServer 前缀分发。
// 常量/纯函数由各模块直接从 constants.js / util.js 命名导入（叶子模块，无循环依赖）。
import { WEBSERVER_RETRY_DELAY_MS } from "./constants.js";
import { isHighFreqReadPath } from "./util.js";
import { register as registerOffice } from "./office.js";
import { register as registerMail } from "./mail.js";
import { register as registerLark } from "./lark.js";
import { register as registerInsights } from "./insights.js";
import { register as registerTodos } from "./todos.js";
import { register as registerLarkBot } from "./larkbot.js";

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

export async function apply(ctx, _config = {}) {
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

  // 取全部注入服务（含 connection 这个未在 inject 声明、按需 ctx.get 的服务）
  const services = {
    webServer,
    workspaceRegistry: ctx.get("workspaceRegistry"),
    sessionQuery: ctx.get("sessionQuery"),
    agents: ctx.get("agents"),
    sessionsSvc: ctx.get("sessions"),
    tokenMeter: ctx.get("tokenMeter"),
    sessionProjections: ctx.get("sessionProjections"),
    projectionCache: ctx.get("sessionProjectionCache"),
    sessionPersistence: ctx.get("sessionPersistence"),
    connection: ctx.get("connection"),
  };

  // 跨模块共享契约：各模块在 register 内注入自己拥有的字段（函数直接赋值、可变状态用访问器）
  const shared = {};
  const runtime = { ctx, services, shared };

  // 各模块 register 返回 { routes }，这里取 .routes 展开合并（33 条路径 → handler）
  const ROUTES = {
    ...registerOffice(runtime).routes,
    ...registerMail(runtime).routes,
    ...registerLark(runtime).routes,
    ...registerInsights(runtime).routes,
    ...registerTodos(runtime).routes,
    ...registerLarkBot(runtime).routes,
  };

  try {
    const dispose = webServer.register({
      kind: "prefix",
      path: "/office-ui",
      handler: async (req, res) => {
        const pathname = String(req.url || "/").split("?")[0];
        // 请求日志：记录每次请求（高频只读轮询路径过滤，避免 3 秒轮询刷屏）
        if (!isHighFreqReadPath(pathname)) {
          shared.appendOfficeLog("info", req.method + " " + pathname);
        }
        if (pathname.startsWith("/office-ui/assets/")) return shared.serveAsset(res, pathname.slice("/office-ui/assets/".length));
        const handler = ROUTES[pathname];
        if (handler) return handler(req, res);
        return shared.serveHtml(res);
      }
    });
    ctx.effect(() => dispose, "office: http routes");
  } catch (e) {
    ctx.logger.error("[office] webServer.register 失败:", e);
  }
}

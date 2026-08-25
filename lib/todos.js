import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { DATA_DIR, TODOS_FILE, TODO_PRIORITIES, TODO_TEXT_MAX, URL_PARSE_BASE } from "./constants.js";
import { isLoopback } from "./util.js";

export function register(runtime) {
  const { shared } = runtime;
  const { sendJson, sendJsonForbidden, readJsonBody, ensureDataDir, localTimeString } = shared;

  // 📝 每日待办（手动记录）：~/.dsh/office/todos.json（{ days: { "YYYY-MM-DD": [{ id, text, done, priority, createdAt }] } }）
  let todosState = { days: {} };
  async function loadTodos() {
    try {
      const parsed = JSON.parse(await readFile(join(DATA_DIR, TODOS_FILE), "utf8"));
      if (parsed && parsed.days && typeof parsed.days === "object") todosState = parsed;
    } catch (e) { /* 首次运行无数据 */ }
  }
  function saveTodos() {
    ensureDataDir()
      .then(() => writeFile(join(DATA_DIR, TODOS_FILE), JSON.stringify(todosState || { days: {} }), "utf8"))
      .catch(e => console.warn('[office] todos save failed:', e?.message || e));
  }
  function todosForDate(date) {
    const arr = todosState && todosState.days && todosState.days[date];
    return Array.isArray(arr) ? arr : (todosState.days[date] = []);
  }
  loadTodos();

  // ============ 📝 每日待办（手动记录，按天存储） ============
  // 状态：~/.dsh/office/todos.json（{ days: { "YYYY-MM-DD": [{ id, text, done, priority, createdAt }] } }）
  const TODO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function newTodoId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function sanitizeTodoText(text) {
    const s = typeof text === "string" ? text.trim() : "";
    return s.slice(0, TODO_TEXT_MAX);
  }

  async function serveTodosList(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    const url = new URL(req.url, URL_PARSE_BASE);
    const date = (url.searchParams.get("date") || "").trim();
    if (!TODO_DATE_RE.test(date)) {
      return sendJson(res, { ok: false, error: { code: "BAD_DATE", message: "date 无效" } }, 400);
    }
    sendJson(res, { ok: true, data: { date, items: todosForDate(date) } });
  }

  async function serveTodosAdd(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const date = body && typeof body.date === "string" ? body.date : "";
    const text = sanitizeTodoText(body && body.text);
    const priority = TODO_PRIORITIES.includes(body && body.priority) ? body.priority : "中";
    if (!TODO_DATE_RE.test(date) || !text) {
      return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "date/text 无效" } }, 400);
    }
    const item = { id: newTodoId(), text, done: false, priority, createdAt: localTimeString() };
    todosForDate(date).push(item);
    saveTodos();
    sendJson(res, { ok: true, item });
  }

  async function serveTodosUpdate(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const date = body && typeof body.date === "string" ? body.date : "";
    const id = body && typeof body.id === "string" ? body.id : "";
    const patch = body && typeof body.patch === "object" && body.patch ? body.patch : null;
    if (!TODO_DATE_RE.test(date) || !id || !patch) {
      return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "date/id/patch 无效" } }, 400);
    }
    const arr = todosForDate(date);
    const item = arr.find((t) => t && t.id === id);
    if (!item) return sendJson(res, { ok: false, error: { code: "NOT_FOUND", message: "该条待办不存在" } }, 404);
    if (typeof patch.done === "boolean") item.done = patch.done;
    if (typeof patch.priority === "string" && TODO_PRIORITIES.includes(patch.priority)) item.priority = patch.priority;
    if (typeof patch.text === "string") {
      const text = sanitizeTodoText(patch.text);
      if (!text) return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "text 不能为空" } }, 400);
      item.text = text;
    }
    saveTodos();
    sendJson(res, { ok: true, item });
  }

  async function serveTodosRemove(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const date = body && typeof body.date === "string" ? body.date : "";
    const id = body && typeof body.id === "string" ? body.id : "";
    if (!TODO_DATE_RE.test(date) || !id) {
      return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "date/id 无效" } }, 400);
    }
    const arr = todosForDate(date);
    const idx = arr.findIndex((t) => t && t.id === id);
    if (idx < 0) return sendJson(res, { ok: false, error: { code: "NOT_FOUND", message: "该条待办不存在" } }, 404);
    arr.splice(idx, 1);   // 硬删除
    saveTodos();
    sendJson(res, { ok: true });
  }

  // 改期：把某条待办从 date 移到 toDate（保留原 id/text/done/priority/createdAt，原子移动）
  async function serveTodosMove(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const date = body && typeof body.date === "string" ? body.date : "";
    const id = body && typeof body.id === "string" ? body.id : "";
    const toDate = body && typeof body.toDate === "string" ? body.toDate : "";
    if (!TODO_DATE_RE.test(date) || !TODO_DATE_RE.test(toDate) || !id) {
      return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "date/id/toDate 无效" } }, 400);
    }
    const from = todosForDate(date);
    const idx = from.findIndex((t) => t && t.id === id);
    if (idx < 0) return sendJson(res, { ok: false, error: { code: "NOT_FOUND", message: "该条待办不存在" } }, 404);
    const [item] = from.splice(idx, 1);
    todosForDate(toDate).push(item);
    saveTodos();
    sendJson(res, { ok: true, item });
  }

  const routes = {
    "/office-ui/todos/list": serveTodosList,
    "/office-ui/todos/add": serveTodosAdd,
    "/office-ui/todos/update": serveTodosUpdate,
    "/office-ui/todos/remove": serveTodosRemove,
    "/office-ui/todos/move": serveTodosMove,
  };

  return { routes };
}

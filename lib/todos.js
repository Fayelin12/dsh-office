import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  DATA_DIR, TODOS_FILE, TODO_PRIORITIES, TODO_TEXT_MAX, TODO_NOTE_MAX,
  TODO_PROJECT_MAX, TODO_PROJECT_COUNT_MAX, URL_PARSE_BASE,
} from "./constants.js";
import { isLoopback } from "./util.js";

export function register(runtime) {
  const { shared } = runtime;
  const { sendJson, sendJsonForbidden, readJsonBody, ensureDataDir, localTimeString } = shared;

  // 📝 待办（全局存储）：~/.dsh/office/todos.json
  // { version: 2, projects: [项目名...], items: [{ id, project|null, text, note, due|null, done, priority, createdAt, completedAt|null }] }
  const TODO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  let todosState = { version: 2, projects: [], items: [] };

  function newTodoId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function sanitizeText(v) {
    const s = typeof v === "string" ? v.trim() : "";
    return s.slice(0, TODO_TEXT_MAX);
  }
  function sanitizeNote(v) {
    const s = typeof v === "string" ? v : "";
    return s.slice(0, TODO_NOTE_MAX);
  }
  function sanitizeProjectName(v) {
    const s = typeof v === "string" ? v.trim() : "";
    return s.slice(0, TODO_PROJECT_MAX);
  }
  // due 合法化：合法日期→原值；null/空串→null；否则 null（不抛错）
  function sanitizeDue(v) {
    if (v === null || v === undefined || v === "") return null;
    const s = typeof v === "string" ? v.trim() : "";
    return TODO_DATE_RE.test(s) ? s : null;
  }
  function sanitizeProjectRef(v) {
    if (v === null || v === undefined || v === "") return null;
    const s = typeof v === "string" ? v.trim() : "";
    return s && todosState.projects.includes(s) ? s : null;
  }

  // 迁移旧格式 { days: { "YYYY-MM-DD": [{ id, text, done, priority, createdAt }] } } → v2
  // 旧条目无项目/备注，due 取创建日（保留"这天有这些待办"的日历语义）
  function migrateLegacy(parsed) {
    const items = [];
    const days = parsed && parsed.days;
    if (days && typeof days === "object") {
      for (const [date, arr] of Object.entries(days)) {
        if (!Array.isArray(arr)) continue;
        for (const it of arr) {
          if (!it || !it.id) continue;
          const done = !!it.done;
          items.push({
            id: it.id,
            project: null,
            text: sanitizeText(it.text),
            note: "",
            due: TODO_DATE_RE.test(date) ? date : null,
            done,
            priority: TODO_PRIORITIES.includes(it.priority) ? it.priority : "中",
            createdAt: typeof it.createdAt === "string" ? it.createdAt : "",
            completedAt: done ? (typeof it.createdAt === "string" ? it.createdAt : null) : null,
          });
        }
      }
    }
    return { version: 2, projects: [], items };
  }

  async function loadTodos() {
    try {
      const parsed = JSON.parse(await readFile(join(DATA_DIR, TODOS_FILE), "utf8"));
      if (parsed && Array.isArray(parsed.items)) {
        todosState = {
          version: 2,
          projects: Array.isArray(parsed.projects) ? parsed.projects.filter((p) => sanitizeProjectName(p)) : [],
          items: parsed.items.filter((it) => it && it.id),
        };
      } else if (parsed) {
        todosState = migrateLegacy(parsed);   // 旧格式首次加载即迁移
        saveTodos();
      }
    } catch (e) { /* 首次运行无数据 */ }
  }
  function saveTodos() {
    ensureDataDir()
      .then(() => writeFile(join(DATA_DIR, TODOS_FILE), JSON.stringify(todosState || { version: 2, projects: [], items: [] }), "utf8"))
      .catch(e => console.warn('[office] todos save failed:', e?.message || e));
  }
  loadTodos();

  // ============ 📋 待办（全局看板 + 按日左列，9 路由） ============
  async function serveTodosBoard(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    sendJson(res, { ok: true, data: { projects: todosState.projects, items: todosState.items } });
  }

  // 按日左列：返回 due 等于该日的条目（含已完成）
  async function serveTodosList(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    const url = new URL(req.url, URL_PARSE_BASE);
    const date = (url.searchParams.get("date") || "").trim();
    if (!TODO_DATE_RE.test(date)) {
      return sendJson(res, { ok: false, error: { code: "BAD_DATE", message: "date 无效" } }, 400);
    }
    const items = todosState.items.filter((t) => t.due === date);
    sendJson(res, { ok: true, data: { date, items } });
  }

  async function serveTodosAdd(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const text = sanitizeText(body && body.text);
    if (!text) {
      return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "text 无效" } }, 400);
    }
    // due 兼容旧调用传的 date（洞察「加入待办」），语义 = 截止日
    const due = sanitizeDue(body && body.due != null ? body.due : (body && body.date));
    const item = {
      id: newTodoId(),
      project: sanitizeProjectRef(body && body.project),
      text,
      note: sanitizeNote(body && body.note),
      due,
      done: false,
      priority: TODO_PRIORITIES.includes(body && body.priority) ? body.priority : "中",
      createdAt: localTimeString(),
      completedAt: null,
    };
    todosState.items.push(item);
    saveTodos();
    sendJson(res, { ok: true, item });
  }

  async function serveTodosUpdate(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const id = body && typeof body.id === "string" ? body.id : "";
    const patch = body && typeof body.patch === "object" && body.patch ? body.patch : null;
    if (!id || !patch) {
      return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "id/patch 无效" } }, 400);
    }
    const item = todosState.items.find((t) => t && t.id === id);
    if (!item) return sendJson(res, { ok: false, error: { code: "NOT_FOUND", message: "该条待办不存在" } }, 404);
    if (Object.prototype.hasOwnProperty.call(patch, "text")) {
      const text = sanitizeText(patch.text);
      if (!text) return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "text 不能为空" } }, 400);
      item.text = text;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "note")) item.note = sanitizeNote(patch.note);
    if (Object.prototype.hasOwnProperty.call(patch, "project")) item.project = sanitizeProjectRef(patch.project);
    if (Object.prototype.hasOwnProperty.call(patch, "due")) item.due = sanitizeDue(patch.due);
    if (typeof patch.done === "boolean") {
      item.done = patch.done;
      item.completedAt = patch.done ? localTimeString() : null;
    }
    if (typeof patch.priority === "string" && TODO_PRIORITIES.includes(patch.priority)) item.priority = patch.priority;
    saveTodos();
    sendJson(res, { ok: true, item });
  }

  async function serveTodosRemove(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const id = body && typeof body.id === "string" ? body.id : "";
    if (!id) return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "id 无效" } }, 400);
    const idx = todosState.items.findIndex((t) => t && t.id === id);
    if (idx < 0) return sendJson(res, { ok: false, error: { code: "NOT_FOUND", message: "该条待办不存在" } }, 404);
    todosState.items.splice(idx, 1);   // 硬删除
    saveTodos();
    sendJson(res, { ok: true });
  }

  // 改期：把某条待办的截止日改为 toDate（保留其余字段）
  async function serveTodosMove(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const id = body && typeof body.id === "string" ? body.id : "";
    const toDate = body && typeof body.toDate === "string" ? body.toDate : "";
    if (!TODO_DATE_RE.test(toDate) || !id) {
      return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "id/toDate 无效" } }, 400);
    }
    const item = todosState.items.find((t) => t && t.id === id);
    if (!item) return sendJson(res, { ok: false, error: { code: "NOT_FOUND", message: "该条待办不存在" } }, 404);
    item.due = toDate;
    saveTodos();
    sendJson(res, { ok: true, item });
  }

  // ---------- 项目管理 ----------
  async function serveTodosProjectsAdd(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const name = sanitizeProjectName(body && body.name);
    if (!name) return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "项目名不能为空" } }, 400);
    if (todosState.projects.includes(name)) {
      return sendJson(res, { ok: false, error: { code: "DUP_PROJECT", message: "项目已存在" } }, 400);
    }
    if (todosState.projects.length >= TODO_PROJECT_COUNT_MAX) {
      return sendJson(res, { ok: false, error: { code: "PROJECT_LIMIT", message: "项目数量已达上限" } }, 400);
    }
    todosState.projects.push(name);
    saveTodos();
    sendJson(res, { ok: true, projects: todosState.projects });
  }

  // 删除项目：条目 project 置 null（未分配），不删条目
  async function serveTodosProjectsRemove(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const name = sanitizeProjectName(body && body.name);
    const idx = todosState.projects.indexOf(name);
    if (idx < 0) return sendJson(res, { ok: false, error: { code: "NOT_FOUND", message: "项目不存在" } }, 404);
    todosState.projects.splice(idx, 1);
    for (const t of todosState.items) if (t.project === name) t.project = null;
    saveTodos();
    sendJson(res, { ok: true, projects: todosState.projects });
  }

  async function serveTodosProjectsRename(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) { sendJsonForbidden(res); return; }
    if (req.method !== "POST") { sendJson(res, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }, 405); return; }
    const body = await readJsonBody(req);
    const oldName = sanitizeProjectName(body && body.oldName);
    const newName = sanitizeProjectName(body && body.newName);
    if (!oldName || !newName) {
      return sendJson(res, { ok: false, error: { code: "BAD_BODY", message: "项目名不能为空" } }, 400);
    }
    if (!todosState.projects.includes(oldName)) {
      return sendJson(res, { ok: false, error: { code: "NOT_FOUND", message: "项目不存在" } }, 404);
    }
    if (oldName === newName) return sendJson(res, { ok: true, projects: todosState.projects });
    if (todosState.projects.includes(newName)) {
      return sendJson(res, { ok: false, error: { code: "DUP_PROJECT", message: "项目已存在" } }, 400);
    }
    todosState.projects[todosState.projects.indexOf(oldName)] = newName;
    for (const t of todosState.items) if (t.project === oldName) t.project = newName;
    saveTodos();
    sendJson(res, { ok: true, projects: todosState.projects });
  }

  const routes = {
    "/office-ui/todos/board": serveTodosBoard,
    "/office-ui/todos/list": serveTodosList,
    "/office-ui/todos/add": serveTodosAdd,
    "/office-ui/todos/update": serveTodosUpdate,
    "/office-ui/todos/remove": serveTodosRemove,
    "/office-ui/todos/move": serveTodosMove,
    "/office-ui/todos/projects/add": serveTodosProjectsAdd,
    "/office-ui/todos/projects/remove": serveTodosProjectsRemove,
    "/office-ui/todos/projects/rename": serveTodosProjectsRename,
  };

  return { routes };
}

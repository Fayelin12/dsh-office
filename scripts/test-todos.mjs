// 一次性后端冒烟：隔离临时 DSH_HOME，验证 todos v2（迁移 + 8 路由）
// 运行：node scripts/test-todos.mjs
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = await mkdtemp(join(tmpdir(), "office-todos-test-"));
process.env.DSH_HOME = TMP;

// ---- 先写旧格式数据，再加载模块（register 内 loadTodos 是异步的） ----
await mkdir(join(TMP, "office"), { recursive: true });
await writeFile(join(TMP, "office", "todos.json"), JSON.stringify({
  days: {
    "2026-08-26": [
      { id: "a1", text: "旧条目-已做", done: true, priority: "高", createdAt: "2026-08-26T09:00:00" },
      { id: "a2", text: "旧条目-未做", done: false, priority: "低", createdAt: "2026-08-26T10:00:00" },
    ],
    "2026-08-27": [{ id: "a3", text: "旧条目-次日", done: false, priority: "中", createdAt: "2026-08-27T08:00:00" }],
  },
}), "utf8");

const { register } = await import("../lib/todos.js");

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failed++; console.error("  ✗ " + msg); }
}

// ---- mock shared ----
const sendJson = (res, payload, status = 200) => {
  res.statusCode = status;
  res.end(JSON.stringify(payload));
};
const shared = {
  sendJson,
  sendJsonForbidden(res) { sendJson(res, { ok: false }, 403); },
  async readJsonBody(req) {
    try { return JSON.parse(req._body || "null"); } catch { return null; }
  },
  async ensureDataDir() { await mkdir(join(TMP, "office"), { recursive: true }); },
  localTimeString() { return "2026-08-28T10:00:00"; },
};
const { routes } = register({ shared });

function req(url, method = "GET", body = null, remote = "127.0.0.1") {
  return { url, method, socket: { remoteAddress: remote }, _body: body ? JSON.stringify(body) : null };
}
async function call(route, url, method, body, remote) {
  const res = { statusCode: 200, end(p) { this.body = p; } };
  await route(req(url, method, body, remote), res);
  return { status: res.statusCode, json: JSON.parse(res.body || "{}") };
}

await new Promise((r) => setTimeout(r, 500)); // 等 register 内 loadTodos 迁移完成

console.log("== 迁移 ==");
let r = await call(routes["/office-ui/todos/board"], "/office-ui/todos/board");
console.error("  [diag] board items =", r.json.data ? r.json.data.items.length : "(no data)", "status", r.status);
assert(r.status === 200 && r.json.ok, "board 200");
assert(r.json.data.items.length === 3, "迁移 3 条：实际 " + r.json.data.items.length);
const a1 = r.json.data.items.find((t) => t.id === "a1");
assert(a1 && a1.due === "2026-08-26" && a1.completedAt !== null && a1.note === "" && a1.project === null,
  "旧条目：due=创建日、完成带 completedAt、无备注无项目");
assert(r.json.data.projects.length === 0, "迁移无项目");

console.log("== 项目管理 ==");
r = await call(routes["/office-ui/todos/projects/add"], "/office-ui/todos/projects/add", "POST", { name: "dsh-office" });
assert(r.status === 200 && r.json.projects.length === 1, "添加项目 dsh-office");
r = await call(routes["/office-ui/todos/projects/add"], "/office-ui/todos/projects/add", "POST", { name: "dsh-office" });
assert(r.status === 400 && r.json.error.code === "DUP_PROJECT", "重复项目 400");
r = await call(routes["/office-ui/todos/projects/add"], "/office-ui/todos/projects/add", "POST", { name: "" });
assert(r.status === 400, "空项目名 400");

console.log("== 添加（带项目/due/备注） ==");
r = await call(routes["/office-ui/todos/add"], "/office-ui/todos/add", "POST",
  { project: "dsh-office", text: "看板上线", due: "2026-09-01", note: "含备注\n第二行", priority: "高" });
assert(r.status === 200 && r.json.item.project === "dsh-office" && r.json.item.due === "2026-09-01" && r.json.item.note === "含备注\n第二行", "添加完整条目");
const newId = r.json.item.id;
r = await call(routes["/office-ui/todos/add"], "/office-ui/todos/add", "POST", { date: "2026-08-28", text: "洞察加入（date 兼容）" });
assert(r.status === 200 && r.json.item.due === "2026-08-28", "date 参数兼容为 due");

console.log("== 更新 ==");
r = await call(routes["/office-ui/todos/update"], "/office-ui/todos/update", "POST", { id: newId, patch: { done: true } });
assert(r.status === 200 && r.json.item.completedAt === "2026-08-28T10:00:00", "勾选完成写 completedAt");
r = await call(routes["/office-ui/todos/update"], "/office-ui/todos/update", "POST", { id: newId, patch: { done: false } });
assert(r.status === 200 && r.json.item.completedAt === null, "取消完成清 completedAt");
r = await call(routes["/office-ui/todos/update"], "/office-ui/todos/update", "POST", { id: newId, patch: { project: null, due: "", note: "" } });
assert(r.status === 200 && r.json.item.project === null && r.json.item.due === null && r.json.item.note === "", "清空 project/due/note");
r = await call(routes["/office-ui/todos/update"], "/office-ui/todos/update", "POST", { id: newId, patch: { text: "  " } });
assert(r.status === 400, "空 text 400");

console.log("== 改期（move） ==");
r = await call(routes["/office-ui/todos/move"], "/office-ui/todos/move", "POST", { id: newId, toDate: "2026-09-02" });
assert(r.status === 200 && r.json.item.due === "2026-09-02", "move 改 due");

console.log("== 项目删除/重命名 ==");
r = await call(routes["/office-ui/todos/projects/rename"], "/office-ui/todos/projects/rename", "POST", { oldName: "dsh-office", newName: "办公室插件" });
assert(r.status === 200 && r.json.projects[0] === "办公室插件", "重命名项目");
r = await call(routes["/office-ui/todos/board"], "/office-ui/todos/board");
assert(r.json.data.items.every((t) => t.project !== "dsh-office"), "条目引用跟随重命名");
r = await call(routes["/office-ui/todos/projects/remove"], "/office-ui/todos/projects/remove", "POST", { name: "办公室插件" });
assert(r.status === 200 && r.json.projects.length === 0, "删除项目");
r = await call(routes["/office-ui/todos/board"], "/office-ui/todos/board");
assert(r.json.data.items.some((t) => t.project === null && t.id === newId), "删除项目后条目转未分配");

console.log("== 删除条目 ==");
r = await call(routes["/office-ui/todos/remove"], "/office-ui/todos/remove", "POST", { id: newId });
assert(r.status === 200, "删除条目 200");
r = await call(routes["/office-ui/todos/remove"], "/office-ui/todos/remove", "POST", { id: "nope" });
assert(r.status === 404, "删除不存在 404");

console.log("== 防护 ==");
r = await call(routes["/office-ui/todos/board"], "/office-ui/todos/board", "GET", null, "1.2.3.4");
assert(r.status === 403, "非 loopback 403");

// 落盘验证（saveTodos 异步落盘，稍等）
await new Promise((r) => setTimeout(r, 300));
let onDisk = null;
try {
  onDisk = JSON.parse(await readFile(join(TMP, "office", "todos.json"), "utf8"));
} catch (e) {
  console.error("  [diag] 落盘读取失败:", e.message);
}
assert(onDisk && onDisk.version === 2 && Array.isArray(onDisk.items) && Array.isArray(onDisk.projects), "落盘为 v2 结构");
assert(onDisk && onDisk.items.length === 4, "落盘含 4 条（实际 " + (onDisk ? onDisk.items.length : 0) + "）");

console.log(failed === 0 ? "\n全部通过 ✔" : "\n失败 " + failed + " 项 ✘");
process.exit(failed === 0 ? 0 : 1);

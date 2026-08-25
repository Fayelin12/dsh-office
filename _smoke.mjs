import { register as registerOffice } from "./lib/office.js";
import { register as registerMail } from "./lib/mail.js";
import { register as registerLark } from "./lib/lark.js";
import { register as registerInsights } from "./lib/insights.js";
import { register as registerTodos } from "./lib/todos.js";

const logger = { info(){}, warn(){}, error(){} };
const ctx = {
  logger,
  get: () => undefined,
  effect: (fn, name) => { try { return fn(); } catch (e) { console.log("EFFECT-ERR", name, e.message); } },
  on: () => () => {}
};
const services = {
  webServer: {}, workspaceRegistry: { list: () => [], archivedSessionIds: [] },
  sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
  agents: { list: () => [], on(){}, off(){} },
  sessionsSvc: { list: () => [], get: () => undefined },
  tokenMeter: {}, sessionProjections: {}, projectionCache: {},
  sessionPersistence: {}, connection: {}, credentials: {}
};
const shared = {};
const runtime = { ctx, services, shared };

for (const [name, reg] of [["office",registerOffice],["mail",registerMail],["lark",registerLark],["insights",registerInsights],["todos",registerTodos]]) {
  try {
    const { routes } = reg(runtime);
    console.log("REGISTER_OK", name, "routes:", Object.keys(routes).length);
  } catch (e) {
    console.log("REGISTER_FAIL", name, e.message, e.stack && e.stack.split("\n")[1]);
  }
}
console.log("shared keys:", Object.keys(shared).sort().join(", "));
console.log("SMOKE_DONE");

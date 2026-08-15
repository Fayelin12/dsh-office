window.__ModuleLoader__.load({
  id: "dsh-office",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const inject = ["connection", "slots"];

    function apply(ctx) {
      const store = { open: false, listeners: new Set() };
      function notify() { store.listeners.forEach((fn) => fn()); }
      function toggle() { store.open = !store.open; notify(); }

      function useOpen() {
        const [open, set] = React.useState(store.open);
        React.useEffect(() => {
          const fn = () => set(store.open);
          store.listeners.add(fn);
          return () => { store.listeners.delete(fn); };
        }, []);
        return open;
      }

      const connection = ctx.get("connection");
      const rpc = connection && connection.rpc ? connection.rpc : null;
      const sessions = ctx.get("sessions");

      // 拦截 sessions.open：任何会话选中（含重复点击当前会话）都关闭面板。
      // 只 watch currentId 无法捕捉「点当前会话」（current 不变），故拦截 open 调用本身。
      if (sessions && typeof sessions.open === "function") {
        const origOpen = sessions.open;
        sessions.open = function (id) {
          if (store.open) { store.open = false; notify(); }
          return origOpen.call(sessions, id);
        };
        ctx.effect(() => () => { sessions.open = origOpen; });
      }

      const timer = ctx.get("timer");
      let panelOpen = false;

      // session 跳转轮询：常驻但面板关闭时跳过，避免无意义 RPC
      if (timer && typeof timer.interval === "function" && rpc && typeof rpc.call === "function") {
        ctx.effect(() => timer.interval(() => {
          if (!panelOpen) return;
          rpc.call("/office", "consume-open", null).then((result) => {
            const sid = result && result.ok ? result.value : null;
            if (sid && sessions && typeof sessions.open === "function") {
              sessions.open(sid);
              store.open = false;
              notify();
            }
          }).catch(() => {});
        }, 2000), "office: poll open-session");
      }

      function timeAgo(ts) {
        if (typeof ts !== "number" || !isFinite(ts)) return "";
        const now = Date.now();
        const ms = ts > 1e12 ? ts : ts * 1000;
        const diff = now - ms;
        if (diff < 0) return "";
        const s = Math.floor(diff / 1000);
        if (s < 60) return "刚刚";
        const m = Math.floor(s / 60);
        if (m < 60) return m + " 分钟前";
        const h = Math.floor(m / 60);
        if (h < 24) return h + " 小时前";
        const d = Math.floor(h / 24);
        if (d < 7) return d + " 天前";
        return "更早";
      }

      // 悬浮会话边框色（按状态）：待确认黄 / 进行中蓝 / 已读绿 / 其他灰
      const ACCENT = {
        pending: "linear-gradient(135deg, rgb(255,204,0), rgb(255,149,0))",
        running: "linear-gradient(135deg, rgb(103,158,254), rgb(65,118,230))",
        completed: "linear-gradient(135deg, rgb(48,209,88), rgb(34,197,94))",
        other: "linear-gradient(135deg, rgb(174,174,178), rgb(142,142,147))"
      };

      function OfficeFab(props) {
        const open = useOpen();
        const useSessions = props && props.useSessions;
        const [hovered, setHovered] = React.useState(false);
        React.useEffect(() => {
          if (open) setHovered(false);
        }, [open]);

        const currentId = useSessions ? useSessions((state) => (state && state.current) || null) : null;

        // 所有会话（含当前），按 updatedAt 倒序；排除子代理
        const allSessions = useSessions ? useSessions((state) => {
          const ids = (state && state.ids) || [];
          const byId = (state && state.byId) || {};
          return ids
            .filter((id) => byId[id] && byId[id].origin !== "subagent")
            .sort((a, b) => (((byId[b] && byId[b].updatedAt) || 0) - ((byId[a] && byId[a].updatedAt) || 0)))
            .map((id) => {
              const s = byId[id];
              let status = "other";
              if (s && s.pendingInteraction) status = "pending";
              else if (s && s.running) status = "running";
              else if (s && s.completed) status = "completed";
              return {
                id,
                title: ((s && (s.title || s.displayTitle)) || String(id).slice(0, 6)),
                updatedAt: (s && s.updatedAt) || null,
                status,
                attention: status !== "other"
              };
            });
        }) : [];

        // 待确认会话，同步给 Host；排除子代理
        const pendingIds = useSessions ? useSessions((state) => {
          const ids = (state && state.ids) || [];
          const byId = (state && state.byId) || {};
          return ids.filter((id) => byId[id] && byId[id].origin !== "subagent" && byId[id].pendingInteraction).map((id) => String(id));
        }) : [];
        const pendingKey = pendingIds.join(",");
        React.useEffect(() => {
          if (rpc && typeof rpc.call === "function") {
            rpc.call("/office", "set-pending", { ids: pendingIds }).catch(() => {});
          }
        }, [pendingKey]);

        if (open) return null;
        const now = Date.now();
        const recentMs = 10 * 60 * 1000;
        const attentionSessions = allSessions.filter((s) => s.attention);
        const badgeCount = attentionSessions.length;
        const others = allSessions.filter((s) => s.id !== currentId);
        const merged = others.filter((s) => {
          if (s.attention) return true;
          if (s.updatedAt == null) return false;
          const ms = s.updatedAt > 1e12 ? s.updatedAt : s.updatedAt * 1000;
          return (now - ms) <= recentMs;
        });
        const showPopup = hovered && merged.length > 0;
        const popupSessions = merged;

        return React.createElement("div", {
          style: {
            position: "fixed", bottom: 24, right: 24, zIndex: 40, pointerEvents: "auto",
            display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8
          },
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false)
        },
          showPopup ? React.createElement("div", {
            style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, maxWidth: 320, maxHeight: 360, overflowY: "auto" }
          },
            popupSessions.map((s) => {
              const accent = ACCENT[s.status] || ACCENT.other;
              return React.createElement("button", {
                key: s.id,
                onClick: () => { if (sessions && typeof sessions.open === "function") sessions.open(s.id); },
                title: s.title,
                style: {
                  display: "flex", alignItems: "center", gap: 8,
                  maxWidth: 280,
                  padding: "6px 10px", borderRadius: 10,
                  border: "1px solid transparent",
                  background: "linear-gradient(var(--dsw-alias-bg-layer-1, #ffffff), var(--dsw-alias-bg-layer-1, #ffffff)) padding-box, " + accent + " border-box",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                  cursor: "pointer", fontFamily: "inherit", boxSizing: "border-box"
                }
              },
                React.createElement("div", {
                  style: { display: "flex", flexDirection: "column", alignItems: "flex-end", minWidth: 0, flex: "1 1 auto" }
                },
                  React.createElement("span", {
                    style: {
                      display: "block", fontSize: 13, lineHeight: "18px", maxWidth: "100%",
                      color: "var(--dsw-alias-label-primary, #1c1c1e)",
                      textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                    }
                  }, s.title),
                  timeAgo(s.updatedAt) ? React.createElement("span", {
                    style: {
                      display: "block", fontSize: 10, lineHeight: "14px",
                      color: "var(--dsw-alias-label-secondary, #6e6e73)",
                      textAlign: "right", fontVariantNumeric: "tabular-nums"
                    }
                  }, timeAgo(s.updatedAt)) : null
                )
              );
            })
          ) : null,
          React.createElement("button", {
            type: "button",
            onClick: toggle,
            title: "打开办公室",
            "aria-label": "打开办公室",
            style: {
              position: "relative",
              display: "flex", alignItems: "center", gap: 8,
              height: 44, padding: "0 18px", borderRadius: 22,
              border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))",
              cursor: "pointer", fontFamily: "inherit", fontSize: 14,
              color: "var(--dsw-alias-label-primary, #1c1c1e)",
              background: "var(--dsw-alias-bg-base, #ffffff)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.16)"
            }
          },
            React.createElement("span", { style: { fontSize: 16, lineHeight: 1 } }, "🏢"),
            React.createElement("span", null, "办公室"),
            badgeCount > 0 ? React.createElement("span", {
              style: {
                position: "absolute", top: 4, right: 8,
                width: 16, height: 16, borderRadius: 8,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 600, lineHeight: 1, color: "#ffffff",
                background: "linear-gradient(135deg, rgb(103,158,254), rgb(65,118,230))",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)"
              }
            }, badgeCount > 9 ? "9+" : String(badgeCount))
            : React.createElement("span", {
              style: {
                position: "absolute", top: 4, right: 8,
                fontSize: 12, lineHeight: 1
              }
            }, "☕️")
          )
        );
      }

      function OfficePanel(props) {
        const open = useOpen();
        const useSessions = props && props.useSessions;
        const currentId = useSessions ? useSessions((state) => (state && state.current) || null) : null;
        const anchorRef = React.useRef(undefined);
        // 面板打开期间，若当前会话变了（点了侧边栏其它会话），自动关闭面板，避免遮挡正常会话
        React.useEffect(() => {
          if (open) {
            if (anchorRef.current === undefined) anchorRef.current = currentId;
            else if (anchorRef.current !== currentId) {
              anchorRef.current = undefined;
              store.open = false;
              notify();
            }
          } else {
            anchorRef.current = undefined;
          }
        }, [open, currentId]);
        // 维护面板打开标志，供 poll 判断是否发 RPC
        React.useEffect(() => {
          panelOpen = open;
          return () => { panelOpen = false; };
        }, [open]);
        if (!open) return null;
        return React.createElement("div", {
          style: { position: "fixed", top: 0, bottom: 0, right: 0, left: "280px", zIndex: 30, pointerEvents: "auto" }
        },
          React.createElement("iframe", {
            src: "/office-ui/",
            style: { width: "100%", height: "100%", border: "none", display: "block" }
          }),
          React.createElement("button", {
            type: "button",
            onClick: toggle,
            title: "退出办公室",
            "aria-label": "退出办公室",
            style: {
              position: "absolute", bottom: 24, right: 24, zIndex: 31,
              display: "flex", alignItems: "center", gap: 8,
              height: 44, padding: "0 18px", borderRadius: 22,
              border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))",
              cursor: "pointer", fontFamily: "inherit", fontSize: 14,
              color: "var(--dsw-alias-label-primary, #1c1c1e)",
              background: "var(--dsw-alias-bg-base, #ffffff)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.16)"
            }
          },
            React.createElement("span", { style: { fontSize: 16, lineHeight: 1 } }, "🚪"),
            React.createElement("span", null, "退出")
          )
        );
      }

      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "office-fab", order: 90, label: "办公室入口" },
        OfficeFab
      ));

      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "office-panel", order: 100, label: "办公室面板" },
        OfficePanel
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

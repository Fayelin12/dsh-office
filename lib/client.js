window.__ModuleLoader__.load({
  id: "dsh-office",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const inject = ["connection", "slots"];

    function apply(ctx) {
      const store = { open: false, listeners: new Set(), sessionSnapshot: null };
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

      // 悬浮提示状态（📢 飞书收到@你的消息）：Host rpc feishu-notice 轮询写入
      const noticeState = { value: null, listeners: new Set() };
      function setNotice(n) {
        noticeState.value = n;
        noticeState.listeners.forEach((fn) => fn(n));
      }
      function useNotice() {
        const [n, setN] = React.useState(noticeState.value);
        React.useEffect(() => {
          const fn = (v) => setN(v);
          noticeState.listeners.add(fn);
          return () => { noticeState.listeners.delete(fn); };
        }, []);
        return n;
      }

      // 会议提醒状态（⏰ 提前 1 小时闹钟）：Host rpc calendar-notice 每 5 分钟轮询写入
      // value: { meetings: [{ summary, start, end, start_ts, end_ts, meeting_url, app_link, organizer, minutesLeft }] }
      const meetingState = { value: null, listeners: new Set() };
      function setMeeting(m) {
        meetingState.value = m;
        meetingState.listeners.forEach((fn) => fn(m));
      }
      function useMeeting() {
        const [m, setM] = React.useState(meetingState.value);
        React.useEffect(() => {
          const fn = (v) => setM(v);
          meetingState.listeners.add(fn);
          return () => { meetingState.listeners.delete(fn); };
        }, []);
        return m;
      }
      // 面板打开后待打开的视图（⏰ 点击 → 打开面板 + 切到会议视图）
      const pendingView = { value: null, listeners: new Set() };
      function setPendingView(v) {
        pendingView.value = v;
        pendingView.listeners.forEach((fn) => fn(v));
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

      // 飞书「提到我」悬浮提示轮询：30s 一次，同一 at 只显示一次
      if (timer && typeof timer.interval === "function" && rpc && typeof rpc.call === "function") {
        let lastShownAt = null;
        ctx.effect(() => timer.interval(() => {
          rpc.call("/office", "feishu-notice", null).then((result) => {
            const n = result && result.ok ? result.value : null;
            if (n && n.at && n.at !== lastShownAt) {
              lastShownAt = n.at;
              setNotice(n);
            }
          }).catch(() => {});
        }, 30000), "office: poll feishu notice");
      }

      // ⏰ 会议提醒轮询：每 5 分钟一次，返回「未来 2 小时内开始的会议」
      if (timer && typeof timer.interval === "function" && rpc && typeof rpc.call === "function") {
        ctx.effect(() => timer.interval(() => {
          rpc.call("/office", "calendar-notice", null).then((result) => {
            const v = result && result.ok ? result.value : null;
            if (v && Array.isArray(v.meetings) && v.meetings.length) {
              setMeeting({ meetings: v.meetings, fetchedAt: v.fetchedAt || null });
            } else {
              setMeeting(null);
            }
          }).catch(() => {});
        }, 5 * 60 * 1000), "office: poll calendar notice");
        // 启动时立即拉一次（不等第一个 5 分钟间隔）
        setTimeout(() => {
          rpc.call("/office", "calendar-notice", null).then((result) => {
            const v = result && result.ok ? result.value : null;
            if (v && Array.isArray(v.meetings) && v.meetings.length) {
              setMeeting({ meetings: v.meetings, fetchedAt: v.fetchedAt || null });
            } else {
              setMeeting(null);
            }
          }).catch(() => {});
        }, 3000);
      }

      // 提示动画 keyframes（客户端 DOM，随插件卸载清理）
      const noticeStyleEl = document.createElement("style");
      noticeStyleEl.textContent =
        "@keyframes officeNoticeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}" +
        "@keyframes officeNoticeOut{from{opacity:1}to{opacity:0;transform:translateY(-6px)}}";
      document.head.appendChild(noticeStyleEl);
      ctx.effect(() => () => { try { document.head.removeChild(noticeStyleEl); } catch (_) {} }, "office: notice styles");

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

        // 飞书「提到我」提示：出现后 6s 自动消失
        const notice = useNotice();
        React.useEffect(() => {
          if (!notice) return;
          const t = setTimeout(() => setNotice(null), 6000);
          return () => clearTimeout(t);
        }, [notice ? notice.at : null]);

        // ⏰ 会议提醒：读取 Host 轮询写入的会议列表，本地 30s 刷新倒计时显示
        const meeting = useMeeting();
        const [meetingTick, setMeetingTick] = React.useState(0);
        React.useEffect(() => {
          const t = setInterval(() => setMeetingTick((x) => x + 1), 30000);
          return () => clearInterval(t);
        }, []);
        // 找到「最近一场即将开始/进行中」的会议（按开始时间升序取第一条）
        function nearestMeeting(m) {
          if (!m || !Array.isArray(m.meetings) || !m.meetings.length) return null;
          const nowMs = Date.now();
          const upcoming = m.meetings
            .filter((e) => typeof e.start_ts === "number" && isFinite(e.start_ts) && e.start_ts >= nowMs - 3600 * 1000)
            .sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
          return upcoming[0] || null;
        }
        function meetingCountdownText(e) {
          if (!e) return "";
          const ms = (e.start_ts || 0) - Date.now();
          const min = Math.max(0, Math.ceil(ms / 60000));
          if (ms <= 0) return "进行中";
          if (min < 60) return "还剩 " + min + " 分钟";
          const h = Math.floor(min / 60), m = min % 60;
          return "还剩 " + h + " 小时" + (m ? " " + m + " 分" : "");
        }
        const nearest = nearestMeeting(meeting);

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

        // 顺手存一份快照，供 OfficePanel 打开时即时渲染（零额外开销）
        store.sessionSnapshot = allSessions;

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
          notice ? React.createElement("div", {
            key: notice.at,
            style: {
              maxWidth: 340,
              display: "flex", alignItems: "center", gap: 6,
              padding: "8px 12px", borderRadius: 12,
              fontSize: 12, fontWeight: 600, lineHeight: 1.4, color: "#1c1c1e",
              background: "linear-gradient(135deg, rgb(255,214,10), rgb(255,159,10))",
              boxShadow: "0 6px 18px rgba(0,0,0,0.22)",
              animation: "officeNoticeIn .3s ease, officeNoticeOut .4s ease 5.2s forwards"
            }
          },
            React.createElement("span", null, "📢"),
            React.createElement("span", null,
              "飞书收到@你的消息" + (notice.chat ? "（" + notice.chat + "）" : "")
            )
          ) : null,
          showPopup ? React.createElement("div", {
            style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, maxWidth: 320, maxHeight: 360, overflowY: "auto" }
          },
            popupSessions.map((s) => {
              const accent = ACCENT[s.status] || ACCENT.other;
              const ago = timeAgo(s.updatedAt);
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
                  ago ? React.createElement("span", {
                    style: {
                      display: "block", fontSize: 10, lineHeight: "14px",
                      color: "var(--dsw-alias-label-secondary, #6e6e73)",
                      textAlign: "right", fontVariantNumeric: "tabular-nums"
                    }
                  }, ago) : null
                )
              );
            })
          ) : null,
          // ⏰ 会议提醒按钮：有会议（提前 1 小时 ~ 进行中）时显示，点击打开面板并切到会议视图
          nearest ? React.createElement("button", {
            type: "button",
            onClick: () => {
              store.open = true;
              setPendingView("calendar");
              notify();
            },
            title: (nearest.summary || "会议") + " · " + ((nearest.start || "").slice(11) || "") + " 开始",
            "aria-label": "会议提醒",
            style: {
              position: "relative",
              display: "flex", alignItems: "center", gap: 8,
              height: 44, padding: "0 16px", borderRadius: 22,
              border: "1px solid " + ((nearest.start_ts || 0) <= Date.now() ? "rgba(52,199,89,0.6)" : "rgba(255,159,10,0.65)"),
              cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
              color: "#1c1c1e",
              background: "linear-gradient(135deg, rgb(255,214,10), rgb(255,159,10))",
              boxShadow: "0 8px 24px rgba(255,149,0,0.28)"
            }
          },
            React.createElement("span", { style: { fontSize: 16, lineHeight: 1 } }, "⏰"),
            React.createElement("span", {
              style: { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }
            }, meetingCountdownText(nearest))
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
        const [iframeReady, setIframeReady] = React.useState(false);

        // 注入覆盖层动画 CSS（只注入一次）
        React.useEffect(() => {
          if (!document.getElementById("office-panel-keyframes")) {
            var style = document.createElement("style");
            style.id = "office-panel-keyframes";
            style.textContent = "@keyframes officeSpin{to{transform:rotate(360deg)}}@keyframes officeOverlayOut{from{opacity:1}to{opacity:0;pointer-events:none}}";
            document.head.appendChild(style);
          }
        }, []);

        // 面板打开时重置 iframe 就绪状态
        React.useEffect(() => {
          if (open) setIframeReady(false);
        }, [open]);

        // 面板打开期间，若当前会话变了（点了侧边栏其它会话），自动关闭面板
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
        React.useEffect(() => {
          panelOpen = open;
          return () => { panelOpen = false; };
        }, [open]);

        // 直接读取 useSessions —— 和 OfficeFab 完全一样，零延迟
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
                status
              };
            });
        }) : [];

        if (!open) return null;
        return React.createElement("div", {
          style: { position: "fixed", top: 0, bottom: 0, right: 0, left: "280px", zIndex: 30, pointerEvents: "auto" }
        },
          // 底层：iframe（加载中时 opacity:0 但仍在加载）
          React.createElement("iframe", {
            src: "/office-ui/",
            onLoad: function () {
              setIframeReady(true);
              try {
                var snap = store.sessionSnapshot;
                if (snap && this.contentWindow) {
                  this.contentWindow.postMessage({ type: "office-snapshot", sessions: snap }, "*");
                }
                if (pendingView.value === "calendar" && this.contentWindow) {
                  pendingView.value = null;
                  this.contentWindow.postMessage({ type: "office-open-calendar" }, "*");
                }
              } catch (_) {}
            },
            style: {
              width: "100%", height: "100%", border: "none", display: "block",
              opacity: iframeReady ? 1 : 0,
              transition: "opacity 0.25s ease-in"
            }
          }),
          // 上层：React 快照覆盖层（iframe 就绪后淡出）
          !iframeReady && allSessions.length > 0 ? React.createElement("div", {
            style: {
              position: "absolute", top: 0, bottom: 0, right: 0, left: 0, zIndex: 32,
              background: "var(--dsw-alias-bg-base, #f5f5f7)",
              display: "flex", flexDirection: "column",
              padding: "24px 32px",
              overflowY: "auto"
            }
          },
            React.createElement("div", {
              style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }
            },
              React.createElement("span", { style: { fontSize: 22 } }, "🏢"),
              React.createElement("span", {
                style: { fontSize: 18, fontWeight: 600, color: "var(--dsw-alias-label-primary, #1c1c1e)" }
              }, "办公室"),
              React.createElement("span", {
                style: {
                  fontSize: 11, fontWeight: 500, color: "var(--dsw-alias-label-secondary, #86868b)",
                  padding: "2px 8px", borderRadius: 6,
                  background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.04))"
                }
              }, "加载中…")
            ),
            React.createElement("div", {
              style: {
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: 10
              }
            },
              allSessions.slice(0, 24).map(function (s) {
                var statusColor = s.status === "running" ? "rgb(103,158,254)"
                  : s.status === "pending" ? "rgb(255,204,0)"
                  : s.status === "completed" ? "rgb(48,209,88)"
                  : "rgb(174,174,178)";
                return React.createElement("div", {
                  key: s.id,
                  style: {
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 14px", borderRadius: 12,
                    background: "var(--dsw-alias-bg-layer-1, #ffffff)",
                    border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.15))",
                    boxShadow: "0 1px 4px rgba(0,0,0,0.06)"
                  }
                },
                  // 状态指示器
                  s.status === "running"
                    ? React.createElement("div", {
                        style: {
                          width: 14, height: 14, borderRadius: 7, flexShrink: 0,
                          border: "2px solid " + statusColor,
                          borderTopColor: "transparent",
                          animation: "officeSpin 0.8s linear infinite"
                        }
                      })
                    : React.createElement("div", {
                        style: {
                          width: 10, height: 10, borderRadius: 5, flexShrink: 0,
                          background: statusColor
                        }
                      }),
                  // 标题
                  React.createElement("div", {
                    style: {
                      flex: 1, minWidth: 0,
                      fontSize: 13, lineHeight: "18px",
                      color: "var(--dsw-alias-label-primary, #1c1c1e)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                    }
                  }, s.title)
                );
              })
            )
          ) : null,
          // 退出按钮（始终可见）
          React.createElement("button", {
            type: "button",
            onClick: toggle,
            title: "退出办公室",
            "aria-label": "退出办公室",
            style: {
              position: "absolute", bottom: 24, right: 24, zIndex: 33,
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

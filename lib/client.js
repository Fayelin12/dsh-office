window.__ModuleLoader__.load({
  id: "dsh-office",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const inject = ["connection", "slots"];

    /* ── 常量 ── */
    const POLL_OPEN_SESSION_MS = 2000;
    const POLL_FEISHU_NOTICE_MS = 30000;
    const CALENDAR_INITIAL_DELAY_MS = 3000;
    const NOTICE_AUTO_DISMISS_MS = 6000;
    const RECENT_SESSION_WINDOW_MS = 10 * 60 * 1000;
    const ONE_HOUR_MS = 3600 * 1000;
    const MEETING_WINDOW_MS = 2 * 3600 * 1000;
    const MS_PER_MINUTE = 60000;
    const TS_THRESHOLD_MS = 1e12;
    const MS_PER_SECOND = 1000;
    const SECONDS_PER_MINUTE = 60;
    const MINUTES_PER_HOUR = 60;
    const HOURS_PER_DAY = 24;
    const DAYS_PER_WEEK = 7;

    const RPC_CHANNEL = '/office';
    const RPC_CONSUME_OPEN = 'consume-open';
    const RPC_FEISHU_NOTICE = 'feishu-notice';
    const RPC_CALENDAR_NOTICE = 'calendar-notice';
    const RPC_SET_PENDING = 'set-pending';
    const OFFICE_UI_URL = '/office-ui/';

    const GRADIENT_PENDING = 'linear-gradient(135deg, rgb(255,204,0), rgb(255,149,0))';
    const GRADIENT_RUNNING = 'linear-gradient(135deg, rgb(103,158,254), rgb(65,118,230))';
    const GRADIENT_COMPLETED = 'linear-gradient(135deg, rgb(48,209,88), rgb(34,197,94))';
    const COLOR_OTHER_GRAY = 'rgb(174,174,178)';
    const GRADIENT_NOTICE_YELLOW = 'linear-gradient(135deg, rgb(255,214,10), rgb(255,159,10))';

    const SHADOW_BUTTON = '0 2px 8px rgba(0,0,0,0.12)';

    const POSITION_EDGE_OFFSET = 24;
    const BUTTON_HEIGHT = 44;
    const BORDER_RADIUS_PILL = 22;
    const BORDER_RADIUS_CARD = 12;
    const BORDER_RADIUS_BUTTON = 10;
    const GAP_DEFAULT = 8;
    const SESSION_GRID_LIMIT = 24;
    const BADGE_MAX_COUNT = 9;

    function createPubSub(initial) {
      const state = { value: initial, listeners: new Set() };
      function set(v) { state.value = v; state.listeners.forEach(fn => fn(v)); }
      function use() {
        const [v, setV] = React.useState(state.value);
        React.useEffect(() => {
          const fn = (val) => setV(val);
          state.listeners.add(fn);
          return () => { state.listeners.delete(fn); };
        }, []);
        return v;
      }
      return { state, set, use };
    }

    function injectKeyframes(id, css) {
      if (document.getElementById(id)) return;
      const el = document.createElement("style");
      el.id = id;
      el.textContent = css;
      document.head.appendChild(el);
      return el;
    }

    // Inject CSS classes for office components
    const officeStyleEl = document.createElement("style");
    officeStyleEl.id = "office-component-styles";
    officeStyleEl.textContent = `
      .office-fab-container {
        position: fixed; bottom: 24px; right: 24px; z-index: 40;
        pointer-events: auto; display: flex; flex-direction: column;
        align-items: flex-end; gap: 8px;
      }
      .office-fab-btn {
        display: flex; align-items: center; gap: 8px;
        height: 44px; padding: 0 18px; border-radius: 22px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25));
        cursor: pointer; font-family: inherit; font-size: 14px;
        color: var(--dsw-alias-label-primary, #1c1c1e);
        background: var(--dsw-alias-bg-base, #ffffff);
        box-shadow: 0 8px 24px rgba(0,0,0,0.16);
      }
      .office-panel-overlay {
        position: fixed; top: 0; bottom: 0; right: 0; left: 280px;
        z-index: 30; pointer-events: auto;
      }
      .office-panel-iframe { width: 100%; height: 100%; border: none; display: block; }
      .office-exit-btn {
        position: absolute; bottom: 24px; right: 24px; z-index: 31;
        display: flex; align-items: center; gap: 8px;
        height: 44px; padding: 0 18px; border-radius: 22px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25));
        cursor: pointer; font-family: inherit; font-size: 14px;
        color: var(--dsw-alias-label-primary, #1c1c1e);
        background: var(--dsw-alias-bg-base, #ffffff);
        box-shadow: 0 8px 24px rgba(0,0,0,0.16);
      }
      .snapshot-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 10px; padding: 10px 14px;
      }
      .snapshot-card {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 14px; border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.15));
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        box-shadow: 0 1px 4px rgba(0,0,0,0.06);
      }
    `;
    document.head.appendChild(officeStyleEl);

    function unwrapResult(r) { return r && r.ok ? r.value : null; }

    function apply(ctx) {
      const { state: openState, set: _setOpen, use: useOpen } = createPubSub(false);
      const store = {
        get open() { return openState.value; },
        set open(v) { _setOpen(v); },
        toggle() { _setOpen(!openState.value); },
        sessionSnapshot: null
      };

      // 悬浮提示状态（📢 飞书收到@你的消息）：Host rpc feishu-notice 轮询写入
      const { state: noticeState, set: setNotice, use: useNotice } = createPubSub(null);

      // 会议提醒状态（⏰ 提前 1 小时闹钟）：Host rpc calendar-notice 每 5 分钟轮询写入
      // value: { meetings: [{ summary, start, end, start_ts, end_ts, meeting_url, app_link, organizer, minutesLeft }] }
      const { state: meetingState, set: setMeeting, use: useMeeting } = createPubSub(null);
      // 面板打开后待打开的视图（⏰ 点击 → 打开面板 + 切到会议视图）
      const pendingView = { value: null };

      const connection = ctx.get("connection");
      const rpc = connection && connection.rpc ? connection.rpc : null;
      const sessions = ctx.get("sessions");

      // 拦截 sessions.open：任何会话选中（含重复点击当前会话）都关闭面板。
      // 只 watch currentId 无法捕捉「点当前会话」（current 不变），故拦截 open 调用本身。
      if (sessions && typeof sessions.open === "function") {
        const origOpen = sessions.open;
        sessions.open = function (id) {
          if (store.open) { store.open = false; }
          return origOpen.call(sessions, id);
        };
        ctx.effect(() => () => { sessions.open = origOpen; });
      }

      const timer = ctx.get("timer");
      const canPoll = timer && typeof timer.interval === "function" && rpc && typeof rpc.call === "function";
      let panelOpen = false;

      // session 跳转轮询：常驻但面板关闭时跳过，避免无意义 RPC
      if (canPoll) {
        ctx.effect(() => timer.interval(() => {
          if (!panelOpen) return;
          rpc.call(RPC_CHANNEL, RPC_CONSUME_OPEN, null).then((result) => {
            const sid = unwrapResult(result);
            if (sid && sessions && typeof sessions.open === "function") {
              sessions.open(sid);
              store.open = false;
            }
          }).catch(() => {});
        }, POLL_OPEN_SESSION_MS), "office: poll open-session");
      }

      // 飞书「提到我」悬浮提示轮询：30s 一次，同一 at 只显示一次
      if (canPoll) {
        let lastShownAt = null;
        ctx.effect(() => timer.interval(() => {
          rpc.call(RPC_CHANNEL, RPC_FEISHU_NOTICE, null).then((result) => {
            const n = unwrapResult(result);
            if (n && n.at && n.at !== lastShownAt) {
              lastShownAt = n.at;
              setNotice(n);
            }
          }).catch(() => {});
        }, POLL_FEISHU_NOTICE_MS), "office: poll feishu notice");
      }

      // ⏰ 会议提醒轮询：前端先判断再轮询（动态频率）
      // - 有会议在 2 小时内开始/进行中 → 每 5 分钟高频轮询（刷新倒计时 + 捕捉变更）
      // - 无临近会议 → 每 30 分钟低频轮询（只发现"新会议加入/改期"），避免空转
      // 用 setTimeout 链替代固定 interval：每次拉完后根据结果决定下次间隔
      if (canPoll) {
        const HIGH_MS = 5 * 60 * 1000;
        const LOW_MS = 30 * 60 * 1000;
        let meetingTimer = null;
        let disposed = false;

        function pollCalendar() {
          if (disposed) return;
          rpc.call(RPC_CHANNEL, RPC_CALENDAR_NOTICE, null).then((result) => {
            const v = unwrapResult(result);
            let nextMs = LOW_MS;
            if (v && Array.isArray(v.meetings) && v.meetings.length) {
              setMeeting({ meetings: v.meetings, fetchedAt: v.fetchedAt || null });
              // 有会议在 2 小时内开始 → 高频；否则低频
              const nowMs = Date.now();
              const hasSoon = v.meetings.some((m) =>
                typeof m.start_ts === "number" && isFinite(m.start_ts) &&
                m.start_ts >= nowMs - ONE_HOUR_MS && m.start_ts <= nowMs + MEETING_WINDOW_MS);
              nextMs = hasSoon ? HIGH_MS : LOW_MS;
            } else {
              setMeeting(null);
              nextMs = LOW_MS;
            }
            if (!disposed) meetingTimer = setTimeout(pollCalendar, nextMs);
          }).catch(() => {
            if (!disposed) meetingTimer = setTimeout(pollCalendar, LOW_MS);
          });
        }
        // 启动时立即拉一次（不等第一个间隔）
        meetingTimer = setTimeout(pollCalendar, CALENDAR_INITIAL_DELAY_MS);
        ctx.effect(() => () => {
          disposed = true;
          if (meetingTimer) clearTimeout(meetingTimer);
        }, "office: poll calendar notice");
      }

      // 提示动画 keyframes（客户端 DOM，随插件卸载清理）
      const noticeStyleEl = injectKeyframes("office-notice-keyframes",
        "@keyframes officeNoticeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}" +
        "@keyframes officeNoticeOut{from{opacity:1}to{opacity:0;transform:translateY(-6px)}}");
      ctx.effect(() => () => { try { document.head.removeChild(noticeStyleEl); } catch (_) {} }, "office: notice styles");

      function timeAgo(ts) {
        if (typeof ts !== "number" || !isFinite(ts)) return "";
        const now = Date.now();
        const ms = ts > TS_THRESHOLD_MS ? ts : ts * MS_PER_SECOND;
        const diff = now - ms;
        if (diff < 0) return "";
        const s = Math.floor(diff / MS_PER_SECOND);
        if (s < SECONDS_PER_MINUTE) return "刚刚";
        const m = Math.floor(s / SECONDS_PER_MINUTE);
        if (m < MINUTES_PER_HOUR) return m + " 分钟前";
        const h = Math.floor(m / MINUTES_PER_HOUR);
        if (h < HOURS_PER_DAY) return h + " 小时前";
        const d = Math.floor(h / HOURS_PER_DAY);
        if (d < DAYS_PER_WEEK) return d + " 天前";
        return "更早";
      }

      // 悬浮会话边框色（按状态）：待确认黄 / 进行中蓝 / 已读绿 / 其他灰
      const ACCENT = {
        pending: GRADIENT_PENDING,
        running: GRADIENT_RUNNING,
        completed: GRADIENT_COMPLETED,
        other: "linear-gradient(135deg, " + COLOR_OTHER_GRAY + ", rgb(142,142,147))"
      };

      function useAllSessions(useSessions) {
        return useSessions ? useSessions((state) => {
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
      }

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
          const t = setTimeout(() => setNotice(null), NOTICE_AUTO_DISMISS_MS);
          return () => clearTimeout(t);
        }, [notice ? notice.at : null]);

        // ⏰ 会议提醒：读取 Host 轮询写入的会议列表，本地 30s 刷新倒计时显示
        const meeting = useMeeting();
        // 找到「最近一场即将开始/进行中」的会议（按开始时间升序取第一条）
        // 窗口：进行中(-1h) ~ 未来 2 小时内开始；与后端 calendar-notice 的 120 分钟窗口一致
        function nearestMeeting(m) {
          if (!m || !Array.isArray(m.meetings) || !m.meetings.length) return null;
          const nowMs = Date.now();
          const upcoming = m.meetings
            .filter((e) => typeof e.start_ts === "number" && isFinite(e.start_ts) &&
              e.start_ts >= nowMs - ONE_HOUR_MS && e.start_ts <= nowMs + MEETING_WINDOW_MS)
            .sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
          return upcoming[0] || null;
        }
        // Keep in sync with calCountdown() in office.html — same formatting logic
        function meetingCountdownText(e) {
          if (!e) return "";
          const ms = (e.start_ts || 0) - Date.now();
          const min = Math.max(0, Math.ceil(ms / MS_PER_MINUTE));
          if (ms <= 0) return "进行中";
          if (min < 60) return min + "分后有会议";
          const h = Math.floor(min / 60), m = min % 60;
          return m ? h + "时" + m + "分后有会议" : h + "时有会议";
        }
        const nearest = nearestMeeting(meeting);

        const currentId = useSessions ? useSessions((state) => (state && state.current) || null) : null;

        // 所有会话（含当前），按 updatedAt 倒序；排除子代理
        const allSessions = useAllSessions(useSessions);

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
            rpc.call(RPC_CHANNEL, RPC_SET_PENDING, { ids: pendingIds }).catch(() => {});
          }
        }, [pendingKey]);

        if (open) return null;
        const now = Date.now();
        const attentionSessions = allSessions.filter((s) => s.attention);
        const badgeCount = attentionSessions.length;
        const others = allSessions.filter((s) => s.id !== currentId);
        const merged = others.filter((s) => {
          if (s.attention) return true;
          if (s.updatedAt == null) return false;
          const ms = s.updatedAt > TS_THRESHOLD_MS ? s.updatedAt : s.updatedAt * MS_PER_SECOND;
          return (now - ms) <= RECENT_SESSION_WINDOW_MS;
        });
        const showPopup = hovered && merged.length > 0;
        const popupSessions = merged;

        return React.createElement("div", {
          className: "office-fab-container",
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false)
        },
          notice ? React.createElement("div", {
            key: notice.at,
            style: {
              maxWidth: 340,
              display: "flex", alignItems: "center", gap: 6,
              padding: "8px 12px", borderRadius: BORDER_RADIUS_CARD,
              fontSize: 12, fontWeight: 600, lineHeight: 1.4, color: "#1c1c1e",
              background: GRADIENT_NOTICE_YELLOW,
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
                  display: "flex", alignItems: "center", gap: GAP_DEFAULT,
                  maxWidth: 280,
                  padding: "6px 10px", borderRadius: BORDER_RADIUS_BUTTON,
                  border: "1px solid transparent",
                  background: "linear-gradient(var(--dsw-alias-bg-layer-1, #ffffff), var(--dsw-alias-bg-layer-1, #ffffff)) padding-box, " + accent + " border-box",
                  boxShadow: SHADOW_BUTTON,
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
              pendingView.value = "calendar";
            },
            title: (nearest.summary || "会议") + " · " + ((nearest.start || "").slice(11) || "") + " 开始",
            "aria-label": "会议提醒",
            style: {
              position: "relative",
              display: "flex", alignItems: "center", gap: GAP_DEFAULT,
              height: BUTTON_HEIGHT, padding: "0 16px", borderRadius: BORDER_RADIUS_BUTTON,
              border: "1.5px solid transparent",
              cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
              color: "var(--dsw-alias-label-primary, #1c1c1e)",
              background: "linear-gradient(var(--dsw-alias-bg-layer-1, #ffffff), var(--dsw-alias-bg-layer-1, #ffffff)) padding-box, " + ((nearest.start_ts || 0) <= Date.now() ? GRADIENT_COMPLETED : GRADIENT_NOTICE_YELLOW) + " border-box",
              boxShadow: SHADOW_BUTTON,
              boxSizing: "border-box"
            }
          },
            React.createElement("span", { style: { fontSize: 16, lineHeight: 1 } }, "⏰"),
            React.createElement("span", {
              style: { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }
            }, meetingCountdownText(nearest))
          ) : null,
          React.createElement("button", {
            type: "button",
            onClick: store.toggle,
            title: "打开办公室",
            "aria-label": "打开办公室",
            className: "office-fab-btn",
            style: { position: "relative" }
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
            }, badgeCount > BADGE_MAX_COUNT ? BADGE_MAX_COUNT + "+" : String(badgeCount))
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
          injectKeyframes("office-panel-keyframes",
            "@keyframes officeSpin{to{transform:rotate(360deg)}}@keyframes officeOverlayOut{from{opacity:1}to{opacity:0;pointer-events:none}}");
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
            }
          } else {
            anchorRef.current = undefined;
          }
        }, [open, currentId]);
        React.useEffect(() => {
          panelOpen = open;
          return () => { panelOpen = false; };
        }, [open]);

        // 所有会话，按 updatedAt 倒序；排除子代理
        const allSessions = useAllSessions(useSessions);

        if (!open) return null;
        return React.createElement("div", {
          className: "office-panel-overlay"
        },
          // 底层：iframe（加载中时 opacity:0 但仍在加载）
          React.createElement("iframe", {
            src: OFFICE_UI_URL,
            onLoad: function () {
              setIframeReady(true);
              try {
                var snap = store.sessionSnapshot;
                if (snap && this.contentWindow) {
                  this.contentWindow.postMessage({ type: "office-snapshot", sessions: snap }, window.location.origin);
                }
                if (pendingView.value === "calendar" && this.contentWindow) {
                  pendingView.value = null;
                  this.contentWindow.postMessage({ type: "office-open-calendar" }, window.location.origin);
                }
              } catch (_) {}
            },
            className: "office-panel-iframe",
            style: {
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
              padding: POSITION_EDGE_OFFSET + "px 32px",
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
              className: "snapshot-grid"
            },
              allSessions.slice(0, SESSION_GRID_LIMIT).map(function (s) {
                var statusColor = s.status === "running" ? "rgb(103,158,254)"
                  : s.status === "pending" ? "rgb(255,204,0)"
                  : s.status === "completed" ? "rgb(48,209,88)"
                  : COLOR_OTHER_GRAY;
                return React.createElement("div", {
                  key: s.id,
                  className: "snapshot-card"
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
            onClick: store.toggle,
            title: "退出办公室",
            "aria-label": "退出办公室",
            className: "office-exit-btn",
            style: { zIndex: 33 }
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

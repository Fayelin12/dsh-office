  // ---------- 启动：拉数据 → 渲染 → 轮询（数据变化才重渲） ----------
  // P2-1: lightweight structural key instead of full JSON.stringify
  function getDataKey() {
    return (DATA.columns || []).map((col) => {
      return (col.workspaces || []).map((ws) => {
        const sessKey = (ws.sessions || []).map((s) =>
          s.id + ':' + (s.active ? '1' : '0') + ':' + (s.pending ? '1' : '0') + ':' + (s.inputTokens || 0) + ':' + (s.tokenTotal || 0)
        ).join(',');
        return ws.id + ':' + (ws.sessionCount || 0) + ':' + (ws.tokenTotal || 0) + '[' + sessKey + ']';
      }).join('|');
    }).join('::');
  }
  let lastDataKey = '';
  function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
      setTimeout(() => overlay.remove(), 300);
    }
  }
  async function refresh() {
    if (mailViewOpen || feishuViewOpen || todoViewOpen) return;  // 邮箱/飞书/待办视图打开时不轮询办公室数据
    try {
      await fetchData();
      // 合并快照实时状态：客户端 useSessions 比服务端 agents.list() 更快知道 running/pending
      // 只"提升"不"降级"——快照说 active 但服务端说 idle → 以快照为准；反之不改
      if (_snapshotStatus) {
        mergeSnapshotStatus();
        _snapshotMerged = true; // 合并后强制渲染一次，防止 getDataKey 去重跳过
      }
      if (showingConfig) return;  // 配置中不重渲染，离开时刷新
      const key = getDataKey();
      if (key !== lastDataKey || _snapshotMerged) {
        lastDataKey = key;
        _snapshotMerged = false;
        renderColumns();
      }
      hideLoading();
    } catch (e) {
      hideLoading();
    }
  }
  // ---------- 打字机：逐字打出文字，气泡框本身不动 ----------
  function typewriter(el, text) {
    if (el._tw) { clearTimeout(el._tw); el._tw = null; }
    let i = 0;
    el.textContent = '';
    const speed = TYPEWRITER_SPEED_MS;
    (function tick() {
      if (i > text.length) { el._tw = null; return; }
      el.textContent = text.slice(0, i);
      i++;
      el._tw = setTimeout(tick, speed);
    })();
  }

  // ---------- 气泡错峰轮换：按 MBTI 的 E/I 决定频率（E 人话多勤快，I 人安静少言） ----------
  const BUBBLE_INTERVAL_MS = {
    male_person:       [4000, 9000],    // ENTJ 项目经理（E）：勤快，常冒泡
    female_adventurer: [4000, 9000],    // ENFP 探索专家（E）：勤快，点子多
    male_adventurer:   [15000, 30000],  // ISTP 工程师（I）：偶尔冒一句
    female_person:     [18000, 35000],  // INFP 开发者（I）：安静，偶尔说话
    zombie:            [20000, 40000],  // INTP 摸鱼大师（I）：懒，但爱突发奇想
    robot:             [30000, 60000],  // ISTJ 机器人（I）：最沉默，按规程报一句
  };

  function rotateColumnBubble(index) {
    if (showingConfig) return;
    const col = DATA.columns && DATA.columns[index];
    if (!col) return;
    const state = columnState(col);
    if (state === 'working') return;  // 工作/工具列保持稳定，不轮换
    const section = $body.querySelectorAll('.column')[index];
    if (!section) return;
    const bubble = section.querySelector('.bubble');
    if (!bubble) return;
    typewriter(bubble, bubbleText(col, state));
  }

  function scheduleColumnBubble(index) {
    const char = CHARACTERS[index];
    const range = (char && BUBBLE_INTERVAL_MS[char.sprite]) || [20000, 40000];
    const delay = range[0] + Math.floor(Math.random() * (range[1] - range[0]));
    if (bubbleTimers[index]) clearTimeout(bubbleTimers[index]);
    bubbleTimers[index] = setTimeout(() => {
      rotateColumnBubble(index);
      scheduleColumnBubble(index);
    }, delay);
  }

  // P1-3: timer tracking for cleanup
  let refreshTimer = null;
  const bubbleTimers = new Array(COLUMN_COUNT).fill(null);

  // 接收父窗口传入的会话快照（OfficeFab 的 useSessions 数据），即时渲染
  // 零额外轮询/监听：只在 iframe 加载时收一次
  window.addEventListener('message', function handler(evt) {
    // 安全：校验 origin，拒绝非本源的 postMessage
    if (evt.origin !== window.location.origin) return;
    var msg = evt && evt.data;
    // 父窗口 ⏰ 会议提醒按钮点击 → 打开待办里的「会议」视图
    if (msg && msg.type === 'office-open-calendar') {
      openTodoMeeting();
      return;
    }
    if (!msg || msg.type !== 'office-snapshot' || !Array.isArray(msg.sessions)) return;
    window.removeEventListener('message', handler); // 只收一次
    try {
      // 保存实时状态映射（供 refresh 合并，防止服务端数据覆盖客户端已知状态）
      _snapshotStatus = {};
      for (var i = 0; i < msg.sessions.length; i++) {
        var s = msg.sessions[i];
        _snapshotStatus[String(s.id)] = {
          active: s.status === 'running' || s.status === 'pending',
          pending: s.status === 'pending'
        };
      }

      if (dataLoaded && Object.keys(_snapshotStatus).length > 0) {
        // 服务端数据已到：只 merge 状态到现有 DATA，不覆盖 workspace 结构
        mergeSnapshotStatus();
        _snapshotMerged = true;
        lastDataKey = ''; // 强制 key 不匹配，触发 renderColumns
        renderColumns();
      } else if (msg.sessions.length) {
        // 服务端数据未到：用快照渲染（所有会话放入占位工作区）
        var snapSessions = msg.sessions.map(function(s) {
          return {
            id: String(s.id),
            title: s.title || '会话 ' + String(s.id).slice(0, 6),
            active: s.status === 'running' || s.status === 'pending',
            pending: s.status === 'pending',
            inputTokens: null,
            tokenTotal: 0,
            tools: []
          };
        });
        DATA = {
          assignments: {},
          columns: (function() {
            var cols = [];
            for (var i = 0; i < COLUMN_COUNT; i++) cols.push({ index: i, workspaces: [] });
            cols[0].workspaces.push({
              id: '__snapshot__',
              title: '',
              sessions: snapSessions,
              sessionCount: snapSessions.length,
              tokenTotal: 0
            });
            return cols;
          })(),
          workspaces: [{
            id: '__snapshot__',
            title: '',
            col: 0,
            sessions: snapSessions,
            sessionCount: snapSessions.length,
            tokenTotal: 0
          }]
        };
        renderColumns();
      }
      hideLoading();
    } catch (_) {}
  });

  // setTimeout 链替代 setInterval：等 refresh 完成后再调度下一次，避免请求堆积
  function scheduleRefresh() {
    var interval = document.hidden ? POLL_INTERVAL_HIDDEN_MS : POLL_INTERVAL_MS; // 后台标签页 30s，前台 3s
    refreshTimer = setTimeout(async () => {
      await refresh();
      scheduleRefresh();
    }, interval);
  }

  (async function start() {
    await loadBubbleTexts();
    renderColumns();
    // 给父窗口 postMessage 150ms 窗口，确保快照先到、_snapshotStatus 先设置
    // 避免 fetchData 比快照快时，服务端旧缓存覆盖客户端已知状态
    await new Promise(r => setTimeout(r, SNAPSHOT_WAIT_MS));
    await refresh();
    scheduleRefresh();
    for (let i = 0; i < COLUMN_COUNT; i++) scheduleColumnBubble(i);  // 每列按自己 MBTI 的 E/I 频率轮换
  })();

  // P1-3: cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (calendarTimer) clearInterval(calendarTimer);
    bubbleTimers.forEach(t => { if (t) clearTimeout(t); });
  });

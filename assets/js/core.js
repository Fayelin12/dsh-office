  // ============================================================
  // 办公室页面：轮询 /office-ui/data，6 列小人 + 会话列表
  // ============================================================

  // 6 个角色：sprite 走 Kenney 精灵图，label 用于配置列标题/下拉，color 用于色底
  const CHARACTERS = [
    { sprite: 'male_adventurer',   label: '工程师',   color: '#7b8fa1' },
    { sprite: 'male_person',       label: '项目经理', color: '#4a6fd4' },
    { sprite: 'female_adventurer', label: '探索专家', color: '#3f8f5f' },
    { sprite: 'female_person',     label: '开发者',   color: '#d4af37' },
    { sprite: 'zombie',            label: '摸鱼大师', color: '#7b5bd4' },
    { sprite: 'robot',             label: '机器人',   color: '#d97706' },
  ];
  const COLUMN_COUNT = CHARACTERS.length;

  // ---------- 配置常量 ----------
  const POLL_INTERVAL_MS = 3000;          // 主轮询间隔
  const POLL_INTERVAL_HIDDEN_MS = 30000;  // 后台标签页轮询间隔
  const TOKEN_TIER_LOW = 10000;           // token 低档阈值
  const TOKEN_TIER_HIGH = 100000;         // token 高档阈值
  const COLUMN_BUSY_THRESHOLD = 4;        // 列状态"忙疯"阈值
  const FEISHU_ACTIVE_HOURS = 6;          // 飞书卡片"6小时内活跃"
  const FEISHU_STALE_DAYS = 3;            // 飞书卡片"超3天弱化"
  const MEETING_SOON_MINUTES = 120;       // 会议"即将开始"阈值（分钟）
  const LOG_POLL_INTERVAL_MS = 2500;      // 办公室日志轮询间隔
  const LOG_MAX_ROWS = 300;               // 日志列表 DOM 保留上限
  const LOG_NEAR_BOTTOM_PX = 24;          // 滚动条贴底判定阈值（px）

  /* ── 常量 ── */
  const API = '/office-ui';
  const TEXT_LOADING = '加载中…';
  const TEXT_LOAD_ERROR = '加载失败';
  const TEXT_READ_ERROR = '读取失败';
  const TEXT_NO_SUBJECT = '（无主题）';
  const TEXT_NO_BODY = '（无正文）';
  const TEXT_SYNCING = '同步中…';
  const TEXT_STATUS_ERROR = '状态获取失败';
  const TEXT_RETRY = '重新检测';
  const TEXT_COPY_OK = '已复制 ✓';
  const TEXT_COPY_FAIL = '复制失败';
  // 飞书消息 + 会议 + 洞察 从 0 到 1 配置指南（在线文档，引导卡与提示词统一引用）
  const GUIDE_URL = 'https://qcn7nupmeook.feishu.cn/docx/SILkdkE4xo8jF8x3SMGcOrFVnSf';
  const GUIDE_LABEL = '📖 配置指南（在线文档）';
  const FEISHU_PER_CHAT = 20;
  const FEISHU_PREVIEW_COUNT = 10;
  const SNAPSHOT_WAIT_MS = 150;
  const CALENDAR_COUNTDOWN_MS = 30000;
  const FEISHU_SYNC_MAX_POLL = 100;
  const TYPEWRITER_SPEED_MS = 50;
  const DARK_INVERT_STRENGTH = '0.92';
  const JSON_HEADERS = { 'content-type': 'application/json' };

  /* ── 工具函数 ── */
  function pad(n) { return String(n).padStart(2, '0'); }

  function setStatus(el, text) {
    el.textContent = text || '';
    el.title = text || '';
  }

  function relativeTime(diffMs, formatDateFn) {
    if (diffMs < 0) diffMs = 0;
    if (diffMs < 60000) return '刚刚';
    if (diffMs < 3600000) return Math.floor(diffMs / 60000) + ' 分钟前';
    if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + ' 小时前';
    if (diffMs < 604800000) return Math.floor(diffMs / 86400000) + ' 天前';
    return formatDateFn ? formatDateFn() : '更早';
  }

  function copyToClipboard(text, okText, failText) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(okText).catch(failText);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); okText(); } catch (_) { failText(); }
      document.body.removeChild(ta);
    }
  }

  async function apiFetch(path, opts) {
    const res = await fetch(API + path, opts);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
  }

  // Kenney Toon Characters 精灵帧（每帧 96×128，坐标来自 Tilesheet XML）
  const KW = 96, KH = 128;
  const KFRAMES = {
    idle:   [[0, 0]],
    cheer:  [[672, 0], [768, 0]],
    behindBack: [[480, 256]],
    run:    [[576, 256], [672, 256], [768, 256]],
    think:  [[288, 384]],
    talk:   [[0, 256]],
    show:   [[384, 256]],
    hold:   [[288, 256]],
    walk:   [[0, 512], [96, 512], [192, 512], [288, 512], [384, 512], [480, 512], [576, 512], [672, 512]],
  };

  // 状态徽标：idle/working 无徽标，busy 🔥，warning ⚠️
  const BADGE = { idle: '', working: '', busy: '🔥', warning: '⚠️' };

  // 空闲动作池 + 点开时为每列随机取一个（整个打开期间保持不变）
  const IDLE_ACTIONS = ['idle', 'behindBack', 'think', 'talk', 'show', 'hold'];
  const columnIdleActions = CHARACTERS.map(() => IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)]);

  // 输入 token 分档阈值（单次输入口径，按 1M 上下文校准，可配置）：
  //   < low 灰(很少)，low~high 蓝(差不多)，> high 黄(浪费)
  const TOKEN_TIERS = { low: TOKEN_TIER_LOW, high: TOKEN_TIER_HIGH };
  function tierOf(tokens) {
    if (tokens == null) return 'low';
    if (tokens < TOKEN_TIERS.low) return 'low';
    if (tokens <= TOKEN_TIERS.high) return 'mid';
    return 'high';
  }
  function formatTokens(n) {
    if (n == null) return '';
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + 'K';
    if (n < 1000000) return Math.round(n / 1000) + 'K';
    const m = n / 1000000;
    return (m >= 100 ? Math.round(m) : m.toFixed(1)) + 'M';
  }

  // 6 列骨架
  function emptyColumns() {
    return CHARACTERS.map((c, index) => ({ index, workspaces: [] }));
  }

  // 兜底演示数据（独立打开 office.html 时展示）
  function demoData() {
    const columns = emptyColumns();
    columns[0].workspaces = [{ id: 'demo-1', title: '项目A', sessions: [
      { id: 's1', title: '重构登录模块', active: true,  inputTokens: 180000 },
      { id: 's2', title: '调研方案', active: false, inputTokens: 4500 },
    ]}];
    columns[1].workspaces = [{ id: 'demo-2', title: '项目B', sessions: [
      { id: 's3', title: '对接审批', active: true, inputTokens: 32000 },
    ]}];
    columns[2].workspaces = [{ id: 'demo-3', title: '项目C', sessions: [
      { id: 's4', title: '爬取数据', active: true, inputTokens: 260000 },
      { id: 's5', title: '清洗数据', active: false, inputTokens: 12000 },
    ]}];
    return { columns, assignments: {} };
  }

  // 当前数据：初始为空骨架，优先 /office-ui/data，独立打开时用演示兜底
  let DATA = { columns: emptyColumns(), assignments: {} };
  let PUBLIC_IP = '';  // 公网 IPv4（Host 端 /office-ui/data 下发，标题栏展示用）
  let dataLoaded = false;
  // 快照实时状态：客户端 useSessions 的 active/pending 比服务端 agents.list() 更快
  // fetchData 返回后用此映射覆盖服务端数据，避免"客户端已知 running 但面板显示 idle"的竞态
  let _snapshotStatus = null;
  let _snapshotMerged = false; // 快照合并后强制渲染一次

  function mergeSnapshotStatus() {
    if (!_snapshotStatus) return;
    var cols = DATA.columns || [];
    for (var ci = 0; ci < cols.length; ci++) {
      var wsList = (cols[ci] && cols[ci].workspaces) || [];
      for (var wi = 0; wi < wsList.length; wi++) {
        var sessions = wsList[wi].sessions || [];
        for (var si = 0; si < sessions.length; si++) {
          var snap = _snapshotStatus[String(sessions[si].id)];
          if (snap) {
            if (snap.active) sessions[si].active = true;
            if (snap.pending) sessions[si].pending = true;
          }
        }
      }
    }
  }

  function mkStep(html) {
    const li = document.createElement('li');
    li.innerHTML = html;
    return li;
  }

  async function fetchData() {
    try {
      const res = await apiFetch('/data', { cache: 'no-store' });
      const json = await res.json();
      if (json && Array.isArray(json.columns) && json.columns.length) {
        DATA = json;
        const ip = (json && json.publicIP) || '';
        // IP 首次到达/变化时补设当前视图标题：初始 HTML 标题是静态「🏢 办公室」，
        // 只有切 tab 走 switchView 才拼括号，主视图要靠这里覆盖
        if (ip !== PUBLIC_IP) {
          PUBLIC_IP = ip;
          if (PUBLIC_IP) setOfficeTitle(currentTitleBase);
        }
        dataLoaded = true;
      }
    } catch (e) {
      if (!dataLoaded) DATA = demoData();  // 独立打开兜底
    }
  }

  // 列状态：由会话 active 数推导（pendingCount / 待确认 待接）
  function columnState(column) {
    let activeCount = 0;
    let pendingCount = 0;
    for (const ws of column.workspaces || []) {
      for (const s of ws.sessions || []) {
        if (s.active) activeCount++;
        if (s.pending) pendingCount++;
      }
    }
    if (pendingCount > 0) return 'warning';
    if (activeCount === 0) return 'idle';
    if (activeCount > COLUMN_BUSY_THRESHOLD) return 'busy';
    return 'working';
  }

  // ---------- 对话气泡：按状态/角色个性化文案 ----------
  function pick(arr) {
    if (!arr || !arr.length) return '';
    return arr[Math.floor(Math.random() * arr.length)];
  }
  // 稳定选择：同一种子（工具名/标题）始终返回同一句，避免被 10 秒轮换随机重抽
  function stablePick(arr, seed) {
    if (!arr || !arr.length) return '';
    let h = 0;
    const s = String(seed || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return arr[Math.abs(h) % arr.length];
  }
  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  // 气泡文案：从 /office-ui/bubble-texts（bubble-texts.json）加载，不在 HTML 硬编码
  let BUBBLE_TEXTS = null;
  async function loadBubbleTexts() {
    try {
      const res = await apiFetch('/bubble-texts', { cache: 'no-store' });
      const json = await res.json();
      if (json && typeof json === 'object') BUBBLE_TEXTS = json;
    } catch (e) {
      BUBBLE_TEXTS = { warning: [], busy: [], titleRules: [], toolRules: [], idle: { zombie: [], robot: [], default: [] } };
    }
  }
  function bubbleText(col, state) {
    const T = BUBBLE_TEXTS || { warning: [], busy: [], titleRules: [], toolRules: [], idle: {} };
    const char = CHARACTERS[col.index];
    const sessions = (col.workspaces || []).flatMap((ws) => ws.sessions || []);
    const active = sessions.filter((s) => s.active);
    // 1) 紧急状态优先
    if (state === 'warning') return pick(T.warning);
    if (state === 'busy') return pick(T.busy);
    if (active.length) {
      const s = active[0];
      // 2) 工具匹配（最近调用的工具）
      if (s.tools && s.tools.length) {
        for (const rule of (T.toolRules || [])) {
          if (rule.keys && rule.keys.some((k) => s.tools.some((t) => String(t).toLowerCase().includes(k)))) {
            return stablePick(rule.texts, s.tools.join(','));
          }
        }
      }
      // 3) 标题关键词匹配 → 4) 标题引用
      const title = s.title || '';
      const lower = title.toLowerCase();
      for (const rule of (T.titleRules || [])) {
        if (rule.keys && rule.keys.some((k) => lower.includes(k))) return stablePick(rule.texts, title);
      }
      return '在搞「' + truncate(title, 10) + '」…';
    }
    // 5) 角色个性化兜底：按角色 sprite 取各自 MBTI 风格的文案
    const idle = T.idle || {};
    return pick(idle[char.sprite] || idle.default);
  }

  const $body = document.getElementById('officeBody');
  const $config = document.getElementById('configView');
  const $configBtn = document.getElementById('configBtn');
  const $officeTitle = document.getElementById('officeTitle');

  // 当前标题基础串（不含 IP 括号），供 IP 异步到达后补设标题
  let currentTitleBase = '\uD83C\uDFE2 \u529E\u516C\u5BA4';
  // 标题统一拼接公网 IP：🏢 办公室（公网IP：<出口 IPv4>）；IP 未查到（查询失败/独立打开兜底）时不带括号
  function setOfficeTitle(base) {
    currentTitleBase = base;
    $officeTitle.textContent = base + (PUBLIC_IP ? '（公网IP：' + PUBLIC_IP + '）' : '');
  }

  // ---------- 渲染 6 列 ----------
  // FIX: renderColumns() no longer re-checks getDataKey() — refresh() already
  // does the key comparison and updates lastDataKey before calling us.
  // The old double-check (key !== lastDataKey) was always false here because
  // refresh() had just set lastDataKey = key, so fullRender() never ran.
  function renderColumns() {
    fullRender();
  }

  function colStats(col) {
    const projectCount = col.workspaces.length;
    const taskCount = col.workspaces.reduce((sum, ws) => sum + (typeof ws.sessionCount === 'number' ? ws.sessionCount : (ws.sessions || []).length), 0);
    const tokenTotal = col.workspaces.reduce((sum, ws) => sum + (typeof ws.tokenTotal === 'number' ? ws.tokenTotal : 0), 0);
    return { projectCount, taskCount, tokenTotal };
  }

  function setStats(statsEl, col) {
    const { projectCount, taskCount, tokenTotal } = colStats(col);
    const bs = statsEl.querySelectorAll('b');
    if (bs[0]) bs[0].textContent = String(projectCount);
    if (bs[1]) bs[1].textContent = String(taskCount);
    if (bs[2]) { bs[2].textContent = formatTokens(tokenTotal); bs[2].title = '累计输入 token：' + tokenTotal; }
  }

  function bubbleKey(col, state) {
    if (state === 'working') {
      const sessions = (col.workspaces || []).flatMap((ws) => ws.sessions || []);
      const active = sessions.filter((s) => s.active);
      if (active.length) {
        const s = active[0];
        return state + '|' + (s.tools || []).join(',') + '|' + (s.title || '');
      }
    }
    return state;
  }

  function sessionRow(s) {
    const li = document.createElement('li');
    li.className = 'session' + (s.active ? '' : ' idle');
    li.dataset.sid = s.id;
    li.title = '点击打开会话';
    li.addEventListener('click', () => openSession(s.id));

    const status = document.createElement('span');
    status.className = 'status';
    const indicator = document.createElement('span');
    indicator.className = s.active ? 'spinner' : 'dot';
    status.appendChild(indicator);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = s.title;

    const sessActive = !!s.active;
    const displayTokens = sessActive ? s.inputTokens : (s.tokenTotal != null ? s.tokenTotal : null);
    const tokens = document.createElement('span');
    tokens.className = 'tokens ' + (sessActive ? tierOf(s.inputTokens) : 'cum');
    tokens.textContent = formatTokens(displayTokens);
    tokens.title = (sessActive ? '单次输入 token：' : '累计 token：') + (displayTokens == null ? '' : displayTokens);

    li.appendChild(status);
    li.appendChild(label);
    li.appendChild(tokens);
    return li;
  }

  function fullRender() {
    $body.querySelectorAll('canvas').forEach((c) => c._stop && c._stop());
    $body.innerHTML = '';
    for (const col of (DATA.columns || [])) {
      const state = columnState(col);
      const char = CHARACTERS[col.index];

      const section = document.createElement('section');
      section.className = 'column';
      section.dataset.bubbleKey = bubbleKey(col, state);

      // 角色标题
      const colTitle = document.createElement('div');
      colTitle.className = 'col-title';
      const titleDot = document.createElement('span');
      titleDot.className = 'dot';
      titleDot.style.background = char.color;
      const titleName = document.createElement('span');
      titleName.textContent = char.label;
      colTitle.appendChild(titleDot);
      colTitle.appendChild(titleName);

      // 动画区
      const anim = document.createElement('div');
      anim.className = 'anim-area';

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = bubbleText(col, state);
      anim.appendChild(bubble);

      const canvas = document.createElement('canvas');
      anim.appendChild(canvas);

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = BADGE[state] || '';
      badge.style.display = BADGE[state] ? '' : 'none';
      anim.appendChild(badge);

      const stats = document.createElement('div');
      stats.className = 'column-stats';
      ['项目', '任务', 'token'].forEach((label) => {
        const span = document.createElement('span');
        span.textContent = label + ' ';
        const b = document.createElement('b');
        b.textContent = '0';
        span.appendChild(b);
        stats.appendChild(span);
      });
      setStats(stats, col);
      anim.appendChild(stats);

      // 工作区列表
      const list = document.createElement('ul');
      list.className = 'workspace-list';
      if (col.workspaces.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = '未分配工作区';
        list.appendChild(empty);
      } else {
        for (const ws of col.workspaces) {
          const wsItem = document.createElement('li');
          wsItem.className = 'workspace';
          const title = document.createElement('div');
          title.className = 'ws-title';
          title.textContent = ws.title;
          wsItem.appendChild(title);
          const sessions = document.createElement('ul');
          sessions.className = 'sessions';
          for (const s of ws.sessions) {
            sessions.appendChild(sessionRow(s));
          }
          wsItem.appendChild(sessions);
          list.appendChild(wsItem);
        }
      }

      section.appendChild(colTitle);
      section.appendChild(anim);
      section.appendChild(list);
      $body.appendChild(section);

      startSprite(canvas, char, state, col.index);
    }
  }

  // ---------- P2-3: Single master rAF loop for all column canvases ----------
  const _spriteList = [];
  let _masterRaf = 0;
  let _masterRunning = false;

  function masterDrawLoop() {
    if (!_masterRunning) return;
    for (const sprite of _spriteList) {
      if (!sprite.alive) continue;
      sprite.draw();
    }
    _masterRaf = requestAnimationFrame(masterDrawLoop);
  }
  function ensureMasterLoop() {
    if (!_masterRunning) {
      _masterRunning = true;
      _masterRaf = requestAnimationFrame(masterDrawLoop);
    }
  }

  // ---------- 占位小人（呼吸动画，之后换 LPC 精灵）----------
  function startSprite(canvas, char, state, columnIndex) {
    const ctx = canvas.getContext('2d');
    let currentState = state;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const img = new Image();
    img.src = API + '/assets/toon/' + char.sprite + '.png';

    const idleAction = columnIdleActions[columnIndex] || 'idle';
    const t0 = performance.now();

    const sprite = {
      alive: true,
      canvas, ctx, img, char, t0,
      get currentState() { return currentState; },
      draw() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        ctx.clearRect(0, 0, w, h);
        const t = (performance.now() - t0) / 1000;

        let key;
        if (currentState === 'idle') key = idleAction;
        else if (currentState === 'busy') key = 'run';
        else if (currentState === 'warning') key = 'cheer';
        else key = 'walk';

        const frames = KFRAMES[key] || KFRAMES.idle;
        const fps = key === 'run' ? 12 : 6;
        const f = frames[Math.floor(t * fps) % frames.length];

        ctx.fillStyle = char.color;
        ctx.globalAlpha = 0.22;
        ctx.beginPath(); ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.34, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;

        ctx.imageSmoothingEnabled = false;
        if (img.complete && img.naturalWidth > 0) {
          const scale = Math.min(w, h) / KH;
          const dw = KW * scale, dh = KH * scale;
          const dx = (w - dw) / 2;
          let dy = (h - dh) / 2;
          if (currentState === 'idle') dy += Math.sin(t * Math.PI * 2 * 0.4) * 2;
          ctx.drawImage(img, f[0], f[1], KW, KH, dx, dy, dw, dh);
        }
      }
    };

    _spriteList.push(sprite);
    ensureMasterLoop();

    canvas._stop = () => {
      sprite.alive = false;
      const idx = _spriteList.indexOf(sprite);
      if (idx >= 0) _spriteList.splice(idx, 1);
      window.removeEventListener('resize', resize);
      if (_spriteList.every(s => !s.alive)) {
        _masterRunning = false;
        cancelAnimationFrame(_masterRaf);
      }
    };
    canvas._setState = (s) => { currentState = s; };
  }

  // ---------- 配置：待保存状态管理 ----------
  // savedAssignments = 磁盘上已持久化的分配（进入配置模式时的快照，保存后更新）
  // pendingAssignments = 用户当前正在编辑的分配（下拉变更立即反映到此，仅预览不保存）
  let savedAssignments = {};
  let pendingAssignments = {};
  const $saveBtn = document.getElementById('saveBtn');
  const $dirtyBadge = document.getElementById('dirtyBadge');

  // 比较 pending vs saved，返回是否有差异
  function isDirty() {
    const pKeys = Object.keys(pendingAssignments);
    const sKeys = Object.keys(savedAssignments);
    if (pKeys.length !== sKeys.length) return true;
    for (const k of pKeys) {
      if (pendingAssignments[k] !== savedAssignments[k]) return true;
    }
    return false;
  }

  // 刷新保存按钮和未保存提示的 UI 状态
  function updateDirtyUI() {
    const dirty = isDirty();
    $saveBtn.classList.toggle('dirty', dirty);
    $saveBtn.classList.toggle('visible', dirty);
    $dirtyBadge.classList.toggle('visible', dirty);
  }

  // 下拉变更：只更新 pending 状态并重新渲染配置视图（不保存到磁盘）
  function onAssignmentChange(e) {
    const wsId = e.target.dataset.wsid;
    const col = parseInt(e.target.value, 10);
    if (wsId) {
      if (col === -1) {
        delete pendingAssignments[wsId];
      } else {
        pendingAssignments[wsId] = col;
      }
    }
    renderConfig();
    updateDirtyUI();
  }

  // 保存：将 pending 提交到磁盘（POST /office-ui/config）
  async function saveAssignments() {
    try {
      const res = await apiFetch('/config', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ assignments: pendingAssignments })
      });
      if (res.ok) {
        savedAssignments = { ...pendingAssignments };
        DATA.assignments = { ...pendingAssignments };
        updateDirtyUI();
      }
    } catch (e) { console.warn('[office]', e?.message || e); }
  }

  $saveBtn.addEventListener('click', saveAssignments);

  // ---------- 打开会话 ----------
  async function openSession(sessionId) {
    if (!sessionId) return;
    try {
      await apiFetch('/open-session', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ sessionId })
      });
    } catch (e) { console.warn('[office]', e?.message || e); }
  }

  // ---------- 配置视图 ----------
  function renderConfig() {
    $config.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'config-hint';
    hint.textContent = '把工作区加进对应的小人（修改后点击右上角「保存」生效）';
    $config.appendChild(hint);

    // 收集所有工作区（含未分配）— 使用 pendingAssignments 预览待保存的分配
    const all = [];
    if (Array.isArray(DATA.workspaces)) {
      for (const ws of DATA.workspaces) {
        const col = pendingAssignments.hasOwnProperty(ws.id)
          ? pendingAssignments[ws.id]
          : (typeof ws.col === 'number' ? ws.col : 0);
        all.push({ id: ws.id, title: ws.title, col });
      }
    } else {
      for (const col of (DATA.columns || [])) {
        for (const ws of col.workspaces || []) {
          const c = pendingAssignments.hasOwnProperty(ws.id)
            ? pendingAssignments[ws.id]
            : col.index;
          all.push({ id: ws.id, title: ws.title, col: c });
        }
      }
    }
    if (all.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '暂无工作区';
      $config.appendChild(empty);
      return;
    }

    function makeSelect(ws) {
      const sel = document.createElement('select');
      const noneOpt = document.createElement('option');
      noneOpt.value = '-1';
      noneOpt.textContent = '未分配';
      sel.appendChild(noneOpt);
      CHARACTERS.forEach((c, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = c.label;
        sel.appendChild(opt);
      });
      sel.value = String(ws.col);
      sel.dataset.wsid = ws.id || '';
      sel.addEventListener('change', onAssignmentChange);
      return sel;
    }

    function makeWsItem(ws) {
      const item = document.createElement('div');
      item.className = 'ws-item';
      const name = document.createElement('span');
      name.className = 'ws-name';
      name.textContent = ws.title;
      name.title = ws.title;
      item.appendChild(name);
      item.appendChild(makeSelect(ws));
      return item;
    }

    function makeCol(head, wsList, full) {
      const col = document.createElement('div');
      col.className = 'config-col' + (full ? ' full' : '');
      const headEl = document.createElement('div');
      headEl.className = 'config-col-head';
      headEl.textContent = head;
      col.appendChild(headEl);
      if (wsList.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'config-col-empty';
        empty.textContent = '空';
        col.appendChild(empty);
      } else {
        for (const ws of wsList) col.appendChild(makeWsItem(ws));
      }
      return col;
    }

    const grid = document.createElement('div');
    grid.className = 'config-grid';

    // 未分配区（全宽）+ 6 个角色列
    const unassigned = all.filter((ws) => ws.col < 0 || ws.col > COLUMN_COUNT - 1);
    grid.appendChild(makeCol('未分配', unassigned, true));
    CHARACTERS.forEach((c, i) => {
      grid.appendChild(makeCol(c.label, all.filter((ws) => ws.col === i)));
    });

    $config.appendChild(grid);
  }

  // ---------- P2-4: 公共视图切换（互斥逻辑） ----------
  function toggleView(name, getState, setState, resetFn, loadFn) {
    const wasOpen = getState();
    setState(false);
    if (resetFn) resetFn();
    if (wasOpen) { switchView('main'); }
    else { setState(true); switchView(name); loadFn(); }
  }

  function switchView(viewName) {
    // 关闭所有视图
    mailViewOpen = false;
    feishuViewOpen = false;
    todoViewOpen = false;
    larkbotViewOpen = false;
    showingConfig = false;
    $body.hidden = false;
    $mailView.hidden = true;
    $feishuView.hidden = true;
    $todoView.hidden = true;
    $larkbotView.hidden = true;
    $config.hidden = true;
    // 重置所有按钮状态（含视图切换的 header 按钮）
    document.querySelectorAll('.office-actions .header-btn, .office-actions .icon-btn').forEach(function(btn) {
      btn.classList.remove('active');
    });
    // 重置配置按钮文本
    $configBtn.textContent = '\u2699\uFE0F \u914D\u7F6E';
    $configBtn.title = '配置';
    // 重置标题
    setOfficeTitle('\uD83C\uDFE2 \u529E\u516C\u5BA4');
    // 打开目标视图
    if (viewName === 'mail') {
      mailViewOpen = true;
      $mailView.hidden = false;
      $body.hidden = true;
      $mailBtn.classList.add('active');
      setOfficeTitle('\uD83C\uDFE2 \u529E\u516C\u5BA4 \u00B7 \u90AE\u7BB1');
    } else if (viewName === 'feishu') {
      feishuViewOpen = true;
      $feishuView.hidden = false;
      $body.hidden = true;
      $feishuBtn.classList.add('active');
      setOfficeTitle('\uD83C\uDFE2 \u529E\u516C\u5BA4 \u00B7 \u98DE\u4E66');
    } else if (viewName === 'todos') {
      todoViewOpen = true;
      $todoView.hidden = false;
      $body.hidden = true;
      $todoBoardBtn.classList.add('active');
      setOfficeTitle('\uD83C\uDFE2 \u529E\u516C\u5BA4 \u00B7 \u65E5\u7A0B');
    } else if (viewName === 'larkbot') {
      larkbotViewOpen = true;
      $larkbotView.hidden = false;
      $body.hidden = true;
      $larkbotBtn.classList.add('active');
      setOfficeTitle('\uD83C\uDFE2 \u529E\u516C\u5BA4 \u00B7 \u7FA4\u804A\u52A9\u7406');
    } else if (viewName === 'config') {
      showingConfig = true;
      $config.hidden = false;
      $body.hidden = true;
      $configBtn.textContent = '\u2713 \u5B8C\u6210';
      $configBtn.title = '完成';
      setOfficeTitle('\uD83C\uDFE2 \u529E\u516C\u5BA4 \u00B7 \u914D\u7F6E');
    }
    refresh();
  }

  // ---------- 配置视图开关 ----------
  let showingConfig = false;
  function toggleConfig() {
    if (showingConfig) {
      // 离开配置模式：重置待保存状态，刷新主视图
      pendingAssignments = {};
      savedAssignments = {};
      updateDirtyUI();
      switchView('main');
      refresh();
    } else {
      switchView('config');
      // 进入配置模式：快照当前已保存的分配，初始化待编辑状态
      savedAssignments = { ...(DATA.assignments || {}) };
      pendingAssignments = { ...savedAssignments };
      renderConfig();
      updateDirtyUI();
    }
  }
  $configBtn.addEventListener('click', toggleConfig);

  // ---------- 帮助弹窗（数据口径 / 办公室日志 双 tab） ----------
  const $helpBtn = document.getElementById('helpBtn');
  const $helpModal = document.getElementById('helpModal');
  const $helpClose = document.getElementById('helpClose');
  const $helpTabCaliber = document.getElementById('helpTabCaliber');
  const $helpTabLogs = document.getElementById('helpTabLogs');
  const $helpPanelCaliber = document.getElementById('helpPanelCaliber');
  const $helpPanelLogs = document.getElementById('helpPanelLogs');
  const $logToggleBtn = document.getElementById('logToggleBtn');
  const $logStatus = document.getElementById('logStatus');
  const $logList = document.getElementById('logList');

  // 日志轮询状态：仅弹窗打开且日志 tab 激活时运行
  let logPollTimer = null;    // setInterval id
  let logAutoScroll = true;   // 是否跟随新日志滚动到底
  let logLastKey = '';        // 列表最后一行 key，防重复追加
  let logEmptyShown = false;  // 占位文案是否已显示

  function logKey(l) { return (l.t || '') + '|' + (l.level || '') + '|' + (l.msg || ''); }

  function logNearBottom() {
    return $logList.scrollHeight - $logList.scrollTop - $logList.clientHeight < LOG_NEAR_BOTTOM_PX;
  }

  function setLogEmpty(on) {
    if (on === logEmptyShown) return;
    logEmptyShown = on;
    const el = $logList.querySelector('.log-empty');
    if (on && !el) {
      const d = document.createElement('div');
      d.className = 'log-empty';
      d.textContent = '暂无日志';
      $logList.appendChild(d);
    } else if (!on && el) {
      el.remove();
    }
  }

  function buildLogRow(l) {
    const row = document.createElement('div');
    row.className = 'log-item';
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = l.t || '';
    const level = document.createElement('span');
    level.className = 'log-level ' + (l.level || 'info');
    level.textContent = l.level || '';
    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = l.msg || '';
    row.appendChild(time);
    row.appendChild(level);
    row.appendChild(msg);
    return row;
  }

  function appendLogs(logs) {
    if (!Array.isArray(logs) || !logs.length) {
      if (!$logList.children.length) setLogEmpty(true);
      return;
    }
    // 跳过已渲染过的行，兼容后端返回全量快照的情况
    let start = 0;
    if (logLastKey) {
      const idx = logs.findIndex((l) => logKey(l) === logLastKey);
      if (idx >= 0) start = idx + 1;
    }
    if (start >= logs.length) return;
    const follow = logAutoScroll && logNearBottom();
    const frag = document.createDocumentFragment();
    for (let i = start; i < logs.length; i++) frag.appendChild(buildLogRow(logs[i]));
    setLogEmpty(false);
    $logList.appendChild(frag);
    while ($logList.children.length > LOG_MAX_ROWS) $logList.removeChild($logList.firstChild);
    logLastKey = logKey(logs[logs.length - 1]);
    if (follow) $logList.scrollTop = $logList.scrollHeight;
  }

  async function fetchOfficeLogs() {
    try {
      const res = await apiFetch('/logs', { cache: 'no-store' });
      const json = await res.json();
      const data = json && json.ok ? json.data : null;
      appendLogs(data && data.logs);
    } catch (_) { /* 拉取失败静默，下一轮重试 */ }
  }

  function startLogPolling() {
    if (logPollTimer) return;
    fetchOfficeLogs();
    logPollTimer = setInterval(fetchOfficeLogs, LOG_POLL_INTERVAL_MS);
  }

  function stopLogPolling() {
    if (!logPollTimer) return;
    clearInterval(logPollTimer);
    logPollTimer = null;
  }

  function updateLogToolbar() {
    $logToggleBtn.textContent = logAutoScroll ? '暂停' : '继续';
    $logStatus.textContent = logAutoScroll ? '实时日志 · 自动滚动' : '实时日志 · 已暂停';
  }

  $logToggleBtn.addEventListener('click', () => {
    logAutoScroll = !logAutoScroll;
    updateLogToolbar();
    if (logAutoScroll) $logList.scrollTop = $logList.scrollHeight;
  });

  // 仅当弹窗打开且日志 tab 激活时轮询
  function syncLogPolling() {
    if (!$helpModal.hidden && $helpTabLogs.classList.contains('active')) startLogPolling();
    else stopLogPolling();
  }

  function switchHelpTab(name) {
    const isLogs = name === 'logs';
    $helpTabCaliber.classList.toggle('active', !isLogs);
    $helpTabLogs.classList.toggle('active', isLogs);
    $helpPanelCaliber.hidden = isLogs;
    $helpPanelLogs.hidden = !isLogs;
    syncLogPolling();
  }

  $helpTabCaliber.addEventListener('click', () => switchHelpTab('caliber'));
  $helpTabLogs.addEventListener('click', () => switchHelpTab('logs'));

  $helpBtn.addEventListener('click', () => {
    $helpModal.hidden = !$helpModal.hidden;
    syncLogPolling();
  });
  $helpClose.addEventListener('click', () => {
    $helpModal.hidden = true;
    syncLogPolling();
  });
  $helpModal.addEventListener('click', (e) => {
    if (e.target === $helpModal) {
      $helpModal.hidden = true;
      syncLogPolling();
    }
  });

  // ---------- 通用 toast 提示（一次性，几秒后消失；全模块共用，须定义在公共基础模块） ----------
  let _toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('officeToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'officeToast';
      el.className = 'office-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
  }


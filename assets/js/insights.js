  // ============================================================
  // 💡 洞察（每日洞察：已并入 📅 日程页右栏，scripts.insights 脚本接入，配置驱动）
  // 数据：GET /insights/status（前置条件+最近生成）· GET /insights/history?date=（历史）· POST /insights/generate（异步生成）· POST /insights/delete|to-session
  // 视图开关由飞书视图（lark.js toggleFeishu）统一驱动，本模块只负责渲染/加载/日期切换
  // ============================================================
  const $insightsStatus = document.getElementById('insightsStatus');
  const $insightsRefreshBtn = document.getElementById('insightsRefreshBtn');
  const $insightsGenBtn = document.getElementById('insightsGenBtn');
  const $insightsMain = document.getElementById('insightsMain');
  const $insightsDateInput = document.getElementById('insightsDateInput');
  const $insightsDatePrev = document.getElementById('insightsDatePrev');
  const $insightsDateNext = document.getElementById('insightsDateNext');
  const $insightsDateToday = document.getElementById('insightsDateToday');
  const $confirmModal = document.getElementById('confirmModal');
  const $confirmTitle = document.getElementById('confirmTitle');
  const $confirmMessage = document.getElementById('confirmMessage');
  const $confirmClose = document.getElementById('confirmClose');
  const $confirmOkBtn = document.getElementById('confirmOkBtn');
  const $toSessionModal = document.getElementById('toSessionModal');
  const $toSessionWorkspace = document.getElementById('toSessionWorkspace');
  const $toSessionPrompt = document.getElementById('toSessionPrompt');
  const $toSessionError = document.getElementById('toSessionError');
  const $toSessionClose = document.getElementById('toSessionClose');
  const $toSessionOkBtn = document.getElementById('toSessionOkBtn');

  let insightsGenerating = false;   // 前端生成轮询标志
  let insightsLazyFired = false;    // 本次打开是否已惰性触发（防重复）
  let insightsDate = null;          // 洞察查看日期（YYYY-MM-DD）
  let currentInsightsDay = null;    // 当前渲染的整日快照（转会话取条目文本用）

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // 按日历日位移（dateStr: YYYY-MM-DD，delta: ±N 天）
  function shiftDate(dateStr, delta) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    d.setDate(d.getDate() + delta);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function insightsPrioClass(p) { return p === '高' ? 'high' : (p === '低' ? 'low' : 'mid'); }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 轻量 markdown → HTML（洞察日报用：标题/列表/加粗/段落；先转义防注入）
  function renderMarkdown(md) {
    if (!md) return '';
    const esc = String(md)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const lines = esc.split(/\r?\n/);
    const html = [];
    let inList = false;
    const closeList = () => { if (inList) { html.push('</ul>'); inList = false; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) { closeList(); continue; }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { closeList(); html.push('<h3>' + h[2] + '</h3>'); continue; }
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) {
        if (!inList) { html.push('<ul>'); inList = true; }
        html.push('<li>' + li[1] + '</li>');
        continue;
      }
      closeList();
      html.push('<p>' + line + '</p>');
    }
    closeList();
    return html.join('')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  // ---------- 引导卡（前置条件检测清单） ----------
  function renderInsightsGuide(prereq) {
    const wrap = document.createElement('div');
    wrap.className = 'insights-guide';
    wrap.appendChild(el('div', 'insights-guide-title', '💡 洞察 / 每日洞察视图'));

    const items = [
      { ok: !!prereq.msgConnected, text: '① 飞书消息已接入（未接入先去 💬 飞书视图配置消息流）' },
      { ok: !!prereq.llmConfigured, warn: true, text: '② LLM 已配置（日报/待办由 LLM 通读当天消息生成；未配置时洞察降级为规则判定，只出不完整日报）' },
    ];
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'insights-guide-item';
      const st = document.createElement('span');
      st.className = 'st ' + (it.ok ? 'ok' : (it.warn ? 'warn' : 'bad'));
      st.textContent = it.ok ? '✅' : (it.warn ? '⚠️' : '❌');
      row.appendChild(st);
      row.appendChild(el('span', '', it.text));
      wrap.appendChild(row);
    }

    const note = document.createElement('div');
    note.className = 'insights-guide-note';
    note.textContent = '洞察 = 今日飞书日报：LLM 通读当天全部消息，生成要点式日报（今日要点/待办/值得回顾的讨论），另附未回复清单（私聊末条非我 + 群聊@我）。LLM key 复用 dsh 凭据（DEEPSEEK_API_KEY），无需额外配置。';
    wrap.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'insights-guide-actions';
    const recheck = el('button', 'icon-btn', '重新检测');
    recheck.style.cssText = 'width:auto;padding:0 12px;font-size:var(--font-body)';
    recheck.addEventListener('click', () => loadInsights(true));
    actions.appendChild(recheck);
    wrap.appendChild(actions);

    $insightsMain.innerHTML = '';
    $insightsMain.appendChild(wrap);
  }

  // ---------- 三区块渲染 ----------
  function renderInsightsData(d) {
    const secs = d.sections || {};
    currentInsightsDay = d;
    const date = d.date || insightsDate || '';
    $insightsMain.innerHTML = '';

    // 当日摘要：实时统计行（随删除/变更即时更新）
    const counts = {
      todos: (secs.todos || []).length,
      unreplied: (secs.unreplied || []).length,
      highlights: (secs.highlights || []).length
    };
    const summary = el('div', 'insights-summary-card');
    const sumText = el('div', 'insights-summary-stats',
      '📋 待办 ' + counts.todos + ' · 📩 未回复 ' + counts.unreplied + ' · 🔥 讨论 ' + counts.highlights);
    summary.appendChild(sumText);
    if (d.summary) summary.appendChild(el('div', 'insights-summary-text', d.summary));
    $insightsMain.appendChild(summary);

    // 📰 日报正文（markdown 渲染）
    if (secs.report) {
      const rSec = el('div', 'insights-section');
      const rHead = el('div', 'insights-sec-head', '📰 今日日报');
      rSec.appendChild(rHead);
      const rCard = el('div', 'insights-card insights-report-card');
      const rBody = document.createElement('div');
      rBody.className = 'insights-report-body';
      rBody.innerHTML = renderMarkdown(secs.report);
      rCard.appendChild(rBody);
      rSec.appendChild(rCard);
      $insightsMain.appendChild(rSec);
    }

    // 卡片操作（🗑 删除 / ↗ 转会话 / 📥 加入我的待办）——删除走二次确认，转会话新建任务
    function appendCardActions(card, section, index, withAddTodo) {
      const acts = el('div', 'insights-card-actions');
      const rm = el('button', 'icon-btn insight-action insights-action-remove', '🗑 删除');
      const ts = el('button', 'icon-btn insight-action', '↗ 转会话');
      rm.dataset.kind = 'remove';
      ts.dataset.kind = 'to-session';
      for (const b of [rm, ts]) { b.dataset.date = date; b.dataset.section = section; b.dataset.index = String(index); }
      acts.appendChild(rm);
      acts.appendChild(ts);
      if (withAddTodo) {
        const at = el('button', 'icon-btn insight-action', '📥 加入待办');
        at.dataset.kind = 'add-todo';
        at.dataset.date = date;
        at.dataset.section = section;
        at.dataset.index = String(index);
        acts.appendChild(at);
      }
      card.appendChild(acts);
    }

    // 📋 重要待办
    const todos = secs.todos || [];
    const tSec = el('div', 'insights-section');
    const tHead = el('div', 'insights-sec-head', '📋 重要待办');
    tHead.appendChild(el('span', 'insights-sec-count', String(todos.length)));
    tSec.appendChild(tHead);
    if (todos.length === 0) {
      tSec.appendChild(el('div', 'insights-empty', '今日暂无待办'));
    } else {
      todos.forEach((t, i) => {
        const card = el('div', 'insights-card');
        const head = el('div', 'insights-card-head');
        head.appendChild(el('span', 'insights-prio ' + insightsPrioClass(t.priority), '[' + (t.priority || '中') + ']'));
        head.appendChild(el('b', '', t.chat_name || t.chat_id || ''));
        if (t.sender_name) head.appendChild(el('span', '', t.sender_name));
        if (t.created_at) head.appendChild(el('span', '', t.created_at));
        const badge = el('span', 'insights-llm-badge' + (t.llm ? ' ok' : ''), t.llm ? 'LLM 判定' : '未经 LLM 判定');
        head.appendChild(badge);
        card.appendChild(head);
        if (t.text) card.appendChild(el('div', 'insights-card-text', t.text));
        const meta = el('div', 'insights-card-meta');
        if (t.action) meta.appendChild(el('div', '', '→ 要做：' + t.action));
        if (t.reason) meta.appendChild(el('div', 'ins-i-reason', '💬 ' + t.reason));
        if (meta.children.length > 0) card.appendChild(meta);
        appendCardActions(card, 'todos', i, true);
        tSec.appendChild(card);
      });
    }
    $insightsMain.appendChild(tSec);

    // 📩 未回复消息
    const unreplied = secs.unreplied || [];
    const uSec = el('div', 'insights-section');
    const uHead = el('div', 'insights-sec-head', '📩 未回复消息');
    uHead.appendChild(el('span', 'insights-sec-count', String(unreplied.length)));
    uSec.appendChild(uHead);
    if (unreplied.length === 0) {
      uSec.appendChild(el('div', 'insights-empty', '都已回复 👍'));
    } else {
      unreplied.forEach((u, i) => {
        const card = el('div', 'insights-card');
        const head = el('div', 'insights-card-head');
        head.appendChild(el('b', '', u.chat_name || u.chat_id || ''));
        head.appendChild(el('span', 'insights-unreplied-why', u.why || ''));
        if (u.since_hours != null) head.appendChild(el('span', '', String(Math.round(u.since_hours * 10) / 10) + ' 小时前'));
        card.appendChild(head);
        const lm = u.last_message || {};
        if (lm.sender_name || lm.text) {
          card.appendChild(el('div', 'insights-card-text', (lm.sender_name ? lm.sender_name + '：' : '') + (lm.text || '')));
        }
        appendCardActions(card, 'unreplied', i);
        uSec.appendChild(card);
      });
    }
    $insightsMain.appendChild(uSec);

    // 🔥 高价值讨论
    const highlights = secs.highlights || [];
    const hSec = el('div', 'insights-section');
    const hHead = el('div', 'insights-sec-head', '🔥 高价值讨论');
    hHead.appendChild(el('span', 'insights-sec-count', String(highlights.length)));
    hSec.appendChild(hHead);
    if (highlights.length === 0) {
      hSec.appendChild(el('div', 'insights-empty', '今日暂无高价值讨论'));
    } else {
      highlights.forEach((h, i) => {
        const card = el('div', 'insights-card');
        const head = el('div', 'insights-card-head');
        head.appendChild(el('b', '', h.chat_name || h.chat_id || ''));
        const msgs = h.messages || [];
        if (msgs.length > 0) head.appendChild(el('span', '', msgs.length + ' 条消息'));
        const badge = el('span', 'insights-llm-badge' + (h.llm ? ' ok' : ''), h.llm ? 'LLM 判定' : '未经 LLM 判定');
        head.appendChild(badge);
        card.appendChild(head);
        if (h.summary) card.appendChild(el('div', 'insights-card-text', '💬 ' + h.summary));
        for (const m of msgs.slice(0, 3)) {
          const row = el('div', 'insights-hl-msg');
          row.appendChild(el('b', '', m.sender_name ? m.sender_name + '：' : ''));
          row.appendChild(document.createTextNode(m.text || ''));
          card.appendChild(row);
        }
        appendCardActions(card, 'highlights', i);
        hSec.appendChild(card);
      });
    }
    $insightsMain.appendChild(hSec);
  }

  function renderInsightsEmpty(date) {
    currentInsightsDay = null;
    $insightsMain.innerHTML = '';
    const wrap = el('div', 'insights-guide');
    wrap.appendChild(el('div', 'insights-guide-title', '💡 洞察 · ' + (date || '')));
    wrap.appendChild(el('div', 'insights-empty', '该日未生成洞察'));
    $insightsMain.appendChild(wrap);
  }

  // ---------- 删除（二次确认 → 硬删除） ----------
  let confirmOkAction = null;
  function showConfirm(title, message, onOk) {
    $confirmTitle.textContent = title;
    $confirmMessage.textContent = message;
    confirmOkAction = onOk;
    $confirmModal.hidden = false;
  }
  $confirmClose.addEventListener('click', () => { $confirmModal.hidden = true; confirmOkAction = null; });
  $confirmModal.addEventListener('click', (e) => { if (e.target === $confirmModal) { $confirmModal.hidden = true; confirmOkAction = null; } });
  $confirmOkBtn.addEventListener('click', () => {
    const fn = confirmOkAction;
    $confirmModal.hidden = true;
    confirmOkAction = null;
    if (fn) fn();
  });

  function confirmDeleteInsight(loc) {
    showConfirm('删除这条洞察？', '此操作不可恢复（硬删除），将从已保存的洞察记录中直接移除。', async () => {
      try {
        const res = await apiFetch('/feishu/insights/delete', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(loc)
        });
        const j = await res.json();
        if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '删除失败');
        toast('已删除');
        loadInsights(false, true);
      } catch (err) {
        toast('删除失败：' + (err && err.message ? err.message : err));
      }
    });
  }

  // ---------- 转会话（新建会话任务：选工作区 + 初始指令 → client 执行 create/prompt/open） ----------
  const DEFAULT_TO_SESSION_WORKSPACE_TITLE = '桌面';   // 转会话默认目标工作区（按标题匹配，无则第一个）

  function buildWorkspaceOptions() {
    let all = Array.isArray(DATA.workspaces) ? DATA.workspaces : [];
    if (all.length === 0) {
      all = [];
      for (const col of (DATA.columns || [])) all.push(...(col.workspaces || []));
    }
    $toSessionWorkspace.innerHTML = '';
    let defaultIdx = 0;
    all.forEach((ws, i) => {
      const opt = document.createElement('option');
      opt.value = ws.id;
      opt.textContent = ws.title;
      $toSessionWorkspace.appendChild(opt);
      if (ws.title === DEFAULT_TO_SESSION_WORKSPACE_TITLE) defaultIdx = i;
    });
    $toSessionWorkspace.selectedIndex = defaultIdx;
  }

  function openToSession(loc) {
    const sec = currentInsightsDay && currentInsightsDay.sections && currentInsightsDay.sections[loc.section];
    const item = sec && sec[loc.index];
    if (!item) { toast('该条洞察不存在，请刷新'); return; }
    let body = '请处理以下来自办公室洞察的事项：\n\n';
    if (loc.section === 'todos') {
      if (item.action) body += '要做什么：' + item.action + '\n';
      if (item.reason) body += '理由：' + item.reason + '\n';
      body += '\n原消息：\n' + (item.text || '');
    } else if (loc.section === 'unreplied') {
      const lm = item.last_message || {};
      body += '有一条尚未回复的消息：\n' + (lm.sender_name ? lm.sender_name + '：' : '') + (lm.text || '') + '\n\n请处理这条消息。';
    } else {
      body += '有一场高价值讨论值得回顾：\n' + (item.summary || '') + '\n\n相关消息：\n' +
        (item.messages || []).map((m) => (m.sender_name ? m.sender_name + '：' : '') + (m.text || '')).join('\n');
    }
    $toSessionPrompt.value = body;
    $toSessionError.textContent = '';
    buildWorkspaceOptions();
    $toSessionModal.hidden = false;
  }

  async function submitToSession() {
    const workspaceId = $toSessionWorkspace.value;
    const promptText = $toSessionPrompt.value.trim();
    if (!workspaceId) { $toSessionError.textContent = '请选择目标工作区'; return; }
    if (!promptText) { $toSessionError.textContent = '任务指令不能为空'; return; }
    try {
      const res = await apiFetch('/feishu/insights/to-session', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ workspaceId, promptText })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '提交失败');
      $toSessionModal.hidden = true;
      toast('已提交，正在创建会话并开工…');
    } catch (err) {
      $toSessionError.textContent = (err && err.message ? err.message : String(err));
    }
  }

  // 卡片操作（事件委托）
  $insightsMain.addEventListener('click', (e) => {
    const btn = e.target.closest('.insight-action');
    if (!btn) return;
    const loc = { date: btn.dataset.date, section: btn.dataset.section, index: parseInt(btn.dataset.index, 10) };
    if (btn.dataset.kind === 'remove') confirmDeleteInsight(loc);
    else if (btn.dataset.kind === 'to-session') openToSession(loc);
    else if (btn.dataset.kind === 'add-todo') addInsightToTodo(loc);
  });

  // 洞察「📋 重要待办」一键加入「📝 我的待办」（复制到洞察查看的那一天）
  async function addInsightToTodo(loc) {
    const sec = currentInsightsDay && currentInsightsDay.sections && currentInsightsDay.sections[loc.section];
    const item = sec && sec[loc.index];
    if (!item) { toast('该条洞察不存在，请刷新'); return; }
    const text = (item.action && String(item.action).trim()) || (item.text && String(item.text).trim()) || '';
    if (!text) { toast('该条洞察无可加入的内容'); return; }
    try {
      const res = await apiFetch('/todos/add', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ date: insightsDate, text })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '添加失败');
      toast('已加入 ' + (insightsDate || todayStr()) + ' 的我的待办');
    } catch (err) {
      toast('加入待办失败：' + (err && err.message ? err.message : err));
    }
  }

  // ---------- 洞察日期切换（只驱动洞察；左=前一天、右=后一天） ----------
  function applyInsightsDate(next) {
    if (!next) return;
    insightsDate = next;
    syncDatePickerUI();
    loadInsights(false, true);
  }
  $insightsDatePrev.addEventListener('click', () => applyInsightsDate(shiftDate(insightsDate || todayStr(), -1)));
  $insightsDateNext.addEventListener('click', () => applyInsightsDate(shiftDate(insightsDate || todayStr(), 1)));
  $insightsDateToday.addEventListener('click', () => applyInsightsDate(todayStr()));
  $insightsDateInput.addEventListener('change', () => applyInsightsDate($insightsDateInput.value));

  $toSessionClose.addEventListener('click', () => { $toSessionModal.hidden = true; });
  $toSessionModal.addEventListener('click', (e) => { if (e.target === $toSessionModal) $toSessionModal.hidden = true; });
  $toSessionOkBtn.addEventListener('click', submitToSession);

  // ---------- 洞察工具栏（视图开关由飞书视图统一驱动，见 lark.js toggleFeishu） ----------
  $insightsRefreshBtn.addEventListener('click', () => loadInsights(true, true));
  $insightsGenBtn.addEventListener('click', () => insightsGenerate());

  function syncDatePickerUI() {
    $insightsDateInput.value = insightsDate || todayStr();
  }

  // ---------- 生成（异步：先增量同步再洞察；前端轮询 status） ----------
  async function insightsGenerate() {
    if (insightsGenerating) return;
    insightsGenerating = true;
    $insightsGenBtn.disabled = true;
    $insightsGenBtn.textContent = '生成中…';
    $insightsStatus.textContent = '⏳ 正在生成…（先增量同步再分析）';
    try {
      await apiFetch('/feishu/insights/generate', { method: 'POST' });
      pollInsightsDone();
    } catch (e) {
      insightsGenerating = false;
      $insightsGenBtn.disabled = false;
      $insightsGenBtn.textContent = '生成今日洞察';
      $insightsStatus.textContent = '⚠️ 生成失败：' + (e && e.message || e);
      try { toast('洞察生成失败'); } catch (_) {}
    }
  }

  function pollInsightsDone() {
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch('/feishu/insights/status?refresh=1');
        const j = await res.json();
        if (j && j.data && !j.data.generating) {
          clearInterval(timer);
          insightsGenerating = false;
          $insightsGenBtn.disabled = false;
          $insightsGenBtn.textContent = '生成今日洞察';
          insightsDate = todayStr();   // 生成完成 → 回到今天视图
          loadInsights(false, true);
        }
      } catch (_) { /* 网络抖动继续轮询 */ }
    }, 3000);
  }

  // ---------- 加载：status（前置条件/惰性触发）→ history（所选日期渲染） ----------
  async function loadInsights(forceRefresh, skipLazy) {
    if (!insightsDate) insightsDate = todayStr();
    syncDatePickerUI();

    try {
      const res = await apiFetch('/feishu/insights/status' + (forceRefresh ? '?refresh=1' : ''));
      const j = await res.json();
      const d = j && j.data;
      if (!d) { $insightsStatus.textContent = '⚠️ 状态获取失败'; return; }

      if (!d.configured) {
        // 未配置洞察脚本：显示引导卡
        renderInsightsGuide(d.prereq || {});
        return;
      }
      if (!(d.prereq && d.prereq.msgConnected)) {
        // 消息流未接入：显示引导卡（先接消息流）
        renderInsightsGuide(d.prereq || {});
        return;
      }

      // 惰性触发：查看今天且今日未生成 → 自动生成（每天最多一次）
      const today = todayStr();
      const lastDate = d.last && d.last.date;
      if (!skipLazy && !insightsLazyFired && insightsDate === today && (!lastDate || lastDate !== today)) {
        insightsLazyFired = true;
        insightsGenerate();
        return;   // 生成完成后由轮询回调刷新
      }

      // 所选日期数据（历史接口；无数据 → 空态）
      const hr = await apiFetch('/feishu/insights/history?date=' + encodeURIComponent(insightsDate));
      const hj = await hr.json();
      const hd = hj && hj.ok && hj.data;
      if (hd && !hd.empty) {
        const st = hd.stats || {};
        const llmTxt = st.llm === 'ok' ? 'LLM 判定 ✅' : (st.llm === 'fallback' ? 'LLM 判定 ⚠️（回退规则）' : '规则判定（未配 LLM key）');
        $insightsStatus.textContent = (hd.date || '') + ' · 扫描 ' + (st.scanned != null ? st.scanned : '?') + ' 条 · ' + llmTxt;
        renderInsightsData(hd);
      } else {
        $insightsStatus.textContent = '';
        renderInsightsEmpty(insightsDate);
      }
    } catch (e) {
      $insightsStatus.textContent = '⚠️ 加载失败';
      try { toast('洞察加载失败'); } catch (_) {}
    }
  }


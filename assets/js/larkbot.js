  // ============================================================
  // 🤖 群聊助理视图：机器人身份监听群聊 → LLM 门控 → dsh 会话执行 → 文本回群
  // 后端：lib/larkbot.js（Host 常驻 WS + agents 绑定 + 决策日志）
  // 视图能力：启停开关 / 状态卡 / 最近决策日志 / 未配置引导卡
  // ============================================================
  const $larkbotBtn = document.getElementById('larkbotBtn');
  const $larkbotView = document.getElementById('larkbotView');
  const $larkbotStatus = document.getElementById('larkbotStatus');
  const $larkbotRefreshBtn = document.getElementById('larkbotRefreshBtn');
  const $larkbotEnableBtn = document.getElementById('larkbotEnableBtn');
  const $larkbotReloadBtn = document.getElementById('larkbotReloadBtn');
  const $larkbotSetup = document.getElementById('larkbotSetup');
  const $larkbotStatusCard = document.getElementById('larkbotStatusCard');
  const $larkbotDecisionList = document.getElementById('larkbotDecisionList');

  let larkbotViewOpen = false;
  let larkbotPollTimer = null;
  const LARKBOT_POLL_MS = 10000;      // 视图打开时的轮询间隔
  const LARKBOT_DECISION_SHOW = 30;   // 决策列表最多渲染条数

  function larkbotTime(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    const diff = Date.now() - t.getTime();
    return relativeTime(diff, () =>
      t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes()));
  }

  // 决策类型 → 徽标
  function larkbotBadge(decision) {
    switch (decision) {
      case 'replied':    return '✅';
      case 'reply':      return '▶️';
      case 'skip':       return '⏭️';
      case 'reply-error':return '⚠️';
      case 'gate-error': return '❌';
      default:           return '·';
    }
  }
  function larkbotDecisionLabel(decision) {
    switch (decision) {
      case 'replied':     return '已回复';
      case 'reply':       return '执行中';
      case 'skip':        return '不回复';
      case 'reply-error': return '回复失败';
      case 'gate-error':  return '门控失败';
      default:            return decision || '';
    }
  }

  // ---------- 状态卡渲染 ----------
  function renderLarkBotStatus(d) {
    const parts = [];
    // 运行状态
    if (!d.configured) {
      parts.push('<div class="larkbot-row warn">配置缺失：' + escHtml(d.configError || '未找到 larkbot-config.json') + '</div>');
    } else if (!d.enabled) {
      parts.push('<div class="larkbot-row warn">已注册但未启用 —— 点右上「启用」开始轮询（需先配置好 allowChats）</div>');
    } else if (!d.running) {
      parts.push('<div class="larkbot-row error">启动失败：' + escHtml(d.lastError || '未知错误') + '</div>');
    } else {
      parts.push('<div class="larkbot-row ok">✅ 运行中 · 轮询 ' + d.chatCount + ' 个群（每 ' + (d.pollIntervalSec || 15) + 's）· 身份 ' + escHtml(d.identity || 'user')
        + (d.activeSessions ? ' · 活跃会话 ' + d.activeSessions : '')
        + (d.busyCount ? ' · 处理中 ' + d.busyCount + ' 群' : '')
        + (d.pendingCount ? ' · 排队 ' + d.pendingCount + ' 条' : '') + '</div>');
      if (d.startedAt) parts.push('<div class="larkbot-row dim">启动于 ' + larkbotTime(new Date(d.startedAt).toISOString()) + '</div>');
    }
    if (d.cliPath) parts.push('<div class="larkbot-row dim">lark-cli：' + escHtml(d.cliPath) + '</div>');
    if (d.workspaceRoot) parts.push('<div class="larkbot-row dim">一群一项目空间：' + escHtml(d.workspaceRoot) + ' / &lt;chatId&gt;</div>');
    parts.push('<div class="larkbot-row dim">决策记录 ' + d.decisionsCount + ' 条（最多展示 ' + LARKBOT_DECISION_SHOW + ' 条）</div>');
    $larkbotStatusCard.innerHTML = parts.join('');
    // 启用按钮状态
    const enabled = d.configured && d.enabled;
    $larkbotEnableBtn.textContent = enabled ? '停用' : '启用';
    $larkbotEnableBtn.title = enabled ? '停用机器人' : '启用机器人';
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- 引导卡（未配置时） ----------
  async function renderLarkBotSetup() {
    try {
      const res = await apiFetch('/larkbot/config', { cache: 'no-store' });
      const j = await res.json();
      if (!j.ok) {
        $larkbotSetup.hidden = false;
        $larkbotSetup.innerHTML =
          '<div class="mail-setup"><div class="mail-setup-card">' +
          '<div class="fm-head"><span>🤖 群聊助理 / 配置</span></div>' +
          '<div class="fm-body"><p>未找到配置 ' + escHtml(j.error && j.error.message || '') + '</p>' +
          '<p>本功能复用你已授权的 <b>lark-cli</b>（超能干应用 + 用户身份）收发飞书消息，<b>不需要任何机器人凭据</b>。</p>' +
          '<p>请在本机创建 ' + escHtml((j.data && j.data.configPath) || '~/.dsh/office/larkbot-config.json') + '：</p>' +
          '<pre class="larkbot-config-pre">' + escHtml(CONFIG_TEMPLATE) + '</pre>' +
          '<p>把机器人所在的目标群 chat_id 填入 <code>allowChats</code>（可在飞书群里 @ 后看办公室日志，或运行 <code>lark-cli im +chat-list</code> 查）。</p>' +
          '<button class="cal-tr-btn" onclick="larkbotCopyConfig()">复制配置模板</button>' +
          '<button class="cal-tr-btn" onclick="larkbotReload()">我已配置，重载</button>' +
          '</div></div></div>';
        return;
      }
      $larkbotSetup.hidden = true;
    } catch (e) {
      $larkbotSetup.hidden = true;
    }
  }

  const CONFIG_TEMPLATE = `{
  "enabled": false,
  "cliPath": "",
  "profile": "",
  "as": "user",
  "workspaceRoot": "",
  "allowChats": ["oc_你的群chat_id"],
  "pollIntervalSec": 15,
  "mentionOnly": false,
  "agentPreset": "",
  "provider": "",
  "model": ""
}`;

  window.larkbotCopyConfig = function () {
    copyToClipboard(CONFIG_TEMPLATE,
      () => setStatus($larkbotStatus, '配置模板已复制'),
      () => setStatus($larkbotStatus, '复制失败，请手动复制'));
  };
  window.larkbotReload = function () { larkbotReloadConfig(); };

  // ---------- 数据加载 ----------
  async function loadLarkBotStatus(quiet) {
    try {
      const res = await apiFetch('/larkbot/status', { cache: 'no-store' });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error && j.error.message || 'status 接口失败');
      renderLarkBotStatus(j.data);
      if (!j.data.configured || !j.data.enabled) await renderLarkBotSetup();
      else $larkbotSetup.hidden = true;
      setStatus($larkbotStatus, '');
    } catch (e) {
      if (!quiet) setStatus($larkbotStatus, '状态读取失败：' + (e && e.message ? e.message : e));
    }
  }

  async function loadLarkBotDecisions() {
    try {
      const res = await apiFetch('/larkbot/decisions', { cache: 'no-store' });
      const j = await res.json();
      if (!j.ok) return;
      const list = (j.data && j.data.decisions) || [];
      const rows = list.slice(0, LARKBOT_DECISION_SHOW).map((d) => {
        const badge = larkbotBadge(d.decision);
        const label = larkbotDecisionLabel(d.decision);
        const reason = d.decision === 'skip' && d.reason ? ' · ' + escHtml(d.reason) : '';
        const err = d.decision === 'reply-error' || d.decision === 'gate-error'
          ? ' <span class="log-level error">' + escHtml(d.reason || '') + '</span>' : '';
        return '<div class="log-item">' +
          '<span class="log-time">' + escHtml(larkbotTime(d.at)) + '</span>' +
          '<span class="log-level">' + badge + ' ' + label + '</span>' +
          '<span class="log-msg" title="' + escHtml(d.text || '') + '">' +
          escHtml((d.sender || '?') + '：' + (d.text || '')) +
          '</span>' + reason + err +
          '</div>';
      });
      $larkbotDecisionList.innerHTML = rows.length
        ? rows.join('')
        : '<div class="log-item"><span class="log-msg">暂无决策记录 —— 启动并监听后，每条群消息的门控判断都会记录在这里。</span></div>';
    } catch (_) { /* 轮询失败静默 */ }
  }

  // ---------- 操作 ----------
  async function larkbotToggleEnable() {
    const enabled = $larkbotEnableBtn.textContent === '启用';
    $larkbotEnableBtn.disabled = true;
    try {
      const res = await apiFetch('/larkbot/enable', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error && j.error.message || 'enable 失败');
      renderLarkBotStatus(j.data);
      if (enabled && (!j.data.running)) {
        setStatus($larkbotStatus, '启动未成功：' + (j.data.lastError || '请查看状态卡'));
      } else {
        setStatus($larkbotStatus, enabled ? '已启用' : '已停用');
      }
      await loadLarkBotDecisions();
    } catch (e) {
      setStatus($larkbotStatus, '操作失败：' + (e && e.message ? e.message : e));
    } finally {
      $larkbotEnableBtn.disabled = false;
    }
  }

  async function larkbotReloadConfig() {
    $larkbotReloadBtn.disabled = true;
    try {
      const res = await apiFetch('/larkbot/reload', { method: 'POST' });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error && j.error.message || 'reload 失败');
      renderLarkBotStatus(j.data);
      if (j.data.enabled && j.data.running) setStatus($larkbotStatus, '已重载并运行中');
      else setStatus($larkbotStatus, '已重载（' + (j.data.lastError || '未运行') + '）');
      await loadLarkBotDecisions();
      if (!j.data.configured || !j.data.enabled) await renderLarkBotSetup();
    } catch (e) {
      setStatus($larkbotStatus, '重载失败：' + (e && e.message ? e.message : e));
    } finally {
      $larkbotReloadBtn.disabled = false;
    }
  }

  // ---------- 视图开关 ----------
  function toggleLarkBot() {
    toggleView('larkbot',
      () => larkbotViewOpen, (v) => { larkbotViewOpen = v; },
      () => { stopLarkBotPoll(); },
      () => {
        loadLarkBotStatus(false);
        loadLarkBotDecisions();
        startLarkBotPoll();
      }
    );
  }

  function startLarkBotPoll() {
    stopLarkBotPoll();
    larkbotPollTimer = setInterval(() => {
      if (!larkbotViewOpen) { stopLarkBotPoll(); return; }
      loadLarkBotStatus(true);
      loadLarkBotDecisions();
    }, LARKBOT_POLL_MS);
  }
  function stopLarkBotPoll() {
    if (larkbotPollTimer) { clearInterval(larkbotPollTimer); larkbotPollTimer = null; }
  }

  // ---------- 事件绑定 ----------
  $larkbotBtn.addEventListener('click', toggleLarkBot);
  $larkbotRefreshBtn.addEventListener('click', () => { loadLarkBotStatus(false); loadLarkBotDecisions(); });
  $larkbotEnableBtn.addEventListener('click', larkbotToggleEnable);
  $larkbotReloadBtn.addEventListener('click', larkbotReloadConfig);

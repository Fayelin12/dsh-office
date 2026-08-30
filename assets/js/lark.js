  // ============================================================
  // 飞书消息流视图（配置驱动：~/.dsh/office/feishu-config.json）
  // 只读取本地脚本输出，不联网；未配置时显示引导卡
  // ============================================================
  const $feishuBtn = document.getElementById('feishuBtn');
  const $feishuView = document.getElementById('feishuView');
  const $feishuIdentity = document.getElementById('feishuIdentity');
  const $feishuStatus = document.getElementById('feishuStatus');
  const $feishuList = document.getElementById('feishuList');
  const $feishuRefreshBtn = document.getElementById('feishuRefreshBtn');
  const $feishuSyncBtn = document.getElementById('feishuSyncBtn');
  const $feishuModal = document.getElementById('feishuModal');
  const $fmTitle = document.getElementById('fmTitle');
  const $fmBody = document.getElementById('fmBody');
  const $fmClose = document.getElementById('fmClose');

  let feishuViewOpen = false;
  let feishuMessages = [];   // 会话数组（方案 B 卡片流）
  let feishuSince = '';      // 上次同步时间（'YYYY-MM-DD HH:MM'），用于标注新消息
  let feishuMention = [];    // 提醒关键词（来自 /status，卡片标黄）
  let feishuSyncTimer = null;
  let feishuLazyFired = false;  // 惰性补同步：每次打开只触发一次

  function formatLastSync(ls) {
    if (!ls) return '';
    return '上次同步 | 新增=' + ls.added + ' 跳过=' + ls.skipped + ' 总消息=' + ls.total + ' 耗时=' + ls.elapsed + 's';
  }

  async function loadFeishuStatus() {
    try {
      const res = await apiFetch('/feishu/status', { cache: 'no-store' });
      const json = await res.json();
      if (!json || !json.ok || !json.data) { setStatus($feishuStatus, TEXT_STATUS_ERROR); return; }
      const d = json.data;
      if (!d.configured) { renderFeishuGuide(); return; }
      $feishuSyncBtn.disabled = false;
      feishuMention = Array.isArray(d.mention) ? d.mention.filter((s) => s) : [];
      const auto = d.autoSync || {};
      let base = d.syncing ? TEXT_SYNCING : formatLastSync(d.lastSync) || '尚未同步';
      if (auto.enabled && base && !d.syncing) base += ' · 每' + auto.intervalMin + '分钟自动同步';
      setStatus($feishuStatus, base);
      if (feishuMessages.length) renderFeishuCards(feishuMessages);  // 关键词到位后刷新卡片状态
      // ③ 惰性补同步：autoSync 开启且数据过期（stale）→ 打开时自动触发一次
      if (auto.enabled && d.stale && !d.syncing && !feishuLazyFired) {
        feishuLazyFired = true;
        syncFeishu('incr');
        // 不等同步完成，立即加载已有消息（用户先看到旧数据）
        loadFeishuMessages();
      }
    } catch (e) {
      setStatus($feishuStatus, TEXT_STATUS_ERROR);
    }
  }

  async function loadFeishuMessages() {
    // 首次加载时显示 loading 提示（列表为空时），后续刷新不闪烁
    if (!$feishuList.children.length) {
      $feishuList.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim);font-size:var(--font-sub)">' + TEXT_LOADING + '</div>';
    }
    try {
      const res = await apiFetch('/feishu/messages?per-chat=' + FEISHU_PER_CHAT, { cache: 'no-store' });
      const json = await res.json();
      if (!json || !json.ok) {
        const code = json && json.error && json.error.code;
        if (code === 'FEISHU_CONFIG_REQUIRED') { renderFeishuGuide(); return; }
        setStatus($feishuStatus, (json && json.error && json.error.message) || TEXT_READ_ERROR);
        return;
      }
      feishuMessages = (json.data && json.data.chats) || [];
      feishuSince = (json.data && json.data.since) || '';
      // latest.js 全量路径下 messages 已是「本次新入库」；卡片预览/详情要展示最近 N 条，改用 recent_messages
      for (const c of feishuMessages) {
        if (c && c.recent_messages) c.messages = c.recent_messages;
      }
      renderFeishuCards(feishuMessages);
    } catch (e) {
      setStatus($feishuStatus, TEXT_READ_ERROR + '：' + (e && e.message ? e.message : e));
    }
  }

  // 正文预览：图片占位符转 📷，压缩空白；资源消息显示类型占位（📷 图片 / 📎 文件 / 📁 文件夹）
  function feishuPreview(m) {
    if (m && m.resource_type) {
      if (m.resource_type === 'image') return '📷 图片';
      if (m.resource_type === 'folder') return '📁 ' + (m.file_name || '文件夹');
      return '📎 ' + (m.file_name || '文件');
    }
    const t = (m && m.text) || '';
    return t.replace(/!\[[^\]]*\]\([^)]*\)/g, '📷 图片').replace(/\s+/g, ' ').trim() || TEXT_NO_BODY;
  }
  function chatTypeLabel(t) { return t === 'p2p' ? '私聊' : '群聊'; }
  function shortTime(created) {
    if (!created) return '';
    const [date, time] = String(created).split(' ');
    const d = new Date();
    const today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return date === today ? (time || '') : date.slice(5);
  }
  function feishuWho(m) {
    return (m && (m.sender_name || (m.user_id || '').slice(0, 8))) || '未知';
  }

  // 卡片状态：yellow（最近 10 条提到关键词）> blue（6 小时内活跃）> gray（超 3 天）
  function feishuCardState(c) {
    if (feishuMention.length) {
      const recent10 = (c.messages || []).slice(0, FEISHU_PREVIEW_COUNT);
      for (const m of recent10) {
        const t = (m && m.text) || '';
        if (feishuMention.some((k) => t.includes(k))) return 'yellow';
      }
    }
    const lastAt = c && c.last_at;
    if (lastAt) {
      const t = new Date(String(lastAt).replace(' ', 'T')).getTime();
      if (!isNaN(t)) {
        const diff = Date.now() - t;
        if (diff <= FEISHU_ACTIVE_HOURS * 3600 * 1000) return 'blue';
        if (diff > FEISHU_STALE_DAYS * 24 * 3600 * 1000) return 'gray';
      }
    }
    return 'normal';
  }
  function feishuStateTitle(state) {
    if (state === 'yellow') return '最近消息提到了「' + feishuMention.join(' / ') + '」';
    if (state === 'blue') return '最近 6 小时内有消息';
    if (state === 'gray') return '超过 3 天没有新消息';
    return '';
  }

  function renderFeishuCards(chats) {
    $feishuList.classList.remove('guide');
    $feishuList.innerHTML = '';
    if (!chats.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '暂无消息，点「同步」拉取';
      $feishuList.appendChild(empty);
      return;
    }
    // 排序：新增数降序 → 最后活跃时间倒序
    const sorted = chats.slice().sort((a, b) => {
      const na = a.new_count || 0, nb = b.new_count || 0;
      if (na !== nb) return nb - na;
      return String(b.last_at || '').localeCompare(String(a.last_at || ''));
    });
    // 4 列错层瀑布流：贪心放入当前最矮的列
    const cols = [];
    for (let i = 0; i < 4; i++) {
      const col = document.createElement('div');
      col.className = 'f-col';
      $feishuList.appendChild(col);
      cols.push(col);
    }
    for (const c of sorted) {
      let mi = 0, mh = Infinity;
      for (let i = 0; i < cols.length; i++) {
        const h = cols[i].offsetHeight;
        if (h < mh) { mh = h; mi = i; }
      }
      cols[mi].appendChild(buildFeishuCard(c));
    }
  }

  function buildFeishuCard(c) {
    const card = document.createElement('div');
    const state = feishuCardState(c);
    const cls = ['f-card'];
    if (state !== 'normal') cls.push(state);
    if ((c.new_count || 0) > 0) cls.push('new');
    card.className = cls.join(' ');
    card.dataset.id = c.chat_id || '';
    const stTitle = feishuStateTitle(state);
    if (stTitle) card.title = stTitle;

    const head = document.createElement('div');
    head.className = 'f-head';
    const name = document.createElement('span');
    name.className = 'f-name';
    name.textContent = c.chat_name || (c.chat_id || '').slice(0, 12);
    name.title = c.chat_name || c.chat_id || '';
    const type = document.createElement('span');
    type.className = 'f-type' + (c.chat_type === 'p2p' ? ' p2p' : '');
    type.textContent = chatTypeLabel(c.chat_type);
    const badge = document.createElement('span');
    badge.className = 'f-new';
    badge.textContent = '+' + (c.new_count || 0);
    const time = document.createElement('span');
    time.className = 'f-time';
    time.textContent = shortTime(c.last_at);
    head.appendChild(name); head.appendChild(type); head.appendChild(badge); head.appendChild(time);

    const preview = document.createElement('div');
    preview.className = 'f-preview';
    const prevMsgs = (c.messages || []).slice(0, FEISHU_PREVIEW_COUNT);   // 卡片内预览最多 10 条
    if (!prevMsgs.length) {
      const row = document.createElement('div');
      row.className = 'fp-row';
      row.textContent = '（暂无消息）';
      preview.appendChild(row);
    } else {
      for (const m of prevMsgs) {
        const row = document.createElement('div');
        row.className = 'fp-row';
        const who = document.createElement('b');
        who.textContent = feishuWho(m) + '：';
        row.appendChild(who);
        row.appendChild(document.createTextNode(feishuPreview(m)));
        row.addEventListener('click', (e) => { e.stopPropagation(); openFeishuChat(c, m.message_id); });
        preview.appendChild(row);
      }
    }

    card.addEventListener('click', () => openFeishuChat(c, null));
    card.appendChild(head); card.appendChild(preview);
    return card;
  }

  // ---------- 会话弹窗（点击卡片打开） ----------
  let feishuModalCtx = null;   // 弹窗分页上下文 { chat, loaded, total }

  function buildFeishuMsgRow(m) {
    const row = document.createElement('div');
    row.className = 'fm-msg';
    row.dataset.id = m.message_id || '';

    const head = document.createElement('div');
    head.className = 'fm-msg-head';
    const isNew = feishuSince && m.created_at && m.created_at > feishuSince;
    if (isNew) {
      const dot = document.createElement('span');
      dot.className = 'fm-msg-new';
      dot.title = '同步后新增';
      head.appendChild(dot);
    }
    const who = document.createElement('span');
    who.className = 'fm-msg-who';
    who.textContent = feishuWho(m);
    who.title = m.user_id || '';
    const tm = document.createElement('span');
    tm.className = 'fm-msg-time';
    tm.textContent = shortTime(m.created_at);
    head.appendChild(who); head.appendChild(tm);

    const text = document.createElement('div');
    text.className = 'fm-msg-text';
    text.textContent = feishuPreview(m);

    row.appendChild(head); row.appendChild(text);
    // 资源消息（图片/文件/文件夹）：渲染资源块（图片缩略图 / 文件下载卡片）
    const resEl = buildFeishuResource(m);
    if (resEl) row.appendChild(resEl);
    row.addEventListener('click', () => {
      // 点击行：展开/收起完整正文（同一时间只展开一条）；资源区点击不冒泡（在 buildFeishuResource 内 stopPropagation）
      const opened = row.classList.contains('open');
      $fmBody.querySelectorAll('.fm-msg.open').forEach((el) => el.classList.remove('open'));
      if (!opened) row.classList.add('open');
    });
    return row;
  }

  // 资源接口 URL 拼接（统一入口：图片内联/打开原图/文件打开共用）
  function buildResourceUrl(m, type, action) {
    const base = action === 'open' ? '/feishu/resource/open' : '/feishu/resource';
    return base + '?msg=' + encodeURIComponent(m.message_id || '') +
      '&key=' + encodeURIComponent(m.resource_key) + '&type=' + encodeURIComponent(type);
  }

  // 资源消息块：image → 缩略图（点击放大/缩小）+ 打开原图；file → 图标 + 文件名 + 打开按钮；folder → 只展示
  function buildFeishuResource(m) {
    const type = m && m.resource_type;
    if (!type || !m.resource_key) return null;
    const box = document.createElement('div');
    box.className = 'fm-resource';
    box.addEventListener('click', (e) => e.stopPropagation());   // 不触发行展开

    if (type === 'image') {
      const img = document.createElement('img');
      img.className = 'fm-resource-img';
      img.alt = '图片';
      img.loading = 'lazy';
      img.src = buildResourceUrl(m, 'image');
      img.addEventListener('click', () => img.classList.toggle('open'));
      box.appendChild(img);
      // 打开原图：新标签页直接渲染本地缓存图（无需下载）
      const view = document.createElement('button');
      view.className = 'fm-resource-dl';
      view.textContent = '打开原图';
      view.addEventListener('click', () => {
        window.open(img.src, '_blank', 'noopener');
      });
      box.appendChild(view);
      img.addEventListener('error', () => {
        // 获取失败（缺权限/过期）：移除图片与打开按钮，显示占位错误
        img.remove();
        view.remove();
        const err = document.createElement('span');
        err.className = 'fm-resource-err';
        err.textContent = '⚠️ 图片不可用（可能无权限或已过期）';
        box.appendChild(err);
      });
      return box;
    }

    // file / folder
    const ic = document.createElement('span');
    ic.className = 'fm-resource-ic';
    ic.textContent = type === 'folder' ? '📁' : '📎';
    const name = document.createElement('span');
    name.className = 'fm-resource-name';
    name.textContent = m.file_name || (type === 'folder' ? '文件夹' : '文件');
    name.title = m.file_name || m.resource_key || '';
    box.appendChild(ic); box.appendChild(name);
    if (type === 'file') {
      // 文件已缓存本地，用系统默认程序打开（md→编辑器 / pptx→PowerPoint / zip→资源管理器），不走浏览器下载
      const openBtn = document.createElement('button');
      openBtn.className = 'fm-resource-dl';
      openBtn.textContent = '打开';
      openBtn.addEventListener('click', async () => {
        openBtn.disabled = true;
        openBtn.textContent = '打开中…';
        try {
          const res = await apiFetch(buildResourceUrl(m, 'file', 'open'), { cache: 'no-store' });
          const j = await res.json().catch(() => null);
          if (!res.ok || !j || !j.ok) {
            toast((j && j.error && j.error.message) || '打开失败');
          }
        } catch (e) {
          toast('打开失败：' + (e && e.message ? e.message : e));
        } finally {
          openBtn.disabled = false;
          openBtn.textContent = '打开';
        }
      });
      box.appendChild(openBtn);
    } else {
      // folder 是容器，不支持打开（lark-cli 无 folder 类型资源）
      const tip = document.createElement('span');
      tip.className = 'fm-resource-err';
      tip.textContent = '文件夹';
      box.appendChild(tip);
    }
    return box;
  }

  // 弹窗底部的「加载更早消息」按钮（按 offset 翻页）
  function renderFeishuMoreBtn() {
    const old = $fmBody.querySelector('.fm-more');
    if (old) old.remove();
    const ctx = feishuModalCtx;
    if (!ctx || ctx.loaded >= ctx.total) return;
    const btn = document.createElement('button');
    btn.className = 'fm-more';
    btn.textContent = '加载更早消息（' + ctx.loaded + '/' + ctx.total + '）';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = TEXT_LOADING;
      try {
        const res = await apiFetch('/feishu/messages?chat=' + encodeURIComponent(ctx.chat.chat_id) +
          '&offset=' + ctx.loaded + '&per-chat=' + FEISHU_PER_CHAT, { cache: 'no-store' });
        const json = await res.json();
        if (!json || !json.ok) {
          btn.disabled = false;
          btn.textContent = '加载失败，点此重试';
          return;
        }
        const one = json.data && json.data.chats && json.data.chats[0];
        const more = (one && one.messages) || [];
        for (const m of more) $fmBody.appendChild(buildFeishuMsgRow(m));
        ctx.loaded += more.length;
        if (one && typeof one.count === 'number') ctx.total = one.count;
        renderFeishuMoreBtn();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '加载失败，点此重试';
      }
    });
    $fmBody.appendChild(btn);
  }

  function openFeishuChat(c, expandMsgId) {
    $fmTitle.textContent = (c.chat_name || c.chat_id || '') +
      ' · ' + chatTypeLabel(c.chat_type) + ' · ' + (c.count || (c.messages || []).length) + ' 条消息';
    $fmBody.innerHTML = '';
    feishuModalCtx = {
      chat: c,
      loaded: (c.messages || []).length,
      total: c.count || (c.messages || []).length
    };
    const msgs = c.messages || [];
    if (!msgs.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '该会话暂无文字消息';
      $fmBody.appendChild(empty);
    }
    for (const m of msgs) $fmBody.appendChild(buildFeishuMsgRow(m));
    renderFeishuMoreBtn();
    $feishuModal.hidden = false;
    if (expandMsgId) {
      const target = $fmBody.querySelector('.fm-msg[data-id="' + expandMsgId + '"]');
      if (target) target.classList.add('open');
    }
  }
  function closeFeishuModal() { $feishuModal.hidden = true; }

  // ---------- 未配置引导卡 ----------
  function renderFeishuGuide() {
    $feishuIdentity.textContent = '💬 飞书';
    $feishuSyncBtn.disabled = true;
    $feishuList.classList.add('guide');
    $feishuList.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'mail-setup';
    const card = document.createElement('div');
    card.className = 'mail-setup-card';

    const title = document.createElement('div');
    title.className = 'ms-title';
    title.textContent = '💬 飞书 / 消息流视图';

    const desc = document.createElement('div');
    desc.className = 'ms-prompt';
    desc.appendChild(document.createTextNode('本视图用于把本机上的消息数据（例如飞书群聊/私聊消息）汇总到办公室面板一屏查看。它只读取本机配置文件 feishu-config.json 里指定的本地脚本输出，不联网、不上传任何数据；未配置时该功能保持禁用，不影响其它功能。'));

    const steps = document.createElement('ol');
    steps.className = 'ms-steps';
    steps.appendChild(mkStep('创建配置文件：<code>~/.dsh/office/feishu-config.json</code>'));
    steps.appendChild(mkStep('填入你的同步脚本与读取脚本的<strong>绝对路径</strong>（见模板）'));
    steps.appendChild(mkStep('点「重新检测」'));

    const tpl = document.createElement('div');
    tpl.className = 'ms-prompt';
    tpl.appendChild(document.createTextNode('配置模板：'));
    const tplText = document.createElement('div');
    tplText.className = 'ms-prompt-text';
    tplText.textContent = '{ "scripts": { "sync": "<你的同步脚本路径，如 .../ingestor/ingestor.js>", "latest": "<你的读取脚本路径，如 .../ingestor/latest.js>" }, "mention": ["你的名字，可选；最近消息提到则卡片标黄"], "autoSync": { "enabled": false, "intervalMin": 30, "说明": "可选；enabled=true 时按间隔自动同步（仅 dsh web 运行期间生效）" } }';
    tpl.appendChild(tplText);

    const actions = document.createElement('div');
    actions.className = 'ms-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn';
    copyBtn.textContent = '复制配置模板';
    copyBtn.addEventListener('click', () => {
      copyToClipboard(tplText.textContent,
        () => setStatus($feishuStatus, TEXT_COPY_OK),
        () => setStatus($feishuStatus, TEXT_COPY_FAIL));
    });
    const retryBtn = document.createElement('button');
    retryBtn.className = 'icon-btn';
    retryBtn.textContent = TEXT_RETRY;
    retryBtn.addEventListener('click', () => {
      setStatus($feishuStatus, '检测中…');
      // 清除后端配置缓存，让 loadFeishuStatus 重新读取磁盘
      apiFetch('/feishu/status?refresh=1', { cache: 'no-store' }).then(() => {
        loadFeishuStatus();
        loadFeishuMessages();
      }).catch(() => {
        loadFeishuStatus();
        loadFeishuMessages();
      });
    });
    actions.appendChild(copyBtn);
    actions.appendChild(retryBtn);

    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(steps);
    card.appendChild(tpl);
    // 可复制提示词：发给 AI 代配（附带在线文档链接，AI 可打开阅读）
    const prompt = document.createElement('div');
    prompt.className = 'ms-prompt';
    prompt.appendChild(document.createTextNode('也可以把下面这句发给你的 AI，让它帮你完成配置：'));
    const promptText = document.createElement('div');
    promptText.className = 'ms-prompt-text';
    promptText.textContent = '请阅读飞书配置指南（' + GUIDE_URL + '），按照文档为我安装并配置 lark-cli（含用户授权），准备消息同步脚本与读取脚本（ingestor.js / latest.js），并写入 ~/.dsh/office/feishu-config.json。';
    card.appendChild(prompt);
    card.appendChild(promptText);
    // 显式文档链接入口
    const guideLink = document.createElement('a');
    guideLink.className = 'guide-link';
    guideLink.href = GUIDE_URL;
    guideLink.target = '_blank';
    guideLink.rel = 'noopener';
    guideLink.textContent = GUIDE_LABEL;
    card.appendChild(guideLink);
    card.appendChild(actions);
    wrap.appendChild(card);
    $feishuList.appendChild(wrap);
    closeFeishuModal();
  }

  // ---------- 同步（手动深捞 / 惰性增量；异步执行 + 轮询状态） ----------
  async function syncFeishu(mode) {
    const incr = mode === 'incr';
    setStatus($feishuStatus, incr ? '增量同步中…' : '深捞同步中…（最近30天）');
    $feishuSyncBtn.disabled = true;
    try {
      const res = await apiFetch('/feishu/sync' + (incr ? '?mode=incr' : ''), { method: 'POST' });
      const json = await res.json();
      if (!json || !json.ok) {
        const code = json && json.error && json.error.code;
        if (code === 'FEISHU_CONFIG_REQUIRED') { renderFeishuGuide(); return; }
        setStatus($feishuStatus, (json && json.error && json.error.message) || '同步失败');
        $feishuSyncBtn.disabled = false;
        return;
      }
      // 轮询 /status 直到同步结束（最长 ~5 分钟）
      let attempts = 0;
      if (feishuSyncTimer) clearTimeout(feishuSyncTimer);
      function scheduleFeishuSync() {
        feishuSyncTimer = setTimeout(async () => {
          attempts++;
          try {
            const r = await apiFetch('/feishu/status', { cache: 'no-store' });
            const j = await r.json();
            const d = j && j.ok && j.data;
            if (d && !d.syncing) {
              feishuSyncTimer = null;
              $feishuSyncBtn.disabled = false;
              setStatus($feishuStatus, formatLastSync(d.lastSync) || '同步完成');
              loadFeishuMessages();
              return; // 同步完成，不再调度
            } else if (attempts > FEISHU_SYNC_MAX_POLL) {
              feishuSyncTimer = null;
              $feishuSyncBtn.disabled = false;
              setStatus($feishuStatus, '同步超时，请稍后查看');
              return; // 超时，不再调度
            }
          } catch (e) { /* 网络抖动，继续轮询 */ }
          scheduleFeishuSync(); // 仍在同步或网络异常，调度下一次
        }, POLL_INTERVAL_MS);
      }
      scheduleFeishuSync();
    } catch (e) {
      setStatus($feishuStatus, '同步失败：' + (e && e.message ? e.message : e));
      $feishuSyncBtn.disabled = false;
    }
  }

  // ---------- 飞书·洞察视图开关（左飞书消息 / 右每日洞察，合并单页） ----------
  function toggleFeishu() {
    toggleView('feishu',
      () => feishuViewOpen, (v) => { feishuViewOpen = v; },
      () => { closeFeishuModal(); feishuLazyFired = false; insightsLazyFired = false; },
      () => { loadFeishuStatus(); loadFeishuMessages(); loadInsights(false, false); }
    );
  }
  $feishuBtn.addEventListener('click', toggleFeishu);
  $feishuRefreshBtn.addEventListener('click', () => { loadFeishuStatus(); loadFeishuMessages(); });
  $feishuSyncBtn.addEventListener('click', () => syncFeishu('manual'));
  $fmClose.addEventListener('click', closeFeishuModal);
  $feishuModal.addEventListener('click', (e) => { if (e.target === $feishuModal) closeFeishuModal(); });

  // ============================================================
  // 会议视图（📅 飞书日历日程，配置驱动：feishu-config.json → scripts.calendar）
  // 数据与飞书消息共用同一套 lark-cli 授权；随消息同步顺带拉取 + 打开时惰性补拉
  // 已并入待办右栏「会议」视图（由 todos.js 调 startCalendarView/stopCalendarView）
  // ============================================================
  const $calendarStatus = document.getElementById('calendarStatus');
  const $calendarList = document.getElementById('calendarList');
  const $calendarRefreshBtn = document.getElementById('calendarRefreshBtn');
  const $calendarSyncBtn = document.getElementById('calendarSyncBtn');

  let calendarEvents = [];       // 全部日程（按开始时间升序）
  let calendarFetchedAt = '';    // 缓存拉取时间

  function calMinLeft(e) {
    if (typeof e.start_ts !== 'number' || !isFinite(e.start_ts)) return null;
    return Math.round((e.start_ts - Date.now()) / 60000);
  }

  // 卡片状态：进行中(live 绿) / 即将开始(soon 橙) / 已结束(done 灰) / 普通
  function calCardClass(e) {
    const min = calMinLeft(e);
    if (min == null) return 'done';
    const ended = typeof e.end_ts === 'number' && isFinite(e.end_ts) && e.end_ts < Date.now();
    if (ended) return 'done';
    if (min <= 0) return 'live';
    if (min <= MEETING_SOON_MINUTES) return 'soon';
    return '';
  }

  // 倒计时文案：已结束 → "已结束"；进行中 → "进行中"；即将开始 → "x分后有会议" / "x时x分后有会议"
  function calCountdown(e) {
    const min = calMinLeft(e);
    if (min == null) return '';
    const ended = typeof e.end_ts === 'number' && isFinite(e.end_ts) && e.end_ts < Date.now();
    if (ended) return '已结束';
    if (min <= 0) return '进行中';
    if (min < 60) return min + '分后有会议';
    const h = Math.floor(min / 60), m = min % 60;
    return m ? h + '时' + m + '分后有会议' : h + '时有会议';
  }

  // 日期标签：今天 · 8月17日（高亮） / 明天 · 8月18日 / 8月14日 · 周五
  function calDateLabel(dateStr) {
    const today = new Date();
    const tKey = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const tom = new Date(today); tom.setDate(tom.getDate() + 1);
    const tKey2 = tom.getFullYear() + '-' + pad(tom.getMonth() + 1) + '-' + pad(tom.getDate());
    const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
    const fmt = (d) => (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + WEEK[d.getDay()];
    if (dateStr === tKey) return '今天 · ' + fmt(today);
    if (dateStr === tKey2) return '明天 · ' + fmt(tom);
    const d = new Date(dateStr + 'T00:00:00');
    return isNaN(d.getTime()) ? dateStr : fmt(d);
  }

  // 纪要/妙记入口：有任一 token 就返回 { url, label }；否则 null
  // 优先级：AI 智能纪要文档 > 手动绑定纪要 > 妙记
  function calMinutesLink(e) {
    // 妙记优先（用户偏好妙记产物）；无妙记才退而求其次显示纪要
    if (e && e.minute_token) return { url: 'https://feishu.cn/minutes/' + e.minute_token, label: '📝 妙记' };
    if (e && e.note_doc_token) return { url: 'https://feishu.cn/docx/' + e.note_doc_token, label: '📝 纪要' };
    if (e && e.meeting_note) return { url: 'https://feishu.cn/docx/' + e.meeting_note, label: '📝 纪要' };
    return null;
  }

  function renderCalendarCards(events) {
    $calendarList.innerHTML = '';
    if (!events.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '近期没有会议日程';
      $calendarList.appendChild(empty);
      return;
    }
    const now = Date.now();
    const isEnded = (e) => typeof e.end_ts === 'number' && isFinite(e.end_ts) && e.end_ts < now;
    const upcoming = events.filter((e) => !isEnded(e)).sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
    const past = events.filter(isEnded).sort((a, b) => (b.end_ts || 0) - (a.end_ts || 0));

    // 纯卡片流：未开始（含进行中）在前、已结束在后，靠卡片状态色区分（绿=进行中/橙=即将/灰=已结束），无标题栏
    for (const e of upcoming) $calendarList.appendChild(buildCalCard(e));
    for (const e of past) $calendarList.appendChild(buildCalCard(e));
  }

  function buildCalCard(e) {
    const card = document.createElement('div');
    card.className = 'cal-card ' + calCardClass(e);
    card.dataset.id = e.event_id || '';

    // 左栏：日期（今天/明天/具体日期）+ 开始时间（大字）+ 结束时间（小字灰）
    const timeCol = document.createElement('div');
    timeCol.className = 'cal-time';
    const date = document.createElement('span');
    date.className = 'ct-date';
    const dayKey = (e.start || '').slice(0, 10);
    const dLabel = calDateLabel(dayKey);
    date.textContent = dLabel === '今天' || dLabel === '明天' ? dLabel : (e.start || '').slice(5, 10);
    const start = document.createElement('span');
    start.className = 'ct-start';
    start.textContent = ((e.start || '').slice(11) || '');
    const end = document.createElement('span');
    end.className = 'ct-end';
    end.textContent = ((e.end || '').slice(11) ? '至 ' + (e.end || '').slice(11) : '');
    timeCol.appendChild(date);
    timeCol.appendChild(start);
    timeCol.appendChild(end);
    card.appendChild(timeCol);

    // 中栏：标题 + meta（组织者 · 状态 · 类型）+ 📝 纪要
    const main = document.createElement('div');
    main.className = 'cal-main';
    const title = document.createElement('div');
    title.className = 'cal-title';
    title.textContent = e.summary || '（无标题）';
    main.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'cal-meta';
    const bits = [];
    if (e.organizer) bits.push('组织者：' + e.organizer);
    if (e.rsvp === 'needs_action') bits.push('待确认');
    else if (e.rsvp === 'accept') bits.push('已接受');
    if (e.busy === 'busy') bits.push('忙碌');
    meta.textContent = bits.join(' · ');
    main.appendChild(meta);
    const actions = buildCalActions(e);
    if (actions) main.appendChild(actions);
    card.appendChild(main);

    // 右栏：倒计时徽标
    const right = document.createElement('div');
    right.className = 'cal-right';
    const cd = document.createElement('span');
    cd.className = 'ct-countdown';
    cd.textContent = calCountdown(e);
    if (cd.textContent) right.appendChild(cd);
    card.appendChild(right);

    return card;
  }

  // ---------- 逐字稿状态行（✅ 已生成+保存 / 已保存 / 拉取中 / 失败重试） ----------
  function trBadge(text, cls) {
    const el = document.createElement('span');
    el.className = 'cal-tr-badge' + (cls ? ' ' + cls : '');
    el.textContent = text;
    return el;
  }

  function trBtn(text, onClick) {
    const el = document.createElement('button');
    el.className = 'cal-tr-btn';
    el.textContent = text;
    el.addEventListener('click', onClick);
    return el;
  }

  // 操作行：📝 妙记/纪要链接 + 转逐字稿 + 逐字稿状态，统一排进单个 .cal-actions 行（不随意换行）
  function buildCalActions(e) {
    const row = document.createElement('div');
    row.className = 'cal-actions';
    const ml = calMinutesLink(e);
    if (ml) {
      const link = document.createElement('a');
      link.className = 'cal-minutes';
      link.textContent = ml.label;
      link.href = ml.url;
      link.target = '_blank';
      link.rel = 'noopener';
      row.appendChild(link);
    }
    const conv = buildConvertBtn(e);
    if (conv) row.appendChild(conv);
    for (const el of buildTranscriptStatus(e)) row.appendChild(el);
    return row.children.length ? row : null;
  }

  // 转逐字稿按钮：有妙记且未生成（无状态或 failed 重试）时显示；done/saved/pending/new 不显示
  function buildConvertBtn(e) {
    if (!e || !e.minute_token) return null;
    const st = e.transcript;
    if (st && (st.status === 'done' || st.status === 'saved' || st.status === 'pending' || st.status === 'new')) return null;
    return trBtn('转逐字稿', () => convertTranscript(e.event_id));
  }

  // 状态元素：done（已生成+保存）/ saved / failed（附申请权限）/ pending / new
  // 返回元素数组，由 buildCalActions 统一排入操作行
  function buildTranscriptStatus(e) {
    const tr = e && e.transcript;
    if (!tr || !tr.status) return [];
    const els = [];
    if (tr.status === 'done') {
      els.push(trBadge('✅ 逐字稿已生成', 'done'));
      els.push(trBtn('保存', () => openSaveDialog(e)));
    } else if (tr.status === 'saved') {
      els.push(trBadge('✅ 已保存', 'done'));
      // 保存地址不固定回显：小问号悬停展示，可移入选中复制
      const hint = document.createElement('span');
      hint.className = 'cal-tr-hint';
      hint.textContent = '?';
      const tip = document.createElement('span');
      tip.className = 'cal-tr-tip';
      tip.textContent = tr.savedTo || '';
      hint.appendChild(tip);
      // 显隐由 JS 控制：hint 悬停显示；移出延迟隐藏（覆盖 6px 间隙），tip 自身悬停取消隐藏
      let tipHideTimer = null;
      const showTip = () => {
        if (tipHideTimer) { clearTimeout(tipHideTimer); tipHideTimer = null; }
        hint.classList.add('show');
      };
      const hideTip = () => {
        if (tipHideTimer) clearTimeout(tipHideTimer);
        tipHideTimer = setTimeout(() => hint.classList.remove('show'), 200);
      };
      hint.addEventListener('mouseenter', showTip);
      hint.addEventListener('mouseleave', hideTip);
      tip.addEventListener('mouseenter', showTip);
      tip.addEventListener('mouseleave', hideTip);
      els.push(hint);
    } else if (tr.status === 'failed') {
      // 失败原因由 toast 一次性提示，卡片不常驻失败文案；无权限时保留申请入口
      if (tr.errorCode === 'NO_PERMISSION') {
        const applyBtn = trBtn('申请权限', async () => {
          applyBtn.disabled = true;
          const r = await applyPermission(e.event_id);
          toast(r.ok ? '已向妙记 owner 发出查看申请' : ('申请失败：' + friendlyLarkError(r.message || '请稍后重试')));
          applyBtn.disabled = false;
        });
        els.push(applyBtn);
      }
    } else if (tr.status === 'pending') {
      els.push(trBadge('⏳ 逐字稿拉取中…'));
    } else if (tr.status === 'new') {
      els.push(trBadge('📥 新妙记，自动拉取中'));
    }
    return els;
  }

  // ---------- 保存对话框（目标目录输入，记忆上次目录） ----------
  let saveEventId = null;

  function openSaveDialog(e) {
    saveEventId = e.event_id;
    $saveError.textContent = '';
    $saveDir.value = localStorage.getItem('office.lastSaveDir') || '';
    $saveModal.hidden = false;
    $saveDir.focus();
  }

  function closeSaveDialog() {
    $saveModal.hidden = true;
    saveEventId = null;
  }

  async function confirmSaveTranscript() {
    const dir = $saveDir.value.trim();
    if (!dir) { $saveError.textContent = '请填写目标目录'; return; }
    $saveConfirmBtn.disabled = true;
    try {
      const res = await apiFetch('/transcript/save', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ event_id: saveEventId, target_dir: dir })
      });
      const json = await res.json();
      if (json && json.ok) {
        localStorage.setItem('office.lastSaveDir', dir);
        closeSaveDialog();
        loadCalendarEvents();
      } else {
        $saveError.textContent = (json && json.error && json.error.message) || '保存失败';
      }
    } catch (err) {
      $saveError.textContent = '保存失败：' + (err && err.message ? err.message : err);
    } finally {
      $saveConfirmBtn.disabled = false;
    }
  }

  // 逐字稿保存对话框（DOM ref + 事件绑定；原与邮箱同区块，因依赖 closeSaveDialog/confirmSaveTranscript 拆至此）
  const $saveModal = document.getElementById('saveModal');
  const $saveDir = document.getElementById('saveDir');
  const $saveError = document.getElementById('saveError');
  const $saveConfirmBtn = document.getElementById('saveConfirmBtn');
  const $saveClose = document.getElementById('saveClose');
  $saveClose.addEventListener('click', closeSaveDialog);
  $saveConfirmBtn.addEventListener('click', confirmSaveTranscript);
  $saveModal.addEventListener('click', (e) => { if (e.target === $saveModal) closeSaveDialog(); });

  // lark-cli 常见英文错误 → 中文提示（其余原样透传，不猜不编）
  function friendlyLarkError(msg) {
    if (!msg) return '未知错误';
    if (/too frequently/i.test(msg)) return '申请太频繁，请稍后再试';
    if (/permission/i.test(msg)) return '无妙记查看权限';
    return msg;
  }

  async function convertTranscript(eventId) {
    try {
      const res = await apiFetch('/transcript/fetch', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ event_id: eventId })
      });
      const json = await res.json();
      if (json && json.ok) {
        toast('✅ 逐字稿已生成');
      } else {
        toast('逐字稿拉取失败：' + friendlyLarkError(json && json.error && json.error.message));
      }
      loadCalendarEvents();
    } catch (err) {
      toast('逐字稿拉取失败：' + (err && err.message ? err.message : err));
    }
  }

  // 申请妙记查看权限：返回 { ok, message }，message 透传后端真实错误（等待 owner 批准）
  async function applyPermission(eventId) {
    try {
      const res = await apiFetch('/transcript/apply-permission', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ event_id: eventId })
      });
      const json = await res.json();
      if (json && json.ok) return { ok: true, message: '' };
      return { ok: false, message: (json && json.error && json.error.message) || '未知错误' };
    } catch (err) {
      return { ok: false, message: (err && err.message ? err.message : err) || '网络异常' };
    }
  }

  function renderCalendarGuide() {
    $calendarList.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'calendar-setup';
    const card = document.createElement('div');
    card.className = 'calendar-setup-card';
    const h = document.createElement('h3');
    h.textContent = '📅 日程未配置';
    const p1 = document.createElement('div');
    p1.className = 'cs-step';
    p1.textContent = '会议日程与飞书消息共用同一套 lark-cli 授权与配置（feishu-config.json），只是脚本不同。配置一次，两个功能都能用。';
    const guideLink = document.createElement('a');
    guideLink.className = 'guide-link';
    guideLink.href = GUIDE_URL;
    guideLink.target = '_blank';
    guideLink.rel = 'noopener';
    guideLink.textContent = GUIDE_LABEL;
    const p2 = document.createElement('div');
    p2.className = 'cs-step';
    p2.textContent = '1. 安装并授权 lark-cli（用户身份，需 calendar / vc / minutes scope）';
    const p3 = document.createElement('div');
    p3.className = 'cs-step';
    p3.textContent = '2. 准备日历脚本（仓库 scripts/calendar.js 是开箱示例，含妙记/纪要链路）';
    const p4 = document.createElement('div');
    p4.className = 'cs-step';
    p4.textContent = '3. 在 ~/.dsh/office/feishu-config.json 的 scripts 里加一行：';
    const code2 = document.createElement('code');
    code2.textContent = '"calendar": "<你的calendar.js绝对路径>"';
    const p5 = document.createElement('div');
    p5.className = 'cs-step';
    p5.textContent = '4. 刷新页面，点右上角「同步」即可拉取日程。';
    // 可复制提示词：发给 AI 代配（附带在线文档链接，AI 可打开阅读）
    const prompt = document.createElement('div');
    prompt.className = 'cs-step';
    prompt.textContent = '也可以把下面这句发给你的 AI，让它帮你完成配置：';
    const promptText = document.createElement('code');
    promptText.textContent = '请阅读飞书配置指南（' + GUIDE_URL + '），按照文档为我安装并配置 lark-cli（含用户授权，scope 需含 calendar / vc / minutes），准备 calendar.js 脚本并写入 ~/.dsh/office/feishu-config.json 的 scripts.calendar。';
    card.appendChild(h); card.appendChild(p1); card.appendChild(guideLink); card.appendChild(p2);
    card.appendChild(p3); card.appendChild(p4); card.appendChild(code2); card.appendChild(p5);
    card.appendChild(prompt); card.appendChild(promptText);
    wrap.appendChild(card);
    $calendarList.appendChild(wrap);
  }

  async function loadCalendarStatus() {
    try {
      const res = await apiFetch('/calendar/status', { cache: 'no-store' });
      const json = await res.json();
      if (!json || !json.ok || !json.data) { setStatus($calendarStatus, TEXT_STATUS_ERROR); return; }
      const d = json.data;
      if (!d.configured) { renderCalendarGuide(); return; }
      $calendarSyncBtn.disabled = false;
      let base = d.syncing ? TEXT_SYNCING : (d.fetchedAt ? '上次同步 ' + d.fetchedAt + (d.total ? ' · ' + d.total + ' 条' : '') : '尚未同步');
      if (d.stale && !d.syncing) base += ' · 数据已过期';
      setStatus($calendarStatus, base);
    } catch (e) {
      setStatus($calendarStatus, TEXT_STATUS_ERROR);
    }
  }

  async function loadCalendarEvents() {
    try {
      const res = await apiFetch('/calendar/events', { cache: 'no-store' });
      const json = await res.json();
      if (!json || !json.ok) {
        const code = json && json.error && json.error.code;
        if (code === 'CALENDAR_CONFIG_REQUIRED') { renderCalendarGuide(); return; }
        setStatus($calendarStatus, (json && json.error && json.error.message) || TEXT_READ_ERROR);
        return;
      }
      calendarEvents = (json.data && json.data.events) || [];
      calendarFetchedAt = (json.data && json.data.fetchedAt) || '';
      renderCalendarCards(calendarEvents);
      loadCalendarStatus();
    } catch (e) {
      setStatus($calendarStatus, TEXT_READ_ERROR + '：' + (e && e.message ? e.message : e));
    }
  }

  async function syncCalendarManual() {
    $calendarSyncBtn.disabled = true;
    $calendarSyncBtn.textContent = TEXT_SYNCING;
    setStatus($calendarStatus, TEXT_SYNCING);
    try {
      const res = await apiFetch('/calendar/sync', { cache: 'no-store', method: 'POST' });
      const json = await res.json();
      if (json && json.ok) {
        setStatus($calendarStatus, '同步完成' + (json.data && json.data.total != null ? ' · ' + json.data.total + ' 条' : ''));
        loadCalendarEvents();
      } else {
        setStatus($calendarStatus, (json && json.error && json.error.message) || '同步失败');
        $calendarSyncBtn.disabled = false;
      }
    } catch (e) {
      setStatus($calendarStatus, '同步失败：' + (e && e.message ? e.message : e));
      $calendarSyncBtn.disabled = false;
    } finally {
      $calendarSyncBtn.textContent = '同步';
    }
  }

  // ---------- 会议视图钩子（嵌入待办右栏，由 todos.js 的「会议」视图调用） ----------
  let calendarTimer = null;
  function startCalendarView() {
    loadCalendarStatus();
    loadCalendarEvents();
    if (calendarTimer) clearInterval(calendarTimer);
    calendarTimer = setInterval(() => {
      document.querySelectorAll('.cal-card[data-id]').forEach(function(card) {
        var eventId = card.dataset.id;
        var evt = calendarEvents.find(function(ev) { return ev.event_id === eventId; });
        if (!evt) return;
        var cdEl = card.querySelector('.ct-countdown');
        if (!cdEl) return;
        cdEl.textContent = calCountdown(evt);
      });
    }, CALENDAR_COUNTDOWN_MS);
  }
  function stopCalendarView() {
    if (calendarTimer) { clearInterval(calendarTimer); calendarTimer = null; }
  }
  $calendarRefreshBtn.addEventListener('click', () => { loadCalendarStatus(); loadCalendarEvents(); });
  $calendarSyncBtn.addEventListener('click', () => syncCalendarManual());

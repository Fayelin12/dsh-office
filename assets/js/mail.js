  // ============================================================
  // 邮箱视图（Agent Mail / agently-cli）
  // ============================================================
  const $mailBtn = document.getElementById('mailBtn');
  const $mailView = document.getElementById('mailView');
  const $mailIdentity = document.getElementById('mailIdentity');
  const $mailFolders = document.getElementById('mailFolders');
  const $mailList = document.getElementById('mailList');
  const $mailRead = document.getElementById('mailRead');
  const $mailStatus = document.getElementById('mailStatus');
  const $mailRefreshBtn = document.getElementById('mailRefreshBtn');
  const $mailComposeBtn = document.getElementById('mailComposeBtn');

  let mailViewOpen = false;
  let mailDir = 'inbox';
  let mailCursor = '';
  let mailHasMore = false;
  let mailLoading = false;
  let composeMode = 'send';   // send | reply
  let composeReplyId = '';
  const MAIL_LIMIT = 20;

  function mailTime(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    const diff = Date.now() - t.getTime();
    return relativeTime(diff, () => t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes()));
  }
  function mailFromName(m) {
    if (!m) return '';
    const from = m.from || {};
    return from.name || from.email || '';
  }

  // ---------- 未配置邮箱：安装/授权引导卡片 ----------
  let mailSetupRequired = false;   // true 时禁用写邮件按钮
  function renderMailSetup(setup, authOnly) {
    mailSetupRequired = true;
    $mailComposeBtn.disabled = true;
    $mailList.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'mail-setup';
    const card = document.createElement('div');
    card.className = 'mail-setup-card';

    const title = document.createElement('div');
    title.className = 'ms-title';
    title.textContent = authOnly ? '📧 邮箱未授权' : '📧 需要先安装 Agent Mail CLI';

    const steps = document.createElement('ol');
    steps.className = 'ms-steps';
    steps.appendChild(mkStep('安装 CLI：<code>npm install -g @tencent-qqmail/agently-cli</code>'));
    steps.appendChild(mkStep('授权：<code>agently-cli auth login</code>（浏览器完成授权）'));
    steps.appendChild(mkStep('重启 dsh web，然后点「重新检测」'));

    const prompt = document.createElement('div');
    prompt.className = 'ms-prompt';
    prompt.appendChild(document.createTextNode('也可以把下面这句发给你的 Agent，让它代为安装配置：'));
    const promptText = document.createElement('div');
    promptText.className = 'ms-prompt-text';
    promptText.textContent = (setup && setup.prompt) || '请阅读 https://agent.qq.com/doc/cli-setup.md 文档，按照步骤为我安装并配置 Agent Mail CLI。';
    prompt.appendChild(promptText);

    const actions = document.createElement('div');
    actions.className = 'ms-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn';
    copyBtn.textContent = '复制提示语';
    copyBtn.addEventListener('click', () => {
      copyToClipboard(promptText.textContent,
        () => setStatus($mailStatus, TEXT_COPY_OK),
        () => setStatus($mailStatus, TEXT_COPY_FAIL));
    });
    const retryBtn = document.createElement('button');
    retryBtn.className = 'icon-btn';
    retryBtn.textContent = TEXT_RETRY;
    retryBtn.addEventListener('click', () => {
      setStatus($mailStatus, '检测中…');
      loadMailIdentity();
      loadMailList(mailDir, '', false);
    });
    actions.appendChild(copyBtn);
    actions.appendChild(retryBtn);

    card.appendChild(title);
    card.appendChild(steps);
    card.appendChild(prompt);
    card.appendChild(actions);
    wrap.appendChild(card);
    $mailList.appendChild(wrap);

    // 读信区清空为引导提示
    $mailRead.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'mail-read-empty';
    empty.textContent = authOnly ? '请先完成邮箱授权' : '请先安装 Agent Mail CLI';
    $mailRead.appendChild(empty);
  }

  function hideMailSetup() {
    if (!mailSetupRequired) return;
    mailSetupRequired = false;
    $mailComposeBtn.disabled = false;
  }

  async function loadMailIdentity() {
    try {
      const res = await apiFetch('/mail/me', { cache: 'no-store' });
      const json = await res.json();
      if (json && json.ok && json.data && json.data.email) {
        $mailIdentity.textContent = '📧 ' + json.data.email;
        hideMailSetup();
      } else if (json && !json.ok) {
        const code = json.error && json.error.code;
        if (code === 'MAIL_CLI_REQUIRED' || code === 'MAIL_AUTH_REQUIRED') {
          $mailIdentity.textContent = '📧 未配置邮箱';
          setStatus($mailStatus, '');
          renderMailSetup(json.error && json.error.setup, code === 'MAIL_AUTH_REQUIRED');
          return;
        }
        if (code === 3) $mailIdentity.textContent = '📧 未授权';
        else if (code === 1 || code === 4) $mailIdentity.textContent = '📧 服务暂不可用';
        else $mailIdentity.textContent = '📧 ' + (json.error && json.error.message || TEXT_LOAD_ERROR);
        setStatus($mailStatus, (json.error && json.error.message) || '授权异常');
        return;
      } else {
        $mailIdentity.textContent = '📧 未授权';
      }
    } catch (e) {
      console.error('[office][mail] loadMailIdentity failed:', e);
      $mailIdentity.textContent = '📧 连接失败';
    }
  }

  function appendMailItems(items) {
    for (const m of items || []) {
      const item = document.createElement('div');
      item.className = 'mail-item' + (m.is_read ? ' read' : '');
      item.dataset.id = m.message_id || '';

      const head = document.createElement('div');
      head.className = 'm-head';
      const dot = document.createElement('span');
      dot.className = 'm-dot';
      const from = document.createElement('span');
      from.className = 'm-from';
      from.textContent = mailFromName(m) || ((m.from && m.from.email) || '未知发件人');
      from.title = (m.from && m.from.email) || '';
      const time = document.createElement('span');
      time.className = 'm-time';
      time.textContent = mailTime(m.created_at);
      head.appendChild(dot); head.appendChild(from); head.appendChild(time);

      const subject = document.createElement('div');
      subject.className = 'm-subject';
      subject.textContent = (m.has_attachments ? '📎 ' : '') + (m.subject || TEXT_NO_SUBJECT);

      const snippet = document.createElement('div');
      snippet.className = 'm-snippet';
      snippet.textContent = m.snippet || '';

      item.appendChild(head); item.appendChild(subject); item.appendChild(snippet);
      item.addEventListener('click', () => openMail(item.dataset.id, item));
      $mailList.appendChild(item);
    }
    if (!$mailList.querySelector('.mail-load-more')) {
      const more = document.createElement('button');
      more.className = 'mail-load-more';
      more.textContent = '加载更多';
      more.addEventListener('click', () => loadMailList(mailDir, mailCursor, true));
      $mailList.appendChild(more);
    }
  }

  async function loadMailList(dir, cursor, append) {
    if (mailLoading) return;
    mailLoading = true;
    setStatus($mailStatus, TEXT_LOADING);
    try {
      const params = new URLSearchParams({ dir: dir || mailDir, limit: String(MAIL_LIMIT) });
      if (cursor) params.set('cursor', cursor);
      const res = await apiFetch('/mail/list?' + params.toString(), { cache: 'no-store' });
      const json = await res.json();
      if (!json || !json.ok) {
        const code = json && json.error && json.error.code;
        if (code === 'MAIL_CLI_REQUIRED' || code === 'MAIL_AUTH_REQUIRED') {
          setStatus($mailStatus, '');
          renderMailSetup(json.error && json.error.setup, code === 'MAIL_AUTH_REQUIRED');
          return;
        }
        const errMsg = (json && json.error && json.error.message) || TEXT_LOAD_ERROR;
        setStatus($mailStatus, errMsg);
        console.warn('[office][mail] mail list error:', errMsg);
        return;
      }
      const items = (json.data && json.data.data) || [];
      const pagination = (json.data && json.data.pagination) || {};
      if (!append) $mailList.innerHTML = '';
      appendMailItems(items);
      mailCursor = pagination.next_cursor || '';
      mailHasMore = !!pagination.has_more;
      const moreBtn = $mailList.querySelector('.mail-load-more');
      if (moreBtn) moreBtn.hidden = !mailHasMore;
      setStatus($mailStatus, '');
    } catch (e) {
      console.error('[office][mail] loadMailList failed:', e);
      setStatus($mailStatus, TEXT_LOAD_ERROR + '：' + (e && e.message ? e.message : e));
    } finally {
      mailLoading = false;
    }
  }

  async function openMail(id, itemEl) {
    if (!id) return;
    $mailList.querySelectorAll('.mail-item.active').forEach((el) => el.classList.remove('active'));
    if (itemEl) itemEl.classList.add('active');
    $mailRead.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'mail-read-empty';
    loading.textContent = TEXT_LOADING;
    $mailRead.appendChild(loading);
    try {
      const res = await apiFetch('/mail/read?id=' + encodeURIComponent(id), { cache: 'no-store' });
      const json = await res.json();
      if (!json || !json.ok || !json.data) {
        $mailRead.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'mail-read-empty';
        err.textContent = (json && json.error && json.error.message) || TEXT_READ_ERROR;
        $mailRead.appendChild(err);
        return;
      }
      const d = json.data;

      const head = document.createElement('div');
      head.className = 'mail-read-head';
      const subj = document.createElement('div');
      subj.className = 'mail-read-subject';
      subj.textContent = d.subject || TEXT_NO_SUBJECT;
      const meta = document.createElement('div');
      meta.className = 'mail-read-meta';
      const from = (d.from && (d.from.name ? d.from.name + ' <' + d.from.email + '>' : d.from.email)) || '';
      const to = (d.to || []).map((t) => t.email || '').filter(Boolean).join(', ');
      let metaText = '发件人：' + from + '\n时间：' + mailTime(d.created_at);
      if (to) metaText += '\n收件人：' + to;
      const attNames = (d.attachments || []).map((a) => a.filename || a.attachment_id || '').filter(Boolean).join('、');
      if (attNames) metaText += '\n附件：' + attNames;
      meta.textContent = metaText;
      head.appendChild(subj); head.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'mail-read-actions';
      const replyBtn = document.createElement('button');
      replyBtn.className = 'icon-btn';
      replyBtn.textContent = '↩ 回复';
      replyBtn.style.width = 'auto';
      replyBtn.style.padding = '0 14px';
      replyBtn.style.fontSize = '12px';
      replyBtn.addEventListener('click', () => openCompose('reply', id, d.from && d.from.email));
      actions.appendChild(replyBtn);

      // 邮件正文是不可信外部输入：用 sandbox 无脚本 iframe 渲染（srcdoc 继承 CSP，sandbox 再兜一层）
      const bodyFrame = document.createElement('iframe');
      bodyFrame.className = 'mail-read-body';
      bodyFrame.sandbox = '';
      // 深色阅读：父页面 CSS 无法穿透 sandbox iframe，改为在邮件文档内注入反色样式；
      // 图片用双重反色抵消保持原色。不依赖邮件自身的 prefers-color-scheme（对声明
      // color-scheme: light only 的邮件同样生效）。
      let emailHtml = d.body || '<p>' + TEXT_NO_BODY + '</p>';
      // 清理危险标签（防止 sandbox 逃逸）
      emailHtml = emailHtml.replace(/<meta\s[^>]*http-equiv[^>]*>/gi, '');
      emailHtml = emailHtml.replace(/<base\s[^>]*>/gi, '');
      emailHtml = emailHtml.replace(/<link\s[^>]*>/gi, '');
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        const darkStyle = '<style>html{filter:invert(' + DARK_INVERT_STRENGTH + ') hue-rotate(180deg)}img,picture,video{filter:invert(' + DARK_INVERT_STRENGTH + ') hue-rotate(180deg)}</style>';
        const headMatch = emailHtml.match(/<head[^>]*>/i);
        const doctypeMatch = emailHtml.match(/^\s*<!doctype[^>]*>/i);
        if (headMatch) {
          emailHtml = emailHtml.slice(0, headMatch.index + headMatch[0].length) + darkStyle + emailHtml.slice(headMatch.index + headMatch[0].length);
        } else if (doctypeMatch) {
          emailHtml = emailHtml.slice(0, doctypeMatch.index + doctypeMatch[0].length) + darkStyle + emailHtml.slice(doctypeMatch.index + doctypeMatch[0].length);
        } else {
          emailHtml = darkStyle + emailHtml;
        }
      }
      bodyFrame.srcdoc = emailHtml;

      $mailRead.innerHTML = '';
      $mailRead.appendChild(head);
      $mailRead.appendChild(bodyFrame);
      $mailRead.appendChild(actions);
      if (itemEl) itemEl.classList.add('read');
    } catch (e) {
      console.error('[office][mail] openMail failed:', e);
      $mailRead.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'mail-read-empty';
      err.textContent = TEXT_READ_ERROR + ': ' + (e && e.message || e);
      $mailRead.appendChild(err);
    }
  }

  // ---------- 写信 / 回复 ----------
  const $composeModal = document.getElementById('composeModal');
  const $composeClose = document.getElementById('composeClose');
  const $composeHead = document.getElementById('composeHead');
  const $composeTo = document.getElementById('composeTo');
  const $composeSubject = document.getElementById('composeSubject');
  const $composeBody = document.getElementById('composeBody');
  const $composeSendBtn = document.getElementById('composeSendBtn');
  const $composeError = document.getElementById('composeError');
  const $composePreview = document.getElementById('composePreview');
  const $composePreviewBtn = document.getElementById('composePreviewBtn');
  let composePreviewOpen = false;

  function openCompose(mode, id, replyTo) {
    composeMode = mode || 'send';
    composeReplyId = id || '';
    $composeTo.value = replyTo || '';
    $composeSubject.value = '';
    $composeBody.value = '';
    $composeError.textContent = '';
    $composeHead.textContent = composeMode === 'reply' ? '↩ 回复邮件' : '✎ 写邮件';
    $composeTo.hidden = composeMode === 'reply';
    $composeModal.hidden = false;
    setComposePreview(false);
    if (composeMode === 'reply') $composeBody.focus();
    else $composeTo.focus();
  }
  function closeCompose() {
    $composeModal.hidden = true;
  }
  $composeClose.addEventListener('click', closeCompose);
  $composeModal.addEventListener('click', (e) => { if (e.target === $composeModal) closeCompose(); });

  // 写邮件 HTML 预览：切换到预览时直接渲染当前正文（用户自行输入的 HTML，信任其内容，仅本人可见）
  function setComposePreview(open) {
    composePreviewOpen = open;
    $composeBody.hidden = open;
    $composePreview.hidden = !open;
    $composePreviewBtn.textContent = open ? '✎ 编辑' : '👁 预览';
    $composePreviewBtn.title = open ? '返回编辑' : '预览 HTML 效果';
    if (open) $composePreview.innerHTML = $composeBody.value;
  }
  $composePreviewBtn.addEventListener('click', () => setComposePreview(!composePreviewOpen));

  async function submitMail() {
    $composeSendBtn.disabled = true;
    $composeError.textContent = '';
    try {
      const payload = composeMode === 'reply'
        ? { id: composeReplyId, body: $composeBody.value }
        : {
            to: $composeTo.value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean),
            subject: $composeSubject.value,
            body: $composeBody.value
          };
      const res = await apiFetch('/mail/' + (composeMode === 'reply' ? 'reply' : 'send'), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (json && json.ok) {
        closeCompose();
        setStatus($mailStatus, '已发送 ✓');
        loadMailList(mailDir, '', false);
      } else {
        $composeError.textContent = (json && json.error && json.error.message) || '发送失败';
      }
    } catch (e) {
      console.error('[office][mail] submitMail failed:', e);
      $composeError.textContent = '发送失败：' + (e && e.message ? e.message : e);
    } finally {
      $composeSendBtn.disabled = false;
    }
  }
  $composeSendBtn.addEventListener('click', submitMail);

  // ---------- 邮箱视图开关 ----------
  function toggleMail() {
    toggleView('mail',
      () => mailViewOpen, (v) => { mailViewOpen = v; },
      () => { mailDir = 'inbox'; mailCursor = ''; mailHasMore = false; },
      () => { loadMailIdentity(); loadMailList('inbox', '', false); }
    );
  }
  $mailBtn.addEventListener('click', toggleMail);
  $mailRefreshBtn.addEventListener('click', () => loadMailList(mailDir, '', false));
  $mailComposeBtn.addEventListener('click', () => openCompose('send'));
  $mailFolders.addEventListener('click', (e) => {
    const btn = e.target.closest('.mail-folder');
    if (!btn || btn.dataset.dir === mailDir) return;
    mailDir = btn.dataset.dir;
    $mailFolders.querySelectorAll('.mail-folder').forEach((b) => b.classList.toggle('active', b === btn));
    mailCursor = '';
    loadMailList(mailDir, '', false);
  });


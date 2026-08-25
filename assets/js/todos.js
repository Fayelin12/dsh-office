  // ============ 📝 每日待办面板（会议视图左列，独立日期） ============
  function todoPrioClass(p) { return p === '高' ? 'high' : (p === '低' ? 'low' : 'mid'); }
  function nextTodoPriority(p) { return p === '高' ? '中' : (p === '中' ? '低' : '高'); }

  async function loadTodos() {
    if (!todoDate) { todoDate = todayStr(); syncTodoDateUI(); }
    const date = todoDate;
    try {
      const res = await apiFetch('/todos/list?date=' + encodeURIComponent(date), { cache: 'no-store' });
      const j = await res.json();
      todos = (j && j.ok && j.data && Array.isArray(j.data.items)) ? j.data.items : [];
    } catch (_) { todos = []; }
    todoLoadedDate = date;
    renderTodos();
  }

  function renderTodos() {
    $todoCount.textContent = String(todos.length);
    $todoList.innerHTML = '';
    if (todos.length === 0) {
      $todoList.appendChild(el('div', 'todo-empty', '这一天还没有待办'));
      return;
    }
    // 未完成在前，已完成沉底；组内按创建顺序
    const open = todos.filter((t) => !t.done);
    const done = todos.filter((t) => t.done);
    for (const t of open.concat(done)) {
      $todoList.appendChild(makeTodoItem(t));
    }
  }

  function makeTodoItem(t) {
    const row = el('div', 'todo-item' + (t.done ? ' done' : ''));
    row.dataset.id = t.id;

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'todo-check';
    chk.checked = !!t.done;
    chk.title = t.done ? '标记为未完成' : '标记为完成';
    row.appendChild(chk);

    const prio = el('span', 'todo-prio ' + todoPrioClass(t.priority), '[' + (t.priority || '中') + ']');
    prio.title = '优先级（点击切换 高→中→低）';
    row.appendChild(prio);

    const text = el('span', 'todo-text', t.text);
    row.appendChild(text);

    if (!t.done) {
      const moveBtn = el('button', 'icon-btn todo-move', '→ 明天');
      moveBtn.title = '顺延到下一天';
      row.appendChild(moveBtn);
    }

    const editBtn = el('button', 'icon-btn todo-edit', '✎');
    editBtn.title = '编辑';
    row.appendChild(editBtn);

    const delBtn = el('button', 'icon-btn todo-del', '🗑');
    delBtn.title = '删除';
    row.appendChild(delBtn);

    return row;
  }

  async function todoAdd() {
    const text = $todoInput.value.trim();
    if (!text) { $todoInput.focus(); return; }
    try {
      const res = await apiFetch('/todos/add', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ date: todoDate || todayStr(), text })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '添加失败');
      $todoInput.value = '';
      loadTodos();
    } catch (err) {
      toast('添加待办失败：' + (err && err.message ? err.message : err));
    }
  }

  async function todoUpdate(id, patch) {
    try {
      const res = await apiFetch('/todos/update', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ date: todoDate || todayStr(), id, patch })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '更新失败');
      loadTodos();
    } catch (err) {
      toast('更新待办失败：' + (err && err.message ? err.message : err));
    }
  }

  async function todoRemove(id) {
    try {
      const res = await apiFetch('/todos/remove', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ date: todoDate || todayStr(), id })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '删除失败');
      loadTodos();
    } catch (err) {
      toast('删除待办失败：' + (err && err.message ? err.message : err));
    }
  }

  // 改到下一天：把该条待办移到当前查看日期的次日（保留原状态）
  async function todoMove(id) {
    const toDate = shiftDate(todoDate || todayStr(), 1);
    try {
      const res = await apiFetch('/todos/move', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ date: todoDate || todayStr(), id, toDate })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '改期失败');
      toast('已改到 ' + toDate);
      loadTodos();
    } catch (err) {
      toast('改期失败：' + (err && err.message ? err.message : err));
    }
  }

  function todoEditInline(id) {
    const row = $todoList.querySelector('.todo-item[data-id="' + id + '"]');
    if (!row) return;
    const textEl = row.querySelector('.todo-text');
    if (!textEl) return;
    const cur = textEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'todo-edit-input';
    input.value = cur;
    input.maxLength = 500;
    textEl.replaceWith(input);
    input.focus();
    let finished = false;
    const commit = () => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      if (v && v !== cur) todoUpdate(id, { text: v });
      else loadTodos();
    };
    const cancel = () => {
      if (finished) return;
      finished = true;
      loadTodos();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }

  $todoAddBtn.addEventListener('click', todoAdd);
  $todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); todoAdd(); }
  });
  $todoList.addEventListener('click', (e) => {
    const row = e.target.closest('.todo-item');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.classList.contains('todo-check')) {
      todoUpdate(id, { done: e.target.checked });
    } else if (e.target.classList.contains('todo-prio')) {
      const t = todos.find((x) => x.id === id);
      if (t) todoUpdate(id, { priority: nextTodoPriority(t.priority) });
    } else if (e.target.closest('.todo-edit')) {
      todoEditInline(id);
    } else if (e.target.closest('.todo-del')) {
      showConfirm('删除这条待办？', '删除后不可恢复。', () => todoRemove(id));
    } else if (e.target.closest('.todo-move')) {
      todoMove(id);
    }
  });

  function toggleInsights() {
    toggleView('insights',
      () => insightsViewOpen, (v) => { insightsViewOpen = v; },
      () => { insightsLazyFired = false; },
      () => { loadInsights(false, false); }
    );
  }
  $insightsBtn.addEventListener('click', toggleInsights);
  $insightsRefreshBtn.addEventListener('click', () => loadInsights(true, true));
  $insightsGenBtn.addEventListener('click', () => insightsGenerate());

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




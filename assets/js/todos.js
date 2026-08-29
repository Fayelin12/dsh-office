  // ============ 📋 待办看板（独立视图）+ 📝 每日待办（会议视图左列） ============

  // ---------- 工具 ----------
  function todoPrioClass(p) { return p === '高' ? 'high' : (p === '低' ? 'low' : 'mid'); }
  function nextTodoPriority(p) { return p === '高' ? '中' : (p === '中' ? '低' : '高'); }
  // due 状态：逾期 / 今天 / 未来（已完成不标色）
  function todoDueState(due, done) {
    if (!due || done) return '';
    const today = todayStr();
    if (due < today) return 'overdue';
    if (due === today) return 'today';
    return 'future';
  }

  // ---------- 待办看板元素 ----------
  const $todoView = document.getElementById('todoView');
  const $todoBoardBtn = document.getElementById('todoBoardBtn');
  const $todoBoard = document.getElementById('todoBoard');
  const $todoBoardInput = document.getElementById('todoBoardInput');
  const $todoBoardProject = document.getElementById('todoBoardProject');
  const $todoBoardDue = document.getElementById('todoBoardDue');
  const $todoBoardAddBtn = document.getElementById('todoBoardAddBtn');
  const $todoProjectFilter = document.getElementById('todoProjectFilter');
  const $todoSearch = document.getElementById('todoSearch');
  const $todoOverdueOnly = document.getElementById('todoOverdueOnly');
  const $todoManageProjectsBtn = document.getElementById('todoManageProjectsBtn');
  const $todoBoardRefreshBtn = document.getElementById('todoBoardRefreshBtn');
  const $todoEditModal = document.getElementById('todoEditModal');
  const $todoEditText = document.getElementById('todoEditText');
  const $todoEditProject = document.getElementById('todoEditProject');
  const $todoEditDue = document.getElementById('todoEditDue');
  const $todoEditNote = document.getElementById('todoEditNote');
  const $todoEditError = document.getElementById('todoEditError');
  const $todoEditClose = document.getElementById('todoEditClose');
  const $todoEditSaveBtn = document.getElementById('todoEditSaveBtn');
  const $todoProjectsModal = document.getElementById('todoProjectsModal');
  const $todoProjNew = document.getElementById('todoProjNew');
  const $todoProjAddBtn = document.getElementById('todoProjAddBtn');
  const $todoProjList = document.getElementById('todoProjList');
  const $todoProjectsClose = document.getElementById('todoProjectsClose');

  let todoViewOpen = false;          // 看板视图是否打开
  let boardItems = [];               // 看板全量条目
  let boardProjects = [];            // 项目列表
  let boardDoneOpen = false;         // 已完成区是否展开
  let editingTodoId = null;          // 编辑弹层目标 id
  let editingProjName = null;        // 项目管理弹层正在重命名的项目

  function toggleTodoBoard() {
    toggleView('todos',
      () => todoViewOpen, (v) => { todoViewOpen = v; },
      null,
      () => { loadBoard(); }
    );
  }
  $todoBoardBtn.addEventListener('click', toggleTodoBoard);

  // ---------- 看板数据 ----------
  async function loadBoard() {
    try {
      const res = await apiFetch('/todos/board', { cache: 'no-store' });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '加载失败');
      boardItems = Array.isArray(j.data.items) ? j.data.items : [];
      boardProjects = Array.isArray(j.data.projects) ? j.data.projects : [];
    } catch (_) { boardItems = []; boardProjects = []; }
    refreshProjectOptions();
    renderBoard();
  }

  // 同步项目下拉（筛选 / 添加行 / 编辑弹层），保留当前选中值
  function refreshProjectOptions() {
    const sync = (sel, keep) => {
      const cur = keep && sel.value;
      sel.innerHTML = '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = sel === $todoProjectFilter ? '全部项目' : '未分配';
      sel.appendChild(none);
      for (const p of boardProjects) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        sel.appendChild(opt);
      }
      if (cur && boardProjects.includes(cur)) sel.value = cur;
    };
    sync($todoProjectFilter, true);
    sync($todoBoardProject, true);
    sync($todoEditProject, false);
  }

  // 排序：due 升序（无 due 沉底）→ 优先级（高中低）→ 创建时间
  function boardSort(items) {
    const prioRank = (p) => (p === '高' ? 0 : (p === '中' ? 1 : 2));
    return items.slice().sort((a, b) => {
      const da = a.due || '9999-12-31';
      const db = b.due || '9999-12-31';
      if (da !== db) return da < db ? -1 : 1;
      const pa = prioRank(a.priority);
      const pb = prioRank(b.priority);
      if (pa !== pb) return pa - pb;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  }

  function renderBoard() {
    $todoBoard.innerHTML = '';
    const today = todayStr();
    const q = $todoSearch.value.trim().toLowerCase();
    const filterProj = $todoProjectFilter.value;
    const overdueOnly = $todoOverdueOnly.checked;

    const match = (t) => {
      if (filterProj && (t.project || '') !== filterProj) return false;
      if (q && (t.text + ' ' + (t.note || '') + ' ' + (t.project || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    };

    // 未完成：按项目分组
    const open = boardItems.filter((t) => !t.done && match(t) && !(overdueOnly && !(t.due && t.due < today)));
    const groups = [];
    for (const p of boardProjects) {
      const items = open.filter((t) => t.project === p);
      if (items.length) groups.push({ name: p, items });
    }
    const unassigned = open.filter((t) => !t.project || boardProjects.indexOf(t.project) < 0);
    if (unassigned.length) groups.push({ name: '未分配', items: unassigned });

    if (groups.length === 0) {
      $todoBoard.appendChild(el('div', 'todo-empty',
        overdueOnly ? '没有已逾期的待办' : (q || filterProj ? '没有符合条件的待办' : '还没有待办，先在上面记一条')));
    } else {
      for (const g of groups) {
        const section = el('div', 'todo-board-group');
        const head = el('div', 'todo-board-group-head');
        head.appendChild(el('span', 'todo-board-group-name', g.name));
        head.appendChild(el('span', 'todo-count', String(g.items.length)));
        section.appendChild(head);
        const list = el('div', 'todo-board-group-list');
        for (const t of boardSort(g.items)) list.appendChild(makeBoardItem(t));
        section.appendChild(list);
        $todoBoard.appendChild(section);
      }
    }

    // 已完成：折叠区（筛选跟随项目/搜索，不看逾期）
    const done = boardItems.filter((t) => t.done && match(t));
    if (done.length) {
      const doneSection = el('div', 'todo-board-done');
      const doneHead = el('button', 'todo-board-done-head', (boardDoneOpen ? '▾' : '▸') + ' 已完成 ' + done.length);
      doneHead.title = boardDoneOpen ? '收起' : '展开';
      doneHead.addEventListener('click', () => { boardDoneOpen = !boardDoneOpen; renderBoard(); });
      doneSection.appendChild(doneHead);
      if (boardDoneOpen) {
        const list = el('div', 'todo-board-group-list');
        const sorted = done.slice().sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
        for (const t of sorted) list.appendChild(makeBoardItem(t));
        doneSection.appendChild(list);
      }
      $todoBoard.appendChild(doneSection);
    }
  }

  function makeBoardItem(t) {
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
    text.title = t.text;
    row.appendChild(text);

    // 截止日徽标（逾期红 / 今天橙）
    if (t.due) {
      const dueEl = el('span', 'todo-due ' + todoDueState(t.due, t.done), '📅 ' + t.due);
      dueEl.title = '截止日' + (todoDueState(t.due, t.done) === 'overdue' ? '（已逾期）' : '');
      row.appendChild(dueEl);
    }

    // 备注图标（有备注时显示，点击展开）
    if (t.note) {
      const noteBtn = el('button', 'icon-btn todo-note-toggle', '📝');
      noteBtn.title = t.noteOpen ? '收起备注' : '展开备注';
      row.appendChild(noteBtn);
    }

    if (!t.done) {
      const editBtn = el('button', 'icon-btn todo-edit', '✎');
      editBtn.title = '编辑（项目/截止日/备注）';
      row.appendChild(editBtn);
    }

    const delBtn = el('button', 'icon-btn todo-del', '🗑');
    delBtn.title = '删除';
    row.appendChild(delBtn);

    // 备注展开行（紧跟条目行）
    if (t.note && t.noteOpen) {
      const noteRow = el('div', 'todo-note-row', t.note);
      noteRow.title = t.note;
      const wrap = document.createElement('div');
      wrap.className = 'todo-item-wrap';
      wrap.appendChild(row);
      wrap.appendChild(noteRow);
      return wrap;
    }
    return row;
  }

  // ---------- 看板操作 ----------
  function boardAdd() {
    const text = $todoBoardInput.value.trim();
    if (!text) { $todoBoardInput.focus(); return; }
    const body = { text, project: $todoBoardProject.value || null, due: $todoBoardDue.value || null };
    apiFetch('/todos/add', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body)
    }).then((res) => res.json()).then((j) => {
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '添加失败');
      $todoBoardInput.value = '';
      $todoBoardDue.value = '';
      loadBoard();
    }).catch((err) => toast('添加待办失败：' + (err && err.message ? err.message : err)));
  }

  function boardUpdate(id, patch) {
    apiFetch('/todos/update', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ id, patch })
    }).then((res) => res.json()).then((j) => {
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '更新失败');
      loadBoard();
    }).catch((err) => toast('更新待办失败：' + (err && err.message ? err.message : err)));
  }

  function boardRemove(id) {
    apiFetch('/todos/remove', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ id })
    }).then((res) => res.json()).then((j) => {
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '删除失败');
      loadBoard();
    }).catch((err) => toast('删除待办失败：' + (err && err.message ? err.message : err)));
  }

  $todoBoardAddBtn.addEventListener('click', boardAdd);
  $todoBoardInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); boardAdd(); }
  });
  $todoBoardRefreshBtn.addEventListener('click', loadBoard);
  $todoProjectFilter.addEventListener('change', renderBoard);
  $todoSearch.addEventListener('input', renderBoard);
  $todoOverdueOnly.addEventListener('change', renderBoard);

  $todoBoard.addEventListener('click', (e) => {
    const row = e.target.closest('.todo-item');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.classList.contains('todo-check')) {
      boardUpdate(id, { done: e.target.checked });
    } else if (e.target.classList.contains('todo-prio')) {
      const t = boardItems.find((x) => x.id === id);
      if (t) boardUpdate(id, { priority: nextTodoPriority(t.priority) });
    } else if (e.target.closest('.todo-note-toggle')) {
      const t = boardItems.find((x) => x.id === id);
      if (t) { t.noteOpen = !t.noteOpen; renderBoard(); }
    } else if (e.target.closest('.todo-edit')) {
      openTodoEdit(id);
    } else if (e.target.closest('.todo-del')) {
      showConfirm('删除这条待办？', '删除后不可恢复。', () => boardRemove(id));
    }
  });

  // ---------- 编辑弹层 ----------
  function openTodoEdit(id) {
    const t = boardItems.find((x) => x.id === id);
    if (!t) return;
    editingTodoId = id;
    $todoEditText.value = t.text || '';
    $todoEditProject.value = t.project || '';
    $todoEditDue.value = t.due || '';
    $todoEditNote.value = t.note || '';
    $todoEditError.textContent = '';
    $todoEditModal.hidden = false;
    $todoEditText.focus();
  }
  function closeTodoEdit() {
    $todoEditModal.hidden = true;
    editingTodoId = null;
  }
  function todoEditSave() {
    const text = $todoEditText.value.trim();
    if (!text) { $todoEditError.textContent = '待办内容不能为空'; return; }
    if (!editingTodoId) return;
    const patch = {
      text,
      project: $todoEditProject.value || null,
      due: $todoEditDue.value || null,
      note: $todoEditNote.value
    };
    boardUpdate(editingTodoId, patch);
    closeTodoEdit();
  }
  $todoEditSaveBtn.addEventListener('click', todoEditSave);
  $todoEditClose.addEventListener('click', closeTodoEdit);
  $todoEditModal.addEventListener('click', (e) => { if (e.target === $todoEditModal) closeTodoEdit(); });
  $todoEditText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); todoEditSave(); }
  });

  // ---------- 项目管理弹层 ----------
  function renderProjectList() {
    $todoProjList.innerHTML = '';
    if (!boardProjects.length) {
      $todoProjList.appendChild(el('div', 'todo-empty', '还没有项目，添加一个吧'));
      return;
    }
    for (const name of boardProjects) {
      const count = boardItems.filter((t) => t.project === name).length;
      const item = el('div', 'todo-proj-item');
      if (editingProjName === name) {
        const input = document.createElement('input');
        input.className = 'todo-proj-rename-input';
        input.value = name;
        input.maxLength = 50;
        item.appendChild(input);
        const okBtn = el('button', 'icon-btn', '✓');
        okBtn.title = '保存重命名';
        okBtn.addEventListener('click', () => {
          const v = input.value.trim();
          if (v && v !== name) renameProject(name, v);
          else { editingProjName = null; renderProjectList(); }
        });
        item.appendChild(okBtn);
        const cancelBtn = el('button', 'icon-btn', '✕');
        cancelBtn.title = '取消';
        cancelBtn.addEventListener('click', () => { editingProjName = null; renderProjectList(); });
        item.appendChild(cancelBtn);
        input.focus();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
        });
      } else {
        item.appendChild(el('span', 'todo-proj-name', name));
        item.appendChild(el('span', 'todo-count', String(count)));
        const editBtn = el('button', 'icon-btn', '✎');
        editBtn.title = '重命名';
        editBtn.addEventListener('click', () => { editingProjName = name; renderProjectList(); });
        item.appendChild(editBtn);
        const delBtn = el('button', 'icon-btn', '🗑');
        delBtn.title = '删除项目（待办转为未分配）';
        delBtn.addEventListener('click', () => {
          showConfirm('删除项目「' + name + '」？', '该项目下的待办会转为「未分配」，不会被删除。', () => removeProject(name));
        });
        item.appendChild(delBtn);
      }
      $todoProjList.appendChild(item);
    }
  }

  function openProjectsModal() {
    editingProjName = null;
    $todoProjNew.value = '';
    renderProjectList();
    $todoProjectsModal.hidden = false;
  }
  function closeProjectsModal() { $todoProjectsModal.hidden = true; }

  function addProject() {
    const name = $todoProjNew.value.trim();
    if (!name) { $todoProjNew.focus(); return; }
    apiFetch('/todos/projects/add', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name })
    }).then((res) => res.json()).then((j) => {
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '添加失败');
      $todoProjNew.value = '';
      boardProjects = j.projects || boardProjects;
      renderProjectList();
      refreshProjectOptions();
      renderBoard();
    }).catch((err) => toast('添加项目失败：' + (err && err.message ? err.message : err)));
  }

  function renameProject(oldName, newName) {
    apiFetch('/todos/projects/rename', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ oldName, newName })
    }).then((res) => res.json()).then((j) => {
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '重命名失败');
      editingProjName = null;
      boardProjects = j.projects || boardProjects;
      for (const t of boardItems) if (t.project === oldName) t.project = newName;
      renderProjectList();
      refreshProjectOptions();
      renderBoard();
    }).catch((err) => toast('重命名失败：' + (err && err.message ? err.message : err)));
  }

  function removeProject(name) {
    apiFetch('/todos/projects/remove', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name })
    }).then((res) => res.json()).then((j) => {
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '删除失败');
      boardProjects = j.projects || boardProjects;
      for (const t of boardItems) if (t.project === name) t.project = null;
      renderProjectList();
      refreshProjectOptions();
      renderBoard();
    }).catch((err) => toast('删除项目失败：' + (err && err.message ? err.message : err)));
  }

  $todoManageProjectsBtn.addEventListener('click', openProjectsModal);
  $todoProjectsClose.addEventListener('click', closeProjectsModal);
  $todoProjectsModal.addEventListener('click', (e) => { if (e.target === $todoProjectsModal) closeProjectsModal(); });
  $todoProjAddBtn.addEventListener('click', addProject);
  $todoProjNew.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addProject(); }
  });

  // ============ 📝 每日待办（会议视图左列，独立日期） ============

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
      $todoList.appendChild(el('div', 'todo-empty', '这一天没有截止的待办'));
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
    text.title = t.text;
    row.appendChild(text);

    // 项目/备注小标识（左列空间有限，只给标识不给操作）
    if (t.project) {
      const proj = el('span', 'todo-chip', t.project);
      proj.title = '项目：' + t.project;
      row.appendChild(proj);
    }
    if (t.note) {
      const noteEl = el('span', 'todo-chip', '📝');
      noteEl.title = '有备注';
      row.appendChild(noteEl);
    }

    if (!t.done) {
      const moveBtn = el('button', 'icon-btn todo-move', '→ 明天');
      moveBtn.title = '顺延到明天（改截止日）';
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
        body: JSON.stringify({ id, patch })
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
        body: JSON.stringify({ id })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '删除失败');
      loadTodos();
    } catch (err) {
      toast('删除待办失败：' + (err && err.message ? err.message : err));
    }
  }

  // 改到下一天：把该条待办的截止日改为当前查看日期的次日（保留原状态）
  async function todoMove(id) {
    const toDate = shiftDate(todoDate || todayStr(), 1);
    try {
      const res = await apiFetch('/todos/move', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id, toDate })
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

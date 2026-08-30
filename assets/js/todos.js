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
  // 条目是否落在某天：单日看 due，持续任务看 [start, due] 区间（YYYY-MM-DD 字符串比较）
  function todoInRange(t, dateStr) {
    if (!t.due) return false;
    const start = t.start || t.due;
    return dateStr >= start && dateStr <= t.due;
  }
  // start/due 归一：start 有而 due 无→单日(due=start)；start>due→交换（保证 start<=due）
  function normalizeTodoRange(start, due) {
    if (start && !due) { due = start; start = null; }
    else if (start && due && start > due) { const t = start; start = due; due = t; }
    return { start, due };
  }
  // 截止日显示文案：单日「📅 8月30日」；持续「📅 8月24日 ~ 8月26日」
  function fmtTodoDue(t) {
    const dueTxt = fmtCalDate(t.due, false);
    return (t.start && t.start !== t.due)
      ? '📅 ' + fmtCalDate(t.start, false) + ' ~ ' + dueTxt
      : '📅 ' + dueTxt;
  }

  // ---------- 待办看板元素 ----------
  const $todoView = document.getElementById('todoView');
  const $todoBoardBtn = document.getElementById('todoBoardBtn');
  const $todoNav = document.getElementById('todoNav');
  const $todoNavProjects = document.getElementById('todoNavProjects');
  const $todoNavStats = document.getElementById('todoNavStats');
  const $todoMain = document.getElementById('todoMain');
  const $todoMainHead = document.getElementById('todoMainHead');
  const $todoBoard = document.getElementById('todoBoard');
  const $todoBoardAdd = document.getElementById('todoBoardAdd');
  const $todoBoardInput = document.getElementById('todoBoardInput');
  const $todoBoardStart = document.getElementById('todoBoardStart');
  const $todoBoardDue = document.getElementById('todoBoardDue');
  const $todoBoardAddBtn = document.getElementById('todoBoardAddBtn');
  const $todoBoardMoreBtn = document.getElementById('todoBoardMoreBtn');
  const $todoBoardOpts = document.getElementById('todoBoardOpts');
  const $todoDueClearBtn = document.getElementById('todoDueClearBtn');
  const $todoSearch = document.getElementById('todoSearch');
  const $todoManageProjectsBtn = document.getElementById('todoManageProjectsBtn');
  const $todoBoardRefreshBtn = document.getElementById('todoBoardRefreshBtn');
  const $todoNavToggle = document.getElementById('todoNavToggle');
  const $todoEditModal = document.getElementById('todoEditModal');
  const $todoEditText = document.getElementById('todoEditText');
  const $todoEditProject = document.getElementById('todoEditProject');
  const $todoEditStart = document.getElementById('todoEditStart');
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
  const $todoDayModal = document.getElementById('todoDayModal');
  const $todoDayTitle = document.getElementById('todoDayTitle');
  const $todoDayList = document.getElementById('todoDayList');
  const $todoDayClose = document.getElementById('todoDayClose');

  let todoViewOpen = false;          // 看板视图是否打开
  let todoView = 'all';              // 左栏选中视图：all | today | timeline | unassigned | project:<项目名>
  let boardItems = [];               // 看板全量条目
  let boardProjects = [];            // 项目列表
  let boardDoneOpen = false;         // 已完成区是否展开
  let timelineLaterOpen = false;     // 时间轴「更晚」区是否展开
  let dayModalDate = null;           // 日历格子弹窗正在查看的日期（YYYY-MM-DD）
  let editingTodoId = null;          // 编辑弹层目标 id
  let editingProjName = null;        // 项目管理弹层正在重命名的项目
  let calMonth = null;               // 日历视图所在月（'YYYY-MM'，null 表示当月）
  let todoNavCollapsed = false;      // 窄屏（≤720px）下 true = 左栏抽屉收起；宽屏忽略
  let $todoNavBackdrop = null;       // 抽屉遮罩元素（懒创建）

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
    renderTodoLayout();
    if (dayModalDate) renderTodoDayModal();   // 日历格子弹窗打开时，数据变更后同步刷新
  }

  // 同步编辑弹层项目下拉
  function refreshProjectOptions() {
    $todoEditProject.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = '未分配';
    $todoEditProject.appendChild(first);
    for (const p of boardProjects) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      $todoEditProject.appendChild(opt);
    }
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

  // ---------- 左右布局渲染（左栏导航 + 右栏列表） ----------
  function renderTodoLayout() {
    collapseTodoNav();   // 窄屏下切换视图/刷新后自动收起抽屉（宽屏无影响）
    // 当前项目被删除时，活动视图回退「全部」
    if (todoView.indexOf('project:') === 0 && boardProjects.indexOf(todoView.slice(8)) < 0) todoView = 'all';
    renderTodoNav();
    renderTodoMain();
  }

  // 左栏：智能入口计数 + 项目列表 + 底部统计
  function renderTodoNav() {
    const today = todayStr();
    const open = boardItems.filter((t) => !t.done);
    const counts = {
      all: open.length,
      today: open.filter((t) => todoInRange(t, today)).length,
      timeline: open.length,
      unassigned: open.filter((t) => !t.project).length
    };
    const activeView = todoView;
    for (const btn of $todoNav.querySelectorAll('.todo-nav-scroll > .todo-nav-item[data-view]')) {
      const n = counts[btn.dataset.view] || 0;
      btn.classList.toggle('active', activeView === btn.dataset.view);
      let c = btn.querySelector('.todo-nav-count');
      if (!c) { c = el('span', 'todo-nav-count'); btn.appendChild(c); }
      c.textContent = String(n);
    }
    $todoNavProjects.innerHTML = '';
    for (const name of boardProjects) {
      const n = open.filter((t) => t.project === name).length;
      const btn = el('button', 'todo-nav-item' + (todoView === 'project:' + name ? ' active' : ''), '▸ ' + name);
      btn.dataset.view = 'project:' + name;
      btn.appendChild(el('span', 'todo-nav-count', String(n)));
      $todoNavProjects.appendChild(btn);
    }
    $todoNavStats.textContent = '合计 ' + counts.all + ' · 逾期 ' + open.filter((t) => t.due && t.due < today).length;
  }

  // 右栏：视图头 + 添加区（按视图显隐）+ 条目列表
  function renderTodoMain() {
    const today = todayStr();
    const q = $todoSearch.value.trim().toLowerCase();
    const searchMatch = (t) => !q || (t.text + ' ' + (t.note || '') + ' ' + (t.project || '')).toLowerCase().indexOf(q) >= 0;

    // 全部视图：右栏整体渲染日历（日历自带头部，不再显示外层视图头）
    if (todoView === 'all') {
      $todoMainHead.innerHTML = '';
      $todoBoardAdd.hidden = true;
      $todoBoardOpts.hidden = true;
      $todoBoardMoreBtn.textContent = '▸ 选项';
      $todoBoard.innerHTML = '';
      $todoBoard.appendChild(renderTodoCalendar());
      return;
    }

    // 今天视图：逾期（滚入今天）+ 今天（含持续任务进行中）+ 已完成
    if (todoView === 'today') {
      renderToday(today, q, searchMatch);
      return;
    }

    // 时间轴视图（主 + 项目）：逾期 → 今天 → 明天 → 未来7天 → 更晚 → 未安排
    if (todoView === 'timeline' || todoView.indexOf('project:') === 0) {
      renderTimeline(today, q, searchMatch, todoView === 'timeline' ? null : todoView.slice(8));
      return;
    }

    // 未分配视图（唯一剩余的扁平列表）
    const open = boardItems.filter((t) => !t.done && !t.project && searchMatch(t));
    const done = boardItems.filter((t) => t.done && !t.project && searchMatch(t));

    // 视图头：标题 + 未完成/逾期计数
    const overdueInScope = open.filter((t) => t.due && t.due < today).length;
    $todoMainHead.innerHTML = '';
    const head = el('div', 'todo-main-head');
    head.appendChild(el('span', 'todo-main-title', '未分配'));
    head.appendChild(el('span', 'todo-main-meta', '未完成 ' + open.length + ' · 逾期 ' + overdueInScope));
    $todoMainHead.appendChild(head);

    // 添加区
    $todoBoardAdd.hidden = false;
    $todoBoardInput.placeholder = '记一条待办…';

    // 条目列表 + 已完成折叠区
    $todoBoard.innerHTML = '';
    if (open.length === 0 && done.length === 0) {
      $todoBoard.appendChild(el('div', 'todo-empty', q ? '没有符合条件的待办' : '还没有未分配的待办'));
    } else {
      for (const t of boardSort(open)) $todoBoard.appendChild(makeBoardItem(t, false));
      if (done.length) $todoBoard.appendChild(makeDoneSection(done, false));
    }
  }

  // ---------- 时间轴视图（🕐） ----------
  // 'YYYY-MM-DD' → '周X'
  function ttWeekday(dateStr) {
    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    const d = new Date(dateStr + 'T00:00:00');
    return isNaN(d.getTime()) ? '' : '周' + WD[d.getDay()];
  }

  // 单个时间轴分组：节点 + 日期标签 + 计数 + 条目列表（showDue=false 时隐藏条目内截止日 chip；showProject=false 时隐藏项目 chip，如单项目视图）
  function makeTimelineGroup(state, label, items, showDue, showProject) {
    const g = el('div', 'tt-group tt-' + state);
    const head = el('div', 'tt-head');
    head.appendChild(el('span', 'tt-dot'));
    head.appendChild(el('span', 'tt-label', label));
    head.appendChild(el('span', 'tt-count', String(items.length)));
    g.appendChild(head);
    const list = el('div', 'tt-items');
    for (const t of items) list.appendChild(makeBoardItem(t, showProject, showDue));
    g.appendChild(list);
    return g;
  }

  // 已完成折叠区（时间轴 / 今天 / 扁平列表共用）
  function makeDoneSection(done, showProject) {
    const doneSection = el('div', 'todo-board-done');
    const doneHead = el('button', 'todo-board-done-head', (boardDoneOpen ? '▾' : '▸') + ' 已完成 ' + done.length);
    doneHead.title = boardDoneOpen ? '收起' : '展开';
    doneHead.addEventListener('click', () => { boardDoneOpen = !boardDoneOpen; renderTodoMain(); });
    doneSection.appendChild(doneHead);
    if (boardDoneOpen) {
      const list = el('div', 'todo-board-group-list');
      const sorted = done.slice().sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
      for (const t of sorted) list.appendChild(makeBoardItem(t, showProject, true));
      doneSection.appendChild(list);
    }
    return doneSection;
  }

  function renderTimeline(today, q, searchMatch, projectScope) {
    const crossProject = projectScope == null;
    const inScope = (t) => crossProject || t.project === projectScope;
    const open = boardItems.filter((t) => !t.done && inScope(t) && searchMatch(t));
    const done = boardItems.filter((t) => t.done && inScope(t) && searchMatch(t));
    const overdueCount = open.filter((t) => t.due && t.due < today).length;

    // 视图头
    $todoMainHead.innerHTML = '';
    const head = el('div', 'todo-main-head');
    head.appendChild(el('span', 'todo-main-title', crossProject ? '🕐 时间轴' : '📁 ' + projectScope));
    head.appendChild(el('span', 'todo-main-meta', '未完成 ' + open.length + ' · 逾期 ' + overdueCount));
    $todoMainHead.appendChild(head);

    // 添加区（默认今天截止）
    $todoBoardAdd.hidden = false;
    $todoBoardInput.placeholder = crossProject ? '记一条待办…（今天截止）' : '记一条待办…（将归入 ' + projectScope + ' · 今天截止）';

    $todoBoard.innerHTML = '';
    if (open.length === 0 && done.length === 0) {
      $todoBoard.appendChild(el('div', 'todo-empty', q ? '没有符合条件的待办' : (crossProject ? '时间轴里还没有待办' : '这个项目还没有待办')));
      return;
    }

    // 分组：逾期 / 今天 / 明天 / 未来(至+7) / 更晚 / 未安排
    const horizon = shiftDate(today, 7);
    const overdue = [], later = [], noDue = [], buckets = {};
    for (const t of open) {
      if (!t.due) noDue.push(t);
      else if (t.due < today) overdue.push(t);
      else if (t.due > horizon) later.push(t);
      else (buckets[t.due] = buckets[t.due] || []).push(t);
    }

    const tl = el('div', 'todo-timeline');
    if (overdue.length) tl.appendChild(makeTimelineGroup('overdue', '⏰ 逾期', boardSort(overdue), true, crossProject));
    const tomorrow = shiftDate(today, 1);
    if (buckets[today]) tl.appendChild(makeTimelineGroup('today', '今天 · ' + fmtCalDate(today, false) + ' · ' + ttWeekday(today), boardSort(buckets[today]), false, crossProject));
    if (buckets[tomorrow]) tl.appendChild(makeTimelineGroup('tomorrow', '明天 · ' + fmtCalDate(tomorrow, false) + ' · ' + ttWeekday(tomorrow), boardSort(buckets[tomorrow]), false, crossProject));
    for (let i = 2; i <= 7; i++) {
      const d = shiftDate(today, i);
      if (buckets[d]) tl.appendChild(makeTimelineGroup('future', fmtCalDate(d, false) + ' · ' + ttWeekday(d), boardSort(buckets[d]), false, crossProject));
    }

    // 更晚（7 天之后，默认折叠）
    if (later.length) {
      const g = el('div', 'tt-group tt-later');
      const laterHead = el('button', 'tt-head tt-toggle');
      laterHead.title = timelineLaterOpen ? '收起' : '展开';
      laterHead.addEventListener('click', () => { timelineLaterOpen = !timelineLaterOpen; renderTodoMain(); });
      laterHead.appendChild(el('span', 'tt-dot'));
      laterHead.appendChild(el('span', 'tt-label', (timelineLaterOpen ? '▾ ' : '▸ ') + '更晚'));
      laterHead.appendChild(el('span', 'tt-count', String(later.length)));
      g.appendChild(laterHead);
      if (timelineLaterOpen) {
        const list = el('div', 'tt-items');
        for (const t of boardSort(later)) list.appendChild(makeBoardItem(t, crossProject, true));
        g.appendChild(list);
      }
      tl.appendChild(g);
    }

    if (noDue.length) tl.appendChild(makeTimelineGroup('none', '未安排 · 无截止日', boardSort(noDue), false, crossProject));
    $todoBoard.appendChild(tl);

    // 已完成（折叠，独立 footer，不参与时间轴竖线）
    if (done.length) $todoBoard.appendChild(makeDoneSection(done, crossProject));
  }

  // 今天视图：逾期（滚入今天）+ 今天（含持续任务进行中）+ 已完成
  function renderToday(today, q, searchMatch) {
    const open = boardItems.filter((t) => !t.done && searchMatch(t));
    const done = boardItems.filter((t) => t.done && searchMatch(t));
    const overdue = open.filter((t) => t.due && t.due < today);
    const todayItems = open.filter((t) => todoInRange(t, today));

    // 视图头
    $todoMainHead.innerHTML = '';
    const head = el('div', 'todo-main-head');
    head.appendChild(el('span', 'todo-main-title', '📅 今天'));
    head.appendChild(el('span', 'todo-main-meta', '未完成 ' + (overdue.length + todayItems.length) + ' · 逾期 ' + overdue.length));
    $todoMainHead.appendChild(head);

    // 添加区（默认今天截止）
    $todoBoardAdd.hidden = false;
    $todoBoardInput.placeholder = '记一条待办…（今天截止）';

    $todoBoard.innerHTML = '';
    if (overdue.length === 0 && todayItems.length === 0 && done.length === 0) {
      $todoBoard.appendChild(el('div', 'todo-empty', q ? '没有符合条件的待办' : '今天还没有待办'));
      return;
    }

    const tl = el('div', 'todo-timeline');
    if (overdue.length) tl.appendChild(makeTimelineGroup('overdue', '⏰ 逾期', boardSort(overdue), true, true));
    if (todayItems.length) tl.appendChild(makeTimelineGroup('today', '今天 · ' + fmtCalDate(today, false) + ' · ' + ttWeekday(today), boardSort(todayItems), false, true));
    $todoBoard.appendChild(tl);

    if (done.length) $todoBoard.appendChild(makeDoneSection(done, true));
  }

  function makeBoardItem(t, showProjectChip, showDue) {
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

    // 标题 + 备注（备注用灰色小字内联在标题下方，clamp 2 行）
    const body = el('div', 'todo-body');
    const text = el('div', 'todo-text', t.text);
    text.title = t.text;
    body.appendChild(text);
    if (t.note) {
      const note = el('div', 'todo-note', t.note);
      note.title = t.note;
      body.appendChild(note);
    }
    row.appendChild(body);

    // 截止日徽标（逾期红 / 今天橙；持续任务显示 start~due 区间）；时间轴已按日期分组，组内条目可隐藏避免重复
    if (t.due && showDue !== false) {
      const dueEl = el('span', 'todo-due ' + todoDueState(t.due, t.done), fmtTodoDue(t));
      dueEl.title = (t.start && t.start !== t.due ? '持续 ' + t.start + ' ~ ' + t.due : '截止日') + (todoDueState(t.due, t.done) === 'overdue' ? '（已逾期）' : '');
      row.appendChild(dueEl);
    }

    // 快捷改期（未完成条目，紧跟日期右边）：
    // 「下一天继续」→ 今天继续、明天截止（start=今天, due=明天，今天+明天都有）
    // 「改到下一天」→ 移到明天、今天不做（清 start，due=明天）
    if (!t.done) {
      const contBtn = el('button', 'todo-quick todo-continue', '下一天继续');
      contBtn.title = '今天继续，明天截止（今天+明天都有）';
      row.appendChild(contBtn);
      const deferBtn = el('button', 'todo-quick todo-defer', '改到下一天');
      deferBtn.title = '移到明天，今天不做';
      row.appendChild(deferBtn);
    }

    // 跨项目视图（时间轴/单日）显示项目 chip
    if (showProjectChip && t.project) {
      const chip = el('span', 'todo-chip', t.project);
      chip.title = '项目：' + t.project;
      row.appendChild(chip);
    }

    if (!t.done) {
      const editBtn = el('button', 'icon-btn todo-edit', '✎');
      editBtn.title = '编辑（项目/截止日/备注）';
      row.appendChild(editBtn);
    }

    const delBtn = el('button', 'icon-btn todo-del', '🗑');
    delBtn.title = '删除';
    row.appendChild(delBtn);

    return row;
  }

  // ---------- 日历视图（左栏「全部」） ----------
  // 项目色点色板（§10 token 取值，按 boardProjects 索引循环取模；未分配无点）
  const CAL_DOT_COLORS = ['var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--danger)', 'var(--text-dim)'];

  // 当前日历所在年/月（calMonth: 'YYYY-MM'，null 表示当月）
  function calBase() {
    const now = new Date();
    const y = calMonth ? parseInt(calMonth.slice(0, 4), 10) : now.getFullYear();
    const m = calMonth ? parseInt(calMonth.slice(5, 7), 10) - 1 : now.getMonth();
    return { y, m };
  }

  // 翻月：返回 'YYYY-MM'
  function shiftCalMonth(delta) {
    const { y, m } = calBase();
    const d = new Date(y, m + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // 'YYYY-MM-DD' → '2026年8月29日'（full）或 '8月29日'（short）
  function fmtCalDate(dateStr, full) {
    const m = parseInt(dateStr.slice(5, 7), 10);
    const d = parseInt(dateStr.slice(8, 10), 10);
    return (full ? dateStr.slice(0, 4) + '年' : '') + m + '月' + d + '日';
  }

  // 项目色点：按 boardProjects 索引取模色板，同一项目颜色一致
  function calProjectColor(name) {
    const i = boardProjects.indexOf(name);
    return CAL_DOT_COLORS[i < 0 ? 0 : i % CAL_DOT_COLORS.length];
  }

  // 格内条目：项目色点 + 截断标题；已完成淡显划线，当月内已过且未完成标红
  function makeCalItem(t) {
    const overdue = !!t.due && !t.done && t.due < todayStr();
    const item = el('button', 'todo-cal-item' + (t.done ? ' done' : '') + (overdue ? ' overdue' : ''));
    item.dataset.id = t.id;
    item.title = t.text;
    if (t.project) {
      const dot = el('span', 'todo-cal-dot');
      dot.style.background = calProjectColor(t.project);
      item.appendChild(dot);
    }
    item.appendChild(el('span', 'todo-cal-item-text', t.text));
    return item;
  }

  // 渲染月历：周一起始、仅当月天数（前补空占位），每格最多 2 条 + 超出「+N」
  function renderTodoCalendar() {
    const { y, m } = calBase();
    const today = todayStr();
    const cal = el('div', 'todo-calendar');

    // 头部：‹ 2026 年 8 月 › [今天] 统计
    const head = el('div', 'todo-cal-head');
    const prevBtn = el('button', 'icon-btn', '‹');
    prevBtn.title = '上个月';
    const nextBtn = el('button', 'icon-btn', '›');
    nextBtn.title = '下个月';
    const todayBtn = el('button', 'todo-cal-today', '今天');
    todayBtn.title = '回到当前月';
    const monthPrefix = y + '-' + String(m + 1).padStart(2, '0');
    const inMonth = boardItems.filter((t) => t.due && t.due.indexOf(monthPrefix) === 0);
    const stat = el('span', 'todo-cal-stat',
      '本月待办 ' + inMonth.filter((t) => !t.done).length + ' · 已完成 ' + inMonth.filter((t) => t.done).length);
    prevBtn.addEventListener('click', () => { calMonth = shiftCalMonth(-1); renderTodoMain(); });
    nextBtn.addEventListener('click', () => { calMonth = shiftCalMonth(1); renderTodoMain(); });
    todayBtn.addEventListener('click', () => { calMonth = null; renderTodoMain(); });
    head.appendChild(prevBtn);
    head.appendChild(el('span', 'todo-cal-title', y + '年' + (m + 1) + '月'));
    head.appendChild(nextBtn);
    head.appendChild(todayBtn);
    head.appendChild(stat);
    cal.appendChild(head);

    // 网格：周一起始（一 二 三 四 五 六 日）
    const grid = el('div', 'todo-cal-grid');
    for (const wd of ['一', '二', '三', '四', '五', '六', '日']) grid.appendChild(el('div', 'todo-cal-wd', wd));
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) grid.appendChild(el('div', 'todo-cal-empty'));
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const cell = el('div', 'todo-cal-cell' + (dateStr === today ? ' today' : ''));
      cell.dataset.date = dateStr;
      cell.appendChild(el('span', 'todo-cal-day', String(d)));
      const dayItems = boardItems.filter((t) => todoInRange(t, dateStr));
      for (const t of boardSort(dayItems).slice(0, 2)) cell.appendChild(makeCalItem(t));
      if (dayItems.length > 2) {
        const more = el('button', 'todo-cal-more', '+' + (dayItems.length - 2));
        more.title = '查看当天全部待办';
        cell.appendChild(more);
      }
      grid.appendChild(cell);
    }
    // 末行补齐空白格：让月历网格恒为完整周数（6 行 × 7 列），避免最后一行参差不齐
    const trailing = (7 - ((lead + daysInMonth) % 7)) % 7;
    for (let i = 0; i < trailing; i++) grid.appendChild(el('div', 'todo-cal-empty'));
    cal.appendChild(grid);
    return cal;
  }

  // 日历交互：点格内条目打开编辑弹窗；点日期数字/空白格/「+N」打开该日待办弹窗
  $todoBoard.addEventListener('click', (e) => {
    const calItem = e.target.closest('.todo-cal-item');
    if (calItem) { openTodoEdit(calItem.dataset.id); return; }
    const cell = e.target.closest('.todo-cal-cell');
    if (cell && cell.dataset.date) openTodoDay(cell.dataset.date);
  });

  // ---------- 看板操作 ----------
  // 添加归属由当前视图决定：project:X → 归入该项目且默认今天截止；timeline → 默认今天截止；unassigned → 不设项目、due 取附属行
  function boardAdd() {
    const text = $todoBoardInput.value.trim();
    if (!text) { $todoBoardInput.focus(); return; }
    let project = null;
    let due = $todoBoardDue.value || null;
    if (todoView.indexOf('project:') === 0) { project = todoView.slice(8); due = due || todayStr(); }
    else if (todoView === 'today' || todoView === 'timeline') due = due || todayStr();
    const range = normalizeTodoRange($todoBoardStart.value || null, due);
    const body = { text, project, start: range.start, due: range.due };
    apiFetch('/todos/add', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body)
    }).then((res) => res.json()).then((j) => {
      if (!j || !j.ok) throw new Error((j && j.error && j.error.message) || '添加失败');
      $todoBoardInput.value = '';
      $todoBoardStart.value = '';
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
  $todoSearch.addEventListener('input', renderTodoLayout);

  // 左栏导航：点击切换视图（含动态项目项）
  $todoNav.addEventListener('click', (e) => {
    const btn = e.target.closest('.todo-nav-item');
    if (!btn) return;
    todoView = btn.dataset.view;
    renderTodoLayout();
  });

  // ---------- 窄屏左栏抽屉（≤720px：左栏折叠为抽屉，☰ 展开） ----------
  function isTodoNavNarrow() { return window.matchMedia('(max-width: 720px)').matches; }

  // 收起抽屉：加 .collapsed 并隐藏遮罩（仅窄屏有效，宽屏无视觉影响）
  function collapseTodoNav() {
    if (!isTodoNavNarrow()) return;
    todoNavCollapsed = true;
    $todoNav.classList.add('collapsed');
    if ($todoNavBackdrop) $todoNavBackdrop.hidden = true;
  }

  // 展开抽屉（仅窄屏调用）：去 .collapsed 并显示遮罩
  function expandTodoNav() {
    todoNavCollapsed = false;
    $todoNav.classList.remove('collapsed');
    if (!$todoNavBackdrop) {
      $todoNavBackdrop = document.createElement('div');
      $todoNavBackdrop.className = 'todo-nav-backdrop';
      $todoNavBackdrop.hidden = true;
      $todoNavBackdrop.addEventListener('click', collapseTodoNav);
      $todoView.appendChild($todoNavBackdrop);
    }
    $todoNavBackdrop.hidden = false;
  }

  // ☰ 切换：窄屏下展开/收起
  $todoNavToggle.addEventListener('click', () => {
    if (!isTodoNavNarrow()) return;
    if (todoNavCollapsed) expandTodoNav();
    else collapseTodoNav();
  });

  // 初始化：视口 ≤720px 时默认折叠（不做 resize 监听，刷新时按当前宽度重新初始化）
  if (isTodoNavNarrow()) collapseTodoNav();

  // 展开/收起 截止日 附属行
  $todoBoardMoreBtn.addEventListener('click', () => {
    const hidden = $todoBoardOpts.hidden;
    $todoBoardOpts.hidden = !hidden;
    $todoBoardMoreBtn.textContent = hidden ? '▸ 选项' : '▾ 选项';
    $todoBoardMoreBtn.title = hidden ? '展开 截止日选项' : '收起 截止日选项';
  });

  // 日期快捷：今天 / 明天 / 清除
  $todoBoardOpts.addEventListener('click', (e) => {
    const q = e.target.closest('.todo-date-quick');
    if (q) {
      $todoBoardDue.value = shiftDate(todayStr(), parseInt(q.dataset.shift, 10) || 0);
      return;
    }
    if (e.target.closest('#todoDueClearBtn')) $todoBoardDue.value = '';
  });

  // 待办条目行交互（看板列表 + 日历日弹窗共用）
  function onTodoItemClick(e) {
    const row = e.target.closest('.todo-item');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.classList.contains('todo-check')) {
      boardUpdate(id, { done: e.target.checked });
    } else if (e.target.classList.contains('todo-prio')) {
      const t = boardItems.find((x) => x.id === id);
      if (t) boardUpdate(id, { priority: nextTodoPriority(t.priority) });
    } else if (e.target.closest('.todo-continue')) {
      // 下一天继续：今天继续、明天截止（今天+明天都有）
      boardUpdate(id, { start: todayStr(), due: shiftDate(todayStr(), 1) });
    } else if (e.target.closest('.todo-defer')) {
      // 改到下一天：移到明天、今天不做
      boardUpdate(id, { start: null, due: shiftDate(todayStr(), 1) });
    } else if (e.target.closest('.todo-edit')) {
      openTodoEdit(id);
    } else if (e.target.closest('.todo-del')) {
      showConfirm('删除这条待办？', '删除后不可恢复。', () => boardRemove(id));
    }
  }
  $todoBoard.addEventListener('click', onTodoItemClick);
  $todoDayList.addEventListener('click', onTodoItemClick);

  // ---------- 编辑弹层 ----------
  function openTodoEdit(id) {
    const t = boardItems.find((x) => x.id === id);
    if (!t) return;
    editingTodoId = id;
    $todoEditText.value = t.text || '';
    $todoEditProject.value = t.project || '';
    $todoEditStart.value = t.start || '';
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
    const range = normalizeTodoRange($todoEditStart.value || null, $todoEditDue.value || null);
    const patch = {
      text,
      project: $todoEditProject.value || null,
      start: range.start,
      due: range.due,
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

  // ---------- 日历日待办弹窗 ----------
  function openTodoDay(date) {
    dayModalDate = date;
    renderTodoDayModal();
    $todoDayModal.hidden = false;
  }
  function renderTodoDayModal() {
    if (!dayModalDate) return;
    const date = dayModalDate;
    const open = boardItems.filter((t) => !t.done && todoInRange(t, date));
    const done = boardItems.filter((t) => t.done && todoInRange(t, date));
    $todoDayTitle.textContent = '📅 ' + fmtCalDate(date, true) + ' · ' + ttWeekday(date);
    $todoDayList.innerHTML = '';
    if (open.length === 0 && done.length === 0) {
      $todoDayList.appendChild(el('div', 'todo-empty', '这一天还没有待办'));
      return;
    }
    for (const t of boardSort(open)) $todoDayList.appendChild(makeBoardItem(t, true, false));
    if (done.length) {
      $todoDayList.appendChild(el('div', 'todo-day-sep', '已完成 ' + done.length));
      const sorted = done.slice().sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
      for (const t of sorted) $todoDayList.appendChild(makeBoardItem(t, true, false));
    }
  }
  function closeTodoDay() {
    $todoDayModal.hidden = true;
    dayModalDate = null;
  }
  $todoDayClose.addEventListener('click', closeTodoDay);
  $todoDayModal.addEventListener('click', (e) => { if (e.target === $todoDayModal) closeTodoDay(); });

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
    collapseTodoNav();   // 窄屏：打开项目管理弹层前收起抽屉，避免弹层被遮罩盖住
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
      renderTodoLayout();
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
      renderTodoLayout();
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
      renderTodoLayout();
    }).catch((err) => toast('删除项目失败：' + (err && err.message ? err.message : err)));
  }

  $todoManageProjectsBtn.addEventListener('click', openProjectsModal);
  $todoProjectsClose.addEventListener('click', closeProjectsModal);
  $todoProjectsModal.addEventListener('click', (e) => { if (e.target === $todoProjectsModal) closeProjectsModal(); });
  $todoProjAddBtn.addEventListener('click', addProject);
  $todoProjNew.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addProject(); }
  });

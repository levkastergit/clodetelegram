/* Мини-приложение Telegram для общения с Claude: сессии, лимиты, чат */
(() => {
  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = tg ? tg.initData : "";

  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const inputEl = $("input");
  const statusBar = $("statusBar");
  const statusText = $("statusText");
  const attachmentsEl = $("attachments");
  const sessionListEl = $("sessionList");
  const sidebarEl = $("sidebar");

  let me = null; // ответ /api/me
  let tabs = []; // список сессий (tabSummary)
  let activeTabId = null;
  let attachments = []; // [{path, name}]
  // Кэш по вкладкам: сообщения, статус, ожидающие карточки
  const cache = new Map(); // tabId -> {msgs:[], loaded, status, approval, question}

  if (!initData) {
    $("guard").hidden = false;
    return;
  }
  tg.ready();
  tg.expand();

  // ---------- API ----------

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        "X-Tg-Init-Data": initData,
        ...(opts.body && typeof opts.body === "string"
          ? { "Content-Type": "application/json" }
          : {}),
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  }

  const post = (path, body) =>
    api(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  // ---------- Утилиты ----------

  let toastTimer;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  function tabCache(id) {
    if (!cache.has(id)) {
      cache.set(id, {
        msgs: [],
        loaded: false,
        status: null,
        approval: null,
        question: null,
      });
    }
    return cache.get(id);
  }

  function findTab(id) {
    return tabs.find((t) => t.id === id);
  }

  function fmtReset(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return (
      "сброс " +
      d.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    );
  }

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
  }

  // ---------- Сайдбар ----------

  function renderAccount() {
    $("accountName").textContent = me.user.name;
    $("roleBadge").hidden = me.role !== "guest";
  }

  async function loadLimits() {
    if (me.role !== "owner") return;
    try {
      const data = await api("/api/limits");
      const list = $("usageList");
      list.innerHTML = "";
      for (const w of data.windows) {
        const item = document.createElement("div");
        item.className = "usage-item";
        const top = document.createElement("div");
        top.className = "u-top";
        const lbl = document.createElement("span");
        lbl.textContent = w.label;
        const pct = document.createElement("span");
        pct.className = "u-pct";
        pct.textContent = w.pct + "%";
        top.append(lbl, pct);
        const bar = document.createElement("div");
        bar.className = "u-bar";
        const fill = document.createElement("div");
        fill.className = "u-fill";
        fill.style.width = Math.min(100, Math.max(0, w.pct)) + "%";
        if (w.pct >= 90) fill.style.background = "var(--danger)";
        bar.appendChild(fill);
        item.append(top, bar);
        const reset = fmtReset(w.resetsAt);
        if (reset) {
          const r = document.createElement("div");
          r.className = "u-reset";
          r.textContent = reset;
          item.appendChild(r);
        }
        list.appendChild(item);
      }
      if (data.extra) {
        const e = document.createElement("div");
        e.className = "usage-extra";
        e.textContent = data.extra;
        list.appendChild(e);
      }
      $("usageSection").hidden = data.windows.length === 0 && !data.extra;
    } catch {
      // лимиты не критичны — просто не показываем
    }
  }

  let limitsTimer;
  function scheduleLimitsRefresh() {
    clearTimeout(limitsTimer);
    limitsTimer = setTimeout(loadLimits, 4000);
  }

  function renderSessions() {
    sessionListEl.innerHTML = "";
    if (tabs.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "Сессий пока нет — создайте первую.";
      sessionListEl.appendChild(hint);
      return;
    }
    for (const t of tabs) {
      const c = cache.get(t.id);
      const item = document.createElement("div");
      item.className = "session-item";
      if (t.id === activeTabId) item.classList.add("active");
      if (t.running) item.classList.add("running");
      if (c && (c.approval || c.question) && t.id !== activeTabId) {
        item.classList.add("attention");
      }
      const dot = document.createElement("span");
      dot.className = "s-dot";
      const body = document.createElement("div");
      body.className = "s-body";
      const title = document.createElement("div");
      title.className = "s-title";
      title.textContent = t.title;
      body.appendChild(title);
      const proj = document.createElement("div");
      proj.className = "s-proj";
      proj.textContent = t.project ? "📁 " + t.project : "💬 без проекта";
      body.appendChild(proj);
      const close = document.createElement("button");
      close.className = "s-close";
      close.textContent = "✕";
      close.title = "Закрыть сессию";
      close.onclick = (e) => {
        e.stopPropagation();
        closeTab(t.id);
      };
      item.append(dot, body, close);
      item.onclick = () => selectTab(t.id);
      sessionListEl.appendChild(item);
    }
  }

  function toggleSidebar(open) {
    const want = open ?? !sidebarEl.classList.contains("open");
    sidebarEl.classList.toggle("open", want);
    $("sidebarBackdrop").hidden = !want;
  }

  // ---------- Чат ----------

  function addMsg(tabId, role, text) {
    tabCache(tabId).msgs.push({ role, text });
    if (tabId === activeTabId) renderChat();
  }

  function renderStatus() {
    const c = activeTabId ? tabCache(activeTabId) : null;
    const t = activeTabId ? findTab(activeTabId) : null;
    const show = Boolean(c && c.status && t && t.running);
    statusBar.hidden = !show;
    if (show) statusText.textContent = c.status;
    $("btnStop").hidden = !(t && t.running);
  }

  function renderTopbar() {
    const t = activeTabId ? findTab(activeTabId) : null;
    $("tabTitle").textContent = t ? t.title : "Claude";
    $("tabProject").textContent = t
      ? t.project
        ? "📁 " + t.project
        : "💬 без проекта"
      : "";
  }

  function renderChat() {
    messagesEl.innerHTML = "";
    if (!activeTabId) {
      const n = document.createElement("div");
      n.className = "msg notice";
      n.textContent = "Создайте сессию, чтобы начать диалог с Клодом.";
      messagesEl.appendChild(n);
      renderTopbar();
      renderStatus();
      return;
    }
    const c = tabCache(activeTabId);
    for (const m of c.msgs) {
      const el = document.createElement("div");
      el.className = "msg " + m.role;
      el.textContent = m.text;
      messagesEl.appendChild(el);
    }
    if (c.approval) messagesEl.appendChild(approvalCard(c.approval));
    if (c.question) messagesEl.appendChild(questionCard(c.question));
    renderTopbar();
    renderStatus();
    scrollDown();
  }

  // Карточка подтверждения действия
  function approvalCard(ap) {
    const card = document.createElement("div");
    card.className = "card";
    const title = document.createElement("div");
    title.className = "c-title";
    title.textContent = "Разрешить действие?";
    const desc = document.createElement("div");
    desc.className = "c-desc";
    desc.textContent = ap.description;
    const actions = document.createElement("div");
    actions.className = "c-actions";
    const yes = document.createElement("button");
    yes.className = "btn primary";
    yes.textContent = "✅ Разрешить";
    yes.onclick = () => post("/api/approve", { id: ap.id, allowed: true }).catch((e) => toast(e.message));
    const no = document.createElement("button");
    no.className = "btn danger";
    no.textContent = "❌ Отклонить";
    no.onclick = () => post("/api/approve", { id: ap.id, allowed: false }).catch((e) => toast(e.message));
    actions.append(yes, no);
    card.append(title, desc, actions);
    return card;
  }

  // Карточка вопроса с вариантами
  function questionCard(q) {
    const card = document.createElement("div");
    card.className = "card";
    const title = document.createElement("div");
    title.className = "c-title";
    title.textContent = q.header ? `${q.header}: ${q.question}` : q.question;
    card.appendChild(title);
    if (!q.selected) q.selected = new Set();
    for (let i = 0; i < q.options.length; i++) {
      const o = q.options[i];
      const b = document.createElement("button");
      b.className = "btn block";
      if (q.selected.has(i)) b.classList.add("selected");
      b.textContent = (q.multi && q.selected.has(i) ? "☑ " : "") + o.label;
      if (o.description) {
        const d = document.createElement("span");
        d.className = "b-desc";
        d.textContent = o.description;
        b.appendChild(d);
      }
      b.onclick = () => {
        if (q.multi) {
          if (q.selected.has(i)) q.selected.delete(i);
          else q.selected.add(i);
          renderChat();
        } else {
          post("/api/answer", { id: q.id, answer: o.label }).catch((e) =>
            toast(e.message)
          );
        }
      };
      card.appendChild(b);
    }
    if (q.multi) {
      const done = document.createElement("button");
      done.className = "btn primary block";
      done.textContent = "✅ Готово";
      done.onclick = () => {
        const labels = [...q.selected].sort().map((i) => q.options[i].label);
        if (labels.length === 0) {
          toast("Выберите хотя бы один вариант");
          return;
        }
        post("/api/answer", { id: q.id, answer: labels.join(", ") }).catch((e) =>
          toast(e.message)
        );
      };
      card.appendChild(done);
    }
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Можно ответить и текстом в поле ввода.";
    card.appendChild(hint);
    return card;
  }

  // ---------- Переключение и загрузка сессий ----------

  async function selectTab(id) {
    activeTabId = id;
    toggleSidebar(false);
    renderSessions();
    renderChat();
    post("/api/activate", { id }).catch(() => {});
    const c = tabCache(id);
    if (!c.loaded) {
      c.loaded = true;
      try {
        const data = await api("/api/history?tab=" + encodeURIComponent(id));
        if (data.messages.length > 0) {
          c.msgs = data.messages.concat(c.msgs);
          if (activeTabId === id) renderChat();
        }
      } catch {
        c.loaded = false;
      }
    }
  }

  async function closeTab(id) {
    const t = findTab(id);
    if (t && t.running && !confirm("Задача ещё выполняется. Закрыть сессию?")) {
      return;
    }
    try {
      const r = await api("/api/tab/" + encodeURIComponent(id), {
        method: "DELETE",
      });
      tabs = tabs.filter((x) => x.id !== id);
      cache.delete(id);
      if (activeTabId === id) {
        activeTabId = r.activeTabId;
        if (activeTabId) selectTab(activeTabId);
      }
      renderSessions();
      renderChat();
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- Новая сессия ----------

  function openSheet(html) {
    $("sheetBody").innerHTML = "";
    if (html) $("sheetBody").appendChild(html);
    $("sheet").hidden = false;
  }
  function closeSheet() {
    $("sheet").hidden = true;
  }
  $("sheetBackdrop").onclick = closeSheet;

  async function newSessionFlow() {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = "Новая сессия";
    wrap.appendChild(h);
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Загружаю список проектов…";
    wrap.appendChild(hint);
    openSheet(wrap);

    let projects;
    try {
      projects = (await api("/api/projects")).projects;
    } catch (e) {
      hint.textContent = e.message;
      return;
    }
    hint.remove();

    if (me.role === "owner") {
      const chat = document.createElement("button");
      chat.className = "btn block";
      chat.textContent = "💬 Чат без проекта";
      chat.onclick = () => createTab({ project: null });
      wrap.appendChild(chat);

      const np = document.createElement("button");
      np.className = "btn block";
      np.textContent = "🆕 Новый проект (папка)";
      np.onclick = () => {
        const name = prompt("Название нового проекта:");
        if (name && name.trim()) createTab({ newProject: name.trim() });
      };
      wrap.appendChild(np);

      const lbl = document.createElement("div");
      lbl.className = "hint";
      lbl.textContent = "Или выберите проект:";
      wrap.appendChild(lbl);
    }

    for (const p of projects) {
      const b = document.createElement("button");
      b.className = "btn block";
      b.textContent = "📁 " + p.name + (p.local ? "" : "  ⤓");
      if (!p.local) b.title = "Будет склонирован с GitHub";
      b.onclick = () => pickProjectSession(p);
      wrap.appendChild(b);
    }
  }

  // Шаг 2: новый диалог или продолжение прошлого
  async function pickProjectSession(p) {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = "📁 " + p.name;
    wrap.appendChild(h);
    const fresh = document.createElement("button");
    fresh.className = "btn primary block";
    fresh.textContent = "🆕 Новый диалог";
    fresh.onclick = () => createTab({ project: p.name });
    wrap.appendChild(fresh);
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Ищу прошлые диалоги…";
    wrap.appendChild(hint);
    openSheet(wrap);

    try {
      const data = await api(
        "/api/project-sessions?name=" + encodeURIComponent(p.name)
      );
      hint.remove();
      if (data.sessions.length > 0) {
        const lbl = document.createElement("div");
        lbl.className = "hint";
        lbl.textContent = "Продолжить прошлый диалог:";
        wrap.appendChild(lbl);
        for (const s of data.sessions) {
          const b = document.createElement("button");
          b.className = "btn block";
          const when = new Date(s.mtime).toLocaleString("ru-RU", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
          b.textContent = s.title;
          const d = document.createElement("span");
          d.className = "b-desc";
          d.textContent = when;
          b.appendChild(d);
          b.onclick = () => createTab({ project: p.name, resume: s.id });
          wrap.appendChild(b);
        }
      }
    } catch {
      hint.textContent = "Прошлые диалоги не загрузились.";
    }
  }

  async function createTab(body) {
    closeSheet();
    try {
      const r = await post("/api/tab", body);
      tabs.push(r.tab);
      renderSessions();
      await selectTab(r.tab.id);
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- Настройки ----------

  function settingsSheet() {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = "Настройки";
    wrap.appendChild(h);

    const autoRow = document.createElement("div");
    autoRow.className = "setting-row";
    const autoLbl = document.createElement("div");
    autoLbl.innerHTML =
      "Авто-режим<br><small style='color:var(--hint)'>Действия без подтверждений</small>";
    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = me.settings.auto;
    const track = document.createElement("span");
    track.className = "track";
    sw.append(cb, track);
    cb.onchange = async () => {
      try {
        const r = await post("/api/settings", { auto: cb.checked });
        me.settings.auto = r.auto;
      } catch (e) {
        toast(e.message);
        cb.checked = me.settings.auto;
      }
    };
    autoRow.append(autoLbl, sw);
    wrap.appendChild(autoRow);

    const models = [
      { v: null, label: "По умолчанию" },
      { v: "opus", label: "Opus" },
      { v: "sonnet", label: "Sonnet" },
      { v: "haiku", label: "Haiku" },
    ];
    const mLbl = document.createElement("div");
    mLbl.className = "hint";
    mLbl.textContent = "Модель:";
    wrap.appendChild(mLbl);
    for (const m of models) {
      const b = document.createElement("button");
      b.className = "btn block";
      if ((me.settings.model ?? null) === m.v) b.classList.add("selected");
      b.textContent = m.label;
      b.onclick = async () => {
        try {
          const r = await post("/api/settings", { model: m.v });
          me.settings.model = r.model;
          settingsSheet(); // перерисовать
        } catch (e) {
          toast(e.message);
        }
      };
      wrap.appendChild(b);
    }
    openSheet(wrap);
  }

  // ---------- Отправка ----------

  async function send() {
    if (!activeTabId) {
      newSessionFlow();
      return;
    }
    const text = inputEl.value.trim();
    if (!text && attachments.length === 0) return;
    const t = findTab(activeTabId);
    const c = tabCache(activeTabId);
    const parts = [];
    for (const a of attachments) parts.push(`Файл: ${a.path}`);
    if (text) parts.push(text);
    const full = parts.join("\n");
    // Ответ на активный вопрос — просто текст, без вложений
    const isAnswer = Boolean(c.question);
    if (t.running && !isAnswer) {
      toast("В этой сессии задача ещё выполняется.");
      return;
    }
    try {
      const r = await post("/api/message", { tab: activeTabId, text: full });
      inputEl.value = "";
      autoGrow();
      attachments = [];
      renderAttachments();
      if (!r.answeredQuestion) {
        addMsg(activeTabId, "user", full);
      }
    } catch (e) {
      toast(e.message);
    }
  }

  function renderAttachments() {
    attachmentsEl.innerHTML = "";
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      const chip = document.createElement("span");
      chip.className = "attach-chip";
      chip.textContent = "📎 " + a.name + " ";
      const del = document.createElement("button");
      del.textContent = "✕";
      del.onclick = () => {
        attachments.splice(i, 1);
        renderAttachments();
      };
      chip.appendChild(del);
      attachmentsEl.appendChild(chip);
    }
  }

  async function uploadFiles(files) {
    if (!activeTabId) {
      toast("Сначала создайте сессию.");
      return;
    }
    for (const f of files) {
      try {
        const r = await api(
          "/api/upload?tab=" +
            encodeURIComponent(activeTabId) +
            "&name=" +
            encodeURIComponent(f.name),
          { method: "POST", body: f }
        );
        attachments.push(r);
      } catch (e) {
        toast(`${f.name}: ${e.message}`);
      }
    }
    renderAttachments();
  }

  // ---------- SSE ----------

  function connectEvents() {
    const es = new EventSource("/api/events?auth=" + encodeURIComponent(initData));
    es.onmessage = (ev) => {
      let e;
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      const t = e.tab ? findTab(e.tab) : null;
      const c = e.tab ? tabCache(e.tab) : null;
      switch (e.type) {
        case "turn_started":
          if (t) t.running = true;
          if (c) c.status = "⏳ Думаю…";
          renderSessions();
          renderStatus();
          break;
        case "status":
          if (c) c.status = e.text;
          if (e.tab === activeTabId) renderStatus();
          break;
        case "tab_title":
          if (t) t.title = e.title;
          renderSessions();
          renderTopbar();
          break;
        case "approval":
          if (c) c.approval = { id: e.id, description: e.description };
          if (e.tab === activeTabId) renderChat();
          else renderSessions();
          break;
        case "approval_done":
          if (c) c.approval = null;
          if (e.tab === activeTabId) renderChat();
          else renderSessions();
          break;
        case "question":
          if (c)
            c.question = {
              id: e.id,
              question: e.question,
              header: e.header,
              multi: e.multi,
              options: e.options,
              selected: new Set(),
            };
          if (e.tab === activeTabId) renderChat();
          else renderSessions();
          break;
        case "question_done":
          if (c) {
            c.question = null;
            if (e.answer) c.msgs.push({ role: "user", text: e.answer });
          }
          if (e.tab === activeTabId) renderChat();
          else renderSessions();
          break;
        case "done":
          if (t) t.running = false;
          if (c) {
            c.status = null;
            c.approval = null;
            c.question = null;
            if (e.text) c.msgs.push({ role: "assistant", text: e.text });
            else if (e.error) c.msgs.push({ role: "error", text: e.error });
            else if (e.aborted)
              c.msgs.push({ role: "notice", text: "⏹ Остановлено." });
          }
          renderSessions();
          if (e.tab === activeTabId) renderChat();
          scheduleLimitsRefresh();
          break;
      }
    };
    es.onerror = () => {
      // браузер переподключится сам
    };
  }

  // ---------- Обработчики ----------

  $("btnNewSession").onclick = newSessionFlow;
  $("btnSettings").onclick = settingsSheet;
  $("btnMenu").onclick = () => toggleSidebar();
  $("sidebarBackdrop").onclick = () => toggleSidebar(false);
  $("btnSend").onclick = send;
  $("btnStop").onclick = () => {
    if (activeTabId) post("/api/stop", { tab: activeTabId }).catch((e) => toast(e.message));
  };
  $("btnAttach").onclick = () => $("fileInput").click();
  $("fileInput").onchange = (e) => {
    uploadFiles([...e.target.files]);
    e.target.value = "";
  };
  inputEl.addEventListener("input", autoGrow);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !tg.platform?.match(/android|ios/)) {
      e.preventDefault();
      send();
    }
  });

  // ---------- Старт ----------

  (async () => {
    try {
      me = await api("/api/me");
    } catch (e) {
      $("guard").hidden = false;
      $("guard").querySelector("p").textContent = e.message;
      return;
    }
    tabs = me.tabs;
    activeTabId = me.activeTabId;
    // Ожидающие карточки с сервера (если приложение переоткрыли)
    for (const t of tabs) {
      const c = tabCache(t.id);
      if (t.pending) {
        if (t.pending.approval) c.approval = t.pending.approval;
        if (t.pending.question) {
          c.question = { ...t.pending.question, selected: new Set() };
        }
      }
    }
    renderAccount();
    renderSessions();
    connectEvents();
    loadLimits();
    if (activeTabId && findTab(activeTabId)) {
      selectTab(activeTabId);
    } else if (tabs.length > 0) {
      selectTab(tabs[tabs.length - 1].id);
    } else {
      renderChat();
    }
  })();
})();

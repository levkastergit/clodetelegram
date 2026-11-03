/* Мини-приложение Telegram для общения с Claude */
(() => {
  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = tg ? tg.initData : "";

  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const inputEl = $("input");
  const statusBar = $("statusBar");
  const statusText = $("statusText");
  const attachmentsEl = $("attachments");

  let me = null; // ответ /api/me
  let attachments = []; // [{path, name}]
  let activeQuestion = null; // {id, multi, selected:Set, labels:[], cardEl}

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
        ...(opts.body && !(opts.body instanceof Blob) && !(opts.body instanceof File)
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
    api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

  // ---------- Утилиты интерфейса ----------

  let toastTimer;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMsg(role, text) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollDown();
    return div;
  }

  function addCard() {
    const div = document.createElement("div");
    div.className = "msg card";
    messagesEl.appendChild(div);
    scrollDown();
    return div;
  }

  function setStatus(text) {
    statusBar.hidden = false;
    statusText.textContent = text;
  }

  function clearStatus() {
    statusBar.hidden = true;
  }

  function button(label, cls, onClick) {
    const b = document.createElement("button");
    b.className = "btn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  // Нумерованный список «1. … 2. …» в ответе — кнопки быстрого ответа
  function detectNumberedOptions(text) {
    const nums = [];
    for (const line of text.split("\n")) {
      const m = /^\s*(\d{1,2})[.)]\s+/.exec(line);
      if (m) nums.push(Number(m[1]));
    }
    const uniq = [...new Set(nums)];
    if (uniq.length >= 2 && uniq.length <= 10 && uniq[0] === 1 && uniq.every((n, i) => n === i + 1)) {
      return uniq;
    }
    return [];
  }

  function offerNumberButtons(text) {
    const nums = detectNumberedOptions(text);
    if (nums.length === 0) return;
    const card = addCard();
    const row = document.createElement("div");
    row.className = "btnrow";
    for (const n of nums) {
      row.appendChild(
        button(String(n), "alt", () => {
          card.remove();
          sendMessage(String(n));
        })
      );
    }
    card.appendChild(row);
    scrollDown();
  }

  // ---------- Подтверждения и вопросы ----------

  const approvalCards = new Map(); // id -> card element

  function showApproval(id, description) {
    if (approvalCards.has(id)) return;
    const card = addCard();
    approvalCards.set(id, card);
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Клод хочет выполнить:";
    const desc = document.createElement("div");
    desc.className = "desc";
    desc.textContent = description;
    const row = document.createElement("div");
    row.className = "btnrow";
    const decide = (allowed) => {
      post("/api/approve", { id, allowed }).catch((e) => toast(e.message));
    };
    row.appendChild(button("✅ Разрешить", "", () => decide(true)));
    row.appendChild(button("❌ Отклонить", "alt", () => decide(false)));
    card.append(title, desc, row);
    scrollDown();
    if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("warning");
  }

  function closeApproval(id, allowed) {
    const card = approvalCards.get(id);
    if (!card) return;
    approvalCards.delete(id);
    card.innerHTML = "";
    const note = document.createElement("div");
    note.className = "hint";
    note.textContent = allowed ? "✅ Разрешено" : "❌ Отклонено";
    card.appendChild(note);
  }

  function showQuestion(q) {
    if (activeQuestion && activeQuestion.id === q.id) return;
    const card = addCard();
    const state = {
      id: q.id,
      multi: Boolean(q.multi),
      selected: new Set(),
      labels: q.options.map((o) => o.label),
      cardEl: card,
    };
    activeQuestion = state;

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "❓ " + q.question;
    card.appendChild(title);

    const answer = (text) => {
      post("/api/answer", { id: q.id, answer: text }).catch((e) => toast(e.message));
    };

    q.options.forEach((o, i) => {
      const b = button(o.label + (o.description ? "\n" + o.description : ""), "option", () => {
        if (state.multi) {
          if (state.selected.has(i)) {
            state.selected.delete(i);
            b.classList.remove("selected");
          } else {
            state.selected.add(i);
            b.classList.add("selected");
          }
        } else {
          answer(state.labels[i]);
        }
      });
      card.appendChild(b);
    });

    if (state.multi) {
      card.appendChild(
        button("✅ Готово", "", () => {
          const chosen = [...state.selected].sort((a, b2) => a - b2).map((i) => state.labels[i]);
          if (chosen.length === 0) {
            toast("Выберите хотя бы один вариант.");
            return;
          }
          answer(chosen.join(", "));
        })
      );
    }

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = state.multi
      ? "Можно выбрать несколько и нажать «Готово», либо написать свой ответ."
      : "Нажмите кнопку либо напишите свой ответ.";
    card.appendChild(hint);
    scrollDown();
    if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("warning");
  }

  function closeQuestion(id, answer) {
    if (!activeQuestion || activeQuestion.id !== id) return;
    const card = activeQuestion.cardEl;
    activeQuestion = null;
    card.innerHTML = "";
    const note = document.createElement("div");
    note.className = "hint";
    note.textContent = answer ? "➡️ " + answer : "Вопрос отменён";
    card.appendChild(note);
  }

  // ---------- Поток событий ----------

  function connectEvents() {
    const es = new EventSource("/api/events?auth=" + encodeURIComponent(initData));
    es.onmessage = (ev) => {
      let e;
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (e.type === "status") {
        setStatus(e.text);
      } else if (e.type === "approval") {
        showApproval(e.id, e.description);
      } else if (e.type === "approval_done") {
        closeApproval(e.id, e.allowed);
      } else if (e.type === "question") {
        showQuestion(e);
      } else if (e.type === "question_done") {
        closeQuestion(e.id, e.answer);
      } else if (e.type === "done") {
        clearStatus();
        if (e.text) {
          addMsg("bot", e.text);
          offerNumberButtons(e.text);
        } else if (e.aborted) {
          addMsg("note", "Задача остановлена.");
        } else if (e.error) {
          addMsg("note", e.error);
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
      }
    };
    es.onerror = () => {
      // браузер переподключится сам; при протухшем initData страницу надо переоткрыть
    };
  }

  // ---------- Отправка сообщений ----------

  function composeText(raw) {
    const lines = attachments.map((a) => "Я прислал файл, он сохранён по пути: " + a.path);
    if (raw) lines.push(raw);
    return lines.join("\n");
  }

  async function sendMessage(raw) {
    const text = composeText(raw.trim());
    if (!text) return;
    try {
      const r = await post("/api/message", { text });
      addMsg("user", raw.trim() || text);
      if (!r.answeredQuestion) setStatus("⏳ Думаю…");
      attachments = [];
      renderAttachments();
      inputEl.value = "";
      autosize();
    } catch (e) {
      toast(e.message);
    }
  }

  $("btnSend").addEventListener("click", () => sendMessage(inputEl.value));
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !tg.platform.match(/android|ios/)) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
  }
  inputEl.addEventListener("input", autosize);

  $("btnStop").addEventListener("click", () => {
    post("/api/stop").catch((e) => toast(e.message));
  });

  // ---------- Файлы ----------

  $("btnAttach").addEventListener("click", () => $("fileInput").click());

  $("fileInput").addEventListener("change", async (e) => {
    for (const file of e.target.files) {
      if (file.size > 50 * 1024 * 1024) {
        toast(`«${file.name}» больше 50 МБ — не загружаю.`);
        continue;
      }
      try {
        setStatus("📤 Загружаю " + file.name + "…");
        const r = await api("/api/upload?name=" + encodeURIComponent(file.name), {
          method: "POST",
          body: file,
          headers: { "Content-Type": "application/octet-stream" },
        });
        attachments.push(r);
        renderAttachments();
      } catch (err) {
        toast("Не удалось загрузить " + file.name + ": " + err.message);
      } finally {
        clearStatus();
      }
    }
    e.target.value = "";
  });

  function renderAttachments() {
    attachmentsEl.innerHTML = "";
    attachments.forEach((a, i) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip";
      chip.textContent = "📎 " + a.name + " ";
      const x = document.createElement("button");
      x.textContent = "✕";
      x.addEventListener("click", () => {
        attachments.splice(i, 1);
        renderAttachments();
      });
      chip.appendChild(x);
      attachmentsEl.appendChild(chip);
    });
  }

  // ---------- Шторка (проекты, сессии, настройки, лимиты) ----------

  const sheet = $("sheet");
  const sheetBody = $("sheetBody");
  $("sheetBackdrop").addEventListener("click", closeSheet);

  function openSheet() {
    sheet.hidden = false;
  }
  function closeSheet() {
    sheet.hidden = true;
    sheetBody.innerHTML = "";
  }

  function sheetTitle(text) {
    const h = document.createElement("h3");
    h.textContent = text;
    sheetBody.appendChild(h);
  }

  function listItem(label, sub, onClick) {
    const b = document.createElement("button");
    b.className = "list-item";
    b.textContent = label;
    if (sub) {
      const s = document.createElement("span");
      s.className = "sub";
      s.textContent = sub;
      b.appendChild(s);
    }
    b.addEventListener("click", onClick);
    sheetBody.appendChild(b);
    return b;
  }

  // Проекты
  $("btnProject").addEventListener("click", async () => {
    sheetBody.innerHTML = "";
    sheetTitle("Проекты");
    openSheet();
    try {
      const r = await api("/api/projects");
      if (me.role === "owner") {
        listItem("💬 Чат без проекта", null, async () => {
          try {
            await post("/api/chat");
            closeSheet();
            await loadMe();
            await loadHistory();
          } catch (e) {
            toast(e.message);
          }
        });
        listItem("➕ Новый проект", null, async () => {
          const name = prompt("Название нового проекта (имя папки):");
          if (!name) return;
          try {
            await post("/api/project/new", { name });
            closeSheet();
            await loadMe();
            messagesEl.innerHTML = "";
            addMsg("note", "Проект создан. Пишите задачу.");
          } catch (e) {
            toast(e.message);
          }
        });
      }
      for (const p of r.projects) {
        listItem(
          (p.local ? "💻 " : "☁️ ") + p.name,
          p.name === r.current ? "текущий" : p.local ? null : "склонируется при выборе",
          () => selectProject(p.name, !p.local)
        );
      }
    } catch (e) {
      toast(e.message);
      closeSheet();
    }
  });

  async function selectProject(name, needsClone) {
    sheetBody.innerHTML = "";
    sheetTitle(needsClone ? "Клонирую «" + name + "»…" : "Открываю «" + name + "»…");
    try {
      const r = await post("/api/project", { name });
      showSessions(name, r.sessions);
    } catch (e) {
      toast(e.message);
      closeSheet();
    }
  }

  function showSessions(project, sessions) {
    sheetBody.innerHTML = "";
    sheetTitle("«" + project + "»: диалог");
    listItem("🆕 Новый диалог", null, async () => {
      try {
        await post("/api/session", { id: null });
        closeSheet();
        await loadMe();
        messagesEl.innerHTML = "";
        addMsg("note", "Новый диалог — пишите задачу.");
      } catch (e) {
        toast(e.message);
      }
    });
    for (const s of sessions) {
      const d = new Date(s.mtime);
      const when = d.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      listItem(s.title.slice(0, 60) || "(без названия)", when, async () => {
        try {
          await post("/api/session", { id: s.id });
          closeSheet();
          await loadMe();
          await loadHistory();
        } catch (e) {
          toast(e.message);
        }
      });
    }
    if (sessions.length === 0) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Прошлых диалогов нет.";
      sheetBody.appendChild(p);
    }
  }

  // Настройки
  $("btnSettings").addEventListener("click", () => {
    sheetBody.innerHTML = "";
    sheetTitle("Настройки");
    openSheet();

    const autoRow = document.createElement("div");
    autoRow.className = "setting-row";
    const autoLabel = document.createElement("div");
    autoLabel.innerHTML =
      "Авто-режим<br><small style='color:var(--hint)'>выполнять действия без подтверждений</small>";
    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = me.state.auto;
    const track = document.createElement("span");
    track.className = "track";
    sw.append(cb, track);
    cb.addEventListener("change", async () => {
      try {
        const r = await post("/api/settings", { auto: cb.checked });
        me.state.auto = r.auto;
      } catch (e) {
        toast(e.message);
        cb.checked = me.state.auto;
      }
    });
    autoRow.append(autoLabel, sw);
    sheetBody.appendChild(autoRow);

    const modelRow = document.createElement("div");
    modelRow.className = "setting-row";
    const ml = document.createElement("div");
    ml.textContent = "Модель";
    const seg = document.createElement("div");
    seg.className = "seg";
    const models = [
      { label: "По умолч.", value: null },
      { label: "Opus", value: "opus" },
      { label: "Sonnet", value: "sonnet" },
      { label: "Haiku", value: "haiku" },
    ];
    const rerender = () => {
      seg.innerHTML = "";
      for (const m of models) {
        const b = button(m.label, me.state.model === m.value ? "" : "alt", async () => {
          try {
            const r = await post("/api/settings", { model: m.value });
            me.state.model = r.model;
            rerender();
          } catch (e) {
            toast(e.message);
          }
        });
        seg.appendChild(b);
      }
    };
    rerender();
    modelRow.append(ml, seg);
    sheetBody.appendChild(modelRow);
  });

  // Лимиты
  $("btnLimits").addEventListener("click", async () => {
    sheetBody.innerHTML = "";
    sheetTitle("Лимиты подписки");
    openSheet();
    const pre = document.createElement("pre");
    pre.className = "limits";
    pre.textContent = "⏳ Запрашиваю…";
    sheetBody.appendChild(pre);
    try {
      const r = await api("/api/limits");
      pre.textContent = r.lines.join("\n");
    } catch (e) {
      pre.textContent = e.message;
    }
  });

  // ---------- Загрузка состояния ----------

  function headerLabel() {
    const s = me.state;
    return s.mode === "project" && s.project ? "📁 " + s.project : "💬 Чат";
  }

  async function loadMe() {
    me = await api("/api/me");
    $("btnProject").textContent = headerLabel();
    $("btnLimits").hidden = me.role !== "owner";
    if (me.running) setStatus("⏳ Выполняется задача…");
    else clearStatus();
    if (me.pending.approval) showApproval(me.pending.approval.id, me.pending.approval.description);
    if (me.pending.question) {
      showQuestion({
        id: me.pending.question.id,
        question: me.pending.question.question,
        multi: me.pending.question.multi,
        options: me.pending.question.options,
      });
    }
  }

  async function loadHistory() {
    messagesEl.innerHTML = "";
    try {
      const r = await api("/api/history");
      for (const m of r.messages) addMsg(m.role === "user" ? "user" : "bot", m.text);
      if (r.messages.length === 0) {
        addMsg("note", me.role === "guest"
          ? "Доступен проект «" + (me.state.project || "") + "». Пишите задачу."
          : "Пишите задачу — или выберите проект сверху.");
      }
      scrollDown();
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- Старт ----------

  (async () => {
    try {
      await loadMe();
    } catch (e) {
      $("guard").hidden = false;
      $("guard").querySelector("p").textContent = e.message;
      return;
    }
    connectEvents();
    await loadHistory();
  })();
})();

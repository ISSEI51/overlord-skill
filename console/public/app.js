const STATES = [
  { key: "inbox", label: "受信箱" },
  { key: "discovery", label: "調査中" },
  { key: "specified", label: "実装準備完了" },
  { key: "implementing", label: "実装中" },
  { key: "reviewing", label: "確認中" },
  { key: "acceptance", label: "完成確認待ち" },
  { key: "done", label: "完了" },
  { key: "blocked", label: "停止中" },
];

const ACTIVE_STATES = ["discovery", "specified", "implementing", "reviewing", "acceptance"];
const SCREEN_INTERVAL_MS = 1500;
const DOCK_WIDTH_KEY = "overlord.dockWidth";

const view = {
  data: null,
  selectedId: null,
  screenText: "",
  screenError: null,
  screenTimer: null,
  setupOpen: false,
  setupBuilt: false,
  composeBuilt: false,
  /** Unsent commander draft; survives any dock rebuild. */
  draft: "",
};

const $ = (selector) => document.querySelector(selector);

/* ------------------------------------------------------------------ api */

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function toast(message, bad = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("bad", bad);
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, bad ? 6000 : 2500);
}

async function load() {
  try {
    view.data = await api("/api/state");
    render();
  } catch (error) {
    toast(`ボードを読み込めません: ${error.message}`, true);
  }
}

async function patchItem(id, patch) {
  const result = await api(`/api/items/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ rev: view.data.rev, patch }),
  });
  view.data.rev = result.rev;
  const index = view.data.board.items.findIndex((item) => item.id === id);
  if (index >= 0) view.data.board.items[index] = result.item;
  render();
  return result.item;
}

async function setCommander(link) {
  const result = await api("/api/commander", {
    method: "PUT",
    body: JSON.stringify({ rev: view.data.rev, commander: link }),
  });
  view.data.rev = result.rev;
  view.data.board.commander = result.commander;
  view.screenText = "";
  view.screenError = null;
  view.setupOpen = false;
  view.setupBuilt = false;
  render();
}

/* --------------------------------------------------------------- render */

function render() {
  if (!view.data) return;
  renderHeader();
  renderDecisions();
  renderBoard();
  renderDetail();
  renderDock();
}

function renderHeader() {
  const { boardPath, exists, cmux } = view.data;
  const path = $("#board-path");
  path.textContent = boardPath;
  path.title = exists ? boardPath : `${boardPath}（未作成）`;

  const items = view.data.board.items ?? [];
  const implementing = items.filter((item) => item.state === "implementing").length;
  const active = items.filter((item) => ACTIVE_STATES.includes(item.state)).length;
  const warnings = [];
  if (implementing > 3) warnings.push(`実装中 ${implementing} 件（上限3）`);
  if (active > 10) warnings.push(`進行中 ${active} 件（上限10）`);
  $("#wip").textContent = warnings.join(" / ");

  const conn = $("#conn");
  conn.textContent = cmux.available ? "cmux 接続済み" : "cmux 未接続";
  conn.className = `pill ${cmux.available ? "ok" : "bad"}`;
  conn.title = cmux.error ?? "";
}

function renderDecisions() {
  const raw = view.data.board.decisions_required ?? [];
  const section = $("#decisions");
  const list = $("#decision-list");
  list.replaceChildren();
  if (raw.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  for (const entry of raw.slice(0, 3)) {
    const text = typeof entry === "string" ? entry : (entry.question ?? entry.title ?? "");
    const id = typeof entry === "object" ? (entry.id ?? null) : findIdInText(text);
    const node = document.createElement("div");
    node.className = "decision";
    node.textContent = text;
    if (id) {
      node.title = `${id} を開く`;
      node.addEventListener("click", () => select(id));
    }
    list.append(node);
  }
}

function findIdInText(text) {
  const match = String(text).match(/\b[A-Z]{2,6}-[A-Z0-9]{1,6}-?\d{2,4}\b/);
  return match ? match[0] : null;
}

function renderBoard() {
  const board = $("#board");
  board.replaceChildren();
  const items = view.data.board.items ?? [];
  for (const state of STATES) {
    const columnItems = items.filter((item) => item.state === state.key);
    const column = document.createElement("section");
    column.className = "column";
    if (state.key === "implementing" && columnItems.length > 3) {
      column.classList.add("over-limit");
    }
    column.dataset.state = state.key;

    const head = document.createElement("div");
    head.className = "column-head";
    head.innerHTML = `<span>${state.label}</span><span class="count">${columnItems.length}</span>`;

    const body = document.createElement("div");
    body.className = "column-body";
    for (const item of columnItems) body.append(cardNode(item));

    column.append(head, body);
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      column.classList.add("drop");
    });
    column.addEventListener("dragleave", () => column.classList.remove("drop"));
    column.addEventListener("drop", async (event) => {
      event.preventDefault();
      column.classList.remove("drop");
      const id = event.dataTransfer.getData("text/plain");
      const item = items.find((entry) => entry.id === id);
      if (!item || item.state === state.key) return;
      try {
        await patchItem(id, { state: state.key });
        toast(`${id} を「${state.label}」へ移動`);
      } catch (error) {
        toast(`移動できません: ${error.message}`, true);
        await load();
      }
    });
    board.append(column);
  }
}

function cardNode(item) {
  const node = document.createElement("article");
  node.className = "card";
  node.draggable = true;
  if (item.id === view.selectedId) node.classList.add("selected");

  const score = scoreOf(item);
  const top = document.createElement("div");
  top.className = "card-top";
  top.innerHTML =
    `<span class="card-id">${escapeHtml(item.id)}</span>` +
    (score === null ? "" : `<span class="card-score">${score}</span>`);

  const title = document.createElement("h3");
  title.className = "card-title";
  title.textContent = item.title ?? "";

  node.append(top, title);

  if (item.next_action) {
    const next = document.createElement("div");
    next.className = "card-next";
    next.textContent = `→ ${item.next_action}`;
    node.append(next);
  }

  const tags = document.createElement("div");
  tags.className = "card-tags";
  if (item.project) tags.append(tagNode(item.project));
  if (item.owner) tags.append(tagNode(item.owner));
  if (item.agent?.surface_id) tags.append(tagNode("担当あり", "agent"));
  if (item.blocker) tags.append(tagNode("停止中", "blocked"));
  if (tags.children.length > 0) node.append(tags);

  node.addEventListener("click", () => select(item.id));
  node.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", item.id);
    node.classList.add("dragging");
  });
  node.addEventListener("dragend", () => node.classList.remove("dragging"));
  return node;
}

function tagNode(text, extra = "") {
  const node = document.createElement("span");
  node.className = `tag ${extra}`.trim();
  node.textContent = text;
  return node;
}

function scoreOf(item) {
  const priority = item.priority;
  if (!priority) return null;
  const values = ["impact", "urgency", "confidence", "ease"]
    .map((key) => priority[key])
    .filter((value) => typeof value === "number");
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return `${total}/${values.length * 5}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character],
  );
}

/* --------------------------------------------------------------- detail */

function currentItem() {
  return (view.data?.board.items ?? []).find((item) => item.id === view.selectedId) ?? null;
}

function select(id) {
  view.selectedId = id;
  render();
}

function closeDetail() {
  view.selectedId = null;
  render();
}

function renderDetail() {
  const panel = $("#detail");
  const item = currentItem();
  if (!item) {
    panel.hidden = true;
    return;
  }
  const active = document.activeElement;
  if (
    !panel.hidden &&
    active &&
    panel.contains(active) &&
    (active.tagName === "TEXTAREA" || active.tagName === "INPUT")
  ) {
    return;
  }
  panel.hidden = false;
  $("#detail-id").textContent = [item.id, item.project].filter(Boolean).join("  ·  ");
  $("#detail-title").textContent = item.title ?? "";

  const root = $("#detail-body");
  root.replaceChildren();

  root.append(commandField(item));

  const stateField = fieldNode("状態");
  const stateSelect = document.createElement("select");
  for (const state of STATES) {
    const option = document.createElement("option");
    option.value = state.key;
    option.textContent = state.label;
    option.selected = state.key === item.state;
    stateSelect.append(option);
  }
  stateSelect.addEventListener("change", async () => {
    try {
      await patchItem(item.id, { state: stateSelect.value });
    } catch (error) {
      toast(`更新できません: ${error.message}`, true);
      await load();
    }
  });
  stateField.append(stateSelect);
  root.append(stateField);

  root.append(editableField(item, "next_action", "次にすること"));
  root.append(editableField(item, "owner", "担当"));
  root.append(editableField(item, "blocker", "止まっている理由"));
  root.append(workerField(item));
  root.append(readonlyField("困っていることと根拠", item.evidence));

  const conditions = item.acceptance_conditions ?? [];
  const conditionField = fieldNode("完成の条件");
  if (conditions.length === 0) {
    conditionField.append(emptyValue());
  } else {
    const list = document.createElement("ul");
    list.className = "conditions";
    for (const condition of conditions) {
      const entry = document.createElement("li");
      entry.textContent = condition;
      list.append(entry);
    }
    conditionField.append(list);
  }
  root.append(conditionField);

  root.append(readonlyField("今回はやらないこと", item.out_of_scope));

  for (const [key, label] of [
    ["brief", "実装前メモ"],
    ["review", "確認結果"],
  ]) {
    if (item[key]) root.append(readonlyField(label, formatValue(item[key])));
  }

  const updated = fieldNode("更新");
  const stamp = document.createElement("div");
  stamp.className = "value empty";
  stamp.textContent = item.updated_at ?? "-";
  updated.append(stamp);
  root.append(updated);
}

/** Card actions are phrased as instructions to the commander, never sent directly. */
function commandField(item) {
  const field = fieldNode("司令塔への指示");
  const row = document.createElement("div");
  row.className = "templates";
  for (const template of cardInstructions(item)) {
    const button = document.createElement("button");
    button.className = "btn";
    button.textContent = template.label;
    button.addEventListener("click", () => fillCompose(template.text));
    row.append(button);
  }
  field.append(row);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "指示文は司令塔の入力欄に入ります。送信はあなたが押したときだけです。";
  field.append(hint);
  return field;
}

function cardInstructions(item) {
  return [
    { label: "状況を聞く", text: `${item.id} の状況と次の一手を3行以内で教えてください。` },
    {
      label: "進める",
      text:
        `${item.id} を進めてください。担当のサブエージェントを起動し、` +
        "このカードの状態に必要な作業だけを行わせてください。",
    },
    {
      label: "実装ブリーフ",
      text: `${item.id} の実装ブリーフを作成してください。`,
    },
    {
      label: "独立レビュー",
      text: `${item.id} の独立レビューを、実装したサブエージェントとは別のサブエージェントで実行してください。`,
    },
    {
      label: "完了の可否",
      text: `${item.id} を完了にしてよいか、完成の条件ごとの結果で教えてください。`,
    },
  ];
}

/** Read-only view of the worker session the commander assigned to this card. */
function workerField(item) {
  const field = fieldNode("担当セッション");
  const link = item.agent?.surface_id
    ? terminalSurfaces().find((entry) => entry.surface.id === item.agent.surface_id)
    : null;
  if (!item.agent?.surface_id) {
    const node = document.createElement("div");
    node.className = "value empty";
    node.textContent = "未割り当て（司令塔が起動します）";
    field.append(node);
    return field;
  }
  const row = document.createElement("div");
  row.className = "row";
  const name = document.createElement("div");
  name.className = "value";
  name.textContent = link
    ? `${link.workspace.title || link.workspace.ref} / ${link.surface.title || link.surface.ref}`
    : "記録されたセッションは見つかりません（終了済み）";
  row.append(name);
  if (link) {
    const focus = document.createElement("button");
    focus.className = "btn";
    focus.textContent = "cmux で開く";
    focus.addEventListener("click", async () => {
      try {
        await api("/api/cmux/focus", {
          method: "POST",
          body: JSON.stringify({
            workspace: link.workspace.ref,
            surfaceId: link.surface.id,
          }),
        });
      } catch (error) {
        toast(`開けません: ${error.message}`, true);
      }
    });
    row.append(focus);
  }
  field.append(row);
  if (item.agent.cwd) {
    const cwd = document.createElement("div");
    cwd.className = "hint";
    cwd.textContent = item.agent.cwd;
    field.append(cwd);
  }
  return field;
}

function formatValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function fieldNode(label) {
  const field = document.createElement("div");
  field.className = "field";
  const caption = document.createElement("label");
  caption.textContent = label;
  field.append(caption);
  return field;
}

function emptyValue() {
  const node = document.createElement("div");
  node.className = "value empty";
  node.textContent = "—";
  return node;
}

function readonlyField(label, value) {
  const field = fieldNode(label);
  if (!value) {
    field.append(emptyValue());
    return field;
  }
  const node = document.createElement("div");
  node.className = "value";
  node.textContent = value;
  field.append(node);
  return field;
}

function editableField(item, key, label) {
  const field = fieldNode(label);
  const input = document.createElement("input");
  input.type = "text";
  input.value = item[key] ?? "";
  input.placeholder = "—";
  const commit = async () => {
    const next = input.value.trim() === "" ? null : input.value;
    if ((item[key] ?? null) === next) return;
    try {
      await patchItem(item.id, { [key]: next });
    } catch (error) {
      toast(`更新できません: ${error.message}`, true);
      await load();
    }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") {
      // Cancel, don't save: restore the original value so the blur commit
      // sees no change, and keep the panel open.
      event.stopPropagation();
      input.value = item[key] ?? "";
      input.blur();
    }
  });
  field.append(input);
  return field;
}

/* ------------------------------------------------------------ commander */

function terminalSurfaces() {
  const workspaces = view.data?.cmux.workspaces ?? [];
  return workspaces.flatMap((workspace) =>
    workspace.surfaces
      .filter((surface) => surface.type === "terminal")
      .map((surface) => ({ workspace, surface })),
  );
}

function commanderLink() {
  const id = view.data?.board.commander?.surface_id;
  if (!id) return null;
  return terminalSurfaces().find((entry) => entry.surface.id === id) ?? null;
}

function renderDock() {
  const link = commanderLink();
  const configured = Boolean(view.data.board.commander?.surface_id);
  const ready = Boolean(link) && !view.setupOpen;

  const name = $("#commander-name");
  name.textContent = link
    ? `${link.workspace.title || link.workspace.ref} / ${link.surface.title || link.surface.ref}`
    : configured
      ? "記録されたセッションが見つかりません"
      : "未設定";

  const controls = $("#dock-controls");
  controls.replaceChildren();
  if (ready) {
    controls.append(
      dockButton("cmux で開く", async () => {
        await api("/api/cmux/focus", {
          method: "POST",
          body: JSON.stringify({ workspace: link.workspace.ref, surfaceId: link.surface.id }),
        });
      }),
    );
    controls.append(
      dockButton("変更", () => {
        view.setupOpen = true;
        view.setupBuilt = false;
        render();
      }),
    );
  } else if (view.setupOpen && configured) {
    controls.append(
      dockButton("戻る", () => {
        view.setupOpen = false;
        render();
      }),
    );
  }

  const screen = $("#commander-screen");
  screen.hidden = !ready;
  if (ready) {
    // Content is owned by refreshScreen so a board re-render never scrolls it.
    startScreenPolling(link.surface.id);
  } else {
    stopScreenPolling();
    screen.textContent = "";
  }

  if (!ready) {
    renderSetup();
    return;
  }
  renderCompose();
}

function dockButton(label, action) {
  const button = document.createElement("button");
  button.className = "btn";
  button.textContent = label;
  button.addEventListener("click", async () => {
    try {
      await action();
    } catch (error) {
      toast(error.message, true);
    }
  });
  return button;
}

function renderSetup() {
  const root = $("#dock-compose");
  if (view.setupBuilt) return;
  view.setupBuilt = true;
  view.composeBuilt = false;
  root.replaceChildren();

  if (!view.data.cmux.available) {
    const notice = document.createElement("div");
    notice.className = "notice bad";
    notice.textContent =
      view.data.cmux.error ?? "cmux に接続できません。cmux アプリが起動しているか確認してください。";
    root.append(notice);
    return;
  }

  const field = fieldNode("司令塔にするセッション");
  const picker = document.createElement("select");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "選んでください";
  picker.append(none);
  for (const workspace of view.data.cmux.workspaces) {
    const group = document.createElement("optgroup");
    group.label = workspace.title || workspace.ref;
    for (const surface of workspace.surfaces.filter((entry) => entry.type === "terminal")) {
      const option = document.createElement("option");
      option.value = surface.id;
      option.textContent = surface.title || surface.ref;
      option.title = workspace.latestMessage ?? "";
      group.append(option);
    }
    if (group.children.length > 0) picker.append(group);
  }
  field.append(picker);

  const row = document.createElement("div");
  row.className = "row";
  row.style.marginTop = "8px";

  const apply = document.createElement("button");
  apply.className = "btn primary";
  apply.textContent = "このセッションを司令塔にする";
  apply.addEventListener("click", async () => {
    const entry = terminalSurfaces().find((candidate) => candidate.surface.id === picker.value);
    if (!entry) {
      toast("セッションを選んでください", true);
      return;
    }
    try {
      await setCommander({
        workspace_id: entry.workspace.id,
        surface_id: entry.surface.id,
        cwd: entry.workspace.cwd ?? null,
      });
      toast("司令塔を設定しました");
    } catch (error) {
      toast(`設定できません: ${error.message}`, true);
    }
  });
  row.append(apply);

  const create = document.createElement("button");
  create.className = "btn";
  create.textContent = "司令塔を新しく起動";
  row.append(create);

  const refresh = document.createElement("button");
  refresh.className = "btn";
  refresh.textContent = "一覧を更新";
  refresh.addEventListener("click", async () => {
    view.setupBuilt = false;
    await load();
  });
  row.append(refresh);

  field.append(row);

  // Inline directory field for a new commander workspace (no window.prompt).
  const createForm = document.createElement("div");
  createForm.className = "inline-form";
  createForm.hidden = true;
  const cwdInput = document.createElement("input");
  cwdInput.type = "text";
  cwdInput.value = view.data.projectRoot;
  cwdInput.placeholder = "司令塔を動かすディレクトリ";
  const launch = document.createElement("button");
  launch.className = "btn primary";
  launch.textContent = "起動";
  launch.addEventListener("click", () => {
    const cwd = cwdInput.value.trim();
    if (cwd === "") {
      toast("ディレクトリを入力してください", true);
      return;
    }
    void startCommanderWorkspace(cwd);
  });
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "キャンセル";
  cancel.addEventListener("click", () => {
    createForm.hidden = true;
  });
  createForm.append(cwdInput, launch, cancel);
  field.append(createForm);
  create.addEventListener("click", () => {
    createForm.hidden = false;
    cwdInput.focus();
  });

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.style.marginTop = "8px";
  hint.textContent =
    "司令塔は1つだけです。各カードの作業は司令塔がサブエージェントを起動して進めます。";
  field.append(hint);

  root.append(field);
}

async function startCommanderWorkspace(cwd) {
  try {
    const result = await api("/api/cmux/workspace", {
      method: "POST",
      body: JSON.stringify({
        name: "Overlord 司令塔",
        cwd,
        command: "claude",
        description: "Overlord Console の司令塔セッション",
      }),
    });
    await load();
    const created = result.workspace;
    const surface = created?.surfaces?.find((entry) => entry.type === "terminal");
    if (!created || !surface) {
      toast("ワークスペースを作成しました。一覧から選んでください。");
      view.setupBuilt = false;
      render();
      return;
    }
    await setCommander({ workspace_id: created.id, surface_id: surface.id, cwd });
    fillCompose(
      "/product-ops この会話を Overlord の司令塔にしてください。" +
        "docs/product-ops/board.yaml を読み、今日の状況を整理してください。",
    );
    toast("司令塔を起動しました");
  } catch (error) {
    toast(`起動できません: ${error.message}`, true);
  }
}

/** The compose box is built once so typing survives board re-renders. */
function renderCompose() {
  const root = $("#dock-compose");
  if (view.composeBuilt) return;
  view.composeBuilt = true;
  view.setupBuilt = false;
  root.replaceChildren();

  const templates = document.createElement("div");
  templates.className = "templates";
  for (const template of dockTemplates()) {
    const button = document.createElement("button");
    button.className = "btn";
    button.textContent = template.label;
    button.addEventListener("click", () => fillCompose(template.text));
    templates.append(button);
  }
  root.append(templates);

  const input = document.createElement("textarea");
  input.id = "compose-input";
  input.placeholder = "司令塔への指示（⌘Enter または Ctrl+Enter で送信）";
  input.value = view.draft;
  input.addEventListener("input", () => {
    view.draft = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send(true);
    }
  });
  root.append(input);

  const actions = document.createElement("div");
  actions.className = "row";
  actions.style.marginTop = "8px";

  const sendButton = document.createElement("button");
  sendButton.className = "btn primary";
  sendButton.textContent = "送信";
  sendButton.addEventListener("click", () => send(true));
  actions.append(sendButton);

  const pasteButton = document.createElement("button");
  pasteButton.className = "btn";
  pasteButton.textContent = "貼り付けのみ";
  pasteButton.addEventListener("click", () => send(false));
  actions.append(pasteButton);

  for (const [key, label] of [
    ["enter", "Enter"],
    ["escape", "Esc"],
    ["up", "↑"],
    ["down", "↓"],
  ]) {
    const button = document.createElement("button");
    button.className = "btn";
    button.textContent = label;
    button.title = `cmux send-key ${key}`;
    button.addEventListener("click", () => sendKey(key));
    actions.append(button);
  }

  // Two presses within three seconds interrupt; no native dialog.
  const interrupt = document.createElement("button");
  interrupt.className = "btn danger";
  interrupt.textContent = "中断";
  let armTimer = null;
  const disarm = () => {
    clearTimeout(armTimer);
    interrupt.classList.remove("armed");
    interrupt.textContent = "中断";
  };
  interrupt.addEventListener("click", () => {
    if (interrupt.classList.contains("armed")) {
      disarm();
      void sendKey("ctrl+c");
      return;
    }
    interrupt.classList.add("armed");
    interrupt.textContent = "もう一度で中断";
    armTimer = setTimeout(disarm, 3000);
  });
  actions.append(interrupt);

  root.append(actions);
}

function dockTemplates() {
  return [
    {
      label: "今日の状況",
      text:
        "/product-ops 今日の作業状況を整理してください。" +
        "私が決めることは最大3件、実際に試して確認する操作は最大3本に絞ってください。" +
        "各案件は次の一手を1つだけ示してください。",
    },
    {
      label: "作業を割り当て",
      text:
        "空いている実装枠に作業を割り当ててください。" +
        "1件ごとに別のサブエージェントと作業用フォルダを使い、" +
        "docs/product-ops/board.yaml の担当と状態を更新してください。",
    },
    {
      label: "気づきをカードに",
      text: "/product-improvement-card ",
    },
    {
      label: "ボード更新",
      text: "docs/product-ops/board.yaml を現在の状況に合わせて更新してください。",
    },
  ];
}

function fillCompose(text) {
  const input = $("#compose-input");
  if (!input) {
    toast("先に司令塔を設定してください", true);
    return;
  }
  // Never overwrite an unsent draft; append below it instead.
  const draft = input.value;
  const next = draft.trim() === "" ? text : `${draft.replace(/\n+$/, "")}\n${text}`;
  input.value = next;
  view.draft = next;
  input.focus();
  input.setSelectionRange(next.length, next.length);
  if (draft.trim() !== "") toast("下書きの末尾に追記しました");
}

async function send(submit) {
  const link = commanderLink();
  const input = $("#compose-input");
  if (!link || !input) return;
  const text = input.value;
  if (text.trim() === "") return;
  try {
    await api("/api/cmux/send", {
      method: "POST",
      body: JSON.stringify({ surface: link.surface.id, text, submit }),
    });
    input.value = "";
    view.draft = "";
    toast(submit ? "送信しました" : "貼り付けました");
    setTimeout(() => refreshScreen(link.surface.id), 400);
  } catch (error) {
    toast(`送信できません: ${error.message}`, true);
  }
}

async function sendKey(key) {
  const link = commanderLink();
  if (!link) return;
  try {
    await api("/api/cmux/key", {
      method: "POST",
      body: JSON.stringify({ surface: link.surface.id, key }),
    });
    setTimeout(() => refreshScreen(link.surface.id), 300);
  } catch (error) {
    toast(`キーを送れません: ${error.message}`, true);
  }
}

function startScreenPolling(surfaceId) {
  if (view.screenTimer?.surfaceId === surfaceId) return;
  stopScreenPolling();
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") void refreshScreen(surfaceId);
  }, SCREEN_INTERVAL_MS);
  view.screenTimer = { surfaceId, timer };
  void refreshScreen(surfaceId);
}

function stopScreenPolling() {
  if (view.screenTimer) clearInterval(view.screenTimer.timer);
  view.screenTimer = null;
}

async function refreshScreen(surfaceId) {
  try {
    const result = await api(`/api/cmux/screen?surface=${encodeURIComponent(surfaceId)}&lines=120`);
    view.screenText = result.text;
    view.screenError = null;
  } catch (error) {
    view.screenError = `画面を読めません: ${error.message}`;
  }
  const screen = $("#commander-screen");
  if (!screen || screen.hidden) return;
  const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 24;
  screen.textContent = view.screenError ?? view.screenText;
  screen.classList.toggle("stale", Boolean(view.screenError));
  if (atBottom) screen.scrollTop = screen.scrollHeight;
}

/* ----------------------------------------------------------------- wire */

function setDockWidth(width) {
  const clamped = Math.min(Math.max(width, 360), window.innerWidth * 0.7);
  document.documentElement.style.setProperty("--dock-width", `${Math.round(clamped)}px`);
  try {
    localStorage.setItem(DOCK_WIDTH_KEY, String(Math.round(clamped)));
  } catch {
    /* private windows and blocked storage are fine */
  }
}

try {
  const stored = Number(localStorage.getItem(DOCK_WIDTH_KEY));
  if (Number.isFinite(stored) && stored > 0) setDockWidth(stored);
} catch {
  /* ignore */
}

$("#resizer").addEventListener("mousedown", (event) => {
  event.preventDefault();
  const resizer = $("#resizer");
  resizer.classList.add("active");
  const move = (moveEvent) => setDockWidth(window.innerWidth - moveEvent.clientX);
  const up = () => {
    resizer.classList.remove("active");
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
});

$("#detail-close").addEventListener("click", closeDetail);

/* Card creation dialog: cancel and Escape keep what was typed. */
const cardDialog = $("#card-dialog");
$("#new-card").addEventListener("click", () => {
  cardDialog.showModal();
  $("#card-title").focus();
});
$("#card-cancel").addEventListener("click", () => cardDialog.close());
cardDialog.addEventListener("keydown", (event) => {
  // The dialog handles its own Escape; don't also close the card detail.
  if (event.key === "Escape") event.stopPropagation();
});
cardDialog.querySelector("form").addEventListener("submit", async (event) => {
  const title = $("#card-title").value.trim();
  if (title === "") {
    event.preventDefault();
    toast("見出しを入力してください", true);
    return;
  }
  try {
    const result = await api("/api/items", {
      method: "POST",
      body: JSON.stringify({
        title,
        project: $("#card-project").value.trim() || undefined,
        evidence: $("#card-evidence").value.trim() || undefined,
      }),
    });
    $("#card-title").value = "";
    $("#card-evidence").value = "";
    await load();
    select(result.item.id);
  } catch (error) {
    event.preventDefault();
    toast(`追加できません: ${error.message}`, true);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.activeElement?.tagName !== "TEXTAREA") {
    closeDetail();
  }
});

function connectEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "board" && payload.rev !== view.data?.rev) void load();
  };
  source.onerror = () => {
    source.close();
    setTimeout(connectEvents, 2000);
  };
}

await load();
connectEvents();
setInterval(() => {
  if (document.visibilityState === "visible") void load();
}, 15000);

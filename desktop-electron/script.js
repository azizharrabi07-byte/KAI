'use strict';

I18n.apply();

const app = document.querySelector('.app');
const sidebar = document.querySelector('.sidebar');
const sidebarToggle = document.querySelector('.sidebar-toggle');
const search = document.querySelector('.sidebar-search');
const searchButton = document.querySelector('.sidebar-search-button');
const searchInput = document.querySelector('.sidebar-search-input');
const main = document.querySelector('.main');
const thread = document.querySelector('.thread');
const composer = document.querySelector('.composer');
const composerField = document.querySelector('.composer-field');
const composerInput = document.querySelector('.composer-input');
const composerSend = document.querySelector('.composer-send');

let chatList = null;
let folderPill = null;
let modelStage = null;
let effortSlider = null;

new SmoothHeight(composerField, composerInput);
new ResizeObserver(() => {
  const gap = parseFloat(getComputedStyle(main).getPropertyValue('--composer-bottom-gap')) || 0;
  main.style.setProperty('--composer-space', `${Math.ceil(composer.offsetHeight + gap)}px`);
}).observe(composer);
new Scrollbar(composerInput, document.querySelector('.composer-scrollbar'));
const threadScrollbar = new Scrollbar(thread, document.querySelector('.thread-scrollbar'));
new Scrollbar(document.querySelector('.chats-scroll'), document.querySelector('.chats-scrollbar'));
const composerText = new ComposerText(composerInput, document.querySelector('.composer-mirror'));
LinkChip.watch(document.querySelector('.composer-mirror'));
LinkChip.watch(thread);
const settings = new Settings(document.querySelector('.settings'));
new GeneralSettings({ root: document.querySelector('#settings-general'), context: UserContext });
new AppearanceSettings(document.querySelector('#settings-appearance'));
new CharacterSettings(document.querySelector('#settings-character'));
new UsageSettings({ root: document.querySelector('#settings-usage'), settings, dialog: settings.dialog });
const settingsScrollbar = new Scrollbar(document.querySelector('.settings-page'), document.querySelector('.settings-scrollbar'));
for (const panel of document.querySelectorAll('.settings-panel')) settingsScrollbar.observe(panel);
const threadBottom = document.querySelector('.thread-bottom');
new LiquidGlass(threadBottom, { width: 36, height: 36 });
const library = new Library(ChatStore, syncAll);
window.addEventListener('pagehide', () => {
  library.flush();
  UserContext.flush();
  Usage.flush();
});
const chat = new Chat({ main, thread, bottom: threadBottom, settings, library, onChange: syncAll, onList: list => threadScrollbar.observe(list) });
// The access mode is per CONVERSATION at its highest setting, because Core refuses a
// global elevation by design. The shell owns the active conversation, so it is the one
// place that can name it.
settings.threadIdOf = () => chat.activeId || undefined;
// ── The access-mode button must show what CORE enforces ───────────────────────
// The stored value is the user's last click; Core may have refused or parked it, in
// which case the OLD mode is in force. Read it back with a bounded retry (a Core this
// app just spawned answers only once it has booted), and again whenever a change is not
// applied. Without this the button can claim "Full access" while Core runs "Ask".
let modeSyncAttempts = 0;
function syncModeFromCore() {
  if (!window.KAI2 || !window.KAI2.policy) return;
  window.KAI2.policy.read().then((state) => {
    if (!state || state.ok !== true || !state.mode) {
      // Not ready (or no owner credential): try again shortly, a few times only.
      if (modeSyncAttempts++ < 10) setTimeout(syncModeFromCore, 1500);
      return;
    }
    if (state.mode === settings.mode) return;
    settings.mode = state.mode;
    window.ModePicker?.syncAll?.();
  }).catch(() => {
    if (modeSyncAttempts++ < 10) setTimeout(syncModeFromCore, 1500);
  });
}
settings.onModeResult = (_mode, result) => {
  // Applied -> nothing to correct. Refused or parked -> show what really is in force.
  if (result && result.ok === true) return;
  modeSyncAttempts = 0;
  syncModeFromCore();
};
if (window.KAI2) syncModeFromCore();
else document.addEventListener('kai2:ready', syncModeFromCore, { once: true });

// ── KAI Doer ON/OFF ───────────────────────────────────────────────────────────
// OFF stops KAI starting new work on its own (observation and recording continue);
// ON lets it resume permitted next steps. It does NOT grant Full Access. The label is
// whatever CORE says — never an optimistic local toggle — and it is only repainted once
// Core has accepted, so the button cannot show a state the backend refused.
const doerButton = document.querySelector('.composer-doer');
let doerSyncAttempts = 0;

function paintDoer(state) {
  if (!doerButton) return;
  const on = state === 'ON';
  doerButton.setAttribute('aria-pressed', String(on));
  doerButton.dataset.state = 'ready';
  doerButton.textContent = on ? 'Doer on' : 'Doer off';
  doerButton.title = on
    ? 'KAI may take permitted next steps on its own. This is not Full Access.'
    : 'KAI will not start new work on its own. It can still observe and report.';
}

function syncDoer() {
  if (!doerButton || !window.KAI2 || !window.KAI2.doer) return;
  window.KAI2.doer.read().then((result) => {
    if (!result || result.ok !== true || !result.state) {
      // No owner credential, or Core not ready yet: say so, and retry a few times.
      doerButton.dataset.state = 'error';
      doerButton.textContent = 'Doer ?';
      doerButton.title = (result && result.reason) || 'KAI2 cannot read the Doer state from Core.';
      if (doerSyncAttempts++ < 10) setTimeout(syncDoer, 1500);
      return;
    }
    doerSyncAttempts = 0;
    paintDoer(result.state);
  }).catch(() => { if (doerSyncAttempts++ < 10) setTimeout(syncDoer, 1500); });
}

// ── Monster Mode ─────────────────────────────────────────────────────────────
// How far KAI carries a mission on its own. Core owns the limits and enforces
// them; this control only reads Core's answer and asks it to change. The label is
// never optimistic: it is painted from what Core returned.
const monsterButton = document.querySelector('.composer-monster');
let monsterSyncAttempts = 0;

function paintMonster(state, limits) {
  if (!monsterButton) return;
  const on = state === 'ON';
  monsterButton.setAttribute('aria-pressed', String(on));
  monsterButton.dataset.state = 'ready';
  monsterButton.textContent = on ? 'Monster on' : 'Monster off';
  monsterButton.title = on
    ? `KAI plans, dispatches and verifies a mission itself, within ${limits ? limits.steps + ' steps / ' + limits.minutes + ' min' : 'its limits'}. Permissions are unchanged.`
    : 'KAI works one step at a time unless you ask for more.';
}

function syncMonster() {
  if (!monsterButton || !window.KAI2 || !window.KAI2.monster) return;
  window.KAI2.monster.read().then((result) => {
    if (!result || result.ok !== true || !result.state) {
      monsterButton.dataset.state = 'error';
      monsterButton.textContent = 'Monster ?';
      monsterButton.title = (result && result.reason) || 'KAI2 cannot read Monster Mode from Core.';
      if (monsterSyncAttempts++ < 10) setTimeout(syncMonster, 1500);
      return;
    }
    monsterSyncAttempts = 0;
    paintMonster(result.state, result.limits);
  }).catch(() => { if (monsterSyncAttempts++ < 10) setTimeout(syncMonster, 1500); });
}

if (monsterButton) {
  monsterButton.addEventListener('click', async () => {
    if (!window.KAI2 || !window.KAI2.monster || monsterButton.dataset.state === 'busy') return;
    const next = monsterButton.getAttribute('aria-pressed') === 'true' ? 'OFF' : 'ON';
    monsterButton.dataset.state = 'busy';
    monsterButton.textContent = next === 'ON' ? 'Turning on…' : 'Turning off…';
    const result = await window.KAI2.monster.set(next);
    if (result && result.ok === true) {
      paintMonster(result.state || next, result.limits);
      return;
    }
    monsterButton.dataset.state = 'error';
    monsterButton.textContent = result && result.pendingApproval ? 'Needs approval' : 'Monster ?';
    monsterButton.title = (result && result.reason) || 'Core refused the change.';
    monsterSyncAttempts = 0;
    setTimeout(syncMonster, 2000);
  });
}

if (doerButton) {
  doerButton.addEventListener('click', async () => {
    if (!window.KAI2 || !window.KAI2.doer || doerButton.dataset.state === 'busy') return;
    const next = doerButton.getAttribute('aria-pressed') === 'true' ? 'OFF' : 'ON';
    doerButton.dataset.state = 'busy';
    doerButton.textContent = next === 'ON' ? 'Turning on…' : 'Turning off…';
    const result = await window.KAI2.doer.set(next);
    if (result && result.ok === true) {
      paintDoer(result.state || next);
      return;
    }
    // Refused, parked for approval, or unavailable: show WHY, then re-read the truth.
    doerButton.dataset.state = 'error';
    doerButton.textContent = result && result.pendingApproval ? 'Needs approval' : 'Doer ?';
    doerButton.title = (result && result.reason) || 'Core refused the change.';
    doerSyncAttempts = 0;
    setTimeout(syncDoer, 2000);
  });
  if (window.KAI2) syncDoer();
  else document.addEventListener('kai2:ready', syncDoer, { once: true });
}

if (monsterButton) {
  if (window.KAI2) syncMonster();
  else document.addEventListener('kai2:ready', syncMonster, { once: true });
}

// ── Pending approvals ─────────────────────────────────────────────────────────
// A tool that needs a human is parked IN CORE. This surface lists those real records and
// lets the owner answer them; approving goes through the owner-only IPC, so exactly the
// approved call is retried and dispatched once. Nothing here invents an approval.
const approvalButton = document.querySelector('.composer-approvals');
const approvalTray = document.querySelector('.approval-tray');
let approvalTimer = 0;

function renderApprovals(pending) {
  if (!approvalTray || !approvalButton) return;
  const count = pending.length;
  approvalButton.hidden = count === 0;
  approvalButton.textContent = count === 1 ? '1 approval' : `${count} approvals`;
  approvalButton.title = count > 0 ? 'KAI is waiting for your decision' : '';
  approvalTray.hidden = count === 0;
  approvalTray.textContent = '';
  for (const approval of pending.slice(0, 4)) {
    const row = document.createElement('div');
    row.className = 'approval';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', approval.action || approval.toolId);

    const head = document.createElement('div');
    head.className = 'approval-head';
    const icon = document.createElement('span');
    icon.className = 'approval-icon';
    icon.innerHTML = (window.Glyphs && Glyphs[approval.risk === 'DESTRUCTIVE' ? 'shieldAlert' : 'shield']) || '';
    const main = document.createElement('div');
    main.className = 'approval-main';
    const title = document.createElement('div');
    title.textContent = approval.action || approval.toolId;
    const meta = document.createElement('div');
    meta.className = 'approval-meta';
    const quote = document.createElement('span');
    quote.className = 'approval-quote';
    quote.textContent = `${approval.toolId} · ${String(approval.reason || '').slice(0, 140)}`;
    meta.append(quote);
    main.append(title, meta);
    head.append(icon, main);

    const actions = document.createElement('div');
    actions.className = 'approval-foot';
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'approval-button is-deny';
    deny.textContent = I18n.t('approve.deny');
    const allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'approval-button is-allow';
    allow.textContent = I18n.t('approve.allow');
    // "Always" writes ONE persisted rule for THIS tool at its own risk level. It is
    // never a blanket permission, so it is a third, explicitly labelled choice —
    // and the scope is stated on the button itself, not buried in a tooltip.
    const always = document.createElement('button');
    always.type = 'button';
    always.className = 'approval-button is-always';
    always.textContent = I18n.t('approve.always');
    always.title = `Always allow ${approval.toolId} (${approval.risk}) — nothing else`;
    const decide = async (approved, scope) => {
      approve(allow, deny, true);
      always.disabled = true;
      const out = await window.KAI2.approvals.decide(approval.id, approved, scope);
      if (!out || out.ok !== true) {
        quote.textContent = (out && out.body && out.body.reason) || 'Core refused that decision.';
      } else if (out.body && out.body.grant) {
        quote.textContent = `Always allowed ${approval.toolId} (${approval.risk}).`;
      }
      await refreshApprovals();
    };
    allow.addEventListener('click', () => void decide(true));
    deny.addEventListener('click', () => void decide(false));
    always.addEventListener('click', () => void decide(true, 'always'));
    actions.append(deny, allow, always);
    row.append(head, actions);
    approvalTray.append(row);
  }
}

function approve(allow, deny, busy) {
  allow.disabled = busy;
  deny.disabled = busy;
  allow.textContent = busy ? 'Working…' : I18n.t('approve.allow');
}

async function refreshApprovals() {
  if (!approvalButton || !window.KAI2 || !window.KAI2.approvals) return;
  try {
    const out = await window.KAI2.approvals.list();
    const all = (out && out.ok && out.body && out.body.approvals) || [];
    renderApprovals(all.filter((a) => a && a.status === 'PENDING'));
  } catch (_) {
    // Core unreachable: leave the last known list rather than blanking a real request.
  }
}

if (approvalButton) {
  approvalButton.addEventListener('click', () => {
    if (approvalTray) approvalTray.hidden = !approvalTray.hidden;
  });
  // Start the poller RELIABLY. It used to wait for `window.KAI2` or a one-shot
  // `kai2:ready` event; if the bridge appeared after that event fired, neither
  // branch ran, the poller never started, and the tray stayed at its initial
  // "0 approvals" while Core held a real pending request — the user saw a request
  // mentioned in chat and had NO card to click. Poll from now on, and retry the
  // first render until the bridge is actually there.
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    void refreshApprovals();
    approvalTimer = setInterval(() => { if (!document.hidden) void refreshApprovals(); }, 5000);
  };
  if (window.KAI2) start();
  else document.addEventListener('kai2:ready', start, { once: true });
  // Belt and braces: the bridge may arrive without the event, and the interval must
  // exist even if the first render happens a moment late.
  if (!started) {
    let tries = 0;
    const wait = setInterval(() => {
      tries += 1;
      if (window.KAI2 || tries > 40) { clearInterval(wait); start(); }
    }, 250);
  }
  window.addEventListener('pagehide', () => clearInterval(approvalTimer));
}

// ── Daily summary ─────────────────────────────────────────────────────────────
// RENDERING only: Core builds the report from real missions, worker results and
// KAI-verified outcomes, and owns the once-a-day offer. Opening this never consumes that
// offer and never marks anything delivered, so asking twice is free.
const summaryButton = document.querySelector('.composer-summary');
const summaryPanel = document.querySelector('.summary-panel');
const summaryBody = document.querySelector('.summary-body');

async function loadDailySummary() {
  if (!summaryButton || !summaryBody || !window.KAI2 || !window.KAI2.dailySummary) return;
  summaryButton.dataset.state = 'busy';
  summaryButton.textContent = 'Working…';
  const out = await window.KAI2.dailySummary();
  summaryButton.dataset.state = 'ready';
  summaryButton.textContent = 'Summary';
  if (!out || out.ok !== true) {
    summaryBody.textContent = (out && out.body && out.body.reason) || 'Core could not build the summary.';
    if (summaryPanel) summaryPanel.hidden = false;
    return;
  }
  summaryBody.textContent = out.body.markdown || 'Nothing to summarise yet.';
  if (summaryPanel) summaryPanel.hidden = false;
}

if (summaryButton) {
  summaryButton.addEventListener('click', () => {
    if (summaryPanel && !summaryPanel.hidden && summaryBody && summaryBody.textContent) {
      summaryPanel.hidden = true;   // a second click closes what it opened
      return;
    }
    void loadDailySummary();
  });
  document.querySelector('.summary-close')?.addEventListener('click', () => {
    if (summaryPanel) summaryPanel.hidden = true;
  });
}

const lockScreen = new LockScreen({ main, chat, composer, onOpen: () => composerInput.focus({ preventScroll: true }) });
const lockCard = new LockCard({ chat, library, scroller: document.querySelector('.chats-scroll'), screen: lockScreen });
new WelcomeGhost({ main, root: document.querySelector('.welcome'), input: composerInput });
folderPill = new FolderPill({ button: document.querySelector('.composer-folder'), library, chat });
chatList = new ChatList({
  root: document.querySelector('.chats'),
  library,
  chat,
  onNewFolder: async () => {
    const folder = await library.pick();
    if (!folder) return;
    chat.newChat(folder);
    composerInput.focus();
  },
  onNewChat: (folder) => {
    chat.newChat(folder);
    composerInput.focus();
  },
  onLock: (id, row) => lockCard.open(id, row),
});
document.querySelector('.titlebar-name').innerHTML = `${Glyphs.ghost}<span>KAI2</span>`;
const modeButton = document.querySelector('.composer-mode');
const browserToggle = document.querySelector('.browser-toggle');
let browserPanel = null;
if (AgentTools.available) {
  modeButton.hidden = false;
  new ModePicker({ button: modeButton, settings, onChange: () => chat.onModeChange() });

  // ── Reconcile the mode control with CORE at startup ──────────────────────────
  // The picker stores the last CLICK, so a session where Core never granted Full
  // left the button reading "Full" while Core enforced `normal`. Clicking Full then
  // did nothing at all — `set()` returns early because the stored mode already
  // matched. Reading Core once at start makes the button show what is TRUE, so a
  // click is a real change and can raise its elevation.
  (async () => {
    const bridge = window.KAI2 && window.KAI2.policy;
    if (!bridge || typeof bridge.read !== 'function') return;
    try {
      const state = await bridge.read();
      const fromCore = state && state.mode;
      if (!fromCore) return;
      // Core is the authority, in BOTH directions. Only downgrading meant the button
      // could read "ask" while Core was genuinely elevated — the control then lied
      // about the mode the user had already approved.
      if (settings.mode !== fromCore) {
        settings.setMode(fromCore);
        window.ModePicker?.syncAll?.();
      }
    } catch (_) {
      // A Core that cannot answer leaves the stored preference alone; the first
      // real mode change reports the truth.
    }
  })();
  browserToggle.hidden = false;
  browserPanel = window.browserPanel = new BrowserPanel({ app, main, toggle: browserToggle });
}
const attachments = new Attachments({
  tray: document.querySelector('.composer-attachments'),
  picker: document.querySelector('.composer-picker'),
  panel: document.querySelector('.note-panel'),
  main,
  zone: document.querySelector('.drop-zone'),
  input: composerInput,
  onChange: syncComposer,
  onText: (text, undo) => composerText.place(text, undo),
  // Files dropped on the open settings go to the settings' own list, not into the message.
  isActive: () => !MiniChat.current && !chat.active?.locked && !settings.dialog.open,
});
new SelectionMenu({
  onAsk: (text, box) => {
    const mini = box.closest('.mini')?.__mini;
    if (mini) { mini.quote(text); return; }
    composerText.insertQuote(text);
    syncComposer();
  },
  onMini: text => { if (chat.active?.record) MiniChat.open({ settings, source: chat, library, quote: text }); },
});
new AddMenu({ button: document.querySelector('.composer-add'), attachments, chat, input: composerInput });
settings.show(chat.model);
modelStage = new ModelStage({
  button: document.querySelector('.composer-model'),
  root: document.querySelector('.model-stage'),
  chat,
  settings,
  input: composerInput,
});
effortSlider = new EffortSlider({
  button: document.querySelector('.composer-effort'),
  panel: document.querySelector('.effort-panel'),
  settings,
});
effortSlider.lock(chat.busy);

document.querySelector('.sidebar-settings').addEventListener('settings-open', () => settings.open());

document.querySelector('.sidebar-new-chat').addEventListener('add', () => {
  chat.newChat();
  composerInput.focus();
});

function setSidebarCollapsed(collapsed) {
  app.classList.toggle('is-sidebar-collapsed', collapsed);
  sidebarToggle.toggleAttribute('collapsed', collapsed);
  sidebar.inert = collapsed;
  browserPanel?.fit();
}

sidebarToggle.addEventListener('sidebar-toggle', () => {
  setSidebarCollapsed(!app.classList.contains('is-sidebar-collapsed'));
});

const searchField = new SearchField({
  root: search,
  button: searchButton,
  input: searchInput,
  clear: document.querySelector('.sidebar-search-clear'),
});
searchInput.addEventListener('input', () => chatList.setQuery(searchInput.value));

document.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyK' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (document.querySelector('dialog[open]')) return;
  event.preventDefault();
  if (app.classList.contains('is-sidebar-collapsed')) setSidebarCollapsed(false);
  searchField.focus();
});

composer.addEventListener('mousedown', (event) => {
  if (event.target === composer || event.target.classList.contains('composer-toolbar')) {
    event.preventDefault();
    composerInput.focus();
  }
});

function syncComposer() {
  composerSend.toggleAttribute('disabled', !composerText.text().trim() && !attachments.count);
  composerField.classList.toggle('has-value', composerInput.value !== '');
}

function syncAll() {
  if (!chatList) return;
  syncComposer();
  folderPill.sync();
  chatList.render();
  lockScreen.sync();
  settings.show(chat.model);
  modelStage?.sync();
  effortSlider?.lock(chat.busy);
}



// ── Tasks & Schedule ─────────────────────────────────────────────────────────
// Every row here is a record from Core: missions, schedules and durable tool
// calls. Nothing is inferred, and nothing is stored in the renderer.
const tasksButton = document.querySelector('.tasks-button');
const tasksPanel = document.querySelector('.tasks-panel');
const tasksBody = document.querySelector('.tasks-body');
const tasksBadge = document.querySelector('.tasks-badge');

function taskRow(state, stateClass, title, when) {
  const row = document.createElement('div');
  row.className = 'tasks-row';
  const st = document.createElement('span');
  st.className = 'tasks-state ' + stateClass;
  st.textContent = state;
  const ti = document.createElement('span');
  ti.className = 'tasks-title';
  ti.textContent = title;
  row.append(st, ti);
  if (when) {
    const w = document.createElement('span');
    w.className = 'tasks-when';
    w.textContent = when;
    row.append(w);
  }
  return row;
}

function taskSection(title, rows) {
  const box = document.createElement('div');
  box.className = 'tasks-section';
  const h = document.createElement('h4');
  h.textContent = title;
  box.append(h);
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tasks-empty';
    empty.textContent = 'Nothing here.';
    box.append(empty);
  } else {
    for (const r of rows) box.append(r);
  }
  return box;
}

function shortWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}


/** A tool call said the way a person would: no JSON, no ids. */
function humanCall(c) {
  const tool = String(c.toolName || c.toolId || 'tool');
  let args = c.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
  const inner = (args && (args.input || args)) || {};
  const url = inner && typeof inner.url === 'string' ? inner.url : '';
  const query = inner && typeof inner.query === 'string' ? inner.query : '';
  const path = inner && typeof inner.path === 'string' ? inner.path : '';
  const action = args && typeof args.action === 'string' ? args.action : '';
  if (/browser/i.test(tool)) {
    if (url) return 'Browsed ' + url.replace(/^https?:\/\//, '').slice(0, 60);
    if (action === 'read') return 'Read a page';
    return 'Used the browser';
  }
  if (/shell|powershell/i.test(tool)) return 'Ran a command';
  if (/filesystem_write|write_file/i.test(tool)) return path ? 'Wrote ' + path.slice(0, 50) : 'Wrote a file';
  if (/filesystem/i.test(tool)) return path ? 'Read ' + path.slice(0, 50) : 'Looked through files';
  if (/git/i.test(tool)) return 'Checked the repository';
  if (/memory/i.test(tool)) return 'Used its memory';
  if (query) return 'Searched for “' + query.slice(0, 40) + '”';
  return tool.replace(/^(capability|kai)[._]/, '').replace(/[._]/g, ' ');
}

async function renderTasks() {
  if (!tasksBody) return;
  if (!window.KAI2 || typeof window.KAI2.dashboard !== 'function') return;
  const out = await window.KAI2.dashboard();
  const body = (out && out.body) || {};
  const state = body.state || {};
  const schedules = (body.schedules && body.schedules.schedules) || [];
  const calls = (body.activity && body.activity.calls) || [];

  tasksBody.textContent = '';

  // Current: what Core says is actually running, plus the newest real execution.
  const current = [];
  const missions = state.missions || {};
  if (missions.active > 0) current.push(taskRow('RUNNING', 'is-running', `${missions.active} mission(s) in progress`, ''));
  if (missions.unfinished > 0) current.push(taskRow('UNFINISHED', 'is-idle', `${missions.unfinished} mission(s) not finished`, ''));
  const newest = calls[0];
  if (newest) {
    const ok = String(newest.status || '').toUpperCase() === 'EXECUTED';
    current.push(taskRow(ok ? 'DONE' : String(newest.status || '—'),
      ok ? 'is-done' : 'is-failed',
      `${newest.toolName || newest.toolId || 'tool'}`,
      shortWhen(newest.completedAt)));
  }
  if (current.length === 0) current.push(taskRow('IDLE', 'is-idle', 'KAI is not running a task', ''));
  const policyLine = document.createElement('div');
  policyLine.className = 'tasks-empty';
  policyLine.textContent = `Stage review: ${await reviewPolicyNow()} — ask = every stage, auto = ordinary stages run`;
  tasksBody.append(policyLine);
  tasksBody.append(taskSection('Current', current));

  // Recent execution: real outcomes, never a claim.
  const recent = calls.slice(0, 8).map((c) => {
    const ok = String(c.status || '').toUpperCase() === 'EXECUTED';
    return taskRow(ok ? 'DONE' : String(c.status || '—'),
      ok ? 'is-done' : 'is-failed',
      humanCall(c),
      shortWhen(c.completedAt));
  });
  tasksBody.append(taskSection('Recent execution', recent));

  // TODOs: real work items Core owns. This is the task list, not a renderer array.
  const items = (body.work && (body.work.workItems || body.work.items)) || [];
  const ordering = { RUNNING: 0, QUEUED: 1, CHANGES_REQUESTED: 2, BLOCKED: 3, COMPLETED: 4, FAILED: 5, CANCELLED: 6 };
  const todoRows = items
    .slice()
    .sort((a, b) => (ordering[String(a.state || a.status).toUpperCase()] ?? 9) - (ordering[String(b.state || b.status).toUpperCase()] ?? 9))
    .slice(0, 12)
    .map((w) => {
      const st = String(w.state || w.status || 'TODO').toUpperCase();
      const cls = st === 'COMPLETED' ? 'is-done' : st === 'FAILED' || st === 'BLOCKED' ? 'is-failed' : st === 'RUNNING' ? 'is-running' : 'is-idle';
      const row = taskRow(st.replace(/_/g, ' '), cls, String(w.objective || w.title || w.id).slice(0, 90), shortWhen(w.updatedAt));
      // Edit: swap the title for an input, save through Core, re-read the panel.
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'tasks-cancel';
      edit.textContent = '✎';
      edit.title = 'Edit this task';
      edit.addEventListener('click', () => {
        const titleEl = row.querySelector('.tasks-title');
        if (!titleEl) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tasks-add-input';
        input.value = String(w.objective || w.title || '');
        titleEl.textContent = '';
        titleEl.append(input);
        input.focus();
        input.select();
        const save = async () => {
          const next = input.value.trim();
          if (!next || next === String(w.objective || w.title || '')) { await renderTasks(); return; }
          const out = await window.KAI2.todoEdit(w.id, next).catch(() => null);
          if (!out || !out.ok) {
            input.placeholder = (out && out.body && out.body.reason) || 'Core refused the edit.';
            return;
          }
          await renderTasks();
        };
        // Enter saves; Escape cancels. NO blur handler: re-rendering on save removed
        // the input, which fired blur and saved a second time with a detached value —
        // that double-save blanked the row while Core kept the old objective.
        let done = false;
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (done) return; done = true; void save(); }
          if (e.key === 'Escape') { done = true; void renderTasks(); }
        });
      });
      // Run: drive this plan's stages in order (Core does the work).
      const run = document.createElement('button');
      run.type = 'button';
      run.className = 'tasks-cancel';
      run.textContent = '▶';
      run.title = 'Run this plan';
      run.addEventListener('click', async () => {
        run.disabled = true;
        run.textContent = '…';
        // Remember the approval this plan parked on, and pass it back next time:
        // without it, re-running raised a SECOND approval for the same stage
        // instead of consuming the one the owner had already granted.
        const prior = run.dataset.approvalId;
        const out = await window.KAI2.todoRun(w.id, prior).catch(() => null);
        run.disabled = false;
        run.textContent = '▶';
        if (out && out.ok && out.body) {
          if (out.body.parkedApprovalId) run.dataset.approvalId = out.body.parkedApprovalId;
          else delete run.dataset.approvalId;
          const st = String(out.body.state || '');
          if (st !== 'COMPLETED') run.title = out.body.note || st;
        }
        await renderTasks();
      });
      row.append(edit, run);
      return row;
    });
  const todoSection = taskSection('TODOs', todoRows);
  // A create box: one objective line, which is all Core requires.
  const form = document.createElement('form');
  form.className = 'tasks-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Add a TODO for KAI…';
  input.className = 'tasks-add-input';
  const add = document.createElement('button');
  add.type = 'submit';
  add.className = 'tasks-add-button';
  add.textContent = 'Add';
  form.append(input, add);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const objective = input.value.trim();
    if (!objective) return;
    add.disabled = true;
    const out = await window.KAI2.todoCreate(objective, []).catch(() => null);
    add.disabled = false;
    if (out && out.ok) { input.value = ''; await renderTasks(); }
    else input.placeholder = (out && out.body && out.body.reason) || 'Core refused that TODO.';
  });
  todoSection.append(form);
  tasksBody.append(todoSection);

  // Schedule: real persisted entries, in the user's local time.
  const upcoming = schedules
    .filter((x) => x.enabled !== false)
    .slice()
    .sort((a, b) => String(a.runAt || '').localeCompare(String(b.runAt || '')))
    .slice(0, 10)
    .map((x) => {
      const row = taskRow(x.enabled === false ? 'PAUSED' : 'PLANNED', 'is-idle', x.title || x.id, shortWhen(x.runAt));
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'tasks-cancel';
      cancel.textContent = '×';
      cancel.title = 'Cancel this scheduled task';
      cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        const out = await window.KAI2.scheduleCancel(x.id).catch(() => null);
        if (out && out.ok) await renderTasks();
        else cancel.disabled = false;
      });
      row.append(cancel);
      return row;
    });
  tasksBody.append(taskSection('Schedule', upcoming));

  const pendingCount = calls.filter((c) => String(c.status || '').toUpperCase() === 'FAILED').length;
  if (tasksBadge) {
    const n = (missions.active || 0) + upcoming.length;
    tasksBadge.hidden = n === 0;
    tasksBadge.textContent = String(n);
  }
}

if (tasksButton) {
  tasksButton.addEventListener('click', async () => {
    if (!tasksPanel) return;
    const open = tasksPanel.hidden;
    tasksPanel.hidden = !open;
    tasksButton.setAttribute('aria-expanded', String(open));
    if (open) await renderTasks();
  });
  document.querySelector('.tasks-close')?.addEventListener('click', () => {
    tasksPanel.hidden = true;
    tasksButton.setAttribute('aria-expanded', 'false');
  });
  // A cheap, bounded refresh so the panel is not a snapshot from when it opened.
  setInterval(() => {
    if (tasksPanel && !tasksPanel.hidden && !document.hidden) void renderTasks();
  }, 8000);
}


// ── Automatic planning ───────────────────────────────────────────────────────
// A substantial request should produce a PERSISTED plan, not just prose the model
// may or may not follow. This derives the stages from the request's own verbs and
// creates a real work item — the same records the dashboard and /todos read.
// It is deliberately conservative: a question gets an answer, not a task list.
function planStagesFor(text) {
  const t = text.toLowerCase();
  const stages = [];
  // Order matters: a request to FIX something is an implementation task even if it
  // also says "investigate", so the more specific intent must win.
  if (/\b(fix|repair|bug|broken|failing|regression)\b/.test(t)) {
    stages.push('Inspect the relevant code', 'Reproduce the failure', 'Apply the smallest fix', 'Run targeted tests', 'Report the result');
  } else if (/\b(research|find out|look up|compare|survey|investigate)\b/.test(t)) {
    stages.push('Gather sources', 'Read and compare the material', 'Summarise with links');
  } else if (/\b(implement|build|add|create|write|refactor)\b/.test(t)) {
    stages.push('Design the change', 'Implement it', 'Test it', 'Verify the outcome');
  } else if (/\b(plan|schedule|roadmap|break down)\b/.test(t)) {
    stages.push('Clarify the goal', 'Break it into tasks', 'Order and schedule them');
  }
  return stages;
}

function isSubstantialRequest(text) {
  const t = String(text || '').trim();
  if (t.length < 40) return false;                 // a short question is not a project
  if (t.length > 4000) return false;
  if (!/\s/.test(t)) return false;
  return planStagesFor(t).length > 0;
}

let plannedFor = new Set();

async function maybePlan(text) {
  if (!isSubstantialRequest(text)) return null;
  const key = text.trim().slice(0, 120);
  if (plannedFor.has(key)) return null;             // one plan per distinct request
  const stages = planStagesFor(text);
  const out = await window.KAI2.todoCreate(text.trim().slice(0, 300), stages).catch(() => null);
  if (out && out.ok) {
    plannedFor.add(key);
    const n = document.createElement('div');
    n.className = 'mode-notice';
    n.textContent = `Planned this as ${stages.length} step(s): ${stages.join(' → ')}`;
    n.hidden = false;
    const host = document.querySelector('.mode-notice');
    if (host && host.parentElement) host.parentElement.insertBefore(n, host);
    else document.body.append(n);
    setTimeout(() => n.remove(), 12000);
    return stages;
  }
  return null;
}

// -- Slash commands -----------------------------------------------------------
// One registry, real handlers. A command is never sent to the model as prose:
// if it starts with "/" it is resolved here or refused here with suggestions.
const COMMANDS = [
  { name: 'help', usage: '', help: 'list the commands you can run' },
  { name: 'tools', usage: '', help: 'every tool KAI can call, and whether it is available' },
  { name: 'workers', usage: '', help: 'the workforce KAI actually has, with live state' },
  { name: 'agents', usage: '', help: 'registered employees and what they can do' },
  { name: 'approvals', usage: '', help: 'actions waiting for your decision' },
  { name: 'summary', usage: '[from] [to]', help: 'the evidence-backed day report' },
  { name: 'activity', usage: '', help: 'show or hide the activity strip' },
  { name: 'clear', usage: '', help: 'empty the composer (never the conversation)' },
  { name: 'status', usage: '', help: 'Core connectivity, mode, current task, pending approvals' },
  { name: 'todo', usage: '', help: 'the current task and its next step' },
  { name: 'todos', usage: '', help: 'every persistent TODO and its status' },
  { name: 'plan', usage: '', help: 'the active task plan and its progress' },
  { name: 'schedule', usage: '', help: 'upcoming scheduled work' },
  { name: 'cancel', usage: '', help: 'cancel the active task or a scheduled entry' },
  { name: 'run', usage: '<command>', help: 'run a terminal command through Core (asks first)' },
  { name: 'review', usage: '[ask|auto|off]', help: 'how much stage review you want (auto = ordinary stages run)' },
];

function showCommandOutput(title, text) {
  if (!summaryPanel || !summaryBody) return;
  summaryBody.textContent = '— ' + title + ' —\n\n' + text;
  summaryPanel.hidden = false;
  if (typeof summaryPanel.scrollIntoView === 'function') summaryPanel.scrollIntoView({ block: 'nearest' });
}

function listOf(value, key) {
  const body = value && value.body;
  if (!body) return null;
  if (Array.isArray(body)) return body;
  if (key && Array.isArray(body[key])) return body[key];
  return Array.isArray(body.data) ? body.data : null;
}

const COMMAND_HANDLERS = {
  async help() {
    const lines = COMMANDS.map((c) => '  /' + c.name + (c.usage ? ' ' + c.usage : '') + '\n      ' + c.help);
    return lines.join('\n');
  },
  async tools() {
    const out = await window.KAI2.catalog();
    const tools = listOf(out.body && out.body.tools, 'tools');
    if (!tools) return 'Core did not return a tool list.\n' + JSON.stringify(out.body || out).slice(0, 300);
    // Core's /tools declares what KAI may call; it does NOT report per-tool
    // availability, so counting "available" would be an invented number.
    const declared = tools.length;
    const lines = tools
      .slice(0, 60)
      .map((t) => '  ' + (t.id || t.name) + (t.permission ? '  [' + t.permission + ']' : ''));
    const note = declared > 60 ? '\n  … ' + (declared - 60) + ' more' : '';
    return declared + ' declared tools. Core reports no per-tool availability, so ' +
      'a declaration is not a promise that the backend is reachable.\n' + lines.join('\n') + note;
  },
  async workers() {
    const out = await window.KAI2.catalog();
    const agents = listOf(out.body && out.body.workers, 'agents');
    if (!agents) return 'Core did not return a workforce.\n' + JSON.stringify(out.body || out).slice(0, 300);
    return agents.map((a) => '  ' + a.id + ' — ' + (a.state || 'unknown') + (a.detail ? '\n      ' + a.detail : '')).join('\n');
  },
  async agents() {
    const out = await window.KAI2.catalog();
    const people = listOf(out.body && out.body.employees, 'employees');
    if (!people) return 'Core did not return any employees.';
    if (!people.length) return 'No employees registered.';
    return people.map((e) => '  ' + (e.name || e.id) + (e.role ? ' — ' + e.role : '') + (e.id !== (e.name || e.id) ? '  (' + e.id + ')' : '')).join('\n');
  },
  async approvals() {
    const out = await window.KAI2.approvals.list();
    const all = listOf(out, 'approvals');
    if (!all) return 'Core did not return approvals.\n' + JSON.stringify(out.body || out).slice(0, 300);
    // Only a PENDING record awaits a decision. Decided history is not a queue.
    const rows = all.filter((r) => String(r.status || '').toUpperCase() === 'PENDING');
    if (!rows.length) return 'Nothing is waiting for you.' + (all.length ? '\n(' + all.length + ' decided records are kept as history.)' : '');
    return rows.map((r) => '  ' + r.id + '  ' + (r.title || r.tool || r.action || '') + (r.reason ? '\n      ' + r.reason : '')).join('\n');
  },
  async summary() {
    const out = await window.KAI2.dailySummary();
    if (!out || !out.ok) return 'The summary is unavailable: ' + ((out && out.body && out.body.reason) || 'Core could not build it.');
    return out.body.markdown || 'Nothing to summarise yet.';
  },
  async activity() {
    // The REAL records: what KAI invoked, with what arguments and what came back.
    if (!window.KAI2 || typeof window.KAI2.toolActivity !== 'function') return 'Core did not return an activity list.';
    const out = await window.KAI2.toolActivity(50);
    const rows = (out && out.body && out.body.calls) || [];
    if (!rows.length) return 'No tool invocations recorded yet.';
    const clip = (v, n) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return String(s === undefined ? '' : s).slice(0, n);
    };
    return rows
      .slice(0, 25)
      .map((c) => {
        const when = String(c.completedAt || c.startedAt || '').replace('T', ' ').slice(0, 19);
        // Duration when both ends exist: a real number, not an estimate.
        const ms =
          c.startedAt && c.completedAt
            ? new Date(c.completedAt).getTime() - new Date(c.startedAt).getTime()
            : null;
        const dur = ms !== null && Number.isFinite(ms) && ms >= 0 ? `  ${ms}ms` : '';
        const approval = c.approvalId ? `  approval=${c.approvalId}` : '';
        return [
          `  [${c.status || 'unknown'}] ${c.toolName || c.toolId || '?'}${approval}${dur}`,
          `      ${when}  ${clip(c.arguments, 180)}`,
          c.result ? `      → ${clip(c.result, 240)}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n');
  },
  async clear() {
    composerInput.value = '';
    composerText.refresh();
    syncComposer();
    return 'Composer cleared. The conversation is untouched.';
  },

  async status() {
    const out = await window.KAI2.dashboard();
    const body = (out && out.body) || {};
    const state = body.state || {};
    const pol = await window.KAI2.policy.read().catch(() => null);
    const pend = await window.KAI2.approvals.list().then((r) => (r.body?.approvals || []).filter((a) => a.status === 'PENDING')).catch(() => []);
    const missions = state.missions || {};
    const agents = state.agents || [];
    return [
      `Core: ${pol && pol.core ? 'reachable' : 'unknown'} — mode "${(pol && pol.mode) || '?'}"`,
      `Tasks running: ${missions.active || 0} · unfinished: ${missions.unfinished || 0}`,
      `Pending approvals: ${pend.length}`,
      `Workers: ${agents.map((a) => `${a.id} ${a.state || ''}`).join(', ') || 'none'}`,
      `Stage review: ${await reviewPolicyNow()}`,
    ].join('\n');
  },

  async todo() {
    const items = await workItems();
    const active = items.find((w) => /RUNNING|IN_PROGRESS|READY|QUEUED/i.test(String(w.state || w.status || '')));
    if (!active) return 'No active task. Ask me for something substantial and I will plan it.';
    const next = active.nextAction || active.currentStep || (active.steps && active.steps[0] && active.steps[0].title) || 'next step not recorded';
    return `Current: ${active.objective || active.title}\nNext: ${next}`;
  },

  async todos() {
    const items = await workItems();
    if (!items.length) return 'No TODOs yet. Ask me for something substantial and I will plan it.';
    return items
      .slice(0, 20)
      .map((w) => `  [${String(w.state || w.status || 'TODO').toUpperCase()}] ${String(w.objective || w.title || w.id).slice(0, 90)}`)
      .join('\n');
  },

  async plan() {
    const items = await workItems();
    const active = items.find((w) => /RUNNING|IN_PROGRESS|READY|QUEUED/i.test(String(w.state || w.status || ''))) || items[0];
    if (!active) return 'No plan to show.';
    const steps = active.steps || active.plan || [];
    const lines = [`Plan: ${active.objective || active.title}`, `State: ${String(active.state || active.status || '?').toUpperCase()}`];
    if (Array.isArray(steps) && steps.length) {
      steps.forEach((st, i) => lines.push(`  ${i + 1}. [${String(st.state || st.status || 'TODO').toUpperCase()}] ${st.title || st.objective || ''}`));
    } else {
      lines.push('  (no step detail recorded for this task)');
    }
    return lines.join('\n');
  },

  async schedule(rest) {
    // `/schedule add <title> | <when>` creates a REAL entry in Core's scheduler.
    // `<when>` is anything Date.parse understands ("tomorrow 9am" is NOT — an ISO
    // instant, "2026-10-25T09:00" or a plain date). The entry is stored, not printed.
    const addMatch = /^add\s+(.+)$/i.exec(String(rest || '').trim());
    if (addMatch) {
      const parts = addMatch[1].split('|').map((x) => x.trim());
      const title = parts[0];
      const when = parts[1];
      if (!title) return 'Give it a title: /schedule add <title> | <when>';
      if (!when) return 'Give it a time: /schedule add <title> | 2026-10-25T09:00';
      const at = new Date(when);
      if (Number.isNaN(at.getTime())) return `I cannot read "${when}" as a date. Try 2026-10-25T09:00.`;
      const out = await window.KAI2.scheduleCreate(title, at.toISOString()).catch(() => null);
      if (!out || !out.ok) return `Core refused: ${(out && out.body && out.body.reason) || 'unknown'}`;
      return `Scheduled "${title}" for ${at.toLocaleString()}.`;
    }
    const out = await window.KAI2.dashboard();
    const list = ((out && out.body && out.body.schedules && out.body.schedules.schedules) || [])
      .filter((x) => x.enabled !== false)
      .sort((a, b) => String(a.runAt || '').localeCompare(String(b.runAt || '')));
    if (!list.length) return 'Nothing is scheduled. Create one with: /schedule add <title> | <when>';
    return list.slice(0, 20).map((x) => `  ${String(x.runAt || '').replace('T', ' ').slice(0, 16)}  ${x.title || x.id}`).join('\n');
  },

  async review(rest) {
    const want = String(rest || '').trim().toLowerCase();
    const read = async () => {
      const out = await window.KAI2.reviewPolicy().catch(() => null);
      const s = (out && out.body && (out.body.settings || out.body)) || {};
      return s['orchestration.review'] || 'ASK';
    };
    if (!want) return `Stage review policy: ${await read()}\n  ask  = approve every stage\n  auto = ordinary stages run; risky ones ask\n  off  = only EXTERNAL/DESTRUCTIVE ask`;
    if (!['ask','auto','off'].includes(want)) return 'Pick one of: ask, auto, off';
    const out = await window.KAI2.reviewPolicy(want).catch(() => null);
    const body = (out && out.body) || {};
    if (body.approvalRequired) return `Changing the review policy needs your approval (${body.approvalId || 'pending'}). Approve it, then run /review ${want} again.`;
    if (!out || !out.ok) return `Core refused: ${body.reason || 'unknown'}`;
    return `Stage review policy is now ${want.toUpperCase()}. ${await read() === want.toUpperCase() ? '' : '(read-back differs)'}`.trim();
  },

  async run(rest) {
    const command = String(rest || '').trim();
    if (!command) return 'Give me a command: /run echo hello';
    const out = await window.KAI2.shellRun(command).catch(() => null);
    const body = (out && out.body) || {};
    // Core parks a DESTRUCTIVE command for the owner; that is the designed path.
    if (body.approvalRequired) {
      return `That needs your approval first (${body.approvalId || 'pending'}). Approve it in the approvals list, then run:\n/run ${command} ${body.approvalId || ''}`.trim();
    }
    if (!out || !out.ok) return `Core refused: ${body.reason || 'unknown'}`;
    const result = body.result || body;
    const exit = result.exitCode !== undefined ? result.exitCode : (result.result && result.result.exitCode);
    const stdout = result.stdout || (result.result && result.result.stdout) || '';
    const stderr = result.stderr || (result.result && result.result.stderr) || '';
    return [`exit ${exit}`,
      stdout ? `stdout:\n${String(stdout).slice(0, 800)}` : 'stdout: (empty)',
      stderr ? `stderr:\n${String(stderr).slice(0, 400)}` : ''].filter(Boolean).join('\n');
  },

  async cancel() {
    // Real cancellation: an active mission first, then a scheduled entry. Never
    // hide a row and call that cancellation.
    const out = await window.KAI2.dashboard();
    const body = (out && out.body) || {};
    const missions = (body.state && body.state.missions) || {};
    if (missions.active > 0) {
      const live = (body.state && (body.state.missionList || body.state.missionsList)) || [];
      if (live.length === 1) return 'One mission is running; cancel it from the Tasks panel so you can see what stops.';
      return `${missions.active} mission(s) running. Say which one to cancel.`;
    }
    const list = (body.schedules && body.schedules.schedules) || [];
    const upcoming = list.filter((x) => x.enabled !== false);
    if (upcoming.length === 1) {
      const res = await window.KAI2.scheduleCancel(upcoming[0].id).catch(() => null);
      return res && res.ok ? `Cancelled "${upcoming[0].title || upcoming[0].id}".` : `Core refused: ${(res && res.body && res.body.reason) || 'unknown'}`;
    }
    if (upcoming.length > 1) return `${upcoming.length} scheduled items. Open Tasks to pick one.`;
    return 'Nothing is running or scheduled to cancel.';
  },
};


/** The persistent work items, from the same read the Tasks panel uses. */

/** The effective stage-review policy, read from Core (never guessed). */
async function reviewPolicyNow() {
  const out = await window.KAI2.reviewPolicy().catch(() => null);
  const s = (out && out.body && (out.body.settings || out.body)) || {};
  return s['orchestration.review'] || 'ASK';
}

async function workItems() {
  const out = await window.KAI2.dashboard().catch(() => null);
  const body = (out && out.body) || {};
  return (body.work && (body.work.workItems || body.work.items)) || [];
}

async function runCommand(text) {
  const name = text.slice(1).split(/\s+/)[0].toLowerCase();
  const handler = COMMAND_HANDLERS[name];
  if (!handler) {
    const close = COMMANDS.map((c) => '/' + c.name).filter((c) => c.indexOf('/' + name) === 0);
    showCommandOutput('/' + name, 'There is no /' + name + ' command.' + (close.length ? '\nDid you mean: ' + close.join(', ') : '\nType /help to see what exists.'));
    return;
  }
  try {
    showCommandOutput('/' + name, await handler(text.slice(1).trim().slice(name.length).trim()));
  } catch (err) {
    showCommandOutput('/' + name, 'That command failed: ' + String(err && err.message ? err.message : err));
  }
}

function send() {
  const text = composerText.text().trim();
  // A command is resolved here, never handed to the model as prose.
  if (text.charAt(0) === '/') {
    composerInput.value = '';
    composerText.refresh();
    syncComposer();
    void runCommand(text);
    return;
  }
  // Plan substantial work BEFORE it is sent, so the TODO exists while the work runs.
  void maybePlan(text);
  if ((!text && !attachments.count) || !chat.send(text, attachments.items)) return;
  attachments.take();
  composerInput.value = '';
  composerText.refresh();
  syncComposer();
}

composerInput.addEventListener('input', syncComposer);

composerInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
  event.preventDefault();
  send();
});

// Escape stops the agent from anywhere in the window, not only from the message field. An open menu or dialog, and
// fields that use Escape themselves (renaming, search, the address bar), get it first.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !chat.busy) return;
  if (document.querySelector(':popover-open, dialog[open]')) return;
  event.preventDefault();
  chat.stop();
});

composerSend.addEventListener('composer-send', () => send());

syncComposer();

// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, WORKFORCE_INTEGRATION_IDS, type AgentTask } from "../core/state";
import type { CoreSessionRow } from "../core/core-state";
import { subagentActivity, type CoreSubagentRow } from "../core/core-state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../character/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { overviewCardKey } from "./overview-key";
import { buildSubagent, resolveVisual } from "./subagent";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  /** Opens the configured n8n instance — used by the n8n error card. */
  openN8n(): void;
  decide(d: "allow" | "deny"): void;
  /** Create / switch / rename / archive a Core conversation session. */
  coreSession(cmd: SessionCommand): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

/** What the sessions view asks Core to do. Routed through the Core link. */
export type SessionCommand =
  | { op: "create"; title?: string }
  | { op: "activate"; id: string }
  | { op: "rename"; id: string; title: string }
  | { op: "archive"; id: string }
  | { op: "unarchive"; id: string };

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabSessions = h("button", { class: "tab", title: "Sessions", onclick: () => go("sessions") }, svg(ICONS.stack, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabSessions, tabDrop),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabSessions.classList.toggle("on", v === "sessions");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  // The right-side panel: KAI's SUBAGENTS first, each with the worker it runs on as
  // demoted infrastructure beneath it. Raw workers are never peers of KAI here.
  const subHead = h("div", { class: "sub-head" });
  const subList = h("div", { class: "subagents" });
  const right = card(null, subHead, subList);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let subKey: string | null = null;
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
    openSessions: () => actions.setView("sessions"),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      const sessionActive =
        task?.id === "integration_claude" && (task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: task.source === "claudeCode" ? "Claude Code" : "n8n" }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        // The key includes KAI's own runtime state and the Core connection: the
        // KAI card renders `State.runtimeLabel` and the connection, so without
        // them the card kept showing "KAI is idle" while the character's glow had
        // already moved to USING_TOOL. See `overview-key.ts` for the pinning test.
        const key = overviewCardKey({
          id: task.id,
          detailOpen,
          state: task.state,
          steps: task.steps,
          loaded: info?.loaded,
          error: info?.error,
          configured: info?.configured,
          data: info?.data,
          runtime: State.runtime,
          connection: State.core.conn,
        });
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const subs = State.core.subagents;
      // The signature includes each subagent's ACTIVE flag, which is derived from the
      // real PENDING approvals (`subagent:<id>`), so the panel re-renders the moment a
      // run parks or is decided — not on a client timer.
      const key = subs
        .map((s) => {
          const a = subagentActivity(State.core, s);
          return `${s.id}:${s.name}:${s.status}:${s.workerId}:${a.active ? 1 : 0}:${a.approvalId ?? ""}`;
        })
        .join("|");
      if (key !== subKey) {
        subKey = key;
        const activeCount = subs.filter((s) => subagentActivity(State.core, s).active).length;
        clear(subHead);
        subHead.append(
          h("span", { class: "nm", text: "KAI’s subagents" }),
          h("div", { class: "grow" }),
          h("span", {
            class: "count",
            text: subs.length === 0 ? "none" : `${activeCount} active · ${subs.length}`,
          }),
        );
        clear(subList);
        if (subs.length === 0) {
          // Nothing false: say there are none, and show which workers exist beneath
          // KAI so the panel is not an empty hole.
          subList.append(h("span", { class: "empty", text: "No subagents defined yet." }));
          const workers = State.tasks
            .filter((t) => WORKFORCE_INTEGRATION_IDS.includes(t.id))
            .map((t) => t.name);
          if (workers.length > 0) {
            subList.append(h("span", { class: "empty dim", text: `workers beneath KAI: ${workers.join(", ")}` }));
          }
        } else {
          for (const s of subs.slice(0, 3)) subList.append(buildSubagentRow(s, actions));
          if (subs.length > 3) subList.append(h("span", { class: "empty dim", text: `+${subs.length - 3} more` }));
        }
        pruneMiniBots();
      }
    },
  };
}

// ── Subagent row (the right-side panel) ─────────────────────────────────────────
// One of KAI's OWN personas, above the worker it runs on. The row leads with the
// subagent: its mini KAI, its name, and whether it is ACTIVE right now — derived
// from a real parked approval (`subagent:<id>`), never a client-side busy flag.

function buildSubagentRow(sub: CoreSubagentRow, actions: ViewActions): HTMLElement {
  const vis = resolveVisual(sub);
  const act = subagentActivity(State.core, sub);
  // The mini KAI is driven by a task-shaped view of the persona: the subagent's
  // resolved colour, and a state borrowed from its real activity — ACTIVE work is
  // "working", everything else is idle. Nothing here invents activity Core did not
  // report.
  const task: AgentTask = {
    id: sub.id,
    name: sub.name,
    color: vis.primary,
    state: act.active ? "working" : "idle",
    stepIndex: 0,
    steps: [],
    source: "localAgent",
    isIntegration: false,
  };
  const canvas = createMiniBot(task, 22);
  const badge = h("span", {
    class: "badge",
    text: act.active ? "active" : act.standby ? "ready" : sub.status.toLowerCase(),
  });
  badge.style.color = act.active ? "#F5A524" : act.standby ? "#34D399" : "#8b93a1";
  const row = h(
    "div",
    {
      class: "subagent",
      title: `${sub.name} · runs on ${sub.workerId}`,
      onclick: () => {
        State.selectSubagent(sub.id);
        actions.setView("subagent");
      },
    },
    canvas,
    h("span", { class: "nm", text: sub.name }),
    h("span", { class: "role", text: sub.role }),
    h("div", { class: "grow" }),
    badge,
  );
  // The persona's own colour is the row's identity, on its left edge.
  row.style.borderLeftColor = vis.primary;
  return row;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask KAI", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "is asking a question"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Waiting on your answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — KAI can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  // Both open actions exist at once and sync() shows the one that fits the task.
  // Rebuilding the row on every sync would swallow a click landing between a
  // mouse-down and a mouse-up, and there is nothing here that changes per frame.
  const openSession = btn("Open in VS Code", "primary", () => actions.openTerminal());
  const openN8nBtn = btn("Open in n8n", "primary", () => actions.openN8n());
  const dismiss = btn("Dismiss", "secondary", () => actions.setView(State.defaultView()));
  const row = h("div", { class: "actions" }, openSession, openN8nBtn, dismiss);
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  let builtFor: string | null = null;
  return {
    el,
    sync() {
      const task = State.focusTask;
      const fromN8n = task?.source === "n8n";
      // Only redraw the row's variant when the source actually changes: an n8n
      // error has no VS Code folder to open, and a Claude session has no n8n run.
      const variant = fromN8n ? "n8n" : "claude";
      if (variant !== builtFor) {
        builtFor = variant;
        openN8nBtn.style.display = fromN8n ? "" : "none";
        openSession.style.display = fromN8n ? "none" : "";
      }
      clear(who);
      who.append(agentWho(task, fromN8n ? "workflow stopped" : "session stopped"));
      title.textContent = fromN8n ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open in VS Code", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      // KAI's own failed-turn message takes priority over the transient Core note.
      // The Core link owns `noteMessage` and rewrites/clears it on connection
      // changes, so a turn that could not be taken lives in `turnError`; without
      // that priority the honest message was overwritten by a generic connection
      // line and then blanked, leaving this card empty.
      title.textContent = State.turnError ?? State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      // The badge reports the same fact the Hermes card does, from the same poller:
      // a key that is stored and accepted is not the same as one that is missing.
      const hermes = (State.integrations["integration_hermes"]?.data ?? {}) as Record<string, unknown>;
      const keyStored = hermes.keyStored === true;
      const authorised = hermes.authorised === true;
      apiBadge.style.cursor = "pointer";
      apiBadge.title = authorised
        ? "Hermes api-server key: stored and accepted"
        : keyStored
          ? "Hermes api-server key: stored, not accepted"
          : "No Hermes api-server key stored — open Settings";
      apiBadge.onclick = () => actions.openSettingsWindow();
      apiBadge.append(
        dot(authorised ? "#22C55E" : keyStored ? "#F5A524" : "#F4505E", 6),
        h("span", { text: "API" }),
      );
    },
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────────
// KAI's durable conversations. The list converges from the Core snapshot; every
// button here is a Core mutation, so what is on screen is always what Core said.
// Kept to the card/stack idiom: a heading row, a few rows, nothing new.

/** A small text button, matching the settings view's link buttons. */
function lineBtn(label: string, onClick: () => void, color = "#c5c8cd"): HTMLElement {
  return h("button", {
    class: "link-btn",
    style: `color:${color};flex:0 0 auto`,
    text: label,
    onclick: onClick,
  });
}

function buildSessions(actions: ViewActions): ViewHost {
  const heading = h("span", { class: "title", style: "font-size:13px", text: "My Sessions" });
  const newBtn = btn("New Session", "primary", () => actions.coreSession({ op: "create" }));
  const head = h("div", { class: "row", style: "justify-content:space-between" }, heading, newBtn);
  const list = h("div", { style: "display:flex;flex-direction:column;gap:6px;min-height:0" });
  const note = h("div", { class: "sub", style: "font-size:11px" });

  const el = h(
    "div",
    { class: "view" },
    card("indigo", h("div", { class: "stack", style: "padding:12px 16px 12px 96px" }, head, list, note)),
  );

  let editingId: string | null = null;
  let renameInput: HTMLInputElement | null = null;
  let key = "";

  function commitRename(id: string) {
    const title = renameInput?.value.trim() ?? "";
    editingId = null;
    key = "";
    if (title.length > 0) actions.coreSession({ op: "rename", id, title });
    State.notify();
  }

  function rowFor(s: CoreSessionRow, active: boolean): HTMLElement {
    const id = s.id;
    const title = s.title;
    const archived = s.status === "ARCHIVED";
    const row = h("div", { class: "row", style: "gap:7px;min-height:0" });
    row.append(dot(active ? "#34D399" : archived ? "#6b7280" : "#8b93a1", 7));

    if (editingId === id) {
      const input = h("input", {
        type: "text",
        value: title,
        style:
          "flex:1 1 auto;min-width:0;background:rgba(255,255,255,0.07);" +
          "border:1px solid rgba(255,255,255,0.14);border-radius:8px;color:inherit;" +
          "font:400 12px var(--font);padding:3px 7px",
        onkeydown: (e: Event) => {
          const k = (e as KeyboardEvent).key;
          if (k === "Enter") commitRename(id);
          else if (k === "Escape") {
            editingId = null;
            key = "";
            State.notify();
          }
        },
      }) as HTMLInputElement;
      renameInput = input;
      row.append(input, lineBtn("Save", () => commitRename(id), "#34D399"), lineBtn("Cancel", () => {
        editingId = null;
        key = "";
        State.notify();
      }));
      return row;
    }

    row.append(
      h("span", {
        style:
          `flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
          `font:${active ? 600 : 400} 12px var(--font);color:${archived ? "#7b8290" : "var(--ink)"}`,
        text: title,
      }),
    );
    // The worker this conversation is bound to stays VISIBLE but demoted: a small
    // muted label, never the row's headline. It is the worker's id, not KAI's.
    if (s.agentId !== undefined) {
      row.append(h("span", {
        style: "flex:0 0 auto;font:400 10px var(--font);color:#6b7280",
        text: `· ${s.agentId}`,
      }));
    }
    if (active) {
      row.append(h("span", { style: "flex:0 0 auto;font:500 10.5px var(--font);color:#34D399", text: "active" }));
    } else if (!archived) {
      row.append(lineBtn("Use", () => actions.coreSession({ op: "activate", id }), "#3B9EFF"));
    }
    if (archived) {
      row.append(lineBtn("Restore", () => actions.coreSession({ op: "unarchive", id }), "#34D399"));
    } else {
      row.append(lineBtn("Rename", () => {
        editingId = id;
        key = "";
        State.notify();
      }));
      row.append(lineBtn("Archive", () => actions.coreSession({ op: "archive", id }), "#F0A6A6"));
    }
    return row;
  }

  return {
    el,
    sync() {
      const rows = State.core.sessions;
      const activeId = State.core.activeSessionId;
      const sig = `${rows.map((s) => `${s.id}:${s.status}:${s.active ? 1 : 0}:${s.title}:${s.agentId ?? ""}`).join("|")}#${activeId ?? ""}#${editingId ?? ""}`;
      if (sig !== key) {
        key = sig;
        renameInput = null;
        clear(list);
        for (const s of rows.slice(0, 4)) {
          list.append(rowFor(s, s.active || s.id === activeId));
        }
        if (rows.length > 4) list.append(h("div", { class: "sub", style: "font-size:11px", text: `+${rows.length - 4} more` }));
      }
      if (!State.core.conn || State.core.conn === "OFFLINE") {
        note.textContent = "KAI Core is not connected";
      } else if (rows.length === 0) {
        note.textContent = "No sessions yet — press New Session.";
      } else {
        // Report the ACTIVE pointer from Core, not a row flag: if Core names an
        // active session the note must name it too, so the UI can never say
        // "active: none" while the API carries one.
        const active = activeId !== null ? rows.find((s) => s.id === activeId) : undefined;
        const activeLabel = active?.title ?? activeId ?? "none";
        note.textContent = `${rows.length} session(s) · active: ${activeLabel}`;
      }
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("sessions", buildSessions(actions));
  map.set("subagent", buildSubagent(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // No `mail`, `searching` or `result` view is registered, on purpose. They were
  // the three macOS-port placeholders (the upstream Windows tree shipped the same
  // three as `buildPlaceholder` stubs) and no code path ever switched to them, so
  // the shipped behaviour was a card that could never be reached. Their two
  // capabilities — sending a dropped file by email, and a panel for a web-search
  // result — are genuinely absent on Windows: there is no mail transport (the
  // macOS app used Resend or Apple Mail; Windows has neither wired) and the chat
  // path returns a text reply into the chat log rather than a result object.
  // Remove-with-a-reason rather than a placeholder, so nothing unreachable ships.
  return map;
}

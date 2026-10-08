// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../character/engine";
import { characterStateFor, RUNTIME_LABELS, type KaiRuntimeState } from "./runtime-state";
import {
  applyCoreEvent as reduceCoreEvent,
  applySnapshot as reduceCoreSnapshot,
  initialCoreSlice,
  setConnection as reduceCoreConnection,
  type CoreConnState,
  type CoreEventInput,
  type CoreSlice,
  type CoreSnapshotInput,
  type CoreSubagentDetail,
} from "./core-state";

export type AgentSource = "claudeCode" | "n8n" | "localAgent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/**
 * AgentTask.integrationAgents — KAI first, then KAI's workforce, then the rest.
 *
 * `integration_kai` is the ROOT card: KAI is the entity the user talks to and the
 * one the island is about, so the first card on the overview is headed "KAI" and
 * names the workers KAI drives (Hermes, OpenCode, VS Code) as its subordinates.
 * The worker cards still exist and are still reachable by focusing their pill —
 * visible, but demoted, per the hierarchy rule.
 */
export const INTEGRATION_AGENTS: AgentTask[] = [
  // ── KAI itself — the root entity ──────────────────────────────────────────
  task("integration_kai", "KAI", "#34D399", "localAgent"),
  // ── KAI's workforce: the workers and local sessions KAI drives ────────────
  task("integration_hermes", "Hermes", "#38BDF8", "localAgent"),
  task("integration_opencode", "OpenCode", "#F5F6F8", "localAgent"),
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  // ── Third-party services ──────────────────────────────────────────────────
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

/** KAI and its control layer are always on: they need no key and no consent. */
export const ALWAYS_ON_INTEGRATION_IDS = [
  "integration_kai", "integration_hermes", "integration_opencode",
];

/** The workers KAI drives — demoted rows on KAI's card, never a headline. */
export const WORKFORCE_INTEGRATION_IDS = [
  "integration_hermes", "integration_opencode", "integration_claude",
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** How many opt-in pills may show next to KAI. Always-on entries are not a choice. */
export const MAX_OPT_IN_INTEGRATIONS = 4;

/** Opt-in ids inside a stored `activeIntegrations` array (always-on excluded). */
export function optInIntegrationCount(active: readonly string[]): number {
  return active.filter((id) => id !== "integration_claude" && !ALWAYS_ON_INTEGRATION_IDS.includes(id)).length;
}

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** The Claude model KAI uses for its direct (Core-less) chat path. */
  model: string;
  /**
   * The island window position the Rust side persists on drag (key
   * `island_pos`). Typed here so a settings round-trip can never silently
   * drop it; the TS side never writes it — only spreads it through.
   */
  island_pos?: { x: number; y: number } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    ...ALWAYS_ON_INTEGRATION_IDS,
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /**
   * KAI's RUNTIME state — what KAI itself is doing, driven by real Core events,
   * Claude Code hooks and genuine user actions (see `KaiRuntimeMachine`). This is
   * KAI's own state; a worker's state stays on that worker's pill. Views read
   * `runtimeLabel` for a KAI-facing sentence and the character reads
   * `effectiveState`.
   */
  runtime: KaiRuntimeState = "IDLE";
  /** The KAI-facing sentence for `runtime` (e.g. "KAI is thinking…"). */
  runtimeLabel: string = RUNTIME_LABELS.IDLE;
  /**
   * Signals from the chat input to the runtime machine. The chat view sets these
   * (views may only import `core/`), and the island folds them into the machine.
   */
  runtimeInput: { composing: boolean; turnInFlight: boolean; turnOutcome: "ok" | "error" | null } = {
    composing: false,
    turnInFlight: false,
    turnOutcome: null,
  };

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  /**
   * KAI's own message for the last turn it could NOT take — most importantly, the
   * honest "I can't reach my Core right now…" when its Core was unreachable.
   *
   * Deliberately separate from `noteMessage`. That slot carries transient Core
   * notices (a notification, a connection-status line) and is owned by the Core
   * link, which rewrites it on every connection-state change and clears it on
   * reconnect. Routing a failed turn through `noteMessage` therefore destroyed the
   * message twice over: a CONNECTING → OFFLINE transition replaced it with a
   * generic "KAI Core is not running" line, and the reconnect nulled it, leaving
   * the note view on screen showing an empty card. A failed turn is KAI's own
   * answer about a real user action, so it lives here, survives the Core coming
   * back, and is cleared only when the user sends a new turn or leaves the note.
   */
  turnError: string | null = null;
  searchResult: SearchResult | null = null;

  /**
   * KAI's chat history, PER KAI SESSION, keyed by the Core session id.
   *
   * A single global array was the session-isolation bug the review named: after
   * switching KAI sessions the island kept showing the previous conversation, and
   * the turn could even continue the previous worker conversation. The key is the
   * Core session id; `""` is the bucket for a turn that ran with no session (the
   * Core-less direct path). This is KAI's OWN history — the turns Core recorded
   * for the session — never a worker's raw transcript.
   */
  chatHistories: Record<string, ChatMessage[]> = {};
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  /**
   * The Core's state as the island sees it. Kept in this store rather than in a
   * second one: views already render from here, and two sources of "what is
   * happening" is the fragmentation the phase spec warns about. Nothing secret
   * ever lands here — no key, no header, no credential.
   */
  core: CoreSlice = initialCoreSlice();

  /**
   * The subagent the user has selected. Selecting a subagent shows ITS OWN
   * persistent state — name, purpose, personality, visual identity, its sessions
   * and worker activity — never a merge into KAI's conversation. `null` means KAI
   * itself, the parent authority, is what the panel is about.
   */
  selectedSubagentId: string | null = null;
  /**
   * `GET /subagents/:id` for the selected subagent — its persona plus the sessions
   * bound to it. Filled by the Core bridge, never guessed by a view.
   */
  subagentDetail: CoreSubagentDetail | null = null;

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  /**
   * The live history array for one KAI session, created on first use. The chat
   * view mutates this array in place (push), so it must be the stored one, not a
   * fresh copy.
   */
  chatHistoryFor(sessionId: string | null): ChatMessage[] {
    const key = sessionId ?? "";
    let history = this.chatHistories[key];
    if (history === undefined) {
      history = [];
      this.chatHistories[key] = history;
    }
    return history;
  }

  /** The ACTIVE session's history — what the chat view renders. */
  get chatHistory(): ChatMessage[] {
    return this.chatHistoryFor(this.core.activeSessionId);
  }

  /** Replaces one session's history (used when Core's recorded turns are re-read). */
  setChatHistory(sessionId: string | null, messages: ChatMessage[]): void {
    this.chatHistories[sessionId ?? ""] = [...messages];
    this.notify();
  }

  /** Drops one session's history — a dropped file starts a fresh turn for it. */
  clearChatHistory(sessionId: string | null): void {
    this.chatHistories[sessionId ?? ""] = [];
    this.notify();
  }

  get effectiveState(): BotStateName {
    // The dizzy override wins (three slaps is a deliberate user act), then KAI's
    // OWN runtime state. Only when KAI is genuinely idle does the focused worker's
    // state fall through, so a VS Code session still shows on KAI's face without
    // making a worker the subject whenever KAI is doing something.
    if (this.stateOverride !== null) return this.stateOverride;
    if (this.runtime !== "IDLE") return characterStateFor(this.runtime);
    return this.focusTask?.state ?? "idle";
  }

  /**
   * Records KAI's runtime state. Called by the island when the runtime machine
   * transitions; it is the single writer of `runtime`/`runtimeLabel`.
   */
  setRuntime(state: KaiRuntimeState): void {
    if (this.runtime === state) return;
    this.runtime = state;
    this.runtimeLabel = RUNTIME_LABELS[state];
    this.notify();
  }

  /** A signal from the chat input; the island folds it into the machine. */
  setRuntimeInput(patch: {
    composing?: boolean;
    turnInFlight?: boolean;
    turnOutcome?: "ok" | "error" | null;
  }): void {
    if (patch.composing !== undefined) this.runtimeInput.composing = patch.composing;
    if (patch.turnInFlight !== undefined) this.runtimeInput.turnInFlight = patch.turnInFlight;
    if (patch.turnOutcome !== undefined) this.runtimeInput.turnOutcome = patch.turnOutcome;
    this.notify();
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — the control layer and VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const alwaysOn =
        ALWAYS_ON_INTEGRATION_IDS.includes(proto.id) || proto.id === "integration_claude";
      const shouldLoad = alwaysOn || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Keep the declared order so pills never shuffle.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    if (!this.focusId) this.focusId = "integration_kai";
    this.notify();
  }

  toggleIntegration(id: string) {
    // VS Code and the local control layer are not opt-out.
    if (id === "integration_claude" || ALWAYS_ON_INTEGRATION_IDS.includes(id)) return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_kai";
    } else {
      // The cap counts OPT-IN pills only: always-on entries are not a choice
      // and must never eat the budget (the defaults already carry three).
      if (optInIntegrationCount(active) >= MAX_OPT_IN_INTEGRATIONS) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  // ── Core mirror ───────────────────────────────────────────────────────────
  /** Applies one event from the Core's stream. */
  applyCoreEvent(event: CoreEventInput) {
    this.core = reduceCoreEvent(this.core, event);
    this.notify();
  }

  /** Applies a full refresh from the Core (the reconciliation path). */
  applyCoreSnapshot(input: CoreSnapshotInput) {
    this.core = reduceCoreSnapshot(this.core, input);
    this.notify();
  }

  /** Connection state is its own thing: it must not be inferred from stale data. */
  setCoreConnection(conn: CoreConnState, error?: string | null) {
    const next = reduceCoreConnection(this.core, conn, error ?? null);
    if (next.conn === this.core.conn && next.lastError === this.core.lastError) return;
    this.core = next;
    this.notify();
  }

  // ── Subagent selection ──────────────────────────────────────────────────────
  /**
   * Selects a subagent (or clears the selection with `null`, meaning KAI itself).
   * The detail is dropped when the selection changes so a view can never show one
   * subagent's persona while another is selected; the bridge re-fetches it.
   */
  selectSubagent(id: string | null): void {
    if (this.selectedSubagentId === id) return;
    this.selectedSubagentId = id;
    this.subagentDetail = null;
    this.notify();
  }

  /** Records `GET /subagents/:id` for the selected subagent. */
  setSubagentDetail(detail: CoreSubagentDetail | null): void {
    this.subagentDetail = detail;
    this.notify();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();

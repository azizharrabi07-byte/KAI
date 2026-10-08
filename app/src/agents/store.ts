/**
 * agents/store.ts — the agent surface's model.
 *
 * One observable slice, one writer, no view touches the network. The store owns
 * the list of personas, the selected persona's detail, its own sessions and the
 * live chat, and it routes every mutation through `AgentApi`. Views read
 * `store.getState()` and subscribe; the store never imports a DOM node, so it is
 * unit-testable with a fake `AgentApi` and no browser.
 *
 * The chat is the REAL thing: `send` POSTs `/subagents/:id/message`, which runs
 * the ONE policy-governed path AS the persona on the persona's OWN session. When
 * the run is EXTERNAL it PARKS (409 + approvalId); the store records that as
 * `pending`, and `approvePending` re-issues with the approval id so the persona's
 * authored reply is recorded by Core. Nothing here fakes a reply.
 */

import type {
  AgentApi,
  AgentError,
  CapabilityRow,
  Subagent,
  SubagentDetail,
  SubagentSpecInput,
  WorkerRow,
} from "./api";

export type AgentConn = "CONNECTING" | "ONLINE" | "OFFLINE";

export interface AgentChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  at?: string;
  /** A user turn that Core refused (a real failure), rendered as such. */
  failed?: boolean;
}

/** A parked chat/run turn awaiting the human's decision. */
export interface PendingTurn {
  /** "message" re-issues through /message; "run" through /run. */
  kind: "message" | "run";
  agentId: string;
  approvalId: string;
  sessionId: string;
  input: string;
  reason: string;
}

export interface AgentsState {
  conn: AgentConn;
  agents: Subagent[];
  workers: WorkerRow[];
  capabilities: CapabilityRow[];
  selectedId: string | null;
  detail: SubagentDetail | null;
  chat: AgentChatMessage[];
  chatSessionId: string | null;
  pending: PendingTurn | null;
  busy: boolean;
  error: string | null;
  notice: { kind: "ok" | "warn" | "error"; text: string } | null;
  loadError: string | null;
}

export interface AgentsStore {
  getState(): AgentsState;
  subscribe(fn: () => void): () => void;
  /** Load the list, the workers and the capability catalogue from Core. */
  load(): Promise<void>;
  /** Select a persona (or clear with null); loads its detail and its own session. */
  select(id: string | null): Promise<void>;
  /** Re-read the selected persona's detail (status, sessions, activity). */
  refreshDetail(): Promise<void>;
  /** Send one chat turn to the selected persona, on its own session. */
  send(input: string): Promise<void>;
  /** Assign one task to the selected persona (one-shot `/run`). */
  assignTask(input: string): Promise<void>;
  /** Decide the parked turn in the affirmative and re-issue it. */
  approvePending(): Promise<void>;
  /** Refuse the parked turn. */
  denyPending(): Promise<void>;
  /** Re-send the last chat input (a retry after a failure). */
  retry(): Promise<void>;
  clearNotice(): void;
  /** Create a persona (WRITE, direct). Returns the created id or null. */
  create(spec: SubagentSpecInput): Promise<string | null>;
  /** Edit a persona by re-defining it. */
  update(id: string, spec: SubagentSpecInput): Promise<boolean>;
  /** Duplicate a persona under a new id. */
  duplicate(id: string, next: { id: string; name?: string }): Promise<boolean>;
  /** Archive (disable) a persona — the lifecycle axis Core actually exposes. */
  archive(id: string): Promise<boolean>;
  /** Restore (enable) a persona. */
  unarchive(id: string): Promise<boolean>;
  /** Open a fresh session owned by the selected persona. */
  newSession(): Promise<void>;
  /** Read the recorded turns of one of the persona's sessions into the chat. */
  loadTurns(sessionId: string): Promise<void>;
  /** Open one of the persona's sessions as the chat target. */
  openSession(sessionId: string): Promise<void>;
}

let nextMessageId = 1;

/**
 * Collapse ADJACENT identical user turns for display.
 *
 * Core's `/subagents/:id/message` records the user turn on the FRESH call and
 * again on the approval re-issue (the retry carries the same input), so a single
 * "Send" leaves two identical adjacent user turns in the session's history. That
 * is a Core-side duplication; until it is fixed there, the UI de-duplicates only
 * the immediately-adjacent identical pair so a person sees one of their own
 * messages, and never invents, drops or reorders anything else.
 */
function dedupeAdjacent(turns: { role: string; text: string; at?: string }[]): typeof turns {
  const out: typeof turns = [];
  for (const t of turns) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.role === t.role && prev.text === t.text) continue;
    out.push(t);
  }
  return out;
}

export function createAgentsStore(api: AgentApi): AgentsStore {
  const state: AgentsState = {
    conn: "CONNECTING",
    agents: [],
    workers: [],
    capabilities: [],
    selectedId: null,
    detail: null,
    chat: [],
    chatSessionId: null,
    pending: null,
    busy: false,
    error: null,
    notice: null,
    loadError: null,
  };

  const listeners = new Set<() => void>();
  let lastInput: string | null = null;

  function notify(): void {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* a view throwing must not break the store or the other views */
      }
    }
  }

  function setNotice(kind: "ok" | "warn" | "error", text: string): void {
    state.notice = { kind, text };
  }

  function fail(err: AgentError): void {
    state.error = err.message;
    setNotice("error", err.reason ?? err.message);
  }

  async function load(): Promise<void> {
    const [agents, workers, caps] = await Promise.all([
      api.listSubagents(),
      api.listWorkers(),
      api.listCapabilities(),
    ]);
    if (agents.ok) {
      state.agents = agents.value;
      state.conn = "ONLINE";
      state.loadError = null;
    } else {
      state.conn = "OFFLINE";
      state.loadError = agents.error.message;
    }
    if (workers.ok) state.workers = workers.value;
    if (caps.ok) state.capabilities = caps.value;
    notify();
  }

  async function select(id: string | null): Promise<void> {
    state.selectedId = id;
    state.detail = null;
    state.pending = null;
    state.error = null;
    state.notice = null;
    state.chat = [];
    state.chatSessionId = null;
    if (id === null) {
      notify();
      return;
    }
    notify();
    const detail = await api.getSubagent(id);
    if (state.selectedId !== id) return; // selection moved while in flight
    if (!detail.ok) {
      state.error = detail.error.message;
      notify();
      return;
    }
    state.detail = detail.value;
    // The persona's newest own session becomes the chat target; load its turns.
    const newest = detail.value.sessions.find((s) => s.status !== "ARCHIVED") ?? detail.value.sessions[0];
    if (newest !== undefined) {
      state.chatSessionId = newest.id;
      await loadTurns(newest.id, id);
      return;
    }
    notify();
  }

  async function refreshDetail(): Promise<void> {
    const id = state.selectedId;
    if (id === null) return;
    const detail = await api.getSubagent(id);
    if (state.selectedId !== id) return;
    if (detail.ok) {
      state.detail = detail.value;
      // Keep the agent row fresh too.
      const idx = state.agents.findIndex((a) => a.id === id);
      if (idx >= 0) state.agents = state.agents.map((a, i) => (i === idx ? detail.value.subagent : a));
    }
    notify();
  }

  async function loadTurns(sessionId: string, forId?: string): Promise<void> {
    const id = forId ?? state.selectedId;
    if (id === null) return;
    const turns = await api.subagentSessionTurns(id, sessionId);
    if (state.selectedId !== id || state.chatSessionId !== sessionId) return;
    if (!turns.ok) return;
    const visible = dedupeAdjacent(
      turns.value
        .filter((t) => t.role === "user" || t.role === "assistant")
        .map((t) => ({ role: t.role, text: t.text, at: t.at })),
    );
    state.chat = visible.map((t) => ({
      id: nextMessageId++,
      role: t.role as "user" | "assistant",
      text: t.text,
      ...(t.at !== undefined ? { at: t.at } : {}),
    }));
    notify();
  }

  /** Shared tail for a run/message outcome. */
  async function absorbOutcome(
    kind: "message" | "run",
    agentId: string,
    input: string,
    outcome: Awaited<ReturnType<AgentApi["messageSubagent"]>>,
  ): Promise<void> {
    if (!outcome.ok) {
      // Mark the optimistic user turn as failed and keep Core's reason.
      const last = state.chat[state.chat.length - 1];
      if (last !== undefined && last.role === "user") last.failed = true;
      fail(outcome.error);
      notify();
      return;
    }
    const value = outcome.value;
    if (value.kind === "parked") {
      state.chatSessionId = value.sessionId;
      state.pending = { kind, agentId, approvalId: value.approvalId, sessionId: value.sessionId, input, reason: value.reason };
      setNotice("warn", "Waiting for your approval — the persona acts only once you allow it.");
      notify();
      return;
    }
    // A settled run that authored no reply (a /run task) still succeeded.
    state.pending = null;
    if (value.sessionId !== "") state.chatSessionId = value.sessionId;
    if (value.reply.length > 0) {
      state.chat.push({ id: nextMessageId++, role: "assistant", text: value.reply });
    }
    setNotice("ok", kind === "run" ? "Task handed to the persona." : "The persona replied.");
    notify();
    // Re-read the persona's own turns so the view matches what Core recorded.
    if (state.chatSessionId !== null) await loadTurns(state.chatSessionId, agentId);
    await refreshDetail();
  }

  async function send(input: string): Promise<void> {
    const id = state.selectedId;
    if (id === null || state.busy) return;
    const text = input.trim();
    if (text.length === 0) return;
    state.busy = true;
    state.error = null;
    state.notice = null;
    lastInput = text;
    state.chat.push({ id: nextMessageId++, role: "user", text });
    notify();
    try {
      const outcome = await api.messageSubagent(id, {
        input: text,
        ...(state.chatSessionId !== null ? { sessionId: state.chatSessionId } : {}),
      });
      await absorbOutcome("message", id, text, outcome);
    } finally {
      state.busy = false;
      notify();
    }
  }

  async function assignTask(input: string): Promise<void> {
    const id = state.selectedId;
    if (id === null || state.busy) return;
    const text = input.trim();
    if (text.length === 0) return;
    state.busy = true;
    state.error = null;
    state.notice = null;
    notify();
    try {
      const outcome = await api.runSubagent(id, text);
      await absorbOutcome("run", id, text, outcome);
    } finally {
      state.busy = false;
      notify();
    }
  }

  async function approvePending(): Promise<void> {
    const pending = state.pending;
    if (pending === null || state.busy) return;
    state.busy = true;
    notify();
    try {
      const outcome =
        pending.kind === "run"
          ? await api.runSubagent(pending.agentId, pending.input, pending.approvalId)
          : await api.messageSubagent(pending.agentId, {
              input: pending.input,
              sessionId: pending.sessionId,
              approvalId: pending.approvalId,
            });
      await absorbOutcome(pending.kind, pending.agentId, pending.input, outcome);
    } finally {
      state.busy = false;
      notify();
    }
  }

  async function denyPending(): Promise<void> {
    const pending = state.pending;
    if (pending === null || state.busy) return;
    state.busy = true;
    notify();
    try {
      const decided = await api.decideApproval(pending.approvalId, false);
      const last = state.chat[state.chat.length - 1];
      if (last !== undefined && last.role === "user") last.failed = true;
      state.pending = null;
      if (decided.ok) setNotice("warn", "You refused the request — nothing ran.");
      else fail(decided.error);
      notify();
      if (state.chatSessionId !== null) await loadTurns(state.chatSessionId, pending.agentId);
    } finally {
      state.busy = false;
      notify();
    }
  }

  async function retry(): Promise<void> {
    if (lastInput === null) return;
    await send(lastInput);
  }

  async function create(spec: SubagentSpecInput): Promise<string | null> {
    state.busy = true;
    state.error = null;
    state.notice = null;
    notify();
    try {
      const outcome = await api.createSubagent(spec);
      if (!outcome.ok) {
        fail(outcome.error);
        return null;
      }
      if (outcome.value.kind === "parked") {
        setNotice("warn", outcome.value.reason);
        return null;
      }
      await load();
      const created = outcome.value.subagent;
      setNotice("ok", `Created “${created?.name ?? spec.name}”.`);
      return created?.id ?? spec.id;
    } finally {
      state.busy = false;
      notify();
    }
  }

  async function update(id: string, spec: SubagentSpecInput): Promise<boolean> {
    state.busy = true;
    state.error = null;
    notify();
    try {
      const outcome = await api.updateSubagent(id, spec);
      if (!outcome.ok) {
        fail(outcome.error);
        return false;
      }
      if (outcome.value.kind === "parked") {
        setNotice("warn", outcome.value.reason);
        return false;
      }
      await load();
      setNotice("ok", `Saved “${spec.name}”.`);
      return true;
    } finally {
      state.busy = false;
      notify();
    }
  }

  async function duplicate(id: string, next: { id: string; name?: string }): Promise<boolean> {
    state.busy = true;
    state.error = null;
    notify();
    try {
      const outcome = await api.duplicateSubagent(id, next);
      if (!outcome.ok) {
        fail(outcome.error);
        return false;
      }
      if (outcome.value.kind === "parked") {
        setNotice("warn", outcome.value.reason);
        return false;
      }
      await load();
      setNotice("ok", `Duplicated to “${outcome.value.subagent?.name ?? next.id}”.`);
      return true;
    } finally {
      state.busy = false;
      notify();
    }
  }

  async function lifecycle(id: string, archive: boolean): Promise<boolean> {
    state.busy = true;
    state.error = null;
    notify();
    try {
      const outcome = archive ? await api.archiveSubagent(id) : await api.unarchiveSubagent(id);
      if (!outcome.ok) {
        fail(outcome.error);
        return false;
      }
      if (outcome.value.kind === "parked") {
        setNotice("warn", outcome.value.reason);
        return false;
      }
      await load();
      await refreshDetail();
      setNotice("ok", archive ? "Persona archived — it is no longer delegate-able." : "Persona restored.");
      return true;
    } finally {
      state.busy = false;
      notify();
    }
  }

  async function newSession(): Promise<void> {
    const id = state.selectedId;
    if (id === null) return;
    state.busy = true;
    notify();
    try {
      const created = await api.createSubagentSession(id);
      if (!created.ok) {
        fail(created.error);
        return;
      }
      state.chatSessionId = created.value.id;
      state.chat = [];
      await refreshDetail();
      setNotice("ok", "Started a fresh session for this persona.");
    } finally {
      state.busy = false;
      notify();
    }
  }

  /** Open a specific session of the selected persona and read its turns. */
  async function openSession(sessionId: string): Promise<void> {
    const id = state.selectedId;
    if (id === null) return;
    state.chatSessionId = sessionId;
    state.chat = [];
    state.pending = null;
    notify();
    await loadTurns(sessionId, id);
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    load,
    select,
    refreshDetail,
    send,
    assignTask,
    approvePending,
    denyPending,
    retry,
    clearNotice() {
      state.notice = null;
      notify();
    },
    create,
    update,
    duplicate,
    archive: (id) => lifecycle(id, true),
    unarchive: (id) => lifecycle(id, false),
    newSession,
    loadTurns: (sessionId) => loadTurns(sessionId),
    openSession,
  };
}

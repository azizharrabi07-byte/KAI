/**
 * The Core link: one place that owns the client, the event stream and the bootstrap
 * sequence, and pushes everything into the app's state store.
 *
 * The island does not wait for any of this. A desktop presence that shows nothing until
 * a service answers is worse than one that appears immediately and says "Core offline"
 * — so `start()` returns as soon as the stream is asked to connect, and the shell keeps
 * running whatever the Core does.
 *
 * Why a reconciliation pass exists when there is already a stream: the stream is the
 * primary path and events are applied as they arrive, but a stream cannot tell you what
 * you missed while you were disconnected. After every (re)connect — and on a slow,
 * deliberately unambitious timer — the link re-reads a snapshot so the island converges
 * instead of drifting. It is not a substitute for the stream, and the interval is slow
 * for exactly that reason.
 */

import { Bridge } from "./bridge";
import { State } from "./state";
import { createCoreClient, DEFAULT_CORE_BASE_URL, type CoreClient, type CoreError } from "./kai-core";
import {
  createCoreEventStream,
  type CoreEvent,
  type CoreEventStream,
} from "./core-events";
import type { CoreConnState, CoreSnapshotInput } from "./core-state";

/** A slow safety net, not the mechanism. Events do the real work. */
const DEFAULT_RECONCILE_MS = 30_000;

export interface CoreLinkOptions {
  baseUrl?: string;
  /** Injectable for tests. */
  client?: CoreClient;
  stream?: CoreEventStream;
  /** Reconciliation interval in ms; 0 disables it. */
  reconcileMs?: number;
  /** Timer injection so tests never really wait. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CoreLink {
  readonly client: CoreClient;
  readonly stream: CoreEventStream;
  /** Ask the Core for a full snapshot and fold it into the island's state. */
  refresh(): Promise<void>;
  /** Start streaming and take a first snapshot. Returns immediately. */
  start(): void;
  /** Stop streaming and stop reconciling. */
  stop(): void;
}

/** Error codes are for logs and tests; a person gets a sentence. */
export function humanCoreError(error: CoreError): string {
  switch (error.code) {
    case "CORE_OFFLINE":
      return "KAI Core is not running";
    case "TIMEOUT":
      return "KAI Core did not answer in time";
    case "AUTH_REQUIRED":
      return "KAI Core refused the request";
    case "INVALID_RESPONSE":
      return "KAI Core sent something KAI could not read";
    case "REQUEST_FAILED":
      return error.reason !== undefined ? `KAI Core rejected the request: ${error.reason}` : "KAI Core rejected the request";
    default:
      return "KAI Core is unavailable";
  }
}

export function createCoreLink(options: CoreLinkOptions = {}): CoreLink {
  const baseUrl = options.baseUrl ?? DEFAULT_CORE_BASE_URL;
  const client = options.client ?? createCoreClient({ baseUrl });
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const reconcileMs = options.reconcileMs ?? DEFAULT_RECONCILE_MS;
  let reconcileHandle: unknown = null;
  let stopped = false;
  /** Did the last HTTP call reach the Core? Decides OFFLINE vs DEGRADED. */
  let httpReachable = false;
  let lastLoggedState: CoreConnState | null = null;
  /** The session whose turns are currently loaded into the chat history. */
  let loadedSessionId: string | null | undefined = undefined;

  const log = (message: string): void => {
    // Bridge.log is a no-op outside Tauri, so this is safe in `npm run dev` too.
    void Bridge.log(`[core] ${message}`);
  };

  async function refresh(): Promise<void> {
    const snapshot = await client.state();
    if (!snapshot.ok) {
      httpReachable = false;
      const message = humanCoreError(snapshot.error);
      // HTTP failed. If the stream is still delivering events the Core is reachable but
      // requests are failing, which is DEGRADED — not the same thing as OFFLINE.
      State.setCoreConnection(stream.state === "ONLINE" ? "DEGRADED" : "OFFLINE", message);
      return;
    }
    httpReachable = true;

    const value = snapshot.value;
    const input: CoreSnapshotInput = {
      agents: value.agents.map((a) => ({
        id: a.id,
        state: a.state,
        ...(a.detail !== undefined ? { detail: a.detail } : {}),
        ...(a.lastActivity !== undefined ? { lastActivity: a.lastActivity } : {}),
      })),
    };
    if (value.startedAt !== undefined) input.coreStartedAt = value.startedAt;
    if (value.uptimeMs !== undefined) input.uptimeMs = value.uptimeMs;
    if (value.scheduler?.running !== undefined) input.schedulerRunning = value.scheduler.running;
    if (value.tools?.registered !== undefined) input.toolCount = value.tools.registered;

    // Each list is fetched separately: one failing call must not blank the others, and
    // it must not be replaced with an empty list that would look like "nothing running".
    const [missions, notifications, approvals, sessions, subagents] = await Promise.all([
      client.missions({ limit: 20 }),
      client.notifications({ limit: 20 }),
      client.approvals(),
      client.sessions({ includeArchived: true, limit: 20 }),
      client.subagents(),
    ]);

    if (missions.ok) {
      input.missions = missions.value.map((m) => {
        const steps = m.steps ?? [];
        const done = steps.filter((s) => s.status === "COMPLETED").length;
        const failedStep = steps.find((s) => s.error !== undefined);
        return {
          id: m.id,
          title: m.title,
          status: m.status,
          updatedAt: m.updatedAt,
          doneSteps: done,
          totalSteps: steps.length,
          ...(failedStep?.error !== undefined ? { errorText: failedStep.error.message } : {}),
        };
      });
    }
    if (notifications.ok) {
      input.notifications = notifications.value.map((n) => ({
        id: n.id,
        title: n.title,
        type: n.type,
        priority: n.priority,
        read: n.read,
        createdAt: n.createdAt,
      }));
    }
    if (approvals.ok) {
      input.approvals = approvals.value.map((a) => ({
        id: a.id,
        toolId: a.toolId,
        action: a.action,
        reason: a.reason,
        risk: a.risk,
        status: a.status,
      }));
    }
    if (sessions.ok) {
      const activeId = sessions.value.activeSessionId;
      input.sessions = sessions.value.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        active: s.id === activeId,
        ...(s.updatedAt !== undefined ? { updatedAt: s.updatedAt } : {}),
        ...(s.turnCount !== undefined ? { turnCount: s.turnCount } : {}),
        // The bound worker stays visible — demoted to a label in the sessions
        // view, never a headline. It is the worker's id, not KAI's identity.
        ...(s.agentId !== undefined ? { agentId: s.agentId } : {}),
        ...(s.agentSessionId !== undefined ? { agentSessionId: s.agentSessionId } : {}),
      }));
      input.activeSessionId = activeId;
    }
    if (subagents.ok) {
      // KAI's own personas. The worker each runs on rides along as a demoted field;
      // the panel leads with the SUBAGENT and shows the worker beneath it.
      input.subagents = subagents.value.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        soul: s.soul,
        workerId: s.workerId,
        capabilities: s.capabilities,
        employeeId: s.employeeId,
        status: s.status,
        enabled: s.enabled,
        problems: s.problems,
        createdAt: s.createdAt,
        ...(s.model !== undefined ? { model: s.model } : {}),
        ...(s.visual !== undefined ? { visual: s.visual } : {}),
        ...(s.instanceId !== undefined ? { instanceId: s.instanceId } : {}),
      }));
    }

    State.applyCoreSnapshot(input);

    // KAI's conversation belongs to the session, not to the island. When the
    // active session changes — or on the first snapshot after a restart — read
    // that session's OWN recorded turns from Core and make them the chat history.
    // This is what makes switching sessions restore that session's conversation,
    // and what stops one session's turns leaking into another. Core's turns are
    // KAI's recorded conversation, never a worker's raw transcript.
    const activeSessionId = State.core.activeSessionId;
    if (activeSessionId !== loadedSessionId) {
      loadedSessionId = activeSessionId;
      if (activeSessionId !== null) void loadSessionTurns(activeSessionId);
    }
  }

  /** Replaces the active session's chat history with the turns Core recorded for it. */
  async function loadSessionTurns(sessionId: string): Promise<void> {
    const turns = await client.sessionTurns(sessionId, { limit: 100 });
    if (!turns.ok) return;
    const messages = turns.value
      .filter((t) => t.role === "user" || t.role === "assistant")
      .map((t, i) => ({
        id: i + 1,
        role: t.role as "user" | "assistant",
        content: t.text,
      }));
    // Guard against a race: if the active session changed while the request was
    // in flight, this result is for a session nobody is looking at any more.
    if (State.core.activeSessionId !== sessionId) return;
    State.setChatHistory(sessionId, messages);
  }

  const stream =
    options.stream ??
    createCoreEventStream({
      baseUrl,
      onEvent: (event: CoreEvent) => {
        State.applyCoreEvent({
          ...(event.id !== undefined ? { id: event.id } : {}),
          type: event.type,
          ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
          ...(event.source !== undefined ? { source: event.source } : {}),
          payload: event.payload,
          ...(event.missionId !== undefined ? { missionId: event.missionId } : {}),
          ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
        });
      },
      onState: (conn: CoreConnState) => {
        // A stream that is down while HTTP still answers is DEGRADED: KAI knows the
        // state of things but is no longer being told about changes.
        const shown: CoreConnState = conn === "OFFLINE" && httpReachable ? "DEGRADED" : conn;
        const message =
          shown === "DEGRADED"
            ? "connected, but not receiving Core events"
            : shown === "OFFLINE"
              ? "KAI Core is not running"
              : null;
        State.setCoreConnection(shown, message);
        if (shown !== lastLoggedState) {
          lastLoggedState = shown;
          log(`connection ${shown}`);
        }
        // Every (re)connect re-reads a snapshot, so a Core restart restores the island
        // without the user restarting the desktop app.
        if (shown === "ONLINE" || shown === "DEGRADED") void refresh();
      },
    });

  function scheduleReconcile(): void {
    if (stopped || reconcileMs <= 0 || reconcileHandle !== null) return;
    reconcileHandle = setTimer(() => {
      reconcileHandle = null;
      void refresh().finally(() => scheduleReconcile());
    }, reconcileMs);
  }

  return {
    client,
    stream,

    refresh,

    start(): void {
      stopped = false;
      log("connecting");
      stream.connect();
      void refresh();
      scheduleReconcile();
    },

    stop(): void {
      stopped = true;
      if (reconcileHandle !== null) {
        clearTimer(reconcileHandle);
        reconcileHandle = null;
      }
      stream.disconnect();
    },
  };
}

/** Boots the Core link in the running app. Returns the link so it can be stopped. */
export function startCoreLink(options: CoreLinkOptions = {}): CoreLink {
  const link = createCoreLink(options);
  link.start();
  return link;
}

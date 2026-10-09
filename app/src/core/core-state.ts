/**
 * The UI's view of KAI Core.
 *
 * One slice, one reducer, no view subscribing to the network: the Core's snapshot
 * (`/state`, `/agents`, …) and its event stream both funnel through here, and views
 * read the result. Keeping the reducer pure and separate from the transport is what
 * makes "an agent event updates the UI" testable without a Core, a socket or a DOM.
 *
 * Two rules this file exists to enforce:
 *  - **Bounded memory.** The event list is a ring: a long-running Core must not grow
 *    the island's memory one frame at a time.
 *  - **No duplicates.** An SSE reconnect replays nothing today, but a dedupe-by-id on
 *    notifications and events means the UI cannot double-report the same thing — the
 *    user must never see the same notification twice because a socket blinked.
 *
 * Nothing here decides anything about agents, missions or tools: the Core is
 * authoritative and this is a mirror of what it said.
 */

/** Same union the event stream reports; declared here so the reducer has no transport dependency. */
export type CoreConnState = "CONNECTING" | "ONLINE" | "DEGRADED" | "OFFLINE";

export interface CoreAgentRow {
  id: string;
  /** "idle" | "working" | "offline" | "error" | "starting" — as reported, never invented. */
  state: string;
  detail?: string;
  lastActivity?: string;
}

export interface CoreMissionRow {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  /** Completed vs total steps, when the Core gave us the steps. */
  doneSteps?: number;
  totalSteps?: number;
  /** A failed mission keeps its reason: the island shows it rather than a bare "failed". */
  errorText?: string;
}

export interface CoreNotificationRow {
  id: string;
  title: string;
  type: string;
  priority: string;
  read: boolean;
  createdAt: string;
}

export interface CoreApprovalRow {
  id: string;
  toolId: string;
  action: string;
  reason: string;
  risk: string;
  status: string;
}

/** One of KAI's durable conversations, as the sessions view renders it. */
export interface CoreSessionRow {
  id: string;
  title: string;
  /** "ACTIVE" | "ARCHIVED", as reported. */
  status: string;
  updatedAt?: string;
  turnCount?: number;
  /** True for the one session new turns go to. Derived from the Core's active pointer. */
  active: boolean;
  /**
   * The worker this conversation is bound to (e.g. "hermes"), once a turn ran.
   * Kept so the UI can show WHICH worker KAI is using for a session — the worker
   * stays visible, demoted to a label, never a headline.
   */
  agentId?: string;
  /**
   * That worker's own conversation id. Carried for completeness and shown as a
   * demoted detail only; it is the WORKER's id, never KAI's session identity.
   */
  agentSessionId?: string;
  /**
   * One-line excerpt of the persisted digest (the objective), when Core has
   * one. Precomputed by the caller from `CoreSessionSummary.summary` — the
   * row itself never derives text.
   */
  summaryExcerpt?: string;
}

/** One recorded turn of a KAI session, as `GET /sessions/:id/turns` returns it. */
export interface CoreSessionTurnRow {
  id: string;
  /** "user" | "assistant", as reported. */
  role: string;
  text: string;
  at: string;
  /** Which worker produced an assistant turn, when Core recorded one. */
  agentId?: string;
}

/**
 * One of KAI's SUBAGENTS — a persona KAI owns (name, role, soul, visual identity,
 * preferred worker), as `GET /subagents` returns it. This is deliberately NOT a
 * worker: the worker this persona runs on is a demoted field (`workerId`), never a
 * peer of KAI. `status` is the persona's live workforce lifecycle state.
 */
export interface CoreSubagentRow {
  id: string;
  name: string;
  role: string;
  /** The persona's soul/personality, redacted. */
  soul: string;
  /** The worker this persona runs on — infrastructure beneath the subagent. */
  workerId: string;
  model?: string;
  capabilities: string[];
  /** The visual reference the KAI_VARIANT model resolves (declared + resolved). */
  visual?: { declared?: Record<string, unknown>; resolved?: unknown };
  employeeId: string;
  /** "READY" | "DEGRADED" | "UNAVAILABLE" | … as the workforce reports it. */
  status: string;
  enabled: boolean;
  instanceId?: string;
  problems: string[];
  createdAt: string;
}

/** One durable KAI session BOUND to a subagent persona (its own history). */
export interface CoreSubagentSessionRow {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  turnCount?: number;
  agentId?: string;
  agentSessionId?: string;
}

/** `GET /subagents/:id` — the persona plus the sessions bound to it. */
export interface CoreSubagentDetail {
  subagent: CoreSubagentRow;
  sessions: CoreSubagentSessionRow[];
}

export interface CoreEventRow {
  /** Event id when the Core supplied one — used for dedupe. */
  id?: string;
  type: string;
  at: string;
  text: string;
  /**
   * The event's payload, retained VERBATIM.
   *
   * The wire type is sometimes only an envelope: every Core notification is
   * published as `notification.created` with its real semantic type nested in
   * `payload.type` (see `core/src/notifications/service.ts`). Consuming the
   * payload for `text` and then dropping it loses that type before the runtime
   * machine can see it, so the payload rides on the row and is forwarded by the
   * bridge. It is deliberately untyped: it crossed a process boundary.
   */
  payload?: unknown;
}

export interface CoreSlice {
  conn: CoreConnState;
  /** Why we are not ONLINE, in words fit to show a person. */
  lastError: string | null;
  lastSyncAt: number | null;
  coreStartedAt: string | null;
  uptimeMs: number | null;
  schedulerRunning: boolean | null;
  toolCount: number | null;
  agents: CoreAgentRow[];
  missions: CoreMissionRow[];
  notifications: CoreNotificationRow[];
  approvals: CoreApprovalRow[];
  sessions: CoreSessionRow[];
  /** The Core's active pointer, or null when none has been chosen. */
  activeSessionId: string | null;
  /**
   * KAI's SUBAGENTS — its own personas, ABOVE the workers. These are what the
   * right-side panel leads with; the workers they run on are demoted beneath them.
   */
  subagents: CoreSubagentRow[];
  /** Newest first, bounded. */
  recentEvents: CoreEventRow[];
}

/** How many events the island keeps for its "what has been happening" list. */
export const CORE_EVENT_LIMIT = 20;
/** How many missions/notifications/approvals the island mirrors. */
export const CORE_LIST_LIMIT = 50;

export function initialCoreSlice(): CoreSlice {
  return {
    conn: "CONNECTING",
    lastError: null,
    lastSyncAt: null,
    coreStartedAt: null,
    uptimeMs: null,
    schedulerRunning: null,
    toolCount: null,
    agents: [],
    missions: [],
    notifications: [],
    approvals: [],
    sessions: [],
    activeSessionId: null,
    subagents: [],
    recentEvents: [],
  };
}

/** What a `/state` (+ list) refresh hands the reducer. */
export interface CoreSnapshotInput {
  agents?: CoreAgentRow[];
  missions?: CoreMissionRow[];
  notifications?: CoreNotificationRow[];
  approvals?: CoreApprovalRow[];
  sessions?: CoreSessionRow[];
  /** `null` is a real value here: "no session is active", not "leave it alone". */
  activeSessionId?: string | null;
  subagents?: CoreSubagentRow[];
  coreStartedAt?: string;
  uptimeMs?: number;
  schedulerRunning?: boolean;
  toolCount?: number;
  now?: number;
}

export function setConnection(
  slice: CoreSlice,
  conn: CoreConnState,
  error?: string | null,
): CoreSlice {
  return {
    ...slice,
    conn,
    lastError: conn === "ONLINE" ? null : (error ?? slice.lastError),
  };
}

export function applySnapshot(slice: CoreSlice, input: CoreSnapshotInput): CoreSlice {
  return {
    ...slice,
    agents: input.agents ?? slice.agents,
    missions: input.missions ?? slice.missions,
    notifications: input.notifications ?? slice.notifications,
    approvals: input.approvals ?? slice.approvals,
    sessions: input.sessions ?? slice.sessions,
    // Unlike the lists above, `null` is a meaningful active pointer, so only
    // `undefined` (the field absent) leaves the previous value in place.
    activeSessionId: input.activeSessionId === undefined ? slice.activeSessionId : input.activeSessionId,
    subagents: input.subagents ?? slice.subagents,
    coreStartedAt: input.coreStartedAt ?? slice.coreStartedAt,
    uptimeMs: input.uptimeMs ?? slice.uptimeMs,
    schedulerRunning: input.schedulerRunning ?? slice.schedulerRunning,
    toolCount: input.toolCount ?? slice.toolCount,
    lastSyncAt: input.now ?? Date.now(),
    // A successful snapshot is evidence the Core is answering, even if the stream has
    // not said so yet.
    conn: "ONLINE",
    lastError: null,
  };
}

/** An event as it arrives from the stream. Deliberately loose: it crossed a process boundary. */
export interface CoreEventInput {
  id?: string;
  type: string;
  timestamp?: string;
  source?: string;
  payload?: unknown;
  missionId?: string;
  stepId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One line of human text for an event, so the island can say something useful. */
export function summarizeEvent(type: string, payload?: unknown): string {
  const p = asRecord(payload);
  switch (type) {
    case "mission.created":
      return `Mission created${str(p["title"]) ? `: ${str(p["title"])}` : ""}`;
    case "mission.started":
      return "Mission started";
    case "mission.progress": {
      const title = str(p["title"]);
      return title !== undefined ? `Working: ${title}` : "Mission progressing";
    }
    case "mission.completed":
      return "Mission completed";
    case "mission.failed":
      return "Mission failed";
    case "mission.cancelled":
      return "Mission cancelled";
    case "agent.connected":
      return `${str(p["id"]) ?? "Agent"} connected`;
    case "agent.disconnected":
      return `${str(p["id"]) ?? "Agent"} disconnected`;
    case "agent.error":
      return `${str(p["id"]) ?? "Agent"} error`;
    case "agent.status_changed":
      return `${str(p["id"]) ?? "Agent"} is ${str(p["state"]) ?? "changed"}`;
    case "approval.requested":
      return `Approval needed: ${str(p["toolId"]) ?? str(p["action"]) ?? "an action"}`;
    case "approval.approved":
      return "Approval granted";
    case "approval.rejected":
      return "Approval rejected";
    case "notification.created":
      return str(p["title"]) ?? "Notification";
    case "memory.created":
      return "Memory stored";
    case "memory.deleted":
      return "Memory removed";
    case "scheduled_task.triggered":
      return `Scheduled task ran${str(p["title"]) ? `: ${str(p["title"])}` : ""}`;
    case "scheduler.tick_failed":
      return `Scheduler housekeeping failed${str(p["reason"]) ? `: ${str(p["reason"])}` : ""}`;
    case "session.created":
      return `Session created${str(p["title"]) ? `: ${str(p["title"])}` : ""}`;
    case "session.updated":
    case "session.renamed":
      return `Session updated${str(p["title"]) ? `: ${str(p["title"])}` : ""}`;
    case "session.activated":
    case "session.switched":
      return "Switched session";
    case "session.archived":
      return "Session archived";
    case "session.unarchived":
      return "Session restored";
    case "core.started":
      return "KAI Core started";
    case "core.stopped":
      return "KAI Core stopped";
    case "worker.started":
      return `${str(p["workerId"]) ?? "Worker"} working`;
    case "worker.heartbeat":
      return str(p["step"]) ?? str(p["note"]) ?? "Worker active";
    case "worker.progress":
      return str(p["label"]) ?? "Worker progressing";
    case "worker.waiting":
      return "Waiting for approval";
    case "worker.review":
      return "Reviewer checking";
    case "worker.completed":
      return "Work completed and verified";
    case "worker.failed":
      return `Work failed${str(p["reason"]) ? `: ${str(p["reason"])}` : ""}`;
    case "worker.cancelled":
      return "Work cancelled";
    case "review.requested":
      return "Review requested";
    case "review.decided":
      return `Review: ${str(p["verdict"]) ?? "decided"}`;
    case "delegation.routed":
      return str(p["rationale"]) ?? "Worker dispatched";
    case "work.planned":
      return str(p["rationale"]) ?? "Work planned — awaiting dispatch";
    case "benchmark.updated":
      return "Worker benchmark updated";
    case "command.started":
      return `$ ${str(p["command"]) ?? "command"} ${Array.isArray(p["args"]) ? (p["args"] as unknown[]).join(" ") : ""}`.trim();
    case "command.stdout":
    case "command.stderr": {
      // The command card renders the raw chunk; the activity line stays a
      // compact first-line marker so a chatty command never floods the feed.
      const chunk = str(p["chunk"]) ?? "";
      const first = chunk.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
      return first.length > 100 ? `${first.slice(0, 97)}…` : first;
    }
    case "command.exit": {
      const code = p["exitCode"];
      return `exit ${code === null || code === undefined ? "?" : String(code)}${typeof p["durationMs"] === "number" ? ` · ${Math.round((p["durationMs"] as number))}ms` : ""}`;
    }
    default:
      // An unknown event type still appears, labelled — silently dropping it would hide
      // a Core feature from the person looking at the island.
      return type;
  }
}

/**
 * Event name → the mission status it implies. These are the Core's real MissionStatus
 * values, not the event names: `mission.started` means RUNNING, and inventing a
 * "STARTED" status would make a running mission invisible to every filter (the active
 * count read 0 while a mission was running — the test that covers this is the reason
 * the map exists).
 */
const MISSION_STATUS_BY_EVENT: Record<string, string> = {
  "mission.created": "QUEUED",
  "mission.started": "RUNNING",
  "mission.completed": "COMPLETED",
  "mission.failed": "FAILED",
  "mission.cancelled": "CANCELLED",
};

function upsertMission(rows: CoreMissionRow[], id: string, patch: Partial<CoreMissionRow>): CoreMissionRow[] {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) {
    const created: CoreMissionRow = {
      id,
      title: patch.title ?? "Mission",
      status: patch.status ?? "RUNNING",
      ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
      ...(patch.doneSteps !== undefined ? { doneSteps: patch.doneSteps } : {}),
      ...(patch.totalSteps !== undefined ? { totalSteps: patch.totalSteps } : {}),
      ...(patch.errorText !== undefined ? { errorText: patch.errorText } : {}),
    };
    return [created, ...rows];
  }
  return rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
}

function upsertAgent(rows: CoreAgentRow[], id: string, patch: Partial<CoreAgentRow>): CoreAgentRow[] {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) {
    return [...rows, { id, state: patch.state ?? "unknown", ...patch }];
  }
  return rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
}

/**
 * Sessions converge on the snapshot (core-boot re-reads `/sessions`), so this is
 * only exercised if Core ever streams conversation-session events. It is written
 * now so the pointer and the `active` flags can never disagree with a `status`
 * change: archiving the active session clears the pointer, activating one moves
 * it and un-marks every other row.
 */
function upsertSession(
  rows: CoreSessionRow[],
  id: string,
  patch: Partial<CoreSessionRow>,
): CoreSessionRow[] {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) {
    const created: CoreSessionRow = {
      id,
      title: patch.title ?? "Conversation",
      status: patch.status ?? "ACTIVE",
      active: patch.active ?? false,
      ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
      ...(patch.turnCount !== undefined ? { turnCount: patch.turnCount } : {}),
      ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
      ...(patch.agentSessionId !== undefined ? { agentSessionId: patch.agentSessionId } : {}),
    };
    return [created, ...rows];
  }
  return rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
}

/**
 * The event → state mapping. Every branch is defensive: the payload came from another
 * process and may be missing fields or of the wrong type entirely.
 */
export function applyCoreEvent(slice: CoreSlice, event: CoreEventInput): CoreSlice {
  const at = event.timestamp ?? new Date().toISOString();
  const p = asRecord(event.payload);
  const id = str(p["id"]) ?? event.missionId;

  let next: CoreSlice = slice;

  // Record the event itself first, bounded and deduped by id.
  const row: CoreEventRow = { type: event.type, at, text: summarizeEvent(event.type, event.payload) };
  if (event.id !== undefined) row.id = event.id;
  // Retain the payload so a nested semantic type (a notification's own `type`)
  // survives to the runtime machine instead of being consumed for `text` alone.
  if (event.payload !== undefined) row.payload = event.payload;
  const alreadyHave = event.id !== undefined && slice.recentEvents.some((e) => e.id === event.id);
  if (!alreadyHave) {
    next = {
      ...next,
      recentEvents: [row, ...next.recentEvents].slice(0, CORE_EVENT_LIMIT),
    };
  }

  switch (event.type) {
    case "agent.status_changed":
    case "agent.connected":
    case "agent.disconnected":
    case "agent.error": {
      if (id === undefined) break;
      const state =
        event.type === "agent.connected"
          ? (str(p["state"]) ?? "idle")
          : event.type === "agent.disconnected"
            ? "offline"
            : event.type === "agent.error"
              ? "error"
              : (str(p["state"]) ?? undefined);
      const patch: Partial<CoreAgentRow> = { lastActivity: at };
      if (state !== undefined) patch.state = state;
      const detail = str(p["detail"]) ?? str(p["reason"]);
      if (detail !== undefined) patch.detail = detail;
      next = { ...next, agents: upsertAgent(next.agents, id, patch) };
      break;
    }

    case "mission.created":
    case "mission.started":
    case "mission.progress":
    case "mission.completed":
    case "mission.failed":
    case "mission.cancelled": {
      if (id === undefined) break;
      const patch: Partial<CoreMissionRow> = { updatedAt: at };
      const title = str(p["title"]);
      if (title !== undefined) patch.title = title;
      // An explicit status from the Core wins over our inference — it is authoritative.
      const explicit = str(p["status"]);
      const implied = MISSION_STATUS_BY_EVENT[event.type];
      if (explicit !== undefined) patch.status = explicit;
      else if (implied !== undefined) patch.status = implied;
      // A progress event carries no status of its own: keep the row's, defaulting to
      // RUNNING for a mission we have not seen before.
      else if (next.missions.find((m) => m.id === id) === undefined) patch.status = "RUNNING";
      const total = num(p["totalSteps"]) ?? num(p["steps"]);
      const done = num(p["doneSteps"]) ?? num(p["index"]);
      if (total !== undefined) patch.totalSteps = total;
      if (done !== undefined) patch.doneSteps = done;
      if (event.type === "mission.failed") {
        const reason = str(p["message"]) ?? str(p["reason"]) ?? str(p["error"]);
        patch.errorText = reason ?? "failed";
      }
      next = { ...next, missions: upsertMission(next.missions, id, patch).slice(0, CORE_LIST_LIMIT) };
      break;
    }

    case "notification.created": {
      const notifId = str(p["id"]);
      if (notifId === undefined) break;
      if (next.notifications.some((n) => n.id === notifId)) break; // dedupe across reconnects
      const created: CoreNotificationRow = {
        id: notifId,
        title: str(p["title"]) ?? "Notification",
        type: str(p["type"]) ?? "notification",
        priority: str(p["priority"]) ?? "NORMAL",
        read: p["read"] === true,
        createdAt: str(p["createdAt"]) ?? at,
      };
      next = { ...next, notifications: [created, ...next.notifications].slice(0, CORE_LIST_LIMIT) };
      break;
    }

    case "notification.read": {
      const notifId = str(p["id"]);
      if (notifId === undefined) break;
      next = {
        ...next,
        notifications: next.notifications.map((n) => (n.id === notifId ? { ...n, read: true } : n)),
      };
      break;
    }

    case "approval.requested": {
      const approvalId = str(p["id"]);
      if (approvalId === undefined) break;
      if (next.approvals.some((a) => a.id === approvalId)) break;
      const created: CoreApprovalRow = {
        id: approvalId,
        toolId: str(p["toolId"]) ?? "unknown",
        action: str(p["action"]) ?? "action",
        reason: str(p["reason"]) ?? "",
        risk: str(p["risk"]) ?? "WRITE",
        status: "PENDING",
      };
      next = { ...next, approvals: [created, ...next.approvals].slice(0, CORE_LIST_LIMIT) };
      break;
    }

    case "approval.approved":
    case "approval.rejected": {
      const approvalId = str(p["id"]);
      if (approvalId === undefined) break;
      const status = event.type === "approval.approved" ? "APPROVED" : "REJECTED";
      next = {
        ...next,
        approvals: next.approvals.map((a) => (a.id === approvalId ? { ...a, status } : a)),
      };
      break;
    }

    case "session.created":
    case "session.updated":
    case "session.renamed": {
      if (id === undefined) break;
      const patch: Partial<CoreSessionRow> = { updatedAt: at };
      const title = str(p["title"]);
      if (title !== undefined) patch.title = title;
      const status = str(p["status"]);
      if (status !== undefined) patch.status = status;
      const turnCount = num(p["turnCount"]);
      if (turnCount !== undefined) patch.turnCount = turnCount;
      const agentId = str(p["agentId"]);
      if (agentId !== undefined) patch.agentId = agentId;
      const agentSessionId = str(p["agentSessionId"]);
      if (agentSessionId !== undefined) patch.agentSessionId = agentSessionId;
      next = { ...next, sessions: upsertSession(next.sessions, id, patch).slice(0, CORE_LIST_LIMIT) };
      break;
    }

    case "session.activated":
    case "session.switched": {
      if (id === undefined) break;
      next = {
        ...next,
        activeSessionId: id,
        sessions: next.sessions.map((s) => (s.id === id ? { ...s, active: true } : { ...s, active: false })),
      };
      break;
    }

    case "session.archived": {
      if (id === undefined) break;
      next = {
        ...next,
        sessions: next.sessions.map((s) => (s.id === id ? { ...s, status: "ARCHIVED", active: false } : s)),
        activeSessionId: next.activeSessionId === id ? null : next.activeSessionId,
      };
      break;
    }

    case "session.unarchived": {
      if (id === undefined) break;
      next = {
        ...next,
        sessions: next.sessions.map((s) => (s.id === id ? { ...s, status: "ACTIVE" } : s)),
      };
      break;
    }

    case "core.stopped":
      // The Core said goodbye; the stream will close next. Say so now rather than
      // waiting for the socket to fail, so the island reacts immediately.
      next = { ...next, conn: "OFFLINE", lastError: "KAI Core stopped" };
      break;

    case "core.started":
      next = { ...next, lastSyncAt: Date.now() };
      break;

    default:
      break;
  }

  return next;
}

/** Counts the island shows on the overview, derived from the mirror (never invented). */
export function coreCounts(slice: CoreSlice): {
  activeMissions: number;
  unread: number;
  pendingApprovals: number;
} {
  return {
    activeMissions: slice.missions.filter(
      (m) => m.status === "RUNNING" || m.status === "WAITING" || m.status === "WAITING_APPROVAL" || m.status === "QUEUED",
    ).length,
    unread: slice.notifications.filter((n) => !n.read).length,
    pendingApprovals: slice.approvals.filter((a) => a.status === "PENDING").length,
  };
}

// ── Subagents: deriving activity from real Core state ─────────────────────────
//
// A subagent run goes through the ONE policy-governed `agents.run_task`, which is
// EXTERNAL and therefore PARKS: the runtime records a PENDING approval whose
// `action` is the run's task id, `subagent:<id>` (see core/src/runtime.ts
// `runSubagent`). So a subagent is ACTIVE when such an approval is pending — that
// is the real, API-sourced signal, and two subagents parked at once is exactly the
// concurrency the runtime layer proved. Nothing here is inferred from a client
// timer or an animation.

/** The token a subagent's parked approval carries. */
export function subagentApprovalToken(id: string): string {
  return `subagent:${id}`;
}

/** The PENDING approval belonging to a subagent, or null. */
export function subagentPendingApproval(
  slice: CoreSlice,
  id: string,
): CoreApprovalRow | null {
  const token = subagentApprovalToken(id);
  return (
    slice.approvals.find(
      (a) => a.status === "PENDING" && (a.action === token || a.action.includes(token)),
    ) ?? null
  );
}

/**
 * A subagent's activity, from real Core state only.
 *
 * `active` is true when a run for this persona is parked for approval — the one
 * honest "this subagent is doing something right now" signal the API carries.
 * `standby` is true when the persona's employee is healthy but idle.
 */
export function subagentActivity(
  slice: CoreSlice,
  sub: CoreSubagentRow,
): { active: boolean; standby: boolean; label: string; approvalId: string | null } {
  const pending = subagentPendingApproval(slice, sub.id);
  if (pending !== null) {
    return { active: true, standby: false, label: "active · awaiting approval", approvalId: pending.id };
  }
  const healthy = sub.enabled || sub.status === "READY" || sub.status === "DEGRADED";
  return {
    active: false,
    standby: healthy,
    label: healthy ? "standing by" : sub.status.toLowerCase(),
    approvalId: null,
  };
}

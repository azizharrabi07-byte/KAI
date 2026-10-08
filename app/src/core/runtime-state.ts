/**
 * KAI's RUNTIME state — what KAI is *doing*, as distinct from where the island is
 * placed (see `src/island/fsm.ts` for the placement machine) and from a worker's
 * own state (see `BotStateName` for the character's rendering vocabulary).
 *
 * Why this exists: the island used to have exactly four states — hidden, petit,
 * home, greet — which describe a *window*, not an agent. KAI's face then had to
 * borrow the focused worker's `BotStateName` to look busy, which is precisely the
 * "Hermes wearing a KAI persona" failure: KAI looked like whatever worker happened
 * to be focused.
 *
 * This machine is the fix. It is **event-driven and honest**:
 *   - every non-IDLE state is ENTERED by a real event (a Core event, a Claude Code
 *     hook, or a genuine local user action) and LEFT by a real event;
 *   - the only exception is a *bounded safeguard* (SUCCESS/ERROR hold briefly, and
 *     a stranded active state times out) that returns to IDLE — never a timer
 *     that invents work;
 *   - each transition carries the event/correlation id that caused it, so a UI
 *     state can always be traced back to the event behind it.
 *
 * The module is pure: no DOM, no Tauri, no network. That is what makes every
 * transition testable with a hand-built event.
 */

import type { BotStateName } from "./layout";

/**
 * What KAI is doing. The full runtime vocabulary the directive names, widened
 * past the first twelve so the island can distinguish the activities a person
 * actually wants to tell apart (coding vs. browsing vs. running a command vs.
 * driving the computer), while still keeping the coarse WORKING/USING_TOOL/
 * WAITING states for events that carry no finer detail.
 *
 * Every one of these is entered by a REAL event (see `stateForEvent`); none is
 * entered by a timer. The character's own state → source-pose mapping lives in
 * `character/types.ts` (`KAI_STATE_POSE`); the auditable table is reproduced in
 * the header of that file.
 */
export type KaiRuntimeState =
  | "IDLE"
  | "LISTENING"
  | "THINKING"
  | "PLANNING"
  | "RESEARCHING"
  | "BROWSING"
  | "CODING"
  | "WORKING"
  | "USING_TOOL"
  | "USING_CLI"
  | "USING_BROWSER"
  | "USING_CUA"
  | "DELEGATING"
  | "MULTI_AGENT"
  | "WAITING"
  | "WAITING_APPROVAL"
  /**
   * KAI needs a HUMAN for something that is not a tool approval — a decision,
   * information, a blocked external system, an unavailable worker or a broken
   * credential. Distinct from WAITING_APPROVAL, which is specifically "approve
   * this one call". It is entered by a REAL Core event: a HIGH/CRITICAL-priority
   * notification, or one of the explicit attention semantic types below. The
   * island's own structured attention surface (`island/attention.ts`) enumerates
   * the reasons; this state is the single face that says "look at me".
   */
  | "NEEDS_USER"
  | "LEARNING"
  | "BUILDING_SKILL"
  | "RECOVERING"
  | "SUCCESS"
  | "ERROR"
  | "OFFLINE";

/** The Core's connection state, as the island already models it. */
export type RuntimeConnection = "CONNECTING" | "ONLINE" | "DEGRADED" | "OFFLINE";

/**
 * An event as it arrives from the Core stream (or a local signal). Deliberately
 * loose: it crossed a process boundary, so only `type` is guaranteed.
 */
export interface RuntimeEventInput {
  id?: string;
  type: string;
  timestamp?: string;
  source?: string;
  payload?: unknown;
  missionId?: string;
  stepId?: string;
}

/** One transition, with the correlation ids of whatever caused it. */
export interface RuntimeTransition {
  from: KaiRuntimeState;
  to: KaiRuntimeState;
  /** The event type (or local signal name) that caused this. */
  cause: string;
  /** The Core event id, when the cause was a Core event. Traceability. */
  eventId?: string;
  missionId?: string;
  stepId?: string;
  /** Wall-clock ms, so a transition log can be ordered. */
  at: number;
}

// ── KAI-facing labels ─────────────────────────────────────────────────────────

/**
 * What KAI says about itself in each state. First person, KAI as the actor; a
 * worker is never the subject. Views render these instead of a worker's name.
 */
export const RUNTIME_LABELS: Record<KaiRuntimeState, string> = {
  IDLE: "KAI is idle",
  LISTENING: "KAI is listening",
  THINKING: "KAI is thinking…",
  PLANNING: "KAI is planning…",
  RESEARCHING: "KAI is researching…",
  BROWSING: "KAI is browsing…",
  CODING: "KAI is coding…",
  WORKING: "KAI is working…",
  USING_TOOL: "KAI is using a tool…",
  USING_CLI: "KAI is running a command…",
  USING_BROWSER: "KAI is driving a browser…",
  USING_CUA: "KAI is driving the computer…",
  DELEGATING: "KAI is working through a worker…",
  MULTI_AGENT: "KAI is running several workers…",
  WAITING: "KAI is waiting…",
  WAITING_APPROVAL: "KAI needs your approval",
  NEEDS_USER: "KAI needs you",
  LEARNING: "KAI is learning…",
  BUILDING_SKILL: "KAI is building a skill…",
  RECOVERING: "KAI is recovering…",
  SUCCESS: "KAI finished",
  ERROR: "KAI hit an error",
  OFFLINE: "KAI Core is offline",
};

/**
 * The runtime state → the character's own state vocabulary. This is the bridge
 * to `src/character/engine.ts`'s `setState(BotStateName)`. The character agent is
 * widening `BotStateName` to accept the runtime names directly; until that lands
 * this maps each runtime state onto the closest existing character state, so
 * KAI's face reflects KAI's real state instead of a worker's.
 */
export function characterStateFor(state: KaiRuntimeState): BotStateName {
  switch (state) {
    case "IDLE":
      return "idle";
    // Attentive, not busy: the user is typing, KAI is not yet doing anything.
    case "LISTENING":
      return "idle";
    case "THINKING":
      return "thinking";
    case "PLANNING":
      return "thinking";
    // Researching, browsing and using a browser are all "looking something up":
    // the legacy `searching` state (its own colour + scan) is the closest fit.
    case "RESEARCHING":
    case "BROWSING":
    case "USING_BROWSER":
      return "searching";
    // Coding / running a command / driving the computer / building a skill are
    // all "doing focused work": the legacy `working` glow.
    case "CODING":
    case "USING_CLI":
    case "USING_CUA":
    case "BUILDING_SKILL":
      return "working";
    case "WORKING":
      return "working";
    case "USING_TOOL":
      return "searching";
    case "DELEGATING":
      return "working";
    case "MULTI_AGENT":
      return "working";
    case "WAITING":
      return "thinking";
    case "WAITING_APPROVAL":
    // "KAI needs you" is the same amber, big-eyed "asks for help" face as an
    // approval: the user must look, and the reason is spelled out by the island's
    // attention surface rather than by the character.
    case "NEEDS_USER":
      return "approval";
    case "LEARNING":
      return "thinking";
    case "RECOVERING":
      return "thinking";
    case "SUCCESS":
      return "finished";
    case "ERROR":
      return "error";
    case "OFFLINE":
      return "sleeping";
  }
}

// ── Event → state ─────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The activity a named tool implies. This is the REAL fine-grained signal: a
 * Claude Code `PreToolUse` hook carries `tool_name` (`Bash`, `Write`,
 * `WebSearch`, `Task`, an MCP `computer_use` tool, …), and the MCP/hermes worker
 * streams carry a tool id. Nothing here is inferred from timing — an unknown
 * tool falls back to the coarse USING_TOOL rather than guessing.
 *
 * Ordered most-specific first; the first pattern that matches wins.
 */
export function toolStateFor(tool: string | undefined): KaiRuntimeState {
  const t = (tool ?? "").toLowerCase();
  if (t === "") return "USING_TOOL";
  // Driving a real computer / desktop (the computer-use/CUA tool family).
  if (/(computer[_-]?use|\bcua\b|desktop[_-]?control|screenshot|click_at)/.test(t)) return "USING_CUA";
  // Running a command line.
  if (/(^|[^a-z])(bash|powershell|shell|terminal|exec|command|run[_-]?command|subprocess)([^a-z]|$)/.test(t)) {
    return "USING_CLI";
  }
  // A browser / navigation tool.
  if (/(web[_-]?fetch|fetch[_-]?url|browser|playwright|puppeteer|navigate|open[_-]?url|new[_-]?tab)/.test(t)) {
    return "BROWSING";
  }
  // Searching / looking something up.
  if (/(web[_-]?search|search|grep|glob|(?<![a-z])ls(?![a-z])|find|lookup|query)/.test(t)) {
    return "RESEARCHING";
  }
  // Handing work to another agent (the Task/subagent tool).
  if (/((?<![a-z])task(?![a-z])|subagent|delegate|dispatch)/.test(t)) return "DELEGATING";
  // Writing / editing code.
  if (/(write|edit|multi[_-]?edit|notebook|apply[_-]?patch|str[_-]?replace|patch|create[_-]?file|code)/.test(t)) {
    return "CODING";
  }
  // Reading source is a coding activity more often than not.
  if (/(read|cat|open[_-]?file)/.test(t)) return "CODING";
  return "USING_TOOL";
}

/**
 * The real-event mapping. Every branch names an event the Core (or the island's
 * own hook server) actually emits; a type with no mapping returns `null` and
 * changes nothing — an unknown event is not an excuse to invent a state.
 *
 * Two families are handled:
 *   - control-plane events (the `/core/events` SSE stream): mission.*, approval.*,
 *     action.executed, agent.*, core.*, scheduled_task.triggered;
 *   - worker runtime events (turn.*, item.*, request.*) IF they reach the stream.
 *     They are mapped here so the FSM is ready, but note in the report that no
 *     `TurnAdapter` provider is currently attached to the Core's bus, so the Core
 *     does not emit them on the wire today.
 */
export function stateForEvent(
  event: RuntimeEventInput,
): { state: KaiRuntimeState; cause: string } | null {
  // ── the generic-notification envelope ──────────────────────────────────────
  // Some semantic events travel wrapped: `notifications/service.ts` publishes
  // EVERY Core notification on the wire as `notification.created`, with the real
  // event type nested in `payload.type` (e.g. `mission.recovery_blocked`). The
  // switch below keys on `event.type`, so without this the wrapped event is
  // invisible — the `mission.recovery_blocked` branch could never fire. Resolve
  // the nested type HERE, in the one canonical event→state table, and re-enter
  // this same mapping: no second event model, no duplicated branch, and the
  // semantic type survives the envelope.
  if (event.type === "notification.created") {
    const nested = str(asRecord(event.payload)["type"]);
    if (nested === undefined || nested === event.type) return null;
    const mapped = stateForEvent({ ...event, type: nested });
    if (mapped !== null) return mapped;
    // The envelope carried a semantic type that is not one of the lifecycle
    // types above, but the Core marked it HIGH or CRITICAL. A high-priority
    // notification is KAI raising its hand: it is a REAL event (the priority is a
    // real Core field, `notifications/service.ts` coerces it) and the honest face
    // for it is NEEDS_USER, not a silent no-op. A LOW/NORMAL notification with an
    // unmapped type still changes nothing (asserted in runtime-state.test.ts).
    const priority = str(asRecord(event.payload)["priority"]);
    if (priority === "HIGH" || priority === "CRITICAL") {
      return { state: "NEEDS_USER", cause: `${event.type}:${nested}` };
    }
    return null;
  }

  const p = asRecord(event.payload);
  switch (event.type) {
    // ── missions: KAI planning and executing its own work ────────────────────
    case "mission.created":
      return { state: "PLANNING", cause: event.type };
    case "mission.started":
    case "mission.progress":
      return { state: "WORKING", cause: event.type };
    case "mission.completed":
      return { state: "SUCCESS", cause: event.type };
    case "mission.failed":
    case "mission.cancelled":
      return { state: "ERROR", cause: event.type };
    // A mission that failed before/after a side effect is under recovery, not
    // simply failed: the Core emits this while the recovery engine replays or
    // blocks the step.
    case "mission.recovery_blocked":
      return { state: "RECOVERING", cause: event.type };

    // ── KAI needs a human, and it is not a tool approval ─────────────────────
    // These are the semantic types a Core notification uses to say "a person has
    // to act": an external system blocked the work, a worker KAI depends on is
    // gone, or a credential is broken. They arrive wrapped in `notification.created`
    // (resolved above) and are mapped to the one NEEDS_USER face; the island's
    // attention surface (`island/attention.ts`) recovers the SPECIFIC reason for
    // the user. Forward-compatible: the envelope + priority fallback above is the
    // path that works with today's Core, and these names are the vocabulary the
    // moment Core emits them.
    case "mission.blocked":
    case "worker.unavailable":
    case "agent.unavailable":
    case "auth.required":
    case "authentication.required":
    case "credential.invalid":
    case "credential.expired":
      return { state: "NEEDS_USER", cause: event.type };

    // ── approvals: KAI is blocked on the user ────────────────────────────────
    case "approval.requested":
    case "request.opened":
      return { state: "WAITING_APPROVAL", cause: event.type };
    case "approval.approved":
    case "approval.rejected":
    case "request.resolved":
      // The decision unblocks KAI; the mission's own progress event will follow.
      return { state: "WORKING", cause: event.type };
    case "approval.expired":
      return { state: "IDLE", cause: event.type };

    // ── actions: a tool ran, directly or through a worker ────────────────────
    case "action.executed": {
      // The action record names the executor: an `employeeId` means KAI delegated.
      const employeeId = str(p["employeeId"]);
      if (employeeId !== undefined) return { state: "DELEGATING", cause: event.type };
      // No executor: classify by the tool itself, when the record names one.
      // `capabilityId`/`toolId` are the real fields the Core writes; an action
      // with neither stays the coarse USING_TOOL.
      const tool = str(p["toolId"]) ?? str(p["capabilityId"]) ?? str(p["tool"]);
      if (tool !== undefined) {
        return { state: toolStateFor(tool), cause: `${event.type}:${tool}` };
      }
      return { state: "USING_TOOL", cause: event.type };
    }
    case "scheduled_task.triggered":
      return { state: "WORKING", cause: event.type };

    // ── agents/workers: KAI's workforce reporting in ─────────────────────────
    case "agent.status_changed":
    case "agent.connected": {
      const s = str(p["state"]) ?? (event.type === "agent.connected" ? "idle" : undefined);
      switch (s) {
        case "working":
        case "running":
          return { state: "WORKING", cause: `${event.type}:${s}` };
        case "thinking":
        case "starting":
        case "connecting":
          return { state: "THINKING", cause: `${event.type}:${s}` };
        case "waiting":
          return { state: "WAITING", cause: `${event.type}:${s}` };
        case "error":
          return { state: "ERROR", cause: `${event.type}:${s}` };
        // idle/offline: a worker resting says nothing about what KAI is doing.
        default:
          return null;
      }
    }
    case "agent.error":
      return { state: "ERROR", cause: event.type };
    case "agent.disconnected":
      // A worker leaving does not stop KAI; it just loses an employee.
      return null;

    // ── subagent runs: KAI's own personas working ──────────────────────────
    case "agent.spawned":
      return { state: "WORKING", cause: event.type };
    case "agent.run_started":
      return { state: "DELEGATING", cause: event.type };
    case "agent.run_completed":
      return { state: "SUCCESS", cause: event.type };
    case "agent.run_failed":
      return { state: "ERROR", cause: event.type };
    case "agent.run_cancelled":
      return { state: "IDLE", cause: event.type };

    // ── worker runtime events (mapped if they ever reach the stream) ─────────
    case "turn.started":
      return { state: "THINKING", cause: event.type };
    // A worker started a tool. The hook payload names it (`tool_name`), which is
    // what lets KAI's face say "coding" vs "browsing" vs "running a command"
    // instead of a single generic "using a tool".
    case "item.started": {
      const tool = str(p["tool_name"]) ?? str(p["tool"]);
      return { state: toolStateFor(tool), cause: tool !== undefined ? `${event.type}:${tool}` : event.type };
    }
    case "item.completed":
      return { state: "WORKING", cause: event.type };
    case "turn.completed":
      return { state: "SUCCESS", cause: event.type };
    case "turn.failed":
      return { state: "ERROR", cause: event.type };

    // ── the Core itself ──────────────────────────────────────────────────────
    case "core.stopped":
      return { state: "OFFLINE", cause: event.type };
    case "core.started":
      return { state: "IDLE", cause: event.type };

    default:
      return null;
  }
}

/** Event types that are allowed to leave WAITING_APPROVAL. */
const APPROVAL_LEAVING = new Set([
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "request.resolved",
  "mission.completed",
  "mission.failed",
  "mission.cancelled",
  "core.stopped",
]);

/**
 * The event-driven runtime state machine.
 *
 * Usage: `applyEvent()` for every Core event (deduped by id), `setConnection()`
 * for the stream's own state, the local signals for genuine user actions, and
 * `tick()` from the frame loop for the bounded safeguard only.
 */
export class KaiRuntimeMachine {
  state: KaiRuntimeState = "IDLE";
  /** The transition that produced `state`, for tracing and for the UI. */
  lastTransition: RuntimeTransition | null = null;
  onTransition: ((t: RuntimeTransition) => void) | null = null;

  /** SUCCESS/ERROR hold this long, then return to IDLE (a bounded safeguard). */
  resultHoldMs = 4_000;
  /**
   * A bounded maximum for any active state. If a terminal event is ever missed
   * (a dropped frame), KAI must not sit "working" forever — this returns to IDLE.
   * It is a safeguard, never the mechanism: nothing enters a state because a
   * timer expired.
   */
  maxActiveMs = 600_000;

  /**
   * How long a connection outage may persist before KAI is shown OFFLINE.
   *
   * The defect this closes: `setConnection` entered OFFLINE only on the exact
   * string `"OFFLINE"`, but a Core death with a retry pending stays `CONNECTING`
   * (see `core-events.ts`) — so the machine never left its last active pose and
   * the island kept saying "KAI is using a tool…" long after the runtime was
   * gone. A short grace is used rather than flipping on the first failed poll, so
   * a genuine reconnect blip does not strobe the character.
   */
  offlineGraceMs = 1_500;

  private enteredAt = 0;
  private seen = new Set<string>();
  private composing = false;
  /**
   * Live subagents, counted from REAL `subagent.started` / `subagent.stopped`
   * events. Two or more running at once is what makes KAI's face enter the
   * multi-agent behaviour; a single one is delegation. Never inferred from a
   * timer, and clamped at zero so a duplicate stop cannot go negative.
   */
  private subagents = 0;
  /**
   * Latched once TWO subagents have run at the same time. The multi-agent
   * behaviour then HOLDS while any remain: a naive `count >= 2 ? MULTI_AGENT :
   * DELEGATING` recomputed on every event drops KAI out of MULTI_AGENT the
   * instant one of two finishes, even though another is still running. The latch
   * is cleared only when the last subagent stops, so the behaviour is entered and
   * left by real events — never by the count crossing back under two.
   */
  private multiAgent = false;
  /** When the connection first stopped being ONLINE, or null while it is healthy. */
  private unhealthySince: number | null = null;

  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.enteredAt = now();
  }

  private go(
    next: KaiRuntimeState,
    cause: string,
    ids: { eventId?: string; missionId?: string; stepId?: string } = {},
    at = this.now(),
  ): boolean {
    if (next === this.state) return false;
    const from = this.state;
    this.state = next;
    this.enteredAt = at;
    const t: RuntimeTransition = { from, to: next, cause, at };
    if (ids.eventId !== undefined) t.eventId = ids.eventId;
    if (ids.missionId !== undefined) t.missionId = ids.missionId;
    if (ids.stepId !== undefined) t.stepId = ids.stepId;
    this.lastTransition = t;
    this.onTransition?.(t);
    return true;
  }

  /** Feed one Core event. Deduped by id; returns true when a transition happened. */
  applyEvent(event: RuntimeEventInput, at = this.now()): boolean {
    if (event.id !== undefined) {
      if (this.seen.has(event.id)) return false;
      this.seen.add(event.id);
      if (this.seen.size > 256) {
        // Bounded: keep only the most recent ids. A ring would be nicer, but the
        // set only exists to stop a reconnect replaying an event twice.
        const first = this.seen.values().next().value;
        if (first !== undefined) this.seen.delete(first);
      }
    }

    const mapped = stateForEvent(event);
    if (mapped === null) {
      // Subagent concurrency is a machine-level fact (a count), so it is handled
      // here rather than in the pure event→state table. `subagent.started` /
      // `subagent.stopped` are REAL events (Claude Code's `SubagentStart` /
      // `SubagentStop` hooks); two live at once enters the multi-agent behaviour.
      if (event.type === "subagent.started" || event.type === "subagent.stopped") {
        const started = event.type === "subagent.started";
        this.subagents = Math.max(0, this.subagents + (started ? 1 : -1));
        // Two live at once enters the multi-agent behaviour; one is delegation.
        if (this.subagents >= 2) this.multiAgent = true;
        // OFFLINE is owned by the connection, not by business events.
        if (this.state === "OFFLINE") return false;
        // The last subagent finishing does not end the turn — the parent worker
        // is still going, so fall back to WORKING rather than inventing IDLE.
        if (!started && this.subagents === 0) {
          this.multiAgent = false;
          return this.go("WORKING", `${event.type}:none-left`, {}, at);
        }
        // While the latch holds, one finishing leaves KAI in MULTI_AGENT because
        // others are still running. Only a count that never reached two (or a
        // fully drained set) reads as plain delegation.
        const to: KaiRuntimeState = this.multiAgent ? "MULTI_AGENT" : "DELEGATING";
        return this.go(to, `${event.type}:${this.subagents}`, {}, at);
      }
      return false;
    }

    // WAITING_APPROVAL and NEEDS_USER are sticky: an unrelated worker event must
    // not clear a question the user has not answered. Only a decision or a
    // terminal event may.
    if (
      (this.state === "WAITING_APPROVAL" || this.state === "NEEDS_USER") &&
      !APPROVAL_LEAVING.has(event.type)
    ) {
      return false;
    }
    // OFFLINE is owned by the connection, not by business events.
    if (this.state === "OFFLINE" && event.type !== "core.started") {
      return false;
    }

    return this.go(mapped.state, mapped.cause, {
      ...(event.id !== undefined ? { eventId: event.id } : {}),
      ...(event.missionId !== undefined ? { missionId: event.missionId } : {}),
      ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
    }, at);
  }

  /**
   * The stream's own state.
   *
   * OFFLINE is still entered and left only here (business events cannot), but an
   * outage no longer has to be spelled `"OFFLINE"` to count: CONNECTING (a retry
   * is pending) and DEGRADED are also "not online", and they arm the grace timer
   * that `tick()` turns into OFFLINE. A real reconnection — the ONLINE event —
   * clears the outage and leaves OFFLINE for a clean IDLE; the Core's own events
   * then re-drive the pose, so recovery is never a guess or a stale pose.
   */
  setConnection(conn: RuntimeConnection, at = this.now()): boolean {
    if (conn === "ONLINE") {
      this.unhealthySince = null;
      if (this.state === "OFFLINE") {
        return this.go("IDLE", "core.connection.ONLINE", {}, at);
      }
      return false;
    }
    // CONNECTING | DEGRADED | OFFLINE: the runtime is not answering. Record when
    // the outage began, once, so repeated polls cannot keep pushing the deadline out.
    if (this.unhealthySince === null) this.unhealthySince = at;
    return false;
  }

  /** LISTENING: the user is composing in the input. A real local signal. */
  setComposing(active: boolean, at = this.now()): boolean {
    if (active === this.composing) return false;
    this.composing = active;
    if (active) {
      // Only from a resting state; never over work that is genuinely happening.
      if (this.state === "IDLE") return this.go("LISTENING", "input.composing", {}, at);
      return false;
    }
    if (this.state === "LISTENING") return this.go("IDLE", "input.idle", {}, at);
    return false;
  }

  /** THINKING: the user submitted a turn to KAI. A real local user action. */
  turnSubmitted(at = this.now()): boolean {
    // While the runtime is offline, a local submit cannot make KAI look busy: the
    // turn has nowhere to go. OFFLINE is left only by a real reconnection.
    if (this.state === "OFFLINE") return false;
    return this.go("THINKING", "chat.turn.submitted", {}, at);
  }

  /** SUCCESS/ERROR: KAI's turn resolved. `ok` decides which. */
  turnResolved(ok: boolean, at = this.now()): boolean {
    if (this.state === "OFFLINE") return false;
    return this.go(ok ? "SUCCESS" : "ERROR", "chat.turn.settled", {}, at);
  }

  /**
   * The bounded safeguard, called from the frame loop. Nothing here ENTERS a
   * state: it only returns a transient result to IDLE after its hold, and a
   * stranded active state to IDLE after `maxActiveMs`.
   */
  tick(at = this.now()): void {
    // A connection outage that outlives the grace period is a real offline: KAI
    // must not keep showing a stale active pose. A blip shorter than the grace
    // never flips, because the reconnection clears `unhealthySince` first.
    if (
      this.state !== "OFFLINE" &&
      this.unhealthySince !== null &&
      at - this.unhealthySince >= this.offlineGraceMs
    ) {
      this.go("OFFLINE", "core.connection.lost", {}, at);
      return;
    }
    if (this.state === "SUCCESS" || this.state === "ERROR") {
      if (at - this.enteredAt >= this.resultHoldMs) this.go("IDLE", "hold.elapsed", {}, at);
      return;
    }
    if (
      this.state !== "IDLE" &&
      this.state !== "OFFLINE" &&
      this.state !== "WAITING_APPROVAL" &&
      this.state !== "NEEDS_USER" &&
      this.state !== "LISTENING" &&
      at - this.enteredAt >= this.maxActiveMs
    ) {
      this.go("IDLE", "safeguard.timeout", {}, at);
    }
  }

  /** Test/teardown helper: back to a clean IDLE. */
  reset(): void {
    this.state = "IDLE";
    this.enteredAt = this.now();
    this.lastTransition = null;
    this.seen.clear();
    this.composing = false;
    this.subagents = 0;
    this.multiAgent = false;
    this.unhealthySince = null;
  }
}

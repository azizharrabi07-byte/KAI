/**
 * Worker-activity presentation that keeps KAI the speaker.
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * A worker — `hermes`, `opencode`, a Claude Code subagent — must never be the
 * SUBJECT of the sentence KAI says about what is happening. KAI is the actor:
 * "KAI is coding…", not "hermes is coding". The worker stays VISIBLE, but
 * DEMOTED: it rides on the presentation as a `worker` field a view can render
 * as a small label, never as the headline.
 *
 * Why a separate module: `runtime-state.ts` maps an event to KAI's STATE; this
 * module maps that state (and the raw event) to the SENTENCE a view shows, and
 * is the single place the KAI-vs-worker framing is decided. Deriving the
 * sentence per-view is how the "Hermes wearing a KAI persona" defect came back
 * the first time.
 *
 * It is pure: no DOM, no network, no Tauri. Every sentence is testable with a
 * hand-built event.
 */

import {
  RUNTIME_LABELS,
  stateForEvent,
  type KaiRuntimeState,
  type RuntimeEventInput,
} from "../core/runtime-state";

/** The demoted worker behind an activity. Never the sentence's subject. */
export interface PresentedWorker {
  id: string;
  /** "working" | "idle" | … as the payload reported it, when it did. */
  state?: string;
  /** A short reason the payload carried, when it did. */
  detail?: string;
}

/** One KAI-subject presentation of an event. */
export interface PresentedActivity {
  /**
   * KAI's runtime state this event implies, or `null` when the event reports
   * something about a worker without changing what KAI is doing (a worker that
   * went idle). A `null` state means "do not move KAI's pose".
   */
  state: KaiRuntimeState | null;
  /** The sentence, always with KAI as the subject. */
  line: string;
  /** The worker behind it, demoted. `null` when no worker is named. */
  worker: PresentedWorker | null;
  /** The event type (or a finer `type:detail` key) that produced this. */
  cause: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The worker an event names, if any. The Core's agent events carry `id`; an
 * action record carries `employeeId`; a mission/step may carry `agentId`. The
 * FIRST match wins, in the order the Core writes them.
 */
export function workerOf(event: RuntimeEventInput): PresentedWorker | null {
  const p = asRecord(event.payload);
  const id = str(p["employeeId"]) ?? str(p["agentId"]) ?? str(p["id"]);
  if (id === undefined) return null;
  const worker: PresentedWorker = { id };
  const state = str(p["state"]);
  if (state !== undefined) worker.state = state;
  const detail = str(p["detail"]) ?? str(p["reason"]);
  if (detail !== undefined) worker.detail = detail;
  return worker;
}

/** KAI's own sentence for a state. The one place a view should read it from. */
export function presentRuntime(state: KaiRuntimeState): string {
  return RUNTIME_LABELS[state];
}

/**
 * KAI's sentence for a worker's status, framed as KAI's own workforce state.
 *
 * A worker going idle or offline does NOT change KAI's pose — KAI is designed to
 * run with a worker down — so the `state` is `null` and only the sentence is
 * produced. The worker is named only in the trailing clause.
 */
function workerStatusLine(worker: PresentedWorker): PresentedActivity {
  const who = `worker "${worker.id}"`;
  switch (worker.state) {
    case "working":
    case "running":
      return { state: "WORKING", line: `KAI is working through ${who}`, worker, cause: "agent.status_changed:working" };
    case "thinking":
    case "starting":
    case "connecting":
      return { state: "THINKING", line: `KAI is thinking through ${who}`, worker, cause: "agent.status_changed:thinking" };
    case "waiting":
      return { state: "WAITING", line: `KAI is waiting on ${who}`, worker, cause: "agent.status_changed:waiting" };
    case "error":
      return { state: "ERROR", line: `KAI's ${who} hit an error`, worker, cause: "agent.error" };
    default:
      // idle / offline: a resting worker says nothing about what KAI is doing.
      return { state: null, line: `KAI is idle — ${who} is resting`, worker, cause: "agent.status_changed:idle" };
  }
}

/**
 * Present one event as a KAI-subject activity, or `null` when KAI has nothing
 * honest to say (an event type this build does not narrate).
 *
 * The mapping to a STATE comes from the one canonical table
 * (`stateForEvent`); only the SENTENCE is decided here.
 */
export function presentActivity(event: RuntimeEventInput): PresentedActivity | null {
  const worker = workerOf(event);

  // Agent lifecycle: the canonical table maps working/thinking/waiting/error,
  // and returns null for idle. Those are exactly the cases where KAI still has
  // something to say (its workforce changed), so they are handled here.
  if (
    event.type === "agent.status_changed" ||
    event.type === "agent.connected" ||
    event.type === "agent.disconnected"
  ) {
    const p = asRecord(event.payload);
    const reported = str(p["state"]) ?? (event.type === "agent.connected" ? "idle" : "offline");
    const effectiveWorker: PresentedWorker = worker ?? { id: "a worker" };
    effectiveWorker.state = reported;
    return workerStatusLine(effectiveWorker);
  }

  // Subagent runs: KAI remains the subject; the persona is named, demoted.
  // The payload names `subagentId` (its spec id), which `workerOf` does not
  // read — a persona is not a worker.
  if (
    event.type === "agent.spawned" ||
    event.type === "agent.run_started" ||
    event.type === "agent.run_completed" ||
    event.type === "agent.run_failed" ||
    event.type === "agent.run_cancelled"
  ) {
    const p = asRecord(event.payload);
    const who = str(p["subagentId"]) ?? str(p["name"]) ?? "an agent";
    switch (event.type) {
      case "agent.spawned":
        return { state: "WORKING", line: `KAI spawned agent ${who}`, worker: null, cause: event.type };
      case "agent.run_started":
        return { state: "DELEGATING", line: `KAI started a run for ${who}`, worker: null, cause: event.type };
      case "agent.run_completed":
        return { state: "SUCCESS", line: `KAI finished a run for ${who}`, worker: null, cause: event.type };
      case "agent.run_failed":
        return { state: "ERROR", line: `KAI's run for ${who} failed`, worker: null, cause: event.type };
      default:
        return { state: null, line: `KAI cancelled a run for ${who}`, worker: null, cause: event.type };
    }
  }

  const mapped = stateForEvent(event);
  if (mapped === null) return null;

  return {
    state: mapped.state,
    line: RUNTIME_LABELS[mapped.state],
    worker,
    cause: mapped.cause,
  };
}

/**
 * A worker ROSTER row (the workforce list). This is the one place a worker is
 * the subject — because the row IS the worker, not a narration of KAI's
 * activity. Views must use `presentActivity` for KAI's activity line and this
 * only for the roster.
 */
export function presentWorkerRow(worker: { id: string; state: string; detail?: string }): {
  name: string;
  state: string;
  label: string;
} {
  const label =
    worker.state === "working" || worker.state === "running"
      ? "working"
      : worker.state === "error"
        ? "errored"
        : worker.state === "offline"
          ? "offline"
          : "idle";
  return { name: worker.id, state: worker.state, label };
}

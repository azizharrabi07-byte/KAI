/**
 * SHARED STATE — the one Core mirror the island and the main workspace both read.
 *
 * The island is NOT a second KAI: it owns no session, no memory, no worker state,
 * no tools, no agent state, no policy, no approvals, no scheduler and no
 * conversation. It renders the SAME Core the main workspace renders. This module
 * is that single fact expressed as code — one mirror (`State.core`, the app
 * store's `CoreSlice`), one reducer (`core-state.ts`), two named entry points:
 *
 *   - `applyFromIsland(event)`    — an event that arrived on the island's stream;
 *   - `applyFromWorkspace(event)` — an event that arrived on the workspace's stream.
 *
 * Both funnel into the ONE reducer, so a mission started from the main UI is
 * visible to the island, and an approval answered from the island is visible to
 * the main UI — there is no second copy that could drift. `stop`/`start` of either
 * surface never destroys the mirror; the Core survives both (see
 * `app/src-tauri/src/core_process.rs`: the Core is a job-object child with a
 * respawning supervisor, tied to KAI's process, not to a window).
 */

import { State } from "../core/state";
import type { CoreSlice, CoreEventInput, CoreSnapshotInput } from "../core/core-state";

/** A read-only view of the shared mirror. Both surfaces hand each other this. */
export interface CoreMirrorReader {
  read(): CoreSlice;
  subscribe(fn: () => void): () => void;
}

/** The identity of the shared Core state — what "the same KAI" means concretely. */
export interface CoreIdentity {
  conn: CoreSlice["conn"];
  activeSessionId: string | null;
  sessionIds: string[];
  missionIds: string[];
  /** PENDING approval ids, sorted. */
  pendingApprovalIds: string[];
  workerIds: string[];
  subagentIds: string[];
}

/**
 * The shared mirror. A thin, honest statement over `State.core` — it does not
 * copy the slice, so there is provably nothing to diverge.
 */
export const sharedCore: CoreMirrorReader & {
  /** Apply an event from the island's stream. */
  applyFromIsland(event: CoreEventInput): CoreSlice;
  /** Apply an event from the workspace's stream. */
  applyFromWorkspace(event: CoreEventInput): CoreSlice;
  /** Apply a full snapshot (either surface's reconciliation path). */
  applySnapshot(input: CoreSnapshotInput): CoreSlice;
  /** Set the connection (owned by whichever stream observed it). */
  setConnection(conn: CoreSlice["conn"], error?: string | null): CoreSlice;
} = {
  read: () => State.core,
  subscribe: (fn) => State.subscribe(fn),
  applyFromIsland: (event) => {
    State.applyCoreEvent(event);
    return State.core;
  },
  applyFromWorkspace: (event) => {
    State.applyCoreEvent(event);
    return State.core;
  },
  applySnapshot: (input) => {
    State.applyCoreSnapshot(input);
    return State.core;
  },
  setConnection: (conn, error) => {
    State.setCoreConnection(conn, error ?? null);
    return State.core;
  },
};

/** The identity both surfaces must agree on. Derived, never stored. */
export function coreIdentity(slice: CoreSlice): CoreIdentity {
  return {
    conn: slice.conn,
    activeSessionId: slice.activeSessionId,
    sessionIds: slice.sessions.map((s) => s.id).sort(),
    missionIds: slice.missions.map((m) => m.id).sort(),
    pendingApprovalIds: slice.approvals.filter((a) => a.status === "PENDING").map((a) => a.id).sort(),
    workerIds: slice.agents.map((a) => a.id).sort(),
    subagentIds: slice.subagents.map((s) => s.id).sort(),
  };
}

/** True when two readers are looking at the same KAI. */
export function sameCoreState(a: CoreSlice, b: CoreSlice): boolean {
  return JSON.stringify(coreIdentity(a)) === JSON.stringify(coreIdentity(b));
}

/**
 * The workspace composition: one client, one event stream, one state slice.
 *
 * `createWorkspace` owns the typed routes (`routes.ts`), the real Core event
 * stream (`core/core-events.ts` → `GET /core/events`, server-sent events), and
 * the workspace slice (`store.ts`). Panels subscribe to the slice; nothing else
 * touches the network.
 *
 * WHY ITS OWN STREAM: the island's `core-boot.ts` owns the island's stream and
 * the island's state slice. The workspace is a separate surface with its own
 * slice, so it opens its OWN SSE subscription — the Core serves every subscriber
 * independently, and the workspace is then decoupled from the island's
 * lifecycle (either can start, stop or reconnect without disturbing the other).
 *
 * Reconciliation exists alongside the stream for the same reason it does in
 * `core-boot.ts`: a stream cannot tell you what you missed while disconnected.
 * On every (re)connect — and on a slow timer — the workspace re-reads a
 * snapshot so it converges instead of drifting. The timer is deliberately slow;
 * it is a safety net, not the mechanism.
 */

import { createCoreEventStream, DEFAULT_BASE_URL, type CoreEvent, type CoreEventStream, type CoreEventStreamOptions } from "../core/core-events";
import { createCoreClient, DEFAULT_CORE_BASE_URL, type CoreClient } from "../core/kai-core";
import { createWorkspaceRoutes, type WorkspaceRoutes, type WorkspaceRoutesOptions } from "./routes";
import {
  applySnapshot,
  applyWorkspaceEvent,
  initialWorkspaceSlice,
  setConnection,
  type WorkspaceSlice,
} from "./store";
import type { CoreConnState } from "../core/core-state";
import type { RuntimeEventInput } from "../core/runtime-state";

/** A slow safety net, not the mechanism. Events do the real work. */
const DEFAULT_REFRESH_MS = 30_000;

export interface WorkspaceOptions {
  baseUrl?: string;
  /** Injected for tests; otherwise built over `baseUrl`. */
  routes?: WorkspaceRoutes;
  /** The island's client, reused for shared routes (approvals, sessions). */
  client?: CoreClient;
  /** Injected for tests: the stream's transport/timers/backoff. The event and
   *  state handlers are always owned here, so a test drives the REAL wiring. */
  streamOptions?: Omit<CoreEventStreamOptions, "baseUrl" | "onEvent" | "onState">;
  /** Reconciliation interval in ms; 0 disables it. */
  refreshMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  routesOptions?: Omit<WorkspaceRoutesOptions, "baseUrl">;
}

export interface Workspace {
  readonly routes: WorkspaceRoutes;
  /** The shared Core client — approvals and sessions come from here, so the
   *  workspace and the island read the SAME approvals list. */
  readonly client: CoreClient;
  readonly stream: CoreEventStream;
  getState(): WorkspaceSlice;
  subscribe(fn: (slice: WorkspaceSlice) => void): () => void;
  /** Apply one Core event (the stream calls this; tests call it directly). */
  applyEvent(event: RuntimeEventInput): void;
  /** Ask the Core for a full snapshot and fold it into the slice. */
  refresh(): Promise<void>;
  /** Start streaming and take a first snapshot. Returns immediately. */
  start(): void;
  /** Stop streaming and stop reconciling. */
  stop(): void;
}

export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  const baseUrl = (options.baseUrl ?? DEFAULT_CORE_BASE_URL).replace(/\/+$/, "");
  const routes = options.routes ?? createWorkspaceRoutes({ baseUrl, ...(options.routesOptions ?? {}) });
  const client = options.client ?? createCoreClient({ baseUrl });
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;

  let slice = initialWorkspaceSlice();
  let stopped = false;
  let reconcileHandle: unknown = null;
  const listeners = new Set<(slice: WorkspaceSlice) => void>();

  function emit(): void {
    for (const fn of listeners) {
      try {
        fn(slice);
      } catch {
        // A panel throwing must not break the stream or the other panels.
      }
    }
  }

  function commit(next: WorkspaceSlice): void {
    slice = next;
    emit();
  }

  async function refresh(): Promise<void> {
    // Each route is fetched separately: one failing call must not blank the
    // others, and it must not be replaced with an empty list that would look
    // like "nothing registered".
    const [tools, mcp, maintenance, actions] = await Promise.all([
      routes.tools(),
      routes.mcp(),
      routes.maintenance(),
      routes.actions(50),
    ]);

    const input: Parameters<typeof applySnapshot>[1] = {};
    if (tools.ok) input.tools = tools.value;
    if (mcp.ok) input.mcp = mcp.value;
    if (maintenance.ok) input.maintenance = maintenance.value;
    if (actions.ok) input.actions = actions.value;

    // Only a fully-failed refresh is treated as "Core is not answering"; a
    // partial success still proves the Core is up, and the failed routes keep
    // their previous values.
    const anyOk = tools.ok || mcp.ok || maintenance.ok || actions.ok;
    if (!anyOk) {
      const firstFailure = !tools.ok ? tools.error : !mcp.ok ? mcp.error : !maintenance.ok ? maintenance.error : actions.error;
      commit(setConnection(slice, slice.conn === "ONLINE" ? "DEGRADED" : "OFFLINE", firstFailure.message));
      return;
    }
    commit(applySnapshot(slice, input));
  }

  const stream = createCoreEventStream({
    baseUrl,
    ...(options.streamOptions ?? {}),
    onEvent: (event: CoreEvent) => applyEvent(event),
    onState: (conn: CoreConnState) => {
      commit(setConnection(slice, conn));
      if (conn === "ONLINE") void refresh();
    },
  });

  function applyEvent(event: CoreEvent): void {
    commit(applyWorkspaceEvent(slice, event));
    // A terminal Core event (e.g. core.stopped) should be reflected in the
    // other slices too, so re-read once the stream says something changed.
    if (event.type === "core.started") void refresh();
  }

  function scheduleReconcile(): void {
    if (stopped || refreshMs <= 0 || reconcileHandle !== null) return;
    reconcileHandle = setTimer(() => {
      reconcileHandle = null;
      void refresh().finally(() => scheduleReconcile());
    }, refreshMs);
  }

  return {
    routes,
    client,
    stream,
    getState: () => slice,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    applyEvent,
    refresh,
    start() {
      stopped = false;
      stream.connect();
      void refresh();
      scheduleReconcile();
    },
    stop() {
      stopped = true;
      if (reconcileHandle !== null) {
        clearTimer(reconcileHandle);
        reconcileHandle = null;
      }
      stream.disconnect();
      listeners.clear();
    },
  };
}

/** Boots a workspace in the running app. Returns it so it can be stopped. */
export function startWorkspace(options: WorkspaceOptions = {}): Workspace {
  const workspace = createWorkspace(options);
  workspace.start();
  return workspace;
}

/** Re-exported so a caller need not import two modules for the base URL. */
export { DEFAULT_BASE_URL as WORKSPACE_EVENTS_BASE_URL };

/**
 * The workspace's ONE state slice.
 *
 * One slice, one reducer, no panel subscribing to the network: the Core's route
 * snapshots (`/tools`, `/mcp`, `/maintenance/status`, `/actions`) and its event
 * stream both funnel through here, and the workspace panels read the result.
 * Keeping the reducer pure and separate from the transport is what makes "a
 * Core event updates the workspace" testable with no Core, no socket and no DOM.
 *
 * Two rules this file exists to enforce:
 *  - **Bounded memory.** The event list is a ring: a long-running Core must not
 *    grow the workspace's memory one frame at a time.
 *  - **No duplicates.** A dedupe-by-id means the user never sees the same event
 *    twice because a socket blinked.
 *
 * Every event row carries BOTH the neutral Core summary (`text`, for a raw log)
 * and the KAI-subject sentence (`line`, from `presenter.ts`) plus the demoted
 * worker — so no panel has to re-derive the framing, and KAI stays the speaker
 * everywhere the workspace narrates activity.
 */

import { CORE_EVENT_LIMIT, summarizeEvent, type CoreConnState } from "../core/core-state";
import type {
  ActionRecord,
  MaintenanceReport,
  McpSummary,
  ToolDescription,
} from "./types";
import { presentActivity, type PresentedWorker } from "./presenter";
import type { RuntimeEventInput } from "../core/runtime-state";

/** One event as the workspace shows it. */
export interface WorkspaceEventRow {
  /** Event id when Core supplied one — used for dedupe. */
  id?: string;
  type: string;
  at: string;
  /** The neutral Core summary. */
  text: string;
  /** KAI's own sentence, from `presentActivity`. Falls back to `text`. */
  line: string;
  /** The worker behind it, demoted. */
  worker: PresentedWorker | null;
  /** The raw payload, retained verbatim (Core owns its shape). */
  payload?: unknown;
}

export interface WorkspaceSlice {
  conn: CoreConnState;
  /** Why we are not ONLINE, in words fit to show a person. */
  lastError: string | null;
  lastSyncAt: number | null;
  /** Every registered tool, described (`GET /tools`). */
  tools: ToolDescription[];
  /** The measured MCP capability + catalogue (`GET /mcp`). */
  mcp: McpSummary | null;
  /** KAI's own health (`GET /maintenance/status`). */
  maintenance: MaintenanceReport | null;
  /** The persisted `action.executed` records (`GET /actions`). */
  actions: ActionRecord[];
  /** Newest first, bounded. */
  events: WorkspaceEventRow[];
}

export function initialWorkspaceSlice(): WorkspaceSlice {
  return {
    conn: "CONNECTING",
    lastError: null,
    lastSyncAt: null,
    tools: [],
    mcp: null,
    maintenance: null,
    actions: [],
    events: [],
  };
}

export function setConnection(
  slice: WorkspaceSlice,
  conn: CoreConnState,
  error?: string | null,
): WorkspaceSlice {
  return {
    ...slice,
    conn,
    lastError: conn === "ONLINE" ? null : (error ?? slice.lastError),
  };
}

export interface WorkspaceSnapshotInput {
  tools?: ToolDescription[];
  mcp?: McpSummary | null;
  maintenance?: MaintenanceReport | null;
  actions?: ActionRecord[];
  now?: number;
}

/** Fold a route snapshot in. A present-but-empty list is meaningful; use it. */
export function applySnapshot(slice: WorkspaceSlice, input: WorkspaceSnapshotInput): WorkspaceSlice {
  return {
    ...slice,
    tools: input.tools ?? slice.tools,
    mcp: input.mcp === undefined ? slice.mcp : input.mcp,
    maintenance: input.maintenance === undefined ? slice.maintenance : input.maintenance,
    actions: input.actions ?? slice.actions,
    lastSyncAt: input.now ?? Date.now(),
    conn: "ONLINE",
    lastError: null,
  };
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
 * The event → slice mapping. Every branch is defensive: the payload came from
 * another process and may be missing fields or be of the wrong type entirely.
 *
 * The KAI-subject line comes from `presentActivity`; a neutral fallback is the
 * Core summary from the island's own `summarizeEvent`, so an event the
 * presenter does not narrate still appears rather than vanishing.
 */
export function applyWorkspaceEvent(slice: WorkspaceSlice, event: RuntimeEventInput): WorkspaceSlice {
  const at = event.timestamp ?? new Date().toISOString();
  const presented = presentActivity(event);
  const text = summarizeEvent(event.type, event.payload);

  const row: WorkspaceEventRow = {
    type: event.type,
    at,
    text,
    line: presented?.line ?? text,
    worker: presented?.worker ?? null,
  };
  if (event.id !== undefined) row.id = event.id;
  if (event.payload !== undefined) row.payload = event.payload;

  const alreadyHave = event.id !== undefined && slice.events.some((e) => e.id === event.id);
  if (alreadyHave) return slice;

  let next: WorkspaceSlice = { ...slice, events: [row, ...slice.events].slice(0, CORE_EVENT_LIMIT) };

  // A few events are also worth reflecting in the tool/MCP slices so the panels
  // converge from the stream, not only from a slow refresh.
  switch (event.type) {
    case "core.stopped":
      next = { ...next, conn: "OFFLINE", lastError: "KAI Core stopped" };
      break;
    case "core.started":
      next = { ...next, lastSyncAt: Date.now() };
      break;
    case "tool.invoked":
    case "tool.completed":
    case "tool.failed": {
      // Tool activity is stated through missions today (the Core publishes no
      // tool.* events), so this branch is forward-compatible only and invents
      // nothing: it records the event row above and changes no tool slice.
      break;
    }
    default:
      break;
  }

  return next;
}

/** Counts the workspace shows, derived from the mirror (never invented). */
export function workspaceCounts(slice: WorkspaceSlice): {
  registeredTools: number;
  sideEffectingTools: number;
  mcpServers: number;
  mcpConnected: number;
  maintenanceFailing: number;
} {
  return {
    registeredTools: slice.tools.length,
    sideEffectingTools: slice.tools.filter((t) => t.permission.sideEffecting).length,
    mcpServers: slice.mcp?.counts.servers ?? 0,
    mcpConnected: slice.mcp?.counts.connected ?? 0,
    maintenanceFailing: slice.maintenance?.checks.filter((c) => c.status === "fail").length ?? 0,
  };
}

/** The dispatch lines a tool's permission implies, for a panel's hint text. */
export function toolDispatchHint(tool: ToolDescription): string {
  const risk = tool.permission.risk;
  if (risk === "READ" && !tool.permission.effectful) {
    return "runs directly (read-only)";
  }
  return `parks for approval (${risk}) — a human decides, then the same call retries`;
}

/** A one-line summary of an action record for the actions panel. */
export function actionLine(action: ActionRecord): string {
  const p = asRecord(action);
  const actionName = str(p["action"]) ?? str(p["type"]) ?? "action";
  const tool = str(p["toolId"]) ?? str(p["capabilityId"]);
  const employee = str(p["employeeId"]);
  const status = str(p["status"]);
  const parts: string[] = [];
  if (tool !== undefined) parts.push(tool);
  if (employee !== undefined) parts.push(`via ${employee}`);
  if (status !== undefined) parts.push(status.toLowerCase());
  return parts.length > 0 ? `${actionName} — ${parts.join(" · ")}` : actionName;
}

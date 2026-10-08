/**
 * The KAI workspace's wire vocabulary.
 *
 * These are the shapes the REAL Core routes return (verified against
 * `core/src/**` and the live artifact), narrowed to the fields the workspace
 * renders. Every optional field is omitted rather than invented when Core does
 * not send it: the Core is a separate process and its payload can be
 * older/newer than this client.
 *
 * Nothing here is a second source of truth. A field exists only because a route
 * in `routes.ts` reads it, and every route in `routes.ts` is a route the Core
 * actually serves (see `docs/api.md` and the route modules under `core/src/`).
 */

import type { CoreResult } from "../core/kai-core";

/** ── GET /tools ──────────────────────────────────────────────────────────── */

/** The declaration a tool makes about its risk, straight from `describeTool`. */
export interface ToolPermission {
  /** "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE". */
  risk: string;
  effectful: boolean;
  /** Derived by Core: risk !== READ || effectful. */
  sideEffecting: boolean;
}

/** A tool's declared schema, or an honest "it declares none, with the reason". */
export type ToolSchemaView =
  | { declared: true; schema: unknown }
  | { declared: false; reason: string };

export interface ToolDescription {
  id: string;
  name: string;
  description: string;
  permission: ToolPermission;
  schema: ToolSchemaView;
}

/** ── POST /tools/:id/invoke ──────────────────────────────────────────────── */

/**
 * The outcome of invoking one tool. A 409 is the NORMAL parked outcome (the
 * tool is EXTERNAL/DESTRUCTIVE): it carries `approvalRequired` and the id to
 * retry with. A 400/403/500 is a typed refusal with a reason.
 */
export interface ToolInvokeOutcome {
  toolId: string;
  /** "EXECUTED" | "FAILED" | … as the invocation reports it. */
  status: string;
  invocationId?: string;
  executionId?: string;
  result?: unknown;
  /** True when the tool parked for a human decision (HTTP 409). */
  approvalRequired: boolean;
  /** The id to retry the SAME request with, when parked. */
  approvalId?: string;
  /** Core's refusal reason, when the call did not run. */
  reason?: string;
}

/** ── GET /mcp ────────────────────────────────────────────────────────────── */

/** A server as `GET /mcp/servers` lists it: secret VALUES are never present. */
export interface McpServerSummary {
  name: string;
  transport: string;
  /** stdio only: the launched command. */
  command?: string;
  /** stdio only: the argument vector. */
  args?: string[];
  /** stdio only: env variable NAMES the server is given. Never the values. */
  envKeys?: string[];
  /** remote only: the endpoint URL. */
  url?: string;
  /** remote only: header NAMES. Never the values. */
  headerKeys?: string[];
  /** KAI knows the entry. */
  enabled: boolean;
  /** Declares a KAI-owned risk. A tool with no derivable risk is refused. */
  hasRisk: boolean;
  /** Live connection state. */
  connected: boolean;
  /** How many of this server's tools are registered in KAI's ONE registry. */
  toolCount: number;
  resourceCount: number | null;
  serverInfo?: { name?: string; version?: string; protocolVersion?: string };
}

/** The measured `mcp` capability, from `mcpCapabilityHealth`. */
export interface McpCapabilityHealth {
  /** "AVAILABLE" | "DEGRADED" | "UNAVAILABLE". */
  availability: string;
  detail: string;
}

export interface McpSummary {
  capability: McpCapabilityHealth;
  counts: {
    servers: number;
    enabled: number;
    connected: number;
    tools: number;
    resources: number;
  };
  servers: McpServerSummary[];
  /** The 8 management tools registered into KAI's registry, and any refused. */
  management: { registered: string[]; refused: { name: string; reason: string }[] };
  persistence: { path: string | null; problem: string | null };
  /** How many invocations the provenance ledger holds. */
  provenanceCount: number;
}

/** One tool a server exposed, from `GET /mcp/servers/:name/tools`. */
export interface McpServerTool {
  id: string;
  name: string;
  risk: string;
  description: string;
}

/** One row of `GET /mcp/provenance` — the invocation ledger. */
export interface McpProvenanceRecord {
  executionId: string;
  toolId: string;
  server: string;
  tool: string;
  source: string;
  status: string;
  startedAt: string;
  durationMs: number;
  error?: { code: string; message: string };
}

/** ── GET /maintenance/status ─────────────────────────────────────────────── */

export interface MaintenanceCheck {
  name: string;
  /** "pass" | "warn" | "fail". */
  status: string;
  detail: string;
}

export interface MaintenanceRepair {
  name: string;
  performed: boolean;
  detail: string;
}

export interface MaintenanceIdentity {
  buildId: string;
  gitCommit: string;
  protocolVersion: number;
  pid: number;
  onDiskBuildId?: string;
  /** The anti-stale check: the running process IS the build stamped on disk. */
  current: boolean;
  detail: string;
}

export interface MaintenanceReport {
  ok: boolean;
  checkedAt: string;
  identity: MaintenanceIdentity;
  checks: MaintenanceCheck[];
  repairs: MaintenanceRepair[];
}

/** ── POST /prompts/compose ───────────────────────────────────────────────── */

export interface PromptSectionReport {
  name: string;
  /** "stable" | "volatile". */
  band: string;
  /** "instruction" | "data". */
  trust: string;
  chars: number;
  bodyChars: number;
  budget: number;
  truncated: boolean;
}

export interface ComposedPromptView {
  text: string;
  sections: PromptSectionReport[];
  totalChars: number;
  problems: string[];
  order: string[];
}

/** ── GET /actions ────────────────────────────────────────────────────────── */

/**
 * One `action.executed` record. The payload is deliberately loose: it crossed a
 * process boundary and Core owns its full shape. The fields the workspace shows
 * are read defensively and everything else rides along untouched.
 */
export interface ActionRecord {
  id?: string;
  type?: string;
  action?: string;
  toolId?: string;
  capabilityId?: string;
  employeeId?: string;
  status?: string;
  at?: string;
  timestamp?: string;
  /** The artifact the action produced (memoryId, skillId, …). */
  result?: unknown;
  [key: string]: unknown;
}

/** A `CoreResult` alias, so callers read like the base client's. */
export type WorkspaceResult<T> = CoreResult<T>;

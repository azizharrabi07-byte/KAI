// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI tool plane — the nouns, declared once (Stream C).
 *
 * The registry (./registry.ts) is the boundary; this file is its vocabulary.
 * Eight nouns describe one tool call, and each answers exactly one question:
 *
 *   ToolRegistry    where a tool is registered, and the ONLY way to run one
 *   ToolSchema      what input a tool accepts — machine-readable, when declared
 *   ToolInvocation  what happened on ONE attempt: ids, status, timing, decision
 *   ToolResult      what the caller gets back: the value, or an error VALUE
 *   ToolError       why it refused or failed (the frozen KaiError, never a throw)
 *   ToolProvenance  what it produced, where the call came from, and whether a
 *                   dedupe means it produced nothing
 *   ToolPermission  the declared risk, the effect flag, and the ONE derived
 *                   side-effect answer
 *   ToolApproval    whether a human was asked, which approval, and its state
 *
 * Everything here is additive over the FROZEN shared contracts: `RiskLevel`,
 * `KaiError`, `KaiErrorCode` and `ApprovalStatus` are imported from
 * `shared/contracts.ts`, and `ActionResultState`/`ExecutorType` from
 * `observability/action-record.ts` — never re-invented, so the tool plane cannot
 * drift from the record vocabulary the bus already speaks.
 *
 * The one rule that must not move (falsified once already, see
 * `tests/side-effect-derivation.test.ts`): a side effect is derived from the
 * tool's EFFECT, not from its declared risk —
 *
 *     sideEffecting = risk !== "READ" || effectful === true
 *
 * `permissionOf()` / `sideEffectingOf()` below are that rule's canonical home.
 */

import type { ApprovalStatus, KaiError, KaiErrorCode, RiskLevel } from "../shared/contracts.ts";
import type { ActionResultState, ExecutorType } from "../observability/action-record.ts";

// ── ToolSchema ────────────────────────────────────────────────────────────────
//
// A declarative description of a tool's input, for a planner/UI that must show
// what a tool accepts WITHOUT running it. It is deliberately small — the shape
// the registry validators actually enforce — and it never REPLACES `validate()`:
// the validator remains the authority at the boundary; a declared schema that
// drifted would be caught by the tools-plane test that cross-checks the real
// validators against these declarations.

export type ToolFieldType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface ToolFieldSchema {
  type: ToolFieldType;
  description?: string;
  /** True when the tool refuses an input that omits this field. */
  required?: boolean;
  /** The closed set of accepted values, when the field has one. */
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
}

export interface ToolSchema {
  kind: "object";
  properties: Readonly<Record<string, ToolFieldSchema>>;
  /** False when an undeclared option is refused (what the real validators do). */
  additionalProperties: boolean;
}

/**
 * What the plane can HONESTLY say about a tool's schema. A tool that validates
 * procedurally and declares no schema reports `declared: false` with the reason —
 * never an invented shape.
 */
export type ToolSchemaView =
  | { declared: true; schema: ToolSchema }
  | { declared: false; reason: string };

// ── ToolPermission ────────────────────────────────────────────────────────────

export interface ToolPermission {
  /** The risk the tool DECLARES; the policy gate is what acts on it. */
  risk: RiskLevel;
  /** The second, separate fact: the tool creates work despite a READ risk. */
  effectful: boolean;
  /** Derived from EFFECT, not from risk alone. See the module header. */
  sideEffecting: boolean;
}

/**
 * The ONE side-effect derivation. Every consumer (mission creation, the
 * acceptance boundary, a UI badge) must ask this rather than re-deriving it
 * from `risk` alone — that shortcut is the falsified-2 defect
 * (`missions.create` ran with no recovery record).
 */
export function sideEffectingOf(tool: { risk: RiskLevel; effectful?: boolean }): boolean {
  return tool.risk !== "READ" || tool.effectful === true;
}

export function permissionOf(tool: { risk: RiskLevel; effectful?: boolean }): ToolPermission {
  return {
    risk: tool.risk,
    effectful: tool.effectful === true,
    sideEffecting: sideEffectingOf(tool),
  };
}

// ── ToolError ─────────────────────────────────────────────────────────────────

/**
 * A tool failure is a VALUE, in the frozen `KaiError` shape — the same shape
 * every other Core boundary returns. Aliased rather than re-shaped: a second
 * error vocabulary is how two modules end up disagreeing about `code`.
 */
export type ToolError = KaiError;

/** Build a tool error. `retryable` is false by default: the registry never retries for you. */
export function toolError(
  code: KaiErrorCode,
  message: string,
  at: () => Date,
  detail?: string,
): ToolError {
  const error: ToolError = { code, message, retryable: false, at: at().toISOString() };
  if (detail !== undefined) error.detail = detail;
  return error;
}

// ── ToolApproval ──────────────────────────────────────────────────────────────

export interface ToolApproval {
  /** True when policy demanded a human for this attempt. */
  required: boolean;
  /** The approval that was created (park) or presented (re-issue). */
  approvalId?: string;
  /** The presented approval's state at decision time, when it had one. */
  status?: ApprovalStatus;
}

// ── ToolProvenance ────────────────────────────────────────────────────────────

/**
 * The artifact ids one action NAMES on its record. The SAME correlation ids the
 * frozen action record carries (`action-record.ts`), kept as one shape so the
 * tool plane and the bus cannot disagree about which field names which artifact.
 */
export interface ToolArtifactIds {
  memoryId?: string;
  skillId?: string;
  learningEventId?: string;
  checkpointId?: string;
  scheduleId?: string;
  /** The mission this action created or acted on. */
  missionId?: string;
  /** The approval this action decided (NOT the one that authorised it). */
  approvalId?: string;
}

/**
 * What this action produced, and where the call came from.
 *
 * THE DEDUPE RULE (pinned defect, `tests/adversarial-observability.test.ts`): an
 * action names an artifact ONLY when it produced one. A deduped `memory.write`
 * returns an EXISTING entry id; naming it would make two actions claim the same
 * memory and a trace would resolve to the wrong action. So a dedupe signal
 * suppresses naming — generically, for every tool (see ./provenance.ts).
 */
export interface ToolProvenance {
  /** Who caused the call: "core" (default), "scheduler", "route", a test label. */
  source: string;
  /** KAI acted directly, or through an employee. Derived, never claimed. */
  executorType: ExecutorType;
  employeeId?: string;
  capabilityId?: string;
  /** True when the operation found an EXISTING artifact instead of producing one. */
  deduped: boolean;
  /** The ids this action names. Empty for a deduped action, and for a refusal. */
  artifacts: ToolArtifactIds;
}

// ── ToolInvocation / ToolResult ───────────────────────────────────────────────

/** The status vocabulary of one attempt — the record vocabulary, not a second one. */
export type ToolCallStatus = ActionResultState;

/**
 * The full record of ONE tool call attempt, built by the registry for EVERY
 * call — executed, denied, parked, failed or refused — so a refusal is as
 * traceable as a success. It carries the complete correlation set the mission
 * requires: toolId · executionId · sessionId · agentId · source · arguments ·
 * result · status · duration, plus approvalId where applicable.
 *
 * `executionId` / `sessionId` / `agentId` are present when they EXIST — a call
 * outside any mission has no acceptance-ledger execution, and inventing one
 * would be the exact mislink class this plane refuses. Absence is honest here.
 */
export interface ToolInvocation {
  /**
   * Unique per attempt. It IS the `actionId` the bus record carries: one
   * attempt, one identity, so a caller can join the invocation it received to
   * the record the bus persisted without guessing.
   */
  invocationId: string;
  toolId: string;
  /** The acceptance-ledger execution this call belongs to, when one applies. */
  executionId?: string;
  /** The conversation session this call belonged to, when the caller knew it. */
  sessionId?: string;
  /** The agent that CAUSED this call, when one did. */
  agentId?: string;
  /** Who caused it. Defaults to "core". */
  source: string;
  /**
   * The validated arguments handed to `execute()`; the raw input as received
   * when validation did not pass. Never re-derived: it is what was acted on.
   */
  arguments: unknown;
  status: ToolCallStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  approvalId?: string;
  approval?: ToolApproval;
  /** The policy outcome ("allow" | "deny" | "needs_approval" | "none"). */
  policyDecision: string;
  /** WHICH authority decided ("default", "rule:<id>", "mode:<mode>", "not-reached"). */
  decisionSource: string;
  /** Absent only when no tool with this id exists (nothing to describe). */
  permission?: ToolPermission;
  provenance: ToolProvenance;
  /** The tool's value, on success. */
  result?: unknown;
  /** Why it refused or failed, on every other status. */
  error?: ToolError;
}

/**
 * What `invoke()` returns. Both branches carry the `invocation`, so the caller
 * never has to re-ask the bus what happened. `result`/`error` keep the exact
 * shape every existing caller already switches on — the invocation is additive.
 */
export type ToolResult =
  | { ok: true; result: unknown; invocation: ToolInvocation }
  | { ok: false; error: ToolError; invocation: ToolInvocation };

// ── Descriptions (what GET /tools serves) ─────────────────────────────────────

export interface ToolDescription {
  id: string;
  name: string;
  description: string;
  permission: ToolPermission;
  schema: ToolSchemaView;
}

/**
 * Describe a tool for a planner, a UI, or the `/tools` routes: declared facts
 * only. A schema that was never declared is reported as undeclared WITH the
 * reason — the same honesty rule the rest of the Core applies to capabilities.
 */
export function describeTool(tool: {
  id: string;
  name: string;
  description: string;
  risk: RiskLevel;
  effectful?: boolean;
  schema?: ToolSchema;
}): ToolDescription {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    permission: permissionOf(tool),
    schema:
      tool.schema !== undefined
        ? { declared: true, schema: tool.schema }
        : {
            declared: false,
            reason:
              "this tool validates procedurally (validate()) and declares no machine-readable schema; its validator is the authority",
          },
  };
}

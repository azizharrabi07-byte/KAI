import { createHash } from "node:crypto";
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core tool registry — the mandatory boundary (spec §41).
 *
 * Nothing an LLM or an agent produces reaches this machine directly. Every
 * action goes:
 *
 *     request -> validate -> policy -> (approval) -> execute
 *
 * and this file is where that chain is enforced, in that order, once. A tool
 * is a plain data object with a `validate` and an `execute`; it never gets to
 * decide whether it is allowed to run. If this boundary is soft, nothing above
 * it can be trusted, so the ordering here is the point of the module rather
 * than an implementation detail.
 *
 * Failure modes are all values, never exceptions:
 *   - unknown id                -> NOT_FOUND
 *   - bad input                 -> VALIDATION_FAILED   (policy/execute untouched)
 *   - no gate attached          -> POLICY_DENIED
 *   - rule says deny            -> POLICY_DENIED       (execute untouched)
 *   - needs approval, none      -> APPROVAL_REQUIRED
 *   - execute throws            -> INTERNAL
 */

import {
  isNonEmptyString,
  isRecord,
  type Approval,
  type RiskLevel,
} from "../shared/contracts.ts";
import type { PolicyDecision, PolicyGate } from "../policies/gate.ts";
import {
  buildActionRecord,
  employeeOfToolInput,
  type ActionRecord,
  type ActionResultState,
} from "../observability/action-record.ts";
import type { ApprovalService, Publish } from "../approvals/service.ts";
import { redactText } from "../redact/index.ts";
import { executionIdFor } from "../recovery/ledger.ts";
import { deriveToolProvenance } from "./provenance.ts";
import {
  permissionOf,
  toolError,
  type ToolApproval,
  type ToolArtifactIds,
  type ToolCallStatus,
  type ToolError,
  type ToolInvocation,
  type ToolPermission,
  type ToolResult,
  type ToolSchema,
} from "./types.ts";

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  risk: RiskLevel;
  /**
   * Optional. True when the tool CREATES WORK / mutates durable state even
   * though its declared risk is READ.
   *
   * `risk` answers "what does this do to the world?"; a tool like
   * `missions.create` starts a mission — real, duplicate-able work — yet does
   * not itself touch the world, so READ is an honest risk for policy. It is NOT
   * an honest answer to "must the acceptance boundary record this step?", and
   * keying the side-effect derivation off risk alone let such a step run with no
   * recovery record at all (a crash then replayed it). This flag is that second
   * fact, stated once, where the tool is defined. The ONE derivation that reads
   * it lives in `./types.ts` (`sideEffectingOf`) — never re-derive from `risk`.
   */
  effectful?: boolean;
  /**
   * Optional declarative input contract (./types.ts). `validate()` remains the
   * authority at the boundary; this is what a planner or a UI can read without
   * running the tool. A tool that declares none reports `declared: false`
   * honestly (see `describeTool`).
   */
  schema?: ToolSchema;
  /** Runtime input validator. Returns the parsed value or an error — never trust the caller. */
  validate(input: unknown): { ok: true; value: unknown } | { ok: false; reason: string };
  execute(
    input: unknown,
    ctx: {
      missionId?: string;
      stepId?: string;
      /** The schedule whose fire caused this action, when one did. */
      scheduleId?: string;
      /** The worker turn this action belonged to, when the caller knew it. */
      turnId?: string;
      /** Cancellation for this attempt; long-running tools must honour it. */
      signal?: AbortSignal;
    },
  ): Promise<unknown>;
}

/**
 * The caller-supplied context of ONE invocation attempt (Stream C).
 *
 * Everything here is optional and additive: a caller that knows nothing about
 * correlation gets the behaviour it always did, and one that knows the mission
 * step gets the full set on BOTH the returned `ToolInvocation` and the published
 * action record. `executionId` is derived from `missionId` + `stepId` with the
 * acceptance ledger's ONE formula (`executionIdFor`, imported) unless the caller
 * overrides it explicitly — the formula is never re-invented here.
 */
export interface ToolInvokeOptions {
  missionId?: string;
  stepId?: string;
  /** The schedule whose fire caused this action; recorded so a chain can be resolved. */
  scheduleId?: string;
  /** The worker turn this action belonged to; recorded so a chain can be resolved. */
  turnId?: string;
  approvalId?: string;
  /** The conversation session this call belonged to, when the caller knew it. */
  sessionId?: string;
  /** The agent that CAUSED this call, when one did. */
  agentId?: string;
  /** Who caused it: "core" (default), "scheduler", "route", a test label. */
  source?: string;
  /**
   * The acceptance-ledger execution this call belongs to. An explicit id wins;
   * otherwise it is derived from (missionId, stepId) — the same formula the
   * recovery ledger and the boundary runner use, so the bus record and the
   * ledger row join on ONE id instead of two lookalikes.
   */
  executionId?: string;
  /**
   * Cancellation for this attempt. Checked before the tool body runs (an
   * already-aborted attempt settles CANCELLED without executing) and handed to
   * the body via the execute ctx so long-running tools can stop mid-flight.
   */
  signal?: AbortSignal;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(id: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  /** The only way to run anything: validate -> policy -> (approval) -> execute. */
  invoke(id: string, input: unknown, opts?: ToolInvokeOptions): Promise<ToolResult>;
  /**
   * Emit an action record for a durable state change this boundary did NOT run
   * through `invoke` — the staged-skill approve/install routes (byte-bound to an
   * approval, so deliberately not an `invoke()` call) and `POST /missions`,
   * which creates its mission directly and never consults policy.
   *
   * Still goes through the SAME emitter as `invoke`, so the record carries the
   * same `coreBuildId`, the same `actionId` sequencer and the same bus. A path
   * that mutates state without a trace is a silent path; this is the escape
   * hatch that keeps such a path observable without giving up one emitter.
   *
   * Recording must never change the outcome: a bus failure is swallowed (and
   * warned) here, because an audit log that can veto an action has become a
   * second policy gate.
   */
  record(args: ActionRecordInput): void;
}

/** The argument shape of `ToolRegistry.record` / the internal `recordAction`. */
export interface ActionRecordInput {
  toolId: string;
  input: unknown;
  resultState: ActionResultState;
  startedAt: string;
  decision?: PolicyDecision;
  approvalId?: string;
  invokeOpts?: ToolInvokeOptions;
  /** The artifacts a successful execution produced, so the record can name them. */
  artifacts?: ActionArtifactIds;
  detail?: string;
  /**
   * The attempt's identity — the SAME id the returned `ToolInvocation` carries,
   * so a caller can join the invocation it received to the record the bus
   * persisted without guessing. One is minted when absent: every record has one.
   */
  actionId?: string;
  /**
   * The acceptance-ledger execution this action belongs to. Derived from the
   * invoke options when absent, so the `record()` escape hatch writes the same
   * id the boundary would instead of a record that cannot join its ledger row.
   */
  executionId?: string;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The acceptance-ledger execution id for one attempt: the caller's explicit id
 * wins; otherwise it is derived from (missionId, stepId) with the ledger's ONE
 * formula. Absent when the caller named no mission step — a call outside a
 * mission has no acceptance-ledger execution, and inventing one would be the
 * exact mislink class this plane refuses. Absence is honest here.
 */
function resolveExecutionId(opts?: {
  missionId?: string;
  stepId?: string;
  executionId?: string;
}): string | undefined {
  const explicit = opts?.executionId;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const missionId = opts?.missionId;
  const stepId = opts?.stepId;
  if (
    missionId !== undefined &&
    missionId.length > 0 &&
    stepId !== undefined &&
    stepId.length > 0
  ) {
    return executionIdFor(missionId, stepId);
  }
  return undefined;
}

/**
 * The per-attempt bookkeeping every branch of `invoke` shares.
 *
 * One attempt, one identity: `invocationId` IS the actionId the bus record
 * carries, so the caller can join the invocation it received to the record the
 * bus persisted. `settle` (below, inside the registry) builds the invocation
 * and emits the ONE record for the attempt — executed, refused or failed — so
 * every outcome is as traceable as every other.
 */
interface AttemptMeta {
  invocationId: string;
  toolId: string;
  /**
   * What was acted on: the raw input as received until validation passes, the
   * validated value afterwards (the invocation's `arguments`, exactly).
   */
  input: unknown;
  startedAt: string;
  startedMs: number;
  source: string;
  invokeOpts?: ToolInvokeOptions;
  executionId?: string;
  sessionId?: string;
  agentId?: string;
  approvalId?: string;
  approval?: ToolApproval;
  permission?: ToolPermission;
}

/**
 * The outcome of one attempt, as `settle` consumes it. A discriminated pair so
 * the compiler enforces the one invariant that matters: an EXECUTED attempt
 * carries its result, every other status carries its error — never both, never
 * neither.
 */
type SettleOutcome =
  | {
      status: ToolCallStatus;
      decision?: PolicyDecision;
      /** The approval that was created (park) or presented (re-issue). */
      approvalId?: string;
      approval?: ToolApproval;
      detail?: string;
      executed: true;
      result: unknown;
    }
  | {
      status: ToolCallStatus;
      decision?: PolicyDecision;
      approvalId?: string;
      approval?: ToolApproval;
      detail?: string;
      executed?: false;
      error: ToolError;
    };

/** Shape check for a registration — a malformed tool must not enter the registry. */
function assertWellFormed(tool: ToolDefinition): void {
  if (!isRecord(tool)) throw new Error("tool definition must be an object");
  if (!isNonEmptyString(tool.id)) throw new Error("tool definition requires a non-empty id");
  if (!isNonEmptyString(tool.name)) throw new Error(`tool "${tool.id}" requires a non-empty name`);
  if (!isNonEmptyString(tool.description)) {
    throw new Error(`tool "${tool.id}" requires a non-empty description`);
  }
  if (typeof tool.validate !== "function") throw new Error(`tool "${tool.id}" requires validate()`);
  if (typeof tool.execute !== "function") throw new Error(`tool "${tool.id}" requires execute()`);
}

/**
 * The durable artifacts one action NAMES, by tool — the tool-plane's
 * `ToolArtifactIds` (./types.ts), ALIASED rather than re-declared so the
 * registry, the invocation and the bus cannot disagree about which field names
 * which artifact. The per-tool switch that fills it lives in ./provenance.ts.
 */
export type ActionArtifactIds = ToolArtifactIds;


/**
 * A stable hash of a tool input.
 *
 * Keys are sorted recursively, so two structurally identical inputs hash the
 * same regardless of property order — but any change to a VALUE changes the
 * hash. This is what binds an approval to the action the human was asked about
 * rather than to the tool in general.
 */
function stableHash(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(",")}}`;
  };
  // The approval id is an INVOCATION OPTION, not part of the action: a caller
  // that re-issues the approved call naturally carries the id in the same body,
  // and hashing it would make every legitimate retry look like a different
  // action. Everything else is bound.
  const action = value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => k !== "approvalId"))
    : value;
  return createHash("sha256").update(canonical(action), "utf8").digest("hex");
}

export function createToolRegistry(opts: {
  policy?: PolicyGate;
  approvals?: ApprovalService;
  publish?: Publish;
  /** Stamped on every action record, so a trace names the build that produced it. */
  coreBuildId?: string;
  /**
   * Called when this boundary CREATES an approval for a request it parked.
   *
   * The registry is the only place that both knows the exact validated input and
   * hands back the approval id, so it is the only place that can tell the runtime
   * what to re-issue once a human answers. The runtime records it (durably) and
   * replays it in `decideApproval`. A throwing hook must not break the park, so
   * callers' errors are swallowed here.
   */
  onApprovalRequest?: (info: {
    approvalId: string;
    toolId: string;
    input: unknown;
    missionId?: string;
    stepId?: string;
    scheduleId?: string;
    turnId?: string;
  }) => void;
  now?: () => Date;
}): ToolRegistry {
  const policy = opts.policy;
  const approvals = opts.approvals;
  // Accepted for symmetry with the other Core services. The registry publishes
  // exactly one event type: `action.executed`, from `recordAction` below —
  // one attempt, one record, whether it ran, was refused, or failed. Approval
  // lifecycle events are emitted by the approval service, not here.
  const publish = opts.publish;
  void publish;
  const now = opts.now ?? (() => new Date());

  const tools = new Map<string, ToolDefinition>();
  const coreBuildId = opts.coreBuildId ?? "unknown";
  let actionSeq = 0;

  /**
   * One attempt, one identity: this mints the `actionId` the bus record carries
   * AND the `invocationId` the caller receives. Same value on both, so the
   * invocation joins its record without a lookup table.
   */
  function nextActionId(): string {
    return `act_${now().getTime().toString(36)}_${(actionSeq++).toString(36)}`;
  }

  /**
   * Record one action attempt on the existing bus.
   *
   * Emitted HERE because this function is the only place an executable action
   * passes: a builtin tool, the worker tool, and any MCP-adapted tool all come
   * through `invoke`. A record written anywhere else would miss paths — and the
   * paths it missed would be exactly the ones nobody was watching.
   *
   * Recording must never change the outcome: a bus failure is swallowed, because an
   * audit log that can veto an action has become a second policy gate.
   */
  function recordAction(args: ActionRecordInput): void {
    if (publish === undefined) return;
    const employeeId = employeeOfToolInput(args.toolId, args.input);
    // A capability action is a tool whose id names its capability, so the record
    // can say WHICH capability without the caller having to remember to pass it —
    // and a caller cannot misreport it either.
    const capabilityId = args.toolId.startsWith("capability.")
      ? args.toolId.slice("capability.".length)
      : undefined;
    // The causal schedule (who fired this) wins over the artifact schedule (what
    // this created), so a scheduled `schedule.manage` still names the schedule
    // that invoked it rather than only the one it produced.
    const scheduleId = args.invokeOpts?.scheduleId ?? args.artifacts?.scheduleId;
    // Same rule for the mission (a caller-known causal mission wins over the one
    // named by the result) and for the approval (the authorizing approval — the
    // one that let this run — wins over a decided one named as the artifact).
    const missionId = args.invokeOpts?.missionId ?? args.artifacts?.missionId;
    const approvalId = args.approvalId ?? args.artifacts?.approvalId;
    // The acceptance-ledger execution this action belongs to: an explicit id
    // wins; otherwise derived from the CAUSAL mission step. Never from the
    // artifact mission — the mission an action CREATED is not its execution.
    const executionId = args.executionId ?? resolveExecutionId(args.invokeOpts);
    const base = buildActionRecord({
      coreBuildId,
      actionId: args.actionId ?? nextActionId(),
      toolId: args.toolId,
      policyDecision: args.decision?.outcome ?? "none",
      decisionSource: args.decision?.source ?? "not-reached",
      resultState: args.resultState,
      startedAt: args.startedAt,
      completedAt: now().toISOString(),
      ...(missionId !== undefined ? { missionId } : {}),
      ...(args.invokeOpts?.turnId !== undefined ? { turnId: args.invokeOpts.turnId } : {}),
      ...(scheduleId !== undefined ? { scheduleId } : {}),
      ...(employeeId !== undefined ? { employeeId } : {}),
      ...(capabilityId !== undefined ? { capabilityId } : {}),
      ...(approvalId !== undefined ? { approvalId } : {}),
      ...(args.artifacts?.memoryId !== undefined ? { memoryId: args.artifacts.memoryId } : {}),
      ...(args.artifacts?.skillId !== undefined ? { skillId: args.artifacts.skillId } : {}),
      ...(args.artifacts?.learningEventId !== undefined
        ? { learningEventId: args.artifacts.learningEventId }
        : {}),
      ...(args.artifacts?.checkpointId !== undefined ? { checkpointId: args.artifacts.checkpointId } : {}),
      ...(args.detail !== undefined ? { detail: args.detail } : {}),
    });
    // `executionId` is attached by SPREAD, not passed in: `buildActionRecord`
    // (the observability module, owned elsewhere) does not declare the field,
    // and the record must carry it NOW — the whole point is that the bus record
    // and the acceptance-ledger row join on ONE id. The annotation names the
    // ENRICHED shape (`ActionRecord & { executionId? }`) — a plain `ActionRecord`
    // annotation would trip the excess-property check on the fresh literal,
    // since `executionId` is not declared there; the enriched type is assignable
    // to `ActionRecord` everywhere one is expected, and the field survives to
    // the bus payload verbatim.
    const record: ActionRecord & { executionId?: string } =
      executionId !== undefined ? { ...base, executionId } : base;
    try {
      publish("action.executed", record, {
        source: "core",
        ...(missionId !== undefined ? { missionId } : {}),
        ...(args.invokeOpts?.stepId !== undefined ? { stepId: args.invokeOpts.stepId } : {}),
      });
    } catch (error) {
      // Recording never vetoes — but a record that could not be written is a
      // state change nobody can see, so it must not vanish silently either.
      // The message itself goes through the redactor: Core's stdout is piped
      // into kai.log verbatim, and an error string can carry a credential.
      console.warn(
        `[kai-core] action record for "${args.toolId}" could not be published: ${
          redactText(error instanceof Error ? error.message : String(error))
        }`,
      );
    }
  }

  /**
   * Build the ONE invocation for an attempt, emit the ONE record for it, and
   * hand back the `ToolResult` the caller sees — for every outcome, executed or
   * refused, so a refusal is as traceable as a success.
   *
   * Provenance is derived HERE, at the single place every executed action
   * passes: `deriveToolProvenance` (./provenance.ts) applies the generic dedupe
   * guard and reads the per-tool artifact shape, so a deduped write names
   * nothing and a refusal names nothing — without a per-tool patch in this file.
   */
  function settle(meta: AttemptMeta, outcome: SettleOutcome): ToolResult {
    const completed = now();
    const executed = outcome.executed === true;
    const approvalId = outcome.approvalId ?? meta.approvalId;
    const approval = outcome.approval ?? meta.approval;
    const provenance = deriveToolProvenance({
      toolId: meta.toolId,
      input: meta.input,
      ...(executed ? { result: outcome.result } : {}),
      source: meta.source,
      executed,
    });
    const invocation: ToolInvocation = {
      invocationId: meta.invocationId,
      toolId: meta.toolId,
      ...(meta.executionId !== undefined ? { executionId: meta.executionId } : {}),
      ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
      ...(meta.agentId !== undefined ? { agentId: meta.agentId } : {}),
      source: meta.source,
      arguments: meta.input,
      status: outcome.status,
      startedAt: meta.startedAt,
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - meta.startedMs),
      ...(approvalId !== undefined ? { approvalId } : {}),
      ...(approval !== undefined ? { approval } : {}),
      policyDecision: outcome.decision?.outcome ?? "none",
      decisionSource: outcome.decision?.source ?? "not-reached",
      ...(meta.permission !== undefined ? { permission: meta.permission } : {}),
      provenance,
      ...(executed ? { result: outcome.result } : {}),
      ...(outcome.executed === true ? {} : { error: outcome.error }),
    };
    recordAction({
      toolId: meta.toolId,
      input: meta.input,
      resultState: outcome.status,
      startedAt: meta.startedAt,
      ...(outcome.decision !== undefined ? { decision: outcome.decision } : {}),
      ...(approvalId !== undefined ? { approvalId } : {}),
      ...(meta.invokeOpts !== undefined ? { invokeOpts: meta.invokeOpts } : {}),
      actionId: meta.invocationId,
      ...(meta.executionId !== undefined ? { executionId: meta.executionId } : {}),
      artifacts: provenance.artifacts,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    });
    if (outcome.executed === true) {
      return { ok: true, result: outcome.result, invocation };
    }
    return { ok: false, error: outcome.error, invocation };
  }

  function register(tool: ToolDefinition): void {
    assertWellFormed(tool);
    // Refuse to shadow an existing id: silently replacing a reviewed tool with
    // a same-named one is exactly the kind of confusion this boundary exists to
    // prevent. Callers that want a different tool should choose a new id.
    if (tools.has(tool.id)) {
      throw new Error(`tool "${tool.id}" is already registered; refusing to overwrite it`);
    }
    tools.set(tool.id, tool);
  }

  function get(id: string): ToolDefinition | undefined {
    return tools.get(id);
  }

  function list(): ToolDefinition[] {
    return [...tools.values()];
  }

  async function invoke(id: string, input: unknown, invokeOpts?: ToolInvokeOptions): Promise<ToolResult> {
    const started = now();
    const tool = tools.get(id);
    const executionId = resolveExecutionId(invokeOpts);
    // ONE attempt, ONE identity: `invocationId` is minted here and reused as the
    // record's `actionId` in `settle`, so the invocation the caller receives and
    // the record the bus persists are the same attempt by construction.
    const meta: AttemptMeta = {
      invocationId: nextActionId(),
      toolId: id,
      input,
      startedAt: started.toISOString(),
      startedMs: started.getTime(),
      source: invokeOpts?.source ?? "core",
      ...(invokeOpts !== undefined ? { invokeOpts } : {}),
      ...(executionId !== undefined ? { executionId } : {}),
      ...(invokeOpts?.sessionId !== undefined ? { sessionId: invokeOpts.sessionId } : {}),
      ...(invokeOpts?.agentId !== undefined ? { agentId: invokeOpts.agentId } : {}),
      ...(invokeOpts?.approvalId !== undefined ? { approvalId: invokeOpts.approvalId } : {}),
      ...(tool !== undefined ? { permission: permissionOf(tool) } : {}),
    };
    if (tool === undefined) {
      return settle(meta, {
        status: "NOT_FOUND",
        error: toolError("NOT_FOUND", `no tool is registered with id "${id}"`, now),
        detail: "no such tool",
      });
    }

    // ── 0. cancellation ────────────────────────────────────────────────────
    // Stopping before a start is still a stop: an already-aborted attempt
    // settles CANCELLED without validation, policy, approval or execution.
    // Cancellation wins over every other outcome for this attempt.
    if (invokeOpts?.signal?.aborted === true) {
      return settle(meta, {
        status: "FAILED",
        error: toolError("CANCELLED", `tool "${id}" was cancelled before it started`, now),
        detail: "cancelled before execute",
      });
    }

    // ── 1. validate ──────────────────────────────────────────────────────────
    // First, and unconditionally: an input that does not parse must never reach
    // the policy engine or the tool body.
    let validation: unknown;
    try {
      validation = tool.validate(input);
    } catch (error) {
      // A validator that THROWS is still a refusal that must be traceable: the
      // caller sent something this boundary could not even parse.
      return settle(meta, {
        status: "INVALID",
        error: toolError(
          "VALIDATION_FAILED",
          `tool "${id}" validator threw instead of returning a result: ${detailOf(error)}`,
          now,
          detailOf(error),
        ),
        detail: detailOf(error),
      });
    }
    if (!isRecord(validation) || typeof validation.ok !== "boolean") {
      return settle(meta, {
        status: "INVALID",
        error: toolError(
          "VALIDATION_FAILED",
          `tool "${id}" validator returned a malformed result (expected {ok, value|reason})`,
          now,
        ),
        detail: "validator returned a malformed result",
      });
    }
    if (!validation.ok) {
      const reason = typeof validation.reason === "string" ? validation.reason : "input rejected";
      return settle(meta, {
        status: "INVALID",
        error: toolError("VALIDATION_FAILED", `tool "${id}" rejected its input: ${reason}`, now, reason),
        detail: reason,
      });
    }
    // Validation passed: the VALIDATED value is what was acted on, from here on —
    // on the invocation's `arguments` and on the record alike.
    const value = validation.value;
    meta.input = value;

    // ── 2. policy ────────────────────────────────────────────────────────────
    if (policy === undefined) {
      return settle(meta, {
        status: "DENIED",
        error: toolError(
          "POLICY_DENIED",
          `tool "${id}" cannot run: no policy gate is attached to this registry`,
          now,
        ),
        detail: "no policy gate",
      });
    }

    const decision = await policy.check({
      toolId: id,
      action: tool.name,
      risk: tool.risk,
      ...(invokeOpts?.missionId !== undefined ? { missionId: invokeOpts.missionId } : {}),
      ...(invokeOpts?.stepId !== undefined ? { stepId: invokeOpts.stepId } : {}),
      input: value,
    });

    if (decision.outcome === "deny") {
      return settle(meta, {
        status: "DENIED",
        decision,
        ...(decision.approvalId !== undefined ? { approvalId: decision.approvalId } : {}),
        error: toolError("POLICY_DENIED", decision.reason, now, decision.approvalId),
      });
    }

    // ── 3. approval ──────────────────────────────────────────────────────────
    if (decision.outcome === "needs_approval") {
      if (approvals === undefined) {
        return settle(meta, {
          status: "APPROVAL_REQUIRED",
          decision,
          error: toolError(
            "APPROVAL_REQUIRED",
            `${decision.reason}; no approval service is attached so the request cannot be recorded`,
            now,
          ),
          detail: "no approval service is attached",
        });
      }

      const approvalId = invokeOpts?.approvalId;
      if (!isNonEmptyString(approvalId)) {
        // No approval in hand: record the question and hand the caller the id.
        const created = approvals.request({
          toolId: id,
          action: tool.name,
          reason: decision.reason,
          risk: tool.risk,
          inputHash: stableHash(value),
          ...(invokeOpts?.missionId !== undefined ? { missionId: invokeOpts.missionId } : {}),
          ...(invokeOpts?.stepId !== undefined ? { stepId: invokeOpts.stepId } : {}),
        });
        // Tell the runtime what was parked, so a verdict can re-issue it. The
        // hook never vetoes: a recording failure is not a reason to un-park.
        if (opts.onApprovalRequest !== undefined) {
          try {
            opts.onApprovalRequest({
              approvalId: created.id,
              toolId: id,
              input: value,
              ...(invokeOpts?.missionId !== undefined ? { missionId: invokeOpts.missionId } : {}),
              ...(invokeOpts?.stepId !== undefined ? { stepId: invokeOpts.stepId } : {}),
              ...(invokeOpts?.scheduleId !== undefined ? { scheduleId: invokeOpts.scheduleId } : {}),
              ...(invokeOpts?.turnId !== undefined ? { turnId: invokeOpts.turnId } : {}),
            });
          } catch (error) {
            // Recording is best-effort here; the approval itself is already durable.
            // Best-effort must still be loud: if the runtime never learns what was
            // parked, a verdict cannot re-issue it and the park looks orphaned.
            console.warn(
              `[kai-core] onApprovalRequest hook threw for "${id}" (approval ${created.id}): ${
                redactText(error instanceof Error ? error.message : String(error))
              }`,
            );
          }
        }
        return settle(meta, {
          status: "APPROVAL_REQUIRED",
          decision,
          approvalId: created.id,
          approval: { required: true, approvalId: created.id, status: "PENDING" },
          error: toolError(
            "APPROVAL_REQUIRED",
            `${decision.reason}; approval "${created.id}" is pending`,
            now,
            created.id,
          ),
        });
      }

      const approval: Approval | null = approvals.get(approvalId);
      if (approval === null) {
        return settle(meta, {
          status: "APPROVAL_REQUIRED",
          decision,
          approvalId,
          approval: { required: true, approvalId },
          error: toolError("APPROVAL_REQUIRED", `approval "${approvalId}" is unknown`, now, approvalId),
          detail: "approval id is unknown",
        });
      }
      // An approval authorises one tool and no other. Without this check a real
      // "yes" to a benign action could be spent on a dangerous one.
      if (approval.toolId !== id) {
        // This is the one refusal that means someone tried to spend an approval
        // on the wrong action, so it must be traceable with both ids on record.
        return settle(meta, {
          status: "DENIED",
          decision,
          approvalId,
          approval: { required: true, approvalId, status: approval.status },
          error: toolError(
            "POLICY_DENIED",
            `approval "${approvalId}" was granted for tool "${approval.toolId}" and does not authorise "${id}"`,
            now,
          ),
          detail: `approval was granted for tool "${approval.toolId}"`,
        });
      }
      // An approval binds to the ACTION, not just the tool. A verdict given for
      // one input must not authorise a different one — approving "restore
      // checkpoint A into dir X" cannot be spent on "restore checkpoint B into
      // dir Y". Absent on a pre-migration row, in which case the tool-level check
      // above is all there is and that is stated in the refusal below.
      if (approval.inputHash !== undefined && approval.inputHash !== stableHash(value)) {
        return settle(meta, {
          status: "DENIED",
          decision,
          approvalId,
          approval: { required: true, approvalId, status: approval.status },
          error: toolError(
            "POLICY_DENIED",
            `approval "${approvalId}" was granted for a DIFFERENT input to "${id}" and does not authorise this action`,
            now,
          ),
          detail: "approval was granted for different input",
        });
      }
      if (approval.status === "REJECTED") {
        return settle(meta, {
          status: "DENIED",
          decision,
          approvalId,
          approval: { required: true, approvalId, status: approval.status },
          error: toolError("POLICY_DENIED", `approval "${approvalId}" was rejected`, now),
          detail: "approval was rejected",
        });
      }
      if (approval.status === "EXPIRED") {
        return settle(meta, {
          status: "DENIED",
          decision,
          approvalId,
          approval: { required: true, approvalId, status: approval.status },
          error: toolError("POLICY_DENIED", `approval "${approvalId}" expired before use`, now),
          detail: "approval expired before use",
        });
      }
      if (approval.status !== "APPROVED") {
        return settle(meta, {
          status: "APPROVAL_REQUIRED",
          decision,
          approvalId,
          approval: { required: true, approvalId, status: approval.status },
          error: toolError(
            "APPROVAL_REQUIRED",
            `approval "${approvalId}" is still ${approval.status}`,
            now,
            approvalId,
          ),
          detail: `approval is still ${approval.status}`,
        });
      }
      // APPROVED and bound to this tool: fall through to execute. The approval
      // that AUTHORISED the run rides on the invocation and the record.
      meta.approval = { required: true, approvalId, status: approval.status };
    }

    // ── 4. execute ───────────────────────────────────────────────────────────
    try {
      const result = await tool.execute(value, {
        ...(invokeOpts?.missionId !== undefined ? { missionId: invokeOpts.missionId } : {}),
        ...(invokeOpts?.stepId !== undefined ? { stepId: invokeOpts.stepId } : {}),
        ...(invokeOpts?.scheduleId !== undefined ? { scheduleId: invokeOpts.scheduleId } : {}),
        ...(invokeOpts?.turnId !== undefined ? { turnId: invokeOpts.turnId } : {}),
        ...(invokeOpts?.signal !== undefined ? { signal: invokeOpts.signal } : {}),
      });
      // The result NAMES what was produced (a memory id, a skill id, …) — when
      // it really produced it. `settle` reads it through `deriveToolProvenance`,
      // which applies the generic dedupe guard first, so a deduped write names
      // nothing and the trace stays unambiguous.
      return settle(meta, { status: "EXECUTED", decision, executed: true, result });
    } catch (error) {
      // A tool that throws is a tool that failed, not a registry that failed.
      return settle(meta, {
        status: "FAILED",
        decision,
        error: toolError("INTERNAL", `tool "${id}" failed while executing: ${detailOf(error)}`, now, detailOf(error)),
        detail: detailOf(error),
      });
    }
  }

  return { register, get, list, invoke, record: recordAction };
}

// ── The tool-plane vocabulary, re-exported ────────────────────────────────────
//
// One import site for consumers: a caller that already depends on
// `./registry.ts` (the MCP adapter, the capability layer, the tests) can reach
// the eight nouns and their helpers without a second import path, and the names
// cannot drift because they are re-exports of the ONE declaration in ./types.ts.
// `describeTool` is the description builder the /tools routes serve.

export {
  describeTool,
  permissionOf,
  sideEffectingOf,
  toolError,
} from "./types.ts";
export type {
  ToolApproval,
  ToolArtifactIds,
  ToolCallStatus,
  ToolDescription,
  ToolError,
  ToolFieldSchema,
  ToolFieldType,
  ToolInvocation,
  ToolPermission,
  ToolProvenance,
  ToolResult,
  ToolSchema,
  ToolSchemaView,
} from "./types.ts";
export { deriveToolProvenance, dedupeSignalOf, deriveArtifactIds } from "./provenance.ts";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * POST /worker/authorize — the per-action authorization boundary for an external worker.
 *
 * ── Why this exists
 * KAI's tool boundary (`tools/registry.ts`) is mandatory for anything KAI itself runs: a
 * tool call passes validate → risk → policy → (approval) → execute, and there is no second
 * path. But a DELEGATED worker (Hermes) executes its own tools inside its own process, so
 * those calls never reached that boundary. This route is the decision half of closing that
 * gap: the worker declares the exact action it is about to take, and KAI answers
 * allow / deny / needs-approval BEFORE the side effect happens.
 *
 * ── What it deliberately reuses instead of reimplementing
 * `runtime.policy` — the same engine the registry consults. There is no second policy path
 * here; this is a caller of the existing authority, which is the whole point. The arguments
 * are checked by the TOOL'S OWN `validate()`, the same authority the registry uses, so what
 * gets bound and shown to a human is the exact input the tool will receive.
 *
 * ── The properties that make it an authority rather than a suggestion
 *   1. RISK COMES FROM THE REGISTRY, NOT THE CALLER. The tool id is looked up in
 *      `runtime.tools`, and `risk`/`action` are taken from that definition. A worker
 *      cannot declare READ for a DESTRUCTIVE tool to talk its way past approval.
 *   2. AN UNKNOWN TOOL IS DENIED. There is no "assume it is fine" branch.
 *   3. THE DECISION IS BOUND TO THE EXACT ARGUMENTS. A canonical hash of (toolId, args) is
 *      returned, so an approval for `rm -rf /a` cannot be replayed for `rm -rf /b`.
 *   4. A WORKER CAN NEVER SELF-APPROVE. This route only ever evaluates policy; it cannot
 *      mint an approval. `needs_approval` is reported as needing a HUMAN decision.
 *   5. FAILURE IS NEVER A GRANT. Every malformed input, unknown tool, or policy error
 *      returns a non-allow decision. The route has no code path that returns `allow`
 *      without a policy decision behind it.
 *
 * ── What is new here: the worker's NAMES are not KAI's ids
 * A Hermes worker declares `read_file`, `write_file`, `terminal` — names KAI does not
 * register. Refusing every one of them was correct and useless (legitimate work denied by a
 * name mismatch is how a gate gets switched off), so this route now offers a name it does
 * not register to `agents/tool-mapping.ts`:
 *
 *   • a name the resolver MAPS becomes the KAI id plus normalised arguments, and then takes
 *     the ordinary path below — risk from the registry, the tool's own validator, policy;
 *   • a name the resolver REFUSES is denied with the resolver's machine-readable code
 *     (`permanent_deny`, `unsupported_capability`, `ambiguous_mapping`, ...), regardless of
 *     the arguments it came with;
 *   • a name that is neither is denied exactly as before.
 *
 * The translation cannot widen anything: it never produces an id that is not in the mapping
 * table, it refuses a mapping whose live risk is weaker than the one it was reviewed against
 * (`risk_regression`), and a fixed set of KAI ids is refused outright on this path
 * (`workerForbiddenKaiTool` — self-approval, policy authoring, identity, code loading, MCP
 * administration, dispatchers), because those are preconditions OF the boundary rather than
 * actions taken through it. `shell.run` and `filesystem.write` are deliberately NOT on that
 * list: the running policy already parks them for a human.
 */

import { createHash } from "node:crypto";

import { resolveHermesTool, workerForbiddenKaiTool } from "../agents/tool-mapping.ts";
import type { CoreRuntime } from "../runtime.ts";
import type { RiskLevel } from "../shared/contracts.ts";
import type { PolicyDecision } from "../policies/gate.ts";

/** One worker's declared intent, as it arrives on the wire. */
export interface WorkerAuthorizeRequest {
  /** The registry tool id the worker is about to run, e.g. "terminal". */
  toolId: string;
  /** The exact arguments it will pass. Hashed into the authorization binding. */
  args: unknown;
  /** Which worker is asking, for the audit record. */
  worker?: string;
  missionId?: string;
  stepId?: string;
  /** How the worker intends to invoke it, for the record (e.g. "shell", "delegate"). */
  route?: string;
}

export interface WorkerAuthorizeDecision {
  decision: "allow" | "deny" | "needs_approval";
  /** Why, in words a human or a log can act on. */
  reason: string;
  /**
   * The machine-readable reason: a refusal code from the resolver ("permanent_deny",
   * "ambiguous_mapping", "unsupported_argument", ...), a boundary code ("no_tool_id",
   * "invalid_args", "unknown_tool", "invalid_arguments", "worker_forbidden_kai_tool",
   * "policy_error"), or `policy_<outcome>` when the policy authority decided.
   */
  code: string;
  /** Which authority decided (a rule, the mode, or the default). */
  source: string;
  /** Present when the decision is `needs_approval`; the human decides this one. */
  approvalId?: string;
  /**
   * The binding: sha256 over (toolId + canonical args). An approval is valid only for
   * this exact value, so a different command cannot reuse it.
   */
  binding: string;
  /** The risk the REGISTRY declares for this tool — never the caller's claim. */
  risk: RiskLevel;
  /** The tool's display name, also from the registry. */
  action: string;
  /** Present when the worker's name was TRANSLATED: what it asked for, and what it means. */
  mapping?: { from: string; to: string; equivalence: string };
}

/** A refusal we generate ourselves, always with a reason and never `allow`. */
function refuse(reason: string, binding: string, code: string): WorkerAuthorizeDecision {
  return {
    decision: "deny",
    reason,
    code,
    source: "default",
    binding,
    risk: "DESTRUCTIVE",
    action: "unknown",
  };
}

/**
 * Canonical JSON: object keys sorted, recursively, so two structurally equal argument sets
 * always hash the same regardless of key order. Without this, `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` would be different bindings for the same command.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The binding an approval is valid for: this tool, these exact arguments. */
export function authorizationBinding(toolId: string, args: unknown): string {
  return createHash("sha256").update(`${toolId}\u0000${canonicalJson(args)}`).digest("hex").slice(0, 32);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Decide one declared action. Exported so it is testable without HTTP.
 *
 * `runtime` is the real Core runtime; only `tools.get` and `policy.check` are used.
 */
export async function authorizeWorkerAction(
  runtime: CoreRuntime,
  raw: unknown,
): Promise<WorkerAuthorizeDecision> {
  const body = (raw ?? {}) as Record<string, unknown>;

  const declared = asNonEmptyString(body["toolId"]);
  const worker = asNonEmptyString(body["worker"]);
  const args = body["args"];

  // ── Validation. Every failure denies, and names what was wrong. ────────────────
  if (declared === null) {
    return refuse("the request names no toolId, so there is nothing to authorize", "none", "no_tool_id");
  }
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    // A non-object `args` cannot be hashed meaningfully, so it cannot be bound.
    return refuse(
      `args for "${declared}" must be an object or omitted, not ${Array.isArray(args) ? "an array" : typeof args}`,
      "invalid",
      "invalid_args",
    );
  }
  const declaredArgs = args === undefined ? {} : args;

  // ── The worker's name is not necessarily KAI's id. A name this Core registers is taken
  //    as-is (no translation, no alias); anything else is offered to the mapping layer, and
  //    a refusal there is a refusal — bound to what the worker actually asked for. ─────────
  let toolId = declared;
  let effectiveArgs: unknown = declaredArgs;
  let mapping: WorkerAuthorizeDecision["mapping"];
  if (runtime.tools.get(declared) === undefined) {
    const translated = resolveHermesTool(declared, declaredArgs, runtime.tools);
    if (!translated.ok) {
      return refuse(
        translated.reason,
        authorizationBinding(declared, declaredArgs),
        translated.code,
      );
    }
    toolId = translated.kaiToolId;
    effectiveArgs = translated.args;
    mapping = { from: translated.hermesTool, to: translated.kaiToolId, equivalence: translated.equivalence };
  }

  // ── The tool must exist, and the REGISTRY decides its risk. ────────────────────
  const tool = runtime.tools.get(toolId);
  if (tool === undefined) {
    return refuse(
      `"${toolId}" is not a tool this Core registers, so it cannot be authorized`,
      authorizationBinding(declared, declaredArgs),
      "unknown_tool",
    );
  }

  // ── Some ids are preconditions OF this boundary rather than actions through it. A
  //    worker that can author policy, replace KAI's identity, load code, resolve its own
  //    approval or administer MCP servers is not a worker being governed. ────────────────
  const forbidden = workerForbiddenKaiTool(toolId);
  if (forbidden !== undefined) {
    return refuse(
      `"${toolId}" is never authorized for a delegated worker: ${forbidden.reason}`,
      authorizationBinding(toolId, effectiveArgs),
      "worker_forbidden_kai_tool",
    );
  }

  // ── The arguments are judged by the TOOL'S OWN validator — the same authority the
  //    registry consults — BEFORE any decision is made, so an approval can never be minted
  //    for input the tool itself would refuse. ─────────────────────────────────────────
  let boundArgs: unknown = effectiveArgs;
  if (typeof tool.validate === "function") {
    const checked = tool.validate(effectiveArgs);
    if (!checked.ok) {
      return refuse(
        `the arguments for "${toolId}" were refused by the tool's own validator, so nothing was authorized: ${checked.reason}`,
        authorizationBinding(declared, declaredArgs),
        "invalid_arguments",
      );
    }
    boundArgs = checked.value;
  }
  const binding = authorizationBinding(toolId, boundArgs);

  // ── The decision comes from the existing policy authority. ────────────────────
  let decision: PolicyDecision;
  try {
    decision = await runtime.policy.check({
      toolId,
      action: tool.name,
      risk: tool.risk,
      input: {
        args: boundArgs,
        binding,
        ...(mapping !== undefined ? { mappedFrom: mapping.from } : {}),
        ...(worker !== null ? { worker } : {}),
      },
      ...(asNonEmptyString(body["missionId"]) !== null ? { missionId: asNonEmptyString(body["missionId"])! } : {}),
      ...(asNonEmptyString(body["stepId"]) !== null ? { stepId: asNonEmptyString(body["stepId"])! } : {}),
    });
  } catch (err) {
    // A policy error must never become a grant. Fail closed, and say so.
    return refuse(
      `policy evaluation failed for "${toolId}", so the action was refused: ${err instanceof Error ? err.message : String(err)}`,
      binding,
      "policy_error",
    );
  }

  const base = {
    reason: decision.reason,
    code: `policy_${decision.outcome}`,
    source: decision.source,
    binding,
    risk: tool.risk,
    action: tool.name,
    ...(mapping !== undefined ? { mapping } : {}),
  };
  if (decision.outcome === "allow") return { decision: "allow", ...base };
  if (decision.outcome === "needs_approval") {
    // Something upstream already parked this and named the record; do not mint a second
    // question about the same action.
    if (decision.approvalId !== undefined) {
      return { decision: "needs_approval", ...base, approvalId: decision.approvalId };
    }
    // ── A worker's ask must become a QUESTION A HUMAN CAN ANSWER ─────────────
    //
    // Reporting `needs_approval` on its own is an unactionable dead end: the hook tells
    // the worker "approve it in KAI, then retry" and there is nothing to approve. So the
    // ask is parked through the ONE approval service, bound to this exact tool and these
    // exact validated arguments (`inputHash` is the same binding returned to the caller).
    //
    // The retry then lands on a SPENT or SPENDABLE record, never on a blank slate:
    //   • an APPROVED record for this binding is spent here, authorising this one call;
    //   • a PENDING record for this binding is returned as-is, so a repeated ask does not
    //     stack a second question about the same action;
    //   • a spent record authorises nothing, so a fresh question is asked instead of
    //     silently reusing a "yes" that has already been used.
    const missionId = asNonEmptyString(body["missionId"]);
    const stepId = asNonEmptyString(body["stepId"]);
    const matching = runtime.approvals
      .list()
      .filter((approval) => approval.toolId === toolId && approval.inputHash === binding);

    const granted = matching.find(
      (approval) => approval.status === "APPROVED" && approval.consumedAt === undefined,
    );
    if (granted !== undefined) {
      // Consuming is the authorisation: the store only spends an APPROVED, unspent row,
      // so two racing retries cannot both succeed.
      if (runtime.approvals.consume(granted.id)) {
        return {
          decision: "allow",
          ...base,
          code: "approval_granted",
          reason: `the owner approved exactly this action (approval ${granted.id}); this call spent that approval`,
          approvalId: granted.id,
        };
      }
      return refuse(
        `approval ${granted.id} covers this action but was already spent, so it authorises nothing further; ask again for a new approval`,
        binding,
        "approval_spent",
      );
    }

    const pending = matching.find(
      (approval) =>
        approval.status === "PENDING" &&
        (approval.expiresAt === undefined || Date.parse(approval.expiresAt) > Date.now()),
    );
    if (pending !== undefined) {
      return { decision: "needs_approval", ...base, approvalId: pending.id };
    }

    const created = runtime.approvals.request({
      toolId,
      action: tool.name,
      reason: decision.reason,
      risk: tool.risk,
      inputHash: binding,
      ...(missionId !== null ? { missionId } : {}),
      ...(stepId !== null ? { stepId } : {}),
    });
    return { decision: "needs_approval", ...base, approvalId: created.id };
  }
  return { decision: "deny", ...base };
}

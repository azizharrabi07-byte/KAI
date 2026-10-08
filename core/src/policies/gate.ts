// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core policy gate (spec §37/§38).
 *
 * The single question this module answers: may this tool be run at all, and if
 * so, does a human have to say yes first? It is deliberately the *only* thing
 * that answers it — no tool decides its own trustworthiness.
 *
 * Safe by default. KAI will eventually be allowed to control this machine, and
 * the invariant that makes that acceptable is that the default path for
 * anything that touches the world is "stop and ask". So:
 *
 *   READ        -> allow
 *   WRITE       -> needs_approval   (a rule may permit specific tools)
 *   EXTERNAL    -> needs_approval   (a rule may permit specific tools)
 *   DESTRUCTIVE -> needs_approval   (a rule may permit specific tools)
 *
 * Nothing here ever *denies* by default — denial is a deliberate configuration
 * choice — but nothing dangerous is ever allowed silently either. An
 * unrecognized risk string is treated as needs_approval rather than trusted.
 *
 * A rule matches on `risk`, optionally narrowed to a list of tool ids. The
 * first matching rule in the configured order wins, so specific rules can be
 * placed ahead of general ones.
 */

import { isNonEmptyString, type PolicyMode, type RiskLevel } from "../shared/contracts.ts";
import {
  BASELINE_MODE,
  cancelElevation,
  confirmElevation,
  downgrade,
  effectiveMode,
  initialPolicyState,
  requestElevation,
  type ModeChange,
  type ModeScope,
  type PolicyActor,
  type PolicyState,
} from "./mode.ts";

export type PolicyOutcome = "allow" | "deny" | "needs_approval";

export interface PolicyRequest {
  toolId: string;
  action: string;
  risk: RiskLevel;
  missionId?: string;
  stepId?: string;
  input?: unknown;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
  approvalId?: string;
  /**
   * WHICH authority decided, as a stable key. A free-form reason is fine for a
   * human and useless for a UI or an audit log ("was this allowed by a rule, by
   * the mode, or by the default?"). Phase 0 found upstream's decision record
   * carries exactly this, and that KAI's `reason` alone could not answer it.
   */
  source: PolicySource;
}

/**
 * A closed set, deliberately. If a new authority is added it must be named here
 * rather than smuggled in as a reason string.
 */
export type PolicySource =
  | "default"
  | `rule:${string}`
  | `mode:${PolicyMode}`
  | "unknown-risk"
  | "no-gate";

export interface PolicyGate {
  check(request: PolicyRequest): Promise<PolicyDecision>;
}

export interface PolicyRule {
  id: string;
  risk: RiskLevel;
  outcome: PolicyOutcome;
  /** optional scope: tool ids this rule applies to; absent = all */
  tools?: string[];
}

const RISK_LEVELS: readonly RiskLevel[] = ["READ", "WRITE", "EXTERNAL", "DESTRUCTIVE"];
const OUTCOMES: readonly PolicyOutcome[] = ["allow", "deny", "needs_approval"];

/**
 * What happens when no configured rule matches. This table is the security
 * posture of the whole product, so it is a literal, single place, with no
 * cleverness: only READ is trusted to run unattended.
 */
const DEFAULT_OUTCOME: Readonly<Record<RiskLevel, PolicyOutcome>> = {
  READ: "allow",
  WRITE: "needs_approval",
  EXTERNAL: "needs_approval",
  DESTRUCTIVE: "needs_approval",
};

function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

function isOutcome(value: unknown): value is PolicyOutcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

/**
 * Drop rules that are not well-formed rather than trusting them. A rule that
 * cannot be understood must not be able to loosen anything: dropping it leaves
 * the subject tool on the safe default (needs_approval), which is the failure
 * direction we want.
 */
function normalizeRules(rules: readonly PolicyRule[]): PolicyRule[] {
  const out: PolicyRule[] = [];
  for (const rule of rules) {
    if (rule === null || typeof rule !== "object") continue;
    if (!isNonEmptyString(rule.id) || !isRiskLevel(rule.risk) || !isOutcome(rule.outcome)) continue;

    const normalized: PolicyRule = { id: rule.id, risk: rule.risk, outcome: rule.outcome };
    if (rule.tools !== undefined) {
      if (!Array.isArray(rule.tools)) continue;
      const tools = rule.tools.filter((tool): tool is string => isNonEmptyString(tool));
      if (tools.length !== rule.tools.length || tools.length === 0) continue;
      normalized.tools = tools;
    }
    out.push(normalized);
  }
  return out;
}

function ruleMatches(rule: PolicyRule, request: PolicyRequest): boolean {
  if (rule.risk !== request.risk) return false;
  // Absent `tools` means the rule is a blanket rule for this risk level.
  return rule.tools === undefined || rule.tools.includes(request.toolId);
}

const RULE_VERBS: Readonly<Record<PolicyOutcome, string>> = {
  allow: "allows",
  deny: "denies",
  needs_approval: "requires approval for",
};

function ruleReason(rule: PolicyRule, request: PolicyRequest): string {
  const scope =
    rule.tools === undefined ? `every ${request.risk} tool` : `tool "${request.toolId}"`;
  return `policy rule "${rule.id}" ${RULE_VERBS[rule.outcome]} ${scope}`;
}

function defaultReason(risk: RiskLevel, toolId: string, outcome: PolicyOutcome): string {
  if (outcome === "allow") {
    return `tool "${toolId}" is READ-only; read-only tools are allowed without approval`;
  }
  switch (risk) {
    case "WRITE":
      return `tool "${toolId}" performs a WRITE; writes are allowed only when a policy rule explicitly permits them, so this requires user approval`;
    case "EXTERNAL":
      return `tool "${toolId}" acts outside this machine (EXTERNAL); outbound actions always require user approval`;
    case "DESTRUCTIVE":
      return `tool "${toolId}" is DESTRUCTIVE; destructive actions always require user approval and are never allowed silently`;
    case "READ":
      // Unreachable today (READ defaults to allow) but kept exhaustive so a
      // future change to DEFAULT_OUTCOME still produces an honest reason.
      return `tool "${toolId}" is READ-only and requires approval by current policy`;
  }
}

export interface PolicyEngine extends PolicyGate {
  /** A copy of the live rule set. */
  rules(): PolicyRule[];
  /**
   * Replace the rule set at runtime. Malformed rules are dropped rather than
   * trusted, so the failure direction is always toward the safe default.
   */
  setRules(rules: readonly PolicyRule[]): { applied: number; dropped: number; reason: string };
  mode(): PolicyMode;
  policyState(): PolicyState;
  requestElevation(input: { to: PolicyMode; scope: ModeScope; requestedBy: PolicyActor }): ModeChange;
  confirmElevation(input: { requestId: string; confirmedBy: PolicyActor }): ModeChange;
  cancelElevation(): ModeChange;
  downgrade(input?: { to?: PolicyMode; reason?: string }): ModeChange;
}

/**
 * The per-mode outcome table. `normal` IS the historical default table, so the
 * default mode cannot change behaviour by accident — that is asserted in tests
 * rather than left to review.
 */
const MODE_OUTCOME: Readonly<Record<PolicyMode, Readonly<Record<RiskLevel, PolicyOutcome>>>> = {
  "ask-all": {
    READ: "needs_approval",
    WRITE: "needs_approval",
    EXTERNAL: "needs_approval",
    DESTRUCTIVE: "needs_approval",
  },
  normal: DEFAULT_OUTCOME,
  // Same risk table as `normal`: what `auto-read` adds is elsewhere (an exact,
  // already-granted scope is not re-asked), never a lower requirement here.
  "auto-read": DEFAULT_OUTCOME,
  elevated: {
    READ: "allow",
    WRITE: "allow",
    // Never loosened. A mode that let these through silently would make
    // "elevated" mean "unattended", which is not what it is.
    EXTERNAL: "needs_approval",
    DESTRUCTIVE: "needs_approval",
  },
};

function modeReason(mode: PolicyMode, risk: RiskLevel, toolId: string, outcome: PolicyOutcome): string {
  if (mode === "normal") return defaultReason(risk, toolId, outcome);
  if (mode === "ask-all") {
    return `policy mode "ask-all" requires approval for every action, including ${risk} tool "${toolId}"`;
  }
  if (mode === "elevated" && outcome === "allow") {
    return `policy mode "elevated" allows ${risk} tool "${toolId}" without a card (EXTERNAL and DESTRUCTIVE still require approval)`;
  }
  return defaultReason(risk, toolId, outcome);
}

export function createPolicyEngine(opts: {
  rules?: PolicyRule[];
  mode?: PolicyMode;
  now?: () => Date;
  idFactory?: () => string;
  /**
   * Audit sink. Called for every decision and every mode change. It must never
   * break the decision path, so a throwing sink is swallowed — an audit log that
   * can veto a decision has become a second gate.
   */
  onDecision?: (decision: PolicyDecision, request: PolicyRequest) => void;
} = {}): PolicyEngine {
  const now = opts.now ?? (() => new Date());
  let rules = normalizeRules(opts.rules ?? []);
  let state: PolicyState = initialPolicyState(now(), opts.mode ?? BASELINE_MODE);

  function audit(decision: PolicyDecision, request: PolicyRequest): void {
    try {
      opts.onDecision?.(decision, request);
    } catch {
      // Deliberately swallowed: see onDecision's contract above.
    }
  }

  async function check(request: PolicyRequest): Promise<PolicyDecision> {
    // Defensive: `risk` crosses an IPC boundary and is a plain string at
    // runtime. Anything unrecognized goes to a human rather than to the tool.
    if (!isRiskLevel(request.risk)) {
      const decision: PolicyDecision = {
        outcome: "needs_approval",
        reason: `tool "${request.toolId}" declares an unrecognized risk level (${JSON.stringify(
          request.risk,
        )}); unknown risks are never allowed silently`,
        source: "unknown-risk",
      };
      audit(decision, request);
      return decision;
    }

    // Explicit rules beat the mode: a rule is a narrower statement of intent
    // than "how KAI is currently configured".
    const rule = rules.find((candidate) => ruleMatches(candidate, request));
    if (rule !== undefined) {
      const decision: PolicyDecision = {
        outcome: rule.outcome,
        reason: ruleReason(rule, request),
        source: `rule:${rule.id}`,
      };
      audit(decision, request);
      return decision;
    }

    // An unconfirmed elevation must not be in force here (fail closed).
    const inForce = effectiveMode(state).mode;
    const outcome = MODE_OUTCOME[inForce][request.risk];
    const decision: PolicyDecision = {
      outcome,
      reason: modeReason(inForce, request.risk, request.toolId, outcome),
      source: inForce === "normal" ? "default" : `mode:${inForce}`,
    };
    audit(decision, request);
    return decision;
  }

  /** A copy, so a caller cannot mutate the live rule set through the return value. */
  function rulesSnapshot(): PolicyRule[] {
    return rules.map((rule) => ({
      id: rule.id,
      risk: rule.risk,
      outcome: rule.outcome,
      ...(rule.tools !== undefined ? { tools: [...rule.tools] } : {}),
    }));
  }

  function setRules(next: readonly PolicyRule[]): { applied: number; dropped: number; reason: string } {
    const candidate = Array.isArray(next) ? next : [];
    const normalized = normalizeRules(candidate);
    const dropped = candidate.length - normalized.length;
    rules = normalized;
    return {
      applied: normalized.length,
      dropped,
      reason:
        dropped > 0
          ? `applied ${normalized.length} policy rule(s); dropped ${dropped} malformed rule(s), which leaves their subjects on the safe default`
          : `applied ${normalized.length} policy rule(s)`,
    };
  }

  function applyChange(change: ModeChange): ModeChange {
    if (change.ok) state = change.state;
    return change;
  }

  return {
    check,
    rules: rulesSnapshot,
    setRules,
    mode: () => effectiveMode(state).mode,
    policyState: () => ({ ...state, ...(state.pending !== undefined ? { pending: { ...state.pending } } : {}) }),
    requestElevation: (input) => applyChange(requestElevation(state, { ...input, now: now(), requestId: opts.idFactory?.() ?? `elev-${now().getTime()}` })),
    confirmElevation: (input) => applyChange(confirmElevation(state, { ...input, now: now() })),
    cancelElevation: () => applyChange(cancelElevation(state, now())),
    downgrade: (input) => applyChange(downgrade(state, { ...(input ?? {}), now: now() })),
  };
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * capabilities/registry.ts — the catalogue of what KAI (or an employee) can USE.
 *
 * A capability is an *actuator*, not a reasoner: browser, computer, shell, git,
 * filesystem, mcp, network, voice, phone, scheduler. It is deliberately not the
 * same thing as an employee (shared/contracts.ts), and KAI holds direct
 * capabilities of its own — that is what keeps KAI working with zero employees
 * installed (brief Part M). `provider` records that split: "kai" for a direct
 * capability, an employee id otherwise.
 *
 * ── Why registration is refused rather than trusted ─────────────────────────
 * Two invariants protect the policy boundary that sits above this module:
 *
 *   1. Every exposed action must declare its own risk, and the capability's
 *      declared `risk` must never be LOWER than the risk of its most dangerous
 *      action. A capability that reports READ while one of its actions writes is
 *      a policy hole: the gate (policies/gate.ts) would let it run unattended.
 *      So registration is refused when the numbers disagree (POLICY_DENIED), and
 *      a capability that will not enumerate its actions is refused too — we
 *      cannot prove an understatement we cannot see. Overstating is always
 *      allowed: erring toward "ask a human" is the safe direction.
 *   2. Availability is under-claimed, never over-claimed. A capability that has
 *      not been probed starts UNAVAILABLE; a health probe that throws or returns
 *      a malformed result is recorded as UNAVAILABLE *with the reason*, never
 *      silently left at a previous AVAILABLE. An operator's `disable` outranks
 *      any probe, so a disabled capability can never be talked back to life by a
 *      health check.
 *
 * Errors are values (KaiError), never thrown at this module's boundary.
 */

import {
  isCapabilityAvailability,
  isNonEmptyString,
  isRecord,
  type Capability,
  type CapabilityAvailability,
  type CapabilityId,
  type KaiError,
  type KaiErrorCode,
  type RiskLevel,
} from "../shared/contracts.ts";

// ── Risk ordering ─────────────────────────────────────────────────────────────
//
// The one place risk levels are ordered. policies/gate.ts decides *whether* a
// risk may run; this decides *how risky* one level is relative to another, which
// is what both the understatement invariant and the grant matrix need. It is
// data rather than a chain of ifs so a new level cannot be inserted somewhere
// without being ordered here.

export const RISK_ORDER: readonly RiskLevel[] = ["READ", "WRITE", "EXTERNAL", "DESTRUCTIVE"];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_ORDER as readonly string[]).includes(value);
}

/** 0 = READ … 3 = DESTRUCTIVE. Higher means more authority. */
export function riskRank(risk: RiskLevel): number {
  return RISK_ORDER.indexOf(risk);
}

/** The most dangerous of a set of risks, or undefined when the set is empty. */
export function maxRisk(risks: readonly RiskLevel[]): RiskLevel | undefined {
  let max: RiskLevel | undefined;
  for (const risk of risks) {
    if (max === undefined || riskRank(risk) > riskRank(max)) max = risk;
  }
  return max;
}

// ── Errors as values ──────────────────────────────────────────────────────────

export function kaiError(
  code: KaiErrorCode,
  message: string,
  at: () => Date,
  detail?: string,
): KaiError {
  const error: KaiError = { code, message, retryable: false, at: at().toISOString() };
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** Result shape for every fallible capability operation. Mirrors tools/registry.ts. */
export type CapabilityResult<T> = { ok: true; value: T } | { ok: false; error: KaiError };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Shapes ────────────────────────────────────────────────────────────────────

/**
 * One action a capability exposes, and the risk of *performing* it. This is the
 * unit the understatement invariant is checked against: a capability is only as
 * safe as its worst action.
 */
export interface CapabilityAction {
  id: string;
  risk: RiskLevel;
}

/**
 * What a caller registers. It is `Capability` (contracts.ts) minus the derived
 * `supportedActions` and plus the per-action risk table:
 *
 *   - `supportedActions` is derived from `actions`, so the two can never
 *     disagree about what a capability exposes.
 *   - `provider` defaults to "kai" (a direct capability). An employee-provided
 *     capability names the employee id.
 *   - `availability` is optional and defaults to UNAVAILABLE: a capability that
 *     has not been probed is not advertised (under-claim, never over-claim).
 */
export interface CapabilityRegistration {
  id: CapabilityId;
  name: string;
  version?: string;
  availability?: CapabilityAvailability;
  risk: RiskLevel;
  requirements?: readonly string[];
  provider?: string;
  /** Every exposed action with its own risk. At least one is required. */
  actions: readonly CapabilityAction[];
  health(): Promise<{ availability: CapabilityAvailability; detail?: string }>;
}

/** A read-time view: the effective availability plus how it was reached. */
export interface CapabilityStatus {
  id: CapabilityId;
  /** The effective availability (DISABLED when an operator disabled it). */
  availability: CapabilityAvailability;
  /** Why, when the probe explained itself or failed. */
  detail?: string;
  /** ISO-8601 of the last probe, when one has run. */
  checkedAt?: string;
  /** True only when the last probe reported AVAILABLE and it is not disabled. */
  healthy: boolean;
  /** True when an operator disabled it; health can never override this. */
  disabled: boolean;
}

export interface CapabilityRegistry {
  register(registration: CapabilityRegistration): CapabilityResult<Capability>;
  unregister(id: CapabilityId): CapabilityResult<true>;
  get(id: CapabilityId): Capability | undefined;
  list(): Capability[];
  ids(): CapabilityId[];
  has(id: CapabilityId): boolean;
  /** The availability query. undefined for an unknown id (honest, not a default). */
  status(id: CapabilityId): CapabilityStatus | undefined;
  /** Runs the probe and records its verdict. undefined for an unknown id. */
  checkHealth(id: CapabilityId): Promise<CapabilityStatus | undefined>;
  checkAllHealth(): Promise<Record<CapabilityId, CapabilityStatus>>;
  disable(id: CapabilityId): CapabilityResult<true>;
  enable(id: CapabilityId): CapabilityResult<true>;
}

interface Entry {
  /** The stored definition; `availability` holds the last *probed* value. */
  capability: Capability;
  actions: readonly CapabilityAction[];
  /** Operator intent. When true the effective availability is DISABLED. */
  disabled: boolean;
  detail?: string;
  checkedAt?: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Returns a human reason when the registration is unusable, else null. */
function validateRegistration(value: unknown): string | null {
  if (!isRecord(value)) return "capability registration must be an object";
  if (!isNonEmptyString(value.id)) return "capability registration requires a non-empty id";
  if (!isNonEmptyString(value.name)) return `capability "${value.id}" requires a non-empty name`;
  if (!isRiskLevel(value.risk)) {
    return `capability "${value.id}" requires a valid risk level (${RISK_ORDER.join("/")})`;
  }
  if (value.provider !== undefined && !isNonEmptyString(value.provider)) {
    return `capability "${value.id}" provider must be a non-empty string when given`;
  }
  if (value.availability !== undefined && !isCapabilityAvailability(value.availability)) {
    return `capability "${value.id}" availability must be one of AVAILABLE/DEGRADED/UNAVAILABLE/DISABLED`;
  }
  if (value.version !== undefined && typeof value.version !== "string") {
    return `capability "${value.id}" version must be a string when given`;
  }
  if (value.requirements !== undefined) {
    if (!Array.isArray(value.requirements)) {
      return `capability "${value.id}" requirements must be an array of strings when given`;
    }
    for (const requirement of value.requirements) {
      if (!isNonEmptyString(requirement)) {
        return `capability "${value.id}" requirements must be non-empty strings`;
      }
    }
  }
  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    return `capability "${value.id}" must enumerate at least one action with its risk`;
  }
  const seen = new Set<string>();
  for (const action of value.actions) {
    if (!isRecord(action)) return `capability "${value.id}" actions must be objects`;
    if (!isNonEmptyString(action.id)) return `capability "${value.id}" actions require a non-empty id`;
    if (!isRiskLevel(action.risk)) {
      return `capability "${value.id}" action "${action.id}" requires a valid risk level`;
    }
    if (seen.has(action.id)) {
      return `capability "${value.id}" declares action "${action.id}" more than once`;
    }
    seen.add(action.id);
  }
  if (typeof value.health !== "function") return `capability "${value.id}" requires a health() probe`;
  return null;
}

// ── The registry ──────────────────────────────────────────────────────────────

export function createCapabilityRegistry(opts: { now?: () => Date } = {}): CapabilityRegistry {
  const now = opts.now ?? (() => new Date());
  const entries = new Map<CapabilityId, Entry>();

  /** Effective availability folds in the operator's disable, which always wins. */
  function effective(entry: Entry): CapabilityAvailability {
    return entry.disabled ? "DISABLED" : entry.capability.availability;
  }

  /** A copy, so a caller cannot mutate the live entry through the return value. */
  function view(entry: Entry): Capability {
    return { ...entry.capability, availability: effective(entry) };
  }

  function statusOf(entry: Entry): CapabilityStatus {
    const status: CapabilityStatus = {
      id: entry.capability.id,
      availability: effective(entry),
      healthy: !entry.disabled && entry.capability.availability === "AVAILABLE",
      disabled: entry.disabled,
    };
    if (entry.detail !== undefined) status.detail = entry.detail;
    if (entry.checkedAt !== undefined) status.checkedAt = entry.checkedAt;
    return status;
  }

  function register(registration: CapabilityRegistration): CapabilityResult<Capability> {
    const reason = validateRegistration(registration);
    if (reason !== null) {
      return { ok: false, error: kaiError("VALIDATION_FAILED", reason, now) };
    }
    if (entries.has(registration.id)) {
      // Same rule as the tool registry: silently replacing a reviewed
      // capability with a same-named one is exactly the confusion this
      // boundary exists to prevent.
      return {
        ok: false,
        error: kaiError(
          "VALIDATION_FAILED",
          `capability "${registration.id}" is already registered; refusing to overwrite it`,
          now,
        ),
      };
    }

    const actions: CapabilityAction[] = registration.actions.map((action) => ({
      id: action.id,
      risk: action.risk,
    }));

    // ── The understatement invariant ─────────────────────────────────────────
    // `maxRisk` is defined because validation required at least one action.
    const worst = maxRisk(actions.map((action) => action.risk)) as RiskLevel;
    if (riskRank(registration.risk) < riskRank(worst)) {
      const offenders = actions
        .filter((action) => action.risk === worst)
        .map((action) => `"${action.id}"`)
        .join(", ");
      return {
        ok: false,
        error: kaiError(
          "POLICY_DENIED",
          `capability "${registration.id}" declares risk ${registration.risk} but exposes ${worst} action(s) ${offenders}; ` +
            `a capability must never report a risk lower than its most dangerous action`,
          now,
          `declared=${registration.risk} required>=${worst}`,
        ),
      };
    }

    const capability: Capability = {
      id: registration.id,
      name: registration.name,
      availability: registration.availability ?? "UNAVAILABLE",
      risk: registration.risk,
      provider: registration.provider ?? "kai",
      supportedActions: actions.map((action) => action.id),
      health: registration.health,
    };
    if (registration.version !== undefined) capability.version = registration.version;
    if (registration.requirements !== undefined) {
      capability.requirements = [...registration.requirements];
    }

    const entry: Entry = { capability, actions, disabled: false };
    entries.set(registration.id, entry);
    return { ok: true, value: view(entry) };
  }

  function unregister(id: CapabilityId): CapabilityResult<true> {
    if (!entries.delete(id)) {
      return { ok: false, error: kaiError("NOT_FOUND", `no capability "${id}" is registered`, now) };
    }
    return { ok: true, value: true };
  }

  function get(id: CapabilityId): Capability | undefined {
    const entry = entries.get(id);
    return entry === undefined ? undefined : view(entry);
  }

  function list(): Capability[] {
    return [...entries.values()].map(view);
  }

  function ids(): CapabilityId[] {
    return [...entries.keys()];
  }

  function has(id: CapabilityId): boolean {
    return entries.has(id);
  }

  function status(id: CapabilityId): CapabilityStatus | undefined {
    const entry = entries.get(id);
    return entry === undefined ? undefined : statusOf(entry);
  }

  async function checkHealth(id: CapabilityId): Promise<CapabilityStatus | undefined> {
    const entry = entries.get(id);
    if (entry === undefined) return undefined;

    let availability: CapabilityAvailability;
    let detail: string | undefined;
    try {
      const result = await entry.capability.health();
      if (isRecord(result) && isCapabilityAvailability(result.availability)) {
        availability = result.availability;
        detail = typeof result.detail === "string" ? result.detail : undefined;
      } else {
        // A malformed verdict is not a healthy one. Treat it as unavailable and
        // say why, rather than guessing at intent.
        availability = "UNAVAILABLE";
        detail = "health probe returned a malformed result (expected { availability, detail? })";
      }
    } catch (error) {
      // A crashed probe is a health *result*, never a throw at this boundary.
      availability = "UNAVAILABLE";
      detail = `health probe threw: ${describe(error)}`;
    }

    // Record the probe. When disabled, `effective()` still reports DISABLED, so
    // storing the probed value cannot resurrect a capability an operator turned
    // off.
    entry.capability = { ...entry.capability, availability };
    entry.detail = detail;
    entry.checkedAt = now().toISOString();
    return statusOf(entry);
  }

  async function checkAllHealth(): Promise<Record<CapabilityId, CapabilityStatus>> {
    const result: Record<CapabilityId, CapabilityStatus> = {};
    for (const id of entries.keys()) {
      const checked = await checkHealth(id);
      if (checked !== undefined) result[id] = checked;
    }
    return result;
  }

  function disable(id: CapabilityId): CapabilityResult<true> {
    const entry = entries.get(id);
    if (entry === undefined) {
      return { ok: false, error: kaiError("NOT_FOUND", `no capability "${id}" is registered`, now) };
    }
    entry.disabled = true;
    return { ok: true, value: true };
  }

  function enable(id: CapabilityId): CapabilityResult<true> {
    const entry = entries.get(id);
    if (entry === undefined) {
      return { ok: false, error: kaiError("NOT_FOUND", `no capability "${id}" is registered`, now) };
    }
    // Re-enabling restores the last *probed* availability, not a claim of health:
    // if it was never probed that is UNAVAILABLE until checkHealth says otherwise.
    entry.disabled = false;
    return { ok: true, value: true };
  }

  return {
    register,
    unregister,
    get,
    list,
    ids,
    has,
    status,
    checkHealth,
    checkAllHealth,
    disable,
    enable,
  };
}

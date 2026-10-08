// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * capabilities/matrix.ts — the CapabilityGrant matrix (spec Part L).
 *
 * This is the Employee × Capability × Permission relationship: *may* this
 * employee use this capability, up to what risk, and in exactly which place.
 * It is deliberately the only thing that answers that question, and it is
 * deliberately separate from both availability (whether the capability works)
 * and policy (policies/gate.ts, whether *any* action of this risk may run). The
 * planner composes the three; none of them trusts the others' job.
 *
 * ── Why scope is explicit and never implicit ─────────────────────────────────
 * A grant names a scope: `thread`, `mission`, `employee` or `global`. There is
 * no implicit "everywhere" — a mission- or thread-scoped grant must carry the
 * `scopeId` it is anchored to, or it is refused at grant time, because a grant
 * missing its anchor is an unrestricted grant wearing a narrow-sounding label.
 * Coverage is directional:
 *
 *   - `global`    covers every request.
 *   - `employee`  covers all work by that one employee (its employeeId already
 *                 matched), whatever the request's own scope.
 *   - `mission`   covers only a request that is itself mission-scoped to the
 *                 same mission id.
 *   - `thread`    covers only a request that is itself thread-scoped to the same
 *                 thread id.
 *
 * So a thread grant can never leak into a mission or global request, while a
 * global grant (which means it) can cover a thread request.
 *
 * ── Why the permission is a ceiling, not a floor ─────────────────────────────
 * `permission` is the highest risk the grant allows. A use is authorized when
 * its risk is at or below the grant's permission. When several grants match, the
 * check reports the *tightest* grant that still covers the request — that is the
 * "minimum necessary authority" primitive the planner reads.
 *
 * Errors are values (KaiError), never thrown at this module's boundary.
 */

import {
  isNonEmptyString,
  isRecord,
  type CapabilityGrant,
  type CapabilityId,
  type RiskLevel,
} from "../shared/contracts.ts";
import {
  kaiError,
  maxRisk,
  riskRank,
  isRiskLevel,
  type CapabilityResult,
} from "./registry.ts";

export const GRANT_SCOPES: readonly CapabilityGrant["scope"][] = [
  "thread",
  "mission",
  "employee",
  "global",
];

function isScope(value: unknown): value is CapabilityGrant["scope"] {
  return typeof value === "string" && (GRANT_SCOPES as readonly string[]).includes(value);
}

/** What a caller asks about: one proposed use, in one explicit place. */
export interface CapabilityUse {
  employeeId: string;
  capabilityId: CapabilityId;
  risk: RiskLevel;
  scope: CapabilityGrant["scope"];
  /** Required for thread/mission scopes; identifies the thread or mission. */
  scopeId?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  /** Always populated — a denial explains itself, like the policy gate's. */
  reason: string;
  /** The tightest matching grant that authorized the use, when allowed. */
  grant?: CapabilityGrant;
  /** The risk ceiling of that grant, when allowed. */
  authority?: RiskLevel;
}

export interface CapabilityMatrix {
  grant(grant: CapabilityGrant): CapabilityResult<CapabilityGrant>;
  revoke(grant: CapabilityGrant): CapabilityResult<true>;
  grants(): CapabilityGrant[];
  grantsFor(employeeId: string, capabilityId?: CapabilityId): CapabilityGrant[];
  /** The permission check: consult the matrix for one proposed use. */
  checkUse(use: CapabilityUse): PermissionDecision;
}

/** Stable identity of a grant, used for the no-overwrite and revoke rules. */
function grantKey(grant: CapabilityGrant): string {
  return [grant.employeeId, grant.capabilityId, grant.scope, grant.scopeId ?? ""].join("\u0000");
}

function copyGrant(grant: CapabilityGrant): CapabilityGrant {
  const copy: CapabilityGrant = {
    employeeId: grant.employeeId,
    capabilityId: grant.capabilityId,
    permission: grant.permission,
    scope: grant.scope,
  };
  if (grant.scopeId !== undefined) copy.scopeId = grant.scopeId;
  return copy;
}

/**
 * Does this grant's scope cover a request at `use.scope`? The employee and
 * capability of the two are compared by the caller; this answers only the
 * "where" half.
 */
function grantCovers(grant: CapabilityGrant, use: CapabilityUse): boolean {
  switch (grant.scope) {
    case "global":
      return true;
    case "employee":
      // employeeId already matched, so an employee grant covers all of that
      // employee's work. A grant that says otherwise is not an employee grant.
      return true;
    case "mission":
      return use.scope === "mission" && grant.scopeId === use.scopeId;
    case "thread":
      return use.scope === "thread" && grant.scopeId === use.scopeId;
  }
}

export function createCapabilityMatrix(
  opts: { now?: () => Date } = {},
): CapabilityMatrix {
  const now = opts.now ?? (() => new Date());
  const grants = new Map<string, CapabilityGrant>();

  function validate(input: unknown): string | null {
    if (!isRecord(input)) return "capability grant must be an object";
    if (!isNonEmptyString(input.employeeId)) return "capability grant requires a non-empty employeeId";
    if (!isNonEmptyString(input.capabilityId)) {
      return `capability grant for employee "${input.employeeId}" requires a non-empty capabilityId`;
    }
    if (!isRiskLevel(input.permission)) {
      return `capability grant for "${input.capabilityId}" requires a valid permission risk level`;
    }
    if (!isScope(input.scope)) {
      return `capability grant for "${input.capabilityId}" requires a scope (${GRANT_SCOPES.join("/")})`;
    }
    const scopeId = input.scopeId;
    if (scopeId !== undefined && !isNonEmptyString(scopeId)) {
      return `capability grant for "${input.capabilityId}" scopeId must be a non-empty string when given`;
    }
    // The scope-anchor rule. A mission/thread grant without its id, or a global
    // grant wearing one, is a contradiction, so it is refused rather than
    // reinterpreted — this is where "no implicit everywhere" is enforced.
    if ((input.scope === "mission" || input.scope === "thread") && scopeId === undefined) {
      return `capability grant with scope "${input.scope}" requires a scopeId; a scoped grant without an anchor would be unrestricted`;
    }
    if (input.scope === "global" && scopeId !== undefined) {
      return `capability grant with scope "global" must not carry a scopeId`;
    }
    if (input.scope === "employee" && scopeId !== undefined && scopeId !== input.employeeId) {
      return `capability grant with scope "employee" may only anchor to its own employee id`;
    }
    return null;
  }

  function grant(input: CapabilityGrant): CapabilityResult<CapabilityGrant> {
    const reason = validate(input);
    if (reason !== null) {
      return { ok: false, error: kaiError("VALIDATION_FAILED", reason, now) };
    }
    const normalized = copyGrant(input);
    const key = grantKey(normalized);
    if (grants.has(key)) {
      // Refuse to silently replace a reviewed grant with a different ceiling.
      return {
        ok: false,
        error: kaiError(
          "VALIDATION_FAILED",
          `employee "${normalized.employeeId}" already holds a grant for "${normalized.capabilityId}" at scope ${normalized.scope}; revoke it before re-granting`,
          now,
        ),
      };
    }
    grants.set(key, normalized);
    return { ok: true, value: copyGrant(normalized) };
  }

  function revoke(input: CapabilityGrant): CapabilityResult<true> {
    const key = grantKey(input);
    if (!grants.has(key)) {
      return {
        ok: false,
        error: kaiError(
          "NOT_FOUND",
          `no grant matches employee "${input.employeeId}" / capability "${input.capabilityId}" / scope ${input.scope}`,
          now,
        ),
      };
    }
    grants.delete(key);
    return { ok: true, value: true };
  }

  function grantsSnapshot(): CapabilityGrant[] {
    return [...grants.values()].map(copyGrant);
  }

  function grantsFor(employeeId: string, capabilityId?: CapabilityId): CapabilityGrant[] {
    return grantsSnapshot().filter(
      (grant) =>
        grant.employeeId === employeeId &&
        (capabilityId === undefined || grant.capabilityId === capabilityId),
    );
  }

  function checkUse(use: CapabilityUse): PermissionDecision {
    if (!isRiskLevel(use.risk)) {
      return {
        allowed: false,
        reason: `unrecognized risk ${JSON.stringify(use.risk)}; an unknown risk is never authorized`,
      };
    }

    const matching = [...grants.values()].filter(
      (grant) =>
        grant.employeeId === use.employeeId &&
        grant.capabilityId === use.capabilityId &&
        grantCovers(grant, use),
    );

    if (matching.length === 0) {
      return {
        allowed: false,
        reason: `no capability grant authorizes employee "${use.employeeId}" to use "${use.capabilityId}" in scope ${use.scope}`,
      };
    }

    // The tightest grant that still covers the requested risk — the minimum
    // authority that does the job, not the first or the widest one.
    let best: CapabilityGrant | undefined;
    for (const grant of matching) {
      if (riskRank(grant.permission) < riskRank(use.risk)) continue;
      if (best === undefined || riskRank(grant.permission) < riskRank(best.permission)) {
        best = grant;
      }
    }

    if (best === undefined) {
      const ceiling = maxRisk(matching.map((grant) => grant.permission)) as RiskLevel;
      return {
        allowed: false,
        reason: `employee "${use.employeeId}" holds grants for "${use.capabilityId}" but they permit at most ${ceiling}, below the required ${use.risk}`,
      };
    }

    return {
      allowed: true,
      reason: `grant permits employee "${use.employeeId}" to use "${use.capabilityId}" up to ${best.permission} in scope ${best.scope}${best.scopeId !== undefined ? ` (${best.scopeId})` : ""}`,
      grant: copyGrant(best),
      authority: best.permission,
    };
  }

  return { grant, revoke, grants: grantsSnapshot, grantsFor, checkUse };
}

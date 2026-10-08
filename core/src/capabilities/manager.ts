// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * capabilities/manager.ts — the Capability Manager (spec Parts K + L).
 *
 * It composes three things that must stay separate and be asked separately:
 *
 *   registry.ts  what a capability *is* (metadata, availability, health)
 *   matrix.ts    what an employee *may* do with it (Employee × Capability ×
 *                Permission, with an explicit scope)
 *   this file    who should *do the work*: which employee declares a
 *                capability, whether it is available, and — the planning query —
 *                which available employee can perform it at the required risk
 *                with the minimum necessary authority
 *
 * ── Employees are declared, never assumed ────────────────────────────────────
 * The manager holds an employee *mapping* only: an id, its state, and the
 * capability ids it declares. It does not start, inspect or reason about
 * employees — that is the employee layer's job (shared/contracts.ts). A
 * declaration here means "this employee says it can use X"; whether a given use
 * is allowed is the matrix's answer, and whether X actually works is the
 * registry's.
 *
 * ── KAI works with zero employees ────────────────────────────────────────────
 * A capability whose `provider` is "kai" is held directly by KAI; when none of
 * them need an employee, `resolve` returns KAI itself. That is what keeps the
 * control plane usable before a single employee is installed (brief Part M).
 *
 * ── The planner is an abstraction, not an optimiser ──────────────────────────
 * `plan` answers one question with a direct, readable loop: for each available
 * employee that declares the capability, take the *tightest* grant that still
 * covers the required risk, and choose the employee with the smallest such
 * ceiling (ties broken by employee id, so the result is deterministic). It
 * hard-codes nothing about browser, shell or any particular capability; adding
 * one is registration, not a code change here. Sophisticated scheduling is
 * deliberately out of scope.
 */

import {
  isEmployeeState,
  isNonEmptyString,
  isRecord,
  type Capability,
  type CapabilityGrant,
  type CapabilityId,
  type EmployeeState,
  type RiskLevel,
} from "../shared/contracts.ts";
import {
  createCapabilityRegistry,
  kaiError,
  riskRank,
  isRiskLevel,
  type CapabilityRegistration,
  type CapabilityRegistry,
  type CapabilityResult,
  type CapabilityStatus,
} from "./registry.ts";
import {
  createCapabilityMatrix,
  type CapabilityMatrix,
  type CapabilityUse,
  type PermissionDecision,
} from "./matrix.ts";

/**
 * The slice of an employee the capability manager needs. Deliberately small so
 * this module has no edge into the employee layer: whoever owns that layer feeds
 * the mapping in (registerEmployee / unregisterEmployee), and the lead wires it.
 */
export interface EmployeeView {
  id: string;
  state: EmployeeState;
  /** Capability ids this employee declares it can use. Declared, not trusted. */
  capabilities: readonly CapabilityId[];
}

/** An employee is "available" only while it is READY. Anything less is not. */
export function isEmployeeAvailable(state: EmployeeState): boolean {
  return state === "READY";
}

export interface CapabilityPlanRequest {
  capabilityId: CapabilityId;
  /** The most dangerous action the work needs. */
  risk: RiskLevel;
  /** Where the work happens. Explicit; there is no default scope. */
  scope: CapabilityGrant["scope"];
  scopeId?: string;
}

/**
 * The planning answer. `via` names who can actually do it: KAI itself for a
 * direct capability, an employee otherwise. A failure carries a reason rather
 * than a bare `null`, so callers can tell the user *why* nothing can do the job.
 */
export type CapabilityPlan =
  | {
      ok: true;
      via: "employee";
      employeeId: string;
      capabilityId: CapabilityId;
      risk: RiskLevel;
      /** The ceiling of the grant that will be used — the minimum that covers `risk`. */
      authority: RiskLevel;
      grant: CapabilityGrant;
      reason: string;
    }
  | { ok: true; via: "kai"; capabilityId: CapabilityId; risk: RiskLevel; reason: string }
  | { ok: false; reason: string };

/** Whether KAI can use one of its own direct capabilities right now. */
export type DirectUse =
  | { ok: true; capabilityId: CapabilityId; risk: RiskLevel; reason: string }
  | { ok: false; reason: string };

export interface CapabilityManager {
  readonly registry: CapabilityRegistry;
  readonly matrix: CapabilityMatrix;

  // Registry passthrough — the catalogue.
  register(registration: CapabilityRegistration): CapabilityResult<Capability>;
  unregister(id: CapabilityId): CapabilityResult<true>;
  get(id: CapabilityId): Capability | undefined;
  list(): Capability[];
  status(id: CapabilityId): CapabilityStatus | undefined;
  checkHealth(id: CapabilityId): Promise<CapabilityStatus | undefined>;
  checkAllHealth(): Promise<Record<CapabilityId, CapabilityStatus>>;

  // Employee ↔ capability mapping, both directions.
  registerEmployee(employee: EmployeeView): CapabilityResult<EmployeeView>;
  unregisterEmployee(id: string): CapabilityResult<true>;
  employee(id: string): EmployeeView | undefined;
  employees(): EmployeeView[];
  capabilitiesOf(employeeId: string): CapabilityId[];
  employeesDeclaring(capabilityId: CapabilityId): EmployeeView[];
  availableProviders(capabilityId: CapabilityId): EmployeeView[];

  // Permission matrix.
  grant(grant: CapabilityGrant): CapabilityResult<CapabilityGrant>;
  revoke(grant: CapabilityGrant): CapabilityResult<true>;
  grants(): CapabilityGrant[];
  checkUse(use: CapabilityUse): PermissionDecision;

  // Planning.
  plan(request: CapabilityPlanRequest): CapabilityPlan;
  /** KAI's own direct use of a capability it holds (provider "kai"). */
  kaiDirect(capabilityId: CapabilityId): DirectUse;
  /** KAI-direct when it can, otherwise the minimum-authority employee. */
  resolve(request: CapabilityPlanRequest): CapabilityPlan;
}

function validateEmployee(value: unknown): string | null {
  if (!isRecord(value)) return "employee view must be an object";
  if (!isNonEmptyString(value.id)) return "employee view requires a non-empty id";
  if (!isEmployeeState(value.state)) return `employee "${value.id}" has an unrecognized state`;
  if (!Array.isArray(value.capabilities)) {
    return `employee "${value.id}" capabilities must be an array of capability ids`;
  }
  for (const capability of value.capabilities) {
    if (!isNonEmptyString(capability)) {
      return `employee "${value.id}" capabilities must all be non-empty strings`;
    }
  }
  return null;
}

export function createCapabilityManager(
  opts: {
    registry?: CapabilityRegistry;
    matrix?: CapabilityMatrix;
    now?: () => Date;
  } = {},
): CapabilityManager {
  const now = opts.now ?? (() => new Date());
  const registry = opts.registry ?? createCapabilityRegistry({ now });
  const matrix = opts.matrix ?? createCapabilityMatrix({ now });

  const employees = new Map<string, EmployeeView>();

  function registerEmployee(employee: EmployeeView): CapabilityResult<EmployeeView> {
    const reason = validateEmployee(employee);
    if (reason !== null) {
      return { ok: false, error: kaiError("VALIDATION_FAILED", reason, now) };
    }
    // Unlike a capability *definition*, an employee is live state whose snapshot
    // changes (READY -> DEGRADED -> READY). Re-registering updates the snapshot;
    // it is not an overwrite hazard, it is how state transitions are reported.
    const deduped = [...new Set(employee.capabilities)];
    const stored: EmployeeView = { id: employee.id, state: employee.state, capabilities: deduped };
    employees.set(employee.id, stored);
    return { ok: true, value: { ...stored, capabilities: [...deduped] } };
  }

  function unregisterEmployee(id: string): CapabilityResult<true> {
    if (!employees.delete(id)) {
      return { ok: false, error: kaiError("NOT_FOUND", `employee "${id}" is not known`, now) };
    }
    return { ok: true, value: true };
  }

  function employee(id: string): EmployeeView | undefined {
    return employees.get(id);
  }

  function employeesList(): EmployeeView[] {
    return [...employees.values()];
  }

  /** Which capabilities this employee declares. Empty for an unknown employee. */
  function capabilitiesOf(employeeId: string): CapabilityId[] {
    return [...(employees.get(employeeId)?.capabilities ?? [])];
  }

  /** The forward answer: every employee, regardless of state, that declares it. */
  function employeesDeclaring(capabilityId: CapabilityId): EmployeeView[] {
    return [...employees.values()].filter((entry) => entry.capabilities.includes(capabilityId));
  }

  /**
   * The reverse answer the planner needs: employees that declare the capability
   * *and* are ready to use it. State filters here; capability availability is
   * plan's job, so a READY employee is still returned for a DEGRADED capability.
   */
  function availableProviders(capabilityId: CapabilityId): EmployeeView[] {
    return employeesDeclaring(capabilityId).filter((entry) => isEmployeeAvailable(entry.state));
  }

  function kaiDirect(capabilityId: CapabilityId): DirectUse {
    const capability = registry.get(capabilityId);
    if (capability === undefined) {
      return { ok: false, reason: `no capability "${capabilityId}" is registered` };
    }
    if (capability.provider !== "kai") {
      return {
        ok: false,
        reason: `capability "${capabilityId}" is provided by employee "${capability.provider}", not directly by KAI`,
      };
    }
    const status = registry.status(capabilityId);
    if (status === undefined || status.availability !== "AVAILABLE") {
      return {
        ok: false,
        reason: `capability "${capabilityId}" is ${status?.availability ?? "unknown"}; KAI cannot use it directly`,
      };
    }
    return {
      ok: true,
      capabilityId,
      risk: capability.risk,
      reason: `KAI holds capability "${capabilityId}" directly (risk ${capability.risk}); the use itself is still subject to the policy gate`,
    };
  }

  function plan(request: CapabilityPlanRequest): CapabilityPlan {
    const capability = registry.get(request.capabilityId);
    if (capability === undefined) {
      return { ok: false, reason: `no capability "${request.capabilityId}" is registered` };
    }
    if (!isRiskLevel(request.risk)) {
      return { ok: false, reason: `unrecognized required risk ${JSON.stringify(request.risk)}` };
    }

    // An unhealthy capability is never planned onto, however healthy its
    // employees are. Only AVAILABLE counts; DEGRADED/UNAVAILABLE/DISABLED do not.
    const status = registry.status(request.capabilityId);
    if (status === undefined || status.availability !== "AVAILABLE") {
      return {
        ok: false,
        reason: `capability "${request.capabilityId}" is ${status?.availability ?? "unknown"}${
          status?.detail !== undefined ? ` (${status.detail})` : ""
        } and cannot be used`,
      };
    }

    const candidates = availableProviders(request.capabilityId);
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: `no available employee declares capability "${request.capabilityId}"`,
      };
    }

    let best:
      | { employeeId: string; grant: CapabilityGrant; authority: RiskLevel }
      | undefined;

    for (const candidate of candidates) {
      const decision = matrix.checkUse({
        employeeId: candidate.id,
        capabilityId: request.capabilityId,
        risk: request.risk,
        scope: request.scope,
        ...(request.scopeId !== undefined ? { scopeId: request.scopeId } : {}),
      });
      if (!decision.allowed || decision.grant === undefined || decision.authority === undefined) {
        continue;
      }
      const authority = decision.authority;
      // Minimum necessary authority: the smallest ceiling that still covers the
      // required risk. Equal ceilings are broken by employee id so the choice is
      // stable across calls.
      const better =
        best === undefined ||
        riskRank(authority) < riskRank(best.authority) ||
        (riskRank(authority) === riskRank(best.authority) && candidate.id < best.employeeId);
      if (better) best = { employeeId: candidate.id, grant: decision.grant, authority };
    }

    if (best === undefined) {
      return {
        ok: false,
        reason: `no available employee holding a grant can use "${request.capabilityId}" at ${request.risk} in scope ${request.scope}`,
      };
    }

    return {
      ok: true,
      via: "employee",
      employeeId: best.employeeId,
      capabilityId: request.capabilityId,
      risk: request.risk,
      authority: best.authority,
      grant: best.grant,
      reason: `employee "${best.employeeId}" can use "${request.capabilityId}" at ${request.risk} with the least authority that suffices (${best.authority})`,
    };
  }

  function resolve(request: CapabilityPlanRequest): CapabilityPlan {
    const capability = registry.get(request.capabilityId);
    if (capability === undefined) {
      return { ok: false, reason: `no capability "${request.capabilityId}" is registered` };
    }
    // Direct capabilities need no employee. If KAI holds it, KAI can use it —
    // the policy gate still decides whether the risk needs approval.
    if (capability.provider === "kai") {
      const direct = kaiDirect(request.capabilityId);
      if (direct.ok) {
        return {
          ok: true,
          via: "kai",
          capabilityId: request.capabilityId,
          risk: capability.risk,
          reason: direct.reason,
        };
      }
      return { ok: false, reason: direct.reason };
    }
    return plan(request);
  }

  return {
    registry,
    matrix,
    register: (registration) => registry.register(registration),
    unregister: (id) => registry.unregister(id),
    get: (id) => registry.get(id),
    list: () => registry.list(),
    status: (id) => registry.status(id),
    checkHealth: (id) => registry.checkHealth(id),
    checkAllHealth: () => registry.checkAllHealth(),

    registerEmployee,
    unregisterEmployee,
    employee,
    employees: employeesList,
    capabilitiesOf,
    employeesDeclaring,
    availableProviders,

    grant: (grant) => matrix.grant(grant),
    revoke: (grant) => matrix.revoke(grant),
    grants: () => matrix.grants(),
    checkUse: (use) => matrix.checkUse(use),

    plan,
    kaiDirect,
    resolve,
  };
}

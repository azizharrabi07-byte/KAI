// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * manager.ts — the Workforce Manager.
 *
 * This is the layer ABOVE `core/src/agents/registry.ts`, and it is deliberately
 * not a rename of it. The agent registry catalogues *protocol adapters* and fans
 * lifecycle calls out to them. The workforce manager owns *employees*: it knows
 * each employee's lifecycle state, whether it is enabled, what role it holds,
 * which capabilities it is granted at what risk, and which one should do a piece
 * of work. The adapters stay exactly as they are — an employee's instance may
 * carry one, and the manager will use it to delegate — but the manager never
 * replaces them and never speaks their port protocol.
 *
 * ── The three invariants that make it safe to run unattended ──────────────────
 *
 *  1. ERRORS AND ABSENT EMPLOYEES ARE VALUES. A missing employee, a `create()`
 *     that throws, a dead health probe, a delegation to nothing — every one of
 *     these returns a result object. None of them throws up into KAI. (Spec Part
 *     M: a missing worker must never take KAI down.)
 *
 *  2. DUPLICATE REGISTRATION LOSES NOTHING. Re-registering the same descriptor
 *     is an idempotent success; registering a *different* employee under an id
 *     that is already taken is refused (a value) and the first registration —
 *     with its instance — stays intact. Auto-registered discovery placeholders
 *     may be upgraded by a real registration; a real one never is.
 *
 *  3. ILLEGAL LIFECYCLE MOVES ARE REFUSED, NOT APPLIED. Every state change goes
 *     through `lifecycle.ts`; a move the table forbids comes back as a value.
 *
 * Everything is injected (discovery, trusted sources, installer, event sink) so
 * the runtime's composition root does the wiring and this file has no knowledge
 * of where its collaborators came from.
 */

import { isNonEmptyString, isRecord } from "../shared/contracts.ts";
import type {
  AgentCapability,
  AgentTaskResult,
  CapabilityGrant,
  CapabilityId,
  EmployeeDescriptor,
  EmployeeInstance,
  EmployeeSnapshot,
  EmployeeState,
  KaiError,
  RiskLevel,
} from "../shared/contracts.ts";
import type { EmployeeKind } from "../shared/runtime-events.ts";
import {
  createLifecycle,
  employeeError,
  isLegalTransition,
  legalTransitions,
  transitionPath,
} from "./lifecycle.ts";
import type { EmployeeLifecycle, TransitionResult } from "./lifecycle.ts";
import { describeError, makeSnapshot } from "./employee.ts";
import { descriptorForDiscovery } from "./discovery.ts";
import type {
  Discovery,
  DiscoveryResult,
  EmployeeInstaller,
  InstallDecision,
  InstallPlan,
  TrustedSourceRegistry,
} from "./discovery.ts";

// ── Result shapes ─────────────────────────────────────────────────────────────

/** The common shape of "something happened to an employee". Never thrown. */
export interface OperationResult {
  ok: boolean;
  employeeId: string;
  state: EmployeeState;
  changed?: boolean;
  detail?: string;
  error?: KaiError;
}

export interface RegistrationResult {
  ok: boolean;
  employeeId: string;
  state: EmployeeState;
  /** True when this id was already registered. */
  duplicate?: boolean;
  /** True when a discovery placeholder was upgraded by a real registration. */
  replacedPlaceholder?: boolean;
  error?: KaiError;
}

export interface HealthCheckResult {
  ok: boolean;
  employeeId: string;
  state: EmployeeState;
  snapshot?: EmployeeSnapshot;
  error?: KaiError;
}

export interface DelegationRequest {
  /** KAI's own id for the work, so a run traces back to a mission step. */
  taskId: string;
  input: string;
  /** Required agent capability; defaults to "run_task". */
  capability?: AgentCapability;
  role?: string;
  allowDegraded?: boolean;
  options?: Record<string, unknown>;
}

export interface DelegationResult {
  ok: boolean;
  taskId: string;
  employeeId?: string;
  instanceId?: string;
  state?: EmployeeState;
  result?: AgentTaskResult;
  error?: KaiError;
}

export interface EmployeeHandle {
  employeeId: string;
  instanceId?: string;
  kind: EmployeeKind;
  state: EmployeeState;
  role?: string;
}

export interface SelectionCriteria {
  /** A declared employee capability id (e.g. "browser", "shell"). */
  capabilityId?: CapabilityId;
  role?: string;
  /** Allow DEGRADED employees when no READY one is acceptable; default false. */
  allowDegraded?: boolean;
}

/** The workforce's answer to "describe this employee" — one flat, renderable row. */
export interface EmployeeDescription {
  id: string;
  name: string;
  kind: EmployeeKind;
  version?: string;
  description?: string;
  origin: string;
  state: EmployeeState;
  enabled: boolean;
  /** True when this row came from discovery and has no adapter wired yet. */
  placeholder: boolean;
  role?: string;
  capabilities: readonly CapabilityId[];
  grants: readonly CapabilityGrant[];
  config: Readonly<Record<string, unknown>>;
  instanceId?: string;
  snapshot?: EmployeeSnapshot;
  problems: readonly string[];
  history: readonly EmployeeState[];
}

export interface WorkforceManager {
  // ── registration ──
  register(descriptor: EmployeeDescriptor, options?: { placeholder?: boolean; kind?: EmployeeKind }): RegistrationResult;
  unregister(employeeId: string): boolean;
  has(employeeId: string): boolean;
  get(employeeId: string): EmployeeDescriptor | undefined;
  list(): EmployeeDescription[];
  describe(employeeId?: string): EmployeeDescription[];

  // ── discovery ──
  observe(result: DiscoveryResult): RegistrationResult;
  discover(sourceId?: string): Promise<RegistrationResult[]>;

  // ── lifecycle operations ──
  install(employeeId: string, request?: { package?: string }): Promise<OperationResult>;
  authenticate(employeeId: string): Promise<OperationResult>;
  configure(employeeId: string, config: Record<string, unknown>): OperationResult;
  healthCheck(employeeId: string): Promise<HealthCheckResult>;
  monitor(): Promise<HealthCheckResult[]>;
  enable(employeeId: string): Promise<OperationResult>;
  disable(employeeId: string): Promise<OperationResult>;
  remove(employeeId: string): Promise<OperationResult>;
  recover(employeeId: string): Promise<OperationResult>;

  // ── role and permissions ──
  assignRole(employeeId: string, role: string): OperationResult;
  grant(employeeId: string, grant: Omit<CapabilityGrant, "employeeId">): OperationResult;
  revoke(employeeId: string, capabilityId: CapabilityId, scope?: CapabilityGrant["scope"], scopeId?: string): boolean;
  permissions(employeeId: string): CapabilityGrant[];

  // ── selection and delegation ──
  select(criteria?: SelectionCriteria): EmployeeHandle | null;
  available(criteria?: SelectionCriteria): EmployeeHandle[];
  delegate(request: DelegationRequest): Promise<DelegationResult>;
}

export interface WorkforceManagerOptions {
  onEvent?: (type: string, payload: unknown) => void;
  discovery?: Discovery;
  sources?: TrustedSourceRegistry;
  installer?: EmployeeInstaller;
  /**
   * Runs a delegated task THROUGH the policy-governed boundary.
   *
   * Required for `delegate()`. Without it the manager would have to call the
   * adapter directly, and a direct adapter call skips validate -> policy ->
   * approval — the one bypass Phase 1 exists to eliminate, and the same class of
   * hole as the old `/agents/:id/action` route. So the manager refuses rather than
   * executing unsupervised.
   */
  executeTask?: (input: {
    employeeId: string;
    capability: string;
    taskId: string;
    input: string;
    options?: Record<string, unknown>;
  }) => Promise<AgentTaskResult>;
}

// ── Internal record ───────────────────────────────────────────────────────────

interface WorkforceRecord {
  descriptor: EmployeeDescriptor;
  kind: EmployeeKind;
  lifecycle: EmployeeLifecycle;
  placeholder: boolean;
  role?: string;
  config: Record<string, unknown>;
  grants: CapabilityGrant[];
  capabilities: CapabilityId[];
  problems: string[];
  version?: string;
  lastSnapshot?: EmployeeSnapshot;
  instance?: EmployeeInstance;
  instancePromise?: Promise<EmployeeInstance | null>;
  /** The state to return to on enable, remembered from the disable. */
  previousState?: EmployeeState;
}

const RISK_LEVELS: readonly RiskLevel[] = ["READ", "WRITE", "EXTERNAL", "DESTRUCTIVE"];
const GRANT_SCOPES: readonly CapabilityGrant["scope"][] = ["thread", "mission", "employee", "global"];

function grantKey(employeeId: string, grant: Pick<CapabilityGrant, "capabilityId" | "scope" | "scopeId">): string {
  return `${employeeId}|${grant.capabilityId}|${grant.scope}|${grant.scopeId ?? ""}`;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createWorkforceManager(options: WorkforceManagerOptions = {}): WorkforceManager {
  const records = new Map<string, WorkforceRecord>();
  const discovery = options.discovery;
  const sources = options.sources;
  const installer = options.installer;
  const executeTask = options.executeTask;
  const onEvent = options.onEvent;

  /** An observer must never break a workforce operation. */
  function emit(type: string, payload: unknown): void {
    if (onEvent === undefined) return;
    try {
      onEvent(type, payload);
    } catch {
      /* the sink is the sink's problem */
    }
  }

  function newRecord(descriptor: EmployeeDescriptor, kind: EmployeeKind, placeholder: boolean): WorkforceRecord {
    return {
      descriptor,
      kind,
      placeholder,
      lifecycle: createLifecycle("DISCOVERED"),
      config: {},
      grants: [],
      capabilities: [...descriptor.metadata.capabilities],
      problems: [],
      ...(descriptor.metadata.version !== undefined ? { version: descriptor.metadata.version } : {}),
    };
  }

  /**
   * Apply a *direct* transition. This is what explicit user operations use: if
   * the table does not allow the exact move, it is refused. No clever routing —
   * "disable" that quietly resurrects a REMOVED employee would be a surprise.
   */
  function transitionDirect(rec: WorkforceRecord, target: EmployeeState): TransitionResult {
    const from = rec.lifecycle.state();
    const result = rec.lifecycle.apply(target);
    if (result.ok && result.changed) {
      emit("workforce.state_changed", { employeeId: rec.descriptor.metadata.id, from, to: target });
    }
    return result;
  }

  /**
   * Apply the shortest *legal route* to a target state. Used where KAI learns
   * the world's truth (health, discovery): a probe that finds a DISCOVERED
   * employee healthy needs DISCOVERED -> INSTALLED -> READY, and that route is
   * derived from the table rather than special-cased here.
   */
  function transitionVia(rec: WorkforceRecord, target: EmployeeState): TransitionResult {
    const from = rec.lifecycle.state();
    if (from === target) return { ok: true, from, to: target, changed: false };
    const path = transitionPath(from, target);
    if (path === null) {
      return {
        ok: false,
        from,
        to: target,
        changed: false,
        error: employeeError(
          "VALIDATION_FAILED",
          `cannot move "${rec.descriptor.metadata.id}" from ${from} to ${target}`,
          `from ${from} the legal targets are: ${legalTransitions(from).join(", ") || "(none)"}`,
        ),
      };
    }
    for (const step of path) {
      const result = rec.lifecycle.apply(step);
      if (!result.ok) return result;
    }
    emit("workforce.state_changed", { employeeId: rec.descriptor.metadata.id, from, to: target, via: path });
    return { ok: true, from, to: target, changed: true };
  }

  /**
   * Start the employee's instance exactly once. The in-flight promise guard is
   * what makes "no duplicate instances" true under concurrent callers, and the
   * try/catch is what makes a `create()` that throws a value rather than a crash.
   */
  async function ensureInstanceImpl(rec: WorkforceRecord): Promise<EmployeeInstance | null> {
    if (rec.instance !== undefined) return rec.instance;
    if (rec.instancePromise !== undefined) return rec.instancePromise;
    const id = rec.descriptor.metadata.id;
    const pending = (async (): Promise<EmployeeInstance | null> => {
      try {
        const created = await rec.descriptor.create({ instanceId: `${id}#1` });
        if (
          created === null ||
          typeof created !== "object" ||
          typeof created.snapshot !== "function" ||
          typeof created.dispose !== "function"
        ) {
          rec.problems = ["create() did not return a usable employee instance"];
          return null;
        }
        rec.instance = created;
        return created;
      } catch (error) {
        rec.problems = [`create() failed: ${describeError(error)}`];
        return null;
      } finally {
        rec.instancePromise = undefined;
      }
    })();
    rec.instancePromise = pending;
    return pending;
  }

  async function disposeInstance(rec: WorkforceRecord): Promise<void> {
    const instance = rec.instance;
    rec.instance = undefined;
    rec.instancePromise = undefined;
    if (instance !== undefined) {
      try {
        await instance.dispose();
      } catch {
        /* dispose must never take down the caller */
      }
    }
  }

  function descriptionOf(rec: WorkforceRecord): EmployeeDescription {
    const meta = rec.descriptor.metadata;
    const state = rec.lifecycle.state();
    const version = rec.version ?? meta.version;
    return {
      id: meta.id,
      name: meta.name,
      kind: rec.kind,
      ...(version !== undefined ? { version } : {}),
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      origin: meta.origin,
      state,
      enabled: state !== "DISABLED" && state !== "REMOVED",
      placeholder: rec.placeholder,
      ...(rec.role !== undefined ? { role: rec.role } : {}),
      capabilities: [...rec.capabilities],
      grants: rec.grants.map((grant) => ({ ...grant })),
      config: { ...rec.config },
      ...(rec.instance !== undefined ? { instanceId: rec.instance.instanceId } : {}),
      ...(rec.lastSnapshot !== undefined ? { snapshot: rec.lastSnapshot } : {}),
      problems: [...rec.problems],
      history: rec.lifecycle.history(),
    };
  }

  function notFound(employeeId: string): OperationResult {
    return {
      ok: false,
      employeeId,
      state: "UNAVAILABLE",
      error: employeeError("NOT_FOUND", `no employee is registered as "${employeeId}"`),
    };
  }

  // ── Registration ─────────────────────────────────────────────────────────────

  function registerImpl(
    descriptor: EmployeeDescriptor,
    opts: { placeholder?: boolean; kind?: EmployeeKind } = {},
  ): RegistrationResult {
    const candidate = descriptor as unknown;
    if (!isRecord(candidate) || !isRecord((candidate as { metadata?: unknown }).metadata)) {
      return {
        ok: false,
        employeeId: "",
        state: "UNAVAILABLE",
        error: employeeError("VALIDATION_FAILED", "an employee descriptor needs metadata"),
      };
    }
    const meta = (candidate as { metadata: Record<string, unknown> }).metadata;
    if (!isNonEmptyString(meta.id) || !isNonEmptyString(meta.name)) {
      return {
        ok: false,
        employeeId: typeof meta.id === "string" ? meta.id : "",
        state: "UNAVAILABLE",
        error: employeeError("VALIDATION_FAILED", "an employee needs a non-empty id and name"),
      };
    }
    const id = meta.id;
    const placeholder = opts.placeholder === true;
    const existing = records.get(id);

    if (existing !== undefined) {
      if (existing.descriptor === descriptor) {
        // The same object registered twice is an idempotent success.
        return { ok: true, employeeId: id, state: existing.lifecycle.state(), duplicate: true };
      }
      if (existing.placeholder && !placeholder) {
        // A real registration upgrades a discovery stub. Stubs exist only to make
        // an un-wired employee observable, so replacing one loses nothing.
        const stale = existing.instance;
        if (stale !== undefined) void stale.dispose().catch(() => undefined);
        records.set(id, newRecord(descriptor, opts.kind ?? existing.kind, false));
        emit("workforce.registered", { employeeId: id, name: meta.name, replacedPlaceholder: true });
        return { ok: true, employeeId: id, state: "DISCOVERED", replacedPlaceholder: true };
      }
      if (existing.placeholder && placeholder) {
        return { ok: true, employeeId: id, state: existing.lifecycle.state(), duplicate: true };
      }
      // Different descriptor under a taken id: refuse, keep the first intact.
      return {
        ok: false,
        employeeId: id,
        state: existing.lifecycle.state(),
        duplicate: true,
        error: employeeError(
          "VALIDATION_FAILED",
          `employee "${id}" is already registered`,
          `registered as "${existing.descriptor.metadata.name}"; unregister it first to replace it`,
        ),
      };
    }

    records.set(id, newRecord(descriptor, opts.kind ?? id, placeholder));
    emit("workforce.registered", { employeeId: id, name: meta.name, placeholder });
    return { ok: true, employeeId: id, state: "DISCOVERED" };
  }

  function unregisterImpl(employeeId: string): boolean {
    const rec = records.get(employeeId);
    if (rec === undefined) return false;
    records.delete(employeeId);
    const instance = rec.instance;
    if (instance !== undefined) void instance.dispose().catch(() => undefined);
    emit("workforce.unregistered", { employeeId });
    return true;
  }

  // ── Discovery ────────────────────────────────────────────────────────────────

  /**
   * Fold a discovery result into the workforce. If nothing is registered for the
   * id yet, a placeholder descriptor is created so the employee is observable;
   * if the lead already registered a real one, only its state/capabilities move.
   * Never returns a failure: discovery is observation, not an operation that can
   * be rejected. DISABLED and REMOVED are respected — observation must not undo
   * a user's intent.
   */
  function observeImpl(result: DiscoveryResult): RegistrationResult {
    let rec = records.get(result.employeeId);
    if (rec === undefined) {
      const registered = registerImpl(descriptorForDiscovery(result), {
        placeholder: true,
        kind: result.kind,
      });
      if (!registered.ok) return registered;
      rec = records.get(result.employeeId);
      if (rec === undefined) return registered;
    }

    rec.capabilities = [...new Set([...rec.capabilities, ...result.capabilities])];
    rec.problems = [...result.problems];
    if (result.version !== undefined) rec.version = result.version;
    rec.lastSnapshot = makeSnapshot(result.state, {
      reachable: result.reachable,
      authenticated: result.authenticated,
      ...(result.version !== undefined ? { version: result.version } : {}),
      problems: result.problems,
    });

    const current = rec.lifecycle.state();
    if (current === "DISABLED" || current === "REMOVED") {
      return { ok: true, employeeId: result.employeeId, state: current };
    }
    const moved = transitionVia(rec, result.state);
    if (!moved.ok) {
      // A placeholder can only go DISCOVERED -> READY/DEGRADED/UNAVAILABLE, all of
      // which are legal, so this is belt-and-braces: report, never throw.
      emit("workforce.observe_refused", { employeeId: result.employeeId, error: moved.error });
      return { ok: true, employeeId: result.employeeId, state: current };
    }
    emit("workforce.observed", {
      employeeId: result.employeeId,
      state: moved.to,
      installed: result.installed,
      reachable: result.reachable,
    });
    return { ok: true, employeeId: result.employeeId, state: moved.to };
  }

  async function discoverImpl(sourceId?: string): Promise<RegistrationResult[]> {
    if (discovery === undefined) return [];
    const results = await discovery.scan(sourceId);
    return results.map((result) => observeImpl(result));
  }

  // ── Lifecycle operations ─────────────────────────────────────────────────────

  /**
   * Install. The policy boundary is checked FIRST, before any state moves: an
   * untrusted source or a URL-shaped package is refused and the employee is left
   * exactly as it was. Only then does the lifecycle go DISCOVERED -> INSTALLING.
   * No auto-installer is wired in Phase 1, so a trusted source with no installer
   * ends UNAVAILABLE with the manual instruction attached — a value, not a throw.
   */
  async function installImpl(employeeId: string, request: { package?: string } = {}): Promise<OperationResult> {
    const rec = records.get(employeeId);
    if (rec === undefined) return notFound(employeeId);

    const decision: InstallDecision = sources
      ? sources.authorizeInstall({
          sourceId: employeeId,
          ...(request.package !== undefined ? { package: request.package } : {}),
        })
      : {
          allowed: false,
          reason: "installation is disabled: no trusted-source registry is configured",
          error: employeeError("POLICY_DENIED", "installation is disabled: no trusted-source registry is configured"),
        };
    if (!decision.allowed) {
      emit("workforce.install_refused", { employeeId, reason: decision.reason });
      return { ok: false, employeeId, state: rec.lifecycle.state(), error: decision.error };
    }

    const toInstalling = transitionVia(rec, "INSTALLING");
    if (!toInstalling.ok) {
      return { ok: false, employeeId, state: rec.lifecycle.state(), error: toInstalling.error };
    }

    const plan: InstallPlan = {
      employeeId,
      source: decision.source,
      ...(decision.install !== undefined ? { install: decision.install } : {}),
    };

    if (installer === undefined || !installer.canInstall(plan)) {
      transitionDirect(rec, "UNAVAILABLE");
      return {
        ok: false,
        employeeId,
        state: rec.lifecycle.state(),
        error: employeeError(
          "INTERNAL",
          `no installer is configured for "${employeeId}"`,
          decision.install?.instructions ?? "install it manually, then re-run discovery",
        ),
      };
    }

    let result: { ok: boolean; detail?: string };
    try {
      result = await installer.install(plan);
    } catch (error) {
      result = { ok: false, detail: describeError(error) };
    }
    if (result.ok) {
      transitionDirect(rec, "INSTALLED");
      emit("workforce.installed", { employeeId });
      return { ok: true, employeeId, state: rec.lifecycle.state(), changed: true };
    }
    transitionDirect(rec, "UNAVAILABLE");
    return {
      ok: false,
      employeeId,
      state: rec.lifecycle.state(),
      error: employeeError("INTERNAL", `install of "${employeeId}" failed`, result.detail),
    };
  }

  /**
   * Authenticate. There is no credential surface in the contract — the employee's
   * own snapshot reports `authenticated` — so this is: enter AUTHENTICATING, ask
   * the employee what it now is, and land READY / DEGRADED / UNAVAILABLE from that
   * answer. An employee whose probe already reports authenticated never leaves
   * READY.
   */
  async function authenticateImpl(employeeId: string): Promise<OperationResult> {
    const rec = records.get(employeeId);
    if (rec === undefined) return notFound(employeeId);
    if (rec.lifecycle.state() === "READY") {
      return { ok: true, employeeId, state: "READY", changed: false, detail: "already ready" };
    }
    const toAuthenticating = transitionDirect(rec, "AUTHENTICATING");
    if (!toAuthenticating.ok) {
      return { ok: false, employeeId, state: rec.lifecycle.state(), error: toAuthenticating.error };
    }

    const checked = await healthCheckImpl(employeeId);
    const snapshot = checked.snapshot;
    let target: EmployeeState = "UNAVAILABLE";
    if (snapshot !== undefined) {
      if (!snapshot.reachable) target = "UNAVAILABLE";
      else if (snapshot.state === "READY") target = "READY";
      else if (snapshot.authenticated) target = "READY";
      else target = "DEGRADED";
    }
    const moved = transitionDirect(rec, target);
    return {
      ok: moved.ok && target === "READY",
      employeeId,
      state: rec.lifecycle.state(),
      changed: moved.changed,
      ...(moved.ok ? {} : { error: moved.error }),
    };
  }

  function configureImpl(employeeId: string, config: Record<string, unknown>): OperationResult {
    const rec = records.get(employeeId);
    if (rec === undefined) return notFound(employeeId);
    if (isRecord(config)) rec.config = { ...rec.config, ...config };
    emit("workforce.configured", { employeeId, keys: Object.keys(rec.config) });
    return { ok: true, employeeId, state: rec.lifecycle.state(), changed: true };
  }

  /** Observe the employee's real health and move its state to match. Never throws. */
  async function healthCheckImpl(employeeId: string): Promise<HealthCheckResult> {
    const rec = records.get(employeeId);
    if (rec === undefined) {
      return { ok: false, employeeId, state: "UNAVAILABLE", error: employeeError("NOT_FOUND", `no employee is registered as "${employeeId}"`) };
    }

    const instance = await ensureInstanceImpl(rec);
    let snapshot: EmployeeSnapshot;
    if (instance === null) {
      snapshot = makeSnapshot("UNAVAILABLE", {
        reachable: false,
        authenticated: false,
        problems: rec.problems.length > 0 ? [...rec.problems] : ["no instance could be created"],
      });
    } else {
      try {
        snapshot = await instance.snapshot();
      } catch (error) {
        snapshot = makeSnapshot("UNAVAILABLE", { reachable: false, authenticated: false, problems: [describeError(error)] });
      }
    }
    rec.lastSnapshot = snapshot;
    if (snapshot.version !== undefined) rec.version = snapshot.version;

    const current = rec.lifecycle.state();
    // A user's DISABLED/REMOVED intent is never undone by a health probe. Without
    // this, a monitor sweep would silently re-enable a disabled employee.
    if (current !== "DISABLED" && current !== "REMOVED") {
      // Route via the table: a healthy probe on a fresh DISCOVERED employee must
      // pass through INSTALLED to become READY rather than being refused.
      transitionVia(rec, snapshot.state);
    }
    emit("workforce.health_checked", { employeeId, state: rec.lifecycle.state(), snapshot });
    return { ok: snapshot.state === "READY", employeeId, state: rec.lifecycle.state(), snapshot };
  }

  async function monitorImpl(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];
    for (const id of records.keys()) {
      try {
        results.push(await healthCheckImpl(id));
      } catch (error) {
        // healthCheckImpl already guards; this is the final backstop so one
        // employee can never abort the sweep.
        results.push({
          ok: false,
          employeeId: id,
          state: "UNAVAILABLE",
          error: employeeError("INTERNAL", `health sweep failed for "${id}"`, describeError(error)),
        });
      }
    }
    return results;
  }

  /** Re-enable a DISABLED employee, restoring the state it was disabled from. */
  async function enableImpl(employeeId: string): Promise<OperationResult> {
    const rec = records.get(employeeId);
    if (rec === undefined) return notFound(employeeId);
    const current = rec.lifecycle.state();
    if (current === "REMOVED") {
      return {
        ok: false,
        employeeId,
        state: current,
        error: employeeError("VALIDATION_FAILED", `employee "${employeeId}" was removed; re-register it instead`),
      };
    }
    if (current !== "DISABLED") {
      return { ok: true, employeeId, state: current, changed: false, detail: "employee is not disabled" };
    }
    const desired = rec.previousState ?? "READY";
    const target = isLegalTransition("DISABLED", desired) ? desired : "INSTALLED";
    const moved = transitionDirect(rec, target);
    if (!moved.ok) return { ok: false, employeeId, state: current, error: moved.error };
    rec.previousState = undefined;
    emit("workforce.enabled", { employeeId, restoredTo: target });
    // "Enabled" must be a fact, not an assumption: re-observe before reporting.
    const checked = await healthCheckImpl(employeeId);
    return { ok: true, employeeId, state: rec.lifecycle.state(), changed: true, ...(checked.snapshot?.problems ? { detail: checked.snapshot.problems.join("; ") } : {}) };
  }

  /** Disable: stop it being selected for work AND stop any work it is running. */
  async function disableImpl(employeeId: string): Promise<OperationResult> {
    const rec = records.get(employeeId);
    if (rec === undefined) return notFound(employeeId);
    const current = rec.lifecycle.state();
    if (current === "DISABLED") {
      return { ok: true, employeeId, state: "DISABLED", changed: false };
    }
    if (current === "REMOVED") {
      return {
        ok: false,
        employeeId,
        state: current,
        error: employeeError("VALIDATION_FAILED", `employee "${employeeId}" was removed and cannot be disabled`),
      };
    }
    const moved = transitionDirect(rec, "DISABLED");
    if (!moved.ok) return { ok: false, employeeId, state: current, error: moved.error };
    rec.previousState = moved.from;
    emit("workforce.disabled", { employeeId, from: moved.from });

    // Selection excludes DISABLED on its own; this makes disabling mean *stopped*,
    // not merely unselectable for future work.
    const instance = rec.instance;
    if (instance !== undefined) {
      try {
        await instance.turns?.stopAll();
      } catch {
        /* best effort */
      }
      try {
        await instance.adapter?.disconnect();
      } catch {
        /* best effort */
      }
    }
    return { ok: true, employeeId, state: "DISABLED", changed: true };
  }

  /** Remove: dispose and tombstone. Only re-discovery can bring it back. */
  async function removeImpl(employeeId: string): Promise<OperationResult> {
    const rec = records.get(employeeId);
    if (rec === undefined) return notFound(employeeId);
    if (rec.lifecycle.state() === "REMOVED") {
      return { ok: true, employeeId, state: "REMOVED", changed: false };
    }
    const moved = transitionVia(rec, "REMOVED");
    if (!moved.ok) return { ok: false, employeeId, state: rec.lifecycle.state(), error: moved.error };
    await disposeInstance(rec);
    rec.grants = [];
    rec.role = undefined;
    rec.config = {};
    rec.previousState = undefined;
    rec.problems = [];
    emit("workforce.removed", { employeeId });
    return { ok: true, employeeId, state: "REMOVED", changed: true };
  }

  /**
   * Recover: throw away the possibly-poisoned instance and build a fresh one from
   * the descriptor, then re-observe. This is the "it broke, bring it back" path;
   * it is distinct from enable (which is for user intent, not failure).
   */
  async function recoverImpl(employeeId: string): Promise<OperationResult> {
    const rec = records.get(employeeId);
    if (rec === undefined) return notFound(employeeId);
    const current = rec.lifecycle.state();
    if (current === "READY") return { ok: true, employeeId, state: "READY", changed: false };
    if (current === "DISABLED") {
      return { ok: false, employeeId, state: current, error: employeeError("VALIDATION_FAILED", `employee "${employeeId}" is disabled; enable it first`) };
    }
    if (current === "REMOVED") {
      return { ok: false, employeeId, state: current, error: employeeError("VALIDATION_FAILED", `employee "${employeeId}" was removed; re-register it instead`) };
    }
    await disposeInstance(rec);
    const checked = await healthCheckImpl(employeeId);
    const ready = rec.lifecycle.state() === "READY";
    emit("workforce.recovered", { employeeId, ok: ready, state: rec.lifecycle.state() });
    return {
      ok: ready,
      employeeId,
      state: rec.lifecycle.state(),
      changed: true,
      ...(ready
        ? {}
        : {
            error: employeeError(
              "AGENT_NOT_LISTENING",
              `"${employeeId}" is still unavailable after recovery`,
              checked.snapshot?.problems?.join("; "),
            ),
          }),
    };
  }

  // ── Role and permissions ─────────────────────────────────────────────────────

  function assignRoleImpl(employeeId: string, role: string): OperationResult {
    const rec = records.get(employeeId);
    if (rec === undefined) return notFound(employeeId);
    if (!isNonEmptyString(role)) {
      return { ok: false, employeeId, state: rec.lifecycle.state(), error: employeeError("VALIDATION_FAILED", "a role must be a non-empty string") };
    }
    rec.role = role;
    emit("workforce.role_assigned", { employeeId, role });
    return { ok: true, employeeId, state: rec.lifecycle.state(), changed: true };
  }

  /**
   * Grant a capability at a risk ceiling and a scope. A grant is REPLACED when
   * the same (employee, capability, scope, scopeId) is granted again — there is
   * exactly one authority level per tuple, so "grant twice" cannot accidentally
   * widen anything.
   */
  function grantImpl(employeeId: string, grant: Omit<CapabilityGrant, "employeeId">): OperationResult {
    const rec = records.get(employeeId);
    if (rec === undefined) return notFound(employeeId);
    if (!isNonEmptyString(grant?.capabilityId)) {
      return { ok: false, employeeId, state: rec.lifecycle.state(), error: employeeError("VALIDATION_FAILED", "a grant needs a capabilityId") };
    }
    if (!RISK_LEVELS.includes(grant.permission)) {
      return { ok: false, employeeId, state: rec.lifecycle.state(), error: employeeError("VALIDATION_FAILED", `unknown permission "${String(grant.permission)}"`, `known levels: ${RISK_LEVELS.join(", ")}`) };
    }
    if (!GRANT_SCOPES.includes(grant.scope)) {
      return { ok: false, employeeId, state: rec.lifecycle.state(), error: employeeError("VALIDATION_FAILED", `unknown grant scope "${String(grant.scope)}"`, `known scopes: ${GRANT_SCOPES.join(", ")}`) };
    }
    const full: CapabilityGrant = {
      employeeId,
      capabilityId: grant.capabilityId,
      permission: grant.permission,
      scope: grant.scope,
      ...(grant.scopeId !== undefined ? { scopeId: grant.scopeId } : {}),
    };
    const key = grantKey(employeeId, full);
    rec.grants = [...rec.grants.filter((existing) => grantKey(employeeId, existing) !== key), full];
    emit("workforce.granted", { employeeId, capabilityId: full.capabilityId, permission: full.permission, scope: full.scope });
    return { ok: true, employeeId, state: rec.lifecycle.state(), changed: true };
  }

  function revokeImpl(
    employeeId: string,
    capabilityId: CapabilityId,
    scope: CapabilityGrant["scope"] = "employee",
    scopeId?: string,
  ): boolean {
    const rec = records.get(employeeId);
    if (rec === undefined) return false;
    const key = grantKey(employeeId, { capabilityId, scope, ...(scopeId !== undefined ? { scopeId } : {}) });
    const before = rec.grants.length;
    rec.grants = rec.grants.filter((grant) => grantKey(employeeId, grant) !== key);
    if (rec.grants.length === before) return false;
    emit("workforce.revoked", { employeeId, capabilityId, scope });
    return true;
  }

  function permissionsImpl(employeeId: string): CapabilityGrant[] {
    const rec = records.get(employeeId);
    return rec === undefined ? [] : rec.grants.map((grant) => ({ ...grant }));
  }

  // ── Selection and delegation ─────────────────────────────────────────────────

  /**
   * Who can take work right now.
   *
   * Only READY (and DEGRADED, when explicitly allowed) employees are eligible —
   * DISABLED, UNAVAILABLE, INSTALLED, AUTHENTICATING and DISCOVERED all mean
   * "cannot be handed a task". Discovery placeholders are skipped: they are
   * observable for the UI, but KAI has no adapter to hand them work through.
   */
  function availableImpl(criteria: SelectionCriteria = {}): EmployeeHandle[] {
    const handles: EmployeeHandle[] = [];
    for (const rec of records.values()) {
      if (rec.placeholder) continue;
      const state = rec.lifecycle.state();
      const eligible = state === "READY" || (criteria.allowDegraded === true && state === "DEGRADED");
      if (!eligible) continue;
      if (criteria.role !== undefined && rec.role !== criteria.role) continue;
      if (criteria.capabilityId !== undefined && !rec.capabilities.includes(criteria.capabilityId)) continue;
      handles.push({
        employeeId: rec.descriptor.metadata.id,
        ...(rec.instance !== undefined ? { instanceId: rec.instance.instanceId } : {}),
        kind: rec.kind,
        state,
        ...(rec.role !== undefined ? { role: rec.role } : {}),
      });
    }
    return handles;
  }

  function selectImpl(criteria: SelectionCriteria = {}): EmployeeHandle | null {
    const handles = availableImpl(criteria);
    return handles.length > 0 ? handles[0] ?? null : null;
  }

  /**
   * Hand a task to the best eligible employee. Every failure mode is a value:
   * nothing selectable -> NOT_FOUND; no adapter/capability -> AGENT_CAPABILITY_MISSING;
   * the adapter throws -> AGENT_RUN_FAILED. `ok` means the run completed.
   */
  async function delegateImpl(request: DelegationRequest): Promise<DelegationResult> {
    const capability: AgentCapability = request.capability ?? "run_task";
    const handle = selectImpl({
      ...(request.role !== undefined ? { role: request.role } : {}),
      ...(request.allowDegraded !== undefined ? { allowDegraded: request.allowDegraded } : {}),
    });
    if (handle === null) {
      return {
        ok: false,
        taskId: request.taskId,
        error: employeeError(
          "NOT_FOUND",
          `no available employee can handle "${request.taskId}"${request.role !== undefined ? ` (role: ${request.role})` : ""}`,
        ),
      };
    }

    const rec = records.get(handle.employeeId);
    if (rec === undefined) {
      return { ok: false, taskId: request.taskId, error: employeeError("NOT_FOUND", `employee "${handle.employeeId}" vanished mid-delegation`) };
    }
    const instance = await ensureInstanceImpl(rec);
    if (instance === null) {
      return {
        ok: false,
        taskId: request.taskId,
        employeeId: handle.employeeId,
        state: rec.lifecycle.state(),
        error: employeeError("INTERNAL", `employee "${handle.employeeId}" has no usable instance`),
      };
    }
    const adapter = instance.adapter;
    if (adapter === undefined) {
      return {
        ok: false,
        taskId: request.taskId,
        employeeId: handle.employeeId,
        instanceId: instance.instanceId,
        state: rec.lifecycle.state(),
        error: employeeError("AGENT_CAPABILITY_MISSING", `employee "${handle.employeeId}" has no task adapter wired`),
      };
    }
    let capabilities: readonly string[];
    try {
      capabilities = instance.capabilities();
    } catch (error) {
      capabilities = [];
      emit("workforce.delegate_error", { employeeId: handle.employeeId, detail: describeError(error) });
    }
    if (!capabilities.includes(capability)) {
      return {
        ok: false,
        taskId: request.taskId,
        employeeId: handle.employeeId,
        instanceId: instance.instanceId,
        state: rec.lifecycle.state(),
        error: employeeError("AGENT_CAPABILITY_MISSING", `employee "${handle.employeeId}" cannot ${capability}`),
      };
    }

    try {
      if (executeTask === undefined) {
        // Refuse rather than bypass. A direct adapter call here would be the
        // second way to reach a worker, and the review that closed the first one
        // would be worthless.
        return {
          ok: false,
          taskId: request.taskId,
          employeeId: handle.employeeId,
          instanceId: instance.instanceId,
          state: rec.lifecycle.state(),
          error: employeeError(
            "AGENT_CAPABILITY_MISSING",
            `employee "${handle.employeeId}" cannot be delegated to: no policy-governed executor is wired, and calling the adapter directly would bypass validate -> policy -> approval`,
          ),
        };
      }
      const result = await executeTask({
        employeeId: handle.employeeId,
        capability,
        taskId: request.taskId,
        input: request.input,
        ...(request.options !== undefined ? { options: request.options } : {}),
      });
      emit("workforce.delegated", { employeeId: handle.employeeId, taskId: request.taskId, state: result.state });
      return {
        ok: result.state === "completed",
        taskId: request.taskId,
        employeeId: handle.employeeId,
        instanceId: instance.instanceId,
        state: rec.lifecycle.state(),
        result,
        ...(result.state === "completed" || result.error === undefined ? {} : { error: result.error }),
      };
    } catch (error) {
      emit("workforce.delegate_error", { employeeId: handle.employeeId, taskId: request.taskId, detail: describeError(error) });
      return {
        ok: false,
        taskId: request.taskId,
        employeeId: handle.employeeId,
        instanceId: instance.instanceId,
        state: rec.lifecycle.state(),
        error: employeeError("AGENT_RUN_FAILED", `delegation to "${handle.employeeId}" threw`, describeError(error)),
      };
    }
  }

  // ── The manager ──────────────────────────────────────────────────────────────

  return {
    register: registerImpl,
    unregister: unregisterImpl,
    has: (employeeId) => records.has(employeeId),
    get: (employeeId) => records.get(employeeId)?.descriptor,
    list: () => [...records.values()].map(descriptionOf),
    describe: (employeeId) =>
      employeeId === undefined
        ? [...records.values()].map(descriptionOf)
        : [...records.values()].filter((rec) => rec.descriptor.metadata.id === employeeId).map(descriptionOf),

    observe: observeImpl,
    discover: discoverImpl,

    install: installImpl,
    authenticate: authenticateImpl,
    configure: configureImpl,
    healthCheck: healthCheckImpl,
    monitor: monitorImpl,
    enable: enableImpl,
    disable: disableImpl,
    remove: removeImpl,
    recover: recoverImpl,

    assignRole: assignRoleImpl,
    grant: grantImpl,
    revoke: revokeImpl,
    permissions: permissionsImpl,

    select: selectImpl,
    available: availableImpl,
    delegate: delegateImpl,
  };
}

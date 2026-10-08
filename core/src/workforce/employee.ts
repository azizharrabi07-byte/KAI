// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * employee.ts — the primitives an *employee* is built from.
 *
 * An employee is a reasoning worker KAI can hire (Hermes, OpenCode, Codex, a
 * future one). The frozen contract splits it into a stateless descriptor and a
 * live instance; this file provides the small, safe constructors that keep that
 * split honest, so neither the manager nor the lead's wiring has to hand-roll a
 * contract-shaped object with its own idea of what "snapshot" means.
 *
 * Two rules encoded here, because they are easy to get wrong once and painful
 * everywhere after:
 *
 *  1. An instance factory must NEVER throw past KAI. `makeInstance` wraps
 *     `snapshot()`/`dispose()` so a broken employee becomes an UNAVAILABLE
 *     snapshot — a value — instead of an exception travelling up into the
 *     control plane.
 *  2. `dispose()` is idempotent. Shutdown paths call it on every employee and on
 *     every recovery; the second call must be a no-op, not an error.
 */

import { isNonEmptyString, isRecord, nowIso } from "../shared/contracts.ts";
import type {
  AgentAdapter,
  CapabilityId,
  EmployeeDescriptor,
  EmployeeInstance,
  EmployeeMetadata,
  EmployeeSnapshot,
  EmployeeState,
} from "../shared/contracts.ts";
import type { EmployeeKind, TurnAdapter } from "../shared/runtime-events.ts";

// ── Errors as values ───────────────────────────────────────────────────────────

/** Best-effort human string for an error, without leaking anything. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { kaiError?: { code?: unknown } }).kaiError?.code;
    return typeof code === "string" ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

// ── Metadata ──────────────────────────────────────────────────────────────────

export interface EmployeeMetadataInput {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** Where it came from; defaults to "builtin". */
  origin?: string;
  capabilities?: readonly CapabilityId[];
}

/** Capability ids are declared, so drop anything that is not a real string and dedupe. */
export function normalizeCapabilities(input: readonly CapabilityId[] | undefined): CapabilityId[] {
  if (input === undefined) return [];
  const seen = new Set<CapabilityId>();
  for (const capability of input) {
    if (isNonEmptyString(capability)) seen.add(capability);
  }
  return [...seen];
}

/**
 * Build validated metadata. This throws on a missing id/name — deliberately:
 * `defineEmployee` is authoring-time code written by KAI's own developers, and a
 * nameless employee is a programmer error that should fail loudly at the call
 * site. Untrusted data (discovery results, IPC) does not come through here; the
 * manager validates *that* and returns a value.
 */
export function makeEmployeeMetadata(input: EmployeeMetadataInput): EmployeeMetadata {
  if (!isRecord(input) || !isNonEmptyString(input.id)) {
    throw new Error("employee metadata requires a non-empty id");
  }
  if (!isNonEmptyString(input.name)) {
    throw new Error(`employee "${input.id}" requires a non-empty name`);
  }
  const metadata: EmployeeMetadata = {
    id: input.id,
    name: input.name,
    origin: isNonEmptyString(input.origin) ? input.origin : "builtin",
    capabilities: normalizeCapabilities(input.capabilities),
  };
  if (input.version !== undefined) metadata.version = input.version;
  if (input.description !== undefined) metadata.description = input.description;
  return metadata;
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

export interface SnapshotInput {
  reachable?: boolean;
  authenticated?: boolean;
  version?: string;
  problems?: readonly string[];
  at?: string;
}

/**
 * A contract-shaped snapshot with every field defaulted honestly: a snapshot
 * nobody filled in says "not reachable, not authenticated", which is the safe
 * reading, rather than implying health by omission.
 */
export function makeSnapshot(state: EmployeeState, input: SnapshotInput = {}): EmployeeSnapshot {
  const snapshot: EmployeeSnapshot = {
    state,
    at: input.at ?? nowIso(),
    reachable: input.reachable ?? false,
    authenticated: input.authenticated ?? false,
  };
  if (input.version !== undefined) snapshot.version = input.version;
  if (input.problems !== undefined && input.problems.length > 0) {
    snapshot.problems = [...input.problems];
  }
  return snapshot;
}

// ── Instances ─────────────────────────────────────────────────────────────────

export interface EmployeeInstanceParts {
  instanceId: string;
  employeeId: string;
  kind: EmployeeKind;
  adapter?: AgentAdapter;
  turns?: TurnAdapter;
  capabilities?: readonly CapabilityId[];
  initialState?: EmployeeState;
  /** The employee's own view of itself. May throw; that is handled below. */
  snapshot: () => Promise<EmployeeSnapshot>;
  /** Optional override; when absent, the last snapshot's state is reported. */
  state?: () => EmployeeState;
  /** Optional cleanup; may throw; may be called twice. */
  dispose?: () => Promise<void>;
}

/**
 * Assemble a contract-shaped `EmployeeInstance` from parts.
 *
 * The wrapper is the point: callers supply a raw `snapshot`/`dispose` that may
 * misbehave, and everything above sees only values. If `snapshot()` throws, the
 * instance reports UNAVAILABLE with the reason attached rather than propagating;
 * `dispose()` swallows and is idempotent.
 */
export function makeInstance(parts: EmployeeInstanceParts): EmployeeInstance {
  let lastState: EmployeeState = parts.initialState ?? "DISCOVERED";
  let disposed = false;

  const instance: EmployeeInstance = {
    instanceId: parts.instanceId,
    employeeId: parts.employeeId,
    kind: parts.kind,
    // Optional properties are attached only when present, so `"adapter" in instance`
    // stays an honest test rather than reading an explicit `undefined`.
    ...(parts.adapter !== undefined ? { adapter: parts.adapter } : {}),
    ...(parts.turns !== undefined ? { turns: parts.turns } : {}),
    state(): EmployeeState {
      return parts.state ? parts.state() : lastState;
    },
    async snapshot(): Promise<EmployeeSnapshot> {
      try {
        const snapshot = await parts.snapshot();
        lastState = snapshot.state;
        return snapshot;
      } catch (error) {
        lastState = "UNAVAILABLE";
        return makeSnapshot("UNAVAILABLE", {
          reachable: false,
          authenticated: false,
          problems: [describeError(error)],
        });
      }
    },
    capabilities(): readonly CapabilityId[] {
      return normalizeCapabilities(parts.capabilities);
    },
    async dispose(): Promise<void> {
      if (disposed) return; // idempotent: a second dispose is not an error
      disposed = true;
      lastState = "REMOVED";
      if (parts.dispose !== undefined) {
        try {
          await parts.dispose();
        } catch {
          // An employee that fails to clean up must not break KAI's shutdown.
        }
      }
    },
  };

  return instance;
}

// ── Descriptors ───────────────────────────────────────────────────────────────

export interface EmployeeDefinition extends EmployeeMetadataInput {
  create: (input?: { instanceId?: string }) => Promise<EmployeeInstance>;
}

/**
 * Build an `EmployeeDescriptor`. The returned `create` simply forwards to the
 * definition's `create`; the reason this indirection exists is metadata
 * validation, so a descriptor handed to the manager is always well-formed.
 */
export function defineEmployee(definition: EmployeeDefinition): EmployeeDescriptor {
  const metadata = makeEmployeeMetadata(definition);
  if (typeof definition.create !== "function") {
    throw new Error(`employee "${metadata.id}" requires a create() function`);
  }
  return {
    metadata,
    create: (input) => definition.create(input),
  };
}

/**
 * A descriptor for an employee KAI knows about but cannot actually start —
 * discovered services with no adapter wired yet, or trusted sources that are
 * simply not installed. Its instance always reports UNAVAILABLE with the reason,
 * which is how Part J's "is Codex installed? no" reaches the UI as a value.
 */
export function createUnavailableEmployee(metadata: EmployeeMetadata, reason: string): EmployeeDescriptor {
  const meta = makeEmployeeMetadata(metadata);
  return {
    metadata: meta,
    async create(input = {}): Promise<EmployeeInstance> {
      return makeInstance({
        instanceId: input.instanceId ?? `${meta.id}#unavailable`,
        employeeId: meta.id,
        kind: meta.id,
        capabilities: meta.capabilities,
        initialState: "UNAVAILABLE",
        snapshot: async () =>
          makeSnapshot("UNAVAILABLE", {
            reachable: false,
            authenticated: false,
            problems: [reason],
          }),
      });
    },
  };
}

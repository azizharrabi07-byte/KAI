// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The mock workstation provider — the seam's executable specification.
 *
 * WHY this ships in `src` rather than only inside a test file: the provider
 * contract is only meaningful if it is implementable without a driver, and the
 * mock is what proves it. It is also the only way to exercise the states that
 * matter and cannot be summoned on demand from a real machine — an absent
 * driver, a call that times out, a session that has gone stale, a permission
 * refusal, and an action whose effect the provider cannot prove.
 *
 * It is DETERMINISTIC: no wall clock (the timestamp is injected), no sleeping,
 * no randomness, and a scripted sequence that repeats its last step rather than
 * running out. A test that flakes on a mock is a test that cannot tell a bug
 * from a race.
 *
 * It records every call, so a test can assert the thing that actually matters:
 * that a refused action NEVER reached the provider, rather than merely that the
 * caller received a refusal.
 */

import {
  fail,
  failure,
  ok,
  outcome,
  validateActionTarget,
  type AccessibilityElement,
  type ActionReport,
  type ConnectInfo,
  type FailureInput,
  type ObservationTarget,
  type OutcomeInput,
  type ProviderAvailability,
  type Screenshot,
  type WindowSummary,
  type WorkstationAction,
  type WorkstationFailure,
  type WorkstationObservation,
  type WorkstationProvider,
  type WorkstationResult,
  type WorkstationStatus,
} from "./provider.ts";

/** The provider methods a script can make fail. */
export type MockMethod = "availability" | "connect" | "disconnect" | "status" | "observe" | "act";

export interface MockObservationStep {
  /** The verdict for this observation. Defaults to `confirmed`. */
  verdict?: OutcomeInput;
  screenshot?: Screenshot | null;
  elements?: readonly AccessibilityElement[];
  windows?: readonly WindowSummary[];
  snapshotId?: string;
  /** False models a truncated accessibility walk. */
  complete?: boolean;
  /** When set, the call fails with this error instead of returning an observation. */
  error?: FailureInput;
}

export interface MockActionStep {
  /** The verdict for this action. Defaults to `unverifiable` — never `confirmed`. */
  verdict?: OutcomeInput;
  driverCode?: string;
  /** When set, the call fails with this error instead of returning a report. */
  error?: FailureInput;
}

export interface MockCallLog {
  availability: number;
  connect: number;
  disconnect: number;
  status: number;
  observe: ObservationTarget[];
  act: WorkstationAction[];
  close: number;
}

export interface MockProviderOptions {
  id?: string;
  availability?: ProviderAvailability;
  /** When set, `connect` fails with this error. */
  connectFailure?: FailureInput;
  /** Scripted observations, consumed in order; the last one repeats. */
  observations?: readonly MockObservationStep[];
  /** Scripted action results, consumed in order; the last one repeats. */
  actions?: readonly MockActionStep[];
  statusValue?: WorkstationStatus;
  /** Methods that resolve to a timeout instead of their normal result. */
  timeouts?: readonly MockMethod[];
  /** Methods that resolve to a permission refusal instead of their normal result. */
  permissionsDenied?: readonly MockMethod[];
  /** After this many `observe`+`act` calls the session is stale. */
  staleAfter?: number;
  now?: () => string;
}

export interface MockWorkstationProvider extends WorkstationProvider {
  readonly kind: "mock";
  readonly calls: MockCallLog;
  /** Replace the next observation the provider will return. */
  setObservation(step: MockObservationStep): void;
  /** Replace the next action result the provider will return. */
  setAction(step: MockActionStep): void;
}

const DEFAULT_AVAILABILITY: ProviderAvailability = {
  available: true,
  version: "0.28.2",
  supported: true,
  daemonRunning: true,
};

const DEFAULT_STATUS: WorkstationStatus = {
  connected: false,
  version: "0.28.2",
  daemonRunning: true,
  permissionMode: "standard",
  desktopAuthorized: false,
  screen: { width: 1920, height: 1080 },
  session: null,
};

const TIMEOUT: FailureInput = {
  kind: "timeout",
  message: "the provider call exceeded its time budget",
  retryable: true,
};

const PERMISSION: FailureInput = {
  kind: "permission",
  message: "the provider denied this call",
  effect: "refused",
};

export function createMockWorkstationProvider(options: MockProviderOptions = {}): MockWorkstationProvider {
  const id = options.id ?? "mock:workstation";
  const now = options.now ?? ((): string => "1970-01-01T00:00:00.000Z");
  const timeouts: readonly MockMethod[] = options.timeouts ?? [];
  const denied: readonly MockMethod[] = options.permissionsDenied ?? [];
  const calls: MockCallLog = { availability: 0, connect: 0, disconnect: 0, status: 0, observe: [], act: [], close: 0 };

  let connected = false;
  let screenTouches = 0;
  let observationIndex = 0;
  let actionIndex = 0;
  const observations = [...(options.observations ?? [])];
  const actions = [...(options.actions ?? [])];

  /** A scripted interruption, if this method is scripted to fail. */
  function interruption(method: MockMethod): WorkstationFailure | null {
    if (timeouts.includes(method)) return failure(TIMEOUT);
    if (denied.includes(method)) return failure(PERMISSION);
    return null;
  }

  /** Refuse screen- or input-touching calls once the scripted session expires. */
  function staleCheck(): WorkstationFailure | null {
    if (options.staleAfter === undefined) return null;
    if (screenTouches >= options.staleAfter) {
      return failure({
        kind: "stale_session",
        message: "the observation this session was built on is stale",
        effect: "refused",
        driverCode: "stale_element_token",
        detail: `the session expired after ${String(options.staleAfter)} call(s); observe again`,
      });
    }
    return null;
  }

  function nextObservation(step: MockObservationStep | undefined, target: ObservationTarget): WorkstationObservation {
    const verdict = step?.verdict ?? { effect: "confirmed" };
    return {
      ...outcome(verdict),
      target,
      capturedAt: now(),
      screenshot: step?.screenshot ?? null,
      elements: step?.elements ?? [],
      complete: step?.complete ?? true,
      ...(step?.snapshotId !== undefined ? { snapshotId: step.snapshotId } : {}),
      ...(step?.windows !== undefined ? { windows: step.windows } : {}),
    };
  }

  function nextAction(step: MockActionStep | undefined, action: WorkstationAction): ActionReport {
    // The default is `unverifiable`, deliberately: a mock that reported
    // `confirmed` for an unscripted action would teach callers the wrong habit.
    const verdict = step?.verdict ?? { effect: "unverifiable" };
    const report: ActionReport = {
      ...outcome(verdict),
      action: action.kind,
      target: action.target.kind,
      at: now(),
    };
    if (step?.driverCode !== undefined) report.driverCode = step.driverCode;
    return report;
  }

  return {
    id,
    kind: "mock",
    calls,

    setObservation(step: MockObservationStep): void {
      observations.push(step);
    },

    setAction(step: MockActionStep): void {
      actions.push(step);
    },

    async availability(): Promise<WorkstationResult<ProviderAvailability>> {
      calls.availability += 1;
      const stop = interruption("availability");
      if (stop) return fail(stop);
      return ok(options.availability ?? DEFAULT_AVAILABILITY);
    },

    async connect(): Promise<WorkstationResult<ConnectInfo>> {
      calls.connect += 1;
      const stop = interruption("connect");
      if (stop) return fail(stop);
      if (options.connectFailure) return fail(failure(options.connectFailure));

      const available = options.availability ?? DEFAULT_AVAILABILITY;
      if (!available.available) {
        return fail(failure({ kind: "unavailable", message: available.detail ?? "the provider is unavailable" }));
      }
      if (!available.supported) {
        return fail(failure({ kind: "unsupported", message: available.detail ?? "the provider version is unsupported" }));
      }
      if (!available.daemonRunning) {
        return fail(failure({ kind: "unavailable", message: available.detail ?? "the provider daemon is not running" }));
      }

      connected = true;
      screenTouches = 0;
      const info: ConnectInfo = {
        version: available.version ?? "unknown",
        platform: process.platform,
        daemon: true,
        capabilities: ["click", "type", "key", "hotkey", "scroll", "drag"],
      };
      return ok(info);
    },

    async disconnect(): Promise<WorkstationResult<void>> {
      calls.disconnect += 1;
      const stop = interruption("disconnect");
      if (stop) return fail(stop);
      connected = false;
      return ok(undefined);
    },

    async status(): Promise<WorkstationResult<WorkstationStatus>> {
      calls.status += 1;
      const stop = interruption("status");
      if (stop) return fail(stop);
      const base = options.statusValue ?? DEFAULT_STATUS;
      return ok({ ...base, connected, session: connected ? "mock-session" : null });
    },

    async observe(target: ObservationTarget): Promise<WorkstationResult<WorkstationObservation>> {
      calls.observe.push(target);
      const stop = interruption("observe");
      if (stop) return fail(stop);

      const stale = staleCheck();
      if (stale) return fail(stale);

      if (!connected) {
        return fail(failure({ kind: "unavailable", message: "the provider is not connected" }));
      }
      screenTouches += 1;

      const step = observations[Math.min(observationIndex, Math.max(observations.length - 1, 0))];
      if (observations.length > 0 && observationIndex < observations.length - 1) observationIndex += 1;
      if (step?.error) return fail(failure(step.error));

      return ok(nextObservation(step, target));
    },

    async act(action: WorkstationAction): Promise<WorkstationResult<ActionReport>> {
      // Validation happens BEFORE the call is logged as reaching the provider
      // body's effects, so a malformed action provably never gets past the seam.
      const invalid = validateActionTarget(action);
      if (invalid) return fail(invalid);

      calls.act.push(action);
      const stop = interruption("act");
      if (stop) return fail(stop);

      const stale = staleCheck();
      if (stale) return fail(stale);

      if (!connected) {
        return fail(failure({ kind: "unavailable", message: "the provider is not connected" }));
      }
      screenTouches += 1;

      const step = actions[Math.min(actionIndex, Math.max(actions.length - 1, 0))];
      if (actions.length > 0 && actionIndex < actions.length - 1) actionIndex += 1;
      if (step?.error) return fail(failure(step.error));

      return ok(nextAction(step, action));
    },

    async close(): Promise<void> {
      calls.close += 1;
      connected = false;
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A deterministic element tree, so tests never hand-write indices. */
export const MOCK_ELEMENTS: readonly AccessibilityElement[] = [
  { index: 0, role: "Window", label: "Untitled — Notepad", depth: 0, actions: [] },
  { index: 1, role: "Edit", label: "Text editor", value: "", depth: 1, enabled: true, actions: ["set_value"] },
  { index: 2, role: "Button", label: "Save", depth: 1, enabled: true, actions: ["invoke"] },
];

export const MOCK_WINDOW = { pid: 4242, windowId: 1001 } as const;

/** A deterministic PNG header as base64 — enough to prove pixels were carried. */
export const MOCK_SCREENSHOT: Screenshot = {
  mimeType: "image/png",
  width: 800,
  height: 600,
  dataBase64: "iVBORw0KGgo=",
};

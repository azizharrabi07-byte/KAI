// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Worker preflight: what KAI can actually dispatch to, and what is missing.
 *
 * The gap this closes was found by running the system. A fresh Core compiles a plan
 * and then refuses to dispatch with *"no workers are available"*, and the default
 * `workerAuto: "ASK"` refuses autonomous dispatch — both correct, and both
 * invisible until a goal is already half-executed.
 *
 * This module answers, BEFORE anything is dispatched:
 *   - is autonomous dispatch authorized, and if not, what setting is missing?
 *   - which workers are INSTALLED and reachable (an adapter probe), which are
 *     REGISTERED with KAI (a persona), and which can actually be selected?
 *   - what exactly must the user do to make a goal runnable?
 *
 * It reports; it never enables anything. Installing a CLI is not registration, and
 * registration is not reachability — those are three different facts.
 */

export interface WorkerPreflightEntry {
  id: string;
  /** "installed" — the adapter exists in the registry. */
  installed: boolean;
  /** "reachable" — the adapter's own live probe answered. */
  reachable: boolean;
  /** "registered" — a KAI persona exists, so the router can select it. */
  registered: boolean;
  /** The adapter's own words when it cannot be used. */
  reason: string;
  capabilities: readonly string[];
}

export interface ExecutionModeReport {
  workerAuto: "AUTO" | "ASK" | "OFF";
  autonomyLevel: number;
  /** True only when KAI may dispatch WITHOUT asking. */
  autonomousDispatchReady: boolean;
  why: string;
}

export interface WorkerPreflight {
  ready: boolean;
  executionMode: ExecutionModeReport;
  workers: WorkerPreflightEntry[];
  /** Every reason a goal cannot dispatch yet, in the order a user should fix them. */
  blockers: string[];
}

export interface WorkerPreflightInput {
  /** The registered personas — the set the router may actually select from. */
  personas: readonly string[];
  /** Adapter health, keyed by adapter id, from the registry's own live probes. */
  health: Record<string, { ok: boolean; detail: string }>;
  /** Adapter capabilities, keyed by adapter id. */
  capabilities: Record<string, readonly string[]>;
  autonomy: { workerAuto: "AUTO" | "ASK" | "OFF"; level: number };
}

/**
 * Build the report. Pure: every fact is passed in, so it is testable without a
 * registry, a network or a running worker.
 */
export function buildWorkerPreflight(input: WorkerPreflightInput): WorkerPreflight {
  const adapterIds = Object.keys(input.health);
  const workers: WorkerPreflightEntry[] = adapterIds.map((id) => {
    const health = input.health[id];
    const reachable = health?.ok === true;
    return {
      id,
      installed: true,
      reachable,
      registered: input.personas.includes(id),
      reason: reachable
        ? "reachable"
        : (health?.detail ?? "the adapter did not report health"),
      capabilities: input.capabilities[id] ?? [],
    };
  });

  // A persona names the WORKER it runs on, so a registered persona is what makes a
  // worker selectable even when the adapter id itself is not the persona id.
  const registeredPersonas = input.personas.filter((p) => p.length > 0);

  const autonomousDispatchReady =
    input.autonomy.workerAuto === "AUTO" && input.autonomy.level >= 2;
  const executionMode: ExecutionModeReport = {
    workerAuto: input.autonomy.workerAuto,
    autonomyLevel: input.autonomy.level,
    autonomousDispatchReady,
    why: autonomousDispatchReady
      ? `KAI may dispatch without asking (workerAuto AUTO, autonomy level ${input.autonomy.level}).`
      : input.autonomy.workerAuto !== "AUTO"
        ? `autonomous dispatch is OFF by policy: workerAuto is "${input.autonomy.workerAuto}". Set it to "AUTO" to let an approved plan run unattended.`
        : `autonomy level ${input.autonomy.level} does not delegate automatically; level 2 or higher is required.`,
  };

  const blockers: string[] = [];
  if (registeredPersonas.length === 0) {
    blockers.push(
      "no worker is REGISTERED with KAI. Installing a runtime is not registration: register a persona " +
        "(POST /subagents with a workerId such as \"hermes\") before a goal can dispatch.",
    );
  }
  const usable = workers.filter((w) => w.reachable);
  if (workers.length === 0) {
    blockers.push("no worker adapter is registered at all — nothing can be dispatched.");
  } else if (usable.length === 0) {
    blockers.push(
      `no worker is REACHABLE: ${workers.map((w) => `${w.id} (${w.reason})`).join("; ")}. Start the runtime, or register one that is running.`,
    );
  }
  if (!autonomousDispatchReady) blockers.push(executionMode.why);

  return { ready: blockers.length === 0, executionMode, workers, blockers };
}

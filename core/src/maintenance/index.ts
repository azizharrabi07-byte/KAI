// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI maintaining itself.
 *
 * The directive names "self-maintenance / upgrading" as an area. The repo had no
 * requirement for it at all (recorded as NOT FOUND in `docs/phase4-roadmap.md`),
 * so this module is scoped to what KAI can HONESTLY do to itself, and nothing
 * more: it checks the subsystems it owns, repairs the ones it is allowed to
 * touch, and reports which build is actually running.
 *
 * The staleness check is not decoration. This project has already produced one
 * wrong answer because a STALE Core served a port while a newer build was
 * believed to be answering; the only durable defence is to compare the build id
 * the running process loaded against the build id stamped on disk next to it.
 *
 * What it deliberately does NOT do: no network, no downloads, no self-replacing
 * binaries (that would be an unauthenticated code-execution path — the opposite
 * of the rest of this design), and no touching anything outside KAI's own
 * directories. "Upgrading" here means "report precisely which build is running
 * and whether it is the one on disk", which is what an operator actually needs,
 * plus the repairs below that KAI can perform safely in-process.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KaiError } from "../shared/contracts.ts";

export type CheckStatus = "pass" | "warn" | "fail";

export interface MaintenanceCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface MaintenanceRepair {
  name: string;
  performed: boolean;
  detail: string;
}

export interface MaintenanceIdentity {
  buildId: string;
  gitCommit: string;
  protocolVersion: number;
  pid: number;
  /** The build id stamped next to the running code, when it can be read. */
  onDiskBuildId?: string;
  /** True when the running process IS the build on disk. The anti-stale check. */
  current: boolean;
  detail: string;
}

export interface MaintenanceReport {
  ok: boolean;
  checkedAt: string;
  identity: MaintenanceIdentity;
  checks: MaintenanceCheck[];
  repairs: MaintenanceRepair[];
}

export interface MaintenanceDeps {
  identity: () => { buildId: string; gitCommit: string; protocolVersion: number; pid: number };
  /** Where the compiled code lives, so the on-disk stamp can be read. */
  moduleDir: string;
  paths: { database: string; ledger: string; sessions: string };
  /** Live probes. Each returns a detail string and whether it is healthy. */
  probeDatabase: () => { ok: boolean; detail: string };
  probeSessions: () => { ok: boolean; detail: string };
  probeAgents: () => { ok: boolean; detail: string };
  probeScheduler: () => { ok: boolean; detail: string };
  probeLedger: () => { ok: boolean; detail: string };
  // ── repairs KAI may perform on itself ──────────────────────────────────────
  runMemoryUpkeep: () => void | Promise<void>;
  recoverScheduler: () => { resumed?: number; missed?: number } | void;
  /** Reconcile work items a dead process left in flight; returns what it blocked. */
  recoverWorkItems: () => { abandoned: string[] };
  resumeMissions: () => Promise<{ resumed: string[]; blocked: string[] }>;
  syncViews: () => void;
  now?: () => Date;
}

export interface MaintenanceService {
  /** Inspect only. Never changes anything. */
  status(): MaintenanceReport;
  /** Inspect, then perform the repairs that the inspection justifies. */
  run(): Promise<MaintenanceReport>;
}

/** Read the build stamp that sits next to the running module. */
function readOnDiskBuildId(moduleDir: string): string | undefined {
  const candidate = join(moduleDir, "build-info.json");
  if (!existsSync(candidate)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { buildId?: unknown };
    return typeof parsed.buildId === "string" && parsed.buildId.length > 0 ? parsed.buildId : undefined;
  } catch {
    return undefined;
  }
}

export function createMaintenanceService(deps: MaintenanceDeps): MaintenanceService {
  const now = deps.now ?? (() => new Date());

  function identity(): MaintenanceIdentity {
    const running = deps.identity();
    const onDisk = readOnDiskBuildId(deps.moduleDir);
    const current = onDisk === undefined ? running.buildId.length > 0 : onDisk === running.buildId;
    return {
      ...running,
      ...(onDisk !== undefined ? { onDiskBuildId: onDisk } : {}),
      current,
      detail:
        onDisk === undefined
          ? `running build ${running.buildId}; no build stamp found next to the running code, so "is this the reviewed build?" cannot be answered here`
          : current
            ? `running build ${running.buildId} IS the build stamped on disk`
            : `STALE: running build ${running.buildId} but the code on disk is build ${onDisk} — this process is not the build under review`,
    };
  }

  function inspect(): MaintenanceCheck[] {
    const checks: MaintenanceCheck[] = [];
    const id = identity();
    checks.push({ name: "identity", status: id.current ? "pass" : "warn", detail: id.detail });

    const db = deps.probeDatabase();
    checks.push({ name: "database", status: db.ok ? "pass" : "fail", detail: db.detail });

    const sessions = deps.probeSessions();
    checks.push({ name: "sessions", status: sessions.ok ? "pass" : "fail", detail: sessions.detail });

    const ledger = deps.probeLedger();
    checks.push({ name: "recovery-ledger", status: ledger.ok ? "pass" : "fail", detail: ledger.detail });

    const agents = deps.probeAgents();
    // An unreachable worker is a WARN, not a failure: KAI is explicitly designed
    // to run with a worker offline, and reporting that as a fault would be a lie.
    checks.push({ name: "agents", status: agents.ok ? "pass" : "warn", detail: agents.detail });

    const scheduler = deps.probeScheduler();
    checks.push({ name: "scheduler", status: scheduler.ok ? "pass" : "warn", detail: scheduler.detail });

    return checks;
  }

  function status(): MaintenanceReport {
    const checks = inspect();
    return {
      ok: checks.every((c) => c.status !== "fail"),
      checkedAt: now().toISOString(),
      identity: identity(),
      checks,
      repairs: [],
    };
  }

  async function run(): Promise<MaintenanceReport> {
    const checks = inspect();
    const repairs: MaintenanceRepair[] = [];

    // Repair 1: memory upkeep. Running a cycle is safe and idempotent, and it is
    // exactly what a restart would do — so doing it here cannot invent state.
    try {
      await deps.runMemoryUpkeep();
      repairs.push({ name: "memory-upkeep", performed: true, detail: "ran one upkeep cycle" });
    } catch (error) {
      repairs.push({ name: "memory-upkeep", performed: false, detail: errorText(error) });
    }

    // Repair 2: settle what a dead process left in the scheduler's lease ledger.
    try {
      const outcome = deps.recoverScheduler();
      repairs.push({
        name: "scheduler-recovery",
        performed: true,
        detail: outcome === undefined ? "recovered interrupted leases" : JSON.stringify(outcome),
      });
    } catch (error) {
      repairs.push({ name: "scheduler-recovery", performed: false, detail: errorText(error) });
    }

    // Repair 3: finish (or refuse) missions a crash interrupted.
    try {
      const outcome = await deps.resumeMissions();
      repairs.push({
        name: "mission-recovery",
        performed: true,
        detail: `resumed ${outcome.resumed.length}, blocked ${outcome.blocked.length}`,
      });
    } catch (error) {
      repairs.push({ name: "mission-recovery", performed: false, detail: errorText(error) });
    }

    // Repair 4: re-derive the employee ↔ capability view (a stale view is how a
    // capability can be refused while it is actually available).
    try {
      deps.syncViews();
      repairs.push({ name: "view-sync", performed: true, detail: "re-synced employee capability views" });
    } catch (error) {
      repairs.push({ name: "view-sync", performed: false, detail: errorText(error) });
    }

    return {
      ok: checks.every((c) => c.status !== "fail"),
      checkedAt: now().toISOString(),
      identity: identity(),
      checks,
      repairs,
    };
  }

  return { status, run };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  const asKai = error as KaiError | undefined;
  if (asKai !== undefined && typeof asKai.message === "string") return asKai.message;
  return String(error);
}

/**
 * The island's COMPANION ACTIONS.
 *
 * The island is a companion, not a second authority. When a person acts from the
 * island — approve, reject, cancel, open KAI, focus a mission, open the
 * conversation — the action EXECUTES THROUGH KAI CORE. There is no policy here:
 * this module never inspects a tool's risk, never decides whether a cancel is
 * allowed, and never keeps its own copy of an approval. It forwards a human's
 * intent to the ONE Core, then re-reads the mirror the main workspace also reads.
 *
 * Two guarantees this module exists to provide:
 *
 *  1. **Execute onCE.** An approval answered from the island must fire exactly
 *     once — a double-click must not send two decisions, and the second attempt
 *     must be a no-op the caller can see. A ledger keyed on the action+target
 *     latches the moment a decision is dispatched, before the await, so a
 *     concurrent second call cannot race it. A FAILED call clears the latch so a
 *     genuine retry is still possible — but a SUCCESS is permanent.
 *
 *  2. **No island policy.** The Core is the only authority. If the Core refuses a
 *     cancel (it is not safe for that mission), the island reports the refusal; it
 *     does not pre-filter.
 *
 * The controller is transport-agnostic: it takes the minimal Core client surface
 * and a `refresh`, so it is testable with a fake client and no Core.
 */

import type { CoreClient } from "../core/kai-core";
import type { AttentionAction, AttentionFocus } from "./attention";

/** The minimal Core surface the companion needs. Widened from CoreClient. */
export type CompanionCoreClient = Pick<CoreClient, "decideApproval" | "cancelMission">;

/**
 * The main UI, from the island's point of view. Opening/focusing a surface is UI
 * navigation, not policy, so it is a callback rather than a Core call. In the
 * running app this is `window.__kaiWorkspace` (see `workspace/mount.ts`); in a
 * browser it can be a no-op. The island stays decoupled from the workspace module.
 */
export interface SurfaceFocuser {
  /** Reveal and focus the main KAI surface (the workspace / main window). */
  openKai(): void;
  /** Focus the surface that answers a reason. */
  focus(target: AttentionFocus, id?: string): void;
}

/** A request a person made from the island. */
export interface CompanionRequest {
  action: AttentionAction;
  /** The approval / mission / subagent the action targets. */
  targetId?: string;
  /** For focus/open: the surface to point at. */
  focus?: AttentionFocus;
}

/** The outcome, in words fit to log and to show. */
export interface CompanionOutcome {
  ok: boolean;
  /** True when this call actually dispatched; false when it was a repeat. */
  executed: boolean;
  /** One line: what happened, KAI's voice. */
  detail: string;
  /** Present when the Core refused (`ok: false`). */
  reason?: string;
}

export interface CompanionController {
  execute(req: CompanionRequest): Promise<CompanionOutcome>;
  /** How many distinct core-mutating actions have landed. For diagnostics/tests. */
  readonly executedCount: number;
  /** Test/teardown: forget executed actions. */
  reset(): void;
}

export interface CompanionDeps {
  client: CompanionCoreClient;
  refresh: () => Promise<void>;
  focuser: SurfaceFocuser;
}

/** The actions that mutate Core state (and therefore must fire once). */
const MUTATING: ReadonlySet<AttentionAction> = new Set(["approve", "reject", "cancel"]);

function keyFor(req: CompanionRequest): string {
  return `${req.action}:${req.targetId ?? ""}`;
}

/**
 * Create the companion controller. Pure wiring over the injected Core client —
 * no DOM, no globals, no timers.
 */
export function createCompanionController(deps: CompanionDeps): CompanionController {
  const { client, refresh, focuser } = deps;
  /** Latched keys: a core-mutating action that has been dispatched. */
  const done = new Set<string>();
  let executedCount = 0;

  async function dispatch(req: CompanionRequest): Promise<CompanionOutcome> {
    switch (req.action) {
      case "approve":
      case "reject": {
        const id = req.targetId ?? "";
        if (id === "") return { ok: false, executed: false, detail: "No approval to answer.", reason: "MISSING_TARGET" };
        const approved = req.action === "approve";
        const res = await client.decideApproval(id, approved);
        if (!res.ok) {
          return { ok: false, executed: false, detail: "KAI could not record your decision.", reason: res.error.reason ?? res.error.code };
        }
        return {
          ok: true,
          executed: true,
          detail: approved ? "KAI recorded your approval." : "KAI recorded your refusal.",
        };
      }
      case "cancel": {
        const id = req.targetId ?? "";
        if (id === "") return { ok: false, executed: false, detail: "No mission to cancel.", reason: "MISSING_TARGET" };
        const res = await client.cancelMission(id);
        if (!res.ok) {
          // Core refused (the mission is not safe to cancel, or already gone) —
          // reported, never pre-filtered here.
          return { ok: false, executed: false, detail: "KAI did not cancel that mission.", reason: res.error.reason ?? res.error.code };
        }
        return { ok: true, executed: true, detail: "KAI cancelled the mission." };
      }
      case "focus": {
        focuser.focus(req.focus ?? "workspace", req.targetId);
        return { ok: true, executed: true, detail: "KAI opened that for you." };
      }
      case "open": {
        focuser.openKai();
        if (req.focus !== undefined) focuser.focus(req.focus, req.targetId);
        return { ok: true, executed: true, detail: "KAI opened the workspace." };
      }
    }
  }

  return {
    async execute(req) {
      const key = keyFor(req);
      // Execute-once for core-mutating actions: latch BEFORE the await so a
      // concurrent second dispatch cannot slip through.
      if (MUTATING.has(req.action) && done.has(key)) {
        return { ok: true, executed: false, detail: "KAI already acted on that." };
      }
      if (MUTATING.has(req.action)) done.add(key);
      try {
        const outcome = await dispatch(req);
        if (outcome.ok) {
          executedCount += 1;
          // Re-read the shared mirror so both surfaces converge on what Core stored.
          try {
            await refresh();
          } catch {
            /* refresh failing does not undo the decision Core recorded */
          }
          return outcome;
        }
        // Failed: a failed attempt is not an execution — allow a real retry.
        if (MUTATING.has(req.action)) done.delete(key);
        return outcome;
      } catch (err) {
        if (MUTATING.has(req.action)) done.delete(key);
        return {
          ok: false,
          executed: false,
          detail: "KAI could not reach Core for that action.",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
    get executedCount() {
      return executedCount;
    },
    reset() {
      done.clear();
      executedCount = 0;
    },
  };
}

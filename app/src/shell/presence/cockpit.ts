// The Work Cockpit — the honest worker/execution console.
//
// WHAT THIS SURFACE EXISTS TO PREVENT: a single sentence on screen that lets a
// worker's own claim pass for something KAI checked. So the cockpit renders
// FOUR ledgers that are never merged, never averaged and never re-labelled:
//
//   1. TASKS KAI ASSIGNED   — Core's own board record   (GET /work-items)
//   2. REPORTED BY THE WORKER — the handoff, the worker's words, verbatim
//   3. ACTIVITY KAI OBSERVED — Core's bounded activity log (GET /activity)
//   4. VERIFICATION KAI RAN  — the verification record: the ONLY source of a PASS
//
// Every value comes from a real Core call through the typed client. There is no
// placeholder worker, no invented TODO and no synthesised activity: if Core did
// not answer, the section says so. Provenance is not decoration — it is the
// contract (`provenanceLabel`), and it is pure so it can be tested without a DOM.
//
// The badge vocabulary is the sibling Goals surface's:eligible (gp-ok), paused
// (gp-paused), blocked (gp-blocked), revise (gp-revise), neutral — plus one this
// surface adds, `gp-unverified`, because "no independent check has run" is a
// state a supervisor must be able to SEE, not infer from the absence of green.
//
// The Doer switch and Guard are read, never toggled here: flipping autonomy
// belongs to the one place that owns it, and duplicating the switch would be a
// second writer for a single durable preference.

import "./cockpit.css";
import type { ShellContext } from "../types";
import type {
  CoreActivityEvent,
  CoreBenchEntry,
  CoreDoerState,
  CoreGoalSummary,
  CoreResult,
  CoreWorkItemSummary,
  CoreWorkerHealth,
  CoreWorkerProbe,
} from "../../core/kai-core";
import { relativeTime } from "../../views/activity";

type El = HTMLElement;

// ── Pure status layer (no DOM — tested directly) ────────────────────────────

/** The badge skins. `gp-*` mirrors goals.ts; `gp-unverified` is defined in cockpit.css. */
export type BadgeClass = "gp-ok" | "gp-paused" | "gp-blocked" | "gp-revise" | "gp-neutral" | "gp-unverified";

export interface Badge {
  readonly text: string;
  readonly cls: BadgeClass;
}

/**
 * The one badge that must never overstate what KAI is allowed to do. Mirrors the
 * Goals surface, and an UNKNOWN value is shown as blocked — never as eligible.
 */
export function eligibilityBadge(eligibility: string): Badge {
  switch (eligibility) {
    case "ELIGIBLE":
      return { text: "Eligible — approved and the Doer is ON", cls: "gp-ok" };
    case "PAUSED_DOER_OFF":
      return { text: "Paused — approved, but the KAI Doer is OFF", cls: "gp-paused" };
    case "NOT_APPROVED":
      return { text: "Not approved — nothing may be dispatched", cls: "gp-blocked" };
    default:
      return { text: `Eligibility unknown to this surface (${eligibility})`, cls: "gp-blocked" };
  }
}

/** The autonomous switch, as the Core reports it. Never a guess from co-occurrence. */
export function doerBadge(state: string): Badge {
  if (state === "ON") return { text: "Doer ON — approved work may run", cls: "gp-ok" };
  if (state === "OFF") return { text: "Doer OFF — nothing is dispatched", cls: "gp-paused" };
  return { text: `Doer state unknown (${state})`, cls: "gp-blocked" };
}

/** Guard is authoritative and always active; it is reported, never toggled. */
export function guardBadge(guard: string): Badge {
  if (guard === "ON") return { text: "Guard ON — policy gates every write", cls: "gp-ok" };
  return { text: `Guard ${guard} — the Core did not report it as ON`, cls: "gp-blocked" };
}

/**
 * The pending-inbox label. With the Doer OFF the rows are PARKED — waiting, not
 * reviewed. The wording never implies KAI has looked at them.
 */
export function pendingLabel(doer: Pick<CoreDoerState, "state" | "pending">): { text: string; cls: BadgeClass; count: number } {
  const count = doer.pending.pending;
  if (doer.state === "OFF") {
    if (count > 0) return { text: `${count} parked — not yet processed`, cls: "gp-paused", count };
    return { text: "Doer OFF — nothing parked", cls: "gp-neutral", count: 0 };
  }
  if (count > 0) return { text: `Doer ON — ${count} queued for processing`, cls: "gp-revise", count };
  return { text: "Doer ON — inbox empty", cls: "gp-ok", count: 0 };
}

/** The provenance tier of one claim. */
export type ProvenanceTier = "kai-verified" | "kai-observed" | "worker-reported" | "unattributed";

/**
 * WHAT KIND OF CLAIM IS THIS?
 *
 * The one invariant this whole module is built around: `kaiVerified === false`
 * can NEVER produce the `kai-verified` tier, whatever a worker or an observation
 * says. A worker report is a report; only KAI's own check upgrades a claim.
 */
export function provenanceLabel(
  workerReported: boolean,
  kaiObserved: boolean,
  kaiVerified: boolean,
): { tier: ProvenanceTier; text: string; cls: BadgeClass } {
  if (kaiVerified) return { tier: "kai-verified", text: "KAI-verified", cls: "gp-ok" };
  if (kaiObserved) return { tier: "kai-observed", text: "KAI-observed — not verified", cls: "gp-revise" };
  if (workerReported) return { tier: "worker-reported", text: "Reported by the worker — not checked by KAI", cls: "gp-unverified" };
  return { tier: "unattributed", text: "No claim on record", cls: "gp-neutral" };
}

/**
 * The verification record's own badge. Absent and failed are different things,
 * and neither is a pass. Criteria counts come from Core, never from the handoff.
 */
export function verificationBadge(verification: CoreWorkItemSummary["verification"]): Badge {
  if (verification === undefined) return { text: "No verification recorded", cls: "gp-unverified" };
  const criteria = verification.criteria ?? [];
  const met = criteria.filter((c) => c.met).length;
  const unmet = criteria.length - met;
  if (verification.passed === true) {
    return { text: criteria.length > 0 ? `Verified by KAI — ${met}/${criteria.length} criteria met` : "Verified by KAI", cls: "gp-ok" };
  }
  if (verification.passed === false) {
    return {
      text: criteria.length > 0 ? `Verification FAILED — ${unmet}/${criteria.length} criteria unmet` : "Verification FAILED",
      cls: "gp-blocked",
    };
  }
  return { text: "Verification recorded without a verdict", cls: "gp-unverified" };
}

/** States in which a worker is, or may be, holding the item. */
export function isLiveState(state: string): boolean {
  return ["READY", "CLAIMED", "RUNNING", "WAITING", "REVIEW", "CHANGES_REQUESTED"].includes(state);
}

/**
 * A work item's headline state. A FAILED independent check dominates the item's
 * own self-reported state — "the worker says done" is not a pass.
 */
export function workItemBadge(state: string, verification: CoreWorkItemSummary["verification"]): Badge {
  if (verification?.passed === false && state !== "CANCELLED") return { text: "Verification failed", cls: "gp-blocked" };
  switch (state) {
    case "COMPLETED":
      return verification?.passed === true
        ? { text: "Completed — verified", cls: "gp-ok" }
        : { text: "Completed — UNVERIFIED", cls: "gp-unverified" };
    case "FAILED":
      return { text: "Failed", cls: "gp-blocked" };
    case "BLOCKED":
      return { text: "Blocked", cls: "gp-blocked" };
    case "CANCELLED":
      return { text: "Cancelled", cls: "gp-neutral" };
    case "CHANGES_REQUESTED":
      return { text: "Changes requested", cls: "gp-paused" };
    case "REVIEW":
      return { text: "In review", cls: "gp-paused" };
    case "WAITING":
      return { text: "Waiting", cls: "gp-paused" };
    case "CLAIMED":
      return { text: "Claimed — running", cls: "gp-revise" };
    case "RUNNING":
      return { text: "Running", cls: "gp-revise" };
    case "READY":
      return { text: "Ready — not dispatched", cls: "gp-neutral" };
    default:
      return { text: `State not recognised by this surface (${state})`, cls: "gp-unverified" };
  }
}

export function criterionBadge(status: CriterionStatus): Badge {
  if (status === "PASS") return { text: "PASS", cls: "gp-ok" };
  if (status === "FAILED") return { text: "FAILED", cls: "gp-blocked" };
  return { text: "UNVERIFIED", cls: "gp-unverified" };
}

/**
 * A worker's TRUE availability. A missing probe is `unknown` — never "available".
 * An unreachable adapter is shown with the Core's own reason beside it.
 */
export function workerAvailability(probe: CoreWorkerProbe | undefined): { text: string; cls: BadgeClass; reason: string | null } {
  if (probe === undefined) return { text: "Availability unknown — Core reported no probe", cls: "gp-unverified", reason: null };
  if (!probe.reachable) return { text: "Unavailable — adapter unreachable", cls: "gp-blocked", reason: probe.reason ?? null };
  if (probe.authorized === false) return { text: "Reachable — NOT authorized", cls: "gp-blocked", reason: probe.reason ?? null };
  return { text: "Available", cls: "gp-ok", reason: null };
}

/**
 * The next action, DERIVED from Core's own state (the work-item summary carries
 * no `nextAction` field). Callers label it as derived — it proposes, it does not
 * report.
 */
export function nextActionFor(state: string): string {
  switch (state) {
    case "READY":
      return "Dispatch it to a worker, or leave it queued.";
    case "CLAIMED":
    case "RUNNING":
      return "Wait for the worker's handoff.";
    case "WAITING":
      return "The worker is waiting — resolve what it is waiting on.";
    case "REVIEW":
      return "Review the handoff (POST /work-items/:id/review).";
    case "CHANGES_REQUESTED":
      return "Re-run the item on the worker against the review findings.";
    case "BLOCKED":
      return "A dependency or a gate is blocking — inspect the blocker.";
    case "FAILED":
      return "Inspect the failure, then retry or cancel.";
    case "COMPLETED":
      return "Nothing — confirm the verification record before treating it as done.";
    case "CANCELLED":
      return "Nothing — the item is cancelled.";
    default:
      return "Unknown state — nothing can be derived from it.";
  }
}

/** The goal a person is looking at: the newest non-terminal one, else the newest. */
export function pickActiveGoal<T extends { state: string; updatedAt: string }>(goals: readonly T[]): T | null {
  if (goals.length === 0) return null;
  const newestFirst = [...goals].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return newestFirst.find((g) => !["COMPLETED", "FAILED", "CANCELLED"].includes(g.state)) ?? newestFirst[0] ?? null;
}

export type CriterionStatus = "PASS" | "FAILED" | "UNVERIFIED";

export interface CriterionRow {
  readonly criterion: string;
  readonly status: CriterionStatus;
  readonly detail: string;
}

/**
 * Which acceptance criteria have PASSED or FAILED — from KAI's verification
 * records ONLY, and only for work items attributable to this goal's CURRENT
 * revision (matched by `taskId`, the same rule Core's executor uses).
 *
 * A criterion with no matching verification record is UNVERIFIED — never met.
 * A criterion with any unmet record is FAILED — one failing check is not
 * averaged away by a passing one.
 */
export function goalCriteriaStatuses(
  goal: Pick<CoreGoalSummary, "currentRevision">,
  items: readonly CoreWorkItemSummary[],
): CriterionRow[] {
  const revision = goal.currentRevision;
  if (revision === null) return [];
  const taskIds = new Set(revision.content.tasks.map((t) => t.id));
  const checks = new Map<string, { met: boolean; detail: string }>();
  for (const item of items) {
    if (item.taskId === undefined || !taskIds.has(item.taskId)) continue;
    for (const c of item.verification?.criteria ?? []) {
      const prev = checks.get(c.name);
      const detail = c.detail ?? "";
      if (prev === undefined) checks.set(c.name, { met: c.met, detail });
      else checks.set(c.name, prev.met && c.met ? prev : { met: false, detail: detail !== "" ? detail : prev.detail });
    }
  }
  const criteria =
    revision.content.acceptanceCriteria.length > 0
      ? revision.content.acceptanceCriteria
      : [...new Set(revision.content.tasks.flatMap((t) => t.acceptanceCriteria))];
  return criteria.map((criterion) => {
    const check = checks.get(criterion);
    if (check === undefined) return { criterion, status: "UNVERIFIED", detail: "no verification record names this criterion" };
    return { criterion, status: check.met ? "PASS" : "FAILED", detail: check.detail };
  });
}

export interface PlanTaskLink {
  readonly goalId: string;
  readonly goalStatement: string;
  readonly taskTitle: string;
  readonly dependsOn: string[];
}

/**
 * The dependency link, from the plan revision that authorised the work: the item
 * carries `taskId`, and the revision's task with that id carries `dependsOn` —
 * exactly the lookup Core's executor performs. `null` means Core reported no
 * link, which the UI states rather than guessing.
 */
export function planTaskLink(item: Pick<CoreWorkItemSummary, "taskId">, goals: readonly CoreGoalSummary[]): PlanTaskLink | null {
  if (item.taskId === undefined) return null;
  for (const goal of goals) {
    const revision = goal.currentRevision;
    if (revision === null) continue;
    const task = revision.content.tasks.find((t) => t.id === item.taskId);
    if (task === undefined) continue;
    return { goalId: goal.id, goalStatement: goal.statement, taskTitle: task.title, dependsOn: [...task.dependsOn] };
  }
  return null;
}

/** One parked inbox row, as the Doer read carries it. */
export interface ParkedEvent {
  readonly id: string;
  readonly eventType: string;
  readonly state: string;
  readonly at: string;
  readonly attempts: number;
  readonly workItemId: string | null;
}

/**
 * The parked inbox rows. `CoreDoerState` names the COUNTS; the same read also
 * carries the rows, so they are read defensively here — a malformed or absent
 * row yields no row, never a fabricated one.
 */
export function parkedEvents(doer: CoreDoerState): ParkedEvent[] {
  // `CoreDoerState` names the counts; the same read also carries the parked
  // rows. `in`-narrowing gives a checked (unknown) read instead of a cast.
  if (!("results" in doer)) return [];
  const raw: unknown = doer.results;
  if (!Array.isArray(raw)) return [];
  const rows: ParkedEvent[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const id = r["idempotencyKey"];
    const eventType = r["eventType"];
    const state = r["state"];
    if (typeof id !== "string" || typeof eventType !== "string" || typeof state !== "string") continue;
    rows.push({
      id,
      eventType,
      state,
      at: typeof r["createdAt"] === "string" ? r["createdAt"] : "",
      attempts: typeof r["attempts"] === "number" ? r["attempts"] : 0,
      workItemId: typeof r["workItemId"] === "string" ? r["workItemId"] : null,
    });
  }
  return rows;
}

// ── DOM helpers (the sibling surfaces' `el`) ────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<Record<string, unknown>>,
  children?: (El | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props !== undefined) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "text") node.textContent = String(value);
      else if (key === "class") node.className = String(value);
      else if (key === "html") node.innerHTML = String(value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else node.setAttribute(key, String(value));
    }
  }
  for (const child of children ?? []) node.append(child);
  return node;
}

function badge(b: Badge): El {
  return el("span", { class: `gp-badge ${b.cls}`, text: b.text });
}

function field(label: string, value: string | null | undefined): El {
  return el("div", { class: "gp-field" }, [
    el("span", { class: "gp-field-label", text: label }),
    el("span", { class: "gp-field-value", text: value === undefined || value === null || value === "" ? "—" : value }),
  ]);
}

function list(label: string, values: readonly string[]): El {
  return el("div", { class: "gp-field" }, [
    el("span", { class: "gp-field-label", text: label }),
    el(
      "span",
      { class: "gp-field-value" },
      values.length === 0 ? ["—"] : values.map((v) => el("span", { class: "gp-chip", text: v })),
    ),
  ]);
}

function sectionHead(title: string, note: string, p: { text: string; cls: BadgeClass }): El {
  return el("div", { class: "ck-panel-head" }, [
    el("span", { class: "ck-panel-title", text: title }),
    badge(p),
    el("div", { class: "ck-panel-note", text: note }),
  ]);
}

// ── The surface ─────────────────────────────────────────────────────────────

export interface CockpitOptions {
  /** Which goal to open on. Default: the active one Core reports. */
  goalId?: string;
  /** Called after a refresh so the shell can update its own views. */
  onChanged?: () => void;
  /** Subscribe to the shell's Core event stream for live refreshes. Default true. */
  live?: boolean;
}

export interface CockpitHandle {
  refresh(): void;
  destroy(): void;
}

/** Report a Core refusal verbatim — never as a silent no-op. */
function failureText(result: CoreResult<unknown>): string {
  if (result.ok) return "";
  const status = result.error.status === undefined ? "" : ` (HTTP ${result.error.status})`;
  return `${result.error.message}${status}`;
}

export function buildCockpitView(container: El, ctx: ShellContext, options: CockpitOptions = {}): CockpitHandle {
  const client = ctx.client;

  const strip = el("div", { class: "ck-strip" });
  const goalHost = el("div", {});
  const workersHost = el("div", {});

  const assignedBody = el("div", { class: "ck-panel-body" });
  const reportedBody = el("div", { class: "ck-panel-body" });
  const observedBody = el("div", { class: "ck-panel-body" });
  const verifiedBody = el("div", { class: "ck-panel-body" });
  const parkedBody = el("div", { class: "ck-panel-body" });

  const ledger = el("div", { class: "ck-ledger" }, [
    el("div", { class: "ck-panel" }, [
      sectionHead(
        "Tasks KAI assigned",
        "Core's own board record — what KAI put on the board, independent of anything any worker says happened.",
        provenanceLabel(false, true, false),
      ),
      assignedBody,
    ]),
    el("div", { class: "ck-panel" }, [
      sectionHead(
        "Reported by the worker",
        "The worker's own account, verbatim from its handoff. These lines are claims; KAI has not checked them.",
        provenanceLabel(true, false, false),
      ),
      reportedBody,
    ]),
    el("div", { class: "ck-panel" }, [
      sectionHead(
        "Activity KAI observed",
        "Events Core recorded while KAI was running. Observation is not verification — an observed event proves nothing was checked.",
        provenanceLabel(false, true, false),
      ),
      observedBody,
    ]),
    el("div", { class: "ck-panel" }, [
      sectionHead(
        "Verification KAI performed",
        "The only source of a PASS: checks KAI ran itself. A criterion with no record here is unverified, not met.",
        provenanceLabel(false, true, true),
      ),
      verifiedBody,
    ]),
    el("div", { class: "ck-panel ck-pending" }, [
      sectionHead(
        "Pending events (the Doer inbox)",
        "Results waiting to be interpreted. Parking means Core has NOT processed them — it does not mean KAI reviewed them.",
        provenanceLabel(false, true, false),
      ),
      parkedBody,
    ]),
  ]);

  const head = el("div", { class: "gp-head" }, [
    el("div", { class: "gp-head-title", text: "Cockpit" }),
    el("div", {
      class: "gp-head-blurb",
      text: "The work KAI dispatched, the worker's own account of it, what KAI observed, and what KAI verified — four separate ledgers, never conflated.",
    }),
  ]);
  const refreshBtn = el("button", { class: "gp-action", type: "button", text: "Refresh" });
  refreshBtn.addEventListener("click", () => {
    void refresh().then(() => options.onChanged?.());
  });

  container.replaceChildren(
    el("div", { class: "ck-shell" }, [head, el("div", { class: "gp-row" }, [refreshBtn]), strip]),
    el("div", { class: "ck-grid" }, [
      el("div", { class: "ck-col" }, [
        el("div", { class: "ck-panel" }, [
          el("div", { class: "ck-panel-head" }, [
            el("span", { class: "ck-panel-title", text: "Active goal" }),
            el("div", { class: "ck-panel-note", text: "From Core's goal store. Lifecycle state, eligibility and the criteria Core has actually verified." }),
          ]),
          goalHost,
        ]),
        el("div", { class: "ck-panel" }, [
          el("div", { class: "ck-panel-head" }, [
            el("span", { class: "ck-panel-title", text: "Workers" }),
            el("div", { class: "ck-panel-note", text: "Reachability is Core's own live probe. An adapter Core could not reach says so, with the reason it gave." }),
          ]),
          workersHost,
        ]),
      ]),
      ledger,
    ]),
  );

  function errorLine(text: string): El {
    return el("div", { class: "gp-error", text });
  }

  function emptyLine(text: string): El {
    return el("div", { class: "gp-empty", text });
  }

  // ── Workers ───────────────────────────────────────────────────────────────

  function renderWorkers(workers: CoreWorkerHealth | undefined, items: readonly CoreWorkItemSummary[], bench: readonly CoreBenchEntry[], failure: string | null): void {
    workersHost.replaceChildren();
    if (failure !== null) {
      workersHost.append(errorLine(`Core did not answer: ${failure}`));
      return;
    }
    // Every id Core named anywhere — the probe, the bench, the board — with the
    // probe Core reported for it (undefined when Core reported none).
    const known = new Map<string, CoreWorkerProbe | undefined>();
    for (const [id, probe] of Object.entries(workers ?? {})) known.set(id, probe);
    for (const entry of bench) if (!known.has(entry.profile.workerId)) known.set(entry.profile.workerId, undefined);
    for (const item of items) {
      if (item.workerId !== undefined && item.workerId !== "" && !known.has(item.workerId)) known.set(item.workerId, undefined);
    }
    if (known.size === 0) {
      workersHost.append(emptyLine("Core named no workers and reported no probe."));
      return;
    }
    for (const id of [...known.keys()].sort()) {
      const probe = known.get(id);
      const avail = workerAvailability(probe);
      const assigned = items.filter((i) => i.workerId === id && isLiveState(i.state));
      const row = el("div", { class: "ck-worker" }, [
        el("div", { class: "ck-worker-head" }, [
          el("span", { class: "ck-worker-id", text: id }),
          badge({ text: avail.text, cls: avail.cls }),
        ]),
      ]);
      if (avail.reason !== null) {
        row.append(el("div", { class: "ck-worker-reason", text: `Core's reason: ${avail.reason}` }));
      }
      const benchEntry = bench.find((b) => b.profile.workerId === id);
      const touched = items
        .filter((i): i is CoreWorkItemSummary & { updatedAt: string } => i.workerId === id && i.updatedAt !== undefined)
        .map((i) => i.updatedAt);
      const stamps = [...touched, ...(benchEntry?.profile.updatedAt !== undefined ? [benchEntry.profile.updatedAt] : [])].sort();
      const last = stamps[stamps.length - 1];
      row.append(
        field("Assigned now", assigned.length === 0 ? "nothing in flight" : assigned.map((i) => `${i.id} (${i.state})`).join(", ")),
        field("Last contact", last === undefined ? "Core recorded none" : `${relativeTime(last)} ago`),
        field(
          "Measured profile",
          benchEntry === undefined
            ? "Core reported no bench profile"
            : `value ${benchEntry.profile.overallValue?.toFixed(3) ?? "—"} · confidence ${benchEntry.profile.overallConfidence ?? "—"} · ${benchEntry.profile.totalSamples ?? 0} samples`,
        ),
      );
      for (const d of benchEntry?.recent ?? []) {
        row.append(el("div", { class: "ck-domain", text: `${d.domain} — quality ${d.quality.toFixed(2)} · verification ${d.verification.toFixed(2)} · ${d.samples} samples · ${d.confidence}` }));
      }
      workersHost.append(row);
    }
  }

  // ── Active goal ───────────────────────────────────────────────────────────

  function renderGoal(goals: readonly CoreGoalSummary[], items: readonly CoreWorkItemSummary[], failure: string | null): void {
    goalHost.replaceChildren();
    if (failure !== null) {
      goalHost.append(errorLine(`Core did not answer: ${failure}`));
      return;
    }
    const goal = options.goalId !== undefined ? goals.find((g) => g.id === options.goalId) ?? null : pickActiveGoal(goals);
    if (goal === null) {
      goalHost.append(emptyLine("Core reports no goals. Nothing has been challenged, planned or approved."));
      return;
    }
    goalHost.append(
      el("div", { class: "ck-goal-head" }, [
        el("div", { class: "ck-goal-statement", text: goal.statement }),
        badge(eligibilityBadge(goal.eligibility)),
        badge({ text: `State: ${goal.state}`, cls: "gp-neutral" }),
      ]),
    );
    goalHost.append(field("Approval", `${goal.approval.reason || "Core gave no reason"}`));
    if (goal.blocker !== undefined && goal.blocker !== "") goalHost.append(field("Blocker", goal.blocker));
    const revision = goal.currentRevision;
    goalHost.append(field("Plan", revision === null ? "no revision yet" : `revision ${revision.version} (${revision.contentHash.slice(0, 10)})`));

    const criteriaHost = el("div", { class: "ck-criteria" });
    const rows = goalCriteriaStatuses(goal, items);
    if (revision === null) {
      criteriaHost.append(emptyLine("No plan revision exists, so there are no acceptance criteria to check."));
    } else if (rows.length === 0) {
      criteriaHost.append(emptyLine("This revision states no acceptance criteria."));
    } else {
      for (const row of rows) {
        criteriaHost.append(
          el("div", { class: "ck-criterion" }, [
            el("span", { class: "ck-criterion-name", text: row.criterion }),
            badge(criterionBadge(row.status)),
            row.status === "UNVERIFIED" ? el("span", { class: "ck-criterion-detail", text: row.detail }) : el("span"),
          ]),
        );
      }
    }
    goalHost.append(el("div", { class: "gp-section-title", text: "Acceptance criteria" }), criteriaHost);
  }

  // ── Ledger 1: tasks KAI assigned ─────────────────────────────────────────

  function renderAssigned(items: readonly CoreWorkItemSummary[], goals: readonly CoreGoalSummary[], failure: string | null): void {
    assignedBody.replaceChildren();
    if (failure !== null) {
      assignedBody.append(errorLine(`Core did not answer: ${failure}`));
      return;
    }
    if (items.length === 0) {
      assignedBody.append(emptyLine("Core's board is empty — KAI has assigned no work."));
      return;
    }
    for (const item of items) {
      const link = planTaskLink(item, goals);
      const node = el("div", { class: "ck-item" }, [
        el("div", { class: "ck-item-head" }, [
          el("span", { class: "ck-item-title", text: item.objective ?? item.id }),
          badge(workItemBadge(item.state, item.verification)),
        ]),
        el("div", { class: "ck-item-meta" }, [
          el("span", { class: "mono", text: item.id }),
          el("span", { text: `worker ${item.workerId ?? "unassigned"}` }),
          el("span", { text: `attempts ${item.attempts ?? 0}` }),
          item.valueScore !== undefined ? el("span", { text: `value ${item.valueScore.toFixed(3)}` }) : el("span"),
        ]),
        field("Depends on", link === null ? "Core reported no plan link for this item" : link.dependsOn.length === 0 ? "nothing — the plan lists no dependencies" : link.dependsOn.join(", ")),
        el("div", { class: "ck-item-next" }, [
          el("span", { class: "ck-item-next-label", text: "Next action" }),
          el("span", { text: nextActionFor(item.state) }),
          el("span", { class: "ck-derived", text: "derived from Core state" }),
        ]),
        badge(verificationBadge(item.verification)),
      ]);
      if (link !== null) node.append(el("div", { class: "ck-item-link", text: `Plan task “${link.taskTitle}” in goal ${link.goalId}` }));
      if (item.handoff?.status !== undefined) {
        node.append(el("div", { class: "ck-item-link", text: `Worker handoff status: ${item.handoff.status} — see “Reported by the worker”.` }));
      }
      assignedBody.append(node);
    }
  }

  // ── Ledger 2: reported by the worker ─────────────────────────────────────

  function renderReported(items: readonly CoreWorkItemSummary[], failure: string | null): void {
    reportedBody.replaceChildren();
    if (failure !== null) {
      reportedBody.append(errorLine(`Core did not answer: ${failure}`));
      return;
    }
    const withHandoff = items.filter((i) => i.handoff !== undefined);
    if (withHandoff.length === 0) {
      reportedBody.append(emptyLine("No worker has returned a handoff. There are no worker claims to show."));
      return;
    }
    for (const item of withHandoff) {
      const h = item.handoff ?? {};
      const node = el("div", { class: "ck-report" }, [
        el("div", { class: "ck-item-head" }, [
          el("span", { class: "ck-item-title", text: item.objective ?? item.id }),
          badge(provenanceLabel(true, false, false)),
        ]),
        field("Status", h.status),
        field("Result", h.result),
        field("Tests the worker says it ran", h.tests),
        list("Evidence the worker cites", h.evidence ?? []),
        list("Blockers", h.blockers ?? []),
        list("Risks", h.risks ?? []),
        list("Follow-ups", h.followUps ?? []),
      ]);
      reportedBody.append(node);
    }
  }

  // ── Ledger 3: activity KAI observed ──────────────────────────────────────

  function renderObserved(events: readonly CoreActivityEvent[], failure: string | null): void {
    observedBody.replaceChildren();
    if (failure !== null) {
      observedBody.append(errorLine(`Core did not answer: ${failure}`));
      return;
    }
    if (events.length === 0) {
      observedBody.append(emptyLine("Core recorded no activity."));
      return;
    }
    for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
      observedBody.append(
        el("div", { class: "ck-event" }, [
          el("span", { class: "ck-event-kind mono", text: event.kind }),
          el("span", { class: "ck-event-label", text: event.label }),
          el("span", { class: "ck-event-at", text: `${relativeTime(event.at)} ago` }),
          event.detail !== undefined && event.detail !== "" ? el("div", { class: "ck-event-detail", text: event.detail }) : el("span"),
        ]),
      );
    }
  }

  // ── Ledger 4: verification KAI performed ─────────────────────────────────

  function renderVerified(items: readonly CoreWorkItemSummary[], failure: string | null): void {
    verifiedBody.replaceChildren();
    if (failure !== null) {
      verifiedBody.append(errorLine(`Core did not answer: ${failure}`));
      return;
    }
    const withVerification = items.filter((i) => i.verification !== undefined);
    if (withVerification.length === 0) {
      verifiedBody.append(
        emptyLine("No verification record exists. Nothing on the board has passed an independent check, whatever the handoffs say."),
      );
      return;
    }
    for (const item of withVerification) {
      const v = item.verification ?? {};
      const node = el("div", { class: "ck-verify" }, [
        el("div", { class: "ck-item-head" }, [
          el("span", { class: "ck-item-title", text: item.objective ?? item.id }),
          badge(verificationBadge(item.verification)),
        ]),
        el("div", { class: "ck-item-meta" }, [
          el("span", { class: "mono", text: item.id }),
          v.at !== undefined ? el("span", { text: `checked ${relativeTime(v.at)} ago` }) : el("span"),
        ]),
      ]);
      const criteria = v.criteria ?? [];
      if (criteria.length === 0) node.append(emptyLine("The check recorded a verdict but no per-criterion detail."));
      for (const c of criteria) {
        node.append(
          el("div", { class: "ck-criterion" }, [
            el("span", { class: "ck-criterion-name", text: c.name }),
            badge(c.met ? { text: "MET", cls: "gp-ok" } : { text: "NOT MET", cls: "gp-blocked" }),
            c.detail !== undefined && c.detail !== "" ? el("span", { class: "ck-criterion-detail", text: c.detail }) : el("span"),
          ]),
        );
      }
      verifiedBody.append(node);
    }
  }

  // ── The Doer strip + parked inbox ────────────────────────────────────────

  function renderDoer(doer: CoreDoerState | null, failure: string | null): void {
    strip.replaceChildren();
    parkedBody.replaceChildren();
    if (doer === null) {
      strip.append(errorLine(`Core did not answer for the Doer: ${failure ?? "unknown"}`));
      parkedBody.append(errorLine("The Doer inbox could not be read, so no pending event can be shown."));
      return;
    }
    const pending = pendingLabel(doer);
    strip.append(
      el("div", { class: "ck-switch" }, [
        el("span", { class: "ck-switch-label", text: "KAI Doer" }),
        badge(doerBadge(doer.state)),
        badge(guardBadge(doer.guard)),
        badge({ text: pending.text, cls: pending.cls }),
        el("span", { class: "ck-switch-counts", text: `inbox: ${doer.pending.pending} pending · ${doer.pending.claimed} claimed · ${doer.pending.done} done · ${doer.pending.failed} failed` }),
      ]),
    );
    parkedBody.append(el("div", { class: "ck-item-meta" }, [el("span", { text: pending.text })]));
    const rows = parkedEvents(doer);
    if (rows.length === 0) {
      parkedBody.append(emptyLine("Core listed no pending events."));
      return;
    }
    for (const row of rows) {
      parkedBody.append(
        el("div", { class: "ck-event" }, [
          el("span", { class: "ck-event-kind mono", text: row.eventType }),
          el("span", { class: "ck-event-label", text: row.workItemId ?? row.id }),
          el("span", { class: "ck-event-at", text: row.at === "" ? row.state : `${row.state} · ${relativeTime(row.at)} ago` }),
          el("div", { class: "ck-event-detail", text: row.state === "PENDING" ? "parked — not yet processed" : `state ${row.state} · ${row.attempts} attempt(s)` }),
        ]),
      );
    }
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  let busy = false;

  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const [doerRes, goalsRes, itemsRes, healthRes, benchRes, activityRes] = await Promise.all([
        client.getDoer(),
        client.listGoals(),
        client.getWorkItems({ limit: 100 }),
        client.health(),
        client.getBench(),
        client.getActivity(),
      ]);

      renderDoer(doerRes.ok ? doerRes.value : null, doerRes.ok ? null : failureText(doerRes));
      const goals = goalsRes.ok ? goalsRes.value : [];
      const items = itemsRes.ok ? itemsRes.value : [];
      const bench = benchRes.ok ? benchRes.value : [];

      renderGoal(goals, items, goalsRes.ok ? null : failureText(goalsRes));
      renderAssigned(items, goals, itemsRes.ok ? null : failureText(itemsRes));
      renderReported(items, itemsRes.ok ? null : failureText(itemsRes));
      renderObserved(activityRes.ok ? activityRes.value : [], activityRes.ok ? null : failureText(activityRes));
      renderVerified(items, itemsRes.ok ? null : failureText(itemsRes));
      renderWorkers(healthRes.ok ? healthRes.value.workers : undefined, items, bench, healthRes.ok ? null : failureText(healthRes));
    } finally {
      busy = false;
    }
  }

  // A live read of the shell's one Core stream: a new event re-reads the
  // cockpit, so a dispatch or a handoff appears without a manual refresh.
  let unsubscribe: (() => void) | null = null;
  if (options.live !== false && typeof ctx.workspace?.subscribe === "function") {
    let lastKey = "";
    let timer: number | undefined;
    unsubscribe = ctx.workspace.subscribe((slice) => {
      const key = `${slice.events.length}:${slice.actions.length}:${slice.conn}`;
      if (key === lastKey) return;
      lastKey = key;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 300);
    });
    const outer = unsubscribe;
    unsubscribe = () => {
      clearTimeout(timer);
      outer?.();
    };
  }

  void refresh();

  return {
    refresh: () => void refresh(),
    destroy: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

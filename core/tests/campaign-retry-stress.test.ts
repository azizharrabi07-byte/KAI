// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Dispatch / retry ledger STRESS + FAULT INJECTION.
 *
 * Deterministic by construction: a fixed seed drives every classification, no
 * sleeps are used anywhere, and every "wait" is a real observable (an awaited
 * port call). The suite drives the REAL orchestrator + work board over real
 * SQLite (in-memory, or a temp FILE so a "restart" is a real close/reopen)
 * with scriptable ports.
 *
 * The property: the durable dispatch ledger is the single source of truth for
 * how many worker attempts a work item has spent, and NO scheduling — 50
 * concurrent runs, 100 independent items, duplicate or reordered resume
 * events, a restart, budget exhaustion, validator worker rotation, or a
 * corrective child chain — can exceed the per-item ceiling or report a
 * gate-failed item as completed.
 *
 * Run from `core/`:  node --test tests/campaign-retry-stress.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkBoard, type WorkBoard } from "../src/orchestration/board.ts";
import { createBenchmark } from "../src/orchestration/bench.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import { createTrace } from "../src/orchestration/trace.ts";
import { createLearning } from "../src/orchestration/learn.ts";
import { evaluatingDeps } from "./learn-eval-fixture.ts";
import {
  createOrchestrator,
  type DelegateInput,
  type DelegateResult,
  type Orchestrator,
} from "../src/orchestration/orchestrator.ts";
import type { AutonomyPolicy } from "../src/orchestration/types.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";
import { createOutcomeContract } from "../src/orchestration/outcome.ts";

// ── Determinism: a FIXED seed, no RNG from the environment, no timers ────────

const SEED = "kai-retry-stress-v1";
const CONCURRENT_ON_ONE = 50;
const INDEPENDENT_ITEMS = 100;

/** Deterministic xorshift32 seeded from {@link SEED}; same stream every run. */
function prngFromSeed(seed: string): () => number {
  let s = 0;
  for (let i = 0; i < seed.length; i += 1) s = (Math.imul(s, 31) + seed.charCodeAt(i)) >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OBJ = "Make the poller stop busy-waiting";
const DELIVERABLE = "the patched poller";

function baseAutonomy(
  level: AutonomyPolicy["level"] = 2,
  maxRetries = 2,
  maxReassignments?: number,
  maxParallel = 3,
): AutonomyPolicy {
  return {
    level,
    workerAuto: "AUTO",
    review: "AUTO",
    skillLearning: "PROPOSE",
    budgets: {
      maxDepth: 2,
      maxRetries,
      ...(maxReassignments !== undefined ? { maxReassignments } : {}),
    },
    maxDepth: 2,
    maxParallel,
    taskRetentionDays: 30,
  };
}

/** A worker reply whose CHANGED ARTIFACTS name `artifact`. */
function okReply(deliverable: string, artifact = "src/a.ts"): string {
  return [
    "STATUS: ok",
    `RESULT: Delivered ${deliverable}; the work is done.`,
    `CHANGED ARTIFACTS: ${artifact}`,
    "EVIDENCE: tests pass",
    "TESTS: npm test — 18/18 passed",
    "BLOCKERS: (none)",
    "RISKS: none noted",
    "FOLLOW-UPS: none",
    "RECOMMENDED NEXT STEP: ship it",
    "TOOLS USED: read, edit",
  ].join("\n");
}

/** A reply that trips the `force[- ]push` FORBIDDEN OUTCOME (→ CONTRADICTED). */
function forbiddenReply(): string {
  return [
    "STATUS: ok",
    "RESULT: I force-push the branch and delivered the patch.",
    "CHANGED ARTIFACTS: src/a.ts",
    "EVIDENCE: tests pass",
    "BLOCKERS: (none)",
    "RISKS: none noted",
    "FOLLOW-UPS: none",
    "RECOMMENDED NEXT STEP: ship it",
    "TOOLS USED: read, edit",
  ].join("\n");
}

type ToolStub = (input: unknown, opts?: { missionId?: string; turnId?: string; source?: string; approvalId?: string }) => {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  approvalId?: string;
};

function metadataHandler(exists: boolean): ToolStub {
  return () => ({ ok: true, result: { exists, size: exists ? 123 : 0 } });
}

function shellHandler(exitCode: number, stdout = "", stderr = ""): ToolStub {
  return () => ({ ok: true, result: { exitCode, stdout, stderr } });
}

// ── The restart-capable harness ──────────────────────────────────────────────

interface HarnessState {
  autonomy: AutonomyPolicy;
  delegateQueue: DelegateResult[];
  delegateFn?: (input: DelegateInput) => DelegateResult | Promise<DelegateResult>;
  delegateCalls: DelegateInput[];
  reviewQueue: { verdict: "PASS" | "CHANGES_REQUESTED" | "BLOCKED"; findings: string[] }[];
  approvals: Map<string, string>;
  toolHandlers: Record<string, ToolStub>;
  policyOutcome: "allow" | "deny" | "needs_approval";
}

interface Harness {
  orch: Orchestrator;
  board: WorkBoard;
  published: { type: string; payload: unknown }[];
  state: HarnessState;
  close(): void;
}

// Approval ids are unique across the WHOLE run (not per harness): a "restart"
// must not reissue an id a previous process already consumed, or a dedupe
// check would fire for the wrong reason.
let approvalSeq = 0;

function harness(opts: {
  dbPath?: string;
  level?: AutonomyPolicy["level"];
  maxRetries?: number;
  maxReassignments?: number;
  maxParallel?: number;
  review?: "AUTO" | "ASK" | "OFF";
} = {}): Harness {
  const stores = openSqliteStores({ path: opts.dbPath ?? ":memory:" });
  const board = createWorkBoard(stores.workItems);
  const bench = createBenchmark(stores.workerProfiles);
  const dispatcher = createDispatcher({
    bench,
    availability: () => ["worker-1", "worker-2", "worker-3", "worker-4", "worker-5"],
    capabilities: () => ({ skills: ["typescript", "testing"], tools: ["read", "edit", "shell"] }),
  });
  const trace = createTrace({ store: stores.activity, prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }) as const });
  const learning = createLearning({ metrics: stores.skillMetrics, validate: () => ({ ok: true }), stage: () => ({ ok: true }), ...evaluatingDeps() });
  const published: { type: string; payload: unknown }[] = [];
  const state: HarnessState = {
    autonomy: {
      ...baseAutonomy(opts.level ?? 2, opts.maxRetries ?? 2, opts.maxReassignments, opts.maxParallel ?? 3),
      review: opts.review ?? "AUTO",
    },
    delegateQueue: [],
    delegateCalls: [],
    reviewQueue: [],
    approvals: new Map<string, string>(),
    toolHandlers: {},
    policyOutcome: "allow",
  };
  const orch = createOrchestrator({
    board,
    bench,
    dispatcher,
    trace,
    learning,
    patterns: stores.promptPatterns,
    reviewRunner: async () => state.reviewQueue.shift() ?? { verdict: "PASS", findings: [] },
    delegate: async (input: DelegateInput): Promise<DelegateResult> => {
      state.delegateCalls.push(input);
      if (state.delegateFn !== undefined) return state.delegateFn(input);
      return state.delegateQueue.shift() ?? { ok: true, reply: okReply(DELIVERABLE) };
    },
    skills: {
      relevant: () => [],
      load: () => ({ ok: false, reason: "no skills in this suite" }),
      inspect: () => null,
    },
    policyCheck: async () => ({ outcome: state.policyOutcome, reason: `policy says ${state.policyOutcome}` }),
    approvals: {
      request: () => {
        approvalSeq += 1;
        const id = `appr_${approvalSeq}`;
        state.approvals.set(id, "PENDING");
        return { id };
      },
      get: (id: string) => {
        const status = state.approvals.get(id);
        return status === undefined ? null : { status };
      },
    },
    autonomy: () => state.autonomy,
    publish: (type: string, payload: unknown) => {
      published.push({ type, payload });
    },
    tools: {
      invoke: async (id, input, o) => {
        const handler = state.toolHandlers[id];
        if (handler !== undefined) return handler(input, o);
        return { ok: true, result: {} };
      },
    },
    rememberLesson: () => ({ ok: true }),
  });
  return { orch, board, published, state, close: () => stores.close() };
}

// ── Ledger / event readers ───────────────────────────────────────────────────

interface DispatchRecord {
  workerId: string;
  kind: "initial" | "retry" | "reassign";
  at: string;
}

function outputsOf(h: Harness, id: string): Record<string, unknown> {
  const outputs = h.board.get(id)?.outputs;
  return outputs !== null && typeof outputs === "object" && !Array.isArray(outputs)
    ? (outputs as Record<string, unknown>)
    : {};
}

function ledgerOf(h: Harness, id: string): DispatchRecord[] {
  const raw = outputsOf(h, id)["dispatches"];
  return Array.isArray(raw) ? (raw as DispatchRecord[]) : [];
}

function resumeKeysOf(h: Harness, id: string): string[] {
  const raw = outputsOf(h, id)["resumeKeys"];
  return Array.isArray(raw) ? (raw as string[]) : [];
}

/** The work item ids referenced by every `worker.completed` event. */
function completedEventIds(h: Harness): string[] {
  const ids: string[] = [];
  for (const event of h.published) {
    if (event.type !== "worker.completed") continue;
    const payload = event.payload as { workItemId?: unknown; id?: unknown } | null;
    const id = payload?.workItemId ?? payload?.id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

// ── Invariant table (printed, then asserted) ─────────────────────────────────

interface InvariantRow {
  invariant: string;
  held: boolean;
  evidence: string;
}

function renderTable(title: string, rows: InvariantRow[]): void {
  const failed = rows.filter((r) => !r.held).length;
  const lines = [
    "",
    `══ INVARIANT TABLE :: ${title} ══`,
    "held?  | invariant | evidence",
    ...rows.map((r) => `${r.held ? "HELD " : "FAIL "} | ${r.invariant} | ${r.evidence}`),
    `── ${rows.length - failed}/${rows.length} held${failed > 0 ? ` — ${failed} VIOLATION(S)` : ""} ──`,
  ];
  console.log(lines.join("\n"));
}

function assertTable(rows: InvariantRow[]): void {
  for (const row of rows) {
    assert.ok(row.held, `INVARIANT VIOLATED: ${row.invariant} — ${row.evidence}`);
  }
}

/** A temp dir + db path that a test must clean up itself. */
function tempDb(tag: string): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `kai-retry-stress-${tag}-`));
  return { dir, dbPath: join(dir, "core.db") };
}

function cleanup(dir: string): void {
  // Best-effort: Windows may still hold the freshly written SQLite file. A
  // failure here must NEVER mask the real assertion result.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Left for the OS temp cleaner; the test result is what matters.
  }
}

// ══ S1. 50 concurrent runs on ONE item ═══════════════════════════════════════

test("S1 — 50 concurrent runWorkItem on ONE item dispatch exactly once", async () => {
  const h = harness();
  try {
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    const id = started.workItemId;

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_ON_ONE }, () => h.orch.runWorkItem(id, { workerId: "worker-1" })),
    );

    const ledger = ledgerOf(h, id);
    const delegates = h.state.delegateCalls.length;
    const completed = outcomes.filter((o) => o.state === "COMPLETED").length;
    const refused = outcomes.filter((o) => /already (CLAIMED|RUNNING)/.test(o.note)).length;

    const rows: InvariantRow[] = [
      { invariant: "exactly ONE delegate dispatch for 50 concurrent runs", held: delegates === 1, evidence: `delegateCalls=${delegates}` },
      { invariant: "ledger length is exactly 1", held: ledger.length === 1, evidence: `dispatches=${JSON.stringify(ledger.map((d) => [d.workerId, d.kind]))}` },
      { invariant: "exactly one run performs the work", held: completed === 1, evidence: `COMPLETED outcomes=${completed}` },
      { invariant: "the other 49 are refused as duplicate dispatch", held: refused === CONCURRENT_ON_ONE - 1, evidence: `duplicate-refusals=${refused}` },
      { invariant: "final board state is COMPLETED (gate passed once)", held: h.board.get(id)?.state === "COMPLETED", evidence: `state=${h.board.get(id)?.state}` },
      { invariant: "one dispatch ⇒ one `worker.started` ledger entry", held: ledger.filter((d) => d.kind === "initial").length === 1, evidence: `initial=${ledger.filter((d) => d.kind === "initial").length}` },
    ];
    renderTable("S1 — 50 concurrent on one item", rows);
    assertTable(rows);
  } finally {
    h.close();
  }
});

// ══ S2. 100 independent items, driven concurrently ═══════════════════════════

interface ItemVector {
  id: string;
  expectPass: boolean;
  finalState: string | undefined;
  outcomeState: string;
  completedEvents: number;
}

/** Drive 100 independent items concurrently; return the invariant table + vector. */
async function driveHundredAsync(): Promise<{
  rows: InvariantRow[];
  vectors: ItemVector[];
  delegateCalls: number;
}> {
  const h = harness();
  try {
    const rnd = prngFromSeed(SEED);
    const specs: { id: string; expectPass: boolean }[] = [];
    for (let i = 0; i < INDEPENDENT_ITEMS; i += 1) {
      const pass = (rnd() & 1) === 1;
      const started = h.orch.startObjective(
        { objective: `task ${i} MODE-${pass ? "PASS" : "FAIL"} ${OBJ}`, deliverable: DELIVERABLE },
        ["worker-1"],
      );
      specs.push({ id: started.workItemId, expectPass: pass });
    }
    h.state.delegateFn = (input) =>
      input.prompt.includes("MODE-FAIL")
        ? { ok: false, error: "injected worker fault (deterministic)" }
        : { ok: true, reply: okReply(DELIVERABLE) };

    const results = await Promise.all(specs.map((s) => h.orch.runWorkItem(s.id, { workerId: "worker-1" })));
    const completedIds = completedEventIds(h);
    const completedPerItem = new Map<string, number>();
    for (const id of completedIds) completedPerItem.set(id, (completedPerItem.get(id) ?? 0) + 1);

    const vectors: ItemVector[] = specs.map((s, i) => ({
      id: s.id,
      expectPass: s.expectPass,
      finalState: h.board.get(s.id)?.state,
      outcomeState: results[i]?.state ?? "MISSING",
      completedEvents: completedPerItem.get(s.id) ?? 0,
    }));

    const truthful = vectors.filter(
      (v) => v.finalState === (v.expectPass ? "COMPLETED" : "FAILED") && v.outcomeState === v.finalState,
    ).length;
    const falseCompletion = vectors.filter((v) => !v.expectPass && v.completedEvents > 0);
    const missingCompletion = vectors.filter((v) => v.expectPass && v.completedEvents === 0);

    const rows: InvariantRow[] = [
      { invariant: "all 100 items reach a truthful terminal state", held: truthful === INDEPENDENT_ITEMS, evidence: `truthful=${truthful}/${INDEPENDENT_ITEMS}` },
      { invariant: "exactly one dispatch per item (100 total)", held: h.state.delegateCalls.length === INDEPENDENT_ITEMS, evidence: `delegateCalls=${h.state.delegateCalls.length}` },
      {
        invariant: "NO `worker.completed` for any item whose gate did not pass",
        held: falseCompletion.length === 0,
        evidence: falseCompletion.length === 0
          ? "0 gate-failed items emitted worker.completed"
          : `DEFECT: ${falseCompletion.length} gate-failed item(s) emitted worker.completed: ${JSON.stringify(falseCompletion.map((v) => [v.id, v.finalState, v.completedEvents]).slice(0, 5))}`,
      },
      {
        invariant: "every gate-PASSED (COMPLETED) item did emit `worker.completed`",
        held: missingCompletion.length === 0,
        evidence: missingCompletion.length === 0 ? "all COMPLETED items emitted it" : `missing for ${missingCompletion.length} item(s)`,
      },
    ];
    return { rows, vectors, delegateCalls: h.state.delegateCalls.length };
  } finally {
    h.close();
  }
}

test("S2 — 100 independent items: truthful terminals, no false worker.completed", async () => {
  const first = await driveHundredAsync();
  renderTable("S2 — 100 independent items", first.rows);
  assertTable(first.rows);

  // Determinism: the same fixed seed reproduces the same vector on re-run.
  const second = await driveHundredAsync();
  const fingerprint = (vs: ItemVector[]): string => JSON.stringify(vs.map((v) => [v.expectPass, v.finalState, v.outcomeState, v.completedEvents]));
  const rows: InvariantRow[] = [
    {
      invariant: "re-run with the same seed yields an identical result vector",
      held: fingerprint(first.vectors) === fingerprint(second.vectors),
      evidence: `passItems=${first.vectors.filter((v) => v.expectPass).length} failItems=${first.vectors.filter((v) => !v.expectPass).length} identical=${fingerprint(first.vectors) === fingerprint(second.vectors)}`,
    },
    { invariant: "dispatch count is stable across runs", held: first.delegateCalls === second.delegateCalls && first.delegateCalls === INDEPENDENT_ITEMS, evidence: `${first.delegateCalls} vs ${second.delegateCalls}` },
  ];
  renderTable("S2b — determinism", rows);
  assertTable(rows);
});

// ══ S3. Duplicate + out-of-order resumeEventId delivery ══════════════════════

test("S3 — duplicate and out-of-order resumeEventId never consume/grant wrongly", async () => {
  const h = harness({ maxRetries: 2, maxReassignments: 0 });
  try {
    h.state.delegateFn = () => ({ ok: false, error: "injected fault" });
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    const id = started.workItemId;

    const call = (key: string) => h.orch.runWorkItem(id, { workerId: "worker-1", resumeEventId: key });
    const sizes: number[] = [];
    const step = async (key: string) => {
      const out = await call(key);
      sizes.push(ledgerOf(h, id).length);
      return out;
    };

    const first = await step("e10"); // consumes the initial attempt
    const d1 = await step("e10"); // exact duplicate
    const o1 = await step("e05"); // an OLDER, never-seen id, delivered late
    const d2 = await step("e05"); // duplicate of the late-arriving id
    const d3 = await step("e10"); // the original again, after a newer key
    const newer = await step("e99"); // a genuinely new key
    const exhausted = await step("e100"); // new key, but the ceiling is spent
    const dupAfterBlock = await step("e99"); // duplicate on a blocked item

    const ledger = ledgerOf(h, id);
    const retries = ledger.filter((d) => d.kind === "retry").length;
    const reassign = ledger.filter((d) => d.kind === "reassign").length;

    const rows: InvariantRow[] = [
      { invariant: "the initial delivery consumes exactly one attempt", held: sizes[0] === 1 && first.state === "FAILED", evidence: `ledger after first=1, state=${first.state}` },
      { invariant: "an exact duplicate consumes NOTHING", held: sizes[1] === 1 && d1.note.includes("duplicate delivery"), evidence: `ledger=${sizes[1]} note="${d1.note}"` },
      { invariant: "an out-of-order (older) never-seen id is treated as a NEW delivery (consumes 1)", held: sizes[2] === 2 && o1.state === "FAILED", evidence: `ledger=${sizes[2]} state=${o1.state}` },
      { invariant: "a duplicate of the late-arriving id consumes NOTHING", held: sizes[3] === 2 && d2.note.includes("duplicate delivery"), evidence: `ledger=${sizes[3]} note="${d2.note}"` },
      { invariant: "the original id redelivered after a newer key is still a duplicate", held: sizes[4] === 2 && d3.note.includes("duplicate delivery"), evidence: `ledger=${sizes[4]} note="${d3.note}"` },
      { invariant: "a genuinely new key consumes exactly one attempt", held: sizes[5] === 3 && newer.state === "FAILED", evidence: `ledger=${sizes[5]} state=${newer.state}` },
      {
        invariant: "same-worker retries ≤ maxRetries(2) and reassignments ≤ maxReassignments(0)",
        held: retries <= 2 && reassign <= 0,
        evidence: `retries=${retries}/2 reassignments=${reassign}/0`,
      },
      { invariant: "total dispatches ≤ 1+maxRetries+maxReassignments = 3", held: ledger.length <= 3, evidence: `total=${ledger.length}` },
      { invariant: "an over-budget new key is refused as BLOCKED (never COMPLETED)", held: sizes[6] === 3 && exhausted.state === "BLOCKED", evidence: `ledger=${sizes[6]} state=${exhausted.state} note="${exhausted.note}"` },
      { invariant: "the refused key consumes nothing (no new dispatch)", held: h.state.delegateCalls.length === 3, evidence: `delegateCalls=${h.state.delegateCalls.length}` },
      { invariant: "a duplicate on an exhausted/blocked item does not un-block it", held: sizes[7] === 3 && dupAfterBlock.state === "BLOCKED" && dupAfterBlock.note.includes("duplicate delivery"), evidence: `ledger=${sizes[7]} state=${dupAfterBlock.state} note="${dupAfterBlock.note}"` },
      { invariant: "the item is never COMPLETED on an all-failing path", held: [first, o1, newer, exhausted].every((o) => o.state !== "COMPLETED"), evidence: `outcomes=${[first, o1, newer, exhausted].map((o) => o.state).join(",")}` },
    ];
    renderTable("S3 — duplicate / out-of-order resume keys", rows);
    assertTable(rows);
  } finally {
    h.close();
  }
});

test("S3b — the SAME brand-new key delivered concurrently consumes exactly once", async () => {
  const h = harness({ maxRetries: 2, maxReassignments: 0 });
  try {
    h.state.delegateFn = () => ({ ok: false, error: "injected fault" });
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    const id = started.workItemId;

    await Promise.all(Array.from({ length: 12 }, () => h.orch.runWorkItem(id, { workerId: "worker-1", resumeEventId: "evtC" })));

    const ledger = ledgerOf(h, id);
    const rows: InvariantRow[] = [
      { invariant: "12 concurrent deliveries of one key consume exactly ONE attempt", held: ledger.length === 1, evidence: `dispatches=${ledger.length}` },
      { invariant: "exactly one dispatch reached the worker", held: h.state.delegateCalls.length === 1, evidence: `delegateCalls=${h.state.delegateCalls.length}` },
      { invariant: "the key is recorded once", held: resumeKeysOf(h, id).filter((k) => k === "evtC").length === 1, evidence: `resumeKeys=${JSON.stringify(resumeKeysOf(h, id))}` },
    ];
    renderTable("S3b — concurrent duplicate key", rows);
    assertTable(rows);
  } finally {
    h.close();
  }
});

// ══ S4. Restart between phases ═══════════════════════════════════════════════

test("S4a — restart between claim and dispatch: claim + ledger are durable first", async () => {
  const { dir, dbPath } = tempDb("restart-claim");
  let id = "";
  try {
    const h1 = harness({ dbPath });
    let resolveInvoked!: () => void;
    const invoked = new Promise<void>((r) => {
      resolveInvoked = r;
    });
    h1.state.delegateFn = () => {
      resolveInvoked();
      return new Promise<DelegateResult>(() => {
        /* never settles: the process "crashes" mid-dispatch */
      });
    };
    const started = h1.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" },
      ["worker-1"],
    );
    id = started.workItemId;

    // Fire the run WITHOUT awaiting; synchronously the claim + ledger entry are
    // already persisted (they happen before the first await).
    void h1.orch.runWorkItem(id, { workerId: "worker-1" });
    const mid = h1.board.get(id);
    assert.equal(mid?.state, "RUNNING", "the claim is durable before the worker is invoked");
    assert.equal(ledgerOf(h1, id).length, 1, "the ledger records the dispatch before the delegate runs");

    await invoked; // deterministic wait: the run reached the delegate port
    assert.equal(h1.state.delegateCalls.length, 1, "the pending run is now parked at the delegate port");
    h1.close();

    // REAL restart: a NEW orchestrator + stores over the same FILE.
    const h2 = harness({ dbPath });
    try {
      const item = h2.board.get(id);
      const ledger = ledgerOf(h2, id);
      // The Outcome Contract object is materialized lazily at GATE time, so a
      // run interrupted before the delegate returns has none yet; what must be
      // durable are the CONTRACT INPUTS it is built from. Rebuild it here and
      // check the shape is exactly what the original objective demanded.
      const rebuilt = createOutcomeContract({
        missionId: item?.id ?? id,
        intent: item?.objective ?? OBJ,
        deliverables: [DELIVERABLE],
        requiredEvidence: [...(item?.requiredEvidence ?? [])],
      });
      const rows: InvariantRow[] = [
        { invariant: "the CLAIMED/RUNNING state survived the restart", held: item?.state === "RUNNING", evidence: `state=${item?.state}` },
        { invariant: "the in-flight dispatch entry survived the restart", held: ledger.length === 1, evidence: `dispatches=${JSON.stringify(ledger.map((d) => [d.workerId, d.kind]))}` },
        {
          invariant: "the durable contract INPUTS survived (contract rebuilds identically)",
          held: JSON.stringify(rebuilt.requiredEvidence) === JSON.stringify(["file present: src/a.ts"]) && rebuilt.acceptanceCriteria.length === 1 && item?.deliverable === DELIVERABLE,
          evidence: `requiredEvidence=${JSON.stringify(rebuilt.requiredEvidence)} acceptanceCriteria=${JSON.stringify(rebuilt.acceptanceCriteria)} deliverable=${item?.deliverable}`,
        },
        { invariant: "no handoff is fabricated for an unfinished dispatch", held: item?.handoff === undefined, evidence: `handoff=${item?.handoff === undefined ? "absent" : "PRESENT (unexpected)"}` },
        { invariant: "the restarted orchestrator dispatches nothing on its own", held: h2.state.delegateCalls.length === 0, evidence: `delegateCalls=${h2.state.delegateCalls.length}` },
      ];
      renderTable("S4a — restart mid-dispatch", rows);
      assertTable(rows);
    } finally {
      h2.close();
    }
  } finally {
    cleanup(dir);
  }
});

test("S4b — restart between dispatch and completion: settlement survives, nothing replays", async () => {
  const { dir, dbPath } = tempDb("restart-complete");
  let id = "";
  try {
    const h1 = harness({ dbPath });
    h1.state.toolHandlers["filesystem.metadata"] = metadataHandler(true);
    const started = h1.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" },
      ["worker-1"],
    );
    id = started.workItemId;
    const first = await h1.orch.runWorkItem(id, { workerId: "worker-1", resumeEventId: "evt_1" });
    assert.equal(first.state, "COMPLETED", `the first run must complete through the gate: ${first.note}`);
    const completedBefore = completedEventIds(h1).filter((x) => x === id).length;
    h1.close();

    const h2 = harness({ dbPath });
    try {
      const item = h2.board.get(id);
      const ledger = ledgerOf(h2, id);
      const evidence = item?.evidence ?? [];
      const rows: InvariantRow[] = [
        { invariant: "the COMPLETED state survived the restart", held: item?.state === "COMPLETED", evidence: `state=${item?.state}` },
        { invariant: "the dispatch ledger survived (length 1)", held: ledger.length === 1, evidence: `dispatches=${JSON.stringify(ledger.map((d) => [d.workerId, d.kind]))}` },
        { invariant: "the resume key survived", held: resumeKeysOf(h2, id).includes("evt_1"), evidence: `resumeKeys=${JSON.stringify(resumeKeysOf(h2, id))}` },
        { invariant: "the handoff survived with its result", held: (item?.handoff?.result ?? "").length > 0, evidence: `result="${(item?.handoff?.result ?? "").slice(0, 60)}"` },
        { invariant: "the KAI-observed evidence survived", held: evidence.some((e) => e.source === "kai-observed"), evidence: `observed=${evidence.filter((e) => e.source === "kai-observed").length} of ${evidence.length}` },
        { invariant: "the Outcome Contract survived", held: outputsOf(h2, id)["contract"] !== undefined, evidence: `contract=${outputsOf(h2, id)["contract"] === undefined ? "MISSING" : "present"}` },
        { invariant: "the completion was reported exactly once before the restart", held: completedBefore >= 1, evidence: `worker.completed events for item=${completedBefore}` },
      ];
      renderTable("S4b — restart after completion (state)", rows);
      assertTable(rows);

      const dup = await h2.orch.runWorkItem(id, { workerId: "worker-1", resumeEventId: "evt_1" });
      const rerun = await h2.orch.runWorkItem(id, { workerId: "worker-1" });
      const after = completedEventIds(h2).filter((x) => x === id).length;
      const rows2: InvariantRow[] = [
        { invariant: "redelivering the consumed resume key is a no-op", held: dup.note.includes("duplicate delivery"), evidence: `note="${dup.note}"` },
        { invariant: "re-running a settled item is refused (reports COMPLETED)", held: rerun.state === "COMPLETED" && /already COMPLETED|create a new item/i.test(rerun.note), evidence: `state=${rerun.state} note="${rerun.note}"` },
        { invariant: "NO second dispatch happens after the restart", held: h2.state.delegateCalls.length === 0, evidence: `delegateCalls=${h2.state.delegateCalls.length}` },
        { invariant: "the ledger did not grow", held: ledgerOf(h2, id).length === 1, evidence: `dispatches=${ledgerOf(h2, id).length}` },
        { invariant: "no completion event is emitted post-restart", held: after === 0, evidence: `post-restart worker.completed=${after}` },
      ];
      renderTable("S4b — restart after completion (no replay)", rows2);
      assertTable(rows2);
    } finally {
      h2.close();
    }
  } finally {
    cleanup(dir);
  }
});

test("S4c — restart between evidence collection/approval park: resume gathers, never re-dispatches", async () => {
  const { dir, dbPath } = tempDb("restart-evidence");
  let id = "";
  let approvalId = "";
  try {
    const h1 = harness({ dbPath });
    const started = h1.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, successCriteria: ["tests pass"], requiredEvidence: ["npm test"], workingDir: "C:/tmp/project" },
      ["worker-1"],
    );
    id = started.workItemId;
    const parked = await h1.orch.runWorkItem(id, { workerId: "worker-1" });
    assert.equal(parked.state, "WAITING", `the guarded check must park pending approval: ${parked.note}`);
    approvalId = parked.parkedApprovalId as string;
    assert.ok(approvalId.length > 0, "a parked approval id is required for this scenario");
    h1.close();

    const h2 = harness({ dbPath });
    h2.state.toolHandlers["shell.run"] = shellHandler(0, "18/18 passed", "");
    try {
      const item = h2.board.get(id);
      const parkedOutputs = outputsOf(h2, id)["parked"] as { approvalId?: string } | undefined;
      const pending = outputsOf(h2, id)["pendingEvidence"] as { labels?: string[] } | undefined;
      const rows: InvariantRow[] = [
        { invariant: "the WAITING (evidence-park) state survived", held: item?.state === "WAITING", evidence: `state=${item?.state}` },
        { invariant: "the parked approval linkage survived", held: parkedOutputs?.approvalId === approvalId, evidence: `parked.approvalId=${parkedOutputs?.approvalId}` },
        { invariant: "the pending evidence labels survived", held: (pending?.labels ?? []).includes("npm test"), evidence: `labels=${JSON.stringify(pending?.labels ?? [])}` },
        { invariant: "the handoff survived", held: item?.handoff !== undefined, evidence: `handoff=${item?.handoff === undefined ? "MISSING" : "present"}` },
        { invariant: "the single dispatch entry survived", held: ledgerOf(h2, id).length === 1, evidence: `dispatches=${ledgerOf(h2, id).length}` },
      ];
      renderTable("S4c — restart at evidence park (state)", rows);
      assertTable(rows);

      const decided = await h2.orch.onApprovalDecided(approvalId, true);
      const after = h2.board.get(id);
      const evidence = after?.evidence ?? [];
      const rows2: InvariantRow[] = [
        { invariant: "the approval resumes the parked evidence round", held: decided.handled >= 1, evidence: `handled=${decided.handled}` },
        { invariant: "the resumed item COMPLETES through the gate", held: after?.state === "COMPLETED", evidence: `state=${after?.state}` },
        { invariant: "NO second dispatch happens on resume", held: h2.state.delegateCalls.length === 0, evidence: `delegateCalls=${h2.state.delegateCalls.length}` },
        { invariant: "the ledger is still 1 (resume is not a dispatch)", held: ledgerOf(h2, id).length === 1, evidence: `dispatches=${ledgerOf(h2, id).length}` },
        { invariant: "the resume key for the approval is recorded", held: resumeKeysOf(h2, id).includes(`approval:${approvalId}`), evidence: `resumeKeys=${JSON.stringify(resumeKeysOf(h2, id))}` },
        { invariant: "KAI-observed test evidence settled the requirement", held: evidence.some((e) => e.source === "kai-observed" && e.supports.includes("npm test")), evidence: `observed-with-support=${evidence.filter((e) => e.source === "kai-observed" && e.supports.includes("npm test")).length}` },
      ];
      renderTable("S4c — restart at evidence park (resume)", rows2);
      assertTable(rows2);
    } finally {
      h2.close();
    }
  } finally {
    cleanup(dir);
  }
});

test("S4d — restart between review (review=ASK park): resume must not re-dispatch the worker", async () => {
  const { dir, dbPath } = tempDb("restart-review");
  let id = "";
  let approvalId = "";
  try {
    const h1 = harness({ dbPath, review: "ASK" });
    h1.state.delegateFn = () => ({ ok: true, reply: okReply(DELIVERABLE) });
    const started = h1.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    id = started.workItemId;
    const parked = await h1.orch.runWorkItem(id, { workerId: "worker-1" });
    assert.equal(parked.state, "REVIEW", `review=ASK must park for a human: ${parked.note}`);
    approvalId = parked.parkedApprovalId as string;
    assert.ok(approvalId.length > 0, "a parked approval id is required for this scenario");
    const dispatchedBefore = h1.state.delegateCalls.length;
    h1.close();

    const h2 = harness({ dbPath, review: "ASK" });
    h2.state.delegateFn = () => ({ ok: true, reply: okReply(DELIVERABLE) });
    try {
      const item = h2.board.get(id);
      const parkedOutputs = outputsOf(h2, id)["parked"] as { approvalId?: string; kind?: string } | undefined;
      const rows: InvariantRow[] = [
        { invariant: "the REVIEW park state survived", held: item?.state === "REVIEW", evidence: `state=${item?.state}` },
        { invariant: "the parked review approval linkage survived", held: parkedOutputs?.approvalId === approvalId && parkedOutputs?.kind === "review", evidence: `parked=${JSON.stringify(parkedOutputs)}` },
        { invariant: "the handoff survived", held: item?.handoff !== undefined, evidence: `handoff=${item?.handoff === undefined ? "MISSING" : "present"}` },
        { invariant: "the single dispatch entry survived", held: ledgerOf(h2, id).length === 1, evidence: `dispatches=${ledgerOf(h2, id).length}` },
      ];
      renderTable("S4d — restart at review park (state)", rows);
      assertTable(rows);

      const decided = await h2.orch.onApprovalDecided(approvalId, true);
      const afterFirst = h2.board.get(id);
      const ledgerAfter = ledgerOf(h2, id).length;
      const dispatchesAfter = h2.state.delegateCalls.length;
      const reParked = (outputsOf(h2, id)["parked"] as { approvalId?: string; kind?: string } | undefined)?.approvalId;
      // Approve the (re-)parked review once more to expose whether the resume
      // makes progress or loops. This is deterministic: no timers involved.
      let secondState = afterFirst?.state;
      let secondDispatches = dispatchesAfter;
      let secondLedger = ledgerAfter;
      if (afterFirst?.state === "REVIEW" && typeof reParked === "string" && reParked.length > 0) {
        await h2.orch.onApprovalDecided(reParked, true);
        secondState = h2.board.get(id)?.state;
        secondDispatches = h2.state.delegateCalls.length;
        secondLedger = ledgerOf(h2, id).length;
      }
      const completedOnResume = completedEventIds(h2).filter((x) => x === id).length;

      const rows2: InvariantRow[] = [
        { invariant: "the approval is handled exactly once", held: decided.handled === 1, evidence: `handled=${decided.handled}` },
        { invariant: "resuming a REVIEW park does NOT re-dispatch the worker", held: dispatchesAfter === 0, evidence: `dispatchesAfterResume=${dispatchesAfter} (pre-restart dispatches=${dispatchedBefore})` },
        { invariant: "resuming a REVIEW park does not consume another attempt", held: ledgerAfter === 1, evidence: `ledger=${ledgerAfter} → ${JSON.stringify(ledgerOf(h2, id).map((d) => [d.workerId, d.kind]))}` },
        { invariant: "resuming does not silently re-park / loop", held: afterFirst?.state !== "REVIEW", evidence: `stateAfterResume=${afterFirst?.state} reParkedApproval=${reParked}` },
        { invariant: "approving a review park makes PROGRESS (completes) rather than looping", held: secondState === "COMPLETED" && completedOnResume > 0, evidence: `after 2nd approval: state=${secondState} dispatches=${secondDispatches} ledger=${secondLedger} worker.completed=${completedOnResume}` },
        { invariant: "no COMPLETED is claimed without the gate passing", held: completedOnResume === 0 || secondState === "COMPLETED", evidence: `completedOnResume=${completedOnResume} state=${secondState}` },
      ];
      renderTable("S4d — restart at review park (resume)", rows2);
      assertTable(rows2);
    } finally {
      h2.close();
    }
  } finally {
    cleanup(dir);
  }
});

// ══ S5. Budget invariants under rotation ═════════════════════════════════════

test("S5 — budget ceilings bind the item under worker rotation", async () => {
  const h = harness({ maxRetries: 3, maxReassignments: 1 });
  try {
    h.state.delegateFn = () => ({ ok: false, error: "injected fault" });
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    const id = started.workItemId;

    const sequence = [
      "worker-1", // initial
      "worker-1", // retry 1
      "worker-1", // retry 2
      "worker-1", // retry 3 (budget spent)
      "worker-2", // reassign 1 (budget spent)
      "worker-2", // refused: retries spent
      "worker-1", // refused: reassignments spent
      "worker-3", // refused: reassignments spent
      "worker-1", // refused: reassignments spent
    ];
    const outcomes = [];
    const totals: number[] = [];
    for (const workerId of sequence) {
      outcomes.push(await h.orch.runWorkItem(id, { workerId }));
      totals.push(ledgerOf(h, id).length);
    }
    const ledger = ledgerOf(h, id);
    const retries = ledger.filter((d) => d.kind === "retry").length;
    const reassign = ledger.filter((d) => d.kind === "reassign").length;
    const maxTotal = 1 + 3 + 1;

    // Extra rotation must buy nothing.
    const dispatchesAtCeiling = h.state.delegateCalls.length;
    const rotation = [];
    for (const workerId of ["worker-4", "worker-5", "worker-2", "worker-1", "worker-3"]) {
      rotation.push(await h.orch.runWorkItem(id, { workerId }));
    }

    const maintained = totals.every((t) => t <= maxTotal) && totals.every((t, i) => i === 0 || t >= totals[i - 1]);

    const rows: InvariantRow[] = [
      {
        invariant: `ledger kinds are exactly [initial, retry×3, reassign×1]`,
        held: JSON.stringify(ledger.map((d) => d.kind)) === JSON.stringify(["initial", "retry", "retry", "retry", "reassign"]),
        evidence: `kinds=${JSON.stringify(ledger.map((d) => d.kind))}`,
      },
      { invariant: "same-worker retries ≤ maxRetries (3)", held: retries <= 3, evidence: `retries=${retries}/3` },
      { invariant: "reassignments ≤ maxReassignments (1)", held: reassign <= 1, evidence: `reassignments=${reassign}/1` },
      { invariant: `total dispatches ≤ 1+maxRetries+maxReassignments = ${maxTotal}`, held: ledger.length <= maxTotal, evidence: `total=${ledger.length}/${maxTotal}` },
      { invariant: "the budget is fully spent, never over-spent", held: ledger.length === maxTotal, evidence: `total=${ledger.length}` },
      { invariant: "no dispatch ever reached the worker over budget", held: h.state.delegateCalls.length === maxTotal, evidence: `delegateCalls=${h.state.delegateCalls.length}` },
      { invariant: "every over-budget call is BLOCKED, none COMPLETED", held: outcomes.slice(maxTotal).every((o) => o.state === "BLOCKED") && outcomes.every((o) => o.state !== "COMPLETED"), evidence: `states=${outcomes.map((o) => o.state).join(",")}` },
      { invariant: "worker ROTATION cannot exceed the per-item ceiling", held: rotation.every((o) => o.state === "BLOCKED") && h.state.delegateCalls.length === dispatchesAtCeiling, evidence: `rotation-states=${rotation.map((o) => o.state).join(",")} delegateCalls=${h.state.delegateCalls.length}` },
      { invariant: "the ledger is monotonically bounded (never overshoots)", held: maintained, evidence: `totals=${totals.join("→")}` },
      { invariant: "exhaustion settles BLOCKED, never COMPLETED", held: h.board.get(id)?.state === "BLOCKED", evidence: `final state=${h.board.get(id)?.state}` },
    ];
    renderTable("S5 — budget ceilings under rotation", rows);
    assertTable(rows);
  } finally {
    h.close();
  }
});

test("S5b — the ceiling survives a restart (no fresh budget)", async () => {
  const { dir, dbPath } = tempDb("restart-budget");
  let id = "";
  try {
    const h1 = harness({ dbPath, maxRetries: 1, maxReassignments: 0 });
    h1.state.delegateFn = () => ({ ok: false, error: "injected fault" });
    const started = h1.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    id = started.workItemId;
    await h1.orch.runWorkItem(id, { workerId: "worker-1" });
    await h1.orch.runWorkItem(id, { workerId: "worker-1" });
    const spent = ledgerOf(h1, id).length;
    h1.close();

    const h2 = harness({ dbPath, maxRetries: 1, maxReassignments: 0 });
    h2.state.delegateFn = () => ({ ok: false, error: "injected fault" });
    try {
      const refused = await h2.orch.runWorkItem(id, { workerId: "worker-1" });
      const rows: InvariantRow[] = [
        { invariant: "the spent budget survived the restart", held: spent === 2 && ledgerOf(h2, id).length === 2, evidence: `before=${spent} after=${ledgerOf(h2, id).length}` },
        { invariant: "a restart never grants a fresh attempt", held: refused.state === "BLOCKED", evidence: `state=${refused.state} note="${refused.note}"` },
        { invariant: "the restarted orchestrator dispatches nothing", held: h2.state.delegateCalls.length === 0, evidence: `delegateCalls=${h2.state.delegateCalls.length}` },
      ];
      renderTable("S5b — ceiling durability", rows);
      assertTable(rows);
    } finally {
      h2.close();
    }
  } finally {
    cleanup(dir);
  }
});

// ══ S6. Corrective children ══════════════════════════════════════════════════

test("S6a — corrective chain is bounded by maxDepth and never resets a parent ledger", async () => {
  const h = harness({ maxRetries: 2, maxReassignments: 0 });
  try {
    h.state.delegateFn = () => ({ ok: true, reply: forbiddenReply() });
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, forbidden: ["force-push"], budget: { maxRetries: 1, maxDepth: 2, maxReassignments: 0 } },
      ["worker-1"],
    );
    const id = started.workItemId;
    await h.orch.runWorkItem(id, { workerId: "worker-1" });

    const parent = h.board.get(id);
    const level1 = h.board.children(id);
    const level2 = level1[0] !== undefined ? h.board.children(level1[0].id) : [];
    const level3 = level2[0] !== undefined ? h.board.children(level2[0].id) : [];
    const chain = [parent, ...level1, ...level2].filter((it) => it !== undefined && it !== null);
    const deepest = level2[0];

    const rows: InvariantRow[] = [
      { invariant: "the corrective chain stops at maxDepth (3 dispatches total)", held: h.state.delegateCalls.length === 3, evidence: `dispatches=${h.state.delegateCalls.length} (maxDepth=2 ⇒ parent + child + grandchild)` },
      { invariant: "the parent made exactly ONE dispatch (a child never resets it)", held: ledgerOf(h, id).length === 1, evidence: `parent ledger=${JSON.stringify(ledgerOf(h, id).map((d) => d.kind))}` },
      { invariant: "the parent is never COMPLETED on a contradicted deliverable", held: parent?.state !== "COMPLETED", evidence: `parent state=${parent?.state}` },
      { invariant: "each child carries its OWN single attempt", held: chain.every((it) => ledgerOf(h, it.id).length === 1), evidence: `ledgers=${JSON.stringify(chain.map((it) => [it.id, ledgerOf(h, it.id).length]))}` },
      { invariant: "the chain depth never exceeds maxDepth (2)", held: chain.every((it) => h.board.depthOf(it.id) <= 2), evidence: `depths=${JSON.stringify(chain.map((it) => h.board.depthOf(it.id)))}` },
      { invariant: "the DEPTH-MAX item parks instead of spawning an unbounded chain", held: level3.length === 0, evidence: `level2=${level2.length} level3=${level3.length} deepest state=${deepest?.state}` },
      { invariant: "no item in the chain is reported COMPLETED", held: chain.every((it) => it.state !== "COMPLETED"), evidence: `states=${chain.map((it) => it.state).join(",")}` },
      { invariant: "children inherit the parent's contract and budget", held: level1[0]?.budget?.maxRetries === 1 && JSON.stringify(level1[0]?.forbiddenOutcomes) === JSON.stringify(["force-push"]), evidence: `child budget.maxRetries=${level1[0]?.budget?.maxRetries} forbidden=${JSON.stringify(level1[0]?.forbiddenOutcomes)}` },
    ];
    renderTable("S6a — bounded corrective chain", rows);
    assertTable(rows);
  } finally {
    h.close();
  }
});

test("S6b — the maxChildren ceiling refuses an unbounded corrective branch", async () => {
  // maxParallel=1 ⇒ maxChildren=1 for corrective branches.
  const h = harness({ maxRetries: 2, maxReassignments: 0, maxParallel: 1 });
  try {
    h.state.delegateFn = () => ({ ok: true, reply: forbiddenReply() });
    const started = h.orch.startObjective(
      {
        objective: OBJ,
        deliverable: DELIVERABLE,
        forbidden: ["force-push"],
        budget: { maxRetries: 1, maxDepth: 2, maxReassignments: 0, maxChildren: 1 },
        subtasks: ["pre-existing sub task"],
      },
      ["worker-1"],
    );
    const id = started.workItemId;
    assert.equal(h.board.children(id).length, 1, "the pre-existing child consumes the maxChildren allowance");
    await h.orch.runWorkItem(id, { workerId: "worker-1" });

    const parent = h.board.get(id);
    const children = h.board.children(id);
    const nextAction = outputsOf(h, id)["nextAction"] as { action?: string; state?: string; reason?: string } | undefined;

    const rows: InvariantRow[] = [
      { invariant: "no corrective child is created beyond maxChildren", held: children.length === 1, evidence: `children=${children.length} (maxChildren=1)` },
      { invariant: "the corrective branch did not dispatch a worker", held: h.state.delegateCalls.length === 1, evidence: `delegateCalls=${h.state.delegateCalls.length}` },
      { invariant: "the parent parks with a recorded reason instead of looping", held: parent?.state === "WAITING" && nextAction?.state === "blocked", evidence: `state=${parent?.state} nextAction=${JSON.stringify(nextAction)}` },
      { invariant: "the parent's ledger is untouched by the refusal", held: ledgerOf(h, id).length === 1, evidence: `dispatches=${ledgerOf(h, id).length}` },
      { invariant: "the parent is never COMPLETED", held: parent?.state !== "COMPLETED", evidence: `state=${parent?.state}` },
    ];
    renderTable("S6b — maxChildren ceiling", rows);
    assertTable(rows);
  } finally {
    h.close();
  }
});

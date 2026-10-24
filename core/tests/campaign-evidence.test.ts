// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Campaign reproduction: does an artifact claim get checked against the ITEM's
 * workspace, or against KAI's own working directory?
 *
 * `gatherEvidence` calls `filesystem.metadata` with the raw claimed path and no
 * cwd, so the tool resolves it against KAI's own sandbox roots. An item with no
 * `workingDir` therefore gets "evidence" about whatever KAI happens to have at
 * that path — a false observation about the wrong tree.
 *
 * These tests run from `core/`, so `src/orchestration/board.ts` EXISTS relative
 * to the process cwd and is a good stand-in for "a path KAI happens to have".
 *
 * Run from `core/`:  node --test tests/campaign-evidence.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorkBoard, type WorkBoard } from "../src/orchestration/board.ts";
import { createBenchmark } from "../src/orchestration/bench.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import { createTrace } from "../src/orchestration/trace.ts";
import { createLearning } from "../src/orchestration/learn.ts";
import { evaluatingDeps } from "./learn-eval-fixture.ts";
import { createOrchestrator, type Orchestrator } from "../src/orchestration/orchestrator.ts";
import type { AutonomyPolicy } from "../src/orchestration/types.ts";
import type { Stores } from "../src/shared/contracts.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";

/** A path that certainly exists relative to the Core's own working directory. */
const KAI_OWN_FILE = "src/orchestration/board.ts";

function autonomy(): AutonomyPolicy {
  return {
    level: 2,
    workerAuto: "AUTO",
    review: "AUTO",
    skillLearning: "PROPOSE",
    budgets: { maxDepth: 2, maxRetries: 2 },
    maxDepth: 2,
    maxParallel: 3,
    taskRetentionDays: 30,
  };
}

function okReply(deliverable: string, artifact: string): string {
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

interface H {
  orch: Orchestrator;
  board: WorkBoard;
  stores: Stores;
  close(): void;
}

function harness(claimedArtifact: string = KAI_OWN_FILE): H {
  const stores = openSqliteStores({ path: ":memory:" });
  const board = createWorkBoard(stores.workItems);
  const bench = createBenchmark(stores.workerProfiles);
  const dispatcher = createDispatcher({
    bench,
    availability: () => ["worker-1"],
    capabilities: () => ({ skills: ["typescript"], tools: ["read"] }),
  });
  const trace = createTrace({ store: stores.activity, prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }) as const });
  const learning = createLearning({ metrics: stores.skillMetrics, validate: () => ({ ok: true }), stage: () => ({ ok: true }), ...evaluatingDeps() });
  const orch = createOrchestrator({
    board,
    bench,
    dispatcher,
    trace,
    learning,
    patterns: stores.promptPatterns,
    reviewRunner: async () => ({ verdict: "PASS" as const, findings: [] }),
    delegate: async () => ({ ok: true as const, reply: okReply("the patch", claimedArtifact) }),
    skills: { relevant: () => [], load: () => ({ ok: false, reason: "missing" }) },
    policyCheck: async () => ({ outcome: "allow" as const, reason: "allowed" }),
    approvals: {
      request: () => ({ id: "appr_1" }),
      get: () => ({ status: "PENDING" }),
    },
    autonomy,
    publish: () => {},
    // REAL tool invocation: this is the production path (the tool resolves the
    // path against its own sandbox roots when no cwd is supplied).
    tools: {
      invoke: async (id, input) => {
        const { filesystemMetadataProbe } = await import("./campaign-tools.ts");
        return filesystemMetadataProbe(id, input);
      },
    },
  });
  return { orch, board, stores, close: () => stores.close() };
}

function observedSupports(h: H, id: string): string[] {
  const item = h.board.get(id);
  const ev = (item?.evidence ?? []) as { source?: string; supports?: string[]; detail?: string }[];
  return ev.filter((r) => r.source === "kai-observed").flatMap((r) => r.supports ?? []);
}

function observedDetails(h: H, id: string): string[] {
  const item = h.board.get(id);
  const ev = (item?.evidence ?? []) as { source?: string; detail?: string }[];
  return ev.filter((r) => r.source === "kai-observed").map((r) => r.detail ?? "");
}

test("REPRO: no workingDir must NOT produce a positive observation from KAI's own tree", async () => {
  const h = harness();
  try {
    const started = h.orch.startObjective(
      { objective: "patch the poller", deliverable: "the patch", requiredEvidence: [`file present: ${KAI_OWN_FILE}`] },
      ["worker-1"],
    );
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    const supports = observedSupports(h, started.workItemId);
    const details = observedDetails(h, started.workItemId);
    // The defect: without a workspace, KAI inspected ITS OWN tree and recorded a
    // positive observation for a path that has nothing to do with the item.
    assert.deepEqual(
      supports,
      [],
      `no workspace was given, so nothing may be observed; got supports=${JSON.stringify(supports)} details=${JSON.stringify(details)}`,
    );
    assert.notEqual(out.state, "COMPLETED", "an unscoped check must never complete the item");
  } finally {
    h.close();
  }
});

test("a workingDir that lacks the file records ABSENT and never completes", async () => {
  const h = harness();
  try {
    const started = h.orch.startObjective(
      {
        objective: "patch the poller",
        deliverable: "the patch",
        requiredEvidence: [`file present: ${KAI_OWN_FILE}`],
        workingDir: "C:/definitely/not/a/real/workspace",
      },
      ["worker-1"],
    );
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(out.state, "COMPLETED");
    assert.deepEqual(observedSupports(h, started.workItemId), [], "an absent file settles nothing");
  } finally {
    h.close();
  }
});

test("REPRO: a REFUSED check must not be recorded as a disk observation", async () => {
  const h = harness("C:/Windows/win.ini");
  try {
    // The claimed artifact is an absolute path outside the tool's sandbox, so
    // `filesystem.metadata` REFUSES it (ok:false). That refusal must surface as
    // an unverifiable label, not be converted into "the file is absent".
    const started = h.orch.startObjective(
      {
        objective: "patch the poller",
        deliverable: "the patch",
        requiredEvidence: ["file present: C:/Windows/win.ini"],
        workingDir: "C:/tmp/project",
      },
      ["worker-1"],
    );
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(out.state, "COMPLETED");
    const details = observedDetails(h, started.workItemId);
    assert.deepEqual(details, [], `a refused check must not produce an observation, got ${JSON.stringify(details)}`);
    const activity = h.orch.activityList({ workItemId: started.workItemId }, "VERBOSE");
    assert.ok(
      activity.some((e) => e.label.includes("Evidence unsupported") || e.label.includes("outside the workspace sandbox")),
      `the refusal must be recorded as unsupported, got ${JSON.stringify(activity.map((e) => e.label).slice(0, 6))}`,
    );
  } finally {
    h.close();
  }
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * A green exit code is not proof that the intended tests ran.
 *
 * `node --test` in a directory with no discoverable tests exits 0 and reports
 * "tests 0 / pass 0"; `go test` prints "no test files"; a command can print an
 * unrelated success message and exit 0. A live Goal Challenger found exactly this
 * and was right, so KAI now requires a POSITIVE count of discovered/executed tests
 * before a test criterion can be satisfied, and records anything else as a
 * non-satisfying observation.
 *
 * These tests drive the REAL orchestrator and the REAL Outcome Gate; only the
 * shell is stubbed, so each case is the gate's actual verdict on a real output.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkBoard } from "../src/orchestration/board.ts";
import { createBenchmark } from "../src/orchestration/bench.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import { createLearning } from "../src/orchestration/learn.ts";
import { evaluatingDeps } from "./learn-eval-fixture.ts";
import { createOrchestrator } from "../src/orchestration/orchestrator.ts";
import { createTrace } from "../src/orchestration/trace.ts";
import { openSqliteStores, type Stores } from "../src/storage/sqlite.ts";
import type { AutonomyPolicy } from "../src/orchestration/types.ts";

function autonomy(): AutonomyPolicy {
  return {
    level: 3,
    workerAuto: "AUTO",
    review: "AUTO",
    skillLearning: "PROPOSE",
    budgets: { maxDepth: 2, maxRetries: 2 },
    maxDepth: 2,
    maxParallel: 3,
    taskRetentionDays: 30,
  };
}

const HANDOFF = [
  "STATUS: ok",
  "RESULT: ran the suite",
  "CHANGED ARTIFACTS: report.txt",
  "EVIDENCE: see tests",
  "TESTS: ran the suite",
  "BLOCKERS: (none)",
  "RISKS: none",
  "FOLLOW-UPS: none",
  "RECOMMENDED NEXT STEP: none",
  "TOOLS USED: shell",
].join("\n");

interface Case {
  label: string;
  stdout: string;
  stderr?: string;
  exitCode: number;
}

/** Run one criterion through the real gate and return what it recorded. */
async function runCase(c: Case): Promise<{ met: boolean; detail: string; supports: string[]; exitCode: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), "kai-testverify-"));
  const stores: Stores = openSqliteStores({ path: join(dir, "kai.db") });
  const board = createWorkBoard(stores.workItems);
  const bench = createBenchmark(stores.workerProfiles);
  try {
    const orch = createOrchestrator({
      board,
      bench,
      dispatcher: createDispatcher({
        bench,
        availability: () => ["worker-1"],
        capabilities: () => ({ skills: [], tools: ["read", "shell"] }),
      }),
      trace: createTrace({ store: stores.activity, prefs: () => ({ activity: "OFF", reasoning: "SUMMARY" }) as const }),
      learning: createLearning({ metrics: stores.skillMetrics, validate: () => ({ ok: true }), stage: () => ({ ok: true }), ...evaluatingDeps() }),
      patterns: stores.promptPatterns,
      reviewRunner: async () => ({ verdict: "PASS", findings: [] }),
      delegate: async () => ({ ok: true, reply: HANDOFF }),
      skills: { relevant: () => [], load: () => ({ ok: false, reason: "none" }), inspect: () => null },
      policyCheck: async () => ({ outcome: "allow", reason: "test policy allows" }),
      approvals: { request: () => ({ id: "appr_1" }), get: () => ({ status: "APPROVED" }) },
      autonomy,
      publish: () => {},
      tools: {
        invoke: async (id: string) => {
          if (id === "shell.run") {
            return { ok: true, result: { exitCode: c.exitCode, stdout: c.stdout, stderr: c.stderr ?? "" } };
          }
          if (id === "filesystem.metadata") return { ok: true, result: { exists: true, size: 1 } };
          return { ok: true, result: {} };
        },
      },
      rememberLesson: () => ({ ok: true }),
    });

    const started = orch.startObjective(
      { objective: "run the suite", deliverable: "a green suite", successCriteria: [c.label], requiredEvidence: [c.label] },
      ["worker-1"],
    );
    // A command-based verification is risk-classified DESTRUCTIVE, so it PARKS for
    // a human by default (correct: it executes a command). This test models the
    // approved case, which is what lets the command path actually run.
    await orch.runWorkItem(started.workItemId, { workerId: "worker-1", approvalId: "appr_verify" });
    const item = board.get(started.workItemId);
    const record = (item?.evidence ?? []).find((e) => e.kind === "test result");
    return {
      met: (item?.evidence ?? []).some((e) => e.source === "kai-observed" && e.supports.includes(c.label)),
      detail: record?.detail ?? "(no test-result record)",
      supports: record?.supports ?? [],
      exitCode: record?.exitCode ?? null,
    };
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("a test criterion is satisfied ONLY when the run shows a positive test count", async (t) => {
  const cases: (Case & { expect: boolean; why: string })[] = [
    {
      label: "npm test",
      stdout: "# tests 12\n# pass 12\n# fail 0",
      exitCode: 0,
      expect: true,
      why: "12 tests ran and passed",
    },
    {
      label: "npm test",
      stdout: "# tests 0\n# pass 0\n# fail 0",
      exitCode: 0,
      expect: false,
      why: "the classic VACUOUS pass: zero tests discovered, exit 0",
    },
    {
      label: "go test",
      stdout: "?   example/pkg [no test files]\nok  example/pkg 0.001s",
      exitCode: 0,
      expect: false,
      why: "go reports no test files — nothing ran",
    },
    {
      label: "npm test",
      stdout: "All checks passed! Nothing to do.",
      exitCode: 0,
      expect: false,
      why: "an unrelated success message with no test count is not proof",
    },
    {
      label: "npm test",
      stdout: "# pass 3\n# fail 1\nnot ok 1 - the failing case",
      exitCode: 1,
      expect: false,
      why: "a failing run is never satisfied, even with tests discovered",
    },
    {
      label: "cargo test",
      stdout: "test result: ok. 7 passed; 0 failed; 0 ignored",
      exitCode: 0,
      expect: true,
      why: "cargo reports a positive pass count",
    },
    {
      label: "pytest",
      stdout: "=== 4 passed in 0.21s ===",
      exitCode: 0,
      expect: true,
      why: "pytest reports a positive pass count",
    },
  ];

  for (const c of cases) {
    const result = await runCase(c);
    assert.equal(
      result.met,
      c.expect,
      `${c.why}\n  label: ${c.label}\n  exit: ${c.exitCode}\n  recorded: ${result.detail}`,
    );
    if (!c.expect) {
      assert.deepEqual(result.supports, [], `${c.why}: a non-satisfying run must record EMPTY supports`);
    }
    t.diagnostic(`${c.expect ? "PASS" : "REFUSED"} — ${c.why} — ${result.detail.slice(0, 110)}`);
  }
});

test("a vacuous run names itself as vacuous, so the reason is not mistaken for a tooling fault", async (t) => {
  const result = await runCase({ label: "npm test", stdout: "# tests 0\n# pass 0", exitCode: 0 });
  assert.equal(result.met, false);
  assert.match(result.detail, /ZERO tests|vacuous/i, `the reason must say what happened: ${result.detail}`);
  t.diagnostic(`recorded: ${result.detail}`);
});

test("a run whose count cannot be established is reported as unestablished, never as a pass", async (t) => {
  const result = await runCase({ label: "npm test", stdout: "done\n", exitCode: 0 });
  assert.equal(result.met, false);
  assert.match(result.detail, /no test count could be established/i, `got: ${result.detail}`);
  t.diagnostic(`recorded: ${result.detail}`);
});

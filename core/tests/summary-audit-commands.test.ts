// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * `/summary` and `/audit` through the REAL command path.
 *
 * These are not parser unit tests. They build the same route table the server
 * mounts (`buildCommandRoutes`) over a REAL `createCoreRuntime`, invoke the
 * `/commands/:id/run` handler exactly as the UI's `runSlash` does, and assert on
 * what the command actually did — a durable work board for `/summary`, and a
 * real workspace inspection for `/audit`.
 *
 * Run from `core/`:  node --test tests/summary-audit-commands.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { buildCommandRoutes } from "../src/commands/routes.ts";
import { listCommands } from "../src/commands/commands.ts";
import type { ApiRequest, ApiResponse } from "../src/api/routes.ts";

function boot(dir: string) {
  return createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
}

async function runCommand(
  routes: ReturnType<typeof buildCommandRoutes>,
  id: string,
  body: { args?: unknown; raw?: string },
): Promise<ApiResponse> {
  const route = routes.find((r) => r.pattern === "/commands/:id/run");
  assert.ok(route !== undefined, "the command run route must exist");
  const request: ApiRequest = {
    method: "POST",
    path: `/commands/${id}/run`,
    query: new URLSearchParams(),
    body,
  };
  return route.handler(request, { id });
}

interface CommandResultText {
  ok?: boolean;
  result?: { command?: string; title?: string; text?: string };
  reason?: string;
}

test("the catalogue advertises /summary and /audit", () => {
  const ids = listCommands().map((c) => c.id);
  assert.ok(ids.includes("summary"), "/summary is registered");
  assert.ok(ids.includes("audit"), "/audit is registered");
});

test("/summary renders an evidence-backed report over the real work board", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cmd-summary-"));
  const runtime = boot(dir);
  try {
    await runtime.start();
    // One persona is enough for a READ objective to route (the same step the
    // live API performs when it POSTs /work-items).
    const spawned = await runtime.tools.invoke("workforce.subagent", {
      id: "researcher",
      name: "Researcher",
      role: "research",
      soul: "I am methodical, analytical and citation-focused.",
      workerId: "opencode",
    });
    assert.equal(spawned.ok, true, spawned.ok ? "" : spawned.error.message);
    const candidates = runtime.subagents.list().map((p) => p.spec.id);
    const started = runtime.orchestrator.startObjective({ objective: "Say hello and confirm you are online", deliverable: "the fix" }, candidates);
    assert.ok(started.workItemId.length > 0, started.note);
    const res = await runCommand(buildCommandRoutes(runtime), "summary", { args: [] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as CommandResultText;
    assert.equal(body.ok, true);
    assert.equal(body.result?.command, "summary");
    assert.match(body.result?.text ?? "", new RegExp(started.workItemId), "the report names the real work item");
    assert.match(body.result?.text ?? "", /Work summary/);
    assert.match(body.result?.text ?? "", /Daily offer/, "the report explains the daily-offer state");
    // Nothing was sent to the user just by asking for a report.
    assert.equal(runtime.notifications.list().length, 0);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("/summary accepts a date range and stays honest about an empty day", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cmd-summary-range-"));
  const runtime = boot(dir);
  try {
    await runtime.start();
    const res = await runCommand(buildCommandRoutes(runtime), "summary", { args: ["2020-01-01", "2020-01-02"] });
    assert.equal(res.status, 200);
    const body = res.body as CommandResultText;
    assert.match(body.result?.text ?? "", /nothing to report/i);
    assert.match(body.result?.title ?? "", /2020-01-01 → 2020-01-02/, "the range is honoured");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("/audit with no report refuses and audits nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cmd-audit-empty-"));
  const runtime = boot(dir);
  try {
    await runtime.start();
    const res = await runCommand(buildCommandRoutes(runtime), "audit", { args: [], raw: "" });
    assert.equal(res.status, 200);
    const body = res.body as CommandResultText;
    assert.match(body.result?.title ?? "", /needs a report/i);
    assert.match(body.result?.text ?? "", /Nothing was audited/);
    assert.deepEqual(runtime.stores.workItems.list({}), [], "no audit work item was created");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("/audit checks a pasted report against the real workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cmd-audit-live-"));
  const runtime = boot(dir);
  try {
    await runtime.start();
    const workspace = mkdtempSync(join(tmpdir(), "kai-audit-ws-"));
    // The artifact the report claims does NOT exist in that workspace.
    const claimed = join(workspace, "src", "poller.ts");
    const report = [
      "STATUS: ok",
      "RESULT: I fixed the poller busy-wait.",
      `CHANGED ARTIFACTS: ${claimed}`,
      "EVIDENCE: tests pass",
      "TESTS: npm test — 18/18 passed",
      "BLOCKERS: (none)",
      "RISKS: none",
      "FOLLOW-UPS: none",
      "RECOMMENDED NEXT STEP: ship",
      "TOOLS USED: edit",
    ].join("\n");
    const res = await runCommand(buildCommandRoutes(runtime), "audit", {
      args: [],
      raw: `--dir ${workspace}\n${report}`,
    });
    assert.equal(res.status, 200);
    const body = res.body as CommandResultText;
    assert.match(body.result?.text ?? "", /What the worker claimed \(UNTRUSTED\)/);
    assert.match(body.result?.text ?? "", /ABSENT/, "the real filesystem check is reflected");
    assert.match(body.result?.text ?? "", /Next-worker prompt/, "the correction prompt is offered");
    assert.match(body.result?.text ?? "", /Not launched/i, "level-2 autonomy does not silently auto-run an external correction");
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("/audit --file reads a multiline report without truncating it silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cmd-audit-file-"));
  const runtime = boot(dir);
  try {
    await runtime.start();
    const workspace = mkdtempSync(join(tmpdir(), "kai-audit-ws2-"));
    const reportPath = join(workspace, "report.md");
    const claimed = join(workspace, "does-not-exist.ts");
    writeFileSync(
      reportPath,
      ["STATUS: ok", `RESULT: shipped ${claimed}`, `CHANGED ARTIFACTS: ${claimed}`, "EVIDENCE: manual", "TESTS: none", "BLOCKERS: (none)", "RISKS: none", "FOLLOW-UPS: none", "RECOMMENDED NEXT STEP: ship", "TOOLS USED: edit"].join("\n"),
      "utf8",
    );
    const res = await runCommand(buildCommandRoutes(runtime), "audit", {
      args: [],
      raw: `--file ${reportPath} --dir ${workspace}`,
    });
    assert.equal(res.status, 200);
    const body = res.body as CommandResultText;
    assert.match(body.result?.text ?? "", new RegExp(`file ${reportPath.replace(/\\/g, "\\\\")}`), "the source is named");
    assert.match(body.result?.text ?? "", /ABSENT/);
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("/audit --file with a missing file gives a typed error and audits nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cmd-audit-missing-"));
  const runtime = boot(dir);
  try {
    await runtime.start();
    const res = await runCommand(buildCommandRoutes(runtime), "audit", {
      args: [],
      raw: `--file ${join(tmpdir(), "definitely-not-here-12345.md")}`,
    });
    assert.equal(res.status, 200);
    const body = res.body as CommandResultText;
    assert.match(body.result?.title ?? "", /not readable/i);
    assert.match(body.result?.text ?? "", /Nothing was audited/);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

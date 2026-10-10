// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Campaign verification — `/audit` and `/summary`/daily-offer honesty.
 *
 * Independent adversarial pass. The audit and summary paths are driven through
 * the REAL command route table (`buildCommandRoutes(runtime)`) over a REAL
 * `createCoreRuntime`, invoked exactly as the UI's `runSlash` does (the
 * `/commands/:id/run` handler with `{ args, raw }`), plus the real scheduler
 * for the housekeeping seam. Nothing about the orchestrator or the stores is
 * mocked; every observable is read from the runtime itself.
 *
 * Run from `core/`:  node --test tests/campaign-audit-summary.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { buildCommandRoutes } from "../src/commands/routes.ts";
import { createDailySummaryService } from "../src/summary/daily.ts";
import { createWorkBoard, type WorkBoard } from "../src/orchestration/board.ts";
import { createScheduler } from "../src/scheduler/scheduler.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";
import type { ApiRequest, ApiResponse } from "../src/api/routes.ts";
import type { VerifiedEvidence } from "../src/orchestration/types.ts";

// ── Harness ───────────────────────────────────────────────────────────────────

function boot(dir: string) {
  return createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
}

type Routes = ReturnType<typeof buildCommandRoutes>;

/** Invoke `/commands/:id/run` the way the UI's runSlash does. */
async function runCommand(
  routes: Routes,
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

interface CmdResult {
  command?: string;
  title?: string;
  text?: string;
  data?: unknown;
}
interface CmdBody {
  ok?: boolean;
  result?: CmdResult;
  reason?: string;
}
interface ObservedRecord {
  id: string;
  kind: string;
  source: string;
  detail: string;
  supports: string[];
}
interface AuditData {
  workItemId: string;
  claims: string[];
  observed: ObservedRecord[];
  unmetCriteria: string[];
  missingEvidence: string[];
  blockers: string[];
  reviewNotes: string[];
  limitation?: string;
  nextPrompt: string;
  launched: { started: boolean; workItemId?: string; reason: string };
}
interface SummaryTotals {
  tasks: number;
  verified: number;
  reportedOnly: number;
  planned: number;
  running: number;
  waiting: number;
  blocked: number;
  failed: number;
  cancelled: number;
  failureCount: number;
}
interface SummaryData {
  totals: SummaryTotals;
  items: Array<{ id: string; classification: string; observedEvidence: number; reportedEvidence: number }>;
  empty: boolean;
}

function resultOf(res: ApiResponse): CmdResult {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CmdBody;
  assert.equal(body.ok, true, `command failed: ${body.reason ?? "?"}`);
  assert.ok(body.result !== undefined, "a successful run must carry a result");
  return body.result;
}
function auditOf(res: ApiResponse): AuditData {
  const data = resultOf(res).data as AuditData | undefined;
  assert.ok(data !== undefined, "the audit result must carry structured data");
  return data;
}
function summaryOf(res: ApiResponse): SummaryData {
  const data = resultOf(res).data as SummaryData | undefined;
  assert.ok(data !== undefined, "the summary result must carry structured data");
  return data;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** A worker handoff in the documented format, with only the fields given. */
function handoff(opts: {
  result: string;
  artifact?: string;
  tests?: string;
  status?: string;
  evidence?: string;
}): string {
  const lines = [`STATUS: ${opts.status ?? "ok"}`, `RESULT: ${opts.result}`];
  if (opts.artifact !== undefined) lines.push(`CHANGED ARTIFACTS: ${opts.artifact}`);
  lines.push(`EVIDENCE: ${opts.evidence ?? "I ran it and it worked"}`);
  if (opts.tests !== undefined) lines.push(`TESTS: ${opts.tests}`);
  lines.push("BLOCKERS: (none)", "RISKS: none", "FOLLOW-UPS: none", "RECOMMENDED NEXT STEP: ship", "TOOLS USED: edit");
  return lines.join("\n");
}

// ══ /audit ════════════════════════════════════════════════════════════════════

test("1 audit: a claimed file that EXISTS is recorded present (real workspace)", async () => {
  const dir = tempDir("kai-audit-exists-");
  const ws = tempDir("kai-audit-ws-exists-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    const claimed = join(ws, "src", "poller.ts");
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(claimed, "export const poll = true;\n", "utf8");

    const res = await runCommand(buildCommandRoutes(runtime), "audit", {
      args: [],
      raw: `--dir ${ws}\n${handoff({ result: "I fixed the poller busy-wait.", artifact: claimed })}`,
    });
    const text = resultOf(res).text ?? "";
    const data = auditOf(res);

    assert.equal(data.observed.length, 1, `expected one observation; got ${JSON.stringify(data.observed)}`);
    const obs = data.observed[0]!;
    assert.equal(obs.source, "kai-observed", "the observation is KAI's own, not a worker claim");
    assert.match(obs.detail, /exists/, `present file must be recorded present: ${obs.detail}`);
    assert.doesNotMatch(obs.detail, /ABSENT/, "a present file must never be recorded ABSENT");
    assert.ok(obs.supports.includes(`file present: ${claimed}`), "the observation settles its requirement label");
    assert.match(text, /What KAI observed itself/);
    assert.match(text, /exists/);
  } finally {
    await runtime.stop();
    cleanup(dir);
    cleanup(ws);
  }
});

test("2 audit: a claimed file that is ABSENT is recorded ABSENT and never claims success", async () => {
  const dir = tempDir("kai-audit-absent-");
  const ws = tempDir("kai-audit-ws-absent-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    const claimed = join(ws, "src", "not-created.ts");

    const res = await runCommand(buildCommandRoutes(runtime), "audit", {
      args: [],
      raw: `--dir ${ws}\n${handoff({ result: "I created the missing module.", artifact: claimed })}`,
    });
    const title = resultOf(res).title ?? "";
    const data = auditOf(res);

    assert.equal(data.observed.length, 1);
    const obs = data.observed[0]!;
    assert.match(obs.detail, /ABSENT/, `absent file must be recorded ABSENT: ${obs.detail}`);
    assert.deepEqual(obs.supports, [], "an ABSENT file settles nothing");
    assert.doesNotMatch(title, /correction launched/, "no success is claimed for an unmet requirement");
    assert.equal(data.launched.started, false, "default autonomy must not auto-launch");
  } finally {
    await runtime.stop();
    cleanup(dir);
    cleanup(ws);
  }
});

test("3 audit --file reads a real report file (multiline, not truncated)", async () => {
  const dir = tempDir("kai-audit-file-");
  const ws = tempDir("kai-audit-ws-file-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    const claimed = join(ws, "does-not-exist.ts");
    const reportPath = join(ws, "report.md");
    writeFileSync(
      reportPath,
      handoff({ result: `shipped ${claimed}`, artifact: claimed, evidence: "manual inspection" }),
      "utf8",
    );

    const res = await runCommand(buildCommandRoutes(runtime), "audit", {
      args: [],
      raw: `--file ${reportPath} --dir ${ws}`,
    });
    const text = resultOf(res).text ?? "";
    const data = auditOf(res);

    assert.ok(text.includes(`file ${reportPath}`), `source must name the file: ${text.slice(0, 120)}`);
    assert.match(text, /ABSENT/);
    assert.equal(data.observed.length, 1);
  } finally {
    await runtime.stop();
    cleanup(dir);
    cleanup(ws);
  }
});

test("4 audit: empty / missing / unreadable / empty-file reports are typed refusals, nothing audited", async () => {
  const dir = tempDir("kai-audit-refuse-");
  const ws = tempDir("kai-audit-ws-refuse-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    const routes = buildCommandRoutes(runtime);

    // (a) empty paste.
    const empty = resultOf(await runCommand(routes, "audit", { args: [], raw: "" }));
    assert.match(empty.title ?? "", /needs a report/i);
    assert.match(empty.text ?? "", /Nothing was audited/);

    // (b) missing file.
    const missing = resultOf(
      await runCommand(routes, "audit", { args: [], raw: `--file ${join(tmpdir(), "definitely-not-here-audit.md")}` }),
    );
    assert.match(missing.title ?? "", /not readable/i);
    assert.match(missing.text ?? "", /Nothing was audited/);

    // (c) unreadable: a directory is not a readable report file.
    const dirAsFile = join(ws, "a-directory");
    mkdirSync(dirAsFile, { recursive: true });
    const unreadable = resultOf(await runCommand(routes, "audit", { args: [], raw: `--file ${dirAsFile}` }));
    assert.match(unreadable.title ?? "", /not readable/i);
    assert.match(unreadable.text ?? "", /Nothing was audited/);

    // (d) an empty file.
    const emptyFile = join(ws, "empty.md");
    writeFileSync(emptyFile, "   \n\n", "utf8");
    const emptyRead = resultOf(await runCommand(routes, "audit", { args: [], raw: `--file ${emptyFile}` }));
    assert.match(emptyRead.title ?? "", /empty/i);
    assert.match(emptyRead.text ?? "", /Nothing was audited/);

    assert.deepEqual(runtime.stores.workItems.list({}), [], "no audit work item was created by any refusal");
    assert.equal(runtime.notifications.list().length, 0);
  } finally {
    await runtime.stop();
    cleanup(dir);
    cleanup(ws);
  }
});

test("5 audit with no --dir runs NO checks and says the workspace was not provided", async () => {
  const dir = tempDir("kai-audit-nodir-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    // A RELATIVE claim that would resolve against the Core's own cwd
    // (`core/src/orchestration/board.ts` exists there). Without a workspace it
    // must NOT be inspected.
    const relativeClaim = "src/orchestration/board.ts";
    const res = await runCommand(buildCommandRoutes(runtime), "audit", {
      args: [],
      raw: handoff({ result: "I changed the orchestration board.", artifact: relativeClaim }),
    });
    const text = resultOf(res).text ?? "";
    const data = auditOf(res);

    assert.deepEqual(data.observed, [], "no workspace given: KAI must not inspect its own tree");
    assert.equal(data.observed.length, 0);
    assert.match(data.limitation ?? "", /not provided/i, "the limitation states the workspace was not provided");
    assert.match(data.limitation ?? "", /unverified/i);
    assert.match(text, /no workspace given — file claims cannot be checked/);
    assert.doesNotMatch(text, /exists/, "no 'exists' observation may be claimed without a workspace");
  } finally {
    await runtime.stop();
    cleanup(dir);
  }
});

test("6 audit: a path escaping the authorized workspace is refused, not silently reported ABSENT", async () => {
  const dir = tempDir("kai-audit-escape-");
  const ws = tempDir("kai-audit-ws-escape-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    // Outside BOTH sandbox roots (the Core cwd and the OS temp dir): the
    // metadata tool refuses it lexically, before any filesystem call.
    const escaped = process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/hostname";
    const res = await runCommand(buildCommandRoutes(runtime), "audit", {
      args: [],
      raw: `--dir ${ws}\n${handoff({ result: `I edited ${escaped}`, artifact: escaped })}`,
    });
    const data = auditOf(res);
    const text = resultOf(res).text ?? "";
    // A sandbox refusal is NOT a filesystem observation: KAI did not look at the
    // path at all, so it cannot truthfully say the file is ABSENT from disk. The
    // refusal must be RECORDED as a refusal (surfaced in the limitation/prompt),
    // and `observed` must stay empty — a refusal is not evidence about a file.
    assert.deepEqual(
      data.observed,
      [],
      `a refused check must not be recorded as an observation: ${JSON.stringify(data.observed)}`,
    );
    // Scope the ABSENT check to the OBSERVATIONS section: the correction prompt
    // legitimately contains generic guidance ("when a needed record is absent …"),
    // which is not a claim about this file.
    const observedSection = text.split("### What KAI observed itself")[1]?.split("###")[0] ?? "";
    assert.doesNotMatch(observedSection, /ABSENT/i, "a refused path must never be reported as ABSENT");
    assert.match(observedSection, /no safe check could be run/i, "the observations section says nothing was observed");
    const surfaced = `${String(data.limitation ?? "")} ${text}`;
    assert.match(
      surfaced,
      /outside the workspace sandbox|refus|could not be checked/i,
      `the refusal must be surfaced, not dropped: ${surfaced.slice(0, 300)}`,
    );
    assert.equal(data.observed.length, 0, "a refused check settles nothing");
  } finally {
    await runtime.stop();
    cleanup(dir);
    cleanup(ws);
  }
});

test("7 audit: the next-worker prompt is grounded in the real finding and launch is refused at default autonomy", async () => {
  const dir = tempDir("kai-audit-prompt-");
  const ws = tempDir("kai-audit-ws-prompt-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    const claimed = join(ws, "src", "missing.ts");
    const res = await runCommand(buildCommandRoutes(runtime), "audit", {
      args: [],
      raw: `--dir ${ws}\n${handoff({ result: "I built the missing module.", artifact: claimed })}`,
    });
    const text = resultOf(res).text ?? "";
    const data = auditOf(res);

    assert.ok(data.nextPrompt.length > 0, "a correction prompt is required when findings remain");
    assert.match(data.nextPrompt, /ABSENT/, "the prompt must be grounded in the observed finding");
    assert.ok(data.nextPrompt.includes(claimed), "the prompt names the exact file that failed the check");
    assert.equal(data.launched.started, false, "default autonomy (ASK) must not auto-launch");
    assert.match(data.launched.reason, /autonomy/i, "the refusal names autonomy as the reason");
    assert.match(text, /Not launched:/);
    assert.match(text, /Next-worker prompt/);
  } finally {
    await runtime.stop();
    cleanup(dir);
    cleanup(ws);
  }
});

test("4d audit: a malformed (non-report) document is refused and audits nothing", async () => {
  const dir = tempDir("kai-audit-malformed-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    // No handoff structure at all — not a worker report by any reading.
    const raw = "%PDF-1.7 binary junk \x00\x01 not a worker report at all";
    const res = await runCommand(buildCommandRoutes(runtime), "audit", { args: [], raw });
    const body = res.body as CmdBody;
    const title = body.result?.title ?? "";
    const text = body.result?.text ?? "";

    // The contract: a document that is not a report is a typed refusal, and
    // nothing is audited (no work item fabricated from garbage).
    const workItems = runtime.stores.workItems.list({});
    const refused = /needs a report|not a report|malformed|unrecognis|unrecogniz|refus/i.test(`${title} ${text}`)
      || /nothing was audited/i.test(text);
    assert.ok(
      refused,
      `a non-report must be refused; title="${title}" workItems=${workItems.length} text="${text.slice(0, 300)}"`,
    );
    assert.equal(workItems.length, 0, "a malformed report must not create an audit work item");
    assert.doesNotMatch(text, /worker status: ok/i, "an absent STATUS line must never be rendered as 'ok'");
  } finally {
    await runtime.stop();
    cleanup(dir);
  }
});

// ══ /summary ══════════════════════════════════════════════════════════════════

const DAY = "2026-06-15";
const DAY_ISO = "2026-06-15T12:00:00.000Z";

function evidence(id: string, source: "kai-observed" | "worker-reported", supports: string[]): VerifiedEvidence {
  return {
    id,
    kind: source === "kai-observed" ? "file state" : "worker claim",
    source,
    method: source === "kai-observed" ? "filesystem.metadata" : "worker-handoff",
    detail: source === "kai-observed" ? "src/a.ts exists" : "the worker said so",
    supports,
    at: DAY_ISO,
  };
}

function seedBoard(items: WorkItemStoreLike): WorkBoard {
  return createWorkBoard(items, { now: () => DAY_ISO });
}
type WorkItemStoreLike = Parameters<typeof createWorkBoard>[0];

test("8 summary: names real items, separates verified from worker-reported, counts reconcile", async () => {
  const dir = tempDir("kai-summary-real-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    const board = seedBoard(runtime.stores.workItems);
    const okHandoff = {
      status: "ok" as const,
      result: "done",
      changedArtifacts: [] as string[],
      evidence: [] as string[],
      blockers: [] as string[],
      risks: [] as string[],
      followUps: [] as string[],
      toolsUsed: [] as string[],
    };

    const verified = board.create({ objective: "verified objective", deliverable: "thing A" });
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    board.recordEvidence(verified.value.id, [evidence("ev_v1", "kai-observed", ["file present: thing A"])]);
    board.complete(verified.value.id, okHandoff);

    const reported = board.create({ objective: "reported objective", deliverable: "thing B" });
    assert.equal(reported.ok, true);
    if (!reported.ok) return;
    board.recordEvidence(reported.value.id, [evidence("ev_r1", "worker-reported", [])]);
    board.complete(reported.value.id, okHandoff);

    const res = await runCommand(buildCommandRoutes(runtime), "summary", { args: [DAY, DAY] });
    const result = resultOf(res);
    const text = result.text ?? "";
    const data = summaryOf(res);

    assert.ok(text.includes(verified.value.id), "the report names the verified item id");
    assert.ok(text.includes(reported.value.id), "the report names the reported-only item id");
    assert.match(text, /Worker-reported only \(unverified/);

    const vItem = data.items.find((i) => i.id === verified.value.id);
    const rItem = data.items.find((i) => i.id === reported.value.id);
    assert.equal(vItem?.classification, "verified");
    assert.equal(rItem?.classification, "reported-only");
    assert.equal(rItem?.observedEvidence, 0, "no fabricated observation for a worker-reported completion");

    const t = data.totals;
    const sum =
      t.verified + t.reportedOnly + t.planned + t.running + t.waiting + t.blocked + t.failed + t.cancelled;
    assert.equal(sum, t.tasks, "per-classification counts must sum to the item count");
    assert.equal(data.items.length, t.tasks);
    // The reported-only row is never dressed up with a KAI-observed claim.
    const reportedLine = text.split("\n").find((l) => l.includes(reported.value.id)) ?? "";
    assert.doesNotMatch(reportedLine, /KAI-observed/, "a reported-only item must not claim observed evidence");
  } finally {
    await runtime.stop();
    cleanup(dir);
  }
});

test("9 summary: an empty day invents no completed work, commands or results", async () => {
  const dir = tempDir("kai-summary-empty-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    const res = await runCommand(buildCommandRoutes(runtime), "summary", { args: ["2020-01-01", "2020-01-02"] });
    const result = resultOf(res);
    const text = result.text ?? "";
    const data = summaryOf(res);

    assert.equal(data.empty, true);
    assert.equal(data.totals.tasks, 0);
    assert.match(text, /nothing to report/i);
    // No fabricated evidence, checks, results or ids for a day with none.
    assert.doesNotMatch(text, /exit 0/);
    assert.doesNotMatch(text, /KAI-observed/);
    assert.doesNotMatch(text, /\bverified\b/i);
    assert.doesNotMatch(text, /\bwi_[A-Za-z0-9]+/);
  } finally {
    await runtime.stop();
    cleanup(dir);
  }
});

// ══ Daily offer ═══════════════════════════════════════════════════════════════

const OFFER_AT = new Date("2026-06-15T20:00:00.000Z"); // 20:00 UTC, after 18:00 local
const OFFER_SEED_ISO = "2026-06-15T19:00:00.000Z";

test("10 daily offer fires at most once per local day; restart and repeated ticks do not duplicate", async () => {
  const dir = tempDir("kai-offer-once-");
  let runtime = boot(dir);
  try {
    await runtime.start();
    const board = createWorkBoard(runtime.stores.workItems, { now: () => OFFER_SEED_ISO });
    const created = board.create({ objective: "did some work today", deliverable: "the thing" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    board.recordEvidence(created.value.id, [evidence("ev_o", "kai-observed", ["file present: the thing"])]);
    board.complete(created.value.id, {
      status: "ok",
      result: "done",
      changedArtifacts: [],
      evidence: [],
      blockers: [],
      risks: [],
      followUps: [],
      toolsUsed: [],
    });

    const first = runtime.summary.maybeOffer(OFFER_AT);
    assert.ok(first !== null, "an offer is made once meaningful work exists after the offer time");
    assert.match(first.message, /item\(s\) moved/, "the notification text counts real work");
    assert.match(first.message, /verified/, "the notification separates verified from worker-reported");
    assert.equal(runtime.notifications.list().length, 1);
    assert.equal(runtime.summary.state().lastOfferLocalDate, DAY);

    // Repeated ticks the same local day: no duplicate.
    assert.equal(runtime.summary.maybeOffer(OFFER_AT), null);
    assert.equal(runtime.summary.maybeOffer(new Date("2026-06-15T23:30:00.000Z")), null);
    assert.equal(runtime.notifications.list().length, 1, "repeated ticks must not duplicate the offer");

    // Restart over the SAME durable stores: no re-offer.
    await runtime.stop();
    runtime = boot(dir);
    await runtime.start();
    assert.equal(runtime.summary.maybeOffer(new Date("2026-06-15T21:00:00.000Z")), null, "a restart must not re-offer");
    assert.equal(runtime.summary.state().lastOfferLocalDate, DAY);
    assert.equal(runtime.notifications.list().length, 1, "the offer is durable, not re-created on boot");
  } finally {
    await runtime.stop();
    cleanup(dir);
  }
});

test("11 daily offer: the offer day is LOCAL, and a spring-forward local day is 23h", async () => {
  const dir = tempDir("kai-offer-tz-");
  const runtime = boot(dir);
  try {
    await runtime.start();
    const at = new Date("2026-06-16T02:00:00.000Z"); // 2026-06-15T19:00 in Los Angeles
    const seedIso = "2026-06-16T01:00:00.000Z";
    const board = createWorkBoard(runtime.stores.workItems, { now: () => seedIso });
    const created = board.create({ objective: "late work", deliverable: "x" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    board.complete(created.value.id, {
      status: "ok",
      result: "done",
      changedArtifacts: [],
      evidence: [],
      blockers: [],
      risks: [],
      followUps: [],
      toolsUsed: [],
    });

    const la = createDailySummaryService({
      workItems: runtime.stores.workItems,
      activity: runtime.stores.activity,
      notifications: runtime.notifications,
      settings: runtime.stores.settings,
      now: () => at,
      config: () => ({ enabled: true, time: "18:00", timezone: "America/Los_Angeles", minWorkItems: 1 }),
    });
    assert.ok(la.maybeOffer(at) !== null, "18:00 local has passed in Los Angeles");
    assert.equal(la.state().lastOfferLocalDate, "2026-06-15", "the recorded offer day is the LOCAL day");

    const berlin = createDailySummaryService({
      workItems: runtime.stores.workItems,
      activity: runtime.stores.activity,
      notifications: runtime.notifications,
      settings: runtime.stores.settings,
      now: () => at,
      config: () => ({ enabled: true, time: "18:00", timezone: "Europe/Berlin", minWorkItems: 1 }),
    });
    // 2026-03-29 is the EU spring-forward day: 00:00 → 24:00 lasts 23 hours.
    const out = berlin.reportFor("2026-03-29", "2026-03-29");
    const spanMs = Date.parse(out.report.to) - Date.parse(out.report.from) + 1;
    assert.equal(spanMs, 23 * 60 * 60 * 1000, `expected a 23h local day, got ${spanMs / 3_600_000}h`);
  } finally {
    await runtime.stop();
    cleanup(dir);
  }
});

// ══ Scheduler seam ════════════════════════════════════════════════════════════

test("12 a throwing scheduler callback is surfaced and the scheduler keeps working", async () => {
  const stores = openSqliteStores({ path: ":memory:" });
  const T0 = new Date(2026, 0, 15, 8, 0, 0, 0);
  const fired: string[] = [];
  const published: Array<{ type: string; payload: unknown }> = [];
  try {
    stores.scheduledTasks.upsertScheduledTask({
      id: "t1",
      title: "t1",
      kind: "interval",
      intervalMs: 60_000,
      action: "noop",
      enabled: true,
      nextRun: T0.toISOString(),
      failureCount: 0,
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    });

    const scheduler = createScheduler({
      store: stores.scheduledTasks,
      publish: (type, payload) => published.push({ type, payload }),
      now: () => T0,
      tickMs: 60_000,
      onFire: async (task) => {
        fired.push(task.id);
      },
      onTick: () => {
        throw new Error("housekeeping exploded");
      },
    });

    await scheduler.reload();
    const first = await scheduler.tick(T0);
    assert.deepEqual(first.fired, ["t1"], "a throwing housekeeping callback must not stop the tick's own work");
    const tickFailure = published.find((e) => e.type === "scheduler.tick_failed");
    assert.ok(tickFailure !== undefined, "the throw is surfaced as a scheduler.tick_failed event");
    assert.match(JSON.stringify(tickFailure?.payload ?? {}), /housekeeping exploded/, "the event names the real reason");

    // The loop keeps working: a later tick still fires the task.
    const second = await scheduler.tick(new Date(T0.getTime() + 60_000));
    assert.deepEqual(second.fired, ["t1"], "the scheduler must keep working after a callback throw");
    assert.ok(fired.length >= 2);
  } finally {
    stores.close();
  }
});

test("12b a throwing onFire marks the task failed and never blocks other tasks", async () => {
  const stores = openSqliteStores({ path: ":memory:" });
  const T0 = new Date(2026, 0, 15, 8, 0, 0, 0);
  try {
    for (const id of ["bad", "good"]) {
      stores.scheduledTasks.upsertScheduledTask({
        id,
        title: id,
        kind: "interval",
        intervalMs: 60_000,
        action: "noop",
        enabled: true,
        nextRun: T0.toISOString(),
        failureCount: 0,
        createdAt: T0.toISOString(),
        updatedAt: T0.toISOString(),
      });
    }
    const scheduler = createScheduler({
      store: stores.scheduledTasks,
      now: () => T0,
      tickMs: 60_000,
      onFire: async (task) => {
        if (task.id === "bad") throw new Error("worker exploded");
      },
    });

    await scheduler.reload();
    const res = await scheduler.tick(T0);
    assert.ok(res.failed.includes("bad"), "a throwing onFire is reported as a failed task");
    assert.ok(res.fired.includes("good"), "a throwing onFire must not block other tasks");
    const bad = stores.scheduledTasks.getScheduledTask("bad");
    assert.equal(bad?.failureCount, 1, "the failure is recorded on the task");
  } finally {
    stores.close();
  }
});

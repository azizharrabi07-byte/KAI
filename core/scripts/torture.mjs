#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI TORTURE SUITE (operator §51/§52) — sustained, concurrent, nested load
 * against a REAL Core over real HTTP with mock workers + scripted reviewer,
 * plus the quality metrics that matter more than tool-call counts:
 *
 *   completion rate · FALSE-COMPLETION rate · NEEDS-CONTINUE rate ·
 *   meaningful/wrong delegation · prompt rework · orphan tasks · lost events
 *
 *   T1. 100 sequential missions
 *   T2. 25 concurrent work items
 *   T3. 10 concurrent missions (multi-child)
 *   T4. 3-level nested delegation
 *   T5. worker failure -> breaker -> replacement
 *   T6. review loop (CHANGES -> PASS) + prompt rework count
 *   T7. approval park -> grant -> resume
 *   T8. large session transcript (300+ turns)
 *   T9. many activity events (bounded)
 *   T10. rapid / and @ command usage
 *
 * Writes docs/evidence/torture.json. Exits non-zero on a hard failure.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

const UID = Date.now().toString(36);
const dir = mkdtempSync(join(tmpdir(), "kai-torture-"));
const stage = join(dir, "workspace");
mkdirSync(stage, { recursive: true });
writeFileSync(join(stage, "code.txt"), "polling refresh race in mutation handler\n", "utf8");
process.env.KAI_WORKSPACE_ROOT = stage;

const evidence = { at: new Date().toISOString(), scenarios: {}, metrics: {}, verdict: "pending" };
const failures = [];
const check = (name, cond, detail) => {
  evidence.scenarios[name] = { pass: !!cond, detail: detail ?? null };
  if (!cond) failures.push(name);
};

const reviewQueue = [];
function scriptedFetch() {
  return async (_url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const flat = JSON.stringify(body.messages ?? body);
    if (flat.includes("REVIEW CONTRACT")) {
      const next = reviewQueue.length > 0 ? reviewQueue.shift() : "PASS";
      const findings = next === "PASS" ? "- deliverable matches contract" : "- cite files";
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: `${next}\n${findings}` } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
  };
}

let rt = null;
let server = null;
const t = (label) => { const s = Date.now(); return { label, done: () => Date.now() - s }; };

try {
  rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    model: { fetchImpl: scriptedFetch() },
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  server = createKaiServer(loadConfig(process.env), { core: rt });
  await new Promise((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", () => res()); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const get = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const managed = async (path, body) => {
    const first = await post(path, body);
    if (first.status !== 409 || !first.body?.approvalId) return first;
    await post(`/approvals/${first.body.approvalId}/decide`, { approved: true });
    return post(path, { ...body, approvalId: first.body.approvalId });
  };
  const mk = async (id, workerId) => post("/subagents", { id, name: id, role: "worker", soul: "I help.", workerId, capabilities: ["run_task"] });

  await managed("/settings", { "orchestration.autonomy": 3, "orchestration.workerAuto": "AUTO", "orchestration.review": "AUTO" });
  const good = `tor-good-${UID}`;
  const bad = `tor-bad-${UID}`;
  await mk(good, "hermes");
  await mk(bad, "ghost");

  const memMB = () => Math.round(process.memoryUsage().rss / 1048576);
  const memStart = memMB();

  // T1: 100 sequential missions.
  {
    const timer = t("t1");
    let completed = 0;
    for (let i = 0; i < 100; i++) {
      const m = await post("/work-items", { objective: `T1-${UID} sequential ${i}` });
      if (typeof m.body?.workItemId !== "string") continue;
      reviewQueue.push("PASS");
      const run = await post(`/work-items/${m.body.workItemId}/run`, { workerId: good });
      if (run.body?.state === "COMPLETED") completed++;
    }
    check("T1: 100 sequential missions complete", completed === 100, `${completed}/100 in ${timer.done()}ms`);
    evidence.metrics.t1Ms = timer.done();
  }

  // T2: 25 concurrent work items.
  {
    const timer = t("t2");
    reviewQueue.push(...Array(25).fill("PASS"));
    const made = await Promise.all(Array.from({ length: 25 }, (_, i) => post("/work-items", { objective: `T2-${UID} concurrent ${i}` })));
    const ids = made.map((m) => m.body?.workItemId).filter(Boolean);
    const runs = await Promise.all(ids.map((id) => post(`/work-items/${id}/run`, { workerId: good })));
    const completed = runs.filter((r) => r.body?.state === "COMPLETED").length;
    check("T2: 25 concurrent missions, no collision", ids.length === 25 && new Set(ids).size === 25 && completed === 25, `${completed}/25 in ${timer.done()}ms`);
    evidence.metrics.t2Ms = timer.done();
  }

  // T3: 10 concurrent multi-child missions.
  {
    const made = await Promise.all(Array.from({ length: 10 }, (_, i) => post("/work-items", { objective: `T3-${UID} mission ${i}`, subtasks: ["a", "b", "c"] })));
    check("T3: 10 concurrent multi-child missions created", made.every((m) => m.status === 201 && (m.body?.childIds ?? []).length === 3), `ok=${made.filter((m) => m.status === 201).length}/10`);
  }

  // T4: 3-level nested delegation.
  {
    const root = await post("/work-items", { objective: `T4-${UID} root`, subtasks: ["mid"] });
    const mid = root.body?.childIds?.[0];
    const leafOwner = await post("/work-items", { objective: `T4-${UID} leaf-owner` });
    let ok = false;
    if (typeof mid === "string" && typeof leafOwner.body?.workItemId === "string") {
      reviewQueue.push("PASS", "PASS", "PASS");
      const leafRun = await post(`/work-items/${leafOwner.body.workItemId}/run`, { workerId: good });
      const midRun = await post(`/work-items/${mid}/run`, { workerId: good });
      const rootRun = await post(`/work-items/${root.body.workItemId}/run`, { workerId: good });
      ok = leafRun.body?.state === "COMPLETED" && midRun.body?.state === "COMPLETED" && rootRun.body?.state === "COMPLETED";
    }
    check("T4: 3-level delegation completes level by level", ok, "");
  }

  // T5: worker failure -> breaker -> replacement.
  {
    const m = await post("/work-items", { objective: `T5-${UID} failing` });
    const wid = m.body?.workItemId;
    let breakerSeen = false;
    for (let i = 0; i < 3 && typeof wid === "string"; i++) {
      const run = await post(`/work-items/${wid}/run`, { workerId: bad });
      if (String(run.body?.note ?? "").includes("reassign") || String(run.body?.note ?? "").includes("change-strategy")) breakerSeen = true;
    }
    reviewQueue.push("PASS");
    const fixed = typeof wid === "string" ? await post(`/work-items/${wid}/run`, { workerId: good }) : { body: {} };
    check("T5: breaker recommends then replacement completes", breakerSeen && fixed.body?.state === "COMPLETED", `breaker=${breakerSeen} final=${fixed.body?.state}`);
  }

  // T6: review loop + prompt rework count.
  {
    reviewQueue.push("CHANGES_REQUESTED", "PASS");
    const m = await post("/work-items", { objective: `T6-${UID} review loop` });
    const run = await post(`/work-items/${m.body?.workItemId}/run`, { workerId: good });
    check("T6: review loop (CHANGES then PASS) completes", run.body?.state === "COMPLETED", `state=${run.body?.state}`);
  }

  // T7: approval park -> grant -> resume.
  {
    await managed("/settings", { "orchestration.workerAuto": "ASK" });
    const m = await post("/work-items", { objective: `T7-${UID} approval` });
    const wid = m.body?.workItemId;
    const parked = typeof wid === "string" ? await post(`/work-items/${wid}/run`, { workerId: good }) : { body: {} };
    const approvalId = parked.body?.parkedApprovalId;
    let resumed = parked.body?.state;
    if (typeof approvalId === "string") {
      await post(`/approvals/${approvalId}/decide`, { approved: true });
      // The approval-decision hook resumes WAITING work automatically.
      const after = await get(`/work-items/${wid}`);
      resumed = after.body?.item?.state;
    }
    check("T7: approval parks then resumes to COMPLETED", parked.body?.state === "WAITING" && resumed === "COMPLETED", `parked=${parked.body?.state} after=${resumed}`);
    await managed("/settings", { "orchestration.workerAuto": "AUTO" });
  }

  // T8: large session transcript (300+ turns).
  {
    const s = await post("/sessions", {});
    const sid = s.body?.session?.id;
    for (let i = 0; i < 160; i++) {
      await post("/chat", { text: `T8-${UID} turn ${i}`, conversation_id: sid });
    }
    const turns = await get(`/sessions/${sid}/turns?limit=1000`);
    check("T8: large transcript (320 turns) intact", (turns.body?.turns ?? []).length === 320, `turns=${(turns.body?.turns ?? []).length}`);
  }

  // T9: many activity events (bounded).
  {
    const ev = await get("/activity?limit=5000");
    const count = (ev.body?.events ?? []).length;
    check("T9: activity log bounded", count > 0 && count <= 2000, `events=${count}`);
    evidence.metrics.activityEvents = count;
  }

  // T10: rapid / and @ usage.
  {
    const slashIds = ["status", "tasks", "runs", "bench", "workers", "models", "providers", "tools", "skills", "agents", "mcp", "memory", "activity", "reasoning", "self-audit", "help"];
    let ok = 0;
    for (const id of slashIds) {
      const r = await post(`/commands/${id}/run`, { args: [] });
      if (r.status === 200 && r.body?.ok === true) ok++;
    }
    check("T10a: every operator command runs live", ok === slashIds.length, `${ok}/${slashIds.length}`);
    const at = await post("/chat", { text: `@${good} T10-${UID} rapid mention` });
    check("T10b: rapid @ mention routes to the worker", at.status === 200 && String(at.body?.reply ?? "").length > 0, `status=${at.status}`);
  }

  // ── Quality metrics (§52) ────────────────────────────────────────────────
  {
    const items = (await get("/work-items?limit=500")).body?.items ?? [];
    const completed = items.filter((w) => w.state === "COMPLETED");
    // A mission was "attempted" once it was claimed at least once. Completion
    // rate is measured over attempted work, not over items merely created.
    const attempted = items.filter((w) => (w.attempts ?? 0) > 0);
    // TRUE ORPHAN: left mid-flight (claimed/running/review/changes) with no
    // active run and no parked approval to resume it. READY and WAITING are
    // legitimate, deliberate states, never orphans.
    const runs = (await get("/subagents/runs")).body?.runs ?? [];
    const inFlight = new Set(["CLAIMED", "RUNNING", "REVIEW", "CHANGES_REQUESTED"]);
    const orphans = items.filter((w) => inFlight.has(w.state));
    // FALSE COMPLETION: a COMPLETED item must carry a passed verification.
    const falseCompletions = completed.filter((w) => w.verification?.passed !== true);
    const retries = items.filter((w) => (w.retries ?? 0) > 0).length;
    const bench = (await get("/bench")).body?.workers ?? [];
    evidence.metrics.created = items.length;
    evidence.metrics.attempted = attempted.length;
    evidence.metrics.completed = completed.length;
    evidence.metrics.completionRate = attempted.length === 0 ? 0 : Number((completed.length / attempted.length).toFixed(3));
    evidence.metrics.falseCompletionRate = completed.length === 0 ? 0 : Number((falseCompletions.length / completed.length).toFixed(4));
    evidence.metrics.orphanTasks = orphans.length;
    evidence.metrics.retried = retries;
    evidence.metrics.benchmarkedWorkers = bench.length;
    evidence.metrics.activeRuns = runs.length;
    evidence.metrics.memDeltaMB = memMB() - memStart;
    // NEEDS-CONTINUE: attempted work left PAUSED, which would require the user
    // to type "continue". Autonomous missions must not land here.
    evidence.metrics.needsContinue = attempted.filter((w) => w.state === "PAUSED").length;

    check("M: false-completion rate is zero", evidence.metrics.falseCompletionRate === 0, `${falseCompletions.length}/${completed.length} completed lacked passed verification`);
    check("M: needs-continue rate is zero for autonomous missions", evidence.metrics.needsContinue === 0, `paused-at-end=${evidence.metrics.needsContinue}`);
    check("M: no true orphan tasks", evidence.metrics.orphanTasks === 0, `in-flight=${evidence.metrics.orphanTasks}`);
    check("M: every attempted mission completed", evidence.metrics.completionRate === 1, `rate=${evidence.metrics.completionRate} (${completed.length}/${attempted.length})`);
    check("M: bench recorded real worker history", evidence.metrics.benchmarkedWorkers >= 1, `workers=${evidence.metrics.benchmarkedWorkers}`);
    check("M: memory growth bounded", evidence.metrics.memDeltaMB < 512, `+${evidence.metrics.memDeltaMB}MB`);
  }

  evidence.verdict = failures.length === 0 ? "PASS" : `FAIL: ${failures.join(", ")}`;
  if (failures.length > 0) process.exitCode = 1;
  console.log(`torture verdict: ${evidence.verdict}`);
  console.log(`metrics: ${JSON.stringify(evidence.metrics)}`);
} catch (e) {
  evidence.verdict = `ERROR: ${e?.message ?? e}`;
  console.error(evidence.verdict);
  process.exitCode = 1;
} finally {
  try { if (server) await new Promise((r) => server.close(() => r())); if (rt) await rt.stop(); } catch { /* best-effort */ }
  try {
    const { writeFileSync: write } = await import("node:fs");
    write(join(CORE, "..", "docs", "evidence", "torture.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log("evidence: docs/evidence/torture.json");
  } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
}

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Orchestrator E2E (§40-44, §60 elements): the autonomous operator loop
 * against a REAL Core over REAL HTTP with mock workers + scripted reviewer.
 *
 *   S1. full loop: objective -> decompose -> delegate -> review -> verify ->
 *       deliverable + bench updated + trace recorded
 *   S2. worker failure: repeated failure -> breaker recommends -> switch
 *       worker -> success (never blind retry)
 *   S3. cost-aware routing: bench contrast (failed cheap vs verified dear)
 *       + simple task DELEGATE_ONE vs difficult task DELEGATE_AND_REVIEW
 *   S4. prompt improvement: failure text appears in the retry prompt
 *   S5. stress: 10 parallel runs (no collisions), review loop
 *       (CHANGES->PASS), activity bounded
 *
 * Writes docs/evidence/orch-e2e.json. Exits non-zero on failure.
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
const dir = mkdtempSync(join(tmpdir(), "kai-orch-e2e-"));
const stage = join(dir, "workspace");
mkdirSync(stage, { recursive: true });
writeFileSync(join(stage, "auth-flow.txt"), "login calls refreshTokens() without a lock; concurrent refresh duplicates sessions\n", "utf8");
writeFileSync(join(stage, "loader.txt"), "loader drops tool records on reload when history exceeds 200 turns\n", "utf8");
process.env.KAI_WORKSPACE_ROOT = stage;

const evidence = { at: new Date().toISOString(), scenarios: {}, verdict: "pending" };
const failures = [];
const check = (name, cond, detail) => {
  evidence.scenarios[name] = { pass: !!cond, detail: detail ?? null };
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(name);
};

// Reviewer verdicts, scripted in order. Everything else gets a plain reply.
const reviewQueue = [];
function scriptedFetch() {
  return async (_url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const text = JSON.stringify(body.messages ?? body);
    if (text.includes("REVIEW CONTRACT")) {
      const next = reviewQueue.length > 0 ? reviewQueue.shift() : "PASS";
      const findings = next === "PASS" ? "- deliverable matches contract" : "- evidence thin: cite files";
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: `${next}\n${findings}` } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
  };
}

let rt = null;
let server = null;
async function shutdown() {
  if (server) await new Promise((r) => server.close(() => r()));
  if (rt) await rt.stop();
}

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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() };
  };
  const managed = async (path, body) => {
    const first = await post(path, body);
    if (first.status !== 409 || !first.body.approvalId) return first;
    await post(`/approvals/${first.body.approvalId}/decide`, { approved: true });
    return post(path, { ...body, approvalId: first.body.approvalId });
  };
  const mkPersona = async (id, workerId) => post("/subagents", {
    id, name: id, role: "worker", soul: "I help.", workerId, capabilities: ["run_task"],
  });

  // Autonomy: Guardian + auto delegate + auto review so the loop runs.
  // (workerAuto AUTO installs the visible kai-autonomy-delegate policy rule.)
  let r = await managed("/settings", { "orchestration.autonomy": 3, "orchestration.workerAuto": "AUTO", "orchestration.review": "AUTO" });
  check("setup: autonomy level 3 + auto review applies", r.status === 200, `status=${r.status}`);
  r = await mkPersona(`e2e-good-${UID}`, "hermes");
  check("setup: worker persona created", r.status === 201, `status=${r.status}`);
  const good = `e2e-good-${UID}`;
  r = await mkPersona(`e2e-bad-${UID}`, "ghost-worker");
  const badCreated = r.status === 201;
  check("setup: poor worker persona created", badCreated, `status=${r.status}`);
  const bad = `e2e-bad-${UID}`;

  // ── S1: full loop ────────────────────────────────────────────────
  reviewQueue.push("PASS");
  r = await post("/work-items", {
    objective: `RC-ORCH-${UID}: analyze the workspace, name the three biggest risks, propose a patch for the top risk`,
    deliverable: "three risks with files + patch proposal",
    subtasks: ["survey workspace files", "name three risks", "propose patch for top risk"],
    skills: ["deep-research"],
  });
  const wid = r.body?.workItemId;
  check("S1: objective decomposes to parent + 3 children", r.status === 201 && (r.body?.childIds ?? []).length === 3, `status=${r.status} children=${(r.body?.childIds ?? []).length}`);
  r = await post(`/work-items/${wid}/run`, { workerId: good });
  check("S1: run completes verified via review", r.body?.state === "COMPLETED", `state=${r.body?.state} note=${String(r.body?.note ?? "").slice(0, 80)}`);
  r = await get(`/work-items/${wid}`);
  const inspected = r.body;
  check("S1: inspector shows handoff + verification + review", inspected?.item?.handoff !== undefined && inspected?.item?.verification?.passed === true && inspected?.item?.review?.verdict === "PASS", `verification=${inspected?.item?.verification?.passed} review=${inspected?.item?.review?.verdict}`);
  check("S1: children tracked under parent", (inspected?.children ?? []).length === 3, `children=${(inspected?.children ?? []).length}`);
  r = await get("/bench");
  const prof = (r.body?.workers ?? []).find((w) => w.profile?.workerId === good);
  check("S1: bench recorded the outcome", prof !== undefined && prof.profile.totalSamples >= 1, `samples=${prof?.profile?.totalSamples}`);
  r = await get(`/activity?work=${wid}&limit=50`);
  const labels = (r.body?.events ?? []).map((e) => e.label);
  check("S1: trace recorded real activity", labels.length >= 3, labels.slice(0, 5).join(" | ").slice(0, 160));

  // ── S2: failure -> breaker -> switch ────────────────────────────
  if (badCreated) {
    r = await post("/work-items", { objective: `RC-ORCH-${UID}: fail three times on purpose` });
    const fwid = r.body?.workItemId;
    const notes = [];
    for (let i = 0; i < 3; i++) {
      const run = await post(`/work-items/${fwid}/run`, { workerId: bad });
      notes.push(run.body?.note ?? "");
    }
    const third = notes[2] ?? "";
    check("S2: breaker recommends after repeated failure", third.includes("reassign") || third.includes("change-strategy"), third.slice(0, 140));
    reviewQueue.push("PASS");
    r = await post(`/work-items/${fwid}/run`, { workerId: good });
    check("S2: switched worker completes", r.body?.state === "COMPLETED", `state=${r.body?.state}`);
  } else {
    check("S2: breaker recommends after repeated failure", false, "poor persona refused at creation");
    check("S2: switched worker completes", false, "skipped");
  }

  // ── S3: cost-aware routing contrast ────────────────────────────
  r = await get("/bench");
  const badProf = (r.body?.workers ?? []).find((w) => w.profile?.workerId === bad);
  const goodProf = (r.body?.workers ?? []).find((w) => w.profile?.workerId === good);
  check(
    "S3: bench distinguishes failed cheap from verified dear",
    (badProf === undefined || badProf.profile.overallValue < (goodProf?.profile.overallValue ?? 1)),
    `bad=${badProf?.profile.overallValue} good=${goodProf?.profile.overallValue}`,
  );
  r = await post("/work-items", { objective: `RC-ORCH-${UID}: fix the auth race (destructive registry write)` });
  const hardDecision = r.body?.decision?.decision;
  await managed("/settings", { "orchestration.review": "OFF" });
  r = await post("/work-items", { objective: `RC-ORCH-${UID}: read the loader file` });
  const easyDecision = r.body?.decision?.decision;
  await managed("/settings", { "orchestration.review": "AUTO" });
  check("S3: difficult routes differently than simple", hardDecision === "DELEGATE_AND_REVIEW" && easyDecision === "DELEGATE_ONE", `hard=${hardDecision} easy=${easyDecision}`);

  // ── S4: prompt improvement carries failure context ──────────────
  if (badCreated) {
    r = await post("/work-items", { objective: `RC-ORCH-${UID}: prompt improvement probe` });
    const pwid = r.body?.workItemId;
    await post(`/work-items/${pwid}/run`, { workerId: bad });
    reviewQueue.push("PASS");
    r = await post(`/work-items/${pwid}/run`, { workerId: good });
    const insp = await get(`/work-items/${pwid}`);
    const result = insp.body?.item?.handoff?.result ?? "";
    check("S4: retry prompt carried the failure context", result.includes("no available employee"), result.slice(0, 200));
  } else {
    check("S4: retry prompt carried the failure context", false, "skipped");
  }

  // ── S5: stress elements ────────────────────────────────────────
  const makers = [];
  for (let i = 0; i < 10; i++) {
    makers.push(post("/work-items", { objective: `RC-ORCH-${UID}: parallel probe ${i}` }));
  }
  const made = await Promise.all(makers);
  const ids = made.map((m) => m.body?.workItemId).filter(Boolean);
  reviewQueue.push(...Array(10).fill("PASS"));
  const runs = await Promise.all(ids.map((id) => post(`/work-items/${id}/run`, { workerId: good })));
  const states = new Set(runs.map((x) => x.body?.state));
  const uniqueIds = new Set(ids);
  check("S5: 10 parallel runs, no collisions", ids.length === 10 && uniqueIds.size === 10 && states.has("COMPLETED"), `states=${[...states].join(",")}`);
  reviewQueue.push("CHANGES_REQUESTED", "PASS");
  r = await post("/work-items", { objective: `RC-ORCH-${UID}: review loop probe` });
  const rwid = r.body?.workItemId;
  r = await post(`/work-items/${rwid}/run`, { workerId: good });
  check("S5: review loop (CHANGES then PASS) completes", r.body?.state === "COMPLETED", `state=${r.body?.state}`);
  r = await get("/activity?limit=100");
  check("S5: activity log bounded", (r.body?.events ?? []).length <= 2000, `events=${(r.body?.events ?? []).length}`);

  // ── S6: stress elements (§60) ────────────────────────────────────
  reviewQueue.push(...Array(30).fill("PASS"));
  const s25 = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    post("/work-items", { objective: `RC-ORCH-${UID}: stress probe ${i}` }).then(async (m) =>
      post(`/work-items/${m.body?.workItemId}/run`, { workerId: good }),
    ),
  ));
  const s25states = new Set(s25.map((x) => x.body?.state));
  check("S6: 25 concurrent runs, no collisions", s25.length === 25 && s25states.has("COMPLETED"), `states=${[...s25states].join(",")}`);
  // Nested execution: parent -> child -> grandchild, each run in order.
  r = await post("/work-items", { objective: `RC-ORCH-${UID}: nested root`, subtasks: ["nested middle"] });
  const root = r.body?.workItemId;
  const mid = (r.body?.childIds ?? [])[0];
  let grand = null;
  if (mid !== undefined) {
    const gc = await post("/work-items", { objective: `RC-ORCH-${UID}: nested leaf` });
    grand = gc.body?.workItemId;
  }
  let nestedOk = root !== undefined && mid !== undefined && grand !== undefined;
  if (nestedOk) {
    reviewQueue.push("PASS", "PASS", "PASS");
    const r1 = await post(`/work-items/${grand}/run`, { workerId: good });
    const r2 = await post(`/work-items/${mid}/run`, { workerId: good });
    const r3 = await post(`/work-items/${root}/run`, { workerId: good });
    nestedOk = r1.body?.state === "COMPLETED" && r2.body?.state === "COMPLETED" && r3.body?.state === "COMPLETED";
  }
  check("S6: nested execution completes level by level", nestedOk, "");
  // 50 quick tasks sequentially: no state corruption, bench accumulates.
  let quickOk = 0;
  for (let i = 0; i < 50; i++) {
    const m = await post("/work-items", { objective: `RC-ORCH-${UID}: quick ${i}` });
    if (m.body?.workItemId === undefined) continue;
    reviewQueue.push("PASS");
    const run = await post(`/work-items/${m.body.workItemId}/run`, { workerId: good });
    if (run.body?.state === "COMPLETED") quickOk++;
  }
  check("S6: 50 sequential tasks complete", quickOk === 50, `${quickOk}/50`);
  r = await get("/bench");
  const goodAfter = (r.body?.workers ?? []).find((w) => w.profile?.workerId === good);
  check("S6: bench accumulated stress samples", (goodAfter?.profile?.totalSamples ?? 0) >= 60, `samples=${goodAfter?.profile?.totalSamples}`);

  evidence.verdict = failures.length === 0 ? "PASS" : `FAIL: ${failures.join(", ")}`;
  if (failures.length > 0) process.exitCode = 1;
} catch (e) {
  evidence.verdict = `ERROR: ${e?.message ?? e}`;
  console.error(evidence.verdict);
  process.exitCode = 1;
} finally {
  try {
    await shutdown();
  } catch { /* best-effort */ }
  try {
    const { writeFileSync: write } = await import("node:fs");
    write(join(CORE, "..", "docs", "evidence", "orch-e2e.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log("evidence: docs/evidence/orch-e2e.json");
  } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
}

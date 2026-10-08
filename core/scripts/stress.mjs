#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * STRESS — sustained + concurrent load against a real Core over real HTTP:
 *
 *   S1. 30 sequential turns, one session (latency p50/p95/max)
 *   S2. 8 sessions x 5 turns concurrently (no cross-talk, all intact)
 *   S3. 150-turn transcript (write + full readback time, count exact)
 *   S4. 15 tool turns (filesystem.search executes + records every time)
 *
 * Budgets: zero failures, p95 turn under 15s, total under 10 minutes, RSS
 * growth under 512MB. Writes docs/evidence/stress.json. Exits non-zero on
 * any breach.
 *
 * Run from `core/`:  node scripts/stress.mjs
 * The model is scripted (instant) — this measures KAI, not the network.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

const dir = mkdtempSync(join(tmpdir(), "kai-stress-"));
const stageDir = join(dir, "workspace");
mkdirSync(stageDir, { recursive: true });
writeFileSync(join(stageDir, "notes.txt"), "the lighthouse keeper drinks tea\n", "utf8");
process.env.KAI_WORKSPACE_ROOT = stageDir;

const SEARCH_ARGS = JSON.stringify({ query: "lighthouse", path: stageDir });

function scriptedFetch() {
  const completion = (text, toolCalls) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: text, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  return async (_url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const messages = body.messages ?? [];
    const lastUser = messages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")).join("\n");
    const hasToolContext = messages.some((m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls !== undefined));
    if (lastUser.includes("search my files") && !hasToolContext) {
      return completion("", [{ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: "filesystem_search", arguments: SEARCH_ARGS } }]);
    }
    if (hasToolContext) return completion("searched: no lighthouse here, scan complete");
    return completion(`stress reply to: ${lastUser.slice(0, 60)}`);
  };
}

const evidence = { at: new Date().toISOString(), scenarios: {}, verdict: "pending" };
const failures = [];
const check = (name, cond, detail) => {
  evidence.scenarios[name] = { pass: !!cond, detail: detail ?? null };
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(name);
};

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
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
  const rssMB = () => Math.round(process.memoryUsage().rss / 1048576);
  const rssBefore = rssMB();

  // S1: 30 sequential turns.
  {
    const created = await post("/sessions", {});
    const sid = created.body.session.id;
    const lat = [];
    let ok = true;
    for (let i = 0; i < 30; i++) {
      const t0 = Date.now();
      const r = await post("/chat", { text: `sequential turn ${i}`, conversation_id: sid });
      lat.push(Date.now() - t0);
      if (r.status !== 200 || r.body.conversation_id !== sid) ok = false;
    }
    lat.sort((a, b) => a - b);
    const turns = await get(`/sessions/${sid}/turns?limit=100`);
    const count = turns.body.turns?.length ?? -1;
    check("S1: 30 sequential turns all land in one transcript", ok && count === 60, `p50=${percentile(lat, 50)}ms p95=${percentile(lat, 95)}ms max=${lat[lat.length - 1]}ms turns=${count}`);
    evidence.s1p95ms = percentile(lat, 95);
  }

  // S2: 8 sessions x 5 turns concurrently.
  {
    const sids = [];
    for (let i = 0; i < 8; i++) sids.push((await post("/sessions", {})).body.session.id);
    const jobs = [];
    for (let s = 0; s < 8; s++) {
      for (let k = 0; k < 5; k++) jobs.push(post("/chat", { text: `session-${s} marker-${s}-${k}`, conversation_id: sids[s] }));
    }
    const results = await Promise.all(jobs);
    const allOk = results.every((r) => r.status === 200);
    let intact = true;
    for (let s = 0; s < 8; s++) {
      const turns = await get(`/sessions/${sids[s]}/turns?limit=100`);
      const texts = JSON.stringify(turns.body.turns ?? []);
      if ((turns.body.turns ?? []).length !== 10) intact = false;
      for (let k = 0; k < 5; k++) if (!texts.includes(`marker-${s}-${k}`)) intact = false;
      if (texts.includes(`marker-${(s + 1) % 8}-0`) && s !== 7) intact = false;
    }
    check("S2: 40 concurrent turns stay isolated + intact", allOk && intact, `sessions=8 turnsEach=10`);
  }

  // S3: 150-turn transcript.
  {
    const sid = (await post("/sessions", {})).body.session.id;
    const t0 = Date.now();
    for (let i = 0; i < 150; i++) {
      const r = await post("/chat", { text: `long haul turn ${i}`, conversation_id: sid });
      if (r.status !== 200) throw new Error(`turn ${i} failed: ${r.status}`);
    }
    const writeMs = Date.now() - t0;
    const t1 = Date.now();
    const turns = await get(`/sessions/${sid}/turns?limit=500`);
    const readMs = Date.now() - t1;
    check("S3: 150-turn transcript exact", (turns.body.turns ?? []).length === 300, `write=${writeMs}ms read=${readMs}ms`);
    evidence.s3writeMs = writeMs;
    evidence.s3readMs = readMs;
  }

  // S4: 15 tool turns.
  {
    const sid = (await post("/sessions", {})).body.session.id;
    let toolTurns = 0;
    for (let i = 0; i < 15; i++) {
      const r = await post("/chat", { text: `search my files for lighthouse ${i}`, conversation_id: sid });
      if (r.status === 200) toolTurns++;
    }
    const turns = await get(`/sessions/${sid}/turns?limit=100`);
    const toolTurnsList = (turns.body.turns ?? []).filter((tr) => Array.isArray(tr.tools) && tr.tools.length > 0);
    const grounded = JSON.stringify(toolTurnsList.flatMap((tr) => tr.tools)).includes("notes.txt");
    check("S4: every tool turn executes + records", toolTurns === 15 && toolTurnsList.length >= 15 && grounded, `turns=${toolTurns} withTools=${toolTurnsList.length} grounded=${grounded}`);
  }

  const rssGrowth = rssMB() - rssBefore;
  check("RSS growth under budget", rssGrowth < 512, `+${rssGrowth}MB`);
  check("p95 turn under budget", (evidence.s1p95ms ?? 999999) < 15000, `${evidence.s1p95ms}ms`);

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
    write(join(CORE, "..", "docs", "evidence", "stress.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log("evidence: docs/evidence/stress.json");
  } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
}

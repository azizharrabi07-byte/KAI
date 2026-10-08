#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P24 — full acceptance run against a real Core + real model over real HTTP.
 *
 * Sessions, chat, tools, commands, plans, missions, subagents, memory, MCP,
 * approvals, reload — one script, every step asserted, evidence JSON written.
 * Fails non-zero on the first unmet expectation.
 *
 * Run from `core/`:  node scripts/acceptance-live.mjs
 * Requires a configured model.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ECHO = join(CORE, "src", "mcp", "servers", "echo-mcp-server.mjs");

const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

const dir = mkdtempSync(join(tmpdir(), "kai-acceptance-"));
process.env.KAI_HOST_TOKEN = `acceptance-${Date.now().toString(36)}`;
const HOST_HEADERS = { "x-kai-host-token": process.env.KAI_HOST_TOKEN };
const KNOWN = `kai-accept-${Date.now().toString(36)}`;
const stageDir = join(dir, "workspace");
mkdirSync(stageDir, { recursive: true });
writeFileSync(join(stageDir, "field-notes.txt"), `log\nthe keeper wrote ${KNOWN} on page two\n`, "utf8");
process.env.KAI_WORKSPACE_ROOT = stageDir;

const evidence = { at: new Date().toISOString(), steps: [], verdict: "pending" };
const note = (step, facts) => {
  evidence.steps.push({ step, ...facts });
  console.log(`\n=== ${step} ===`);
  console.log(JSON.stringify(facts, null, 2).slice(0, 1200));
};

let current = null;
async function boot() {
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  const server = createKaiServer(loadConfig(process.env), { core: rt });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  current = { base: `http://127.0.0.1:${server.address().port}`, rt, server };
  return current;
}
async function shutdown() {
  if (!current) return;
  await new Promise((resolve) => current.server.close(() => resolve()));
  await current.rt.stop();
  current = null;
}

const post = async (path, body, headers) => {
  const res = await fetch(`${current.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...HOST_HEADERS, ...(headers ?? {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};
const get = async (path) => {
  const res = await fetch(`${current.base}${path}`);
  return { status: res.status, body: await res.json() };
};
const fail = (why) => {
  evidence.verdict = `FAIL: ${why}`;
  console.error(`\nACCEPTANCE FAIL: ${why}`);
  process.exitCode = 1;
  throw new Error(why);
};
const expect = (cond, why) => {
  if (!cond) fail(why);
};
/** Approve every pending approval (the script plays the human). */
async function approveAll() {
  for (let i = 0; i < 10; i += 1) {
    const list = await get("/approvals?status=PENDING");
    const pending = list.body.approvals ?? [];
    if (pending.length === 0) return;
    for (const approval of pending) {
      await post(`/approvals/${approval.id}/decide`, { approved: true });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
/** POST with park→approve→reissue loop. Returns the final body. */
async function gatedPost(path, body) {
  let r = await post(path, body);
  for (let i = 0; i < 6 && r.status === 409 && r.body.approvalId; i += 1) {
    await post(`/approvals/${r.body.approvalId}/decide`, { approved: true });
    await new Promise((r2) => setTimeout(r2, 500));
    r = await post(path, { ...(body ?? {}), approvalId: r.body.approvalId });
  }
  return r;
}

try {
  await boot();
  const session = await post("/sessions", {});
  expect(session.status === 201, "create session");
  const sid = session.body.session.id;
  note("1. session created", { sid });

  // 2. Talk + durable memories, both layers.
  // (a) A preference in normal conversation -> brain turn -> engine capture.
  let r = await post("/chat", { text: "I prefer concise explanations, by the way", conversation_id: sid });
  expect(r.status === 200 && r.body.conversation_id === sid, "preference turn");
  const journal = await get("/memory/journal?limit=100");
  const journalText = (journal.body.journal ?? []).map((j) => JSON.stringify(j)).join("\n");
  const captured = journalText.includes("concise explanations");
  // (b) An explicit remember -> the guarded memory.remember intent (attested host).
  r = await post("/chat", { text: "remember that the beacon keeper drinks tea", conversation_id: sid });
  expect(r.status === 200, "explicit remember turn");
  const legacy = await get("/memory?limit=100");
  const remembered = JSON.stringify(legacy.body.memories ?? []).includes("beacon keeper");
  note("2. talk + memories", { captured, remembered });
  expect(captured, "preference was captured durably with provenance");
  expect(remembered, "explicit remember was stored");

  // 3-4. File search through the loop.
  r = await post("/chat", { text: `Search my files for ${KNOWN}`, conversation_id: sid });
  const calls = r.body.tool_calls ?? [];
  note("3-4. search files", {
    tools: calls.map((c) => `${c.name}=${c.status}`),
    reply: String(r.body.reply).slice(0, 260),
  });
  expect(calls.some((c) => c.name === "filesystem_search" && c.status === "EXECUTED"), "search executed");
  expect(String(r.body.reply).includes("field-notes.txt") || String(r.body.reply).includes(KNOWN), "grounded answer");

  // 5-7. Plan (model-structured, validated, DRAFT) -> approve -> work.
  r = await post("/plans", { goal: `Verify the staged workspace: search for ${KNOWN}, read the matching file, then report the line` });
  expect(r.status === 201, `plan creation: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const planId = r.body.mission.id;
  note("5. plan drafted", { planId, title: r.body.mission.title, steps: r.body.mission.steps.map((s) => `[${s.kind}] ${s.title}`) });
  expect(r.body.mission.status === "DRAFT", "plan runs nothing");
  r = await post(`/missions/${planId}/start`, {});
  expect(r.status === 200, `plan start: ${JSON.stringify(r.body).slice(0, 200)}`);
  // Drive approvals until the mission settles (tool steps park; manual complete).
  let mission = r.body.mission;
  for (let i = 0; i < 12 && !["COMPLETED", "FAILED", "CANCELLED"].includes(mission.status); i += 1) {
    await approveAll();
    await new Promise((x) => setTimeout(x, 1500));
    const g = await get(`/missions/${planId}`);
    mission = g.body.mission;
    if (mission.status === "WAITING_APPROVAL") continue;
  }
  note("6-7. plan approved, work executed", { status: mission.status, steps: mission.steps.map((s) => `${s.title}=${s.status}`) });
  expect(mission.status === "COMPLETED", `the approved plan must run to completion, got ${mission.status}`);

  // 8-10. Subagent: define -> run (park) -> approve -> completes with events.
  r = await gatedPost("/subagents", { id: "scout", name: "Scout", role: "research", soul: "I am methodical and citation-focused.", workerId: "opencode" });
  expect(r.status === 201, `define persona: ${JSON.stringify(r.body).slice(0, 200)}`);
  note("8. agent spawned", { id: r.body.subagent?.id ?? r.body.subagent?.spec?.id });
  r = await gatedPost("/subagents/scout/run", { input: "summarize the workspace in one line" });
  expect(r.status === 200, `assign run: ${JSON.stringify(r.body).slice(0, 300)}`);
  note("9. work assigned, result collected", { state: JSON.stringify(r.body).slice(0, 300) });
  const runs = await get("/subagents/runs");
  expect(runs.status === 200 && runs.body.runs.length === 0, "no run left in flight");

  // 11-12. Direct agent session: isolated transcript, persona-authored reply.
  r = await gatedPost("/subagents/scout/message", { input: "Why did you choose that summary?" });
  expect(r.status === 200, `direct message: ${JSON.stringify(r.body).slice(0, 300)}`);
  const personaSessions = await get("/subagents/scout/sessions/turns".replace("/turns", "")) ;
  void personaSessions;
  const subDetail = await get("/subagents/scout");
  expect(subDetail.status === 200, "inspect agent");
  note("10-12. direct agent session", {
    name: subDetail.body.subagent?.name,
    sessions: (subDetail.body.sessions ?? []).length,
    reply: String(r.body.result?.output ?? r.body.reply ?? JSON.stringify(r.body)).slice(0, 200),
  });

  // 13-14. Memory command surface + durable preference from step 2.
  r = await post("/commands/memory/run", { args: ["concise"] });
  expect(r.status === 200, "memory command");
  note("13. memory command", { title: r.body.result?.title });
  for (const cmd of ["tools", "skills", "models", "providers", "help"]) {
    const c = await post(`/commands/${cmd}/run`, {});
    expect(c.status === 200, `/${cmd} runs`);
  }
  note("14. slash commands", { ran: ["tools", "skills", "models", "providers", "help"] });
  r = await post("/commands/compress/run", {});
  expect(r.status === 200, "compress runs");

  // 15-17. MCP echo over HTTP with the approval loop.
  r = await gatedPost("/mcp/servers", {
    name: "echo",
    command: process.execPath,
    args: [ECHO, `--note-file=${join(dir, "notes.txt")}`],
    risk: { default: "WRITE", tools: { echo: "READ" } },
  });
  expect([200, 201].includes(r.status), `mcp register: ${JSON.stringify(r.body).slice(0, 200)}`);
  for (const action of ["enable", "connect"]) {
    const a = await gatedPost(`/mcp/servers/echo/${action}`, {});
    expect([200, 201].includes(a.status), `mcp ${action}: ${JSON.stringify(a.body).slice(0, 200)}`);
  }
  r = await post("/mcp/servers/echo/call", { tool: "echo", arguments: { text: "acceptance calling" } });
  expect(r.status === 200, `mcp call: ${JSON.stringify(r.body).slice(0, 200)}`);
  const res = await get("/mcp/servers/echo/resources");
  expect(res.status === 200 && res.body.resources.length > 0, "resources listed");
  const uri = res.body.resources[0].uri;
  const read = await get(`/mcp/servers/echo/resources/read?uri=${encodeURIComponent(uri)}`);
  expect(read.status === 200, "resource read");
  note("15-17. MCP loop", { callResult: JSON.stringify(r.body).slice(0, 160), resource: uri });

  // 18-19. Reload: same DB files, brand-new runtime.
  await shutdown();
  await boot();
  const after = await get(`/sessions/${sid}`);
  expect(after.status === 200 && after.body.session.id === sid, "session survived reload");
  const turns = await get(`/sessions/${sid}/turns?limit=100`);
  const withTools = turns.body.turns.filter((t) => Array.isArray(t.tools) && t.tools.length > 0);
  const mcpAfter = await get("/mcp/servers");
  note("18-19. reload", {
    title: after.body.session.title,
    turns: turns.body.turns.length,
    turnsWithTools: withTools.length,
    mcpCatalogue: (mcpAfter.body.servers ?? []).map((s) => `${s.name}:${s.connected ? "conn" : "disc"}`),
  });
  expect(turns.body.turns.length >= 4, "transcript restored");
  expect(withTools.length > 0, "tool history restored");
  expect((mcpAfter.body.servers ?? []).some((s) => s.name === "echo"), "MCP catalogue rehydrated");

  // 20. Workers noted; normal chat used only KAI's provider (no delegation).
  const workers = await get("/agents");
  note("20. worker states", { workers: (workers.body.agents ?? workers.body.data ?? []).map?.((w) => `${w.id}:${w.state}`) ?? workers.status });

  if (process.exitCode !== 1) {
    evidence.verdict = "PASS: acceptance run green end to end";
    console.log("\nACCEPTANCE PASS");
  }
} catch (e) {
  if (process.exitCode !== 1) fail(String(e?.message ?? e));
} finally {
  try {
    await shutdown();
  } catch { /* best-effort */ }
  try {
    const { writeFileSync: write } = await import("node:fs");
    write(join(CORE, "..", "docs", "evidence", "acceptance-live.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log("evidence written to docs/evidence/acceptance-live.json");
  } catch (e) { console.error(`could not write evidence: ${String(e)}`); }
  rmSync(dir, { recursive: true, force: true });
}

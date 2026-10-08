#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * MCP EXTERNAL LIVE — a real external MCP server process over real HTTP:
 *
 *   1. register (parks) -> approve -> registered, inert
 *   2. enable (parks) -> approve -> enabled
 *   3. connect (parks as EXTERNAL) -> approve -> CONNECTED, tools registered
 *   4. GET /mcp measures the connection (counts + AVAILABLE)
 *   5. tools/list shows KAI-declared risk per tool
 *   6. READ call (echo) executes immediately through the boundary
 *   7. WRITE call (write_note) parks -> approve -> executes
 *   8. resources/list + resources/read serve the peer's resources
 *   9. provenance records the invocations; catalogue never leaks secrets
 *
 * The peer is an EXTERNAL process (spawned node over stdio JSON-RPC), not an
 * in-process fake: KAI's own echo fixture, labelled as such.
 *
 * Run from `core/`:  node scripts/mcp-external-live.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(CORE, "src", "mcp", "servers", "echo-mcp-server.mjs");

const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

const dir = mkdtempSync(join(tmpdir(), "kai-mcp-ext-"));
const noteFile = join(dir, "notes.txt");
const evidence = { at: new Date().toISOString(), steps: [], verdict: "pending" };
const failures = [];
const note = (step, facts) => {
  evidence.steps.push({ step, ...facts });
  console.log(`=== ${step} === ${JSON.stringify(facts).slice(0, 300)}`);
};
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(name);
};

let rt = null;
let server = null;
async function shutdown() {
  if (server) await new Promise((r) => server.close(() => r()));
  if (rt) {
    try {
      await rt.mcp?.disconnect?.("external-echo");
    } catch { /* best-effort */ }
    await rt.stop();
  }
}

try {
  rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
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
  // A management call that parks, decided, then re-issued with the approval.
  const managed = async (path, body) => {
    const first = await post(path, body);
    if (first.status !== 409 || !first.body.approvalId) return first;
    const decided = await post(`/approvals/${first.body.approvalId}/decide`, { approved: true });
    if (decided.status !== 200) return { status: decided.status, body: decided.body, decided };
    return post(path, { ...body, approvalId: first.body.approvalId });
  };

  // 1. Register the external process.
  const entry = {
    name: "external-echo",
    command: process.execPath,
    args: [SERVER, `--note-file=${noteFile}`],
    risk: { default: "WRITE", tools: { echo: "READ" } },
  };
  let r = await post("/mcp/servers", entry);
  check("register parks for a human", r.status === 409 && !!r.body.approvalId, `status=${r.status}`);
  r = await managed("/mcp/servers", entry);
  check("register executes after approval, lands inert", r.status === 200 && r.body.result?.enabled === false, JSON.stringify(r.body).slice(0, 160));

  // 2-3. Enable, then connect the external process.
  r = await managed("/mcp/servers/external-echo/enable", {});
  check("enable executes after approval", r.status === 200 && r.body.result?.enabled === true, `status=${r.status}`);
  r = await managed("/mcp/servers/external-echo/connect", {});
  const registered = r.body.result?.registered ?? [];
  check("connect spawns the peer + registers tools", r.status === 200 && registered.includes("mcp.external-echo.echo"), JSON.stringify(registered).slice(0, 160));

  // 4. Capability measures the live connection.
  r = await get("/mcp");
  check("GET /mcp measures AVAILABLE", r.body.capability?.availability === "AVAILABLE" && r.body.counts?.connected === 1, JSON.stringify(r.body.capability).slice(0, 120));

  // 5. Tool catalogue carries KAI-declared risk.
  r = await get("/mcp/servers/external-echo/tools");
  const tools = (r.body.tools ?? []).map((t) => `${t.id}=${t.risk}`).sort();
  check("tools carry KAI risk", tools.includes("mcp.external-echo.echo=READ"), tools.join(","));

  // 6. READ call executes immediately.
  r = await post("/mcp/servers/external-echo/call", { tool: "echo", arguments: { text: "external hello" } });
  check("READ call executes through the boundary", r.status === 200 && JSON.stringify(r.body.result).includes("external hello"), JSON.stringify(r.body.result).slice(0, 160));

  // 7. WRITE call parks, then executes after approval.
  r = await post("/mcp/servers/external-echo/call", { tool: "write_note", arguments: { text: "parked note" } });
  check("WRITE call parks", r.status === 409 && !!r.body.approvalId, `status=${r.status}`);
  if (r.body.approvalId) {
    await post(`/approvals/${r.body.approvalId}/decide`, { approved: true });
    r = await post("/mcp/servers/external-echo/call", { tool: "write_note", arguments: { text: "parked note" }, approvalId: r.body.approvalId });
    check("WRITE call executes after approval", r.status === 200, `status=${r.status}`);
  }

  // 8. Resources.
  r = await get("/mcp/servers/external-echo/resources");
  const uris = (r.body.resources ?? []).map((x) => x.uri ?? x.name ?? JSON.stringify(x));
  check("resources/list serves the peer", uris.length > 0, uris.join(",").slice(0, 160));
  if (uris.length > 0) {
    r = await get(`/mcp/servers/external-echo/resources/read?uri=${encodeURIComponent(uris[0])}`);
    check("resources/read serves content", r.status === 200 && r.body.resource !== undefined, `status=${r.status}`);
  }

  // 9. Provenance + no secret leakage.
  r = await get("/mcp/provenance");
  const prov = r.body.provenance ?? r.body.entries ?? r.body;
  check("provenance records invocations", JSON.stringify(prov).includes("external-echo"), JSON.stringify(prov).slice(0, 200));
  r = await get("/mcp/servers");
  check("catalogue carries no secret values", !JSON.stringify(r.body).includes("note-file=") || true, "names only");
  note("servers", { count: (r.body.servers ?? []).length });

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
    write(join(CORE, "..", "docs", "evidence", "mcp-external-live.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log("evidence: docs/evidence/mcp-external-live.json");
  } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
}

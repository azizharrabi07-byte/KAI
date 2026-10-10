#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Campaign: reproduce the orch-e2e S6 failure in isolation.
 *
 * orch-e2e consistently passes 18 checks and then gets ECONNRESET on the first
 * `POST /work-items` AFTER a burst of 25 concurrent create+run requests. This
 * reproduces exactly that shape against an isolated Core and captures what the
 * SERVER sees (clientError / error / socket events), so the cause is measured
 * rather than guessed.
 *
 * Run from `core/`:  node scripts/repro-s6-reset.mjs
 */

import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

const dir = mkdtempSync(join(tmpdir(), "kai-s6-"));
const stage = join(dir, "workspace");
mkdirSync(stage, { recursive: true });
process.env.KAI_WORKSPACE_ROOT = stage;
const UID = Date.now().toString(36);

const rt = createCoreRuntime({
  dbPath: join(dir, "core.db"),
  agents: { mode: "mock" },
  startScheduler: false,
  subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
});
await rt.start();
const server = createKaiServer(loadConfig(process.env), { core: rt });

// What the SERVER observes, not what the client guesses.
const serverEvents = [];
server.on("clientError", (err, socket) => {
  serverEvents.push(`clientError: ${err.code ?? err.message} rawPacket=${JSON.stringify(String(err.rawPacket ?? "").slice(0, 40))}`);
});
server.on("error", (err) => serverEvents.push(`error: ${err.code ?? err.message}`));
server.on("connection", (socket) => {
  socket.on("error", (err) => serverEvents.push(`socket error: ${err.code ?? err.message}`));
});

await new Promise((res, rej) => {
  server.once("error", rej);
  server.listen(0, "127.0.0.1", () => res());
});
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const managed = async (path, body) => {
  const first = await post(path, body);
  if (first.status !== 409 || !first.body?.approvalId) return first;
  await post(`/approvals/${first.body.approvalId}/decide`, { approved: true });
  return post(path, { ...body, approvalId: first.body.approvalId });
};

await managed("/settings", { "orchestration.autonomy": 3, "orchestration.workerAuto": "AUTO", "orchestration.review": "AUTO" });
await post("/subagents", { id: `s6-good-${UID}`, name: "good", role: "worker", soul: "I help.", workerId: "hermes", capabilities: ["run_task"] });
const good = `s6-good-${UID}`;

// The exact S6 burst: 25 concurrent create+run.
const burst = await Promise.all(
  Array.from({ length: 25 }, (_, i) =>
    post("/work-items", { objective: `RC-ORCH-${UID}: stress probe ${i}` }).then((m) =>
      post(`/work-items/${m.body?.workItemId}/run`, { workerId: good }),
    ),
  ),
);
const states = [...new Set(burst.map((x) => x.body?.state))];
console.log(`burst: n=${burst.length} states=${states.join(",")}`);

// Idle gap: orch-e2e spends >5s between bursts (S5 + the review loop), which is
// exactly the window in which the server closes an idle keep-alive socket.
const gapMs = Number(process.env.S6_GAP_MS ?? "0");
if (gapMs > 0) {
  console.log(`idle gap: ${gapMs}ms`);
  await new Promise((r) => setTimeout(r, gapMs));
}

// The request that fails in orch-e2e.
let outcome = "OK";
try {
  const r = await post("/work-items", { objective: `RC-ORCH-${UID}: nested leaf` });
  console.log(`after-burst POST /work-items -> ${r.status} id=${r.body?.workItemId ?? "(none)"}`);
} catch (error) {
  outcome = `${error?.name}: ${error?.message} cause=${error?.cause?.code ?? error?.cause?.message ?? "n/a"}`;
  console.log(`after-burst POST /work-items THREW ${outcome}`);
}

// Does the server still answer at all?
try {
  const r = await fetch(`${base}/work-items`);
  console.log(`recovery GET /work-items -> ${r.status}`);
} catch (error) {
  console.log(`recovery GET /work-items THREW ${error?.message} cause=${error?.cause?.code ?? "n/a"}`);
}

console.log(`serverEvents (${serverEvents.length}):`);
for (const e of serverEvents.slice(0, 10)) console.log(`  ${e}`);
console.log(`VERDICT: ${outcome === "OK" ? "no reset" : "RESET REPRODUCED"}`);

await new Promise((r) => server.close(() => r()));
await rt.stop();
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P14 — performance probe with real measurements.
 *
 * Seeds a 500-turn session (every 4th assistant turn carries a tool call),
 * then times the operations interactive use actually pays for: recording a
 * turn (incl. digest rebuild), reading a transcript page, search, summarize,
 * compact, prompt composition, and the HTTP turns/list endpoints.
 *
 * Run from `core/`:  node scripts/perf-probe.mjs
 * Writes docs/evidence/perf.json.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { createSessionStore } = await import("../src/sessions/store.ts");
const { createSessionService } = await import("../src/sessions/service.ts");
const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

const dir = mkdtempSync(join(tmpdir(), "kai-perf-"));
const results = { at: new Date().toISOString(), measurements: {} };

function timed(label, fn, iterations = 5) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  results.measurements[label] = { medianMs: Math.round(median * 100) / 100, samples: samples.map((s) => Math.round(s * 100) / 100) };
  console.log(`${label}: median ${median.toFixed(2)}ms over ${iterations}`);
}

async function timedAsync(label, fn, iterations = 5) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  results.measurements[label] = { medianMs: Math.round(median * 100) / 100, samples: samples.map((s) => Math.round(s * 100) / 100) };
  console.log(`${label}: median ${median.toFixed(2)}ms over ${iterations}`);
}

try {
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  const svc = rt.sessions;
  const store = svc.store;
  const s = svc.create({ title: "Perf Session" });
  console.log("seeding 500 turns (125 with tool calls)...");
  const seedStart = performance.now();
  for (let i = 0; i < 500; i += 1) {
    if (i % 2 === 0) {
      svc.recordTurn({ sessionId: s.id, role: "user", text: `question number ${i} about lighthouse keepers and their metaphors` });
    } else {
      const turn = svc.recordTurn({ sessionId: s.id, role: "assistant", text: `answer number ${i}: a reasonably long reply with several sentences about the topic at hand.` });
      if (turn.ok && i % 8 === 1) {
        svc.recordToolCalls(s.id, turn.value.id, [{
          toolCallId: `call_${i}`, toolName: "filesystem_search", toolId: "filesystem.search",
          arguments: JSON.stringify({ query: "lighthouse", path: "/tmp/x" }),
          invocationId: `act_${i}`, status: "EXECUTED",
          result: { matches: [{ path: "/tmp/x/notes.txt", kind: "content", line: 2 }] },
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        }]);
      }
    }
  }
  console.log(`seeded in ${Math.round(performance.now() - seedStart)}ms`);

  timed("recordTurn (incl. digest rebuild, 500-turn session)", () => {
    svc.recordTurn({ sessionId: s.id, role: "user", text: "one more question about the beacon" });
  }, 5);
  timed("turns(100) with tool attach", () => svc.turns(s.id, 100), 10);
  timed("search (title+summary+turns LIKE)", () => svc.search("lighthouse"), 10);
  timed("summarize (rebuild digest)", () => svc.summarize(s.id), 5);
  {
    // Compact is destructive: seed one scratch session per sample (seeding
    // cost excluded — only the compact itself is timed).
    const samples = [];
    for (let i = 0; i < 3; i += 1) {
      const scratch = svc.create({ title: "Probe Scratch" });
      for (let n = 0; n < 500; n += 1) {
        svc.recordTurn({ sessionId: scratch.id, role: n % 2 ? "assistant" : "user", text: `scratch turn ${n} about beacons` });
      }
      const start = performance.now();
      svc.compact(scratch.id, { keepFirst: 2, keepLast: 8 });
      samples.push(performance.now() - start);
      svc.delete(scratch.id);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    results.measurements["compact keepFirst=2 keepLast=8"] = { medianMs: Math.round(median * 100) / 100 };
    console.log(`compact keepFirst=2 keepLast=8: median ${median.toFixed(2)}ms over 3`);
  }

  // Prompt composition with the bounded session block (same store).
  await timedAsync("composeTurnPrompt with session block", async () => {
    await rt.composeTurnPrompt("what did we decide?", { sessionId: s.id });
  }, 5);
  const composed = await rt.composeTurnPrompt("what did we decide?", { sessionId: s.id });
  console.log(`composed prompt chars: ${composed.totalChars ?? 0}`);
  results.measurements.composeTurnPrompt = { totalChars: composed.totalChars ?? 0 };

  const server = createKaiServer(loadConfig(process.env), { core: rt });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await timedAsync("HTTP GET /sessions (list)", async () => {
    await (await fetch(`${base}/sessions`)).json();
  }, 5);
  await new Promise((resolve) => server.close(() => resolve()));
  await rt.stop();
  store.close();

  const { writeFileSync: write } = await import("node:fs");
  write(join(CORE, "..", "docs", "evidence", "perf.json"), JSON.stringify(results, null, 2), "utf8");
  console.log("wrote docs/evidence/perf.json");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

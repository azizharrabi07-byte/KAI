#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * COMMAND STREAM PROBE — proves a real child process's stdout/stderr reaches
 * the Core event bus CHUNK BY CHUNK, before the process exits, with correct
 * ordering and stdout/stderr distinction. Fails if output only appears at exit
 * (the old execFile-buffered behaviour).
 *
 * Writes docs/evidence/command-stream-probe.json.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const { createCoreRuntime } = await import("../src/runtime.ts");
const { shellRun } = await import("../src/tools/workspace.ts");

const dir = mkdtempSync(join(tmpdir(), "kai-cmd-"));
const evidence = { at: new Date().toISOString(), events: [], verdict: "pending" };
const failures = [];
const check = (n, c, d) => { evidence.events.push({ check: n, pass: !!c, detail: d ?? null }); console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); if (!c) failures.push(n); };

let rt = null;
try {
  rt = createCoreRuntime({ dbPath: join(dir, "core.db"), agents: { mode: "mock" }, startScheduler: false, subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") } });
  await rt.start();

  const seen = [];
  const t0 = Date.now();
  const off = rt.bus.subscribe((e) => {
    if (String(e.type).startsWith("command.")) {
      seen.push({ at: Date.now() - t0, type: e.type, stream: e.payload?.stream, chunk: typeof e.payload?.chunk === "string" ? e.payload.chunk : undefined, exitCode: e.payload?.exitCode, durationMs: e.payload?.durationMs });
    }
  });

  // A real node child that prints stdout 1/2, stderr, stdout 3 with delays.
  const script = [
    "const d=(ms)=>new Promise(r=>setTimeout(r,ms));",
    "(async()=>{",
    "process.stdout.write('line-1\\n');await d(300);",
    "process.stdout.write('line-2\\n');await d(300);",
    "process.stderr.write('warn-x\\n');await d(300);",
    "process.stdout.write('line-3\\n');await d(300);",
    "process.exitCode=0;",
    "})();",
  ].join("");
  const result = await shellRun({ command: process.execPath, args: ["-e", script] });
  await delay(120);
  off();

  const stdout = seen.filter((s) => s.type === "command.stdout");
  const stderr = seen.filter((s) => s.type === "command.stderr");
  const exit = seen.find((s) => s.type === "command.exit");
  const started = seen.find((s) => s.type === "command.started");
  evidence.timeline = seen.map((s) => ({ at: s.at, type: s.type, stream: s.stream, chunk: s.chunk, exitCode: s.exitCode }));

  check("C1: command.started emitted", started !== undefined, `at ${started?.at}ms`);
  check("C2: stdout arrived in multiple chunks", stdout.length >= 3, `${stdout.length} stdout chunks`);
  check("C3: stderr distinguished from stdout", stderr.length >= 1, `${stderr.length} stderr chunks`);
  const lastStdout = stdout[stdout.length - 1];
  check("C4: output streamed BEFORE exit", exit !== undefined && lastStdout !== undefined && lastStdout.at < exit.at, `last stdout ${lastStdout?.at}ms vs exit ${exit?.at}ms`);
  check("C5: ordering preserved (line-1 before line-3)", stdout[0]?.chunk?.includes("line-1") === true && stdout.some((s) => s.chunk?.includes("line-3")), stdout.map((s) => (s.chunk ?? "").trim()).join(","));
  check("C6: exit code reported", exit?.exitCode === 0, `exit=${exit?.exitCode}`);
  check("C7: result buffered form still correct", result.exitCode === 0 && result.stdout.includes("line-1") && result.stderr.includes("warn-x"), "");
  evidence.timelineSummary = { stdoutChunks: stdout.length, stderrChunks: stderr.length, firstMs: stdout[0]?.at, lastMs: lastStdout?.at, exitMs: exit?.at };

  evidence.verdict = failures.length === 0 ? "PASS" : `FAIL: ${failures.join(", ")}`;
  if (failures.length > 0) process.exitCode = 1;
  console.log(`command-stream verdict: ${evidence.verdict}`);
  console.log(`timeline: ${JSON.stringify(evidence.timelineSummary)}`);
} catch (e) {
  evidence.verdict = `ERROR: ${e?.message ?? e}`;
  console.error(evidence.verdict);
  process.exitCode = 1;
} finally {
  try { if (rt) await rt.stop(); } catch { /* best-effort */ }
  try {
    const { writeFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    writeFileSync(join(CORE, "..", "docs", "evidence", "command-stream-probe.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log("evidence: docs/evidence/command-stream-probe.json");
  } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
}

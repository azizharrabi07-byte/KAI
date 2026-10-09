#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Worker honesty probe: Hermes reachable, OpenCode offline (live machine).
 *
 * Against an ISOLATED Core (temp DB — never the user's live state):
 *   H1. agents.run_task -> opencode parks for approval (EXTERNAL boundary).
 *   H2. approving it fails HONESTLY (AGENT_NOT_LISTENING naming 127.0.0.1:4096),
 *       state failed — never a fabricated completion.
 *   H3. agents.run_task -> hermes with a trivial bounded task returns the
 *       worker's REAL output (or a real, named error).
 *   H4. denying the approval prevents execution (no run starts).
 *
 * Writes docs/evidence/worker-honesty.json. Exits non-zero on failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { createCoreRuntime } = await import("../src/runtime.ts");

const dir = mkdtempSync(join(tmpdir(), "kai-worker-honesty-"));
const evidence = { at: new Date().toISOString(), scenarios: {} };
const failures = [];
const check = (name, cond, detail) => {
  evidence.scenarios[name] = { pass: !!cond, detail: detail ?? null };
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(name);
};

const rt = createCoreRuntime({
  dbPath: join(dir, "kai.db"),
  startScheduler: false,
  subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
});
await rt.start();

const approvalIdOf = (invoked) =>
  invoked?.invocation?.approvalId ?? invoked?.error?.detail ?? null;

try {
  // H1: EXTERNAL delegation parks for a human — never executes blindly.
  const parked = await rt.tools.invoke(
    "agents.run_task",
    { agentId: "opencode", action: "honesty probe", input: "Reply with the single word PONG." },
    { source: "worker-honesty" },
  );
  const parkedId = approvalIdOf(parked);
  check(
    "H1 opencode run_task parks for approval",
    parked.ok === false && parkedId !== null && String(parkedId).length > 0,
    JSON.stringify({ ok: parked.ok, status: parked?.invocation?.status, approvalId: parkedId }).slice(0, 200),
  );

  // H4: denying prevents execution.
  if (parkedId !== null) {
    const denied = rt.approvals.decide(parkedId, false);
    check("H4 denial is recorded", denied.ok === true, JSON.stringify(denied).slice(0, 160));
    const afterDeny = await rt.tools.invoke(
      "agents.run_task",
      { agentId: "opencode", action: "honesty probe", input: "Reply PONG." },
      { source: "worker-honesty", approvalId: parkedId },
    );
    check(
      "H4 denied approval executes nothing",
      afterDeny.ok === false,
      JSON.stringify({ ok: afterDeny.ok, status: afterDeny?.invocation?.status }).slice(0, 200),
    );
  } else {
    check("H4 denial is recorded", false, "no approval id to deny");
    check("H4 denied approval executes nothing", false, "no approval id to deny");
  }

  // H2: approved opencode run fails honestly (connection refused on :4096).
  const parked2 = await rt.tools.invoke(
    "agents.run_task",
    { agentId: "opencode", action: "honesty probe 2", input: "Reply with the single word PONG." },
    { source: "worker-honesty" },
  );
  const parked2Id = approvalIdOf(parked2);
  if (parked2Id !== null) {
    rt.approvals.decide(parked2Id, true);
    const ran = await rt.tools.invoke(
      "agents.run_task",
      { agentId: "opencode", action: "honesty probe 2", input: "Reply with the single word PONG." },
      { source: "worker-honesty", approvalId: parked2Id },
    );
    const text = JSON.stringify(ran).slice(0, 600);
    const honest =
      ran.ok === false ||
      (typeof ran?.result?.state === "string" && ran.result.state !== "completed") ||
      /NOT_LISTENING|refused|unreachable|4096/i.test(text);
    const fabricated =
      ran.ok === true && ran?.result?.state === "completed" && !/PONG/i.test(text);
    check("H2 opencode-offline fails honestly, never fabricated", honest && !fabricated, text.slice(0, 300));
  } else {
    check("H2 opencode-offline fails honestly, never fabricated", false, "no second approval id");
  }

  // H3: hermes (live) runs the bounded task and returns its real output.
  const parked3 = await rt.tools.invoke(
    "agents.run_task",
    { agentId: "hermes", action: "honesty probe", input: "Reply with the single word PONG and nothing else." },
    { source: "worker-honesty" },
  );
  const parked3Id = approvalIdOf(parked3);
  if (parked3Id !== null) {
    rt.approvals.decide(parked3Id, true);
    const ran = await rt.tools.invoke(
      "agents.run_task",
      { agentId: "hermes", action: "honesty probe", input: "Reply with the single word PONG and nothing else." },
      { source: "worker-honesty", approvalId: parked3Id, sessionId: undefined },
    );
    const text = JSON.stringify(ran?.result ?? ran).slice(0, 400);
    check("H3 hermes returns its real output", /PONG/i.test(text), text.slice(0, 200));
  } else {
    // Hermes may itself need approval config; an honest named error still passes.
    check("H3 hermes returns its real output", false, `no approval id: ${JSON.stringify(parked3).slice(0, 200)}`);
  }
} finally {
  await rt.stop();
}

evidence.verdict = failures.length === 0 ? "pass" : "fail";
writeFileSync(join(CORE, "..", "docs", "evidence", "worker-honesty.json"), JSON.stringify(evidence, null, 2));
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
if (failures.length > 0) {
  console.error(`FAILURES: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("worker honesty: all scenarios passed");

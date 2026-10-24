// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The capability boundary, audited as a MATRIX: Browser / CUA / MCP / Shell /
 * Git / Filesystem (+ KAI's own `system`) each checked against the four
 * properties the scope demands of an effectful operation:
 *
 *   1. CLASSIFIED        — the tool carries its capability's risk, and the
 *                          declared action list is exactly what the dispatch
 *                          can reach (nothing more, nothing less);
 *   2. POLICY + APPROVAL — non-READ capabilities PARK for a human before any
 *                          transport is touched, READ ones run unattended;
 *   3. RECORDED          — every attempt (parked, refused, executed) emits
 *                          exactly one `action.executed` from the one boundary;
 *   4. SURVIVES RESTART  — the parked request AND its action record are still
 *                          there, and can be approved, after a Core restart.
 *
 * Two of these were live defects, both regressed here:
 *
 *   G1 — `registerCapabilityTool` dispatched ANY action name. `capability.system`
 *        (READ) with {action:"shell.run"} reached the DESTRUCTIVE shell tool,
 *        which is what makes the registration-time invariant ("the capability's
 *        risk covers its actions") prove nothing about what is reachable.
 *   G2 — refusal paths in `tools/registry.ts` `invoke` returned WITHOUT calling
 *        `recordAction`: a validator that threw or returned garbage, and every
 *        approval-shaped refusal (unknown / mismatched / rejected / expired /
 *        still-pending approval id, or no approval service at all) left no trace
 *        at the acceptance boundary. A wrong approval id re-used ten times was
 *        one record.
 *
 * Run from `core/`:  node --test tests/capability-boundary.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import type { CoreRuntime } from "../src/runtime.ts";
import { executionIdFor } from "../src/recovery/ledger.ts";
import { BROWSER_ACTIONS } from "../src/capabilities/browser/transport.ts";
import { probeGit } from "../src/tools/workspace.ts";

/** The contract under audit: id -> (declared risk, declared actions). */
const EXPECTED: Record<string, { risk: string; actions: readonly string[] }> = {
  system: { risk: "READ", actions: ["system.get_status", "agents.list", "missions.list", "memory.list"] },
  // The WHOLE CDP surface plus `observe` (routed by the tool, absent from
  // BROWSER_ACTIONS): declared must equal routed, or the guard either refuses a
  // real action or admits one that was never risk-checked.
  browser: { risk: "EXTERNAL", actions: [...BROWSER_ACTIONS, "observe"] },
  // windows/observe/inspect are routed by name; click/type/keypress/scroll are
  // the driver-shaped actions routed through transport.act.
  computer: {
    risk: "DESTRUCTIVE",
    actions: ["click", "type", "keypress", "scroll", "observe", "inspect", "windows"],
  },
  mcp: { risk: "EXTERNAL", actions: ["call"] },
  filesystem: { risk: "WRITE", actions: ["read", "list", "write"] },
  git: { risk: "READ", actions: ["status", "log", "diff"] },
  shell: { risk: "DESTRUCTIVE", actions: ["run"] },
};

/** Capabilities whose default policy must park them for a human. */
const MUST_PARK = ["browser", "computer", "mcp", "filesystem", "shell"];
/** Capabilities whose default policy lets them run unattended. */
const MAY_RUN = ["system", "git"];

interface ActionRecord {
  toolId: string;
  resultState: string;
  capabilityId?: string;
  approvalId?: string;
  detail?: string;
}

function boot(dbPath: string): CoreRuntime {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

function capture(rt: CoreRuntime): ActionRecord[] {
  const records: ActionRecord[] = [];
  rt.bus.subscribe((event) => {
    if (event.type === "action.executed") records.push(event.payload as ActionRecord);
  });
  return records;
}

function recordsFor(records: ActionRecord[], toolId: string): ActionRecord[] {
  return records.filter((record) => record.toolId === toolId);
}

// ── 1. classified ─────────────────────────────────────────────────────────────

test("classified: every capability tool carries its capability's risk and declares exactly what it can reach", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cap-matrix-"));
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const capabilities = rt.capabilities.list();
  assert.deepEqual(
    capabilities.map((capability) => capability.id).sort(),
    Object.keys(EXPECTED).sort(),
    "the matrix covers every registered capability — add the new one here",
  );

  for (const [id, expected] of Object.entries(EXPECTED)) {
    const capability = capabilities.find((entry) => entry.id === id);
    assert.ok(capability, `${id} is registered`);
    assert.equal(capability.risk, expected.risk, `${id} is classified ${expected.risk}`);
    assert.deepEqual(
      [...capability.supportedActions],
      [...expected.actions],
      `${id} declares exactly the actions its dispatch can reach`,
    );

    // The tool a caller actually reaches inherits that same risk, so the policy
    // engine is asked about the capability's worst case, never a softer one.
    const tool = rt.tools.get(`capability.${id}`);
    assert.ok(tool, `capability.${id} is registered as a tool`);
    assert.equal(tool.risk, expected.risk, `capability.${id} carries ${expected.risk}`);
  }

  // The browser's declared set must not silently drift from the transport's.
  assert.equal(EXPECTED.browser.actions.length, BROWSER_ACTIONS.length + 1, "all 15 transport actions + observe");
  assert.ok(EXPECTED.browser.actions.includes("navigate"), "the EXTERNAL action is declared");
  assert.ok(EXPECTED.browser.actions.includes("switch_tab"), "a READ action is declared");
});

// ── 1b. G1 regression: a name that was never declared never dispatches ────────

test("G1: an undeclared action is refused by NAME and never reaches a handler or an approval", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cap-g1-"));
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const records = capture(rt);

  // The live defect: capability.system is READ, and "shell.run" is a real tool
  // id, so the old dispatch handed it straight to the shell — a DESTRUCTIVE
  // action reached through a READ-classified capability, which parked an
  // approval for "shell.run" on the way.
  const shell = await rt.tools.invoke("capability.system", { action: "shell.run" });
  assert.equal(shell.ok, false, JSON.stringify(shell));
  if (!shell.ok) {
    assert.match(shell.error.message, /shell\.run/, `the refusal names the action sent: ${shell.error.message}`);
    assert.match(shell.error.message, /it accepts: system\.get_status/, `and lists what IS accepted: ${shell.error.message}`);
  }
  assert.equal(
    rt.approvals.list().some((approval) => approval.toolId === "shell.run"),
    false,
    "an undeclared action must never even reach the inner policy gate",
  );

  // Same defect for an EXTERNAL builtin: the validator used to run.
  const runTask = await rt.tools.invoke("capability.system", { action: "agents.run_task" });
  assert.equal(runTask.ok, false);
  if (!runTask.ok) assert.match(runTask.error.message, /agents\.run_task/);

  // A nonsense name on a non-READ capability PARKS first: the capability's
  // declared risk governs, so the attempt reaches policy and approval before any
  // name check — the same park-first boundary `capability-action-name.test.ts`
  // pins (a WRITE payload with a wrong op name parks, then refuses by name only
  // once approved). What G1 proves HERE is that the park is the last thing that
  // happens: no transport is probed and no handler runs, so the caller is never
  // handed a transport/unavailability claim for a name the capability could
  // never dispatch. The refusal-by-name for such a call is exercised in the
  // companion test, on the approved re-issue.
  const nonsense = await rt.tools.invoke("capability.computer", { action: "take_over_the_world" });
  assert.equal(nonsense.ok, false);
  if (!nonsense.ok) {
    assert.equal(nonsense.error.code, "APPROVAL_REQUIRED", `a non-READ capability parks: ${nonsense.error.message}`);
    assert.doesNotMatch(nonsense.error.message, /cua-driver|UNAVAILABLE/);
  }

  // The attempt IS recorded — as a FAILED execution of the capability tool, the
  // state the registry assigns when `execute` refuses — and no inner tool was
  // ever invoked.
  const attempted = recordsFor(records, "capability.system");
  assert.equal(attempted.length, 2, `both refusals are recorded once each: ${JSON.stringify(attempted)}`);
  assert.ok(
    attempted.every((record) => record.resultState === "FAILED"),
    `a refusal inside execute is FAILED, never EXECUTED: ${JSON.stringify(attempted)}`,
  );
  assert.equal(recordsFor(records, "shell.run").length, 0, "the shell tool never entered the boundary");
});

// ── 2. policy + approval ──────────────────────────────────────────────────────

test("policy+approval: every non-READ capability parks before any transport; READ capabilities run", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cap-policy-"));
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const records = capture(rt);

  for (const id of MUST_PARK) {
    const first = EXPECTED[id].actions[0];
    const parked = await rt.tools.invoke(`capability.${id}`, { action: first });
    assert.equal(parked.ok, false, `${id} must not run unattended: ${JSON.stringify(parked)}`);
    if (parked.ok) continue;
    assert.equal(parked.error.code, "APPROVAL_REQUIRED", `${id} parks: ${parked.error.message}`);

    const approvalId = parked.error.detail;
    assert.ok(typeof approvalId === "string" && approvalId.length > 0, `${id} hands back an approval id`);
    const approval = rt.approvals.get(approvalId);
    assert.ok(approval, `${id} left a durable approval`);
    assert.equal(approval.toolId, `capability.${id}`, "the approval is bound to this tool and no other");
    assert.equal(approval.risk, EXPECTED[id].risk, "the approval records the risk that parked it");
    assert.equal(rt.parkedRequests.get(approvalId)?.toolId, `capability.${id}`, "the parked request is recorded for re-issue");

    const record = recordsFor(records, `capability.${id}`).at(-1);
    assert.equal(record?.resultState, "APPROVAL_REQUIRED", `${id} parks are recorded`);
    assert.equal(record?.approvalId, approvalId, "the record names the approval it is waiting on");
    assert.equal(record?.capabilityId, id, "the record names the capability");
  }

  // READ-classified capabilities need no human — but they still must not be
  // refused by the guard, which proves the guard refuses UNDECLARED names only.
  const system = await rt.tools.invoke("capability.system", {});
  assert.equal(system.ok, true, JSON.stringify(system));
  assert.equal(recordsFor(records, "capability.system").at(-1)?.resultState, "EXECUTED");

  const gitProbed = await probeGit();
  if (gitProbed.available) {
    const git = await rt.tools.invoke("capability.git", { input: { cwd: dir } });
    assert.equal(git.ok, true, JSON.stringify(git));
    assert.equal(recordsFor(records, "capability.git").at(-1)?.resultState, "EXECUTED");
  }
});

// ── 3. recorded: nothing the boundary sees may go unrecorded ──────────────────

test("G2: a refusal with an unknown, pending or rejected approval id is recorded, one record per attempt", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cap-g2-"));
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const records = capture(rt);
  const input = { action: "write", input: { path: join(dir, "never.txt"), content: "x" } };

  // An approval id that does not exist: the caller is told to get one, and the
  // attempt is on the record. Re-using it is a second attempt, so a second record.
  const unknown1 = await rt.tools.invoke("capability.filesystem", input, { approvalId: "apr_not_a_real_id" });
  const unknown2 = await rt.tools.invoke("capability.filesystem", input, { approvalId: "apr_not_a_real_id" });
  assert.equal(unknown1.ok, false);
  assert.equal(unknown2.ok, false);

  // A real approval, still PENDING: spending it is an attempt too.
  const pending = await rt.tools.invoke("capability.filesystem", input);
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.equal(pending.error.code, "APPROVAL_REQUIRED");
  const approvalId = pending.ok ? "" : String(pending.error.detail);
  const stillPending = await rt.tools.invoke("capability.filesystem", input, { approvalId });

  // A REJECTED approval must never authorise anything, and the refusal is a DENIED.
  const rejected = await rt.decideApproval(approvalId, false);
  assert.equal(rejected.reissued, false, "a rejection runs nothing");
  const afterReject = await rt.tools.invoke("capability.filesystem", input, { approvalId });

  const attempts = recordsFor(records, "capability.filesystem");
  assert.equal(attempts.length, 5, `every attempt is recorded exactly once: ${JSON.stringify(attempts)}`);
  assert.deepEqual(
    attempts.map((record) => record.resultState),
    ["APPROVAL_REQUIRED", "APPROVAL_REQUIRED", "APPROVAL_REQUIRED", "APPROVAL_REQUIRED", "DENIED"],
    "approval-shaped refusals are APPROVAL_REQUIRED; an authority-shaped one is DENIED",
  );
  assert.deepEqual(
    attempts.map((record) => record.approvalId),
    ["apr_not_a_real_id", "apr_not_a_real_id", approvalId, approvalId, approvalId],
    "each record carries the approval id the caller tried to spend",
  );
  assert.equal(stillPending.ok, false);
  assert.equal(afterReject.ok, false);
  assert.equal(
    recordsFor(records, "capability.filesystem").filter((record) => record.resultState === "EXECUTED").length,
    0,
    "nothing ran: the write must not have been recorded as executed",
  );
});

test("G2: a validator that throws or returns garbage is recorded as INVALID, not silently dropped", async () => {
  // Registered straight on a boundary with a recording bus, because these are
  // registry-level refusals: the same `invoke` every capability tool goes through.
  const { createToolRegistry } = await import("../src/tools/registry.ts");
  const { createPolicyEngine } = await import("../src/policies/gate.ts");
  const records: ActionRecord[] = [];
  const registry = createToolRegistry({
    policy: createPolicyEngine({ rules: [] }),
    publish: (type, payload) => {
      if (type === "action.executed") records.push(payload as ActionRecord);
    },
  });

  registry.register({
    id: "demo.throws",
    name: "validator throws",
    description: "a validator that throws",
    risk: "READ",
    validate: () => {
      throw new Error("validator blew up");
    },
    execute: async () => null,
  });
  registry.register({
    id: "demo.malformed",
    name: "validator malformed",
    description: "a validator that returns nothing usable",
    risk: "READ",
    validate: () => null as never,
    execute: async () => null,
  });

  const thrown = await registry.invoke("demo.throws", {});
  const malformed = await registry.invoke("demo.malformed", {});
  assert.equal(thrown.ok, false);
  assert.equal(malformed.ok, false);

  assert.equal(records.length, 2, `both refusals are on the record: ${JSON.stringify(records)}`);
  assert.deepEqual(
    records.map((record) => [record.toolId, record.resultState]),
    [
      ["demo.throws", "INVALID"],
      ["demo.malformed", "INVALID"],
    ],
    "a refusal before policy is INVALID, and it is recorded",
  );
  assert.match(records[0]?.detail ?? "", /blew up/, "the record carries the reason");
});

// ── 4. survives a restart ─────────────────────────────────────────────────────

test("restart: a parked DESTRUCTIVE capability action, its record, and the approval all survive", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cap-restart-"));
  const dbPath = join(dir, "kai.db");
  const marker = join(dir, "ran.txt");
  let rt2: CoreRuntime | undefined;
  t.after(async () => {
    if (rt2 !== undefined) await rt2.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const rt1 = boot(dbPath);
  const records = capture(rt1);
  const parked = await rt1.tools.invoke("capability.shell", {
    action: "run",
    input: { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok")`] },
  });
  assert.equal(parked.ok, false, JSON.stringify(parked));
  if (parked.ok) return;
  assert.equal(parked.error.code, "APPROVAL_REQUIRED");
  const approvalId = String(parked.error.detail);
  const parkedRecord = recordsFor(records, "capability.shell").at(-1);
  assert.equal(parkedRecord?.resultState, "APPROVAL_REQUIRED");
  await rt1.stop();

  // A NEW Core over the same files: the record is read back from the persisted
  // event store, not from the bus of the process that wrote it.
  rt2 = boot(dbPath);
  await rt2.start();
  assert.ok(rt2.parkedRequests.get(approvalId) !== null, "the parked request survives");
  assert.ok(rt2.approvals.get(approvalId), "the approval survives");
  const persisted = rt2.stores.events.listEvents({ types: ["action.executed"], limit: 200 });
  const afterRestart = persisted
    .map((event) => event.payload as ActionRecord)
    .filter((record) => record.toolId === "capability.shell" && record.approvalId === approvalId);
  assert.equal(afterRestart.length, 1, `the parked attempt is on disk after the restart: ${JSON.stringify(afterRestart)}`);
  assert.equal(afterRestart[0]?.resultState, "APPROVAL_REQUIRED");

  // …and the human's yes still runs it, after the restart.
  const decided = await rt2.decideApproval(approvalId, true);
  assert.equal(decided.reissued, true, JSON.stringify(decided));
  const { existsSync, readFileSync } = await import("node:fs");
  assert.equal(existsSync(marker), true, "the approved shell action ran after the restart");
  assert.equal(readFileSync(marker, "utf8"), "ok");
});

// ── 5. classification reaches the mission boundary too ────────────────────────

test("mission derivation: a capability tool step is side-effecting exactly when its risk says so", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cap-derive-"));
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  for (const [id, expected] of Object.entries(EXPECTED)) {
    const mission = await rt.createAndStartMission({
    metadata: { criteria: ["file present: package.json"] },
      title: `classification ${id}`,
      steps: [{ title: "step", kind: "tool", target: `capability.${id}`, input: {} }],
    });
    const step = mission.steps[0]!;
    const sideEffecting = expected.risk !== "READ";
    assert.equal(
      step.sideEffecting,
      sideEffecting,
      `capability.${id} (${expected.risk}) is ${sideEffecting ? "side-effecting" : "not side-effecting"}`,
    );
    if (sideEffecting) {
      // Only side-effecting steps cross the acceptance boundary, so this is the
      // record that must exist for the risky capabilities. Every non-READ
      // capability PARKS for a human, and a parked step has not crossed the
      // point of no return, so its durable phase is BEFORE_ACCEPT — the
      // replay-safe one. The phase is the proof the classification reached the
      // ledger: a READ capability wrote no record at all.
      const record = rt.recovery.get(executionIdFor(mission.id, step.id));
      assert.ok(record !== null, `capability.${id} is recorded by the acceptance boundary`);
      assert.equal(record.phase, "BEFORE_ACCEPT");
    }
  }
});

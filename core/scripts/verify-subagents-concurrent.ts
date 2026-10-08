/**
 * verify-subagents-concurrent.ts — PROOF that two KAI subagents run CONCURRENTLY.
 *
 * This is not a UI animation: it boots the REAL Core runtime (mock agent
 * adapters, but the real workforce, policy engine, tool registry and approval
 * service), defines TWO subagents with different name/purpose/personality/colour,
 * fires BOTH runs at the same time, and independently verifies each result.
 *
 * It also proves the safety boundary: each run PARKS for approval (a subagent is
 * not a way around the policy), and each is approved and settled separately.
 *
 * Run: cd core && node scripts/verify-subagents-concurrent.ts
 * Writes: ../docs/evidence/subagents/concurrent.json
 */
import { createCoreRuntime } from "../src/runtime.ts";
import { createMockHermes, createMockOpenCode } from "../src/agents/mock.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(here, "..", "..", "docs", "evidence", "subagents");
mkdirSync(evidenceDir, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "kai-subagents-"));
const rt = createCoreRuntime({
  dbPath: join(dir, "kai.db"),
  agents: { mode: "mock" },
  startScheduler: false,
  subsystemPaths: { runUpkeepOnStart: false },
});

// Record each adapter's run window, so overlap is measured, not asserted.
const windows: Record<string, { start: number; end: number }> = {};
function instrument(id: string, adapter: ReturnType<typeof createMockHermes>) {
  const base = adapter.runTask.bind(adapter);
  return {
    ...adapter,
    runTask: async (task: Parameters<typeof base>[0]) => {
      const start = Date.now();
      try {
        return await base(task);
      } finally {
        windows[id] = { start, end: Date.now() };
      }
    },
  };
}

// Slow the two workers down so a genuine overlap is observable (mock workMs).
rt.registry.register(instrument("hermes", createMockHermes({ workMs: 800 })));
rt.registry.register(instrument("opencode", createMockOpenCode({ workMs: 800 })));

await rt.start();

const SUBAGENTS = [
  {
    id: "research-kai", name: "Research KAI", role: "deep researcher",
    soul: "Patient, sceptical, cites everything.",
    workerId: "hermes", capabilities: ["run_task"],
    visual: { variant: "kai-research", colour: "#8B5CF6", outfit: "halo" },
  },
  {
    id: "coding-kai", name: "Coding KAI", role: "implementation engineer",
    soul: "Blunt, ships small diffs, tests first.",
    workerId: "opencode", capabilities: ["run_task"],
    visual: { variant: "kai-coder", colour: "#FBBF24", outfit: "cap" },
  },
];

for (const spec of SUBAGENTS) {
  const defined = await rt.tools.invoke("workforce.subagent", spec);
  if (!defined.ok) throw new Error(`define ${spec.id} failed: ${JSON.stringify(defined)}`);
}

const log: string[] = [];
const say = (s: string) => { log.push(s); console.log(s); };

say(`defined subagents: ${rt.subagents.list().map((s) => `${s.spec.name}(${s.employeeId})`).join(", ")}`);

// ── Fire BOTH runs at the same time ───────────────────────────────────────────
const t0 = Date.now();
const [runA, runB] = await Promise.all([
  rt.runSubagent("research-kai", "Summarise the concurrent-execution spec."),
  rt.runSubagent("coding-kai", "Write a failing test for the two-run invariant."),
]);
const firedMs = Date.now() - t0;

function pendingId(run: unknown): string | undefined {
  const r = run as { result?: { error?: { code?: string; detail?: string } }; error?: { code?: string; detail?: string } };
  const err = r?.result?.error ?? r?.error;
  return err?.code === "APPROVAL_REQUIRED" ? err.detail : undefined;
}
const aprA = pendingId(runA);
const aprB = pendingId(runB);
say(`both runs fired in ${firedMs}ms; both parked for approval: A=${aprA} B=${aprB}`);

// Two DISTINCT pending approvals, held at the same instant.
const pending = rt.approvals.list({ status: "PENDING" });
say(`pending approvals at the same instant: ${pending.map((a) => a.id).join(", ")}`);

// ── Approve BOTH concurrently, then verify each result independently ──────────
const [decA, decB] = await Promise.all([
  aprA ? rt.decideApproval(aprA, true) : Promise.resolve(null),
  aprB ? rt.decideApproval(aprB, true) : Promise.resolve(null),
]);

function outcome(dec: unknown): { state: string; output: string } {
  const d = dec as { result?: { result?: { state?: string; output?: string }; state?: string; output?: string } };
  const inner = d?.result?.result ?? d?.result;
  return { state: inner?.state ?? "?", output: inner?.output ?? "" };
}
const outA = outcome(decA);
const outB = outcome(decB);

say(`A result: state=${outA.state} output=${JSON.stringify(outA.output)}`);
say(`B result: state=${outB.state} output=${JSON.stringify(outB.output)}`);

// ── Independent verification ──────────────────────────────────────────────────
const checks: Record<string, boolean> = {
  "two distinct approvals held concurrently": Boolean(aprA && aprB && aprA !== aprB),
  "run A completed": outA.state === "completed",
  "run B completed": outB.state === "completed",
  "results are INDEPENDENT (different worker outputs)": outA.output !== outB.output && outA.output.length > 0 && outB.output.length > 0,
  "run A carries Research KAI's persona": outA.output.includes("Research KAI"),
  "run B carries Coding KAI's persona": outB.output.includes("Coding KAI"),
  "run A ran on hermes": outA.output.startsWith("hermes mock output:"),
  "run B ran on opencode": outB.output.startsWith("opencode mock output:"),
  "worker windows OVERLAP in wall-clock": Boolean(windows.hermes && windows.opencode && windows.hermes.start < windows.opencode.end && windows.opencode.start < windows.hermes.end),
};

say("── checks ──");
for (const [k, v] of Object.entries(checks)) say(`  ${v ? "PASS" : "FAIL"}  ${k}`);

const allPass = Object.values(checks).every(Boolean);

const evidence = {
  at: new Date().toISOString(),
  subagents: SUBAGENTS,
  employeeIds: rt.subagents.list().map((s) => s.employeeId),
  approvals: { A: aprA, B: aprB, pendingAtSameInstant: pending.map((a) => a.id) },
  results: { A: outA, B: outB },
  runWindowsMs: windows,
  overlapMs:
    windows.hermes && windows.opencode
      ? Math.min(windows.hermes.end, windows.opencode.end) - Math.max(windows.hermes.start, windows.opencode.start)
      : 0,
  checks,
  allPass,
};
writeFileSync(join(evidenceDir, "concurrent.json"), JSON.stringify(evidence, null, 2));
say(`evidence -> ${join(evidenceDir, "concurrent.json")}`);

await rt.stop();
if (!allPass) process.exit(1);

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Louis Raillé — MIT (see repository LICENSE).

/**
 * DEMO FIXTURES — every value here is INVENTED.
 *
 * This prototype exists so the interface can be reviewed before it replaces the
 * production one. Nothing in it talks to a Core, reads a real database or calls a
 * real endpoint, and nothing here may be presented as telemetry.
 *
 * `DEMO` is stamped on every fixture and rendered in the UI chrome, so a
 * screenshot can never be mistaken for a live system. The shapes mirror KAI's
 * real contracts (goal + revision + approval, work items with criteria and
 * evidence, adapter status, typed events) because a prototype built on invented
 * shapes would not answer the question it is asked to answer.
 */

/** Marks every fixture. The UI renders this; the README repeats it. */
export const DEMO_BANNER = "DEMO DATA — not connected to a Core";

export const DEMO_GOALS = [
  {
    id: "g-1041",
    statement: "Ship the worker dashboard and prove the polling fix with a test",
    state: "RUNNING",
    createdAt: "2026-10-13T09:12:04Z",
    /** The revision that is actually approved, and the one dispatch is bound to. */
    approvedRevision: "rev_2",
    revisions: [
      { id: "rev_1", version: 1, note: "initial plan", approved: false, invalidated: "writes outside the workspace" },
      { id: "rev_2", version: 2, note: "tasks restricted to the workspace", approved: true },
    ],
    acceptanceCriteria: [
      "file content equals: out.txt = hex:4f4b",
      "npm test",
    ],
    constraints: ["stay inside the authorized workspace", "no network"],
    forbiddenOutcomes: ["writing outside the workspace", "claiming success without evidence"],
    budgets: { maxTasks: 4, maxRetries: 1, maxDepth: 2 },
    challenge: {
      mode: "DEEP",
      verdict: "REVISE",
      rounds: 1,
      lenses: [
        { role: "feasibility", verdict: "PASS", ms: 4100 },
        { role: "failure-analysis", verdict: "PASS", ms: 3800 },
        { role: "user-value", verdict: "PASS", ms: 4400 },
        { role: "security", verdict: "BLOCKED", ms: 5000, objection: "the plan writes outside the authorized workspace" },
        { role: "verification", verdict: "PASS", ms: 3900 },
        { role: "cost-alternatives", verdict: "PASS", ms: 4200 },
      ],
      note: "One blocking objection outvoted the other five. A majority does not carry an objection.",
    },
  },
  {
    id: "g-1039",
    statement: "Audit usage accounting and say plainly what cannot be enforced",
    state: "BLOCKED",
    createdAt: "2026-10-13T08:02:11Z",
    approvedRevision: "rev_1",
    revisions: [{ id: "rev_1", version: 1, note: "audit only", approved: true }],
    acceptanceCriteria: ["file present: report.md"],
    constraints: [],
    forbiddenOutcomes: [],
    budgets: { maxTasks: 2, maxRetries: 1, maxDepth: 2 },
    challenge: { mode: "QUICK", verdict: "CONDITIONAL", rounds: 1, lenses: [], note: "kept, with a condition" },
  },
];

export const DEMO_TASKS = [
  {
    id: "t1",
    goalId: "g-1041",
    revisionId: "rev_2",
    title: "produce out.txt",
    state: "COMPLETED",
    attempts: 1,
    dependsOn: [],
    workerId: "hermes",
    criteria: ["file content equals: out.txt = hex:4f4b"],
    evidence: [
      {
        criterion: "file content equals: out.txt = hex:4f4b",
        source: "KAI-OBSERVED",
        method: "filesystem.read → sha256 + hex bytes",
        observed: "sha 9f2c…41ab · value 4f4b",
        at: "2026-10-13T09:41:18Z",
      },
    ],
  },
  {
    id: "t2",
    goalId: "g-1041",
    revisionId: "rev_2",
    title: "write the polling test",
    state: "QUEUED",
    attempts: 1,
    dependsOn: ["t1"],
    workerId: "hermes",
    criteria: ["npm test"],
    evidence: [],
  },
  {
    id: "t3",
    goalId: "g-1041",
    revisionId: "rev_2",
    title: "verify the diff independently",
    state: "CHANGES_REQUESTED",
    attempts: 2,
    dependsOn: ["t2"],
    workerId: "opencode",
    criteria: ["npm test"],
    evidence: [
      {
        criterion: "npm test",
        source: "WORKER-REPORTED",
        method: "the worker's own summary",
        observed: "claimed 12 passing",
        at: "2026-10-13T09:44:02Z",
        limitation: "a worker claim is not proof — KAI has not run the suite itself",
      },
    ],
  },
  {
    id: "t4",
    goalId: "g-1041",
    revisionId: "rev_2",
    title: "archive the run",
    state: "BLOCKED",
    attempts: 0,
    dependsOn: ["t3"],
    workerId: "codex",
    criteria: ["file present: archive.zip"],
    evidence: [],
    blockReason: "budget exhausted: dispatch would reach 5 of 4 — the allowance is spent and is never silently restored",
    nextCommand: "/goal status g-1041",
  },
];

export const DEMO_WORKERS = [
  {
    id: "hermes",
    label: "Hermes",
    runtime: "hermes-agent",
    configured: true,
    installed: true,
    reachable: true,
    authorized: true,
    state: "BUSY",
    endpoint: ":8642",
    session: "sess_9f2c41ab",
    capabilities: ["run_task", "cancel_task", "tokens", "sessions"],
    reports: { tokens: true, toolCalls: false, cost: false },
    assignment: "t2 · write the polling test",
    activeTasks: 1,
    latest: { kind: "progress", text: "implementing exponential backoff (task #17)", at: "2026-10-13T09:43:51Z" },
    limitation: "reports token usage only; tool calls and cost are not reported",
  },
  {
    id: "opencode",
    label: "OpenCode",
    runtime: "opencode",
    configured: true,
    installed: true,
    reachable: false,
    authorized: true,
    state: "UNREACHABLE",
    endpoint: ":4096",
    session: null,
    capabilities: ["run_task", "cancel_task", "events", "sessions"],
    reports: { tokens: false, toolCalls: false, cost: false },
    assignment: null,
    activeTasks: 0,
    latest: { kind: "error", text: "connection refused — nothing is listening on :4096", at: "2026-10-13T09:44:03Z" },
    limitation: "installed and registered, but not reachable. Installed is not registered, and registered is not reachable.",
  },
  {
    id: "codex",
    label: "Codex",
    runtime: "codex-cli",
    configured: false,
    installed: false,
    reachable: false,
    authorized: false,
    state: "NOT_INSTALLED",
    endpoint: null,
    session: null,
    capabilities: [],
    reports: { tokens: false, toolCalls: false, cost: false },
    assignment: null,
    activeTasks: 0,
    latest: null,
    limitation: "no CLI found on PATH — KAI will not dispatch to it",
  },
];

/** Typed events. `source` is the evidence strength, and it is shown in the UI. */
export const DEMO_EVENTS = [
  { at: "09:12:04.1", kind: "GOAL", text: "goal created", source: "KAI-OBSERVED", ref: "g-1041" },
  { at: "09:12:06.4", kind: "PLAN", text: "revision rev_1 proposed", source: "KAI-OBSERVED", ref: "rev_1" },
  { at: "09:13:22.8", kind: "GOAL", text: "challenged · 6 lenses · 6 distinct prompts", source: "KAI-OBSERVED", ref: "rev_1" },
  { at: "09:13:23.0", kind: "BLOCKER", text: "security objection: writes outside the authorized workspace", source: "KAI-OBSERVED", ref: "rev_1" },
  { at: "09:13:24.2", kind: "PLAN", text: "verdict REVISE — a blocking objection outvoted five passes", source: "KAI-OBSERVED", ref: "rev_1" },
  { at: "09:18:40.0", kind: "APPROVAL", text: "user approved rev_2", source: "KAI-OBSERVED", ref: "rev_2" },
  { at: "09:19:02.6", kind: "DISPATCH", text: "t1 → hermes · dispatch 1/4 reserved before the claim", source: "KAI-OBSERVED", ref: "t1" },
  { at: "09:41:17.9", kind: "WORKER", text: "hermes reported token usage: 1 500 in, 400 out", source: "WORKER-REPORTED", ref: "t1" },
  { at: "09:41:18.4", kind: "VERIFICATION", text: "criterion met · out.txt = hex:4f4b", source: "KAI-OBSERVED", ref: "t1" },
  { at: "09:41:18.6", kind: "SETTLEMENT", text: "t1 COMPLETED — the gate passed on evidence KAI collected", source: "KAI-OBSERVED", ref: "t1" },
  { at: "09:42:10.3", kind: "DISPATCH", text: "t2 → hermes · dispatch 2/4", source: "KAI-OBSERVED", ref: "t2" },
  { at: "09:43:51.2", kind: "WORKER", text: "hermes: implementing exponential backoff (task #17)", source: "WORKER-REPORTED", ref: "t2" },
  { at: "09:44:02.9", kind: "RETRY", text: "t3 → CHANGES_REQUESTED · attempt 2 of 3", source: "KAI-OBSERVED", ref: "t3" },
  { at: "09:44:03.1", kind: "BLOCKER", text: "opencode unreachable on :4096 — not dispatched", source: "KAI-OBSERVED", ref: "t3" },
  { at: "09:45:00.0", kind: "TOOL", text: "tool call charged · dispatch allowance 2/4 · tool allowance 6/20", source: "KAI-OBSERVED", ref: "t2" },
];

export const DEMO_EVIDENCE = {
  "g-1041": [
    {
      criterion: "file content equals: out.txt = hex:4f4b",
      status: "SATISFIED",
      source: "KAI-OBSERVED",
      method: "filesystem.read → sha256 9f2c…41ab, hex 4f4b",
      task: "t1",
      at: "2026-10-13T09:41:18Z",
      limitation: null,
    },
    {
      criterion: "npm test",
      status: "UNVERIFIED",
      source: "WORKER-REPORTED",
      method: "the worker's own summary claimed 12 passing",
      task: "t3",
      at: "2026-10-13T09:44:02Z",
      limitation: "KAI has not run the suite; a claim is not proof",
    },
  ],
};

export const DEMO_SKILLS = [
  { id: "verification-loop", version: 3, source: "library", eligible: true, scan: "CLEAN", note: "verify, then act" },
  { id: "gateguard", version: 1, source: "mined:ecc", eligible: true, scan: "WARNING", note: "reference-only warning: names the patterns it detects" },
  { id: "polling-backoff", version: 1, source: "candidate", eligible: false, scan: "CLEAN", note: "awaiting evaluation — 0 of 3 benchmark tasks run" },
];

export const DEMO_MEMORY = [
  { id: "m-1", scope: "session", text: "The user prefers evidence before adjectives.", at: "2026-10-13T09:20:00Z" },
  { id: "m-2", scope: "project", text: "out.txt is the artifact this workspace's goal produces.", at: "2026-10-13T09:41:20Z" },
];

export const DEMO_APPROVALS = [
  { id: "apr_1", action: "skill.install", status: "PENDING", bound: "sha256 6f41…c8", at: "2026-10-13T09:46:00Z" },
  { id: "apr_0", action: "doer.set", status: "APPROVED", bound: "tool doer.set", at: "2026-10-13T09:44:30Z", note: "spent — a replay is a no-op" },
];

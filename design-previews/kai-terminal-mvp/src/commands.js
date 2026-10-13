// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Louis Raillé — MIT (see repository LICENSE).

/**
 * The command layer: parsing, the command table, and execution against DEMO state.
 *
 * This module has no DOM. It is the part a prototype is judged on — a cosmetic
 * input that prints canned answers would not tell us whether the interaction
 * model works — so it is a real parser over a real table, and every handler
 * mutates prototype state that the UI then re-renders.
 *
 * Output is STRUCTURED BLOCKS rather than one blob of text, so the UI can render a
 * compact result card for a significant outcome and a plain line for a small one.
 */

import { goalById, pushEvent, taskById, taskCounts, tasksForGoal, workerById, isDispatchable } from "./state.js";
import { DEMO_BANNER } from "./fixtures.js";

/** ── parsing ──────────────────────────────────────────────────────────────── */

/**
 * Split a command line into a name and positional arguments.
 *
 * Quoting is honoured (`/memory search "a phrase"`), because a search for more
 * than one word is the normal case and silently truncating it would be a lie
 * about what was searched.
 */
export function parseCommand(line) {
  const raw = String(line ?? "").trim();
  if (raw.length === 0) return { ok: false, error: "empty command" };
  if (!raw.startsWith("/")) {
    return { ok: false, error: `commands start with "/" — did you mean "/${raw.split(/\s+/)[0]}"?` };
  }

  const tokens = [];
  let current = "";
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(ch) && !quoted) {
      if (current.length > 0) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quoted) return { ok: false, error: "unbalanced quote" };
  if (current.length > 0) tokens.push(current);

  const name = (tokens.shift() ?? "").toLowerCase();
  if (name.length === 0) return { ok: false, error: "empty command" };
  return { ok: true, name, args: tokens, raw };
}

/** ── output helpers ───────────────────────────────────────────────────────── */

const text = (s) => ({ type: "text", text: s });
const kv = (title, rows) => ({ type: "kv", title, rows });
const table = (title, columns, rows) => ({ type: "table", title, columns, rows });
const note = (title, body, tone = "info") => ({ type: "note", title, text: body, tone });
const bad = (message, hint) => ({ type: "error", message, ...(hint !== undefined ? { hint } : {}) });

const out = (...blocks) => ({ ok: true, blocks });
const fail = (message, hint) => ({ ok: false, blocks: [bad(message, hint)] });

/** The header every command that reads state prints, so the demo is unmissable. */
const DEMO_HEAD = note("DEMO", DEMO_BANNER, "warn");

/** ── the command table ────────────────────────────────────────────────────── */

/**
 * `family` groups the commands in `/help`. `usage` is what the suggestion list
 * shows. `run(ctx)` returns `{ ok, blocks }` and may mutate `ctx.state`.
 */
export const COMMANDS = [];
function define(family, name, summary, usage, aliases, run) {
  COMMANDS.push({ family, name, summary, usage, aliases: aliases ?? [], run });
}

const need = (ctx, value, what) =>
  value !== undefined && value.length > 0
    ? null
    : fail(`${what} is required`, `usage: ${ctx.usage}`);

/* ── Goals and plans ─────────────────────────────────────────────────────── */

define("Goals", "/help", "List the commands that actually work here", "/help [family]", ["/?"], (ctx) => {
  const filter = ctx.args[0]?.toLowerCase();
  const families = [...new Set(COMMANDS.map((c) => c.family))].filter((f) => filter === undefined || f.toLowerCase().includes(filter));
  const blocks = [
    DEMO_HEAD,
    text("Every command below is implemented against prototype state. Anything not listed is answered with an explicit \"not implemented\"."),
  ];
  for (const family of families) {
    blocks.push(table(family, ["command", "what it does"], COMMANDS.filter((c) => c.family === family).map((c) => [c.usage, c.summary])));
  }
  return out(...blocks);
});

define("Goals", "/goal", "Goals: new, list, inspect, challenge, plan, approve, reject, status", "/goal <new|list|inspect|challenge|plan|approve|reject|status> [id]", [], (ctx) => {
  const sub = (ctx.args[0] ?? "").toLowerCase();
  const id = ctx.args[1];
  const state = ctx.state;

  if (sub === "list") {
    return out(
      DEMO_HEAD,
      table("Goals", ["id", "state", "approved", "statement"], state.goals.map((g) => [g.id, g.state, g.approvedRevision, g.statement])),
    );
  }
  if (sub === "new") {
    const statement = ctx.args.slice(1).join(" ") || "a new demo goal";
    const goal = {
      id: `g-${1042 + state.goals.length}`,
      statement,
      state: "AWAITING_PLAN_APPROVAL",
      createdAt: new Date().toISOString(),
      approvedRevision: null,
      revisions: [{ id: "rev_1", version: 1, note: "initial plan", approved: false }],
      acceptanceCriteria: ["(proposed by the planner — not yet reviewed)"],
      constraints: [],
      forbiddenOutcomes: [],
      budgets: { maxTasks: 4, maxRetries: 1, maxDepth: 2 },
      challenge: null,
    };
    state.goals.push(goal);
    state.selectedGoalId = goal.id;
    pushEvent(state, "GOAL", `goal created: ${goal.id}`, "KAI-OBSERVED", goal.id);
    return out(DEMO_HEAD, note("Goal created", `${goal.id} — "${statement}"`, "ok"), text("Next: /goal challenge " + goal.id));
  }

  if (sub === "inspect" || sub === "status") {
    const goal = id === undefined ? goalById(state, state.selectedGoalId) : goalById(state, id);
    if (goal === null) return fail(`no goal "${id ?? state.selectedGoalId}"`, "/goal list");
    const tasks = tasksForGoal(state, goal.id);
    const counts = taskCounts({ ...state, tasks });
    const blocks = [
      DEMO_HEAD,
      kv(`${goal.id} · ${goal.state}`, [
        ["statement", goal.statement],
        ["approved revision", goal.approvedRevision ?? "(none — nothing may dispatch)"],
        ["revisions", goal.revisions.map((r) => `${r.id}${r.approved ? " ✓" : ""}`).join(", ")],
        ["tasks", `${counts.total} · ${counts.COMPLETED} done · ${counts.RUNNING} running · ${counts.BLOCKED} blocked`],
        ["criteria", goal.acceptanceCriteria.join(" | ")],
        ["challenge", goal.challenge === null ? "(not challenged yet)" : `${goal.challenge.mode} → ${goal.challenge.verdict}`],
      ]),
      table("Tasks", ["id", "state", "worker", "depends on"], tasks.map((t) => [t.id, t.state, t.workerId ?? "—", t.dependsOn.join(",") || "—"])),
    ];
    if (goal.challenge !== null && goal.challenge.lenses.length > 0) {
      blocks.push(table("Challenge · 6 lenses", ["lens", "verdict", "ms"], goal.challenge.lenses.map((l) => [l.role, l.verdict, String(l.ms)])));
      blocks.push(note("Synthesis", goal.challenge.note, goal.challenge.verdict === "REVISE" ? "warn" : "info"));
    }
    return out(...blocks);
  }

  if (sub === "challenge") {
    const goal = id === undefined ? goalById(state, state.selectedGoalId) : goalById(state, id);
    if (goal === null) return fail(`no goal "${id ?? state.selectedGoalId}"`, "/goal list");
    goal.challenge = {
      mode: "DEEP",
      verdict: "REVISE",
      rounds: 1,
      lenses: [
        { role: "feasibility", verdict: "PASS", ms: 4020 },
        { role: "failure-analysis", verdict: "PASS", ms: 3710 },
        { role: "user-value", verdict: "PASS", ms: 4330 },
        { role: "security", verdict: "BLOCKED", ms: 4880, objection: "writes outside the authorized workspace" },
        { role: "verification", verdict: "PASS", ms: 3900 },
        { role: "cost-alternatives", verdict: "PASS", ms: 4150 },
      ],
      note: "One blocking objection outvoted the other five. A lens that did not run would be BLOCKED, never PASS.",
    };
    goal.state = "PLAN_PROPOSED";
    pushEvent(state, "GOAL", `challenged ${goal.id} · 6 lenses`, "KAI-OBSERVED", goal.id);
    pushEvent(state, "BLOCKER", "security objection: writes outside the authorized workspace", "KAI-OBSERVED", goal.id);
    return out(DEMO_HEAD, note("Challenge · REVISE", "The security lens blocked. A blocking objection is not outvoted.", "warn"), text(`Next: /goal plan ${goal.id}`));
  }

  if (sub === "plan") {
    const goal = id === undefined ? goalById(state, state.selectedGoalId) : goalById(state, id);
    if (goal === null) return fail(`no goal "${id ?? state.selectedGoalId}"`, "/goal list");
    const next = goal.revisions.length + 1;
    const rev = { id: `rev_${next}`, version: next, note: "tasks restricted to the workspace", approved: false };
    goal.revisions.push(rev);
    goal.state = "AWAITING_PLAN_APPROVAL";
    // A NEW revision invalidates the previous approval. Reusing it would dispatch
    // against a plan the user never saw.
    if (goal.approvedRevision !== null) {
      goal.approvedRevision = null;
      for (const r of goal.revisions) r.approved = false;
    }
    pushEvent(state, "PLAN", `${rev.id} proposed for ${goal.id}`, "KAI-OBSERVED", rev.id);
    return out(
      DEMO_HEAD,
      note("Plan revision proposed", `${rev.id} — "${rev.note}"`, "info"),
      note("Approval invalidated", "A material revision clears the previous approval. Nothing dispatches until you approve this one.", "warn"),
      text(`Next: /goal approve ${goal.id}`),
    );
  }

  if (sub === "approve" || sub === "reject") {
    const goal = id === undefined ? goalById(state, state.selectedGoalId) : goalById(state, id);
    if (goal === null) return fail(`no goal "${id ?? state.selectedGoalId}"`, "/goal list");
    const latest = goal.revisions[goal.revisions.length - 1];
    if (sub === "reject") {
      goal.state = "REJECTED";
      pushEvent(state, "APPROVAL", `user rejected ${latest.id}`, "KAI-OBSERVED", latest.id);
      return out(DEMO_HEAD, note("Rejected", `${latest.id} was rejected. Nothing will dispatch against it.`, "info"));
    }
    latest.approved = true;
    goal.approvedRevision = latest.id;
    goal.state = "RUNNING";
    pushEvent(state, "APPROVAL", `user approved ${latest.id}`, "KAI-OBSERVED", latest.id);
    return out(DEMO_HEAD, note("Approved", `Dispatch is now bound to ${latest.id}.`, "ok"), text(`Next: /run ${goal.id}`));
  }

  return fail(`unknown subcommand "/goal ${sub}"`, "/goal <new|list|inspect|challenge|plan|approve|reject|status> [id]");
});

/* ── Execution ───────────────────────────────────────────────────────────── */

define("Execution", "/run", "Dispatch the next eligible task of a goal", "/run <goal-id>", [], (ctx) => {
  const goal = ctx.args[0] === undefined ? goalById(ctx.state, ctx.state.selectedGoalId) : goalById(ctx.state, ctx.args[0]);
  if (goal === null) return fail(`no goal "${ctx.args[0] ?? ctx.state.selectedGoalId}"`, "/goal list");
  if (goal.approvedRevision === null) {
    return fail(`${goal.id} has no approved revision`, `/goal approve ${goal.id}`);
  }
  const candidates = tasksForGoal(ctx.state, goal.id).filter((t) => isDispatchable(ctx.state, t).ok);
  if (candidates.length === 0) {
    const why = tasksForGoal(ctx.state, goal.id).map((t) => `${t.id}: ${isDispatchable(ctx.state, t).reason}`);
    // Nothing ran, so this is a FAILURE of the command, not a quiet success.
    return {
      ok: false,
      blocks: [DEMO_HEAD, bad("nothing was dispatched", "/task inspect <id>"), note("Why each task is not eligible", why.join(" · "), "warn")],
    };
  }
  const task = candidates[0];
  task.state = "RUNNING";
  task.attempts += 1;
  ctx.state.budget.dispatch.used += 1;
  pushEvent(ctx.state, "DISPATCH", `${task.id} → ${task.workerId} · dispatch ${ctx.state.budget.dispatch.used}/${ctx.state.budget.dispatch.max}`, "KAI-OBSERVED", task.id);
  return out(
    DEMO_HEAD,
    kv(`Dispatched ${task.id}`, [
      ["worker", task.workerId],
      ["attempt", String(task.attempts)],
      ["dispatch allowance", `${ctx.state.budget.dispatch.used} / ${ctx.state.budget.dispatch.max} (reserved BEFORE the claim)`],
      ["criteria", task.criteria.join(" | ")],
    ]),
    note("What happens next", "KAI waits for the worker, then verifies the artifact itself. A worker saying \"done\" is not the proof.", "info"),
  );
});

define("Execution", "/pause", "Pause a goal (Doer OFF stops autonomous work)", "/pause <goal-id>", [], (ctx) => {
  const goal = goalById(ctx.state, ctx.args[0] ?? ctx.state.selectedGoalId);
  if (goal === null) return fail("no such goal", "/goal list");
  ctx.state.doer = "OFF";
  goal.state = "PAUSED";
  pushEvent(ctx.state, "GOAL", `${goal.id} paused — Doer OFF`, "KAI-OBSERVED", goal.id);
  return out(DEMO_HEAD, note("Paused", "Doer is OFF. Autonomous dispatch and follow-up stop immediately. Guard is still ON.", "warn"));
});

define("Execution", "/resume", "Resume a paused goal (re-validates approval)", "/resume <goal-id>", [], (ctx) => {
  const goal = goalById(ctx.state, ctx.args[0] ?? ctx.state.selectedGoalId);
  if (goal === null) return fail("no such goal", "/goal list");
  ctx.state.doer = "ON";
  if (goal.approvedRevision === null) {
    return fail(`${goal.id} has no approved revision — resuming would dispatch unapproved work`, `/goal approve ${goal.id}`);
  }
  goal.state = "RUNNING";
  pushEvent(ctx.state, "GOAL", `${goal.id} resumed — approval re-validated`, "KAI-OBSERVED", goal.id);
  return out(DEMO_HEAD, note("Resumed", `Doer ON, and ${goal.approvedRevision} is still the approved revision.`, "ok"));
});

define("Execution", "/tasks", "The work board", "/tasks [goal-id]", [], (ctx) => {
  const goalId = ctx.args[0];
  const tasks = goalId === undefined ? ctx.state.tasks : tasksForGoal(ctx.state, goalId);
  const counts = taskCounts({ ...ctx.state, tasks });
  return out(
    DEMO_HEAD,
    table("Work board", ["id", "state", "worker", "att", "depends"], tasks.map((t) => [t.id, t.state, t.workerId ?? "—", String(t.attempts), t.dependsOn.join(",") || "—"])),
    text(`${counts.total} tasks · ${counts.COMPLETED} completed · ${counts.RUNNING} running · ${counts.BLOCKED} blocked · ${counts.CHANGES_REQUESTED} needing a change`),
  );
});

define("Execution", "/task", "Inspect one task, its criteria and its evidence", "/task inspect <id>", [], (ctx) => {
  const sub = (ctx.args[0] ?? "").toLowerCase();
  if (sub !== "inspect") return fail(`unknown subcommand "/task ${sub}"`, "/task inspect <id>");
  const task = taskById(ctx.state, ctx.args[1]);
  if (task === null) return fail(`no task "${ctx.args[1]}"`, "/tasks");
  const dispatchable = isDispatchable(ctx.state, task);
  const blocks = [
    DEMO_HEAD,
    kv(`${task.id} · ${task.state}`, [
      ["goal", `${task.goalId} @ ${task.revisionId}`],
      ["worker", task.workerId ?? "(unassigned)"],
      ["attempts", String(task.attempts)],
      ["depends on", task.dependsOn.join(", ") || "(nothing)"],
      ["dispatchable", dispatchable.ok ? "yes" : `no — ${dispatchable.reason}`],
      ["criteria", task.criteria.join(" | ")],
    ]),
  ];
  if (task.blockReason !== undefined) blocks.push(note("Why it is blocked", task.blockReason, "error"));
  if (task.nextCommand !== undefined) blocks.push(text(`Next: ${task.nextCommand}`));
  if (task.evidence.length === 0) {
    blocks.push(note("No evidence", "Nothing has been recorded for this task. It cannot be reported complete.", "warn"));
  } else {
    blocks.push(table("Evidence", ["criterion", "source", "observed", "limitation"], task.evidence.map((e) => [e.criterion, e.source, e.observed, e.limitation ?? "—"])));
  }
  return out(...blocks);
});

define("Execution", "/events", "The activity stream, with each event's evidence source", "/events [kind] [n]", [], (ctx) => {
  const kind = ctx.args[0]?.toUpperCase();
  const limit = Number(ctx.args[1] ?? 20);
  const rows = ctx.state.events.filter((e) => kind === undefined || e.kind === kind).slice(-Math.max(1, Math.min(limit, 200)));
  return out(
    DEMO_HEAD,
    table("Events", ["at", "kind", "source", "text"], rows.map((e) => [e.at, e.kind, e.source, e.text])),
    text(`sources: KAI-OBSERVED (KAI saw it) · WORKER-REPORTED (a worker said it) · VERIFIED (independently checked)`),
  );
});

define("Execution", "/logs", "Raw worker output for a task", "/logs [task-id]", [], (ctx) => {
  const task = taskById(ctx.state, ctx.args[0] ?? "t2");
  if (task === null) return fail(`no task "${ctx.args[0]}"`, "/tasks");
  return out(
    DEMO_HEAD,
    note("Raw output", `${task.id} · ${task.workerId ?? "unassigned"} — the worker's own stdout, unedited and unverified.`, "info"),
    text(`[${task.id}] inspecting target directory\n[${task.id}] applying change\n[${task.id}] running: npm test\n[${task.id}] 12 passing (0 failing)\n[${task.id}] STATUS: ok`),
  );
});

define("Execution", "/evidence", "What KAI can and cannot prove about a goal", "/evidence <goal-id>", [], (ctx) => {
  const goal = goalById(ctx.state, ctx.args[0] ?? ctx.state.selectedGoalId);
  if (goal === null) return fail("no such goal", "/goal list");
  const rows = ctx.state.evidence[goal.id] ?? [];
  if (rows.length === 0) return out(DEMO_HEAD, note("No evidence", `${goal.id} has no recorded evidence. It cannot be called complete.`, "warn"));
  return out(
    DEMO_HEAD,
    table("Evidence", ["criterion", "status", "source", "method", "task"], rows.map((e) => [e.criterion, e.status, e.source, e.method, e.task])),
    ...rows.filter((e) => e.limitation !== null).map((e) => note("Limitation", `${e.criterion}: ${e.limitation}`, "warn")),
  );
});

/* ── Workers ─────────────────────────────────────────────────────────────── */

define("Workers", "/workers", "Every configured worker and its TRUE availability", "/workers", [], (ctx) => {
  return out(
    DEMO_HEAD,
    table(
      "Workers",
      ["id", "runtime", "state", "reachable", "tasks", "reports"],
      ctx.state.workers.map((w) => [
        w.id,
        w.runtime,
        w.state,
        w.reachable ? "yes" : "no",
        String(w.activeTasks),
        Object.entries(w.reports).filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing",
      ]),
    ),
    note("Installed is not registered", "And registered is not reachable. Those are three different facts, and the UI keeps them apart.", "info"),
  );
});

define("Workers", "/worker", "Inspect a worker: tasks, logs, limitations", "/worker <inspect|tasks|logs> <id>", [], (ctx) => {
  const sub = (ctx.args[0] ?? "").toLowerCase();
  const worker = workerById(ctx.state, ctx.args[1] ?? ctx.state.selectedWorkerId);
  if (worker === null) return fail(`no worker "${ctx.args[1]}"`, "/workers");
  ctx.state.selectedWorkerId = worker.id;

  if (sub === "inspect" || sub === "") {
    return out(
      DEMO_HEAD,
      kv(`${worker.label} · ${worker.state}`, [
        ["runtime", worker.runtime],
        ["endpoint", worker.endpoint ?? "(none)"],
        ["configured", String(worker.configured)],
        ["installed", String(worker.installed)],
        ["reachable", String(worker.reachable)],
        ["authorized", String(worker.authorized)],
        ["session", worker.session ?? "(none)"],
        ["assignment", worker.assignment ?? "(idle)"],
        ["capabilities", worker.capabilities.join(", ") || "(none)"],
        ["reports", Object.entries(worker.reports).filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing"],
      ]),
      note("Limitation", worker.limitation, worker.reachable ? "info" : "warn"),
    );
  }
  if (sub === "tasks") {
    const tasks = ctx.state.tasks.filter((t) => t.workerId === worker.id);
    return out(DEMO_HEAD, table(`${worker.label} — KAI's tasks for it`, ["id", "state", "title"], tasks.map((t) => [t.id, t.state, t.title])),
      note("Native vs assigned", "Tasks in the worker's OWN interface are not KAI work items. The board above is authoritative.", "info"));
  }
  if (sub === "logs") {
    if (worker.latest === null) return out(DEMO_HEAD, note("No activity", `${worker.label} has produced nothing.`, "warn"));
    return out(DEMO_HEAD, note("Latest", `${worker.latest.kind} · ${worker.latest.at}`, "info"), text(worker.latest.text));
  }
  return fail(`unknown subcommand "/worker ${sub}"`, "/worker <inspect|tasks|logs> <id>");
});

/* ── Autonomy and safety ─────────────────────────────────────────────────── */

define("Autonomy", "/doer", "Autonomous execution: on or off. Guard is NOT affected.", "/doer <on|off>", [], (ctx) => {
  const want = (ctx.args[0] ?? "").toLowerCase();
  if (want !== "on" && want !== "off") return fail(`"/doer ${want}" is not a state`, "/doer on | /doer off");
  ctx.state.doer = want.toUpperCase();
  pushEvent(ctx.state, "GOAL", `Doer ${ctx.state.doer}`, "KAI-OBSERVED", null);
  return out(
    DEMO_HEAD,
    note(`Doer ${ctx.state.doer}`, ctx.state.doer === "OFF"
      ? "New autonomous dispatch, retry, correction and promotion stop immediately. Incoming results are still recorded. Running workers are NOT killed."
      : "Eligible approved work resumes; the current plan revision and approval are re-validated first.", ctx.state.doer === "OFF" ? "warn" : "ok"),
    kv("Controls", [["Doer", ctx.state.doer], ["Guard", ctx.state.guard + " (never switched by /doer)"]]),
  );
});

define("Autonomy", "/guard", "The policy boundary — always on", "/guard", [], (ctx) => {
  if (ctx.args.length > 0) {
    // There is no `/guard off`. Refusing the ARGUMENT is the point: a boundary a
    // command can lower is not a boundary.
    return fail(`"/guard ${ctx.args[0]}" is not possible — Guard has no off switch`, "/guard");
  }
  return out(
    DEMO_HEAD,
    kv("Guard", [
      ["state", ctx.state.guard],
      ["autonomy", "level 3 · supervised"],
      ["EXTERNAL effects", "approval required"],
      ["DESTRUCTIVE", "approval required"],
      ["outside the workspace", "refused"],
      ["policy.set", "owner only"],
    ]),
    note("This is not a toggle", "Guard has no off switch here, and no command in this prototype turns it off. A skill, a worker or a document cannot widen it by instructing KAI to.", "info"),
  );
});

define("Autonomy", "/policy", "The rules that decide what may run", "/policy", [], (ctx) => {
  return out(
    DEMO_HEAD,
    table("Policy", ["risk", "effect"], [
      ["READ", "runs directly"],
      ["WRITE", "runs inside the authorized workspace"],
      ["EXTERNAL", "parks for your approval"],
      ["DESTRUCTIVE", "parks for your approval; performs nothing until decided"],
    ]),
    note("One boundary", "Every tool invocation passes the same policy check, whoever calls it.", "info"),
  );
});

define("Autonomy", "/approvals", "Pending and spent approvals", "/approvals", [], (ctx) => {
  const pending = ctx.state.approvals.filter((a) => a.status === "PENDING");
  const spent = ctx.state.approvals.filter((a) => a.status === "APPROVED");
  return out(
    DEMO_HEAD,
    table("Pending", ["id", "action", "bound to", "at"], pending.map((a) => [a.id, a.action, a.bound, a.at])),
    table("Spent", ["id", "action", "bound to", "note"], spent.map((a) => [a.id, a.action, a.bound, a.note ?? "—"])),
    note("An approval binds to an ACTION", "Not just to a tool: re-issuing the call with different arguments is refused.", "info"),
  );
});

/* ── Learning ────────────────────────────────────────────────────────────── */

define("Learning", "/memory", "Operational memory: what KAI recorded and why", "/memory search <query>", [], (ctx) => {
  const sub = (ctx.args[0] ?? "").toLowerCase();
  if (sub !== "search") return fail(`unknown subcommand "/memory ${sub}"`, "/memory search <query>");
  const q = ctx.args.slice(1).join(" ").toLowerCase();
  const rows = ctx.state.memory.filter((m) => q.length === 0 || m.text.toLowerCase().includes(q));
  if (rows.length === 0) return out(DEMO_HEAD, note("Nothing matches", `No memory entry mentions "${q}".`, "warn"));
  return out(DEMO_HEAD, table("Memory", ["id", "scope", "text"], rows.map((m) => [m.id, m.scope, m.text])));
});

define("Learning", "/skills", "The skill library, and what is only a candidate", "/skills", [], (ctx) => {
  return out(
    DEMO_HEAD,
    table("Skills", ["id", "version", "source", "scan", "eligible", "note"], ctx.state.skills.map((s) => [s.id, String(s.version), s.source, s.scan, s.eligible ? "yes" : "no", s.note])),
    note("A candidate is not a skill", "Scoring is automatic; proposing, evaluating and promoting are separate states, and a candidate cannot promote itself.", "info"),
  );
});

define("Learning", "/skill", "Skill lifecycle: inspect, propose, evaluate, promote, rollback", "/skill <inspect|propose|evaluate|promote|rollback> <id>", [], (ctx) => {
  const sub = (ctx.args[0] ?? "").toLowerCase();
  const id = ctx.args[1];
  const skill = ctx.state.skills.find((s) => s.id === id);

  if (sub === "inspect") {
    if (skill === undefined) return fail(`no skill "${id}"`, "/skills");
    return out(
      DEMO_HEAD,
      kv(`${skill.id} · v${skill.version}`, [
        ["source", skill.source],
        ["security scan", skill.scan],
        ["eligible", String(skill.eligible)],
        ["note", skill.note],
      ]),
    );
  }
  if (sub === "propose") {
    const candidate = { id: "polling-backoff-2", version: 1, source: "candidate", eligible: false, scan: "CLEAN", note: "from t1 (COMPLETED, verified) — 0 of 3 benchmark tasks run" };
    ctx.state.skills.push(candidate);
    pushEvent(ctx.state, "GOAL", `candidate skill proposed: ${candidate.id}`, "KAI-OBSERVED", "t1");
    return out(DEMO_HEAD, note("Candidate proposed", `${candidate.id} — provenance: goal g-1041, revision rev_2, task t1, worker hermes, verified by KAI.`, "info"), text("Next: /skill evaluate " + candidate.id));
  }
  if (sub === "evaluate") {
    if (skill === undefined) return fail(`no skill "${id}"`, "/skills");
    if (skill.source !== "candidate") return fail(`${skill.id} is not a candidate — nothing to evaluate`, "/skills");
    skill.note = "evaluated: 2 of 3 tasks passed, 1 regressed";
    pushEvent(ctx.state, "GOAL", `evaluated ${skill.id}: 2/3 passed, 1 regressed`, "KAI-OBSERVED", skill.id);
    return out(DEMO_HEAD, note("Evaluation failed its bar", "One task regressed. A candidate that fails evaluation cannot be promoted.", "error"), text("It stays a candidate. /skill rollback is for an ACTIVE version."));
  }
  if (sub === "promote") {
    if (skill === undefined) return fail(`no skill "${id}"`, "/skills");
    if (skill.source !== "candidate") return fail(`${skill.id} is not a candidate`, "/skills");
    return fail(
      `${skill.id} failed evaluation (1 regression) — promotion is refused`,
      "A candidate cannot promote itself, and it cannot weaken Guard to obtain approval.",
    );
  }
  if (sub === "rollback") {
    if (skill === undefined) return fail(`no skill "${id}"`, "/skills");
    if (skill.source === "candidate") return fail(`${skill.id} was never active — there is nothing to roll back to`, "/skills");
    skill.version = Math.max(1, skill.version - 1);
    pushEvent(ctx.state, "GOAL", `rolled back ${skill.id} to v${skill.version}`, "KAI-OBSERVED", skill.id);
    return out(DEMO_HEAD, note("Rolled back", `${skill.id} is now v${skill.version}. The prior revision was kept, so this is reversible again.`, "ok"));
  }
  return fail(`unknown subcommand "/skill ${sub}"`, "/skill <inspect|propose|evaluate|promote|rollback> <id>");
});

/* ── Environment ─────────────────────────────────────────────────────────── */

define("Environment", "/workspace", "The authorized workspace", "/workspace", [], (ctx) =>
  out(DEMO_HEAD, kv("Workspace", [["path", ctx.state.workspace], ["writes outside it", "refused"], ["note", "this is a demo path; nothing here touches a real directory"]])));

define("Environment", "/health", "Core, Doer, Guard and worker summary", "/health", [], (ctx) => {
  const reachable = ctx.state.workers.filter((w) => w.reachable).length;
  return out(
    DEMO_HEAD,
    kv("Health", [
      ["core", ctx.state.coreConnected ? "connected (demo)" : "DISCONNECTED (demo)"],
      ["doer", ctx.state.doer],
      ["guard", ctx.state.guard],
      ["workers", `${reachable} of ${ctx.state.workers.length} reachable`],
      ["provider", ctx.state.providerRateLimited ? "RATE-LIMITED (demo)" : "ok (demo)"],
    ]),
  );
});

define("Environment", "/doctor", "Diagnose the demo's blocked and degraded states", "/doctor", [], (ctx) => {
  const findings = [];
  if (!ctx.state.coreConnected) findings.push(["core", "disconnected — the UI is showing the disconnected state"]);
  if (ctx.state.doer === "OFF") findings.push(["doer", "OFF — autonomous dispatch and follow-up are suspended; Guard is still ON"]);
  if (ctx.state.providerRateLimited) findings.push(["provider", "rate-limited — this is a demo toggle, not a real 429"]);
  for (const w of ctx.state.workers.filter((x) => !x.reachable)) findings.push([`worker:${w.id}`, w.limitation]);
  for (const t of ctx.state.tasks.filter((x) => x.state === "BLOCKED")) findings.push([`task:${t.id}`, t.blockReason ?? "blocked"]);
  for (const s of ctx.state.skills.filter((x) => x.source === "candidate")) findings.push([`skill:${s.id}`, s.note]);
  if (findings.length === 0) return out(DEMO_HEAD, note("Nothing to report", "Every demo component is healthy.", "ok"));
  return out(DEMO_HEAD, table("Findings", ["component", "detail"], findings));
});

define("Environment", "/clear", "Clear the transcript", "/clear", ["/cls"], () => ({ ok: true, blocks: [], clear: true }));

/* ── Execution ───────────────────────────────────────────────────────────── */

/** Aliases, resolved before the table is consulted. */
const ALIASES = { "/?": "/help", "/cls": "/clear", "/t": "/tasks", "/w": "/workers", "/g": "/goal", "/s": "/skills" };

/**
 * Run one command line against the demo state.
 *
 * Returns `{ ok, blocks, clear? }`. Every failure is a structured error with a
 * hint, because "nothing happened" is the least useful answer a terminal can give.
 */
export function runCommand(state, line) {
  const parsed = parseCommand(line);
  if (!parsed.ok) return { ok: false, blocks: [bad(parsed.error, "/help")] };

  const name = ALIASES[parsed.name] ?? parsed.name;
  const command = COMMANDS.find((c) => c.name === name);
  if (command === undefined) {
    // A hint at the closest name, so a typo is a near-miss rather than a dead end.
    const near = COMMANDS.map((c) => c.name).find((n) => n.startsWith(name.slice(0, 3)));
    return { ok: false, blocks: [bad(`"${parsed.name}" is not implemented in this prototype`, near !== undefined ? `did you mean ${near}? · /help` : "/help")] };
  }
  state.history.push(line);
  const ctx = { state, args: parsed.args, raw: parsed.raw, usage: command.usage, name };
  try {
    return command.run(ctx);
  } catch (error) {
    return { ok: false, blocks: [bad(`the command threw: ${error instanceof Error ? error.message : String(error)}`, "/help")] };
  }
}

/** Every command name, for the suggestion list. */
export function commandNames() {
  return COMMANDS.map((c) => c.name);
}

/** Suggestions for a partially typed line. */
export function suggest(prefix, limit = 8) {
  const p = String(prefix ?? "").trim().toLowerCase();
  if (p.length === 0) return COMMANDS.slice(0, limit);
  return COMMANDS.filter((c) => c.name.startsWith(p.split(/\s+/)[0]) || c.aliases.some((a) => a.startsWith(p))).slice(0, limit);
}

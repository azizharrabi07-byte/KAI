// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Louis Raillé — MIT (see repository LICENSE).

/**
 * The prototype's wiring: render DEMO state, drive the command prompt.
 *
 * Everything below reads from `createDemoState()` and re-renders after each
 * command, so a state change (`/doer off`) is visible across the whole surface —
 * the header, the graph and the command output all move together. That is the
 * property a screenshot cannot prove and this prototype exists to test.
 */

import { runCommand, suggest, commandNames } from "./commands.js";
import { createDemoState, goalById, taskById, tasksForGoal, taskCounts, isDispatchable, IN_FLIGHT } from "./state.js";

const state = createDemoState();
const $ = (id) => document.getElementById(id);

/** ── header ──────────────────────────────────────────────────────────────── */

function renderStatus() {
  const reachable = state.workers.filter((w) => w.reachable).length;
  const goal = goalById(state, state.selectedGoalId);
  const pills = [
    ["CORE", state.coreConnected ? "connected" : "DISCONNECTED", state.coreConnected ? "on" : "bad", state.coreConnected ? "accent" : ""],
    ["DOER", state.doer, state.doer === "ON" ? "on" : "off", ""],
    // Guard gets its own colour class so it can never read as the same switch as Doer.
    ["GUARD", state.guard, "on", "guard"],
    ["WORKERS", `${reachable}/${state.workers.length}`, reachable > 0 ? "on" : "bad", ""],
    ["GOAL", goal === null ? "—" : `${goal.id} ${goal.state}`, "on", "accent"],
    ["WS", state.workspace, "on", ""],
  ];
  $("status").innerHTML = pills
    .map(([k, v, dot, extra]) =>
      `<span class="pill ${dot} ${extra}"><span class="dot"></span><span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span></span>`)
    .join("");
}

/** ── the architecture graph ──────────────────────────────────────────────── */

function renderGraph() {
  const goal = goalById(state, state.selectedGoalId);
  if (goal === null) {
    $("graph").innerHTML = `<div class="criteria">no goal selected — /goal list</div>`;
    $("criteria").innerHTML = "";
    $("super").innerHTML = "";
    $("archhint").textContent = "";
    return;
  }
  const tasks = tasksForGoal(state, goal.id);
  const counts = taskCounts({ ...state, tasks });
  const running = tasks.find((t) => t.state === "RUNNING");
  const verified = tasks.filter((t) => t.evidence.some((e) => e.source === "KAI-OBSERVED")).length;
  const approved = goal.approvedRevision !== null;

  const stages = [
    ["GOAL", goal.state, goal.id, goal.state === "BLOCKED" ? "blocked" : "active"],
    ["PLAN", approved ? goal.approvedRevision : "unapproved", `${goal.revisions.length} revision(s)`, approved ? "done" : "blocked"],
    ["TASKS", `${counts.COMPLETED}/${counts.total}`, `${counts.RUNNING} running · ${counts.BLOCKED} blocked`, counts.BLOCKED > 0 ? "blocked" : counts.RUNNING > 0 ? "active" : "done"],
    ["WORKERS", running === undefined ? "idle" : (running.workerId ?? "—"), running === undefined ? "none assigned" : `running ${running.id}`, running === undefined ? "" : "active"],
    ["VERIFICATION", `${verified} verified`, "KAI-observed evidence", verified > 0 ? "done" : ""],
    ["RESULT", goal.state === "COMPLETED" ? "met" : "open", "settles on the gate", ""],
  ];

  $("archhint").textContent = `dispatch bound to ${goal.approvedRevision ?? "(nothing — unapproved)"}`;
  $("graph").innerHTML = `
    <div class="flow">
      ${stages
        .map(([lbl, val, sub, cls], i) =>
          `${i > 0 ? '<span class="arrow">→</span>' : ""}<div class="stage ${cls}"><div class="lbl">${lbl}</div><div class="val">${escapeHtml(val)}</div><div class="sub">${escapeHtml(sub)}</div></div>`)
        .join("")}
    </div>
    <div class="objective"><span class="ok">objective</span>${escapeHtml(goal.objective ?? goal.title ?? goal.id)}</div>
    <div class="tasks">
      ${tasks
        .map(
          (t) => `<div class="task" data-task="${t.id}">
            <span class="tid">${t.id}</span>
            <span class="state ${t.state}">${t.state}</span>
            <span class="ttitle">${escapeHtml(t.title)}</span>
            <span class="tworker">${t.workerId ?? "—"}${t.dependsOn.length > 0 ? ` <span class="deps">· after ${t.dependsOn.join(",")}</span>` : ""}</span>
          </div>`,
        )
        .join("")}
    </div>`;
  const { tone, what, next, also } = supervisorDecision(goal, tasks);
  $("criteria").innerHTML = `<b>acceptance criteria</b> · ${goal.acceptanceCriteria.map(escapeHtml).join(" &nbsp;|&nbsp; ")}`;
  $("super").innerHTML = `
    <div class="superrow ${tone}"><span class="sk">${tone === "wait" ? "waiting on" : tone === "ready" ? "can proceed" : "settled"}</span><span class="sv">${escapeHtml(what)}</span></div>
    <div class="superrow"><span class="sk">next</span><span class="sv"><code>${escapeHtml(next)}</code></span></div>
    ${also === null ? "" : `<div class="superrow wait"><span class="sk">also</span><span class="sv">${escapeHtml(also)}</span></div>`}`;
}

/**
 * What KAI is waiting for, and the next command that moves it.
 *
 * Derived from state, never hard-coded, so suspending autonomy or re-planning
 * changes the advice on the same render.
 */
function supervisorDecision(goal, tasks) {
  const blocked = tasks.find((t) => t.state === "BLOCKED");
  const also = blocked === undefined ? null : `${blocked.id} still needs a decision: ${blocked.blockReason ?? "unstated"}`;
  if (goal.approvedRevision === null) {
    return { tone: "wait", what: `revision ${goal.revisions.length} is not approved — nothing may dispatch`, next: `/goal approve ${goal.id}`, also };
  }
  if (state.doer === "OFF") {
    return { tone: "wait", what: "Doer is OFF — autonomous work is suspended", next: "/doer on", also };
  }
  // What KAI can DO comes first: a supervisor that leads with what it cannot do
  // reads as stuck. Only tasks that are neither finished, blocked, nor already
  // in flight, and whose dependencies are met, are candidates.
  const ready = tasks.find(
    (t) => !IN_FLIGHT.has(t.state) && t.state !== "COMPLETED" && t.state !== "BLOCKED" && t.dependsOn.every((d) => taskById(state, d)?.state === "COMPLETED"),
  );
  if (ready !== undefined) {
    return { tone: "ready", what: `KAI can dispatch ${ready.id} — ${ready.title} (${ready.workerId ?? "no worker"})`, next: `/run ${goal.id}`, also };
  }
  if (tasks.every((t) => t.state === "COMPLETED")) {
    return { tone: "settled", what: "all tasks settled — the outcome gate decides", next: `/goal status ${goal.id}`, also: null };
  }
  // Nothing is ready. Report the REAL reason for each unfinished task rather than
  // blaming whichever one happens to be blocked — a supervisor that names the
  // wrong cause sends the user to the wrong place.
  const pending = tasks.filter((t) => t.state !== "COMPLETED");
  const reasons = pending.map((t) => `${t.id} ${isDispatchable(state, t).reason}`).join(" · ");
  const needsUser = pending.find((t) => t.state === "BLOCKED" || t.state === "CHANGES_REQUESTED");
  return {
    tone: "wait",
    what: reasons.length > 0 ? reasons : "no unfinished task remains",
    next: needsUser === undefined ? "/doctor" : `/task inspect ${needsUser.id}`,
    also: null,
  };
}

/** ── workers ─────────────────────────────────────────────────────────────── */

function renderWorkers() {
  $("workers").innerHTML = state.workers
    .map(
      (w) => `<div class="worker ${w.id === state.selectedWorkerId ? "sel" : ""}" data-worker="${w.id}">
        <div class="top"><span class="name">${escapeHtml(w.label)}</span><span class="wstate ${w.state}">${w.state}</span></div>
        <div class="rt">${escapeHtml(w.runtime)}${w.endpoint !== null ? ` · ${w.endpoint}` : ""}</div>
        <div class="meta">${w.assignment === null ? "idle" : `→ ${escapeHtml(w.assignment)}`} · ${w.activeTasks} task(s)</div>
        <div class="lim">${escapeHtml(w.limitation)}</div>
      </div>`,
    )
    .join("");
}

/** ── events ──────────────────────────────────────────────────────────────── */

function renderEvents() {
  $("events").innerHTML = state.events
    .slice(-40)
    .reverse()
    .map(
      (e) => `<div class="ev">
        <span class="at">${e.at}</span>
        <span class="kind ${e.kind}">${e.kind}</span>
        <span class="txt">${escapeHtml(e.text)}</span>
        <span class="src">${e.source}${e.ref === null ? "" : ` · ${e.ref}`}</span>
      </div>`,
    )
    .join("");
}

/** ── the terminal transcript ─────────────────────────────────────────────── */

function renderBlocks(blocks) {
  return blocks.map(renderBlock).join("");
}

function renderBlock(b) {
  if (b.type === "text") return `<div class="block text">${escapeHtml(b.text)}</div>`;
  if (b.type === "error") {
    return `<div class="block error"><div class="em">${escapeHtml(b.message)}</div>${b.hint === undefined ? "" : `<div class="eh">${escapeHtml(b.hint)}</div>`}</div>`;
  }
  if (b.type === "note") {
    return `<div class="block note ${b.tone}"><div class="nt">${escapeHtml(b.title)}</div><div class="nb">${escapeHtml(b.text)}</div></div>`;
  }
  if (b.type === "kv") {
    return `<div class="block"><div class="section-h">${escapeHtml(b.title)}</div>${b.rows
      .map(([k, v]) => `<div class="kvrow"><span class="k">${escapeHtml(String(k))}</span><span class="v">${escapeHtml(String(v))}</span></div>`)
      .join("")}</div>`;
  }
  if (b.type === "table") {
    return `<div class="block"><div class="section-h">${escapeHtml(b.title)}</div><table><thead><tr>${b.columns
      .map((c) => `<th>${escapeHtml(c)}</th>`)
      .join("")}</tr></thead><tbody>${b.rows
      .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;
  }
  return "";
}

function echo(line) {
  return `<div class="echo"><span class="pr">kai&gt;</span> ${escapeHtml(line)}</div>`;
}

function append(line, result) {
  const el = $("transcript");
  el.insertAdjacentHTML("beforeend", echo(line) + renderBlocks(result.blocks));
  el.scrollTop = el.scrollHeight;
}

function renderAll() {
  renderStatus();
  renderGraph();
  renderWorkers();
  renderEvents();
}

/** ── the prompt ─────────────────────────────────────────────────────────── */

const el = $("prompt");
let sugList = [];
let sugSel = 0;
let historyIndex = -1;

function renderSuggestions() {
  const box = $("suggest");
  const value = el.value;
  if (!value.startsWith("/") || value.includes(" ") && value.trim().split(/\s+/).length > 2) {
    box.hidden = true;
    sugList = [];
    return;
  }
  sugList = suggest(value);
  if (sugList.length === 0) {
    box.hidden = true;
    return;
  }
  sugSel = 0;
  box.hidden = false;
  box.innerHTML = sugList
    .map(
      (c, i) => `<div class="sug ${i === 0 ? "sel" : ""}" data-i="${i}">
        <span class="sn">${escapeHtml(c.usage)}</span>
        <span class="sf">${escapeHtml(c.family)}</span>
        <span class="sd">${escapeHtml(c.summary)}</span>
      </div>`,
    )
    .join("");
  box.querySelectorAll(".sug").forEach((node) =>
    node.addEventListener("mousedown", (event) => {
      event.preventDefault();
      acceptSuggestion(Number(node.dataset.i));
    }),
  );
}

function acceptSuggestion(index) {
  const chosen = sugList[index];
  if (chosen === undefined) return;
  // Complete to the command name and keep a trailing space, so the next keystroke
  // is the argument.
  el.value = chosen.name === "/goal" || chosen.name === "/skill" || chosen.name === "/worker" || chosen.name === "/memory" || chosen.name === "/task"
    ? `${chosen.name} `
    : chosen.name;
  $("suggest").hidden = true;
  el.focus();
}

function moveSuggestion(delta) {
  if (sugList.length === 0) return;
  sugSel = (sugSel + delta + sugList.length) % sugList.length;
  $("suggest").querySelectorAll(".sug").forEach((n, i) => n.classList.toggle("sel", i === sugSel));
}

function submit(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  const result = runCommand(state, trimmed);
  if (result.clear === true) {
    $("transcript").innerHTML = "";
    renderAll();
    return;
  }
  append(trimmed, result);
  renderAll();
  $("suggest").hidden = true;
}

$("promptform").addEventListener("submit", (event) => {
  event.preventDefault();
  submit(el.value);
  el.value = "";
  historyIndex = -1;
});

el.addEventListener("input", renderSuggestions);

el.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    if (!$("suggest").hidden) {
      event.preventDefault();
      moveSuggestion(1);
    }
    return;
  }
  if (event.key === "ArrowUp") {
    if (!$("suggest").hidden) {
      event.preventDefault();
      moveSuggestion(-1);
      return;
    }
    if (state.history.length === 0) return;
    event.preventDefault();
    historyIndex = historyIndex === -1 ? state.history.length - 1 : Math.max(0, historyIndex - 1);
    el.value = state.history[historyIndex] ?? "";
    return;
  }
  if (event.key === "Tab") {
    if (!$("suggest").hidden && sugList.length > 0) {
      event.preventDefault();
      acceptSuggestion(sugSel);
    }
    return;
  }
  if (event.key === "Escape") {
    $("suggest").hidden = true;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    submit(el.value);
    el.value = "";
    historyIndex = -1;
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    el.focus();
    el.select();
  }
});

/** Clicking a task or worker inspects it, exactly as the command would. */
document.addEventListener("click", (event) => {
  const task = event.target instanceof Element ? event.target.closest("[data-task]") : null;
  if (task !== null) {
    submit(`/task inspect ${task.dataset.task}`);
    return;
  }
  const worker = event.target instanceof Element ? event.target.closest("[data-worker]") : null;
  if (worker !== null) {
    state.selectedWorkerId = worker.dataset.worker;
    submit(`/worker inspect ${worker.dataset.worker}`);
  }
});

/** ── boot ───────────────────────────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

renderAll();
$("transcript").innerHTML =
  `<div class="block note warn"><div class="nt">DEMO PROTOTYPE</div><div class="nb">
     Every goal, worker, event and number here is invented. Nothing is connected to a Core.
     Type <b>/help</b> for the commands that actually work, then try <b>/goal inspect g-1041</b>,
     <b>/doer off</b> and <b>/skill promote polling-backoff</b>.
   </div></div>`;
$("transcript").insertAdjacentHTML("beforeend", echo("/goal inspect g-1041") + renderBlocks(runCommand(state, "/goal inspect g-1041").blocks));
renderAll();
el.focus();

// Expose for the acceptance checks and for a reviewer's console.
window.__kaiDemo = { state, runCommand, submit, commandNames };

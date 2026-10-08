#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * RC-VALIDATION — release-candidate battery against a REAL Core booted from SOURCE:
 *
 *   (1) realistic multi-tool task (search -> read -> verdict with files+evidence)
 *   (2) forced interruption -> PAUSED, then "continue" resumes + completes
 *   (3) forced budget-cut with empty synthesis -> structured PAUSED, never bare progress
 *   (4) providers: 3 live entries, catalogues, /models/use parks -> approve -> applies -> survives restart
 *   (5) commands: /models /providers /tools /skills /agents /mcp via POST /commands/:id/run
 *   (6) @agent park + Allow-collect and @skill body load via the chat route
 *   (7) session switching: 3 sessions, interleaved turns, isolation + intact transcripts
 *   (8) agent lifecycle: create + message + edit objective + reload persists + persona-authored run
 *   (9) settings persist + effective sources
 *
 * The model is scripted (instant) — this validates KAI, not the network.
 * Run from `core/`:  node scripts/rc-validation.mjs
 * Writes docs/evidence/rc-validation.json. Exits non-zero on any failure.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UID = Date.now().toString(36);

const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

// ── Temp workspace + DB dir ──────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "kai-rc-"));
const stageDir = join(dir, "workspace");
mkdirSync(stageDir, { recursive: true });
writeFileSync(
  join(stageDir, "loader-audit.txt"),
  "the loader reads turns newest-first; the bug: it drops tool records on reload\n",
  "utf8",
);
writeFileSync(
  join(stageDir, "tool-loop.txt"),
  "tool loop runs search then read; keeper line: the lighthouse stands\n",
  "utf8",
);
process.env.KAI_WORKSPACE_ROOT = stageDir;

// ── Stub worker backends (so /providers probes are LIVE, not offline) ─────────
function startStub(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const payload = handler(req.url ?? "/", req.method ?? "GET", body);
      const text = JSON.stringify(payload.body);
      res.writeHead(payload.status, { "content-type": "application/json" });
      res.end(text);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise(server));
  });
}

const hermesStub = await startStub((url) => {
  if (url === "/health") return { status: 200, body: { status: "ok", platform: "test", version: "rc-9.9.9" } };
  if (url === "/v1/models") return { status: 200, body: { data: [{ id: "hermes-rc-model" }] } };
  return { status: 404, body: { error: "nope" } };
});
const opencodeStub = await startStub((url) => {
  if (url === "/global/health") return { status: 200, body: { healthy: true, version: "rc-9.9.9" } };
  return { status: 404, body: { error: "nope" } };
});
const HERMES_URL = `http://127.0.0.1:${hermesStub.address().port}`;
const OPENCODE_URL = `http://127.0.0.1:${opencodeStub.address().port}`;

// ── Scripted instant model (OpenAI wire shape) ───────────────────────────────
const seenBodies = [];
function completion(text, toolCalls) {
  return new Response(
    JSON.stringify({
      model: "rc-model",
      choices: [{
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls !== undefined ? "tool_calls" : "stop",
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
const tc = (name, args) => ({
  id: `call_${Math.random().toString(36).slice(2)}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

function scriptedFetch() {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/models") && (init.method === undefined || init.method === "GET")) {
      return new Response(
        JSON.stringify({ data: [{ id: "rc-model" }, { id: "rc-switched-model" }, { id: "rc-settings-model" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    let body = {};
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    } catch { body = {}; }
    try {
      seenBodies.push(JSON.stringify(body).slice(0, 30000));
    } catch { /* never break the turn on telemetry */ }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m?.role === "user");
    const lastText = String(lastUser?.content ?? "");
    const toolResults = messages.filter((m) => m?.role === "tool").length;

    // Final-synthesis guard pass: always empty -> honest PAUSED.
    if (lastText.includes("FINAL answer")) return completion("");
    // Resume prompt ("continue"): finish the SAME task.
    if (lastText.includes("Original objective (do not lose this)")) {
      if (lastText.includes(`RC2-RESUME-${UID}`)) {
        return completion(
          "## Result\nRC2 resumed and finished: the loader drops tool records. " +
          "Verdict: RC2-VERDICT-DONE fix the loader to keep tool records.",
        );
      }
      return completion("## Result\nResumed and finished. Verdict: done.");
    }
    // (1) realistic multi-tool task.
    if (lastText.includes(`RC1-AUDIT-${UID}`)) {
      if (toolResults === 0) {
        return completion("I'll inspect the staged files.", [
          tc("filesystem_search", { query: "loader fault", path: stageDir }),
        ]);
      }
      if (toolResults === 1) {
        return completion("Found candidates; reading the loader file.", [
          tc("filesystem_read", { path: join(stageDir, "loader-audit.txt") }),
        ]);
      }
      return completion(
        "## Result\nFiles: loader-audit.txt, tool-loop.txt. " +
        "Evidence: the loader reads turns newest-first but drops tool records on reload. " +
        "Verdict: RC1-VERDICT the loader is at fault — fix it to keep tool records.",
      );
    }
    // (2)/(3): never finish on our own — the budget cut must pause us.
    if (lastText.includes(`RC2-RESUME-${UID}`) || lastText.includes(`RC3-PAUSE-${UID}`)) {
      return completion("Still searching the workspace.", [
        tc("filesystem_search", { query: "workspace audit", path: stageDir }),
      ]);
    }
    return completion(`rc reply to: ${lastText.slice(0, 80)}`);
  };
}

// ── Boot / reboot (same DB files) ────────────────────────────────────────────
let rt = null;
let server = null;
let base = "";
function runtimeOptions() {
  return {
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock", hermes: { baseUrl: HERMES_URL, apiKey: "rc-key" }, opencode: { baseUrl: OPENCODE_URL } },
    startScheduler: false,
    model: { apiKey: "rc-key", baseUrl: "http://127.0.0.1:9/rc", name: "rc-model", fetchImpl: scriptedFetch() },
    brainMaxToolIterations: 2,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  };
}
async function boot() {
  rt = createCoreRuntime(runtimeOptions());
  await rt.start();
  server = createKaiServer(loadConfig(process.env), { core: rt });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function shutdown() {
  if (server) await new Promise((r) => server.close(() => r()));
  server = null;
  if (rt) await rt.stop();
  rt = null;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
};
const get = async (path) => {
  const res = await fetch(`${base}${path}`);
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
};
const parkedIdOf = (r) => {
  const b = (r?.body ?? {});
  return typeof b.approvalId === "string" && b.approvalId.length > 0 ? b.approvalId : null;
};
async function approveAndReissue(path, body, approvalId) {
  const decided = await post(`/approvals/${approvalId}/decide`, { approved: true });
  if (decided.status !== 200) return { decided, reissued: null };
  const reissued = await post(path, { ...(body ?? {}), approvalId });
  return { decided, reissued };
}

// ── Evidence ─────────────────────────────────────────────────────────────────
const evidence = { at: new Date().toISOString(), uid: UID, scenarios: {}, verdict: "pending" };
const failures = [];
const check = (name, cond, detail) => {
  evidence.scenarios[name] = { pass: !!cond, detail: detail ?? null };
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`);
  if (!cond) failures.push(name);
};

try {
  await boot();

  // ── (1) realistic multi-tool task ─────────────────────────────────────────
  {
    const name = "(1) multi-tool task names files + verdict, COMPLETED";
    const created = await post("/sessions", {});
    const sid = created.body?.session?.id;
    const r = await post("/chat", {
      text: `RC1-AUDIT-${UID}: inspect the staged workspace files, find the cause of the loader fault, deliver a verdict naming the files with evidence`,
      conversation_id: sid,
    });
    const reply = String(r.body?.reply ?? "");
    const state = r.body?.task_state ?? r.body?.taskState;
    const calls = r.body?.tool_calls ?? [];
    const names = calls.map((c) => c.toolId ?? c.name);
    const turns = await get(`/sessions/${sid}/turns?limit=100`);
    const tjson = JSON.stringify(turns.body?.turns ?? []);
    const ok = r.status === 200
      && state === "COMPLETED"
      && reply.includes("loader-audit.txt")
      && reply.includes("RC1-VERDICT")
      && /verdict/i.test(reply)
      && !/^(I'll|Still searching)/i.test(reply.trim())
      && names.includes("filesystem.search")
      && tjson.includes("loader-audit.txt");
    check(name, ok, `state=${state} tools=${names.join(",")} reply=${reply.slice(0, 160)}`);
  }

  // ── (2) forced interruption -> PAUSED -> continue resumes + completes ──────
  {
    const name = "(2) budget-cut PAUSES, continue resumes SAME task to COMPLETED";
    const sid = (await post("/sessions", {})).body?.session?.id;
    const before = seenBodies.length;
    const r1 = await post("/chat", {
      text: `RC2-RESUME-${UID}: audit the workspace and report the verdict`,
      conversation_id: sid,
    });
    const reply1 = String(r1.body?.reply ?? "");
    const state1 = r1.body?.task_state ?? r1.body?.taskState;
    const paused = r1.status === 200
      && state1 === "PAUSED"
      && /Task paused because the execution budget was reached/.test(reply1)
      && /Completed:/.test(reply1)
      && /Remaining:/.test(reply1)
      && /continue/i.test(reply1);
    const r2 = await post("/chat", { text: "continue", conversation_id: sid });
    const reply2 = String(r2.body?.reply ?? "");
    const state2 = r2.body?.task_state ?? r2.body?.taskState;
    const resumedBodies = seenBodies.slice(before).join("\n");
    const resumed = r2.status === 200
      && state2 === "COMPLETED"
      && reply2.includes("RC2-VERDICT-DONE")
      && resumedBodies.includes("Original objective (do not lose this)")
      && resumedBodies.includes(`RC2-RESUME-${UID}`);
    check(name, paused && resumed,
      `paused=${paused} state1=${state1} resumed=${resumed} state2=${state2} reply2=${reply2.slice(0, 120)}`);
  }

  // ── (3) budget-cut + empty synthesis -> structured PAUSED ──────────────────
  {
    const name = "(3) empty synthesis pauses honestly, never bare progress";
    const sid = (await post("/sessions", {})).body?.session?.id;
    const r = await post("/chat", {
      text: `RC3-PAUSE-${UID}: audit the workspace and report the verdict`,
      conversation_id: sid,
    });
    const reply = String(r.body?.reply ?? "");
    const state = r.body?.task_state ?? r.body?.taskState;
    const ok = r.status === 200
      && state === "PAUSED"
      && /Task paused because the execution budget was reached/.test(reply)
      && /Completed:/.test(reply)
      && /Remaining:/.test(reply)
      && reply.trim() !== "Still searching the workspace.";
    check(name, ok, `state=${state} reply=${reply.slice(0, 200)}`);
  }

  // ── (4) providers + models/use park/approve/restart ───────────────────────
  {
    const name = "(4) providers live, models/use parks then applies + survives restart";
    const prov = await get("/providers");
    const list = prov.body?.providers ?? [];
    const ids = list.map((p) => p.id).sort();
    const kinds = Object.fromEntries(list.map((p) => [p.id, p.kind]));
    const threeLive = prov.status === 200
      && ids.join(",") === "hermes,kai-model,opencode"
      && kinds["kai-model"] === "model"
      && kinds["hermes"] === "worker"
      && kinds["opencode"] === "worker";
    const cat = await get("/models");
    const catProviders = cat.body?.providers ?? [];
    const kaiCat = catProviders.find((p) => p.id === "kai-model");
    const hermesCat = catProviders.find((p) => p.id === "hermes");
    const catalogues = cat.status === 200
      && catProviders.length === 3
      && Array.isArray(kaiCat?.models)
      && kaiCat.models.length > 0;
    const parked = await post("/models/use", { model: "rc-switched-model" });
    const approvalId = parkedIdOf(parked);
    let applied = false;
    if (parked.status === 409 && approvalId) {
      const { reissued } = await approveAndReissue("/models/use", { model: "rc-switched-model" }, approvalId);
      applied = reissued?.status === 200;
    }
    const after = await get("/models");
    const kaiAfter = (after.body?.providers ?? []).find((p) => p.id === "kai-model");
    const current = (kaiAfter?.models ?? []).find((m) => m.current);
    const selected = applied && current?.id === "rc-switched-model";
    const workerRefused = (await post("/models/use", { model: "x", provider: "hermes" })).status === 400;

    // Restart on the SAME DB files; the selection must survive.
    await shutdown();
    await boot();
    const settings = await get("/settings");
    const survives = settings.status === 200
      && settings.body?.effective?.values?.name === "rc-switched-model";
    check(name, threeLive && catalogues && selected && workerRefused && survives,
      `providers=${ids.join(",")} kaiModels=${(kaiCat?.models ?? []).map((m) => m.id).join(",")} hermesModels=${(hermesCat?.models ?? []).map((m) => m.id).join(",") || hermesCat?.note} selected=${selected} survives=${survives}`);
  }

  // ── (5) commands ──────────────────────────────────────────────────────────
  {
    const name = "(5) /models /providers /tools /skills /agents /mcp run live";
    const catalogue = await get("/commands");
    const catIds = (catalogue.body?.commands ?? []).map((c) => c.id);
    const wanted = ["models", "providers", "tools", "skills", "agents", "mcp"];
    const results = {};
    for (const id of wanted) {
      const r = await post(`/commands/${id}/run`, {});
      results[id] = { status: r.status, text: String(r.body?.result?.text ?? "") };
    }
    const live = (id, re) => results[id].status === 200 && re.test(results[id].text);
    const ok = wanted.every((id) => catIds.includes(id))
      && live("models", /KAI model|rc-model|active/)
      && live("providers", /kai-model/)
      && live("tools", /filesystem\.search/)
      && live("skills", /skill/i)
      && live("agents", /agent/i)
      && live("mcp", /MCP|server/i);
    const skills = await get("/skills");
    const skillCount = (skills.body?.skills ?? []).length;
    check(name, ok && skillCount >= 1,
      `models=${results.models.text.slice(0, 60)} tools-hit=${/filesystem\.search/.test(results.tools.text)} skills=${skillCount} agents=${results.agents.text.slice(0, 60)} mcp=${results.mcp.text.slice(0, 60)}`);
  }

  // ── (6) @agent park + Allow-collect, @skill body load ─────────────────────
  {
    const name = "(6) @agent parks + Allow collects; @skill loads body";
    // Persona for the @agent turn.
    const spec = {
      id: "rcc", name: "Rcc", role: "courier",
      soul: "I carry messages swiftly and exactly.",
      workerId: "opencode",
      objective: `RC6-OBJECTIVE-${UID}: carry the verdict`,
      instructions: `RC6-INSTRUCTIONS-${UID}: one line, exact`,
    };
    let created = await post("/subagents", spec);
    if (created.status === 409 && parkedIdOf(created)) {
      const { reissued } = await approveAndReissue("/subagents", spec, parkedIdOf(created));
      created = reissued;
    }
    const sid = (await post("/sessions", {})).body?.session?.id;
    const agentTurn = await post("/chat", {
      text: `@rcc RC6-AGENT-${UID}: survey the workspace and report back`,
      conversation_id: sid,
    });
    const run = agentTurn.body?.agent_run ?? agentTurn.body?.agentRun;
    const agentApproval = typeof run?.approvalId === "string" ? run.approvalId : null;
    const agentParked = agentTurn.status === 200 && agentApproval !== null && /approval/i.test(String(agentTurn.body?.reply ?? ""));
    let collected = false;
    let collectReply = "";
    if (agentParked) {
      const msg = await post("/subagents/rcc/message", {
        input: `RC6-AGENT-${UID} collect after allow`,
        approvalId: agentApproval,
      });
      collectReply = String(msg.body?.reply ?? msg.body?.subagent?.reply ?? "");
      collected = msg.status === 200 && collectReply.includes("I'm Rcc");
    }
    const skillTurn = await post("/chat", {
      text: `@deep-research RC6-SKILL-${UID}: compare the loader and the tool loop`,
      conversation_id: sid,
    });
    const inv = skillTurn.body?.invocation;
    const skillReceipt = skillTurn.status === 200
      && Array.isArray(inv?.skills) && inv.skills.includes("deep-research");
    const bodyLoaded = seenBodies.join("\n").includes("shared schema");
    check(name, created.status === 201 && agentParked && collected && skillReceipt && bodyLoaded,
      `create=${created.status} parked=${agentParked} collected=${collected} reply=${collectReply.slice(0, 80)} skill=${skillReceipt} bodyLoaded=${bodyLoaded}`);
  }

  // ── (7) session switching ─────────────────────────────────────────────────
  {
    const name = "(7) 3 sessions interleave isolated, transcripts intact";
    const mk = async (title) => (await post("/sessions", { title })).body?.session?.id;
    const idA = await mk(`RC7-A-${UID}`);
    const idB = await mk(`RC7-B-${UID}`);
    const idC = await mk(`RC7-C-${UID}`);
    const turns = [["A", idA, 1], ["B", idB, 1], ["C", idC, 1], ["A", idA, 2], ["B", idB, 2], ["C", idC, 2]];
    let allOk = true;
    for (const [tag, sid, n] of turns) {
      const r = await post("/chat", { text: `RC7-${tag}-${UID} turn ${n}`, conversation_id: sid });
      if (r.status !== 200 || (r.body?.conversation_id ?? null) !== sid) allOk = false;
    }
    await post(`/sessions/${idB}/activate`, {});
    const tA = await get(`/sessions/${idA}/turns?limit=100`);
    const tB = await get(`/sessions/${idB}/turns?limit=100`);
    const tC = await get(`/sessions/${idC}/turns?limit=100`);
    const active = await get("/sessions/active");
    const jA = JSON.stringify(tA.body?.turns ?? []);
    const jB = JSON.stringify(tB.body?.turns ?? []);
    const jC = JSON.stringify(tC.body?.turns ?? []);
    const isolated = jA.includes(`RC7-A-${UID}`) && !jA.includes(`RC7-B-${UID}`) && !jA.includes(`RC7-C-${UID}`)
      && jB.includes(`RC7-B-${UID}`) && !jB.includes(`RC7-A-${UID}`) && !jB.includes(`RC7-C-${UID}`)
      && jC.includes(`RC7-C-${UID}`) && !jC.includes(`RC7-A-${UID}`) && !jC.includes(`RC7-B-${UID}`);
    const intact = (tA.body?.turns ?? []).length === 4
      && (tB.body?.turns ?? []).length === 4
      && (tC.body?.turns ?? []).length === 4;
    const switched = active.body?.session?.id === idB;
    check(name, allOk && isolated && intact && switched,
      `isolated=${isolated} intact=${intact} active=${active.body?.session?.id === idB}`);
  }

  // ── (8) agent lifecycle ────────────────────────────────────────────────────
  {
    const name = "(8) persona create/message/edit/reload-persist/persona-run";
    const baseSpec = {
      id: "rcagent", name: "RcAgent", role: "field researcher",
      soul: "I observe precisely and report plainly.",
      workerId: "opencode",
      objective: `RC8-OBJECTIVE-${UID}: watch the north gate`,
      instructions: `RC8-INSTRUCTIONS-${UID}: report in one line`,
    };
    let created = await post("/subagents", baseSpec);
    if (created.status === 409 && parkedIdOf(created)) {
      const { reissued } = await approveAndReissue("/subagents", baseSpec, parkedIdOf(created));
      created = reissued;
    }
    // Direct message: parks, then Allow collects a persona-authored reply.
    const first = await post("/subagents/rcagent/message", { input: `RC8-DIRECT-${UID}: status check` });
    const firstApproval = parkedIdOf(first);
    let directReply = "";
    if (first.status === 409 && firstApproval) {
      const msg = await post("/subagents/rcagent/message", { input: `RC8-DIRECT-${UID}: status check`, approvalId: firstApproval });
      directReply = String(msg.body?.reply ?? "");
    }
    const directOk = directReply.includes("I'm RcAgent");
    // Edit the objective by re-defining the same id.
    const edited = { ...baseSpec, objective: `RC8-OBJECTIVE-EDITED-${UID}: watch both gates` };
    const editRes = await post("/subagents/rcagent", edited);
    const editOk = editRes.status === 201 || editRes.status === 200;
    const got = await get("/subagents/rcagent");
    const editVisible = String(got.body?.subagent?.spec?.objective ?? got.body?.subagent?.objective ?? "").includes(`RC8-OBJECTIVE-EDITED-${UID}`);
    // Reload on the SAME DB: the edited objective must persist.
    await shutdown();
    await boot();
    const after = await get("/subagents/rcagent");
    const persists = String(after.body?.subagent?.spec?.objective ?? after.body?.subagent?.objective ?? "").includes(`RC8-OBJECTIVE-EDITED-${UID}`);
    // Run after reload: persona-authored final from the mock worker.
    const run = await post("/subagents/rcagent/message", { input: `RC8-RUN-${UID}: final sweep` });
    const runApproval = parkedIdOf(run);
    let runReply = "";
    if (run.status === 409 && runApproval) {
      const msg = await post("/subagents/rcagent/message", { input: `RC8-RUN-${UID}: final sweep`, approvalId: runApproval });
      runReply = String(msg.body?.reply ?? "");
    }
    const runOk = runReply.includes("I'm RcAgent") && runReply.trim().length > "I'm RcAgent".length;
    check(name, created.status === 201 && directOk && editOk && editVisible && persists && runOk,
      `create=${created.status} direct=${directOk} edit=${editOk}/${editVisible} persists=${persists} run=${runOk} runReply=${runReply.slice(0, 90)}`);
  }

  // ── (9) settings persist + effective sources ───────────────────────────────
  {
    const name = "(9) settings park/approve/persist with effective sources";
    const parked = await post("/settings", { "model.name": "rc-settings-model" });
    const approvalId = parkedIdOf(parked);
    let storedOk = false;
    if (parked.status === 409 && approvalId) {
      const { reissued } = await approveAndReissue("/settings", { "model.name": "rc-settings-model" }, approvalId);
      storedOk = reissued?.status === 200;
    }
    const s = await get("/settings");
    const stored = s.body?.stored ?? [];
    const effective = s.body?.effective ?? {};
    const ok = storedOk
      && s.status === 200
      && effective?.values?.name === "rc-settings-model"
      && effective?.sources?.name === "settings"
      && JSON.stringify(stored).includes("model.name");
    check(name, ok,
      `effective=${effective?.values?.name} source=${effective?.sources?.name} storedKeys=${(stored ?? []).map((e) => e.key).join(",")}`);
  }

  evidence.verdict = failures.length === 0 ? "PASS" : `FAIL: ${failures.join(", ")}`;
  if (failures.length > 0) process.exitCode = 1;
} catch (e) {
  evidence.verdict = `ERROR: ${e?.message ?? e}`;
  console.error(evidence.verdict);
  process.exitCode = 1;
} finally {
  try { await shutdown(); } catch { /* best-effort */ }
  try { hermesStub.close(); } catch { /* best-effort */ }
  try { opencodeStub.close(); } catch { /* best-effort */ }
  try {
    const out = join(CORE, "..", "docs", "evidence", "rc-validation.json");
    writeFileSync(out, JSON.stringify(evidence, null, 2), "utf8");
    console.log(`evidence: ${out}`);
  } catch (e) {
    console.error(`could not write evidence: ${String(e)}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P1 LIVE E2E — real sessions over real HTTP against a real Core + real model:
 *
 *   1. Create session            6. Rename session            11. Delete it
 *   2. Title through conversation 7. Reload (new runtime, same DB files) 12. Gone
 *   3. Several messages           8. Session remains           13. Create another
 *   4. filesystem.search          9. Summary remains           14. Switch sessions
 *   5. Tool record in history    10. Search finds it           15. Transcripts isolated
 *
 * Fails non-zero on the first unmet expectation. Writes the full evidence to
 * docs/evidence/session-e2e-live.json.
 *
 * Run from `core/`:  node scripts/session-e2e-live.mjs
 * Requires a configured model (KAI_MODEL_API_KEY or <KAI_HOME>/model/credentials.json).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

const dir = mkdtempSync(join(tmpdir(), "kai-session-e2e-"));
const KNOWN = `kai-e2e-proof-${Date.now().toString(36)}`;
const stageDir = join(dir, "workspace");
const { mkdirSync } = await import("node:fs");
mkdirSync(stageDir, { recursive: true });
writeFileSync(join(stageDir, "field-notes.txt"), `tuesday\nthe keeper wrote ${KNOWN} here\n`, "utf8");
process.env.KAI_WORKSPACE_ROOT = stageDir;

const evidence = { at: new Date().toISOString(), steps: [], verdict: "pending" };
const note = (step, facts) => {
  evidence.steps.push({ step, ...facts });
  console.log(`\n=== ${step} ===`);
  console.log(JSON.stringify(facts, null, 2).slice(0, 1500));
};

let servers = [];
async function boot() {
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, sessionsPath: join(dir, "kai-sessions.db") },
  });
  await rt.start();
  const server = createKaiServer(loadConfig(process.env), { core: rt });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const handle = { base, rt, server };
  servers.push(handle);
  return handle;
}
async function shutdown(handle) {
  await new Promise((resolve) => handle.server.close(() => resolve()));
  await handle.rt.stop();
  servers = servers.filter((s) => s !== handle);
}

const post = async (base, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};
const get = async (base, path) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};
const fail = (why) => {
  evidence.verdict = `FAIL: ${why}`;
  console.error(`\nE2E FAIL: ${why}`);
  process.exitCode = 1;
};
const expect = (cond, why) => {
  if (!cond) {
    fail(why);
    throw new Error(why);
  }
};

let primary = null;
try {
  primary = await boot();

  // 1. Create session.
  let r = await post(primary.base, "/sessions", {});
  expect(r.status === 201 && r.body.session?.id, `create failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const idA = r.body.session.id;
  note("1. create session", { idA, title: r.body.session.title });

  // 2. Real title through conversation (autotitle derives from first user turn).
  r = await post(primary.base, "/chat", {
    text: "Help me design the restaurant QR ordering flow with a worker confirmation step",
    conversation_id: idA,
  });
  expect(r.status === 200, `chat 1 failed: ${r.status}`);
  expect(r.body.conversation_id === idA, `turn left the session: ${r.body.conversation_id}`);
  let s = await get(primary.base, `/sessions/${idA}`);
  expect(s.status === 200, "get session failed");
  note("2. title through conversation", { title: s.body.session.title, conversation_id: r.body.conversation_id });
  expect(!/^Conversation \d+$/.test(s.body.session.title), `title still a placeholder: ${s.body.session.title}`);

  // 3. Several more messages, same session.
  for (const text of [
    "We decided to keep Supabase as the persistence layer",
    "Remaining task: improve the worker refresh behavior",
  ]) {
    r = await post(primary.base, "/chat", { text, conversation_id: idA });
    expect(r.status === 200 && r.body.conversation_id === idA, `follow-up left the session: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  note("3. several messages", { lastReply: String(r.body.reply).slice(0, 200) });

  // 4. filesystem.search through the conversation.
  r = await post(primary.base, "/chat", { text: `Search my files for ${KNOWN}`, conversation_id: idA });
  expect(r.status === 200, `search turn failed: ${r.status}`);
  const toolCalls = r.body.tool_calls ?? [];
  note("4. search turn", {
    tool_calls: toolCalls.map((c) => ({ name: c.name, status: c.status, invocationId: c.invocationId })),
    reply: String(r.body.reply).slice(0, 300),
  });
  expect(toolCalls.some((c) => c.name === "filesystem_search" && c.status === "EXECUTED"), "model never EXECUTED filesystem.search");
  expect(String(r.body.reply).includes("field-notes.txt") || String(r.body.reply).includes(KNOWN), "reply not grounded in the hit");

  // 5. Tool call/result in session history.
  r = await get(primary.base, `/sessions/${idA}/turns?limit=100`);
  expect(r.status === 200, "turns read failed");
  const assistantTurns = r.body.turns.filter((t) => t.role === "assistant");
  const withTools = assistantTurns.filter((t) => Array.isArray(t.tools) && t.tools.length > 0);
  note("5. tool record in history", {
    turns: r.body.turns.length,
    assistantTurns: assistantTurns.length,
    turnsWithTools: withTools.length,
    firstTool: withTools[0]?.tools?.[0] ? { name: withTools[0].tools[0].toolName, status: withTools[0].tools[0].status } : null,
  });
  expect(withTools.length > 0, "no persisted tool call on any assistant turn");
  const allToolsJson = JSON.stringify(withTools.flatMap((t) => t.tools));
  expect(allToolsJson.includes(KNOWN) || allToolsJson.includes("field-notes"), "persisted tool result lacks the hit");

  // 6. Rename.
  r = await post(primary.base, `/sessions/${idA}/rename`, { title: "Restaurant QR SaaS Architecture" });
  expect(r.status === 200 && r.body.session.title === "Restaurant QR SaaS Architecture", "rename failed");
  note("6. rename", { title: r.body.session.title });

  // 7-10. RELOAD: brand-new runtime + server on the SAME database files.
  await shutdown(primary);
  primary = await boot();
  s = await get(primary.base, `/sessions/${idA}`);
  expect(s.status === 200, "session missing after reload");
  const after = s.body.session;
  const turnsAfter = await get(primary.base, `/sessions/${idA}/turns?limit=100`);
  const withToolsAfter = turnsAfter.body.turns.filter((t) => Array.isArray(t.tools) && t.tools.length > 0);
  const active = await get(primary.base, "/sessions/active");
  note("7-9. reload restoration", {
    sameId: after.id === idA,
    title: after.title,
    summary: after.summary ?? null,
    turns: turnsAfter.body.turns.length,
    turnsWithTools: withToolsAfter.length,
    activeSessionId: active.body.session?.id ?? null,
  });
  expect(after.id === idA, "id changed across reload");
  expect(after.title === "Restaurant QR SaaS Architecture", "rename did not survive reload");
  expect(after.summary?.objective?.length > 0, "summary missing after reload");
  expect(turnsAfter.body.turns.length >= 8, `transcript shrank: ${turnsAfter.body.turns.length}`);
  expect(withToolsAfter.length > 0, "tool records lost across reload");
  expect(active.body.session?.id === idA, "active session not restored");

  // 10. Search finds it (`{hits: [{session, matched, turn?}]}`).
  r = await get(primary.base, `/sessions/search?query=${encodeURIComponent("Restaurant QR")}`);
  const hits = r.body.hits ?? r.body.sessions ?? [];
  const hitIds = hits.map((h) => h.session?.id ?? h.id);
  expect(r.status === 200 && hitIds.includes(idA), `search missed: ${JSON.stringify(r.body).slice(0, 300)}`);
  note("10. search finds it", { hits: hits.length, matched: hits.find((h) => (h.session?.id ?? h.id) === idA)?.matched });

  // Continue contextually after reload (summary + recent turns compose the prompt).
  r = await post(primary.base, "/chat", { text: "What persistence did we decide on?", conversation_id: idA });
  expect(r.status === 200 && r.body.conversation_id === idA, "post-reload turn failed");
  note("resume turn", { reply: String(r.body.reply).slice(0, 300) });

  // 11-12. Delete + gone. Delete is DESTRUCTIVE, so Core parks it (409) and
  // the E2E approves it like the UI Allow button would — proving the park →
  // approve → execute path live too.
  r = await post(primary.base, `/sessions/${idA}/delete`, {});
  let approvalFlow = "direct";
  if (r.status === 409 && r.body.approvalId) {
    approvalFlow = `parked(${r.body.approvalId})->approved`;
    const decided = await post(primary.base, `/approvals/${r.body.approvalId}/decide`, { approved: true });
    expect(decided.status === 200, `decide failed: ${decided.status} ${JSON.stringify(decided.body).slice(0, 200)}`);
    // The verdict re-issues the parked delete; poll until it lands.
    const deadline = Date.now() + 15_000;
    for (;;) {
      s = await get(primary.base, `/sessions/${idA}`);
      if (s.status === 404) break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  expect(r.status === 200 || r.status === 409, `delete failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  s = await get(primary.base, `/sessions/${idA}`);
  const list = await get(primary.base, "/sessions");
  note("11-12. delete + gone", {
    approvalFlow,
    getStatus: s.status,
    stillListed: (list.body.sessions ?? []).some((x) => x.id === idA),
    activeAfterDelete: list.body.activeSessionId ?? null,
  });
  expect(s.status === 404, "deleted session still readable");
  expect(!(list.body.sessions ?? []).some((x) => x.id === idA), "deleted session still listed");

  // 13-15. Two sessions, switch, isolation.
  const b = await post(primary.base, "/sessions", { title: "Beta" });
  const c = await post(primary.base, "/sessions", { title: "Gamma" });
  const idB = b.body.session.id;
  const idC = c.body.session.id;
  await post(primary.base, "/chat", { text: "beta talks about sailing", conversation_id: idB });
  await post(primary.base, "/chat", { text: "gamma talks about cooking", conversation_id: idC });
  let sw = await post(primary.base, `/sessions/${idB}/activate`, {});
  expect(sw.status === 200, "activate B failed");
  const tb = await get(primary.base, `/sessions/${idB}/turns?limit=100`);
  const tc = await get(primary.base, `/sessions/${idC}/turns?limit=100`);
  const activeNow = await get(primary.base, "/sessions/active");
  note("13-15. switch + isolation", {
    idB, idC,
    active: activeNow.body.session?.id,
    betaTurns: tb.body.turns.map((t) => t.text.slice(0, 40)),
    gammaTurns: tc.body.turns.map((t) => t.text.slice(0, 40)),
  });
  expect(activeNow.body.session?.id === idB, "switch did not move the pointer");
  expect(tb.body.turns.every((t) => !t.text.includes("cooking")), "beta transcript polluted");
  expect(tc.body.turns.every((t) => !t.text.includes("sailing")), "gamma transcript polluted");

  if (process.exitCode !== 1) {
    evidence.verdict = "PASS: all 15 E2E steps verified against a real Core + real model";
    console.log("\nE2E PASS");
  }
} catch (e) {
  if (process.exitCode !== 1) fail(String(e));
} finally {
  for (const h of [...servers]) {
    try {
      await shutdown(h);
    } catch {
      // Shutdown is best-effort after a failure.
    }
  }
  try {
    const { writeFileSync: write } = await import("node:fs");
    write(join(CORE, "..", "docs", "evidence", "session-e2e-live.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log("evidence written to docs/evidence/session-e2e-live.json");
  } catch (e) {
    console.error(`could not write evidence: ${String(e)}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Per-subagent memory isolation — the adversarial proof (A–F + negatives).
 *
 * KAI's memory authority is ONE canonical store. A subagent's private facts
 * (`scope: "subagent"`, `scopeId: <persona>`) are unreachable from another
 * persona by default. The ONLY way one persona's fact reaches another is an
 * explicit, governed share (`memory/shares.ts`): a POINTER to exactly one entry,
 * from one persona to one persona, minted only under a real KAI approval.
 *
 * This file pins the whole property, deterministically (mock agents, a temp
 * SQLite file, no network), so a later change to recall, sharing or the policy
 * boundary cannot silently reopen a leak:
 *
 *   A  a private write is private: the author recalls it, a neighbour cannot.
 *   B  the non-leak reaches the COMPOSED PROMPT: `subagent:<other>` never carries
 *      another persona's private fact into a turn.
 *   C  a governed share names ONE entry and parks for a human; nothing is granted
 *      while parked.
 *   D  after the human approval the recipient recalls the shared fact — and ONLY
 *      the explicitly shared item, never the rest of the source's bucket.
 *   E  a private write made AFTER the grant does not follow the share.
 *   F  a real restart (new Core over the SAME files) keeps A's private facts,
 *      keeps the grant exactly as narrow, and keeps B locked out of what was not
 *      shared.
 *   N  the negatives: no approval, foreign approval, unknown ids, non-private
 *      entry, same-subagent share, duplicate, revoked, stale/expired, and
 *      session/cross-subagent leakage.
 *
 *   cd core && node --test tests/subagent-memory-isolation.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi, type CoreApi } from "../src/api/routes.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const SHARED = "The unique marker ALPHA_SECRET belongs to persona Alpha private ledger.";
const PRIVATE_2 = "The second private marker ALPHA_PRIVATE_2 lives only in persona Alpha ledger.";
const PRIVATE_3 = "The later private marker ALPHA_PRIVATE_3 was written after the grant.";
const ALPHA_ONLY = "Persona Alpha alone knows the word ZEPHYRQUARTZ.";
const SESSION_FACT = "This session-only marker SESSIONONLY belongs to a conversation thread.";

/** A query whose tokens match every Alpha fact above — so a hit proves access. */
const QUERY = "unique marker persona alpha";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `kai-subagent-mem-${name}-`));
}

function boot(dbPath: string): ReturnType<typeof createCoreRuntime> {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

async function definePersona(rt: ReturnType<typeof createCoreRuntime>, id: string): Promise<void> {
  const res = await rt.tools.invoke("workforce.subagent", {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    role: "researcher",
    soul: "cites everything",
    workerId: "hermes",
    capabilities: ["filesystem"],
  });
  assert.equal((res as { ok?: boolean }).ok, true, `defining persona ${id} failed: ${JSON.stringify(res)}`);
}

function post(api: CoreApi, path: string, body: unknown) {
  return api.handle({ method: "POST", path, query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body });
}

function get(api: CoreApi, path: string, q: Record<string, string>) {
  return api.handle({ method: "GET", path, query: new URLSearchParams(q), body: null });
}

/** Write a subagent-private fact through the real route; return its entry id. */
async function writePrivate(
  api: CoreApi,
  scopeId: string,
  content: string,
): Promise<string> {
  const res = await post(api, "/memory/write", {
    content,
    type: "project_fact",
    importance: 4,
    scope: "subagent",
    scopeId,
  });
  assert.equal(res.status, 201, `private write refused: ${JSON.stringify(res.body)}`);
  return (res.body as { memory: { id: string } }).memory.id;
}

function contents(hits: ReadonlyArray<{ entry: { content: string } }>): string[] {
  return hits.map((hit) => hit.entry.content);
}

/**
 * Drive the REAL park -> decide -> re-issue flow for a share and return the
 * granted share record. A share is a security-relevant WRITE that is not in
 * KAI's internal-state list, so it parks by default — that IS the gate.
 */
async function grantShare(
  api: CoreApi,
  rt: ReturnType<typeof createCoreRuntime>,
  input: { fromSubagent: string; toSubagent: string; entryId: string },
): Promise<{ id: string; approvalId: string }> {
  const first = await post(api, "/memory/share", input);
  assert.equal(first.status, 409, `a share must park for a human: ${JSON.stringify(first.body)}`);
  const approvalId = (first.body as { approvalId: string }).approvalId;
  assert.ok(typeof approvalId === "string" && approvalId.length > 0, "the parked share hands back an approval id");
  const decided = await post(api, `/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  // OPTION A: the VERDICT is the one dispatch this approval authorises — `reissueParked`
  // re-issues the exact parked call — so the granted share comes back on the verdict.
  // Re-posting with the same approval id would be a second dispatch, which the registry
  // now refuses (correctly).
  let share = (decided.body as { result?: { share?: { id: string } } }).result?.share;
  if (share === undefined) {
    // A share parked outside the registry's re-issue path still makes its own call; its
    // approval is unspent, so exactly one dispatch happens either way.
    const granted = await post(api, "/memory/share", { ...input, approvalId });
    assert.equal(granted.status, 201, `the approved share must grant: ${JSON.stringify(granted.body)}`);
    share = (granted.body as { share: { id: string } }).share;
  }
  return { id: share.id, approvalId };
}

// ── A + B: a private write is private, and the leak stops at the prompt ───────

test("A/B: a subagent-private fact is recalled by its author and NEVER by a neighbour, in search or in the composed prompt", async (t) => {
  const dir = tempDir("ab");
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await rt.start();
  const api = createCoreApi(rt);
  await definePersona(rt, "alpha");
  await definePersona(rt, "bravo");

  const entryId = await writePrivate(api, "alpha", SHARED);

  // A recalls its own fact; B does not (runtime level).
  assert.deepEqual(contents(rt.recallForSubagent("alpha", { text: QUERY })), [SHARED]);
  assert.deepEqual(contents(rt.recallForSubagent("bravo", { text: QUERY })), [], "B must not recall A's private fact");

  // The same holds through the route B actually calls.
  const bSearch = await get(api, "/memory/search", { q: QUERY, scope: "subagent", scopeId: "bravo" });
  assert.equal(bSearch.status, 200);
  assert.deepEqual(contents((bSearch.body as { hits: unknown[] }).hits as never), []);
  const aSearch = await get(api, "/memory/search", { q: QUERY, scope: "subagent", scopeId: "alpha" });
  assert.equal(aSearch.status, 200);
  assert.equal((aSearch.body as { hits: unknown[] }).hits.length, 1);

  // B: the non-leak reaches the COMPOSED PROMPT. This is the whole point — a
  // recall that "works" in a test but leaks into a turn would still be a leak.
  const request = "what is the unique marker for persona alpha";
  const composedB = await rt.composeTurnPrompt(request, { scope: "subagent:bravo" });
  assert.ok(!composedB.text.includes("ALPHA_SECRET"), "B's composed prompt must not carry A's private fact");
  const composedA = await rt.composeTurnPrompt(request, { scope: "subagent:alpha" });
  assert.ok(composedA.text.includes("ALPHA_SECRET"), "A's own composed prompt recalls its private fact");

  // A write into a persona that does not exist is refused, not orphaned.
  const ghostWrite = rt.rememberForSubagent("ghost", { content: "orphan" });
  assert.equal(ghostWrite.ok, false, "a fact scoped to an unknown persona is unreachable and must be refused");

  assert.ok(entryId.length > 0);
});

// ── C + D: a governed share names ONE entry, and only after the human says yes ─

test("C/D: a share parks for a human, then grants EXACTLY the named entry to the named recipient — and nothing else", async (t) => {
  const dir = tempDir("cd");
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await rt.start();
  const api = createCoreApi(rt);
  await definePersona(rt, "alpha");
  await definePersona(rt, "bravo");

  // Alpha holds TWO private facts. Only one will ever be shared.
  const sharedId = await writePrivate(api, "alpha", SHARED);
  const privateId = await writePrivate(api, "alpha", PRIVATE_2);

  // C: the first call parks; nothing is granted while parked.
  const first = await post(api, "/memory/share", { fromSubagent: "alpha", toSubagent: "bravo", entryId: sharedId });
  assert.equal(first.status, 409, JSON.stringify(first.body));
  assert.equal((first.body as { approvalRequired: boolean }).approvalRequired, true);
  const approvalId = (first.body as { approvalId: string }).approvalId;
  assert.ok(approvalId.startsWith("apr_"), `the parked share names a real approval: ${approvalId}`);
  assert.equal(rt.subagentMemoryShares.list().length, 0, "a parked share grants NOTHING");
  const card = rt.approvals.list({ status: "PENDING" }).find((a) => a.id === approvalId);
  assert.ok(card, "a real pending approval exists");
  assert.equal(card!.toolId, "memory.share", "the card is bound to the share tool");
  assert.equal(rt.recallForSubagent("bravo", { text: QUERY }).length, 0, "B still has nothing while parked");

  // Decide it, then re-issue with the id.
  assert.equal((await post(api, `/approvals/${approvalId}/decide`, { approved: true })).status, 200);
  const granted = await post(api, "/memory/share", { fromSubagent: "alpha", toSubagent: "bravo", entryId: sharedId, approvalId });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  const share = (granted.body as { share: { id: string; fromSubagent: string; toSubagent: string; entryId: string; approvalId: string } }).share;
  // C: the grant is SPECIFIC — one sender, one recipient, one entry, a real approval.
  assert.equal(share.fromSubagent, "alpha");
  assert.equal(share.toSubagent, "bravo");
  assert.equal(share.entryId, sharedId);
  assert.equal(share.approvalId, approvalId);
  assert.equal(rt.subagentMemoryShares.list().length, 1, "exactly one grant exists");

  // D: B can now recall the shared fact…
  assert.deepEqual(contents(rt.recallForSubagent("bravo", { text: QUERY })), [SHARED]);
  // …and ONLY it. A browse of everything shared to B is exactly the one entry;
  // A's second private fact is not reachable.
  assert.deepEqual(contents(rt.recallForSubagent("bravo")), [SHARED], "only the explicitly shared item is visible");
  assert.ok(!contents(rt.recallForSubagent("bravo")).includes(PRIVATE_2), "the unshared neighbour fact must not leak");
  // The route agrees.
  const bSearch = await get(api, "/memory/search", { q: QUERY, scope: "subagent", scopeId: "bravo" });
  assert.deepEqual(contents((bSearch.body as { hits: unknown[] }).hits as never), [SHARED]);

  // The share is a POINTER, not a copy: the fact still lives in Alpha's bucket.
  assert.equal(rt.memoryEngine.get(sharedId)?.scopeId, "alpha", "the shared fact never left Alpha's bucket");
  assert.equal(rt.memoryEngine.get(privateId)?.scopeId, "alpha");
  // Alpha still recalls both of its own facts.
  assert.deepEqual(new Set(contents(rt.recallForSubagent("alpha", { text: QUERY }))), new Set([SHARED, PRIVATE_2]));
});

// ── E: a private write made after the grant does not follow the share ─────────

test("E: a fact Alpha writes AFTER the grant does not reach Bravo", async (t) => {
  const dir = tempDir("e");
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await rt.start();
  const api = createCoreApi(rt);
  await definePersona(rt, "alpha");
  await definePersona(rt, "bravo");

  const sharedId = await writePrivate(api, "alpha", SHARED);
  await grantShare(api, rt, { fromSubagent: "alpha", toSubagent: "bravo", entryId: sharedId });
  assert.deepEqual(contents(rt.recallForSubagent("bravo")), [SHARED]);

  // A writes a NEW private fact after the grant.
  await writePrivate(api, "alpha", PRIVATE_3);

  // The grant did not widen: B still sees exactly the one shared entry.
  assert.deepEqual(contents(rt.recallForSubagent("bravo")), [SHARED], "a post-grant private write must not follow the share");
  assert.ok(!contents(rt.recallForSubagent("bravo")).includes(PRIVATE_3));
  assert.equal(rt.subagentMemoryShares.list().length, 1, "no implicit second grant appeared");
  // Alpha can still recall the new fact itself.
  assert.ok(contents(rt.recallForSubagent("alpha", { text: "later private marker" })).includes(PRIVATE_3));
});

// ── F: a real restart keeps A's private facts, the grant, and the boundary ────

test("F: after a real Core restart, A's private facts survive, the shared fact stays shared, and the unshared stays private", async (t) => {
  const dir = tempDir("f");
  const dbPath = join(dir, "kai.db");

  let rt = boot(dbPath);
  await rt.start();
  let api = createCoreApi(rt);
  await definePersona(rt, "alpha");
  await definePersona(rt, "bravo");

  const sharedId = await writePrivate(api, "alpha", SHARED);
  const privateId = await writePrivate(api, "alpha", PRIVATE_2);
  await grantShare(api, rt, { fromSubagent: "alpha", toSubagent: "bravo", entryId: sharedId });

  // Before restart: the baseline.
  assert.deepEqual(contents(rt.recallForSubagent("bravo")), [SHARED]);
  await rt.stop();

  // RESTART: a brand-new Core over the SAME database and the SAME JSON files.
  rt = boot(dbPath);
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await rt.start();
  api = createCoreApi(rt);

  // Personas reloaded from `kai-subagents.json`.
  assert.deepEqual(new Set(rt.subagents.list().map((s) => s.spec.id)), new Set(["alpha", "bravo"]));

  // A's private memory survived the restart (same database file).
  assert.deepEqual(new Set(contents(rt.recallForSubagent("alpha", { text: QUERY }))), new Set([SHARED, PRIVATE_2]));
  // The grant survived (same shares JSON) and stays exactly as narrow.
  assert.equal(rt.subagentMemoryShares.list().length, 1, "the grant survives a restart");
  assert.equal(rt.subagentMemoryShares.list()[0]!.entryId, sharedId);
  assert.deepEqual(contents(rt.recallForSubagent("bravo")), [SHARED], "the shared fact remains shared after restart");
  assert.ok(!contents(rt.recallForSubagent("bravo")).includes(PRIVATE_2), "the unshared fact remains private after restart");
  // And the route B calls agrees after restart.
  const bSearch = await get(api, "/memory/search", { q: QUERY, scope: "subagent", scopeId: "bravo" });
  assert.deepEqual(contents((bSearch.body as { hits: unknown[] }).hits as never), [SHARED]);
  assert.equal(rt.memoryEngine.get(privateId)?.scopeId, "alpha", "the unshared fact still lives only in Alpha's bucket");
});

// ── Negatives: the runtime share boundary is fail-closed ──────────────────────

test("N(runtime): no-approval, unknown ids, a non-private entry, and a same-subagent share are all refused", async (t) => {
  const dir = tempDir("n-runtime");
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await rt.start();
  const api = createCoreApi(rt);
  await definePersona(rt, "alpha");
  await definePersona(rt, "bravo");

  const alphaId = await writePrivate(api, "alpha", SHARED);
  const bravoId = await writePrivate(api, "bravo", "Bravo's own private fact BRAVOKEEP.");
  const globalRes = await post(api, "/memory/write", { content: "A global fact every persona may read GLOBALFACT." });
  assert.equal(globalRes.status, 201);
  const globalId = (globalRes.body as { memory: { id: string } }).memory.id;

  // Empty approval id: the whole point of the gate. Refused, nothing granted.
  const empty = rt.shareSubagentMemory({ fromSubagent: "alpha", entryId: alphaId, toSubagent: "bravo", approvalId: "" });
  assert.equal(empty.ok, false);
  assert.match((empty as { reason: string }).reason, /approval/i);
  assert.equal(rt.subagentMemoryShares.list().length, 0);

  // Unknown recipient.
  const ghostTo = rt.shareSubagentMemory({ fromSubagent: "alpha", entryId: alphaId, toSubagent: "ghost", approvalId: "apr_x" });
  assert.equal(ghostTo.ok, false);
  assert.match((ghostTo as { reason: string }).reason, /ghost/);

  // Unknown sender.
  const ghostFrom = rt.shareSubagentMemory({ fromSubagent: "ghost", entryId: alphaId, toSubagent: "bravo", approvalId: "apr_x" });
  assert.equal(ghostFrom.ok, false);
  assert.match((ghostFrom as { reason: string }).reason, /ghost/);

  // A share must cross subagents.
  const same = rt.shareSubagentMemory({ fromSubagent: "alpha", entryId: alphaId, toSubagent: "alpha", approvalId: "apr_x" });
  assert.equal(same.ok, false);
  assert.match((same as { reason: string }).reason, /cross subagents/);

  // Unknown entry id.
  const noEntry = rt.shareSubagentMemory({ fromSubagent: "alpha", entryId: "mem_nope", toSubagent: "bravo", approvalId: "apr_x" });
  assert.equal(noEntry.ok, false);
  assert.match((noEntry as { reason: string }).reason, /no memory entry/);

  // A global entry is not private to anyone — a share cannot move it.
  const fromGlobal = rt.shareSubagentMemory({ fromSubagent: "alpha", entryId: globalId, toSubagent: "bravo", approvalId: "apr_x" });
  assert.equal(fromGlobal.ok, false);
  assert.match((fromGlobal as { reason: string }).reason, /not private to subagent "alpha"/);

  // A's claim on B's entry is false — refused.
  const steal = rt.shareSubagentMemory({ fromSubagent: "alpha", entryId: bravoId, toSubagent: "bravo", approvalId: "apr_x" });
  assert.equal(steal.ok, false);
  assert.match((steal as { reason: string }).reason, /not private to subagent "alpha"/);

  assert.equal(rt.subagentMemoryShares.list().length, 0, "no negative case minted a grant");
});

// ── Negatives: approval binding at the real route/tool boundary ───────────────

test("N(approval): an approval for another tool, an unknown approval, and a rejected approval all fail to authorise a share", async (t) => {
  const dir = tempDir("n-approval");
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await rt.start();
  const api = createCoreApi(rt);
  await definePersona(rt, "alpha");
  await definePersona(rt, "bravo");
  const alphaId = await writePrivate(api, "alpha", SHARED);

  // Foreign approval: a real APPROVED approval, but bound to a DIFFERENT tool.
  const foreign = rt.approvals.request({ toolId: "memory.write", action: "Write a memory", reason: "unrelated", risk: "WRITE" });
  rt.approvals.decide(foreign.id, true);
  const crossed = await post(api, "/memory/share", { fromSubagent: "alpha", toSubagent: "bravo", entryId: alphaId, approvalId: foreign.id });
  assert.equal(crossed.status, 403, JSON.stringify(crossed.body));
  assert.match((crossed.body as { reason: string }).reason, /does not authorise/);
  assert.equal(rt.subagentMemoryShares.list().length, 0);

  // Unknown approval id.
  const unknown = await post(api, "/memory/share", { fromSubagent: "alpha", toSubagent: "bravo", entryId: alphaId, approvalId: "apr_ghost" });
  assert.equal(unknown.status, 409, JSON.stringify(unknown.body));
  assert.match((unknown.body as { reason: string }).reason, /unknown/);

  // A rejected approval cannot authorise anything.
  const parked = await post(api, "/memory/share", { fromSubagent: "alpha", toSubagent: "bravo", entryId: alphaId });
  assert.equal(parked.status, 409);
  const rejId = (parked.body as { approvalId: string }).approvalId;
  assert.equal((await post(api, `/approvals/${rejId}/decide`, { approved: false })).status, 200);
  const afterReject = await post(api, "/memory/share", { fromSubagent: "alpha", toSubagent: "bravo", entryId: alphaId, approvalId: rejId });
  assert.equal(afterReject.status, 403, JSON.stringify(afterReject.body));
  assert.match((afterReject.body as { reason: string }).reason, /rejected/);

  assert.equal(rt.subagentMemoryShares.list().length, 0, "no rejected/crossed approval minted a grant");
});

// ── Negatives: duplicate, revoked, stale — and session/cross-subagent leakage ─

test("N(lifecycle): a duplicate share dedupes, a revoked share removes access, and a stale (expired) share grants nothing", async (t) => {
  const dir = tempDir("n-lifecycle");
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await rt.start();
  const api = createCoreApi(rt);
  await definePersona(rt, "alpha");
  await definePersona(rt, "bravo");

  const sharedId = await writePrivate(api, "alpha", SHARED);
  const { id: shareId, approvalId } = await grantShare(api, rt, { fromSubagent: "alpha", toSubagent: "bravo", entryId: sharedId });

  // Duplicate: re-issuing the same (from, entry, to) does not create a second grant.
  const dupRoute = await post(api, "/memory/share", { fromSubagent: "alpha", toSubagent: "bravo", entryId: sharedId, approvalId });
  assert.equal(dupRoute.status, 201);
  assert.equal((dupRoute.body as { share: { id: string } }).share.id, shareId, "the duplicate returns the SAME share");
  const dupRuntime = rt.shareSubagentMemory({ fromSubagent: "alpha", entryId: sharedId, toSubagent: "bravo", approvalId: "apr_other" });
  assert.equal(dupRuntime.ok, true);
  assert.equal((dupRuntime as { share: { id: string } }).share.id, shareId);
  assert.equal(rt.subagentMemoryShares.list().length, 1, "dedup keeps exactly one grant");

  // Revoked: after revoke the recipient loses access (the pointer is gone).
  assert.equal(rt.subagentMemoryShares.revoke(shareId), true);
  assert.equal(rt.subagentMemoryShares.list().length, 0);
  assert.deepEqual(contents(rt.recallForSubagent("bravo", { text: QUERY })), [], "a revoked share grants nothing");
  assert.equal(rt.subagentMemoryShares.revoke(shareId), false, "revoking twice is a no-op, not an error");

  // Stale: an entry already past its `until` is inactive; a share of it grants nothing.
  const past = new Date(Date.now() - 60_000).toISOString();
  const staleWrite = rt.memoryEngine.write({ content: "A stale marker STALEFACT that has already expired.", scope: "subagent", scopeId: "alpha", until: past });
  assert.equal(staleWrite.ok, true);
  const staleId = (staleWrite as { entry: { id: string } }).entry.id;
  const staleGrant = rt.shareSubagentMemory({ fromSubagent: "alpha", entryId: staleId, toSubagent: "bravo", approvalId: "apr_x" });
  assert.equal(staleGrant.ok, true, "the pointer is granted, but recall must still exclude an expired fact");
  assert.deepEqual(contents(rt.recallForSubagent("bravo", { text: "stale marker" })), [], "an expired shared fact is never recalled");
  assert.equal(rt.subagentMemoryShares.list().length, 1);
});

test("N(leakage): global facts reach every persona, but session and other personas' buckets never do", async (t) => {
  const dir = tempDir("n-leakage");
  const rt = boot(join(dir, "kai.db"));
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await rt.start();
  const api = createCoreApi(rt);
  await definePersona(rt, "alpha");
  await definePersona(rt, "bravo");

  // A global fact (shared) and a session-scoped fact (private to the session).
  const globalRes = await post(api, "/memory/write", { content: "Every persona may read this global fact GLOBALFACT." });
  assert.equal(globalRes.status, 201);
  // The session entry is written at the engine level: a subagent recall must
  // never pick it up regardless of how the session scope was populated.
  const sessionWrite = rt.memoryEngine.write({ content: SESSION_FACT, scope: "session", scopeId: "sess-1" });
  assert.equal(sessionWrite.ok, true);
  const alphaOnlyId = await writePrivate(api, "alpha", ALPHA_ONLY);

  const alphaRecall = contents(rt.recallForSubagent("alpha", { text: "fact" }));
  // Global is readable by everyone…
  assert.ok(alphaRecall.some((c) => c.includes("GLOBALFACT")), "a global fact is shared");
  // …but a session fact is NOT pulled into a subagent's recall (session leakage).
  assert.ok(!alphaRecall.some((c) => c.includes("SESSIONONLY")), "session-scoped memory must not leak into a subagent");
  // And another persona's private fact never appears (cross-subagent leakage).
  const bravoRecall = contents(rt.recallForSubagent("bravo", { text: "fact" }));
  assert.ok(!bravoRecall.some((c) => c.includes("ZEPHYRQUARTZ")), "A's private fact must not leak to B");
  assert.ok(bravoRecall.some((c) => c.includes("GLOBALFACT")), "B still reads global facts");
  // Alpha's own private fact is visible to alpha.
  assert.ok(contents(rt.recallForSubagent("alpha", { text: "ZEPHYRQUARTZ" })).includes(ALPHA_ONLY));
  assert.ok(alphaOnlyId.length > 0);
});

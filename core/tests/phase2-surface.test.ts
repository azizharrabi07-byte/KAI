// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Phase 2 HTTP surface — WIRING tests (src/api/routes.ts).
 *
 * These do NOT re-test the subsystems (memory, prompts, skills, learning each
 * have their own suites). They prove four things the routing layer is responsible
 * for, end to end through a real CoreRuntime over a real (temp) database:
 *
 *   (a) a fact POSTed to the memory route is searchable back AND survives a
 *       runtime restart over the same database file (the M1/M2 mechanism);
 *   (b) the composed prompt really is the pipeline's output — sections in the
 *       ONE contract order, and relevance filtering is real (the relevant fact is
 *       recalled into it, an irrelevant one is not);
 *   (c) the staged-skill install REFUSES when the staged bytes changed after the
 *       approval (SHA-256 binding);
 *   (d) a route that needs approval returns 409 {approvalRequired, approvalId}
 *       and does NOT act, and re-issuing with the id after a human decides does.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi } from "../src/api/routes.ts";
import type { CoreApi } from "../src/api/routes.ts";
import { SECTION_ORDER } from "../src/prompts/index.ts";

// ── Harness ────────────────────────────────────────────────────────────────────

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-phase2-surface-"));
}

/** A Core with mock agents, no scheduler timer and no startup upkeep: fast + quiet. */
function boot(dbPath: string) {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

function post(api: CoreApi, path: string, body: unknown) {
  return api.handle({ method: "POST", path, query: new URLSearchParams(), body });
}

function get(api: CoreApi, path: string, q?: Record<string, string>) {
  return api.handle({ method: "GET", path, query: new URLSearchParams(q ?? {}) });
}

const RELEVANT_FACT = "The KAI phase two release codename is falcon.";
const IRRELEVANT_FACT = "Coffee beans arrive Thursday.";

/**
 * Stage a skill through the real learning route (a repeated workflow becomes a
 * skill CANDIDATE that is staged, never installed). Returns what the caller needs
 * to drive approve/install.
 */
async function stageSkill(api: CoreApi): Promise<{ stagedId: string; sha256: string; skillId: string }> {
  const resp = await post(api, "/learning/propose", {
    kind: "repeated_workflow",
    summary: "nightly deploy",
    steps: ["git fetch origin", "git build the release", "git ship the release"],
    repeatCount: 3,
  });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  const outcome = (resp.body as { outcome: any }).outcome;
  assert.equal(outcome.decision, "skill", JSON.stringify(outcome));
  assert.equal(outcome.skill?.staged, true, JSON.stringify(outcome));
  return { stagedId: outcome.skill.stagedId, sha256: outcome.skill.sha256, skillId: outcome.skill.skillId };
}

// ── (a) memory persists across a runtime restart ───────────────────────────────

test("(a) a memory written over the route is searchable and survives a runtime restart", async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, "kai.db");
  let runtime2: ReturnType<typeof boot> | undefined;
  t.after(async () => {
    if (runtime2 !== undefined) await runtime2.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const runtime1 = boot(dbPath);
  const api1 = createCoreApi(runtime1);

  const created = await post(api1, "/memory/write", {
    content: RELEVANT_FACT,
    type: "project_fact",
    importance: 5,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = (created.body as { memory: { id: string } }).memory.id;

  // Search it back, and read it back by id.
  const found = await get(api1, "/memory/search", { q: "falcon" });
  assert.equal(found.status, 200);
  const hits = (found.body as { hits: Array<{ entry: { id: string; content: string } }> }).hits;
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0]!.entry.id, id);
  assert.equal(hits[0]!.entry.content, RELEVANT_FACT);

  const read = await get(api1, `/memory/${id}`);
  assert.equal(read.status, 200);
  assert.equal((read.body as { memory: { content: string } }).memory.content, RELEVANT_FACT);

  // Restart: stop this Core, then build a NEW one over the SAME database file.
  await runtime1.stop();

  runtime2 = boot(dbPath);
  const api2 = createCoreApi(runtime2);

  const found2 = await get(api2, "/memory/search", { q: "falcon" });
  assert.equal(found2.status, 200);
  const hits2 = (found2.body as { hits: Array<{ entry: { id: string; content: string } }> }).hits;
  assert.equal(hits2.length, 1, JSON.stringify(hits2));
  assert.equal(hits2[0]!.entry.id, id);
  assert.equal(hits2[0]!.entry.content, RELEVANT_FACT);
});

// ── (b) the composed prompt is the pipeline's output, with real recall ─────────

test("(b) the composed prompt is ordered by SECTION_ORDER and recalls the relevant fact only", async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  // Two facts: one the request ("falcon") is about, one it is not.
  assert.equal((await post(api, "/memory/write", { content: RELEVANT_FACT, type: "project_fact", importance: 4 })).status, 201);
  assert.equal((await post(api, "/memory/write", { content: IRRELEVANT_FACT, type: "note", importance: 5 })).status, 201);

  const composed = await runtime.composeTurnPrompt("falcon");

  // Sections are emitted in the ONE contract order (a subsequence of SECTION_ORDER).
  const names = composed.sections.map((s) => s.name);
  assert.deepEqual(
    names,
    SECTION_ORDER.filter((n) => names.includes(n)),
    `sections out of order: ${names.join(", ")}`,
  );
  assert.ok(names.includes("safety"), "safety section missing");
  assert.ok(names.includes("memory"), "memory section missing");
  assert.ok(names.includes("request"), "request section missing");

  // The relevant fact IS recalled into the prompt; the irrelevant one is NOT.
  assert.ok(composed.text.includes("## Recalled memory"), composed.text);
  assert.ok(composed.text.includes(RELEVANT_FACT), "relevant fact was not recalled");
  assert.ok(!composed.text.includes(IRRELEVANT_FACT), "irrelevant fact leaked into the prompt");
});

// ── (c) staged install refuses tampered bytes ──────────────────────────────────

test("(c) the staged-skill install refuses when the staged bytes change after approval", async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  const { stagedId, sha256 } = await stageSkill(api);

  // Approve the exact bytes and have a human grant it.
  const approve = await post(api, `/skills/staging/${stagedId}/approve`, { sha256 });
  assert.equal(approve.status, 201, JSON.stringify(approve.body));
  const approvalId = (approve.body as { approvalId: string }).approvalId;
  const decided = await post(api, `/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));

  // Tamper with the staged bytes AFTER the approval was granted.
  const view = await get(api, `/skills/staging/${stagedId}`);
  assert.equal(view.status, 200);
  const stagedPath = (view.body as { staged: { path: string } }).staged.path;
  writeFileSync(
    join(stagedPath, "SKILL.md"),
    "---\nname: nightly-deploy\ndescription: swapped after approval\n---\n\nSomething the human never saw.\n",
  );

  const install = await post(api, `/skills/staging/${stagedId}/install`, { sha256, approvalId });
  assert.equal(install.status, 403, JSON.stringify(install.body));
  assert.match((install.body as { reason: string }).reason, /sha256|bytes/i);

  // Nothing was installed.
  const listed = await get(api, "/skills");
  const skills = (listed.body as { skills: Array<{ id: string }> }).skills;
  assert.ok(!skills.some((s) => s.id.startsWith("nightly-deploy")), JSON.stringify(skills));
});

// ── (d) the approval gate: 409 parks it, the id releases it ────────────────────

test("(d) a route needing approval returns 409 and does not act until re-issued with the id", async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  const { stagedId, sha256, skillId } = await stageSkill(api);
  const approve = await post(api, `/skills/staging/${stagedId}/approve`, { sha256 });
  assert.equal(approve.status, 201, JSON.stringify(approve.body));
  const approvalId = (approve.body as { approvalId: string }).approvalId;

  // First attempt: the approval is still PENDING, so the install is PARKED.
  const parked = await post(api, `/skills/staging/${stagedId}/install`, { sha256, approvalId });
  assert.equal(parked.status, 409, JSON.stringify(parked.body));
  assert.equal((parked.body as { approvalRequired: boolean }).approvalRequired, true);
  assert.equal((parked.body as { approvalId: string }).approvalId, approvalId);

  // The action did NOT happen.
  const before = await get(api, "/skills");
  const beforeSkills = (before.body as { skills: Array<{ id: string }> }).skills;
  assert.ok(!beforeSkills.some((s) => s.id === skillId), JSON.stringify(beforeSkills));

  // A human decides.
  const decided = await post(api, `/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((decided.body as { approval: { status: string } }).approval.status, "APPROVED");

  // Re-issuing the SAME request with the id now performs the install.
  const installed = await post(api, `/skills/staging/${stagedId}/install`, { sha256, approvalId });
  assert.equal(installed.status, 201, JSON.stringify(installed.body));
  assert.equal((installed.body as { install: { skillId: string } }).install.skillId, skillId);

  const after = await get(api, "/skills");
  const afterSkills = (after.body as { skills: Array<{ id: string }> }).skills;
  assert.ok(afterSkills.some((s) => s.id === skillId), JSON.stringify(afterSkills));
});

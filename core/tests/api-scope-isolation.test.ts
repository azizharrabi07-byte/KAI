// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * HTTP memory-scope isolation (Phase 2 Part H).
 *
 * A scoped fact must be recallable ONLY from the scope it was written into (plus
 * the shared global bucket). This drives that through the REAL HTTP surface over a
 * REAL runtime and a REAL database — not the engine in isolation — because the
 * guarantee is a property of the route + the runtime's scope resolution together.
 *
 * The decisive case is `project`: nothing in KAI mints a project id, so the
 * runtime must REFUSE the scope (400) rather than accept it into a bucket nothing
 * will ever recall. Pretending to honour a scope is the fake this test forbids.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi, type CoreApi } from "../src/api/routes.ts";
import { createMission } from "../src/missions/mission.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-scope-iso-"));
}

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

const FACT = "The falcon release is blocked on the approval queue.";

test("HTTP scope isolation: a mission-scoped fact is recallable only from its own mission", async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  // Two REAL missions: m1 owns the fact, m2 is a genuine second mission that must
  // see nothing. (A fake id would be refused rather than returning 0 hits.)
  const m1 = createMission({ title: "mission one" });
  const m2 = createMission({ title: "mission two" });
  runtime.stores.missions.upsertMission(m1);
  runtime.stores.missions.upsertMission(m2);

  // Write the fact into m1's mission scope through the route.
  const created = await post(api, "/memory/write", {
    content: FACT,
    type: "project_fact",
    importance: 4,
    scope: "mission",
    scopeId: m1.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // m2's scope: a different real mission -> 0 hits. No leak across missions.
  const m2hits = await get(api, "/memory/search", { q: "falcon", scope: "mission", scopeId: m2.id });
  assert.equal(m2hits.status, 200, JSON.stringify(m2hits.body));
  assert.equal((m2hits.body as { hits: unknown[] }).hits.length, 0, "m2 must not see m1's fact");

  // No scope at all -> the shared global bucket only -> 0 hits.
  const globalHits = await get(api, "/memory/search", { q: "falcon" });
  assert.equal(globalHits.status, 200, JSON.stringify(globalHits.body));
  assert.equal((globalHits.body as { hits: unknown[] }).hits.length, 0, "the fact is private, not global");

  // m1's scope -> exactly the one fact.
  const m1hits = await get(api, "/memory/search", { q: "falcon", scope: "mission", scopeId: m1.id });
  assert.equal(m1hits.status, 200, JSON.stringify(m1hits.body));
  const hits = (m1hits.body as { hits: Array<{ entry: { id: string; content: string } }> }).hits;
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0]!.entry.content, FACT);

  // The runtime agrees with the route.
  assert.equal(runtime.recallForMission(m1.id, { text: "falcon" }).length, 1);
  assert.equal(runtime.recallForMission(m2.id, { text: "falcon" }).length, 0);
});

test("HTTP scope isolation: a scope with no producer is REFUSED with 400, never silently accepted", async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  // `project` has no producer in this runtime: nothing mints a project id, so a
  // project-scoped fact would be unreachable. The write must be refused.
  const write = await post(api, "/memory/write", { content: FACT, scope: "project" });
  assert.equal(write.status, 400, JSON.stringify(write.body));
  assert.equal((write.body as { code: string }).code, "MEMORY_SCOPE_UNSUPPORTED");
  assert.match((write.body as { reason: string }).reason, /project/);

  // And nothing was written: a global search for the fact finds nothing.
  const search = await get(api, "/memory/search", { q: "falcon", scope: "project" });
  assert.equal(search.status, 400, JSON.stringify(search.body));

  const globalHits = await get(api, "/memory/search", { q: "falcon" });
  assert.equal((globalHits.body as { hits: unknown[] }).hits.length, 0, "the refused write wrote nothing");
});

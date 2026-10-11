// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Memory provenance — the omitted default and the HTTP boundary (FALSIFIED 1a).
 *
 * The canonical memory engine used to default an omitted `provenance`/`source`
 * to `user_statement`, so any writer that simply left the field out stored its
 * fact as user authority. `POST /memory/write` then passed a caller's own
 * `provenance` straight through. Both halves are pinned here:
 *
 *   - an omitted provenance stores the MOST RESTRICTIVE value (system_state),
 *     never user authority — the learning pipeline's `external` discipline;
 *   - a caller over HTTP cannot CLAIM `user_statement` (provenance or source):
 *     it is refused with a reason that names it, exactly as /learning/propose
 *     refuses `source: "user"`.
 *
 * Plain `node --test`, no network beyond loopback.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryStore } from "../src/storage/memoryStore.ts";
import { createMemoryEngine } from "../src/memory/index.ts";
import { createCoreApi } from "../src/api/routes.ts";
import { createCoreRuntime } from "../src/runtime.ts";

const BASE_ISO = "2026-01-02T03:04:05.000Z";

test("an omitted provenance stores the most restrictive value, never user authority", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-mem-prov-"));
  const store = openMemoryStore({ path: join(dir, "kai.db") });
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const engine = createMemoryEngine({
    store,
    now: () => new Date(BASE_ISO),
    idFactory: (() => {
      let n = 0;
      return () => `m${n++}`;
    })(),
  });

  const written = engine.write({ content: "the staging host is db.internal" });
  assert.equal(written.ok, true, written.ok ? "" : written.refusal.detail);
  if (!written.ok) return;
  assert.equal(
    written.entry.provenance,
    "system_state",
    "an omitted provenance must default to the restrictive value, not user authority",
  );
  assert.equal(written.entry.source, "system_state", "the coarse source agrees with the provenance");
  assert.notEqual(written.entry.provenance, "user_statement");

  // An EXPLICIT provenance is still honoured: the discipline is about the
  // DEFAULT, not about refusing every value a host-supplied caller passes.
  const explicit = engine.write({ content: "a model-proposed fact", provenance: "model_candidate" });
  assert.equal(explicit.ok, true, explicit.ok ? "" : explicit.refusal.detail);
  assert.equal(explicit.ok && explicit.entry.provenance, "model_candidate");
});

test("POST /memory/write refuses a caller-claimed user provenance and defaults omitted provenance restrictively", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-mem-prov-http-"));
  const runtime = createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);
  const post = (body: unknown) =>
    api.handle({ method: "POST", path: "/memory/write", query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body });

  // 1. Claiming user provenance is refused outright, with the reason named.
  const claimedProvenance = await post({ content: "claimed as the user", provenance: "user_statement" });
  assert.equal(claimedProvenance.status, 400, JSON.stringify(claimedProvenance.body));
  assert.match(
    (claimedProvenance.body as { reason: string }).reason,
    /user_statement/,
    "the refusal names what was claimed",
  );

  // 2. The coarse source is user authority too, and is refused the same way.
  const claimedSource = await post({ content: "claimed as the user too", source: "user_statement" });
  assert.equal(claimedSource.status, 400, JSON.stringify(claimedSource.body));

  // 3. No provenance at all: stored, but with the restrictive default.
  const omitted = await post({ content: "an external fact with no provenance" });
  assert.equal(omitted.status, 201, JSON.stringify(omitted.body));
  const entry = (omitted.body as { memory: { provenance: string; source: string } }).memory;
  assert.equal(entry.provenance, "system_state");
  assert.equal(entry.source, "system_state");

  // 4. The refused writes stored nothing: no fact is user authority.
  assert.equal(
    runtime.memoryEngine.search({ text: "claimed as the user" }).length,
    0,
    "a refused write must not be persisted",
  );
});

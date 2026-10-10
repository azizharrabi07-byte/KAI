// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Migration v4 → v5: the goal linkage on `work_items`.
 *
 * The rest of the suite proves the CURRENT schema works. This proves an
 * EXISTING database survives the upgrade: a database written by the previous
 * build (v4) must keep every work item, its evidence and the user's settings,
 * and the two new columns must read back as ABSENT (meaning "not part of a
 * goal") rather than as an empty value that a later check could mistake for a
 * real linkage.
 *
 * It builds the v4 database by applying the real v1..v4 migrations to a temp
 * file and stamping `user_version = 4`, which is exactly the state a user's
 * database is in before this build opens it.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MIGRATIONS, SCHEMA_VERSION } from "../src/storage/schema.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";

/** Build a database at `version` by running the real migrations up to it. */
function buildAt(path: string, version: number): void {
  const db = new DatabaseSync(path);
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    for (const statement of migration.statements) db.exec(statement);
  }
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
}

test("a v4 database keeps its work items, evidence and settings through the v5 upgrade", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-migrate-"));
  const path = join(dir, "kai.db");
  // One teardown, ordered: the databases must be CLOSED before the directory is
  // removed, or Windows refuses (the file is still open).
  const handles: { close(): void }[] = [];
  t.after(() => {
    for (const handle of handles.reverse()) {
      try {
        handle.close();
      } catch {
        // A close that fails must not prevent the cleanup below.
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  assert.ok(SCHEMA_VERSION >= 5, "this test describes the v5 upgrade");

  // ── A database as the PREVIOUS build left it ────────────────────────────────
  buildAt(path, 4);
  const legacy = new DatabaseSync(path);
  legacy
    .prepare(
      `INSERT INTO work_items (id, objective, skills, tools, state, attempts, heartbeats, failures, retries,
        createdAt, updatedAt, criteria, requiredEvidence, evidence)
       VALUES (?, ?, '[]', '[]', 'COMPLETED', 1, '[]', '[]', 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      "work_legacy",
      "a task from the previous build",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:05:00.000Z",
      JSON.stringify(["the deliverable exists"]),
      JSON.stringify(["the deliverable exists"]),
      JSON.stringify([{ source: "kai-observed", kind: "file", detail: "seen", supports: ["the deliverable exists"] }]),
    );
  legacy.prepare(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)`).run(
    "orchestration.doer",
    "ON",
    "2026-01-01T00:00:00.000Z",
  );
  legacy.close();

  // ── The upgrade ─────────────────────────────────────────────────────────────
  const stores = openSqliteStores({ path });
  handles.push(stores);

  const item = stores.workItems.get("work_legacy");
  assert.ok(item, "the pre-existing work item survived the upgrade");
  assert.equal(item.objective, "a task from the previous build");
  assert.equal(item.state, "COMPLETED");
  assert.deepEqual(item.criteria, ["the deliverable exists"], "v4 criteria survived");
  assert.deepEqual(item.requiredEvidence, ["the deliverable exists"], "v4 evidence requirements survived");
  assert.equal((item.evidence ?? []).length, 1, "v4 KAI-observed evidence survived");
  assert.equal(
    (item.evidence ?? [])[0]?.source,
    "kai-observed",
    "and the trust split (observed vs worker-reported) is intact",
  );

  // The new columns read back as ABSENT — not as an empty string, which a naive
  // check could treat as a real (and therefore authorising) goal linkage.
  assert.equal(item.goalId, undefined, "an old row is not part of a goal");
  assert.equal(item.goalRevisionId, undefined);

  assert.equal(stores.settings.get("orchestration.doer"), "ON", "the user's saved preference survived");

  // ── And the upgraded database is usable ─────────────────────────────────────
  stores.workItems.upsert({
    id: "work_new",
    objective: "a task from this build",
    goalId: "goal_1",
    goalRevisionId: "rev_1",
    skills: [],
    tools: [],
    state: "READY",
    attempts: 0,
    heartbeats: [],
    failures: [],
    retries: 0,
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
  });
  const fresh = stores.workItems.get("work_new");
  assert.equal(fresh?.goalId, "goal_1", "the new linkage round-trips");
  assert.equal(fresh?.goalRevisionId, "rev_1");

  // Reopening must not re-run the migrations or lose anything.
  stores.close();
  const reopened = openSqliteStores({ path });
  handles.push(reopened);
  assert.equal(reopened.workItems.get("work_legacy")?.goalId, undefined, "still absent after a reopen");
  assert.equal(reopened.workItems.get("work_new")?.goalId, "goal_1", "and the new linkage persists");
  const version = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    Number((version.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
    SCHEMA_VERSION,
    "the database is stamped at the current schema version",
  );
  version.close();
});

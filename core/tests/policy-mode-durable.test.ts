// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The DURABLE policy mode.
 *
 * `policy-mode.test.ts` already pins the mode ENGINE (transitions, owner-only
 * elevation, unblockable downgrade). This file pins the layer that was missing:
 * the state now outlives the process, and the route makes it reachable.
 *
 * The properties that would be security bugs if they flipped:
 *
 *   * a mode a human set is still in force after a restart
 *   * a corrupt or unreadable store can only LOSE an elevation, never invent one
 *   * an unconfirmed elevation is never in force, before or after a restart
 *   * a downgrade works with no store at all (durability is never a precondition
 *     for reducing authority)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPolicyEngine } from "../src/policies/gate.ts";
import { openPolicyStateStore, resolvedInitialState } from "../src/policies/state-store.ts";
import { initialPolicyState, type PolicyState } from "../src/policies/mode.ts";
import type { PolicyMode } from "../src/shared/contracts.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-policy-"));
}

test("a mode set in one engine is in force in the NEXT one (it survives a restart)", () => {
  const dir = tempDir();
  const path = join(dir, "policy-state.db");
  try {
    // Process 1: elevate via request -> confirm.
    const storeOne = openPolicyStateStore({ path });
    const first = createPolicyEngine({
      initialState: resolvedInitialState(storeOne),
      onChange: (state) => storeOne.save(state),
    });
    assert.equal(first.mode(), "normal", "a fresh store starts at the baseline");

    const requested = first.requestElevation({ to: "elevated", scope: { kind: "global" }, requestedBy: "owner" });
    // `elevated` may not be global (refused by shape), so scope it to a mission.
    assert.equal(requested.ok, false, "elevated may not be scoped globally");
    const scoped = first.requestElevation({
      to: "elevated",
      scope: { kind: "mission", id: "m-1" },
      requestedBy: "owner",
    });
    assert.equal(scoped.ok, true, scoped.reason);
    assert.equal(first.mode(), "normal", "an UNCONFIRMED elevation is not in force");
    const requestId = first.policyState().pending?.requestId;
    assert.ok(typeof requestId === "string" && requestId.length > 0, "a request id is issued");
    const confirmed = first.confirmElevation({ requestId, confirmedBy: "owner" });
    assert.equal(confirmed.ok, true, confirmed.reason);
    assert.equal(first.mode(), "elevated");
    storeOne.close();

    // Process 2: a NEW store and a NEW engine over the same file.
    const storeTwo = openPolicyStateStore({ path });
    const second = createPolicyEngine({ initialState: resolvedInitialState(storeTwo) });
    assert.equal(second.mode(), "elevated", "the mode a human confirmed is still in force");
    assert.deepEqual(second.policyState().scope, { kind: "mission", id: "m-1" });
    assert.equal(second.policyState().pending, undefined, "a confirmed elevation leaves nothing pending");
    storeTwo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a NON-owner elevation is refused, and leaves nothing to persist", () => {
  const dir = tempDir();
  const path = join(dir, "policy-state.db");
  try {
    const store = openPolicyStateStore({ path });
    const saved: PolicyState[] = [];
    const engine = createPolicyEngine({
      initialState: resolvedInitialState(store),
      onChange: (state) => {
        saved.push(state);
        store.save(state);
      },
    });
    // A worker asking on the user's behalf must not even be able to PREPARE it.
    const refused = engine.requestElevation({
      to: "auto-read",
      scope: { kind: "global" },
      requestedBy: "worker",
    });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /owner/i, refused.reason);
    assert.equal(engine.mode(), "normal");
    assert.equal(saved.length, 0, "a refused change is never persisted");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a downgrade needs no store, and works with a throwing persist sink", () => {
  // Reducing authority must never be gated on a disk write succeeding.
  const engine = createPolicyEngine({
    initialState: initialPolicyState(new Date(), "elevated" as PolicyMode),
    onChange: () => {
      throw new Error("the disk is full");
    },
  });
  assert.equal(engine.mode(), "elevated");
  const change = engine.downgrade({ reason: "test" });
  assert.equal(change.ok, true, change.reason);
  assert.equal(engine.mode(), "normal", "the downgrade applies despite the failed sink");
});

test("a corrupt store is reported as no state at all (it can only LOSE authority)", async () => {
  const dir = tempDir();
  try {
    // A store whose row holds a mode that is not a policy mode.
    const path = join(dir, "policy-state.db");
    const store = openPolicyStateStore({ path });
    // Write a valid state first so the table exists, then corrupt it directly.
    store.save({
      mode: "normal",
      scope: { kind: "global" },
      updatedAt: new Date().toISOString(),
    });
    store.close();

    // Corrupt via SQL: an unknown mode is exactly the "row that will not parse".
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    db.exec(`UPDATE policy_state SET mode = 'superuser' WHERE id = 1`);
    db.close();

    const reopened = openPolicyStateStore({ path });
    assert.equal(reopened.load(), undefined, "an unparseable row is no state, not a guessed one");
    // And the resolution rule therefore lands on the baseline.
    assert.equal(resolvedInitialState(reopened).mode, "normal");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a PENDING elevation survives a restart but is still not in force", () => {
  const dir = tempDir();
  const path = join(dir, "policy-state.db");
  try {
    const storeOne = openPolicyStateStore({ path });
    const first = createPolicyEngine({
      initialState: resolvedInitialState(storeOne),
      onChange: (state) => storeOne.save(state),
    });
    const requested = first.requestElevation({
      to: "auto-read",
      scope: { kind: "global" },
      requestedBy: "owner",
    });
    assert.equal(requested.ok, true, requested.reason);
    storeOne.close();

    const storeTwo = openPolicyStateStore({ path });
    const second = createPolicyEngine({ initialState: resolvedInitialState(storeTwo) });
    // Fail closed: a prepared-but-unconfirmed elevation resolves DOWN.
    assert.equal(second.mode(), "normal", "an unconfirmed elevation is never in force");
    assert.ok(second.policyState().pending !== undefined, "the prepared request is still visible");
    assert.match(second.policyState().pending?.to ?? "", /^auto-read$/);
    storeTwo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a malformed store FILE does not stop the runtime: it resolves to the baseline", () => {
  const dir = tempDir();
  try {
    // A path that is not a SQLite database at all.
    const path = join(dir, "policy-state.db");
    writeFileSync(path, "this is not a database");
    // Opening a non-database must throw rather than silently produce authority;
    // the runtime treats a store it cannot open as absent.
    assert.throws(() => openPolicyStateStore({ path }));
    // And the fallback the runtime uses is the baseline.
    assert.equal(resolvedInitialState(undefined).mode, "normal");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

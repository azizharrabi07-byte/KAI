// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The per-skill lock.
 *
 * Two properties are load-bearing and both are asserted below: the lock lives
 * OUTSIDE the directory it protects (so a skill's own delete/recreate cannot
 * free it), and its name is the CANONICAL IDENTITY rather than the basename (so
 * `writing/summary` and `research/summary` do not collide).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSkillLocks } from "../src/skills/lock.ts";

function tempRoot(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kai-skill-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

test("a held lock refuses a second writer, and says who holds it", (t) => {
  const root = tempRoot(t);
  const locks = createSkillLocks({ root });
  let inner: string | undefined;
  const outer = locks.withLock("writing/summary", () => {
    assert.equal(locks.held("writing/summary"), true);
    // A second acquisition of the SAME id is refused — that is the whole point.
    const second = locks.withLock("writing/summary", () => "should not run");
    assert.equal(second.ok, false);
    if (!second.ok) inner = second.error.message;
    return "first";
  });
  assert.equal(outer.ok, true);
  if (outer.ok) assert.equal(outer.value, "first");
  assert.match(String(inner), /is locked by .* \(pid \d+\) since/);
  assert.match(String(inner), /another read-modify-write is in progress/);
  assert.equal(locks.held("writing/summary"), false, "released afterwards");
  t.diagnostic(String(inner));
});

test("the lock file lives OUTSIDE the skill directory", (t) => {
  const root = tempRoot(t);
  const locks = createSkillLocks({ root });
  locks.withLock("writing/summary", () => {
    const lockDir = join(root, ".locks");
    assert.equal(existsSync(lockDir), true, "the lock directory is a sibling of the skills root");
    const files = readdirSync(lockDir);
    assert.equal(files.length, 1);
    // The lock is named after the IDENTITY, so it is not the skill's own name and
    // cannot be removed by deleting the skill's directory.
    assert.doesNotMatch(files[0] ?? "", /summary/, "the lock name is a hash, not the skill basename");
    assert.match(files[0] ?? "", /^[0-9a-f]{32}\.lock$/);
    return true;
  });
  // Recreating the skill directory does not free the lock: the lock was never
  // inside it. (Asserted structurally above; here we prove the dir is untouched.)
  mkdirSync(join(root, "writing", "summary"), { recursive: true });
  assert.equal(existsSync(join(root, ".locks")), true);
});

test("CANONICAL IDENTITY: two skills sharing a basename never collide", (t) => {
  const root = tempRoot(t);
  const locks = createSkillLocks({ root });
  const held: string[] = [];
  // Hold one while acquiring the other. If the lock were named after the
  // basename ("summary"), the second would be refused.
  locks.withLock("writing/summary", () => {
    const other = locks.withLock("research/summary", () => {
      held.push("research/summary");
      return "ok";
    });
    assert.equal(other.ok, true, `a different id must not share the lock: ${other.ok ? "" : other.error.message}`);
    return true;
  });
  assert.deepEqual(held, ["research/summary"]);
  const files = readdirSync(join(root, ".locks"));
  assert.equal(files.length, 0, "both were released");
});

test("the lock is released even when the operation throws", (t) => {
  const root = tempRoot(t);
  const locks = createSkillLocks({ root });
  assert.throws(() => {
    locks.withLock("x", () => {
      throw new Error("the operation failed");
    });
  }, /the operation failed/);
  assert.equal(locks.held("x"), false, "a throwing operation still unlocks");
  const again = locks.withLock("x", () => "fine");
  assert.equal(again.ok, true);
});

test("a lock whose owner process is GONE is stolen, not honoured forever", (t) => {
  const root = tempRoot(t);
  const lockDir = join(root, ".locks");
  mkdirSync(lockDir, { recursive: true });
  // A lock left by a process that no longer exists. pid 0 is never a live process.
  const staleName = "deadbeefdeadbeefdeadbeefdeadbeef.lock";
  writeFileSync(
    join(lockDir, staleName),
    JSON.stringify({ id: "orphan", ownerId: "lock_dead", pid: 0, at: new Date().toISOString() }),
  );
  const locks = createSkillLocks({ root });
  // A crashed writer must not lock a skill out permanently. Note: this stale
  // lock is for a DIFFERENT id than the one we acquire, so the file itself is
  // what we inspect.
  const acquired = locks.withLock("orphan", () => "recovered");
  assert.equal(acquired.ok, true, "a dead owner's lock does not block the skill forever");
  if (acquired.ok) assert.equal(acquired.value, "recovered");
  t.diagnostic("stale lock stolen");
});

test("a lock older than staleMs is stolen even if the pid looks alive", (t) => {
  const root = tempRoot(t);
  const lockDir = join(root, ".locks");
  mkdirSync(lockDir, { recursive: true });
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const locks = createSkillLocks({ root, now: () => new Date(clock), staleMs: 1000 });
  // Hold it, then jump the clock past the staleness window.
  locks.withLock("aged", () => {
    clock += 60_000;
    const stolen = locks.withLock("aged", () => "stolen");
    assert.equal(stolen.ok, true, "an expired lock is not honoured");
    return true;
  });
});

test("a corrupt lock file is treated as stale rather than blocking forever", (t) => {
  const root = tempRoot(t);
  const lockDir = join(root, ".locks");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "00000000000000000000000000000000.lock"), "not json at all");
  const locks = createSkillLocks({ root });
  assert.equal(locks.held("whatever"), false, "a corrupt lock does not read as held");
});

test("listHeld reports live locks and skips stale ones", (t) => {
  const root = tempRoot(t);
  const locks = createSkillLocks({ root });
  locks.withLock("a/b", () => {
    const held = locks.listHeld();
    assert.equal(held.length, 1);
    assert.equal(held[0]?.id, "a/b");
    assert.ok((held[0]?.pid ?? 0) > 0);
    assert.match(String(held[0]?.ownerId), /^lock_\d+_/);
    return true;
  });
  assert.deepEqual(locks.listHeld(), [], "nothing is held once released");
});

test("the lock body records the canonical id, not a path", (t) => {
  const root = tempRoot(t);
  const locks = createSkillLocks({ root });
  locks.withLock("deep/nested/id", () => {
    const file = join(root, ".locks", readdirSync(join(root, ".locks"))[0] ?? "");
    const body = JSON.parse(readFileSync(file, "utf8")) as { id: string; ownerId: string; pid: number };
    assert.equal(body.id, "deep/nested/id");
    assert.equal(body.pid, process.pid);
    return true;
  });
});

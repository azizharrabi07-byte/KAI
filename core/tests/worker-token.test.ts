// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Tests for the worker credential (src/worker-token.ts).
 *
 * The property that matters is not "a token is produced" but: the Core and the
 * out-of-process hook end up with the SAME value, and when they cannot, the
 * result is a refusal (no route accepts the call) rather than an ungated run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MIN_WORKER_TOKEN_LENGTH,
  defaultWorkerTokenFile,
  resolveWorkerToken,
} from "../src/worker-token.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-worker-token-"));
}

test("an explicit token is used AND written where the hook reads it", () => {
  const file = join(tempDir(), "nested", "worker-token");
  const explicit = "a".repeat(64);
  const resolved = resolveWorkerToken({ explicit, file });
  assert.equal(resolved.token, explicit);
  assert.equal(resolved.source, "env");
  assert.equal(resolved.persisted, true);
  assert.equal(readFileSync(file, "utf8"), explicit);
});

test("an existing file is reused unchanged (Core restarts do not invalidate the hook)", () => {
  const file = join(tempDir(), "worker-token");
  const existing = "b".repeat(64);
  writeFileSync(file, existing, "utf8");
  const resolved = resolveWorkerToken({ file });
  assert.equal(resolved.token, existing);
  assert.equal(resolved.source, "file");
  assert.equal(readFileSync(file, "utf8"), existing);
});

test("with neither a token nor a file, a 64-hex token is minted and persisted", () => {
  const file = join(tempDir(), "kai", "worker-token");
  const resolved = resolveWorkerToken({ file });
  assert.equal(resolved.source, "created");
  assert.equal(resolved.persisted, true);
  assert.match(resolved.token ?? "", /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(file, "utf8"), resolved.token);
});

test("a too-short explicit token is not a credential: it is ignored, never used", () => {
  const file = join(tempDir(), "worker-token");
  const resolved = resolveWorkerToken({ explicit: "short", file });
  assert.notEqual(resolved.token, "short");
  assert.equal(resolved.source, "created");
  assert.equal(resolved.token?.length, 64);
});

test("a too-short file is replaced rather than honoured", () => {
  const file = join(tempDir(), "worker-token");
  writeFileSync(file, "tiny", "utf8");
  const resolved = resolveWorkerToken({ file });
  assert.equal(resolved.source, "created");
  assert.equal(resolved.token?.length, 64);
});

test("when the file cannot be written the Core keeps a token but reports it is not persisted", () => {
  const dir = tempDir();
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory", "utf8");
  const file = join(blocker, "worker-token");
  const resolved = resolveWorkerToken({ file });
  assert.equal(resolved.source, "unavailable");
  assert.equal(resolved.persisted, false);
  // The token still exists in memory so the decision function has something to
  // verify; the hook cannot read it, so its calls fail closed.
  assert.match(resolved.token ?? "", /^[0-9a-f]{64}$/);
});

test("defaultWorkerTokenFile honours the override and otherwise stays under the user's app data", () => {
  assert.equal(
    defaultWorkerTokenFile({ KAI_WORKER_TOKEN_FILE: "C:\\custom\\token" }),
    "C:\\custom\\token",
  );
  const derived = defaultWorkerTokenFile({});
  assert.match(derived, /worker-token$/);
  assert.ok(derived.length > "worker-token".length);
});

test("MIN_WORKER_TOKEN_LENGTH is long enough to be a secret", () => {
  assert.ok(MIN_WORKER_TOKEN_LENGTH >= 32);
});

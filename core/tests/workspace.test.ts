// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The REAL shell / git / filesystem ops (Phase 4 gap 1).
 * Plain `node --test`, no dependencies.
 * Run from `core/`:  node --test tests/workspace.test.ts
 *
 * These drive the op functions directly — the pure half. The boundary half (that
 * a write/shell action PARKS for a human and is recovered by an approval) is in
 * `tests/workspace-approval.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  filesystemList,
  filesystemRead,
  filesystemWrite,
  gitLog,
  gitStatus,
  probeGit,
  probeShell,
  shellRun,
  createWorkspaceTools,
  WORKSPACE_TOOL_IDS,
} from "../src/tools/workspace.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-workspace-"));
}

// ── filesystem ────────────────────────────────────────────────────────────────

test("filesystem.write then read round-trips the exact bytes", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hello.txt");

  const written = filesystemWrite({ path, content: "kai says hi\n" });
  assert.equal(written.path, path);
  assert.equal(written.bytes, Buffer.byteLength("kai says hi\n", "utf8"));

  const read = filesystemRead({ path });
  assert.equal(read.content, "kai says hi\n");
  assert.equal(read.truncated, false);
});

test("filesystem.write can create parent directories on request", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "a", "b", "c.txt");

  // Without createDirs the write fails (the parent is missing)…
  assert.throws(() => filesystemWrite({ path, content: "x" }), /ENOENT|no such file/i);
  // …and with it, it succeeds.
  const written = filesystemWrite({ path, content: "x", createDirs: true });
  assert.equal(filesystemRead({ path }).content, "x");
  assert.equal(written.path, path);
});

test("filesystem.read is bounded and admits the truncation", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "big.txt");
  writeFileSync(path, "abcdefghij", "utf8");

  const read = filesystemRead({ path, maxBytes: 4 });
  assert.equal(read.truncated, true);
  assert.equal(read.content, "abcd");
  assert.equal(read.bytes, 10);
});

test("filesystem.list reports real entry types and sizes", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "one.txt"), "123", "utf8");

  const listing = filesystemList({ path: dir });
  const one = listing.entries.find((e) => e.name === "one.txt");
  assert.ok(one !== undefined, JSON.stringify(listing.entries));
  assert.equal(one.type, "file");
  assert.equal(one.size, 3);
  assert.equal(listing.truncated, false);
});

test("an unknown option is refused rather than ignored", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => filesystemList({ path: dir, recursive: true }), /unknown option "recursive"/);
});

// ── shell ─────────────────────────────────────────────────────────────────────

test("shell.run executes a program with an explicit argument list", async () => {
  const result = await shellRun({
    command: process.execPath,
    args: ["-e", "process.stdout.write('shell-ok')"],
    cwd: process.cwd(),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "shell-ok");
  assert.equal(result.truncated, false);
});

test("shell.run reports a non-zero exit as a result, not a throw", async () => {
  const result = await shellRun({ command: process.execPath, args: ["-e", "process.exit(3)"], cwd: process.cwd() });
  assert.equal(result.exitCode, 3);
});

test("shell.run rejects a command that cannot be started", async () => {
  await assert.rejects(
    () => shellRun({ command: "definitely-not-a-program-kai-test", args: [], cwd: process.cwd() }),
    /could not run/,
  );
});

test("shell.run refuses a non-string argument list", () => {
  return assert.rejects(() => shellRun({ command: process.execPath, args: ["-e", 5] }), /args must be an array of strings/);
});

// ── git ───────────────────────────────────────────────────────────────────────

test("git capability is probed honestly, and the read ops work when it is present", async (t) => {
  const probed = await probeGit();
  if (!probed.available) {
    t.skip(`git is not runnable here: ${probed.detail}`);
    return;
  }
  // `core/` is itself inside the KAI repository, so the default cwd is a real repo.
  const status = await gitStatus({});
  assert.ok(status.branch.length > 0, JSON.stringify(status));
  assert.equal(typeof status.clean, "boolean");
  assert.ok(Array.isArray(status.entries));

  const log = await gitLog({ limit: 1 });
  assert.equal(log.commits.length, 1);
  assert.match(log.commits[0]!.sha, /^[0-9a-f]{40}$/);
});

test("the shell probe measures a real spawn", async () => {
  const probed = await probeShell();
  assert.equal(probed.available, true, probed.detail);
});

// ── registration ──────────────────────────────────────────────────────────────

test("the workspace tools carry honest risk and the effectful flag", () => {
  const tools = createWorkspaceTools();
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  assert.deepEqual(
    [...byId.keys()].sort(),
    [...Object.values(WORKSPACE_TOOL_IDS)].sort(),
  );
  assert.equal(byId.get(WORKSPACE_TOOL_IDS.read)?.risk, "READ");
  assert.equal(byId.get(WORKSPACE_TOOL_IDS.list)?.risk, "READ");
  assert.equal(byId.get(WORKSPACE_TOOL_IDS.gitStatus)?.risk, "READ");
  assert.equal(byId.get(WORKSPACE_TOOL_IDS.gitLog)?.risk, "READ");
  assert.equal(byId.get(WORKSPACE_TOOL_IDS.gitDiff)?.risk, "READ");
  // The two that touch the world are WRITE/DESTRUCTIVE *and* effectful, so the
  // acceptance boundary records them rather than replaying them blindly.
  assert.equal(byId.get(WORKSPACE_TOOL_IDS.write)?.risk, "WRITE");
  assert.equal(byId.get(WORKSPACE_TOOL_IDS.write)?.effectful, true);
  assert.equal(byId.get(WORKSPACE_TOOL_IDS.shell)?.risk, "DESTRUCTIVE");
  assert.equal(byId.get(WORKSPACE_TOOL_IDS.shell)?.effectful, true);
});

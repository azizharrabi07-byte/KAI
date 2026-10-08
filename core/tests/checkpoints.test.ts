// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Part G — real tests for KAI's shadow checkpoints.
 *
 * These run the real `git` binary against real temporary directories. The test
 * that matters most asserts the invariant the brief calls out: the user's real
 * `.git` directory and history must be byte-for-byte unchanged after a create
 * and a restore.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildManifest, createCheckpointManager } from "../src/checkpoints/checkpoint.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** SHA-256 of the whole directory tree (files + relative paths), for "untouched" assertions. */
function treeHash(root: string): string {
  const hash = createHash("sha256");
  function walk(dir: string, rel: string): void {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = statSync(abs);
      if (st.isDirectory()) {
        hash.update(`D:${r}\n`);
        walk(abs, r);
      } else {
        hash.update(`F:${r}\n`);
        hash.update(readFileSync(abs));
        hash.update("\n");
      }
    }
  }
  if (existsSync(root)) walk(root, "");
  return hash.digest("hex");
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const USER_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function userGit(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=User", "-c", "user.email=user@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: USER_GIT_ENV },
  );
}

test("checkpoint create/restore round trip restores content, resurrects deleted files, removes new ones", () => {
  const workspace = tempDir("kai-ckpt-");
  const root = join(workspace, "store");
  const target = join(workspace, "project");
  mkdirSync(join(target, "sub"), { recursive: true });
  writeFileSync(join(target, "a.txt"), "original-a\n");
  writeFileSync(join(target, "sub", "b.txt"), "original-b\n");

  const ckpt = createCheckpointManager({ root });
  const created = ckpt.create({ target, label: "before-risky-op" });
  assert.equal(created.ok, true, created.ok === false ? created.reason : "");
  assert.equal(created.ok && created.checkpoint.fileCount, 2);

  // Mutate: change one file, delete another, add a third.
  writeFileSync(join(target, "a.txt"), "CHANGED\n");
  rmSync(join(target, "sub", "b.txt"));
  writeFileSync(join(target, "extra.txt"), "should be gone after restore\n");

  const id = created.ok ? created.checkpoint.id : "";
  const restored = ckpt.restore(id);
  assert.equal(restored.ok, true, restored.ok === false ? restored.reason : "");
  assert.equal(restored.ok && restored.verified, true);
  assert.equal(readFileSync(join(target, "a.txt"), "utf8"), "original-a\n");
  assert.equal(readFileSync(join(target, "sub", "b.txt"), "utf8"), "original-b\n");
  assert.equal(existsSync(join(target, "extra.txt")), false, "file added after the snapshot is removed");
});

test("restore verifies the result and reports failure when the manifest does not match", () => {
  const workspace = tempDir("kai-ckpt-");
  const root = join(workspace, "store");
  const target = join(workspace, "project");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "a.txt"), "hello\n");

  const ckpt = createCheckpointManager({ root });
  const created = ckpt.create({ target });
  assert.equal(created.ok, true);
  const id = created.ok ? created.checkpoint.id : "";

  // Corrupt the on-disk manifest: the restore will still run, but verification
  // must catch that the tree it produced is not the tree it claimed to store.
  const manifestFile = join(root, `${id}.json`);
  const parsed = JSON.parse(readFileSync(manifestFile, "utf8")) as {
    manifest: Array<{ path: string; sha256: string }>;
  };
  parsed.manifest[0]!.sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
  writeFileSync(manifestFile, JSON.stringify(parsed));

  const restored = ckpt.restore(id);
  assert.equal(restored.ok, false, "a restore that did not reproduce the snapshot must fail");
  assert.equal(restored.ok === false && restored.verified, false);
  assert.ok(restored.ok === false && (restored.mismatches?.length ?? 0) > 0);
});

test("restore reports failure (not a false success) when the shadow repository is unusable", () => {
  const workspace = tempDir("kai-ckpt-");
  const root = join(workspace, "store");
  const target = join(workspace, "project");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "a.txt"), "hello\n");

  const ckpt = createCheckpointManager({ root });
  const created = ckpt.create({ target });
  assert.equal(created.ok, true);
  const id = created.ok ? created.checkpoint.id : "";

  // Destroy the shadow objects, leaving the shadow dir present but unusable.
  rmSync(join(root, `${id}.git`, "objects"), { recursive: true, force: true });

  const restored = ckpt.restore(id);
  assert.equal(restored.ok, false);
  assert.equal(restored.ok === false && restored.verified, false);
  assert.match(restored.ok === false ? restored.reason : "", /checkout|failed|missing/i);
});

test("a checkpoint of a real git repo never touches the user's .git metadata or history", () => {
  const workspace = tempDir("kai-ckpt-");
  const root = join(workspace, "store");
  const target = join(workspace, "userrepo");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "tracked.txt"), "v1\n");

  // Make it a real repository with real history.
  userGit(target, ["init", "--quiet"]);
  userGit(target, ["add", "-A"]);
  userGit(target, ["commit", "--quiet", "-m", "initial"]);
  userGit(target, ["tag", "keep-me"]);

  const gitDir = join(target, ".git");
  const gitBefore = treeHash(gitDir);
  const logBefore = userGit(target, ["log", "--oneline", "--all"]);

  const ckpt = createCheckpointManager({ root });
  const created = ckpt.create({ target, label: "snapshot-of-git-repo" });
  assert.equal(created.ok, true, created.ok === false ? created.reason : "");
  // The snapshot records the working files, not the git metadata.
  assert.equal(created.ok && created.checkpoint.manifest.some((f) => f.path.startsWith(".git")), false);

  writeFileSync(join(target, "tracked.txt"), "v2-mutated\n");
  writeFileSync(join(target, "untracked.txt"), "extra\n");

  const id = created.ok ? created.checkpoint.id : "";
  const restored = ckpt.restore(id);
  assert.equal(restored.ok, true, restored.ok === false ? restored.reason : "");

  // The files came back...
  assert.equal(readFileSync(join(target, "tracked.txt"), "utf8"), "v1\n");
  assert.equal(existsSync(join(target, "untracked.txt")), false);

  // ...and the user's git metadata and history are byte-for-byte untouched.
  assert.equal(treeHash(gitDir), gitBefore, "the user's .git must not be modified");
  assert.equal(userGit(target, ["log", "--oneline", "--all"]), logBefore, "history must be unchanged");
  assert.equal(userGit(target, ["tag", "--list"]).trim(), "keep-me");
});

test("creating a checkpoint of a missing target fails safely and writes nothing usable", () => {
  const workspace = tempDir("kai-ckpt-");
  const root = join(workspace, "store");
  const ckpt = createCheckpointManager({ root });
  const created = ckpt.create({ target: join(workspace, "does-not-exist") });
  assert.equal(created.ok, false);
  assert.match(created.ok === false ? created.reason : "", /does not exist/);
  assert.deepEqual(ckpt.list(), []);
});

test("buildManifest is deterministic and excludes .git", () => {
  const workspace = tempDir("kai-ckpt-");
  const target = join(workspace, "proj");
  mkdirSync(join(target, ".git"), { recursive: true });
  writeFileSync(join(target, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(target, "x.txt"), "x\n");
  const a = buildManifest(target);
  const b = buildManifest(target);
  assert.deepEqual(a.files, b.files);
  assert.deepEqual(a.files.map((f) => f.path), ["x.txt"]);
});

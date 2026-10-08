// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI-owned shadow checkpoints (Part G).
 *
 * Before a risky filesystem or multi-step operation KAI takes a snapshot of the
 * directory it is about to change, so a recoverable failure can be rolled back
 * to the exact bytes that were there. Two hard rules shape the implementation:
 *
 *   1. NEVER TOUCH THE USER'S GIT METADATA OR HISTORY. A snapshot is stored in a
 *      *separate* git directory that KAI owns (`<root>/<id>.git`), and every git
 *      invocation runs with `GIT_DIR` pointed at that shadow repo and
 *      `GIT_WORK_TREE` at the user's directory. Git therefore never reads or
 *      writes `<target>/.git`; the shadow repo's `info/exclude` additionally
 *      keeps `.git/` out of the snapshot entirely. The user's real repository is
 *      neither indexed nor committed to.
 *
 *   2. NEVER REPORT A ROLLBACK THAT DID NOT HAPPEN. `restore()` re-hashes the
 *      whole tree afterwards and compares it to the snapshot manifest. Only an
 *      exact match is reported as `{ ok: true, verified: true }`; anything else
 *      is `{ ok: false, verified: false, reason }` with the mismatching paths.
 *      A failed restore is a failure value, never an optimistic success.
 *
 * The manifest is KAI's own (path -> sha256) record of the tree, computed in
 * Node rather than trusting git, so verification is independent of the mechanism
 * that performed the restore.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CheckpointFile {
  /** Path relative to the snapshotted target, POSIX separators. */
  path: string;
  sha256: string;
  size: number;
  type: "file" | "symlink";
}

export interface Checkpoint {
  id: string;
  label?: string;
  target: string;
  /** Commit sha inside the shadow repo. */
  sha: string;
  createdAt: string;
  fileCount: number;
  manifest: CheckpointFile[];
}

export type CreateResult = { ok: true; checkpoint: Checkpoint } | { ok: false; reason: string };

export type RestoreResult =
  | { ok: true; verified: true; id: string; restored: number; removed: number }
  | {
      ok: false;
      verified: false;
      id?: string;
      reason: string;
      mismatches?: string[];
    };

export interface CheckpointManager {
  readonly root: string;
  create(input: { target: string; label?: string; exclude?: string[] }): CreateResult;
  restore(id: string, opts?: { target?: string }): RestoreResult;
  list(): Checkpoint[];
  get(id: string): Checkpoint | null;
  remove(id: string): boolean;
}

export function defaultCheckpointsDir(): string {
  const override = process.env.KAI_CORE_CHECKPOINTS_DIR?.trim();
  if (override !== undefined && override.length > 0) return override;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "KAI", "core", "checkpoints");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg !== undefined && xdg.length > 0) return join(xdg, "KAI", "core", "checkpoints");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "KAI", "core", "checkpoints");
  }
  return join(homedir(), ".local", "share", "KAI", "core", "checkpoints");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Walk a directory into a deterministic manifest, skipping git metadata and any
 * caller-supplied exclusions. This is the record the restore is verified against.
 */
export function buildManifest(root: string, exclude: readonly string[] = []): { files: CheckpointFile[]; errors: string[] } {
  const files: CheckpointFile[] = [];
  const errors: string[] = [];
  const skip = new Set<string>([".git", ...exclude.map((e) => e.replace(/^\.\//, "").replace(/\/$/, ""))]);

  function walk(dir: string, relPrefix: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch (error) {
      errors.push(`${relPrefix || "."}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = relPrefix === "" ? name : `${relPrefix}/${name}`;
      if (skip.has(name) || skip.has(rel)) continue;
      let stat;
      try {
        stat = lstatSync(abs);
      } catch (error) {
        errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs, rel);
      } else if (stat.isSymbolicLink()) {
        let targetText = "";
        try {
          targetText = readlinkSync(abs);
        } catch {
          targetText = "";
        }
        files.push({
          path: toPosix(rel),
          sha256: createHash("sha256").update(targetText).digest("hex"),
          size: targetText.length,
          type: "symlink",
        });
      } else if (stat.isFile()) {
        try {
          const content = readFileSync(abs);
          files.push({
            path: toPosix(rel),
            sha256: createHash("sha256").update(content).digest("hex"),
            size: content.byteLength,
            type: "file",
          });
        } catch (error) {
          errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  walk(root, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, errors };
}

function manifestsEqual(a: readonly CheckpointFile[], b: readonly CheckpointFile[]): string[] {
  const mismatches: string[] = [];
  const byPath = new Map(b.map((f) => [f.path, f]));
  const seen = new Set<string>();
  for (const want of a) {
    seen.add(want.path);
    const got = byPath.get(want.path);
    if (got === undefined) {
      mismatches.push(`${want.path}: missing after restore`);
    } else if (got.sha256 !== want.sha256 || got.type !== want.type) {
      mismatches.push(`${want.path}: content differs after restore`);
    }
  }
  for (const extra of b) {
    if (!seen.has(extra.path)) mismatches.push(`${extra.path}: unexpected file after restore`);
  }
  return mismatches;
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function createCheckpointManager(opts: {
  root?: string;
  gitBin?: string;
  now?: () => Date;
} = {}): CheckpointManager {
  const root = opts.root ?? defaultCheckpointsDir();
  const gitBin = opts.gitBin ?? "git";
  const now = opts.now ?? (() => new Date());
  mkdirSync(root, { recursive: true });

  // An empty config file so the user's ~/.gitconfig cannot influence a snapshot,
  // and so that git never suggests writing to it.
  const emptyConfig = join(root, ".gitconfig-empty");
  if (!existsSync(emptyConfig)) writeFileSync(emptyConfig, "");

  function git(args: string[], cwd: string): GitResult {
    const result = spawnSync(gitBin, ["-c", "user.name=KAI", "-c", "user.email=kai@localhost", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return {
      status: result.status ?? -1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : result.error?.message ?? "",
    };
  }

  function shadowDir(id: string): string {
    return join(root, `${id}.git`);
  }
  function manifestPath(id: string): string {
    return join(root, `${id}.json`);
  }

  function writeExclude(dir: string, patterns: readonly string[]): void {
    mkdirSync(join(dir, "info"), { recursive: true });
    const lines = [".git/", ".git", ...patterns.map((p) => p.trim()).filter((p) => p.length > 0)];
    writeFileSync(join(dir, "info", "exclude"), `${lines.join("\n")}\n`);
  }

  function create(input: { target: string; label?: string; exclude?: string[] }): CreateResult {
    const target = resolve(input.target);
    if (!existsSync(target)) return { ok: false, reason: `target does not exist: ${target}` };
    if (!lstatSync(target).isDirectory()) return { ok: false, reason: `target is not a directory: ${target}` };

    const id = `ckpt_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const dir = shadowDir(id);

    try {
      const init = git(["init", "--bare", "--quiet", dir], root);
      if (init.status !== 0) {
        return { ok: false, reason: `git init failed: ${init.stderr || init.stdout}` };
      }

      // Exclusion patterns live in the SHADOW repo, never in the user's tree.
      const exclude = [...(input.exclude ?? [])];
      // If KAI's own checkpoint store happens to sit inside the target, keep it out.
      const relRoot = relative(target, root);
      if (relRoot !== "" && !relRoot.startsWith("..") && !isAbsolute(relRoot)) exclude.push(`${toPosix(relRoot)}/`);
      writeExclude(dir, exclude);

      const env = { gitDir: dir, workTree: target };
      const add = gitWithEnv(["add", "-A"], root, env);
      if (add.status !== 0) {
        rmSync(dir, { recursive: true, force: true });
        return { ok: false, reason: `git add failed: ${add.stderr || add.stdout}` };
      }

      const message = `KAI checkpoint ${id}${input.label !== undefined ? ` — ${input.label}` : ""}`;
      const commit = gitWithEnv(["commit", "--allow-empty", "--quiet", "-m", message], root, env);
      if (commit.status !== 0) {
        rmSync(dir, { recursive: true, force: true });
        return { ok: false, reason: `git commit failed: ${commit.stderr || commit.stdout}` };
      }

      const rev = gitWithEnv(["rev-parse", "HEAD"], root, env);
      const sha = rev.stdout.trim();
      if (rev.status !== 0 || sha.length === 0) {
        rmSync(dir, { recursive: true, force: true });
        return { ok: false, reason: `could not resolve snapshot commit: ${rev.stderr}` };
      }

      const built = buildManifest(target, exclude);
      if (built.errors.length > 0) {
        // A snapshot with unreadable files is not a snapshot we would trust to
        // restore: fail rather than store a partial manifest.
        rmSync(dir, { recursive: true, force: true });
        return { ok: false, reason: `could not read every file: ${built.errors.join("; ")}` };
      }

      const checkpoint: Checkpoint = {
        id,
        target,
        sha,
        createdAt: now().toISOString(),
        fileCount: built.files.length,
        manifest: built.files,
      };
      if (input.label !== undefined) checkpoint.label = input.label;
      writeFileSync(manifestPath(id), JSON.stringify(checkpoint, null, 2));
      return { ok: true, checkpoint };
    } catch (error) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // clean-up is best-effort
      }
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Run a git command with an explicit shadow GIT_DIR and the user's tree as the
   * work tree. Factored out so EVERY git call here uses the same isolation.
   */
  function gitWithEnv(
    args: string[],
    cwd: string,
    env: { gitDir: string; workTree: string },
  ): GitResult {
    const result = spawnSync(
      gitBin,
      ["-c", "user.name=KAI", "-c", "user.email=kai@localhost", "-c", "commit.gpgsign=false", ...args],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: env.gitDir,
          GIT_WORK_TREE: env.workTree,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    return {
      status: result.status ?? -1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : result.error?.message ?? "",
    };
  }

  function get(id: string): Checkpoint | null {
    const file = manifestPath(id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Checkpoint;
    } catch {
      return null;
    }
  }

  function list(): Checkpoint[] {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return [];
    }
    const found: Checkpoint[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === ".gitconfig-empty") continue;
      const id = entry.slice(0, -".json".length);
      const ckpt = get(id);
      if (ckpt !== null) found.push(ckpt);
    }
    found.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return found;
  }

  function restore(id: string, restoreOpts?: { target?: string }): RestoreResult {
    const checkpoint = get(id);
    if (checkpoint === null) {
      return { ok: false, verified: false, id, reason: `checkpoint not found: ${id}` };
    }
    const dir = shadowDir(id);
    if (!existsSync(dir)) {
      return { ok: false, verified: false, id, reason: `shadow repository is missing: ${dir}` };
    }
    const target = resolve(restoreOpts?.target ?? checkpoint.target);
    if (!existsSync(target)) {
      return { ok: false, verified: false, id, reason: `restore target does not exist: ${target}` };
    }

    // Restore every snapshot file at its recorded content. GIT_DIR is the shadow
    // repo, so the user's own .git is never touched.
    const checkout = gitWithEnv(["checkout", "--force", checkpoint.sha, "--", "."], target, {
      gitDir: dir,
      workTree: target,
    });
    if (checkout.status !== 0) {
      return {
        ok: false,
        verified: false,
        id,
        reason: `git checkout failed: ${checkout.stderr || checkout.stdout}`,
      };
    }

    // Remove files that appeared after the snapshot, so a rollback really
    // returns the tree to the snapshot state. NEVER touches .git.
    const wanted = new Set(checkpoint.manifest.map((f) => f.path));
    let removed = 0;
    function prune(dirToWalk: string, relPrefix: string): void {
      let entries: string[];
      try {
        entries = readdirSync(dirToWalk);
      } catch {
        return;
      }
      for (const name of entries) {
        const abs = join(dirToWalk, name);
        const rel = relPrefix === "" ? name : `${relPrefix}/${name}`;
        if (name === ".git" || rel === ".git") continue;
        let stat;
        try {
          stat = lstatSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          prune(abs, rel);
        } else if (!wanted.has(toPosix(rel))) {
          try {
            rmSync(abs, { force: true });
            removed += 1;
          } catch {
            // best-effort; verification below will catch it
          }
        }
      }
    }
    prune(target, "");

    // Verify HONESTLY against the KAI-computed manifest.
    const after = buildManifest(target, []);
    const mismatches = manifestsEqual(checkpoint.manifest, after.files);
    if (mismatches.length > 0 || after.errors.length > 0) {
      return {
        ok: false,
        verified: false,
        id,
        reason: "restore did not reproduce the snapshot",
        mismatches: [...mismatches, ...after.errors],
      };
    }

    return { ok: true, verified: true, id, restored: checkpoint.manifest.length, removed };
  }

  function remove(id: string): boolean {
    let removedSomething = false;
    try {
      rmSync(shadowDir(id), { recursive: true, force: true });
      removedSomething = true;
    } catch {
      // best-effort
    }
    try {
      rmSync(manifestPath(id), { force: true });
      removedSomething = true;
    } catch {
      // best-effort
    }
    return removedSomething;
  }

  return { root, create, restore, list, get, remove };
}

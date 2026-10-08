// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Safe filesystem primitives for the skills module.
 *
 * Every path a skill touches is derived from a root the caller owns plus an id
 * that has already been validated. Two independent defences exist because a
 * single one is famously easy to get subtly wrong:
 *
 *   1. STRING containment — `resolve()` the candidate and require it to sit
 *      inside the resolved root. This stops `../` traversal.
 *   2. REPARSE containment — resolve the deepest EXISTING ancestor with
 *      `realpathSync` and require the real path to sit inside the real root,
 *      and refuse when any component between root and target is a symlink.
 *      This stops a symlink/junction placed inside the root from reaching out
 *      of it. On Windows a directory junction is created without elevation, so
 *      this is the realistic escape, not a theoretical one.
 *
 * Atomicity: a write goes to a sibling temp file, is fsynced, then `rename`d
 * into place. `rename` within a directory is atomic, so a crash leaves either
 * the old file or the new one — never a half-written file where a reader can
 * see it.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SkillFsError, skillError } from "./errors.ts";

function pathRefusal(root: string, target: string, detail: string): SkillFsError {
  return new SkillFsError(
    skillError(
      "POLICY_DENIED",
      `refusing to touch "${target}": it is not safely contained by the skills root`,
      () => new Date(),
      detail,
    ),
  );
}

/** Resolve `root` + segments and require string-level containment. */
export function safeJoin(root: string, ...segments: string[]): string {
  const absRoot = resolve(root);
  const target = resolve(absRoot, ...segments);
  const rel = relative(absRoot, target);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw pathRefusal(absRoot, target, `resolved outside the root: ${rel}`);
  }
  return target;
}

/** String-level containment check for an already-computed path. */
export function assertInside(root: string, target: string): void {
  const absRoot = resolve(root);
  const absTarget = resolve(target);
  const rel = relative(absRoot, absTarget);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw pathRefusal(absRoot, absTarget, `resolved outside the root: ${rel}`);
  }
}

/**
 * Refuse when `target` reaches outside `root` through a link, or when any
 * component on the way is a symlink. Uses both an lstat walk (named symlinks)
 * and a realpath check (which also resolves junctions, whose lstat may not
 * report as symlinks).
 */
export function assertNoReparseEscape(root: string, target: string): void {
  const absRoot = resolve(root);
  const absTarget = resolve(target);
  assertInside(absRoot, absTarget);

  const rel = relative(absRoot, absTarget);
  if (rel === "") return;

  // 1. No component may itself be a symlink/junction.
  let acc = absRoot;
  for (const part of rel.split(sep)) {
    acc = join(acc, part);
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(acc);
    } catch {
      break; // reached a component that does not exist yet; nothing further to check
    }
    if (stat.isSymbolicLink()) {
      throw pathRefusal(absRoot, absTarget, `component "${acc}" is a symlink`);
    }
  }

  // 2. The real path of the deepest existing ancestor must stay inside the root.
  let realRoot: string;
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    return; // root does not exist yet, so there is nothing installed to escape through
  }
  let probe = absTarget;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    return;
  }
  const realRel = relative(realRoot, realProbe);
  if (realRel !== "" && (realRel.startsWith("..") || isAbsolute(realRel))) {
    throw pathRefusal(absRoot, absTarget, `real path "${realProbe}" escapes the root via a link`);
  }
}

/** mkdir -p guarded by both containment checks. */
export function ensureDir(root: string, dir: string): void {
  assertNoReparseEscape(root, dir);
  mkdirSync(dir, { recursive: true });
}

/**
 * Write `data` atomically: temp file in the same directory, fsync, rename.
 * A reader sees the old content or the new content, never a partial write.
 */
export function atomicWriteFile(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      renameSync(tmp, file);
    } catch {
      // Windows: rename replaces an existing FILE but some filesystems still
      // refuse. Fall back to an explicit replace so a pointer update cannot
      // wedge; the primary path above is the atomic one.
      if (existsSync(file)) unlinkSync(file);
      renameSync(tmp, file);
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(file: string): T | undefined {
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Remove a file or directory without following a link out of the root. */
export function safeRemovePath(root: string, target: string): void {
  assertNoReparseEscape(root, target);
  if (!existsSync(target)) return;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    unlinkSync(target);
    return;
  }
  rmSync(target, { recursive: true, force: true });
}

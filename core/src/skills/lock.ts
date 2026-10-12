// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * A per-skill lock, held across a whole read-modify-write.
 *
 * ## The two details that matter
 *
 * 1. **The lock lives OUTSIDE the skill directory.** If the lock file sat inside
 *    the directory it protects, deleting and recreating that directory would
 *    unlink the lock and hand a second writer the same skill. The lock root is a
 *    sibling (`.locks/`), so a skill's own filesystem lifecycle cannot free it.
 *
 * 2. **The name is the CANONICAL IDENTITY, not the basename.** Two skills can
 *    share a basename in different categories (`writing/summary` and
 *    `research/summary`); naming the lock after the basename would let them
 *    collide and serialise against each other. The name is a hash of the full
 *    id, so distinct ids never share a lock and one id always maps to one lock.
 *
 * ## Staleness
 *
 * A lock records its owner and pid. A lock whose process is gone, or which is
 * older than `staleMs`, is STOLEN rather than honoured forever — a crashed
 * process must not lock a skill out permanently. The theft is reported, never
 * silent.
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "./hash.ts";
import type { SkillResult } from "./types.ts";
import { fail, ok, skillError } from "./errors.ts";

/** How long a lock may be held before another writer may steal it. */
export const DEFAULT_STALE_MS = 5 * 60_000;

interface LockBody {
  id: string;
  ownerId: string;
  pid: number;
  at: string;
}

export interface SkillLocks {
  /**
   * Run `fn` while holding this skill's lock. The lock is released in a
   * `finally`, so a throwing operation still unlocks.
   *
   * The acquisition is immediate-or-refuse: a synchronous store cannot wait
   * without blocking the event loop, so a contended lock returns a clear refusal
   * the caller can retry, instead of spinning.
   */
  withLock<T>(id: string, fn: () => T): SkillResult<T>;
  /** Is the lock currently held by a live, unexpired owner? */
  held(id: string): boolean;
  /** Every lock currently held, for observability. */
  listHeld(): { id: string; ownerId: string; pid: number; at: string }[];
}

function readLock(path: string): LockBody | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockBody>;
    if (typeof parsed.id !== "string" || typeof parsed.ownerId !== "string") return null;
    return {
      id: parsed.id,
      ownerId: parsed.ownerId,
      pid: typeof parsed.pid === "number" ? parsed.pid : -1,
      at: typeof parsed.at === "string" ? parsed.at : new Date(0).toISOString(),
    };
  } catch {
    // An unreadable lock is treated as stale by the caller: a corrupt lock must
    // not block a skill forever.
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    // Signal 0 performs the existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createSkillLocks(opts: {
  /** The skills root. The lock directory is created as its sibling `.locks`. */
  root: string;
  now?: () => Date;
  staleMs?: number;
  ownerId?: string;
}): SkillLocks {
  const now = opts.now ?? (() => new Date());
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const ownerId =
    opts.ownerId ?? `lock_${process.pid}_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const lockDir = join(opts.root, ".locks");

  /**
   * The lock path for an id. The FULL id is hashed, so distinct ids never share
   * a lock and one id always resolves to one path.
   */
  function lockPath(id: string): string {
    return join(lockDir, `${sha256Hex(id).slice(0, 32)}.lock`);
  }

  function isStale(body: LockBody, at: Date): boolean {
    const age = at.getTime() - Date.parse(body.at);
    if (Number.isFinite(age) && age > staleMs) return true;
    return !isProcessAlive(body.pid);
  }

  function held(id: string): boolean {
    const path = lockPath(id);
    if (!existsSync(path)) return false;
    const body = readLock(path);
    if (body === null) return false; // corrupt = stale
    return !isStale(body, now());
  }

  function withLock<T>(id: string, fn: () => T): SkillResult<T> {
    mkdirSync(lockDir, { recursive: true });
    const path = lockPath(id);
    const at = now();
    const body: LockBody = { id, ownerId, pid: process.pid, at: at.toISOString() };
    const payload = JSON.stringify(body);

    let handle: number | undefined;
    try {
      // `wx` is exclusive create: the atomic acquire. No lock file exists -> we
      // own it; it exists -> someone else does.
      handle = openSync(path, "wx");
      writeSync(handle, payload);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return fail(
          skillError("INTERNAL", `could not acquire the lock for skill "${id}": ${String(error)}`, now, "LOCK_FAILED"),
        );
      }
      // Contended. Honour it unless its owner is gone or it is too old.
      const existing = readLock(path);
      if (existing !== null && !isStale(existing, at)) {
        return fail(
          skillError(
            "POLICY_DENIED",
            `skill "${id}" is locked by ${existing.ownerId} (pid ${existing.pid}) since ${existing.at}; ` +
              "another read-modify-write is in progress — retry when it finishes",
            now,
            "LOCK_HELD",
          ),
        );
      }
      // Stale: steal it. The theft is deliberate and recorded in the caller's
      // trace by the reason string, never silent.
      try {
        unlinkSync(path);
      } catch {
        // Another writer stole it between the check and the unlink; we will
        // simply fail to create it below and report contention honestly.
      }
      try {
        handle = openSync(path, "wx");
        writeSync(handle, payload);
      } catch {
        return fail(
          skillError(
            "POLICY_DENIED",
            `skill "${id}" was stolen by another writer while recovering a stale lock — retry`,
            now,
            "LOCK_RACE",
          ),
        );
      }
    } finally {
      if (handle !== undefined) {
        try {
          closeSync(handle);
        } catch {
          // The descriptor is already closed.
        }
      }
    }

    try {
      return ok(fn());
    } finally {
      // Release ONLY if the lock is still ours: a stolen lock must not be
      // deleted out from under its new owner.
      const current = readLock(path);
      if (current !== null && current.ownerId === ownerId) {
        try {
          unlinkSync(path);
        } catch {
          // Already removed.
        }
      }
    }
  }

  return {
    withLock,
    held,
    listHeld() {
      if (!existsSync(lockDir)) return [];
      const out: { id: string; ownerId: string; pid: number; at: string }[] = [];
      const at = now();
      for (const name of listLockFiles(lockDir)) {
        const body = readLock(join(lockDir, name));
        if (body === null || isStale(body, at)) continue;
        out.push({ id: body.id, ownerId: body.ownerId, pid: body.pid, at: body.at });
      }
      return out;
    },
  };
}

/** The `.lock` files in a directory. Kept separate so the main path stays readable. */
function listLockFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".lock"));
  } catch {
    return [];
  }
}

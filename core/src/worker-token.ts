// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The worker credential: the ONE secret the Hermes `pre_tool_call` hook holds.
 *
 * Why a separate credential exists at all
 * ---------------------------------------
 * `POST /worker/authorize` decides whether one tool invocation a delegated
 * worker is about to make may proceed. The caller is Hermes, a separate process
 * that KAI does not control the lifecycle of, so it cannot share the owner
 * token that lives in the desktop app's encrypted store. Handing it the OWNER
 * token would let a compromised hook do everything the owner can do; the whole
 * point of the boundary is that it cannot.
 *
 * This token authorizes exactly one route (`WORKER_TOKEN_ROUTES` in authz.ts)
 * and nothing else. It is therefore safe to put in a file the hook can read:
 * reading it buys the ability to ASK for a decision, never to change what KAI
 * is authorized to do.
 *
 * Failure direction
 * -----------------
 * If no token can be established, no route accepts a worker call and the hook
 * fails closed. That blocks delegated tool use rather than opening it - the
 * direction a security boundary must fail in.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Shorter than this is not a secret; a mismatch must not silently downgrade. */
export const MIN_WORKER_TOKEN_LENGTH = 32;

/**
 * Where the hook looks, by default. Kept in the per-user private app-data
 * directory: the hook runs as the same user, and no broader ACL is involved.
 * `KAI_WORKER_TOKEN_FILE` overrides it for tests and unusual layouts.
 */
export function defaultWorkerTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = typeof env.KAI_WORKER_TOKEN_FILE === "string" ? env.KAI_WORKER_TOKEN_FILE.trim() : "";
  if (override.length > 0) return override;
  if (process.platform === "win32") {
    const base =
      typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim().length > 0
        ? env.LOCALAPPDATA.trim()
        : join(homedir(), "AppData", "Local");
    return join(base, "KAI", "worker-token");
  }
  const state =
    typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim().length > 0
      ? env.XDG_STATE_HOME.trim()
      : join(homedir(), ".local", "state");
  return join(state, "kai", "worker-token");
}

export interface WorkerTokenResolution {
  /** What /worker/authorize verifies against, or undefined when none exists. */
  token: string | undefined;
  /**
   * Where the value came from. `unavailable` means a token was minted but could
   * not be written for the hook: the Core still holds it, and the hook will
   * fail closed because it cannot read it.
   */
  source: "env" | "file" | "created" | "unavailable";
  /** The path the hook is expected to read. */
  file: string;
  /** False only when the token exists in memory but not on disk. */
  persisted: boolean;
}

function usable(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length >= MIN_WORKER_TOKEN_LENGTH ? trimmed : undefined;
}

function readToken(file: string): string | undefined {
  try {
    return usable(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function persist(file: string, token: string): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
    // mode is honoured on POSIX; on Windows the containing app-data directory
    // already carries a per-user ACL, and chmod is best-effort.
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the worker token: an explicit one wins, then an existing file, then a
 * freshly minted one. An explicit token is written to the file so the hook and
 * the Core agree even when the app starts the Core with an env value.
 */
export function resolveWorkerToken(
  input: { explicit?: string; file?: string } = {},
): WorkerTokenResolution {
  const file = input.file ?? defaultWorkerTokenFile();
  const explicit = usable(input.explicit);
  if (explicit !== undefined) {
    const persisted = persist(file, explicit);
    return { token: explicit, source: "env", file, persisted };
  }

  const fromFile = readToken(file);
  if (fromFile !== undefined) return { token: fromFile, source: "file", file, persisted: true };

  const token = randomBytes(32).toString("hex");
  const persisted = persist(file, token);
  return {
    token,
    source: persisted ? "created" : "unavailable",
    file,
    persisted,
  };
}

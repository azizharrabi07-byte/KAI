// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Core ownership: exactly one authoritative control plane (Priority 1/2/9).
 *
 * The failure this exists to prevent is specific and was observed: a second Core
 * was spawned, lost the port to an older Core, exited, and the caller went on
 * assuming its new build was serving. A valid-looking HTTP response from an
 * unknown Core is worse than a loud failure, because it gets believed.
 *
 * So startup now decides deliberately between three outcomes, and never silently:
 *
 *   ADOPTED  a compatible Core already owns the port -> this process stands down
 *   REFUSED  something incompatible owns it          -> explicit non-zero exit
 *   BOUND    nothing owned it                        -> this process is the Core
 *
 * "Compatible" is a protocol-version match, never a 200 from /health: a stale Core
 * answers 200 just as cheerfully as the current one.
 */

import { execFile } from "node:child_process";

export interface RemoteIdentity {
  service?: unknown;
  coreVersion?: unknown;
  buildId?: unknown;
  gitCommit?: unknown;
  protocolVersion?: unknown;
  pid?: unknown;
}

/** A 200 from an unrelated HTTP server must not be mistaken for a Core. */
export function looksLikeCoreIdentity(value: unknown): value is RemoteIdentity {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.service === "kai-core" && typeof record.protocolVersion === "number";
}

/**
 * Ask whatever owns the port who it is. Returns null when nothing answers, when
 * the answer is not a Core, or when it does not answer in time — all three mean
 * "not an adoptable Core", and the caller must not treat them as success.
 */
export async function probeExistingCore(
  baseUrl: string,
  timeoutMs = 1500,
): Promise<RemoteIdentity | null> {
  try {
    const response = await fetch(`${baseUrl}/identity`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return looksLikeCoreIdentity(body) ? body : null;
  } catch {
    return null;
  }
}

/** True for the specific OS error a taken port produces. */
export function isAddressInUse(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /EADDRINUSE|address already in use/i.test(message);
}

/**
 * Which process owns the port, when the platform will say. Best-effort: the
 * message is still explicit without it, so a failure here returns null rather
 * than throwing during a startup failure path.
 */
export function parseOwningPid(netstatOutput: string, port: number): number | null {
  for (const line of netstatOutput.split(/\r?\n/)) {
    // e.g. "  TCP    127.0.0.1:8788    0.0.0.0:0    LISTENING    24816"
    if (!line.includes("LISTENING")) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const local = fields[1] ?? "";
    if (!local.endsWith(`:${port}`)) continue;
    const pid = Number(fields[fields.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

export function owningPidForPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("netstat", ["-ano"], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(parseOwningPid(String(stdout), port));
    });
  });
}

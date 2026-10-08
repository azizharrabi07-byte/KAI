// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Who is this Core? (Phase 1 Priority 3) — and is it HONESTLY that Core?
 *
 * This exists because of a real, expensive failure: a live acceptance run queried
 * `127.0.0.1:8788` and got answers from an OLDER Core — one that was not the build
 * under review — and the results were reported as if they described the new code.
 * A reachable `/health` is NOT proof that the right Core is answering.
 *
 * The deeper failure it closes: `/identity` used to read `build-info.json` FROM
 * DISK ON EVERY CALL. A Core started before a rebuild would therefore report the
 * NEW build id written after it launched, while the code it was running was the
 * OLD one — making build identity a dishonest freshness gate that silently passed
 * a stale process as fresh.
 *
 * The fix has three parts, and only one of them is per-request:
 *
 *   1. The identity the RUNNING PROCESS loaded is captured ONCE, at module load
 *      (== process start), and reported from memory. `buildId`/`gitCommit`/
 *      `coreVersion`/`protocolVersion`/`pid`/`startedAt` are frozen facts about
 *      this process, not about the file on disk or the caller.
 *   2. The on-disk comparison is a SEPARATE, clearly-named pair of fields
 *      (`onDiskBuildId`, `identityMatchesDisk`): re-reading the very stamp file the
 *      process loaded from, so a file rewritten AFTER launch shows up as a
 *      mismatch instead of silently becoming the reported identity.
 *   3. A source-hash-vs-stamp check: the same SHA-256 over `core/src/**` (see
 *      `source-hash.ts`, the ONE implementation) is recomputed for the current
 *      source and compared to what the process loaded. When the source is present
 *      beside the artifact, `artifactMatchesSource` answers "was the artifact I am
 *      running built from the source I can see?" — the question the stale-relay
 *      incident needed answered and could not.
 *
 *   buildId  a CONTENT HASH of the SOURCE, computed at build time. Deliberately
 *            not a timestamp: a timestamp changes on every build even when the
 *            code is identical, and stays the same when it should not. The same
 *            source always produces the same buildId; any code change produces a
 *            different one.
 *   gitCommit  the revision the build came from, so "is this the reviewed build?"
 *            is answerable.
 *   protocolVersion  bumped when the API surface changes shape, so an older Core
 *            can be detected as incompatible rather than merely old.
 *
 * The derivation is a PURE FUNCTION (`deriveIdentity`), so the stale-detection
 * rules are unit-testable without touching the process's real files; the process
 * wrapper (`loadIdentity`) supplies the frozen snapshot and the fresh disk read.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeSourceBuildId } from "./source-hash.ts";

/**
 * Bump when the HTTP surface changes in a way an older client would misread.
 * A client that requires 1 must not adopt a Core reporting anything else.
 */
export const PROTOCOL_VERSION = 1;

/**
 * A one-word verdict on whether this process is honestly the build it claims.
 *
 *   "fresh"       the loaded identity matches the stamp on disk AND, when the
 *                 source is present beside the artifact, the source it was
 *                 (re)built from. Nothing contradictory was found.
 *   "stale"       a comparable check FAILED — the stamp on disk is no longer what
 *                 this process loaded, or the artifact was built from different
 *                 source than the `core/src` sitting next to it.
 *   "unverified"  there is no stamp to compare (running straight from source with
 *                 no build). Not a failure, but not fresh either.
 */
export type Freshness = "fresh" | "stale" | "unverified";

export interface CoreIdentity {
  service: "kai-core";
  coreVersion: string;
  /** Content hash of the SOURCE the process loaded. Same source -> same id. */
  buildId: string;
  gitCommit: string;
  protocolVersion: number;
  pid: number;
  /** ISO-8601, when THIS process started. Not part of identity. */
  startedAt: string;
  /**
   * Absolute path of the `build-info.json` this process loaded at startup, or
   * null when there was none (a source checkout running `tsx`). Names exactly
   * which artifact the reported identity describes.
   */
  identitySource: string | null;
  /** The build id currently written at `identitySource`, read fresh each call. */
  onDiskBuildId: string | null;
  /** True when the stamp on disk still equals the one this process loaded. */
  identityMatchesDisk: boolean;
  /**
   * The source-derived id recomputed from `core/src` beside the artifact at
   * startup, or null when no source is present (the shipped bundle).
   */
  sourceBuildId: string | null;
  /**
   * True when the running artifact was built from the current source; false when
   * it was not; null when it cannot be compared (no source, or no known build id).
   */
  artifactMatchesSource: boolean | null;
  /** Why `artifactMatchesSource` is null, when it is. */
  sourceCheckReason: string | null;
  /** The derived verdict. A stale process never reports "fresh". */
  freshness: Freshness;
}

/**
 * Everything `deriveIdentity` needs: what the process LOADED (frozen), what the
 * stamp file says NOW (fresh), and what the current source hashes to. Separating
 * these three is the whole point — they can disagree, and when they do it must be
 * visible.
 */
export interface StampSnapshot {
  /** The build id this process loaded at startup, or "unknown". */
  loadedBuildId: string;
  loadedGitCommit: string;
  loadedCoreVersion: string;
  loadedProtocolVersion: number;
  /** Path of the stamp the process loaded from, when there was one. */
  identitySource: string | null;
  /** The build id at `identitySource` read FRESH, or null when no stamp file. */
  onDiskBuildId: string | null;
  /** The source-derived id recomputed from core/src, or null when absent. */
  sourceBuildId: string | null;
  /** Why `sourceBuildId` could not be compared, when it could not. */
  sourceCheckReason: string | null;
}

/**
 * The stale-detection rules, as a pure function of the three inputs above.
 *
 * This is the ONLY place a freshness verdict is decided, so it can be tested
 * exhaustively (and a test can drive the "stamp changed after launch" and
 * "artifact built from other source" cases without a second process).
 */
export function deriveIdentity(
  snapshot: StampSnapshot,
  meta: { pid: number; startedAt: string },
): CoreIdentity {
  const buildId = nonEmptyString(snapshot.loadedBuildId) ?? "unknown";

  // The dynamic half. `onDiskBuildId === null` means there is no stamp file to
  // contradict the process (a source run): not a mismatch.
  const identityMatchesDisk =
    snapshot.onDiskBuildId === null ? true : snapshot.onDiskBuildId === buildId;

  let artifactMatchesSource: boolean | null;
  let sourceCheckReason = snapshot.sourceCheckReason;
  if (snapshot.sourceBuildId === null) {
    artifactMatchesSource = null; // reason already explains why (or we add one)
  } else if (buildId === "unknown") {
    artifactMatchesSource = null;
    sourceCheckReason ??= "the running artifact carries no build stamp, so there is nothing to compare the source against";
  } else {
    artifactMatchesSource = snapshot.sourceBuildId === buildId;
    if (artifactMatchesSource) sourceCheckReason = null;
  }

  const freshness: Freshness =
    artifactMatchesSource === false || !identityMatchesDisk
      ? "stale"
      : buildId === "unknown"
        ? "unverified"
        : "fresh";

  return {
    service: "kai-core",
    coreVersion: nonEmptyString(snapshot.loadedCoreVersion) ?? "0.1.0",
    buildId,
    gitCommit: nonEmptyString(snapshot.loadedGitCommit) ?? "unknown",
    protocolVersion:
      typeof snapshot.loadedProtocolVersion === "number" ? snapshot.loadedProtocolVersion : PROTOCOL_VERSION,
    pid: meta.pid,
    startedAt: meta.startedAt,
    identitySource: snapshot.identitySource,
    onDiskBuildId: snapshot.onDiskBuildId,
    identityMatchesDisk,
    sourceBuildId: snapshot.sourceBuildId,
    artifactMatchesSource,
    sourceCheckReason,
    freshness,
  };
}

export interface IdentitySelfCheck {
  ok: boolean;
  /** A process-exit code to use when the check fails, in the relay-guard idiom. */
  code: number;
  detail: string;
}

/**
 * The boot self-check, in the spirit of the relay guard. It asks the one question
 * a Core must be able to answer before it claims to serve: "am I the build of the
 * source I can see, and is the stamp on disk still mine?"
 *
 * A "stale" verdict refuses (ok:false, exit code 5). An "unverified" verdict is
 * allowed — a source checkout with no stamp is not a lie — but is surfaced so a
 * reader is never left believing an unverified process was proven fresh.
 */
export function identitySelfCheck(identity: CoreIdentity): IdentitySelfCheck {
  if (identity.freshness === "stale") {
    const which =
      identity.artifactMatchesSource === false
        ? "the artifact was built from DIFFERENT source than core/src" +
          ` (loaded build ${identity.buildId}, current source ${String(identity.sourceBuildId)})`
        : "the build stamp on disk changed after this process started" +
          ` (loaded build ${identity.buildId}, on-disk now ${String(identity.onDiskBuildId)})`;
    return {
      ok: false,
      code: 5,
      detail:
        `REFUSED: this Core is not honestly the build it claims — ${which}. ` +
        "Rebuild the chain: `cd core && npm run build && npm run bundle`, then `cd app && npx tauri build`.",
    };
  }
  if (identity.freshness === "unverified") {
    return {
      ok: true,
      code: 0,
      detail:
        `identity UNVERIFIED: running build ${identity.buildId}` +
        (identity.sourceCheckReason !== null ? ` — ${identity.sourceCheckReason}` : ""),
    };
  }
  const sourceNote =
    identity.artifactMatchesSource === true
      ? `source matches artifact (${String(identity.sourceBuildId)})`
      : identity.sourceCheckReason !== null
        ? identity.sourceCheckReason
        : "source not comparable";
  return {
    ok: true,
    code: 0,
    detail: `identity FRESH: build ${identity.buildId} matches the stamp on disk; ${sourceNote}`,
  };
}

// ── The process wrapper ───────────────────────────────────────────────────────

interface BuildInfo {
  buildId?: unknown;
  gitCommit?: unknown;
  coreVersion?: unknown;
  protocolVersion?: unknown;
}

/** Where a stamp lives, relative to the module doing the looking. */
function stampCandidates(here: string): string[] {
  return [
    join(here, "build-info.json"),
    join(here, "..", "build-info.json"),
    // Running from source (tests, tsx): the stamp lives next to the compiled
    // output, so look there rather than degrading to "unknown" whenever the code
    // has not been copied beside it.
    join(here, "..", "dist", "build-info.json"),
    join(here, "..", "bundle", "build-info.json"),
  ];
}

/**
 * Read the build stamp written next to the compiled output by
 * `scripts/build-info.mjs`, and REPORT WHICH FILE IT CAME FROM. When it is absent
 * (a checkout running `tsc` by hand, a test run) the identity degrades to explicit
 * "unknown" values rather than inventing a build id — an unknown build must look
 * unknown, never plausible.
 */
function readBuildInfo(here: string): { info: BuildInfo; path: string | null } {
  for (const candidate of stampCandidates(here)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed === "object" && parsed !== null) return { info: parsed as BuildInfo, path: candidate };
    } catch {
      // Try the next location; a missing stamp is not an error.
    }
  }
  return { info: {}, path: null };
}

/** The buildId field of one specific stamp file, or null when unreadable. */
function readBuildIdAt(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { buildId?: unknown };
    return nonEmptyString(parsed.buildId);
  } catch {
    return null;
  }
}

/**
 * Locate the `core/src` tree that produced the artifact this process is running,
 * so the source hash can be recomputed. Returns null for a shipped bundle, which
 * carries only compiled output — there the source genuinely is not present and
 * the check must say so rather than pretend.
 *
 * The module lives in `<core>/dist`, `<core>/bundle` or `<core>/src`; in an
 * installed app it lives in a `core/` resource directory with no `src` beside it.
 */
export function findCoreSourceDir(here: string): string | null {
  const candidates = [join(here, ".."), join(here, "..", ".."), here, join(here, ".")];
  for (const base of candidates) {
    if (!existsSync(join(base, "src")) || !existsSync(join(base, "package.json"))) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { name?: unknown };
      if (pkg.name === "@kai/core") return base;
    } catch {
      // Not a readable package.json; try the next candidate.
    }
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * When THIS process started, captured ONCE at module load.
 *
 * It must not be computed inside `loadIdentity()`: that function is called per
 * request by the `/identity` route, so a `new Date()` there reported the time of
 * the LAST REQUEST as the process start — verified live, two GETs three seconds
 * apart returned `startedAt` values three seconds apart while `pid` was constant.
 * A field whose contract is "when this process started" must be a fact about the
 * process, not about the caller.
 */
const PROCESS_STARTED_AT = new Date().toISOString();
const PROCESS_PID = process.pid;

/**
 * THE IDENTITY THIS PROCESS LOADED, captured ONCE at startup.
 *
 * Everything identity-shaped that `/identity` reports is read from here, never
 * from disk again. This is the fix for "a Core that started before a rebuild
 * reported the new build id": the file may change under a running process, but the
 * process's own identity may not.
 */
const LOADED = readBuildInfo(HERE);

/** The source-hash-vs-stamp verdict, computed ONCE at startup. */
function computeSourceVerdict(loadedBuildId: string): { sourceBuildId: string | null; reason: string | null } {
  const sourceDir = findCoreSourceDir(HERE);
  if (sourceDir === null) {
    return {
      sourceBuildId: null,
      reason:
        "no core/src beside the running artifact (a shipped bundle carries compiled output only); source equality cannot be recomputed here",
    };
  }
  try {
    return { sourceBuildId: computeSourceBuildId(sourceDir), reason: null };
  } catch (error) {
    return {
      sourceBuildId: null,
      reason: `source hash could not be computed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const LOADED_BUILD_ID = nonEmptyString(LOADED.info.buildId) ?? "unknown";
const SOURCE_VERDICT = computeSourceVerdict(LOADED_BUILD_ID);

export function loadIdentity(env: NodeJS.ProcessEnv = process.env): CoreIdentity {
  const info = LOADED.info;
  // The SEPARATE, dynamic half: re-read the exact stamp file this process loaded
  // from, so a rebuild that rewrote it after launch is visible as a mismatch
  // rather than silently becoming the reported identity.
  const onDiskBuildId = LOADED.path === null ? null : readBuildIdAt(LOADED.path);

  const snapshot: StampSnapshot = {
    loadedBuildId: nonEmptyString(info.buildId) ?? "unknown",
    loadedGitCommit: nonEmptyString(info.gitCommit) ?? nonEmptyString(env.KAI_GIT_COMMIT) ?? "unknown",
    loadedCoreVersion: nonEmptyString(info.coreVersion) ?? nonEmptyString(env.npm_package_version) ?? "0.1.0",
    loadedProtocolVersion: typeof info.protocolVersion === "number" ? info.protocolVersion : PROTOCOL_VERSION,
    identitySource: LOADED.path,
    onDiskBuildId,
    sourceBuildId: SOURCE_VERDICT.sourceBuildId,
    sourceCheckReason: SOURCE_VERDICT.reason,
  };
  return deriveIdentity(snapshot, { pid: PROCESS_PID, startedAt: PROCESS_STARTED_AT });
}

/** One line, for a log or a terminal, that says exactly which build is running. */
export function describeIdentity(identity: CoreIdentity): string {
  const source =
    identity.artifactMatchesSource === null
      ? "source-vs-artifact=unverifiable"
      : `source-vs-artifact=${identity.artifactMatchesSource ? "match" : "MISMATCH"}`;
  return (
    `build=${identity.buildId} commit=${identity.gitCommit} protocol=${identity.protocolVersion} pid=${identity.pid}` +
    ` freshness=${identity.freshness} ${source}`
  );
}

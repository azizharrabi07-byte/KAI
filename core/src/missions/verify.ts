// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * verify.ts — the evidence gate that stands between a worker's CLAIM and `COMPLETED`.
 *
 * ## Why this exists
 *
 * A live Hermes run demonstrated the defect: the worker's own output said
 * `read_file was blocked twice by kai-guard`, and the mission was still marked
 * `COMPLETED`. The executor treated "the runner returned ok" as proof, so a worker
 * could hand KAI any sentence at all and be believed.
 *
 * This module closes that. A criterion is settled only by something KAI OBSERVED
 * ITSELF: it reads the named artifact off disk, inside the workspace sandbox, and
 * compares it. Nothing here reads the worker's message, its summary, its reported
 * tool calls, or its `completed` status — those are claims, and a claim cannot settle
 * a criterion.
 *
 * ## Fail-closed by construction
 *
 * The verifier understands exactly two criterion forms, the ones the criteria
 * vocabulary already defines: `file present:` and `file content equals:`. Everything
 * else — a test runner, a human review, a prose deliverable — comes back UNVERIFIED
 * rather than assumed. An unverified criterion blocks completion, so the failure
 * direction of an unrecognised criterion is "do not complete", never "pass".
 */

import { existsSync, readFileSync } from "node:fs";

import { classifyCriterion } from "../goals/criteria.ts";
import { MAX_READ_BYTES, assertInsideWorkspace, defaultWorkspaceRoot } from "../tools/workspace.ts";
import { isAbsolute, resolve } from "node:path";

export interface VerdictForCriterion {
  criterion: string;
  verified: boolean;
  /** One line saying what settled it, or exactly what is missing. */
  reason: string;
}

export interface MissionVerification {
  /** Always "kai-observed": every settled criterion was read by KAI, not reported. */
  source: "kai-observed";
  checkedAt: string;
  verified: string[];
  unverified: VerdictForCriterion[];
  /** True when at least one criterion needed a PERSON, not a file check. */
  needsHuman: boolean;
}

/**
 * Compare an observed file body to a criterion's expected value.
 *
 * Two spellings, matching the criteria vocabulary: `hex:<bytes>` for an exact byte
 * comparison, and a quoted or bare string for a textual one. A quoted value must
 * match EXACTLY after trailing whitespace is trimmed, because a file's final newline
 * is not part of the value a person wrote down.
 */
function matchesExpected(body: string, expected: string): boolean {
  if (expected.toLowerCase().startsWith("hex:")) {
    const want = expected.slice(4).replace(/\s+/g, "").toLowerCase();
    const got = Buffer.from(body, "utf8").toString("hex").toLowerCase();
    return got === want;
  }
  const quoted =
    (expected.startsWith('"') && expected.endsWith('"')) ||
    (expected.startsWith("'") && expected.endsWith("'"));
  const want = quoted ? expected.slice(1, -1) : expected;
  return body.trim() === want.trim();
}

/** Read an artifact inside the sandbox, or say precisely why KAI could not. */
function readArtifact(label: string, path: string): { body: string } | { verdict: VerdictForCriterion } {
  if (path.length === 0) {
    return { verdict: { criterion: label, verified: false, reason: "the criterion names no path" } };
  }
  let target: string;
  try {
    // A criterion is written against the WORKSPACE ("package.json"), not against wherever
    // the Core process happens to be running from. Resolving a relative path against
    // `process.cwd()` made `package.json` mean `<core-dir>/package.json` — outside the
    // declared workspace — so a genuinely satisfied criterion failed verification.
    const anchored = isAbsolute(path) ? path : resolve(defaultWorkspaceRoot(), path);
    // The SAME sandbox every other file tool honours. A criterion cannot become a way
    // to read outside the workspace.
    target = assertInsideWorkspace(anchored);
  } catch (error) {
    return {
      verdict: {
        criterion: label,
        verified: false,
        reason: `the path is outside the workspace sandbox: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  try {
    const raw = readFileSync(target);
    if (raw.byteLength > MAX_READ_BYTES) {
      return { verdict: { criterion: label, verified: false, reason: `the file is larger than ${MAX_READ_BYTES} bytes` } };
    }
    return { body: raw.toString("utf8") };
  } catch (error) {
    return {
      verdict: {
        criterion: label,
        verified: false,
        reason: `KAI could not read the artifact: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/** Split `"<path> = <expected>"` (the shared tail of the value-comparison forms). */
function splitExpectation(rest: string): { path: string; expected: string } {
  const eq = rest.indexOf("=");
  return eq < 0
    ? { path: "", expected: "" }
    : { path: rest.slice(0, eq).trim(), expected: rest.slice(eq + 1).trim() };
}

/** Settle one `file content equals:` criterion: the WHOLE body must equal the spec. */
function checkFileContent(label: string): VerdictForCriterion {
  const { path, expected } = splitExpectation(label.slice("file content equals:".length));
  if (path.length === 0 || expected.length === 0) {
    return { criterion: label, verified: false, reason: 'the criterion needs "<path> = <spec>"' };
  }
  const read = readArtifact(label, path);
  if ("verdict" in read) return read.verdict;
  return matchesExpected(read.body, expected)
    ? { criterion: label, verified: true, reason: "KAI read the artifact and its content matches the criterion" }
    // The VALUE is deliberately not echoed: a mismatch must not become a way to read a
    // file's contents out of the mission record.
    : { criterion: label, verified: false, reason: "KAI read the artifact and its content does NOT match the criterion" };
}

/**
 * Settle one `file json field:` criterion: a FIELD of a JSON artifact equals the spec.
 *
 * A JSON artifact is not compared as a whole body — `package.json` can never equal
 * `0.1.0`. The assertion people actually write is about a field, so that is what this
 * form checks: KAI parses the file and reads exactly that path.
 */
function checkJsonField(label: string): VerdictForCriterion {
  const { path, expected } = splitExpectation(label.slice("file json field:".length));
  const hash = path.indexOf("#");
  if (path.length === 0 || expected.length === 0 || hash <= 0) {
    return { criterion: label, verified: false, reason: 'the criterion needs "<path>#<field> = <value>"' };
  }
  const file = path.slice(0, hash).trim();
  const dotted = path.slice(hash + 1).trim();
  const read = readArtifact(label, file);
  if ("verdict" in read) return read.verdict;

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.body);
  } catch {
    return { criterion: label, verified: false, reason: "KAI read the artifact but it is not valid JSON" };
  }
  let current: unknown = parsed;
  for (const segment of dotted.split(".")) {
    if (current === null || typeof current !== "object") {
      return { criterion: label, verified: false, reason: `KAI read the artifact but "${dotted}" is not present` };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    return { criterion: label, verified: false, reason: `KAI read the artifact but "${dotted}" is not present` };
  }
  const observed = typeof current === "string" ? current : JSON.stringify(current);
  return observed.trim() === expected.replace(/^["']|["']$/g, "").trim()
    ? { criterion: label, verified: true, reason: `KAI read the artifact and "${dotted}" equals the criterion` }
    : { criterion: label, verified: false, reason: `KAI read the artifact and "${dotted}" does NOT equal the criterion` };
}

/** Settle one `file present:` criterion by looking for the path. */
function checkFilePresent(label: string): VerdictForCriterion {
  const path = label.slice("file present:".length).trim();
  if (path.length === 0) return { criterion: label, verified: false, reason: "the criterion names no path" };
  let target: string;
  try {
    // Same anchoring rule as the content check: a criterion names a path in the
    // WORKSPACE, not in whatever directory the Core was launched from.
    target = assertInsideWorkspace(isAbsolute(path) ? path : resolve(defaultWorkspaceRoot(), path));
  } catch (error) {
    return {
      criterion: label,
      verified: false,
      reason: `the path is outside the workspace sandbox: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return existsSync(target)
    ? { criterion: label, verified: true, reason: "KAI observed the path exist" }
    : { criterion: label, verified: false, reason: "KAI looked and the path does not exist" };
}

/**
 * Verify a mission's acceptance criteria against what KAI can observe.
 *
 * An EMPTY criteria list is not a pass: a mission with nothing to check has nothing
 * KAI could have verified, so `unverified` is empty while `verified` is also empty —
 * callers must require at least one VERIFIED criterion, which the executor does.
 */
export function verifyMissionCriteria(
  criteria: readonly string[],
  now: () => Date = () => new Date(),
): MissionVerification {
  const verified: string[] = [];
  const unverified: VerdictForCriterion[] = [];
  let needsHuman = false;

  for (const criterion of criteria) {
    // A JSON artifact is compared by FIELD, so this form is settled before the classifier
    // (which knows only whole-body and presence) could call it unsupported.
    if (criterion.trim().toLowerCase().startsWith("file json field:")) {
      const verdict = checkJsonField(criterion);
      if (verdict.verified) verified.push(verdict.criterion);
      else unverified.push(verdict);
      continue;
    }
    const classified = classifyCriterion(criterion);
    if (classified.kind === "file-content") {
      const verdict = checkFileContent(criterion);
      if (verdict.verified) verified.push(verdict.criterion);
      else unverified.push(verdict);
      continue;
    }
    if (classified.kind === "file-present") {
      const verdict = checkFilePresent(criterion);
      if (verdict.verified) verified.push(verdict.criterion);
      else unverified.push(verdict);
      continue;
    }
    if (classified.kind === "human-review") {
      needsHuman = true;
      unverified.push({
        criterion,
        verified: false,
        reason: "this criterion needs a person's decision; KAI cannot observe it",
      });
      continue;
    }
    unverified.push({ criterion, verified: false, reason: classified.reason });
  }

  return { source: "kai-observed", checkedAt: now().toISOString(), verified, unverified, needsHuman };
}

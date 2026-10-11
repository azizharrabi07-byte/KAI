// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Acceptance criteria, typed by their SETTLEMENT PATH.
 *
 * The defect this closes was found by a live run: the planner produced criteria
 * such as *"the final report states that all tests passed"* — prose with no
 * machine-verifiable settlement path. The worker did its job, KAI verified the
 * bytes it could, and the goal still could not complete, because a criterion
 * existed that nothing could ever settle.
 *
 * A criterion is therefore not free text. Its label decides HOW it is settled, and
 * a label no verifier recognises is `unsupported` — which the architect REFUSES
 * rather than letting it reach execution. The kinds mirror the checks the Outcome
 * Gate actually routes:
 *
 *   file content equals: <path> = hex:4f4b   KAI reads the file and compares bytes
 *   file present: <path>                     KAI stats it in the scoped workspace
 *   npm test | node --test | cargo test …    KAI runs it and requires a POSITIVE test count
 *   human review: <question>                 a person decides; KAI parks and asks
 *   anything else                            UNSUPPORTED — refused at plan time
 *
 * One definition, imported by both the gate and the architect, so the thing that
 * REFUSES a criterion and the thing that SETTLES it cannot drift apart.
 */

/** How a criterion can be settled. */
export type CriterionKind = "file-content" | "file-present" | "test-run" | "human-review" | "unsupported";

export interface ClassifiedCriterion {
  /** The label exactly as the user or the plan wrote it. */
  label: string;
  kind: CriterionKind;
  /** Why this classification, in one line — shown when a plan is refused. */
  reason: string;
}

/** The prefix that routes a criterion to KAI's own byte comparison. */
export const FILE_CONTENT_PREFIX = "file content equals:";

/** The prefix that routes a criterion to an existence check in the workspace. */
export const FILE_PRESENT_PREFIX = "file present:";

/**
 * The prefix the Outcome Contract derives from a deliverable. It is settled by the
 * SAME artifact check (`matchArtifact` against the worker's CHANGED ARTIFACTS), so
 * it is a real settlement path and not prose.
 */
export const DELIVERABLE_PRESENT_PREFIX = "deliverable present:";

/** The generic derived criterion, settled by the same artifact check. */
export const GENERIC_DELIVERABLE_CRITERION = "a user-facing deliverable exists";

/** The prefix that marks a criterion as needing a HUMAN decision. */
export const HUMAN_REVIEW_PREFIX = "human review:";

/**
 * The test/build commands the gate will execute, mirroring `testCommandFor` in
 * `orchestration/orchestrator.ts`. Kept here as the single list both sides use.
 */
export const RUNNABLE_COMMAND_PATTERN = /\b((?:npm|npx|node|cargo|pytest|python|go|tsc)(?:\s+[A-Za-z0-9_./:=-]+)*)/i;

/** True when the label contains a shell metacharacter, so it is never runnable. */
export function hasShellMetacharacters(label: string): boolean {
  return /[;&|><$`(){}\[\]!*?]/.test(label);
}

/** The runnable command a label names, or null. Same shapes the gate executes. */
export function runnableCommandFor(label: string): { command: string; args: string[] } | null {
  if (hasShellMetacharacters(label)) return null;
  const m = RUNNABLE_COMMAND_PATTERN.exec(label);
  if (m === null || m[1] === undefined) return null;
  const parts = m[1].trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const args = parts.slice(1);
  if (command === undefined) return null;
  if (command === "npm" && (args[0] === "test" || (args[0] === "run" && args[1] !== undefined))) return { command, args };
  if (command === "npx" && args[0] === "tsc" && args.includes("--noEmit")) return { command, args };
  if (command === "node" && args[0] === "--test") return { command, args };
  if (command === "cargo" && args[0] === "test") return { command, args };
  // pytest accepts only bare selectors or `-q`: any other flag could change what
  // is collected, and this list exists to be a closed set.
  if (command === "pytest" && args.every((a) => !a.startsWith("-") || a === "-q")) return { command, args };
  if (command === "go" && args[0] === "test") return { command, args };
  if (command === "tsc" && args.includes("--noEmit")) return { command, args };
  return null;
}

/**
 * Classify ONE criterion by its settlement path. Order matters: the explicit
 * prefixes win, then a runnable command, then human review, then unsupported.
 */
export function classifyCriterion(label: string): ClassifiedCriterion {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    return { label, kind: "unsupported", reason: "an empty criterion has no settlement path" };
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith(FILE_CONTENT_PREFIX)) {
    // The gate requires `<path> = <spec>`; a bare prefix is not a check.
    const rest = trimmed.slice(FILE_CONTENT_PREFIX.length);
    return rest.includes("=")
      ? { label: trimmed, kind: "file-content", reason: "KAI reads the file and compares its bytes" }
      : {
          label: trimmed,
          kind: "unsupported",
          reason: `"${FILE_CONTENT_PREFIX}" needs "<path> = <spec>" (for example "= hex:4f4b" or '= "OK"')`,
        };
  }
  if (lower.startsWith(FILE_PRESENT_PREFIX)) {
    const rest = trimmed.slice(FILE_PRESENT_PREFIX.length).trim();
    return rest.length > 0
      ? { label: trimmed, kind: "file-present", reason: "KAI checks that the path exists in the scoped workspace" }
      : { label: trimmed, kind: "unsupported", reason: `"${FILE_PRESENT_PREFIX}" needs a path` };
  }
  if (lower.startsWith(DELIVERABLE_PRESENT_PREFIX)) {
    const rest = trimmed.slice(DELIVERABLE_PRESENT_PREFIX.length).trim();
    return rest.length > 0
      ? {
          label: trimmed,
          kind: "file-present",
          reason: "KAI checks the artifact the worker named in CHANGED ARTIFACTS against the workspace",
        }
      : { label: trimmed, kind: "unsupported", reason: `"${DELIVERABLE_PRESENT_PREFIX}" needs a deliverable` };
  }
  if (lower === GENERIC_DELIVERABLE_CRITERION) {
    return {
      label: trimmed,
      kind: "file-present",
      reason: "the derived criterion: KAI checks that the worker produced a named artifact",
    };
  }
  if (lower.startsWith(HUMAN_REVIEW_PREFIX)) {
    const question = trimmed.slice(HUMAN_REVIEW_PREFIX.length).trim();
    return question.length > 0
      ? { label: trimmed, kind: "human-review", reason: "a person must decide; KAI parks the goal and asks" }
      : { label: trimmed, kind: "unsupported", reason: `"${HUMAN_REVIEW_PREFIX}" needs the question to ask` };
  }
  const cmd = runnableCommandFor(trimmed);
  if (cmd !== null) {
    return {
      label: trimmed,
      kind: "test-run",
      reason: `KAI runs \`${cmd.command} ${cmd.args.join(" ")}\` and requires a positive test count, not just exit 0`,
    };
  }
  // Nothing routes it. This is the case the live planner produced.
  return {
    label: trimmed,
    kind: "unsupported",
    reason:
      "no verifier settles this criterion. Rewrite it as a check KAI can perform " +
      `("${FILE_CONTENT_PREFIX} …", "${FILE_PRESENT_PREFIX} …", a runnable test command), ` +
      `or declare it "${HUMAN_REVIEW_PREFIX} <question>" if a person must judge it`,
  };
}

/** Classify a list, preserving order and duplicates. */
export function classifyCriteria(labels: readonly string[]): ClassifiedCriterion[] {
  return labels.map(classifyCriterion);
}

/** The criteria a plan may NOT execute: nothing can settle them. */
export function unsupportedCriteria(labels: readonly string[]): ClassifiedCriterion[] {
  return classifyCriteria(labels).filter((c) => c.kind === "unsupported");
}

/** True when a criterion needs a person, so it can never be auto-settled. */
export function isHumanReview(label: string): boolean {
  return classifyCriterion(label).kind === "human-review";
}


/**
 * The filesystem paths a criterion names, so a run can PROVE its workspace before
 * dispatch: the artifact must not already exist (a stale file from an earlier run
 * must never satisfy a new goal) and it must not escape the authorized root.
 */
export function artifactPathsFor(label: string): string[] {
  const trimmed = label.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith(FILE_PRESENT_PREFIX)) {
    const path = trimmed.slice(FILE_PRESENT_PREFIX.length).trim();
    return path.length > 0 ? [path] : [];
  }
  if (lower.startsWith(FILE_CONTENT_PREFIX)) {
    const rest = trimmed.slice(FILE_CONTENT_PREFIX.length);
    const eq = rest.indexOf("=");
    if (eq < 0) return [];
    const path = rest.slice(0, eq).trim();
    return path.length > 0 ? [path] : [];
  }
  // A deliverable name is only a PATH when it looks like one; a prose deliverable
  // has no artifact to prove, so it contributes nothing to the workspace proof.
  if (lower.startsWith(DELIVERABLE_PRESENT_PREFIX)) {
    const name = trimmed.slice(DELIVERABLE_PRESENT_PREFIX.length).trim();
    return /[./\\]/.test(name) && !/\s/.test(name) ? [name] : [];
  }
  return [];
}

/** Every artifact path named by a set of criteria, de-duplicated. */
export function artifactPathsForAll(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    for (const path of artifactPathsFor(label)) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}


/**
 * The path a `file present:` criterion names, or null.
 *
 * It is checked DIRECTLY against the workspace — KAI stats the path itself — so
 * presence does not depend on the worker remembering to name the artifact in its
 * handoff. That dependency was a real defect: a worker that created the file
 * correctly still left the criterion unmet because its handoff named something
 * else. `deliverable present:` keeps the handoff-based check, because THAT
 * criterion is about the worker's claim.
 */
export function presencePathFor(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed.toLowerCase().startsWith(FILE_PRESENT_PREFIX)) return null;
  const path = trimmed.slice(FILE_PRESENT_PREFIX.length).trim();
  return path.length > 0 ? path : null;
}

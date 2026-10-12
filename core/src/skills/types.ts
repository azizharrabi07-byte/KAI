// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core skills — KAI-owned contracts (Phase 2 Part C).
 *
 * These shapes live OUTSIDE the frozen `shared/contracts.ts` on purpose: they do
 * not cross the Core <-> desktop IPC boundary yet, so they sit beside the code
 * that validates them, exactly as the MCP module does with `mcp/types.ts`.
 *
 * The one idea that shapes every type below: a skill has METADATA and a BODY,
 * and they are different things. A listing never carries a body, a `relevant()`
 * result never carries a body, and the body is only ever read by `load()`. That
 * is what "progressive disclosure" means here, and it is a property of the
 * TYPES, not a convention — there is no field in `SkillMetadata` that could hold
 * a body even by mistake.
 */

import type { KaiError } from "../shared/contracts.ts";

// ── Identity / lifecycle ──────────────────────────────────────────────────────

/** Operator intent. A disabled skill stays on disk and is inspectable, but is never loaded or offered. */
export type SkillStatus = "enabled" | "disabled";

/**
 * Where a skill came from. Free-form but conventional:
 *   "builtin"          shipped with KAI
 *   "user"             authored/registered directly by a human
 *   "learned"          produced by the learning pipeline (ALWAYS via approval)
 *   "discovered:<path>" found on disk
 */
export type SkillSource = string;

// ── Validation issues ─────────────────────────────────────────────────────────

/**
 * The precise reason a SKILL.md was refused. Kept as a closed union so a test
 * (and a UI) can assert an exact rejection class rather than matching prose.
 */
export type SkillIssueCode =
  | "NOT_A_STRING"
  | "OVERSIZED"
  | "INVISIBLE_UNICODE"
  | "ENCODED_PAYLOAD"
  | "DOWNLOAD_EXEC"
  | "PATH_TRAVERSAL"
  | "INVALID_ID"
  | "FRONTMATTER_MISSING"
  | "FRONTMATTER_INVALID"
  | "MISSING_NAME"
  | "MISSING_DESCRIPTION"
  | "INVALID_NAME"
  | "INVALID_KEY"
  | "EMPTY_BODY"
  | "TOO_MANY_TAGS";

export interface SkillIssue {
  code: SkillIssueCode;
  message: string;
  detail?: string;
}

/**
 * Result shape for every fallible skill operation. Mirrors the MCP module: a
 * refusal is a VALUE, never a throw, so a caller that got `{ok:false}` knows
 * nothing was half-written.
 */
export type SkillResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: KaiError; issues?: SkillIssue[] };

// ── Metadata (never a body) ───────────────────────────────────────────────────

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  /**
   * WHY the skill exists (one line): what job it does for KAI. Optional;
   * when present it is scored by `relevant()` alongside the description.
   */
  purpose?: string;
  /**
   * Tool ids the skill may use (e.g. `filesystem.search`). Advisory: shown in
   * the UI and to the model, and a future plane may scope execution to it —
   * but every tool still passes the registry boundary regardless.
   */
  tools?: readonly string[];
  /** Hard limits the skill declares for itself (shown, never silently waived). */
  constraints?: readonly string[];
  tags: readonly string[];
  /** Typed applicability conditions, when the frontmatter declared any. */
  conditions?: SkillConditions;
  /** The contract version the conditions were read under. */
  conditionsVersion?: number;
  /** Declared version from frontmatter, when present. */
  version?: string;
  source: SkillSource;
  /** SHA-256 (hex) of the EXACT installed SKILL.md bytes. */
  contentHash: string;
  status: SkillStatus;
  /** Current revision number, 1-based. */
  revision: number;
  /** How many revisions exist (rollback history). */
  revisionCount: number;
  installedAt: string;
  updatedAt: string;
  /** Installation directory for the current revision (metadata, not content). */
  path: string;
}

/** One immutable, content-addressed revision. Bytes never change once written. */
export interface SkillRevisionView {
  revision: number;
  sha256: string;
  installedAt: string;
  source: SkillSource;
  /** The approval id that authorised this revision, when it was a learned install. */
  approvedBy?: string;
  /** The staging id the bytes came from, when this revision came through staging. */
  fromStagedId?: string;
}

/** Metadata plus the revision history. Still no body. */
export interface SkillRecord extends SkillMetadata {
  revisions: SkillRevisionView[];
}

/** The body, returned ONLY by `load()`. */
export interface LoadedSkill {
  metadata: SkillMetadata;
  body: string;
  path: string;
}

/** A parsed, validated SKILL.md. */
/**
 * The version of the applicability-metadata contract.
 *
 * It exists so a future change to the meaning of a condition can be told apart
 * from today's: a skill carrying version 1 is interpreted by version-1 rules,
 * and an unknown version is reported rather than guessed at.
 */
export const SKILL_CONDITIONS_VERSION = 1;

/**
 * Where a skill applies. Every field is OPTIONAL and an absent field is not a
 * constraint, so a skill with no conditions applies everywhere.
 *
 * These are EXPLICIT frontmatter fields (`platforms:`, `environments:`,
 * `domains:`). The older convention of encoding the same thing in `tags:`
 * (`platform:linux`) is still read for backward compatibility, but the explicit
 * field always wins and a disagreement between the two is reported.
 */
export interface SkillConditions {
  /** Platform ids, as `process.platform` reports them (`win32`, `linux`, `darwin`). */
  platforms?: readonly string[];
  /** Environments (`ci`, `local`, ...). An UNKNOWN environment does not exclude. */
  environments?: readonly string[];
  /** Task domains (`research`, `coding`, ...). */
  domains?: readonly string[];
  /** Tool ids the skill needs. A missing tool makes it ineligible. */
  tools?: readonly string[];
}

export interface ParsedSkill {
  /** The id the caller supplied, when one was validated alongside the content. */
  id?: string;
  name: string;
  description: string;
  version?: string;
  purpose?: string;
  tools?: readonly string[];
  constraints?: readonly string[];
  tags: readonly string[];
  /** Typed applicability conditions, when the frontmatter declared any. */
  conditions?: SkillConditions;
  /** The contract version the conditions were read under. */
  conditionsVersion?: number;
  frontmatter: Readonly<Record<string, string>>;
  body: string;
  /** The exact input string; hashing this is hashing the file. */
  markdown: string;
}

// ── Staging (C4: the exact-byte approval pipeline) ───────────────────────────

/** What the human is asked to approve — the whole staged content, not a summary. */
export interface StagedSkillReview {
  name: string;
  description: string;
  purpose?: string;
  tools?: readonly string[];
  constraints?: readonly string[];
  tags: readonly string[];
  body: string;
}

export interface StagedSkillMeta {
  stagedId: string;
  skillId: string;
  /** SHA-256 of the EXACT staged SKILL.md bytes. This is what an approval binds to. */
  sha256: string;
  source: SkillSource;
  stagedAt: string;
  expiresAt: string;
  /** Set once an approval has been requested for this staging. */
  approvalId?: string;
  name: string;
  description: string;
  tags: readonly string[];
}

export interface StagedSkillView extends StagedSkillMeta {
  path: string;
  review: StagedSkillReview;
}

/** Returned by `stage()`. The caller holds `sha256` to bind the approval to. */
export interface StageReceipt {
  stagedId: string;
  sha256: string;
  skillId: string;
}

/** Returned by `installApproved()`. */
export interface InstallReceipt {
  skillId: string;
  revision: number;
  sha256: string;
  installedAt: string;
  /** The approval id the install was bound to. */
  approvedBy: string;
}

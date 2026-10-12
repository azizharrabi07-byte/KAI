// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The skills filesystem store.
 *
 * On-disk layout under a caller-owned root:
 *
 *   registry.json                       metadata + status + the revision history
 *   installed/<id>/<sha256>/SKILL.md    one IMMUTABLE, content-addressed revision
 *   staging/<stagedId>/SKILL.md         staged bytes awaiting approval
 *   staging/<stagedId>/stage.json       the staging record (sha, expiry, approval)
 *
 * Two properties are structural, not conventions:
 *
 *   - A revision directory is named by the SHA-256 of its own bytes, so its
 *     content can never change: a different byte string is a different
 *     directory. Rolling back only moves the pointer in `registry.json`; it
 *     never rewrites history.
 *   - Metadata (name/description/tags) is stored in the index at install time,
 *     so `list()`/`relevant()` never read a body. Only `readRevisionBody()` —
 *     which `load()` calls — opens a SKILL.md, and it fires the `onBodyRead`
 *     hook so that "the body loads only when asked" is observable in a test.
 *
 * Path safety (traversal and symlink/junction escape) is enforced by `paths.ts`
 * on every access; this module never builds a path without checking it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillFsError, skillError } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import {
  assertNoReparseEscape,
  atomicWriteJson,
  atomicWriteFile,
  ensureDir,
  readJson,
  safeJoin,
  safeRemovePath,
} from "./paths.ts";
import { isSafeSkillId } from "./validate.ts";

export interface StoredRevision {
  revision: number;
  sha256: string;
  installedAt: string;
  source: string;
  approvedBy?: string;
  fromStagedId?: string;
}

export interface StoredSkill {
  id: string;
  name: string;
  description: string;
  purpose?: string;
  tools?: string[];
  constraints?: string[];
  tags: string[];
  version?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  disabled: boolean;
  currentSha: string;
  revisions: StoredRevision[];
}

export interface StagedMeta {
  stagedId: string;
  skillId: string;
  sha256: string;
  source: string;
  stagedAt: string;
  expiresAt: string;
  approvalId?: string;
  name: string;
  description: string;
  tags: string[];
  /**
   * The security verdict for THESE bytes, recorded at stage time and re-checked
   * at activation. `sha256` inside it is the hash of the scanned candidate, so a
   * verdict can never be carried over to different bytes.
   */
  scan?: {
    outcome: "CLEAN" | "WARNING" | "BLOCKED" | "ERROR";
    sha256: string;
    reason: string;
    scannedAt: string;
    findings: { code: string; severity: "warning" | "blocked"; message: string; evidence: string; line?: number }[];
    error?: string;
  };
}

/** Test/observability seams. Production passes neither. */
export interface SkillStoreHooks {
  /** Called after a SKILL.md body is read from disk (i.e. by `load`). */
  onBodyRead?: (path: string) => void;
  /** Crash-injection points used to prove the atomic-install invariant. */
  faults?: {
    /** Thrown just before a freshly written revision directory is published. */
    beforeRevisionRename?: () => void;
  };
}

export interface SkillStore {
  readonly root: string;
  listSkills(): StoredSkill[];
  getSkill(id: string): StoredSkill | undefined;
  putSkill(skill: StoredSkill): void;
  removeSkill(id: string): void;
  hasSkill(id: string): boolean;

  revisionPath(id: string, sha256: string): string;
  revisionExists(id: string, sha256: string): boolean;
  writeRevisionAtomic(id: string, sha256: string, markdown: string): void;
  /** Reads the installed body and fires `onBodyRead`. Throws SkillFsError. */
  readRevisionBody(id: string, sha256: string): string;
  revisionDir(id: string): string;

  stageWrite(meta: StagedMeta, markdown: string): void;
  stageRead(stagedId: string): { markdown: string; meta: StagedMeta } | undefined;
  stageUpdate(stagedId: string, patch: Partial<StagedMeta>): StagedMeta | undefined;
  stageDelete(stagedId: string): void;
  stagePath(stagedId: string): string;
  listStageIds(): string[];
}

interface SkillIndex {
  version: 1;
  skills: StoredSkill[];
}

const INDEX_FILE = "registry.json";

function fsFail(codeMessage: string, at: () => Date, detail?: string): SkillFsError {
  return new SkillFsError(skillError("STORAGE_FAILED", codeMessage, at, detail));
}

export function createSkillStore(opts: { root: string; now?: () => Date; hooks?: SkillStoreHooks }): SkillStore {
  const root = opts.root;
  const now = opts.now ?? (() => new Date());
  const hooks = opts.hooks ?? {};

  const indexPath = safeJoin(root, INDEX_FILE);
  const installedRoot = safeJoin(root, "installed");
  const stagingRoot = safeJoin(root, "staging");

  function loadIndex(): StoredSkill[] {
    const index = readJson<SkillIndex>(indexPath);
    if (index === undefined || !Array.isArray(index.skills)) return [];
    return index.skills.filter(
      (entry): entry is StoredSkill =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as StoredSkill).id === "string" &&
        typeof (entry as StoredSkill).currentSha === "string" &&
        Array.isArray((entry as StoredSkill).revisions),
    );
  }

  function saveIndex(skills: StoredSkill[]): void {
    ensureDir(root, root);
    assertNoReparseEscape(root, indexPath);
    atomicWriteJson(indexPath, { version: 1, skills } satisfies SkillIndex);
  }

  function getSkill(id: string): StoredSkill | undefined {
    return loadIndex().find((entry) => entry.id === id);
  }

  function hasSkill(id: string): boolean {
    return getSkill(id) !== undefined;
  }

  function putSkill(skill: StoredSkill): void {
    if (!isSafeSkillId(skill.id)) throw fsFail(`unsafe skill id "${skill.id}"`, now);
    const skills = loadIndex();
    const at = skills.findIndex((entry) => entry.id === skill.id);
    if (at >= 0) skills[at] = skill;
    else skills.push(skill);
    saveIndex(skills);
  }

  function removeSkill(id: string): void {
    const skills = loadIndex().filter((entry) => entry.id !== id);
    saveIndex(skills);
  }

  function revisionDir(id: string): string {
    if (!isSafeSkillId(id)) throw fsFail(`unsafe skill id "${id}"`, now);
    const dir = safeJoin(installedRoot, id);
    assertNoReparseEscape(root, dir);
    return dir;
  }

  function revisionPath(id: string, sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw fsFail(`unsafe revision hash "${sha256}"`, now);
    const file = safeJoin(installedRoot, id, sha256, "SKILL.md");
    assertNoReparseEscape(root, file);
    return file;
  }

  function revisionExists(id: string, sha256: string): boolean {
    return existsSync(revisionPath(id, sha256));
  }

  /**
   * Publish an immutable revision. If the revision directory already exists we
   * verify the bytes match (a mismatch is impossible for the same hash, so it
   * means the on-disk revision was tampered with) and leave it untouched.
   */
  function writeRevisionAtomic(id: string, sha256: string, markdown: string): void {
    const finalDir = safeJoin(installedRoot, id, sha256);
    assertNoReparseEscape(root, finalDir);

    if (existsSync(finalDir)) {
      const existing = readFileSync(safeJoin(finalDir, "SKILL.md"), "utf8");
      if (sha256Hex(existing) !== sha256) {
        throw fsFail(
          `revision ${sha256.slice(0, 12)} of skill "${id}" on disk does not match its hash`,
          now,
          "the stored revision was modified",
        );
      }
      return;
    }

    const idDir = safeJoin(installedRoot, id);
    ensureDir(root, idDir);
    const tmp = safeJoin(installedRoot, id, `.tmp-${sha256.slice(0, 8)}-${Date.now().toString(36)}`);
    assertNoReparseEscape(root, tmp);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "SKILL.md"), markdown, "utf8");

    hooks.faults?.beforeRevisionRename?.();

    try {
      renameSync(tmp, finalDir);
    } catch (error) {
      // Best-effort cleanup; the failure is reported as a value by the caller.
      try {
        safeRemovePath(root, tmp);
      } catch {
        /* ignore */
      }
      throw error instanceof SkillFsError
        ? error
        : fsFail(`could not publish revision for "${id}"`, now, error instanceof Error ? error.message : String(error));
    }
  }

  function readRevisionBody(id: string, sha256: string): string {
    const file = revisionPath(id, sha256);
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch (error) {
      throw fsFail(
        `could not read skill "${id}" revision ${sha256.slice(0, 12)}`,
        now,
        error instanceof Error ? error.message : String(error),
      );
    }
    hooks.onBodyRead?.(file);
    return body;
  }

  // ── Staging ─────────────────────────────────────────────────────────────────

  function stageDir(stagedId: string): string {
    if (!isSafeSkillId(stagedId)) throw fsFail(`unsafe staging id "${stagedId}"`, now);
    const dir = safeJoin(stagingRoot, stagedId);
    assertNoReparseEscape(root, dir);
    return dir;
  }

  function stageWrite(meta: StagedMeta, markdown: string): void {
    const dir = stageDir(meta.stagedId);
    ensureDir(root, dir);
    atomicWriteFile(join(dir, "SKILL.md"), markdown);
    atomicWriteJson(join(dir, "stage.json"), meta);
  }

  function stageRead(stagedId: string): { markdown: string; meta: StagedMeta } | undefined {
    const dir = stageDir(stagedId);
    const meta = readJson<StagedMeta>(join(dir, "stage.json"));
    if (meta === undefined) return undefined;
    let markdown: string;
    try {
      markdown = readFileSync(join(dir, "SKILL.md"), "utf8");
    } catch {
      return undefined;
    }
    return { markdown, meta };
  }

  function stageUpdate(stagedId: string, patch: Partial<StagedMeta>): StagedMeta | undefined {
    const current = stageRead(stagedId);
    if (current === undefined) return undefined;
    const next: StagedMeta = { ...current.meta, ...patch };
    atomicWriteJson(join(stageDir(stagedId), "stage.json"), next);
    return next;
  }

  function stageDelete(stagedId: string): void {
    let dir: string;
    try {
      dir = stageDir(stagedId);
    } catch {
      return; // an unsafe id names nothing we would ever have written
    }
    safeRemovePath(root, dir);
  }

  function stagePath(stagedId: string): string {
    return stageDir(stagedId);
  }

  function listStageIds(): string[] {
    if (!existsSync(stagingRoot)) return [];
    try {
      return readdirSync(stagingRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  return {
    root,
    listSkills: loadIndex,
    getSkill,
    putSkill,
    removeSkill,
    hasSkill,
    revisionPath,
    revisionExists,
    writeRevisionAtomic,
    readRevisionBody,
    revisionDir,
    stageWrite,
    stageRead,
    stageUpdate,
    stageDelete,
    stagePath,
    listStageIds,
  };
}

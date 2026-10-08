// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The staged-approval install pipeline (spec Part C4) — the most important part
 * of the skills system.
 *
 * THE PIPELINE, exactly:
 *
 *   candidate → redact → validate → STAGE → HUMAN APPROVAL
 *             → SHA-256 binding of the exact approved bytes → INSTALL
 *             → immutable revision
 *
 * THE RULE THAT MAKES IT MEAN ANYTHING: the bytes the human approved must be
 * the exact bytes installed. That is enforced by hashing, not by trusting a
 * path or a label:
 *
 *   - `stage()` writes the bytes and returns their SHA-256.
 *   - `requestInstallApproval(stagedId, sha256)` puts that SHA-256 into the
 *     approval the human sees and records it on the staging record.
 *   - `installApproved()` re-reads the staged bytes, re-hashes them, and refuses
 *     when the recalculated hash differs from BOTH the hash the caller passed
 *     and the hash on the staging record. So editing a staged skill after the
 *     approval was granted cannot install the edited bytes.
 *
 * Every install is an IMMUTABLE, content-addressed revision
 * (`installed/<id>/<sha256>/SKILL.md`), so a crash mid-install leaves either the
 * previous revision or the new one as the current pointer — never a half-written
 * skill. Rollback moves the pointer; it never rewrites bytes.
 *
 * Fail closed, like the MCP adapter: with no approval service wired, an install
 * is refused rather than allowed. A learned skill with no human in the loop is
 * precisely what this module exists to prevent.
 */

import type { ApprovalService } from "../approvals/service.ts";
import type { Approval } from "../shared/contracts.ts";
import { fail, guard, ok, skillError } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import type { SkillStore, StagedMeta, StoredSkill } from "./store.ts";
import { isSafeSkillId, parseSkillMarkdown, validateSkillId } from "./validate.ts";
import type {
  InstallReceipt,
  SkillResult,
  StageReceipt,
  StagedSkillMeta,
  StagedSkillView,
} from "./types.ts";

/** The tool id an install approval is bound to. One approval authorises one install. */
export const SKILL_INSTALL_TOOL_ID = "skill.install";

/** How long staged bytes stay approvable before they must be re-staged. */
export const DEFAULT_STAGE_TTL_MS = 15 * 60_000;

export interface SkillStaging {
  /** Validate, redact-free write of already-prepared bytes. Returns {stagedId, sha256}. */
  stage(input: { id: string; markdown: string; source?: string; ttlMs?: number }): SkillResult<StageReceipt>;
  inspectStaged(stagedId: string): SkillResult<StagedSkillView>;
  listStaged(): StagedSkillMeta[];
  discardStaged(stagedId: string): SkillResult<true>;
  /** Creates the human approval bound to `sha256`. Returns the approval id. */
  requestInstallApproval(stagedId: string, sha256: string): SkillResult<{ stagedId: string; sha256: string; approvalId: string }>;
  /** Installs ONLY if the staged bytes still hash to the approved sha256 and the approval is APPROVED. */
  installApproved(input: { stagedId: string; sha256: string; approvalId: string }): SkillResult<InstallReceipt>;
  rollback(id: string): SkillResult<{ skillId: string; revision: number; sha256: string }>;
}

function normalizeTtl(ttlMs: unknown): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) return DEFAULT_STAGE_TTL_MS;
  return ttlMs;
}

export function createSkillStaging(opts: {
  store: SkillStore;
  approvals?: ApprovalService;
  now?: () => Date;
  idFactory?: () => string;
  stageTtlMs?: number;
  /** Crash-injection seam: thrown between publishing a revision and swapping the pointer. */
  faults?: { beforePointerSwap?: () => void };
}): SkillStaging {
  const { store } = opts;
  const now = opts.now ?? (() => new Date());
  const defaultTtlMs = normalizeTtl(opts.stageTtlMs);
  let seq = 0;
  const idFactory = opts.idFactory ?? (() => `stg_${now().getTime().toString(36)}_${(seq++).toString(36)}`);

  function readStage(stagedId: string): SkillResult<{ markdown: string; meta: StagedMeta }> {
    if (!isSafeSkillId(stagedId)) {
      return fail(skillError("VALIDATION_FAILED", `staging id "${stagedId}" is not usable`, now, "INVALID_ID"));
    }
    const record = store.stageRead(stagedId);
    if (record === undefined) {
      return fail(skillError("NOT_FOUND", `no staged skill "${stagedId}" exists; it may have been consumed or discarded`, now, "STALE_STAGE"));
    }
    return ok(record);
  }

  function isExpired(meta: StagedMeta, at: Date): boolean {
    const expires = Date.parse(meta.expiresAt);
    return Number.isFinite(expires) && expires <= at.getTime();
  }

  function verifyApproval(meta: StagedMeta, approvalId: string): SkillResult<Approval> {
    const approvals = opts.approvals;
    if (approvals === undefined) {
      return fail(
        skillError("POLICY_DENIED", "no approval service is wired, so a skill can never be installed without a human", now, "NO_APPROVER"),
      );
    }
    if (meta.approvalId === undefined || meta.approvalId !== approvalId) {
      return fail(
        skillError(
          "POLICY_DENIED",
          `approval "${approvalId}" was not requested for staged skill "${meta.stagedId}"`,
          now,
          "APPROVAL_MISMATCH",
        ),
      );
    }
    const approval = approvals.get(approvalId);
    if (approval === null) {
      return fail(skillError("APPROVAL_REQUIRED", `approval "${approvalId}" is unknown`, now, "UNKNOWN_APPROVAL"));
    }
    if (approval.toolId !== SKILL_INSTALL_TOOL_ID) {
      return fail(
        skillError("POLICY_DENIED", `approval "${approvalId}" authorises "${approval.toolId}", not a skill install`, now, "WRONG_TOOL"),
      );
    }
    if (approval.status === "REJECTED") {
      return fail(skillError("POLICY_DENIED", `approval "${approvalId}" was rejected`, now, "REJECTED"));
    }
    if (approval.status === "EXPIRED") {
      return fail(skillError("POLICY_DENIED", `approval "${approvalId}" expired before use`, now, "EXPIRED"));
    }
    if (approval.status !== "APPROVED") {
      return fail(skillError("APPROVAL_REQUIRED", `approval "${approvalId}" is still ${approval.status}`, now, "PENDING"));
    }
    if (!approval.reason.includes(meta.sha256)) {
      return fail(
        skillError("POLICY_DENIED", `approval "${approvalId}" is not bound to these exact bytes`, now, "NOT_BOUND"),
      );
    }
    return ok(approval);
  }

  function stage(input: { id: string; markdown: string; source?: string; ttlMs?: number }): SkillResult<StageReceipt> {
    return guard(now, () => {
      const idIssues = validateSkillId(input.id);
      if (idIssues.length > 0) {
        return fail(skillError("VALIDATION_FAILED", `skill id refused: ${idIssues[0]?.message ?? "invalid"}`, now, "INVALID_ID"), idIssues);
      }
      // Validate BEFORE writing: an invalid candidate writes nothing at all.
      const parsed = parseSkillMarkdown(input.markdown, { id: input.id });
      if (!parsed.ok) return parsed;

      const sha256 = sha256Hex(input.markdown);
      const stagedId = idFactory();
      if (!isSafeSkillId(stagedId)) {
        return fail(skillError("INTERNAL", `generated staging id "${stagedId}" is not usable`, now));
      }
      const at = now();
      const ttl = normalizeTtl(input.ttlMs ?? defaultTtlMs);
      const meta: StagedMeta = {
        stagedId,
        skillId: input.id,
        sha256,
        source: input.source ?? "learned",
        stagedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + ttl).toISOString(),
        name: parsed.value.name,
        description: parsed.value.description,
        tags: [...parsed.value.tags],
      };
      store.stageWrite(meta, input.markdown);
      return ok({ stagedId, sha256, skillId: input.id });
    });
  }

  function inspectStaged(stagedId: string): SkillResult<StagedSkillView> {
    return guard(now, () => {
      const read = readStage(stagedId);
      if (!read.ok) return read;
      const parsed = parseSkillMarkdown(read.value.markdown, { id: read.value.meta.skillId });
      if (!parsed.ok) return parsed;
      const view: StagedSkillView = {
        ...read.value.meta,
        path: store.stagePath(stagedId),
        review: {
          name: parsed.value.name,
          description: parsed.value.description,
          ...(parsed.value.purpose !== undefined ? { purpose: parsed.value.purpose } : {}),
          ...(parsed.value.tools !== undefined ? { tools: [...parsed.value.tools] } : {}),
          ...(parsed.value.constraints !== undefined ? { constraints: [...parsed.value.constraints] } : {}),
          tags: [...parsed.value.tags],
          body: parsed.value.body,
        },
      };
      return ok(view);
    });
  }

  function listStaged(): StagedSkillMeta[] {
    const out: StagedSkillMeta[] = [];
    for (const stagedId of store.listStageIds()) {
      const read = store.stageRead(stagedId);
      if (read !== undefined) out.push(read.meta);
    }
    return out.sort((a, b) => (a.stagedAt < b.stagedAt ? -1 : 1));
  }

  function discardStaged(stagedId: string): SkillResult<true> {
    return guard(now, () => {
      if (!store.stageRead(stagedId)) {
        return fail(skillError("NOT_FOUND", `no staged skill "${stagedId}"`, now));
      }
      store.stageDelete(stagedId);
      return ok(true);
    });
  }

  function requestInstallApproval(
    stagedId: string,
    sha256: string,
  ): SkillResult<{ stagedId: string; sha256: string; approvalId: string }> {
    return guard(now, () => {
      const read = readStage(stagedId);
      if (!read.ok) return read;
      const meta = read.value.meta;
      if (isExpired(meta, now())) {
        return fail(skillError("POLICY_DENIED", `staged skill "${stagedId}" expired at ${meta.expiresAt}; re-stage it`, now, "STALE_STAGE"));
      }
      if (sha256 !== meta.sha256) {
        return fail(
          skillError("POLICY_DENIED", "the sha256 offered does not match the staged bytes; refusing to request approval for different content", now, "HASH_MISMATCH"),
        );
      }
      const approvals = opts.approvals;
      if (approvals === undefined) {
        return fail(skillError("POLICY_DENIED", "no approval service is wired, so no approval can be requested", now, "NO_APPROVER"));
      }
      const approval = approvals.request({
        toolId: SKILL_INSTALL_TOOL_ID,
        action: `Install skill "${meta.skillId}"`,
        reason: `Approve installing skill "${meta.skillId}" — content sha256 ${meta.sha256}`,
        risk: "WRITE",
      });
      store.stageUpdate(stagedId, { approvalId: approval.id });
      return ok({ stagedId, sha256: meta.sha256, approvalId: approval.id });
    });
  }

  function installApproved(input: {
    stagedId: string;
    sha256: string;
    approvalId: string;
  }): SkillResult<InstallReceipt> {
    return guard(now, () => {
      const read = readStage(input.stagedId);
      if (!read.ok) return read;
      const { markdown, meta } = read.value;
      const at = now();

      if (isExpired(meta, at)) {
        return fail(
          skillError("POLICY_DENIED", `staged skill "${input.stagedId}" expired at ${meta.expiresAt}; the approval can no longer be used`, now, "STALE_STAGE"),
        );
      }

      // ── The exact-byte binding ────────────────────────────────────────────
      const actual = sha256Hex(markdown);
      if (actual !== input.sha256 || actual !== meta.sha256) {
        return fail(
          skillError(
            "POLICY_DENIED",
            `the staged bytes for "${input.stagedId}" no longer match the approved sha256; ` +
              `refusing to install bytes the human did not approve`,
            now,
            "HASH_MISMATCH",
          ),
        );
      }

      const approvalCheck = verifyApproval(meta, input.approvalId);
      if (!approvalCheck.ok) return approvalCheck;
      const approval = approvalCheck.value;

      // Defence in depth: even approved bytes must still pass validation.
      const parsed = parseSkillMarkdown(markdown, { id: meta.skillId });
      if (!parsed.ok) {
        return fail(skillError("VALIDATION_FAILED", "the approved content no longer validates and will not be installed", now), parsed.issues);
      }

      const existing = store.getSkill(meta.skillId);
      const currentRevision = existing?.revisions[existing.revisions.length - 1]?.revision ?? 0;

      // Already the current revision: idempotent, consume the stage, install nothing new.
      if (existing !== undefined && existing.currentSha === meta.sha256) {
        store.stageDelete(input.stagedId);
        return ok({
          skillId: meta.skillId,
          revision: currentRevision,
          sha256: meta.sha256,
          installedAt: existing.updatedAt,
          approvedBy: approval.id,
        });
      }

      // Publish the immutable revision FIRST, then swap the pointer. A crash
      // between the two leaves the previous revision current.
      store.writeRevisionAtomic(meta.skillId, meta.sha256, markdown);

      const fault = opts.faults?.beforePointerSwap;
      if (fault !== undefined) {
        try {
          fault();
        } catch (error) {
          return fail(
            skillError(
              "STORAGE_FAILED",
              "install was interrupted before the revision was published; the previous revision is still current",
              now,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      }

      const revisionNumber = currentRevision + 1;
      const updatedAt = at.toISOString();
      const nextRevision = {
        revision: revisionNumber,
        sha256: meta.sha256,
        installedAt: updatedAt,
        source: meta.source,
        approvedBy: approval.id,
        fromStagedId: meta.stagedId,
      };
      const entry: StoredSkill =
        existing === undefined
          ? {
              id: meta.skillId,
              name: parsed.value.name,
              description: parsed.value.description,
              tags: [...parsed.value.tags],
              source: meta.source,
              createdAt: updatedAt,
              updatedAt,
              disabled: false,
              currentSha: meta.sha256,
              revisions: [nextRevision],
            }
          : {
              ...existing,
              name: parsed.value.name,
              description: parsed.value.description,
              tags: [...parsed.value.tags],
              updatedAt,
              currentSha: meta.sha256,
              revisions: [...existing.revisions, nextRevision],
            };
      if (parsed.value.version !== undefined) entry.version = parsed.value.version;
      // The approved revision's runtime metadata rides the pointer swap, so an
      // upgrade that adds (or drops) purpose/tools/constraints takes effect
      // with the revision — never a version behind.
      if (parsed.value.purpose !== undefined) entry.purpose = parsed.value.purpose;
      else delete entry.purpose;
      if (parsed.value.tools !== undefined) entry.tools = [...parsed.value.tools];
      else delete entry.tools;
      if (parsed.value.constraints !== undefined) entry.constraints = [...parsed.value.constraints];
      else delete entry.constraints;
      store.putSkill(entry);
      store.stageDelete(input.stagedId);

      return ok({
        skillId: meta.skillId,
        revision: revisionNumber,
        sha256: meta.sha256,
        installedAt: updatedAt,
        approvedBy: approval.id,
      });
    });
  }

  function rollback(id: string): SkillResult<{ skillId: string; revision: number; sha256: string }> {
    return guard(now, () => {
      const entry = store.getSkill(id);
      if (entry === undefined) {
        return fail(skillError("NOT_FOUND", `no skill is registered with id "${id}"`, now));
      }
      const currentIndex = entry.revisions.findIndex((revision) => revision.sha256 === entry.currentSha);
      const previous = currentIndex > 0 ? entry.revisions[currentIndex - 1] : undefined;
      if (previous === undefined) {
        return fail(
          skillError("POLICY_DENIED", `skill "${id}" has no earlier revision to roll back to`, now, "NO_ROLLBACK"),
        );
      }
      store.putSkill({ ...entry, currentSha: previous.sha256, updatedAt: now().toISOString() });
      return ok({ skillId: id, revision: previous.revision, sha256: previous.sha256 });
    });
  }

  return {
    stage,
    inspectStaged,
    listStaged,
    discardStaged,
    requestInstallApproval,
    installApproved,
    rollback,
  };
}

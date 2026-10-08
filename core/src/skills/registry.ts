// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The skill registry — the catalogue, and the progressive-disclosure boundary.
 *
 * Two responsibilities, both deliberately narrow:
 *
 *   1. LIFECYCLE (spec C3): register / list / inspect / load / disable / enable
 *      / delete. Every skill carries id, name, description, revision, source,
 *      contentHash and status.
 *
 *   2. PROGRESSIVE DISCLOSURE (spec C2): `list()` and `relevant()` return
 *      METADATA ONLY. They read name/description/tags from the index and never
 *      open a SKILL.md body. `load(id)` is the ONLY method that reads a body.
 *      A caller cannot accidentally inject every skill into a prompt because a
 *      listing has no body field to inject, and `relevant()` is the intended
 *      query — "give me the skills worth loading" — without paying for the
 *      bodies of the ones that are not.
 *
 * `register()` is CREATE-ONLY and refuses a duplicate id, matching the tool and
 * capability registries: silently replacing a reviewed skill with a same-named
 * one is the exact confusion the boundary exists to prevent. Updates are the
 * job of the approved install pipeline (`staging.installApproved`), which
 * appends an immutable revision instead of overwriting.
 */

import { dirname } from "node:path";
import { fail, guard, ok, skillError } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import { safeRemovePath } from "./paths.ts";
import type { SkillStore, StoredSkill } from "./store.ts";
import { isSafeSkillId, parseSkillMarkdown, validateSkillId } from "./validate.ts";
import type {
  LoadedSkill,
  SkillMetadata,
  SkillRecord,
  SkillResult,
  SkillRevisionView,
} from "./types.ts";

export interface SkillRegistry {
  register(input: { id: string; markdown: string; source?: string }): SkillResult<SkillRecord>;
  list(): SkillMetadata[];
  /** Metadata plus revision history. Never a body. */
  inspect(id: string): SkillResult<SkillRecord>;
  /** The ONLY method that reads a body. */
  load(id: string): SkillResult<LoadedSkill>;
  disabled(id: string): boolean;
  has(id: string): boolean;
  ids(): string[];
  disable(id: string): SkillResult<SkillRecord>;
  enable(id: string): SkillResult<SkillRecord>;
  delete(id: string): SkillResult<true>;
  /**
   * Rank skills against a natural-language query from METADATA only and return
   * at most `limit` of them, best first. An empty query matches nothing.
   */
  relevant(query: string, limit?: number): SkillMetadata[];
}

function toRevisionView(revision: StoredSkill["revisions"][number]): SkillRevisionView {
  const view: SkillRevisionView = {
    revision: revision.revision,
    sha256: revision.sha256,
    installedAt: revision.installedAt,
    source: revision.source,
  };
  if (revision.approvedBy !== undefined) view.approvedBy = revision.approvedBy;
  if (revision.fromStagedId !== undefined) view.fromStagedId = revision.fromStagedId;
  return view;
}

export function createSkillRegistry(opts: { store: SkillStore; now?: () => Date }): SkillRegistry {
  const { store } = opts;
  const now = opts.now ?? (() => new Date());

  function pathOf(entry: StoredSkill): string {
    return dirname(store.revisionPath(entry.id, entry.currentSha));
  }

  function toMetadata(entry: StoredSkill): SkillMetadata {
    const metadata: SkillMetadata = {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      tags: [...entry.tags],
      source: entry.source,
      contentHash: entry.currentSha,
      status: entry.disabled ? "disabled" : "enabled",
      revision: entry.revisions[entry.revisions.length - 1]?.revision ?? entry.revisions.length,
      revisionCount: entry.revisions.length,
      installedAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      path: pathOf(entry),
    };
    if (entry.version !== undefined) metadata.version = entry.version;
    if (entry.purpose !== undefined) metadata.purpose = entry.purpose;
    if (entry.tools !== undefined) metadata.tools = [...entry.tools];
    if (entry.constraints !== undefined) metadata.constraints = [...entry.constraints];
    return metadata;
  }

  function toRecord(entry: StoredSkill): SkillRecord {
    return { ...toMetadata(entry), revisions: entry.revisions.map(toRevisionView) };
  }

  function register(input: { id: string; markdown: string; source?: string }): SkillResult<SkillRecord> {
    return guard(now, () => {
      const idIssues = validateSkillId(input.id);
      if (idIssues.length > 0) {
        return fail(skillError("VALIDATION_FAILED", `skill id refused: ${idIssues[0]?.message ?? "invalid"}`, now, "INVALID_ID"), idIssues);
      }
      const parsed = parseSkillMarkdown(input.markdown, { id: input.id });
      if (!parsed.ok) return parsed;
      if (store.hasSkill(input.id)) {
        return fail(
          skillError(
            "VALIDATION_FAILED",
            `skill "${input.id}" is already registered; refusing to overwrite it. Use the approved install pipeline to add a revision.`,
            now,
          ),
        );
      }

      const sha256 = sha256Hex(input.markdown);
      const at = now().toISOString();
      const source = input.source ?? "user";
      store.writeRevisionAtomic(input.id, sha256, input.markdown);

      const entry: StoredSkill = {
        id: input.id,
        name: parsed.value.name,
        description: parsed.value.description,
        tags: [...parsed.value.tags],
        source,
        createdAt: at,
        updatedAt: at,
        disabled: false,
        currentSha: sha256,
        revisions: [{ revision: 1, sha256, installedAt: at, source }],
      };
      if (parsed.value.version !== undefined) entry.version = parsed.value.version;
      if (parsed.value.purpose !== undefined) entry.purpose = parsed.value.purpose;
      if (parsed.value.tools !== undefined) entry.tools = [...parsed.value.tools];
      if (parsed.value.constraints !== undefined) entry.constraints = [...parsed.value.constraints];
      store.putSkill(entry);
      return ok(toRecord(entry));
    });
  }

  function list(): SkillMetadata[] {
    return store
      .listSkills()
      .map(toMetadata)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  function inspect(id: string): SkillResult<SkillRecord> {
    return guard(now, () => {
      const entry = store.getSkill(id);
      if (entry === undefined) {
        return fail(skillError("NOT_FOUND", `no skill is registered with id "${id}"`, now));
      }
      return ok(toRecord(entry));
    });
  }

  function load(id: string): SkillResult<LoadedSkill> {
    return guard(now, () => {
      if (!isSafeSkillId(id)) {
        return fail(skillError("VALIDATION_FAILED", `skill id "${id}" is not usable`, now, "INVALID_ID"), validateSkillId(id));
      }
      const entry = store.getSkill(id);
      if (entry === undefined) {
        return fail(skillError("NOT_FOUND", `no skill is registered with id "${id}"`, now));
      }
      if (entry.disabled) {
        return fail(skillError("POLICY_DENIED", `skill "${id}" is disabled and will not be loaded`, now));
      }
      const body = store.readRevisionBody(id, entry.currentSha);
      if (sha256Hex(body) !== entry.currentSha) {
        return fail(
          skillError(
            "POLICY_DENIED",
            `skill "${id}" failed its integrity check: the installed bytes no longer match the recorded hash`,
            now,
            "INTEGRITY_MISMATCH",
          ),
        );
      }
      return ok({ metadata: toMetadata(entry), body, path: pathOf(entry) });
    });
  }

  function disabled(id: string): boolean {
    return store.getSkill(id)?.disabled ?? false;
  }

  function has(id: string): boolean {
    return store.hasSkill(id);
  }

  function ids(): string[] {
    return store.listSkills().map((entry) => entry.id);
  }

  function setDisabled(id: string, value: boolean): SkillResult<SkillRecord> {
    return guard(now, () => {
      const entry = store.getSkill(id);
      if (entry === undefined) {
        return fail(skillError("NOT_FOUND", `no skill is registered with id "${id}"`, now));
      }
      const next: StoredSkill = { ...entry, disabled: value, updatedAt: now().toISOString() };
      store.putSkill(next);
      return ok(toRecord(next));
    });
  }

  function disable(id: string): SkillResult<SkillRecord> {
    return setDisabled(id, true);
  }

  function enable(id: string): SkillResult<SkillRecord> {
    return setDisabled(id, false);
  }

  function remove(id: string): SkillResult<true> {
    return guard(now, () => {
      const entry = store.getSkill(id);
      if (entry === undefined) {
        return fail(skillError("NOT_FOUND", `no skill is registered with id "${id}"`, now));
      }
      // revisionDir asserts containment, so deleting a skill whose directory
      // was replaced by a link refuses rather than following it out of the root.
      const dir = store.revisionDir(id);
      safeRemovePath(store.root, dir);
      store.removeSkill(id);
      return ok(true);
    });
  }

  function tokenize(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0);
  }

  function score(entry: StoredSkill, tokens: readonly string[]): number {
    const name = entry.name.toLowerCase();
    const description = entry.description.toLowerCase();
    const purpose = (entry.purpose ?? "").toLowerCase();
    const tags = entry.tags.map((tag) => tag.toLowerCase());
    let total = 0;
    for (const token of tokens) {
      if (name.includes(token)) total += 3;
      if (description.includes(token)) total += 2;
      // The purpose states the job: it scores with the description.
      if (purpose.length > 0 && purpose.includes(token)) total += 2;
      if (tags.some((tag) => tag.includes(token))) total += 1;
    }
    return total;
  }

  function relevant(query: string, limit = 5): SkillMetadata[] {
    const tokens = tokenize(query);
    if (tokens.length === 0 || limit <= 0) return [];
    return store
      .listSkills()
      .filter((entry) => !entry.disabled)
      .map((entry) => ({ entry, value: score(entry, tokens) }))
      .filter((candidate) => candidate.value > 0)
      .sort((a, b) => (b.value - a.value) || (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0))
      .slice(0, limit)
      .map((candidate) => toMetadata(candidate.entry));
  }

  return {
    register,
    list,
    inspect,
    load,
    disabled,
    has,
    ids,
    disable,
    enable,
    delete: remove,
    relevant,
  };
}

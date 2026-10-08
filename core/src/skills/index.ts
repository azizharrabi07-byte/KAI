// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core skills — barrel export.
 *
 * This directory owns everything about SKILL.md: the strict validator (C1), the
 * progressive-disclosure registry (C2/C3), and the exact-byte staged-approval
 * install pipeline (C4). Nothing here is imported by `runtime.ts` yet — see
 * `WIRING.md` in this directory for the two lines the Core lead adds.
 */

export * from "./types.ts";
export { SkillFsError, fail, guard, ok, skillError } from "./errors.ts";
export { sha256File, sha256Hex } from "./hash.ts";
export { parseFrontmatter } from "./frontmatter.ts";
export type { FrontmatterParse } from "./frontmatter.ts";
export {
  ALLOWED_FRONTMATTER_KEYS,
  SKILL_LIMITS,
  isSafeSkillId,
  parseSkillMarkdown,
  validateSkillId,
} from "./validate.ts";
export { renderSkillMarkdown } from "./render.ts";
export type { SkillDraft } from "./render.ts";
export {
  assertInside,
  assertNoReparseEscape,
  atomicWriteFile,
  atomicWriteJson,
  ensureDir,
  readJson,
  safeJoin,
  safeRemovePath,
} from "./paths.ts";
export { BUILTIN_SKILLS, seedBuiltinSkills, type BuiltinSkill, type SkillSeeder } from "./builtin.ts";
export { KAI_LIBRARY_SOURCE, libraryDir, listLibrarySkills, seedLibrarySkills } from "./library.ts";
export { createSkillStore } from "./store.ts";
export type { SkillStore, SkillStoreHooks, StagedMeta, StoredRevision, StoredSkill } from "./store.ts";
export { createSkillRegistry } from "./registry.ts";
export type { SkillRegistry } from "./registry.ts";
export { DEFAULT_STAGE_TTL_MS, SKILL_INSTALL_TOOL_ID, createSkillStaging } from "./staging.ts";
export type { SkillStaging } from "./staging.ts";
export { createSkillToolDefinitions } from "./tools.ts";

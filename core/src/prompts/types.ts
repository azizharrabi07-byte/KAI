// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The public shapes of KAI's one system-prompt composition pipeline (Phase 2 Part E).
 *
 * Kept separate from the implementation so a caller can import the types
 * (`import type { MemoryRecall } from "../prompts/index.ts"`) without pulling the
 * pipeline in, and so the injected ports below are the ONLY thing this module
 * depends on outside of itself.
 *
 * The ports are the whole reason this file exists as its own seam: the memory
 * and skill modules are being built in parallel, so the pipeline must compile and
 * be testable against these hand-written interfaces BEFORE those modules land —
 * and the real implementations must plug in without changing a line of the
 * pipeline. There is deliberately no import of `memory/**` or `skills/**` here,
 * and there must never be one.
 */

// ── Sections ──────────────────────────────────────────────────────────────────

/**
 * The pipeline's sections, in the ONE order that is the contract:
 *
 *   system safety -> KAI identity/SOUL -> response behavior ->
 *   stable user context -> relevant memory -> relevant skills ->
 *   mission context -> current request
 *
 * This array is the source of truth. The composer iterates it; it never sorts,
 * reorders or accepts a caller-supplied order, which is what makes "memory cannot
 * outrank safety" structural rather than a comment.
 */
export const SECTION_ORDER: readonly SectionName[] = [
  "safety",
  "identity",
  "guidance",
  "shark",
  "user-context",
  "memory",
  "skills",
  "mission",
  "request",
];

export type SectionName =
  | "safety"
  | "identity"
  | "guidance"
  | "shark"
  | "user-context"
  | "memory"
  | "skills"
  | "mission"
  | "request";

/** Stable sections can be cached and compared across turns; volatile ones cannot. */
export type PromptBand = "stable" | "volatile";

/**
 * `instruction` sections carry authority. `data` sections are reference material
 * and are fenced and labelled so their content can never be read as an instruction.
 */
export type SectionTrust = "instruction" | "data";

// ── Injected ports (the ONLY outward dependency) ───────────────────────────────

/** One recalled memory row, as the memory module will hand it over. */
export interface MemoryRecallItem {
  id: string;
  content: string;
  source: string;
  createdAt: string;
  score?: number;
}

/**
 * Relevant-memory recall. The pipeline passes the CURRENT request as `query` and a
 * bounded `limit`, so retrieval is relevance-keyed and never a full-DB dump.
 */
export type MemoryRecall = (
  query: string,
  opts: { limit: number; scope?: string },
) => Promise<readonly MemoryRecallItem[]>;

/** One skill, as the skills module will hand it over. */
export interface SkillIndexItem {
  id: string;
  name: string;
  description: string;
  path: string;
}

/** Relevant-skill lookup, keyed by the current request. */
export interface SkillIndex {
  relevant(query: string, limit: number): Promise<readonly SkillIndexItem[]>;
}

/** KAI's own current mission, or null when there is none. */
export type MissionContext = { id: string; goal: string; status: string } | null;

// ── Identity input ────────────────────────────────────────────────────────────

/**
 * The identity documents the pipeline composes. A structural subset of
 * `KaiIdentity` (agent/soul.ts), so the caller can pass `provider.identity()`
 * directly. `soul` is KAI's identity; `user` is the stable user context.
 */
export interface IdentityDocs {
  soul: string;
  user: string;
  version?: string;
}

// ── Budgets ───────────────────────────────────────────────────────────────────

/**
 * Every section is bounded, and so is the total. `memoryItem` / `skillItem` bound
 * a single recalled row; `memory` / `skills` bound the section; `total` is a hard
 * ceiling on the assembled prompt.
 */
export interface PromptLimits {
  safety: number;
  identity: number;
  guidance: number;
  shark: number;
  userContext: number;
  memory: number;
  memoryItem: number;
  skills: number;
  skillItem: number;
  mission: number;
  request: number;
  total: number;
}

// ── Results ───────────────────────────────────────────────────────────────────

/** Per-section size report, so growth is measurable rather than eyeballed. */
export interface SectionReport {
  name: SectionName;
  band: PromptBand;
  trust: SectionTrust;
  /** Characters this section contributes to the prompt, heading and fences included. */
  chars: number;
  /** Characters of section body emitted (post-bounding, pre-fence-escape). `<= budget`. */
  bodyChars: number;
  /** The per-section body budget that applied. */
  budget: number;
  /** True when content was truncated or items were omitted to fit the budget. */
  truncated: boolean;
}

export interface ComposedPrompt {
  /** The full prompt, sections concatenated in the fixed order. */
  text: string;
  /** The stable prefix: byte-identical across turns for the same identity/limits. */
  stable: string;
  /** The volatile suffix: everything that depends on the request or live state. */
  volatile: string;
  sections: SectionReport[];
  /** `text.length`, repeated so a caller need not measure it. */
  totalChars: number;
  /** Non-fatal problems, in words fit to show a user (truncations, missing ports). */
  problems: string[];
  /** The order actually used — always a prefix-ordered subsequence of SECTION_ORDER. */
  order: readonly SectionName[];
}

// ── Options / the composer ────────────────────────────────────────────────────

export interface ComposeTurnOptions {
  /** KAI's current mission, or null/omitted for none. */
  mission?: MissionContext;
  /** Opaque scope passed to memory recall (thread/mission id). */
  scope?: string;
  /** Bounded recall count for memory. Defaults to DEFAULT_RECALL.memory. */
  memoryLimit?: number;
  /** Bounded recall count for skills. Defaults to DEFAULT_RECALL.skills. */
  skillLimit?: number;
  /**
   * The KAI conversation this turn belongs to. When set, the runtime appends
   * a BOUNDED session block (digest + recent turns) — never the lifetime
   * transcript. Absent means no session context (stateless callers).
   */
  sessionId?: string;
}

export interface PromptComposerOptions {
  /** Required: KAI's identity documents (soul + stable user context). */
  identity: IdentityDocs;
  /** Overrides the built-in safety text. Rarely wanted; the default is load-bearing. */
  safety?: string;
  /** Omitted means "no memory available this turn", which degrades, never throws. */
  memory?: MemoryRecall;
  /** Omitted means "no skills available this turn", which degrades, never throws. */
  skills?: SkillIndex;
  /** Per-section / total overrides. Merged over DEFAULT_LIMITS. */
  limits?: Partial<PromptLimits>;
}

export interface PromptComposer {
  /** Composes one turn's system prompt for `request`. Never throws for a missing port. */
  compose(request: string, opts?: ComposeTurnOptions): Promise<ComposedPrompt>;
  /** Section sizes from the most recent compose(). Empty before the first call. */
  report(): readonly SectionReport[];
  /** The fixed pipeline order. */
  order(): readonly SectionName[];
  /** The effective limits (defaults merged with any overrides). */
  limits(): PromptLimits;
}

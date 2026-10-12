// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Skill applicability, and a deterministic index snapshot.
 *
 * ## Why an index and not the bodies
 *
 * KAI already discloses skills progressively — `list()` returns metadata and a
 * body is loaded only on demand. What was missing is APPLICABILITY: a skill for
 * a Linux-only toolchain was offered on Windows, and a skill that needs a tool
 * KAI does not have was offered anyway. The model then spends attention on
 * instructions it cannot follow.
 *
 * This module answers, for a given execution context, which skills are eligible,
 * and produces a SNAPSHOT that a turn can hold: the snapshot is built once, so a
 * skill created or edited mid-turn cannot silently change which skills that turn
 * is using. It is keyed by a content hash, so "which index did this run see?" is
 * answerable afterwards.
 *
 * ## Where the conditions come from
 *
 * Conditions are read from a skill's TAGS, using an explicit, documented
 * convention:
 *
 *     platform:linux     platform:win32     platform:darwin
 *     env:ci             env:local
 *     domain:research    domain:coding
 *
 * A tag convention rather than new frontmatter keys, deliberately: first-class
 * `platforms:` frontmatter would need the parser allow-list, `SkillMetadata`, the
 * store schema and its migration to change together, and the behaviour is
 * available today without touching stored data. A skill with NO condition tags is
 * eligible everywhere, so this never narrows an existing skill.
 */

import { sha256Hex } from "./hash.ts";

/** A tag prefix that carries a condition. Anything else is an ordinary tag. */
const CONDITION_PREFIXES: Record<string, "platforms" | "environments" | "domains"> = {
  platform: "platforms",
  env: "environments",
  domain: "domains",
};

export interface SkillConditions {
  /** Platform ids this skill applies to (`linux`, `win32`, `darwin`). */
  platforms?: readonly string[];
  /** Environments (`ci`, `local`, ...). */
  environments?: readonly string[];
  /** Task domains (`research`, `coding`, ...). */
  domains?: readonly string[];
  /** Tool ids the skill needs. A missing tool makes it ineligible. */
  tools?: readonly string[];
}

export interface ApplicabilityContext {
  /** The runtime platform: `process.platform` by convention. */
  platform: string;
  /** The environment, when KAI knows one. */
  environment?: string;
  /** The task domain, when the plan named one. */
  domain?: string;
  /** Tool ids available for this run. */
  availableTools: readonly string[];
}

export interface Eligibility {
  eligible: boolean;
  reason: string;
}

/** Read the condition tags out of a skill's tags. Unknown tags are ignored. */
export function conditionsFromTags(tags: readonly string[]): SkillConditions {
  const conditions: { platforms: string[]; environments: string[]; domains: string[] } = {
    platforms: [],
    environments: [],
    domains: [],
  };
  for (const tag of tags) {
    const separator = tag.indexOf(":");
    if (separator <= 0) continue;
    const prefix = tag.slice(0, separator).toLowerCase();
    const value = tag.slice(separator + 1).trim().toLowerCase();
    const key = CONDITION_PREFIXES[prefix];
    if (key === undefined || value.length === 0) continue;
    conditions[key].push(value);
  }
  const out: SkillConditions = {};
  if (conditions.platforms.length > 0) out.platforms = conditions.platforms;
  if (conditions.environments.length > 0) out.environments = conditions.environments;
  if (conditions.domains.length > 0) out.domains = conditions.domains;
  return out;
}

/**
 * Is this skill applicable here?
 *
 * Every declared condition must be satisfied; an undeclared condition is not a
 * constraint. The reason always explains the decision, so an ineligible skill can
 * say why instead of silently vanishing from the index.
 */
export function checkApplicability(conditions: SkillConditions, context: ApplicabilityContext): Eligibility {
  if (conditions.platforms !== undefined && conditions.platforms.length > 0) {
    const platform = context.platform.toLowerCase();
    if (!conditions.platforms.includes(platform)) {
      return {
        eligible: false,
        reason: `applies to ${conditions.platforms.join("/")} but this is ${context.platform}`,
      };
    }
  }
  if (conditions.environments !== undefined && conditions.environments.length > 0) {
    // Unknown environment FAILS OPEN, and a known one that differs fails CLOSED.
    //
    // The distinction matters: KAI often does not know its environment, and
    // failing closed there would make every `env:ci` skill invisible in the
    // ordinary case. Hermes reaches the same conclusion from the other side —
    // its `environments:` is documented as an offer-surface relevance gate, and
    // "an explicit load always succeeds". A known mismatch is still a real
    // mismatch, so it hides the skill.
    if (context.environment !== undefined && context.environment.length > 0) {
      const environment = context.environment.toLowerCase();
      if (!conditions.environments.includes(environment)) {
        return {
          eligible: false,
          reason: `applies to the ${conditions.environments.join("/")} environment but this is "${context.environment}"`,
        };
      }
    }
  }
  if (conditions.domains !== undefined && conditions.domains.length > 0) {
    const domain = (context.domain ?? "").toLowerCase();
    if (!conditions.domains.includes(domain)) {
      return {
        eligible: false,
        reason: `applies to the ${conditions.domains.join("/")} domain but this task is "${context.domain ?? "(none)"}"`,
      };
    }
  }
  if (conditions.tools !== undefined && conditions.tools.length > 0) {
    const available = new Set(context.availableTools);
    const missing = conditions.tools.filter((tool) => !available.has(tool));
    if (missing.length > 0) {
      return { eligible: false, reason: `needs ${missing.join(", ")}, which this run does not have` };
    }
  }
  return { eligible: true, reason: "applicable" };
}

/** The minimum a skill must expose to be indexed. Decoupled from the store row. */
export interface IndexableSkill {
  id: string;
  name: string;
  description: string;
  tags: readonly string[];
  tools?: readonly string[];
  version?: string;
  source: string;
  sha256: string;
  disabled: boolean;
}

export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  version?: string;
  source: string;
  /** The content hash of the skill's active revision. */
  sha256: string;
  eligible: boolean;
  /** Why it is eligible, or exactly why it is not. */
  reason: string;
  /** True when the skill is disabled — a separate axis from applicability. */
  disabled: boolean;
}

export interface SkillIndexSnapshot {
  /** Content hash of the entry list: the identity of THIS index. */
  snapshotId: string;
  builtAt: string;
  context: ApplicabilityContext;
  entries: SkillIndexEntry[];
  eligible: number;
  ineligible: number;
  /** The entries were truncated to the cap, so the index is bounded by contract. */
  truncated: boolean;
}

/**
 * Build a deterministic snapshot for one execution context.
 *
 * Deterministic by construction: entries are ordered by id, so the same skills in
 * the same context always produce the same `snapshotId`, whatever order the store
 * returned them in.
 */
export function buildSkillIndex(
  skills: readonly IndexableSkill[],
  context: ApplicabilityContext,
  opts: { now?: () => Date; maxEntries?: number } = {},
): SkillIndexSnapshot {
  const now = opts.now ?? (() => new Date());
  // A SAFETY bound, not a working limit. It was 200, which a fresh Core already
  // exceeded (266 skills), so the default silently dropped 66 of them — the exact
  // "silently hide a skill" failure this module exists to avoid. The cap is now
  // high enough to be a guard against pathological growth, and `truncated` is
  // reported so an incomplete index can never be mistaken for a complete one.
  const maxEntries = opts.maxEntries ?? 5000;
  const ordered = [...skills].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const truncated = ordered.length > maxEntries;
  const bounded = ordered.slice(0, maxEntries);

  const entries: SkillIndexEntry[] = bounded.map((skill) => {
    const conditions = conditionsFromTags(skill.tags);
    const withTools: SkillConditions =
      skill.tools !== undefined && skill.tools.length > 0 ? { ...conditions, tools: skill.tools } : conditions;
    const verdict = skill.disabled
      ? { eligible: false, reason: "disabled by an operator" }
      : checkApplicability(withTools, context);
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      ...(skill.version !== undefined ? { version: skill.version } : {}),
      source: skill.source,
      sha256: skill.sha256,
      eligible: verdict.eligible,
      reason: verdict.reason,
      disabled: skill.disabled,
    };
  });

  const eligible = entries.filter((e) => e.eligible).length;
  return {
    snapshotId: sha256Hex(
      JSON.stringify(entries.map((e) => [e.id, e.sha256, e.eligible])),
    ),
    builtAt: now().toISOString(),
    context,
    entries,
    eligible,
    ineligible: entries.length - eligible,
    truncated,
  };
}

/** The eligible skills of a snapshot, in index order. */
export function eligibleSkills(snapshot: SkillIndexSnapshot): SkillIndexEntry[] {
  return snapshot.entries.filter((entry) => entry.eligible);
}

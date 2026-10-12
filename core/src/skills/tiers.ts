// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Skill tiers, and the deterministic rule that resolves a name conflict.
 *
 * ## What a "tier" is in KAI
 *
 * KAI has ONE skill registry (a single store root), so a tier is not a directory
 * that shadows another — it is the skill's PROVENANCE, which KAI already records
 * as `source`. Three sources exist in practice:
 *
 *     "builtin"                  KAI's own skills
 *     "discovered:kai-library"   the curated third-party library
 *     "learned"                  created by an agent or imported by a user
 *
 * ## The policy
 *
 * Two skills can carry the same NAME while having different ids, and until now
 * whichever one a caller happened to read first won. That is exactly the
 * "arbitrary preference / silent overwrite" this module removes. The rule is:
 *
 *     builtin  >  library  >  project  >  learned  >  imported  >  unknown
 *
 * `builtin` is first because it is the only tier KAI ships and reviews itself;
 * `learned` outranks `imported` because a learned skill at least passed KAI's
 * own scan and staging gate. The order is a DATA table, not a comparison chain,
 * and the tie-break inside a tier is the skill ID — so the outcome never depends
 * on filesystem or store iteration order.
 *
 * ## What it will not do
 *
 * An unknown `source` is NOT discarded and NOT silently promoted: it resolves to
 * the `unknown` tier, which loses every conflict and says so. A disabled skill
 * never wins. A shadowed skill is reported with the reason, so a user can see
 * that something was hidden and why.
 */

export type SkillTier = "builtin" | "library" | "project" | "learned" | "imported" | "unknown";

/**
 * The precedence, most trusted first. The INDEX in this array is the rank, so
 * reordering the policy is a one-line change and cannot be done by accident.
 */
export const SKILL_TIER_ORDER: readonly SkillTier[] = [
  "builtin",
  "library",
  "project",
  "learned",
  "imported",
  "unknown",
];

/** The source string that names each tier. One table, so the mapping is auditable. */
const TIER_BY_SOURCE: Record<string, SkillTier> = {
  builtin: "builtin",
  "discovered:kai-library": "library",
  "kai-library": "library",
  library: "library",
  project: "project",
  user: "project",
  learned: "learned",
  agent: "learned",
  imported: "imported",
  external: "imported",
};

/**
 * The tier a source belongs to.
 *
 * An unrecognized source is `unknown`, deliberately: guessing a tier for
 * something KAI does not understand would let it outrank a skill KAI reviewed.
 * The value is preserved on the resolution so the reason can name it.
 */
export function tierOf(source: string): SkillTier {
  return TIER_BY_SOURCE[source.trim().toLowerCase()] ?? "unknown";
}

export function tierRank(tier: SkillTier): number {
  const index = SKILL_TIER_ORDER.indexOf(tier);
  return index === -1 ? SKILL_TIER_ORDER.length : index;
}

export interface TierCandidate {
  id: string;
  /** The frontmatter name. A skill with none is identified by its id. */
  name?: string;
  source: string;
  sha256: string;
  disabled: boolean;
}

export interface TierResolved extends TierCandidate {
  tier: SkillTier;
  /** The normalized key this skill competed under. */
  key: string;
}

export interface ShadowedSkill {
  id: string;
  source: string;
  tier: SkillTier;
  sha256: string;
  /** Exactly why it lost, in one line a user can read. */
  reason: string;
}

export interface NameResolution {
  /** The normalized name these skills competed for. */
  key: string;
  winner: TierResolved;
  shadowed: ShadowedSkill[];
  /** One line explaining the outcome. */
  reason: string;
}

export interface TierResolution {
  resolutions: NameResolution[];
  /** id → the reason it was shadowed. Absent means the skill is selectable. */
  shadowed: Map<string, string>;
}

/** The conflict key: a name, normalized. No name means the id identifies it. */
function conflictKey(skill: TierCandidate): string {
  const raw = skill.name !== undefined && skill.name.trim().length > 0 ? skill.name : skill.id;
  return raw.trim().toLowerCase();
}

/**
 * Resolve every name conflict. Deterministic: the outcome is a pure function of
 * the input set, so two runs over the same skills in any order agree.
 */
export function resolveSkillTiers(skills: readonly TierCandidate[]): TierResolution {
  const groups = new Map<string, TierCandidate[]>();
  for (const skill of skills) {
    const key = conflictKey(skill);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [skill]);
    else bucket.push(skill);
  }

  const resolutions: NameResolution[] = [];
  const shadowed = new Map<string, string>();

  for (const [key, bucket] of groups) {
    // Rank: a selectable skill before a disabled one, then by tier, then by id.
    // The id tie-break is what makes this independent of iteration order.
    const ranked = [...bucket].sort((a, b) => {
      if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
      const byTier = tierRank(tierOf(a.source)) - tierRank(tierOf(b.source));
      if (byTier !== 0) return byTier;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const winner = ranked[0];
    if (winner === undefined) continue;
    const winnerResolved: TierResolved = { ...winner, tier: tierOf(winner.source), key };

    const losers: ShadowedSkill[] = [];
    for (const loser of ranked.slice(1)) {
      const loserTier = tierOf(loser.source);
      let reason: string;
      if (loser.disabled) {
        reason = `disabled, so it cannot be selected even though it is a "${loserTier}" skill`;
      } else if (loser.sha256 === winner.sha256) {
        // Not really a conflict: the same bytes under two ids.
        reason = `identical content to "${winner.id}" (same sha256), so it adds nothing`;
      } else if (loserTier === winnerResolved.tier) {
        reason = `same tier "${loserTier}" as "${winner.id}", which wins the id tie-break`;
      } else {
        // The SOURCE is named, not just the tier: "which skill lost, and where
        // did it come from" is the question a user actually has.
        reason =
          `tier "${loserTier}" (source "${loser.source}") is lower precedence than ` +
          `"${winnerResolved.tier}" from "${winner.id}" (order: ${SKILL_TIER_ORDER.join(" > ")})`;
      }
      losers.push({ id: loser.id, source: loser.source, tier: loserTier, sha256: loser.sha256, reason });
      shadowed.set(loser.id, `shadowed by "${winner.id}": ${reason}`);
    }

    const reason =
      losers.length === 0
        ? `"${key}" is unambiguous: ${winner.id} (${winnerResolved.tier})`
        : `"${key}" resolved to ${winner.id} (${winnerResolved.tier}); ${losers.length} shadowed`;
    resolutions.push({ key, winner: winnerResolved, shadowed: losers, reason });
  }

  resolutions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { resolutions, shadowed };
}

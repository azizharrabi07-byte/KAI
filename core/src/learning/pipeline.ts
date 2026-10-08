// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The learning pipeline (spec C5 + D).
 *
 *   completed turn → lesson candidate → classify (memory | skill | none)
 *                  → validate → (skill ⇒ STAGE, never install) → host approves
 *
 * Three properties are the point of this module:
 *
 *   1. `proposeFromTurn(event)` is PURE. It extracts a candidate and returns a
 *      proposal. Nothing is written, and the same event always yields the same
 *      decision.
 *   2. A skill is only ever STAGED. `submit` calls `staging.stage`, which writes
 *      to the staging area and returns `{stagedId, sha256}`. Installing requires
 *      a human approval bound to that hash, through the C4 pipeline. There is no
 *      code path here that installs anything, and nothing here can edit
 *      production source.
 *   3. A rejected candidate writes NOTHING. Validation happens BEFORE the stage
 *      write, so a download-and-execute body, a traversal id or an invisible
 *      character leaves the staging area and the registry exactly as they were.
 *
 * Redaction runs before staging: a learned skill must never carry a credential
 * into the review a human reads.
 */

import { redactText } from "../redact/index.ts";
import { sha256Hex } from "../skills/hash.ts";
import { renderSkillMarkdown } from "../skills/render.ts";
import type { SkillStaging } from "../skills/staging.ts";
import { classify } from "./classify.ts";
import type { LearningOutcome, LessonProposal, MemoryCandidate, TurnEvent, TurnKind } from "./types.ts";

/** A memory longer than this is a document, not a remembered fact. */
export const MAX_MEMORY_CHARS = 4000;

/**
 * The turn kinds that assert USER authority. Only a host-attested
 * `source === "user"` turn may carry them; `submit` re-checks this so a
 * hand-built proposal cannot bypass `classify`'s gate.
 */
const USER_AUTHORITY_KINDS: readonly TurnKind[] = ["user_correction", "explicit_instruction"];

export interface LearningPipelineDeps {
  /** Where a skill candidate is staged. It cannot install; only the host can. */
  staging: SkillStaging;
  /**
   * How a memory is persisted. Injected so this module never touches
   * `core/src/memory/**`; when omitted, the candidate is returned uninstalled
   * and the host decides.
   */
  memoryWriter?: (candidate: MemoryCandidate) => unknown;
  now?: () => Date;
  idFactory?: () => string;
}

export interface LearningPipeline {
  /** PURE. Extract a candidate from a turn. Writes nothing. */
  proposeFromTurn(event: TurnEvent): LessonProposal;
  /** Validate and route a proposal. Skills are staged; memories go to the host. */
  submit(proposal: LessonProposal): LearningOutcome;
  /** Convenience: proposeFromTurn then submit. */
  learnFromTurn(event: TurnEvent): LearningOutcome;
}

/**
 * The memory entry id a `memoryWriter` returned, if it returned one. The engine's
 * write result is `{ ok, entry, deduped }` on success; anything else yields none.
 * Read structurally so this module keeps holding no import from `memory/**`.
 */
function entryIdOf(written: unknown): string | undefined {
  if (typeof written !== "object" || written === null) return undefined;
  const entry = (written as { entry?: unknown }).entry;
  if (typeof entry !== "object" || entry === null) return undefined;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function slugSkillId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length === 0 ? "learned" : slug;
}

export function createLearningPipeline(deps: LearningPipelineDeps): LearningPipeline {
  const now = deps.now ?? (() => new Date());
  let seq = 0;
  const idFactory = deps.idFactory ?? (() => `les_${now().getTime().toString(36)}_${(seq++).toString(36)}`);

  function proposeFromTurn(event: TurnEvent): LessonProposal {
    const classification = classify(event);
    const proposal: LessonProposal = {
      id: idFactory(),
      createdAt: now().toISOString(),
      sourceEvent: event.kind,
      // Provenance travels with the proposal so `submit` can re-check it. An
      // absent source is the most restrictive value, never `user`.
      source: event.source ?? "external",
      decision: classification.decision,
      confidence: classification.confidence,
      rationale: classification.rationale,
    };
    if (classification.memory !== undefined) proposal.memory = classification.memory;
    if (classification.skillDraft !== undefined) proposal.skillDraft = classification.skillDraft;
    return proposal;
  }

  function submit(proposal: LessonProposal): LearningOutcome {
    // Defence in depth. `classify` already refuses a non-user user-authority
    // turn, but `submit` is itself a path that can write a memory or stage a
    // skill, so it re-checks: even a hand-built proposal cannot turn a
    // non-user `user_correction`/`explicit_instruction` into persistent
    // learning. Observation-shaped turns (a repeated workflow, a failure and
    // its recovery) carry no user authority and are unaffected.
    if (
      proposal.decision !== "none" &&
      USER_AUTHORITY_KINDS.includes(proposal.sourceEvent) &&
      proposal.source !== "user"
    ) {
      return {
        decision: "rejected",
        proposal,
        reasons: [
          `a ${proposal.source ?? "external"}-sourced ${proposal.sourceEvent} is not a user instruction; only a host-attested user turn may be learned`,
        ],
      };
    }

    if (proposal.decision === "none") {
      return { decision: "none", proposal };
    }

    if (proposal.decision === "memory") {
      const candidate = proposal.memory;
      if (candidate === undefined) {
        return { decision: "rejected", proposal, reasons: ["memory proposal carried no candidate"] };
      }
      const content = redactText(candidate.content).trim();
      if (content.length === 0) {
        return { decision: "rejected", proposal, reasons: ["memory content was empty after redaction"] };
      }
      if (content.length > MAX_MEMORY_CHARS) {
        return { decision: "rejected", proposal, reasons: [`memory content exceeds ${MAX_MEMORY_CHARS} characters`] };
      }
      const safe: MemoryCandidate = { type: candidate.type, content, importance: candidate.importance };
      const installed = deps.memoryWriter !== undefined;
      // The writer returns the engine's own write result; its `entry.id` is the
      // artifact this lesson produced. Threading it back is what lets the action
      // trace for `learning.propose` name the exact memory a later turn recalls
      // (see tools/registry.ts artifactIdsOf) — the L2 behaviour-change link.
      const written = installed ? deps.memoryWriter?.(safe) : undefined;
      const entryId = entryIdOf(written);
      return {
        decision: "memory",
        proposal,
        memory: { candidate: safe, installed, ...(entryId !== undefined ? { entryId } : {}) },
      };
    }

    // ── skill: STAGE only, never install ─────────────────────────────────────
    const draft = proposal.skillDraft;
    if (draft === undefined) {
      return { decision: "rejected", proposal, reasons: ["skill proposal carried no draft"] };
    }
    const name = redactText(draft.name).trim() || "learned-skill";
    const description = redactText(draft.description).trim() || name;
    const body = redactText(draft.body);
    const skillId = `${slugSkillId(name).slice(0, 48)}-${sha256Hex(body).slice(0, 6)}`;
    const markdown = renderSkillMarkdown({
      name,
      description,
      body,
      ...(draft.tags !== undefined ? { tags: draft.tags } : {}),
    });

    const staged = deps.staging.stage({ id: skillId, markdown, source: "learned" });
    if (!staged.ok) {
      return { decision: "rejected", proposal, issues: staged.issues, reasons: [staged.error.message] };
    }
    return {
      decision: "skill",
      proposal,
      skill: {
        staged: true,
        stagedId: staged.value.stagedId,
        sha256: staged.value.sha256,
        skillId: staged.value.skillId,
      },
    };
  }

  function learnFromTurn(event: TurnEvent): LearningOutcome {
    return submit(proposeFromTurn(event));
  }

  return { proposeFromTurn, submit, learnFromTurn };
}

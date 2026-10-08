// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Learning — KAI-owned contracts (Phase 2 Parts C/D).
 *
 * The pipeline turns a COMPLETED TURN into a lesson and decides what kind of
 * lesson it is: a memory, a skill, or nothing at all. Two rules are baked into
 * these types:
 *
 *   1. `proposeFromTurn` returns a PROPOSAL with no side effects. Nothing an
 *      event contains — and nothing a model extracted from it — is written by
 *      the extraction step. Validation and approval belong to the host.
 *   2. A skill proposal is ALWAYS a candidate that must be staged and approved.
 *      There is no field, flag or option anywhere that installs a skill from
 *      model output.
 */

import type { MemoryType } from "../shared/contracts.ts";
import type { SkillDraft } from "../skills/render.ts";
import type { SkillIssue } from "../skills/types.ts";

// ── Turn events ───────────────────────────────────────────────────────────────

export type TurnKind =
  | "user_correction"
  | "successful_execution"
  | "repeated_workflow"
  | "failure_recovery"
  | "explicit_instruction";

/**
 * WHO produced a turn event. Provenance is assigned by the HOST at the boundary
 * that received the turn — never inferred from content and never taken from a
 * model, a tool or a fetched page. The classifier may never upgrade it.
 *
 *   user     — the user's own message, attested by the host that received it
 *   worker   — an agent/worker turn
 *   tool     — a tool's output
 *   external — anything from outside the host (a web page, an HTTP caller)
 *   system   — one of KAI's own subsystems
 *
 * Only `user` carries user authority: only a host-attested user turn may make a
 * `user_correction` or an `explicit_instruction` into durable learning. Every
 * other source is a claim about the world, never an instruction the user gave.
 */
export type LearningSource = "user" | "worker" | "tool" | "external" | "system";

export interface TurnContext {
  /**
   * WHO produced this event. REQUIRED: a caller cannot silently omit it. When a
   * value is absent at runtime it is treated as the most restrictive source,
   * `external` — never `user`.
   */
  source: LearningSource;
  /** What the user said, when the event carries it. */
  userText?: string;
  /** What the assistant did, when the event carries it. */
  assistantText?: string;
  /** ISO-8601. Set by the caller; this module never invents a timestamp for an event. */
  at?: string;
}

/** The user corrected KAI. Correction shape is optional: the text alone is enough. */
export interface UserCorrectionEvent extends TurnContext {
  kind: "user_correction";
  correction?: { before: string; after: string };
}

/** A task KAI completed, and how many times the same shape has been seen. */
export interface SuccessfulExecutionEvent extends TurnContext {
  kind: "successful_execution";
  steps?: readonly string[];
  repeatCount?: number;
}

/** The same workflow observed several times. */
export interface RepeatedWorkflowEvent extends TurnContext {
  kind: "repeated_workflow";
  summary: string;
  steps?: readonly string[];
  repeatCount: number;
}

/** Something failed and KAI recovered. */
export interface FailureRecoveryEvent extends TurnContext {
  kind: "failure_recovery";
  failure: string;
  recovery: string;
}

/** The user told KAI to remember or to always do something. */
export interface ExplicitInstructionEvent extends TurnContext {
  kind: "explicit_instruction";
  text: string;
  scope?: "preference" | "procedure";
}

export type TurnEvent =
  | UserCorrectionEvent
  | SuccessfulExecutionEvent
  | RepeatedWorkflowEvent
  | FailureRecoveryEvent
  | ExplicitInstructionEvent;

// ── Proposals and outcomes ────────────────────────────────────────────────────

/** What the extraction step decided. `none` is a real, first-class answer. */
export type LearningDecision = "memory" | "skill" | "none";

/** A memory worth storing. The host owns whether it is written. */
export interface MemoryCandidate {
  type: MemoryType;
  content: string;
  /** 1 (trivia) to 5 (must not be forgotten). */
  importance: number;
}

/** The extraction result. A PROPOSAL — nothing has been written. */
export interface LessonProposal {
  id: string;
  createdAt: string;
  sourceEvent: TurnKind;
  /** The provenance carried over from the turn. `submit` re-checks it. */
  source: LearningSource;
  decision: LearningDecision;
  /** 0..1, the extractor's own confidence. Advisory. */
  confidence: number;
  rationale: string;
  memory?: MemoryCandidate;
  skillDraft?: SkillDraft;
}

/**
 * What the host did with a proposal. A skill outcome is only ever STAGED — the
 * install still requires a human approval bound to the staged bytes.
 */
export interface LearningOutcome {
  decision: LearningDecision | "rejected";
  proposal: LessonProposal;
  memory?: { candidate: MemoryCandidate; installed: boolean; entryId?: string };
  skill?: { staged: boolean; stagedId?: string; sha256?: string; skillId?: string };
  /** Validation issues, when a skill candidate was refused. */
  issues?: SkillIssue[];
  /** Human-readable reasons, when a memory candidate was refused. */
  reasons?: string[];
}

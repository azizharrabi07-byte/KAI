// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Classification: turn a completed event into MEMORY | SKILL | NONE.
 *
 * Deterministic on purpose. This is the extractor's *judgement*, and a judgement
 * that changed run to run could not be reviewed, tested or reasoned about. The
 * heuristics below are the honest, boring version of "what is worth keeping":
 *
 *   - A correction of a FACT or PREFERENCE is a memory.
 *   - A correction that states a PROCEDURE ("always…", "whenever…", numbered
 *     steps) is a skill CANDIDATE — but most corrections are not, which is the
 *     whole point: "not every correction becomes a permanent skill".
 *   - A single successful execution is NOT a skill. A workflow seen at least
 *     REPEAT_THRESHOLD times is.
 *   - A failure and its recovery is a lesson to recall (memory), not a procedure.
 *   - Anything that does not fit is NONE, and NONE writes nothing.
 *
 * The decision here is a PROPOSAL. It is never trusted as an instruction.
 */

import type { MemoryType } from "../shared/contracts.ts";
import type { SkillDraft } from "../skills/render.ts";
import type { MemoryCandidate, TurnEvent, TurnKind } from "./types.ts";

export const REPEAT_THRESHOLD = 3;

const PROCEDURE_MARKERS =
  /\b(always|whenever|every\s+time|each\s+time|from\s+now\s+on|in\s+future|step\s*\d|first\b[^.\n]{0,80}\bthen\b|instead\s+of|do\s+not\s+ever|never\s+(?:do|use|call|push|commit))\b/i;

const PREFERENCE_MARKERS =
  /\b(prefer|prefers|i\s+like|i\s+don'?t\s+like|remember\s+that|remember\s+i|my\s+name\s+is|call\s+me|works?\s+in)\b/i;

export interface Classification {
  decision: "memory" | "skill" | "none";
  confidence: number;
  rationale: string;
  memory?: MemoryCandidate;
  skillDraft?: SkillDraft;
}

/**
 * The turn kinds that assert USER authority: a correction of the user's, or an
 * instruction the user gave. Only a host-attested `source === "user"` turn may
 * carry them; for any other source (and for an omitted source) they are NONE.
 */
const USER_AUTHORITY_KINDS: readonly TurnKind[] = ["user_correction", "explicit_instruction"];

function clean(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function stepCount(text: string): number {
  // Whitespace may already be collapsed by `clean`, so count a numbered/bulleted
  // item anywhere a token boundary precedes it (not only after a newline).
  const numbered = text.match(/(?:^|\s)(?:\d+[.)]|[-*])\s+/g);
  const sequential = text.match(/\bthen\b/gi);
  return (numbered?.length ?? 0) + (sequential?.length ?? 0);
}

function stepsToBody(steps: readonly string[] | undefined): string {
  if (steps === undefined || steps.length === 0) return "Follow the recorded steps.";
  return steps.map((step, index) => `${index + 1}. ${clean(step)}`).join("\n");
}

function skillName(hint: string): string {
  const slug = hint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length === 0 ? "learned-skill" : slug;
}

function firstSentence(text: string): string {
  const first = text.split(/[.\n]/)[0] ?? "";
  const cleaned = first.trim();
  return (cleaned.length === 0 ? text.trim() : cleaned).slice(0, 200);
}

function skillDecision(rationale: string, body: string, hint: string): Classification {
  const text = clean(body);
  return {
    decision: "skill",
    confidence: 0.6,
    rationale,
    skillDraft: {
      name: skillName(hint.length > 0 ? hint : text),
      description: firstSentence(text.length > 0 ? text : hint),
      tags: ["learned"],
      body: text.length > 0 ? text : hint,
    },
  };
}

function memoryDecision(
  type: MemoryType,
  content: string,
  confidence: number,
  rationale: string,
): Classification {
  const importance = type === "user_preference" ? 4 : type === "project_fact" ? 4 : 3;
  return { decision: "memory", confidence, rationale, memory: { type, content: clean(content), importance } };
}

function noneDecision(rationale: string): Classification {
  return { decision: "none", confidence: 0.5, rationale };
}

export function classify(event: TurnEvent): Classification {
  // ── Provenance gate ─────────────────────────────────────────────────────────
  // Authorship is NEVER inferred from content, and nothing a model, a tool or a
  // payload says can upgrade it. A `user_correction` or an `explicit_instruction`
  // is user authority, and only a host-attested `source === "user"` turn may
  // carry it. Any other source — and an omitted source, which is treated as the
  // most restrictive value, `external` — yields NONE: no memory, no skill.
  if (USER_AUTHORITY_KINDS.includes(event.kind) && event.source !== "user") {
    const source = event.source ?? "external";
    return noneDecision(
      `a ${source}-sourced ${event.kind} is not a user instruction; only a host-attested user turn may create user authority`,
    );
  }

  switch (event.kind) {
    case "explicit_instruction": {
      const text = clean(event.text);
      if (event.scope === "procedure" || PROCEDURE_MARKERS.test(text)) {
        return skillDecision("an explicit procedural instruction", text, text);
      }
      const type: MemoryType =
        event.scope === "preference" || PREFERENCE_MARKERS.test(text) ? "user_preference" : "project_fact";
      return memoryDecision(type, text, 0.7, "an explicit instruction states a durable preference or fact");
    }

    case "user_correction": {
      const after = clean(event.correction?.after ?? event.userText ?? "");
      const combined = `${event.userText ?? ""} ${after}`;
      if (PROCEDURE_MARKERS.test(combined) || stepCount(after) >= 2) {
        return skillDecision("a correction that generalises into a repeatable procedure", after || combined, after || combined);
      }
      const type: MemoryType = PREFERENCE_MARKERS.test(combined) ? "user_preference" : "project_fact";
      return memoryDecision(
        type,
        after || combined,
        0.55,
        "a one-off factual correction; not every correction becomes a permanent skill",
      );
    }

    case "successful_execution": {
      const repeat = event.repeatCount ?? 0;
      if (repeat >= REPEAT_THRESHOLD) {
        return skillDecision(`a workflow repeated ${repeat} times`, stepsToBody(event.steps), "repeated-workflow");
      }
      return noneDecision("a single successful execution is not a repeatable procedure");
    }

    case "repeated_workflow": {
      if (event.repeatCount >= REPEAT_THRESHOLD) {
        return skillDecision(`a workflow observed ${event.repeatCount} times`, stepsToBody(event.steps), event.summary);
      }
      return noneDecision(
        `workflow seen ${event.repeatCount} time(s); below the repeat threshold of ${REPEAT_THRESHOLD}`,
      );
    }

    case "failure_recovery": {
      const content = `Failure: ${clean(event.failure)}\nRecovery: ${clean(event.recovery)}`;
      return memoryDecision("note", content, 0.6, "a failure and its recovery is a lesson to recall, not yet a procedure");
    }

    default:
      return noneDecision("unrecognised turn; nothing to learn");
  }
}

export type { TurnKind };

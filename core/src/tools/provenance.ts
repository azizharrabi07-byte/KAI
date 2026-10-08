// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Tool provenance — what an action PRODUCED, and the dedupe rule.
 *
 * One function, `deriveToolProvenance`, is called at the ONE place every
 * executed action passes (the registry's `invoke`), and it is the only place
 * artifact ids are read off a result. Two rules govern it:
 *
 * ── 1. Creation-only naming, generically ─────────────────────────────────────
 *
 * The pinned defect (`tests/adversarial-observability.test.ts`): a deduped
 * `memory.write` returns the EXISTING entry id, so a second action record named
 * a memory it did not create and a trace resolved to the wrong action. The fix
 * must not be one special case per tool — a tool that learns to dedupe later
 * would reintroduce the mislink silently. So the plane applies a GENERIC guard:
 *
 *     a result that reports `deduped: true` — at its top level, or one level
 *     down under `value` (a SkillResult-shaped envelope) — names NO artifact.
 *
 * Any tool whose operation can find an existing artifact must propagate that
 * signal in its result, and the plane then refuses to name anything. (Known
 * residual, reported not papered over: `learning.propose` does not propagate the
 * signal from the memory write it performs — `learning/pipeline.ts` drops
 * `deduped` before the tool result exists — so a deduped learned memory is still
 * named by its learning action. That file is outside Stream C; the rule above
 * is what its fix must satisfy.)
 *
 * ── 2. Executed actions only ─────────────────────────────────────────────────
 *
 * A refusal (denied / parked / invalid / not found) names nothing, even if its
 * INPUT carries an id-shaped field: a `mission.cancel` that policy refused did
 * not cancel the mission. Provenance for a refusal reports the honest empty set
 * — the same discipline as `resultState` on the record.
 *
 * ── Why the per-tool shapes remain ───────────────────────────────────────────
 *
 * Reading WHICH artifact a result names is inherently per-tool (each engine has
 * its own result shape), so the switch below is boundary knowledge kept in one
 * place — not a second policy. Only an id that is really present is returned:
 * nothing is guessed, and a tool whose result names no artifact yields none.
 */

import { employeeOfToolInput } from "../observability/action-record.ts";
import type { ToolArtifactIds, ToolProvenance } from "./types.ts";

/** A non-empty string `id` off an object value, if it has one. */
function idOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** A non-empty string at `key` off an object value, if it has one. */
function stringAt(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/**
 * The generic dedupe signal: `deduped: true` on the result, or on a
 * SkillResult-style `{ ok, value }` envelope's `value`.
 */
export function dedupeSignalOf(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ((result as { deduped?: unknown }).deduped === true) return true;
  const value = (result as { value?: unknown }).value;
  if (typeof value === "object" && value !== null && (value as { deduped?: unknown }).deduped === true) {
    return true;
  }
  return false;
}

/**
 * The artifact ids a SUCCESSFUL execution names, by tool. See the module header:
 * per-tool result shapes, one place, ids only when really present.
 */
export function deriveArtifactIds(toolId: string, input: unknown, result: unknown): ToolArtifactIds {
  const out: ToolArtifactIds = {};
  switch (toolId) {
    case "memory.write": {
      // The engine's write result: { ok, entry, deduped }. The dedupe guard has
      // already suppressed naming for a deduped write (see the module header);
      // this branch reads the entry the write produced.
      const writeResult = result as { entry?: unknown } | undefined;
      const id = idOf(writeResult?.entry) ?? idOf(result);
      if (id !== undefined) out.memoryId = id;
      break;
    }
    case "memory.create": {
      // The legacy row is built by the caller, so its id is on the input.
      const id = idOf(input) ?? idOf(result);
      if (id !== undefined) out.memoryId = id;
      break;
    }
    case "skill.toggle":
    case "skill.delete": {
      // A SkillResult carries the record (toggle) or `true` (delete); delete
      // still knows which id it removed because the caller passed it in.
      const id = idOf((result as { value?: unknown } | undefined)?.value) ?? idOf(result) ?? idOf(input);
      if (id !== undefined) out.skillId = id;
      break;
    }
    case "learning.propose": {
      // The proposal names the learning event; a staged skill names itself; a
      // learned MEMORY names the exact entry it wrote, so the action trace links
      // "the user was understood" to the artifact that later turns recall.
      const id = stringAt((result as { proposal?: unknown } | undefined)?.proposal, "id");
      if (id !== undefined) out.learningEventId = id;
      const skillId = stringAt((result as { skill?: unknown } | undefined)?.skill, "skillId");
      if (skillId !== undefined) out.skillId = skillId;
      const memoryId = stringAt((result as { memory?: unknown } | undefined)?.memory, "entryId");
      if (memoryId !== undefined) out.memoryId = memoryId;
      break;
    }
    case "checkpoint.create":
    case "checkpoint.restore": {
      const id = idOf((result as { checkpoint?: unknown } | undefined)?.checkpoint) ?? idOf(input);
      if (id !== undefined) out.checkpointId = id;
      break;
    }
    case "schedule.manage": {
      const id =
        idOf((result as { schedule?: unknown } | undefined)?.schedule) ??
        idOf(result) ??
        idOf((input as { task?: unknown } | undefined)?.task);
      if (id !== undefined) out.scheduleId = id;
      break;
    }
    case "missions.create": {
      // The tool returns the created Mission; the HTTP route records the same
      // way, naming the mission it just started.
      const id = idOf(result);
      if (id !== undefined) out.missionId = id;
      break;
    }
    case "mission.cancel": {
      // The target was supplied, not created: `{id}` is the mission acted on.
      const id = idOf(input);
      if (id !== undefined) out.missionId = id;
      break;
    }
    case "approval.decide": {
      // The decided approval is the INPUT id; a verdict that resumed a mission
      // also names it in the result, so both facts land on the record.
      const decided = idOf(input);
      if (decided !== undefined) out.approvalId = decided;
      const missionId = stringAt(result, "missionId");
      if (missionId !== undefined) out.missionId = missionId;
      break;
    }
  }
  return out;
}

/**
 * The provenance of ONE attempt.
 *
 * `executed` is true only when `execute()` really ran; a refusal yields the
 * honest empty artifact set. `result` is read only when executed.
 */
export function deriveToolProvenance(args: {
  toolId: string;
  input: unknown;
  result?: unknown;
  source: string;
  executed: boolean;
}): ToolProvenance {
  // Which employee a call reached, and which capability it exercised, are
  // boundary facts the plane already knows how to derive — kept here so the
  // invocation and the record cannot disagree about who did it.
  const employeeId = employeeOfToolInput(args.toolId, args.input);
  const capabilityId = args.toolId.startsWith("capability.")
    ? args.toolId.slice("capability.".length)
    : undefined;
  const deduped = args.executed && dedupeSignalOf(args.result);
  const artifacts =
    args.executed && !deduped ? deriveArtifactIds(args.toolId, args.input, args.result) : {};
  return {
    source: args.source,
    executorType: employeeId !== undefined ? "employee" : "kai",
    ...(employeeId !== undefined ? { employeeId } : {}),
    ...(capabilityId !== undefined ? { capabilityId } : {}),
    deduped,
    artifacts,
  };
}

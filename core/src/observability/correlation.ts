// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Phase 2 Part L — the READ side of the action record's correlation ids.
 *
 * The action record already carries optional `scheduleId`, `missionId`, `turnId`,
 * `memoryId`, `skillId`, `learningEventId`, `checkpointId` and `recoveryDecision`
 * (see ./action-record.ts). Those ids are only worth carrying if something can
 * USE them to answer the question Part L exists for:
 *
 *   "Which schedule/execution caused this memory (or skill, or learning) write,
 *    and which mission/turn did it happen in?"
 *
 * This module is that reader. It is deliberately NOT a second logging
 * architecture: it imports the frozen `KaiEvent` shape and the existing
 * `ActionRecord`, reads the events the one bus already publishes, and returns a
 * plain answer. It writes nothing, owns no store and has no lifecycle — the
 * single bus remains the only place state is produced.
 *
 * Everything is optional on the way in and on the way out: a record that names
 * no artifact, or an artifact no record names, is a real, first-class answer
 * (`linked: false`) rather than a throw. An audit reader that can explode on a
 * sparse record would be useless at exactly the moment it is needed.
 */

import type { KaiEvent } from "../shared/contracts.ts";
import type { ActionRecord } from "./action-record.ts";

/** The correlation ids one action record carries. Every field except actionId is optional. */
export interface CorrelationIds {
  /** Which scheduled task fired the chain, when a schedule started it. */
  scheduleId?: string;
  /** Which mission the action belonged to. */
  missionId?: string;
  /** Which worker turn the action belonged to. */
  turnId?: string;
  /** Unique per action attempt: the action's own identity. */
  actionId: string;
  /** The checkpoint an action created/touched, when it did. */
  checkpointId?: string;
  /** The recovery classification the action was decided on, when it was. */
  recoveryDecision?: string;
  /** The memory artifact an action wrote. */
  memoryId?: string;
  /** The skill artifact an action produced/revisioned. */
  skillId?: string;
  /** The learning event an action produced. */
  learningEventId?: string;
}

/** Which kind of artifact an id names. */
export type ArtifactKind = "memory" | "skill" | "learning" | "checkpoint";

export interface ArtifactRef {
  kind: ArtifactKind;
  id: string;
}

/** The answer to "what produced this artifact, and where did it come from?". */
export interface CorrelationTrace {
  artifact: ArtifactRef;
  /** True when an action.executed record names this artifact. */
  linked: boolean;
  /** The record that names it, when one exists. */
  action?: ActionRecord;
  actionId?: string;
  scheduleId?: string;
  missionId?: string;
  turnId?: string;
  checkpointId?: string;
  recoveryDecision?: string;
  /** A human-readable, honest statement of what the trace did or did not find. */
  reason: string;
}

/** The record field that carries an artifact id, by artifact kind. */
type ArtifactField = "memoryId" | "skillId" | "learningEventId" | "checkpointId";

const FIELD_FOR_KIND: Readonly<Record<ArtifactKind, ArtifactField>> = {
  memory: "memoryId",
  skill: "skillId",
  learning: "learningEventId",
  checkpoint: "checkpointId",
};

/** Extract the correlation the record actually carries. */
export function correlationOf(record: ActionRecord): CorrelationIds {
  const ids: CorrelationIds = { actionId: record.actionId };
  if (record.scheduleId !== undefined) ids.scheduleId = record.scheduleId;
  if (record.missionId !== undefined) ids.missionId = record.missionId;
  if (record.turnId !== undefined) ids.turnId = record.turnId;
  if (record.checkpointId !== undefined) ids.checkpointId = record.checkpointId;
  if (record.recoveryDecision !== undefined) ids.recoveryDecision = record.recoveryDecision;
  if (record.memoryId !== undefined) ids.memoryId = record.memoryId;
  if (record.skillId !== undefined) ids.skillId = record.skillId;
  if (record.learningEventId !== undefined) ids.learningEventId = record.learningEventId;
  return ids;
}

/**
 * A record is what an `action.executed` payload should be. Shape check only —
 * enough to walk the stream safely without trusting an arbitrary payload.
 */
function isActionRecordPayload(payload: unknown): payload is ActionRecord {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { actionId?: unknown }).actionId === "string"
  );
}

/** Every action record carried by `events`, in the order the events appear. */
export function actionRecords(events: readonly KaiEvent[]): ActionRecord[] {
  const out: ActionRecord[] = [];
  for (const event of events) {
    if (event.type !== "action.executed") continue;
    if (isActionRecordPayload(event.payload)) out.push(event.payload);
  }
  return out;
}

/**
 * Resolve the chain that produced one artifact.
 *
 * The link is the artifact id the record carries: an action that wrote memory
 * `mem_1` names it in `memoryId`, so `traceArtifact(events, {kind:"memory",
 * id:"mem_1"})` finds that record and returns the schedule/mission/turn the
 * record names. A missing link is reported, never guessed.
 */
export function traceArtifact(
  events: readonly KaiEvent[],
  artifact: ArtifactRef,
): CorrelationTrace {
  const field = FIELD_FOR_KIND[artifact.kind];
  const action = actionRecords(events).find((record) => record[field] === artifact.id);

  if (action === undefined) {
    return {
      artifact,
      linked: false,
      reason: `no action.executed record names ${artifact.kind} "${artifact.id}"`,
    };
  }

  const trace: CorrelationTrace = {
    artifact,
    linked: true,
    action,
    actionId: action.actionId,
    reason: `linked to action "${action.actionId}" via ${field}`,
  };
  if (action.scheduleId !== undefined) trace.scheduleId = action.scheduleId;
  if (action.missionId !== undefined) trace.missionId = action.missionId;
  if (action.turnId !== undefined) trace.turnId = action.turnId;
  if (action.checkpointId !== undefined) trace.checkpointId = action.checkpointId;
  if (action.recoveryDecision !== undefined) trace.recoveryDecision = action.recoveryDecision;
  return trace;
}

/**
 * The one-question convenience over `traceArtifact`: did this artifact come from
 * a scheduled run, and if so which schedule, mission and turn? Returns undefined
 * only when nothing links at all; a link with no schedule is reported with
 * `scheduleId: undefined` rather than fabricated.
 */
export function scheduleOriginOf(
  events: readonly KaiEvent[],
  artifact: ArtifactRef,
): { scheduleId?: string; missionId?: string; turnId?: string; actionId: string } | undefined {
  const trace = traceArtifact(events, artifact);
  if (!trace.linked || trace.actionId === undefined) return undefined;
  const origin: { scheduleId?: string; missionId?: string; turnId?: string; actionId: string } = {
    actionId: trace.actionId,
  };
  if (trace.scheduleId !== undefined) origin.scheduleId = trace.scheduleId;
  if (trace.missionId !== undefined) origin.missionId = trace.missionId;
  if (trace.turnId !== undefined) origin.turnId = trace.turnId;
  return origin;
}

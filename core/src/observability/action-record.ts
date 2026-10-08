// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Who actually did this? (Phase 1: action observability)
 *
 * One record shape, emitted on the EXISTING event bus for every executable action,
 * so the question the stale-Core incident made urgent is answerable after the fact:
 *
 *   "Who performed this action, through which capability, under which policy
 *    decision, which approval, and which Core build?"
 *
 * Deliberately not a second logging architecture: this is a payload on the bus KAI
 * already has, persisted by the existing shouldPersist rule and redacted by the
 * existing redactor. A parallel log would drift from the bus and be wrong at
 * exactly the moment it was needed.
 *
 * `coreBuildId` is the field that would have caught the incident immediately: a
 * record naming a build that is not the build under review is self-evidently wrong,
 * without anyone having to trust a port number.
 */

import { redactText } from "../redact/index.ts";

/** KAI acts directly, or via an employee. There is no third kind. */
export type ExecutorType = "kai" | "employee";

/** How the action ended, in the vocabulary the decision already uses. */
export type ActionResultState =
  | "EXECUTED"
  | "DENIED"
  | "APPROVAL_REQUIRED"
  | "FAILED"
  | "NOT_FOUND"
  | "INVALID";

export interface ActionRecord {
  /** Which Core build performed this. The anti-stale-Core field. */
  coreBuildId: string;
  missionId?: string;
  turnId?: string;
  /**
   * Phase 2 correlation ids. They are the SAME record shape on the SAME bus —
   * not a second logging architecture. A record only carries the ids that
   * apply: a memory write names its entry, an install its skill revision, a
   * schedule its task, a checkpoint its id, a recovery decision its execution.
   */
  memoryId?: string;
  skillId?: string;
  learningEventId?: string;
  scheduleId?: string;
  checkpointId?: string;
  /** The recovery classification a decision was made on (BEFORE_ACCEPT, …). */
  recoveryDecision?: string;
  /** Unique per action attempt, so a retry is a new record not a duplicate. */
  actionId: string;
  executorType: ExecutorType;
  /** Set only for employee actions: which employee. */
  employeeId?: string;
  employeeInstanceId?: string;
  /** Set when the action ran through a registered capability. */
  capabilityId?: string;
  /** The boundary that decided: a tool id today. */
  toolId: string;
  policyDecision: string;
  /** Which authority decided: a rule, the mode, or the default. */
  decisionSource: string;
  approvalId?: string;
  startedAt: string;
  completedAt: string;
  resultState: ActionResultState;
  /** Bounded, redacted detail. Never a full payload: a record is a trace, not a transcript. */
  detail?: string;
}

const MAX_DETAIL = 400;

/**
 * Build a record. Text that could carry a credential is redacted before it is put
 * on the bus — the same boundary every other persistence path uses, because an
 * audit log that leaks a key is worse than no audit log.
 */
export function buildActionRecord(input: {
  coreBuildId: string;
  actionId: string;
  toolId: string;
  policyDecision: string;
  decisionSource: string;
  resultState: ActionResultState;
  startedAt: string;
  completedAt: string;
  missionId?: string;
  turnId?: string;
  employeeId?: string;
  employeeInstanceId?: string;
  capabilityId?: string;
  approvalId?: string;
  memoryId?: string;
  skillId?: string;
  learningEventId?: string;
  scheduleId?: string;
  checkpointId?: string;
  recoveryDecision?: string;
  detail?: string;
}): ActionRecord {
  const record: ActionRecord = {
    coreBuildId: input.coreBuildId,
    actionId: input.actionId,
    // An employee action is one that ran through the worker tool; everything else
    // KAI did itself. Derived rather than passed in, so a caller cannot mislabel
    // itself as KAI when it delegated.
    executorType: input.employeeId !== undefined ? "employee" : "kai",
    toolId: input.toolId,
    policyDecision: input.policyDecision,
    decisionSource: input.decisionSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    resultState: input.resultState,
  };
  if (input.missionId !== undefined) record.missionId = input.missionId;
  if (input.turnId !== undefined) record.turnId = input.turnId;
  if (input.employeeId !== undefined) record.employeeId = input.employeeId;
  if (input.employeeInstanceId !== undefined) record.employeeInstanceId = input.employeeInstanceId;
  if (input.capabilityId !== undefined) record.capabilityId = input.capabilityId;
  if (input.approvalId !== undefined) record.approvalId = input.approvalId;
  if (input.memoryId !== undefined) record.memoryId = input.memoryId;
  if (input.skillId !== undefined) record.skillId = input.skillId;
  if (input.learningEventId !== undefined) record.learningEventId = input.learningEventId;
  if (input.scheduleId !== undefined) record.scheduleId = input.scheduleId;
  if (input.checkpointId !== undefined) record.checkpointId = input.checkpointId;
  if (input.recoveryDecision !== undefined) record.recoveryDecision = input.recoveryDecision;
  if (input.detail !== undefined) {
    const redacted = redactText(input.detail);
    record.detail = redacted.length > MAX_DETAIL ? `${redacted.slice(0, MAX_DETAIL)}…` : redacted;
  }
  return record;
}

/**
 * The worker tool is the single path to an employee (Part F/§6), so it is also the
 * single place that decides which employee a record names.
 */
export function employeeOfToolInput(toolId: string, input: unknown): string | undefined {
  if (toolId !== "agents.run_task") return undefined;
  if (typeof input !== "object" || input === null) return undefined;
  const agentId = (input as { agentId?: unknown }).agentId;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : undefined;
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * coucou-map.ts — KAI lifecycle events → Coucou's supported event vocabulary.
 *
 * Coucou accepts a fixed set of names and gives each a meaning in its pill state
 * machine. This module maps ONLY the pairs where KAI's event and Coucou's name mean
 * the same thing; anything else is dropped rather than relabelled to make the pill
 * look busier.
 *
 * Two rules that exist because their absence would be a lie:
 *
 *   • `PreToolUse` is never emitted. KAI's vocabulary has no "a tool just started"
 *     event, so emitting one for a worker dispatch would fabricate a tool call that
 *     never happened. `PostToolUse` comes only from `action.executed`, which records
 *     an action that actually ran.
 *
 *   • `PermissionRequest` is never emitted. Coucou does not support third-party
 *     approvals: its relay answers with no decision. An `approval.requested` becomes
 *     a `Notification` telling the person a decision is waiting in KAI — never a card
 *     that pretends clicking it approves anything.
 */

import type { KaiEvent } from "../shared/contracts.ts";
import type { CoucouEventName } from "./coucou.ts";

export interface CoucouOutbound {
  name: CoucouEventName;
  sessionId: string;
  fields: Record<string, unknown>;
}

/** The fixed text for a pending decision: a status line, not an approval surface. */
export const APPROVAL_WAITING_MESSAGE = "KAI is waiting for your decision";

/** Read a string member from an untyped payload without asserting a shape. */
function payloadString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!(key in payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The session id every event of one unit of work shares.
 *
 * Correlated from start to terminal, so Coucou replaces the pill's state instead of
 * accumulating a phantom session per event.
 */
function sessionIdFor(event: KaiEvent): string {
  if (typeof event.missionId === "string" && event.missionId.length > 0) return event.missionId;
  const goalId = payloadString(event.payload, "goalId");
  if (goalId !== null) return `goal-${goalId}`;
  return event.id;
}

/**
 * The pure mapping. No state, no clock: a test can call it directly.
 *
 * Returns every Coucou event this KAI event justifies — an empty array for the
 * overwhelming majority, which is what keeps the pill from narrating.
 */
export function mapKaiEvent(event: KaiEvent): CoucouOutbound[] {
  const sessionId = sessionIdFor(event);
  const workerLabel = payloadString(event.payload, "subagentId") ?? payloadString(event.payload, "employeeId");

  switch (event.type) {
    case "mission.started":
      return [{ name: "SessionStart", sessionId, fields: {} }];

    case "agent.run_started":
      return [{ name: "UserPromptSubmit", sessionId, fields: workerLabel === null ? {} : { prompt: workerLabel } }];

    case "action.executed": {
      // A real action completed. `toolId` is the boundary that decided, and is the
      // closest honest equivalent of Coucou's `tool_name`.
      const toolId = payloadString(event.payload, "toolId");
      return [{ name: "PostToolUse", sessionId, fields: toolId === null ? {} : { tool_name: toolId } }];
    }

    case "agent.run_failed":
      return [
        {
          name: "PostToolUseFailure",
          sessionId,
          fields: workerLabel === null ? {} : { tool_name: workerLabel },
        },
      ];

    case "approval.requested":
      // A status line. NOT a PermissionRequest: Coucou cannot decide for KAI.
      return [{ name: "Notification", sessionId, fields: { message: APPROVAL_WAITING_MESSAGE } }];

    case "mission.completed":
      return [{ name: "Stop", sessionId, fields: {} }];

    case "mission.failed":
      return [{ name: "StopFailure", sessionId, fields: {} }];

    case "mission.cancelled":
      return [{ name: "SessionEnd", sessionId, fields: {} }];

    default:
      // Not mapped on purpose. `mission.progress` is the loud one: it fires often
      // and describes no state change Coucou has a word for.
      return [];
  }
}

/** How long an identical event is considered a repeat of the last one. */
const REPEAT_WINDOW_MS = 1000;

/**
 * `mapKaiEvent` plus a repeat guard.
 *
 * The bus can publish the same transition more than once (a retry, a replayed
 * resume, two subscribers on one turn). Coucou would show that as activity, so the
 * last `(session, name, label)` is remembered and a repeat inside the window is
 * skipped. State lives here rather than in the bridge so it is testable alone.
 */
export function createCoucouMapper(options: { now?: () => number; windowMs?: number } = {}): (event: KaiEvent) => CoucouOutbound[] {
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? REPEAT_WINDOW_MS;
  const lastSeen = new Map<string, number>();

  return (event: KaiEvent): CoucouOutbound[] => {
    const mapped = mapKaiEvent(event);
    if (mapped.length === 0) return mapped;
    const at = now();
    const out: CoucouOutbound[] = [];
    for (const item of mapped) {
      const label = typeof item.fields["tool_name"] === "string" ? item.fields["tool_name"] : "";
      const key = `${item.sessionId}\u0000${item.name}\u0000${label}`;
      const previous = lastSeen.get(key);
      if (previous !== undefined && at - previous < windowMs) continue;
      lastSeen.set(key, at);
      out.push(item);
    }
    // A long mission must not grow this map without bound; drop entries that can no
    // longer suppress anything.
    if (lastSeen.size > 256) {
      for (const [key, seenAt] of lastSeen) {
        if (at - seenAt >= windowMs) lastSeen.delete(key);
      }
    }
    return out;
  };
}

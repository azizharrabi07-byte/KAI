// Chat activity — the tool and worker work behind a turn, as rows.
//
// KAI's reply is only half of what happened: a turn may drive a worker, run a
// tool, park an approval and touch memory. Those are real Core events
// (`CoreEventRow`), already mirrored into the app store from the one SSE stream
// — this module turns them into short, KAI-facing rows for the chat's activity
// strip. It invents nothing: a row exists only because Core published the event.

import type { CoreEventRow } from "../core/core-state";

export type ActivityKind = "tool" | "worker" | "mission" | "approval" | "memory" | "session" | "info";

export interface ActivityRow {
  /** Dedupe key: the event id when present, else type+time. */
  key: string;
  kind: ActivityKind;
  text: string;
  at: string;
}

function kindOf(type: string): ActivityKind {
  if (type === "action.executed") return "tool";
  if (type.startsWith("agent.")) return "worker";
  if (type.startsWith("mission.")) return "mission";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("memory.")) return "memory";
  if (type.startsWith("session.")) return "session";
  return "info";
}

/**
 * The most recent activity rows, newest first.
 *
 * `text` is the event's own human line (`CoreEventRow.text`, produced from the
 * payload), so the chat never paraphrases Core into something it did not say.
 */
export function chatActivity(events: CoreEventRow[], limit = 5): ActivityRow[] {
  const out: ActivityRow[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const key = e.id ?? `${e.type}@${e.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = e.text.trim();
    if (text.length === 0) continue;
    out.push({ key, kind: kindOf(e.type), text, at: e.at });
    if (out.length >= limit) break;
  }
  return out;
}

/** A single glyph/word for an activity kind — KAI's own, no upstream artwork. */
export function activityLabel(kind: ActivityKind): string {
  switch (kind) {
    case "tool":
      return "tool";
    case "worker":
      return "worker";
    case "mission":
      return "mission";
    case "approval":
      return "approval";
    case "memory":
      return "memory";
    case "session":
      return "session";
    default:
      return "note";
  }
}

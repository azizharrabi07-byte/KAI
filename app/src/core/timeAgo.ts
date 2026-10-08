/**
 * Relative time for every "ago" label in the island.
 *
 * Lives here rather than in `views/integrations.ts` so it can be unit-tested
 * without a DOM (`app/tests/timeAgo.test.ts`).
 *
 * ── Why this function is careful about units ────────────────────────────────
 * Callers hand it numbers from two different conventions, and JavaScript's
 * `Date` always reads a number as *milliseconds*:
 *
 *   Hermes   GET /api/sessions    →  started_at: 1790888537.0502937   (Unix SECONDS, float)
 *   Stripe   balance / charges    →  created:     <Unix SECONDS>
 *   OpenCode GET /session         →  time.created: 1790874019236      (Unix MILLISECONDS)
 *   GitHub   user/repos           →  pushed_at:   "2026-10-01T20:11:04Z"  (ISO string)
 *
 * Feeding Hermes' seconds straight to `new Date()` lands in January 1970, and the
 * card rendered exactly that: a session started minutes ago showed "20707d".
 * Verified against the live payload on the Hermes install (2026-10-01).
 *
 * So any numeric timestamp below MS_THRESHOLD is treated as seconds. The
 * threshold is safe because the two conventions are four orders of magnitude
 * apart: 1e11 seconds is the year 5138, while 1e11 milliseconds is 1973. This is
 * a documented convention guard, not a "divide it if it looks big" guess.
 */
const MS_THRESHOLD = 1e11;

/** Millisecond epoch from whatever a caller passes. `NaN` when unusable. */
function toMillis(value: unknown): number {
  if (typeof value === "number") {
    return value < MS_THRESHOLD ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return NaN;
    // JSON sometimes carries numbers as strings; treat those as numbers, so a
    // stringified seconds value does not fall through to the Date parser.
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      return asNumber < MS_THRESHOLD ? asNumber * 1000 : asNumber;
    }
    return new Date(trimmed).getTime();
  }
  if (value instanceof Date) return value.getTime();
  return NaN;
}

/** Same shape as the Swift `timeAgo` computed properties. */
export function timeAgo(value: unknown): string {
  const ms = toMillis(value);
  // A resolved timestamp at or below zero is a *missing* value, not 1970.
  // Hermes' API omits `started_at` entirely when it is absent, and the Rust side
  // maps that absence with `.unwrap_or(0.0)` (integrations.rs:891) — so 0.0
  // arrives meaning "no timestamp", and reading it literally rendered day-scale
  // garbage (~20728d today). No age is the honest output; the caller renders an
  // empty cell.
  //
  // Deliberately no *plausibility floor* beyond this: a small positive value is
  // still read literally, because a floor would also hide legitimately old data.
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = (Date.now() - ms) / 1000;
  if (!Number.isFinite(diff)) return "";
  // A future timestamp (clock skew between KAI and an agent) must never render a
  // negative age; "just now" is the honest reading.
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

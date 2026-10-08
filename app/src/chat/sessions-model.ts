// The sessions list as data — pure, so sort/search/archive rules are testable
// without a DOM. The DOM surface (`views/sessions.ts`) renders exactly this.
//
// Nothing here invents a session: every row comes from Core's `/sessions`
// snapshot. The only transformation is the derived display title
// (`chat/title.ts`), which never overwrites a name a person chose.

import type { CoreSessionRow } from "../core/core-state";
import { sessionDisplayTitle } from "./title";

export type SessionSort = "recent" | "created" | "title" | "turns";

export const SESSION_SORTS: { key: SessionSort; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "created", label: "Created" },
  { key: "title", label: "Title" },
  { key: "turns", label: "Turns" },
];

export interface SessionView {
  id: string;
  /** What to show: the derived topic title, or the stored title when it is a real name. */
  title: string;
  /** True when `title` was derived from the conversation rather than stored. */
  derived: boolean;
  status: string;
  archived: boolean;
  /** True for the one session new turns go to. */
  active: boolean;
  updatedAt?: string;
  turnCount?: number;
  /** The worker this conversation is bound to (demoted detail, never a headline). */
  agentId?: string;
  /** One-line digest excerpt, when the session has recorded turns. */
  excerpt?: string;
}

export interface SessionFilter {
  /** Free text; matched against the display title and the id. */
  query: string;
  sort: SessionSort;
  /** When false, archived sessions are hidden. */
  includeArchived: boolean;
  /** Per-session first user turn, when the caller has loaded it. */
  firstUserText?: (id: string) => string | null | undefined;
}

function ms(value: string | undefined): number {
  if (value === undefined) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/** Project Core's rows into display rows and apply the filter/sort rules. */
export function buildSessionViews(rows: CoreSessionRow[], filter: SessionFilter): SessionView[] {
  const q = filter.query.trim().toLowerCase();
  const out: SessionView[] = [];

  for (const row of rows) {
    const archived = row.status === "ARCHIVED";
    if (archived && !filter.includeArchived) continue;
    const { title, derived } = sessionDisplayTitle(row.title, filter.firstUserText?.(row.id));
    if (q.length > 0 && !title.toLowerCase().includes(q) && !row.id.toLowerCase().includes(q)) continue;
    out.push({
      id: row.id,
      title,
      derived,
      status: row.status,
      archived,
      active: row.active,
      ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
      ...(row.turnCount !== undefined ? { turnCount: row.turnCount } : {}),
      ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
      ...(row.summaryExcerpt !== undefined ? { excerpt: row.summaryExcerpt } : {}),
    });
  }

  // The active session always leads; the rest follow the chosen order. Stable
  // tie-break by id so equal timestamps never reshuffle between frames.
  const cmp = (a: SessionView, b: SessionView): number => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    switch (filter.sort) {
      case "title":
        return a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
      case "turns":
        return (b.turnCount ?? 0) - (a.turnCount ?? 0) || a.id.localeCompare(b.id);
      case "created":
        // `createdAt` is not on the row; a lower id ordering is Core's creation
        // order for the placeholder ids, and `updatedAt` breaks the tie.
        return ms(a.updatedAt) - ms(b.updatedAt) || a.id.localeCompare(b.id);
      case "recent":
      default:
        return ms(b.updatedAt) - ms(a.updatedAt) || a.id.localeCompare(b.id);
    }
  };
  return out.sort(cmp);
}

/** Small, honest summary line for the sessions header. */
export function summariseSessions(views: SessionView[], total: number): string {
  if (total === 0) return "No sessions yet";
  const shown = views.length;
  const active = views.find((v) => v.active)?.title;
  const base = shown === total ? `${total} session${total === 1 ? "" : "s"}` : `${shown} of ${total}`;
  return active !== undefined ? `${base} · active: ${active}` : `${base} · none active`;
}

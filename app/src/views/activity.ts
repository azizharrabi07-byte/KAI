// KAI — the Activity page (owner §D). A PRIMARY surface at real dimensions: the
// live feed of what KAI actually did, from real Core events.
//
// SOURCE
//   The events are the ones KAI Core streams over its SSE bus and the shell
//   folds into the workspace slice (`WorkspaceSlice.events`, fed by
//   `GET /core/events`; the `/core/events` stream is the control-plane bus that
//   carries mission.*, approval.*, agent.*, session.*, core.* …). Each row
//   carries both the neutral Core summary and KAI's own sentence
//   (`presentActivity`), with the worker DEMOTED — KAI is always the subject.
//   This page renders those; it starts no second event path and invents nothing.
//
// ── Attribution (MIT) ────────────────────────────────────────────────────────
// Portions adapted from OpenGhost (github.com/ANDRETRIPOL/OpenGhost), MIT License,
// Copyright (c) 2026 Andrew — the live-stream PRESENTATION mechanism from
// `stream-view.js`: keep a stable list, MORPH existing nodes in place instead of
// rebuilding, and reveal newly-arrived text with a paced wave that
// `prefers-reduced-motion` disables. Only the mechanism was learned; KAI writes
// its own names, pacing values and CSS. See docs/OPEN_GHOST_REUSE_MANIFEST.md §3.

import { h, clear, dot } from "./dom";
import type { WorkspaceSlice, WorkspaceEventRow } from "../workspace/store";
import type { PageContext } from "./tools";
import { OK, WARN, INFO, BAD, INK, DIM, DIM2, MONO } from "./tools";

// ── Pure layer ───────────────────────────────────────────────────────────────

export type ActivityGroup = "all" | "missions" | "approvals" | "sessions" | "workers" | "core" | "tools";

export const ACTIVITY_GROUPS: { id: ActivityGroup; label: string }[] = [
  { id: "all", label: "All" },
  { id: "missions", label: "Missions" },
  { id: "approvals", label: "Approvals" },
  { id: "sessions", label: "Sessions" },
  { id: "workers", label: "Workforce" },
  { id: "tools", label: "Tools" },
  { id: "core", label: "Core" },
];

/** Which group an event's type belongs to. Unknown types are still shown under All. */
export function groupOf(type: string): ActivityGroup {
  if (type.startsWith("mission")) return "missions";
  if (type.startsWith("approval")) return "approvals";
  if (type.startsWith("session")) return "sessions";
  if (type.startsWith("agent") || type.startsWith("workforce") || type.startsWith("subagent")) return "workers";
  if (type.startsWith("worker") || type.startsWith("review") || type.startsWith("delegation") || type.startsWith("benchmark")) return "workers";
  if (type.startsWith("command")) return "tools";
  if (type.startsWith("tool") || type.startsWith("mcp") || type.startsWith("capability")) return "tools";
  if (type.startsWith("core")) return "core";
  return "all";
}

/** KAI's own colour for an event family. KAI-authored values. */
export function groupColor(type: string): string {
  switch (groupOf(type)) {
    case "missions":
      return INFO;
    case "approvals":
      return WARN;
    case "workers":
      return "#A78BFA";
    case "tools":
      return "#22D3EE";
    case "sessions":
      return OK;
    case "core":
      return "#8b93a1";
    default:
      return DIM;
  }
}

/** Filter the feed by group and a free-text query over KAI's line and the Core summary. */
export function filterActivity(events: WorkspaceEventRow[], group: ActivityGroup, query: string): WorkspaceEventRow[] {
  const q = query.trim().toLowerCase();
  return events.filter((e) => {
    if (group !== "all" && groupOf(e.type) !== group) return false;
    if (q === "") return true;
    return (
      e.line.toLowerCase().includes(q) ||
      e.text.toLowerCase().includes(q) ||
      e.type.toLowerCase().includes(q) ||
      (e.worker !== null && e.worker.id.toLowerCase().includes(q))
    );
  });
}

/** A compact relative time ("just now", "4m", "2h", "3d"), from a real timestamp. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 90) return "1m";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 5400) return "1h";
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export interface ActivityPageOptions extends PageContext {
  /** Cap on rendered rows; default 300 (the slice itself is already ring-bounded). */
  maxRows?: number;
}

export interface ActivityPage {
  readonly el: HTMLElement;
  render(slice: WorkspaceSlice): void;
  destroy(): void;
}

export function createActivityPage(options: ActivityPageOptions): ActivityPage {
  const maxRows = options.maxRows ?? 300;

  const el = h("section", {
    class: "kai-page kai-activity-page",
    style: "display:flex;flex-direction:column;height:100%;min-height:0;width:100%;box-sizing:border-box",
  });

  const connChip = h("span", { class: "kai-activity-conn" });
  const countChip = h("span", { class: "kai-activity-count", style: `font:500 11px var(--font,sans-serif);color:${DIM2}` });
  const search = h("input", {
    class: "kai-search",
    type: "search",
    placeholder: "Filter activity…",
    style:
      `font:400 11.5px var(--font,sans-serif);color:${INK};background:rgba(255,255,255,.05);` +
      `border:1px solid rgba(255,255,255,.10);border-radius:8px;padding:5px 10px;min-width:200px;outline:none`,
  });
  const refresh = h("button", {
    class: "kai-btn",
    style: `font:600 11px var(--font,sans-serif);color:${INFO};background:${INFO}14;border:1px solid ${INFO}55;border-radius:7px;padding:3px 10px;cursor:pointer`,
    text: "Refresh",
    onclick: () => options.refresh?.(),
  });
  const filterRow = h("div", { style: "display:flex;gap:5px;align-items:center;flex-wrap:wrap;padding:0 2px 8px" });
  const header = h(
    "div",
    { style: "display:flex;align-items:center;gap:10px;padding:2px 2px 6px;flex-wrap:wrap" },
    h("span", { style: `font:600 15px var(--font,sans-serif);color:${INK}`, text: "Activity" }),
    connChip,
    h("div", { style: "flex:1 1 auto" }),
    countChip,
    search,
    refresh,
  );

  const feed = h("div", {
    class: "kai-activity-feed",
    style: "flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:1px;padding:0 2px 20px",
  });

  el.append(header, filterRow, feed);

  let slice: WorkspaceSlice | null = null;
  let group: ActivityGroup = "all";
  let query = "";
  // morph map: event key → the row element, so arrivals animate and old rows
  // never flicker. Keyed by id when Core gave one, else type+timestamp.
  const rows = new Map<string, HTMLElement>();

  function keyOf(e: WorkspaceEventRow): string {
    return e.id ?? `${e.type}@${e.at}`;
  }

  function buildGroupChips(): void {
    clear(filterRow);
    for (const g of ACTIVITY_GROUPS) {
      const on = g.id === group;
      filterRow.append(
        h("button", {
          class: on ? "kai-chip on" : "kai-chip",
          style:
            `font:${on ? 600 : 500} 10.5px var(--font,sans-serif);cursor:pointer;border-radius:999px;padding:2px 10px;` +
            `color:${on ? INK : DIM};background:${on ? "rgba(255,255,255,.08)" : "transparent"};` +
            `border:1px solid ${on ? "rgba(255,255,255,.22)" : "rgba(255,255,255,.09)"}`,
          text: g.label,
          onclick: () => {
            group = g.id;
            buildGroupChips();
            renderFeed(false);
          },
        }),
      );
    }
  }

  // ── feed rendering (morph in place; wave the arrivals) ───────────────────
  function renderFeed(animate = true): void {
    if (slice === null) return;
    const events = filterActivity(slice.events, group, query).slice(0, maxRows);
    countChip.textContent = `${events.length} of ${slice.events.length}`;

    if (events.length === 0) {
      clear(feed);
      rows.clear();
      feed.append(
        h("div", { style: `margin-top:16px;font:400 12px var(--font,sans-serif);color:${DIM}`, text: slice.events.length === 0 ? "No Core activity yet." : "Nothing matches the filter." }),
      );
      return;
    }

    // Drop the empty-state node(s) the moment real rows exist.
    for (const child of [...feed.children]) if (!(child as HTMLElement).dataset.row) child.remove();

    const wanted = new Set(events.map(keyOf));
    // remove rows no longer in the filtered set
    for (const [key, node] of [...rows]) {
      if (!wanted.has(key)) {
        node.remove();
        rows.delete(key);
      }
    }
    // place rows newest-first, morphing existing nodes in place
    let cursor = feed.firstElementChild as HTMLElement | null;
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i]!;
      const key = keyOf(e);
      let node = rows.get(key);
      const isNew = node === undefined;
      if (node === undefined) {
        node = eventRow(e);
        node.dataset.row = "1";
        rows.set(key, node);
      } else {
        morphRow(node, e);
      }
      if (cursor !== node) {
        feed.insertBefore(node, cursor);
      } else {
        cursor = cursor.nextElementSibling as HTMLElement | null;
      }
      if (isNew && animate && !reducedMotion()) wave(node, i);
    }
  }

  /** Update an existing row's text in place, the way a live stream morphs nodes. */
  function morphRow(node: HTMLElement, e: WorkspaceEventRow): void {
    const line = node.querySelector<HTMLElement>(".kai-activity-line");
    if (line && line.textContent !== e.line) line.textContent = e.line;
    const time = node.querySelector<HTMLElement>(".kai-activity-time");
    if (time) time.textContent = relativeTime(e.at);
    const worker = node.querySelector<HTMLElement>(".kai-activity-worker");
    const label = e.worker !== null ? e.worker.id : "";
    if (worker) {
      worker.textContent = label;
      worker.hidden = label === "";
    }
  }

  /** The staged reveal: staggered fade+lift, disabled under reduced motion. */
  function wave(node: HTMLElement, index: number): void {
    const delay = Math.min(index * 26, 260);
    try {
      node.animate(
        [
          { opacity: 0, transform: "translateY(-5px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 260, delay, easing: "cubic-bezier(0.32,0.72,0,1)", fill: "backwards" },
      );
    } catch {
      /* Web Animations may be unavailable; the row is already visible */
    }
  }

  function eventRow(e: WorkspaceEventRow): HTMLElement {
    const color = groupColor(e.type);
    const rowEl = h("div", {
      class: "kai-activity-row",
      style:
        "display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:7px;" +
        "border-top:1px solid rgba(255,255,255,.045)",
    });
    const worker = e.worker !== null ? e.worker.id : "";
    rowEl.append(
      dot(color, 7),
      h(
        "div",
        { style: "display:flex;align-items:baseline;gap:8px;min-width:0;flex:1 1 auto" },
        h("span", {
          class: "kai-activity-line",
          title: e.text,
          style: `font:400 12px var(--font,sans-serif);color:${INK};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`,
          text: e.line,
        }),
        h("span", {
          class: "kai-activity-type",
          style: `font:500 9.5px ${MONO};color:${color};border:1px solid ${color}55;border-radius:999px;padding:0 6px;flex:0 0 auto`,
          text: e.type,
        }),
      ),
      h("span", {
        class: "kai-activity-worker",
        hidden: worker === "",
        style: `font:400 10px var(--font,sans-serif);color:${DIM};flex:0 0 auto`,
        text: worker,
      }),
      h("span", { class: "kai-activity-time", style: `font:400 10px ${MONO};color:${DIM};flex:0 0 auto;min-width:52px;text-align:right`, text: relativeTime(e.at) }),
    );
    return rowEl;
  }

  function render(next: WorkspaceSlice): void {
    const prevConn = slice?.conn;
    slice = next;
    const ok = next.conn === "ONLINE";
    const color = ok ? OK : next.conn === "OFFLINE" ? BAD : WARN;
    connChip.textContent = next.conn.toLowerCase();
    connChip.setAttribute(
      "style",
      `font:600 10px ${MONO};color:${color};border:1px solid ${color}55;background:${color}1f;border-radius:999px;padding:1px 8px`,
    );
    // The connection chip is the one thing worth a subtle pulse when it flips.
    if (prevConn !== undefined && prevConn !== next.conn && !reducedMotion()) {
      try {
        connChip.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
      } catch {
        /* no Web Animations */
      }
    }
    renderFeed(true);
  }

  function reducedMotion(): boolean {
    try {
      return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  search.addEventListener("input", () => {
    query = search.value;
    renderFeed(false);
  });

  buildGroupChips();
  render({
    conn: "CONNECTING", lastError: null, lastSyncAt: null, tools: [], mcp: null, maintenance: null, actions: [], events: [],
  });

  // Re-tick the relative times every 30s so "just now" ages without a re-render
  // of the whole feed (the stream itself remains the source of new rows).
  const ticker = setInterval(() => {
    if (slice === null) return;
    for (const e of slice.events) {
      const key = keyOf(e);
      const node = rows.get(key);
      const time = node?.querySelector<HTMLElement>(".kai-activity-time");
      if (time) time.textContent = relativeTime(e.at);
    }
  }, 30_000);

  return {
    el,
    render,
    destroy() {
      clearInterval(ticker);
      rows.clear();
      clear(el);
    },
  };
}

// ── The shell seam (Stream A owns the shell; this is the ONE line it adds) ───
//
//   import { mountActivity } from "../views/activity";
//   registerPage("activity", mountActivity);

import type { PageFactory } from "../shell/types";

export const mountActivity: PageFactory = (ctx) => {
  const page = createActivityPage({
    routes: ctx.workspace.routes,
    refresh: () => void ctx.workspace.refresh(),
  });
  const unsubscribe = ctx.workspace.subscribe((slice) => page.render(slice));
  page.render(ctx.workspace.getState());
  return {
    el: page.el,
    sync: () => page.render(ctx.workspace.getState()),
    destroy: () => {
      unsubscribe();
      page.destroy();
    },
  };
};

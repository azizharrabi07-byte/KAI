// Sessions view — KAI's durable conversations, in the main window.
//
// This is the DOM surface the sessions model (`chat/sessions-model.ts`) says
// renders exactly its data. The list is Core's real `/sessions` snapshot; the
// display titles come from `chat/title.ts` (a real name always wins, a generic
// placeholder is replaced by a title DERIVED from the conversation's first user
// turn). Every mutation — create, rename, activate, archive, restore, delete —
// is a real Core call: rename/activate/archive through the base client, the
// governed search and the DESTRUCTIVE delete through `chat/session-routes.ts`,
// which may PARK for approval. A park is shown as a park, never as a success.

import { h, clear, dot } from "./dom";
import "../chat/chat.css";
import type { ShellContext, ShellPage, PageFactory } from "../shell/types";
import type { CoreSessionSummary } from "../core/kai-core";
import type { CoreSessionRow } from "../core/core-state";
import {
  buildSessionViews,
  summariseSessions,
  SESSION_SORTS,
  type SessionSort,
} from "../chat/sessions-model";
import { isGenericSessionTitle, deriveSessionTitle } from "../chat/title";
import { createSessionRoutes, type SessionSearchHit } from "../chat/session-routes";

type Notice = { kind: "ok" | "warn" | "error"; text: string };

/** A short, honest "time since" for the row's last activity. */
function relative(iso: string | undefined): string {
  if (iso === undefined) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** The ONE line the integrator registers for the "sessions" route. */
export const mountSessions: PageFactory = (ctx: ShellContext): ShellPage => {
  const routes = createSessionRoutes({ baseUrl: ctx.client.baseUrl });

  const el = h("section", { class: "kai-page kai-sessions-host" });
  el.style.padding = "0";
  el.style.overflow = "hidden";
  el.style.display = "flex";

  // ── header ────────────────────────────────────────────────────────────────
  const summary = h("span", { class: "sum", text: "" });
  const newBtn = h("button", { class: "kai-btn is-primary", type: "button", text: "New session" });
  const titlebar = h(
    "div",
    { class: "kai-sessions-titlebar" },
    h("span", { class: "name", text: "Sessions" }),
    summary,
    h("span", { class: "grow" }),
    newBtn,
  );

  const search = h("input", { class: "kai-search", type: "text", placeholder: "Search sessions…", spellcheck: "false" });
  const seg = h("div", { class: "kai-seg" });
  const archiveToggle = h("input", { type: "checkbox" });
  const archiveCheck = h("label", { class: "kai-check" }, archiveToggle, h("span", { text: "Show archived" }));
  const controls = h("div", { class: "kai-sessions-controls" }, search, seg, archiveCheck);

  const head = h("div", { class: "kai-sessions-head" }, titlebar, controls);
  const list = h("div", { class: "kai-sessions-list" });
  const note = h("div", { class: "kai-sessions-note" });

  el.append(h("div", { class: "kai-sessions" }, head, list, note));

  // ── state ─────────────────────────────────────────────────────────────────
  let rows: CoreSessionSummary[] = [];
  let activeId: string | null = null;
  let query = "";
  let sort: SessionSort = "recent";
  let includeArchived = false;
  let editing: string | null = null;
  let confirmDelete: string | null = null;
  let busy = false;
  let notice: Notice | null = null;
  let deepHits: SessionSearchHit[] = [];
  const firstUser = new Map<string, string>();
  /** Sessions whose derived title has already been persisted to Core. */
  const persistedTitles = new Set<string>();

  const sortButtons = new Map<SessionSort, HTMLButtonElement>();
  for (const s of SESSION_SORTS) {
    const btn = h("button", { type: "button", text: s.label });
    btn.addEventListener("click", () => {
      sort = s.key;
      render();
    });
    sortButtons.set(s.key, btn);
    seg.append(btn);
  }

  function setNotice(kind: Notice["kind"], text: string): void {
    notice = { kind, text };
    render();
  }

  // ── loading ───────────────────────────────────────────────────────────────
  async function load(): Promise<void> {
    const res = await ctx.client.sessions({ includeArchived: true, limit: 200 });
    if (res.ok) {
      rows = res.value.sessions;
      activeId = res.value.activeSessionId;
      notice = null;
    } else {
      notice = { kind: "error", text: res.error.reason ?? res.error.message };
    }
    render();
    void preloadTitles();
  }

  /**
   * Load the FIRST user turn for generic-titled sessions so their derived
   * titles are real, bounded and never guessed. A title a person chose is
   * untouched, so those rows are skipped.
   */
  async function preloadTitles(): Promise<void> {
    const need = rows
      .filter((s) => isGenericSessionTitle(s.title) && !firstUser.has(s.id))
      .slice(0, 20);
    if (need.length === 0) return;
    let changed = false;
    for (const s of need) {
      const res = await ctx.client.sessionTurns(s.id, { limit: 10 });
      if (!res.ok) continue;
      const first = res.value.find((t) => t.role === "user");
      if (first === undefined) continue;
      firstUser.set(s.id, first.text);
      changed = true;
      // PERSIST the derived title to Core, once, so it survives a restart —
      // a derived title becomes a real one, not a display-only guess.
      if (!persistedTitles.has(s.id)) {
        persistedTitles.add(s.id);
        const derived = deriveSessionTitle(first.text);
        if (derived !== null && !isGenericSessionTitle(derived)) {
          const renamed = await ctx.client.renameSession(s.id, derived);
          if (renamed.ok) {
            const row = rows.find((r) => r.id === s.id);
            if (row !== undefined) row.title = derived;
          }
        }
      }
    }
    if (changed) render();
  }

  function toRow(s: CoreSessionSummary): CoreSessionRow {
    const updated = s.lastTurnAt ?? s.updatedAt;
    // The digest excerpt: Core's persisted objective, truncated. Sessions with
    // no turns yet have no digest and show no excerpt — never a guess.
    const objective = s.summary?.objective.trim() ?? "";
    const excerpt = objective.length > 0 ? (objective.length <= 120 ? objective : `${objective.slice(0, 117).trimEnd()}…`) : undefined;
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      active: s.id === activeId,
      ...(updated !== undefined ? { updatedAt: updated } : {}),
      ...(s.turnCount !== undefined ? { turnCount: s.turnCount } : {}),
      ...(s.agentId !== undefined ? { agentId: s.agentId } : {}),
      ...(s.agentSessionId !== undefined ? { agentSessionId: s.agentSessionId } : {}),
      ...(excerpt !== undefined ? { summaryExcerpt: excerpt } : {}),
    };
  }

  // ── mutations ─────────────────────────────────────────────────────────────
  async function create(): Promise<void> {
    const res = await ctx.client.createSession({});
    if (!res.ok) {
      setNotice("error", res.error.reason ?? res.error.message);
      return;
    }
    const activated = await ctx.client.activateSession(res.value.id);
    if (!activated.ok) {
      setNotice("error", activated.error.reason ?? activated.error.message);
      return;
    }
    setNotice("ok", "Started a new conversation.");
    await load();
  }

  async function open(id: string): Promise<void> {
    if (id !== activeId) {
      const res = await ctx.client.activateSession(id);
      if (!res.ok) {
        setNotice("error", res.error.reason ?? res.error.message);
        return;
      }
      activeId = id;
    }
    ctx.navigate("chat");
  }

  async function rename(id: string, title: string): Promise<void> {
    const clean = title.trim();
    editing = null;
    if (clean.length === 0) {
      render();
      return;
    }
    const res = await ctx.client.renameSession(id, clean);
    if (!res.ok) {
      setNotice("error", res.error.reason ?? res.error.message);
      return;
    }
    setNotice("ok", `Renamed to “${clean}”.`);
    await load();
  }

  /**
   * Duplicate — a durable WRITE fork on Core (`POST /sessions/:id/duplicate`).
   * The copy gets its OWN worker conversation. May PARK for approval; a park is
   * shown as a park, never faked into a copy.
   */
  async function duplicate(id: string, title: string): Promise<void> {
    busy = true;
    render();
    const res = await routes.duplicate(id, { title: `${title} (copy)` });
    busy = false;
    if (!res.ok) {
      setNotice("error", res.error.reason ?? res.error.message);
      return;
    }
    if (res.value.kind === "parked") {
      const ref = res.value.approvalId !== undefined ? ` (approval ${res.value.approvalId})` : "";
      setNotice("warn", `Duplicate is waiting for your approval${ref} — nothing was copied.`);
      return;
    }
    const newId = res.value.session.id;
    if (newId !== undefined) {
      const act = await ctx.client.activateSession(newId);
      if (act.ok) activeId = newId;
    }
    setNotice("ok", "Duplicated into a new conversation.");
    await load();
  }

  async function archive(id: string, restore: boolean): Promise<void> {
    const res = restore ? await ctx.client.unarchiveSession(id) : await ctx.client.archiveSession(id);
    if (!res.ok) {
      setNotice("error", res.error.reason ?? res.error.message);
      return;
    }
    setNotice("ok", restore ? "Session restored." : "Session archived.");
    await load();
  }

  /**
   * Delete — DESTRUCTIVE and policy-governed. With no approval it may PARK
   * (`409 { approvalRequired, approvalId }`), which is shown as a park, never
   * faked into a success.
   */
  async function remove(id: string): Promise<void> {
    busy = true;
    render();
    const res = await routes.remove(id);
    busy = false;
    confirmDelete = null;
    if (!res.ok) {
      setNotice("error", res.error.reason ?? res.error.message);
      return;
    }
    if (res.value.kind === "parked") {
      const ref = res.value.approvalId !== undefined ? ` (approval ${res.value.approvalId})` : "";
      setNotice("warn", `Delete is waiting for your approval${ref} — nothing was removed.`);
      return;
    }
    setNotice("ok", "Session deleted.");
    await load();
  }

  // ── governed search over turn text ────────────────────────────────────────
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleDeepSearch(q: string): void {
    if (searchTimer !== null) clearTimeout(searchTimer);
    if (q.trim().length < 2) {
      deepHits = [];
      render();
      return;
    }
    searchTimer = setTimeout(() => {
      void routes.search(q, 20).then((res) => {
        deepHits = res.ok ? res.value : [];
        render();
      });
    }, 300);
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function metaLine(view: { updatedAt?: string; agentId?: string; status: string; turnCount?: number }): HTMLElement {
    const parts: string[] = [];
    const when = relative(view.updatedAt);
    if (when.length > 0) parts.push(when);
    if (view.turnCount !== undefined) parts.push(`${view.turnCount} turn(s)`);
    if (view.agentId !== undefined) parts.push(`worker ${view.agentId}`);
    parts.push(view.status);
    return h("span", { class: "kai-session-meta", text: parts.join(" · ") });
  }

  function rowFor(view: ReturnType<typeof buildSessionViews>[number]): HTMLElement {
    const row = h("div", {
      class: `kai-session${view.active ? " is-active" : ""}${view.archived ? " is-archived" : ""}`,
    });
    const colour = view.active ? "#34d399" : view.archived ? "#6b7280" : "#8b93a1";
    row.append(dot(colour, 8));

    const main = h("div", { class: "kai-session-main" });

    if (editing === view.id) {
      const field = h("input", { class: "kai-session-input", type: "text", value: view.title });
      const commit = (): void => void rename(view.id, field.value);
      field.addEventListener("keydown", (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === "Enter") {
          ke.preventDefault();
          commit();
        } else if (ke.key === "Escape") {
          editing = null;
          render();
        }
        ke.stopPropagation();
      });
      main.append(field, h("span", { class: "kai-session-meta", text: "Enter to save · Esc to cancel" }));
      const actions = h(
        "div",
        { class: "kai-session-actions" },
        h("button", { class: "kai-btn", type: "button", text: "Save", onclick: commit }),
        h("button", {
          class: "kai-btn",
          type: "button",
          text: "Cancel",
          onclick: () => {
            editing = null;
            render();
          },
        }),
      );
      row.append(main, actions);
      return row;
    }

    const name = h("span", { class: `kai-session-name${view.derived ? " is-derived" : ""}`, text: view.title });
    main.append(name);
    if (view.excerpt !== undefined) {
      main.append(h("span", { class: "kai-session-excerpt", text: view.excerpt }));
    }
    main.append(metaLine(view));
    row.append(main);

    const actions = h("div", { class: "kai-session-actions" });
    if (!view.archived) {
      actions.append(
        h("button", { class: "kai-btn", type: "button", text: view.active ? "Open" : "Switch", onclick: () => void open(view.id) }),
        h("button", { class: "kai-btn", type: "button", text: "Rename", onclick: () => {
          editing = view.id;
          render();
        } }),
        h("button", { class: "kai-btn", type: "button", text: "Duplicate", onclick: () => void duplicate(view.id, view.title) }),
        h("button", { class: "kai-btn", type: "button", text: "Archive", onclick: () => void archive(view.id, false) }),
        h("button", {
          class: `kai-btn${confirmDelete === view.id ? " is-danger" : ""}`,
          type: "button",
          text: confirmDelete === view.id ? "Confirm delete" : "Delete",
          onclick: () => {
            if (confirmDelete === view.id) {
              void remove(view.id);
            } else {
              confirmDelete = view.id;
              render();
            }
          },
        }),
      );
    } else {
      actions.append(
        h("button", { class: "kai-btn", type: "button", text: "Restore", onclick: () => void archive(view.id, true) }),
        h("button", {
          class: `kai-btn${confirmDelete === view.id ? " is-danger" : ""}`,
          type: "button",
          text: confirmDelete === view.id ? "Confirm delete" : "Delete",
          onclick: () => {
            if (confirmDelete === view.id) {
              void remove(view.id);
            } else {
              confirmDelete = view.id;
              render();
            }
          },
        }),
      );
    }
    row.append(actions);
    return row;
  }

  function render(): void {
    for (const [key, btn] of sortButtons) btn.classList.toggle("on", key === sort);
    archiveToggle.checked = includeArchived;
    if (search.value !== query) search.value = query;

    const views = buildSessionViews(rows.map(toRow), {
      query,
      sort,
      includeArchived,
      firstUserText: (id) => firstUser.get(id),
    });

    clear(list);
    if (views.length === 0) {
      list.append(
        h("div", {
          class: "kai-empty",
          text:
            rows.length === 0
              ? "No sessions yet — press New session to start one."
              : "No sessions match your search.",
        }),
      );
    } else {
      for (const v of views) list.append(rowFor(v));
    }

    // Deep (server) hits over turn text, when the local filter found the query
    // useful and the search route returned matches beyond the visible rows.
    if (deepHits.length > 0) {
      const seen = new Set(views.map((v) => v.id));
      const extra = deepHits.filter((hit) => !seen.has(hit.id));
      if (extra.length > 0) {
        list.append(
          h(
            "div",
            { class: "kai-sessions-section" },
            h("div", { class: "kai-session-meta", text: `matched in turn text (${extra.length})` }),
            ...extra.map((hit) =>
              h(
                "div",
                { class: "kai-session" },
                dot("#22d3ee", 8),
                h("div", { class: "kai-session-main" },
                  h("span", { class: "kai-session-name", text: hit.title || hit.id }),
                  h("span", { class: "kai-session-meta", text: `matched in ${hit.match} · ${hit.status}` }),
                ),
                h("div", { class: "kai-session-actions" },
                  h("button", { class: "kai-btn", type: "button", text: "Open", onclick: () => void open(hit.id) }),
                ),
              ),
            ),
          ),
        );
      }
    }

    summary.textContent = summariseSessions(views, rows.length);
    note.textContent = notice !== null ? notice.text : busy ? "Working…" : "";
    note.classList.toggle("is-error", notice?.kind === "error");
    note.style.color = notice?.kind === "warn" ? "#f5a524" : notice?.kind === "ok" ? "#34d399" : "";
  }

  search.addEventListener("input", () => {
    query = search.value;
    confirmDelete = null;
    render();
    scheduleDeepSearch(query);
  });
  archiveToggle.addEventListener("change", () => {
    includeArchived = archiveToggle.checked;
    render();
  });
  newBtn.addEventListener("click", () => void create());

  void load();

  return {
    el,
    sync(): void {
      void load();
    },
    destroy(): void {
      if (searchTimer !== null) clearTimeout(searchTimer);
    },
  };
};

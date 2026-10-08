/**
 * agents/agents-page.ts — the Agents surface: list ⇄ detail ⇄ create/edit.
 *
 * The list is Core's real persona list (`GET /subagents`), each row leading with
 * the persona and demoting its worker. Selecting a row opens the full page;
 * "New agent" opens the creation flow; editing reopens the same flow. The whole
 * surface is one DOM tree the shell mounts.
 */

import { el, clear, button, chip, dot, spacer, muted } from "./ui";
import { renderAgentPage, type AgentPageHandle } from "./page";
import { renderAgentForm } from "./create";
import type { AgentsStore } from "./store";
import type { Subagent } from "./api";

export interface AgentsSurfaceHandle {
  el: HTMLElement;
  /** Called by the shell when the surface becomes visible. */
  sync(): void;
  /** Open the real create-agent flow (used by a global command/palette). */
  openCreate(): void;
  destroy(): void;
}

type Mode = { kind: "list" } | { kind: "detail" } | { kind: "create" } | { kind: "edit"; agent: Subagent };

export function renderAgentsSurface(store: AgentsStore): AgentsSurfaceHandle {
  const root = el("section", {
    class: "kai-page kai-agents",
    style: "display:flex;flex-direction:column;gap:16px;height:100%;min-height:0",
  });

  const title = el("h1", {
    text: "Agents",
    style: "margin:0;font:600 22px var(--font,system-ui);color:var(--ink,#f5f6f8)",
  });
  const lede = el("p", {
    text: "KAI's own personas — each with its own soul, worker, capabilities and memory. They act only through KAI's policy and approvals.",
    style: "margin:0;font:400 12.5px var(--font,system-ui);color:#8b93a1;max-width:760px",
  });
  const connLine = el("div", { style: "font:400 11px var(--font,system-ui);color:#8b93a1;min-height:14px" });

  const head = el(
    "div",
    { style: "display:flex;align-items:flex-start;gap:12px" },
    el("div", { style: "display:flex;flex-direction:column;gap:4px;min-width:0" }, title, lede),
    spacer(),
    button("New agent", "primary", () => showCreate()),
  );

  const bodyHost = el("div", { style: "flex:1 1 auto;min-height:0;overflow:hidden" });

  let mode: Mode = { kind: "list" };
  let detailHandle: AgentPageHandle | null = null;
  let formDestroy: (() => void) | null = null;

  function teardown(): void {
    if (detailHandle !== null) {
      detailHandle.destroy();
      detailHandle = null;
    }
    if (formDestroy !== null) {
      formDestroy();
      formDestroy = null;
    }
  }

  function showList(): void {
    teardown();
    mode = { kind: "list" };
    void store.select(null);
    render();
  }

  function showDetail(id: string): void {
    teardown();
    mode = { kind: "detail" };
    void store.select(id);
    render();
  }

  function showCreate(): void {
    teardown();
    mode = { kind: "create" };
    render();
  }

  function showEdit(agent: Subagent): void {
    teardown();
    mode = { kind: "edit", agent };
    render();
  }

  // ── list ─────────────────────────────────────────────────────────────────────
  function renderList(s: ReturnType<AgentsStore["getState"]>): HTMLElement {
    const list = el("div", {
      style: "display:flex;flex-direction:column;gap:8px;max-width:900px",
    });
    if (s.agents.length === 0) {
      list.append(
        muted(s.conn === "OFFLINE" ? "KAI Core is not connected — the list will appear when it is." : "No agents defined yet. Create one."),
      );
      return list;
    }
    for (const a of s.agents) {
      const archived = !a.enabled;
      const row = el("div", {
        style:
          "display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;cursor:pointer;" +
          "background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);" +
          (archived ? "opacity:0.62;" : ""),
      });
      const declared = (a.visual?.declared ?? {}) as Record<string, unknown>;
      const colour = typeof declared.colour === "string" ? declared.colour : "#8B93A1";
      row.append(
        dot(colour, 12),
        el("div", { style: "display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto" },
          el("span", { text: a.name, style: "font:600 14px var(--font,system-ui);color:var(--ink,#f5f6f8)" }),
          el("span", {
            text: a.soul.length > 0 ? a.soul : a.role,
            style: "font:400 11.5px var(--font,system-ui);color:#8b93a1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:640px",
          }),
        ),
        muted(`runs on ${a.workerId}`),
        chip(
          archived ? "ARCHIVED" : a.activity === "awaiting approval" ? "AWAITING APPROVAL" : a.status,
          archived ? "#8b93a1" : a.activity === "awaiting approval" ? "#f5a524" : "#34d399",
        ),
        el("span", { text: "›", style: "color:#6b7280;font:600 16px var(--font,system-ui)" }),
      );
      row.addEventListener("click", () => showDetail(a.id));
      list.append(row);
    }
    return list;
  }

  function render(): void {
    const s = store.getState();
    connLine.textContent =
      s.loadError !== null
        ? s.loadError
        : `${s.conn.toLowerCase()} · ${s.agents.length} agent(s) · workers: ${s.workers.map((w) => w.id).join(", ") || "none"}`;
    connLine.style.color = s.conn === "OFFLINE" ? "#f4505e" : "#8b93a1";

    head.style.display = mode.kind === "list" ? "flex" : "none";
    if (mode.kind === "list") {
      clear(bodyHost);
      bodyHost.append(connLine, renderList(s));
      return;
    }
    if (mode.kind === "create" || mode.kind === "edit") {
      // Rebuild the form ONCE per entry (a subscribe-driven rebuild would reset inputs).
      if (bodyHost.dataset.formMode !== `${mode.kind}:${mode.kind === "edit" ? mode.agent.id : ""}`) {
        teardown();
        clear(bodyHost);
        bodyHost.dataset.formMode = `${mode.kind}:${mode.kind === "edit" ? mode.agent.id : ""}`;
        const form = renderAgentForm(store, {
          mode: mode.kind,
          ...(mode.kind === "edit" ? { agent: mode.agent } : {}),
          onDone: () => {
            bodyHost.dataset.formMode = "";
            const id = mode.kind === "edit" ? mode.agent.id : store.getState().agents[store.getState().agents.length - 1]?.id;
            if (id !== undefined) showDetail(id);
            else showList();
          },
          onCancel: () => {
            bodyHost.dataset.formMode = "";
            showList();
          },
        });
        formDestroy = form.destroy;
        bodyHost.append(form.el);
      }
      return;
    }
    // detail
    bodyHost.dataset.formMode = "";
    if (detailHandle === null) {
      clear(bodyHost);
      detailHandle = renderAgentPage(store, {
        onBack: () => showList(),
        onEdit: (agent) => showEdit(agent),
      });
      bodyHost.append(detailHandle.el);
    }
    // While a detail page is mounted its own store subscription keeps it live.
  }

  const unsubscribe = store.subscribe(render);
  void store.load().then(() => render());
  root.append(head, bodyHost);
  render();

  return {
    el: root,
    sync: () => {
      void store.load().then(() => render());
      render();
    },
    openCreate: () => showCreate(),
    destroy: () => {
      teardown();
      unsubscribe();
    },
  };
}

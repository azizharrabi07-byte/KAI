// The KAI workspace — the mount and its product wiring.
//
// This is the workspace's last mile. It owns the one `#kai-workspace` host, the
// panel that renders the workspace slice, and the `window.__kaiWorkspace`
// handle the live verification harness reaches. It follows the precedent of
// `src/visual/mount.ts`: the module above is the mechanism, this file puts it on
// screen.
//
// It wires every button to a REAL Core route through the workspace routes, and
// it wires approvals to the SAME decider the island's approval card uses
// (`island/core-bridge.ts`'s `decideCoreApproval`) — so the workspace and the
// island share one approval path, not two.
//
// The visual host, when supplied, is the same `VisualHost` the island mounts;
// `presentMessage` runs a normal KAI message through it, so a message carrying a
// diagram is compiled by Core and drawn by the engine.

import type { Workspace } from "./workspace";
import { presentKaiMessage, type VisualCompileHost } from "./visual";
import type { WorkspaceNotice, WorkspaceTab } from "../views/workspace-panels";
import {
  mountPanel,
  renderTabStrip,
  renderWorkspaceFooter,
  renderWorkspacePanel,
} from "../views/workspace-panels";
import { State } from "../core/state";
import { decideCoreApproval } from "../island/core-bridge";

export interface WorkspaceMountOptions {
  /** The workspace (routes + stream + slice). Required. */
  workspace: Workspace;
  /** The visual host, so replies carrying a diagram are drawn. Optional. */
  visual?: VisualCompileHost | null;
}

export interface WorkspaceHandle {
  /** The host element (`#kai-workspace`). */
  readonly el: HTMLElement;
  /** The tab currently on screen. */
  readonly tab: WorkspaceTab;
  show(tab?: WorkspaceTab): void;
  hide(): void;
  toggle(): void;
  /** Run a normal KAI message through the visual engine. Returns the prose. */
  presentMessage(text: string): Promise<string>;
  /** Stop reconciling and streaming. */
  stop(): void;
}

export function mountWorkspace(root: HTMLElement, options: WorkspaceMountOptions): WorkspaceHandle {
  const { workspace, visual = null } = options;

  const el = document.createElement("section");
  el.id = "kai-workspace";
  el.className = "kai-workspace";
  el.hidden = true;
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "KAI workspace");
  root.appendChild(el);

  // ── chrome ─────────────────────────────────────────────────────────────────
  const head = document.createElement("div");
  head.className = "kai-workspace-head";
  head.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:8px";

  const title = document.createElement("span");
  title.style.cssText = "font:600 13px var(--font);color:var(--ink)";
  title.textContent = "KAI workspace";

  const status = document.createElement("span");
  status.className = "kai-workspace-status";
  status.style.cssText = "font:400 10.5px var(--font);color:#9398a1";

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "link-btn";
  refreshBtn.style.cssText = "color:#3B9EFF;flex:0 0 auto";
  refreshBtn.textContent = "Refresh";

  const hideBtn = document.createElement("button");
  hideBtn.className = "link-btn";
  hideBtn.style.cssText = "color:#9398a1;flex:0 0 auto";
  hideBtn.textContent = "Close";

  head.append(title, status, spacer(), refreshBtn, hideBtn);

  const tabHost = document.createElement("div");
  const panelHost = document.createElement("div");
  panelHost.className = "kai-workspace-panel";
  panelHost.style.cssText = "flex:1 1 auto;min-height:0;display:flex";

  const noticeHost = document.createElement("div");
  noticeHost.className = "kai-workspace-notice";
  noticeHost.style.cssText = "font:400 10.5px var(--font);margin-top:6px;min-height:12px";

  el.append(head, tabHost, panelHost, noticeHost);

  // ── state ──────────────────────────────────────────────────────────────────
  let tab: WorkspaceTab = "tools";
  let notice: WorkspaceNotice | null = null;
  let tabKey = "";
  let busy = false;

  function setNotice(kind: WorkspaceNotice["kind"], text: string): void {
    notice = { kind, text };
    noticeHost.textContent = text;
    noticeHost.style.color = kind === "ok" ? "#34D399" : kind === "warn" ? "#F5A524" : "#F4505E";
  }

  /** Every action funnels through here so the panel always re-reads Core after. */
  async function guarded<T>(fn: () => Promise<T>, onOk: (value: T) => string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const value = await fn();
      setNotice("ok", onOk(value));
    } catch (err) {
      setNotice("error", err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      await workspace.refresh();
      render();
    }
  }

  const actions = {
    setTab: (next: WorkspaceTab) => {
      tab = next;
      render();
    },
    refresh: () => {
      void workspace.refresh().then(() => render());
    },
    invokeTool: (id: string) => {
      void guarded(
        () => workspace.routes.invokeTool(id, {}),
        (res) => {
          if (!res.ok) return `Core refused: ${res.error.reason ?? res.error.message}`;
          return res.value.approvalRequired
            ? `KAI parked ${id} for your approval — answer it in Approvals`
            : `KAI ran ${id} (${res.value.status})`;
        },
      );
    },
    mcpCommand: (name: string, command: Parameters<typeof workspace.routes.mcpServerCommand>[1]) => {
      void guarded(
        () => workspace.routes.mcpServerCommand(name, command),
        (res) => {
          if (!res.ok) return `Core refused: ${res.error.reason ?? res.error.message}`;
          return res.value.approvalRequired
            ? `KAI parked mcp.${command} ${name} for your approval`
            : `KAI ran mcp.${command} on ${name}`;
        },
      );
    },
    mcpCall: (name: string, tool: string) => {
      void guarded(
        () => workspace.routes.mcpCall(name, { tool, source: "ui" }),
        (res) => {
          if (!res.ok) return `Core refused: ${res.error.reason ?? res.error.message}`;
          return res.value.approvalRequired
            ? `KAI parked ${name}/${tool} for your approval`
            : `KAI called ${name}/${tool} (${res.value.status})`;
        },
      );
    },
    runMaintenance: () => {
      void guarded(
        () => workspace.routes.runMaintenance(),
        (res) => {
          if (!res.ok) return `Core refused: ${res.error.reason ?? res.error.message}`;
          return res.value.ok ? "KAI's self-check passed" : "KAI's self-check found problems";
        },
      );
    },
    composePrompt: (request: string) => {
      void guarded(
        () => workspace.routes.composePrompt(request),
        (res) => (res.ok ? `KAI composed a ${res.value.totalChars}-char prompt` : "KAI could not compose the prompt"),
      );
    },
    decideApproval: (id: string, decision: "allow" | "deny") => {
      // SHARED with the island: the same decider the approval card uses.
      const handled = decideCoreApproval(id, decision);
      setNotice(handled ? "ok" : "warn", handled ? `KAI recorded your ${decision}` : "That approval is not KAI Core's");
      void workspace.refresh().then(() => render());
    },
  };

  // ── render ──────────────────────────────────────────────────────────────────
  function render(): void {
    const slice = workspace.getState();
    const core = State.core;

    const connDot = slice.conn === "ONLINE" ? "🟢" : slice.conn === "DEGRADED" ? "🟡" : "⚪";
    status.textContent = `${connDot} ${slice.conn.toLowerCase()} · ${slice.tools.length} tools · mcp ${slice.mcp?.counts.connected ?? 0}/${slice.mcp?.counts.servers ?? 0}`;

    const strip = renderTabStrip(tab, slice, core, actions);
    if (strip.key !== tabKey) {
      tabKey = strip.key;
      tabHost.replaceChildren(strip.el);
    }
    mountPanel(panelHost, renderWorkspacePanel(tab, slice, core, actions, notice));
    const footer = renderWorkspaceFooter(slice);
    const existing = el.querySelector(".kai-workspace-footer");
    if (existing) existing.replaceWith(footer);
    else el.append(footer);
  }

  const unsubscribeWorkspace = workspace.subscribe(() => render());
  const unsubscribeState = State.subscribe(() => render());

  refreshBtn.addEventListener("click", () => actions.refresh());
  hideBtn.addEventListener("click", () => hide());

  // Keyboard: Escape closes the workspace, so it behaves like the island.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && !el.hidden) hide();
  };
  window.addEventListener("keydown", onKey);

  function show(next?: WorkspaceTab): void {
    if (next !== undefined) tab = next;
    el.hidden = false;
    render();
  }

  function hide(): void {
    el.hidden = true;
  }

  async function presentMessage(text: string): Promise<string> {
    const presented = await presentKaiMessage(visual, text);
    // A refusal is surfaced, never swallowed: the caller sees Core's own reason.
    for (const outcome of presented.outcomes) {
      if (!outcome.ok) {
        setNotice("warn", `KAI could not draw a diagram: ${outcome.reason ?? outcome.code ?? "refused"}`);
      }
    }
    return presented.text;
  }

  render();

  const handle: WorkspaceHandle = {
    el,
    get tab() {
      return tab;
    },
    show,
    hide,
    toggle: () => (el.hidden ? show() : hide()),
    presentMessage,
    stop() {
      unsubscribeWorkspace();
      unsubscribeState();
      window.removeEventListener("keydown", onKey);
      workspace.stop();
    },
  };

  // The live verification harness reaches the REAL handle, never a stub.
  (window as unknown as { __kaiWorkspace?: WorkspaceHandle }).__kaiWorkspace = handle;

  return handle;
}

/** A flexible spacer, so the chrome's left group and buttons separate. */
function spacer(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "flex:1 1 auto";
  return el;
}

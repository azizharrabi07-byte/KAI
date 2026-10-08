// The KAI workspace panels — the render layer over the workspace slice.
//
// A panel is a pure function of state: it reads the workspace slice
// (`../workspace/store.ts`) and the island's Core slice (for approvals, which
// are SHARED with the island — the same `State.core.approvals` the approval card
// reads) and returns DOM. No panel calls `fetch`; every action is a callback the
// mount wires to the workspace routes. That keeps the "one transport, one place"
// rule the rest of the app follows.
//
// Nothing here is a placeholder: the tools panel lists the REAL registry, the
// MCP panel reports the MEASURED capability and the REAL catalogue, the
// diagnostics panel is KAI's own `/maintenance/status`, and the approvals panel
// renders the SAME pending approvals the island's card does.

import { h, clear, dot } from "./dom";
import { toolDispatchHint, actionLine, type WorkspaceSlice } from "../workspace/store";
import type { CoreSlice, CoreApprovalRow } from "../core/core-state";
import type {
  MaintenanceReport,
  McpSummary,
  ToolDescription,
} from "../workspace/types";
import type { McpServerCommand } from "../workspace/routes";

export type WorkspaceTab = "tools" | "mcp" | "diagnostics" | "approvals" | "activity";

export const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "tools", label: "Tools" },
  { id: "mcp", label: "MCP" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "approvals", label: "Approvals" },
  { id: "activity", label: "Activity" },
];

/** What a panel's buttons call back into. Routed by the mount, never a panel. */
export interface WorkspacePanelActions {
  setTab(tab: WorkspaceTab): void;
  refresh(): void;
  /** Run one tool through `/tools/:id/invoke`. A park is the normal outcome. */
  invokeTool(id: string): void;
  /** A parked MCP management action (`enable`, `connect`, …). */
  mcpCommand(name: string, command: McpServerCommand): void;
  /** Invoke a discovered MCP tool (`/mcp/servers/:name/call`). */
  mcpCall(name: string, tool: string): void;
  /** Run KAI's self-maintenance (`/maintenance/run`). */
  runMaintenance(): void;
  /** Compose the exact prompt a turn would send (`/prompts/compose`). */
  composePrompt(request: string): void;
  /** Decide a Core approval — routed through the ISLAND's shared decider. */
  decideApproval(id: string, decision: "allow" | "deny"): void;
}

/** A short note about the last action, shown under the tab strip. */
export interface WorkspaceNotice {
  kind: "ok" | "warn" | "error";
  text: string;
}

// ── Small shared pieces ─────────────────────────────────────────────────────

const RISK_COLOR: Record<string, string> = {
  READ: "#34D399",
  WRITE: "#F5A524",
  EXTERNAL: "#3B9EFF",
  DESTRUCTIVE: "#F4505E",
};

function chip(text: string, color: string): HTMLElement {
  return h("span", {
    style:
      `flex:0 0 auto;font:600 10px var(--font);color:${color};` +
      `border:1px solid ${color}55;background:${color}1f;border-radius:999px;padding:1px 7px`,
    text,
  });
}

function muted(text: string): HTMLElement {
  return h("span", { style: "font:400 10.5px var(--font);color:#6b7280", text });
}

function lineBtn(label: string, onClick: () => void, color = "#c5c8cd"): HTMLElement {
  return h("button", {
    class: "link-btn",
    style: `color:${color};flex:0 0 auto`,
    text: label,
    onclick: onClick,
  });
}

function row(...children: (Node | string | null)[]): HTMLElement {
  return h("div", { class: "row", style: "gap:7px;min-width:0;align-items:center" }, ...children);
}

function sectionTitle(text: string, trailing?: string): HTMLElement {
  return h(
    "div",
    { class: "row", style: "justify-content:space-between;margin:2px 0 2px" },
    h("span", { class: "title", style: "font-size:12.5px", text }),
    trailing !== undefined ? muted(trailing) : h("div", { class: "grow" }),
  );
}

function emptyLine(text: string): HTMLElement {
  return h("div", { class: "sub", style: "font-size:11px", text });
}

// ── Tools ───────────────────────────────────────────────────────────────────

function renderTools(slice: WorkspaceSlice, actions: WorkspacePanelActions): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:5px;min-height:0;overflow:auto" });
  const tools = slice.tools;
  body.append(
    sectionTitle(
      "Registered tools",
      tools.length === 0 ? "none" : `${tools.length} · ${tools.filter((t) => t.permission.sideEffecting).length} side-effecting`,
    ),
  );
  if (tools.length === 0) {
    body.append(emptyLine(slice.conn === "OFFLINE" ? "KAI Core is not connected" : "No tools are registered."));
    return body;
  }
  for (const tool of tools.slice(0, 12)) body.append(toolRow(tool, actions));
  if (tools.length > 12) body.append(muted(`+${tools.length - 12} more`));
  return body;
}

function toolRow(tool: ToolDescription, actions: WorkspacePanelActions): HTMLElement {
  const risk = tool.permission.risk;
  const color = RISK_COLOR[risk] ?? "#8b93a1";
  const schemaNote = tool.schema.declared ? "schema declared" : "no schema (procedural validator)";
  return h(
    "div",
    { style: "display:flex;flex-direction:column;gap:2px;padding:4px 0;border-top:1px solid rgba(255,255,255,0.05)" },
    row(
      dot(color, 7),
      h("span", { style: "font:600 11.5px var(--font);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis", text: tool.name }),
      h("span", { style: "font:400 10px var(--mono,monospace);color:#7b8290;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", text: tool.id }),
      h("div", { class: "grow" }),
      chip(risk, color),
      tool.permission.effectful ? chip("effectful", "#F5A524") : null,
    ),
    h("div", { style: "font:400 10.5px var(--font);color:var(--dim-2,#9398a1)", text: tool.description }),
    row(
      muted(toolDispatchHint(tool)),
      h("div", { class: "grow" }),
      lineBtn(
        tool.permission.sideEffecting ? "Request approval" : "Run",
        () => actions.invokeTool(tool.id),
        tool.permission.sideEffecting ? "#F5A524" : "#34D399",
      ),
      muted(schemaNote),
    ),
  );
}

// ── MCP ─────────────────────────────────────────────────────────────────────

function renderMcp(slice: WorkspaceSlice, actions: WorkspacePanelActions): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:5px;min-height:0;overflow:auto" });
  const mcp: McpSummary | null = slice.mcp;
  if (mcp === null) {
    body.append(sectionTitle("MCP"));
    body.append(emptyLine(slice.conn === "OFFLINE" ? "KAI Core is not connected" : "No MCP capability reported."));
    return body;
  }

  const availColor =
    mcp.capability.availability === "AVAILABLE"
      ? "#34D399"
      : mcp.capability.availability === "DEGRADED"
        ? "#F5A524"
        : "#8b93a1";
  body.append(
    sectionTitle("MCP capability", `provenance ${mcp.provenanceCount}`),
    row(
      dot(availColor, 8),
      chip(mcp.capability.availability, availColor),
      muted(mcp.capability.detail),
    ),
    row(
      muted(`${mcp.counts.servers} server(s)`),
      muted(`· ${mcp.counts.enabled} enabled`),
      muted(`· ${mcp.counts.connected} connected`),
      muted(`· ${mcp.counts.tools} tool(s)`),
      muted(`· ${mcp.counts.resources} resource(s)`),
    ),
    sectionTitle("Servers", mcp.servers.length === 0 ? "none registered" : String(mcp.servers.length)),
  );
  if (mcp.servers.length === 0) {
    body.append(emptyLine("No MCP servers registered — register one via POST /mcp/servers."));
  } else {
    for (const server of mcp.servers) {
      const statusColor = server.connected ? "#34D399" : server.enabled ? "#F5A524" : "#6b7280";
      const status = server.connected ? "connected" : server.enabled ? "enabled" : "disabled";
      const target =
        server.transport === "stdio"
          ? `${server.command ?? ""} ${(server.args ?? []).join(" ")}`.trim()
          : (server.url ?? "");
      body.append(
        h(
          "div",
          { style: "display:flex;flex-direction:column;gap:2px;padding:4px 0;border-top:1px solid rgba(255,255,255,0.05)" },
          row(
            dot(statusColor, 7),
            h("span", { style: "font:600 11.5px var(--font);color:var(--ink)", text: server.name }),
            chip(server.transport, "#8b93a1"),
            chip(status, statusColor),
            server.hasRisk ? null : chip("no risk → tools refused", "#F4505E"),
            h("div", { class: "grow" }),
            muted(`${server.toolCount} tool(s)`),
          ),
          target.length > 0
            ? h("div", { style: "font:400 10px var(--mono,monospace);color:#7b8290;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", text: target })
            : null,
          row(
            lineBtn("Enable", () => actions.mcpCommand(server.name, "enable"), "#34D399"),
            lineBtn("Connect", () => actions.mcpCommand(server.name, "connect"), "#3B9EFF"),
            lineBtn("Refresh", () => actions.mcpCommand(server.name, "refresh")),
            lineBtn("Disable", () => actions.mcpCommand(server.name, "disable"), "#F5A524"),
            lineBtn("Remove", () => actions.mcpCommand(server.name, "remove"), "#F0A6A6"),
          ),
        ),
      );
    }
  }
  body.append(
    sectionTitle("Management tools"),
    muted(
      mcp.management.registered.length === 0
        ? "none registered"
        : mcp.management.registered.join(", "),
    ),
  );
  if (mcp.management.refused.length > 0) {
    body.append(
      h(
        "div",
        { style: "font:400 10.5px var(--font);color:#F0A6A6" },
        `refused: ${mcp.management.refused.map((r) => `${r.name} (${r.reason})`).join("; ")}`,
      ),
    );
  }
  if (mcp.persistence.problem !== null) {
    body.append(h("div", { style: "font:400 10.5px var(--font);color:#F5A524", text: `persistence: ${mcp.persistence.problem}` }));
  }
  return body;
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

const CHECK_COLOR: Record<string, string> = { pass: "#34D399", warn: "#F5A524", fail: "#F4505E" };

function renderDiagnostics(
  slice: WorkspaceSlice,
  actions: WorkspacePanelActions,
  notice: WorkspaceNotice | null,
): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:5px;min-height:0;overflow:auto" });
  const report: MaintenanceReport | null = slice.maintenance;
  body.append(sectionTitle("Self-diagnostics"));

  if (report === null) {
    body.append(emptyLine(slice.conn === "OFFLINE" ? "KAI Core is not connected" : "No maintenance report yet."));
    body.append(row(h("div", { class: "grow" }), lineBtn("Run self-check", () => actions.runMaintenance(), "#3B9EFF")));
    return body;
  }

  const id = report.identity;
  body.append(
    row(
      dot(id.current ? "#34D399" : "#F5A524", 8),
      chip(id.current ? "current build" : "STALE", id.current ? "#34D399" : "#F5A524"),
      muted(`build ${id.buildId.slice(0, 12)} · pid ${id.pid} · protocol ${id.protocolVersion}`),
    ),
    h(
      "div",
      { style: "font:400 10.5px var(--font);color:var(--dim-2,#9398a1)" },
      id.onDiskBuildId !== undefined
        ? `on disk: build ${id.onDiskBuildId.slice(0, 12)} — ${id.detail}`
        : id.detail,
    ),
    sectionTitle(report.ok ? "All checks passed" : "Checks", new Date(report.checkedAt).toLocaleTimeString()),
  );
  for (const check of report.checks) {
    const color = CHECK_COLOR[check.status] ?? "#8b93a1";
    body.append(
      row(
        dot(color, 6),
        h("span", { style: "font:500 11px var(--font);color:var(--ink);min-width:96px", text: check.name }),
        h("span", { style: "font:400 10.5px var(--font);color:var(--dim-2,#9398a1)", text: check.detail }),
      ),
    );
  }
  if (report.repairs.length > 0) {
    body.append(sectionTitle("Repairs"));
    for (const repair of report.repairs) {
      body.append(
        row(
          dot(repair.performed ? "#34D399" : "#F5A524", 6),
          h("span", { style: "font:500 11px var(--font);color:var(--ink);min-width:96px", text: repair.name }),
          muted(repair.detail),
        ),
      );
    }
  }
  body.append(
    row(
      h("div", { class: "grow" }),
      notice !== null ? muted(notice.text) : null,
      lineBtn("Run self-check + repairs", () => actions.runMaintenance(), "#3B9EFF"),
    ),
  );
  return body;
}

// ── Approvals (SHARED with the island) ──────────────────────────────────────

function renderApprovals(core: CoreSlice, actions: WorkspacePanelActions): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:5px;min-height:0;overflow:auto" });
  const pending: CoreApprovalRow[] = core.approvals.filter((a) => a.status === "PENDING");
  body.append(sectionTitle("Pending approvals", pending.length === 0 ? "none" : String(pending.length)));
  if (pending.length === 0) {
    body.append(emptyLine(core.conn === "OFFLINE" ? "KAI Core is not connected" : "Nothing is waiting for your decision."));
    return body;
  }
  for (const approval of pending.slice(0, 8)) {
    const riskColor = RISK_COLOR[approval.risk] ?? "#8b93a1";
    body.append(
      h(
        "div",
        { style: "display:flex;flex-direction:column;gap:3px;padding:4px 0;border-top:1px solid rgba(255,255,255,0.05)" },
        row(
          chip(approval.risk, riskColor),
          h("span", { style: "font:600 11.5px var(--font);color:var(--ink)", text: approval.toolId }),
          h("div", { class: "grow" }),
          muted(approval.action),
        ),
        h("div", { style: "font:400 10.5px var(--font);color:var(--dim-2,#9398a1)", text: approval.reason }),
        row(
          h("div", { class: "grow" }),
          lineBtn("Deny", () => actions.decideApproval(approval.id, "deny"), "#F0A6A6"),
          lineBtn("Allow", () => actions.decideApproval(approval.id, "allow"), "#34D399"),
        ),
      ),
    );
  }
  return body;
}

// ── Activity (KAI-subject) ──────────────────────────────────────────────────

function renderActivity(slice: WorkspaceSlice): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:4px;min-height:0;overflow:auto" });
  body.append(sectionTitle("What KAI has been doing", slice.events.length === 0 ? "nothing yet" : String(slice.events.length)));
  if (slice.events.length === 0) {
    body.append(emptyLine("No Core events yet."));
    return body;
  }
  for (const event of slice.events.slice(0, 14)) {
    // The line is KAI's own sentence; the worker is DEMOTED to a trailing label.
    body.append(
      row(
        dot(event.type.startsWith("mission") ? "#3B9EFF" : event.type.startsWith("approval") ? "#F5A524" : "#8b93a1", 6),
        h("span", { style: "flex:1 1 auto;min-width:0;font:400 11px var(--font);color:var(--dim-2,#9398a1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis", text: event.line }),
        event.worker !== null ? muted(`· ${event.worker.id}`) : null,
        muted(new Date(event.at).toLocaleTimeString()),
      ),
    );
  }
  return body;
}

// ── Actions & log (KAI's own recorded actions) ──────────────────────────────

function renderActions(slice: WorkspaceSlice): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:3px;min-height:0;overflow:auto" });
  body.append(sectionTitle("Recorded actions", slice.actions.length === 0 ? "none" : String(slice.actions.length)));
  if (slice.actions.length === 0) {
    body.append(emptyLine("No action.executed records."));
    return body;
  }
  for (const action of slice.actions.slice(0, 8)) {
    body.append(muted(actionLine(action)));
  }
  return body;
}

// ── Composition ─────────────────────────────────────────────────────────────

export function renderWorkspacePanel(
  tab: WorkspaceTab,
  slice: WorkspaceSlice,
  core: CoreSlice,
  actions: WorkspacePanelActions,
  notice: WorkspaceNotice | null = null,
): HTMLElement {
  switch (tab) {
    case "tools":
      return renderTools(slice, actions);
    case "mcp":
      return renderMcp(slice, actions);
    case "diagnostics":
      return renderDiagnostics(slice, actions, notice);
    case "approvals":
      return renderApprovals(core, actions);
    case "activity":
      return renderActivity(slice);
  }
}

/** The tab strip, with live counts. Rebuilt only when the counts change. */
export function renderTabStrip(
  active: WorkspaceTab,
  slice: WorkspaceSlice,
  core: CoreSlice,
  actions: WorkspacePanelActions,
): { el: HTMLElement; key: string } {
  const pending = core.approvals.filter((a) => a.status === "PENDING").length;
  const counts: Record<WorkspaceTab, number | null> = {
    tools: slice.tools.length,
    mcp: slice.mcp?.counts.servers ?? null,
    diagnostics: slice.maintenance === null ? null : slice.maintenance.checks.filter((c) => c.status === "fail").length,
    approvals: pending,
    activity: slice.events.length,
  };
  const key = WORKSPACE_TABS.map((t) => `${t.id}:${counts[t.id] ?? ""}`).join("|") + `#${active}`;
  const el = h("div", { class: "kai-workspace-tabs", style: "display:flex;gap:6px;align-items:center" });
  for (const tab of WORKSPACE_TABS) {
    const on = tab.id === active;
    const count = counts[tab.id];
    el.append(
      h(
        "button",
        {
          class: on ? "link-btn on" : "link-btn",
          style: `color:${on ? "#f5f6f8" : "#9398a1"};font-weight:${on ? 600 : 400};flex:0 0 auto`,
          text: count !== null && count > 0 ? `${tab.label} ${count}` : tab.label,
          onclick: () => actions.setTab(tab.id),
        },
      ),
    );
  }
  return { el, key };
}

/** The actions/log footer, shared by every tab. */
export function renderWorkspaceFooter(slice: WorkspaceSlice): HTMLElement {
  return h("div", { class: "kai-workspace-footer", style: "display:flex;flex-direction:column;gap:3px;margin-top:auto" }, renderActions(slice));
}

/** Replace a container's children with `next`, so panels never leak nodes. */
export function mountPanel(container: HTMLElement, next: HTMLElement): void {
  clear(container);
  container.append(next);
}

// KAI — the MCP page (owner §D). A PRIMARY surface at real dimensions.
//
// WHAT IT SHOWS (all read from the ONE live Core route surface)
//   GET /mcp                     the measured capability + counts + catalogue
//   GET /mcp/servers             the catalogue (secret VALUES never present)
//   GET /mcp/servers/:name       one server + live state (fetched on selection)
//   GET /mcp/provenance          the invocation ledger (fetched on demand)
//   POST /mcp/servers/:name/:cmd a parked management action (enable/connect/…)
//
// ── THE HONEST STATUS RULE (never faked) ─────────────────────────────────────
// A server's status is derived ONLY from Core's declared facts — `connected`,
// `enabled`, and `transport`. A remote server (`http`/`sse`) that is enabled but
// not connected is BLOCKED, and the reason is Core's own: this build implements
// the stdio transport only. Discord (stdio) connected live shows CONNECTED with
// its real server info and tool count. Nothing here hard-codes "CONNECTED" or
// "BLOCKED" per server name. When a management action runs, the page shows
// Core's real response — including the park reason — verbatim.
//
// ── CREDENTIALS ──────────────────────────────────────────────────────────────
// Only credential KEY NAMES and, when Core reports them, their PRESENCE status
// are ever rendered. Values are never requested, stored, logged or displayed.
// The persistence catalogue and any value live in Core, never here.
//
// ── Attribution (MIT) ────────────────────────────────────────────────────────
// Portions adapted from OpenGhost (github.com/ANDRETRIPOL/OpenGhost), MIT License,
// Copyright (c) 2026 Andrew — the approval-card PRESENTATION and schema SHAPE
// vocabulary reused through `./tools` (see its header). See
// docs/OPEN_GHOST_REUSE_MANIFEST.md.

import { h, clear, dot } from "./dom";
import type { WorkspaceSlice } from "../workspace/store";
import type { McpServerSummary, McpProvenanceRecord, ToolInvokeOutcome } from "../workspace/types";
import type { McpServerCommand } from "../workspace/routes";
import type { CoreResult } from "../core/kai-core";
import type { PageContext } from "./tools";
import { OK, WARN, INFO, BAD, INK, DIM, DIM2, MONO, renderApprovalCard, safeJson, extractApprovalId } from "./tools";

// ── Pure layer: honest status derivation ─────────────────────────────────────

export type McpStatus = "CONNECTED" | "CONNECTING" | "BLOCKED" | "ENABLED" | "DISABLED";

export interface McpServerStatus {
  /** The word shown on the chip. */
  status: McpStatus;
  color: string;
  /** A short, honest reason — Core's own words where Core gave them. */
  reason: string;
  /** Whether a connect attempt can plausibly succeed (stdio only). */
  connectable: boolean;
}

/**
 * Derive a server's TRUE status from Core's declared facts only.
 *
 * The reason for BLOCKED is the build's own honest limitation, stated exactly as
 * Core's `connectServer` states it: a non-stdio endpoint cannot be connected by
 * this build. This is a DISPLAY of a declared fact, never a decision and never a
 * per-server hard-code.
 */
export function serverStatus(server: Pick<McpServerSummary, "connected" | "enabled" | "transport" | "hasRisk">): McpServerStatus {
  const remote = server.transport !== "stdio";
  if (server.connected) {
    return { status: "CONNECTED", color: OK, reason: "Live connection; its tools are registered in KAI's registry.", connectable: true };
  }
  if (!server.enabled) {
    return { status: "DISABLED", color: "#8b93a1", reason: "Disabled — a server is inert until a human enables it.", connectable: false };
  }
  if (remote) {
    return {
      status: "BLOCKED",
      color: BAD,
      reason: `This build implements the stdio transport only, so a ${server.transport} endpoint cannot be connected yet.`,
      connectable: false,
    };
  }
  if (!server.hasRisk) {
    return { status: "ENABLED", color: WARN, reason: "Enabled but not connected; it declares no KAI risk, so its tools would be refused.", connectable: true };
  }
  return { status: "ENABLED", color: WARN, reason: "Enabled but not connected — press Connect to launch it.", connectable: true };
}

/** The endpoint a server talks to, for display. Secret values are never part of it. */
export function serverTarget(server: McpServerSummary): string {
  if (server.transport === "stdio") {
    return `${server.command ?? ""} ${(server.args ?? []).join(" ")}`.trim();
  }
  return server.url ?? "";
}

/** Credential KEY NAMES only — never values. */
export function credentialKeys(server: McpServerSummary): string[] {
  if (server.transport === "stdio") return server.envKeys ?? [];
  return server.headerKeys ?? [];
}

// ── Raw enrichment: read ONLY credential key NAMES + presence status ─────────
//
// `GET /mcp/servers/:name` returns the full view, whose `credentials` block the
// typed summary intentionally drops. Presence is worth showing (it proves the
// fail-closed path) but a VALUE must never leave Core. This reader asks the SAME
// base URL the typed routes use and returns key name + status only — there is no
// field in its result that could hold a value.

export interface CredentialPresence {
  key: string;
  /** "PRESENT" | "MISSING" | "UNREADABLE" | "NOT_REQUIRED". */
  status: string;
}

export async function fetchCredentialPresence(
  baseUrl: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialPresence[]> {
  try {
    const res = await fetchImpl(`${baseUrl}/mcp/servers/${encodeURIComponent(name)}`, { method: "GET" });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    const server = asRecord(asRecord(body)?.server);
    const credentials = asRecord(server?.credentials);
    const keys = credentials?.keys;
    if (!Array.isArray(keys)) return [];
    const out: CredentialPresence[] = [];
    for (const raw of keys) {
      const rec = asRecord(raw);
      const key = rec && typeof rec.key === "string" ? rec.key : undefined;
      const status = rec && typeof rec.status === "string" ? rec.status : undefined;
      // ONLY the name and the state word; no value field is ever read.
      if (key !== undefined && status !== undefined) out.push({ key, status });
    }
    return out;
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export interface McpPageOptions extends PageContext {
  /** Command override (default: `routes.mcpServerCommand`). */
  command?: (name: string, command: McpServerCommand) => Promise<CoreResult<ToolInvokeOutcome>>;
  /** Provenance limit; default 50. */
  provenanceLimit?: number;
}

export interface McpPage {
  readonly el: HTMLElement;
  render(slice: WorkspaceSlice): void;
  select(name: string | null): void;
  readonly selectedName: string | null;
  destroy(): void;
}

const STATUS_ORDER: McpStatus[] = ["CONNECTED", "BLOCKED", "ENABLED", "CONNECTING", "DISABLED"];

export function createMcpPage(options: McpPageOptions): McpPage {
  const el = h("section", {
    class: "kai-page kai-mcp-page",
    style: "display:flex;flex-direction:column;height:100%;min-height:0;width:100%;box-sizing:border-box",
  });

  // capability band
  const capDot = dot("#8b93a1", 8);
  const capChip = h("span", { class: "kai-mcp-cap-chip" });
  const capDetail = h("span", { class: "kai-mcp-cap-detail", style: `font:400 11px var(--font,sans-serif);color:${DIM}` });
  const counts = h("span", { class: "kai-mcp-counts", style: `font:500 11px var(--font,sans-serif);color:${DIM2}` });
  const provenanceBtn = actionBtn("Provenance", () => void loadProvenance(), INFO);
  const refresh = actionBtn("Refresh", () => options.refresh?.(), INFO);
  const header = h(
    "div",
    { style: "display:flex;align-items:center;gap:10px;padding:2px 2px 8px;flex-wrap:wrap" },
    h("span", { style: `font:600 15px var(--font,sans-serif);color:${INK}`, text: "MCP" }),
    capDot,
    capChip,
    capDetail,
    h("div", { style: "flex:1 1 auto" }),
    counts,
    provenanceBtn,
    refresh,
  );

  const listPane = h("div", {
    class: "kai-mcp-list",
    style:
      `flex:0 0 340px;min-width:260px;max-width:42%;overflow-y:auto;overflow-x:hidden;` +
      `display:flex;flex-direction:column;gap:2px;padding-right:6px`,
  });
  const detailPane = h("div", {
    class: "kai-mcp-detail",
    style: "flex:1 1 auto;min-width:0;overflow-y:auto;padding:2px 4px 16px 18px;border-left:1px solid rgba(255,255,255,.07)",
  });
  const ledgerHost = h("div", {
    class: "kai-mcp-ledger",
    style: "flex:0 0 auto;max-height:42%;overflow-y:auto;border-top:1px solid rgba(255,255,255,.07);padding:8px 4px 4px",
  });
  ledgerHost.hidden = true;
  const body = h("div", { style: "display:flex;flex:1 1 auto;min-height:0;align-items:stretch" }, listPane, detailPane);

  el.append(header, body, ledgerHost);

  let slice: WorkspaceSlice | null = null;
  let selectedName: string | null = null;
  let detailSeq = 0;

  function notify(kind: "ok" | "warn" | "error", text: string): void {
    if (options.notify) options.notify(kind, text);
  }

  // ── list ────────────────────────────────────────────────────────────────
  function renderList(): void {
    clear(listPane);
    const servers = slice?.mcp?.servers ?? [];
    if (slice !== null && slice.conn === "OFFLINE") {
      listPane.append(muted("KAI Core is offline — the MCP catalogue cannot be read."));
      return;
    }
    if (servers.length === 0) {
      listPane.append(muted("No MCP servers are registered. Register one with POST /mcp/servers."));
      return;
    }
    const ordered = [...servers].sort(
      (a, b) => STATUS_ORDER.indexOf(serverStatus(a).status) - STATUS_ORDER.indexOf(serverStatus(b).status) || a.name.localeCompare(b.name),
    );
    for (const server of ordered) listPane.append(serverRow(server));
  }

  function serverRow(server: McpServerSummary): HTMLElement {
    const st = serverStatus(server);
    const on = server.name === selectedName;
    const rowEl = h("button", {
      class: on ? "kai-row on" : "kai-row",
      style:
        `display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer;` +
        `background:${on ? "rgba(59,158,255,.10)" : "transparent"};border:0;border-radius:7px;padding:6px 8px`,
      onclick: () => select(server.name),
    });
    rowEl.append(
      dot(st.color, 8),
      h(
        "div",
        { style: "display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto" },
        h(
          "div",
          { style: "display:flex;align-items:center;gap:8px" },
          h("span", { style: `font:600 12px var(--font,sans-serif);color:${INK};text-transform:capitalize`, text: server.name }),
          h("div", { style: "flex:1 1 auto" }),
          chip(st.status, st.color),
        ),
        h("div", { style: "display:flex;align-items:center;gap:6px" }, chip(server.transport, "#8b93a1"), muted(`${server.toolCount} tool(s)`, 10)),
      ),
    );
    return rowEl;
  }

  // ── detail ──────────────────────────────────────────────────────────────
  async function renderDetail(): Promise<void> {
    clear(detailPane);
    if (selectedName === null) {
      detailPane.append(
        h("div", { style: `margin-top:18px;font:400 12px var(--font,sans-serif);color:${DIM}`, text: "Select a server to see its transport, credentials and tools." }),
      );
      return;
    }
    const listed = slice?.mcp?.servers.find((s) => s.name === selectedName) ?? null;
    if (listed === null) {
      detailPane.append(muted(`No MCP server named "${selectedName}" is registered.`));
      return;
    }
    // Re-read the live state from GET /mcp/servers/:name (proves the route).
    const seq = ++detailSeq;
    const fetched = await options.routes.mcpServer(selectedName);
    if (seq !== detailSeq) return;
    const server: McpServerSummary = fetched.ok ? fetched.value : listed;
    const presence = await fetchCredentialPresence(options.routes.baseUrl, server.name);
    if (seq !== detailSeq) return;
    clear(detailPane);
    detailPane.append(detail(server, presence));
  }

  function detail(server: McpServerSummary, presence: CredentialPresence[]): HTMLElement {
    const st = serverStatus(server);
    const frag = h("div", { style: "display:flex;flex-direction:column;gap:2px;max-width:780px" });

    frag.append(
      h(
        "div",
        { style: "display:flex;align-items:center;gap:10px;margin-top:6px" },
        h("span", { style: `font:600 16px var(--font,sans-serif);color:${INK};text-transform:capitalize`, text: server.name }),
        chip(st.status, st.color),
        chip(server.transport, "#8b93a1"),
        server.hasRisk ? chip("risk declared", OK) : chip("no risk → tools refused", BAD),
      ),
      h("p", { style: `margin:8px 0 2px;font:400 12px/1.5 var(--font,sans-serif);color:${DIM2}`, text: st.reason }),
    );

    // server info
    const info = server.serverInfo;
    if (info !== undefined && (info.name !== undefined || info.version !== undefined || info.protocolVersion !== undefined)) {
      frag.append(sectionLabel("Server"));
      frag.append(
        mono(`${info.name ?? server.name}${info.version !== undefined ? ` v${info.version}` : ""}${info.protocolVersion !== undefined ? ` · protocol ${info.protocolVersion}` : ""}`, 11),
      );
    }

    // endpoint
    const target = serverTarget(server);
    frag.append(sectionLabel(server.transport === "stdio" ? "Command" : "Endpoint"));
    frag.append(mono(target === "" ? "(not configured)" : target, 11));

    // credentials — KEY NAMES + presence only, never values
    const keys = credentialKeys(server);
    frag.append(sectionLabel("Credentials", "names & presence only — values are never shown"));
    if (keys.length === 0 && presence.length === 0) {
      frag.append(muted("No credentials are required by this server."));
    } else {
      const rows = presence.length > 0 ? presence : keys.map((k) => ({ key: k, status: "DECLARED" }));
      for (const entry of rows) {
        frag.append(
          h(
            "div",
            { style: "display:flex;align-items:center;gap:8px;padding:3px 0" },
            mono(entry.key, 11, INK),
            h("div", { style: "flex:1 1 auto" }),
            chip(entry.status, presenceColor(entry.status)),
          ),
        );
      }
      frag.append(muted("KAI holds only a reference; the value is resolved inside Core at launch.", 10));
    }

    // actions
    frag.append(sectionLabel("Actions"));
    const actionHost = h("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
    if (!server.enabled) actionHost.append(actionBtn("Enable", () => void run(server, "enable"), OK));
    if (server.enabled && !server.connected) actionHost.append(actionBtn("Connect", () => void run(server, "connect"), INFO));
    if (server.connected) actionHost.append(actionBtn("Refresh tools", () => void run(server, "refresh"), INFO));
    if (server.connected) actionHost.append(actionBtn("Disconnect", () => void run(server, "disconnect"), WARN));
    if (server.enabled) actionHost.append(actionBtn("Disable", () => void run(server, "disable"), WARN));
    actionHost.append(actionBtn("Remove", () => void run(server, "remove"), BAD));
    frag.append(actionHost);
    frag.append(h("div", { class: "kai-mcp-action-result" }));

    // tools registered
    frag.append(sectionLabel("Registered tools", String(server.toolCount)));
    frag.append(
      server.toolCount === 0
        ? muted(st.status === "CONNECTED" ? "This server exposed no tools." : "Connect the server to register its tools.")
        : muted(`${server.toolCount} of this server's tools are registered in KAI's ONE registry (visible on the Tools page).`),
    );
    return frag;
  }

  // ── actions ─────────────────────────────────────────────────────────────
  async function run(server: McpServerSummary, command: McpServerCommand): Promise<void> {
    const exec = options.command ?? ((name, cmd) => options.routes.mcpServerCommand(name, cmd));
    const host = detailPane.querySelector(".kai-mcp-action-result");
    host?.querySelector(".kai-approval-card")?.remove();
    if (host) clear(host);
    const res = await exec(server.name, command);
    if (!res.ok) {
      notify("error", `Core refused mcp.${command} ${server.name}: ${res.error.reason ?? res.error.message}`);
      return;
    }
    if (res.value.approvalRequired) {
      notify("warn", `KAI parked mcp.${command} on ${server.name} for your approval.`);
      const approvalId = res.value.approvalId ?? extractApprovalId(res.value.reason ?? "");
      if (host) {
        host.append(
          renderApprovalCard(
            {
              title: `Approve mcp.${command} on ${server.name}`,
              effect: "WRITE",
              effectColor: WARN,
              detail: safeJson({ toolId: `mcp.${command}`, server: server.name }),
              ...(approvalId !== undefined ? { approvalId } : {}),
              ...(res.value.reason !== undefined ? { reason: res.value.reason } : {}),
            },
            (decision) => {
              if (approvalId === undefined || options.decideApproval === undefined) {
                notify("warn", "Answer this approval in the Approvals view.");
                return;
              }
              options.decideApproval(approvalId, decision);
              notify("ok", `KAI recorded your ${decision}.`);
              options.refresh?.();
            },
          ),
        );
      }
      return;
    }
    // The real outcome. A connect on a remote endpoint is refused BEFORE parking
    // (AGENT_NOT_LISTENING), so its honest reason is shown here, verbatim.
    if (res.value.status === "FAILED" || (res.value.result !== undefined && String(res.value.status).toUpperCase() === "FAILED")) {
      notify("error", `Core refused: ${res.value.reason ?? res.value.status}`);
      return;
    }
    notify("ok", `KAI ran mcp.${command} on ${server.name} (${res.value.status}).`);
    options.refresh?.();
  }

  // ── provenance ledger ───────────────────────────────────────────────────
  async function loadProvenance(): Promise<void> {
    if (!ledgerHost.hidden) {
      ledgerHost.hidden = true;
      provenanceBtn.textContent = "Provenance";
      return;
    }
    ledgerHost.hidden = false;
    provenanceBtn.textContent = "Hide provenance";
    clear(ledgerHost);
    ledgerHost.append(muted("Reading GET /mcp/provenance…"));
    const res = await options.routes.mcpProvenance(options.provenanceLimit ?? 50);
    clear(ledgerHost);
    ledgerHost.append(sectionLabel("MCP provenance ledger", res.ok ? `${res.value.length} record(s)` : "unavailable"));
    if (!res.ok) {
      ledgerHost.append(muted(res.error.reason ?? res.error.message));
      return;
    }
    if (res.value.length === 0) {
      ledgerHost.append(muted("No MCP tool has been invoked yet. The ledger records every attempt — success or refusal."));
      return;
    }
    for (const record of res.value.slice(0, 60)) ledgerHost.append(provenanceRow(record));
  }

  function provenanceRow(record: McpProvenanceRecord): HTMLElement {
    const ok = record.status === "EXECUTED";
    const color = ok ? OK : record.status === "FAILED" || record.status === "INVALID" ? BAD : WARN;
    const err = record.error !== undefined ? ` — ${record.error.code}: ${record.error.message}` : "";
    return h(
      "div",
      { style: "display:flex;align-items:center;gap:8px;padding:3px 0" },
      dot(color, 6),
      mono(record.toolId, 10.5, INK),
      muted(`via ${record.source}`, 10),
      h("div", { style: "flex:1 1 auto" }),
      muted(`${record.durationMs}ms`, 10),
      chip(record.status, color),
      record.startedAt !== "" ? muted(new Date(record.startedAt).toLocaleTimeString(), 10) : null,
      err !== "" ? h("span", { style: `font:400 10px var(--font,sans-serif);color:${BAD}`, text: err }) : null,
    );
  }

  // ── selection / render ──────────────────────────────────────────────────
  function select(name: string | null): void {
    selectedName = name;
    renderList();
    void renderDetail();
  }

  function render(next: WorkspaceSlice): void {
    slice = next;
    const mcp = next.mcp;
    if (mcp === null) {
      capChip.textContent = next.conn === "OFFLINE" ? "UNAVAILABLE" : "…";
      capChip.setAttribute("style", `font:600 10px ${MONO};color:${DIM};border:1px solid ${DIM}55;border-radius:999px;padding:1px 8px`);
      capDetail.textContent = next.conn === "OFFLINE" ? "KAI Core is offline." : "Reading MCP capability…";
      counts.textContent = "";
      renderList();
      void renderDetail();
      return;
    }
    const availColor = mcp.capability.availability === "AVAILABLE" ? OK : mcp.capability.availability === "DEGRADED" ? WARN : "#8b93a1";
    capDot.setAttribute("style", `width:8px;height:8px;background:${availColor};border-radius:50%`);
    capChip.textContent = mcp.capability.availability;
    capChip.setAttribute("style", `font:600 10px ${MONO};color:${availColor};border:1px solid ${availColor}55;background:${availColor}1f;border-radius:999px;padding:1px 8px`);
    capDetail.textContent = mcp.capability.detail;
    counts.textContent = `${mcp.counts.servers} server(s) · ${mcp.counts.connected} connected · ${mcp.counts.tools} tool(s) · provenance ${mcp.provenanceCount}`;
    renderList();
    void renderDetail();
  }

  render({
    conn: "CONNECTING", lastError: null, lastSyncAt: null, tools: [], mcp: null, maintenance: null, actions: [], events: [],
  });

  return {
    el,
    render,
    select,
    get selectedName() {
      return selectedName;
    },
    destroy() {
      detailSeq += 1;
      clear(el);
    },
  };
}

// ── The shell seam (Stream A owns the shell; this is the ONE line it adds) ───
//
//   import { mountMcp } from "../views/mcp";
//   registerPage("mcp", mountMcp);

import type { PageFactory } from "../shell/types";

export const mountMcp: PageFactory = (ctx) => {
  const page = createMcpPage({
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

function chip(text: string, color: string): HTMLElement {
  return h("span", {
    style:
      `flex:0 0 auto;font:600 10px ${MONO};color:${color};border:1px solid ${color}55;` +
      `background:${color}1f;border-radius:999px;padding:1px 8px`,
    text,
  });
}

function muted(text: string, size = 11): HTMLElement {
  return h("span", { style: `font:400 ${size}px var(--font,sans-serif);color:${DIM}`, text });
}

function mono(text: string, size = 10.5, color = DIM2): HTMLElement {
  return h("span", {
    style: `font:400 ${size}px ${MONO};color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`,
    text,
  });
}

function actionBtn(label: string, onClick: () => void, color = "#c5c8cd"): HTMLButtonElement {
  return h("button", {
    class: "kai-btn",
    style:
      `font:600 11px var(--font,sans-serif);color:${color};background:${color}14;border:1px solid ${color}55;` +
      `border-radius:7px;padding:3px 10px;cursor:pointer`,
    text: label,
    onclick: onClick,
  });
}

function sectionLabel(text: string, trailing?: string): HTMLElement {
  return h(
    "div",
    { style: "display:flex;align-items:baseline;gap:8px;margin:10px 0 4px" },
    h("span", { style: `font:600 11px var(--font,sans-serif);color:${DIM2};text-transform:uppercase;letter-spacing:.06em`, text }),
    trailing !== undefined ? muted(trailing, 10) : h("div", { style: "flex:1 1 auto" }),
  );
}

function presenceColor(status: string): string {
  switch (status) {
    case "PRESENT":
      return OK;
    case "MISSING":
      return BAD;
    case "UNREADABLE":
      return WARN;
    case "NOT_REQUIRED":
    case "DECLARED":
      return "#8b93a1";
    default:
      return DIM;
  }
}

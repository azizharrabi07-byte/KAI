// KAI — the Tools page (owner §D). A PRIMARY surface at real dimensions, not a
// strip: a searchable registry list beside a full tool detail.
//
// WHAT IT SHOWS (all read from the ONE live Core route surface)
//   GET /tools        the registry, described (list)
//   GET /tools/:id    one tool, described (detail, fetched on selection)
//   POST /tools/:id/invoke  run a tool through the ONE boundary; a 409 park is normal
//
// A tool's risk is CORE'S declaration (`permission.risk`, `effectful`,
// `sideEffecting`). This page never re-classifies risk and never decides whether
// an action is allowed: the registry's boundary (validate -> policy -> (approval)
// -> execute) is the sole authority, and the page only DISPLAYS what Core said
// and shows the park reason when the boundary asks for a human.
//
// ── Attribution (MIT) ────────────────────────────────────────────────────────
// Portions adapted from OpenGhost (github.com/ANDRETRIPOL/OpenGhost), MIT License,
// Copyright (c) 2026 Andrew — specifically the tool-schema SHAPE vocabulary and
// the `describe` display-description idea from `agent-tools.js`, and the
// approval-card PRESENTATION structure from `approval-card.js`. Only the
// mechanism/idea was taken; KAI writes its own names, contract, geometry and
// CSS. OpenGhost's risk classifier is a front-end regex heuristic and is
// deliberately NOT ported: KAI's policy engine stays the sole decision. See
// docs/OPEN_GHOST_REUSE_MANIFEST.md §6/§9/§B.
//
// A pure helper layer (`schemaFields`, `describeTool`) sits at the top so it is
// testable with no DOM; the DOM builders below consume it.

import { h, clear, dot } from "./dom";
import { toolDispatchHint, actionLine, type WorkspaceSlice, type WorkspaceEventRow } from "../workspace/store";
import type { ToolDescription, ToolPermission, ToolSchemaView, ToolInvokeOutcome } from "../workspace/types";
import type { WorkspaceRoutes } from "../workspace/routes";
import type { CoreResult } from "../core/kai-core";

// ── KAI's own palette (KAI-authored values; never OpenGhost's styles.css) ─────

export const RISK_COLOR: Record<string, string> = {
  READ: "#34D399",
  WRITE: "#F5A524",
  EXTERNAL: "#3B9EFF",
  DESTRUCTIVE: "#F4505E",
};
export const OK = "#34D399";
export const WARN = "#F5A524";
export const INFO = "#3B9EFF";
export const BAD = "#F4505E";
export const INK = "var(--ink,#f5f6f8)";
export const DIM = "var(--dim,#9398a1)";
export const DIM2 = "var(--dim-2,#8e939c)";
export const MONO = "var(--mono,ui-monospace,monospace)";

export function riskColor(risk: string): string {
  return RISK_COLOR[risk] ?? "#8b93a1";
}

// ── Pure layer: schema shapes & display descriptions ─────────────────────────

/** One field of a tool's declared input, normalized for display. */
export interface SchemaField {
  name: string;
  /** "string" | "integer" | "number" | "boolean" | "array" | "object" | "enum" | "unknown". */
  type: string;
  description: string;
  required: boolean;
  enumValues: string[];
  minimum?: number;
  maximum?: number;
  /** For arrays: the element type, when declared. */
  itemsType?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) if (typeof item === "string") out.push(item);
  return out;
}

/**
 * Normalize a tool's declared schema to a flat field list.
 *
 * Handles KAI's own shape (`{ kind: "object", properties: {…},
 * additionalProperties: false }`, with `required` either per-property or a
 * top-level array) and the OpenGhost-style function shape (`{ function: {
 * parameters: { properties, required } } }`) so the same renderer serves either.
 * An undeclared schema yields `[]` — an honest empty, never an invented field.
 */
export function schemaFields(view: ToolSchemaView): SchemaField[] {
  if (!view.declared) return [];
  const root = asRecord(view.schema);
  if (root === null) return [];
  // Unwrap the OpenGhost-style `{ function: { parameters } }` envelope.
  const fn = asRecord(root.function);
  const params = asRecord(fn?.parameters) ?? asRecord(root.parameters) ?? root;
  const properties = asRecord(params.properties);
  if (properties === null) return [];
  const topRequired = new Set(asStringArray(params.required));

  const fields: SchemaField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const spec = asRecord(raw) ?? {};
    const rawType = spec.type;
    const type =
      typeof rawType === "string"
        ? rawType
        : Array.isArray(rawType)
          ? asStringArray(rawType).join(" | ")
          : "unknown";
    const enumValues = asStringArray(spec.enum);
    const items = asRecord(spec.items);
    const field: SchemaField = {
      name,
      type: enumValues.length > 0 ? "enum" : type,
      description: typeof spec.description === "string" ? spec.description : "",
      // Per-property `required: true` (KAI) OR the top-level required array (both).
      required: spec.required === true || topRequired.has(name),
      enumValues,
    };
    if (typeof spec.minimum === "number") field.minimum = spec.minimum;
    if (typeof spec.maximum === "number") field.maximum = spec.maximum;
    if (items && typeof items.type === "string") field.itemsType = items.type;
    fields.push(field);
  }
  return fields;
}

/** A plain-language, display-only description of a tool — never a decision. */
export interface ToolDisplay {
  /** The tool's own declared sentence. */
  headline: string;
  /** Core's declared risk level, verbatim. */
  risk: string;
  /** A short, plain word for what the tool does to the machine. */
  effectWord: string;
  /** Colour for the effect word. */
  effectColor: string;
  /** "runs directly (read-only)" / "parks for approval (…) — …" */
  dispatch: string;
  /** How many declared input fields (0 when none declared). */
  fieldCount: number;
  /** True when Core reports a declared schema. */
  hasSchema: boolean;
  /** The reason Core gave when no schema was declared. */
  schemaReason: string;
}

/**
 * The display description of a tool. Every value is derived from Core's declared
 * facts; nothing is inferred from the tool id, its name, or a regex over its
 * input. This is what the card/list shows — it never gates execution.
 */
export function describeTool(tool: ToolDescription): ToolDisplay {
  const permission: ToolPermission = tool.permission;
  const risk = permission.risk;
  let effectWord: string;
  if (!permission.sideEffecting) effectWord = "reads only";
  else if (risk === "WRITE") effectWord = "changes things";
  else if (risk === "EXTERNAL") effectWord = "affects other processes";
  else if (risk === "DESTRUCTIVE") effectWord = "can destroy";
  else effectWord = "has an effect";
  const fields = schemaFields(tool.schema);
  return {
    headline: tool.description,
    risk,
    effectWord,
    effectColor: riskColor(risk),
    dispatch: toolDispatchHint(tool),
    fieldCount: fields.length,
    hasSchema: tool.schema.declared,
    schemaReason: tool.schema.declared ? "" : tool.schema.reason,
  };
}

/** One execution row for the selected tool, derived from real Core history. */
export interface ToolExecution {
  at: string;
  /** "executed" | "approval" | "action" as Core recorded it. */
  kind: string;
  text: string;
  tone: string;
}

/**
 * The recent executions of a tool from the workspace slice — the events the Core
 * stream delivered and the persisted `action.executed` records. Nothing is
 * invented: a reference is included only when the payload actually names the
 * tool id, and an empty result is reported as "no recorded executions".
 */
export function toolExecutions(slice: WorkspaceSlice, toolId: string): ToolExecution[] {
  const rows: ToolExecution[] = [];
  for (const event of slice.events) {
    const p = asRecord((event as WorkspaceEventRow).payload);
    const mentioned =
      p !== null &&
      (p.toolId === toolId || p.capabilityId === toolId || (typeof p.action === "string" && p.action.includes(toolId)));
    if (!mentioned && !event.type.includes(toolId)) continue;
    const isApproval = event.type.startsWith("approval");
    const isTool = event.type.startsWith("tool");
    rows.push({
      at: event.at,
      kind: isApproval ? "approval" : isTool ? "executed" : event.type,
      text: event.line,
      tone: isApproval ? WARN : event.type.endsWith(".failed") ? BAD : OK,
    });
  }
  for (const action of slice.actions) {
    const p = asRecord(action);
    const tool = typeof p?.toolId === "string" ? p.toolId : typeof p?.capabilityId === "string" ? p.capabilityId : "";
    if (tool !== toolId) continue;
    const at = typeof p?.at === "string" ? p.at : typeof p?.timestamp === "string" ? p.timestamp : "";
    rows.push({ at, kind: "action", text: actionLine(action), tone: INFO });
  }
  // Newest first when a timestamp is present; unknown timestamps sink.
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// ── Shared mount context ─────────────────────────────────────────────────────

/**
 * What the shell (Stream A) hands every page. Structural: any object with these
 * fields works, so the shell does not import a type from here.
 */
export interface PageContext {
  /** The typed Core routes (`workspace/routes.ts`). */
  routes: WorkspaceRoutes;
  /** A short human notice after an action. Optional. */
  notify?: (kind: "ok" | "warn" | "error", text: string) => void;
  /** Ask the shell to re-read the shared slice after a real state change. Optional. */
  refresh?: () => void;
  /** Correlation ids forwarded to invocations. Optional. */
  sessionId?: string;
  agentId?: string;
  /** Who caused the invocation; default "ui". */
  source?: string;
  /** Decide a parked approval, when the shell wires the shared decider. */
  decideApproval?: (id: string, decision: "allow" | "deny") => void;
}

// ── Small shared pieces (KAI's own visual design) ────────────────────────────

function chip(text: string, color: string): HTMLElement {
  return h("span", {
    style:
      `flex:0 0 auto;font:600 10px ${MONO};color:${color};letter-spacing:.02em;` +
      `border:1px solid ${color}55;background:${color}1f;border-radius:999px;padding:1px 8px`,
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

/** `prefers-reduced-motion` — animation is a courtesy, never required. */
function reducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** The KAI ink-underline that marks a primary/selected row (KAI-authored). */
function accentBar(color: string, height = 0): HTMLElement {
  return h("i", { style: `display:block;width:3px;height:${height > 0 ? `${height}px` : "100%"};background:${color};border-radius:2px` });
}

// ── Approval-card PRESENTATION (adapted from OpenGhost `approval-card.js`) ────
//
// The idea kept from OpenGhost: the card LEADS with what the step is for in
// plain words, says what it does to the computer (worked out by KAI from the
// tool's own declared risk, so a harmless-sounding sentence cannot hide a
// dangerous action), and keeps the technical detail one click away. The card
// does NOT decide: KAI's approval authority is Core's, and the card resolves the
// same 409-park the boundary produced.

export interface ApprovalCardSpec {
  /** Plain-language headline. */
  title: string;
  /** Core's declared risk word, shown as an effect badge. */
  effect: string;
  effectColor: string;
  /** The technical detail behind the reveal (the raw input JSON, the reason). */
  detail: string;
  /** The approval id to retry with, when the park named one. */
  approvalId?: string;
  reason?: string;
}

export function renderApprovalCard(
  spec: ApprovalCardSpec,
  onDecide: (decision: "allow" | "deny") => void,
): HTMLElement {
  const el = h("div", {
    class: "kai-approval-card",
    role: "group",
    "aria-label": spec.title,
    style:
      `display:flex;flex-direction:column;gap:6px;border:1px solid ${spec.effectColor}55;background:${spec.effectColor}12;` +
      `border-radius:10px;padding:10px 12px;margin-top:8px`,
  });
  const head = h(
    "div",
    { style: "display:flex;align-items:center;gap:8px" },
    dot(spec.effectColor, 8),
    h("span", { style: `font:600 12px var(--font,sans-serif);color:${INK}`, text: spec.title }),
    h("div", { style: "flex:1 1 auto" }),
    chip(spec.effect, spec.effectColor),
  );
  el.append(head);
  if (spec.reason !== undefined) el.append(h("div", { style: `font:400 10.5px var(--font,sans-serif);color:${DIM2}`, text: spec.reason }));

  if (spec.detail.length > 0) {
    const details = h("details", { style: "margin-top:2px" });
    details.append(
      h("summary", {
        style: `cursor:pointer;font:500 10.5px var(--font,sans-serif);color:${DIM}`,
        text: "Show what will run",
      }),
      h("pre", {
        style:
          `margin:6px 0 0;padding:8px;background:rgba(0,0,0,.28);border-radius:7px;` +
          `font:400 10.5px ${MONO};color:${DIM2};white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto`,
        text: spec.detail,
      }),
    );
    el.append(details);
  }

  const foot = h("div", { style: "display:flex;gap:8px;justify-content:flex-end;margin-top:2px" });
  if (spec.approvalId !== undefined) foot.append(mono(`approval ${spec.approvalId}`, 10));
  foot.append(h("div", { style: "flex:1 1 auto" }));
  foot.append(actionBtn("Deny", () => onDecide("deny"), BAD));
  foot.append(actionBtn("Allow", () => onDecide("allow"), OK));
  el.append(foot);
  return el;
}

// ── The page ─────────────────────────────────────────────────────────────────

export interface ToolsPageOptions extends PageContext {
  /** Invoke override (default: `routes.invokeTool`). */
  invokeTool?: (id: string, input: unknown) => Promise<CoreResult<ToolInvokeOutcome>>;
}

export interface ToolsPage {
  readonly el: HTMLElement;
  /** The shell calls this on every workspace-slice change. */
  render(slice: WorkspaceSlice): void;
  /** Select a tool by id (also used by the shell's deep-link). */
  select(id: string | null): void;
  readonly selectedId: string | null;
  destroy(): void;
}

export function createToolsPage(options: ToolsPageOptions): ToolsPage {
  const source = options.source ?? "ui";

  const el = h("section", {
    class: "kai-page kai-tools-page",
    style: "display:flex;flex-direction:column;height:100%;min-height:0;width:100%;box-sizing:border-box",
  });

  // ── header ──────────────────────────────────────────────────────────────
  const countChip = h("span", { class: "kai-tools-count" });
  const search = h("input", {
    class: "kai-search",
    type: "search",
    placeholder: "Filter tools by id, name or risk…",
    style:
      `font:400 11.5px var(--font,sans-serif);color:${INK};background:rgba(255,255,255,.05);` +
      `border:1px solid rgba(255,255,255,.10);border-radius:8px;padding:5px 10px;min-width:220px;outline:none`,
  });
  const refresh = actionBtn("Refresh", () => options.refresh?.(), INFO);
  const header = h(
    "div",
    { style: "display:flex;align-items:center;gap:10px;padding:2px 2px 10px" },
    h("span", { style: `font:600 15px var(--font,sans-serif);color:${INK}`, text: "Tools" }),
    countChip,
    h("div", { style: "flex:1 1 auto" }),
    search,
    refresh,
  );

  // ── two panes ───────────────────────────────────────────────────────────
  const listPane = h("div", {
    class: "kai-tools-list",
    style:
      `flex:0 0 380px;min-width:280px;max-width:44%;overflow-y:auto;overflow-x:hidden;` +
      `display:flex;flex-direction:column;gap:2px;padding-right:6px`,
  });
  const detailPane = h("div", {
    class: "kai-tools-detail",
    style:
      `flex:1 1 auto;min-width:0;overflow-y:auto;padding:2px 4px 16px 18px;` +
      `border-left:1px solid rgba(255,255,255,.07)`,
  });
  const body = h(
    "div",
    { style: "display:flex;flex:1 1 auto;min-height:0;align-items:stretch" },
    listPane,
    detailPane,
  );
  el.append(header, body);

  // ── state ───────────────────────────────────────────────────────────────
  let slice: WorkspaceSlice | null = null;
  let selectedId: string | null = null;
  let filter = "";
  let detailSeq = 0;

  function notify(kind: "ok" | "warn" | "error", text: string): void {
    if (options.notify) options.notify(kind, text);
  }

  function visibleTools(): ToolDescription[] {
    const all = slice?.tools ?? [];
    const q = filter.trim().toLowerCase();
    if (q === "") return all;
    return all.filter((t) => {
      const d = describeTool(t);
      return (
        t.id.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        d.risk.toLowerCase().includes(q)
      );
    });
  }

  // ── list ────────────────────────────────────────────────────────────────
  function renderList(): void {
    clear(listPane);
    if (slice === null) return;
    if (slice.conn === "OFFLINE") {
      listPane.append(muted("KAI Core is offline — the registry cannot be read."));
      return;
    }
    const tools = visibleTools();
    if (tools.length === 0) {
      listPane.append(muted(slice.tools.length === 0 ? "No tools are registered." : "No tool matches the filter."));
      return;
    }
    for (const tool of tools) listPane.append(toolRow(tool));
  }

  function toolRow(tool: ToolDescription): HTMLElement {
    const d = describeTool(tool);
    const on = tool.id === selectedId;
    const rowEl = h("button", {
      class: on ? "kai-row on" : "kai-row",
      style:
        `display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer;` +
        `background:${on ? "rgba(59,158,255,.10)" : "transparent"};border:0;border-radius:7px;padding:6px 8px`,
      onclick: () => select(tool.id),
    });
    rowEl.append(
      accentBar(on ? INFO : "transparent", 0),
      h(
        "div",
        { style: "display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto" },
        h(
          "div",
          { style: "display:flex;align-items:center;gap:8px;min-width:0" },
          h("span", { style: `font:600 12px var(--font,sans-serif);color:${INK};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`, text: tool.name }),
          h("div", { style: "flex:1 1 auto" }),
          chip(d.risk, d.effectColor),
        ),
        mono(tool.id, 10.5),
      ),
    );
    return rowEl;
  }

  // ── detail ──────────────────────────────────────────────────────────────
  async function renderDetail(): Promise<void> {
    clear(detailPane);
    if (selectedId === null) {
      detailPane.append(
        h("div", { style: `margin-top:18px;font:400 12px var(--font,sans-serif);color:${DIM}`, text: "Select a tool to see its schema, risk and recent executions." }),
      );
      return;
    }
    const listed = slice?.tools.find((t) => t.id === selectedId) ?? null;
    if (listed === null) {
      detailPane.append(muted(`No tool is registered with id "${selectedId}".`));
      return;
    }
    // The list row already carries a full description; GET /tools/:id is still
    // read to prove the detail route live and to pick up any newer declaration.
    const seq = ++detailSeq;
    const fetched = await options.routes.tool(selectedId);
    if (seq !== detailSeq) return; // a newer selection superseded this fetch
    const tool: ToolDescription = fetched.ok ? fetched.value : listed;
    if (!fetched.ok && fetched.error.code !== "CORE_OFFLINE") {
      notify("warn", `Detail route: ${fetched.error.reason ?? fetched.error.message}`);
    }
    clear(detailPane);
    detailPane.append(detailView(tool));
  }

  function detailView(tool: ToolDescription): HTMLElement {
    const d = describeTool(tool);
    const frag = h("div", { style: "display:flex;flex-direction:column;gap:2px;max-width:760px" });

    frag.append(
      h(
        "div",
        { style: "display:flex;align-items:center;gap:10px;margin-top:6px" },
        h("span", { style: `font:600 16px var(--font,sans-serif);color:${INK}`, text: tool.name }),
        chip(d.risk, d.effectColor),
        tool.permission.effectful ? chip("effectful", WARN) : null,
      ),
      mono(tool.id, 11.5, DIM),
      h("p", { style: `margin:8px 0 2px;font:400 12.5px/1.5 var(--font,sans-serif);color:${DIM2}`, text: d.headline }),
      h(
        "div",
        { style: "display:flex;align-items:center;gap:8px;margin-top:2px" },
        chip(d.effectWord, d.effectColor),
        muted(d.dispatch, 11),
      ),
    );

    // ── schema ──
    frag.append(sectionLabel("Input schema", d.hasSchema ? `${d.fieldCount} field(s)` : "none declared"));
    if (!d.hasSchema) {
      frag.append(
        h("div", { style: `font:400 11.5px var(--font,sans-serif);color:${WARN}`, text: `No schema declared — ${d.schemaReason || "procedural validator"}.` }),
      );
    } else if (d.fieldCount === 0) {
      frag.append(muted("This tool takes no input."));
    } else {
      for (const field of schemaFields(tool.schema)) frag.append(schemaFieldRow(field));
    }
    // The raw declaration, one click away.
    if (tool.schema.declared) {
      const raw = h("details", { style: "margin-top:6px" });
      raw.append(
        h("summary", { style: `cursor:pointer;font:500 10.5px var(--font,sans-serif);color:${DIM}`, text: "Show raw schema" }),
        h("pre", {
          style:
            `margin:6px 0 0;padding:8px;background:rgba(0,0,0,.28);border-radius:7px;` +
            `font:400 10.5px ${MONO};color:${DIM2};white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto`,
          text: safeJson(tool.schema.schema),
        }),
      );
      frag.append(raw);
    }

    // ── invoke ──
    frag.append(sectionLabel("Run"));
    const invokeHost = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
    const runBtn = actionBtn(
      tool.permission.sideEffecting ? "Request (parks for approval)" : "Run",
      () => void runTool(tool, invokeHost),
      tool.permission.sideEffecting ? WARN : OK,
    );
    invokeHost.append(
      h(
        "div",
        { style: "display:flex;align-items:center;gap:10px" },
        runBtn,
        muted(tool.permission.sideEffecting ? "Core will park this for a human decision." : "Core will execute this directly."),
      ),
    );
    frag.append(invokeHost);

    // ── recent executions ──
    const executions = slice !== null ? toolExecutions(slice, tool.id) : [];
    frag.append(sectionLabel("Recent executions", executions.length === 0 ? "none" : String(executions.length)));
    if (executions.length === 0) {
      frag.append(muted("No recorded executions for this tool."));
    } else {
      for (const ex of executions.slice(0, 12)) {
        frag.append(
          h(
            "div",
            { style: "display:flex;align-items:center;gap:8px;padding:3px 0" },
            dot(ex.tone, 6),
            h("span", { style: `font:400 11px var(--font,sans-serif);color:${DIM2};flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`, text: ex.text }),
            chip(ex.kind, ex.tone),
            ex.at !== "" ? muted(new Date(ex.at).toLocaleTimeString(), 10) : null,
          ),
        );
      }
    }
    return frag;
  }

  function schemaFieldRow(field: SchemaField): HTMLElement {
    const range =
      field.minimum !== undefined || field.maximum !== undefined
        ? ` (${field.minimum ?? "…"}–${field.maximum ?? "…"})`
        : "";
    const typeText = field.itemsType !== undefined ? `${field.type}<${field.itemsType}>` : field.type;
    return h(
      "div",
      { style: "display:flex;flex-direction:column;gap:2px;padding:5px 0;border-top:1px solid rgba(255,255,255,.05)" },
      h(
        "div",
        { style: "display:flex;align-items:center;gap:8px" },
        h("span", { style: `font:600 11.5px ${MONO};color:${INK}`, text: field.name }),
        chip(`${typeText}${range}`, INFO),
        field.required ? chip("required", WARN) : muted("optional", 10),
      ),
      field.description !== "" ? h("div", { style: `font:400 11px var(--font,sans-serif);color:${DIM2}`, text: field.description }) : null,
      field.enumValues.length > 0 ? mono(`one of: ${field.enumValues.join(", ")}`, 10) : null,
    );
  }

  // ── run ─────────────────────────────────────────────────────────────────
  async function runTool(tool: ToolDescription, host: HTMLElement): Promise<void> {
    const invoke = options.invokeTool ?? ((id, input) => options.routes.invokeTool(id, input, {
      source,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    }));
    host.querySelector(".kai-approval-card")?.remove();
    const res = await invoke(tool.id, {});
    if (!res.ok) {
      notify("error", `Core refused ${tool.id}: ${res.error.reason ?? res.error.message}`);
      return;
    }
    if (res.value.approvalRequired) {
      notify("warn", `KAI parked ${tool.id} for your approval.`);
      host.append(approvalFromOutcome(tool, res.value));
      return;
    }
    notify("ok", `KAI ran ${tool.id} (${res.value.status}).`);
    options.refresh?.();
  }

  function approvalFromOutcome(tool: ToolDescription, outcome: ToolInvokeOutcome): HTMLElement {
    const d = describeTool(tool);
    // The park reason names the approval id Core created; show it verbatim.
    const approvalId = outcome.approvalId ?? extractApprovalId(outcome.reason ?? "");
    return renderApprovalCard(
      {
        title: `Approve running ${tool.name}`,
        effect: d.risk,
        effectColor: d.effectColor,
        detail: safeJson({ toolId: tool.id, input: {}, dispatch: d.dispatch }),
        ...(approvalId !== undefined ? { approvalId } : {}),
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
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
    );
  }

  // ── selection ───────────────────────────────────────────────────────────
  function select(id: string | null): void {
    selectedId = id;
    renderList();
    void renderDetail();
  }

  function render(next: WorkspaceSlice): void {
    slice = next;
    countChip.textContent = `${next.tools.length} registered${next.tools.length > 0 ? ` · ${next.tools.filter((t) => t.permission.sideEffecting).length} side-effecting` : ""}`;
    countChip.setAttribute(
      "style",
      `font:500 11px var(--font,sans-serif);color:${next.conn === "ONLINE" ? OK : WARN};flex:0 0 auto`,
    );
    renderList();
    void renderDetail();
  }

  search.addEventListener("input", () => {
    filter = search.value;
    renderList();
  });

  let mounted = false;
  function ensureInitialRender(): void {
    if (mounted) return;
    mounted = true;
    if (slice === null) render({ conn: "CONNECTING", lastError: null, lastSyncAt: null, tools: [], mcp: null, maintenance: null, actions: [], events: [] });
  }
  ensureInitialRender();

  return {
    el,
    render,
    select,
    get selectedId() {
      return selectedId;
    },
    destroy() {
      detailSeq += 1;
      clear(el);
    },
  };
}

// ── tiny shared helpers ───────────────────────────────────────────────────────

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Pull `apr_…` out of a Core park reason, when it named one. */
export function extractApprovalId(text: string): string | undefined {
  const m = /\b(apr_[A-Za-z0-9_]+)\b/.exec(text);
  return m?.[1];
}

/** Re-export so `reducedMotion` has a home for the other pages without a DOM dep. */
export { reducedMotion };

// ── The shell seam (Stream A owns the shell; this is the ONE line it adds) ───
//
//   import { mountTools } from "../views/tools";
//   registerPage("tools", mountTools);
//
// The factory matches the shell's `PageFactory` exactly: it builds the page once,
// keeps it in step with the shell's ONE workspace slice via `subscribe`, and
// releases that subscription on `destroy`.

import type { PageFactory } from "../shell/types";

export const mountTools: PageFactory = (ctx) => {
  const page = createToolsPage({
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

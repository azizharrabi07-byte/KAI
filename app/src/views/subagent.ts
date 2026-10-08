// The SUBAGENT view — one persona's OWN persistent state.
//
// Selecting a subagent opens THIS panel, not KAI's conversation. What is shown is
// the persona's own record, read from Core: its name, purpose (role), personality
// (soul), visual identity (resolved through the KAI_VARIANT model), the worker it
// runs on — demoted to infrastructure beneath it, never a peer of KAI — its
// capabilities, the memory scope it owns, and the sessions bound to it
// (`GET /subagents/:id`, agentId === the persona's employee id). KAI stays the
// parent authority: the back button returns to KAI's own overview.
//
// Nothing here decides anything: the status and the session list are Core's. The
// one action is "Run a task", which POSTs the EXTERNAL run route; the run parks for
// approval exactly like any other action, and the parked approval is what lights the
// subagent as ACTIVE on the panel.

import { h, clear, dot } from "./dom";
import { State } from "../core/state";
import { subagentActivity, type CoreSubagentRow } from "../core/core-state";
import { washRGBA } from "../core/layout";
import { findPreset, describeVariant } from "../character/variant";
import { requestSubagentRun } from "../island/core-bridge";
import type { ViewActions, ViewHost } from "./views";

/** A subagent's visual identity, resolved through the KAI_VARIANT model. */
export function resolveVisual(sub: CoreSubagentRow): { primary: string; secondary: string; label: string } {
  const declared = (sub.visual?.declared ?? {}) as Record<string, unknown>;
  const variantId = typeof declared.variant === "string" ? declared.variant : undefined;
  const preset = variantId !== undefined ? findPreset(variantId) : undefined;
  const colour = typeof declared.colour === "string" ? declared.colour : undefined;
  const primary = preset?.primaryColor ?? colour ?? "#8B93A1";
  const secondary = preset?.secondaryColor ?? primary;
  // The model describes itself when it recognises the variant; otherwise we report
  // exactly what the persona declared — never an invented outfit.
  const bits: string[] = [];
  if (typeof declared.outfit === "string") bits.push(`${declared.outfit} outfit`);
  if (typeof declared.skin === "string") bits.push(`${declared.skin} skin`);
  if (Array.isArray(declared.accessories) && declared.accessories.length > 0) {
    bits.push(declared.accessories.filter((a) => typeof a === "string").join("/"));
  }
  const label = preset !== undefined
    ? describeVariant(preset)
    : bits.length > 0
      ? `${sub.name} — ${bits.join(" · ")}`
      : "no declared visual variant";
  return { primary, secondary, label };
}

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

export function buildSubagent(actions: ViewActions): ViewHost {
  const body = h("div", {
    class: "stack",
    style: "padding:12px 16px 12px 96px;justify-content:flex-start;gap:6px",
  });
  const el = h("div", { class: "view" }, h("div", { class: "card wash" }, body));
  const cardEl = el.firstElementChild as HTMLElement;
  cardEl.style.setProperty("--wash", washRGBA("indigo"));

  let key = "";

  return {
    el,
    sync() {
      const detail = State.subagentDetail;
      const selectedId = State.selectedSubagentId;
      // Prefer the fetched detail; fall back to the list row so the header is right
      // the instant a subagent is picked, before its detail request lands.
      const sub = detail?.subagent ?? State.core.subagents.find((s) => s.id === selectedId) ?? null;
      if (sub === null) {
        const show = State.core.conn === "OFFLINE" ? "KAI Core is not connected" : "No subagent selected.";
        if (key !== show) {
          key = show;
          clear(body);
          body.append(h("div", { class: "title", style: "font-size:14px", text: show }));
        }
        return;
      }

      const act = subagentActivity(State.core, sub);
      const vis = resolveVisual(sub);
      const worker = State.core.agents.find((a) => a.id === sub.workerId);
      const workerState = worker?.state ?? "unknown";
      const sessions = detail?.sessions ?? [];

      const sig = [
        sub.id, sub.name, sub.role, sub.soul, sub.workerId, sub.status, String(sub.enabled),
        vis.label, act.active ? "1" : "0", act.label, act.approvalId ?? "",
        workerState, sessions.map((s) => `${s.id}:${s.title}:${s.status}:${s.turnCount ?? ""}`).join(","),
      ].join("|");
      if (sig === key) return;
      key = sig;

      clear(body);

      // ── persona header ──────────────────────────────────────────────────────
      body.append(
        h(
          "div",
          { class: "row", style: "gap:7px;min-width:0" },
          dot(vis.primary, 9),
          h("span", {
            style: "font:600 14px var(--font);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
            text: sub.name,
          }),
          h("span", { style: "font:400 11px var(--font);color:var(--dim-2)", text: `· ${sub.role}` }),
          h("div", { class: "grow" }),
          chip(act.active ? "ACTIVE" : act.standby ? "READY" : sub.status, act.active ? "#F5A524" : act.standby ? "#34D399" : "#8b93a1"),
        ),
      );

      // ── purpose / personality ───────────────────────────────────────────────
      body.append(
        h("div", {
          style: "font:400 11.5px var(--font);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
          text: sub.soul.length > 0 ? sub.soul : "No personality recorded.",
        }),
      );

      // ── visual identity (from the KAI_VARIANT model) ─────────────────────────
      body.append(
        h(
          "div",
          { class: "row", style: "gap:6px;min-width:0" },
          dot(vis.secondary, 6),
          muted("identity"),
          h("span", {
            style: "font:400 10.5px var(--font);color:#8b93a1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
            text: vis.label,
          }),
        ),
      );

      // ── infrastructure: the worker, DEMOTED beneath the subagent ─────────────
      body.append(
        h(
          "div",
          { class: "row", style: "gap:6px" },
          muted("runs on"),
          h("span", { style: "font:500 10.5px var(--font);color:#8b93a1", text: sub.workerId }),
          dot(workerState === "working" ? "#3B9EFF" : workerState === "error" ? "#F4505E" : "#6b7280", 5),
          muted(workerState),
          ...(sub.model !== undefined ? [muted(`· ${sub.model}`)] : []),
          ...(act.active ? [chip(`approval ${act.approvalId ?? "parked"}`, "#F5A524")] : []),
        ),
      );

      // ── memory scope: the persona's own namespace ───────────────────────────
      body.append(
        h(
          "div",
          { class: "row", style: "gap:6px;min-width:0" },
          muted("memory scope"),
          h("span", {
            style: "font:400 10.5px var(--mono,#monospace);color:#8b93a1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
            text: sub.employeeId,
          }),
          ...(sub.capabilities.length > 0 ? [muted(`· ${sub.capabilities.join(", ")}`)] : []),
        ),
      );

      // ── its OWN sessions (never merged into KAI's conversation) ──────────────
      const sessionRows = h("div", { style: "display:flex;flex-direction:column;gap:3px;min-height:0" });
      if (sessions.length === 0) {
        sessionRows.append(muted("No sessions of its own yet."));
      } else {
        for (const s of sessions.slice(0, 3)) {
          sessionRows.append(
            h(
              "div",
              { class: "row", style: "gap:6px;min-width:0" },
              dot(s.status === "ACTIVE" ? "#34D399" : "#8b93a1", 6),
              h("span", {
                style: "font:400 11px var(--font);color:var(--dim-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
                text: s.title,
              }),
              muted(s.turnCount !== undefined ? `${s.turnCount} turn(s)` : s.status.toLowerCase()),
            ),
          );
        }
        if (sessions.length > 3) sessionRows.append(muted(`+${sessions.length - 3} more`));
      }
      body.append(sessionRows);

      // ── actions ─────────────────────────────────────────────────────────────
      body.append(
        h(
          "div",
          { class: "actions", style: "gap:8px;margin-top:2px" },
          h("button", {
            class: "btn secondary",
            text: "Back to KAI",
            onclick: () => actions.setView(State.defaultView()),
          }),
          h("button", {
            class: "btn primary",
            text: "Run a task",
            onclick: () => {
              // The run is EXTERNAL: it parks for approval, which then lights this
              // persona as ACTIVE. The task text is a plain default the user can
              // change by asking KAI directly.
              requestSubagentRun(sub.id, `Run ${sub.name}'s next task.`);
            },
          }),
        ),
      );
    },
  };
}

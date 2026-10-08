// The island's COMPANION HEADER.
//
// The island is a companion, not the application. Its chrome is therefore a
// STATUS line and exactly ONE primary action — **Open KAI** — which reveals and
// focuses the main KAI surface. There are no tabs, no session list, no agent
// management, no MCP management, no settings panel and no chat here: those are
// the main window's job (see docs/KAI_UI_RESET_PLAN.md). The island renders a
// mirror of Core, it does not manage it.
//
// The two remaining buttons are pure WINDOW controls, and they are the two the
// owner named, made deliberately distinct:
//
//   "–"  COLLAPSE  → the placement FSM's `petit` (the compact bar). The window
//                    stays on screen as the small pill; click it to reopen. This
//                    reuses the already-proven hide FSM rather than inventing a
//                    second one.
//   "✕"  CLOSE     → the proven `close_island` path: the WINDOW is hidden and the
//                    island is gone from the screen. KAI's runtime — Core, the
//                    pollers, the hooks — is untouched. Reopen from the tray.
//
// The progress strip is honest: it is visible only while the RUNTIME state
// machine reports KAI genuinely active (a REAL event put it there), and it is
// indeterminate because KAI does not publish a percentage. Nothing here invents
// work or runs a timer of its own.

import { h } from "../views/dom";
import { State } from "../core/state";
import { botGlowColor } from "../core/layout";
import type { KaiRuntimeState } from "../core/runtime-state";

export interface CompanionHeaderActions {
  /** The ONE primary action: reveal and focus the main KAI surface. */
  openKai(): void;
  /** Collapse to the compact bar (placement FSM `petit`). */
  collapse(): void;
  /** Close the island window (KAI keeps running). */
  close(): void;
  /** Hand the window move to the OS. */
  drag(): void;
  /** A soft tick when a control is used. */
  blip(): void;
}

export interface CompanionHeader {
  el: HTMLElement;
  sync(): void;
}

/**
 * Runtime states that mean KAI is actively doing something *right now*. Every one
 * is entered by a real event (see `core/runtime-state.ts`); the terminal
 * (SUCCESS/ERROR), resting (IDLE/LISTENING) and waiting (WAITING /
 * WAITING_APPROVAL / NEEDS_USER / OFFLINE) states are not "progress".
 */
const ACTIVE: ReadonlySet<KaiRuntimeState> = new Set<KaiRuntimeState>([
  "THINKING",
  "PLANNING",
  "RESEARCHING",
  "BROWSING",
  "CODING",
  "WORKING",
  "USING_TOOL",
  "USING_CLI",
  "USING_BROWSER",
  "USING_CUA",
  "DELEGATING",
  "MULTI_AGENT",
  "LEARNING",
  "BUILDING_SKILL",
  "RECOVERING",
]);

const STYLE_ID = "kai-companion-style";

/** Installs the (tiny, uniquely-named) animation for the progress strip, once. */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    "@keyframes kai-progress-sweep{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}} " +
    ".kai-progress-fill{animation:kai-progress-sweep 1.15s linear infinite}";
  document.head.append(style);
}

const WINDOW_BUTTON =
  "flex:0 0 auto;border:0;border-radius:6px;padding:0;line-height:1;cursor:pointer;" +
  "width:22px;height:22px;font:600 11px ui-sans-serif,system-ui;color:rgba(255,255,255,.72);" +
  "background:rgba(255,255,255,.10)";

export function buildCompanionHeader(actions: CompanionHeaderActions): CompanionHeader {
  ensureStyle();

  const dot = h("span", {
    id: "kai-status-dot",
    style: "width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#8b93a1",
  });
  const label = h("span", {
    id: "kai-status-label",
    style:
      "font:500 11.5px var(--font);color:#c5c8cd;min-width:0;overflow:hidden;" +
      "text-overflow:ellipsis;white-space:nowrap",
  });
  const status = h(
    "div",
    { style: "display:flex;align-items:center;gap:7px;flex:1 1 auto;min-width:0;padding-left:14px" },
    dot,
    label,
  );

  // ── the ONE primary action ──────────────────────────────────────────────────
  const openBtn = h("button", {
    id: "kai-open",
    title: "Open KAI in the main window",
    text: "Open KAI",
    style:
      "flex:0 0 auto;border:0;cursor:pointer;font:600 11px ui-sans-serif,system-ui;" +
      "color:#0b0d12;background:#3B9EFF;padding:5px 11px;border-radius:8px",
  });
  openBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.blip();
    actions.openKai();
  });

  // ── window controls (move / collapse / close) ───────────────────────────────
  const grip = h("div", {
    id: "island-grip",
    title: "Drag to move KAI",
    text: "⠿",
    style:
      "width:22px;height:22px;display:flex;align-items:center;justify-content:center;" +
      "font:12px ui-sans-serif,system-ui;color:rgba(255,255,255,.55);cursor:grab;" +
      "background:rgba(255,255,255,.10);border-radius:6px;user-select:none",
  });
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    actions.drag();
  });

  const collapseBtn = h("button", {
    id: "island-hide",
    title: "Collapse KAI to the compact bar",
    text: "–",
    style: WINDOW_BUTTON,
  });
  collapseBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  collapseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.blip();
    actions.collapse();
  });

  const closeBtn = h("button", {
    id: "island-close",
    title: "Close the island (KAI keeps running)",
    text: "✕",
    style: WINDOW_BUTTON,
  });
  closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.close();
  });

  const controls = h(
    "div",
    { style: "display:flex;align-items:center;gap:6px;flex:0 0 auto;padding-right:10px" },
    openBtn,
    grip,
    collapseBtn,
    closeBtn,
  );

  // ── the honest progress strip (indeterminate, active-only) ───────────────────
  const progressFill = h("div", {
    class: "kai-progress-fill",
    style:
      "width:34%;height:100%;background:linear-gradient(90deg," +
      "rgba(59,158,255,0),#3B9EFF,rgba(59,158,255,0))",
  });
  const progress = h(
    "div",
    {
      id: "kai-progress",
      style:
        "position:absolute;left:0;right:0;bottom:0;height:2px;overflow:hidden;" +
        "display:none;border-radius:2px;background:rgba(255,255,255,.06)",
    },
    progressFill,
  );

  const el = h("div", { id: "header", style: "position:relative" }, status, controls, progress);

  let lastKey = "";

  return {
    el,
    sync() {
      const offline = State.runtime === "OFFLINE" || State.core.conn === "OFFLINE";
      const text = offline ? "KAI Core is offline — reconnecting…" : State.runtimeLabel;
      const color = offline ? "#F4505E" : botGlowColor(State.effectiveState);
      const active = !offline && ACTIVE.has(State.runtime);
      const key = `${text}|${color}|${active ? 1 : 0}`;
      if (key === lastKey) return;
      lastKey = key;
      label.textContent = text;
      dot.style.background = color;
      progress.style.display = active ? "block" : "none";
    },
  };
}

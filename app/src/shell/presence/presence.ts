// The owner's reference design (docs/design/kai-presence-v2.html) as the REAL
// KAI main interface.
//
// LOOK & INTERACTION MODEL: kept exactly — the rail, the orb and its moods, the
// composer with mode segments and the abilities popover, the command palette,
// the details drawer with its three tabs, the plan/thinking/tool/approval/summary
// card shapes, the status bar, the agent grid and the tool rows.
//
// WHAT IS DIFFERENT: every hardcoded array (TOOLS / MCPS / AGENTS) and the
// scripted `run()` are gone. Nothing in this file invents work. Every value a
// person sees comes from a real KAI Core call:
//   GET  /tools              every registered tool, described (workspace routes)
//   GET  /mcp                the measured MCP capability + live catalogue
//   GET  /subagents          KAI's personas (via the agents api, with activity)
//   GET  /sessions           the conversation list; /sessions/:id/turns history
//   POST /chat               a real turn; the reply is Core's, not a facsimile
//   GET  /core/events (SSE)  the real event stream, folded into the thread
//   GET  /approvals?…        real approvals; POST /approvals/:id/decide decides
//   GET  /state, /maintenance/status   real health + identity
//
// The orb's mood is driven by the same event-driven runtime machine the island
// uses (see presence/mood.ts), never a timer.

import "./presence.css";
import type { ShellContext, ShellPage } from "../types";
import { ROUTES, parseRoute, routeHash, type RouteId } from "../routes";
import type { WorkspaceEventRow } from "../../workspace";
import type { ToolDescription, McpServerSummary } from "../../workspace/types";
import { describeTool } from "../../views/tools";
import { serverStatus, serverTarget, credentialKeys } from "../../views/mcp";
import { ACTIVITY_GROUPS, filterActivity, groupColor, relativeTime, type ActivityGroup } from "../../views/activity";
import { createOrb, setOrbMood, boop, mountOrbParallax, MOOD_LABELS, MOOD_ORDER, type Mood } from "./orb";
import { MoodDriver } from "./mood";
import { createAgentApi, type Subagent } from "../../agents/api";
import { createSessionRoutes } from "../../chat/session-routes";
import { sessionDisplayTitle } from "../../chat/title";
import { describeToolCall, describeToolActivity } from "../../chat/tool-card";
import type {
  CoreBenchEntry,
  CoreError,
  CoreOrchestrationPrefs,
  CoreSessionSummary,
  CoreToolCall,
  CoreWorkerHealth,
  CoreWorkItemSummary,
} from "../../core/kai-core";
import { conversationVisible } from "./conversation";
import {
  createLiveAssistant,
  installCodeCopy,
  previewCardValue,
  renderAssistantStatic,
  type LiveAssistant,
} from "../../chat/render-assistant";
import { createPalette, type PaletteHandle } from "../commands/palette";
import type { CommandContext } from "../commands/registry";
import { readMode, writeMode, type ModeId } from "../modes";

// ── tiny DOM helpers (the design's `$`/`h`) ──────────────────────────────────

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | undefined> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === undefined || c === null) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/**
 * REMOVED: `skillsFromCore` read `GET /skills` over a raw fetch because the
 * client had no `skills()` method. The typed client now owns that route
 * (`client.skills()` + `stagedSkills()`), so the raw bypass is deleted rather
 * than left as a second, untyped reader.
 */

/** The design's `ic()` icon set (20×20), plus a few KAI section glyphs. */
const IC: Record<string, string> = {
  files: '<path d="M3 6.500a1.500 1.500 0 0 1 1.500-1.500h3l1.500 2h6.500A1.500 1.500 0 0 1 17 8.500v6A1.500 1.500 0 0 1 15.500 16h-11A1.500 1.500 0 0 1 3 14.500z"/>',
  term: '<rect x="2.500" y="4" width="15" height="12" rx="2"/><path d="M6 8.500l2.500 2L6 12.500M10.500 12.500h3.500"/>',
  git: '<circle cx="6" cy="5" r="1.800"/><circle cx="6" cy="15" r="1.800"/><circle cx="14" cy="9" r="1.800"/><path d="M6 6.800v6.400M7.800 9h4.400"/>',
  web: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2.200 2.200 2.200 11.800 0 14M10 3c-2.200 2.200-2.200 11.800 0 14"/>',
  browser: '<rect x="2.500" y="3.500" width="15" height="13" rx="2"/><path d="M2.500 7.500h15"/>',
  plug: '<path d="M7 3v4M13 3v4M5 7h10v3.500a5 5 0 0 1-10 0zM10 15.500V18"/>',
  mcp: '<rect x="4" y="2.800" width="12" height="5" rx="1.200"/><rect x="4" y="12.200" width="12" height="5" rx="1.200"/><path d="M6.800 5.300h.010M6.800 14.700h.010"/>',
  agent: '<circle cx="10" cy="8" r="3.200"/><path d="M4 17c.6-3 3-4.500 6-4.500s5.400 1.500 6 4.500"/>',
  warn: '<path d="M10 3l7.500 13h-15zM10 8.500v3.500M10 14.500h.01"/>',
  chat: '<path d="M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3a2 2 0 0 1-2-2z"/>',
  home: '<path d="M3 9l7-6 7 6v7.5a1 1 0 0 1-1 1h-4v-5h-4v5H4a1 1 0 0 1-1-1z"/>',
  sessions: '<rect x="3" y="3.5" width="14" height="13" rx="2"/><path d="M6 7.5h8M6 10.5h8M6 13.5h5"/>',
  missions: '<path d="M10 2.5l6 3v5c0 3.2-2.4 6-6 7-3.6-1-6-3.8-6-7v-5z"/>',
  workers: '<circle cx="10" cy="10" r="3"/><path d="M10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18"/>',
  activity: '<path d="M2 11h3l2-6 3 12 3-9 2 3h3"/>',
  memory: '<path d="M10 3a4 4 0 0 0-4 4v1a3 3 0 0 0 0 6 3 3 0 0 0 4 2.8M10 3a4 4 0 0 1 4 4v1a3 3 0 0 1 0 6 3 3 0 0 1-4 2.8M10 3v13"/>',
  skills: '<path d="M10 2.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 7.8l5-.7z"/>',
  settings: '<circle cx="10" cy="10" r="2.600"/><path d="M10 2v2.200M10 15.800V18M2 10h2.200M15.800 10H18M4.300 4.300l1.600 1.600M14.100 14.100l1.600 1.600M15.700 4.300l-1.600 1.600M5.900 14.100l-1.600 1.600"/>',
};

/** The permanent nav rail — deliberately minimal (everything else is contextual). */
const RAIL_ROUTE_IDS: readonly RouteId[] = ["chat", "sessions", "agents", "settings"];

const ROUTE_ICON: Record<RouteId, string> = {
  home: "home", chat: "chat", sessions: "sessions", missions: "missions", agents: "agent",
  workers: "workers", tools: "plug", mcp: "mcp", activity: "activity", memory: "memory",
  skills: "skills", settings: "settings",
};

function icon(name: string): string {
  return `<svg class="i" viewBox="0 0 20 20">${IC[name] ?? IC.plug}</svg>`;
}

function hexToHue(hex: string | undefined): number | null {
  if (hex === undefined) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let hh = 0;
  if (max === r) hh = ((g - b) / d) % 6;
  else if (max === g) hh = (b - r) / d + 2;
  else hh = (r - g) / d + 4;
  return Math.round(hh * 60);
}

/** A hex colour declared by a subagent's visual, or a stable fallback from its id. */
function agentHue(a: Subagent, index: number): number {
  const declared = a.visual?.declared as Record<string, unknown> | undefined;
  const colour = declared !== undefined && typeof declared["colour"] === "string" ? (declared["colour"] as string) : undefined;
  return hexToHue(colour) ?? (index * 47) % 360;
}

// ── The application ──────────────────────────────────────────────────────────

export function mountPresence(root: HTMLElement, ctx: ShellContext): ShellPage {
  const { client, workspace } = ctx;
  // Same Core the rest of the shell talks to — never a hardcoded port.
  const agentApi = createAgentApi({ baseUrl: client.baseUrl });

  const app = h("div", { class: "app", id: "kp-app" });
  const rail = h("nav", { class: "rail", "aria-label": "Main" });
  const railOrb = createOrb({ mood: "idle", fx: false, size: 36, title: "Say hi to KAI" });
  rail.append(railOrb);
  const navButtons = new Map<RouteId, HTMLElement>();
  // The permanent rail is deliberately SMALL (operator §21/§54): KAI, Sessions,
  // Agents, Settings. Every other surface stays a real route, reachable by
  // command (`/tools`, `/bench`, `/activity`, …), the Ctrl+K palette (nav.*),
  // or a deep link — never a permanent tab.
  for (const route of ROUTES.filter((r) => RAIL_ROUTE_IDS.includes(r.id))) {
    const badge = h("span", { class: "n" });
    badge.hidden = true;
    const btn = h("button", { class: "rb", type: "button", "aria-label": route.label, title: route.label, html: icon(ROUTE_ICON[route.id]) + '<span class="n" hidden></span>' });
    btn.dataset.route = route.id;
    (btn.querySelector(".n") as HTMLElement).style.setProperty("--accent", route.accent);
    btn.addEventListener("click", () => show(route.id));
    navButtons.set(route.id, btn);
    rail.append(btn);
  }
  const sp = h("span", { class: "sp" });
  const labRail = h("button", { class: "rb", type: "button", "aria-label": "Feelings", html: icon("agent") });
  labRail.addEventListener("click", () => { show("chat"); lab.classList.toggle("on"); });
  rail.append(sp, labRail);

  const main = h("main", { class: "main" });

  // ── overlays / lab / drawer / status ─────────────────────────────────────
  const lab = h("div", { class: "lab", id: "kp-lab" });
  const fg = h("div", { class: "fg" });
  lab.append(h("h4", { text: "KAI's feelings" }), h("p", { text: "KAI reacts to what really happens. Tap one to preview it." }), fg);

  const drawer = h("aside", { class: "dr", "aria-label": "Details" });
  const drawerBadge = h("span", { class: "badge", text: "0" });
  const tabButtons: Record<string, HTMLElement> = {};
  const tabs = h("div", { class: "tabs", role: "tablist" });
  for (const [id, label] of [["act", "Activity"], ["agt", "Agents"], ["core", "Core"]] as const) {
    const b = h("button", { role: "tab", "aria-selected": "false", text: label });
    b.dataset.t = id;
    b.addEventListener("click", () => drTab(id));
    tabButtons[id] = b;
    tabs.append(b);
  }
  const dpAct = h("div", { class: "dp", id: "kp-dp-act" });
  const dpAgt = h("div", { class: "dp", id: "kp-dp-agt" });
  const dpCore = h("div", { class: "dp", id: "kp-dp-core" });
  const dfoot = h("div", { class: "dfoot" });
  dfoot.style.display = "none";
  drawer.append(h("div", { class: "dr-in" }, tabs, dpAct, dpAgt, dpCore, dfoot));

  const statusBar = h("footer", { class: "sb", id: "kp-sb" });

  const toasts = h("div", { class: "toasts" });

  // The command palette is the REAL registry palette (`shell/commands`), not
  // the old hardcoded list: it is instantiated with the live context once the
  // actions it dispatches are in scope (see the palette section below), and
  // its element joins the shell there.
  let paletteHandle: PaletteHandle | null = null;

  const modalOv = h("div", { class: "ov", id: "kp-mov" });
  const modal = h("div", { class: "modal", role: "dialog" });
  modalOv.append(modal);

  app.append(rail, main, drawer, statusBar);
  const shell = h("div", { id: "kai-presence-root" }, app, lab, modalOv, toasts);
  root.append(shell);

  // ── shared state ──────────────────────────────────────────────────────────
  const moods = new MoodDriver(workspace);
  let view: RouteId = "chat";
  let currentMood: Mood = "idle";
  let moodLockUntil = 0;
  let busy = false;
  /** The live turn's abort handle — the composer Stop control drives it. */
  let activeAbort: AbortController | null = null;
  /** True once the user pressed Stop this turn, so the settle path is honest. */
  let stopRequested = false;

  // Operator workspace chrome, assigned by buildChat (created lazily so the
  // status painters can run before the chat surface mounts).
  let statePills: HTMLElement | undefined;
  let actStrip: HTMLElement | undefined;
  /** True while a streamed turn owns the thread DOM — blocks renderTurns wipes. */
  let streamLive = false;

  let tools: ToolDescription[] = [];
  let mcpServers: McpServerSummary[] = [];
  let mcpCapability = { availability: "UNAVAILABLE", detail: "" };
  let agents: Subagent[] = [];
  let approvals: { id: string; toolId: string; action: string; reason: string; risk: string }[] = [];
  let sessions: CoreSessionSummary[] = [];
  let identity: { buildId?: string; pid?: number; uptimeMs?: number } = {};

  // ── orchestration display prefs (cached) ─────────────────────────────────
  // The visibility half of GET /settings' orchestration block, cached in this
  // module. Refreshed on prime() and after an autonomy save; every surface
  // below reads this copy instead of fetching per render.
  interface OrchPrefs {
    activity: "OFF" | "COMPACT" | "VERBOSE";
    toolsView: "COLLAPSED" | "EXPANDED";
    agentsView: "COMPACT" | "DETAILED";
  }
  let orchPrefs: OrchPrefs = { activity: "COMPACT", toolsView: "COLLAPSED", agentsView: "COMPACT" };

  /** Normalize the orchestration block into editable effective values. */
  function readOrchEff(orch: CoreOrchestrationPrefs): {
    level: number; workerAuto: string; review: string; skillLearning: string;
    activity: string; reasoning: string; toolsView: string; agentsView: string;
    maxDepth: number; maxParallel: number; maxRetries: number; retention: number;
  } {
    const auto = orch.autonomy ?? {};
    const pickStr = (v: unknown, allowed: string[], fallback: string): string =>
      typeof v === "string" && allowed.includes(v) ? v : fallback;
    const pickInt = (v: unknown, min: number, max: number, fallback: number): number => {
      const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
      return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
    };
    const budgets =
      auto.budgets !== null && typeof auto.budgets === "object" && !Array.isArray(auto.budgets)
        ? (auto.budgets as Record<string, unknown>)
        : undefined;
    return {
      level: pickInt(auto.level, 0, 4, 2),
      workerAuto: pickStr(auto.workerAuto, ["AUTO", "ASK", "OFF"], "ASK"),
      review: pickStr(auto.review, ["AUTO", "ASK", "OFF"], "ASK"),
      skillLearning: pickStr(auto.skillLearning, ["OFF", "PROPOSE", "AUTO_SAFE"], "PROPOSE"),
      activity: pickStr(orch.activity, ["OFF", "COMPACT", "VERBOSE"], "COMPACT"),
      reasoning: pickStr(orch.reasoning, ["HIDDEN", "SUMMARY", "PROVIDER_EXPOSED"], "SUMMARY"),
      toolsView: pickStr(orch.toolsView, ["COLLAPSED", "EXPANDED"], "COLLAPSED"),
      agentsView: pickStr(orch.agentsView, ["COMPACT", "DETAILED"], "COMPACT"),
      maxDepth: pickInt(auto.maxDepth ?? budgets?.maxDepth, 1, 5, 2),
      maxParallel: pickInt(auto.maxParallel, 1, 10, 3),
      maxRetries: pickInt(auto.maxRetries ?? budgets?.maxRetries, 0, 5, 2),
      retention: pickInt(auto.taskRetentionDays, 1, 365, 30),
    };
  }

  async function refreshOrchPrefs(): Promise<void> {
    const res = await client.getSettings();
    if (!res.ok || res.value.orchestration === undefined) return;
    const eff = readOrchEff(res.value.orchestration);
    orchPrefs = {
      activity: eff.activity as OrchPrefs["activity"],
      toolsView: eff.toolsView as OrchPrefs["toolsView"],
      agentsView: eff.agentsView as OrchPrefs["agentsView"],
    };
  }

  // ── mood surface ──────────────────────────────────────────────────────────
  const orbs = { hero: createOrb({ mood: "idle", fx: true, title: "KAI" }), who: createOrb({ mood: "idle", fx: true }), rail: railOrb };
  function paintMood(mood: Mood, label?: string): void {
    currentMood = mood;
    shell.dataset.mood = mood;
    for (const o of [orbs.hero, orbs.who, orbs.rail]) setOrbMood(o, mood);
    const moodLabelEl = shell.querySelector<HTMLElement>("#kp-mood-l");
    if (moodLabelEl !== null) moodLabelEl.textContent = label ?? MOOD_LABELS[mood];
    paintStatus();
  }
  function flashPreview(mood: Mood, ms = 4200): void {
    if (busy) return;
    moodLockUntil = Date.now() + ms;
    paintMood(mood);
    window.setTimeout(() => { if (!busy && currentMood === mood && Date.now() >= moodLockUntil) paintMood("idle"); }, ms);
  }
  moods.subscribe((s) => {
    if (Date.now() < moodLockUntil) return;
    paintMood(s.mood);
  });

  // ── rail / view switching ─────────────────────────────────────────────────
  /** Re-read the Workers bench. Assigned by buildLists; no-op until built. */
  let refreshWorkersBench: () => void = () => {};
  /** Re-read the Missions list. Assigned by buildLists; no-op until built. */
  let refreshMissions: () => void = () => {};
  const views = new Map<RouteId, HTMLElement>();
  function buildViews(): void {
    for (const route of ROUTES) {
      const v = h("section", { class: "view", id: `kp-v-${route.id}` });
      v.dataset.route = route.id;
      views.set(route.id, v);
      main.append(v);
    }
    main.append(lab);
    buildChat(views.get("chat")!);
    buildAgents(views.get("agents")!);
    buildTools(views.get("tools")!, true);
    buildTools(views.get("mcp")!, false);
    buildActivity(views.get("activity")!);
    buildSessions(views.get("sessions")!);
    buildOverview(views.get("home")!);
    // `buildLists` is primed by `prime()` (called immediately after `buildViews`)
    // so the list pages share ONE re-runnable primer with the rest of the app.
  }

  function show(route: RouteId): void {
    view = route;
    for (const [id, v] of views) v.classList.toggle("on", id === route);
    for (const [id, b] of navButtons) b.classList.toggle("on", id === route);
    // The shell's route state and the location hash follow the REAL view —
    // `getRoute()` reports this, and a hash is a deep link, not decoration.
    ctx.navigate(route);
    const hash = routeHash(route);
    if (window.location.hash !== hash) window.location.hash = hash;
    if (route === "agents") void loadAgents();
    if (route === "tools" || route === "mcp") void loadTools();
    if (route === "sessions") void loadSessions();
    if (route === "workers") refreshWorkersBench();
    if (route === "missions") refreshMissions();
  }

  /** Back/forward buttons move the real view, not just the URL. */
  function onHashChange(): void {
    const routed = parseRoute(window.location.hash);
    if (routed !== view) show(routed);
  }
  window.addEventListener("hashchange", onHashChange);

  // ── toast ─────────────────────────────────────────────────────────────────
  function toast(text: string, kind?: "ok" | "err"): void {
    const el = h("div", { class: "toast", html: `<span>${kind === "err" ? "⚠" : kind === "ok" ? "✓" : "•"}</span>${esc(text)}` });
    toasts.append(el);
    window.setTimeout(() => { el.classList.add("out"); window.setTimeout(() => el.remove(), 450); }, 3200);
  }

  // ══ CHAT ══════════════════════════════════════════════════════════════════
  interface Turn {
    id: number;
    role: "user" | "assistant";
    text: string;
    /** Core's persisted tool calls for this turn — rendered as cards, never invented. */
    tools?: CoreToolCall[];
  }
  let chatSeq = 1;
  let turns: Turn[] = [];
  let activeSession: CoreSessionSummary | null = null;
  let loadedSessionId: string | null = null;
  let firstUserText: string | undefined;
  let turnCardHost: HTMLElement | null = null;
  let threadCol: HTMLElement;
  let threadEl: HTMLElement;
  let chatInput: HTMLTextAreaElement;

  // ── Scroll manager (mountPresence scope so every timeline writer shares
  // it): follow-tail ONLY while the user is already near the bottom. Stream
  // appends never smooth-scroll (a queued smooth animation per delta is pure
  // jank); at most one instant jump per frame. Scrolled away → a Jump control
  // appears and nothing yanks the view.
  const reducedMotion = (): boolean =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function nearBottom(px = 96): boolean {
    if (threadEl === undefined) return true;
    return threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < px;
  }
  let followQueued = false;
  function requestFollow(): void {
    if (threadEl === undefined || !nearBottom()) return;
    if (followQueued) return;
    followQueued = true;
    const jump = (): void => {
      followQueued = false;
      // Instant during a stream (smooth would queue an animation per chunk);
      // smooth only for the explicit user-initiated jump below.
      threadEl.scrollTop = threadEl.scrollHeight;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(jump);
    else jump();
  }
  /** Thread chrome that needs the built thread: Jump-to-latest control. */
  function initThreadChrome(): void {
    const jumpBtn = h("button", { class: "jump", type: "button", text: "↓ latest", hidden: true });
    jumpBtn.addEventListener("click", () => {
      threadEl.scrollTo({ top: threadEl.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
    });
    threadEl.append(jumpBtn);
    threadEl.addEventListener("scroll", () => {
      jumpBtn.hidden = nearBottom();
    }, { passive: true });
  }

  function buildChat(v: HTMLElement): void {
    const proj = h("div", { class: "proj" }, h("span", { class: "mono", text: "KAI" }), h("small", { id: "kp-proj-sub", text: "no session yet" }));
    // Operator identity: the REAL KAI character engine (orbs.who) is the main
    // character, with KAI's live mood as the state line (operator §4/§12/§15).
    const who = h("div", { class: "who" }, orbs.who, h("div", { class: "who-id" },
      h("div", { class: "who-name" }, h("b", { text: "KAI" }), h("span", { class: "who-role", text: "// AUTONOMOUS OPERATOR" })),
      h("div", { class: "who-state" }, h("span", { id: "kp-mood-l", text: MOOD_LABELS.idle })),
    ));
    statePills = h("div", { class: "opstate", id: "kp-opstate" });
    const labBtn = h("button", { class: "pill", type: "button", text: "Feelings" });
    labBtn.addEventListener("click", () => lab.classList.toggle("on"));
    const palBtn = h("button", { class: "pill", type: "button", html: 'Commands <kbd>Ctrl K</kbd>' });
    palBtn.addEventListener("click", openPalette);
    // Theme is real propagated state (ThemeController on the document root),
    // not a preview: Light -> Dark -> System.
    const themeBtn = h("button", { class: "pill", type: "button", text: "Theme" });
    themeBtn.addEventListener("click", () => {
      if (ctx.theme === undefined) {
        toast("Theme control is unavailable in this host", "err");
        return;
      }
      const next = ctx.theme.cycle();
      toast(`Theme: ${next}`, "ok");
    });
    const drBtn = h("button", { class: "pill", type: "button" }, h("span", { text: "Details " }), drawerBadge);
    drBtn.addEventListener("click", () => app.classList.toggle("drawer"));
    const top = h("header", { class: "top op" }, proj, who, statePills, h("div", { class: "topr" }, labBtn, themeBtn, palBtn, drBtn));

    // Live activity strip: the operator's execution stream. Real events only,
    // appended as they arrive (operator §8/§22) — never a post-hoc dump.
    actStrip = h("div", { class: "actstrip", id: "kp-actstrip" });
    threadCol = h("div", { class: "col" });
    threadEl = h("section", { class: "thread" }, threadCol);

    // Code-copy for every `.md-copy` button the rich renderer emits, live or
    // settled: exactly one delegated listener for the whole thread.
    installCodeCopy(threadCol, toast);
    initThreadChrome();

    const hero = h("div", { class: "hero" }, h("div", { class: "float" }, orbs.hero), h("h1", { id: "kp-greet", text: greetTitle() }), h("p", { id: "kp-greet-s", text: greetSub() }));
    chatInput = h("textarea", { rows: "1", id: "kp-in", placeholder: "Describe a task, / for commands, @ for agents and skills" });
    const mention = h("div", { class: "pop mention", id: "kp-mention" });
    const slashPop = h("div", { class: "pop mention", id: "kp-slash" });
    const abBtn = h("button", { class: "tb", type: "button", "aria-haspopup": "true" }, h("span", { class: "dot", id: "kp-ab-dot" }), h("span", { id: "kp-ab-txt", text: "Abilities" }));
    const abpop = h("div", { class: "pop", id: "kp-abpop" });
    const modes = h("div", { class: "seg", role: "group", "aria-label": "Mode" });
    for (const [m, label] of [["ask", "Ask first"], ["plan", "Plan"], ["auto", "Auto"]] as const) {
      const b = h("button", { type: "button", text: label });
      b.dataset.m = m;
      // The segment is REAL persisted mode state (`shell/modes.ts`), not a
      // visual toggle: "Auto" runs the Work mode. Plan/Work execution lands
      // with plan/work mode; the selection is honoured from the first turn.
      b.addEventListener("click", () => setMode(m === "auto" ? "work" : m));
      modes.append(b);
    }
    paintModeSegment(readMode());
    const go = h("button", { class: "go", type: "button", "aria-label": "Send", html: '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>' });
    // Console chips: live targets + the operator commands, from the real
    // registries. Clicking inserts into the composer (never a dead chip).
    const opChips = h("div", { class: "opchips", id: "kp-opchips" });
    function chip(text: string): HTMLElement {
      const b = h("button", { class: "opchip", type: "button", text });
      b.addEventListener("click", () => {
        chatInput.value = chatInput.value.trim().length > 0 ? `${chatInput.value.trim()} ${text} ` : `${text} `;
        chatInput.focus();
      });
      return b;
    }
    opChips.append(chip("@"), chip("/work"), chip("/status"), chip("/bench"), chip("/abort"));
    const comp = h("div", { class: "comp" }, opChips, chatInput, h("div", { class: "crow" }, abBtn, modes, h("span", { class: "sp" }), go));
    const hintRow = h("div", { class: "ophint" },
      h("span", { html: "Press <kbd>Enter</kbd> to dispatch" }),
      h("span", { text: "·" }),
      h("span", { html: "<kbd>Ctrl K</kbd> command menu" }),
      h("span", { text: "·" }),
      h("span", { html: "<kbd>Ctrl ⇧ S</kbd> stop" }),
      h("span", { text: "·" }),
      h("span", { html: "<kbd>/</kbd> commands · <kbd>@</kbd> agents" }),
    );
    const cw = h("div", { class: "cw", id: "kp-cw" }, mention, slashPop, abpop, comp, hintRow);

    const chips = h("div", { class: "chips" });
    for (const c of ["What can you do?", "What are you working on right now?", "Show me my sessions"]) {
      const b = h("button", { type: "button", text: c });
      b.addEventListener("click", () => runTurn(c));
      chips.append(b);
    }
    const abil = h("div", { class: "abil", id: "kp-abil" });
    const stage = h("section", { class: "stage" }, hero, cw, chips, abil);

    v.append(top, actStrip, threadEl, stage);

    // Composer wiring.
    chatInput.addEventListener("input", () => {
      chatInput.style.height = "auto";
      chatInput.style.height = `${Math.min(160, chatInput.scrollHeight)}px`;
      moods.setComposing(chatInput.value.trim().length > 0 && !busy);
      const m = /(?:^|\s)@([\w-]*)$/.exec(chatInput.value);
      if (m !== null) {
        slashPop.classList.remove("on");
        mentionOpen(m[1] ?? "");
      } else {
        mention.classList.remove("on");
        slashOpen();
      }
    });
    chatInput.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      // The open `@` picker owns its keys first (arrows/Enter/Tab/Esc).
      if (mentionKey(ke)) return;
      if (slashKey(ke)) return;
      // Ctrl/Cmd+Shift+Enter = plan-only (operator §46): draft, run nothing.
      if (ke.key === "Enter" && (ke.ctrlKey || ke.metaKey) && ke.shiftKey) {
        ke.preventDefault();
        const text = chatInput.value.trim();
        if (text.length > 0) void runPlan(text);
        return;
      }
      // Enter (or Ctrl/Cmd+Enter) sends; Shift+Enter is a newline.
      if (ke.key === "Enter" && !ke.shiftKey) {
        ke.preventDefault();
        submit();
      }
      ke.stopPropagation();
    });
    chatInput.addEventListener("blur", () => moods.setComposing(false));
    go.addEventListener("click", () => submit());
    abBtn.addEventListener("click", (e) => { e.stopPropagation(); const p = abpop; if (p.classList.toggle("on")) abPaint(); });
    document.addEventListener("click", (e) => {
      const t = e.target as Node;
      if (!abpop.contains(t) && !abBtn.contains(t)) abpop.classList.remove("on");
      if (!lab.contains(t) && !labBtn.contains(t) && !labRail.contains(t)) lab.classList.remove("on");
    });
    document.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if ((ke.ctrlKey || ke.metaKey) && ke.key.toLowerCase() === "k") { ke.preventDefault(); openPalette(); }
      // Stop the active mission/run (operator §46): Ctrl/Cmd+Shift+S.
      if ((ke.ctrlKey || ke.metaKey) && ke.shiftKey && ke.key.toLowerCase() === "s") {
        ke.preventDefault();
        if (busy && activeAbort !== null) {
          stopRequested = true;
          activeAbort.abort();
          toast("Stopping…", "ok");
        }
      }
      if (ke.key === "Escape") { closePalette(); closeModal(); lab.classList.remove("on"); abpop.classList.remove("on"); mention.classList.remove("on"); }
    });
    orbs.hero.addEventListener("click", () => { if (!busy) { boop(orbs.hero); flashPreview("happy", 1800); } });
    railOrb.addEventListener("click", () => { if (!busy) { boop(railOrb); flashPreview("happy", 1800); } });

    renderAbil();
  }

  function greetTitle(): string {
    const hr = new Date().getHours();
    return hr < 5 ? "Still up? Let's build something." : hr < 12 ? "Good morning." : hr < 18 ? "Good afternoon." : "Good evening.";
  }
  function greetSub(): string {
    const hr = new Date().getHours();
    return hr < 5 ? "The quiet hours are good for deep work." : hr < 12 ? "What should we build today?" : hr < 18 ? "What are we building?" : "What are we building tonight?";
  }

  /**
   * A parked `@agent` run as an inline Allow/Refuse card. Allow re-issues the
   * exact parked run through the agent path with the approval id; the
   * persona-authored result lands as the next assistant bubble. Refuse rejects
   * the approval, so the work never runs.
   */
  function appendAgentRunCard(run: { subagentId: string; approvalId: string; reason: string }, task: string): void {
    const card = h("div", { class: "k" });
    const box = h("div", { class: "ask blk" });
    box.append(
      h("h4", { text: `Allow ${run.subagentId} to run this?` }),
      h("div", { class: "cmd", text: run.reason.slice(0, 300) }),
    );
    const btns = h("div", { class: "btns" });
    const allow = h("button", { class: "btn warn", type: "button", text: "Allow once" });
    const deny = h("button", { class: "btn", type: "button", text: "Refuse" });
    allow.addEventListener("click", () => {
      allow.textContent = "Running…";
      // The click IS the consent: record it (decide) before re-issuing, the
      // same order the /message handler uses. Re-issuing with a still-PENDING
      // id just mints a second approval and never executes.
      void client
        .decideApproval(run.approvalId, true)
        .then(() => agentApi.runSubagent(run.subagentId, task, run.approvalId))
        .then((res) => {
          if (!res.ok) {
            allow.textContent = "Allow once";
            toast(res.error.message, "err");
            return;
          }
          card.remove();
          if (res.value.kind === "reply") {
            const text = res.value.reply.length > 0 ? res.value.reply : `Run settled (${res.value.state}).`;
            const assistant: Turn = { id: chatSeq++, role: "assistant", text };
            turns.push(assistant);
            appendTurn(assistant);
          } else {
            toast("Run parked again — answer it in Approvals", "ok");
            void refreshApprovals();
          }
          void refreshActive();
        });
    });
    deny.addEventListener("click", () => {
      void client.decideApproval(run.approvalId, false).then(() => {
        card.remove();
        toast("Run refused — it will not execute", "ok");
      });
    });
    btns.append(allow, deny);
    box.append(btns);
    card.append(box);
    threadCol.append(card);
    requestFollow();
  }

  /**
   * Collapse a settled turn's SUCCESSFUL tool cards into one expandable
   * execution block ("Executed 4 tools · …"). Waiting (`…`) and failed (`✕`)
   * cards stay open in place — an approval or an error must never hide inside
   * a collapsed block. Approval cards (`.ask`) are a different shape and are
   * never touched here.
   */
  function collapseTurnTools(host: HTMLElement): void {
    // Display pref: EXPANDED leaves every tool card open.
    if (orchPrefs.toolsView === "EXPANDED") return;
    const cards = Array.from(host.querySelectorAll("details.tc"));
    if (cards.length === 0) return;
    const settled: HTMLElement[] = [];
    const names: string[] = [];
    for (const card of cards) {
      const summary = card.querySelector("summary")?.textContent ?? "";
      if (summary.includes("…") || summary.includes("✕")) continue;
      settled.push(card as HTMLElement);
      const name = card.querySelector("summary b")?.textContent?.replace(/^✓\s*/, "").trim() ?? "";
      if (name.length > 0) names.push(name);
    }
    if (settled.length === 0) return;
    const first = settled[0]!;
    const wrap = h("details", { class: "tex blk" });
    const summary = h("summary");
    const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ` (+${names.length - 4} more)` : "");
    summary.textContent = `⚙ Executed ${settled.length} tool${settled.length === 1 ? "" : "s"}${shown.length > 0 ? ` · ${shown}` : ""}`;
    wrap.append(summary);
    // Swap FIRST, while the wrapper is still empty: moving a card into the
    // wrapper reparents it, and replacing an element with a wrapper that
    // already contains it is a DOM hierarchy error.
    first.replaceWith(wrap);
    for (const card of settled) wrap.append(card);
  }

  /**
   * One tool call as a thread card, in the event-card shape — WITH its real
   * content. The summary names the tool + status; the body carries the actual
   * bounded result (the live wire preview when streaming, a clipped preview
   * of the persisted value for history), the error, the approval, and the
   * duration. Raw payloads stay collapsed; useful details are inspectable.
   */
  function toolCard(t: {
    toolName: string;
    toolId?: string;
    status: string;
    arguments?: string;
    /** Persisted raw value (history path). */
    result?: unknown;
    /** Live bounded redacted preview (stream path). Wins over `result`. */
    resultPreview?: string;
    resultTruncated?: boolean;
    error?: { code: string; message: string };
    approvalId?: string;
    startedAt?: string;
    completedAt?: string;
  }): HTMLElement {
    const described = describeToolCall({ ...t, arguments: t.arguments ?? "" });
    const el = h("details", { class: "tc blk" });
    const summary = h("summary");
    summary.innerHTML =
      `<span class="ti">${icon("plug")}</span><b>${esc(described.glyph)} ${esc(described.name)}</b>` +
      `<code>${esc(described.status)}${described.detail !== "" ? ` · ${esc(described.detail)}` : ""}</code>`;
    el.append(summary);
    const body = h("div", { class: "tbody" });
    if (t.arguments !== undefined && t.arguments !== "") {
      const args = t.arguments.length > 500 ? `${t.arguments.slice(0, 500)}…` : t.arguments;
      body.append(h("div", { class: "targs" }, h("code", { text: args })));
    }
    if (t.error !== undefined) {
      body.append(h("div", { class: "terr" }, h("code", { text: t.error.code }), h("span", { text: ` ${t.error.message}` })));
    }
    if (t.approvalId !== undefined) {
      body.append(h("div", { class: "t appr" }, h("span", { text: `waiting on approval ${t.approvalId}` })));
    }
    // Live preview first (already redacted + bounded by Core); history falls
    // back to a clipped preview of the persisted value with honest truncation.
    const live = t.resultPreview !== undefined ? { text: t.resultPreview, truncated: t.resultTruncated === true } : undefined;
    const shown = live ?? previewCardValue(t.result);
    if (shown.text !== undefined) {
      body.append(h("pre", { class: "tout", text: shown.text }));
      if (shown.truncated) body.append(h("div", { class: "ttrunc", text: "truncated — full value retained server-side" }));
      const copy = h("button", { class: "mini", type: "button", text: "Copy" });
      copy.addEventListener("click", () => {
        void navigator.clipboard?.writeText(shown.text ?? "").then(
          () => toast("Copied", "ok"),
          () => toast("Copy failed", "err"),
        );
      });
      body.append(copy);
    }
    if (t.startedAt !== undefined && t.completedAt !== undefined) {
      const ms = Date.parse(t.completedAt) - Date.parse(t.startedAt);
      if (Number.isFinite(ms) && ms >= 0) body.append(h("div", { class: "tdur", text: `${ms}ms` }));
    }
    if (body.childElementCount > 0) el.append(body);
    return el;
  }

  function bubbleTurn(t: Turn): HTMLElement {
    if (t.role === "user") {
      const wrap = h("div", { class: "u fade" });
      wrap.append(h("span", { text: t.text }));
      // Edit INPUT (operator §30): refill the composer with this turn's text so
      // the user can revise and resend. Completed history is never mutated —
      // resending creates a new turn, so the transcript stays honest.
      const edit = h("button", { class: "mini", type: "button", text: "Edit" });
      edit.addEventListener("click", () => {
        chatInput.value = t.text;
        chatInput.focus();
        chatInput.style.height = "auto";
        chatInput.style.height = `${Math.min(160, chatInput.scrollHeight)}px`;
      });
      wrap.append(edit);
      return wrap;
    }
    const k = h("div", { class: "k" });
    // The production rich renderer (render-assistant.ts): headings, lists,
    // tables, code, quotes, links and math through the safe Markdown
    // boundary — never a plain paragraph, never raw model HTML.
    const mdHost = h("div", { class: "kai-md fade" });
    if (t.text.trim().length > 0) {
      try {
        renderAssistantStatic(mdHost, t.text);
      } catch {
        // A renderer failure must never blank a real answer: fall back to
        // plain text rather than lose what Core said.
        mdHost.textContent = t.text;
      }
    }
    k.append(mdHost);
    // Copy every assistant message (operator §31): explicit, not selection-only.
    if (t.text.trim().length > 0) {
      const copy = h("button", { class: "mini", type: "button", text: "Copy" });
      copy.addEventListener("click", () => {
        void navigator.clipboard?.writeText(t.text).then(
          () => toast("Copied", "ok"),
          () => toast("Copy failed", "err"),
        );
      });
      k.append(copy);
    }
    // The persisted tool history renders under the answer it produced — the
    // same cards a reloaded session shows.
    if (t.tools !== undefined) {
      for (const call of t.tools) k.append(toolCard(call));
    }
    return k;
  }
  function appendTurn(t: Turn): void {
    const node = bubbleTurn(t);
    if (t.role === "assistant") collapseTurnTools(node);
    threadCol.append(node);
    requestFollow();
  }
  /**
   * Show the thread whenever there is a conversation OR a live turn — and never
   * drop back to the greeting just because a turn finished. This RECOMPUTES the
   * class from the one tested decision (`conversationVisible`) instead of adding
   * it on send and removing it on completion. The old blind removal at the end of
   * `runTurn` was the actual cause of "sending a prompt sends me back to Home":
   * the stylesheet shows the greeting hero and hides the thread without this
   * class, so a finished reply collapsed the conversation into the landing.
   */
  function refreshChatSurface(): void {
    app.classList.toggle("talking", conversationVisible({ turns: turns.length, busy }));
  }
  function renderTurns(): void {
    // NEVER rebuild the thread while a turn is streaming into it: a concurrent
    // `loadHistory` (fired by refreshActive on a fresh session) used to wipe the
    // in-progress live bubble here, so the streamed answer only appeared at
    // settle — the "shows only at the end" defect. The live node owns the DOM
    // until the turn settles; the data model still updates underneath.
    if (streamLive) return;
    threadCol.textContent = "";
    for (const t of turns) {
      const node = bubbleTurn(t);
      if (t.role === "assistant") collapseTurnTools(node);
      threadCol.append(node);
    }
    refreshChatSurface();
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  /** A real activity card, built from a real Core event (the design's `tool()`). */
  function appendEventCard(row: WorkspaceEventRow, mcp = false): void {
    // Display pref: OFF hides event cards entirely; COMPACT hides the payload.
    if (orchPrefs.activity === "OFF") return;
    if (turnCardHost === null) return;
    const el = h("details", { class: "tc blk" });
    const summary = h("summary");
    summary.innerHTML = `<span class="ti ${mcp ? "mcp" : ""}">${icon(mcp ? "plug" : "term")}</span><b>${esc(row.type)}</b><code>${esc(row.line)}</code>${mcp ? '<span class="tag">MCP</span>' : ""}<span class="ms"><span class="okd"></span>${esc(relativeTime(row.at))}</span>`;
    el.append(summary);
    if (row.payload !== undefined && orchPrefs.activity === "VERBOSE") {
      el.append(h("pre", { text: JSON.stringify(row.payload, null, 2).slice(0, 2000) }));
    }
    turnCardHost.append(el);
    requestFollow();
  }

  /**
   * Name the subsystem that actually failed (owner §26) — a Core that could not
   * be reached is a NETWORK failure; a Core that answered but whose turn failed
   * is the MODEL PROVIDER's; anything else is KAI's own. One subsystem is never
   * reported as another.
   */
  function classifyTurnFailure(error: CoreError): string {
    switch (error.code) {
      case "CORE_OFFLINE":
      case "TIMEOUT":
        return "NETWORK";
      case "REQUEST_FAILED":
      case "INVALID_RESPONSE":
        return "MODEL PROVIDER";
      default:
        return "KAI";
    }
  }

  /**
   * A failed turn stays IN the session: the failure is shown where the turn was,
   * the person's input is preserved, and a Retry re-sends the SAME turn without
   * recording it twice. Nothing navigates away and nothing is replaced by the
   * greeting (owner §26).
   */
  function appendTurnFailure(subsystem: string, message: string, text: string): void {
    const card = h("div", { class: "k" });
    card.append(h("p", { class: "bad fade", text: `${subsystem} — ${message}` }));
    const retry = h("button", { class: "btn", type: "button", text: "Retry" });
    retry.addEventListener("click", () => {
      card.remove();
      void runTurn(text, true);
    });
    card.append(h("div", { class: "btns" }, retry));
    threadCol.append(card);
    if (chatInput.value.trim().length === 0) {
      chatInput.value = text;
      chatInput.style.height = "auto";
      chatInput.style.height = `${Math.min(160, chatInput.scrollHeight)}px`;
    }
    requestFollow();
  }

  function chatHeader(): void {
    const sub = shell.querySelector<HTMLElement>("#kp-proj-sub");
    if (sub === null) return;
    if (activeSession === null) { sub.textContent = "no session yet — your next message starts one"; return; }
    const shown = sessionDisplayTitle(activeSession.title, firstUserText);
    const turnsLabel = activeSession.turnCount !== undefined ? ` · ${activeSession.turnCount} turns` : "";
    // Core's persisted digest, compact: the objective tells what a resumed
    // conversation is about at a glance. Absent until the first turn.
    const objective = activeSession.summary?.objective.trim() ?? "";
    const excerpt = objective.length > 80 ? `${objective.slice(0, 77).trimEnd()}…` : objective;
    sub.textContent = `${shown.title}${turnsLabel}${excerpt.length > 0 ? ` · ${excerpt}` : ""}`;
  }

  // History-load generation: `loadHistory` is fired unawaited from several
  // paths (a finished turn, a tab sync, opening a session), so two loads for
  // the same session can be in flight at once and resolve in EITHER order. The
  // last response used to win regardless of recency — a stale snapshot then
  // overwrote newer local turns (an answer that "appears only after changing
  // tabs") or an empty one (the landing greeting over a live conversation).
  // Only the NEWEST load may write: older responses are discarded.
  let historySeq = 0;
  async function loadHistory(id: string): Promise<void> {
    const seq = ++historySeq;
    const res = await client.sessionTurns(id, { limit: 200 });
    if (seq !== historySeq) return;
    if (!res.ok) return;
    // `tools` ride along from Core's transcript — a reloaded session shows the
    // same tool cards the live turn showed. Nothing is reconstructed locally.
    const incoming = res.value
      .filter((t) => t.role === "user" || t.role === "assistant")
      .map((t) => ({
        id: chatSeq++,
        role: t.role as "user" | "assistant",
        text: t.text,
        ...(t.tools !== undefined && t.tools.length > 0 ? { tools: t.tools } : {}),
      }));
    if (id !== loadedSessionId) {
      // Switching sessions: the snapshot owns the surface, whatever its size.
      turns = incoming;
    } else if (incoming.length >= turns.length) {
      // Same-session refresh that caught up: adopt it.
      turns = incoming;
    } else {
      // Same-session snapshot that PREDATES local truth (a settle still
      // landing, or one that failed server-side while the user already saw
      // the streamed turn + its failure card): replacing would silently wipe
      // visible history. Keep local turns; the next refresh reconciles.
      chatHeader();
      return;
    }
    loadedSessionId = id;
    firstUserText = turns.find((t) => t.role === "user")?.text;
    chatHeader();
    renderTurns();
  }
  // refreshActive is fired unawaited from many paths, so responses can resolve
  // in EITHER order. A STALE null (requested before a session existed,
  // resolving after the first turn settled) used to wipe the just-rendered
  // answer back to the empty hero. Only the NEWEST response may write — the
  // same generation rule loadHistory already honours.
  let activeSeq = 0;
  async function refreshActive(): Promise<void> {
    const seq = ++activeSeq;
    const res = await client.activeSession();
    if (seq !== activeSeq) return;
    // Transport failure: keep showing what is loaded. Only an AUTHORITATIVE
    // answer changes the surface — a failed fetch must never blank it.
    if (!res.ok) { chatHeader(); return; }
    activeSession = res.value;
    if (activeSession === null) {
      // A turn in flight may still be creating its session: never wipe under
      // it. The settle path refreshes again once the session exists.
      if (busy || streamLive) { chatHeader(); return; }
      // Core says there is no active conversation (e.g. the session was
      // deleted and nothing remained): drop the stale thread so a dead
      // session's transcript cannot linger, then show the genuine empty hero.
      if (turns.length > 0 || loadedSessionId !== null) {
        turns = [];
        loadedSessionId = null;
        firstUserText = undefined;
        renderTurns();
      }
      chatHeader();
      return;
    }
    // Never reload history while a turn is streaming: the in-flight turn owns
    // the thread until settle (see renderTurns' streamLive guard). Reloading
    // now would drop the just-added user bubble and the live answer.
    if (activeSession.id !== loadedSessionId && !busy) { await loadHistory(activeSession.id); return; }
    chatHeader();
  }

  function submit(): void {
    const text = chatInput.value.trim();
    if (text.length === 0 || busy) return;
    chatInput.value = "";
    chatInput.style.height = "auto";
    // A slash invocation runs a REAL Core command, not a chat turn: the result
    // renders as KAI's answer but is never recorded as conversation.
    if (text.startsWith("/")) {
      void runSlash(text);
      return;
    }
    // Plan Mode is real: in Plan mode a message IS a planning request — the
    // model drafts a structured plan (executing nothing) and the turn offers
    // approval. Ask/Work modes converse normally.
    if (readMode() === "plan") {
      void runPlan(text);
      return;
    }
    void runTurn(text);
  }

  /**
   * Plan Mode turn: draft a structured plan from the message and offer the
   * approve-to-work transition inline. The draft persists as a DRAFT mission
   * whether or not it is approved — planning never executes.
   */
  async function runPlan(goal: string): Promise<void> {
    busy = true;
    refreshChatSurface();
    const userTurn: Turn = { id: chatSeq++, role: "user", text: goal };
    turns.push(userTurn);
    appendTurn(userTurn);
    const k = h("div", { class: "k" });
    const think = h("details", { class: "think blk", open: true }, h("summary", { html: "<i></i>KAI is planning" }), h("div", { text: "Drafting a structured plan — nothing will run." }));
    k.append(think);
    threadCol.append(k);
    requestFollow();
    try {
      const res = await client.runCommand("plan", goal);
      think.remove();
      if (!res.ok) {
        appendTurnFailure("KAI", res.error.reason ?? res.error.message, goal);
        return;
      }
      const assistant: Turn = { id: chatSeq++, role: "assistant", text: `${res.value.title}\n${res.value.text}` };
      turns.push(assistant);
      appendTurn(assistant);
      const missionId = (res.value.data as { missionId?: string } | undefined)?.missionId;
      if (missionId !== undefined) {
        const card = h("div", { class: "k" });
        const approve = h("button", { class: "btn pri", type: "button", text: "Approve & start work" });
        const view = h("button", { class: "btn", type: "button", text: "Review in Missions" });
        approve.addEventListener("click", () => {
          approve.textContent = "Starting…";
          void client.startMission(missionId).then((started) => {
            if (started.ok) {
              approve.textContent = `Mission ${started.value.status.toLowerCase()}`;
              approve.setAttribute("disabled", "true");
              toast("Work started — follow it under Missions", "ok");
              return;
            }
            approve.textContent = "Approve & start work";
            toast(started.error.reason ?? started.error.message, "err");
          });
        });
        view.addEventListener("click", () => show("missions"));
        card.append(h("div", { class: "btns" }, approve, view));
        threadCol.append(card);
        requestFollow();
      }
    } catch (err) {
      think.remove();
      appendTurnFailure("KAI", err instanceof Error ? err.message : String(err), goal);
    } finally {
      busy = false;
      window.setTimeout(() => { if (!busy) refreshChatSurface(); }, 600);
    }
  }

  /**
   * Execute `/command args…` against Core and render the outcome. Unknown
   * commands and command failures render as KAI's answer text — the slash is
   * consumed either way, never sent to the model as chat.
   */
  async function runSlash(text: string): Promise<void> {
    const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.*))?$/.exec(text);
    busy = true;
    refreshChatSurface();
    const userTurn: Turn = { id: chatSeq++, role: "user", text };
    turns.push(userTurn);
    appendTurn(userTurn);
    const fail = (message: string): void => {
      const assistant: Turn = { id: chatSeq++, role: "assistant", text: message };
      turns.push(assistant);
      appendTurn(assistant);
    };
    try {
      if (match === null) {
        fail(`“${text}” is not a command — try /help.`);
        return;
      }
      const res = await client.runCommand(match[1] ?? "", (match[2] ?? "").trim());
      if (!res.ok) {
        fail(res.error.reason ?? res.error.message);
        return;
      }
      const assistant: Turn = { id: chatSeq++, role: "assistant", text: `${res.value.title}\n${res.value.text}` };
      turns.push(assistant);
      appendTurn(assistant);
      // Commands that move the conversation (notably /new) refresh the header
      // so the surface names the session the next turn will join.
      void refreshActive();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      window.setTimeout(() => { if (!busy) refreshChatSurface(); }, 600);
    }
  }

  async function runTurn(text: string, resend = false): Promise<void> {
    busy = true;
    refreshChatSurface();
    moods.setComposing(false);
    moods.turnSubmitted();
    // `resend` (a Retry after a failed turn) re-issues the SAME turn without
    // recording a second user bubble — the failure already recorded the words.
    if (!resend) {
      const userTurn: Turn = { id: chatSeq++, role: "user", text };
      turns.push(userTurn);
      appendTurn(userTurn);
    }
    // The live host for real tool/approval/agent cards that arrive this turn.
    stopRequested = false;
    appendActStrip("Thinking…", "plan");
    paintOperatorStatus();
    const controller = new AbortController();
    activeAbort = controller;
    const k = h("div", { class: "k" });
    const think = h("details", { class: "think blk", open: true }, h("summary", { html: "<i></i>KAI is working" }), h("div", { text: "Waiting for Core…" }));
    // STOP (operator §29/§33): real abort of the streamed turn, always visible
    // while KAI is working. Honest — a run that cannot preempt mid-tool says so
    // via the settled state rather than pretending it halted instantly.
    const stop = h("button", { class: "mini", type: "button", text: "Stop" });
    stop.addEventListener("click", () => {
      stopRequested = true;
      stop.textContent = "Stopping…";
      activeAbort?.abort();
    });
    think.append(stop);
    k.append(think);
    threadCol.append(k);
    requestFollow();
    turnCardHost = k;

    // Prefer the STREAM: deltas paint as they arrive and the brain's real
    // tool events drive the "searching…" states. A stream that never starts
    // falls back to the plain turn — same record, different delivery.
    //
    // Two flags, not one: `streamActive` means the stream produced anything
    // (text or tool events — the fallback test), while `liveAttached` means
    // the answer bubble is in the DOM. Conflating them hid tool-turn answers:
    // a tool event arriving before any text delta marked the stream "done"
    // and the bubble with the actual answer was never attached — the card
    // rendered, the reply stayed invisible. That was Bug A.
    let streamActive = false;
    let liveAttached = false;
    let liveText = "";
    const liveNode = h("div", { class: "k" });
    // The live answer renders through the SAME rich renderer as settled
    // turns (render-assistant.ts): StreamView morphs incrementally on its own
    // rAF loop, so a delta never rebuilds the thread.
    const liveHost = h("div", { class: "kai-md fade" });
    liveNode.append(liveHost);
    let liveView: LiveAssistant | null = null;
    // Read through a call: the view is assigned inside stream callbacks, so a
    // direct read here would be narrowed to its `null` initializer.
    const getLiveView = (): LiveAssistant | null => liveView;
    // One card per tool attempt, keyed by the REAL toolCallId: the start
    // opens a running card in timeline position, the terminal event replaces
    // it IN PLACE with the outcome + result body. No duplicates, no
    // post-hoc grouping under the final answer.
    const liveToolCards = new Map<string, HTMLElement>();
    const thinkLabel = think.querySelector("summary");
    const settleStreamed = (sessionId: string | undefined): void => {
      think.remove();
      // The live StreamView already painted the full answer in place; record
      // the turn without touching the DOM again — except collapsing the
      // turn's successful tool cards into one execution block.
      if (turnCardHost !== null) collapseTurnTools(turnCardHost);
      const assistant: Turn = { id: chatSeq++, role: "assistant", text: liveText };
      turns.push(assistant);
      if (sessionId !== undefined) loadedSessionId = sessionId;
      moods.turnResolved(true);
      void refreshApprovals();
      void refreshActive();
    };
    try {
      const res = await client.chatStream(text, activeSession?.id ?? undefined, {
        onDelta: (delta) => {
          streamActive = true;
          streamLive = true;
          if (!liveAttached) {
            liveAttached = true;
            threadCol.append(liveNode);
            liveView = createLiveAssistant(liveHost, requestFollow);
          }
          liveText += delta;
          try {
            liveView?.push(liveText);
          } catch {
            // Renderer failure mid-stream must never lose the answer: the
            // settled record below still carries the full text.
          }
          requestFollow();
        },
        onToolEvent: (event) => {
          streamActive = true;
          streamLive = true;
          if (event.type === "tool_start") {
            if (thinkLabel !== null) {
              thinkLabel.innerHTML = `<i></i>KAI is ${esc(describeToolActivity(event.toolId, event.toolName))}…`;
            }
            // The attempt opens its timeline card NOW (running), in arrival
            // order — the result replaces it when the terminal event lands.
            const running = toolCard({
              toolName: event.toolName,
              ...(event.toolId !== undefined ? { toolId: event.toolId } : {}),
              status: "RUNNING",
              ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
              ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
            });
            liveToolCards.set(event.toolCallId, running);
            turnCardHost?.append(running);
            appendActStrip(`${event.toolId ?? event.toolName} · started`.trim(), "tool");
            requestFollow();
            return;
          }
          // A terminal tool event replaces its running card IN PLACE with the
          // ACTUAL outcome + bounded result body — never synthesised, never a
          // second card, never deferred to the final answer.
          const card = toolCard({
            toolName: event.toolName,
            ...(event.toolId !== undefined ? { toolId: event.toolId } : {}),
            status: event.status ?? "UNKNOWN",
            ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
            ...(event.resultPreview !== undefined ? { resultPreview: event.resultPreview } : {}),
            ...(event.resultTruncated !== undefined ? { resultTruncated: event.resultTruncated } : {}),
            ...(event.error !== undefined ? { error: event.error } : {}),
            ...(event.approvalId !== undefined ? { approvalId: event.approvalId } : {}),
            ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
            ...(event.completedAt !== undefined ? { completedAt: event.completedAt } : {}),
          });
          const prior = liveToolCards.get(event.toolCallId);
          if (prior !== undefined) {
            prior.replaceWith(card);
            liveToolCards.delete(event.toolCallId);
          } else {
            turnCardHost?.append(card);
          }
          appendActStrip(`${event.toolId ?? event.toolName} · ${event.status ?? ""}`.trim(), "tool");
          requestFollow();
        },
        signal: controller.signal,
      });
      const cancelled = (res.ok && res.value.cancelled === true) || (res.ok && res.value.taskState === "CANCELLED");
      if (streamActive) appendActStrip(cancelled || stopRequested ? "Stopped — run aborted" : "Done", "done");
      if (streamActive) {
        void getLiveView()?.finish();
        settleStreamed(res.ok ? res.value.sessionId : undefined);
        if (cancelled || stopRequested) {
          // The user stopped it AND the run reports cancelled: the child
          // processes are dead (server aborts the run on disconnect and the
          // registry kills the tree). Settle what streamed, say ABORTED
          // plainly — never Done, never a failure card.
          toast("Stopped — work aborted", "ok");
          moods.turnResolved(true);
          void refreshActive();
        } else if (!res.ok) {
          appendTurnFailure(classifyTurnFailure(res.error), res.error.reason ?? res.error.message, text);
          moods.turnResolved(false);
        } else if (res.value.agentRun !== undefined) {
          // A delegated `@agent` turn parked on an approval: the reply names
          // it, and this card lets the user Allow it inline.
          appendAgentRunCard(res.value.agentRun, text);
        }
      } else if (stopRequested) {
        // Stopped before the first frame: settle quietly. Falling through to
        // the plain path here would RE-SEND a turn the user just cancelled.
        think.remove();
        liveNode.remove();
        toast("Stopped — work aborted", "ok");
        moods.turnResolved(true);
        void refreshActive();
      } else {
        // The stream never started: same turn over the plain path.
        think.remove();
        liveNode.remove();
        const plain = await client.chat(text, activeSession?.id);
        if (plain.ok) {
          const reply = plain.value.reply;
          const assistant: Turn = {
            id: chatSeq++,
            role: "assistant",
            text: reply,
            ...(plain.value.toolCalls !== undefined && plain.value.toolCalls.length > 0
              ? { tools: plain.value.toolCalls }
              : {}),
          };
          turns.push(assistant);
          appendTurn(assistant);
          if (plain.value.agentRun !== undefined) {
            appendAgentRunCard(plain.value.agentRun, text);
          }
          if (plain.value.sessionId !== undefined) loadedSessionId = plain.value.sessionId;
          moods.turnResolved(true);
          void refreshApprovals();
          void refreshActive();
        } else {
          appendTurnFailure(classifyTurnFailure(plain.error), plain.error.reason ?? plain.error.message, text);
          moods.turnResolved(false);
        }
      }
    } catch (err) {
      think.remove();
      liveNode.remove();
      appendTurnFailure("KAI", err instanceof Error ? err.message : String(err), text);
      moods.turnResolved(false);
    } finally {
      turnCardHost = null;
      activeAbort = null;
      streamLive = false;
      busy = false;
      void refreshWorkerHealth();
      chatInput.focus();
      // Recompute — NOT remove. With the reply in `turns`, the conversation stays
      // in front instead of collapsing back to the greeting (the eject-to-Home bug).
      window.setTimeout(() => { if (!busy) refreshChatSurface(); }, 600);
    }
  }

  // ══ mention + abilities ═══════════════════════════════════════════════════
  /** Live skill catalogue for `@` (id, name, one-line description). */
  let mentionSkills: { id: string; name: string; description: string }[] = [];
  async function loadMentionSkills(): Promise<void> {
    const res = await client.skills();
    if (res.ok) {
      mentionSkills = res.value
        .filter((s) => s.status === "enabled")
        .map((s) => ({ id: s.id, name: s.name, description: s.description }));
    }
  }
  /**
   * `@` explicit invocation picker: live agents AND live skills, each with
   * type + description. Selecting inserts `@Name `; sending routes the turn
   * through the router's invocation path (USE, never mere mention).
   */
  function mentionOpen(q: string): void {
    const p = shell.querySelector<HTMLElement>("#kp-mention");
    if (p === null) return;
    const needle = q.toLowerCase();
    const matches = (name: string): boolean => name.toLowerCase().startsWith(needle);
    const agentItems = agents.filter((a) => matches(a.name)).map((a) => ({
      n: a.name,
      sub: `Agent · ${a.role}`,
    }));
    const skillItems = mentionSkills.filter((s) => matches(s.name) || matches(s.id)).map((s) => ({
      n: s.name,
      sub: `Skill · ${s.description.slice(0, 80)}`,
    }));
    const items = [...agentItems, ...skillItems].slice(0, 8);
    if (items.length === 0) { p.classList.remove("on"); return; }
    p.innerHTML =
      "<h5>Invoke — agents run, skills guide</h5>" +
      items
        .map(
          (i) =>
            `<button class="pr" data-n="${esc(i.n)}" style="width:100%;border:0;background:none;text-align:left"><span class="ti">${icon("agent")}</span><div><b>${esc(i.n)}</b><small>${esc(i.sub)}</small></div></button>`,
        )
        .join("");
    p.classList.add("on");
    const buttons = Array.from(p.querySelectorAll<HTMLElement>(".pr"));
    buttons.forEach((b, index) => {
      if (index === 0) b.classList.add("sel");
      b.addEventListener("click", () => {
        chatInput.value = chatInput.value.replace(/@[\w-]*$/, `@${b.dataset.n ?? ""} `);
        p.classList.remove("on");
        chatInput.focus();
      });
      b.addEventListener("mouseenter", () => {
        for (const other of buttons) other.classList.remove("sel");
        b.classList.add("sel");
      });
    });
  }
  // ══ slash commands — the live registry palette in the composer ═══════════
  /** Core's command catalogue (the palette's only source — never hardcoded). */
  let slashCommands: { id: string; title: string; description: string; usage: string; args?: { name: string; description?: string; source: string }[] }[] = [];
  async function loadSlashCommands(): Promise<void> {
    const res = await client.commands();
    if (res.ok) slashCommands = res.value;
  }

  /** Live suggestions for one command argument from current runtime state. */
  function argSuggestions(source: string, needle: string): { value: string; sub: string }[] {
    const q = needle.toLowerCase();
    const starts = (s: string): boolean => s.toLowerCase().startsWith(q);
    if (source === "sessions") {
      return sessions
        .filter((s) => s.status === "ACTIVE" && (starts(s.title) || starts(s.id)))
        .slice(0, 6)
        .map((s) => ({ value: s.id, sub: `Session · ${s.title.slice(0, 60)}` }));
    }
    if (source === "agents") {
      return agents
        .filter((a) => a.enabled && (starts(a.name) || starts(a.id)))
        .slice(0, 6)
        .map((a) => ({ value: a.name, sub: `Agent · ${a.role.slice(0, 60)}` }));
    }
    if (source === "skills") {
      return mentionSkills
        .filter((s) => starts(s.name) || starts(s.id))
        .slice(0, 6)
        .map((s) => ({ value: s.name, sub: `Skill · ${s.description.slice(0, 60)}` }));
    }
    if (source === "mcp") {
      return mcpServers
        .filter((s) => starts(s.name))
        .slice(0, 6)
        .map((s) => ({ value: s.name, sub: `MCP · ${s.connected ? "connected" : "not connected"}` }));
    }
    return [];
  }

  /** The `/` popup element (built in buildChat; queried like `#kp-mention`). */
  function slashEl(): HTMLElement | null {
    return shell.querySelector<HTMLElement>("#kp-slash");
  }

  /**
   * The `/` menu: registry commands filtered as you type, then live argument
   * suggestions once the command is complete. Enter runs, Tab completes,
   * Esc closes, arrows move. Everything listed comes from Core or live state.
   */
  function slashOpen(): void {
    const slashPop = slashEl();
    if (slashPop === null) return;
    const text = chatInput.value;
    const match = /^\/([\w-]*)(.*)$/.exec(text);
    if (match === null) {
      slashPop.classList.remove("on");
      return;
    }
    const name = match[1] ?? "";
    const rest = (match[2] ?? "").trimStart();
    const exact = slashCommands.find((c) => c.id === name);
    type Row = { label: string; sub: string; apply: string };
    let rows: Row[] = [];
    if (exact === undefined || rest.length === 0) {
      // Completing the command name itself.
      const needle = name.toLowerCase();
      rows = slashCommands
        .filter((c) => c.id.toLowerCase().startsWith(needle) || c.title.toLowerCase().includes(needle))
        .slice(0, 8)
        .map((c) => ({ label: `/${c.id}`, sub: `${c.title} — ${c.usage}`, apply: `/${c.id} ` }));
    } else if (exact.args !== undefined && exact.args.length > 0) {
      // Completing the first argument from its live source.
      const first = exact.args[0]!;
      const suggestions = argSuggestions(first.source, rest);
      rows = suggestions.map((s) => ({ label: s.value, sub: s.sub, apply: `/${exact.id} ${s.value} ` }));
      if (rows.length === 0) {
        rows = [{ label: first.name, sub: first.description ?? exact.usage, apply: `/${exact.id} ` }];
      }
    } else {
      slashPop.classList.remove("on");
      return;
    }
    if (rows.length === 0) {
      slashPop.classList.remove("on");
      return;
    }
    slashPop.innerHTML =
      "<h5>Commands — from KAI's registry</h5>" +
      rows
        .map(
          (r) =>
            `<button class="pr" data-apply="${esc(r.apply)}" style="width:100%;border:0;background:none;text-align:left"><div><b>${esc(r.label)}</b><small>${esc(r.sub)}</small></div></button>`,
        )
        .join("");
    slashPop.classList.add("on");
    const buttons = Array.from(slashPop.querySelectorAll<HTMLElement>(".pr"));
    buttons.forEach((b) => {
      b.addEventListener("click", () => {
        chatInput.value = b.dataset.apply ?? "";
        slashPop.classList.remove("on");
        chatInput.focus();
      });
      b.addEventListener("mouseenter", () => {
        for (const other of buttons) other.classList.remove("sel");
        b.classList.add("sel");
      });
    });
  }

  /** Keyboard through the open `/` menu. Returns true when it consumed the key. */
  function slashKey(e: KeyboardEvent): boolean {
    const slashPop = slashEl();
    if (slashPop === null || !slashPop.classList.contains("on")) return false;
    const buttons = Array.from(slashPop.querySelectorAll<HTMLElement>(".pr"));
    if (buttons.length === 0) return false;
    const current = buttons.findIndex((b) => b.classList.contains("sel"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
      for (const b of buttons) b.classList.remove("sel");
      buttons[next]?.classList.add("sel");
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const target = current >= 0 ? buttons[current] : buttons[0];
      target?.click();
      // Tab completes the text so typing can continue; Enter sends it —
      // runSlash executes the completed command for real.
      if (e.key === "Enter") submit();
      return true;
    }
    if (e.key === "Escape") {
      slashPop.classList.remove("on");
      return true;
    }
    return false;
  }

  /** Keyboard through the open `@` picker: Up/Down move, Enter/Tab accept, Esc closes. */
  function mentionKey(e: KeyboardEvent): boolean {
    const p = shell.querySelector<HTMLElement>("#kp-mention");
    if (p === null || !p.classList.contains("on")) return false;
    const buttons = Array.from(p.querySelectorAll<HTMLElement>(".pr"));
    if (buttons.length === 0) return false;
    const current = buttons.findIndex((b) => b.classList.contains("sel"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
      for (const b of buttons) b.classList.remove("sel");
      buttons[next]?.classList.add("sel");
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const target = current >= 0 ? buttons[current] : buttons[0];
      target?.click();
      return true;
    }
    if (e.key === "Escape") {
      p.classList.remove("on");
      return true;
    }
    return false;
  }

  function renderAbil(): void {
    const host = shell.querySelector<HTMLElement>("#kp-abil");
    if (host === null) return;
    const ready = tools.filter((t) => !t.permission.sideEffecting).length;
    const att = mcpServers.filter((s) => s.enabled && !s.connected).length;
    host.innerHTML =
      `<button class="ab" data-go="tools"><span class="ti">${icon("plug")}</span><div><b>${tools.length} tools registered</b><span>${ready} run without approval</span></div></button>` +
      `<button class="ab" data-go="mcp"><span class="ti mcp">${icon("plug")}</span><div><b>${mcpServers.length} MCP servers</b><span>${att > 0 ? `${att} need attention` : "all healthy"}</span></div></button>` +
      `<button class="ab" data-go="agents"><span class="ti">${icon("agent")}</span><div><b>${agents.length} agents</b><span>Ready to take jobs</span></div></button>`;
    for (const b of Array.from(host.querySelectorAll<HTMLElement>("[data-go]"))) {
      b.addEventListener("click", () => show((b.dataset.go ?? "chat") as RouteId));
    }
  }

  function abPaint(): void {
    const p = shell.querySelector<HTMLElement>("#kp-abpop");
    if (p === null) return;
    p.innerHTML =
      "<h5>Agents</h5>" +
      agents.map((a) => `<div class="pr"><span data-orb-hue="${agentHue(a, 0)}"></span><div><b>${esc(a.name)}</b><small>${esc(a.role)}</small></div><span class="chip mut">${esc(a.status)}</span></div>`).join("") +
      "<h5>Tools and MCP</h5>" +
      tools.slice(0, 30).map((t) => `<div class="pr"><span class="ti">${icon("plug")}</span><div><b>${esc(t.name)}</b><small>${esc(t.permission.risk.toLowerCase())}${t.permission.sideEffecting ? ", parks for approval" : ", runs directly"}</small></div></div>`).join("") +
      (tools.length > 30 ? `<div class="empty">…and ${tools.length - 30} more tools.</div>` : "") +
      '<div class="btns" style="padding:8px 10px"><button class="mini" id="kp-ab-man">Manage tools</button><button class="mini" id="kp-ab-ag">Manage agents</button></div>';
    for (const s of Array.from(p.querySelectorAll<HTMLElement>("[data-orb-hue]"))) {
      const o = createOrb({ mood: "idle", fx: false, size: 30, hue: Number(s.dataset.orbHue ?? "0") });
      s.replaceWith(o);
    }
    const man = p.querySelector("#kp-ab-man"); const ag = p.querySelector("#kp-ab-ag");
    man?.addEventListener("click", () => { p.classList.remove("on"); show("tools"); });
    ag?.addEventListener("click", () => { p.classList.remove("on"); show("agents"); });
  }

  // ══ AGENTS ════════════════════════════════════════════════════════════════
  function buildAgents(v: HTMLElement): void {
    const sumRow = h("div", { class: "sumrow", id: "kp-ag-sum" });
    const grid = h("div", { class: "agrid", id: "kp-agrid" });
    const newBtn = h("button", { class: "pill pri", type: "button", text: "New agent" });
    newBtn.addEventListener("click", newAgent);
    const top = h("header", { class: "top", style: "padding:22px 0 14px" },
      h("div", {}, h("h2", { text: "Agents" }), h("p", { text: "KAI leads. Agents take focused jobs and work in parallel." })),
      h("div", { class: "topr" }, newBtn));
    v.append(h("div", { class: "scroll" }, h("div", { class: "wrapw" }, top, sumRow, grid)));
  }

  /** Runs currently in flight (parked runs stay listed until decided). */
  let agentRuns: { runId: string; subagentId: string; status: string; approvalId?: string }[] = [];

  async function loadAgents(): Promise<void> {
    const res = await agentApi.listSubagents();
    if (res.ok) agents = res.value;
    const runs = await agentApi.listSubagentRuns();
    if (runs.ok) agentRuns = runs.value;
    renderAgents();
    renderAbil();
    paintStatus();
    if (view === "home") void renderOverview();
  }

  function renderAgents(): void {
    const sum = shell.querySelector<HTMLElement>("#kp-ag-sum");
    const grid = shell.querySelector<HTMLElement>("#kp-agrid");
    if (sum === null || grid === null) return;
    const on = agents.filter((a) => a.enabled);
    sum.innerHTML = `<span class="chip">${on.length} active</span><span class="chip ok">${agents.filter((a) => a.activity !== "idle").length} working now</span><span class="chip mut">${agents.length - on.length} turned off</span>`;
    if (agentRuns.length > 0) {
      sum.innerHTML += `<span class="chip warn">${agentRuns.length} run(s) in flight</span>`;
    }
    grid.textContent = "";
    // In-flight runs first: each names its persona and state, and a parked
    // run offers a real Cancel (its approval is rejected, so it never runs).
    for (const run of agentRuns) {
      const card = h("div", { class: "acard run" });
      card.append(
        h("h3", { text: `Run · ${run.subagentId}` }),
        h("p", { text: run.status === "parked" ? "Waiting on your approval" : "Executing" }),
        h("div", { class: "foot" }, h("span", { class: "chip mut", text: run.runId })),
      );
      if (run.status === "parked") {
        const cancel = h("button", { class: "mini", type: "button", text: "Cancel run" });
        cancel.addEventListener("click", () => {
          void agentApi.cancelSubagentRun(run.runId).then((res) => {
            if (res.ok) {
              toast("Run cancelled", "ok");
              void loadAgents();
            } else toast(res.error.message, "err");
          });
        });
        card.querySelector(".foot")?.append(cancel);
      }
      grid.append(card);
    }
    agents.forEach((a, i) => {
      const card = h("div", { class: "acard" + (a.enabled ? "" : " dis") });
      const orb = createOrb({ mood: a.enabled ? (a.activity !== "idle" ? "focus" : "idle") : "sleepy", fx: false, size: 88, hue: agentHue(a, i) });
      const state = !a.enabled ? "off" : a.activity !== "idle" ? "work" : a.status === "READY" ? "idle" : "idle";
      card.append(
        orb,
        h("h3", { text: a.name }),
        h("p", { text: a.role + " — " + a.soul.replace(/^I am [^,]*,?\s*/i, "") }),
        // Display pref: DETAILED always shows the objective line plus every
        // capability; COMPACT keeps the short form.
        ...(orchPrefs.agentsView === "DETAILED"
          ? [h("p", {
            class: "obj",
            text: `Objective: ${
              a.objective !== undefined && a.objective.length > 0 ? a.objective.slice(0, 280) : "(none recorded)"
            }`,
          })]
          : a.objective !== undefined && a.objective.length > 0
            ? [h("p", { class: "obj", text: `Objective: ${a.objective.slice(0, 140)}` })]
            : []),
        h("div", {
          class: "tools",
        }, ...(orchPrefs.agentsView === "DETAILED" ? a.capabilities : a.capabilities.slice(0, 4)).map((c) =>
          h("span", { class: "chip mut", text: c }),
        )),
        h("span", { class: "chip " + (state === "work" ? "" : "mut"), text: state === "work" ? (a.currentTask ?? "Working") : !a.enabled ? "Turned off" : a.status }),
        h("div", { class: "foot" },
          h("button", { class: "mini", type: "button", text: "Give it a job" }),
          h("button", { class: "mini", type: "button", text: a.enabled ? "Archive" : "Restore" }),
          h("span", { class: "chip mut", text: a.workerId })),
      );
      const editBtn = h("button", { class: "mini", type: "button", text: "Edit" });
      editBtn.addEventListener("click", () => editAgent(a));
      card.querySelector(".foot")?.append(editBtn);
      const buttons = Array.from(card.querySelectorAll(".mini"));
      (buttons[0] as HTMLElement).addEventListener("click", () => giveJob(a));
      (buttons[1] as HTMLElement).addEventListener("click", () => {
        const call = a.enabled ? agentApi.archiveSubagent(a.id) : agentApi.unarchiveSubagent(a.id);
        void call.then((res) => {
          if (res.ok) {
            toast(a.enabled ? `${a.name} archived — no longer delegate-able` : `${a.name} restored`, "ok");
            void loadAgents();
          } else toast(res.error.message, "err");
        });
      });
      orb.addEventListener("click", () => { boop(orb); setOrbMood(orb, "happy"); window.setTimeout(() => setOrbMood(orb, a.enabled ? "idle" : "sleepy"), 1200); });
      grid.append(card);
    });
    const add = h("button", { class: "acard add", type: "button" });
    add.innerHTML = '<span style="font-size:34px;line-height:1">+</span><b>New agent</b><p style="min-height:0">Give it a job, tools and a color.</p>';
    add.addEventListener("click", newAgent);
    grid.append(add);
  }

  async function giveJob(a: Subagent): Promise<void> {
    const job = window.prompt(`What should ${a.name} do?`, "");
    if (job === null || job.trim() === "") return;
    const res = await agentApi.runSubagent(a.id, job.trim());
    if (res.ok) {
      if (res.value.kind === "parked") { toast(`${a.name}'s run parked for your approval`, "ok"); void refreshApprovals(); }
      else toast(`${a.name} replied`, "ok");
    } else {
      toast(res.error.reason ?? res.error.message, "err");
    }
    void loadAgents();
  }

  function agentForm(initial?: {
    name: string;
    role: string;
    soul: string;
    description?: string;
    objective?: string;
    instructions?: string;
    workerId: string;
  }): {
    fields: {
      name: HTMLInputElement;
      role: HTMLInputElement;
      soul: HTMLTextAreaElement;
      description: HTMLInputElement;
      objective: HTMLTextAreaElement;
      instructions: HTMLTextAreaElement;
      worker: HTMLSelectElement;
    };
    rows: HTMLElement[];
  } {
    const name = h("input", { placeholder: "For example: Migrator", maxlength: "20" }) as HTMLInputElement;
    name.value = initial?.name ?? "";
    const role = h("input", { placeholder: "researcher", value: initial?.role ?? "generalist" }) as HTMLInputElement;
    const soul = h("textarea", { rows: "3", placeholder: "I move database schemas safely and check every migration on a copy first." }) as HTMLTextAreaElement;
    soul.value = initial?.soul ?? "";
    const description = h("input", { placeholder: "One-line description", maxlength: "120" }) as HTMLInputElement;
    description.value = initial?.description ?? "";
    const objective = h("textarea", { rows: "2", placeholder: "What is it responsible for? e.g. Research competitors and report with evidence." }) as HTMLTextAreaElement;
    objective.value = initial?.objective ?? "";
    const instructions = h("textarea", { rows: "3", placeholder: "How should it behave? e.g. Be skeptical, cite sources, stay concise." }) as HTMLTextAreaElement;
    instructions.value = initial?.instructions ?? "";
    const worker = h("select", {});
    for (const w of ["hermes", "opencode"]) worker.append(h("option", { value: w, text: w }));
    worker.value = initial?.workerId ?? "hermes";
    return {
      fields: { name, role, soul, description, objective, instructions, worker },
      rows: [
        h("label", { class: "fld" }, h("span", { text: "Name" }), name),
        h("label", { class: "fld" }, h("span", { text: "Role" }), role),
        h("label", { class: "fld" }, h("span", { text: "Description" }), description),
        h("label", { class: "fld" }, h("span", { text: "What is its soul? (how it thinks and speaks)" }), soul),
        h("label", { class: "fld" }, h("span", { text: "Objective (what it is responsible for)" }), objective),
        h("label", { class: "fld" }, h("span", { text: "System instructions (how it behaves)" }), instructions),
        h("label", { class: "fld" }, h("span", { text: "Worker it runs on" }), worker),
      ],
    };
  }

  function newAgent(): void {
    closeModal();
    const pv = createOrb({ mood: "curious", fx: false, size: 60, hue: 0 });
    const form = agentForm();
    const create = h("button", { class: "btn pri", type: "button", text: "Create agent" });
    const cancel = h("button", { class: "btn", type: "button", text: "Cancel" });
    modal.append(
      h("div", { class: "mhead" }, pv, h("div", {}, h("h3", { text: "New agent" }), h("p", { class: "sub", style: "margin:0", text: "A real KAI subagent with a real soul the runtime loads." }))),
      ...form.rows,
      h("div", { class: "mfoot" }, cancel, create),
    );
    form.fields.name.addEventListener("input", () => setOrbMood(pv, form.fields.name.value ? "listen" : "curious"));
    cancel.addEventListener("click", closeModal);
    create.addEventListener("click", () => {
      const n = form.fields.name.value.trim();
      if (n === "") { setOrbMood(pv, "worry"); form.fields.name.focus(); return; }
      const id = n.toLowerCase().replace(/\W+/g, "-").slice(0, 40) || `agent-${Date.now()}`;
      create.textContent = "Creating…";
      const spec: Parameters<typeof agentApi.createSubagent>[0] = {
        id,
        name: n,
        role: form.fields.role.value.trim() || "generalist",
        soul: form.fields.soul.value.trim() || `I am ${n}, a KAI subagent.`,
        workerId: form.fields.worker.value,
      };
      const description = form.fields.description.value.trim();
      if (description.length > 0) spec.description = description;
      const objective = form.fields.objective.value.trim();
      if (objective.length > 0) spec.objective = objective;
      const instructions = form.fields.instructions.value.trim();
      if (instructions.length > 0) spec.instructions = instructions;
      void agentApi.createSubagent(spec).then((res) => {
        if (res.ok) {
          closeModal();
          toast(`${n} joined your agents`, "ok");
          flashPreview("excited", 2600);
          void loadAgents();
        } else {
          create.textContent = "Create agent";
          setOrbMood(pv, "worry");
          toast(res.error.reason ?? res.error.message, "err");
        }
      });
    });
    modalOv.classList.add("on");
    window.setTimeout(() => form.fields.name.focus(), 50);
  }

  /** Edit an existing persona: objective, instructions and identity persist on save. */
  function editAgent(agent: {
    id: string;
    name: string;
    role: string;
    soul: string;
    description?: string;
    objective?: string;
    instructions?: string;
    workerId: string;
  }): void {
    closeModal();
    const form = agentForm(agent);
    const save = h("button", { class: "btn pri", type: "button", text: "Save" });
    const cancel = h("button", { class: "btn", type: "button", text: "Cancel" });
    modal.append(
      h("div", { class: "mhead" }, h("div", {}, h("h3", { text: `Edit ${agent.name}` }), h("p", { class: "sub", style: "margin:0", text: "Re-defining replaces the persona; future runs use the new objective and instructions." }))),
      ...form.rows,
      h("div", { class: "mfoot" }, cancel, save),
    );
    cancel.addEventListener("click", closeModal);
    save.addEventListener("click", () => {
      const n = form.fields.name.value.trim();
      if (n === "") {
        toast("A name is required", "err");
        return;
      }
      save.textContent = "Saving…";
      const spec: Parameters<typeof agentApi.updateSubagent>[1] = {
        id: agent.id,
        name: n,
        role: form.fields.role.value.trim() || "generalist",
        soul: form.fields.soul.value.trim(),
        workerId: form.fields.worker.value,
      };
      const description = form.fields.description.value.trim();
      if (description.length > 0) spec.description = description;
      const objective = form.fields.objective.value.trim();
      if (objective.length > 0) spec.objective = objective;
      const instructions = form.fields.instructions.value.trim();
      if (instructions.length > 0) spec.instructions = instructions;
      void agentApi.updateSubagent(agent.id, spec).then((res) => {
        if (res.ok) {
          closeModal();
          toast(`${n} updated — future runs use the new instructions`, "ok");
          void loadAgents();
        } else {
          save.textContent = "Save";
          toast(res.error.message, "err");
        }
      });
    });
    modalOv.classList.add("on");
  }

  // ══ TOOLS + MCP ═══════════════════════════════════════════════════════════
  function buildTools(v: HTMLElement, includeBuiltin: boolean): void {
    const sumRow = h("div", { class: "sumrow" });
    const body = h("div", { class: "wrapw" });
    const topr = h("div", { class: "topr" });
    const check = h("button", { class: "pill pri", type: "button", text: "Re-read from Core" });
    check.addEventListener("click", () => { void loadTools(); toast("Re-read the tool registry from Core", "ok"); });
    topr.append(check);
    const top = h("header", { class: "top", style: "padding:22px 0 14px" },
      h("div", {}, h("h2", { text: includeBuiltin ? "Tools and MCP" : "MCP servers" }), h("p", { text: "Everything KAI can use, as Core declares it." })), topr);
    body.append(top, sumRow);
    if (includeBuiltin) {
      body.append(h("div", { class: "sec", text: "Built-in tools" }), h("div", { class: "kp-built" }));
    }
    body.append(h("div", { class: "sec", text: "MCP servers" }), h("div", { class: "kp-mcp" }));
    v.append(h("div", { class: "scroll" }, body));
    v.dataset.builtin = includeBuiltin ? "1" : "0";
  }

  async function loadTools(): Promise<void> {
    const [toolsRes, mcpRes] = await Promise.all([workspace.routes.tools(), workspace.routes.mcp()]);
    if (toolsRes.ok) tools = toolsRes.value;
    if (mcpRes.ok) { mcpServers = mcpRes.value.servers; mcpCapability = mcpRes.value.capability; }
    for (const route of ["tools", "mcp"] as const) renderTools(views.get(route)!);
    renderAbil();
    paintStatus();
  }

  function toolRow(t: ToolDescription): HTMLElement {
    const d = describeTool(t);
    const el = h("div", { class: "trow" });
    el.innerHTML =
      `<span class="ti">${icon("plug")}</span>` +
      `<div><b>${esc(t.name)}</b><small>${esc(t.description)}</small><div class="meta"><span class="chip mut">${esc(t.id)}</span>` +
      `<span class="chip ${d.risk === "READ" ? "ok" : d.risk === "DESTRUCTIVE" ? "err" : "warn"}">${esc(d.risk)}</span>` +
      `<span class="chip mut">${d.fieldCount} input${d.fieldCount === 1 ? "" : "s"}</span></div></div>` +
      `<div class="tcell"><span class="chip mut">${esc(d.effectWord)}</span></div>` +
      `<div class="tcell"><span class="chip mut" title="${esc(d.dispatch)}">${t.permission.sideEffecting ? "parks for approval" : "runs directly"}</span></div>` +
      `<div class="tcell"><span class="chip" title="recent real executions">${"›"}</span></div>`;
    return el;
  }

  function renderTools(v: HTMLElement): void {
    if (!v.isConnected) return;
    const builtinHost = v.querySelector<HTMLElement>(".kp-built");
    const mcpHost = v.querySelector<HTMLElement>(".kp-mcp");
    const sum = v.querySelector<HTMLElement>(".sumrow");
    if (sum === null) return;
    const sideEffecting = tools.filter((t) => t.permission.sideEffecting).length;
    sum.innerHTML =
      `<span class="chip ok">${tools.length} tools registered</span>` +
      `<span class="chip">${sideEffecting} park for approval</span>` +
      `<span class="chip ${mcpCapability.availability === "AVAILABLE" ? "ok" : mcpCapability.availability === "DEGRADED" ? "warn" : "err"}">MCP ${esc(mcpCapability.availability.toLowerCase())}</span>` +
      `<span class="chip mut">${mcpServers.length} MCP servers</span>`;
    if (builtinHost !== null) {
      builtinHost.textContent = "";
      for (const t of tools) builtinHost.append(toolRow(t));
      if (tools.length === 0) builtinHost.append(h("div", { class: "empty", text: "Core reported no registered tools." }));
    }
    if (mcpHost !== null) {
      mcpHost.textContent = "";
      if (mcpServers.length === 0) {
        mcpHost.append(h("div", { class: "empty", text: `No MCP server is registered. Core: "${mcpCapability.detail || "no MCP server is registered"}"` }));
      }
      for (const s of mcpServers) {
        mcpHost.append(mcpServerRow(s));
      }
    }
  }

  /** One MCP server: live status plus the real lifecycle actions. */
  function mcpServerRow(s: McpServerSummary): HTMLElement {
    const st = serverStatus(s);
    const keys = credentialKeys(s);
    const el = h("div", { class: "trow" + (s.enabled ? "" : " off") });
    el.innerHTML =
      `<span class="ti mcp">${icon("plug")}</span>` +
      `<div><b>${esc(s.name)}</b><small>${esc(serverTarget(s))}</small><div class="meta">` +
      `<span class="chip mut">${esc(s.transport)}</span>` +
      `<span class="chip mut">${s.toolCount} tools</span>` +
      (keys.length > 0 ? `<span class="chip mut">cred: ${esc(keys.join(", "))}</span>` : "") +
      `<span class="chip ${st.status === "CONNECTED" ? "ok" : st.status === "BLOCKED" ? "err" : "warn"}">${esc(st.status)}</span></div></div>` +
      `<div class="tcell"><span class="chip mut">${esc(st.reason)}</span></div>`;
    const actions = h("div", { class: "tcell btns" });
    const refresh = (): void => {
      void loadTools();
    };
    const parkNotice = (label: string, approvalId?: string): void => {
      toast(
        approvalId !== undefined
          ? `${label} is waiting for your approval (${approvalId}) — nothing ran yet`
          : `${label} parked for approval`,
        "ok",
      );
      void refreshApprovals();
    };
    const command = (
      label: string,
      cmd: "enable" | "disable" | "connect" | "disconnect" | "refresh",
    ): HTMLButtonElement => {
      const btn = h("button", { class: "mini", type: "button", text: label });
      btn.addEventListener("click", () => {
        void workspace.routes.mcpServerCommand(s.name, cmd).then((res) => {
          if (!res.ok) {
            toast(res.error.reason ?? res.error.message, "err");
            return;
          }
          if (res.value.approvalRequired) {
            parkNotice(`${cmd} ${s.name}`, res.value.approvalId ?? undefined);
            return;
          }
          toast(`${cmd} ${s.name}: ${res.value.status}`, "ok");
          refresh();
        });
      });
      return btn;
    };
    if (s.enabled) {
      actions.append(command(s.connected ? "Disconnect" : "Connect", s.connected ? "disconnect" : "connect"));
      if (s.connected) actions.append(command("Refresh", "refresh"));
      actions.append(command("Disable", "disable"));
    } else {
      actions.append(command("Enable", "enable"));
    }
    // Tools: the live list from the server, each invocable with JSON args.
    const toolsBtn = h("button", { class: "mini", type: "button", text: "Tools" });
    const detail = h("div", { class: "mdetail" });
    let toolsOpen = false;
    toolsBtn.addEventListener("click", () => {
      toolsOpen = !toolsOpen;
      if (!toolsOpen) {
        detail.textContent = "";
        return;
      }
      detail.textContent = "Reading tools…";
      void workspace.routes.mcpServerTools(s.name).then((res) => {
        detail.textContent = "";
        if (!res.ok) {
          detail.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message }));
          return;
        }
        if (res.value.length === 0) {
          detail.append(h("div", { class: "empty", text: "No tools discovered." }));
          return;
        }
        for (const tool of res.value) {
          const row = h("div", { class: "arow" });
          row.append(
            h("div", {}, h("b", { text: tool.name }), h("small", { text: `${tool.id} · ${tool.risk}` })),
          );
          const callBtn = h("button", { class: "mini", type: "button", text: "Call" });
          callBtn.addEventListener("click", () => {
            const raw = window.prompt(`Arguments JSON for ${tool.name} (empty = {}):`, "{}");
            if (raw === null) return;
            let args: unknown = {};
            try {
              args = raw.trim() === "" ? {} : (JSON.parse(raw) as unknown);
            } catch {
              toast("Arguments are not valid JSON", "err");
              return;
            }
            void workspace.routes.mcpCall(s.name, { tool: tool.name, arguments: args, source: "ui" }).then((called) => {
              if (!called.ok) {
                toast(called.error.reason ?? called.error.message, "err");
                return;
              }
              if (called.value.approvalRequired) {
                parkNotice(`call ${tool.name}`, called.value.approvalId ?? undefined);
                return;
              }
              toast(`${tool.name}: ${called.value.status}`, "ok");
            });
          });
          const cell = h("div", { class: "btns" });
          cell.append(callBtn);
          row.append(cell);
          detail.append(row);
        }
      });
    });
    actions.append(toolsBtn);
    // Resources: list, then read one by URI.
    const resBtn = h("button", { class: "mini", type: "button", text: "Resources" });
    resBtn.addEventListener("click", () => {
      toolsOpen = false;
      detail.textContent = "Reading resources…";
      void workspace.routes.mcpServerResources(s.name).then((res) => {
        detail.textContent = "";
        if (!res.ok) {
          detail.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message }));
          return;
        }
        const list = res.value as Array<{ uri?: string; name?: string }>;
        if (list.length === 0) {
          detail.append(h("div", { class: "empty", text: "No resources listed." }));
          return;
        }
        for (const resource of list) {
          const uri = resource.uri ?? "";
          const row = h("div", { class: "arow" });
          row.append(h("div", {}, h("b", { text: resource.name ?? uri }), h("small", { text: uri })));
          const readBtn = h("button", { class: "mini", type: "button", text: "Read" });
          readBtn.addEventListener("click", () => {
            void workspace.routes.mcpReadResource(s.name, uri).then((read) => {
              if (!read.ok) {
                toast(read.error.reason ?? read.error.message, "err");
                return;
              }
              closeModal();
              modal.append(
                h("div", { class: "mhead" }, h("div", {}, h("h3", { text: resource.name ?? uri }), h("p", { class: "sub", style: "margin:0", text: uri }))),
                h("pre", { style: "white-space:pre-wrap", text: JSON.stringify(read.value, null, 2).slice(0, 6000) }),
              );
              modalOv.classList.add("on");
            });
          });
          const cell = h("div", { class: "btns" });
          cell.append(readBtn);
          row.append(cell);
          detail.append(row);
        }
      });
    });
    actions.append(resBtn);
    el.append(actions);
    const wrap = h("div", { class: "mcpwrap" });
    wrap.append(el, detail);
    return wrap;
  }

  // ══ ACTIVITY ══════════════════════════════════════════════════════════════
  let activityGroup: ActivityGroup = "all";
  function buildActivity(v: HTMLElement): void {
    const groups = h("div", { class: "sumrow" });
    for (const g of ACTIVITY_GROUPS) {
      const b = h("button", { class: "chip " + (g.id === "all" ? "" : "mut"), type: "button", text: g.label });
      b.dataset.g = g.id;
      b.addEventListener("click", () => { activityGroup = g.id; void renderActivity(); });
      groups.append(b);
    }
    const feed = h("div", { class: "tl kp-feed" });
    v.append(h("div", { class: "scroll" }, h("div", { class: "wrapw" },
      h("header", { class: "top", style: "padding:22px 0 14px" }, h("div", {}, h("h2", { text: "Activity" }), h("p", { text: "Everything KAI has really done, from the Core event stream." }))),
      groups, feed)));
  }
  /** Detail lines prefixed "Reasoning:" render as quiet italic rows. */
  function reasoningLines(e: { text: string; line: string }): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const src of [e.text, e.line]) {
      for (const raw of src.split("\n")) {
        const t = raw.trim();
        if (t.startsWith("Reasoning:") && !seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      }
    }
    return out;
  }
  async function renderActivity(): Promise<void> {
    const v = views.get("activity")!;
    const feed = v.querySelector<HTMLElement>(".kp-feed");
    if (feed === null) return;
    feed.textContent = "";
    // Display pref: OFF hides the feed with a pointer to Settings.
    if (orchPrefs.activity === "OFF") {
      feed.append(h("div", { class: "empty", text: "Activity is off — event cards and this feed are hidden. Turn it back on in Settings." }));
      const go = h("button", { class: "mini", type: "button", text: "Open Settings" });
      go.addEventListener("click", () => show("settings"));
      feed.append(h("div", { class: "btns" }, go));
      return;
    }
    const rows = filterActivity(workspace.getState().events, activityGroup, "");
    if (rows.length === 0) { feed.append(h("div", { class: "empty", text: "Nothing yet. Every real tool call, approval and agent hand-off shows up here." })); return; }
    for (const e of rows.slice(0, 200)) {
      feed.append(h("div", { class: "ev", style: `--evc:${groupColor(e.type)}` },
        h("b", { text: e.line }),
        h("small", { html: `${esc(e.type)}, ${esc(relativeTime(e.at))}` })));
      for (const r of reasoningLines(e)) {
        feed.append(h("div", { class: "ev", style: `--evc:${groupColor(e.type)};font-style:italic;opacity:0.72` },
          h("small", { text: r })));
      }
    }
  }

  // ══ SESSIONS ══════════════════════════════════════════════════════════════
  function buildSessions(v: HTMLElement): void {
    const list = h("div", { class: "kp-sessions wrapw" });
    v.append(h("div", { class: "scroll" }, h("header", { class: "top", style: "padding:22px 0 14px" }, h("div", {}, h("h2", { text: "Sessions" }), h("p", { text: "Your conversations with KAI — real, on Core." }))), list));
  }
  // Same generation guard as the transcript: overlapping list loads resolve
  // in either order, and a stale one must not resurrect deleted sessions.
  let sessionsSeq = 0;
  async function loadSessions(): Promise<void> {
    const seq = ++sessionsSeq;
    const res = await client.sessions({ includeArchived: true, limit: 100 });
    if (seq !== sessionsSeq) return;
    if (res.ok) sessions = res.value.sessions;
    const list = views.get("sessions")!.querySelector<HTMLElement>(".kp-sessions");
    if (list === null) return;
    list.textContent = "";
    const sessionRoutes = createSessionRoutes({ baseUrl: client.baseUrl });
    for (const s of sessions) {
      const shown = sessionDisplayTitle(s.title, undefined);
      const isActive = activeSession !== null && activeSession.id === s.id;
      // Core's persisted digest, one line when the session has turns.
      const objective = s.summary?.objective.trim() ?? "";
      const excerpt = objective.length > 90 ? `${objective.slice(0, 87).trimEnd()}…` : objective;
      const meta = `${s.status.toLowerCase()} · ${s.turnCount ?? 0} turns · ${s.agentId ?? "no worker yet"}${excerpt.length > 0 ? ` · ${excerpt}` : ""}`;
      const row = h("div", { class: "arow" },
        h("div", {}, h("b", { text: shown.title }), h("small", { text: meta })));
      const actions = h("div", { class: "btns" });
      const openBtn = h("button", { class: "mini", type: "button", text: isActive ? "Active" : "Open" });
      openBtn.addEventListener("click", () => { void openSession(s.id); });
      actions.append(openBtn);
      const detailsBtn = h("button", { class: "mini", type: "button", text: "Details" });
      detailsBtn.addEventListener("click", () => showSessionDetails(s.id));
      actions.append(detailsBtn);
      const dupBtn = h("button", { class: "mini", type: "button", text: "Fork" });
      dupBtn.addEventListener("click", () => {
        void sessionRoutes.duplicate(s.id, { title: `${s.title} (fork)` }).then((res) => {
          if (!res.ok) {
            toast(res.error.reason ?? res.error.message, "err");
            return;
          }
          if (res.value.kind === "parked") {
            toast("Fork is waiting for your approval — nothing copied yet", "ok");
            void refreshApprovals();
            return;
          }
          toast("Session forked", "ok");
          void loadSessions();
        });
      });
      actions.append(dupBtn);
      const clearBtn = h("button", { class: "mini", type: "button", text: "Clear" });
      clearBtn.addEventListener("click", () => {
        if (!window.confirm(`Clear all turns in “${s.title}”? The digest survives; the transcript does not.`)) return;
        void sessionRoutes.clear(s.id).then((res) => {
          if (!res.ok) {
            toast(res.error.reason ?? res.error.message, "err");
            return;
          }
          if (res.value.kind === "parked") {
            toast("Clear is waiting for your approval — nothing removed yet", "ok");
            void refreshApprovals();
            return;
          }
          toast(`Cleared ${res.value.removed ?? 0} turn(s)`, "ok");
          loadedSessionId = null;
          void refreshActive();
          void loadSessions();
        });
      });
      actions.append(clearBtn);
      const exportBtn = h("button", { class: "mini", type: "button", text: "Export" });
      exportBtn.addEventListener("click", () => { void exportSession(s.id, s.title); });
      actions.append(exportBtn);
      row.append(actions);
      list.append(row);
    }
    if (sessions.length === 0) list.append(h("div", { class: "empty", text: "No sessions yet." }));
  }
  /** Session details: the persisted facts, from Core — never derived locally. */
  function showSessionDetails(id: string): void {
    const found = sessions.find((row) => row.id === id);
    if (found === undefined) {
      toast("Session is no longer listed — reloading", "err");
      void loadSessions();
      return;
    }
    closeModal();
    const toolsUsed = found.summary?.toolsUsed.join(", ") ?? "none yet";
    const files = found.summary?.files.slice(0, 5).join("\n") ?? "";
    const grid = h("div", {});
    const rows: Array<[string, string]> = [
      ["title", found.title],
      ["id", found.id],
      ["status", found.status],
      ["kind", found.sessionKind ?? "kai-conversation"],
      ["turns", String(found.turnCount ?? 0)],
      ["created", found.createdAt],
      ["updated", found.updatedAt],
      ["last activity", found.lastTurnAt ?? "—"],
      ["objective", found.summary?.objective || "(no turns yet)"],
      ["tools used", toolsUsed],
    ];
    if (files.length > 0) rows.push(["files", files]);
    for (const [k, v] of rows) {
      grid.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: k }), h("small", { text: v }))));
    }
    const openBtn = h("button", { class: "btn pri", type: "button", text: "Open session" });
    openBtn.addEventListener("click", () => {
      closeModal();
      void openSession(id);
    });
    const closeBtn = h("button", { class: "btn", type: "button", text: "Close" });
    closeBtn.addEventListener("click", closeModal);
    modal.append(
      h("div", { class: "mhead" }, h("div", {}, h("h3", { text: "Session details" }), h("p", { class: "sub", style: "margin:0", text: "Persisted state, read from Core." }))),
      grid,
      h("div", { class: "mfoot" }, closeBtn, openBtn),
    );
    modalOv.classList.add("on");
  }

  /** Export a session transcript + digest as a JSON download. */
  async function exportSession(id: string, title: string): Promise<void> {
    const [turnsRes, sessionRes] = await Promise.all([
      client.sessionTurns(id, { limit: 10000 }),
      client.sessions({ limit: 500 }),
    ]);
    if (!turnsRes.ok) {
      toast(turnsRes.error.reason ?? turnsRes.error.message, "err");
      return;
    }
    const session = sessionRes.ok ? sessionRes.value.sessions.find((row) => row.id === id) ?? null : null;
    const payload = {
      exportedAt: new Date().toISOString(),
      exportedBy: "kai",
      session,
      turns: turnsRes.value,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kai-session-${id}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Exported “${title}” (${turnsRes.value.length} turns)`, "ok");
  }

  async function openSession(id: string): Promise<void> {
    const res = await client.activateSession(id);
    if (!res.ok) { toast(res.error.reason ?? res.error.message, "err"); return; }
    loadedSessionId = null;
    await refreshActive();
    show("chat");
    toast("Session opened", "ok");
  }

  // ══ OVERVIEW (home) ═══════════════════════════════════════════════════════
  function buildOverview(v: HTMLElement): void {
    v.append(h("div", { class: "scroll" }, h("div", { class: "wrapw" },
      h("header", { class: "top", style: "padding:22px 0 14px" }, h("div", {}, h("h2", { text: "Home" }), h("p", { text: "Where KAI is, right now — read from Core." }))),
      h("div", { class: "sumrow kp-ov" }),
      h("div", { class: "kp-ov-sections" }))));
  }
  async function renderOverview(): Promise<void> {
    const host = views.get("home")!.querySelector<HTMLElement>(".kp-ov");
    if (host === null) return;
    // Fresh sessions for the Recent section (bounded list, same call the
    // Sessions page uses).
    const sessionsRes = await client.sessions({ limit: 20 });
    if (sessionsRes.ok) sessions = sessionsRes.value.sessions;
    const st = await client.state();
    const conn = workspace.getState().conn;
    const s = st.ok ? st.value : null;
    host.innerHTML =
      `<span class="chip ${conn === "ONLINE" ? "ok" : conn === "OFFLINE" ? "err" : "warn"}">Core ${esc(conn.toLowerCase())}</span>` +
      `<span class="chip">${tools.length} tools</span>` +
      `<span class="chip">${agents.length} agents</span>` +
      `<span class="chip">${mcpServers.length} MCP servers</span>` +
      `<span class="chip">${s?.missions?.active ?? 0} active missions</span>` +
      `<span class="chip">${s?.approvals?.pending ?? approvals.length} pending approvals</span>` +
      `<span class="chip mut">build ${esc(identity.buildId ?? "unknown")}</span>`;
    // Useful sections, every row real: recent sessions (open on click),
    // pending approvals (drawer on click), in-flight agent runs.
    const sections = views.get("home")!.querySelector<HTMLElement>(".kp-ov-sections");
    if (sections === null) return;
    sections.textContent = "";
    const recent = sessions.filter((row) => row.status === "ACTIVE").slice(0, 5);
    if (recent.length > 0) {
      const box = h("div", { class: "ovsec" }, h("h4", { text: "Recent sessions" }));
      for (const row of recent) {
        const b = h("button", { class: "arow", type: "button" });
        b.append(h("div", {}, h("b", { text: sessionDisplayTitle(row.title, undefined).title }), h("small", { text: `${row.turnCount ?? 0} turns` })));
        b.addEventListener("click", () => void openSession(row.id));
        box.append(b);
      }
      sections.append(box);
    }
    if (approvals.length > 0) {
      const box = h("div", { class: "ovsec" }, h("h4", { text: `Pending approvals (${approvals.length})` }));
      for (const approval of approvals.slice(0, 5)) {
        const b = h("button", { class: "arow", type: "button" });
        b.append(h("div", {}, h("b", { text: approval.toolId }), h("small", { text: approval.reason.slice(0, 120) })));
        b.addEventListener("click", () => app.classList.add("drawer"));
        box.append(b);
      }
      sections.append(box);
    }
    if (agentRuns.length > 0) {
      const box = h("div", { class: "ovsec" }, h("h4", { text: `Running work (${agentRuns.length})` }));
      for (const run of agentRuns.slice(0, 5)) {
        box.append(
          h("div", { class: "arow" }, h("div", {}, h("b", { text: run.subagentId }), h("small", { text: run.status === "parked" ? "waiting on approval" : "executing" }))),
        );
      }
      sections.append(box);
    }
  }

  // ══ simple real list pages (missions, workers, memory) ════════════════════
  function simplePage(route: RouteId, title: string, blurb: string): HTMLElement {
    const host = h("div", { class: "kp-list wrapw" });
    views.get(route)!.append(h("div", { class: "scroll" },
      h("header", { class: "top", style: "padding:22px 0 14px" }, h("div", {}, h("h2", { text: title }), h("p", { text: blurb }))), host));
    return host;
  }
  function buildLists(): void {
    // Idempotent: re-priming must REBUILD these pages, never stack a second copy.
    for (const route of ["missions", "workers", "memory", "skills", "settings"] as const) {
      views.get(route)!.textContent = "";
    }
    const host = simplePage("missions", "Missions", "Work KAI is carrying out — from Core. DRAFT entries are plans awaiting approval.");
    const missionRows = h("div", {});
    host.append(missionRows);
    async function paintMissions(): Promise<void> {
      missionRows.textContent = "";
      const res = await client.missions({ limit: 50 });
      if (!res.ok) {
        missionRows.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message }));
        return;
      }
      if (res.value.length === 0) {
        missionRows.append(h("div", { class: "empty", text: "No missions recorded. Use /plan <goal> to draft one." }));
        return;
      }
      for (const m of res.value) missionRows.append(missionRow(m, () => void paintMissions()));
    }
    void paintMissions();
    // A /plan drafts a mission after boot, so re-read on visit (same class as
    // the bench refresh): a freshly planned mission must appear without reload.
    refreshMissions = () => void paintMissions();
    const whost = simplePage("workers", "Workforce", "The engines KAI drives — from Core.");
    void client.agents().then((res) => {
      if (!res.ok) { whost.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message })); return; }
      for (const a of res.value) whost.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: a.id }), h("small", { text: `${a.state}${a.health !== undefined ? ` · ${a.health.ok ? "healthy" : "unreachable"}` : ""}` }))));
    });
    // Bench: measured worker profiles with evidence, from GET /bench.
    const benchHost = h("div", {});
    whost.append(h("h4", { text: "Benchmarks" }), benchHost);
    async function paintBench(): Promise<void> {
      benchHost.textContent = "";
      const res = await client.getBench();
      if (!res.ok) {
        benchHost.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message }));
        return;
      }
      if (res.value.length === 0) {
        benchHost.append(h("div", { class: "empty", text: "No benchmark data yet — completed work teaches the bench." }));
        return;
      }
      for (const entry of res.value) benchHost.append(benchRow(entry));
    }
    void paintBench();
    // Bench is the only list page with no other refresh trigger (skills and
    // settings repaint locally on change): re-read it on every visit so a
    // worker that just completed appears without a reload.
    refreshWorkersBench = () => void paintBench();
    const mhost = simplePage("memory", "Memory", "What KAI remembers — from Core, with provenance.");
    const msearch = h("input", { placeholder: "Search memories…", "aria-label": "Search memories" }) as HTMLInputElement;
    mhost.append(msearch);
    const mrows = h("div", {});
    mhost.append(mrows);
    async function paintMemories(): Promise<void> {
      const q = msearch.value.trim();
      mrows.textContent = "";
      if (q.length > 0) {
        const res = await client.searchMemoryEntries(q, { limit: 50 });
        if (!res.ok) {
          mrows.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message }));
          return;
        }
        if (res.value.length === 0) {
          mrows.append(h("div", { class: "empty", text: `No memories match “${q}”.` }));
          return;
        }
        const refresh = (): void => {
          void paintMemories();
        };
        for (const entry of res.value) mrows.append(memoryRow(entry, refresh));
        return;
      }
      const res = await client.memory({ limit: 100 });
      if (!res.ok) {
        mrows.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message }));
        return;
      }
      if (res.value.length === 0) {
        mrows.append(h("div", { class: "empty", text: "Core holds no memories yet. Say “remember that …” to store one." }));
        return;
      }
      mrows.append(
        h(
          "div",
          { class: "empty", text: "Showing the legacy list — search above for ranked recall with provenance." },
        ),
      );
      for (const m of res.value.slice(0, 100)) {
        const rec = m as Record<string, unknown>;
        mrows.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: String(rec.type ?? "memory") }), h("small", { text: String(rec.content ?? "").slice(0, 160) }))));
      }
    }
    let msearchTimer: ReturnType<typeof setTimeout> | null = null;
    msearch.addEventListener("input", () => {
      if (msearchTimer !== null) clearTimeout(msearchTimer);
      msearchTimer = setTimeout(() => void paintMemories(), 300);
    });
    void paintMemories();
    // Skills are read from Core's real registry: installed skills with their
    // purpose/tools/constraints and enabled state, plus the staging area where
    // learned skills wait for approval. Mutations go through the policy-gated
    // routes — a 409 is shown as a park, never faked into a change.
    const khost = simplePage("skills", "Skills", "Procedures KAI has learned.");
    const krows = h("div", {});
    khost.append(krows);
    const kstaging = h("div", {});
    khost.append(kstaging);
    async function paintSkills(): Promise<void> {
      krows.textContent = "";
      kstaging.textContent = "";
      const res = await client.skills();
      if (!res.ok) {
        krows.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message }));
      } else if (res.value.length === 0) {
        krows.append(h("div", { class: "empty", text: "Core holds no learned skills yet." }));
      } else {
        const builtins = res.value.filter((s) => s.source === "builtin").length;
        krows.append(h("h4", { text: `${res.value.length} skills (${builtins} KAI builtins, ${res.value.length - builtins} library)` }));
        for (const s of res.value) krows.append(skillRow(s, () => void paintSkills()));
      }
      const staged = await client.stagedSkills();
      if (staged.ok && staged.value.length > 0) {
        kstaging.append(h("h4", { text: `Staged — awaiting approval (${staged.value.length})` }));
        for (const item of staged.value) kstaging.append(stagedRow(item, () => void paintSkills()));
      }
    }
    void paintSkills();
    const shost = simplePage("settings", "Settings", "How KAI behaves.");
    void client.state().then((res) => {
      const s = res.ok ? res.value : null;
      shost.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: "Core build" }), h("small", { text: identity.buildId ?? "unknown" }))));
      if (s?.database?.path !== undefined) shost.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: "Database" }), h("small", { text: s.database.path }))));
      if (s?.scheduler !== undefined) shost.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: "Scheduler" }), h("small", { text: `${s.scheduler.running ? "running" : "stopped"} · ${s.scheduler.enabled ?? 0}/${s.scheduler.total ?? 0} enabled` }))));
    });
    // KAI's soul: the live text + version, editable through the policy-gated
    // POST /soul (parks for a human — a parked edit changes nothing).
    const soulRow = h("div", { class: "arow" }, h("div", {}, h("b", { text: "Soul" }), h("small", { text: "loading…" })));
    shost.append(soulRow);
    void client.getSoul().then((res) => {
      const small = soulRow.querySelector("small");
      if (!res.ok) {
        if (small !== null) small.textContent = res.error.reason ?? res.error.message;
        return;
      }
      if (small !== null) small.textContent = `identity v${res.value.version}`;
      const actions = h("div", { class: "btns" });
      const viewBtn = h("button", { class: "mini", type: "button", text: "View soul" });
      viewBtn.addEventListener("click", () => {
        closeModal();
        modal.append(
          h("div", { class: "mhead" }, h("div", {}, h("h3", { text: `Soul (v${res.value.version})` }), h("p", { class: "sub", style: "margin:0", text: "Who KAI is. Edits take effect on the next turn." }))),
          h("pre", { style: "white-space:pre-wrap", text: res.value.soul }),
        );
        modalOv.classList.add("on");
      });
      const editBtn = h("button", { class: "mini", type: "button", text: "Edit soul" });
      editBtn.addEventListener("click", () => {
        closeModal();
        const area = h("textarea", { rows: "10", style: "width:100%", text: res.value.soul }) as HTMLTextAreaElement;
        const save = h("button", { class: "btn pri", type: "button", text: "Save soul" });
        const cancel = h("button", { class: "btn", type: "button", text: "Cancel" });
        cancel.addEventListener("click", closeModal);
        save.addEventListener("click", () => {
          const next = area.value.trim();
          if (next.length === 0) return;
          save.textContent = "Saving…";
          void client.setSoul(next).then((saved) => {
            if (saved.ok) {
              closeModal();
              toast("Soul updated — KAI's next turn uses it", "ok");
              return;
            }
            if (saved.error.status === 409) {
              closeModal();
              toast("Soul change is waiting for your approval — nothing changed yet", "ok");
              void refreshApprovals();
              return;
            }
            save.textContent = "Save soul";
            toast(saved.error.reason ?? saved.error.message, "err");
          });
        });
        modal.append(
          h("div", { class: "mhead" }, h("div", {}, h("h3", { text: "Edit soul" }), h("p", { class: "sub", style: "margin:0", text: "Replacing what KAI is requires approval." }))),
          area,
          h("div", { class: "mfoot" }, cancel, save),
        );
        modalOv.classList.add("on");
      });
      actions.append(viewBtn, editBtn);
      soulRow.append(actions);
    });
    // KAI's model: the EFFECTIVE values with their winning source per key, and
    // inputs that persist a patch through the parking `POST /settings` — the
    // next turn uses it, no restart. The key itself is never stored here: the
    // row only says whether one is configured.
    const modelRow = h("div", { class: "arow" }, h("div", {}, h("b", { text: "Model" }), h("small", { text: "loading…" })));
    shost.append(modelRow);
    async function paintModel(): Promise<void> {
      const res = await client.getSettings();
      const small = modelRow.querySelector("small");
      modelRow.querySelectorAll(".btns,.mset").forEach((n) => n.remove());
      if (!res.ok) {
        if (small !== null) small.textContent = res.error.reason ?? res.error.message;
        return;
      }
      const eff = res.value.effective;
      if (small !== null) {
        small.textContent =
          `${eff.values.name} · ${eff.values.baseUrl} · ${eff.values.timeoutMs}ms · key ${eff.values.apiKeyConfigured ? "set" : "missing"}`;
      }
      const src = h("div", { class: "mset" });
      src.append(h("div", { text: `name ← ${eff.sources.name} · endpoint ← ${eff.sources.baseUrl} · timeout ← ${eff.sources.timeoutMs}` }));
      const nameIn = h("input", { type: "text", placeholder: "model.name (blank keeps current)" }) as HTMLInputElement;
      const urlIn = h("input", { type: "text", placeholder: "model.baseUrl (blank keeps current)" }) as HTMLInputElement;
      const timeoutIn = h("input", { type: "text", placeholder: "model.timeoutMs (blank keeps current)" }) as HTMLInputElement;
      const actions = h("div", { class: "btns" });
      const save = h("button", { class: "mini", type: "button", text: "Save model settings" });
      save.addEventListener("click", () => {
        const patch: Record<string, string> = {};
        if (nameIn.value.trim().length > 0) patch["model.name"] = nameIn.value.trim();
        if (urlIn.value.trim().length > 0) patch["model.baseUrl"] = urlIn.value.trim();
        if (timeoutIn.value.trim().length > 0) patch["model.timeoutMs"] = timeoutIn.value.trim();
        if (Object.keys(patch).length === 0) return;
        save.textContent = "Saving…";
        void client.updateSettings(patch).then((saved) => {
          if (saved.ok) {
            toast("Model settings updated — KAI's next turn uses them", "ok");
            void paintModel();
            return;
          }
          if (saved.error.status === 409) {
            toast("Model change is waiting for your approval — nothing changed yet", "ok");
            void refreshApprovals();
          } else {
            toast(saved.error.reason ?? saved.error.message, "err");
          }
          save.textContent = "Save model settings";
        });
      });
      const reset = h("button", { class: "mini", type: "button", text: "Reset to defaults" });
      reset.addEventListener("click", () => {
        reset.textContent = "Resetting…";
        void client.resetSettings().then((cleared) => {
          if (cleared.ok) {
            toast("Model settings reset — lower layers apply again", "ok");
            void paintModel();
          } else if (cleared.error.status === 409) {
            toast("Reset is waiting for your approval — nothing changed yet", "ok");
            void refreshApprovals();
          } else {
            toast(cleared.error.reason ?? cleared.error.message, "err");
          }
          reset.textContent = "Reset to defaults";
        });
      });
      actions.append(save, reset);
      src.append(nameIn, urlIn, timeoutIn);
      modelRow.append(src, actions);
    }
    void paintModel();
    // Providers + models: the ONE live registry, rendered. KAI's own model is
    // selectable here (persists, applies on the next turn, no restart); worker
    // models are shown but not selectable — KAI has no per-request worker
    // override, and the UI says so instead of faking it. Credentials are
    // configured/not-configured only: values never appear, before or after save.
    const provHost = h("div", {});
    shost.append(provHost);
    async function paintProviders(): Promise<void> {
      provHost.textContent = "";
      const res = await client.getProviders();
      if (!res.ok) {
        provHost.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: "Providers" }), h("small", { text: res.error.reason ?? res.error.message }))));
        return;
      }
      for (const p of res.value) {
        const state = p.reachable ? (p.authorized ? "READY" : "REACHABLE (not authorized)") : `OFFLINE (${p.reason ?? "no reason"})`;
        const bits = [
          state,
          `auth: ${p.authConfigured ? "configured" : "not configured"}`,
          ...(p.version !== undefined ? [`v${p.version}`] : []),
          ...(p.latencyMs !== undefined ? [`${p.latencyMs}ms`] : []),
        ];
        const row = h("div", { class: "arow" }, h("div", {}, h("b", { text: `${p.label}${p.current ? " · backing KAI" : ""}` }), h("small", { text: `${p.baseUrl} · ${bits.join(" · ")}` })));
        const actions = h("div", { class: "btns" });
        if (p.kind === "model") {
          const models = await client.listModels();
          const mine = models.ok ? (models.value.find((m) => m.id === p.id)?.models ?? []) : [];
          const select = h("select", {}) as HTMLSelectElement;
          const current = mine.find((m) => m.current);
          for (const m of mine) select.append(h("option", { value: m.id, text: `${m.id}${m.current ? " (active)" : ""}` }));
          if (current !== undefined) select.value = current.id;
          select.addEventListener("change", () => {
            const wanted = select.value;
            if (wanted.length === 0) return;
            void client.useModel(wanted).then((saved) => {
              if (saved.ok) {
                toast(`KAI's next turn uses ${wanted}`, "ok");
                void paintProviders();
                void paintModel();
                return;
              }
              if (saved.error.status === 409) {
                toast("Model change is waiting for your approval — nothing changed yet", "ok");
                void refreshApprovals();
                return;
              }
              toast(saved.error.reason ?? saved.error.message, "err");
            });
          });
          actions.append(select);
        } else {
          actions.append(h("span", { class: "hint", text: p.models.length > 0 ? `models: ${p.models.map((m) => m.id).join(", ")}` : (p.modelsNote ?? "no catalogue") }));
        }
        const test = h("button", { class: "mini", type: "button", text: "Test" });
        test.addEventListener("click", () => {
          test.textContent = "Testing…";
          void client.testProvider(p.id).then((tested) => {
            test.textContent = "Test";
            if (!tested.ok) {
              toast(tested.error.reason ?? tested.error.message, "err");
              return;
            }
            const t = tested.value;
            toast(t.ok ? `${p.label}: CONNECTED${t.latencyMs !== undefined ? ` (${t.latencyMs}ms)` : ""}` : `${p.label}: FAILED — ${t.reason}`, t.ok ? "ok" : "err");
            void paintProviders();
          });
        });
        actions.append(test);
        row.append(actions);
        provHost.append(row);
      }
      provHost.append(h("div", {
        class: "hint",
        text: "Worker models are listed, not selectable. KAI's own key lives in its environment or credential file; the Hermes key lives in the OS credential store (Settings window → KAI's worker). Values are never shown here.",
      }));
    }
    void paintProviders();
    // Autonomy: the orchestration.* prefs after the Providers section. Loads
    // the current block from GET /settings, saves only changed keys through
    // the parking POST /settings (409 → toast + refreshApprovals, like Model).
    const autonomyHost = h("div", {});
    shost.append(autonomyHost);
    async function paintAutonomy(): Promise<void> {
      autonomyHost.textContent = "";
      autonomyHost.append(
        h(
          "div",
          { class: "arow" },
          h(
            "div",
            {},
            h("b", { text: "Autonomy" }),
            h("small", { text: "How independently KAI may work. Writes park for approval like model settings." }),
          ),
        ),
      );
      const res = await client.getSettings();
      if (!res.ok) {
        autonomyHost.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message }));
        return;
      }
      if (res.value.orchestration === undefined) {
        autonomyHost.append(h("div", { class: "empty", text: "Core did not report orchestration preferences." }));
        return;
      }
      const eff = readOrchEff(res.value.orchestration);
      const LEVEL_LABELS = ["0 Advisor", "1 Delegator", "2 Operator", "3 Guardian", "4 Autonomous"];
      autonomyHost.append(
        h(
          "div",
          { class: "mset" },
          h("div", {
            text: `effective: level ${eff.level} (${LEVEL_LABELS[eff.level]?.slice(2) ?? "?"}) · worker ${eff.workerAuto} · review ${eff.review} · learning ${eff.skillLearning} · activity ${eff.activity} · reasoning ${eff.reasoning} · tools ${eff.toolsView} · agents ${eff.agentsView} · depth ${eff.maxDepth} · parallel ${eff.maxParallel} · retries ${eff.maxRetries} · retention ${eff.retention}d`,
          }),
        ),
      );
      const pick = (options: string[], current: string): HTMLSelectElement => {
        const s = h("select", {}) as HTMLSelectElement;
        for (const o of options) s.append(h("option", { value: o, text: o }));
        s.value = current;
        return s;
      };
      const num = (value: number, min: number, max: number): HTMLInputElement => {
        const input = h("input", { type: "number", value: String(value), min: String(min), max: String(max) }) as HTMLInputElement;
        input.style.width = "72px";
        return input;
      };
      const levelSel = pick(LEVEL_LABELS, LEVEL_LABELS[eff.level] ?? LEVEL_LABELS[2]!);
      const workerAutoSel = pick(["AUTO", "ASK", "OFF"], eff.workerAuto);
      const reviewSel = pick(["AUTO", "ASK", "OFF"], eff.review);
      const skillSel = pick(["OFF", "PROPOSE", "AUTO_SAFE"], eff.skillLearning);
      const activitySel = pick(["OFF", "COMPACT", "VERBOSE"], eff.activity);
      const reasoningSel = pick(["HIDDEN", "SUMMARY", "PROVIDER_EXPOSED"], eff.reasoning);
      const toolsSel = pick(["COLLAPSED", "EXPANDED"], eff.toolsView);
      const agentsSel = pick(["COMPACT", "DETAILED"], eff.agentsView);
      const depthIn = num(eff.maxDepth, 1, 5);
      const parallelIn = num(eff.maxParallel, 1, 10);
      const retriesIn = num(eff.maxRetries, 0, 5);
      const retentionIn = num(eff.retention, 1, 365);
      const selRow = (label: string, hint: string, control: HTMLElement): HTMLElement =>
        h("div", { class: "arow" }, h("div", {}, h("b", { text: label }), h("small", { text: hint })), h("div", { class: "btns" }, control));
      autonomyHost.append(
        selRow("Autonomy level", "0 Advisor · 1 Delegator · 2 Operator · 3 Guardian · 4 Autonomous", levelSel),
        selRow("Worker start", "AUTO runs workers directly · ASK parks · OFF blocks delegation", workerAutoSel),
        selRow("Review", "AUTO verifies silently · ASK asks · OFF skips review", reviewSel),
        selRow("Skill learning", "OFF · PROPOSE stages for approval · AUTO_SAFE installs safe ones", skillSel),
        selRow("Activity feed", "OFF hides cards and the route · COMPACT hides payloads · VERBOSE shows them", activitySel),
        selRow("Reasoning", "HIDDEN · SUMMARY · PROVIDER_EXPOSED", reasoningSel),
        selRow("Tools view", "COLLAPSED groups settled cards · EXPANDED leaves every card open", toolsSel),
        selRow("Agents view", "COMPACT short rows · DETAILED adds objective and every capability", agentsSel),
        selRow("Max depth", "delegation depth, 1–5", depthIn),
        selRow("Max parallel", "parallel children, 1–10", parallelIn),
        selRow("Max retries", "retries per item, 0–5", retriesIn),
        selRow("Retention", "task retention, 1–365 days", retentionIn),
      );
      const actions = h("div", { class: "btns" });
      const save = h("button", { class: "mini", type: "button", text: "Save autonomy" });
      save.addEventListener("click", () => {
        const clamp = (input: HTMLInputElement, min: number, max: number, fallback: number): string => {
          const n = Number(input.value);
          return String(Number.isInteger(n) && n >= min && n <= max ? n : fallback);
        };
        const want: Array<[string, string, string]> = [
          ["orchestration.autonomy", String(LEVEL_LABELS.indexOf(levelSel.value)), String(eff.level)],
          ["orchestration.workerAuto", workerAutoSel.value, eff.workerAuto],
          ["orchestration.review", reviewSel.value, eff.review],
          ["orchestration.skillLearning", skillSel.value, eff.skillLearning],
          ["orchestration.activity", activitySel.value, eff.activity],
          ["orchestration.reasoning", reasoningSel.value, eff.reasoning],
          ["orchestration.toolsView", toolsSel.value, eff.toolsView],
          ["orchestration.agentsView", agentsSel.value, eff.agentsView],
          ["orchestration.maxDepth", clamp(depthIn, 1, 5, eff.maxDepth), String(eff.maxDepth)],
          ["orchestration.maxParallel", clamp(parallelIn, 1, 10, eff.maxParallel), String(eff.maxParallel)],
          ["orchestration.maxRetries", clamp(retriesIn, 0, 5, eff.maxRetries), String(eff.maxRetries)],
          ["orchestration.taskRetentionDays", clamp(retentionIn, 1, 365, eff.retention), String(eff.retention)],
        ];
        const patch: Record<string, string> = {};
        for (const [k, v, cur] of want) if (v !== cur) patch[k] = v;
        if (Object.keys(patch).length === 0) {
          toast("No autonomy changes to save", "ok");
          return;
        }
        save.textContent = "Saving…";
        void client.updateSettings(patch).then((saved) => {
          if (saved.ok) {
            toast("Autonomy updated — takes effect immediately", "ok");
            void refreshOrchPrefs().then(() => {
              void paintAutonomy();
              renderAgents();
              if (view === "activity") void renderActivity();
            });
            return;
          }
          if (saved.error.status === 409) {
            toast("Autonomy change is waiting for your approval — nothing changed yet", "ok");
            void refreshApprovals();
          } else {
            toast(saved.error.reason ?? saved.error.message, "err");
          }
          save.textContent = "Save autonomy";
        });
      });
      actions.append(save);
      autonomyHost.append(actions);
    }
    void paintAutonomy();
  }

  /** One installed skill: metadata, provenance and lifecycle actions. */
  function skillRow(
    skill: {
      id: string;
      name: string;
      description: string;
      purpose?: string;
      tools?: string[];
      constraints?: string[];
      tags: string[];
      version?: string;
      source: string;
      contentHash: string;
      status: "enabled" | "disabled";
      revision: number;
    },
    refresh: () => void,
  ): HTMLElement {
    const bits = [`${skill.status}`, `v${skill.version ?? "?"}`, `rev ${skill.revision}`, skill.source];
    if (skill.purpose !== undefined && skill.purpose.length > 0) bits.unshift(skill.purpose.slice(0, 90));
    const row = h(
      "div",
      { class: "arow" },
      h("div", {}, h("b", { text: skill.name }), h("small", { text: bits.join(" · ") })),
    );
    const actions = h("div", { class: "btns" });
    const viewBtn = h("button", { class: "mini", type: "button", text: "Details" });
    viewBtn.addEventListener("click", () => {
      closeModal();
      const grid = h("div", {});
      const rows: Array<[string, string]> = [
        ["description", skill.description],
        ["status", skill.status],
        ["source", skill.source],
        ["version", skill.version ?? "(unversioned)"],
        ["hash", `${skill.contentHash.slice(0, 12)}…`],
        ["id", skill.id],
      ];
      if (skill.purpose !== undefined) rows.splice(1, 0, ["purpose", skill.purpose]);
      if (skill.tools !== undefined) rows.splice(2, 0, ["tools", skill.tools.join(", ")]);
      if (skill.constraints !== undefined) rows.splice(3, 0, ["constraints", skill.constraints.join("; ")]);
      for (const [k, v] of rows) {
        grid.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: k }), h("small", { text: v }))));
      }
      modal.append(
        h("div", { class: "mhead" }, h("div", {}, h("h3", { text: skill.name }), h("p", { class: "sub", style: "margin:0", text: "Installed skill with its provenance." }))),
        grid,
      );
      modalOv.classList.add("on");
    });
    const toggleBtn = h("button", {
      class: "mini",
      type: "button",
      text: skill.status === "enabled" ? "Disable" : "Enable",
    });
    toggleBtn.addEventListener("click", () => {
      void client.setSkillEnabled(skill.id, skill.status !== "enabled").then((res) => {
        if (res.ok) {
          toast(`Skill ${res.value.status}`, "ok");
          refresh();
          return;
        }
        if (res.error.status === 409) {
          toast("Skill change is waiting for your approval — nothing changed yet", "ok");
          void refreshApprovals();
          return;
        }
        toast(res.error.reason ?? res.error.message, "err");
      });
    });
    const deleteBtn = h("button", { class: "mini", type: "button", text: "Delete" });
    deleteBtn.addEventListener("click", () => {
      if (!window.confirm(`Delete skill “${skill.name}”? This removes its files.`)) return;
      void client.deleteSkill(skill.id).then((res) => {
        if (res.ok) {
          toast("Skill deleted", "ok");
          refresh();
          return;
        }
        if (res.error.status === 409) {
          toast("Delete is waiting for your approval — nothing removed yet", "ok");
          void refreshApprovals();
          return;
        }
        toast(res.error.reason ?? res.error.message, "err");
      });
    });
    actions.append(viewBtn, toggleBtn, deleteBtn);
    row.append(actions);
    return row;
  }

  /** One staged skill: review the exact bytes, then approve and install. */
  function stagedRow(
    item: { stagedId: string; skillId: string; name: string; description: string; sha256: string; expiresAt: string },
    refresh: () => void,
  ): HTMLElement {
    const row = h(
      "div",
      { class: "arow" },
      h(
        "div",
        {},
        h("b", { text: `${item.name} (staged)` }),
        h("small", { text: `${item.description.slice(0, 100)} · sha ${item.sha256.slice(0, 12)}… · expires ${item.expiresAt}` }),
      ),
    );
    const actions = h("div", { class: "btns" });
    const reviewBtn = h("button", { class: "mini", type: "button", text: "Review" });
    reviewBtn.addEventListener("click", () => {
      void client.stagedSkill(item.stagedId).then((res) => {
        if (!res.ok) {
          toast(res.error.reason ?? res.error.message, "err");
          return;
        }
        closeModal();
        const staged = res.value as {
          sha256: string;
          review?: { name?: string; description?: string; purpose?: string; tools?: string[]; constraints?: string[]; body?: string };
        };
        const review = staged.review;
        const grid = h("div", {});
        if (review !== undefined) {
          for (const [k, v] of [
            ["name", review.name ?? ""],
            ["description", review.description ?? ""],
            ...(review.purpose !== undefined ? [["purpose", review.purpose] as [string, string]] : []),
            ...(review.tools !== undefined ? [["tools", review.tools.join(", ")] as [string, string]] : []),
            ...(review.constraints !== undefined ? [["constraints", review.constraints.join("; ")] as [string, string]] : []),
          ]) {
            grid.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: k }), h("small", { text: v }))));
          }
          if (review.body !== undefined) grid.append(h("pre", { style: "white-space:pre-wrap", text: review.body.slice(0, 4000) }));
        }
        const approveBtn = h("button", { class: "btn pri", type: "button", text: "Approve these bytes" });
        const closeBtn = h("button", { class: "btn", type: "button", text: "Close" });
        closeBtn.addEventListener("click", closeModal);
        approveBtn.addEventListener("click", () => {
          approveBtn.textContent = "Approving…";
          void client.approveStagedSkill(item.stagedId, staged.sha256).then((approved) => {
            if (!approved.ok) {
              approveBtn.textContent = "Approve these bytes";
              toast(approved.error.reason ?? approved.error.message, "err");
              return;
            }
            const approvalId = (approved.value as { approvalId?: string }).approvalId;
            if (approvalId === undefined) {
              toast("No approval id came back — nothing installed", "err");
              return;
            }
            void client.installStagedSkill(item.stagedId, approvalId, staged.sha256).then((installed) => {
              if (installed.ok) {
                closeModal();
                toast("Skill installed", "ok");
                refresh();
                return;
              }
              if (installed.error.status === 409) {
                closeModal();
                toast("Install is waiting for your decision", "ok");
                void refreshApprovals();
                return;
              }
              toast(installed.error.reason ?? installed.error.message, "err");
            });
          });
        });
        modal.append(
          h("div", { class: "mhead" }, h("div", {}, h("h3", { text: `Review: ${item.name}` }), h("p", { class: "sub", style: "margin:0", text: "Approve ONLY these exact bytes." }))),
          grid,
          h("div", { class: "mfoot" }, closeBtn, approveBtn),
        );
        modalOv.classList.add("on");
      });
    });
    const discardBtn = h("button", { class: "mini", type: "button", text: "Discard" });
    discardBtn.addEventListener("click", () => {
      if (!window.confirm(`Discard staged skill “${item.name}”? It was never installed.`)) return;
      void client.discardStagedSkill(item.stagedId).then((res) => {
        if (res.ok) {
          toast("Staged skill discarded", "ok");
          refresh();
          return;
        }
        toast(res.error.reason ?? res.error.message, "err");
      });
    });
    actions.append(reviewBtn, discardBtn);
    row.append(actions);
    return row;
  }

  /** One mission: steps, state, and the approve-to-work transition. */
  function missionRow(
    mission: {
      id: string;
      title: string;
      description?: string;
      status: string;
      steps?: { id: string; title: string; kind: string; status: string }[];
    },
    refresh: () => void,
  ): HTMLElement {
    const steps = mission.steps ?? [];
    const done = steps.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED").length;
    const row = h(
      "div",
      { class: "arow" },
      h(
        "div",
        {},
        h("b", { text: mission.title }),
        h("small", { text: `${mission.status.toLowerCase()} · ${done}/${steps.length} steps done` }),
      ),
    );
    const actions = h("div", { class: "btns" });
    const openBtn = h("button", { class: "mini", type: "button", text: "Inspect" });
    openBtn.addEventListener("click", () => {
      closeModal();
      const list = h("div", {});
      list.append(
        h(
          "div",
          { class: "arow" },
          h("div", {}, h("b", { text: "Objective" }), h("small", { text: mission.description ?? "(no stated objective)" })),
        ),
      );
      if (steps.length === 0) {
        list.append(h("div", { class: "empty", text: "No steps recorded." }));
      }
      for (const [i, step] of steps.entries()) {
        list.append(
          h(
            "div",
            { class: "arow" },
            h(
              "div",
              {},
              h("b", { text: `${i + 1}. ${step.title}` }),
              h("small", { text: `${step.kind}${step.kind !== "manual" ? ` → ${(step as { target?: string }).target ?? "?"}` : ""} · ${step.status.toLowerCase()}` }),
            ),
          ),
        );
      }
      // Linked work items, read live — each opens the work-item inspector.
      list.append(h("h4", { text: "Linked work" }));
      const linked = h("div", {});
      linked.append(h("div", { class: "empty", text: "Reading linked work…" }));
      list.append(linked);
      void client.getWorkItems({ mission: mission.id }).then((wi) => {
        linked.textContent = "";
        if (!wi.ok) {
          linked.append(h("div", { class: "empty", text: wi.error.reason ?? wi.error.message }));
          return;
        }
        if (wi.value.length === 0) {
          linked.append(h("div", { class: "empty", text: "No work items linked to this mission yet." }));
          return;
        }
        for (const item of wi.value) linked.append(workItemRow(item));
      });
      const foot = h("div", { class: "mfoot" });
      const closeBtn = h("button", { class: "btn", type: "button", text: "Close" });
      closeBtn.addEventListener("click", closeModal);
      foot.append(closeBtn);
      // Approve → work: DRAFT plans start here. Terminal missions offer
      // nothing to start or stop.
      if (mission.status === "DRAFT" || mission.status === "QUEUED" || mission.status === "WAITING_APPROVAL") {
        const startBtn = h("button", { class: "btn pri", type: "button", text: "Approve & start" });
        startBtn.addEventListener("click", () => {
          startBtn.textContent = "Starting…";
          void client.startMission(mission.id).then((res) => {
            if (res.ok) {
              closeModal();
              toast(`Mission ${res.value.status.toLowerCase()}`, "ok");
              refresh();
              return;
            }
            startBtn.textContent = "Approve & start";
            toast(res.error.reason ?? res.error.message, "err");
          });
        });
        foot.append(startBtn);
      }
      if (mission.status !== "COMPLETED" && mission.status !== "FAILED" && mission.status !== "CANCELLED") {
        const cancelBtn = h("button", { class: "btn", type: "button", text: "Cancel" });
        cancelBtn.addEventListener("click", () => {
          void client.cancelMission(mission.id).then((res) => {
            if (res.ok) {
              closeModal();
              toast("Mission cancelled", "ok");
              refresh();
              return;
            }
            toast(res.error.reason ?? res.error.message, "err");
          });
        });
        foot.append(cancelBtn);
      }
      modal.append(
        h("div", { class: "mhead" }, h("div", {}, h("h3", { text: mission.title }), h("p", { class: "sub", style: "margin:0", text: `Mission ${mission.id} · ${mission.status.toLowerCase()}` }))),
        list,
        foot,
      );
      modalOv.classList.add("on");
    });
    actions.append(openBtn);
    row.append(actions);
    // The row itself opens the inspector; the buttons keep their own clicks.
    row.style.cursor = "pointer";
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".btns") !== null) return;
      openBtn.click();
    });
    return row;
  }

  // ── orchestration surfaces (bench, missions, work items) ───────────────────

  function workValue(v: number | undefined): string {
    return v === undefined ? "—" : `${Math.round(v * 100)}%`;
  }

  function trendArrow(trend: string): string {
    return trend === "up" ? "↑" : trend === "down" ? "↓" : "→";
  }

  function workReviewLine(item: CoreWorkItemSummary): string | null {
    const r = item.review;
    if (r === undefined) return null;
    return `review: ${r.verdict ?? "recorded"}${
      r.findings !== undefined ? ` · ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}` : ""
    }`;
  }

  function workCostLine(item: CoreWorkItemSummary): string | null {
    const c = item.cost;
    const ti = item.tokensIn ?? c?.tokensIn;
    const to = item.tokensOut ?? c?.tokensOut;
    const lat = item.latencyMs ?? c?.latencyMs;
    const bits: string[] = [];
    if (c?.costUsd !== undefined) bits.push(`$${c.costUsd.toFixed(4)}`);
    if (ti !== undefined || to !== undefined) bits.push(`tokens ${ti ?? 0} in / ${to ?? 0} out`);
    if (c?.toolCalls !== undefined) bits.push(`${c.toolCalls} tool calls`);
    if (lat !== undefined) bits.push(`${lat}ms`);
    return bits.length > 0 ? bits.join(" · ") : null;
  }

  /** One work item as a clickable row — opens the inspector. */
  function workItemRow(item: CoreWorkItemSummary): HTMLElement {
    const row = h("button", { class: "arow", type: "button" });
    row.style.textAlign = "left";
    const box = h(
      "div",
      {},
      h("b", { text: item.objective !== undefined && item.objective.length > 0 ? item.objective.slice(0, 100) : item.id }),
      h("small", {
        text: `${item.state.toLowerCase()} · worker ${item.workerId ?? "unassigned"} · value ${workValue(item.valueScore)}`,
      }),
    );
    const review = workReviewLine(item);
    if (review !== null) box.append(h("small", { text: review }));
    const cost = workCostLine(item);
    if (cost !== null) box.append(h("small", { text: cost }));
    row.append(box);
    row.addEventListener("click", () => openWorkItem(item.id));
    return row;
  }

  /** One bench profile: value, confidence, samples, top domains, evidence + recent work. */
  function benchRow(entry: CoreBenchEntry): HTMLElement {
    const p = entry.profile;
    const wrap = h("div", {});
    const head = h(
      "div",
      { class: "arow" },
      h(
        "div",
        {},
        h("b", { text: `${p.workerId}${p.role !== undefined && p.role.length > 0 ? ` · ${p.role}` : ""}` }),
        h("small", {
          text: `value ${workValue(p.overallValue)} · confidence ${p.overallConfidence ?? "low"} · ${p.totalSamples ?? 0} samples`,
        }),
      ),
    );
    const actions = h("div", { class: "btns" });
    const evBtn = h("button", { class: "mini", type: "button", text: "Evidence" });
    actions.append(evBtn);
    head.append(actions);
    wrap.append(head);
    const detail = h("div", {});
    detail.style.display = "none";
    evBtn.addEventListener("click", () => {
      const open = detail.style.display === "none";
      detail.style.display = open ? "" : "none";
      evBtn.textContent = open ? "Hide evidence" : "Evidence";
    });
    if (entry.recent.length === 0) {
      detail.append(h("div", { class: "empty", text: "No domain evidence yet." }));
    }
    for (const d of entry.recent) {
      detail.append(
        h(
          "div",
          { class: "arow" },
          h(
            "div",
            {},
            h("b", { text: d.domain }),
            h("small", {
              text: `quality ${workValue(d.quality)} · verification ${workValue(d.verification)} · ${d.samples} samples · ${trendArrow(d.trend)}`,
            }),
          ),
        ),
      );
    }
    const recentRows = h("div", {});
    detail.append(h("div", { class: "hint", text: "Recent work — select one to inspect it." }), recentRows);
    void client.getWorkItems({ worker: p.workerId, limit: 5 }).then((res) => {
      if (!res.ok) {
        recentRows.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message }));
        return;
      }
      if (res.value.length === 0) {
        recentRows.append(h("div", { class: "empty", text: "No work items for this worker yet." }));
        return;
      }
      for (const item of res.value) recentRows.append(workItemRow(item));
    });
    wrap.append(detail);
    return wrap;
  }

  /** Work-item inspector: inspect() data in the shared modal. */
  function openWorkItem(id: string): void {
    closeModal();
    const body = h("div", {});
    body.append(h("div", { class: "empty", text: "Reading work item…" }));
    const closeBtn = h("button", { class: "btn", type: "button", text: "Close" });
    closeBtn.addEventListener("click", closeModal);
    modal.append(
      h("div", { class: "mhead" }, h("div", {}, h("h3", { text: "Work item" }), h("p", { class: "sub", style: "margin:0", text: id }))),
      body,
      h("div", { class: "mfoot" }, closeBtn),
    );
    modalOv.classList.add("on");
    void client.getWorkItem(id).then((res) => {
      body.textContent = "";
      if (!res.ok) {
        body.append(h("div", { class: "empty", text: res.error.reason ?? res.error.message }));
        return;
      }
      const { item, children, activity, benchmark } = res.value;
      body.append(
        h(
          "div",
          { class: "arow" },
          h(
            "div",
            {},
            h("b", { text: item.objective ?? item.id }),
            h("small", {
              text: `${item.state.toLowerCase()} · worker ${item.workerId ?? "unassigned"} · value ${workValue(item.valueScore)}`,
            }),
          ),
        ),
      );
      if (item.deliverable !== undefined) {
        body.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: "Deliverable" }), h("small", { text: item.deliverable }))));
      }
      const cost = workCostLine(item);
      if (cost !== null) {
        body.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: "Cost" }), h("small", { text: cost }))));
      }
      const review = item.review;
      if (review !== undefined) {
        const box = h(
          "div",
          {},
          h("b", { text: `Review: ${review.verdict ?? "recorded"}` }),
          h("small", { text: `${review.reviewerId ?? "reviewer"}${review.at !== undefined ? ` · ${review.at}` : ""}` }),
        );
        for (const f of review.findings ?? []) box.append(h("small", { text: `· ${f.slice(0, 200)}` }));
        body.append(h("div", { class: "arow" }, box));
      }
      // Handoff summary: a result slice plus the evidence count — never transcripts.
      if (item.handoff !== undefined) {
        const result = item.handoff.result ?? "";
        const slice = result.length > 400 ? `${result.slice(0, 400).trimEnd()}…` : result;
        const counts = [`status ${item.handoff.status ?? "?"}`];
        if (item.handoff.evidence !== undefined) counts.push(`${item.handoff.evidence.length} evidence`);
        body.append(
          h(
            "div",
            { class: "arow" },
            h("div", {}, h("b", { text: `Handoff — ${counts.join(" · ")}` }), h("small", { text: slice.length > 0 ? slice : "(no result text)" })),
          ),
        );
      }
      if (children.length > 0) {
        body.append(h("h4", { text: `Children (${children.length})` }));
        for (const child of children) body.append(workItemRow(child));
      }
      if (activity.length > 0) {
        body.append(h("h4", { text: `Activity (${activity.length})` }));
        for (const a of activity.slice(0, 50)) {
          body.append(
            h(
              "div",
              { class: "arow" },
              h("div", {}, h("b", { text: a.label.slice(0, 140) }), h("small", { text: `${a.kind}${a.at !== "" ? ` · ${a.at}` : ""}` })),
            ),
          );
        }
      }
      if (benchmark !== null) {
        const bp = benchmark.profile;
        body.append(
          h(
            "div",
            { class: "arow" },
            h(
              "div",
              {},
              h("b", { text: `Benchmark — ${bp.workerId}` }),
              h("small", { text: `value ${workValue(bp.overallValue)} · ${bp.overallConfidence ?? "low"} · ${bp.totalSamples ?? 0} samples` }),
            ),
          ),
        );
      } else {
        body.append(h("div", { class: "hint", text: "No benchmark for this worker yet." }));
      }
    });
  }

  /** One memory row: content + provenance, with view/correct/delete. */
  function memoryRow(
    entry: {
      id: string;
      content: string;
      type: string;
      provenance: string;
      confidence: number;
      scope: string;
      scopeId: string;
      createdAt: string;
    },
    refresh: () => void,
  ): HTMLElement {
    const row = h(
      "div",
      { class: "arow" },
      h(
        "div",
        {},
        h("b", { text: entry.content.slice(0, 120) }),
        h("small", { text: `${entry.type} · ${entry.provenance} · confidence ${entry.confidence}` }),
      ),
    );
    const actions = h("div", { class: "btns" });
    const viewBtn = h("button", { class: "mini", type: "button", text: "View" });
    viewBtn.addEventListener("click", () => {
      closeModal();
      const grid = h("div", {});
      for (const [k, v] of [
        ["content", entry.content],
        ["type", entry.type],
        ["provenance", entry.provenance],
        ["confidence", String(entry.confidence)],
        ["scope", `${entry.scope}:${entry.scopeId}`],
        ["created", entry.createdAt],
        ["id", entry.id],
      ]) {
        grid.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: k }), h("small", { text: v }))));
      }
      modal.append(h("div", { class: "mhead" }, h("div", {}, h("h3", { text: "Memory" }), h("p", { class: "sub", style: "margin:0", text: "Durable fact with its provenance." }))), grid);
      modalOv.classList.add("on");
    });
    const correctBtn = h("button", { class: "mini", type: "button", text: "Correct" });
    correctBtn.addEventListener("click", () => {
      const next = window.prompt("Correct this memory to:", entry.content);
      if (next === null || next.trim() === "" || next.trim() === entry.content) return;
      void client.correctMemoryEntry(entry.id, { content: next.trim() }).then((res) => {
        if (res.ok) {
          toast("Memory corrected", "ok");
          refresh();
        } else toast(res.error.reason ?? res.error.message, "err");
      });
    });
    const deleteBtn = h("button", { class: "mini", type: "button", text: "Delete" });
    deleteBtn.addEventListener("click", () => {
      if (!window.confirm(`Forget this memory?\n\n“${entry.content.slice(0, 140)}”`)) return;
      void client.deleteMemoryEntry(entry.id).then((res) => {
        if (res.ok) {
          toast("Memory forgotten", "ok");
          refresh();
          return;
        }
        // 409: forgetting parks for a human — shown as a park, never faked.
        if (res.error.status === 409) {
          toast("Delete is waiting for your approval — nothing forgotten yet", "ok");
          void refreshApprovals();
          return;
        }
        toast(res.error.reason ?? res.error.message, "err");
      });
    });
    actions.append(viewBtn, correctBtn, deleteBtn);
    row.append(actions);
    return row;
  }

  // ══ APPROVALS ═════════════════════════════════════════════════════════════
  async function refreshApprovals(): Promise<void> {
    const res = await client.approvals({ status: "PENDING" });
    if (!res.ok) return;
    approvals = res.value.map((a) => ({ id: a.id, toolId: a.toolId, action: a.action, reason: a.reason, risk: a.risk }));
    drawerBadge.textContent = String(approvals.length);
    if (approvals.length > 0) renderApprovalCards();
    if (view === "home") void renderOverview();
  }
  function renderApprovalCards(): void {
    if (turnCardHost === null) return;
    for (const a of approvals) {
      const card = h("div", { class: "ask blk" });
      card.innerHTML = `<h4>${icon("warn")}KAI needs your call — ${esc(a.toolId)}</h4><div class="cmd">${esc(a.action)}\n${esc(a.reason)}</div>`;
      const btns = h("div", { class: "btns" });
      const deny = h("button", { class: "btn", type: "button", text: "Deny" });
      const allow = h("button", { class: "btn warn", type: "button", text: "Allow once" });
      deny.addEventListener("click", () => void decide(a.id, false));
      allow.addEventListener("click", () => void decide(a.id, true));
      btns.append(allow, deny);
      card.append(btns);
      turnCardHost.append(card);
    }
    requestFollow();
  }
  async function decide(id: string, approved: boolean): Promise<void> {
    const res = await client.decideApproval(id, approved);
    if (!res.ok) toast(res.error.reason ?? res.error.message, "err");
    else toast(approved ? "Approved" : "Denied", approved ? "ok" : undefined);
    await refreshApprovals();
  }

  // ══ STATUS BAR ════════════════════════════════════════════════════════════
  function paintStatus(): void {
    const slice = workspace.getState();
    const conn = slice.conn;
    const working = agents.filter((a) => a.activity !== "idle");
    const att = mcpServers.filter((s) => s.enabled && !s.connected).length;
    statusBar.innerHTML =
      `<button data-go="tools"><i class="d ${tools.length === 0 ? "n" : ""}"></i>${tools.length} tools registered</button>` +
      `<button data-go="mcp"><i class="d ${att > 0 ? "w" : ""}"></i>${mcpServers.filter((s) => s.connected).length} of ${mcpServers.length} MCP servers connected</button>` +
      `<span class="sp"></span>` +
      (working.length > 0
        ? `<span class="live"><i></i>${esc(working.map((a) => a.name).join(", "))} working</span>`
        : `<span>${agents.filter((a) => a.enabled).length} agents idle</span>`) +
      `<span class="sp"></span><span>KAI core, ${conn === "ONLINE" ? "local harness connected" : conn.toLowerCase()}</span>`;
    for (const b of Array.from(statusBar.querySelectorAll<HTMLElement>("[data-go]"))) {
      b.addEventListener("click", () => show((b.dataset.go ?? "chat") as RouteId));
    }
    const nTools = navButtons.get("tools")?.querySelector<HTMLElement>(".n");
    if (nTools !== undefined && nTools !== null) { nTools.hidden = att === 0; nTools.textContent = String(att); }
    const abDot = shell.querySelector<HTMLElement>("#kp-ab-dot");
    if (abDot !== null) abDot.className = "dot" + (att > 0 ? " w" : "");
    const abTxt = shell.querySelector<HTMLElement>("#kp-ab-txt");
    if (abTxt !== null) abTxt.textContent = `${agents.length} agents, ${tools.length} tools`;
  }

  // ══ DRAWER ════════════════════════════════════════════════════════════════
  function drTab(t: string): void {
    for (const [id, b] of Object.entries(tabButtons)) b.setAttribute("aria-selected", id === t ? "true" : "false");
    dpAct.classList.toggle("on", t === "act");
    dpAgt.classList.toggle("on", t === "agt");
    dpCore.classList.toggle("on", t === "core");
  }
  function renderDrawer(): void {
    // Activity tab — real events.
    const rows = workspace.getState().events.slice(0, 60);
    dpAct.textContent = "";
    if (rows.length === 0) dpAct.append(h("div", { class: "empty", text: "Nothing yet. Every tool call and agent hand-off shows up here." }));
    else {
      const tl = h("div", { class: "tl" });
      for (const e of rows) tl.append(h("div", { class: "ev" }, h("b", { text: e.line }), h("small", { text: `${e.type}, ${relativeTime(e.at)}` })));
      dpAct.append(tl);
    }
    // Agents tab — real subagents.
    dpAgt.textContent = "";
    if (agents.length === 0) dpAgt.append(h("div", { class: "empty", text: "No agents." }));
    else for (const a of agents) {
      dpAgt.append(h("div", { class: "arow" },
        createOrb({ mood: a.enabled ? "idle" : "sleepy", fx: false, size: 38, hue: agentHue(a, 0) }),
        h("div", {}, h("b", { text: a.name }), h("small", { text: a.currentTask ?? a.status })),
        h("span", { class: "chip mut", text: a.enabled ? "on" : "off" })));
    }
    // Core tab — real identity/health.
    dpCore.textContent = "";
    dpCore.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: "Build" }), h("small", { text: identity.buildId ?? "unknown" }))));
    dpCore.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: "Uptime" }), h("small", { text: identity.uptimeMs !== undefined ? `${Math.round(identity.uptimeMs / 1000)}s` : "—" }))));
    if (mcpCapability.detail !== "") dpCore.append(h("div", { class: "arow" }, h("div", {}, h("b", { text: "MCP" }), h("small", { text: `${mcpCapability.availability}: ${mcpCapability.detail}` }))));
  }

  // ══ palette (the REAL registry palette — Ctrl/Cmd+K) ════════════════════
  //
  // Every row is dispatchable to real code (see `dispatchPaletteAction`): the
  // registry's `when` gates hide impossible actions, and the host maps each id
  // to the same implementation the buttons use. No stub list, no dead rows.
  function paletteContext(): CommandContext {
    return {
      route: view,
      mode: readMode(),
      theme: ctx.theme?.mode ?? "system",
      resolvedTheme: "light",
      approvalCount: approvals.length,
      sessionId: activeSession?.id ?? null,
      agentId: null,
      agentCount: agents.length,
      toolCount: tools.length,
      mcpConnected: mcpServers.filter((s) => s.connected).length,
    };
  }

  /** Keep the composer's mode segment in sync with the persisted mode. */
  function paintModeSegment(mode: ModeId): void {
    const buttons = Array.from(shell.querySelectorAll<HTMLElement>(".seg [data-m]"));
    for (const button of buttons) {
      const value = button.dataset.m ?? "";
      const on = value === mode || (mode === "work" && value === "auto");
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function setMode(mode: ModeId): void {
    writeMode(mode);
    paintModeSegment(mode);
    toast(`Mode: ${mode === "ask" ? "Ask first" : mode === "plan" ? "Plan" : "Work"}`, "ok");
  }

  async function compressActiveSession(): Promise<void> {
    if (activeSession === null) {
      toast("No active session to compress", "err");
      return;
    }
    const res = await client.runCommand("compress", [activeSession.id]);
    if (!res.ok) {
      toast(res.error.reason ?? res.error.message, "err");
      return;
    }
    toast(res.value.title, "ok");
    loadedSessionId = null;
    void refreshActive();
    if (view === "sessions") void loadSessions();
  }

  async function deleteActiveSession(): Promise<void> {
    if (activeSession === null) {
      toast("No active session to delete", "err");
      return;
    }
    const title = activeSession.title;
    if (!window.confirm(`Delete session “${title}”? This removes its transcript and tool history.`)) return;
    const routes = createSessionRoutes({ baseUrl: client.baseUrl });
    const res = await routes.remove(activeSession.id);
    if (!res.ok) {
      toast(res.error.reason ?? res.error.message, "err");
      return;
    }
    if (res.value.kind === "parked") {
      toast(`Delete parked for approval${res.value.approvalId !== undefined ? ` (${res.value.approvalId})` : ""} — nothing removed`, "ok");
      void refreshApprovals();
      return;
    }
    toast("Session deleted", "ok");
    loadedSessionId = null;
    void refreshActive();
    if (view === "sessions") void loadSessions();
  }

  async function decideLatest(approved: boolean): Promise<void> {
    if (approvals.length === 0) {
      toast("Nothing is waiting for approval", "err");
      return;
    }
    const latest = approvals[0]!;
    const res = await client.decideApproval(latest.id, approved);
    if (!res.ok) {
      toast(res.error.reason ?? res.error.message, "err");
      return;
    }
    toast(approved ? "Approved" : "Rejected", "ok");
    void refreshApprovals();
  }

  /** Every palette id → the real action. Nothing here is decorative. */
  function dispatchPaletteAction(id: string): void {
    if (id.startsWith("nav.")) {
      show(id.slice("nav.".length) as RouteId);
      return;
    }
    switch (id) {
      case "new.chat":
      case "new.session":
        void newSession();
        return;
      case "new.agent":
        show("agents");
        newAgent();
        return;
      case "new.mission": {
        const title = window.prompt("What is the mission?", "");
        if (title === null || title.trim() === "") return;
        void client.createMission({ title: title.trim() }).then((res) => {
          if (res.ok) {
            toast("Mission started", "ok");
            show("missions");
          } else toast(res.error.reason ?? res.error.message, "err");
        });
        return;
      }
      case "open.approvals":
        app.classList.add("drawer");
        return;
      case "session.compress":
        void compressActiveSession();
        return;
      case "session.delete":
        void deleteActiveSession();
        return;
      case "session.search":
        show("sessions");
        return;
      case "mode.ask":
        setMode("ask");
        return;
      case "mode.plan":
        setMode("plan");
        return;
      case "mode.work":
        setMode("work");
        return;
      case "theme.light":
      case "theme.dark":
      case "theme.system":
        if (ctx.theme === undefined) {
          toast("Theme control is unavailable in this host", "err");
          return;
        }
        ctx.theme.set(id.slice("theme.".length) as "light" | "dark" | "system");
        toast(`Theme: ${id.slice("theme.".length)}`, "ok");
        return;
      case "theme.toggle":
        if (ctx.theme === undefined) {
          toast("Theme control is unavailable in this host", "err");
          return;
        }
        ctx.theme.cycle();
        return;
      case "agent.assign":
      case "agent.memory":
      case "agent.switch":
        // Gated to an agent context by the registry; reaching here without one
        // means the context changed under the open palette.
        show("agents");
        return;
      case "approve.latest":
        void decideLatest(true);
        return;
      case "reject.latest":
        void decideLatest(false);
        return;
      case "approval.inspect":
        app.classList.add("drawer");
        return;
      case "kai.feelings":
        show("chat");
        lab.classList.add("on");
        return;
      case "models.show":
        show("chat");
        chatInput.value = "/models";
        submit();
        return;
      case "providers.show":
        show("chat");
        chatInput.value = "/providers";
        submit();
        return;
      case "model.change":
      case "provider.test":
        show("settings");
        return;
      case "sys.diagnostics":
        app.classList.add("drawer");
        return;
      default:
        toast(`Unknown command: ${id}`, "err");
    }
  }

  paletteHandle = createPalette({ context: paletteContext, run: dispatchPaletteAction });
  shell.append(paletteHandle.el);
  function openPalette(): void { paletteHandle?.open(); }
  function closePalette(): void { paletteHandle?.close(); }
  async function newSession(): Promise<void> {
    const created = await client.createSession({});
    if (!created.ok) { toast(created.error.reason ?? created.error.message, "err"); return; }
    await client.activateSession(created.value.id);
    loadedSessionId = null;
    await refreshActive();
    show("chat");
    toast("New session started", "ok");
  }

  function closeModal(): void { modalOv.classList.remove("on"); modal.textContent = ""; }
  modalOv.addEventListener("click", (e) => { if (e.target === modalOv) closeModal(); });

  // ══ feelings lab ══════════════════════════════════════════════════════════
  (function buildLab(): void {
    for (const m of MOOD_ORDER) {
      const b = h("button", { type: "button" });
      b.append(createOrb({ mood: m, fx: false, size: 44 }), document.createTextNode(MOOD_LABELS[m].split(",")[0]!));
      b.addEventListener("click", () => { if (!busy) { show("chat"); flashPreview(m, 4500); } });
      fg.append(b);
    }
  })();

  // ══ real event stream → thread cards + drawer + activity ══════════════════
  // Every read that has no live event of its own is primed by `prime()`. It used
  // to run ONCE at boot; if Core was still starting then those reads failed and
  // NOTHING retried them, so the real launch → "Open KAI" flow painted an empty
  // product (0 tools, 0 agents) until a manual reload — while `workspace` happily
  // re-read the same routes on its own timer. The workspace slice's transition to
  // ONLINE is the signal to re-prime: once on the first connect, and again on any
  // reconnect.
  let lastConn: string | null = null;
  /**
   * One compact operator-activity row: real label + kind dot. Bounded to 30
   * rows so the strip is a live pulse, not a log dump (operator §8/§9).
   */
  function appendActStrip(label: string, kind: string): void {
    if (actStrip === undefined) return;
    const dot = kind.startsWith("worker") ? "w" : kind.startsWith("review") ? "r" : kind.startsWith("benchmark") ? "b" : "d";
    const row = h("div", { class: `actrow ${dot}` }, h("i", {}), h("span", { text: label }));
    actStrip.append(row);
    while (actStrip.childElementCount > 30) actStrip.firstElementChild?.remove();
    actStrip.scrollTop = actStrip.scrollHeight;
  }

  /**
   * Live command cards, keyed by commandExecutionId: a real child process's
   * stdout/stderr appended AS CHUNKS ARRIVE (never a post-exit dump). Started
   * opens the card; chunks append; exit stamps status + duration.
   */
  const commandCards = new Map<string, { el: HTMLElement; out: HTMLElement; status: HTMLElement; outLen: number }>();
  const CMD_OUTPUT_CAP = 200_000;
  function renderCommandRow(row: WorkspaceEventRow): void {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const id = typeof p["commandExecutionId"] === "string" ? p["commandExecutionId"] : null;
    if (id === null) return;
    if (row.type === "command.started") {
      if (commandCards.has(id)) return;
      const cmd = `${typeof p["command"] === "string" ? p["command"] : ""} ${Array.isArray(p["args"]) ? (p["args"] as string[]).join(" ") : ""}`.trim();
      const el = h("details", { class: "cmd blk", open: true });
      const status = h("code", { class: "st", text: "running" });
      const head = h("summary");
      head.innerHTML = `<span class="ti">${icon("term")}</span><code class="cline">$ ${esc(cmd)}</code>`;
      head.append(status);
      const out = h("pre", { class: "cmdout" });
      el.append(head, out);
      (turnCardHost ?? threadCol).append(el);
      requestFollow();
      commandCards.set(id, { el, out, status, outLen: 0 });
      return;
    }
    const card = commandCards.get(id);
    if (card === undefined) return;
    if (row.type === "command.stdout" || row.type === "command.stderr") {
      const chunk = typeof p["chunk"] === "string" ? p["chunk"] : "";
      if (chunk.length === 0) return;
      const line = h("span", { class: row.type === "command.stderr" ? "cmd-err" : "cmd-out", text: chunk });
      card.out.append(line);
      // O(1) cap accounting: reading textContent per chunk rescans the whole
      // output (quadratic on long streams). A running counter trims from the
      // head without ever measuring the body.
      card.outLen += chunk.length;
      while (card.outLen > CMD_OUTPUT_CAP && card.out.firstChild !== null) {
        const first = card.out.firstChild;
        card.outLen -= (first.textContent ?? "").length;
        first.remove();
      }
      // Follow the tail on the SCROLLABLE element (the output pre), only when
      // the user is already at the bottom of the THREAD.
      if (nearBottom()) card.out.scrollTop = card.out.scrollHeight;
      return;
    }
    if (row.type === "command.exit") {
      const code = p["exitCode"];
      const ms = typeof p["durationMs"] === "number" ? Math.round(p["durationMs"]) : null;
      const aborted = p["cancelled"] === true;
      const ok = code === 0 && !aborted;
      card.status.textContent = aborted
        ? `ABORTED${ms !== null ? ` · ${ms}ms` : ""}`
        : `exit ${code === null || code === undefined ? "?" : String(code)}${ms !== null ? ` · ${ms}ms` : ""}`;
      card.status.classList.toggle("bad", !ok);
      const copy = h("button", { class: "mini", type: "button", text: "Copy" });
      copy.addEventListener("click", () => {
        void navigator.clipboard?.writeText(card.out.textContent ?? "").then(() => toast("Copied", "ok"), () => toast("Copy failed", "err"));
      });
      card.el.append(copy);
      commandCards.delete(id);
    }
  }

  /**
   * Operator header state pills — from REAL state: the workspace connection,
   * the latest operator activity, and pending approvals. Nothing fabricated.
   */
  /** Last known worker reachability from Core's OWN probes (GET /health). */
  let workerHealth: CoreWorkerHealth | undefined;
  async function refreshWorkerHealth(): Promise<void> {
    try {
      const res = await client.health();
      if (res.ok && res.value.workers !== undefined) workerHealth = res.value.workers;
    } catch {
      // Keep last known; never fabricate a status from a failed fetch.
    }
    paintOperatorStatus();
  }
  function paintOperatorStatus(): void {
    if (statePills === undefined) return;
    const slice = workspace.getState();
    const online = slice.conn === "ONLINE";
    const latestOp = slice.events.find((e) =>
      e.type.startsWith("worker") || e.type.startsWith("review") || e.type.startsWith("delegation") || e.type.startsWith("mission"));
    const bits: string[] = [];
    bits.push(`<span class="opill ${online ? "ok" : "bad"}"><i></i>${online ? "RUNTIME ACTIVE" : "OFFLINE"}</span>`);
    // Worker pills render Core's measured probes — reachable/authorized or the
    // real reason. Unknown stays unshown; an offline worker is never "idle".
    const hermes = workerHealth?.hermes;
    if (hermes !== undefined) {
      const label = hermes.reachable ? (hermes.authorized === false ? "HERMES UNAUTH" : "HERMES OK") : "HERMES OFFLINE";
      bits.push(`<span class="opill ${hermes.reachable && hermes.authorized !== false ? "ok" : "bad"}"><i></i>${esc(label)}</span>`);
    }
    const opencode = workerHealth?.opencode;
    if (opencode !== undefined) {
      const why = opencode.reachable
        ? "OPENCODE OK"
        : `OPENCODE OFFLINE${opencode.reason !== undefined ? ` · ${shortReason(opencode.reason)}` : ""}`;
      bits.push(`<span class="opill ${opencode.reachable ? "ok" : "bad"}"><i></i>${esc(why)}</span>`);
    }
    if (latestOp !== undefined) bits.push(`<span class="opill"><i></i>${esc(latestOp.text.slice(0, 40))}</span>`);
    bits.push(`<span class="opill ${approvals.length > 0 ? "warn" : ""}"><i></i>${approvals.length} APPROVAL${approvals.length === 1 ? "" : "S"}</span>`);
    statePills.innerHTML = bits.join("");
  }
  function shortReason(reason: string): string {
    const mapped: Record<string, string> = {
      upstream_unreachable: "unreachable",
      connection_refused: "refused",
      timeout: "timeout",
      unhealthy: "unhealthy",
      malformed_response: "bad response",
    };
    return (mapped[reason] ?? reason).slice(0, 24);
  }

  // Fold cursor: ID-based, never length-based. The store ring is newest-first
  // and CAPPED (CORE_EVENT_LIMIT): once full, its length stops growing, so a
  // `slice(0, len - cursor)` cursor goes permanently blind — every event past
  // the first ~20 (command output, exits, later turns) silently never folds.
  // Rows are collected newest-first until the first already-seen row, marked
  // immediately (even if a renderer throws), then rendered oldest-first.
  const seenEventIds = new Set<string>();
  const seenEventObjs = new WeakSet<object>();
  function isFreshRow(e: WorkspaceEventRow): boolean {
    if (e.id !== undefined) return !seenEventIds.has(e.id);
    return !seenEventObjs.has(e);
  }
  function markRowSeen(e: WorkspaceEventRow): void {
    if (e.id !== undefined) {
      seenEventIds.add(e.id);
      if (seenEventIds.size > 500) {
        const it = seenEventIds.values();
        for (let i = 0; i < 100; i += 1) {
          const next = it.next();
          if (next.done) break;
          seenEventIds.delete(next.value);
        }
      }
    } else {
      seenEventObjs.add(e);
    }
  }
  const unsubscribe = workspace.subscribe(() => {
    const slice = workspace.getState();
    // New rows since the last fold, oldest-first for rendering.
    const freshNewestFirst: WorkspaceEventRow[] = [];
    for (const e of slice.events) {
      if (!isFreshRow(e)) break;
      freshNewestFirst.push(e);
      markRowSeen(e);
    }
    const fresh = freshNewestFirst.reverse();
    // One poison row must NEVER stall the timeline: every row folds in its
    // own guard, and the cursor ALWAYS advances past what was seen — even
    // when a renderer throws. (A swallowed throw here used to freeze the
    // cursor and silently drop every later event, including command exits.)
    const foldError = (where: string, error: unknown): void => {
      try {
        console.error(`[kai] event fold failed at ${where}: ${error instanceof Error ? error.message : String(error)}`);
      } catch { /* logging never breaks the fold */ }
    };
    // `fresh` is already oldest-first (collected newest-first, reversed
    // once): lifecycle order (start/chunks/exit) is preserved, so a command
    // exit can never overtake its started card.
    if (fresh.length > 0) {
      for (const e of fresh) {
        // Command output streams into its own live card, independent of a
        // turn (a mission command runs outside chat too).
        if (!e.type.startsWith("command.")) continue;
        try {
          renderCommandRow(e);
        } catch (error) {
          foldError(`command:${e.type}`, error);
        }
      }
    }
    if (turnCardHost !== null && fresh.length > 0) {
      for (const e of fresh) {
        if (e.type.startsWith("command.")) continue;
        try {
          appendEventCard(e, e.type.startsWith("mcp") || e.type.startsWith("tool"));
        } catch (error) {
          foldError(`event:${e.type}`, error);
        }
      }
    }
    // The operator activity strip streams EVERY fresh operator event live
    // (worker/review/delegation/benchmark), independent of a turn (§8/§22).
    if (fresh.length > 0) {
      for (const e of fresh) {
        if (e.type.startsWith("worker") || e.type.startsWith("review") || e.type.startsWith("delegation") || e.type.startsWith("benchmark")) {
          try {
            appendActStrip(e.text, e.type);
          } catch (error) {
            foldError(`strip:${e.type}`, error);
          }
        }
      }
    }
    try {
      renderDrawer();
      if (view === "activity") void renderActivity();
      paintStatus();
      paintOperatorStatus();
    } catch (error) {
      foldError("chrome", error);
    }
    if (slice.conn === "ONLINE" && lastConn !== "ONLINE") prime();
    lastConn = slice.conn;
  });

  // ── the data primer ───────────────────────────────────────────────────────
  // Every read that has no live event of its own. Run at boot AND whenever the
  // workspace (re)reaches ONLINE, so a Core that was still starting when this
  // page loaded is picked up without a manual reload.
  function prime(): void {
    paintOperatorStatus();
    void refreshWorkerHealth();
    void workspace.routes.maintenance().then((res) => {
      if (res.ok) {
        identity = { buildId: res.value.identity.buildId, pid: res.value.identity.pid };
        renderDrawer();
        paintStatus();
        void renderOverview();
      }
    });
    void client.state().then((res) => {
      if (res.ok) {
        identity = { ...identity, ...(res.value.uptimeMs !== undefined ? { uptimeMs: res.value.uptimeMs } : {}) };
        void renderOverview();
      }
    });
    void loadTools();
    void loadAgents();
    void loadMentionSkills();
    void loadSlashCommands();
    void refreshActive();
    void refreshApprovals();
    void renderOverview();
    buildLists();
    // Display prefs ride with the primer: once cached, repaint the surfaces
    // they govern so a restarted Core's prefs apply without a reload.
    void refreshOrchPrefs().then(() => {
      renderAgents();
      if (view === "activity") void renderActivity();
    });
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  buildViews();
  drTab("act");
  mountOrbParallax(shell);
  moods.start();
  paintStatus();
  renderDrawer();
  renderActivity();
  prime();
  // A deep link lands on its route; a bare open lands on chat, as before.
  show(window.location.hash ? parseRoute(window.location.hash) : "chat");

  return {
    el: shell,
    showRoute: show,
    sync(): void {
      void loadTools();
      void loadAgents();
      void refreshActive();
      void refreshApprovals();
      if (view === "activity") void renderActivity();
    },
    destroy(): void {
      window.removeEventListener("hashchange", onHashChange);
      unsubscribe();
      moods.stop();
    },
  };
}


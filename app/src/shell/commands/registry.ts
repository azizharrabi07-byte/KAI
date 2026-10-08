// KAI's command registry — the real command layer behind the palette and `/`.
//
// Every entry is backed by an ACTUAL KAI capability. There are no decorative
// commands: if nothing can execute it, it is not here (owner §10, §34). The
// registry is DOM-free and pure, so the catalogue, the context filter and the
// ranking are unit-tested with no browser and no Core; the palette binds each
// id to its host action (see `presence.ts`).
//
// Context-awareness (owner §12) lives in each command's `when` predicate: an
// approval command appears only when an approval exists, an agent command only
// inside an agent context, and a mode/theme command only when it would change
// something. "Do not show impossible actions" is enforced here, once.

import type { RouteId } from "../routes";
import type { ThemeMode } from "../theme";
import type { ModeId } from "../modes";

export type CommandGroup =
  | "create"
  | "mode"
  | "theme"
  | "navigate"
  | "agent"
  | "approval"
  | "kai";

export const GROUP_ORDER: readonly CommandGroup[] = [
  "create",
  "mode",
  "theme",
  "navigate",
  "agent",
  "approval",
  "kai",
];

export const GROUP_LABELS: Record<CommandGroup, string> = {
  create: "Start",
  mode: "Mode",
  theme: "Theme",
  navigate: "Go to",
  agent: "This agent",
  approval: "Needs you",
  kai: "KAI",
};

/** Everything a command's availability may depend on. All real, all live. */
export interface CommandContext {
  route: RouteId;
  mode: ModeId;
  theme: ThemeMode;
  resolvedTheme: "light" | "dark";
  /** Pending approvals Core reports right now. */
  approvalCount: number;
  /** The session new turns go to, when one is chosen. */
  sessionId: string | null;
  /** The agent whose context we are in (its page/session), when any. */
  agentId: string | null;
  agentCount: number;
  toolCount: number;
  mcpConnected: number;
}

export interface CommandDescriptor {
  /** Stable id — the palette's host maps this to the real action. */
  id: string;
  label: string;
  /** Secondary text (the palette's right column). */
  hint: string;
  group: CommandGroup;
  /** Extra match terms beyond the label. */
  keywords?: string[];
  /** Show only when this returns true. Omitted ⇒ always. */
  when?: (ctx: CommandContext) => boolean;
}

const navigate = (route: RouteId, label: string): CommandDescriptor => ({
  id: `nav.${route}`,
  label,
  hint: "/" + route,
  group: "navigate",
  keywords: [route, "go", "open", "show"],
});

/**
 * The catalogue. `when` is the ONLY gate — an entry absent from a context is one
 * that would do nothing, so hiding it is the correct behaviour, not a nicety.
 */
export const COMMANDS: readonly CommandDescriptor[] = [
  // ── Start ──────────────────────────────────────────────────────────────────
  { id: "new.chat", label: "New chat", hint: "/new", group: "create", keywords: ["chat", "conversation", "start", "talk"] },
  { id: "new.session", label: "New session", hint: "/session", group: "create", keywords: ["chat", "conversation", "start"] },
  { id: "new.agent", label: "Create agent", hint: "/agent", group: "create", keywords: ["subagent", "persona", "researcher"] },
  { id: "new.mission", label: "Start a mission", hint: "/mission", group: "create", keywords: ["work", "task", "plan", "job"] },
  { id: "open.approvals", label: "Show approvals", hint: "/approve", group: "create", when: (c) => c.approvalCount > 0 },
  {
    id: "session.compress",
    label: "Compress this session",
    hint: "/compress",
    group: "create",
    keywords: ["shrink", "context", "summarize", "compact"],
    when: (c) => c.sessionId !== null,
  },
  {
    id: "session.delete",
    label: "Delete this session",
    hint: "asks first",
    group: "create",
    keywords: ["remove", "destroy"],
    when: (c) => c.sessionId !== null,
  },
  {
    id: "session.search",
    label: "Search sessions",
    hint: "opens Sessions",
    group: "create",
    keywords: ["find", "filter", "lookup"],
  },

  // ── Mode ───────────────────────────────────────────────────────────────────
  { id: "mode.ask", label: "Enable Ask mode", hint: "/ask", group: "mode", keywords: ["chat", "talk", "manual"], when: (c) => c.mode !== "ask" },
  { id: "mode.plan", label: "Enable Plan mode", hint: "/plan", group: "mode", keywords: ["plan", "propose", "approve"], when: (c) => c.mode !== "plan" },
  { id: "mode.work", label: "Enable Work mode", hint: "/work", group: "mode", keywords: ["work", "execute", "mission", "run"], when: (c) => c.mode !== "work" },

  // ── Theme ──────────────────────────────────────────────────────────────────
  { id: "theme.light", label: "Theme: Light", hint: "", group: "theme", keywords: ["appearance", "day"], when: (c) => c.theme !== "light" },
  { id: "theme.dark", label: "Theme: Dark", hint: "", group: "theme", keywords: ["appearance", "night"], when: (c) => c.theme !== "dark" },
  { id: "theme.system", label: "Theme: System", hint: "", group: "theme", keywords: ["appearance", "os", "auto"], when: (c) => c.theme !== "system" },
  { id: "theme.toggle", label: "Switch theme", hint: "cycle Light → Dark → System", group: "theme", keywords: ["appearance", "dark", "light"] },

  // ── Navigate ───────────────────────────────────────────────────────────────
  navigate("home", "Go to Home"),
  navigate("chat", "Open Chat"),
  navigate("sessions", "Open Sessions"),
  navigate("missions", "Open Missions"),
  navigate("agents", "Open Agents"),
  navigate("workers", "Open Workers"),
  navigate("tools", "Open Tools"),
  navigate("mcp", "Open MCP"),
  navigate("activity", "Open Activity"),
  navigate("memory", "Open Memory"),
  navigate("skills", "Open Skills"),
  navigate("settings", "Open Settings"),

  // ── This agent (only inside an agent context) ───────────────────────────────
  { id: "agent.assign", label: "Assign work to this agent", hint: "/agent work", group: "agent", keywords: ["task", "job", "delegate"], when: (c) => c.agentId !== null },
  { id: "agent.memory", label: "View this agent's memory", hint: "/memory", group: "agent", keywords: ["recall", "remember"], when: (c) => c.agentId !== null },
  { id: "agent.switch", label: "Switch agent", hint: "/agents", group: "agent", keywords: ["change", "another"], when: (c) => c.agentCount > 1 },

  // ── Needs you (only when an approval is real) ──────────────────────────────
  { id: "approve.latest", label: "Approve the pending request", hint: "/approve", group: "approval", keywords: ["allow", "yes", "permission"], when: (c) => c.approvalCount > 0 },
  { id: "reject.latest", label: "Reject the pending request", hint: "/deny", group: "approval", keywords: ["deny", "no", "block"], when: (c) => c.approvalCount > 0 },
  { id: "approval.inspect", label: "Inspect approvals", hint: "details drawer", group: "approval", keywords: ["review", "pending"], when: (c) => c.approvalCount > 0 },

  // ── KAI ────────────────────────────────────────────────────────────────────
  { id: "kai.feelings", label: "Preview KAI's feelings", hint: "/feelings", group: "kai", keywords: ["mood", "expression", "appearance", "character"] },
  { id: "sys.diagnostics", label: "Open diagnostics", hint: "Core health", group: "kai", keywords: ["status", "maintenance", "health", "build"] },
  { id: "models.show", label: "Show models", hint: "/models", group: "kai", keywords: ["model", "llm", "list"] },
  { id: "providers.show", label: "Show providers", hint: "/providers", group: "kai", keywords: ["provider", "backend", "connection"] },
  { id: "model.change", label: "Change model", hint: "Settings → Providers", group: "kai", keywords: ["model", "switch", "select", "llm"] },
  { id: "provider.test", label: "Test providers", hint: "Settings → Providers", group: "kai", keywords: ["provider", "test", "connection", "health"] },
];

/** A descriptor is available when it has no gate or its gate passes. */
export function isAvailable(cmd: CommandDescriptor, ctx: CommandContext): boolean {
  return cmd.when === undefined || cmd.when(ctx);
}

/** Every command available in this context, in group order and catalogue order. */
export function availableCommands(ctx: CommandContext): CommandDescriptor[] {
  const rank = new Map(GROUP_ORDER.map((g, i) => [g, i]));
  return COMMANDS.filter((c) => isAvailable(c, ctx)).sort(
    (a, b) => (rank.get(a.group) ?? 99) - (rank.get(b.group) ?? 99),
  );
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Score one command against a query. 0 = no match. Higher is better: a label
 * prefix beats a label substring, which beats a keyword hit.
 */
export function scoreCommand(cmd: CommandDescriptor, query: string): number {
  const q = normalize(query);
  if (q === "") return 1;
  const label = normalize(cmd.label);
  if (label.startsWith(q)) return 100 - label.length;
  const inLabel = label.indexOf(q);
  if (inLabel >= 0) return 60 - inLabel;
  for (const kw of cmd.keywords ?? []) {
    const k = normalize(kw);
    if (k.startsWith(q)) return 40;
    if (k.includes(q)) return 20;
  }
  if (normalize(cmd.hint).includes(q)) return 10;
  return 0;
}

/**
 * The palette's results: available commands ranked by the query, stable within
 * equal scores (so group order and catalogue order survive a search).
 */
export function searchCommands(ctx: CommandContext, query: string): CommandDescriptor[] {
  const ranked = availableCommands(ctx)
    .map((cmd, i) => ({ cmd, score: scoreCommand(cmd, query), i }))
    .filter((r) => r.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return ranked.map((r) => r.cmd);
}

export function commandById(id: string): CommandDescriptor | undefined {
  return COMMANDS.find((c) => c.id === id);
}

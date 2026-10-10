// The shell's route table — pure data and pure parsing, no DOM.
//
// KAI's own navigation vocabulary (owner §38). Each route is a named surface the
// shell mounts into its outlet; the order here IS the sidebar order. The ids are
// closed, and the interface builds every view eagerly, so there is no placeholder
// path: an unknown hash falls back to the default below.
//
// This module is deliberately DOM-free so the routing can be unit-tested with no
// browser and no Core.

export type RouteId =
  | "home"
  | "chat"
  | "sessions"
  | "missions"
  | "goals"
  | "agents"
  | "workers"
  | "tools"
  | "mcp"
  | "activity"
  | "memory"
  | "skills"
  | "settings";

export interface ShellRoute {
  readonly id: RouteId;
  readonly label: string;
  /** One line shown under the topbar title. */
  readonly blurb: string;
  /**
   * KAI's accent for this surface — a colour from KAI's own palette (style.css
   * `:root`). It is drawn as the nav item's indicator, so the shell carries KAI's
   * colour language and nothing borrowed from another product.
   */
  readonly accent: string;
}

export const ROUTES: readonly ShellRoute[] = [
  { id: "home", label: "Home", blurb: "Where KAI is, right now.", accent: "#6366f1" },
  { id: "chat", label: "Chat", blurb: "Talk with KAI.", accent: "#22d3ee" },
  { id: "sessions", label: "Sessions", blurb: "Your conversations with KAI.", accent: "#22d3ee" },
  { id: "missions", label: "Missions", blurb: "Work KAI is carrying out.", accent: "#f5a524" },
  { id: "goals", label: "Goals", blurb: "Challenged, planned, approved — then run.", accent: "#a855f7" },
  { id: "agents", label: "Agents", blurb: "KAI's own personas.", accent: "#f472b6" },
  { id: "workers", label: "Workers", blurb: "The engines KAI drives.", accent: "#34d399" },
  { id: "tools", label: "Tools", blurb: "What KAI can do.", accent: "#6366f1" },
  { id: "mcp", label: "MCP", blurb: "Servers and capabilities KAI has been given.", accent: "#22d3ee" },
  { id: "activity", label: "Activity", blurb: "What KAI has been doing.", accent: "#8b93a1" },
  { id: "memory", label: "Memory", blurb: "What KAI remembers.", accent: "#f472b6" },
  { id: "skills", label: "Skills", blurb: "Procedures KAI has learned.", accent: "#f5a524" },
  { id: "settings", label: "Settings", blurb: "How KAI behaves.", accent: "#9398a1" },
] as const;

export const DEFAULT_ROUTE: RouteId = "home";

const ROUTE_IDS: ReadonlySet<string> = new Set(ROUTES.map((r) => r.id));

export function isRouteId(value: string): value is RouteId {
  return ROUTE_IDS.has(value);
}

/** The route record for an id — always defined, because ids are closed. */
export function routeOf(id: RouteId): ShellRoute {
  const found = ROUTES.find((r) => r.id === id);
  // The type is closed over ROUTES, so this cannot be hit; the fallback keeps the
  // return type non-optional without an `!`.
  return found ?? ROUTES[0]!;
}

/**
 * Parse a location hash (`#/chat`, `#chat`, `#/Settings`) into a route id.
 * Anything unknown — an empty hash, a stray anchor — resolves to the default, so
 * the shell always has a surface to render.
 */
export function parseRoute(hash: string | undefined | null): RouteId {
  const match = /^#\/?([a-zA-Z]+)/.exec(hash ?? "");
  const id = match?.[1]?.toLowerCase() ?? "";
  return isRouteId(id) ? id : DEFAULT_ROUTE;
}

/** The canonical hash for a route. */
export function routeHash(id: RouteId): string {
  return `#/${id}`;
}

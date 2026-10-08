// The shell's page contract.
//
// A page is what the shell mounts into its outlet for one route. Streams B, C and
// D each export a factory shaped like `PageFactory` and hand the integrator ONE
// line: `registerPage("chat", mountChat)`. The shell owns the outlet, the sidebar
// and the router; a page owns only its own DOM inside the outlet.
//
// Nothing here imports the island: the shell is a Core-consuming surface in its
// own window, using its own client, and the island stays a companion.

import type { CoreClient } from "../core/kai-core";
import type { Workspace } from "../workspace/workspace";
import type { RouteId } from "./routes";
import type { ThemeController } from "./theme";

/** Navigate the shell to another route (updates the location hash). */
export type Navigate = (route: RouteId) => void;

/** What every page is handed, once, when the shell first mounts it. */
export interface ShellContext {
  /** A real Core client. The shell's own — never the island's. */
  readonly client: CoreClient;
  /**
   * The shell's workspace (typed routes + real Core event stream + one slice).
   * Streams that render tools/MCP/activity already consume this shape; reusing it
   * keeps the shell at ONE transport and ONE stream.
   */
  readonly workspace: Workspace;
  /** Move the shell to another route. */
  navigate: Navigate;
  /** The live theme (Light/Dark/System). Present in the shell; absent in tests. */
  readonly theme?: ThemeController;
  /**
   * Run a real command by its registry id (see `commands/registry.ts`). This is
   * how a page — e.g. Home's command centre — triggers an action that belongs to
   * the shell (start a session, create an agent, start a mission) without
   * inventing a second implementation. Absent in tests.
   */
  readonly invoke?: (commandId: string) => void;
}

/** One mounted surface. The shell shows/hides `el` as the route changes. */
export interface ShellPage {
  readonly el: HTMLElement;
  /** Called every time the page becomes the visible route, after mount. */
  sync?(): void;
  /** Programmatic navigation into the page's own view (used by the shell handle). */
  showRoute?(route: RouteId): void;
  /** Release listeners/timers when the shell is torn down. */
  destroy?(): void;
}

export type PageFactory = (ctx: ShellContext) => ShellPage;

/**
 * The KAI shell — public surface.
 *
 * The main window's navigation and its outlet. A stream with a real surface
 * imports `registerPage` from here and adds ONE line to `src/shell/main.ts`:
 *
 *   import { registerPage } from "./shell";
 *   registerPage("chat", mountChat);   // or:
 *   import { registerPage } from "../shell";
 *
 * The shell is complete before any page is registered — unregistered routes
 * render the honest placeholder.
 */

export { mountShell } from "./shell";
export type { ShellHandle, ShellMountOptions } from "./shell";
export { registerPage, hasPage, pageFactory, registeredRoutes, clearPages } from "./registry";
export { ROUTES, DEFAULT_ROUTE, isRouteId, parseRoute, routeHash, routeOf } from "./routes";
export type { RouteId, ShellRoute } from "./routes";
export type { ShellContext, ShellPage, PageFactory, Navigate } from "./types";

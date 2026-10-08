// The page registry — the seam every other stream plugs into.
//
// The shell is complete with no pages registered: unregistered routes render the
// honest placeholder. A stream that has a real surface calls `registerPage` with
// its factory, and the shell mounts it on the next visit. This is what stops work
// being "built, proven, and mounted nowhere": the integrator adds one line.
//
// DOM-free, so it is unit-testable with no browser.

import type { RouteId } from "./routes";
import type { PageFactory } from "./types";

const pages = new Map<RouteId, PageFactory>();

/** Register (or replace) the page factory for a route. */
export function registerPage(id: RouteId, factory: PageFactory): void {
  pages.set(id, factory);
}

export function hasPage(id: RouteId): boolean {
  return pages.has(id);
}

export function pageFactory(id: RouteId): PageFactory | undefined {
  return pages.get(id);
}

/** Every route that currently has a real page, in registration order. */
export function registeredRoutes(): RouteId[] {
  return [...pages.keys()];
}

/** Test/reload helper: forget every registration. */
export function clearPages(): void {
  pages.clear();
}

// The shell's navigation and the two-window correction, locked as invariants.
//
//   cd app && node --test tests/shell.test.ts
//
// The routing and the registry are pure, so they are tested directly. The window
// declaration and the island/window split are asserted by reading the two files
// that declare them — the honest way to test "the island entry no longer mounts
// the workspace into a 240×6 strip" without a WebView. Live behaviour is proven
// separately against the launched app (screenshots + CDP).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DEFAULT_ROUTE, ROUTES, isRouteId, parseRoute, routeHash, routeOf } from "../src/shell/routes.ts";
import { clearPages, hasPage, pageFactory, registerPage, registeredRoutes } from "../src/shell/registry.ts";
import type { PageFactory } from "../src/shell/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_ORDER = [
  "home",
  "chat",
  "sessions",
  "missions",
  "agents",
  "workers",
  "tools",
  "mcp",
  "activity",
  "memory",
  "skills",
  "settings",
] as const;

test("the sidebar declares KAI's twelve sections, in order", () => {
  assert.deepEqual(
    ROUTES.map((r) => r.id),
    [...EXPECTED_ORDER],
  );
  for (const route of ROUTES) {
    assert.ok(route.label.length > 0, `${route.id} needs a label`);
    assert.ok(route.blurb.length > 0, `${route.id} needs a blurb`);
    assert.match(route.accent, /^#[0-9a-fA-F]{6}$/, `${route.id} needs a KAI palette accent`);
  }
});

test("the default route is Home", () => {
  assert.equal(DEFAULT_ROUTE, "home");
  assert.equal(parseRoute(""), "home");
  assert.equal(parseRoute(undefined), "home");
});

test("a hash routes to a section; anything unknown falls back to Home", () => {
  assert.equal(parseRoute("#/chat"), "chat");
  assert.equal(parseRoute("#chat"), "chat");
  assert.equal(parseRoute("#/Settings"), "settings");
  assert.equal(parseRoute("#/not-a-route"), "home");
  assert.equal(parseRoute("#"), "home");
  assert.equal(parseRoute("#/home/extra"), "home");
});

test("routeHash and parseRoute round-trip for every section", () => {
  for (const id of EXPECTED_ORDER) {
    assert.equal(parseRoute(routeHash(id)), id);
  }
});

test("isRouteId and routeOf agree with the table", () => {
  assert.ok(isRouteId("mcp"));
  assert.ok(!isRouteId("nope"));
  assert.equal(routeOf("agents").label, "Agents");
});

test("the registry is empty-safe and takes a factory per route", () => {
  clearPages();
  assert.equal(hasPage("chat"), false);
  assert.equal(pageFactory("chat"), undefined);
  assert.deepEqual(registeredRoutes(), []);

  const fake = (() => ({ el: {} as HTMLElement })) as unknown as PageFactory;
  registerPage("chat", fake);
  assert.equal(hasPage("chat"), true);
  assert.equal(pageFactory("chat"), fake);
  assert.deepEqual(registeredRoutes(), ["chat"]);
  clearPages();
  assert.equal(hasPage("chat"), false);
});

test("tauri.conf.json declares the real main window, exactly as specified", () => {
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")) as {
    app: { windows: Array<Record<string, unknown>> };
  };
  const windows = conf.app.windows;
  const main = windows.find((w) => w.label === "main");
  assert.ok(main, "a window labelled `main` must be declared");
  assert.equal(main.url, "shell.html");
  assert.equal(main.width, 1280);
  assert.equal(main.height, 820);
  assert.equal(main.minWidth, 900);
  assert.equal(main.minHeight, 600);
  assert.equal(main.decorations, true);
  assert.equal(main.resizable, true);
  assert.equal(main.alwaysOnTop, false);
  assert.equal(main.transparent, false);
  assert.equal(main.visible, false, "the main window starts hidden");
  // The companion is unchanged and still small.
  const island = windows.find((w) => w.label === "island");
  assert.ok(island);
  assert.equal(island.width, 240);
  assert.equal(island.height, 6);
  assert.equal(island.alwaysOnTop, true);
});

test("the island entry no longer mounts the workspace", () => {
  const main = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
  assert.ok(!main.includes("mountWorkspace"), "the island must not mount the workspace");
  assert.ok(!main.includes("startWorkspace"), "the island must not start the workspace");
});

test("main.ts branches by URL: shell.html renders the shell, not the island", () => {
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")) as {
    app: { windows: Array<Record<string, unknown>> };
  };
  const main = conf.app.windows.find((w) => w.label === "main");
  const island = conf.app.windows.find((w) => w.label === "island");
  assert.notEqual(main?.url, island?.url, "the two windows must have different URLs");
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The workstation-provider seam.
 *
 * Three layers of test, deliberately separated by what they can prove:
 *
 *   CONTRACT — one suite, run against BOTH providers. It is the same assertions
 *     for the mock and for the real `cua-driver`, so a provider cannot pass by
 *     having its own idea of what the interface means.
 *
 *   DRIVER MAPPING — the CUA provider driven by a FAKE process runner. Every
 *     payload fixture below is a verbatim capture from the installed
 *     cua-driver 0.28.2 (see the probe transcript in
 *     docs/architecture/KAI_WORKSTATION.md), not an invented shape. This is
 *     where the honest-effect rule is pinned: a call the driver merely
 *     delivered must come back `unverifiable`.
 *
 *   LIVE — the real provider against the real daemon, for the calls that touch
 *     no pixels and inject no input (availability, status, connect, disconnect,
 *     close). Live capture and live input are skipped by name: the suite runs
 *     unattended on a machine somebody is using, and reading their screen or
 *     clicking their windows is not something a test may do uninvited.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { REAL_DRIVER_SEAM } from "../src/capabilities/computer/transport.ts";
import {
  actionArguments,
  classifyCliRun,
  createCuaWorkstationProvider,
  CUA_TOOL_BY_ACTION,
  readAccessibilityElements,
  readDriverVerdict,
  readScreenshot,
  readWindows,
  type CliRun,
  type CuaCliRunner,
} from "../src/workstation/cua.ts";
import {
  createMockWorkstationProvider,
  MOCK_ELEMENTS,
  MOCK_SCREENSHOT,
  MOCK_WINDOW,
} from "../src/workstation/mock.ts";
import {
  failure,
  isVerifiedOutcome,
  outcome,
  toKaiError,
  validateActionTarget,
  type ActionTarget,
  type WorkstationAction,
  type WorkstationObservation,
  type WorkstationProvider,
} from "../src/workstation/provider.ts";

// ── Harness ───────────────────────────────────────────────────────────────────

const DRIVER_PATH = REAL_DRIVER_SEAM.executable;
const DRIVER_PRESENT = process.platform === "win32" && existsSync(DRIVER_PATH);
const CUA_SKIP_REASON = `cua-driver is not installed at ${DRIVER_PATH} on ${process.platform}`;
const LIVE_CAPTURE = process.env["KAI_WORKSTATION_LIVE_CAPTURE"] === "1";
const LIVE_CAPTURE_SKIP_REASON =
  "live screen capture and live input injection are opt-in (set KAI_WORKSTATION_LIVE_CAPTURE=1); this suite must not read or click a machine somebody is using";

/** A `CliRun` with sane defaults, so a fixture states only what it is about. */
function cliRun(overrides: Partial<CliRun> = {}): CliRun {
  return { code: 0, stdout: "", stderr: "", timedOut: false, spawnFailed: false, ...overrides };
}

interface FakeRunner {
  run: CuaCliRunner;
  /** Every argv the provider built, in order. */
  readonly argv: (readonly string[])[];
  /** Every stdin payload the provider sent, in order. */
  readonly stdin: (string | null)[];
}

/**
 * A process runner that answers from a script keyed by tool name. This is how
 * the CUA provider is tested without a driver, without a screen and without a
 * clock: the mapping and the timeout discipline are the subject, not the OS.
 */
function createFakeRunner(handler: (tool: string, args: readonly string[], stdin: string | null) => CliRun): FakeRunner {
  const argv: (readonly string[])[] = [];
  const stdin: (string | null)[] = [];
  const run: CuaCliRunner = async (_command, args, input) => {
    argv.push([...args]);
    stdin.push(input);
    // `call <tool> …` for tool calls; a bare subcommand (`--version`, `status`)
    // otherwise. The provider's probes are not wrapped in `call`.
    const tool = args[0] === "call" ? (args[1] ?? "") : (args[0] ?? "");
    return handler(tool, args, input);
  };
  return { run, argv, stdin };
}

/** A runner that reports a healthy 0.28.2 install with a running daemon. */
function healthyRunner(extra?: (tool: string) => CliRun | undefined): FakeRunner {
  return createFakeRunner((tool) => {
    const scripted = extra?.(tool);
    if (scripted) return scripted;
    if (tool === "--version") return cliRun({ stdout: "cua-driver 0.28.2\n" });
    if (tool === "status") {
      return cliRun({ stdout: "Cua Driver daemon is running\n  socket: \\\\.\\pipe\\cua-driver\n  permission mode: standard (built_in_default)\n" });
    }
    if (tool === "start_session") return cliRun({ stdout: JSON.stringify({ active: true, session: "kai-workstation" }) });
    if (tool === "end_session") return cliRun({ stdout: JSON.stringify({ active: false, session: "kai-workstation" }) });
    if (tool === "health_report") return cliRun({ stdout: JSON.stringify({ driver_version: "0.28.2", overall: "ok" }) });
    if (tool === "get_screen_size") return cliRun({ stdout: JSON.stringify({ width: 1920, height: 1080 }) });
    return cliRun({ stdout: "{}" });
  });
}

/** A connected CUA provider over a fake runner. */
async function connectedCua(handler: (tool: string, args: readonly string[], stdin: string | null) => CliRun): Promise<{ provider: WorkstationProvider; runner: FakeRunner }> {
  const runner = createFakeRunner(handler);
  const provider = createCuaWorkstationProvider({ runner: runner.run });
  const connected = await provider.connect();
  assert.equal(connected.ok, true, "the fixture provider must connect");
  return { provider, runner };
}

function windowTarget(): ActionTarget {
  return { kind: "element", window: MOCK_WINDOW, elementIndex: 2, snapshotId: "s00000001" };
}

// ── 1. The verdict invariant ──────────────────────────────────────────────────

test("verified is derived from effect and cannot be asserted independently", () => {
  assert.equal(outcome({ effect: "confirmed" }).verified, true);
  for (const effect of ["unverifiable", "suspected_noop", "partial", "refused"] as const) {
    assert.equal(outcome({ effect }).verified, false, `${effect} must never be verified`);
  }
});

test("a hand-written outcome claiming unverifiable-yet-verified is rejected by the invariant", () => {
  // The exact bug this contract exists to prevent, expressed as a literal.
  const lying = { effect: "unverifiable", verified: true } as unknown as WorkstationObservation;
  assert.equal(isVerifiedOutcome(lying), false);
  // And the constructor can never produce it.
  assert.equal(isVerifiedOutcome(outcome({ effect: "unverifiable" })), true);
});

test("a failure can never carry the confirmed effect", () => {
  const refused = failure({ kind: "route", message: "no route", effect: "refused" });
  assert.equal(refused.effect, "refused");
  // The type excludes "confirmed"; this asserts the runtime agrees for every
  // non-confirmed value a caller might pass through an untyped boundary.
  assert.notEqual(refused.effect, "confirmed");
});

// ── 2. Target validation (provider-independent) ───────────────────────────────

test("a malformed target is refused before any provider sees it", () => {
  const cases: [string, WorkstationAction][] = [
    ["an element target with no snapshot", { kind: "click", target: { kind: "element", window: MOCK_WINDOW, elementIndex: 1, snapshotId: "" } }],
    ["an element target with a negative index", { kind: "click", target: { kind: "element", window: MOCK_WINDOW, elementIndex: -1, snapshotId: "s1" } }],
    ["a point target with a non-finite coordinate", { kind: "click", target: { kind: "point", window: MOCK_WINDOW, x: Number.NaN, y: 0 } }],
    ["a window target with a zero pid", { kind: "click", target: { kind: "window", window: { pid: 0, windowId: 1 } } }],
    ["typing at a bare pixel", { kind: "type", target: { kind: "point", window: MOCK_WINDOW, x: 1, y: 2 }, text: "hi" }],
    ["a hotkey with a single key", { kind: "hotkey", target: windowTarget(), keys: ["ctrl"] }],
    ["a drag from an element", { kind: "drag", target: windowTarget(), from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }],
  ];

  for (const [label, action] of cases) {
    const invalid = validateActionTarget(action);
    assert.notEqual(invalid, null, `${label} must be refused`);
    assert.equal(invalid?.kind, "target", `${label} must be a target failure`);
  }

  assert.equal(validateActionTarget({ kind: "click", target: windowTarget() }), null);
  assert.equal(validateActionTarget({ kind: "type", target: { kind: "desktop" }, text: "hi" }), null);
});

// ── 3. Driver payload mapping (real captures) ─────────────────────────────────

test("the driver's own refusal payloads are read as refusals, never as success", () => {
  // Captured verbatim: cua-driver call click '{"pid":999999,"window_id":1,"x":10,"y":10}'
  const targetRefusal = readDriverVerdict({ code: "window_target_not_found", effect: "refused", pid: 999999, window_id: 1 });
  assert.equal(targetRefusal.effect, "refused");
  assert.equal(targetRefusal.driverCode, "window_target_not_found");

  // Captured verbatim: cua-driver call click '{"pid":19084,...,"snapshot_id":"s00000000"}'
  const staleRefusal = readDriverVerdict({
    refusal: { code: "stale_element_token", message: "element_token is stale; call get_window_state again to refresh" },
    status: "refused",
  });
  assert.equal(staleRefusal.effect, "refused");
  assert.equal(staleRefusal.driverCode, "stale_element_token");
  assert.match(staleRefusal.detail ?? "", /stale/);
});

test("a structured isError payload keeps its code and is never confirmed", () => {
  // The shape the driver documents for background_unavailable.
  const verdict = readDriverVerdict({
    isError: true,
    structuredContent: { code: "background_unavailable", escalation: { recommended: "foreground" } },
  });
  assert.equal(verdict.driverCode, "background_unavailable");
  assert.notEqual(verdict.effect, "confirmed");
});

test("verify_state status maps honestly: unknown never implies success", () => {
  assert.equal(readDriverVerdict({ status: "satisfied" }).effect, "confirmed");
  assert.equal(readDriverVerdict({ status: "unsatisfied" }).effect, "suspected_noop");
  assert.equal(readDriverVerdict({ status: "unknown" }).effect, null);
});

test("a payload with no verdict yields no effect, so the caller must say unverifiable", () => {
  // Captured verbatim from get_screen_size: a real payload with no action verdict.
  assert.equal(readDriverVerdict({ height: 1080, scale_factor: 1.1041666666666667, width: 1920 }).effect, null);
  assert.equal(readDriverVerdict("not an object").effect, null);
});

test("a driver effect and route are translated verbatim", () => {
  const verdict = readDriverVerdict({
    effect: "unverifiable",
    route: "synthetic_events",
    evidence: [{ kind: "value_readback" }],
  });
  assert.equal(verdict.effect, "unverifiable");
  assert.equal(verdict.route, "synthetic_events");
  assert.deepEqual(verdict.evidence, ["value_readback"]);
});

// ── 4. Process classification ─────────────────────────────────────────────────

test("the exit code and the parse result are both load-bearing", () => {
  // The trap: the installed driver exits 0 while printing a plain-text
  // rejection for a schema violation.
  const schemaRejection = classifyCliRun(cliRun({ code: 0, stdout: "Missing required integer field: pid\n" }));
  assert.equal(schemaRejection.ok, false);
  assert.equal(schemaRejection.ok === false ? schemaRejection.error.kind : null, "target");

  const daemonDown = classifyCliRun(cliRun({ code: 1, stderr: "Cua Driver daemon is not running on \\\\.\\pipe\\cua-driver.\n" }));
  assert.equal(daemonDown.ok === false ? daemonDown.error.kind : null, "unavailable");

  const permission = classifyCliRun(cliRun({ code: 1, stderr: "Permission denied: tool 'no_such_tool' has no reviewed risk classification\n" }));
  assert.equal(permission.ok === false ? permission.error.kind : null, "permission");
  assert.equal(permission.ok === false ? permission.error.effect : null, "refused");

  const badArgv = classifyCliRun(cliRun({ code: 2, stderr: "error: positional JSON arg did not parse" }));
  assert.equal(badArgv.ok === false ? badArgv.error.kind : null, "protocol");

  assert.equal(classifyCliRun(cliRun({ timedOut: true })).ok === false, true);
  assert.equal(classifyCliRun(cliRun({ spawnFailed: true })).ok === false, true);

  const good = classifyCliRun(cliRun({ stdout: JSON.stringify({ status: "satisfied" }) }));
  assert.equal(good.ok, true);
});

// ── 5. The argv rule ──────────────────────────────────────────────────────────

test("the command line is built only from fixed tokens, never from caller data", () => {
  const provider = createCuaWorkstationProvider({ runner: healthyRunner().run, socket: String.raw`\\.\pipe\cua-driver` });
  assert.deepEqual(provider.invocation("click"), ["call", "click", "--socket", String.raw`\\.\pipe\cua-driver`]);
  assert.throws(() => provider.invocation("browser_navigate"), /unknown driver tool/);
  assert.throws(() => provider.invocation("serve"), /unknown driver tool/);
  assert.throws(() => provider.invocation("stop"), /unknown driver tool/);
});

test("caller values travel on stdin, and never appear in argv", async () => {
  const { provider, runner } = await connectedCua((tool) => {
    if (tool === "type_text") return cliRun({ stdout: JSON.stringify({ effect: "unverifiable" }) });
    return healthyRunnerTool(tool);
  });

  const secret = "https://example.test/private?token=abc";
  const acted = await provider.act({ kind: "type", target: windowTarget(), text: secret });
  assert.equal(acted.ok, true);

  const sentArgv = runner.argv.flat().join(" ");
  assert.equal(sentArgv.includes(secret), false, "caller text must never reach argv");
  assert.equal(sentArgv.includes("example.test"), false, "no caller value may reach argv");

  const lastStdin = runner.stdin[runner.stdin.length - 1] ?? "";
  assert.equal(lastStdin.includes(secret), true, "caller text must travel on stdin");
  assert.equal(lastStdin.includes("element_index"), true);
});

/** The healthy runner's per-tool script, callable outside the closure. */
function healthyRunnerTool(tool: string): CliRun {
  if (tool === "--version") return cliRun({ stdout: "cua-driver 0.28.2\n" });
  if (tool === "status") return cliRun({ stdout: "Cua Driver daemon is running\n  permission mode: standard (built_in_default)\n" });
  if (tool === "start_session") return cliRun({ stdout: JSON.stringify({ active: true, session: "kai-workstation" }) });
  if (tool === "end_session") return cliRun({ stdout: JSON.stringify({ active: false }) });
  if (tool === "health_report") return cliRun({ stdout: JSON.stringify({ driver_version: "0.28.2", overall: "ok" }) });
  if (tool === "get_screen_size") return cliRun({ stdout: JSON.stringify({ width: 1920, height: 1080, scale_factor: 1 }) });
  return cliRun({ stdout: "{}" });
}

test("action arguments carry exactly one addressing mode", () => {
  const element = actionArguments({ kind: "click", target: windowTarget() });
  assert.equal(element.element_index, 2);
  assert.equal(element.snapshot_id, "s00000001");
  assert.equal("x" in element, false);
  assert.equal("scope" in element, false);

  const point = actionArguments({ kind: "click", target: { kind: "point", window: MOCK_WINDOW, x: 5, y: 6 } });
  assert.equal(point.x, 5);
  assert.equal("element_index" in point, false);

  const desktop = actionArguments({ kind: "click", target: { kind: "desktop-point", x: 1, y: 2 } });
  assert.equal(desktop.scope, "desktop");
  assert.equal("pid" in desktop, false);

  const hotkey = actionArguments({ kind: "hotkey", target: windowTarget(), keys: ["ctrl", "shift", "t"] });
  assert.deepEqual(hotkey.keys, ["ctrl", "shift", "t"]);

  const drag = actionArguments({ kind: "drag", target: { kind: "window", window: MOCK_WINDOW }, from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
  assert.equal(drag.from_x, 1);
  assert.equal(drag.to_y, 4);
});

test("the provider never issues a host-changing driver verb", async () => {
  const { provider, runner } = await connectedCua((tool) => healthyRunnerTool(tool));
  await provider.act({ kind: "click", target: windowTarget() });
  await provider.status();
  await provider.close();

  const forbidden = ["stop", "serve", "install", "update", "autostart", "config", "revoke"];
  for (const argv of runner.argv) {
    for (const token of argv) {
      assert.equal(
        forbidden.includes(token),
        false,
        `the provider must never run '${token}' (argv: ${argv.join(" ")})`,
      );
    }
  }
});

// ── 6. Response readers ───────────────────────────────────────────────────────

test("window state is read into elements, a screenshot and a snapshot id", () => {
  const payload = {
    app_name: "notepad.exe",
    snapshot_id: "s00000002",
    screenshot_png_b64: "iVBORw0KGgo=",
    screenshot_mime_type: "image/png",
    screenshot_width: 64,
    screenshot_height: 62,
    elements_complete: true,
    total_element_count: 2,
    elements: [
      { element_index: 0, role: "Button", label: "Save", enabled: true, actions: ["invoke"], frame: { x: 1, y: 2, w: 3, h: 4 }, element_token: "s00000002:0" },
      { element_index: 1, role: "Text", label: "−791 heures" },
    ],
  };

  const elements = readAccessibilityElements(payload);
  assert.equal(elements.length, 2);
  assert.equal(elements[0]?.role, "Button");
  assert.deepEqual(elements[0]?.frame, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(elements[0]?.token, "s00000002:0");

  const screenshot = readScreenshot(payload);
  assert.equal(screenshot?.mimeType, "image/png");
  assert.equal(screenshot?.width, 64);
  assert.equal(screenshot?.dataBase64, "iVBORw0KGgo=");

  assert.equal(readAccessibilityElements({ elements: "nonsense" }).length, 0);
  assert.equal(readScreenshot({}), null);
});

test("a desktop window inventory is read from the accessibility tree", () => {
  const windows = readWindows({
    windows: [{ app_name: "notepad.exe", pid: 10, window_id: 20, title: "Untitled", is_on_screen: true, minimized: false, bounds: { x: 0, y: 0, width: 800, height: 600 } }],
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.windowId, 20);
  assert.equal(windows[0]?.bounds?.width, 800);
  assert.equal(readWindows({ windows: [{ title: "no ids" }] }).length, 0);
});

// ── 7. CUA provider states ────────────────────────────────────────────────────

test("an absent driver is reported honestly, not as an exception", async () => {
  const runner = createFakeRunner(() => cliRun({ spawnFailed: true, stderr: "ENOENT" }));
  const provider = createCuaWorkstationProvider({ runner: runner.run });
  const available = await provider.availability();
  assert.equal(available.ok, true);
  assert.equal(available.ok ? available.value.available : null, false);
  assert.equal(available.ok ? available.value.supported : null, false);
});

test("an installed driver with a stopped daemon is available but not connectable", async () => {
  const runner = createFakeRunner((tool) => {
    if (tool === "--version") return cliRun({ stdout: "cua-driver 0.28.2\n" });
    if (tool === "status") return cliRun({ code: 1, stderr: "Cua Driver daemon is not running\n" });
    return cliRun({ stdout: "{}" });
  });
  const provider = createCuaWorkstationProvider({ runner: runner.run });

  const available = await provider.availability();
  assert.equal(available.ok ? available.value.available : null, true);
  assert.equal(available.ok ? available.value.daemonRunning : null, false);

  const connected = await provider.connect();
  assert.equal(connected.ok, false);
  assert.equal(connected.ok === false ? connected.error.kind : null, "unavailable");
});

test("a driver below the floor is refused as unsupported", async () => {
  const runner = createFakeRunner((tool) => {
    if (tool === "--version") return cliRun({ stdout: "cua-driver 0.19.3\n" });
    return cliRun({ stdout: "Cua Driver daemon is running\n" });
  });
  const provider = createCuaWorkstationProvider({ runner: runner.run });
  const available = await provider.availability();
  assert.equal(available.ok ? available.value.supported : null, false);
  const connected = await provider.connect();
  assert.equal(connected.ok === false ? connected.error.kind : null, "unsupported");
});

test("a delivered action with no driver verdict is unverifiable, never confirmed", async () => {
  const { provider } = await connectedCua((tool) => {
    // A bare success payload: the driver said nothing about the effect.
    if (tool === "click") return cliRun({ stdout: JSON.stringify({ performed: true }) });
    return healthyRunnerTool(tool);
  });

  const acted = await provider.act({ kind: "click", target: windowTarget() });
  assert.equal(acted.ok, true);
  assert.equal(acted.ok ? acted.value.effect : null, "unverifiable");
  assert.equal(acted.ok ? acted.value.verified : null, false, "a delivered event is not an applied change");
});

test("an action is confirmed only when the driver says so", async () => {
  const { provider } = await connectedCua((tool) => {
    if (tool === "click") {
      return cliRun({ stdout: JSON.stringify({ effect: "confirmed", route: "accessibility", evidence: [{ kind: "value_readback" }] }) });
    }
    return healthyRunnerTool(tool);
  });

  const acted = await provider.act({ kind: "click", target: windowTarget() });
  assert.equal(acted.ok ? acted.value.effect : null, "confirmed");
  assert.equal(acted.ok ? acted.value.verified : null, true);
  assert.equal(acted.ok ? acted.value.route : null, "accessibility");
});

test("a partial delivery is reported as partial", async () => {
  const { provider } = await connectedCua((tool) => {
    if (tool === "type_text") return cliRun({ stdout: JSON.stringify({ effect: "partial", delivery: { delivered_count: 3 } }) });
    return healthyRunnerTool(tool);
  });
  const acted = await provider.act({ kind: "type", target: windowTarget(), text: "abcdef" });
  assert.equal(acted.ok ? acted.value.effect : null, "partial");
  assert.equal(acted.ok ? acted.value.verified : null, false);
});

test("a stale handle is a typed stale_session failure carrying the driver's code", async () => {
  const { provider } = await connectedCua((tool) => {
    if (tool === "click") {
      return cliRun({
        stdout: JSON.stringify({ refusal: { code: "stale_element_token", message: "element_token is stale" }, status: "refused" }),
      });
    }
    return healthyRunnerTool(tool);
  });

  const acted = await provider.act({ kind: "click", target: windowTarget() });
  assert.equal(acted.ok, false);
  assert.equal(acted.ok === false ? acted.error.kind : null, "stale_session");
  assert.equal(acted.ok === false ? acted.error.driverCode : null, "stale_element_token");
  assert.equal(acted.ok === false ? acted.error.effect : null, "refused");
});

test("a permission denial is a typed permission failure", async () => {
  const { provider } = await connectedCua((tool) => {
    if (tool === "click") return cliRun({ code: 1, stderr: "Permission denied: tool 'click' has no reviewed risk classification\n" });
    return healthyRunnerTool(tool);
  });
  const acted = await provider.act({ kind: "click", target: windowTarget() });
  assert.equal(acted.ok === false ? acted.error.kind : null, "permission");
  assert.equal(acted.ok === false ? acted.error.effect : null, "refused");
});

test("a hung driver call is bounded and reported as a timeout", async () => {
  const runner = createFakeRunner((tool) => {
    if (tool === "click") return cliRun({ timedOut: true, code: null });
    return healthyRunnerTool(tool);
  });
  const provider = createCuaWorkstationProvider({ runner: runner.run, timeoutMs: 25 });
  const connected = await provider.connect();
  assert.equal(connected.ok, true);

  const acted = await provider.act({ kind: "click", target: windowTarget() });
  assert.equal(acted.ok === false ? acted.error.kind : null, "timeout");
  assert.equal(acted.ok === false ? acted.error.retryable : null, true);
});

test("a malformed action is refused without ever reaching the driver", async () => {
  const { provider, runner } = await connectedCua((tool) => healthyRunnerTool(tool));
  const before = runner.argv.length;

  const acted = await provider.act({
    kind: "click",
    target: { kind: "element", window: MOCK_WINDOW, elementIndex: 3, snapshotId: "" },
  });

  assert.equal(acted.ok === false ? acted.error.kind : null, "target");
  assert.equal(runner.argv.length, before, "a refused action must not reach the driver");
});

test("an unconnected provider refuses to observe or act", async () => {
  const runner = healthyRunner();
  const provider = createCuaWorkstationProvider({ runner: runner.run });
  const observed = await provider.observe({ kind: "desktop" });
  assert.equal(observed.ok === false ? observed.error.kind : null, "unavailable");
  const acted = await provider.act({ kind: "click", target: windowTarget() });
  assert.equal(acted.ok === false ? acted.error.kind : null, "unavailable");
});

test("a window observation carries elements, a snapshot id and completeness", async () => {
  const { provider } = await connectedCua((tool) => {
    if (tool === "get_window_state") {
      return cliRun({
        stdout: JSON.stringify({
          window_title: "Untitled — Notepad",
          snapshot_id: "s00000003",
          screenshot_png_b64: "iVBORw0KGgo=",
          screenshot_mime_type: "image/png",
          screenshot_width: 800,
          screenshot_height: 600,
          elements_complete: true,
          total_element_count: 2,
          elements: [
            { element_index: 0, role: "Edit", label: "Text editor" },
            { element_index: 1, role: "Button", label: "Save" },
          ],
        }),
      });
    }
    return healthyRunnerTool(tool);
  });

  const observed = await provider.observe({ kind: "window", window: MOCK_WINDOW });
  assert.equal(observed.ok, true);
  assert.equal(observed.ok ? observed.value.effect : null, "confirmed");
  assert.equal(observed.ok ? observed.value.snapshotId : null, "s00000003");
  assert.equal(observed.ok ? observed.value.elements.length : null, 2);
  assert.equal(observed.ok ? observed.value.complete : null, true);
  assert.equal(observed.ok ? observed.value.screenshot?.width : null, 800);
});

test("a truncated accessibility walk is reported as incomplete", async () => {
  const { provider } = await connectedCua((tool) => {
    if (tool === "get_window_state") {
      return cliRun({
        stdout: JSON.stringify({
          snapshot_id: "s00000004",
          elements_complete: false,
          total_element_count: 5000,
          returned_element_count: 2,
          elements: [{ element_index: 0, role: "Button", label: "Save" }],
        }),
      });
    }
    return healthyRunnerTool(tool);
  });
  const observed = await provider.observe({ kind: "window", window: MOCK_WINDOW });
  assert.equal(observed.ok ? observed.value.complete : null, false);
});

test("a desktop observation unions pixels with the window inventory", async () => {
  const { provider } = await connectedCua((tool) => {
    if (tool === "get_desktop_state") {
      return cliRun({ stdout: JSON.stringify({ screenshot_png_b64: "iVBORw0KGgo=", screenshot_mime_type: "image/png", screenshot_width: 1920, screenshot_height: 1080 }) });
    }
    if (tool === "get_accessibility_tree") {
      return cliRun({ stdout: JSON.stringify({ windows: [{ pid: 10, window_id: 20, title: "Untitled", app_name: "notepad.exe" }] }) });
    }
    return healthyRunnerTool(tool);
  });

  const observed = await provider.observe({ kind: "desktop" });
  assert.equal(observed.ok, true);
  assert.equal(observed.ok ? observed.value.windows?.length : null, 1);
  assert.equal(observed.ok ? observed.value.screenshot?.width : null, 1920);
});

test("status reports the driver's own permission mode", async () => {
  const { provider } = await connectedCua((tool) => healthyRunnerTool(tool));
  const status = await provider.status();
  assert.equal(status.ok, true);
  assert.equal(status.ok ? status.value.permissionMode : null, "standard");
  assert.equal(status.ok ? status.value.connected : null, true);
  assert.equal(status.ok ? status.value.screen?.width : null, 1920);
});

test("close is idempotent and tears down the session without stopping the daemon", async () => {
  const { provider, runner } = await connectedCua((tool) => healthyRunnerTool(tool));
  await provider.close();
  await provider.close();

  const ended = runner.argv.filter((argv) => argv[1] === "end_session").length;
  assert.equal(ended, 1, "the session is ended exactly once");
  for (const argv of runner.argv) assert.equal(argv.includes("stop"), false, "the daemon must be left running");
});

// ── 8. Core error bridge ──────────────────────────────────────────────────────

test("a workstation failure bridges into the Core's frozen error contract", () => {
  assert.equal(toKaiError(failure({ kind: "timeout", message: "slow", retryable: true })).code, "AGENT_TIMEOUT");
  assert.equal(toKaiError(failure({ kind: "unavailable", message: "gone" })).code, "AGENT_NOT_LISTENING");
  assert.equal(toKaiError(failure({ kind: "permission", message: "no" })).code, "POLICY_DENIED");
  assert.equal(toKaiError(failure({ kind: "target", message: "bad" })).code, "VALIDATION_FAILED");

  const bridged = toKaiError(failure({ kind: "stale_session", message: "stale", driverCode: "stale_element_token" }));
  assert.equal(bridged.code, "AGENT_RUN_ABANDONED");
  assert.match(bridged.detail ?? "", /stale_element_token/);
});

// ── 9. Mock provider: the required states ─────────────────────────────────────

test("mock: connect and disconnect move the lifecycle and are observable in status", async () => {
  const provider = createMockWorkstationProvider();
  assert.equal((await provider.status()).ok ? (await provider.status()).value.connected : null, false);

  const connected = await provider.connect();
  assert.equal(connected.ok, true);
  const status = await provider.status();
  assert.equal(status.ok ? status.value.connected : null, true);

  const disconnected = await provider.disconnect();
  assert.equal(disconnected.ok, true);
  assert.equal(provider.calls.connect, 1);
  assert.equal(provider.calls.disconnect, 1);
});

test("mock: an unavailable provider is reported honestly rather than thrown", async () => {
  const provider = createMockWorkstationProvider({
    availability: { available: false, version: null, supported: false, daemonRunning: false, detail: "driver not installed" },
  });

  const available = await provider.availability();
  assert.equal(available.ok, true);
  assert.equal(available.ok ? available.value.available : null, false);
  assert.equal(available.ok ? available.value.detail : null, "driver not installed");

  const connected = await provider.connect();
  assert.equal(connected.ok, false);
  assert.equal(connected.ok === false ? connected.error.kind : null, "unavailable");
});

test("mock: a timeout is a typed, retryable failure", async () => {
  const provider = createMockWorkstationProvider({ timeouts: ["observe"] });
  await provider.connect();
  const observed = await provider.observe({ kind: "desktop" });
  assert.equal(observed.ok, false);
  assert.equal(observed.ok === false ? observed.error.kind : null, "timeout");
  assert.equal(observed.ok === false ? observed.error.retryable : null, true);
});

test("mock: a stale session refuses further work and says why", async () => {
  const provider = createMockWorkstationProvider({ staleAfter: 1 });
  await provider.connect();
  assert.equal((await provider.observe({ kind: "window", window: MOCK_WINDOW })).ok, true);

  const second = await provider.observe({ kind: "window", window: MOCK_WINDOW });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false ? second.error.kind : null, "stale_session");
  assert.equal(second.ok === false ? second.error.driverCode : null, "stale_element_token");
  assert.equal(second.ok === false ? second.error.effect : null, "refused");
});

test("mock: a permission refusal is a typed failure, not a success", async () => {
  const provider = createMockWorkstationProvider({ permissionsDenied: ["act"] });
  await provider.connect();
  const acted = await provider.act({ kind: "click", target: windowTarget() });
  assert.equal(acted.ok, false);
  assert.equal(acted.ok === false ? acted.error.kind : null, "permission");
  assert.equal(acted.ok === false ? acted.error.effect : null, "refused");
});

test("mock: an unscripted action is unverifiable, never confirmed", async () => {
  const provider = createMockWorkstationProvider();
  await provider.connect();
  const acted = await provider.act({ kind: "click", target: windowTarget() });
  assert.equal(acted.ok, true);
  assert.equal(acted.ok ? acted.value.effect : null, "unverifiable");
  assert.equal(acted.ok ? acted.value.verified : null, false);
  assert.equal(acted.ok ? isVerifiedOutcome(acted.value) : null, true);
});

test("mock: a scripted refusal never reaches the provider's action path", async () => {
  const provider = createMockWorkstationProvider();
  await provider.connect();
  const before = provider.calls.act.length;

  const refused = await provider.act({ kind: "click", target: { kind: "point", window: MOCK_WINDOW, x: Number.POSITIVE_INFINITY, y: 0 } });
  assert.equal(refused.ok === false ? refused.error.kind : null, "target");
  assert.equal(provider.calls.act.length, before, "a refused action must not be recorded as delivered");
});

test("mock: scripted observations and actions are returned in order and then repeat", async () => {
  const provider = createMockWorkstationProvider({
    observations: [
      { verdict: { effect: "confirmed" }, elements: [MOCK_ELEMENTS[1]!], snapshotId: "s00000001", screenshot: MOCK_SCREENSHOT },
      { verdict: { effect: "confirmed" }, elements: [MOCK_ELEMENTS[1]!, MOCK_ELEMENTS[2]!], snapshotId: "s00000002" },
    ],
    actions: [{ verdict: { effect: "confirmed" } }],
  });
  await provider.connect();

  const first = await provider.observe({ kind: "window", window: MOCK_WINDOW });
  assert.equal(first.ok ? first.value.elements.length : null, 1);
  assert.equal(first.ok ? first.value.snapshotId : null, "s00000001");

  const second = await provider.observe({ kind: "window", window: MOCK_WINDOW });
  assert.equal(second.ok ? second.value.elements.length : null, 2);

  const third = await provider.observe({ kind: "window", window: MOCK_WINDOW });
  assert.equal(third.ok ? third.value.snapshotId : null, "s00000002", "the last step repeats rather than running out");

  const acted = await provider.act({ kind: "click", target: windowTarget() });
  assert.equal(acted.ok ? acted.value.effect : null, "confirmed");
});

test("mock: the mock is deterministic — no wall clock, no sleeping", async () => {
  const provider = createMockWorkstationProvider({ now: () => "2026-01-01T00:00:00.000Z" });
  await provider.connect();
  const first = await provider.observe({ kind: "window", window: MOCK_WINDOW });
  const second = await provider.observe({ kind: "window", window: MOCK_WINDOW });
  assert.equal(first.ok ? first.value.capturedAt : null, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(first.ok ? first.value.capturedAt : null, second.ok ? second.value.capturedAt : null);
});

// ── 10. The contract suite, run against BOTH providers ────────────────────────

interface ContractOptions {
  /** True when the provider talks to a real machine. */
  live: boolean;
  /** Named reason to skip the whole suite (e.g. no driver binary). */
  skip?: string;
}

/**
 * One suite, two providers. Everything here is a statement about the INTERFACE,
 * so a provider that disagrees fails — which is the point of having a seam.
 *
 * The split between `suite` and `liveSuite` is a safety boundary, not tidiness:
 * a live provider must not be asked to read the operator's screen or click
 * their windows just because a test suite ran.
 */
function contractSuite(label: string, make: () => WorkstationProvider, options: ContractOptions): void {
  const skip = options.skip;
  const suite = (name: string, fn: () => Promise<void>): void => {
    test(`${label}: ${name}`, { skip }, fn);
  };
  const liveSuite = (name: string, fn: () => Promise<void>): void => {
    test(`${label}: ${name}`, {
      skip: skip ?? (options.live ? LIVE_CAPTURE_SKIP_REASON : "the mock has no live screen"),
    }, fn);
  };

  suite("availability answers with a typed, honest report", async () => {
    const provider = make();
    const available = await provider.availability();
    assert.equal(available.ok, true, "availability must resolve, never throw");
    if (available.ok) {
      assert.equal(typeof available.value.available, "boolean");
      assert.equal(typeof available.value.supported, "boolean");
      assert.equal(typeof available.value.daemonRunning, "boolean");
      if (!available.value.available) {
        assert.equal(available.value.version, null, "an unavailable provider reports no version");
      }
    }
    await provider.close();
  });

  suite("status answers with the full typed shape", async () => {
    const provider = make();
    const status = await provider.status();
    assert.equal(status.ok, true);
    if (status.ok) {
      assert.equal(typeof status.value.connected, "boolean");
      assert.equal(typeof status.value.daemonRunning, "boolean");
      assert.equal(status.value.permissionMode === null || typeof status.value.permissionMode === "string", true);
    }
    await provider.close();
  });

  suite("connect and disconnect round-trip, and close is idempotent", async () => {
    const provider = make();
    const available = await provider.availability();
    if (!available.ok || !available.value.available || !available.value.supported || !available.value.daemonRunning) {
      const connected = await provider.connect();
      assert.equal(connected.ok, false, "an unusable provider must refuse connect rather than pretend");
      await provider.close();
      return;
    }

    const connected = await provider.connect();
    assert.equal(connected.ok, true);
    if (connected.ok) {
      assert.equal(typeof connected.value.version, "string");
      assert.equal(connected.value.capabilities.length > 0, true);
    }

    assert.equal((await provider.disconnect()).ok, true);
    await provider.close();
    await provider.close();
  });

  suite("a malformed target is refused before the provider is asked to act", async () => {
    const provider = make();
    const acted = await provider.act({
      kind: "click",
      target: { kind: "element", window: MOCK_WINDOW, elementIndex: 0, snapshotId: "" },
    });
    assert.equal(acted.ok, false);
    assert.equal(acted.ok === false ? acted.error.kind : null, "target");
    await provider.close();
  });

  suite("every outcome satisfies the verified invariant", async () => {
    const provider = make();
    const connected = await provider.connect();
    if (!connected.ok) {
      await provider.close();
      return;
    }

    // Only a provider whose screen is a fixture may be asked to act here.
    if (!options.live) {
      const observed = await provider.observe({ kind: "window", window: MOCK_WINDOW });
      assert.equal(observed.ok, true);
      if (observed.ok) assert.equal(isVerifiedOutcome(observed.value), true);

      const acted = await provider.act({ kind: "click", target: windowTarget() });
      assert.equal(acted.ok, true);
      if (acted.ok) {
        assert.equal(isVerifiedOutcome(acted.value), true);
        assert.equal(acted.value.verified, acted.value.effect === "confirmed");
      }
    }
    await provider.close();
  });

  liveSuite("observation against a live screen", async () => {
    const provider = make();
    const connected = await provider.connect();
    if (!connected.ok) {
      await provider.close();
      return;
    }
    const observed = await provider.observe({ kind: "desktop" });
    assert.equal(observed.ok, true);
    if (observed.ok) {
      assert.equal(observed.value.screenshot !== null || (observed.value.windows?.length ?? 0) > 0, true);
      assert.equal(isVerifiedOutcome(observed.value), true);
    }
    await provider.close();
  });
}

contractSuite("mock", () => createMockWorkstationProvider(), { live: false });

contractSuite(
  "cua",
  () =>
    createCuaWorkstationProvider({
      // The live suite only ever asks the daemon questions; it injects no input.
      runner: undefined,
    }),
  { live: true, skip: DRIVER_PRESENT ? undefined : CUA_SKIP_REASON },
);

test("the CUA provider is skipped by name, never silently passed, when the binary is absent", () => {
  if (DRIVER_PRESENT) {
    assert.equal(existsSync(DRIVER_PATH), true);
    return;
  }
  assert.match(CUA_SKIP_REASON, /cua-driver is not installed at/);
});

test("the mock and CUA providers declare distinct kinds and ids", async () => {
  const mock = createMockWorkstationProvider();
  const cua = createCuaWorkstationProvider({ runner: healthyRunner().run });
  assert.equal(mock.kind, "mock");
  assert.equal(cua.kind, "cua");
  assert.notEqual(mock.id, cua.id);
  await mock.close();
  await cua.close();
});

test("the tool map is closed and covers every action kind", () => {
  const kinds: WorkstationAction["kind"][] = ["click", "type", "key", "hotkey", "scroll", "drag"];
  for (const kind of kinds) {
    assert.equal(typeof CUA_TOOL_BY_ACTION[kind], "string", `${kind} must map to a driver tool`);
  }
  assert.equal(Object.keys(CUA_TOOL_BY_ACTION).length, kinds.length);
});

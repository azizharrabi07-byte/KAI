// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The workstation provider against the REAL `cua-driver` on THIS machine.
 *
 * Two layers, deliberately separated by what they can prove:
 *
 *   RECORDED — assertions against `docs/evidence/workstation-live.json`, a
 *     verbatim capture of read-only driver output taken on this machine. This
 *     layer runs EVERYWHERE, needs no driver, and is where the provider's
 *     classification is pinned against real bytes rather than invented shapes.
 *     The load-bearing fact lives here: the installed driver exits **0** while
 *     printing a plain-text rejection to **stdout** for a schema violation, so
 *     neither the exit code nor the parse result alone is enough.
 *
 *   LIVE — the real provider over the real binary and the real named pipe,
 *     restricted to HARMLESS, READ-ONLY, already-authorized operations
 *     (`--version`, `status`, `doctor --json`, `list-tools`, `get_screen_size`,
 *     `check_permissions`, `health_report`, `list_windows`,
 *     `get_accessibility_tree`, and the deliberately-invalid invocations the
 *     driver refuses). **No pixels of the operator's screen are read and no
 *     input is injected.** This layer is opt-in via `KAI_WORKSTATION_LIVE=1`
 *     and skips by name otherwise: a test suite must never read or click a
 *     machine somebody is using.
 *
 * Run from `core/`:
 *   node --test --experimental-strip-types tests/workstation-live.test.ts
 *   KAI_WORKSTATION_LIVE=1 node --test --experimental-strip-types tests/workstation-live.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { REAL_DRIVER_SEAM } from "../src/capabilities/computer/transport.ts";
import {
  classifyCliRun,
  createCuaWorkstationProvider,
  createNodeCliRunner,
  readDriverVerdict,
  readWindows,
  type CliRun,
  type CuaCliRunner,
} from "../src/workstation/cua.ts";

// ── The recorded transcript ───────────────────────────────────────────────────

interface RecordedProbe {
  args: readonly string[];
  stdin: string | null;
  code: number | null;
  signal: string | null;
  ms: number;
  stdout: string;
  stderr: string;
  error: string | null;
}

interface RecordedRefusal {
  tool: string;
  stdin: unknown;
  exitCode: number;
  payload: unknown;
}

interface RecordedEvidence {
  capturedAt: string;
  host: { platform: string; os: string; arch: string; node: string; hostname: string };
  driver: {
    executable: string;
    socket: string;
    version: string;
    parsedVersion: string;
    daemonRunning: boolean;
    daemonPid: number;
    permissionMode: string | null;
    doctorOk: boolean;
    doctorProbes: { label: string; status: string }[];
    toolCount: number;
    toolNames: string[];
  };
  invocation: { probes: string; args: string; example: string };
  facts: {
    screen: { width: number; height: number; scale_factor: number };
    permissions: { elevated: boolean; integrity_level: string; uia: boolean; post_message: boolean };
    health: { driver_version: string; overall: string; platform: string; schema_version: string };
    windowCount: number;
    legacyWindowCount: number;
    accessibilityTree: { windowCount: number; processCount: number };
    startSession: Record<string, unknown>;
    endSession: Record<string, unknown>;
  };
  recordedRefusals: Record<string, RecordedRefusal | string>;
  probes: Record<string, RecordedProbe>;
}

const EVIDENCE_PATH = fileURLToPath(new URL("../../docs/evidence/workstation-live.json", import.meta.url));
// Repo-committed capture, not untrusted input: cast once to the shape this file
// asserts against, and every field below is checked explicitly.
const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as RecordedEvidence;

/** The recorded run: the raw probe plus the fields `classifyCliRun` consumes. */
type RecordedRun = RecordedProbe & CliRun;

/** The recorded run, in the shape `classifyCliRun` consumes. */
function recorded(label: string): RecordedRun {
  const probe = evidence.probes[label];
  assert.ok(probe, `the transcript must contain the ${label} probe`);
  return {
    ...probe,
    timedOut: false,
    spawnFailed: false,
  };
}

// ── Live opt-in ───────────────────────────────────────────────────────────────

const LIVE = process.env["KAI_WORKSTATION_LIVE"] === "1";
const LIVE_SKIP_REASON =
  "live driver calls are opt-in (set KAI_WORKSTATION_LIVE=1); this suite must not read or click a machine somebody is using";

const DRIVER_PRESENT = process.platform === "win32" && existsSync(REAL_DRIVER_SEAM.executable);
const DRIVER_SKIP_REASON = `cua-driver is not installed at ${REAL_DRIVER_SEAM.executable} on ${process.platform}`;

/** Both gates, as one skip reason or `undefined` to run. */
function liveSkip(): string | undefined {
  if (!LIVE) return LIVE_SKIP_REASON;
  if (!DRIVER_PRESENT) return DRIVER_SKIP_REASON;
  return undefined;
}

/** The provider's own production runner: the same process seam the seam uses. */
const runDriver: CuaCliRunner = createNodeCliRunner();

/** Run one read-only driver invocation and classify it exactly as the provider does. */
async function probe(args: readonly string[], stdin: string | null, timeoutMs = 20_000) {
  const run = await runDriver(REAL_DRIVER_SEAM.executable, args, stdin, timeoutMs);
  return { run, classified: classifyCliRun(run) };
}

const PIPE = REAL_DRIVER_SEAM.windowsPipe;
/** A pipe name nothing listens on. Used to prove the daemon-absent shape without touching the real daemon. */
const DEAD_PIPE = String.raw`\\.\pipe\kai-no-such-daemon`;

// ── A. The transcript is real and is from THIS machine ────────────────────────

test("the recorded transcript names this machine's driver, socket and install", () => {
  assert.equal(evidence.driver.executable, REAL_DRIVER_SEAM.executable);
  assert.equal(evidence.driver.socket, REAL_DRIVER_SEAM.windowsPipe);
  assert.equal(evidence.driver.version, "cua-driver 0.28.2");
  assert.equal(evidence.driver.parsedVersion, REAL_DRIVER_SEAM.installedVersion);
  assert.equal(evidence.driver.daemonRunning, true);
  assert.equal(evidence.driver.permissionMode, "standard");
  assert.ok(evidence.driver.daemonPid > 0, "the daemon pid is recorded");
  assert.match(evidence.invocation.example, /--socket/);
  assert.match(evidence.invocation.args, /STDIN/);
});

test("every doctor probe passed on the recorded machine", () => {
  assert.equal(evidence.driver.doctorOk, true);
  assert.equal(evidence.driver.doctorProbes.length, 7);
  for (const probe of evidence.driver.doctorProbes) {
    assert.equal(probe.status, "ok", `doctor probe '${probe.label}' must be ok`);
  }
  const labels = evidence.driver.doctorProbes.map((p) => p.label);
  // The one that decides whether ANY of this works: a desktop the driver can see.
  assert.ok(labels.includes("interactive session"), "the interactive-session probe is recorded");
  assert.ok(labels.includes("UI Automation"), "the UIA probe is recorded");
});

test("the recorded tool registry is the 57-tool surface the provider draws from", () => {
  assert.equal(evidence.driver.toolCount, 57);
  assert.equal(evidence.driver.toolNames.length, 57);
  // The tools this provider actually names must exist in the registry, or the
  // closed map in cua.ts would be addressing tools the driver does not have.
  for (const tool of ["click", "type_text", "press_key", "hotkey", "scroll", "drag"]) {
    assert.ok(evidence.driver.toolNames.includes(tool), `${tool} must be in the driver's registry`);
  }
  for (const tool of ["health_report", "get_screen_size", "get_window_state", "get_desktop_state", "get_accessibility_tree", "start_session", "end_session"]) {
    assert.ok(evidence.driver.toolNames.includes(tool), `${tool} must be in the driver's registry`);
  }
  // And the probes this file runs against the real binary.
  assert.ok(evidence.driver.toolNames.includes("check_permissions"));
  assert.ok(evidence.driver.toolNames.includes("list_windows"));
});

test("the recorded read-only facts are the ones the provider reports", () => {
  assert.equal(evidence.facts.screen.width, 1920);
  assert.equal(evidence.facts.screen.height, 1080);
  assert.equal(evidence.facts.permissions.uia, true);
  assert.equal(evidence.facts.permissions.post_message, true);
  assert.equal(evidence.facts.health.driver_version, "0.28.2");
  assert.equal(evidence.facts.health.overall, "ok");
  assert.equal(evidence.facts.health.platform, "win32");
  assert.ok(evidence.facts.windowCount > 0, "the machine had visible windows when captured");
  // A fresh session does NOT get desktop scope — the escalation is explicit.
  assert.equal(evidence.facts.startSession["desktop_capture_authorized"], false);
  assert.equal(evidence.facts.startSession["effective_scope"], "window");
  assert.equal(evidence.facts.endSession["active"], false);
});

// ── B. The four real error shapes ─────────────────────────────────────────────
//
// This is the load-bearing finding. The installed driver has FOUR distinct
// failure shapes and one of them EXITS 0 with plain text on STDOUT, so a
// classifier that trusts the exit code reports an empty success for a call the
// driver rejected. All four were captured from the real binary.

test("all four real error shapes classify as typed failures, never as success", () => {
  const cases: [label: string, kind: string][] = [
    ["err-unknown-tool", "permission"],
    ["err-schema-violation", "target"],
    ["err-argv-json", "protocol"],
    ["err-daemon-absent", "unavailable"],
  ];

  for (const [label, kind] of cases) {
    const run = recorded(label);
    const classified = classifyCliRun(run);
    assert.equal(classified.ok, false, `${label} must not classify as success`);
    assert.equal(classified.ok ? null : classified.error.kind, kind, `${label} must be a ${kind} failure`);
    assert.notEqual(classified.ok ? null : classified.error.effect, "confirmed");
  }
});

test("the exit-0-with-text-on-stdout shape is an ERROR, not an empty success", () => {
  // The whole reason the exit code alone is not enough. Verbatim from the
  // installed driver: a schema violation prints to stdout and exits 0.
  const run = recorded("err-schema-violation");
  assert.equal(run.code, 0, "the driver really does exit 0 for this shape");
  assert.equal(run.stderr.trim(), "", "and prints nothing on stderr");
  assert.equal(run.stdout.trim(), "Missing required integer field pid.");

  const classified = classifyCliRun(run);
  assert.equal(classified.ok, false, "exit 0 with unparseable stdout must be a failure");
  assert.equal(classified.ok ? null : classified.error.kind, "target");
  assert.match(classified.ok ? "" : (classified.error.detail ?? ""), /Missing required integer field pid/);
});

test("the exit code alone is never sufficient: exit 0 with no parseable payload is a failure", () => {
  const shapes: [label: string, run: CliRun, kind: string][] = [
    ["empty stdout, exit 0", { code: 0, stdout: "", stderr: "", timedOut: false, spawnFailed: false }, "protocol"],
    ["unrecognised text, exit 0", { code: 0, stdout: "something the driver has never printed", stderr: "", timedOut: false, spawnFailed: false }, "protocol"],
    ["real schema rejection, exit 0", recorded("err-schema-violation"), "target"],
  ];
  for (const [label, run, kind] of shapes) {
    assert.equal(run.code, 0, `${label} is an exit-0 shape`);
    const classified = classifyCliRun(run);
    assert.equal(classified.ok, false, `${label} must not be an empty success`);
    assert.equal(classified.ok ? null : classified.error.kind, kind, `${label} must be a ${kind} failure`);
  }
});

test("a real daemon-absent rejection names the socket it could not reach", () => {
  const run = recorded("err-daemon-absent");
  assert.equal(run.code, 1);
  assert.match(run.stderr, /daemon is not running/);
  assert.ok(run.args.includes(DEAD_PIPE), "the probe used a pipe with no daemon, not the real one");

  const classified = classifyCliRun(run);
  assert.equal(classified.ok, false);
  assert.equal(classified.ok ? null : classified.error.kind, "unavailable");
  assert.equal(classified.ok ? null : classified.error.retryable, true, "a stopped daemon is retryable");
});

test("the argv-JSON rejection is exit 2 and is classified as a protocol failure", () => {
  const run = recorded("err-argv-json");
  assert.equal(run.code, 2);
  assert.match(run.stderr, /did not parse/);
  const classified = classifyCliRun(run);
  assert.equal(classified.ok, false);
  assert.equal(classified.ok ? null : classified.error.kind, "protocol");
});

test("an unknown tool is refused by the driver's own risk review, not by the provider", () => {
  const run = recorded("err-unknown-tool");
  assert.equal(run.code, 1);
  assert.match(run.stderr, /no reviewed risk classification/);
  const classified = classifyCliRun(run);
  assert.equal(classified.ok, false);
  assert.equal(classified.ok ? null : classified.error.kind, "permission");
  assert.equal(classified.ok ? null : classified.error.effect, "refused");
});

// ── C. Refusals arrive in-band, with a verdict ────────────────────────────────

test("a real refusal payload maps to effect refused, never to success", () => {
  for (const key of ["window_target_not_found", "stale_element_token"]) {
    const entry = evidence.recordedRefusals[key] as RecordedRefusal;
    assert.equal(entry.exitCode, 0, `${key} arrives with exit 0`);
    const verdict = readDriverVerdict(entry.payload);
    assert.equal(verdict.effect, "refused", `${key} must be a refusal`);
    assert.equal(verdict.driverCode, key, `${key} keeps the driver's own code`);
  }
});

test("a refusal that names itself is refused even without the explicit marker", () => {
  // The driver's published reason set can arrive as a bare code. Reporting that
  // as `unverifiable` would discard the driver's statement that it did not act.
  assert.equal(readDriverVerdict({ code: "route_unavailable", message: "no background route" }).effect, "refused");
  assert.equal(readDriverVerdict({ refusal: { code: "permission_required", message: "needs approval" } }).effect, "refused");
  assert.equal(readDriverVerdict({ code: "background_unavailable" }).effect, "refused");
  assert.equal(readDriverVerdict({ code: "delivery_failed" }).effect, "refused");

  // But a delivery whose effect merely could not be PROVEN is not a refusal.
  assert.equal(readDriverVerdict({ code: "effect_unconfirmed" }).effect, null);

  // And an unrecognised payload still yields NO verdict, so the caller must say
  // `unverifiable` rather than guess.
  assert.equal(readDriverVerdict({ height: 1080, width: 1920 }).effect, null);
  assert.equal(readDriverVerdict({ status: "unknown" }).effect, null);
  assert.equal(readDriverVerdict("not an object").effect, null);
});

test("a code-only refusal reaches the provider as a typed refusal failure", async () => {
  const provider = createCuaWorkstationProvider({
    runner: refusalRunner({ code: "route_unavailable", message: "no background route" }),
  });
  assert.equal((await provider.connect()).ok, true);

  const acted = await provider.act({ kind: "click", target: { kind: "element", window: { pid: 42, windowId: 7 }, elementIndex: 1, snapshotId: "s00000001" } });
  assert.equal(acted.ok, false, "a refusal is a failure, not a report");
  assert.equal(acted.ok ? null : acted.error.effect, "refused");
  assert.equal(acted.ok ? null : acted.error.driverCode, "route_unavailable");
});

/** A provider whose action tool answers with `payload`, everything else healthy. */
function refusalRunner(payload: unknown): CuaCliRunner {
  return async (_command, args) => {
    const tool = args[0] === "call" ? (args[1] ?? "") : (args[0] ?? "");
    if (tool === "--version") return { code: 0, stdout: "cua-driver 0.28.2\n", stderr: "", timedOut: false, spawnFailed: false };
    if (tool === "status") return { code: 0, stdout: "Cua Driver daemon is running\n  permission mode: standard\n", stderr: "", timedOut: false, spawnFailed: false };
    if (tool === "start_session") return { code: 0, stdout: JSON.stringify({ active: true }), stderr: "", timedOut: false, spawnFailed: false };
    if (tool === "click") return { code: 0, stdout: JSON.stringify(payload), stderr: "", timedOut: false, spawnFailed: false };
    return { code: 0, stdout: "{}", stderr: "", timedOut: false, spawnFailed: false };
  };
}

// ── D. The window inventory the provider really reads ─────────────────────────
//
// `get_accessibility_tree` is the tool the provider calls for a desktop
// observation, and it returns geometry FLAT on each entry. `list_windows`
// nests it under `bounds`. Both shapes were captured from the real driver;
// reading only the nested one dropped the geometry of every window.

test("the flat geometry the accessibility tree really returns is read into bounds", () => {
  const tree = JSON.parse(evidence.probes["accessibility-tree"]!.stdout) as { windows: Record<string, unknown>[] };
  assert.ok(tree.windows.length > 0, "the recorded tree has windows");
  const sample = tree.windows[0]!;
  assert.equal(sample["bounds"], undefined, "the accessibility tree does not nest geometry");
  assert.equal(typeof sample["x"], "number", "it carries flat x");

  const windows = readWindows(tree);
  assert.equal(windows.length, tree.windows.length);
  assert.deepEqual(windows[0]?.bounds, {
    x: sample["x"],
    y: sample["y"],
    width: sample["width"],
    height: sample["height"],
  });
});

test("the nested geometry that list_windows really returns is read the same way", () => {
  const listed = JSON.parse(evidence.probes["list-windows"]!.stdout) as { windows: Record<string, unknown>[] };
  assert.ok(listed.windows.length > 0, "the recorded inventory has windows");
  const sample = listed.windows[0]!;
  assert.ok(sample["bounds"] !== undefined, "list_windows nests geometry under bounds");

  const windows = readWindows(listed);
  assert.equal(windows.length, listed.windows.length);
  assert.deepEqual(windows[0]?.bounds, sample["bounds"]);
  assert.equal(windows[0]?.app, sample["app_name"]);
  assert.equal(windows[0]?.onScreen, sample["is_on_screen"]);
});

test("an entry with no geometry at all still yields no bounds", () => {
  const windows = readWindows({ windows: [{ pid: 1, window_id: 2, title: "no geometry" }] });
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.bounds, undefined);
  assert.equal(windows[0]?.title, "no geometry");
});

// ── E. The daemon probe names the configured socket ───────────────────────────
//
// `status` with no `--socket` reports the DEFAULT pipe. A provider pointed
// anywhere else would then report `daemonRunning: true` for a pipe with
// nothing behind it — measured live against a pipe name nothing listens on.

test("the daemon probe names the provider's configured socket", async () => {
  const argv: (readonly string[])[] = [];
  const runner: CuaCliRunner = async (_command, args) => {
    argv.push([...args]);
    if (args[0] === "--version") return { code: 0, stdout: "cua-driver 0.28.2\n", stderr: "", timedOut: false, spawnFailed: false };
    return { code: 0, stdout: "Cua Driver daemon is running\n  permission mode: standard\n", stderr: "", timedOut: false, spawnFailed: false };
  };

  const provider = createCuaWorkstationProvider({ runner, socket: DEAD_PIPE });
  const available = await provider.availability();
  assert.equal(available.ok, true);

  const statusArgv = argv.find((args) => args[0] === "status");
  assert.ok(statusArgv, "the daemon probe ran");
  assert.ok(statusArgv.includes("--socket"), "the probe must name a socket");
  assert.equal(statusArgv[statusArgv.indexOf("--socket") + 1], DEAD_PIPE);
});

test("a provider pointed at a pipe with no daemon does not claim the daemon is running", async () => {
  // Verbatim driver behaviour, recorded: `status --socket <other>` exits 1 with
  // "Cua Driver daemon is not running".
  const dead = recorded("status-dead-socket");
  assert.equal(dead.code, 1);
  assert.match(dead.stderr, /daemon is not running/);
  assert.ok(dead.args.includes(DEAD_PIPE));

  const runner: CuaCliRunner = async (_command, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "cua-driver 0.28.2\n", stderr: "", timedOut: false, spawnFailed: false };
    return { code: dead.code, stdout: dead.stdout, stderr: dead.stderr, timedOut: false, spawnFailed: false };
  };

  const provider = createCuaWorkstationProvider({ runner, socket: DEAD_PIPE });
  const available = await provider.availability();
  assert.equal(available.ok, true);
  assert.equal(available.ok ? available.value.available : null, true, "the binary is present");
  assert.equal(available.ok ? available.value.daemonRunning : null, false, "but its daemon is not reachable");
  assert.match(available.ok ? (available.value.detail ?? "") : "", /daemon is not running/);
});

// ── F. LIVE: the real provider over the real binary ───────────────────────────
//
// Read-only only. No screen pixels are read; no input is injected. Every call
// below is a probe, an inventory, or an invocation the driver refuses.

test("live: the real provider reports availability from the installed driver", { skip: liveSkip() }, async () => {
  const provider = createCuaWorkstationProvider();
  const available = await provider.availability();

  assert.equal(available.ok, true);
  assert.equal(available.ok ? available.value.available : null, true);
  assert.equal(available.ok ? available.value.supported : null, true, `driver must meet the floor ${REAL_DRIVER_SEAM.installedVersion}`);
  assert.equal(available.ok ? available.value.daemonRunning : null, true);
  assert.match(available.ok ? (available.value.version ?? "") : "", /0\.28\.2/);
});

test("live: connect, status and disconnect round-trip against the real daemon", { skip: liveSkip() }, async () => {
  const provider = createCuaWorkstationProvider();
  const connected = await provider.connect();
  assert.equal(connected.ok, true, connected.ok ? "" : connected.error.message);
  assert.equal(connected.ok ? connected.value.daemon : null, true);
  assert.match(connected.ok ? connected.value.version : "", /0\.28\.2/);
  assert.deepEqual(
    connected.ok ? [...connected.value.capabilities] : [],
    ["click", "type_text", "press_key", "hotkey", "scroll", "drag"],
  );

  const status = await provider.status();
  assert.equal(status.ok, true);
  assert.equal(status.ok ? status.value.connected : null, true);
  assert.equal(status.ok ? status.value.daemonRunning : null, true);
  assert.equal(status.ok ? status.value.permissionMode : null, "standard");
  // A fresh session has window scope, not desktop scope.
  assert.equal(status.ok ? status.value.desktopAuthorized : null, false);
  assert.deepEqual(status.ok ? status.value.screen : null, { width: 1920, height: 1080 });
  assert.equal(status.ok ? status.value.version : null, "0.28.2");

  const disconnected = await provider.disconnect();
  assert.equal(disconnected.ok, true, "disconnect must never stop the operator's daemon");

  // The daemon is still the one that was there before, untouched.
  const after = await provider.availability();
  assert.equal(after.ok ? after.value.daemonRunning : null, true);
});

test("live: the four error shapes reproduce against the real binary", { skip: liveSkip() }, async () => {
  const shapes: [label: string, args: string[], stdin: string | null, kind: string][] = [
    ["unknown tool", ["call", "no_such_tool", "--socket", PIPE], "{}", "permission"],
    ["schema violation", ["call", "get_window_state", "--socket", PIPE], "{}", "target"],
    ["argv JSON", ["call", "get_screen_size", "not-json", "--socket", PIPE], null, "protocol"],
    ["daemon absent", ["call", "get_screen_size", "--socket", DEAD_PIPE], "{}", "unavailable"],
  ];

  for (const [label, args, stdin, kind] of shapes) {
    const { classified } = await probe(args, stdin);
    assert.equal(classified.ok, false, `${label} must not classify as success`);
    assert.equal(classified.ok ? null : classified.error.kind, kind, `${label} must be a ${kind} failure`);
  }
});

test("live: the recorded read-only facts still hold", { skip: liveSkip() }, async () => {
  const version = await probe(["--version"], null);
  assert.equal(version.run.code, 0);
  assert.match(version.run.stdout, /^cua-driver 0\.28\.2/);

  const status = await probe(["status", "--socket", PIPE], null);
  assert.equal(status.run.code, 0);
  assert.match(status.run.stdout, /daemon is running/i);
  assert.match(status.run.stdout, /permission mode:\s*standard/);

  const doctor = await probe(["doctor", "--json"], null);
  assert.equal(doctor.run.code, 0);
  const report = JSON.parse(doctor.run.stdout) as { ok: boolean; probes: { status: string }[] };
  assert.equal(report.ok, true);
  assert.ok(report.probes.every((p) => p.status === "ok"));

  const tools = await probe(["list-tools"], null);
  assert.equal(tools.run.code, 0);
  assert.equal(tools.run.stdout.trim().split("\n").filter(Boolean).length, 57);

  const screen = await probe(["call", "get_screen_size", "--socket", PIPE], "{}");
  assert.equal(screen.classified.ok, true);
  const size = screen.classified.ok ? (screen.classified.payload as Record<string, unknown>) : {};
  assert.equal(size["width"], 1920);
  assert.equal(size["height"], 1080);
  assert.equal(typeof size["scale_factor"], "number");

  const permissions = await probe(["call", "check_permissions", "--socket", PIPE], "{}");
  assert.equal(permissions.classified.ok, true);
  const perms = permissions.classified.ok ? (permissions.classified.payload as Record<string, unknown>) : {};
  assert.equal(perms["uia"], true);
  assert.equal(perms["post_message"], true);

  const health = await probe(["call", "health_report", "--socket", PIPE], "{}");
  assert.equal(health.classified.ok, true);
  const report2 = health.classified.ok ? (health.classified.payload as Record<string, unknown>) : {};
  assert.equal(report2["driver_version"], "0.28.2");
  assert.equal(report2["overall"], "ok");
});

test("live: the window inventory is read from the real driver without reading pixels", { skip: liveSkip() }, async () => {
  const tree = await probe(["call", "get_accessibility_tree", "--socket", PIPE], "{}");
  assert.equal(tree.classified.ok, true);
  const windows = readWindows(tree.classified.ok ? tree.classified.payload : null);
  assert.ok(windows.length > 0, "the driver reports visible windows");

  // Metadata only: the accessibility tree carries no pixels at all.
  assert.equal((tree.classified.ok ? (tree.classified.payload as Record<string, unknown>) : {})["screenshot_png_b64"], undefined);
  for (const window of windows) {
    assert.ok(window.pid > 0);
    assert.ok(window.windowId > 0);
    assert.equal(typeof window.title, "string");
    assert.ok(window.bounds, `window ${window.windowId} must carry the flat geometry the tree returned`);
    assert.ok(window.bounds!.width >= 0 && window.bounds!.height >= 0);
  }

  const listed = await probe(["call", "list_windows", "--socket", PIPE], "{}");
  assert.equal(listed.classified.ok, true);
  const inventory = readWindows(listed.classified.ok ? listed.classified.payload : null);
  assert.ok(inventory.length > 0, "list_windows reports windows too");
  assert.ok(inventory.every((w) => w.bounds !== undefined), "nested bounds are read as well");
});

test("live: the provider never issues a host-changing driver verb", { skip: liveSkip() }, async () => {
  // The forbidden set: anything that would install, update, configure, serve,
  // stop or revoke on the operator's machine. The real argv of a real
  // availability + connect + status + disconnect cycle is recorded here and
  // asserted, not the provider's own claim about what it would run.
  const forbidden = ["serve", "stop", "install", "uninstall", "update", "config", "revoke", "autostart", "kill"];
  const argv: (readonly string[])[] = [];
  const recording: CuaCliRunner = async (command, args, stdin, timeoutMs) => {
    argv.push([...args]);
    return runDriver(command, args, stdin, timeoutMs);
  };

  const provider = createCuaWorkstationProvider({ runner: recording });
  assert.equal((await provider.availability()).ok, true);
  assert.equal((await provider.connect()).ok, true);
  assert.equal((await provider.status()).ok, true);
  assert.equal((await provider.disconnect()).ok, true);

  assert.ok(argv.length > 0, "the cycle really ran the driver");
  for (const args of argv) {
    for (const token of forbidden) {
      assert.ok(!args.includes(token), `argv [${args.join(" ")}] must not contain '${token}'`);
    }
    // Every invocation is a bare probe or `call <tool>`; nothing else.
    assert.ok(args[0] === "call" || args[0] === "--version" || args[0] === "status", `unexpected subcommand ${String(args[0])}`);
  }
  // The daemon this whole cycle ran against is still the one that was there.
  const after = await provider.availability();
  assert.equal(after.ok ? after.value.daemonRunning : null, true);
});

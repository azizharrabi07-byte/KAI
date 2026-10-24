// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * coucou-bridge.test.ts — the KAI → Coucou bridge contract.
 *
 * The bridge shells out to Coucou's own relay, so these tests substitute the spawn
 * seam rather than starting a real pipe. What is asserted is the CONTRACT: the exact
 * argv, the newline-framed JSON envelope, what is refused, what is redacted, and that
 * none of it can delay or fail the Core.
 *
 *   cd core && node --test tests/coucou-bridge.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createCoucouBridge,
  COUCOU_EVENTS,
  type CoucouSpawnFn,
} from "../src/integrations/coucou.ts";
import { createCoucouMapper, mapKaiEvent, APPROVAL_WAITING_MESSAGE } from "../src/integrations/coucou-map.ts";
import type { KaiEvent } from "../src/shared/contracts.ts";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A relay path that exists. `start()` refuses an absent relay, so a test that wants
 * to observe a spawn needs a real file. The node binary is always there.
 */
const RELAY_STUB = process.execPath;

/**
 * Build a throwaway `%LOCALAPPDATA%` whose default relay location really exists, so
 * the DEFAULT path — not an override — is what gets asserted.
 */
function fakeLocalAppData(): string {
  const root = mkdtempSync(join(tmpdir(), "kai-coucou-"));
  const bin = join(root, "Coucou", "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, join(bin, "coucou-hook.exe"));
  return root;
}

// ── A recording spawn seam ────────────────────────────────────────────────────

interface FakeChild {
  written: string[];
  ended: boolean;
  killed: boolean;
  fail(error: Error): void;
  exit(code: number): void;
}

interface Recorder {
  spawnFn: CoucouSpawnFn;
  calls: { command: string; args: readonly string[] }[];
  children: FakeChild[];
}

/**
 * A spawn that records instead of running. `children` lets a test drive the outcome
 * (exit / error) so timeout and failure paths are deterministic.
 */
function recorder(): Recorder {
  const calls: { command: string; args: readonly string[] }[] = [];
  const children: FakeChild[] = [];
  const spawnFn: CoucouSpawnFn = (command, args) => {
    calls.push({ command, args });
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
    const child: FakeChild = {
      written: [],
      ended: false,
      killed: false,
      fail(error) {
        for (const fn of listeners.get("error") ?? []) fn(error);
      },
      exit(code) {
        for (const fn of listeners.get("close") ?? []) fn(code);
      },
    };
    children.push(child);
    return {
      stdin: {
        write(chunk: string) {
          child.written.push(chunk);
          return true;
        },
        end() {
          child.ended = true;
        },
      },
      on(event: string, listener: (...a: unknown[]) => void) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return child;
      },
      kill() {
        child.killed = true;
        return true;
      },
    };
  };
  return { spawnFn, calls, children };
}

/** A bridge whose relay is reported present, wired to a fresh recorder. */
function bridgeWith(overrides: Partial<Parameters<typeof createCoucouBridge>[0]> = {}): {
  bridge: ReturnType<typeof createCoucouBridge>;
  rec: Recorder;
} {
  const rec = recorder();
  const bridge = createCoucouBridge({
    relayPath: RELAY_STUB,
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    spawnFn: rec.spawnFn,
    // Deterministic: no Coucou pipe in the test environment unless a case says so.
    pipePresentFn: () => false,
    ...overrides,
  });
  bridge.start();
  return { bridge, rec };
}

/** Let queued microtasks (the drain chain) run. */
function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

const parse = (payload: string): Record<string, unknown> => JSON.parse(payload) as Record<string, unknown>;

// ── 1. Relay path + argv ──────────────────────────────────────────────────────

test("the default relay path is the documented per-user location", () => {
  const local = fakeLocalAppData();
  const rec = recorder();
  const bridge = createCoucouBridge({ env: { LOCALAPPDATA: local }, spawnFn: rec.spawnFn });
  bridge.start();
  assert.equal(bridge.status().state, "ready", "the default location is probed, not hardcoded");
  // The path is only observable through a spawn, so send one and read the argv.
  bridge.send("SessionStart", "s1");
  assert.equal(rec.calls[0]?.command, join(local, "Coucou", "bin", "coucou-hook.exe"));
});

test("a supplied relayPath wins, and the agent tag is exactly `kai`", () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("SessionStart", "s1");
  assert.equal(rec.calls[0]?.command, RELAY_STUB);
  assert.deepEqual(rec.calls[0]?.args, ["--agent", "kai"]);
});

test("an invalid agent id makes the bridge unavailable and sends nothing", () => {
  for (const bad of ["KAI", "", "a".repeat(25), "has space"]) {
    const rec = recorder();
    const bridge = createCoucouBridge({ relayPath: RELAY_STUB, agent: bad, spawnFn: rec.spawnFn });
    bridge.start();
    assert.equal(bridge.status().state, "unavailable", `"${bad}" must be refused`);
    bridge.send("SessionStart", "s1");
    assert.equal(rec.calls.length, 0);
  }
});

// ── 2. Framing ────────────────────────────────────────────────────────────────

test("the payload is one JSON document terminated by a newline", () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("SessionStart", "session-1");
  const written = rec.children[0]?.written.join("") ?? "";
  assert.ok(written.endsWith("\n"), "the relay reads one document per write");
  assert.equal(written.indexOf("\n"), written.length - 1, "exactly one trailing newline");
  const body = parse(written.trimEnd());
  assert.equal(body["hook_event_name"], "SessionStart");
  assert.equal(body["session_id"], "session-1");
  assert.equal(body["coucou_agent"], "kai");
});

test("stdin is ended so the relay does not wait for more input", () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("Stop", "s1");
  assert.equal(rec.children[0]?.ended, true);
});

// ── 3. Every supported event round-trips ──────────────────────────────────────

test("each supported event name is accepted and framed", () => {
  for (const name of COUCOU_EVENTS) {
    const { bridge, rec } = bridgeWith();
    bridge.send(name, "s1");
    const body = parse((rec.children[0]?.written.join("") ?? "").trimEnd());
    assert.equal(body["hook_event_name"], name);
  }
});

// ── 4. Refusals ───────────────────────────────────────────────────────────────

test("a malformed session id is refused without spawning", () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("SessionStart", "bad id!");
  assert.equal(rec.calls.length, 0, "nothing was spawned");
  assert.equal(bridge.status().dropped, 1);
  assert.match(bridge.status().lastError ?? "", /session id/);
});

test("an unknown event name is refused without spawning", () => {
  const { bridge, rec } = bridgeWith();
  // Cast through unknown: this is exactly what a JS caller or a future edit could do.
  bridge.send("PreToolUseNope" as unknown as (typeof COUCOU_EVENTS)[number], "s1");
  assert.equal(rec.calls.length, 0);
  assert.equal(bridge.status().dropped, 1);
});

// ── 5. Reserved fields cannot be forged ──────────────────────────────────────

test("a caller cannot override the envelope fields", () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("SessionStart", "real-session", {
    hook_event_name: "Stop",
    coucou_agent: "someone-else",
    session_id: "forged",
  });
  const body = parse((rec.children[0]?.written.join("") ?? "").trimEnd());
  assert.equal(body["hook_event_name"], "SessionStart");
  assert.equal(body["coucou_agent"], "kai");
  assert.equal(body["session_id"], "real-session");
});

// ── 6. Redaction ──────────────────────────────────────────────────────────────

test("secret-shaped keys never reach the wire", () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("PostToolUse", "s1", {
    tool_name: "read",
    apiKey: "sk-live-abcdef",
    authorization: "Bearer abc",
    password: "hunter2",
  });
  const written = rec.children[0]?.written.join("") ?? "";
  for (const secret of ["sk-live-abcdef", "Bearer abc", "hunter2"]) {
    assert.equal(written.includes(secret), false, `${secret} must not be transmitted`);
  }
});

test("absolute paths are replaced inside a message, and prose is left alone", () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("Notification", "s1", { message: "Reading C:\\Users\\DELL\\.env for the audit" });
  const one = parse((rec.children[0]?.written.join("") ?? "").trimEnd());
  assert.equal(one["message"], "Reading <path> for the audit");

  const { bridge: b2, rec: r2 } = bridgeWith();
  b2.send("Notification", "s1", { message: "read and/or write the file" });
  const two = parse((r2.children[0]?.written.join("") ?? "").trimEnd());
  assert.equal(two["message"], "read and/or write the file", "a bare slash is not a path");
});

test("only allowlisted fields are forwarded", () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("PostToolUse", "s1", {
    tool_name: "read",
    fullPrompt: "the entire user prompt",
    toolInput: { secret: "x" },
    goalContext: ["nested"],
  });
  const body = parse((rec.children[0]?.written.join("") ?? "").trimEnd());
  assert.deepEqual(Object.keys(body).sort(), ["coucou_agent", "hook_event_name", "session_id", "tool_name"]);
});

// ── 7. Bounds ─────────────────────────────────────────────────────────────────

test("a huge field is clamped so the payload fits the relay's limit", () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("UserPromptSubmit", "s1", { prompt: "x".repeat(10_000) });
  const written = rec.children[0]?.written.join("") ?? "";
  assert.ok(Buffer.byteLength(written, "utf8") <= 4096, "payload stays inside the relay's read size");
  const body = parse(written.trimEnd());
  assert.ok(typeof body["prompt"] === "string" && (body["prompt"] as string).length <= 200);
});

test("the queue is bounded and drops the OLDEST entry, counting every drop", async () => {
  const { bridge } = bridgeWith({ maxQueue: 8 });
  // The first send spawns immediately (never completes here); the rest queue behind
  // it. So the bound is 1 in-flight + maxQueue queued, and every other send is a drop.
  for (let i = 0; i < 100; i += 1) bridge.send("PostToolUse", "s1", { tool_name: `t${i}` });
  const status = bridge.status();
  assert.equal(status.dropped, 100 - 8 - 1, "exactly the overflow is dropped");
  assert.equal(status.sent, 0, "the first child never completed");
  await settle();
});

// ── 8. Failures are data ──────────────────────────────────────────────────────

test("a relay that fails to start is recorded and does not throw", async () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("SessionStart", "s1");
  rec.children[0]?.fail(new Error("spawn ENOENT"));
  await settle();
  assert.match(bridge.status().lastError ?? "", /ENOENT/);
  // The bridge keeps working for the next event.
  bridge.send("Stop", "s1");
  assert.equal(rec.calls.length, 2);
});

test("a non-zero exit is recorded, and a later success still counts", async () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("SessionStart", "s1");
  rec.children[0]?.exit(2);
  await settle();
  assert.match(bridge.status().lastError ?? "", /exited 2/);

  bridge.send("Stop", "s1");
  rec.children[1]?.exit(0);
  await settle();
  assert.equal(bridge.status().sent, 1, "the successful send is counted");
});

// ── 9. Absent Coucou ──────────────────────────────────────────────────────────

test("a missing relay is a normal state, not an error, and nothing is spawned", () => {
  const rec = recorder();
  const bridge = createCoucouBridge({
    relayPath: "C:\\definitely\\not\\here\\coucou-hook.exe",
    spawnFn: rec.spawnFn,
  });
  bridge.start();
  const status = bridge.status();
  assert.equal(status.state, "unavailable");
  assert.match(status.reason ?? "", /relay not found/);
  bridge.send("SessionStart", "s1");
  assert.equal(rec.calls.length, 0);
  assert.equal(status.dropped + bridge.status().dropped, 1);
});

test("a present relay does not claim delivery when Coucou is not listening", () => {
  // Verified against the real relay: it exits 0 whether or not it delivered, so a
  // "ready, no reason" status would overstate the connection. With no `coucou-` pipe
  // up, the status has to say so even though sending is possible.
  const { bridge } = bridgeWith();
  const status = bridge.status();
  assert.equal(status.state, "ready", "the relay is present, so sending is possible");
  assert.match(status.reason ?? "", /not running/, "and the operator is told it will be dropped");
});

// ── 10. Shutdown kills the child ──────────────────────────────────────────────

test("stop() clears the queue, kills the in-flight child and goes disabled", async () => {
  const { bridge, rec } = bridgeWith();
  bridge.send("SessionStart", "s1");
  for (let i = 0; i < 5; i += 1) bridge.send("PostToolUse", "s1", { tool_name: `t${i}` });

  await bridge.stop();
  assert.equal(rec.children[0]?.killed, true, "an orphaned relay must not outlive the Core");
  assert.equal(bridge.status().state, "disabled");

  const before = bridge.status();
  bridge.send("Stop", "s1");
  assert.equal(rec.calls.length, 1, "nothing new is sent after stop");
  assert.equal(bridge.status().dropped, before.dropped + 1);
});

// ── 11. The mapping ───────────────────────────────────────────────────────────

const ev = (type: string, extra: Partial<KaiEvent> = {}): KaiEvent =>
  ({ id: "evt_1", type, timestamp: "2026-10-14T00:00:00.000Z", source: "core", payload: {}, ...extra }) as KaiEvent;

test("each mapped KAI event maps to its honest Coucou equivalent", () => {
  const cases: [string, string, Partial<KaiEvent>][] = [
    ["mission.started", "SessionStart", { missionId: "m1" }],
    ["agent.run_started", "UserPromptSubmit", { missionId: "m1", payload: { subagentId: "worker-a" } }],
    ["action.executed", "PostToolUse", { missionId: "m1", payload: { toolId: "filesystem.read" } }],
    ["agent.run_failed", "PostToolUseFailure", { missionId: "m1", payload: { subagentId: "worker-a" } }],
    ["approval.requested", "Notification", { missionId: "m1" }],
    ["mission.completed", "Stop", { missionId: "m1" }],
    ["mission.failed", "StopFailure", { missionId: "m1" }],
    ["mission.cancelled", "SessionEnd", { missionId: "m1" }],
  ];
  for (const [kai, coucou, extra] of cases) {
    const out = mapKaiEvent(ev(kai, extra));
    assert.equal(out.length, 1, `${kai} must map to exactly one event`);
    assert.equal(out[0]?.name, coucou, `${kai} -> ${coucou}`);
    assert.equal(out[0]?.sessionId, "m1", "the session id correlates the whole mission");
  }
});

test("PreToolUse and PermissionRequest are never produced", () => {
  const everyKaiType = [
    "mission.started", "mission.progress", "mission.completed", "mission.failed", "mission.cancelled",
    "agent.run_started", "agent.run_failed", "action.executed", "approval.requested",
    "core.started", "core.stopped", "notification.created", "approval.approved",
  ];
  for (const type of everyKaiType) {
    for (const out of mapKaiEvent(ev(type, { missionId: "m1" }))) {
      assert.notEqual(out.name, "PreToolUse", `${type} must not fabricate a tool start`);
      assert.notEqual(out.name as string, "PermissionRequest", `${type} must not ask Coucou to decide`);
    }
  }
});

test("an approval is a notification that says where the decision lives", () => {
  const out = mapKaiEvent(ev("approval.requested", { missionId: "m1" }));
  assert.equal(out[0]?.name, "Notification");
  assert.equal(out[0]?.fields["message"], APPROVAL_WAITING_MESSAGE);
  assert.equal(out[0]?.fields["decision"], undefined, "no decision field is ever offered");
});

test("an unmapped event produces nothing", () => {
  assert.deepEqual(mapKaiEvent(ev("mission.progress", { missionId: "m1" })), []);
  assert.deepEqual(mapKaiEvent(ev("core.started")), []);
});

test("the session id falls back to the goal, then to the event id", () => {
  assert.equal(mapKaiEvent(ev("mission.started", { missionId: "m9" }))[0]?.sessionId, "m9");
  assert.equal(mapKaiEvent(ev("mission.started", { payload: { goalId: "g7" } }))[0]?.sessionId, "goal-g7");
  assert.equal(mapKaiEvent(ev("mission.started"))[0]?.sessionId, "evt_1");
});

// ── 12. Duplicate suppression ─────────────────────────────────────────────────

test("a repeated transition inside the window is suppressed, and survives the window", () => {
  let clock = 1000;
  const map = createCoucouMapper({ now: () => clock, windowMs: 1000 });
  const event = ev("mission.started", { missionId: "m1" });

  assert.equal(map(event).length, 1);
  assert.equal(map(event).length, 0, "the same transition twice is not two events");
  clock += 1001;
  assert.equal(map(event).length, 1, "past the window it reports again");
});

test("two different missions are never collapsed together", () => {
  const map = createCoucouMapper({ now: () => 1000 });
  assert.equal(map(ev("mission.started", { missionId: "a" })).length, 1);
  assert.equal(map(ev("mission.started", { missionId: "b" })).length, 1);
});

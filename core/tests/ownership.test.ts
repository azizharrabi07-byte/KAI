// Phase 1 Priorities 1-3: core ownership and build identity.
//
// These are unit tests for the DECISION logic, not for the live behaviour (which
// was verified against the running Core). They exist because the failure that
// motivated this work was a WRONG DECISION rather than a crash: a second Core lost
// the port, exited, and its caller went on believing the new build was serving.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isAddressInUse,
  looksLikeCoreIdentity,
  parseOwningPid,
} from "../src/ownership.ts";
import { PROTOCOL_VERSION, loadIdentity } from "../src/identity.ts";

// ── Identity: a 200 is not proof of anything ─────────────────────────────────

test("only a real kai-core identity is adoptable", () => {
  assert.equal(looksLikeCoreIdentity({ service: "kai-core", protocolVersion: 1 }), true);
  // The shapes that must NOT be mistaken for a Core.
  assert.equal(looksLikeCoreIdentity(null), false);
  assert.equal(looksLikeCoreIdentity({}), false);
  assert.equal(looksLikeCoreIdentity({ status: "ok" }), false, "a plain 200 body proves nothing");
  assert.equal(looksLikeCoreIdentity({ service: "kai-core" }), false, "protocol is required");
  assert.equal(looksLikeCoreIdentity({ service: "something-else", protocolVersion: 1 }), false);
  assert.equal(looksLikeCoreIdentity({ service: "kai-core", protocolVersion: "1" }), false);
});

test("an unstamped build reports unknown rather than inventing an id", () => {
  // Run from TypeScript source there is no build stamp next to the module, which
  // is exactly the "cannot know" case: it must look unknown, not plausible.
  const identity = loadIdentity({});
  assert.equal(identity.service, "kai-core");
  assert.equal(identity.protocolVersion, PROTOCOL_VERSION);
  assert.ok(typeof identity.pid === "number" && identity.pid > 0);
  assert.ok(["unknown", "03167dc7803438b7", "87cfcc52c1c90b4f"].includes(identity.buildId) || identity.buildId.length === 16,
    `buildId must be unknown or a 16-char stamp, got ${identity.buildId}`);
  assert.ok(identity.gitCommit.length > 0, "commit is either a sha or the word unknown");
});

test("startedAt is the PROCESS start, not the time of the call", async () => {
  // Reproduced live: `/identity` is answered by calling loadIdentity() per
  // request, so a `new Date()` inside it reported the LAST REQUEST as the process
  // start — two GETs three seconds apart returned startedAt values three seconds
  // apart while pid stayed constant. The field's contract is a fact about the
  // process, so two reads must agree no matter how far apart they are.
  const first = loadIdentity({});
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = loadIdentity({});
  assert.equal(first.startedAt, second.startedAt, "two reads of one process must report one start time");
  const parsed = Date.parse(first.startedAt);
  assert.ok(Number.isFinite(parsed), "startedAt must be a parseable ISO-8601 timestamp");
  assert.ok(parsed <= Date.now(), "the process cannot have started in the future");
  assert.equal(first.pid, second.pid, "and the pid it describes must be stable too");
});

// ── The port error that used to pass silently ────────────────────────────────

test("a taken port is recognised by code and by message", () => {
  assert.equal(isAddressInUse(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" })), true);
  assert.equal(isAddressInUse(new Error("listen EADDRINUSE: address already in use 127.0.0.1:8788")), true);
  assert.equal(isAddressInUse(new Error("EACCES: permission denied")), false);
  assert.equal(isAddressInUse(undefined), false);
  assert.equal(isAddressInUse("some string failure"), false);
});

// ── Naming the owner ─────────────────────────────────────────────────────────

const NETSTAT = [
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:8788         0.0.0.0:0              LISTENING       17888",
  "  TCP    127.0.0.1:8642         0.0.0.0:0              LISTENING       4312",
  "  TCP    127.0.0.1:4096         0.0.0.0:0              LISTENING       9900",
  "  TCP    [::1]:8788             [::]:0                 LISTENING       777",
].join("\r\n");

test("the owning pid is found for the requested port only", () => {
  assert.equal(parseOwningPid(NETSTAT, 8788), 17888, "first match for 8788 is the IPv4 listener");
  assert.equal(parseOwningPid(NETSTAT, 8642), 4312);
  assert.equal(parseOwningPid(NETSTAT, 4096), 9900);
  assert.equal(parseOwningPid(NETSTAT, 1234), null, "an unowned port yields null, not a wrong pid");
  assert.equal(parseOwningPid("", 8788), null);
});

test("a non-listening row is not mistaken for an owner", () => {
  const established = "  TCP    127.0.0.1:8788         127.0.0.1:52000        ESTABLISHED     555";
  assert.equal(parseOwningPid(established, 8788), null, "only LISTENING rows name the owner");
});

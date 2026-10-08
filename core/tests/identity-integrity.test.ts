// Source != artifact must be IMPOSSIBLE TO HIDE.
//
// These tests pin the two halves of identity honesty:
//
//   1. `deriveIdentity` — the pure stale-detection rules. A stamp rewritten after
//      launch, or an artifact built from different source, MUST come out "stale"
//      and MUST make the boot self-check refuse. This is driven directly, without
//      a second process, so the exact regressions are exhaustive and cheap.
//   2. `computeSourceBuildId` — the ONE source hash. It is deterministic, changes
//      when the source changes, and is not a timestamp.
//
// A live end-to-end proof (source == artifact == running pid) is separate, in the
// launch evidence; these guard the decision logic that proof relies on.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROTOCOL_VERSION,
  deriveIdentity,
  identitySelfCheck,
  loadIdentity,
  type StampSnapshot,
} from "../src/identity.ts";
import { computeSourceBuildId } from "../src/source-hash.ts";

const META = { pid: 4242, startedAt: new Date(0).toISOString() };

function snapshot(over: Partial<StampSnapshot>): StampSnapshot {
  return {
    loadedBuildId: "aaaaaaaaaaaaaaaa",
    loadedGitCommit: "0".repeat(40),
    loadedCoreVersion: "0.1.0",
    loadedProtocolVersion: PROTOCOL_VERSION,
    identitySource: "C:/core/dist/build-info.json",
    onDiskBuildId: "aaaaaaaaaaaaaaaa",
    sourceBuildId: "aaaaaaaaaaaaaaaa",
    sourceCheckReason: null,
    ...over,
  };
}

// ── The stamp on disk drifting from what the process loaded ──────────────────

test("a stamp rewritten after launch is STALE, never silently fresh", () => {
  // The observed bug: a Core started before a rebuild reported the NEW build id.
  const identity = deriveIdentity(
    snapshot({
      loadedBuildId: "1111111111111111",
      onDiskBuildId: "2222222222222222",
      sourceBuildId: "1111111111111111",
    }),
    META,
  );
  assert.equal(identity.buildId, "1111111111111111", "the REPORTED id is what the process loaded, not the file");
  assert.equal(identity.onDiskBuildId, "2222222222222222", "the drifted on-disk id is a SEPARATE field");
  assert.equal(identity.identityMatchesDisk, false);
  assert.equal(identity.freshness, "stale");

  const check = identitySelfCheck(identity);
  assert.equal(check.ok, false);
  assert.equal(check.code, 5);
  assert.match(check.detail, /stamp on disk changed after this process started/);
});

// ── The artifact built from different source ─────────────────────────────────

test("an artifact built from DIFFERENT source is STALE and refuses to boot", () => {
  const identity = deriveIdentity(
    snapshot({ loadedBuildId: "1111111111111111", onDiskBuildId: "1111111111111111", sourceBuildId: "9999999999999999" }),
    META,
  );
  assert.equal(identity.artifactMatchesSource, false);
  assert.equal(identity.sourceBuildId, "9999999999999999");
  assert.equal(identity.freshness, "stale");

  const check = identitySelfCheck(identity);
  assert.equal(check.ok, false);
  assert.equal(check.code, 5);
  assert.match(check.detail, /built from DIFFERENT source than core\/src/);
});

// ── The honest success cases ─────────────────────────────────────────────────

test("matching source, matching disk -> FRESH", () => {
  const identity = deriveIdentity(snapshot({}), META);
  assert.equal(identity.identityMatchesDisk, true);
  assert.equal(identity.artifactMatchesSource, true);
  assert.equal(identity.freshness, "fresh");
  assert.equal(identitySelfCheck(identity).ok, true);
  assert.equal(identitySelfCheck(identity).code, 0);
});

test("a shipped bundle with no source beside it is FRESH but source-UNVERIFIABLE", () => {
  // The installed app ships compiled output only: core/src genuinely is not
  // present, so source equality cannot be recomputed. It must SAY so, not fake it.
  const identity = deriveIdentity(
    snapshot({ sourceBuildId: null, sourceCheckReason: "no core/src beside the running artifact" }),
    META,
  );
  assert.equal(identity.artifactMatchesSource, null, "not comparable is null, never a false claim");
  assert.equal(identity.freshness, "fresh");
  const check = identitySelfCheck(identity);
  assert.equal(check.ok, true);
  assert.match(check.detail, /source equality cannot be recomputed|no core\/src/);
});

test("no stamp at all -> UNVERIFIED, allowed but never called fresh", () => {
  const identity = deriveIdentity(
    snapshot({
      loadedBuildId: "unknown",
      identitySource: null,
      onDiskBuildId: null,
      sourceBuildId: "3333333333333333",
      sourceCheckReason: null,
    }),
    META,
  );
  assert.equal(identity.artifactMatchesSource, null);
  assert.equal(identity.freshness, "unverified");
  assert.equal(identitySelfCheck(identity).ok, true);
});

test("a missing source does not fabricate a match", () => {
  const identity = deriveIdentity(snapshot({ sourceBuildId: null, sourceCheckReason: "no core/src" }), META);
  assert.notEqual(identity.artifactMatchesSource, true);
});

// ── The live process wrapper is frozen ───────────────────────────────────────

test("loadIdentity reports the loaded identity from memory, stable across calls", async () => {
  const first = loadIdentity({});
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = loadIdentity({});

  assert.equal(first.buildId, second.buildId, "the loaded build id must not change between reads");
  assert.equal(first.gitCommit, second.gitCommit);
  assert.equal(first.startedAt, second.startedAt, "startedAt is the process start, not the call time");
  assert.equal(first.pid, second.pid);
  assert.equal(first.onDiskBuildId, second.onDiskBuildId);
  assert.equal(first.identityMatchesDisk, second.identityMatchesDisk);

  assert.ok(["fresh", "stale", "unverified"].includes(first.freshness), `unexpected freshness ${first.freshness}`);
  // Running from TypeScript source the stamp it found (if any) is a compiled
  // artifact's; the path must name a real build-info.json, or be null.
  assert.ok(
    first.identitySource === null || first.identitySource.endsWith("build-info.json"),
    `identitySource must name a stamp file or be null, got ${String(first.identitySource)}`,
  );
  assert.ok(
    first.sourceBuildId === null || /^[0-9a-f]{16}$/.test(first.sourceBuildId),
    `sourceBuildId must be a 16-hex hash or null, got ${String(first.sourceBuildId)}`,
  );
  assert.equal(first.service, "kai-core");
  assert.equal(first.protocolVersion, PROTOCOL_VERSION);
});

test("a fresh process self-check never claims source honesty it cannot prove", () => {
  const identity = loadIdentity({});
  const check = identitySelfCheck(identity);
  assert.equal(check.ok, identity.freshness !== "stale");
  assert.equal(check.ok, check.code === 0);
  assert.ok(check.detail.length > 0);
});

// ── The ONE source hash ──────────────────────────────────────────────────────

function tempCore(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kai-srchash-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), source, "utf8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@kai/core", version: "0.1.0" }), "utf8");
  writeFileSync(join(dir, "tsconfig.json"), "{}", "utf8");
  return dir;
}

test("the source hash is deterministic and changes only when the source changes", () => {
  const dir = tempCore("export const a = 1;\n");
  const first = computeSourceBuildId(dir);
  assert.equal(first, computeSourceBuildId(dir), "same source -> same id (not a timestamp)");
  assert.match(first, /^[0-9a-f]{16}$/);

  writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n", "utf8");
  const second = computeSourceBuildId(dir);
  assert.notEqual(second, first, "any source edit -> a different id");

  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  assert.equal(computeSourceBuildId(dir), first, "reverting the edit restores the id");
});

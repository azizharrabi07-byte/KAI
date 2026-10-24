'use strict';
/**
 * core-compat.test.js — the Core compatibility contract.
 *
 * The acceptance criterion for Phase 0 is NOT "GET /identity exists". It is that a stale
 * or unknown Core can no longer be silently accepted. So every test below asserts a
 * VERDICT (and `ok === false` where a refusal is required), never merely that a function
 * ran.
 *
 * Every case is driven by an injected observation, so no test touches the user's running
 * Core, starts anything, or depends on the network.
 */

const test = require('node:test');
const assert = require('node:assert');
const Compat = require('../desktop/core-compat');
const { STATES } = Compat;

// A pinned expectation, mirroring what scripts/stamp-core-expectation.mjs writes.
const EXPECTED = Compat.normalizeExpectation({
  mode: 'pinned',
  coreBuildId: '2f6db2a3129c22ed',
  protocolVersion: 1,
});

/** A well-formed, self-consistent identity for the expected build. */
function goodIdentity(overrides) {
  return Object.assign(
    {
      service: 'kai-core',
      coreVersion: '0.1.0',
      buildId: '2f6db2a3129c22ed',
      gitCommit: '1840663d3d7d320b4d2d57e8c69393546c042940',
      protocolVersion: 1,
      pid: 14820,
      startedAt: '2026-10-14T21:28:52.819Z',
      identitySource: 'C:\\tmp\\kai-exec\\app\\target\\release\\core\\build-info.json',
      onDiskBuildId: '2f6db2a3129c22ed',
      identityMatchesDisk: true,
      sourceBuildId: null,
      artifactMatchesSource: null,
      sourceCheckReason: 'no core/src beside the running artifact',
      freshness: 'fresh',
    },
    overrides || {},
  );
}

const check = (body, overrides) => Compat.classifyCoreIdentity(EXPECTED, { status: 200, body: body === undefined ? goodIdentity(overrides) : body });

// ── 1. The expected Core build is accepted ───────────────────────────────────────
test('1. the expected Core build is accepted', () => {
  const verdict = check();
  assert.strictEqual(verdict.ok, true, verdict.reason);
  assert.strictEqual(verdict.state, STATES.COMPATIBLE);
  // The verdict must name the build it accepted, so "compatible" is inspectable.
  assert.strictEqual(verdict.detail.buildId, '2f6db2a3129c22ed');
  assert.strictEqual(verdict.detail.protocolVersion, 1);
});

test('1b. acceptance reports what could NOT be verified rather than implying it was', () => {
  const verdict = check();
  // A shipped bundle genuinely cannot recompute source equality; that must be visible,
  // not rendered as a silent success.
  assert.strictEqual(verdict.detail.artifactMatchesSource, null);
  assert.match(verdict.detail.sourceCheckReason, /no core\/src/);
});

// ── 2. An older / different Core is refused ──────────────────────────────────────
test('2. an older Core build is refused', () => {
  // The real other build on this machine: %LOCALAPPDATA%\KAI\core (commit 8b6d8ae).
  const verdict = check(undefined, { buildId: 'b09ebd4986998b13' });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.state, STATES.STALE);
  assert.match(verdict.reason, /b09ebd4986998b13/);
  assert.match(verdict.reason, /2f6db2a3129c22ed/);
});

test('2b. a Core that contradicts its own on-disk stamp is refused', () => {
  assert.strictEqual(check(undefined, { identityMatchesDisk: false }).state, STATES.STALE);
  assert.strictEqual(check(undefined, { freshness: 'stale' }).state, STATES.STALE);
});

test('2c. a rebuild that kept the expected build id but broke its freshness is still refused', () => {
  // Guards against "the id matches, so ship it" — the Core's own self-consistency wins.
  const verdict = check(undefined, { freshness: 'stale', buildId: '2f6db2a3129c22ed' });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.state, STATES.STALE);
});

// ── 3. An unknown build is refused ───────────────────────────────────────────────
test('3. a Core with no usable build identity is refused', () => {
  for (const bad of [undefined, null, '', 'unknown', 'UNKNOWN', '  ']) {
    const verdict = check(undefined, { buildId: bad });
    assert.strictEqual(verdict.ok, false, `buildId ${JSON.stringify(bad)} must not be accepted`);
    assert.strictEqual(verdict.state, STATES.UNKNOWN_BUILD);
  }
});

// ── 4. An incompatible protocol version is refused ───────────────────────────────
test('4. an incompatible protocol version is refused', () => {
  const older = check(undefined, { protocolVersion: 0 });
  assert.strictEqual(older.ok, false);
  assert.strictEqual(older.state, STATES.PROTOCOL_MISMATCH);

  const newer = check(undefined, { protocolVersion: 2 });
  assert.strictEqual(newer.ok, false);
  assert.strictEqual(newer.state, STATES.PROTOCOL_MISMATCH);
});

test('4b. protocol is checked BEFORE the build id', () => {
  // A Core whose API shape differs must be refused even when the build id happens to
  // match, because every other field may then mean something else.
  const verdict = check(undefined, { protocolVersion: 7, buildId: '2f6db2a3129c22ed' });
  assert.strictEqual(verdict.state, STATES.PROTOCOL_MISMATCH);
});

test('4c. a missing protocol version is refused as unknown, not assumed', () => {
  const verdict = check(undefined, { protocolVersion: undefined });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.state, STATES.UNKNOWN_BUILD);
});

// ── 5. Missing / malformed identity responses ────────────────────────────────────
test('5. a malformed identity response is refused', () => {
  const cases = [
    { status: 200, body: null },
    { status: 200, body: 'not json' },
    { status: 200, body: [] },
    { status: 200, body: { service: 'something-else' } },
    { status: 404, body: null },
    { status: 500, body: { service: 'kai-core' } },
  ];
  for (const observation of cases) {
    const verdict = Compat.classifyCoreIdentity(EXPECTED, observation);
    assert.strictEqual(verdict.ok, false, JSON.stringify(observation));
    assert.strictEqual(verdict.state, STATES.MALFORMED, JSON.stringify(observation));
  }
});

// ── 6. A network failure is distinguishable from a version mismatch ───────────────
test('6. a network failure is reported as unreachable, not as a version problem', () => {
  const verdict = Compat.classifyCoreIdentity(EXPECTED, { error: new Error('ECONNREFUSED 127.0.0.1:8788') });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.state, STATES.UNREACHABLE);
  // The two need opposite actions from the user, so their descriptions must differ.
  const stale = check(undefined, { buildId: 'deadbeefdeadbeef' });
  assert.notStrictEqual(verdict.state, stale.state);
  assert.match(Compat.describeVerdict(verdict), /start the KAI2 Core/i);
  assert.match(Compat.describeVerdict(stale), /restart the Core from the current build/i);
});

// ── 7. The gate refuses to allow a turn (the fetch-level proof is in core-stream.test.js)
test('7. the gate does not allow a turn unless the Core is compatible', () => {
  for (const state of [STATES.STALE, STATES.UNKNOWN_BUILD, STATES.PROTOCOL_MISMATCH, STATES.UNVERIFIABLE, STATES.MALFORMED, STATES.UNREACHABLE]) {
    assert.strictEqual(Compat.isCompatible({ ok: false, state }), false, state);
  }
  assert.strictEqual(Compat.isCompatible({ ok: true, state: STATES.COMPATIBLE }), true);
  // A verdict claiming ok but carrying a non-compatible state must not pass.
  assert.strictEqual(Compat.isCompatible({ ok: true, state: STATES.STALE }), false);
  assert.strictEqual(Compat.isCompatible(null), false);
  assert.strictEqual(Compat.isCompatible(undefined), false);
});

// ── 8. Retry recovers once a compatible Core is available ────────────────────────
test('8. retry recovers after a compatible Core becomes available', async () => {
  // First call: nothing listening. Second call (the Retry): the expected Core answers.
  const responses = [
    () => { throw new Error('ECONNREFUSED'); },
    () => ({ status: 200, json: async () => goodIdentity() }),
  ];
  let calls = 0;
  const gate = Compat.createCoreGate({
    expectation: EXPECTED,
    base: 'http://127.0.0.1:8788',
    ttlMs: 0,
    fetchImpl: async () => responses[Math.min(calls++, responses.length - 1)](),
  });

  const first = await gate.checkTurn();
  assert.strictEqual(first.allowed, false);
  assert.strictEqual(first.verdict.state, STATES.UNREACHABLE);

  const second = await gate.checkTurn(); // Retry
  assert.strictEqual(second.allowed, true, second.verdict.reason);
  assert.strictEqual(second.verdict.state, STATES.COMPATIBLE);
  assert.strictEqual(calls, 2);
});

test('8b. by default a success is NOT cached across turns, so a restarted Core is caught immediately', async () => {
  let mode = 'good';
  const gate = Compat.createCoreGate({
    expectation: EXPECTED,
    base: 'http://x',
    // No ttlMs: the default re-checks every turn. A Core replaced by an older build must
    // be caught on the very next turn, not after a cache window.
    fetchImpl: async () => ({ status: 200, json: async () => (mode === 'good' ? goodIdentity() : goodIdentity({ buildId: 'something-else' })) }),
  });
  assert.strictEqual((await gate.checkTurn()).allowed, true);
  mode = 'stale'; // the operator restarted the Core from an older build
  const after = await gate.checkTurn();
  assert.strictEqual(after.allowed, false);
  assert.strictEqual(after.verdict.state, STATES.STALE);
});

test('8c. an explicit ttlMs caches a success, and documents that behaviour', async () => {
  let calls = 0;
  let mode = 'good';
  const gate = Compat.createCoreGate({
    expectation: EXPECTED,
    base: 'http://x',
    ttlMs: 60000,
    fetchImpl: async () => {
      calls += 1;
      return { status: 200, json: async () => (mode === 'good' ? goodIdentity() : goodIdentity({ buildId: 'x' })) };
    },
  });
  assert.strictEqual((await gate.checkTurn()).allowed, true);
  assert.strictEqual(calls, 1);
  mode = 'stale';
  // Within the TTL the cached success is reused — which is why the DEFAULT is 0 and a
  // caller must opt in deliberately.
  assert.strictEqual((await gate.checkTurn()).allowed, true);
  assert.strictEqual(calls, 1);
  // Refresh (what Retry calls) re-checks regardless of the TTL.
  await gate.refresh();
  assert.strictEqual(calls, 2);
  assert.strictEqual((await gate.checkTurn()).allowed, false);
});

test('8d. a failed verdict is never reused as a success', async () => {
  const gate = Compat.createCoreGate({
    expectation: EXPECTED,
    base: 'http://x',
    ttlMs: 60000,
    fetchImpl: async () => ({ status: 200, json: async () => goodIdentity({ buildId: 'not-the-expected-build' }) }),
  });
  const first = await gate.checkTurn();
  const second = await gate.checkTurn();
  assert.strictEqual(first.allowed, false);
  assert.strictEqual(second.allowed, false, 'a failure must never be served from cache as allowed');
});

test('8e. the gate resolves its base from resolveBase, not only from base', async () => {
  // Regression: the desktop app wires a `resolveBase()` (the Core URL can move at
  // runtime) and passes no `base`. The gate used to fetch a RELATIVE "/identity", so
  // every check failed with "Failed to parse URL from /identity" while the Core was
  // perfectly healthy. Caught by actually launching the app.
  let sawUrl = null;
  const gate = Compat.createCoreGate({
    expectation: EXPECTED,
    resolveBase: () => 'http://core.test',
    fetchImpl: async (url) => {
      sawUrl = String(url);
      return { status: 200, json: async () => goodIdentity() };
    },
  });
  const turn = await gate.checkTurn();
  assert.strictEqual(turn.allowed, true, turn.verdict && turn.verdict.reason);
  assert.strictEqual(sawUrl, 'http://core.test/identity', 'the check must target an absolute URL');
});

test('8f. an empty base is reported as unreachable, never as compatible', async () => {
  const gate = Compat.createCoreGate({ expectation: EXPECTED, base: '' });
  const turn = await gate.checkTurn();
  assert.strictEqual(turn.allowed, false);
});

// ── 9. A legitimate development build is NOT rejected ────────────────────────────
test('9. a development build with a verifiable generated identity is accepted in track mode', () => {
  const track = Compat.normalizeExpectation({ mode: 'track', protocolVersion: 1 });
  const verdict = Compat.classifyCoreIdentity(track, { status: 200, body: goodIdentity({ buildId: 'cafebabe12345678' }) });
  assert.strictEqual(verdict.ok, true, verdict.reason);
  assert.strictEqual(verdict.state, STATES.COMPATIBLE);
  // Accepted, but never silently: the verdict names the build being tracked.
  assert.match(verdict.reason, /cafebabe12345678/);
  assert.match(verdict.reason, /development mode/i);
});

test('9b. track mode still refuses an UNVERIFIABLE build', () => {
  const track = Compat.normalizeExpectation({ mode: 'track', protocolVersion: 1 });
  const verdict = Compat.classifyCoreIdentity(track, { status: 200, body: goodIdentity({ buildId: 'unknown' }) });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.state, STATES.UNKNOWN_BUILD);
});

// ── The artifact/source case ─────────────────────────────────────────────────────
test('artifact built from different source is refused as unverifiable', () => {
  const verdict = check(undefined, { artifactMatchesSource: false, sourceCheckReason: 'source hash differs' });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.state, STATES.UNVERIFIABLE);
  assert.match(verdict.reason, /source hash differs/);
});

test('artifactMatchesSource true is accepted', () => {
  const verdict = check(undefined, { artifactMatchesSource: true });
  assert.strictEqual(verdict.ok, true, verdict.reason);
});

// ── A malformed EXPECTATION is a refusal too ─────────────────────────────────────
test('an unreadable expectation refuses rather than accepting everything', () => {
  const missing = Compat.normalizeExpectation({ mode: 'pinned' }); // no build id
  assert.strictEqual(missing.valid, false);
  const verdict = Compat.classifyCoreIdentity(missing, { status: 200, body: goodIdentity() });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.state, STATES.MALFORMED);
});

test('loadExpectation reads core-expected.json and validates it', () => {
  const loaded = Compat.loadExpectation({
    readFile: () => JSON.stringify({ mode: 'pinned', coreBuildId: 'abc123', protocolVersion: 1 }),
  });
  assert.strictEqual(loaded.valid, true);
  assert.strictEqual(loaded.coreBuildId, 'abc123');

  const broken = Compat.loadExpectation({ readFile: () => '{ not json' });
  assert.strictEqual(broken.valid, false);

  // The env override exists for isolated test instances, and must actually win.
  const fromEnv = Compat.loadExpectation({
    readFile: () => JSON.stringify({ mode: 'pinned', coreBuildId: 'abc123', protocolVersion: 1 }),
    env: { KAI2_EXPECT_CORE_BUILD: 'envbuild', KAI2_EXPECT_PROTOCOL: '1' },
  });
  assert.strictEqual(fromEnv.coreBuildId, 'envbuild');
});

// ── The shipped expectation must be valid and match the current contract ─────────
test('the committed core-expected.json is valid for the current protocol', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'core-expected.json'), 'utf8'));
  const norm = Compat.normalizeExpectation(raw);
  assert.strictEqual(norm.valid, true, norm.problems.join('; '));
  assert.strictEqual(norm.protocolVersion, 1, 'the committed expectation must match Core PROTOCOL_VERSION');
  assert.ok(Compat.isUsableBuildId(norm.coreBuildId));
});

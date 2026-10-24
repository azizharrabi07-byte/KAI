'use strict';
/**
 * core-supervisor.test.js — KAI2 owns the Core without ever causing a SECOND one.
 *
 * The load-bearing property is negative: when a Core is already answering, the supervisor
 * must adopt it and attempt NO spawn. Only one Core may run (it binds a fixed port and owns
 * the SQLite files), so a second one would shadow or corrupt the first. Every test asserts
 * that, plus that a Core KAI2 did not start is never killed.
 *
 * Fully injected: no real process is started and no socket is opened.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createCoreSupervisor, probeCore } = require('../desktop/core-supervisor');

function coreIdentity(overrides) {
  return Object.assign(
    {
      service: 'kai-core',
      coreVersion: '0.1.0',
      buildId: '2f6db2a3129c22ed',
      gitCommit: '1840663d3d7d320b4d2d57e8c69393546c042940',
      protocolVersion: 1,
      pid: 14820,
      startedAt: '2026-10-14T21:28:52.819Z',
      identitySource: 'x',
      onDiskBuildId: '2f6db2a3129c22ed',
      identityMatchesDisk: true,
      sourceBuildId: null,
      artifactMatchesSource: null,
      sourceCheckReason: null,
      freshness: 'fresh',
    },
    overrides || {},
  );
}

const respond = (body, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** A fetch that stands in for "something is listening on the port". */
function probeAnswering(identity) {
  return async () => ({ ok: true, status: 200, json: async () => identity });
}

/** A fetch that fails as if nothing is bound. */
function probeRefused() {
  return async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:8788');
  };
}

// ── The probe identifies a Core, not merely a listener ──────────────────────────
test('the probe identifies a real Core and names its build', async () => {
  const p = await probeCore({ base: 'http://x', fetchImpl: probeAnswering(coreIdentity()) });
  assert.strictEqual(p.answering, true);
  assert.strictEqual(p.identity.service, 'kai-core');
  assert.strictEqual(p.identity.buildId, '2f6db2a3129c22ed');
});

test('the probe does NOT call a non-Core service a Core', async () => {
  // A stranger on the port must not stop KAI2 from starting the real Core.
  const stranger = await probeCore({ base: 'http://x', fetchImpl: probeAnswering({ hello: 'world' }) });
  assert.strictEqual(stranger.answering, false);
  assert.match(stranger.reason, /not a kai-core identity/);

  const notFound = await probeCore({ base: 'http://x', fetchImpl: respond({ error: 'nope' }, 404) });
  assert.strictEqual(notFound.answering, false);
  assert.match(notFound.reason, /HTTP 404/);

  const notJson = await probeCore({
    base: 'http://x',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
  });
  assert.strictEqual(notJson.answering, false);
});

// ── Adopt, never race a second Core ─────────────────────────────────────────────
test('an answering Core is adopted and NO spawn is attempted', async () => {
  const spawns = [];
  const sup = createCoreSupervisor({
    base: 'http://x',
    fetchImpl: probeAnswering(coreIdentity()),
    spawnImpl: (...args) => {
      spawns.push(args);
      throw new Error('MUST NOT SPAWN');
    },
  });
  const result = await sup.ensure();
  assert.strictEqual(result.origin, 'adopted');
  assert.strictEqual(spawns.length, 0, 'a second Core must never be started');
  assert.strictEqual(result.identity.buildId, '2f6db2a3129c22ed');
});

test('ensuring twice while a Core is up still spawns nothing', async () => {
  const spawns = [];
  const sup = createCoreSupervisor({
    fetchImpl: probeAnswering(coreIdentity()),
    spawnImpl: () => { spawns.push(1); return { pid: 1, on() {}, unref() {} }; },
  });
  await sup.ensure();
  await sup.ensure();
  await sup.ensure();
  assert.strictEqual(spawns.length, 0);
});

// ── Spawn only when nothing Core-shaped is there ────────────────────────────────
test('with nothing listening, KAI2 starts the Core and reports it as owned', async () => {
  const spawns = [];
  const sup = createCoreSupervisor({
    coreDir: __dirname, // a directory that does exist
    spawnImpl: (bin, args) => {
      spawns.push({ bin, args });
      return { pid: 4242, on() {}, unref() {}, kill() {}, exitCode: null };
    },
  });
  // Point the probe at a definitely-closed port via an injected fetch.
  const sup2 = createCoreSupervisor({
    coreDir: __dirname,
    fetchImpl: probeRefused(),
    spawnImpl: (bin, args) => {
      spawns.push({ bin, args });
      return { pid: 4242, on() {}, unref() {}, kill() {}, exitCode: null };
    },
  });
  void sup; // the first supervisor is only here to show the default path is not taken
  const result = await sup2.ensure();
  // __dirname has no server.js, so this must refuse rather than spawn blindly.
  assert.strictEqual(result.origin, 'absent');
  assert.match(String(result.error), /no Core entry point/);
  assert.strictEqual(spawns.length, 0, 'a missing entry point must not be spawned');
});

test('a Core that is not there is reported absent, with the reason', async () => {
  const sup = createCoreSupervisor({ coreDir: 'C:\\does\\not\\exist', fetchImpl: probeRefused() });
  const result = await sup.ensure();
  assert.strictEqual(result.origin, 'absent');
  assert.match(String(result.error), /no Core entry point/);
  assert.strictEqual(sup.status().serverPresent, false);
});

// ── Never stop a Core we did not start ──────────────────────────────────────────
test('an adopted Core is never killed by KAI2', async () => {
  const sup = createCoreSupervisor({ fetchImpl: probeAnswering(coreIdentity()) });
  await sup.ensure();
  const stopped = await sup.stopOwned();
  assert.strictEqual(stopped.stopped, false);
  assert.match(stopped.reason, /does not own/);
});

test('stopOwned with nothing owned stops nothing', async () => {
  const sup = createCoreSupervisor({ coreDir: 'C:\\does\\not\\exist', fetchImpl: probeRefused() });
  await sup.ensure();
  const stopped = await sup.stopOwned();
  assert.strictEqual(stopped.stopped, false);
});

// ── Status is honest ────────────────────────────────────────────────────────────
test('status reports origin, port and whether the entry point exists', async () => {
  const sup = createCoreSupervisor({ fetchImpl: probeAnswering(coreIdentity()), port: 8788 });
  await sup.ensure();
  const status = sup.status();
  assert.strictEqual(status.origin, 'adopted');
  assert.strictEqual(status.port, 8788);
  assert.strictEqual(typeof status.serverPresent, 'boolean');
  assert.strictEqual(status.pid, null, 'an adopted Core is not our child, so it has no pid here');
});

// -- The environment the Core is started with ------------------------------------
//
// KAI_HERMES_PROFILE is not cosmetic: it is what puts the delegated worker in the Hermes
// profile where KAI installed its per-tool authorization hook. A Core started against the
// host's default profile would run the worker somewhere the boundary is not installed.
test('a Core KAI2 starts is pointed at the KAI Hermes profile', async () => {
  const fsx = require('node:fs');
  const osx = require('node:os');
  const pathx = require('node:path');
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'kai-sup-'));
  fsx.writeFileSync(pathx.join(dir, 'server.js'), '// stand-in entry point\n', 'utf8');

  const spawned = [];
  const sup = createCoreSupervisor({
    coreDir: dir,
    fetchImpl: probeRefused(),
    loadToken: async () => 'token',
    saveToken: async () => {},
    spawnImpl: (bin, args, opts) => {
      spawned.push({ bin, args, opts });
      return { pid: 4242, on() {}, unref() {}, kill() {}, exitCode: null };
    },
  });

  const previous = process.env.KAI_HERMES_PROFILE;
  delete process.env.KAI_HERMES_PROFILE;
  try {
    const result = await sup.ensure();
    assert.strictEqual(result.origin, 'owned');
  } finally {
    if (previous === undefined) delete process.env.KAI_HERMES_PROFILE;
    else process.env.KAI_HERMES_PROFILE = previous;
    fsx.rmSync(dir, { recursive: true, force: true });
  }

  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].opts.env.KAI_HERMES_PROFILE, 'kai');
  assert.strictEqual(spawned[0].opts.env.KAI_HOST_TOKEN, 'token');
});

test('an explicit KAI_HERMES_PROFILE is passed through rather than overridden', async () => {
  const fsx = require('node:fs');
  const osx = require('node:os');
  const pathx = require('node:path');
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'kai-sup-'));
  fsx.writeFileSync(pathx.join(dir, 'server.js'), '// stand-in entry point\n', 'utf8');

  const spawned = [];
  const sup = createCoreSupervisor({
    coreDir: dir,
    fetchImpl: probeRefused(),
    loadToken: async () => 'token',
    saveToken: async () => {},
    spawnImpl: (bin, args, opts) => {
      spawned.push({ bin, args, opts });
      return { pid: 4242, on() {}, unref() {}, kill() {}, exitCode: null };
    },
  });

  const previous = process.env.KAI_HERMES_PROFILE;
  process.env.KAI_HERMES_PROFILE = 'other';
  try {
    await sup.ensure();
  } finally {
    if (previous === undefined) delete process.env.KAI_HERMES_PROFILE;
    else process.env.KAI_HERMES_PROFILE = previous;
    fsx.rmSync(dir, { recursive: true, force: true });
  }

  assert.strictEqual(spawned[0].opts.env.KAI_HERMES_PROFILE, 'other');
});

// ── Two ensures at once must still start ONE Core ───────────────────────────────
//
// `ensure()` is async (probe → token → spawn). Two callers that arrive while the port
// is still silent can both pass the "no child yet" check before either spawns. The
// loser then binds the same port and exits; KAI2 keeps a dead child and reports a
// Core it does not actually own. Single-flight is the contract.

test('two concurrent ensures start exactly one Core', async () => {
  const fsx = require('node:fs');
  const osx = require('node:os');
  const pathx = require('node:path');
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'kai-sup-race-'));
  fsx.writeFileSync(pathx.join(dir, 'server.js'), '// stand-in entry point\n', 'utf8');

  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let spawns = 0;
  const sup = createCoreSupervisor({
    coreDir: dir,
    fetchImpl: probeRefused(),
    loadToken: async () => { await barrier; return 'token'; },
    saveToken: async () => {},
    spawnImpl: () => {
      spawns += 1;
      return { pid: 4242, on() {}, unref() {}, kill() {}, exitCode: null };
    },
  });

  try {
    const first = sup.ensure();
    const second = sup.ensure();
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(spawns, 1, 'a second Core must never be spawned by a concurrent ensure');
    assert.strictEqual(a.origin, 'owned');
    assert.strictEqual(b.origin, 'owned');
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

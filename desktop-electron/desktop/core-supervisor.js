'use strict';
/**
 * core-supervisor.js — KAI2 owns the Core's lifecycle.
 *
 * ── Why this exists
 * Until now KAI2 was a client that assumed somebody else had started the Core. In practice
 * the OLD Tauri app (`kai.exe`) was the thing that did it: `kai.exe` is the parent process
 * of `node core/server.js`. That made the old UI load-bearing, so it could not be retired,
 * and it meant a KAI2 user had to start a different application before KAI2 would work.
 *
 * The Rust launcher already solved the hard part, and this mirrors its design deliberately
 * (app/src-tauri/src/core_process.rs):
 *
 *   1. ADOPT. If something that IDENTIFIES as a Core already answers, use it and never
 *      start a second one. Only one Core may run — it binds a fixed port and owns the
 *      SQLite files, so a second one would corrupt or shadow the first.
 *   2. SPAWN. Otherwise start `node <core>/server.js` with no console window.
 *   3. Re-probe. A Core that disappears is a cold start again: the next pass adopts or
 *      spawns, whichever is right. State is never assumed.
 *
 * ── What it deliberately does NOT do
 * - It never kills a Core it did not start. An adopted Core belongs to whoever started it.
 * - It does not treat "something is listening" as a Core: the probe requires the Core's own
 *   identity, because a stray process on the port must not stop KAI2 starting the real one.
 * - It does not guess the Core's location from the CWD; the path is explicit and overridable.
 */

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** The Core actually running on this machine today (verified: pid 14820). */
const DEFAULT_CORE_DIR = 'C:\\tmp\\kai-exec\\app\\target\\release\\core';
const DEFAULT_PORT = 8788;

/**
 * Probe for a Core-shaped server.
 *
 * `/identity` is used on purpose. It answers with the Core's frozen facts and nothing else:
 * unlike `/health` it does not probe Hermes/OpenCode (so a healthy port does not depend on
 * other services being up), and unlike `/state` it actually carries the `service` field.
 * Measured: `/state` returns `{ok, startedAt, uptimeMs, database, agents, …}` with **no**
 * service field, so a probe keyed on it cannot tell a Core from a stranger on the port.
 */
async function probeCore(options = {}) {
  const base = String(options.base || '').replace(/\/+$/, '');
  const doFetch = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(base + '/identity', {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { answering: false, reason: `HTTP ${res.status}` };
    let body = null;
    try {
      body = await res.json();
    } catch {
      return { answering: false, reason: 'not JSON' };
    }
    // Core identity, not merely "something answered".
    if (!body || typeof body !== 'object' || body.service !== 'kai-core') {
      return { answering: false, reason: 'not a kai-core identity' };
    }
    return { answering: true, identity: body };
  } catch (err) {
    return { answering: false, reason: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Own the Core: adopt one that is already up, otherwise start one.
 *
 * `origin` is reported so the UI can be honest about which happened:
 *   "adopted" — an existing Core was used; KAI2 must not stop it.
 *   "owned"   — KAI2 started it; KAI2 may stop it.
 *   "absent"  — nothing is running and starting it failed.
 */
function createCoreSupervisor(options = {}) {
  const coreDir = options.coreDir || process.env.KAI2_CORE_DIR || DEFAULT_CORE_DIR;
  const port = Number(options.port || process.env.KAI2_CORE_PORT || DEFAULT_PORT);
  const base = `http://127.0.0.1:${port}`;
  const nodeBin = options.nodeBin || process.execPath;
  const spawnImpl = options.spawnImpl || spawn;

  let origin = 'absent';
  let child = null;
  let lastError = null;
  // Single-flight: `ensure()` probes, reads the token and spawns across several awaits,
  // so two callers could both see "no child" and start two Cores on one port. Every
  // concurrent caller now shares the first call's result.
  let inflight = null;
  /**
   * The token minted for the Core KAI2 runs, or null.
   *
   * Minted once and PERSISTED (encrypted, by the caller) so a later KAI2 run — which
   * adopts the Core this one started — still holds the credential that Core accepts.
   * Without that, owner controls would break every time the window was reopened.
   */
  let hostToken = null;
  const loadToken = typeof options.loadToken === 'function' ? options.loadToken : async () => null;
  const saveToken = typeof options.saveToken === 'function' ? options.saveToken : async () => {};

  const serverJs = path.join(coreDir, 'server.js');

  /** Is the Core's entry point actually on disk? Spawning must not be attempted blindly. */
  function corePresent() {
    try {
      return fs.existsSync(serverJs);
    } catch {
      return false;
    }
  }

  async function ensureOnce() {
    // (1) ADOPT — never start a second Core.
    const probe = await probeCore({ base, fetchImpl: options.fetchImpl, timeoutMs: options.probeTimeoutMs });
    if (probe.answering) {
      origin = 'adopted';
      lastError = null;
      // An adopted Core may be one WE started in an earlier run, so the persisted token
      // is used. If it belongs to somebody else, Core refuses it and the caller reports
      // that honestly — which is the same direction as sending no token at all.
      hostToken = await loadToken();
      return { origin, base, port, identity: probe.identity };
    }

    // (3, part) A Core we started that has since exited is not "ours" any more.
    if (child && child.exitCode !== null) child = null;

    if (child) {
      // We are already starting one; do not race a second.
      return { origin: 'owned', base, port, pending: true };
    }

    // (2) SPAWN.
    if (!corePresent()) {
      origin = 'absent';
      lastError = `no Core entry point at ${serverJs}`;
      return { origin, base, port, error: lastError };
    }

    try {
      // ── The host token ────────────────────────────────────────────────────────
      // Owner-only Core routes (the policy mode, the Doer, deciding an approval)
      // require attestation, and a Core started WITHOUT `KAI_HOST_TOKEN` refuses
      // every one of them (`ownerAuth: owner-controls-refused`). KAI2 owns this
      // Core's lifecycle, so KAI2 mints the token and passes it — the same thing the
      // desktop app does — which is what makes the app it started operable.
      //
      // Only a Core WE start gets our token. An ADOPTED Core belongs to whoever
      // started it; we do not know their token, so owner controls stay refused for it
      // and the UI says so instead of pretending they work.
      hostToken = (await loadToken()) || randomBytes(32).toString('hex');
      await saveToken(hostToken);
      // `detached` + no stdio so the Core outlives a window close and shows no console.
      // The Core reads its own credentials (KAI_HERMES_KEY from the env or the selected
      // Hermes profile), so nothing else secret is passed here.
      //
      // KAI_HERMES_PROFILE puts the delegated worker in KAI's own Hermes profile. That
      // profile is where KAI installs its `pre_tool_call` authorization hook, so a Core
      // that targeted the host's default profile would run the worker somewhere the
      // boundary is not installed. Override it only when the hook lives elsewhere.
      child = spawnImpl(nodeBin, [serverJs], {
        cwd: coreDir,
        env: {
          ...process.env,
          // In a PACKAGED app `process.execPath` is KAI2.exe, not a bare Node runtime.
          // Without this, spawning it with server.js starts a SECOND app window and
          // Core never listens — which is exactly what happened in the packaged build.
          // The flag makes the same binary behave as Node, which is what the dev
          // launch (`electron.exe`) happened to do already.
          ELECTRON_RUN_AS_NODE: '1',
          KAI_CORE_PORT: String(port),
          KAI_HOST_TOKEN: hostToken,
          KAI_HERMES_PROFILE: process.env.KAI_HERMES_PROFILE || 'kai',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      });
      child.on('error', (err) => { lastError = String(err && err.message ? err.message : err); });
      child.on('exit', () => { child = null; });
      if (child.unref) child.unref();
      origin = 'owned';
      lastError = null;
      return { origin, base, port, pid: child.pid };
    } catch (err) {
      origin = 'absent';
      lastError = String(err && err.message ? err.message : err);
      return { origin, base, port, error: lastError };
    }
  }

  /**
   * Stop the Core ONLY when KAI2 started it. An adopted Core belongs to its own starter
   * and killing it would be an unrequested side effect on somebody else's process.
   */
  async function stopOwned() {
    if (origin !== 'owned' || !child) {
      return { stopped: false, reason: `origin is ${origin}; KAI2 does not own that Core` };
    }
    try {
      child.kill();
      child = null;
      origin = 'absent';
      return { stopped: true };
    } catch (err) {
      return { stopped: false, reason: String(err && err.message ? err.message : err) };
    }
  }

  /** Public entry point: one probe → spawn sequence at a time, however many callers. */
  function ensure() {
    if (inflight) return inflight;
    const run = ensureOnce().finally(() => {
      if (inflight === run) inflight = null;
    });
    inflight = run;
    return run;
  }

  function status() {
    return { origin, base, port, coreDir, serverPresent: corePresent(), pid: child ? child.pid : null, error: lastError };
  }

  /**
   * The credential to attest an owner-only route with, or null when there is none.
   *
   * This is the token we minted and passed to the Core, whether we started it in this
   * run or in an earlier one. It is null only when nothing has ever been minted.
   */
  function token() {
    return hostToken;
  }

  return {
    ensure,
    stopOwned,
    status,
    token,
    probe: () => probeCore({ base, fetchImpl: options.fetchImpl, timeoutMs: options.probeTimeoutMs }),
  };
}

module.exports = { createCoreSupervisor, probeCore, DEFAULT_CORE_DIR, DEFAULT_PORT };

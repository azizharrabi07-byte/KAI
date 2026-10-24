'use strict';
/**
 * core-compat.js — does the Core answering REALLY match the build KAI2 expects?
 *
 * ── Why this exists
 * KAI2 is an Electron client that proxies to a Core it does not own or launch. A
 * reachable Core was therefore accepted silently: a stale process left running from an
 * earlier build answered every request and nothing in the UI or the bridge noticed. The
 * comparison audit made this concrete — the live Core was build `1840663`, an ancestor
 * of source HEAD, while KAI2 happily proxied to it.
 *
 * Two facts make this fixable without redesigning Core ownership:
 *
 *   1. Core already exposes `GET /identity` returning a `CoreIdentity`: `buildId` is a
 *      SHA-256 of the SOURCE tree (not of the emitted artifact, so `dist/` and `bundle/`
 *      agree), plus `gitCommit`, `protocolVersion`, `freshness`, `identityMatchesDisk`,
 *      `artifactMatchesSource` and the reason when it cannot be checked.
 *   2. `PROTOCOL_VERSION` is declared in Core with the rule written next to it: "A client
 *      that requires 1 must not adopt a Core reporting anything else."
 *
 * So KAI2 does not need to launch, supervise or restart anything. It needs to KNOW which
 * build it expects, COMPARE that against what answered, and REFUSE to proceed when they
 * disagree — which is exactly what this module computes.
 *
 * ── What this module deliberately is NOT
 * - It does not start, stop or restart a Core. Core ownership is unchanged.
 * - It does not treat `/health` or a successful TCP connection as proof of anything.
 * - It does not treat `coreVersion` ("0.1.0") as identity: that string is the same across
 *   builds. Identity is `buildId` + `protocolVersion` + the Core's own self-consistency.
 * - It never reports a failure as success. Every branch returns a reason string.
 *
 * ── The one hard rule
 * A stale, unknown or unverifiable Core must NEVER classify as `compatible`. Callers may
 * choose how loudly to complain, but they may not override this classification.
 */

const EXPECTED_FILE = 'core-expected.json';

/**
 * The verdict. `ok` is the ONLY field a caller may gate normal work on.
 *
 *   compatible         the expected build answered, the protocol matches, and the Core's
 *                      own identity is self-consistent.
 *   stale              a Core answered, but it is not the build KAI2 expects — or it
 *                      contradicts its own on-disk stamp.
 *   unknown-build      a Core answered without a usable build identity.
 *   protocol-mismatch  the API surface is a different shape; an older client would
 *                      MISREAD it, so this must refuse even if the build id matched.
 *   unverifiable       the artifact cannot be shown to come from the source it claims
 *                      where verification was required.
 *   malformed          something answered, but not with a valid CoreIdentity.
 *   unreachable        no HTTP response at all (transport failure).
 *
 * `unreachable` is deliberately distinct from every version problem: "start the Core"
 * and "your Core is the wrong build" need opposite responses from the user.
 */
const STATES = Object.freeze({
  COMPATIBLE: 'compatible',
  STALE: 'stale',
  UNKNOWN_BUILD: 'unknown-build',
  PROTOCOL_MISMATCH: 'protocol-mismatch',
  UNVERIFIABLE: 'unverifiable',
  MALFORMED: 'malformed',
  UNREACHABLE: 'unreachable',
});

const EXPECTED_MODES = Object.freeze({
  /** The Core must be exactly the build recorded in core-expected.json. */
  PINNED: 'pinned',
  /**
   * Development: accept any Core whose identity is *verifiable* (a real generated build
   * id that matches its own stamp). A deliberately generated dev build must not be
   * rejected — but it is still surfaced, never silent.
   */
  TRACK: 'track',
});

/** A build id is usable only when it is a real value, not a placeholder. */
function isUsableBuildId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().toLowerCase() !== 'unknown';
}

/** Missing/placeholder protocol versions are unknown, which is a refusal, not a pass. */
function normalizeProtocol(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Clamp and validate an expectation read from JSON or the environment.
 * A malformed expectation is itself a refusal reason — it must not silently become
 * "expect nothing", which would make every Core compatible.
 */
function normalizeExpectation(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const mode = source.mode === EXPECTED_MODES.TRACK ? EXPECTED_MODES.TRACK : EXPECTED_MODES.PINNED;
  const protocolVersion = normalizeProtocol(source.protocolVersion);
  const coreBuildId = isUsableBuildId(source.coreBuildId) ? source.coreBuildId.trim() : null;
  const problems = [];
  if (protocolVersion === null) problems.push('no required protocolVersion recorded');
  if (mode === EXPECTED_MODES.PINNED && coreBuildId === null) {
    problems.push('pinned mode requires a coreBuildId');
  }
  return {
    mode,
    protocolVersion,
    coreBuildId,
    note: typeof source.note === 'string' ? source.note : null,
    valid: problems.length === 0,
    problems,
  };
}

/**
 * Load the expectation: an explicit override wins, then `core-expected.json`, then an
 * env var (so an isolated test instance or a dev run can point somewhere else).
 *
 * `readFile` is injected rather than imported so this stays a pure, testable function
 * with no hidden filesystem access.
 */
function loadExpectation(options) {
  const opts = options || {};
  const fromEnv = opts.env && typeof opts.env === 'object' ? opts.env : {};
  if (isUsableBuildId(fromEnv.KAI2_EXPECT_CORE_BUILD)) {
    return normalizeExpectation({
      mode: fromEnv.KAI2_EXPECT_CORE_MODE === 'track' ? 'track' : 'pinned',
      coreBuildId: fromEnv.KAI2_EXPECT_CORE_BUILD,
      protocolVersion: Number(fromEnv.KAI2_EXPECT_PROTOCOL) || 1,
      note: 'from environment',
    });
  }
  let raw = null;
  try {
    const text = opts.readFile(EXPECTED_FILE, 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    return {
      mode: EXPECTED_MODES.PINNED,
      protocolVersion: null,
      coreBuildId: null,
      note: null,
      valid: false,
      problems: ['core-expected.json is missing or unreadable: ' + String(err && err.message ? err.message : err)],
    };
  }
  return normalizeExpectation(raw);
}

/**
 * THE classifier. Pure: it takes what was observed and returns a verdict. No I/O, no
 * clock, no network — so every failure mode below is unit-testable without a Core.
 *
 * @param expectation  normalized expectation (see normalizeExpectation)
 * @param observation  { error } for a transport failure, or { status, body } for a reply
 */
function classifyCoreIdentity(expectation, observation) {
  const exp = expectation || normalizeExpectation(null);
  const obs = observation || {};
  const at = new Date().toISOString();

  const deny = (state, reason, detail) => ({
    ok: false,
    state,
    reason,
    detail: detail || null,
    identity: obs.body && typeof obs.body === 'object' ? obs.body : null,
    checkedAt: at,
  });

  // A malformed expectation is a refusal, and it must be distinguishable from a bad Core:
  // the fix is in KAI2's own files, not in the running process.
  if (!exp.valid) {
    return deny(STATES.MALFORMED, 'KAI2 does not know which Core build it expects (' + exp.problems.join('; ') + ')');
  }

  // 1. Transport. Nothing answered — this is NOT a version problem.
  if (obs.error) {
    const message = obs.error && obs.error.message ? obs.error.message : String(obs.error);
    return deny(STATES.UNREACHABLE, 'KAI Core did not respond: ' + message);
  }

  // 2. HTTP. A non-2xx is reachable-but-not-a-Core, which is a malformed identity rather
  //    than unreachability: the user's action differs (wrong service on the port).
  if (typeof obs.status === 'number' && (obs.status < 200 || obs.status >= 300)) {
    return deny(STATES.MALFORMED, 'GET /identity answered HTTP ' + obs.status + ' — that is not a KAI Core identity response');
  }

  const body = obs.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return deny(STATES.MALFORMED, 'GET /identity did not return a JSON object');
  }

  // 3. Shape. `service` is how a Core names itself; anything else on the port is not it.
  if (body.service !== 'kai-core') {
    return deny(
      STATES.MALFORMED,
      'the response is not a KAI Core identity (service = ' + JSON.stringify(body.service) + ')',
    );
  }

  // 4. Protocol shape. Checked BEFORE the build id on purpose: a Core whose API surface
  //    has a different shape must be refused even if its build id happened to match,
  //    because every other field may mean something else.
  const protocol = normalizeProtocol(body.protocolVersion);
  if (protocol === null) {
    return deny(STATES.UNKNOWN_BUILD, 'KAI Core reported no protocolVersion');
  }
  if (protocol !== exp.protocolVersion) {
    return deny(
      STATES.PROTOCOL_MISMATCH,
      'KAI Core speaks protocol ' + protocol + ' but KAI2 requires ' + exp.protocolVersion,
    );
  }

  // 5. Build identity must exist before it can be compared.
  if (!isUsableBuildId(body.buildId)) {
    return deny(STATES.UNKNOWN_BUILD, 'KAI Core reported no usable buildId (it may be running straight from source with no build stamp)');
  }
  const buildId = body.buildId.trim();

  // 6. The Core's OWN self-consistency. A process whose loaded identity no longer matches
  //    its stamp, or that declares itself stale, is reporting a contradiction — refuse
  //    regardless of what the expected build is.
  if (body.freshness === 'stale') {
    return deny(STATES.STALE, 'KAI Core reports its own identity as stale (the stamp on disk is no longer the one this process loaded)');
  }
  if (body.identityMatchesDisk === false) {
    return deny(STATES.STALE, 'KAI Core is running an identity that no longer matches build-info.json on disk — it was rebuilt after this process started');
  }

  // 7. Where source verification was possible and FAILED, the artifact is not the code we
  //    think it is. `null` means "could not check" (a shipped bundle has no source beside
  //    it) and is recorded, not treated as failure.
  if (body.artifactMatchesSource === false) {
    return deny(
      STATES.UNVERIFIABLE,
      'KAI Core was built from different source than the core/src beside it' +
        (body.sourceCheckReason ? ' (' + body.sourceCheckReason + ')' : ''),
    );
  }

  // 8. The comparison that gives this module its name.
  if (exp.mode === EXPECTED_MODES.PINNED) {
    if (buildId !== exp.coreBuildId) {
      return deny(
        STATES.STALE,
        'KAI Core build ' + buildId + ' is not the build KAI2 expects (' + exp.coreBuildId + ')',
        { expected: exp.coreBuildId, actual: buildId },
      );
    }
  }

  // 9. Accept. Report exactly what was verified, including what could NOT be verified, so
  //    the UI can be honest rather than merely green.
  return {
    ok: true,
    state: STATES.COMPATIBLE,
    reason:
      exp.mode === EXPECTED_MODES.TRACK
        ? 'tracking Core build ' + buildId + ' (development mode: any verifiable build id is accepted)'
        : 'KAI Core build ' + buildId + ' matches the expected build',
    detail: {
      buildId,
      gitCommit: typeof body.gitCommit === 'string' ? body.gitCommit : null,
      protocolVersion: protocol,
      mode: exp.mode,
      freshness: typeof body.freshness === 'string' ? body.freshness : null,
      // null = "could not be checked here", which is not the same as "verified".
      artifactMatchesSource: typeof body.artifactMatchesSource === 'boolean' ? body.artifactMatchesSource : null,
      sourceCheckReason: typeof body.sourceCheckReason === 'string' ? body.sourceCheckReason : null,
      identitySource: typeof body.identitySource === 'string' ? body.identitySource : null,
    },
    identity: body,
    checkedAt: at,
  };
}

/**
 * The live check: GET /identity and classify. `fetchImpl` is injected so tests drive the
 * network deterministically.
 */
async function checkCoreCompatibility(expectation, options) {
  const opts = options || {};
  const base = String(opts.base || '').replace(/\/+$/, '');
  const doFetch = opts.fetchImpl || fetch;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(base + '/identity', {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      return classifyCoreIdentity(expectation, { status: res.status, body: null });
    }
    return classifyCoreIdentity(expectation, { status: res.status, body });
  } catch (err) {
    return classifyCoreIdentity(expectation, { error: err });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A stable, user-facing sentence. The UI shows this verbatim; it must never imply a
 * success, and it must name the concrete next action.
 */
function describeVerdict(verdict) {
  const state = verdict && verdict.state;
  switch (state) {
    case STATES.COMPATIBLE:
      return verdict.reason;
    case STATES.UNREACHABLE:
      return 'KAI Core is not reachable. Start the KAI2 Core, then retry. (' + verdict.reason + ')';
    case STATES.STALE:
      return 'KAI2 is talking to the wrong KAI Core build, so answers would describe code that is not running. ' + verdict.reason + '. Restart the Core from the current build, then retry.';
    case STATES.UNKNOWN_BUILD:
      return 'The KAI Core that answered cannot prove which build it is, so KAI2 cannot trust it. ' + verdict.reason + '. Start a Core built with `npm run build` or `npm run bundle`, then retry.';
    case STATES.PROTOCOL_MISMATCH:
      return 'This KAI Core speaks a different protocol version, so KAI2 would misread it. ' + verdict.reason + '. Update the Core (or KAI2) until both agree, then retry.';
    case STATES.UNVERIFIABLE:
      return 'The KAI Core artifact cannot be shown to match its source. ' + verdict.reason + '. Rebuild and restart the Core, then retry.';
    case STATES.MALFORMED:
      return 'Something is answering on the Core port but it is not a KAI Core identity response. ' + verdict.reason + '.';
    default:
      return 'KAI2 could not verify the running KAI Core.';
  }
}

/** True only for the one state that permits normal work. */
function isCompatible(verdict) {
  return Boolean(verdict && verdict.ok === true && verdict.state === STATES.COMPATIBLE);
}

/**
 * A gate around the check, so every caller shares one verdict.
 *
 * `checkTurn()` is the enforceable decision: the main process calls it before proxying a
 * turn, so a renderer that is stale, out of date, or simply lying cannot push a request
 * through to an incompatible Core.
 *
 * ── Why the default TTL is 0 (re-check every turn)
 * The identity is frozen when a Core process starts, so a running Core cannot silently
 * become a different build — but it CAN be replaced by one. Restarting the Core with an
 * older build would leave a cached success looking valid for the length of the TTL, and
 * the very first turn after that restart would go to the wrong Core. That is exactly the
 * silent acceptance this module exists to remove. The check is a `GET /identity` on
 * localhost, measured in single-digit milliseconds against a turn that costs seconds, so
 * caching the success buys almost nothing and can cost the whole guarantee.
 *
 * `ttlMs` remains available for a caller that has measured a reason to raise it. A FAILED
 * verdict is never reused as a success regardless of the TTL.
 */
function createCoreGate(options) {
  const opts = options || {};
  const ttlMs = Number(opts.ttlMs) >= 0 ? Number(opts.ttlMs) : 0;
  let cached = null;

  async function run() {
    const expectation = opts.expectation || loadExpectation(opts);
    // Resolve the base here, once. Callers of `createCoreGate` naturally have a
    // `resolveBase()` (the URL can move at runtime), but `checkCoreCompatibility` takes a
    // plain `base`. Without this the gate fetched a relative "/identity" and every check
    // failed with "Failed to parse URL" — the Core was healthy the whole time.
    const resolvedBase =
      typeof opts.base === 'string' && opts.base.length > 0
        ? opts.base
        : typeof opts.resolveBase === 'function'
          ? opts.resolveBase()
          : '';
    const verdict = await checkCoreCompatibility(expectation, { ...opts, base: resolvedBase });
    cached = verdict;
    return verdict;
  }

  return {
    /** Force a fresh check. This is what a Retry button calls. */
    async refresh() {
      return run();
    },
    /** The last verdict, or null when nothing has been checked yet. */
    current() {
      return cached;
    },
    /**
     * Decide whether a turn may proceed. A success is cached briefly; a failure is not
     * cached as success and is re-derived on the next call.
     */
    async checkTurn() {
      if (cached && isCompatible(cached) && Date.now() - Date.parse(cached.checkedAt) < ttlMs) {
        return { allowed: true, verdict: cached };
      }
      const verdict = await run();
      return { allowed: isCompatible(verdict), verdict };
    },
  };
}

module.exports = {
  STATES,
  EXPECTED_MODES,
  EXPECTED_FILE,
  isUsableBuildId,
  normalizeExpectation,
  loadExpectation,
  classifyCoreIdentity,
  checkCoreCompatibility,
  describeVerdict,
  isCompatible,
  createCoreGate,
};

'use strict';
/**
 * core-stream.test.js — proof that an incompatible Core never receives a turn.
 *
 * This is the test that makes Phase 0 an enforcement rather than a display. It asserts on
 * the BLOCKED SIDE EFFECT (no /chat/stream request is made) and on the refusal the user
 * sees — not on whether some mock was called.
 */

const test = require('node:test');
const assert = require('node:assert');
const Compat = require('../desktop/core-compat');
const { createCoreStreamHandler } = require('../desktop/core-stream');

const EXPECTED = Compat.normalizeExpectation({
  mode: 'pinned',
  coreBuildId: '2f6db2a3129c22ed',
  protocolVersion: 1,
});

function identity(overrides) {
  return Object.assign(
    {
      service: 'kai-core',
      coreVersion: '0.1.0',
      buildId: '2f6db2a3129c22ed',
      gitCommit: '1840663d3d7d320b4d2d57e8c69393546c042940',
      protocolVersion: 1,
      pid: 1,
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

/** A readable SSE body carrying one delta frame and a done frame. */
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const parts = chunks.map(c => encoder.encode(c));
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true, value: undefined }),
      }),
    },
  };
}

/** Record every channel the handler reports back to the renderer. */
function recorder() {
  const events = [];
  return { events, send: (channel, payload) => events.push({ channel, payload }) };
}

/** Build a handler whose identity check and turn fetch are both injected, and counted. */
function harness(identityBody, options) {
  const opts = options || {};
  const { events, send } = recorder();
  const identityCalls = [];
  const turnCalls = [];
  const gate = Compat.createCoreGate({
    expectation: EXPECTED,
    base: 'http://core.test',
    ttlMs: 0,
    fetchImpl: async (url) => {
      identityCalls.push(url);
      if (opts.identityThrows) throw new Error('ECONNREFUSED');
      return { status: 200, json: async () => identityBody };
    },
  });
  const handler = createCoreStreamHandler({
    gate,
    resolveBase: () => 'http://core.test',
    fetchImpl: async (url, init) => {
      turnCalls.push({ url, init });
      if (opts.turnThrows) throw new Error('socket hang up');
      return sseResponse(['data:{"delta":"hello"}\n\n', 'data:{"done":true}\n\n']);
    },
  });
  return { handler, send, events, identityCalls, turnCalls };
}

// ── The refusal: no request reaches an incompatible Core ─────────────────────────
test('a STALE Core receives no turn at all, and the user is told why', async () => {
  const h = harness(identity({ buildId: 'b09ebd4986998b13' }));
  const result = await h.handler.handle({ requestId: 'r1', text: 'do the thing', send: h.send });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.state, Compat.STATES.STALE);
  // THE blocked side effect: the turn request was never made.
  assert.strictEqual(h.turnCalls.length, 0, 'an incompatible Core must receive no /chat/stream request');
  // No content of any kind was relayed as if the model had answered.
  assert.strictEqual(h.events.filter(e => e.channel.startsWith('kai:stream:frame')).length, 0);
  assert.strictEqual(h.events.filter(e => e.channel === 'kai:stream:end').length, 0);
  // And the failure is reported with a concrete next action.
  const error = h.events.find(e => e.channel === 'kai:stream:error');
  assert.ok(error, 'the renderer must be told the turn was refused');
  assert.match(String(error.payload), /restart the Core from the current build/i);
});

test('an UNREACHABLE Core receives no turn and is not reported as a version problem', async () => {
  const h = harness(null, { identityThrows: true });
  const result = await h.handler.handle({ requestId: 'r2', text: 'hi', send: h.send });
  assert.strictEqual(result.state, Compat.STATES.UNREACHABLE);
  assert.strictEqual(h.turnCalls.length, 0);
  const error = h.events.find(e => e.channel === 'kai:stream:error');
  assert.match(String(error.payload), /not reachable/i);
  assert.doesNotMatch(String(error.payload), /wrong KAI Core build/i);
});

test('a Core with no usable build identity receives no turn', async () => {
  const h = harness(identity({ buildId: 'unknown' }));
  const result = await h.handler.handle({ requestId: 'r3', text: 'hi', send: h.send });
  assert.strictEqual(result.state, Compat.STATES.UNKNOWN_BUILD);
  assert.strictEqual(h.turnCalls.length, 0);
});

test('a wrong protocol version receives no turn', async () => {
  const h = harness(identity({ protocolVersion: 9 }));
  const result = await h.handler.handle({ requestId: 'r4', text: 'hi', send: h.send });
  assert.strictEqual(result.state, Compat.STATES.PROTOCOL_MISMATCH);
  assert.strictEqual(h.turnCalls.length, 0);
});

test('a malformed identity response receives no turn', async () => {
  const h = harness({ service: 'not-kai' });
  const result = await h.handler.handle({ requestId: 'r5', text: 'hi', send: h.send });
  assert.strictEqual(result.state, Compat.STATES.MALFORMED);
  assert.strictEqual(h.turnCalls.length, 0);
});

test('a missing gate fails closed instead of sending', async () => {
  const { events, send } = recorder();
  const handler = createCoreStreamHandler({ gate: null, resolveBase: () => 'http://core.test', fetchImpl: async () => { throw new Error('must not be called'); } });
  const result = await handler.handle({ requestId: 'r6', text: 'hi', send });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.state, 'no-gate');
  assert.match(String(events.find(e => e.channel === 'kai:stream:error').payload), /cannot verify/i);
});

// ── The permitted path still works ───────────────────────────────────────────────
test('the expected Core receives the turn and its frames are relayed', async () => {
  const h = harness(identity());
  const result = await h.handler.handle({ requestId: 'r7', text: 'hello', send: h.send });

  assert.strictEqual(result.ok, true);
  // Exactly one turn request, addressed to the streaming endpoint, carrying only text.
  assert.strictEqual(h.turnCalls.length, 1);
  assert.strictEqual(h.turnCalls[0].url, 'http://core.test/chat/stream');
  assert.deepStrictEqual(JSON.parse(h.turnCalls[0].init.body), { text: 'hello' });
  // The frames reached the renderer, and the stream ended cleanly.
  assert.strictEqual(h.events.filter(e => e.channel === 'kai:stream:frame').length, 2);
  assert.strictEqual(h.events.filter(e => e.channel === 'kai:stream:end').length, 1);
});

test('an empty turn is refused before any check or request', async () => {
  const h = harness(identity());
  await h.handler.handle({ requestId: 'r8', text: '   ', send: h.send });
  assert.strictEqual(h.identityCalls.length, 0);
  assert.strictEqual(h.turnCalls.length, 0);
  assert.strictEqual(h.events[0].payload, 'nothing to send');
});

test('a transport failure AFTER a valid verdict is reported as unreachable, not as stale', async () => {
  const h = harness(identity(), { turnThrows: true });
  const result = await h.handler.handle({ requestId: 'r9', text: 'hello', send: h.send });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.state, 'transport');
  const error = h.events.find(e => e.channel === 'kai:stream:error');
  assert.match(String(error.payload), /unreachable/i);
  // It still tried, because the Core WAS the expected build at check time.
  assert.strictEqual(h.turnCalls.length, 1);
});

test('Retry after the Core becomes compatible lets the turn through', async () => {
  // First turn: an older Core answers /identity. Second: the expected Core does.
  let which = 'old';
  const { events, send } = recorder();
  const turnCalls = [];
  const gate = Compat.createCoreGate({
    expectation: EXPECTED,
    base: 'http://core.test',
    ttlMs: 0,
    fetchImpl: async () => ({ status: 200, json: async () => (which === 'old' ? identity({ buildId: 'b09ebd4986998b13' }) : identity()) }),
  });
  const handler = createCoreStreamHandler({
    gate,
    resolveBase: () => 'http://core.test',
    fetchImpl: async (url, init) => { turnCalls.push(url); return sseResponse(['data:{"delta":"ok"}\n\n']); },
  });

  const refused = await handler.handle({ requestId: 'a', text: 'hi', send });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(turnCalls.length, 0);

  which = 'new'; // the operator restarted the Core from the current build
  const allowed = await handler.handle({ requestId: 'b', text: 'hi', send });
  assert.strictEqual(allowed.ok, true, 'Retry must recover once a compatible Core is available');
  assert.strictEqual(turnCalls.length, 1);
  assert.strictEqual(events.filter(e => e.channel === 'kai:stream:end').length, 1);
});

// ── Stopping a turn ────────────────────────────────────────────────────────────
//
// The renderer holds an AbortController per turn (chat.js), but the main-process
// proxy used to ignore it: pressing Stop left the Core request (and any tool it was
// running) alive. These tests pin the cancellation contract.

const raceTimeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('turn did not settle')), ms));

test('a stopped turn aborts the Core request and reports no error', async () => {
  let sawSignal = null;
  const fetchImpl = (url, init) => {
    sawSignal = init && init.signal;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          }),
        }),
      },
    });
  };
  const gate = { checkTurn: async () => ({ allowed: true }) };
  const { events, send } = recorder();
  const handler = createCoreStreamHandler({ gate, fetchImpl, resolveBase: () => 'http://core.test' });
  const controller = new AbortController();
  const turn = handler.handle({ text: 'hi', send, signal: controller.signal });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sawSignal, 'the fetch received a signal');
  controller.abort();
  const result = await Promise.race([turn, raceTimeout(800)]);
  assert.strictEqual(result.state, 'aborted');
  assert.strictEqual(events.some((event) => event.channel === 'kai:stream:error'), false, 'an abort is not a failure');
  assert.strictEqual(sawSignal.aborted, true);
});

test('an already-stopped turn never reaches Core', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }; };
  const gate = { checkTurn: async () => ({ allowed: true }) };
  const { events, send } = recorder();
  const handler = createCoreStreamHandler({ gate, fetchImpl, resolveBase: () => 'http://core.test' });
  const controller = new AbortController();
  controller.abort();
  const result = await handler.handle({ text: 'hi', send, signal: controller.signal });
  assert.strictEqual(result.state, 'aborted');
  assert.strictEqual(calls, 0, 'no request is made for a turn already stopped');
  assert.strictEqual(events.some((event) => event.channel === 'kai:stream:error'), false);
});

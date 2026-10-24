'use strict';
/**
 * core-stream.js — the ONE place a KAI2 turn is proxied to Core, and the ONE place a
 * turn is refused.
 *
 * ── Why this is a module and not inline in main.js
 * The compatibility check is only worth anything if a turn cannot get past it. Putting
 * the gate and the fetch in the same small function makes the property testable: give it
 * a fake `fetch` and it either calls it (compatible) or does not (refused). A check that
 * lives in the UI, or that is applied after the request was already sent, is not a gate.
 *
 * ── What it guarantees
 * - An incompatible Core is refused BEFORE any request is made. No `/chat/stream` call
 *   happens, so the incompatible Core never performs work on the user's behalf.
 * - Transport failures after that are reported as failures; they are never rendered as a
 *   reply, and never silently swallowed.
 * - The renderer only ever receives frames; it never holds a Core URL it could be tricked
 *   into sending elsewhere.
 */

const Compat = require('./core-compat');

/** How long Core may take to ANSWER a turn request before the turn is failed. */
const CONNECT_TIMEOUT_MS = 30000;

/**
 * @param options.gate      a core-compat `createCoreGate()` instance (the authority)
 * @param options.fetchImpl injected for tests; defaults to global fetch
 * @param options.resolveBase returns the Core base URL for a turn (env override folded
 *                            in by the caller, so there is one place that knows it)
 */
function createCoreStreamHandler(options) {
  const opts = options || {};
  const gate = opts.gate;
  const doFetch = opts.fetchImpl || fetch;
  const resolveBase = typeof opts.resolveBase === 'function' ? opts.resolveBase : () => '';

  /**
   * Handle one turn. `send(channel, payload)` is the transport back to the renderer; it is
   * injected so the blocked-fetch property can be asserted without Electron.
   */
  async function handle(request) {
    const req = request || {};
    const send = typeof req.send === 'function' ? req.send : () => {};
    const text = req.text;
    /** The renderer's Stop. Forwarded to fetch so Core's request is really cut. */
    const signal = req.signal;

    if (typeof text !== 'string' || text.trim().length === 0) {
      send('kai:stream:error', 'nothing to send');
      return { ok: false, state: 'empty' };
    }

    // The renderer's chosen thinking level, if it named one. Validated here as well
    // as in Core so a malformed value is refused BEFORE the turn is spent, and never
    // forwarded as an unrecognised field.
    const thinking =
      req.thinking === 'instant' || req.thinking === 'low' || req.thinking === 'high' || req.thinking === 'max'
        ? req.thinking
        : undefined;

    if (!gate || typeof gate.checkTurn !== 'function') {
      // Fail closed. A missing gate must not become an open door.
      send('kai:stream:error', 'KAI2 cannot verify the KAI Core build (no compatibility gate is configured).');
      return { ok: false, state: 'no-gate' };
    }

    // ── The gate ────────────────────────────────────────────────────────────────
    // Nothing below this line may run unless the running Core is the build KAI2 expects.
    const turn = await gate.checkTurn();
    if (!turn.allowed) {
      send('kai:stream:error', Compat.describeVerdict(turn.verdict));
      return { ok: false, state: turn.verdict && turn.verdict.state, verdict: turn.verdict };
    }

    // Stopped before it began: do not spend a model request on it.
    if (signal !== undefined && signal.aborted) {
      return { ok: false, state: 'aborted' };
    }

    const base = String(resolveBase() || '').replace(/\/+$/, '');
    let res;
    try {
      res = await doFetch(base + '/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(thinking !== undefined ? { text, thinking } : { text }),
        // Stop must reach Core. Without a signal the request ran to completion
        // and kept spending the model after the owner had already stopped the
        // turn — the UI said "stopped" while Core carried on working.
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      // The Core answered /identity a moment ago but not now: report the real reason. It
      // is deliberately NOT retried as a compatibility problem — the verdict was valid.
      send('kai:stream:error', 'KAI Core is unreachable at ' + base);
      return { ok: false, state: 'transport', error: String(err && err.message ? err.message : err) };
    }

    if (!res.ok) {
      send('kai:stream:error', 'KAI Core refused the turn: HTTP ' + res.status);
      return { ok: false, state: 'http-' + res.status };
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      send('kai:stream:error', 'KAI Core returned no readable stream.');
      return { ok: false, state: 'no-body' };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        buffer += decoder.decode(step.value, { stream: true });
        for (let boundary = buffer.indexOf('\n\n'); boundary !== -1; boundary = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith('data:')) send('kai:stream:frame', frame.slice(5).trim());
        }
      }
      // A server that closes without a final blank line leaves the last frame —
      // the terminal `done` — sitting in the buffer, where it used to be dropped.
      // Flushed here so the turn always ends on a real terminal event.
      for (const frame of (buffer + decoder.decode()).split('\n\n')) {
        if (frame.startsWith('data:')) send('kai:stream:frame', frame.slice(5).trim());
      }
    } catch (err) {
      // A stop is not a failure: the owner asked for it, so it is reported as
      // `aborted` rather than as an error the UI would show as a fault.
      if (err && err.name === 'AbortError') {
        return { ok: false, state: 'aborted' };
      }
      send('kai:stream:error', 'KAI Core stream failed: ' + String(err && err.message ? err.message : err));
      return { ok: false, state: 'stream', error: String(err && err.message ? err.message : err) };
    }
    send('kai:stream:end', null);
    return { ok: true, state: 'streamed' };
  }

  return { handle };
}

module.exports = { createCoreStreamHandler };

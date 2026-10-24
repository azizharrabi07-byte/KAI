'use strict';
/**
 * kai-bridge.test.js — what the bridge actually SENDS to KAI Core.
 *
 * The bridge is a browser IIFE, so it is loaded here against a minimal `window` stub. The
 * test that matters is the app-note one: OpenGhost appends "notes" AFTER the user's turn as
 * `role:'user'` messages beginning "This note comes from the app, not from the user:". The
 * bridge used to take the LAST user message, so it sent the note and dropped the question —
 * the model then answered "I don't have the tools needed to process the note you've
 * provided". This suite pins the corrected behaviour.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const APP_STATE_NOTE =
  'This note comes from the app, not from the user: the day and the permission mode, as they stand from here on.\nToday is Thursday.';

/** Load the bridge into a fresh stub environment and return handles for assertions. */
function loadBridge(options = {}) {
  const sent = [];
  const compat = { calls: 0 };
  const frames = options.frames || [{ delta: 'ok' }, { done: true }];

  const fakeWindow = {
    openghost: {
      kai: {
        compat: {
          check: async () => {
            compat.calls += 1;
            return { ok: true, state: 'compatible', detail: { buildId: 'test', protocolVersion: 1 } };
          },
          status: async () => null,
        },
        stream: options.stream || ((text, handlers) => {
          sent.push(text);
          // Behave like a healthy Core: emit the scenario's frames, then end. A function
          // is asked per call, so a test can give each turn its own events.
          const list = typeof frames === 'function' ? frames(sent.length - 1) : frames;
          for (const frame of list) handlers.onFrame(JSON.stringify(frame));
          handlers.onEnd();
        }),
      },
    },
    Providers: {},
    Settings: function Settings() {},
    KAI2_CORE_URL: 'http://127.0.0.1:8788',
  };
  if (options.activity) fakeWindow.KAI2Activity = options.activity;
  fakeWindow.Settings.prototype.configFor = () => ({ provider: 'kai', ready: true });
  fakeWindow.window = fakeWindow;

  const fakeDocument = {
    getElementById: () => null,
    createElement: () => ({ style: {}, dataset: {}, appendChild() {}, addEventListener() {}, querySelector: () => null, setAttribute() {} }),
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  };

  const saved = { window: global.window, document: global.document, localStorage: global.localStorage };
  global.window = fakeWindow;
  global.document = fakeDocument;
  global.localStorage = { getItem: () => null };

  // Fresh module instance every time: the bridge patches globals on load.
  delete require.cache[require.resolve('../kai-bridge.js')];
  require(path.join('..', 'kai-bridge.js'));

  return {
    sent,
    compat,
    providers: fakeWindow.Providers,
    kai2: fakeWindow.KAI2,
    restore() {
      global.window = saved.window;
      global.document = saved.document;
      global.localStorage = saved.localStorage;
    },
  };
}

const collect = (providers, options) => {
  const deltas = [];
  return providers.stream(null, { ...options, onContent: (d) => deltas.push(d) }).then((r) => ({ r, deltas }));
};

/** An in-memory stand-in for `window.KAI2Activity`, so persistence is observable here. */
function memoryActivity() {
  const saved = new Map();
  return {
    saved,
    read: async (session) => (saved.has(session) ? JSON.parse(JSON.stringify(saved.get(session))) : []),
    save: async (session, entries) => {
      saved.set(session, JSON.parse(JSON.stringify(entries)));
    },
    clear: async (session) => {
      saved.delete(session);
    },
  };
}

/** Let fire-and-forget persistence writes land before asserting on them. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a plain user turn is sent verbatim', async () => {
  const b = loadBridge();
  try {
    const { r } = await collect(b.providers, {
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'What is 2 plus 2?' }],
    });
    assert.deepStrictEqual(b.sent, ['What is 2 plus 2?']);
    assert.match(r.content, /ok/);
    assert.deepStrictEqual(r.tool_calls, [], 'the loop must stay terminated');
  } finally {
    b.restore();
  }
});

test('an APP NOTE after the user turn is skipped, not sent as the question', async () => {
  const b = loadBridge();
  try {
    // This is the exact shape OpenGhost produces when agent mode is on.
    await collect(b.providers, {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Summarise my day' },
        { role: 'user', content: APP_STATE_NOTE },
      ],
    });
    assert.deepStrictEqual(b.sent, ['Summarise my day'], 'the note must never be sent as the user turn');
  } finally {
    b.restore();
  }
});

test('several app notes in a row are all skipped', async () => {
  const b = loadBridge();
  try {
    await collect(b.providers, {
      messages: [
        { role: 'user', content: 'Do the thing' },
        { role: 'user', content: APP_STATE_NOTE },
        { role: 'user', content: 'This message comes from the app, not from the user: the pictures your last tool calls returned, in order.' },
      ],
    });
    assert.deepStrictEqual(b.sent, ['Do the thing']);
  } finally {
    b.restore();
  }
});

test('a turn that is ONLY an app note is refused, not sent', async () => {
  const b = loadBridge();
  try {
    await assert.rejects(
      () => collect(b.providers, { messages: [{ role: 'user', content: APP_STATE_NOTE }] }),
      /nothing to send/,
    );
    assert.deepStrictEqual(b.sent, [], 'nothing may reach Core when there is no real question');
  } finally {
    b.restore();
  }
});

test('an assistant message is never mistaken for the user turn', async () => {
  const b = loadBridge();
  try {
    await collect(b.providers, {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'an earlier answer' },
        { role: 'user', content: 'second' },
      ],
    });
    assert.deepStrictEqual(b.sent, ['second']);
  } finally {
    b.restore();
  }
});

// -- Core tool events -> activity, never reply text -------------------------------
//
// Core streams `tool_event` frames for every real tool execution. They must feed the
// activity timeline and nothing else: a tool name appearing inside the assistant's
// answer is the rendering bug these tests pin.

const TOOL_START = {
  tool_event: {
    type: 'tool_start',
    toolCallId: 'call-1',
    toolId: 'filesystem.read',
    toolName: 'read_file',
    status: 'EXECUTED',
    arguments: '{"path":"C:\\\\Users\\\\DELL\\\\notes.txt"}',
    startedAt: '2026-10-19T10:00:00.000Z',
  },
};
const TOOL_DONE = {
  tool_event: {
    type: 'tool_done',
    toolCallId: 'call-1',
    invocationId: 'inv-1',
    toolId: 'filesystem.read',
    toolName: 'read_file',
    status: 'EXECUTED',
    arguments: '{"path":"C:\\\\Users\\\\DELL\\\\notes.txt"}',
    startedAt: '2026-10-19T10:00:00.000Z',
    completedAt: '2026-10-19T10:00:01.000Z',
    resultPreview: 'hello',
    resultTruncated: false,
  },
};

test('a tool event feeds activity and never the reply text', async () => {
  const b = loadBridge({ frames: [TOOL_START, { delta: 'The file says hello.' }, TOOL_DONE, { done: true }] });
  try {
    b.kai2.setSession('session-a');
    const { r } = await collect(b.providers, { messages: [{ role: 'user', content: 'read my notes' }] });
    assert.strictEqual(r.content, 'The file says hello.', 'tool metadata must not leak into the answer');
    const rows = b.kai2.activity();
    assert.strictEqual(rows.length, 1, 'start + done for one call must be one row');
    assert.strictEqual(rows[0].toolId, 'filesystem.read');
    assert.strictEqual(rows[0].phase, 'tool_done');
    assert.strictEqual(rows[0].status, 'EXECUTED');
    assert.strictEqual(rows[0].resultPreview, 'hello');
    // The same real execution now rides in the chat model's own shape: one call and one
    // result, matched by Core's toolCallId. It is NOT prose.
    assert.deepStrictEqual(r.tool_calls, [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"C:\\\\Users\\\\DELL\\\\notes.txt"}' },
      },
    ]);
    assert.deepStrictEqual(r.tool_results, [
      { tool_call_id: 'call-1', name: 'read_file', status: 'EXECUTED', phase: 'tool_done', content: 'hello' },
    ]);
    assert.doesNotMatch(r.content, /read_file/, 'the tool name must never appear in the answer');
  } finally {
    b.restore();
  }
});

test('a frame carrying a tool event AND a delta is not dropped', async () => {
  // One frame can legitimately carry both; the old early-return lost the delta and the
  // terminal `done`, truncating the answer whenever Core piggybacked an event.
  const b = loadBridge({
    frames: [
      TOOL_START,
      { tool_event: TOOL_DONE.tool_event, delta: 'The file says hello.', done: true, finish_reason: 'stop' },
    ],
  });
  try {
    b.kai2.setSession('session-a');
    const { r } = await collect(b.providers, { messages: [{ role: 'user', content: 'read my notes' }] });
    assert.strictEqual(r.content, 'The file says hello.', 'the delta in the same frame must survive');
    assert.strictEqual(r.finishReason, 'stop');
    assert.strictEqual(r.tool_calls.length, 1);
  } finally {
    b.restore();
  }
});

test('only the calls THIS turn ran become its tool records', async () => {
  const b = loadBridge({
    frames: (n) => (n === 0 ? [TOOL_START, { delta: 'ok' }, TOOL_DONE, { done: true }] : [{ delta: 'again' }, { done: true }]),
  });
  try {
    b.kai2.setSession('session-a');
    const first = await collect(b.providers, { messages: [{ role: 'user', content: 'first' }] });
    assert.strictEqual(first.r.tool_calls.length, 1);

    // A later turn in the same conversation must not replay the earlier call.
    const second = await collect(b.providers, { messages: [{ role: 'user', content: 'second' }] });
    assert.deepStrictEqual(second.r.tool_calls, [], 'an earlier turn is history, not this reply');
    assert.deepStrictEqual(second.r.tool_results, []);
    assert.strictEqual(b.kai2.activity().length, 1, 'and the timeline still holds the one real call');
  } finally {
    b.restore();
  }
});

test('a denied call is reported as a denial, never as success', async () => {
  const b = loadBridge({
    frames: [
      {
        tool_event: {
          type: 'tool_done',
          toolCallId: 'call-denied',
          toolName: 'run_command',
          status: 'DENIED',
          arguments: '{"command":"rm -rf /"}',
          error: { code: 'POLICY', message: 'the owner refused this action' },
        },
      },
      { delta: 'I could not run that.' },
      { done: true },
    ],
  });
  try {
    const { r } = await collect(b.providers, { messages: [{ role: 'user', content: 'delete it' }] });
    assert.strictEqual(r.tool_results.length, 1);
    assert.strictEqual(r.tool_results[0].status, 'DENIED');
    assert.match(r.tool_results[0].content, /^Denied:/);
    assert.doesNotMatch(r.tool_results[0].content, /^Done/);
  } finally {
    b.restore();
  }
});

test('activity is written per session and rehydrated by a later run', async () => {
  const activity = memoryActivity();
  const first = loadBridge({ activity, frames: [TOOL_START, { delta: 'ok' }, TOOL_DONE, { done: true }] });
  try {
    first.kai2.setSession('chat-abc');
    await collect(first.providers, { messages: [{ role: 'user', content: 'read' }] });
    await flush();
    assert.strictEqual(activity.saved.get('chat-abc').length, 1, 'the real call was written for its session');
    assert.strictEqual(activity.saved.has(''), false, 'nothing is written under the empty session');
  } finally {
    first.restore();
  }

  // A fresh run, as after a reload: no memory, the same store.
  const second = loadBridge({ activity });
  try {
    second.kai2.setSession('chat-abc');
    await flush();
    const rows = second.kai2.activity();
    assert.strictEqual(rows.length, 1, 'the saved call comes back exactly once');
    assert.strictEqual(rows[0].key, 'call-1');
    assert.strictEqual(rows[0].status, 'EXECUTED');
    assert.strictEqual(rows[0].resultPreview, 'hello');
  } finally {
    second.restore();
  }
});

test('history restored mid-turn is never counted as this turn’s calls', async () => {
  const activity = memoryActivity();
  // A slow read lands AFTER the turn has finished, exactly the race a reload can lose.
  // It snapshots the store when asked (like the real IPC read), then answers late.
  const read = activity.read;
  activity.read = (session) => {
    const pending = read(session);
    return new Promise((resolve) => setTimeout(() => resolve(pending), 5));
  };
  activity.saved.set('chat-abc', [
    { key: 'call-old', name: 'read_file', phase: 'tool_done', status: 'EXECUTED', resultPreview: 'old' },
  ]);
  const b = loadBridge({
    activity,
    frames: [
      { tool_event: { type: 'tool_done', toolCallId: 'call-new', toolName: 'read_file', status: 'EXECUTED', resultPreview: 'new' } },
      { delta: 'ok' },
      { done: true },
    ],
  });
  try {
    b.kai2.setSession('chat-abc');
    const { r } = await collect(b.providers, { messages: [{ role: 'user', content: 'again' }] });
    assert.deepStrictEqual(r.tool_calls.map((call) => call.id), ['call-new'], 'only the real new execution');
    // Let the deliberately slow read land before the bridge is torn down.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const ids = b.kai2.activity().map((row) => row.key);
    assert.deepStrictEqual(ids, ['call-old', 'call-new'], 'the restored row follows history into the strip');
  } finally {
    b.restore();
  }
});

test('a protected session is neither written nor read back', async () => {
  const activity = memoryActivity();
  activity.saved.set('chat-secret', [
    { key: 'call-1', toolName: 'read_file', name: 'read_file', phase: 'tool_done', status: 'EXECUTED', resultPreview: 'a secret' },
  ]);
  const b = loadBridge({ activity });
  try {
    b.kai2.setSession('chat-secret', { persist: false });
    await flush();
    assert.deepStrictEqual(b.kai2.activity(), [], 'stored activity must not surface for a sealed chat');
    assert.strictEqual(activity.saved.size, 1, 'and nothing is cleared by merely opening it locked');
  } finally {
    b.restore();
  }
});

test('a tool event with no correlation id is not shown', async () => {
  const b = loadBridge({
    frames: [
      { tool_event: { type: 'tool_start', toolName: 'read_file', status: 'EXECUTED' } },
      { delta: 'ok' },
      { done: true },
    ],
  });
  try {
    b.kai2.setSession('session-a');
    await collect(b.providers, { messages: [{ role: 'user', content: 'hi' }] });
    assert.deepStrictEqual(b.kai2.activity(), [], 'an event we cannot correlate to a call is not a row');
  } finally {
    b.restore();
  }
});

test('activity belongs to the conversation that produced it', async () => {
  const b = loadBridge({ frames: [TOOL_START, { delta: 'ok' }, { done: true }] });
  try {
    b.kai2.setSession('session-a');
    await collect(b.providers, { messages: [{ role: 'user', content: 'first' }] });
    assert.strictEqual(b.kai2.activity().length, 1);

    b.kai2.setSession('session-b');
    assert.deepStrictEqual(b.kai2.activity(), [], 'a new conversation starts with no activity');

    b.kai2.setSession('session-a');
    assert.strictEqual(b.kai2.activity().length, 1, 'the first conversation keeps its own timeline');
  } finally {
    b.restore();
  }
});

test('changing session notifies listeners with null, and unsubscribe stops delivery', async () => {
  const b = loadBridge();
  try {
    const seen = [];
    const off = b.kai2.onActivity((entry) => seen.push(entry));
    b.kai2.setSession('session-a');
    assert.deepStrictEqual(seen, [null], 'selecting a session asks listeners to re-read');
    b.kai2.setSession('session-a');
    assert.deepStrictEqual(seen, [null], 're-selecting the same session notifies nobody');
    b.kai2.setSession('session-b');
    assert.deepStrictEqual(seen, [null, null], 'null means "re-read", not "here is an event"');
    off();
    b.kai2.setSession('session-c');
    assert.deepStrictEqual(seen, [null, null], 'an unsubscribed listener hears nothing');
  } finally {
    b.restore();
  }
});

test('tool arguments and errors are bounded before they reach the timeline', async () => {
  const longArguments = 'x'.repeat(5000);
  const error = { code: 'E_TOOL', message: 'y'.repeat(2000) };
  const b = loadBridge({
    frames: [
      {
        tool_event: {
          type: 'tool_error',
          toolCallId: 'call-2',
          toolName: 'read_file',
          status: 'FAILED',
          arguments: longArguments,
          error,
        },
      },
      { delta: 'read failed' },
      { done: true },
    ],
  });
  try {
    b.kai2.setSession('session-a');
    await collect(b.providers, { messages: [{ role: 'user', content: 'hi' }] });
    const [row] = b.kai2.activity();
    assert.strictEqual(row.arguments.length, 4000);
    assert.strictEqual(row.error.message.length, 500);
    assert.strictEqual(row.error.code, 'E_TOOL');
    assert.strictEqual(row.phase, 'tool_error');
    assert.strictEqual(row.status, 'FAILED');
  } finally {
    b.restore();
  }
});

test('an approval-required event keeps the approval id it came with', async () => {
  const b = loadBridge({
    frames: [
      {
        tool_event: {
          type: 'tool_approval_required',
          toolCallId: 'call-3',
          toolName: 'write_file',
          status: 'APPROVAL_REQUIRED',
          approvalId: 'appr-9',
        },
      },
      { delta: 'waiting' },
      { done: true },
    ],
  });
  try {
    b.kai2.setSession('session-a');
    const { r } = await collect(b.providers, { messages: [{ role: 'user', content: 'write it' }] });
    const [row] = b.kai2.activity();
    assert.strictEqual(row.approvalId, 'appr-9');
    assert.strictEqual(row.status, 'APPROVAL_REQUIRED');
    // Nothing has run yet, so it is not recorded as a completed tool exchange.
    assert.deepStrictEqual(r.tool_calls, []);
    assert.deepStrictEqual(r.tool_results, []);
  } finally {
    b.restore();
  }
});

// ── The turn's authoritative text lives in the terminal frame ──────────────────
// Measured on the live Core: a research turn ran TEN browser operations, streamed
// 18 characters, then ended with `{done:true, error:'brain_unavailable',
// reply:'My own model provider isn't answering that right now — …'}`. The reply
// was never read, so the owner saw an empty answer after real work. Every case
// below must produce a non-empty reply for a turn whose answer is in `done`.

test('a done frame whose reply carries the answer is rendered, not dropped', async () => {
  const b = loadBridge({
    frames: [
      { tool_event: { id: 't1', name: 'browser_navigate', status: 'ok' } },
      { done: true, reply: 'The answer Core actually produced.' },
    ],
  });
  try {
    const { r, deltas } = await collect(b.providers, { messages: [{ role: 'user', content: 'research it' }] });
    assert.equal(r.content, 'The answer Core actually produced.');
    assert.deepEqual(deltas, ['The answer Core actually produced.']);
  } finally { b.restore(); }
});

test('streamed text is never overwritten by the terminal reply', async () => {
  const b = loadBridge({
    frames: [{ delta: 'streamed answer' }, { done: true, reply: 'a different stored answer' }],
  });
  try {
    const { r } = await collect(b.providers, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.content, 'streamed answer');
  } finally { b.restore(); }
});

test('tool events followed by an empty reply still report a real failure', async () => {
  const b = loadBridge({
    frames: [
      { tool_event: { id: 't1', name: 'browser_read', status: 'ok' } },
      { done: true },
    ],
  });
  try {
    await assert.rejects(
      () => collect(b.providers, { messages: [{ role: 'user', content: 'research' }] }),
      /without sending anything/,
      'an empty turn must fail loudly rather than render nothing',
    );
  } finally { b.restore(); }
});

// ── Stopping a turn ────────────────────────────────────────────────────────────
//
// chat.js aborts `turn.controller` on Stop. The bridge must pass that through to the
// main-process stream (which aborts the Core request), and the turn must reject as an
// AbortError — never resolve as if it answered.

test('stopping a turn cancels the main-process stream and rejects as aborted', async () => {
  let cancelCalls = 0;
  let handlers = null;
  const b = loadBridge({
    stream: (_text, h) => {
      handlers = h;
      return () => { cancelCalls += 1; };
    },
  });
  try {
    const controller = new AbortController();
    const pending = b.providers.stream(null, {
      messages: [{ role: 'user', content: 'do something long' }],
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(handlers, 'the stream started');
    controller.abort();
    // A bridge that ignores the signal would never settle: bound the wait so the
    // defect fails fast instead of hanging the suite.
    const settled = await Promise.race([
      pending.then(() => 'resolved', (error) => error),
      new Promise((r) => setTimeout(() => r('timeout'), 800)),
    ]);
    assert.ok(settled !== 'timeout', 'the aborted turn must settle');
    assert.strictEqual(settled && settled.name, 'AbortError');
    assert.strictEqual(cancelCalls, 1, 'the main-process stream was cancelled exactly once');
    assert.strictEqual(handlers, null || handlers, 'handlers captured');
  } finally {
    b.restore();
  }
});

test('a turn whose signal is already aborted never starts the stream', async () => {
  let started = 0;
  const b = loadBridge({
    stream: () => { started += 1; return () => {}; },
  });
  try {
    const controller = new AbortController();
    controller.abort();
    const settled = await Promise.race([
      b.providers.stream(null, { messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })
        .then(() => 'resolved', (error) => error),
      new Promise((r) => setTimeout(() => r('timeout'), 800)),
    ]);
    assert.ok(settled !== 'timeout', 'an already-stopped turn must settle');
    assert.strictEqual(settled && settled.name, 'AbortError');
    assert.strictEqual(started, 0, 'nothing was sent to the main process');
  } finally {
    b.restore();
  }
});

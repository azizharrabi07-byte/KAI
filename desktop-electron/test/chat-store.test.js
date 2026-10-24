'use strict';
/**
 * chat-store.test.js — the per-session record of what KAI actually did.
 *
 * `chat-store.js` exposes `window.KAI2Activity`, which the bridge writes after every real
 * tool event and reads once per conversation. These tests pin the two things that make a
 * reload honest: the record is tied to one session, and it goes through the same store as
 * the chats (or the local fallback outside Electron).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

/** Load chat-store.js against either an openghost store or a fresh localStorage stub. */
function load(options = {}) {
  const saved = { window: global.window, localStorage: global.localStorage };
  const data = new Map();
  const window = options.openghost ? { openghost: options.openghost } : {};
  global.window = window;
  global.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
  delete require.cache[require.resolve('../chat-store.js')];
  require(path.join('..', 'chat-store.js'));
  return {
    window,
    data,
    restore() {
      global.window = saved.window;
      global.localStorage = saved.localStorage;
    },
  };
}

const entry = (key, extra = {}) => ({ key, name: 'read_file', status: 'EXECUTED', resultPreview: key, ...extra });

test('activity is saved under its own session and read back', async () => {
  const loaded = load();
  try {
    const api = loaded.window.KAI2Activity;
    await api.save('chat-1', [entry('call-1')]);
    await api.save('chat-2', [entry('call-2')]);
    assert.deepStrictEqual(await api.read('chat-1'), [entry('call-1')]);
    assert.deepStrictEqual(await api.read('chat-2'), [entry('call-2')]);
    assert.deepStrictEqual(await api.read('chat-3'), [], 'an unknown chat has no activity');
  } finally {
    loaded.restore();
  }
});

test('a protected chat is cleared without touching another session', async () => {
  const loaded = load();
  try {
    const api = loaded.window.KAI2Activity;
    await api.save('chat-1', [entry('call-1')]);
    await api.save('chat-2', [entry('call-2')]);
    await api.clear('chat-1');
    assert.deepStrictEqual(await api.read('chat-1'), []);
    assert.deepStrictEqual(await api.read('chat-2'), [entry('call-2')]);
  } finally {
    loaded.restore();
  }
});

test('the stored list is bounded, and an empty save writes nothing', async () => {
  const loaded = load();
  try {
    const api = loaded.window.KAI2Activity;
    const many = Array.from({ length: 250 }, (_, i) => entry(`call-${i}`));
    await api.save('chat-1', many);
    const rows = await api.read('chat-1');
    assert.strictEqual(rows.length, 200);
    assert.strictEqual(rows[0].key, 'call-50', 'the newest 200 are kept');
    await api.save('chat-2', []);
    assert.deepStrictEqual(await api.read('chat-2'), []);
  } finally {
    loaded.restore();
  }
});

test('it uses the openghost store when the app provides one', async () => {
  const data = new Map();
  const store = {
    read: async (key) => (data.has(key) ? JSON.parse(data.get(key)) : null),
    write: async (key, value) => {
      data.set(key, JSON.stringify(value));
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
  const loaded = load({ openghost: { store } });
  try {
    const api = loaded.window.KAI2Activity;
    await api.save('chat-1', [entry('call-1')]);
    assert.ok(data.has('activity/chat-1'), 'the app store is the one written to');
    assert.deepStrictEqual(await api.read('chat-1'), [entry('call-1')]);
    await api.clear('chat-1');
    assert.strictEqual(data.has('activity/chat-1'), false);
  } finally {
    loaded.restore();
  }
});

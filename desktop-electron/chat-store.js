(() => {
'use strict';

const PREFIX = 'openghost:';

const local = {
 async read(key) {
  try { return JSON.parse(localStorage.getItem(PREFIX + key)); } catch { return null; }
 },
 async write(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
 },
 async remove(key) {
  localStorage.removeItem(PREFIX + key);
 },
};

window.ChatStore = window.openghost?.store || local;

// ── Tool activity, for the conversation that produced it ─────────────────────
//
// The bridge records every REAL Core tool execution for the open conversation. That
// record is kept on disk too, under `activity/<conversation id>`, through the same
// store as the chats — so reopening a chat after a reload shows what KAI actually did,
// not just the prose it left behind.
//
// Storage is best effort: a full disk, a locked-down store or a bad key must never
// break a turn, and the live strip keeps working from memory. A protected chat is
// never saved here; the bridge asks for that with `setSession(id, {persist:false})`.
const ACTIVITY = 'activity/';
const ACTIVITY_LIMIT = 200;

const activity = {
 async read(session) {
  if (typeof session !== 'string' || !session) return [];
  let saved;
  try { saved = await window.ChatStore.read(ACTIVITY + session); } catch { return []; }
  return Array.isArray(saved) ? saved.slice(-ACTIVITY_LIMIT) : [];
 },
 save(session, entries) {
  if (typeof session !== 'string' || !session) return Promise.resolve();
  const list = Array.isArray(entries) ? entries.slice(-ACTIVITY_LIMIT) : [];
  if (!list.length) return Promise.resolve();
  try { return Promise.resolve(window.ChatStore.write(ACTIVITY + session, list)).catch(() => {}); } catch { return Promise.resolve(); }
 },
 clear(session) {
  if (typeof session !== 'string' || !session) return Promise.resolve();
  const store = window.ChatStore;
  try { return Promise.resolve(typeof store.remove === 'function' ? store.remove(ACTIVITY + session) : null).catch(() => {}); } catch { return Promise.resolve(); }
 },
};

window.KAI2Activity = activity;
})();

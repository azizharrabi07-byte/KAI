#!/usr/bin/env node
/**
 * scripts/live-test.mjs — LIVE checks against a RUNNING KAI2 window.
 *
 * Not a unit test: it drives the packaged app over the Chrome DevTools Protocol,
 * inspects the real DOM/WebGL framebuffers, and asserts behaviour a person can see.
 * The app must be started with a debugging port:
 *
 *   dist\win-unpacked\KAI2.exe --remote-debugging-port=9222
 *   npm run test:live -- --port 9222
 *
 * Read-only by design: it creates temporary elements and removes them, it never
 * saves a character, never sends a chat turn, and restores the avatar state it
 * changes. Exit code 1 when any check fails.
 *
 * Node 22+ ships a global WebSocket, so this needs no dependency.
 */

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : Number(process.env.KAI2_CDP_PORT || 9222);
})();

const results = [];
const exceptions = [];
let ws = null;
let nextId = 1;
const pending = new Map();

function record(name, ok, detail, skipped = false) {
  results.push({ name, ok, detail, skipped });
  const label = skipped ? "SKIP" : ok ? "PASS" : "FAIL";
  console.log(`  ${label}  ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

function send(method, params = {}) {
  const id = nextId++;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(payload);
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: false,
  });
  if (response.exceptionDetails) {
    const text = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "evaluation failed";
    throw new Error(text);
  }
  return response.result.value;
}

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => {
    if (!r.ok) throw new Error(`CDP list returned ${r.status}`);
    return r.json();
  });
  const page = targets.find((t) => t.type === "page" && /index\.html/.test(t.url));
  if (!page) throw new Error(`no KAI2 page on port ${PORT}; targets: ${targets.map((t) => t.url).join(", ")}`);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id).resolve(message.result || {});
      pending.delete(message.id);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const d = message.params?.exceptionDetails;
      exceptions.push(d?.exception?.description || d?.text || "exception");
    }
    if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
      exceptions.push(message.params.entry.text);
    }
  };
  await send("Runtime.enable");
  await send("Log.enable");
  return page;
}

const IN_PAGE = `(async () => {
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const welcome = q('.welcome-flight kai-avatar');
  const K = window.KaiAvatar;
  const stage = welcome && welcome._stage;

  out.app = {
    title: document.title,
    kaiAvatar: Boolean(K && K.mirror),
    welcomeLive: Boolean(welcome && welcome.live),
    stageSize: stage ? [stage._width, stage._height] : null,
    state: stage ? stage.getState() : null,
    hidden: document.hidden,
    tabCount: document.querySelectorAll('.settings-tab').length,
    characterTab: Boolean(document.querySelector('.settings-tab[data-page="character"]')),
    characterPanel: Boolean(document.getElementById('settings-character')),
    titlebarArt: (() => { const i = document.querySelector('.titlebar-name img'); return i ? i.complete && i.naturalWidth > 0 : null; })(),
    oldGhostSvg: document.querySelectorAll('svg.glyph-kai').length,
    coreNoticeHidden: (() => { const c = document.getElementById('kai-core-compat'); return c ? c.style.display === 'none' : null; })(),
    characterSaved: (() => { try { const raw = localStorage.getItem('kai.character.v1'); return raw ? JSON.parse(raw).version : null; } catch { return 'unreadable'; } })(),
    chatRows: document.querySelectorAll('.chat-row').length,
    composerPresent: Boolean(document.querySelector('.composer-input')),
    avatarElements: document.querySelectorAll('kai-avatar').length,
    liveStages: [...document.querySelectorAll('kai-avatar')].filter(a => a.live).length,
    savedPalette: (() => { try { const raw = localStorage.getItem('kai.character.v1'); return raw ? JSON.parse(raw).palette.tip : null; } catch { return null; } })(),
    welcomePalette: (() => { const w = document.querySelector('.welcome-flight kai-avatar'); return w ? w.getConfig().palette.tip : null; })(),
  };

  const glMargins = (el) => {
    const s = el._stage;
    if (!s) return { error: 'no stage' };
    s.setPaused(true);
    s.renderStill();
    const gl = s.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (buf[(y * w + x) * 4 + 3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    s.setPaused(false);
    return { box: [w, h], margins: { left: minX, right: w - 1 - maxX, bottom: minY, top: h - 1 - maxY } };
  };

  // 1. The welcome frames the WHOLE character (the reported bug).
  if (stage) out.welcomeFrame = glMargins(welcome);

  // 2. Framing across aspect ratios and coat lengths, on a throwaway stage.
  const probe = document.createElement('kai-avatar');
  probe.setAttribute('source', '');
  probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:256px;height:256px;pointer-events:none';
  document.body.append(probe);
  probe.resume();
  out.frames = [];
  for (const [fur, w, h, label] of [[0.22,256,280,'0.91/0.22'],[0.43,256,280,'0.91/0.43'],[0.62,256,280,'0.91/0.62'],[0.43,256,256,'1.0/0.43'],[0.43,512,256,'1.7/0.43']]) {
    probe.setConfig(K.withFurValue(probe.getConfig(), 'length', fur));
    probe.style.width = w + 'px'; probe.style.height = h + 'px';
    await sleep(350);
    const m = glMargins(probe);
    out.frames.push({ label, ...m, pass: m.margins && m.margins.left > 0 && m.margins.right > 0 && m.margins.bottom > 0 && m.margins.top > 0 });
  }
  probe.remove();

  // 3. The launch splash shows the whole character (crop only for face marks).
  const splash = document.createElement('ghost-thinking');
  splash.style.cssText = 'position:fixed;top:40px;left:40px;width:112px;height:112px;z-index:99999';
  document.body.append(splash);
  await sleep(200);
  // rAF is throttled while the window is occluded; ask for the frame explicitly.
  K.mirror.flush();
  await sleep(100);
  out.splashMirror = (() => {
    const c = splash.shadowRoot.querySelector('canvas');
    if (!c || !c.width) return { error: 'no canvas' };
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, opaque = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 8) { opaque++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    return { canvas: [c.width, c.height], opaque, margins: { left: minX, right: c.width - 1 - maxX, bottom: minY, top: c.height - 1 - maxY } };
  })();
  splash.remove();

  // 4. A status-size mark still paints the face.
  const mark = document.createElement('ghost-thinking');
  mark.style.cssText = 'position:fixed;top:40px;left:200px;width:30px;height:33px;z-index:99999';
  document.body.append(mark);
  await sleep(200);
  K.mirror.flush();
  await sleep(100);
  out.markMirror = (() => {
    const c = mark.shadowRoot.querySelector('canvas');
    if (!c || !c.width) return { error: 'no canvas' };
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
    return { canvas: [c.width, c.height], opaque, mirroring: Boolean(mark.mirroring) };
  })();
  mark.remove();

  // 5. The shared source pauses when no mark is visible.
  await sleep(500);
  const src = document.querySelector('body > kai-avatar[source]');
  out.sourcePaused = src && src._stage ? src._stage._paused : null;

  // 6. Real state signals, and one-shots that do not restart.
  if (stage) {
    const before = window.KaiCharacterState ? window.KaiCharacterState.current : null;
    const dispatch = (state) => document.dispatchEvent(new CustomEvent('kai:character-state', { detail: { state } }));
    dispatch('thinking'); await sleep(200);
    const thinking = stage.getState();
    dispatch('working'); await sleep(200);
    const working = stage.getState();
    dispatch('success'); await sleep(250);
    const p1 = stage.controller.getActionProgress();
    dispatch('success'); await sleep(120);
    const p2 = stage.controller.getActionProgress();
    out.states = { thinking, working, oneShotRestarted: p2 < p1, action: stage.controller.getCurrentAction() };
    if (before) dispatch(before);
    await sleep(200);
    out.states.restored = stage.getState();
  }

  // 6b. The real state driver: typing addresses KAI, clearing returns to idle.
  const composer = document.querySelector('.composer-input');
  if (composer && window.KaiCharacterState) {
    const had = composer.value;
    composer.value = 'ping'; composer.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(250);
    const listening = window.KaiCharacterState.current;
    const avatarListening = stage ? stage.getState() : null;
    composer.value = had; composer.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    out.composer = { listening, avatarListening, after: window.KaiCharacterState.current };
  }

  // 6c. Tabs actually switch panels.
  document.querySelector('.sidebar-settings').dispatchEvent(new CustomEvent('settings-open', { bubbles: true, composed: true }));
  const settingsDialog = document.querySelector('dialog.settings');
  out.tabSwitch = [];
  for (const page of ['general', 'providers', 'usage', 'appearance', 'character']) {
    settingsDialog.querySelector('.settings-tab[data-page="' + page + '"]').click();
    await sleep(120);
    const panel = settingsDialog.querySelector('.settings-panel[data-page="' + page + '"]');
    out.tabSwitch.push({ page, visible: panel ? !panel.hidden : false });
  }
  settingsDialog.close();

  // 6d. The guarded store IPC still round-trips (settings/chats use it), and the
  // arbitrary-path reveal capability is gone.
  out.store = await (async () => {
    try {
      const key = 'live-check/probe';
      await window.openghost.store.write(key, { ok: true });
      const read = await window.openghost.store.read(key);
      await window.openghost.store.remove(key);
      const after = await window.openghost.store.read(key);
      return { read, removed: after === null };
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) };
    }
  })();
  out.revealGone = typeof window.openghost.revealFolder === 'undefined';

  // 7. Character Studio opens, previews, and discards without saving.
  const savedRaw = localStorage.getItem('kai.character.v1');
  document.querySelector('.sidebar-settings').dispatchEvent(new CustomEvent('settings-open', { bubbles: true, composed: true }));
  const dialog = document.querySelector('dialog.settings');
  dialog.querySelector('.settings-tab[data-page="character"]').click();
  await sleep(600);
  const panel = document.getElementById('settings-character');
  const preview = panel.querySelector('kai-avatar');
  const savedStyle = preview.getConfig().furStyle;
  const styleButton = panel.querySelector('.character-style[data-style="curly"]');
  styleButton.click();
  await sleep(400);
  out.studio = {
    open: dialog.open,
    previewLive: preview.live,
    style: preview.getConfig().furStyle,
    dirty: panel.querySelector('.character-summary').textContent.includes('unsaved'),
    savedUnchanged: localStorage.getItem('kai.character.v1') === savedRaw,
    savedStyle,
  };
  panel.querySelector('[data-action="revert"]').click();
  await sleep(200);
  out.studio.revertedStyle = preview.getConfig().furStyle;
  dialog.close();
  await sleep(500);
  out.studio.previewPaused = preview._stage ? preview._stage._paused || !preview._stage._running : null;

  return out;
})()`;

async function main() {
  console.log(`KAI2 live checks — CDP ${PORT}\n`);
  let page;
  try {
    page = await connect();
  } catch (error) {
    console.error(`Cannot reach KAI2: ${error.message}`);
    console.error('Start the app with --remote-debugging-port=9222 and try again.');
    process.exit(2);
  }
  console.log(`  target: ${page.url}\n`);

  // Timers and requestAnimationFrame are throttled in a hidden/occluded window, which
  // would make every wait in the page stall. The checks need the real, visible window.
  const visible = await evaluate("({ hidden: document.hidden, visibility: document.visibilityState })");
  if (visible.hidden) {
    record("window is visible", false, "KAI2 is minimized or fully occluded — restore its window and rerun (timers are throttled while hidden)");
    finish();
    return;
  }
  record("window is visible", true, visible.visibility);

  let data;
  try {
    data = await evaluate(IN_PAGE);
  } catch (error) {
    record("page evaluation", false, error.message);
    finish();
    return;
  }

  const app = data.app || {};
  record("app is the current build", app.kaiAvatar === true, app.kaiAvatar ? "window.KaiAvatar.mirror present" : "mirror API missing");
  record("welcome avatar is live", app.welcomeLive === true, app.stageSize);
  record("welcome state readable", typeof app.state === "string", app.state);
  record("Core contract accepted", app.coreNoticeHidden !== false, app.coreNoticeHidden === false ? "compat notice is VISIBLE" : "no refusal notice");
  record("titlebar uses the new art", app.titlebarArt === true, app.titlebarArt === true ? "image loaded" : "image missing");
  record("no old ghost SVG", app.oldGhostSvg === 0, `${app.oldGhostSvg} left`);
  record("five settings tabs", app.tabCount === 5, `${app.tabCount} tabs`);
  record("Character tab + panel exist", app.characterTab === true && app.characterPanel === true, "");
  record("saved character readable", app.characterSaved === null || app.characterSaved === 1, app.characterSaved === null ? "nothing saved yet" : `schema v${app.characterSaved}`);
  record("chat list renders", app.chatRows > 0, `${app.chatRows} rows`);
  record("composer present", app.composerPresent === true, "");
  record("avatar budget (≤4 elements, ≤3 live stages)", app.avatarElements <= 4 && app.liveStages <= 3, `${app.avatarElements} elements, ${app.liveStages} live`);
  record("welcome wears the saved palette", app.savedPalette === null || app.savedPalette === app.welcomePalette, `${app.welcomePalette} (saved ${app.savedPalette})`);

  const wf = data.welcomeFrame || {};
  const m = wf.margins || {};
  const whole = m.left > 0 && m.right > 0 && m.bottom > 0 && m.top > 0;
  record("welcome frames the whole character", whole, m);

  let framesOk = true;
  for (const f of data.frames || []) {
    if (!f.pass) framesOk = false;
    record(`framing ${f.label}`, f.pass === true, f.margins);
  }
  if (!data.frames) record("framing across aspects", false, "no frames returned");

  const splash = data.splashMirror || {};
  const sm = splash.margins || {};
  const splashWhole = splash.opaque > 0 && sm.left > 0 && sm.right > 0 && sm.bottom > 0 && sm.top > 0;
  record("splash shows the whole character", splashWhole, splash.error || { opaque: splash.opaque, margins: sm });

  const mark = data.markMirror || {};
  record("status mark paints the face", mark.opaque > 0, mark.error || mark);

  record("shared source pauses with no marks", data.sourcePaused === true, data.sourcePaused === true ? "paused" : `paused=${data.sourcePaused}`);

  const st = data.states || {};
  record("thinking state applied", st.thinking === "thinking", st.thinking);
  record("working state applied", st.working === "working", st.working);
  record("one-shot did not restart on a repeated state", st.oneShotRestarted === false, st.action);
  record("avatar returned to the app's state", typeof st.restored === "string", st.restored);

  const comp = data.composer || {};
  record("composer typing = listening (real driver)", comp.listening === "listening", `${comp.listening} → avatar ${comp.avatarListening}`);
  record("clearing returns to idle", comp.after === "idle", comp.after);

  record("store IPC round-trips (write/read/remove)", data.store && data.store.read && data.store.read.ok === true && data.store.removed === true, data.store);
  record("arbitrary-path reveal removed", data.revealGone === true, data.revealGone === true ? "not exposed" : "still exposed");

  const tabs = data.tabSwitch || [];
  record("settings tabs switch", tabs.length === 5 && tabs.every(t => t.visible), tabs);

  const studio = data.studio || {};
  record("Character Studio opens", studio.open === true, "");
  record("studio preview is live", studio.previewLive === true, "");
  record("style change previews", studio.style === "curly", studio.style);
  record("draft marked unsaved", studio.dirty === true, "");
  record("preview does not save", studio.savedUnchanged === true, "");
  record("discard restores the saved style", studio.revertedStyle === studio.savedStyle, `${studio.revertedStyle} (saved: ${studio.savedStyle})`);
  record("studio preview pauses when closed", studio.previewPaused === true, `${studio.previewPaused}`);

  record("no page exceptions", exceptions.length === 0, exceptions.slice(0, 3));
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed} passed, ${failed.length} failed, ${results.length} checks`);
  try { ws?.close(); } catch {}
  process.exit(failed.length ? 1 : 0);
}

main();

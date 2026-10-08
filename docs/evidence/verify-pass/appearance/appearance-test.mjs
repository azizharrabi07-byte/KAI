// appearance-test.mjs — the LIVE appearance evidence for KAI.
//
//   node appearance-test.mjs change   # drive the product UI, capture before/after
//   node appearance-test.mjs verify   # after a real restart: read what persisted
//
// What this pins, against the packaged app (island exactly
// http://tauri.localhost/ on the WebView2 debug port):
//
//   change phase
//     (a) the baseline appearance is read FROM THE ISLAND via the app's own
//         `window.__kaiAppearance()` hook, and its orb canvas is saved as a PNG;
//     (b) the settings window is opened with the app's own command, and the
//         appearance is changed by driving the REAL controls (the KAI-Coder
//         preset button and the skin/outfit <select>s) — a product-UI action,
//         not a direct write to the store;
//     (c) the island's appearance changes without a restart and a SECOND orb
//         canvas PNG is saved.
//
//   verify phase
//     the island, freshly launched after killing the process, reports the same
//     appearance the UI selected — i.e. the choice survived a restart.
//
// The appearance is NEVER read from a value the harness set itself: every read is
// `window.__kaiAppearance()` (what the island actually applied) or the saved PNG.

import { writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";

const CDP = process.env.KAI_CDP ?? "http://127.0.0.1:9222";
const ISLAND_URL = "http://tauri.localhost/";
const SETTINGS_URL = "http://tauri.localhost/settings.html";
const PHASE = process.argv[2] ?? "change";
const OUT = "appearance-test-results.json";
const ONEPX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

// ── CDP plumbing ──────────────────────────────────────────────────────────────
async function connect(url) {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const target = list.find((t) => t.type === "page" && t.url === url);
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
    return r.result.value;
  };
  const shot = async (name) => {
    try {
      const r = await send("Page.captureScreenshot", { format: "png" });
      if (r?.data) { writeFileSync(name, Buffer.from(r.data, "base64")); return name; }
    } catch (e) { say("(screenshot failed:", String(e).slice(0, 80), ")"); }
    return null;
  };
  return { ws, send, ev, shot, close: () => ws.close() };
}

/** Save the island orb canvas as PNG; returns the file or null. */
async function saveOrb(island, name) {
  const data = await island.ev("(() => { const c = document.getElementById('bot-canvas'); return c ? c.toDataURL('image/png') : null; })()");
  if (!data || data.length < 100) return null;
  writeFileSync(name, Buffer.from(data.replace(/^data:image\/png;base64,/, ""), "base64"));
  return name;
}

async function expand(island) {
  try { await island.ev("window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})"); } catch { /* */ }
}

async function findSettings(maxMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await connect(SETTINGS_URL);
    if (s) return s;
    await sleep(150);
  }
  return null;
}

// ── Boot: island must be present ──────────────────────────────────────────────
let island = await connect(ISLAND_URL);
if (!island) {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  console.error("no island page target; got", list.map((t) => t.url));
  process.exit(3);
}
await expand(island);
await sleep(400);

const results = { generatedAt: new Date().toISOString(), phase: PHASE, islandUrl: ISLAND_URL };

if (PHASE === "reset") {
  // Put KAI back to the default via the REAL preset button, so the change phase
  // starts from a known, distinct baseline on a re-run.
  await island.ev("window.__TAURI_INTERNALS__.invoke('open_settings_window')");
  const settings = await findSettings();
  if (!settings) { say("FAIL: no settings window"); process.exit(4); }
  await sleep(800);
  const clicked = await settings.ev(`(() => { const b = document.querySelector('[data-preset="kai"]'); if (!b) return null; b.click(); return b.textContent; })()`);
  say("reset clicked:", clicked);
  await sleep(600);
  let v = null;
  for (let i = 0; i < 16; i++) {
    await expand(island);
    v = await island.ev("window.__kaiAppearance ? window.__kaiAppearance() : null");
    if (v && v.skin === "blue" && v.accessory === "none") break;
    await sleep(250);
  }
  say("island appearance after reset:", JSON.stringify(v));
  results.afterReset = { variant: v };
  settings.close();
} else if (PHASE === "change") {
  // ── (a) baseline read from the island itself ──
  const before = await island.ev("window.__kaiAppearance ? window.__kaiAppearance() : null");
  const beforePng = await saveOrb(island, "appearance-01-before-orb.png");
  const beforeIsland = await island.shot("appearance-01-before-island.png");
  say("baseline island appearance:", JSON.stringify(before), "->", beforePng);

  // ── (b) open the settings window with the app's own command, drive the UI ──
  await island.ev("window.__TAURI_INTERNALS__.invoke('open_settings_window')");
  const settings = await findSettings();
  if (!settings) { say("FAIL: settings window never appeared on CDP"); process.exit(4); }
  await sleep(800);

  const controls = await settings.ev(`(() => ({
    preset: !!document.querySelector('[data-preset="kai-coder"]'),
    skin: !!document.querySelector('[data-role="appearance-skin"]'),
    theme: !!document.querySelector('[data-role="appearance-theme"]'),
    outfit: !!document.querySelector('[data-role="appearance-accessory"]'),
    heading: !!([...document.querySelectorAll('h2 span')].find((s) => s.textContent === "KAI's appearance")),
  }))()`);
  say("settings controls present:", JSON.stringify(controls));

  // Drive the REAL preset button (KAI-Coder: yellow skin / sun theme / cap outfit),
  // then nudge the skin and outfit selects to prove the controls themselves work.
  const clicked = await settings.ev(`(() => {
    const b = document.querySelector('[data-preset="kai-coder"]');
    if (!b) return null;
    b.click();
    return b.textContent;
  })()`);
  say("clicked preset:", clicked);
  await sleep(300);

  const setSel = async (role, value) => settings.ev(`(() => {
    const s = document.querySelector('[data-role="${role}"]');
    if (!s) return null;
    s.value = ${JSON.stringify(value)};
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return s.value;
  })()`);
  const skinSet = await setSel("appearance-skin", "yellow");
  const outfitSet = await setSel("appearance-accessory", "cap");
  say("set skin ->", skinSet, " outfit ->", outfitSet);
  await sleep(600);

  const stored = await settings.ev("localStorage.getItem('kai.appearance.v1')");
  say("settings localStorage kai.appearance.v1:", stored);

  // ── (c) the island changes WITHOUT a restart ──
  let after = null;
  for (let i = 0; i < 20; i++) {
    await expand(island);
    after = await island.ev("window.__kaiAppearance ? window.__kaiAppearance() : null");
    if (after && after.skin === "yellow" && after.accessory === "cap") break;
    await sleep(250);
  }
  await sleep(500);
  const afterPng = await saveOrb(island, "appearance-02-after-orb.png");
  const afterIsland = await island.shot("appearance-02-after-island.png");
  say("island appearance after UI change (no restart):", JSON.stringify(after), "->", afterPng);

  const changed = !!before && !!after && (before.skin !== after.skin || before.accessory !== after.accessory);
  const applied = after && after.skin === "yellow" && after.accessory === "cap";
  const distinctPngs = beforePng && afterPng && !readFileSync(beforePng).equals(readFileSync(afterPng));

  Object.assign(results, {
    baseline: { variant: before, orbPng: beforePng, islandPng: beforeIsland },
    selected: { skin: "yellow", theme: "sun", accessory: "cap" },
    storedJson: stored,
    afterNoRestart: { variant: after, orbPng: afterPng, islandPng: afterIsland },
    checks: {
      settingsControlsFound: controls.skin && controls.theme && controls.outfit && controls.preset,
      islandChangedWithoutRestart: changed,
      islandAppliedSelection: applied,
      orbPngsDiffer: distinctPngs,
    },
  });
  say("\nCHANGE summary: settingsControlsFound=" + results.checks.settingsControlsFound +
      " changedWithoutRestart=" + changed + " appliedSelection=" + applied +
      " orbPngsDiffer=" + distinctPngs);
  settings.close();
} else if (PHASE === "verify") {
  // ── restart phase: what did the freshly launched island load? ──
  const restored = await island.ev("window.__kaiAppearance ? window.__kaiAppearance() : null");
  const restoredPng = await saveOrb(island, "appearance-03-after-restart-orb.png");
  const restoredIsland = await island.shot("appearance-03-after-restart-island.png");
  const stored = await island.ev("localStorage.getItem('kai.appearance.v1')");
  const matches = restored && restored.skin === "yellow" && restored.accessory === "cap";
  say("after restart, island appearance:", JSON.stringify(restored), "->", restoredPng);
  say("after restart, localStorage kai.appearance.v1:", stored);
  Object.assign(results, {
    afterRestart: { variant: restored, orbPng: restoredPng, islandPng: restoredIsland, storedJson: stored },
    checks: { persistedAcrossRestart: matches },
  });
  say("\nVERIFY summary: persistedAcrossRestart=" + matches);
} else {
  console.error("unknown phase", PHASE);
  process.exit(2);
}

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
writeFileSync(OUT, JSON.stringify({ ...prev, ...results }, null, 2));
appendFileSync("appearance-test-run.txt", "\n=== phase: " + PHASE + " ===\n" + log.join("\n") + "\n");
say("wrote", OUT);
island.close();

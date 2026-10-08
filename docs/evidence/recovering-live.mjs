// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * recovering-live.mjs — the NINE-POINT live chain for the RECOVERING state.
 *
 *   node docs/evidence/recovering-live.mjs <blockedMissionId>
 *
 * Runs against the REAL packaged product:
 *   • the Core the app spawned (http://127.0.0.1:8788)
 *   • the island WebView2 over CDP (http://127.0.0.1:9222, page url exactly
 *     http://tauri.localhost/)
 *
 * It reads the RUNNING renderer's own handles — `window.__kaiEngine.state`,
 * `window.__kaiEngine.renderer.pose`, `window.__kaiProbe()` — never a
 * `faceState() === "recovering"` substitution, and never a harness copy of the
 * engine. The screenshot is the real island page.
 *
 * Writes docs/evidence/recovering-live.json with the raw wire event, the renderer
 * receipt (before / after the resolution event), and the exit transition.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CORE = process.env.KAI_CORE ?? "http://127.0.0.1:8788";
const CDP = process.env.KAI_CDP ?? "http://127.0.0.1:9222";
const ISLAND_URL = "http://tauri.localhost/";
const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, "recovering-live.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

const missionId = process.argv[2];
if (!missionId) { console.error("usage: node recovering-live.mjs <blockedMissionId>"); process.exit(2); }

// ── HTTP to the Core ─────────────────────────────────────────────────────────
async function core(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(CORE + path, init);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}
const get = (p) => core("GET", p);
const post = (p, b) => core("POST", p, b ?? {});

// ── Wait for the Core the app spawned ────────────────────────────────────────
let identity = null;
for (let i = 0; i < 60; i++) {
  try { const r = await get("/identity"); if (r.status === 200) { identity = r.json; break; } } catch { /* */ }
  await sleep(500);
}
if (!identity) { console.error("Core /identity never answered"); process.exit(3); }
say("core /identity:", JSON.stringify(identity));

// ── SSE: the real event stream, exactly as a client receives it ──────────────
// Open the stream and keep it open for the whole run so the exit event is
// captured live too.
const sseController = new AbortController();
const sseRes = await fetch(`${CORE}/core/events`, { signal: sseController.signal });
if (sseRes.status !== 200) { console.error("SSE status", sseRes.status); process.exit(4); }
const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
const wire = [];              // every parsed KaiEvent, in arrival order
let buffer = "";
const readerLoop = (async () => {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          try { wire.push({ raw, event: JSON.parse(raw), at: new Date().toISOString() }); } catch { /* */ }
        }
      }
    }
  } catch { /* aborted */ }
})();

// Give the stream a moment to deliver the startup replay.
await sleep(1500);
say(`\n=== [POINT 2] the actual Core event on the wire (${wire.length} events received) ===`);
const recovery = wire.find((w) => w.event?.payload?.type === "mission.recovery_blocked")
  ?? wire.find((w) => JSON.stringify(w.event).includes("mission.recovery_blocked"));
if (!recovery) {
  say("NO mission.recovery_blocked event reached the SSE stream. Wire types seen:",
    JSON.stringify([...new Set(wire.map((w) => w.event?.type))]));
} else {
  say("  raw frame:", recovery.raw);
  say("  wire type :", recovery.event.type);
  say("  payload   :", JSON.stringify(recovery.event.payload));
  say("  nested    :", recovery.event.payload?.type);
}

// ── CDP to the real island renderer ──────────────────────────────────────────
const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((t) => t.type === "page" && t.url === ISLAND_URL);
if (!target) { console.error("no island page target; got", list.map((t) => t.url)); process.exit(5); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r && r.data) { writeFileSync(join(DIR, name), Buffer.from(r.data, "base64")); return name; }
  return null;
}
// Keep the island expanded: the frame loop that advances the orb only runs while it is.
await ev(`if(window.__charKeep)clearInterval(window.__charKeep);window.__charKeep=setInterval(()=>{try{window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})}catch(e){}},3000);'keep'`);
await ev(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})`).catch(() => {});
await sleep(600);

/** The renderer receipt: the RUNNING renderer's own state + pose + probe. */
async function receipt() {
  return await ev(`(() => ({
    engineState: (window.__kaiEngine && window.__kaiEngine.state) ?? null,
    rendererPose: (window.__kaiEngine && window.__kaiEngine.renderer && window.__kaiEngine.renderer.pose) ?? null,
    probe: (typeof window.__kaiProbe === 'function') ? window.__kaiProbe() : null,
    canvas: (()=>{const c=document.getElementById('bot-canvas');return c?{w:c.width,h:c.height}:null;})(),
  }))()`);
}

say("\n=== [POINTS 4-7] the renderer receipt (RECOVERING, before the resolution event) ===");
const before = await receipt();
say("  engineState  :", JSON.stringify(before.engineState));
say("  rendererPose :", JSON.stringify(before.rendererPose));
say("  probe.runtime:", JSON.stringify(before.probe?.runtime));
say("  probe.label  :", JSON.stringify(before.probe?.runtimeLabel));
say("  probe.conn   :", JSON.stringify(before.probe?.conn));
say("  canvas       :", JSON.stringify(before.canvas));

const orbPng = await ev(`(()=>{const c=document.getElementById('bot-canvas');return c?c.toDataURL('image/png'):null;})()`);
if (orbPng) writeFileSync(join(DIR, "recovering-orb.png"), Buffer.from(orbPng.replace(/^data:image\/png;base64,/, ""), "base64"));
const islandPng = await shot("recovering-island.png");
say("  orb png      :", orbPng ? "recovering-orb.png" : "(none)");
say("  island png   :", islandPng ?? "(none)");

// ── Point 9: the EXIT — resolve the blocked mission with a real event ────────
say("\n=== [POINT 9] the exit: POST /missions/:id/cancel on the blocked mission ===");
const cancel = await post(`/missions/${missionId}/cancel`, {});
say("  POST /missions/" + missionId + "/cancel ->", cancel.status, JSON.stringify(cancel.json));

// Capture the mission.cancelled event live on the SAME stream.
let cancelled = null;
for (let i = 0; i < 30 && !cancelled; i++) {
  cancelled = wire.find((w) => w.event?.type === "mission.cancelled");
  if (!cancelled) await sleep(200);
}
say("  mission.cancelled on the wire:", cancelled ? cancelled.raw : "(not seen)");

// Poll the renderer until it leaves RECOVERING (ERROR holds ~4 s, then IDLE).
let after = null;
for (let i = 0; i < 40; i++) {
  after = await receipt();
  if (after.engineState !== before.engineState) break;
  await sleep(150);
}
say("  after engineState  :", JSON.stringify(after.engineState));
say("  after rendererPose :", JSON.stringify(after.rendererPose));
say("  after probe.runtime:", JSON.stringify(after.probe?.runtime));
say("  after probe.label  :", JSON.stringify(after.probe?.runtimeLabel));

// ── Recovery status (the ledger the blocked verdict came from) ───────────────
const recStatus = await get("/recovery/status");
say("\nGET /recovery/status ->", recStatus.status, JSON.stringify(recStatus.json).slice(0, 400));

// ── Memory scope regression ──────────────────────────────────────────────────
const mem = await get("/memory/search?scope=bogus");
say("\nGET /memory/search?scope=bogus ->", mem.status, mem.text.slice(0, 300));

const out = {
  generatedAt: new Date().toISOString(),
  identity,
  missionId,
  points: {
    p2_wire_event: recovery ? { raw: recovery.raw, type: recovery.event.type, payload: recovery.event.payload } : null,
    p3_bridge_preserved: recovery ? { wireType: recovery.event.type, nestedType: recovery.event.payload?.type } : null,
    p4_p7_renderer_before: before,
    p9_cancel: { status: cancel.status, body: cancel.json, missionCancelledEvent: cancelled ? cancelled.raw : null, renderer_after: after },
  },
  wireTypes: [...new Set(wire.map((w) => w.event?.type))],
  wire,
  recoveryStatus: { status: recStatus.status, body: recStatus.json },
  memoryScopeBogus: { status: mem.status, body: mem.json ?? mem.text },
  log,
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
say("\nwrote", OUT);
await ev("clearInterval(window.__charKeep); 'stopped'").catch(() => {});
sseController.abort();
ws.close();
await readerLoop.catch(() => {});

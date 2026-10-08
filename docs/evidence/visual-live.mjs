// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).
//
// visual-live.mjs — the live chain for the KAI Visual Engine vertical slice.
//
//   node docs/evidence/visual-live.mjs
//
// Runs against the REAL packaged product:
//   • the Core the app spawned (http://127.0.0.1:8788)
//   • the island WebView2 over CDP (http://127.0.0.1:9222, page url exactly
//     http://tauri.localhost/)
//
// It drives the product's OWN host handle — `window.__kaiVisual.compile` — and
// reads the RUNNING renderer's own receipt (`window.__kaiVisualEngine.lastReceipt`),
// never a harness copy of the engine. It captures a real rendered screenshot and a
// real validator refusal (raw payload from the Core's HTTP boundary AND the same
// refusal through the host).
//
// Writes docs/evidence/visual-live.json with every raw capture.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CORE = process.env.KAI_CORE ?? "http://127.0.0.1:8788";
const CDP = process.env.KAI_CDP ?? "http://127.0.0.1:9222";
const ISLAND_URL = "http://tauri.localhost/";
const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, "visual-live.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

// ── HTTP to the Core ─────────────────────────────────────────────────────────
async function core(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(CORE + path, init);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const get = (p) => core("GET", p);
const post = (p, b) => core("POST", p, b ?? {});

// ── The sources the harness sends ────────────────────────────────────────────
// A real, valid visual intent: the slice's own seam, drawn.
const VALID_SOURCE = [
  "flowchart TD",
  "  model[Model output] --> compile[Core: parse]",
  "  compile --> validate{Validator}",
  "  validate -->|accept| engine[KAI Visual Engine]",
  "  validate -->|refuse| reject[400 rejection]",
  "  engine --> renderer[SVG renderer]",
  "  renderer --> screen[Real KAI UI]",
].join("\n");

// Adversarial inputs — a model could emit these; they must NOT reach the renderer.
const ADVERSARIAL_SOURCES = {
  markup_label: "A[<script>alert(1)</script>] --> B",
  unsupported_kind: "sequenceDiagram\nA->>B: hi",
  self_loop: "A --> A",
};

// ── Wait for the Core the app spawned ────────────────────────────────────────
let identity = null;
for (let i = 0; i < 90; i++) {
  try { const r = await get("/identity"); if (r.status === 200) { identity = r.json; break; } } catch { /* */ }
  await sleep(500);
}
if (!identity) { console.error("Core /identity never answered"); process.exit(3); }
say("core /identity:", JSON.stringify(identity));

// ── The raw validator boundary (HTTP), captured independently of the renderer ─
say("\n=== [RAW] POST /visual/compile — the Core validator, over HTTP ===");
const rawAccept = await post("/visual/compile", { source: VALID_SOURCE });
say("  accept ->", rawAccept.status, JSON.stringify(rawAccept.json).slice(0, 400));
const rawRejections = {};
for (const [name, source] of Object.entries(ADVERSARIAL_SOURCES)) {
  const r = await post("/visual/compile", { source });
  rawRejections[name] = { source, status: r.status, body: r.json ?? r.text };
  say(`  refuse[${name}] ->`, r.status, JSON.stringify(r.json ?? r.text));
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

// Keep the island expanded: the window must be open for a panel over it to be seen.
await ev(`if(window.__kaiKeep)clearInterval(window.__kaiKeep);window.__kaiKeep=setInterval(()=>{try{window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})}catch(e){}},3000);'keep'`);
await ev(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})`).catch(() => {});
await sleep(600);

// ── Wait for the product's host handle (mounted in main.ts) ──────────────────
let hostReady = false;
for (let i = 0; i < 40; i++) {
  hostReady = await ev(`typeof window.__kaiVisual === 'object' && window.__kaiVisual !== null && typeof window.__kaiVisual.compile === 'function'`);
  if (hostReady) break;
  await sleep(250);
}
say("\n=== [HOST] window.__kaiVisual present:", hostReady, "===");
if (!hostReady) {
  const which = await ev(`({ kaiVisual: typeof window.__kaiVisual, engine: typeof window.__kaiVisualEngine })`);
  say("  handle types:", JSON.stringify(which));
}

// ── Point A: compile a VALID intent through the real host, then read the receipt
say("\n=== [A] window.__kaiVisual.compile(<valid flow>) ===");
const compiled = await ev(`window.__kaiVisual.compile(${JSON.stringify(VALID_SOURCE)})`);
say("  compile outcome:", JSON.stringify(compiled));
await sleep(1200); // let the entrance spring settle so the screenshot shows the drawing

// The renderer's OWN receipt, read from the live engine handle — not the return value.
const engineReceipt = await ev(`(() => {
  const e = window.__kaiVisualEngine;
  return e ? { lastReceipt: e.lastReceipt, lastRejection: e.lastRejection } : null;
})()`);
say("  window.__kaiVisualEngine receipt:", JSON.stringify(engineReceipt));

// What is actually on screen: the host, its visibility, and the SVG it holds.
const dom = await ev(`(() => {
  const host = document.getElementById('kai-visual');
  if (!host) return { host: null };
  const svg = host.querySelector('svg.kai-visual-svg');
  return {
    host: { hidden: host.hidden, rect: (() => { const r = host.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() },
    svg: svg ? { width: svg.getAttribute('width'), height: svg.getAttribute('height'), viewBox: svg.getAttribute('viewBox') } : null,
    nodes: host.querySelectorAll('.kai-visual-node').length,
    edges: host.querySelectorAll('.kai-visual-edge').length,
    labels: Array.from(host.querySelectorAll('.kai-visual-label')).map((t) => t.textContent).slice(0, 12),
    textContent: host.textContent.slice(0, 300),
  };
})()`);
say("  host DOM:", JSON.stringify(dom));
const png = await shot("visual-rendered.png");
say("  screenshot:", png ?? "(none)");

// ── Point B: the adversarial inputs, through the real host ───────────────────
say("\n=== [B] window.__kaiVisual.compile(<adversarial>) — must refuse, never draw ===");
const hostRejections = {};
for (const [name, source] of Object.entries(ADVERSARIAL_SOURCES)) {
  const out = await ev(`window.__kaiVisual.compile(${JSON.stringify(source)})`);
  hostRejections[name] = out;
  say(`  refuse[${name}] ->`, JSON.stringify(out));
}
// A malformed STRUCTURED intent, straight at the renderer's guard (bypasses Core):
const structured = await ev(`window.__kaiVisual.render(${JSON.stringify({
  kind: "flow", direction: "TD",
  nodes: [{ id: "A", label: "<img onerror=alert(1)>", shape: "box" }], edges: [],
})})`);
say("  render(<malformed structured intent>) ->", JSON.stringify(structured));
const rejShot = await shot("visual-rejection.png");
say("  rejection screenshot:", rejShot ?? "(none)");

// ── Memory scope regression (the canonical scope must still list subagent) ───
const mem = await get("/memory/search?scope=bogus");
say("\nGET /memory/search?scope=bogus ->", mem.status, mem.text.slice(0, 300));

const out = {
  generatedAt: new Date().toISOString(),
  identity,
  validSource: VALID_SOURCE,
  adversarialSources: ADVERSARIAL_SOURCES,
  raw: {
    accept: { status: rawAccept.status, body: rawAccept.json ?? rawAccept.text },
    rejections: rawRejections,
  },
  host: {
    present: hostReady,
    compileValid: compiled,
    engineReceipt,
    dom,
    rejections: hostRejections,
    structuredRejection: structured,
  },
  screenshots: { rendered: png, rejection: rejShot },
  memoryScopeBogus: { status: mem.status, body: mem.json ?? mem.text },
  log,
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
say("\nwrote", OUT);
await ev("clearInterval(window.__kaiKeep); 'stopped'").catch(() => {});
ws.close();

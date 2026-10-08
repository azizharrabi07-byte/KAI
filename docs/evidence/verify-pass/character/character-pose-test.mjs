// character-pose-test.mjs — live per-ACTION evidence for the ported KAI orb.
//
//   node character-pose-test.mjs
//
// Runs against the REAL packaged product (island exactly http://tauri.localhost/
// on the WebView2 CDP port). For each source action it drives the real renderer
// and saves the orb canvas + a full-island screenshot, plus a rolling canvas hash
// so a held action can be shown to be MOVING rather than a frozen still.
//
// Two kinds of trigger, and the log says which:
//   • EVENT  — a real Core control-plane event the island turns into a character
//              state (a completed mission → SUCCESS, an approved approval →
//              WORKING). These are the states the app actually reaches.
//   • ENGINE — modes the island has no button for yet (3-D eye rig, pose-z
//              gallery, shatter). Driven through the LIVE island engine handle
//              (`window.__kaiEngine`, registered by engine.draw each frame), so
//              the render still happens in the real product — never a harness copy.
//
// A repeated-pose pass runs SUCCESS twice from two separate real missions and
// asserts the two entry frames are NOT identical.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CORE = process.env.KAI_CORE ?? "http://127.0.0.1:8788";
const CDP = process.env.KAI_CDP ?? "http://127.0.0.1:9222";
const ISLAND_URL = "http://tauri.localhost/";
const DIR = dirname(fileURLToPath(import.meta.url));
const OUT_JSON = join(DIR, "character-pose-results.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

// ── CDP ──────────────────────────────────────────────────────────────────────
const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((t) => t.type === "page" && t.url === ISLAND_URL);
if (!target) { console.error("no island page target; got", list.map((t) => t.url)); process.exit(3); }
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
async function expand() { try { await ev(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})`); } catch { /* */ } }
async function shot(name) {
  try { const r = await send("Page.captureScreenshot", { format: "png" }); if (r && r.data) { writeFileSync(join(DIR, name), Buffer.from(r.data, "base64")); return name; } } catch (e) { say("  (screenshot failed:", String(e).slice(0, 80), ")"); }
  return null;
}
async function core(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(CORE + path, init);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}
const post = (p, b) => core("POST", p, b ?? {});
const get = (p) => core("GET", p);

const HASH = `(()=>{const c=document.getElementById('bot-canvas');if(!c)return null;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let h=2166136261>>>0;for(let i=0;i<d.length;i+=13){h^=d[i];h=Math.imul(h,16777619)>>>0;}return h.toString(16).padStart(8,'0');})()`;
const PNG = `(()=>{const c=document.getElementById('bot-canvas');return c?c.toDataURL('image/png'):null;})()`;
const CANVAS = `(()=>{const c=document.getElementById('bot-canvas');return c?{w:c.width,h:c.height}:null;})()`;
const RESET = `(()=>{const e=window.__kaiEngine;if(!e)return 'no engine';e.setEyeMode3(false);e.clearGallery();e.setShatter(0,0);e.setState('IDLE',true);return 'reset';})()`;
// Keep the island expanded: the frame loop that advances the orb only runs while it is.
await ev(`if(window.__charKeep)clearInterval(window.__charKeep);window.__charKeep=setInterval(()=>{try{window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})}catch(e){}},4000);'keep'`);

await expand(); await sleep(400);
const handle = await ev("typeof window.__kaiEngine");
const canvas = await ev(CANVAS);
say("engine handle:", handle, " canvas:", JSON.stringify(canvas));
if (handle !== "object" || !canvas) { say("FAIL: no live __kaiEngine / bot-canvas"); process.exit(4); }

// ── Real Core event triggers ─────────────────────────────────────────────────
async function realMissionSuccess() {
  const r = await post("/missions", { title: "char-ok " + Date.now().toString(36), steps: [{ kind: "tool", title: "noop", target: "missions.create", input: { title: "char-nested" } }] });
  say("    [EVENT] POST /missions ->", r.status, r.json?.mission?.status);
}
async function realApprovalWorking() {
  // A capability write parks an approval; approving it publishes
  // approval.approved, which the island maps to the WORKING character state.
  const r = await post("/capabilities/computer/test", { action: "windows" });
  say("    [EVENT] POST /capabilities/computer/test ->", r.status);
  await sleep(800);
  const ap = await get("/approvals?status=PENDING");
  const pend = (ap.json?.approvals ?? [])[0];
  if (!pend) { say("    [EVENT] no parked approval"); return; }
  const d = await post(`/approvals/${pend.id}/decide`, { approved: true });
  say("    [EVENT] decide", pend.id, "->", d.status);
}

// ── Capture one action. `trigger` is always a Node-side async fn. ─────────────
async function run(name, kind, trigger, waitMs = 650, gapMs = 200, holdExpr = null) {
  await expand();
  await ev(RESET);
  await sleep(350);
  say(`\n[${name}] trigger=${kind}`);
  await trigger();
  await sleep(waitMs);
  const samples = [];
  for (let i = 0; i < 4; i++) {
    if (holdExpr) await ev(holdExpr);
    samples.push(await ev(HASH));
    await sleep(gapMs);
  }
  if (holdExpr) await ev(holdExpr);
  const png = await ev(PNG);
  const orbFile = `character-${name}-orb.png`;
  if (png) writeFileSync(join(DIR, orbFile), Buffer.from(png.replace(/^data:image\/png;base64,/, ""), "base64"));
  const islandFile = await shot(`character-${name}-island.png`);
  const distinct = new Set(samples).size;
  say(`  hashes: ${samples.join(" ")}  distinct=${distinct}  ${distinct > 1 ? "(moving)" : "(STILL)"}  -> ${orbFile}`);
  return { name, kind, samples, distinctHashes: distinct, moving: distinct > 1, orbFile, islandFile };
}

// ── The action matrix ────────────────────────────────────────────────────────
const results = [];
const coreId = await (await fetch(`${CORE}/identity`)).json().catch(() => null);
say("core /identity:", JSON.stringify(coreId));

// SUCCESS (real event) → hands raised + green rings
results.push(await run("success-hands", "EVENT mission.completed", realMissionSuccess, 700));
await sleep(1400);
// approval.approved resolves into USING_TOOL (the approval spawns a tool run),
// captured here for the real-event record.
results.push(await run("approval-toolcall", "EVENT approval.approved", realApprovalWorking, 700));
await sleep(1400);
// WORKING → laptop. Held each sample because the island re-syncs setState; the
// approval EVENT parks in USING_TOOL, so the held ENGINE state is what pins the
// `working` pose (and its laptop prop) for the capture.
results.push(await run("working-laptop", "ENGINE setState(WORKING)", async () => { await ev("window.__kaiEngine.setState('WORKING')"); }, 500, 180, "window.__kaiEngine.setState('WORKING')"));
await sleep(1400);
// WAITING → backpack. Held each sample because the island re-syncs setState.
results.push(await run("waiting-backpack", "ENGINE setState(WAITING)", async () => { await ev("window.__kaiEngine.setState('WAITING')"); }, 500, 180, "window.__kaiEngine.setState('WAITING')"));
// 3-D eye rig
results.push(await run("mode3-eyes", "ENGINE setEyeMode3(true)", async () => { await ev("window.__kaiEngine.setEyeMode3(true)"); }, 800, 220, "window.__kaiEngine.setEyeMode3(true)"));
// pose-z gallery faces
results.push(await run("gallery-S1", "ENGINE showGallery('S1')", async () => { await ev("window.__kaiEngine.showGallery('S1')"); }, 700, 220, "window.__kaiEngine.showGallery('S1')"));
results.push(await run("gallery-V15", "ENGINE showGallery('V15')", async () => { await ev("window.__kaiEngine.showGallery('V15')"); }, 700, 220, "window.__kaiEngine.showGallery('V15')"));
results.push(await run("gallery-V23", "ENGINE showGallery('V23')", async () => { await ev("window.__kaiEngine.showGallery('V23')"); }, 700, 220, "window.__kaiEngine.showGallery('V23')"));
// shatter (shards fly, then shell, then reassemble)
results.push(await run("shatter", "ENGINE shatter()", async () => { await ev("window.__kaiEngine.shatter()"); }, 300, 130));

// ── Repeated-pose: SUCCESS entered twice from two separate real missions ──────
await ev(RESET); await sleep(400);
say("\n[repeated-pose] SUCCESS x2 (two separate real missions)");
async function entryHash(label) { return { label, hash: await ev(HASH), t: Date.now() }; }
const e = [];
await realMissionSuccess(); await sleep(500);
e.push(await entryHash("entry1a")); await sleep(300); e.push(await entryHash("entry1b"));
await sleep(2600);
await realMissionSuccess(); await sleep(500);
e.push(await entryHash("entry2a")); await sleep(300); e.push(await entryHash("entry2b"));
const entry1 = e.find((x) => x.label === "entry1a").hash;
const entry2 = e.find((x) => x.label === "entry2a").hash;
const repeatedIdentical = entry1 === entry2;
say(`  entry1 hash=${entry1}  entry2 hash=${entry2}  identical=${repeatedIdentical}`);

// ── Results ──────────────────────────────────────────────────────────────────
const out = {
  generatedAt: new Date().toISOString(),
  core: coreId,
  islandUrl: ISLAND_URL,
  canvas,
  actions: results,
  repeatedPose: { state: "SUCCESS", entry1, entry2, identical: repeatedIdentical, samples: e },
  summary: {
    actions: results.length,
    moving: results.filter((r) => r.moving).length,
    allMoving: results.every((r) => r.moving),
    repeatedPoseDistinct: !repeatedIdentical,
  },
};
writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
say("\n=== summary ===");
say("actions:", out.summary.actions, " moving:", out.summary.moving, " allMoving:", out.summary.allMoving);
say("repeated-pose distinct:", out.summary.repeatedPoseDistinct);
say("wrote", OUT_JSON);
await ev("clearInterval(window.__charKeep); 'stopped'");
ws.close();

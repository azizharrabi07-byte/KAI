// KAI — UI TRUTH HARNESS.
//
// Launches the real release app, waits for the bundled Core to answer, opens the
// main window through the island's real action, then reads the LIVE DOM of the
// main window: is the navigation rail present, what are its items, what does each
// route actually render, and what does Core really report. Screenshots each route.
//
//   node docs/evidence/kai-ui-truth.mjs
//
// Writes docs/evidence/kai-ui-truth.json. Nothing is simulated.

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const APP = "C:/Users/DELL/Desktop/kai/app/target/release/kai.exe";
const CORE = "http://127.0.0.1:8788";
const PORT = 9222;
const UDD = "C:/Users/DELL/.hermes/profiles/kai/cache/scratch/wv2-uitruth";
const EV = "C:/Users/DELL/Desktop/kai/docs/evidence";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = { harness: "kai-ui-truth", at: new Date().toISOString() };
const say = (s) => { (ev.steps ||= []).push(s); console.log("· " + s); };

async function targets() { return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === "page"); }
function connect(url) { return new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = () => rej(new Error("ws")); }); }
let seq = 1;
function cdp(ws, method, params = {}) {
  const mine = seq++;
  return new Promise((res, rej) => {
    const on = (e) => { const m = JSON.parse(e.data); if (m.id === mine) { ws.removeEventListener("message", on); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
    ws.addEventListener("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
}
const ev2 = (ws, expression) => cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then((r) => (r.exceptionDetails ? { __error: r.exceptionDetails.text } : r.result.value));
async function shot(ws, name) { try { const r = await cdp(ws, "Page.captureScreenshot", { format: "png" }); writeFileSync(`${EV}/${name}.png`, Buffer.from(r.data, "base64")); return `${EV}/${name}.png`; } catch { return null; } }
async function waitFor(cond, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await cond()) return true; } catch { } await sleep(500); } return false; }

const RAIL_PROBE = `(() => {
  const rail = document.querySelector("nav.rail");
  const cs = rail ? getComputedStyle(rail) : null;
  const r = rail ? rail.getBoundingClientRect() : null;
  const items = rail ? [...rail.querySelectorAll("*")].filter(e => e.children.length === 0 && (e.textContent||"").trim()).map(e => e.textContent.trim()) : [];
  return {
    hasRail: !!rail, railRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    railDisplay: cs ? cs.display : null, railVisibility: cs ? cs.visibility : null, railOpacity: cs ? cs.opacity : null,
    railItems: items, railButtons: rail ? rail.querySelectorAll("button").length : 0,
    rootKids: document.getElementById("root")?.childElementCount ?? -1,
    bodyClasses: [...document.body.classList].join(" "),
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    headline: (document.body.innerText||"").replace(/\\s+/g," ").slice(0, 300)
  };
})()`;

const CLICK = (label) => `(() => {
  const rail = document.querySelector("nav.rail");
  if (!rail) return { clicked: false, reason: "no nav.rail" };
  const el = [...rail.querySelectorAll("button,[role=button],a,li,div")].find(e => (e.textContent||"").trim() === ${JSON.stringify(label)});
  if (!el) return { clicked: false, reason: "no rail entry", known: [...rail.querySelectorAll("*")].map(e=>e.textContent.trim()).filter(Boolean).slice(0,40) };
  el.click();
  return { clicked: true };
})()`;

const READ_VIEW = `(() => {
  const vis = [...document.querySelectorAll("[id^=kp-v-]")].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"; }).map(e => e.id);
  return { visibleViews: vis, text: (document.body.innerText||"").replace(/\\s+/g," ").slice(0, 420) };
})()`;

async function main() {
  try { rmSync(UDD, { recursive: true, force: true }); } catch { }
  mkdirSync(UDD, { recursive: true });
  const child = spawn(APP, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: UDD } });
  child.unref();
  ev.launch = { pid: child.pid, at: new Date().toISOString() };
  say("launched pid=" + child.pid);
  if (!(await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).ok, 45000, "cdp"))) throw new Error("no cdp");
  say("cdp up");

  // Wait for the bundled Core — record how long it really takes.
  const t0 = Date.now();
  let identity = null;
  const up = await waitFor(async () => { const r = await fetch(`${CORE}/identity`); if (r.ok) { identity = await r.json(); return true; } return false; }, 90000, "core");
  ev.core = { answered: up, afterMs: Date.now() - t0, identity };
  say(`Core /identity answered=${up} after ${Date.now() - t0}ms ${identity ? identity.buildId + " pid " + identity.pid + " " + identity.freshness : ""}`);

  const island = (await targets()).find((t) => !t.url.includes("settings") && !t.url.includes("shell.html"));
  const iws = await connect(island.webSocketDebuggerUrl);
  ev.openKai = await ev2(iws, `window.__TAURI_INTERNALS__.invoke("open_main_window").then(()=>"ok").catch(e=>"ERR "+e)`);
  await shot(iws, "uitruth-island-panel");
  iws.close();
  say("open_main_window → " + JSON.stringify(ev.openKai));
  await sleep(2500);

  const main = (await targets()).find((t) => t.url.includes("shell.html"));
  const ws = await connect(main.webSocketDebuggerUrl);
  await sleep(2500); // let the first Core slice paint
  ev.rail = await ev2(ws, RAIL_PROBE);
  say("rail: " + JSON.stringify({ has: ev.rail.hasRail, rect: ev.rail.railRect, display: ev.rail.railDisplay, items: ev.rail.railItems, buttons: ev.rail.railButtons }));
  ev.mainHome = await shot(ws, "uitruth-main-home");

  const coreCounts = {};
  for (const p of ["/tools", "/sessions", "/agents", "/mcp", "/identity/model", "/skills"]) {
    try { const r = await fetch(`${CORE}${p}`); const t = await r.text(); coreCounts[p] = { status: r.status, body: t.slice(0, 400) }; } catch (e) { coreCounts[p] = { status: null, error: String(e.message) }; }
  }
  ev.coreCounts = coreCounts;
  for (const [p, v] of Object.entries(coreCounts)) say(`Core ${p} → ${v.status} ${String(v.body).replace(/\s+/g, " ").slice(0, 160)}`);

  ev.routes = [];
  const labels = [];
  if (ev.rail.hasRail) {
    const raw = ev.rail.railItems;
    for (const it of raw) if (/^(Home|Chat|Sessions|Missions|Agents|Workers|Tools|MCP|Activity|Memory|Skills|Settings)$/.test(it)) labels.push(it);
  }
  say("rail labels detected: " + JSON.stringify(labels));
  let n = 0;
  for (const label of labels) {
    const c = await ev2(ws, CLICK(label));
    await sleep(1200);
    const v = await ev2(ws, READ_VIEW);
    const png = n < 6 ? await shot(ws, `uitruth-route-${label.toLowerCase()}`) : null;
    ev.routes.push({ label, click: c, ...v, screenshot: png });
    say(`route ${label}: clicked=${c.clicked} views=${JSON.stringify(v.visibleViews)} :: ${String(v.text).slice(0, 120)}`);
    n++;
  }
  ws.close();
  writeFileSync(`${EV}/kai-ui-truth.json`, JSON.stringify(ev, null, 2));
  console.log("wrote " + EV + "/kai-ui-truth.json");
}
main().catch((e) => { ev.fatal = String(e?.message ?? e); writeFileSync(`${EV}/kai-ui-truth.json`, JSON.stringify(ev, null, 2)); console.log("FATAL " + ev.fatal); });

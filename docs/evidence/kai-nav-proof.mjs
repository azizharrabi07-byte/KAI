// KAI — NAV PROOF. Click every navigation rail entry by its REAL accessible name
// (the rail is icon-only, so `aria-label` is the label) and record what each route
// renders, with a screenshot of the key pages.
//   node docs/evidence/kai-nav-proof.mjs
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const APP = "C:/Users/DELL/Desktop/kai/app/target/release/kai.exe";
const CORE = "http://127.0.0.1:8788";
const PORT = 9222;
const UDD = "C:/Users/DELL/.hermes/profiles/kai/cache/scratch/wv2-navproof";
const EV = "C:/Users/DELL/Desktop/kai/docs/evidence";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = { harness: "kai-nav-proof", at: new Date().toISOString(), steps: [] };
const say = (s) => { ev.steps.push(s); console.log("· " + s); };

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
async function waitFor(cond, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await cond()) return true; } catch { } await sleep(400); } return false; }

const LABELS = `[...document.querySelectorAll("nav.rail button")].map(b => b.getAttribute("aria-label") || b.title || "(unlabelled)")`;
const CLICK = (label) => `(() => {
  const b = [...document.querySelectorAll("nav.rail button")].find(b => (b.getAttribute("aria-label")||b.title) === ${JSON.stringify(label)});
  if (!b) return { clicked: false };
  b.click(); return { clicked: true };
})()`;
const VIEW = `(() => {
  const vis = [...document.querySelectorAll("[id^=kp-v-]")].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== "none"; }).map(e => e.id);
  const h2 = document.querySelector("[id^=kp-v-]:not([hidden]) h2");
  return { visibleViews: vis, heading: h2 ? h2.textContent : null, text: (document.body.innerText||"").replace(/\\s+/g," ").slice(0,200) };
})()`;

async function main() {
  try { rmSync(UDD, { recursive: true, force: true }); } catch { }
  mkdirSync(UDD, { recursive: true });
  const child = spawn(APP, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: UDD } });
  child.unref();
  say("launched pid=" + child.pid);
  if (!(await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).ok, 45000))) throw new Error("no cdp");
  const t0 = Date.now();
  let identity = null;
  const up = await waitFor(async () => { const r = await fetch(`${CORE}/identity`); if (r.ok) { identity = await r.json(); return true; } return false; }, 90000);
  ev.core = { answered: up, afterMs: Date.now() - t0, identity };
  say(`Core answered=${up} after ${Date.now() - t0}ms ${identity ? identity.buildId : ""}`);

  const island = (await targets()).find((t) => !t.url.includes("settings") && !t.url.includes("shell.html"));
  const iws = await connect(island.webSocketDebuggerUrl);
  await ev2(iws, `window.__TAURI_INTERNALS__.invoke("open_main_window")`);
  iws.close();
  await sleep(3000);

  const main = (await targets()).find((t) => t.url.includes("shell.html"));
  const ws = await connect(main.webSocketDebuggerUrl);
  await sleep(2500);
  ev.viewport = await ev2(ws, `({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })`);
  ev.railGeometry = await ev2(ws, `(() => { const r = document.querySelector("nav.rail"); const b = r.getBoundingClientRect(); return { display: getComputedStyle(r).display, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; })()`);
  say(`viewport ${ev.viewport.w}x${ev.viewport.h} @dpr ${ev.viewport.dpr}; rail ${JSON.stringify(ev.railGeometry)}`);

  const labels = await ev2(ws, LABELS);
  ev.railLabels = labels;
  say("rail entries: " + JSON.stringify(labels));

  ev.routes = [];
  const want = ["Home", "Chat", "Sessions", "Agents", "Tools", "Skills", "Settings"];
  for (const label of labels) {
    const c = await ev2(ws, CLICK(label));
    await sleep(1100);
    const v = await ev2(ws, VIEW);
    const png = want.includes(label) ? await shot(ws, `nav-${label.toLowerCase()}`) : null;
    ev.routes.push({ label, ...c, ...v, screenshot: png });
    say(`${label}: clicked=${c.clicked} views=${JSON.stringify(v.visibleViews)} heading=${JSON.stringify(v.heading)}`);
  }
  // final full-window shot on Home
  await ev2(ws, CLICK("Home"));
  await sleep(1200);
  ev.homeScreenshot = await shot(ws, "nav-home-final");
  ws.close();
  writeFileSync(`${EV}/kai-nav-proof.json`, JSON.stringify(ev, null, 2));
  console.log("wrote " + EV + "/kai-nav-proof.json");
}
main().catch((e) => { ev.fatal = String(e?.message ?? e); writeFileSync(`${EV}/kai-nav-proof.json`, JSON.stringify(ev, null, 2)); console.log("FATAL " + ev.fatal); });

// Probe the main window's OWN view of its size via the Tauri window plugin, then
// ask it to become the declared 1280x820 logical — and measure what changes.
// Reuses the acceptance harness launch path. Writes docs/evidence/kai-window-size-probe.json.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const APP = "C:/Users/DELL/Desktop/kai/app/target/release/kai.exe";
const PORT = 9222;
const UDD = "C:/Users/DELL/.hermes/profiles/kai/cache/scratch/wv2-probe";
const OUT = "C:/Users/DELL/Desktop/kai/docs/evidence/kai-window-size-probe.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = { harness: "kai-window-size-probe", at: new Date().toISOString() };
const say = (s) => { ev.steps = ev.steps || []; ev.steps.push(s); console.log("· " + s); };

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

async function waitFor(cond, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await cond()) return; } catch { } await sleep(500); } throw new Error("timeout " + what); }

const PROBE = `(async () => {
  const I = window.__TAURI_INTERNALS__.invoke;
  const call = async (m, a) => { try { return await I(m, a ?? {}); } catch (e) { return "ERR " + String(e); } };
  const out = {};
  out.scaleFactor = await call("plugin:window|scale_factor");
  out.innerSize = await call("plugin:window|inner_size");
  out.outerSize = await call("plugin:window|outer_size");
  out.isMaximized = await call("plugin:window|is_maximized");
  out.isVisible = await call("plugin:window|is_visible");
  out.css = { outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio };
  const before = out.css;
  await call("plugin:window|set_size", { value: { Logical: { width: 1280, height: 820 } } });
  await new Promise(r => setTimeout(r, 900));
  out.cssAfterSetLogical1280x820 = { outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight };
  out.innerSizeAfter = await call("plugin:window|inner_size");
  return out;
})()`;

async function main() {
  try { rmSync(UDD, { recursive: true, force: true }); } catch { }
  mkdirSync(UDD, { recursive: true });
  const child = spawn(APP, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: UDD } });
  child.unref();
  ev.launch = { path: APP, pid: child.pid };
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).ok, 45000, "cdp");
  await sleep(2500);
  const island = (await targets()).find((t) => !t.url.includes("settings") && !t.url.includes("shell.html"));
  {
    const ws = await connect(island.webSocketDebuggerUrl);
    ev.openResult = await ev2(ws, `window.__TAURI_INTERNALS__.invoke("open_main_window").then(()=>"ok").catch(e=>"ERR "+e)`);
    ws.close();
  }
  say("open_main_window → " + JSON.stringify(ev.openResult));
  await sleep(2000);
  const main = (await targets()).find((t) => t.url.includes("shell.html"));
  ev.mainTarget = main?.url;
  const ws = await connect(main.webSocketDebuggerUrl);
  ev.mainWindow = await ev2(ws, PROBE);
  {
    const r = await cdp(ws, "Page.captureScreenshot", { format: "png" });
    writeFileSync("C:/Users/DELL/Desktop/kai/docs/evidence/accept-main-after-set1280.png", Buffer.from(r.data, "base64"));
  }
  ws.close();
  say(JSON.stringify(ev.mainWindow, null, 2));
  writeFileSync(OUT, JSON.stringify(ev, null, 2));
  console.log("wrote " + OUT);
}
main().catch((e) => { ev.fatal = String(e?.message ?? e); writeFileSync(OUT, JSON.stringify(ev, null, 2)); console.log("FATAL " + ev.fatal); });

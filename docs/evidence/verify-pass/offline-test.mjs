// offline-test.mjs — defect B, live: does the character fall to OFFLINE when Core dies?
//
//   node offline-test.mjs
//
// One process, so the timing is controlled: it drives a REAL action.executed
// (POST /notifications/:id/read), reads the island's pose, kills the Core from
// the host (taskkill is silent under MSYS; process.kill is not), then polls the
// live island every 400 ms. The app auto-restarts Core ~3 s after a kill, so the
// poll also captures the recovery.
//
// The pose is read from #bot-glow (colour + opacity, a pure function of the
// character state) and the runtime label element. The label element is only
// re-rendered when the overview's focus task changes, so it can lag; the glow is
// the live signal and the canvas PNG is the ground truth for the pose.

import { writeFileSync } from "node:fs";

const CORE = process.env.KAI_CORE ?? "http://127.0.0.1:8788";
const CDP = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP ──────────────────────────────────────────────────────────────────────
const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((t) => t.type === "page" && t.url === "http://tauri.localhost/");
if (target === undefined) {
  console.error("no island page target; got", list.map((t) => t.url));
  process.exit(3);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result.value;
}

// ── the pose, read from the live DOM ─────────────────────────────────────────
const READ = `(() => {
  const g = document.getElementById('bot-glow');
  const c = document.getElementById('bot-canvas');
  const card = [...document.querySelectorAll('.int-card')].find((x) => /your agent/.test(x.textContent));
  const label = card && card.querySelector('.int-status span') ? card.querySelector('.int-status span').textContent : null;
  return {
    glow: g ? g.style.background : null,
    opacity: g ? g.style.opacity : null,
    label,
    islandH: document.getElementById('island').style.height,
    canvas: c ? { w: c.width, h: c.height } : null,
  };
})()`;

const CANVAS_PNG = `document.getElementById('bot-canvas').toDataURL('image/png')`;

async function expand() {
  // The island auto-collapses to 32 px after 15 s; the frame loop (which runs
  // runtime.tick()) only runs while it is open, so keep it open around the poll.
  await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})`);
}

function savePng(dataUrl, name) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  writeFileSync(name, Buffer.from(b64, "base64"));
}

// ── run ──────────────────────────────────────────────────────────────────────
const id = await (await fetch(`${CORE}/identity`)).json();
console.log("core identity:", JSON.stringify(id));
const pid = id.pid;

await expand();
await sleep(1200);

// A REAL event: notification.read executes the notification.read tool, which
// publishes action.executed on the bus; the island's SSE link maps that to
// USING_TOOL. This is the same real event the earlier pass used.
const notif = await (await fetch(`${CORE}/notifications?limit=5`)).json();
const nid = notif.notifications?.[0]?.id;
console.log("notification.read trigger:", nid);
if (nid !== undefined) {
  const r = await fetch(`${CORE}/notifications/${nid}/read`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  console.log("  POST status:", r.status);
}
await sleep(1500);

const before = await evaluate(READ);
const beforePng = await evaluate(CANVAS_PNG);
savePng(beforePng, "offline-before.png");
console.log("BEFORE:", JSON.stringify(before));

// Re-open right before the kill so the whole 6.4 s poll is inside the 15 s window.
await expand();
await sleep(200);

const t0 = Date.now();
let killResult = "?";
try {
  process.kill(pid);
  killResult = "process.kill(" + pid + ") sent";
} catch (e) {
  killResult = "process.kill(" + pid + ") failed: " + e.code;
}
console.log("KILL:", killResult);

const series = [];
for (let i = 0; i < 16; i++) {
  await sleep(400);
  const r = await evaluate(READ);
  series.push({ ms: Date.now() - t0, ...r });
}
console.log("POLL (16 x 400 ms after the kill):");
for (const s of series) {
  console.log(`  +${String(s.ms).padStart(4)}ms  glow=${s.glow}  op=${s.opacity}  label=${JSON.stringify(s.label)}  islandH=${s.islandH}`);
}

const afterPng = await evaluate(CANVAS_PNG);
savePng(afterPng, "offline-after.png");

const out = { identity: id, killResult, before, series };
writeFileSync("offline-test-results.json", JSON.stringify(out, null, 2));
console.log("\nwrote offline-test-results.json + offline-before.png + offline-after.png");
ws.close();

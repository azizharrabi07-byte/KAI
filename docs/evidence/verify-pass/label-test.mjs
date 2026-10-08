// label-test.mjs — the KAI card's runtime LABEL must follow KAI's real runtime state.
//
//   node label-test.mjs
//
// The defect this pins (found live): `buildOverview.sync()` rebuilt the KAI card
// on a key of task.id/state/steps + integration data, NOT on the runtime state or
// the Core connection. KAI's card renders `State.runtimeLabel`, so a real event
// that moved KAI to USING_TOOL changed the character's glow but left the label a
// user reads stuck at "KAI is idle".
//
// It drives a REAL event (POST /notifications/:id/read executes the
// notification.read tool, which publishes action.executed on the bus; the island's
// SSE link maps that to USING_TOOL) and polls BOTH signals every 300 ms: the glow
// (#bot-glow, the pose) and the card's label (the text). Both must agree.

import { writeFileSync } from "node:fs";

const CORE = process.env.KAI_CORE ?? "http://127.0.0.1:8788";
const CDP = "http://127.0.0.1:9222";
const OUT = process.env.KAI_OUT ?? "label-test-results.json";
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

// The KAI card is the one whose header sub-text is "your agent". Read both the
// pose (glow) and the label text from the live DOM.
const READ = `(() => {
  const g = document.getElementById('bot-glow');
  const card = [...document.querySelectorAll('.int-card')].find((x) => /your agent/.test(x.textContent));
  const label = card && card.querySelector('.int-status span') ? card.querySelector('.int-status span').textContent : null;
  const head = card && card.querySelector('.int-head b') ? card.querySelector('.int-head b').textContent : null;
  return { glow: g ? g.style.background : null, opacity: g ? g.style.opacity : null, head, label };
})()`;

async function expand() {
  await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})`);
}

const id = await (await fetch(`${CORE}/identity`)).json();
console.log("core identity:", JSON.stringify(id));
const pid = id.pid;

await expand();
await sleep(1200);

const before = await evaluate(READ);
console.log("BEFORE (no event yet):", JSON.stringify(before));

// A REAL event: notification.read → action.executed → USING_TOOL.
const notif = await (await fetch(`${CORE}/notifications?limit=5`)).json();
const nid = notif.notifications?.[0]?.id;
console.log("notification.read trigger:", nid);
let postStatus = null;
if (nid !== undefined) {
  const r = await fetch(`${CORE}/notifications/${nid}/read`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  postStatus = r.status;
  console.log("  POST status:", r.status);
}
await expand();

const series = [];
for (let i = 0; i < 10; i++) {
  await sleep(300);
  series.push({ ms: (i + 1) * 300, ...(await evaluate(READ)) });
}
console.log("POLL (10 x 300 ms after the real action.executed):");
for (const s of series) {
  console.log(`  +${String(s.ms).padStart(4)}ms  glow=${s.glow}  op=${s.opacity}  label=${JSON.stringify(s.label)}`);
}

// A USING_TOOL pose is the indigo glow; the label that agrees with it is
// RUNTIME_LABELS.USING_TOOL = "KAI is using a tool…".
const usingGlow = /99,\s*102,\s*241/.test(before.glow ?? "") || series.some((s) => /99,\s*102,\s*241/.test(s.glow ?? ""));
const labelFollowed = series.some((s) => /using a tool/i.test(s.label ?? ""));
const labelStuck = series.every((s) => /idle/i.test(s.label ?? ""));
const verdict = usingGlow && labelFollowed ? "PASS (label follows the pose)"
  : usingGlow && labelStuck ? "FAIL (stale label: pose moved, label did not)"
  : "INCONCLUSIVE (no USING_TOOL pose observed)";
console.log("\nVERDICT:", verdict);

writeFileSync(OUT, JSON.stringify({ identity: id, postStatus, before, series, verdict }, null, 2));
console.log(`wrote ${OUT}`);
ws.close();

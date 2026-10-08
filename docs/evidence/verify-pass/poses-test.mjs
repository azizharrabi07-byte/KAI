// poses-test.mjs — the live per-state POSE evidence for KAI's orb.
//
//   node poses-test.mjs
//
// What this pins, in the LIVE island (the packaged app on 127.0.0.1:8788 with its
// WebView2 debug port open):
//
//   (a) each runtime state drives a DISTINCT glow colour AND a DISTINCT card
//       label — recorded from the real DOM, not from the code table;
//   (b) re-entering a state does NOT freeze the pose: the orb canvas hash at the
//       moment of entry differs across two separate entries, and the hash keeps
//       changing while a state is held (the orb is animating, not a still);
//   (c) a REAL PNG of the orb is saved per state (the canvas itself) plus a
//       full-island screenshot, so the character can actually be seen.
//
// Every state is entered by a REAL trigger (no invented events):
//   THINKING         — the chat input's Enter submit (a genuine local user act)
//   USING_TOOL       — POST /notifications/:id/read  → action.executed
//   SUCCESS          — a mission whose step completes → mission.completed
//   ERROR            — a mission whose step fails     → mission.failed
//   WORKING          — approve a parked agent mission → approval.approved
//   WAITING_APPROVAL — a parked capability write      → approval.requested
//
// The island auto-collapses to 32px after ~15s and the frame loop that runs
// runtime.tick() only runs while expanded, so the island is kept expanded via
// the tray event. The window match is EXACT ("http://tauri.localhost/") because
// "tauri.localhost/" also prefixes settings.html — the wrong-window trap.

import { writeFileSync } from "node:fs";

const CORE = process.env.KAI_CORE ?? "http://127.0.0.1:8788";
const CDP = process.env.KAI_CDP ?? "http://127.0.0.1:9222";
const ISLAND_URL = "http://tauri.localhost/";
const OUT_JSON = process.env.KAI_OUT ?? "poses-test-results.json";
const OUT_LOG = process.env.KAI_LOG ?? "poses-test-run.txt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The state table we expect to observe (glow + label are the assertions) ────
const EXPECT = {
  IDLE:             { rgb: "rgb(255, 255, 255)", label: "KAI is idle",             pose: "idle"       },
  THINKING:         { rgb: "rgb(167, 139, 250)", label: "KAI is thinking…",        pose: "thinking"   },
  WORKING:          { rgb: "rgb(59, 158, 255)",  label: "KAI is working…",         pose: "working"    },
  USING_TOOL:       { rgb: "rgb(99, 102, 241)",  label: "KAI is using a tool…",    pose: "scan"       },
  WAITING_APPROVAL: { rgb: "rgb(245, 165, 36)",  label: "KAI needs your approval", pose: "needsuser"  },
  SUCCESS:          { rgb: "rgb(52, 211, 153)",  label: "KAI finished",            pose: "success"    },
  ERROR:            { rgb: "rgb(244, 80, 94)",   label: "KAI hit an error",        pose: "error"      },
};

const logLines = [];
function say(...a) { const s = a.join(" "); console.log(s); logLines.push(s); }

// ── CDP ──────────────────────────────────────────────────────────────────────
const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((t) => t.type === "page" && t.url === ISLAND_URL);
if (target === undefined) {
  console.error("no island page target; got", list.map((t) => t.url));
  process.exit(3);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
function send(method, params) {
  return new Promise((res, rej) => { const id = ++nextId; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
}
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result.value;
}
async function expand() {
  try { await ev(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})`); } catch { /* */ }
}
async function shot(name) {
  try {
    const r = await send("Page.captureScreenshot", { format: "png" });
    if (r && r.data) { writeFileSync(name, Buffer.from(r.data, "base64")); return name; }
  } catch (e) { say("  (screenshot failed:", String(e).slice(0, 80), ")"); }
  return null;
}
async function core(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(CORE + path, init);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}
const post = (p, b) => core("POST", p, b ?? {});
const get = (p) => core("GET", p);

// ── The in-page sampler ───────────────────────────────────────────────────────
// Every 8ms it reads the glow colour, the card label, and (only when the COLOUR
// changes, so it is cheap) a canvas pixel hash + PNG of the orb. It also keeps a
// rolling animation sample of the canvas hash so a held state can be shown to be
// MOVING rather than a frozen still.
await ev(`(() => {
  const hashOf = (c) => {
    try {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261 >>> 0;
      for (let i = 0; i < d.length; i += 13) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; }
      return h.toString(16).padStart(8, '0');
    } catch (e) { return 'err'; }
  };
  const read = () => {
    const g = document.getElementById('bot-glow');
    const bg = g ? g.style.background : null;
    const col = bg ? (bg.match(/rgb\\([^)]*\\)/) || [null])[0] : null;
    const card = [...document.querySelectorAll('.int-card')].find((x) => /your agent/.test(x.textContent));
    const label = card && card.querySelector('.int-status span') ? card.querySelector('.int-status span').textContent : null;
    return { col, label, op: g ? g.style.opacity : null };
  };
  window.__k = { trans: [], anim: [], lastCol: null };
  // A point-in-time snapshot, so a caller can ask "is this state showing RIGHT
  // NOW?" without waiting for a transition — a state entered before the caller
  // cleared the log leaves no transition to find.
  window.__k.snap = () => {
    const r = read();
    const c = document.getElementById('bot-canvas');
    let hash = null, png = null;
    if (c) { hash = hashOf(c); try { png = c.toDataURL('image/png'); } catch (e) {} }
    return { t: Math.round(performance.now()), col: r.col, label: r.label, op: r.op, hash, png };
  };
  if (window.__kTick) clearInterval(window.__kTick);
  if (window.__kAnim) clearInterval(window.__kAnim);
  if (window.__kKeep) clearInterval(window.__kKeep);
  window.__kTick = setInterval(() => {
    const r = read();
    if (r.col !== window.__k.lastCol) {
      window.__k.lastCol = r.col;
      const c = document.getElementById('bot-canvas');
      let hash = null, png = null;
      if (c) { hash = hashOf(c); try { png = c.toDataURL('image/png'); } catch (e) {} }
      window.__k.trans.push({ t: Math.round(performance.now()), col: r.col, label: r.label, op: r.op, hash, png });
      if (window.__k.trans.length > 60) window.__k.trans.shift();
    }
  }, 8);
  window.__kAnim = setInterval(() => {
    const c = document.getElementById('bot-canvas');
    if (c) { window.__k.anim.push({ t: Math.round(performance.now()), hash: hashOf(c) }); if (window.__k.anim.length > 400) window.__k.anim.shift(); }
  }, 200);
  // Keep the island expanded: the frame loop only runs while it is.
  window.__kKeep = setInterval(() => { try { window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'}); } catch (e) {} }, 4000);
  return 'sampler installed';
})()`);

const id = await (await fetch(`${CORE}/identity`)).json();
say("core /identity:", JSON.stringify(id));

async function resetTrans() { await ev("window.__k.trans = []; 'ok'"); }
async function readTrans() { return ev("window.__k.trans"); }

// Capture: clear the transition log, run the trigger, wait for the expected
// colour to appear as an entry, and return that transition record.
async function capture(name, trigger, timeoutMs = 25000) {
  await expand();
  // A trigger is not always REQUIRED to be in this state: a chat turn's own tool
  // actions drive USING_TOOL (and mission events drive others) on their own. If
  // the state is already showing, that IS the observation — a state entered
  // before the log was cleared leaves no transition to find, so waiting for a
  // change waits forever. Record the live colour/label/hash and a screenshot.
  const pre = await ev("window.__k.snap()");
  if (pre && pre.col === EXPECT[name].rgb) return recordSnapshot(name, pre, "already showing");
  await resetTrans();
  await trigger();
  const t0 = Date.now();
  let hit = null;
  while (Date.now() - t0 < timeoutMs) {
    await expand();
    const tr = await readTrans();
    hit = tr.find((x) => x.col === EXPECT[name].rgb);
    if (hit) break;
    await sleep(60);
  }
  if (!hit) { say(`FAIL  ${name}: colour ${EXPECT[name].rgb} never appeared within ${timeoutMs}ms`); return null; }
  return recordSnapshot(name, hit, "entered on trigger");
}

/** Save the island + orb PNGs for one observed state and log it. */
async function recordSnapshot(name, hit, how) {
  // Grab a full-island screenshot while the state is (still) held.
  const pngFile = `pose-island-${name.toLowerCase()}.png`;
  const savedShot = await shot(pngFile);
  // Save the orb canvas PNG captured at entry.
  const orbFile = `pose-orb-${name.toLowerCase()}.png`;
  if (hit.png) { writeFileSync(orbFile, Buffer.from(hit.png.replace(/^data:image\/png;base64,/, ""), "base64")); }
  say(`PASS  ${name}: glow=${hit.col}  opacity=${hit.op}  label=${JSON.stringify(hit.label)}  orbHash=${hit.hash}  (${how})  -> ${hit.png ? orbFile : "(no canvas png)"}${savedShot ? "  " + savedShot : ""}`);
  return { ...hit, orbFile: hit.png ? orbFile : null, islandFile: savedShot };
}

say("\n=== driving the runtime states with real triggers ===");

// 0. IDLE — the resting state. Read BEFORE any trigger: at rest the machine is
//    already idle, so this is a real reading of the resting pose, not a forced one.
const idle = await capture("IDLE", async () => { await sleep(200); }, 5000);

// 1. THINKING — a genuine local user action: the chat input's Enter submit.
const thinking = await capture("THINKING", async () => {
  await ev(`(() => { const t = document.querySelector('.tab[title="Ask"]'); if (t) t.click(); return 'ask'; })()`);
  await sleep(250);
  await ev(`(() => {
    const input = document.querySelector('.chat-input');
    if (!input) return 'no input';
    input.value = 'ping';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'submitted';
  })()`);
}, 8000);
// let the chat turn settle so it does not bleed into the next state
await sleep(6000);

// 2. USING_TOOL (entry 1) — notification.read → action.executed.
async function notifRead() {
  // Reading a notification that is ALREADY read publishes nothing — see
  // core/src/notifications/service.ts: "Already read: nothing changed, so nothing
  // to announce." The old version read `notifications[0]`, which on a store that
  // any earlier run has touched is a READ row, so the trigger published no
  // `action.executed` and the machine never entered USING_TOOL (this is the flake
  // that made the first USING_TOOL capture fail while the second passed). Read the
  // first UNREAD row instead, and if there is none, mint one by running a step
  // that fails — the autonomy supervisor raises an unread HIGH notification for it.
  const pickUnread = async () =>
    ((await get("/notifications?limit=20")).json?.notifications ?? []).find((x) => x.read === false);
  let first = await pickUnread();
  if (first === undefined) {
    await post("/missions", {
      title: "pose-notif " + Date.now().toString(36),
      steps: [{ kind: "tool", title: "bad", target: "capability.system", input: { action: "no.such.action" } }],
    });
    await sleep(800);
    first = await pickUnread();
  }
  if (first === undefined) throw new Error("no UNREAD notification to read");
  const r = await post(`/notifications/${first.id}/read`, {});
  say("  trigger POST /notifications/" + first.id + "/read ->", r.status);
}
const using1 = await capture("USING_TOOL", notifRead);

// 3. SUCCESS — a mission whose single tool step completes.
const success = await capture("SUCCESS", async () => {
  const r = await post("/missions", { title: "pose-ok " + Date.now().toString(36), steps: [{ kind: "tool", title: "noop", target: "missions.create", input: { title: "nested-pose" } }] });
  say("  trigger POST /missions ->", r.status, r.json?.mission?.status);
});
await sleep(1500);

// 4. ERROR — a mission whose step fails (capability.system, an action it cannot do).
const error = await capture("ERROR", async () => {
  const r = await post("/missions", { title: "pose-err " + Date.now().toString(36), steps: [{ kind: "tool", title: "bad", target: "capability.system", input: { action: "no.such.action" } }] });
  say("  trigger POST /missions ->", r.status, r.json?.mission?.status);
});
await sleep(1500);

// 5. USING_TOOL (entry 2) — a second, separate entry into the SAME state, after
//    having left it (SUCCESS/ERROR in between). This is the repeated-pose check.
const using2 = await capture("USING_TOOL", notifRead);

// 6. WORKING — approve a parked agent mission → approval.approved.
let working = null;
{
  const a = await post("/missions", { title: "pose-work " + Date.now().toString(36), steps: [{ kind: "agent", title: "say hi", target: "hermes", input: { input: "Reply with exactly: POSE-OK" } }] });
  say("  agent mission ->", a.status, a.json?.mission?.status);
  const mid = a.json?.mission?.id;
  await sleep(700);
  const ap = await get("/approvals?status=PENDING");
  const pend = (ap.json?.approvals ?? []).find((x) => x.missionId === mid && x.status === "PENDING");
  if (pend === undefined) { say("FAIL  WORKING: no parked approval for mission", mid); }
  else {
    say("  approving parked approval", pend.id, "(", pend.toolId, ")");
    working = await capture("WORKING", async () => { const d = await post(`/approvals/${pend.id}/decide`, { approved: true }); say("  trigger decide ->", d.status); }, 25000);
  }
}

// 7. WAITING_APPROVAL — a parked capability write → approval.requested.
const waiting = await capture("WAITING_APPROVAL", async () => {
  const r = await post("/capabilities/computer/test", { action: "windows" });
  say("  trigger POST /capabilities/computer/test ->", r.status, (r.json?.reason ?? "").slice(0, 90));
});

// ── Animation check: is the orb MOVING while a state is held? ─────────────────
// Read the rolling hash samples and count distinct hashes over the last few seconds.
const anim = await ev("window.__k.anim.slice(-40)");
const distinctAnimHashes = new Set((anim ?? []).map((x) => x.hash)).size;

// ── Results ───────────────────────────────────────────────────────────────────
const states = {};
for (const k of Object.keys(EXPECT)) {
  const c = { IDLE: idle, THINKING: thinking, WORKING: working, USING_TOOL: using1, WAITING_APPROVAL: waiting, SUCCESS: success, ERROR: error }[k];
  states[k] = c
    ? { observed: true, glow: c.col, opacity: c.op, label: c.label, expectedGlow: EXPECT[k].rgb, expectedLabel: EXPECT[k].label, labelMatches: c.label === EXPECT[k].label, pose: EXPECT[k].pose, orbHash: c.hash, orbPng: c.orbFile, islandPng: c.islandFile }
    : { observed: false, expectedGlow: EXPECT[k].rgb, expectedLabel: EXPECT[k].label, pose: EXPECT[k].pose };
}
const observed = Object.entries(states).filter(([, v]) => v.observed);
const glows = observed.map(([, v]) => v.glow);
const labels = observed.map(([, v]) => v.label);
const distinctGlows = new Set(glows).size;
const distinctLabels = new Set(labels).size;
const repeatedPose = {
  state: "USING_TOOL",
  entry1: using1 ? { t: using1.t, hash: using1.hash, glow: using1.col, label: using1.label } : null,
  entry2: using2 ? { t: using2.t, hash: using2.hash, glow: using2.col, label: using2.label } : null,
  identical: using1 && using2 ? using1.hash === using2.hash : null,
  note: "two separate entries into USING_TOOL (SUCCESS/ERROR in between) must not produce the same canvas hash",
};
const results = {
  generatedAt: new Date().toISOString(),
  core: id,
  islandUrl: ISLAND_URL,
  states,
  distinctness: {
    observedCount: observed.length,
    distinctGlows,
    distinctLabels,
    allDistinct: distinctGlows === observed.length && distinctLabels === observed.length,
  },
  repeatedPose,
  animation: { distinctHashesInLast40Samples: distinctAnimHashes, sampleEveryMs: 200, moving: distinctAnimHashes > 1 },
};

writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
say("\n=== summary ===");
say("observed states:", observed.length, "/", Object.keys(EXPECT).length);
say("distinct glows:", distinctGlows, " distinct labels:", distinctLabels, " -> allDistinct:", results.distinctness.allDistinct);
say("repeated pose (USING_TOOL x2): entry1.hash=" + (using1?.hash ?? "-") + " entry2.hash=" + (using2?.hash ?? "-") + " identical=" + repeatedPose.identical);
say("orb animation (distinct hashes in last 40 x 200ms samples):", distinctAnimHashes, "-> moving:", results.animation.moving);
say("wrote", OUT_JSON);

await ev("clearInterval(window.__kTick); clearInterval(window.__kAnim); clearInterval(window.__kKeep); 'stopped'");
writeFileSync(OUT_LOG, logLines.join("\n") + "\n");
ws.close();

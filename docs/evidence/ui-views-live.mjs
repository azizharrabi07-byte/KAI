// Drive every island view to a real rendered state in the RUNNING PACKAGED app,
// over the WebView2 DevTools Protocol, and record what the page actually said.
//
//   node ui-views-live.mjs                # the app must already be up on :9222
//   KAI_LAUNCH=1 node ui-views-live.mjs   # launch it first (debug port via env)
//
// Nothing here is inferred from the source. Each step drives a real input — a
// renderer-level mouse event, or the exact Tauri event Rust delivers (a `hook`
// relay payload, a `tray` menu id, an OLE drag-drop) — and then reads the DOM the
// app produced, plus a screenshot of the whole island window.
//
// Which view is active cannot be read off a class name: only `overview` carries its
// own name in the class list, the rest are plain `.view`, and `greeting` is a canvas
// with no `.view` at all. So the active view is the one holding the `on` class, mapped
// through the order `buildViews` registers them in (parsed from the source here), and
// `greeting` is detected from its canvas being displayed.
//
// Exit code is 1 unless EVERY expected view was actually reached.
//
// The debug port is injected through the environment (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)
// and is not in the shipped build; see launch-cdp.ps1.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.CDP_PORT ?? "9222";
const CORE = process.env.KAI_CORE ?? "http://127.0.0.1:8788";
const LAUNCH = process.env.KAI_LAUNCH === "1";
const APP = process.env.KAI_APP ?? "C:\\Users\\DELL\\Desktop\\kai\\app\\target\\release\\kai.exe";
const DROP_FILE = process.env.KAI_DROP_FILE ?? join(HERE, "ui-drop-probe.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(line);

/** The order `buildViews` registers the views in — the order they sit in the DOM. */
const VIEW_ORDER = [
  ...readFileSync(join(HERE, "..", "..", "app", "src", "views", "views.ts"), "utf8").matchAll(
    /map\.set\(\s*"([a-zA-Z]+)"/g,
  ),
].map((m) => m[1]);

// ── the REAL Windows cursor ───────────────────────────────────────────────────
// The island does not read DOM mousemove: `island.rs` polls GetCursorPos() and the front
// end reacts to the `cursor` events Rust sends. So an island left alone for its 15 s
// auto-close retracts to `petit` even while a CDP-driven test is clicking inside it —
// which deactivates the drop sequence (no `choose`) and turns the next click into a
// re-expand to the default view. Parking the actual cursor inside the island is what a
// real user's presence does, and it is what makes these runs deterministic.

const WIN_INPUT = join(HERE, "win-input.ps1");

function ps(action, extra = []) {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WIN_INPUT, "-Action", action, ...extra],
    { encoding: "utf8" },
  );
  return JSON.parse(out.trim());
}

/** Move the real cursor to the island's centre. Returns what it did, or why it could not. */
async function parkRealCursor(ws) {
  try {
    const win = ps("rect"); // the kai window, physical pixels, physical origin
    const vp = JSON.parse(
      await evaluate(ws, `JSON.stringify({ w: document.documentElement.clientWidth })`),
    );
    const island = await rectOf(ws, "#island");
    if (!island) return "no #island box to park on";
    const factor = win.width / vp.w;
    const x = Math.round(win.left + island.x * factor);
    const y = Math.round(win.top + island.y * factor);
    ps("move", ["-X", String(x), "-Y", String(y)]);
    return `cursor parked at ${x},${y} (screen)`;
  } catch (err) {
    return `could not park the cursor: ${err.message}`;
  }
}

// ── CDP client ────────────────────────────────────────────────────────────────

async function islandTarget(deadlineMs) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find(
        (t) => t.type === "page" && !t.url.includes("settings") && t.url.includes("tauri.localhost"),
      );
      if (page) return page;
    } catch {
      // the debug port is not up yet
    }
    if (Date.now() > until) throw new Error("no island page target appeared on the debug port");
    await sleep(50);
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`websocket error: ${e.message ?? "unknown"}`));
  });
}

let nextId = 1;
function send(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const res = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error(`eval threw: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ""}`);
  }
  return res.result.value;
}

async function shot(ws, name) {
  const { data } = await send(ws, "Page.captureScreenshot", { format: "png" });
  const bytes = Buffer.from(data, "base64");
  writeFileSync(join(HERE, name), bytes);
  return `${name} (${bytes.length} bytes)`;
}

async function clickXY(ws, x, y) {
  await send(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await sleep(30);
  await send(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(50);
  await send(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1 });
}

/** The island's own events are delivered by Rust through the Tauri event plugin. */
function emit(ws, event, payload) {
  return evaluate(
    ws,
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: ${JSON.stringify(event)}, payload: ${JSON.stringify(payload)} })`,
  );
}

// ── Reading the page ──────────────────────────────────────────────────────────

const READ = `(() => {
  const views = [...document.querySelectorAll('#views .view')];
  const idx = views.findIndex((e) => e.classList.contains('on'));
  const on = idx >= 0 ? views[idx] : null;
  const island = document.getElementById('island');
  const content = document.getElementById('content');
  const greeting = document.getElementById('greeting-canvas');
  const r = island ? island.getBoundingClientRect() : { width: 0, height: 0 };
  return JSON.stringify({
    index: idx,
    onClass: on ? on.className : null,
    greetingShown: greeting ? greeting.style.display === 'block' : false,
    cssWidth: Math.round(r.width),
    cssHeight: Math.round(r.height),
    contentVisible: content ? content.style.opacity === '1' : null,
    text: on ? on.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400) : '',
    pills: [...document.querySelectorAll('#views .view.on .pill .lbl')].map((e) => e.textContent),
  });
})()`;

async function read(ws) {
  const raw = JSON.parse(await evaluate(ws, READ));
  const view = raw.greetingShown ? "greeting" : raw.index >= 0 ? VIEW_ORDER[raw.index] ?? `unknown#${raw.index}` : null;
  return { ...raw, view };
}

/** Wait for the geometry to stop moving, then return the reading. */
async function settle(ws, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let last = await read(ws);
  let stable = 0;
  while (Date.now() < until) {
    await sleep(120);
    const now = await read(ws);
    if (now.cssWidth === last.cssWidth && now.cssHeight === last.cssHeight && now.view === last.view) {
      if (++stable >= 2) return now;
    } else {
      stable = 0;
    }
    last = now;
  }
  return last;
}

async function waitForView(ws, view, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await read(ws);
    if (last.view === view) return last;
    if (Date.now() > until) throw new Error(`never reached view "${view}"; last was ${JSON.stringify(last)}`);
    await sleep(100);
  }
}

/** Poll a predicate over the reading, mostly so the greeting is caught as it plays. */
async function waitFor(ws, predicate, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const now = await read(ws);
    if (predicate(now)) return now;
    if (Date.now() > until) return null;
    await sleep(50);
  }
}

async function rectOf(ws, selector, index = 0) {
  const raw = await evaluate(
    ws,
    `(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!e) return 'null';
      const r = e.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height });
    })()`,
  );
  return raw === "null" ? null : JSON.parse(raw);
}

async function clickSelector(ws, selector, index = 0) {
  const r = await rectOf(ws, selector, index);
  if (!r) throw new Error(`nothing matches ${selector}[${index}]`);
  if (r.w === 0 || r.h === 0) throw new Error(`${selector}[${index}] has no box (w=${r.w} h=${r.h})`);
  await clickXY(ws, r.x, r.y);
  return r;
}

// ── The run ───────────────────────────────────────────────────────────────────

const results = [];
let failures = 0;

async function capture(ws, name, expected, note = "") {
  const state = await read(ws);
  const file = `ui-view-${name}.png`;
  const bytes = await shot(ws, file);
  const ok = expected(state);
  if (!ok) failures++;
  log(`${name.padEnd(14)} view=${state.view} css=${state.cssWidth}x${state.cssHeight} contentVisible=${state.contentVisible} ${ok ? "OK" : "*** NOT THE EXPECTED STATE ***"}`);
  log(`${" ".repeat(14)} text: ${JSON.stringify(state.text)}`);
  log(`${" ".repeat(14)} shot: ${bytes}${note ? `   [${note}]` : ""}`);
  results.push({ name, view: state.view, file, ok, text: state.text });
  return state;
}

const isView = (name) => (s) => s.view === name;
const isViewWith = (name, needle) => (s) => s.view === name && s.text.includes(needle);

async function main() {
  if (LAUNCH) {
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=${PORT}'; Start-Process -FilePath '${APP}'`,
    ]);
    log(`launched ${APP} with the debug port on ${PORT}`);
  }

  const target = await islandTarget(40_000);
  log(`island target: ${target.url} (${target.id})`);
  const ws = await connect(target.webSocketDebuggerUrl);

  // The active view is NAMED by its position in the DOM, so the DOM must hold exactly
  // the views `buildViews` registers — one extra `.view` (a card that nests one) or one
  // missing shifts every name and silently mislabels the screenshots. Check it before
  // reading anything, and fail loudly rather than reporting a wrong name.
  const domViews = JSON.parse(
    await evaluate(
      ws,
      `JSON.stringify({ views: [...document.querySelectorAll('#views .view')].map((e) => e.className),
        children: [...document.getElementById('views').children].map((e) => e.className) })`,
    ),
  );
  log(`#views holds ${domViews.views.length} .view element(s); buildViews registers ${VIEW_ORDER.length}`);
  for (const cls of domViews.views) log(`   ${JSON.stringify(cls)}`);
  if (domViews.views.length !== VIEW_ORDER.length) {
    throw new Error(
      `the DOM holds ${domViews.views.length} views but ${VIEW_ORDER.length} are registered — the view names below would be shifted and wrong`,
    );
  }

  // ── greeting, captured while it plays ──────────────────────────────────────
  // ~2.9 s of animation then it collapses, so it is polled for, not looked for once.
  const greeting = await waitFor(ws, (s) => s.view === "greeting", 30_000);
  if (greeting !== null) {
    await capture(ws, "greeting", isView("greeting"), "the launch animation, caught while it plays");
  } else {
    failures++;
    log("greeting       *** NOT CAUGHT (the animation had already finished) ***");
    results.push({ name: "greeting", view: null, file: null, ok: false, text: "" });
  }

  // ── identity of the Core this app is actually talking to ───────────────────
  const identity = await waitForCore();
  const maint = await getJson(`${CORE}/maintenance/status`);
  log(`core identity: build=${identity.buildId} commit=${identity.gitCommit} pid=${identity.pid} protocol=${identity.protocolVersion}`);
  log(`core maintenance: ${JSON.stringify(maint).slice(0, 300)}`);
  log(`port ${new URL(CORE).port} owner: ${portOwner(identity.pid)}`);
  log(`view order (from buildViews): ${VIEW_ORDER.join(", ")}`);

  // ── clear the leftovers of earlier acceptance runs ────────────────────────
  // An unread HIGH notification from a previous run takes the screen the moment the
  // bridge first sees it, which is exactly how a stale "Approved action failed" card
  // hijacked two captures above in an earlier pass of this very script. Reading them
  // first is test hygiene, not a workaround: the run must start from a known state.
  const opened = await getJson(`${CORE}/notifications?limit=50`);
  const unread = (opened.notifications ?? []).filter((n) => !n.read);
  for (const n of unread) await post(`/notifications/${n.id}/read`, {});
  log(`cleared ${unread.length} unread notification(s) left by earlier runs`);

  // The greeting collapses to `petit`; the tray's "Open KAI" is the real way back.
  await emit(ws, "tray", "open");
  await settle(ws);
  log(`presence: ${await parkRealCursor(ws)}`);
  await capture(ws, "overview", isViewWith("overview", "Hermes"), "tray → Open KAI");

  // ── the ticker: a live Claude Code session on the focused pill ─────────────
  // The pills are the NON-focused agents, so index 1 is VS Code while Hermes holds
  // the focus. Clicking it moves the focus and the left card becomes the ticker.
  await clickSelector(ws, ".pill", 1);
  await settle(ws);
  await emit(ws, "hook", { hook_event_name: "SessionStart", cwd: "C:\\Users\\DELL\\Desktop\\kai" });
  await emit(ws, "hook", {
    hook_event_name: "PreToolUse",
    cwd: "C:\\Users\\DELL\\Desktop\\kai",
    tool_name: "Bash",
    tool_input: { command: "npm run typecheck" },
  });
  await sleep(500);
  await capture(
    ws,
    "ticker",
    (s) => s.view === "overview" && s.text.includes("Exécute") && !s.pills.includes("VS Code"),
    "hook SessionStart + PreToolUse on the focused VS Code pill",
  );

  // ── the integration card (the other half of the overview) ─────────────────
  await clickSelector(ws, ".pill", 0);
  await settle(ws);
  await capture(ws, "overview-card", isViewWith("overview", "Control layer"), "integration card after focusing another pill");

  // ── header tabs: prompt, sessions, upload, settings ───────────────────────
  await clickSelector(ws, "#header .tabs .tab", 1); // Ask
  await waitForView(ws, "prompt");
  await capture(ws, "prompt", isView("prompt"), "header → Ask");

  // A real turn through the app's own chat path (Rust → Hermes / Core).
  await evaluate(ws, `(() => { document.querySelector('.chat-input').focus(); return true; })()`);
  await send(ws, "Input.insertText", { text: "Reply with exactly: KAI-UI-VIEWS-OK" });
  await send(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  let replied = false;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const s = await read(ws);
    if ((s.text.match(/KAI-UI-VIEWS-OK/g) ?? []).length >= 2) {
      replied = true;
      break;
    }
    if (s.view !== "prompt") break;
    // Keep the island open across a turn that can take longer than its auto-close:
    // the reply lands in the chat either way, but the view under test has to still be
    // the one on screen when the capture is taken.
    if (i % 10 === 9) log(`presence (mid-turn): ${await parkRealCursor(ws)}`);
  }
  if ((await read(ws)).cssWidth !== 640) log(`presence (after turn): ${await parkRealCursor(ws)}`);
  await capture(ws, "prompt-reply", (s) => s.view === "prompt" && replied, replied ? "a real model turn, echoed into the chat log" : "NO REPLY SEEN");

  await clickSelector(ws, "#header .tabs .tab", 2); // Sessions
  await waitForView(ws, "sessions");
  await capture(ws, "sessions", isView("sessions"), "header → Sessions");

  await clickSelector(ws, "#header .tabs .tab", 3); // Drop
  await waitForView(ws, "upload");
  await capture(ws, "upload", isView("upload"), "header → Drop");

  await clickSelector(ws, "#header button[title=Settings]", 0);
  await waitForView(ws, "settings");
  await capture(ws, "settings", isView("settings"), "header → Settings (in-island)");

  // ── the drop sequence, driven by the same drag-drop events OLE delivers ────
  writeFileSync(DROP_FILE, "KAI ui-views-live drop probe\n");
  await emit(ws, "tauri://drag-enter", { paths: [DROP_FILE], position: { x: 320, y: 30 } });
  await waitForView(ws, "upload");
  await emit(ws, "tauri://drag-over", { position: { x: 320, y: 40 } });
  await emit(ws, "tauri://drag-drop", { paths: [DROP_FILE], position: { x: 320, y: 40 } });
  await waitForView(ws, "uploading", 10_000);
  await capture(ws, "uploading", isView("uploading"), `real drag-drop of ${DROP_FILE}`);
  // Record the trail: `choose` is reached by the drop sequence's own timer, and if the
  // island leaves it (an ingest failure goes to `note`, then back to the default view)
  // the sequence of views seen is the diagnosis.
  const trail = [];
  const until = Date.now() + 18_000;
  let chose = false;
  while (Date.now() < until) {
    const s = await read(ws);
    if (trail[trail.length - 1] !== s.view) trail.push(s.view);
    if (s.view === "choose") {
      chose = true;
      break;
    }
    if (trail.length === 1 && trail[0] === "uploading") log(`presence (drop): ${await parkRealCursor(ws)}`);
    await sleep(150);
  }
  log(`drop trail: ${trail.join(" -> ")}`);
  if (!chose) {
    // Say what the island did instead of claiming a render that never happened.
    const now = await read(ws);
    await capture(ws, "choose", () => false, `NEVER REACHED choose (trail: ${trail.join(" -> ")}; now ${now.view})`);
    throw new Error(`the drop sequence never produced "choose" (trail: ${trail.join(" -> ")})`);
  }
  await capture(ws, "choose", isView("choose"), "the drop sequence's own transition");

  // ── the note view, on a real failure the product already reports ──────────
  // A drop whose file is gone: `ingest_file` fails and the island must say so, in the
  // note, rather than silently doing nothing. It auto-returns to the default view
  // after 2.4 s, so it is captured as soon as it appears.
  await emit(ws, "tauri://drag-drop", { paths: [join(HERE, "ui-drop-missing.txt")], position: { x: 320, y: 40 } });
  await waitForView(ws, "note", 10_000);
  await capture(ws, "note", isView("note"), "a drop of a file that is not there (the ingest failure path)");
  await sleep(2600);

  // ── a Core approval, parked for real, then decided from the card ──────────
  const writePath = join(HERE, "ui-approval-probe.txt");
  const parked = await post("/capabilities/filesystem/test", {
    // The OP name, not the tool id: `action` carries the action's name.
    action: "write",
    input: { path: writePath, content: "written through the approval card\n" },
  });
  log(`core park: HTTP ${parked.status} approvalId=${parked.body?.approvalId ?? "none"} executed=${parked.body?.executed ?? "?"}`);
  // The island's bridge re-reads pending approvals on a 5 s poll, so the card appears late.
  await waitForView(ws, "approval", 25_000);
  await capture(ws, "approval", isView("approval"), `Core parked ${parked.body?.approvalId ?? "?"}`);

  await clickSelector(ws, ".view.on .btn.primary", 0); // Allow
  await sleep(2500);
  // The card must be GONE once the request behind it was decided: a card that outlives
  // its request is the "I keep clicking allow and nothing happens" defect.
  await capture(
    ws,
    "after-allow",
    (s) => s.view !== "approval",
    "Allow was clicked; the card must leave with the request it was drawn for",
  );
  let wrote = "NOT WRITTEN";
  try {
    wrote = JSON.stringify(readFileSync(writePath, "utf8").trim());
  } catch (e) {
    wrote = `unreadable: ${e.message}`;
  }
  log(`approved write on disk: ${wrote}`);

  // ── the Claude Code approval card (the relay path on Windows) ─────────────
  await focusClaudePill(ws);
  await emit(ws, "hook", {
    hook_event_name: "PermissionRequest",
    request_id: "ui-views-probe-1",
    session_id: "ui-views-probe",
    cwd: "C:\\Users\\DELL\\Desktop\\kai",
    tool_name: "Bash",
    tool_input: { command: "rm -rf build/probe" },
  });
  await waitForView(ws, "approval", 10_000);
  await capture(ws, "approval-hook", isView("approval"), "hook PermissionRequest (Claude Code relay)");
  await clickSelector(ws, ".view.on .btn.secondary", 0); // Deny
  await sleep(800);

  // ── the question view (Claude Code asked something) ───────────────────────
  await focusClaudePill(ws);
  await emit(ws, "hook", {
    hook_event_name: "Notification",
    cwd: "C:\\Users\\DELL\\Desktop\\kai",
    message: "Which search engine should I use?",
  });
  await waitForView(ws, "question", 10_000);
  await capture(ws, "question", isViewWith("question", "asking a question"), "hook Notification ending in ?");

  // ── error and finished ────────────────────────────────────────────────────
  await emit(ws, "hook", { hook_event_name: "StopFailure", cwd: "C:\\Users\\DELL\\Desktop\\kai", message: "the tool call failed" });
  await waitForView(ws, "error", 10_000);
  await capture(ws, "error", isViewWith("error", "stopped"), "hook StopFailure");

  await emit(ws, "hook", { hook_event_name: "Stop", cwd: "C:\\Users\\DELL\\Desktop\\kai", message: "finished the task" });
  await waitForView(ws, "finished", 10_000);
  await capture(ws, "finished", isViewWith("finished", "finished"), "hook Stop");

  // ── confused: three slaps on KAI itself ───────────────────────────────────
  await clickSelector(ws, "#header .tabs .tab", 0); // overview, KAI is visible there
  await settle(ws);
  const bot = JSON.parse(
    await evaluate(
      ws,
      `(() => { const r = document.getElementById('bot-canvas').getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
    ),
  );
  for (let i = 0; i < 3; i++) {
    await clickXY(ws, bot.x, bot.y);
    await sleep(250);
  }
  await waitForView(ws, "confused", 10_000);
  await capture(ws, "confused", isView("confused"), "three real clicks on KAI");

  // ── the `empty` view: implemented, and unreachable today ──────────────────
  // `defaultView()` answers "empty" when there are no tasks, and three of them (Hermes,
  // OpenCode, VS Code) are ALWAYS on — so no product path can switch to this view and no
  // driver can honestly claim to have rendered it. It is not a placeholder: it is fully
  // implemented, it sits in the DOM, and it is the correct fallback if that ever changes.
  // Read it from the DOM and say exactly that, rather than dressing a forced render as a
  // live one.
  const empty = JSON.parse(
    await evaluate(
      ws,
      `(() => {
        const v = [...document.querySelectorAll('#views .view')][${VIEW_ORDER.indexOf("empty")}];
        return JSON.stringify({ present: !!v, on: v ? v.classList.contains('on') : false, text: v ? v.innerText.replace(/\\s+/g, ' ').trim() : null });
      })()`,
    ),
  );
  log(`empty          present=${empty.present} active=${empty.on} text=${JSON.stringify(empty.text)}`);
  log(`               [UNREACHABLE by any product path: the three control-layer pills are always on.`);
  log(`                Implemented, in the DOM, and correct if that ever stops being true — not a placeholder.]`);

  // ── summary ───────────────────────────────────────────────────────────────
  log("");
  log("── views reached ──");
  for (const r of results) {
    log(`${(r.view ?? "NONE").padEnd(14)} ${r.ok ? "OK  " : "FAIL"} ${r.name.padEnd(14)} ${r.file ?? ""}`);
  }
  log("");
  log(`${results.filter((r) => r.ok).length}/${results.length} expected states reached (${failures} not the expected state)`);
  ws.close();
  return failures;
}

/** VS Code must hold the focus for the hook-driven alert views to surface. */
async function focusClaudePill(ws) {
  // The pills only exist on the overview, so make that the active view first — after
  // the note/approval cards the island is on a view that has no pills at all.
  const before = await read(ws);
  if (before.view !== "overview") {
    await clickSelector(ws, "#header .tabs .tab", 0);
    await settle(ws);
  }
  const state = await read(ws);
  if (state.pills.includes("VS Code")) {
    await clickSelector(ws, ".pill", state.pills.indexOf("VS Code"));
    await settle(ws);
  }
}

// ── Core helpers ──────────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(`${CORE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed };
}

async function getJson(url) {
  return (await fetch(url)).json();
}

/** The Core answers only a few seconds after the window appears; wait for it. */
async function waitForCore(timeoutMs = 40_000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      const res = await fetch(`${CORE}/identity`);
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() > until) throw new Error(`no Core identity on ${CORE} after ${timeoutMs}ms (${last})`);
    await sleep(300);
  }
}

/** Which pid owns the port, read from netstat — identity alone proves which Core answers. */
function portOwner(pid) {
  try {
    const port = new URL(CORE).port;
    const out = execFileSync("cmd", ["/c", "netstat -ano"], { encoding: "utf8" });
    const line = out.split(/\r?\n/).find((l) => l.includes(`:${port} `) && l.includes("LISTENING"));
    if (line === undefined) return "none";
    const owner = line.trim().split(/\s+/).pop();
    return `${owner}${owner === String(pid) ? " (matches identity)" : " (MISMATCH with identity)"}`;
  } catch (err) {
    return `unreadable: ${err.message}`;
  }
}

main()
  .then((failed) => {
    if (failed > 0) {
      log("RESULT: FAILED — at least one view did not reach its expected state");
      process.exit(1);
    }
    log("RESULT: every expected view reached its expected state");
  })
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exit(1);
  });

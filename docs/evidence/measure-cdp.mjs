// Measure the real launched KAI app: for every WebView2 page target, its own
// window geometry, the page it hosts, and whether the main window is a real one.
const PORT = process.argv[2] || "9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function list() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await res.json()).filter((t) => t.type === "page");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error("ws error"));
  });
}

let id = 1;
function cdp(ws, method, params = {}) {
  const mine = id++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === mine) {
        ws.removeEventListener("message", onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
}

async function evaluate(ws, expr) {
  const r = await cdp(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.text };
  return r.result.value;
}

const out = [];
for (const t of await list()) {
  const rec = { url: t.url, title: t.title, id: t.id };
  const ws = await connect(t.webSocketDebuggerUrl);
  try {
    rec.geom = await evaluate(
      ws,
      `({ outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight,
          screenX: window.screenX, screenY: window.screenY, dpr: window.devicePixelRatio,
          docTitle: document.title, bodyWin: document.body?.dataset?.window ?? null,
          hasRoot: !!document.getElementById("root"), probe: typeof window.__kaiShell !== "undefined",
          probeHasCore: window.__kaiShell ? window.__kaiShell.hasCore() : null,
          probeRoute: window.__kaiShell ? window.__kaiShell.getRoute() : null,
          tauriInternals: typeof window.__TAURI_INTERNALS__ !== "undefined",
          rootChildren: document.getElementById("root") ? document.getElementById("root").childElementCount : -1,
          visibleText: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 240) })`
    );
  } catch (e) {
    rec.geom = { error: String(e.message) };
  }
  ws.close();
  out.push(rec);
}
console.log(JSON.stringify(out, null, 2));
// What the OWNER called "the main window", reported as the OS sees it.
const main = out.find((r) => r.url.includes("shell.html"));
console.log(
  "ACCEPTANCE: main-window(shell.html) outer =",
  main?.geom?.outerW + "x" + main?.geom?.outerH,
  "| inner =", main?.geom?.innerW + "x" + main?.geom?.innerH,
  "| island outer =", (out.find((r) => /tauri\.localhost\/$/.test(r.url))?.geom?.outerW ?? "?") + "x" + (out.find((r) => /tauri\.localhost\/$/.test(r.url))?.geom?.outerH ?? "?")
);

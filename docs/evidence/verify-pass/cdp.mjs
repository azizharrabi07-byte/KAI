// cdp.mjs — evaluate an expression in one of the Tauri WebView2 pages over CDP.
//
//   node cdp.mjs <urlSubstring> <expression>
//
// The app runs with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222,
// so both windows (the island at tauri.localhost/ and settings at
// tauri.localhost/settings.html) are debuggable Chromium pages. This picks the target
// whose URL contains <urlSubstring>, evaluates <expression> with returnByValue, and
// prints the JSON result. Nothing here is app code; it is the harness.

const urlSub = process.argv[2];
const expr = process.argv[3];
if (urlSub === undefined || expr === undefined) {
  console.error("usage: node cdp.mjs <urlSubstring> <expression>");
  process.exit(2);
}

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
// A leading '=' forces an EXACT url match, because "tauri.localhost/" is also a
// prefix of "tauri.localhost/settings.html" — the settings page matched first and
// a glow query against it returned null (the wrong-window trap, live).
const exact = urlSub.startsWith("=");
const wanted = exact ? urlSub.slice(1) : urlSub;
const target = list.find((t) => t.type === "page" && typeof t.url === "string" && (exact ? t.url === wanted : t.url.includes(wanted)));
if (target === undefined) {
  console.error("no page target matching", JSON.stringify(urlSub), "->", list.map((t) => t.url));
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
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = (e) => reject(new Error("ws error " + String(e && e.message)));
});
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const r = await send("Runtime.evaluate", {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
});
if (r.exceptionDetails) {
  console.error("EXCEPTION:", JSON.stringify(r.exceptionDetails, null, 2));
  ws.close();
  process.exit(4);
}
console.log(typeof r.result.value === "string" ? r.result.value : JSON.stringify(r.result.value, null, 2));
ws.close();

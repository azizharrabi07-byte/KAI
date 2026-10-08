// Tiny Chrome DevTools Protocol driver for KAI's WebView2 windows.
//
// Node 22+ ships a global WebSocket, so this needs no dependencies at all.
// The app is launched with --remote-debugging-port=9222 (see launch-cdp.cmd);
// nothing in the shipped build opens that port.
//
//   node cdp.mjs targets
//   node cdp.mjs eval   "<javascript>"        [--target island|settings]
//   node cdp.mjs shot   <out.png>             [--target island|settings]
//   node cdp.mjs move   <x> <y>               [--target island|settings]
//   node cdp.mjs click  <x> <y>               [--target island|settings]
//   node cdp.mjs type   "<text>"              [--target island|settings]
//   node cdp.mjs key    <key>                 [--target island|settings]

const PORT = process.env.CDP_PORT || "9222";
const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const which = flag("--target", "island");

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return res.json();
}

async function pickTarget() {
  const list = await targets();
  const pages = list.filter((t) => t.type === "page");
  if (pages.length === 0) throw new Error("no page targets on the debug port");
  if (which === "settings") {
    const t = pages.find((p) => p.url.includes("settings"));
    if (!t) throw new Error("settings window not found");
    return t;
  }
  const t = pages.find((p) => !p.url.includes("settings")) || pages[0];
  return t;
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
  const res = await send(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`eval threw: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description ?? "")}`);
  }
  return res.result.value;
}

async function mouse(ws, type, x, y) {
  await send(ws, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" ? "none" : "left",
    buttons: type === "mouseMoved" ? 0 : 1,
    clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0,
  });
}

async function main() {
  if (cmd === "targets") {
    const list = await targets();
    for (const t of list) console.log(t.type, "|", t.title, "|", t.url);
    return;
  }

  const target = await pickTarget();
  const ws = await connect(target.webSocketDebuggerUrl);

  switch (cmd) {
    case "eval": {
      const value = await evaluate(ws, argv[1]);
      console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
      break;
    }
    case "shot": {
      const out = argv[1];
      const { data } = await send(ws, "Page.captureScreenshot", { format: "png" });
      const fs = await import("node:fs");
      fs.writeFileSync(out, Buffer.from(data, "base64"));
      console.log(`wrote ${out} (${Buffer.from(data, "base64").length} bytes)`);
      break;
    }
    case "move": {
      const x = Number(argv[1]);
      const y = Number(argv[2]);
      // Two moves: browsers only fire mouseover/mouseenter when the position
      // actually changes between events, and DOM inspection tools are not the
      // only thing that depends on it.
      await mouse(ws, "mouseMoved", x - 4, y - 4);
      await new Promise((r) => setTimeout(r, 60));
      await mouse(ws, "mouseMoved", x, y);
      console.log(`moved to ${x},${y}`);
      break;
    }
    case "click": {
      const x = Number(argv[1]);
      const y = Number(argv[2]);
      await mouse(ws, "mouseMoved", x, y);
      await new Promise((r) => setTimeout(r, 40));
      await mouse(ws, "mousePressed", x, y);
      await new Promise((r) => setTimeout(r, 60));
      await mouse(ws, "mouseReleased", x, y);
      console.log(`clicked ${x},${y}`);
      break;
    }
    case "type": {
      await send(ws, "Input.insertText", { text: argv[1] });
      console.log(`typed ${argv[1].length} chars`);
      break;
    }
    case "key": {
      const key = argv[1];
      const map = {
        Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
        Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
        Tab: { code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
      };
      const k = map[key] ?? { code: key, windowsVirtualKeyCode: 0 };
      await send(ws, "Input.dispatchKeyEvent", { type: "keyDown", key, ...k });
      await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", key, ...k });
      console.log(`key ${key}`);
      break;
    }
    case "emulate": {
      // Pins the page viewport to a given CSS size for one capture. Used to show
      // what the island renders like at the viewport this host's WebView reports
      // when the window is sized from the display scale factor (554x246) — the
      // state is emulated, and any screenshot taken this way says so.
      const w = Number(argv[1]);
      const h = Number(argv[2]);
      if (w === 0) {
        await send(ws, "Emulation.clearDeviceMetricsOverride", {});
        console.log("emulation cleared");
        break;
      }
      await send(ws, "Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 0,
        mobile: false,
      });
      console.log(`viewport pinned to ${w}x${h} CSS px`);
      break;
    }
    case "drag": {
      // Synthetic drag at the renderer. Tauri's file-drop arrives over OLE
      // (IDropTarget on the webview HWND), not through Blink, so this is
      // expected NOT to reach the app — the point of having it is to test that
      // instead of assuming it.
      const file = argv[1];
      const x = Number(argv[2] ?? 360);
      const y = Number(argv[3] ?? 60);
      const data = {
        items: [{ mimeType: "application/octet-stream", data: file, title: file.split(/[\\/]/).pop() }],
        files: [file],
        dragOperationsMask: 1,
      };
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await send(ws, "Input.dispatchDragEvent", { type, x, y, data });
        await new Promise((r) => setTimeout(r, 120));
      }
      console.log(`dispatched dragEnter/dragOver/drop at ${x},${y} with ${file}`);
      break;
    }
    case "domdrop": {
      // A plain DOM drag-and-drop, the way a web page would see one.
      const file = argv[1];
      const x = Number(argv[2] ?? 360);
      const y = Number(argv[3] ?? 60);
      const value = await evaluate(ws, `(() => {
        const target = document.elementFromPoint(${x}, ${y}) || document.body;
        const dt = new DataTransfer();
        dt.items.add(new File(["kai"], ${JSON.stringify(file.split(/[\\\\/]/).pop())}));
        const events = {};
        for (const type of ["dragenter", "dragover", "drop"]) {
          const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${x}, clientY: ${y} });
          events[type] = target.dispatchEvent(ev);
        }
        return JSON.stringify({ target: target.id || target.className || target.tagName, events });
      })()`);
      console.log(`dom drop on ${value}`);
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
  ws.close();
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

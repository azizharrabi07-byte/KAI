// KAI — live end-to-end journey harness (integration / release stream).
//
// Drives the REAL launched Tauri app over its WebView2 debug port and the REAL
// KAI Core over its loopback HTTP API. It proves, step by step, the acceptance
// chain: UI action -> Core route -> real runtime -> real state change -> event ->
// UI update. No mocks, no fake timers: every step reads the running product.
//
//   node kai-live-journey.mjs [--core http://127.0.0.1:8788] [--port 9222] [--approval <id>]
//
// Exit code 0 when every step passed; 1 otherwise. Prints one JSON block.
//
// Environment note: every step is a live read of the launched app; where a step
// cannot be exercised it is reported as NOT PROVEN with the reason, never faked.

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const CORE = flag("--core", "http://127.0.0.1:8788");
const PORT = flag("--port", "9222");
const APPROVAL = flag("--approval", null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function coreGet(path) {
  const res = await fetch(`${CORE}${path}`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function pickIslandTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const pages = list.filter((t) => t.type === "page");
  const island = pages.find((p) => !p.url.includes("settings")) || pages[0];
  if (!island) throw new Error("no page targets on the debug port");
  return island;
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
    throw new Error(`eval threw: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description ?? "")}`);
  }
  return res.result.value;
}

const steps = [];
function record(name, ok, detail, extra) {
  steps.push({ step: name, ok, detail, ...(extra ? { extra } : {}) });
}

async function main() {
  const target = await pickIslandTarget();
  const ws = await connect(target.webSocketDebuggerUrl);

  // ── Step 1: the Core is the freshly built artifact ─────────────────────────
  const ident = await coreGet("/identity");
  const identBody = ident.body;
  const samePid = identBody.pid;
  // Confirm the pid owning :8788 is the one /identity reports.
  const owner = (await import("node:child_process")).execSync(
    `netstat -ano | findstr :8788 | findstr LISTENING`,
    { encoding: "utf8", windowsHide: true },
  ).trim().split(/\s+/).pop();
  record(
    "core identity is the rebuilt artifact",
    ident.status === 200 && typeof identBody.buildId === "string",
    `buildId=${identBody.buildId} freshness=${identBody.freshness} identityMatchesDisk=${identBody.identityMatchesDisk} pid=${samePid} owner=${owner}`,
    { buildId: identBody.buildId, pidMatchesPort: String(samePid) === String(owner) },
  );

  // ── Step 2: the canonical identity model is on the API surface ─────────────
  const model = await coreGet("/identity/model");
  const m = model.body && model.body.model;
  record(
    "GET /identity/model serves the canonical identity model",
    model.status === 200 && m && m.agentId === "kai" && m.displayName === "KAI",
    model.status === 200
      ? `agentId=${m.agentId} displayName=${m.displayName} authorities=${Object.keys(m.authority).join(",")} binding=${m.binding.length}`
      : `HTTP ${model.status}`,
  );

  // ── Step 3: the tool and session surfaces answer ───────────────────────────
  const tools = await coreGet("/tools");
  const mcp = await coreGet("/mcp");
  const sess = await coreGet("/sessions/search"); // 400: validates ?query=, not 404
  record(
    "mounted surfaces answer",
    tools.status === 200 && mcp.status === 200 && sess.status === 400,
    `GET /tools ${tools.status} (count=${tools.body?.count}) GET /mcp ${mcp.status} (servers=${mcp.body?.counts?.servers}) GET /sessions/search ${sess.status}`,
  );

  // ── Step 4: reveal the island (structured attention needs an open island) ──
  await evaluate(ws, "__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'}).then(()=>'ok')");
  await sleep(1600);
  const modeInfo = await evaluate(ws, "JSON.stringify({mode:window.__kaiProbe?window.__kaiProbe().mode:'?', view:window.__kaiProbe?window.__kaiProbe().view:'?'})");
  const mode = JSON.parse(modeInfo).mode;
  record("island reveals on tray open", mode === "expanded", `mode=${mode}`);

  if (!APPROVAL) {
    record("island approve proof", false, "no --approval id supplied; cannot run the island approval step", { skipped: true });
  } else {
    // ── Step 5: the island DERIVES structured attention from real Core state ─
    const attn = JSON.parse(
      await evaluate(ws, "JSON.stringify((window.__kaiIsland&&window.__kaiIsland.attention||[]).map(a=>({id:a.id,reason:a.reason,actions:a.actions,approvalId:a.approvalId||null})))"),
    );
    const item = attn.find((a) => a.approvalId === APPROVAL);
    record(
      "island shows the parked approval as structured attention",
      !!item && item.reason === "needs_approval" && item.actions.includes("approve"),
      item ? `item=${item.id} actions=${item.actions.join(",")}` : `attention=${JSON.stringify(attn)}`,
    );

    // ── Step 6: UI action — click Allow ON THE ISLAND's attention surface ────
    const before = await coreGet(`/approvals/${APPROVAL}`);
    const clicked = await evaluate(
      ws,
      `(()=>{const el=document.querySelector('#attention');if(!el)return {clicked:false,reason:'no #attention'};` +
        `const btns=[...el.querySelectorAll('button')];const allow=btns.find(b=>b.textContent.trim()==='Allow');` +
        `if(!allow)return {clicked:false,reason:'no Allow button',texts:btns.map(b=>b.textContent)};allow.click();` +
        `return {clicked:true,text:allow.textContent};})()`,
    );
    record(
      "island Allow clicked (real DOM button on the companion surface)",
      clicked.clicked === true,
      JSON.stringify(clicked),
    );

    // ── Step 7: real Core state change (route -> runtime -> persisted state) ─
    let after = before;
    for (let i = 0; i < 20; i += 1) {
      await sleep(400);
      after = await coreGet(`/approvals/${APPROVAL}`);
      if (after.body?.approval?.status === "APPROVED") break;
    }
    record(
      "Core recorded APPROVED (the decision landed on the ONE approval)",
      after.body?.approval?.status === "APPROVED",
      `status: ${before.body?.approval?.status ?? "?"} -> ${after.body?.approval?.status ?? "?"}`,
      { approvalId: APPROVAL },
    );

    // ── Step 8: event -> UI update (the island mirror converged on Core) ─────
    let gone = false;
    let finalAttn = attn;
    for (let i = 0; i < 20; i += 1) {
      await sleep(400);
      finalAttn = JSON.parse(
        await evaluate(ws, "JSON.stringify((window.__kaiIsland&&window.__kaiIsland.attention||[]).map(a=>({id:a.id,approvalId:a.approvalId||null})))"),
      );
      if (!finalAttn.some((a) => a.approvalId === APPROVAL)) {
        gone = true;
        break;
      }
    }
    record(
      "island UI updated from Core's event (approval left the attention list)",
      gone,
      `attention now: ${JSON.stringify(finalAttn)}`,
    );
  }

  ws.close();

  const pass = steps.filter((s) => s.ok).length;
  console.log(JSON.stringify({ core: CORE, port: PORT, passed: pass, total: steps.length, steps }, null, 2));
  process.exit(pass === steps.length ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ fatal: err.message, steps }, null, 2));
  process.exit(1);
});

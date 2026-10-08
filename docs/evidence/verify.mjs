// Deterministic parity verification for the three approved fixes.
//
//   node verify.mjs [--store-key <path-to-key-file>]
//
// Run against a KAI build launched with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222.
//
// Every check drives the app through its own entry points - a synthetic click on
// the real control, or the same Tauri command the UI calls - so the result does
// not depend on the shared OS cursor (a human moving the mouse drifts it between
// a move and a click, which is what made an earlier manual probe report a
// non-existent bug). Read-only for the repository.

const PORT = process.env.CDP_PORT || '9222';
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const island = list.filter((t) => t.type === 'page').find((p) => !p.url.includes('settings'));
  if (!island) throw new Error('no island target on the debug port');
  return island;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('websocket error'));
  });
}

let nextId = 1;
function send(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const on = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', on);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const res = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error('eval threw: ' + res.exceptionDetails.text);
  return res.result.value;
}

const results = [];
function record(name, pass, detail) {
  results.push({ check: name, pass });
  console.log(`\n### ${name}: ${pass ? 'PASS' : 'FAIL'}`);
  console.log(JSON.stringify(detail, null, 2));
}

// Click the app's own control, the same handler a real click reaches.
const CLICK_CONTROL = (title) => `(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === ${JSON.stringify(title)});
  if (!b) return 'not found';
  b.click();
  return 'clicked';
})()`;

// Real geometry of the active card against the box its view gives it.
const CARD_FIT = `(() => {
  const island = document.getElementById('island');
  const views = [...document.querySelectorAll('#views > .view')];
  const i = views.findIndex(v => v.classList.contains('on'));
  const view = views[i >= 0 ? i : 0];
  const card = view.querySelector('.int-card');
  if (!card) return JSON.stringify({ error: 'no int-card in the active view', viewIndex: i });
  const box = card.closest('.card');
  const cb = card.getBoundingClientRect(), bb = box.getBoundingClientRect(), ib = island.getBoundingClientRect();
  return JSON.stringify({
    viewIndex: i,
    sessionRows: card.querySelectorAll('.int-row').length,
    meta: [...card.querySelectorAll('.int-meta span')].map(s => s.textContent),
    island: [Math.round(ib.width), Math.round(ib.height)],
    content: Math.round(cb.height),
    box: Math.round(bb.height),
    overflowPx: Math.round(cb.bottom - bb.bottom),
    fits: cb.bottom <= bb.bottom + 1,
  });
})()`;

// Only elements that are actually painted: an ancestor with opacity 0 is an
// off-stage layer (the file-drop choreography), not visible clipping.
const VISIBLE_CLIP = `(() => {
  const island = document.getElementById('island').getBoundingClientRect();
  const bad = [];
  for (const e of document.querySelectorAll('#views > .view.on *')) {
    const b = e.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    let n = e, hidden = false;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') { hidden = true; break; }
      n = n.parentElement;
    }
    if (hidden) continue;
    if (b.right > island.right + 1 || b.bottom > island.bottom + 1)
      bad.push(((typeof e.className === 'string' && e.className) || e.tagName) + ' right=' + Math.round(b.right) + ' bottom=' + Math.round(b.bottom));
  }
  return JSON.stringify({ islandBottom: Math.round(island.bottom), visibleOverflow: bad.slice(0, 8), count: bad.length });
})()`;

(async () => {
  const ws = await connect((await pickTarget()).webSocketDebuggerUrl);

  if (argv.includes('--store-key')) {
    const fs = await import('node:fs');
    const key = fs.readFileSync(argv[argv.indexOf('--store-key') + 1], 'utf8').trim();
    const out = await evaluate(ws, `(async () => { try { await window.__TAURI_INTERNALS__.invoke('secret_set', { key: 'hermes-api-key', value: ${JSON.stringify(key)} }); return 'stored'; } catch (e) { return 'failed: ' + e.message; } })()`);
    console.log('### hermes-api-key: ' + out);
  }

  // 1. layout: the real card must fit the box the overview view gives it.
  await evaluate(ws, CLICK_CONTROL('Overview'));
  await sleep(900);
  const fit = JSON.parse(await evaluate(ws, CARD_FIT));
  record('1. overview card fits its box (real session rows, no clipping)', fit.fits === true && fit.overflowPx <= 0, fit);

  // 2. nothing painted may escape the island surface.
  const clip = JSON.parse(await evaluate(ws, VISIBLE_CLIP));
  record('2. nothing visible escapes the island surface', clip.count === 0, clip);

  // 3. the Settings gear responds (same handler the real click reaches).
  await evaluate(ws, CLICK_CONTROL('Settings'));
  await sleep(700);
  const gear = JSON.parse(await evaluate(ws, `(() => {
    const vs = [...document.querySelectorAll('#views > .view')];
    const i = vs.findIndex(v => v.classList.contains('on'));
    return JSON.stringify({ viewIndex: i, isSettingsView: !!(vs[i] && vs[i].querySelector('.settings-rows')) });
  })()`));
  record('3. Settings gear switches the island to its settings view', gear.isSettingsView === true, gear);

  // 4. a real chat turn through the Rust chain (Hermes /v1/runs).
  const chat = JSON.parse(await evaluate(ws, `(async () => {
    const t0 = performance.now();
    try {
      const reply = await window.__TAURI_INTERNALS__.invoke('chat_send', {
        query: 'Reply with exactly this token and nothing else: KAI-CHAT-OK', context: null,
      });
      return JSON.stringify({ ok: true, ms: Math.round(performance.now() - t0), text: (reply && reply.text) || reply });
    } catch (e) {
      return JSON.stringify({ ok: false, ms: Math.round(performance.now() - t0), error: String((e && e.message) || e) });
    }
  })()`));
  record('4. chat returns real model text via Hermes /v1/runs',
    chat.ok === true && /KAI-CHAT-OK/.test(String(chat.text)), chat);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} checks passed =====`);
  if (failed.length) console.log('failed: ' + failed.map((f) => f.check).join(' | '));
  ws.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('VERIFY FAILED:', e.message); process.exit(2); });

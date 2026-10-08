# KAI — parity fixes: card overflow, Settings gear, chat path

Three defects from the parity audit (`docs/parity-audit.md` §5a, §8a, §10) were
addressed and verified against the running app. Everything below is a file:line, a
measured number, or a live result; nothing is inferred.

Audit items closed: **§5a** (Hermes card clipped), **§8a** (Settings gear), **§10**
(no working LLM path). Build state at the time of writing: `npm run tauri build`
completes cleanly (`tsc --noEmit` + `vite build` pass), producing
`app/target/release/kai.exe` and
`app/target/release/bundle/nsis/KAI_0.1.1_x64-setup.exe`.

---

## Fix 1 — Overview card clipped at the bottom

### What was wrong

The overview view declared a height of 160 in `app/src/core/layout.ts`. Its card
inherits upstream CSS `.card { height: 100%; overflow: hidden }`
(`app/src/style.css:276`) and therefore got a **105 px** box. The measured content
of the card is taller than that:

| State | Card content height (CSS px) |
|---|---|
| No session rows | 95 |
| One session row | 113 |
| Three real Hermes session rows | **151** |

The three-row case is the real worst case: three live Hermes session rows after the
api-server key had been stored. At 151 px of content in a 105 px box,
`.card`'s `overflow: hidden` cropped the bottom row of the Hermes card — the
"Refresh" / "Settings…" links — which is exactly what the user's screenshot showed.

### What changed

One number, using the file's own per-view-height mechanism:

- `app/src/core/layout.ts:76` — `overview: { height: 160 → 210, … }`.

The same mechanism already gave `upload` 176 (`layout.ts:83`) and `mail` 240
(`layout.ts:88`), so no new machinery was introduced. At island height 210 the
card box is **158 px**, so the 151 px worst case fits with **7 px to spare**. No CSS
`overflow` was hidden to achieve this, and no session rows were dropped.

### How it was verified

- Measured card content against the three-row case in the running app: 151 px inside
  a 158 px box (`worstFits: true`).
- `docs/evidence/verify.mjs` check 1 clicks the app's own Overview control, then
  measures the real card against the box its view gives it and asserts
  `content <= box`, reporting the live session-row count alongside the numbers.
- Check 2 scans every visible element in the active view and confirms none escapes
  the island's painted surface (`visibleOverflow: []`, count 0).

### Known limitations or trade-offs

- The island's expanded height grows with the overview only; other views are
  untouched. The 7 px headroom is the margin for the current worst case (three
  rows). A layout that renders a fourth session row would exceed it again.
- The audit's alternative — tightening the card's vertical rhythm to fit 105 px —
  was not taken, because it would have required reflowing KAI-added card markup;
  growing the surface was the smaller change and keeps the inherited CSS intact.

---

## Fix 2 — Settings gear: measurement error, not a product bug

### What was wrong

The audit (§8a) recorded that clicking the header's `title="Settings"` button did
not open the Settings window. On re-examination there is **no product defect here,
and no code change was needed**. The earlier finding was a measurement error in the
test harness, not in the app.

The gear is built at `app/src/views/views.ts:85`:

```ts
const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
```

`go("settings")` calls `actions.setView(v)`. It switches the island to its **own
in-island settings view** (sound toggle switch, 10/15/30 s auto-close, status
badges) — it is *not* meant to open the separate Settings window. That separate
window is opened by the tray menu item and by the "Settings…" links inside the
cards (`views.ts:444`, `actions.openSettingsWindow()`). The two are different
surfaces and the audit tested the wrong expectation.

### What changed

**Nothing.** No source file was modified for this item. The correct behaviour was
already present; only the verification was wrong.

### How it was verified

A real OS-cursor click at the gear's exact centre changed the island's active view
from index 0 (overview) to index 8 (settings). In the DOM the view indices are:
`0 = overview` (cards), `8 = settings`, `9 = chat`.

The previous "does not respond" result was caused by four harness faults, all on the
test side:

1. The click coordinates were computed while the window was in the 6 px hidden
   wake-strip state, where the frontend pushes a zero-height island rect and the
   cursor poll is deliberately parked — so the click was aimed using a hidden
   layout.
2. The helper used `document.querySelector`; all 16 views each carry a header, so
   it resolved and clicked the wrong element.
3. The helper waited 900 ms between moving the cursor and clicking, during which
   the layout changed.
4. The OS cursor is shared with the human user, so measured positions drifted;
   jumps to unrelated coordinates (e.g. `1446,726`) were observed mid-test.

### Known limitations or trade-offs

- The lesson for the harness: assert on the island's **active view**, not on cursor
  coordinates, and scope selectors to the active view. Coordinate-based click tests
  are unreliable while a human shares the same cursor.
- Because the gear and the "Settings…" links lead to different surfaces, any future
  test must state which one it expects.

---

## Fix 3 — Chat wired to the verified Hermes path

### What was wrong

`app/src-tauri/src/claude.rs` tried KAI Core (`http://127.0.0.1:8788/chat`) and then
the direct Anthropic API. The configured provider was dead. Evidence from this
repo's own probes: `docs/evidence/provider-probe.txt` reports **`USABLE: []`**
(every probed model failed), and `docs/evidence/kai-core-chat-turn.json` shows an
**HTTP 405** from a static route (`405 Method Not Allowed: This is a static site`).

### What changed

Added `hermes_chat()` at `app/src-tauri/src/claude.rs:220`, and made it the first
link in the chain.

- `POST http://127.0.0.1:8642/v1/runs` with body `{"input": query}` and header
  `Authorization: Bearer <hermes-api-key>` (`claude.rs:233`).
- Then poll `GET /v1/runs/{run_id}` every **600 ms** up to a **120 s** deadline
  (`claude.rs:274`). On terminal `completed` it returns the run's `output`; on
  `failed` / `error` / `stopped` it returns an honest error; on timeout it
  `POST`s `/v1/runs/{run_id}/stop` (`claude.rs:265`) so the run is not abandoned.
- Connection failure or no stored key returns `Ok(None)`, so the chain falls through
  to the next provider. A `401` / `403` surfaces a message telling the user to
  update the key in Settings.

Precedence is now **Hermes gateway → KAI Core → direct Anthropic**, so the
previously working paths are untouched when Hermes is absent.

The key lives in the Windows Credential Manager under the app's own service, stored
through the app's own `secret_set` command exactly as the Settings window does. The
app never reads Hermes' `.env`. Route documentation lives in
`docs/evidence/agent-interfaces-verified.md` (§1.1).

### How it was verified

End-to-end through the UI's own command: `chat_send` via the webview bridge returned
the real model text **"KAI-CHAT-OK"** in **8556 ms**. `docs/evidence/verify-parity.mjs`
check 3 reproduces this by invoking `chat_send` and asserting the reply matches
`/KAI-CHAT-OK/`.

### Known limitations or trade-offs

- Polling is fixed at 600 ms with a 120 s deadline; there is no live token streaming
  yet. Streaming would use `GET /v1/runs/{id}/events` (SSE), which is documented but
  not wired into this path.
- The Hermes path is only as available as the gateway on `127.0.0.1:8642`; when it is
  down the app falls back to KAI Core and then Anthropic, and the user sees whichever
  honest error those paths produce.
- A missing or stale key yields `Ok(None)` (fall-through) or a `401`/`403` message,
  respectively — the fix does not attempt to discover or repair the key itself.

---

## How to re-verify

Read-only checks against an already-running build; none of them writes to the app
except the deliberately opt-in key store.

1. **Deterministic parity checks** — `docs/evidence/verify.mjs`. Launch KAI
   with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, then
   `node docs/evidence/verify.mjs`. It runs four checks and prints a PASS/FAIL
   summary: (1) the overview card fits its box with the real session rows, (2) no
   visible element escapes the island surface, (3) the Settings gear switches the
   island to its settings view, (4) `chat_send` returns real model text.
   `node docs/evidence/verify.mjs --store-key <path-to-key-file>` stores the Hermes
   api-server key through `secret_set`, the same command the Settings window uses;
   this is not the default and is only needed once per machine.
   
   Latest run, after the follow-up below: **4/4 PASS** — content 151 px in a 158 px
   box (`overflowPx: -6`), 0 visible overflow, view index 0 → 8, and `KAI-CHAT-OK`
   in 5.5 s.
2. **DPI / geometry probe** — `docs/evidence/dpi-check.ps1`. Read-only: reports the
   display DPI, the island window's DPI (`GetDpiForWindow`), and the resulting scale
   factor, which together explain the physical↔CSS relationship the card fit depends
   on (`docs/evidence/dpi-probe.ps1` is a companion variant).
3. For the gear (Fix 2), re-check by asserting the island's active view index rather
   than cursor coordinates, scoped to the active view. Indices: `0 = overview`,
   `8 = settings`, `9 = chat`. A correct click moves the index from 0 to 8.

## Follow-up after review

A static review of these changes found two robustness faults **in the new chat
path**, both fixed and re-verified afterwards (rebuild 22:00, `verify.mjs` 4/4 PASS):

- **A run left executing when a poll failed.** A failed poll request, body read or
  JSON parse returned early *without* stopping the run it had started — contradicting
  the function's own comment, which claimed every exit stopped it. Every give-up path
  now routes through `abandon()` in `claude.rs`, which calls
  `POST /v1/runs/{run_id}/stop` and then returns the message. KAI reporting an error
  while the gateway keeps an agent working (and spending) on the user's behalf is
  both dishonest and expensive.
- **A stalled gateway dressed up as an absent one.** The opening POST mapped every
  transport error to "not listening", so a gateway that accepted the socket and then
  hung fell through silently to the other providers and the user saw an unrelated
  error. Only a connect failure now means absent (`e.is_connect()`); anything else
  surfaces as `Hermes unreachable: …`.
- Also corrected: the comment in `layout.ts` quoted the box size as if derived by
  arithmetic; it now states the measured figure.

## References

- `docs/parity-audit.md` — upstream comparison, scale/clipping analysis, the open
  items these fixes close (§5a, §8a, §10).
- `docs/evidence/agent-interfaces-verified.md` — the verified Hermes `/v1/runs`
  route and the live turn that proves it.
- `docs/evidence/provider-probe.txt` — `USABLE: []` for the old provider.
- `docs/evidence/kai-core-chat-turn.json` — the HTTP 405 from the old core route.
- `docs/migration.md`, `NOTICE.md` — provenance and licensing.

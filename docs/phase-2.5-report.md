# PHASE 2.5 — UI / CORE INTEGRATION

**Status: PASS for the integration; PARTIAL where a dependency is absent.**

The island is now a live window into KAI Core. What that means concretely: the agent
state, missions, notifications and approvals the island shows come from the control
plane, and the island survives the Core going away and coming back without being
restarted. What it does not mean: the old Rust polling paths are still present (on
purpose — see *Not done*).

## Core client

`app/src/core/kai-core.ts` — one typed client for every Core call. The webview never
calls `fetch` on the Core anywhere else; there is a single base URL.
**17 tests.** Every method resolves to a result value instead of throwing, with errors
normalised to `CORE_OFFLINE` / `TIMEOUT` / `AUTH_REQUIRED` / `REQUEST_FAILED` /
`INVALID_RESPONSE`. Timeouts really abort, and a 2xx that is HTML rather than the
expected shape is reported as an invalid response instead of being read as empty data.

## SSE

`app/src/core/core-events.ts` — the `/core/events` stream. **18 tests.**
Hand-written SSE framing (a `:` keep-alive is not an event, multi-line `data:` is
joined, `\r\n` tolerated, malformed JSON dropped without throwing). Reconnects on a
bounded schedule — 1s, 2s, 5s, 10s, 15s, then capped — and a success resets it, so one
blip does not leave the client slow forever. `disconnect()` aborts the in-flight read
and cancels any pending retry. States are reported honestly: `CONNECTING` while an
attempt is in flight *or a retry is pending*, `ONLINE` only once frames flow, `OFFLINE`
only when nothing is scheduled.

## UI state

`app/src/core/core-state.ts` — the Core slice plus a **pure reducer**, in the app's
existing store rather than a second one. **12 tests.** The event ring is capped and
notifications/events are deduped by id, so a reconnecting stream can never make the
same notification appear twice.

The reducer caught a real bug in itself during development: deriving a mission's status
from the event name gave a running mission the status `STARTED`, which is not a Core
status — so the active count read **0 while a mission was running**. Events now map to
the real `MissionStatus` values, and an explicit status from the Core wins over our
inference.

## Agents, missions, notifications, approvals

| | Source | Where it shows |
|---|---|---|
| Hermes / OpenCode state | `GET /state`, `agent.*` events | the existing pills, driven by `core-bridge.ts` |
| Missions | `GET /missions`, `mission.*` events | the note bubble on a terminal transition |
| Notifications | `GET /notifications`, `notification.created` | the note bubble + pill badge |
| Approvals | `GET /approvals`, `approval.requested` | the **existing** approval card; the buttons ask the Core first, the Claude Code relay second |
| Core connection | the stream's state | the note bubble: "KAI Core is not running — reconnecting…" |

Restraint is deliberate: a mission finishing while you are reading the chat waits in the
note instead of seizing the screen.

## Chat

Unchanged in path (`Rust claude.rs → Core POST /chat`) and still working. The Core
answers state questions from state — verified live with the app's own client:
`"what is happening?"` → `agent=core, from_state=true`, naming both agents and the real
counts. Anything the router does not recognise still falls through to the agent path.

## Offline / reconnect

Verified by killing the Core under a running island and bringing it back:

```
08:15:48  ui  [core] connecting → CONNECTING → ONLINE
08:16:15  ui  [core] connection CONNECTING      ← Core killed
          island note: 'KAI Core is not running — reconnecting…'
08:16:33  ui  [core] connection ONLINE          ← Core restarted, app never restarted
          island note: ''                       ← cleared itself
```

The app did not crash (the debug port kept answering; the window stayed up), and the
mission created before the restart was still there afterwards.

## Tests

| Suite | Count | State |
|---|---|---|
| `app/` (client, stream, state, timeAgo) | 57 | all pass |
| `core/` (runtime, storage, events, agents, missions, scheduler, policy, tools, api) | 229 | 216 pass, 0 fail, **13 skipped** — the OpenCode live tests, skipped with that reason because OpenCode is not running on this host |

App typecheck clean; Core typecheck clean.

## Files changed

```
app/src/core/kai-core.ts        new  the typed Core client
app/src/core/core-events.ts     new  the event stream
app/src/core/core-state.ts      new  the UI's Core slice + reducer
app/src/core/core-boot.ts       new  bootstrap: stream + snapshot refresh
app/src/island/core-bridge.ts   new  Core state → the existing island surfaces
app/src/core/state.ts                one Core slice added to the existing store
app/src/island/island.ts             an approval asks the Core before the relay
app/src/main.ts                      starts the link, never awaited
app/src-tauri/tauri.conf.json        CSP: the Core origin is now reachable
core/src/config.ts                   allowed origins include a packaged window's
docs/ui-core-dataflow.md        new  the pre-change data flow and the authority rules
```

## Known limitations

- **Secrets never reach the front end.** Nothing in this phase carries a credential: the
  client has no auth header, the stream is plain events, and the state slice has no
  field for one. The Core reads the Hermes key itself (caller → environment → the
  Hermes install's `.env`).
- **OpenCode behaviour is unproven end to end** here because OpenCode is not running on
  this host. The Core reports it as `offline`, which is what the island shows.
- **The island does not start the Core yet.** The spec's "ensure Core" step is not
  implemented: the linker, not the app, brings the Core up today (`npm start`). This is
  the main gap against the phase's acceptance list.
- **The old Rust polling paths still run.** They are the reason sessions still appear in
  the overview; removing them before the Core's `/agents` covers the same fields would
  be a regression, so nothing was deleted.
- **Tool invocations still publish no events** (the contract has no `tool.*` types), so
  tool activity is visible only through mission progress and approvals.
- **Dedupe is by id.** An SSE frame carrying no id is appended each time; the Core
  always sets one today, so this is theoretical rather than observed.

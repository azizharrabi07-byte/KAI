# KAI Workstation — the provider seam and the CUA driver

Status: implemented (seam + real CUA provider + mock) · Branch `feat/goal-executive`
· Driver probed: **cua-driver 0.28.2** (`x86_64-windows`), daemon running.

This records the contract, the real driver surface as measured on this machine,
the host/guest boundary, the safety boundaries, the honest platform limits, the
resource budget, and a **plan** for a disposable VM. Every driver fact below is
a verbatim probe result, not documentation copied from upstream.

## 1. Why a seam, and what it is

KAI drives a GUI workspace. Two things must not be conflated:

* **What a provider must be able to answer** — observe, act, and be honest about
  whether the act landed. That is the seam (`core/src/workstation/provider.ts`).
* **How the currently installed driver answers it** — a translation, and one of
  several possible ones (`core/src/workstation/cua.ts`).

`capabilities/computer/` is a different, lower layer: a transport plus the safety
orchestrator (human hold, frame dedupe, transition protection) and a deliberately
narrow four-verb action union. The workstation seam sits above that question and
adds what a workspace needs: an observation that carries **both** the pixels and
the accessibility tree, an action union that covers click / type / key / hotkey /
scroll / drag, and a verdict on the result.

| Module | Role |
|---|---|
| `core/src/workstation/provider.ts` | The provider-agnostic contract, target validation, the effect vocabulary, the `KaiError` bridge |
| `core/src/workstation/cua.ts` | The real provider: one-shot `cua-driver call`, bounded, typed failures |
| `core/src/workstation/mock.ts` | Deterministic scripted provider; the seam's executable specification |
| `core/tests/workstation.test.ts` | One contract suite run against **both** providers |
| `core/tests/workstation-live.test.ts` | The provider against the **real** driver: recorded transcript assertions (always) + opt-in read-only live calls |
| `docs/evidence/workstation-live.json` | The verbatim read-only driver transcript those tests assert against |

### The central rule: a delivered event is not an applied change

The contract's `effect` is deliberately the same five words the installed driver
already uses for its own action results:

| `effect` | Meaning | `verified` |
|---|---|---|
| `confirmed` | The provider has publishable readback or a window change it can point at | **true** |
| `partial` | Only part of the work landed (e.g. N of M characters) | false |
| `unverifiable` | Delivered, but the effect cannot be proven. **The honest default.** | false |
| `suspected_noop` | Available evidence suggests nothing useful changed | false |
| `refused` | The provider deliberately did not deliver | false |

`verified` is **derived**, never supplied: `verified === (effect === "confirmed")`.
Outcomes are built through `outcome()` so the two cannot disagree, and
`isVerifiedOutcome()` lets a caller assert the invariant rather than restate it.

This matters concretely on Windows. The driver's own `WINDOWS.md` records that a
posted click on a UWP surface and a posted `WM_CHAR` into a Chromium content area
are **silently ignored**, and that the layered click path "can return
`effect:"unverifiable"` after PostMessage even when the click did nothing". A
contract that could not say `unverifiable` would eventually report success for an
action that never happened.

## 2. The real driver surface (measured)

```
$ where cua-driver
C:\Users\DELL\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe

$ cua-driver --version
cua-driver 0.28.2

$ cua-driver status
Cua Driver daemon is running
  socket: \\.\pipe\cua-driver
  pid: 19208
  permission mode: standard (built_in_default)
  user policy: configured=false, active=false, valid=true
  managed policy: configured=false, active=false, valid=true
  authorization host: unavailable (unavailable)
  capability manifest: configured=false, approved_at_startup=false, valid=true
```

`cua-driver doctor --json` — all seven probes `ok`:

| Probe | Result |
|---|---|
| `binary` | `cua-driver 0.28.2 (x86_64-windows)` |
| `install dir` | `C:\Users\DELL\.cua-driver\packages\releases\0.28.2-x86_64-pc-windows-msvc\cua-driver.exe` |
| `home dir` | `C:\Users\DELL\.cua-driver` (1 release dir cached) |
| `telemetry` | `enabled via default (install-id present)` |
| `interactive session` | `session 1 has an attached interactive desktop (session=1; window_station=attached; thread_desktop=Default; input_desktop=Default; foreground_hwnd=0x40646)` |
| `UI Automation` | `CoCreateInstance(CUIAutomation) succeeded` |
| `EnumWindows visible` | `12 windows` |

`cua-driver manifest --pretty` advertises `mcp_invocation = { command: <exe>, args: ["mcp"] }`
and a **57-tool** registry (`cua-driver list-tools`). `cua-driver call <tool> <json>`
invokes one tool through the running daemon. `%LOCALAPPDATA%\cua-driver\` holds only
`cua-driver.pid`; the install lives under `%LOCALAPPDATA%\Programs\Cua\cua-driver\`.

### What the one-shot CLI actually returns

Read-only calls (verbatim):

```jsonc
// call get_screen_size '{}'
{ "height": 1080, "scale_factor": 1.1041666666666667, "width": 1920 }

// call check_permissions '{}'
{ "elevated": true, "integrity_level": "High", "integrity_level_rid": 12288,
  "post_message": true, "uia": true }

// call health_report '{}'
{ "driver_version": "0.28.2", "overall": "ok", "platform": "win32", "schema_version": "1",
  "checks": [ … "ax_capability": pass, "screen_capture_capability": "D3D11 device reachable",
              "tcc_accessibility"/"tcc_screen_recording": "not applicable on Windows" … ] }

// call get_window_state '{"pid":…,"window_id":…}'
{ "app_name", "element_count", "elements": [ { element_index, element_token, role, label,
    enabled, actions, frame:{x,y,w,h}, depth } ], "elements_complete", "returned_element_count",
  "total_element_count", "snapshot_id", "tree_markdown", "window_bounds", "window_title",
  "screenshot_png_b64", "screenshot_mime_type", "screenshot_width", "screenshot_height" }

// call get_accessibility_tree '{}'
{ "processes": [ {name,pid} … ], "windows": [ {height,pid,title,width,window_id,x,y} … ] }

// call start_session '{"session":"kai-probe"}'
{ "active": true, "capture_scope": "auto", "desktop_capture_authorized": false,
  "desktop_unlocked": false, "effective_scope": "window", "revived": false, "session": "kai-probe" }

// call verify_state '{"pid":…,"window_id":…,"expect":[…],"timeout_ms":0}'
{ "elapsed_ms": 456, "samples": 1, "stable": true, "status": "satisfied",
  "predicates": [ { "index": 0, "status": "satisfied", "unknown_reason": null,
                    "observed_json": "{\"matches\":3}" } ] }
```

`--screenshot-out-file <path>` writes the PNG to disk and **omits**
`screenshot_png_b64` from the JSON. The provider uses the inline form (no
filesystem side effects); the flag was verified working.

### Error surface — the exit code alone is not enough

This is the trap the provider is built around. Four distinct failure shapes, and
**one of them exits 0**:

| Trigger | Exit | Stream | Output |
|---|---|---|---|
| Unknown tool | 1 | stderr | `Permission denied: tool 'no_such_tool' has no reviewed risk classification` |
| Schema violation | **0** | **stdout** | `Missing required integer field pid.` |
| Unparseable argv JSON | 2 | stderr | `error: positional JSON arg to 'cua-driver call' did not parse: …` |
| Daemon not running | 1 | stderr | `Cua Driver daemon is not running on \\.\pipe\<socket>.` |

So `classifyCliRun` treats **both** the exit code and whether stdout parsed as
load-bearing. Exit 0 with unparseable stdout is a plain-text rejection, not a
success.

All four shapes are re-captured verbatim, with exit codes and both streams, in
`docs/evidence/workstation-live.json` and asserted against the provider in
`core/tests/workstation-live.test.ts`. The daemon-not-running shape is produced
against a **second, dead pipe name** (`\\.\pipe\kai-no-such-daemon`) so the real
daemon is never touched.

That transcript carries one deliberate redaction, recorded in its own
`redaction` block: the window inventories' `title` fields are replaced with a
placeholder, and the accessibility tree's process list is replaced by its count.
Those fields name what the **operator** had open on their own desktop, which is
not load-bearing for this contract — the tests assert window ids, geometry,
`app_name` and counts, never a title's text. Everything else is verbatim.

### What the live exercise changed in `cua.ts`

Running the real driver through the provider found three defects that no fixture
would have shown. All three are fixed, and each is pinned by a test:

1. **The desktop window inventory had no geometry.** `get_accessibility_tree` —
   the tool the provider calls for a desktop observation — returns each window's
   geometry **flat** on the entry (`x` / `y` / `width` / `height`), while
   `list_windows` nests it under `bounds`. `readWindows` read only the nested
   form, so every window in a desktop observation came back without bounds: a
   caller could list windows but never address one by point. `readWindows` now
   accepts both real shapes.
2. **A refusal that did not use the explicit marker was reported as
   `unverifiable`.** The driver has two observed refusal shapes and both happen
   to carry `effect: "refused"` or `status: "refused"`, but its published reason
   set (`route_unavailable`, `delivery_failed`, `background_unavailable`,
   `permission_required`, …) can arrive as a bare code. Those payloads yielded
   *no verdict*, so a deliberate refusal was reported as a delivered-but-unproven
   action. `readDriverVerdict` now reads a `refusal` object or a code from the
   refusal vocabulary as `refused`. `effect_unconfirmed` is deliberately excluded:
   a delivery whose effect could not be proven is `unverifiable`, not a refusal.
3. **The daemon probe ignored the configured socket.** `availability()` ran
   `cua-driver status` with no `--socket`, which reports the **default** pipe. A
   provider constructed against any other socket therefore reported
   `daemonRunning: true` for a pipe with nothing behind it — measured live
   against `\\.\pipe\kai-no-such-daemon`. `probeStatus()` now names the same
   socket every `call` uses.

### Refusals arrive in-band, with a verdict

```jsonc
// call click '{"pid":999999,"window_id":1,"x":10,"y":10}'   → exit 0
{ "code": "window_target_not_found", "effect": "refused", "pid": 999999, "window_id": 1 }

// call click '{"pid":19084,"window_id":263402,"element_index":9999,
//             "snapshot_id":"s00000000"}'                    → exit 0
{ "refusal": { "code": "stale_element_token",
               "message": "element_token is stale; call get_window_state again to refresh" },
  "status": "refused" }
```

The driver's shipped skill pack (`C:\Users\DELL\.cua-driver\skills\cua-driver`,
read-only evidence) documents its own action-result vocabulary — `effect`,
`route` (`accessibility` / `synthetic_events` / `global_input` / `dom` /
`trusted_input`), `evidence`, `escalation`, and the closed reason set
`route_unavailable` / `delivery_failed` / `effect_unconfirmed` / `suspected_noop`
/ `permission_required`. The seam's vocabulary is a superset of that, and the
mapping in `cua.ts` is a translation, not an invention.

**No input was injected to produce any fact above.** The refusal payloads came
from calls that *cannot* deliver input (a non-existent pid; a fabricated
snapshot handle, which the driver fails closed on). Live input injection was not
exercised on this machine.

## 3. Architecture

```
┌─ HOST (trusted) ──────────────────────────────────────────────────────────┐
│  KAI Core            KAI Guard (policy · risk · approvals · audit)        │
│      │                                                                    │
│      ├── workstation/provider.ts   ← the contract, target validation      │
│      ├── workstation/mock.ts       ← tests, deterministic                 │
│      └── workstation/cua.ts        ← bounded one-shot calls               │
│                 │                                                         │
│                 │  spawn: cua-driver call <tool> --socket \\.\pipe\…      │
│                 │  stdin: JSON args   (never argv)                        │
│                 ▼                                                         │
│        cua-driver daemon  (session 1, interactive desktop)                │
│                 │  UIA · PostMessage · SendInput · D3D11 capture          │
└─────────────────┼─────────────────────────────────────────────────────────┘
                  ▼
┌─ GUEST (disposable, KAI's workspace) ─────────────────────────────────────┐
│  Applications KAI operates. No Core, no Guard, no user secrets.           │
│  Clipboard · drag-drop · drive redirection · guest→host shares: OFF.      │
└───────────────────────────────────────────────────────────────────────────┘
```

Two design consequences worth stating plainly:

1. **The daemon socket is local.** `\\.\pipe\cua-driver` is a Windows named pipe,
   reachable only from the machine it runs on. A guest VM cannot be driven by the
   host's daemon. The guest therefore runs its own driver plus a thin bridge that
   speaks *this* contract; the host's Core and Guard stay on the host and talk to
   that bridge over one explicit, audited channel. Nothing else crosses.
2. **The provider never stops the daemon.** `disconnect()` ends *our* session
   (`end_session`); it never runs `cua-driver stop`, `serve`, `install`, `update`,
   `config` or `revoke`. A test asserts no argv token from that forbidden set is
   ever issued. Killing the operator's daemon would be a host change made on the
   operator's behalf, which this seam must not do.

### The argv rule, enforced by construction

The command line is built from **only** three fixed things: the executable, one
tool name drawn from a closed map, and the fixed `--socket` flag. Every
caller-supplied value — text, keys, coordinates, window ids, element indices —
travels as JSON on **stdin**. There is no code path that can put a caller string
into argv, and the action union has no URL or argv member to smuggle one
through: navigation is a browser-capability concern, not a workstation input
concern. `invocation()` throws before a process exists if the tool is not in the
closed map, and a test asserts the argv never contains caller data.

## 4. The host/guest boundary

| Concern | Lives on | Why |
|---|---|---|
| Core (missions, orchestration, work items) | **Host** | It is the authority; it must not be reachable from inside the thing it is driving |
| Guard (policy, risk, approvals, audit) | **Host** | Enforcement point must be outside the workspace it governs |
| Provider seam + CUA provider | **Host** | The decision "may KAI act, and did it work" is a host decision |
| cua-driver daemon | **Guest** | It needs an interactive desktop session and OS-level input/capture rights |
| Applications KAI operates | **Guest** | Disposable; contains no user secrets |

The guest is a workspace, not a peer. It holds no policy, no approvals, no
credentials, and no durable state that matters. Reverting the VM to a checkpoint
must be a safe, total undo.

## 5. Safety boundaries

**OFF by default — these must be explicitly enabled, per-run, by a human:**

| Channel | Default | Why it is off |
|---|---|---|
| Shared clipboard (host ↔ guest) | **OFF** | A clipboard is a bidirectional channel that bypasses every policy check. It is how a secret leaves, and how an instruction arrives. |
| Drag-and-drop (guest → host) | **OFF** | Same channel, different transport: files, not text |
| Shared folders / drive redirection | **OFF** | Gives the guest read or write reach into host storage |
| USB passthrough | **OFF** | Unmediated device access |
| Guest → host network shares | **OFF** | The guest is untrusted; it must not initiate into the host |
| Host → guest RDP drive/clipboard redirection | **OFF** | RDP silently re-enables both by default |
| Desktop-scope capture/input | **OFF** | The driver reports `desktop_capture_authorized: false` on a fresh session; window scope is the default and desktop scope is an explicit escalation |
| `delivery_mode: "foreground"` | **OFF** | The driver never fronts a window unless asked; fronting steals the operator's focus. `background` is the mandatory first attempt and the driver decides when it is impossible |

**Always on:**

* Guard decides *whether* an action is allowed; the provider only decides *how*
  and reports *whether it worked*. A provider cannot grant itself permission.
* A malformed target is refused by `validateActionTarget()` **before** any
  provider sees it — a test asserts the driver is never reached.
* Every call is bounded by a timeout; a timeout kills the child process.
* `availability()` reports an absent driver as a normal state (`available:false`
  with a reason), never as an exception or a silent success.

## 6. Honest platform limitations

These are properties of the platform, not bugs to be fixed later.

1. **Windows needs a daemon in the interactive session.** UIA, capture and input
   all require an attached desktop. `cua-driver doctor` reports
   `session 1 has an attached interactive desktop`; the driver ships
   `cua-driver autostart enable`, which registers a logon Scheduled Task so
   `serve` starts at every interactive logon. A daemon in session 0 (a service)
   would see no desktop.
2. **An SSH session sees an empty desktop.** An SSH login does not attach to the
   interactive window station, so `EnumWindows` returns nothing useful and
   capture yields nothing. This is not a permission that can be granted — it is
   the window-station model. Any "headless" use must run through a process that
   *is* in the interactive session (the autostart task, or a scheduled task with
   the right logon), not through SSH.
3. **Locked screen.** `start_session` reports `desktop_unlocked: false` /
   `effective_scope: "window"`. A locked or disconnected desktop is not a
   workspace.
4. **Background delivery is not always possible.** Chromium/Electron content,
   GTK buttons, VCL/LibreOffice accelerators, terminal and WPF text without an
   element handle are known to drop posted events. The driver returns a
   structured `background_unavailable` rather than fronting; the caller must
   escalate deliberately.
5. **The accessibility tree lies on some surfaces.** Canvas, video, WebGL and
   custom-drawn UI have no UIA peer; `get_window_state` says so and the caller
   must fall back to pixels. The driver's own docs are explicit that the tree and
   the screenshot must be cross-checked.
6. **Absence is not proof.** A truncated walk (`elements_complete: false`,
   `returned_element_count < total_element_count`) or a non-exhaustive
   projection means a missing element is *unknown*, not absent. The seam carries
   `complete: false` for exactly this.
7. **Elevation is real.** `check_permissions` reported `elevated: true`,
   `integrity_level: "High"`. The driver can act with the rights of the account
   running the daemon — which is why the guest, not the host, is the workspace.
8. **No screenshot tool.** There is no standalone `screenshot` tool in 0.28.2;
   `get_window_state` (window) and `get_desktop_state` (full display) are the
   capture paths. The provider uses exactly those.

## 7. Resource budget

Measured on this machine (cua-driver 0.28.2, session 1, 12 visible windows):

| Item | Measured |
|---|---|
| `--version` / `status` probe | ~0.2–0.6 s per call |
| `call get_screen_size` | ~0.5–3.6 s (cold daemon round-trip) |
| `call get_window_state` (small window, 2 elements) | ~0.5–1.0 s |
| `call list_windows` | ~3.6 s |
| `cua-driver doctor --json` | ~4.4 s |
| Main display | 1920 × 1080 reported, `scale_factor` 1.1041666666666667 |
| Window screenshot (183 × 176) | 6 606 bytes PNG |
| `get_window_state` UIA defaults | ≤ 5 000 elements, depth ≤ 25 |
| Driver's own note on a large tree | Chrome's ~5 000-element tree returns in ~2–3 s |

Budget chosen by the provider:

* **20 s** per observation or action (`timeoutMs`), **8 s** per lifecycle probe
  (`probeTimeoutMs`). Both configurable. A timeout kills the child.
* A screenshot is carried inline as base64, so one 1920×1080 frame is roughly
  `4/3 × PNG size` on the pipe. A full-desktop PNG of that size is on the order
  of 1–3 MB, i.e. ~1.3–4 MB of base64 per observation. **[INFERENCE]** — the
  desktop was not captured during probing (see §8); the window figure is
  measured and the desktop figure is scaled from it.
* One observation = **one process** (two for desktop scope: capture + window
  inventory). No daemon is spawned or owned by the provider.

## 8. Disposable-VM runbook — **A PLAN, NOT YET EXECUTED**

> **This runbook requires separate, explicit host authorization.** Nothing in it
> has been run. No VM was created, no Hyper-V feature was changed, no service was
> installed, and no driver setting was modified during this work. The probe
> transcript in §2 is read-only: `where`, `--version`, `--help`, `status`,
> `doctor`, `manifest`, `list-tools`, `describe`, `dump-docs`, `skills path`,
> `skills status`, `sessions --json`, and read-only `call` invocations
> (`get_screen_size`, `check_permissions`, `health_report`, `list_windows`,
> `get_window_state`, `get_accessibility_tree`, `verify_state`,
> `start_session`/`end_session`). Two window-scoped reads were taken against the
> Windows Clock applet to learn the response shape: its accessibility tree, and
> one screenshot written to a temp file whose **size** (6 606 bytes) was read and
> whose pixels were never displayed. The full desktop was never captured.

Goal: a workspace KAI may drive freely, which reverting makes **totally** undone.

### Step 0 — Authorization and preconditions

1. Obtain explicit human authorization for the Hyper-V changes below. Stop here
   without it.
2. Confirm the host is Windows 11 Pro/Enterprise with virtualization enabled in
   firmware.
3. Confirm no production workload shares the host GPU budget.
4. Record the pre-existing state so it can be restored:
   `Get-VMSwitch`, `Get-VM`, `Get-NetNat` — save the output.

### Step 1 — Network isolation (host)

1. Create an **internal-only** switch:
   `New-VMSwitch -Name "KAI-Workstation" -SwitchType Internal`
2. Give the host vNIC an address and NAT it, so the guest has egress for updates
   but no inbound path to the host:
   `New-NetIPAddress -IPAddress 192.168.222.1 -PrefixLength 24 -InterfaceAlias "vEthernet (KAI-Workstation)"`
   `New-NetNat -Name "KAI-Workstation-NAT" -InternalIPInterfaceAddressPrefix 192.168.222.0/24`
3. Do **not** attach the guest to the default switch, and do **not** bridge to the
   physical LAN.

### Step 2 — Create the VM (host)

1. `New-VM -Name "KAI-Workstation-01" -Generation 2 -MemoryStartupBytes 8GB -NewVHDPath <path>\kai-ws.vhdx -NewVHDSizeBytes 80GB -SwitchName "KAI-Workstation"`
2. `Set-VMProcessor -VMName "KAI-Workstation-01" -Count 4`
3. `Set-VMMemory -VMName "KAI-Workstation-01" -DynamicMemoryEnabled $true -MinimumBytes 4GB -MaximumBytes 12GB`
4. Enable nested-free, no GPU passthrough, no enhanced session:
   `Set-VM -VMName "KAI-Workstation-01" -EnhancedSessionTransportType HvSocket` is
   **not** wanted here — leave enhanced session mode **off** at the host
   (`Set-VMHost -EnableEnhancedSessionMode $false`) so RDP clipboard and drive
   redirection cannot be re-enabled by accident.
5. Install Windows 11 Enterprise (eval) or Ubuntu 24.04 from ISO, with a **local**
   account. No Microsoft account, no domain join, no shared credentials.

### Step 3 — Close the guest's channels (guest)

1. `Set-VMHost`-level: confirm enhanced session mode off; confirm no
   `Set-VM -Clipboard` / drive-redirection options are enabled.
2. In the guest, disable RDP clipboard and drive redirection in
   `HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp`:
   `fDisableClip = 1`, `fDisableCdm = 1`.
3. Disable Hyper-V Data Exchange / Guest Services that leak host context, keeping
   only what the bridge needs.
4. Verify from the guest that the host's shares are unreachable.

### Step 4 — Install the driver in the GUEST (guest)

1. Install cua-driver in the guest using the canonical installer.
2. `cua-driver doctor --json` must show the `interactive session` probe `ok` —
   i.e. an attached interactive desktop. If it does not, the guest is headless
   and the runbook stops here.
3. `cua-driver autostart enable` — registers the logon Scheduled Task so `serve`
   starts at every interactive logon. This is the Windows answer to
   "the daemon must live in the interactive session" (§6.1).
4. Keep `--permission-mode standard` (the default). Do **not** use
   `--dangerously-bypass-approvals`, and do not set
   `--permission-mode unrestricted`.
5. Confirm: `cua-driver status` reports the daemon running, and
   `cua-driver call check_permissions '{}'` reports what it actually has.

### Step 5 — The bridge (guest)

1. Run a thin workstation bridge in the guest that implements the
   `WorkstationProvider` contract by calling the **local** named pipe
   (`\\.\pipe\cua-driver`) — the pipe is not remotely reachable (§3.1).
2. Expose exactly one authenticated channel to the host. No second port, no file
   share, no clipboard.
3. The host's Core points its provider at that channel. Core and Guard never
   leave the host.

### Step 6 — Verify the boundary

1. From the host, `availability()` reports the guest's driver version and
   `daemonRunning: true`.
2. `observe({kind:"desktop"})` returns pixels and a window inventory.
3. Attempt each OFF-by-default channel (clipboard, drag-drop, drive, share) and
   **confirm it fails**. A boundary that was never tested is not a boundary.
4. Confirm `disconnect()` leaves the guest's daemon running (the provider must
   never stop it).
5. Confirm a locked/disconnected guest desktop degrades to
   `desktop_unlocked: false` rather than hanging.

### Step 7 — Make it disposable

1. Take a checkpoint once the guest is clean and verified:
   `Checkpoint-VM -Name "KAI-Workstation-01" -SnapshotName "clean"`
2. Before each unattended run: `Restore-VMSnapshot`.
3. After each run: inspect, then revert. Never accumulate drift.

### Step 8 — Teardown

1. `Remove-VM -Name "KAI-Workstation-01" -Force`, delete the VHDX.
2. `Remove-VMSwitch -Name "KAI-Workstation" -Force`; `Remove-NetNat -Name "KAI-Workstation-NAT"`.
3. Restore anything Step 0 recorded as changed.

## 9. Not implemented yet (honest scope)

* **No guest VM and no bridge exist.** §8 is a plan. The provider currently drives
  the machine it runs on — this machine.
* **No MCP transport in this seam.** `capabilities/computer/real-transport.ts`
  speaks MCP-over-stdio for the long-lived path; this seam uses the bounded
  one-shot CLI. Both are deliberate; neither replaces the other.
* **No live-input integration test.** Live capture and live input are opt-in via
  `KAI_WORKSTATION_LIVE_CAPTURE=1` and are skipped by name otherwise, because the
  suite must not read or click a machine somebody is using.
* **No `verify_state` wrapper.** The driver's `verify_state` is the right way to
  *prove* a postcondition, and its `satisfied`/`unsatisfied`/`unknown` mapping is
  already implemented and tested in `readDriverVerdict`. No provider method
  exposes it yet, so actions currently land on the driver's own `effect` field.
* **No recording / trajectory replay.** The driver ships `start_recording` and
  `replay_trajectory`; the seam does not expose them.
* **No browser navigation.** The action union has no URL member on purpose (§3).
* **`list_windows` is not on the provider's closed surface.** The provider builds
  its desktop inventory from `get_accessibility_tree`, which returns the same
  window set with flat geometry but without `app_name` / `z_index` / `layer`.
  `list_windows` is exercised live by the test suite and parsed by the same
  `readWindows`, but the provider does not call it.

### What is NOT verified — stated plainly

1. **No VM exists.** No guest, no hypervisor change, no switch, no checkpoint, no
   bridge. Every driver fact in this document was measured on the **host** it was
   written on. The §4 host/guest boundary and the §8 runbook are architecture and
   plan, not observed behaviour.
2. **No input was ever injected.** No click, keystroke, scroll or drag was
   delivered to any window. The two refusal payloads in §2 came from calls that
   *cannot* deliver input (a pid that does not exist; a fabricated snapshot
   handle the driver fails closed on), and they are recorded in
   `docs/evidence/workstation-live.json` as fixtures rather than re-run, because
   reproducing them means invoking `click`.
3. **No screen pixels were read.** No `get_desktop_state` call was made, and the
   live test asserts that the accessibility-tree payload it reads carries no
   `screenshot_png_b64`. The only screenshot ever taken in this work was one
   window-scoped capture whose **byte size** was read and whose pixels were never
   displayed.
4. **The desktop-scope path is untested end to end.** `observe({kind:"desktop"})`
   is exercised against the mock and against fake runners, never against a real
   desktop, precisely because it captures the operator's whole screen.
5. **`desktop_capture_authorized` was never granted.** Every real `start_session`
   reported `false` with `effective_scope: "window"`. The escalation path has
   never been walked.
6. **The two-client concurrency story is unverified.** One provider at a time was
   exercised. Two providers sharing `\\.\pipe\cua-driver` with different session
   labels was not.
7. **Behaviour on a locked or disconnected desktop is unverified.** The driver
   reports `desktop_unlocked: false` in its own session payload; that a call
   degrades rather than hangs in that state was not observed.
8. **The recorded transcript is a point-in-time capture.** It records
   `EnumWindows visible: 15 windows` and daemon pid 19208 on 2026-10-11. Those
   numbers move with the machine; the tests assert the *shape* and the stable
   facts (version, socket, permission mode, tool count, screen size), not the
   window list.

## 10. Reproducing this on THIS machine

Everything in §2, §3 and §6 was measured here. This is the exact procedure to
reproduce it, and it is bounded to read-only calls for one reason: the machine is
somebody's working desktop, not a fixture.

### 10.1 The machine and the install

| Fact | Value |
|---|---|
| Host | `DESKTOP-2L3HISO`, Windows 10.0.26200 (x64) |
| Binary | `C:\Users\DELL\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe` |
| Version | `cua-driver 0.28.2` — `cua-driver --version` |
| Daemon | running, **pid 19208**, permission mode `standard` (`built_in_default`) |
| Socket | `\\.\pipe\cua-driver` — a Windows **named pipe**, not a TCP port and not a unix socket |
| Driver home | `C:\Users\DELL\.cua-driver` (one cached release dir) |
| Tool registry | **57** tools — `cua-driver list-tools` |
| Display | 1920 × 1080, `scale_factor` 1.1041666666666667 |
| Token | `check_permissions` → `elevated: true`, `integrity_level: "High"`, `uia: true`, `post_message: true` |
| Doctor | 7/7 probes `ok`, including `interactive session` and `UI Automation` |

The binary path and the pipe name are **not** discovered at runtime — they are
the two constants in `REAL_DRIVER_SEAM` (`core/src/capabilities/computer/transport.ts:185`)
and the provider's defaults. Pointing the provider at another machine means
overriding both `executable` and `socket`.

### 10.2 The invocation

Every call is one short-lived process. **The JSON arguments go on stdin, never in
argv** — the driver's own `call --help` warns that PowerShell 5.1 mangles quoted
JSON in argv, and keeping caller data out of the command line is also what makes
the argv rule enforceable (§3).

```powershell
# a bare subcommand (no daemon round-trip for --version; `status` does use the daemon)
& $exe --version
& $exe status --socket \\.\pipe\cua-driver
& $exe doctor --json
& $exe list-tools

# one tool through the running daemon: JSON on STDIN
'{}'                                             | & $exe call get_screen_size     --socket \\.\pipe\cua-driver
'{}'                                             | & $exe call check_permissions   --socket \\.\pipe\cua-driver
'{}'                                             | & $exe call health_report       --socket \\.\pipe\cua-driver
'{}'                                             | & $exe call list_windows        --socket \\.\pipe\cua-driver
'{}'                                             | & $exe call get_accessibility_tree --socket \\.\pipe\cua-driver
'{"session":"kai-workstation"}'                  | & $exe call start_session       --socket \\.\pipe\cua-driver
```

In Node (what the provider and the test suite actually do):

```ts
spawn(exe, ["call", tool, "--socket", socket], { stdio: ["pipe", "pipe", "pipe"] })
  // then write JSON.stringify(args) to child.stdin
```

`status` is the one subcommand whose `--socket` matters twice over: without it,
`status` reports the **default** pipe, which is how a provider pointed elsewhere
could claim a daemon it cannot reach (§2).

To reproduce the whole transcript:

```powershell
cd core
node --test --experimental-strip-types tests/workstation-live.test.ts                 # recorded layer only; live tests skip by name
$env:KAI_WORKSTATION_LIVE = "1"
node --test --experimental-strip-types tests/workstation-live.test.ts                 # recorded layer + read-only live calls
```

### 10.3 Autostart — and why the daemon needs an interactive session

`cua-driver autostart status` → `registered (running)`.

The registered task, queried read-only with
`schtasks /query /tn "\cua-driver-serve" /v /fo list`:

| Field | Value |
|---|---|
| Task | `\cua-driver-serve` |
| Run as | `DELL` |
| **Logon type** | **Interactive only** |
| **Trigger** | **At logon** |
| Run level | Highest — the task's own comment: *"RunLevel=Highest for UWP/AppContainer support"* |
| Action | `powershell.exe -NoProfile -WindowStyle Hidden -NonInteractive -Command "Start-Process -FilePath '<exe>' -ArgumentList 'serve' -WindowStyle Hidden -WorkingDirectory 'C:\Users\DELL'"` |
| Last result | `0` |
| State | Enabled |

**Why `Interactive` and not a service.** Windows isolates services into
**Session 0**, which has no desktop and no interactive window station. The
driver's own Windows guidance (`%USERPROFILE%\.cua-driver\skills\cua-driver\WINDOWS.md`,
read-only) states that in Session 0 UI Automation enumeration, `PrintWindow`
capture and `IApplicationActivationManager` all *silently* return empty or time
out, and that the direct runtime refuses a runtime owner whose `SessionId == 0`
before any action runs. So a Session-0 daemon does not fail loudly — it returns
plausible emptiness. That is the worst possible failure mode for this seam, whose
entire job is to distinguish "nothing is there" from "I could not see".

The task therefore triggers **at logon**, in the user's own session, and the
daemon it starts lands in that session. `cua-driver doctor` confirms the result
on this machine:

```
interactive session  ok  session 1 has an attached interactive desktop
                         (session=1; window_station=attached; thread_desktop=Default;
                          input_desktop=Default; foreground_hwnd=0x40646)
```

If the daemon is ever started over SSH, that login is usually Session 0 and the
daemon must instead be kicked into the interactive session —
`schtasks /Run /TN cua-driver-serve`. **This provider never does that, and never
starts, stops, installs, updates or reconfigures the daemon**: those are host
changes made on the operator's behalf, which this seam must not make.

### 10.4 Which capabilities need an interactive session

The guest VM does not exist yet (§9), so "guest" here means *whatever interactive
desktop the daemon runs in*. Every capability below is **unavailable** — silently
or by refusal — to a Session-0 daemon:

| Capability | Provider surface | Why it needs a desktop |
|---|---|---|
| UI Automation enumeration | `observe({kind:"window"})`, `observe({kind:"desktop"})`, `list_windows` | `CUIAutomation` walks the desktop's window station; Session 0 has none |
| Accessibility tree | `get_accessibility_tree` | Same enumeration, same empty result |
| Screen capture | `get_desktop_state`, `get_window_state` screenshot | D3D11 / `PrintWindow` needs a real desktop surface; Session 0 returns blank |
| Input injection | `click`, `type`, `key`, `hotkey`, `scroll`, `drag` | `SendInput` / `PostMessage` address windows on the input desktop |
| UWP / AppContainer activation | (driver's `launch_app`) | `IApplicationActivationManager` needs an interactive session |
| Browser tools | (driver's `browser_*`) | Chrome/Edge must run in an interactive user session, not Session 0 |
| Session scope reporting | `start_session` → `desktop_unlocked`, `effective_scope` | Reports what the daemon can actually reach |

The narrow exception is the **lifecycle and probe surface**, which works with no
desktop at all: `--version`, `status`, `doctor`, `list-tools`, `health_report`,
`check_permissions`, `get_screen_size`, `start_session` / `end_session`. Those are
exactly the calls the live test layer is allowed to make.

On this machine the question does not arise — `doctor` reports an attached
interactive desktop in session 1 — but it decides whether the whole seam is
usable, so it is the first probe to check anywhere else.

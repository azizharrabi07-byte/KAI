# Computer-use (CUA) foundation — the transport seam

This directory is KAI's Phase 1 Part P computer-use foundation. It is **thin**
and, in this phase, **fake-backed**: nothing here spawns or talks to a real
driver. This file records exactly what a later phase must wire, so the seam is
honest rather than implied.

## What is real today

- The `ComputerTransport` interface (`transport.ts`): `connect` / `inspect` /
  `act` / `observe` plus `windows`. `act` carries the closed action union
  (click, type, keypress, scroll).
- `createFakeTransport` (`fake-transport.ts`) — a deterministic implementation
  used by every test. `session.transport.endpoint.kind === "fake"`.
- The four safety mechanisms, all above the transport and all tested:
  fail-closed human hold, stale-lease generation guard, observation
  deduplication, and mid-sequence transition invalidation.

## What a later phase must implement

A real transport implementing `ComputerTransport` over **MCP over stdio** to
`cua-driver`:

1. **Spawn** the driver:
   `C:\Users\DELL\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe`
   (path is the discovered default; make it configurable).
2. **Handshake**: MCP `initialize`, then `tools/list` to learn the actual tool
   surface. Do **not** forward MCP `ping` to the driver — versions through at
   least 0.22.x answer `-32601`; answer it on the near side.
3. **Local daemon transport on Windows is a NAMED PIPE**, not a unix socket:
   `\\.\pipe\cua-driver`. Do not reach for a socket path on Windows.
4. **Version gate**: the floor is `MINIMUM_DRIVER_VERSION = "0.28.2"`
   (`transport.ts`), re-derived for the installed driver. Upstream OpenMausBot
   pins 0.19.3 / 0.20.0 — those constants are wrong for this machine and must
   not be copied.
5. **Control gate**: the real transport must remain policy-free. Who-is-driving
   is enforced by `session.ts`, never by the transport.

## Security posture

- An unreachable / unparsable / timed-out control reading is treated as HELD
  (`heldUnreachable`). Failure to confirm is never permission.
- A lease release is refused unless both its id **and** its generation still
  match the active lease, so a stale expiry timer cannot drop a live lease.
- An observation or action whose control generation changes mid-sequence is
  discarded, not returned.

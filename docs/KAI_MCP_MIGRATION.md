# KAI — MCP migration (Hermes → KAI)

**What this document is.** The record of moving MCP server connectivity from Hermes to KAI: the
servers that actually exist on this machine, the exact Hermes→KAI field mapping, the one rule that
governs every credential, and — with the same weight — the two proofs that were owed and are now
executed: **Hermes-independence** and the **live tool-collision** test. This is the Stream F
deliverable named in `docs/KAI_LOOP_HANDOFF.md` §4 and §9.

**Verification vocabulary** (used verbatim, from the mission plan): `UNIT PROVEN` · `INTEGRATION
PROVEN` · `END-TO-END PROVEN` · `MOCK ONLY` · `NOT PROVEN` · `BLOCKED_EXTERNAL` · `AUTH_FAILED`.
Nothing here is rounded up.

**Method.** Every factual claim is either a real read of a file on this machine (`file:line` or an
exact path) or a live run recorded in an evidence JSON in `docs/evidence/`. No server definition was
taken from memory, the internet, or a README.

**Machine-checked records:**

| Evidence | Covers |
|---|---|
| `docs/evidence/kai-mcp-final.json` | The MCP library: manager/routes/capability/e2e, 28 tests, full-suite numbers (Stream D, 2026-10-04) |
| `docs/evidence/kai-mcp-all-credentials-final.json` | **Every credential** across every discovered server, held as a reference, presence only |
| `docs/evidence/kai-mcp-independence-final.json` | **Hermes-independence proof** — source grep + live OS process-tree walk |
| `docs/evidence/kai-mcp-collision-live.json` | **Live tool-collision** test — two real servers, same tool name, no collision |
| `docs/evidence/mcp-integration.json` | The `/mcp` mount, before/after bodies |

---

## 1. What was migrated, and the one rule

Hermes already had MCP working: it reads `mcp_servers:` blocks from its `config.yaml` and runs the
servers. KAI needed the same capability **without inheriting Hermes's code, its process, or its
secrets**. What was migrated is therefore the *definition* of each server — command, args, url,
env-key names — never a credential value, never a process, never an import.

> **The one rule: a secret is a REFERENCE, never a value.** A stored MCP secret is
> `env:NAME` (resolve from the launch environment) or `credman:TARGET` (read Generic Credential
> `TARGET` from the Windows Credential Manager). The reference is inert at rest; a value is resolved
> only at server-launch time by the single privileged caller, and no value is ever written to a log,
> a listing, an HTTP body or an evidence file. See `core/src/mcp/secrets.ts:5-37` for the full
> rationale.

---

## 2. What actually exists on this machine (read, not assumed)

Real MCP server definitions were found in exactly two Hermes config files, read directly:

| Server | Transport | Command / URL | Env key(s) | Source file |
|---|---|---|---|---|
| `discord` | stdio | `npx -y @iqai/mcp-discord` | `DISCORD_TOKEN` | `~/.hermes/config.yaml` **and** `~/.hermes/profiles/kai/config.yaml` |
| `canva` | http | `https://mcp.canva.com/mcp` | — | `~/.hermes/profiles/automate-man/config.yaml` |

Profiles `kage` and the others define no `mcp_servers`. No `.mcp.json` and no Claude-Desktop config
exists on this machine. The `cua-driver` transport is real but is **not** a configured MCP server and
its transport is outside KAI's model — deliberately documented and **not** registered.

**No third-party MCP server beyond these two is configured anywhere on this machine.** That is the
honest boundary of what can be demonstrated here.

---

## 3. The Hermes → KAI field mapping

Hermes's `mcp_servers.<name>` block is a *launch recipe*. KAI's `McpServerEntry`
(`core/src/mcp/types.ts`, validated in `core/src/mcp/validation.ts`) is a *KAI-owned capability
record*: the same recipe, plus the risk declaration KAI requires, plus the reference form of every
secret, minus anything KAI will not trust.

| Hermes field | KAI field | Note |
|---|---|---|
| `command` | `command` | `stdio` only; `npx` is resolved to a real launcher by `real-client.ts` (Windows `npx` → `node npx-cli.js`, else `cmd.exe /c`) — see `real-client.ts:175` |
| `args` | `args` | copied verbatim |
| `env: {TOKEN: <value>}` | `env: {TOKEN: "env:TOKEN"}` | **the value is dropped; only a reference is stored** |
| `url` | `url` + `transport: "http"` | stored faithfully; `connect` refuses it (stdio-only build) → `BLOCKED_EXTERNAL` |
| `connect_timeout` / `timeout` | — | KAI uses its own `handshakeTimeoutMs` / `requestTimeoutMs` |
| *(none)* | `risk: { default, tools }` | **KAI-declared, required.** MCP `annotations` are self-reported by the server's own code and are never trusted as risk (`KAI_MCP_ARCHITECTURE.md` §3, `tool-adapter.ts`) |
| *(none)* | `enabled` | a migrated server lands **disabled**; a human enables it with `mcp.enable` |

**Fail-closed risk.** A tool with no derivable KAI-declared risk is **refused** (`POLICY_DENIED`) and
named in the connect report's `refused[]` — never defaulted to `READ`. A server migrated without a
`risk` block therefore registers zero tools, on purpose.

---

## 4. Credentials — every one held as a reference

`core/src/mcp/secrets.ts` implements the two reference kinds; `key` names, `kind`, `target` and a
status from `{ PRESENT | MISSING | UNREADABLE }` are the only things ever reported
(`registry.ts:399` `credentialReport`). Resolution fails **closed** — an unset variable or an absent
credential is a typed `AGENT_AUTH_FAILED` value with a reason, never an empty string or a silent
"no auth" fallback (`secrets.ts:109-138`).

The all-credentials run (`kai-mcp-all-credentials-final.json`, 2026-10-05) resolved **every**
credential reachable from the discovered servers:

| Source | Key | Reference | Status |
|---|---|---|---|
| `discord` | `DISCORD_TOKEN` | `env:DISCORD_TOKEN` | **PRESENT** |
| `canva` | *(none)* | — | `NOT_REQUIRED` (http, no headers) |
| Windows Credential Manager | `kai-host-token.com.aziz.kai` | `credman:…` | **PRESENT** |
| Windows Credential Manager | `hermes-api-key.com.aziz.kai` | `credman:…` | **PRESENT** |
| Windows Credential Manager | `kai-absent-target-does-not-exist.com.aziz.kai` | `credman:…` | **MISSING** (proves the fail-closed path) |

The same run connected `discord` live with the reference resolved (`env:DISCORD_TOKEN` → `PRESENT`),
reaching MCP-Discord v1.0.0 with 22 tools, and then **scanned its own written evidence file to prove
the token value does not appear in it** (`assertion.leakScan.secretAppearsInFile: false`).

**No credential value exists anywhere in the repository, in any evidence file, or in this document.**
Secret material is only ever `PRESENT` / `MISSING` / `UNREADABLE` / `NOT_REQUIRED`.

---

## 5. What was proven live

Recorded in `kai-mcp-final.json` and re-confirmed on 2026-10-05:

- **`discord` — CONNECTED.** `npx -y @iqai/mcp-discord`, MCP-Discord v1.0.0, protocol `2025-06-18`,
  **22 tools, 0 refused**. A safe `READ` (`discord_login`) executed and authenticated. Disconnect
  leaves **no stale `CONNECTED`**; reconnect restores the tools. `resources/list` returned `NOT_FOUND`
  because that server implements none — the resource mechanism itself is proven separately against
  KAI's fixture.
- **`canva` — BLOCKED_EXTERNAL.** Registration, storage and validation all succeed, but its `http`
  transport is unimplemented in this build, so `connect` refuses it honestly
  (`AGENT_NOT_LISTENING`, "this build implements the stdio transport only"). Not a fake, not a
  hidden failure — see §8.

A **real bug was found and fixed** during this migration: `npx` leaves a grandchild holding the
stdio pipe, so a plain disconnect leaked it. `real-client.ts` now does a process-tree kill plus pipe
destroy on dispose. A second defect was caught by the *full* suite (§7) — see below.

---

## 6. Hermes-independence proof — EXECUTED

**The claim:** KAI's MCP capability belongs to KAI, not to Hermes. Previously only structural
evidence existed; it is now executed and recorded in `docs/evidence/kai-mcp-independence-final.json`.

**(A) Source independence — measured grep over `core/src/mcp/**` (15 files).** References to
`hermes` / `.hermes` / `8642`: **1 total, 0 in executable code**. The single hit is a *comment* in
`real-client.ts:175` explaining why Windows `npx` is resolved to a real launcher — it describes a
Hermes-shaped input, it does not depend on Hermes. KAI's MCP modules import nothing from Hermes.

**(B) Runtime independence — live OS process-tree walk.** A standalone node process importing **only**
KAI's `core/src/mcp` modules loaded KAI's real stdio client and connected to **two real servers** — KAI's
own fixture (which needs nothing from Hermes) and the real third-party `discord` server — completing
the handshake, listing tools, and executing a tool on each. The OS tree
(`Get-CimInstance Win32_Process`) was then walked from each server pid:

```
node.exe (MCP server, child)  →  node.exe (KAI process, OWNER)  →  bash → … → Hermes.exe (ambient launcher)
```

- The MCP child's **direct parent is KAI's own node process** (`parentIsKaiHarness: true` for both).
- **No Hermes process sits between the child and KAI** (`hermesBetweenChildAndKai: false` for both).
  Hermes appears only *above* KAI — because Hermes launched this very test harness; it is the ambient
  shell, not a dependency of the MCP path.

**Verdict: `INDEPENDENCE PROVEN`.** The transport is KAI's, the process is KAI's, the catalogue is
KAI's. Hermes is neither imported nor required at runtime.

---

## 7. Tool-collision test — re-run LIVE

The unit test (`core/tests/mcp-secrets.test.ts` §5) proved namespacing at unit level only. The live
form is recorded in `docs/evidence/kai-mcp-collision-live.json` (2026-10-05): KAI's real `McpManager`
spawned **two real child MCP servers** (`alpha`, `beta`), both exposing a tool named `echo`, connected
both, and invoked each:

```
alpha echo {text:"A"} → toolId mcp.alpha.echo → "A"
beta  echo {text:"B"} → toolId mcp.beta.echo  → "B"
```

Both registered under distinct, namespaced ids (`mcp.alpha.echo`, `mcp.beta.echo`); invoking one
reached only its own server. `collisionHeld: true`, `distinctIds: true`.
**Verdict: `END-TO-END PROVEN (live)`.**

---

## 8. The full suite — re-run after the MCP change

`core: node scripts/test.mjs` on 2026-10-05, run in the **foreground** (the Hermes background-process
artifact described in the handoff does not apply):

```
ℹ tests 848 · pass 834 · fail 0 · skipped 13
```

The MCP subset: `mcp-manager` 17/17 · `mcp-capability` 6/6 · `mcp-routes` 4/4 · `mcp-runtime-e2e`
1/1 · `mcp-real` **12/12** · `mcp-secrets` · `mcp` — all pass.

**A real regression was caught and fixed by this re-run.** `mcp-real.test.ts` "dispose() settles
in-flight work and leaves no orphan process" failed reproducibly with an uncaught `EPIPE`: `dispose()`
kills the child while a write is still queued, and the child's `stdin` pipe emitted `EPIPE`
asynchronously with **no `error` listener** attached — a stream-level error reaching the event loop as
an uncaught exception. Fixed in `core/src/mcp/real-client.ts` by attaching no-op `error` listeners to
`child.stdin` and `child.stdout` (the `stderr` one already existed). This is exactly the class of
defect that a **green MCP-subset-only run hides** — the previous stream ran 15/15 but never the full
838/848-suite.

The 13 skipped tests are the live-agent suites skipping by design when their context is absent — they
are **not** green and are not reported as green.

---

## 9. What is NOT migrated / not proven — plainly

- **Remote (`http`/`sse`) transport: NOT implemented.** `canva` registers but cannot connect
  → `BLOCKED_EXTERNAL`. Say so; do not round it up.
- **Prompts, sampling, roots, elicitation: NOT implemented.** Server→client requests
  are refused explicitly so a server is never left waiting. (`resources/read` IS
  implemented and proven live — see `docs/evidence/mcp-external-live.json`.)
- **Third-party servers beyond `discord`/`canva`: none configured on this machine.** No claim is made
  about any other server. The external-process path itself is proven live against
  KAI's echo fixture (`docs/evidence/mcp-external-live.json`).
- **UI for MCP: the main window's MCP page** (servers, tools, resources, credentials
  presence, provenance, enable/connect actions).
- **Persistence mode `0600`** is honoured on POSIX; on Windows it is best-effort (NTFS ACLs govern).
- **`/identity` / build-drift**, **`attachProvider` call sites**, **13 skipped tests' explanation** —
  carried open items from the handoff, outside this stream.

---

## 10. How to re-run every proof

```bash
cd core
# full suite (foreground; watch for the background-tty artifact)
node scripts/test.mjs

# the MCP subset
node --test tests/mcp-manager.test.ts tests/mcp-capability.test.ts tests/mcp-routes.test.ts \
            tests/mcp-runtime-e2e.test.ts tests/mcp-real.test.ts tests/mcp-secrets.test.ts
```

The three live harnesses live in the agent scratch directory (they read KAI by absolute URL and never
print a secret); each writes its evidence JSON under `docs/evidence/`:

```
kai-mcp-independence.mjs    → docs/evidence/kai-mcp-independence-final.json
kai-mcp-collision-live.mjs  → docs/evidence/kai-mcp-collision-live.json
kai-mcp-all-credentials.mjs → docs/evidence/kai-mcp-all-credentials-final.json
```

The architecture of the mechanism itself is in `docs/KAI_MCP_ARCHITECTURE.md`; the module contract is
in `core/src/mcp/WIRING.md`.

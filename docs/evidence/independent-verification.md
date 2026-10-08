# Independent verification of shipped KAI artifacts and stored credential

Performed from outside the KAI app (shell + HTTP only). No build/run/build commands
were issued and the app process was left untouched. Observation time: 2026-10-01
21:41-21:42 +0100 (local). Secrets are never printed; only presence/length is
reported.

## 1. Artifacts

| path | size (bytes) | sha256 | mtime |
|---|---|---|---|
| `app/target/release/kai.exe` | 4,917,760 | `27e6d35c8653f3e32a43d8900c8005d03747e0ebb90b68a3ef64d3e14239b2c2` | 2026-10-01 21:40:53 +0100 |
| `app/target/release/bundle/nsis/KAI_0.1.1_x64-setup.exe` | 1,945,497 | `4c1d0f8b82c3f22a8971bb62b3593d2fa0e9d97b4272ec27062b8d942c95c0c8` | 2026-10-01 21:40:53 +0100 |

Both artifacts carry today's date (2026-10-01) with an mtime ~55 s before the
observation, and the executable/installer pair share the same build minute, so they
look freshly built today. Only one NSIS installer is present under
`bundle/nsis/`. The build-pipeline intermediates (`kai.exe`, `kai_lib.dll`,
`kai.pdb`) all carry the same 21:39-21:40 stamp, consistent with a single fresh
link, not a stale artifact left behind by an earlier build.

## 2. Credential Manager (presence only)

`cmdkey /list` was run and filtered for the app's service name. The following entry
is present (verbatim fields, translated):

    Cible  : LegacyGeneric:target=hermes-api-key.com.aziz.kai
    Type   : Générique
    Utilisateur : hermes-api-key
    Persistance de l'ordinateur local

- `com.aziz.kai` matches `SERVICE` in `app/src-tauri/src/secrets.rs` and the
  `identifier` in `app/src-tauri/tauri.conf.json`.
- The target string `hermes-api-key.com.aziz.kai` is exactly the
  `{user}.{service}` form the `keyring` crate writes for
  `Entry::new("com.aziz.kai", "hermes-api-key")`, and `hermes-api-key` is the first
  entry of `KNOWN_KEYS` in `secrets.rs`.
- Presence: PRESENT. Persistence: local machine (survives reboot). The secret value
  was not read and is not recorded here.
- Separately, `API_SERVER_KEY` exists in `C:\Users\DELL\.hermes\.env` with length
  32 (value not printed).

## 3. Seal checks against the BUILT bundle / binary

Sources were not used to satisfy these except to explain wiring.

| claim | how checked | observed | verdict |
|---|---|---|---|
| (a) overview view height = 210 in layout code | grep the built front-end bundle `app/dist/assets/island-Dma9Xdes.js` | `At={overview:{height:210,botX:68,botY:null,botDiameter:58,agentMode:"pills"},...}` present in built JS | VERIFIED |
| (b) Hermes run endpoint `127.0.0.1:8642` / `/v1/runs` | grep built front-end, then the exe binary | `127.0.0.1:8642` present in built front-end bundle (`island-Dma9Xdes.js`, in the "Not running" status string). `/v1/runs` absent from the front-end. In the exe: `v1/runs` x3 and `8642` x1 | VERIFIED |
| (b') exe embeds the freshly built front-end | grep exe for the built asset filenames | exe contains `island-Dma9Xdes` and `dom-CZhZGZCD`, the exact built asset names under `app/dist/assets/` | VERIFIED |
| (c) island/character bundle changed vs the previous build | look for a retained prior bundle to diff | NOT VERIFIED - see below | NOT VERIFIED |

Notes on (b): the endpoint string lives in the Rust layer, not the web layer.
`app/src-tauri/src/claude.rs:37` defines `HERMES_BASE = "http://127.0.0.1:8642"`
and calls `POST {HERMES_BASE}/v1/runs` (line 233) plus `GET .../v1/runs/{run_id}`
(line 274); `integrations.rs:826` repeats `HERMES_BASE`. The built exe carries these
strings, so the shipped binary contains the run endpoint. The front-end bundle only
carries `127.0.0.1:8642` as a display fallback (it receives `baseUrl` from Rust), and
does not itself contain `/v1/runs`.

Notes on (a): the built value differs from the committed pre-change source, where
`app/src/core/layout.ts` had `overview: { height: 160, ... }` (see `git diff`); the
built bundle and the working-tree source both now read 210, so the bundle reflects
the post-change source.

## 4. Endpoint liveness (right now)

Server was listening on `127.0.0.1:8642`.

- `GET /health` (no auth): **HTTP 200**.
- `POST /v1/runs` with `{"input":"Reply with exactly KAI-SUBAGENT-OK and nothing else."}`,
  `Authorization: Bearer <API_SERVER_KEY>`: **HTTP 202**, body
  `{"run_id": "run_6898e16b7ad549a080809cdc5e4845ab", "status": "started", "replayed": false}`.
- `GET /v1/runs/run_6898e16b7ad549a080809cdc5e4845ab`: **HTTP 200**, `status:
  completed`, `completed: true`, `output: "KAI-SUBAGENT-OK"`, `model: "hermes-agent"`,
  `runtime.provider: "opencode-go"`, `runtime.model: "deepseek-v4.1-flash"`.

The run reached a terminal `completed` status and returned exactly `KAI-SUBAGENT-OK`.

## 5. What I could not verify

- **(c) island/character bundle delta vs the previous build.** `app/dist/` is
  gitignored (`.gitignore:12`) and gets overwritten on every build, and no prior
  bundle copy (e.g. a previous installer or a `dist` backup) is retained on disk, so
  there is nothing to diff the current bundle against. Indirect evidence only: the
  current bundle embeds `height:210` while the committed source at HEAD had `height:
  160`, so the bundle was necessarily regenerated after the layout change. Character
  drawing code is unchanged versus HEAD (`git status` shows only `layout.ts` and
  `claude.rs` modified), so any island-bundle delta is attributable to the layout
  change, not to the character code. Direct comparison: NOT VERIFIED.
- **Contents of the front-end assets inside the exe.** Tauri embeds `../dist` but the
  asset bodies are not greppable as plain text in the exe (only the asset *names*
  `island-Dma9Xdes` / `dom-CZhZGZCD` are visible), so the (a) layout literal was
  confirmed in the built bundle on disk, not by reading it back out of the exe.
- **Credential value correctness.** Presence, persistence and target naming were
  confirmed; the secret itself was not read, so I cannot attest that its value is a
  valid api-server key (the live run above is consistent with a working key).

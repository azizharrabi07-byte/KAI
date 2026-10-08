# OpenCode backend mechanisms — audit for KAI reuse

Date: 2026-10-06. No OpenCode source checkout exists in this environment; what
was audited is the installed binary + API surface + MIT SDK/plugin packages +
the local gateway shim + KAI's own thin client. Nothing below copies OpenCode
code into KAI: KAI's identity, soul, memory, sessions, agent semantics and
product design remain KAI-native, and no OpenCode branding enters KAI.

## Inventory (what exists, where)

- Binary: `%AppData%\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`
  (`opencode-ai@1.18.34`, MIT). Serves `http://127.0.0.1:4096`.
- API contract: `docs/evidence/opencode-openapi.json` (162 paths).
- SDK: `<gateway>/node_modules/@opencode-ai/sdk@1.18.30` (MIT) — spawner +
  typed client used as inspiration only.
- Plugin API: `@opencode-ai/plugin@1.18.33` (MIT) — `tool.schema` pattern noted.
- Gateway shim: `C:\Users\DELL\opencode-gateway\server.js` (ISC, local only,
  embeds live keys — never bundled or copied).
- KAI's own client: `core/src/agents/opencode.ts`,
  `core/src/agents/adapters/opencodeAdapter.ts`, `core/src/lib/sse.ts`.

## Per-mechanism verdicts

| # | Mechanism | Source / Purpose / License | Verdict | KAI integration point |
|---|-----------|---------------------------|---------|----------------------|
| 1 | Commands + parsing | Server routes + markdown-command convention; MIT SDK | ADAPT (file-format idea only) | `core/src/skills/frontmatter.ts`, `core/src/commands/commands.ts` |
| 2 | Tool-call loop | Inside the binary; observable via session/message SSE | REJECT reuse / ADAPT pattern (failure detection) | `core/src/chat/brain.ts`, `core/src/tools/registry.ts` stay authoritative |
| 3 | MCP client | Server-owned connect; KAI MCP independent | REJECT (keep KAI MCP) | `core/src/mcp/manager.ts` — do not delegate |
| 4 | Providers/models | Provider JSON + overlay map; MIT SDK types | ADAPT (overlay-via-env pattern for tests) | `core/src/model/openai-compatible.ts` |
| 5 | Sessions | Server session store, opaque | REJECT — KAI sessions are KAI identity | `core/src/sessions/*` stay native; opencode sessions are ephemeral workers |
| 6 | Compaction/context | Server-side summarizer, no vendored code | ADAPT (spec the trigger, reimplement) | `core/src/memory/*`, `core/src/sessions/service.ts` (`compact`) |
| 7 | Permissions/approvals | `permission.updated`, `PERMISSION_REPLIES` enum (MIT) | ADAPT enum, REJECT auto-allow | `core/src/approvals/service.ts` |
| 8 | Skills | SKILL.md frontmatter convention; third-party licenses vary | ADAPT convention only | `core/src/skills/registry.ts`; treat external skills as content, not code |
| 9 | Plugins | `@opencode-ai/plugin` MIT, but community plugins unpinned | REJECT — do not load into KAI | none; KAI `core/src/plugins/` stays native |
| 10 | Subprocess handling | SDK `createOpencodeServer` supervision idiom (MIT) | ADAPT idiom (stdout-handshake, env-config, abort) | `core/scripts/*`, KAI-owned daemons only |
| 11 | Agent spawning | Server orchestration, no reusable code | REJECT — KAI workforce stays native | `core/src/agents/adapters/opencodeAdapter.ts:runTask` only |
| 12 | Streaming/SSE | `parseSse` is KAI-owned MIT; event names are protocol facts | KEEP | `core/src/lib/sse.ts`, `core/src/agents/opencode.ts` |
| 13 | Transcripts | Transcript JSON observed; extraction code KAI-owned | KEEP (read-only) | `core/src/sessions/service.ts` — convert then discard server copy |

## Provenance / license notes

- `opencode-ai`, `@opencode-ai/sdk`, `@opencode-ai/plugin`: MIT — safe to
  depend on and learn from, not to rebrand.
- `opencode-gateway` shim: ISC but embeds live API keys — never copied.
- `~/.config/opencode/opencode.json` files contain local API keys — never
  copied or committed.
- Community plugins/skills (`latest` tags): unpinned, unaudited licenses —
  pin and audit before any ingestion; none ingested to date.
- KAI keeps the `OpenCode` name only in `agents/opencode*` + docs/evidence.

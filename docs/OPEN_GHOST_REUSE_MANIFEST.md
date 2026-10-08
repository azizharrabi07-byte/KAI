# OpenGhost → KAI reuse manifest

**Source audited:** `ANDRETRIPOL/OpenGhost` @ commit **`42f0dc879f3cc443552d6b27a9b7998d3cc1deee`** (branch `main`, `v1.3.0-4-g42f0dc8`), checkout `C:/Users/DELL/Desktop/OpenGhost`.
**Companion:** `docs/OPEN_GHOST_AUDIT.md`.
**Classification tokens:** `REUSE` · `ADAPT` · `REIMPLEMENT` · `KEEP KAI VERSION` · `DO NOT IMPORT`.
**Rule:** code being MIT does **not** license OpenGhost branding, protected artwork, animations, or visual identity. Those are classified `DO NOT IMPORT` regardless of how clean the code is.

---

## A. Licence legend used below

From `OpenGhost/LICENSE`:
- **MIT** — "the source code: the agent engine, the tools, and the rendering engine."
- **EXCLUDED (all rights reserved)** — (1) the name OpenGhost, (2) the ghost logo/icon/glyph/splash ghost, (3) the animations, (4) the visual design (layout, colors, interface). A modified distribution must have its own name, logo, animations, and visual design; **no commercial use**.

---

## B. Classification — code components

| # | Component / exact path(s) | What it is | Licence | Class | Note |
|---|---|---|---|---|---|
| 1 | `diagram.js` (7,996 L) — parsers `parseFlow…parseRoute`, `KINDS`, `layoutFlow/layoutGraph/layoutRing`, `TYPES`, `class Scene`, `class Glide`, `renameNode`, `class DiagramView`, `compile/safeCompile`, `window.Diagram` | The drawing engine: 43 kinds, layout, animated SVG scene graph, live editing | MIT (rendering engine) | **ADAPT → REIMPLEMENT as KAI Visual Engine** | Dependency-free & separable; **port under KAI's spec→validate→render interface with KAI-written CSS**. Highest-value target. |
| 2 | `markdown.js` (974 L) — `parse/renderAll`, live mode, `renderCode` diagram dispatch (`DIAGRAM_KINDS`, `DIAGRAM_HEADER`), `calcModel`/`sheetModel` DSLs, `artHtml`, media cards, `window.Markdown` | Hand-written Markdown renderer emitting the `.md-diagram` host | MIT | **ADAPT** | The dispatch seam (fence → placeholder → engine) is worth copying; the `.md-*` CSS is not. Second-most valuable file. |
| 3 | `stream-view.js` (306 L) — `class StreamView` | Live streaming text renderer (pacing, DOM morph, reveal) | MIT | **ADAPT** | Presentation mechanism; feed from KAI's existing SSE, do not add an event path. |
| 4 | `tex.js` (268 L) — `SYMBOLS`, `render`, `window.Tex` | Own LaTeX-subset math renderer | MIT | **REUSE (with attribution)** | Self-contained, no deps. |
| 5 | `highlight.js` (96 L) — `code/markup/diff`, `window.Highlight` | Own code highlighter | MIT | **REUSE (with attribution)** | Self-contained. |
| 6 | `agent-tools.js` (988 L) — `SCHEMAS`, `needsApproval/describe/run`, `riskyShell/shellEffect/posixEffect/…`, `RISKY_CLICK` | Tool schemas + client-side risk/approval heuristic | MIT (agent engine/tools) | **ADAPT (mechanism/ideas only) → KEEP KAI authority** | Risk classifier is regex/heuristic; KAI's `policies/gate.ts` stays the sole decision. Useful for *tool-schema shapes* and *display descriptions*. |
| 7 | `agent-prompt.js` — `AGENT`, `MODES`, per-OS `SYSTEMS`, `window.AgentPrompt` | System-prompt builder, incl. diagram-formatting instructions | MIT | **ADAPT (prompting technique only)** | The “teach the model the dialect so it emits visual intent” idea is valuable; KAI owns its prompt text. |
| 8 | `chat.js` (1,746 L) — `class Chat`/`class SideChat`, `request/useTool/approve/…` | Single-agent turn loop, streaming, approvals, history, compaction | MIT (agent engine) | **DO NOT IMPORT (loop) → IDEAS ONLY** | A loop is an orchestrator; KAI Core owns missions/execution. Take only UX/streaming ideas. |
| 9 | `approval-card.js` — `ApprovalCard`, `window.ApprovalCard` | The approval card UX | MIT | **ADAPT (presentation)** | The "app-derived effect description" anti-social-engineering idea is worth keeping; KAI owns the approval *authority*. |
| 10 | `desktop/tools.js` (434 L) — `TOOLS`, `runTool`, `runShell/readFile/writeFile/editFile/listFiles/runGit/fetchUrl/videoFrames`, `environment` | Shell/fs/git/fetch/video executors (main process) | MIT (tools) | **REFERENCE** | KAI has its own workspace tools (`core/src/tools/{registry,builtin,workspace}.ts`). Useful as a catalogue of *tool ergonomics*, not to import. |
| 11 | `desktop/browser.js` (630 L) — `install()` isolated-world DOM walker, `run`, `adopt`, refs/roles | Real-browser tool engine (webContents + isolated world) | MIT (tools) | **ADAPT (interaction/observation model only)** | KAI browser is CDP-based; take the *numbered-ref / text-snapshot / shared-panel observation* idea behind KAI's transport seam. |
| 12 | `browser-panel.js` (573 L) — `class BrowserPanel` | Shared user/agent browser panel UI | MIT | **ADAPT (presentation idea)** | Presentation only; KAI owns the browser capability. |
| 13 | `desktop/browser-preload.js` | Login-detection shim (hostname only) | MIT | **REFERENCE / REIMPLEMENT** | Tiny; a privacy-respecting pattern. |
| 14 | `providers.js` + `desktop/{llm,openai,anthropic,chatgpt,keys}.js` + `deepseek.js` | Provider facade, transports, OAuth, encrypted keys | MIT (agent engine) | **REFERENCE** | KAI owns identity/secrets/providers (`core/src/agents/adapters/*`, Rust `secrets.rs`). |
| 15 | `chat-store.js`, `library.js`, `user-context.js`, `usage.js`, `chat-lock.js`, `lock-ui.js` | KV store, chat/folder index, standing context, usage, chat lock | MIT | **REFERENCE / KEEP KAI VERSION** | KAI owns persistence/memory (`core/src/storage/*`, `core/src/memory/*`). Chat-lock crypto is a curiosity, not an authority. |
| 16 | Generic UI modules (`scrollbar.js`, `smooth-height.js`, `row-glide.js`, `liquid-glass.js`, `link-chip.js`, `file-kinds.js`, `icon-button.js`, `search-field.js`, `selection-menu.js`, `stats-card.js`, `model-stage.js`, `dock.js`, `mode-picker.js`, settings-* , effort-* …) | Framework-free UI primitives | MIT | **ADAPT (technique) / KEEP KAI VERSION** | Techniques (spring easing, glass, morph) are transferable; KAI's frontend stays KAI's. |
| 17 | `desktop/main.js`, `desktop/preload.js`, `desktop/pdf.js`, `desktop/media.js` | Electron shell, contextBridge surface, PDF/video readers | MIT | **REFERENCE** | KAI's desktop host is Tauri 2 + Rust; keep KAI's. |

---

## C. Classification — branding, artwork, animation, visual identity (NEVER imported for licence reasons)

| # | Asset / exact path | Kind | Licence | Class |
|---|---|---|---|---|
| 18 | the name **`OpenGhost`** (README, titles, `package.json` `productName`, app-id `com.openghost.app`) | Branding / name | EXCLUDED | **DO NOT IMPORT** |
| 19 | `desktop/icon.ico`, `desktop/icon.png`, `desktop/icon.svg` | Logo / app icon | EXCLUDED (ghost logo) | **DO NOT IMPORT** |
| 20 | `images/icon.png` | Logo | EXCLUDED | **DO NOT IMPORT** |
| 21 | the **`GHOST`** path constant inside `glyphs.js` (+ the ghost draw on splash) | Logo / glyph | EXCLUDED (ghost logo/glyph) | **DO NOT IMPORT** (the *other* icons in `glyphs.js` are generic UI glyphs but are entangled with the file — extract case-by-case, never the ghost) |
| 22 | `images/*.jpg` (13 screenshots: `visual, scheme, food, trip, editor, browser, welcome, mini, stats, general, modes, settings, splash`) | Artwork / screenshots of the product & visual identity | EXCLUDED (visual design / artwork) | **DO NOT IMPORT** |
| 23 | `desktop/cursor.png` (403 KB) | Artwork (custom cursor) | EXCLUDED (visual identity/artwork) | **DO NOT IMPORT** |
| 24 | `splash.js`, `splash-mist.js` (WebGL/Canvas mist + flight) | Animation | EXCLUDED (animations) | **DO NOT IMPORT** |
| 25 | `welcome-ghost.js`, `ghost-thinking.js`, `desktop.js` splash hooks | Animation / branding | EXCLUDED (animations/logo) | **DO NOT IMPORT** |
| 26 | `styles.css` — the whole visual identity: `:root`/`[data-theme]` colour tokens, `--glass-*`, `--splash-*` night/mist, shadows, per-element transitions, the `.dg-*` diagram theme | Visual design: layout, colours, interface | EXCLUDED (visual design) | **DO NOT IMPORT as identity** — extract only *non-distinctive technique* (token system, reduced-motion, spring easing), with KAI-authored values |
| 27 | README prose / screenshot captions | Content | Not code (MIT does not cover excluded materials) | **DO NOT IMPORT** as product copy |

> **Layouts / colours / design assets summary:** all colour values, layout, spacing identity, glass recipes, splash art, cursor, and icons in `styles.css`, `images/**`, `desktop/{icon.*,cursor.png}` are **protected visual identity → DO NOT IMPORT**. KAI writes its own.

---

## D. Net disposition per KAI subsystem

| KAI subsystem | OpenGhost contributes | Classification |
|---|---|---|
| Visual/drawing engine (new) | `diagram.js` | **ADAPT/REIMPLEMENT (KAI-owned)** |
| Markdown/streaming presentation | `markdown.js`, `stream-view.js`, `tex.js`, `highlight.js` | **ADAPT** |
| Chat interaction/presentation ideas | `chat.js` UX, `approval-card.js` | **ADAPT (presentation only)** |
| Prompting technique | `agent-prompt.js` diagram-formatting idea | **ADAPT** |
| Browser interaction/observation model | `desktop/browser.js` idea, `browser-panel.js` | **ADAPT (behind KAI CDP seam)** |
| Agent loop / orchestration | — | **KEEP KAI VERSION** |
| Policy / approvals / permissions | — | **KEEP KAI VERSION** (authority) |
| Tools / filesystem / shell / Git | reference only | **KEEP KAI VERSION** |
| Provider/identity/secrets | reference only | **KEEP KAI VERSION** |
| Memory / context / persistence | reference only | **KEEP KAI VERSION** |
| Workforce / subagents / scheduler / recovery / observability / MCP / CUA | not present in OpenGhost | **KEEP KAI VERSION** |
| Branding / name / logo / animations / artwork / visual design | — | **DO NOT IMPORT** |

---

## E. Attribution requirement (MIT)

Any ported MIT code from OpenGhost must carry attribution in KAI's `NOTICE.md`: "Portions adapted from OpenGhost (github.com/ANDRETRIPOL/OpenGhost), MIT License, Copyright (c) 2026 Andrew," alongside the existing Coucou/upstream notices. Per-file provenance should be noted in the ported module headers.

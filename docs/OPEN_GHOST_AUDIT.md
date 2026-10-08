# OpenGhost — real-source audit

**Auditor:** delegated audit subagent · **Mode:** read-only on OpenGhost; read-only on KAI except the two docs in `docs/`.
**Date:** 2026-10-04 · **Scope:** obtain, verify, and audit the *actual* `ANDRETRIPOL/OpenGhost` source, file by file. No integration, no import, no KAI code touched.

Companion document: `docs/OPEN_GHOST_REUSE_MANIFEST.md` (per-component classification).

---

## 1. Exact repo + commit audited

| Fact | Value |
|---|---|
| Remote | `https://github.com/ANDRETRIPOL/OpenGhost.git` |
| Checkout path | `C:/Users/DELL/Desktop/OpenGhost` (outside KAI; nothing committed, nothing pushed) |
| Method | `gh repo clone ANDRETRIPOL/OpenGhost OpenGhost` (succeeded first try, account `OussemaHarrabi`) |
| Branch | `main` |
| **EXACT commit** | **`42f0dc879f3cc443552d6b27a9b7998d3cc1deee`** |
| Commit date | 2026-10-03 21:24:00 +0200 |
| Commit subject | `Add the Sponsor button and a section on supporting the project` |
| `git describe` | `v1.3.0-4-g42f0dc8` (4 commits past the `v1.3.0` tag) |
| `v1.3.0` tag SHA | `9072eafde9a347910d4654dc5b198a258aae5189` |
| Tags present | `v1.0.0`, `v1.0.1`, `v1.1.0`, `v1.2.0`, `v1.3.0` |
| Version | `package.json` `"version": "1.3.0"`, README headline “v1.3.0 beta” |
| Files tracked | **109** (81 `.js`, 1 `.css`, 2 `.html`, 2 `.yml`, 13 `.jpg`, 3 `.png`, 1 `.svg`, 1 `.ico`, 2 `.json`, 1 `.md`, 1 `LICENSE`) |

Everything below was read from this checkout. **No claim about OpenGhost internals is inferred from the README's prose, screenshots, or web articles** where the code itself answers the question; the README and images are cited only as branding/design evidence.

---

## 2. Repository structure

Flat, single-package Electron app. No monorepo, no bundler, no TypeScript. Two roots:

- **Renderer (browser context, plain `<script>` tags, IIFE globals):** ~70 `.js` files at repo root + `index.html` + `styles.css` (12,239 lines).
- **Main process (Node/Electron, `require`/`module.exports`):** `desktop/`.

```
OpenGhost/
├── index.html                 # renderer shell; loads every root .js by <script> in dependency order
├── styles.css                 # 12,239 lines — ALL visual design: tokens, glass, animations, diagram themes
├── package.json               # Electron app; deps: only @anthropic-ai/sdk; devDeps electron, electron-builder
├── LICENSE                    # split licence (MIT code / rights-reserved excluded materials)
├── README.md                  # prose + screenshots (branding/design evidence)
├── diagram.js                 # 7,996 lines — THE DRAWING ENGINE (headline asset)
├── markdown.js                # 974 lines — Markdown + fence/diagram dispatch + calc/sheet + art
├── stream-view.js             # 306 lines — live streaming text renderer
├── tex.js                     # 268 lines — own LaTeX subset renderer
├── highlight.js               # 96 lines — own code highlighter
├── glyphs.js                  # 43 lines — inline SVG icon set (mixed with branding: ghost logo)
├── chat.js                    # 1,746 lines — agent turn loop, streaming, approvals, history
├── agent-tools.js             # 988 lines — tool schemas + the approval/risk engine (renderer)
├── agent-prompt.js            # system prompt builder (per-OS)
├── approval-card.js           # the approval card UI
├── browser-panel.js           # 573 lines — in-app browser panel UI (webview host)
├── desktop.js, theme.js, i18n.js, script.js    # bootstrap / theming / i18n / wiring
├── providers.js, deepseek.js   # model-provider facade; DeepSeek calls from the page
├── chat-store.js, library.js, user-context.js, usage.js, chat-lock.js, lock-ui.js  # persistence/context/lock
├── ... ~35 single-purpose UI components (effort-*, settings-*, model-*, dock, splash, welcome-ghost …)
├── images/                    # 13 .jpg — README screenshots + icon
└── desktop/
    ├── main.js                # Electron entrypoint: window, IPC, theme, CSP host
    ├── preload.js             # contextBridge → window.openghost (the ONLY renderer↔main surface)
    ├── tools.js               # 434 lines — shell/fs/git/fetch/video tool EXECUTORS (main process)
    ├── browser.js             # 630 lines — the real browser tool engine (webContents, CDP-free, isolated world)
    ├── browser-preload.js     # login-detection shim inside browser pages
    ├── llm.js, openai.js, anthropic.js, chatgpt.js  # provider transports (main process)
    ├── keys.js                # OS-keychain-encrypted API-key store
    ├── media.js, pdf.js, pdf.html
    └── icon.ico / icon.png / icon.svg / cursor.png  # app icon + branding + cursor artwork
```

**Package/build system:** plain **npm + Electron 44 + electron-builder 26**. `npm start` = `electron .`; `npm run dist[:mac|:linux]`. No webpack/vite/rollup. `asar:true`. Runtime dependency: exactly one — `@anthropic-ai/sdk ^0.128.0`. Everything else (diagrams, markdown, math, highlight, agents) is hand-written. Confirmed against the README's "Written from scratch" claim: no Mermaid, no chart lib, no Markdown lib, no UI framework.

**Load order is the dependency graph** (`index.html` lines 144–211): primitives (`i18n`, `liquid-glass`, `scrollbar`, `glyphs`) → `deepseek`/`providers` → `tex`/`highlight`/`markdown`/`diagram` → `stream-view` → attachments/media → settings → agent (`agent-tools`, `agent-prompt`, `approval-card`) → `chat` → `browser-panel`/`lock-ui` → `script`/`splash`. Every module is an IIFE that hangs one object off `window.*` (full map in §7).

---

## 3. Architecture summary

**Two-process Electron app, renderer-heavy.**

- **Main process (`desktop/main.js`)** owns: the `BrowserWindow` (`contextIsolation:true`, `sandbox:true`, `nodeIntegration` off), the built-in browser engine, all filesystem/shell/git execution, OpenAI/ChatGPT/Anthropic transport, encrypted key storage, PDF reading, and the OS-native titlebar/theme. The renderer reaches it **only** through `desktop/preload.js`'s `window.openghost` contextBridge — a fixed, small IPC surface (`tool:run`, `llm:*`, `browser:*`, `store:*`, `keys:*`, `auth:*`, `folder:*`, `pdf:read`, `theme:set`, `window:titlebar`). Every handler is gated by a `fromApp(event)` origin check in `main.js`.
- **Renderer** holds the agent loop (`chat.js`), the tool *schemas and risk/approval logic* (`agent-tools.js`), the system prompt (`agent-prompt.js`), all rendering (markdown → diagrams → streaming), the chat library, settings, and the provider facade.
- **Security posture:** strict CSP in `index.html` (`default-src 'none'; script-src 'self'; connect-src https://api.deepseek.com` — the page may only talk to DeepSeek; OpenAI/Claude go via main). Model text is never executed: `markdown.js`/`highlight.js` build DOM from escaped strings; the diagram engine builds SVG programmatically, never from model-supplied HTML.
- **Three permission modes** (Ask/Auto/Full) drive a hand-written risk classifier in `agent-tools.js` that parses shell/git/fs commands to decide whether a step needs human approval.

**Data model:** a chat = a `Library` entry (project folder or a “no-folder” chat under `~/OpenGhost/Chats`), persisted through `ChatStore` (main-process store or localStorage). Conversation history is stored in Chat-Completions shape and converted per-provider.

---

## 4. Visual / drawing engine analysis (HIGHEST-VALUE TARGET)

**Verdict: this is the single most valuable mechanism in the repo, and it is cleanly separable.**

### 4.1 `diagram.js` — 7,996 lines, IIFE, exposes `window.Diagram`

Files it depends on: **none** at load time (it self-contains geometry, layout, animation). It reads two CSS custom properties (`--font`, `--mono-font`) and drives the `.md-diagram` hosts that `markdown.js` emits. Public API (`diagram.js` last line):

```js
window.Diagram = { view, prewarm, compile: safeCompile, renameNode, editorFor, withHeader };
```

Structure, in order:

| Region (approx lines) | What it is | Key symbols |
|---|---|---|
| 3–137 | **Design constants**: geometry for every drawing kind (NODE, FLOW_GAP, PIE, CHART, GANTT, RADAR, METRICS, FOOD, SANKEY, HEAT, GIT …), the `FONT` table, `SERIES` palette, `LAYERS`. | `FONT`, `SERIES`, `TYPE`, `LAYERS` |
| 138–500 | **Low-level helpers**: SVG element factory, text measurement / wrapping / truncation, number & amount formatting, cubic path resampling, arrowhead paths, text blocks, fade/pop. | `svg`, `setAttrs`, `textWidth`, `wrap`, `truncate`, `pathOf`, `headPath`, `textBlock` |
| 500–1174 | **Per-dialect parsers** (Mermaid-like + custom): `parseFlow`, `parseState`, `parseSequence`, `parsePie`, `parseXY`, `parseCandles`, `parseTimeline`, `parseGantt`, `parseMindmap`, `parseQuadrant`, `parseRadar`, `parseER`, `parseClass`, `parseWireframe`, `parseFiles`, `parseMetrics`, `parseBars`, `parseRanges`, `parseBoard`, `parseJourney`, `parseWaterfall`, `parseFunnel`, `parseSankey`, `parseHeat`, `parseScatter`, `parseTreemap`, `parseGit`, `parseArray`, `parseBracket`, `parseNutrition`, `parseFacts`, `parseChecklist`, `parseChanges`, `parseOutline`, `parseMatches`, `parseWords`, `parseGloss`, `parseForms`, `parseRecipe`, `parseParts`, `parseSettings`, `parseRoute`. | one `parseX` per kind |
| 1174–1765 | **Layout engine**: layered graph layout with isotonic-regression rank ordering, crossing minimisation, ring layout, level packing, s-curves, group/cluster layout, auto-turn (sideways), auto-beside. | `layoutFlow`, `layoutRing`, `packLevel`, `sCurve`, `layoutGraph` |
| 1765–5804 | **Scene builders** — one `xScene(data, tones, opts)` per kind, each returning `{ items, width, height, hints, kind, … }`. 43 scene builders. | `flowScene`, `pieScene`, `chartScene`, `candleScene`, `ganttScene`, `mindScene`, `nutritionScene`, `routeScene`, … |
| 5804–5890 | **Dispatch**: `clean()` (strips front-matter/`%%` comments), `KINDS` regex→builder table (43 entries, lines 5818–5862), `withHeader`, `compile`, `safeCompile`. | `KINDS`, `compile` |
| 5892–6590 | **Item-type renderers**: `buildCard`, `buildShape`, `shapePath`, `barPath`, and the `TYPES` registry (`view`, `node`, `edge`, `label`, `arc`, …) that draw/refresh each primitives. | `TYPES`, `buildShape` |
| 6590–6813 | **Scene graph + animation**: `Scene` class (spring-integrated property interpolation, layered SVG groups, `patch`/`set`/retarget/tick/destroy) and `Glide` (row-highlight spring). | `class Scene`, `class Glide`, `springTo`, `stepProps` |
| 6819–7262 | **Live editing helpers**: `renameNode` (rewrites source text per dialect), plus source-editing transforms. | `renameNode` |
| 7291–7995 | **`class DiagramView`** — the orchestrator: builds the SVG stage, `ResizeObserver`-driven relayout, `viewSpec`/`applyView` (scale/zoom/column logic), `pointer` interaction + tooltips, `rename` (dblclick node rename), the tools/editor toolbar, `prewarm` warm-up. | `class DiagramView`, `prewarm` |

### 4.2 The 43 kinds (from `KINDS`, `diagram.js:5818–5862`)

flow/flowchart, stateDiagram, sequenceDiagram, pie, xychart, candlestick, timeline, gantt, mindmap, quadrantChart, radar, erDiagram, classDiagram, wireframe/mockup, files/folder, metrics, bars/ledger, ranges, plan/board/kanban, steps, journey, waterfall, funnel, sankey, heatmap/calendar, scatter, treemap, gitGraph, array/cells, bracket, nutrition/food/meals, facts/passport, checklist, changes/diff, outline/contents, matches/fixtures, words/vocab, gloss, forms/conjugation, recipe/cooking, parts/build, settings/setup, route/itinerary/trip. Many are **Mermaid-dialect-compatible**; several are proprietary custom dialects (nutrition, recipe, route, forms, matches, settings, facts).

### 4.3 How the engine is invoked (the seam KAI can mirror)

1. Model emits a fenced block: ` ```mermaid … ` ``` or ` ```nutrition … ` ```.
2. `markdown.js` `renderCode()` (lines 553–567) maps the language via `DIAGRAM_KINDS` and emits a **placeholder div carrying the raw source in a data attribute**: `<div class="md-diagram" data-diagram="…" data-kind="…">`.
3. `stream-view.js` (lines 42–45, 138–146) queries `.md-diagram`, and creates `el.__view = Diagram.view(el, onChange)`.
4. `DiagramView` calls `safeCompile(source, tones, {width, column, zoom, …})` → scene spec → `Scene.set(...)`, which draws SVG and animates with springs. `safeCompile` **catches every parse error and returns `null`** — a broken spec degrades to a status/fallback, never a crash.
5. Live editing: `DiagramView` can regenerate source via `renameNode`; on change it dispatches a bubbling `diagram-edit` `CustomEvent` that `chat.js:396` listens for and persists.

**This spec → validator(`compile`/`safeCompile`) → renderer(`Scene`) → DOM/SVG boundary is exactly the shape KAI's owner wants** (“model describes WHAT, the engine decides HOW”). The model never emits SVG or DOM; it emits a text dialect that the engine parses and lays out.

### 4.4 Is it reusable / adaptable / reimplement-only?

- **Reusable as-is (MIT):** `diagram.js` is dependency-free, self-contained, plain browser JS, builds SVG via DOM APIs, no eval, no `innerHTML` of model text. It only needs `window.Diagram`, a `.md-diagram` host element, and the diagram CSS classes. It reads nothing from Electron.
- **Adaptation cost:** it relies on ~60 CSS custom properties for tones/fonts and on a large block of `styles.css` (the `.dg-*` rules). Those CSS rules are entangled with the *visual design* (licence-excluded, §11) — so **the JS is reusable, the exact CSS look is not**. KAI would supply its own theme tokens/classes.
- **Licence status:** the `LICENSE` explicitly says MIT "applies to the source code: the agent engine, the tools, **and the rendering engine**." The drawing engine is named as MIT code. The **visual design** (layout/colours/interface) is separately excluded. So: port the engine; write your own CSS.

### 4.5 Sibling rendering assets

- `tex.js` (268 lines) — a hand-written LaTeX-subset renderer producing MathML/DOM; `window.Tex.render`. MIT, reusable.
- `highlight.js` (96 lines) — hand-written, language-family code highlighter; `window.Highlight.code`. MIT, reusable.
- `markdown.js` (974 lines) — hand-written Markdown renderer with **live/incremental** mode (`live:true` used during streaming), callouts, tables, calc/sheet mini-DSLs, ASCII-art detection, media cards, and the diagram dispatch. MIT, reusable — this is the second-most valuable file after `diagram.js`.
- `stream-view.js` (306 lines) — the live streaming text renderer: token pacing, DOM node reuse/morphing, reveal animation, `Markdown.blocks(..., {live})`. MIT, reusable.
- `glyphs.js` (43 lines) — inline SVG icon set. **Mixed licence status:** icons are generic UI glyphs, but it also contains the **ghost logo path (`GHOST` const)**, which is excluded branding. Reuse would require removing the ghost glyph.

---

## 5. Agent / runtime analysis

- **Turn loop** lives in the renderer: `chat.js` (1,746 lines) — `class Chat` / `class SideChat`. Core flow: `request()` (chat.js:1038) builds messages (system prompts from `agent-prompt.js`, `UserContext` additions, history with cache marks, notes), calls `Providers.stream(...)`; content deltas feed `StreamView.push`; tool calls run through `useTool()` (chat.js:1077) → optional approval → `AgentTools.run`.
- **Tool definitions & risk engine** — `agent-tools.js` (988 lines): `SCHEMAS` (function-calling JSON schemas), `needsApproval()`, `describe()`, `run()` (bridges to main via `window.openghost.tools.run`), plus a large hand-written shell/git/fs command parser (`riskyShell`, `shellEffect`, `posixEffect`, `shellTargets`, `posixTargets`) that classifies Windows-PowerShell and POSIX commands by effect (read/delete/system/install/change/online/record/run). `RISKY_CLICK` regex flags dangerous browser clicks. This is a **risk classifier**, not a policy authority.
- **System prompt** — `agent-prompt.js`: per-OS (PowerShell/zsh/bash) persona “You are OpenGhost …”, tool usage, git discipline, internet, built-in browser, and **Formatting instructions that tell the model to emit diagrams**. Notable: the prompt deliberately teaches the model the diagram dialects — the “visual intent” is produced by prompting, then parsed by the engine.
- **Approval** — `approval-card.js`: plain-language headline, app-derived effect description (“so a harmless-sounding sentence can’t hide a deletion”), place chips, command/diff preview, remembered expand state.
- **Provider transports** — `providers.js` (facade) dispatches to `deepseek.js` (renderer, calls api.deepseek.com directly) or, via `desktop/llm.js`, to `desktop/openai.js` (Responses API + Codex/ChatGPT), `desktop/anthropic.js` (official SDK, Messages API), `desktop/chatgpt.js` (OAuth login, Codex client-id, tokens in OS keychain). Normalised result shape: `{content, reasoning, toolCalls, finishReason, usage}`.
- **Not present:** any autonomous mission scheduler, workforce manager, multi-agent orchestration, recovery ledger, or subagent system. OpenGhost is a **single-agent, single-turn-loop desktop app**. Its “agent runtime” is a tool-calling loop, nothing that competes with KAI Core.

**KAI boundary consequence:** the OpenGhost "agent" is *not* an orchestrator/policy/memory authority — it is a loop + a risk heuristic. Under the owner's rule it must still be treated as **KEEP KAI** (no second loop/registry/policy), but it poses a far smaller conflict surface than a full agent framework would.

---

## 6. Browser / tooling analysis

- **Tool executors (main):** `desktop/tools.js` `TOOLS` = `{ run_powershell|run_zsh|run_bash, read_file, video_frames, write_file, edit_file, list_files, git, fetch_url }`; `browser_*` routed to `desktop/browser.js`. Shell spawn is bounded (TIMEOUT, output head/tail caps, ANSI strip, PowerShell prelude/epilogue for exit codes), git is probed honestly, fetch capped at 5 MB.
- **The browser (`desktop/browser.js`, 630 lines):** a real in-app browser using Electron `webContents`/`webview` under a persistent partition (`persist:browser`). The heavy lifting is an **injected script run in an isolated world** (`WORLD 1077`) — `install()` (~200 lines, lines 26–280) walks the DOM, assigns numbered refs (`state.next`, `refs`, `ids`), computes accessibility-ish roles/names, and exposes snapshot/click/type/scroll/read/wait actions. The agent “sees a page as text with numbered elements”. Downloads handled; keyboard/modifier maps (`KEYS`, `MODIFIERS`); navigation history. A right-click context menu is built in `adopt()`. `browser-preload.js` reports sign-in by watching filled password fields (sends only the hostname).
- **Renderer side:** `browser-panel.js` (573 lines) is the shared user/agent panel (tabs, share-width sizing, cursor overlay, toasts) over an Electron `<webview>`; `chat.js` hands control between user and agent (`panel.userHas`, `waitForAgent`).
- **No CDP.** OpenGhost uses Electron’s own webContents API + an isolated-world DOM script, not the Chrome DevTools Protocol. KAI’s browser capability is CDP-based (`core/src/capabilities/browser/cdp-transport.ts`). The *mechanism* is different; only the **interaction/observation idea** (numbered refs, text snapshot, shared panel) is transferable.

---

## 7. UI / rendering analysis

- **No framework.** Every control is a custom element or plain class wired in `script.js` / `index.html`. ~35 single-purpose modules, each an IIFE exposing `window.X`.
- **Window/DOM exports (full map):** `AddMenu, AgentPrompt, AgentTools, ApprovalCard, AttachmentReader, Attachments, BrowserPanel, Chat, SideChat, ChatList, ChatLock, ChatStore, ComposerText, DeepSeek, Diagram, Dock, StageWord, StageVeil, EffortMorph, EffortPaint, EffortSlider, EffortStage, FileKinds, FolderPill, Glyphs, Highlight, IconButton, Library, LinkChip, LiquidGlass, LockScreen, LockCard, Markdown, MediaEmbed, MediaSlider, MiniChat, ModelGlyph, ModelStage, ModePicker, Providers, RowGlide, Scrollbar, SearchField, SelectionFocus, SelectionMenu, Settings, AppearanceSettings, GeneralSettings, UsageSettings, SmoothHeight, SplashMist, StatsCard, StreamView, Tex, Theme, Usage, UserContext, WelcomeGhost`.
- **Styling:** `styles.css` (12,239 lines) is the whole visual identity — theme tokens under `:root`/`[data-theme=dark|light]`, the `--glass-*` glassmorphism system, splash night/mist tokens, per-element animations, and the `.dg-*` diagram themes. **This file is the bulk of the protected “visual design”.** Reusable *ideas* (token-driven theming, glass primitives, spring easings), not the exact values.
- **Motion:** springs are sampled into `linear()` easings (`lock-ui.js spring()`, `diagram.js springTo`, `row-glide.js`), reduced-motion respected throughout.
- **Splash / branding modules:** `splash.js`, `splash-mist.js`, `welcome-ghost.js`, `ghost-thinking.js`, `desktop/cursor.png`, `desktop/icon.*`, and the `GHOST` glyph — all part of the protected visual identity.

---

## 8. Streaming / event architecture

- **Renderer streaming:** `stream-view.js` — `class StreamView` receives cumulative content via `push()`, re-renders `Markdown.blocks(source,{live:true})`, and morphs the existing DOM (node reuse for `P`/`DIV`/`H*`, grapheme-aware segmenter, wave reveal, paced to the model). `finish()` settles. `chat.js:1056` drives it from provider `onContent` deltas.
- **Diagram live mode:** while a fenced block is still open, `markdown.js` marks the host `data-live` and `DiagramView` recompiles as text arrives.
- **Main↔renderer events:** provider runs are event-based over IPC — `llm:start`/`llm:abort` (send) with `llm:event` (deltas/done/error) back; `browser:event` similarly. There is **no SSE, no WebSocket, no event bus** and no cross-process event log. Streaming is deltas pushed from the fetch/SSE of each provider transport, forwarded once.
- **Contrast with KAI:** KAI's authoritative stream is SSE `GET /core/events` with a typed `{id,type,timestamp,source,payload,…}` frame on a real event bus. OpenGhost's model is **presentation-only deltas** — a source of UI/pacing mechanisms, not an event architecture.

---

## 9. Persistence / context analysis

- **`ChatStore` (`chat-store.js`, 19 lines):** `window.openghost.store` (main-process `store:read/write/remove`) with a localStorage fallback. One tiny KV interface.
- **`Library` (`library.js`, 365 lines):** the chat/folder index (`INDEX`), debounced saves (`SAVE_DELAY 250`), titles, no-folder chats under `~/OpenGhost/Chats`, case-insensitive path keys per-OS.
- **`UserContext` (`user-context.js`, 162 lines):** the “tell it once” standing instructions + always-attached files, injected into every request's system prompt (and re-injected after compaction). Bounded (`LIMITS`), image-weighted.
- **`Usage` (`usage.js`, 149 lines):** local token accounting per day/model/provider.
- **`chat-lock.js` / `lock-ui.js`:** real client-side encryption of a locked chat (PBKDF iterations, seal/open) + the lock UI.
- **Context / compaction:** history is kept in Chat-Completions shape; `chat.js` builds `notes`, cache seams (`cache:true`), and compacts against each model's window (`Compact chat`). No vector memory, no journal, no memory engine.
- **Contrast with KAI:** OpenGhost is **chat-history + one settings blob**. KAI owns SQLite storage, memory engine/capture/journal, identity/soul (SOUL/USER/MEMORY.md), and the event bus. This is **KEEP KAI** with certainty; OpenGhost persistence is a UI-state pattern only.

---

## 10. Security / approval analysis

- **Process isolation:** `contextIsolation:true`, `sandbox:true`, no `nodeIntegration`; renderer only via `contextBridge`. Every IPC handler origin-checked (`fromApp(event)`).
- **CSP:** `default-src 'none'`, `script-src 'self'`, page may `connect-src` only `https://api.deepseek.com`; other providers via main. No remote code, no eval from model text.
- **Injection safety:** markdown/code/art all escape before DOM; diagrams are built from parsed data as SVG DOM objects, never model HTML; `MediaEmbed.trusted` gates embeds.
- **Risk/approval model:** three modes (Ask/Auto/Full); `agent-tools.js` classifies command effects and requires approval for write/destructive/system/online/risky-git/risky-click; the approval card restates the *machine effect* independently of the model's own description (anti-social-engineering).
- **Secrets:** API keys and the ChatGPT OAuth tokens are encrypted with the OS keychain (`safeStorage`) in `desktop/keys.js` / `desktop/chatgpt.js`; keys loaded before the window opens. README credits a prior plaintext-key bug, fixed in v1.2.0.
- **Browser:** isolated world; page scripts can't see the injected agent; only hostname leaves on sign-in detection.
- **What it is not:** there is no policy engine, no capability/risk registry as a service, no approval *authority* — it is a **client-side heuristic + a card**. KAI's `policies/gate.ts`, `policies/mode.ts`, `approvals/service.ts` remain the sole authority.
- **Residual risk to record:** the risk classifier is regex/heuristic (e.g. `RISKY_CLICK`, `RISKY_SHELL`). Needed only as *inspiration*, never as authority.

---

## 11. Licence analysis

**Single licence file: `LICENSE` (no `LICENSE-ASSETS.md`, no `NOTICE`).** Verbatim structure:

- “OpenGhost is covered by two terms.”
- MIT “applies to **the source code: the agent engine, the tools, and the rendering engine**.”
- “It does not apply to the **excluded materials**. Those stay with Andrew, **all rights reserved**.”
- **Excluded materials (verbatim list):**
  1. the name OpenGhost and any name close enough to be taken for it
  2. the ghost logo, including the icon, the glyph, and the ghost on the splash screen
  3. the animations
  4. the visual design of the application, including its layout, colors, and interface
- **Permitted with excluded materials:** run the official OpenGhost; build/run this repo unchanged for yourself; keep a GitHub fork to propose changes.
- **Forbidden with excluded materials (paid or free):** publish/distribute/host a modified version keeping any of them (a modified version must have its own name, logo, animations, visual design); redistribute as your own/under another name or in a way taken for official; **any commercial purpose** (product, service, company, paid, advertised, for profit, including a fork, rebrand, hosted).
- Other uses need written permission from Andrew.
- Then the standard **MIT License, Copyright (c) 2026 Andrew**.

**Implications for KAI (see manifest for the per-file split):**
- **Code covered (MIT, reusable with attribution):** the agent engine, tools, and **the rendering engine** — i.e. `diagram.js`, `markdown.js`, `tex.js`, `highlight.js`, `stream-view.js`, `agent-tools.js` logic, `desktop/tools.js`, `desktop/browser.js` engine, provider transports.
- **Excluded (rights-reserved, DO NOT IMPORT):** the name, the ghost logo/glyph/icon/splash ghost, the animations, and the visual design (layout, colors, interface) — most concretely `styles.css`'s identity, `glyphs.js`'s `GHOST`, `desktop/icon.*`, `desktop/cursor.png`, all `images/*`, and the splash/welcome modules.
- **Grey area to flag, not guess:** `styles.css` mixes *generic mechanism* (token system, glass, motion) with *protected design*; treat the file as protected, extract only non-distinctive techniques, and never copy its exact values. The README prose/screenshot captions are content, not code.

**Precedent in KAI (already established):** KAI's `NOTICE.md` records that the ancestor **Coucou** project used `LICENSE-ASSETS.md` to separate MIT code from rights-reserved name/character/sounds, and KAI reused only the MIT code, deleted the upstream character (`src/mochi/`), and ships no upstream audio/art; **OpenMausBot's `enterprise/` was source-available and deliberately not imported.** OpenGhost's two-term `LICENSE` is the same pattern; apply the same discipline.

---

## 12. File-by-file reuse candidates (summary — full table in the manifest)

**Highest-value MIT source files for KAI (exact paths):** `diagram.js`, `markdown.js`, `stream-view.js`, `tex.js`, `highlight.js` (the visual/render stack); `agent-tools.js`, `agent-prompt.js`, `chat.js`, `approval-card.js` (loop + risk + prompt + approval UX, mechanism only); `desktop/tools.js`, `desktop/browser.js`, `browser-panel.js` (tool executors + browser observation model); `desktop/{llm,openai,anthropic,chatgpt,keys}.js`, `providers.js`, `deepseek.js` (provider normalisation, reference only).

**Do-not-import (branding/art/design):** `images/**`, `desktop/icon.{ico,png,svg}`, `desktop/cursor.png`, the `GHOST` glyph in `glyphs.js`, `splash.js`, `splash-mist.js`, `welcome-ghost.js`, `ghost-thinking.js`, and the identity content of `styles.css`.

---

## 13. The KAI integration boundary

**KAI remains the SINGLE control plane.** OpenGhost is a **source of mechanisms**, not a second runtime.

Intended future shape (owner's rule, recorded here):

```
LLM / worker → KAI Core → visual intent → schema validation → KAI Visual Engine → rendered UI
                              (the model describes WHAT; the engine decides HOW)
```

- **KAI keeps ownership of:** identity, soul, memory, missions, policy, approvals, workforce, subagents, workers, scheduler, recovery, observability, permissions, MCP, browser/CDP, CUA, security, persistence.
- **OpenGhost must NOT become:** a second agent orchestrator, policy engine, approval system, workforce manager, memory authority, tool registry, or security authority.
- **What KAI takes from OpenGhost:** the **drawing/diagram engine** and its spec→validate→render boundary; the **live streaming renderer**; the **rich chat/Markdown presentation**; the **interaction/rendering model** (numbered DOM refs, shared browser panel presentation); and **desktop/presentation ideas** — always as KAI-owned mechanisms behind KAI's existing seams (renderer interface; transport seam for browser/CUA).

Existing KAI seams the mechanisms must land behind (from `docs/openghost-integration-audit.md`, traced): `app/src/character/{engine,orb,types}.ts` (drawing already isolated behind `types.ts` — the diagram engine should enter the same way), `core/src/capabilities/browser/cdp-transport.ts` (browser transport seam), `core/src/capabilities/computer/real-transport.ts` (CUA seam), `core/src/api/routes.ts` + `core/src/server.ts` SSE (the only event path).

---

## 14. What must NOT be imported

1. **Any OpenGhost agent loop / control plane** as a competing runtime — KAI Core only.
2. **Any second tool registry, policy engine, approval service, workforce manager, memory authority, or security authority.**
3. **The OpenGhost name, ghost logo, glyph, icon, splash ghost, animations, or visual design** (layout/colours/interface) — rights-reserved, and per the licence a modified distribution must have its own name/logo/animation/design.
4. **`images/**`, `desktop/icon.*`, `desktop/cursor.png`, the `GHOST` glyph path, and the splash/welcome branding modules.**
5. **The exact `styles.css` identity** — never copy its colours/layout/animation values; KAI supplies its own.
6. **Any path where an LLM's raw text becomes DOM/HTML/SVG or reaches the machine directly** — the required shape is spec → validate → render.
7. **OpenGhost's regex risk-classifier as an authority** — at most inspiration; KAI's `policies/gate.ts` decides.
8. **Provider OAuth/credential handling copied wholesale** — KAI owns secrets/identity; OpenGhost's `keys.js`/`chatgpt.js` are references only.

---

## 15. Recommended implementation sequence

1. **Licence gate (done for source; keep the artifact):** this audit + the manifest are the allow/deny list. Nothing is adapted without them.
2. **Define the KAI-owned visual-spec contract** — a structured spec type + validator + renderer interface, mirroring how `app/src/character/types.ts` already isolates drawing. The LLM emits a spec; the validator rejects malformed specs; the renderer draws. No DOM from the model. (This is the seam that makes OpenGhost's engine *portable*: OpenGhost's own boundary is source-text → `compile` → scene spec → SVG.)
3. **Port the drawing engine as a KAI module** (`REIMPLEMENT/ADAPT` from `diagram.js`): bring parsers + layout + `Scene` + `DiagramView` over as KAI-owned code under KAI's renderer interface, **with KAI-written CSS** (no OpenGhost design values). Attribute MIT in `NOTICE.md`.
4. **Port the render stack** (`markdown.js` live mode, `stream-view.js`, `tex.js`, `highlight.js`) behind KAI's presentation layer, then wire the streaming presentation onto KAI's **existing** SSE (`/core/events`) — do not add a second event path.
5. **Adopt browser/interaction presentation ideas** only, behind the CDP transport seam; keep CDP authoritative.
6. **One mechanism per PR**, each behind its existing seam, each covered by a KAI test; re-run both KAI suites on a clean checkout at each step (another agent currently owns the regression baseline).

---

## 16. Risks / conflicts with KAI's architecture

- **Authority-drift (highest):** importing the OpenGhost loop/tools wholesale would create a second control plane. Structural guards already in KAI (single `runtime.ts`, “no second manager”, worker-never-the-speaker) must be asserted in tests on any import.
- **Licence/asset contamination:** the drawing engine's JS is MIT but its look lives in protected `styles.css`; copying CSS wholesale would contaminate KAI's UI and breach the licence. Mitigation: KAI-authored CSS, plus the Coucou-style delete/replace-and-verify discipline.
- **Porting cost:** `diagram.js` is 8k lines and tightly coupled to its own CSS class names/`FONT` metrics; a faithful port is real work, and the `FONT` table assumes specific rendered font sizes (documented in-file: “the stylesheet gives the same numbers to the class each one stands for”). KAI must keep measurement and CSS in sync.
- **Dialect surface:** 43 kinds include proprietary dialects; KAI should port the mechanism and a chosen subset of kinds, not necessarily all 43.
- **Event-model mismatch:** OpenGhost is presentation-only deltas; KAI is an authoritative event bus. Keep them separate — the visual engine consumes KAI events, it does not replace them.
- **Browser-mechanism mismatch:** OpenGhost = Electron webContents + isolated-world DOM script; KAI = CDP. Only the observation/interaction idea transfers.
- **Quarantine of KAI's visual engine:** KAI already declares its character (`app/src/character/*`) an original, not derived from upstream artwork; the OpenGhost port must land *beside* it as a separate, clearly-attributed module, not contaminate it.
- **Dirty-tree/parallel agents:** three agents are editing KAI (island, memory, character). Any port PR must rebase and re-run both suites; do not stage other agents' files.

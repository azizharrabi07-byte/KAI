# KAI — source lineage and third-party notices

## Upstream

KAI's Windows desktop shell is derived from the `windows/` implementation of **Coucou** — a desktop
companion app by **Louis Raillé**.

- Upstream: https://github.com/Louis-CFM/coucou
- Windows implementation: https://github.com/Louis-CFM/coucou/tree/main/windows
- Pinned reference commit: `8e12bed56134d2ee7165e73f132646b143ce56e4`
  ("docs: changelog for Windows CI artifact download")
- Local read-only reference clone used during the migration: `C:\Users\DELL\Desktop\coucou-source`
- Migration record and rebrand audit: `docs/migration.md`

## Licence of the reused part

The **source code** of Coucou is licensed under the MIT License, Copyright (c) 2026 Louis Raillé.
Those terms are preserved verbatim in `LICENSE`, and this file records the lineage. MIT requires the
upstream copyright notice to travel with the source, and it does.

## What is NOT reused (rights reserved upstream)

Coucou's own `LICENSE-ASSETS.md` states that the MIT License covers the **source code only** and that
the brand and artwork remain the property of the author:

> - the names **"Coucou"** and **"Mochi"**;
> - the **Mochi character** — its design, look, expressions and animations as a character;
> - the **app icon** and **menu bar icon**;
> - the **sounds**;
> - the **images, GIFs and videos**.

The same file says, explicitly: *"If you fork Coucou to ship your own app, that's welcome under the
MIT License: just give it your own name, icon, character and sounds."* That is what KAI does.

| Upstream asset | Upstream location | What KAI did |
|---|---|---|
| The names "Coucou" and "Mochi" | everywhere | Never used. 196 replacements across 42 files; audit returns 0 hits |
| The Mochi character (design, look, expressions, animations) | drawn procedurally in `windows/src/mochi/` | `src/mochi/` **deleted**; replaced by `src/character/` — an original squircle "core" with a single horizontal iris band, orbiting ticks, an intake aperture and its own particle set |
| App icon and menu-bar icon | `NotchBuddy/Assets.xcassets/`, `windows/src-tauri/icons/` | All 5 files **regenerated** from KAI's own mark by `scripts/gen-icons.mjs` |
| The 28 sounds | `NotchBuddy/Resources/sounds/` | Not copied. KAI ships **no audio files**: all 28 voices are synthesised at runtime from the recipe table in `src/core/sound.ts`. The upstream `SOUNDS_DIR` plugin was removed from `vite.config.ts` |
| Images, GIFs, videos | `docs/media/`, `design/`, `windows/screenshots/` | Not copied; `screenshots/` deleted |

The upstream Windows tree references the macOS sound folder through `SOUNDS_DIR` in
`vite.config.ts` and ships **no** audio of its own. KAI contains no upstream audio and no upstream
character art: `find app core -iname '*.wav'` returns nothing, and `app/dist/` is built without a
`sounds/` directory.

## Verification

Run the rebrand audit recorded in `docs/migration.md` §5. As of the migration it returns zero hits
for `coucou`, `Coucou`, `COUCOU`, `mochi`, `Mochi`, `MOCHI`, `NotchBuddy`, `louisraille`,
`Louis Raille` and `Raill`, both across the sources and inside the built bundle. The only files in
this repository containing upstream branding are the evidence files in `docs/evidence/`, which exist
to document what upstream looked like.

## OpenGhost — an adapted mechanism (visual/diagram engine)

The **KAI Visual Engine** (`core/src/visual/`, `app/src/visual/`) adapts one mechanism from
**OpenGhost**, a desktop agent app by **Andrew (ANDRETRIPOL)**: the *structured-visual-intent* seam
and its rank-layered flow layout. A model's text is parsed into a bounded, typed intent that a
validator either accepts or refuses; the renderer draws only an accepted intent.

> Portions adapted from OpenGhost (github.com/ANDRETRIPOL/OpenGhost), MIT License, Copyright (c) 2026 Andrew.

- Upstream: https://github.com/ANDRETRIPOL/OpenGhost
- Pinned reference commit: `42f0dc879f3cc443552d6b27a9b7998d3cc1deee` (`v1.3.0-4-g42f0dc8`, branch `main`)
- Local read-only reference clone used during the audit: `C:\Users\DELL\Desktop\OpenGhost`
- Audit and per-component reuse classification: `docs/OPEN_GHOST_AUDIT.md`, `docs/OPEN_GHOST_REUSE_MANIFEST.md`

Only the MIT-covered **rendering mechanism** was learned from: the idea of a text dialect parsed
into a layered graph, laid out by rank, and drawn as an animated SVG scene. The code is KAI's own
TypeScript, written to KAI's own contract, with KAI's own names, limits, geometry and CSS. KAI's
renderer is the single authority: an intent is validated before it is drawn, and the renderer
re-guards it.

The chat surface additionally adapts OpenGhost's MIT-covered **presentation** modules — the
hand-written, dependency-free Markdown renderer (`app/src/chat/vendor/markdown.ts`), the streaming
reveal/pacing mechanism (`app/src/chat/vendor/stream-view.ts`), the LaTeX-subset math renderer
(`app/src/chat/vendor/tex.ts`) and the code highlighter (`app/src/chat/vendor/highlight.ts`). The
mechanisms are reused under KAI's own contract; OpenGhost's `.md-*`/`.dg-*` CSS is **not** imported —
the chat surface's stylesheet (`app/src/chat/chat.css`) is KAI's own. Each ported file carries a
provenance header.

## What is NOT reused from OpenGhost (rights reserved upstream)

OpenGhost's own `LICENSE` states that the MIT License covers **the source code** — the agent engine,
the tools and the rendering engine — and that the following are **excluded materials, all rights
reserved**: the name *OpenGhost*, the ghost logo/icon/glyph/splash ghost, the animations, and the
visual design of the application (layout, colours, interface).

| Upstream asset | What KAI did |
|---|---|
| The name **"OpenGhost"** | Never used in the product. Appears only in `docs/` audit/evidence and this notice |
| The ghost logo, icon, glyph, splash ghost | **Not imported.** KAI's icon set is its own (`scripts/gen-icons.mjs`) |
| `styles.css` (the visual identity) | **Not imported.** The engine's CSS (`app/src/visual/visual.css`) is KAI's, referencing KAI's own CSS variables (`--card`, `--ink`, `--indigo`, …) |
| `images/**`, `desktop/cursor.png`, splash/welcome modules | **Not imported** |
| The animations | **Not imported.** The entrance is KAI's own spring integration, written for KAI |
| OpenGhost's agent loop, tool registry, policy/approval engine, providers, persistence | **Not imported.** KAI Core remains the single control plane and the single policy authority |

## Third-party products referenced, not bundled

KAI talks to products that are installed separately on the machine and are not distributed with it:
**Hermes Agent** (Nous Research), **OpenCode**, **Claude Code** (Anthropic), **Visual Studio Code**
(Microsoft), and the optional Stripe / GitHub / Vercel / n8n / Resend / Notion / Cal.com services.
Their names and marks belong to their owners.

## KAI's own assets

The KAI character, the KAI icon set, the launch sequence and the synthesised sound palette were
created for this project and are covered by the same MIT licence as the source code (see `LICENSE`,
Copyright (c) 2026 Aziz).

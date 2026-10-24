# KAI3D — KAI's 3D character

The 3D character from the supplied `kai 3d v3` project, integrated into KAI2 as the
app's real avatar (the welcome hero and the Character Studio preview), with grooming,
colour and motion made configurable and persistent.

Everything here is frontend-only. No Core, research, worker, tool or API file is
touched: the character consumes the state KAI2 already publishes
(`kai:character-state`) and never decides anything about KAI's work.

## What is here

```
avatar3d/
  build.mjs                 esbuild → ../kai-avatar3d.js (classic script, committed)
  src/
    blobCreature.js         ┐
    furSystem.js            │ the supplied KAI 3D character library, copied
    furShaders.js           │ VERBATIM from `kai 3d v3/src/` — no edits, so a
    gpuPhysics.js           │ future drop of the library can be diffed by file
    kaiState.js             │
    stateIndicators.js      ┘
    character-config.js     the normalized character model + presets + storage
    state-bridge.js         KAI2 runtime state → character state (pure, testable)
    stage.js                one renderer/scene/loop, config → uniforms, state → pose
    element.js              <kai-avatar>, the only thing that creates a stage
    index.js                the bundle entry → window.KaiAvatar
```

Consumers:

| File | Role |
| --- | --- |
| `index.html` | loads `kai-avatar3d.js`; hosts `<kai-avatar>` in the welcome hero; adds the **Character** settings tab |
| `welcome-ghost.js` | shows the static welcome avatar, pauses it when faded out, resumes on enter |
| `settings-character.js` | the Character Studio page |
| `script.js` | instantiates `CharacterSettings` (one line) |
| `styles.css` | `.character-*` studio styles (appended block) |
| `i18n.js` | three strings for the tab, its lead and the preview label |
| `test/character-studio.test.js` | the model/state rules |

## Build

`kai-avatar3d.js` is generated and committed (the app has no runtime bundler and
loads every file as `<script src>` under a strict CSP). To rebuild:

```sh
npm i three@0.186.1 esbuild@0.25.0   # once, anywhere esbuild's CJS entry is resolvable
npm run build:avatar                 # node avatar3d/build.mjs
```

`build.mjs` looks for `three` and `esbuild` in the repo first, then in
`C:/tmp/kai-avatar-build` (the scratch install used for the committed bundle). The
bundle is self-contained (three r186 included).

### Packaging

The packaged app carries the character: `npm run dist:portable` stamps
`desktop/core-expected.json` from the deployed Core, builds `dist/win-unpacked` and
`dist/KAI2.exe` (the shortcut's target), then `npm run verify:core` proves the
package expects the Core it ships against. Verified after the build:

* `dist/win-unpacked/resources/app.asar` contains `kai-avatar3d.js`,
  `settings-character.js` and `avatar3d/`;
* the portable build launches with the welcome avatar live and the Character tab
  present (packaged app, real profile, no console errors);
* a character saved in the packaged app reloads into the welcome avatar from the real
  profile (`kai.character.v1`), which is the persistence path end to end;
* the Core contract reads `contract OK`.

The stamp rewrites `desktop/core-expected.json` (the repo's own release step); no
other backend file is touched by this feature.

## Appearance model (`character-config.js`)

Saved under the webview store key `kai.character.v1`, schema `version: 1`:

```jsonc
{
  "version": 1,
  "preset": "kai-official | custom",
  "furStyle": "straight | soft | wavy | curly | fluffy | short",
  "fur": { "length", "density", "clumping", "curliness", "roughness", "specular" },
  "palette": { "id", "base", "tip", "accent" },
  "motion": { "personality", "speed", "intensity", "wind", "accentStrength", "reducedMotion" },
  "render": { "quality": "auto | high | light" }
}
```

* Every value is clamped to the range the renderer accepts (`LIMITS`); unknown
  styles/presets/colours/of a future version fall back to KAI's default instead of
  reaching a shader.
* `curliness` is bounded by `MAX_CURL_SWEEP / length` (0.34): above that sideways
  sweep the outer locks close over the eyes. The studio shows the clamped value.
* `preset` is only kept while the config still matches that preset; any edit makes
  it `custom`.
* Saving writes the store and dispatches `kai:character-changed`; `<kai-avatar>`
  elements apply it live. Drafts never write.

### What each control actually moves

| Control | Renderer effect |
| --- | --- |
| Fur style | `furLength`, `uCurliness` (spiral in the strand/shell vertex shaders), `uClumping` (tuft pull), density → strand instance count |
| Length / Density / Clump / Curl / Roughness / Sheen | the matching uniforms; density only changes the instance count (`updateDensity`) |
| Root / Tip / Accent | `uBaseColor`, `uTipColor`, the skin material, and the rim light / `uRimLightColor` |
| Personality / Speed / Expressiveness | `KAIStateController.setAnimationSpeed` / `setAnimationIntensity` (amplitude multiplier) |
| Fur wind | `uWindStrength` (and the GPGPU wind uniform in high mode) |
| State tint | how much of the CURRENT state's palette is blended over the saved one |
| Fur quality | light (32 shells / 26k strands) vs high (64 / 60k + GPGPU physics, if WebGL2 float RTT exists) |
| Reduced motion | paints settled still frames; the render loop stops |

State colour never overwrites the saved palette: `STATE_ACCENT` is 0 at idle, so at
rest the chosen palette renders exactly, and a running/approval/error/success state
tints it only until it leaves.

## State mapping (`state-bridge.js`)

`kai-character-state.js` (unchanged) publishes the real state; the avatar maps:

| KAI2 (`kai:character-state`) | character | one-shot |
| --- | --- | --- |
| `idle` | idle | — |
| `listening` | idle (the 3D face has no separate listening pose; nothing is faked) | — |
| `thinking` | thinking | ponder |
| `working` | working | engage |
| `waiting_approval` | waiting_for_approval | approval alert |
| `success` | success | celebration + sparkle |
| `error` | error | recoil + error cue |
| `offline` | offline | settle |

Additionally the character reads the bridge's REAL tool activity
(`window.KAI2.onActivity`, the same entries the activity strip renders — see
`avatar3d/src/activity.js`):

| bridge entry | character |
| --- | --- |
| `tool_start` | working (a tool is actually running) |
| `tool_approval_required` / `APPROVAL_REQUIRED` | waiting_for_approval |
| `tool_error` / `INVALID` / `FAILED` / `NOT_FOUND` | one error recoil (a one-shot; the persistent state is not claimed) |
| `tool_done` / `EXECUTED` | returns to the runtime state — never a celebration |
| `DENIED` | returns to the runtime state — a person's decision, not a failure |

The runtime's safety states (`offline`, `error`, `success`) always win over a running
tool, and an entry key dedupes repeated frames so nothing restarts.

The gate fires an entrance animation only on a real transition (`AvatarStateGate`),
so repeated status reads never restart a celebration. `paused` is in the character's
vocabulary but KAI2 does not signal it — it is listed in the studio's Advanced →
Signals note instead of being invented. The studio's motion preview drives its own
element only.

## Every KAI face is the character (not just the welcome)

The old 2D orb still existed in the splash and beside every reply — the surfaces a
person actually watches while KAI works. `<ghost-thinking>` is that old face, and it
now mounts the 3D character by default:

* ONE hidden `<kai-avatar source>` renders the character at 256 px (pixel ratio 1,
  `preserveDrawingBuffer`, `alwaysRender`);
* every `<ghost-thinking>` — the launch splash, a message status, the chat mark, the
  mini-chat empty state, the effort panel — copies that frame into its own 2D canvas
  (`avatar3d/src/mirror.js`). No WebGL context per mark;
* the source follows the same `kai:character-state`, `kai2.onActivity` and saved
  config as the welcome hero, and pauses when no mirror is on screen;
* a `look()` from the splash or the pointer gaze is forwarded to the source;
* without WebGL, `<ghost-thinking>` keeps its original 2D engine.

The old character's static art is gone too: `Glyphs.ghost` — the titlebar mark, the
theme-preview card, the mini-chat title and the browser panel — is now
`assets/kai-avatar-mark.png`, and `assets/kai-avatar.png` + `desktop/icon.png` /
`desktop/icon.ico` (six PNG sizes) are rendered from the same 3D character with KAI's
default palette.

The welcome hero keeps its own stage (it is the large, framed surface). Two stages
coexist only while the splash and the welcome are both visible.

## Core expectation (packaged app)

`desktop/core-expected.json` is the Core build KAI2 accepts. A normal release pins
it: `npm run dist:portable` stamps and verifies an exact id.

While another process is rebuilding the Core, a pinned id goes stale within minutes
(KAI2 then shows "talking to the wrong KAI Core build" and refuses turns). For that
workspace there is `npm run dist:portable:track`, which stamps
`--mode track`: any Core with a verifiable build identity is accepted, the UI still
names the build it talks to, and `verify-core-contract` checks that the package
carries a track expectation and that the Core names itself. Releases use the pinned
command; this checkout uses track.

## Framing (fixed)

The camera is fitted to the character's real bounds — body bounding sphere + the coat's
current length — for the narrower of the two fields of view, with a 1.15 margin. The
old fixed distance ignored the fur: at 168×184 with a 0.43 coat the rendered silhouette
touched both side edges (margins 0 px). The live checks assert non-zero margins at
0.5/0.91/1.0/1.7 aspects and 0.22/0.43/0.62 coats.

The mirror crop is size-aware: a large mirror (the launch splash) copies the whole
frame; a small mark (≤64 px) crops to the face, where a full figure would be a speck.

## Lifecycle and performance

* One `AvatarStage` per `<kai-avatar>`: one renderer, one RAF loop, one asset set.
  Two can coexist (welcome + studio); each is disposed with its element.
* Lazy: no WebGL context until the element has a size and is on screen.
* Paused when the welcome fades out (`welcome-ghost.js` calls `pause()`), when the
  element leaves the viewport (`IntersectionObserver`) and when the document is
  hidden.
* Frame budget: 30 fps for the ambient welcome, 60 fps for the interactive preview.
* Appearance edits write uniforms only; geometry is never rebuilt. Verified in the
  app: 60 slider edits left `bodyGeometry` and the shell geometry the same objects.
* Sampling follows the surface's size (see `DETAIL_TIERS` in `stage.js`): 20 shells /
  8k strands below 240 px, 24 / 12k below 420 px, 32 / 16k above. Shell layer scale
  keeps the coat's full length, so this changes sampling density only — never the
  saved appearance, which is the same on the hero and in the preview. Density and
  the other fur controls still apply on top.
* Measured here (Electron 44, Intel UHD, D3D11; the packaged KAI2 and a browser
  harness were also running, so these are pessimistic):
  page ≈ 45 fps with the avatar paused; ≈ 39 fps with the hero at 168 px and its
  30 fps budget; the 543 px preview ≈ 14–16 fps at the default tier.
  Cost of the geometry, measured at the hero: 32 shells / 21k strands ≈ 17.6 fps;
  10k strands ≈ 27.6; 6k strands + 16 shells ≈ 41.6. `quality: "high"` is meant for
  a discrete GPU; on this machine it is not the default for that reason.

## Live checks (the running app)

`scripts/live-checks.mjs` drives a RUNNING packaged KAI2 over CDP and asserts the real
DOM and WebGL framebuffers (framing, splash/mark mirrors, state transitions, studio
preview/discard, no exceptions). It never saves a character and never sends a turn.

```sh
dist\win-unpacked\KAI2.exe --remote-debugging-port=9222
npm run test:live -- --port 9222
```

The window must be visible and not fully covered: Chromium throttles timers and rAF in
an occluded window, which the script now detects and reports instead of hanging. It
also has a `flush()` hook so mirror painting can be checked without rAF.

## Fallbacks

* No WebGL → the element mounts the existing 2D `<ghost-thinking>` and emits
  `kai-avatar-unavailable`; the studio shows `2D fallback` and still saves settings.
* WebGL context lost → the same fallback path.
* GPU fur requested but unavailable → the light pipeline runs and the studio says so.

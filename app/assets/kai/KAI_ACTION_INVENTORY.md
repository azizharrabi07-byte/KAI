# KAI — complete source action inventory

Source of truth: `app/assets/kai/KAI_matrix_orb_v17.html` (the original single-file
SVG + JS character; a verbatim copy also lives at `Downloads/KAI_matrix_orb_v17.html`).
Every line reference below (`L…`) points at that file.

This is the audited list of **every** pose, expression, movement, animation,
transition, skin, colour, theme, accessory, decoration and special/idle/interaction
action the source contains. Nothing here was invented; nothing in the source is
dropped from the list because the current state machine did not know about it.

The runtime implementation of this inventory lives in:

- `app/src/character/actions.ts` — the machine-readable registry (`KAI_ACTIONS`,
  `STATE_ACTIONS`, `stateActions`, `pickAction`).
- `app/src/character/orb.ts` — the Canvas-2D renderer (SC/ST/EY/THM/SKN/FITS/JD/PZ).
- `app/src/character/engine.ts` — the public `KaiEngine` API.

---

## 0. The data tables in the source

| Table | L | Contents |
|---|---|---|
| `EY` | 119 | 23 named eye expressions: `[ew, eL, eR, tilt, sep, gx, gy]` |
| `SC` | 124–155 | the timed step-sequences for every named pose: `[expr, ms, params?]`, `'>idle'` sentinel |
| `NM` | 389 | the 34 pose buttons (the full named-pose list) |
| `ST` | 103–118, 148, 154 | per-pose spring targets (`p`) + theme overrides (`v`) |
| `VN`/`K`/`AW`/`TH` | 100–101, 114 | base theme vectors (neutral / cool-blue / awake-bright / thinking) |
| `THM` | 362–372 | 11 named colour themes (aqua, wake, sky, mint, sun, rose, plan, help, progress, error, ultra) |
| `TMAP` | 361 | pose-z key → theme key |
| `SKN` | 391 | 3 skins (blue, black, yellow) |
| `FITS` + `HC`/`CC`/`ACC` | 285–317, 284 | 8 accessories (hair, cap, bat, phones, cat, crown, halo, none) + colour tables |
| `SK`/`VX`/`KEEP`/`PZ`/`NMZ` | 338–360 | the pose-z shard gallery (30 kept faces) |
| `JD` | 97 | jump/flip physics descriptors `[seconds, fullTurns, doubleTurns]` |

### Spring set (L94–97)
`S` holds 30 spring integrators (`Sp`: `x, v, t, k, d`), the animation backbone for
every scalar: `hl, hr, hv, en, tx, ty, rot, sq, gx, gy, ew, eL, eR, tilt, sep, bl,
wb, tn, m3, cv, dg, ro, pq, sx, sy, pa, yw, pt, lx, ly, ho`.

### Theme vector (L100)
`VN` = `{dp, ta, tc, bt, dm, et, eb, gl, hl, rg, sw, wk, ld, gt, wv, sl, sh, lp, mm,
gs, bk, th}` — the 22-channel colour/effect vector, interpolated each frame
(`VC += (TG-VC)*a`, L185–186) and applied to tint, brightness, dim, dots, eye
gradients, halo, rings, glitch, wind, shards, shell, laptop, meridian, glasses,
backpack, core.

---

## 1. Named poses (`NM`, L389) — 34

Each is an `SC` sequence of `EY` expressions with per-step spring params. Duration
= the step's ms (the source jitters it ±15–20 % via `0.85 + random()*0.4`, L157).
"→idle" = the SC ends with the `>idle` sentinel and returns to the idle loop.

| # | Pose | Visual meaning | SC (L) | Timing | Transition | Runtime state(s) | Skins / acc. |
|---|---|---|---|---|---|---|---|
| 1 | `idle` | resting: calm→relaxed→soft→attentive→curious loop | 124 | 3500/2500/2800/1400/1500/3000 ms, persistent | loops forever; `>idle` self | IDLE, LISTENING | all / all |
| 2 | `awake` | bright wake-up, head-back kick | 125 | 150 + 1100, then auto-idle at 1900 ms (L164) | auto→idle | LISTENING, IDLE | all / all |
| 3 | `listening` | attentive, receiving | 126 | 2600/1500/2000, persistent loop | loops | LISTENING | all / all |
| 4 | `thinking` | asym→intense→calm with the energy core | 127 | 1500/2200/1100 | loops | THINKING, PLANNING, WAITING | all / all |
| 5 | `working` | determined/sideglance + "Working" chip | 128 | 1100/900/700/1000 | loops | WORKING, DELEGATING, executing | all / all |
| 6 | `waiting` | calm→sideglance, glasses + backpack | 129 | 2400/1400/800/1300 | loops | WAITING | all / all |
| 7 | `success` | happy jump, green rings | 130 | 1700/700, `>idle`; ring fade at 2600 ms (L163) | →idle | SUCCESS, finished | all / all |
| 8 | `warning` | skeptical→asym, amber, shake | 131 | 1300/2000/1500 | loops | ratelimit, warning | all / all |
| 9 | `error` | small→sad, red glitch, tilt | 132 | 500 + hold; glitch cleared at 900 ms (L165) | holds | ERROR, error | all / all |
| 10 | `sleeping` | sleepy, dim, slow bob, zzz | 133 | persistent (0 ms) | persistent | OFFLINE, sleeping | all / all |
| 11 | `planning` | alias of `thinking` (L155) | =127 | as thinking | loops | PLANNING | all / all |
| 12 | `executing` | alias of `working` (L155) | =128 | as working | loops | executing, WORKING | all / all |
| 13 | `toolcall` | determined→sideglance (a tool runs) | 134 | 700/1300/900 | loops | USING_TOOL, toolcall, searching | all / all |
| 14 | `verifying` | skeptical→sideglance→skeptical | 135 | 1500/900/1200 | loops | verifying, USING_TOOL | all / all |
| 15 | `blocked` | blocked eyes, chin-down, stuck | 136 | persistent (0 ms) | persistent | blocked | all / all |
| 16 | `needsuser` | attentive double-prompt "asks for help" | 137 | 1200/700 | loops | WAITING_APPROVAL, approval, needsuser | all / all |
| 17 | `multiagent` | proc1→proc2 (delegating through workers) | 138 | 650/650 | loops | DELEGATING, multiagent | all / all |
| 18 | `confirmation` | attentive nod, ty −5/+4 | 139 | 500/500, `>idle` | →idle | question, confirmation | all / all |
| 19 | `done` | alias of `success` (L155) | =130 | as success | →idle | done, SUCCESS | all / all |
| 20 | `boot` | sleepy→line→sleepy→line→calm→surprised→calm→idle | 140 | 700/320/160/260/240/420/500, `>idle` | →idle | boot (startup) | all / all |
| 21 | `funny` | the source's random BN picker (L390) | 148 | 100 ms | — | funny | all / all |
| 22 | `jump` | crouch→leap (JD `[1.6,0,0]`) | 149 | 290/1000/310/0 | JD physics → idle at 1.6 s | jump | all / all |
| 23 | `backflip` | back somersault (JD `[2,1,0]`) | 150 | 360/1240/400/0 | JD → idle at 2 s | backflip | all / all |
| 24 | `frontflip` | forward somersault (alias of backflip, L151) | =150 | as backflip | JD → idle | frontflip | all / all |
| 25 | `spin` | 720° spin (JD `[2.8,0,1]`) | 152 | 500/1750/550/0 | JD → idle at 2.8 s | spin | all / all |
| 26 | `fight` | bobbing combat, orange theme | 153 | 1100/500/900/500 | loops | fight | all / all |
| 27 | `cross` | attentive eye-cross | 140 | 500/1800/700/1500/600, `>idle` | →idle | cross | all / all |
| 28 | `derp` | derpA→derpB wobble | 141 | 500/1800/1600/500, `>idle` | →idle | derp | all / all |
| 29 | `rolling` | 360° roll | 142 | 400/2300/500/400, `>idle` | →idle | dizzy, rolling | all / all |
| 30 | `doze` | doze→startle awake | 143 | 600/1800/900/350/500, `>idle` | →idle | doze, WAITING | all / all |
| 31 | `doubletake` | side-glance double-take | 144 | 500/420/300/650/500, `>idle` | →idle | doubletake | all / all |
| 32 | `idea` | intense→surprised→happy "eureka" | 145 | 900/700/900, `>idle` | →idle | idea, THINKING | all / all |
| 33 | `scan` | sideL/sideglance sweep | 146 | 280/280/240/240/900/500, `>idle` | →idle | searching, scan, USING_TOOL | all / all |
| 34 | `cool` | skeptical→determined, ty −4 | 147 | 900/1400/500, `>idle` | →idle | cool, WAITING | all / all |

`go(n)` (L162) also applies pose-specific impulses: `success` ty.v −300 → −200 @520 ms;
`awake` ty.v −170 + squash, auto-idle @1900 ms; `error` random tx kick + squash, glitch
clear @900 ms; `warning` squash; `sleeping` squash.

---

## 2. Expressions (`EY`, L119) — 23

`[ew, eL, eR, tilt, sep, gx, gy]` → eye width, left/right eye height, tilt, eye
separation, eye X/Y nudge. Applied by `Pz()` (L121).

| Expression | ew | eL | eR | tilt | sep | gx | gy | Visual meaning |
|---|---|---|---|---|---|---|---|---|
| `calm` | 1 | .82 | .82 | 0 | 1 | 0 | 0 | neutral resting |
| `relaxed` | 1 | .85 | .85 | 0 | 1 | 0 | 3 | settled, slightly down |
| `attentive` | .95 | 1.15 | 1.15 | 0 | 1 | 0 | −2 | tall, alert eyes |
| `soft` | 1.05 | .7 | .7 | 0 | 1 | 0 | 1 | gentle, half-lidded |
| `curious` | 1.05 | 1.08 | 1.08 | 0 | 1.05 | 0 | −4 | wider, slight up-look |
| `surprised` | 1.15 | 1.3 | 1.3 | 0 | 1.05 | 0 | −2 | big wide eyes |
| `small` | .7 | .6 | .6 | 0 | 1 | 0 | 0 | shrunk, sheepish |
| `sleepy` | 1.3 | .08 | .08 | 0 | 1 | 0 | 8 | near-closed, down |
| `line` | 1.5 | .06 | .06 | 0 | 1 | 0 | 0 | flat line (deadpan/boot) |
| `sideL` | 1 | .95 | .95 | 0 | 1 | −16 | 1 | look left |
| `derpA` | 1 | 1.35 | .55 | 6 | 1 | 0 | 0 | cross-eyed derp (L tall) |
| `derpB` | 1 | .55 | 1.35 | −6 | 1 | 0 | 0 | cross-eyed derp (R tall) |
| `skeptical` | 1 | .6 | .8 | 5 | 1 | 0 | 0 | one-eye squint |
| `determined` | 1 | .72 | .72 | 8 | .97 | 0 | −1 | angled, resolute |
| `intense` | .8 | .62 | .62 | 0 | .92 | 0 | −5 | narrowed, focused |
| `sideglance` | 1 | .95 | .95 | 0 | 1 | 16 | 1 | look right |
| `asym` | 1 | .58 | .95 | −4 | 1 | −8 | −6 | asymmetric, puzzled |
| `proc1` | .55 | 1.2 | .95 | 0 | 1.05 | 0 | 0 | processing, left bright |
| `proc2` | .55 | .95 | 1.2 | 0 | 1.05 | 0 | 0 | processing, right bright |
| `core` | .6 | .8 | .8 | 0 | .65 | 0 | 0 | core-focus (energy core) |
| `happy` | 1.12 | 1.12 | 1.12 | 0 | 1.05 | 0 | −2 | bright, up-look |
| `sad` | 1 | .6 | .6 | 6 | 1 | 0 | 8 | downcast |
| `blocked` | 1 | .65 | .65 | 3 | 1 | 0 | 9 | stuck, chin down |

Bare-expression entry points: `engine.triggerEmote(emote)` → `EMOTE_EXPR`
(`engine.ts`): love→happy, surprised→surprised, proud→determined, wink→sideglance,
yawn→sleepy, happy→happy, annoyed→skeptical.

---

## 3. Colour themes (`THM`, L362–372) — 11 (+4 base vectors)

Applied by `VT = VN ⊕ ST[pose].v` then interpolated into `VC` (L185). `tc` tint,
`et/eb` eye top/bottom, `gl` eye glow, `hl` halo, `dm` dim, plus effects
`rg` (success rings), `gt` (glitch), `wv` (wind/skin displacement), `lp` (laptop),
`mm` (meridian cage), `gs` (glasses), `bk` (backpack), `th` (energy core),
`dp` (dot opacity), `ta` (tint alpha).

| Theme | tc | ta | dm | Extra effect channels | Visual meaning |
|---|---|---|---|---|---|
| `aqua` | 60,200,255 | .4 | .08 | — | cool cyan |
| `wake` (=AW) | bright | — | — | bt .95, dp .1 | bright awake (dark eyes on bright) |
| `sky` | 70,150,255 | .5 | .08 | — | daylight blue |
| `mint` | 40,215,170 | .55 | .08 | — | green/ok |
| `sun` | 255,190,50 | .58 | .05 | — | warm amber |
| `rose` | 255,110,170 | .52 | .06 | — | pink |
| `plan` | 96,104,255 | .6 | .12 | mm .4 | indigo planning + meridians |
| `help` | 255,168,30 | .64 | .04 | — | orange help |
| `progress` | 40,215,110 | .64 | .05 | rg 1 | green progress + rings |
| `error` | 235,50,60 | .68 | .12 | gt 1, wv .3 | red error + glitch + wind |
| `ultra` | 160,80,255 | .64 | .05 | lp 1, rg 1, mm .3 | violet "ultrawork": laptop + rings + meridians |

Base vectors: `VN` neutral (L100), `K` cool-blue (L101), `AW` awake-bright (L101),
`TH` thinking (L114). Per-pose overrides in `ST` (L103–112) select these.
`TMAP` (L361) maps each pose-z key to a theme.

---

## 4. Skins (`SKN`, L391; `skin()`, L392–394) — 3

Recolour the body gradient (`#body`, `#shg`), deep wash (`#deep`, `#d3`), under-glow
(`#under`), the air-layer colour matrix, the theme eye/halo/glow channels, the rim
(`#ob` stroke), the 3-D rim gradient (`#r3`) and the dot pattern (`#dots`).

| Skin | Body stops | deep | under | air matrix | rim | r3 | dot |
|---|---|---|---|---|---|---|---|
| `blue` | #1B5FE0 #2E84F6 #5CB8FF #A4E4FF #E4F8FF | #0A3CB0 | #7FE0FF | .13 .45 1 | #D6F5FF | #8fe6ff | #CDEBFF |
| `black` | #020203 #0a0a0c #17171b #34343c #9a9aa6 | #000000 | #8a8a96 | .5 .5 .55 | #c8c8d0 | #b8b8c4 | #d8d8de |
| `yellow` | #E59B00 #FFC21A #FFDC5C #FFEFA0 #FFFBE0 | #9a5a00 | #FFF0A0 | .95 .6 .12 | #D6F5FF | #8fe6ff | #CDEBFF |

Black skin also overrides `hl`/`gl`/`eb` on `VN`/`K`/`AW` (L393).

---

## 5. Accessories (`FITS`, L285–317) — 8

3-D meshes (`dome`/`spike` builders, L281–283) projected with `PJ` (L218), flat-shaded
(L329–332) with light `LDIR=[-.45,.75,.55]`, split back/front by z (L334–336).
Cycling the same accessory bumps its variant `v` (L318).

| Accessory | Visual meaning | Build (L) | Variants |
|---|---|---|---|
| `none` | bare orb | 318 | — |
| `hair` | spiked hair dome + crown spike | 286–290 | 8 colour pairs `HC` |
| `cap` | baseball cap, dome + brim | 291–296 | 6 `CC` colours |
| `bat` | bat cowl with ears + emblem | 297–303 | fixed |
| `phones` | headphone band + ear discs | 304–309 | 5 `ACC` colours |
| `cat` | cat-ear spikes + pink inner ear | 310–311 | 8 `HC` |
| `crown` | gold band + 8 points + jewels | 312–314 | fixed |
| `halo` | tilted ring above the head, bobbing | 315–317 | 3 colours |

---

## 6. Movement / physics (`JD`, L97; frame L189–196)

| Movement | JD `[s, fullTurns, doubleTurns]` | Phases (L190–193) | Runtime trigger |
|---|---|---|---|
| `jump` | [1.6, 0, 0] | crouch (ju<.18) → ballistic arc (ju<.8, ty −105·4·ja(1−ja)) → land squash | dblclick (L265) / action |
| `backflip` | [2, 1, 0] | + 360° rotation, eased `ja²(3−2ja)` | action |
| `frontflip` | [2, −1, 0] | − 360° rotation | action |
| `spin` | [2.8, 0, 1] | + 720° rotation | action |
| `fight` | — | left/right hooks `JL/JR = max(0,±sin(4.2t))³`, bob, sway | action |

`FR` (frame rotation) is added to the body `rot` (L196). `working` adds a 4 Hz squash
ripple; `warning` adds 2 Hz tx shake + squash; `error` glitch jitters tx (L197–198).

---

## 7. Decorations / effects

| Effect | What it is | Source (L) | Driven by | Runtime state |
|---|---|---|---|---|
| Halo pulse | radial glow, 4.6 s opacity pulse | 11, 60 | always | all |
| Shadow | ellipse under the orb, scales with height | 58, 202 | ty, lx | all |
| Dot pattern | 6 px dotted texture on the body | 33, 41 | `VC.dp` | all |
| Meridian cage | 6 vertical + 5 horizontal ellipses (3-D grid) | 47, 220–222 | `VC.mm`/pointer | plan/ultra/pointer |
| Energy core | pulsing core with orbiting dots + pulse ring | 51, 231–237 | `VC.th`, `en`, `pu` | thinking/idea/working |
| Success rings | 2 expanding rings | 61–62, 240 | `VC.rg` | success/progress |
| Glitch bars | 5 red bars, random on a 12 Hz grid | 63, 241–242 | `VC.gt` | error |
| Specular | moving highlight ellipse + pinhole | 65, 223 | pointer | all |
| Eyelids | two arcs, opacity `VC.ld` | 68, 239 | `VC.ld` | all |
| Glasses | round glasses + brow lines | 71, 211 | `VC.gs` | waiting |
| Working chip | "Working" pill + 3 blinking dots | 73, 215 | pose | working/executing |
| Hands | two white hand circles, raised on success/awake | 74, 229–230 | `hl/hr/hv` springs | success/awake |
| Laptop | laptop with animated key-hands | 76–80, 211 | `VC.lp` | working/ultra |
| Backpack | floating backpack prop | 81–85, 211 | `VC.bk` | waiting |
| Air/wind layers | 5 feTurbulence layers + wind displacement | 34–38, 43–46, 224 | pointer, `VC.wv` | all / error |
| Shard/shell break-apart | orb sliced into 7 wedges that fly apart | 64–65, 266–273, 210–213 | `VC.sl`/`VC.sh` (dormant in source) | — (source never triggers) |
| Crack glow | red crack glow behind shards | 64, 210 | `VC.sl` | — |
| 3-D eye rig (`mode3`) | alternate projected eye ellipses on the sphere | 66, 226–228 | `mode3`, `pa/ho` springs | toggle (3D button) |
| Pose-z gallery | 30 alternate "faces" projected on the sphere | 338–360, 225 | `pzOn`, `TV` theme | pose gallery |

---

## 8. Idle / interaction / special actions

| Action | What it does | Source (L) | Timing |
|---|---|---|---|
| `blink` | fast lid close (bl 0.07 for 95 ms) | 170–171 | 2–5.5 s random loop; never while sleeping |
| `glance` | idle eye dart + micro tilt | 173–175 | every 1.8–5 s while idle |
| `perk` | idle startle: head kick + eye pop | 176 | every 9–16 s while idle |
| `eye jitter` | ±5/±3 px organic eye wander | 98 | every 1.1–2 s |
| `pointer gaze` | eyes + body follow the cursor | 177, 224 | on move |
| `hit` (slap) | 1 s shake + turbulence displacement + blink | 246–253 | on click |
| `drag` | yaw/pitch spin with inertia, snap to face | 254–264 | on drag |
| `dblclick` | triggers `jump` | 265 | on double-click |
| `funny` auto | random BN pose every 15 s | 390 | 15 s (removed in the port — see §10) |
| `boot` | startup sequence | 390 | on load |

---

## 9. What the source's own UI exposes

- Pose buttons = `NM` (34), L389.
- Accessory buttons = `ACN` (8), L386.
- Skin buttons = `SKN` (3), L394.
- 3-D toggle, L390.
- Pose-z gallery buttons = `PZ` keys with `NMZ` labels, L374; "Auto" cycles every
  2600 ms, L385.

---

## 10. Port status after this pass

Corrected record. An earlier revision of this table overstated four items as
"ported this pass" when their fields, setters and tables existed but nothing
actually *drew* them; and it listed the laptop/backpack as ported when the port's
`ST` reassignment block had silently dropped the `lp`/`bk` channels, so no state
change ever lit either prop. The table below records what the renderer really does.

| Source feature | Status in `orb.ts` |
|---|---|
| body + 5-stop gradients, dot pattern, deep/under/tint/bright/dim, highlight, rim | ported |
| EY table (23) | ported verbatim |
| SC sequences (all 34, durations kept) | ported verbatim |
| ST per-pose params + theme overrides | ported verbatim |
| THM (11) + VN/K/AW/TH + interpolation | ported verbatim |
| SKN (3) | ported |
| FITS (8) with 3-D projection + flat shading | ported |
| JD physics (jump/backflip/frontflip/spin) + fight | ported |
| success rings, glitch bars, meridians, working chip, glasses, specular, shadow, halo, core | ported |
| hands (`#hnd`) | ✓ ported — the `hl/hr/hv` springs the SC steps drive raise the two white hand circles |
| laptop (`#lap`) | ✓ **fixed this pass** — `working`/`executing` now light `VT.lp=1` in `go()` and `drawProps` reads `VC.lp`; before the fix the port's `ST` reassignment block dropped the channel and `drawProps` never read the `this.laptop` field, so it never rendered |
| backpack (`#bk`) | ✓ **fixed this pass** — same dropped-channel bug; `go()` now re-lights `VT.bk=1` for `waiting` and `drawProps` reads `VC.bk` |
| 3-D eye rig (`mode3`) | ✓ ported — `drawEyeMode3` renders the depth wash, cyan rim and projected eyes while `eyeMode3` is on |
| shard/shell break-apart + crack | ✓ ported — `drawCrack` / `drawShards` (7 wedges) / shell render from `VC.sl`/`VC.sh` |
| pose-z gallery (`PZ`, 30 faces) | ✓ ported — `drawGallery` projects the kept shard rows onto the sphere; `showGallery()` selects one |
| hit / slap turbulence (L246–253) | **PARTIAL** — the `S.yw`/`S.pt` springs exist and integrate, but no host gesture is bound to them, so the click-shake + turbulence displacement never fires |
| drag yaw/pitch spin (L254–264) | **PARTIAL** — same springs, no bound drag gesture; the island drives gaze through `lookX`/`lookY` instead of a drag spin |
| feTurbulence air/wind layers (#air1-5, #skin, #wsoft, L34–46) | **IMPOSSIBLE** in Canvas-2D — SVG filter graphs built from `feTurbulence` + `feDisplacementMap` fractal noise have no Canvas-2D primitive, and a per-frame per-pixel noise field would cost far more CPU than the WebView2 island allows. Documented in `PORT_NOTES`; deliberately not faked |
| 15 s random `funny` auto-trigger | **removed on purpose** — actions must be event-driven, never `animation = random()` |

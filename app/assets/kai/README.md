# KAI character assets

## Origin of the orb character

`KAI_matrix_orb_v17.html` is the **source of truth** for KAI's orb character. It
was supplied as a single-file SVG + JS character and copied here verbatim so the
character no longer exists only in `Downloads/`. The Canvas-2D port that ships in
the app lives in `app/src/character/orb.ts`; `engine.ts` is the public wrapper.

Do not edit `KAI_matrix_orb_v17.html` — it is the reference. If the orb is ever
re-ported, diff against this file.

## What was ported

`app/src/character/orb.ts` reproduces, verbatim where possible:

- the orb body and its five-stop radial gradients (`#body`, `#deep`, `#under`, `#hl`),
- the two-eye rig and the full **EY** expression table (23 named expressions),
- every pose in the **NM** list and its **SC** timed step-sequence (durations kept),
- the **ST** per-pose params/theme table and the spring-interpolated theme vector,
- the **THM** named themes and **TMAP**,
- the three **SKN** skins (blue / black / yellow),
- the eight **FITS** accessories (hair / cap / bat / phones / cat / crown / halo /
  none) with the source's 3-D mesh projection and flat shading,
- the boot sequence.

`PORT_NOTES` at the bottom of `orb.ts` lists what was deliberately omitted (SVG
turbulence/air filters, shard/shell 3-D break-apart, the 3-D eye mode, glitch
bars, the pose-z gallery, laptop/backpack/hands props, and the 15-second random
`funny` trigger) with the reason for each.

## Harness

`harness/` is a standalone browser harness used to verify the port — it is **not**
part of the app bundle.

- `harness/index.html` + `harness/demo.js` — grid of states, poses, accessories and
  skins driven by `app/src/character/demo.ts`.
- `harness/standalone.html` — the same, with the bundle inlined, plus a synchronous
  self-test that writes per-state/accessory/skin pixel signatures into `<pre id="out">`.
- `harness/shot.png` — a headless-Chromium screenshot of the settled grid.
- `harness/original.html` — a copy of the origin asset, for side-by-side viewing.

Rebuild after changing `demo.ts`:

```
cd app
npx esbuild src/character/demo.ts --bundle --format=iife --outfile=../assets/kai/harness/demo.js
python3 assets/kai/harness/build_standalone.py   # run from inside harness/
```

Verify headlessly (Chromium — the same engine WebView2 uses):

```
chrome --headless=new --disable-gpu --no-sandbox \
  --dump-dom "file:///…/assets/kai/harness/standalone.html" > dom.html
```

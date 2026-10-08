---
name: product-spin
description: Use when a product needs a seamless 360° turntable video — a slow rotating loop for a product page, reel, or hero background. Triggers on "spin", "turntable", "rotating product", "360 video", "spinning loop", or "make it rotate".
---

# Product Spin

## Purpose
Produce a clean, seamless turntable loop of one product: even rotation, locked framing,
crisp label, loopable start and end.

## When to use
- Product page gallery video, hero background loop, or reel B-roll.
- The product has a back or sides worth showing.
- Not for cinematic moves or environments (use `animate-product`); not for a still set of
  angles (use `product-360-shoot`).

## Inputs
- Product photo, three-quarter view preferred. Required.
- If the back matters: 2–3 extra reference angles (back, side). Strongly recommended.
- Duration 5 or 8 s; "full turn" or "half turn".
- Background: seamless colour, gradient, or studio; aspect ratio.

## Output
A **Spin Card**, then the generated clip if a generator is available.

Spin Card format:
1. `Model`: video, image-to-video, product photo as first frame.
2. `Prompt`, base text to edit per product: "Slow 360-degree orbit around the referenced
   product, [N] seconds, even rotation speed, product centred on a [surface] against
   [backdrop], soft front key plus rim light, shallow depth of field, label remains crisp
   and legible, subtle floor reflection, locked focal length, no zoom, no cuts, loops
   seamlessly."
3. `Fidelity clause`, verbatim: "Keep the product shape, logo, label, colour, packaging,
   material, and proportions exactly the same."
4. `Negative`: no camera shake, no environment change, no added objects or text.
5. `Settings`: duration, aspect ratio, reference frames attached.

Generation: `runway-api` video skill if installed; otherwise return the card and say so.

## Constraints
- Unseen sides are estimates; without back references the model invents the back — say
  this in the handoff when only one photo was supplied.
- Transparent or mirror-finish products smear; add "matte studio reflections" or offer a
  static hero instead.
- Always include "loops seamlessly" and "even rotation"; omit either and the clip stutters.
- Do not describe the product in words beyond its category; the reference frame carries the look.

## Examples
"Spin the new backpack, 8 s, teal background." → Card with 8 s, teal seamless,
three-quarter start; request a back photo; note that without it the rear pocket layout is a guess.

"Half-turn of the trophy for the awards page." → Card: 5 s, 180° arc, dark gradient
backdrop, matte reflections flagged because of the metallic finish.

---
name: product-explosion
description: Use when a product photo needs to become a hero "explosion" image — ingredients or parts frozen mid-burst around the product, or an exploded-view teardown with components hovering apart. Triggers on "explosion shot", "exploded view", "ingredients flying", "burst ad", "teardown render", or a request for a dramatic single-frame product hero.
---

# Product Explosion

## Purpose
Turn one clean product photo into a single dramatic hero frame where the product's
ingredients, contents, or components hang frozen mid-burst around it. Two flavours:
**burst** (ingredients, liquid, or particles flying outward — food, drink, skincare, sports
gear) and **teardown** (radial exploded view revealing real inner parts — hardware,
equipment, shoes).

## When to use
- A landing-page hero, paid-social key visual, or poster needs one high-impact product frame.
- The product's "what's inside" or "what it's made of" is the selling point.
- Not for motion (use `animate-product`); not for multi-angle sets (use `product-360-shoot`).

## Inputs
- Product photo: clean background, product fully visible, label readable. Required.
- Flavour: `burst` or `teardown`. If unstated, choose burst for consumables and
  teardown for hardware, and say which you chose.
- Burst: 3–6 named ingredients or elements to fly outward. Teardown: the real component
  list (5–12), never invented.
- Background colour or "match brand palette"; aspect ratio (default 1:1; 4:5 feed; 9:16 story).
- Optional: one tagline, up to three spec callouts (teardown only).

## Output
A **Prompt Card**, then the generated image if a generator is available.

Prompt Card format:
1. `Model`: image (still).
2. `Prompt`: one paragraph built in this order — scene surface and backdrop → product
   centred and exact → burst or teardown geometry ("radial arrangement from a central
   axis", "frozen mid-air", "outer shell hovering above core") → lighting (soft key plus
   rim) → lens ("100mm macro look, f/8") → finish ("ultra-realistic product photography").
3. `Fidelity clause`, always verbatim: "Keep the product shape, logo, label, colour,
   packaging, material, and proportions exactly the same. Do not add components or text
   that do not exist."
4. `Negative`: no extra typography, no watermark, no duplicated product, exactly one product.
5. `Settings`: aspect ratio, reference image attached.

Generation: if the `runway-api` plugin is installed, run the card through its image
skill with the product photo as reference. Otherwise return the card for pasting into
ChatGPT Images or another generator, and say so.

## Constraints
- Teardown: cap at 4 depth layers and 12 parts or the frame reads as clutter; state "radial
  arrangement from a central axis" or parts stack like a sandwich.
- Burst: name every flying element; unnamed "stuff" renders as mush.
- Never invent internal components. If the real internals are unknown, use burst.
- Keep copy out of the image unless the user supplies the exact words.
- Do not present the render as a real photograph of the real product.

## Examples
**Burst** — "Explosion shot of our electrolyte drink, teal brand background, 4:5."
→ Card: still; teal seamless backdrop; can centred and exact; lime wedges, salt crystals,
water droplets and mint leaves radiating outward frozen mid-air; soft key plus teal rim
light; 100mm macro look; fidelity clause; negatives; 4:5. → Generated via Runway.

**Teardown** — "Exploded view of the knee pad, white background."
→ Ask for the real layer list (outer sleeve, foam insert, gel cap, stitching) if unknown;
card states 4 layers radial, "do not add components that do not exist", 1:1.

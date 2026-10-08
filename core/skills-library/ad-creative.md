---
name: ad-creative
description: Use when a product or offer needs a polished paid-social or display key visual — hero composition, brand palette, optional headline and CTA — in platform sizes. Triggers on "ad creative", "static ad", "key visual", "Meta or Instagram ad image", "banner", "hero image for the campaign".
---

# Ad Creative

## Purpose
Produce one deliberate key visual for a campaign: scene, product, action, camera, and
atmosphere chosen on purpose, palette limited to brand colours, copy either exact or
absent, delivered in the sizes the channel needs.

## When to use
- Paid social, display, email hero, or landing-page banner imagery.
- Several sizes of one concept are needed.
- Not for creator-style authenticity (`ugc-ad`) or editorial covers (`magazine-cover`).

## Inputs
- Product or offer photo, or a description. Required.
- Brand palette (2 colours plus 1 accent) and typeface, if copy will be added later.
- Exact headline and CTA text, or "no copy" (default: no copy inside the image).
- Platform sizes: 1:1 feed, 4:5 feed, 9:16 story or reel, 16:9 web. Default 1:1 plus 9:16.
- Audience and mood in one line (e.g. "parents of youth athletes, energetic, trustworthy").

## Output
A **Creative Card** per concept, then the images if a generator is available.

Creative Card format:
1. `Concept`: one sentence — the single idea the frame communicates.
2. `Prompt` in five layers: `Scene` (surface first, then backdrop) → `Subject` (product
   exact, centred or rule-of-thirds) → `Action` (what is happening around it) → `Camera`
   (lens and angle, e.g. "90mm, slight low angle") → `Atmosphere` (light direction,
   softbox position, mood).
3. `Palette`: product colour plus background colour plus one accent, nothing else.
4. `Copy`: exact text and safe-zone placement, or "none — typography added in Canva".
5. `Fidelity clause`, verbatim: "Keep the product shape, logo, label, colour, packaging,
   material, and proportions exactly the same. No text on the label, no AI-generated typography."
6. `Sizes`: one prompt variant per aspect ratio with composition notes (leave headroom for copy).

Generation: `runway-api` image skill if installed; otherwise return the card and say so.
Typography goes on afterwards in a design tool (Canva connector if available), never in
the generator.

## Constraints
- Lock format and composition before generating; "make a nice ad" is not a brief — ask
  for audience, mood, and size.
- Limit the palette; unbounded palettes oversaturate.
- Never let the generator render headlines or CTAs; it misspells and invents.
- Keep 15–20% clear space where copy will sit.
- Check the final against `impeccable-ui` or `visual-direction-review` before shipping.

## Examples
"Meta ad for fall tryouts, teal and black, 1:1 and 9:16, headline 'Tryouts Sept 13'."
→ Card: concept "the gym floor before the whistle"; scene polished court with a teal
backdrop wash; subject volleyball exact, low angle; action chalk dust drifting; camera
90mm; atmosphere side softbox; palette teal, black, white accent; copy set in Canva; two sizes.

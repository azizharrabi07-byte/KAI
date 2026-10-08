---
name: animate-product
description: Use when a still product photo should become a short product video (5–10 s) — a reveal, a hero camera move, light sweeping across the surface, or a 2–3 shot mini-ad. Triggers on "animate this product", "make the photo move", "product video from image", "image to video ad", or "Sora/Runway product clip".
---

# Animate Product

## Purpose
Turn one hero product photo into a short, coherent product video by directing motion
only — camera, light, and environment move; the product itself stays pixel-faithful.

## When to use
- A landing hero, story ad, or reel needs motion but only a still exists.
- A single-take reveal or a 2–3 shot mini-ad is wanted.
- Not for a clean turntable (use `product-spin`) or a still hero (use `product-explosion` or `ad-creative`).

## Inputs
- Hero product photo, clean and well lit. Required.
- One-line selling point (drives the motion idea).
- Length: 5, 8, or 10 s per shot; number of shots (default 1, max 3).
- Aspect ratio: 9:16 story, 1:1 feed, 16:9 web.
- Constraints such as "no faces", "no text", "silent".

## Output
A **Shot Card** per shot, then the generated clip(s) if a generator is available.

Shot Card format:
1. `Model`: video, image-to-video, with the hero photo as the first frame.
2. `Scene`: environment and surface in one clause.
3. `Camera`: exactly one motivated move (slow push-in, drift, orbit, tilt, rack focus).
4. `Action`: what moves around the product (light sweep, mist, particles, water, fabric).
5. `Physics micro-directives`, two of them: e.g. "condensation beads slide slowly",
   "dust motes drift in backlight".
6. `Continuity anchor`: "product remains centred, same scale and label orientation as the reference".
7. `Fidelity clause`, verbatim: "Keep the product shape, logo, label, colour, packaging,
   material, and proportions exactly the same."
8. `Guardrails`: no cuts, no zoom bursts, no added text, no hands unless asked.
9. `Settings`: duration, aspect ratio.

Generation: if the `runway-api` plugin is installed, run each card through its video
skill with the photo as the input frame. Otherwise return the cards for Sora or another
image-to-video tool, and say so.

## Constraints
- Describe motion, never re-describe the product; text re-description drifts the label and palette.
- One camera move per shot; combined pans, orbits, and zooms warp labels.
- Keep single takes under 10 s; coherence degrades beyond that.
- Multi-shot: repeat the same fidelity clause and continuity anchor in every card.
- Generated footage must not be presented as real-world footage of the product.

## Examples
"Animate the jersey photo for a 9:16 story, 8 seconds, premium feel."
→ Shot Card: video i2v; matte charcoal studio; slow push-in; a single band of warm light
sweeps left to right across the fabric; micro: "fabric weave catches highlight", "faint
studio haze"; anchor; fidelity clause; guardrails: no text, no hands; 8 s, 9:16.

"Three-shot mini ad for the water bottle." → Three cards: (1) reveal from shadow,
(2) condensation close-up drift, (3) pull-back to hero on brand colour — same anchor and
fidelity clause on each.

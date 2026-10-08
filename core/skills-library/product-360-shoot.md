---
name: product-360-shoot
description: Use when one product photo must become a full multi-angle still set — front, back, sides, top, three-quarter, and detail shots under consistent lighting — for a product page gallery, marketplace listing, or catalogue. Triggers on "360 shoot", "all angles", "multi-angle set", "product gallery images", "listing photos".
---

# Product 360 Shoot

## Purpose
Generate a consistent set of product stills from a single source photo: fixed lighting,
fixed scale, fixed backdrop, evenly spaced angles plus macro details — a virtual studio shoot.

## When to use
- Listing galleries (marketplace, Shopify, club store), catalogue pages, spec sheets.
- Stills are wanted rather than a spin video.
- Not for a video loop (`product-spin`) or one hero frame (`ad-creative`).

## Inputs
- Source photo: three-quarter view, whole product visible, simple background. Required.
- Optional extra references (back, underside) — improves hidden-side accuracy.
- Set size: `standard` (8 frames: front, back, left, right, top, 3/4 front-left,
  3/4 back-right, one macro detail) or `full` (12 frames at 30° plus 2 macros).
- Backdrop (default pure white, marketplace-safe); aspect ratio (default 1:1).
- Detail to feature in macro shots (stitching, logo, texture, closure).

## Output
A **Set Card**, then the frames if a generator is available.

Set Card format:
1. `Model`: image, reference edit, one call per angle, all in the same session.
2. `Shared block`, repeated verbatim in every angle prompt: backdrop, surface, lighting
   ("two softboxes at 45° left and right, gentle top fill"), lens ("85mm product lens"),
   scale ("product fills 70% of frame, centred"), and the fidelity clause "Keep the product
   shape, logo, label, colour, packaging, material, and proportions exactly the same."
3. `Angle list`: one line per frame — angle name, degrees, what must be visible.
4. `Negative`: no props, no text, no shadow changes between frames, no colour shift.
5. `Manifest`: file names `product_<angle>.png`, hidden-side frames marked "estimated",
   plus a contact-sheet preview.

Generation: `runway-api` image skill per angle, same reference each call. Otherwise return
the card and say so.

## Constraints
- Generate all angles against the same source image in one sitting; separate sessions drift.
- Hidden surfaces are reconstructions: mark them "estimated" and never use them for
  technical or compliance purposes.
- Small text and logos degrade on non-reference angles; re-run any frame with an
  unreadable label rather than accepting it.
- Marketplace main image: pure white background, product only, no text — keep frame one compliant.

## Examples
"360 shoot of the team hoodie for the store, standard set." → Set Card: white backdrop,
8 angles, macro on the chest logo, manifest; frames generated; back frame marked
"estimated" because only a front photo was supplied.

"Full 12-angle set of the ball on black." → 12 frames at 30°, two macros (seams, valve),
black seamless, colour-shift negative emphasised.

---
name: ugc-ad
description: Use when marketing content should look like an ordinary person shot it on a phone — mirror selfie with the product, kitchen-counter demo, unboxing, testimonial frame, or a short vertical clip — rather than polished studio work. Triggers on "UGC", "creator-style", "make it look real, not an ad", "phone-shot", "testimonial video", "authentic".
---

# UGC Ad

## Purpose
Produce user-generated-content-style stills and short vertical clips: believable setting,
imperfect framing, natural light, real-looking hands and skin, product clearly legible —
deliberately not polished.

## When to use
- Paid social that must not read as an ad; creator-style proof; before and after; unboxing.
- A still first, optionally animated into a 5–8 s vertical clip.
- Not for premium hero visuals (`ad-creative`).

## Inputs
- 1–3 product photos. Required.
- Creator description (adult, age range, vibe) or "faceless, hands only".
- Setting (bathroom mirror, kitchen counter, car, gym bag on a bench) and time of day.
- Mood word: honest, cozy, funny, chaotic, hyped.
- Format: 9:16 (default) or 4:5. Still only, or still plus clip.

## Output
A **UGC Card**, then the still (and clip) if a generator is available.

UGC Card format:
1. `Model`: image, reference edit; optional second step image-to-video.
2. `Prompt`, base text to adapt: "Photorealistic 9:16 vertical UGC-style image that looks
   like an authentic phone photo. Scene: [setting], natural window light from one side.
   Subject: [creator] holding [product] close to the camera, product label readable.
   Mood: [mood]. Slight motion blur, slightly askew smartphone angle, lived-in background
   details, everyday clothes, real hand texture, no smoothed AI skin, no studio lighting."
3. `Fidelity clause`: "Keep the product shape, logo, label, colour, packaging, material,
   and proportions exactly the same."
4. `Negative`: no watermark, no on-image text or captions, no professional lighting; and
   the prompt itself contains no words like flawless, luxury, premium, cinematic.
5. `Clip step`, if requested: "Turn the still into a realistic lifestyle clip, handheld
   micro-shake, creator tilts the product toward the camera, 6 s, product preserved exactly."

Generation: `runway-api` image (then video) skills if installed; otherwise return the card
and say so.

## Constraints
- Polished vocabulary kills the look; strip adjectives like "stunning" and "cinematic".
- The product must stay legible; if the label blurs, regenerate with "label in focus".
- Disclose synthetic creators where platform rules require it; never imply a real customer
  said something they did not.
- Generated creators are adults only.

## Examples
"UGC still of someone holding the recovery drink after practice, honest mood, 9:16."
→ Card: gym bag on a bench, late-afternoon side light, hands-only creator, label readable,
negatives, fidelity clause; still generated; clip step offered.

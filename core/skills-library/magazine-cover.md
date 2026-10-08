---
name: magazine-cover
description: Use when a person, team, or product should be presented as a magazine cover — masthead, headline, cover lines, barcode, 2:3 portrait — for social posts, player spotlights, sponsor decks, or award graphics. Triggers on "magazine cover", "put them on a cover", "cover story graphic", "issue cover".
---

# Magazine Cover

## Purpose
Compose a convincing fictional magazine cover around a supplied subject photo: face or
product preserved exactly, invented masthead, supplied headline and cover lines, standard
cover furniture.

## When to use
- Player or coach spotlight, season recap, sponsor pitch, award announcement.
- A product launch teased as a "cover story".
- Not for real publication layout work; the output is a single flat image.

## Inputs
- Subject photo (person or product). Required. For a person, confirm permission to use
  their likeness; for a minor, a guardian's consent.
- Fictional masthead (magazine title). Never a real title.
- One headline, two or three cover lines, an issue tag (month and year, or "The Season Issue").
- Palette and mood; aspect ratio 2:3 (default) or 4:5.

## Output
A **Cover Card**, then the image if a generator is available.

Cover Card format:
1. `Model`: image, reference edit with the subject photo.
2. `Prompt`: "Place the person/product in the referenced photo on a [genre] magazine cover
   titled [MASTHEAD], face/product kept exact, [pose or framing], [lighting], masthead
   across the top partially behind the subject's head, headline '[HEADLINE]' in the lower
   third, cover lines '[LINE 1]' and '[LINE 2]' in the left column, issue tag top-right,
   barcode bottom-right, 2:3 portrait, printed-cover paper texture."
3. `Copy manifest`: every line of text, verbatim, as a list — the generator renders only these.
4. `Fidelity clause`: "Keep the face/product exactly as in the reference; no changes to
   features, skin, logo, or proportions."
5. `Negative`: no real magazine titles or logos, no extra text, no watermark.

Generation: `runway-api` image skill if installed; otherwise return the card and say so.
If text renders wrong, regenerate once, then finish the copy in Canva.

## Constraints
- Fictional masthead only; real titles risk refusal and trademark trouble.
- Every word must be in the copy manifest, or the model invents cover lines.
- The output is a flat image, not a print-ready layout file.
- Youth teams: no cover of a minor without guardian consent on record.
- Proof-read the render before posting; text errors are common.

## Examples
"Put our setter on a cover for the season recap, teal and white." → Masthead "COURTSIDE",
headline "The Season Issue", lines "12 wins, one team" and "Inside the huddle", issue tag
"Fall 2026"; copy manifest listed; consent confirmed; 2:3.

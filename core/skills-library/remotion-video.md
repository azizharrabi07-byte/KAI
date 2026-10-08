---
name: remotion-video
description: Build programmatic video in React with Remotion â€” compositions, animation, audio, captions, and rendering. Use this skill for any Remotion code: product demos, animated explainers, social cuts, data-driven video.
---

# Remotion Video Skill

## Purpose
Build programmatic video in React with Remotion â€” compositions, animation, audio, captions, and rendering.

## When to use
Use this skill for any Remotion code: product demos, animated explainers, social cuts, data-driven video. Use `framer-motion-interactions.md` for animation inside a running app rather than a rendered file.

## Inputs
- composition intent and duration
- target fps, dimensions, and output format
- assets: media, fonts, data feeding the animation
- whether audio, captions, or 3D are involved

## Output
Return:
- a composition plan: scenes with frame ranges and transitions
- the Remotion components, driven by `useCurrentFrame`
- timing values derived from fps rather than hardcoded frame numbers
- the commands to preview and render

## Constraints
- scaffold a new project with `npx create-video@latest --yes --blank my-video`; preview with `npx remotion studio`
- sanity-check layout with a single frame when useful: `npx remotion still <composition-id> --scale=0.25 --frame=30` (frames are zero-based, so at 30fps that is the one-second mark); skip it for trivial edits
- everything derives from `useCurrentFrame()`; never animate from wall-clock time, `setState`, or CSS transitions
- express durations in seconds converted through fps so the composition survives an fps change
- `interpolate` needs explicit `extrapolateLeft` and `extrapolateRight`; unclamped ranges are a common defect
- use `spring()` for physical motion and easing curves for choreographed motion
- wrap timed segments in `<Sequence>` rather than doing manual frame arithmetic
- load fonts and media through Remotion's own loaders; unloaded assets render as blank frames
- keep every frame deterministic and side-effect free â€” the renderer evaluates frames out of order
- use `calculateMetadata` to set duration and dimensions dynamically from input props rather than hardcoding
- reach for FFmpeg for trimming and silence detection; use React Three Fiber for 3D inside a composition

## Examples
- Build a 30-second explainer with scene transitions and a soundtrack
- Generate a data-driven chart animation whose duration follows the input series
- Add captions and an audio-reactive visualiser to an existing composition

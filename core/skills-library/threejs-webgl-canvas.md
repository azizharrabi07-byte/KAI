---
name: threejs-webgl-canvas
description: Build performant 3D scenes, particle systems, shader effects, and interactive canvas backgrounds for the web. Use this skill for GPU-rendered visuals: hero backgrounds, product viewers, data visualisation in 3D, or generative canvas work.
---

# Three.js and WebGL Canvas Skill

## Purpose
Build performant 3D scenes, particle systems, shader effects, and interactive canvas backgrounds for the web.

## When to use
Use this skill for GPU-rendered visuals: hero backgrounds, product viewers, data visualisation in 3D, or generative canvas work. Use `framer-motion-interactions.md` for DOM animation.

## Inputs
- visual intent and reference material
- whether the scene is ambient, interactive, or a full viewer
- performance budget and minimum target device
- assets: models, textures, HDRIs

## Output
Return:
- a scene plan: geometry, materials, lighting, camera, and render loop strategy
- the implementation, in raw Three.js or react-three-fiber to match the project
- shader code where custom materials are needed, with uniforms documented
- a teardown path and a performance note (draw calls, triangle count, texture memory)

## Constraints
- always dispose geometries, materials, textures, and the renderer on unmount â€” this is the most common leak
- pause the render loop when the canvas is offscreen or the tab is hidden
- cap `devicePixelRatio` at 2; uncapped DPR is the usual cause of poor performance on high-density displays
- instance repeated geometry; merge static meshes; keep draw calls low rather than optimising shaders first
- prefer cheap fakes â€” baked lighting, matcaps, fresnel rims â€” over real-time shadows and physical lights
- compress textures and models; state the transferred byte cost
- provide a static fallback for machines without WebGL and for `prefers-reduced-motion`
- canvas content is invisible to assistive technology â€” never put essential information there alone

## Examples
- Build an ambient particle background that idles under 2ms per frame
- Create an interactive 3D product viewer with orbit controls
- Write a custom shader for a gradient mesh hero

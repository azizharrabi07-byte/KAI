// kai-character-entry.ts — the ONE file KAI2's build takes from the KAI app.
//
// KAI's real character engine lives in the KAI (Tauri) app at
// `C:\tmp\kai-exec\app\src\character\` and is TypeScript ESM. KAI2 is Electron with
// no bundler — ~70 plain <script> tags — so the engine is folded into ONE IIFE,
// `kai-character-engine.js` (next to KAI2's own scripts), by esbuild. Nothing in
// `app/src/character/` is touched: this entry only re-exports.
//
// Rebuild (esbuild comes with the KAI app's own vite dependency):
//
//   cd C:\tmp\kai-exec\app
//   node node_modules/esbuild/bin/esbuild \
//     C:/Users/DELL/source/kai2-desktop/scripts/kai-character-entry.ts \
//     --bundle --format=iife --global-name=KaiCharacter --target=chrome120 \
//     --outfile=C:/tmp/kai-character-engine.js
//
// then put the provenance header (see the top of kai-character-engine.js) in front
// of it and move it into KAI2. The only consumer is `ghost-thinking.js`.

export * from "C:/tmp/kai-exec/app/src/character/engine";
export * from "C:/tmp/kai-exec/app/src/character/canvas-view";
// Exported so KAI2 can switch the engine's synthesised soundtrack off: KAI2 has no
// sound design of its own, and the engine only makes noise if Sound.preload() ran.
export { Sound } from "C:/tmp/kai-exec/app/src/core/sound";
export type { AccessoryName, SkinName } from "C:/tmp/kai-exec/app/src/character/orb";
export type { KaiStateName } from "C:/tmp/kai-exec/app/src/character/types";

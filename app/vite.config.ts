import { defineConfig } from "vite";
import { resolve } from "node:path";

// KAI has no shared asset folder to mount: the character is drawn with Canvas 2D
// and every sound is synthesised at runtime, so nothing is served from disk and
// nothing has to be copied into the bundle. This config is therefore just the two
// entry points plus the Tauri dev-server contract.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        island: resolve(__dirname, "index.html"),
        shell: resolve(__dirname, "shell.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
});

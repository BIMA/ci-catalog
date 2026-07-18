import { defineConfig } from "vite";

// base './' makes built asset + manifest.json paths relative, so the generated
// catalog works when served from any subdirectory (npx serve pipeline-docs).
export default defineConfig({
  base: "./",
});

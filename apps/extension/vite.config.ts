import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Background (type: module) and side panel (script type=module) can share ES chunks. */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        sidepanel: resolve(__dirname, "src/sidepanel.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]"
      }
    }
  }
});

import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Content scripts cannot use ES modules — build as a single IIFE. */
export default defineConfig({
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, "src/content.ts"),
      name: "TweetHelperContent",
      formats: ["iife"],
      fileName: () => "content.js"
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: "[name].[ext]"
      }
    }
  }
});

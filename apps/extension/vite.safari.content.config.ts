import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Build the shared X content script as a classic script for iPhone Safari. */
export default defineConfig({
  publicDir: "public-safari",
  build: {
    outDir: "../ios/TweetHelperMobile/TweetHelperSafari/Resources",
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, "src/content.ts"),
      name: "TweetHelperContent",
      formats: ["iife"],
      fileName: () => "content.js"
    },
    rollupOptions: {
      output: { inlineDynamicImports: true, assetFileNames: "[name].[ext]" }
    }
  }
});

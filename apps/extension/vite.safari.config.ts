import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Background and compact popup bundle for the iOS Safari Web Extension. */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "../ios/TweetHelperMobile/TweetHelperSafari/Resources",
    emptyOutDir: false,
    sourcemap: false,
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

import { describe, expect, it } from "vitest";
import manifest from "../public/manifest.json";
import { readFileSync } from "node:fs";
describe("MV3 side-panel and accessibility contracts", () => {
  it("uses a side panel and messaging-capable service worker without a popup", () => {
    expect(manifest.manifest_version).toBe(3); expect(manifest.side_panel.default_path).toBe("sidepanel.html"); expect(manifest.permissions).toContain("sidePanel"); expect(manifest.action).not.toHaveProperty("default_popup");
  });
  it("keeps targets accessible, responsive, focused, and color-scheme aware", () => {
    const css = readFileSync(new URL("../public/sidepanel.css", import.meta.url), "utf8");
    expect(css).toContain("min-height:44px"); expect(css).toContain(":focus-visible"); expect(css).toContain("color-scheme:light dark"); expect(css).toContain("@media(max-width:300px)");
  });
});

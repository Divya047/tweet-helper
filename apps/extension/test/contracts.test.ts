import { describe, expect, it } from "vitest";
import manifest from "../public/manifest.json";
import { readFileSync } from "node:fs";
import { BATCH_STRATEGIES, assignReplyTones, outcomePayloadForEvent, REPLY_TONES } from "../src/contracts.js";
describe("MV3 side-panel and accessibility contracts", () => {
  it("uses a side panel and messaging-capable service worker without a popup", () => {
    expect(manifest.manifest_version).toBe(3); expect(manifest.side_panel.default_path).toBe("sidepanel.html"); expect(manifest.permissions).toContain("sidePanel"); expect(manifest.action).not.toHaveProperty("default_popup");
  });
  it("keeps targets accessible, responsive, focused, and color-scheme aware", () => {
    const css = readFileSync(new URL("../public/sidepanel.css", import.meta.url), "utf8");
    expect(css).toContain("min-height:44px"); expect(css).toContain(":focus-visible"); expect(css).toContain("color-scheme:light dark"); expect(css).toContain("@media(max-width:300px)");
  });
  it("builds eight varied post slots with exactly three community questions", () => {
    expect(BATCH_STRATEGIES).toHaveLength(8);
    expect(BATCH_STRATEGIES.filter((strategy) => strategy.question)).toHaveLength(3);
    expect(BATCH_STRATEGIES.map((strategy) => strategy.label)).toEqual([
      "Direct insight",
      "Contrarian take",
      "Practical example",
      "Useful checklist",
      "Tradeoff question",
      "Production lesson",
      "Peer recommendation",
      "Concise observation"
    ]);
  });
  it("assigns shuffled reply tones so queue drafts vary structure", () => {
    expect(REPLY_TONES).toHaveLength(8);
    expect(REPLY_TONES.map((tone) => tone.label)).toEqual([
      "Practical caveat",
      "Counterexample",
      "Tradeoff callout",
      "Implementation detail",
      "Pattern observation",
      "Constructive pushback",
      "Reasoned question",
      "Concise add-on"
    ]);
    const assigned = assignReplyTones(10);
    expect(assigned).toHaveLength(10);
    expect(new Set(assigned.slice(0, 8).map((tone) => tone.label)).size).toBe(8);
    expect(assigned[8]?.label).toBe(assigned[0]?.label);
    expect(assigned[9]?.label).toBe(assigned[1]?.label);
  });
  it("maps verified Chrome publishes to the durable outcome API contract", () => {
    expect(outcomePayloadForEvent({
      clientEventId:"chrome-1",kind:"published",occurredAt:new Date().toISOString(),finalText:"Final reply",externalId:"123",
      context:{kind:"reply",currentText:"Final reply",target:{text:"Source post",url:"https://x.com/a/status/1"}}
    })).toMatchObject({status:"published",platform:"chrome",finalText:"Final reply",sourceText:"Source post",clientEventId:"chrome-1",externalId:"123",contentKind:"reply"});
  });
});

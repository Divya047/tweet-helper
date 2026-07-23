import { describe, expect, it } from "vitest";
import manifest from "../public/manifest.json";
import { readFileSync } from "node:fs";
import {
  FIND_HIGH_INTENT,
  TREND_SCAN,
  assignReplyTones,
  buildSingleTrendBrief,
  deriveFeedTrends,
  mapNativeExplore,
  outcomePayloadForEvent,
  REPLY_TONES,
  samplePostsForScoring,
  sourcePostUrl
} from "../src/contracts.js";
describe("MV3 side-panel and accessibility contracts", () => {
  it("uses a side panel and messaging-capable service worker without a popup", () => {
    expect(manifest.manifest_version).toBe(3); expect(manifest.side_panel.default_path).toBe("sidepanel.html"); expect(manifest.permissions).toContain("sidePanel"); expect(manifest.action).not.toHaveProperty("default_popup");
  });
  it("keeps targets accessible, responsive, focused, and color-scheme aware", () => {
    const css = readFileSync(new URL("../public/sidepanel.css", import.meta.url), "utf8");
    expect(css).toContain("min-height:44px"); expect(css).toContain(":focus-visible"); expect(css).toContain("color-scheme:light dark"); expect(css).toContain("@media(max-width:300px)");
    expect(css).toContain(".section-title"); expect(css).toContain(".explore-actions");
    expect(css).toContain(".trend-chip"); expect(css).toContain(".trend-list");
  });
  it("maps native 1+4 generate/post responses into Explore cards", () => {
    const cards = mapNativeExplore({
      recommendation: { id: "r1", text: "Strongest take." },
      explore: [
        { id: "e1", text: "Specific angle." },
        { id: "e2", text: "Tension angle." },
        { id: "e3", text: "Question angle." },
        { id: "e4", text: "Concise angle." }
      ],
      suggestions: [{ id: "r1", text: "Strongest take." }],
      strategies: [
        { label: "Recommended" },
        { label: "Specific" },
        { label: "Constructive tension" },
        { label: "Experience question" },
        { label: "Concise practical" }
      ]
    });
    expect(cards).toHaveLength(5);
    expect(cards[0]).toMatchObject({ id: "r1", recommended: true, strategy: "Recommended" });
    expect(cards.slice(1).every((card) => !card.recommended)).toBe(true);
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
  it("resolves a navigable source post URL from url or numeric id", () => {
    expect(sourcePostUrl({ text: "hi", url: "https://x.com/a/status/99" })).toBe("https://x.com/a/status/99");
    expect(sourcePostUrl({ id: "123456789", text: "hi" })).toBe("https://x.com/i/status/123456789");
    expect(sourcePostUrl({ id: "visible-0", text: "hi" })).toBeUndefined();
  });
  it("targets eight high-intent replies from a capped feed collect", () => {
    expect(FIND_HIGH_INTENT.targetReplies).toBe(8);
    expect(FIND_HIGH_INTENT.maxCandidates).toBe(12);
    expect(FIND_HIGH_INTENT.minScore).toBe(70);
  });
  it("defines a long trend scan budget and clusters scored topic summaries", () => {
    expect(TREND_SCAN.maxDurationMs).toBeGreaterThanOrEqual(120_000);
    expect(TREND_SCAN.maxCandidates).toBeGreaterThan(FIND_HIGH_INTENT.maxCandidates);
    expect(TREND_SCAN.scoreSampleSize).toBeLessThanOrEqual(16);
    expect(samplePostsForScoring(["a", "b", "c", "d", "e"], 3)).toEqual(["a", "c", "e"]);
    const trends = deriveFeedTrends([
      { topicSummary: "AI coding agents in production", suggestedAngle: "ops caveat", score: 80 },
      { topicSummary: "AI coding agents for shipping", suggestedAngle: "shipping lesson", score: 72 },
      { topicSummary: "Pricing experiments for B2B", suggestedAngle: "price test", score: 88 },
      { topicSummary: "Pricing experiments that flopped", suggestedAngle: "postmortem", score: 70 },
      { topicSummary: "Pricing experiments worth repeating", score: 65 }
    ], 2);
    expect(trends).toHaveLength(2);
    expect(trends[0]?.count).toBe(3);
    expect(trends[0]?.label.toLowerCase()).toContain("pricing");
    expect(trends[1]?.count).toBe(2);
    const brief = buildSingleTrendBrief(trends[0]!, "founders");
    expect(brief).toContain("Join this circulating conversation among founders");
    expect(brief).toContain(trends[0]!.label);
    expect(brief).toContain("this single theme only");
    expect(brief).not.toContain(trends[1]!.label);
  });
});

import { describe, expect, it } from "vitest";
import manifest from "../public/manifest.json";
import safariManifest from "../public-safari/manifest.json";
import { readFileSync } from "node:fs";
import {
  FIND_HIGH_INTENT,
  TREND_SCAN,
  adaptiveOpportunityMix,
  assignReplyStyles,
  buildReplyDraftInstructions,
  buildTasteAwareReplyInstructions,
  buildSingleTrendBrief,
  deriveFeedTrends,
  emptyOpportunityLaneStats,
  mapNativeExplore,
  outcomePayloadForEvent,
  feedbackPayloadForEvent,
  REPLY_TONES,
  REPLY_VOICES,
  samplePostsForScoring,
  selectOpportunityMix,
  sourcePostUrl,
  updateQueuedDraft
} from "../src/contracts.js";
describe("MV3 side-panel and accessibility contracts", () => {
  it("uses a side panel and messaging-capable service worker without a popup", () => {
    expect(manifest.manifest_version).toBe(3); expect(manifest.side_panel.default_path).toBe("sidepanel.html"); expect(manifest.permissions).toContain("sidePanel"); expect(manifest.action).not.toHaveProperty("default_popup");
  });
  it("packages a compact, least-privilege iPhone Safari popup", () => {
    expect(safariManifest.manifest_version).toBe(3);
    expect(safariManifest.permissions).toContain("nativeMessaging");
    expect(safariManifest.action.default_popup).toBe("mobile.html");
    expect(safariManifest.host_permissions).toEqual([
      "https://x.com/*",
      "https://twitter.com/*",
      "https://divyas-laptop.tail991db1.ts.net/*"
    ]);
    const html = readFileSync(new URL("../public-safari/mobile.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../public-safari/mobile.css", import.meta.url), "utf8");
    expect(html).toContain("viewport-fit=cover");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toContain("position:sticky");
    expect(css).toContain("-webkit-line-clamp:2");
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
  it("retains legacy explicit tone helpers for compatibility", () => {
    expect(REPLY_TONES).toHaveLength(8);
    expect(REPLY_VOICES).toHaveLength(8);
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
    expect(REPLY_VOICES.map((voice) => voice.label)).toEqual([
      "Dry understated",
      "Blunt direct",
      "Curious peer",
      "Sparse clipped",
      "Slightly skeptical",
      "Conversational",
      "Technical precise",
      "Quiet confident"
    ]);
    const assigned = assignReplyStyles(10);
    expect(assigned).toHaveLength(10);
    expect(new Set(assigned.slice(0, 8).map((style) => style.tone.label)).size).toBe(8);
    expect(new Set(assigned.slice(0, 8).map((style) => style.voice.label)).size).toBe(8);
    expect(assigned[8]?.tone.label).toBe(assigned[0]?.tone.label);
    expect(assigned[8]?.voice.label).toBe(assigned[0]?.voice.label);
    expect(assigned[9]?.tone.label).toBe(assigned[1]?.tone.label);
    expect(assigned[9]?.voice.label).toBe(assigned[1]?.voice.label);
    const instructions = buildReplyDraftInstructions(assigned[0]!, "earn relevant follows");
    expect(instructions).toContain(`Reply tone for this draft: ${assigned[0]!.tone.label}.`);
    expect(instructions).toContain(`Voice register for this draft: ${assigned[0]!.voice.label}.`);
    expect(instructions).toContain("generic AI openers");
  });
  it("uses source-aware taste instructions in live reply generation", () => {
    const instructions = buildTasteAwareReplyInstructions("start a useful conversation");
    expect(instructions).toContain("Choose the stance from the source post");
    expect(instructions).toContain("Prefer no reply");
    expect(instructions).not.toContain("Reply tone for this draft");
  });
  it("maps edits, skips, and publishes into backend taste feedback", () => {
    const context = { kind: "reply" as const, currentText: "", target: { text: "Source claim" } };
    expect(feedbackPayloadForEvent({
      clientEventId: "skip-1",
      kind: "skip",
      occurredAt: new Date().toISOString(),
      suggestionId: "s1",
      originalText: "Love this.",
      context
    })).toMatchObject({ decision: "skipped", originalText: "Love this.", kind: "comment" });
    expect(feedbackPayloadForEvent({
      clientEventId: "publish-1",
      kind: "published",
      occurredAt: new Date().toISOString(),
      suggestionId: "s2",
      originalText: "Maybe caching is hard.",
      finalText: "Cache invalidation is the product constraint.",
      context
    })).toMatchObject({ decision: "edited", suggestionId: "s2" });
  });
  it("keeps generated copy when a queued draft is edited more than once", () => {
    const queued = {
      id: "q1",
      draft: { id: "s1", text: "Generated wording" },
      context: { kind: "post" as const, currentText: "" },
      createdAt: 1
    };
    const first = updateQueuedDraft(queued, "  My preferred wording  ")!;
    const second = updateQueuedDraft(first.item, "My final wording")!;
    expect(first.item.draft.text).toBe("My preferred wording");
    expect(second.item.generatedText).toBe("Generated wording");
    expect(second.originalText).toBe("Generated wording");
    expect(second.finalText).toBe("My final wording");
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
    expect(FIND_HIGH_INTENT.maxCandidates).toBe(24);
    expect(FIND_HIGH_INTENT.maxScrolls).toBe(16);
    expect(FIND_HIGH_INTENT.minScore).toBe(60);
    expect(FIND_HIGH_INTENT.adjacentMinScore).toBe(55);
    expect(FIND_HIGH_INTENT.wildcardMinScore).toBe(50);
    expect(FIND_HIGH_INTENT.maxRisk).toBe(55);
  });
  it("selects a diverse default queue with five proven, two adjacent, and one wildcard", () => {
    const ranked = [
      ...[90, 85, 80, 75, 70].map((score, index) => ({ id: `p${index}`, score, recommendation: "reply" as const, reason: "fit", suggestedAngle: "add detail", topicSummary: `proven topic ${index}`, contributionPotential: score, audienceFit: score, novelty: 30, risk: 5, confidence: 85, risks: [] })),
      ...[58, 57].map((score, index) => ({ id: `a${index}`, score, recommendation: "reply" as const, reason: "adjacent", suggestedAngle: "connect it", topicSummary: `adjacent field ${index}`, contributionPotential: 70, audienceFit: 60, novelty: 75, risk: 10, confidence: 70, risks: [] })),
      { id: "w0", score: 52, recommendation: "reply" as const, reason: "novel", suggestedAngle: "test it", topicSummary: "unfamiliar but useful system", contributionPotential: 65, audienceFit: 50, novelty: 95, risk: 15, confidence: 60, risks: [] }
    ];
    const posts = ranked.map((post) => ({ id: post.id, text: post.topicSummary, author: post.id }));
    const selected = selectOpportunityMix(ranked, posts, emptyOpportunityLaneStats());
    expect(selected).toHaveLength(8);
    expect(selected.filter((item) => item.lane === "proven")).toHaveLength(5);
    expect(selected.filter((item) => item.lane === "adjacent")).toHaveLength(2);
    expect(selected.filter((item) => item.lane === "wildcard")).toHaveLength(1);
  });
  it("adapts exploration only after enough insert-or-skip decisions", () => {
    const stats = emptyOpportunityLaneStats();
    stats.adjacent.used = 3;
    stats.adjacent.skipped = 5;
    expect(adaptiveOpportunityMix(stats)).toEqual({ proven: 4, adjacent: 3, wildcard: 1 });
    stats.wildcard.used = 3;
    stats.wildcard.skipped = 5;
    expect(adaptiveOpportunityMix(stats)).toEqual({ proven: 4, adjacent: 2, wildcard: 2 });
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

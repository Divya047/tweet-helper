import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROWTH_PREFERENCES,
  enrichTopicSummaries,
  looksLikeCommentBait,
  suppressCommentBaitScores,
  validateDraftResponse,
  validateGenerateRewriteRequest,
  validateScoreVisiblePostsResponse
} from "../src/index.js";

describe("shared validators", () => {
  it("exports founder community growth defaults", () => {
    expect(DEFAULT_GROWTH_PREFERENCES).toEqual({
      audience: "Tech founders, indie hackers, and builders shipping products",
      pillar: "building",
      outcome: "earn relevant follows"
    });
  });

  it("accepts a valid draft response", () => {
    const result = validateDraftResponse({
      suggestions: [{ text: "Useful point.", rationale: "Matches tone.", confidence: 0.8 }]
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.id).toBeTruthy();
  });

  it("parses nested intentAnalysis on draft responses", () => {
    const result = validateDraftResponse({
      intentAnalysis: {
        intent: "Author is asking how early to talk to customers",
        confidence: 0.9,
        needsClarification: false,
        speechAct: "question",
        claimOrAsk: "When should founders talk to customers?",
        replyObjective: "Give a concrete timing heuristic",
        constraints: ["Do not invent metrics"],
        targetContext: "Founders should talk to customers earlier."
      },
      suggestions: [{ text: "Before the deck.", rationale: "Answers the ask.", confidence: 0.85 }]
    });

    expect(result.intentAnalysis).toEqual({
      intent: "Author is asking how early to talk to customers",
      confidence: 0.9,
      needsClarification: false,
      speechAct: "question",
      claimOrAsk: "When should founders talk to customers?",
      replyObjective: "Give a concrete timing heuristic",
      constraints: ["Do not invent metrics"],
      targetContext: "Founders should talk to customers earlier."
    });
  });

  it("ignores invalid speechAct values on intentAnalysis", () => {
    const result = validateDraftResponse({
      intentAnalysis: {
        intent: "Unclear post",
        confidence: 0.4,
        needsClarification: true,
        speechAct: "rant",
        constraints: []
      },
      suggestions: [{ text: "Clarify the constraint.", rationale: "Safe.", confidence: 0.7 }]
    });

    expect(result.intentAnalysis?.speechAct).toBeUndefined();
    expect(result.intentAnalysis?.needsClarification).toBe(true);
  });

  it("parses source-aware stance decisions and permits explicit abstention", () => {
    const result = validateDraftResponse({
      abstained: true,
      abstainReason: "The post leaves no non-generic opening.",
      intentAnalysis: {
        intent: "A bare product announcement",
        confidence: 0.92,
        needsClarification: false,
        speechAct: "announcement",
        shouldReply: false,
        replyWorthiness: 24,
        recommendedStance: "abstain",
        stanceReason: "Any reply would be applause.",
        constraints: []
      },
      suggestions: []
    });

    expect(result.abstained).toBe(true);
    expect(result.suggestions).toEqual([]);
    expect(result.intentAnalysis).toMatchObject({
      shouldReply: false,
      replyWorthiness: 24,
      recommendedStance: "abstain"
    });
  });

  it("detects comment bait and suppresses high-intent reply scores", () => {
    expect(looksLikeCommentBait("Comment YES if you agree and tag someone who needs this.")).toBe(true);
    expect(looksLikeCommentBait("Local software should make privacy the default.")).toBe(false);

    const suppressed = suppressCommentBaitScores(
      [{
        id: "bait",
        score: 88,
        recommendation: "reply",
        reason: "Looks popular.",
        suggestedAngle: "Jump in.",
        topicSummary: "Engagement farming prompt",
        risks: []
      }],
      [{ id: "bait", text: "Like if you agree. RT if you love this." }]
    );

    expect(suppressed[0]?.recommendation).toBe("skip");
    expect(suppressed[0]?.score).toBeLessThanOrEqual(25);
    expect(suppressed[0]?.risks).toContain("comment_bait");
  });

  it("fills missing topic summaries from source post text", () => {
    const enriched = enrichTopicSummaries(
      [{
        id: "1",
        score: 80,
        recommendation: "reply",
        reason: "Fit",
        suggestedAngle: "Add a caveat",
        risks: []
      }],
      [{ id: "1", text: "Local software should make privacy the default for every user." }]
    );
    expect(enriched[0]?.topicSummary).toContain("Local software should make privacy");
  });

  it("rejects an invalid reaction recommendation", () => {
    expect(() =>
      validateScoreVisiblePostsResponse({
        rankedPosts: [
          {
            id: "1",
            score: 90,
            recommendation: "auto reply",
            reason: "Bad",
            suggestedAngle: "No",
            topicSummary: "Invalid recommendation case",
            risks: []
          }
        ]
      })
    ).toThrow(/invalid recommendation/i);
  });

  it("validates rewrite requests", () => {
    expect(
      validateGenerateRewriteRequest({
        text: "Make this clearer",
        kind: "post",
        instructions: "Keep it short.",
        mode: "cheap"
      })
    ).toEqual({
      text: "Make this clearer",
      kind: "post",
      instructions: "Keep it short.",
      mode: "cheap"
    });

    expect(() => validateGenerateRewriteRequest({ text: "", kind: "post" })).toThrow(/text/i);
    expect(() => validateGenerateRewriteRequest({ text: "Draft", kind: "quote" })).toThrow(/kind must be post or comment/i);
  });
});

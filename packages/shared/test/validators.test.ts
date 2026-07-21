import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROWTH_PREFERENCES,
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
        risks: []
      }],
      [{ id: "bait", text: "Like if you agree. RT if you love this." }]
    );

    expect(suppressed[0]?.recommendation).toBe("skip");
    expect(suppressed[0]?.score).toBeLessThanOrEqual(25);
    expect(suppressed[0]?.risks).toContain("comment_bait");
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
        mode: "cheap",
        model: "advanced"
      })
    ).toEqual({
      text: "Make this clearer",
      kind: "post",
      instructions: "Keep it short.",
      mode: "cheap",
      model: "advanced"
    });

    expect(() => validateGenerateRewriteRequest({ text: "", kind: "post" })).toThrow(/text/i);
    expect(() => validateGenerateRewriteRequest({ text: "Draft", kind: "quote" })).toThrow(/kind must be post or comment/i);
  });
});

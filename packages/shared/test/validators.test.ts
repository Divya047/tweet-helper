import { describe, expect, it } from "vitest";
import { validateDraftResponse, validateGenerateRewriteRequest, validateScoreVisiblePostsResponse } from "../src/index.js";

describe("shared validators", () => {
  it("accepts a valid draft response", () => {
    const result = validateDraftResponse({
      suggestions: [{ text: "Useful point.", rationale: "Matches tone.", confidence: 0.8 }]
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.id).toBeTruthy();
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

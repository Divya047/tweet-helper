import { describe, expect, it } from "vitest";
import { buildServer, createMockTogetherClient } from "../src/server.js";
import { openDatabase } from "../src/db.js";

describe("backend routes", () => {
  it("imports archive data and generates mocked post drafts without network calls", async () => {
    const db = openDatabase(":memory:");
    const mockTogether = createMockTogetherClient(() => ({
      suggestions: [
        {
          text: "Local tools work best when they stay boring and useful.",
          rationale: "Concise and practical.",
          confidence: 0.84
        },
        {
          text: "The best side projects are the ones you can trust locally.",
          rationale: "Matches the topic.",
          confidence: 0.78
        },
        {
          text: "Small automation, manual approval, less regret.",
          rationale: "Short and direct.",
          confidence: 0.76
        }
      ]
    }));
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      togetherClient: mockTogether
    });

    const importResponse = await app.inject({
      method: "POST",
      url: "/api/import/x-archive",
      payload: {
        tweetsJsText: `window.YTD.tweets.part0 = [{"tweet":{"id_str":"1","full_text":"I like local-first tools."}}];`
      }
    });

    expect(importResponse.statusCode).toBe(200);
    expect(importResponse.json().data.imported).toBe(1);

    const generateResponse = await app.inject({
      method: "POST",
      url: "/api/generate/post",
      payload: { topic: "local-first tools", goal: "authentic" }
    });

    expect(generateResponse.statusCode).toBe(200);
    expect(generateResponse.json().data.suggestions).toHaveLength(3);
    expect(generateResponse.json().meta.cached).toBe(false);

    const cachedResponse = await app.inject({
      method: "POST",
      url: "/api/generate/post",
      payload: { topic: "local-first tools", goal: "authentic" }
    });

    expect(cachedResponse.json().meta.cached).toBe(true);
    await app.close();
  });

  it("scores visible posts with safe recommendations", async () => {
    const db = openDatabase(":memory:");
    const mockTogether = createMockTogetherClient(() => ({
      rankedPosts: [
        {
          id: "123",
          score: 86,
          recommendation: "reply",
          reason: "Strong topic fit.",
          suggestedAngle: "Add a practical caveat.",
          risks: []
        }
      ]
    }));
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      togetherClient: mockTogether
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/score/visible-posts",
      payload: {
        posts: [{ id: "123", text: "Local software should make privacy the default.", author: "dev" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.rankedPosts[0].recommendation).toBe("reply");
    await app.close();
  });
});

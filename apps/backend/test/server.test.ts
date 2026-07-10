import { describe, expect, it } from "vitest";
import { buildServer, createMockTogetherClient } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import type { JsonCompletionRequest } from "../src/together.js";

describe("backend routes", () => {
  it("imports archive data and generates mocked post drafts without network calls", async () => {
    const db = openDatabase(":memory:");
    const requests: JsonCompletionRequest[] = [];
    const mockTogether = createMockTogetherClient((request) => {
      requests.push(request);
      return {
        suggestions: [
          {
            text: "I like local-first tools.",
            rationale: "Copied too closely.",
            confidence: 0.9
          },
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
      };
    });
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
    expect(generateResponse.json().data.suggestions.map((suggestion: { text: string }) => suggestion.text)).not.toContain(
      "I like local-first tools."
    );
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("I like local-first tools.");
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

  it("keeps protected routes open when mobile auth is not configured", async () => {
    const db = openDatabase(":memory:");
    const mockTogether = createMockTogetherClient(() => ({
      suggestions: [{ text: "A clearer local-first draft.", rationale: "Tighter.", confidence: 0.8 }]
    }));
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      togetherClient: mockTogether
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/generate/rewrite",
      payload: { text: "local first tools are good", kind: "post" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.suggestions[0].text).toBe("A clearer local-first draft.");
    await app.close();
  });

  it("requires bearer auth for protected routes when mobile auth is configured", async () => {
    const db = openDatabase(":memory:");
    const mockTogether = createMockTogetherClient(() => ({
      suggestions: [{ text: "Authorized draft.", rationale: "Valid.", confidence: 0.8 }]
    }));
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10, mobileAuthToken: "secret-token" },
      togetherClient: mockTogether
    });

    const missing = await app.inject({
      method: "POST",
      url: "/api/generate/post",
      payload: { topic: "local tools" }
    });
    const wrong = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { authorization: "Bearer wrong" }
    });
    const feedbackMissing = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { suggestionId: "1", kind: "post", decision: "skipped" }
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    const authorized = await app.inject({
      method: "POST",
      url: "/api/generate/post",
      headers: { authorization: "Bearer secret-token" },
      payload: { topic: "local tools" }
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(feedbackMissing.statusCode).toBe(401);
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect(authorized.statusCode).toBe(200);
    await app.close();
  });

  it("rewrites existing drafts through cache and rejects empty text", async () => {
    const db = openDatabase(":memory:");
    const requests: JsonCompletionRequest[] = [];
    const mockTogether = createMockTogetherClient((request) => {
      requests.push(request);
      return {
        suggestions: [
          { text: "Local tools work best when they are boring and useful.", rationale: "Clearer.", confidence: 0.88 },
          { text: "The best local tools stay quiet, fast, and useful.", rationale: "More distinct.", confidence: 0.82 }
        ]
      };
    });
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      togetherClient: mockTogether
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/generate/rewrite",
      payload: { text: "   ", kind: "post" }
    });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.json().error.message).toMatch(/text is required/i);

    const response = await app.inject({
      method: "POST",
      url: "/api/generate/rewrite",
      payload: {
        text: "local tools should be simple and useful",
        kind: "post",
        instructions: "Make it sharper."
      }
    });
    const cached = await app.inject({
      method: "POST",
      url: "/api/generate/rewrite",
      payload: {
        text: "local tools should be simple and useful",
        kind: "post",
        instructions: "Make it sharper."
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.suggestions).toHaveLength(2);
    expect(response.json().meta.cached).toBe(false);
    expect(cached.json().meta.cached).toBe(true);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain("Preserve the user's meaning");
    await app.close();
  });
});

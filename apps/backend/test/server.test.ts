import { describe, expect, it } from "vitest";
import { buildServer, createMockCodexClient } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import type { JsonCompletionRequest } from "../src/codex.js";

describe("backend routes", () => {
  it("imports archive data and generates mocked post drafts without network calls", async () => {
    const db = openDatabase(":memory:");
    const requests: JsonCompletionRequest[] = [];
    const mockCodex = createMockCodexClient((request) => {
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
      codexClient: mockCodex
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

    expect(cachedResponse.json().meta.cached).toBe(false);
    await app.close();
  });

  it("scores visible posts with safe recommendations", async () => {
    const db = openDatabase(":memory:");
    let calls = 0;
    const mockCodex = createMockCodexClient(() => {
      calls += 1;
      return ({
      rankedPosts: [
        {
          id: "123",
          score: 86,
          recommendation: "reply",
          reason: "Strong topic fit.",
          suggestedAngle: "Add a practical caveat.",
          topicSummary: "Privacy should be the default in local software",
          contributionPotential: 90,
          audienceFit: 84,
          novelty: 72,
          risk: 8,
          confidence: 88,
          risks: []
        }
      ]
      });
    });
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      codexClient: mockCodex
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/score/visible-posts",
      payload: {
        posts: [{ id: "123", text: "Local software should make privacy the default.", author: "dev" }],
        audience: "Tech founders, indie hackers, and builders shipping products",
        contentPillar: "building",
        desiredOutcome: "earn relevant follows"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.rankedPosts[0].recommendation).toBe("reply");
    const cached = await app.inject({
      method: "POST",
      url: "/api/score/visible-posts",
      payload: {
        posts: [{ id: "123", text: "Local software should make privacy the default.", author: "dev" }],
        audience: "Tech founders, indie hackers, and builders shipping products",
        contentPillar: "building",
        desiredOutcome: "earn relevant follows"
      }
    });
    expect(cached.json().meta.cached).toBe(true);
    expect(calls).toBe(1);
    await app.close();
  });

  it("scores all 24 submitted posts and attaches trusted X media", async () => {
    const db = openDatabase(":memory:");
    let scoringRequest: JsonCompletionRequest | undefined;
    const mockCodex = createMockCodexClient((request) => {
      scoringRequest = request;
      const userPayload = JSON.parse(request.messages[1]!.content) as { visiblePosts: Array<{ id: string }> };
      return {
        rankedPosts: userPayload.visiblePosts.map((post, index) => ({
          id: post.id,
          score: 90 - index,
          recommendation: "reply",
          reason: "Useful peer discussion.",
          suggestedAngle: "Add a concrete implementation detail.",
          topicSummary: `Topic ${index}`,
          contributionPotential: 85,
          audienceFit: 80,
          novelty: 70,
          risk: 5,
          confidence: 90,
          risks: []
        }))
      };
    });
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      codexClient: mockCodex
    });
    const imageUrl = "https://pbs.twimg.com/media/example.jpg?name=large";
    const response = await app.inject({
      method: "POST",
      url: "/api/score/visible-posts",
      payload: {
        posts: Array.from({ length: 24 }, (_, index) => ({
          id: `post-${index}`,
          text: `Candidate post number ${index} has enough context to score.`,
          ...(index === 23 ? { media: [{ type: "image", url: imageUrl, altText: "A product chart" }] } : {})
        }))
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.rankedPosts).toHaveLength(24);
    expect(JSON.parse(scoringRequest!.messages[1]!.content).visiblePosts).toHaveLength(24);
    expect(scoringRequest!.imageUrls).toEqual([imageUrl]);
    await app.close();
  });

  it("rejects incomplete score results instead of silently dropping candidates", async () => {
    const db = openDatabase(":memory:");
    const mockCodex = createMockCodexClient(() => ({
      rankedPosts: [{
        id: "first",
        score: 80,
        recommendation: "reply",
        reason: "Useful discussion.",
        suggestedAngle: "Add detail.",
        topicSummary: "First topic",
        contributionPotential: 80,
        audienceFit: 80,
        novelty: 70,
        risk: 5,
        confidence: 90,
        risks: []
      }]
    }));
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      codexClient: mockCodex
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/score/visible-posts",
      payload: { posts: [{ id: "first", text: "First complete post for scoring." }, { id: "second", text: "Second complete post for scoring." }] }
    });

    expect(response.statusCode).toBe(500);
    await app.close();
  });

  it("does not learn style from accepted generated feedback", async () => {
    const db = openDatabase(":memory:");
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      codexClient: createMockCodexClient(() => ({}))
    });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { suggestionId: "generated", kind: "comment", decision: "accepted", finalText: "Generated wording." }
    });
    const edited = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { suggestionId: "edited", kind: "comment", decision: "edited", originalText: "Generated wording.", finalText: "My wording." }
    });

    expect(accepted.json().data.learned).toBe(false);
    expect(edited.json().data.learned).toBe(true);
    expect(db.prepare("SELECT text FROM writing_examples ORDER BY text").all()).toEqual([{ text: "My wording." }]);
    await app.close();
  });

  it("forces comment-bait posts to skip for high-intent scoring", async () => {
    const db = openDatabase(":memory:");
    const mockCodex = createMockCodexClient(() => ({
      rankedPosts: [
        {
          id: "bait",
          score: 92,
          recommendation: "reply",
          reason: "High engagement potential.",
          suggestedAngle: "Agree and ask a follow-up.",
          topicSummary: "Ask for likes and tags",
          contributionPotential: 20,
          audienceFit: 40,
          novelty: 10,
          risk: 90,
          confidence: 85,
          risks: []
        }
      ]
    }));
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      codexClient: mockCodex
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/score/visible-posts",
      payload: {
        posts: [{ id: "bait", text: "Comment YES if you agree and tag someone who needs to hear this.", author: "growth" }]
      }
    });

    expect(response.statusCode).toBe(200);
    const ranked = response.json().data.rankedPosts[0];
    expect(ranked.recommendation).toBe("skip");
    expect(ranked.score).toBeLessThanOrEqual(25);
    expect(ranked.risks).toContain("comment_bait");
    await app.close();
  });

  it("keeps protected routes open when mobile auth is not configured", async () => {
    const db = openDatabase(":memory:");
    const mockCodex = createMockCodexClient(() => ({
      suggestions: [{ text: "A clearer local-first draft.", rationale: "Tighter.", confidence: 0.8 }]
    }));
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      codexClient: mockCodex
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
    const mockCodex = createMockCodexClient(() => ({
      suggestions: [{ text: "Authorized draft.", rationale: "Valid.", confidence: 0.8 }]
    }));
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10, mobileAuthToken: "secret-token" },
      codexClient: mockCodex
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
    const mockCodex = createMockCodexClient((request) => {
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
      codexClient: mockCodex
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
    expect(cached.json().meta.cached).toBe(false);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1]?.messages)).toContain("Preserve the user's meaning");
    await app.close();
  });

  it("selects one source-aware reply through the taste judge", async () => {
    const db = openDatabase(":memory:");
    const requests: JsonCompletionRequest[] = [];
    const mockCodex = createMockCodexClient((request) => {
      requests.push(request);
      if (request.schemaName === "IntentAnalysis") {
        return {
          intent: "Author asks when to talk to customers",
          confidence: 0.94,
          needsClarification: false,
          speechAct: "question",
          claimOrAsk: "When should founders start customer interviews?",
          replyObjective: "Answer with a useful timing principle",
          shouldReply: true,
          replyWorthiness: 88,
          recommendedStance: "answer",
          stanceReason: "There is a direct question worth answering.",
          constraints: []
        };
      }
      if (request.schemaName === "DraftResponse") {
        return {
          suggestions: [
            { id: "generic", text: "Great point. Talk to them early!", rationale: "Positive.", confidence: 0.9 },
            { id: "sharp", text: "Before the roadmap hardens into assumptions.", rationale: "Answers directly.", confidence: 0.84 }
          ]
        };
      }
      return {
        shouldReply: true,
        reason: "The concise answer adds a useful timing principle.",
        confidence: 0.91,
        recommendedId: "sharp",
        stance: "answer",
        evaluations: [
          { suggestionId: "generic", score: 38, sourceFit: 55, novelty: 20, voiceFit: 30, restraint: 45, reasons: ["Generic applause"], flags: ["generic"] },
          { suggestionId: "sharp", score: 91, sourceFit: 95, novelty: 86, voiceFit: 90, restraint: 94, reasons: ["Direct and useful"], flags: [] }
        ]
      };
    });
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      codexClient: mockCodex
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/generate/comment",
      payload: {
        sourcePost: {
          id: "1",
          text: "When should founders start talking to customers?",
          media: [{ type: "image", url: "https://pbs.twimg.com/media/customer-chart.jpg", altText: "Interview response chart" }]
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.suggestions).toHaveLength(1);
    expect(response.json().data.suggestions[0]).toMatchObject({
      id: "sharp",
      text: "Before the roadmap hardens into assumptions.",
      strategy: "answer"
    });
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.imageUrls?.[0] === "https://pbs.twimg.com/media/customer-chart.jpg")).toBe(true);
    expect(response.json().data.tasteDecision.recommendedId).toBe("sharp");
    await app.close();
  });

  it("returns an explicit abstention when no reply clears the taste bar", async () => {
    const db = openDatabase(":memory:");
    const mockCodex = createMockCodexClient((request) => {
      if (request.schemaName === "IntentAnalysis") {
        return {
          intent: "Bare launch announcement",
          confidence: 0.95,
          needsClarification: false,
          speechAct: "announcement",
          claimOrAsk: "A product shipped",
          replyObjective: "Only respond if there is something distinct to add",
          shouldReply: false,
          replyWorthiness: 25,
          recommendedStance: "abstain",
          stanceReason: "A reply would only be applause.",
          constraints: []
        };
      }
      if (request.schemaName === "DraftResponse") {
        return {
          suggestions: [
            { id: "applause", text: "Love this. Huge congrats!", rationale: "Supportive.", confidence: 0.9 }
          ]
        };
      }
      return {
        shouldReply: false,
        reason: "Every candidate is generic applause.",
        confidence: 0.96,
        stance: "abstain",
        evaluations: [
          { suggestionId: "applause", score: 22, sourceFit: 40, novelty: 5, voiceFit: 18, restraint: 25, reasons: ["Generic applause"], flags: ["generic"] }
        ]
      };
    });
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      codexClient: mockCodex
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/generate/comment",
      payload: { sourcePost: { id: "1", text: "We shipped v2 today." } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.suggestions).toEqual([]);
    expect(response.json().data.abstained).toBe(true);
    expect(response.json().data.abstainReason).toMatch(/generic applause/i);
    await app.close();
  });

  it("learns negative feedback in the inspectable personal taste profile", async () => {
    const db = openDatabase(":memory:");
    const { app } = await buildServer({
      db,
      config: { dbPath: ":memory:", dailyBudgetUsd: 10, monthlyBudgetUsd: 10 },
      codexClient: createMockCodexClient(() => ({}))
    });

    await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: {
        suggestionId: "skip-me",
        kind: "comment",
        decision: "skipped",
        originalText: "Great point. Love this.",
        context: { sourcePost: { text: "A launch announcement." } }
      }
    });
    const profile = await app.inject({ method: "GET", url: "/api/taste-profile" });

    expect(profile.statusCode).toBe(200);
    expect(profile.json().data.decisionCounts.skipped).toBe(1);
    expect(profile.json().data.negativeExamples).toContain("Great point. Love this.");
    await app.close();
  });
});

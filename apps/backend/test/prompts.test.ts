import { describe, expect, it } from "vitest";
import { buildCommentMessages, buildPostMessages, buildScoreMessages } from "../src/prompts.js";
import { DEFAULT_GROWTH_PREFERENCES } from "@tweet-helper/shared";

describe("audience growth prompts", () => {
  it("grounds posts in the selected audience and content pillar", () => {
    const messages = buildPostMessages({
      topic: "What I learned shipping a local-first sync feature",
      goal: "engagement",
      audience: DEFAULT_GROWTH_PREFERENCES.audience,
      contentPillar: "building",
      desiredOutcome: "earn relevant follows"
    }, undefined, []);

    const prompt = JSON.stringify(messages);
    expect(prompt).toContain(DEFAULT_GROWTH_PREFERENCES.audience);
    expect(prompt).toContain("building");
    expect(prompt).toContain("earn relevant follows");
    expect(prompt).toContain("peer founders and builders");
    expect(prompt).toContain("never publish a naked engagement question");
  });

  it("requires replies to add standalone value and scores for community fit", () => {
    const reply = JSON.stringify(buildCommentMessages({
      sourcePost: { id: "1", text: "Founders should talk to customers earlier." },
      audience: DEFAULT_GROWTH_PREFERENCES.audience,
      contentPillar: "building",
      desiredOutcome: "earn relevant follows"
    }, undefined, [], [], {
      intent: "Author claims founders wait too long to talk to customers",
      confidence: 0.9,
      needsClarification: false,
      speechAct: "claim",
      claimOrAsk: "Founders should talk to customers earlier",
      replyObjective: "Add a concrete timing heuristic or tradeoff",
      constraints: []
    }));
    const scoring = JSON.stringify(buildScoreMessages({
      posts: [{ id: "1", text: "Founders should talk to customers earlier." }],
      audience: DEFAULT_GROWTH_PREFERENCES.audience,
      contentPillar: "building",
      desiredOutcome: "earn relevant follows"
    }, undefined, []));

    expect(reply).toContain("complete thought that is useful even when read on its own");
    expect(reply).toContain("peer founder/builder expertise");
    expect(reply).toContain("sourceIntent");
    expect(reply).toContain("speechAct/claimOrAsk/replyObjective");
    expect(reply).toContain("when that fits the replyObjective");
    expect(reply).toContain("Never invent facts");
    expect(reply).toContain("Do not default to anecdote openers");
    expect(reply).toContain("Do not default to counterexample");
    expect(reply).toContain("voice register");
    expect(reply).toContain("Great point");
    expect(reply).toContain("It's not X, it's Y");
    expect(reply).toContain("Sound like a specific person typing quickly on X");
    expect(reply).toContain("Suggestions must address sourceIntent");
    expect(reply).toContain("earn relevant follows");
    expect(scoring).toContain(DEFAULT_GROWTH_PREFERENCES.audience);
    expect(scoring).toContain("high metrics alone is not a reason");
    expect(scoring).toContain("Never recommend reply for comment-bait posts");
    expect(scoring).toContain("comment-bait / reply-harvesting risk");
    expect(scoring).toContain("author/audience overlap with target niche");
    expect(scoring).toContain("alignment with desiredOutcome");
    expect(scoring).toContain("Prefer posts from builders, founders, and engineers");
    expect(scoring).toContain("topicSummary");
    expect(scoring).toContain("max 12 words");
  });
});

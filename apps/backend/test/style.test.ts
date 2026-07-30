import { describe, expect, it } from "vitest";
import { openDatabase, saveFeedback, upsertWritingExamples } from "../src/db.js";
import { buildPersonalTasteProfile, getPersonalTasteProfile, rebuildPersonalTasteProfile, selectStyleExamples } from "../src/style.js";

describe("style example selection", () => {
  it("excludes recently imported archive tweets from draft context", () => {
    const db = openDatabase(":memory:");
    upsertWritingExamples(db, [
      {
        id: "x:recent",
        kind: "post",
        text: "Fresh local-first tools should stay small and boring.",
        source: "x-archive",
        createdAt: new Date().toISOString()
      },
      {
        id: "x:older",
        kind: "post",
        text: "Older local-first tools note with a practical edge.",
        source: "x-archive",
        createdAt: "2025-01-01T00:00:00.000Z"
      }
    ]);

    const examples = selectStyleExamples(db, "local-first tools", "post");

    expect(examples.map((example) => example.id)).toContain("x:older");
    expect(examples.map((example) => example.id)).not.toContain("x:recent");
  });

  it("builds taste from accepted, edited, and skipped decisions", () => {
    const profile = buildPersonalTasteProfile([
      {
        suggestionId: "accepted",
        decision: "accepted",
        originalText: "Caching is a product decision, not just an implementation detail.",
        finalText: "Caching is a product decision, not just an implementation detail.",
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        suggestionId: "edited",
        decision: "edited",
        originalText: "Great point! I think maybe the real unlock is asking a thoughtful question?",
        finalText: "The harder constraint is deciding what not to cache.",
        createdAt: "2026-01-02T00:00:00.000Z"
      },
      {
        suggestionId: "skipped",
        decision: "skipped",
        originalText: "Love this. So true!",
        finalText: null,
        createdAt: "2026-01-03T00:00:00.000Z"
      }
    ]);

    expect(profile.decisionCounts).toEqual({ accepted: 1, edited: 1, rejected: 0, skipped: 1 });
    expect(profile.editSignals.shorterRate).toBe(1);
    expect(profile.editSignals.removedQuestionRate).toBe(1);
    expect(profile.editSignals.removedApplauseRate).toBe(1);
    expect(profile.negativeExamples).toContain("Love this. So true!");
    expect(profile.guidance).toContain("The user usually shortens generated drafts; cut harder before presenting one.");
  });

  it("persists a profile rebuilt from the latest decision per suggestion", () => {
    const db = openDatabase(":memory:");
    saveFeedback(db, {
      suggestionId: "same",
      kind: "comment",
      decision: "skipped",
      originalText: "Great point."
    });
    saveFeedback(db, {
      suggestionId: "same",
      kind: "comment",
      decision: "edited",
      originalText: "Great point.",
      finalText: "The constraint matters more than the tool."
    });

    const rebuilt = rebuildPersonalTasteProfile(db);
    const loaded = getPersonalTasteProfile(db);

    expect(rebuilt.sampleCount).toBe(1);
    expect(rebuilt.decisionCounts.edited).toBe(1);
    expect(loaded).toEqual(rebuilt);
  });
});

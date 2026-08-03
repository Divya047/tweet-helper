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

  it("uses unique archive or manually edited examples and excludes helper outcomes", () => {
    const db = openDatabase(":memory:");
    upsertWritingExamples(db, [
      { id: "edit:1", kind: "comment", text: "The constraint matters more than the tool.", source: "feedback" },
      { id: "edit:2", kind: "comment", text: "The constraint matters more than the tool!", source: "feedback" },
      { id: "outcome:1", kind: "comment", text: "Generated copy should not train itself.", source: "outcome" },
      { id: "archive:1", kind: "comment", text: "An older authentic comment about constraints.", source: "x-archive", createdAt: "2025-01-01T00:00:00.000Z" }
    ]);

    const examples = selectStyleExamples(db, "constraint tool generated copy", "comment", 8);

    expect(examples.filter((example) => normalizeForTest(example.text) === "the constraint matters more than the tool")).toHaveLength(1);
    expect(examples.map((example) => example.id)).not.toContain("outcome:1");
    expect(new Set(examples.map((example) => normalizeForTest(example.text))).size).toBe(examples.length);
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

  it("preserves a manual edit when publishing later accepts the edited text", () => {
    const db = openDatabase(":memory:");
    saveFeedback(db, {
      suggestionId: "same",
      kind: "comment",
      decision: "edited",
      originalText: "Generated wording.",
      finalText: "My wording."
    });
    saveFeedback(db, {
      suggestionId: "same",
      kind: "comment",
      decision: "accepted",
      originalText: "My wording.",
      finalText: "My wording."
    });

    const rebuilt = rebuildPersonalTasteProfile(db);

    expect(rebuilt.sampleCount).toBe(1);
    expect(rebuilt.decisionCounts.edited).toBe(1);
    expect(rebuilt.editSignals.sampleCount).toBe(1);
    expect(rebuilt.positiveExamples).toContain("My wording.");
  });

  it("does not merge unrelated feedback when a model reuses suggestion ids", () => {
    const db = openDatabase(":memory:");
    saveFeedback(db, { suggestionId: "1", kind: "comment", decision: "edited", originalText: "First generated draft.", finalText: "First edit." });
    saveFeedback(db, { suggestionId: "1", kind: "comment", decision: "edited", originalText: "Different generated draft.", finalText: "Different edit." });
    const profile = rebuildPersonalTasteProfile(db);
    expect(profile.decisionCounts.edited).toBe(2);
  });
});

function normalizeForTest(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

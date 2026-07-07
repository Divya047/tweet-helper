import { describe, expect, it } from "vitest";
import { openDatabase, upsertWritingExamples } from "../src/db.js";
import { selectStyleExamples } from "../src/style.js";

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
});

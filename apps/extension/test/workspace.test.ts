import { describe, expect, it } from "vitest";
import type { QueueItem } from "../src/contracts.js";
import {
  analyzeDraft,
  DEFAULT_SCAN_PREFERENCES,
  duplicateQueueIds,
  filterAndSortQueue,
  filterScanPosts,
  normalizeWorkspacePreferences,
  parseListInput,
  replyPresetInstruction,
  splitThread
} from "../src/workspace.js";

const item = (id: string, text: string, values: Partial<QueueItem> = {}): QueueItem => ({
  id,
  draft: { id: `draft-${id}`, text },
  context: { kind: "reply", currentText: "", target: { text: "source", author: "alice" } },
  createdAt: Number(id),
  ...values
});

describe("workspace power tools", () => {
  it("normalizes scan controls into safe ranges", () => {
    const value = normalizeWorkspacePreferences({
      scan: { targetReplies: 99, maxCandidates: 2, scrollStepPercent: 12, ignoredAuthors: [" Alice ", "Alice"] },
      queueSort: "bad"
    });
    expect(value.scan.targetReplies).toBe(12);
    expect(value.scan.maxCandidates).toBe(8);
    expect(value.scan.scrollStepPercent).toBe(40);
    expect(value.scan.ignoredAuthors).toEqual(["Alice"]);
    expect(value.queueSort).toBe("newest");
  });

  it("filters feed posts and reports every rejection reason", () => {
    const result = filterScanPosts([
      { text: "tiny" },
      { text: "A useful post about systems", author: "ignored" },
      { text: "A useful post about crypto systems", author: "bob" },
      { text: "Share your thoughts?", author: "carol" },
      { text: "A practical post about queue recovery", author: "dave" }
    ], { ...DEFAULT_SCAN_PREFERENCES, ignoredAuthors: ["@ignored"], blockedTerms: ["crypto"] });
    expect(result.posts.map((post) => post.author)).toEqual(["dave"]);
    expect(result.stats).toMatchObject({ collected: 5, kept: 1, tooShort: 1, ignoredAuthor: 1, blockedTerm: 1, commentBait: 1 });
  });

  it("searches and sorts queue items across copy, source, tags, and favorites", () => {
    const items = [
      item("1", "older queue draft", { tags: ["pricing"] }),
      item("2", "newer draft", { favorite: true, context: { kind: "post", currentText: "" } }),
      item("3", "third draft", { sourceSummary: "pricing experiments" })
    ];
    expect(filterAndSortQueue(items, { query: "pricing", kind: "all", sort: "newest", favoritesOnly: false }).map((entry) => entry.id)).toEqual(["3", "1"]);
    expect(filterAndSortQueue(items, { query: "", kind: "all", sort: "favorites", favoritesOnly: false })[0]?.id).toBe("2");
    expect(filterAndSortQueue(items, { query: "", kind: "post", sort: "newest", favoritesOnly: false }).map((entry) => entry.id)).toEqual(["2"]);
    items[0]!.scheduledFor = "2026-08-22T10:00";
    items[2]!.scheduledFor = "2026-08-21T10:00";
    expect(filterAndSortQueue(items, { query: "", kind: "all", sort: "scheduled", favoritesOnly: false }).map((entry) => entry.id)).toEqual(["3", "1", "2"]);
  });

  it("finds duplicates and gives concrete draft warnings", () => {
    const items = [item("1", "Same useful point https://x.com/one"), item("2", "same useful point"), item("3", "different")];
    expect([...duplicateQueueIds(items)].sort()).toEqual(["1", "2"]);
    expect(analyzeDraft("Great post. Everyone gets 75% better. Thoughts? #one #two #three", "reply", true).map((warning) => warning.code)).toEqual([
      "generic-praise", "engagement-question", "claim", "hashtag-heavy", "duplicate"
    ]);
  });

  it("splits long posts into numbered pieces within the limit", () => {
    const pieces = splitThread(`${"A useful sentence with enough words. ".repeat(15)}${"A final thought. ".repeat(10)}`, 120);
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.every((piece) => piece.length <= 120)).toBe(true);
    expect(pieces[0]).toMatch(/^1\/\d+ /);
  });

  it("parses reusable lists and exposes distinct reply preset instructions", () => {
    expect(parseListInput("alice, bob\nalice")).toEqual(["alice", "bob"]);
    expect(replyPresetInstruction("technical")).toContain("implementation detail");
    expect(replyPresetInstruction("technical")).not.toBe(replyPresetInstruction("warm"));
  });
});

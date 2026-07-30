import { describe, expect, it } from "vitest";
import { normalizeActivity } from "../src/activity.js";
describe("daily activity counts", () => {
  it("keeps uncapped post and reply totals", () => {
    expect(normalizeActivity(
      { dayKey: "2026-07-10", posts: 125, replies: 89 },
      new Date(2026, 6, 10)
    )).toEqual({ dayKey: "2026-07-10", posts: 125, replies: 89 });
  });
  it("resets using a local calendar date rather than a parsed UTC fixture", () => {
    expect(normalizeActivity({ dayKey: "2026-07-09", posts: 4, replies: 3 }, new Date(2026, 6, 10, 0, 1))).toEqual({ dayKey: "2026-07-10", posts: 0, replies: 0 });
  });
});

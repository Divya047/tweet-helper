import { describe, expect, it } from "vitest";
import { activitySnapshot, normalizeActivity, SOFT_GOALS } from "../src/activity.js";
describe("soft activity goals", () => {
  it("uses stable 8/24 goals without disabling work", () => {
    const result = activitySnapshot({ dayKey: "2026-07-10", posts: 9, replies: 25 }, new Date(2026, 6, 10));
    expect(result.goals).toEqual(SOFT_GOALS); expect(result.postProgress).toBeGreaterThan(1); expect(result.replyProgress).toBeGreaterThan(1);
    expect(result).not.toHaveProperty("canPost"); expect(result).not.toHaveProperty("canReply");
  });
  it("resets using a local calendar date rather than a parsed UTC fixture", () => {
    expect(normalizeActivity({ dayKey: "2026-07-09", posts: 4, replies: 3 }, new Date(2026, 6, 10, 0, 1))).toEqual({ dayKey: "2026-07-10", posts: 0, replies: 0 });
  });
});

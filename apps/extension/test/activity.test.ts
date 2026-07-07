import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  getBarColor,
  normalizeState,
  type ActivityState
} from "../src/activity.js";

describe("activity tracker", () => {
  const base: ActivityState = {
    dayKey: "2026-07-07",
    dailyPosts: 0,
    dailyReplies: 0,
    batchPosts: 0,
    batchReplies: 0,
    batchWindowStart: null
  };

  it("resets daily counters on a new day", () => {
    const state: ActivityState = {
      ...base,
      dailyPosts: 5,
      dailyReplies: 10,
      batchPosts: 2,
      batchReplies: 4,
      batchWindowStart: Date.parse("2026-07-07T10:00:00")
    };
    const now = Date.parse("2026-07-08T01:00:00");
    const normalized = normalizeState(state, now);
    expect(normalized.dayKey).toBe("2026-07-08");
    expect(normalized.dailyPosts).toBe(0);
    expect(normalized.dailyReplies).toBe(0);
    expect(normalized.batchPosts).toBe(0);
    expect(normalized.batchReplies).toBe(0);
    expect(normalized.batchWindowStart).toBeNull();
  });

  it("clears legacy batch counters during normalization", () => {
    const windowStart = Date.parse("2026-07-07T10:00:00");
    const state: ActivityState = {
      ...base,
      dailyPosts: 2,
      batchPosts: 2,
      batchReplies: 6,
      batchWindowStart: windowStart
    };
    const now = windowStart + 60_000;
    const normalized = normalizeState(state, now);
    expect(normalized.dailyPosts).toBe(2);
    expect(normalized.batchPosts).toBe(0);
    expect(normalized.batchReplies).toBe(0);
    expect(normalized.batchWindowStart).toBeNull();
  });

  it("disables post button only when the daily cap is reached", () => {
    const windowStart = Date.now() - 60_000;
    const atDailyCap = buildSnapshot({ ...base, dailyPosts: 8, batchWindowStart: windowStart }, Date.now());
    expect(atDailyCap.canPost).toBe(false);
    expect(atDailyCap.postDisabledReason).toBe("Daily limit reached");

    const atBatchCap = buildSnapshot(
      { ...base, dailyPosts: 1, batchPosts: 2, batchWindowStart: windowStart },
      Date.now()
    );
    expect(atBatchCap.canPost).toBe(true);
    expect(atBatchCap.postDisabledReason).toBeNull();
  });

  it("keeps reply button enabled when legacy batch cap is reached", () => {
    const windowStart = Date.now() - 60_000;
    const snapshot = buildSnapshot(
      { ...base, dailyReplies: 5, batchReplies: 6, batchWindowStart: windowStart },
      Date.now()
    );
    expect(snapshot.canReply).toBe(true);
    expect(snapshot.replyDisabledReason).toBeNull();
  });

  it("shifts bar color as ratio increases", () => {
    expect(getBarColor(0.3)).toBe("#22c55e");
    expect(getBarColor(0.7)).toBe("#f59e0b");
    expect(getBarColor(0.9)).toBe("#f43f5e");
    expect(getBarColor(1)).toBe("#d97706");
  });
});

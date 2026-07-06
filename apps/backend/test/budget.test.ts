import { describe, expect, it } from "vitest";
import { assertWithinBudget } from "../src/budget.js";
import { initializeSettings, logUsage, openDatabase } from "../src/db.js";

describe("budget guard", () => {
  it("blocks requests that exceed the daily budget", () => {
    const db = openDatabase(":memory:");
    initializeSettings(db, { dailyBudgetUsd: 0.001, monthlyBudgetUsd: 10 });
    logUsage(db, "test", "cache", 1, 1, 0.0009);

    expect(() => assertWithinBudget(db, 1000, 1000)).toThrow(/daily together budget/i);
  });
});

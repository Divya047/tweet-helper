import { estimateTogetherCostUsd } from "@tweet-helper/shared";
import type { AppDatabase } from "./db.js";
import { getSettings, getUsageSince } from "./db.js";

export interface BudgetCheck {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export function assertWithinBudget(db: AppDatabase, inputTokens: number, outputTokens: number): BudgetCheck {
  const estimatedCostUsd = estimateTogetherCostUsd(inputTokens, outputTokens);
  const settings = getSettings(db);
  const dailyBudgetUsd = numberSetting(settings.dailyBudgetUsd, 2);
  const monthlyBudgetUsd = numberSetting(settings.monthlyBudgetUsd, 20);
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const spentToday = getUsageSince(db, dayStart);
  const spentThisMonth = getUsageSince(db, monthStart);

  if (spentToday + estimatedCostUsd > dailyBudgetUsd) {
    throw new Error(
      `Daily Together budget would be exceeded. Spent $${spentToday.toFixed(4)}, estimated request $${estimatedCostUsd.toFixed(
        4
      )}, daily limit $${dailyBudgetUsd.toFixed(2)}.`
    );
  }

  if (spentThisMonth + estimatedCostUsd > monthlyBudgetUsd) {
    throw new Error(
      `Monthly Together budget would be exceeded. Spent $${spentThisMonth.toFixed(4)}, estimated request $${estimatedCostUsd.toFixed(
        4
      )}, monthly limit $${monthlyBudgetUsd.toFixed(2)}.`
    );
  }

  return { inputTokens, outputTokens, estimatedCostUsd };
}

function numberSetting(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

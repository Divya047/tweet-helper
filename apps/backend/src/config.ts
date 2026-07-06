import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_MODEL } from "@tweet-helper/shared";

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  model: string;
  togetherApiKey?: string;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
}

export function loadEnvFiles(cwd = process.cwd()): void {
  for (const envDir of envSearchDirs(cwd)) {
    for (const fileName of [".env.local", ".env"]) {
      const filePath = resolve(envDir, fileName);
      if (!existsSync(filePath)) {
        continue;
      }
      const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const separator = trimmed.indexOf("=");
        if (separator === -1) {
          continue;
        }
        const key = trimmed.slice(0, separator).trim();
        const rawValue = trimmed.slice(separator + 1).trim();
        if (!process.env[key]) {
          process.env[key] = rawValue.replace(/^["']|["']$/g, "");
        }
      }
    }
  }
}

function envSearchDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);
  while (true) {
    dirs.push(current);
    if (existsSync(resolve(current, ".git")) || isWorkspacePackage(current)) {
      return dirs;
    }
    const parent = dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
}

function isWorkspacePackage(dir: string): boolean {
  const packagePath = resolve(dir, "package.json");
  if (!existsSync(packagePath)) {
    return false;
  }
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { workspaces?: unknown };
    return Array.isArray(packageJson.workspaces);
  } catch {
    return false;
  }
}

export function getConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const togetherApiKey = process.env.TOGETHER_API_KEY || undefined;
  return {
    port: numberFromEnv("PORT", 4317),
    host: process.env.HOST ?? "127.0.0.1",
    dbPath: process.env.DB_PATH ?? "./data/tweet-helper.sqlite",
    model: process.env.TOGETHER_MODEL ?? DEFAULT_MODEL,
    dailyBudgetUsd: numberFromEnv("DAILY_BUDGET_USD", 2),
    monthlyBudgetUsd: numberFromEnv("MONTHLY_BUDGET_USD", 20),
    ...(togetherApiKey ? { togetherApiKey } : {}),
    ...overrides
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

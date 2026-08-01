import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFiles } from "../src/config.js";

const originalCodexCliPath = process.env.CODEX_CLI_PATH;

afterEach(() => {
  if (originalCodexCliPath === undefined) {
    delete process.env.CODEX_CLI_PATH;
  } else {
    process.env.CODEX_CLI_PATH = originalCodexCliPath;
  }
});

describe("loadEnvFiles", () => {
  it("loads env files from the workspace root when started in a workspace package", () => {
    delete process.env.CODEX_CLI_PATH;
    const root = mkdtempSync(join(tmpdir(), "tweet-helper-env-"));
    const backendDir = join(root, "apps", "backend");
    mkdirSync(backendDir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    writeFileSync(join(root, ".env.local"), "CODEX_CLI_PATH=/root/codex\n");

    loadEnvFiles(backendDir);

    expect(process.env.CODEX_CLI_PATH).toBe("/root/codex");
  });

  it("keeps package env values ahead of workspace root values", () => {
    delete process.env.CODEX_CLI_PATH;
    const root = mkdtempSync(join(tmpdir(), "tweet-helper-env-"));
    const backendDir = join(root, "apps", "backend");
    mkdirSync(backendDir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    writeFileSync(join(root, ".env.local"), "CODEX_CLI_PATH=/root/codex\n");
    writeFileSync(join(backendDir, ".env.local"), "CODEX_CLI_PATH=/package/codex\n");

    loadEnvFiles(backendDir);

    expect(process.env.CODEX_CLI_PATH).toBe("/package/codex");
  });
});

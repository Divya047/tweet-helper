import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFiles } from "../src/config.js";

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
  if (originalTogetherApiKey === undefined) {
    delete process.env.TOGETHER_API_KEY;
  } else {
    process.env.TOGETHER_API_KEY = originalTogetherApiKey;
  }
});

describe("loadEnvFiles", () => {
  it("loads env files from the workspace root when started in a workspace package", () => {
    delete process.env.TOGETHER_API_KEY;
    const root = mkdtempSync(join(tmpdir(), "tweet-helper-env-"));
    const backendDir = join(root, "apps", "backend");
    mkdirSync(backendDir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    writeFileSync(join(root, ".env.local"), "TOGETHER_API_KEY=root-key\n");

    loadEnvFiles(backendDir);

    expect(process.env.TOGETHER_API_KEY).toBe("root-key");
  });

  it("keeps package env values ahead of workspace root values", () => {
    delete process.env.TOGETHER_API_KEY;
    const root = mkdtempSync(join(tmpdir(), "tweet-helper-env-"));
    const backendDir = join(root, "apps", "backend");
    mkdirSync(backendDir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    writeFileSync(join(root, ".env.local"), "TOGETHER_API_KEY=root-key\n");
    writeFileSync(join(backendDir, ".env.local"), "TOGETHER_API_KEY=package-key\n");

    loadEnvFiles(backendDir);

    expect(process.env.TOGETHER_API_KEY).toBe("package-key");
  });
});

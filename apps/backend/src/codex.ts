import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODEL,
  estimateTokens,
  parseJsonObject,
  type DraftResponse,
  type ScoreVisiblePostsResponse
} from "@tweet-helper/shared";
import type { ChatMessage } from "./prompts.js";

export interface JsonCompletionRequest {
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
  /** Per-request Codex CLI timeout. Defaults to 60s. */
  timeoutMs?: number;
}

export interface JsonCompletionResult {
  value: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  rawText: string;
  model: string;
}

export interface CodexClient {
  defaultModel: string;
  completeJson(request: JsonCompletionRequest): Promise<JsonCompletionResult>;
}

export interface CodexInvocation {
  prompt: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
}

export type CodexRunner = (invocation: CodexInvocation) => Promise<string>;

export function createCodexClient(options: { command?: string; run?: CodexRunner } = {}): CodexClient {
  const run = options.run ?? createCodexCliRunner(options.command ?? "codex");
  return {
    defaultModel: DEFAULT_MODEL,
    async completeJson(request) {
      const first = await requestJsonCompletion(run, request);
      try {
        return {
          value: parseJsonObject(first.rawText),
          inputTokens: first.inputTokens,
          outputTokens: first.outputTokens,
          costUsd: first.costUsd,
          rawText: first.rawText,
          model: DEFAULT_MODEL
        };
      } catch (error) {
        const repaired = await requestJsonCompletion(run, repairRequest(request, first.rawText));
        try {
          return {
            value: parseJsonObject(repaired.rawText),
            inputTokens: first.inputTokens + repaired.inputTokens,
            outputTokens: first.outputTokens + repaired.outputTokens,
            costUsd: first.costUsd + repaired.costUsd,
            rawText: repaired.rawText,
            model: DEFAULT_MODEL
          };
        } catch {
          throw error;
        }
      }
    }
  };
}

async function requestJsonCompletion(
  run: CodexRunner,
  request: JsonCompletionRequest
): Promise<Omit<JsonCompletionResult, "value">> {
  const timeoutMs = request.timeoutMs ?? 60_000;
  const prompt = messagesToPrompt(request.messages, request.schemaName);
  const rawText = await run({ prompt, schema: request.schema, timeoutMs });
  if (!rawText.trim()) {
    throw new Error("Codex CLI did not return a final response.");
  }
  return {
    inputTokens: estimateTokens(prompt),
    outputTokens: estimateTokens(rawText),
    costUsd: 0,
    rawText,
    model: DEFAULT_MODEL
  };
}

function createCodexCliRunner(command: string): CodexRunner {
  let authenticationCheck: Promise<void> | undefined;
  return async ({ prompt, schema, timeoutMs }) => {
    authenticationCheck ??= assertChatGPTLogin(command);
    await authenticationCheck;
    const tempDir = await mkdtemp(join(tmpdir(), "tweet-helper-codex-"));
    const schemaPath = join(tempDir, "schema.json");
    const outputPath = join(tempDir, "response.json");
    try {
      await writeFile(schemaPath, JSON.stringify(toStrictOutputSchema(schema)), "utf8");
      await runProcess(
        command,
        [
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--model",
          DEFAULT_MODEL,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "--color",
          "never",
          "--cd",
          tempDir,
          "-"
        ],
        prompt,
        timeoutMs
      );
      return await readFile(outputPath, "utf8");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function assertChatGPTLogin(command: string): Promise<void> {
  const result = await runProcess(command, ["login", "status"], undefined, 10_000);
  if (!/logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error("Codex CLI must be signed in with ChatGPT. Run `codex login` and choose ChatGPT sign-in.");
  }
}

function runProcess(
  command: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { OPENAI_API_KEY: _openAIKey, CODEX_API_KEY: _codexKey, ...subscriptionEnv } = process.env;
    const child = spawn(command, args, { env: subscriptionEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", (error) => reject(new Error(`Could not start Codex CLI (${command}): ${error.message}`)));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex CLI timed out after ${Math.round(timeoutMs / 1000)}s. Try again.`));
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(usefulError(stderr) ?? `Codex CLI exited with status ${code ?? "unknown"}.`));
      }
    });
    child.stdin.end(stdin);
  });
}

function messagesToPrompt(messages: ChatMessage[], schemaName: string): string {
  return [
    `Generate the ${schemaName} result for the conversation below.`,
    "Do not inspect files, run commands, browse, or use tools.",
    "Return only the final JSON value matching the supplied output schema.",
    ...messages.map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`)
  ].join("\n\n");
}

function toStrictOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeSchemaNode(schema, false) as Record<string, unknown>;
}

function normalizeSchemaNode(node: unknown, nullable: boolean): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => normalizeSchemaNode(item, false));
  }
  if (!node || typeof node !== "object") {
    return node;
  }

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = { ...source };
  if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    const properties = source.properties as Record<string, unknown>;
    const originallyRequired = new Set(Array.isArray(source.required) ? source.required : []);
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, normalizeSchemaNode(value, !originallyRequired.has(key))])
    );
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  if (source.items !== undefined) {
    result.items = normalizeSchemaNode(source.items, false);
  }
  if (Array.isArray(source.anyOf)) {
    result.anyOf = source.anyOf.map((item) => normalizeSchemaNode(item, false));
  }

  if (!nullable) {
    return result;
  }
  if (typeof result.type === "string") {
    result.type = [result.type, "null"];
    if (Array.isArray(result.enum) && !result.enum.includes(null)) {
      result.enum = [...result.enum, null];
    }
    return result;
  }
  if (Array.isArray(result.type) && !result.type.includes("null")) {
    result.type = [...result.type, "null"];
    return result;
  }
  return { anyOf: [result, { type: "null" }] };
}

function appendBounded(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-16_000);
}

function usefulError(value: string): string | undefined {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines.slice(-12).join("\n") : undefined;
}

function repairRequest(request: JsonCompletionRequest, rawText: string): JsonCompletionRequest {
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        role: "assistant",
        content: rawText
      },
      {
        role: "user",
        content: [
          "The previous response was not complete valid JSON.",
          "Return the same answer as complete valid JSON matching the requested schema.",
          "Return only JSON with no markdown, comments, or explanation."
        ].join("\n")
      }
    ],
    maxTokens: Math.min(10_000, Math.max(request.maxTokens * 2, request.maxTokens + 1000)),
    temperature: 0
  };
}

export function cacheKeyFor(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const draftResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intentAnalysis: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: { type: "string", minLength: 1 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        needsClarification: { type: "boolean" },
        speechAct: {
          type: "string",
          enum: ["question", "claim", "announcement", "advice", "opinion", "complaint", "other"]
        },
        claimOrAsk: { type: "string" },
        replyObjective: { type: "string" },
        shouldReply: { type: "boolean" },
        replyWorthiness: { type: "number", minimum: 0, maximum: 100 },
        recommendedStance: {
          type: "string",
          enum: ["answer", "agree-and-add", "clarify", "challenge", "contextualize", "ask", "acknowledge", "abstain"]
        },
        stanceReason: { type: "string" },
        targetContext: { type: "string" },
        parentContext: { type: "string" },
        quotedContext: { type: "string" },
        constraints: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["intent", "confidence", "needsClarification", "constraints"]
    },
    suggestions: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          text: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          strategy: { type: "string" },
          isQuestion: { type: "boolean" }
        },
        required: ["text", "rationale", "confidence"]
      }
    },
    abstained: { type: "boolean" },
    abstainReason: { type: "string" }
  },
  required: ["suggestions"]
} satisfies Record<string, unknown>;

export const tasteDecisionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    shouldReply: { type: "boolean" },
    reason: { type: "string", minLength: 1, maxLength: 240 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    recommendedId: { type: "string" },
    stance: {
      type: "string",
      enum: ["answer", "agree-and-add", "clarify", "challenge", "contextualize", "ask", "acknowledge", "abstain"]
    },
    evaluations: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          suggestionId: { type: "string", minLength: 1 },
          score: { type: "number", minimum: 0, maximum: 100 },
          sourceFit: { type: "number", minimum: 0, maximum: 100 },
          novelty: { type: "number", minimum: 0, maximum: 100 },
          voiceFit: { type: "number", minimum: 0, maximum: 100 },
          restraint: { type: "number", minimum: 0, maximum: 100 },
          reasons: { type: "array", maxItems: 3, items: { type: "string", maxLength: 100 } },
          flags: { type: "array", maxItems: 4, items: { type: "string", maxLength: 60 } }
        },
        required: ["suggestionId", "score", "sourceFit", "novelty", "voiceFit", "restraint", "reasons", "flags"]
      }
    }
  },
  required: ["shouldReply", "reason", "confidence", "evaluations"]
} satisfies Record<string, unknown>;

export const scoreResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    rankedPosts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          score: { type: "number", minimum: 0, maximum: 100 },
          recommendation: { type: "string", enum: ["reply", "quote idea", "save for later", "skip"] },
          reason: { type: "string", minLength: 1, maxLength: 80 },
          suggestedAngle: { type: "string", minLength: 1, maxLength: 80 },
          topicSummary: { type: "string", minLength: 1, maxLength: 80 },
          draftSeed: { type: "string", maxLength: 120 },
          risks: {
            type: "array",
            maxItems: 2,
            items: { type: "string", maxLength: 40 }
          }
        },
        required: ["id", "score", "recommendation", "reason", "suggestedAngle", "topicSummary", "risks"]
      }
    }
  },
  required: ["rankedPosts"]
} satisfies Record<string, unknown>;

export function asDraftResponse(value: unknown): DraftResponse {
  return value as DraftResponse;
}

export function asScoreResponse(value: unknown): ScoreVisiblePostsResponse {
  return value as ScoreVisiblePostsResponse;
}

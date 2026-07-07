import { createHash } from "node:crypto";
import {
  DEFAULT_MODEL,
  estimateTokens,
  estimateTogetherCostUsd,
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
  model?: string;
}

export interface JsonCompletionResult {
  value: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  rawText: string;
  model: string;
}

export interface TogetherClient {
  defaultModel: string;
  completeJson(request: JsonCompletionRequest): Promise<JsonCompletionResult>;
}

export function createTogetherClient(apiKey: string | undefined, model = DEFAULT_MODEL): TogetherClient {
  return {
    defaultModel: model,
    async completeJson(request) {
      if (!apiKey) {
        throw new Error("Missing TOGETHER_API_KEY. Add it to .env.local before generating or scoring.");
      }

      const chosenModel = typeof request.model === "string" && request.model.trim() ? request.model : model;
      const first = await requestJsonCompletion(apiKey, chosenModel, request);
      try {
        return {
          value: parseJsonObject(first.rawText),
          inputTokens: first.inputTokens,
          outputTokens: first.outputTokens,
          costUsd: first.costUsd,
          rawText: first.rawText,
          model: chosenModel
        };
      } catch (error) {
        const repaired = await requestJsonCompletion(apiKey, chosenModel, repairRequest(request, first.rawText));
        try {
          return {
            value: parseJsonObject(repaired.rawText),
            inputTokens: first.inputTokens + repaired.inputTokens,
            outputTokens: first.outputTokens + repaired.outputTokens,
            costUsd: first.costUsd + repaired.costUsd,
            rawText: repaired.rawText,
            model: chosenModel
          };
        } catch {
          throw error;
        }
      }
    }
  };
}

async function requestJsonCompletion(
  apiKey: string,
  model: string,
  request: JsonCompletionRequest
): Promise<Omit<JsonCompletionResult, "value">> {
      const response = await fetch("https://api.together.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.schemaName,
              schema: request.schema
            }
          }
        })
      });

      const body = (await response.json().catch(() => null)) as TogetherResponse | null;
      if (!response.ok) {
        throw new Error(body?.error?.message ?? `Together request failed with HTTP ${response.status}.`);
      }

      const rawText = body?.choices?.[0]?.message?.content;
      if (!rawText) {
        throw new Error("Together response did not include assistant content.");
      }

      const inputTokens = body?.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(request.messages));
      const outputTokens = body?.usage?.completion_tokens ?? estimateTokens(rawText);
      return {
        inputTokens,
        outputTokens,
        costUsd: estimateTogetherCostUsd(inputTokens, outputTokens),
        rawText,
        model
      };
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
    suggestions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          text: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["text", "rationale", "confidence"]
      }
    }
  },
  required: ["suggestions"]
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
          reason: { type: "string", minLength: 1 },
          suggestedAngle: { type: "string", minLength: 1 },
          draftSeed: { type: "string" },
          risks: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["id", "score", "recommendation", "reason", "suggestedAngle", "risks"]
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

interface TogetherResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

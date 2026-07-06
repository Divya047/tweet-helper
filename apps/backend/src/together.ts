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
}

export interface JsonCompletionResult {
  value: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  rawText: string;
}

export interface TogetherClient {
  model: string;
  completeJson(request: JsonCompletionRequest): Promise<JsonCompletionResult>;
}

export function createTogetherClient(apiKey: string | undefined, model = DEFAULT_MODEL): TogetherClient {
  return {
    model,
    async completeJson(request) {
      if (!apiKey) {
        throw new Error("Missing TOGETHER_API_KEY. Add it to .env.local before generating or scoring.");
      }

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
        value: parseJsonObject(rawText),
        inputTokens,
        outputTokens,
        costUsd: estimateTogetherCostUsd(inputTokens, outputTokens),
        rawText
      };
    }
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
      minItems: 3,
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

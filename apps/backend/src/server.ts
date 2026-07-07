import { readFileSync } from "node:fs";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ADVANCED_MODEL,
  DEFAULT_MODEL,
  estimateTokens,
  validateDraftResponse,
  validateScoreVisiblePostsResponse,
  type DraftResponse,
  type FeedbackRequest,
  type GenerateCommentRequest,
  type GeneratePostRequest,
  type ScoreVisiblePostsRequest
} from "@tweet-helper/shared";
import { parseTweetsJs, parseXArchiveZip } from "./archive.js";
import { assertWithinBudget } from "./budget.js";
import { getConfig, loadEnvFiles, type AppConfig } from "./config.js";
import {
  getCachedGeneration,
  getRecentXArchiveExamples,
  getSettings,
  getStyleProfile,
  initializeSettings,
  logUsage,
  normalizeForStorage,
  openDatabase,
  saveCachedGeneration,
  saveFeedback,
  updateSettings,
  upsertWritingExamples,
  type AppDatabase,
  type WritingExample,
  type WritingExampleInput
} from "./db.js";
import { buildCommentMessages, buildPostMessages, buildScoreMessages, type ChatMessage } from "./prompts.js";
import { RECENT_ARCHIVE_EXAMPLE_WINDOW_MS, rebuildStyleProfile, selectStyleExamples } from "./style.js";
import {
  cacheKeyFor,
  createTogetherClient,
  draftResponseSchema,
  scoreResponseSchema,
  type JsonCompletionRequest,
  type JsonCompletionResult,
  type TogetherClient
} from "./together.js";

export interface BuildServerOptions {
  config?: Partial<AppConfig>;
  db?: AppDatabase;
  togetherClient?: TogetherClient;
}

export interface BuiltServer {
  app: FastifyInstance;
  db: AppDatabase;
  config: AppConfig;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<BuiltServer> {
  loadEnvFiles();
  const config = getConfig(options.config);
  const db = options.db ?? openDatabase(config.dbPath);
  initializeSettings(db, {
    model: config.model,
    dailyBudgetUsd: config.dailyBudgetUsd,
    monthlyBudgetUsd: config.monthlyBudgetUsd,
    backendUrl: `http://${config.host}:${config.port}`
  });

  const togetherClient = options.togetherClient ?? createTogetherClient(config.togetherApiKey, config.model);
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "OPTIONS"]
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = /budget/i.test(error.message) ? 402 : error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: {
        message: error.message,
        statusCode
      }
    });
  });

  app.get("/health", async () => ({
    ok: true,
    model: togetherClient.defaultModel,
    settings: getSettings(db)
  }));

  app.get("/api/settings", async () => ({ data: getSettings(db) }));

  app.put<{ Body: Record<string, unknown> }>("/api/settings", async (request) => ({
    data: updateSettings(db, request.body ?? {})
  }));

  app.post<{ Body: ImportArchiveBody }>("/api/import/x-archive", async (request) => {
    const body = request.body ?? {};
    const result = importArchiveInput(body);
    const imported = upsertWritingExamples(db, result.examples);
    const styleProfile = rebuildStyleProfile(db);
    return {
      data: {
        imported,
        filesRead: result.filesRead,
        styleProfile
      }
    };
  });

  app.post<{ Body: GeneratePostRequest }>("/api/generate/post", async (request) => {
    assertNonEmptyString(request.body?.topic, "topic");
    const body = request.body;
    const mode = body.mode === "cheap" ? "cheap" : "standard";
    const requestedModel = body.model === "advanced" ? ADVANCED_MODEL : undefined;
    const styleProfile = getStyleProfile(db);
    const examples = selectStyleExamples(db, `${body.topic} ${body.instructions ?? ""}`, "post");
    const recentArchiveExamples = getRecentXArchiveExamples(db, recentArchiveCutoff());
    const messages = buildPostMessages(body, styleProfile, examples);
    const response = await runCachedJsonGeneration({
      db,
      togetherClient,
      endpoint: "generate_post",
      cacheInput: {
        body,
        styleProfile,
        examples: examples.map((example) => example.id),
        blockedExamples: recentArchiveExamples.map((example) => example.id),
        model: requestedModel ?? "default"
      },
      request: {
        messages,
        schemaName: "DraftResponse",
        schema: draftResponseSchema,
        maxTokens: mode === "cheap" ? 360 : 700,
        temperature: mode === "cheap" ? 0.65 : 0.8,
        ...(requestedModel ? { model: requestedModel } : {})
      },
      validate: (value) => removeRecentArchiveCopies(validateDraftResponse(value), recentArchiveExamples)
    });
    return response;
  });

  app.post<{ Body: GenerateCommentRequest }>("/api/generate/comment", async (request) => {
    assertNonEmptyString(request.body?.sourcePost?.text, "sourcePost.text");
    const body = request.body;
    const mode = body.mode === "cheap" ? "cheap" : "standard";
    const requestedModel = body.model === "advanced" ? ADVANCED_MODEL : undefined;
    const styleProfile = getStyleProfile(db);
    const examples = selectStyleExamples(
      db,
      `${body.sourcePost.text} ${body.angle ?? ""} ${body.instructions ?? ""}`,
      "comment"
    );
    const recentArchiveExamples = getRecentXArchiveExamples(db, recentArchiveCutoff());
    const messages = buildCommentMessages(body, styleProfile, examples);
    const response = await runCachedJsonGeneration({
      db,
      togetherClient,
      endpoint: "generate_comment",
      cacheInput: {
        body,
        styleProfile,
        examples: examples.map((example) => example.id),
        blockedExamples: recentArchiveExamples.map((example) => example.id),
        model: requestedModel ?? "default"
      },
      request: {
        messages,
        schemaName: "DraftResponse",
        schema: draftResponseSchema,
        maxTokens: mode === "cheap" ? 340 : 650,
        temperature: mode === "cheap" ? 0.6 : 0.75,
        ...(requestedModel ? { model: requestedModel } : {})
      },
      validate: (value) => removeRecentArchiveCopies(validateDraftResponse(value), recentArchiveExamples)
    });
    return response;
  });

  app.post<{ Body: ScoreVisiblePostsRequest }>("/api/score/visible-posts", async (request) => {
    const posts = request.body?.posts ?? [];
    if (!Array.isArray(posts) || posts.length === 0) {
      throw new Error("posts must include at least one visible post.");
    }
    const sanitizedPosts = posts
      .filter((post) => typeof post.text === "string" && post.text.trim())
      .slice(0, 20)
      .map((post, index) => ({
        ...post,
        id: post.id?.trim() || `visible-${index}`,
        text: post.text.trim()
      }));
    const body: ScoreVisiblePostsRequest = { posts: sanitizedPosts };
    const styleProfile = getStyleProfile(db);
    const examples = selectStyleExamples(
      db,
      sanitizedPosts.map((post) => post.text).join("\n"),
      "comment",
      10
    );
    const messages = buildScoreMessages(body, styleProfile, examples);
    const response = await runCachedJsonGeneration({
      db,
      togetherClient,
      endpoint: "score_visible_posts",
      cacheInput: { body, styleProfile, examples: examples.map((example) => example.id) },
      request: {
        messages,
        schemaName: "ScoreVisiblePostsResponse",
        schema: scoreResponseSchema,
        maxTokens: 1800,
        temperature: 0.35
      },
      validate: validateScoreVisiblePostsResponse
    });
    return response;
  });

  app.post<{ Body: FeedbackRequest }>("/api/feedback", async (request) => {
    const body = request.body;
    assertNonEmptyString(body?.suggestionId, "suggestionId");
    assertNonEmptyString(body?.kind, "kind");
    assertNonEmptyString(body?.decision, "decision");
    const feedbackInput = {
      suggestionId: body.suggestionId,
      kind: body.kind,
      decision: body.decision,
      ...(body.originalText ? { originalText: body.originalText } : {}),
      ...(body.finalText ? { finalText: body.finalText } : {}),
      ...(body.context ? { contextJson: JSON.stringify(body.context) } : {})
    };
    const id = saveFeedback(db, feedbackInput);

    let learned = false;
    if ((body.decision === "accepted" || body.decision === "edited") && body.finalText?.trim()) {
      const example: WritingExampleInput = {
        id: `feedback:${id}`,
        kind: body.kind,
        text: body.finalText.trim(),
        source: "feedback"
      };
      upsertWritingExamples(db, [example]);
      rebuildStyleProfile(db);
      learned = true;
    }

    return { data: { id, learned } };
  });

  return { app, db, config };
}

interface ImportArchiveBody {
  archivePath?: string;
  archiveBase64?: string;
  tweetsJsText?: string;
}

interface ImportArchiveParsed {
  examples: WritingExampleInput[];
  filesRead: string[];
}

function importArchiveInput(body: ImportArchiveBody): ImportArchiveParsed {
  if (body.tweetsJsText) {
    return { examples: parseTweetsJs(body.tweetsJsText), filesRead: ["request:tweetsJsText"] };
  }
  if (body.archiveBase64) {
    const buffer = Buffer.from(body.archiveBase64, "base64");
    return parseXArchiveZip(new Uint8Array(buffer));
  }
  if (body.archivePath) {
    const buffer = readFileSync(body.archivePath);
    return parseXArchiveZip(new Uint8Array(buffer));
  }
  throw new Error("Provide archivePath, archiveBase64, or tweetsJsText.");
}

function recentArchiveCutoff(): string {
  return new Date(Date.now() - RECENT_ARCHIVE_EXAMPLE_WINDOW_MS).toISOString();
}

function removeRecentArchiveCopies(response: DraftResponse, recentExamples: WritingExample[]): DraftResponse {
  if (recentExamples.length === 0) {
    return response;
  }

  const blockedTexts = new Set(recentExamples.map((example) => normalizeForStorage(example.text)).filter(Boolean));
  const suggestions = response.suggestions.filter((suggestion) => !blockedTexts.has(normalizeForStorage(suggestion.text)));
  if (suggestions.length === 0) {
    throw new Error("Generated drafts copied recent archive tweets. Try again with more specific instructions.");
  }
  return { suggestions };
}

async function runCachedJsonGeneration<T>(options: {
  db: AppDatabase;
  togetherClient: TogetherClient;
  endpoint: string;
  cacheInput: unknown;
  request: JsonCompletionRequest;
  validate: (value: unknown) => T;
}): Promise<{
  data: T;
  meta: {
    cached: boolean;
    model: string;
    estimatedCostUsd: number;
    inputTokens: number;
    outputTokens: number;
  };
}> {
  const model = getSettings(options.db).model;
  const cacheKey = cacheKeyFor({
    model: typeof options.request.model === "string" ? options.request.model : typeof model === "string" ? model : DEFAULT_MODEL,
    endpoint: options.endpoint,
    input: options.cacheInput
  });

  const cached = getCachedGeneration(options.db, cacheKey);
  if (cached) {
    return {
      data: options.validate(JSON.parse(cached.responseJson)),
      meta: {
        cached: true,
        model: typeof options.request.model === "string" ? options.request.model : options.togetherClient.defaultModel,
        estimatedCostUsd: cached.costUsd,
        inputTokens: cached.inputTokens,
        outputTokens: cached.outputTokens
      }
    };
  }

  const inputTokens = estimateTokens(messagesToTokenText(options.request.messages));
  assertWithinBudget(options.db, inputTokens, options.request.maxTokens);
  const completion = await options.togetherClient.completeJson(options.request);
  const data = options.validate(completion.value);
  saveCachedGeneration(
    options.db,
    cacheKey,
    JSON.stringify(data),
    completion.inputTokens,
    completion.outputTokens,
    completion.costUsd
  );
  logUsage(options.db, options.endpoint, cacheKey, completion.inputTokens, completion.outputTokens, completion.costUsd);
  return {
    data,
    meta: {
      cached: false,
      model: completion.model,
      estimatedCostUsd: completion.costUsd,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens
    }
  };
}

export function createMockTogetherClient(
  responseFactory: (request: JsonCompletionRequest) => unknown
): TogetherClient {
  return {
    defaultModel: DEFAULT_MODEL,
    async completeJson(request: JsonCompletionRequest): Promise<JsonCompletionResult> {
      const value = responseFactory(request);
      const rawText = JSON.stringify(value);
      return {
        value,
        inputTokens: estimateTokens(messagesToTokenText(request.messages)),
        outputTokens: estimateTokens(rawText),
        costUsd: 0,
        rawText,
        model: typeof request.model === "string" && request.model.trim() ? request.model : DEFAULT_MODEL
      };
    }
  };
}

function messagesToTokenText(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
}

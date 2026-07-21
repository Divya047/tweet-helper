import { readFileSync } from "node:fs";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ADVANCED_MODEL,
  DEFAULT_MODEL,
  estimateTokens,
  validateGenerateRewriteRequest,
  enrichTopicSummaries,
  suppressCommentBaitScores,
  validateDraftResponse,
  validateScoreVisiblePostsResponse,
  type DraftResponse,
  type FeedbackRequest,
  type GenerateCommentRequest,
  type GeneratePostRequest,
  type GenerateRewriteRequest,
  type IntentAnalysis,
  type OutcomeRequest,
  type ScoreVisiblePostsRequest
} from "@tweet-helper/shared";
import { parseTweetsJs, parseXArchiveZip } from "./archive.js";
import { assertWithinBudget } from "./budget.js";
import { getConfig, loadEnvFiles, type AppConfig } from "./config.js";
import {
  getCachedGeneration,
  appendWorkItems,
  createWorkSession,
  deleteWorkSession,
  getTodayProgress,
  getOutcomeByIdempotencyKey,
  ensureCapturedWorkItem,
  getWorkSession,
  listWorkSessions,
  reconcileArchiveOutcomes,
  saveOutcome,
  updateWorkItem,
  updateWorkSession,
  getRecentXArchiveExamples,
  getPairedReplyExamples,
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
import {
  buildCommentMessages,
  buildPostMessages,
  buildRewriteMessages,
  buildScoreMessages,
  type ChatMessage
} from "./prompts.js";
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
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!config.mobileAuthToken || request.method === "OPTIONS" || !isProtectedApiPath(request.url)) {
      return;
    }
    if (request.headers.authorization !== `Bearer ${config.mobileAuthToken}`) {
      return reply.status(401).send({
        error: {
          message: "Missing or invalid bearer token.",
          statusCode: 401
        }
      });
    }
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
    ok: true
  }));

  app.get("/api/settings", async () => ({ data: getSettings(db) }));

  app.put<{ Body: Record<string, unknown> }>("/api/settings", async (request) => ({
    data: updateSettings(db, request.body ?? {})
  }));

  app.post<{ Body: ImportArchiveBody }>("/api/import/x-archive", async (request) => {
    const body = request.body ?? {};
    const result = importArchiveInput(body);
    const imported = upsertWritingExamples(db, result.examples);
    const reconciledOutcomes = reconcileArchiveOutcomes(db, result.examples);
    const styleProfile = rebuildStyleProfile(db);
    return {
      data: {
        imported,
        filesRead: result.filesRead,
        styleProfile,
        reconciledOutcomes
      }
    };
  });

  app.post<{ Body: GeneratePostRequest }>("/api/generate/post", async (request) => {
    assertNonEmptyString(request.body?.topic, "topic");
    const body = request.body;
    const mode = body.mode === "cheap" ? "cheap" : "standard";
    const requestedModel = mode === "cheap" || body.model === "standard" ? undefined : ADVANCED_MODEL;
    const styleProfile = getStyleProfile(db);
    const analysis = await analyzeIntent(db,togetherClient,body.topic);
    const examples = selectStyleExamples(db, `${body.topic} ${body.instructions ?? ""}`, "post");
    const recentArchiveExamples = getRecentXArchiveExamples(db, recentArchiveCutoff());
    const messages = buildPostMessages(body, styleProfile, examples);
    const response = await runCachedJsonGeneration({
      db,
      togetherClient,
      endpoint: "generate_post",
      cacheable: false,
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
      validate: (value) => enrichDraftResponse(removeRecentArchiveCopies(validateDraftResponse(value), recentArchiveExamples),body.topic,undefined,analysis)
    });
    return response;
  });

  app.post<{ Body: GenerateCommentRequest }>("/api/generate/comment", async (request) => {
    assertNonEmptyString(request.body?.sourcePost?.text, "sourcePost.text");
    const body = request.body;
    const mode = body.mode === "cheap" ? "cheap" : "standard";
    const requestedModel = mode === "cheap" || body.model === "standard" ? undefined : ADVANCED_MODEL;
    const styleProfile = getStyleProfile(db);
    // Heuristic intent only — a second LLM round-trip made reply drafting feel stuck.
    const analysis = heuristicIntent(body.sourcePost.text, body.sourcePost);
    const examples = selectStyleExamples(
      db,
      `${body.sourcePost.text} ${body.angle ?? ""} ${body.instructions ?? ""}`,
      "comment"
    );
    const pairedExamples=getPairedReplyExamples(db,body.sourcePost.text);
    const recentArchiveExamples = getRecentXArchiveExamples(db, recentArchiveCutoff());
    const messages = buildCommentMessages(body, styleProfile, examples,pairedExamples);
    const response = await runCachedJsonGeneration({
      db,
      togetherClient,
      endpoint: "generate_comment",
      cacheable: false,
      cacheInput: {
        body,
        styleProfile,
        examples: examples.map((example) => example.id),
        pairedExamples,
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
      validate: (value) => enrichDraftResponse(removeRecentArchiveCopies(validateDraftResponse(value), recentArchiveExamples),body.sourcePost.text,body.sourcePost,analysis)
    });
    return response;
  });

  app.post<{ Body: GenerateRewriteRequest }>("/api/generate/rewrite", async (request) => {
    const body = validateGenerateRewriteRequest(request.body);
    const mode = body.mode === "cheap" ? "cheap" : "standard";
    const requestedModel = mode === "cheap" || body.model === "standard" ? undefined : ADVANCED_MODEL;
    const styleProfile = getStyleProfile(db);
    const analysis = await analyzeIntent(db,togetherClient,body.text);
    const examples = selectStyleExamples(db, `${body.text} ${body.instructions ?? ""}`, body.kind);
    const recentArchiveExamples = getRecentXArchiveExamples(db, recentArchiveCutoff());
    const messages = buildRewriteMessages(body, styleProfile, examples);
    const response = await runCachedJsonGeneration({
      db,
      togetherClient,
      endpoint: "generate_rewrite",
      cacheable: false,
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
        temperature: mode === "cheap" ? 0.55 : 0.7,
        ...(requestedModel ? { model: requestedModel } : {})
      },
      validate: (value) => enrichDraftResponse(removeRecentArchiveCopies(validateDraftResponse(value), recentArchiveExamples),body.text,undefined,analysis)
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
      .slice(0, 16)
      .map((post, index) => ({
        ...post,
        id: post.id?.trim() || `visible-${index}`,
        text: post.text.trim()
      }));
    const audience = typeof request.body?.audience === "string" ? request.body.audience.trim() : "";
    const contentPillar = typeof request.body?.contentPillar === "string" ? request.body.contentPillar.trim() : "";
    const desiredOutcome = typeof request.body?.desiredOutcome === "string" ? request.body.desiredOutcome.trim() : "";
    const body: ScoreVisiblePostsRequest = {
      posts: sanitizedPosts,
      ...(audience ? { audience } : {}),
      ...(contentPillar ? { contentPillar } : {}),
      ...(desiredOutcome ? { desiredOutcome } : {})
    };
    const styleProfile = getStyleProfile(db);
    const examples = selectStyleExamples(
      db,
      sanitizedPosts.map((post) => post.text).join("\n"),
      "comment",
      3
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
        maxTokens: 1000,
        temperature: 0.2,
        timeoutMs: 90_000
      },
      validate: validateScoreVisiblePostsResponse
    });
    return {
      ...response,
      data: {
        rankedPosts: enrichTopicSummaries(
          suppressCommentBaitScores(response.data.rankedPosts, sanitizedPosts),
          sanitizedPosts
        )
      }
    };
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

  app.post<{ Body: { title?: string; softGoal?: number } }>("/api/work-sessions", async (request) => ({ data: createWorkSession(db, request.body ?? {}) }));
  app.get<{ Querystring: { includeArchived?: string } }>("/api/work-sessions", async (request) => ({ data: listWorkSessions(db, request.query?.includeArchived === "true") }));
  app.get<{ Params: { id: string } }>("/api/work-sessions/:id", async (request, reply) => {
    const session = getWorkSession(db, request.params.id);
    return session ? { data: session } : reply.status(404).send({error:{message:"Work session not found.",statusCode:404}});
  });
  app.patch<{ Params: { id: string }; Body: { title?: string; status?: "active"|"completed"|"archived"; softGoal?: number } }>("/api/work-sessions/:id", async (request, reply) => {
    const session = updateWorkSession(db, request.params.id, request.body ?? {});
    return session ? {data:session} : reply.status(404).send({error:{message:"Work session not found.",statusCode:404}});
  });
  app.delete<{ Params: { id: string } }>("/api/work-sessions/:id", async (request, reply) => deleteWorkSession(db,request.params.id) ? reply.status(204).send() : reply.status(404).send({error:{message:"Work session not found.",statusCode:404}}));

  app.post<{ Params: { id: string }; Body: { posts?: GenerateCommentRequest["sourcePost"][] } }>("/api/work-sessions/:id/items", async (request) => {
    if (!getWorkSession(db,request.params.id)) throw Object.assign(new Error("Work session not found."),{statusCode:404});
    const posts=(request.body?.posts ?? []).filter((post) => typeof post?.text === "string" && post.text.trim()).slice(0,24);
    if (!posts.length) throw new Error("posts must include at least one source post.");
    return {data:appendWorkItems(db,request.params.id,posts)};
  });
  app.post<{ Params: { id: string }; Body: { posts?: GenerateCommentRequest["sourcePost"][] } }>("/api/work-sessions/:id/batch", async (request) => {
    if (!getWorkSession(db,request.params.id)) throw Object.assign(new Error("Work session not found."),{statusCode:404});
    const posts=selectEightPostBatch(request.body?.posts ?? []);
    return {data:{items:appendWorkItems(db,request.params.id,posts),questionCount:posts.filter(isEasyQuestion).length}};
  });
  app.patch<{ Params: { id: string }; Body: { status?: "pending"|"drafted"|"used"|"published"|"skipped"; recommendation?: string; score?: number; draftResponse?: unknown } }>("/api/work-items/:id", async (request, reply) => {
    const item=updateWorkItem(db,request.params.id,request.body ?? {});
    return item ? {data:item} : reply.status(404).send({error:{message:"Work item not found.",statusCode:404}});
  });
  app.post<{ Params: { id:string }; Body: { kind?: "used"|"published"; idempotencyKey?:string; text?:string; externalId?:string } }>("/api/work-items/:id/outcomes",async(request)=>{
    if (request.body?.kind !== "used" && request.body?.kind !== "published") throw new Error("kind must be used or published.");
    assertNonEmptyString(request.body.idempotencyKey,"idempotencyKey");
    return {data:saveOutcome(db,{workItemId:request.params.id,kind:request.body.kind,idempotencyKey:request.body.idempotencyKey,...(request.body.text?{text:request.body.text}:{}),...(request.body.externalId?{externalId:request.body.externalId}:{})})};
  });
  app.post<{ Body: OutcomeRequest }>("/api/outcomes", async (request) => {
    const body = request.body;
    if (body?.status !== "used" && body?.status !== "published") throw new Error("status must be used or published.");
    if (body.platform !== "chrome" && body.platform !== "ios") throw new Error("platform must be chrome or ios.");
    assertNonEmptyString(body.finalText, "finalText");
    assertNonEmptyString(body.clientEventId, "clientEventId");
    const existing = getOutcomeByIdempotencyKey(db, body.clientEventId);
    if (existing) return { data: { outcome: existing, created: false } };
    const contextSource = body.context && typeof body.context === "object" && "target" in body.context
      ? (body.context.target as GenerateCommentRequest["sourcePost"] | undefined)
      : undefined;
    const sourcePost = contextSource?.text
      ? contextSource
      : { text: body.sourceText?.trim() || body.finalText.trim(), ...(body.sourceURL ? { url: body.sourceURL } : {}) };
    const item = ensureCapturedWorkItem(db, {
      ...(body.workId ? { workItemId: body.workId } : {}),
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      sourcePost
    });
    const outcomeContext = {
      ...(body.context ?? {}),
      ...(body.contentKind ? { contentKind: body.contentKind } : {})
    };
    const result = saveOutcome(db, {
      workItemId: item.id,
      kind: body.status,
      idempotencyKey: body.clientEventId,
      text: body.finalText.trim(),
      platform: body.platform,
      ...(body.externalId ? { externalId: body.externalId } : {}),
      context: outcomeContext,
      ...(body.contentKind ? { contentKind: body.contentKind } : {})
    });
    if (result.created) rebuildStyleProfile(db);
    return { data: result };
  });
  app.get("/api/progress/today",async()=>({data:getTodayProgress(db)}));

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

function isProtectedApiPath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return path.startsWith("/api/generate/") || path.startsWith("/api/work-") || path.startsWith("/api/progress/") || path === "/api/outcomes" || path === "/api/feedback" || path === "/api/settings";
}

function isEasyQuestion(post: GenerateCommentRequest["sourcePost"]): boolean {
  const text=post.text.toLowerCase();
  return text.includes("?") && /\b(you|your|favorite|prefer|experience|recommend|which|what|how)\b/.test(text);
}

export function selectEightPostBatch(posts: GenerateCommentRequest["sourcePost"][]): GenerateCommentRequest["sourcePost"][] {
  const valid=posts.filter((post)=>typeof post?.text === "string" && post.text.trim());
  const questions=valid.filter(isEasyQuestion).slice(0,4);
  const desired=Math.min(4,Math.max(3,questions.length));
  const selected=questions.slice(0,desired);
  const selectedKeys=new Set(selected.map((post)=>post.id ?? post.text));
  for (const post of valid) {
    if (selected.length >= 8) break;
    const key=post.id ?? post.text;
    if (!selectedKeys.has(key)) {selected.push(post);selectedKeys.add(key);}
  }
  return selected.slice(0,8);
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

function enrichDraftResponse(response: DraftResponse, input: string, source?: GenerateCommentRequest["sourcePost"], analyzed?: IntentAnalysis): DraftResponse {
  const words=normalizeForStorage(input).split(" ").filter(Boolean);
  const confidence=Math.min(0.95,Math.max(0.25,words.length/12));
  const labels=["Recommended","Specific","Constructive tension","Experience question","Concise practical"];
  const suggestions=response.suggestions;
  const recommendation=response.recommendation ?? suggestions[0];
  return {
    ...response,
    ...(recommendation ? {recommendation}:{}),
    explore:response.explore ?? suggestions.slice(1,5),
    intentAnalysis:analyzed ?? {intent:words.slice(0,8).join(" ") || "unclear",confidence,needsClarification:confidence<0.5,
      ...(source?{targetContext:source.text}:{}),...(source?.parentPost?{parentContext:source.parentPost.text}:{}),...(source?.quotedPost?{quotedContext:source.quotedPost.text}:{}),constraints:[]},
    strategies:suggestions.slice(0,5).map((suggestion,index)=>({id:`strategy-${suggestion.id}`,label:labels[index] ?? `Explore ${index}`,angle:suggestion.rationale,tone:index===0?"on-brand":"exploratory",exploratory:index>0}))
  };
}

async function analyzeIntent(db: AppDatabase, togetherClient: TogetherClient, input: string, source?: GenerateCommentRequest["sourcePost"]): Promise<IntentAnalysis> {
  const fallback = () => heuristicIntent(input, source);
  try {
    const result=await runCachedJsonGeneration({db,togetherClient,endpoint:"analyze_intent",cacheInput:{input,source},request:{model:DEFAULT_MODEL,messages:[
      {role:"system",content:"Analyze intent and draft strategy. Separate target, parent, and quoted context. Mark needsClarification when confidence is below 0.5. Return JSON only."},
      {role:"user",content:JSON.stringify({input,source})}],schemaName:"IntentAnalysis",schema:{type:"object",properties:{intent:{type:"string"},confidence:{type:"number"},needsClarification:{type:"boolean"},targetContext:{type:"string"},parentContext:{type:"string"},quotedContext:{type:"string"},constraints:{type:"array",items:{type:"string"}}},required:["intent","confidence","needsClarification","constraints"]},maxTokens:350,temperature:.2},validate:(value)=>{
        if (!value || typeof value !== "object") return fallback(); const item=value as Record<string,unknown>;
        if (typeof item.intent !== "string" || typeof item.confidence !== "number") return fallback();
        return {intent:item.intent,confidence:Math.max(0,Math.min(1,item.confidence)),needsClarification:item.needsClarification===true || item.confidence<.5,constraints:Array.isArray(item.constraints)?item.constraints.filter((x):x is string=>typeof x==="string"):[],...(typeof item.targetContext==="string"?{targetContext:item.targetContext}:{}),...(typeof item.parentContext==="string"?{parentContext:item.parentContext}:{}),...(typeof item.quotedContext==="string"?{quotedContext:item.quotedContext}:{})};
      }});
    return result.data;
  } catch {
    return fallback();
  }
}

function heuristicIntent(input: string, source?: GenerateCommentRequest["sourcePost"]): IntentAnalysis {
  const words = normalizeForStorage(input).split(" ").filter(Boolean);
  const confidence = Math.min(0.95, Math.max(0.25, words.length / 12));
  return {
    intent: words.slice(0, 8).join(" ") || "unclear",
    confidence,
    needsClarification: confidence < 0.5,
    ...(source ? { targetContext: source.text } : {}),
    ...(source?.parentPost ? { parentContext: source.parentPost.text } : {}),
    ...(source?.quotedPost ? { quotedContext: source.quotedPost.text } : {}),
    constraints: []
  };
}

async function runCachedJsonGeneration<T>(options: {
  db: AppDatabase;
  togetherClient: TogetherClient;
  endpoint: string;
  cacheInput: unknown;
  request: JsonCompletionRequest;
  validate: (value: unknown) => T;
  cacheable?: boolean;
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

  const cached = options.cacheable === false ? undefined : getCachedGeneration(options.db, cacheKey);
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
  if (options.cacheable !== false) {
    saveCachedGeneration(options.db,cacheKey,JSON.stringify(data),completion.inputTokens,completion.outputTokens,completion.costUsd);
  }
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

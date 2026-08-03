import { readFileSync } from "node:fs";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import {
  DEFAULT_MODEL,
  estimateTokens,
  validateGenerateRewriteRequest,
  enrichTopicSummaries,
  suppressCommentBaitScores,
  parseIntentAnalysis,
  validateDraftResponse,
  validateCompleteScoreVisiblePostsResponse,
  type DraftResponse,
  type FeedbackRequest,
  type GenerateCommentRequest,
  type GeneratePostRequest,
  type GenerateRewriteRequest,
  type IntentAnalysis,
  type OutcomeRequest,
  type ReplyStance,
  type ScoreVisiblePostsRequest,
  type TasteDecision
} from "@tweet-helper/shared";
import { parseTweetsJs, parseXArchiveZip } from "./archive.js";
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
  buildTasteJudgeMessages,
  type ChatMessage
} from "./prompts.js";
import {
  RECENT_ARCHIVE_EXAMPLE_WINDOW_MS,
  getPersonalTasteProfile,
  rebuildPersonalTasteProfile,
  rebuildStyleProfile,
  selectStyleExamples
} from "./style.js";
import {
  cacheKeyFor,
  createCodexClient,
  draftResponseSchema,
  scoreResponseSchema,
  tasteDecisionSchema,
  type JsonCompletionRequest,
  type JsonCompletionResult,
  type CodexClient
} from "./codex.js";

export interface BuildServerOptions {
  config?: Partial<AppConfig>;
  db?: AppDatabase;
  codexClient?: CodexClient;
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
    model: DEFAULT_MODEL,
    dailyBudgetUsd: config.dailyBudgetUsd,
    monthlyBudgetUsd: config.monthlyBudgetUsd,
    backendUrl: `http://${config.host}:${config.port}`
  });

  const codexClient = options.codexClient ?? createCodexClient({ command: config.codexCliPath });
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

  app.get("/api/taste-profile", async () => ({ data: getPersonalTasteProfile(db) }));

  app.post<{ Body: ImportArchiveBody }>("/api/import/x-archive", async (request) => {
    const body = request.body ?? {};
    const result = importArchiveInput(body);
    const imported = upsertWritingExamples(db, result.examples);
    const reconciledOutcomes = reconcileArchiveOutcomes(db, result.examples);
    const styleProfile = rebuildStyleProfile(db);
    const tasteProfile = rebuildPersonalTasteProfile(db);
    return {
      data: {
        imported,
        filesRead: result.filesRead,
        styleProfile,
        tasteProfile,
        reconciledOutcomes
      }
    };
  });

  app.post<{ Body: GeneratePostRequest }>("/api/generate/post", async (request) => {
    assertNonEmptyString(request.body?.topic, "topic");
    const body = request.body;
    const mode = body.mode === "cheap" ? "cheap" : "standard";
    const styleProfile = getStyleProfile(db);
    const analysis = await analyzeIntent(db,codexClient,body.topic);
    const examples = selectStyleExamples(db, `${body.topic} ${body.instructions ?? ""}`, "post");
    const recentArchiveExamples = getRecentXArchiveExamples(db, recentArchiveCutoff());
    const messages = buildPostMessages(body, styleProfile, examples);
    const response = await runCachedJsonGeneration({
      db,
      codexClient,
      endpoint: "generate_post",
      cacheable: false,
      cacheInput: {
        body,
        styleProfile,
        examples: examples.map((example) => example.id),
        blockedExamples: recentArchiveExamples.map((example) => example.id),
        model: DEFAULT_MODEL
      },
      request: {
        messages,
        schemaName: "DraftResponse",
        schema: draftResponseSchema,
        maxTokens: mode === "cheap" ? 360 : 700,
        temperature: mode === "cheap" ? 0.65 : 0.8
      },
      validate: (value) => enrichDraftResponse(removeRecentArchiveCopies(validateDraftResponse(value), recentArchiveExamples),body.topic,undefined,analysis)
    });
    return response;
  });

  app.post<{ Body: GenerateCommentRequest }>("/api/generate/comment", async (request) => {
    assertNonEmptyString(request.body?.sourcePost?.text, "sourcePost.text");
    const body = request.body;
    const mode = body.mode === "cheap" ? "cheap" : "standard";
    const styleProfile = getStyleProfile(db);
    const tasteProfile = getPersonalTasteProfile(db);
    // Short separate pass: understand the source before drafting replies.
    const analysis = await analyzeIntent(db, codexClient, body.sourcePost.text, body.sourcePost, tasteProfile);
    const examples = selectStyleExamples(
      db,
      `${body.sourcePost.text} ${body.angle ?? ""} ${body.instructions ?? ""}`,
      "comment"
    );
    const pairedExamples=getPairedReplyExamples(db,body.sourcePost.text);
    const recentArchiveExamples = getRecentXArchiveExamples(db, recentArchiveCutoff());
    const messages = buildCommentMessages(body, styleProfile, examples, pairedExamples, analysis, tasteProfile);
    const generated = await runCachedJsonGeneration({
      db,
      codexClient,
      endpoint: "generate_comment",
      cacheable: false,
      cacheInput: {
        body,
        styleProfile,
        examples: examples.map((example) => example.id),
        pairedExamples,
        blockedExamples: recentArchiveExamples.map((example) => example.id),
        intent: analysis,
        model: DEFAULT_MODEL
      },
      request: {
        messages,
        schemaName: "DraftResponse",
        schema: draftResponseSchema,
        maxTokens: mode === "cheap" ? 620 : 760,
        imageUrls: imageUrlsForSource(body.sourcePost),
        temperature: mode === "cheap" ? 0.6 : 0.75
      },
      validate: (value) =>
        enrichDraftResponse(
          removeRecentArchiveCopies(validateDraftResponse(value), recentArchiveExamples),
          body.sourcePost.text,
          body.sourcePost,
          analysis
        )
    });
    const judged = await judgeReplyTaste(db, codexClient, body, analysis, tasteProfile, generated.data);
    return {
      data: applyTasteDecision(generated.data, judged.data, analysis),
      meta: combineGenerationMeta(generated.meta, judged.meta)
    };
  });

  app.post<{ Body: GenerateRewriteRequest }>("/api/generate/rewrite", async (request) => {
    const body = validateGenerateRewriteRequest(request.body);
    const mode = body.mode === "cheap" ? "cheap" : "standard";
    const styleProfile = getStyleProfile(db);
    const analysis = await analyzeIntent(db,codexClient,body.text);
    const examples = selectStyleExamples(db, `${body.text} ${body.instructions ?? ""}`, body.kind);
    const recentArchiveExamples = getRecentXArchiveExamples(db, recentArchiveCutoff());
    const messages = buildRewriteMessages(body, styleProfile, examples);
    const response = await runCachedJsonGeneration({
      db,
      codexClient,
      endpoint: "generate_rewrite",
      cacheable: false,
      cacheInput: {
        body,
        styleProfile,
        examples: examples.map((example) => example.id),
        blockedExamples: recentArchiveExamples.map((example) => example.id),
        model: DEFAULT_MODEL
      },
      request: {
        messages,
        schemaName: "DraftResponse",
        schema: draftResponseSchema,
        maxTokens: mode === "cheap" ? 340 : 650,
        temperature: mode === "cheap" ? 0.55 : 0.7
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
      .slice(0, 24)
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
      codexClient,
      endpoint: "score_visible_posts",
      cacheInput: { body, styleProfile, examples: examples.map((example) => example.id) },
      request: {
        messages,
        schemaName: "ScoreVisiblePostsResponse",
        schema: scoreResponseSchemaForCount(sanitizedPosts.length),
        maxTokens: Math.max(1200, sanitizedPosts.length * 140),
        imageUrls: imageUrlsForPosts(sanitizedPosts),
        temperature: 0.2,
        timeoutMs: 90_000
      },
      validate: (value) => validateCompleteScoreVisiblePostsResponse(
        value,
        sanitizedPosts.map((post) => post.id!)
      )
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
    // Only a manual edit is evidence of the user's own wording. An accepted
    // generated draft still informs taste, but must not become style training.
    if (body.decision === "edited" && body.finalText?.trim()) {
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
    rebuildPersonalTasteProfile(db);

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
    if (result.created) {
      rebuildStyleProfile(db);
      rebuildPersonalTasteProfile(db);
    }
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
  return path.startsWith("/api/generate/") || path.startsWith("/api/work-") || path.startsWith("/api/progress/") || path === "/api/outcomes" || path === "/api/feedback" || path === "/api/settings" || path === "/api/taste-profile";
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
  return {
    ...response,
    suggestions
  };
}

function withSourceContext(
  analysis: IntentAnalysis | undefined,
  source?: GenerateCommentRequest["sourcePost"]
): IntentAnalysis | undefined {
  if (!analysis) return undefined;
  if (!source) return analysis;
  return {
    ...analysis,
    targetContext: analysis.targetContext?.trim() || source.text,
    ...(source.parentPost
      ? { parentContext: analysis.parentContext?.trim() || source.parentPost.text }
      : analysis.parentContext
        ? { parentContext: analysis.parentContext }
        : {}),
    ...(source.quotedPost
      ? { quotedContext: analysis.quotedContext?.trim() || source.quotedPost.text }
      : analysis.quotedContext
        ? { quotedContext: analysis.quotedContext }
        : {})
  };
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

async function judgeReplyTaste(
  db: AppDatabase,
  codexClient: CodexClient,
  body: GenerateCommentRequest,
  analysis: IntentAnalysis,
  tasteProfile: ReturnType<typeof getPersonalTasteProfile>,
  response: DraftResponse
) {
  const fallback = () => fallbackTasteDecision(response, analysis);
  if (response.suggestions.length === 0) {
    return {
      data: fallback(),
      meta: emptyGenerationMeta(codexClient.defaultModel)
    };
  }
  try {
    return await runCachedJsonGeneration({
      db,
      codexClient,
      endpoint: "judge_reply_taste",
      cacheable: false,
      cacheInput: {
        body,
        analysis,
        tasteProfile,
        suggestions: response.suggestions
      },
      request: {
        messages: buildTasteJudgeMessages(body, analysis, response.suggestions, tasteProfile),
        schemaName: "TasteDecision",
        schema: tasteDecisionSchema,
        maxTokens: 700,
        imageUrls: imageUrlsForSource(body.sourcePost),
        temperature: 0.1
      },
      validate: (value) => parseTasteDecision(value, response, analysis) ?? fallback()
    });
  } catch {
    return {
      data: fallback(),
      meta: emptyGenerationMeta(codexClient.defaultModel)
    };
  }
}

function parseTasteDecision(
  value: unknown,
  response: DraftResponse,
  analysis: IntentAnalysis
): TasteDecision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.shouldReply !== "boolean" || typeof item.reason !== "string" || !Array.isArray(item.evaluations)) {
    return undefined;
  }
  const candidateIds = new Set(response.suggestions.map((suggestion) => suggestion.id));
  const evaluations = item.evaluations.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const evaluation = raw as Record<string, unknown>;
    if (typeof evaluation.suggestionId !== "string" || !candidateIds.has(evaluation.suggestionId)) return [];
    const score = boundedNumber(evaluation.score, 0, 100);
    if (score === undefined) return [];
    return [{
      suggestionId: evaluation.suggestionId,
      score,
      sourceFit: boundedNumber(evaluation.sourceFit, 0, 100) ?? score,
      novelty: boundedNumber(evaluation.novelty, 0, 100) ?? score,
      voiceFit: boundedNumber(evaluation.voiceFit, 0, 100) ?? score,
      restraint: boundedNumber(evaluation.restraint, 0, 100) ?? score,
      reasons: stringArray(evaluation.reasons, 3),
      flags: stringArray(evaluation.flags, 4)
    }];
  });
  if (!evaluations.length) return undefined;
  const best = [...evaluations].sort((left, right) => right.score - left.score)[0]!;
  const stances: readonly ReplyStance[] = [
    "answer", "agree-and-add", "clarify", "challenge", "contextualize", "ask", "acknowledge", "abstain"
  ];
  const stance =
    typeof item.stance === "string" && stances.includes(item.stance as ReplyStance)
      ? (item.stance as ReplyStance)
      : analysis.recommendedStance;
  const recommendedScore = best.score;
  const shouldReply =
    item.shouldReply
    && analysis.shouldReply !== false
    && recommendedScore >= 72;
  return {
    shouldReply,
    reason: item.reason.trim() || (shouldReply ? "Best candidate clears the taste bar." : "Silence is stronger."),
    confidence: boundedNumber(item.confidence, 0, 1) ?? 0.7,
    ...(shouldReply ? { recommendedId: best.suggestionId } : {}),
    ...(stance ? { stance: shouldReply ? stance : "abstain" } : {}),
    evaluations
  };
}

function fallbackTasteDecision(response: DraftResponse, analysis: IntentAnalysis): TasteDecision {
  const evaluations = response.suggestions.map((suggestion) => {
    const generic = /^(great point|love this|so true|exactly|one thing i'?d add|curious how)\b/i.test(suggestion.text);
    const stock = /\b(the real unlock|here'?s the thing|at the end of the day)\b/i.test(suggestion.text);
    const score = Math.max(0, Math.min(100, Math.round(suggestion.confidence * 100) - (generic ? 35 : 0) - (stock ? 20 : 0)));
    return {
      suggestionId: suggestion.id,
      score,
      sourceFit: score,
      novelty: Math.max(0, score - (generic ? 20 : 0)),
      voiceFit: score,
      restraint: Math.max(0, score - (stock ? 15 : 0)),
      reasons: generic ? ["Generic opener"] : ["Best available candidate"],
      flags: [...(generic ? ["generic"] : []), ...(stock ? ["stock_phrase"] : [])]
    };
  });
  const best = [...evaluations].sort((left, right) => right.score - left.score)[0];
  const shouldReply = analysis.shouldReply !== false && !!best && best.score >= 72;
  return {
    shouldReply,
    reason: shouldReply ? "Best candidate clears the local taste fallback." : analysis.stanceReason ?? "No candidate clears the taste bar.",
    confidence: analysis.confidence,
    ...(shouldReply && best ? { recommendedId: best.suggestionId } : {}),
    stance: shouldReply ? analysis.recommendedStance ?? "contextualize" : "abstain",
    evaluations
  };
}

function applyTasteDecision(response: DraftResponse, decision: TasteDecision, analysis: IntentAnalysis): DraftResponse {
  const ranked = [...response.suggestions].sort((left, right) => {
    const leftScore = decision.evaluations.find((item) => item.suggestionId === left.id)?.score ?? 0;
    const rightScore = decision.evaluations.find((item) => item.suggestionId === right.id)?.score ?? 0;
    return rightScore - leftScore;
  });
  const winner = ranked.find((suggestion) => suggestion.id === decision.recommendedId) ?? ranked[0];
  if (!decision.shouldReply || !winner) {
    return {
      suggestions: [],
      explore: [],
      intentAnalysis: analysis,
      strategies: [],
      abstained: true,
      abstainReason: decision.reason,
      tasteDecision: decision
    };
  }
  const selected = {
    ...winner,
    strategy: decision.stance ?? analysis.recommendedStance ?? winner.strategy ?? "source-aware"
  };
  return {
    suggestions: [selected],
    recommendedId: selected.id,
    recommendation: selected,
    explore: [],
    intentAnalysis: analysis,
    strategies: [{
      id: `strategy-${selected.id}`,
      label: "Taste pick",
      angle: decision.reason,
      tone: decision.stance ?? analysis.recommendedStance ?? "source-aware",
      exploratory: false
    }],
    tasteDecision: decision
  };
}

async function analyzeIntent(
  db: AppDatabase,
  codexClient: CodexClient,
  input: string,
  source?: GenerateCommentRequest["sourcePost"],
  tasteProfile?: ReturnType<typeof getPersonalTasteProfile>
): Promise<IntentAnalysis> {
  const fallback = () => withSourceContext(heuristicIntent(input, source), source) ?? heuristicIntent(input, source);
  try {
    const result = await runCachedJsonGeneration({
      db,
      codexClient,
      endpoint: "analyze_intent",
      cacheInput: { input, source, tasteProfile },
      request: {
        messages: [
          {
            role: "system",
            content: source
              ? [
                  "Analyze the source post a user may reply to. Be brief and concrete.",
                  "Classify speechAct as one of: question, claim, announcement, advice, opinion, complaint, other.",
                  "Paraphrase claimOrAsk in one line. State replyObjective as what a useful reply should accomplish.",
                  "Judge whether the user has an honest, non-generic reason to reply. Set shouldReply, replyWorthiness 0-100, recommendedStance, and stanceReason.",
                  "recommendedStance must be one of: answer, agree-and-add, clarify, challenge, contextualize, ask, acknowledge, abstain.",
                  "Prefer abstain when a reply would only applaud, restate, posture, or force expertise.",
                  "Use the personal taste profile as preference evidence, especially its edit signals and negative examples.",
                  "Separate target, parent, and quoted context when present. List constraints. Mark needsClarification when confidence is below 0.5.",
                  "Return JSON only."
                ].join(" ")
              : "Analyze intent and draft strategy. Separate target, parent, and quoted context. Mark needsClarification when confidence is below 0.5. Return JSON only."
          },
          { role: "user", content: JSON.stringify({ input, source, personalTasteProfile: tasteProfile ?? null }) }
        ],
        schemaName: "IntentAnalysis",
        schema: {
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
            constraints: { type: "array", items: { type: "string" } }
          },
          required: ["intent", "confidence", "needsClarification", "constraints"]
        },
        maxTokens: 280,
        ...(source ? { imageUrls: imageUrlsForSource(source) } : {}),
        temperature: 0.2
      },
      validate: (value) => {
        const parsed = parseIntentAnalysis(value);
        if (!parsed) return fallback();
        return withSourceContext(parsed, source) ?? parsed;
      }
    });
    return result.data;
  } catch {
    return fallback();
  }
}

function heuristicIntent(input: string, source?: GenerateCommentRequest["sourcePost"]): IntentAnalysis {
  const words = normalizeForStorage(input).split(" ").filter(Boolean);
  const confidence = Math.min(0.95, Math.max(0.25, words.length / 12));
  const isQuestion = input.includes("?");
  const isThin = words.length < 5;
  return {
    intent: words.slice(0, 8).join(" ") || "unclear",
    confidence,
    needsClarification: confidence < 0.5,
    ...(source ? {
      shouldReply: !isThin,
      replyWorthiness: isThin ? 35 : Math.round(confidence * 100),
      recommendedStance: isThin ? "abstain" : isQuestion ? "answer" : "contextualize",
      stanceReason: isThin ? "The source is too thin for a substantive reply." : isQuestion ? "Answer the explicit ask directly." : "Add context only if it changes how peers read the claim."
    } as const : {}),
    ...(source ? { targetContext: source.text } : {}),
    ...(source?.parentPost ? { parentContext: source.parentPost.text } : {}),
    ...(source?.quotedPost ? { quotedContext: source.quotedPost.text } : {}),
    constraints: []
  };
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

function stringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, limit)
    : [];
}

function emptyGenerationMeta(model: string) {
  return { cached: false, model, estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 };
}

function combineGenerationMeta(
  first: ReturnType<typeof emptyGenerationMeta>,
  second: ReturnType<typeof emptyGenerationMeta>
) {
  return {
    cached: first.cached && second.cached,
    model: second.outputTokens > 0 ? second.model : first.model,
    estimatedCostUsd: first.estimatedCostUsd + second.estimatedCostUsd,
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens
  };
}

function scoreResponseSchemaForCount(count: number): Record<string, unknown> {
  return {
    ...scoreResponseSchema,
    properties: {
      ...scoreResponseSchema.properties,
      rankedPosts: {
        ...scoreResponseSchema.properties.rankedPosts,
        minItems: count,
        maxItems: count
      }
    }
  };
}

function imageUrlsForPosts(posts: GenerateCommentRequest["sourcePost"][]): string[] {
  return [...new Set(posts.flatMap((post) => imageUrlsForSource(post)))];
}

function imageUrlsForSource(source: GenerateCommentRequest["sourcePost"]): string[] {
  const mediaItems = Array.isArray(source.media) ? source.media : [];
  const own = mediaItems.flatMap((media) =>
    media && media.type === "image" && typeof media.url === "string" && media.url.trim() ? [media.url.trim()] : []
  );
  return [...new Set([
    ...own,
    ...(source.parentPost ? imageUrlsForSource(source.parentPost) : []),
    ...(source.quotedPost ? imageUrlsForSource(source.quotedPost) : [])
  ])];
}

async function runCachedJsonGeneration<T>(options: {
  db: AppDatabase;
  codexClient: CodexClient;
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
  const cacheKey = cacheKeyFor({
    model: options.codexClient.defaultModel,
    endpoint: options.endpoint,
    input: options.cacheInput,
    // Prompt/schema changes must never reuse a response produced by old rules.
    messages: options.request.messages,
    schemaName: options.request.schemaName,
    schema: options.request.schema
  });

  const cached = options.cacheable === false ? undefined : getCachedGeneration(options.db, cacheKey);
  if (cached) {
    return {
      data: options.validate(JSON.parse(cached.responseJson)),
      meta: {
        cached: true,
        model: options.codexClient.defaultModel,
        estimatedCostUsd: cached.costUsd,
        inputTokens: cached.inputTokens,
        outputTokens: cached.outputTokens
      }
    };
  }

  let completion = await options.codexClient.completeJson(options.request);
  let data: T;
  try {
    data = options.validate(completion.value);
  } catch (error) {
    const validationMessage = error instanceof Error ? error.message : "The response was incomplete or inconsistent.";
    const repaired = await options.codexClient.completeJson({
      ...options.request,
      messages: [
        ...options.request.messages,
        { role: "assistant", content: completion.rawText },
        {
          role: "user",
          content: `The previous JSON failed semantic validation: ${validationMessage}. Return a complete corrected JSON result with exactly the requested input IDs and all required fields.`
        }
      ],
      maxTokens: Math.min(10_000, Math.max(options.request.maxTokens * 2, options.request.maxTokens + 1000)),
      temperature: 0
    });
    data = options.validate(repaired.value);
    completion = {
      ...repaired,
      inputTokens: completion.inputTokens + repaired.inputTokens,
      outputTokens: completion.outputTokens + repaired.outputTokens,
      costUsd: completion.costUsd + repaired.costUsd
    };
  }
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

export function createMockCodexClient(
  responseFactory: (request: JsonCompletionRequest) => unknown
): CodexClient {
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
        model: DEFAULT_MODEL
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

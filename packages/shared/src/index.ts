export const DEFAULT_MODEL = "MiniMaxAI/MiniMax-M3";
export const ADVANCED_MODEL = "zai-org/GLM-5.2";

export const TOGETHER_GLM_5_2_PRICING = {
  inputPerMillion: 1.4,
  cachedInputPerMillion: 0.26,
  outputPerMillion: 4.4
} as const;

export type ContentKind = "post" | "comment" | "reply";
export type FeedbackDecision = "accepted" | "edited" | "rejected" | "skipped";
export type ReactionRecommendation = "reply" | "quote idea" | "save for later" | "skip";
export type ContentPillar = "building" | "teaching" | "point-of-view" | string;
export type DesiredOutcome =
  | "earn relevant follows"
  | "start a useful conversation"
  | "create something worth saving"
  | string;

export interface GrowthPreferences {
  audience: string;
  pillar: ContentPillar;
  outcome: DesiredOutcome;
}

/** Defaults for a tech-dev founder seeking peer builders. */
export const DEFAULT_GROWTH_PREFERENCES: GrowthPreferences = {
  audience: "Tech founders, indie hackers, and builders shipping products",
  pillar: "building",
  outcome: "earn relevant follows"
};

export interface SourcePost {
  id?: string;
  author?: string;
  text: string;
  url?: string;
  metrics?: Record<string, number | string | undefined>;
  parentPost?: SourcePost;
  quotedPost?: SourcePost;
}

export type SpeechAct =
  | "question"
  | "claim"
  | "announcement"
  | "advice"
  | "opinion"
  | "complaint"
  | "other";

export type ReplyStance =
  | "answer"
  | "agree-and-add"
  | "clarify"
  | "challenge"
  | "contextualize"
  | "ask"
  | "acknowledge"
  | "abstain";

export interface IntentAnalysis {
  intent: string;
  confidence: number;
  needsClarification: boolean;
  speechAct?: SpeechAct;
  /** One-line paraphrase of what the author is asserting or asking. */
  claimOrAsk?: string;
  /** One-line “a useful reply should …” grounded in the source. */
  replyObjective?: string;
  /** Whether there is enough original value to justify replying at all. */
  shouldReply?: boolean;
  /** 0-100 estimate of whether a non-generic reply is worth posting. */
  replyWorthiness?: number;
  /** Source-aware stance selected before prose is drafted. */
  recommendedStance?: ReplyStance;
  stanceReason?: string;
  targetContext?: string;
  parentContext?: string;
  quotedContext?: string;
  constraints: string[];
}

const SPEECH_ACTS: readonly SpeechAct[] = [
  "question",
  "claim",
  "announcement",
  "advice",
  "opinion",
  "complaint",
  "other"
];

export interface DraftStrategy {
  id: string;
  label: string;
  angle: string;
  tone: string;
  exploratory: boolean;
}

export type WorkSessionStatus = "active" | "completed" | "archived";
export type WorkItemStatus = "pending" | "drafted" | "used" | "published" | "skipped";
export type OutcomeKind = "used" | "published";
export type OutcomePlatform = "chrome" | "ios";

export interface WorkSession {
  id: string;
  title: string;
  status: WorkSessionStatus;
  softGoal: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  items?: WorkItem[];
}

export interface WorkItem {
  id: string;
  sessionId: string;
  position: number;
  sourcePost: SourcePost;
  status: WorkItemStatus;
  recommendation?: ReactionRecommendation;
  score?: number;
  draftResponse?: DraftResponse;
  createdAt: string;
  updatedAt: string;
}

export interface Outcome {
  id: string;
  workItemId: string;
  kind: OutcomeKind;
  idempotencyKey: string;
  text?: string;
  externalId?: string;
  platform?: OutcomePlatform;
  context?: Record<string, unknown>;
  createdAt: string;
}

export interface OutcomeRequest {
  status: OutcomeKind;
  platform: OutcomePlatform;
  finalText: string;
  clientEventId: string;
  contentKind?: "post" | "reply";
  sourceText?: string;
  sourceURL?: string;
  sessionId?: string;
  workId?: string;
  externalId?: string;
  context?: Record<string, unknown>;
}

export interface GeneratePostRequest {
  topic: string;
  goal?: "authentic" | "engagement" | "business" | string;
  length?: "short" | "medium" | "thread";
  audience?: string;
  contentPillar?: ContentPillar;
  desiredOutcome?: DesiredOutcome;
  instructions?: string;
  mode?: "standard" | "cheap";
  model?: "standard" | "advanced";
  regenerationSeed?: string;
}

export interface GenerateCommentRequest {
  sourcePost: SourcePost;
  angle?: string;
  audience?: string;
  contentPillar?: ContentPillar;
  desiredOutcome?: DesiredOutcome;
  instructions?: string;
  mode?: "standard" | "cheap";
  model?: "standard" | "advanced";
  regenerationSeed?: string;
}

export interface GenerateRewriteRequest {
  text: string;
  kind: "post" | "comment";
  instructions?: string;
  mode?: "standard" | "cheap";
  model?: "standard" | "advanced";
  regenerationSeed?: string;
}

export interface VisiblePost extends SourcePost {
  viewportIndex?: number;
}

export interface ScoreVisiblePostsRequest {
  posts: VisiblePost[];
  audience?: string;
  contentPillar?: ContentPillar;
  desiredOutcome?: DesiredOutcome;
}

export interface DraftSuggestion {
  id: string;
  text: string;
  rationale: string;
  confidence: number;
  strategy?: string;
  isQuestion?: boolean;
}

export interface TasteCandidateEvaluation {
  suggestionId: string;
  score: number;
  sourceFit: number;
  novelty: number;
  voiceFit: number;
  restraint: number;
  reasons: string[];
  flags: string[];
}

export interface TasteDecision {
  shouldReply: boolean;
  reason: string;
  confidence: number;
  recommendedId?: string;
  stance?: ReplyStance;
  evaluations: TasteCandidateEvaluation[];
}

export interface DraftResponse {
  suggestions: DraftSuggestion[];
  recommendedId?: string;
  recommendation?: DraftSuggestion;
  explore?: DraftSuggestion[];
  intentAnalysis?: IntentAnalysis;
  strategies?: DraftStrategy[];
  /** True when the taste gate decided that silence beats every generated option. */
  abstained?: boolean;
  abstainReason?: string;
  tasteDecision?: TasteDecision;
}

export interface ScoredPost {
  id: string;
  score: number;
  recommendation: ReactionRecommendation;
  reason: string;
  suggestedAngle: string;
  /** Ultra-short plain-language summary of what the post is about (for fast queue review). */
  topicSummary?: string;
  draftSeed?: string;
  risks: string[];
}

export interface ScoreVisiblePostsResponse {
  rankedPosts: ScoredPost[];
}

export interface FeedbackRequest {
  suggestionId: string;
  kind: ContentKind;
  decision: FeedbackDecision;
  originalText?: string;
  finalText?: string;
  context?: Record<string, unknown>;
}

export interface ApiEnvelope<T> {
  data: T;
  meta: {
    cached: boolean;
    model: string;
    estimatedCostUsd: number;
    inputTokens: number;
    outputTokens: number;
  };
}

export function normalizeText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(normalizeText(value).length / 4));
}

export function estimateTogetherCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * TOGETHER_GLM_5_2_PRICING.inputPerMillion +
    (outputTokens / 1_000_000) * TOGETHER_GLM_5_2_PRICING.outputPerMillion
  );
}

export function isReactionRecommendation(value: unknown): value is ReactionRecommendation {
  return value === "reply" || value === "quote idea" || value === "save for later" || value === "skip";
}

const COMMENT_BAIT_PATTERNS: RegExp[] = [
  /\b(comment|like|rt|retweet|quote|share)\b[\s\S]{0,40}\b(if|yes|below|for a|for an)\b/i,
  /\b(drop|leave|put)\b[\s\S]{0,24}\b(a |an |your )?(🔥|❤️|💯|emoji|comment|like)\b/i,
  /\btag (a |someone|somebody|a friend)\b/i,
  /\b(i'?ll|i will)\b[\s\S]{0,48}\b(follow|dm|send|give)\b[\s\S]{0,40}\b(comment|like|rt|retweet)\b/i,
  /\b(follow|like|rt|retweet)\b[\s\S]{0,24}(and|&)[\s\S]{0,24}\b(comment|like|rt|retweet)\b/i,
  /\b(this (post )?will flop|only real ones|real ones (will|comment)|prove me wrong)\b/i,
  /\b(rate (this|it)|score (this|it)|1\s*[-–to]+\s*10)\b/i,
  /\bfill in the blank\b/i,
  /\bwho( '?s| is)? (with me|else (thinks|agrees|feels))\b/i,
  /\bagree or disagree\b/i,
  /\b(comment|reply) (below|your|with)\b/i,
  /\bthoughts\??\s*$/i
];

/** Detects reply-harvesting / comment-bait posts that high-intent reply flows should skip. */
export function looksLikeCommentBait(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  if (COMMENT_BAIT_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  const lower = normalized.toLowerCase();
  if (lower.length > 140) return false;
  return /^(who else|anyone else|am i the only|thoughts\??|agree\??|yes or no|y\/n)\b/.test(lower)
    || /\b(yes or no|y\/n)\??\s*$/.test(lower);
}

/** Force comment-bait posts to skip so high-intent reply queues never draft into them. */
export function suppressCommentBaitScores(
  rankedPosts: ScoredPost[],
  posts: Array<Pick<SourcePost, "id" | "text">>
): ScoredPost[] {
  const textById = new Map(
    posts
      .filter((post): post is SourcePost & { id: string } => typeof post.id === "string" && post.id.trim().length > 0)
      .map((post) => [post.id.trim(), post.text])
  );
  return rankedPosts.map((ranked) => {
    const postText = textById.get(ranked.id);
    if (!postText || !looksLikeCommentBait(postText)) return ranked;
    return {
      ...ranked,
      score: Math.min(ranked.score, 25),
      recommendation: "skip" as const,
      reason: /comment bait/i.test(ranked.reason)
        ? ranked.reason
        : `Comment bait — skip high-intent reply. ${ranked.reason}`,
      risks: [...new Set([...(ranked.risks ?? []), "comment_bait"])]
    };
  });
}

/** Fill missing topic summaries from source post text so queue cards never crash. */
export function enrichTopicSummaries(
  rankedPosts: ScoredPost[],
  posts: Array<Pick<SourcePost, "id" | "text">>
): ScoredPost[] {
  const textById = new Map(
    posts
      .filter((post): post is SourcePost & { id: string } => typeof post.id === "string" && post.id.trim().length > 0)
      .map((post) => [post.id.trim(), post.text])
  );
  return rankedPosts.map((ranked) => {
    if (ranked.topicSummary?.trim()) return ranked;
    const postText = textById.get(ranked.id)?.replace(/\s+/g, " ").trim();
    if (!postText) return ranked;
    const summary = postText.length <= 80 ? postText : `${postText.slice(0, 79).trimEnd()}…`;
    return { ...ranked, topicSummary: summary };
  });
}

export function validateDraftResponse(value: unknown): DraftResponse {
  if (!isObject(value) || !Array.isArray(value.suggestions)) {
    throw new Error("Draft response must include suggestions array.");
  }

  const parsedSuggestions = value.suggestions.slice(0, 5).map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`Draft suggestion ${index} must be an object.`);
    }
    const text = stringField(item, "text");
    const rationale = stringField(item, "rationale");
    const confidence = numberField(item, "confidence", 0.1, 1);
    const id = typeof item.id === "string" && item.id.trim() ? item.id : cryptoRandomId();
    return {
      id,
      text,
      rationale,
      confidence,
      ...(typeof item.strategy === "string" ? { strategy: item.strategy } : {}),
      ...(typeof item.isQuestion === "boolean" ? { isQuestion: item.isQuestion } : {})
    };
  });

  const suggestions = parsedSuggestions.filter((candidate, index, all) => all.findIndex((other) =>
    openingKey(other.text) === openingKey(candidate.text) || textSimilarity(other.text, candidate.text) >= 0.82
  ) === index);

  const abstained = value.abstained === true;
  if (suggestions.length === 0 && !abstained) {
    throw new Error("Draft response must include at least one suggestion.");
  }

  const recommendation = isObject(value.recommendation)
    ? parseDraftSuggestion(value.recommendation, suggestions.length)
    : suggestions[0];
  const explore = Array.isArray(value.explore)
    ? value.explore.slice(0, 4).map((item, index) => {
        if (!isObject(item)) throw new Error(`Explore suggestion ${index} must be an object.`);
        return parseDraftSuggestion(item, index);
      })
    : suggestions.slice(1, 5);
  const intentAnalysis = parseIntentAnalysis(value.intentAnalysis);
  return {
    suggestions,
    ...(typeof value.recommendedId === "string" ? { recommendedId: value.recommendedId } : recommendation ? { recommendedId: recommendation.id } : {}),
    ...(recommendation ? { recommendation } : {}),
    ...(explore ? { explore } : {}),
    ...(intentAnalysis ? { intentAnalysis } : {}),
    ...(abstained ? { abstained: true } : {}),
    ...(typeof value.abstainReason === "string" && value.abstainReason.trim()
      ? { abstainReason: value.abstainReason.trim() }
      : {})
  };
}

export function parseIntentAnalysis(value: unknown): IntentAnalysis | undefined {
  if (!isObject(value) || typeof value.intent !== "string" || !value.intent.trim()) {
    return undefined;
  }
  const confidence =
    typeof value.confidence === "number" && !Number.isNaN(value.confidence)
      ? Math.min(1, Math.max(0, value.confidence))
      : 0.5;
  const constraints = Array.isArray(value.constraints)
    ? value.constraints.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  const speechAct =
    typeof value.speechAct === "string" && SPEECH_ACTS.includes(value.speechAct as SpeechAct)
      ? (value.speechAct as SpeechAct)
      : undefined;
  const replyStances: readonly ReplyStance[] = [
    "answer",
    "agree-and-add",
    "clarify",
    "challenge",
    "contextualize",
    "ask",
    "acknowledge",
    "abstain"
  ];
  const recommendedStance =
    typeof value.recommendedStance === "string" && replyStances.includes(value.recommendedStance as ReplyStance)
      ? (value.recommendedStance as ReplyStance)
      : undefined;
  return {
    intent: value.intent.trim(),
    confidence,
    needsClarification: value.needsClarification === true || confidence < 0.5,
    constraints,
    ...(speechAct ? { speechAct } : {}),
    ...(typeof value.claimOrAsk === "string" && value.claimOrAsk.trim() ? { claimOrAsk: value.claimOrAsk.trim() } : {}),
    ...(typeof value.replyObjective === "string" && value.replyObjective.trim()
      ? { replyObjective: value.replyObjective.trim() }
      : {}),
    ...(typeof value.shouldReply === "boolean" ? { shouldReply: value.shouldReply } : {}),
    ...(typeof value.replyWorthiness === "number" && Number.isFinite(value.replyWorthiness)
      ? { replyWorthiness: Math.min(100, Math.max(0, value.replyWorthiness)) }
      : {}),
    ...(recommendedStance ? { recommendedStance } : {}),
    ...(typeof value.stanceReason === "string" && value.stanceReason.trim()
      ? { stanceReason: value.stanceReason.trim() }
      : {}),
    ...(typeof value.targetContext === "string" && value.targetContext.trim()
      ? { targetContext: value.targetContext.trim() }
      : {}),
    ...(typeof value.parentContext === "string" && value.parentContext.trim()
      ? { parentContext: value.parentContext.trim() }
      : {}),
    ...(typeof value.quotedContext === "string" && value.quotedContext.trim()
      ? { quotedContext: value.quotedContext.trim() }
      : {})
  };
}

function openingKey(text: string): string { return normalizeText(text).toLowerCase().split(" ").slice(0,4).join(" "); }
function textSimilarity(left: string, right: string): number {
  const a=new Set(normalizeText(left).toLowerCase().split(/\W+/).filter(Boolean));
  const b=new Set(normalizeText(right).toLowerCase().split(/\W+/).filter(Boolean));
  const union=new Set([...a,...b]);
  if (!union.size) return 1;
  let overlap=0; for (const word of a) if (b.has(word)) overlap += 1;
  return overlap/union.size;
}

function parseDraftSuggestion(item: Record<string, unknown>, index: number): DraftSuggestion {
  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id : cryptoRandomId(),
    text: stringField(item, "text"),
    rationale: stringField(item, "rationale"),
    confidence: numberField(item, "confidence", 0.1, 1),
    ...(typeof item.strategy === "string" ? { strategy: item.strategy } : {}),
    ...(typeof item.isQuestion === "boolean" ? { isQuestion: item.isQuestion } : {})
  };
}

export function validateScoreVisiblePostsResponse(value: unknown): ScoreVisiblePostsResponse {
  if (!isObject(value) || !Array.isArray(value.rankedPosts)) {
    throw new Error("Score response must include rankedPosts array.");
  }

  const rankedPosts = value.rankedPosts.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`Ranked post ${index} must be an object.`);
    }
    const recommendation = item.recommendation;
    if (!isReactionRecommendation(recommendation)) {
      throw new Error(`Ranked post ${index} has invalid recommendation.`);
    }
    const result: ScoredPost = {
      id: stringField(item, "id"),
      score: numberField(item, "score", 0, 100),
      recommendation,
      reason: stringField(item, "reason"),
      suggestedAngle: stringField(item, "suggestedAngle"),
      risks: Array.isArray(item.risks) ? item.risks.filter((risk): risk is string => typeof risk === "string") : []
    };
    if (typeof item.topicSummary === "string" && item.topicSummary.trim()) {
      result.topicSummary = item.topicSummary.trim().slice(0, 120);
    }
    if (typeof item.draftSeed === "string") {
      result.draftSeed = item.draftSeed;
    }
    return result;
  });

  return { rankedPosts };
}

export function validateGenerateRewriteRequest(value: unknown): GenerateRewriteRequest {
  if (!isObject(value)) {
    throw new Error("Rewrite request body must be an object.");
  }

  const rawText = value.text;
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("text is required.");
  }
  const text = rawText.trim();
  const kind = value.kind;
  if (kind !== "post" && kind !== "comment") {
    throw new Error("kind must be post or comment.");
  }

  const result: GenerateRewriteRequest = {
    text,
    kind
  };
  if (typeof value.instructions === "string" && value.instructions.trim()) {
    result.instructions = value.instructions.trim();
  }
  if (value.mode === "cheap" || value.mode === "standard") {
    result.mode = value.mode;
  }
  if (value.model === "standard" || value.model === "advanced") {
    result.model = value.model;
  }
  if (typeof value.regenerationSeed === "string" && value.regenerationSeed.trim()) {
    result.regenerationSeed = value.regenerationSeed.trim();
  }
  return result;
}

export function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error";
    throw new Error(`Model returned invalid JSON: ${message}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.trim().length === 0) {
    throw new Error(`Missing required string field: ${field}`);
  }
  return result.trim();
}

function numberField(value: Record<string, unknown>, field: string, min: number, max: number): number {
  const result = value[field];
  if (typeof result !== "number" || Number.isNaN(result)) {
    throw new Error(`Missing required number field: ${field}`);
  }
  return Math.min(max, Math.max(min, result));
}

function cryptoRandomId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `id_${Math.random().toString(36).slice(2)}`;
}

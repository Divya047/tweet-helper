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

export interface SourcePost {
  id?: string;
  author?: string;
  text: string;
  url?: string;
  metrics?: Record<string, number | string | undefined>;
  parentPost?: SourcePost;
  quotedPost?: SourcePost;
}

export interface IntentAnalysis {
  intent: string;
  confidence: number;
  needsClarification: boolean;
  targetContext?: string;
  parentContext?: string;
  quotedContext?: string;
  constraints: string[];
}

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
  createdAt: string;
}

export interface GeneratePostRequest {
  topic: string;
  goal?: "authentic" | "engagement" | "business" | string;
  length?: "short" | "medium" | "thread";
  instructions?: string;
  mode?: "standard" | "cheap";
  model?: "standard" | "advanced";
  regenerationSeed?: string;
}

export interface GenerateCommentRequest {
  sourcePost: SourcePost;
  angle?: string;
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
}

export interface DraftSuggestion {
  id: string;
  text: string;
  rationale: string;
  confidence: number;
}

export interface DraftResponse {
  suggestions: DraftSuggestion[];
  recommendation?: DraftSuggestion;
  explore?: DraftSuggestion[];
  intentAnalysis?: IntentAnalysis;
  strategies?: DraftStrategy[];
}

export interface ScoredPost {
  id: string;
  score: number;
  recommendation: ReactionRecommendation;
  reason: string;
  suggestedAngle: string;
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
    return { id, text, rationale, confidence };
  });

  const suggestions = parsedSuggestions.filter((candidate, index, all) => all.findIndex((other) =>
    openingKey(other.text) === openingKey(candidate.text) || textSimilarity(other.text, candidate.text) >= 0.82
  ) === index);

  if (suggestions.length === 0) {
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
  return {
    suggestions,
    ...(recommendation ? { recommendation } : {}),
    ...(explore ? { explore } : {})
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
    confidence: numberField(item, "confidence", 0.1, 1)
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

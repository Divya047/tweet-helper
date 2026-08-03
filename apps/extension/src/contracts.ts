import type { FeedbackRequest, OutcomeRequest, ScoredPost, SourceMedia } from "@tweet-helper/shared";

export type ComposerKind = "post" | "reply";
export type EventKind = "insert" | "edit" | "skip" | "published";

export interface PostContext { id?: string; author?: string; text: string; url?: string; media?: SourceMedia[] }
export interface ComposerContext {
  kind: ComposerKind;
  currentText: string;
  target?: PostContext;
  parent?: PostContext;
  quoted?: PostContext;
}
export interface Draft { id: string; text: string; strategy?: string; recommended?: boolean }
export interface QueueItem {
  id: string;
  draft: Draft;
  /** The generated copy before any queue edits, retained for taste learning. */
  generatedText?: string;
  opportunityLane?: OpportunityLane;
  context: ComposerContext;
  createdAt: number;
  /** Ultra-short summary of the source post topic for fast queue review. */
  sourceSummary?: string;
}

export type OpportunityLane = "proven" | "adjacent" | "wildcard";
export type OpportunityOutcome = "shown" | "used" | "edited" | "skipped";
export type OpportunityLaneStats = Record<OpportunityLane, Record<OpportunityOutcome, number>>;
export interface OpportunityMix { proven: number; adjacent: number; wildcard: number }
export interface OpportunitySelection { score: ScoredPost; lane: OpportunityLane }

export function nextOpportunityWave<T>(pool: T[], cursor: number, accepted: number, target: number): { items: T[]; nextCursor: number } {
  const size = Math.max(0, target - accepted);
  const items = pool.slice(cursor, cursor + size);
  return { items, nextCursor: cursor + items.length };
}

export const DEFAULT_OPPORTUNITY_MIX: OpportunityMix = { proven: 5, adjacent: 2, wildcard: 1 };

export function emptyOpportunityLaneStats(): OpportunityLaneStats {
  return {
    proven: { shown: 0, used: 0, edited: 0, skipped: 0 },
    adjacent: { shown: 0, used: 0, edited: 0, skipped: 0 },
    wildcard: { shown: 0, used: 0, edited: 0, skipped: 0 }
  };
}

export function adaptiveOpportunityMix(stats: OpportunityLaneStats): OpportunityMix {
  const adjacent = laneUseRate(stats.adjacent);
  const wildcard = laneUseRate(stats.wildcard);
  if (wildcard.decisions >= 8 && wildcard.rate >= 0.3) return { proven: 4, adjacent: 2, wildcard: 2 };
  if (adjacent.decisions >= 8 && adjacent.rate >= 0.3) return { proven: 4, adjacent: 3, wildcard: 1 };
  if (adjacent.decisions >= 8 && adjacent.rate <= 0.1) return { proven: 6, adjacent: 1, wildcard: 1 };
  return { ...DEFAULT_OPPORTUNITY_MIX };
}

export function recordOpportunityOutcome(
  stats: OpportunityLaneStats,
  lane: OpportunityLane,
  outcome: OpportunityOutcome
): OpportunityLaneStats {
  return {
    ...stats,
    [lane]: { ...stats[lane], [outcome]: stats[lane][outcome] + 1 }
  };
}

/** Build a safe, diverse queue instead of taking the eight highest totals. */
export function selectOpportunityMix(
  rankedPosts: ScoredPost[],
  posts: PostContext[],
  stats: OpportunityLaneStats,
  target: number = FIND_HIGH_INTENT.targetReplies
): OpportunitySelection[] {
  const postById = new Map(posts.map((post) => [post.id, post]));
  const safe = rankedPosts.filter((post) =>
    post.recommendation === "reply" && (post.risk ?? riskFromFlags(post.risks)) <= FIND_HIGH_INTENT.maxRisk
  );
  const mix = adaptiveOpportunityMix(stats);
  const chosen: OpportunitySelection[] = [];
  const ids = new Set<string>();
  const add = (score: ScoredPost, lane: OpportunityLane): void => {
    if (ids.has(score.id) || chosen.length >= target) return;
    ids.add(score.id);
    chosen.push({ score, lane });
  };
  const selectedPosts = (): ScoredPost[] => chosen.map((item) => item.score);

  takeDiverse(safe.filter((post) => post.score >= FIND_HIGH_INTENT.minScore), mix.proven, selectedPosts, postById, "quality")
    .forEach((score) => add(score, "proven"));
  takeDiverse(safe.filter((post) => post.score >= FIND_HIGH_INTENT.adjacentMinScore && !ids.has(post.id)), mix.adjacent, selectedPosts, postById, "balanced")
    .forEach((score) => add(score, "adjacent"));
  takeDiverse(safe.filter((post) => post.score >= FIND_HIGH_INTENT.wildcardMinScore && !ids.has(post.id)), mix.wildcard, selectedPosts, postById, "novelty")
    .forEach((score) => add(score, "wildcard"));

  const fallback = safe
    .filter((post) => post.score >= FIND_HIGH_INTENT.wildcardMinScore && !ids.has(post.id))
    .sort((left, right) => opportunityQuality(right) - opportunityQuality(left));
  for (const score of fallback) {
    const lane: OpportunityLane = score.score >= FIND_HIGH_INTENT.minScore
      ? "proven"
      : score.score >= FIND_HIGH_INTENT.adjacentMinScore ? "adjacent" : "wildcard";
    add(score, lane);
  }
  return chosen;
}

function takeDiverse(
  candidates: ScoredPost[],
  count: number,
  selected: () => ScoredPost[],
  postById: Map<string | undefined, PostContext>,
  mode: "quality" | "balanced" | "novelty"
): ScoredPost[] {
  const pool = [...candidates];
  const result: ScoredPost[] = [];
  while (result.length < count && pool.length) {
    const context = [...selected(), ...result];
    pool.sort((left, right) => laneRank(right, context, postById, mode) - laneRank(left, context, postById, mode));
    result.push(pool.shift()!);
  }
  return result;
}

function laneRank(
  post: ScoredPost,
  selected: ScoredPost[],
  postById: Map<string | undefined, PostContext>,
  mode: "quality" | "balanced" | "novelty"
): number {
  const quality = opportunityQuality(post);
  const novelty = opportunityNovelty(post, selected, postById);
  if (mode === "quality") return quality * 0.82 + novelty * 0.18;
  if (mode === "balanced") return quality * 0.5 + novelty * 0.5;
  return quality * 0.25 + novelty * 0.75;
}

function opportunityQuality(post: ScoredPost): number {
  const contribution = post.contributionPotential ?? post.score;
  const audience = post.audienceFit ?? post.score;
  const confidence = post.confidence ?? post.score;
  const risk = post.risk ?? riskFromFlags(post.risks);
  return contribution * 0.4 + audience * 0.3 + confidence * 0.15 + post.score * 0.15 - risk * 0.35;
}

function opportunityNovelty(
  post: ScoredPost,
  selected: ScoredPost[],
  postById: Map<string | undefined, PostContext>
): number {
  if (!selected.length) return post.novelty ?? 100;
  const topic = post.topicSummary ?? postById.get(post.id)?.text ?? "";
  const author = postById.get(post.id)?.author;
  let maxSimilarity = 0;
  for (const other of selected) {
    const otherTopic = other.topicSummary ?? postById.get(other.id)?.text ?? "";
    let similarity = textSimilarity(topic, otherTopic);
    const otherAuthor = postById.get(other.id)?.author;
    if (author && otherAuthor && author === otherAuthor) similarity = Math.max(similarity, 0.8);
    maxSimilarity = Math.max(maxSimilarity, similarity);
  }
  const derived = (1 - maxSimilarity) * 100;
  return post.novelty === undefined ? derived : (derived + post.novelty) / 2;
}

function textSimilarity(left: string, right: string): number {
  const tokens = (value: string): Set<string> => new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const a = tokens(left);
  const b = tokens(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / union.size;
}

function riskFromFlags(risks: string[]): number {
  return Math.min(100, risks.length * 25);
}

function laneUseRate(stats: Record<OpportunityOutcome, number>): { decisions: number; rate: number } {
  const decisions = stats.used + stats.skipped;
  return { decisions, rate: decisions ? stats.used / decisions : 0 };
}

export interface QueueDraftEdit {
  item: QueueItem;
  originalText: string;
  finalText: string;
}

/** Replace queued copy while retaining the generated version as learning input. */
export function updateQueuedDraft(item: QueueItem, nextText: string): QueueDraftEdit | undefined {
  const finalText = nextText.trim();
  if (!finalText || finalText === item.draft.text) return undefined;
  const originalText = item.generatedText ?? item.draft.text;
  return {
    item: {
      ...item,
      generatedText: originalText,
      draft: { ...item.draft, text: finalText }
    },
    originalText,
    finalText
  };
}
export interface QueueInsertResult {
  inserted: boolean;
  reason?: string;
}
export interface ClientEvent {
  clientEventId: string;
  kind: EventKind;
  occurredAt: string;
  suggestionId?: string;
  externalId?: string;
  originalText?: string;
  finalText?: string;
  context: ComposerContext;
  syncedAt?: string;
}
export interface ExtensionState {
  sessionId: string;
  queue: QueueItem[];
  activeQueueItemId?: string;
  events: ClientEvent[];
  activity: { dayKey: string; posts: number; replies: number };
  activityTracking: "insert";
}
export type FeedScrollStoppedReason = "cap" | "stagnant" | "duration" | "aborted";

export interface FeedTrend {
  label: string;
  count: number;
  sampleAngle?: string;
}

export type ExtensionMessage =
  | { type: "GET_STATE" }
  | { type: "SET_QUEUE"; queue: QueueItem[]; activeQueueItemId?: string }
  | { type: "COMPOSER_CONTEXT" }
  | { type: "GENERATE_AND_INSERT"; context: ComposerContext }
  | { type: "INSERT_QUEUE_NEXT"; item: QueueItem }
  | { type: "OPEN_SOURCE_POST"; target: PostContext }
  | { type: "RECORD_EVENT"; event: ClientEvent }
  | { type: "OPEN_SIDE_PANEL" }
  | { type: "SCAN_VISIBLE" }
  | {
      type: "COLLECT_FEED_POSTS";
      excludeIds?: string[];
      maxCandidates?: number;
      maxScrolls?: number;
      pauseMs?: number;
      stagnantLimit?: number;
      maxDurationMs?: number;
      reportProgress?: boolean;
    }
  | { type: "STOP_FEED_SCROLL" }
  | { type: "FEED_SCROLL_PROGRESS"; posts: number; scrolls: number; elapsedMs: number }
  | { type: "NATIVE_CONFIG_REQUEST" }
  | { type: "NATIVE_API_REQUEST"; path: string; method: "GET" | "POST"; body?: unknown };

export const FIND_HIGH_INTENT = {
  targetReplies: 8,
  maxCandidates: 24,
  maxScrolls: 16,
  scrollPauseMs: 650,
  stagnantLimit: 2,
  minScore: 60,
  adjacentMinScore: 55,
  wildcardMinScore: 50,
  maxRisk: 55
} as const;

/** Long feed scroll used to surface circulating topics for original post ideas. */
export const TREND_SCAN = {
  maxCandidates: 48,
  maxScrolls: 80,
  scrollPauseMs: 800,
  stagnantLimit: 5,
  maxDurationMs: 150_000,
  scoreSampleSize: 16,
  topTrends: 4
} as const;

export function sourcePostUrl(target?: PostContext): string | undefined {
  if (target?.url?.includes("/status/")) return target.url;
  if (target?.id && /^\d+$/.test(target.id)) return `https://x.com/i/status/${target.id}`;
  return undefined;
}

/** Evenly sample posts across a long scroll so scoring stays within the backend cap. */
export function samplePostsForScoring<T>(posts: T[], limit: number): T[] {
  if (limit <= 0 || posts.length === 0) return [];
  if (posts.length <= limit) return [...posts];
  const sampled: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const position = Math.floor((index * (posts.length - 1)) / Math.max(1, limit - 1));
    sampled.push(posts[position]!);
  }
  return sampled;
}

/** Cluster topic summaries from scored feed posts into ranked feed trends. */
export function deriveFeedTrends(
  rankedPosts: Array<{ topicSummary?: string; suggestedAngle?: string; score?: number }>,
  limit = TREND_SCAN.topTrends
): FeedTrend[] {
  const buckets = new Map<string, { label: string; count: number; sampleAngle?: string; bestScore: number }>();
  for (const post of rankedPosts) {
    const label = normalizeTrendLabel(post.topicSummary);
    if (!label) continue;
    const key = trendClusterKey(label);
    const existing = buckets.get(key);
    const score = typeof post.score === "number" ? post.score : 0;
    if (!existing) {
      buckets.set(key, {
        label,
        count: 1,
        ...(post.suggestedAngle?.trim() ? { sampleAngle: post.suggestedAngle.trim() } : {}),
        bestScore: score
      });
      continue;
    }
    existing.count += 1;
    if (score > existing.bestScore) {
      existing.bestScore = score;
      existing.label = label;
      if (post.suggestedAngle?.trim()) existing.sampleAngle = post.suggestedAngle.trim();
    }
  }

  return [...buckets.values()]
    .sort((left, right) => right.count - left.count || right.bestScore - left.bestScore)
    .slice(0, Math.max(0, limit))
    .map(({ label, count, sampleAngle }) => ({
      label,
      count,
      ...(sampleAngle ? { sampleAngle } : {})
    }));
}

/** One focused brief per feed trend — never mash multiple themes into one topic. */
export function buildSingleTrendBrief(trend: FeedTrend, audience: string): string {
  const who = audience || "peer founders and builders";
  const angle = trend.sampleAngle ? `\nUseful angle worth joining: ${trend.sampleAngle}` : "";
  return [
    `Join this circulating conversation among ${who}:`,
    trend.label,
    `(seen ${trend.count}× in the current feed)${angle}`,
    "Write one original post with specific value for this single theme only.",
    "Do not mention, combine, or reference any other unrelated trends.",
    "Do not copy or closely paraphrase any source post."
  ].join("\n");
}

function normalizeTrendLabel(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.replace(/[.!?]+$/g, "").trim().slice(0, 80);
}

function trendClusterKey(label: string): string {
  const stop = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "about", "that", "from"]);
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !stop.has(token))
    .slice(0, 2)
    .join(" ");
}

/** Map a standard generate/post 1+4 response into Explore cards (recommended first). */
export function mapNativeExplore(
  response: {
    recommendation?: { id: string; text: string; strategy?: string };
    explore?: Array<{ id: string; text: string; strategy?: string }>;
    suggestions: Array<{ id: string; text: string; strategy?: string }>;
    strategies?: Array<{ label: string }>;
  }
): Draft[] {
  const labels = response.strategies?.map((item) => item.label) ?? [
    "Recommended",
    "Specific",
    "Constructive tension",
    "Experience question",
    "Concise practical"
  ];
  const recommended = response.recommendation ?? response.suggestions[0];
  const exploreItems = (response.explore?.length ? response.explore : response.suggestions.slice(1, 5)).slice(0, 4);
  const cards: Draft[] = [];
  if (recommended) {
    cards.push({
      id: recommended.id,
      text: recommended.text,
      strategy: recommended.strategy ?? labels[0] ?? "Recommended",
      recommended: true
    });
  }
  for (let index = 0; index < exploreItems.length; index += 1) {
    const item = exploreItems[index]!;
    if (recommended && item.id === recommended.id) continue;
    cards.push({
      id: item.id,
      text: item.text,
      strategy: item.strategy ?? labels[index + 1] ?? `Explore ${index + 1}`,
      recommended: false
    });
  }
  return cards.slice(0, 5);
}

/** @deprecated Legacy explicit presets. Live reply generation now uses the backend's source-aware taste gate. */
export const REPLY_TONES = [
  {
    label: "Practical caveat",
    instruction: "Add one concrete caveat or edge case peers miss. No anecdote, no invented personal story, and no question."
  },
  {
    label: "Counterexample",
    instruction: "Offer one concise counterexample or exception that sharpens the point. No invented personal experience and no question."
  },
  {
    label: "Tradeoff callout",
    instruction: "Name the main tradeoff the post implies and which side usually wins under what constraint. No anecdote and no question."
  },
  {
    label: "Implementation detail",
    instruction: "Contribute one specific implementation, process, or operational detail the author did not state. Do not invent credentials or personal history. No question."
  },
  {
    label: "Pattern observation",
    instruction: "State a crisp pattern or principle that generalizes the post. Keep it analytical, not story-led. No question."
  },
  {
    label: "Constructive pushback",
    instruction: "Disagree or qualify the claim with one clear reason. Stay peer-respectful; avoid dunking. No invented story and no question."
  },
  {
    label: "Reasoned question",
    instruction: "Lead with one useful premise, then ask one specific question peers can answer in a sentence. Do not invent a personal anecdote to earn the question."
  },
  {
    label: "Concise add-on",
    instruction: "Agree briefly only if earned, then add one short, specific insight that stands alone. No story opener like 'one time we…' and no question."
  }
] as const;

/** @deprecated Legacy voice presets retained for stored callers and compatibility tests. */
export const REPLY_VOICES = [
  {
    label: "Dry understated",
    instruction: "Flat and underplayed. No hype, no softener, no applause. Prefer one plain sentence over a polished paragraph."
  },
  {
    label: "Blunt direct",
    instruction: "Short declarative sentences. Lead with the point; skip throat-clearing. Contractions are fine. Do not hedge with 'maybe' stacks."
  },
  {
    label: "Curious peer",
    instruction: "Sound like a sharp peer thinking out loud. Natural cadence, light uncertainty only where earned — not performative curiosity."
  },
  {
    label: "Sparse clipped",
    instruction: "Minimal wording. One tight claim, maybe a fragment. Cut filler words. Sound typed fast, not drafted."
  },
  {
    label: "Slightly skeptical",
    instruction: "Measured doubt or qualification without dunking or sarcasm piles. Keep respect; keep edge."
  },
  {
    label: "Conversational",
    instruction: "Peer-chat register: contractions, uneven sentence length, one informal turn of phrase if it fits. Still substantive — not chatty fluff."
  },
  {
    label: "Technical precise",
    instruction: "Exact wording, concrete nouns, process or systems language. No marketing gloss. Prefer specificity over punchiness."
  },
  {
    label: "Quiet confident",
    instruction: "Calm certainty without bravado. No exclamation, no hype adjectives. State the insight as if it is already obvious to practitioners."
  }
] as const;

export type ReplyTone = (typeof REPLY_TONES)[number];
export type ReplyVoice = (typeof REPLY_VOICES)[number];
export type ReplyStyle = { tone: ReplyTone; voice: ReplyVoice };

/** @deprecated Live reply paths no longer assign random styles. */
export function assignReplyStyles(count: number): ReplyStyle[] {
  const tones = shuffleCopy(REPLY_TONES);
  const voices = shuffleCopy(REPLY_VOICES);
  return Array.from({ length: count }, (_, index) => ({
    tone: tones[index % tones.length]!,
    voice: voices[index % voices.length]!
  }));
}

/** @deprecated Live reply paths use buildTasteAwareReplyInstructions. */
export function assignReplyTones(count: number): ReplyTone[] {
  return assignReplyStyles(count).map((style) => style.tone);
}

/** @deprecated Live reply paths use buildTasteAwareReplyInstructions. */
export function buildReplyDraftInstructions(style: ReplyStyle, outcome: string): string {
  return [
    `Reply tone for this draft: ${style.tone.label}.`,
    style.tone.instruction,
    `Voice register for this draft: ${style.voice.label}.`,
    style.voice.instruction,
    "Signal peer expertise with a complete thought that stands alone.",
    "Never invent facts, metrics, credentials, or personal experiences. If a story would require invention, use a different structure.",
    "Do not use generic AI openers or stock parallel constructions; sound like a real peer typing on X.",
    `Desired response: ${outcome}.`
  ].join("\n");
}

/** Let the backend choose a source-aware stance instead of assigning a random persona. */
export function buildTasteAwareReplyInstructions(outcome: string): string {
  return [
    "Choose the stance from the source post and the user's learned taste; do not force a predetermined reply format.",
    "Prefer no reply to applause, restatement, performative expertise, or a question asked only for engagement.",
    "Draft multiple internal candidates for the taste gate, then return only what clears it.",
    "Never invent facts, metrics, credentials, or personal experiences.",
    `Desired response: ${outcome}.`
  ].join("\n");
}

function shuffleCopy<T>(items: readonly T[]): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const left = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = left;
  }
  return pool;
}

export function stableId(prefix = "evt"): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

export function outcomePayloadForEvent(event: ClientEvent): OutcomeRequest | undefined {
  if (event.kind !== "published" || !event.finalText?.trim()) return undefined;
  return {
    status: "published",
    platform: "chrome",
    finalText: event.finalText.trim(),
    clientEventId: event.clientEventId,
    contentKind: event.context.kind,
    ...(event.context.target?.text ? { sourceText: event.context.target.text } : {}),
    ...(event.context.target?.url ? { sourceURL: event.context.target.url } : {}),
    ...(event.externalId ? { externalId: event.externalId } : {}),
    context: {
      kind: event.context.kind,
      ...(event.context.target ? { target: event.context.target } : {}),
      ...(event.context.parent ? { parent: event.context.parent } : {}),
      ...(event.context.quoted ? { quoted: event.context.quoted } : {})
    }
  };
}

export function feedbackPayloadForEvent(event: ClientEvent): FeedbackRequest | undefined {
  if (!event.suggestionId) return undefined;
  const context = {
    sourcePost: event.context.target,
    ...(event.context.parent ? { parentPost: event.context.parent } : {}),
    ...(event.context.quoted ? { quotedPost: event.context.quoted } : {}),
    eventKind: event.kind
  };
  if (event.kind === "skip") {
    return {
      suggestionId: event.suggestionId,
      kind: event.context.kind === "reply" ? "comment" : "post",
      decision: "skipped",
      ...(event.originalText ? { originalText: event.originalText } : {}),
      context
    };
  }
  if (event.kind === "edit" && event.originalText && event.finalText) {
    return {
      suggestionId: event.suggestionId,
      kind: event.context.kind === "reply" ? "comment" : "post",
      decision: "edited",
      originalText: event.originalText,
      finalText: event.finalText,
      context
    };
  }
  if (event.kind === "published" && event.finalText) {
    const originalText = event.originalText?.trim();
    return {
      suggestionId: event.suggestionId,
      kind: event.context.kind === "reply" ? "comment" : "post",
      decision: originalText && originalText !== event.finalText.trim() ? "edited" : "accepted",
      ...(originalText ? { originalText } : {}),
      finalText: event.finalText.trim(),
      context
    };
  }
  return undefined;
}

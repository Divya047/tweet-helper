import { looksLikeCommentBait } from "@tweet-helper/shared";
import type { ComposerKind, PostContext, QueueItem } from "./contracts.js";

export type QueueSort = "newest" | "oldest" | "favorites" | "kind" | "scheduled";
export type ReplyPreset = "taste" | "concise" | "technical" | "pushback" | "question" | "warm";

export interface QueueViewOptions {
  query: string;
  kind: "all" | ComposerKind;
  sort: QueueSort;
  favoritesOnly: boolean;
}

export interface ScanPreferences {
  targetReplies: number;
  maxCandidates: number;
  maxScrolls: number;
  pauseMs: number;
  stagnantLimit: number;
  scrollStepPercent: number;
  minTextLength: number;
  ignoredAuthors: string[];
  blockedTerms: string[];
  includeCommentBait: boolean;
}

export interface ScanFilterStats {
  collected: number;
  kept: number;
  tooShort: number;
  ignoredAuthor: number;
  blockedTerm: number;
  commentBait: number;
}

export interface ScanReport extends ScanFilterStats {
  id: string;
  kind: "replies" | "trends";
  startedAt: string;
  scrolls: number;
  scored: number;
  eligible: number;
  drafted: number;
  queued: number;
  abstained: number;
  stoppedReason?: string;
}

export interface DraftWarning {
  code: "long" | "generic-praise" | "engagement-question" | "claim" | "hashtag-heavy" | "duplicate";
  message: string;
}

export interface SavedTemplate {
  id: string;
  name: string;
  text: string;
  kind: ComposerKind;
  createdAt: number;
}

export interface LocalProfile {
  id: string;
  name: string;
  createdAt: number;
}

export interface WorkspacePreferences {
  scan: ScanPreferences;
  queueSort: QueueSort;
  replyPreset: ReplyPreset;
  warningsEnabled: boolean;
}

export const DEFAULT_SCAN_PREFERENCES: ScanPreferences = {
  targetReplies: 8,
  maxCandidates: 24,
  maxScrolls: 24,
  pauseMs: 650,
  stagnantLimit: 4,
  scrollStepPercent: 65,
  minTextLength: 8,
  ignoredAuthors: [],
  blockedTerms: [],
  includeCommentBait: false
};

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  scan: { ...DEFAULT_SCAN_PREFERENCES },
  queueSort: "newest",
  replyPreset: "taste",
  warningsEnabled: true
};

export function normalizeWorkspacePreferences(value: unknown): WorkspacePreferences {
  const record = value && typeof value === "object" ? value as Partial<WorkspacePreferences> : {};
  const scan: Partial<ScanPreferences> = record.scan && typeof record.scan === "object" ? record.scan : {};
  return {
    scan: {
      targetReplies: clampInteger(scan.targetReplies, 1, 12, DEFAULT_SCAN_PREFERENCES.targetReplies),
      maxCandidates: clampInteger(scan.maxCandidates, 8, 48, DEFAULT_SCAN_PREFERENCES.maxCandidates),
      maxScrolls: clampInteger(scan.maxScrolls, 4, 80, DEFAULT_SCAN_PREFERENCES.maxScrolls),
      pauseMs: clampInteger(scan.pauseMs, 250, 2_000, DEFAULT_SCAN_PREFERENCES.pauseMs),
      stagnantLimit: clampInteger(scan.stagnantLimit, 2, 10, DEFAULT_SCAN_PREFERENCES.stagnantLimit),
      scrollStepPercent: clampInteger(scan.scrollStepPercent, 40, 90, DEFAULT_SCAN_PREFERENCES.scrollStepPercent),
      minTextLength: clampInteger(scan.minTextLength, 1, 40, DEFAULT_SCAN_PREFERENCES.minTextLength),
      ignoredAuthors: normalizeStringList(scan.ignoredAuthors),
      blockedTerms: normalizeStringList(scan.blockedTerms),
      includeCommentBait: typeof scan.includeCommentBait === "boolean" ? scan.includeCommentBait : false
    },
    queueSort: isQueueSort(record.queueSort) ? record.queueSort : DEFAULT_WORKSPACE_PREFERENCES.queueSort,
    replyPreset: isReplyPreset(record.replyPreset) ? record.replyPreset : DEFAULT_WORKSPACE_PREFERENCES.replyPreset,
    warningsEnabled: typeof record.warningsEnabled === "boolean" ? record.warningsEnabled : true
  };
}

export function filterAndSortQueue(items: QueueItem[], options: QueueViewOptions): QueueItem[] {
  const query = options.query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (options.kind !== "all" && item.context.kind !== options.kind) return false;
    if (options.favoritesOnly && !item.favorite) return false;
    if (!query) return true;
    const haystack = [
      item.draft.text,
      item.draft.strategy,
      item.sourceSummary,
      item.context.target?.text,
      item.context.target?.author,
      ...(item.tags ?? [])
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(query);
  });
  return filtered.sort((left, right) => {
    if (options.sort === "oldest") return left.createdAt - right.createdAt;
    if (options.sort === "favorites") return Number(!!right.favorite) - Number(!!left.favorite) || right.createdAt - left.createdAt;
    if (options.sort === "kind") return left.context.kind.localeCompare(right.context.kind) || right.createdAt - left.createdAt;
    if (options.sort === "scheduled") return scheduleTime(left) - scheduleTime(right) || right.createdAt - left.createdAt;
    return right.createdAt - left.createdAt;
  });
}

export function filterScanPosts(posts: PostContext[], preferences: ScanPreferences): { posts: PostContext[]; stats: ScanFilterStats } {
  const ignored = new Set(preferences.ignoredAuthors.map(normalizeAuthor));
  const blocked = preferences.blockedTerms.map((term) => term.toLowerCase()).filter(Boolean);
  const stats: ScanFilterStats = {
    collected: posts.length,
    kept: 0,
    tooShort: 0,
    ignoredAuthor: 0,
    blockedTerm: 0,
    commentBait: 0
  };
  const kept = posts.filter((post) => {
    const text = post.text.trim();
    if (text.length < preferences.minTextLength) {
      stats.tooShort += 1;
      return false;
    }
    if (post.author && ignored.has(normalizeAuthor(post.author))) {
      stats.ignoredAuthor += 1;
      return false;
    }
    const lower = text.toLowerCase();
    if (blocked.some((term) => lower.includes(term))) {
      stats.blockedTerm += 1;
      return false;
    }
    if (!preferences.includeCommentBait && looksLikeCommentBait(text)) {
      stats.commentBait += 1;
      return false;
    }
    return true;
  });
  stats.kept = kept.length;
  return { posts: kept, stats };
}

export function duplicateQueueIds(items: QueueItem[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = normalizeDraft(item.draft.text);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), item.id]);
  }
  return new Set([...groups.values()].filter((ids) => ids.length > 1).flat());
}

export function analyzeDraft(text: string, kind: ComposerKind, duplicate = false): DraftWarning[] {
  const normalized = text.trim();
  const warnings: DraftWarning[] = [];
  if (normalized.length > 280) warnings.push({ code: "long", message: `${normalized.length} characters. Split it before posting.` });
  if (/^(great|love|amazing|excellent) (post|point|take|thread)\b/i.test(normalized)) {
    warnings.push({ code: "generic-praise", message: "Starts with generic praise." });
  }
  if (kind === "reply" && /(?:what do you think|thoughts\?|agree\?)(?:\s+#[\p{L}\p{N}_]+)*\s*$/iu.test(normalized)) {
    warnings.push({ code: "engagement-question", message: "Ends with an engagement-only question." });
  }
  if (/\b(?:always|never|guaranteed|proven|everyone|no one)\b/i.test(normalized) || /\b\d+(?:\.\d+)?%\b/.test(normalized)) {
    warnings.push({ code: "claim", message: "Check the absolute or numeric claim." });
  }
  if ((normalized.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 2) {
    warnings.push({ code: "hashtag-heavy", message: "Uses more than two hashtags." });
  }
  if (duplicate) warnings.push({ code: "duplicate", message: "Duplicates another queued draft." });
  return warnings;
}

export function splitThread(text: string, limit = 280): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= limit) return [normalized];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("; "), window.lastIndexOf(", "), window.lastIndexOf(" "));
    const cut = boundary >= Math.floor(limit * 0.55) ? boundary + (window[boundary] === "." ? 1 : 0) : limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  if (chunks.some((chunk) => chunk.length > limit)) return hardSplit(normalized, limit);
  const total = chunks.length;
  if (total <= 1) return chunks;
  const reserve = String(total).length * 2 + 3;
  if (chunks.some((chunk) => chunk.length + reserve > limit)) return hardSplit(normalized, limit - reserve).map((chunk, index, all) => `${index + 1}/${all.length} ${chunk}`);
  return chunks.map((chunk, index) => `${index + 1}/${total} ${chunk}`);
}

export function replyPresetInstruction(preset: ReplyPreset): string {
  const instructions: Record<ReplyPreset, string> = {
    taste: "Use the learned taste profile and choose the strongest source-aware stance.",
    concise: "Keep it to one or two tight sentences. Cut setup, applause, and repeated context.",
    technical: "Add one exact implementation detail, constraint, or mechanism. Use concrete nouns.",
    pushback: "Qualify or disagree with one clear reason. Stay respectful and do not dunk.",
    question: "Add a useful premise, then ask one specific question that can be answered directly.",
    warm: "Sound supportive and human, then add a specific observation. Avoid generic praise."
  };
  return instructions[preset];
}

export function parseListInput(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function hardSplit(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const boundary = remaining.slice(0, limit + 1).lastIndexOf(" ");
    const cut = boundary >= Math.floor(limit * 0.5) ? boundary : limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))] : [];
}

function normalizeAuthor(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function normalizeDraft(value: string): string {
  return value.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function isQueueSort(value: unknown): value is QueueSort {
  return value === "newest" || value === "oldest" || value === "favorites" || value === "kind" || value === "scheduled";
}

function isReplyPreset(value: unknown): value is ReplyPreset {
  return value === "taste" || value === "concise" || value === "technical" || value === "pushback" || value === "question" || value === "warm";
}

function scheduleTime(item: QueueItem): number {
  const value = item.scheduledFor ? Date.parse(item.scheduledFor) : Number.POSITIVE_INFINITY;
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

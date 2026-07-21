import type { OutcomeRequest } from "@tweet-helper/shared";

export type ComposerKind = "post" | "reply";
export type EventKind = "insert" | "edit" | "skip" | "published";

export interface PostContext { id?: string; author?: string; text: string; url?: string }
export interface ComposerContext {
  kind: ComposerKind;
  currentText: string;
  target?: PostContext;
  parent?: PostContext;
  quoted?: PostContext;
}
export interface Draft { id: string; text: string; strategy?: string; recommended?: boolean }
export interface QueueItem { id: string; draft: Draft; context: ComposerContext; createdAt: number }
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
}
export type ExtensionMessage =
  | { type: "GET_STATE" }
  | { type: "SET_QUEUE"; queue: QueueItem[]; activeQueueItemId?: string }
  | { type: "COMPOSER_CONTEXT" }
  | { type: "GENERATE_AND_INSERT"; context: ComposerContext }
  | { type: "INSERT_QUEUE_NEXT"; item: QueueItem }
  | { type: "RECORD_EVENT"; event: ClientEvent }
  | { type: "OPEN_SIDE_PANEL" }
  | { type: "SCAN_VISIBLE" };

export const BATCH_STRATEGIES = [
  { label: "Direct insight", instruction: "Lead with one crisp, useful insight founders or builders can apply. Do not ask a question.", question: false },
  { label: "Contrarian take", instruction: "Offer a defensible founder/builder contrarian take with reasoning. Do not ask a question.", question: false },
  { label: "Practical example", instruction: "Give one concise shipping or product example with a concrete detail. Do not ask a question.", question: false },
  { label: "Useful checklist", instruction: "Turn the idea into a short useful checklist for builders. Do not ask a question.", question: false },
  { label: "Tradeoff question", instruction: "Share one useful premise about a technical or product tradeoff, then ask one specific question peers can answer in a sentence. Avoid trivia and engagement bait.", question: true },
  { label: "Production lesson", instruction: "Share one useful premise about what broke or surprised you while shipping, then ask one experience-based question peers can answer in a sentence. Avoid trivia and engagement bait.", question: true },
  { label: "Peer recommendation", instruction: "Share one useful premise, then ask peers for one concrete recommendation with context (tool, approach, or pattern). Avoid trivia and engagement bait.", question: true },
  { label: "Concise observation", instruction: "Write one concise, specific observation from building or founding with no question.", question: false }
] as const;

/** Distinct reply structures assigned across a queue batch so drafts do not collapse into one anecdote tone. */
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

/** Shuffle tones once per batch, then rotate — variety without repeating the same structure back-to-back. */
export function assignReplyTones(count: number): Array<(typeof REPLY_TONES)[number]> {
  const pool = [...REPLY_TONES];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const left = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = left;
  }
  return Array.from({ length: count }, (_, index) => pool[index % pool.length]!);
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

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

export function stableId(prefix = "evt"): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

import { dayKey, normalizeActivity } from "./activity.js";
import type { ClientEvent, ExtensionState, QueueItem } from "./contracts.js";
import { stableId } from "./contracts.js";

export const STATE_KEY = "tweet-helper-state-v2";
export const initialState = (): ExtensionState => ({
  sessionId: stableId("session"), queue: [], events: [], activity: { dayKey: dayKey(), posts: 0, replies: 0 }
});

export function normalizeExtensionState(value: Partial<ExtensionState> | undefined): ExtensionState {
  const fallback = initialState();
  const queue = Array.isArray(value?.queue) ? value.queue.filter(validQueueItem) : [];
  return {
    sessionId: typeof value?.sessionId === "string" ? value.sessionId : fallback.sessionId,
    queue,
    ...(queue.some((item) => item.id === value?.activeQueueItemId) ? { activeQueueItemId: value!.activeQueueItemId } : {}),
    events: Array.isArray(value?.events) ? value.events.filter(validEvent).slice(-500) : [],
    activity: normalizeActivity(value?.activity)
  };
}

export async function loadState(): Promise<ExtensionState> {
  const stored = await chrome.storage!.local!.get(STATE_KEY);
  return normalizeExtensionState(stored[STATE_KEY] as Partial<ExtensionState> | undefined);
}
export async function saveState(state: ExtensionState): Promise<void> {
  await chrome.storage!.local!.set({ [STATE_KEY]: normalizeExtensionState(state) });
}
export async function appendEvent(event: ClientEvent): Promise<ExtensionState> {
  const state = await loadState();
  if (state.events.some((item) => item.clientEventId === event.clientEventId)) return state;
  state.events.push(event);
  if (event.kind === "published") {
    if (event.context.kind === "reply") state.activity.replies += 1;
    else state.activity.posts += 1;
  }
  await saveState(state);
  return state;
}

function validQueueItem(value: unknown): value is QueueItem {
  return !!value && typeof value === "object" && typeof (value as QueueItem).id === "string" && typeof (value as QueueItem).draft?.text === "string";
}
function validEvent(value: unknown): value is ClientEvent {
  return !!value && typeof value === "object" && typeof (value as ClientEvent).clientEventId === "string";
}

import { dayKey, normalizeActivity } from "./activity.js";
import type { ClientEvent, ComposerContext, ExtensionState, QueueItem } from "./contracts.js";
import { stableId } from "./contracts.js";

export const STATE_KEY = "tweet-helper-state-v2";
export const ACTIVE_PROFILE_KEY = "tweet-helper-active-profile";
export const DEFAULT_PROFILE_ID = "default";

export function stateKeyForProfile(profileId: string): string {
  return `${STATE_KEY}:${normalizeProfileId(profileId)}`;
}
export const initialState = (): ExtensionState => ({
  sessionId: stableId("session"),
  queue: [],
  events: [],
  activity: { dayKey: dayKey(), posts: 0, replies: 0 },
  activityTracking: "insert"
});

export function normalizeExtensionState(value: Partial<ExtensionState> | undefined): ExtensionState {
  const fallback = initialState();
  const queue = Array.isArray(value?.queue) ? value.queue.filter(validQueueItem) : [];
  const events = Array.isArray(value?.events) ? value.events.filter(validEvent).slice(-500) : [];
  return {
    sessionId: typeof value?.sessionId === "string" ? value.sessionId : fallback.sessionId,
    queue,
    ...(queue.some((item) => item.id === value?.activeQueueItemId) ? { activeQueueItemId: value!.activeQueueItemId } : {}),
    events,
    // Migrate old publish-based totals once, then keep an uncapped persisted insert count.
    activity: value?.activityTracking === "insert"
      ? normalizeActivity(value.activity)
      : activityFromEvents(events),
    activityTracking: "insert"
  };
}

export async function loadState(): Promise<ExtensionState> {
  const profileMeta = await chrome.storage!.local!.get(ACTIVE_PROFILE_KEY);
  const profileId = normalizeProfileId(profileMeta[ACTIVE_PROFILE_KEY]);
  const profileKey = stateKeyForProfile(profileId);
  const profileStored = await chrome.storage!.local!.get(profileKey);
  const legacyStored = profileId === DEFAULT_PROFILE_ID ? await chrome.storage!.local!.get(STATE_KEY) : {};
  const value = profileStored[profileKey]
    ?? legacyStored[STATE_KEY];
  return normalizeExtensionState(value as Partial<ExtensionState> | undefined);
}
export async function saveState(state: ExtensionState): Promise<void> {
  const stored = await chrome.storage!.local!.get(ACTIVE_PROFILE_KEY);
  const profileId = normalizeProfileId(stored[ACTIVE_PROFILE_KEY]);
  const normalized = normalizeExtensionState(state);
  await chrome.storage!.local!.set({
    [stateKeyForProfile(profileId)]: normalized,
    ...(profileId === DEFAULT_PROFILE_ID ? { [STATE_KEY]: normalized } : {})
  });
}
export async function appendEvent(event: ClientEvent): Promise<ExtensionState> {
  const state = await loadState();
  if (state.events.some((item) => item.clientEventId === event.clientEventId)) return state;
  state.events.push(event);
  if (event.kind === "insert") {
    if (activityKindForContext(event.context) === "reply") state.activity.replies += 1;
    else state.activity.posts += 1;
  }
  await saveState(state);
  return state;
}

/** Activity bucket. Trust the context captured by the helper's Insert action. */
export function activityKindForContext(context: ComposerContext): "post" | "reply" {
  return context.kind === "reply" ? "reply" : "post";
}

export function activityFromEvents(events: ClientEvent[], now = new Date()): { dayKey: string; posts: number; replies: number } {
  const today = dayKey(now);
  let posts = 0;
  let replies = 0;
  for (const event of events) {
    if (event.kind !== "insert") continue;
    const occurred = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurred) || dayKey(new Date(occurred)) !== today) continue;
    if (activityKindForContext(event.context) === "reply") replies += 1;
    else posts += 1;
  }
  return { dayKey: today, posts, replies };
}

function validQueueItem(value: unknown): value is QueueItem {
  return !!value && typeof value === "object" && typeof (value as QueueItem).id === "string" && typeof (value as QueueItem).draft?.text === "string";
}
function validEvent(value: unknown): value is ClientEvent {
  return !!value && typeof value === "object" && typeof (value as ClientEvent).clientEventId === "string";
}

function normalizeProfileId(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value) ? value : DEFAULT_PROFILE_ID;
}

import type { ExtensionMessage } from "./contracts.js";
import { feedbackPayloadForEvent, outcomePayloadForEvent } from "./contracts.js";
import { postJson } from "./api.js";
import { appendEvent, loadState, saveState } from "./state.js";

chrome.runtime!.onInstalled!.addListener(() => {
  void chrome.storage!.local!.set({ backendUrl: "http://127.0.0.1:4317" });
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
});

chrome.runtime!.onMessage!.addListener((message: ExtensionMessage, sender, sendResponse) => {
  void handleMessage(message, sender).then(sendResponse, (error: unknown) => sendResponse({ error: error instanceof Error ? error.message : "Request failed" }));
  return true;
});

async function handleMessage(message: ExtensionMessage, sender: { tab?: { id?: number }; documentId?: string }): Promise<unknown> {
  if (message.type === "GET_STATE") return syncEvents(await loadState());
  if (message.type === "SET_QUEUE") {
    const state = await loadState();
    state.queue = message.queue;
    if (message.activeQueueItemId) state.activeQueueItemId = message.activeQueueItemId;
    else delete state.activeQueueItemId;
    await saveState(state);
    return state;
  }
  if (message.type === "RECORD_EVENT") return syncEvents(await appendEvent(message.event));
  if (message.type === "FEED_SCROLL_PROGRESS") return { ok: true };
  if (message.type === "OPEN_SIDE_PANEL" && sender.tab?.id !== undefined) {
    await chrome.sidePanel?.open?.({ tabId: sender.tab.id });
    return { ok: true };
  }
  return { ok: false };
}

async function syncEvents(state: Awaited<ReturnType<typeof loadState>>): Promise<typeof state> {
  let changed = false;
  for (const event of state.events) {
    if (event.syncedAt) continue;
    const outcome = outcomePayloadForEvent(event);
    const feedback = feedbackPayloadForEvent(event);
    if (!outcome && !feedback) {
      event.syncedAt = new Date().toISOString();
      changed = true;
      continue;
    }
    try {
      if (feedback) await postJson("/api/feedback", feedback);
      if (outcome) await postJson("/api/outcomes", outcome);
      event.syncedAt = new Date().toISOString();
      changed = true;
    } catch {
      // Keep the local event pending. GET_STATE and the next event retry it.
    }
  }
  if (changed) await saveState(state);
  return state;
}

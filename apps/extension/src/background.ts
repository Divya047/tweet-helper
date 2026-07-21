import type { ExtensionMessage } from "./contracts.js";
import { outcomePayloadForEvent } from "./contracts.js";
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
  if (message.type === "GET_STATE") return syncPublishedEvents(await loadState());
  if (message.type === "SET_QUEUE") {
    const state = await loadState();
    state.queue = message.queue;
    if (message.activeQueueItemId) state.activeQueueItemId = message.activeQueueItemId;
    else delete state.activeQueueItemId;
    await saveState(state);
    return state;
  }
  if (message.type === "RECORD_EVENT") return syncPublishedEvents(await appendEvent(message.event));
  if (message.type === "OPEN_SIDE_PANEL" && sender.tab?.id !== undefined) {
    await chrome.sidePanel?.open?.({ tabId: sender.tab.id });
    return { ok: true };
  }
  return { ok: false };
}

async function syncPublishedEvents(state: Awaited<ReturnType<typeof loadState>>): Promise<typeof state> {
  let changed = false;
  for (const event of state.events) {
    if (event.syncedAt) continue;
    const payload = outcomePayloadForEvent(event);
    if (!payload) continue;
    try {
      await postJson("/api/outcomes", payload);
      event.syncedAt = new Date().toISOString();
      changed = true;
    } catch {
      // Keep the local event pending. GET_STATE and the next event retry it.
    }
  }
  if (changed) await saveState(state);
  return state;
}

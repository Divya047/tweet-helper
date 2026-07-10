import type { ExtensionMessage } from "./contracts.js";
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
  if (message.type === "GET_STATE") return loadState();
  if (message.type === "SET_QUEUE") {
    const state = await loadState();
    state.queue = message.queue;
    if (message.activeQueueItemId) state.activeQueueItemId = message.activeQueueItemId;
    else delete state.activeQueueItemId;
    await saveState(state);
    return state;
  }
  if (message.type === "RECORD_EVENT") return appendEvent(message.event);
  if (message.type === "OPEN_SIDE_PANEL" && sender.tab?.id !== undefined) {
    await chrome.sidePanel?.open?.({ tabId: sender.tab.id });
    return { ok: true };
  }
  return { ok: false };
}

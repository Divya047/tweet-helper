import type { ApiEnvelope, DraftResponse } from "@tweet-helper/shared";
import { postJson } from "./api.js";
import { activitySnapshot } from "./activity.js";
import type { ComposerContext, Draft, ExtensionMessage, ExtensionState, QueueItem } from "./contracts.js";
import { stableId } from "./contracts.js";

type View = "today" | "queue" | "explore";
let view: View = "today"; let state: ExtensionState; let context: ComposerContext | undefined; let explore: Draft[] = [];
const app = document.getElementById("app")!; const status = document.getElementById("status")!;

void refresh();
document.querySelectorAll<HTMLButtonElement>("nav button").forEach((button) => button.addEventListener("click", () => {
  view = button.dataset.view as View; document.querySelectorAll("nav button").forEach((item) => item.setAttribute("aria-selected", String(item === button))); render();
}));

async function refresh(): Promise<void> {
  state = await chrome.runtime!.sendMessage({ type: "GET_STATE" } satisfies ExtensionMessage);
  const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true });
  if (tab?.id) context = await chrome.tabs!.sendMessage!(tab.id, { type: "COMPOSER_CONTEXT" } satisfies ExtensionMessage).catch(() => undefined);
  render();
}
function render(): void {
  if (view === "today") renderToday(); else if (view === "queue") renderQueue(); else renderExplore();
}
function renderToday(): void {
  const snap = activitySnapshot(state.activity);
  app.innerHTML = `<h1>Today</h1><div class="goals"><div class="card goal"><span>Posts</span><strong>${snap.posts}<small> / ${snap.goals.posts}</small></strong><div class="bar"><i style="width:${snap.postProgress * 100}%"></i></div><span class="muted">Soft goal — keep going if it serves you.</span></div><div class="card goal"><span>Replies</span><strong>${snap.replies}<small> / ${snap.goals.replies}</small></strong><div class="bar"><i style="width:${snap.replyProgress * 100}%"></i></div><span class="muted">Soft goal — never a lockout.</span></div></div><div class="card"><strong>${state.queue.length} queued</strong><span class="muted">Queue and activity persist across tabs and panel reloads.</span></div>`;
}
function renderQueue(): void {
  app.innerHTML = `<h1>Queue</h1>${state.queue.length ? state.queue.map((item, index) => `<article class="card"><strong>${index + 1}. ${escapeHtml(item.draft.text)}</strong><button data-insert="${item.id}" class="primary">Insert next</button><button data-remove="${item.id}">Skip</button></article>`).join("") : `<div class="card muted">No drafts queued. Add a strategy from Explore.</div>`}`;
  app.querySelectorAll<HTMLButtonElement>("[data-insert]").forEach((button) => button.addEventListener("click", () => void insertQueue(button.dataset.insert!)));
  app.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((button) => button.addEventListener("click", () => void removeQueue(button.dataset.remove!)));
}
function renderExplore(): void {
  app.innerHTML = `<h1>Explore</h1><label for="brief">Brief</label><textarea id="brief" placeholder="What do you want to say?">${escapeHtml(context?.currentText ?? "")}</textarea><button id="explore" class="primary">Explore four strategies</button>${explore.map((draft) => `<article class="card ${draft.recommended ? "recommended" : ""}"><span class="strategy">${escapeHtml(draft.strategy ?? "Alternative")}${draft.recommended ? " · Recommended" : ""}</span><strong>${escapeHtml(draft.text)}</strong><button data-add="${draft.id}">Add to queue</button></article>`).join("")}`;
  document.getElementById("explore")?.addEventListener("click", () => void generateExplore());
  app.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((button) => button.addEventListener("click", () => void addQueue(button.dataset.add!)));
}
async function generateExplore(): Promise<void> {
  const brief = (document.getElementById("brief") as HTMLTextAreaElement).value.trim(); if (!brief) return setStatus("Add a brief first.");
  setStatus("Exploring strategies…");
  const labels = ["Direct insight", "Contrarian take", "Practical story", "Open question"];
  const instructions = ["Lead with one crisp, useful insight.", "Offer a defensible contrarian take.", "Tell a concise practical story with a concrete detail.", "Frame one thoughtful open question that invites real answers."];
  const results = await Promise.all(instructions.map((instruction) => postJson<ApiEnvelope<DraftResponse>>("/api/generate/post", { topic: brief, instructions: instruction })));
  explore = results.map((result, i) => ({ id: result.data.suggestions[0]?.id ?? stableId("draft"), text: result.data.suggestions[0]?.text ?? brief, strategy: labels[i]!, recommended: i === 0 }));
  setStatus("Four distinct strategies ready."); renderExplore();
}
async function addQueue(id: string): Promise<void> { const draft = explore.find((item) => item.id === id); if (!draft) return; const item: QueueItem = { id: stableId("queue"), draft, context: context ?? { kind: "post", currentText: "" }, createdAt: Date.now() }; state.queue.push(item); state.activeQueueItemId ??= item.id; await persist(); setStatus("Added to queue."); }
async function insertQueue(id: string): Promise<void> { const item = state.queue.find((entry) => entry.id === id); const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true }); if (!item || !tab?.id) return; await chrome.tabs!.sendMessage!(tab.id, { type: "INSERT_QUEUE_NEXT", item } satisfies ExtensionMessage); state.queue = state.queue.filter((entry) => entry.id !== id); setActiveToFirst(); await persist(); renderQueue(); }
async function removeQueue(id: string): Promise<void> { const skipped = state.queue.find((entry) => entry.id === id); state.queue = state.queue.filter((entry) => entry.id !== id); setActiveToFirst(); if (skipped) await chrome.runtime!.sendMessage({ type: "RECORD_EVENT", event: { clientEventId: stableId("skip"), kind: "skip", occurredAt: new Date().toISOString(), suggestionId: skipped.draft.id, originalText: skipped.draft.text, context: skipped.context } } satisfies ExtensionMessage); await persist(); renderQueue(); }
function setActiveToFirst(): void { const first = state.queue[0]?.id; if (first) state.activeQueueItemId = first; else delete state.activeQueueItemId; }
async function persist(): Promise<void> { const message: ExtensionMessage = { type: "SET_QUEUE", queue: state.queue, ...(state.activeQueueItemId ? { activeQueueItemId: state.activeQueueItemId } : {}) }; state = await chrome.runtime!.sendMessage(message); }
function setStatus(text: string): void { status.textContent = text; }
function escapeHtml(value: string): string { const node = document.createElement("div"); node.textContent = value; return node.innerHTML; }

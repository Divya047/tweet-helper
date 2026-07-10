import type { ApiEnvelope, DraftResponse } from "@tweet-helper/shared";
import { postJson } from "./api.js";
import type { ClientEvent, ComposerContext, ExtensionMessage, QueueItem } from "./contracts.js";
import { stableId } from "./contracts.js";
import { findComposers, getComposerContext, getComposerText, insertTextIntoComposer, isComposerElement } from "./dom.js";
import { hasPublishSuccessEvidence, PublishTracker, statusIdFromUrl } from "./publish.js";

const ACTION_CLASS = "tweet-helper-action";
const UNDO_MS = 10_000;
const tracker = new PublishTracker();
const undoHandlers = new WeakMap<HTMLButtonElement, () => void>();
let focusedComposer: HTMLElement | undefined;
let lastGenerated: { suggestionId: string; originalText: string; insertedText: string; context: ComposerContext } | undefined;

if (location.hostname === "x.com" || location.hostname === "twitter.com") init();

function init(): void {
  enhanceComposers();
  document.addEventListener("focusin", rememberComposer, true);
  document.addEventListener("input", captureEdit, true);
  document.addEventListener("click", observeNativeSubmit, true);
  chrome.runtime!.onMessage!.addListener((message: ExtensionMessage, _sender, respond) => {
    void handleMessage(message).then(respond);
    return true;
  });
  new MutationObserver(() => { enhanceComposers(); observeSuccess(); }).observe(document.documentElement, { childList: true, subtree: true });
}

export function contextualAction(context: ComposerContext, hasActiveQueue: boolean): "Draft reply" | "Improve" | "Open brief" | "Insert next" {
  if (hasActiveQueue) return "Insert next";
  if (context.currentText) return "Improve";
  return context.kind === "reply" ? "Draft reply" : "Open brief";
}

async function enhanceComposers(): Promise<void> {
  const state = await chrome.runtime!.sendMessage({ type: "GET_STATE" } satisfies ExtensionMessage);
  const active = state?.queue?.find((item: QueueItem) => item.id === state.activeQueueItemId) as QueueItem | undefined;
  for (const composer of findComposers()) {
    const parent = composer.parentElement;
    let button = parent?.querySelector<HTMLButtonElement>(`:scope > .${ACTION_CLASS}`);
    if (!parent) continue;
    if (!button) {
      button = document.createElement("button"); button.type = "button"; button.className = ACTION_CLASS;
      button.setAttribute("aria-label", "Tweet Helper composer action");
      button.addEventListener("click", () => { const undo = undoHandlers.get(button!); if (undo) undo(); else void runAction(composer); });
      parent.append(button);
    }
    button.textContent = contextualAction(getComposerContext(composer), !!active);
    Object.assign(button.style, {
      minWidth: "44px", minHeight: "44px", padding: "0 16px", marginTop: "8px", border: "2px solid currentColor",
      borderRadius: "999px", background: "Canvas", color: "CanvasText", font: "700 14px system-ui", cursor: "pointer",
      position: "relative", zIndex: "1", outlineOffset: "3px", maxWidth: "100%"
    });
  }
}

async function runAction(composer: HTMLElement): Promise<void> {
  focusedComposer = composer;
  const state = await chrome.runtime!.sendMessage({ type: "GET_STATE" } satisfies ExtensionMessage);
  const active = state?.queue?.find((item: QueueItem) => item.id === state.activeQueueItemId) as QueueItem | undefined;
  if (active) return insertDraft(composer, active.draft.id, active.draft.text, active.context);
  const context = getComposerContext(composer);
  if (context.kind === "post" && !context.currentText) {
    composer.focus();
    await chrome.runtime!.sendMessage({ type: "OPEN_SIDE_PANEL" } satisfies ExtensionMessage);
    return;
  }
  await generateAndInsert(composer, context);
}

async function generateAndInsert(composer: HTMLElement, context: ComposerContext): Promise<void> {
  const response = context.currentText
    ? await postJson<ApiEnvelope<DraftResponse>>("/api/generate/rewrite", { text: context.currentText, kind: context.kind === "reply" ? "comment" : "post" })
    : await postJson<ApiEnvelope<DraftResponse>>("/api/generate/comment", { sourcePost: context.target, angle: "" });
  const draft = response.data.suggestions[0];
  if (draft) insertDraft(composer, draft.id, draft.text, context);
}

function insertDraft(composer: HTMLElement, suggestionId: string, text: string, context: ComposerContext): void {
  const originalText = getComposerText(composer);
  replaceWithUndo(composer, text);
  lastGenerated = { suggestionId, originalText, insertedText: text, context };
  record("insert", { suggestionId, originalText, finalText: text, context });
  showUndo(composer, originalText);
}

export function replaceWithUndo(composer: HTMLElement, text: string): () => void {
  const original = getComposerText(composer);
  insertTextIntoComposer(composer, text);
  return () => insertTextIntoComposer(composer, original);
}

function showUndo(composer: HTMLElement, originalText: string): void {
  const button = composer.parentElement?.querySelector<HTMLButtonElement>(`.${ACTION_CLASS}`);
  if (!button) return;
  const label = button.textContent; button.textContent = "Undo";
  const undo = () => { insertTextIntoComposer(composer, originalText); button.textContent = label ?? "Improve"; undoHandlers.delete(button); };
  undoHandlers.set(button, undo);
  window.setTimeout(() => { if (button.textContent === "Undo") { button.textContent = contextualAction(getComposerContext(composer), false); undoHandlers.delete(button); } }, UNDO_MS);
}

function rememberComposer(event: FocusEvent): void { if (event.target instanceof Element && isComposerElement(event.target)) focusedComposer = event.target; }
function captureEdit(event: Event): void {
  const composer = event.target instanceof Element && isComposerElement(event.target) ? event.target : undefined;
  if (!composer || !lastGenerated || getComposerText(composer) === lastGenerated.insertedText) return;
  record("edit", { ...lastGenerated, finalText: getComposerText(composer) }); lastGenerated = undefined;
}
function observeNativeSubmit(event: MouseEvent): void {
  const button = (event.target as Element | null)?.closest<HTMLElement>('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
  if (!button || button.getAttribute("aria-disabled") === "true" || !focusedComposer) return;
  const context = getComposerContext(focusedComposer); const finalText = getComposerText(focusedComposer);
  if (!finalText) return;
  tracker.begin({ context, finalText, startedAt: Date.now(), ...(lastGenerated?.suggestionId ? { suggestionId: lastGenerated.suggestionId } : {}) });
  window.setTimeout(() => { if (tracker.pending) tracker.cancel(); }, 15_000);
}
function observeSuccess(): void {
  if (!tracker.pending || !hasPublishSuccessEvidence()) return;
  const event = tracker.confirm(statusIdFromUrl(location.href)); if (event) void chrome.runtime!.sendMessage({ type: "RECORD_EVENT", event });
}
function record(kind: ClientEvent["kind"], values: Omit<ClientEvent, "clientEventId" | "kind" | "occurredAt">): void {
  void chrome.runtime!.sendMessage({ type: "RECORD_EVENT", event: { clientEventId: stableId(), kind, occurredAt: new Date().toISOString(), ...values } });
}
async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  if (message.type === "COMPOSER_CONTEXT") return focusedComposer ? getComposerContext(focusedComposer) : undefined;
  if (message.type === "INSERT_QUEUE_NEXT" && focusedComposer) return insertDraft(focusedComposer, message.item.draft.id, message.item.draft.text, message.item.context);
  if (message.type === "SCAN_VISIBLE") return { ok: true };
  return undefined;
}

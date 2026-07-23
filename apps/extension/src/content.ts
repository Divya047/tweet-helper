import {
  DEFAULT_GROWTH_PREFERENCES,
  type ApiEnvelope,
  type DraftResponse,
  type GrowthPreferences
} from "@tweet-helper/shared";
import { postJson } from "./api.js";
import type { ClientEvent, ComposerContext, ExtensionMessage, QueueItem } from "./contracts.js";
import { assignReplyTones, stableId } from "./contracts.js";
import { expandTruncatedPostText, extractVisiblePosts, collectFeedPosts, findComposers, findTweetArticle, getComposerActionPlacement, getComposerContext, getComposerText, insertTextIntoComposer, isComposerElement } from "./dom.js";
import { hasPublishSuccessEvidence, PublishTracker, statusIdFromUrl } from "./publish.js";

const ACTION_CLASS = "tweet-helper-action";
const GROWTH_STORAGE_KEY = "growthPreferences";
const UNDO_MS = 10_000;
const tracker = new PublishTracker();
const undoHandlers = new WeakMap<HTMLButtonElement, () => void>();
let focusedComposer: HTMLElement | undefined;
let lastGenerated: { suggestionId: string; originalText: string; insertedText: string; context: ComposerContext } | undefined;
let composerObserver: MutationObserver | undefined;
let stopped = false;
let enhancing = false;
let enhanceAgain = false;
let feedScrollAbort: AbortController | undefined;

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
  composerObserver = new MutationObserver(() => { void enhanceComposers(); observeSuccess(); });
  composerObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function stopInvalidatedScript(): void {
  if (stopped) return;
  stopped = true;
  composerObserver?.disconnect();
  document.removeEventListener("focusin", rememberComposer, true);
  document.removeEventListener("input", captureEdit, true);
  document.removeEventListener("click", observeNativeSubmit, true);
}

async function sendRuntimeMessage<T = unknown>(message: ExtensionMessage): Promise<T | undefined> {
  if (stopped) return undefined;
  try {
    return await chrome.runtime!.sendMessage(message) as T;
  } catch (error) {
    // Reloading an unpacked extension invalidates content scripts in existing tabs.
    // Other transient messaging failures must not disable the composer enhancement.
    if (String(error).toLowerCase().includes("extension context invalidated")) stopInvalidatedScript();
    return undefined;
  }
}

export function contextualAction(context: ComposerContext, hasActiveQueue: boolean): "Draft reply" | "Improve" | "Open brief" | "Insert next" {
  if (hasActiveQueue) return "Insert next";
  if (context.currentText) return "Improve";
  return context.kind === "reply" ? "Draft reply" : "Open brief";
}

async function enhanceComposers(): Promise<void> {
  if (stopped) return;
  if (enhancing) { enhanceAgain = true; return; }
  enhancing = true;
  const state = await sendRuntimeMessage<{ queue?: QueueItem[]; activeQueueItemId?: string }>({ type: "GET_STATE" });
  if (stopped) { enhancing = false; return; }
  const active = state?.queue?.find((item: QueueItem) => item.id === state.activeQueueItemId) as QueueItem | undefined;
  for (const composer of findComposers()) {
    const { host, before } = getComposerActionPlacement(composer);
    const container = composer.closest<HTMLElement>('[role="dialog"], article[data-testid="tweet"], article') ?? composer.parentElement;
    let button = host.querySelector<HTMLButtonElement>(`:scope > .${ACTION_CLASS}`)
      ?? container?.querySelector<HTMLButtonElement>(`.${ACTION_CLASS}`);
    if (!button) {
      button = document.createElement("button"); button.type = "button"; button.className = ACTION_CLASS;
      button.setAttribute("aria-label", "Tweet Helper composer action");
      button.addEventListener("click", () => { const undo = undoHandlers.get(button!); if (undo) undo(); else void runAction(composer); });
    }
    if (button.parentElement !== host || (before && button.nextElementSibling !== before)) host.insertBefore(button, before ?? null);
    const label = contextualAction(getComposerContext(composer), !!active);
    if (button.textContent !== label) button.textContent = label;
    Object.assign(button.style, {
      minWidth: "44px", minHeight: "36px", padding: "0 16px", margin: "0 8px 0 0", border: "1px solid currentColor",
      borderRadius: "999px", background: "Canvas", color: "CanvasText", font: "700 14px system-ui", cursor: "pointer",
      position: "relative", zIndex: "1", outlineOffset: "3px", maxWidth: "100%", flexShrink: "0"
    });
  }
  enhancing = false;
  if (enhanceAgain) { enhanceAgain = false; void enhanceComposers(); }
}

async function runAction(composer: HTMLElement): Promise<void> {
  focusedComposer = composer;
  const state = await sendRuntimeMessage<{ queue?: QueueItem[]; activeQueueItemId?: string }>({ type: "GET_STATE" });
  const active = state?.queue?.find((item: QueueItem) => item.id === state.activeQueueItemId) as QueueItem | undefined;
  if (active) return insertDraft(composer, active.draft.id, active.draft.text, active.context);
  await expandTruncatedPostText(composer.closest<HTMLElement>('[role="dialog"], article[data-testid="tweet"], article') ?? document);
  const context = getComposerContext(composer);
  if (context.kind === "post" && !context.currentText) {
    composer.focus();
    await sendRuntimeMessage({ type: "OPEN_SIDE_PANEL" });
    return;
  }
  await generateAndInsert(composer, context);
}

async function generateAndInsert(composer: HTMLElement, context: ComposerContext): Promise<void> {
  const growth = await loadGrowthPreferences();
  const response = context.currentText
    ? await postJson<ApiEnvelope<DraftResponse>>("/api/generate/rewrite", {
        text: context.currentText,
        kind: context.kind === "reply" ? "comment" : "post",
        instructions: `Desired response: ${growth.outcome}. Write for ${growth.audience}.`
      })
    : await postJson<ApiEnvelope<DraftResponse>>("/api/generate/comment", {
        sourcePost: context.target ? {
          ...context.target,
          ...(context.parent ? { parentPost: context.parent } : {}),
          ...(context.quoted ? { quotedPost: context.quoted } : {})
        } : undefined,
        angle: "",
        audience: growth.audience,
        contentPillar: growth.pillar,
        desiredOutcome: growth.outcome,
        instructions: (() => {
          const tone = assignReplyTones(1)[0]!;
          return [
            `Reply tone for this draft: ${tone.label}.`,
            tone.instruction,
            "Signal peer expertise with a complete thought that stands alone.",
            "Never invent facts, metrics, credentials, or personal experiences.",
            `Desired response: ${growth.outcome}.`
          ].join("\n");
        })()
      });
  const draft = response.data.suggestions[0];
  if (draft) insertDraft(composer, draft.id, draft.text, context);
}

async function loadGrowthPreferences(): Promise<GrowthPreferences> {
  try {
    const stored = await chrome.storage!.local!.get(GROWTH_STORAGE_KEY);
    const value = stored[GROWTH_STORAGE_KEY];
    if (!value || typeof value !== "object") return { ...DEFAULT_GROWTH_PREFERENCES };
    const record = value as Record<string, unknown>;
    return {
      audience: typeof record.audience === "string" && record.audience.trim() ? record.audience.trim() : DEFAULT_GROWTH_PREFERENCES.audience,
      pillar: typeof record.pillar === "string" && record.pillar.trim() ? record.pillar.trim() : DEFAULT_GROWTH_PREFERENCES.pillar,
      outcome: typeof record.outcome === "string" && record.outcome.trim() ? record.outcome.trim() : DEFAULT_GROWTH_PREFERENCES.outcome
    };
  } catch {
    return { ...DEFAULT_GROWTH_PREFERENCES };
  }
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
  const button = getComposerActionPlacement(composer).host.querySelector<HTMLButtonElement>(`.${ACTION_CLASS}`);
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
  const event = tracker.confirm(statusIdFromUrl(location.href)); if (event) void sendRuntimeMessage({ type: "RECORD_EVENT", event });
}
function record(kind: ClientEvent["kind"], values: Omit<ClientEvent, "clientEventId" | "kind" | "occurredAt">): void {
  void sendRuntimeMessage({ type: "RECORD_EVENT", event: { clientEventId: stableId(), kind, occurredAt: new Date().toISOString(), ...values } });
}
async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  if (message.type === "COMPOSER_CONTEXT") return focusedComposer ? getComposerContext(focusedComposer) : undefined;
  if (message.type === "INSERT_QUEUE_NEXT" && focusedComposer) return insertDraft(focusedComposer, message.item.draft.id, message.item.draft.text, message.item.context);
  if (message.type === "OPEN_SOURCE_POST") return openSourcePost(message.target);
  if (message.type === "SCAN_VISIBLE") {
    await expandTruncatedPostText(document, true);
    return { posts: extractVisiblePosts() };
  }
  if (message.type === "STOP_FEED_SCROLL") {
    feedScrollAbort?.abort();
    feedScrollAbort = undefined;
    return { stopped: true };
  }
  if (message.type === "COLLECT_FEED_POSTS") {
    feedScrollAbort?.abort();
    const abort = new AbortController();
    feedScrollAbort = abort;
    try {
      return await collectFeedPosts({
        ...(message.excludeIds ? { excludeIds: message.excludeIds } : {}),
        ...(message.maxCandidates !== undefined ? { maxCandidates: message.maxCandidates } : {}),
        ...(message.maxScrolls !== undefined ? { maxScrolls: message.maxScrolls } : {}),
        ...(message.pauseMs !== undefined ? { pauseMs: message.pauseMs } : {}),
        ...(message.stagnantLimit !== undefined ? { stagnantLimit: message.stagnantLimit } : {}),
        ...(message.maxDurationMs !== undefined ? { maxDurationMs: message.maxDurationMs } : {}),
        signal: abort.signal,
        onProgress: message.reportProgress
          ? (progress) => {
              void sendRuntimeMessage({
                type: "FEED_SCROLL_PROGRESS",
                posts: progress.posts,
                scrolls: progress.scrolls,
                elapsedMs: progress.elapsedMs
              });
            }
          : undefined
      });
    } finally {
      if (feedScrollAbort === abort) feedScrollAbort = undefined;
    }
  }
  return undefined;
}

function openSourcePost(target: { id?: string; url?: string; text: string }): { found: boolean } {
  const article = findTweetArticle(document, target);
  if (!article) return { found: false };
  article.scrollIntoView({ behavior: "smooth", block: "center" });
  const previousOutline = article.style.outline;
  const previousOutlineOffset = article.style.outlineOffset;
  article.style.outline = "3px solid Highlight";
  article.style.outlineOffset = "4px";
  window.setTimeout(() => {
    article.style.outline = previousOutline;
    article.style.outlineOffset = previousOutlineOffset;
  }, 2_000);
  return { found: true };
}

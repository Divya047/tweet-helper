import type { ApiEnvelope, DraftResponse, ScoreVisiblePostsResponse, ScoredPost, SourcePost } from "@tweet-helper/shared";
import { postJson } from "./api.js";
import {
  extractVisiblePosts,
  findComposers,
  getComposerText,
  getFocusedComposer,
  getNearestSourcePost,
  insertTextIntoComposer
} from "./dom.js";

const ROOT_ID = "tweet-helper-root";
const INLINE_CLASS = "tweet-helper-inline";

let panelRoot: ShadowRoot | undefined;
let selectedSuggestion: { id: string; kind: "post" | "comment"; text: string; context?: Record<string, unknown> } | undefined;

init();

function init(): void {
  if (!location.hostname.endsWith("x.com") && !location.hostname.endsWith("twitter.com")) {
    return;
  }
  createPanel();
  enhanceComposers();
  const observer = new MutationObserver(() => enhanceComposers());
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function createPanel(): void {
  if (document.getElementById(ROOT_ID)) {
    return;
  }
  const host = document.createElement("div");
  host.id = ROOT_ID;
  document.documentElement.append(host);
  panelRoot = host.attachShadow({ mode: "open" });
  renderPanel({
    status: "Ready. Open a composer or scan visible posts.",
    results: []
  });
}

function renderPanel(state: { status: string; results: string[] }): void {
  if (!panelRoot) {
    return;
  }
  panelRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        width: min(380px, calc(100vw - 36px));
        max-height: min(620px, calc(100vh - 36px));
        overflow: auto;
        box-sizing: border-box;
        padding: 12px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        background: #ffffff;
        color: #111827;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.2);
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .title { font-weight: 750; }
      .controls { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
      button {
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #f8fafc;
        color: #111827;
        cursor: pointer;
        padding: 7px 9px;
        font: inherit;
      }
      button.primary { border-color: #111827; background: #111827; color: #fff; }
      textarea {
        box-sizing: border-box;
        width: 100%;
        min-height: 72px;
        resize: vertical;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 8px;
        font: inherit;
      }
      .status { color: #475569; margin: 6px 0 0; }
      .result {
        border-top: 1px solid #e2e8f0;
        padding-top: 10px;
        margin-top: 10px;
        white-space: pre-wrap;
      }
      .meta { color: #64748b; font-size: 12px; margin-bottom: 5px; }
    </style>
    <div class="panel">
      <div class="top">
        <div class="title">Tweet Helper</div>
        <button id="collapse" title="Hide panel">Hide</button>
      </div>
      <textarea id="topic" placeholder="Topic, angle, or extra instructions"></textarea>
      <div class="controls">
        <button class="primary" id="draftPost">Draft post</button>
        <button id="draftComment">Draft reply</button>
        <button id="scan">Scan visible posts</button>
        <button id="insert">Insert selected</button>
        <button id="copy">Copy selected</button>
        <button id="good">Good</button>
        <button id="bad">Skip</button>
      </div>
      <div class="status">${escapeHtml(state.status)}</div>
      <div id="results">${state.results.join("")}</div>
    </div>
  `;

  panelRoot.getElementById("collapse")?.addEventListener("click", () => {
    const host = document.getElementById(ROOT_ID);
    if (host) {
      host.style.display = "none";
    }
  });
  panelRoot.getElementById("draftPost")?.addEventListener("click", () => void draftPostFromPanel());
  panelRoot.getElementById("draftComment")?.addEventListener("click", () => void draftCommentFromPanel());
  panelRoot.getElementById("scan")?.addEventListener("click", () => void scanVisiblePosts());
  panelRoot.getElementById("insert")?.addEventListener("click", () => insertSelected());
  panelRoot.getElementById("copy")?.addEventListener("click", () => void copySelected());
  panelRoot.getElementById("good")?.addEventListener("click", () => void sendSelectedFeedback("accepted"));
  panelRoot.getElementById("bad")?.addEventListener("click", () => void sendSelectedFeedback("skipped"));
  for (const button of panelRoot.querySelectorAll<HTMLButtonElement>("[data-draft-post]")) {
    button.addEventListener("click", () => void draftCommentForScoredPost(button.dataset.draftPost ?? ""));
  }
  for (const button of panelRoot.querySelectorAll<HTMLButtonElement>("[data-select]")) {
    button.addEventListener("click", () => {
      const text = button.dataset.text ?? "";
      const id = button.dataset.id ?? "";
      const kind = button.dataset.kind === "post" ? "post" : "comment";
      selectedSuggestion = { id, kind, text };
      setStatus(`Selected ${kind} draft.`);
    });
  }
}

function enhanceComposers(): void {
  for (const composer of findComposers()) {
    const parent = composer.parentElement;
    if (!parent || parent.querySelector(`.${INLINE_CLASS}`)) {
      continue;
    }
    const button = document.createElement("button");
    button.className = INLINE_CLASS;
    button.type = "button";
    button.textContent = "Suggest";
    Object.assign(button.style, {
      marginTop: "6px",
      padding: "5px 8px",
      border: "1px solid rgb(203, 213, 225)",
      borderRadius: "6px",
      background: "rgb(248, 250, 252)",
      color: "rgb(17, 24, 39)",
      cursor: "pointer",
      font: "12px system-ui, sans-serif"
    });
    button.addEventListener("click", () => void draftForComposer(composer));
    parent.append(button);
  }
}

async function draftForComposer(composer: HTMLElement): Promise<void> {
  showPanel();
  const sourcePost = getNearestSourcePost(composer);
  if (sourcePost?.text) {
    await generateComment(sourcePost, getComposerText(composer));
    return;
  }
  const topic = getComposerText(composer) || getTopicInput();
  if (!topic) {
    setStatus("Type a topic in the composer or helper panel first.");
    return;
  }
  await generatePost(topic);
}

async function draftPostFromPanel(): Promise<void> {
  const composer = getFocusedComposer();
  const topic = getTopicInput() || (composer ? getComposerText(composer) : "");
  if (!topic) {
    setStatus("Add a topic or type a rough draft in the composer.");
    return;
  }
  await generatePost(topic);
}

async function draftCommentFromPanel(): Promise<void> {
  const composer = getFocusedComposer();
  const topic = getTopicInput();
  const sourcePost = composer ? getNearestSourcePost(composer) : undefined;
  if (!sourcePost?.text && !topic) {
    setStatus("Focus a reply composer or paste the source post/angle in the helper panel.");
    return;
  }
  await generateComment(sourcePost ?? { text: topic }, topic);
}

async function generatePost(topic: string): Promise<void> {
  await withStatus("Generating post drafts...", async () => {
    const response = await postJson<ApiEnvelope<DraftResponse>>("/api/generate/post", {
      topic,
      goal: "authentic",
      length: "short",
      instructions: getTopicInput()
    });
    renderDraftSuggestions(response, "post");
  });
}

async function generateComment(sourcePost: SourcePost, angle?: string): Promise<void> {
  await withStatus("Generating reply drafts...", async () => {
    const response = await postJson<ApiEnvelope<DraftResponse>>("/api/generate/comment", {
      sourcePost,
      angle: angle || getTopicInput(),
      instructions: getTopicInput()
    });
    renderDraftSuggestions(response, "comment", { sourcePostId: sourcePost.id, sourcePostText: sourcePost.text });
  });
}

async function scanVisiblePosts(): Promise<void> {
  await withStatus("Scoring visible posts...", async () => {
    const posts = extractVisiblePosts();
    if (posts.length === 0) {
      setStatus("No visible X posts found in the current viewport.");
      return;
    }
    const response = await postJson<ApiEnvelope<ScoreVisiblePostsResponse>>("/api/score/visible-posts", { posts });
    const byId = new Map(posts.map((post) => [post.id, post]));
    const results = response.data.rankedPosts.map((post) => renderScoredPost(post, byId.get(post.id)));
    renderPanel({
      status: `Scored ${response.data.rankedPosts.length} visible posts. Cached: ${response.meta.cached ? "yes" : "no"}.`,
      results
    });
  });
}

async function draftCommentForScoredPost(id: string): Promise<void> {
  const post = extractVisiblePosts().find((item) => item.id === id);
  if (!post) {
    setStatus("That post is no longer visible. Scan again.");
    return;
  }
  await generateComment(post, getTopicInput());
}

function renderDraftSuggestions(
  response: ApiEnvelope<DraftResponse>,
  kind: "post" | "comment",
  context?: Record<string, unknown>
): void {
  const results = response.data.suggestions.map((suggestion, index) => {
    const encodedText = encodeAttr(suggestion.text);
    return `
      <div class="result">
        <div class="meta">${kind} option ${index + 1} · confidence ${Math.round(suggestion.confidence * 100)}%</div>
        <div>${escapeHtml(suggestion.text)}</div>
        <div class="meta">${escapeHtml(suggestion.rationale)}</div>
        <button data-select data-id="${encodeAttr(suggestion.id)}" data-kind="${kind}" data-text="${encodedText}">Select</button>
      </div>
    `;
  });
  selectedSuggestion = response.data.suggestions[0]
    ? {
        id: response.data.suggestions[0].id,
        kind,
        text: response.data.suggestions[0].text,
        ...(context ? { context } : {})
      }
    : undefined;
  renderPanel({
    status: `Generated ${response.data.suggestions.length} ${kind} drafts. Cached: ${response.meta.cached ? "yes" : "no"}.`,
    results
  });
}

function renderScoredPost(post: ScoredPost, source: SourcePost | undefined): string {
  const score = Math.round(post.score);
  const sourceText = source?.text ? `<div>${escapeHtml(source.text.slice(0, 240))}</div>` : "";
  const risks = post.risks.length ? `<div class="meta">Risks: ${escapeHtml(post.risks.join(", "))}</div>` : "";
  return `
    <div class="result">
      <div class="meta">${score}/100 · ${escapeHtml(post.recommendation)} · @${escapeHtml(source?.author ?? "unknown")}</div>
      ${sourceText}
      <div class="meta">Why: ${escapeHtml(post.reason)}</div>
      <div class="meta">Angle: ${escapeHtml(post.suggestedAngle)}</div>
      ${risks}
      <button data-draft-post="${encodeAttr(post.id)}">Draft reply</button>
    </div>
  `;
}

function insertSelected(): void {
  if (!selectedSuggestion) {
    setStatus("Select a draft first.");
    return;
  }
  const composer = getFocusedComposer();
  if (!composer) {
    setStatus("Focus an X composer first, then insert.");
    return;
  }
  insertTextIntoComposer(composer, selectedSuggestion.text);
  setStatus("Inserted draft into the focused composer. You still approve and post manually.");
}

async function copySelected(): Promise<void> {
  if (!selectedSuggestion) {
    setStatus("Select a draft first.");
    return;
  }
  await navigator.clipboard.writeText(selectedSuggestion.text);
  setStatus("Copied selected draft.");
}

async function sendSelectedFeedback(decision: "accepted" | "skipped"): Promise<void> {
  if (!selectedSuggestion) {
    setStatus("Select a draft first.");
    return;
  }
  await postJson("/api/feedback", {
    suggestionId: selectedSuggestion.id,
    kind: selectedSuggestion.kind,
    decision,
    finalText: decision === "accepted" ? selectedSuggestion.text : undefined,
    context: selectedSuggestion.context
  });
  setStatus(decision === "accepted" ? "Saved as useful feedback." : "Saved as skipped feedback.");
}

async function withStatus(status: string, action: () => Promise<void>): Promise<void> {
  setStatus(status);
  try {
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Request failed.");
  }
}

function showPanel(): void {
  const host = document.getElementById(ROOT_ID);
  if (host) {
    host.style.display = "block";
  } else {
    createPanel();
  }
}

function setStatus(status: string): void {
  if (!panelRoot) {
    return;
  }
  const statusNode = panelRoot.querySelector<HTMLElement>(".status");
  if (statusNode) {
    statusNode.textContent = status;
  }
}

function getTopicInput(): string {
  const topic = panelRoot?.getElementById("topic");
  return topic instanceof HTMLTextAreaElement ? topic.value.trim() : "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char] ?? char;
  });
}

function encodeAttr(value: string): string {
  return escapeHtml(value).replace(/\n/g, "&#10;");
}

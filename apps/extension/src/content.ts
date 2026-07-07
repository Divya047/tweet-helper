import type { ApiEnvelope, DraftResponse, ScoreVisiblePostsResponse, ScoredPost, SourcePost } from "@tweet-helper/shared";
import {
  type ActivitySnapshot,
  formatCountdown,
  getActivitySnapshot,
  getBarColor,
  recordPost,
  recordReply
} from "./activity.js";
import {
  extractVisiblePosts,
  findComposers,
  getComposerText,
  getFocusedComposer,
  getNearestSourcePost,
  isComposerElement,
  insertTextIntoComposer
} from "./dom.js";

const ROOT_ID = "tweet-helper-root";
const LAUNCHER_ID = "tweet-helper-launcher";
const INLINE_CLASS = "tweet-helper-inline";
const DEFAULT_BACKEND_URL = "http://127.0.0.1:4317";

let panelRoot: ShadowRoot | undefined;
let selectedSuggestion: { id: string; kind: "post" | "comment"; text: string; context?: Record<string, unknown> } | undefined;
let lastFocusedComposer: HTMLElement | undefined;
let isBusy = false;
let lastRendered: { status: string; results: string[] } = { status: "", results: [] };
let lastSuggestionById = new Map<
  string,
  { id: string; kind: "post" | "comment"; text: string; context?: Record<string, unknown> }
>();
let activitySnapshot: ActivitySnapshot | undefined;
let activityTimer: number | undefined;
let panelInputs = { topic: "", angle: "", instructions: "" };

init();

async function init(): Promise<void> {
  if (!location.hostname.endsWith("x.com") && !location.hostname.endsWith("twitter.com")) {
    return;
  }
  activitySnapshot = await getActivitySnapshot();
  createPanel();
  enhanceComposers();
  document.addEventListener("focusin", rememberFocusedComposer, true);
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
  lastRendered = state;
  const activityHtml = activitySnapshot ? renderActivitySection(activitySnapshot) : "";
  panelRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        width: min(400px, calc(100vw - 36px));
        max-height: min(680px, calc(100vh - 36px));
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
      .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 8px 0 0; }
      .toggle { display: inline-flex; align-items: center; gap: 6px; color: #334155; font-size: 12px; }
      button {
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #f8fafc;
        color: #111827;
        cursor: pointer;
        padding: 7px 9px;
        font: inherit;
        transition: transform 0.1s ease, opacity 0.15s ease;
      }
      button:active:not([disabled]) { transform: scale(0.97); }
      button[disabled] { opacity: 0.55; cursor: not-allowed; }
      button.primary { border-color: #111827; background: #111827; color: #fff; }
      button.activity-post {
        flex: 1;
        border-color: #3b82f6;
        background: linear-gradient(180deg, #eff6ff 0%, #dbeafe 100%);
        color: #1d4ed8;
        font-weight: 600;
      }
      button.activity-reply {
        flex: 1;
        border-color: #8b5cf6;
        background: linear-gradient(180deg, #f5f3ff 0%, #ede9fe 100%);
        color: #6d28d9;
        font-weight: 600;
      }
      .field { margin: 8px 0 0; }
      .field-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: #64748b;
        margin-bottom: 4px;
      }
      .clear-btn {
        border: none;
        background: transparent;
        color: #94a3b8;
        cursor: pointer;
        padding: 0 4px;
        font-size: 14px;
        line-height: 1;
      }
      .clear-btn:hover { color: #475569; }
      textarea {
        box-sizing: border-box;
        width: 100%;
        min-height: 44px;
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
      .activity {
        margin: 10px 0;
        padding: 10px;
        border-radius: 8px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
      }
      .activity-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .activity-title { font-weight: 650; font-size: 12px; color: #334155; }
      .activity-live {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: #64748b;
      }
      .activity-live::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #22c55e;
      }
      .activity-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .activity-stat {
        padding: 8px;
        border-radius: 6px;
        background: #fff;
        border: 1px solid #e2e8f0;
      }
      .activity-stat.goal-reached { border-color: #d97706; box-shadow: inset 0 0 0 1px rgba(217, 119, 6, 0.15); }
      .activity-stat-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: #64748b;
        margin-bottom: 4px;
      }
      .goal-badge {
        font-size: 10px;
        font-weight: 600;
        color: #b45309;
        background: #fef3c7;
        padding: 1px 5px;
        border-radius: 999px;
      }
      .activity-count { font-size: 20px; font-weight: 750; line-height: 1.1; }
      .activity-count span { font-size: 12px; font-weight: 500; color: #94a3b8; }
      .activity-bar {
        height: 4px;
        border-radius: 999px;
        background: #e2e8f0;
        margin: 6px 0 4px;
        overflow: hidden;
      }
      .activity-bar-fill {
        height: 100%;
        border-radius: 999px;
        transition: width 0.3s ease, background 0.3s ease;
      }
      .activity-window { font-size: 10px; color: #94a3b8; }
      .activity-actions { display: flex; gap: 6px; margin-top: 8px; }
      .cooldown-pill {
        margin-top: 8px;
        padding: 6px 8px;
        border-radius: 6px;
        background: #fffbeb;
        border: 1px solid #fde68a;
        color: #92400e;
        font-size: 11px;
        text-align: center;
      }
    </style>
    <div class="panel">
      <div class="top">
        <div class="title">Tweet Helper</div>
        <button id="collapse" title="Hide panel">Hide</button>
      </div>
      ${activityHtml}
      <div class="field">
        <div class="field-label">Topic <span>For new posts</span></div>
        <textarea id="topic" placeholder="What do you want to post about?">${escapeHtml(panelInputs.topic)}</textarea>
      </div>
      <div class="field">
        <div class="field-label">Angle <span>For replies</span></div>
        <textarea id="angle" placeholder="Your take or reply direction">${escapeHtml(panelInputs.angle)}</textarea>
      </div>
      <div class="field">
        <div class="field-label">
          <span>Instructions</span>
          <button class="clear-btn" id="clearInstructions" type="button" title="Clear instructions" ${panelInputs.instructions ? "" : "hidden"}>×</button>
        </div>
        <textarea id="instructions" placeholder="Tone, constraints, things to include or avoid">${escapeHtml(panelInputs.instructions)}</textarea>
      </div>
      <div class="row">
        <label class="toggle"><input id="cheapMode" type="checkbox" ${getCheapMode() ? "checked" : ""}/> Low cost</label>
        <label class="toggle"><input id="advancedModel" type="checkbox" ${getAdvancedModel() ? "checked" : ""}/> Advanced</label>
        <div class="meta">${isBusy ? "Working…" : "Ready"}</div>
      </div>
      <div class="controls">
        <button class="primary" id="draftPost" ${isBusy ? "disabled" : ""}>Draft post</button>
        <button id="draftComment" ${isBusy ? "disabled" : ""}>Draft reply</button>
        <button id="scan" ${isBusy ? "disabled" : ""}>Scan visible posts</button>
        <button id="insert" ${isBusy ? "disabled" : ""}>Insert selected</button>
        <button id="copy" ${isBusy ? "disabled" : ""}>Copy selected</button>
      </div>
      <div class="status">${escapeHtml(state.status)}</div>
      <div id="results">${state.results.join("")}</div>
    </div>
  `;

  startActivityTimer();

  panelRoot.getElementById("collapse")?.addEventListener("click", () => {
    stopActivityTimer();
    const host = document.getElementById(ROOT_ID);
    if (host) {
      host.style.display = "none";
      showLauncher();
    }
  });
  panelRoot.getElementById("recordPost")?.addEventListener("click", () => void handlePosted());
  panelRoot.getElementById("recordReply")?.addEventListener("click", () => void handleReplied());
  panelRoot.getElementById("draftPost")?.addEventListener("click", () => void draftPostFromPanel());
  panelRoot.getElementById("draftComment")?.addEventListener("click", () => void draftCommentFromPanel());
  panelRoot.getElementById("scan")?.addEventListener("click", () => void scanVisiblePosts());
  panelRoot.getElementById("insert")?.addEventListener("click", () => insertSelected());
  panelRoot.getElementById("copy")?.addEventListener("click", () => void copySelected());
  panelRoot.getElementById("cheapMode")?.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      setCheapMode(target.checked);
    }
  });
  panelRoot.getElementById("advancedModel")?.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      setAdvancedModel(target.checked);
    }
  });
  bindPanelInputs();
  panelRoot.getElementById("clearInstructions")?.addEventListener("click", () => clearInstructions());
  for (const button of panelRoot.querySelectorAll<HTMLButtonElement>("[data-draft-post]")) {
    button.addEventListener("click", () => void draftCommentForScoredPost(button.dataset.draftPost ?? ""));
  }
  for (const button of panelRoot.querySelectorAll<HTMLButtonElement>("[data-select]")) {
    button.addEventListener("click", () => {
      const text = button.dataset.text ?? "";
      const id = button.dataset.id ?? "";
      const kind = button.dataset.kind === "post" ? "post" : "comment";
      const stored = lastSuggestionById.get(id);
      selectedSuggestion = stored ?? { id, kind, text };
      setStatus(`Selected ${kind} draft.`);
    });
  }
  for (const button of panelRoot.querySelectorAll<HTMLButtonElement>("[data-feedback]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.id ?? "";
      const decision = button.dataset.feedback === "accepted" ? "accepted" : "skipped";
      void sendDraftFeedback(id, decision);
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

function rememberFocusedComposer(event: FocusEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (isComposerElement(target)) {
    lastFocusedComposer = target;
  }
}

function getTargetComposer(): HTMLElement | undefined {
  if (lastFocusedComposer?.isConnected) {
    return lastFocusedComposer;
  }
  return getFocusedComposer();
}

async function draftForComposer(composer: HTMLElement): Promise<void> {
  showPanel();
  const sourcePost = getNearestSourcePost(composer);
  if (sourcePost?.text) {
    await generateComment(sourcePost, getComposerText(composer) || getAngleInput());
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
  const composer = getTargetComposer();
  const topic = getTopicInput() || (composer ? getComposerText(composer) : "");
  if (!topic) {
    setStatus("Add a topic or type a rough draft in the composer.");
    return;
  }
  await generatePost(topic);
}

async function draftCommentFromPanel(): Promise<void> {
  const composer = getTargetComposer();
  const angle = getAngleInput();
  const sourcePost = composer ? getNearestSourcePost(composer) : undefined;
  if (!sourcePost?.text && !angle) {
    setStatus("Focus a reply composer or add your angle in the helper panel.");
    return;
  }
  await generateComment(sourcePost ?? { text: angle }, angle);
}

async function generatePost(topic: string): Promise<void> {
  await withStatus("Generating post drafts...", async () => {
    const response = await postJson<ApiEnvelope<DraftResponse>>("/api/generate/post", {
      topic,
      goal: "authentic",
      length: "short",
      instructions: getInstructionsInput(),
      mode: getCheapMode() ? "cheap" : "standard",
      model: getAdvancedModel() ? "advanced" : "standard"
    });
    renderDraftSuggestions(response, "post");
  });
}

async function generateComment(sourcePost: SourcePost, angle?: string): Promise<void> {
  await withStatus("Generating reply drafts...", async () => {
    const response = await postJson<ApiEnvelope<DraftResponse>>("/api/generate/comment", {
      sourcePost,
      angle: angle || getAngleInput(),
      instructions: getInstructionsInput(),
      mode: getCheapMode() ? "cheap" : "standard",
      model: getAdvancedModel() ? "advanced" : "standard"
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
      status: formatMetaStatus(`Scored ${response.data.rankedPosts.length} visible posts.`, response),
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
  await generateComment(post, getAngleInput());
}

function renderDraftSuggestions(
  response: ApiEnvelope<DraftResponse>,
  kind: "post" | "comment",
  context?: Record<string, unknown>
): void {
  lastSuggestionById = new Map(
    response.data.suggestions.map((suggestion) => [
      suggestion.id,
      { id: suggestion.id, kind, text: suggestion.text, ...(context ? { context } : {}) }
    ])
  );
  const results = response.data.suggestions.map((suggestion, index) => {
    const encodedText = encodeAttr(suggestion.text);
    return `
      <div class="result">
        <div class="meta">${kind} option ${index + 1} · confidence ${Math.round(suggestion.confidence * 100)}%</div>
        <div>${escapeHtml(suggestion.text)}</div>
        <div class="meta">${escapeHtml(suggestion.rationale)}</div>
        <div class="controls">
          <button data-select data-id="${encodeAttr(suggestion.id)}" data-kind="${kind}" data-text="${encodedText}">Select</button>
          <button data-feedback="accepted" data-id="${encodeAttr(suggestion.id)}">Good</button>
          <button data-feedback="skipped" data-id="${encodeAttr(suggestion.id)}">Skip</button>
        </div>
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
    status: formatMetaStatus(`Generated ${response.data.suggestions.length} ${kind} drafts.`, response),
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
  const composer = getTargetComposer();
  if (!composer) {
    setStatus("Focus an X composer first, then insert.");
    return;
  }
  insertTextIntoComposer(composer, selectedSuggestion.text);
  clearInstructions();
  setStatus("Inserted draft into the focused composer. You still approve and post manually.");
}

async function copySelected(): Promise<void> {
  if (!selectedSuggestion) {
    setStatus("Select a draft first.");
    return;
  }
  await navigator.clipboard.writeText(selectedSuggestion.text);
  clearInstructions();
  setStatus("Copied selected draft.");
}

async function sendDraftFeedback(id: string, decision: "accepted" | "skipped"): Promise<void> {
  const suggestion = lastSuggestionById.get(id) ?? selectedSuggestion;
  if (!suggestion || !suggestion.id) {
    setStatus("Could not find that draft. Generate drafts again.");
    return;
  }

  await postJson("/api/feedback", {
    suggestionId: suggestion.id,
    kind: suggestion.kind,
    decision,
    originalText: suggestion.text,
    finalText: decision === "accepted" ? suggestion.text : undefined,
    context: suggestion.context
  });
  setStatus(decision === "accepted" ? "Saved feedback: Good." : "Saved feedback: Skip.");
}

async function withStatus(status: string, action: () => Promise<void>): Promise<void> {
  isBusy = true;
  renderPanel({ status, results: lastRendered.results });
  try {
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Request failed.");
  } finally {
    isBusy = false;
    // Re-render once more so buttons/working indicator reflect idle state.
    renderPanel(lastRendered);
  }
}

async function getBackendUrl(): Promise<string> {
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    const stored = await chrome.storage.local.get({ backendUrl: DEFAULT_BACKEND_URL });
    return typeof stored.backendUrl === "string" ? stored.backendUrl : DEFAULT_BACKEND_URL;
  }
  return DEFAULT_BACKEND_URL;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function showPanel(): void {
  const host = document.getElementById(ROOT_ID);
  if (host) {
    host.style.display = "block";
    void refreshActivityView();
  } else {
    void (async () => {
      activitySnapshot = await getActivitySnapshot();
      createPanel();
    })();
  }
  hideLauncher();
}

function showLauncher(): void {
  if (document.getElementById(LAUNCHER_ID)) {
    return;
  }
  const button = document.createElement("button");
  button.id = LAUNCHER_ID;
  button.type = "button";
  button.textContent = "Show Tweet Helper";
  Object.assign(button.style, {
    position: "fixed",
    right: "18px",
    bottom: "18px",
    zIndex: "2147483647",
    border: "1px solid rgb(203, 213, 225)",
    borderRadius: "999px",
    background: "rgb(17, 24, 39)",
    color: "#fff",
    cursor: "pointer",
    padding: "10px 12px",
    font: "13px system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.2)"
  });
  button.addEventListener("click", () => {
    showPanel();
  });
  document.documentElement.append(button);
}

function hideLauncher(): void {
  document.getElementById(LAUNCHER_ID)?.remove();
}

function setStatus(status: string): void {
  if (!panelRoot) {
    return;
  }
  lastRendered = { ...lastRendered, status };
  const statusNode = panelRoot.querySelector<HTMLElement>(".status");
  if (statusNode) {
    statusNode.textContent = status;
  }
}

function getTopicInput(): string {
  const topic = panelRoot?.getElementById("topic");
  return topic instanceof HTMLTextAreaElement ? topic.value.trim() : panelInputs.topic.trim();
}

function getAngleInput(): string {
  const angle = panelRoot?.getElementById("angle");
  return angle instanceof HTMLTextAreaElement ? angle.value.trim() : panelInputs.angle.trim();
}

function getInstructionsInput(): string {
  const instructions = panelRoot?.getElementById("instructions");
  return instructions instanceof HTMLTextAreaElement ? instructions.value.trim() : panelInputs.instructions.trim();
}

function bindPanelInputs(): void {
  for (const id of ["topic", "angle", "instructions"] as const) {
    const el = panelRoot?.getElementById(id);
    if (!(el instanceof HTMLTextAreaElement)) {
      continue;
    }
    el.value = panelInputs[id];
    el.addEventListener("input", () => {
      panelInputs[id] = el.value;
      if (id === "instructions") {
        updateClearInstructionsButton();
      }
    });
  }
}

function updateClearInstructionsButton(): void {
  const button = panelRoot?.getElementById("clearInstructions");
  if (button) {
    button.hidden = !panelInputs.instructions;
  }
}

function clearInstructions(): void {
  panelInputs.instructions = "";
  const instructions = panelRoot?.getElementById("instructions");
  if (instructions instanceof HTMLTextAreaElement) {
    instructions.value = "";
  }
  updateClearInstructionsButton();
}

function formatMetaStatus<T>(base: string, response: ApiEnvelope<T>): string {
  const cost = response.meta.estimatedCostUsd;
  const cached = response.meta.cached ? "yes" : "no";
  return `${base} Cached: ${cached}. Est. $${cost.toFixed(4)} · in ${response.meta.inputTokens} · out ${response.meta.outputTokens}.`;
}

function getCheapMode(): boolean {
  try {
    return localStorage.getItem("tweet-helper-cheap-mode") === "1";
  } catch {
    return false;
  }
}

function setCheapMode(enabled: boolean): void {
  try {
    localStorage.setItem("tweet-helper-cheap-mode", enabled ? "1" : "0");
  } catch {
    // ignore
  }
}

function getAdvancedModel(): boolean {
  try {
    return localStorage.getItem("tweet-helper-advanced-model") === "1";
  } catch {
    return false;
  }
}

function setAdvancedModel(enabled: boolean): void {
  try {
    localStorage.setItem("tweet-helper-advanced-model", enabled ? "1" : "0");
  } catch {
    // ignore
  }
}

function renderActivitySection(snapshot: ActivitySnapshot): string {
  const postRatio = snapshot.dailyPosts / snapshot.limits.dailyPosts;
  const replyRatio = snapshot.dailyReplies / snapshot.limits.dailyReplies;
  const postBarWidth = Math.min(100, postRatio * 100);
  const replyBarWidth = Math.min(100, replyRatio * 100);
  const postBarColor = getBarColor(postRatio);
  const replyBarColor = getBarColor(replyRatio);

  const showCooldown =
    snapshot.windowEndsAt !== null &&
    (!snapshot.canPost || !snapshot.canReply) &&
    Date.now() < snapshot.windowEndsAt;
  const cooldownHtml = showCooldown
    ? `<div class="cooldown-pill" id="activityCooldown">Recharge in ${formatCountdown(snapshot.windowEndsAt! - Date.now())} — pace yourself</div>`
    : "";

  const postGoalBadge = snapshot.postsDailyComplete ? `<span class="goal-badge">Goal reached</span>` : "";
  const replyGoalBadge = snapshot.repliesDailyComplete ? `<span class="goal-badge">Goal reached</span>` : "";

  return `
    <div class="activity" id="activitySection">
      <div class="activity-header">
        <div class="activity-title">Today's Activity</div>
        <div class="activity-live">Live</div>
      </div>
      <div class="activity-stats">
        <div class="activity-stat${snapshot.postsDailyComplete ? " goal-reached" : ""}">
          <div class="activity-stat-label">
            <span>Posts</span>
            ${postGoalBadge}
          </div>
          <div class="activity-count">${snapshot.dailyPosts} <span>/ ${snapshot.limits.dailyPosts}</span></div>
          <div class="activity-bar"><div class="activity-bar-fill" style="width:${postBarWidth}%;background:${postBarColor}"></div></div>
          <div class="activity-window">Window ${snapshot.batchPosts}/${snapshot.limits.batchPosts}</div>
        </div>
        <div class="activity-stat${snapshot.repliesDailyComplete ? " goal-reached" : ""}">
          <div class="activity-stat-label">
            <span>Replies</span>
            ${replyGoalBadge}
          </div>
          <div class="activity-count">${snapshot.dailyReplies} <span>/ ${snapshot.limits.dailyReplies}</span></div>
          <div class="activity-bar"><div class="activity-bar-fill" style="width:${replyBarWidth}%;background:${replyBarColor}"></div></div>
          <div class="activity-window">Window ${snapshot.batchReplies}/${snapshot.limits.batchReplies}</div>
        </div>
      </div>
      <div class="activity-actions">
        <button
          class="activity-post"
          id="recordPost"
          ${!snapshot.canPost || isBusy ? "disabled" : ""}
          title="${escapeHtml(snapshot.postDisabledReason ?? "Log a post you published")}"
        >✓ Posted</button>
        <button
          class="activity-reply"
          id="recordReply"
          ${!snapshot.canReply || isBusy ? "disabled" : ""}
          title="${escapeHtml(snapshot.replyDisabledReason ?? "Log a reply you published")}"
        >✓ Replied</button>
      </div>
      ${cooldownHtml}
    </div>
  `;
}

function startActivityTimer(): void {
  stopActivityTimer();
  activityTimer = window.setInterval(() => {
    void refreshActivityView(true);
  }, 30_000);
}

function stopActivityTimer(): void {
  if (activityTimer !== undefined) {
    window.clearInterval(activityTimer);
    activityTimer = undefined;
  }
}

async function refreshActivityView(quiet = false): Promise<void> {
  const previous = activitySnapshot;
  activitySnapshot = await getActivitySnapshot();

  if (!panelRoot) {
    return;
  }

  const activitySection = panelRoot.getElementById("activitySection");
  if (!activitySection) {
    if (!quiet) {
      renderPanel(lastRendered);
    }
    return;
  }

  const temp = document.createElement("div");
  temp.innerHTML = renderActivitySection(activitySnapshot);
  const nextSection = temp.firstElementChild;
  if (nextSection) {
    activitySection.replaceWith(nextSection);
    panelRoot.getElementById("recordPost")?.addEventListener("click", () => void handlePosted());
    panelRoot.getElementById("recordReply")?.addEventListener("click", () => void handleReplied());
  }

  if (
    previous &&
    activitySnapshot.windowEndsAt &&
    previous.windowEndsAt &&
    activitySnapshot.windowEndsAt <= Date.now() &&
    previous.windowEndsAt > Date.now()
  ) {
    setStatus("Window reset — you're good to go again.");
  }
}

async function handlePosted(): Promise<void> {
  const before = activitySnapshot?.dailyPosts ?? 0;
  activitySnapshot = await recordPost();
  renderPanel({
    status: activitySnapshot.canPost
      ? `Post logged · ${activitySnapshot.dailyPosts}/${activitySnapshot.limits.dailyPosts} today`
      : activitySnapshot.postsDailyComplete
        ? `Daily post goal reached · ${activitySnapshot.dailyPosts}/${activitySnapshot.limits.dailyPosts}`
        : `Post logged · recharge window active`,
    results: lastRendered.results
  });
  if (activitySnapshot.dailyPosts > before && activitySnapshot.postsDailyComplete) {
    setStatus(`Daily post goal reached · ${activitySnapshot.dailyPosts}/${activitySnapshot.limits.dailyPosts}`);
  }
}

async function handleReplied(): Promise<void> {
  const before = activitySnapshot?.dailyReplies ?? 0;
  activitySnapshot = await recordReply();
  renderPanel({
    status: activitySnapshot.canReply
      ? `Reply logged · ${activitySnapshot.dailyReplies}/${activitySnapshot.limits.dailyReplies} today`
      : activitySnapshot.repliesDailyComplete
        ? `Daily reply goal reached · ${activitySnapshot.dailyReplies}/${activitySnapshot.limits.dailyReplies}`
        : `Reply logged · recharge window active`,
    results: lastRendered.results
  });
  if (activitySnapshot.dailyReplies > before && activitySnapshot.repliesDailyComplete) {
    setStatus(`Daily reply goal reached · ${activitySnapshot.dailyReplies}/${activitySnapshot.limits.dailyReplies}`);
  }
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

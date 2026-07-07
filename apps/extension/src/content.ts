import type { ApiEnvelope, DraftResponse, ScoreVisiblePostsResponse, ScoredPost, SourcePost } from "@tweet-helper/shared";
import {
  type ActivitySnapshot,
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
let panelMode: "post" | "reply" | "scan" = "post";

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
  const hasResults = state.results.length > 0;
  const busyLabel = isBusy ? "Working" : "Ready";
  const hasSelection = Boolean(selectedSuggestion);
  const canUseSelection = hasSelection && !isBusy;
  panelRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483647;
        width: min(424px, calc(100vw - 32px));
        max-height: min(760px, calc(100vh - 32px));
        overflow: auto;
        padding: 14px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.94);
        color: #0f172a;
        box-shadow: 0 24px 70px rgba(15, 23, 42, 0.24), 0 2px 10px rgba(15, 23, 42, 0.08);
        font: 13px/1.38 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        letter-spacing: 0;
        backdrop-filter: blur(24px) saturate(1.35);
        -webkit-backdrop-filter: blur(24px) saturate(1.35);
      }
      .panel::-webkit-scrollbar { width: 10px; }
      .panel::-webkit-scrollbar-thumb { background: rgba(100, 116, 139, 0.28); border: 3px solid transparent; border-radius: 999px; background-clip: padding-box; }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
      .brand { min-width: 0; }
      .title { font-size: 15px; font-weight: 760; line-height: 1.15; color: #0f172a; }
      .subtitle { margin-top: 2px; color: #64748b; font-size: 11px; }
      .top-actions { display: inline-flex; align-items: center; gap: 8px; }
      .status-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        border-radius: 999px;
        background: rgba(241, 245, 249, 0.9);
        color: #475569;
        font-size: 11px;
        font-weight: 650;
        white-space: nowrap;
      }
      .status-chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: ${isBusy ? "#f59e0b" : "#22c55e"}; }
      .section { margin-top: 12px; }
      .section-title { margin: 0 0 8px; color: #334155; font-size: 12px; font-weight: 720; }
      .mode-tabs {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 4px;
        padding: 4px;
        border: 1px solid rgba(203, 213, 225, 0.78);
        border-radius: 8px;
        background: rgba(248, 250, 252, 0.82);
      }
      .mode-tab {
        min-height: 32px;
        border-color: transparent;
        background: transparent;
        box-shadow: none;
      }
      .mode-tab[aria-pressed="true"] {
        background: #fff;
        border-color: rgba(148, 163, 184, 0.4);
        box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
      }
      .controls { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 0; }
      .primary-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
      .utility-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 8px; }
      .settings-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-top: 8px;
        padding: 8px;
        border: 1px solid rgba(203, 213, 225, 0.8);
        border-radius: 8px;
        background: rgba(248, 250, 252, 0.76);
      }
      .toggle { display: inline-flex; align-items: center; gap: 7px; color: #475569; font-size: 12px; font-weight: 590; }
      .toggle input { accent-color: #0f172a; }
      button {
        min-height: 34px;
        border: 1px solid rgba(203, 213, 225, 0.95);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.82);
        color: #0f172a;
        cursor: pointer;
        padding: 7px 10px;
        font: inherit;
        font-weight: 650;
        transition: transform 0.12s ease, opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease;
      }
      button:hover:not([disabled]) { background: #f8fafc; border-color: #94a3b8; }
      button:active:not([disabled]) { transform: scale(0.97); }
      button[disabled] { opacity: 0.55; cursor: not-allowed; }
      button.is-selected { border-color: #2563eb; background: #eff6ff; color: #1d4ed8; }
      button.primary { min-height: 40px; border-color: #0f172a; background: #0f172a; color: #fff; box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18); }
      button.primary:hover:not([disabled]) { background: #1e293b; border-color: #1e293b; }
      button.icon { width: 32px; min-height: 32px; padding: 0; border-radius: 999px; color: #64748b; }
      button.ghost { background: transparent; border-color: transparent; color: #64748b; }
      button.activity-post {
        flex: 1;
        border-color: rgba(37, 99, 235, 0.22);
        background: #eff6ff;
        color: #1d4ed8;
      }
      button.activity-reply {
        flex: 1;
        border-color: rgba(124, 58, 237, 0.22);
        background: #f5f3ff;
        color: #6d28d9;
      }
      .field { margin: 9px 0 0; }
      .field[hidden], .mode-actions[hidden] { display: none; }
      .field-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: #64748b;
        margin-bottom: 5px;
        font-weight: 680;
      }
      .field-label span:last-child { font-weight: 560; color: #94a3b8; }
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
        min-height: 50px;
        resize: vertical;
        border: 1px solid rgba(203, 213, 225, 0.95);
        border-radius: 8px;
        padding: 9px 10px;
        background: rgba(255, 255, 255, 0.9);
        color: #0f172a;
        font: inherit;
        outline: none;
        transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
      }
      textarea:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12); background: #fff; }
      textarea::placeholder { color: #94a3b8; }
      .status {
        margin: 10px 0 0;
        padding: 9px 10px;
        border-radius: 8px;
        background: rgba(248, 250, 252, 0.86);
        color: #475569;
        font-size: 12px;
      }
      .selection-note {
        margin-top: 8px;
        color: ${hasSelection ? "#2563eb" : "#94a3b8"};
        font-size: 11px;
        font-weight: 650;
      }
      .results { display: grid; gap: 10px; margin-top: 10px; }
      .result {
        border: 1px solid rgba(226, 232, 240, 0.95);
        border-radius: 8px;
        padding: 11px;
        background: rgba(255, 255, 255, 0.78);
        white-space: pre-wrap;
      }
      .result.selected { border-color: rgba(37, 99, 235, 0.6); box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.16); }
      .result-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
      .result-title { color: #334155; font-weight: 720; font-size: 12px; }
      .draft-text { color: #0f172a; font-size: 13px; line-height: 1.45; }
      .meta { color: #64748b; font-size: 11px; margin-top: 6px; }
      .badge { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 7px; border-radius: 999px; background: #f1f5f9; color: #475569; font-size: 11px; font-weight: 680; white-space: nowrap; }
      .score-badge { background: #ecfdf5; color: #047857; }
      .risk-badge { background: #fff7ed; color: #c2410c; margin-right: 4px; }
      .activity {
        margin: 12px 0 0;
        padding: 10px;
        border-radius: 8px;
        background: rgba(248, 250, 252, 0.82);
        border: 1px solid rgba(226, 232, 240, 0.95);
      }
      .activity-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .activity-title { font-weight: 720; font-size: 12px; color: #334155; }
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
        background: rgba(255, 255, 255, 0.82);
        border: 1px solid rgba(226, 232, 240, 0.95);
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
      .activity-count { font-size: 20px; font-weight: 760; line-height: 1.1; }
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
      .empty {
        margin-top: 10px;
        padding: 13px;
        border: 1px dashed rgba(148, 163, 184, 0.65);
        border-radius: 8px;
        color: #64748b;
        background: rgba(248, 250, 252, 0.52);
        font-size: 12px;
      }
      @media (prefers-color-scheme: dark) {
        .panel { background: rgba(15, 23, 42, 0.92); border-color: rgba(148, 163, 184, 0.22); color: #e2e8f0; box-shadow: 0 24px 70px rgba(0, 0, 0, 0.46), 0 2px 10px rgba(0, 0, 0, 0.24); }
        .title, .draft-text, button { color: #e2e8f0; }
        .subtitle, .meta, .field-label, .toggle, .status, .activity-live { color: #94a3b8; }
        .section-title, .activity-title, .result-title { color: #cbd5e1; }
        .status-chip, .settings-row, .status, .activity, .empty { background: rgba(30, 41, 59, 0.72); border-color: rgba(148, 163, 184, 0.2); }
        .mode-tabs { background: rgba(30, 41, 59, 0.72); border-color: rgba(148, 163, 184, 0.2); }
        .mode-tab[aria-pressed="true"] { background: rgba(15, 23, 42, 0.92); border-color: rgba(148, 163, 184, 0.32); box-shadow: none; }
        textarea, .result, .activity-stat, button { background: rgba(15, 23, 42, 0.72); border-color: rgba(148, 163, 184, 0.24); color: #e2e8f0; }
        .result.selected { border-color: rgba(96, 165, 250, 0.7); box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.18); }
        textarea:focus { background: rgba(15, 23, 42, 0.92); }
        button:hover:not([disabled]) { background: rgba(30, 41, 59, 0.92); border-color: rgba(203, 213, 225, 0.36); }
        button.primary { background: #f8fafc; border-color: #f8fafc; color: #0f172a; }
        .badge { background: rgba(51, 65, 85, 0.9); color: #cbd5e1; }
      }
    </style>
    <div class="panel">
      <div class="top">
        <div class="brand">
          <div class="title">Tweet Helper</div>
          <div class="subtitle">Draft faster. Approve everything.</div>
        </div>
        <div class="top-actions">
          <div class="status-chip">${busyLabel}</div>
          <button class="icon" id="collapse" title="Hide panel" aria-label="Hide panel">×</button>
        </div>
      </div>
      <div class="section">
        <div class="mode-tabs" role="group" aria-label="Tweet Helper mode">
          <button class="mode-tab" data-mode="post" aria-pressed="${panelMode === "post"}">Post</button>
          <button class="mode-tab" data-mode="reply" aria-pressed="${panelMode === "reply"}">Reply</button>
          <button class="mode-tab" data-mode="scan" aria-pressed="${panelMode === "scan"}">Scan</button>
        </div>
        <div class="field" ${panelMode === "post" ? "" : "hidden"}>
          <div class="field-label">Topic <span>New post</span></div>
          <textarea id="topic" placeholder="What should this post say?">${escapeHtml(panelInputs.topic)}</textarea>
        </div>
        <div class="field" ${panelMode === "reply" ? "" : "hidden"}>
          <div class="field-label">Reply angle <span>Focused composer</span></div>
          <textarea id="angle" placeholder="Your take, counterpoint, or direction">${escapeHtml(panelInputs.angle)}</textarea>
        </div>
        <div class="field" ${panelMode === "scan" ? "hidden" : ""}>
          <div class="field-label">
            <span>Instructions</span>
            <button class="clear-btn" id="clearInstructions" type="button" title="Clear instructions" ${panelInputs.instructions ? "" : "hidden"}>×</button>
          </div>
          <textarea id="instructions" placeholder="Tone, constraints, things to include or avoid">${escapeHtml(panelInputs.instructions)}</textarea>
        </div>
        <div class="primary-actions mode-actions" ${panelMode === "post" ? "" : "hidden"}>
          <button class="primary" id="draftPost" ${isBusy ? "disabled" : ""}>Draft post</button>
          <button id="scanFromPost" ${isBusy ? "disabled" : ""}>Scan posts</button>
        </div>
        <div class="primary-actions mode-actions" ${panelMode === "reply" ? "" : "hidden"}>
          <button class="primary" id="draftComment" ${isBusy ? "disabled" : ""}>Draft reply</button>
          <button id="scanFromReply" ${isBusy ? "disabled" : ""}>Scan posts</button>
        </div>
        <div class="primary-actions mode-actions" ${panelMode === "scan" ? "" : "hidden"}>
          <button class="primary" id="scan" ${isBusy ? "disabled" : ""}>Scan visible posts</button>
          <button id="draftCommentFromScan" ${isBusy ? "disabled" : ""}>Draft reply</button>
        </div>
      </div>
      <div class="section">
        <div class="utility-actions">
          <button id="insert" ${canUseSelection ? "" : "disabled"}>Insert</button>
          <button id="copy" ${canUseSelection ? "" : "disabled"}>Copy</button>
          <button id="clearSelection" ${hasSelection && !isBusy ? "" : "disabled"}>Clear</button>
        </div>
        <div class="selection-note">${hasSelection ? `Selected ${selectedSuggestion!.kind === "post" ? "post" : "reply"} draft` : "Select a draft to unlock insert and copy"}</div>
        <div class="settings-row">
          <label class="toggle"><input id="cheapMode" type="checkbox" ${getCheapMode() ? "checked" : ""}/> Low cost</label>
          <label class="toggle"><input id="advancedModel" type="checkbox" ${getAdvancedModel() ? "checked" : ""}/> Advanced model</label>
        </div>
      </div>
      <div class="status">${escapeHtml(state.status)}</div>
      <div id="results" class="results">${hasResults ? state.results.join("") : `<div class="empty">Drafts and scanned opportunities will appear here. Focus a composer for replies, or add a topic for a new post.</div>`}</div>
      ${activityHtml}
    </div>
  `;

  applySelectedDraftUi();
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
  panelRoot.getElementById("draftCommentFromScan")?.addEventListener("click", () => void draftCommentFromPanel());
  panelRoot.getElementById("scan")?.addEventListener("click", () => void scanVisiblePosts());
  panelRoot.getElementById("scanFromPost")?.addEventListener("click", () => void scanVisiblePosts());
  panelRoot.getElementById("scanFromReply")?.addEventListener("click", () => void scanVisiblePosts());
  panelRoot.getElementById("insert")?.addEventListener("click", () => insertSelected());
  panelRoot.getElementById("copy")?.addEventListener("click", () => void copySelected());
  panelRoot.getElementById("clearSelection")?.addEventListener("click", () => clearSelectedSuggestion());
  for (const button of panelRoot.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      if (mode === "post" || mode === "reply" || mode === "scan") {
        panelMode = mode;
        renderPanel(lastRendered);
      }
    });
  }
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
      renderPanel({ ...lastRendered, status: `Selected ${kind} draft.` });
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
      marginTop: "8px",
      minHeight: "30px",
      padding: "5px 11px",
      border: "1px solid rgba(148, 163, 184, 0.45)",
      borderRadius: "999px",
      background: "rgba(255, 255, 255, 0.9)",
      color: "rgb(15, 23, 42)",
      cursor: "pointer",
      font: "600 12px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", sans-serif",
      boxShadow: "0 6px 18px rgba(15, 23, 42, 0.12)",
      backdropFilter: "blur(18px) saturate(1.2)"
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
    panelMode = "reply";
    await generateComment(sourcePost, getComposerText(composer) || getAngleInput());
    return;
  }
  const topic = getComposerText(composer) || getTopicInput();
  if (!topic) {
    setStatus("Type a topic in the composer or helper panel first.");
    return;
  }
  panelMode = "post";
  await generatePost(topic);
}

async function draftPostFromPanel(): Promise<void> {
  panelMode = "post";
  const composer = getTargetComposer();
  const topic = getTopicInput() || (composer ? getComposerText(composer) : "");
  if (!topic) {
    setStatus("Add a topic or type a rough draft in the composer.");
    return;
  }
  await generatePost(topic);
}

async function draftCommentFromPanel(): Promise<void> {
  panelMode = "reply";
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
  panelMode = "scan";
  selectedSuggestion = undefined;
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
  panelMode = "reply";
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
  selectedSuggestion = response.data.suggestions[0]
    ? {
        id: response.data.suggestions[0].id,
        kind,
        text: response.data.suggestions[0].text,
        ...(context ? { context } : {})
      }
    : undefined;
  const results = response.data.suggestions.map((suggestion, index) => {
    const encodedText = encodeAttr(suggestion.text);
    const confidence = Math.round(suggestion.confidence * 100);
    const kindLabel = kind === "post" ? "Post" : "Reply";
    return `
      <div class="result">
        <div class="result-head">
          <div class="result-title">${kindLabel} option ${index + 1}</div>
          <span class="badge">${confidence}%</span>
        </div>
        <div class="draft-text">${escapeHtml(suggestion.text)}</div>
        <div class="meta">${escapeHtml(suggestion.rationale)}</div>
        <div class="controls">
          <button class="primary" data-select data-id="${encodeAttr(suggestion.id)}" data-kind="${kind}" data-text="${encodedText}">Select</button>
          <button data-feedback="accepted" data-id="${encodeAttr(suggestion.id)}">Good</button>
          <button data-feedback="skipped" data-id="${encodeAttr(suggestion.id)}">Skip</button>
        </div>
      </div>
    `;
  });
  renderPanel({
    status: formatMetaStatus(`Generated ${response.data.suggestions.length} ${kind} drafts.`, response),
    results
  });
}

function renderScoredPost(post: ScoredPost, source: SourcePost | undefined): string {
  const score = Math.round(post.score);
  const sourceText = source?.text ? `<div class="draft-text">${escapeHtml(source.text.slice(0, 240))}</div>` : "";
  const risks = post.risks.length
    ? `<div class="meta">${post.risks.map((risk) => `<span class="risk-badge">${escapeHtml(risk)}</span>`).join("")}</div>`
    : "";
  return `
    <div class="result">
      <div class="result-head">
        <div class="result-title">@${escapeHtml(source?.author ?? "unknown")} · ${escapeHtml(post.recommendation)}</div>
        <span class="badge score-badge">${score}/100</span>
      </div>
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

function clearSelectedSuggestion(): void {
  selectedSuggestion = undefined;
  renderPanel({ ...lastRendered, status: "Selection cleared." });
}

function applySelectedDraftUi(): void {
  if (!panelRoot) {
    return;
  }

  for (const button of panelRoot.querySelectorAll<HTMLButtonElement>("[data-select]")) {
    const isSelected = Boolean(selectedSuggestion?.id && button.dataset.id === selectedSuggestion.id);
    const result = button.closest(".result");
    result?.classList.toggle("selected", isSelected);
    button.classList.toggle("is-selected", isSelected);
    button.classList.toggle("primary", !isSelected);
    button.textContent = isSelected ? "Selected" : "Select";
  }
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

async function postJson<T>(path: string, body: unknown): Promise<T> {
  try {
    const backendUrl = await getBackendUrl();
    const response = await fetch(`${backendUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const json = (await response.json().catch(() => null)) as T | { error?: { message?: string } } | null;
    if (!response.ok) {
      const message = isErrorResponse(json) ? json.error?.message : undefined;
      throw new Error(message ?? `Backend request failed with HTTP ${response.status}.`);
    }
    return json as T;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Could not reach the local backend. Start it, then check the extension backend URL.");
    }
    throw error;
  }
}

async function getBackendUrl(): Promise<string> {
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    const stored = await chrome.storage.local.get({ backendUrl: DEFAULT_BACKEND_URL });
    return typeof stored.backendUrl === "string" ? stored.backendUrl : DEFAULT_BACKEND_URL;
  }
  return DEFAULT_BACKEND_URL;
}

function isErrorResponse(value: unknown): value is { error?: { message?: string } } {
  return typeof value === "object" && value !== null && "error" in value;
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
  const isDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const button = document.createElement("button");
  button.id = LAUNCHER_ID;
  button.type = "button";
  button.title = "Show Tweet Helper";
  button.setAttribute("aria-label", "Show Tweet Helper");
  button.innerHTML = `
    <span class="tweet-helper-launcher-mark">TH</span>
    <span class="tweet-helper-launcher-label">Tweet Helper</span>
  `;
  Object.assign(button.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    zIndex: "2147483647",
    display: "inline-flex",
    alignItems: "center",
    gap: "9px",
    width: "auto",
    maxWidth: "calc(100vw - 32px)",
    height: "44px",
    border: isDark ? "1px solid rgba(148, 163, 184, 0.24)" : "1px solid rgba(15, 23, 42, 0.12)",
    borderRadius: "999px",
    background: isDark ? "rgba(15, 23, 42, 0.92)" : "rgba(255, 255, 255, 0.94)",
    color: isDark ? "rgb(226, 232, 240)" : "rgb(15, 23, 42)",
    cursor: "pointer",
    padding: "0 13px 0 6px",
    font: "700 13px/1 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", sans-serif",
    letterSpacing: "0",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.2), 0 2px 8px rgba(15, 23, 42, 0.08)",
    backdropFilter: "blur(18px) saturate(1.25)",
    WebkitBackdropFilter: "blur(18px) saturate(1.25)",
    transition: "transform 0.14s ease, box-shadow 0.14s ease, background 0.14s ease"
  });
  const mark = button.querySelector<HTMLElement>(".tweet-helper-launcher-mark");
  if (mark) {
    Object.assign(mark.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "32px",
      height: "32px",
      borderRadius: "999px",
      background: isDark ? "rgb(248, 250, 252)" : "rgb(15, 23, 42)",
      color: isDark ? "rgb(15, 23, 42)" : "#fff",
      fontSize: "11px",
      fontWeight: "800",
      flex: "0 0 auto"
    });
  }
  const label = button.querySelector<HTMLElement>(".tweet-helper-launcher-label");
  if (label) {
    Object.assign(label.style, {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    });
  }
  button.addEventListener("mouseenter", () => {
    button.style.transform = "translateY(-1px)";
    button.style.boxShadow = "0 20px 46px rgba(15, 23, 42, 0.24), 0 3px 10px rgba(15, 23, 42, 0.1)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.transform = "translateY(0)";
    button.style.boxShadow = "0 16px 40px rgba(15, 23, 42, 0.2), 0 2px 8px rgba(15, 23, 42, 0.08)";
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
        </div>
        <div class="activity-stat${snapshot.repliesDailyComplete ? " goal-reached" : ""}">
          <div class="activity-stat-label">
            <span>Replies</span>
            ${replyGoalBadge}
          </div>
          <div class="activity-count">${snapshot.dailyReplies} <span>/ ${snapshot.limits.dailyReplies}</span></div>
          <div class="activity-bar"><div class="activity-bar-fill" style="width:${replyBarWidth}%;background:${replyBarColor}"></div></div>
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

}

async function handlePosted(): Promise<void> {
  const before = activitySnapshot?.dailyPosts ?? 0;
  activitySnapshot = await recordPost();
  renderPanel({
    status: activitySnapshot.canPost
      ? `Post logged · ${activitySnapshot.dailyPosts}/${activitySnapshot.limits.dailyPosts} today`
      : activitySnapshot.postsDailyComplete
        ? `Daily post goal reached · ${activitySnapshot.dailyPosts}/${activitySnapshot.limits.dailyPosts}`
        : `Post limit reached`,
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
        : `Reply limit reached`,
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

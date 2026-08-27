import {
  DEFAULT_GROWTH_PREFERENCES,
  type ApiEnvelope,
  type DesiredOutcome,
  type DraftResponse,
  type GrowthPreferences,
  type ScoreVisiblePostsResponse
} from "@tweet-helper/shared";
import { LONG_REQUEST_TIMEOUT_MS, postJson } from "./api.js";
import { normalizeActivity } from "./activity.js";
import type { ComposerContext, Draft, ExtensionMessage, ExtensionState, FeedTrend, OpportunityLaneStats, PostContext, QueueInsertResult, QueueItem } from "./contracts.js";
import {
  buildTasteAwareReplyInstructions,
  buildSingleTrendBrief,
  deriveFeedTrends,
  emptyOpportunityLaneStats,
  mapNativeExplore,
  nextOpportunityWave,
  samplePostsForScoring,
  selectOpportunityMix,
  sourcePostUrl,
  stableId,
  TREND_SCAN,
  updateQueuedDraft,
  recordOpportunityOutcome
} from "./contracts.js";
import {
  analyzeDraft,
  DEFAULT_WORKSPACE_PREFERENCES,
  duplicateQueueIds,
  filterAndSortQueue,
  filterScanPosts,
  normalizeWorkspacePreferences,
  parseListInput,
  replyPresetInstruction,
  splitThread,
  type QueueSort,
  type ReplyPreset,
  type LocalProfile,
  type SavedTemplate,
  type ScanReport,
  type WorkspacePreferences
} from "./workspace.js";
import { ACTIVE_PROFILE_KEY, DEFAULT_PROFILE_ID, stateKeyForProfile } from "./state.js";

const GROWTH_STORAGE_KEY = "growthPreferences";
const OPPORTUNITY_STATS_STORAGE_KEY = "opportunityLaneStats";
const WORKSPACE_PREFERENCES_KEY = "workspacePreferences";
const SCAN_HISTORY_KEY = "scanHistory";
const TEMPLATES_KEY = "savedTemplates";
const PROFILE_CATALOG_KEY = "tweet-helper-profiles";

type View = "today" | "queue" | "explore" | "tools";

let view: View = "today";
let state: ExtensionState;
let context: ComposerContext | undefined;
let explore: Draft[] = [];
let trends: FeedTrend[] = [];
let exploreBrief = "";
let trendScanning = false;
let editingQueueItemId: string | undefined;
let growth: GrowthPreferences = { ...DEFAULT_GROWTH_PREFERENCES };
let opportunityStats: OpportunityLaneStats = emptyOpportunityLaneStats();
let workspacePreferences: WorkspacePreferences = structuredClone(DEFAULT_WORKSPACE_PREFERENCES);
let scanHistory: ScanReport[] = [];
let templates: SavedTemplate[] = [];
let profiles: LocalProfile[] = [{ id: DEFAULT_PROFILE_ID, name: "Default", createdAt: 0 }];
let activeProfileId = DEFAULT_PROFILE_ID;
let queueQuery = "";
let queueKind: "all" | "post" | "reply" = "all";
let favoritesOnly = false;
const app = document.getElementById("app")!;
const status = document.getElementById("status")!;

chrome.runtime!.onMessage!.addListener((message: ExtensionMessage) => {
  if (message.type !== "FEED_SCROLL_PROGRESS" || !trendScanning) return;
  const seconds = Math.round(message.elapsedMs / 1000);
  setStatus(`Scrolling feed… ${message.posts} posts · ${message.scrolls} scrolls · ${seconds}s`);
});

void bootstrap();
document.querySelectorAll<HTMLButtonElement>("nav button").forEach((button) => button.addEventListener("click", () => {
  view = button.dataset.view as View;
  document.querySelectorAll("nav button").forEach((item) => item.setAttribute("aria-selected", String(item === button)));
  render();
}));

async function bootstrap(): Promise<void> {
  const catalog = await loadProfileCatalog();
  profiles = catalog.profiles;
  activeProfileId = catalog.activeProfileId;
  await chrome.storage!.local!.set({ [ACTIVE_PROFILE_KEY]: activeProfileId });
  [growth, opportunityStats, workspacePreferences, scanHistory, templates] = await Promise.all([
    loadGrowthPreferences(),
    loadOpportunityStats(),
    loadWorkspacePreferences(),
    loadScanHistory(),
    loadTemplates()
  ]);
  await refresh();
}

async function refresh(): Promise<void> {
  state = await chrome.runtime!.sendMessage({ type: "GET_STATE" } satisfies ExtensionMessage);
  const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true });
  if (tab?.id) context = await chrome.tabs!.sendMessage!(tab.id, { type: "COMPOSER_CONTEXT" } satisfies ExtensionMessage).catch(() => undefined);
  if (!exploreBrief && context?.currentText) exploreBrief = context.currentText;
  render();
}
function render(): void {
  if (view === "today") renderToday();
  else if (view === "queue") renderQueue();
  else if (view === "explore") renderExplore();
  else renderTools();
}
function renderToday(): void {
  const activity = normalizeActivity(state.activity);
  const edits = state.events.filter((event) => event.kind === "edit").length;
  const skips = state.events.filter((event) => event.kind === "skip").length;
  const pending = state.events.filter((event) => !event.syncedAt).length;
  const scheduled = state.queue.filter((item) => item.scheduledFor && Date.parse(item.scheduledFor) >= Date.now()).sort((left, right) => Date.parse(left.scheduledFor!) - Date.parse(right.scheduledFor!));
  const nextScheduled = scheduled[0];
  app.innerHTML = `<h1>Today</h1><div class="goals"><div class="card goal"><span>Posts inserted</span><strong>${activity.posts}</strong></div><div class="card goal"><span>Replies inserted</span><strong>${activity.replies}</strong></div></div><div class="card"><strong>${state.queue.length} queued</strong><span class="muted">${edits} edits · ${skips} skips · ${pending} waiting to sync</span>${nextScheduled ? `<span>Next planned: ${escapeHtml(formatSchedule(nextScheduled.scheduledFor!))}</span>` : ""}</div>${scanHistory[0] ? renderScanReport(scanHistory[0], "Latest scan") : ""}`;
}
function renderQueue(): void {
  const visible = visibleQueueItems();
  const duplicates = duplicateQueueIds(state.queue);
  app.innerHTML = `<h1>Queue</h1><button id="findReplies" class="primary">Find ${workspacePreferences.scan.targetReplies} high-intent replies</button><span class="muted">Auto-scrolls X using the controls in Tools. A queued reply can go into any open reply composer.</span><div class="queue-tools"><label for="queueSearch">Search</label><input id="queueSearch" value="${escapeHtml(queueQuery)}" placeholder="Draft, source, author, or tag"><label for="queueKind">Kind</label><select id="queueKind"><option value="all"${queueKind === "all" ? " selected" : ""}>All</option><option value="reply"${queueKind === "reply" ? " selected" : ""}>Replies</option><option value="post"${queueKind === "post" ? " selected" : ""}>Posts</option></select><label for="queueSort">Sort</label><select id="queueSort"><option value="newest"${selected(workspacePreferences.queueSort, "newest")}>Newest</option><option value="oldest"${selected(workspacePreferences.queueSort, "oldest")}>Oldest</option><option value="favorites"${selected(workspacePreferences.queueSort, "favorites")}>Favorites first</option><option value="kind"${selected(workspacePreferences.queueSort, "kind")}>Kind</option><option value="scheduled"${selected(workspacePreferences.queueSort, "scheduled")}>Planned time</option></select><label class="check"><input id="favoritesOnly" type="checkbox"${favoritesOnly ? " checked" : ""}> Favorites only</label><div class="actions"><button id="applyQueueFilters">Apply</button><button id="removeVisible"${visible.length ? "" : " disabled"}>Remove shown</button></div></div><span class="muted">Showing ${visible.length} of ${state.queue.length}</span>${visible.length ? visible.map((item, index) => renderQueueCard(item, index, duplicates.has(item.id))).join("") : `<div class="card muted">No drafts match these filters.</div>`}`;
  document.getElementById("findReplies")?.addEventListener("click", () => void findHighIntentReplies());
  document.getElementById("applyQueueFilters")?.addEventListener("click", applyQueueFilters);
  document.getElementById("removeVisible")?.addEventListener("click", () => void removeVisibleQueueItems());
  app.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((button) => button.addEventListener("click", () => void openQueuePost(button.dataset.open!)));
  app.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((button) => button.addEventListener("click", () => beginQueueEdit(button.dataset.edit!)));
  app.querySelectorAll<HTMLButtonElement>("[data-save-edit]").forEach((button) => button.addEventListener("click", () => void saveQueueEdit(button.dataset.saveEdit!)));
  app.querySelectorAll<HTMLButtonElement>("[data-cancel-edit]").forEach((button) => button.addEventListener("click", cancelQueueEdit));
  app.querySelectorAll<HTMLButtonElement>("[data-insert]").forEach((button) => button.addEventListener("click", () => void insertQueue(button.dataset.insert!)));
  app.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((button) => button.addEventListener("click", () => void removeQueue(button.dataset.remove!)));
  app.querySelectorAll<HTMLButtonElement>("[data-favorite]").forEach((button) => button.addEventListener("click", () => void toggleFavorite(button.dataset.favorite!)));
  app.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => button.addEventListener("click", () => void copyQueueItem(button.dataset.copy!)));
  app.querySelectorAll<HTMLButtonElement>("[data-adapt]").forEach((button) => button.addEventListener("click", () => void adaptQueueItem(button.dataset.adapt!)));
  app.querySelectorAll<HTMLButtonElement>("[data-rewrite]").forEach((button) => button.addEventListener("click", () => void rewriteQueueItem(button.dataset.rewrite!)));
  app.querySelectorAll<HTMLButtonElement>("[data-split]").forEach((button) => button.addEventListener("click", () => void splitQueueItem(button.dataset.split!)));
  app.querySelectorAll<HTMLButtonElement>("[data-template]").forEach((button) => button.addEventListener("click", () => void saveQueueTemplate(button.dataset.template!)));
}
function renderQueueCard(item: QueueItem, index: number, duplicate: boolean): string {
  const target = item.context.kind === "reply" ? item.context.target : undefined;
  const canOpen = !!sourcePostUrl(target) || !!target?.text;
  const summary = (item.sourceSummary?.trim() || (target ? truncateText(target.text, 80) : "")).trim();
  const source = summary
    ? `<div class="source"><span class="muted">About</span><p>${escapeHtml(truncateText(summary, 100))}</p></div>`
    : "";
  const openButton = canOpen ? `<button data-open="${item.id}" class="primary">Open post</button>` : "";
  const warnings = workspacePreferences.warningsEnabled ? analyzeDraft(item.draft.text, item.context.kind, duplicate) : [];
  const warningList = warnings.length ? `<div class="warnings">${warnings.map((warning) => `<span>${escapeHtml(warning.message)}</span>`).join("")}</div>` : "";
  const tags = item.tags?.length ? `<div class="tag-list">${item.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : "";
  const schedule = item.scheduledFor ? `<span class="muted">Planned for ${escapeHtml(formatSchedule(item.scheduledFor))}</span>` : "";
  const copy = editingQueueItemId === item.id
    ? `<label class="queue-edit-label" for="queue-edit-${item.id}">${index + 1}. Edit draft</label><textarea id="queue-edit-${item.id}" class="queue-edit" aria-label="Edit queued draft">${escapeHtml(item.draft.text)}</textarea><label for="queue-tags-${item.id}">Tags</label><input id="queue-tags-${item.id}" value="${escapeHtml((item.tags ?? []).join(", "))}" placeholder="launch, technical"><label for="queue-schedule-${item.id}">Planned time</label><input id="queue-schedule-${item.id}" type="datetime-local" value="${escapeHtml(item.scheduledFor ?? "")}"><div class="edit-actions"><button data-cancel-edit="${item.id}">Cancel</button><button data-save-edit="${item.id}" class="primary">Save edit</button></div>`
    : `<strong>${index + 1}. ${escapeHtml(item.draft.text)}</strong>`;
  const adapt = item.context.kind === "reply" ? `<button data-adapt="${item.id}">Adapt here</button>` : "";
  const split = item.context.kind === "post" && item.draft.text.length > 280 ? `<button data-split="${item.id}">Split thread</button>` : "";
  return `<article class="card"><div class="card-heading"><span class="strategy">${escapeHtml(item.draft.strategy ?? "Queued")}</span><button class="icon-button" data-favorite="${item.id}" aria-label="${item.favorite ? "Remove favorite" : "Favorite"}">${item.favorite ? "★" : "☆"}</button></div>${source}${tags}${schedule}${copy}${warningList}<div class="actions queue-actions">${openButton}<button data-insert="${item.id}"${canOpen ? "" : ` class="primary"`}>Insert</button><button data-copy="${item.id}">Copy</button>${adapt}<button data-rewrite="${item.id}">Rewrite</button>${split}<button data-template="${item.id}">Save template</button><button data-edit="${item.id}">Edit</button><button data-remove="${item.id}">Skip</button></div></article>`;
}

function beginQueueEdit(id: string): void {
  editingQueueItemId = id;
  renderQueue();
  const editor = document.getElementById(`queue-edit-${id}`) as HTMLTextAreaElement | null;
  editor?.focus();
  editor?.setSelectionRange(editor.value.length, editor.value.length);
}

function cancelQueueEdit(): void {
  editingQueueItemId = undefined;
  renderQueue();
}

async function saveQueueEdit(id: string): Promise<void> {
  const index = state.queue.findIndex((item) => item.id === id);
  const editor = document.getElementById(`queue-edit-${id}`) as HTMLTextAreaElement | null;
  const item = state.queue[index];
  const tagsInput = document.getElementById(`queue-tags-${id}`) as HTMLInputElement | null;
  const scheduleInput = document.getElementById(`queue-schedule-${id}`) as HTMLInputElement | null;
  if (!item || !editor) return;
  if (!editor.value.trim()) {
    setStatus("A queued draft cannot be empty.");
    editor.focus();
    return;
  }
  const nextTags = parseListInput(tagsInput?.value ?? "");
  const nextSchedule = scheduleInput?.value.trim() ?? "";
  const edit = updateQueuedDraft(item, editor.value);
  editingQueueItemId = undefined;
  if (!edit && JSON.stringify(nextTags) === JSON.stringify(item.tags ?? []) && nextSchedule === (item.scheduledFor ?? "")) {
    setStatus("No changes to save.");
    renderQueue();
    return;
  }
  const updated = { ...(edit?.item ?? item) };
  if (nextTags.length) updated.tags = nextTags;
  else delete updated.tags;
  if (nextSchedule) updated.scheduledFor = nextSchedule;
  else delete updated.scheduledFor;
  state.queue[index] = updated;
  await persist();
  if (edit) await chrome.runtime!.sendMessage({
    type: "RECORD_EVENT",
    event: {
      clientEventId: stableId("queue-edit"),
      kind: "edit",
      occurredAt: new Date().toISOString(),
      suggestionId: item.draft.id,
      originalText: edit.originalText,
      finalText: edit.finalText,
      context: item.context
    }
  } satisfies ExtensionMessage);
  if (edit && item.opportunityLane) await trackOpportunity(item.opportunityLane, "edited");
  setStatus(edit ? "Draft updated. This edit was saved for future suggestions." : "Tags updated.");
  renderQueue();
}

function visibleQueueItems(): QueueItem[] {
  return filterAndSortQueue(state.queue, {
    query: queueQuery,
    kind: queueKind,
    sort: workspacePreferences.queueSort,
    favoritesOnly
  });
}

function applyQueueFilters(): void {
  queueQuery = (document.getElementById("queueSearch") as HTMLInputElement | null)?.value ?? "";
  queueKind = ((document.getElementById("queueKind") as HTMLSelectElement | null)?.value ?? "all") as typeof queueKind;
  workspacePreferences.queueSort = ((document.getElementById("queueSort") as HTMLSelectElement | null)?.value ?? "newest") as QueueSort;
  favoritesOnly = !!(document.getElementById("favoritesOnly") as HTMLInputElement | null)?.checked;
  void persistWorkspacePreferences();
  renderQueue();
}

async function removeVisibleQueueItems(): Promise<void> {
  const visible = visibleQueueItems();
  if (!visible.length || !window.confirm(`Remove ${visible.length} shown draft${visible.length === 1 ? "" : "s"}?`)) return;
  const ids = new Set(visible.map((item) => item.id));
  state.queue = state.queue.filter((item) => !ids.has(item.id));
  setActiveToFirst();
  await persist();
  setStatus(`${visible.length} draft${visible.length === 1 ? "" : "s"} removed.`);
  renderQueue();
}

async function toggleFavorite(id: string): Promise<void> {
  const item = state.queue.find((entry) => entry.id === id);
  if (!item) return;
  item.favorite = !item.favorite;
  await persist();
  renderQueue();
}

async function copyQueueItem(id: string): Promise<void> {
  const item = state.queue.find((entry) => entry.id === id);
  if (!item) return;
  try {
    await navigator.clipboard.writeText(item.draft.text);
    setStatus("Draft copied.");
  } catch {
    setStatus("Copy failed. Open Edit and copy the text manually.");
  }
}

async function adaptQueueItem(id: string): Promise<void> {
  const item = state.queue.find((entry) => entry.id === id);
  const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true });
  if (!item || !tab?.id) return;
  const live = await chrome.tabs!.sendMessage!(tab.id, { type: "COMPOSER_CONTEXT" } satisfies ExtensionMessage).catch(() => undefined) as ComposerContext | undefined;
  if (live?.kind !== "reply" || !live.target) return setStatus("Open the reply composer you want to adapt this draft for.");
  setStatus("Adapting the draft to the open reply…");
  try {
    const result = await postJson<ApiEnvelope<DraftResponse>>("/api/generate/comment", {
      sourcePost: {
        ...live.target,
        ...(live.parent ? { parentPost: live.parent } : {}),
        ...(live.quoted ? { quotedPost: live.quoted } : {})
      },
      angle: `Keep any useful idea from this earlier draft, but rewrite it for the current source: ${item.draft.text}`,
      audience: growth.audience,
      contentPillar: growth.pillar,
      desiredOutcome: growth.outcome,
      instructions: `${buildTasteAwareReplyInstructions(growth.outcome)}\n${replyPresetInstruction(workspacePreferences.replyPreset)}`,
      regenerationSeed: stableId("adapt")
    }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
    const draft = result.data.suggestions[0];
    if (!draft || result.data.abstained) return setStatus(result.data.abstainReason ?? "No adapted reply cleared the taste check.");
    item.generatedText ??= item.draft.text;
    item.draft = { ...item.draft, id: draft.id, text: draft.text, strategy: `Adapted · ${draft.strategy ?? workspacePreferences.replyPreset}` };
    item.context = { ...live, currentText: "" };
    item.sourceSummary = truncateText(live.target.text, 80);
    await persist();
    setStatus("Draft adapted to the open reply.");
    renderQueue();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not adapt this draft.");
  }
}

async function rewriteQueueItem(id: string): Promise<void> {
  const item = state.queue.find((entry) => entry.id === id);
  if (!item) return;
  setStatus(`Rewriting with the ${workspacePreferences.replyPreset} preset…`);
  try {
    const result = await postJson<ApiEnvelope<DraftResponse>>("/api/generate/rewrite", {
      text: item.draft.text,
      kind: item.context.kind === "reply" ? "comment" : "post",
      instructions: `${replyPresetInstruction(workspacePreferences.replyPreset)} Desired response: ${growth.outcome}.`,
      mode: "standard"
    }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
    const draft = result.data.suggestions[0];
    if (!draft) return setStatus("No rewrite returned.");
    item.generatedText ??= item.draft.text;
    item.draft = { ...item.draft, id: draft.id, text: draft.text, strategy: `Rewrite · ${workspacePreferences.replyPreset}` };
    await persist();
    setStatus("Draft rewritten.");
    renderQueue();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Rewrite failed.");
  }
}

async function splitQueueItem(id: string): Promise<void> {
  const index = state.queue.findIndex((entry) => entry.id === id);
  const item = state.queue[index];
  if (!item) return;
  const parts = splitThread(item.draft.text);
  if (parts.length <= 1) return setStatus("This draft already fits in one post.");
  const replacements = parts.map((text, partIndex): QueueItem => ({
    ...item,
    id: stableId("thread"),
    draft: { ...item.draft, id: stableId("draft"), text, strategy: `Thread ${partIndex + 1}/${parts.length}` },
    createdAt: item.createdAt + partIndex
  }));
  state.queue.splice(index, 1, ...replacements);
  state.activeQueueItemId = replacements[0]!.id;
  await persist();
  setStatus(`Split into ${parts.length} queued posts.`);
  renderQueue();
}

async function saveQueueTemplate(id: string): Promise<void> {
  const item = state.queue.find((entry) => entry.id === id);
  if (!item) return;
  templates.unshift({
    id: stableId("template"),
    name: truncateText(item.draft.text, 48),
    text: item.draft.text,
    kind: item.context.kind,
    createdAt: Date.now()
  });
  templates = templates.slice(0, 50);
  await persistTemplates();
  setStatus("Template saved in Tools.");
}

function renderTools(): void {
  const scan = workspacePreferences.scan;
  const reports = scanHistory.slice(0, 8).map((report) => renderScanReport(report)).join("");
  const templateCards = templates.map((template) => `<article class="card"><strong>${escapeHtml(template.name)}</strong><span class="muted">${template.kind} · ${template.text.length} characters</span><p>${escapeHtml(truncateText(template.text, 140))}</p><div class="actions"><button data-use-template="${template.id}">Use as brief</button><button data-queue-template="${template.id}">Queue</button><button data-delete-template="${template.id}">Delete</button></div></article>`).join("");
  const profileOptions = profiles.map((profile) => `<option value="${profile.id}"${selected(activeProfileId, profile.id)}>${escapeHtml(profile.name)}</option>`).join("");
  app.innerHTML = `<h1>Tools</h1><section class="card settings"><h2>Local profiles</h2><label for="activeProfile">Current profile</label><select id="activeProfile">${profileOptions}</select><input id="newProfileName" maxlength="40" placeholder="New profile name"><div class="actions"><button id="createProfile">Create</button><button id="renameProfile">Rename current</button></div><button id="deleteProfile"${activeProfileId === DEFAULT_PROFILE_ID ? " disabled" : ""}>Delete current profile</button><span class="muted">Each profile has its own queue, activity, scan controls, templates, and writing preferences.</span></section><section class="card settings"><h2>Reply scan controls</h2><label for="scanTarget">Replies to queue</label><input id="scanTarget" type="number" min="1" max="12" value="${scan.targetReplies}"><label for="scanCandidates">Posts to collect</label><input id="scanCandidates" type="number" min="8" max="48" value="${scan.maxCandidates}"><label for="scanScrolls">Maximum scrolls</label><input id="scanScrolls" type="number" min="4" max="80" value="${scan.maxScrolls}"><label for="scanPause">Render pause in milliseconds</label><input id="scanPause" type="number" min="250" max="2000" step="50" value="${scan.pauseMs}"><label for="scanStagnant">Empty scans before stopping</label><input id="scanStagnant" type="number" min="2" max="10" value="${scan.stagnantLimit}"><label for="scanStep">Scroll step percent</label><input id="scanStep" type="range" min="40" max="90" value="${scan.scrollStepPercent}"><output id="scanStepOutput">${scan.scrollStepPercent}%</output><label for="scanMinText">Minimum post length</label><input id="scanMinText" type="number" min="1" max="40" value="${scan.minTextLength}"><label for="ignoredAuthors">Ignore authors</label><textarea id="ignoredAuthors" placeholder="one author per line or comma separated">${escapeHtml(scan.ignoredAuthors.join("\n"))}</textarea><label for="blockedTerms">Blocked terms</label><textarea id="blockedTerms" placeholder="topics or phrases">${escapeHtml(scan.blockedTerms.join("\n"))}</textarea><label class="check"><input id="includeCommentBait" type="checkbox"${scan.includeCommentBait ? " checked" : ""}> Include engagement bait</label><button id="saveScanSettings" class="primary">Save scan controls</button></section><section class="card settings"><h2>Writing controls</h2><label for="replyPreset">Reply and rewrite preset</label><select id="replyPreset">${(["taste", "concise", "technical", "pushback", "question", "warm"] as ReplyPreset[]).map((preset) => `<option value="${preset}"${selected(workspacePreferences.replyPreset, preset)}>${preset}</option>`).join("")}</select><label class="check"><input id="warningsEnabled" type="checkbox"${workspacePreferences.warningsEnabled ? " checked" : ""}> Show draft checks</label><button id="saveWritingSettings">Save writing controls</button></section><section><h2 class="section-title">Templates</h2>${templateCards || `<div class="card muted">Save any queued draft as a reusable template.</div>`}</section><section><h2 class="section-title">Scan history</h2>${reports || `<div class="card muted">No scans recorded yet.</div>`}<button id="clearScanHistory"${scanHistory.length ? "" : " disabled"}>Clear scan history</button></section><section class="card settings"><h2>Backup and recovery</h2><button id="exportWorkspace">Export current profile</button><label for="importWorkspace">Import profile backup</label><input id="importWorkspace" type="file" accept="application/json"><button id="clearQueue"${state.queue.length ? "" : " disabled"}>Clear queue</button></section>`;
  document.getElementById("scanStep")?.addEventListener("input", () => {
    const value = (document.getElementById("scanStep") as HTMLInputElement).value;
    const output = document.getElementById("scanStepOutput");
    if (output) output.textContent = `${value}%`;
  });
  document.getElementById("saveScanSettings")?.addEventListener("click", () => void saveScanSettings());
  document.getElementById("activeProfile")?.addEventListener("change", () => void switchProfile((document.getElementById("activeProfile") as HTMLSelectElement).value));
  document.getElementById("createProfile")?.addEventListener("click", () => void createProfile());
  document.getElementById("renameProfile")?.addEventListener("click", () => void renameProfile());
  document.getElementById("deleteProfile")?.addEventListener("click", () => void deleteProfile());
  document.getElementById("saveWritingSettings")?.addEventListener("click", () => void saveWritingSettings());
  document.getElementById("clearScanHistory")?.addEventListener("click", () => void clearScanHistory());
  document.getElementById("exportWorkspace")?.addEventListener("click", exportWorkspace);
  document.getElementById("importWorkspace")?.addEventListener("change", (event) => void importWorkspace(event));
  document.getElementById("clearQueue")?.addEventListener("click", () => void clearQueue());
  app.querySelectorAll<HTMLButtonElement>("[data-use-template]").forEach((button) => button.addEventListener("click", () => useTemplateAsBrief(button.dataset.useTemplate!)));
  app.querySelectorAll<HTMLButtonElement>("[data-queue-template]").forEach((button) => button.addEventListener("click", () => void queueTemplate(button.dataset.queueTemplate!)));
  app.querySelectorAll<HTMLButtonElement>("[data-delete-template]").forEach((button) => button.addEventListener("click", () => void deleteTemplate(button.dataset.deleteTemplate!)));
}
function renderExplore(): void {
  const trendChips = trends.length
    ? `<div class="trend-list" aria-label="Detected feed trends">${trends.map((trend) => `<span class="trend-chip">${escapeHtml(trend.label)} · ${trend.count}</span>`).join("")}</div>`
    : "";
  const exploreCards = explore.map((draft) => `<article class="card ${draft.recommended ? "recommended" : ""}"><span class="strategy">${escapeHtml(draft.strategy ?? "Alternative")}${draft.recommended ? " · Recommended" : ""}</span><strong>${escapeHtml(draft.text)}</strong><button data-add="${draft.id}">Add to queue</button></article>`).join("");
  const scanLabel = trendScanning ? "Scanning feed…" : "Scan feed for trend ideas";
  const stopButton = trendScanning ? `<button id="stopTrendScan" type="button">Stop scroll</button>` : "";
  app.innerHTML = `<h1>Explore</h1><div class="growth-controls"><label for="audience">Target audience</label><input id="audience" value="${escapeHtml(growth.audience)}" placeholder="Who should care about this?"><label for="pillar">Content pillar</label><select id="pillar"><option value="teaching"${growth.pillar === "teaching" ? " selected" : ""}>Teach something useful</option><option value="building"${growth.pillar === "building" ? " selected" : ""}>Build in public</option><option value="point-of-view"${growth.pillar === "point-of-view" ? " selected" : ""}>Share a point of view</option></select><label for="outcome">Desired response</label><select id="outcome"><option value="earn relevant follows"${growth.outcome === "earn relevant follows" ? " selected" : ""}>Earn relevant follows</option><option value="start a useful conversation"${growth.outcome === "start a useful conversation" ? " selected" : ""}>Start a useful conversation</option><option value="create something worth saving"${growth.outcome === "create something worth saving" ? " selected" : ""}>Create something worth saving</option></select></div><label for="brief">Brief</label><textarea id="brief" placeholder="A lesson, experiment, mistake, or informed opinion">${escapeHtml(exploreBrief)}</textarea><span class="muted">Lead with value for peer founders and builders. Or let a long feed scroll suggest what to post from what's circulating.</span><div class="explore-actions"><button id="trendScan" class="primary"${trendScanning ? " disabled" : ""}>${scanLabel}</button>${stopButton}<button id="explore"${trendScanning ? " disabled" : ""}>Explore four alternatives</button></div>${trends.length ? `<h2 class="section-title">Feed trends</h2>${trendChips}` : ""}${explore.length ? `<h2 class="section-title">Alternatives</h2>${exploreCards}` : ""}`;
  document.getElementById("trendScan")?.addEventListener("click", () => void scanFeedTrends());
  document.getElementById("stopTrendScan")?.addEventListener("click", () => void stopTrendScan());
  document.getElementById("explore")?.addEventListener("click", () => void generateExplore());
  app.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((button) => button.addEventListener("click", () => void addQueue(button.dataset.add!)));
  document.getElementById("brief")?.addEventListener("input", () => {
    exploreBrief = (document.getElementById("brief") as HTMLTextAreaElement).value;
  });
  document.getElementById("audience")?.addEventListener("change", () => void persistGrowthPreferences());
  document.getElementById("pillar")?.addEventListener("change", () => void persistGrowthPreferences());
  document.getElementById("outcome")?.addEventListener("change", () => void persistGrowthPreferences());
}
async function generateExplore(): Promise<void> {
  exploreBrief = (document.getElementById("brief") as HTMLTextAreaElement).value;
  const brief = exploreBrief.trim();
  if (!brief) return setStatus("Add a brief first.");
  await persistGrowthPreferences();
  setStatus("Exploring strategies…");
  const result = await postJson<ApiEnvelope<DraftResponse>>("/api/generate/post", {
    ...growthPostRequest(brief, "Return one strongest recommendation and four distinct Explore strategies."),
    mode: "standard"
  });
  explore = mapNativeExplore(result.data);
  setStatus(explore.length ? "Four distinct strategies ready (native 1+4)." : "No alternatives returned. Try again.");
  renderExplore();
}
async function scanFeedTrends(): Promise<void> {
  if (trendScanning) return;
  const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true });
  if (!tab?.id) return setStatus("Open X first.");

  trendScanning = true;
  trends = [];
  const report: ScanReport = {
    id: stableId("scan"), kind: "trends", startedAt: new Date().toISOString(),
    collected: 0, kept: 0, tooShort: 0, ignoredAuthor: 0, blockedTerm: 0, commentBait: 0,
    scrolls: 0, scored: 0, eligible: 0, drafted: 0, queued: 0, abstained: 0
  };
  renderExplore();
  await persistGrowthPreferences();

  try {
    const durationMinutes = Math.round(TREND_SCAN.maxDurationMs / 60_000);
    setStatus(`Starting a long feed scroll (up to ~${durationMinutes} min)…`);
    const collected = await chrome.tabs!.sendMessage!(tab.id, {
      type: "COLLECT_FEED_POSTS",
      maxCandidates: TREND_SCAN.maxCandidates,
      maxScrolls: TREND_SCAN.maxScrolls,
      pauseMs: TREND_SCAN.scrollPauseMs,
      stagnantLimit: TREND_SCAN.stagnantLimit,
      maxDurationMs: TREND_SCAN.maxDurationMs,
      reportProgress: true
    } satisfies ExtensionMessage).catch(() => undefined) as
      | { posts?: Array<{ id?: string; author?: string; text: string; url?: string }>; scrolls?: number; elapsedMs?: number; stoppedReason?: string }
      | undefined;

    const filtered = filterScanPosts(collected?.posts ?? [], workspacePreferences.scan);
    Object.assign(report, filtered.stats, {
      scrolls: collected?.scrolls ?? 0,
      ...(collected?.stoppedReason ? { stoppedReason: collected.stoppedReason } : {})
    });
    const posts = filtered.posts
      .map((post, index) => ({ ...post, id: post.id ?? `trend-${index}` }));

    if (!posts.length) {
      setStatus("No usable posts found while scrolling. Keep X open on a denser feed and try again.");
      return;
    }

    const sample = samplePostsForScoring(posts, TREND_SCAN.scoreSampleSize);
    setStatus(`Read ${posts.length} posts. Scoring ${sample.length} for circulating themes…`);
    const scored = await postJson<ApiEnvelope<ScoreVisiblePostsResponse>>("/api/score/visible-posts", {
      posts: sample.map((post) => ({
        ...post,
        text: post.text.length > 280 ? `${post.text.slice(0, 279).trimEnd()}…` : post.text
      })),
      audience: growth.audience,
      contentPillar: growth.pillar,
      desiredOutcome: growth.outcome
    }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
    report.scored = scored.data.rankedPosts.length;

    trends = deriveFeedTrends(scored.data.rankedPosts, TREND_SCAN.topTrends);
    report.eligible = trends.length;
    if (!trends.length) {
      setStatus(`Scanned ${posts.length} posts but no clear themes emerged. Try another feed slice.`);
      renderExplore();
      return;
    }

    // Keep the brief as a single theme so later "Explore" runs stay focused.
    if (!exploreBrief.trim()) exploreBrief = trends[0]?.label ?? "";

    setStatus(`Spotted ${trends.length} trends. Drafting one original post per theme…`);
    let drafted = 0;
    const results = await mapPool(trends, 3, async (trend) => {
      const result = await postJson<ApiEnvelope<DraftResponse>>("/api/generate/post", {
        ...growthPostRequest(
          buildSingleTrendBrief(trend, growth.audience),
          [
            "Develop exactly one idea for this single trend.",
            "Return the strongest recommendation first.",
            "Prefer specific teaching, build-in-public lessons, or informed POV over vague trend commentary.",
            "Never copy or closely paraphrase feed posts."
          ].join(" ")
        ),
        mode: "cheap"
      }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
      drafted += 1;
      setStatus(`Drafting trend posts… ${drafted}/${trends.length}`);
      return { trend, result };
    });

    explore = results.flatMap(({ trend, result }, index) => {
      const suggestion = result.data.suggestions[0];
      if (!suggestion) return [];
      return [{
        id: suggestion.id,
        text: suggestion.text,
        strategy: `Trend · ${trend.label}`,
        recommended: index === 0
      }];
    });
    report.drafted = results.length;
    report.queued = explore.length;
    report.abstained = Math.max(0, results.length - explore.length);
    const seconds = Math.round((collected?.elapsedMs ?? 0) / 1000);
    const stopNote = collected?.stoppedReason === "aborted" ? " (stopped early)" : "";
    setStatus(
      explore.length
        ? `Ready: ${explore.length} focused drafts from ${trends.length} trends · ${posts.length} posts · ${seconds}s scroll${stopNote}.`
        : "Trends found, but no drafts returned. Try again."
    );
    renderExplore();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Trend scan failed. Try again.");
  } finally {
    trendScanning = false;
    await addScanReport(report);
    if (view === "explore") renderExplore();
  }
}
async function stopTrendScan(): Promise<void> {
  const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true });
  if (!tab?.id) return;
  setStatus("Stopping scroll… finishing with posts collected so far.");
  await chrome.tabs!.sendMessage!(tab.id, { type: "STOP_FEED_SCROLL" } satisfies ExtensionMessage).catch(() => undefined);
}
async function findHighIntentReplies(): Promise<void> {
  const findButton = document.getElementById("findReplies") as HTMLButtonElement | null;
  if (findButton) findButton.disabled = true;
  const scan = workspacePreferences.scan;
  const report: ScanReport = {
    id: stableId("scan"), kind: "replies", startedAt: new Date().toISOString(),
    collected: 0, kept: 0, tooShort: 0, ignoredAuthor: 0, blockedTerm: 0, commentBait: 0,
    scrolls: 0, scored: 0, eligible: 0, drafted: 0, queued: 0, abstained: 0
  };
  try {
    const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true });
    if (!tab?.id) return setStatus("Open X first.");
    await persistGrowthPreferences();
    const replyQueue = state.queue.filter((item) => item.context.kind === "reply");
    const excludeIds = [
      ...new Set(
        replyQueue.flatMap((item) =>
          [item.context.target?.id, item.context.target?.text].filter((value): value is string => !!value)
        )
      )
    ];
    const targetCount = scan.targetReplies;

    setStatus(`Scrolling feed to collect up to ${scan.maxCandidates} posts…`);
    const collected = await chrome.tabs!.sendMessage!(tab.id, {
      type: "COLLECT_FEED_POSTS",
      excludeIds,
      maxCandidates: scan.maxCandidates,
      maxScrolls: scan.maxScrolls,
      pauseMs: scan.pauseMs,
      stagnantLimit: scan.stagnantLimit,
      scrollStepPercent: scan.scrollStepPercent
    } satisfies ExtensionMessage).catch(() => undefined) as { posts?: PostContext[]; scrolls?: number; stoppedReason?: string } | undefined;

    const filtered = filterScanPosts(collected?.posts ?? [], scan);
    Object.assign(report, filtered.stats, {
      scrolls: collected?.scrolls ?? 0,
      ...(collected?.stoppedReason ? { stoppedReason: collected.stoppedReason } : {})
    });
    const posts = filtered.posts
      .map((post, index) => ({ ...post, id: post.id ?? `visible-${index}` }));
    if (!posts.length) return setStatus("No new posts found while scrolling. Try a denser feed and run again.");

    setStatus(`Scoring ${posts.length} posts from ${collected?.scrolls ?? 0} scroll${(collected?.scrolls ?? 0) === 1 ? "" : "s"}…`);
    const scored = await postJson<ApiEnvelope<ScoreVisiblePostsResponse>>("/api/score/visible-posts", {
      posts: posts.map((post) => ({
        ...post,
        text: post.text.length > 280 ? `${post.text.slice(0, 279).trimEnd()}…` : post.text
      })),
      audience: growth.audience,
      contentPillar: growth.pillar,
      desiredOutcome: growth.outcome
    }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
    report.scored = scored.data.rankedPosts.length;
    const postsById = new Map(posts.map((post) => [post.id, post]));
    const opportunities = selectOpportunityMix(scored.data.rankedPosts, posts, opportunityStats, scored.data.rankedPosts.length)
      .flatMap(({ score, lane }) => {
        const post = postsById.get(score.id);
        return post ? [{ score, post, lane }] : [];
      });
    report.eligible = opportunities.length;

    if (!opportunities.length) {
      return setStatus(`Scanned ${posts.length} posts; none were safe reply opportunities. Try another feed.`);
    }

    setStatus(`Drafting up to ${targetCount} high-intent replies…`);
    let drafted = 0;
    let added = 0;
    let cursor = 0;
    while (added < targetCount && cursor < opportunities.length) {
      const nextWave = nextOpportunityWave(opportunities, cursor, added, targetCount);
      const wave = nextWave.items;
      cursor = nextWave.nextCursor;
      const results = await mapPool(wave, 3, async ({ post, score }, index) => {
        const result = await postJson<ApiEnvelope<DraftResponse>>("/api/generate/comment", {
          sourcePost: post,
          angle: score.suggestedAngle,
          audience: growth.audience,
          contentPillar: growth.pillar,
          desiredOutcome: growth.outcome,
          mode: "cheap",
          instructions: `${buildTasteAwareReplyInstructions(growth.outcome)}\n${replyPresetInstruction(workspacePreferences.replyPreset)}`,
          regenerationSeed: `${state.sessionId}:reply:taste:${post.id ?? cursor + index}`
        }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
        drafted += 1;
        setStatus(`Drafting replies… ${drafted} tried · ${added}/${targetCount} ready`);
        return result;
      });

      results.forEach((result, index) => {
        const suggestion = result.data.suggestions[0];
        const opportunity = wave[index];
        if (!suggestion || !opportunity || result.data.abstained || added >= targetCount) return;
        const sourceSummary =
          opportunity.score.topicSummary?.trim()
          || truncateText(opportunity.post.text, 80);
        state.queue.push({
          id: stableId("queue"),
          draft: {
            id: suggestion.id,
            text: suggestion.text,
            strategy: `${laneLabel(opportunity.lane)} · ${opportunity.score.score}/100 · ${suggestion.strategy ?? result.data.tasteDecision?.stance ?? "Taste pick"} · ${opportunity.score.suggestedAngle}`,
            recommended: true
          },
          opportunityLane: opportunity.lane,
          context: { kind: "reply", currentText: "", target: opportunity.post },
          ...(sourceSummary ? { sourceSummary } : {}),
          createdAt: Date.now()
        });
        opportunityStats = recordOpportunityOutcome(opportunityStats, opportunity.lane, "shown");
        added += 1;
      });
    }

    if (!state.activeQueueItemId && state.queue[0]) state.activeQueueItemId = state.queue[0].id;
    await persist();
    await persistOpportunityStats();
    report.drafted = drafted;
    report.queued = added;
    report.abstained = Math.max(0, drafted - added);
    const shortfall = targetCount > added ? ` Wanted ${targetCount}; only ${added} cleared the bar.` : "";
    const laneCounts = countOpportunityLanes(added ? state.queue.slice(-added) : []);
    setStatus(`${added} replies queued: ${laneCounts.proven} proven, ${laneCounts.adjacent} adjacent, ${laneCounts.wildcard} wildcard.${shortfall} Open each post, then Insert.`);
    renderQueue();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Failed to find high-intent replies. Try again.");
  } finally {
    await addScanReport(report);
    if (findButton) findButton.disabled = false;
  }
}
function readGrowthPreferencesFromDom(): GrowthPreferences {
  return {
    audience: (document.getElementById("audience") as HTMLInputElement | null)?.value?.trim() || growth.audience,
    pillar: ((document.getElementById("pillar") as HTMLSelectElement | null)?.value || growth.pillar) as GrowthPreferences["pillar"],
    outcome: ((document.getElementById("outcome") as HTMLSelectElement | null)?.value || growth.outcome) as DesiredOutcome
  };
}
async function persistGrowthPreferences(): Promise<void> {
  if (document.getElementById("audience") || document.getElementById("pillar") || document.getElementById("outcome")) {
    growth = readGrowthPreferencesFromDom();
  }
  await writeScopedStorage(GROWTH_STORAGE_KEY, growth);
}
async function loadGrowthPreferences(): Promise<GrowthPreferences> {
  const value = await readScopedStorage(GROWTH_STORAGE_KEY);
  if (!value || typeof value !== "object") return { ...DEFAULT_GROWTH_PREFERENCES };
  const record = value as Record<string, unknown>;
  return {
    audience: typeof record.audience === "string" && record.audience.trim() ? record.audience.trim() : DEFAULT_GROWTH_PREFERENCES.audience,
    pillar: typeof record.pillar === "string" && record.pillar.trim() ? record.pillar.trim() : DEFAULT_GROWTH_PREFERENCES.pillar,
    outcome: typeof record.outcome === "string" && record.outcome.trim() ? record.outcome.trim() : DEFAULT_GROWTH_PREFERENCES.outcome
  };
}
function growthPostRequest(topic: string, instruction: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    topic,
    goal: "engagement",
    audience: growth.audience,
    contentPillar: growth.pillar,
    desiredOutcome: growth.outcome,
    instructions: `${instruction}\nDesired response: ${growth.outcome}.`,
    ...extra
  };
}
async function addQueue(id: string): Promise<void> {
  const draft = explore.find((item) => item.id === id);
  if (!draft) return;
  const item: QueueItem = { id: stableId("queue"), draft, context: context ?? { kind: "post", currentText: "" }, createdAt: Date.now() };
  state.queue.push(item);
  state.activeQueueItemId ??= item.id;
  await persist();
  setStatus("Added to queue.");
}
async function openQueuePost(id: string): Promise<void> {
  const item = state.queue.find((entry) => entry.id === id);
  const target = item?.context.target;
  if (!item || !target) return setStatus("No source post on this draft.");
  state.activeQueueItemId = item.id;
  await persist();
  const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true });
  if (!tab?.id) return setStatus("Open X first.");
  const result = await chrome.tabs!.sendMessage!(tab.id, { type: "OPEN_SOURCE_POST", target } satisfies ExtensionMessage).catch(() => undefined) as { found?: boolean } | undefined;
  if (result?.found) {
    setStatus("Jumped to the source post. Hit Reply on X, then Insert.");
    return;
  }
  const url = sourcePostUrl(target);
  if (!url) return setStatus("No post link available for this draft.");
  await chrome.tabs!.update!(tab.id, { url });
  setStatus("Opened the source post. Hit Reply on X, then Insert.");
}
async function insertQueue(id: string): Promise<void> {
  const item = state.queue.find((entry) => entry.id === id);
  const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true });
  if (!item || !tab?.id) return;
  const result = await chrome.tabs!.sendMessage!(
    tab.id,
    { type: "INSERT_QUEUE_NEXT", item } satisfies ExtensionMessage
  ).catch(() => undefined) as QueueInsertResult | undefined;
  if (!result?.inserted) {
    setStatus(result?.reason ?? "Could not insert. Focus the correct X composer and try again.");
    return;
  }
  state.queue = state.queue.filter((entry) => entry.id !== id);
  setActiveToFirst();
  await persist();
  if (item.opportunityLane) await trackOpportunity(item.opportunityLane, "used");
  setStatus(item.context.kind === "reply" ? "Reply inserted." : "Post inserted.");
  renderQueue();
}
async function removeQueue(id: string): Promise<void> {
  const skipped = state.queue.find((entry) => entry.id === id);
  state.queue = state.queue.filter((entry) => entry.id !== id);
  setActiveToFirst();
  if (skipped) {
    await chrome.runtime!.sendMessage({
      type: "RECORD_EVENT",
      event: {
        clientEventId: stableId("skip"),
        kind: "skip",
        occurredAt: new Date().toISOString(),
        suggestionId: skipped.draft.id,
        originalText: skipped.draft.text,
        context: skipped.context
      }
    } satisfies ExtensionMessage);
  }
  await persist();
  if (skipped?.opportunityLane) await trackOpportunity(skipped.opportunityLane, "skipped");
  renderQueue();
}

async function loadProfileCatalog(): Promise<{ profiles: LocalProfile[]; activeProfileId: string }> {
  const stored = await chrome.storage!.local!.get([PROFILE_CATALOG_KEY, ACTIVE_PROFILE_KEY]);
  const rawProfiles = stored[PROFILE_CATALOG_KEY];
  const normalized = Array.isArray(rawProfiles)
    ? rawProfiles.filter((item): item is LocalProfile => !!item && typeof item === "object" && typeof (item as LocalProfile).id === "string" && typeof (item as LocalProfile).name === "string")
    : [];
  if (!normalized.some((profile) => profile.id === DEFAULT_PROFILE_ID)) {
    normalized.unshift({ id: DEFAULT_PROFILE_ID, name: "Default", createdAt: 0 });
  }
  const requested = typeof stored[ACTIVE_PROFILE_KEY] === "string" ? stored[ACTIVE_PROFILE_KEY] as string : DEFAULT_PROFILE_ID;
  return {
    profiles: normalized.slice(0, 12),
    activeProfileId: normalized.some((profile) => profile.id === requested) ? requested : DEFAULT_PROFILE_ID
  };
}

async function persistProfileCatalog(): Promise<void> {
  await chrome.storage!.local!.set({ [PROFILE_CATALOG_KEY]: profiles, [ACTIVE_PROFILE_KEY]: activeProfileId });
}

async function switchProfile(profileId: string): Promise<void> {
  if (!profiles.some((profile) => profile.id === profileId)) return;
  activeProfileId = profileId;
  await persistProfileCatalog();
  [growth, opportunityStats, workspacePreferences, scanHistory, templates] = await Promise.all([
    loadGrowthPreferences(), loadOpportunityStats(), loadWorkspacePreferences(), loadScanHistory(), loadTemplates()
  ]);
  explore = [];
  trends = [];
  exploreBrief = "";
  editingQueueItemId = undefined;
  await refresh();
  setStatus(`Switched to ${profiles.find((profile) => profile.id === profileId)?.name ?? "profile"}.`);
}

async function createProfile(): Promise<void> {
  const name = (document.getElementById("newProfileName") as HTMLInputElement | null)?.value.trim();
  if (!name) return setStatus("Enter a profile name first.");
  if (profiles.length >= 12) return setStatus("The local profile limit is 12.");
  const profile: LocalProfile = { id: stableId("profile"), name: name.slice(0, 40), createdAt: Date.now() };
  profiles.push(profile);
  activeProfileId = profile.id;
  await persistProfileCatalog();
  growth = { ...DEFAULT_GROWTH_PREFERENCES };
  opportunityStats = emptyOpportunityLaneStats();
  workspacePreferences = structuredClone(DEFAULT_WORKSPACE_PREFERENCES);
  scanHistory = [];
  templates = [];
  await Promise.all([persistGrowthPreferences(), persistOpportunityStats(), persistWorkspacePreferences(), persistTemplates(), writeScopedStorage(SCAN_HISTORY_KEY, [])]);
  await refresh();
  setStatus(`${profile.name} created.`);
}

async function renameProfile(): Promise<void> {
  const name = (document.getElementById("newProfileName") as HTMLInputElement | null)?.value.trim();
  const profile = profiles.find((item) => item.id === activeProfileId);
  if (!profile || !name) return setStatus("Enter the new profile name first.");
  profile.name = name.slice(0, 40);
  await persistProfileCatalog();
  setStatus("Profile renamed.");
  renderTools();
}

async function deleteProfile(): Promise<void> {
  if (activeProfileId === DEFAULT_PROFILE_ID) return;
  const profile = profiles.find((item) => item.id === activeProfileId);
  if (!profile || !window.confirm(`Delete the local profile "${profile.name}"? Export it first if you may need it.`)) return;
  const profileId = activeProfileId;
  profiles = profiles.filter((item) => item.id !== activeProfileId);
  activeProfileId = DEFAULT_PROFILE_ID;
  await chrome.storage!.local!.remove([
    stateKeyForProfile(profileId),
    `${GROWTH_STORAGE_KEY}:${profileId}`,
    `${OPPORTUNITY_STATS_STORAGE_KEY}:${profileId}`,
    `${WORKSPACE_PREFERENCES_KEY}:${profileId}`,
    `${SCAN_HISTORY_KEY}:${profileId}`,
    `${TEMPLATES_KEY}:${profileId}`
  ]);
  await persistProfileCatalog();
  await switchProfile(DEFAULT_PROFILE_ID);
  setStatus(`${profile.name} deleted from the profile list.`);
}

function scopedStorageKey(base: string): string {
  return `${base}:${activeProfileId}`;
}

async function readScopedStorage(base: string): Promise<unknown> {
  const scoped = scopedStorageKey(base);
  const stored = await chrome.storage!.local!.get(activeProfileId === DEFAULT_PROFILE_ID ? [scoped, base] : scoped);
  return stored[scoped] ?? (activeProfileId === DEFAULT_PROFILE_ID ? stored[base] : undefined);
}

async function writeScopedStorage(base: string, value: unknown): Promise<void> {
  await chrome.storage!.local!.set({
    [scopedStorageKey(base)]: value,
    ...(activeProfileId === DEFAULT_PROFILE_ID ? { [base]: value } : {})
  });
}

async function loadWorkspacePreferences(): Promise<WorkspacePreferences> {
  return normalizeWorkspacePreferences(await readScopedStorage(WORKSPACE_PREFERENCES_KEY));
}

async function persistWorkspacePreferences(): Promise<void> {
  workspacePreferences = normalizeWorkspacePreferences(workspacePreferences);
  await writeScopedStorage(WORKSPACE_PREFERENCES_KEY, workspacePreferences);
}

async function saveScanSettings(): Promise<void> {
  workspacePreferences.scan = normalizeWorkspacePreferences({
    ...workspacePreferences,
    scan: {
      targetReplies: numericInput("scanTarget"),
      maxCandidates: numericInput("scanCandidates"),
      maxScrolls: numericInput("scanScrolls"),
      pauseMs: numericInput("scanPause"),
      stagnantLimit: numericInput("scanStagnant"),
      scrollStepPercent: numericInput("scanStep"),
      minTextLength: numericInput("scanMinText"),
      ignoredAuthors: parseListInput((document.getElementById("ignoredAuthors") as HTMLTextAreaElement | null)?.value ?? ""),
      blockedTerms: parseListInput((document.getElementById("blockedTerms") as HTMLTextAreaElement | null)?.value ?? ""),
      includeCommentBait: !!(document.getElementById("includeCommentBait") as HTMLInputElement | null)?.checked
    }
  }).scan;
  await persistWorkspacePreferences();
  setStatus("Scan controls saved.");
  renderTools();
}

async function saveWritingSettings(): Promise<void> {
  workspacePreferences.replyPreset = ((document.getElementById("replyPreset") as HTMLSelectElement | null)?.value ?? "taste") as ReplyPreset;
  workspacePreferences.warningsEnabled = !!(document.getElementById("warningsEnabled") as HTMLInputElement | null)?.checked;
  await persistWorkspacePreferences();
  setStatus("Writing controls saved.");
}

async function loadScanHistory(): Promise<ScanReport[]> {
  const value = await readScopedStorage(SCAN_HISTORY_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ScanReport => !!item && typeof item === "object" && typeof (item as ScanReport).id === "string").slice(0, 30);
}

async function addScanReport(report: ScanReport): Promise<void> {
  scanHistory = [report, ...scanHistory.filter((item) => item.id !== report.id)].slice(0, 30);
  await writeScopedStorage(SCAN_HISTORY_KEY, scanHistory);
}

async function clearScanHistory(): Promise<void> {
  scanHistory = [];
  await writeScopedStorage(SCAN_HISTORY_KEY, []);
  setStatus("Scan history cleared.");
  renderTools();
}

async function loadTemplates(): Promise<SavedTemplate[]> {
  const value = await readScopedStorage(TEMPLATES_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SavedTemplate => !!item && typeof item === "object" && typeof (item as SavedTemplate).id === "string" && typeof (item as SavedTemplate).text === "string").slice(0, 50);
}

async function persistTemplates(): Promise<void> {
  await writeScopedStorage(TEMPLATES_KEY, templates.slice(0, 50));
}

function useTemplateAsBrief(id: string): void {
  const template = templates.find((item) => item.id === id);
  if (!template) return;
  exploreBrief = template.text;
  switchView("explore");
  setStatus("Template loaded as the Explore brief.");
}

async function queueTemplate(id: string): Promise<void> {
  const template = templates.find((item) => item.id === id);
  if (!template) return;
  const item: QueueItem = {
    id: stableId("queue"),
    draft: { id: stableId("template-draft"), text: template.text, strategy: `Template · ${template.name}` },
    context: { kind: template.kind, currentText: "" },
    createdAt: Date.now()
  };
  state.queue.push(item);
  state.activeQueueItemId ??= item.id;
  await persist();
  setStatus("Template added to the queue.");
}

async function deleteTemplate(id: string): Promise<void> {
  templates = templates.filter((item) => item.id !== id);
  await persistTemplates();
  renderTools();
}

function exportWorkspace(): void {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    state,
    growth,
    workspacePreferences,
    scanHistory,
    templates,
    opportunityStats
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `tweet-helper-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus("Workspace backup exported.");
}

async function importWorkspace(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
    if (parsed.version !== 1 || !parsed.state || typeof parsed.state !== "object") throw new Error("This is not a Tweet Helper workspace backup.");
    const importedState = parsed.state as Partial<ExtensionState>;
    if (!Array.isArray(importedState.queue)) throw new Error("The backup has no valid queue.");
    state.queue = importedState.queue.filter((item): item is QueueItem => !!item && typeof item === "object" && typeof (item as QueueItem).id === "string" && typeof (item as QueueItem).draft?.text === "string");
    setActiveToFirst();
    workspacePreferences = normalizeWorkspacePreferences(parsed.workspacePreferences);
    if (Array.isArray(parsed.scanHistory)) scanHistory = (parsed.scanHistory as ScanReport[]).slice(0, 30);
    if (Array.isArray(parsed.templates)) templates = (parsed.templates as SavedTemplate[]).filter((item) => typeof item?.id === "string" && typeof item?.text === "string").slice(0, 50);
    if (parsed.growth && typeof parsed.growth === "object") growth = { ...growth, ...(parsed.growth as GrowthPreferences) };
    await Promise.all([persist(), persistWorkspacePreferences(), persistTemplates(), writeScopedStorage(SCAN_HISTORY_KEY, scanHistory), writeScopedStorage(GROWTH_STORAGE_KEY, growth)]);
    setStatus(`Imported ${state.queue.length} queued drafts and ${templates.length} templates.`);
    renderTools();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Workspace import failed.");
  } finally {
    input.value = "";
  }
}

async function clearQueue(): Promise<void> {
  if (!state.queue.length || !window.confirm(`Clear all ${state.queue.length} queued drafts? Export a backup first if you may need them.`)) return;
  state.queue = [];
  delete state.activeQueueItemId;
  await persist();
  setStatus("Queue cleared.");
  renderTools();
}

function renderScanReport(report: ScanReport, title = new Date(report.startedAt).toLocaleString()): string {
  const filtered = report.collected - report.kept;
  return `<article class="card scan-report"><strong>${escapeHtml(title)}</strong><span class="muted">${report.kind} · ${report.scrolls} scrolls${report.stoppedReason ? ` · ${escapeHtml(report.stoppedReason)}` : ""}</span><div class="funnel"><span>${report.collected}<small>collected</small></span><span>${filtered}<small>filtered</small></span><span>${report.scored}<small>scored</small></span><span>${report.eligible}<small>eligible</small></span><span>${report.queued}<small>queued</small></span></div><span class="muted">Filtered: ${report.tooShort} short, ${report.ignoredAuthor} author, ${report.blockedTerm} term, ${report.commentBait} bait. ${report.abstained} drafts abstained.</span></article>`;
}

function switchView(next: View): void {
  view = next;
  document.querySelectorAll<HTMLButtonElement>("nav button").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.view === next)));
  render();
}

function numericInput(id: string): number {
  return Number((document.getElementById(id) as HTMLInputElement | null)?.value);
}

function selected(value: string, expected: string): string {
  return value === expected ? " selected" : "";
}

async function loadOpportunityStats(): Promise<OpportunityLaneStats> {
  const defaults = emptyOpportunityLaneStats();
  const stored = await readScopedStorage(OPPORTUNITY_STATS_STORAGE_KEY);
  if (!stored || typeof stored !== "object") return defaults;
  const value = stored as Partial<OpportunityLaneStats>;
  for (const lane of ["proven", "adjacent", "wildcard"] as const) {
    for (const outcome of ["shown", "used", "edited", "skipped"] as const) {
      const count = value[lane]?.[outcome];
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) defaults[lane][outcome] = Math.floor(count);
    }
  }
  return defaults;
}

async function trackOpportunity(lane: QueueItem["opportunityLane"], outcome: "used" | "edited" | "skipped"): Promise<void> {
  if (!lane) return;
  opportunityStats = recordOpportunityOutcome(opportunityStats, lane, outcome);
  await persistOpportunityStats();
}

async function persistOpportunityStats(): Promise<void> {
  await writeScopedStorage(OPPORTUNITY_STATS_STORAGE_KEY, opportunityStats);
}

function laneLabel(lane: QueueItem["opportunityLane"]): string {
  return lane === "adjacent" ? "Adjacent" : lane === "wildcard" ? "Wildcard" : "Proven";
}

function countOpportunityLanes(items: QueueItem[]): { proven: number; adjacent: number; wildcard: number } {
  return items.reduce((counts, item) => {
    if (item.opportunityLane) counts[item.opportunityLane] += 1;
    return counts;
  }, { proven: 0, adjacent: 0, wildcard: 0 });
}
function setActiveToFirst(): void {
  const first = state.queue[0]?.id;
  if (first) state.activeQueueItemId = first;
  else delete state.activeQueueItemId;
}
async function persist(): Promise<void> {
  const message: ExtensionMessage = {
    type: "SET_QUEUE",
    queue: state.queue,
    ...(state.activeQueueItemId ? { activeQueueItemId: state.activeQueueItemId } : {})
  };
  state = await chrome.runtime!.sendMessage(message);
}
function setStatus(text: string): void {
  status.textContent = text;
}
function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
function formatSchedule(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
async function mapPool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]!, index);
    }
  }
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => run());
  await Promise.all(runners);
  return results;
}
function escapeHtml(value: string): string {
  const node = document.createElement("div");
  node.textContent = value;
  return node.innerHTML.replaceAll('"', "&quot;");
}

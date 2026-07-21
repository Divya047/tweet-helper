import {
  DEFAULT_GROWTH_PREFERENCES,
  looksLikeCommentBait,
  type ApiEnvelope,
  type DesiredOutcome,
  type DraftResponse,
  type GrowthPreferences,
  type ScoreVisiblePostsResponse
} from "@tweet-helper/shared";
import { LONG_REQUEST_TIMEOUT_MS, postJson } from "./api.js";
import { activitySnapshot } from "./activity.js";
import type { ComposerContext, Draft, ExtensionMessage, ExtensionState, QueueItem } from "./contracts.js";
import { assignReplyTones, BATCH_STRATEGIES, FIND_HIGH_INTENT, sourcePostUrl, stableId } from "./contracts.js";

const GROWTH_STORAGE_KEY = "growthPreferences";

type View = "today" | "queue" | "explore";
let view: View = "today"; let state: ExtensionState; let context: ComposerContext | undefined; let explore: Draft[] = [];
let growth: GrowthPreferences = { ...DEFAULT_GROWTH_PREFERENCES };
const app = document.getElementById("app")!; const status = document.getElementById("status")!;

void bootstrap();
document.querySelectorAll<HTMLButtonElement>("nav button").forEach((button) => button.addEventListener("click", () => {
  view = button.dataset.view as View; document.querySelectorAll("nav button").forEach((item) => item.setAttribute("aria-selected", String(item === button))); render();
}));

async function bootstrap(): Promise<void> {
  growth = await loadGrowthPreferences();
  await refresh();
}

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
  app.innerHTML = `<h1>Queue</h1><button id="findReplies" class="primary">Find 8 high-intent replies</button><span class="muted">Auto-scrolls your X feed, scores posts, and queues the top ${FIND_HIGH_INTENT.targetReplies}. Open a source post, hit Reply on X, then Insert.</span>${state.queue.length ? state.queue.map((item, index) => renderQueueCard(item, index)).join("") : `<div class="card muted">No drafts queued. Build a post batch or find high-intent replies.</div>`}`;
  document.getElementById("findReplies")?.addEventListener("click", () => void findHighIntentReplies());
  app.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((button) => button.addEventListener("click", () => void openQueuePost(button.dataset.open!)));
  app.querySelectorAll<HTMLButtonElement>("[data-insert]").forEach((button) => button.addEventListener("click", () => void insertQueue(button.dataset.insert!)));
  app.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((button) => button.addEventListener("click", () => void removeQueue(button.dataset.remove!)));
}
function renderQueueCard(item: QueueItem, index: number): string {
  const target = item.context.kind === "reply" ? item.context.target : undefined;
  const canOpen = !!sourcePostUrl(target) || !!target?.text;
  const summary = (item.sourceSummary?.trim() || (target ? truncateText(target.text, 80) : "")).trim();
  const source = summary
    ? `<div class="source"><span class="muted">About</span><p>${escapeHtml(truncateText(summary, 100))}</p></div>`
    : "";
  const openButton = canOpen ? `<button data-open="${item.id}" class="primary">Open post</button>` : "";
  return `<article class="card"><span class="strategy">${escapeHtml(item.draft.strategy ?? "Queued")}</span>${source}<strong>${index + 1}. ${escapeHtml(item.draft.text)}</strong><div class="actions">${openButton}<button data-insert="${item.id}"${canOpen ? "" : ` class="primary"`}>Insert</button><button data-remove="${item.id}">Skip</button></div></article>`;
}
function renderExplore(): void {
  app.innerHTML = `<h1>Explore</h1><div class="growth-controls"><label for="audience">Target audience</label><input id="audience" value="${escapeHtml(growth.audience)}" placeholder="Who should care about this?"><label for="pillar">Content pillar</label><select id="pillar"><option value="teaching"${growth.pillar === "teaching" ? " selected" : ""}>Teach something useful</option><option value="building"${growth.pillar === "building" ? " selected" : ""}>Build in public</option><option value="point-of-view"${growth.pillar === "point-of-view" ? " selected" : ""}>Share a point of view</option></select><label for="outcome">Desired response</label><select id="outcome"><option value="earn relevant follows"${growth.outcome === "earn relevant follows" ? " selected" : ""}>Earn relevant follows</option><option value="start a useful conversation"${growth.outcome === "start a useful conversation" ? " selected" : ""}>Start a useful conversation</option><option value="create something worth saving"${growth.outcome === "create something worth saving" ? " selected" : ""}>Create something worth saving</option></select></div><label for="brief">Brief</label><textarea id="brief" placeholder="A lesson, experiment, mistake, or informed opinion">${escapeHtml(context?.currentText ?? "")}</textarea><span class="muted">Lead with value for peer founders and builders. If you ask a question, earn it with a useful premise first.</span><button id="batch" class="primary">Build 8-post idea queue</button><button id="explore">Explore four alternatives</button>${explore.map((draft) => `<article class="card ${draft.recommended ? "recommended" : ""}"><span class="strategy">${escapeHtml(draft.strategy ?? "Alternative")}${draft.recommended ? " · Recommended" : ""}</span><strong>${escapeHtml(draft.text)}</strong><button data-add="${draft.id}">Add to queue</button></article>`).join("")}`;
  document.getElementById("batch")?.addEventListener("click", () => void generateBatch());
  document.getElementById("explore")?.addEventListener("click", () => void generateExplore());
  app.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((button) => button.addEventListener("click", () => void addQueue(button.dataset.add!)));
  document.getElementById("audience")?.addEventListener("change", () => void persistGrowthPreferences());
  document.getElementById("pillar")?.addEventListener("change", () => void persistGrowthPreferences());
  document.getElementById("outcome")?.addEventListener("change", () => void persistGrowthPreferences());
}
async function generateExplore(): Promise<void> {
  const brief = (document.getElementById("brief") as HTMLTextAreaElement).value.trim(); if (!brief) return setStatus("Add a brief first.");
  await persistGrowthPreferences();
  setStatus("Exploring strategies…");
  const labels = ["Tactical value", "Informed point of view", "Build lesson", "Conversation starter"];
  const instructions = [
    "Lead with one crisp shipping or product insight and give peer builders a practical takeaway.",
    "Offer a defensible founder/builder point of view with reasoning, not a vague hot take.",
    "Share a concise build-in-public lesson using only details in the brief.",
    "Give a useful premise first, then end with one thoughtful tradeoff or experience question that invites substantive answers from peers."
  ];
  const results = await Promise.all(instructions.map((instruction) => postJson<ApiEnvelope<DraftResponse>>("/api/generate/post", growthPostRequest(brief, instruction))));
  explore = results.map((result, i) => ({ id: result.data.suggestions[0]?.id ?? stableId("draft"), text: result.data.suggestions[0]?.text ?? brief, strategy: labels[i]!, recommended: i === 0 }));
  setStatus("Four distinct strategies ready."); renderExplore();
}
async function generateBatch(): Promise<void> {
  const brief = (document.getElementById("brief") as HTMLTextAreaElement).value.trim(); if (!brief) return setStatus("Add one short brief first.");
  await persistGrowthPreferences();
  setStatus("Building eight varied posts…");
  const results = await Promise.all(BATCH_STRATEGIES.map((strategy, index) => postJson<ApiEnvelope<DraftResponse>>("/api/generate/post", growthPostRequest(brief, strategy.instruction, {
    regenerationSeed: `${state.sessionId}:post:${index}`
  }))));
  const drafts = results.map((result, index): Draft => ({
    id: result.data.suggestions[0]?.id ?? stableId("draft"),
    text: result.data.suggestions[0]?.text ?? brief,
    strategy: BATCH_STRATEGIES[index]!.label,
    recommended: index === 0
  }));
  for (const draft of drafts) state.queue.push({ id: stableId("queue"), draft, context: { kind: "post", currentText: "" }, createdAt: Date.now() });
  if (!state.activeQueueItemId && state.queue[0]) state.activeQueueItemId = state.queue[0].id;
  explore = drafts.slice(0, 4);
  await persist(); setStatus("Eight posts queued for peer founders and builders."); renderExplore();
}
async function findHighIntentReplies(): Promise<void> {
  const findButton = document.getElementById("findReplies") as HTMLButtonElement | null;
  if (findButton) findButton.disabled = true;
  try {
    const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true });
    if (!tab?.id) return setStatus("Open X first.");
    await persistGrowthPreferences();
    const existing = new Set(
      state.queue
        .filter((item) => item.context.kind === "reply")
        .flatMap((item) => [item.context.target?.id, item.context.target?.text].filter((value): value is string => !!value))
    );
    const targetCount = Math.min(FIND_HIGH_INTENT.targetReplies, Math.max(0, 24 - existing.size));
    if (targetCount === 0) return setStatus("Reply queue is full (24). Skip some drafts first.");

    setStatus(`Scrolling feed to collect up to ${FIND_HIGH_INTENT.maxCandidates} posts…`);
    const collected = await chrome.tabs!.sendMessage!(tab.id, {
      type: "COLLECT_FEED_POSTS",
      excludeIds: [...existing],
      maxCandidates: FIND_HIGH_INTENT.maxCandidates,
      maxScrolls: FIND_HIGH_INTENT.maxScrolls
    } satisfies ExtensionMessage).catch(() => undefined) as { posts?: Array<{ id?: string; author?: string; text: string; url?: string }>; scrolls?: number } | undefined;

    const posts = (collected?.posts ?? [])
      .filter((post) => !looksLikeCommentBait(post.text))
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
    const postsById = new Map(posts.map((post) => [post.id, post]));
    const opportunities = scored.data.rankedPosts
      .filter((post) => post.recommendation === "reply" && post.score >= FIND_HIGH_INTENT.minScore)
      .sort((left, right) => right.score - left.score)
      .flatMap((score) => {
        const post = postsById.get(score.id);
        return post ? [{ score, post }] : [];
      })
      .slice(0, targetCount);

    if (!opportunities.length) {
      return setStatus(`Scanned ${posts.length} posts — none scored ${FIND_HIGH_INTENT.minScore}+ for a high-intent reply. Try another feed.`);
    }

    setStatus(`Drafting top ${opportunities.length} high-intent ${opportunities.length === 1 ? "reply" : "replies"}…`);
    const tones = assignReplyTones(opportunities.length);
    let drafted = 0;
    const results = await mapPool(opportunities, 3, async ({ post, score }, index) => {
      const tone = tones[index]!;
      const result = await postJson<ApiEnvelope<DraftResponse>>("/api/generate/comment", {
        sourcePost: post,
        angle: score.suggestedAngle,
        audience: growth.audience,
        contentPillar: growth.pillar,
        desiredOutcome: growth.outcome,
        mode: "cheap",
        model: "standard",
        instructions: [
          `Reply tone for this draft: ${tone.label}.`,
          tone.instruction,
          "Signal peer expertise with a complete thought that stands alone.",
          "Never invent facts, metrics, credentials, or personal experiences. If a story would require invention, use a different structure.",
          `Desired response: ${growth.outcome}.`
        ].join("\n"),
        regenerationSeed: `${state.sessionId}:reply:${tone.label}:${post.id ?? index}`
      }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
      drafted += 1;
      setStatus(`Drafting replies… ${drafted}/${opportunities.length}`);
      return result;
    });

    let added = 0;
    results.forEach((result, index) => {
      const suggestion = result.data.suggestions[0];
      const opportunity = opportunities[index];
      const tone = tones[index];
      if (!suggestion || !opportunity || !tone) return;
      const sourceSummary =
        opportunity.score.topicSummary?.trim()
        || truncateText(opportunity.post.text, 80);
      state.queue.push({
        id: stableId("queue"),
        draft: {
          id: suggestion.id,
          text: suggestion.text,
          strategy: `${opportunity.score.score}/100 · ${tone.label} · ${opportunity.score.suggestedAngle}`,
          recommended: true
        },
        context: { kind: "reply", currentText: "", target: opportunity.post },
        ...(sourceSummary ? { sourceSummary } : {}),
        createdAt: Date.now()
      });
      added += 1;
    });

    if (!state.activeQueueItemId && state.queue[0]) state.activeQueueItemId = state.queue[0].id;
    await persist();
    const shortfall = targetCount > added ? ` Wanted ${targetCount}; only ${added} cleared the bar.` : "";
    setStatus(`${added} high-intent ${added === 1 ? "reply" : "replies"} queued.${shortfall} Open each post, then Insert.`);
    renderQueue();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Failed to find high-intent replies. Try again.");
  } finally {
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
  await chrome.storage!.local!.set({ [GROWTH_STORAGE_KEY]: growth });
}
async function loadGrowthPreferences(): Promise<GrowthPreferences> {
  const stored = await chrome.storage!.local!.get(GROWTH_STORAGE_KEY);
  const value = stored[GROWTH_STORAGE_KEY];
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
async function addQueue(id: string): Promise<void> { const draft = explore.find((item) => item.id === id); if (!draft) return; const item: QueueItem = { id: stableId("queue"), draft, context: context ?? { kind: "post", currentText: "" }, createdAt: Date.now() }; state.queue.push(item); state.activeQueueItemId ??= item.id; await persist(); setStatus("Added to queue."); }
async function openQueuePost(id: string): Promise<void> {
  const item = state.queue.find((entry) => entry.id === id);
  const target = item?.context.target;
  if (!item || !target) return setStatus("No source post on this draft.");
  const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true });
  if (!tab?.id) return setStatus("Open X first.");
  const result = await chrome.tabs!.sendMessage!(tab.id, { type: "OPEN_SOURCE_POST", target } satisfies ExtensionMessage).catch(() => undefined) as { found?: boolean } | undefined;
  if (result?.found) {
    setStatus("Jumped to the source post. Hit Reply on X, then Insert.");
    return;
  }
  const url = sourcePostUrl(target);
  if (!url) return setStatus("No post link available for this draft.");
  await chrome.tabs!.update(tab.id, { url });
  setStatus("Opened the source post. Hit Reply on X, then Insert.");
}
async function insertQueue(id: string): Promise<void> { const item = state.queue.find((entry) => entry.id === id); const [tab] = await chrome.tabs!.query!({ active: true, currentWindow: true }); if (!item || !tab?.id) return; await chrome.tabs!.sendMessage!(tab.id, { type: "INSERT_QUEUE_NEXT", item } satisfies ExtensionMessage); state.queue = state.queue.filter((entry) => entry.id !== id); setActiveToFirst(); await persist(); renderQueue(); }
async function removeQueue(id: string): Promise<void> { const skipped = state.queue.find((entry) => entry.id === id); state.queue = state.queue.filter((entry) => entry.id !== id); setActiveToFirst(); if (skipped) await chrome.runtime!.sendMessage({ type: "RECORD_EVENT", event: { clientEventId: stableId("skip"), kind: "skip", occurredAt: new Date().toISOString(), suggestionId: skipped.draft.id, originalText: skipped.draft.text, context: skipped.context } } satisfies ExtensionMessage); await persist(); renderQueue(); }
function setActiveToFirst(): void { const first = state.queue[0]?.id; if (first) state.activeQueueItemId = first; else delete state.activeQueueItemId; }
async function persist(): Promise<void> { const message: ExtensionMessage = { type: "SET_QUEUE", queue: state.queue, ...(state.activeQueueItemId ? { activeQueueItemId: state.activeQueueItemId } : {}) }; state = await chrome.runtime!.sendMessage(message); }
function setStatus(text: string): void { status.textContent = text; }
function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
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
function escapeHtml(value: string): string { const node = document.createElement("div"); node.textContent = value; return node.innerHTML.replaceAll('"', "&quot;"); }

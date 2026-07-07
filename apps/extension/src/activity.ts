export const LIMITS = {
  dailyPosts: 8,
  dailyReplies: 24,
  batchPosts: 2,
  batchReplies: 6,
  batchWindowMs: 3 * 60 * 60 * 1000
} as const;

const STORAGE_KEY = "tweet-helper-activity";

export interface ActivityState {
  dayKey: string;
  dailyPosts: number;
  dailyReplies: number;
  batchPosts: number;
  batchReplies: number;
  batchWindowStart: number | null;
}

export interface ActivitySnapshot {
  dailyPosts: number;
  dailyReplies: number;
  batchPosts: number;
  batchReplies: number;
  limits: typeof LIMITS;
  canPost: boolean;
  canReply: boolean;
  postDisabledReason: string | null;
  replyDisabledReason: string | null;
  windowEndsAt: number | null;
  postsDailyComplete: boolean;
  repliesDailyComplete: boolean;
}

function getDayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyState(dayKey = getDayKey()): ActivityState {
  return {
    dayKey,
    dailyPosts: 0,
    dailyReplies: 0,
    batchPosts: 0,
    batchReplies: 0,
    batchWindowStart: null
  };
}

export function normalizeState(state: ActivityState, now = Date.now()): ActivityState {
  const today = getDayKey(new Date(now));
  let next = { ...state };

  if (next.dayKey !== today) {
    next = {
      ...emptyState(today),
      batchWindowStart: null,
      batchPosts: 0,
      batchReplies: 0
    };
  }

  if (next.batchWindowStart !== null && now - next.batchWindowStart >= LIMITS.batchWindowMs) {
    next = {
      ...next,
      batchWindowStart: null,
      batchPosts: 0,
      batchReplies: 0
    };
  }

  return next;
}

export function getWindowEndsAt(state: ActivityState): number | null {
  if (state.batchWindowStart === null) {
    return null;
  }
  return state.batchWindowStart + LIMITS.batchWindowMs;
}

export function buildSnapshot(state: ActivityState, now = Date.now()): ActivitySnapshot {
  const normalized = normalizeState(state, now);
  const windowEndsAt = getWindowEndsAt(normalized);
  const postsDailyComplete = normalized.dailyPosts >= LIMITS.dailyPosts;
  const repliesDailyComplete = normalized.dailyReplies >= LIMITS.dailyReplies;
  const batchPostsFull = normalized.batchPosts >= LIMITS.batchPosts;
  const batchRepliesFull = normalized.batchReplies >= LIMITS.batchReplies;

  let postDisabledReason: string | null = null;
  if (postsDailyComplete) {
    postDisabledReason = "Daily limit reached";
  } else if (batchPostsFull && windowEndsAt !== null) {
    postDisabledReason = `Recharge in ${formatCountdown(windowEndsAt - now)}`;
  }

  let replyDisabledReason: string | null = null;
  if (repliesDailyComplete) {
    replyDisabledReason = "Daily limit reached";
  } else if (batchRepliesFull && windowEndsAt !== null) {
    replyDisabledReason = `Recharge in ${formatCountdown(windowEndsAt - now)}`;
  }

  return {
    dailyPosts: normalized.dailyPosts,
    dailyReplies: normalized.dailyReplies,
    batchPosts: normalized.batchPosts,
    batchReplies: normalized.batchReplies,
    limits: LIMITS,
    canPost: postDisabledReason === null,
    canReply: replyDisabledReason === null,
    postDisabledReason,
    replyDisabledReason,
    windowEndsAt,
    postsDailyComplete,
    repliesDailyComplete
  };
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) {
    return "0m";
  }
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

export function getBarColor(ratio: number): string {
  if (ratio >= 1) {
    return "#d97706";
  }
  if (ratio >= 0.85) {
    return "#f43f5e";
  }
  if (ratio >= 0.6) {
    return "#f59e0b";
  }
  return "#22c55e";
}

async function loadRawState(): Promise<ActivityState> {
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    if (value && typeof value === "object") {
      return normalizeState(value as ActivityState);
    }
  }
  return emptyState();
}

async function saveState(state: ActivityState): Promise<void> {
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }
}

export async function getActivitySnapshot(): Promise<ActivitySnapshot> {
  const state = await loadRawState();
  const normalized = normalizeState(state);
  if (JSON.stringify(normalized) !== JSON.stringify(state)) {
    await saveState(normalized);
  }
  return buildSnapshot(normalized);
}

async function recordAction(kind: "post" | "reply"): Promise<ActivitySnapshot> {
  const now = Date.now();
  let state = normalizeState(await loadRawState(), now);
  const snapshot = buildSnapshot(state, now);

  if (kind === "post" && !snapshot.canPost) {
    return snapshot;
  }
  if (kind === "reply" && !snapshot.canReply) {
    return snapshot;
  }

  if (state.batchWindowStart === null) {
    state.batchWindowStart = now;
  }

  if (kind === "post") {
    state.dailyPosts += 1;
    state.batchPosts += 1;
  } else {
    state.dailyReplies += 1;
    state.batchReplies += 1;
  }

  await saveState(state);
  return buildSnapshot(state, now);
}

export async function recordPost(): Promise<ActivitySnapshot> {
  return recordAction("post");
}

export async function recordReply(): Promise<ActivitySnapshot> {
  return recordAction("reply");
}

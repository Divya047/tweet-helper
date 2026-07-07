export const LIMITS = {
  dailyPosts: 8,
  dailyReplies: 24
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
  limits: typeof LIMITS;
  canPost: boolean;
  canReply: boolean;
  postDisabledReason: string | null;
  replyDisabledReason: string | null;
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

export function normalizeState(state: Partial<ActivityState> | null | undefined, now = Date.now()): ActivityState {
  const today = getDayKey(new Date(now));
  let next: ActivityState = {
    dayKey: typeof state?.dayKey === "string" ? state.dayKey : today,
    dailyPosts: nonNegativeInteger(state?.dailyPosts),
    dailyReplies: nonNegativeInteger(state?.dailyReplies),
    batchPosts: nonNegativeInteger(state?.batchPosts),
    batchReplies: nonNegativeInteger(state?.batchReplies),
    batchWindowStart: typeof state?.batchWindowStart === "number" ? state.batchWindowStart : null
  };

  if (next.dayKey !== today) {
    next = {
      ...emptyState(today),
      batchWindowStart: null,
      batchPosts: 0,
      batchReplies: 0
    };
  }

  return {
    ...next,
    batchWindowStart: null,
    batchPosts: 0,
    batchReplies: 0
  };
}

export function buildSnapshot(state: ActivityState, now = Date.now()): ActivitySnapshot {
  const normalized = normalizeState(state, now);
  const postsDailyComplete = normalized.dailyPosts >= LIMITS.dailyPosts;
  const repliesDailyComplete = normalized.dailyReplies >= LIMITS.dailyReplies;

  let postDisabledReason: string | null = null;
  if (postsDailyComplete) {
    postDisabledReason = "Daily limit reached";
  }

  let replyDisabledReason: string | null = null;
  if (repliesDailyComplete) {
    replyDisabledReason = "Daily limit reached";
  }

  return {
    dailyPosts: normalized.dailyPosts,
    dailyReplies: normalized.dailyReplies,
    limits: LIMITS,
    canPost: postDisabledReason === null,
    canReply: replyDisabledReason === null,
    postDisabledReason,
    replyDisabledReason,
    postsDailyComplete,
    repliesDailyComplete
  };
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
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const value = stored[STORAGE_KEY];
      if (value && typeof value === "object") {
        return normalizeState(value as Partial<ActivityState>);
      }
    } catch {
      return emptyState();
    }
  }
  return emptyState();
}

async function saveState(state: ActivityState): Promise<void> {
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
    } catch {
      // Extension reloads can invalidate the context while the content script is still running.
    }
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

  if (kind === "post") {
    state.dailyPosts += 1;
  } else {
    state.dailyReplies += 1;
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

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

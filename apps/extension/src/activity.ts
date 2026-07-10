export const SOFT_GOALS = { posts: 8, replies: 24 } as const;

export interface ActivityState { dayKey: string; posts: number; replies: number }
export interface ActivitySnapshot extends ActivityState {
  goals: typeof SOFT_GOALS;
  postProgress: number;
  replyProgress: number;
}

export function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function normalizeActivity(value: Partial<ActivityState> | undefined, now = new Date()): ActivityState {
  const today = dayKey(now);
  if (value?.dayKey !== today) return { dayKey: today, posts: 0, replies: 0 };
  return { dayKey: today, posts: count(value.posts), replies: count(value.replies) };
}

export function activitySnapshot(value: Partial<ActivityState> | undefined, now = new Date()): ActivitySnapshot {
  const state = normalizeActivity(value, now);
  return {
    ...state,
    goals: SOFT_GOALS,
    postProgress: state.posts / SOFT_GOALS.posts,
    replyProgress: state.replies / SOFT_GOALS.replies
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

import type { ContentKind } from "@tweet-helper/shared";
import type { AppDatabase, WritingExample } from "./db.js";
import { getSimilarExamples, getWritingExamples, saveStyleProfile } from "./db.js";

export interface StyleProfile {
  sampleCount: number;
  postCount: number;
  commentCount: number;
  avgChars: number;
  avgWords: number;
  commonOpeners: string[];
  commonClosers: string[];
  punctuation: {
    questionRate: number;
    exclamationRate: number;
    hashtagRate: number;
    linkRate: number;
  };
  guidance: string[];
}

export function rebuildStyleProfile(db: AppDatabase): StyleProfile {
  const examples = getWritingExamples(db, 1000);
  const profile = buildStyleProfile(examples);
  saveStyleProfile(db, JSON.stringify(profile, null, 2));
  return profile;
}

export function buildStyleProfile(examples: WritingExample[]): StyleProfile {
  const sampleCount = examples.length;
  const postCount = examples.filter((example) => example.kind === "post").length;
  const commentCount = examples.filter((example) => example.kind !== "post").length;
  const avgChars = average(examples.map((example) => example.text.length));
  const avgWords = average(examples.map((example) => example.text.split(/\s+/).filter(Boolean).length));
  const questionRate = rate(examples, (example) => example.text.includes("?"));
  const exclamationRate = rate(examples, (example) => example.text.includes("!"));
  const hashtagRate = rate(examples, (example) => /(^|\s)#\w+/.test(example.text));
  const linkRate = rate(examples, (example) => /https?:\/\//.test(example.text));

  const profile: StyleProfile = {
    sampleCount,
    postCount,
    commentCount,
    avgChars: Math.round(avgChars),
    avgWords: Math.round(avgWords),
    commonOpeners: topPhrases(examples, "open"),
    commonClosers: topPhrases(examples, "close"),
    punctuation: {
      questionRate: roundRate(questionRate),
      exclamationRate: roundRate(exclamationRate),
      hashtagRate: roundRate(hashtagRate),
      linkRate: roundRate(linkRate)
    },
    guidance: []
  };

  profile.guidance = deriveGuidance(profile);
  return profile;
}

export function selectStyleExamples(db: AppDatabase, query: string, kind: ContentKind, limit = 8): WritingExample[] {
  const similar = getSimilarExamples(db, query, kind, limit);
  if (similar.length > 0) {
    return similar;
  }
  return getWritingExamples(db, limit).filter((example) => example.kind === kind || example.kind !== "post").slice(0, limit);
}

function deriveGuidance(profile: StyleProfile): string[] {
  const guidance = [
    "Sound like the user's existing writing, not a generic brand account.",
    "Stay concrete, direct, and human.",
    "Avoid engagement bait, fake certainty, and padded phrasing."
  ];
  if (profile.avgWords > 0 && profile.avgWords < 35) {
    guidance.push("Prefer short drafts unless the user explicitly asks for a longer post.");
  }
  if (profile.punctuation.hashtagRate < 0.2) {
    guidance.push("Do not add hashtags unless the prompt asks for them.");
  }
  if (profile.punctuation.exclamationRate < 0.15) {
    guidance.push("Avoid exclamation-heavy language.");
  }
  if (profile.punctuation.linkRate < 0.2) {
    guidance.push("Do not invent links.");
  }
  return guidance;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(examples: WritingExample[], predicate: (example: WritingExample) => boolean): number {
  if (examples.length === 0) {
    return 0;
  }
  return examples.filter(predicate).length / examples.length;
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function topPhrases(examples: WritingExample[], mode: "open" | "close"): string[] {
  const counts = new Map<string, number>();
  for (const example of examples) {
    const words = example.text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length < 3) {
      continue;
    }
    const phrase = mode === "open" ? words.slice(0, 3).join(" ") : words.slice(-3).join(" ");
    const normalized = phrase.toLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);
}

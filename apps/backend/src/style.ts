import type { ContentKind } from "@tweet-helper/shared";
import type { AppDatabase, WritingExample } from "./db.js";
import { getSimilarExamples, getWritingExamples, normalizeForStorage, saveStyleProfile } from "./db.js";

export const RECENT_ARCHIVE_EXAMPLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface PersonalTasteProfile {
  sampleCount: number;
  decisionCounts: {
    accepted: number;
    edited: number;
    rejected: number;
    skipped: number;
  };
  acceptanceRate: number;
  preferredDraft: {
    avgWords: number;
    questionRate: number;
    disagreementRate: number;
    technicalRate: number;
    directnessRate: number;
  };
  editSignals: {
    sampleCount: number;
    shorterRate: number;
    avgLengthRatio: number;
    removedQuestionRate: number;
    removedApplauseRate: number;
    removedHedgeRate: number;
  };
  positiveExamples: string[];
  negativeExamples: string[];
  guidance: string[];
}

export interface TasteFeedbackRow {
  suggestionId: string;
  decision: "accepted" | "edited" | "rejected" | "skipped";
  originalText: string | null;
  finalText: string | null;
  createdAt: string;
}

export function rebuildStyleProfile(db: AppDatabase): StyleProfile {
  const examples = uniqueTrustedStyleExamples(getWritingExamples(db, 1000));
  const profile = buildStyleProfile(examples);
  saveStyleProfile(db, JSON.stringify(profile, null, 2));
  return profile;
}

export function rebuildPersonalTasteProfile(db: AppDatabase): PersonalTasteProfile {
  const feedback = getLatestTasteFeedback(db);
  const feedbackTexts = new Set(
    feedback
      .map((row) => (row.finalText ?? row.originalText ?? "").toLowerCase().replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );
  const rows = [
    ...feedback,
    ...getPublishedTasteSignals(db).filter((row) =>
      !feedbackTexts.has((row.finalText ?? "").toLowerCase().replace(/\s+/g, " ").trim())
    )
  ];
  const profile = buildPersonalTasteProfile(rows);
  db.prepare(
    `INSERT INTO style_profiles(id, json, updated_at) VALUES ('taste', ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
  ).run(JSON.stringify(profile, null, 2), new Date().toISOString());
  return profile;
}

export function getPersonalTasteProfile(db: AppDatabase): PersonalTasteProfile {
  const row = db.prepare("SELECT json FROM style_profiles WHERE id = 'taste'").get() as { json: string } | undefined;
  if (row) {
    try {
      return JSON.parse(row.json) as PersonalTasteProfile;
    } catch {
      // Rebuild malformed or outdated local profile data.
    }
  }
  return rebuildPersonalTasteProfile(db);
}

export function buildPersonalTasteProfile(rows: TasteFeedbackRow[]): PersonalTasteProfile {
  const decisionCounts = {
    accepted: rows.filter((row) => row.decision === "accepted").length,
    edited: rows.filter((row) => row.decision === "edited").length,
    rejected: rows.filter((row) => row.decision === "rejected").length,
    skipped: rows.filter((row) => row.decision === "skipped").length
  };
  const positives = rows
    .filter((row) => row.decision === "accepted" || row.decision === "edited")
    .map((row) => row.finalText?.trim() || row.originalText?.trim() || "")
    .filter(Boolean);
  const negatives = rows
    .filter((row) => row.decision === "rejected" || row.decision === "skipped")
    .map((row) => row.originalText?.trim() || "")
    .filter(Boolean);
  const edits = rows.filter(
    (row) => row.decision === "edited" && row.originalText?.trim() && row.finalText?.trim()
  );
  const positiveCount = decisionCounts.accepted + decisionCounts.edited;
  const decidedCount = positiveCount + decisionCounts.rejected + decisionCounts.skipped;
  const questionRate = textRate(positives, (text) => text.includes("?"));
  const disagreementRate = textRate(positives, (text) =>
    /\b(but|except|unless|depends|disagree|tradeoff|constraint|counterpoint)\b/i.test(text)
  );
  const technicalRate = textRate(positives, (text) =>
    /\b(api|database|latency|cache|model|prompt|deploy|runtime|system|workflow|implementation|code)\b/i.test(text)
  );
  const directnessRate = textRate(positives, (text) =>
    !/^(i think|i feel|maybe|perhaps|it seems|great point|love this|so true)\b/i.test(text.trim())
  );
  const profile: PersonalTasteProfile = {
    sampleCount: rows.length,
    decisionCounts,
    acceptanceRate: roundRate(decidedCount ? positiveCount / decidedCount : 0),
    preferredDraft: {
      avgWords: Math.round(average(positives.map(wordCount))),
      questionRate: roundRate(questionRate),
      disagreementRate: roundRate(disagreementRate),
      technicalRate: roundRate(technicalRate),
      directnessRate: roundRate(directnessRate)
    },
    editSignals: {
      sampleCount: edits.length,
      shorterRate: roundRate(rateRows(edits, (row) => wordCount(row.finalText!) < wordCount(row.originalText!))),
      avgLengthRatio: roundRate(average(edits.map((row) => wordCount(row.finalText!) / Math.max(1, wordCount(row.originalText!))))),
      removedQuestionRate: roundRate(rateRows(edits, (row) => row.originalText!.includes("?") && !row.finalText!.includes("?"))),
      removedApplauseRate: roundRate(rateRows(edits, (row) =>
        /^(great point|love this|so true|exactly|couldn'?t agree more)\b/i.test(row.originalText!.trim())
        && !/^(great point|love this|so true|exactly|couldn'?t agree more)\b/i.test(row.finalText!.trim())
      )),
      removedHedgeRate: roundRate(rateRows(edits, (row) =>
        /\b(maybe|perhaps|i think|it seems)\b/i.test(row.originalText!)
        && !/\b(maybe|perhaps|i think|it seems)\b/i.test(row.finalText!)
      ))
    },
    positiveExamples: uniqueTexts(positives).slice(0, 6),
    negativeExamples: uniqueTexts(negatives).slice(0, 6),
    guidance: []
  };
  profile.guidance = deriveTasteGuidance(profile);
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
  const cutoff = new Date(Date.now() - RECENT_ARCHIVE_EXAMPLE_WINDOW_MS).toISOString();
  const similar = uniqueTrustedStyleExamples(
    getSimilarExamples(db, query, kind, Math.max(limit * 8, limit), { excludeXArchiveCreatedAtSince: cutoff })
  ).slice(0, limit);
  if (similar.length > 0) {
    return similar;
  }
  return uniqueTrustedStyleExamples(getWritingExamples(db, 1000))
    .filter((example) => example.kind === kind || example.kind !== "post")
    .filter((example) => !isRecentXArchiveExample(example, cutoff))
    .slice(0, limit);
}

/**
 * Style must come from the user's archive or an explicit manual edit. Published
 * helper output remains available for outcomes/taste, but cannot train itself.
 */
function uniqueTrustedStyleExamples(examples: WritingExample[]): WritingExample[] {
  const seen = new Set<string>();
  return examples.filter((example) => {
    if (example.source !== "x-archive" && example.source !== "feedback") return false;
    const normalized = normalizeForStorage(example.text);
    if (!normalized) return false;
    const key = `${example.kind}:${normalized}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecentXArchiveExample(example: WritingExample, cutoff: string): boolean {
  return example.source === "x-archive" && example.createdAt >= cutoff;
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

function getLatestTasteFeedback(db: AppDatabase, limit = 300): TasteFeedbackRow[] {
  const rows = db.prepare(
    `SELECT suggestion_id as suggestionId, decision, original_text as originalText,
            final_text as finalText, created_at as createdAt
     FROM feedback
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`
  ).all(limit) as unknown as TasteFeedbackRow[];
  const selected = new Map<string, TasteFeedbackRow>();
  for (const row of rows) {
    // Model suggestion IDs are often reused (for example "1", "2", "3") in
    // unrelated generations. Pair the ID with its original text so unrelated
    // feedback cannot overwrite another signal, while exact retries collapse.
    const original = normalizeForStorage(row.originalText ?? row.finalText ?? "");
    const key = `${row.suggestionId}:${original}`;
    if (!selected.has(key)) selected.set(key, row);
  }
  const signals = [...selected.values()];
  const editedFinals = new Set(
    signals
      .filter((row) => row.decision === "edited" && row.finalText)
      .map((row) => `${row.suggestionId}:${normalizeForStorage(row.finalText!)}`)
  );
  // Publishing an already-edited draft records a later "accepted" event for
  // the edited text. Keep the edit pair and discard that redundant acceptance.
  return signals.filter((row) =>
    row.decision !== "accepted"
    || !editedFinals.has(`${row.suggestionId}:${normalizeForStorage(row.finalText ?? "")}`)
  );
}

function getPublishedTasteSignals(db: AppDatabase, limit = 100): TasteFeedbackRow[] {
  const rows = db.prepare(
    `SELECT id, text, created_at as createdAt
     FROM writing_examples
     WHERE source = 'outcome'
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(limit) as Array<{ id: string; text: string; createdAt: string }>;
  return rows.map((row) => ({
    suggestionId: `published:${row.id}`,
    decision: "accepted",
    originalText: row.text,
    finalText: row.text,
    createdAt: row.createdAt
  }));
}

function deriveTasteGuidance(profile: PersonalTasteProfile): string[] {
  const guidance = [
    "Prefer silence to a generic, performative, or redundant reply.",
    "Choose the stance that fits the source before choosing a writing style.",
    "A reply must add a distinct observation, useful answer, earned question, or necessary qualification."
  ];
  if (profile.preferredDraft.avgWords > 0 && profile.preferredDraft.avgWords <= 24) {
    guidance.push(`Keep replies close to the user's concise norm of about ${profile.preferredDraft.avgWords} words.`);
  }
  if (profile.editSignals.shorterRate >= 0.6) {
    guidance.push("The user usually shortens generated drafts; cut harder before presenting one.");
  }
  if (profile.editSignals.removedQuestionRate >= 0.4) {
    guidance.push("The user often removes generated questions; ask only when the question is the strongest contribution.");
  }
  if (profile.editSignals.removedApplauseRate > 0) {
    guidance.push("Do not lead with praise or agreement filler.");
  }
  if (profile.editSignals.removedHedgeRate >= 0.4) {
    guidance.push("Prefer direct claims over unnecessary hedging.");
  }
  if (profile.preferredDraft.disagreementRate < 0.15 && profile.sampleCount >= 8) {
    guidance.push("Do not manufacture disagreement merely to sound sharp.");
  }
  return guidance;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function textRate(texts: string[], predicate: (text: string) => boolean): number {
  return texts.length ? texts.filter(predicate).length / texts.length : 0;
}

function rateRows<T>(rows: T[], predicate: (row: T) => boolean): number {
  return rows.length ? rows.filter(predicate).length / rows.length : 0;
}

function uniqueTexts(texts: string[]): string[] {
  const seen = new Set<string>();
  return texts.filter((text) => {
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
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

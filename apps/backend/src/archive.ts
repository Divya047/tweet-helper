import { unzipSync } from "fflate";
import type { WritingExampleInput } from "./db.js";

interface ArchiveTweetRecord {
  tweet?: Record<string, unknown>;
}

export interface ArchiveImportResult {
  examples: WritingExampleInput[];
  filesRead: string[];
}

export function parseXArchiveZip(buffer: Uint8Array): ArchiveImportResult {
  const unzipped = unzipSync(buffer);
  const decoder = new TextDecoder();
  const examples: WritingExampleInput[] = [];
  const filesRead: string[] = [];

  for (const [fileName, content] of Object.entries(unzipped)) {
    if (!isTweetDataFile(fileName)) {
      continue;
    }
    const text = decoder.decode(content);
    if (!text.includes("YTD") && !text.trim().startsWith("[")) {
      continue;
    }
    const parsed = parseTweetsJs(text);
    if (parsed.length > 0) {
      filesRead.push(fileName);
      examples.push(...parsed);
    }
  }

  return { examples: dedupeExamples(examples), filesRead };
}

export function parseTweetsJs(text: string): WritingExampleInput[] {
  const jsonText = extractAssignedJson(text);
  const parsed = JSON.parse(jsonText) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  const examples: WritingExampleInput[] = [];
  for (const item of parsed as ArchiveTweetRecord[]) {
    const tweet = item.tweet ?? (item as Record<string, unknown>);
    const fullText = stringValue(tweet.full_text) ?? stringValue(tweet.text);
    const id = stringValue(tweet.id_str) ?? stringValue(tweet.id);
    if (!id || !fullText || fullText.trim().startsWith("RT @")) {
      continue;
    }

    const createdAt = parseCreatedAt(stringValue(tweet.created_at));
    const replyToUser = stringValue(tweet.in_reply_to_screen_name);
    const isReply = Boolean(stringValue(tweet.in_reply_to_status_id_str) || replyToUser);

    examples.push({
      id: `x:${id}`,
      kind: isReply ? "comment" : "post",
      text: fullText.trim(),
      source: "x-archive",
      ...(createdAt ? { createdAt } : {}),
      ...(replyToUser ? { replyToUser } : {})
    });
  }

  return examples;
}

function isTweetDataFile(fileName: string): boolean {
  return /(^|\/)data\/(tweets|tweet|tweets-part\d+|note-tweet).*\.js$/i.test(fileName);
}

function extractAssignedJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return trimmed.replace(/;$/, "");
  }
  const separator = trimmed.indexOf("=");
  if (separator === -1) {
    throw new Error("Archive tweet file does not look like an assigned JSON file.");
  }
  return trimmed.slice(separator + 1).trim().replace(/;$/, "");
}

function parseCreatedAt(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function dedupeExamples(examples: WritingExampleInput[]): WritingExampleInput[] {
  const byId = new Map<string, WritingExampleInput>();
  for (const example of examples) {
    byId.set(example.id, example);
  }
  return [...byId.values()];
}

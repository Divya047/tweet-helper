import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ContentKind, FeedbackDecision } from "@tweet-helper/shared";

export interface WritingExampleInput {
  id: string;
  kind: ContentKind;
  text: string;
  createdAt?: string;
  source: string;
  replyToUser?: string;
}

export interface WritingExample extends Required<Omit<WritingExampleInput, "replyToUser" | "createdAt">> {
  rowid: number;
  createdAt: string;
  replyToUser: string | null;
}

export interface WritingExampleFilters {
  excludeXArchiveCreatedAtSince?: string;
}

export interface CachedGeneration {
  responseJson: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
}

export interface FeedbackInput {
  suggestionId: string;
  kind: ContentKind;
  decision: FeedbackDecision;
  originalText?: string;
  finalText?: string;
  contextJson?: string;
}

export type AppDatabase = DatabaseSync;

export function openDatabase(dbPath: string): AppDatabase {
  const resolved = dbPath === ":memory:" ? dbPath : resolve(dbPath);
  if (resolved !== ":memory:") {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

export function migrate(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS writing_examples (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('post', 'comment', 'reply')),
      text TEXT NOT NULL,
      normalized TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      reply_to_user TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS writing_examples_fts
    USING fts5(text, kind, content='writing_examples', content_rowid='rowid');

    CREATE TRIGGER IF NOT EXISTS writing_examples_ai AFTER INSERT ON writing_examples BEGIN
      INSERT INTO writing_examples_fts(rowid, text, kind) VALUES (new.rowid, new.text, new.kind);
    END;

    CREATE TRIGGER IF NOT EXISTS writing_examples_ad AFTER DELETE ON writing_examples BEGIN
      INSERT INTO writing_examples_fts(writing_examples_fts, rowid, text, kind)
      VALUES('delete', old.rowid, old.text, old.kind);
    END;

    CREATE TRIGGER IF NOT EXISTS writing_examples_au AFTER UPDATE ON writing_examples BEGIN
      INSERT INTO writing_examples_fts(writing_examples_fts, rowid, text, kind)
      VALUES('delete', old.rowid, old.text, old.kind);
      INSERT INTO writing_examples_fts(rowid, text, kind) VALUES (new.rowid, new.text, new.kind);
    END;

    CREATE TABLE IF NOT EXISTS style_profiles (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS generation_cache (
      cache_key TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id TEXT PRIMARY KEY,
      cache_key TEXT,
      endpoint TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      suggestion_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      decision TEXT NOT NULL,
      original_text TEXT,
      final_text TEXT,
      context_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

export function initializeSettings(db: AppDatabase, defaults: Record<string, unknown>): void {
  const stmt = db.prepare("INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES (?, ?, ?)");
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(defaults)) {
    stmt.run(key, JSON.stringify(value), now);
  }
}

export function getSettings(db: AppDatabase): Record<string, unknown> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = JSON.parse(row.value);
  }
  return result;
}

export function updateSettings(db: AppDatabase, values: Record<string, unknown>): Record<string, unknown> {
  const stmt = db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(values)) {
    stmt.run(key, JSON.stringify(value), now);
  }
  return getSettings(db);
}

export function upsertWritingExamples(db: AppDatabase, examples: WritingExampleInput[]): number {
  const stmt = db.prepare(`
    INSERT INTO writing_examples(id, kind, text, normalized, created_at, source, reply_to_user)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      text = excluded.text,
      normalized = excluded.normalized,
      created_at = excluded.created_at,
      source = excluded.source,
      reply_to_user = excluded.reply_to_user
  `);
  let count = 0;
  for (const example of examples) {
    const text = example.text.trim();
    if (!text) {
      continue;
    }
    stmt.run(
      example.id,
      example.kind,
      text,
      normalizeForStorage(text),
      example.createdAt ?? new Date().toISOString(),
      example.source,
      example.replyToUser ?? null
    );
    count += 1;
  }
  return count;
}

export function getWritingExamples(db: AppDatabase, limit = 500): WritingExample[] {
  return db
    .prepare(
      `SELECT rowid, id, kind, text, created_at as createdAt, source, reply_to_user as replyToUser
       FROM writing_examples
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as unknown as WritingExample[];
}

export function getRecentXArchiveExamples(db: AppDatabase, isoTimestamp: string, limit = 100): WritingExample[] {
  return db
    .prepare(
      `SELECT rowid, id, kind, text, created_at as createdAt, source, reply_to_user as replyToUser
       FROM writing_examples
       WHERE source = 'x-archive' AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(isoTimestamp, limit) as unknown as WritingExample[];
}

export function getSimilarExamples(
  db: AppDatabase,
  query: string,
  kind: ContentKind,
  limit = 8,
  filters: WritingExampleFilters = {}
): WritingExample[] {
  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery) {
    try {
      const rows = db
        .prepare(
          `SELECT e.rowid, e.id, e.kind, e.text, e.created_at as createdAt, e.source, e.reply_to_user as replyToUser
           FROM writing_examples_fts f
           JOIN writing_examples e ON e.rowid = f.rowid
           WHERE writing_examples_fts MATCH ? AND e.kind IN (?, 'reply', 'comment')
             AND (? IS NULL OR NOT (e.source = 'x-archive' AND e.created_at >= ?))
           ORDER BY bm25(writing_examples_fts)
           LIMIT ?`
        )
        .all(ftsQuery, kind, filters.excludeXArchiveCreatedAtSince ?? null, filters.excludeXArchiveCreatedAtSince ?? null, limit) as unknown as WritingExample[];
      if (rows.length > 0) {
        return rows;
      }
    } catch {
      // Fall back to simple LIKE below if FTS cannot parse a query.
    }
  }

  const normalized = `%${normalizeForStorage(query).split(" ").slice(0, 4).join("%")}%`;
  return db
    .prepare(
      `SELECT rowid, id, kind, text, created_at as createdAt, source, reply_to_user as replyToUser
       FROM writing_examples
       WHERE normalized LIKE ? AND kind IN (?, 'reply', 'comment')
         AND (? IS NULL OR NOT (source = 'x-archive' AND created_at >= ?))
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(normalized, kind, filters.excludeXArchiveCreatedAtSince ?? null, filters.excludeXArchiveCreatedAtSince ?? null, limit) as unknown as WritingExample[];
}

export function getStyleProfile(db: AppDatabase): string | undefined {
  const row = db.prepare("SELECT json FROM style_profiles WHERE id = 'default'").get() as { json: string } | undefined;
  return row?.json;
}

export function saveStyleProfile(db: AppDatabase, json: string): void {
  db.prepare(
    `INSERT INTO style_profiles(id, json, updated_at) VALUES ('default', ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
  ).run(json, new Date().toISOString());
}

export function getCachedGeneration(db: AppDatabase, cacheKey: string): CachedGeneration | undefined {
  const row = db
    .prepare(
      `SELECT response_json as responseJson, input_tokens as inputTokens, output_tokens as outputTokens,
              cost_usd as costUsd, created_at as createdAt
       FROM generation_cache WHERE cache_key = ?`
    )
    .get(cacheKey) as CachedGeneration | undefined;
  return row;
}

export function saveCachedGeneration(
  db: AppDatabase,
  cacheKey: string,
  responseJson: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number
): void {
  db.prepare(
    `INSERT INTO generation_cache(cache_key, response_json, input_tokens, output_tokens, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       response_json = excluded.response_json,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cost_usd = excluded.cost_usd,
       created_at = excluded.created_at`
  ).run(cacheKey, responseJson, inputTokens, outputTokens, costUsd, new Date().toISOString());
}

export function logUsage(
  db: AppDatabase,
  endpoint: string,
  cacheKey: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number
): void {
  db.prepare(
    `INSERT INTO usage_log(id, cache_key, endpoint, input_tokens, output_tokens, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), cacheKey, endpoint, inputTokens, outputTokens, costUsd, new Date().toISOString());
}

export function getUsageSince(db: AppDatabase, isoTimestamp: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_log WHERE created_at >= ?").get(isoTimestamp) as {
    total: number;
  };
  return row.total;
}

export function saveFeedback(db: AppDatabase, input: FeedbackInput): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO feedback(id, suggestion_id, kind, decision, original_text, final_text, context_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.suggestionId,
    input.kind,
    input.decision,
    input.originalText ?? null,
    input.finalText ?? null,
    input.contextJson ?? null,
    new Date().toISOString()
  );
  return id;
}

export function normalizeForStorage(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{Letter}\p{Number}\s#@]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFtsQuery(value: string): string {
  const stopWords = new Set(["with", "that", "this", "from", "have", "your", "what", "when", "will", "just"]);
  const terms = normalizeForStorage(value)
    .split(" ")
    .filter((term) => term.length >= 4 && !stopWords.has(term))
    .slice(0, 8);
  return terms.join(" OR ");
}

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ContentKind, FeedbackDecision, Outcome, OutcomeKind, SourcePost, WorkItem, WorkItemStatus, WorkSession, WorkSessionStatus } from "@tweet-helper/shared";

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

    CREATE TABLE IF NOT EXISTS work_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'archived')) DEFAULT 'active',
      soft_goal INTEGER NOT NULL DEFAULT 8 CHECK (soft_goal > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      source_post_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'drafted', 'used', 'published', 'skipped')) DEFAULT 'pending',
      recommendation TEXT,
      score REAL,
      draft_response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, position)
    );

    CREATE TABLE IF NOT EXISTS outcomes (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('used', 'published')),
      idempotency_key TEXT NOT NULL UNIQUE,
      text TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(work_item_id, kind)
    );

    CREATE INDEX IF NOT EXISTS work_sessions_status_updated ON work_sessions(status, updated_at);
    CREATE INDEX IF NOT EXISTS work_items_session_position ON work_items(session_id, position);
    CREATE INDEX IF NOT EXISTS outcomes_created_kind ON outcomes(created_at, kind);
  `);
}

export function createWorkSession(db: AppDatabase, input: { title?: string; softGoal?: number } = {}): WorkSession {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO work_sessions(id,title,status,soft_goal,created_at,updated_at) VALUES(?,?,'active',?,?,?)`)
    .run(id, input.title?.trim() || "Tweet work session", Math.max(1, Math.round(input.softGoal ?? 8)), now, now);
  return getWorkSession(db, id)!;
}

export function listWorkSessions(db: AppDatabase, includeArchived = false): WorkSession[] {
  const rows = db.prepare(`SELECT id,title,status,soft_goal as softGoal,created_at as createdAt,updated_at as updatedAt,archived_at as archivedAt FROM work_sessions WHERE (? = 1 OR status != 'archived') ORDER BY updated_at DESC`)
    .all(includeArchived ? 1 : 0) as unknown as WorkSession[];
  return rows.map(cleanSession);
}

export function getWorkSession(db: AppDatabase, id: string): WorkSession | undefined {
  const row = db.prepare(`SELECT id,title,status,soft_goal as softGoal,created_at as createdAt,updated_at as updatedAt,archived_at as archivedAt FROM work_sessions WHERE id=?`).get(id) as unknown as WorkSession | undefined;
  return row ? { ...cleanSession(row), items: listWorkItems(db, id) } : undefined;
}

export function updateWorkSession(db: AppDatabase, id: string, input: { title?: string; status?: WorkSessionStatus; softGoal?: number }): WorkSession | undefined {
  const current = getWorkSession(db, id);
  if (!current) return undefined;
  const status = input.status ?? current.status;
  const now = new Date().toISOString();
  db.prepare(`UPDATE work_sessions SET title=?,status=?,soft_goal=?,updated_at=?,archived_at=? WHERE id=?`).run(
    input.title?.trim() || current.title, status, Math.max(1, Math.round(input.softGoal ?? current.softGoal)), now,
    status === "archived" ? current.archivedAt ?? now : null, id
  );
  return getWorkSession(db, id);
}

export function deleteWorkSession(db: AppDatabase, id: string): boolean {
  return db.prepare("DELETE FROM work_sessions WHERE id=?").run(id).changes > 0;
}

export function appendWorkItems(db: AppDatabase, sessionId: string, posts: SourcePost[]): WorkItem[] {
  const next = db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS position FROM work_items WHERE session_id=?").get(sessionId) as { position: number };
  const now = new Date().toISOString();
  const stmt = db.prepare(`INSERT INTO work_items(id,session_id,position,source_post_json,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)`);
  posts.forEach((post, index) => stmt.run(crypto.randomUUID(), sessionId, next.position + index, JSON.stringify(post), now, now));
  db.prepare("UPDATE work_sessions SET updated_at=? WHERE id=?").run(now, sessionId);
  return listWorkItems(db, sessionId);
}

export function listWorkItems(db: AppDatabase, sessionId: string): WorkItem[] {
  const rows = db.prepare(`SELECT id,session_id as sessionId,position,source_post_json as sourcePostJson,status,recommendation,score,draft_response_json as draftResponseJson,created_at as createdAt,updated_at as updatedAt FROM work_items WHERE session_id=? ORDER BY position`).all(sessionId) as Array<Record<string, unknown>>;
  return rows.map(rowToWorkItem);
}

export function updateWorkItem(db: AppDatabase, id: string, input: { status?: WorkItemStatus; recommendation?: string; score?: number; draftResponse?: unknown }): WorkItem | undefined {
  const currentRow = db.prepare(`SELECT id,session_id as sessionId,position,source_post_json as sourcePostJson,status,recommendation,score,draft_response_json as draftResponseJson,created_at as createdAt,updated_at as updatedAt FROM work_items WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!currentRow) return undefined;
  const current = rowToWorkItem(currentRow);
  const now = new Date().toISOString();
  db.prepare(`UPDATE work_items SET status=?,recommendation=?,score=?,draft_response_json=?,updated_at=? WHERE id=?`).run(
    input.status ?? current.status, input.recommendation ?? current.recommendation ?? null, input.score ?? current.score ?? null,
    input.draftResponse === undefined ? (current.draftResponse ? JSON.stringify(current.draftResponse) : null) : JSON.stringify(input.draftResponse), now, id
  );
  return rowToWorkItem(db.prepare(`SELECT id,session_id as sessionId,position,source_post_json as sourcePostJson,status,recommendation,score,draft_response_json as draftResponseJson,created_at as createdAt,updated_at as updatedAt FROM work_items WHERE id=?`).get(id) as Record<string, unknown>);
}

export function saveOutcome(db: AppDatabase, input: { workItemId: string; kind: OutcomeKind; idempotencyKey: string; text?: string; externalId?: string }): { outcome: Outcome; created: boolean } {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const result = db.prepare(`INSERT OR IGNORE INTO outcomes(id,work_item_id,kind,idempotency_key,text,external_id,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id,input.workItemId,input.kind,input.idempotencyKey,input.text ?? null,input.externalId ?? null,now);
  const row = db.prepare(`SELECT id,work_item_id as workItemId,kind,idempotency_key as idempotencyKey,text,external_id as externalId,created_at as createdAt FROM outcomes WHERE idempotency_key=? OR (work_item_id=? AND kind=?) LIMIT 1`).get(input.idempotencyKey,input.workItemId,input.kind) as unknown as Outcome;
  if (result.changes) updateWorkItem(db,input.workItemId,{status: input.kind});
  return { outcome: cleanOutcome(row), created: result.changes > 0 };
}

export function getTodayProgress(db: AppDatabase, now = new Date()): { date: string; used: number; published: number; completed: number; softGoal: number; remaining: number } {
  const date = now.toISOString().slice(0,10);
  const since = `${date}T00:00:00.000Z`;
  const counts = db.prepare(`SELECT SUM(kind='used') as used,SUM(kind='published') as published,COUNT(*) as completed FROM outcomes WHERE created_at>=?`).get(since) as { used: number|null; published:number|null; completed:number };
  const goal = db.prepare(`SELECT COALESCE(MAX(soft_goal),8) as softGoal FROM work_sessions WHERE status='active'`).get() as { softGoal:number };
  return { date, used: counts.used ?? 0, published: counts.published ?? 0, completed: counts.completed ?? 0, softGoal: goal.softGoal, remaining: Math.max(0,goal.softGoal-(counts.completed ?? 0)) };
}

export function reconcileArchiveOutcomes(db: AppDatabase, examples: WritingExampleInput[]): number {
  let reconciled = 0;
  const candidates=db.prepare(`SELECT wi.id,wi.draft_response_json as draftResponseJson FROM work_items wi LEFT JOIN outcomes o ON o.work_item_id=wi.id AND o.kind='published' WHERE o.id IS NULL AND wi.draft_response_json IS NOT NULL ORDER BY wi.updated_at DESC`).all() as Array<{id:string;draftResponseJson:string}>;
  for (const example of examples) {
    const normalized = normalizeForStorage(example.text);
    const item = candidates.find((candidate) => {
      try {
        const draft=JSON.parse(candidate.draftResponseJson) as {suggestions?:Array<{text?:string}>};
        return draft.suggestions?.some((suggestion)=>typeof suggestion.text === "string" && normalizeForStorage(suggestion.text) === normalized);
      } catch { return false; }
    });
    if (item) {
      const result=saveOutcome(db,{workItemId:item.id,kind:"published",idempotencyKey:`archive:${example.id}`,text:example.text,externalId:example.id});
      if (result.created) reconciled += 1;
    }
  }
  return reconciled;
}

function rowToWorkItem(row: Record<string, unknown>): WorkItem {
  const recommendation=typeof row.recommendation === "string" ? row.recommendation as NonNullable<WorkItem["recommendation"]> : undefined;
  return { id:String(row.id),sessionId:String(row.sessionId),position:Number(row.position),sourcePost:JSON.parse(String(row.sourcePostJson)),status:row.status as WorkItemStatus,
    ...(recommendation ? {recommendation}:{}),...(typeof row.score === "number" ? {score:row.score}:{}),
    ...(row.draftResponseJson ? {draftResponse:JSON.parse(String(row.draftResponseJson))}:{}),createdAt:String(row.createdAt),updatedAt:String(row.updatedAt) };
}
function cleanSession(row: WorkSession): WorkSession { const { archivedAt, ...rest }=row; return archivedAt ? row : rest; }
function cleanOutcome(row: Outcome): Outcome { const {text,externalId,...rest}=row; return {...rest,...(text?{text}:{}),...(externalId?{externalId}:{})}; }

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

export function getPairedReplyExamples(db: AppDatabase, sourceText: string, limit = 8): Array<{ sourceText: string; replyText: string }> {
  const terms = normalizeForStorage(sourceText).split(" ").filter((term) => term.length >= 4).slice(0, 4);
  if (!terms.length) return [];
  const rows = db.prepare(`SELECT context_json as contextJson,final_text as replyText FROM feedback WHERE decision IN ('accepted','edited') AND final_text IS NOT NULL AND context_json IS NOT NULL ORDER BY created_at DESC LIMIT 200`).all() as Array<{contextJson:string;replyText:string}>;
  return rows.flatMap((row) => {
    try {
      const context = JSON.parse(row.contextJson) as { sourcePost?: SourcePost; sourceText?: string };
      const pairedSource = context.sourcePost?.text ?? context.sourceText;
      if (!pairedSource || !terms.some((term) => normalizeForStorage(pairedSource).includes(term))) return [];
      return [{sourceText:pairedSource,replyText:row.replyText}];
    } catch { return []; }
  }).slice(0,limit);
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

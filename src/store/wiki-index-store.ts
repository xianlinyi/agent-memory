import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RawDocument, WikiPage, WikiSearchResult, WikiStatus } from "../types.js";
import { importNodeSqlite } from "../utils/node-sqlite.js";
import { nowIso } from "../utils/time.js";

interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
  close(): void;
}

export class WikiIndexStore {
  private database?: Database;

  constructor(
    private readonly options: {
      databasePath: string;
      vaultPath: string;
    }
  ) {}

  async init(): Promise<void> {
    if (this.database) return;
    await mkdir(dirname(this.options.databasePath), { recursive: true });
    const { DatabaseSync } = await importNodeSqlite();
    this.database = new DatabaseSync(this.options.databasePath) as Database;
    this.database.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
  }

  async rebuild(input: { pages: WikiPage[]; rawDocuments: RawDocument[] }): Promise<void> {
    const db = this.db();
    db.exec("DELETE FROM entity_terms; DELETE FROM page_links; DELETE FROM source_refs; DELETE FROM wiki_fts; DELETE FROM pages; DELETE FROM raw_documents;");
    const insertRaw = db.prepare("INSERT INTO raw_documents(id, path, kind, label, uri, content_hash, created_at, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const raw of input.rawDocuments) {
      insertRaw.run(raw.id, raw.path, raw.kind, raw.label, raw.uri ?? null, raw.contentHash, raw.createdAt, raw.text);
    }

    const insertPage = db.prepare("INSERT INTO pages(id, path, title, type, summary, tags, aliases, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertEntityTerm = db.prepare("INSERT OR REPLACE INTO entity_terms(term, page_id, field, weight) VALUES (?, ?, ?, ?)");
    const insertLink = db.prepare("INSERT INTO page_links(page_id, target_title) VALUES (?, ?)");
    const insertSourceRef = db.prepare("INSERT INTO source_refs(page_id, raw_id) VALUES (?, ?)");
    const insertFts = db.prepare("INSERT INTO wiki_fts(kind, ref_id, title, text) VALUES ('page', ?, ?, ?)");
    for (const page of input.pages) {
      insertPage.run(page.id, page.path, page.title, page.type, page.summary, JSON.stringify(page.tags), JSON.stringify(page.aliases), page.body, page.createdAt, page.updatedAt);
      for (const term of collectEntityTerms(page)) insertEntityTerm.run(term.term, page.id, term.field, term.weight);
      for (const link of page.links) insertLink.run(page.id, link);
      for (const sourceId of page.sourceIds) insertSourceRef.run(page.id, sourceId);
      insertFts.run(page.id, page.title, [page.summary, page.body, page.canonical ?? "", page.tags.join(" "), page.aliases.join(" "), page.hints.join(" "), page.entrypoints.join(" ")].join("\n"));
    }
    const insertRawFts = db.prepare("INSERT INTO wiki_fts(kind, ref_id, title, text) VALUES ('raw', ?, ?, ?)");
    for (const raw of input.rawDocuments) {
      insertRawFts.run(raw.id, raw.label, raw.text);
    }
    db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('last_reindex_at', ?)").run(nowIso());
  }

  async lookupTerms(query: string, limit: number, pages: WikiPage[], rawDocuments: RawDocument[]): Promise<WikiSearchResult[]> {
    const db = this.db();
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const rawById = new Map(rawDocuments.map((raw) => [raw.id, raw]));
    const placeholders = terms.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT page_id, SUM(weight) AS score
         FROM entity_terms
         WHERE term IN (${placeholders})
         GROUP BY page_id
         ORDER BY score DESC, page_id ASC
         LIMIT ?`
      )
      .all(...terms, limit * 2);
    const results: WikiSearchResult[] = [];
    for (const row of rows) {
      const page = pageById.get(String(row.page_id));
      if (!page) continue;
      results.push({
        page,
        score: Number(row.score ?? 0),
        snippet: page.summary,
        sources: page.sourceIds.map((id) => rawById.get(id)).filter((raw): raw is RawDocument => Boolean(raw))
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  async search(query: string, limit: number, pages: WikiPage[], rawDocuments: RawDocument[]): Promise<WikiSearchResult[]> {
    const db = this.db();
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const rawById = new Map(rawDocuments.map((raw) => [raw.id, raw]));
    const rows = db
      .prepare(
        `SELECT kind, ref_id, title, snippet(wiki_fts, 3, '', '', ' ... ', 12) AS snippet, bm25(wiki_fts) AS rank
         FROM wiki_fts
         WHERE wiki_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(sanitizeFtsQuery(query), limit * 2);
    const results: WikiSearchResult[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.kind !== "page") continue;
      const page = pageById.get(String(row.ref_id));
      if (!page || seen.has(page.id)) continue;
      seen.add(page.id);
      results.push({
        page,
        score: Math.abs(Number(row.rank ?? 0)),
        snippet: String(row.snippet ?? page.summary),
        sources: page.sourceIds.map((id) => rawById.get(id)).filter((raw): raw is RawDocument => Boolean(raw))
      });
      if (results.length >= limit) break;
    }
    if (results.length > 0) return results;
    return fallbackSearch(query, limit, pages, rawById);
  }

  async status(): Promise<WikiStatus> {
    const db = this.db();
    const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
    const countPages = (prefix: string) => Number(db.prepare("SELECT COUNT(*) AS count FROM pages WHERE path LIKE ?").get(`${prefix}/%`)?.count ?? 0);
    return {
      vaultPath: this.options.vaultPath,
      databasePath: this.options.databasePath,
      counts: {
        rawDocuments: count("raw_documents"),
        wikiPages: countPages("wiki"),
        memoryPages: countPages("memory"),
        longMemoryPages: countPages("memory/long"),
        wikiUpdateCandidates: countPages("memory/wiki-update-candidates"),
        links: count("page_links"),
        sourceRefs: count("source_refs")
      },
      lastReindexAt: String(db.prepare("SELECT value FROM metadata WHERE key = 'last_reindex_at'").get()?.value ?? "") || undefined
    };
  }

  private db(): Database {
    if (!this.database) throw new Error("Wiki index store is not initialized.");
    return this.database;
  }
}

function fallbackSearch(query: string, limit: number, pages: WikiPage[], rawById: Map<string, RawDocument>): WikiSearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return pages
    .map((page) => {
      const haystack = [page.title, page.summary, page.body, page.canonical ?? "", page.tags.join(" "), page.aliases.join(" "), page.hints.join(" "), page.entrypoints.join(" ")].join("\n").toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { page, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ page, score }) => ({
      page,
      score,
      snippet: page.summary,
      sources: page.sourceIds.map((id) => rawById.get(id)).filter((raw): raw is RawDocument => Boolean(raw))
    }));
}

function sanitizeFtsQuery(query: string): string {
  const terms = queryTerms(query);
  return terms.length > 0 ? terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ") : "\"\"";
}

function queryTerms(query: string): string[] {
  return uniqueTerms(
    query
      .split(/\s+/)
      .flatMap((chunk) => expandEntityTerms(chunk))
      .filter((term) => term.length > 1 && !COMMON_QUERY_TERMS.has(term))
  );
}

function collectEntityTerms(page: WikiPage): Array<{ term: string; field: string; weight: number }> {
  const fields: Array<{ field: string; weight: number; values: string[] }> = [
    { field: "title", weight: 100, values: [page.title] },
    { field: "canonical", weight: 90, values: page.canonical ? [page.canonical] : [] },
    { field: "alias", weight: 80, values: page.aliases },
    { field: "hint", weight: 40, values: page.hints },
    { field: "entrypoint", weight: 30, values: page.entrypoints }
  ];
  const seen = new Set<string>();
  const results: Array<{ term: string; field: string; weight: number }> = [];
  for (const group of fields) {
    for (const value of group.values) {
      for (const term of expandEntityTerms(value)) {
        const key = `${group.field}:${term}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ term, field: group.field, weight: group.weight });
      }
    }
  }
  return results;
}

function expandEntityTerms(value: string): string[] {
  const normalized = normalizeEntityTerm(value);
  if (!normalized) return [];
  const tokens = normalized
    .split(/\s+/)
    .map(normalizeEntityTerm)
    .filter(Boolean);
  return uniqueTerms([normalized, ...tokens]);
}

function normalizeEntityTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueTerms(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

const COMMON_QUERY_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "does",
  "for",
  "how",
  "i",
  "is",
  "me",
  "my",
  "of",
  "or",
  "the",
  "to",
  "what",
  "when",
  "where",
  "why"
]);

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS raw_documents(
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  uri TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages(
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL,
  aliases TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_links(page_id TEXT NOT NULL, target_title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_refs(page_id TEXT NOT NULL, raw_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entity_terms(term TEXT NOT NULL, page_id TEXT NOT NULL, field TEXT NOT NULL, weight INTEGER NOT NULL, PRIMARY KEY(term, page_id, field));
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(kind, ref_id UNINDEXED, title, text);
`;

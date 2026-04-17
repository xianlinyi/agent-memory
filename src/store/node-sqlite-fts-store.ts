import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { GraphStore } from "./graph-store.js";
import type { Entity, Episode, GraphSnapshot, MemoryMatch, MemoryStatus, Relation, SourceRef } from "../types.js";

const SCHEMA_VERSION = 1;

type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
};

type StatementSync = {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
};

export class NodeSqliteFtsGraphStore implements GraphStore {
  private db?: DatabaseSync;

  constructor(
    private readonly options: {
      databasePath: string;
      vaultPath: string;
    }
  ) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.options.databasePath), { recursive: true });
    this.db = await openDatabase(this.options.databasePath);
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec(SCHEMA_SQL);
    this.database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, new Date().toISOString());
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  async upsertEntity(entity: Entity): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO entities(id, name, type, summary, confidence, created_at, updated_at, external_refs, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           type=excluded.type,
           summary=excluded.summary,
           confidence=excluded.confidence,
           updated_at=excluded.updated_at,
           external_refs=excluded.external_refs,
           file_path=excluded.file_path`
      )
      .run(
        entity.id,
        entity.name,
        entity.type,
        entity.summary ?? "",
        entity.confidence,
        entity.createdAt,
        entity.updatedAt,
        JSON.stringify(entity.externalRefs ?? {}),
        entity.filePath ?? null
      );

    this.database.prepare("DELETE FROM aliases WHERE entity_id = ?").run(entity.id);
    for (const alias of entity.aliases) {
      this.database.prepare("INSERT OR IGNORE INTO aliases(entity_id, alias) VALUES (?, ?)").run(entity.id, alias);
    }

    this.database.prepare("DELETE FROM tags WHERE owner_kind = 'entity' AND owner_id = ?").run(entity.id);
    for (const tag of entity.tags) {
      this.database.prepare("INSERT OR IGNORE INTO tags(owner_kind, owner_id, tag) VALUES ('entity', ?, ?)").run(entity.id, tag);
    }

    await this.reindexEntity(entity.id);
  }

  async upsertRelation(relation: Relation): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO relations(id, source_id, target_id, predicate, description, weight, confidence, created_at, updated_at, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_id=excluded.source_id,
           target_id=excluded.target_id,
           predicate=excluded.predicate,
           description=excluded.description,
           weight=excluded.weight,
           confidence=excluded.confidence,
           updated_at=excluded.updated_at,
           file_path=excluded.file_path`
      )
      .run(
        relation.id,
        relation.sourceId,
        relation.targetId,
        relation.predicate,
        relation.description ?? "",
        relation.weight,
        relation.confidence,
        relation.createdAt,
        relation.updatedAt,
        relation.filePath ?? null
      );

    this.database.prepare("DELETE FROM relation_evidence_refs WHERE relation_id = ?").run(relation.id);
    for (const evidenceId of relation.evidenceIds) {
      this.database.prepare("INSERT OR IGNORE INTO relation_evidence_refs(relation_id, evidence_id) VALUES (?, ?)").run(relation.id, evidenceId);
    }

    await this.reindexRelation(relation.id);
  }

  async upsertEpisode(episode: Episode): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO episodes(id, title, text, summary, source_id, created_at, updated_at, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title,
           text=excluded.text,
           summary=excluded.summary,
           source_id=excluded.source_id,
           updated_at=excluded.updated_at,
           file_path=excluded.file_path`
      )
      .run(
        episode.id,
        episode.title,
        episode.text,
        episode.summary ?? "",
        episode.sourceId ?? null,
        episode.createdAt,
        episode.updatedAt,
        episode.filePath ?? null
      );

    this.database.prepare("DELETE FROM entity_episode_refs WHERE episode_id = ?").run(episode.id);
    for (const entityId of episode.entityIds) {
      await this.linkEpisodeEntity(episode.id, entityId);
    }

    await this.reindexEpisode(episode.id);
  }

  async upsertSource(source: SourceRef): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO sources(id, kind, label, uri, text, created_at, updated_at, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind,
           label=excluded.label,
           uri=excluded.uri,
           text=excluded.text,
           updated_at=excluded.updated_at,
           file_path=excluded.file_path`
      )
      .run(source.id, source.kind, source.label, source.uri ?? null, source.text ?? "", source.createdAt, source.updatedAt, source.filePath ?? null);

    await this.reindexSource(source.id);
  }

  async linkEpisodeEntity(episodeId: string, entityId: string): Promise<void> {
    this.database.prepare("INSERT OR IGNORE INTO entity_episode_refs(episode_id, entity_id) VALUES (?, ?)").run(episodeId, entityId);
  }

  async search(query: string, limit: number): Promise<MemoryMatch[]> {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];

    const rows = this.database
      .prepare(
        `SELECT kind, ref_id, title, text, rank
         FROM memory_fts
         WHERE memory_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<{ kind: string; ref_id: string; title: string; text: string; rank: number }>;

    return rows.map((row, index) => ({
      kind: row.kind as MemoryMatch["kind"],
      id: row.ref_id,
      title: row.title,
      text: row.text,
      score: Math.max(0, 1 - index / Math.max(limit, 1)),
      metadata: { rank: row.rank }
    }));
  }

  async graph(entityId?: string): Promise<GraphSnapshot> {
    const entities = entityId ? this.readEntityNeighborhood(entityId) : this.readAllEntities();
    const entityIds = new Set(entities.map((entity) => entity.id));
    const relations = this.readAllRelations().filter(
      (relation) => !entityId || entityIds.has(relation.sourceId) || entityIds.has(relation.targetId)
    );
    const episodes = this.readAllEpisodes().filter((episode) => !entityId || episode.entityIds.some((id) => entityIds.has(id)));
    const sources = this.readAllSources();
    return { entities, relations, episodes, sources };
  }

  async rebuild(snapshot: GraphSnapshot): Promise<void> {
    this.database.exec("BEGIN");
    try {
      this.database.exec(TRUNCATE_SQL);
      for (const source of snapshot.sources) await this.upsertSource(source);
      for (const entity of snapshot.entities) await this.upsertEntity(entity);
      for (const episode of snapshot.episodes) await this.upsertEpisode(episode);
      for (const relation of snapshot.relations) await this.upsertRelation(relation);
      this.setMeta("last_rebuild_at", new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async reindex(): Promise<void> {
    this.database.prepare("DELETE FROM memory_fts").run();
    for (const entity of this.readAllEntities()) await this.reindexEntity(entity.id);
    for (const relation of this.readAllRelations()) await this.reindexRelation(relation.id);
    for (const episode of this.readAllEpisodes()) await this.reindexEpisode(episode.id);
    for (const source of this.readAllSources()) await this.reindexSource(source.id);
    this.setMeta("last_reindex_at", new Date().toISOString());
  }

  async status(): Promise<MemoryStatus> {
    return {
      vaultPath: this.options.vaultPath,
      databasePath: this.options.databasePath,
      schemaVersion: SCHEMA_VERSION,
      counts: {
        entities: this.count("entities"),
        relations: this.count("relations"),
        episodes: this.count("episodes"),
        sources: this.count("sources")
      },
      lastRebuildAt: this.getMeta("last_rebuild_at"),
      lastReindexAt: this.getMeta("last_reindex_at")
    };
  }

  private get database(): DatabaseSync {
    if (!this.db) {
      throw new Error("Graph store is not initialized.");
    }
    return this.db;
  }

  private async reindexEntity(id: string): Promise<void> {
    const entity = this.readEntity(id);
    if (!entity) return;
    this.database.prepare("DELETE FROM memory_fts WHERE kind = 'entity' AND ref_id = ?").run(id);
    this.database
      .prepare("INSERT INTO memory_fts(kind, ref_id, title, text) VALUES ('entity', ?, ?, ?)")
      .run(id, entity.name, [entity.name, entity.summary, entity.aliases.join(" "), entity.tags.join(" ")].join("\n"));
  }

  private async reindexRelation(id: string): Promise<void> {
    const relation = this.readRelation(id);
    if (!relation) return;
    this.database.prepare("DELETE FROM memory_fts WHERE kind = 'relation' AND ref_id = ?").run(id);
    this.database
      .prepare("INSERT INTO memory_fts(kind, ref_id, title, text) VALUES ('relation', ?, ?, ?)")
      .run(id, relation.predicate, [relation.sourceId, relation.predicate, relation.targetId, relation.description].join("\n"));
  }

  private async reindexEpisode(id: string): Promise<void> {
    const episode = this.readEpisode(id);
    if (!episode) return;
    this.database.prepare("DELETE FROM memory_fts WHERE kind = 'episode' AND ref_id = ?").run(id);
    this.database
      .prepare("INSERT INTO memory_fts(kind, ref_id, title, text) VALUES ('episode', ?, ?, ?)")
      .run(id, episode.title, [episode.title, episode.summary, episode.text].join("\n"));
  }

  private async reindexSource(id: string): Promise<void> {
    const source = this.readSource(id);
    if (!source) return;
    this.database.prepare("DELETE FROM memory_fts WHERE kind = 'source' AND ref_id = ?").run(id);
    this.database
      .prepare("INSERT INTO memory_fts(kind, ref_id, title, text) VALUES ('source', ?, ?, ?)")
      .run(id, source.label, [source.label, source.uri, source.text].join("\n"));
  }

  private readAllEntities(): Entity[] {
    const rows = this.database.prepare("SELECT * FROM entities ORDER BY updated_at DESC").all();
    return rows.map((row) => this.entityFromRow(row));
  }

  private readEntityNeighborhood(entityId: string): Entity[] {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT e.*
         FROM entities e
         WHERE e.id = ?
            OR e.id IN (SELECT source_id FROM relations WHERE target_id = ?)
            OR e.id IN (SELECT target_id FROM relations WHERE source_id = ?)
         ORDER BY e.updated_at DESC`
      )
      .all(entityId, entityId, entityId);
    return rows.map((row) => this.entityFromRow(row));
  }

  private readEntity(id: string): Entity | undefined {
    const row = this.database.prepare("SELECT * FROM entities WHERE id = ?").get(id);
    return row ? this.entityFromRow(row) : undefined;
  }

  private readAllRelations(): Relation[] {
    const rows = this.database.prepare("SELECT * FROM relations ORDER BY updated_at DESC").all();
    return rows.map((row) => this.relationFromRow(row));
  }

  private readRelation(id: string): Relation | undefined {
    const row = this.database.prepare("SELECT * FROM relations WHERE id = ?").get(id);
    return row ? this.relationFromRow(row) : undefined;
  }

  private readAllEpisodes(): Episode[] {
    const rows = this.database.prepare("SELECT * FROM episodes ORDER BY updated_at DESC").all();
    return rows.map((row) => this.episodeFromRow(row));
  }

  private readEpisode(id: string): Episode | undefined {
    const row = this.database.prepare("SELECT * FROM episodes WHERE id = ?").get(id);
    return row ? this.episodeFromRow(row) : undefined;
  }

  private readAllSources(): SourceRef[] {
    const rows = this.database.prepare("SELECT * FROM sources ORDER BY updated_at DESC").all();
    return rows.map((row) => sourceFromRow(row));
  }

  private readSource(id: string): SourceRef | undefined {
    const row = this.database.prepare("SELECT * FROM sources WHERE id = ?").get(id);
    return row ? sourceFromRow(row) : undefined;
  }

  private entityFromRow(row: Record<string, unknown>): Entity {
    const id = String(row.id);
    const aliases = this.database.prepare("SELECT alias FROM aliases WHERE entity_id = ? ORDER BY alias").all(id).map((item) => String(item.alias));
    const tags = this.database
      .prepare("SELECT tag FROM tags WHERE owner_kind = 'entity' AND owner_id = ? ORDER BY tag")
      .all(id)
      .map((item) => String(item.tag));
    return {
      id,
      name: String(row.name),
      type: String(row.type) as Entity["type"],
      summary: nullableString(row.summary),
      aliases,
      tags,
      confidence: Number(row.confidence),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      externalRefs: parseJsonRecord(row.external_refs),
      filePath: nullableString(row.file_path)
    };
  }

  private relationFromRow(row: Record<string, unknown>): Relation {
    const id = String(row.id);
    const evidenceIds = this.database
      .prepare("SELECT evidence_id FROM relation_evidence_refs WHERE relation_id = ? ORDER BY evidence_id")
      .all(id)
      .map((item) => String(item.evidence_id));
    return {
      id,
      sourceId: String(row.source_id),
      targetId: String(row.target_id),
      predicate: String(row.predicate),
      description: nullableString(row.description),
      weight: Number(row.weight),
      confidence: Number(row.confidence),
      evidenceIds,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      filePath: nullableString(row.file_path)
    };
  }

  private episodeFromRow(row: Record<string, unknown>): Episode {
    const id = String(row.id);
    const entityIds = this.database
      .prepare("SELECT entity_id FROM entity_episode_refs WHERE episode_id = ? ORDER BY entity_id")
      .all(id)
      .map((item) => String(item.entity_id));
    return {
      id,
      title: String(row.title),
      text: String(row.text),
      summary: nullableString(row.summary),
      sourceId: nullableString(row.source_id),
      entityIds,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      filePath: nullableString(row.file_path)
    };
  }

  private count(table: string): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    return Number(row?.count ?? 0);
  }

  private setMeta(key: string, value: string): void {
    this.database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  private getMeta(key: string): string | undefined {
    const row = this.database.prepare("SELECT value FROM metadata WHERE key = ?").get(key);
    return nullableString(row?.value);
  }
}

async function openDatabase(path: string): Promise<DatabaseSync> {
  const sqlite = (await import("node:sqlite")) as unknown as { DatabaseSync: new (path: string) => DatabaseSync };
  return new sqlite.DatabaseSync(path);
}

function sourceFromRow(row: Record<string, unknown>): SourceRef {
  return {
    id: String(row.id),
    kind: String(row.kind) as SourceRef["kind"],
    label: String(row.label),
    uri: nullableString(row.uri),
    text: nullableString(row.text),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    filePath: nullableString(row.file_path)
  };
}

function parseJsonRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, ""))
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(" OR ");
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  external_refs TEXT NOT NULL DEFAULT '{}',
  file_path TEXT
);

CREATE TABLE IF NOT EXISTS aliases (
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY(entity_id, alias),
  FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY(owner_kind, owner_id, tag)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  uri TEXT,
  text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  file_path TEXT
);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  summary TEXT,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  file_path TEXT,
  FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS entity_episode_refs (
  episode_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY(episode_id, entity_id),
  FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
  FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  description TEXT,
  weight REAL NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  file_path TEXT,
  FOREIGN KEY(source_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY(target_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relation_evidence_refs (
  relation_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY(relation_id, evidence_id),
  FOREIGN KEY(relation_id) REFERENCES relations(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  title,
  text
);
`;

const TRUNCATE_SQL = `
DELETE FROM relation_evidence_refs;
DELETE FROM relations;
DELETE FROM entity_episode_refs;
DELETE FROM episodes;
DELETE FROM sources;
DELETE FROM tags;
DELETE FROM aliases;
DELETE FROM entities;
DELETE FROM memory_fts;
`;

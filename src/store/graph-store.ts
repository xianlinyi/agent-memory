import type { Entity, Episode, GraphSnapshot, MemoryMatch, MemoryStatus, Relation, SourceRef } from "../types.js";

export interface SearchOptions {
  kinds?: MemoryMatch["kind"][];
}

export interface GraphStore {
  init(): Promise<void>;
  close(): Promise<void>;
  upsertEntity(entity: Entity): Promise<void>;
  upsertRelation(relation: Relation): Promise<void>;
  upsertEpisode(episode: Episode): Promise<void>;
  upsertSource(source: SourceRef): Promise<void>;
  linkEpisodeEntity(episodeId: string, entityId: string): Promise<void>;
  search(query: string, limit: number, options?: SearchOptions): Promise<MemoryMatch[]>;
  graph(entityId?: string): Promise<GraphSnapshot>;
  rebuild(snapshot: GraphSnapshot): Promise<void>;
  reindex(): Promise<void>;
  status(): Promise<MemoryStatus>;
  findEpisodeByText?(text: string): Promise<Episode | undefined>;
  findEntitiesByIds?(ids: string[]): Promise<Entity[]>;
  findRelationsByIds?(ids: string[]): Promise<Relation[]>;
  findEntityCandidates?(input: { name: string; aliases?: string[]; type?: Entity["type"]; limit?: number }): Promise<Entity[]>;
  findRelationByTriple?(input: { sourceId: string; predicate: string; targetId: string }): Promise<Relation | undefined>;
  findRelationsByEvidenceId?(episodeId: string): Promise<Relation[]>;
  findSourceById?(id: string): Promise<SourceRef | undefined>;
}

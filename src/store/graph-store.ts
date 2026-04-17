import type { Entity, Episode, GraphSnapshot, MemoryMatch, MemoryStatus, Relation, SourceRef } from "../types.js";

export interface GraphStore {
  init(): Promise<void>;
  close(): Promise<void>;
  upsertEntity(entity: Entity): Promise<void>;
  upsertRelation(relation: Relation): Promise<void>;
  upsertEpisode(episode: Episode): Promise<void>;
  upsertSource(source: SourceRef): Promise<void>;
  linkEpisodeEntity(episodeId: string, entityId: string): Promise<void>;
  search(query: string, limit: number): Promise<MemoryMatch[]>;
  graph(entityId?: string): Promise<GraphSnapshot>;
  rebuild(snapshot: GraphSnapshot): Promise<void>;
  reindex(): Promise<void>;
  status(): Promise<MemoryStatus>;
}

export interface VectorStore {
  upsert?(input: { id: string; vector: number[]; metadata?: Record<string, unknown> }): Promise<void>;
  query?(input: { vector: number[]; limit?: number }): Promise<Array<{ id: string; score: number }>>;
  delete?(id: string): Promise<void>;
}

export class NoopVectorStore implements VectorStore {}

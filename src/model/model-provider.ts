import type { ExtractedMemory, MemoryMatch, QueryHopCandidate, QueryHopDecision, QueryInterpretation } from "../types.js";

export interface ModelProvider {
  extractMemory(input: { text: string }): Promise<ExtractedMemory>;
  extractQuery(input: { text: string }): Promise<QueryInterpretation>;
  decideQueryHop?(input: {
    query: string;
    interpretation: QueryInterpretation;
    hop: number;
    maxHops: number;
    matches: MemoryMatch[];
    candidates: QueryHopCandidate[];
    visitedNodeIds: string[];
  }): Promise<QueryHopDecision>;
  synthesizeAnswer(input: { query: string; interpretation: QueryInterpretation; matches: MemoryMatch[] }): Promise<string>;
  compact?(input: { text: string }): Promise<string>;
  doctor?(input?: { modelCall?: boolean }): Promise<{ ok: boolean; message: string }>;
  close?(): Promise<void>;
}

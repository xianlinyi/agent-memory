export type ISODateString = string;

export type EntityType =
  | "concept"
  | "person"
  | "project"
  | "bug"
  | "rule"
  | "artifact"
  | "decision"
  | "topic"
  | "unknown";

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  summary?: string;
  aliases: string[];
  tags: string[];
  confidence: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  externalRefs?: Record<string, string>;
  filePath?: string;
}

export interface Relation {
  id: string;
  sourceId: string;
  targetId: string;
  predicate: string;
  description?: string;
  weight: number;
  confidence: number;
  evidenceIds: string[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
  filePath?: string;
}

export interface Episode {
  id: string;
  title: string;
  text: string;
  summary?: string;
  sourceId?: string;
  entityIds: string[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
  filePath?: string;
}

export interface SourceRef {
  id: string;
  kind: "cli" | "file" | "url" | "message" | "import" | "manual";
  label: string;
  uri?: string;
  text?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  filePath?: string;
}

export interface ExtractedMemory {
  summary: string;
  entities: Array<Partial<Entity> & Pick<Entity, "name">>;
  relations: Array<Pick<Relation, "sourceId" | "targetId" | "predicate"> & Partial<Relation>>;
}

export interface QueryInterpretation {
  keywords: string[];
  entities: string[];
  predicates: string[];
  expandedQuery: string;
}

export interface QueryHopCandidate {
  id: string;
  title: string;
  summary?: string;
}

export interface QueryHopDecision {
  continue: boolean;
  nodeIds: string[];
  reason?: string;
}

export interface QueryTraversalStep {
  hop: number;
  fromNodeIds: string[];
  selectedNodeIds: string[];
  addedMatchIds: string[];
  decisionReason?: string;
}

export interface MemoryMatch {
  kind: "entity" | "relation" | "episode" | "source";
  id: string;
  title: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface QueryResult {
  query: string;
  interpretation: QueryInterpretation;
  matches: MemoryMatch[];
  answer: string;
  traversal?: QueryTraversalStep[];
}

export interface GraphSnapshot {
  entities: Entity[];
  relations: Relation[];
  episodes: Episode[];
  sources: SourceRef[];
}

export interface MemoryStatus {
  vaultPath: string;
  databasePath: string;
  schemaVersion: number;
  counts: {
    entities: number;
    relations: number;
    episodes: number;
    sources: number;
  };
  lastRebuildAt?: ISODateString;
  lastReindexAt?: ISODateString;
}

export interface AgentMemoryConfig {
  vaultPath: string;
  databasePath: string;
  model: {
    provider: "copilot-sdk" | "copilot-cli" | string;
    model?: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    cliPath?: string;
    cliUrl?: string;
    cliArgs?: string[];
    cwd?: string;
    configDir?: string;
    githubToken?: string;
    useLoggedInUser?: boolean;
    logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";
    command?: string;
    args?: string[];
    promptInput?: "stdin" | "argument";
    timeoutMs: number;
  };
}

export interface IngestInput {
  text: string;
  source?: {
    kind?: SourceRef["kind"];
    label?: string;
    uri?: string;
  };
}

export interface QueryInput {
  text: string;
  limit?: number;
  maxHops?: number;
  synthesize?: boolean;
}

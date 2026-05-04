export type ISODateString = string;
export type MemoryClass = "episodic" | "semantic" | "procedural";
export type MemoryStage = "raw" | "session_summary" | "candidate" | "long_term" | "wiki_update_candidate" | "consolidated";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type RawTargetScope = "memory" | "wiki";

export interface MemoryMetadata {
  memoryClass?: MemoryClass;
  memoryStage?: MemoryStage;
  sessionId?: string;
  eventTime?: ISODateString;
  importance?: number;
  confidence?: number;
  supersedes?: string[];
}

export type RawDocumentKind = "cli" | "file" | "url" | "message" | "import" | "manual";

export interface RawDocument extends MemoryMetadata {
  id: string;
  path: string;
  targetScope?: RawTargetScope;
  kind: RawDocumentKind;
  label: string;
  uri?: string;
  contentHash: string;
  createdAt: ISODateString;
  text: string;
}

export interface WikiPage extends MemoryMetadata {
  id: string;
  path: string;
  title: string;
  type: string;
  canonical?: string;
  summary: string;
  tags: string[];
  aliases: string[];
  hints: string[];
  entrypoints: string[];
  links: string[];
  sourceIds: string[];
  reviewStatus?: ReviewStatus;
  wikiTargetTitle?: string;
  wikiTargetPath?: string;
  approvedAt?: ISODateString;
  body: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface WikiSchema {
  pageTypes: string;
  styleGuide: string;
  lintRules: string;
}

export interface WikiPageDraft {
  path?: string;
  title: string;
  type?: string;
  canonical?: string;
  summary?: string;
  tags?: string[];
  aliases?: string[];
  hints?: string[];
  entrypoints?: string[];
  links?: string[];
  sourceIds?: string[];
  reviewStatus?: ReviewStatus;
  wikiTargetTitle?: string;
  wikiTargetPath?: string;
  approvedAt?: ISODateString;
  memoryClass?: MemoryClass;
  memoryStage?: MemoryStage;
  sessionId?: string;
  eventTime?: ISODateString;
  importance?: number;
  confidence?: number;
  supersedes?: string[];
  body: string;
}

export interface WikiUpdatePlan {
  pages: WikiPageDraft[];
  merge?: Array<{ fromTitle: string; toTitle: string; reason?: string }>;
  notes?: string[];
}

export interface WikiSearchResult {
  page: WikiPage;
  score: number;
  snippet: string;
  sources: RawDocument[];
}

export interface WikiQueryResult {
  query: string;
  answer: string;
  pages: Array<{
    id: string;
    path: string;
    title: string;
    summary: string;
    snippet: string;
    score: number;
  }>;
  sources: Array<{
    id: string;
    path: string;
    label: string;
    kind: RawDocumentKind;
    uri?: string;
  }>;
}

export interface WikiLintIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  pageId?: string;
  sourceId?: string;
  path?: string;
}

export interface WikiStatus {
  vaultPath: string;
  databasePath: string;
  counts: {
    rawDocuments: number;
    wikiPages: number;
    memoryPages: number;
    longMemoryPages: number;
    wikiUpdateCandidates: number;
    links: number;
    sourceRefs: number;
  };
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
    traceDir?: string;
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
  targetScope?: RawTargetScope;
  source?: {
    kind?: RawDocumentKind;
    label?: string;
    uri?: string;
  };
  memory?: {
    class?: MemoryClass;
    stage?: MemoryStage;
    sessionId?: string;
    eventTime?: ISODateString;
    importance?: number;
    confidence?: number;
    supersedes?: string[];
  };
  deferConsolidation?: boolean;
  onProgress?: (event: WikiProgressEvent) => void | Promise<void>;
}

export interface IngestResult {
  raw: RawDocument;
  pages: WikiPage[];
  plan: WikiUpdatePlan;
}

export interface ConsolidateResult {
  sessionSummary?: WikiPage;
  candidates: WikiPage[];
  longMemories: WikiPage[];
  wikiPages: WikiPage[];
  wikiUpdateCandidates: WikiPage[];
  pendingRawDocuments: RawDocument[];
}

export interface ApplyWikiUpdateResult {
  candidate: WikiPage;
  page: WikiPage;
}

export interface RejectWikiUpdateResult {
  candidate: WikiPage;
}

export interface QueryInput {
  text: string;
  limit?: number;
  synthesize?: boolean;
  onProgress?: (event: WikiProgressEvent) => void | Promise<void>;
}

export interface WikiProgressEvent {
  stage: string;
  durationMs: number;
  totalMs: number;
  details?: Record<string, unknown>;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

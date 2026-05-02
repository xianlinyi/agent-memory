export type ISODateString = string;

export type RawDocumentKind = "cli" | "file" | "url" | "message" | "import" | "manual";

export interface RawDocument {
  id: string;
  path: string;
  kind: RawDocumentKind;
  label: string;
  uri?: string;
  contentHash: string;
  createdAt: ISODateString;
  text: string;
}

export interface WikiPage {
  id: string;
  path: string;
  title: string;
  type: string;
  summary: string;
  tags: string[];
  aliases: string[];
  links: string[];
  sourceIds: string[];
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
  title: string;
  type?: string;
  summary?: string;
  tags?: string[];
  aliases?: string[];
  links?: string[];
  sourceIds?: string[];
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
  source?: {
    kind?: RawDocumentKind;
    label?: string;
    uri?: string;
  };
  onProgress?: (event: WikiProgressEvent) => void | Promise<void>;
}

export interface IngestResult {
  raw: RawDocument;
  pages: WikiPage[];
  plan: WikiUpdatePlan;
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

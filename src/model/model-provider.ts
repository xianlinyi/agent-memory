import type { RawDocument, WikiLintIssue, WikiPage, WikiSchema, WikiSearchResult, WikiUpdatePlan } from "../types.js";

export interface ModelProvider {
  planWikiUpdates(input: {
    raw: RawDocument;
    existingPages: WikiPage[];
    schema: WikiSchema;
  }): Promise<WikiUpdatePlan>;
  synthesizeWikiAnswer(input: {
    query: string;
    results: WikiSearchResult[];
    schema: WikiSchema;
  }): Promise<string>;
  lintWiki?(input: {
    pages: WikiPage[];
    rawDocuments: RawDocument[];
    schema: WikiSchema;
  }): Promise<WikiLintIssue[]>;
  doctor?(input?: { modelCall?: boolean }): Promise<{ ok: boolean; message: string }>;
  close?(): Promise<void>;
}

export type IngestModelSession = never;

import { access, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { applyAutomaticCopilotIsolation, defaultConfig, loadConfig, writeConfig } from "../config.js";
import { createModelProvider } from "../model/model-factory.js";
import type { ModelProvider } from "../model/model-provider.js";
import { WikiIndexStore } from "../store/wiki-index-store.js";
import type { ApplyWikiUpdateResult, ConsolidateResult, DoctorCheck, IngestInput, IngestResult, MemoryClass, QueryInput, RawDocument, RawTargetScope, RejectWikiUpdateResult, ReviewStatus, WikiLintIssue, WikiPage, WikiPageDraft, WikiProgressEvent, WikiQueryResult, WikiSearchResult, WikiStatus } from "../types.js";
import { importNodeSqlite } from "../utils/node-sqlite.js";
import { nowIso } from "../utils/time.js";
import { LlmWikiVaultStore, type VaultStore } from "../vault/vault-store.js";

const DEFAULT_QUERY_LIMIT = 5;

export interface MemoryEngineOptions {
  vaultPath: string;
  config?: Awaited<ReturnType<typeof loadConfig>>;
  modelProvider?: ModelProvider;
  vaultStore?: VaultStore;
  indexStore?: WikiIndexStore;
}

export class MemoryEngine {
  private constructor(
    readonly config: Awaited<ReturnType<typeof loadConfig>>,
    private readonly modelProvider: ModelProvider,
    private readonly vaultStore: VaultStore,
    private readonly indexStore: WikiIndexStore
  ) {}

  static async create(options: MemoryEngineOptions): Promise<MemoryEngine> {
    const loadedConfig = options.config ?? (await loadConfig(options.vaultPath));
    const config = options.modelProvider ? loadedConfig : await applyAutomaticCopilotIsolation(loadedConfig);
    const modelProvider = options.modelProvider ?? createModelProvider(config);
    const vaultStore = options.vaultStore ?? new LlmWikiVaultStore(config.vaultPath);
    const indexStore = options.indexStore ?? new WikiIndexStore({ databasePath: config.databasePath, vaultPath: config.vaultPath });
    return new MemoryEngine(config, modelProvider, vaultStore, indexStore);
  }

  async init(): Promise<void> {
    await this.vaultStore.init();
    await writeConfig(this.config);
    await this.indexStore.init();
    await this.reindex();
  }

  async close(): Promise<void> {
    await this.modelProvider.close?.();
    await this.indexStore.close();
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const trace = createTracer(input.onProgress);
    await this.ensureReady();
    await trace("ensureReady");
    const timestamp = nowIso();
    const shouldDefer = input.deferConsolidation !== false;
    const targetScope = input.targetScope ?? (shouldDefer ? "memory" : "wiki");
    const deferredMemoryClass = shouldDefer ? input.memory?.class ?? inferDeferredMemoryClass(input.text, input.source?.kind) : input.memory?.class;
    const raw = await this.vaultStore.writeRawDocument({
      text: input.text,
      kind: input.source?.kind ?? "cli",
      label: input.source?.label ?? input.source?.uri ?? "CLI input",
      uri: input.source?.uri,
      createdAt: timestamp,
      targetScope,
      memoryClass: deferredMemoryClass,
      memoryStage: "raw",
      sessionId: input.memory?.sessionId,
      eventTime: input.memory?.eventTime,
      importance: input.memory?.importance,
      confidence: input.memory?.confidence,
      supersedes: input.memory?.supersedes
    });
    await trace("raw.write", { rawId: raw.id, path: raw.path });

    if (shouldDefer) {
      await trace("memory.defer", { rawId: raw.id, memoryClass: raw.memoryClass, sessionId: raw.sessionId });
      return {
        raw,
        pages: [],
        plan: {
          pages: [],
          notes: ["deferred_for_manual_consolidation"]
        }
      };
    }

    const schema = await this.vaultStore.readSchema();
    const existingPages = await this.vaultStore.readWikiPages();
    const relevantPages = selectRelevantPages(input.text, existingPages, 12);
    const plan = await this.modelProvider.planWikiUpdates({ raw, existingPages: relevantPages, schema });
    await trace("model.planWikiUpdates", { pages: plan.pages.length });

    const pages: WikiPage[] = [];
    for (const draft of plan.pages.length > 0 ? plan.pages : [fallbackDraft(raw)]) {
      pages.push(await this.vaultStore.writeWikiPage(draft, timestamp));
    }
    await trace("wiki.write", { pages: pages.map((page) => page.path) });
    await this.reindex();
    await trace("index.rebuild");
    return { raw, pages, plan };
  }

  async consolidate(options?: { sessionId?: string; onProgress?: (event: WikiProgressEvent) => void | Promise<void> }): Promise<ConsolidateResult> {
    const trace = createTracer(options?.onProgress);
    await this.ensureReady(false);
    await trace("ensureReady");
    const [rawDocuments, memoryPages, wikiPages, schema] = await Promise.all([
      this.vaultStore.readRawDocuments(),
      this.vaultStore.readMemoryPages(),
      this.vaultStore.readWikiPages(),
      this.vaultStore.readSchema()
    ]);
    const pendingRawDocuments = selectPendingRawDocuments(rawDocuments, memoryPages, wikiPages, options?.sessionId);
    await trace("memory.pending", { matches: pendingRawDocuments.length, sessionId: options?.sessionId });
    if (pendingRawDocuments.length === 0) {
      return { candidates: [], longMemories: [], wikiPages: [], wikiUpdateCandidates: [], pendingRawDocuments: [] };
    }

    const timestamp = nowIso();
    const sessionSummary = await this.vaultStore.writeMemoryPage(buildSessionSummaryDraft(pendingRawDocuments, timestamp, options?.sessionId), timestamp);
    await trace("memory.sessionSummary", { path: sessionSummary.path, sources: sessionSummary.sourceIds.length });

    const candidates: WikiPage[] = [];
    const longMemories: WikiPage[] = [];
    const consolidatedWikiPages: WikiPage[] = [];
    const existingLongMemories = memoryPages.filter((page) => page.memoryStage === "long_term");
    const currentWikiPages = [...wikiPages];
    for (const raw of pendingRawDocuments) {
      const normalizedRaw = normalizeRawDocument(raw);
      const targetScope = rawTargetScope(normalizedRaw);
      if (targetScope === "memory") {
        const candidate = await this.vaultStore.writeMemoryPage(buildCandidateDraft(normalizedRaw), timestamp);
        candidates.push(candidate);

        const relevantPages = selectPlanningPages(normalizedRaw, existingLongMemories);
        const plan = await this.modelProvider.planWikiUpdates({ raw: normalizedRaw, existingPages: relevantPages, schema });
        await trace("model.planWikiUpdates", { rawId: normalizedRaw.id, targetScope, pages: plan.pages.length });

        for (const draft of plan.pages.length > 0 ? plan.pages : [fallbackDraft(normalizedRaw)]) {
          const existingMemoryPage = findExistingEntityPage(existingLongMemories, draft);
          const longMemory = await this.vaultStore.writeMemoryPage(buildLongMemoryEntityDraft(normalizedRaw, draft, existingMemoryPage), timestamp);
          longMemories.push(longMemory);
          upsertPage(existingLongMemories, longMemory);
        }
        continue;
      }

      const relevantPages = selectPlanningPages(normalizedRaw, currentWikiPages);
      const plan = await this.modelProvider.planWikiUpdates({ raw: normalizedRaw, existingPages: relevantPages, schema });
      await trace("model.planWikiUpdates", { rawId: normalizedRaw.id, targetScope, pages: plan.pages.length });

      for (const draft of plan.pages.length > 0 ? plan.pages : [fallbackDraft(normalizedRaw)]) {
        const existingWikiPage = findExistingEntityPage(currentWikiPages, draft);
        const wikiPage = await this.vaultStore.writeWikiPage(buildConsolidatedWikiDraft(normalizedRaw, draft, existingWikiPage), timestamp);
        consolidatedWikiPages.push(wikiPage);
        upsertPage(currentWikiPages, wikiPage);
      }
    }
    await trace("memory.candidates", { count: candidates.length, longMemories: longMemories.length, wikiPages: consolidatedWikiPages.length });
    await this.reindex();
    await trace("index.rebuild", { pages: candidates.length + longMemories.length + consolidatedWikiPages.length + (sessionSummary ? 1 : 0) });
    return { sessionSummary, candidates, longMemories, wikiPages: consolidatedWikiPages, wikiUpdateCandidates: [], pendingRawDocuments };
  }

  async query(input: QueryInput): Promise<WikiQueryResult> {
    const trace = createTracer(input.onProgress);
    await this.ensureReady();
    await trace("ensureReady");
    const limit = normalizeLimit(input.limit);
    const [wikiPages, memoryPages, rawDocuments, schema] = await Promise.all([
      this.vaultStore.readWikiPages(),
      this.vaultStore.readMemoryPages(),
      this.vaultStore.readRawDocuments(),
      this.vaultStore.readSchema()
    ]);
    const queryableMemory = queryableMemoryPages(memoryPages);
    const memorySearch = await searchPageGroup(this.indexStore, input.text, limit, queryableMemory, rawDocuments);
    const wikiSearch = await searchPageGroup(this.indexStore, input.text, limit, wikiPages, rawDocuments);
    const results = mergeSearchResults(limit, memorySearch.results, wikiSearch.results);
    await trace("index.search", {
      memoryMatches: memorySearch.results.length,
      wikiMatches: wikiSearch.results.length,
      exactMatches: memorySearch.exactResults.length + wikiSearch.exactResults.length,
      linkedMatches: memorySearch.linkedResults.length + wikiSearch.linkedResults.length,
      ftsMatches: memorySearch.searchResults.length + wikiSearch.searchResults.length,
      matches: results.length
    });
    const answer =
      input.synthesize === false
        ? ""
        : await this.modelProvider.synthesizeWikiAnswer({
            query: input.text,
            results,
            schema
          });
    await trace(input.synthesize === false ? "model.synthesizeAnswer.skipped" : "model.synthesizeAnswer", { answerChars: answer.length });
    return formatQueryResult(input.text, answer, results);
  }

  async reindex(): Promise<void> {
    await this.vaultStore.init();
    await this.indexStore.init();
    const [wikiPages, memoryPages, rawDocuments] = await Promise.all([this.vaultStore.readWikiPages(), this.vaultStore.readMemoryPages(), this.vaultStore.readRawDocuments()]);
    await this.indexStore.rebuild({
      pages: [...wikiPages, ...memoryPages],
      rawDocuments
    });
  }

  async lint(options?: { fix?: boolean }): Promise<WikiLintIssue[]> {
    await this.ensureReady();
    const [wikiPages, memoryPages, rawDocuments, schema] = await Promise.all([
      this.vaultStore.readWikiPages(),
      this.vaultStore.readMemoryPages(),
      this.vaultStore.readRawDocuments(),
      this.vaultStore.readSchema()
    ]);
    const pages = [...wikiPages, ...queryableMemoryPages(memoryPages)];
    const deterministic = deterministicLint(pages, rawDocuments);
    const modelIssues = this.modelProvider.lintWiki ? await this.modelProvider.lintWiki({ pages, rawDocuments, schema }) : [];
    if (options?.fix) {
      const timestamp = nowIso();
      for (const page of wikiPages) {
        if (page.sourceIds.length === 0) continue;
        const fixedBody = normalizeSourcesSection(page.body, page.sourceIds);
        if (fixedBody !== page.body) await this.vaultStore.writeWikiPage({ ...page, body: fixedBody }, timestamp);
      }
      await this.reindex();
    }
    return [...deterministic, ...modelIssues];
  }

  async pages(): Promise<WikiPage[]> {
    await this.ensureReady();
    return this.vaultStore.readWikiPages();
  }

  async longMemory(options?: { memoryClass?: MemoryClass }): Promise<WikiPage[]> {
    await this.ensureReady(false);
    const pages = await this.vaultStore.readLongMemoryPages();
    return options?.memoryClass ? pages.filter((page) => page.memoryClass === options.memoryClass) : pages;
  }

  async wikiUpdateCandidates(options?: { reviewStatus?: ReviewStatus }): Promise<WikiPage[]> {
    await this.ensureReady(false);
    return this.vaultStore.readWikiUpdateCandidates(options);
  }

  async applyWikiUpdate(candidateRef: string): Promise<ApplyWikiUpdateResult> {
    await this.ensureReady();
    const candidates = await this.vaultStore.readWikiUpdateCandidates({ reviewStatus: "pending" });
    const candidate = resolveWikiUpdateCandidate(candidates, candidateRef);
    if (!candidate) throw new Error(`Unknown pending wiki update candidate: ${candidateRef}`);

    const timestamp = nowIso();
    const page = await this.vaultStore.writeWikiPage(
      {
        path: candidate.wikiTargetPath,
        title: candidate.wikiTargetTitle ?? stripWikiUpdateTitle(candidate.title),
        type: approvedWikiType(candidate),
        canonical: candidate.canonical,
        summary: candidate.summary,
        tags: candidate.tags.filter((tag) => tag !== "memory" && tag !== "wiki-update"),
        aliases: candidate.aliases,
        hints: candidate.hints,
        entrypoints: candidate.entrypoints,
        links: candidate.links,
        sourceIds: candidate.sourceIds,
        memoryClass: candidate.memoryClass,
        memoryStage: "consolidated",
        body: candidate.body
      },
      timestamp
    );

    const approvedCandidate = await this.vaultStore.writeMemoryPage(
      {
        ...candidate,
        path: candidate.path,
        reviewStatus: "approved",
        approvedAt: timestamp,
        body: candidate.body
      },
      timestamp
    );

    await this.reindex();
    return { candidate: approvedCandidate, page };
  }

  async rejectWikiUpdate(candidateRef: string): Promise<RejectWikiUpdateResult> {
    await this.ensureReady(false);
    const candidates = await this.vaultStore.readWikiUpdateCandidates({ reviewStatus: "pending" });
    const candidate = resolveWikiUpdateCandidate(candidates, candidateRef);
    if (!candidate) throw new Error(`Unknown pending wiki update candidate: ${candidateRef}`);

    const timestamp = nowIso();
    const rejectedCandidate = await this.vaultStore.writeMemoryPage(
      {
        ...candidate,
        path: candidate.path,
        reviewStatus: "rejected",
        body: candidate.body
      },
      timestamp
    );

    return { candidate: rejectedCandidate };
  }

  async sources(): Promise<RawDocument[]> {
    await this.ensureReady();
    return this.vaultStore.readRawDocuments();
  }

  async status(): Promise<WikiStatus> {
    await this.ensureReady();
    return this.indexStore.status();
  }

  async doctor(options?: { modelCall?: boolean }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [
      { name: "node", ok: isSupportedNode(), message: `Node.js ${process.version}; required >=24.15.0.` }
    ];
    try {
      await importNodeSqlite();
      checks.push({ name: "node:sqlite", ok: true, message: "node:sqlite is importable." });
    } catch (error) {
      checks.push({ name: "node:sqlite", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    try {
      await this.init();
      const status = await this.status();
      checks.push({ name: "vault", ok: true, message: `LLM Wiki ready at ${status.vaultPath}.` });
      checks.push({ name: "index", ok: true, message: `Search index ready at ${status.databasePath}.` });
    } catch (error) {
      checks.push({ name: "vault/index", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    checks.push({ name: "model", ...(this.modelProvider.doctor ? await this.modelProvider.doctor({ modelCall: options?.modelCall }) : { ok: true, message: "No model doctor check defined." }) });
    return checks;
  }

  private async ensureReady(initIndex = true): Promise<void> {
    await this.vaultStore.init();
    if (initIndex) await this.indexStore.init();
  }
}

export async function createDefaultEngine(vaultPath: string): Promise<MemoryEngine> {
  const config = defaultConfig(vaultPath);
  return MemoryEngine.create({ vaultPath, config });
}

export async function textOrFile(input: string): Promise<{ text: string; label: string; uri?: string }> {
  const path = resolve(input);
  try {
    await access(path);
    return { text: await readFile(path, "utf8"), label: basename(path), uri: path };
  } catch {
    return { text: input, label: "CLI input" };
  }
}

function formatQueryResult(query: string, answer: string, results: WikiSearchResult[]): WikiQueryResult {
  const sourceById = new Map<string, RawDocument>();
  for (const result of results) {
    for (const source of result.sources) sourceById.set(source.id, source);
  }
  return {
    query,
    answer,
    pages: results.map((result) => ({
      id: result.page.id,
      path: result.page.path,
      title: result.page.title,
      summary: result.page.summary,
      snippet: result.snippet,
      score: result.score
    })),
    sources: [...sourceById.values()].map((source) => ({
      id: source.id,
      path: source.path,
      label: source.label,
      kind: source.kind,
      uri: source.uri
    }))
  };
}

function deterministicLint(pages: WikiPage[], rawDocuments: RawDocument[]): WikiLintIssue[] {
  const issues: WikiLintIssue[] = [];
  const titles = new Map<string, WikiPage[]>();
  const titleOrAlias = new Set<string>();
  const referencedSources = new Set<string>();
  for (const page of pages) {
    const key = canonical(page.title);
    titles.set(key, [...(titles.get(key) ?? []), page]);
    titleOrAlias.add(key);
    for (const alias of page.aliases) titleOrAlias.add(canonical(alias));
    for (const sourceId of page.sourceIds) referencedSources.add(sourceId);
    if (page.sourceIds.length === 0) issues.push({ severity: "error", code: "missing_source", message: `${page.title} has no raw source references.`, pageId: page.id, path: page.path });
    if (!/^##\s+Sources\s*$/im.test(page.body)) issues.push({ severity: "error", code: "missing_sources_section", message: `${page.title} is missing a Sources section.`, pageId: page.id, path: page.path });
    if (page.body.length > 20000) issues.push({ severity: "warning", code: "page_too_long", message: `${page.title} is longer than 20k characters.`, pageId: page.id, path: page.path });
  }
  for (const sameTitlePages of titles.values()) {
    if (sameTitlePages.length > 1) {
      for (const page of sameTitlePages) issues.push({ severity: "error", code: "duplicate_title", message: `Duplicate wiki title: ${page.title}.`, pageId: page.id, path: page.path });
    }
  }
  for (const page of pages) {
    for (const link of page.links) {
      if (!titleOrAlias.has(canonical(link))) issues.push({ severity: "warning", code: "broken_wikilink", message: `${page.title} links to missing page [[${link}]].`, pageId: page.id, path: page.path });
    }
  }
  for (const raw of rawDocuments) {
    if (!referencedSources.has(raw.id)) issues.push({ severity: "info", code: "unreferenced_raw", message: `${raw.path} is not cited by any wiki page.`, sourceId: raw.id, path: raw.path });
  }
  return issues;
}

function normalizeSourcesSection(body: string, sourceIds: string[]): string {
  const normalized = ["## Sources", ...sourceIds.map((id) => `- ${id}`)].join("\n");
  if (/^##\s+Sources\s*$/im.test(body)) return body.replace(/^##\s+Sources\s*$[\s\S]*$/im, `${normalized}\n`);
  return [body.trim(), "", normalized, ""].join("\n");
}

function fallbackDraft(raw: RawDocument) {
  const title = raw.label === "CLI input" ? firstWords(raw.text, 6) || "Untitled Knowledge" : raw.label;
  return {
    title,
    type: "concept",
    summary: firstWords(raw.text, 24),
    tags: [],
    aliases: [],
    links: [],
    sourceIds: [raw.id],
    body: [`# ${title}`, "", raw.text, "", "## Sources", `- ${raw.id}`].join("\n")
  };
}

function selectRelevantPages(text: string, pages: WikiPage[], limit: number): WikiPage[] {
  const terms = new Set(text.toLowerCase().split(/\s+/).filter((term) => term.length > 2));
  return pages
    .map((page) => {
      const haystack = [page.title, page.summary, page.body, page.canonical ?? "", page.tags.join(" "), page.aliases.join(" "), page.hints.join(" "), page.entrypoints.join(" ")].join(" ").toLowerCase();
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      return { page, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.page);
}

function createTracer(onProgress: QueryInput["onProgress"]): (stage: string, details?: Record<string, unknown>) => Promise<void> {
  const started = Date.now();
  let previous = started;
  return async (stage: string, details?: Record<string, unknown>) => {
    const now = Date.now();
    const event: WikiProgressEvent = { stage, durationMs: now - previous, totalMs: now - started, details };
    previous = now;
    await onProgress?.(event);
  };
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_QUERY_LIMIT;
  return Math.max(1, Math.min(25, Math.trunc(value)));
}

function canonical(value: string): string {
  return value.trim().toLowerCase();
}

function selectPendingRawDocuments(rawDocuments: RawDocument[], memoryPages: WikiPage[], wikiPages: WikiPage[], sessionId?: string): RawDocument[] {
  const durableMemoryRawIds = new Set(memoryPages.filter((page) => page.memoryStage === "long_term").flatMap((page) => page.sourceIds));
  const durableWikiRawIds = new Set(wikiPages.flatMap((page) => page.sourceIds));
  return rawDocuments.filter((raw) => {
    if (sessionId && raw.sessionId !== sessionId) return false;
    const targetScope = rawTargetScope(raw);
    if (targetScope === "wiki" && durableWikiRawIds.has(raw.id)) return false;
    if (targetScope === "memory" && durableMemoryRawIds.has(raw.id)) return false;
    return raw.memoryStage === "raw";
  });
}

async function searchPageGroup(
  indexStore: WikiIndexStore,
  query: string,
  limit: number,
  pages: WikiPage[],
  rawDocuments: RawDocument[]
): Promise<{
  exactResults: WikiSearchResult[];
  linkedResults: WikiSearchResult[];
  searchResults: WikiSearchResult[];
  results: WikiSearchResult[];
}> {
  if (pages.length === 0) {
    return {
      exactResults: [],
      linkedResults: [],
      searchResults: [],
      results: []
    };
  }

  const exactResults = await indexStore.lookupTerms(query, limit, pages, rawDocuments);
  const linkedResults = expandLinkedResults(exactResults, pages, rawDocuments, limit);
  const searchResults = await indexStore.search(query, limit, pages, rawDocuments);
  return {
    exactResults,
    linkedResults,
    searchResults,
    results: mergeSearchResults(limit, exactResults, linkedResults, searchResults)
  };
}

function buildSessionSummaryDraft(rawDocuments: RawDocument[], timestamp: string, sessionId?: string): WikiPageDraft {
  const title = sessionId ? `Session ${sessionId} Summary` : `Session Summary ${timestamp.slice(0, 19)}`;
  return {
    path: sessionId ? `memory/session-summaries/${slugifySegment(sessionId)}.md` : undefined,
    title,
    type: "session-summary",
    summary: `Summary of ${rawDocuments.length} raw memory event${rawDocuments.length === 1 ? "" : "s"} pending consolidation.`,
    tags: ["memory", "session-summary"],
    aliases: [],
    hints: ["session consolidation"],
    entrypoints: [],
    links: [],
    sourceIds: rawDocuments.map((raw) => raw.id),
    memoryStage: "session_summary",
    sessionId,
    eventTime: rawDocuments[rawDocuments.length - 1]?.eventTime ?? rawDocuments[rawDocuments.length - 1]?.createdAt,
    confidence: 0.6,
    body: [
      `# ${title}`,
      "",
      `This summary compresses ${rawDocuments.length} raw memory item${rawDocuments.length === 1 ? "" : "s"} before durable consolidation.`,
      "",
      "## Events",
      ...rawDocuments.map((raw) => `- ${raw.eventTime ?? raw.createdAt}: ${raw.label} [${raw.memoryClass ?? "unspecified"}]`),
      "",
      "## Notes",
      ...rawDocuments.map((raw) => `- ${firstWords(raw.text, 24)}`),
      "",
      "## Sources",
      ...rawDocuments.map((raw) => `- ${raw.id}`)
    ].join("\n")
  };
}

function buildCandidateDraft(raw: RawDocument): WikiPageDraft {
  const memoryClass = resolveRawMemoryClass(raw);
  const title = candidateTitle(raw);
  return {
    path: `memory/candidates/${slugifySegment(raw.label || raw.id)}-${raw.id.slice(4, 12)}.md`,
    title,
    type: "memory-candidate",
    summary: `Candidate ${memoryClass} memory extracted from ${raw.label}.`,
    tags: ["memory", "candidate", memoryClass],
    aliases: [],
    hints: [raw.kind, memoryClass],
    entrypoints: [],
    links: [],
    sourceIds: [raw.id],
    memoryClass,
    memoryStage: "candidate",
    sessionId: raw.sessionId,
    eventTime: raw.eventTime ?? raw.createdAt,
    importance: raw.importance,
    confidence: raw.confidence ?? 0.5,
    supersedes: raw.supersedes,
    body: [
      `# ${title}`,
      "",
      `Memory class: ${memoryClass}`,
      "",
      raw.text,
      "",
      "## Sources",
      `- ${raw.id}`
    ].join("\n")
  };
}

function buildLongMemoryDraft(raw: RawDocument): WikiPageDraft {
  const memoryClass = resolveRawMemoryClass(raw);
  const title = durableMemoryTitle(raw);
  return {
    path: `memory/long/${longMemoryFolder(memoryClass)}/${slugifySegment(title)}-${raw.id.slice(4, 12)}.md`,
    title,
    type: `${memoryClass}-memory`,
    summary: firstWords(raw.text, 24),
    tags: ["memory", "long", memoryClass],
    aliases: [],
    hints: [raw.kind],
    entrypoints: [],
    links: [],
    sourceIds: [raw.id],
    memoryClass,
    memoryStage: "long_term",
    sessionId: raw.sessionId,
    eventTime: raw.eventTime ?? raw.createdAt,
    importance: raw.importance,
    confidence: raw.confidence ?? 0.7,
    supersedes: raw.supersedes,
    body: [
      `# ${title}`,
      "",
      raw.text,
      "",
      "## Sources",
      `- ${raw.id}`
    ].join("\n")
  };
}

function buildLongMemoryEntityDraft(raw: RawDocument, draft: WikiPageDraft, existingMemoryPage?: WikiPage): WikiPageDraft {
  const memoryClass = resolveRawMemoryClass(raw);
  const title = existingMemoryPage?.title ?? draft.title.trim();
  return {
    path: existingMemoryPage?.path ?? joinLongMemoryPath(title, memoryClass),
    title,
    type: draft.type?.trim() || existingMemoryPage?.type || deriveWikiPageType(memoryClass),
    canonical: draft.canonical?.trim() || existingMemoryPage?.canonical,
    summary: draft.summary?.trim() || existingMemoryPage?.summary || firstWords(raw.text, 24),
    tags: uniqueStrings(["memory", "long", memoryClass, ...(existingMemoryPage?.tags ?? []), ...(draft.tags ?? [])]),
    aliases: uniqueStrings([...(existingMemoryPage?.aliases ?? []), ...(draft.aliases ?? [])]),
    hints: uniqueStrings([...(existingMemoryPage?.hints ?? []), ...(draft.hints ?? [])]),
    entrypoints: uniqueStrings([...(existingMemoryPage?.entrypoints ?? []), ...(draft.entrypoints ?? [])]),
    links: uniqueStrings([...(existingMemoryPage?.links ?? []), ...(draft.links ?? [])]),
    sourceIds: uniqueStrings([...(existingMemoryPage?.sourceIds ?? []), ...(draft.sourceIds ?? []), raw.id]),
    memoryClass,
    memoryStage: "long_term",
    sessionId: raw.sessionId,
    eventTime: raw.eventTime ?? raw.createdAt,
    importance: raw.importance,
    confidence: raw.confidence ?? existingMemoryPage?.confidence ?? 0.7,
    supersedes: uniqueStrings([...(existingMemoryPage?.supersedes ?? []), ...(raw.supersedes ?? [])]),
    body: draft.body
  };
}

function buildConsolidatedWikiDraft(raw: RawDocument, draft: WikiPageDraft, existingWikiPage?: WikiPage): WikiPageDraft {
  const memoryClass = resolveRawMemoryClass(raw);
  const title = existingWikiPage?.title ?? draft.title.trim();
  return {
    path: existingWikiPage?.path ?? buildWikiTargetPathForTitle(title, memoryClass),
    title,
    type: draft.type?.trim() || existingWikiPage?.type || deriveWikiPageType(memoryClass),
    canonical: draft.canonical?.trim() || existingWikiPage?.canonical,
    summary: draft.summary?.trim() || existingWikiPage?.summary || firstWords(raw.text, 24),
    tags: uniqueStrings([...(existingWikiPage?.tags ?? []), ...(draft.tags ?? [])]),
    aliases: uniqueStrings([...(existingWikiPage?.aliases ?? []), ...(draft.aliases ?? [])]),
    hints: uniqueStrings([...(existingWikiPage?.hints ?? []), ...(draft.hints ?? [])]),
    entrypoints: uniqueStrings([...(existingWikiPage?.entrypoints ?? []), ...(draft.entrypoints ?? [])]),
    links: uniqueStrings([...(existingWikiPage?.links ?? []), ...(draft.links ?? [])]),
    sourceIds: uniqueStrings([...(existingWikiPage?.sourceIds ?? []), ...(draft.sourceIds ?? []), raw.id]),
    memoryClass,
    memoryStage: "consolidated",
    sessionId: raw.sessionId,
    eventTime: raw.eventTime ?? raw.createdAt,
    importance: raw.importance,
    confidence: raw.confidence ?? existingWikiPage?.confidence ?? 0.7,
    supersedes: uniqueStrings([...(existingWikiPage?.supersedes ?? []), ...(raw.supersedes ?? [])]),
    body: draft.body
  };
}

function buildWikiUpdateCandidateDraft(raw: RawDocument, draft: WikiPageDraft, existingWikiPage?: WikiPage): WikiPageDraft {
  const memoryClass = resolveRawMemoryClass(raw);
  const targetTitle = existingWikiPage?.title ?? draft.title.trim();
  const sourceIds = uniqueStrings([...(draft.sourceIds ?? []), raw.id]);
  const targetPath = existingWikiPage?.path ?? buildWikiTargetPathForTitle(targetTitle, memoryClass);
  return {
    path: `memory/wiki-update-candidates/${slugifySegment(targetTitle)}.md`,
    title: `Update ${targetTitle}`,
    type: draft.type?.trim() || deriveWikiPageType(memoryClass),
    canonical: draft.canonical?.trim() || existingWikiPage?.canonical,
    summary: draft.summary?.trim() || (existingWikiPage ? `Proposed update to ${targetTitle}.` : `Proposed new wiki page for ${targetTitle}.`),
    tags: uniqueStrings([...(draft.tags ?? []), "memory", "wiki-update", memoryClass]),
    aliases: uniqueStrings([...(existingWikiPage?.aliases ?? []), ...(draft.aliases ?? [])]),
    hints: [existingWikiPage ? "update existing wiki" : "create wiki page"],
    entrypoints: uniqueStrings([...(draft.entrypoints ?? []), ...(existingWikiPage?.entrypoints ?? [])]),
    links: draft.links ?? [],
    sourceIds,
    reviewStatus: "pending",
    wikiTargetTitle: targetTitle,
    wikiTargetPath: targetPath,
    memoryClass,
    memoryStage: "wiki_update_candidate",
    sessionId: raw.sessionId,
    eventTime: raw.eventTime ?? raw.createdAt,
    importance: raw.importance,
    confidence: raw.confidence ?? 0.7,
    supersedes: raw.supersedes,
    body: draft.body
  };
}

function queryableMemoryPages(memoryPages: WikiPage[]): WikiPage[] {
  const longMemoryKeys = new Set(memoryPages.filter((page) => page.memoryStage === "long_term").map(memoryPageKey));
  return memoryPages.filter((page) => {
    if (page.memoryStage === "session_summary" || page.memoryStage === "wiki_update_candidate") return false;
    if (page.memoryStage === "candidate" && longMemoryKeys.has(memoryPageKey(page))) return false;
    return true;
  });
}

function memoryPageKey(page: WikiPage): string {
  return `${page.memoryClass ?? "unknown"}:${[...page.sourceIds].sort().join(",")}`;
}

function candidateTitle(raw: RawDocument): string {
  const label = raw.label.trim();
  if (!label || label === "CLI input") return firstWords(raw.text, 6) || `Candidate ${raw.id.slice(4, 12)}`;
  return `Candidate ${label} ${raw.id.slice(4, 12)}`;
}

function durableMemoryTitle(raw: RawDocument): string {
  const label = raw.label.trim();
  if (!label || label === "CLI input") return firstWords(raw.text, 6) || `Memory ${raw.id.slice(4, 12)}`;
  return label;
}

function longMemoryFolder(memoryClass?: MemoryClass): string {
  if (memoryClass === "episodic") return "episodic";
  if (memoryClass === "procedural") return "procedural";
  return "semantic";
}

function buildWikiTargetPath(longMemory: WikiPage): string {
  return buildWikiTargetPathForTitle(longMemory.title, longMemory.memoryClass);
}

function buildWikiTargetPathForTitle(targetTitle: string, memoryClass?: MemoryClass): string {
  return `wiki/${wikiFolder(memoryClass)}/${slugifySegment(targetTitle)}.md`;
}

function findExistingEntityPage(pages: WikiPage[], draft: WikiPageDraft): WikiPage | undefined {
  const title = canonical(draft.title);
  const draftAliases = new Set((draft.aliases ?? []).map(canonical));
  const canonicalTitle = draft.canonical ? canonical(draft.canonical) : undefined;

  return pages.find((page) => {
    const pageTitle = canonical(page.title);
    const pageAliases = new Set(page.aliases.map(canonical));
    if (pageTitle === title || pageAliases.has(title)) return true;
    if (canonicalTitle && (pageTitle === canonicalTitle || pageAliases.has(canonicalTitle))) return true;
    if (draftAliases.has(pageTitle)) return true;
    return [...pageAliases].some((alias) => draftAliases.has(alias));
  });
}

function selectPlanningPages(raw: RawDocument, pages: WikiPage[]): WikiPage[] {
  const label = canonical(raw.label);
  const exactMatches = pages.filter((page) => canonical(page.title) === label || page.aliases.some((alias) => canonical(alias) === label));
  const relevant = selectRelevantPages(`${raw.label}\n${raw.text}`, pages, 20);
  return uniquePages([...exactMatches, ...relevant]);
}

function normalizeRawDocument(raw: RawDocument): RawDocument {
  const memoryClass = resolveRawMemoryClass(raw);
  return raw.memoryClass === memoryClass ? raw : { ...raw, memoryClass };
}

function rawTargetScope(raw: RawDocument): RawTargetScope {
  return raw.targetScope ?? "memory";
}

function resolveRawMemoryClass(raw: RawDocument): MemoryClass {
  return raw.memoryClass ?? inferDeferredMemoryClass(raw.text, raw.kind);
}

function deriveWikiPageType(memoryClass?: MemoryClass): string {
  if (memoryClass === "episodic") return "episode";
  if (memoryClass === "procedural") return "procedure";
  return "concept";
}

function approvedWikiType(candidate: WikiPage): string {
  return candidate.type && candidate.type !== "wiki-update-candidate" ? candidate.type : deriveWikiPageType(candidate.memoryClass);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniquePages(pages: WikiPage[]): WikiPage[] {
  const seen = new Set<string>();
  const unique: WikiPage[] = [];
  for (const page of pages) {
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    unique.push(page);
  }
  return unique;
}

function upsertPage(pages: WikiPage[], page: WikiPage): void {
  const index = pages.findIndex((entry) => entry.id === page.id || entry.path === page.path);
  if (index >= 0) {
    pages[index] = page;
    return;
  }
  pages.push(page);
}

function wikiFolder(memoryClass?: MemoryClass): string {
  if (memoryClass === "episodic") return "episodes";
  if (memoryClass === "procedural") return "procedures";
  return "semantic";
}

function joinLongMemoryPath(title: string, memoryClass?: MemoryClass): string {
  return `memory/long/${longMemoryFolder(memoryClass)}/${slugifySegment(title)}.md`;
}

function resolveWikiUpdateCandidate(candidates: WikiPage[], candidateRef: string): WikiPage | undefined {
  const normalized = candidateRef.trim().toLowerCase();
  return candidates.find(
    (candidate) =>
      candidate.id.toLowerCase() === normalized ||
      candidate.path.toLowerCase() === normalized ||
      candidate.title.toLowerCase() === normalized ||
      (candidate.wikiTargetPath?.toLowerCase() === normalized)
  );
}

function stripWikiUpdateTitle(title: string): string {
  return title.startsWith("Update ") ? title.slice(7).trim() : title;
}

function inferDeferredMemoryClass(text: string, kind?: RawDocument["kind"]): MemoryClass {
  const lower = text.toLowerCase();
  if (kind === "message" || /yesterday|incident|failed|failure|timeout|error|debug|issue|昨天|故障|失败|超时/.test(lower)) return "episodic";
  if (/how to|runbook|playbook|steps|first check|先查|排查|步骤|处理/.test(lower)) return "procedural";
  return "semantic";
}

function slugifySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "memory";
}

function mergeSearchResults(limit: number, ...groups: WikiSearchResult[][]): WikiSearchResult[] {
  const merged: WikiSearchResult[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const result of group) {
      if (seen.has(result.page.id)) continue;
      seen.add(result.page.id);
      merged.push(result);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

function expandLinkedResults(seedResults: WikiSearchResult[], pages: WikiPage[], rawDocuments: RawDocument[], limit: number): WikiSearchResult[] {
  if (seedResults.length === 0) return [];
  const pageByTitleOrAlias = new Map<string, WikiPage>();
  for (const page of pages) {
    pageByTitleOrAlias.set(canonical(page.title), page);
    for (const alias of page.aliases) pageByTitleOrAlias.set(canonical(alias), page);
  }
  const rawById = new Map(rawDocuments.map((raw) => [raw.id, raw]));
  const results: WikiSearchResult[] = [];
  const seen = new Set<string>(seedResults.map((result) => result.page.id));
  for (const seed of seedResults) {
    for (const link of seed.page.links) {
      const page = pageByTitleOrAlias.get(canonical(link));
      if (!page || seen.has(page.id)) continue;
      seen.add(page.id);
      results.push({
        page,
        score: Math.max(1, Math.floor(seed.score / 2)),
        snippet: page.summary,
        sources: page.sourceIds.map((id) => rawById.get(id)).filter((raw): raw is RawDocument => Boolean(raw))
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

function firstWords(text: string, count: number): string {
  return text.trim().split(/\s+/).slice(0, count).join(" ");
}

function isSupportedNode(): boolean {
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  return major > 22 || (major === 22 && minor >= 13);
}

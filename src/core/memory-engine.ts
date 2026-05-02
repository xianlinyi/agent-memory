import { access, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { applyAutomaticCopilotIsolation, defaultConfig, loadConfig, writeConfig } from "../config.js";
import { createModelProvider } from "../model/model-factory.js";
import type { ModelProvider } from "../model/model-provider.js";
import { WikiIndexStore } from "../store/wiki-index-store.js";
import type { DoctorCheck, IngestInput, IngestResult, QueryInput, RawDocument, WikiLintIssue, WikiPage, WikiProgressEvent, WikiQueryResult, WikiSearchResult, WikiStatus } from "../types.js";
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
    const raw = await this.vaultStore.writeRawDocument({
      text: input.text,
      kind: input.source?.kind ?? "cli",
      label: input.source?.label ?? input.source?.uri ?? "CLI input",
      uri: input.source?.uri,
      createdAt: timestamp
    });
    await trace("raw.write", { rawId: raw.id, path: raw.path });

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

  async query(input: QueryInput): Promise<WikiQueryResult> {
    const trace = createTracer(input.onProgress);
    await this.ensureReady();
    await trace("ensureReady");
    const limit = normalizeLimit(input.limit);
    const [pages, rawDocuments, schema] = await Promise.all([this.vaultStore.readWikiPages(), this.vaultStore.readRawDocuments(), this.vaultStore.readSchema()]);
    const results = await this.indexStore.search(input.text, limit, pages, rawDocuments);
    await trace("index.search", { matches: results.length });
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
    await this.indexStore.rebuild({
      pages: await this.vaultStore.readWikiPages(),
      rawDocuments: await this.vaultStore.readRawDocuments()
    });
  }

  async lint(options?: { fix?: boolean }): Promise<WikiLintIssue[]> {
    await this.ensureReady();
    const [pages, rawDocuments, schema] = await Promise.all([this.vaultStore.readWikiPages(), this.vaultStore.readRawDocuments(), this.vaultStore.readSchema()]);
    const deterministic = deterministicLint(pages, rawDocuments);
    const modelIssues = this.modelProvider.lintWiki ? await this.modelProvider.lintWiki({ pages, rawDocuments, schema }) : [];
    if (options?.fix) {
      const timestamp = nowIso();
      for (const page of pages) {
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
      { name: "node", ok: isSupportedNode(), message: `Node.js ${process.version}; required >=22.13.` }
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
      const haystack = [page.title, page.summary, page.body, page.tags.join(" "), page.aliases.join(" ")].join(" ").toLowerCase();
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

function firstWords(text: string, count: number): string {
  return text.trim().split(/\s+/).slice(0, count).join(" ");
}

function isSupportedNode(): boolean {
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  return major > 22 || (major === 22 && minor >= 13);
}

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, relative } from "node:path";
import type { MemoryClass, MemoryStage, RawDocument, RawTargetScope, WikiPage, WikiPageDraft, WikiSchema } from "../types.js";
import { parseMarkdownDocument, stringifyMarkdownDocument } from "../utils/frontmatter.js";
import { slugify, stableId } from "../utils/ids.js";
import { INTERNAL_DIR } from "../config.js";

const STARTER_SCHEMA: Array<{ path: string; body: string }> = [
  {
    path: join("schema", "page-types.md"),
    body: ["# Page Types", "", "- concept: durable explanations, terms, and practices", "- project: durable project knowledge", "- person: stable people knowledge", "- artifact: tools, files, APIs, documents, commands"].join("\n")
  },
  {
    path: join("schema", "style-guide.md"),
    body: ["# Style Guide", "", "- Prefer updating existing pages over creating duplicates.", "- Use clear titles and [[wikilinks]].", "- Every wiki page must include `## Sources`."].join("\n")
  },
  {
    path: join("schema", "lint-rules.md"),
    body: ["# Lint Rules", "", "- Pages must cite at least one raw source.", "- Wikilinks should point to existing page titles or aliases.", "- Avoid duplicate pages for the same topic."].join("\n")
  }
];

export interface VaultStore {
  init(): Promise<void>;
  writeRawDocument(input: {
    text: string;
    kind: RawDocument["kind"];
    label: string;
    uri?: string;
    createdAt: string;
    targetScope?: RawTargetScope;
    memoryClass?: RawDocument["memoryClass"];
    memoryStage?: RawDocument["memoryStage"];
    sessionId?: RawDocument["sessionId"];
    eventTime?: RawDocument["eventTime"];
    importance?: RawDocument["importance"];
    confidence?: RawDocument["confidence"];
    supersedes?: RawDocument["supersedes"];
  }): Promise<RawDocument>;
  writeWikiPage(draft: WikiPageDraft, timestamp: string): Promise<WikiPage>;
  writeMemoryPage(draft: WikiPageDraft, timestamp: string): Promise<WikiPage>;
  readRawDocuments(): Promise<RawDocument[]>;
  readWikiPages(): Promise<WikiPage[]>;
  readMemoryPages(): Promise<WikiPage[]>;
  readLongMemoryPages(): Promise<WikiPage[]>;
  readWikiUpdateCandidates(options?: { reviewStatus?: WikiPage["reviewStatus"] }): Promise<WikiPage[]>;
  readSchema(): Promise<WikiSchema>;
}

export class LlmWikiVaultStore implements VaultStore {
  constructor(readonly vaultPath: string) {}

  async init(): Promise<void> {
    await Promise.all([
      mkdir(join(this.vaultPath, "raw"), { recursive: true }),
      mkdir(join(this.vaultPath, "memory", "raw"), { recursive: true }),
      mkdir(join(this.vaultPath, "wiki"), { recursive: true }),
      mkdir(join(this.vaultPath, "wiki", "raw"), { recursive: true }),
      mkdir(join(this.vaultPath, "wiki", "episodes"), { recursive: true }),
      mkdir(join(this.vaultPath, "wiki", "semantic"), { recursive: true }),
      mkdir(join(this.vaultPath, "wiki", "procedures"), { recursive: true }),
      mkdir(join(this.vaultPath, "memory", "session-summaries"), { recursive: true }),
      mkdir(join(this.vaultPath, "memory", "candidates"), { recursive: true }),
      mkdir(join(this.vaultPath, "memory", "long", "episodic"), { recursive: true }),
      mkdir(join(this.vaultPath, "memory", "long", "semantic"), { recursive: true }),
      mkdir(join(this.vaultPath, "memory", "long", "procedural"), { recursive: true }),
      mkdir(join(this.vaultPath, "memory", "wiki-update-candidates"), { recursive: true }),
      mkdir(join(this.vaultPath, "schema"), { recursive: true }),
      mkdir(join(this.vaultPath, INTERNAL_DIR), { recursive: true })
    ]);
    await Promise.all(STARTER_SCHEMA.map((file) => this.writeStarterFile(file.path, file.body)));
  }

  async writeRawDocument(input: {
    text: string;
    kind: RawDocument["kind"];
    label: string;
    uri?: string;
    createdAt: string;
    targetScope?: RawTargetScope;
    memoryClass?: RawDocument["memoryClass"];
    memoryStage?: RawDocument["memoryStage"];
    sessionId?: RawDocument["sessionId"];
    eventTime?: RawDocument["eventTime"];
    importance?: RawDocument["importance"];
    confidence?: RawDocument["confidence"];
    supersedes?: RawDocument["supersedes"];
  }): Promise<RawDocument> {
    const hash = sha256(input.text);
    const id = stableId("raw", [input.targetScope ?? "legacy", input.label, input.uri ?? "", input.createdAt, hash]);
    const date = input.createdAt.slice(0, 10).split("-");
    const timestamp = input.createdAt.replace(/[:.]/g, "-");
    const path = join(rawRoot(input.targetScope), date[0] ?? "unknown", date[1] ?? "unknown", date[2] ?? "unknown", `${timestamp}-${id.slice(4, 12)}.md`);
    const raw: RawDocument = {
      id,
      path,
      targetScope: input.targetScope,
      kind: input.kind,
      label: input.label,
      uri: input.uri,
      contentHash: hash,
      createdAt: input.createdAt,
      memoryClass: input.memoryClass,
      memoryStage: input.memoryStage ?? "raw",
      sessionId: input.sessionId,
      eventTime: input.eventTime,
      importance: input.importance,
      confidence: input.confidence,
      supersedes: input.supersedes ?? [],
      text: input.text
    };
    await writeMarkdown(join(this.vaultPath, path), rawToFrontmatter(raw), ["# Raw Document", "", input.text].join("\n"));
    return raw;
  }

  async writeWikiPage(draft: WikiPageDraft, timestamp: string): Promise<WikiPage> {
    return this.writePage(draft, timestamp, await this.readWikiPages());
  }

  async writeMemoryPage(draft: WikiPageDraft, timestamp: string): Promise<WikiPage> {
    return this.writePage(draft, timestamp, await this.readMemoryPages());
  }

  async readRawDocuments(): Promise<RawDocument[]> {
    const [legacyRaw, memoryRaw, wikiRaw] = await Promise.all([
      readRawTree(join(this.vaultPath, "raw"), this.vaultPath),
      readRawTree(join(this.vaultPath, "memory", "raw"), this.vaultPath, "memory"),
      readRawTree(join(this.vaultPath, "wiki", "raw"), this.vaultPath, "wiki")
    ]);
    return [...legacyRaw, ...memoryRaw, ...wikiRaw].sort((left, right) => left.path.localeCompare(right.path));
  }

  async readWikiPages(): Promise<WikiPage[]> {
    return readMarkdownTree(join(this.vaultPath, "wiki"), this.vaultPath, pageFromMarkdown, { excludeDirs: ["raw"] });
  }

  async readMemoryPages(): Promise<WikiPage[]> {
    return readMarkdownTree(join(this.vaultPath, "memory"), this.vaultPath, pageFromMarkdown, { excludeDirs: ["raw"] });
  }

  async readLongMemoryPages(): Promise<WikiPage[]> {
    return readMarkdownTree(join(this.vaultPath, "memory", "long"), this.vaultPath, pageFromMarkdown);
  }

  async readWikiUpdateCandidates(options?: { reviewStatus?: WikiPage["reviewStatus"] }): Promise<WikiPage[]> {
    const candidates = await readMarkdownTree(join(this.vaultPath, "memory", "wiki-update-candidates"), this.vaultPath, pageFromMarkdown);
    if (!options?.reviewStatus) return candidates;
    return candidates.filter((candidate) => candidate.reviewStatus === options.reviewStatus);
  }

  async readSchema(): Promise<WikiSchema> {
    const [pageTypes, styleGuide, lintRules] = await Promise.all([
      readTextOrEmpty(join(this.vaultPath, "schema", "page-types.md")),
      readTextOrEmpty(join(this.vaultPath, "schema", "style-guide.md")),
      readTextOrEmpty(join(this.vaultPath, "schema", "lint-rules.md"))
    ]);
    return { pageTypes, styleGuide, lintRules };
  }

  private async writeStarterFile(filePath: string, body: string): Promise<void> {
    const absolutePath = join(this.vaultPath, filePath);
    try {
      await readFile(absolutePath, "utf8");
      return;
    } catch {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, `${body}\n`, "utf8");
    }
  }

  private async writePage(draft: WikiPageDraft, timestamp: string, existingPages: WikiPage[]): Promise<WikiPage> {
    const title = draft.title.trim();
    const path = resolvePagePath(draft, title);
    const existing = existingPages.find((page) => page.path === path) ?? existingPages.find((page) => sameTargetScope(page.path, path) && (sameTitle(page.title, title) || page.aliases.some((alias) => sameTitle(alias, title))));
    const createdAt = existing?.createdAt ?? timestamp;
    const sourceIds = uniqueStrings([...(existing?.sourceIds ?? []), ...(draft.sourceIds ?? [])]);
    const body = ensureWikiPageBody(title, draft.body, sourceIds);
    const links = uniqueStrings([...(draft.links ?? []), ...extractWikiLinks(body)]);
    const page: WikiPage = {
      id: existing?.id ?? stableId("page", [path]),
      path,
      title,
      type: draft.type?.trim() || existing?.type || "concept",
      canonical: draft.canonical?.trim() || existing?.canonical,
      summary: draft.summary?.trim() || existing?.summary || firstContentSentence(body),
      tags: uniqueStrings([...(existing?.tags ?? []), ...(draft.tags ?? [])]),
      aliases: uniqueStrings([...(existing?.aliases ?? []), ...(draft.aliases ?? [])]),
      hints: uniqueStrings([...(existing?.hints ?? []), ...(draft.hints ?? [])]),
      entrypoints: uniqueStrings([...(existing?.entrypoints ?? []), ...(draft.entrypoints ?? [])]),
      links,
      sourceIds,
      reviewStatus: draft.reviewStatus ?? existing?.reviewStatus,
      wikiTargetTitle: draft.wikiTargetTitle ?? existing?.wikiTargetTitle,
      wikiTargetPath: draft.wikiTargetPath ?? existing?.wikiTargetPath,
      approvedAt: draft.approvedAt ?? existing?.approvedAt,
      memoryClass: draft.memoryClass ?? existing?.memoryClass ?? inferMemoryClassFromPath(path),
      memoryStage: draft.memoryStage ?? existing?.memoryStage ?? inferMemoryStageFromPath(path),
      sessionId: draft.sessionId ?? existing?.sessionId,
      eventTime: draft.eventTime ?? existing?.eventTime,
      importance: draft.importance ?? existing?.importance,
      confidence: draft.confidence ?? existing?.confidence,
      supersedes: uniqueStrings([...(existing?.supersedes ?? []), ...(draft.supersedes ?? [])]),
      body,
      createdAt,
      updatedAt: timestamp
    };
    await writeMarkdown(join(this.vaultPath, page.path), pageToFrontmatter(page), page.body);
    return page;
  }
}

export const ObsidianVaultStore = LlmWikiVaultStore;

function rawToFrontmatter(raw: RawDocument): Record<string, unknown> {
  return {
    id: raw.id,
    target_scope: raw.targetScope,
    kind: raw.kind,
    label: raw.label,
    uri: raw.uri,
    content_hash: raw.contentHash,
    created_at: raw.createdAt,
    memory_class: raw.memoryClass,
    memory_stage: raw.memoryStage,
    session_id: raw.sessionId,
    event_time: raw.eventTime,
    importance: raw.importance,
    confidence: raw.confidence,
    supersedes: raw.supersedes
  };
}

function pageToFrontmatter(page: WikiPage): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    type: page.type,
    canonical: page.canonical,
    summary: page.summary,
    tags: page.tags,
    aliases: page.aliases,
    hints: page.hints,
    entrypoints: page.entrypoints,
    links: page.links,
    source_ids: page.sourceIds,
    review_status: page.reviewStatus,
    wiki_target_title: page.wikiTargetTitle,
    wiki_target_path: page.wikiTargetPath,
    approved_at: page.approvedAt,
    memory_class: page.memoryClass,
    memory_stage: page.memoryStage,
    session_id: page.sessionId,
    event_time: page.eventTime,
    importance: page.importance,
    confidence: page.confidence,
    supersedes: page.supersedes,
    created_at: page.createdAt,
    updated_at: page.updatedAt
  };
}

function rawFromMarkdown(frontmatter: Record<string, unknown>, body: string, path: string): RawDocument {
  const text = body.replace(/^# Raw Document\s*/i, "").trim();
  return {
    id: stringValue(frontmatter.id) || stableId("raw", [path, sha256(text)]),
    path,
    targetScope: rawTargetScopeValue(frontmatter.target_scope) ?? inferRawTargetScopeFromPath(path),
    kind: rawKind(stringValue(frontmatter.kind)),
    label: stringValue(frontmatter.label) || basename(path, ".md"),
    uri: stringValue(frontmatter.uri) || undefined,
    contentHash: stringValue(frontmatter.content_hash) || sha256(text),
    createdAt: stringValue(frontmatter.created_at) || new Date(0).toISOString(),
    memoryClass: memoryClassValue(frontmatter.memory_class),
    memoryStage: memoryStageValue(frontmatter.memory_stage) ?? "raw",
    sessionId: stringValue(frontmatter.session_id) || undefined,
    eventTime: stringValue(frontmatter.event_time) || undefined,
    importance: numberValue(frontmatter.importance),
    confidence: numberValue(frontmatter.confidence),
    supersedes: stringArray(frontmatter.supersedes),
    text
  };
}

function rawFromText(text: string, path: string, createdAt: string, targetScope?: RawTargetScope): RawDocument {
  return {
    id: stableId("raw", [path, sha256(text)]),
    path,
    targetScope: targetScope ?? inferRawTargetScopeFromPath(path),
    kind: "manual",
    label: basename(path, extname(path)),
    contentHash: sha256(text),
    createdAt,
    memoryStage: "raw",
    supersedes: [],
    text
  };
}

function pageFromMarkdown(frontmatter: Record<string, unknown>, body: string, path: string): WikiPage {
  const title = stringValue(frontmatter.title) || markdownTitle(body) || basename(path, ".md");
  const sourceIds = stringArray(frontmatter.source_ids);
  return {
    id: stringValue(frontmatter.id) || stableId("page", [title]),
    path,
    title,
    type: stringValue(frontmatter.type) || "concept",
    canonical: stringValue(frontmatter.canonical) || undefined,
    summary: stringValue(frontmatter.summary) || firstContentSentence(body),
    tags: stringArray(frontmatter.tags),
    aliases: stringArray(frontmatter.aliases),
    hints: stringArray(frontmatter.hints),
    entrypoints: stringArray(frontmatter.entrypoints),
    links: uniqueStrings([...stringArray(frontmatter.links), ...extractWikiLinks(body)]),
    sourceIds,
    reviewStatus: reviewStatusValue(frontmatter.review_status),
    wikiTargetTitle: stringValue(frontmatter.wiki_target_title) || undefined,
    wikiTargetPath: stringValue(frontmatter.wiki_target_path) || undefined,
    approvedAt: stringValue(frontmatter.approved_at) || undefined,
    memoryClass: memoryClassValue(frontmatter.memory_class) ?? inferMemoryClassFromPath(path),
    memoryStage: memoryStageValue(frontmatter.memory_stage) ?? inferMemoryStageFromPath(path),
    sessionId: stringValue(frontmatter.session_id) || undefined,
    eventTime: stringValue(frontmatter.event_time) || undefined,
    importance: numberValue(frontmatter.importance),
    confidence: numberValue(frontmatter.confidence),
    supersedes: stringArray(frontmatter.supersedes),
    body,
    createdAt: stringValue(frontmatter.created_at) || new Date(0).toISOString(),
    updatedAt: stringValue(frontmatter.updated_at) || new Date(0).toISOString()
  };
}

async function writeMarkdown(path: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyMarkdownDocument({ frontmatter, body }), "utf8");
}

async function readMarkdownTree<T>(
  root: string,
  vaultPath: string,
  convert: (frontmatter: Record<string, unknown>, body: string, path: string) => T,
  options?: { excludeDirs?: string[] }
): Promise<T[]> {
  const files = await markdownFiles(root, options);
  const records: T[] = [];
  for (const file of files) {
    const parsed = parseMarkdownDocument(await readFile(file, "utf8"));
    records.push(convert(parsed.frontmatter, parsed.body, relative(vaultPath, file)));
  }
  return records;
}

async function readRawTree(root: string, vaultPath: string, targetScope?: RawTargetScope): Promise<RawDocument[]> {
  const files = await textFiles(root);
  const records: RawDocument[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const relativePath = relative(vaultPath, file);
    if (file.endsWith(".md")) {
      const parsed = parseMarkdownDocument(content);
      records.push(rawFromMarkdown(parsed.frontmatter, parsed.body, relativePath));
      continue;
    }
    const fileStat = await stat(file);
    records.push(rawFromText(content, relativePath, fileStat.mtime.toISOString(), targetScope));
  }
  return records;
}

async function markdownFiles(root: string, options?: { excludeDirs?: string[] }): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await readdir(root, { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (options?.excludeDirs?.includes(entry.name)) continue;
      files.push(...(await markdownFiles(path, options)));
    }
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files.sort();
}

async function textFiles(root: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await readdir(root, { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await textFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function ensureWikiPageBody(title: string, body: string, sourceIds: string[]): string {
  const withoutFrontmatter = body.trim().startsWith("---") ? parseMarkdownDocument(body).body : body.trim();
  const withTitle = /^#\s+/m.test(withoutFrontmatter) ? withoutFrontmatter : [`# ${title}`, "", withoutFrontmatter].join("\n");
  if (/^##\s+Sources\s*$/im.test(withTitle)) return withTitle.endsWith("\n") ? withTitle : `${withTitle}\n`;
  const sourceLines = sourceIds.length > 0 ? sourceIds.map((id) => `- ${id}`) : ["- missing-source"];
  return [withTitle.trim(), "", "## Sources", ...sourceLines, ""].join("\n");
}

function extractWikiLinks(text: string): string[] {
  return uniqueStrings([...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match) => match[1]?.trim() ?? "").filter(Boolean));
}

function firstContentSentence(text: string): string {
  const content = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("- raw:") && !line.startsWith("- missing-source"))[0];
  return content?.slice(0, 180) ?? "";
}

function markdownTitle(body: string): string | undefined {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function resolvePagePath(draft: WikiPageDraft, title: string): string {
  if (draft.path?.trim()) return draft.path.trim();
  if (draft.memoryStage === "session_summary") return join("memory", "session-summaries", `${slugify(title)}.md`);
  if (draft.memoryStage === "candidate") return join("memory", "candidates", `${slugify(title)}.md`);
  if (draft.memoryStage === "long_term") return join("memory", "long", longMemoryFolder(draft.memoryClass), `${slugify(title)}.md`);
  if (draft.memoryStage === "wiki_update_candidate") return join("memory", "wiki-update-candidates", `${slugify(title)}.md`);
  if (draft.memoryStage === "consolidated") {
    return join("wiki", consolidatedFolder(draft.memoryClass), `${slugify(title)}.md`);
  }
  return join("wiki", `${slugify(title)}.md`);
}

function sameTargetScope(left: string, right: string): boolean {
  return scopeRoot(left) === scopeRoot(right);
}

function scopeRoot(path: string): string {
  if (path.startsWith("memory/session-summaries/")) return "memory/session-summaries";
  if (path.startsWith("memory/candidates/")) return "memory/candidates";
  if (path.startsWith("memory/long/")) return path.split("/").slice(0, 3).join("/");
  if (path.startsWith("memory/wiki-update-candidates/")) return "memory/wiki-update-candidates";
  if (path.startsWith("wiki/")) return path.split("/").slice(0, 2).join("/");
  return path;
}

function longMemoryFolder(memoryClass?: MemoryClass): string {
  if (memoryClass === "episodic") return "episodic";
  if (memoryClass === "procedural") return "procedural";
  return "semantic";
}

function consolidatedFolder(memoryClass?: MemoryClass): string {
  if (memoryClass === "episodic") return "episodes";
  if (memoryClass === "procedural") return "procedures";
  return "semantic";
}

function inferMemoryStageFromPath(path: string): MemoryStage | undefined {
  if (path.startsWith("raw/")) return "raw";
  if (path.startsWith("memory/raw/")) return "raw";
  if (path.startsWith("wiki/raw/")) return "raw";
  if (path.startsWith("memory/session-summaries/")) return "session_summary";
  if (path.startsWith("memory/candidates/")) return "candidate";
  if (path.startsWith("memory/long/")) return "long_term";
  if (path.startsWith("memory/wiki-update-candidates/")) return "wiki_update_candidate";
  if (path.startsWith("wiki/")) return "consolidated";
  return undefined;
}

function inferMemoryClassFromPath(path: string): MemoryClass | undefined {
  if (path.startsWith("wiki/episodes/")) return "episodic";
  if (path.startsWith("wiki/procedures/")) return "procedural";
  if (path.startsWith("wiki/semantic/")) return "semantic";
  return undefined;
}

function memoryClassValue(value: unknown): MemoryClass | undefined {
  return value === "episodic" || value === "semantic" || value === "procedural" ? value : undefined;
}

function memoryStageValue(value: unknown): MemoryStage | undefined {
  return value === "raw" || value === "session_summary" || value === "candidate" || value === "long_term" || value === "wiki_update_candidate" || value === "consolidated" ? value : undefined;
}

function rawTargetScopeValue(value: unknown): RawTargetScope | undefined {
  return value === "memory" || value === "wiki" ? value : undefined;
}

function inferRawTargetScopeFromPath(path: string): RawTargetScope | undefined {
  if (path.startsWith("memory/raw/")) return "memory";
  if (path.startsWith("wiki/raw/")) return "wiki";
  return undefined;
}

function rawRoot(targetScope?: RawTargetScope): string {
  if (targetScope === "wiki") return join("wiki", "raw");
  if (targetScope === "memory") return join("memory", "raw");
  return "raw";
}

function reviewStatusValue(value: unknown): WikiPage["reviewStatus"] {
  return value === "pending" || value === "approved" || value === "rejected" ? value : undefined;
}

function sameTitle(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function rawKind(value: string): RawDocument["kind"] {
  return value === "file" || value === "url" || value === "message" || value === "import" || value === "manual" ? value : "cli";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import type { RawDocument, WikiPage, WikiPageDraft, WikiSchema } from "../types.js";
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
  writeRawDocument(input: { text: string; kind: RawDocument["kind"]; label: string; uri?: string; createdAt: string }): Promise<RawDocument>;
  writeWikiPage(draft: WikiPageDraft, timestamp: string): Promise<WikiPage>;
  readRawDocuments(): Promise<RawDocument[]>;
  readWikiPages(): Promise<WikiPage[]>;
  readSchema(): Promise<WikiSchema>;
}

export class LlmWikiVaultStore implements VaultStore {
  constructor(readonly vaultPath: string) {}

  async init(): Promise<void> {
    await Promise.all([mkdir(join(this.vaultPath, "raw"), { recursive: true }), mkdir(join(this.vaultPath, "wiki"), { recursive: true }), mkdir(join(this.vaultPath, "schema"), { recursive: true }), mkdir(join(this.vaultPath, INTERNAL_DIR), { recursive: true })]);
    await Promise.all(STARTER_SCHEMA.map((file) => this.writeStarterFile(file.path, file.body)));
  }

  async writeRawDocument(input: { text: string; kind: RawDocument["kind"]; label: string; uri?: string; createdAt: string }): Promise<RawDocument> {
    const hash = sha256(input.text);
    const id = stableId("raw", [hash]);
    const date = input.createdAt.slice(0, 10).split("-");
    const timestamp = input.createdAt.replace(/[:.]/g, "-");
    const path = join("raw", date[0] ?? "unknown", date[1] ?? "unknown", date[2] ?? "unknown", `${timestamp}-${id.slice(4, 12)}.md`);
    const raw: RawDocument = {
      id,
      path,
      kind: input.kind,
      label: input.label,
      uri: input.uri,
      contentHash: hash,
      createdAt: input.createdAt,
      text: input.text
    };
    await writeMarkdown(join(this.vaultPath, path), rawToFrontmatter(raw), ["# Raw Document", "", input.text].join("\n"));
    return raw;
  }

  async writeWikiPage(draft: WikiPageDraft, timestamp: string): Promise<WikiPage> {
    const existing = (await this.readWikiPages()).find((page) => sameTitle(page.title, draft.title) || page.aliases.some((alias) => sameTitle(alias, draft.title)));
    const title = draft.title.trim();
    const path = existing?.path ?? join("wiki", `${slugify(title)}.md`);
    const createdAt = existing?.createdAt ?? timestamp;
    const sourceIds = uniqueStrings([...(existing?.sourceIds ?? []), ...(draft.sourceIds ?? [])]);
    const body = ensureWikiPageBody(title, draft.body, sourceIds);
    const links = uniqueStrings([...(draft.links ?? []), ...extractWikiLinks(body)]);
    const page: WikiPage = {
      id: existing?.id ?? stableId("page", [title]),
      path,
      title,
      type: draft.type?.trim() || existing?.type || "concept",
      summary: draft.summary?.trim() || existing?.summary || firstContentSentence(body),
      tags: uniqueStrings([...(existing?.tags ?? []), ...(draft.tags ?? [])]),
      aliases: uniqueStrings([...(existing?.aliases ?? []), ...(draft.aliases ?? [])]),
      links,
      sourceIds,
      body,
      createdAt,
      updatedAt: timestamp
    };
    await writeMarkdown(join(this.vaultPath, page.path), pageToFrontmatter(page), page.body);
    return page;
  }

  async readRawDocuments(): Promise<RawDocument[]> {
    return readMarkdownTree(join(this.vaultPath, "raw"), this.vaultPath, rawFromMarkdown);
  }

  async readWikiPages(): Promise<WikiPage[]> {
    return readMarkdownTree(join(this.vaultPath, "wiki"), this.vaultPath, pageFromMarkdown);
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
}

export const ObsidianVaultStore = LlmWikiVaultStore;

function rawToFrontmatter(raw: RawDocument): Record<string, unknown> {
  return { id: raw.id, kind: raw.kind, label: raw.label, uri: raw.uri, content_hash: raw.contentHash, created_at: raw.createdAt };
}

function pageToFrontmatter(page: WikiPage): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    type: page.type,
    summary: page.summary,
    tags: page.tags,
    aliases: page.aliases,
    links: page.links,
    source_ids: page.sourceIds,
    created_at: page.createdAt,
    updated_at: page.updatedAt
  };
}

function rawFromMarkdown(frontmatter: Record<string, unknown>, body: string, path: string): RawDocument {
  const text = body.replace(/^# Raw Document\s*/i, "").trim();
  return {
    id: stringValue(frontmatter.id) || stableId("raw", [path]),
    path,
    kind: rawKind(stringValue(frontmatter.kind)),
    label: stringValue(frontmatter.label) || basename(path, ".md"),
    uri: stringValue(frontmatter.uri) || undefined,
    contentHash: stringValue(frontmatter.content_hash) || sha256(text),
    createdAt: stringValue(frontmatter.created_at) || new Date(0).toISOString(),
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
    summary: stringValue(frontmatter.summary) || firstContentSentence(body),
    tags: stringArray(frontmatter.tags),
    aliases: stringArray(frontmatter.aliases),
    links: uniqueStrings([...stringArray(frontmatter.links), ...extractWikiLinks(body)]),
    sourceIds,
    body,
    createdAt: stringValue(frontmatter.created_at) || new Date(0).toISOString(),
    updatedAt: stringValue(frontmatter.updated_at) || new Date(0).toISOString()
  };
}

async function writeMarkdown(path: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyMarkdownDocument({ frontmatter, body }), "utf8");
}

async function readMarkdownTree<T>(root: string, vaultPath: string, convert: (frontmatter: Record<string, unknown>, body: string, path: string) => T): Promise<T[]> {
  const files = await markdownFiles(root);
  const records: T[] = [];
  for (const file of files) {
    const parsed = parseMarkdownDocument(await readFile(file, "utf8"));
    records.push(convert(parsed.frontmatter, parsed.body, relative(vaultPath, file)));
  }
  return records;
}

async function markdownFiles(root: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await readdir(root, { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

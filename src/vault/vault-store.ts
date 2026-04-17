import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { Entity, Episode, GraphSnapshot, Relation, SourceRef } from "../types.js";
import { parseMarkdownDocument, stringifyMarkdownDocument } from "../utils/frontmatter.js";
import { slugify } from "../utils/ids.js";
import { INTERNAL_DIR } from "../config.js";

const ENTITY_FOLDERS = ["People", "Projects", "Bugs", "Rules", "Concepts"] as const;
const VAULT_FOLDERS = [...ENTITY_FOLDERS, "Sessions", "Graph", "Dashboards", "Templates", join(INTERNAL_DIR, "logs")] as const;

const STARTER_FILES: Array<{ path: string; body: string }> = [
  {
    path: join("Dashboards", "Overview.md"),
    body: ["# Knowledge Graph Overview", "", "## Recent Sessions", "", "## Active Projects", "", "## Open Bugs", "", "## Rules"].join("\n")
  },
  {
    path: join("Templates", "Person.md"),
    body: ["# {{name}}", "", "## Summary", "", "## Links"].join("\n")
  },
  {
    path: join("Templates", "Project.md"),
    body: ["# {{name}}", "", "## Summary", "", "## Status", "", "## Links"].join("\n")
  },
  {
    path: join("Templates", "Bug.md"),
    body: ["# {{name}}", "", "## Summary", "", "## Status", "", "## Evidence"].join("\n")
  },
  {
    path: join("Templates", "Rule.md"),
    body: ["# {{name}}", "", "## Rule", "", "## Rationale"].join("\n")
  },
  {
    path: join("Templates", "Concept.md"),
    body: ["# {{name}}", "", "## Summary", "", "## Links"].join("\n")
  },
  {
    path: join("Templates", "Session.md"),
    body: ["# {{title}}", "", "## Observation", "", "## Entities"].join("\n")
  }
];

export interface VaultStore {
  init(): Promise<void>;
  writeEntity(entity: Entity): Promise<Entity>;
  writeRelation(relation: Relation): Promise<Relation>;
  writeEpisode(episode: Episode): Promise<Episode>;
  writeSource(source: SourceRef): Promise<SourceRef>;
  readSnapshot(): Promise<GraphSnapshot>;
}

export class ObsidianVaultStore implements VaultStore {
  private readonly sourcesById = new Map<string, SourceRef>();

  constructor(readonly vaultPath: string) {}

  async init(): Promise<void> {
    await Promise.all(VAULT_FOLDERS.map((folder) => mkdir(join(this.vaultPath, folder), { recursive: true })));
    await Promise.all(STARTER_FILES.map((file) => this.writeStarterFile(file.path, file.body)));
  }

  async writeEntity(entity: Entity): Promise<Entity> {
    const filePath = entity.filePath ?? join(entityFolder(entity.type), `${slugify(`${entity.name}-${entity.id}`)}.md`);
    const body = [
      `# ${entity.name}`,
      "",
      entity.summary ?? "",
      "",
      "## Links",
      ...entity.aliases.map((alias) => `- Alias: ${alias}`)
    ].join("\n");

    await this.writeMarkdown(filePath, entityToFrontmatter(entity), body);
    return { ...entity, filePath };
  }

  async writeRelation(relation: Relation): Promise<Relation> {
    const filePath =
      relation.filePath ?? join("Graph", `${slugify(`${relation.sourceId}-${relation.predicate}-${relation.targetId}`)}.md`);
    const body = [
      `# ${relation.predicate}`,
      "",
      relation.description ?? `${relation.sourceId} ${relation.predicate} ${relation.targetId}`,
      "",
      `Source: [[${relation.sourceId}]]`,
      `Target: [[${relation.targetId}]]`
    ].join("\n");

    await this.writeMarkdown(filePath, relationToFrontmatter(relation), body);
    return { ...relation, filePath };
  }

  async writeEpisode(episode: Episode): Promise<Episode> {
    const filePath = episode.filePath ?? join("Sessions", `${slugify(`${episode.title}-${episode.id}`)}.md`);
    const entityLinks = episode.entityIds.map((id) => `- [[${id}]]`).join("\n");
    const source = episode.sourceId ? this.sourcesById.get(episode.sourceId) : undefined;
    const sourceLines = source
      ? ["", "## Source", `- Kind: ${source.kind}`, `- Label: ${source.label}`, source.uri ? `- URI: ${source.uri}` : undefined].filter(
          Boolean
        )
      : [];
    const body = [
      `# ${episode.title}`,
      "",
      episode.summary ?? "",
      ...sourceLines,
      "",
      "## Observation",
      episode.text,
      "",
      "## Entities",
      entityLinks
    ].join("\n");

    await this.writeMarkdown(filePath, episodeToFrontmatter(episode, source), body);
    return { ...episode, filePath };
  }

  async writeSource(source: SourceRef): Promise<SourceRef> {
    this.sourcesById.set(source.id, source);
    return { ...source, filePath: undefined };
  }

  async readSnapshot(): Promise<GraphSnapshot> {
    const [entitiesByFolder, relations, sessions] = await Promise.all([
      Promise.all(ENTITY_FOLDERS.map((folder) => this.readFolder(folder, frontmatterToEntity))),
      this.readFolder("Graph", frontmatterToRelation),
      this.readFolder("Sessions", frontmatterToSessionRecord)
    ]);
    const sessionSources = sessions.map((session) => session.source).filter((source): source is SourceRef => Boolean(source));
    return {
      entities: entitiesByFolder.flat(),
      relations,
      episodes: sessions.map((session) => session.episode),
      sources: dedupeSources(sessionSources)
    };
  }

  private async writeMarkdown(filePath: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
    const absolutePath = join(this.vaultPath, filePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, stringifyMarkdownDocument({ frontmatter, body }), "utf8");
  }

  private async writeStarterFile(filePath: string, body: string): Promise<void> {
    const absolutePath = join(this.vaultPath, filePath);
    try {
      await readFile(absolutePath, "utf8");
      return;
    } catch {
      await mkdir(join(absolutePath, ".."), { recursive: true });
      await writeFile(absolutePath, `${body}\n`, "utf8");
    }
  }

  private async readFolder<T>(folder: string, convert: (frontmatter: Record<string, unknown>, body: string, filePath: string) => T): Promise<T[]> {
    const absoluteFolder = join(this.vaultPath, folder);
    let entries: string[];
    try {
      entries = await readdir(absoluteFolder);
    } catch {
      return [];
    }

    const records: T[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const absolutePath = join(absoluteFolder, entry);
      const markdown = await readFile(absolutePath, "utf8");
      const parsed = parseMarkdownDocument(markdown);
      records.push(convert(parsed.frontmatter, parsed.body, relative(this.vaultPath, absolutePath)));
    }
    return records;
  }
}

function entityToFrontmatter(entity: Entity): Record<string, unknown> {
  return {
    id: entity.id,
    type: entity.type,
    aliases: entity.aliases,
    tags: entity.tags,
    confidence: entity.confidence,
    created_at: entity.createdAt,
    updated_at: entity.updatedAt,
    external_refs: entity.externalRefs
  };
}

function relationToFrontmatter(relation: Relation): Record<string, unknown> {
  return {
    id: relation.id,
    source_id: relation.sourceId,
    target_id: relation.targetId,
    predicate: relation.predicate,
    weight: relation.weight,
    confidence: relation.confidence,
    evidence_ids: relation.evidenceIds,
    created_at: relation.createdAt,
    updated_at: relation.updatedAt
  };
}

function episodeToFrontmatter(episode: Episode, source?: SourceRef): Record<string, unknown> {
  return {
    id: episode.id,
    source_id: episode.sourceId,
    source_kind: source?.kind,
    source_label: source?.label,
    source_uri: source?.uri,
    source_text: source?.text,
    entity_ids: episode.entityIds,
    created_at: episode.createdAt,
    updated_at: episode.updatedAt
  };
}

function frontmatterToEntity(frontmatter: Record<string, unknown>, body: string, filePath: string): Entity {
  return {
    id: stringValue(frontmatter.id, `entity:${basename(filePath, ".md")}`),
    name: titleFromBody(body, basename(filePath, ".md")),
    type: stringValue(frontmatter.type, "unknown") as Entity["type"],
    summary: bodyWithoutHeading(body),
    aliases: stringArray(frontmatter.aliases),
    tags: stringArray(frontmatter.tags),
    confidence: numberValue(frontmatter.confidence, 0.5),
    createdAt: stringValue(frontmatter.created_at, new Date(0).toISOString()),
    updatedAt: stringValue(frontmatter.updated_at, new Date(0).toISOString()),
    externalRefs: objectValue(frontmatter.external_refs),
    filePath
  };
}

function frontmatterToRelation(frontmatter: Record<string, unknown>, body: string, filePath: string): Relation {
  return {
    id: stringValue(frontmatter.id, `relation:${basename(filePath, ".md")}`),
    sourceId: stringValue(frontmatter.source_id, ""),
    targetId: stringValue(frontmatter.target_id, ""),
    predicate: stringValue(frontmatter.predicate, "related_to"),
    description: bodyWithoutHeading(body),
    weight: numberValue(frontmatter.weight, 1),
    confidence: numberValue(frontmatter.confidence, 0.5),
    evidenceIds: stringArray(frontmatter.evidence_ids),
    createdAt: stringValue(frontmatter.created_at, new Date(0).toISOString()),
    updatedAt: stringValue(frontmatter.updated_at, new Date(0).toISOString()),
    filePath
  };
}

function frontmatterToEpisode(frontmatter: Record<string, unknown>, body: string, filePath: string): Episode {
  return {
    id: stringValue(frontmatter.id, `episode:${basename(filePath, ".md")}`),
    title: titleFromBody(body, basename(filePath, ".md")),
    text: body,
    summary: bodyWithoutHeading(body).slice(0, 240),
    sourceId: optionalString(frontmatter.source_id),
    entityIds: stringArray(frontmatter.entity_ids),
    createdAt: stringValue(frontmatter.created_at, new Date(0).toISOString()),
    updatedAt: stringValue(frontmatter.updated_at, new Date(0).toISOString()),
    filePath
  };
}

function frontmatterToSessionRecord(
  frontmatter: Record<string, unknown>,
  body: string,
  filePath: string
): { episode: Episode; source?: SourceRef } {
  const episode = frontmatterToEpisode(frontmatter, body, filePath);
  const sourceId = optionalString(frontmatter.source_id);
  const source = sourceId
    ? {
        id: sourceId,
        kind: stringValue(frontmatter.source_kind, "manual") as SourceRef["kind"],
        label: stringValue(frontmatter.source_label, titleFromBody(body, basename(filePath, ".md"))),
        uri: optionalString(frontmatter.source_uri),
        text: optionalString(frontmatter.source_text),
        createdAt: episode.createdAt,
        updatedAt: episode.updatedAt,
        filePath
      }
    : undefined;
  return { episode, source };
}

function entityFolder(type: Entity["type"]): string {
  switch (type) {
    case "person":
      return "People";
    case "project":
      return "Projects";
    case "bug":
      return "Bugs";
    case "rule":
      return "Rules";
    default:
      return "Concepts";
  }
}

function dedupeSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.id)) return false;
    seen.add(source.id);
    return true;
  });
}

function titleFromBody(body: string, fallback: string): string {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function bodyWithoutHeading(body: string): string {
  return body.replace(/^#\s+.+\n?/, "").trim();
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function objectValue(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

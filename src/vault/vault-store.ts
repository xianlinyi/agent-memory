import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  repairLinks?(): Promise<void>;
}

export class ObsidianVaultStore implements VaultStore {
  private readonly sourcesById = new Map<string, SourceRef>();
  private readonly entitiesById = new Map<string, Entity>();
  private readonly episodesById = new Map<string, Episode>();

  constructor(readonly vaultPath: string) {}

  async init(): Promise<void> {
    await Promise.all(VAULT_FOLDERS.map((folder) => mkdir(join(this.vaultPath, folder), { recursive: true })));
    await Promise.all(STARTER_FILES.map((file) => this.writeStarterFile(file.path, file.body)));
  }

  async writeEntity(entity: Entity): Promise<Entity> {
    const filePath = entity.filePath ?? join(entityFolder(entity.type), `${slugify(entity.name)}.md`);
    const body = [
      `# ${entity.name}`,
      "",
      entity.summary ?? ""
    ].join("\n");

    await this.writeMarkdown(filePath, entityToFrontmatter(entity), body);
    const written = { ...entity, filePath };
    this.entitiesById.set(written.id, written);
    return written;
  }

  async writeRelation(relation: Relation): Promise<Relation> {
    const filePath = relation.filePath ?? join("Graph", `${this.relationFileName(relation)}.md`);
    const sourceLink = this.entityLink(relation.sourceId);
    const targetLink = this.entityLink(relation.targetId);
    const sourceLabel = this.entityName(relation.sourceId);
    const targetLabel = this.entityName(relation.targetId);
    const evidenceLinks = relation.evidenceIds.map((id) => this.episodeLink(id)).filter((link): link is string => Boolean(link));
    const evidenceLines = evidenceLinks.length > 0 ? ["", "## Evidence", ...evidenceLinks.map((link) => `- ${link}`)] : [];
    const body = [
      `# ${sourceLabel} ${relation.predicate.replace(/_/g, " ")} ${targetLabel}`,
      "",
      relation.description ?? `${sourceLabel} ${relation.predicate.replace(/_/g, " ")} ${targetLabel}.`,
      "",
      "## Relationship",
      `- From: ${sourceLink ?? sourceLabel}`,
      `- To: ${targetLink ?? targetLabel}`,
      `- Predicate: ${relation.predicate}`,
      `- Confidence: ${formatConfidence(relation.confidence)}`,
      ...evidenceLines
    ].join("\n");

    await this.writeMarkdown(filePath, relationToFrontmatter(relation), body);
    return { ...relation, filePath };
  }

  async writeEpisode(episode: Episode): Promise<Episode> {
    const filePath = episode.filePath ?? join("Sessions", `${slugify(episode.title)}.md`);
    const entityLinks = episode.entityIds.map((id) => `- ${this.entityLink(id) ?? readableId(id)}`).join("\n");
    const source = episode.sourceId ? this.sourcesById.get(episode.sourceId) : undefined;
    const sourceLines = source
      ? ["", "## Source", `- ${source.kind}: ${source.label}`, source.uri ? `- URI: ${source.uri}` : undefined].filter(Boolean)
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
      "## Mentioned Entities",
      entityLinks
    ].join("\n");

    await this.writeMarkdown(filePath, episodeToFrontmatter(episode, source), body);
    const written = { ...episode, filePath };
    this.episodesById.set(written.id, written);
    return written;
  }

  async writeSource(source: SourceRef): Promise<SourceRef> {
    this.sourcesById.set(source.id, source);
    return { ...source, filePath: undefined };
  }

  async readSnapshot(): Promise<GraphSnapshot> {
    const { entities, relations, sessions } = await this.readVaultRecords();
    for (const entity of entities) {
      this.entitiesById.set(entity.id, entity);
    }
    for (const session of sessions) {
      this.episodesById.set(session.episode.id, session.episode);
    }
    const entityIds = new Set(entities.map((entity) => entity.id));
    const validRelations = relations.filter((relation) => entityIds.has(relation.sourceId) && entityIds.has(relation.targetId));
    const validSessions = sessions.map((session) => ({
      ...session,
      episode: {
        ...session.episode,
        entityIds: session.episode.entityIds.filter((id) => entityIds.has(id))
      }
    }));
    const sessionSources = validSessions.map((session) => session.source).filter((source): source is SourceRef => Boolean(source));
    return {
      entities,
      relations: validRelations,
      episodes: validSessions.map((session) => session.episode),
      sources: dedupeSources(sessionSources)
    };
  }

  async repairLinks(): Promise<void> {
    const { entities, relations, sessions } = await this.readVaultRecords();
    this.entitiesById.clear();
    this.sourcesById.clear();
    this.episodesById.clear();
    for (const entity of entities) {
      this.entitiesById.set(entity.id, entity);
    }
    for (const session of sessions) {
      this.episodesById.set(session.episode.id, session.episode);
      if (session.source) this.sourcesById.set(session.source.id, session.source);
    }

    const entityIds = new Set(entities.map((entity) => entity.id));
    for (const relation of relations) {
      if (entityIds.has(relation.sourceId) && entityIds.has(relation.targetId)) {
        await this.writeRelation(relation);
      } else if (relation.filePath) {
        await rm(join(this.vaultPath, relation.filePath), { force: true });
      }
    }

    for (const session of sessions) {
      await this.writeEpisode({
        ...session.episode,
        entityIds: session.episode.entityIds.filter((id) => entityIds.has(id))
      });
    }
  }

  private entityLink(entityId: string): string | undefined {
    const entity = this.entitiesById.get(entityId);
    if (!entity?.filePath) return undefined;
    return `[[${stripMarkdownExtension(entity.filePath)}|${escapeLinkAlias(entity.name)}]]`;
  }

  private entityName(entityId: string): string {
    return this.entitiesById.get(entityId)?.name ?? readableId(entityId);
  }

  private episodeLink(episodeId: string): string | undefined {
    const episode = this.episodesById.get(episodeId);
    if (!episode?.filePath) return undefined;
    return `[[${stripMarkdownExtension(episode.filePath)}|${escapeLinkAlias(episode.title)}]]`;
  }

  private relationFileName(relation: Relation): string {
    const source = this.entitiesById.get(relation.sourceId)?.name ?? relation.sourceId;
    const target = this.entitiesById.get(relation.targetId)?.name ?? relation.targetId;
    return slugify(`${source}-${relation.predicate}-${target}`);
  }

  private async readVaultRecords(): Promise<{
    entities: Entity[];
    relations: Relation[];
    sessions: Array<{ episode: Episode; source?: SourceRef }>;
  }> {
    const [entitiesByFolder, relations, sessions] = await Promise.all([
      Promise.all(ENTITY_FOLDERS.map((folder) => this.readFolder(folder, frontmatterToEntity))),
      this.readFolder("Graph", frontmatterToRelation),
      this.readFolder("Sessions", frontmatterToSessionRecord)
    ]);
    return { entities: entitiesByFolder.flat(), relations, sessions };
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
    name: entity.name,
    summary: entity.summary,
    type: entity.type,
    aliases: entity.aliases,
    tags: entity.tags,
    confidence: entity.confidence,
    external_refs: entity.externalRefs,
    id: propertyId(entity.id),
    created_at: entity.createdAt,
    updated_at: entity.updatedAt
  };
}

function relationToFrontmatter(relation: Relation): Record<string, unknown> {
  return {
    id: propertyId(relation.id),
    source_id: propertyId(relation.sourceId),
    target_id: propertyId(relation.targetId),
    predicate: relation.predicate,
    weight: relation.weight,
    confidence: relation.confidence,
    evidence_ids: relation.evidenceIds.map(propertyId),
    created_at: relation.createdAt,
    updated_at: relation.updatedAt
  };
}

function episodeToFrontmatter(episode: Episode, source?: SourceRef): Record<string, unknown> {
  return {
    id: propertyId(episode.id),
    source_id: episode.sourceId ? propertyId(episode.sourceId) : undefined,
    source_kind: source?.kind,
    source_label: source?.label,
    source_uri: source?.uri,
    source_text: source?.text,
    entity_ids: episode.entityIds.map(propertyId),
    created_at: episode.createdAt,
    updated_at: episode.updatedAt
  };
}

function frontmatterToEntity(frontmatter: Record<string, unknown>, body: string, filePath: string): Entity {
  return {
    id: idValue(frontmatter.id, `entity:${basename(filePath, ".md")}`),
    name: titleFromBody(body, basename(filePath, ".md")),
    type: stringValue(frontmatter.type, "unknown") as Entity["type"],
    summary: summaryBeforeSection(body),
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
    id: idValue(frontmatter.id, `relation:${basename(filePath, ".md")}`),
    sourceId: idValue(frontmatter.source_id, ""),
    targetId: idValue(frontmatter.target_id, ""),
    predicate: stringValue(frontmatter.predicate, "related_to"),
    description: relationDescriptionFromBody(body),
    weight: numberValue(frontmatter.weight, 1),
    confidence: numberValue(frontmatter.confidence, 0.5),
    evidenceIds: idArray(frontmatter.evidence_ids),
    createdAt: stringValue(frontmatter.created_at, new Date(0).toISOString()),
    updatedAt: stringValue(frontmatter.updated_at, new Date(0).toISOString()),
    filePath
  };
}

function frontmatterToEpisode(frontmatter: Record<string, unknown>, body: string, filePath: string): Episode {
  return {
    id: idValue(frontmatter.id, `episode:${basename(filePath, ".md")}`),
    title: titleFromBody(body, basename(filePath, ".md")),
    text: sectionBody(body, "Observation") ?? body,
    summary: summaryBeforeSection(body).slice(0, 240),
    sourceId: optionalId(frontmatter.source_id),
    entityIds: idArray(frontmatter.entity_ids),
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
  const sourceId = optionalId(frontmatter.source_id);
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

function relationDescriptionFromBody(body: string): string {
  const lines: string[] = [];
  for (const line of bodyWithoutHeading(body).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(Source|Target):\s+/i.test(trimmed) || /^##\s+(Relationship|Evidence)\b/i.test(trimmed)) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

function summaryBeforeSection(body: string): string {
  return bodyWithoutHeading(body).split(/^##\s+/m)[0]?.trim() ?? "";
}

function sectionBody(body: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^##\\s+${escaped}\\s*$\\n?([\\s\\S]*?)(?=^##\\s+|$)`, "m").exec(body);
  return match?.[1]?.trim();
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalId(value: unknown): string | undefined {
  const text = optionalString(value);
  return text ? readablePropertyId(text) : undefined;
}

function idValue(value: unknown, fallback: string): string {
  return readablePropertyId(stringValue(value, fallback));
}

function idArray(value: unknown): string[] {
  return stringArray(value).map(readablePropertyId);
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

function stripMarkdownExtension(filePath: string): string {
  return filePath.endsWith(".md") ? filePath.slice(0, -3) : filePath;
}

function escapeLinkAlias(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function readableId(id: string): string {
  return id.replace(/^[a-z]+:/, "").replace(/-/g, " ");
}

function formatConfidence(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "unknown";
}

function propertyId(id: string): string {
  return `\`${id}\``;
}

function readablePropertyId(id: string): string {
  return id.replace(/^`(.+)`$/, "$1");
}

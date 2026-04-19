import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MemoryEngine, textOrFile } from "../index.js";
import { configPath } from "../config.js";
import type { IngestProgressEvent, IngestResult, MemoryMatch, QueryProgressEvent, QueryResult } from "../types.js";
import type { GraphSnapshot } from "../types.js";
import type { Logger } from "../utils/logger.js";
import type { ParsedArgs } from "./args.js";
import { numberFlag, stringFlag } from "./args.js";
import { createSpinner, printJsonOrText, withSpinner } from "./output.js";

const COMPACT_RELATIONSHIP_LIMIT = 8;

export async function handleEngineCommand(engine: MemoryEngine, command: string, parsed: ParsedArgs, logger: Logger): Promise<void> {
  switch (command) {
    case "init":
      await engine.init();
      printJsonOrText(parsed, {
        ok: true,
        vaultPath: engine.config.vaultPath,
        databasePath: engine.config.databasePath,
        configPath: configPath(engine.config.vaultPath)
      });
      return;
    case "ingest":
      await handleIngest(engine, parsed, logger);
      return;
    case "query":
      await handleQuery(engine, parsed, logger);
      return;
    case "link":
      await handleLink(engine, parsed);
      return;
    case "graph":
      await handleGraph(engine, parsed);
      return;
    case "rebuild":
      await logger.debug("rebuilding graph store from vault");
      await withSpinner(parsed, "Rebuilding graph store", () => engine.rebuild());
      printJsonOrText(parsed, { ok: true, message: "Rebuilt SQLite graph store from vault." });
      return;
    case "reindex":
      await logger.debug("reindexing graph store");
      await withSpinner(parsed, "Reindexing graph store", () => engine.reindex());
      printJsonOrText(parsed, { ok: true, message: "Rebuilt FTS indexes." });
      return;
    case "compact":
      await logger.debug("compacting memory vault");
      console.log(await withSpinner(parsed, "Compacting memory vault", () => engine.compact()));
      return;
    case "import":
      await handleImport(engine, parsed);
      return;
    case "export":
      await handleExport(engine, parsed);
      return;
    case "doctor":
      await handleDoctor(engine, parsed, logger);
      return;
    case "status":
      await logger.debug("reading status");
      printJsonOrText(parsed, await engine.status());
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function handleIngest(engine: MemoryEngine, parsed: ParsedArgs, logger: Logger): Promise<void> {
  const input = parsed.positionals.join(" ");
  if (!input) throw new Error("ingest requires text or a file path.");

  await logger.debug("reading ingest input");
  const item = await textOrFile(input);
  const source = stringFlag(parsed, "source");
  await logger.debug(`ingesting ${item.text.length} characters`);
  const result = await withSpinner(parsed, "Ingesting memory", () =>
    engine.ingest({
      text: item.text,
      source: {
        kind: item.uri ? "file" : "cli",
        label: source ?? item.label,
        uri: item.uri
      },
      onProgress: async (event) => {
        await logger.debug(formatIngestProgress(event));
      }
    })
  );
  await logger.debug(`ingest complete status=${result.meta.status} entities=${result.entities.length} relations=${result.relations.length}`);
  printJsonOrText(parsed, result, ingestMessage(result));
}

async function handleQuery(engine: MemoryEngine, parsed: ParsedArgs, logger: Logger): Promise<void> {
  const text = parsed.positionals.join(" ");
  if (!text) throw new Error("query requires search text.");

  await logger.debug(`querying ${text.length} characters`);
  const spinner = createSpinner(parsed, "Querying memory");
  const result = await spinner.run(() =>
    engine.query({
      text,
      limit: numberFlag(parsed, "limit") ?? 10,
      maxHops: numberFlag(parsed, "max-hops"),
      synthesize: !parsed.flags.has("json") || (parsed.flags.has("details") && parsed.flags.has("answer")),
      onProgress: async (event) => {
        await logger.debug(formatQueryProgress(event));
      }
    })
  );
  await logger.debug(`query complete matches=${result.matches.length}`);
  if (parsed.flags.has("json")) {
    const graph = parsed.flags.has("details") ? undefined : await engine.graph();
    console.log(JSON.stringify(parsed.flags.has("details") ? result : compactQueryResult(result, graph), null, 2));
    return;
  }

  printQueryResult(parsed, result);
}

async function handleLink(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const from = stringFlag(parsed, "from");
  const to = stringFlag(parsed, "to");
  const type = stringFlag(parsed, "type");
  if (!from || !to || !type) throw new Error("link requires --from, --to, and --type.");

  const relation = await engine.link({ from, to, type, description: stringFlag(parsed, "description") });
  printJsonOrText(parsed, relation, `Linked ${relation.sourceId} ${relation.predicate} ${relation.targetId}.`);
}

async function handleGraph(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const graph = await engine.graph(stringFlag(parsed, "entity"));
  printJsonOrText(parsed, graph, `Graph: ${graph.entities.length} entities, ${graph.relations.length} relations, ${graph.episodes.length} episodes.`);
}

async function handleImport(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const path = parsed.positionals[0];
  if (!path) throw new Error("import requires a JSON export path.");
  const snapshot = await withSpinner(parsed, "Importing memory snapshot", () => engine.import({ path }));
  printJsonOrText(parsed, snapshot, `Imported ${snapshot.entities.length} entities and ${snapshot.relations.length} relations.`);
}

async function handleExport(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const format = stringFlag(parsed, "format") ?? "json";
  const snapshot = await withSpinner(parsed, "Exporting memory snapshot", () => engine.export());
  const output = format === "markdown" ? snapshotToMarkdown(snapshot) : JSON.stringify(snapshot, null, 2);
  const outPath = stringFlag(parsed, "out");
  if (outPath) {
    await writeFile(resolve(outPath), `${output}\n`, "utf8");
  } else {
    console.log(output);
  }
}

async function handleDoctor(engine: MemoryEngine, parsed: ParsedArgs, logger: Logger): Promise<void> {
  await logger.debug(`running doctor modelCall=${parsed.flags.has("model")}`);
  const checks = await withSpinner(parsed, "Checking memory setup", () => engine.doctor({ modelCall: parsed.flags.has("model") }));
  await logger.debug(`doctor complete checks=${checks.length}`);
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(checks, null, 2));
    return;
  }

  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`);
  }
}

function printQueryResult(parsed: ParsedArgs, result: Awaited<ReturnType<MemoryEngine["query"]>>): void {
  console.log(result.answer.trim() || "No answer synthesized.");

  if (!parsed.flags.has("details")) {
    const summary = formatMatchSummary(result.matches);
    if (summary) {
      console.log("");
      console.log(summary);
    }
    return;
  }

  console.log("");
  console.log(`Query: ${result.query}`);
  console.log(`Expanded: ${result.interpretation.expandedQuery}`);
  console.log(`Keywords: ${result.interpretation.keywords.join(", ") || "-"}`);
  console.log(`Entities: ${result.interpretation.entities.join(", ") || "-"}`);
  console.log(`Predicates: ${result.interpretation.predicates.join(", ") || "-"}`);
  console.log("");
  for (const match of result.matches) {
    console.log(`[${match.kind}] ${match.title} (${match.id})`);
    console.log(match.text.split(/\r?\n/).slice(0, 3).join("\n"));
    console.log("");
  }
}

interface CompactQueryResult {
  assumptions: string[];
  relationships: Array<{ source?: string; predicate: string; target?: string; description: string }>;
}

function compactQueryResult(result: QueryResult, graph?: GraphSnapshot): CompactQueryResult {
  const relationships = compactRelationships(result.matches, graph);
  return {
    assumptions: compactAssumptions(relationships),
    relationships
  };
}

function compactAssumptions(relationships: Array<{ source?: string; predicate: string; target?: string; description: string }>): string[] {
  const assumptions: string[] = [];
  const seen = new Set<string>();
  for (const relationship of relationships) {
    if (!relationship.source || !relationship.target) continue;
    const assumption = `${relationship.source} ${relationship.predicate} ${relationship.target}`;
    const key = canonicalText(assumption);
    if (seen.has(key)) continue;
    seen.add(key);
    assumptions.push(assumption);
    if (assumptions.length >= 5) break;
  }
  return assumptions;
}

function compactRelationships(matches: MemoryMatch[], graph?: GraphSnapshot): Array<{ source?: string; predicate: string; target?: string; description: string }> {
  const seen = new Set<string>();
  const relationships: Array<{ source?: string; predicate: string; target?: string; description: string }> = [];
  const entityNames = new Map(graph?.entities.map((entity) => [entity.id, entity.name]) ?? []);
  const relationById = new Map(graph?.relations.map((relation) => [relation.id, relation]) ?? []);
  const matchedEntityIds = new Set(matches.filter((match) => match.kind === "entity").map((match) => match.id));

  for (const match of matches) {
    if (relationships.length >= COMPACT_RELATIONSHIP_LIMIT) break;
    if (match.kind !== "relation") continue;
    addCompactRelationship(relationships, seen, compactRelationship(match, entityNames, relationById));
  }

  if (graph) {
    for (const relation of graph.relations) {
      if (relationships.length >= COMPACT_RELATIONSHIP_LIMIT) break;
      if (!matchedEntityIds.has(relation.sourceId) && !matchedEntityIds.has(relation.targetId)) continue;
      addCompactRelationship(relationships, seen, {
        source: entityNames.get(relation.sourceId) ?? relation.sourceId,
        predicate: relation.predicate,
        target: entityNames.get(relation.targetId) ?? relation.targetId,
        description: relation.description ?? `${entityNames.get(relation.sourceId) ?? relation.sourceId} ${relation.predicate} ${entityNames.get(relation.targetId) ?? relation.targetId}`
      });
    }
  }

  return relationships;
}

function addCompactRelationship(
  relationships: Array<{ source?: string; predicate: string; target?: string; description: string }>,
  seen: Set<string>,
  relationship: { source?: string; predicate: string; target?: string; description: string }
): void {
  const key = relationshipKey(relationship);
  if (seen.has(key)) return;
  seen.add(key);
  relationships.push({
    ...relationship,
    description: cleanCompactText(relationship.description)
  });
}

function relationshipKey(relationship: { source?: string; predicate: string; target?: string }): string {
  return [relationship.source ?? "", relationship.predicate, relationship.target ?? ""].map(canonicalText).join("\u0000");
}

function compactRelationship(
  match: MemoryMatch,
  entityNames: Map<string, string>,
  relationById: Map<string, { sourceId: string; targetId: string; predicate: string; description?: string }>
): { source?: string; predicate: string; target?: string; description: string } {
  const relation = relationById.get(match.id);
  if (relation) {
    return {
      source: entityNames.get(relation.sourceId) ?? relation.sourceId,
      predicate: relation.predicate,
      target: entityNames.get(relation.targetId) ?? relation.targetId,
      description: relation.description ?? (compactMatchText(match) || match.title)
    };
  }

  const lines = match.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const [source, predicate, target, ...descriptionLines] = lines;
  return {
    source: source && source !== match.title ? entityNames.get(source) ?? source : undefined,
    predicate: predicate || match.title,
    target: target ? entityNames.get(target) ?? target : undefined,
    description: descriptionLines.join(" ").trim() || compactMatchText(match) || match.title
  };
}

function compactMatchText(match: MemoryMatch): string {
  const lines = match.text
    .split(/\r?\n/)
    .map(cleanCompactText)
    .filter(Boolean)
    .filter((line) => canonicalText(line) !== canonicalText(match.title))
    .filter((line) => !/^(entity|relation|episode|source):/.test(line));
  return lines.slice(0, 2).join(" ");
}

function cleanCompactText(value: string): string {
  return value
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalText(value: string): string {
  return cleanCompactText(value)
    .toLowerCase()
    .replace(/\b(the|a|an|contents?|content|table|variable|field|rows?|entries?)\b/g, "")
    .replace(/[^a-z0-9_.:\u4e00-\u9fff]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatQueryProgress(event: QueryProgressEvent): string {
  const detailText = event.details ? ` ${formatLogDetails(event.details)}` : "";
  return `query stage=${event.stage} durationMs=${event.durationMs} totalMs=${event.totalMs}${detailText}`;
}

function formatLogDetails(details: Record<string, unknown>): string {
  const parts = Object.entries(details).map(([key, value]) => `${key}=${formatLogValue(value)}`);
  return parts.join(" ");
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return String(value);
  return JSON.stringify(value);
}

function formatIngestProgress(event: IngestProgressEvent): string {
  const parts = [`ingest stage=${event.stage}`, `durationMs=${event.durationMs}`, `totalMs=${event.totalMs}`];
  if (event.details) parts.push(`details=${formatLogValue(event.details)}`);
  if (event.input !== undefined) parts.push(`input=${formatLogValue(event.input)}`);
  if (event.output !== undefined) parts.push(`output=${formatLogValue(event.output)}`);
  return parts.join(" ");
}

function formatMatchSummary(matches: Awaited<ReturnType<MemoryEngine["query"]>>["matches"]): string {
  if (matches.length === 0) return "";
  const shown = matches.slice(0, 3).map((match) => `${match.kind}: ${match.title}`);
  const suffix = matches.length > shown.length ? `, +${matches.length - shown.length} more` : "";
  return `Matches (${matches.length}): ${shown.join("; ")}${suffix}`;
}

function ingestMessage(result: IngestResult): string {
  if (result.meta.skipped) {
    return `Skipped memory ingest${result.meta.reason ? `: ${result.meta.reason}` : "."}`;
  }
  if (result.meta.duplicate) {
    return result.episode.filePath ? "Skipped duplicate memory; existing episode was reused." : "Skipped duplicate or highly similar memory; nothing was stored.";
  }
  if (result.meta.merged) {
    return `Enhanced existing memory: ${result.meta.entitiesMerged} entities merged, ${result.meta.relationsMerged} relations merged, and 1 episode recorded.`;
  }
  return `Ingested ${result.entities.length} entities, ${result.relations.length} relations, and 1 episode.`;
}

function snapshotToMarkdown(snapshot: Awaited<ReturnType<MemoryEngine["export"]>>): string {
  const lines = ["# Agent Memory Export", ""];
  lines.push("## Entities", "");
  for (const entity of snapshot.entities) lines.push(`- ${entity.name} (${entity.id})`);
  lines.push("", "## Relations", "");
  for (const relation of snapshot.relations) lines.push(`- ${relation.sourceId} ${relation.predicate} ${relation.targetId}`);
  lines.push("", "## Sessions", "");
  for (const episode of snapshot.episodes) lines.push(`- ${episode.title} (${episode.id})`);
  return lines.join("\n");
}

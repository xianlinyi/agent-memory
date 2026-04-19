#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MemoryEngine, textOrFile } from "../index.js";
import {
  configPath,
  defaultVaultPath,
  loadConfig,
  loadUserConfig,
  prepareCopilotIsolatedConfig,
  USER_CONFIG_FILE,
  writeConfig,
  writeUserConfig
} from "../config.js";
import { MemoryEngineExecutor } from "../core/engine-executor.js";
import type { AgentMemoryConfig, IngestResult, MemoryMatch, QueryProgressEvent, QueryResult } from "../types.js";
import type { GraphSnapshot } from "../types.js";
import { appendNodeOption, createCliLogger, type Logger } from "../utils/logger.js";

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const COMPACT_RELATIONSHIP_LIMIT = 8;
const SPINNER_FRAMES = [
  "\x1b[34m⠋\x1b[0m",
  "\x1b[34m⠙\x1b[0m",
  "\x1b[34m⠹\x1b[0m",
  "\x1b[34m⠸\x1b[0m",
  "\x1b[34m⠼\x1b[0m",
  "\x1b[34m⠴\x1b[0m",
  "\x1b[34m⠦\x1b[0m",
  "\x1b[34m⠧\x1b[0m",
  "\x1b[34m⠇\x1b[0m",
  "\x1b[34m⠏\x1b[0m"
];
const NO_COLOR_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

async function main(): Promise<void> {
  process.env.NODE_OPTIONS = appendNodeOption(process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning");

  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.command;
  const logger = await createCliLogger({ verbose: parsed.flags.has("verbose"), logFile: stringFlag(parsed, "log-file") });
  try {
    if (!command || command === "help" || parsed.flags.has("help")) {
      printHelp();
      return;
    }

    if (command === "default") {
      await handleDefault(parsed);
      return;
    }

    const vaultPath = stringFlag(parsed, "vault") ?? (await defaultVaultPath());
    await logger.debug(`command=${command} vault=${vaultPath}`);
    if (command === "config") {
      await handleConfig(vaultPath, parsed);
      return;
    }

    if (command === "copilot") {
      await handleCopilot(vaultPath, parsed);
      return;
    }

    const executor = await MemoryEngineExecutor.create({ vaultPath, logger });
    await executor.run(command, (engine) => handleEngineCommand(engine, command, parsed, logger));
  } finally {
    await logger.close?.();
  }
}

async function handleEngineCommand(engine: MemoryEngine, command: string, parsed: ParsedArgs, logger: Logger): Promise<void> {
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

async function handleConfig(vaultPath: string, parsed: ParsedArgs): Promise<void> {
  const [action, key, ...valueParts] = parsed.positionals;
  const config = await loadConfig(vaultPath);

  switch (action) {
    case "get": {
      const value = key ? getConfigValue(config, key) : config;
      printJsonOrText(parsed, value, formatConfigValue(value));
      return;
    }
    case "list":
    case undefined:
      printJsonOrText(parsed, config, JSON.stringify(config, null, 2));
      return;
    case "set": {
      if (!key) throw new Error("config set requires a key.");
      if (valueParts.length === 0) throw new Error("config set requires a value.");
      const value = parseConfigValue(valueParts.join(" "));
      setConfigValue(config, key, value);
      await writeConfig(config);
      printJsonOrText(parsed, { ok: true, key, value }, `Set ${key} = ${formatConfigValue(value)}`);
      return;
    }
    case "unset": {
      if (!key) throw new Error("config unset requires a key.");
      unsetConfigValue(config, key);
      await writeConfig(config);
      printJsonOrText(parsed, { ok: true, key }, `Unset ${key}`);
      return;
    }
    default:
      throw new Error(`Unknown config action: ${action}`);
  }
}

async function handleCopilot(vaultPath: string, parsed: ParsedArgs): Promise<void> {
  const [action] = parsed.positionals;
  switch (action) {
    case "isolate": {
      const isolated = await prepareCopilotIsolatedConfig(vaultPath, stringFlag(parsed, "config-dir"));
      const config = await loadConfig(vaultPath);
      config.model.configDir = isolated.configDir;
      await writeConfig(config);
      printJsonOrText(
        parsed,
        { ok: true, vaultPath: config.vaultPath, modelConfigDir: isolated.configDir, configPath: isolated.configPath, copiedFrom: isolated.copiedFrom },
        `Copilot hooks isolated for ${config.vaultPath}; model.configDir = ${isolated.configDir}`
      );
      return;
    }
    default:
      throw new Error(`Unknown copilot action: ${action ?? "<missing>"}`);
  }
}

async function handleDefault(parsed: ParsedArgs): Promise<void> {
  const [action, value] = parsed.positionals;

  switch (action) {
    case "get":
    case undefined: {
      const vaultPath = await defaultVaultPath();
      printJsonOrText(parsed, { vaultPath, configPath: USER_CONFIG_FILE }, vaultPath);
      return;
    }
    case "set": {
      if (!value) throw new Error("default set requires a vault path.");
      const vaultPath = resolveHome(value);
      await writeUserConfig({ ...(await loadUserConfig()), defaultVaultPath: vaultPath });
      printJsonOrText(parsed, { ok: true, vaultPath, configPath: USER_CONFIG_FILE }, `Default vault set to ${vaultPath}`);
      return;
    }
    case "unset": {
      await writeUserConfig({});
      const vaultPath = await defaultVaultPath();
      printJsonOrText(parsed, { ok: true, vaultPath, configPath: USER_CONFIG_FILE }, `Default vault reset to ${vaultPath}`);
      return;
    }
    default:
      throw new Error(`Unknown default action: ${action}`);
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const [command, ...rest] = args;
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        flags.set(rawKey, inlineValue);
      } else if (rest[index + 1] && !rest[index + 1].startsWith("--")) {
        flags.set(rawKey, rest[index + 1]);
        index += 1;
      } else {
        flags.set(rawKey, true);
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function numberFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(parsed, name);
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function printJsonOrText(parsed: ParsedArgs, value: unknown, text?: string): void {
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(text ?? JSON.stringify(value, null, 2));
  }
}

async function withSpinner<T>(parsed: ParsedArgs, message: string, operation: () => Promise<T>): Promise<T> {
  return createSpinner(parsed, message).run(operation);
}

interface CliSpinner {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

function createSpinner(parsed: ParsedArgs, initialMessage: string): CliSpinner {
  const enabled = Boolean(process.stderr.isTTY) && !parsed.flags.has("verbose");
  const frames = process.env.NO_COLOR ? NO_COLOR_SPINNER_FRAMES : SPINNER_FRAMES;
  let frameIndex = 0;
  let timer: NodeJS.Timeout | undefined;
  let lastLength = 0;
  let cursorHidden = false;
  const startedAt = Date.now();

  const render = () => {
    if (!enabled) return;
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const elapsedText = process.env.NO_COLOR ? `${elapsedSeconds}s` : `\x1b[90m${elapsedSeconds}s\x1b[0m`;
    const line = `${frames[frameIndex]} ${initialMessage} ${elapsedText}`;
    frameIndex = (frameIndex + 1) % frames.length;
    lastLength = Math.max(lastLength, line.length);
    process.stderr.write(`\r${line}${" ".repeat(Math.max(0, lastLength - line.length))}`);
  };

  const stop = () => {
    if (!enabled) return;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    process.stderr.write(`\r${" ".repeat(lastLength)}\r`);
    if (cursorHidden) {
      process.stderr.write("\x1b[?25h");
      cursorHidden = false;
    }
    lastLength = 0;
  };

  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (enabled) {
        process.stderr.write("\x1b[?25l");
        cursorHidden = true;
        render();
        timer = setInterval(render, 80);
      }
      try {
        return await operation();
      } finally {
        stop();
      }
    }
  };
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

function formatMatchSummary(matches: Awaited<ReturnType<MemoryEngine["query"]>>["matches"]): string {
  if (matches.length === 0) return "";
  const shown = matches.slice(0, 3).map((match) => `${match.kind}: ${match.title}`);
  const suffix = matches.length > shown.length ? `, +${matches.length - shown.length} more` : "";
  return `Matches (${matches.length}): ${shown.join("; ")}${suffix}`;
}

function resolveHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? "", path.slice(2));
  return resolve(path);
}

function getConfigValue(config: AgentMemoryConfig, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setConfigValue(config: AgentMemoryConfig, key: string, value: unknown): void {
  assertConfigKey(key);
  const parts = key.split(".");
  const last = parts.pop();
  if (!last) throw new Error("Invalid config key.");
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const part of parts) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[last] = value;
}

function unsetConfigValue(config: AgentMemoryConfig, key: string): void {
  assertConfigKey(key);
  const parts = key.split(".");
  const last = parts.pop();
  if (!last) throw new Error("Invalid config key.");
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const part of parts) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    current = next as Record<string, unknown>;
  }
  delete current[last];
}

function assertConfigKey(key: string): void {
  const allowedKeys = new Set([
    "databasePath",
    "model.provider",
    "model.model",
    "model.reasoningEffort",
    "model.cliPath",
    "model.cliUrl",
    "model.cliArgs",
    "model.cwd",
    "model.configDir",
    "model.traceDir",
    "model.githubToken",
    "model.useLoggedInUser",
    "model.logLevel",
    "model.command",
    "model.args",
    "model.promptInput",
    "model.timeoutMs"
  ]);
  if (!allowedKeys.has(key)) {
    throw new Error(`Unsupported config key: ${key}`);
  }
}

function parseConfigValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  if (value.includes(",") && !value.includes(" ")) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return value;
}

function formatConfigValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function ingestMessage(result: IngestResult): string {
  if (result.meta.duplicate) {
    return "Skipped duplicate memory; existing episode was reused.";
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

function printHelp(): void {
  console.log(`agent-memory

Usage:
  agent-memory init
  agent-memory init --vault <path>
  agent-memory ingest <text|file> [--source <label>] [--vault <path>]
  agent-memory query <text> [--limit n] [--max-hops n] [--details] [--json] [--answer] [--vault <path>]
  agent-memory link --from <id> --to <id> --type <predicate> [--description <text>] [--vault <path>]
  agent-memory graph [--entity <id>] [--json] [--vault <path>]
  agent-memory rebuild [--vault <path>]
  agent-memory reindex [--vault <path>]
  agent-memory compact [--vault <path>]
  agent-memory import <export.json> [--vault <path>]
  agent-memory export [--format json|markdown] [--out <path>] [--vault <path>]
  agent-memory doctor [--model] [--json] [--vault <path>]
  agent-memory status [--json] [--vault <path>]
  agent-memory default get [--json]
  agent-memory default set <vault-path> [--json]
  agent-memory default unset [--json]
  agent-memory config get [key] [--json] [--vault <path>]
  agent-memory config set <key> <value> [--json] [--vault <path>]
  agent-memory config unset <key> [--json] [--vault <path>]
  agent-memory copilot isolate [--config-dir <path>] [--json] [--vault <path>]

Global flags:
  --verbose                 Write progress logs to stderr.
  --log-file <path>         Append progress logs to a file.

Query output:
  --json                    Print compact assumptions and relationships.
  --answer                  Include a synthesized answer only with --json --details.
  --details                 Include query interpretation and full matches in text mode, or full JSON with --json.
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

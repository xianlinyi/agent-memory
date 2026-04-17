#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MemoryEngine, textOrFile } from "../index.js";
import { configPath, defaultVaultPath, loadConfig, loadUserConfig, USER_CONFIG_FILE, writeConfig, writeUserConfig } from "../config.js";
import type { AgentMemoryConfig } from "../types.js";

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.command;

  if (!command || command === "help" || parsed.flags.has("help")) {
    printHelp();
    return;
  }

  if (command === "default") {
    await handleDefault(parsed);
    return;
  }

  const vaultPath = stringFlag(parsed, "vault") ?? (await defaultVaultPath());
  if (command === "config") {
    await handleConfig(vaultPath, parsed);
    return;
  }

  const engine = await MemoryEngine.create({ vaultPath });

  try {
    switch (command) {
      case "init":
        await engine.init();
        printJsonOrText(parsed, {
          ok: true,
          vaultPath: engine.config.vaultPath,
          databasePath: engine.config.databasePath,
          configPath: configPath(engine.config.vaultPath)
        });
        break;
      case "ingest":
        await handleIngest(engine, parsed);
        break;
      case "query":
        await handleQuery(engine, parsed);
        break;
      case "link":
        await handleLink(engine, parsed);
        break;
      case "graph":
        await handleGraph(engine, parsed);
        break;
      case "rebuild":
        await engine.rebuild();
        printJsonOrText(parsed, { ok: true, message: "Rebuilt SQLite graph store from vault." });
        break;
      case "reindex":
        await engine.reindex();
        printJsonOrText(parsed, { ok: true, message: "Rebuilt FTS indexes." });
        break;
      case "compact":
        console.log(await engine.compact());
        break;
      case "import":
        await handleImport(engine, parsed);
        break;
      case "export":
        await handleExport(engine, parsed);
        break;
      case "doctor":
        await handleDoctor(engine, parsed);
        break;
      case "status":
        printJsonOrText(parsed, await engine.status());
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    await engine.close();
  }
}

async function handleIngest(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const input = parsed.positionals.join(" ");
  if (!input) throw new Error("ingest requires text or a file path.");

  const item = await textOrFile(input);
  const source = stringFlag(parsed, "source");
  const result = await engine.ingest({
    text: item.text,
    source: {
      kind: item.uri ? "file" : "cli",
      label: source ?? item.label,
      uri: item.uri
    }
  });
  printJsonOrText(parsed, result, `Ingested ${result.entities.length} entities, ${result.relations.length} relations, and 1 episode.`);
}

async function handleQuery(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const text = parsed.positionals.join(" ");
  if (!text) throw new Error("query requires search text.");

  const result = await engine.query({
    text,
    limit: numberFlag(parsed, "limit") ?? 10,
    maxHops: numberFlag(parsed, "max-hops")
  });
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result.answer);
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
  const snapshot = await engine.import({ path });
  printJsonOrText(parsed, snapshot, `Imported ${snapshot.entities.length} entities and ${snapshot.relations.length} relations.`);
}

async function handleExport(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const format = stringFlag(parsed, "format") ?? "json";
  const snapshot = await engine.export();
  const output = format === "markdown" ? snapshotToMarkdown(snapshot) : JSON.stringify(snapshot, null, 2);
  const outPath = stringFlag(parsed, "out");
  if (outPath) {
    await writeFile(resolve(outPath), `${output}\n`, "utf8");
  } else {
    console.log(output);
  }
}

async function handleDoctor(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const checks = await engine.doctor({ modelCall: parsed.flags.has("model") });
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
  agent-memory query <text> [--limit n] [--max-hops n] [--json] [--vault <path>]
  agent-memory link --from <id> --to <id> --type <predicate> [--vault <path>]
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
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

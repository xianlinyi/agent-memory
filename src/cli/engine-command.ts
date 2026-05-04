import { MemoryEngine, textOrFile } from "../index.js";
import { configPath } from "../config.js";
import type { ConsolidateResult, IngestResult, RawDocument, RawTargetScope, WikiPage, WikiProgressEvent, WikiQueryResult } from "../types.js";
import type { Logger } from "../utils/logger.js";
import type { ParsedArgs } from "./args.js";
import { numberFlag, stringFlag } from "./args.js";
import { printJsonOrText, withSpinner } from "./output.js";

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
    case "reindex":
      await logger.debug("reindexing LLM Wiki");
      await withSpinner(parsed, "Reindexing LLM Wiki", () => engine.reindex());
      printJsonOrText(parsed, { ok: true, message: "Rebuilt LLM Wiki search index." });
      return;
    case "consolidate":
      await handleConsolidate(engine, parsed, logger);
      return;
    case "long-memory":
      await handleLongMemory(engine, parsed);
      return;
    case "wiki-updates":
      await handleWikiUpdates(engine, parsed);
      return;
    case "approve-wiki-update":
      await handleApproveWikiUpdate(engine, parsed, logger);
      return;
    case "reject-wiki-update":
      await handleRejectWikiUpdate(engine, parsed, logger);
      return;
    case "lint":
      await handleLint(engine, parsed);
      return;
    case "pages":
      await handlePages(engine, parsed);
      return;
    case "sources":
      await handleSources(engine, parsed);
      return;
    case "doctor":
      await handleDoctor(engine, parsed);
      return;
    case "status":
      printJsonOrText(parsed, await engine.status());
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function handleIngest(engine: MemoryEngine, parsed: ParsedArgs, logger: Logger): Promise<void> {
  const input = parsed.positionals.join(" ");
  if (!input) throw new Error("ingest requires text or a file path.");
  const item = await textOrFile(input);
  const source = stringFlag(parsed, "source");
  const result = await withSpinner(parsed, "Compiling LLM Wiki", () =>
    engine.ingest({
      text: item.text,
      source: {
        kind: item.uri ? "file" : "cli",
        label: source ?? item.label,
        uri: item.uri
      },
      targetScope: targetScopeFlag(parsed),
      memory: {
        class: memoryClassFlag(parsed),
        sessionId: stringFlag(parsed, "session-id"),
        eventTime: stringFlag(parsed, "event-time")
      },
      deferConsolidation: true,
      onProgress: async (event) => logger.debug(formatProgress(event))
    })
  );
  printJsonOrText(parsed, result, ingestMessage(result));
}

async function handleConsolidate(engine: MemoryEngine, parsed: ParsedArgs, logger: Logger): Promise<void> {
  const result = await withSpinner(parsed, "Consolidating memory", () =>
    engine.consolidate({
      sessionId: stringFlag(parsed, "session-id"),
      onProgress: async (event) => logger.debug(formatProgress(event))
    })
  );
  printJsonOrText(parsed, result, consolidateMessage(result));
}

async function handleLongMemory(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const pages = await engine.longMemory({ memoryClass: memoryClassFlag(parsed) });
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(pages, null, 2));
    return;
  }
  for (const page of pages) console.log(formatPage(page));
}

async function handleWikiUpdates(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const pages = await engine.wikiUpdateCandidates({ reviewStatus: parsed.flags.has("all") ? undefined : "pending" });
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(pages, null, 2));
    return;
  }
  for (const page of pages) console.log(formatPage(page));
}

async function handleApproveWikiUpdate(engine: MemoryEngine, parsed: ParsedArgs, logger: Logger): Promise<void> {
  const candidateRef = parsed.positionals.join(" ");
  if (!candidateRef) throw new Error("approve-wiki-update requires a candidate id, title, or path.");
  const result = await withSpinner(parsed, "Applying wiki update", () => engine.applyWikiUpdate(candidateRef));
  await logger.debug(`approved wiki update ${result.candidate.path} -> ${result.page.path}`);
  printJsonOrText(parsed, result, `Applied ${result.candidate.path} to ${result.page.path}.`);
}

async function handleRejectWikiUpdate(engine: MemoryEngine, parsed: ParsedArgs, logger: Logger): Promise<void> {
  const candidateRef = parsed.positionals.join(" ");
  if (!candidateRef) throw new Error("reject-wiki-update requires a candidate id, title, or path.");
  const result = await withSpinner(parsed, "Rejecting wiki update", () => engine.rejectWikiUpdate(candidateRef));
  await logger.debug(`rejected wiki update ${result.candidate.path}`);
  printJsonOrText(parsed, result, `Rejected ${result.candidate.path}.`);
}

async function handleQuery(engine: MemoryEngine, parsed: ParsedArgs, logger: Logger): Promise<void> {
  const text = parsed.positionals.join(" ");
  if (!text) throw new Error("query requires search text.");
  const result = await withSpinner(parsed, "Querying LLM Wiki", () =>
    engine.query({
      text,
      limit: numberFlag(parsed, "limit"),
      synthesize: !parsed.flags.has("no-answer"),
      onProgress: async (event) => logger.debug(formatProgress(event))
    })
  );
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printQuery(result, parsed.flags.has("details"));
}

async function handleLint(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const issues = await withSpinner(parsed, parsed.flags.has("fix") ? "Linting and fixing LLM Wiki" : "Linting LLM Wiki", () => engine.lint({ fix: parsed.flags.has("fix") }));
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(issues, null, 2));
    return;
  }
  if (issues.length === 0) {
    console.log("No LLM Wiki lint issues found.");
    return;
  }
  for (const issue of issues) {
    console.log(`${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`);
  }
}

async function handlePages(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const pages = await engine.pages();
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(pages, null, 2));
    return;
  }
  for (const page of pages) console.log(formatPage(page));
}

async function handleSources(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const sources = await engine.sources();
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(sources, null, 2));
    return;
  }
  for (const source of sources) console.log(formatSource(source));
}

async function handleDoctor(engine: MemoryEngine, parsed: ParsedArgs): Promise<void> {
  const checks = await withSpinner(parsed, "Checking LLM Wiki setup", () => engine.doctor({ modelCall: parsed.flags.has("model") }));
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(checks, null, 2));
    return;
  }
  for (const check of checks) console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`);
}

function printQuery(result: WikiQueryResult, details: boolean): void {
  console.log(result.answer.trim() || "No answer synthesized.");
  if (result.pages.length > 0) {
    console.log("");
    console.log("Pages:");
    for (const page of result.pages) console.log(`- [[${page.title}]] (${page.path})`);
  }
  if (details && result.sources.length > 0) {
    console.log("");
    console.log("Sources:");
    for (const source of result.sources) console.log(`- ${source.label} (${source.path})`);
  }
}

function ingestMessage(result: IngestResult): string {
  if (result.pages.length === 0 && result.plan.notes?.includes("deferred_for_manual_consolidation")) {
    return `Stored ${result.raw.path} for deferred consolidation.`;
  }
  return `Compiled ${result.raw.path} into ${result.pages.length} wiki page${result.pages.length === 1 ? "" : "s"}.`;
}

function consolidateMessage(result: ConsolidateResult): string {
  if (result.pendingRawDocuments.length === 0) return "No pending raw memories to consolidate.";
  return `Consolidated ${result.pendingRawDocuments.length} raw item${result.pendingRawDocuments.length === 1 ? "" : "s"} into ${result.candidates.length} memory candidate${result.candidates.length === 1 ? "" : "s"}, ${result.longMemories.length} long-memory entit${result.longMemories.length === 1 ? "y" : "ies"}, and ${result.wikiPages.length} wiki entit${result.wikiPages.length === 1 ? "y" : "ies"}.`;
}

function formatPage(page: WikiPage): string {
  return `${page.title}\t${page.path}\t${page.summary}`;
}

function formatSource(source: RawDocument): string {
  return `${source.id}\t${source.path}\t${source.label}`;
}

function formatProgress(event: WikiProgressEvent): string {
  return `${event.stage} +${event.durationMs}ms total=${event.totalMs}ms${event.details ? ` ${JSON.stringify(event.details)}` : ""}`;
}

function memoryClassFlag(parsed: ParsedArgs) {
  const value = stringFlag(parsed, "memory-class");
  return value === "episodic" || value === "semantic" || value === "procedural" ? value : undefined;
}

function targetScopeFlag(parsed: ParsedArgs): RawTargetScope | undefined {
  const value = stringFlag(parsed, "target");
  return value === "memory" || value === "wiki" ? value : undefined;
}

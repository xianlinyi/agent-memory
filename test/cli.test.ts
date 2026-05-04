import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const cliPath = "dist/src/cli/index.js";

test("cli version and upgrade dry-run report package metadata", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { name: string; version: string };

  const help = await execFileAsync(process.execPath, [cliPath, "--help"]);
  assert.match(help.stdout, /Usage:/);

  const textVersion = await execFileAsync(process.execPath, [cliPath, "version"]);
  assert.equal(textVersion.stdout.trim(), packageJson.version);

  const jsonVersion = await execFileAsync(process.execPath, [cliPath, "--version", "--json"]);
  assert.deepEqual(JSON.parse(jsonVersion.stdout), { name: packageJson.name, version: packageJson.version });

  const upgrade = await execFileAsync(process.execPath, [cliPath, "upgrade", "--dry-run", "--json"]);
  const upgradeJson = JSON.parse(upgrade.stdout) as { ok: boolean; dryRun: boolean; packageName: string; currentVersion: string; command: string[] };
  assert.equal(upgradeJson.ok, true);
  assert.equal(upgradeJson.dryRun, true);
  assert.equal(upgradeJson.packageName, packageJson.name);
  assert.equal(upgradeJson.currentVersion, packageJson.version);
});

test("cli init creates LLM Wiki layout and machine-readable status", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-cli-"));
  try {
    const init = await execFileAsync(process.execPath, [cliPath, "init", "--vault", vaultPath, "--json"]);
    const initJson = JSON.parse(init.stdout) as { ok: boolean; vaultPath: string; databasePath: string; configPath: string };
    assert.equal(initJson.ok, true);
    assert.equal(initJson.databasePath, join(vaultPath, ".llm-wiki", "index.db"));
    assert.equal(initJson.configPath, join(vaultPath, ".llm-wiki", "config.json"));
    await access(join(vaultPath, "raw"));
    await access(join(vaultPath, "memory", "raw"));
    await access(join(vaultPath, "wiki"));
    await access(join(vaultPath, "wiki", "raw"));
    await access(join(vaultPath, "memory", "session-summaries"));
    await access(join(vaultPath, "memory", "candidates"));
    await access(join(vaultPath, "memory", "long", "semantic"));
    await access(join(vaultPath, "memory", "wiki-update-candidates"));
    await access(join(vaultPath, "schema", "page-types.md"));

    const status = await execFileAsync(process.execPath, [cliPath, "status", "--vault", vaultPath, "--json"]);
    const statusJson = JSON.parse(status.stdout) as { counts: { rawDocuments: number; wikiPages: number; longMemoryPages: number; wikiUpdateCandidates: number } };
    assert.equal(statusJson.counts.rawDocuments, 0);
    assert.equal(statusJson.counts.wikiPages, 0);
    assert.equal(statusJson.counts.longMemoryPages, 0);
    assert.equal(statusJson.counts.wikiUpdateCandidates, 0);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("cli compiles, queries, lints, reindexes, and lists pages/sources with a CLI provider", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-memory-cli-e2e-"));
  const vaultPath = join(rootPath, "Vault");
  const modelScript = join(rootPath, "model.js");
  try {
    await writeFile(
      modelScript,
      [
        'const fs = require("node:fs");',
        'const prompt = process.argv[2] || fs.readFileSync(0, "utf8");',
        'if (prompt.includes("Plan entity page creations")) {',
        '  const raw = JSON.parse(prompt.split("New raw document:")[1]);',
        '  console.log(JSON.stringify({ pages: [{ title: "Project Atlas", type: "project", summary: "Atlas uses Obsidian memory.", tags: ["memory"], aliases: ["Atlas"], links: ["Obsidian"], sourceIds: [raw.id], body: ["# Project Atlas", "", "Atlas uses [[Obsidian]] for local-first memory.", "", "## Sources", "- " + raw.id].join("\\n") }] }));',
        '} else if (prompt.includes("Answer the user\'s query")) {',
        '  console.log("Atlas uses Obsidian for local-first memory. (Project Atlas)");',
        '} else if (prompt.includes("Review this LLM Wiki")) {',
        '  console.log(JSON.stringify({ issues: [] }));',
        '} else {',
        '  console.log("agent-memory-ok");',
        '}'
      ].join("\n"),
      "utf8"
    );

    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.provider", "copilot-cli", "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.command", process.execPath, "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.args", JSON.stringify([modelScript, "{prompt}"]), "--vault", vaultPath]);

    const ingest = await execFileAsync(process.execPath, [cliPath, "ingest", "Project Atlas uses Obsidian for local-first memory.", "--vault", vaultPath, "--json"]);
    const ingestJson = JSON.parse(ingest.stdout) as { raw: { path: string }; pages: Array<{ title: string }> };
    assert.match(ingestJson.raw.path, /^memory\/raw\//);
    assert.equal(ingestJson.pages.length, 0);

    const consolidate = await execFileAsync(process.execPath, [cliPath, "consolidate", "--vault", vaultPath, "--json"]);
    const consolidateJson = JSON.parse(consolidate.stdout) as { candidates: Array<{ path: string }>; longMemories: Array<{ path: string }>; wikiPages: Array<{ path: string }>; wikiUpdateCandidates: Array<{ path: string }> };
    assert.equal(consolidateJson.candidates.length, 1);
    assert.equal(consolidateJson.longMemories.length, 1);
    assert.equal(consolidateJson.wikiPages.length, 0);
    assert.equal(consolidateJson.wikiUpdateCandidates.length, 0);

    const longMemory = await execFileAsync(process.execPath, [cliPath, "long-memory", "--vault", vaultPath, "--json"]);
    const longMemoryJson = JSON.parse(longMemory.stdout) as Array<{ path: string; memoryStage?: string }>;
    assert.equal(longMemoryJson.length, 1);
    assert.equal(longMemoryJson[0]?.memoryStage, "long_term");

    const wikiIngest = await execFileAsync(process.execPath, [cliPath, "ingest", "Project Atlas keeps wiki pages human editable.", "--target", "wiki", "--source", "Atlas wiki note", "--vault", vaultPath, "--json"]);
    const wikiIngestJson = JSON.parse(wikiIngest.stdout) as { raw: { path: string } };
    assert.match(wikiIngestJson.raw.path, /^wiki\/raw\//);

    const wikiConsolidate = await execFileAsync(process.execPath, [cliPath, "consolidate", "--vault", vaultPath, "--json"]);
    const wikiConsolidateJson = JSON.parse(wikiConsolidate.stdout) as { wikiPages: Array<{ path: string }> };
    assert.equal(wikiConsolidateJson.wikiPages.length, 1);
    assert.equal(wikiConsolidateJson.wikiPages[0]?.path.startsWith("wiki/"), true);

    const wikiUpdates = await execFileAsync(process.execPath, [cliPath, "wiki-updates", "--vault", vaultPath, "--json"]);
    const wikiUpdatesJson = JSON.parse(wikiUpdates.stdout) as Array<{ path: string; reviewStatus?: string }>;
    assert.equal(wikiUpdatesJson.length, 0);

    const query = await execFileAsync(process.execPath, [cliPath, "query", "Atlas memory", "--vault", vaultPath, "--json"]);
    const queryJson = JSON.parse(query.stdout) as { answer: string; pages: Array<{ title: string }>; sources: unknown[] };
    assert.match(queryJson.answer, /Obsidian/);
    assert.ok(queryJson.pages.length > 0);
    assert.equal(queryJson.sources.length, 2);

    const lint = await execFileAsync(process.execPath, [cliPath, "lint", "--vault", vaultPath, "--json"]);
    const lintJson = JSON.parse(lint.stdout) as Array<{ code: string; path?: string }>;
    assert.equal(lintJson.some((issue) => issue.code === "unreferenced_raw"), false);

    await execFileAsync(process.execPath, [cliPath, "reindex", "--vault", vaultPath, "--json"]);
    const pages = JSON.parse((await execFileAsync(process.execPath, [cliPath, "pages", "--vault", vaultPath, "--json"])).stdout) as unknown[];
    const sources = JSON.parse((await execFileAsync(process.execPath, [cliPath, "sources", "--vault", vaultPath, "--json"])).stdout) as unknown[];
    assert.equal(pages.length, 1);
    assert.equal(sources.length, 2);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("cli can reject wiki update candidates and remove them from the pending queue", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-memory-cli-reject-"));
  const vaultPath = join(rootPath, "Vault");
  try {
    await execFileAsync(process.execPath, [cliPath, "init", "--vault", vaultPath, "--json"]);
    await writeFile(
      join(vaultPath, "memory", "wiki-update-candidates", "billing-export.md"),
      [
        "---",
        "id: page:billing-export-candidate",
        "title: Update Billing Export",
        "type: procedure",
        "summary: Billing export callback troubleshooting.",
        "tags: [memory, wiki-update, procedural]",
        "aliases: []",
        "links: []",
        "source_ids:",
        "  - raw:billing-export",
        "review_status: pending",
        "wiki_target_title: Billing Export",
        "wiki_target_path: wiki/procedures/billing-export.md",
        "memory_class: procedural",
        "memory_stage: wiki_update_candidate",
        "created_at: 2026-05-03T00:00:00.000Z",
        "updated_at: 2026-05-03T00:00:00.000Z",
        "---",
        "# Billing Export",
        "",
        "Billing export uses reconciliation token to locate PSP callbacks.",
        "",
        "## Sources",
        "- raw:billing-export"
      ].join("\n"),
      "utf8"
    );

    const pending = await execFileAsync(process.execPath, [cliPath, "wiki-updates", "--vault", vaultPath, "--json"]);
    const pendingJson = JSON.parse(pending.stdout) as Array<{ path: string; reviewStatus?: string }>;
    assert.equal(pendingJson.length, 1);
    assert.equal(pendingJson[0]?.reviewStatus, "pending");

    const rejected = await execFileAsync(process.execPath, [cliPath, "reject-wiki-update", pendingJson[0]?.path ?? "", "--vault", vaultPath, "--json"]);
    const rejectedJson = JSON.parse(rejected.stdout) as { candidate: { reviewStatus?: string; path: string } };
    assert.equal(rejectedJson.candidate.reviewStatus, "rejected");

    const pendingAfterReject = await execFileAsync(process.execPath, [cliPath, "wiki-updates", "--vault", vaultPath, "--json"]);
    assert.equal((JSON.parse(pendingAfterReject.stdout) as unknown[]).length, 0);

    const allCandidates = await execFileAsync(process.execPath, [cliPath, "wiki-updates", "--all", "--vault", vaultPath, "--json"]);
    const allCandidatesJson = JSON.parse(allCandidates.stdout) as Array<{ reviewStatus?: string }>;
    assert.equal(allCandidatesJson.length, 1);
    assert.equal(allCandidatesJson[0]?.reviewStatus, "rejected");

    const pages = JSON.parse((await execFileAsync(process.execPath, [cliPath, "pages", "--vault", vaultPath, "--json"])).stdout) as unknown[];
    assert.equal(pages.length, 0);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const cliPath = "dist/src/cli/index.js";

test("cli version and upgrade dry-run report package metadata", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { name: string; version: string };

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
    await access(join(vaultPath, "wiki"));
    await access(join(vaultPath, "schema", "page-types.md"));

    const status = await execFileAsync(process.execPath, [cliPath, "status", "--vault", vaultPath, "--json"]);
    const statusJson = JSON.parse(status.stdout) as { counts: { rawDocuments: number; wikiPages: number } };
    assert.equal(statusJson.counts.rawDocuments, 0);
    assert.equal(statusJson.counts.wikiPages, 0);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("cli compiles, queries, lints, reindexes, and lists pages/sources with a CLI provider", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-memory-cli-e2e-"));
  const vaultPath = join(rootPath, "Vault");
  const modelScript = join(rootPath, "model.js");
  try {
    await execFileAsync(process.execPath, [
      "-e",
      `
const fs = require("node:fs");
fs.mkdirSync(require("node:path").dirname(process.argv[1]), { recursive: true });
fs.writeFileSync(process.argv[1], \`
const fs = require("node:fs");
const prompt = process.argv[2] || fs.readFileSync(0, "utf8");
if (prompt.includes("Plan wiki page creations")) {
  const raw = JSON.parse(prompt.split("New raw document:")[1]);
  console.log(JSON.stringify({ pages: [{ title: "Project Atlas", type: "project", summary: "Atlas uses Obsidian memory.", tags: ["memory"], aliases: ["Atlas"], links: ["Obsidian"], sourceIds: [raw.id], body: "# Project Atlas\\\\n\\\\nAtlas uses [[Obsidian]] for local-first memory.\\\\n\\\\n## Sources\\\\n- " + raw.id }] }));
} else if (prompt.includes("Answer the user's query")) {
  console.log("Atlas uses Obsidian for local-first memory. (Project Atlas)");
} else if (prompt.includes("Review this LLM Wiki")) {
  console.log(JSON.stringify({ issues: [] }));
} else {
  console.log("agent-memory-ok");
}
\`);
`,
      modelScript
    ]);

    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.provider", "copilot-cli", "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.command", process.execPath, "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.args", JSON.stringify([modelScript, "{prompt}"]), "--vault", vaultPath]);

    const ingest = await execFileAsync(process.execPath, [cliPath, "ingest", "Project Atlas uses Obsidian for local-first memory.", "--vault", vaultPath, "--json"]);
    const ingestJson = JSON.parse(ingest.stdout) as { raw: { path: string }; pages: Array<{ title: string }> };
    assert.match(ingestJson.raw.path, /^raw\//);
    assert.equal(ingestJson.pages[0]?.title, "Project Atlas");

    const query = await execFileAsync(process.execPath, [cliPath, "query", "Atlas memory", "--vault", vaultPath, "--json"]);
    const queryJson = JSON.parse(query.stdout) as { answer: string; pages: Array<{ title: string }>; sources: unknown[] };
    assert.match(queryJson.answer, /Obsidian/);
    assert.equal(queryJson.pages[0]?.title, "Project Atlas");
    assert.equal(queryJson.sources.length, 1);

    const lint = await execFileAsync(process.execPath, [cliPath, "lint", "--vault", vaultPath, "--json"]);
    const lintJson = JSON.parse(lint.stdout) as Array<{ code: string; path?: string }>;
    assert.ok(lintJson.some((issue) => issue.code === "broken_wikilink" && issue.path === "wiki/project-atlas.md"));

    await execFileAsync(process.execPath, [cliPath, "reindex", "--vault", vaultPath, "--json"]);
    const pages = JSON.parse((await execFileAsync(process.execPath, [cliPath, "pages", "--vault", vaultPath, "--json"])).stdout) as unknown[];
    const sources = JSON.parse((await execFileAsync(process.execPath, [cliPath, "sources", "--vault", vaultPath, "--json"])).stdout) as unknown[];
    assert.equal(pages.length, 1);
    assert.equal(sources.length, 1);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

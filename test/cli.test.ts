import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const cliPath = "dist/src/cli/index.js";

test("cli init and doctor produce machine-readable output", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-cli-"));
  try {
    const init = await execFileAsync(process.execPath, [cliPath, "init", "--vault", vaultPath, "--json"]);
    const initJson = JSON.parse(init.stdout) as { ok: boolean; vaultPath: string; databasePath: string; configPath: string };
    assert.equal(initJson.ok, true);
    assert.equal(initJson.vaultPath, vaultPath);
    assert.equal(initJson.databasePath, join(vaultPath, ".kg", "graph.db"));
    assert.equal(initJson.configPath, join(vaultPath, ".kg", "config.json"));
    await access(join(vaultPath, ".kg", "graph.db"));
    await access(join(vaultPath, ".kg", "config.json"));
    const persisted = JSON.parse(await readFile(join(vaultPath, ".kg", "config.json"), "utf8")) as { model: { model: string } };
    assert.equal(persisted.model.model, "gpt-5-mini");

    const doctor = await execFileAsync(process.execPath, [cliPath, "doctor", "--vault", vaultPath, "--json"]);
    const checks = JSON.parse(doctor.stdout) as Array<{ name: string; ok: boolean }>;
    assert.ok(checks.some((check) => check.name === "node"));
    assert.ok(checks.some((check) => check.name === "model"));
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("cli config set and get updates vault config", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-config-"));
  try {
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.model", "gpt-5", "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.timeoutMs", "12345", "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.cliArgs", "[\"--debug\"]", "--vault", vaultPath]);
    await access(join(vaultPath, ".kg", "config.json"));
    await assert.rejects(() => access(join(vaultPath, ".agent-memory", "config.json")));

    const model = await execFileAsync(process.execPath, [cliPath, "config", "get", "model.model", "--vault", vaultPath]);
    assert.equal(model.stdout.trim(), "gpt-5");

    const config = await execFileAsync(process.execPath, [cliPath, "config", "get", "model", "--vault", vaultPath, "--json"]);
    const json = JSON.parse(config.stdout) as { model: string; timeoutMs: number; cliArgs: string[] };
    assert.equal(json.model, "gpt-5");
    assert.equal(json.timeoutMs, 12345);
    assert.deepEqual(json.cliArgs, ["--debug"]);
    const persisted = JSON.parse(await readFile(join(vaultPath, ".kg", "config.json"), "utf8")) as { model: { timeoutMs: number } };
    assert.equal(persisted.model.timeoutMs, 12345);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("cli query json is compact unless details are requested", async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "agent-memory-query-json-"));
  const script = `
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
if (input.includes("Extract durable agent memory")) {
  console.log(JSON.stringify({
    summary: "etr represents cashir.temporary_receipt.",
    entities: [
      { name: "etr", type: "concept", summary: "etr is the contents of cashir.temporary_receipt." },
      { name: "cashir.temporary_receipt", type: "artifact", summary: "Temporary receipt table." }
    ],
    relations: [
      {
        sourceId: "etr",
        targetId: "cashir.temporary_receipt",
        predicate: "represents_table_contents",
        description: "etr is the contents of cashir.temporary_receipt."
      },
      {
        sourceId: "etr",
        targetId: "cashir.temporary_receipt",
        predicate: "represents_table_contents",
        description: "etr represents the contents of cashir.temporary_receipt."
      }
    ]
  }));
} else if (input.includes("Interpret this memory search query")) {
  console.log(JSON.stringify({
    keywords: ["etr", "下拉框"],
    entities: ["etr"],
    predicates: ["未显示"],
    expandedQuery: "etr 下拉框 保存 未显示"
  }));
} else if (input.includes("Decide whether this memory graph query needs another hop")) {
  console.log(JSON.stringify({ continue: false, nodeIds: [], reason: "enough evidence" }));
} else if (input.includes("Answer the user's memory query")) {
  console.log("记忆库没有足够信息回答。");
}
`;

  try {
    await execFileAsync(process.execPath, [cliPath, "init", "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.provider", "copilot-cli", "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.command", process.execPath, "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.args", JSON.stringify(["-e", script]), "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "config", "set", "model.promptInput", "stdin", "--vault", vaultPath]);
    await execFileAsync(process.execPath, [cliPath, "ingest", "etr就是cashir.temporary_receipt表的内容", "--vault", vaultPath]);

    const compact = await execFileAsync(process.execPath, [
      cliPath,
      "query",
      "我创建etr的时候选了下拉框的值但是点保存以后没有显示",
      "--vault",
      vaultPath,
      "--json"
    ]);
    const compactJson = JSON.parse(compact.stdout) as {
      query?: unknown;
      assumptions: string[];
      relationships: Array<{ source?: string; predicate: string; target?: string; description: string }>;
      searchTerms?: unknown;
      evidence?: unknown;
      matchCount?: unknown;
      answer?: string;
      matches?: unknown;
      interpretation?: unknown;
      interpretedQuery?: unknown;
      traversal?: unknown;
    };
    assert.equal(compactJson.answer, undefined);
    assert.equal(compactJson.query, undefined);
    assert.ok(compactJson.assumptions.includes("etr represents_table_contents cashir.temporary_receipt"));
    assert.ok(compactJson.relationships.some((item) => item.predicate === "represents_table_contents"));
    assert.ok(compactJson.relationships.some((item) => item.source === "etr" && item.target === "cashir.temporary_receipt"));
    assert.equal(compactJson.relationships.filter((item) => item.source === "etr" && item.predicate === "represents_table_contents" && item.target === "cashir.temporary_receipt").length, 1);
    assert.deepEqual(Object.keys(compactJson).sort(), ["assumptions", "relationships"]);
    assert.equal(compactJson.searchTerms, undefined);
    assert.equal(compactJson.evidence, undefined);
    assert.equal(compactJson.matchCount, undefined);
    assert.equal(compactJson.matches, undefined);
    assert.equal(compactJson.interpretation, undefined);
    assert.equal(compactJson.interpretedQuery, undefined);
    assert.equal(compactJson.traversal, undefined);

    const detailed = await execFileAsync(process.execPath, [
      cliPath,
      "query",
      "我创建etr的时候选了下拉框的值但是点保存以后没有显示",
      "--vault",
      vaultPath,
      "--json",
      "--details"
    ]);
    const detailedJson = JSON.parse(detailed.stdout) as { matches: unknown[]; interpretation: unknown };
    assert.ok(Array.isArray(detailedJson.matches));
    assert.ok(detailedJson.interpretation);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

test("cli uses a user default vault path when --vault is omitted", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agent-memory-default-root-"));
  const userConfigPath = join(rootPath, "user-config.json");
  const defaultVaultPath = join(rootPath, "DefaultVault");
  const customVaultPath = join(rootPath, "CustomVault");
  const env = { ...process.env, AGENT_MEMORY_USER_CONFIG: userConfigPath };

  try {
    const initial = await execFileAsync(process.execPath, [cliPath, "default", "get", "--json"], { env });
    const initialJson = JSON.parse(initial.stdout) as { vaultPath: string; configPath: string };
    assert.match(initialJson.vaultPath, /agent-memory\/MyVault$/);
    assert.equal(initialJson.configPath, userConfigPath);

    const set = await execFileAsync(process.execPath, [cliPath, "default", "set", customVaultPath, "--json"], { env });
    const setJson = JSON.parse(set.stdout) as { ok: boolean; vaultPath: string };
    assert.equal(setJson.ok, true);
    assert.equal(setJson.vaultPath, customVaultPath);

    const get = await execFileAsync(process.execPath, [cliPath, "default", "get"], { env });
    assert.equal(get.stdout.trim(), customVaultPath);

    const init = await execFileAsync(process.execPath, [cliPath, "init", "--json"], { env });
    const initJson = JSON.parse(init.stdout) as { vaultPath: string; databasePath: string };
    assert.equal(initJson.vaultPath, customVaultPath);
    assert.equal(initJson.databasePath, join(customVaultPath, ".kg", "graph.db"));
    await access(join(customVaultPath, ".kg", "config.json"));

    await execFileAsync(process.execPath, [cliPath, "default", "unset", "--json"], { env });
    await execFileAsync(process.execPath, [cliPath, "default", "set", defaultVaultPath], { env });
    await execFileAsync(process.execPath, [cliPath, "init"], { env });
    await access(join(defaultVaultPath, ".kg", "graph.db"));
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

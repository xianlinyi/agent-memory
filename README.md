# Agent Memory Knowledge Graph

Local-first memory for coding agents, backed by an Obsidian-compatible Markdown vault and a rebuildable SQLite FTS5 graph index.

The project gives an agent a durable memory layer that stays inspectable by humans. Markdown files are the editable record; SQLite is the fast query and relationship index; the configured model provider extracts entities, relations, query intent, graph hops, and optional answers.

## What It Does

- Stores long-lived agent memory in a local vault that can be opened in Obsidian.
- Extracts entities, sessions, sources, and relations from text or files.
- Searches memory through SQLite FTS5 plus bounded graph expansion.
- Returns compact JSON designed for downstream agents and scripts.
- Provides a TypeScript SDK and the `agent-memory` CLI.
- Supports default GitHub Copilot SDK integration and a legacy command-based provider.
- Keeps storage interfaces replaceable for custom graph stores, vault stores, embedding providers, and vector stores.

## Requirements

- Node.js `>=22.13`
- A working GitHub Copilot CLI / Copilot SDK authentication environment, unless you inject your own model provider through the SDK
- A local directory for the memory vault

The default store uses `node:sqlite`. The CLI suppresses Node's SQLite experimental warning during normal use so progress output and JSON responses stay clean.

## Install

```bash
npm install -g @agent-memory/knowledge-graph
```

Or run it without a global install:

```bash
npx @agent-memory/knowledge-graph init --vault ./memory-vault
```

## Quick Start

```bash
agent-memory init --vault ./memory-vault
agent-memory doctor --vault ./memory-vault --model
agent-memory ingest "Project Atlas uses Obsidian for local-first agent memory." --vault ./memory-vault
agent-memory query "How does Atlas store memory?" --vault ./memory-vault
agent-memory query "Atlas memory" --vault ./memory-vault --json
```

If `--vault` is omitted, the CLI uses the user default vault path. The built-in default is `~/agent-memory/MyVault`.

```bash
agent-memory default get
agent-memory default set /Users/me/Documents/MyVault
agent-memory default unset
```

## CLI Reference

```bash
agent-memory init [--vault <path>]
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
```

Global flags:

- `--verbose`: write progress logs to `stderr`.
- `--log-file <path>`: append progress logs to a file.

Interactive commands show a spinner while waiting. Structured output is written to `stdout`; the spinner and logs use `stderr`, and the spinner is disabled when output is captured by scripts.

## Query JSON

Default `query --json` returns a compact, agent-friendly result. It intentionally omits the original question and full internal matches:

```json
{
  "searchTerms": ["Atlas", "memory", "stores"],
  "assumptions": ["Project Atlas uses Obsidian"],
  "relationships": [
    {
      "source": "Project Atlas",
      "predicate": "uses",
      "target": "Obsidian",
      "description": "Project Atlas uses Obsidian for local-first agent memory."
    }
  ],
  "evidence": [
    {
      "kind": "entity",
      "title": "Project Atlas",
      "content": "Uses Obsidian for local-first agent memory."
    }
  ],
  "matchCount": 3
}
```

Use `--answer` with `--json` to include a synthesized natural-language answer. Use `--details` with `--json` to return the full `QueryResult`, including `query`, `interpretation`, `matches`, `answer`, and optional traversal details.

## Script Usage

When called from Python, Node.js, shell pipelines, or CI with captured output, parse `stdout` as JSON and keep `stderr` separate:

```python
import json
import subprocess

result = subprocess.run(
    ["agent-memory", "query", "Atlas memory", "--vault", "./memory-vault", "--json"],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    check=True,
)

data = json.loads(result.stdout)
print(data["assumptions"])
```

Do not merge `stderr` into `stdout` if you also enable `--verbose`, because logs are intentionally written to `stderr`.

## SDK

```ts
import { MemoryEngine } from "@agent-memory/knowledge-graph";

const memory = await MemoryEngine.create({ vaultPath: "./memory-vault" });

try {
  await memory.init();
  await memory.ingest({
    text: "Project Atlas uses Obsidian for local-first memory.",
    source: { kind: "message", label: "Planning chat" }
  });

  const result = await memory.query({
    text: "How does Atlas store memory?",
    limit: 5,
    maxHops: 2
  });

  console.log(result.answer);
  console.log(result.matches);
} finally {
  await memory.close();
}
```

Tests and integrations can inject custom providers or stores:

```ts
const memory = await MemoryEngine.create({
  vaultPath: "./memory-vault",
  modelProvider: myModelProvider,
  graphStore: myGraphStore,
  vaultStore: myVaultStore
});
```

## Model Configuration

Vault configuration lives in `.kg/config.json`:

```json
{
  "vaultPath": "/absolute/path/to/memory-vault",
  "databasePath": "/absolute/path/to/memory-vault/.kg/graph.db",
  "model": {
    "provider": "copilot-sdk",
    "model": "gpt-5",
    "reasoningEffort": "medium",
    "timeoutMs": 30000
  }
}
```

Update it through the CLI:

```bash
agent-memory config set model.model gpt-5 --vault ./memory-vault
agent-memory config set model.reasoningEffort medium --vault ./memory-vault
agent-memory config set model.timeoutMs 30000 --vault ./memory-vault
agent-memory config get model --vault ./memory-vault --json
```

Optional Copilot SDK fields include `model.cliPath`, `model.cliUrl`, `model.cliArgs`, `model.cwd`, `model.configDir`, `model.githubToken`, `model.useLoggedInUser`, and `model.logLevel`.

The legacy `copilot-cli` provider is still available:

```bash
agent-memory config set model.provider copilot-cli --vault ./memory-vault
agent-memory config set model.command copilot --vault ./memory-vault
agent-memory config set model.args '["ask","{prompt}"]' --vault ./memory-vault
agent-memory config set model.promptInput argument --vault ./memory-vault
```

Memory extraction, query interpretation, graph hop decisions, answer synthesis, and compaction require a configured working model provider. If the provider, auth, or model output fails, the command fails explicitly instead of writing approximate memory.

## Vault Layout

```text
memory-vault/
  People/
  Projects/
  Bugs/
  Rules/
  Sessions/
  Concepts/
  Graph/
  Dashboards/
  Templates/
  .kg/
    config.json
    graph.db
```

- `People/`: person entities.
- `Projects/`: project entities.
- `Bugs/`: bug, issue, and regression entities.
- `Rules/`: durable rules, preferences, and constraints.
- `Concepts/`: concepts, artifacts, topics, decisions, and unknown entity types.
- `Sessions/`: atomic observations from conversations, files, commands, imports, or manual input.
- `Graph/`: relation notes and relationship evidence.
- `Dashboards/`: generated starter overview notes.
- `Templates/`: generated Markdown templates.
- `.kg/`: config, SQLite index, logs, and generated state.

Markdown is the human-editable projection. SQLite is the query and relationship index. Run `agent-memory rebuild` after manual Markdown edits, and `agent-memory reindex` when only FTS search indexes need refreshing.

## Documentation

- [中文使用手册](docs/USAGE.zh-CN.md)
- [中文架构文档](docs/ARCHITECTURE.zh-CN.md)
- [Architecture](docs/ARCHITECTURE.en.md)

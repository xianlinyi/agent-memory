# Agent Memory Knowledge Graph

Local-first agent memory layer backed by an Obsidian-compatible Markdown vault and SQLite FTS5 indexes.

## Features

- TypeScript SDK plus `agent-memory` CLI.
- Hybrid Obsidian layout: `People/`, `Projects/`, `Bugs/`, `Rules/`, `Sessions/`, `Concepts/`, `Graph/`, `Dashboards/`, `Templates/`, and `.kg/`.
- SQLite graph store with FTS5 search and rebuildable indexes.
- Replaceable interfaces for model providers, graph stores, vault stores, embedding providers, and vector stores.
- Default model adapter uses the official GitHub Copilot SDK.
- No default vector database yet; embeddings and vector search are extension points.

## Requirements

Node.js `>=22.13` is required because the default store uses `node:sqlite`. Depending on your Node version, `node:sqlite` may still be marked experimental or release-candidate by Node.js.

## Install

```bash
npm install -g @agent-memory/knowledge-graph
```

Or run without installing:

```bash
npx @agent-memory/knowledge-graph init --vault ./memory-vault
```

## CLI

```bash
agent-memory init
agent-memory init --vault ./memory-vault
agent-memory ingest "Codex prefers local-first memory." --vault ./memory-vault
agent-memory query "local-first memory" --vault ./memory-vault --json
agent-memory link --from entity:a --to entity:b --type related_to --vault ./memory-vault
agent-memory graph --vault ./memory-vault --json
agent-memory rebuild --vault ./memory-vault
agent-memory reindex --vault ./memory-vault
agent-memory compact --vault ./memory-vault
agent-memory export --vault ./memory-vault --format json
agent-memory import ./export.json --vault ./memory-vault
agent-memory doctor --vault ./memory-vault
agent-memory doctor --vault ./memory-vault --model
agent-memory status --vault ./memory-vault
agent-memory default get
agent-memory default set /Users/me/Documents/MyVault
agent-memory default unset
agent-memory config set model.model gpt-5 --vault ./memory-vault
agent-memory config get model.model --vault ./memory-vault
```

When `--vault` is omitted, commands use the user default vault path. The built-in default is `~/agent-memory/MyVault`, and it can be changed with `agent-memory default set <path>`.

`ingest` accepts either literal text or a file path. Source metadata can be supplied with `--source`.

## Documentation

- [中文使用文档](docs/USAGE.zh-CN.md)
- [中文架构文档](docs/ARCHITECTURE.zh-CN.md)
- [Architecture](docs/ARCHITECTURE.en.md)

## SDK

```ts
import { MemoryEngine } from "@agent-memory/knowledge-graph";

const memory = await MemoryEngine.create({ vaultPath: "./memory-vault" });
await memory.init();
await memory.ingest({ text: "Project Atlas uses Obsidian for memory." });
const results = await memory.query({ text: "Atlas memory" });
console.log(results.matches);
```

## Copilot SDK Provider

The default provider uses `@github/copilot-sdk`. The SDK talks to the GitHub Copilot CLI through its JSON-RPC protocol, so you still need an authenticated Copilot CLI available locally or bundled through the SDK dependency.

Configuration lives in `.kg/config.json`:

```json
{
  "model": {
    "provider": "copilot-sdk",
    "model": "gpt-5",
    "reasoningEffort": "medium",
    "timeoutMs": 30000
  }
}
```

Optional SDK fields include `cliPath`, `cliUrl`, `cliArgs`, `cwd`, `configDir`, `githubToken`, `useLoggedInUser`, and `logLevel`.

You can edit these through the CLI:

```bash
agent-memory config set model.model gpt-5 --vault ./memory-vault
agent-memory config set model.reasoningEffort medium --vault ./memory-vault
agent-memory config set model.cliPath /usr/local/bin/copilot --vault ./memory-vault
agent-memory config set model.useLoggedInUser true --vault ./memory-vault
agent-memory config get model --vault ./memory-vault --json
```

`agent-memory doctor` checks SDK/CLI connectivity and auth. `agent-memory doctor --model` additionally sends a short model prompt through the configured provider.

Memory extraction, query interpretation, and answer synthesis require a configured, working LLM provider. There is no heuristic fallback. `ingest` uses the LLM to extract entities and relations. `query` uses the LLM to extract searchable keywords/entities/predicates, runs SQLite FTS, returns structured matches, and then asks the LLM to produce a natural-language answer from those matches. If Copilot SDK, authentication, model configuration, or model output fails, `ingest`, `query`, and `compact` fail with an explicit error instead of writing approximate memory.

The legacy `copilot-cli` provider remains available for compatibility:

```json
{
  "model": {
    "provider": "copilot-cli",
    "command": "copilot",
    "args": ["ask", "{prompt}"],
    "promptInput": "argument",
    "timeoutMs": 30000
  }
}
```

`{prompt}` is replaced with the generated prompt before the command is spawned. If no placeholder is present, set `promptInput` to `"argument"` to append the prompt as the final argument, or `"stdin"` to write the prompt to stdin.

## Vault Model

- `People/`: person entities.
- `Projects/`: project entities.
- `Bugs/`: bug entities.
- `Rules/`: durable rule entities.
- `Concepts/`: concepts, topics, artifacts, decisions, and unknown entity types.
- `Sessions/`: atomic observations from conversations, files, commands, or imports. Source metadata is embedded in session frontmatter instead of a separate `Sources/` folder.
- `Graph/`: relation notes and graph evidence summaries.
- `Dashboards/`: generated starter dashboard notes.
- `Templates/`: generated starter Markdown templates.
- `.kg/`: `config.json`, `graph.db`, logs, and generated state.

SQLite is the canonical index and relationship layer. Obsidian files are human-editable projections; `agent-memory rebuild` recreates SQLite state from Markdown.

# Agent Memory LLM Wiki

Local-first LLM Wiki for coding agents. The filesystem is the source of truth:

- `raw/` stores immutable source documents from every ingest.
- `wiki/` stores human-readable Markdown pages maintained by the model.
- `schema/` stores page types, style guidance, and lint rules.
- `.llm-wiki/` stores rebuildable config, logs, cache, and the SQLite FTS index.

SQLite is only a search index. It can always be rebuilt from `raw/` and `wiki/`.

## Install

```bash
npm install -g @xianlinyi/agent-memory
```

## Quick Start

```bash
amem init --vault ./memory-wiki
amem ingest "Project Atlas uses Obsidian for local-first agent memory." --vault ./memory-wiki
amem query "How does Atlas store memory?" --vault ./memory-wiki
amem lint --vault ./memory-wiki
```

## Commands

```text
amem init [--vault <path>]
amem ingest <text|file> [--source <label>] [--vault <path>]
amem query <text> [--limit n] [--details] [--json] [--no-answer] [--vault <path>]
amem reindex [--vault <path>]
amem lint [--fix] [--json] [--vault <path>]
amem pages [--json] [--vault <path>]
amem sources [--json] [--vault <path>]
amem doctor [--model] [--json] [--vault <path>]
amem status [--json] [--vault <path>]
amem config get|set|unset ...
```

## SDK

```ts
import { MemoryEngine } from "@xianlinyi/agent-memory";

const wiki = await MemoryEngine.create({ vaultPath: "./memory-wiki" });

try {
  await wiki.init();
  await wiki.ingest({
    text: "Project Atlas uses Obsidian for local-first agent memory.",
    source: { kind: "message", label: "Planning chat" }
  });

  const result = await wiki.query({ text: "How does Atlas store memory?" });
  console.log(result.answer);
  console.log(result.pages);
} finally {
  await wiki.close();
}
```

## Development

```bash
npm run typecheck
npm test
```

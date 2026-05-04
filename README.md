# Agent Memory

Local-first memory runtime for coding agents. It is memory-first, not wiki-first:

- `memory/raw/` stores raw inputs that should become runtime memory entities.
- `wiki/raw/` stores raw inputs that should become human-facing wiki entities.
- `raw/` remains as a legacy-compatible import location.
- `memory/` stores staged runtime memory.
- `wiki/` stores human-facing Markdown pages.
- `schema/` stores page types, style guidance, and lint rules.
- `.llm-wiki/` stores rebuildable config, traces, and the SQLite FTS index.

SQLite is only a search index. It can always be rebuilt from the Markdown files.

## Install

```bash
npm install @xianlinyi/agent-memory
```

For global CLI usage:

```bash
npm install -g @xianlinyi/agent-memory
```

## Storage Layout

```text
raw/
memory/
  raw/
  session-summaries/
  candidates/
  long/
    episodic/
    semantic/
    procedural/
  wiki-update-candidates/
wiki/
  raw/
  episodes/
  semantic/
  procedures/
schema/
.llm-wiki/
```

The default lifecycles are:

```text
memory/raw -> session_summary -> candidate -> long_term entity
wiki/raw -> consolidated wiki entity
```

`memory/wiki-update-candidates/` is kept only for legacy review artifacts created by older vaults.

## CLI Quick Start

```bash
amem init --vault ./memory-wiki
amem ingest "Yesterday payment proof failed because MQ timeout blocked notification delivery." \
  --memory-class episodic \
  --session-id incident-20260503 \
  --vault ./memory-wiki

amem ingest "Project Atlas keeps wiki pages human editable." \
  --target wiki \
  --source "Atlas wiki note" \
  --vault ./memory-wiki

amem consolidate --session-id incident-20260503 --vault ./memory-wiki
amem query "payment proof timeout" --vault ./memory-wiki
```

You can also hand-write plain text files directly under `memory/raw/` or `wiki/raw/`, then run `amem consolidate`.

`wiki-updates`, `approve-wiki-update`, and `reject-wiki-update` now exist only for legacy pending candidates that may still be present in older vaults.

Use `reject-wiki-update` when a legacy proposed wiki page should stay out of the human-facing wiki:

```bash
amem reject-wiki-update memory/wiki-update-candidates/incident-note.md --vault ./memory-wiki
```

## CLI Commands

```text
amem init [--vault <path>]
amem ingest <text|file> [--source <label>] [--target <memory|wiki>] [--memory-class <episodic|semantic|procedural>] [--session-id <id>] [--event-time <iso>] [--vault <path>]
amem consolidate [--session-id <id>] [--json] [--vault <path>]
amem query <text> [--limit n] [--details] [--json] [--no-answer] [--vault <path>]
amem long-memory [--memory-class <episodic|semantic|procedural>] [--json] [--vault <path>]
amem wiki-updates [--all] [--json] [--vault <path>]
amem approve-wiki-update <candidate-id|title|path> [--json] [--vault <path>]
amem reject-wiki-update <candidate-id|title|path> [--json] [--vault <path>]
amem reindex [--vault <path>]
amem lint [--fix] [--json] [--vault <path>]
amem pages [--json] [--vault <path>]
amem sources [--json] [--vault <path>]
amem doctor [--model] [--json] [--vault <path>]
amem status [--json] [--vault <path>]
amem config get|set|unset ...
```

## SDK Usage

The package can be imported directly by other Node.js or TypeScript projects:

```ts
import { MemoryEngine, defaultConfig } from "@xianlinyi/agent-memory";

const vaultPath = "./memory-wiki";
const config = defaultConfig(vaultPath);

const engine = await MemoryEngine.create({ vaultPath, config });

try {
  await engine.init();

  await engine.ingest({
    text: "Billing export uses reconciliation token to locate PSP callbacks.",
    targetScope: "memory",
    source: { kind: "message", label: "Ops note" },
    memory: { class: "procedural", sessionId: "ops-20260503" }
  });

  await engine.consolidate({ sessionId: "ops-20260503" });
  const result = await engine.query({ text: "reconciliation token callback" });
  console.log(result.answer);
} finally {
  await engine.close();
}
```

  ## Local Testing

  Install dependencies first:

    npm install

  Common local validation commands:

    npm run typecheck
    npm test

  If you only want to verify the package contents without writing a tarball:

    npm pack --dry-run

  ## Local Packaging

  Create a local tarball:

    npm pack

  This project now runs a build automatically during prepare and prepack, so both local directory installs and npm pack refresh dist first.

  The generated tarball will look like:

    xianlinyi-agent-memory-0.1.7.tgz

  ## Use From Another Project

  Option 1: install from npm

    npm install @xianlinyi/agent-memory

  Option 2: install from a local tarball

  In this repo:

    npm pack

  In the consumer project:

    npm install /absolute/path/to/xianlinyi-agent-memory-0.1.7.tgz

  Option 3: install directly from the local source directory

  In the consumer project:

    npm install /absolute/path/to/agent-memory

  Or in package.json:

    {
      "dependencies": {
      "@xianlinyi/agent-memory": "file:../agent-memory"
      }
    }

  Because prepare runs a build automatically, local directory installs will also generate the SDK entry before the dependency is consumed.

  Import as an SDK:

    import { MemoryEngine, defaultConfig } from "@xianlinyi/agent-memory";

  Use the CLI from another project:

    npx amem --help

## Copilot Authentication

`copilot-sdk` supports a GitHub token. For SDK consumers, the preferred order is:

1. `config.model.githubToken`
2. `AGENT_MEMORY_GITHUB_TOKEN`
3. `GITHUB_TOKEN`

If a token is present and `config.model.useLoggedInUser` is not set, Agent Memory will default to token-based auth instead of the logged-in local user.

Recommended pattern for secrets:

```bash
export AGENT_MEMORY_GITHUB_TOKEN="github_pat_your_token"
```

Then in code:

```ts
import { MemoryEngine, defaultConfig } from "@xianlinyi/agent-memory";

const vaultPath = "./memory-wiki";
const config = defaultConfig(vaultPath);
config.model.provider = "copilot-sdk";

const engine = await MemoryEngine.create({ vaultPath, config });
```

You can also set the token explicitly in code:

```ts
config.model.githubToken = process.env.AGENT_MEMORY_GITHUB_TOKEN;
config.model.useLoggedInUser = false;
```

If you store the token in config with the CLI, it will be written to `.llm-wiki/config.json`. Environment variables are safer for production or shared environments.

## Query Behavior

Default query reads:

- queryable `memory/` pages, primarily long-term memory
- `wiki/` pages

The engine searches memory first, then wiki, and merges both result sets before answer synthesis.

Default query does not read:

- `memory/session-summaries/`
- `memory/wiki-update-candidates/`
- superseded `memory/candidates/` when a matching long-term memory already exists

## Development

```bash
npm run typecheck
npm test
```

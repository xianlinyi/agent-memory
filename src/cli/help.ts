export function printHelp(): void {
  console.log(`amem

Usage:
  amem init
  amem init --vault <path>
  amem ingest <text|file> [--source <label>] [--target <memory|wiki>] [--memory-class <episodic|semantic|procedural>] [--session-id <id>] [--event-time <iso>] [--vault <path>]
  amem query <text> [--limit n] [--details] [--json] [--no-answer] [--vault <path>]
  amem consolidate [--session-id <id>] [--json] [--vault <path>]
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
  amem version [--json]
  amem upgrade [--tag <tag>] [--dry-run] [--json]
  amem default get [--json]
  amem default set <vault-path> [--json]
  amem default unset [--json]
  amem config get [key] [--json] [--vault <path>]
  amem config set <key> <value> [--json] [--vault <path>]
  amem config unset <key> [--json] [--vault <path>]
  amem copilot isolate [--config-dir <path>] [--json] [--vault <path>]

Global flags:
  --verbose                 Write progress logs to stderr.
  --log-file <path>         Append progress logs to a file.

Version management:
  version                   Print the currently installed CLI package version.
  upgrade                   Run npm install -g <package>@latest for this package.
  --tag <tag>               Upgrade to a specific npm dist-tag or version. Defaults to latest.
  --dry-run                 Print the upgrade command without running it.

Query output:
  --json                    Print { answer, pages, sources }.
  --no-answer               Search pages without asking the model to synthesize an answer.
  --details                 Include source references in text mode.

Memory staging:
  ingest                    Writes raw documents into memory/raw or wiki/raw before consolidation.
  --target <scope>          Choose whether ingest stores the raw document under memory/raw or wiki/raw. Defaults to memory.
  --memory-class <class>    Tag deferred memory as episodic, semantic, or procedural.
  --session-id <id>         Associate deferred memory with a session for targeted consolidation.
  --event-time <iso>        Override the event timestamp stored on the raw memory item.
  consolidate               Automatically merges memory/raw into memory entities and wiki/raw into wiki entities.
  wiki-updates              Inspect legacy wiki update candidates left from older vaults.
  approve-wiki-update       Apply one legacy reviewed wiki update candidate into the human-facing wiki.
  reject-wiki-update        Mark one legacy wiki update candidate as rejected and keep it out of the pending queue.
`);
}

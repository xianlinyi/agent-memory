export function printHelp(): void {
  console.log(`amem

Usage:
  amem init
  amem init --vault <path>
  amem ingest <text|file> [--source <label>] [--vault <path>]
  amem query <text> [--limit n] [--details] [--json] [--no-answer] [--vault <path>]
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
`);
}

export function printHelp(): void {
  console.log(`agent-memory

Usage:
  agent-memory init
  agent-memory init --vault <path>
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
  agent-memory version [--json]
  agent-memory upgrade [--tag <tag>] [--dry-run] [--json]
  agent-memory default get [--json]
  agent-memory default set <vault-path> [--json]
  agent-memory default unset [--json]
  agent-memory config get [key] [--json] [--vault <path>]
  agent-memory config set <key> <value> [--json] [--vault <path>]
  agent-memory config unset <key> [--json] [--vault <path>]
  agent-memory copilot isolate [--config-dir <path>] [--json] [--vault <path>]

Global flags:
  --verbose                 Write progress logs to stderr.
  --log-file <path>         Append progress logs to a file.

Version management:
  version                   Print the currently installed CLI package version.
  upgrade                   Run npm install -g <package>@latest for this package.
  --tag <tag>               Upgrade to a specific npm dist-tag or version. Defaults to latest.
  --dry-run                 Print the upgrade command without running it.

Query output:
  --json                    Print compact assumptions and relationships.
  --answer                  Include a synthesized answer only with --json --details.
  --details                 Include query interpretation and full matches in text mode, or full JSON with --json.
`);
}

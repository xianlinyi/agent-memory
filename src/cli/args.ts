export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(args: string[]): ParsedArgs {
  const [command, ...rest] = args;
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        flags.set(rawKey, inlineValue);
      } else if (rest[index + 1] && !rest[index + 1].startsWith("--")) {
        flags.set(rawKey, rest[index + 1]);
        index += 1;
      } else {
        flags.set(rawKey, true);
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function numberFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(parsed, name);
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

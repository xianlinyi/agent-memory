type DatabaseSyncConstructor = new (path: string) => unknown;

export interface NodeSqliteModule {
  DatabaseSync: DatabaseSyncConstructor;
}

export async function importNodeSqlite(): Promise<NodeSqliteModule> {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    if (isSqliteExperimentalWarning(warning, args)) return;
    return (originalEmitWarning as (warning: string | Error, ...args: unknown[]) => void).call(process, warning, ...args);
  }) as typeof process.emitWarning;

  try {
    return (await import("node:sqlite")) as unknown as NodeSqliteModule;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function isSqliteExperimentalWarning(warning: string | Error, args: unknown[]): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  const type = warning instanceof Error ? warning.name : warningType(args[0]);
  return type === "ExperimentalWarning" && message.includes("SQLite is an experimental feature");
}

function warningType(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "type" in value) {
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  }
  return undefined;
}

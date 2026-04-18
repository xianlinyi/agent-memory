import { Console } from "node:console";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface Logger {
  debug(message: string): Promise<void>;
  close?(): Promise<void>;
}

export interface CliLoggerOptions {
  verbose?: boolean;
  logFile?: string;
}

export async function createCliLogger(options: CliLoggerOptions): Promise<Logger> {
  const verbose = Boolean(options.verbose);
  const logFile = options.logFile ? resolveHome(options.logFile) : undefined;
  let stream: WriteStream | undefined;
  let fileConsole: Console | undefined;

  if (logFile) {
    await mkdir(dirname(logFile), { recursive: true });
    stream = createWriteStream(logFile, { flags: "a" });
    fileConsole = new Console({ stdout: stream, stderr: stream });
  }

  return {
    async debug(message: string): Promise<void> {
      if (!verbose && !fileConsole) return;
      const line = `[${new Date().toISOString()}] ${message}`;
      if (verbose) {
        console.error(line);
      }
      fileConsole?.log(line);
    },
    async close(): Promise<void> {
      if (!stream) return;
      await new Promise<void>((resolveClose, reject) => {
        stream.end((error?: Error | null) => {
          if (error) reject(error);
          else resolveClose();
        });
      });
    }
  };
}

export function appendNodeOption(existing: string | undefined, option: string): string {
  const parts = existing?.split(/\s+/).filter(Boolean) ?? [];
  if (parts.includes(option) || parts.includes("--no-warnings")) return existing ?? "";
  return [...parts, option].join(" ");
}

function resolveHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? "", path.slice(2));
  return resolve(path);
}

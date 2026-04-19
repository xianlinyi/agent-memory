import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedArgs } from "./args.js";
import { stringFlag } from "./args.js";
import { printJsonOrText } from "./output.js";

interface PackageInfo {
  name: string;
  version: string;
}

export async function handleVersion(parsed: ParsedArgs): Promise<void> {
  const info = await readPackageInfo();
  printJsonOrText(parsed, { name: info.name, version: info.version }, info.version);
}

export async function handleUpgrade(parsed: ParsedArgs): Promise<void> {
  const info = await readPackageInfo();
  const packageName = stringFlag(parsed, "package") ?? info.name;
  const tag = stringFlag(parsed, "tag") ?? "latest";
  const packageSpec = `${packageName}@${tag}`;
  const packageManager = stringFlag(parsed, "package-manager") ?? process.env.AGENT_MEMORY_PACKAGE_MANAGER ?? defaultPackageManager();
  const args = ["install", "-g", packageSpec];
  const command = [packageManager, ...args];

  if (parsed.flags.has("dry-run")) {
    printJsonOrText(
      parsed,
      { ok: true, dryRun: true, packageName, currentVersion: info.version, command },
      `Would run: ${command.join(" ")}`
    );
    return;
  }

  const result = await runCommand(packageManager, args, parsed.flags.has("json"));
  printJsonOrText(
    parsed,
    { ok: true, packageName, currentVersion: info.version, command, stdout: result.stdout, stderr: result.stderr },
    `Upgraded ${packageName} from ${info.version} using ${command.join(" ")}`
  );
}

async function readPackageInfo(): Promise<PackageInfo> {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const path = resolve(current, "package.json");
    try {
      const raw = await readFile(path, "utf8");
      const json = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (typeof json.name === "string" && typeof json.version === "string") {
        return { name: json.name, version: json.version };
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }

    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  throw new Error("Unable to locate package.json for agent-memory.");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function defaultPackageManager(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runCommand(command: string, args: string[], captureOutput: boolean): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    if (captureOutput) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveCommand({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`));
      }
    });
  });
}

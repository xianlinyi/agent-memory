import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentMemoryConfig } from "./types.js";

export const INTERNAL_DIR = ".kg";
export const CONFIG_FILE = "config.json";
export const DATABASE_FILE = "graph.db";
export const DEFAULT_VAULT_PATH = join(homedir(), "agent-memory", "MyVault");
export const USER_CONFIG_FILE = process.env.AGENT_MEMORY_USER_CONFIG ?? join(homedir(), ".agent-memory", "config.json");

export interface UserConfig {
  defaultVaultPath?: string;
}

export function defaultConfig(vaultPath: string): AgentMemoryConfig {
  const resolvedVault = resolve(vaultPath);
  return {
    vaultPath: resolvedVault,
    databasePath: join(resolvedVault, INTERNAL_DIR, DATABASE_FILE),
    model: {
      provider: "copilot-sdk",
      model: "gpt-5",
      timeoutMs: 30000
    }
  };
}

export function configPath(vaultPath: string): string {
  return join(resolve(vaultPath), INTERNAL_DIR, CONFIG_FILE);
}

export async function loadUserConfig(): Promise<UserConfig> {
  try {
    const parsed = JSON.parse(await readFile(USER_CONFIG_FILE, "utf8")) as Partial<UserConfig>;
    return {
      defaultVaultPath: typeof parsed.defaultVaultPath === "string" && parsed.defaultVaultPath ? resolveHome(parsed.defaultVaultPath) : undefined
    };
  } catch {
    return {};
  }
}

export async function writeUserConfig(config: UserConfig): Promise<void> {
  await mkdir(dirname(USER_CONFIG_FILE), { recursive: true });
  await writeFile(USER_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function defaultVaultPath(): Promise<string> {
  const userConfig = await loadUserConfig();
  return userConfig.defaultVaultPath ?? DEFAULT_VAULT_PATH;
}

export async function loadConfig(vaultPath: string): Promise<AgentMemoryConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(vaultPath), "utf8")) as Partial<AgentMemoryConfig>;
    const fallback = defaultConfig(vaultPath);
    return {
      ...fallback,
      ...parsed,
      model: {
        ...fallback.model,
        ...parsed.model
      }
    };
  } catch {
    return defaultConfig(vaultPath);
  }
}

export async function writeConfig(config: AgentMemoryConfig): Promise<void> {
  await mkdir(join(config.vaultPath, INTERNAL_DIR), { recursive: true });
  await writeFile(configPath(config.vaultPath), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function resolveHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

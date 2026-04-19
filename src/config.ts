import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentMemoryConfig } from "./types.js";

export const INTERNAL_DIR = ".kg";
export const CONFIG_FILE = "config.json";
export const DATABASE_FILE = "graph.db";
export const DEFAULT_VAULT_PATH = join(homedir(), "agent-memory", "MyVault");
export const USER_CONFIG_FILE = process.env.AGENT_MEMORY_USER_CONFIG ?? join(homedir(), ".agent-memory", "config.json");
export const DEFAULT_COPILOT_CONFIG_FILE = process.env.AGENT_MEMORY_COPILOT_SOURCE_CONFIG ?? join(homedir(), ".copilot", "config.json");
export const COPILOT_ISOLATED_CONFIG_DIR = "copilot-isolated";
export const COPILOT_TRACE_DIR = "copilot-runs";

export interface UserConfig {
  defaultVaultPath?: string;
}

export interface CopilotIsolatedConfigResult {
  configDir: string;
  configPath: string;
  copiedFrom?: string;
}

export function defaultConfig(vaultPath: string): AgentMemoryConfig {
  const resolvedVault = resolve(vaultPath);
  return {
    vaultPath: resolvedVault,
    databasePath: join(resolvedVault, INTERNAL_DIR, DATABASE_FILE),
    model: {
      provider: "copilot-sdk",
      model: "gpt-5-mini",
      timeoutMs: 600000
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

export async function applyAutomaticCopilotIsolation(config: AgentMemoryConfig): Promise<AgentMemoryConfig> {
  if (!shouldAutomaticallyIsolateCopilot(config)) return config;
  const isolated = await prepareCopilotIsolatedConfig(config.vaultPath);
  return {
    ...config,
    model: {
      ...config.model,
      configDir: isolated.configDir
    }
  };
}

export async function prepareCopilotIsolatedConfig(vaultPath: string, configDir?: string): Promise<CopilotIsolatedConfigResult> {
  const resolvedDir = configDir ? resolveHome(configDir) : defaultCopilotIsolatedConfigDir(vaultPath);
  const targetConfigPath = join(resolvedDir, CONFIG_FILE);
  const sourceConfig = await readCopilotConfig(DEFAULT_COPILOT_CONFIG_FILE, targetConfigPath);
  const isolatedConfig = buildCopilotIsolatedConfig(sourceConfig);

  await mkdir(resolvedDir, { recursive: true });
  await mkdir(join(resolvedDir, "hooks"), { recursive: true });
  await writeFile(targetConfigPath, `${JSON.stringify(isolatedConfig, null, 2)}\n`, "utf8");

  return {
    configDir: resolvedDir,
    configPath: targetConfigPath,
    copiedFrom: sourceConfig ? DEFAULT_COPILOT_CONFIG_FILE : undefined
  };
}

export function defaultCopilotIsolatedConfigDir(vaultPath: string): string {
  return join(resolve(vaultPath), INTERNAL_DIR, COPILOT_ISOLATED_CONFIG_DIR);
}

export function defaultCopilotTraceDir(vaultPath: string): string {
  return join(resolve(vaultPath), INTERNAL_DIR, COPILOT_TRACE_DIR);
}

function shouldAutomaticallyIsolateCopilot(config: AgentMemoryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AGENT_MEMORY_AUTO_COPILOT_ISOLATE === "0" || env.AGENT_MEMORY_AUTO_COPILOT_ISOLATE === "false") return false;
  if (config.model.provider !== "copilot-sdk") return false;
  if (config.model.configDir?.trim()) return false;
  return true;
}

async function readCopilotConfig(sourcePath: string, targetPath: string): Promise<Record<string, unknown> | undefined> {
  if (resolve(sourcePath) === resolve(targetPath)) return undefined;
  try {
    return JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function buildCopilotIsolatedConfig(source: Record<string, unknown> | undefined): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of ["firstLaunchAt", "lastLoggedInUser", "loggedInUsers", "model", "disabledSkills"]) {
    if (source?.[key] !== undefined) config[key] = source[key];
  }
  return {
    ...config,
    banner: "never",
    disableAllHooks: true,
    hooks: {},
    installedPlugins: [],
    enabledPlugins: {}
  };
}

function resolveHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

import { resolve } from "node:path";
import {
  defaultVaultPath,
  loadConfig,
  loadUserConfig,
  prepareCopilotIsolatedConfig,
  USER_CONFIG_FILE,
  writeConfig,
  writeUserConfig
} from "../config.js";
import type { AgentMemoryConfig } from "../types.js";
import type { ParsedArgs } from "./args.js";
import { printJsonOrText } from "./output.js";

export async function handleConfig(vaultPath: string, parsed: ParsedArgs): Promise<void> {
  const [action, key, ...valueParts] = parsed.positionals;
  const config = await loadConfig(vaultPath);

  switch (action) {
    case "get": {
      const value = key ? getConfigValue(config, key) : config;
      printJsonOrText(parsed, value, formatConfigValue(value));
      return;
    }
    case "list":
    case undefined:
      printJsonOrText(parsed, config, JSON.stringify(config, null, 2));
      return;
    case "set": {
      if (!key) throw new Error("config set requires a key.");
      if (valueParts.length === 0) throw new Error("config set requires a value.");
      const value = parseConfigValue(valueParts.join(" "));
      setConfigValue(config, key, value);
      await writeConfig(config);
      printJsonOrText(parsed, { ok: true, key, value }, `Set ${key} = ${formatConfigValue(value)}`);
      return;
    }
    case "unset": {
      if (!key) throw new Error("config unset requires a key.");
      unsetConfigValue(config, key);
      await writeConfig(config);
      printJsonOrText(parsed, { ok: true, key }, `Unset ${key}`);
      return;
    }
    default:
      throw new Error(`Unknown config action: ${action}`);
  }
}

export async function handleCopilot(vaultPath: string, parsed: ParsedArgs): Promise<void> {
  const [action] = parsed.positionals;
  switch (action) {
    case "isolate": {
      const isolated = await prepareCopilotIsolatedConfig(vaultPath, stringFlag(parsed, "config-dir"));
      const config = await loadConfig(vaultPath);
      config.model.configDir = isolated.configDir;
      await writeConfig(config);
      printJsonOrText(
        parsed,
        { ok: true, vaultPath: config.vaultPath, modelConfigDir: isolated.configDir, configPath: isolated.configPath, copiedFrom: isolated.copiedFrom },
        `Copilot hooks isolated for ${config.vaultPath}; model.configDir = ${isolated.configDir}`
      );
      return;
    }
    default:
      throw new Error(`Unknown copilot action: ${action ?? "<missing>"}`);
  }
}

export async function handleDefault(parsed: ParsedArgs): Promise<void> {
  const [action, value] = parsed.positionals;

  switch (action) {
    case "get":
    case undefined: {
      const vaultPath = await defaultVaultPath();
      printJsonOrText(parsed, { vaultPath, configPath: USER_CONFIG_FILE }, vaultPath);
      return;
    }
    case "set": {
      if (!value) throw new Error("default set requires a vault path.");
      const vaultPath = resolveHome(value);
      await writeUserConfig({ ...(await loadUserConfig()), defaultVaultPath: vaultPath });
      printJsonOrText(parsed, { ok: true, vaultPath, configPath: USER_CONFIG_FILE }, `Default vault set to ${vaultPath}`);
      return;
    }
    case "unset": {
      await writeUserConfig({});
      const vaultPath = await defaultVaultPath();
      printJsonOrText(parsed, { ok: true, vaultPath, configPath: USER_CONFIG_FILE }, `Default vault reset to ${vaultPath}`);
      return;
    }
    default:
      throw new Error(`Unknown default action: ${action}`);
  }
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function resolveHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? "", path.slice(2));
  return resolve(path);
}

function getConfigValue(config: AgentMemoryConfig, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setConfigValue(config: AgentMemoryConfig, key: string, value: unknown): void {
  assertConfigKey(key);
  const parts = key.split(".");
  const last = parts.pop();
  if (!last) throw new Error("Invalid config key.");
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const part of parts) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[last] = value;
}

function unsetConfigValue(config: AgentMemoryConfig, key: string): void {
  assertConfigKey(key);
  const parts = key.split(".");
  const last = parts.pop();
  if (!last) throw new Error("Invalid config key.");
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const part of parts) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    current = next as Record<string, unknown>;
  }
  delete current[last];
}

function assertConfigKey(key: string): void {
  const allowedKeys = new Set([
    "databasePath",
    "model.provider",
    "model.model",
    "model.reasoningEffort",
    "model.cliPath",
    "model.cliUrl",
    "model.cliArgs",
    "model.cwd",
    "model.configDir",
    "model.traceDir",
    "model.githubToken",
    "model.useLoggedInUser",
    "model.logLevel",
    "model.command",
    "model.args",
    "model.promptInput",
    "model.timeoutMs"
  ]);
  if (!allowedKeys.has(key)) {
    throw new Error(`Unsupported config key: ${key}`);
  }
}

function parseConfigValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  if (value.includes(",") && !value.includes(" ")) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return value;
}

function formatConfigValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
